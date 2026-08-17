'use strict';

// 이 스위트는 실제 자식 프로세스를 띄워 취소·종료 경로를 시험한다. Windows에서
// 그 실행은 기본으로 막혀 있으므로 여기서만 명시적으로 켠다 — 전역으로 켜면
// 기본 차단 모드가 전체 게이트에서 한 번도 시험되지 않는다.
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ledger = require('../src/run-ledger');
const { preflightDriveProcedure, driveChildKey, tickRun, runDrive, runContext } = require('../src/run');
const { executeOnce } = require('../src/adapter');
const requestJournal = require('../src/request-journal');
const { runtimeWorkspace } = require('../src/runtime');

const HASH = 'a'.repeat(64);
let serial = 1;
function identifier(prefix) { return `${prefix}-${(serial++).toString(16).toUpperCase().padStart(20, '0')}`; }

assert.strictEqual(driveChildKey('driver', HASH, 'acquire'), `driver:${HASH}:acquire:`);
assert.strictEqual(driveChildKey('driver', HASH, 'renew', 'EVT-AAAAAAAAAAAAAAAAAAAA'), `driver:${HASH}:renew:EVT-AAAAAAAAAAAAAAAAAAAA`);
assert.strictEqual(driveChildKey('release', HASH, 'completed', 'EVT-AAAAAAAAAAAAAAAAAAAA'), `release:${HASH}:completed:EVT-AAAAAAAAAAAAAAAAAAAA`);
assert.strictEqual(driveChildKey('outcome', HASH, 'step-completed'), `outcome:${HASH}:step-completed:`);
assert.strictEqual(driveChildKey('halt', HASH, 'lease-lost'), `halt:${HASH}:lease-lost:`);

function procedure(steps) {
  return { name: 'drive-test', revision: 1, schemaVersion: 1, idempotent: true, steps };
}

function startEvent(resolved) {
  const eventId = identifier('EVT');
  return {
    schemaVersion: 2, eventId, type: 'run.started', rootRequestId: identifier('REQ'), requestId: identifier('REQ'),
    clientId: 'agent-one', projectId: 'demo', runId: 'RUN-00000000000000000001', ownerToken: eventId,
    procedure: { name: resolved.name, revision: resolved.revision, schemaVersion: 1, contentHash: HASH, resolved },
    settings: { schemaVersion: 1, contentHash: HASH, safeResolved: {} }
  };
}

function progress(started, values) {
  return {
    schemaVersion: 2, eventId: identifier('EVT'), rootRequestId: identifier('REQ'), requestId: identifier('REQ'),
    clientId: 'agent-one', projectId: 'demo', runId: started.runId, ownerToken: started.ownerToken,
    ...values
  };
}

function context(events) {
  const ownership = ledger.ownershipState(events);
  return { events, ownership, fold: ledger.foldRun(events), owner: ownership.ownerClientId, project: { key: 'demo' }, layout: { root: '.' } };
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function readPidWithRetry(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) {
      const value = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(value) && value > 0) return value;
    }
    if (Date.now() > deadline) throw new Error(`자손 PID 파일이 준비되지 않았습니다: ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processExists(pid);
}

const running = (async () => {
  const gate = { id: 'gate', gate: { command: 'check', args: ['{artifact}', '--strict', '--project', '{project}'] }, onFail: { goto: 'author', maxAttempts: 3 } };
  const valid = procedure([
    { id: 'author', executor: 'adapter', adapter: 'fixture', instruction: { id: 'author-v1', revision: 1, instructionDigest: HASH }, args: [], retrySafety: { mode: 'operation-id' } },
    gate,
    { id: 'publish', executor: 'cli', command: 'publish-fixture', args: ['--key', 'fixed'], retrySafety: { mode: 'gate-recheck', gateStep: 'gate' } },
    { id: 'sync', human: true }
  ]);
  assert.strictEqual(preflightDriveProcedure(valid), valid);
  assert.throws(() => preflightDriveProcedure({ ...valid, idempotent: false }), /idempotent/u);
  assert.throws(() => preflightDriveProcedure(procedure([{ id: 'bad', executor: 'cli', command: 'x', args: [] }])), /retrySafety/u);
  assert.throws(() => preflightDriveProcedure(procedure([{ id: 'bad-gate', gate: { command: 'save', args: ['{artifact}'] } }])), /check/u);
  assert.throws(() => preflightDriveProcedure(procedure([{ id: 'bad', executor: 'cli', command: 'x', args: ['{operationId}', '{operationId}'], retrySafety: { mode: 'operation-id' } }])), /exactly one/u);
  assert.throws(() => preflightDriveProcedure(procedure([gate, { id: 'bad-recheck', executor: 'cli', command: 'x', args: ['{operationId}'], retrySafety: { mode: 'gate-recheck', gateStep: 'gate' } }])), /cannot consume operationId/u);

  const operationId = ledger.operationIdFor({ runId: 'RUN-00000000000000000001', procedureContentHash: HASH, stepId: 'author', logicalAttempt: 1 });
  assert.match(operationId, /^[0-9a-f]{64}$/u);
  assert.strictEqual(operationId, ledger.operationIdFor({ runId: 'RUN-00000000000000000001', procedureContentHash: HASH, stepId: 'author', logicalAttempt: 1 }));
  assert.notStrictEqual(operationId, ledger.operationIdFor({ runId: 'RUN-00000000000000000001', procedureContentHash: HASH, stepId: 'author', logicalAttempt: 2 }));

  const retryStart = startEvent(procedure([{ id: 'author', executor: 'cli', command: 'x', args: ['{operationId}'], retrySafety: { mode: 'operation-id' } }, gate, { id: 'sync', human: true }]));
  const authorDone = progress(retryStart, { type: 'run.step', stepId: 'author', executor: 'cli', exitCode: 0, artifactIds: ['REQ-001'] });
  const gateFailed = progress(retryStart, { type: 'run.gate', stepId: 'gate', command: 'check', args: ['REQ-001', '--strict', '--project', 'demo'], exitCode: 1, diagnostics: ['RDL-X'], attempt: 1 });
  const retryEvents = [retryStart, authorDone, gateFailed, gateFailed];
  assert.strictEqual(ledger.logicalAttemptForStep(retryEvents, 'author'), 2, 'applied author-to-gate failure increments the repeated author once');
  assert.strictEqual(ledger.logicalAttemptForStep(retryEvents, 'gate'), 2, 'the same retry interval increments the gate once');
  assert.strictEqual(ledger.logicalAttemptForStep(retryEvents, 'sync'), 1, 'steps outside the retry interval do not increment');

  const conflictProcedure = procedure([{ id: 'action', executor: 'cli', command: 'x', args: ['{operationId}'], retrySafety: { mode: 'operation-id' } }, { id: 'sync', human: true }]);
  const conflictStart = startEvent(conflictProcedure);
  const opId = ledger.operationIdFor({ runId: conflictStart.runId, procedureContentHash: HASH, stepId: 'action', logicalAttempt: 1 });
  function outcome(artifact, eventId) {
    const operation = ledger.createOperation({ operationId: opId, stepId: 'action', logicalAttempt: 1, outcomeKind: 'step-completed', exitCode: 0, sortedArtifactIds: [artifact], sortedDiagnosticCodes: [], boundedResultDecision: { artifactIds: [artifact] } });
    return { ...progress(conflictStart, { type: 'run.step', stepId: 'action', executor: 'cli', exitCode: 0, artifactIds: [artifact], operation }), eventId: eventId || identifier('EVT') };
  }
  const equivalentA = outcome('REQ-001');
  const equivalentB = { ...equivalentA, eventId: identifier('EVT'), requestId: identifier('REQ') };
  assert.strictEqual(ledger.foldRun([conflictStart, equivalentA, equivalentB]).status, 'running', 'equivalent outcomes fold once and advance to human boundary');
  const conflicting = outcome('REQ-002');
  const conflictedEvents = [conflictStart, equivalentA, conflicting];
  const conflicted = ledger.foldRun(conflictedEvents);
  assert.strictEqual(conflicted.status, 'operation-conflict');
  assert.strictEqual(conflicted.cursor, 'action', 'conflicting outcomes apply neither result');
  const conflict = conflicted.operationConflicts[0];
  const selected = conflict.candidates.find((candidate) => candidate.selectedOutcomeDigest === equivalentA.operation.outcomeDigest);
  const resolved = progress(conflictStart, {
    type: 'run.operation_resolved', operationId: opId, conflictId: conflict.conflictId, candidates: conflict.candidates,
    selectedDecisionEventId: selected.decisionEventId, selectedOutcomeDigest: selected.selectedOutcomeDigest,
    resolverMemberId: 'MEMBER-001', reason: 'select deterministic result', forced: false
  });
  const resolvedFold = ledger.foldRun(conflictedEvents.concat(resolved));
  assert.strictEqual(resolvedFold.status, 'running');
  assert.strictEqual(resolvedFold.cursor, 'sync');

  // 완료가 operation 충돌을 은폐하지 못한다 — 상태는 completed_local로 남더라도
  // 충돌 증거는 operationConflicts와 진단(RDL-RUN-028)으로 항상 노출된다.
  const completedAfterConflict = progress(conflictStart, { type: 'run.completed_local', commit: 'f'.repeat(40), artifactIds: [] });
  const maskedFold = ledger.foldRun(conflictedEvents.concat(completedAfterConflict));
  assert.strictEqual(maskedFold.status, 'completed_local');
  assert.strictEqual(maskedFold.operationConflicts.length, 1, '완료가 operation 충돌 증거를 지우면 안 된다');
  assert(maskedFold.diagnostics.some((item) => item.code === 'RDL-RUN-028'));

  const humanStart = startEvent(procedure([{ id: 'sync', human: true }]));
  let writes = 0;
  const human = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, { runContext: () => context([humanStart]), recordEvent: () => { writes += 1; } });
  assert.deepStrictEqual({ exitCode: human.exitCode, status: human.status, step: human.step }, { exitCode: 0, status: 'waiting_human', step: 'sync' });
  assert.strictEqual(writes, 0, 'human/sync boundary must not write or push');

  const recheckProcedure = procedure([{ id: 'action', executor: 'cli', command: 'mutate', args: [], retrySafety: { mode: 'gate-recheck', gateStep: 'postcheck' } }, { id: 'postcheck', gate: { command: 'check', args: ['{artifact}', '--strict'] } }, { id: 'sync', human: true }]);
  const recheckStart = startEvent(recheckProcedure);
  let executions = 0;
  const recorded = [];
  const rechecked = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => context([recheckStart]), executeGate: () => ({ exitCode: 0, diagnosticCodes: [] }),
    executeCli: () => { executions += 1; return { exitCode: 0, artifactIds: [] }; },
    recordEvent: (_context, event) => { recorded.push(event); }
  });
  assert.strictEqual(rechecked.rechecked, true);
  assert.strictEqual(executions, 0, 'satisfied gate-recheck skips the mutating action');
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].operation.outcomeKind, 'step-completed');

  for (const exitCode of [1, 2]) {
    executions = 0; recorded.length = 0;
    const result = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
      runContext: () => context([recheckStart]), executeGate: () => ({ exitCode, diagnosticCodes: [] }),
      acquireLease: () => ({ id: 'lease' }), executeCli: () => { executions += 1; return { exitCode: 0, artifactIds: [] }; },
      recordEvent: (_context, event) => { recorded.push(event); }
    });
    assert.strictEqual(executions, exitCode === 1 ? 1 : 0);
    if (exitCode === 2) assert.strictEqual(result.exitCode, 2);
  }

  let locked = 0;
  await assert.rejects(() => runDrive('.', {}, { preflight: () => { preflightDriveProcedure({ ...valid, idempotent: false }); }, acquireLock: () => { locked += 1; } }), /idempotent/u);
  assert.strictEqual(locked, 0, 'invalid procedure rejects before acquiring a lock');

  const restartProcedure = procedure([{ id: 'action', executor: 'cli', command: 'x', args: ['{operationId}'], retrySafety: { mode: 'operation-id' } }, { id: 'sync', human: true }]);
  const restartEvents = [startEvent(restartProcedure)];
  const physical = new Map();
  let released = 0;
  const driveDeps = {
    preflight: () => ({ layout: { root: '.' }, project: { key: 'demo' } }),
    acquireLock: () => ({ release() { released += 1; } }),
    runContext: () => context(restartEvents),
    acquireLease: () => ({ id: 'lease' }),
    executeCli: ({ operationId: id }) => { physical.set(id, (physical.get(id) || 0) + 1); return { exitCode: 0, artifactIds: ['REQ-001'] }; },
    recordEvent: (_context, event) => { restartEvents.push(progress(restartEvents[0], event)); }
  };
  const driven = await runDrive('.', { clientId: 'agent-one', run: restartEvents[0].runId }, driveDeps);
  assert.strictEqual(driven.status, 'waiting_human');
  const restarted = await runDrive('.', { clientId: 'agent-one', run: restartEvents[0].runId }, driveDeps);
  assert.strictEqual(restarted.status, 'waiting_human');
  assert.match(driven.rootRequestId, /^REQ-[A-F0-9]{20}$/u);
  assert.match(restarted.rootRequestId, /^REQ-[A-F0-9]{20}$/u);
  assert.notStrictEqual(restarted.rootRequestId, driven.rootRequestId, 'omitted drive request IDs must create a fresh invocation root');
  assert.deepStrictEqual(Array.from(physical.values()), [1], 'restart after committed outcome does not execute the operation twice');
  assert.strictEqual(released, 2);

  const leaseLostEvents = [startEvent(restartProcedure)];
  const lost = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => context(leaseLostEvents), acquireLease: () => ({ id: 'lease' }), heartbeatIntervalMs: 1,
    executeCli: () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, artifactIds: [] }), 25)),
    renewLease: () => { throw new Error('lost'); }, releaseLease: () => {}, recordEvent: (_context, event) => { leaseLostEvents.push(progress(leaseLostEvents[0], event)); }
  });
  assert.strictEqual(lost.reason, 'lease-lost');
  assert.strictEqual(leaseLostEvents.at(-1).type, 'run.halted');

  const heartbeatDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-drive-heartbeat-'));
  try {
    const descendantFile = path.join(heartbeatDirectory, 'descendant.pid');
    const adapterProcedure = procedure([{ id: 'action', executor: 'adapter', adapter: 'fixture', args: [], retrySafety: { mode: 'operation-id' } }, { id: 'sync', human: true }]);
    const adapterEvents = [startEvent(adapterProcedure)];
    const adapterRecords = [];
    const heartbeatOrder = [];
    const heartbeatLost = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
      runContext: () => context(adapterEvents), acquireLease: () => ({ id: 'lease' }), heartbeatIntervalMs: 200,
      renewLease: () => { if (!fs.existsSync(descendantFile)) return; heartbeatOrder.push('renew'); throw new Error('renew failed'); },
      syncLease: () => { heartbeatOrder.push('sync'); }, releaseLease: () => { heartbeatOrder.push('release'); },
      executeAdapter: async ({ signal }) => {
        const source = "const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));if(process.platform!=='win32')process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);";
        // 자식과 손자의 cwd를 임시 디렉터리로 두면 Windows가 그 디렉터리를 잠그고,
        // 정리가 EBUSY로 실패한다. 프로세스가 죽어도 핸들 해제가 늦으면 재시도로는
        // 못 넘긴다 — 기다릴 게 아니라 잠금을 만들지 않는다. pid 파일 경로는
        // 절대 경로이므로 cwd와 무관하다.
        const execution = await executeOnce(process.execPath, ['-e', source, descendantFile], { cwd: os.tmpdir(), env: process.env, timeoutSeconds: 10, signal });
        return { exitCode: execution.category === 'success' ? 0 : 2, artifactIds: [] };
      },
      recordEvent: (_context, event) => { adapterRecords.push(event); adapterEvents.push(progress(adapterEvents[0], event)); }
    });
    assert.strictEqual(heartbeatLost.reason, 'lease-lost');
    assert.deepStrictEqual(heartbeatOrder.slice(-2), ['renew', 'release'], 'renewal failure aborts before sync and releases the lease');
    assert.strictEqual(adapterRecords.some((event) => event.type === 'run.step'), false, 'an aborted adapter cannot append an outcome');
    assert.strictEqual(adapterRecords.at(-1).type, 'run.halted');
    const heartbeatDescendantPid = readPidWithRetry(descendantFile, 5000);
    assert.strictEqual(await waitForProcessExit(heartbeatDescendantPid, 3000), true, `lease-lost descendant ${heartbeatDescendantPid} survived adapter cancellation`);
  } finally {
    await fs.promises.rm(heartbeatDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  const cliHeartbeatDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-drive-cli-heartbeat-'));
  try {
    const cliEntry = path.join(cliHeartbeatDirectory, 'cli-fixture.js');
    const cliDescendantFile = path.join(cliHeartbeatDirectory, 'descendant.pid');
    fs.writeFileSync(cliEntry, "'use strict';const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync(process.argv[3],String(child.pid));if(process.platform!=='win32')process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);", 'utf8');
    const cliProcedure = procedure([{ id: 'action', executor: 'cli', command: 'fixture', args: [cliDescendantFile, '{operationId}'], retrySafety: { mode: 'operation-id' } }, { id: 'sync', human: true }]);
    const cliEvents = [startEvent(cliProcedure)];
    const cliRecords = [];
    const cliHeartbeatOrder = [];
    const cliLost = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
      runContext: () => context(cliEvents), acquireLease: () => ({ id: 'lease' }), heartbeatIntervalMs: 200,
      renewLease: () => { if (!fs.existsSync(cliDescendantFile)) return; cliHeartbeatOrder.push('renew'); throw new Error('renew failed'); },
      syncLease: () => { cliHeartbeatOrder.push('sync'); }, releaseLease: () => { cliHeartbeatOrder.push('release'); },
      driveCliEntry: cliEntry, cliTimeoutSeconds: 10,
      recordEvent: (_context, event) => { cliRecords.push(event); cliEvents.push(progress(cliEvents[0], event)); }
    });
    assert.strictEqual(cliLost.reason, 'lease-lost');
    assert.deepStrictEqual(cliHeartbeatOrder.slice(-2), ['renew', 'release']);
    assert.strictEqual(cliRecords.some((event) => event.type === 'run.step'), false, 'an aborted CLI cannot append an outcome');
    assert.strictEqual(cliRecords.at(-1).type, 'run.halted');
    const cliDescendantPid = readPidWithRetry(cliDescendantFile, 5000);
    assert.strictEqual(await waitForProcessExit(cliDescendantPid, 3000), true, `lease-lost CLI descendant ${cliDescendantPid} survived cancellation`);
  } finally {
    await fs.promises.rm(cliHeartbeatDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  const syncFailureProcedure = procedure([{ id: 'action', executor: 'adapter', adapter: 'fixture', args: [], retrySafety: { mode: 'operation-id' } }, { id: 'sync', human: true }]);
  const syncFailureEvents = [startEvent(syncFailureProcedure)];
  const syncFailureOrder = [];
  const syncLost = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => context(syncFailureEvents), acquireLease: () => ({ id: 'lease' }), heartbeatIntervalMs: 1,
    renewLease: () => { syncFailureOrder.push('renew'); },
    syncLease: () => { syncFailureOrder.push('sync'); throw new Error('workspace sync failed'); },
    releaseLease: () => { syncFailureOrder.push('release'); },
    executeAdapter: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: 2 }), { once: true })),
    recordEvent: (_context, event) => { syncFailureEvents.push(progress(syncFailureEvents[0], event)); }
  });
  assert.strictEqual(syncLost.reason, 'lease-lost');
  assert.deepStrictEqual(syncFailureOrder, ['renew', 'sync', 'release']);
  assert.strictEqual(syncFailureEvents.some((event) => event.type === 'run.step'), false, 'workspace sync failure cannot append an action outcome');
  assert.strictEqual(syncFailureEvents.at(-1).type, 'run.halted');

  const defaultLeaseEvents = [startEvent(restartProcedure)];
  const driverTypes = [];
  const driverApi = {};
  for (const [method, type] of [['acquireDriverLease', 'driver.acquired'], ['renewDriverLease', 'driver.renewed'], ['releaseDriverLease', 'driver.released']]) {
    driverApi[method] = (_root, event) => { driverTypes.push(type); return { event }; };
  }
  const defaultLeaseResult = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => ({ ...context(defaultLeaseEvents), layout: { root: '.', schemaVersion: 6 } }),
    leaseSettings: { ttlSeconds: 60, renewFactor: 0.5 }, driverLease: driverApi,
    driverEventsRoot: 'events', driverLockDirectory: 'locks', driverRuntime: { pending: 'unused' }, now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    executeCli: () => ({ exitCode: 0, artifactIds: [] }),
    recordEvent: (_context, event) => { defaultLeaseEvents.push(progress(defaultLeaseEvents[0], event)); }
  });
  assert.strictEqual(defaultLeaseResult.status, 'continue');
  assert.deepStrictEqual(driverTypes, ['driver.acquired', 'driver.released'], 'a short action releases its soft lease without an unnecessary renewal');

  driverTypes.length = 0;
  let leaseSyncs = 0;
  const heartbeatSuccess = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => ({ ...context([startEvent(restartProcedure)]), layout: { root: '.', schemaVersion: 6 } }),
    leaseSettings: { ttlSeconds: 60, renewFactor: 0.5 }, driverLease: driverApi,
    driverEventsRoot: 'events', driverLockDirectory: 'locks', driverRuntime: { pending: 'unused' }, heartbeatIntervalMs: 2,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'), syncLease: () => { leaseSyncs += 1; },
    executeCli: () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, artifactIds: [] }), 12)), recordEvent: () => {}
  });
  assert.strictEqual(heartbeatSuccess.status, 'continue');
  assert(driverTypes.includes('driver.renewed'), 'a long action renews the soft lease');
  assert.strictEqual(leaseSyncs, driverTypes.filter((type) => type === 'driver.renewed').length, 'each renewal is followed by one workspace sync');
  assert.strictEqual(driverTypes.at(-1), 'driver.released');

  driverTypes.length = 0;
  const defaultLeaseError = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => ({ ...context([startEvent(restartProcedure)]), layout: { root: '.', schemaVersion: 6 } }),
    leaseSettings: { ttlSeconds: 60, renewFactor: 0.5 }, driverLease: driverApi,
    driverEventsRoot: 'events', driverLockDirectory: 'locks', driverRuntime: { pending: 'unused' }, now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    executeCli: () => ({ exitCode: 2, artifactIds: [] }), recordEvent: () => { throw new Error('exit 2 must not append a progress result'); }
  });
  assert.strictEqual(defaultLeaseError.status, 'error');
  assert.deepStrictEqual(driverTypes, ['driver.acquired', 'driver.released'], 'environment exit releases the default soft lease');

  // 실패한 스텝은 반환값만 halted가 아니라 원장도 halted다 — run.step(exit 1) 뒤에
  // run.halted(step-failed)가 기록되어 fold가 running으로 남지 않는다. 그렇지
  // 않으면 다음 drive가 실패 스텝을 재개 절차 없이 다시 실행한다.
  const failedEvents = [startEvent(restartProcedure)];
  const failedRecords = [];
  const failedResult = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => context(failedEvents),
    acquireLease: () => ({ id: 'lease' }), releaseLease: () => {},
    executeCli: () => ({ exitCode: 1, artifactIds: [] }),
    recordEvent: (_context, event) => { failedRecords.push(event); failedEvents.push(progress(failedEvents[0], event)); }
  });
  assert.strictEqual(failedResult.status, 'halted');
  assert.strictEqual(failedResult.reason, 'step-failed');
  assert.deepStrictEqual(failedRecords.map((event) => event.type), ['run.step', 'run.halted']);
  assert.strictEqual(failedRecords.at(-1).reason, 'step-failed');
  assert.strictEqual(ledger.foldRun(failedEvents).status, 'halted');
  assert.strictEqual(ledger.foldRun(failedEvents).haltReason, 'step-failed');

  // verify 스텝은 검증 커널을 지나고 정족수 판정만 run.gate로 남는다. onFail이
  // 없으면 반박됐을 때 돌아갈 곳이 없으므로 preflight가 거부한다.
  const verifyStep = { id: 'verify', executor: 'adapter', verify: { lenses: ['satisfaction-v1'] }, onFail: { goto: 'author', maxAttempts: 2 } };
  const verifyProcedure = procedure([
    { id: 'author', executor: 'cli', command: 'x', args: ['{operationId}'], retrySafety: { mode: 'operation-id' } },
    verifyStep,
    { id: 'sync', human: true }
  ]);
  assert.strictEqual(preflightDriveProcedure(verifyProcedure), verifyProcedure);
  assert.throws(() => preflightDriveProcedure(procedure([
    { id: 'author', executor: 'cli', command: 'x', args: ['{operationId}'], retrySafety: { mode: 'operation-id' } },
    { id: 'verify', executor: 'adapter', verify: { lenses: ['satisfaction-v1'] } },
    { id: 'sync', human: true }
  ])), /requires onFail/u);

  // 통과한 검증은 run.gate(exit 0)로 커서를 전진시킨다.
  const passStart = startEvent(verifyProcedure);
  const passEvents = [passStart, progress(passStart, { type: 'run.step', stepId: 'author', executor: 'cli', exitCode: 0, artifactIds: ['REQ-001'] })];
  const passRecords = [];
  const verifyRoots = [];
  const driveRequestId = identifier('REQ');
  const passed = await tickRun('.', { clientId: 'agent-one', requestId: driveRequestId }, {
    runContext: () => context(passEvents), acquireLease: () => ({ id: 'lease' }), releaseLease: () => {},
    verifyArtifact: (input) => { assert.strictEqual(input.targetId, 'REQ-001', '검증 대상은 최근 산출물이다'); verifyRoots.push(input.rootRequestId); return { fold: { status: 'passed' } }; },
    recordEvent: (_context, event) => { passRecords.push(event); passEvents.push(progress(passStart, event.type === 'run.gate' ? Object.assign({ attempt: 1 }, event) : event)); }
  });
  assert.strictEqual(passed.status, 'continue');
  // 검증은 자기 저널 root를 쓴다. drive의 root를 그대로 넘기면 같은 root에 서로
  // 다른 command digest(run.drive vs verify)가 요구되어 재생 대조가 충돌한다.
  assert(verifyRoots[0] && verifyRoots[0] !== driveRequestId, `검증 저널 root는 drive root와 분리되어야 합니다: ${verifyRoots[0]}`);
  assert.match(verifyRoots[0], /^REQ-[A-F0-9]{20}$/u);
  assert.deepStrictEqual(passRecords.map((event) => event.type), ['run.gate']);
  assert.strictEqual(passRecords[0].command, 'verify');
  assert.strictEqual(passRecords[0].exitCode, 0);
  assert.strictEqual(ledger.foldRun(passEvents).cursor, 'sync', '통과하면 다음 경계로 전진한다');

  // 반박은 절차가 정한 onFail 경로로 되돌아간다.
  const refuteStart = startEvent(verifyProcedure);
  const refuteEvents = [refuteStart, progress(refuteStart, { type: 'run.step', stepId: 'author', executor: 'cli', exitCode: 0, artifactIds: ['REQ-001'] })];
  const refuteRecords = [];
  const refuted = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => context(refuteEvents), acquireLease: () => ({ id: 'lease' }), releaseLease: () => {},
    verifyArtifact: () => ({ fold: { status: 'refuted' } }),
    recordEvent: (_context, event) => { refuteRecords.push(event); refuteEvents.push(progress(refuteStart, event.type === 'run.gate' ? Object.assign({ attempt: 1 }, event) : event)); }
  });
  assert.strictEqual(refuted.status, 'halted');
  assert.strictEqual(refuted.reason, 'gate-failed');
  assert.deepStrictEqual(refuteRecords.map((event) => event.type), ['run.gate', 'run.halted']);
  assert.strictEqual(ledger.foldRun(refuteEvents).cursor, 'author', '반박은 onFail 경로로 되돌린다');

  // 정족수 미달은 재시도로 풀리지 않는다 — 사람을 기다리는 정지다.
  const quorumStart = startEvent(verifyProcedure);
  const quorumEvents = [quorumStart, progress(quorumStart, { type: 'run.step', stepId: 'author', executor: 'cli', exitCode: 0, artifactIds: ['REQ-001'] })];
  const quorumRecords = [];
  const quorum = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => context(quorumEvents), acquireLease: () => ({ id: 'lease' }), releaseLease: () => {},
    verifyArtifact: () => ({ fold: { status: 'human_required' } }),
    recordEvent: (_context, event) => { quorumRecords.push(event); quorumEvents.push(progress(quorumStart, event.type === 'run.gate' ? Object.assign({ attempt: 1 }, event) : event)); }
  });
  assert.strictEqual(quorum.reason, 'verification-required');
  assert.strictEqual(quorumRecords.at(-1).reason, 'verification-required');
  // 사람 대기는 검증 실패가 아니다. 앞에 run.gate(exit 1)를 남기면 실패 attempt가
  // 늘고 onFail 되돌림 의미가 붙어, 원장에서 두 상태를 구분할 수 없게 된다.
  assert.deepStrictEqual(quorumRecords.map((event) => event.type), ['run.halted'], '정족수 미달은 게이트 판정을 남기지 않는다');
  assert.strictEqual(ledger.foldRun(quorumEvents).cursor, 'verify', '사람 대기 중에도 커서는 검증 스텝에 머문다');

  // takeover 후에도 저널이 충돌하지 않는다. verify root가 operationId만의 함수면
  // A가 준비한 root에 B의 command digest가 들어가 재생 대조가 깨진다.
  const takeoverStart = startEvent(verifyProcedure);
  const takeoverAuthor = progress(takeoverStart, { type: 'run.step', stepId: 'author', executor: 'cli', exitCode: 0, artifactIds: ['REQ-001'] });
  const successorToken = identifier('EVT');
  const rootsByOwner = [];
  for (const [clientId, ownerToken] of [['agent-one', takeoverStart.ownerToken], ['agent-two', successorToken], ['agent-one', identifier('EVT')]]) {
    await tickRun('.', { clientId, requestId: identifier('REQ') }, {
      runContext: () => ({
        events: [takeoverStart, takeoverAuthor],
        ownership: { ownerToken, ownerClientId: clientId, status: 'ACTIVE' },
        fold: ledger.foldRun([takeoverStart, takeoverAuthor]),
        owner: clientId, project: { key: 'demo' }, layout: { root: '.' }
      }),
      acquireLease: () => ({ id: 'lease' }), releaseLease: () => {},
      verifyArtifact: (input) => { rootsByOwner.push(input.rootRequestId); return { fold: { status: 'passed' } }; },
      recordEvent: () => {}
    });
  }
  assert.strictEqual(new Set(rootsByOwner).size, 3, `epoch·실행자가 다르면 검증 저널 root도 달라야 합니다: ${JSON.stringify(rootsByOwner)}`);
  for (const root of rootsByOwner) assert.match(root, /^REQ-[A-F0-9]{20}$/u);

  // 검증 대상 산출물이 없으면 실행하지 않고 환경 오류로 멈춘다.
  const emptyStart = startEvent(verifyProcedure);
  const empty = await tickRun('.', { clientId: 'agent-one', requestId: identifier('REQ') }, {
    runContext: () => context([emptyStart, progress(emptyStart, { type: 'run.step', stepId: 'author', executor: 'cli', exitCode: 0, artifactIds: [] })]),
    acquireLease: () => ({ id: 'lease' }), releaseLease: () => {},
    verifyArtifact: () => { throw new Error('대상 없이 검증을 실행하면 안 됩니다.'); },
    recordEvent: () => { throw new Error('대상 없이 기록하면 안 됩니다.'); }
  });
  assert.strictEqual(empty.code, 'verification-target-missing');

  const ledgerWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-drive-ledger-'));
  const ledgerRuntimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-drive-ledger-runtime-'));
  const previousRuntimeHome = process.env.RUNDOL_HOME;
  process.env.RUNDOL_HOME = ledgerRuntimeHome;
  try {
    const repository = path.resolve(__dirname, '..');
    const cli = path.join(repository, 'bin', 'rdl.js');
    const command = (program, args, cwd) => {
      const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: { ...process.env, RUNDOL_HOME: ledgerRuntimeHome } });
      assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result.stdout.trim();
    };
    command('git', ['init', '-b', 'main'], ledgerWorkspace);
    command('git', ['config', 'user.name', 'Drive Ledger Test'], ledgerWorkspace);
    command('git', ['config', 'user.email', 'drive-ledger@example.invalid'], ledgerWorkspace);
    fs.writeFileSync(path.join(ledgerWorkspace, 'README.md'), '# fixture\n', 'utf8');
    command('git', ['add', 'README.md'], ledgerWorkspace);
    command('git', ['commit', '-m', 'initial'], ledgerWorkspace);
    const rdl = (args) => JSON.parse(command(process.execPath, [cli].concat(args, ['--root', ledgerWorkspace, '--json']), repository));
    rdl(['init', 'crm', '--name', 'CRM', '--defaults']);
    rdl(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);
    const projectRoot = path.join(ledgerWorkspace, 'projects', 'crm');
    fs.writeFileSync(path.join(projectRoot, 'procedures.json'), `${JSON.stringify({ schemaVersion: 1, procedures: {
      'gate.fail': { revision: 1, idempotent: true, steps: [
        { id: 'gate', gate: { command: 'check', args: ['{artifact}', '--strict'] }, onFail: { goto: 'gate', maxAttempts: 1 } },
        { id: 'sync', human: true }
      ] }
    } }, null, 2)}\n`, 'utf8');
    command('git', ['add', 'procedures.json'], projectRoot);
    command('git', ['commit', '-m', 'add gate fixture'], projectRoot);
    const started = rdl(['run', 'start', 'gate.fail', '--project', 'crm', '--client-id', 'agent-a']);
    const driveRootRequestId = 'REQ-DDDDDDDDDDDDDDDDDDDD';
    const canonicalContext = runContext(ledgerWorkspace, { project: 'crm', run: started.runId });
    const gateResult = await tickRun(ledgerWorkspace, { project: 'crm', run: started.runId, clientId: 'agent-a', requestId: driveRootRequestId }, {
      runContext: () => ({ ...canonicalContext, fold: { ...canonicalContext.fold, artifactIds: ['REQ-001'] } }),
      executeGate: () => ({ exitCode: 1, diagnosticCodes: ['RDL-TEST-GATE'] })
    });
    assert.strictEqual(gateResult.reason, 'gate-failed');
    const recorded = ledger.readRunEvents(ledger.runDirectory(projectRoot, started.runId)).filter((event) => event.rootRequestId === driveRootRequestId);
    assert.deepStrictEqual(recorded.map((event) => event.type), ['run.gate', 'run.halted']);
    const driveJournal = requestJournal.loadJournal(runtimeWorkspace(ledgerWorkspace), driveRootRequestId).journal;
    assert.strictEqual(Object.keys(driveJournal.children).length, 2, 'gate verdict and halt share one drive request root');
    assert(Object.values(driveJournal.children).every((child) => child.phase === 'complete'));
  } finally {
    if (previousRuntimeHome === undefined) delete process.env.RUNDOL_HOME;
    else process.env.RUNDOL_HOME = previousRuntimeHome;
    fs.rmSync(ledgerWorkspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(ledgerRuntimeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  process.stdout.write('drive tests passed\n');
})();

module.exports = running;
