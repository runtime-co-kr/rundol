'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { verdictEnvelope } = require('../src/verify');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-p15-compat-'));
const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-p15-remote-'));
const bare = path.join(remoteRoot, 'origin.git');
let oldTree = null;

function invoke(program, args, cwd) {
  return spawnSync(program, args, { cwd, encoding: 'utf8' });
}

function command(program, args, cwd) {
  const result = invoke(program, args, cwd);
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function currentCheck() {
  return invoke(process.execPath, [cli, 'check', '--root', temporary, '--json'], root);
}

function event(overrides) {
  return Object.assign({
    schemaVersion: 1,
    eventId: 'EVT-11111111111111111111',
    type: 'verdict.recorded',
    rootRequestId: 'REQ-11111111111111111111',
    requestId: 'REQ-22222222222222222222',
    clientId: 'agent-a',
    projectId: 'crm',
    targetId: 'REQ-001',
    reviewedRevision: 'a'.repeat(40),
    lens: 'satisfaction-v1',
    verdict: 'pass',
    findings: [],
    adapter: {
      name: 'fixture',
      instructionId: 'verify-satisfaction-v1',
      instructionRevision: 1,
      instructionDigest: 'b'.repeat(64)
    },
    validatorInstanceId: 'VAL-11111111111111111111'
  }, overrides);
}

try {
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# P1.5 compatibility\n', 'utf8');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  command('git', ['init', '--bare', '--initial-branch=main', bare], temporary);
  command('git', ['remote', 'add', 'origin', bare], temporary);
  command('git', ['push', '-u', 'origin', 'main'], temporary);
  command(process.execPath, [cli, 'init', 'crm', '--name', '검증 호환성', '--profile', 'lean', '--root', temporary, '--json'], root);
  command(process.execPath, [cli, 'contract', 'set', '--project', 'crm', '--profile', 'lean', '--enforcement', 'advisory', '--root', temporary, '--json'], root);
  command(process.execPath, [cli, 'client', 'register', 'agent-a', '--name', '검증 에이전트', '--type', 'agent', '--owner', 'MEMBER-001', '--root', temporary, '--json'], root);

  const verdictRoot = path.join(temporary, 'projects', 'workspace', 'events', 'verdict');
  fs.mkdirSync(verdictRoot, { recursive: true });
  const valid = verdictEnvelope(event()).shared;
  fs.writeFileSync(path.join(verdictRoot, 'verdict-crm-agent-a-000001.jsonl'), `${JSON.stringify(valid)}\n`, 'utf8');

  const clean = currentCheck();
  assert.strictEqual(clean.status, 0, clean.stdout + clean.stderr);
  assert(!clean.stdout.includes('RDL-VERDICT-'), clean.stdout);

  // 0.28.1 predates verdict registration. Its check/sync must ignore the new kind directory.
  const baseline = command('git', ['rev-parse', '8d1c6df^{commit}'], root);
  oldTree = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-0281-'));
  fs.rmSync(oldTree, { recursive: true, force: true });
  command('git', ['worktree', 'add', '--detach', oldTree, baseline], root);
  const oldCli = path.join(oldTree, 'bin', 'rdl.js');
  const oldCheck = invoke(process.execPath, [oldCli, 'check', '--root', temporary, '--json'], root);
  assert.strictEqual(oldCheck.status, 0, `0.28.1 check failed:\n${oldCheck.stdout}\n${oldCheck.stderr}`);
  assert(!oldCheck.stdout.includes('RDL-LEASE-001'), oldCheck.stdout);
  const oldSync = invoke(process.execPath, [oldCli, 'sync', '--root', temporary, '--project', 'crm', '--no-push', '--json'], root);
  assert.strictEqual(oldSync.status, 0, `0.28.1 sync failed:\n${oldSync.stdout}\n${oldSync.stderr}`);
  command('git', ['worktree', 'remove', '--force', oldTree], root);
  oldTree = null;

  fs.writeFileSync(path.join(verdictRoot, 'not-a-verdict.jsonl'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(verdictRoot, 'verdict-crm-agent-a-000002.jsonl'), [
    '{broken',
    JSON.stringify(Object.assign({}, valid, { verdict: 'refuted' })),
    JSON.stringify(Object.assign({}, valid, { transcript: 'SECRET-TRANSCRIPT' }))
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(verdictRoot, 'verdict-crm-agent-a-000003.jsonl'), `${JSON.stringify(verdictEnvelope(event({ eventId: 'EVT-33333333333333333333', requestId: 'REQ-33333333333333333333', clientId: 'ghost' })).shared)}\n`, 'utf8');
  fs.writeFileSync(path.join(verdictRoot, 'verdict-other-agent-a-000001.jsonl'), `${JSON.stringify(verdictEnvelope(event({ eventId: 'EVT-44444444444444444444', requestId: 'REQ-44444444444444444444' })).shared)}\n`, 'utf8');

  const malformed = currentCheck();
  assert.strictEqual(malformed.status, 1, malformed.stdout + malformed.stderr);
  const output = JSON.parse(malformed.stdout);
  const codes = new Set(output.diagnostics.map((item) => item.code));
  for (const code of ['RDL-VERDICT-010', 'RDL-VERDICT-011', 'RDL-VERDICT-012', 'RDL-VERDICT-013', 'RDL-VERDICT-014']) assert(codes.has(code), `missing ${code}`);
  assert(!malformed.stdout.includes('SECRET-TRANSCRIPT'), 'privacy-sensitive raw field value leaked into diagnostics');

  process.stdout.write('P1.5 compatibility tests passed\n');
} finally {
  if (oldTree) {
    try { command('git', ['worktree', 'remove', '--force', oldTree], root); } catch (_) {}
  }
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.rmSync(remoteRoot, { recursive: true, force: true });
}
