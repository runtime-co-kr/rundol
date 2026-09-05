'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeApprovalEvent, foldApprovals, trustState, documentApprovals, documentStatus, submitDocument, approveDocument, documentHistory, diffSinceApproval, diffSubmission } = require('../src/approval');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-approval-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

const REVISION_A = 'a'.repeat(64);
const REVISION_B = 'b'.repeat(64);

function approvalEvent(overrides) {
  return Object.assign({
    schemaVersion: 1,
    eventId: 'EVT-11111111111111111111',
    type: 'approval.granted',
    rootRequestId: 'REQ-11111111111111111111',
    requestId: 'REQ-22222222222222222222',
    clientId: 'desk-b',
    projectId: 'crm',
    targetId: 'REQ-001',
    reviewedRevision: REVISION_A,
    approvedBy: 'MEMBER-001',
    actorMemberId: 'MEMBER-001',
    basis: [{ kind: 'read' }]
  }, overrides || {});
}

// 접기는 인가 컨텍스트를 요구한다. 손으로 만든 이벤트를 접는 시험도 같은
// 조건을 지나야 한다 — 시험만 인가를 끄면 시험은 실제 경로를 시험하지 않는다.
const LEDGER_AUTHORITY = { clientOwners: [['agent-a', 'MEMBER-001'], ['desk-b', 'MEMBER-001'], ['agent-b', 'MEMBER-002']], members: ['MEMBER-001', 'MEMBER-002'], delegations: [] };

try {
  // 근거는 필수, 사유는 선택이다 — 강제된 사유는 "확인함"으로 채워질 뿐이고
  // 그것으로는 AI 검토가 놓쳤는지 사람이 건너뛰었는지 구분할 수 없다.
  assert.strictEqual(normalizeApprovalEvent(approvalEvent()).reason, undefined);
  assert.strictEqual(normalizeApprovalEvent(approvalEvent({ reason: '설계 의도 확인' })).reason, '설계 의도 확인');
  assert.throws(() => normalizeApprovalEvent(approvalEvent({ basis: [] })), /근거가 하나 이상/u);
  assert.throws(() => normalizeApprovalEvent(approvalEvent({ basis: [{ kind: '지어낸근거' }] })), /지원하지 않는 승인 근거/u);
  assert.throws(() => normalizeApprovalEvent(approvalEvent({ approvedBy: 'agent-a' })), /MEMBER-ID/u);
  assert.throws(() => normalizeApprovalEvent(approvalEvent({ transcript: '금지' })), /알 수 없는 필드/u);
  // 행위자와 승인자가 다르면 위임이 그 차이를 정당화해야 한다. 위임 없이 다른
  // 멤버 명의로 남은 기록은 형태만으로도 거부된다 — 병합으로 흘러들어와도.
  assert.throws(() => normalizeApprovalEvent(approvalEvent({ approvedBy: 'MEMBER-002' })), /근거가 된 위임이 필요/u);
  assert.strictEqual(normalizeApprovalEvent(approvalEvent({ approvedBy: 'MEMBER-002', delegationId: 'DLG-AAAAAAAAAAAAAAAAAAAA', basis: [{ kind: 'delegated' }] })).actorMemberId, 'MEMBER-001');
  assert.deepStrictEqual(normalizeApprovalEvent(approvalEvent({ basis: [{ kind: 'verdict', detail: 'VAL-001' }] })).basis, [{ kind: 'verdict', detail: 'VAL-001' }]);

  // 신뢰 상태는 셋 다 파생이다 — 승인 리비전과 현재 리비전의 비교뿐이다.
  const folded = foldApprovals([approvalEvent()], { authority: LEDGER_AUTHORITY });
  assert.strictEqual(trustState({ id: 'REQ-001', revision: REVISION_A }, folded.approvals.get('REQ-001')).status, 'approved');
  assert.strictEqual(trustState({ id: 'REQ-001', revision: REVISION_B }, folded.approvals.get('REQ-001')).status, 'stale', '수정되면 승인이 낡아야 합니다.');
  assert.strictEqual(trustState({ id: 'REQ-002', revision: REVISION_A }, folded.approvals.get('REQ-002')).status, 'unapproved');
  // 낡은 상태에서도 마지막 승인 정보는 남아 무엇으로 되돌아갈지 알 수 있다.
  const stale = trustState({ id: 'REQ-001', revision: REVISION_B }, folded.approvals.get('REQ-001'));
  assert.strictEqual(stale.approvedRevision, REVISION_A);
  assert.strictEqual(stale.approvedBy, 'MEMBER-001');

  // 실제 Workspace.
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# approval\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);

  const created = rdl(['doc', 'create', 'ADR', '승인 대상 결정', '--owner', 'MEMBER-001', '--scope', '승인 흐름 검증을 위한 결정 기록', '--exclude', '구현 절차', '--project', 'crm']);
  const documentFile = path.join(temporary, 'projects', 'crm', created.relativeFile.replace(/^projects\/crm\//u, ''));
  const projectRoot = path.join(temporary, 'projects', 'crm');
  // 승인 이전에 커밋해 두어야 승인된 리비전을 담은 커밋이 실제로 존재한다.
  command('git', ['add', '-A'], projectRoot);
  command('git', ['commit', '-m', 'add document'], projectRoot);

  // AI가 만든 문서는 승인 기록이 없으므로 미승인이다 — frontmatter의 state와 무관하다.
  const initial = documentStatus(temporary, { project: 'crm' });
  const target = initial.documents.find((document) => document.id === created.id);
  assert.strictEqual(target.status, 'unapproved', 'AI가 만든 문서는 승인 전까지 미승인이어야 합니다.');
  assert.strictEqual(initial.counts.unapproved >= 1, true);

  assert.throws(() => approveDocument(temporary, { project: 'crm', clientId: 'agent-a', targetId: created.id, approvedBy: 'MEMBER-404', basis: [{ kind: 'read' }] }), /등록된 멤버만/u);
  const approved = approveDocument(temporary, { project: 'crm', clientId: 'agent-a', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }], reason: '범위와 결정을 확인함' });
  assert.strictEqual(approved.document.status, 'approved');
  assert.strictEqual(approved.created, true);
  // 같은 리비전을 다시 승인해도 기록이 늘지 않는다.
  assert.strictEqual(approveDocument(temporary, { project: 'crm', clientId: 'agent-a', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }] }).created, false);

  // 승인 결과를 파일에 쓰지 않으므로 리비전이 유지된다 — 썼다면 자기 승인을 무효화했을 것이다.
  const afterApproval = documentStatus(temporary, { project: 'crm' }).documents.find((document) => document.id === created.id);
  assert.strictEqual(afterApproval.status, 'approved');
  assert.strictEqual(afterApproval.revision, target.revision, '승인이 문서 리비전을 바꾸면 안 됩니다.');

  // 한 글자만 고쳐도 승인이 낡는다.
  fs.appendFileSync(documentFile, '\n승인 이후 추가된 문장입니다.\n', 'utf8');
  const modified = documentStatus(temporary, { project: 'crm' }).documents.find((document) => document.id === created.id);
  assert.strictEqual(modified.status, 'stale', '수정하면 승인이 낡아야 합니다.');
  assert.strictEqual(modified.approvedRevision, target.revision);

  // frontmatter를 active로 적어도 신뢰 상태는 바뀌지 않는다 — 원장이 정본이다.
  const source = fs.readFileSync(documentFile, 'utf8');
  fs.writeFileSync(documentFile, source.replace(/^state: .*$/mu, 'state: active'), 'utf8');
  assert.strictEqual(documentStatus(temporary, { project: 'crm' }).documents.find((document) => document.id === created.id).status, 'stale', 'frontmatter로 신뢰 상태를 위조할 수 없어야 합니다.');

  // 이력은 승인 기록과 커밋을 함께 보여준다.
  const history = documentHistory(temporary, { project: 'crm', targetId: created.id });
  assert.strictEqual(history.approvals.length, 1);
  assert.strictEqual(history.approvals[0].approvedBy, 'MEMBER-001');
  assert.deepStrictEqual(history.approvals[0].basis, [{ kind: 'read' }]);
  assert.strictEqual(history.document.status, 'stale');

  // 승인 이후 변경분만 보여준다 — 재승인이 싸야 엄격한 무효화가 유지된다.
  // 조건부 단언은 결함을 덮는다: 기준 커밋을 찾지 못해도 통과해 버린다.
  command('git', ['add', '-A'], projectRoot);
  command('git', ['commit', '-m', 'edit after approval'], projectRoot);
  const diff = diffSinceApproval(temporary, { project: 'crm', targetId: created.id });
  assert.strictEqual(diff.status, 'stale');
  assert(diff.baseCommit, `승인된 리비전을 담은 커밋을 찾아야 합니다: ${diff.reason || '(사유 없음)'}`);
  assert(diff.diff && diff.diff.includes('승인 이후 추가된 문장'), `승인 이후 변경분이 나와야 합니다: ${String(diff.diff).slice(0, 200)}`);
  assert.strictEqual(diff.approvedBy, 'MEMBER-001');

  // CLI 표면과 검사.
  const statusCli = rdl(['doc', 'status', '--project', 'crm']);
  assert(statusCli.counts.stale >= 1);
  const historyCli = rdl(['doc', 'history', created.id, '--project', 'crm']);
  assert.strictEqual(historyCli.approvals.length, 1);
  const checked = rdl(['check']);
  assert.strictEqual(checked.summary.errors, 0, JSON.stringify(checked.diagnostics));

  // ── 보드가 같은 답을 낸다 ──────────────────────────────────────────────────
  //
  // 승인 상태는 지금까지 명령으로만 물을 수 있었다. 화면이 그것을 못 받으면 문서를 열어도
  // 승인 여부를 알 수 없고, 사람은 "지금 뭐가 승인된 상태냐"를 매번 다시 묻는다.
  //
  // 판정을 화면 쪽에서 새로 짓지 않았다는 것을 여기서 못박는다. doc status와 보드가 같은
  // 문서에 다른 답을 내면 사용자는 화면을 믿고, 화면이 틀린 쪽일 때 그 사실이 드러나지 않는다.
  const snapshot = require('../src/board').workspaceSnapshot(temporary, 'crm', null);
  const inbox = snapshot.reviewQueue;
  assert.ok(inbox, '승인 원장이 있는 저장소에서는 검토 인박스가 실린다.');
  assert.strictEqual(inbox.used, true, '승인을 한 번이라도 한 프로젝트는 승인 축을 쓰는 것으로 답한다.');
  assert.strictEqual(inbox.counts.stale, statusCli.counts.stale, '인박스의 낡음 수가 doc status와 같다.');
  assert.strictEqual(inbox.counts.unapproved, statusCli.counts.unapproved || 0, '인박스의 미승인 수가 doc status와 같다.');
  // 낡음이 먼저다. 승인된 것이 흔들린 상태라 하류가 이미 그것을 근거로 삼았다.
  assert.strictEqual(inbox.items[0].status, 'stale', '낡은 문서가 줄의 앞에 선다.');
  assert.strictEqual(inbox.items[0].id, created.id);
  assert.strictEqual(inbox.items[0].approvedBy, 'MEMBER-001', '누가 승인했던 것인지가 줄에 실린다.');
  // 문서 옆에도 붙는다. 목록과 상태를 따로 부르면 둘이 다른 시점을 가리킨다.
  assert.strictEqual(snapshot.documents.find((document) => document.id === created.id).approval.status, 'stale');
  // 낡음은 문제이기도 하다 — 승인된 것이 흔들렸고 하류가 그것을 근거로 삼았다.
  assert.ok(snapshot.attention.some((item) => item.kind === 'document' && item.id === created.id),
    '낡은 문서는 attention에도 선다.');

  // ── 문서 제출 관문 ──────────────────────────────────────────────────────────
  //
  // 관문이 없었던 게 아니라 관문 앞에 줄 설 자리가 없었다. 문서는 정본에 바로
  // 커밋되며 전진했고 승인은 맨 끝에 일괄로 몰렸다 — 이틀 내내 "여기부터는 다시 안
  // 타도 된다"는 지점이 한 번도 생기지 않았다. 제출은 그 줄을 만든다.

  // 제출은 승인 원장의 두 번째 종류다. 원장을 나누지 않았으므로 형태 검증도 봉투도
  // 같은 자리를 지난다 — 새 원장이었다면 check.js의 검증 루프를 복제해야 했고,
  // 복제를 잊는 순간 위조된 제출이 아무 데서도 안 걸린다.
  function submissionEvent(overrides) {
    return Object.assign({
      schemaVersion: 1,
      eventId: 'EVT-33333333333333333333',
      type: 'approval.submitted',
      rootRequestId: 'REQ-11111111111111111111',
      requestId: 'REQ-44444444444444444444',
      clientId: 'agent-a',
      projectId: 'crm',
      targetId: 'REQ-001',
      reviewedRevision: REVISION_B,
      submittedBy: 'MEMBER-001'
    }, overrides || {});
  }
  assert.strictEqual(normalizeApprovalEvent(submissionEvent()).submittedBy, 'MEMBER-001');
  assert.strictEqual(normalizeApprovalEvent(submissionEvent({ reason: '결정 반영분' })).reason, '결정 반영분');
  assert.throws(() => normalizeApprovalEvent(submissionEvent({ type: 'approval.rejected' })), /알 수 없는 승인 이벤트 종류/u);
  // 승인 근거는 제출의 칸이 아니다. 무엇에 기대어 올렸는가는 검토자가 물을 것이지
  // 제출자가 미리 증명할 것이 아니고, 칸을 열어 두면 "근거를 적었으니 승인된 셈"이 된다.
  assert.throws(() => normalizeApprovalEvent(submissionEvent({ basis: [{ kind: 'read' }] })), /알 수 없는 필드/u);
  // 제출에는 책임 이전이 없으므로 위임이 설 자리도 없다.
  assert.throws(() => normalizeApprovalEvent(submissionEvent({ delegationId: 'DLG-AAAAAAAAAAAAAAAAAAAA' })), /알 수 없는 필드/u);
  assert.throws(() => normalizeApprovalEvent(submissionEvent({ submittedBy: 'agent-a' })), /MEMBER-ID/u);

  // 한 접기가 두 종류를 함께 낸다. 상태는 둘을 같이 접어야만 나오므로 원장을 나누면
  // 두 원장을 시각으로 맞춰야 한다.
  const mixed = foldApprovals([approvalEvent(), submissionEvent()], { authority: LEDGER_AUTHORITY });
  assert.strictEqual(mixed.approvals.get('REQ-001').length, 1);
  assert.strictEqual(mixed.submissions.get('REQ-001').length, 1);
  assert.strictEqual(mixed.submissions.get('REQ-001')[0].submittedRevision, REVISION_B);

  // 신뢰 상태 세 값은 그대로다. 제출은 축을 하나 더 얹을 뿐이다.
  const waiting = trustState({ id: 'REQ-001', revision: REVISION_B }, mixed.approvals.get('REQ-001'), mixed.submissions.get('REQ-001'));
  assert.strictEqual(waiting.status, 'stale', '제출이 신뢰 상태를 바꾸면 안 됩니다.');
  assert.strictEqual(waiting.approvedRevision, REVISION_A);
  assert.strictEqual(waiting.submission.state, 'pending', '올린 리비전이 지금 파일과 같으면 검토 대기입니다.');
  // 낡음 + 검토 대기 = 재검토 대기. 두 축의 짝이 답하므로 값을 더 늘리지 않는다.
  assert.strictEqual(waiting.submission.submittedBy, 'MEMBER-001');
  // 제출한 적 없는 문서는 초안이다 — 아직 아무에게도 올리지 않았다.
  assert.strictEqual(trustState({ id: 'REQ-001', revision: REVISION_A }, mixed.approvals.get('REQ-001'), []).submission.state, 'none');

  // 위조된 제출은 인가에서 걸린다. 쓰기 경로에서만 막으면 Git 병합으로 들어온
  // 제출이 그대로 검토 인박스에 서고, 승인자는 아무도 올린 적 없는 것을 자기 몫으로 본다.
  const forged = foldApprovals([submissionEvent({ clientId: 'ghost' })], { authority: LEDGER_AUTHORITY });
  assert.strictEqual(forged.submissions.size, 0, '등록되지 않은 Client의 제출은 채택되면 안 됩니다.');
  assert(forged.diagnostics.some((item) => item.code === 'RDL-APPROVE-020'));
  const impersonated = foldApprovals([submissionEvent({ submittedBy: 'MEMBER-002' })], { authority: LEDGER_AUTHORITY });
  assert.strictEqual(impersonated.submissions.size, 0, 'Client 소유자가 아닌 명의의 제출은 채택되면 안 됩니다.');

  // ── 실제 Workspace: 에이전트도 제출한다 ────────────────────────────────────
  //
  // 이 도구의 협업 모형은 "에이전트가 쓰고 사람이 책임진다"이고 제출은 그 앞쪽이다.
  // 제출까지 사람 전용이면 관문이 아니라 병목이 된다 — 사람이 줄 세우는 일까지 한다.
  const submitted = rdl(['doc', 'submit', created.id, '--client-id', 'agent-a', '--project', 'crm', '--reason', '결정 반영분 검토 요청']);
  assert.strictEqual(submitted.created, true, '에이전트 Client도 제출할 수 있어야 합니다.');
  assert.strictEqual(submitted.document.submission.state, 'pending');
  assert.strictEqual(submitted.document.submission.submittedBy, 'MEMBER-001');
  assert.strictEqual(submitted.document.status, 'stale', '제출이 신뢰 상태를 바꾸면 안 됩니다.');
  // 사람용 번호는 원장에서 계산해 값에 실을 뿐 저장하지 않는다.
  assert.strictEqual(submitted.document.versionLabel, '1.1');
  const submittedRevision = submitted.document.revision;
  // 같은 리비전을 다시 올려도 원장이 불어나지 않는다 — 줄을 두 번 서는 일일 뿐이다.
  assert.strictEqual(rdl(['doc', 'submit', created.id, '--client-id', 'agent-a', '--project', 'crm']).created, false);
  // 문서에는 아무것도 쓰지 않는다. 썼다면 그 쓰기가 리비전을 바꿔 방금 한 제출을 무효화한다.
  assert.strictEqual(documentStatus(temporary, { project: 'crm' }).documents.find((document) => document.id === created.id).revision,
    submittedRevision, '제출이 문서 리비전을 바꾸면 안 됩니다.');

  // 승인본 ↔ 제출본. 승인자가 판정해야 하는 것은 작업본이 아니라 후보다.
  const proposed = diffSubmission(temporary, { project: 'crm', targetId: created.id });
  assert(proposed.approvedCommit, `승인본을 담은 커밋을 찾아야 합니다: ${proposed.reason || '(사유 없음)'}`);
  assert(proposed.submittedCommit, `제출본을 담은 커밋을 찾아야 합니다: ${proposed.reason || '(사유 없음)'}`);
  assert.notStrictEqual(proposed.approvedCommit, proposed.submittedCommit);
  assert(proposed.diff && proposed.diff.includes('승인 이후 추가된 문장'), `승인본과 제출본의 차이가 실제 git diff로 나와야 합니다: ${String(proposed.diff).slice(0, 200)}`);

  // 기존 축은 그대로다 — 더한 것이지 바꾼 것이 아니다.
  const sinceApproval = diffSinceApproval(temporary, { project: 'crm', targetId: created.id });
  assert.strictEqual(sinceApproval.baseCommit, proposed.approvedCommit);
  assert.strictEqual(sinceApproval.status, 'stale');

  // 제출 뒤 또 고치면 판이 흔들린 것이 상태로 드러난다. 승인자가 볼 것과 지금 파일이
  // 다르다는 뜻이고, 이 사실을 드러내는 값이 여태 아무 데도 없었다.
  fs.appendFileSync(documentFile, '\n제출 이후 또 고친 문장입니다.\n', 'utf8');
  const drifted = rdl(['doc', 'status', '--project', 'crm']).documents.find((document) => document.id === created.id);
  assert.strictEqual(drifted.status, 'stale', '제출 축이 신뢰 상태를 건드리면 안 됩니다.');
  assert.strictEqual(drifted.submission.state, 'drifted', '제출 후 고치면 판이 흔들린 것이 드러나야 합니다.');
  assert.strictEqual(drifted.submission.revision, submittedRevision, '흔들려도 무엇이 제출됐던 것인지는 남아야 합니다.');

  // 제출본이 커밋되지 않았으면 지어내지 않고 이유를 낸다. 이것은 결함이 아니라
  // 관문의 정의다 — 유동적인 작업본은 다음 순간 달라질 수 있어 승인의 근거가 못 된다.
  const resubmitted = rdl(['doc', 'submit', created.id, '--client-id', 'agent-a', '--project', 'crm']);
  assert.strictEqual(resubmitted.created, true, '판이 흔들렸으면 다시 올릴 수 있어야 합니다.');
  assert.strictEqual(resubmitted.document.versionLabel, '1.2');
  const uncommitted = rdl(['doc', 'diff', created.id, '--proposed', '--project', 'crm']);
  assert.strictEqual(uncommitted.diff, null, '커밋되지 않은 제출본으로 차분을 지어내면 안 됩니다.');
  assert(/커밋/u.test(uncommitted.reason || ''), `커밋이 없다는 사실이 이유에 드러나야 합니다: ${uncommitted.reason}`);
  assert.strictEqual(uncommitted.submittedCommit, null);
  assert(uncommitted.approvedCommit, '승인본은 여전히 찾을 수 있어야 합니다.');

  // 커밋하면 같은 명령이 실제 차분을 낸다.
  command('git', ['add', '-A'], projectRoot);
  command('git', ['commit', '-m', 'edit after submission'], projectRoot);
  const recommitted = rdl(['doc', 'diff', created.id, '--proposed', '--project', 'crm']);
  assert(recommitted.diff && recommitted.diff.includes('제출 이후 또 고친 문장'), `커밋된 제출본은 차분이 나와야 합니다: ${String(recommitted.diff).slice(0, 200)}`);

  // 상태별로 골라 볼 수 있어야 검토 인박스가 성립한다.
  const pendingOnly = rdl(['doc', 'status', '--project', 'crm', '--submission', 'pending']);
  assert.strictEqual(pendingOnly.submissionCounts.pending, 1);
  assert.strictEqual(pendingOnly.submissionCounts.none, pendingOnly.total - 1, '제출 축의 0도 세어야 "쓰지 않는 프로젝트"와 구분된다.');
  assert(pendingOnly.documents.every((document) => document.submission.state === 'pending'));

  // 승인하면 줄에 서 있던 것이 판정을 받는다.
  const settled = approveDocument(temporary, { project: 'crm', clientId: 'agent-a', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }] });
  assert.strictEqual(settled.document.status, 'approved');
  assert.strictEqual(settled.document.submission.state, 'settled');
  assert.strictEqual(settled.document.versionLabel, '2.0', '승인이 큰 자리를 올리고 작은 자리를 되돌린다.');
  // 이미 승인된 리비전은 올릴 것이 없다.
  assert.strictEqual(submitDocument(temporary, { project: 'crm', clientId: 'agent-a', targetId: created.id }).created, false);

  // 이력에도 제출이 실린다 — git은 무엇이 언제, 원장은 누가 왜 올렸는지를 안다.
  const submissionHistory = documentHistory(temporary, { project: 'crm', targetId: created.id });
  assert.strictEqual(submissionHistory.submissions.length, 2);
  assert.strictEqual(submissionHistory.submissions[0].reason, '결정 반영분 검토 요청');
  assert.strictEqual(submissionHistory.submissions[0].submittedBy, 'MEMBER-001');

  // 읽기 헬퍼는 접힌 원장만 낸다. 이것이 없어서 다른 갈래가 원장 경로와 인가 조립을
  // 자기 파일에 복사했고, 그 사본이 갈리는 날 승인 사유가 조용히 사라진다.
  const ledger = documentApprovals(temporary, { project: 'crm' });
  assert.strictEqual(ledger.project, 'crm');
  assert.strictEqual(ledger.approvals.get(created.id).length, 2);
  assert.strictEqual(ledger.submissions.get(created.id).length, 2);
  assert.strictEqual(ledger.approvals.get(created.id)[0].reason, '범위와 결정을 확인함');

  // 제출도 원장 검증을 지난다. 봉투 다이제스트를 손보면 검사가 그것을 잡는다.
  const shardDirectory = path.join(temporary, 'projects', 'workspace', 'events', 'approval');
  const shard = path.join(shardDirectory, fs.readdirSync(shardDirectory)[0]);
  const original = fs.readFileSync(shard, 'utf8');
  const tampered = original.split(/\r?\n/u).filter(Boolean).map((line) => {
    const event = JSON.parse(line);
    // 제출 사유만 바꾼다. 다이제스트는 그대로 두므로 canonical projection과 어긋난다.
    return JSON.stringify(event.type === 'approval.submitted' ? Object.assign({}, event, { reason: '바꿔치기한 사유' }) : event);
  }).join('\n');
  fs.writeFileSync(shard, `${tampered}\n`, 'utf8');
  const tamperedCheck = require('../src/check').checkWorkspace(temporary, { project: 'crm' });
  assert(tamperedCheck.diagnostics.some((item) => item.code === 'RDL-APPROVE-014'),
    `위조된 제출은 원장 검증에서 걸려야 합니다: ${JSON.stringify(tamperedCheck.diagnostics.slice(0, 5))}`);
  fs.writeFileSync(shard, original, 'utf8');
  assert.strictEqual(rdl(['check']).summary.errors, 0, '되돌린 원장은 다시 깨끗해야 합니다.');

  process.stdout.write('approval tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
