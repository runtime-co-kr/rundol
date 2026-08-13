'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-attach-'));
const source = path.join(temporary, 'source');
const clone = path.join(temporary, 'clone');
const remote = path.join(temporary, 'remote.git');
const sourceHome = path.join(temporary, 'source-home');
const cloneHome = path.join(temporary, 'clone-home');

function command(program, args, cwd, env) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(cwd, args) { return command('git', args, cwd); }
function rdl(cwd, home, args) { return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), root, { RUNDOL_HOME: home })); }

try {
  fs.mkdirSync(source, { recursive: true });
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Rundol Test']);
  git(source, ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(source, 'README.md'), '# Product\n', 'utf8');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-m', 'initial']);
  git(temporary, ['init', '--bare', remote]);
  git(source, ['remote', 'add', 'origin', remote]);
  rdl(source, sourceHome, ['init', 'crm', '--name', '고객 관리']);
  rdl(source, sourceHome, ['sync', '--project', 'crm']);
  git(source, ['push', '-u', 'origin', 'main']);

  git(temporary, ['clone', remote, clone]);
  const before = git(clone, ['status', '--short']);
  const attached = rdl(clone, cloneHome, ['attach', 'crm']);
  assert.strictEqual(attached.attached[0].project, 'crm');
  assert(!fs.existsSync(path.join(clone, '.rundol')));
  assert(fs.existsSync(path.join(clone, 'projects', 'crm', 'project.md')));
  assert(fs.existsSync(path.join(clone, 'projects', 'workspace', 'workspace.yaml')));
  assert.strictEqual(git(clone, ['status', '--short']), before);
  assert.strictEqual(attached.workspace.branch, 'rundol/workspace');
  const audit = rdl(clone, cloneHome, ['check', '--structure', '--project', 'crm']);
  assert.strictEqual(audit.clean, true, JSON.stringify(audit.candidates, null, 2));
  process.stdout.write('attach tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
