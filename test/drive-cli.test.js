'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runtimeWorkspace } = require('../src/runtime');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-drive-cli-'));
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-drive-cli-runtime-'));

function command(program, args, cwd, expectedStatus) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: runtimeHome }) });
  assert.strictEqual(result.status, expectedStatus === undefined ? 0 : expectedStatus, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function rdl(args, expectedStatus) { return command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository, expectedStatus); }
function json(args, expectedStatus) { const result = rdl(args, expectedStatus); assert(result.stdout.trim(), result.stderr); return JSON.parse(result.stdout); }
function assertNoRequest(rootRequestId) {
  const file = path.join(runtimeWorkspace(temporary).pending, 'requests', `${rootRequestId}.json`);
  assert.strictEqual(fs.existsSync(file), false, `unauthorized/preflight drive created request journal ${rootRequestId}`);
}

try {
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Drive Test'], temporary);
  command('git', ['config', 'user.email', 'drive@example.invalid'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Drive CLI fixture\n', 'utf8');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  json(['init', 'crm', '--name', 'CRM']);
  json(['client', 'register', 'device-a', '--name', 'Device', '--type', 'device', '--owner', 'MEMBER-001']);
  json(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);
  json(['client', 'register', 'agent-b', '--name', 'Agent B', '--type', 'agent', '--owner', 'MEMBER-001']);

  const project = path.join(temporary, 'projects', 'crm');
  fs.writeFileSync(path.join(project, 'harness.json'), `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    adapters: { fixture: { enabled: true, command: process.execPath, argsTemplate: [], timeoutSeconds: 5 } },
    drive: { schedulerClientId: 'agent-b' }
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(project, 'procedures.json'), `${JSON.stringify({ schemaVersion: 1, procedures: {
    'drive.fixture': { revision: 1, idempotent: true, steps: [
      { id: 'approval', human: true },
      { id: 'sync-gate', human: true },
      { id: 'closed-check', gate: { command: 'check', args: ['{artifact}', '--structure', '--project', '{project}'] } },
      { id: 'apply', executor: 'adapter', adapter: 'fixture', instruction: 'author-v1', retrySafety: { mode: 'operation-id' } }
    ] }
  } }, null, 2)}\n`, 'utf8');
  command('git', ['add', 'harness.json', 'procedures.json'], project);
  command('git', ['commit', '-m', 'add drive fixture'], project);

  const unsafe = json(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'agent-a']);
  const unsafeBefore = json(['run', 'log', '--run', unsafe.runId, '--project', 'crm']).events.length;
  const unsafeRoot = 'REQ-10101010101010101010';
  const unsafeDrive = json(['run', 'drive', '--run', unsafe.runId, '--project', 'crm', '--client-id', 'agent-a', '--request-id', unsafeRoot], 2);
  assert.strictEqual(unsafeDrive.canonicalCommitted, false);
  assertNoRequest(unsafeRoot);
  assert.strictEqual(json(['run', 'log', '--run', unsafe.runId, '--project', 'crm']).events.length, unsafeBefore);

  const driven = json(['run', 'start', 'drive.fixture', '--project', 'crm', '--client-id', 'agent-a']);
  const rejectedEventCount = json(['run', 'log', '--run', driven.runId, '--project', 'crm']).events.length;
  for (const [clientId, rootRequestId] of [['device-a', 'REQ-20202020202020202020'], ['agent-b', 'REQ-30303030303030303030']]) {
    const rejected = json(['run', 'drive', '--run', driven.runId, '--project', 'crm', '--client-id', clientId, '--request-id', rootRequestId], 2);
    assert.strictEqual(rejected.canonicalCommitted, false);
    assertNoRequest(rootRequestId);
  }
  const scheduledRoot = 'REQ-40404040404040404040';
  const scheduled = json(['run', 'drive', '--run', driven.runId, '--project', 'crm', '--client-id', 'agent-a', '--scheduled', '--request-id', scheduledRoot], 2);
  assert.strictEqual(scheduled.canonicalCommitted, false);
  assertNoRequest(scheduledRoot);
  assert.strictEqual(json(['run', 'log', '--run', driven.runId, '--project', 'crm']).events.length, rejectedEventCount, 'rejected drive authorization must not append run events');

  const waitingApproval = json(['run', 'drive', '--run', driven.runId, '--project', 'crm', '--client-id', 'agent-a']);
  assert.strictEqual(waitingApproval.status, 'waiting_human');
  assert.strictEqual(waitingApproval.step, 'approval');
  json(['run', 'step', '--run', driven.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', 'fixture approval']);
  const waitingSync = json(['run', 'drive', '--run', driven.runId, '--project', 'crm', '--client-id', 'agent-a']);
  assert.strictEqual(waitingSync.status, 'waiting_human');
  assert.strictEqual(waitingSync.step, 'sync-gate');

  const incompleteResolve = rdl(['run', 'operation', 'resolve', '--run', driven.runId, '--project', 'crm', '--client-id', 'agent-a'], 2);
  assert(incompleteResolve.stderr.includes('--operation'));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(runtimeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

process.stdout.write('drive CLI tests passed\n');
