'use strict';

const assert = require('assert');
const {
  MODES, MODE_NAMES, DEFAULT_PROJECT_MODE, DEFAULT_WORKSPACE_FLOOR,
  modeDefinition, resolveMode, assertWithinFloor, floorPolicy, assertBasisAllowed
} = require('../src/approval-mode');
const { KINDS } = require('../src/decision');

// 네 모드가 손잡이 넷의 값을 모두 정한다. 하나라도 비면 그 자리는 부르는 쪽마다 다른
// 기본값을 쓰게 되고, 모드는 이름만 남는다.
assert.strictEqual(MODE_NAMES.length, 4);
for (const name of MODE_NAMES) {
  const mode = modeDefinition(name);
  assert.ok(['required', 'none'].includes(mode.humanGate), `${name}에 사람 게이트 값이 필요합니다`);
  assert.ok(Number.isInteger(mode.policy.validators), `${name}에 검증자 수가 필요합니다`);
  assert.ok(Number.isInteger(mode.policy.quorum), `${name}에 정족수가 필요합니다`);
  assert.strictEqual(typeof mode.policy.requireAdapterDiversity, 'boolean');
  assert.ok(Array.isArray(mode.basis) && mode.basis.length, `${name}에 허용 근거가 필요합니다`);
  assert.strictEqual(typeof mode.requiresDelegation, 'boolean');
  assert.ok(Number.isInteger(mode.rank));
}

// 강약 순서는 사람 게이트 요구를 먼저 보고 그다음 근거의 자율성을 본다. 검증자 수는
// 순위에 넣지 않는다 — 검증자를 늘리는 것은 조이는 일이고 모드를 푸는 것과 방향이 반대다.
const byRank = MODE_NAMES.slice().sort((left, right) => MODES[left].rank - MODES[right].rank);
assert.deepStrictEqual(byRank, ['human-only', 'ai-assisted', 'ai-first', 'ai-only']);
assert.strictEqual(MODES['human-only'].humanGate, 'required');
assert.strictEqual(MODES['ai-only'].humanGate, 'none');

// 검증자 수는 조이는 방향으로만 늘어난다. 순위가 오르는데 검증자가 줄면 "더 푼 모드가
// 더 적게 검증한다"가 되어, 푸는 것과 헐렁해지는 것이 같은 말이 된다.
for (let index = 1; index < byRank.length; index += 1) {
  const looser = MODES[byRank[index]];
  const tighter = MODES[byRank[index - 1]];
  assert.ok(looser.policy.validators >= tighter.policy.validators, `${byRank[index]}의 검증자가 더 적습니다`);
}

// 조합의 일부만 바꾸는 길이 없어야 한다. 두면 이름이 뜻을 잃고 "AI 우선인데 검증자가
// 하나"인 프로젝트가 생긴다.
assert.throws(() => resolveMode({ mode: 'ai-first', validators: 1 }), /부분적으로 바꿀 수 없습니다/u);
assert.throws(() => resolveMode('없는-모드'), /등록되지 않은 승인 모드/u);
assert.strictEqual(resolveMode('ai-first').name, 'ai-first');
assert.strictEqual(resolveMode({ mode: 'ai-only' }).name, 'ai-only');

// 바닥보다 푼 모드는 고를 수 없다. 바닥이 없으면 제약하지 않는다.
assertWithinFloor('human-only', 'ai-assisted');
assertWithinFloor('ai-assisted', 'ai-assisted');
assert.throws(() => assertWithinFloor('ai-first', 'ai-assisted'), /바닥보다 풀 수 없습니다/u);
assert.throws(() => assertWithinFloor('ai-only', 'human-only'), /바닥보다 풀 수 없습니다/u);
assertWithinFloor('ai-only', null);

// 기본값. 새 프로젝트는 가장 조인 쪽에서 시작한다 — 푸는 것은 결정으로 남지만 조인 채로
// 시작하는 것은 아무 기록도 요구하지 않으므로, 기본값이 안전한 쪽이어야 처음 설치가 안전하다.
assert.strictEqual(DEFAULT_PROJECT_MODE, 'human-only');
assert.strictEqual(MODES[DEFAULT_PROJECT_MODE].rank, 0, '기본 모드는 가장 조인 쪽이어야 합니다');
// 바닥은 선언하지 않으면 제약하지 않는다. 여기서도 가장 조인 쪽을 기본으로 두면 모든
// 프로젝트가 얼어붙어, 결국 바닥을 통째로 꺼 버린다. 꺼진 바닥은 없는 바닥보다 나쁘다.
assert.strictEqual(DEFAULT_WORKSPACE_FLOOR, null);

// 모드가 정하는 검증 정책은 최소값이다. 파이프가 더 올릴 수 있고 내릴 수 없다.
const floor = floorPolicy('ai-first');
assert.strictEqual(floor.validators, 2);
assert.strictEqual(floor.requireAdapterDiversity, true);
floor.validators = 99;
assert.strictEqual(floorPolicy('ai-first').validators, 2, '바닥 정책이 밖에서 변형되면 안 됩니다');

// 승인 근거의 자격을 모드가 정한다. 사람만 모드에서 판정을 근거로 받으면 AI 판정이
// 없는데 있는 것처럼 기록된다.
assertBasisAllowed('human-only', ['read']);
assert.throws(() => assertBasisAllowed('human-only', ['verdict']), /verdict 근거를 쓸 수 없습니다/u);
assertBasisAllowed('ai-assisted', ['read', 'verdict']);
assertBasisAllowed('ai-first', ['verdict']);

// AI만 모드는 승인이 없다는 뜻이 아니다. 사람이 미리 위임한 명의로 AI가 승인하고 그
// 위임은 만료되고 취소된다. 책임 주체는 어느 모드에서도 사람으로 남는다.
assertBasisAllowed('ai-only', ['delegated']);
assert.throws(() => assertBasisAllowed('ai-only', ['read']), /read 근거를 쓸 수 없습니다/u);
assert.throws(() => assertBasisAllowed('ai-only', []), /위임된 근거가 필요합니다/u);

// 위임 불가 티어는 어느 모드에서도 열리지 않는다. 모드는 위임 가능한 범위 안에서만
// 배분을 바꾼다. 목록을 시험이 다시 적으면 티어가 늘어날 때 새 항목이 검증되지 않은
// 채로 남으므로 카탈로그에서 가져와 전수로 돈다.
const undelegable = Object.entries(KINDS).filter(([, definition]) => !definition.delegable).map(([kind]) => kind);
assert.ok(undelegable.length >= 5, '위임 불가 티어가 비어 있으면 이 시험은 아무것도 지키지 않습니다');
for (const name of MODE_NAMES) {
  for (const kind of undelegable) {
    assert.strictEqual(KINDS[kind].delegable, false, `${name} 모드에서도 ${kind}는 위임 불가여야 합니다`);
  }
}

// 파이프 허용정책. 프로젝트 모드 하나로는 부족하다 — 같은 프로젝트 안에서도 문서를
// 쓰는 구간과 밖으로 내보내는 구간은 되돌릴 수 있는 정도가 다르다. 그렇다고 구간마다
// 자유롭게 정할 수 있으면 모드는 선언에 그친다. 모드가 바닥이고 스텝은 그 위에서 조인다.
{
  const { validateOverride, assertAllowWithinFloor } = require('../src/procedure');
  const base = { executors: ['adapter', 'client'], humanGate: 'required', minValidators: 2, requireDiversity: true };
  const withAllow = (allow) => ({ steps: [{ id: 'verify', executor: 'adapter', allow }] });
  const parent = withAllow(base);
  const tweak = (patch) => Object.assign({}, base, patch);
  const override = (allow) => validateOverride('f', parent, withAllow(allow), 'fixture');

  // 조이는 방향은 통과해야 한다. 전부 막으면 단조성이 아니라 동결이다.
  override(tweak({ executors: ['adapter'] }));
  override(tweak({ minValidators: 4 }));
  override(tweak({}));

  // 조임 방향이 손잡이마다 다르다. 검증자 수는 클수록 조이고 허용 주체는 적을수록 조인다.
  assert.throws(() => override(tweak({ executors: ['adapter', 'client', 'cli'] })), /허용되지 않은 주체/u, '허용 주체를 늘릴 수 없어야 합니다');
  assert.throws(() => override(tweak({ humanGate: 'optional' })), /humanGate/u, '사람 게이트를 완화할 수 없어야 합니다');
  assert.throws(() => override(tweak({ minValidators: 1 })), /minValidators/u, '검증자 요구를 내릴 수 없어야 합니다');
  assert.throws(() => override(tweak({ requireDiversity: false })), /requireDiversity/u, '다양성 요구를 끌 수 없어야 합니다');
  assert.throws(() => override(undefined), /허용정책을 제거/u);
  assert.throws(() => override({ executors: ['adapter'], humanGate: 'required', minValidators: 2 }), /제거할 수 없습니다/u, '손잡이 하나를 빼는 것도 완화입니다');

  // 방향이 선언되지 않은 손잡이는 조용히 빠지지 않는다.
  const mystery = withAllow({ executors: ['adapter'], mysteryKnob: 1 });
  assert.throws(() => validateOverride('f', mystery, mystery, 'fixture'), /조임 방향이 선언되지 않았습니다/u);

  // 바닥은 판정에만 쓰고 스텝에 저장하지 않는다 — 저장하면 모드를 바꿨을 때 굳어 버린
  // 옛 바닥이 스텝에 남는다.
  const floor = floorPolicy('ai-first');
  const step = (allow) => ({ id: 'verify', allow });
  assert.throws(() => assertAllowWithinFloor('f', step({ minValidators: 1, requireDiversity: true }), floor, 'fixture'), /바닥보다 검증자를 적게/u);
  assert.throws(() => assertAllowWithinFloor('f', step({ minValidators: 2, requireDiversity: false }), floor, 'fixture'), /다양성을 끕니다/u);
  assertAllowWithinFloor('f', step({ minValidators: 2, requireDiversity: true }), floor, 'fixture');
  assertAllowWithinFloor('f', step({ minValidators: 5, requireDiversity: true }), floor, 'fixture');
}

// 바닥은 올리는 것이지 벽이 아니다. 바닥보다 낮은 선언을 거부하면 조직이 바닥을 까는
// 순간 내장 절차가 로드에 실패하고 — 내장은 검증자 하나를 선언한다 — 그러면 사람들은
// 바닥을 꺼 버린다. 꺼진 바닥은 없는 바닥보다 나쁘다.
{
  const { liftToFloor } = require('../src/procedure');

  const procedure = {
    steps: [
      { id: 'author', executor: 'adapter' },
      { id: 'verify', executor: 'adapter', verify: { lenses: ['satisfaction-v1'], policy: { validators: 1, quorum: 1, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: false } } }
    ]
  };

  const raised = liftToFloor(procedure, floorPolicy('ai-first'));
  const lifted = raised.steps.find((step) => step.id === 'verify').verify.policy;
  assert.strictEqual(lifted.validators, 2, '바닥이 검증자를 끌어올려야 합니다');
  assert.strictEqual(lifted.requireAdapterDiversity, true, '바닥이 다양성 요구를 켜야 합니다');
  assert.strictEqual(lifted.maxRefuted, 0, '바닥이 건드리지 않는 값은 그대로여야 합니다');

  // 끌어올린 값은 해석 결과에만 있다. 원본을 고치면 모드를 되돌려도 돌아갈 곳이 없다.
  assert.strictEqual(procedure.steps[1].verify.policy.validators, 1, '원본이 변형되면 안 됩니다');
  assert.strictEqual(procedure.steps[1].verify.policy.requireAdapterDiversity, false);

  // 정족수는 검증자를 넘을 수 없다. 검증자만 올리고 정족수를 그대로 두면 통과 불가능한
  // 정책이 만들어지고, 그 절차는 영원히 완주하지 못한다.
  const skewed = { steps: [{ id: 'verify', executor: 'adapter', verify: { policy: { validators: 1, quorum: 5 } } }] };
  const fixed = liftToFloor(skewed, { validators: 2, quorum: 2, requireAdapterDiversity: false }).steps[0].verify.policy;
  assert.ok(fixed.quorum <= fixed.validators, '정족수가 검증자를 넘으면 안 됩니다');

  // 바닥이 없으면 그대로 둔다. 절차를 만질 이유가 없다.
  assert.strictEqual(liftToFloor(procedure, null), procedure);

  // 이미 바닥보다 조여 둔 스텝은 건드리지 않는다. 같은 객체가 그대로 돌아와야 한다.
  const already = { steps: [{ id: 'verify', executor: 'adapter', verify: { policy: { validators: 5, quorum: 5, requireAdapterDiversity: true } } }] };
  assert.strictEqual(liftToFloor(already, floorPolicy('ai-first')), already, '이미 조인 스텝은 그대로여야 합니다');
}

process.stdout.write('approval mode tests passed\n');
