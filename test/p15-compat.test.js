'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { verdictEnvelope } = require('../src/verify');
const ledger = require('../src/run-ledger');
const eventStore = require('../src/event-store');
const { appendDriverEvent } = require('../src/driver-lease');

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
  // 판정이 지목한 리비전은 이 저장소에서 풀려야 한다. 아무 sha나 쓰면 이 픽스처는
  // "깨끗한 판정"이 아니라 "확인할 수 없는 판정"이 되고, 그것은 RDL-VERDICT-015가
  // 잡는 상태다 — 뒤에서 무진단을 주장할 수 없다.
  const projectHead = command('git', ['rev-parse', 'HEAD'], path.join(temporary, 'projects', 'crm'));
  const valid = verdictEnvelope(event({ reviewedRevision: projectHead })).shared;
  fs.writeFileSync(path.join(verdictRoot, 'verdict-crm-agent-a-000001.jsonl'), `${JSON.stringify(valid)}\n`, 'utf8');

  // 신형 v2 run 원장과 driver lease 샤드 — 0.29 클라이언트가 쓰고 pull로 들어온
  // 상황의 재현이다. 프로덕션 공유 기록과 같은 구성요소(createEventEnvelope →
  // appendEvent, appendDriverEvent)로 만들어 바이트가 동일하다. 0.28.1 check는
  // run 샤드를 구조만 검사하고 driver 디렉터리는 건너뛰므로 어느 쪽도 오진이 없어야 한다.
  const eventsRoot = path.join(temporary, 'projects', 'workspace', 'events');
  const lockDirectory = path.join(temporary, '.compat-locks');
  const contentHash = 'c'.repeat(64);
  const runId = 'RUN-00000000000000000C01';
  const ownerToken = 'EVT-00000000000000000C11';
  const resolvedProcedure = {
    name: 'compat-author', revision: 1, schemaVersion: 1,
    steps: [{ id: 'author', executor: 'adapter' }, { id: 'mech-gate', gate: { command: 'check', args: [] } }, { id: 'save', executor: 'cli' }]
  };
  const runBase = { schemaVersion: 2, rootRequestId: 'REQ-00000000000000000C01', clientId: 'agent-a', projectId: 'crm', runId };
  const runEvents = [
    { ...runBase, eventId: ownerToken, requestId: 'REQ-00000000000000000C11', type: 'run.started', ownerToken, goal: '호환성 픽스처',
      procedure: { name: 'compat-author', revision: 1, schemaVersion: 1, contentHash, resolved: resolvedProcedure },
      settings: { schemaVersion: 1, contentHash, safeResolved: {} } },
    { ...runBase, eventId: 'EVT-00000000000000000C12', requestId: 'REQ-00000000000000000C12', type: 'run.step', ownerToken, stepId: 'author', executor: 'adapter', exitCode: 0, artifactIds: [] },
    { ...runBase, eventId: 'EVT-00000000000000000C13', requestId: 'REQ-00000000000000000C13', type: 'run.gate', ownerToken, stepId: 'mech-gate', command: 'check', args: [], exitCode: 0, diagnostics: [], attempt: 1 },
    { ...runBase, eventId: 'EVT-00000000000000000C14', requestId: 'REQ-00000000000000000C14', type: 'run.step', ownerToken, stepId: 'save', executor: 'cli', exitCode: 0, artifactIds: [] },
    { ...runBase, eventId: 'EVT-00000000000000000C15', requestId: 'REQ-00000000000000000C15', type: 'run.completed_local', ownerToken, commit: 'a'.repeat(40), artifactIds: [] }
  ];
  for (const runEvent of runEvents) {
    eventStore.appendEvent(eventsRoot, 'run', 'crm', runEvent.clientId, ledger.createEventEnvelope(runEvent).shared, { runId, lockDirectory });
  }
  const driverBase = { schemaVersion: 1, rootRequestId: 'REQ-00000000000000000C02', requestId: 'REQ-00000000000000000C21', clientId: 'agent-a', projectId: 'crm', runId, leaseId: 'LEASE-00000000000000000C01', ownerToken };
  appendDriverEvent(eventsRoot, { ...driverBase, eventId: 'EVT-00000000000000000C21', type: 'driver.acquired', expiresAt: '2030-01-01T00:00:00.000Z' }, { lockDirectory });
  appendDriverEvent(eventsRoot, { ...driverBase, requestId: 'REQ-00000000000000000C22', eventId: 'EVT-00000000000000000C22', type: 'driver.released', previousDriverEventId: 'EVT-00000000000000000C21', reason: 'completed' }, { lockDirectory });

  const clean = currentCheck();
  assert.strictEqual(clean.status, 0, clean.stdout + clean.stderr);
  assert(!clean.stdout.includes('RDL-VERDICT-'), clean.stdout);
  assert(!clean.stdout.includes('RDL-RUN-'), clean.stdout);
  assert(!clean.stdout.includes('RDL-DRIVER-'), clean.stdout);

  // 0.28.1은 verdict·driver kind와 run v2 스키마 이전이다. check/sync가 새 kind
  // 디렉터리를 무시하고 run 샤드는 오진 없이 지나가야 한다.
  const baseline = command('git', ['rev-parse', '8d1c6df^{commit}'], root);
  oldTree = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-0281-'));
  fs.rmSync(oldTree, { recursive: true, force: true });
  command('git', ['worktree', 'add', '--detach', oldTree, baseline], root);
  const oldCli = path.join(oldTree, 'bin', 'rdl.js');
  //
  // 0.25가 더한 문서 유형(IFC, STD)과 걷어낸 옛 유형(API)은 이전 판이 알 수 없다.
  // 이건 오진이 아니라 선언된 계약 파기이므로, 종료코드를 0으로 묶는 대신 "그 파기
  // 말고 다른 오류가 없는지"를 본다. 파기가 넓어지면 이 단언이 깨진다.
  const oldCheck = invoke(process.execPath, [oldCli, 'check', '--root', temporary, '--json'], root);
  assert(oldCheck.stdout.trim().startsWith('{'), `0.28.1 check produced no result:\n${oldCheck.stdout}\n${oldCheck.stderr}`);
  const oldErrors = (JSON.parse(oldCheck.stdout).diagnostics || []).filter((item) => item.severity === 'error');
  const undeclared = oldErrors.filter((item) => item.code !== 'RDL-PROFILE-001');
  assert.deepStrictEqual(undeclared, [], `0.28.1 check raised undeclared errors:\n${JSON.stringify(undeclared, null, 2)}`);
  assert(!oldCheck.stdout.includes('RDL-LEASE-001'), oldCheck.stdout);
  assert(!oldCheck.stdout.includes('RDL-RUN-'), oldCheck.stdout);
  const oldSync = invoke(process.execPath, [oldCli, 'sync', '--root', temporary, '--project', 'crm', '--no-push', '--json'], root);
  const oldSyncOutput = `${oldSync.stdout}\n${oldSync.stderr}`;
  // sync가 멈춘 이유도 같은 파기여야 한다. run·lease·driver 때문에 멈춘 것이면 오진이다.
  if (oldSync.status !== 0) assert(oldSyncOutput.includes('RDL-PROFILE-001'), `0.28.1 sync failed for an undeclared reason:\n${oldSyncOutput}`);
  assert(!/RDL-(RUN|LEASE|DRIVER|VERDICT)-/u.test(oldSyncOutput), `0.28.1 sync misread the new shards:\n${oldSyncOutput}`);
  command('git', ['worktree', 'remove', '--force', oldTree], root);
  oldTree = null;

  // ── 혼합 판 경계 ────────────────────────────────────────────────────────
  //
  // 0.31.0은 run.step.commit·run.forced.basis·run.resumed.grantedAttempts를 더하며
  // 스키마를 v3으로 올렸다. 이 경계를 주장이 아니라 실제 판독기로 증명한다 —
  // 배포된 v0.30.2를 꺼내 v3 원장을 읽히고, 조용히 흘려 버리지 않는지 본다.
  //
  // 조용히 흘려 버리면 같은 원장이 판에 따라 다른 사실을 말한다: 승인이 없는 런,
  // 커밋을 모르는 저장. 그래서 옳은 행동은 "모르는 판은 읽지 못한다"이지
  // "모르는 필드는 무시한다"가 아니다.
  const v3RunId = 'RUN-00000000000000000D01';
  const v3Owner = 'EVT-00000000000000000D11';
  const v3Base = { schemaVersion: 3, rootRequestId: 'REQ-00000000000000000D01', clientId: 'agent-a', projectId: 'crm', runId: v3RunId };
  for (const runEvent of [
    { ...v3Base, eventId: v3Owner, requestId: 'REQ-00000000000000000D11', type: 'run.started', ownerToken: v3Owner, goal: 'v3 픽스처',
      procedure: { name: 'compat-author', revision: 1, schemaVersion: 1, contentHash, resolved: resolvedProcedure },
      settings: { schemaVersion: 1, contentHash, safeResolved: {} } },
    { ...v3Base, eventId: 'EVT-00000000000000000D12', requestId: 'REQ-00000000000000000D12', type: 'run.step', ownerToken: v3Owner, stepId: 'save', executor: 'cli', exitCode: 0, artifactIds: [], commit: 'd'.repeat(40) }
  ]) {
    eventStore.appendEvent(eventsRoot, 'run', 'crm', runEvent.clientId, ledger.createEventEnvelope(runEvent).shared, { runId: v3RunId, lockDirectory });
  }

  // 이 판은 v3을 읽는다.
  const v3Current = currentCheck();
  assert(!v3Current.stdout.includes('RDL-RUN-017'), `현재 판이 자기 스키마를 거부했습니다: ${v3Current.stdout}`);

  // 배포된 0.30.2는 이 런을 읽지 못한다고 말해야 한다.
  //
  // 물어야 할 곳은 check가 아니라 fold다. 0.30.2의 check는 run 이벤트의 스키마를
  // 검사하지 않으므로 조용하지만, 조용한 것 자체는 해가 아니다. 해는 "다른 사실을
  // 말하는 것"이고, 사실을 만드는 것은 fold다. 그래서 fold에 직접 묻는다.
  const deployed = command('git', ['rev-parse', 'v0.30.2^{commit}'], root);
  oldTree = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-0302-'));
  fs.rmSync(oldTree, { recursive: true, force: true });
  command('git', ['worktree', 'add', '--detach', oldTree, deployed], root);
  const deployedLedger = require(path.join(oldTree, 'src', 'run-ledger.js'));
  const v3Events = ledger.readSharedRunEvents(require('../src/workspace').workspaceLayout(temporary), 'crm', v3RunId);
  assert(v3Events.length >= 2, `v3 픽스처를 읽지 못했습니다: ${v3Events.length}`);
  const deployedFold = deployedLedger.foldSharedRun(v3Events);
  assert.strictEqual(deployedFold.status, 'missing',
    `배포된 0.30.2가 v3 런을 읽어 냈습니다. 같은 원장이 판에 따라 다른 사실을 말합니다: ${JSON.stringify(deployedFold.status)}`);
  assert((deployedFold.diagnostics || []).some((item) => item.code === 'RDL-RUN-021'),
    `읽지 못한 이유가 기록되지 않았습니다: ${JSON.stringify(deployedFold.diagnostics)}`);
  command('git', ['worktree', 'remove', '--force', oldTree], root);
  oldTree = null;

  // 거꾸로도 막힌다. v3 필드를 단 v2 이벤트는 알 수 없는 필드로 거부된다 —
  // 판만 낮춰 새 사실을 옛 이벤트에 실어 넣는 길이 없어야 한다.
  assert.throws(() => ledger.createEventEnvelope({ ...runBase, schemaVersion: 2, eventId: 'EVT-00000000000000000D21', requestId: 'REQ-00000000000000000D21', type: 'run.step', ownerToken, stepId: 'save', executor: 'cli', exitCode: 0, artifactIds: [], commit: 'e'.repeat(40) }),
    /unknown fields: commit/u);

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
