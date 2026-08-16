'use strict';

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
      renewLease: () => { heartbeatOrder.push('renew'); throw new Error('renew failed'); },
      syncLease: () => { heartbeatOrder.push('sync'); }, releaseLease: () => { heartbeatOrder.push('release'); },
      executeAdapter: async ({ signal }) => {
        const source = "const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));if(process.platform!=='win32')process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);";
        const execution = await executeOnce(process.execPath, ['-e', source, descendantFile], { cwd: heartbeatDirectory, env: process.env, timeoutSeconds: 10, signal });
        return { exitCode: execution.category === 'success' ? 0 : 2, artifactIds: [] };
      },
      recordEvent: (_context, event) => { adapterRecords.push(event); adapterEvents.push(progress(adapterEvents[0], event)); }
    });
    assert.strictEqual(heartbeatLost.reason, 'lease-lost');
    assert.deepStrictEqual(heartbeatOrder, ['renew', 'release'], 'renewal failure aborts before sync and releases the lease');
    assert.strictEqual(adapterRecords.some((event) => event.type === 'run.step'), false, 'an aborted adapter cannot append an outcome');
    assert.strictEqual(adapterRecords.at(-1).type, 'run.halted');
    const heartbeatDescendantPid = Number(fs.readFileSync(descendantFile, 'utf8'));
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
      renewLease: () => { cliHeartbeatOrder.push('renew'); throw new Error('renew failed'); },
      syncLease: () => { cliHeartbeatOrder.push('sync'); }, releaseLease: () => { cliHeartbeatOrder.push('release'); },
      driveCliEntry: cliEntry, cliTimeoutSeconds: 10,
      recordEvent: (_context, event) => { cliRecords.push(event); cliEvents.push(progress(cliEvents[0], event)); }
    });
    assert.strictEqual(cliLost.reason, 'lease-lost');
    assert.deepStrictEqual(cliHeartbeatOrder, ['renew', 'release']);
    assert.strictEqual(cliRecords.some((event) => event.type === 'run.step'), false, 'an aborted CLI cannot append an outcome');
    assert.strictEqual(cliRecords.at(-1).type, 'run.halted');
    const cliDescendantPid = Number(fs.readFileSync(cliDescendantFile, 'utf8'));
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
    rdl(['init', 'crm', '--name', 'CRM']);
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
