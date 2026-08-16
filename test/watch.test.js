'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const {
  defaultInputSnapshot,
  scanRevision,
  dedupKey,
  relationName,
  remoteRelation,
  validateWatchRecord,
  writeNdjsonRecords,
  observeRemoteScope,
  createWatchSession,
  runWatch
} = require('../src/watch');
const { workspaceLayout, selectProject } = require('../src/workspace');

const temporary = path.join(os.tmpdir(), `rundol-watch-test-${process.pid}`);

function command(cwd, args) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return (result.stdout || '').trim();
}

function fixture(name) {
  const root = path.join(temporary, name);
  const project = path.join(root, 'projects', 'demo');
  fs.mkdirSync(path.join(root, '.rundol'), { recursive: true });
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects', 'workspace', 'events', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rundol', 'workspace.yaml'), 'schemaVersion: 2\nid: workspace\nmount: projects\ngit:\n  ref: refs/heads/rundol/workspace\n', 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), '.rundol/\n', 'utf8');
  fs.writeFileSync(path.join(project, 'project.md'), '# Demo\n', 'utf8');
  fs.writeFileSync(path.join(project, 'tasks.json'), '{"schemaVersion":1,"tasks":{}}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'projects', 'workspace', 'events', 'run', 'fixture.jsonl'), '{"eventId":"EVT-FIXTURE"}\n', 'utf8');
  fs.writeFileSync(path.join(project, 'docs', 'REQ-001-요구.md'), '---\nid: REQ-001\ntype: REQ\ntitle: Requirement\n---\n\n# Requirement\n', 'utf8');
  command(root, ['git', 'init', '--quiet']);
  command(root, ['git', 'config', 'user.email', 'watch@example.invalid']);
  command(root, ['git', 'config', 'user.name', 'Watch Test']);
  command(root, ['git', 'add', '.']);
  command(root, ['git', 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

function snapshot(head, documentRevision) {
  return {
    head,
    gitStatusDigest: 'a'.repeat(64),
    documents: [['REQ-001', documentRevision]],
    taskShardDigests: [['tasks.json', 'b'.repeat(64)]],
    projectConfigDigests: [],
    workspaceConfigDigests: [],
    registeredEventShardHeads: [],
    diagnosticSourceRevisions: [['projects/demo/docs/REQ-001-?붽뎄.md', documentRevision]]
  };
}

function diagnostic() {
  return { diagnostics: [{ project: 'demo', artifactId: 'REQ-001', code: 'RDL-TEST-001', severity: 'error', category: 'test', file: 'docs/REQ-001-요구.md', line: 7, message: 'bounded finding' }] };
}

const running = (async () => {
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  const root = fixture('stable');
  const head = command(root, ['git', 'rev-parse', 'HEAD']);
  const initialRevision = '1'.repeat(64);
  const layout = workspaceLayout(root);
  const project = selectProject(layout, 'demo', true);
  project.tasks = path.join(project.root, 'tasks.json');
  const inventory = defaultInputSnapshot({ layout, project }).diagnosticSourceRevisions.map(([file]) => file);
  assert(inventory.some((file) => file.includes('/docs/REQ-001-')), 'valid document file revision must be inventoried');
  assert(inventory.some((file) => file.endsWith('/project.md')), 'no-ID document source must be inventoried');
  assert(inventory.some((file) => file.endsWith('/tasks.json')), 'task source must be inventoried');
  assert(inventory.some((file) => file.endsWith('/events/run/fixture.jsonl')), 'event shard head must be inventoried');
  let current = snapshot(head, initialRevision);
  const emitted = [];
  const session = createWatchSession(root, { project: 'demo', watchId: 'WATCH-00000000000000000001' }, {
    inputSnapshot: () => JSON.parse(JSON.stringify(current)),
    checkWorkspace: () => diagnostic(),
    writeRecords: (records) => emitted.push(...records)
  });
  const trackedBefore = command(root, ['git', 'status', '--porcelain=v1', '--untracked-files=all']);
  const headBefore = command(root, ['git', 'rev-parse', 'HEAD']);

  const first = await session.scanOnce();
  assert.strictEqual(first.exitCode, 0);
  assert.strictEqual(first.records.length, 3);
  assert.deepStrictEqual(first.records.map((record) => record.type), ['watch.scan.started', 'watch.diagnostic', 'watch.scan.completed']);
  assert.strictEqual(first.records[0].scanId, scanRevision(current));
  assert.strictEqual(first.records[1].dedupKey, dedupKey('REQ-001', 'RDL-TEST-001', initialRevision));
  assert.deepStrictEqual(first.records.map((record) => record.sequence), [1, 2, 3]);
  first.records.forEach(validateWatchRecord);

  const unchanged = await session.scanOnce();
  assert.deepStrictEqual(unchanged.records.map((record) => record.type), ['watch.scan.started', 'watch.scan.completed']);
  assert.deepStrictEqual(unchanged.records.map((record) => record.sequence), [4, 5]);
  assert.strictEqual(unchanged.records[1].activeDiagnosticKeys.length, 1);

  current = snapshot(head, '2'.repeat(64));
  const changed = await session.scanOnce();
  assert.strictEqual(changed.records.filter((record) => record.type === 'watch.diagnostic').length, 1, 'content revision change must create a new diagnostic identity');
  assert.strictEqual(changed.records.at(-1).activeDiagnosticKeys.length, 1);

  const deleteSession = createWatchSession(root, { project: 'demo', watchId: 'WATCH-00000000000000000002' }, {
    inputSnapshot: () => JSON.parse(JSON.stringify(current)),
    checkWorkspace: () => ({ diagnostics: [] }),
    writeRecords: () => {}
  });
  const deleted = await deleteSession.scanOnce();
  assert.deepStrictEqual(deleted.records.map((record) => record.type), ['watch.scan.started', 'watch.scan.completed']);
  assert.deepStrictEqual(deleted.records.at(-1).activeDiagnosticKeys, [], 'delete resolves by omission from the active set');

  assert.strictEqual(command(root, ['git', 'status', '--porcelain=v1', '--untracked-files=all']), trackedBefore, 'watch may change only ignored state');
  assert.strictEqual(command(root, ['git', 'rev-parse', 'HEAD']), headBefore);

  fs.rmSync(path.join(root, '.rundol', 'state', 'watch'), { recursive: true, force: true });
  const rebuiltOutput = [];
  const rebuilt = createWatchSession(root, { project: 'demo', watchId: 'WATCH-00000000000000000003' }, {
    inputSnapshot: () => JSON.parse(JSON.stringify(current)),
    checkWorkspace: () => diagnostic(),
    writeRecords: (records) => rebuiltOutput.push(...records)
  });
  const rebuiltScan = await rebuilt.scanOnce();
  assert.strictEqual(rebuiltScan.records.filter((record) => record.type === 'watch.diagnostic').length, 1, 'cache deletion permits one safe re-emission');
  fs.writeFileSync(rebuilt.cacheFile, '{corrupt', 'utf8');
  const corruptRebuild = createWatchSession(root, { project: 'demo', watchId: 'WATCH-00000000000000000008' }, {
    inputSnapshot: () => JSON.parse(JSON.stringify(current)), checkWorkspace: () => diagnostic(), writeRecords: () => {}
  });
  assert.strictEqual((await corruptRebuild.scanOnce()).records.filter((record) => record.type === 'watch.diagnostic').length, 1, 'corrupt cache is disposable and rebuildable');

  const unstableRoot = fixture('unstable');
  const unstableHead = command(unstableRoot, ['git', 'rev-parse', 'HEAD']);
  let capture = 0;
  let checks = 0;
  const unstableOutput = [];
  const unstable = createWatchSession(unstableRoot, { project: 'demo', watchId: 'WATCH-00000000000000000004' }, {
    inputSnapshot: () => snapshot(unstableHead, String(++capture).padStart(64, '0')),
    checkWorkspace: () => { checks += 1; return diagnostic(); },
    writeRecords: (records) => unstableOutput.push(...records)
  });
  const unstableResult = await unstable.scanOnce();
  assert.strictEqual(unstableResult.exitCode, 2);
  assert.strictEqual(checks, 3);
  assert.deepStrictEqual(unstableOutput.map((record) => record.type), ['watch.error']);
  assert(!fs.existsSync(unstable.cacheFile), 'unstable attempts must not mutate cache');

  const sourceRoot = fixture('source-change');
  const sourceHead = command(sourceRoot, ['git', 'rev-parse', 'HEAD']);
  let sourceRevision = '3'.repeat(64);
  const sourceSnapshot = () => ({
    ...snapshot(sourceHead, initialRevision),
    taskShardDigests: [['tasks.json', sourceRevision]],
    diagnosticSourceRevisions: [['tasks.json', sourceRevision]]
  });
  const sourceSession = createWatchSession(sourceRoot, { project: 'demo', watchId: 'WATCH-00000000000000000009' }, {
    inputSnapshot: sourceSnapshot,
    checkWorkspace: () => ({ diagnostics: [{ project: 'demo', code: 'RDL-SOURCE-001', severity: 'error', category: 'task', file: 'tasks.json', message: 'same code' }] }),
    writeRecords: () => {}
  });
  const sourceFirst = await sourceSession.scanOnce();
  const firstSourceKey = sourceFirst.records.find((record) => record.type === 'watch.diagnostic').dedupKey;
  sourceRevision = '4'.repeat(64);
  const sourceChanged = await sourceSession.scanOnce();
  const changedSourceKey = sourceChanged.records.find((record) => record.type === 'watch.diagnostic').dedupKey;
  assert.notStrictEqual(changedSourceKey, firstSourceKey, 'same code must re-emit when its responsible file revision changes');

  const flushRoot = fixture('flush-order');
  const flushHead = command(flushRoot, ['git', 'rev-parse', 'HEAD']);
  let finishWrite;
  const flushSession = createWatchSession(flushRoot, { project: 'demo', watchId: 'WATCH-00000000000000000010' }, {
    inputSnapshot: () => snapshot(flushHead, initialRevision),
    checkWorkspace: () => diagnostic(),
    writeRecords: () => new Promise((resolve) => { finishWrite = resolve; })
  });
  const pendingFlush = flushSession.scanOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert(!fs.existsSync(flushSession.cacheFile), 'cache suppression must wait for injected writer completion');
  finishWrite();
  await pendingFlush;
  assert(fs.existsSync(flushSession.cacheFile));

  const fakeStream = new EventEmitter();
  const flushSignals = [];
  fakeStream.write = (bytes, callback) => {
    assert(bytes.endsWith('\n'));
    setImmediate(() => { flushSignals.push('drain'); fakeStream.emit('drain'); });
    setImmediate(() => { flushSignals.push('callback'); callback(); });
    return false;
  };
  await writeNdjsonRecords([first.records[0]], fakeStream);
  assert.deepStrictEqual(flushSignals.sort(), ['callback', 'drain'], 'stdout writer must await callback and drain');

  assert.strictEqual(relationName(0, 0), 'equal');
  assert.strictEqual(relationName(2, 0), 'ahead');
  assert.strictEqual(relationName(0, 2), 'behind');
  assert.strictEqual(relationName(1, 1), 'diverged');
  const relation = remoteRelation('project', 'refs/heads/rundol/demo', 'a'.repeat(40), 'b'.repeat(40), 1, 2);
  assert.strictEqual(relation.relation, 'diverged');
  assert.match(relation.relationKey, /^[0-9a-f]{64}$/u);
  const gitCalls = [];
  const observed = observeRemoteScope({ scope: 'project', root, remote: 'origin', ref: 'refs/heads/rundol/demo', localRef: 'HEAD' }, (args) => {
    gitCalls.push(args);
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: args[1] === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40), stderr: '' };
    return { status: 0, stdout: '1 2', stderr: '' };
  });
  assert.strictEqual(observed.relation, 'diverged');
  assert.deepStrictEqual(gitCalls[0].slice(0, 4), ['fetch', '--no-tags', '--no-write-fetch-head', 'origin']);
  assert(!gitCalls.some((args) => ['merge', 'reset', 'checkout', 'commit', 'push'].includes(args[0])), 'remote observation must be fetch-and-compare only');
  assert.throws(() => validateWatchRecord({ ...first.records[0], unknown: true }), /unknown/u);

  let networkCalls = 0;
  const localOnly = createWatchSession(root, { project: 'demo', remote: false, watchId: 'WATCH-00000000000000000005' }, {
    inputSnapshot: () => current,
    checkWorkspace: () => ({ diagnostics: [] }),
    writeRecords: () => {},
    remoteScopes: [{ scope: 'project' }],
    observeRemoteScope: () => { networkCalls += 1; return relation; }
  });
  assert.strictEqual((await localOnly.observeRemote()).skipped, true);
  assert.strictEqual(networkCalls, 0, 'without --remote there must be zero network calls');

  const remoteOutput = [];
  const remoteSession = createWatchSession(root, { project: 'demo', remote: true, watchId: 'WATCH-00000000000000000006' }, {
    inputSnapshot: () => current,
    checkWorkspace: () => ({ diagnostics: [] }),
    writeRecords: (records) => remoteOutput.push(...records),
    remoteScopes: [{ scope: 'project' }],
    observeRemoteScope: () => { networkCalls += 1; return relation; }
  });
  await remoteSession.observeRemote();
  await remoteSession.observeRemote();
  assert.strictEqual(remoteOutput.filter((record) => record.type === 'watch.remote.relation').length, 1, 'unchanged remote relation is deduplicated');
  remoteOutput.forEach(validateWatchRecord);

  let released = false;
  const onceRoot = fixture('once');
  const onceHead = command(onceRoot, ['git', 'rev-parse', 'HEAD']);
  const once = await runWatch(onceRoot, { project: 'demo', once: true, remote: false, watchId: 'WATCH-00000000000000000007' }, {
    acquireLock: () => ({ release() { released = true; } }),
    inputSnapshot: () => snapshot(onceHead, initialRevision),
    checkWorkspace: () => ({ diagnostics: [] }),
    writeRecords: () => {}
  });
  assert.strictEqual(once.exitCode, 0);
  assert.strictEqual(released, true, 'watch lock must release in finally');

  process.stdout.write('watch tests passed\n');
})().finally(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

module.exports = running;
