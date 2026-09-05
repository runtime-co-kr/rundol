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

  // ── 승인 낡음이 감시 신호로 나간다 ──────────────────────────────────────────
  //
  // "문서가 승인 이후 바뀌었다"는 사실은 지금까지 화면(board)과 명령(doc status)에만
  // 있었다. 감시가 그것을 못 내면 사람은 승인 대비 변경을 알기 위해 매번 명령을 쳐야 하고,
  // 치지 않으면 승인 안 된 문서 위로 작업이 계속 쌓인다.
  //
  // 판정은 approval.js의 foldApprovals/trustState를 그대로 부른다. 원장 읽기만 주입해
  // 두 벌의 판정이 생기지 않았다는 것을 이 시험이 못박는다.
  const { foldApprovals } = require('../src/approval');
  const LEDGER_AUTHORITY = { clientOwners: [['agent-a', 'MEMBER-001']], members: ['MEMBER-001'], delegations: [] };
  const approvedRevision = '5'.repeat(64);
  const editedRevision = '6'.repeat(64);
  const reeditedRevision = '8'.repeat(64);
  const approvalEvent = (eventId, reviewedRevision) => ({
    schemaVersion: 1, eventId, type: 'approval.granted',
    rootRequestId: 'REQ-11111111111111111111', requestId: eventId.replace(/^EVT-/u, 'REQ-'),
    clientId: 'agent-a', projectId: 'demo', targetId: 'REQ-001', reviewedRevision,
    approvedBy: 'MEMBER-001', actorMemberId: 'MEMBER-001', basis: [{ kind: 'read' }],
    recordedAt: '2026-09-05T00:00:00.000Z'
  });
  const approvedOnce = foldApprovals([approvalEvent('EVT-AAAAAAAAAAAAAAAAAAAA', approvedRevision)], { authority: LEDGER_AUTHORITY }).approvals;

  const staleRoot = fixture('approval-stale');
  const staleHead = command(staleRoot, ['git', 'rev-parse', 'HEAD']);
  let staleDocumentRevision = editedRevision;
  // REQ-002는 승인 이력이 없다 — 미승인이다.
  const staleSnapshot = () => ({
    head: staleHead,
    gitStatusDigest: 'a'.repeat(64),
    documents: [['REQ-001', staleDocumentRevision], ['REQ-002', '7'.repeat(64)]],
    taskShardDigests: [],
    projectConfigDigests: [],
    workspaceConfigDigests: [],
    registeredEventShardHeads: [],
    diagnosticSourceRevisions: []
  });
  const staleSession = createWatchSession(staleRoot, { project: 'demo', watchId: 'WATCH-00000000000000000012' }, {
    inputSnapshot: staleSnapshot,
    checkWorkspace: () => ({ diagnostics: [] }),
    approvalHistories: () => approvedOnce,
    writeRecords: () => {}
  });
  const staleFirst = await staleSession.scanOnce();
  const staleSignals = staleFirst.records.filter((record) => record.type === 'watch.diagnostic');
  assert.strictEqual(staleSignals.length, 1, '승인 후 개정된 문서만 신호가 된다');
  assert.strictEqual(staleSignals[0].targetId, 'REQ-001');
  assert.strictEqual(staleSignals[0].code, 'RDL-APPROVE-030', '판정이 approval.js의 것이므로 코드도 승인의 이름 공간에 선다');
  assert.strictEqual(staleSignals[0].category, 'approval');
  assert.strictEqual(staleSignals[0].severity, 'warning');
  assert.strictEqual(staleSignals[0].targetRevision, editedRevision, '신호가 결박하는 리비전은 지금 스냅샷의 리비전이다');
  assert.strictEqual(staleSignals[0].dedupKey, dedupKey('REQ-001', 'RDL-APPROVE-030', editedRevision));
  assert.ok(staleSignals[0].message.includes('MEMBER-001'), '무엇으로 되돌아갈지 — 누가 승인했었는지를 싣는다');
  staleFirst.records.forEach(validateWatchRecord);
  // 미승인은 신호가 아니다. 아직 아무도 근거로 삼지 않은 줄이고, 승인 축을 쓰지 않는
  // 프로젝트에서는 문서 전건이 미승인이라 그대로 태우면 신호가 문서 전건으로 찬다.
  assert.ok(!staleSignals.some((record) => record.targetId === 'REQ-002'), '미승인은 사건이 아니라 줄이므로 감시 신호가 아니다');

  // 같은 리비전은 한 번만 운다. 매 스캔마다 우는 신호는 꺼진 신호와 같다.
  const staleAgain = await staleSession.scanOnce();
  assert.strictEqual(staleAgain.records.filter((record) => record.type === 'watch.diagnostic').length, 0, '같은 리비전의 낡음은 다시 울지 않는다');
  assert.deepStrictEqual(staleAgain.records.at(-1).activeDiagnosticKeys, [staleSignals[0].dedupKey], '울지 않아도 활성 집합에는 남는다');

  // 다시 고치면 다시 운다 — 그래야 "이번에 바뀐 것"이 보인다.
  staleDocumentRevision = reeditedRevision;
  const staleReedited = await staleSession.scanOnce();
  const reeditedSignals = staleReedited.records.filter((record) => record.type === 'watch.diagnostic');
  assert.strictEqual(reeditedSignals.length, 1, '다시 개정되면 새 리비전으로 다시 운다');
  assert.strictEqual(reeditedSignals[0].targetRevision, reeditedRevision);

  // 재승인은 문서 리비전을 바꾸지 않으므로(승인을 파일에 쓰지 않는다) 해소는 활성 집합에서
  // 빠지는 것으로만 표현된다. 새 레코드 타입 대신 watch.diagnostic 축을 쓴 이유가 이것이다.
  const reapproved = foldApprovals([
    approvalEvent('EVT-AAAAAAAAAAAAAAAAAAAA', approvedRevision),
    Object.assign(approvalEvent('EVT-BBBBBBBBBBBBBBBBBBBB', reeditedRevision), { recordedAt: '2026-09-05T00:01:00.000Z' })
  ], { authority: LEDGER_AUTHORITY }).approvals;
  const resolvedSession = createWatchSession(staleRoot, { project: 'demo', watchId: 'WATCH-00000000000000000013' }, {
    inputSnapshot: staleSnapshot,
    checkWorkspace: () => ({ diagnostics: [] }),
    approvalHistories: () => reapproved,
    writeRecords: () => {}
  });
  const resolved = await resolvedSession.scanOnce();
  assert.strictEqual(resolved.records.filter((record) => record.type === 'watch.diagnostic').length, 0);
  assert.deepStrictEqual(resolved.records.at(-1).activeDiagnosticKeys, [], '재승인은 활성 집합에서 빠지는 것으로 해소된다');

  // 승인 원장이 없어도 감시는 돈다. 감시는 저장소 전체를 훑는 자리라 원장 하나에 인질이
  // 되면 안 된다 — 이 fixture는 판올림 전(schemaVersion 2)이라 원장 자체가 없다.
  const noLedgerRoot = fixture('approval-no-ledger');
  const noLedgerHead = command(noLedgerRoot, ['git', 'rev-parse', 'HEAD']);
  const noLedgerSession = createWatchSession(noLedgerRoot, { project: 'demo', watchId: 'WATCH-00000000000000000014' }, {
    inputSnapshot: () => snapshot(noLedgerHead, initialRevision),
    checkWorkspace: () => diagnostic(),
    writeRecords: () => {}
  });
  const noLedger = await noLedgerSession.scanOnce();
  assert.strictEqual(noLedger.exitCode, 0, '승인 원장이 없어도 스캔은 완료된다');
  assert.strictEqual(noLedger.records.filter((record) => record.code === 'RDL-APPROVE-030').length, 0, '원장이 없으면 낡음 신호 없이 그냥 돈다');
  assert.strictEqual(noLedger.records.filter((record) => record.type === 'watch.diagnostic').length, 1, '나머지 진단은 원장과 무관하게 그대로 나간다');

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

  // remote 관찰은 remoteIntervalSeconds 자체 주기를 따른다 — 설정이 검증만 되고
  // 적용되지 않으면 스캔 주기마다 원격 fetch가 나간다.
  const intervalRoot = fixture('remote-interval');
  fs.writeFileSync(path.join(intervalRoot, 'projects', 'demo', 'harness.json'), `${JSON.stringify({ schemaVersion: 1, revision: 1, watch: { scanIntervalSeconds: 5, remoteIntervalSeconds: 300 } })}\n`, 'utf8');
  const intervalHead = command(intervalRoot, ['git', 'rev-parse', 'HEAD']);
  const intervalAbort = new AbortController();
  let intervalScans = 0;
  let intervalFetches = 0;
  let intervalClock = 0;
  const intervalResult = await runWatch(intervalRoot, { project: 'demo', remote: true, watchId: 'WATCH-00000000000000000011', signal: intervalAbort.signal }, {
    acquireLock: () => ({ release() {} }),
    inputSnapshot: () => { intervalScans += 1; if (intervalScans >= 4) intervalAbort.abort(); return snapshot(intervalHead, initialRevision); },
    checkWorkspace: () => ({ diagnostics: [] }),
    writeRecords: () => {},
    remoteScopes: [{ scope: 'project' }],
    observeRemoteScope: () => { intervalFetches += 1; return relation; },
    watchFactory: () => ({ close() {} }),
    setTimeout: (callback) => setTimeout(callback, 1),
    clearTimeout,
    now: () => { intervalClock += 5000; return intervalClock; }
  });
  assert.strictEqual(intervalResult.exitCode, 0);
  assert(intervalScans >= 4, '연속 감시는 여러 스캔을 수행해야 한다');
  assert.strictEqual(intervalFetches, 1, 'remoteIntervalSeconds 이내에는 스캔마다 원격을 관찰하지 않는다');

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
