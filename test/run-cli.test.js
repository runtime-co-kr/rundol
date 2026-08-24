'use strict';

// 이 스위트는 실제 자식 프로세스를 띄운다. Windows에서 그 실행은 기본으로 막혀
// 있으므로 여기서만 켜고, 끝나면 반드시 되돌린다.
//
// 되돌리지 않으면 같은 프로세스에서 뒤이어 도는 스위트로 새어 나가 전체 게이트가
// 위험 모드에서 돈다 — 실제로 그랬고, "기본 차단에서 검증된다"는 말이 거짓이 됐다.
// 환경변수를 켜는 것과 켠 채로 두는 것은 다른 일이다.
const PREVIOUS_WINDOWS_ADAPTER = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';
function restoreWindowsAdapterOptIn() {
  if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
}

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadProcedures, validateOverride, validateDriveSafety, stepClass, opensRun, BUILTIN,
  TRANSITION_PROCEDURE_PREFIX, transitionProcedureName, transitionOpensRun, procedureFromTransition, resolveTransitionProcedures
} = require('../src/procedure');
const workflow = require('../src/workflow');
const vocabulary = require('../src/vocabulary');
const { runtimeWorkspace } = require('../src/runtime');
const requestJournal = require('../src/request-journal');
const { canonicalJson } = require('../src/event-store');
const runLedger = require('../src/run-ledger');
const driverLease = require('../src/driver-lease');
const { recordVerificationResult, startTransitionRun } = require('../src/run');
const { verifyCommandDigest, validatorInstanceId, invocationId, invocationDescriptor } = require('../src/verify');
const { pinInstruction } = require('../src/instruction-registry');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-run-cli-'));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), root));
}

function rdlRaw(args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: root, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertOverrideRejected(parentStep, childStep, pattern) {
  const parent = { steps: [parentStep] };
  const child = { steps: [childStep] };
  assert.throws(() => validateOverride('safe-flow', parent, child, 'fixture'), pattern);
}

// 검증 정책은 verify.policy 안에 산다. 예전 판정은 step.verify[key]를 보았고 그 자리에는
// 값이 없었으므로 검증자도 정족수도 반박 상한도 전부 검사를 지나쳐 갔다. 완화가 통과하던
// 것을 여기서 고정한다 — 승인 모드가 이 단조성 위에 서기 때문에, 뚫린 채로 두면 바닥을
// 선언해 놓고 스텝에서 검증자를 내리는 길이 남는다.
{
  const base = { validators: 3, quorum: 3, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: true };
  const withPolicy = (policy) => ({ steps: [{ id: 'verify', executor: 'adapter', verify: { lenses: ['satisfaction-v1'], policy } }] });
  const tightParent = withPolicy(base);
  const loosen = (patch) => Object.assign({}, base, patch);

  // 방향은 필드마다 다르다. 하나의 비교로 전부 판정하면 반드시 한쪽이 뒤집힌다.
  assert.throws(() => validateOverride('f', tightParent, withPolicy(loosen({ validators: 1 })), 'fixture'), /validators/u, '검증자를 내릴 수 없어야 합니다');
  assert.throws(() => validateOverride('f', tightParent, withPolicy(loosen({ quorum: 1 })), 'fixture'), /quorum/u, '정족수를 내릴 수 없어야 합니다');
  assert.throws(() => validateOverride('f', tightParent, withPolicy(loosen({ maxRefuted: 5 })), 'fixture'), /maxRefuted/u, '허용 반박을 올릴 수 없어야 합니다');
  assert.throws(() => validateOverride('f', tightParent, withPolicy(loosen({ maxAbstain: 5 })), 'fixture'), /maxAbstain/u, '허용 기권을 올릴 수 없어야 합니다');
  assert.throws(() => validateOverride('f', tightParent, withPolicy(loosen({ requireAdapterDiversity: false })), 'fixture'), /requireAdapterDiversity/u, '다양성 요구를 끌 수 없어야 합니다');

  // 정책 자체를 지우는 것도 완화다.
  assert.throws(
    () => validateOverride('f', tightParent, { steps: [{ id: 'verify', executor: 'adapter', verify: { lenses: ['satisfaction-v1'] } }] }, 'fixture'),
    /검증 정책을 제거/u
  );

  // 조이는 방향은 통과해야 한다. 전부 막으면 단조성이 아니라 동결이다.
  validateOverride('f', tightParent, withPolicy(loosen({ validators: 5 })), 'fixture');
  validateOverride('f', tightParent, withPolicy(loosen({ quorum: 4 })), 'fixture');
  validateOverride('f', tightParent, withPolicy(base), 'fixture');

  // 방향이 선언되지 않은 필드는 조용히 빠지지 않는다. 빠지면 새 손잡이가 생길 때마다
  // 그것만 단조성 밖에 남고, 남았다는 사실은 아무도 모른다.
  const mystery = withPolicy({ validators: 3, mysteryKnob: 1 });
  assert.throws(() => validateOverride('f', mystery, mystery, 'fixture'), /조임 방향이 선언되지 않았습니다/u);
}

// Inheritance is monotonic: a project layer may tighten safety, never remove it.
assertOverrideRejected(
  { id: 'gate', gate: { command: 'check', args: ['REQ-001', '--strict'] }, onFail: { goto: 'gate', maxAttempts: 3, carry: ['finding'] } },
  { id: 'gate', gate: { command: 'check', args: ['REQ-001', '--strict'] } },
  /onFail/u
);
assertOverrideRejected(
  { id: 'verify', executor: 'adapter', lenses: ['satisfaction-v1', 'boundary-v1'], refutedThreshold: 1, abstainThreshold: 1 },
  { id: 'verify', executor: 'adapter', lenses: ['satisfaction-v1'], refutedThreshold: 2, abstainThreshold: 1 },
  /lens|Threshold/u
);
assertOverrideRejected(
  { id: 'write', executor: 'cli', args: ['apply', '--operation', '{operationId}'], retrySafety: { mode: 'operation-id' } },
  { id: 'write', executor: 'cli', args: ['apply'], retrySafety: { mode: 'operation-id' } },
  /operationId/u
);
assertOverrideRejected(
  { id: 'write', executor: 'cli', retrySafety: { mode: 'gate-recheck', gateStep: 'check-written' } },
  { id: 'write', executor: 'cli', retrySafety: { mode: 'gate-recheck', gateStep: 'check-other' } },
  /gate-recheck/u
);
assertOverrideRejected(
  { id: 'approve', human: true },
  { id: 'approve', executor: 'client' },
  /분류|사람/u
);
assert.throws(() => validateDriveSafety({
  name: 'unsafe-drive', revision: 1, idempotent: true,
  steps: [{ id: 'write', executor: 'cli', args: ['apply'] }]
}), /retrySafety/u);
assert.throws(() => validateDriveSafety({
  name: 'unsafe-placeholder', revision: 1, idempotent: true,
  steps: [{ id: 'write', executor: 'cli', args: ['apply', '{operationId}', '{operationId}'], retrySafety: { mode: 'operation-id' } }]
}), /정확히 한 번/u);
assert.doesNotThrow(() => validateDriveSafety({
  name: 'safe-drive', revision: 1, idempotent: true,
  steps: [
    { id: 'check-written', gate: { command: 'check', args: ['{artifact}', '--strict'] } },
    { id: 'write', executor: 'cli', args: ['apply'], retrySafety: { mode: 'gate-recheck', gateStep: 'check-written' } }
  ]
}));
assert.throws(() => validateDriveSafety({
  name: 'unsafe-drive-gate', revision: 1, idempotent: true,
  steps: [{ id: 'unsafe', gate: { command: 'check', args: ['REQ-001', '--fix'] } }]
}), /closed read-only allowlist/u);
assert.throws(() => validateDriveSafety({
  name: 'ambiguous-drive-step', revision: 1, idempotent: true,
  steps: [{ id: 'ambiguous', executor: 'cli', gate: { command: 'check', args: ['REQ-001', '--strict'] } }]
}), /exactly one drive class/u);

// ── 실행 단위 종류 ──────────────────────────────────────────────────────
//
// 스텝 분류가 정본에서 파생되는지 값으로 확인한다. 소스 문자열을 맞춰 보면 아무것도
// 증명하지 못한다 — 글자가 같아도 값이 틀릴 수 있고, 띄어쓰기만 바뀌어도 깨진다.
//
// 종류마다 그 종류로 읽히는 스텝을 하나씩 둔다. 정본에 종류가 늘면 이 표에 빈칸이
// 생겨 첫 단언이 멈춘다. 늘어난 종류가 조용히 client로 떨어지는 길을 막는 것이다.
const SHAPED_STEPS = {
  gate: { id: 'g', gate: { command: 'check', args: ['{artifact}', '--strict'] } },
  client: { id: 'c', executor: 'client' },
  cli: { id: 'l', executor: 'cli' },
  adapter: { id: 'a', executor: 'adapter' },
  human: { id: 'h', human: true }
};
assert.deepStrictEqual(
  Object.keys(SHAPED_STEPS).sort(),
  vocabulary.EXECUTION_UNIT_KINDS.slice().sort(),
  '실행 단위 종류와 스텝 모양 표의 집합이 다릅니다.'
);
for (const [kind, step] of Object.entries(SHAPED_STEPS)) {
  assert.strictEqual(stepClass(step), kind, `${kind} 모양의 스텝이 ${stepClass(step)}로 분류됩니다.`);
  assert.strictEqual(
    opensRun(step),
    vocabulary.RUN_OPENING_UNIT_KINDS.includes(kind),
    `${kind}이 런을 여는지가 정본과 다릅니다.`
  );
}
// 사람 게이트는 게이트의 모양도 갖는다. 순서가 뒤집히면 승인이 조용히 기계 게이트가
// 되고, 그 런은 사람이 본 적 없는 것을 승인된 것으로 기록한다.
assert.strictEqual(stepClass({ id: 'h', human: true, gate: { command: 'check', args: [] } }), 'human');

// 게이트뿐인 절차는 런을 열지 않으므로 로드에서 거부된다. 열어 봐야 그 런은 판정
// 함수가 이미 답한 것을 다시 묻고, 원장에는 남길 것이 없다.
assert.throws(() => validateDriveSafety({
  name: 'gate-only', revision: 1,
  steps: [{ id: 'only-gate', gate: { command: 'check', args: ['{artifact}', '--strict'] } }]
}), /런을 열지 않습니다/u);
// 게이트 하나만 더 있으면 되는 것이 아니라, 런을 여는 종류가 하나라도 있어야 한다.
assert.doesNotThrow(() => validateDriveSafety({
  name: 'gate-then-human', revision: 1,
  steps: [
    { id: 'only-gate', gate: { command: 'check', args: ['{artifact}', '--strict'] } },
    { id: 'approve', human: true }
  ]
}));

// ── 대상 종류 ───────────────────────────────────────────────────────────
//
// 내장 절차가 자기 대상의 종류를 밝힌다. 선택으로 두면 절반이 비는 칸이 되고 절반이
// 빈 칸은 장식이다 — 그 자리를 실제로 세어 본 것이 이 설계의 출발점이었다.
for (const [name, definition] of Object.entries(BUILTIN)) {
  assert(vocabulary.TARGET_KINDS.includes(definition.targetKind), `${name}의 대상 종류가 정본에 없습니다: ${definition.targetKind}`);
}

// 대상 종류는 절차의 정체다. 하위 계층이 바꾸면 같은 이름의 절차가 다른 것을 움직이게
// 되고, 그 이름으로 절차를 부르는 자리가 전부 조용히 다른 일을 한다.
assert.throws(() => validateOverride(
  'retarget',
  { targetKind: 'document', steps: [{ id: 'author', executor: 'client' }] },
  { targetKind: 'task', steps: [{ id: 'author', executor: 'client' }] },
  'fixture'
), /대상 종류를 바꿀 수 없습니다/u);

// ── 전환에서 절차로 ────────────────────────────────────────────────────
//
// ADR-023의 결정 본문 "전환 하나가 절차 하나"가 값으로 서는지 본다.
//
// 경계 목록을 이 시험이 따로 적지 않는다. 적으면 그것이 세 번째 선언이 되고, 정본이
// 바뀐 날 시험만 옛 답으로 통과한다 — 여기서는 정본이 계산한 답과 같은지만 묻는다.
{
  // 스텝 모양 표에서 몸통만 떼어 실행 단위 정의로 쓴다. 정본에 종류가 늘면 위 표에
  // 빈칸이 생겨 이미 멈추므로, 여기서 다시 세지 않는다.
  const unitBodies = {};
  for (const [kind, step] of Object.entries(SHAPED_STEPS)) {
    const body = Object.assign({}, step);
    delete body.id;
    unitBodies[kind] = body;
  }

  // 칸을 갖지 않는 슬롯은 실행 단위와 맞물리지 않는 슬롯뿐이다. 그것이 컴파일되는 것은
  // 실행 단위가 아니라 전환 목록에서의 제외이고, 칸이 생기면 그 칸은 아무것으로도
  // 컴파일되지 않는 죽은 칸이 된다.
  const fieldlessSlots = vocabulary.TRANSITION_SLOTS.filter((slot) => !vocabulary.TRANSITION_SLOT_UNIT_KINDS[slot].length);
  assert.deepStrictEqual(fieldlessSlots, ['restriction'], '칸 없는 슬롯이 제한 하나가 아닙니다.');
  for (const slot of fieldlessSlots) {
    assert.throws(() => transitionOpensRun({ from: 'todo', to: 'doing', [slot]: ['unit'] }), /칸을 갖지 않습니다/u);
  }

  function slotFixture(slot) {
    if (slot === 'approval') return { transition: { from: 'todo', to: 'doing', approval: { human: true, reason: null } }, units: {} };
    const units = {};
    for (const kind of vocabulary.TRANSITION_SLOT_UNIT_KINDS[slot]) units[`unit-${kind}`] = unitBodies[kind];
    return { transition: { from: 'todo', to: 'doing', [slot]: Object.keys(units) }, units };
  }

  // 슬롯 하나만 걸린 전환을 만들어 두 번 묻는다. 슬롯으로 물은 답과 만들어진 절차의
  // 스텝으로 물은 답이 같아야 한다 — 갈리면 검증만 걸린 전환이 런을 열거나, 런을 여는
  // 전환이 절차 없이 지나간다.
  for (const slot of vocabulary.TRANSITION_SLOTS) {
    if (fieldlessSlots.includes(slot)) continue;
    const { transition, units } = slotFixture(slot);
    const opens = vocabulary.RUN_OPENING_SLOTS.includes(slot);
    assert.strictEqual(transitionOpensRun(transition), opens, `${slot} 슬롯이 런을 여는지가 정본과 다릅니다.`);
    const definition = procedureFromTransition(transition, { workflow: 'task-default', targetKind: 'task', units });
    assert.strictEqual(definition !== null, opens, `${slot} 슬롯의 절차 유무가 경계와 다릅니다.`);
    if (definition) assert(definition.steps.some(opensRun), `${slot}에서 만든 절차가 런을 열지 않습니다.`);
  }

  // 슬롯이 무는 실행 단위 종류는 정본의 표가 정한다. 표 밖의 단위를 슬롯에 넣으면
  // 거부한다 — 통과시키면 승인 자리에 기계 게이트가 서는 일이 설정 한 줄로 생긴다.
  for (const slot of vocabulary.TRANSITION_SLOTS) {
    const allowed = vocabulary.TRANSITION_SLOT_UNIT_KINDS[slot];
    if (!allowed.length || slot === 'approval') continue;
    for (const kind of vocabulary.EXECUTION_UNIT_KINDS) {
      if (allowed.includes(kind)) continue;
      assert.throws(
        () => procedureFromTransition(
          { from: 'todo', to: 'doing', [slot]: ['unit'], approval: { human: true, reason: null } },
          { workflow: 'task-default', targetKind: 'task', units: { unit: unitBodies[kind] } }
        ),
        /슬롯에는/u,
        `${slot} 슬롯이 ${kind} 실행 단위를 받았습니다.`
      );
    }
  }

  const taskUnits = {
    'has-owner': { gate: { command: 'check', args: ['{task}', '--strict'] } },
    claim: { executor: 'cli', command: 'task', args: ['claim', '{task}'] },
    note: { executor: 'client' }
  };

  {
    const definition = procedureFromTransition(
      { from: 'todo', to: 'doing', validation: ['has-owner'], execution: ['claim'] },
      { workflow: 'task-default', targetKind: 'task', units: taskUnits }
    );
    // 스텝 순서는 정본의 슬롯 순서다 — 판정이 실행보다 앞선다.
    assert.deepStrictEqual(definition.steps.map((step) => step.id), ['has-owner', 'claim']);
    assert.deepStrictEqual(definition.steps.map(stepClass), ['gate', 'cli']);
    // 대상 종류는 워크플로가 준다. 이 자리가 문서만 다루면 태스크 흐름의 전환은 절차를
    // 갖지 못하고, 갖지 못한 전환은 런도 원장도 없이 지나간다.
    assert.strictEqual(definition.targetKind, 'task');
    assert(vocabulary.TARGET_KINDS.includes(definition.targetKind));
    // 출처는 값으로 갖는다. 이름이 그 셋에서 파생되지만 반대로 읽지 않는다.
    assert.deepStrictEqual(definition.transition, { workflow: 'task-default', from: 'todo', to: 'doing' });
    assert.strictEqual(definition.name, transitionProcedureName(definition.transition));
    assert(definition.name.startsWith(`${TRANSITION_PROCEDURE_PREFIX}.`));
  }

  // 조각을 점으로 가르므로 붙임표가 든 노드 이름이 섞이지 않는다. 붙임표로 이으면
  // a-b → c와 a → b-c가 한 이름이 되고, 두 전환이 한 절차를 나눠 갖는다.
  assert.notStrictEqual(
    transitionProcedureName({ workflow: 'w', from: 'a-b', to: 'c' }),
    transitionProcedureName({ workflow: 'w', from: 'a', to: 'b-c' })
  );
  // (ALL)은 이름에서 any로 선다. 그래서 any라는 노드는 출발 자리에 설 수 없다.
  assert.strictEqual(transitionProcedureName({ workflow: 'w', from: workflow.TRANSITION_WILDCARD, to: 'done' }), 'transition.w.any.done');
  assert.throws(() => transitionProcedureName({ workflow: 'w', from: 'any', to: 'done' }), /any/u);
  // 이름 조각이 될 수 없는 노드는 조용히 뭉개지 않는다. 뭉개면 서로 다른 두 전환이
  // 같은 이름에 도착한다.
  assert.throws(() => transitionProcedureName({ workflow: 'w', from: '진행중', to: 'done' }), /절차 이름을 지을 수 없습니다/u);

  // 빈 목록은 걸린 것도 안 걸린 것도 아니다. 지운 것과 같은 뜻으로 읽으면 런을 여는지가
  // 아무도 안 보는 빈 배열 하나로 뒤집힌다.
  assert.throws(() => transitionOpensRun({ from: 'todo', to: 'doing', execution: [] }), /비어 있습니다/u);
  // 승인 칸은 지금 모양 그대로만 받는다. 걸지 않으려면 칸을 지우는 것이 그 뜻이다.
  assert.throws(
    () => procedureFromTransition({ from: 'todo', to: 'doing', approval: { human: false } }, { workflow: 'w', targetKind: 'task', units: taskUnits }),
    /human: true/u
  );
  // 시작할 수 있는 절차는 자기가 무엇을 움직이는지 밝힌다. 워크플로가 대상 종류를 주지
  // 않으면 그 전환에서 만든 절차는 대상 없는 절차가 된다.
  assert.throws(
    () => procedureFromTransition({ from: 'todo', to: 'doing', execution: ['claim'] }, { workflow: 'w', targetKind: undefined, units: taskUnits }),
    /대상 종류가 없거나/u
  );
  // 이름이 곧 스텝 ID다. 정의가 자기 ID를 들면 워크플로가 부르는 이름과 원장에 남는
  // 이름이 갈린다.
  assert.throws(
    () => procedureFromTransition({ from: 'todo', to: 'doing', execution: ['claim'] }, { workflow: 'w', targetKind: 'task', units: { claim: { id: 'other', executor: 'cli' } } }),
    /이름이 곧 ID/u
  );
  // 가리키는 정의가 없으면 그 슬롯은 아무것으로도 컴파일되지 않는다. 조용히 건너뛰면
  // 설정에 적힌 단위가 도는 줄 알면서 아무 일도 일어나지 않는다.
  assert.throws(
    () => procedureFromTransition({ from: 'todo', to: 'doing', execution: ['missing'] }, { workflow: 'w', targetKind: 'task', units: taskUnits }),
    /실행 단위 정의가 없습니다/u
  );

  // ── 사람 게이트는 상속으로 제거되지 않는다 ────────────────────────────
  //
  // 워크플로는 전환 목록을 층 단위로 갈아탄다. 하위 층이 같은 전환을 승인 칸 없이 다시
  // 적으면 그 전환에 걸렸던 사람 게이트가 사라지는데, 손으로 적은 절차에는 그것을 막는
  // 규율이 이미 있다. 전환에서 만든 절차도 같은 규율을 탄다.
  {
    const layer = (source, transitions) => ({ source, workflow: 'task-default', targetKind: 'task', units: taskUnits, transitions });
    const gated = [{ from: 'review', to: 'done', execution: ['claim'], approval: { human: true, reason: '릴리스는 되돌릴 수 없다' } }];
    assert.throws(
      () => resolveTransitionProcedures([layer('작업공간', gated), layer('프로젝트', [{ from: 'review', to: 'done', execution: ['claim'] }])]),
      /제거할 수 없습니다/u,
      '하위 층이 사람 게이트를 지웠는데 통과했습니다.'
    );
    // 조이는 방향은 통과해야 한다. 전부 막으면 상속이 아니라 동결이고, 얼어붙은 규율은
    // 사람들이 꺼 버린다.
    assert.doesNotThrow(() => resolveTransitionProcedures([
      layer('작업공간', gated),
      layer('프로젝트', [{ from: 'review', to: 'done', input: ['note'], execution: ['claim'], approval: { human: true, reason: '릴리스는 되돌릴 수 없다' } }])
    ]));
    // 승인 칸의 이유가 사람 앞까지 간다. 이유가 절차에 실리지 않으면 게이트에 선 사람은
    // 자기가 무엇을 판단해야 하는지를 설정 파일에서 찾아야 한다.
    const registry = resolveTransitionProcedures([layer('작업공간', gated)]);
    assert.deepStrictEqual(registry.names, ['transition.task-default.review.done']);
    const resolvedGate = registry.resolve('transition.task-default.review.done');
    assert.strictEqual(resolvedGate.source, '작업공간');
    assert.deepStrictEqual(
      resolvedGate.resolved.steps.map((step) => [step.id, step.human === true, step.reason === undefined ? null : step.reason]),
      [['claim', false, null], ['approval', true, '릴리스는 되돌릴 수 없다']]
    );
    // 한 층에 같은 전환이 둘이면 어느 것이 절차인지 갈린다. 이긴 쪽이 승인 칸을 안 든
    // 쪽일 수 있으므로 조용히 첫 번째를 쓰지 않는다.
    assert.throws(() => resolveTransitionProcedures([layer('작업공간', gated.concat(gated))]), /같은 전환이 이 층에 둘/u);
    // 검증만 걸린 전환은 절차가 없으므로 표에도 서지 않는다.
    assert.deepStrictEqual(resolveTransitionProcedures([layer('작업공간', [{ from: 'todo', to: 'doing', validation: ['has-owner'] }])]).names, []);
  }

  // 반쪽만 채워진 전환 출처는 없는 것보다 나쁘다. 없으면 물을 수 없다는 것을 알지만,
  // 반쪽만 있으면 원장이 답할 수 있는 것처럼 보이고 그 답은 틀리다.
  for (const origin of [{ workflow: 'w', from: 'a' }, { workflow: 'w', from: 'a', to: '' }, { workflow: 'w', from: 'a', to: 'b', extra: 1 }]) {
    assert.throws(
      () => runLedger.validateProcedure({ name: 'p', revision: 1, transition: origin, steps: [{ id: 'do', executor: 'client' }] }),
      /전환 출처/u,
      `반쪽 출처가 통과했습니다: ${JSON.stringify(origin)}`
    );
  }
}


try {
  const bare = path.join(temporary, 'origin.git');
  command('git', ['init', '--bare', '--initial-branch=main', bare], temporary);
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  command('git', ['remote', 'add', 'origin', bare], temporary);
  command('git', ['push', 'origin', 'main'], temporary);
  rdl(['init', 'crm', '--name', '고객 관리', '--profile', 'lean']);
  rdl(['contract', 'set', '--project', 'crm', '--profile', 'lean', '--enforcement', 'advisory']);
  rdl(['client', 'register', 'laptop-a', '--name', '업무 노트북', '--type', 'device', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'agent-a', '--name', '동기화 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'reviewer-a', '--name', '검토자', '--type', 'human', '--owner', 'MEMBER-001']);

  // 문서 1개 = 기능 1개 기본: REQ에 기능 2개는 --grouped로도 열리지 않는다.
  const resumeArtifact = rdl(['doc', 'create', 'PRD', '재개 검증', '--project', 'crm', '--owner', 'MEMBER-001', '--scope', '검증 요청 재개 흐름', '--exclude', '외부 시스템 연동']);
  const projectRoot = path.join(temporary, 'projects', 'crm');
  fs.writeFileSync(path.join(projectRoot, 'harness.json'), `${JSON.stringify({ schemaVersion: 1, revision: 1, adapters: { fixture: { enabled: true, command: process.execPath, argsTemplate: [], timeoutSeconds: 5 } }, verify: { defaultAdapter: 'fixture', defaultLenses: ['satisfaction-v1'] } }, null, 2)}\n`, 'utf8');
  command('git', ['add', '.'], projectRoot); command('git', ['commit', '-m', 'add verify resume fixture'], projectRoot);
  const resumeRevision = command('git', ['rev-parse', 'HEAD'], projectRoot);
  const resumeRootId = 'REQ-91919191919191919191'; const resumeLens = 'satisfaction-v1'; const resumeInstruction = pinInstruction('verify-satisfaction-v1');
  const resumeAdapter = { name: 'fixture', instructionId: resumeInstruction.id, instructionRevision: resumeInstruction.revision, instructionDigest: resumeInstruction.instructionDigest };
  const resumeDigest = verifyCommandDigest({ project: 'crm', targetId: resumeArtifact.id, reviewedRevision: resumeRevision, clientId: 'agent-a', adapter: 'fixture', lenses: [resumeLens] });
  const resumeJournal = requestJournal.prepareRoot(runtimeWorkspace(temporary), { rootRequestId: resumeRootId, commandDigest: resumeDigest, clientId: 'agent-a' });
  const resumeValidator = validatorInstanceId(resumeRootId, resumeArtifact.id, resumeRevision, resumeLens, 1); const resumeInvocationId = invocationId(resumeValidator); const resumeChildKey = `verdict:${resumeArtifact.id}:${resumeRevision}:${resumeLens}:1`;
  const resumeDescriptor = invocationDescriptor({ childKey: resumeChildKey, invocationId: resumeInvocationId, validatorInstanceId: resumeValidator, lens: resumeLens, slot: 1, targetPath: path.relative(projectRoot, resumeArtifact.file).replace(/\\/gu, '/'), instruction: resumeInstruction, adapter: resumeAdapter, command: { project: 'crm', targetId: resumeArtifact.id, reviewedRevision: resumeRevision, clientId: 'agent-a', adapter: 'fixture', lenses: [resumeLens] } });
  requestJournal.prepareInvocation(resumeJournal, { invocationKey: resumeChildKey, descriptor: resumeDescriptor }); requestJournal.updateInvocation(resumeJournal, resumeChildKey, 'running', { pid: process.pid });
  const resumeDirectory = path.join(projectRoot, '.rundol', 'verify', resumeInvocationId); fs.mkdirSync(resumeDirectory, { recursive: true });
  const resumeInstructionBytes = Buffer.from(JSON.stringify({ id: resumeInstruction.id, revision: resumeInstruction.revision, instructionDigest: resumeInstruction.instructionDigest }), 'utf8');
  const resumeContextBytes = Buffer.from(JSON.stringify({ target: resumeDescriptor.targetPath, lensId: resumeLens, pin: { targetId: resumeArtifact.id, reviewedRevision: resumeRevision }, instructionId: resumeInstruction.id }), 'utf8');
  const resumeResultBytes = Buffer.from(JSON.stringify({ verdict: 'pass', findings: [] }), 'utf8');
  fs.writeFileSync(path.join(resumeDirectory, 'instruction.json'), resumeInstructionBytes);
  fs.writeFileSync(path.join(resumeDirectory, 'context.json'), resumeContextBytes);
  fs.writeFileSync(path.join(resumeDirectory, 'result.json'), resumeResultBytes);
  fs.writeFileSync(path.join(resumeDirectory, 'receipt.json'), JSON.stringify({
    schemaVersion: 1, instanceId: resumeInvocationId, adapter: resumeAdapter,
    manifestHashes: { instruction: sha256(resumeInstructionBytes), context: sha256(resumeContextBytes) },
    exitCategory: 'success', resultHash: sha256(resumeResultBytes)
  }), 'utf8');
  const liveResume = rdlRaw(['run', 'request', 'resume', resumeRootId, '--client-id', 'agent-a']); assert.strictEqual(liveResume.status, 2); assert(/still live/u.test(liveResume.stderr));
  requestJournal.updateInvocation(resumeJournal, resumeChildKey, 'running', { pid: 2147483646 });
  const resumedVerification = rdl(['run', 'request', 'resume', resumeRootId, '--client-id', 'agent-a']);
  assert.strictEqual(resumedVerification.verification.status, 'passed');
  assert.strictEqual(resumedVerification.children.length, 1, 'resuming an invocation must preserve the recorded verdict child');
  assert.strictEqual(resumedVerification.children[0].phase, 'complete');
  const resumedJournal = requestJournal.loadJournal(runtimeWorkspace(temporary), resumeRootId).journal;
  assert.strictEqual(resumedJournal.children[resumeChildKey].phase, 'complete');
  assert.strictEqual(resumedJournal.invocations[resumeChildKey].phase, 'complete');

  const rejectedCreate = rdlRaw(['doc', 'create', 'REQ', '결제 요구', '--project', 'crm', '--owner', 'MEMBER-001', '--scope', '결제 승인 요구', '--exclude', '환불 흐름', '--function-id', 'FN-001', '--function-id', 'FN-002', '--grouped', '--reason', '사유']);
  assert.notStrictEqual(rejectedCreate.status, 0);
  assert(/기능 1개만/u.test(rejectedCreate.stderr), rejectedCreate.stderr);

  // 내장 절차가 단일 소스로 열거된다.
  const procedures = rdl(['run', 'procedures', '--project', 'crm']);
  const authored = procedures.procedures.find((item) => item.name === 'document.authored');
  assert(authored, '내장 절차 document.authored가 없습니다');
  assert.strictEqual(authored.source, '내장');
  const verified = procedures.procedures.find((item) => item.name === 'document.verified');
  assert(verified, 'P1.5 내장 절차 document.verified가 없습니다');
  const verifiedDefinition = loadProcedures(temporary, 'crm').resolve('document.verified').resolved;
  const authorStep = verifiedDefinition.steps.find((step) => step.id === 'author');
  const verifyStep = verifiedDefinition.steps.find((step) => step.id === 'verify');
  assert.deepStrictEqual(Object.keys(authorStep.instruction).sort(), ['id', 'instructionDigest', 'revision']);
  assert.deepStrictEqual(Object.keys(verifyStep.verify.instructions).sort(), ['boundary-v1', 'omission-v1', 'satisfaction-v1']);
  // 저작을 포함하는 절차의 검증은 저장이 만든 커밋을 본다. run 시작 시점으로
  // 굳히면 저작 결과를 볼 수 없고, "지금 HEAD"로 두면 그 사이 다른 프로세스가
  // 만든 커밋을 저작 결과로 판정한다.
  assert.deepStrictEqual(verifyStep.verify.revisionPin, { strategy: 'step-output-commit', step: 'save' });

  // Run-bound verification result is converted to a deterministic run.gate child under the same root request.
  // revision 2는 문서를 만들지 않는다. 대상 문서를 run 시작 시 고정하고, 절차는
  // 그것을 쓰고·검사하고·검증하고·저장한 뒤 사람 앞에서 멈춘다.
  const verificationRun = rdl(['run', 'start', 'document.verified', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', resumeArtifact.id]);
  // 런이 무엇을 움직이는지 표면이 되짚지 않고 답을 받는다. 식별자만 받으면 표면마다
  // 생김새로 종류를 다시 판정하게 되고, 다시 판정한 것들은 조금씩 달라진다.
  assert.deepStrictEqual(
    rdl(['run', 'next', '--run', verificationRun.runId, '--project', 'crm']).target,
    { kind: 'document', id: resumeArtifact.id },
    '문서 런이 자기 대상을 답하지 않습니다'
  );
  const startedPin = rdl(['run', 'log', '--run', verificationRun.runId, '--project', 'crm']).events.find((item) => item.type === 'run.started').procedure.resolved.steps.find((item) => item.id === 'verify').verify.revisionPin;
  // step-output-commit은 run 시작 시점에 굳힐 수 없다 — 그 커밋이 아직 없다.
  assert.strictEqual(startedPin.strategy, 'step-output-commit');
  assert.strictEqual(startedPin.step, 'save');
  assert.strictEqual(startedPin.reviewedRevision, undefined);
  // revision 2의 첫 스텝은 author다 — plan·create가 없다.
  rdl(['run', 'step', '--run', verificationRun.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', 'fixture author bypass']);
  rdl(['run', 'gate', '--run', verificationRun.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', 'fixture mechanical gate bypass']);
  // 저장이 검증보다 앞이다 — 검증은 저장이 만든 커밋을 본다.
  // 저장 스텝은 커밋을 만드는 스텝이므로, 사람이 대신 보고할 때도 어느 커밋인지
  // 밝혀야 한다. 밝히지 않은 성공은 검증이 결박될 곳을 남기지 않는다.
  rdl(['run', 'step', '--run', verificationRun.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', 'fixture save bypass', '--commit', command('git', ['rev-parse', 'HEAD'], projectRoot)]);
  const verificationRootId = 'REQ-CCCCCCCCCCCCCCCCCCCC';
  const verificationDigest = 'c'.repeat(64);
  requestJournal.prepareRoot(runtimeWorkspace(temporary), { rootRequestId: verificationRootId, commandDigest: verificationDigest, clientId: 'agent-a' });
  const transition = recordVerificationResult(temporary, {
    project: 'crm', run: verificationRun.runId, clientId: 'agent-a', positional: [resumeArtifact.id]
  }, {
    exitCode: 0, status: 'passed', targetId: resumeArtifact.id, rootRequestId: verificationRootId, commandDigest: verificationDigest,
    fold: { lenses: [{ lens: 'satisfaction-v1' }, { lens: 'omission-v1' }, { lens: 'boundary-v1' }] }
  });
  assert.strictEqual(transition.transition, 'run.gate');
  const repeatedTransition = recordVerificationResult(temporary, {
    project: 'crm', run: verificationRun.runId, clientId: 'agent-a', positional: [resumeArtifact.id]
  }, {
    exitCode: 0, status: 'passed', targetId: resumeArtifact.id, rootRequestId: verificationRootId, commandDigest: verificationDigest,
    fold: { lenses: [{ lens: 'satisfaction-v1' }, { lens: 'omission-v1' }, { lens: 'boundary-v1' }] }
  });
  assert.strictEqual(repeatedTransition.transitionEventId, transition.transitionEventId, 'same verification root must reuse its run transition');
  // 검증이 끝나면 남는 것은 사람 스텝뿐이다 — 저장은 그 앞에서 이미 지나갔다.
  assert.strictEqual(rdl(['run', 'next', '--run', verificationRun.runId, '--project', 'crm']).step.id, 'sync-gate');

  // 게이트를 제거하는 프로젝트 오버라이드는 로드 시점에 거부된다.
  const proceduresFile = path.join(temporary, 'projects', 'crm', 'procedures.json');
  fs.writeFileSync(proceduresFile, `${JSON.stringify({
    schemaVersion: 1,
    procedures: {
      'document.authored': {
        revision: 2,
        steps: [
          { id: 'plan', executor: 'cli', command: 'contract', args: ['next', '--project', '{project}', '--json'] },
          { id: 'create', executor: 'cli', command: 'doc', args: ['create'] },
          { id: 'author', executor: 'client' },
          { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}'] },
          { id: 'sync-gate', human: true }
        ]
      }
    }
  }, null, 2)}\n`, 'utf8');
  const rejected = rdlRaw(['run', 'procedures', '--project', 'crm']);
  assert.notStrictEqual(rejected.status, 0);
  assert(/게이트를 제거할 수 없습니다|스텝을 제거할 수 없습니다/u.test(rejected.stderr), rejected.stderr);

  // 스텝을 더하고 시도 상한을 조이는 오버라이드는 허용되고 revision이 갈린다.
  fs.writeFileSync(proceduresFile, `${JSON.stringify({
    schemaVersion: 1,
    procedures: {
      'document.authored': {
        revision: 2,
        steps: [
          { id: 'plan', executor: 'cli', command: 'contract', args: ['next', '--project', '{project}', '--json'] },
          { id: 'create', executor: 'cli', command: 'doc', args: ['create'] },
          { id: 'author', executor: 'client' },
          { id: 'peer-note', executor: 'client' },
          { id: 'mech-gate', gate: { command: 'check', args: ['{artifact}', '--strict'] }, onFail: { goto: 'author', maxAttempts: 2 } },
          { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}'] },
          { id: 'sync-gate', human: true }
        ]
      }
    }
  }, null, 2)}\n`, 'utf8');
  const overridden = rdl(['run', 'procedures', '--project', 'crm']);
  const local = overridden.procedures.find((item) => item.name === 'document.authored');
  assert.strictEqual(local.revision, 2);
  assert.notStrictEqual(local.contentHash, authored.contentHash);

  // 런 시작: 오버라이드된 절차가 pin된다.
  const started = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'laptop-a', '--goal', '결제 REQ']);
  const runId = started.runId;
  assert(/^RUN-[A-F0-9]{20}$/u.test(runId));

  // 런은 자기가 어느 태스크의 일인지 밝힐 수 있다. 저장이 결박을 파생할 때 첫 근거가
  // 되며, 런 시작에 고정되고 도중에 바뀌지 않는다 — 바뀔 수 있으면 그 런이 만든
  // 커밋들이 서로 다른 태스크를 가리킨다.
  {
    const bound = rdl(['task', 'add', '런이 밝히는 태스크', '--project', 'crm', '--client-id', 'laptop-a',
      '--summary', '런과 결박을 잇는다.', '--owner', 'MEMBER-001', '--acceptance', '이어진다.']);
    const taskRun = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'laptop-a', '--task', bound.taskId]);
    const log = rdl(['run', 'log', '--run', taskRun.runId, '--project', 'crm']);
    const startEvent = log.events.find((event) => event.type === 'run.started');
    assert.strictEqual(startEvent.taskId, bound.taskId, '런이 밝힌 태스크가 원장에 남지 않았습니다');
    // 선택 필드다. 밝히지 않은 런도 그대로 돌아야 한다.
    const plain = rdl(['run', 'log', '--run', runId, '--project', 'crm']);
    assert.strictEqual(plain.events.find((event) => event.type === 'run.started').taskId, undefined);
  }

  const procedureFixture = JSON.parse(fs.readFileSync(proceduresFile, 'utf8'));
  procedureFixture.procedures['environment.gate'] = {
    revision: 1,
    // 게이트 뒤에 런을 여는 스텝을 둔다. 게이트뿐인 절차는 런을 열지 않아 로드에서
    // 거부되고, 이 시험이 보려는 것은 게이트가 아니라 요청 저널의 복구다.
    targetKind: 'document',
    steps: [
      { id: 'env-gate', gate: { command: 'check', args: ['--definitely-unknown'] } },
      { id: 'env-report', executor: 'client' }
    ]
  };
  // 런이 태스크도 받는다. 오늘 문서 상태를 sed로 바꾸면 아무 기록도 남지 않는 것과
  // 같은 자리에 태스크가 있다 — 대상 종류가 태스크인 절차가 그것을 런 하나로 만든다.
  procedureFixture.procedures['task.moved'] = {
    revision: 1,
    targetKind: 'task',
    steps: [
      { id: 'decide', executor: 'client' },
      { id: 'approve', human: true }
    ]
  };
  fs.writeFileSync(proceduresFile, `${JSON.stringify(procedureFixture, null, 2)}\n`, 'utf8');
  const environmentRootId = 'REQ-BBBBBBBBBBBBBBBBBBBB';
  const environmentRun = rdl(['run', 'start', 'environment.gate', '--project', 'crm', '--client-id', 'laptop-a', '--request-id', environmentRootId]);
  assert.strictEqual(environmentRun.rootRequestId, environmentRootId);
  const environmentJournal = requestJournal.loadJournal(runtimeWorkspace(temporary), environmentRun.rootRequestId);
  const environmentChild = Object.values(environmentJournal.journal.children)[0];
  const environmentLocalFile = path.join(temporary, 'projects', 'crm', '.rundol', 'runs', environmentRun.runId, 'events.jsonl');
  fs.rmSync(environmentLocalFile);
  requestJournal.updateChild(environmentJournal, environmentChild.childKey, 'canonical-committed');
  const pendingRequests = rdl(['run', 'requests', '--pending']);
  assert(pendingRequests.requests.some((item) => item.rootRequestId === environmentRun.rootRequestId));
  const wrongResumeClient = rdlRaw(['run', 'request', 'resume', environmentRun.rootRequestId, '--client-id', 'agent-a']);
  assert.strictEqual(wrongResumeClient.status, 2);
  assert.strictEqual(fs.existsSync(environmentLocalFile), false);
  const repairedRequest = rdl(['run', 'request', 'resume', environmentRun.rootRequestId, '--client-id', 'laptop-a']);
  assert.strictEqual(repairedRequest.children[0].status, 'projection-repaired');
  const repairedEvent = JSON.parse(fs.readFileSync(environmentLocalFile, 'utf8').trim());
  assert.strictEqual(repairedEvent.eventId, environmentChild.eventId);
  assert.strictEqual(rdl(['run', 'request', 'resume', environmentRun.rootRequestId, '--client-id', 'laptop-a']).children[0].status, 'already-complete');

  // 대상이 태스크인 절차는 태스크를 만들지 않으므로 대상 없이 시작할 수 없다. 시작
  // 시점에 묻지 않으면 런이 끝까지 돌고도 무엇을 움직였는지 답하지 못한다.
  {
    const moved = rdl(['task', 'add', '런이 움직이는 태스크', '--project', 'crm', '--client-id', 'laptop-a',
      '--summary', '런의 대상이 된다.', '--owner', 'MEMBER-001', '--acceptance', '움직인다.']);
    const withoutTarget = rdlRaw(['run', 'start', 'task.moved', '--project', 'crm', '--client-id', 'laptop-a']);
    assert.notStrictEqual(withoutTarget.status, 0, '대상 없는 태스크 런이 시작됐습니다');
    assert.match(`${withoutTarget.stdout}${withoutTarget.stderr}`, /태스크를 움직이는 절차/u, `${withoutTarget.stdout}${withoutTarget.stderr}`);
    // 문서를 주는 것은 인수를 더 준 것이 아니라 대상을 잘못 준 것이다. 조용히 무시하면
    // 시작한 사람은 자기가 무엇을 대상으로 걸었는지 끝까지 모른다.
    const wrongTarget = rdlRaw(['run', 'start', 'task.moved', '--project', 'crm', '--client-id', 'laptop-a', '--task', moved.taskId, '--artifact-id', 'REQ-001']);
    assert.notStrictEqual(wrongTarget.status, 0, '태스크 절차가 문서 대상을 받았습니다');
    const taskRun = rdl(['run', 'start', 'task.moved', '--project', 'crm', '--client-id', 'laptop-a', '--task', moved.taskId]);
    assert.deepStrictEqual(
      rdl(['run', 'next', '--run', taskRun.runId, '--project', 'crm']).target,
      { kind: 'task', id: moved.taskId },
      '태스크 런이 자기 대상을 답하지 않습니다'
    );

    // 전환 하나가 절차 하나가 되어 런을 연다. 절차 목록에 없는 이름으로 런이 열린다는
    // 것이 곧 전환이 절차를 만들었다는 뜻이다 — 오늘 보드에서 상태를 바꾸면 아무 기록도
    // 남지 않는 자리가 여기서 런 하나가 된다.
    const transitionRun = startTransitionRun(temporary, {
      project: 'crm', clientId: 'laptop-a', task: moved.taskId,
      workflow: 'task-default', targetKind: 'task',
      transition: { from: 'doing', to: 'review', input: ['decide'], approval: { human: true, reason: '검토는 다른 사람이 연다' } },
      units: { decide: { executor: 'client' } }
    });
    const transitionNext = rdl(['run', 'next', '--run', transitionRun.runId, '--project', 'crm']);
    assert.strictEqual(transitionNext.procedure.name, 'transition.task-default.doing.review');
    assert.deepStrictEqual(transitionNext.target, { kind: 'task', id: moved.taskId }, '전환에서 연 런이 자기 대상을 답하지 않습니다');
    const transitionStarted = rdl(['run', 'log', '--run', transitionRun.runId, '--project', 'crm']).events.find((event) => event.type === 'run.started');
    // 원장은 어느 전환을 수행했는지에 pin된 절차로 답한다. 이벤트에 따로 적으면 같은
    // 사실이 두 곳에 있게 되고, 두 곳은 갈린다.
    assert.deepStrictEqual(transitionStarted.procedure.resolved.transition, { workflow: 'task-default', from: 'doing', to: 'review' });
    assert.deepStrictEqual(
      transitionStarted.procedure.resolved.steps.map((step) => [step.id, step.reason === undefined ? null : step.reason]),
      [['decide', null], ['approval', '검토는 다른 사람이 연다']]
    );
    // 검증만 걸린 전환으로는 런을 열 수 없다. 열면 그 런은 판정 함수가 이미 답한 것을
    // 다시 묻고, 원장에 남길 것이 없다.
    assert.throws(() => startTransitionRun(temporary, {
      project: 'crm', clientId: 'laptop-a', task: moved.taskId,
      workflow: 'task-default', targetKind: 'task',
      transition: { from: 'doing', to: 'review', validation: ['owned'] },
      units: { owned: { gate: { command: 'check', args: ['{task}', '--strict'] } } }
    }), /런을 열지 않습니다/u);
  }

  // 종류를 밝히지 않은 새 절차는 열리지 않는다. 부모가 없으면 상속받을 곳도 없다.
  {
    const kindless = JSON.parse(fs.readFileSync(proceduresFile, 'utf8'));
    kindless.procedures['kindless'] = { revision: 1, steps: [{ id: 'do', executor: 'client' }] };
    fs.writeFileSync(proceduresFile, `${JSON.stringify(kindless, null, 2)}
`, 'utf8');
    const rejected = rdlRaw(['run', 'procedures', '--project', 'crm']);
    assert.notStrictEqual(rejected.status, 0, '대상 종류 없는 절차가 열렸습니다');
    assert.match(rejected.stderr, /대상 종류가 없거나/u, rejected.stderr);
    delete kindless.procedures['kindless'];
    fs.writeFileSync(proceduresFile, `${JSON.stringify(kindless, null, 2)}
`, 'utf8');
  }

  // 전환이 만드는 절차의 이름 공간은 워크플로가 갖는다. procedures.json이 그 자리에
  // 서면 워크플로가 세운 절차를 조용히 대신하게 되고, 그 절차에 걸린 사람 게이트가
  // 사라진 것을 아무도 모른다.
  {
    const squatted = JSON.parse(fs.readFileSync(proceduresFile, 'utf8'));
    squatted.procedures[`${TRANSITION_PROCEDURE_PREFIX}.task-default.review.done`] = { revision: 1, targetKind: 'task', steps: [{ id: 'do', executor: 'client' }] };
    fs.writeFileSync(proceduresFile, `${JSON.stringify(squatted, null, 2)}
`, 'utf8');
    const rejected = rdlRaw(['run', 'procedures', '--project', 'crm']);
    assert.notStrictEqual(rejected.status, 0, '전환 이름 공간을 손으로 적은 절차가 열렸습니다');
    assert.match(rejected.stderr, /이름 공간은 워크플로 전환이 갖습니다/u, rejected.stderr);
    delete squatted.procedures[`${TRANSITION_PROCEDURE_PREFIX}.task-default.review.done`];
    fs.writeFileSync(proceduresFile, `${JSON.stringify(squatted, null, 2)}
`, 'utf8');
  }

  // 오버라이드가 적지 않은 대상 종류는 부모에게서 온다. 계층마다 다시 적게 하면 한 번
  // 빠뜨린 계층이 조용히 대상 없는 절차가 된다.
  assert.strictEqual(loadProcedures(temporary, 'crm').resolve('document.authored').resolved.targetKind, 'document');

  // Prepared semantic children use their canonical type, not a historical child-key prefix, when resuming.
  const semanticRun = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'agent-a']);
  const semanticStarted = rdl(['run', 'log', '--run', semanticRun.runId, '--project', 'crm']).events.find((event) => event.type === 'run.started');
  const transitionRootId = 'REQ-DDDDDDDDDDDDDDDDDDDD';
  const transitionChildKey = `transition:crm:${semanticRun.runId}:none:run.halted`;
  const transitionRequestId = requestJournal.childRequestId(transitionRootId, transitionChildKey);
  const transitionEventId = requestJournal.eventIdForRequest(transitionRequestId);
  const transitionRoot = requestJournal.prepareRoot(runtimeWorkspace(temporary), { rootRequestId: transitionRootId, commandDigest: 'd'.repeat(64), clientId: 'agent-a' });
  const transitionEnvelope = runLedger.createEventEnvelope({
    schemaVersion: 2, eventId: transitionEventId, type: 'run.halted', rootRequestId: transitionRootId,
    requestId: transitionRequestId, clientId: 'agent-a', projectId: 'crm', runId: semanticRun.runId,
    ownerToken: semanticStarted.ownerToken, reason: 'manual', resumable: true
  });
  requestJournal.prepareChild(transitionRoot, { childKey: transitionChildKey, canonicalBytes: transitionEnvelope.canonicalBytes, runId: semanticRun.runId });
  const resumedTransition = rdl(['run', 'request', 'resume', transitionRootId, '--client-id', 'agent-a']);
  assert.strictEqual(resumedTransition.children[0].status, 'canonical-replayed');
  assert.strictEqual(requestJournal.loadJournal(runtimeWorkspace(temporary), transitionRootId).journal.phase, 'complete');
  assert(rdl(['run', 'log', '--run', semanticRun.runId, '--project', 'crm']).events.some((event) => event.eventId === transitionEventId));

  const driverRootId = 'REQ-EEEEEEEEEEEEEEEEEEEE';
  const operationId = 'f'.repeat(64);
  const driverChildKey = `driver:${operationId}:acquire:`;
  const driverRequestId = requestJournal.childRequestId(driverRootId, driverChildKey);
  const driverEventId = requestJournal.eventIdForRequest(driverRequestId);
  const driverRoot = requestJournal.prepareRoot(runtimeWorkspace(temporary), { rootRequestId: driverRootId, commandDigest: 'e'.repeat(64), clientId: 'agent-a' });
  const preparedDriver = {
    schemaVersion: 1, eventId: driverEventId, type: 'driver.acquired', rootRequestId: driverRootId,
    requestId: driverRequestId, clientId: 'agent-a', projectId: 'crm', runId: semanticRun.runId,
    leaseId: 'LEASE-EEEEEEEEEEEEEEEEEEEE', ownerToken: semanticStarted.ownerToken,
    expiresAt: '2031-01-01T00:00:00.000Z', operationId
  };
  requestJournal.prepareChild(driverRoot, { childKey: driverChildKey, canonicalBytes: driverLease.driverEnvelope(preparedDriver).canonicalBytes, runId: semanticRun.runId });
  const resumedDriver = rdl(['run', 'request', 'resume', driverRootId, '--client-id', 'agent-a']);
  assert.strictEqual(resumedDriver.children[0].status, 'canonical-replayed');
  assert.strictEqual(requestJournal.loadJournal(runtimeWorkspace(temporary), driverRootId).journal.phase, 'complete');
  const driverEvents = driverLease.readDriverEvents(path.join(temporary, 'projects', 'workspace', 'events'), 'crm', semanticRun.runId);
  assert(driverEvents.some((event) => event.eventId === driverEventId));

  const unsupportedRootId = 'REQ-AAAAAAAAAAAAAAAAAAAA';
  const unsupportedRoot = requestJournal.prepareRoot(runtimeWorkspace(temporary), {
    rootRequestId: unsupportedRootId,
    commandDigest: 'a'.repeat(64),
    clientId: 'laptop-a'
  });
  const unsupportedChildKey = 'verdict:REQ-001:revision:lens:1';
  const unsupportedRequestId = requestJournal.childRequestId(unsupportedRootId, unsupportedChildKey);
  const unsupportedEventId = requestJournal.eventIdForRequest(unsupportedRequestId);
  requestJournal.prepareChild(unsupportedRoot, {
    childKey: unsupportedChildKey,
    canonicalBytes: Buffer.from(canonicalJson({
      schemaVersion: 1, rootRequestId: unsupportedRootId, requestId: unsupportedRequestId,
      eventId: unsupportedEventId, type: 'verdict.recorded', clientId: 'laptop-a', projectId: 'crm'
    }), 'utf8')
  });
  const unsupportedResume = rdl(['run', 'request', 'resume', unsupportedRootId, '--client-id', 'laptop-a']);
  assert.strictEqual(unsupportedResume.children[0].status, 'unsupported-future-child');
  assert.strictEqual(requestJournal.loadJournal(runtimeWorkspace(temporary), unsupportedRootId).journal.children[unsupportedChildKey].phase, 'prepared');

  const environmentGate = rdlRaw(['run', 'gate', '--run', environmentRun.runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert.strictEqual(environmentGate.status, 2, environmentGate.stdout + environmentGate.stderr);
  assert(environmentGate.stdout.trim(), environmentGate.stderr);
  assert.strictEqual(JSON.parse(environmentGate.stdout).exitCode, 2);

  const missingClient = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm']);
  assert.strictEqual(missingClient.status, 2, missingClient.stdout + missingClient.stderr);
  const futureStep = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'create', '--client-id', 'laptop-a']);
  assert.strictEqual(futureStep.status, 2, futureStep.stdout + futureStep.stderr);

  // 절차 정의가 삭제돼도 진행 중 런은 pin으로 완주한다.
  fs.rmSync(proceduresFile);

  // next → step 보고의 대화형 루프. plan/create/author를 진행한다.
  let next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'plan');
  assert.deepStrictEqual(next.step.args, ['next', '--project', 'crm', '--json']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'create', '--artifact-id', 'REQ-001', '--client-id', 'laptop-a']);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'author');
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'peer-note', '--client-id', 'laptop-a']);

  // 게이트 스텝은 step 보고로 전진할 수 없다.
  const wrongStep = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'mech-gate', '--client-id', 'laptop-a']);
  assert.notStrictEqual(wrongStep.status, 0);

  // 게이트 실제 실행: 필수 필드가 빠진 REQ-001 문서를 심어 진짜 check 실패를 만든다.
  const brokenDocument = path.join(temporary, 'projects', 'crm', 'REQ-001-결제요구.md');
  fs.writeFileSync(brokenDocument, '---\nid: REQ-001\ntype: REQ\n---\n\n# 결제 요구\n', 'utf8');
  const gate = rdlRaw(['run', 'gate', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert.strictEqual(gate.status, 1, gate.stdout + gate.stderr);
  const gateResult = JSON.parse(gate.stdout);
  assert.strictEqual(gateResult.exitCode > 0, true);
  assert(gateResult.diagnostics.length > 0, '게이트가 진단 코드를 수집하지 못했습니다');
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'author');
  assert.strictEqual(next.attempts['mech-gate'], 1);

  // 재작업 후 사람이 사유와 함께 게이트를 우회하면 forced로 기록되고 전진한다.
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'peer-note', '--client-id', 'laptop-a']);
  const noReason = rdlRaw(['run', 'gate', '--run', runId, '--project', 'crm', '--force', '--client-id', 'laptop-a']);
  assert.notStrictEqual(noReason.status, 0);
  const forced = rdl(['run', 'gate', '--run', runId, '--project', 'crm', '--force', '--reason', '테스트 픽스처에는 실제 문서가 없다', '--client-id', 'laptop-a']);
  assert.strictEqual(forced.forced, true);
  fs.rmSync(brokenDocument);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'save');

  // 수동 정지와 재개.
  rdl(['run', 'halt', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  const haltedNext = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(haltedNext.status, 'halted');
  const blockedStep = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert.notStrictEqual(blockedStep.status, 0);
  rdl(['run', 'resume', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);

  // save와 sync-gate(사람 게이트)를 보고하고 완료한다. 저장은 커밋을 만드는 스텝
  // 이므로 어느 커밋인지 밝히지 않으면 성공으로 받아들이지 않는다.
  const withoutCommit = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'save', '--client-id', 'laptop-a']);
  assert.notStrictEqual(withoutCommit.status, 0, '커밋 없는 저장 보고가 통과했습니다');
  assert.match(`${withoutCommit.stdout}${withoutCommit.stderr}`, /커밋을 만드는 스텝/u, `${withoutCommit.stdout}${withoutCommit.stderr}`);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'save', '--client-id', 'laptop-a', '--commit', command('git', ['rev-parse', 'HEAD'], path.join(temporary, 'projects', 'crm'))]);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.human, true);
  // 클라이언트 중립 인터페이스도 실행 단위 종류를 그대로 답한다. 여기가 client로
  // 나오면 표면이 보는 종류와 절차가 아는 종류가 갈린 것이다.
  assert.strictEqual(next.step.executor, 'human');
  const humanWithoutAcknowledgement = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'sync-gate', '--client-id', 'laptop-a']);
  assert.strictEqual(humanWithoutAcknowledgement.status, 2);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'sync-gate', '--client-id', 'laptop-a', '--force', '--reason', '수동 동기화 승인']);
  const completed = rdl(['run', 'complete', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert(completed.commit);

  // 미완료 스텝이 있으면 complete가 거부되는지는 두 번째 런으로 확인한다.
  const second = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'laptop-a']);
  const incomplete = rdlRaw(['run', 'complete', '--run', second.runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert.notStrictEqual(incomplete.status, 0);
  assert(/완료되지 않은 스텝/u.test(incomplete.stderr));

  // sync가 성공하면 completed_local 런이 synced로 전이한다 — 두 번째 완료.
  // 이 픽스처의 런들은 사람 승인을 거치지 않았다. 공유하려면 사람의 판단이 필요하고,
  // 그것이 곧 --share-unverified가 --approved-by를 요구하는 이유다.
  rdl(['sync', '--project', 'crm', '--client-id', 'agent-a', '--share-unverified', '픽스처 런을 그대로 공유한다', '--approved-by', 'reviewer-a']);
  const listed = rdl(['run', 'list', '--project', 'crm']);
  const syncedRun = listed.runs.find((item) => item.runId === runId);
  assert.strictEqual(syncedRun.status, 'synced');
  const stillRunning = listed.runs.find((item) => item.runId === second.runId);
  assert.strictEqual(stillRunning.status, 'running');

  // 원장 열람.
  const log = rdl(['run', 'log', '--run', runId, '--project', 'crm']);
  assert(log.events.some((event) => event.type === 'run.forced'));
  assert(log.events.some((event) => event.type === 'run.synced'));

  process.stdout.write('run CLI tests passed\n');
} finally {
  restoreWindowsAdapterOptIn();
  fs.rmSync(temporary, { recursive: true, force: true });
}
