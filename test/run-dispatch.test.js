'use strict';

// 자동 전환 큐의 시험. 세 층을 각각 잰다 — 선언(auto가 무엇을 거부하는가),
// 절차(auto가 무엇을 약속하게 하는가), 큐(누가 후보이고 회전이 무엇을 하는가).
//
// 세 층을 한 시험에 섞지 않는 이유는 실패가 어디를 고치라는 말이어야 하기
// 때문이다. 설정이 틀렸는지, 절차가 약속을 어겼는지, 큐가 잘못 세었는지는
// 각각 다른 파일의 결함이다.

const assert = require('assert');
const workflow = require('../src/workflow');
const config = require('../src/workflow-config');
const { procedureFromTransition, transitionProcedureName } = require('../src/procedure');
const { autoCandidates } = require('../src/run-dispatch');

const { normalizeWorkflows, mergeWorkflows } = workflow;

function build(raw) {
  return mergeWorkflows([normalizeWorkflows(raw, { file: 'workflows.json' })]);
}

function flowDefinition(overrides) {
  return Object.assign({
    targetKind: 'task',
    nodes: {
      todo: { step: 'unclaimed' },
      doing: { step: 'in-progress', requiresOwner: true },
      done: { step: 'completed', validity: 'valid', requiresOwner: true }
    },
    executionUnits: {
      build: { kind: 'cli', label: '수행' },
      notify: { kind: 'adapter', label: '알림' },
      author: { kind: 'client', label: '저작' },
      'tst-link': { kind: 'gate', source: 'link', method: 'count', linkType: 'TST', min: 1 }
    },
    transitions: [
      { from: 'todo', to: 'doing', execution: ['build'], auto: true },
      { from: 'doing', to: 'done', execution: ['build'], approval: { human: true } }
    ]
  }, overrides || {});
}

// ── 1. 선언 — auto는 기계 전용 전환에만 선다 ────────────────────────────────

// 성립하는 선언. auto를 적지 않은 전환은 false로 읽힌다 — 없는 것과 끈 것이
// 같은 값이어야 큐가 "선언되지 않은 전환"을 세지 않는다.
{
  const flows = build({ f: flowDefinition() });
  const auto = flows.f.transitions.find((item) => item.from === 'todo');
  const manual = flows.f.transitions.find((item) => item.from === 'doing');
  assert.strictEqual(auto.auto, true, 'auto: true가 전환에 실려야 한다.');
  assert.strictEqual(manual.auto, false, '적지 않은 전환은 자동이 아니다.');
}

// 사람 승인이 걸린 전환. 자동으로 열면 열리자마자 사람 앞에 멈춘 런이 쌓인다 —
// 그것은 큐가 아니라 소음이다.
assert.throws(
  () => build({ f: flowDefinition({ transitions: [{ from: 'todo', to: 'doing', execution: ['build'], approval: { human: true }, auto: true }] }) }),
  /사람 승인이 걸린 전환은 자동으로 열 수 없습니다/u,
  '승인과 자동은 같은 전환에 설 수 없다.'
);

// 입력 슬롯이 걸린 전환. 새로 댈 값이 있는 일은 사람이나 에이전트 세션의 것이고,
// 무인 드라이버는 값을 지어내지 못한다.
assert.throws(
  () => build({ f: flowDefinition({ transitions: [{ from: 'todo', to: 'doing', input: ['author'], execution: ['build'], auto: true }] }) }),
  /입력 슬롯이 걸린 전환은 자동으로 열 수 없습니다/u,
  '입력과 자동은 같은 전환에 설 수 없다.'
);

// 수행 슬롯이 없는 전환. 검증만 걸린 전환은 판정이 곧 답이라 열 런이 없다.
assert.throws(
  () => build({ f: flowDefinition({ transitions: [{ from: 'todo', to: 'doing', validation: ['tst-link'], auto: true }] }) }),
  /수행 슬롯이 없는 전환은 자동으로 열 것이 없습니다/u,
  '열 것이 없는 자동 선언은 적재에서 거부된다.'
);

// auto: false는 받지 않는다. 승인 칸의 human: true와 같은 규율이다 — 끄는 값을
// 받으면 "적었는데 꺼져 있다"와 "안 적었다"가 화면에서 갈리지 않는다.
assert.throws(
  () => build({ f: flowDefinition({ transitions: [{ from: 'todo', to: 'doing', execution: ['build'], auto: false }] }) }),
  /auto는 true만 쓸 수 있습니다/u,
  '자동을 끄는 방법은 칸을 지우는 것이다.'
);

// ── 2. 절차 — auto는 idempotent 약속이 된다 ────────────────────────────────
//
// 실행 단위의 몸통은 procedure.js가 이미 받는 스텝 모양으로 준다. 설정층의 단위
// 정의(kind만 있는)에 몸통을 실어 주는 일은 전환 슬롯 배선 갈래의 것이고, 이
// 시험은 몸통이 온 뒤의 약속만 잰다 — auto 전환의 절차는 idempotent로 고정되어
// 손으로 적은 idempotent 절차와 같은 drive 안전성 검증을 탄다.

const BODY_UNITS = {
  build: { executor: 'cli', command: 'save', args: ['--project', '{project}', '--run', '{runId}'], retrySafety: { mode: 'converging' } }
};

function normalizedTransition(overrides) {
  return Object.assign({
    from: 'todo', to: 'doing', title: null, approval: null,
    validation: null, input: null, execution: ['build'], auto: true
  }, overrides || {});
}

// auto 전환의 절차는 idempotent: true로 고정된다. 이 고정이 없으면 드라이버가 연
// 런을 runDrive의 preflight가 거절해, 큐는 아무도 실행할 수 없는 런으로 찬다.
{
  const definition = procedureFromTransition(normalizedTransition(), {
    source: 'workflows.json', workflow: 'f', targetKind: 'task', units: BODY_UNITS, floor: null
  });
  assert.strictEqual(definition.idempotent, true, 'auto 전환의 절차는 무인 약속을 든다.');
  assert.strictEqual(definition.targetKind, 'task');
  assert.deepStrictEqual(definition.steps.map((step) => step.id), ['build'], '수행 슬롯의 단위가 스텝이 된다.');
}

// auto가 아니면 약속도 없다. idempotent를 절차 성질로 지어내면 사람이 밟는 전환의
// 절차까지 무인 검증을 요구하게 된다.
{
  const definition = procedureFromTransition(normalizedTransition({ auto: false }), {
    source: 'workflows.json', workflow: 'f', targetKind: 'task', units: BODY_UNITS, floor: null
  });
  assert.strictEqual(definition.idempotent, undefined, '자동이 아닌 전환은 약속을 들지 않는다.');
}

// 약속은 검증을 데려온다. retrySafety 없는 cli 스텝은 손으로 적은 idempotent
// 절차가 거부되는 그 자리에서 같은 말로 거부된다 — 약속만 하고 검증을 건너뛴
// 절차는 규율 밖에 남고, 남았다는 사실은 아무 신호도 내지 않는다.
assert.throws(
  () => procedureFromTransition(normalizedTransition(), {
    source: 'workflows.json', workflow: 'f', targetKind: 'task',
    units: { build: { executor: 'cli', command: 'save', args: [] } }, floor: null
  }),
  /retrySafety가 필요합니다/u,
  'auto 절차도 drive 안전성 검증을 탄다.'
);

// ── 3. 큐 — 누가 후보인가 ──────────────────────────────────────────────────

function candidateConfig(overrides) {
  const workflows = build({ f: flowDefinition(overrides) });
  const bindings = config.normalizeBindings({ task: { '*': 'f' } }, workflows, 'workflows.json');
  return { workflows, bindings };
}

const AUTO_NAME = transitionProcedureName({ workflow: 'f', from: 'todo', to: 'doing' });

// 자동 전환의 출발 노드에 선 태스크가 후보다. 다른 노드에 선 태스크와 끝난
// 태스크는 어느 전환 앞에도 서 있지 않다.
{
  const candidates = autoCandidates({
    projectKey: 'memo',
    config: candidateConfig(),
    tasks: {
      'TASK-A': { status: 'todo', kind: 'normal', owner: 'MEMBER-001' },
      'TASK-B': { status: 'doing', kind: 'normal', owner: 'MEMBER-001' },
      'TASK-C': { status: 'done', kind: 'normal', owner: 'MEMBER-001' }
    },
    existing: []
  });
  assert.strictEqual(candidates.length, 1, 'todo에 선 태스크 하나만 후보다.');
  assert.strictEqual(candidates[0].taskId, 'TASK-A');
  assert.strictEqual(candidates[0].procedureName, AUTO_NAME, '후보는 자기 절차 이름을 안다 — dedup의 축이다.');
  assert.strictEqual(candidates[0].workflow, 'f', '출처 워크플로가 실린다.');
}

// 같은 (태스크, 절차)의 런이 원장에 있으면 다시 열지 않는다. 상태를 묻지 않는
// 이유가 이 장치의 중심이다 — 열린 런은 이미 큐에 있고, 끝났는데 태스크가 그
// 자리라면 사람이 봐야 할 정지이지 다시 열 일이 아니다. 원장이 격리 저장소를
// 겸하므로 프로세스가 죽어도 재큐잉이 없다.
{
  const candidates = autoCandidates({
    projectKey: 'memo',
    config: candidateConfig(),
    tasks: { 'TASK-A': { status: 'todo', kind: 'normal', owner: 'MEMBER-001' } },
    existing: [{ taskId: 'TASK-A', procedureName: AUTO_NAME }]
  });
  assert.deepStrictEqual(candidates, [], '원장에 있는 (태스크, 절차)는 다시 열지 않는다.');
}

// 담당자 규칙도 큐를 거른다. requiresOwner 노드로 가는 자동 전환은 담당자가
// 실린 태스크에서만 선다 — 큐가 판정을 새로 짓지 않고 judgeTransition을 그대로
// 쓰기 때문에, 규칙 카탈로그가 늘어도 큐는 저절로 따라간다.
{
  const unowned = autoCandidates({
    projectKey: 'memo', config: candidateConfig(),
    tasks: { 'TASK-A': { status: 'todo', kind: 'normal' } }, existing: []
  });
  assert.deepStrictEqual(unowned, [], '담당자 없는 태스크는 requiresOwner 노드로 자동 전환되지 않는다.');
}

// 검증 슬롯이 막는 태스크는 후보가 아니다. 판정하지 못한 규칙도 막힘이다 — 못 본
// 규칙을 통과로 세지 않는 규율이 큐에도 그대로 선다.
{
  const gated = candidateConfig({
    transitions: [{ from: 'todo', to: 'doing', validation: ['tst-link'], execution: ['build'], auto: true }]
  });
  const blocked = autoCandidates({
    projectKey: 'memo', config: gated,
    tasks: { 'TASK-A': { status: 'todo', kind: 'normal', owner: 'MEMBER-001', links: [] } }, existing: []
  });
  assert.deepStrictEqual(blocked, [], 'TST 링크가 없는 태스크는 링크 게이트에 막힌다.');
  const passing = autoCandidates({
    projectKey: 'memo', config: gated,
    tasks: { 'TASK-A': { status: 'todo', kind: 'normal', owner: 'MEMBER-001', links: ['TST-001'] } }, existing: []
  });
  assert.strictEqual(passing.length, 1, '게이트를 지난 태스크는 후보다.');
}

// 내장으로 떨어지는 태스크는 후보가 아니다. 내장에는 전환 목록이 없으므로 자동
// 선언이 있을 자리도 없다 — 배정 없는 유형이 조용히 큐에 들면 안 된다.
{
  const workflows = build({ f: flowDefinition() });
  const bindings = config.normalizeBindings({ task: { special: 'f' } }, workflows, 'workflows.json');
  const candidates = autoCandidates({
    projectKey: 'memo', config: { workflows, bindings },
    tasks: { 'TASK-A': { status: 'todo', kind: 'normal', owner: 'MEMBER-001' } }, existing: []
  });
  assert.deepStrictEqual(candidates, [], '배정되지 않은 유형은 내장을 타고, 내장은 자동이 없다.');
}

// 순서는 태스크 ID 정렬이다. 회전이 후보 하나를 고르므로 순서가 값이고, 값이면
// 재현되어야 한다.
{
  const candidates = autoCandidates({
    projectKey: 'memo', config: candidateConfig(),
    tasks: {
      'TASK-B': { status: 'todo', kind: 'normal', owner: 'MEMBER-001' },
      'TASK-A': { status: 'todo', kind: 'normal', owner: 'MEMBER-001' }
    },
    existing: []
  });
  assert.deepStrictEqual(candidates.map((item) => item.taskId), ['TASK-A', 'TASK-B'], '후보는 태스크 ID 순이다.');
}

// ── 4. 회전 — 몰 것이 없을 때만 열고, 하나만 연다 ──────────────────────────

const { driveRotation } = require('../src/run-driver');

function drivableFold() {
  return {
    status: 'running', cursor: 'author', completedSteps: [], attempts: {},
    cursorStep: { id: 'author', human: false }, owner: 'driver-a'
  };
}

function entry(fold) {
  return { project: { key: 'memo' }, runId: 'RUN-0123456789ABCDEF0123', fold, liveness: { lease: false, lock: false } };
}

function reader(runs) {
  return () => ({ workspace: '/ws', layout: null, runs, unreadable: [] });
}

function candidate(taskId) {
  return {
    project: 'memo', taskId, node: 'todo', workflow: 'f', targetKind: 'task',
    units: {}, transition: normalizedTransition(), procedureName: AUTO_NAME
  };
}

(async () => {
  // 몰 런이 없으면 후보 하나로 런을 연다. 여는 것도 회전 하나에 하나다 — 열기와
  // 몰기가 섞이지 않아야 회전의 결과가 셋 중 하나로 읽힌다.
  {
    const opened = [];
    const result = await driveRotation('/ws', { clientId: 'driver-a', quarantine: new Map() }, {
      drive: () => { throw new Error('몰 것이 없어야 한다'); },
      readRunFolds: reader([]),
      projectConsents: () => true,
      dispatchCandidates: () => ({ candidates: [candidate('TASK-A'), candidate('TASK-B')] }),
      openCandidate: (start, item) => { opened.push(item.taskId); return { runId: 'RUN-NEW' }; }
    });
    assert.strictEqual(result.drove, false);
    assert.deepStrictEqual(opened, ['TASK-A'], '후보 둘 중 첫 하나만 연다.');
    assert.strictEqual(result.queued.taskId, 'TASK-A');
    assert.strictEqual(result.queued.runId, 'RUN-NEW');
  }

  // 동의 없는 프로젝트의 후보는 열지 않는다. auto 선언은 계약층의 것이고 이
  // 작업공간에서 무인으로 열어도 되는가는 drive.schedulerClientId의 것이다 —
  // 드라이브와 같은 관문을 지나야 두 행위의 동의가 갈리지 않는다.
  {
    const opened = [];
    const result = await driveRotation('/ws', { clientId: 'driver-a', quarantine: new Map() }, {
      drive: () => Promise.resolve({ status: 'completed' }),
      readRunFolds: reader([]),
      projectConsents: () => false,
      dispatchCandidates: () => ({ candidates: [candidate('TASK-A')] }),
      openCandidate: (start, item) => { opened.push(item.taskId); return { runId: 'RUN-NEW' }; }
    });
    assert.deepStrictEqual(opened, [], '동의 없는 프로젝트는 열지 않는다.');
    assert.strictEqual(result.queued, null);
  }

  // 몰 런이 있으면 큐를 보지 않는다. 열기는 몰기의 준비이므로 이미 준비된 것이
  // 있으면 그쪽이 먼저다.
  {
    let asked = 0;
    await driveRotation('/ws', { clientId: 'driver-a', quarantine: new Map() }, {
      drive: () => Promise.resolve({ status: 'completed' }),
      readRunFolds: reader([entry(drivableFold())]),
      projectConsents: () => true,
      dispatchCandidates: () => { asked += 1; return { candidates: [candidate('TASK-A')] }; },
      openCandidate: () => { throw new Error('열면 안 된다'); }
    });
    assert.strictEqual(asked, 0, '몰 런이 있는 회전은 큐를 묻지 않는다.');
  }

  // 열기가 실패한 후보는 프로세스가 사는 동안 다시 집지 않는다. 원장에 아무것도
  // 남지 않은 실패라 dedup이 잡지 못하고, 잡지 못하면 회전마다 같은 실패를
  // 반복한다. 격리와 같은 규율이다 — 저장하지 않고, 재기동이 한 번 더 시도한다.
  {
    const quarantine = new Map();
    let attempts = 0;
    const deps = {
      drive: () => Promise.resolve({ status: 'completed' }),
      readRunFolds: reader([]),
      projectConsents: () => true,
      dispatchCandidates: () => ({ candidates: [candidate('TASK-A')] }),
      openCandidate: () => { attempts += 1; throw new Error('units에 몸통이 없습니다'); }
    };
    const first = await driveRotation('/ws', { clientId: 'driver-a', quarantine }, deps);
    assert.strictEqual(attempts, 1, '1회전은 연다.');
    assert.match(first.queued.error, /몸통/u, '실패는 회전 결과에 남는다.');
    await driveRotation('/ws', { clientId: 'driver-a', quarantine }, deps);
    await driveRotation('/ws', { clientId: 'driver-a', quarantine }, deps);
    assert.strictEqual(attempts, 1, '2·3회전은 다시 열지 않는다 — 뜨거운 순환이 없다.');
  }

  console.log('run-dispatch: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
