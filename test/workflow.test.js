'use strict';

// 워크플로 스텝과 전환 판정. 이 갈래가 세운 것 둘을 지킨다.
//
//   1. 코드가 상태 이름을 비교하지 않는다.
//   2. 판정이 막는 규칙을 전부 돌려주고, 표면들이 같은 함수를 부른다.
//
// 둘째를 재는 방법은 12절이 반증 조건으로 적어 둔 것 그대로다 — 01절의 사건을
// 재현해서 이번엔 한 화면에 둘 다 나오는지 본다. 안 나오면 계약이 안 지켜진 것이다.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vocabulary = require('../src/vocabulary');
const workflow = require('../src/workflow');

const sourceRoot = path.resolve(__dirname, '..', 'src');

// ── 노드와 스텝 ─────────────────────────────────────────────────────────

// 어휘가 선언한 상태에는 전부 설 자리가 있어야 한다. 없으면 그 상태의 태스크는
// 어느 목록에도 들지 않고, 목록에서 빠졌다는 사실은 아무 신호도 내지 않는다.
for (const state of vocabulary.TASK_STATES) {
  const step = workflow.stepOf(state);
  assert(vocabulary.WORKFLOW_STEPS.includes(step), `${state}에 스텝이 없습니다.`);
}

// 모르는 값에는 스텝을 지어내지 않는다. 지어내면 오타 하나가 조용히 할 일이 된다.
for (const unknown of ['배포완료', 'open', '', null, undefined]) {
  assert.strictEqual(workflow.stepOf(unknown), null, `${unknown}에 스텝이 생겼습니다.`);
}

// 유효성은 completed에서만 뜻이 있다.
assert.strictEqual(workflow.validityOf('done'), 'valid');
for (const state of vocabulary.TASK_STATES) {
  if (workflow.stepOf(state) === 'completed') continue;
  assert.strictEqual(workflow.validityOf(state), null, `${state}에 유효성이 붙었습니다.`);
}

// 끝난 것과 열린 것은 서로의 여집합이다 — 노드 층에서도 그래야 한다. 갈리면
// 어떤 태스크는 끝나지도 열려 있지도 않게 된다.
for (const state of vocabulary.TASK_STATES) {
  assert.notStrictEqual(workflow.isTerminal(state), workflow.isOpen(state), `${state}가 끝난 것도 열린 것도 아닙니다.`);
}
// 붙어 있는 것은 열린 것의 부분집합이고, 아무도 안 잡은 것과 겹치지 않는다.
for (const state of vocabulary.TASK_STATES) {
  if (!workflow.isActive(state)) continue;
  assert(workflow.isOpen(state), `${state}가 붙어 있는데 열려 있지 않습니다.`);
  assert(!workflow.isUnclaimed(state), `${state}가 붙어 있는데 아무도 안 잡았습니다.`);
}

// 예전 어휘가 상태 이름으로 답하던 물음과 스텝이 답하는 물음이 같아야 한다.
// 이관이 뜻을 바꾸지 않았다는 확인이며, 갈리는 날 이 줄이 먼저 넘어진다.
assert.deepStrictEqual(
  vocabulary.TASK_STATES.filter(workflow.isTerminal).sort(),
  vocabulary.TERMINAL_TASK_STATES.slice().sort(),
  '스텝으로 센 종료 상태가 정본과 다릅니다.'
);
assert.deepStrictEqual(
  vocabulary.TASK_STATES.filter(workflow.isOpen).sort(),
  vocabulary.OPEN_TASK_STATES.slice().sort(),
  '스텝으로 센 열린 상태가 정본과 다릅니다.'
);
assert.deepStrictEqual(
  vocabulary.TASK_STATES.filter(workflow.isActive).sort(),
  vocabulary.ACTIVE_TASK_STATES.slice().sort(),
  '스텝으로 센 활성 상태가 정본과 다릅니다.'
);

// 담당자를 요구하는 노드. 이관 전 규칙이 손으로 적고 있던 넷 그대로여야 한다.
// 이 갈래가 하는 일은 상태 문자열을 걷어내는 것이지 규칙을 넓히는 것이 아니다.
// 넓히는 것은 값을 고치는 별도의 결정이고, 두 일이 한 커밋에 섞이면 나중에
// 무엇이 어느 쪽 때문에 바뀌었는지 답할 수 없다.
//
// waiting이 빠져 있는 것이 눈에 띈다. 아무도 안 잡은 일이 바깥 사정에 막혀 있는
// 경우가 그것이고, 그것이 오류인지 아닌지는 이 시험이 답하지 않는다 — 답을 바꾸려는
// 사람이 이 줄을 먼저 만나게 하는 것이 여기서 할 수 있는 일이다.
assert.deepStrictEqual(
  Object.keys(workflow.TASK_NODES).filter((node) => workflow.TASK_NODES[node].requiresOwner).sort(),
  ['cancelled', 'doing', 'done', 'review'],
  '담당자를 요구하는 노드가 이관 전과 다릅니다.'
);

// 아직 어느 절도 정하지 않은 매핑이 있다. 0건이라 미뤄 둔 것이고, 미뤘다는 사실이
// 값에 남아 있어야 나중에 "누가 정했는지 모르지만 원래 이랬다"가 되지 않는다.
const unratified = Object.keys(workflow.TASK_NODES).filter((node) => !workflow.TASK_NODES[node].ratified);
assert.deepStrictEqual(unratified.sort(), ['review', 'waiting'], '비준되지 않은 매핑 목록이 달라졌습니다.');

// ── 묶음 롤업 ───────────────────────────────────────────────────────────

// 가장 덜 진행된 것이 묶음을 정한다.
assert.strictEqual(workflow.rollupNodes(['done', 'todo']).step, 'unclaimed');
assert.strictEqual(workflow.rollupNodes(['done', 'doing']).step, 'in-progress');
assert.strictEqual(workflow.rollupNodes(['done', 'review']).step, 'in-approval');
assert.strictEqual(workflow.rollupNodes(['done', 'done']).step, 'completed');
assert.strictEqual(workflow.rollupNodes([]).step, null);

// 성취와 취소가 섞이면 답을 고르지 않는다. 예전에는 이 자리가 어휘 밖의 'open'이
// 되어 안착한 묶음이 열린 것으로 보였다.
const mixed = workflow.rollupNodes(['done', 'cancelled']);
assert.strictEqual(mixed.step, null);
assert.strictEqual(mixed.ambiguous, true);
assert.deepStrictEqual(mixed.mixed, ['completed', 'dropped']);

// 롤업이 내는 값은 전부 어휘 안이다. 지어낸 일곱 번째 값이 다시 생기지 않는다.
for (const combination of [['todo'], ['doing'], ['review'], ['done'], ['cancelled'], ['done', 'todo'], ['cancelled', 'todo']]) {
  const rolled = workflow.rollupNodes(combination);
  if (rolled.step === null) continue;
  assert(vocabulary.WORKFLOW_STEPS.includes(rolled.step), `롤업이 어휘 밖 값을 냈습니다: ${rolled.step}`);
}

// ── 판정 ────────────────────────────────────────────────────────────────

const whole = {
  id: 'TASK-ABCDEFGH',
  title: '판정 대상',
  owner: 'MEMBER-001',
  links: ['TST-001'],
  externalRefs: [{ kind: 'pr', value: 'https://example.test/pr/1' }],
  acceptanceCriteria: { 'AC-001': { text: 'x', done: true } }
};
function about(changes) {
  return Object.assign({}, whole, changes);
}
function codes(blockers) {
  return blockers.map((blocker) => blocker.code).sort();
}

// 갖춰진 항목은 어느 노드에서도 막히지 않는다.
for (const state of vocabulary.TASK_STATES) {
  const item = about({ status: state, blocker: null, cancellation: null });
  if (state === 'waiting') item.blocker = { waitingFor: 'MEMBER-001', condition: 'c', since: '2026-08-15T00:00:00.000Z' };
  if (state === 'cancelled') item.cancellation = { reason: 'r', decidedBy: 'MEMBER-001', at: '2026-08-15T00:00:00.000Z' };
  assert.deepStrictEqual(workflow.judgeItem(item, null), [], `${state}에서 갖춘 항목이 막혔습니다.`);
}

// 빈 목록이 통과다. 불리언이 아니라 목록인 것이 "전부 돌려준다"의 강제다.
assert(Array.isArray(workflow.judgeItem(about({ status: 'done' }), null)));

// ── 01절의 왕복. 12절이 반증 조건으로 적은 재현이다 ─────────────────────
//
// 태스크 열둘을 완료로 옮길 때 RDL-TASK-019가 먼저 막고, 하나를 면제하자
// RDL-IMPL-021이 다시 막았다. 두 규칙이 같은 사실에서 나오는데 한 화면에 보이지
// 않아 두 번 왕복했다. 이번엔 한 번에 다 나와야 한다.
const stuck = about({ status: 'done', owner: null, links: [], acceptanceCriteria: { 'AC-001': { text: 'x', done: false } } });
const blocked = workflow.judgeTransition('doing', 'done', stuck, null);
assert.deepStrictEqual(
  codes(blocked),
  ['RDL-TASK-007', 'RDL-TASK-018', 'RDL-TASK-019'],
  '완료로 옮길 때 막는 규칙이 한 번에 다 나오지 않습니다.'
);
// 사람이 읽는 한 덩어리에도 셋이 다 실린다. 표면이 첫 줄만 꺼내면 왕복이 돌아온다.
const report = workflow.blockerReport(blocked);
for (const code of ['RDL-TASK-007', 'RDL-TASK-018', 'RDL-TASK-019']) {
  assert(report.includes(code), `보고에 ${code}가 없습니다.`);
}

// 면제할 수 있는 게이트는 이름을 함께 말한다. 막는 말은 진단 코드로 하고 면제는 게이트
// 이름으로 받는데, 둘이 다른 어휘라 막힌 사람에게 이름을 알 길이 없었다 — RDL-TASK-019를
// 보고 done-requires-test-link를 떠올릴 근거가 아무 데도 없다.
assert(report.includes('--exempt done-requires-test-link'), '면제할 수 있는 게이트가 이름을 말하지 않습니다.');
// 면제할 수 없는 규칙은 그 말을 하지 않는다. 없는 문을 가리키면 사람은 그 문을 두드린다.
assert(!workflow.blockerReport(blocked.filter((blocker) => blocker.code === 'RDL-TASK-018')).includes('--exempt'),
  '면제 목록 밖 규칙이 면제를 권합니다.');
// 목록은 어휘가 든다. 여기서 다시 세면 코드가 목록을 좁힐 때 안내만 남아 없는 문을 가리킨다.
for (const gate of blocked.map((blocker) => blocker.ruleId).filter((ruleId) => report.includes(`--exempt ${ruleId}`))) {
  assert(vocabulary.EXEMPTABLE_GATES.includes(gate), `어휘 밖 게이트를 권합니다: ${gate}`);
}

// 막는 규칙 하나하나가 사람에게 무엇을 고쳐야 하는지 말할 수 있어야 한다.
// 말하지 못하면 표면마다 항목을 다시 뒤지게 되고, 다시 뒤진 것들은 달라진다.
for (const blocker of blocked) {
  assert(blocker.ruleId, '규칙 식별자가 없습니다.');
  assert(vocabulary.RULE_ORIGINS.includes(blocker.origin), `어휘 밖 origin입니다: ${blocker.origin}`);
  assert(vocabulary.VALIDATION_SOURCE_KINDS.includes(blocker.source), `어휘 밖 source입니다: ${blocker.source}`);
  assert(vocabulary.VALIDATION_METHODS.includes(blocker.method), `어휘 밖 method입니다: ${blocker.method}`);
  assert(String(blocker.target).startsWith('TASK-ABCDEFGH.'), `대상이 항목을 가리키지 않습니다: ${blocker.target}`);
  assert(blocker.message, '사람이 읽는 말이 없습니다.');
}

// 항상 참이어야 하는 것과 이 전환에만 걸린 것은 고치는 길이 다르다. 그 구분이
// 값으로 나와야 막힌 사람이 다른 전환으로 갈 수 있는지 알 수 있다.
const origins = {};
for (const blocker of blocked) origins[blocker.code] = blocker.origin;
assert.strictEqual(origins['RDL-TASK-007'], 'item-type');
assert.strictEqual(origins['RDL-TASK-018'], 'transition');
assert.strictEqual(origins['RDL-TASK-019'], 'transition');

// 면제된 규칙은 목록에 오지 않는다. 면제는 검증이 아니라 판정을 건너뛰는 것이다.
const exempt = about({
  status: 'done',
  links: [],
  exemption: { gates: ['done-requires-test-link'], reason: '재량 면제', decidedBy: 'MEMBER-001', at: '2026-08-15T00:00:00.000Z' }
});
assert.deepStrictEqual(codes(workflow.judgeItem(exempt, null)), [], '면제한 규칙이 여전히 막습니다.');
// 그런데 건너뛴 것이 무엇인지는 남아야 한다. 면제가 어느 규칙을 조용히 죽이고
// 있는지가 여기서 보인다 — 침묵만 남으면 죽은 규칙과 구분되지 않는다.
const skipped = workflow.exemptedRules('done', exempt);
assert.deepStrictEqual(skipped.map((entry) => entry.ruleId), ['done-requires-test-link']);
assert.strictEqual(skipped[0].reason, '재량 면제');
assert.strictEqual(skipped[0].decidedBy, 'MEMBER-001');

// 사유 없는 면제는 면제가 아니다. 받아 주면 면제가 조용한 우회가 된다.
const reasonless = about({ status: 'done', links: [], exemption: { gates: ['done-requires-test-link'] } });
assert.deepStrictEqual(codes(workflow.judgeItem(reasonless, null)), ['RDL-TASK-019']);

// 이번 판정이 실제로 본 규칙이 남아야 한다. 막은 것만 적으면 "한 번도 안 막은
// 규칙"과 "한 번도 안 불린 규칙"이 같은 침묵이 되고, 그 둘은 정반대의 뜻이다.
const evaluated = workflow.evaluatedRules('done');
assert(evaluated.includes('done-requires-test-link'));
assert(evaluated.includes('completion-requires-acceptance'));
assert(!evaluated.includes('waiting-requires-blocker'), '대기 규칙이 완료에서 평가됩니다.');

// 모르는 노드는 아무것도 평가하지 않는다. 지어낸 규칙으로 막으면 그 항목은
// 고칠 방법이 없다.
assert.deepStrictEqual(workflow.judgeTransition('doing', '배포완료', whole, null), []);

// ── 파일도 시계도 읽지 않는다 ───────────────────────────────────────────
//
// 계약이 정한 것이고, 인자에 시계가 없는 것이 그 강제다. 같은 입력에 같은 답이
// 나오지 않으면 막힌 사람에게 무엇을 고쳐야 하는지 말해 줄 수 없다.
// 판정부의 폐포. 목록 하나로 못박지 않고 전이 의존을 따라가는 이유는 목록만 짧고
// 폐포는 저장 계층에 닿는 모양이 실제로 있었기 때문이다 — 겉으로 순수해 보이는 모듈이
// 작업공간 모듈을 타고 파일 시스템에 닿았다. 여기 이름을 올리는 것은 "이 모듈은 값만
// 보고 답한다"는 선언이고, 아래 두 물음이 그 선언을 강제한다.
const JUDGMENT_CLOSURE = ['workflow', 'validation-catalog', 'vocabulary'];
const reached = [];
for (const moduleName of JUDGMENT_CLOSURE) {
  const text = fs.readFileSync(path.join(sourceRoot, `${moduleName}.js`), 'utf8');
  for (const forbidden of ["require('fs')", "require('path')", 'Date.now(', 'new Date(']) {
    assert(!text.includes(forbidden), `판정부가 ${forbidden}을 씁니다: ${moduleName}.js`);
  }
  for (const call of text.match(/require\('([^']+)'\)/gu) || []) {
    const specifier = call.slice("require('".length, -2);
    assert(specifier.startsWith('./'), `판정부가 바깥 모듈을 뭅니다: ${moduleName} -> ${specifier}`);
    const target = specifier.slice(2);
    assert(JUDGMENT_CLOSURE.includes(target), `판정부의 전이 의존이 폐포 밖입니다: ${moduleName} -> ${target}`);
    reached.push(target);
  }
}
// 검증 슬롯의 판정기를 새로 짓지 않았는지 본다. 같은 규칙을 두 벌로 판정하면 같은
// 항목이 어디서 보느냐에 따라 다른 답을 받는다.
assert(reached.includes('validation-catalog'), '판정부가 소스 × 방법 판정기를 부르지 않습니다.');

// 같은 입력에 같은 답. 두 번 물어서 다르면 어딘가 시계나 순서를 보고 있다.
assert.deepStrictEqual(
  workflow.judgeTransition('doing', 'done', stuck, null),
  workflow.judgeTransition('doing', 'done', stuck, null),
  '같은 입력에 판정이 두 번 다르게 나옵니다.'
);

// ── 표면들이 같은 판정을 부르는가 ───────────────────────────────────────
//
// 이 설계의 전제다. 표면마다 자기 판정을 가지면 같은 저장소 상태에서 명령줄과
// 보드와 검사기가 다른 답을 내고, 사람과 에이전트는 같은 계층이 아니게 된다.
// 부른다는 사실이 아니라 답이 같다는 것을 본다 — 부르기만 하고 다르게 쓰면
// 부르는 것만으로는 아무것도 보장되지 않는다.

const { checkTaskEntries } = require('../src/check-rules');
function checkCodes(task) {
  const issues = [];
  checkTaskEntries(issues, { 'TASK-ABCDEFGH': task }, {
    taskIds: ['TASK-ABCDEFGH'], taskFile: 'tasks.json', registry: new Map(),
    memberIds: new Set(['MEMBER-001']), stakeholderIds: new Set(),
    kinds: ['normal', 'test'], results: ['pass', 'fail', 'blocked', 'skipped'],
    testedDocuments: () => [], readiness: () => []
  });
  return issues.map((item) => item.code);
}

// 검사기가 내는 코드에 판정이 막은 것이 전부 들어 있어야 한다. 검사기는 사람과
// 문서를 아는 판정을 더 얹으므로 같음이 아니라 포함이다.
const surfaceCodes = checkCodes(Object.assign({ status: 'done' }, stuck, { status: 'done' }));
for (const code of codes(blocked)) {
  assert(surfaceCodes.includes(code), `검사기가 ${code}를 내지 않습니다 — 표면이 자기 판정을 갖고 있습니다.`);
}

// 한 위반이 진단 둘로 보이면 안 된다. 이름이 붙은 게이트는 유형 해석기가 부르고
// 검사기는 같은 규칙을 다시 내지 않는다.
const once = surfaceCodes.filter((code) => code === 'RDL-TASK-019');
assert.strictEqual(once.length, 1, `RDL-TASK-019가 ${once.length}번 나옵니다.`);

// 저장 계층도 같은 카탈로그를 본다. 예전에는 저장이 blocker가 있기만 하면 받고
// 검사가 세 부분을 요구해서, 저장을 지난 값이 검사에서 막히는 틈이 있었다.
const { assertNodeConsistency } = require('../src/tasks');
assert.throws(
  () => assertNodeConsistency({ status: 'todo', blocker: null }, { status: 'waiting', blocker: { waitingFor: 'MEMBER-001' } }),
  /RDL-TASK-014/u,
  '저장 계층이 갖춰지지 않은 blocker를 받습니다.'
);
// 저장이 던지는 말에도 막는 것이 전부 실린다.
try {
  assertNodeConsistency(null, { status: 'cancelled', owner: null, blocker: { waitingFor: 'MEMBER-001' } });
  assert.fail('막혀야 하는 저장이 통과했습니다.');
} catch (error) {
  for (const code of ['RDL-TASK-007', 'RDL-TASK-015', 'RDL-TASK-023']) {
    assert(error.message.includes(code), `저장의 오류에 ${code}가 없습니다: ${error.message}`);
  }
  // Board가 400으로 돌려줄 근거를 잃지 않아야 한다. 잃으면 잘못된 입력이 전부 500이 된다.
  assert.strictEqual(error.statusCode, 400);
}

// ── 화면이 읽을 수 있는 모양인가 ────────────────────────────────────────
//
// 보드 화면은 브라우저에서 그대로 돌아 require를 쓸 수 없다. 서버가 실어 주는
// 값만으로 스텝과 요구 필드를 가를 수 있어야 한다.
const view = workflow.taskWorkflowView();
assert.deepStrictEqual(Object.keys(view.nodes).sort(), vocabulary.TASK_STATES.slice().sort());
assert.deepStrictEqual(view.steps, vocabulary.WORKFLOW_STEPS.slice());
assert.deepStrictEqual(view.terminalSteps, vocabulary.TERMINAL_WORKFLOW_STEPS.slice());
assert.deepStrictEqual(view.nodes.waiting.requires, ['blocker']);
assert.deepStrictEqual(view.nodes.cancelled.requires, ['cancellation']);
assert.deepStrictEqual(view.nodes.todo.requires, []);
// 실어 보내는 값이 JSON을 지나도 그대로여야 한다. 스냅숏은 직렬화되어 간다.
assert.deepStrictEqual(JSON.parse(JSON.stringify(view)), view, '워크플로가 직렬화를 지나며 달라집니다.');

// ── 담당 파일에 상태 문자열 비교가 남지 않았는가 ────────────────────────
//
// 12절이 적은 반증 조건 첫째다. "이관 후에도 남아 있으면 규칙이 데이터로 안 나간
// 것이다 — 표만 바뀐 것이다." 그래서 세는 일을 사람 손에 두지 않는다.
//
// 남겨 둔 자리는 이유와 함께 적는다. 이유 없이 면제하면 다음 사람이 그 자리에
// 하나를 더 얹고, 목록은 그때부터 아무것도 막지 않는다.
const ALLOWED = new Map([
  // 프로세스 종료 범주다. 태스크 상태가 아니라 자식 프로세스가 어떻게 끝났는가이며,
  // 02절이 오탐 둘로 센 자리 그대로다.
  ['src/adapter.js', 1],
  // 판정 대상의 진행이 아니라 실행 결과의 이름이다. 위와 같은 범주다.
  ['src/run.js', 1],
  // 정본이 자기 목록을 좁히는 자리다. 어휘가 어휘를 참조하는 것은 사본이 아니다.
  ['src/vocabulary.js', 1],
  // 옛 상태 이름을 읽는 것이 그 파일의 일이다. 아직 안 옮겨진 데이터를 세는 자리라
  // 여기서 스텝으로 물으면 옮길 것이 남았는지를 물을 수 없게 된다.
  ['src/migration-audit.js', 3],
  // --outcome의 값 목록이다. done · blocked · rejected는 런이 어떻게 끝났는가이고
  // 태스크의 진행이 아니다. 글자 하나가 겹칠 뿐 다른 축이다.
  ['bin/rdl.js', 1]
]);

const TASK_STATE_LITERALS = vocabulary.TASK_STATES.map((state) => `'${state}'`);

// 긴 연산자를 먼저 자국으로 바꾼다. 그러지 않으면 ==가 === 안에서 또 걸려 한 자리가
// 두 번 세어지고, 부풀린 수는 줄어드는 것을 못 보게 한다.
function markOperators(line) {
  return line.split('===').join('').split('!==').join('').split('==').join('').split('!=').join('');
}

// 목록 소속으로 묻는 자리. 대괄호 안에 상태 리터럴이 든 채로 includes를 부르는
// 것만 센다. 줄 전체에서 찾으면 (task.reviewers || []).includes(...) 같은 자리가
// 같은 줄에 있다는 이유만으로 걸린다.
function listMemberships(line) {
  let found = 0;
  for (const call of ['].includes(', '].indexOf(']) {
    let at = line.indexOf(call);
    while (at >= 0) {
      const opened = line.lastIndexOf('[', at);
      const inside = opened >= 0 ? line.slice(opened, at) : '';
      if (TASK_STATE_LITERALS.some((literal) => inside.includes(literal))) found += 1;
      at = line.indexOf(call, at + 1);
    }
  }
  return found;
}

// 화면 이름과 상태 이름이 우연히 같은 글자를 쓴다. state.taskScope === 'review'는
// 어느 화면을 보고 있는가이지 태스크가 어디 서 있는가가 아니다. 글자가 같다는
// 이유로 세면 이 시험은 고칠 수 없는 것을 고치라고 말하게 된다.
//
// 왼쪽이 무엇인지로 가른다. 세는 자리를 지우는 것이 아니라 다른 축을 빼는 것이므로,
// 빼는 이름을 목록으로 두어 늘어나는 것이 보이게 한다.
const VIEW_OPERANDS = ['view', 'taskScope'];
function stripViewComparisons(line) {
  let stripped = line;
  for (const operand of VIEW_OPERANDS) {
    for (const operator of ['===', '!==']) {
      const mark = `${operand} ${operator} '`;
      let at = stripped.indexOf(mark);
      while (at >= 0) {
        const closing = stripped.indexOf(`'`, at + mark.length);
        if (closing < 0) break;
        stripped = stripped.slice(0, at) + stripped.slice(closing + 1);
        at = stripped.indexOf(mark);
      }
    }
  }
  return stripped;
}

function stateComparisons(line) {
  const marked = markOperators(stripViewComparisons(line));
  let found = 0;
  for (const literal of TASK_STATE_LITERALS) {
    // 양쪽 다 본다. 한쪽만 보면 리터럴을 왼쪽에 두는 것만으로 빠져나간다.
    found += marked.split(` ${literal}`).length - 1;
    found += marked.split(`${literal} `).length - 1;
  }
  return found + listMemberships(line);
}

function sourceFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.(js|mjs)$/u.test(entry.name)) found.push(full);
  }
  return found;
}

const counted = new Map();
for (const file of sourceFiles(sourceRoot).concat([path.resolve(__dirname, '..', 'bin', 'rdl.js')])) {
  const relative = path.relative(path.dirname(sourceRoot), file).replace(/\\/gu, '/');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const hits = stateComparisons(line);
    if (hits) counted.set(relative, (counted.get(relative) || 0) + hits);
  }
}

const unexpected = [];
for (const [file, hits] of counted) {
  const allowed = ALLOWED.get(file) || 0;
  if (hits > allowed) unexpected.push(`  ${file}  ${hits}곳 (허용 ${allowed})`);
}
assert.deepStrictEqual(
  unexpected,
  [],
  `상태 문자열 비교가 남았습니다. 스텝으로 물으세요 — workflow.stepOf · isTerminal · isOpen · isActive.\n${unexpected.join('\n')}`
);

// 허용한 자리가 줄어도 이 목록은 그대로 남는다. 남은 목록은 "여기는 봐준다"고
// 말하므로, 사라진 자리를 계속 봐주면 다음 사람이 그 자리에 새로 적을 수 있다.
const stale = [];
for (const [file, allowed] of ALLOWED) {
  if ((counted.get(file) || 0) < allowed) stale.push(`  ${file}  허용 ${allowed}인데 실제 ${counted.get(file) || 0}`);
}
assert.deepStrictEqual(stale, [], `허용 목록이 실제보다 큽니다. 줄여 두세요.\n${stale.join('\n')}`);

// ── 승인 근거를 값으로 읽는다 ───────────────────────────────────────────
//
// 승인 슬롯은 "다른 행위자가 동의했는가"를 묻고, 그 답은 항목이 무엇을 갖췄는지로는
// 서지 않는다. 그래서 근거가 값으로 실려 와야 하고, 실려 오지 않으면 막힌 채로 둔다 —
// 없는 동의를 있는 것으로 세면 게이트가 아니라 통과 도장이 된다.
//
// 파일도 시각도 읽지 않는 것은 그대로다. 승인 기록의 정본은 원장이고 그것을 읽어 이
// 모양으로 실어 주는 것은 부른 표면의 몫이며, 위의 폐포 시험이 그 갈라섬을 지킨다.

const pass = (actor) => ({ kind: 'read', verdict: 'pass', actor, delegatedFrom: null });

assert.strictEqual(workflow.approvalShortfall({}, null), '', '근거가 없으면 덧붙일 말이 없는 모자람이다.');
assert.strictEqual(workflow.approvalShortfall({ approvals: [pass('MEMBER-002')] }, { memberId: 'MEMBER-001' }), null, '다른 행위자의 동의가 슬롯을 연다.');
assert.strictEqual(workflow.approvalShortfall({ approvals: [pass('MEMBER-002')] }, null), null, '행위자를 모르면 근거를 그대로 받는다 — 모르는 것을 같다고 세면 게이트가 다시 벽이 된다.');
assert.match(workflow.approvalShortfall({ approvals: [pass('MEMBER-001')] }, { memberId: 'MEMBER-001' }), /자기 자신/u, '자기 승인은 승인이 아니다.');
assert.strictEqual(workflow.approvalShortfall({ approvals: [pass('MEMBER-001'), pass('MEMBER-002')] }, { memberId: 'MEMBER-001' }), null, '자기 것 말고 하나라도 있으면 열린다.');

// 신원은 책임을 지는 이름에서 고른다. 승인의 책임은 멤버가 지므로 멤버가 먼저다.
assert.match(workflow.approvalShortfall({ approvals: [pass('MEMBER-001')] }, 'MEMBER-001'), /자기 자신/u, '행위자를 문자열로 넘겨도 같은 답이어야 한다.');
assert.strictEqual(workflow.approvalShortfall({ approvals: [pass('MEMBER-001')] }, { memberId: 'MEMBER-002', clientId: 'MEMBER-001' }), null, '멤버가 다르면 다른 행위자다.');

// 모양이 아닌 줄은 세지 않는다. 세면 아무 필드나 담은 객체 하나가 사람 게이트를 연다.
for (const broken of [
  { kind: '읽음', verdict: 'pass', actor: 'MEMBER-002', delegatedFrom: null },
  { kind: 'read', verdict: '통과', actor: 'MEMBER-002', delegatedFrom: null },
  { kind: 'read', verdict: 'pass', actor: '', delegatedFrom: null },
  // 위임된 근거는 누구에게서 왔는지가 근거의 일부다. 그 자리가 비면 책임이 어디로
  // 갔는지 아무도 답할 수 없고, 답할 수 없는 승인은 승인이 아니다.
  { kind: 'delegated', verdict: 'pass', actor: 'MEMBER-002', delegatedFrom: null },
  'MEMBER-002'
]) {
  assert.strictEqual(workflow.approvalShortfall({ approvals: [broken] }, null), '', `모양이 아닌 근거가 슬롯을 엽니다: ${JSON.stringify(broken)}`);
}
assert.strictEqual(
  workflow.approvalShortfall({ approvals: [{ kind: 'delegated', verdict: 'pass', actor: 'MEMBER-002', delegatedFrom: 'MEMBER-003' }] }, null),
  null,
  '위임한 사람이 적힌 근거는 선다.'
);

// 기권과 반려를 가른 것이 여기서 값이 된다 — "보지 못했다"는 아직 답이 아니지만
// "보고 아니라 했다"는 답이며, 답은 다른 동의로 덮이지 않는다.
assert.match(workflow.approvalShortfall({ approvals: [{ kind: 'read', verdict: 'abstain', actor: 'MEMBER-002', delegatedFrom: null }] }, null), /기권/u, '기권은 동의가 아니다.');
assert.match(
  workflow.approvalShortfall({ approvals: [pass('MEMBER-002'), { kind: 'verdict', verdict: 'refuted', actor: 'MEMBER-003', delegatedFrom: null }] }, null),
  /반려/u,
  '반려는 동의보다 뒤에 적혀도 이긴다.'
);

// 근거의 어휘를 새로 짓지 않았는지 본다. 전환이 자기 어휘를 세우면 같은 물음에 두 벌의
// 답이 생기고, 두 벌은 갈린다.
for (const kind of vocabulary.BASIS_KINDS) {
  const basis = { kind, verdict: 'pass', actor: 'MEMBER-002', delegatedFrom: kind === 'delegated' ? 'MEMBER-003' : null };
  assert.strictEqual(workflow.approvalShortfall({ approvals: [basis] }, null), null, `어휘가 선언한 근거 종류를 못 읽습니다: ${kind}`);
}
assert.deepStrictEqual(vocabulary.VERDICTS.slice(), ['pass', 'refuted', 'abstain'], '판정 어휘가 바뀌면 위 세 갈래를 다시 봐야 한다.');

// 설정이 없는 저장소는 그대로다. 내장 흐름에는 전환 목록이 없으므로 승인 슬롯도 없고,
// 근거를 실어도 판정이 달라지지 않는다 — 달라지면 그것은 기능이 아니라 사고다.
assert.deepStrictEqual(
  workflow.judgeTransition('doing', 'done', whole, null),
  workflow.judgeTransition('doing', 'done', Object.assign({}, whole, { approvals: [pass('MEMBER-002')] }), null),
  '내장 흐름의 판정이 승인 근거에 흔들립니다.'
);

process.stdout.write('workflow tests passed\n');
