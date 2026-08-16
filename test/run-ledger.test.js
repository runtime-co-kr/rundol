'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const ledger = require(path.join(root, 'src', 'run-ledger.js'));
const requestJournal = require(path.join(root, 'src', 'request-journal.js'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-run-ledger-'));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

const procedure = {
  name: 'document.author-verified',
  revision: 1,
  schemaVersion: 1,
  steps: [
    { id: 'author' },
    { id: 'mech-gate', gate: { command: 'check', args: ['--strict'] }, onFail: { goto: 'author', maxAttempts: 2 } },
    { id: 'save' }
  ]
};

try {
  // Canonical v2 records stay flat, digest exactly 32 bytes, and localDetail never enters shared projection.
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  const digestC = 'c'.repeat(64);
  const canonicalProcedure = {
    name: procedure.name,
    revision: 1,
    schemaVersion: 1,
    contentHash: digestA,
    resolved: procedure
  };
  function canonicalEvent(overrides) {
    return Object.assign({
      schemaVersion: 2,
      eventId: 'EVT-00000000000000000001',
      type: 'run.started',
      rootRequestId: 'REQ-00000000000000000001',
      requestId: 'REQ-00000000000000000002',
      clientId: 'laptop-a',
      projectId: 'crm',
      runId: 'RUN-00000000000000000001',
      ownerToken: 'EVT-00000000000000000001',
      goal: ' canonical\r\ngoal ',
      procedure: canonicalProcedure,
      settings: { schemaVersion: 1, contentHash: digestB, safeResolved: {} },
      occurredAt: '2099-01-01T00:00:00.000Z',
      localDetail: { machine: 'secret' }
    }, overrides);
  }
  const envelope = ledger.createEventEnvelope(canonicalEvent());
  assert.strictEqual(envelope.canonicalDigest.length, 64);
  assert.strictEqual(envelope.shared.localDetail, undefined);
  assert.deepStrictEqual(envelope.local.localDetail, { machine: 'secret' });
  assert.strictEqual(envelope.shared.goal, 'canonical\ngoal');
  assert(!Object.prototype.hasOwnProperty.call(envelope.shared, 'canonical'));
  assert.throws(() => ledger.createEventEnvelope(Object.assign({}, envelope.local, { goal: 'tampered' })), /canonicalDigest mismatch/u);

  const canonicalDirectory = path.join(temporary, 'canonical-run');
  ledger.appendRunEvent(canonicalDirectory, envelope.local);
  ledger.appendRunEvent(canonicalDirectory, Object.assign({}, envelope.shared, { occurredAt: '2000-01-01T00:00:00.000Z' }));
  assert.strictEqual(ledger.readRunEvents(canonicalDirectory).length, 1);
  const conflictingStarted = canonicalEvent({ goal: 'different', localDetail: undefined });
  assert.throws(() => ledger.appendRunEvent(canonicalDirectory, conflictingStarted), /eventId corruption/u);
  const projectionDirectory = path.join(temporary, 'projection-run');
  ledger.appendRunEvent(projectionDirectory, envelope.shared);
  ledger.appendRunEvent(projectionDirectory, envelope.local);
  const projectedUnion = ledger.unionRunEvents([envelope.local], [envelope.shared]);
  assert.strictEqual(projectedUnion.length, 1);
  assert.deepStrictEqual(projectedUnion[0].localDetail, { machine: 'secret' });

  // Request roots/children replay exact canonical UTF-8 bytes and reject a changed semantic child.
  const journalRuntime = { pending: path.join(temporary, 'pending') };
  const journalRootId = 'REQ-10000000000000000001';
  const journalChildKey = 'event:run.started:RUN-00000000000000000001';
  const journalRequestId = requestJournal.childRequestId(journalRootId, journalChildKey);
  const journalEventId = requestJournal.eventIdForRequest(journalRequestId);
  const journalRoot = requestJournal.prepareRoot(journalRuntime, { rootRequestId: journalRootId, commandDigest: digestC, clientId: 'laptop-a' });
  const childBytes = Buffer.from(ledger.canonicalJson({ eventId: journalEventId, requestId: journalRequestId, rootRequestId: journalRootId, schemaVersion: 2 }), 'utf8');
  const child = requestJournal.prepareChild(journalRoot, { childKey: journalChildKey, canonicalBytes: childBytes });
  assert.strictEqual(requestJournal.decodeChild(child, journalRoot.journal.rootRequestId).equals(childBytes), true);
  assert.strictEqual(requestJournal.prepareChild(journalRoot, { childKey: child.childKey, canonicalBytes: childBytes }).eventId, child.eventId);
  assert.throws(() => requestJournal.prepareChild(journalRoot, { childKey: child.childKey, canonicalBytes: Buffer.from('{}') }), /child mismatch/u);
  requestJournal.updateChild(journalRoot, child.childKey, 'canonical-committed');
  requestJournal.updateChild(journalRoot, child.childKey, 'complete');
  assert.strictEqual(requestJournal.loadJournal(journalRuntime, journalRoot.journal.rootRequestId).journal.phase, 'complete');
  const secondChildKey = 'event:run.step:RUN-00000000000000000001';
  const secondRequestId = requestJournal.childRequestId(journalRootId, secondChildKey);
  const secondEventId = requestJournal.eventIdForRequest(secondRequestId);
  const secondBytes = Buffer.from(ledger.canonicalJson({ eventId: secondEventId, requestId: secondRequestId, rootRequestId: journalRootId, schemaVersion: 2 }), 'utf8');
  requestJournal.prepareChild(journalRoot, { childKey: secondChildKey, canonicalBytes: secondBytes });
  const reopened = requestJournal.loadJournal(journalRuntime, journalRoot.journal.rootRequestId).journal;
  assert.strictEqual(reopened.phase, 'pending', 'a newly prepared child must reopen a completed root for recovery');
  assert.strictEqual(reopened.children[secondChildKey].phase, 'prepared');

  // Causal owner tokens support A -> B -> A, fence stale writes, and ignore timestamps.
  let sequence = 10;
  function id(prefix) { sequence += 1; return `${prefix}-${String(sequence).padStart(20, '0')}`; }
  function v2(type, clientId, ownerToken, fields) {
    const eventId = id('EVT');
    const event = Object.assign({ schemaVersion: 2, eventId, type, rootRequestId: id('REQ'), requestId: id('REQ'), clientId, projectId: 'crm', runId: 'RUN-00000000000000000002' }, fields);
    if (ownerToken !== undefined) event.ownerToken = ownerToken;
    return ledger.createEventEnvelope(event).shared;
  }
  const aStartId = id('EVT');
  const aStart = ledger.createEventEnvelope(canonicalEvent({ eventId: aStartId, ownerToken: aStartId, rootRequestId: id('REQ'), requestId: id('REQ'), runId: 'RUN-00000000000000000002', goal: undefined, localDetail: undefined })).shared;
  const aStep = v2('run.step', 'laptop-a', aStartId, { stepId: 'author', executor: 'adapter', exitCode: 0, artifactIds: [] });
  const bTakeoverId = id('EVT');
  const bTakeover = ledger.createEventEnvelope({ schemaVersion: 2, eventId: bTakeoverId, type: 'run.takeover', rootRequestId: id('REQ'), requestId: id('REQ'), clientId: 'desk-b', projectId: 'crm', runId: aStart.runId, ownerToken: bTakeoverId, previousClientId: 'laptop-a', previousOwnerToken: aStartId, previousOwnerHeadEventId: aStep.eventId, basis: 'forced', reason: 'machine unavailable' }).shared;
  const staleA = v2('run.gate', 'laptop-a', aStartId, { stepId: 'mech-gate', command: 'check', args: ['--strict'], exitCode: 1, diagnostics: ['RDL-X-001'], attempt: 1 });
  const bForced = v2('run.forced', 'desk-b', bTakeoverId, { stepId: 'mech-gate', reason: 'reviewed bypass' });
  const aReturnId = id('EVT');
  const aReturn = ledger.createEventEnvelope({ schemaVersion: 2, eventId: aReturnId, type: 'run.takeover', rootRequestId: id('REQ'), requestId: id('REQ'), clientId: 'laptop-a', projectId: 'crm', runId: aStart.runId, ownerToken: aReturnId, previousClientId: 'desk-b', previousOwnerToken: bTakeoverId, previousOwnerHeadEventId: bForced.eventId, basis: 'forced', reason: 'machine restored' }).shared;
  const aSave = v2('run.step', 'laptop-a', aReturnId, { stepId: 'save', executor: 'cli', exitCode: 0, artifactIds: ['REQ-001'] });
  const ownershipEvents = [aStart, aStep, staleA, bTakeover, bForced, aReturn, aSave];
  const causal = ledger.foldSharedRun(ownershipEvents);
  assert.strictEqual(causal.ownerToken, aReturnId);
  assert.strictEqual(causal.cursor, null);
  assert.deepStrictEqual(causal.attempts, {});
  assert(causal.staleEventIds.includes(staleA.eventId));
  const partitionReordered = [bTakeover, bForced, aStart, aStep, staleA, aReturn, aSave];
  assert.deepStrictEqual(
    { ownerToken: ledger.foldSharedRun(partitionReordered).ownerToken, cursor: ledger.foldSharedRun(partitionReordered).cursor, attempts: ledger.foldSharedRun(partitionReordered).attempts },
    { ownerToken: causal.ownerToken, cursor: causal.cursor, attempts: causal.attempts }
  );

  // Concurrent takeover children fail closed until a complete reasoned resolution selects one decision tuple.
  const conflictStartId = id('EVT');
  const conflictStart = ledger.createEventEnvelope(canonicalEvent({ eventId: conflictStartId, ownerToken: conflictStartId, rootRequestId: id('REQ'), requestId: id('REQ'), runId: 'RUN-00000000000000000003', goal: undefined, localDetail: undefined })).shared;
  const bDecisionId = id('EVT');
  const bDecision = ledger.createEventEnvelope({ schemaVersion: 2, eventId: bDecisionId, type: 'run.takeover', rootRequestId: id('REQ'), requestId: id('REQ'), clientId: 'desk-b', projectId: 'crm', runId: conflictStart.runId, ownerToken: bDecisionId, previousClientId: 'laptop-a', previousOwnerToken: conflictStartId, previousOwnerHeadEventId: conflictStartId, basis: 'forced', reason: 'partition b' }).shared;
  const cDecisionId = id('EVT');
  const cDecision = ledger.createEventEnvelope({ schemaVersion: 2, eventId: cDecisionId, type: 'run.takeover', rootRequestId: id('REQ'), requestId: id('REQ'), clientId: 'desk-c', projectId: 'crm', runId: conflictStart.runId, ownerToken: cDecisionId, previousClientId: 'laptop-a', previousOwnerToken: conflictStartId, previousOwnerHeadEventId: conflictStartId, basis: 'forced', reason: 'partition c' }).shared;
  const conflicted = ledger.ownershipState([conflictStart, bDecision, cDecision]);
  assert.strictEqual(conflicted.status, 'CONFLICT');
  assert.strictEqual(conflicted.parentClient, 'laptop-a');
  assert.strictEqual(conflicted.candidates.length, 2);
  const resolutionId = id('EVT');
  const resolution = ledger.createEventEnvelope({ schemaVersion: 2, eventId: resolutionId, type: 'run.ownership_resolved', rootRequestId: id('REQ'), requestId: id('REQ'), clientId: 'laptop-a', projectId: 'crm', runId: conflictStart.runId, conflictId: conflicted.conflictId, candidates: conflicted.candidates, selectedDecisionEventId: bDecisionId, selectedOwnerToken: bDecisionId, resolverMemberId: 'MEMBER-001', reason: 'select intact branch', forced: false }).shared;
  const resolved = ledger.ownershipState([cDecision, resolution, conflictStart, bDecision]);
  assert.strictEqual(resolved.status, 'ACTIVE');
  assert.strictEqual(resolved.token, bDecisionId);

  // 절차 검증: goto는 앞선 스텝만, revision·스텝 형식 강제.
  assert.throws(() => ledger.validateProcedure({ name: 'x', revision: 1, steps: [{ id: 'a', onFail: { goto: 'b', maxAttempts: 1 } }, { id: 'b' }] }), /앞선 스텝만/u);
  assert.throws(() => ledger.validateProcedure(Object.assign({}, procedure, { revision: 0 })), /revision/u);

  // 단독 원장 시나리오 fold (workspace 불필요 — 순수 로컬).
  const unit = path.join(temporary, 'unit-run');
  const started = ledger.appendRunEvent(unit, {
    type: 'run.started', runId: 'RUN-0123456789ABCDEF0123', projectId: 'crm', clientId: 'laptop-a', goal: '테스트',
    procedure: { name: procedure.name, revision: 1, schemaVersion: 1, contentHash: 'x', resolved: procedure }
  });
  assert(started.event.eventId.startsWith('EVT-'));

  ledger.appendRunEvent(unit, { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'laptop-a' });
  let fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.cursor, 'mech-gate');
  assert.deepStrictEqual(fold.completedSteps, ['author']);

  // 게이트 실패 → goto로 author 재작업, attempts는 fold가 계산.
  ledger.appendRunEvent(unit, { type: 'run.gate', stepId: 'mech-gate', exitCode: 1, diagnostics: ['RDL-DOC-004'], clientId: 'laptop-a' });
  fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.cursor, 'author');
  assert.strictEqual(fold.attempts['mech-gate'], 1);
  assert.deepStrictEqual(fold.lastGate.diagnostics, ['RDL-DOC-004']);

  // 상한 도달: halted 이벤트 없이도 fold가 attempt-limit을 강제.
  ledger.appendRunEvent(unit, { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'laptop-a' });
  ledger.appendRunEvent(unit, { type: 'run.gate', stepId: 'mech-gate', exitCode: 1, diagnostics: [], clientId: 'laptop-a' });
  fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.status, 'halted');
  assert.strictEqual(fold.haltReason, 'attempt-limit');

  // 크래시 절단: 불완전한 꼬리는 읽기에서 무시되고, 다음 append가 결정적으로 복구한다.
  const file = path.join(unit, 'events.jsonl');
  const beforeCrash = ledger.foldRun(ledger.readRunEvents(unit));
  fs.appendFileSync(file, '{"type":"run.gate","exitCo', 'utf8');
  assert.deepStrictEqual(ledger.foldRun(ledger.readRunEvents(unit)), beforeCrash);
  ledger.appendRunEvent(unit, { type: 'run.resumed', fromStep: 'author', clientId: 'laptop-a' });
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean)) JSON.parse(line);

  // 재개는 시도 예산을 되살린다. 이후 통과한 스텝의 과거 실패는 소급되지 않는다.
  fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.status, 'running');
  assert.strictEqual(fold.cursor, 'author');
  ledger.appendRunEvent(unit, { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'laptop-a' });
  ledger.appendRunEvent(unit, { type: 'run.gate', stepId: 'mech-gate', exitCode: 0, diagnostics: [], clientId: 'laptop-a' });
  ledger.appendRunEvent(unit, { type: 'run.step', stepId: 'save', executor: 'cli', exitCode: 0, clientId: 'laptop-a' });
  ledger.appendRunEvent(unit, { type: 'run.completed_local', commit: 'abc', clientId: 'laptop-a' });
  fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.status, 'completed_local');
  assert.strictEqual(fold.cursor, null);
  assert.deepStrictEqual(fold.completedSteps, ['author', 'mech-gate', 'save']);

  // fold 결정성: 같은 이벤트 열 → 같은 결과.
  const events = ledger.readRunEvents(unit);
  assert.deepStrictEqual(ledger.foldRun(events), ledger.foldRun(events));

  // 중간 줄 손상은 관용 대상이 아니라 원장 파손이다.
  const corrupt = path.join(temporary, 'corrupt-run');
  ledger.appendRunEvent(corrupt, { type: 'run.started', runId: 'RUN-0123456789ABCDEF0124', projectId: 'crm', clientId: 'laptop-a', procedure: { name: 'x.y', revision: 1, contentHash: 'x', resolved: { name: 'x.y', revision: 1, steps: [{ id: 'a' }] } } });
  const corruptFile = path.join(corrupt, 'events.jsonl');
  fs.appendFileSync(corruptFile, '{"broken\n', 'utf8');
  ledger.appendRunEvent(corrupt, { type: 'run.step', stepId: 'a', exitCode: 0, clientId: 'laptop-a' });
  assert.throws(() => ledger.readRunEvents(corrupt), /파싱할 수 없습니다/u);

  // 실제 workspace: 공유 미러, 커서 재현성, 시계 무관 소유권 사슬, 인수 규칙.
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  JSON.parse(command(process.execPath, [cli, 'init', 'crm', '--name', '고객 관리', '--root', temporary, '--json'], root));
  JSON.parse(command(process.execPath, [cli, 'client', 'register', 'laptop-a', '--name', '업무 노트북', '--type', 'device', '--owner', 'MEMBER-001', '--root', temporary, '--json'], root));
  JSON.parse(command(process.execPath, [cli, 'client', 'register', 'desk-b', '--name', '데스크톱', '--type', 'device', '--owner', 'MEMBER-001', '--root', temporary, '--json'], root));

  // 공유 원장에 쓰는 주체는 등록된 client여야 한다.
  assert.throws(() => ledger.createRun(temporary, { project: 'crm', clientId: 'ghost', procedure }), /등록되지 않은 Client/u);

  const created = ledger.createRun(temporary, { project: 'crm', goal: '결제 REQ', clientId: 'laptop-a', procedure });
  assert(ledger.RUN_ID.test(created.runId));
  assert(created.directory.startsWith(path.join(temporary, 'projects', 'crm', '.rundol', 'runs')));
  const runFold = ledger.foldRun(ledger.readRunEvents(created.directory));
  assert.strictEqual(runFold.status, 'running');
  assert.strictEqual(runFold.cursor, 'author');
  assert.strictEqual(runFold.procedure.name, 'document.author-verified');
  assert.strictEqual(ledger.listRuns(path.join(temporary, 'projects', 'crm')).length, 1);
  const projectStatus = command('git', ['status', '--short'], path.join(temporary, 'projects', 'crm'));
  assert(!projectStatus.includes('.rundol'));

  // 공유 미러: events/run/ 서브디렉터리의 client+run 샤드.
  const sharedShard = path.join(temporary, 'projects', 'workspace', 'events', 'run', `run-crm-laptop-a-${created.runId}-000001.jsonl`);
  assert(fs.existsSync(sharedShard));

  // 커서 재현성 (AC-P0c ①): 로컬 원장 없이 공유 이벤트만 fold해도 소유자와 동일.
  const { workspaceLayout } = require(path.join(root, 'src', 'workspace.js'));
  ledger.recordRunEvent(temporary, { project: 'crm', runId: created.runId, event: { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'laptop-a' } });
  ledger.recordRunEvent(temporary, { project: 'crm', runId: created.runId, event: { type: 'run.gate', stepId: 'mech-gate', exitCode: 1, diagnostics: ['RDL-DOC-004'], clientId: 'laptop-a' } });
  const layout = workspaceLayout(temporary);
  const sharedFold = ledger.foldSharedRun(ledger.readSharedRunEvents(layout, 'crm', created.runId));
  const localFold = ledger.foldRun(ledger.readRunEvents(created.directory));
  assert.deepStrictEqual(
    { status: sharedFold.status, cursor: sharedFold.cursor, attempts: sharedFold.attempts, haltReason: sharedFold.haltReason },
    { status: localFold.status, cursor: localFold.cursor, attempts: localFold.attempts, haltReason: localFold.haltReason }
  );

  // 정지하지 않은 런의 자동 인수는 거부된다. 벽시계는 어디에도 개입하지 않는다.
  assert.throws(() => ledger.takeoverRun(temporary, { project: 'crm', runId: created.runId, clientId: 'desk-b' }), /자동으로 인수할 수 없습니다/u);

  // halted 후 자동 인수. 새 소유자의 이벤트가 25년 과거의 시계를 갖더라도 사슬 순서가 이긴다.
  ledger.recordRunEvent(temporary, { project: 'crm', runId: created.runId, event: { type: 'run.halted', reason: 'manual', atStep: 'author', resumable: true, clientId: 'laptop-a' } });
  const taken = ledger.takeoverRun(temporary, { project: 'crm', runId: created.runId, clientId: 'desk-b' });
  assert.strictEqual(taken.basis, 'halted');
  assert.strictEqual(taken.previousClientId, 'laptop-a');
  ledger.recordRunEvent(temporary, { project: 'crm', runId: created.runId, event: { type: 'run.resumed', fromStep: 'author', clientId: 'desk-b', occurredAt: '2000-01-01T00:00:00.000Z' } });
  ledger.recordRunEvent(temporary, { project: 'crm', runId: created.runId, event: { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'desk-b', occurredAt: '2000-01-01T00:00:01.000Z' } });
  const chained = ledger.foldSharedRun(ledger.readSharedRunEvents(layout, 'crm', created.runId));
  assert.strictEqual(chained.status, 'running');
  assert.strictEqual(chained.cursor, 'mech-gate');
  assert.throws(() => ledger.takeoverRun(temporary, { project: 'crm', runId: created.runId, clientId: 'desk-b' }), /이미 이 런의 소유자/u);

  // 정지 없는 런의 강제 인수는 사람의 결정이며 사유가 필수다.
  const second = ledger.createRun(temporary, { project: 'crm', goal: '두 번째', clientId: 'laptop-a', procedure });
  assert.throws(() => ledger.takeoverRun(temporary, { project: 'crm', runId: second.runId, clientId: 'desk-b', force: true }), /--reason/u);
  const forced = ledger.takeoverRun(temporary, { project: 'crm', runId: second.runId, clientId: 'desk-b', force: true, reason: '소유 머신 분실' });
  assert.strictEqual(forced.basis, 'forced');

  // 신버전 검사가 run 샤드를 이해한다: 정상 통과 + 위조 clientId는 RDL-RUN-003.
  const checkOutput = JSON.parse(command(process.execPath, [cli, 'check', '--root', temporary, '--json'], root));
  const runDiagnostics = JSON.stringify(checkOutput).match(/RDL-RUN-\d{3}/gu) || [];
  assert.strictEqual(runDiagnostics.length, 0, `예상 밖 run 진단: ${runDiagnostics.join(', ')}`);

  // 혼합 버전 실측 (AC-P0c ②): 구버전(0.24.0) check가 events/run/을 보고도 오진 0.
  const oldCommit = command('git', ['log', '--all', '--format=%H', '--grep=chore: release 0.24.0', '-1'], root);
  if (oldCommit) {
    const oldTree = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-old-'));
    command('git', ['worktree', 'add', '--detach', oldTree, oldCommit], root);
    try {
      const result = spawnSync(process.execPath, [path.join(oldTree, 'bin', 'rdl.js'), 'check', '--root', temporary, '--json'], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `구버전 check 실패:\n${result.stdout}\n${result.stderr}`);
      assert(!result.stdout.includes('RDL-LEASE-001'), `구버전이 run 샤드를 임대 파일로 오진:\n${result.stdout}`);
    } finally {
      command('git', ['worktree', 'remove', '--force', oldTree], root);
    }
  }

  process.stdout.write('run ledger tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
