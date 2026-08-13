'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkWorkspace } = require('../src/check');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-bootstrap-cli-'));
try {
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n', 'utf8');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);

  const invalidTrait = spawnSync(process.execPath, [cli, 'init', 'invalid', '--name', 'Invalid', '--trait', 'api', '--root', temporary, '--json'], { cwd: repository, encoding: 'utf8' });
  assert.notStrictEqual(invalidTrait.status, 0);
  assert(invalidTrait.stderr.includes('--profile'));
  assert(!fs.existsSync(path.join(temporary, 'projects')));

  const created = JSON.parse(command(process.execPath, [cli, 'init', 'demo', '--name', 'Demo', '--profile', 'service', '--trait', 'operations', '--trait', 'api', '--root', temporary, '--json'], repository));
  assert.strictEqual(created.action, 'created');
  assert.strictEqual(created.profile, 'service');
  assert.deepStrictEqual(created.traits, ['api', 'operations']);
  assert(created.missing.some((item) => item.type === 'PRD' && item.command.includes('rdl doc create PRD')));
  const projectFile = path.join(temporary, 'projects', 'demo', 'project.md');
  assert(fs.readFileSync(projectFile, 'utf8').includes('documentProfile:'));
  const policyCheck = checkWorkspace(temporary, { project: 'demo', strict: true });
  assert(policyCheck.diagnostics.some((item) => item.code === 'RDL-PROFILE-002' && item.severity === 'error'));
  assert(policyCheck.diagnostics.some((item) => item.code === 'RDL-PROFILE-003' && item.severity === 'warning'));

  command('git', ['remote', 'add', 'origin', path.join(temporary, 'missing-remote.git')], temporary);
  const repeated = JSON.parse(command(process.execPath, [cli, 'init', '--root', temporary, '--json'], repository));
  assert.strictEqual(repeated.action, 'already-connected');

  const configured = JSON.parse(command(process.execPath, [cli, 'project', 'profile', '--project', 'demo', '--profile', 'lean', '--root', temporary, '--json'], repository));
  assert.strictEqual(configured.profile, 'lean');
  assert.deepStrictEqual(configured.traits, ['api', 'operations']);
  assert(configured.missing.some((item) => item.type === 'REQ'));
  const overridden = JSON.parse(command(process.execPath, [cli, 'project', 'profile', '--project', 'demo', '--profile', 'lean', '--required', 'REQ,PRD', '--recommended', 'TST,ARC', '--on-demand', 'GLS,RUN,API,ADR,MOD,SCR', '--root', temporary, '--json'], repository));
  assert.strictEqual(overridden.revision, 3);
  assert.deepStrictEqual(overridden.history, ['service', 'lean', 'lean']);

  fs.mkdirSync(path.join(temporary, 'projects', 'demo', 'docs'), { recursive: true });
  const legacyPrd = path.join(temporary, 'projects', 'demo', 'docs', 'PRD-001-legacy.md');
  fs.writeFileSync(legacyPrd, `---\nid: PRD-001\ntype: document\nkind: product-requirements\ntitle: 레거시 요구\ndescription: 레거시 경로 이동 검증\nowner: "[[project#^MEMBER-001|프로젝트 책임자]]"\nstate: active\ntags: [rundol/artifact, artifact/product-requirements, domain/demo, feature/legacy]\naliases: [PRD-001]\nrelated: []\n---\n# 레거시 요구\n`, 'utf8');
  const dryRun = JSON.parse(command(process.execPath, [cli, 'doc', 'migrate', '--project', 'demo', '--root', temporary, '--json'], repository));
  assert.strictEqual(dryRun.dryRun, true);
  assert.strictEqual(dryRun.moves.length, 1);
  const structureBefore = JSON.parse(command(process.execPath, [cli, 'check', '--structure', '--project', 'demo', '--root', temporary, '--json'], repository));
  assert(structureBefore.candidates.some((item) => item.kind === 'legacy-document-migration'));
  const applied = JSON.parse(command(process.execPath, [cli, 'doc', 'migrate', '--project', 'demo', '--apply', '--root', temporary, '--json'], repository));
  assert.strictEqual(applied.applied, true);
  assert(fs.existsSync(path.join(temporary, 'projects', 'demo', 'docs', 'prd', 'PRD-001-legacy.md')));
  const structureAfter = JSON.parse(command(process.execPath, [cli, 'check', '--structure', '--project', 'demo', '--root', temporary, '--json'], repository));
  assert(!structureAfter.candidates.some((item) => item.kind === 'legacy-document-migration'));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('bootstrap CLI tests passed\n');
