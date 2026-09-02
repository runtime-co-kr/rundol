'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeApprovalEvent, foldApprovals, trustState, documentStatus, approveDocument, documentHistory, diffSinceApproval } = require('../src/approval');

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

  process.stdout.write('approval tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
