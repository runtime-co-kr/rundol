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

// 보드 표면은 서버를 띄우므로 비동기다. 이 파일의 나머지는 동기라, 마지막에 promise를
// 내보내고 워커가 그것을 기다리게 한다(test/worker.js가 그 계약을 이미 갖고 있다).
const http = require('http');
function request(port, pathname, options) {
  const settings = Object.assign({ method: 'GET', headers: {} }, options || {});
  return new Promise((resolve, reject) => {
    // 연결을 재사용하지 않는다. 전체 스위트를 동시에 돌리면 요청 사이 간격이 서버의
    // 유휴 타임아웃을 넘고, 죽은 소켓을 재사용하면서 ECONNRESET으로 간헐 실패한다.
    const call = http.request({ hostname: '127.0.0.1', port, path: pathname, method: settings.method, headers: settings.headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    call.on('error', (error) => reject(new Error(`${settings.method} ${pathname} 실패: ${error.code || error.message}`)));
    if (settings.body) call.write(settings.body);
    call.end();
  });
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
const LEDGER_AUTHORITY = { clientOwners: [['agent-a', 'MEMBER-001'], ['desk-b', 'MEMBER-001'], ['desk-h', 'MEMBER-001'], ['agent-b', 'MEMBER-002']], members: ['MEMBER-001', 'MEMBER-002'], delegations: [] };

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
  // 승인은 사람의 것이다. 이 시험이 오래 agent-a로 승인하고 통과했는데, 그것은
  // 게이트가 옳았다는 뜻이 아니라 게이트에 시험이 없었다는 뜻이었다 — approval.js
  // 머리말이 선언한 "AI가 쓴 초안과 사람이 책임지는 정본의 경계"가 코드에 없었다.
  rdl(['client', 'register', 'desk-h', '--name', '강윤정 데스크', '--type', 'human', '--owner', 'MEMBER-001']);

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

  // 사람 게이트. 에이전트 Client는 자기가 쓴 초안을 스스로 정본으로 만들 수 없다.
  // 거절의 문장은 무엇이 걸렸는지까지 말해야 한다 — "승인할 수 없습니다"만 돌려주면
  // 유형이 문제인지 상태가 문제인지 모른 채 같은 명령을 다시 치게 된다.
  assert.throws(() => approveDocument(temporary, { project: 'crm', clientId: 'agent-a', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }] }),
    /활성 human Client만 승인할 수 있습니다.*유형이 agent/u, '에이전트 Client의 문서 승인은 거절되어야 합니다.');
  assert.throws(() => approveDocument(temporary, { project: 'crm', clientId: 'desk-h', targetId: created.id, approvedBy: 'MEMBER-404', basis: [{ kind: 'read' }] }), /등록된 멤버만/u);
  const approved = approveDocument(temporary, { project: 'crm', clientId: 'desk-h', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }], reason: '범위와 결정을 확인함' });
  assert.strictEqual(approved.document.status, 'approved');
  assert.strictEqual(approved.created, true);
  // 같은 리비전을 다시 승인해도 기록이 늘지 않는다.
  assert.strictEqual(approveDocument(temporary, { project: 'crm', clientId: 'desk-h', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }] }).created, false);
  // 비활성 human도 지나지 못한다. 자격은 유형 하나가 아니라 셋(유형·상태·멤버십)이다.
  rdl(['client', 'disable', 'desk-h']);
  assert.throws(() => approveDocument(temporary, { project: 'crm', clientId: 'desk-h', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }] }),
    /활성 human Client만 승인할 수 있습니다.*상태가 disabled/u, '비활성 human Client의 승인도 거절되어야 합니다.');
  rdl(['client', 'enable', 'desk-h']);

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
  const settled = approveDocument(temporary, { project: 'crm', clientId: 'desk-h', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }] });
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

  // 화면이 쓰는 자리도 여기서 지난다. 명령줄만 시험하면 보드가 자기 판정을 따로 갖게
  // 되고, 표면마다 판정이 갈리면 그중 느슨한 쪽이 게이트의 실제 높이가 된다.
  module.exports = boardApprovalSurface(created.id, documentFile)
    .then(() => { process.stdout.write('approval tests passed\n'); })
    .finally(cleanup);
} catch (error) {
  cleanup();
  throw error;
}

function cleanup() {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// ── 화면에서 비교하고 승인한다 ──────────────────────────────────────────────
//
// 지금까지 보드에는 문서 승인도 비교도 없었다. 검토 인박스는 목록이었고, 행을 눌러
// 도착한 문서 화면에도 승인할 자리가 없었다 — 서버에 그 엔드포인트 자체가 없었기
// 때문이다. 그래서 화면을 보던 사람은 승인할 때마다 터미널로 갈아타야 했고, 그
// 왕복이 승인을 맨 뒤로 미루는 자리였다.
// 대상은 인자로 받는다. 시험 본문의 const는 try 블록의 것이라 이 함수에서 보이지
// 않고, 보이게 하려고 밖으로 올리면 어느 값이 언제 채워지는지가 흐려진다.
async function boardApprovalSurface(documentId, documentFile) {
  const board = require('../src/board').createBoardServer(temporary, { token: 'test-session-token', project: 'crm' });
  await new Promise((resolve, reject) => {
    board.server.once('error', reject);
    board.server.listen(0, '127.0.0.1', resolve);
  });
  const port = board.server.address().port;
  const post = (pathname, payload, headers) => request(port, pathname, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-Rundol-Token': 'test-session-token' }, headers || {}),
    body: JSON.stringify(payload)
  });
  const approvePath = `/api/projects/crm/documents/${encodeURIComponent(documentId)}/approve`;
  const diffPath = `/api/projects/crm/documents/${encodeURIComponent(documentId)}/diff`;
  try {
    // 승인된 문서를 한 글자 고쳐 낡음으로 만든다. 화면이 승인하는 자리는 늘 이 상태다.
    fs.appendFileSync(documentFile, '\n화면에서 승인할 문장입니다.\n', 'utf8');

    // 승인자 목록은 서버가 낸다. 화면이 clients와 people로 이 목록을 직접 만들면 그것이
    // 자격 판정의 네 번째 표면이 되고, 화면의 판정은 아무도 시험하지 않는다.
    const snapshotValue = (await request(port, '/api/projects/crm/board-snapshot')).body;
    assert.deepStrictEqual(snapshotValue.approvers.map((client) => client.id), ['desk-h'],
      '승인 자격자만 화면에 실려야 합니다 — 에이전트 Client는 고를 수 없습니다.');
    assert(snapshotValue.approvalCatalog.basisKinds.includes('read'), '근거 목록은 서버가 실어 줍니다.');

    // 비교. 승인본 ↔ 작업본이라 방금 고친 문장이 그대로 나와야 한다.
    const diff = (await request(port, `${diffPath}?axis=since-approval`)).body;
    assert.strictEqual(diff.axis, 'since-approval');
    assert.strictEqual(diff.status, 'stale');
    assert(diff.diff && diff.diff.includes('화면에서 승인할 문장'), `승인 이후 변경분이 나와야 합니다: ${String(diff.diff).slice(0, 200)}`);
    // 제출 축도 같은 자리에서 물을 수 있어야 한다. 승인자가 판정해야 하는 것은 작업본이
    // 아니라 승인 후보이고, 그 둘이 다를 수 있다는 사실이 관문의 핵심이다.
    const proposedAxis = (await request(port, `${diffPath}?axis=submission`)).body;
    assert.strictEqual(proposedAxis.axis, 'submission');
    // 지어내지 않는다. 비교할 것이 없으면 빈 차분이 아니라 이유가 온다 — "비교 기준 없음"과
    // "바뀐 것 없음"은 다른 값이고, 앞엣것을 뒤엣것으로 그리면 사람은 안 바뀐 줄 알고 승인한다.
    assert(proposedAxis.diff || proposedAxis.reason, '차분이 없으면 이유가 있어야 합니다.');
    const unknownAxis = await request(port, `${diffPath}?axis=nonsense`);
    assert.strictEqual(unknownAxis.status, 400, '모르는 축은 서버 결함이 아니라 잘못된 요청입니다.');
    const missing = await request(port, '/api/projects/crm/documents/ADR-999/diff?axis=since-approval');
    assert.strictEqual(missing.status, 404, '없는 문서는 404입니다.');

    // 사람 게이트. 에이전트 Client는 화면으로도 지나지 못하고, 왜 못 지나는지가 답에 있어야
    // 한다 — 화면이 그 문장을 그대로 옮기므로 여기서 삼키면 화면에서도 사라진다.
    const byAgent = await post(approvePath, { clientId: 'agent-a', basis: [{ kind: 'read' }], reason: '읽었습니다' });
    assert.strictEqual(byAgent.status, 400, `에이전트 Client의 승인은 거절되어야 합니다: ${JSON.stringify(byAgent.body)}`);
    assert(/활성 human Client만 승인할 수 있습니다/u.test(byAgent.body.error), `거절 사유가 그대로 와야 합니다: ${byAgent.body.error}`);
    assert(/유형이 agent/u.test(byAgent.body.error), '무엇이 걸렸는지까지 말해야 합니다.');

    // 근거와 사유는 화면에서도 필수다. 근거가 없으면 나중에 "AI 검토가 놓쳤나 사람이
    // 건너뛰었나"를 가를 수 없고, 사유가 없으면 훑기와 판단이 같은 동작이 된다.
    assert.strictEqual((await post(approvePath, { clientId: 'desk-h', basis: [], reason: '확인' })).body.code, 'missing-basis');
    assert.strictEqual((await post(approvePath, { clientId: 'desk-h', basis: [{ kind: 'read' }] })).body.code, 'missing-reason');
    assert.strictEqual((await post(approvePath, { basis: [{ kind: 'read' }], reason: '확인' })).body.code, 'missing-approver');
    // 토큰 없는 쓰기는 이 로컬 세션의 것이 아니다.
    assert.strictEqual((await post(approvePath, { clientId: 'desk-h', basis: [{ kind: 'read' }], reason: '확인' }, { 'X-Rundol-Token': '' })).status, 403);

    // 하네스가 띄운 Board는 human 자격을 HTTP로 빌려주는 창구가 된다. 런 승인이 그것을
    // 거절하는 이유가 문서 승인에는 더 곧다 — 정본을 AI가 스스로 정본으로 만드는 자리다.
    process.env.RUNDOL_HARNESS_CHILD = '1';
    const harnessed = await post(approvePath, { clientId: 'desk-h', basis: [{ kind: 'read' }], reason: '확인' });
    delete process.env.RUNDOL_HARNESS_CHILD;
    assert.strictEqual(harnessed.status, 403, '하네스가 띄운 Board에서는 승인이 거절되어야 합니다.');
    assert.strictEqual(harnessed.body.code, 'harness-board');
    // 조회는 막지 않는다. 무엇이 막혀 있는지는 하네스도 알아야 사람에게 가져갈 수 있다.
    process.env.RUNDOL_HARNESS_CHILD = '1';
    assert.strictEqual((await request(port, `${diffPath}?axis=since-approval`)).status, 200, '하네스에서도 조회는 열려 있어야 합니다.');
    delete process.env.RUNDOL_HARNESS_CHILD;

    // human Client의 승인은 그대로 된다.
    const granted = await post(approvePath, { clientId: 'desk-h', basis: [{ kind: 'read', detail: '3장 전체 재독' }], reason: '화면에서 차분을 보고 승인함' });
    assert.strictEqual(granted.status, 200, `승인이 되어야 합니다: ${JSON.stringify(granted.body)}`);
    assert.strictEqual(granted.body.document.status, 'approved');
    assert.strictEqual(granted.body.created, true);
    // 명의는 고를 여지가 없다 — 위임이 아니면 언제나 그 Client의 소유자다.
    assert.strictEqual(granted.body.document.approvedBy, 'MEMBER-001');

    // 승인 뒤 화면이 받는 값도 새 상태여야 한다. 화면은 스냅숏을 다시 읽는 것 말고
    // 할 일이 없어야 하고, 그러려면 스냅숏이 그 사실을 이미 알고 있어야 한다.
    const after = (await request(port, '/api/projects/crm/board-snapshot')).body;
    assert.strictEqual(after.documents.find((item) => item.id === documentId).approval.status, 'approved');
    assert(!after.reviewQueue.items.some((item) => item.id === documentId), '승인한 문서는 검토 줄에서 빠져야 합니다.');
    // 원장에는 근거와 사유가 그대로 남는다. 화면으로 한 승인과 명령줄로 한 승인이
    // 같은 값을 남기지 않으면 이력은 표면마다 다른 이야기를 하게 된다.
    const recorded = documentHistory(temporary, { project: 'crm', targetId: documentId }).approvals.slice(-1)[0];
    assert.deepStrictEqual(recorded.basis, [{ kind: 'read', detail: '3장 전체 재독' }]);
    assert.strictEqual(recorded.reason, '화면에서 차분을 보고 승인함');

    // 이미 승인된 판은 다시 승인해도 원장이 늘지 않는다.
    assert.strictEqual((await post(approvePath, { clientId: 'desk-h', basis: [{ kind: 'read' }], reason: '한 번 더' })).body.created, false);
  } finally {
    await new Promise((resolve) => board.server.close(resolve));
  }
}
