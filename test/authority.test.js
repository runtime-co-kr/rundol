'use strict';

// 인가는 쓰기 경로만으로 지킬 수 없다. 이 시험은 CLI를 지나지 않고 원장에 직접
// 도착한 이벤트 — Git 병합으로 들어오는 것과 같은 경로 — 가 상태를 바꾸지
// 못한다는 것을 확인한다. 외부 검증에서 위조한 승인이 approved로, 위조한 위임이
// active로 채택된 것을 재현한 시험이다.
//
// 위조 이벤트는 형식을 완전히 갖춰야 한다. 형식이 틀리면 인가에 닿기 전에
// 스키마 검사가 버리고, 그러면 이 시험은 통과하면서 아무것도 증명하지 못한다 —
// 처음 작성했을 때 실제로 그랬다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeApprovalEvent, foldApprovals, readApprovalEvents } = require('../src/approval');
const { delegationIdFor, foldDelegations, readDelegationEvents } = require('../src/delegation');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-authority-'));
const home = path.join(temporary, 'runtime');
const previousHome = process.env.RUNDOL_HOME;
process.env.RUNDOL_HOME = home;

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

const eventsRoot = () => path.join(temporary, 'projects', 'workspace', 'events');

// 원장에 직접 이벤트를 붙인다. CLI의 결박을 지나지 않는 경로 — Git 병합이
// 정확히 이렇게 도착한다.
function appendRaw(ledger, projectId, clientId, event) {
  const directory = path.join(eventsRoot(), ledger);
  fs.mkdirSync(directory, { recursive: true });
  const shard = path.join(directory, `${ledger}-${projectId}-${clientId}-000001.jsonl`);
  fs.appendFileSync(shard, `${JSON.stringify(event)}\n`, 'utf8');
}

function authorityFor(projectKey) {
  return require('../src/authority').authorityContext(temporary, projectKey, { now: Date.parse('2026-08-17T12:00:00.000Z') });
}

const hex = (character) => character.repeat(20);

try {
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# authority\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', 'A', '--type', 'agent', '--owner', 'MEMBER-001']);
  // 위조 검증에는 실제 두 번째 멤버가 필요 없다. 이 Client의 소유자가 아닌 명의면
  // 충분하다 — 인가는 "이 Client가 이 이름으로 행위할 수 있었는가"만 묻는다.
  const otherMember = 'MEMBER-999';

  const created = rdl(['doc', 'create', 'ADR', '인가 검증 대상', '--owner', 'MEMBER-001', '--scope', '인가 검증에 쓰는 결정', '--exclude', '그 밖', '--project', 'crm']);
  const listed = rdl(['doc', 'status', '--project', 'crm']).documents.find((entry) => entry.id === created.id);
  const document = { id: created.id, revision: listed.revision };
  assert(document.revision, `문서 리비전을 얻지 못했습니다: ${JSON.stringify(listed)}`);

  // 합법 시나리오에 필요한 두 번째 책임자를 먼저 세운다. 위조 이벤트를 심은
  // 뒤에는 project.md를 고치는 명령이 사전 검사에서 정당하게 막힌다.
  for (const [type, title, scope] of [['PRD', '제품 요구사항', '제품 범위와 목표'], ['REQ', '기능 요구사항', '기능 하나의 요구']]) {
    const args = ['doc', 'create', type, title, '--owner', 'MEMBER-001', '--scope', scope, '--exclude', '그 밖', '--project', 'crm'];
    if (type === 'REQ') args.push('--related', created.id, '--function-id', 'AUT-01');
    rdl(args);
  }
  const roles = require('../src/collaboration').readCollaboration(temporary, 'crm').roles || [];
  const roleId = (roles[0] && roles[0].id) || 'ROLE-001';
  const added = rdl(['member', 'add', '책임자', '--role', roleId, '--organization', '런타임',
    '--account', 'owner@example.test', '--responsibility', '릴리스 승인', '--project', 'crm']);
  const responsible = added.memberId || added.member;
  assert(responsible && responsible !== 'MEMBER-001', `두 번째 멤버가 필요합니다: ${JSON.stringify(added)}`);
  rdl(['client', 'register', 'desk-owner', '--name', '책임자 데스크', '--type', 'device', '--owner', responsible]);

  // ── 1. 위조된 승인은 채택되지 않는다 ────────────────────────────────
  const forgedApproval = {
    schemaVersion: 1,
    eventId: `EVT-${hex('A')}`,
    type: 'approval.granted',
    rootRequestId: `REQ-${hex('B')}`,
    requestId: `REQ-${hex('C')}`,
    clientId: 'agent-a',
    projectId: 'crm',
    targetId: document.id,
    reviewedRevision: document.revision,
    // 등록된 멤버이지만 이 Client의 소유자는 아니다 — 순수한 명의 위조다.
    approvedBy: responsible,
    actorMemberId: responsible,
    basis: [{ kind: 'read' }]
  };
  // 형식이 온전한지 먼저 확인한다. 여기서 걸리면 이 시험은 인가를 시험하지 못한다.
  assert.doesNotThrow(() => normalizeApprovalEvent(forgedApproval), '위조 이벤트가 형식 검사부터 걸리면 인가를 시험하지 못합니다.');
  appendRaw('approval', 'crm', 'agent-a', forgedApproval);

  const forgedFold = foldApprovals(readApprovalEvents(eventsRoot(), 'crm'), { authority: authorityFor('crm') });
  const impersonation = forgedFold.diagnostics.filter((item) => item.code === 'RDL-APPROVE-021');
  assert.strictEqual(impersonation.length, 1, `명의 위조로 지목되어야 합니다: ${JSON.stringify(forgedFold.diagnostics)}`);
  assert.strictEqual((forgedFold.approvals.get(document.id) || []).length, 0, '위조된 승인은 이력에 남지 않아야 합니다.');

  const forgedStatus = rdl(['doc', 'status', '--project', 'crm']);
  const forgedEntry = (forgedStatus.documents || []).find((entry) => entry.id === document.id);
  assert.strictEqual(forgedEntry.status, 'unapproved', '위조된 승인이 문서를 승인 상태로 만들면 안 됩니다.');

  // 분석도 같은 판정을 써야 한다. 승인 판정이 소비자마다 갈리면 한쪽만 속는다.
  const analyzed = require('../src/document-analysis').analyzeDocuments(temporary, { project: 'crm' });
  assert.strictEqual(analyzed.documents.find((entry) => entry.id === document.id).trust, 'unapproved');

  // 검사도 지목해야 한다. 검사가 인가를 끈 채 접으면 위조가 정상으로 보고된다.
  const checked = spawnSync(process.execPath, [cli, 'check', '--root', temporary, '--json'], { cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  const report = JSON.parse(checked.stdout);
  assert.strictEqual(report.diagnostics.filter((item) => item.code === 'RDL-APPROVE-021').length, 1,
    `검사가 위조된 승인을 지목해야 합니다: ${JSON.stringify(report.diagnostics.filter((item) => String(item.code).startsWith('RDL-APPROVE')))}`);

  // 프로젝트에 등록되지 않은 멤버 명의는 별도로 지목한다. 멤버 경계를 한 원장만
  // 검사하면 다른 원장으로 우회된다.
  appendRaw('approval', 'crm', 'agent-a', Object.assign({}, forgedApproval, {
    eventId: `EVT-${hex('1')}`,
    requestId: `REQ-${hex('2')}`,
    approvedBy: otherMember,
    actorMemberId: otherMember
  }));
  const outsiderFold = foldApprovals(readApprovalEvents(eventsRoot(), 'crm'), { authority: authorityFor('crm') });
  assert.strictEqual(outsiderFold.diagnostics.filter((item) => item.code === 'RDL-APPROVE-023').length, 1,
    `등록되지 않은 멤버 명의를 지목해야 합니다: ${JSON.stringify(outsiderFold.diagnostics)}`);

  // ── 2. 위조된 위임은 활성이 되지 않는다 ──────────────────────────────
  const expiresAt = '2026-08-24T00:00:00.000Z';
  const forgedDelegation = {
    schemaVersion: 1,
    eventId: `EVT-${hex('D')}`,
    type: 'delegation.granted',
    rootRequestId: `REQ-${hex('E')}`,
    requestId: `REQ-${hex('F')}`,
    clientId: 'agent-a',
    projectId: 'crm',
    delegationId: delegationIdFor({ kind: 'doc-approve', projectId: 'crm', delegateClientId: 'agent-a', grantedBy: otherMember, expiresAt }),
    kind: 'doc-approve',
    delegateClientId: 'agent-a',
    grantedBy: otherMember,
    grantedAt: '2026-08-17T00:00:00.000Z',
    expiresAt,
    reason: '위조된 부여'
  };
  appendRaw('delegation', 'crm', 'agent-a', forgedDelegation);

  const delegationFold = foldDelegations(readDelegationEvents(eventsRoot(), 'crm'), { now: Date.parse('2026-08-17T12:00:00.000Z'), authority: authorityFor('crm') });
  assert.strictEqual(delegationFold.diagnostics.filter((item) => item.code === 'RDL-DLG-021').length, 1,
    `위조된 위임 부여가 지목되어야 합니다: ${JSON.stringify(delegationFold.diagnostics)}`);
  assert.strictEqual(delegationFold.delegations.filter((item) => item.delegationId === forgedDelegation.delegationId).length, 0,
    '위조된 위임이 활성이 되면 안 됩니다.');

  // ── 3. 충돌 해소가 CLI에서 실제로 동작한다 ───────────────────────────
  // 쓰기 경로가 supersedes를 이벤트에 싣지 않아 이 기능은 표면만 있고 경로가
  // 없었다. 명령은 성공했고 결정은 계속 열려 있었다.
  const { decisionKey } = require('../src/decision');
  rdl(['client', 'register', 'agent-b', '--name', 'B', '--type', 'agent', '--owner', 'MEMBER-001']);
  const requested = rdl(['decision', 'request', '--kind', 'release-version', '--subject', 'v0.30.0',
    '--question', '어떤 버전으로 올리나', '--option', 'minor=마이너', '--option', 'major=메이저',
    '--recommend', 'minor', '--because', '새 명령이 추가됐다', '--blast', '배포',
    '--client-id', 'agent-a', '--project', 'crm']);
  const decisionId = requested.decision.decisionId;
  rdl(['decision', 'answer', decisionId, '--select', 'minor', '--member', 'MEMBER-001',
    '--reason', '마이너가 맞다', '--client-id', 'agent-a', '--project', 'crm']);

  // 다른 Client에서 다른 선택이 병합돼 들어온다. 상충하는 답은 해소될 때까지
  // 열린 상태로 둔다 — 하나를 고르는 것은 결정이 아니라 은폐다.
  const conflictingEventId = `EVT-${hex('B')}`;
  appendRaw('decision', 'crm', 'agent-b', {
    schemaVersion: 1,
    eventId: conflictingEventId,
    type: 'decision.answered',
    rootRequestId: `REQ-${hex('D')}`,
    requestId: `REQ-${hex('E')}`,
    clientId: 'agent-b',
    projectId: 'crm',
    decisionId,
    decisionKey: decisionKey({ kind: 'release-version', project: 'crm', subject: 'v0.30.0' }),
    kind: 'release-version',
    selectedOption: 'major',
    answeredBy: 'MEMBER-001',
    reason: '메이저가 맞다'
  });
  const conflicted = rdl(['decision', 'list', '--project', 'crm']).decisions.find((item) => item.decisionId === decisionId);
  assert.strictEqual(conflicted.status, 'open', '상충하는 답변이 있으면 결정은 열린 채로 남아야 합니다.');

  // 잘못된 대체는 해소하지 못한다. 진단만 하고 답변을 살려 두면 self·unknown·
  // 분기 대체로 아무 결정이나 answered로 만들 수 있다.
  rdl(['decision', 'answer', decisionId, '--select', 'minor', '--member', 'MEMBER-001',
    '--reason', '없는 대상을 대체한다', '--supersedes', `EVT-${hex('C')}`,
    '--client-id', 'agent-a', '--project', 'crm']);
  const stillOpen = rdl(['decision', 'list', '--project', 'crm']).decisions.find((item) => item.decisionId === decisionId);
  assert.strictEqual(stillOpen.status, 'open', '대체 대상이 없는 답변이 결정을 해소하면 안 됩니다.');

  // 올바른 대체는 해소한다. 탈출구 없이 닫기만 하면 영구 교착이 된다.
  const resolved = rdl(['decision', 'answer', decisionId, '--select', 'minor', '--member', 'MEMBER-001',
    '--reason', '마이너로 확정한다', '--supersedes', conflictingEventId,
    '--client-id', 'agent-a', '--project', 'crm']);
  assert.strictEqual(resolved.decision.status, 'answered', `대체가 충돌을 해소해야 합니다: ${JSON.stringify(resolved.decision)}`);
  assert.strictEqual(resolved.decision.selectedOption, 'minor');

  // ── 4. 교차 소유자 위임이 실제로 동작한다 ────────────────────────────
  // 접기가 위임을 몰라 위임된 답변이 버려졌다. 명령은 delegated:true를
  // 돌려주면서 상태는 open이었다 — 표면과 상태가 갈렸다.
  // 책임자가 자기 Client로 위임을 부여하고, 수임 Client가 그 이름으로 답한다.
  const granted = rdl(['delegation', 'grant', '--kind', 'release-version', '--delegate', 'agent-a',
    '--member', responsible, '--reason', '릴리스 판단을 위임한다', '--days', '7',
    '--client-id', 'desk-owner', '--project', 'crm']);
  const delegationId = granted.delegation.delegationId;

  const delegatedDecision = rdl(['decision', 'request', '--kind', 'release-version', '--subject', 'v0.31.0',
    '--question', '다음 버전은', '--option', 'minor=마이너', '--option', 'major=메이저',
    '--recommend', 'minor', '--because', '기능 추가', '--blast', '배포',
    '--client-id', 'agent-a', '--project', 'crm']);
  // 유효한 위임이 있으면 요청 즉시 부여자 명의의 답변이 함께 남는다. 그 답변이
  // 접기에서 살아남아야 결정이 실제로 닫힌다.
  assert.strictEqual(delegatedDecision.delegated, true, '위임이 적용되어야 합니다.');
  assert.strictEqual(delegatedDecision.decision.status, 'answered',
    `위임된 결정은 열린 채로 남으면 안 됩니다: ${JSON.stringify(delegatedDecision.decision)}`);
  assert.strictEqual(delegatedDecision.decision.answeredBy, responsible, '책임은 부여자가 진다.');
  assert.strictEqual(delegatedDecision.delegationId, delegationId);

  // ── 5. 취소는 미래에만 작용한다 ──────────────────────────────────────
  // 인가를 "지금 유효한가"로 판정하면 두 가지가 동시에 깨진다. 만료·취소된 위임이
  // 영원히 통하고, 반대로 취소하면 그 전에 정당하게 한 일이 사라진다. 둘 다 원장의
  // 과거 사실을 현재 상태로 판정한 결과다.
  const beforeRevoke = rdl(['decision', 'list', '--project', 'crm']).decisions
    .find((item) => item.decisionId === delegatedDecision.decision.decisionId);
  assert.strictEqual(beforeRevoke.status, 'answered');

  rdl(['delegation', 'revoke', delegationId, '--member', responsible, '--reason', '위임을 거둔다',
    '--client-id', 'desk-owner', '--project', 'crm']);

  // 취소 전에 남은 답변은 그대로 살아 있어야 한다.
  const afterRevoke = rdl(['decision', 'list', '--project', 'crm']).decisions
    .find((item) => item.decisionId === delegatedDecision.decision.decisionId);
  assert.strictEqual(afterRevoke.status, 'answered', '취소가 그 전의 정당한 답변을 지우면 안 됩니다.');
  assert.strictEqual(afterRevoke.answeredBy, responsible);

  // 취소 뒤에 그 위임을 근거로 든 행위는 인정되지 않는다. 쓰기 경로는 이미 막지만
  // Git 병합으로 들어오는 경로가 남으므로 접기가 판정해야 한다.
  const lateKey = decisionKey({ kind: 'release-version', project: 'crm', subject: 'v0.32.0' });
  const lateDecisionId = require('../src/decision').decisionIdFor(lateKey);
  const lateBase = {
    schemaVersion: 1,
    rootRequestId: `REQ-${hex('7')}`,
    clientId: 'agent-a',
    projectId: 'crm',
    decisionId: lateDecisionId,
    decisionKey: lateKey,
    kind: 'release-version'
  };
  appendRaw('decision', 'crm', 'agent-a', Object.assign({}, lateBase, {
    eventId: `EVT-${hex('8')}`,
    requestId: `REQ-${hex('9')}`,
    type: 'decision.requested',
    question: '취소 뒤의 결정',
    options: [{ id: 'minor', label: '마이너' }, { id: 'major', label: '메이저' }],
    recommendation: { option: 'minor', because: '기능 추가' },
    impact: { reversible: true, blast: '배포' },
    occurredAt: new Date().toISOString(),
    recordedAt: new Date().toISOString()
  }));
  appendRaw('decision', 'crm', 'agent-a', Object.assign({}, lateBase, {
    eventId: `EVT-${hex('A')}`,
    requestId: `REQ-${hex('B')}`,
    type: 'decision.answered',
    selectedOption: 'minor',
    answeredBy: responsible,
    delegationId,
    reason: '취소된 위임을 근거로 든다',
    occurredAt: new Date(Date.now() + 60000).toISOString(),
    recordedAt: new Date(Date.now() + 60000).toISOString()
  }));
  const lateFold = rdl(['decision', 'list', '--project', 'crm']).decisions.find((item) => item.decisionId === lateDecisionId);
  assert.strictEqual(lateFold.status, 'open', '취소된 위임을 근거로 든 답변이 결정을 해소하면 안 됩니다.');

  // ── 6. Client 비활성화는 과거 기록을 지우지 않는다 ───────────────────
  rdl(['client', 'disable', 'agent-a']);
  const afterDisable = rdl(['decision', 'list', '--project', 'crm']).decisions
    .find((item) => item.decisionId === delegatedDecision.decision.decisionId);
  assert.strictEqual(afterDisable.status, 'answered', 'Client 비활성화가 과거 기록을 소급 무효화하면 안 됩니다.');
  assert.strictEqual(afterDisable.answeredBy, responsible);
  rdl(['client', 'enable', 'agent-a']);

  // ── 7. 판정에 쓰는 시각은 다이제스트가 덮는다 ────────────────────────
  // occurredAt은 canonical 밖이라 같은 이벤트의 시각만 바꿔도 다이제스트가
  // 그대로다. 그 값으로 권한을 판정하면 취소된 위임을 취소 전으로 되돌려 다시
  // 쓸 수 있다 — 판정에 쓰는 값과 다이제스트가 덮는 값이 어긋나면 안 된다.
  const { decisionEnvelope } = require('../src/decision');
  const { approvalEnvelope } = require('../src/approval');
  const { delegationEnvelope } = require('../src/delegation');
  const answerBase = {
    schemaVersion: 1,
    eventId: `EVT-${hex('2')}`,
    type: 'decision.answered',
    rootRequestId: `REQ-${hex('3')}`,
    requestId: `REQ-${hex('4')}`,
    clientId: 'agent-a',
    projectId: 'crm',
    decisionId: lateDecisionId,
    decisionKey: lateKey,
    kind: 'release-version',
    selectedOption: 'minor',
    answeredBy: 'MEMBER-001',
    reason: '시각이 다이제스트에 덮이는지 본다',
    recordedAt: '2026-08-17T00:00:00.000Z'
  };
  const early = decisionEnvelope(answerBase).canonicalDigest;
  const later = decisionEnvelope(Object.assign({}, answerBase, { recordedAt: '2026-08-18T00:00:00.000Z' })).canonicalDigest;
  assert.notStrictEqual(early, later, '기록 시각을 바꾸면 결정 다이제스트가 달라져야 합니다.');
  // 표시용 시각은 판정에 쓰이지 않으므로 다이제스트를 바꾸지 않는다.
  assert.strictEqual(decisionEnvelope(Object.assign({}, answerBase, { occurredAt: '2026-01-01T00:00:00.000Z' })).canonicalDigest, early);

  const approvalBase = {
    schemaVersion: 1,
    eventId: `EVT-${hex('5')}`,
    type: 'approval.granted',
    rootRequestId: `REQ-${hex('6')}`,
    requestId: `REQ-${hex('0')}`,
    clientId: 'agent-a',
    projectId: 'crm',
    targetId: document.id,
    reviewedRevision: document.revision,
    approvedBy: 'MEMBER-001',
    actorMemberId: 'MEMBER-001',
    basis: [{ kind: 'read' }],
    recordedAt: '2026-08-17T00:00:00.000Z'
  };
  assert.notStrictEqual(
    approvalEnvelope(approvalBase).canonicalDigest,
    approvalEnvelope(Object.assign({}, approvalBase, { recordedAt: '2026-08-18T00:00:00.000Z' })).canonicalDigest,
    '기록 시각을 바꾸면 승인 다이제스트가 달라져야 합니다.');

  const revokeBase = {
    schemaVersion: 1,
    eventId: `EVT-${hex('C')}`,
    type: 'delegation.revoked',
    rootRequestId: `REQ-${hex('C')}`,
    requestId: `REQ-${hex('D')}`,
    clientId: 'desk-owner',
    projectId: 'crm',
    delegationId,
    kind: 'release-version',
    previousDelegationEventId: `EVT-${hex('E')}`,
    revokedBy: responsible,
    reason: '시각이 다이제스트에 덮이는지 본다',
    recordedAt: '2026-08-17T00:00:00.000Z'
  };
  assert.notStrictEqual(
    delegationEnvelope(revokeBase).canonicalDigest,
    delegationEnvelope(Object.assign({}, revokeBase, { recordedAt: '2026-08-18T00:00:00.000Z' })).canonicalDigest,
    '기록 시각을 바꾸면 위임 다이제스트가 달라져야 합니다.');

  // ── 8. 인가 없는 접기는 불가능하다 ──────────────────────────────────
  // 안전한 경로가 opt-in이면 언젠가 꺼진다. 실제로 rdl check가 껐었다.
  assert.throws(() => foldApprovals([], {}), /인가 컨텍스트/u, '인가 없는 승인 접기는 거부되어야 합니다.');
  assert.throws(() => foldDelegations([], { now: 0 }), /인가 컨텍스트/u, '인가 없는 위임 접기는 거부되어야 합니다.');
  assert.throws(() => require('../src/decision').foldDecisions([], {}), /인가 컨텍스트/u, '인가 없는 결정 접기는 거부되어야 합니다.');

  process.stdout.write('authority tests passed\n');
} finally {
  if (previousHome === undefined) delete process.env.RUNDOL_HOME;
  else process.env.RUNDOL_HOME = previousHome;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
