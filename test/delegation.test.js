'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEFAULT_EXPIRY_DAYS,
  MAXIMUM_EXPIRY_DAYS,
  delegationIdFor,
  normalizeDelegationEvent,
  foldDelegations,
  listDelegations,
  grantDelegation,
  revokeDelegation,
  activeDelegationFor
} = require('../src/delegation');
const { requestDecision, listDecisions } = require('../src/decision');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-delegation-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

const GRANTED_AT = '2026-01-01T00:00:00.000Z';
const EXPIRES_AT = '2026-01-08T00:00:00.000Z';

function grantEvent(overrides) {
  const base = { kind: 'scope-change', projectId: 'crm', delegateClientId: 'agent-a', grantedBy: 'MEMBER-001', expiresAt: EXPIRES_AT };
  return Object.assign({
    schemaVersion: 1,
    eventId: 'EVT-11111111111111111111',
    type: 'delegation.granted',
    rootRequestId: 'REQ-11111111111111111111',
    requestId: 'REQ-22222222222222222222',
    clientId: 'desk-b',
    projectId: 'crm',
    delegationId: delegationIdFor(base),
    kind: 'scope-change',
    delegateClientId: 'agent-a',
    grantedBy: 'MEMBER-001',
    grantedAt: GRANTED_AT,
    expiresAt: EXPIRES_AT,
    reason: '이 프로젝트의 범위 확장은 에이전트가 판단한다'
  }, overrides || {});
}

try {
  // 위임 불가 티어가 없으면 카탈로그 전체가 위임 한 번으로 무력화된다.
  for (const kind of ['publish', 'pr-merge', 'force-takeover', 'delegation-grant']) {
    assert.throws(() => normalizeDelegationEvent(grantEvent({ kind })), /위임할 수 없는 결정/u, `${kind}는 위임 부여가 거부되어야 합니다.`);
  }
  assert.strictEqual(normalizeDelegationEvent(grantEvent()).kind, 'scope-change');

  // 만료는 선택이 아니라 성질이다. 상한을 넘는 위임은 부여 자체가 거부된다.
  assert.throws(() => normalizeDelegationEvent(grantEvent({ expiresAt: '2026-03-01T00:00:00.000Z' })), /30일을 넘을 수 없습니다/u);
  assert.throws(() => normalizeDelegationEvent(grantEvent({ expiresAt: GRANTED_AT })), /부여 시각보다 뒤여야/u);
  assert.strictEqual(MAXIMUM_EXPIRY_DAYS, 30);
  assert.strictEqual(DEFAULT_EXPIRY_DAYS, 7);

  // 만료는 벽시계가 아니라 fold의 입력이다.
  const active = foldDelegations([grantEvent()], { now: '2026-01-05T00:00:00.000Z' });
  assert.strictEqual(active.active.length, 1);
  assert.strictEqual(active.delegations[0].status, 'active');
  const expired = foldDelegations([grantEvent()], { now: '2026-02-01T00:00:00.000Z' });
  assert.strictEqual(expired.active.length, 0);
  assert.strictEqual(expired.delegations[0].status, 'expired');

  const revokeEvent = {
    schemaVersion: 1, eventId: 'EVT-33333333333333333333', type: 'delegation.revoked',
    rootRequestId: 'REQ-33333333333333333333', requestId: 'REQ-44444444444444444444',
    clientId: 'desk-b', projectId: 'crm', delegationId: grantEvent().delegationId, kind: 'scope-change',
    previousDelegationEventId: 'EVT-11111111111111111111', revokedBy: 'MEMBER-001', reason: '범위 판단을 다시 사람이 한다'
  };
  // 만료 판정 시각은 호출자가 준다 — fold 안에서 벽시계를 읽으면 같은 이벤트가
  // 언제 읽느냐에 따라 다른 결과를 낸다.
  assert.throws(() => foldDelegations([grantEvent()], {}), /현재 시각\(now\)이 필요/u);
  assert.throws(() => foldDelegations([grantEvent()]), /현재 시각\(now\)이 필요/u);

  const revoked = foldDelegations([grantEvent(), revokeEvent], { now: '2026-01-05T00:00:00.000Z' });
  assert.strictEqual(revoked.active.length, 0);
  assert.strictEqual(revoked.delegations[0].status, 'revoked');
  // 열거 순서에 의존하지 않는다.
  assert.deepStrictEqual(foldDelegations([revokeEvent, grantEvent()], { now: '2026-01-05T00:00:00.000Z' }).delegations, revoked.delegations);

  // 취소는 자기가 가리키는 부여와 같은 위임·종류여야 한다. 이전 이벤트 ID만
  // 맞으면 되게 두면 다른 위임의 취소로 엉뚱한 권한이 꺼진다.
  const mismatchedRevoke = Object.assign({}, revokeEvent, { eventId: 'EVT-77777777777777777777', delegationId: 'DLG-FFFFFFFFFFFFFFFFFFFF' });
  const wrongTarget = foldDelegations([grantEvent(), mismatchedRevoke], { now: '2026-01-05T00:00:00.000Z' });
  assert.strictEqual(wrongTarget.active.length, 1, '다른 위임을 가리키는 취소로 권한이 꺼지면 안 됩니다.');
  assert(wrongTarget.diagnostics.some((item) => item.code === 'RDL-DLG-017'));

  // 같은 범위에 활성 위임이 둘이면 어느 것이 근거인지 갈린다 — 하나를 조용히
  // 고르는 대신 그 범위를 비우고 진단한다.
  const secondGrant = grantEvent({ eventId: 'EVT-88888888888888888888', requestId: 'REQ-88888888888888888888', expiresAt: '2026-01-07T00:00:00.000Z', delegationId: delegationIdFor({ kind: 'scope-change', projectId: 'crm', delegateClientId: 'agent-a', grantedBy: 'MEMBER-001', expiresAt: '2026-01-07T00:00:00.000Z' }) });
  const ambiguous = foldDelegations([grantEvent(), secondGrant], { now: '2026-01-05T00:00:00.000Z' });
  assert.strictEqual(ambiguous.active.length, 0, '모호한 위임은 권한을 열면 안 됩니다.');
  assert.deepStrictEqual(ambiguous.ambiguous, [{ kind: 'scope-change', delegateClientId: 'agent-a' }]);
  assert(ambiguous.diagnostics.some((item) => item.code === 'RDL-DLG-018'));

  // 실제 Workspace: 부여 → 자동 승인 → 취소 → 다시 질문.
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# delegation\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'desk-b', '--name', 'Desk B', '--type', 'device', '--owner', 'MEMBER-001']);

  assert.throws(() => grantDelegation(temporary, { project: 'crm', clientId: 'desk-b', kind: 'publish', delegateClientId: 'agent-a', grantedBy: 'MEMBER-001', reason: '배포를 맡긴다' }), /위임할 수 없는 결정/u);
  assert.throws(() => grantDelegation(temporary, { project: 'crm', clientId: 'desk-b', kind: 'scope-change', delegateClientId: 'agent-a', grantedBy: 'MEMBER-404', reason: 'x' }), /등록된 멤버만/u);

  const granted = grantDelegation(temporary, { project: 'crm', clientId: 'desk-b', kind: 'scope-change', delegateClientId: 'agent-a', grantedBy: 'MEMBER-001', reason: '범위 확장은 에이전트가 판단한다' });
  assert.strictEqual(granted.delegation.status, 'active');
  assert.strictEqual(granted.delegation.delegateClientId, 'agent-a');
  assert(activeDelegationFor(temporary, { project: 'crm', kind: 'scope-change', clientId: 'agent-a' }), '부여된 위임을 찾을 수 있어야 합니다.');
  assert.strictEqual(activeDelegationFor(temporary, { project: 'crm', kind: 'scope-change', clientId: 'desk-b' }), null, '위임은 수임 Client에만 적용됩니다.');
  assert.strictEqual(activeDelegationFor(temporary, { project: 'crm', kind: 'release-version', clientId: 'agent-a' }), null, '위임은 종류별로 분리됩니다.');

  // 위임은 질문을 없애되 기록을 없애지 않는다 — 요청과 답변이 함께 남고
  // 어느 위임으로 승인됐는지 사유에 남는다.
  const delegatedRequest = {
    project: 'crm', clientId: 'agent-a', kind: 'scope-change', subject: '문서 정체성 마이그레이션',
    question: '요청에 없던 작업을 착수할까요?',
    options: [{ id: 'proceed', label: '착수한다' }, { id: 'defer', label: '별도 태스크로 남긴다' }],
    recommendation: { option: 'proceed', because: '같은 파일을 다시 열어야 해서 함께 하는 편이 쌉니다' },
    impact: { reversible: true, blast: '이 작업 묶음' }
  };
  const auto = requestDecision(temporary, delegatedRequest);
  assert.strictEqual(auto.delegated, true, '유효한 위임이 있으면 질문 없이 진행되어야 합니다.');
  assert.strictEqual(auto.decision.status, 'answered');
  assert.strictEqual(auto.decision.selectedOption, 'proceed', '위임 승인은 권고안을 따릅니다.');
  assert.strictEqual(auto.decision.answeredBy, 'MEMBER-001', '위임 승인의 결정자는 부여자입니다.');
  assert(auto.decision.reason.includes(granted.delegation.delegationId), `위임 근거가 사유에 남아야 합니다: ${auto.decision.reason}`);
  assert.strictEqual(listDecisions(temporary, { project: 'crm', open: true }).decisions.length, 0, '위임된 결정은 대기로 남지 않습니다.');

  // 취소하면 다음 결정부터 다시 묻는다.
  const revokedResult = revokeDelegation(temporary, { project: 'crm', clientId: 'desk-b', delegationId: granted.delegation.delegationId, revokedBy: 'MEMBER-001', reason: '범위 판단을 다시 사람이 한다' });
  assert.strictEqual(revokedResult.delegation.status, 'revoked');
  assert.strictEqual(activeDelegationFor(temporary, { project: 'crm', kind: 'scope-change', clientId: 'agent-a' }), null);
  const afterRevoke = requestDecision(temporary, Object.assign({}, delegatedRequest, { subject: '두 번째 범위 확장' }));
  assert.strictEqual(afterRevoke.delegated, undefined, '취소 후에는 위임 승인이 없어야 합니다.');
  assert.strictEqual(afterRevoke.decision.status, 'open');

  // CLI 표면과 검사.
  const listed = rdl(['delegation', 'list', '--project', 'crm']);
  assert.strictEqual(listed.total, 1);
  assert.strictEqual(listed.active, 0);
  const checked = rdl(['check']);
  assert.strictEqual(checked.summary.errors, 0, JSON.stringify(checked.diagnostics));

  assert.strictEqual(listDelegations(temporary, { project: 'crm', active: true }).delegations.length, 0);

  process.stdout.write('delegation tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
