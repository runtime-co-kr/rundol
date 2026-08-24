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

process.stdout.write('workflow config tests passed (전환 선언 · 승인 슬롯 · 3단 상속 · 바인딩)\n');
