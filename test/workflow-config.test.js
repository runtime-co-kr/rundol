'use strict';

// 설정으로 정의하는 워크플로. 어휘가 아니라 프로젝트가 노드와 전환을 정하는 층이며,
// 이 시험이 지키는 것은 하나다 — 설정이 없으면 판정이 판올림 전과 같아야 한다.
//
// 파일을 읽는 부분과 값만 보는 부분을 따로 시험한다. 섞으면 판정이 틀렸는지
// 파일을 잘못 읽었는지 구분되지 않고, 구분되지 않는 실패는 어디를 고칠지 말해 주지 않는다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workflow = require('../src/workflow');
const config = require('../src/workflow-config');
const vocabulary = require('../src/vocabulary');

const { normalizeWorkflows, mergeWorkflows, createWorkflow } = workflow;

function definition(overrides) {
  return Object.assign({
    targetKind: 'task',
    nodes: {
      todo: { step: 'unclaimed' },
      doing: { step: 'in-progress', requiresOwner: true },
      review: { step: 'in-approval', requiresOwner: true },
      done: { step: 'completed', validity: 'valid', requiresOwner: true },
      cancelled: { step: 'dropped', requiresOwner: true }
    },
    transitions: [
      { from: 'todo', to: 'doing', title: '착수' },
      { from: 'doing', to: 'review', title: '검토 요청' },
      { from: 'review', to: 'done', title: '승인', approval: { human: true } },
      { to: 'cancelled', title: '취소' }
    ]
  }, overrides || {});
}

function build(raw) {
  return mergeWorkflows([normalizeWorkflows(raw, { file: 'workflows.json' })]);
}

// ── 설정이 없으면 지금 판정 그대로 ────────────────────────────────────────────
//
// 이 갈래가 깨서는 안 되는 유일한 것이다. 설정을 안 쓴 저장소에서 답이 달라지면
// 그것은 기능이 아니라 사고다.

assert.strictEqual(workflow.stepOf('done'), 'completed', '내장 노드 표가 그대로여야 한다.');
assert.strictEqual(workflow.transitionAllowed('todo', 'done'), true, '전환 목록이 없으면 막지 않는다.');
assert.deepStrictEqual(workflow.judgeTransition('todo', 'todo', { id: 'T-1' }), [], '내장은 전환을 막지 않는다.');

// ── 정규화가 거부하는 것 ─────────────────────────────────────────────────────
//
// 알 수 없는 키를 판정 시점까지 끌고 가면 그 규칙은 아무 항목에도 맞지 않는 채로
// 살고, 그렇게 사는 동안 아무 신호도 내지 않는다. item-type.js와 같은 규율이다.

assert.throws(() => normalizeWorkflows({ x: { nodez: {} } }, { file: 'f.json' }), /알 수 없는 키/u, '모르는 키를 받으면 안 된다.');
assert.throws(() => normalizeWorkflows({ x: { nodes: { a: { step: '없음' } } } }, { file: 'f.json' }), /스텝은 다음 중 하나/u, '어휘 밖 스텝을 받으면 안 된다.');
assert.throws(
  () => normalizeWorkflows({ x: { nodes: { a: { step: 'in-progress', validity: 'valid' } } } }, { file: 'f.json' }),
  /completed 스텝에서만/u,
  '유효성은 completed에서만 뜻이 있다.'
);
assert.throws(() => normalizeWorkflows({ x: { disabled: 'yes' } }, { file: 'f.json' }), /disabled는 true만/u, 'disabled는 true만 받는다.');

// 거부 메시지는 파일과 키 경로와 이유를 함께 문다. 철자를 고치려 들지 않게 하려면
// 어디가 왜 틀렸는지가 한 줄에 있어야 한다.
try {
  normalizeWorkflows({ 흐름: { nodez: {} } }, { file: 'projects/x/workflows.json' });
  assert.fail('거부되지 않았다.');
} catch (error) {
  assert.match(error.message, /projects\/x\/workflows\.json/u, '파일 경로가 있어야 한다.');
  assert.match(error.message, /workflows\.흐름\.nodez/u, '키 경로가 있어야 한다.');
}

// 전환이 이 워크플로 밖 노드를 가리키면 거부한다. (ALL)의 범위가 매핑 안이라는
// 규칙이 여기서 선다 — 바깥으로 열면 노드를 더하는 것만으로 기존 전환이 바뀐다.
assert.throws(
  () => build({ x: { nodes: { a: { step: 'unclaimed' } }, transitions: [{ from: 'a', to: '없는노드' }] } }),
  /이 워크플로에 없는 노드/u,
  '없는 노드로 가는 전환을 받으면 안 된다.'
);

// ── 전환이 선언한 것만 허용한다 ──────────────────────────────────────────────

const flow = createWorkflow(build({ f: definition() }).f);
assert.strictEqual(flow.transitionAllowed('todo', 'doing'), true, '선언한 전환은 허용된다.');
assert.strictEqual(flow.transitionAllowed('todo', 'done'), false, '선언하지 않은 전환은 막힌다.');
assert.strictEqual(flow.transitionAllowed('doing', 'cancelled'), true, '(ALL) 전환은 어느 노드에서든 간다.');
assert.strictEqual(flow.transitionAllowed('cancelled', 'cancelled'), true, '제자리는 전환이 아니다.');

const blocked = flow.judgeTransition('todo', 'done', { id: 'T-1', owner: 'M-1' });
assert.strictEqual(blocked.length, 1, '갈 수 없는 자리에는 그 사실 하나만 돌려준다.');
assert.strictEqual(blocked[0].code, 'RDL-FLOW-001', '선언되지 않은 전환의 코드다.');
assert.strictEqual(blocked[0].origin, 'transition', '전환에 걸린 규칙이다.');

// ── 승인 슬롯이 사람 게이트다 ────────────────────────────────────────────────
//
// 카탈로그가 아니라 전환이 드는 이유는 물음이 다르기 때문이다. 카탈로그는 "항목이
// 무엇을 갖췄는가"를 묻고 승인은 "다른 행위자가 동의했는가"를 묻는데, 뒤엣것은
// 항목만 보고 답할 수 없다.

const ready = { id: 'T-1', owner: 'M-1', links: ['TST-001'], acceptanceCriteria: { 'AC-1': { done: true } } };
const gated = flow.judgeTransition('review', 'done', ready);
const approval = gated.find((item) => item.code === 'RDL-FLOW-002');
assert.ok(approval, '승인 슬롯을 건 전환은 사람 게이트를 낸다.');
assert.strictEqual(approval.human, true, '사람 게이트임을 값으로 밝힌다.');

const ungated = createWorkflow(build({ f: definition({
  transitions: [{ from: 'review', to: 'done', title: '승인' }]
}) }).f);
assert.ok(
  !ungated.judgeTransition('review', 'done', ready).some((item) => item.code === 'RDL-FLOW-002'),
  '승인 슬롯을 안 걸면 사람 게이트가 없다.'
);

// 승인 슬롯은 human: true만 받는다. 다른 값을 받으면 "걸었는데 안 걸린" 게이트가
// 생기고, 그 사실은 아무 신호도 내지 않는다.
assert.throws(
  () => build({ x: { nodes: { a: { step: 'unclaimed' }, b: { step: 'completed' } }, transitions: [{ from: 'a', to: 'b', approval: { human: false } }] } }),
  /human: true만/u,
  '승인 슬롯은 human: true만 받는다.'
);

// ── 슬롯은 이름으로 실행 단위를 가리킨다 ─────────────────────────────────────
//
// 전환마다 검사를 처음부터 다시 적게 하면 워크플로가 비대해진다 — 지라가 전환 N:M을
// 두지 않아 validator를 전환마다 다시 적는 자리가 그것이다. 이름을 붙여 두면 같은 검사가
// 한 줄이고, 그 줄을 고치면 그것을 가리키는 전환이 전부 따라간다.

// 칸 목록은 손으로 적지 않고 어휘의 표에서 나온다. 손으로 적으면 어휘가 슬롯을 늘렸는데
// 설정이 그 칸을 못 받는 날이 오고, 그 사실은 아무 신호도 내지 않는다.
assert.deepStrictEqual(
  workflow.SLOT_KEYS.slice(),
  vocabulary.TRANSITION_SLOTS.filter((slot) => vocabulary.TRANSITION_SLOT_UNIT_KINDS[slot].length > 0),
  '전환의 칸이 어휘의 슬롯 표에서 나오지 않습니다.'
);
assert.ok(!workflow.SLOT_KEYS.includes('restriction'), '제한은 칸을 갖지 않는다 — 목록에 있는가 없는가가 곧 그 슬롯의 데이터다.');
assert.deepStrictEqual(workflow.NAMED_SLOT_KEYS.slice(), ['validation', 'input', 'execution'], '이름 목록으로 가리키는 슬롯은 셋이다 — 승인 칸은 아직 뒤처져 있다.');

function slotted(overrides) {
  return {
    targetKind: 'task',
    nodes: {
      todo: { step: 'unclaimed' },
      review: { step: 'in-approval', requiresOwner: true },
      done: { step: 'completed', validity: 'valid', requiresOwner: true }
    },
    executionUnits: Object.assign({
      'tst-link': { kind: 'gate', source: 'link', method: 'count', linkType: 'TST', min: 1, label: 'TST 링크' },
      'criteria-done': { kind: 'gate', source: 'acceptance-criteria', method: 'every', element: { field: 'done', values: [true] } },
      notify: { kind: 'adapter', label: '알림' }
    }, (overrides || {}).executionUnits),
    transitions: (overrides || {}).transitions || [
      { from: 'todo', to: 'review', title: '검토 요청' },
      { from: 'review', to: 'done', title: '승인', validation: ['tst-link', 'criteria-done'], execution: ['notify'], approval: { human: true } }
    ]
  };
}

const slotFlow = createWorkflow(build({ f: slotted() }).f);
const slots = slotFlow.transitionFor('review', 'done');
assert.deepStrictEqual(slots.validation.slice(), ['tst-link', 'criteria-done'], '검증 슬롯이 이름 목록을 그대로 든다 — 순서는 목록의 순서다.');
assert.deepStrictEqual(slots.execution.slice(), ['notify'], '수행 슬롯도 이름으로 가리킨다.');
assert.strictEqual(slots.input, null, '적지 않은 슬롯은 걸리지 않는다.');

// 없는 단위를 가리키면 여기서 막는다. 판정 시점까지 끌고 가면 그 전환은 검사를 건 줄
// 알면서 아무것도 검사하지 않는다.
assert.throws(
  () => build({ f: slotted({ transitions: [{ from: 'todo', to: 'done', validation: ['없는검사'] }] }) }),
  /이 워크플로에 없는 실행 단위/u,
  '없는 실행 단위를 가리키면 안 된다.'
);

// 종류가 슬롯에 안 맞으면 어느 칸에 걸어야 하는지를 함께 말한다. 이름만 알리면 오타로
// 여기고 철자를 고친다.
try {
  build({ f: slotted({ transitions: [{ from: 'todo', to: 'done', validation: ['notify'] }] }) });
  assert.fail('거부되지 않았다.');
} catch (error) {
  assert.match(error.message, /validation 슬롯은 gate 단위만 받습니다/u, '슬롯이 무는 종류를 말해야 한다.');
  assert.match(error.message, /execution 칸에 겁니다/u, '어느 칸에 걸어야 하는지를 말해야 한다.');
}

// 승인은 아직 이름 목록을 받지 않는다. 받는 척하면 human 단위를 선언한 사람은 자기가
// 건 게이트가 도는 줄 알지만 어느 전환도 그 이름을 가리키지 못한다.
assert.throws(
  () => build({ f: slotted({ executionUnits: { owner: { kind: 'human' } } }) }),
  /human 단위는 아직 이름으로 가리킬 수 없습니다/u,
  '뒤처진 칸을 뒤처지지 않은 것처럼 받으면 안 된다.'
);

assert.throws(
  () => build({ f: slotted({ transitions: [{ from: 'todo', to: 'done', validation: [] }] }) }),
  /비어 있지 않은 이름 배열/u,
  '빈 슬롯은 적지 않는다 — 칸만 있는 선언은 무엇을 적는 자리인지 모르겠다는 뜻으로 읽힌다.'
);
assert.throws(
  () => build({ f: slotted({ transitions: [{ from: 'todo', to: 'done', validation: ['tst-link', 'tst-link'] }] }) }),
  /같은 실행 단위를 두 번/u,
  '한 슬롯에 같은 단위를 두 번 걸면 같은 진단이 둘 선다.'
);

// ── 성질이 안 맞는 조합은 판정이 아니라 파싱에서 거부된다 ────────────────────
//
// 소스의 성질이 쓸 수 있는 방법을 정하므로 소스 × 방법 표를 두지 않는다. 판정 시점까지
// 끌고 가면 그 규칙은 아무 항목에도 맞지 않는 채로 살고, 사는 동안 아무 신호도 내지 않는다.

assert.throws(
  () => build({ f: slotted({ executionUnits: { bad: { kind: 'gate', source: 'acceptance-criteria', method: 'unique' } } }) }),
  /성질이 collection이므로 unique로 볼 수 없습니다/u,
  '성질에 안 맞는 조합은 설정 파싱에서 거부된다.'
);

// 유일성은 항목 하나만 보고 답할 수 없다. 걸 자리가 없는 것이 아니라 자리가 다르다 —
// 항상 참이어야 하는 규칙이므로 항목 유형이 든다.
assert.throws(
  () => build({ f: slotted({ executionUnits: { dup: { kind: 'gate', source: 'composite', method: 'unique', fields: ['title'] } } }) }),
  /전환이 아니라 항목 유형에 겁니다/u,
  'composite 소스는 전환에 걸 수 없다.'
);

// 몸통의 오타는 카탈로그가 문다. 여기서 키를 골라 담으면 카탈로그가 늘린 파라미터를
// 이 파일이 조용히 버린다.
try {
  build({ f: slotted({ executionUnits: { typo: { kind: 'gate', source: 'link', method: 'count', linkTyp: 'TST', min: 1 } } }) });
  assert.fail('거부되지 않았다.');
} catch (error) {
  assert.match(error.message, /workflows\.f\.executionUnits\.typo/u, '키 경로가 실행 단위를 가리켜야 한다.');
}

// ── 검증 슬롯이 실제로 판정한다 ──────────────────────────────────────────────
//
// 판정기를 새로 짓지 않고 소스 × 방법 카탈로그를 그대로 부른다. 두 벌이 되면 같은
// 항목이 어디서 보느냐에 따라 다른 판정을 받는다.

const half = { id: 'TASK-2', owner: 'M-1', links: [], acceptanceCriteria: { 'AC-1': { done: true }, 'AC-2': { done: false } } };
const judged = slotFlow.judgeTransition('review', 'done', half, { memberId: 'MEMBER-001' });
const counted = judged.find((item) => item.ruleId === 'review→done.tst-link');
assert.ok(counted, '검증 슬롯의 규칙이 판정에 선다.');
assert.strictEqual(counted.code, 'RDL-VAL-005', '진단 코드는 규칙이 아니라 방법에 붙는다.');
assert.strictEqual(counted.origin, 'transition', '전환에 걸린 규칙이다.');
assert.strictEqual(counted.target, 'TASK-2.links[TST]', '무엇을 봤는지가 대상에 실린다.');
assert.ok(judged.some((item) => item.ruleId === 'review→done.criteria-done'), '막는 규칙을 전부 돌려준다.');

// 규칙이 걸린 자리가 이름공간이다. 같은 단위를 두 전환에 걸어도 발화 이력이 한 규칙으로
// 세지 않고 어느 전환에서 걸렸는지에 답한다.
const shared = createWorkflow(build({ f: slotted({ transitions: [
  { from: 'todo', to: 'review', title: '검토 요청', validation: ['tst-link'] },
  { from: 'review', to: 'done', title: '승인', validation: ['tst-link'] }
] }) }).f);
assert.ok(
  shared.judgeTransition('todo', 'review', half, null).some((item) => item.ruleId === 'todo→review.tst-link'),
  '같은 단위라도 걸린 전환이 식별자에 남는다.'
);

// 못 본 것을 통과로 세지 않는다. 남의 항목의 값은 부른 표면이 실어 줘야 답할 수 있고,
// 통과로 세면 아무도 안 지키는 규칙이 지켜지는 규칙으로 보인다.
const crossFlow = createWorkflow(build({ f: slotted({
  // 소스가 이미 필드를 뽑았으므로 원소 조건은 값만 견준다. field를 또 적으면 값을
  // 객체로 여겨 아무 원소도 만족하지 못한다.
  executionUnits: { 'tst-pass': { kind: 'gate', source: 'link-field', method: 'every', linkType: 'TST', field: 'result', element: { values: ['pass'] } } },
  transitions: [{ from: 'review', to: 'done', title: '승인', validation: ['tst-pass'] }]
}) }).f);
const linked = { id: 'TASK-3', owner: 'M-1', links: ['TST-001'], acceptanceCriteria: { 'AC-1': { done: true } } };
assert.ok(
  crossFlow.judgeTransition('review', 'done', linked, null)
    .some((item) => item.ruleId === 'review→done.tst-pass' && /판정하지 못한 규칙은 통과로 세지 않습니다/u.test(item.message)),
  '값이 안 실려 온 규칙은 통과가 아니라 막는다.'
);

// 실어 주면 판정한다. 판정이 파일을 읽지 않으므로 그 값은 항목을 타고 들어온다.
assert.ok(
  !crossFlow.judgeTransition('review', 'done', Object.assign({}, linked, { related: { 'TST-001': { result: 'pass' } } }), null)
    .some((item) => item.ruleId === 'review→done.tst-pass'),
  '실린 값으로 판정이 선다.'
);
assert.ok(
  crossFlow.judgeTransition('review', 'done', Object.assign({}, linked, { related: { 'TST-001': { result: 'fail' } } }), null)
    .some((item) => item.ruleId === 'review→done.tst-pass'),
  '실린 값이 어긋나면 막는다.'
);

// ── 승인 슬롯을 여는 근거 ────────────────────────────────────────────────────
//
// 근거가 값으로 실려 오면 슬롯이 열린다. 열리지 않으면 게이트가 아니라 벽이고, 벽이면
// 슬롯을 건 전환은 approval을 지우는 것 말고는 밟을 길이 없다.

const settled = { id: 'TASK-4', owner: 'M-1', links: ['TST-001'], acceptanceCriteria: { 'AC-1': { done: true } } };
function approvalOf(item, actor) {
  return slotFlow.judgeTransition('review', 'done', item, actor).find((entry) => entry.code === 'RDL-FLOW-002') || null;
}

assert.ok(approvalOf(settled, { memberId: 'MEMBER-001' }), '근거가 없으면 막힌다 — 없는 동의를 있는 것으로 세면 통과 도장이 된다.');
assert.strictEqual(
  approvalOf(Object.assign({}, settled, { approvals: [{ kind: 'read', verdict: 'pass', actor: 'MEMBER-002', delegatedFrom: null }] }), { memberId: 'MEMBER-001' }),
  null,
  '다른 행위자의 동의가 실리면 슬롯이 열린다.'
);

// 자기 자신의 동의는 승인이 아니다. 승인은 다른 행위자를 기다리는 일이므로 누구인지가
// 근거의 일부이고, 그래서 판정이 처음으로 actor를 본다.
assert.match(
  approvalOf(Object.assign({}, settled, { approvals: [{ kind: 'read', verdict: 'pass', actor: 'MEMBER-001', delegatedFrom: null }] }), { memberId: 'MEMBER-001' }).message,
  /자기 자신의 동의는 승인이 아닙니다/u,
  '자기 승인으로는 열리지 않는다.'
);

// 기권과 반려는 다르다 — "보지 못했다"와 "보고 아니라 했다"는 다르며, 뒤엣것은 답이므로
// 다른 동의로 덮이지 않는다.
assert.match(
  approvalOf(Object.assign({}, settled, { approvals: [{ kind: 'read', verdict: 'abstain', actor: 'MEMBER-002', delegatedFrom: null }] }), null).message,
  /기권 1건뿐입니다/u,
  '기권은 동의가 아니다.'
);
assert.match(
  approvalOf(Object.assign({}, settled, { approvals: [
    { kind: 'read', verdict: 'pass', actor: 'MEMBER-002', delegatedFrom: null },
    { kind: 'verdict', verdict: 'refuted', actor: 'MEMBER-003', delegatedFrom: null }
  ] }), null).message,
  /반려했습니다/u,
  '반려는 다른 동의로 덮이지 않는다.'
);

// 움직이지 않는 판정은 전환을 묻지 않는다. 물으면 (ALL) 전환에 걸린 슬롯이 그 노드에
// 앉아 있는 항목에도 걸리고, 같은 규칙이 출발을 적은 전환에서는 안 걸리므로 답이 규칙의
// 성질이 아니라 그 전환이 (ALL)로 적혔는가에 달리게 된다.
const wildFlow = createWorkflow(build({ f: slotted({ transitions: [
  { to: 'done', title: '어디서든 완료', validation: ['tst-link'], approval: { human: true } }
] }) }).f);
assert.deepStrictEqual(
  wildFlow.judgeItem({ id: 'TASK-5', owner: 'M-1', links: [], acceptanceCriteria: { 'AC-1': { done: true } }, status: 'done' }, null)
    .filter((entry) => entry.origin === 'transition' && /^(review→done\.|todo→done\.|\(ALL\)→done\.)/u.test(entry.ruleId)),
  [],
  '자리에서 묻는 판정에 전환 슬롯이 걸립니다.'
);
assert.ok(
  !wildFlow.judgeItem({ id: 'TASK-5', owner: 'M-1', links: ['TST-001'], acceptanceCriteria: { 'AC-1': { done: true } }, status: 'done' }, null)
    .some((entry) => entry.code === 'RDL-FLOW-002'),
  '움직이지 않는 항목에 사람 게이트가 걸립니다.'
);
// 밟으면 걸린다. 위가 "안 걸린다"만 보면 슬롯이 아예 안 도는 것과 구분되지 않는다.
assert.ok(
  wildFlow.judgeTransition('todo', 'done', { id: 'TASK-5', owner: 'M-1', links: ['TST-001'], acceptanceCriteria: { 'AC-1': { done: true } } }, null)
    .some((entry) => entry.code === 'RDL-FLOW-002'),
  '(ALL) 전환을 밟으면 사람 게이트가 선다.'
);

// ── 실행 단위도 상속을 탄다 ──────────────────────────────────────────────────

const unitInherited = mergeWorkflows([
  normalizeWorkflows({ f: slotted() }, { file: 'workspace' }),
  normalizeWorkflows({ f: { executionUnits: { 'tst-link': { kind: 'gate', source: 'link', method: 'count', linkType: 'TST', min: 2 } } } }, { file: 'project' })
]);
assert.strictEqual(unitInherited.f.units['tst-link'].rule.min, 2, '하위 층이 실행 단위를 덮어쓴다.');
assert.ok(unitInherited.f.units['criteria-done'], '적지 않은 단위는 상속받는다.');

// 없앤 단위는 노드와 다르게 다룬다. 갈 곳을 잃은 전환은 함께 사라지는 것이 맞지만,
// 검사 하나를 잃은 전환은 여전히 갈 곳이 있으므로 사라지면 안 된다 — 그 전환은 남고
// 검사만 조용히 빠지며, 빠졌다는 사실은 아무 신호도 내지 않는다.
assert.throws(
  () => mergeWorkflows([
    normalizeWorkflows({ f: slotted() }, { file: 'workspace' }),
    normalizeWorkflows({ f: { executionUnits: { 'tst-link': { disabled: true } } } }, { file: 'project' })
  ]),
  /없앤 실행 단위를 아직 가리킵니다/u,
  '없앤 단위를 가리키는 전환이 남으면 막는다.'
);

// ── 3단 상속 ────────────────────────────────────────────────────────────────

const inherited = mergeWorkflows([
  normalizeWorkflows({ f: definition() }, { file: 'workspace' }),
  normalizeWorkflows({ f: { nodes: { doing: { step: 'in-progress', label: '작업중' } } } }, { file: 'project' })
]);
assert.strictEqual(inherited.f.nodes.doing.label, '작업중', '하위 층이 노드를 덮어쓴다.');
assert.strictEqual(inherited.f.nodes.todo.step, 'unclaimed', '적지 않은 노드는 상속받는다.');
assert.strictEqual(inherited.f.transitions.length, 4, '전환을 안 적으면 상위 것을 그대로 쓴다.');

const replaced = mergeWorkflows([
  normalizeWorkflows({ f: definition() }, { file: 'workspace' }),
  normalizeWorkflows({ f: { transitions: [{ from: 'todo', to: 'done' }] } }, { file: 'project' })
]);
assert.strictEqual(replaced.f.transitions.length, 1, '전환을 적으면 층 단위로 갈아탄다.');

// 없앤 것은 없앴다고 적혀야 한다. 맵 병합에는 삭제가 없으므로 disabled가 그 자리다.
const dropped = mergeWorkflows([
  normalizeWorkflows({ f: definition() }, { file: 'workspace' }),
  normalizeWorkflows({ f: { disabled: true } }, { file: 'project' })
]);
assert.ok(!dropped.f, '하위가 없앤 워크플로는 사라진다.');

const droppedNode = mergeWorkflows([
  normalizeWorkflows({ f: definition() }, { file: 'workspace' }),
  normalizeWorkflows({ f: { nodes: { waiting: { step: 'in-progress' }, review: { disabled: true } } } }, { file: 'project' })
]);
assert.ok(!droppedNode.f.nodes.review, '하위가 없앤 노드는 사라진다.');
assert.ok(droppedNode.f.nodes.waiting, '하위가 더한 노드는 선다.');

// ── 바인딩 ──────────────────────────────────────────────────────────────────

const workflows = build({ f: definition(), d: definition({ targetKind: 'document', transitions: [] }) });
assert.deepStrictEqual(
  config.normalizeBindings({ task: { normal: 'f' } }, workflows, 'w.json'),
  { task: { normal: 'f' } },
  '유형이 이름으로 워크플로를 가리킨다.'
);
assert.throws(() => config.normalizeBindings({ task: { normal: '없음' } }, workflows, 'w.json'), /없는 워크플로/u, '없는 워크플로를 가리키면 막는다.');
assert.throws(() => config.normalizeBindings({ task: { normal: 'd' } }, workflows, 'w.json'), /document 워크플로/u, '대상 종류가 어긋나면 막는다.');
assert.throws(() => config.normalizeBindings({ 없는종류: {} }, workflows, 'w.json'), /대상 종류는 다음 중 하나/u, '어휘 밖 대상 종류를 막는다.');

// `*`가 기본이다. 문서 열하나 중 열이 같은 흐름을 쓰는 것이 지금 실측이고, 그 열을
// 열 줄로 적으면 하나를 고칠 때 열 곳을 고쳐야 한다.
const bound = { workflows, bindings: { task: { test: 'f', '*': 'f' } } };
assert.strictEqual(config.workflowFor(bound, 'task', 'test').transitionAllowed('todo', 'done'), false, '배정된 유형은 그 흐름을 탄다.');
assert.strictEqual(config.workflowFor(bound, 'task', '처음보는유형').transitionAllowed('todo', 'done'), false, '기본 배정이 나머지를 받는다.');

// 배정이 없으면 내장으로 떨어진다. 배정은 부분적일 수 있고, 하나만 흐름을 갖고 싶은
// 프로젝트가 나머지를 적지 않아도 돌아야 한다.
const unbound = config.workflowFor({ workflows, bindings: {} }, 'task', 'normal');
assert.strictEqual(unbound.transitionAllowed('todo', 'done'), true, '배정이 없으면 내장이 답한다.');
assert.strictEqual(unbound.stepOf('done'), 'completed', '내장 노드 표가 선다.');

// ── 파일을 읽는 부분 ─────────────────────────────────────────────────────────

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rdl-workflows-'));
const file = path.join(scratch, 'workflows.json');
try {
  assert.strictEqual(config.readJson(path.join(scratch, '없다.json')), null, '없는 파일은 null이다 — 없는 것과 잘못된 것은 다르다.');

  fs.writeFileSync(file, '{ 이건 JSON이 아니다');
  assert.throws(() => config.readJson(file), /JSON을 읽지 못했습니다/u, '깨진 파일은 이유와 함께 거부한다.');

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, workflows: {} }));
  assert.throws(() => config.readJson(file), /지원하지 않는 workflows\.json schemaVersion/u, '모르는 판을 지금 판으로 읽지 않는다.');

  fs.writeFileSync(file, JSON.stringify({ workflowz: {} }));
  assert.throws(() => config.readJson(file), /알 수 없는 키/u, '최상위의 모르는 키를 거부한다.');

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, workflows: { f: definition() }, bindings: { task: { '*': 'f' } } }));
  const parsed = config.readJson(file);
  assert.strictEqual(parsed.schemaVersion, 1, '정상 파일은 그대로 읽힌다.');
  const loaded = mergeWorkflows([normalizeWorkflows(parsed.workflows, { file })]);
  assert.strictEqual(createWorkflow(loaded.f).transitionAllowed('todo', 'done'), false, '읽은 정의가 판정에 그대로 선다.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ── 화면에 실어 보낼 값 ──────────────────────────────────────────────────────

const view = flow.taskWorkflowView();
assert.strictEqual(view.transitions.length, 4, '전환도 화면에 실린다.');
assert.ok(view.transitions.some((item) => item.approval === true), '사람 게이트가 걸린 전환을 화면이 안다.');
assert.deepStrictEqual(workflow.taskWorkflowView().transitions, null, '내장은 전환 목록이 없다.');

// 슬롯과 실행 단위도 실린다. 전환이 이름으로 가리키므로 이름만 보내면 화면이 그 이름이
// 무엇인지 물을 자리가 없고, 무는 자리가 없으면 화면은 자기 목록을 다시 적기 시작한다.
const slotView = slotFlow.taskWorkflowView();
const gateView = slotView.transitions.find((item) => item.to === 'done');
assert.deepStrictEqual(gateView.validation, ['tst-link', 'criteria-done'], '검증 슬롯이 화면에 실린다.');
assert.deepStrictEqual(gateView.execution, ['notify'], '수행 슬롯이 화면에 실린다.');
assert.strictEqual(slotView.executionUnits['tst-link'].label, 'TST 링크', '이름이 가리키는 단위가 함께 실린다.');
assert.strictEqual(slotView.executionUnits.notify.kind, 'adapter', '단위의 종류도 실린다.');

// 런을 여는지는 목록으로 적지 않고 어휘의 경계에서 계산한다. 다시 적으면 슬롯이 무는
// 종류를 바꾸는 날 이 값만 옛 답을 들고 남는다.
assert.strictEqual(gateView.opensRun, true, '입력 · 수행 · 승인이 걸린 전환은 런을 연다.');
assert.strictEqual(slotView.transitions.find((item) => item.to === 'review').opensRun, false, '아무것도 안 걸린 전환은 런을 열지 않는다.');
assert.strictEqual(
  workflow.transitionOpensRun({ validation: ['tst-link'], input: null, execution: null, approval: null }),
  false,
  '검증만 걸린 전환은 런을 열지 않는다 — 그 런은 판정 함수가 이미 답한 것을 다시 묻는다.'
);

// ── 저장 게이트가 전환을 본다 ────────────────────────────────────────────────
//
// 판정이 있어도 저장이 안 물으면 규칙은 종이로 남는다. 전환은 rdl task set에서
// 밟히므로 그 자리가 흐름을 타야 실제로 막힌다.

const { assertNodeConsistency } = require('../src/tasks');

// 흐름을 안 넘기면 내장이 답한다 — 판올림 전과 같다.
assertNodeConsistency({ status: 'todo', owner: 'M-1' }, { status: 'done', links: ['TST-1'] });

// 흐름을 넘기면 선언되지 않은 전환이 막힌다.
assert.throws(
  () => assertNodeConsistency({ status: 'todo', owner: 'M-1' }, { status: 'done', links: ['TST-1'] }, flow),
  /RDL-FLOW-001/u,
  '선언되지 않은 전환은 저장에서 막힌다.'
);

// 선언한 전환은 지난다.
assertNodeConsistency({ status: 'todo', owner: 'M-1' }, { status: 'doing' }, flow);

// 승인 슬롯이 걸린 전환은 사람 게이트로 막힌다.
assert.throws(
  () => assertNodeConsistency({ status: 'review', owner: 'M-1' }, { status: 'done', links: ['TST-1'] }, flow),
  /RDL-FLOW-002/u,
  '승인이 필요한 전환은 저장에서 막힌다.'
);

// 자리를 안 옮기는 저장은 전환을 묻지 않는다. 묻는 순간 필드 하나 고치는 일이
// 전환 규칙에 걸리고, 그러면 흐름을 켠 프로젝트는 아무것도 못 고친다.
assertNodeConsistency({ status: 'done', owner: 'M-1' }, { summary: '고침' }, flow);

// ── 검사가 흐름을 탄다 ──────────────────────────────────────────────────────
//
// 저장은 앞으로 들어올 것을 막고 검사는 이미 있는 것을 본다. 검사가 흐름을 모르면
// "지금 이 저장소가 자기 규칙을 지키고 있나"에 답하지 못한다.

const { checkTaskEntries } = require('../src/check-rules');

// 담당자를 요구하는 노드를 프로젝트가 정한다. 내장은 doing에만 걸지만 이 흐름은
// todo에도 건다 — 흐름이 판정을 바꾼다는 것을 그 차이가 보인다.
const ownerFlow = createWorkflow(build({ f: {
  targetKind: 'task',
  nodes: {
    todo: { step: 'unclaimed', requiresOwner: true },
    done: { step: 'completed', validity: 'valid', requiresOwner: true }
  }
} }).f);

function judgeWith(flowFor) {
  const found = [];
  checkTaskEntries(found, {
    'TASK-AAAA': { title: '담당자 없는 할 일', status: 'todo', owner: null, links: [], deps: [], acceptanceCriteria: {} }
  }, {
    taskIds: ['TASK-AAAA'],
    taskFile: 'tasks.json',
    registry: new Map(),
    memberIds: new Set(),
    stakeholderIds: new Set(),
    kinds: [],
    results: [],
    testedDocuments: () => [],
    flowFor
  });
  return found.map((item) => item.code);
}

// 흐름을 안 넘기면 내장이다 — todo에 담당자를 요구하지 않으므로 조용하다.
assert.ok(
  !judgeWith(null).includes('RDL-TASK-007'),
  '흐름을 안 넘기면 내장 판정이라 todo에 담당자를 요구하지 않는다.'
);

// 흐름을 넘기면 그 흐름이 정한 대로 판정한다.
assert.ok(
  judgeWith(() => ownerFlow).includes('RDL-TASK-007'),
  '프로젝트가 정한 흐름이 검사의 판정을 바꾼다.'
);

process.stdout.write('workflow config tests passed (전환 선언 · 슬롯 넷 · 검증 판정 · 승인 근거 · 3단 상속 · 바인딩)\n');
