'use strict';

// 할당 발급과 보고 저장의 시험. TST-020(발급), TST-021(보고 제출),
// TST-022(검수 판정)의 계약을 담는다.
//
// 순수 판정부터 잰다. 발급 거부 코드의 순서와 원장 접기가 파일 시스템 없이
// 고정되어야, 저장 경로가 붙은 뒤에도 판정이 저장의 사정에 끌려가지 않는다.

const assert = require('assert');
const { composeAssignment, orderWorkEvents, foldAssignments } = require('../src/worker-contract');

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

function request(overrides) {
  return Object.assign({
    goal: '할당 발급 경로를 세운다',
    acceptance: [{ id: 'AC-001', text: '발급이 원장에 남는다' }],
    functionIds: ['WRK-01'],
    allowedPaths: ['src/assignment/**'],
    forbidden: [],
    procedure: { name: 'impl', revision: 3 },
    reportSchema: 'report-v1',
    assignee: { kind: 'agent', id: 'claude-code' }
  }, overrides);
}

const PINNED = { name: 'impl', revision: 3, digest: DIGEST };
const CONTEXT = { declaredFunctionIds: ['WRK-01', 'WRK-02'], openAssignments: [] };

// ── 1. 발급 거부 코드의 순서 (순수, 파일 없음) ───────────────────────────
// 다섯 코드가 서로 다르게 도달 가능해야 통제자가 무엇을 고쳐야 하는지 안다.
// 하나로 뭉개면 "발급이 안 된다"만 남고 이유가 사라진다.

// 기능 ID만 빠진 것은 다른 누락과 구분한다. REQ-048이 근거 없는 작업을 만들지
// 않는다는 목적으로 그 규칙을 따로 두었기 때문이다.
const onlyFunctionIds = composeAssignment(request({ functionIds: [] }), PINNED, CONTEXT);
assert.strictEqual(onlyFunctionIds.code, 'missing-function-id');
assert.deepStrictEqual(onlyFunctionIds.missing, ['functionIds']);

// 누락이 여럿이면 전부 열거한다. 첫 항목에서 멈추면 워커가 왕복을 여러 번 한다.
const several = composeAssignment(request({ goal: '', acceptance: [], functionIds: [] }), PINNED, CONTEXT);
assert.strictEqual(several.code, 'missing-field');
assert.deepStrictEqual(several.missing, ['goal', 'acceptance', 'functionIds']);

// 정규 문서가 선언하지 않은 기능 ID는 근거가 없다.
const unknown = composeAssignment(request({ functionIds: ['WRK-01', 'WRK-99'] }), PINNED, CONTEXT);
assert.strictEqual(unknown.code, 'unknown-function-id');
assert.deepStrictEqual(unknown.unknownFunctionIds, ['WRK-99']);

// 절차를 다이제스트로 고정하지 못하면 워커가 무엇을 따랐는지 나중에 말할 수 없다.
for (const pinned of [null, { name: 'impl', revision: 3, digest: '' }, { name: '', revision: 3, digest: DIGEST }]) {
  assert.strictEqual(composeAssignment(request(), pinned, CONTEXT).code, 'procedure-unpinnable');
}

// 겹침은 어느 할당과 어느 경로에서 겹쳤는지까지 돌려준다. 하나만 알려주면
// 어디까지 좁혀야 통과하는지 알 수 없다.
const overlapping = composeAssignment(request(), PINNED, {
  declaredFunctionIds: ['WRK-01'],
  openAssignments: [{ id: 'ASG-EXIST01', state: 'open', allowedPaths: ['src/assignment/**'] }]
});
assert.strictEqual(overlapping.code, 'path-overlap');
assert.deepStrictEqual(overlapping.overlaps, [{ assignmentId: 'ASG-EXIST01', paths: ['src/assignment/**'] }]);

// 다섯 코드가 서로 다르다 — TST-020 통과 기준이 요구하는 그것.
const codes = new Set([onlyFunctionIds.code, several.code, unknown.code, 'procedure-unpinnable', overlapping.code]);
assert.strictEqual(codes.size, 5, '다섯 거부 사유가 서로 구분된다');

// 닫힌 할당은 겹침의 대상이 아니다. 취소한 뒤 같은 경로로 다시 발급할 수 있어야 한다.
const afterCancel = composeAssignment(request(), PINNED, {
  declaredFunctionIds: ['WRK-01'],
  openAssignments: [{ id: 'ASG-EXIST01', state: 'closed', allowedPaths: ['src/assignment/**'] }]
});
assert.ok(!afterCancel.code, '닫힌 할당은 재발급을 막지 않는다');

// 통과한 요청은 저장할 본문이 된다. 식별자와 발급 시각은 본문이 아니다 —
// 저장의 사실이지 판정의 입력이 아니므로, 같은 요청이 언제나 같은 바이트를 낸다.
const composed = composeAssignment(request(), PINNED, CONTEXT);
assert.ok(!composed.code, '거부 사유가 없다');
assert.strictEqual(composed.procedure.digest, DIGEST, '절차가 다이제스트로 고정된다');
assert.deepStrictEqual(Object.keys(composed).sort(), ['acceptance', 'allowedPaths', 'assignee', 'forbidden', 'functionIds', 'goal', 'procedure', 'reportSchema'].sort());
assert.deepStrictEqual(composeAssignment(request(), PINNED, CONTEXT), composed, '같은 요청은 같은 본문을 낸다');

// ── 2. 원장 접기 (순수, 파일 없음) ───────────────────────────────────────

function issued(overrides) {
  return Object.assign({
    schemaVersion: 1, eventId: 'EVT-01', type: 'assignment.issued', clientId: 'agent-a',
    projectId: 'memo', recordedAt: '2026-08-21T00:00:00.000Z',
    assignmentId: 'ASG-AAAA0001', issuedBy: { kind: 'human', id: 'MEMBER-001' }, taskId: null,
    goal: '할당 발급 경로를 세운다',
    acceptance: [{ id: 'AC-001', text: '발급이 원장에 남는다' }],
    functionIds: ['WRK-01'], allowedPaths: ['src/assignment/**'], forbidden: [],
    procedure: { name: 'impl', revision: 3, digest: DIGEST },
    reportSchema: 'report-v1', assignee: { kind: 'agent', id: 'claude-code' }
  }, overrides);
}

function submitted(reportId, at, overrides) {
  return {
    schemaVersion: 1, eventId: 'EVT-' + reportId, type: 'report.submitted', clientId: 'agent-a',
    projectId: 'memo', recordedAt: at, assignmentId: 'ASG-AAAA0001', reportId,
    report: Object.assign({
      id: reportId, assignmentId: 'ASG-AAAA0001', worker: { kind: 'agent', id: 'claude-code' },
      schema: 'report-v1', outcome: 'done',
      claims: [{ id: 'AC-001', met: true, evidence: 'test:assignment.test.js' }],
      changed: ['src/assignment/index.js'], procedureDigest: DIGEST
    }, overrides || {})
  };
}

// 순서의 정본이 필요하다. 두 클라이언트의 조각이 임의 순서로 병합되기 때문이다.
const shuffled = orderWorkEvents([
  { eventId: 'EVT-B', recordedAt: '2026-08-21T00:00:02.000Z' },
  { eventId: 'EVT-A', recordedAt: '2026-08-21T00:00:01.000Z' },
  { eventId: 'EVT-C', recordedAt: '2026-08-21T00:00:01.000Z' }
]);
assert.deepStrictEqual(shuffled.map((item) => item.eventId), ['EVT-A', 'EVT-C', 'EVT-B'], '같은 시각은 eventId로 가른다');

const open = foldAssignments([issued()]);
assert.strictEqual(open.assignments.length, 1);
assert.strictEqual(open.assignments[0].state, 'open');
assert.strictEqual(open.assignments[0].taskId, null);

for (const reason of ['verified', 'cancelled']) {
  const closed = foldAssignments([
    issued(),
    { schemaVersion: 1, eventId: 'EVT-02', type: 'assignment.closed', clientId: 'agent-a', projectId: 'memo', recordedAt: '2026-08-21T00:00:05.000Z', assignmentId: 'ASG-AAAA0001', reason, detail: '', closedBy: { kind: 'human', id: 'MEMBER-001' } }
  ]);
  assert.strictEqual(closed.assignments[0].state, 'closed');
  assert.strictEqual(closed.assignments[0].closedReason, reason);
}

// 보고 둘이면 앞의 것이 대체 표시를 받되 사라지지 않는다. 추가 전용 원장에서
// 지난 사건을 고칠 수 없으므로 대체는 계산으로만 표현된다.
const twoReports = foldAssignments([
  issued(),
  submitted('RPT-AAAA0001', '2026-08-21T00:00:02.000Z'),
  submitted('RPT-AAAA0002', '2026-08-21T00:00:03.000Z')
]);
const reports = twoReports.assignments[0].reports;
assert.strictEqual(reports.length, 2, '대체된 보고도 기록에 남는다');
assert.strictEqual(reports[0].supersededBy, 'RPT-AAAA0002');
assert.strictEqual(reports[1].supersededBy, null);

// 절차 일치는 저장이 아니라 계산에서 나온다. 두 다이제스트가 모두 불변이므로
// 저장하면 입력은 틀릴 수 없는데 저장된 값만 틀릴 수 있는 상태가 생긴다.
assert.strictEqual(reports[0].procedureMatched, true);
const mismatched = foldAssignments([issued(), submitted('RPT-AAAA0003', '2026-08-21T00:00:02.000Z', { procedureDigest: OTHER_DIGEST })]);
assert.strictEqual(mismatched.assignments[0].reports[0].procedureMatched, false);

// 거부는 기록되지만 상태를 만들지 않는다. assignmentId가 없는 것이 그 사실의
// 표현이며, 그래서 부분 발급이 남지 않는다.
const rejected = foldAssignments([
  { schemaVersion: 1, eventId: 'EVT-09', type: 'assignment.rejected', clientId: 'agent-a', projectId: 'memo', recordedAt: '2026-08-21T00:00:01.000Z', code: 'path-overlap', missing: [], unknownFunctionIds: [], overlaps: [{ assignmentId: 'ASG-AAAA0001', paths: ['src/assignment/**'] }], requestedBy: { kind: 'human', id: 'MEMBER-001' }, summary: { goal: '겹치는 요청', functionIds: ['WRK-01'], allowedPaths: ['src/assignment/**'] } }
]);
assert.strictEqual(rejected.assignments.length, 0, '거부된 발급은 할당을 만들지 않는다');
assert.strictEqual(rejected.rejections.length, 1, '거부는 침묵하지 않는다');

// 조각 하나가 깨져도 나머지는 접힌다. 던지면 깨진 조각 하나가 프로젝트 전체
// 목록을 감추고, 그 사실을 아무도 모른다.
const damaged = foldAssignments([
  issued(),
  { schemaVersion: 1, eventId: 'EVT-99', type: 'report.submitted', clientId: 'agent-a', projectId: 'memo', recordedAt: '2026-08-21T00:00:04.000Z', assignmentId: 'ASG-NOSUCH01', reportId: 'RPT-X', report: {} },
  { schemaVersion: 1, eventId: 'EVT-98', type: 'nonsense', clientId: 'agent-a', projectId: 'memo', recordedAt: '2026-08-21T00:00:05.000Z' }
]);
assert.strictEqual(damaged.assignments.length, 1, '깨진 조각이 나머지를 감추지 않는다');
assert.strictEqual(damaged.diagnostics.length, 2, '깨진 조각은 진단 한 줄씩으로 드러난다');

// ── 3. 저장 왕복 (실제 작업공간) ─────────────────────────────────────────
// 순수 판정이 값으로 고정됐으니 이제 저장이 그 판정을 실제로 부르는지 잰다.
// 흉내낸 원장으로는 봉투·다이제스트·샤드 이름이 맞는지 알 수 없다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-assignment-'));

function command(program, args) {
  const result = spawnSync(program, args, { cwd: temporary, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json'])));
}

try {
  const bare = path.join(temporary, 'origin.git');
  command('git', ['init', '--bare', '--initial-branch=main', bare]);
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  command('git', ['remote', 'add', 'origin', bare]);
  command('git', ['push', 'origin', 'main']);
  rdl(['init', 'memo', '--name', '메모', '--profile', 'lean']);
  rdl(['client', 'register', 'boss-a', '--name', '통제자', '--type', 'human', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'agent-a', '--name', '워커', '--type', 'agent', '--owner', 'MEMBER-001']);
  rdl(['doc', 'create', 'PRD', '메모 제품 요구사항', '--project', 'memo', '--owner', 'MEMBER-001',
    '--scope', '메모 제품의 사용자 문제와 성공 기준', '--exclude', '개별 메모 작성 동작']);
  rdl(['doc', 'create', 'REQ', '메모 검색', '--project', 'memo', '--owner', 'MEMBER-001',
    '--scope', '저장된 메모를 조건으로 검색하는 동작', '--exclude', '메모 작성과 색인 구축',
    '--function-id', 'WRK-01', '--related', 'PRD-001']);
  const task = rdl(['task', 'add', '검색 구현', '--project', 'memo', '--acceptance', '제목으로 찾는다', '--owner', 'MEMBER-001']);

  const store = require('../src/assignment');
  const base = {
    project: 'memo', clientId: 'boss-a', assigneeClientId: 'agent-a', taskId: task.taskId,
    goal: '검색을 구현한다',
    acceptance: [{ id: 'AC-001', text: '제목으로 찾는다' }],
    functionIds: ['WRK-01'], allowedPaths: ['src/search/**'], forbidden: [],
    procedureName: 'document.authored', procedureRevision: 1, reportSchema: 'report-v1'
  };

  const issued = store.issueAssignment(temporary, base);
  assert.strictEqual(issued.changed, true);
  assert.match(issued.assignmentId, /^ASG-[A-Z0-9]{8}$/u, '워커가 손으로 칠 수 있는 짧은 식별자다');
  assert.strictEqual(issued.assignment.procedure.digest.length, 64, '절차가 다이제스트로 고정된다');

  // 워커 신원은 등록된 Client 유형에서 파생한다. 주장하게 두면 에이전트가 사람이라고
  // 적을 수 있고, ADR-020이 막으려 한 순환이 열린다.
  assert.deepStrictEqual(issued.assignment.assignee, { kind: 'agent', id: 'agent-a' });
  assert.deepStrictEqual(issued.assignment.issuedBy, { kind: 'human', id: 'MEMBER-001' });

  // 겹치는 발급은 거부되고 어느 할당의 어느 경로와 겹쳤는지까지 돌려준다.
  const overlap = store.issueAssignment(temporary, base);
  assert.strictEqual(overlap.changed, false);
  assert.strictEqual(overlap.rejected.code, 'path-overlap');
  assert.deepStrictEqual(overlap.rejected.overlaps, [{ assignmentId: issued.assignmentId, paths: ['src/search/**'] }]);

  // 거부는 기록되지만 할당을 만들지 않는다. 부분 발급이 남으면 실패다.
  assert.strictEqual(store.readAssignments(temporary, 'memo').assignments.length, 1, '거부가 할당을 만들지 않는다');
  assert.strictEqual(store.readAssignments(temporary, 'memo').rejections.length, 1, '거부는 침묵하지 않는다');

  const submit = (overrides) => store.submitReport(temporary, Object.assign({
    project: 'memo', clientId: 'agent-a', assignmentId: issued.assignmentId,
    schema: 'report-v1', outcome: 'done',
    claims: [{ id: 'AC-001', met: true, evidence: 'test:assignment.test.js' }],
    changed: ['src/search/index.js'], procedureDigest: issued.assignment.procedure.digest
  }, overrides || {}));

  // 접수 거부는 판정부가 낸다. 저장 경로가 판정을 다시 쓰면 표면마다 답이 갈린다.
  assert.strictEqual(submit({ clientId: 'boss-a' }).rejected.code, 'not-assignee');
  assert.strictEqual(submit({ schema: 'other-v9' }).rejected.code, 'schema-mismatch');
  assert.strictEqual(submit({ outcome: 'blocked' }).rejected.code, 'missing-reason');

  // 범위를 벗어난 변경은 접수는 되고 검수에서 반려된다. 접수와 검수는 다른 질문이다.
  const outOfScope = submit({ changed: ['docs/elsewhere.md'] });
  assert.strictEqual(outOfScope.changed, true, '형식을 갖춘 보고는 접수된다');
  const rejectedVerdict = store.verifyLatestReport(temporary, { project: 'memo', clientId: 'boss-a', assignmentId: issued.assignmentId });
  assert.strictEqual(rejectedVerdict.decision, 'reject');
  assert.deepStrictEqual(rejectedVerdict.blocks, [{ code: 'path-out-of-scope', target: 'docs/elsewhere.md' }]);
  assert.strictEqual(rejectedVerdict.closed, false, '반려는 할당을 닫지 않는다');

  // 고쳐 낸 보고가 통과하면 할당이 닫힌다. 통과한 일을 열어 두면 그 경로가 계속
  // 배제되어 다음 할당이 막힌다.
  const good = submit({});
  const passed = store.verifyLatestReport(temporary, { project: 'memo', clientId: 'boss-a', assignmentId: issued.assignmentId });
  assert.strictEqual(passed.decision, 'pass');
  assert.strictEqual(passed.closed, true);
  assert.strictEqual(submit({}).rejected.code, 'assignment-closed');

  // 대체된 보고는 사라지지 않는다. 추가 전용 원장이므로 대체는 계산으로 표현된다.
  const shown = store.showAssignment(temporary, { project: 'memo', assignmentId: issued.assignmentId });
  assert.strictEqual(shown.reports.length, 2, '대체된 보고도 남는다');
  assert.strictEqual(shown.reports[0].supersededBy, good.reportId);
  assert.strictEqual(shown.reports[1].supersededBy, null);
  assert.strictEqual(shown.reports[0].procedureMatched, true, '절차 일치는 계산에서 나온다');
  assert.strictEqual(shown.state, 'closed');
  assert.strictEqual(shown.closedReason, 'verified');

  // 사람 표면에 내부 어휘가 새지 않는다.
  const forbidden = ['runId', 'leaseId', 'clientId', 'schemaVersion', 'ownerToken', 'operationId'];
  const leaked = forbidden.filter((token) => JSON.stringify(shown).includes(token));
  assert.deepStrictEqual(leaked, [], `투영에 내부 어휘가 남았습니다: ${leaked.join(', ')}`);

  // 태스크 상태는 읽기 시점에 계산한다. 반려된 태스크가 할당을 닫지는 않는다 —
  // 닫음의 판정자가 셋이 되고 그중 하나가 할당을 쳐다보지도 않는 명령에 살게 된다.
  assert.deepStrictEqual(shown.task, { id: task.taskId, status: 'todo' });
  rdl(['task', 'set', task.taskId, '--project', 'memo', '--status', 'cancelled', '--reason', '범위 변경']);
  const afterCancelledTask = store.showAssignment(temporary, { project: 'memo', assignmentId: issued.assignmentId });
  assert.strictEqual(afterCancelledTask.task.status, 'cancelled', '태스크 상태가 저장이 아니라 계산에서 나온다');

  // 취소한 뒤에는 같은 경로로 다시 발급할 수 있다. 닫힌 할당은 겹침의 대상이 아니다.
  const reissued = store.issueAssignment(temporary, base);
  assert.strictEqual(reissued.changed, true, '닫힌 할당은 재발급을 막지 않는다');
  assert.notStrictEqual(reissued.assignmentId, issued.assignmentId, '식별자를 다시 쓰지 않는다');

  // 사람 워커와 에이전트 워커가 같은 접수 경로를 쓴다. 경로가 갈리면 판정도
  // 갈리고, 그 순간 두 워커는 같은 계층이 아니게 된다. 사람은 MEMBER-ID로,
  // 에이전트는 클라이언트 식별자로 식별되지만 지나는 문은 하나다.
  const humanIssued = store.issueAssignment(temporary, Object.assign({}, base, {
    assigneeClientId: 'boss-a', allowedPaths: ['docs/search/**'], goal: '검색 문서를 쓴다'
  }));
  assert.strictEqual(humanIssued.changed, true);
  assert.deepStrictEqual(humanIssued.assignment.assignee, { kind: 'human', id: 'MEMBER-001' }, '사람 워커는 MEMBER-ID로 식별된다');

  const humanReport = store.submitReport(temporary, {
    project: 'memo', clientId: 'boss-a', assignmentId: humanIssued.assignmentId,
    schema: 'report-v1', outcome: 'done',
    claims: [{ id: 'AC-001', met: true, evidence: 'docs/search/설계.md' }],
    changed: ['docs/search/설계.md'], procedureDigest: humanIssued.assignment.procedure.digest
  });
  assert.strictEqual(humanReport.changed, true, '사람 워커의 보고도 같은 경로로 접수된다');
  const humanVerdict = store.verifyLatestReport(temporary, { project: 'memo', clientId: 'boss-a', assignmentId: humanIssued.assignmentId });
  assert.strictEqual(humanVerdict.decision, 'pass', '같은 판정부가 같은 답을 낸다');
  assert.strictEqual(humanVerdict.closed, true);

  // 에이전트가 사람의 할당에 보고할 수 없다. 수임자 판정이 워커 종류를 가른다.
  const wrongKind = store.submitReport(temporary, {
    project: 'memo', clientId: 'agent-a', assignmentId: humanIssued.assignmentId,
    schema: 'report-v1', outcome: 'done',
    claims: [{ id: 'AC-001', met: true, evidence: 'x' }], changed: [],
    procedureDigest: humanIssued.assignment.procedure.digest
  });
  assert.strictEqual(wrongKind.rejected.code, 'assignment-closed', '닫힌 뒤에는 종류와 무관하게 막힌다');

  // 샤드 파일명이 event-store 계약을 따른다.
  const shardDirectory = path.join(temporary, 'projects', 'workspace', 'events', 'assignment');
  const shards = fs.readdirSync(shardDirectory);
  assert.deepStrictEqual(shards, ['assignment-memo-agent-a-000001.jsonl', 'assignment-memo-boss-a-000001.jsonl'].filter((name) => shards.includes(name)).sort(), `예상 밖 샤드: ${shards.join(', ')}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('assignment tests passed\n');
