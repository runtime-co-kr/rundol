'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveHarnessSettings } = require('../src/harness-settings');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-harness-settings-'));

function write(name, value) {
  const file = path.join(temporary, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

try {
  const defaults = resolveHarnessSettings({});
  assert.deepStrictEqual(defaults.safeResolved.sync, { retryBackoffSeconds: [1, 2, 4], maxAttempts: 3 });
  assert.strictEqual(defaults.runtimeResolved.watch.scanIntervalSeconds, 5);
  assert(!JSON.stringify(defaults.safeResolved).includes('schedulerClientId'));
  assert(!JSON.stringify(defaults.safeResolved).includes('scanIntervalSeconds'));

  const workspace = write('workspace.json', {
    schemaVersion: 1,
    revision: 4,
    sync: { retryBackoffSeconds: [2, 5], maxAttempts: 2 },
    adapter: { timeoutSeconds: 50 },
    adapters: {
      worker: { command: 'worker-cli', argsTemplate: ['--input', '{context}', '--result={result}'], timeoutSeconds: 40, enabled: true }
    },
    verify: { defaultAdapter: 'worker', defaultLenses: ['satisfaction-v1'] }
  });
  const project = write('project.json', {
    schemaVersion: 1,
    revision: 7,
    adapter: { timeoutSeconds: 25 },
    adapters: {
      worker: { enabled: false },
      project: { command: 'project-cli', argsTemplate: ['{instruction}', '{operationId}'], timeoutSeconds: 20, enabled: true }
    },
    verify: { defaultAdapter: 'project', defaultLenses: ['boundary-v1', 'omission-v1'] },
    drive: { schedulerClientId: 'agent-one' }
  });
  const merged = resolveHarnessSettings({ workspaceFile: workspace, projectFile: project });
  assert.strictEqual(merged.workspaceRevision, 4);
  assert.strictEqual(merged.projectRevision, 7);
  assert.deepStrictEqual(merged.runtimeResolved.sync.retryBackoffSeconds, [2, 5]);
  assert.strictEqual(merged.runtimeResolved.adapter.timeoutSeconds, 25);
  assert.deepStrictEqual(merged.runtimeResolved.adapters.worker, { enabled: false }, 'adapter entries replace as a whole');
  assert.deepStrictEqual(merged.runtimeResolved.verify.defaultLenses, ['boundary-v1', 'omission-v1'], 'arrays replace as a whole');
  assert.strictEqual(merged.sources.adapter.timeoutSeconds, 'project');
  assert.strictEqual(merged.sources.sync.maxAttempts, 'workspace');
  assert.deepStrictEqual(merged.safeResolved.adapterRefs.worker, { enabled: false });
  assert.strictEqual(merged.safeResolved.adapterRefs.project.commandDigest.length, 64);
  assert.strictEqual(merged.safeResolved.adapterRefs.project.argsTemplateDigest.length, 64);
  const pinned = JSON.stringify(merged.safeResolved);
  assert(!pinned.includes('project-cli'));
  assert(!pinned.includes('{instruction}'));
  assert(!pinned.includes('agent-one'));

  const duplicate = write('duplicate.json', '{"schemaVersion":1,"revision":1,"sync":{"maxAttempts":3,"maxAttempts":3}}');
  assert.throws(() => resolveHarnessSettings({ workspaceFile: duplicate }), /중복 JSON 키/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('unknown.json', { schemaVersion: 1, revision: 1, mystery: true }) }), /알 수 없는 키/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('schema.json', { schemaVersion: 2, revision: 1 }) }), /schemaVersion/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('revision.json', { schemaVersion: 1, revision: 0 }) }), /revision/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('null.json', { schemaVersion: 1, revision: 1, adapter: { timeoutSeconds: null } }) }), /timeoutSeconds/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('backoff.json', { schemaVersion: 1, revision: 1, sync: { retryBackoffSeconds: [2, 2], maxAttempts: 2 } }) }), /엄격히 증가/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('attempts.json', { schemaVersion: 1, revision: 1, sync: { retryBackoffSeconds: [1, 2], maxAttempts: 3 } }) }), /길이와 같아야/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('lease.json', { schemaVersion: 1, revision: 1, lease: { ttlSeconds: 60, renewFactor: 0.1 } }) }), /최소 10초/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('adapter-shape.json', { schemaVersion: 1, revision: 1, adapters: { bad: { enabled: true, name: 'bad' } } }) }), /알 수 없는 키/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('placeholder.json', { schemaVersion: 1, revision: 1, adapters: { bad: { command: 'bad', argsTemplate: ['{secret}'], timeoutSeconds: 1, enabled: true } } }) }), /placeholder/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('unknown-lens.json', { schemaVersion: 1, revision: 1, verify: { defaultLenses: ['mutable-project-lens-v1'] } }) }), /registry ID/u);
  assert.throws(() => resolveHarnessSettings({ workspaceFile: write('disabled-default.json', { schemaVersion: 1, revision: 1, adapters: { bad: { enabled: false } }, verify: { defaultAdapter: 'bad' } }) }), /활성 resolved adapter/u);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('harness settings tests passed\n');
