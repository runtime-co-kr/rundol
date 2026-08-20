'use strict';

// 승인 모드. 사람과 AI가 함께 일할 때 사람 게이트를 어디에 둘지가 처리량을 정한다.
//
// 촘촘하게 깔면 시스템이 사람 속도로 떨어지고, 그러면 사람은 게이트를 읽지 않고
// 누르기 시작한다. 승인이 형식이 되는 순간 통제도 함께 사라지므로, 촘촘한 게이트는
// 통제가 아니라 통제의 외관이다. 그래서 모드는 신뢰의 눈금이 아니라 주의의 배분표다.
//
// 네 모드는 새 기제가 아니다. 사람 게이트 여부, 검증자 정책, 승인 근거의 종류, 위임
// 요구 — 이미 있는 손잡이 넷의 조합에 이름을 붙인 것이다. 이름을 붙이는 이유는 조합을
// 매번 손으로 맞추면 팀마다 다른 조합이 생기고 그 차이를 아무도 설명하지 못하기 때문이다.
//
// REQ-064가 규범이다.

// 조합 표는 코드가 갖는다. 파일이 조합을 정의할 수 있으면 같은 이름이 프로젝트마다
// 다른 뜻을 갖고, 그 순간 모드로 소통할 수 없다.
//
// rank는 강약 순서다. 사람 게이트 요구를 먼저 보고 그다음 승인 근거의 자율성을 본다.
// 검증자 수는 순위에 넣지 않는다 — 검증자를 늘리는 것은 조이는 일이고, 모드를 푸는
// 것과 방향이 반대다.
const MODES = Object.freeze({
  'human-only': Object.freeze({
    rank: 0,
    humanGate: 'required',
    policy: Object.freeze({ validators: 0, quorum: 0, requireAdapterDiversity: false }),
    basis: Object.freeze(['read', 'check']),
    requiresDelegation: false
  }),
  'ai-assisted': Object.freeze({
    rank: 1,
    humanGate: 'required',
    policy: Object.freeze({ validators: 1, quorum: 1, requireAdapterDiversity: false }),
    basis: Object.freeze(['read', 'check', 'verdict']),
    requiresDelegation: false
  }),
  'ai-first': Object.freeze({
    rank: 2,
    humanGate: 'required',
    policy: Object.freeze({ validators: 2, quorum: 2, requireAdapterDiversity: true }),
    basis: Object.freeze(['read', 'check', 'verdict']),
    requiresDelegation: false
  }),
  'ai-only': Object.freeze({
    rank: 3,
    humanGate: 'none',
    policy: Object.freeze({ validators: 3, quorum: 2, requireAdapterDiversity: true }),
    basis: Object.freeze(['delegated']),
    requiresDelegation: true
  })
});

const MODE_NAMES = Object.freeze(Object.keys(MODES));

// 새 프로젝트는 가장 조인 쪽에서 시작한다. 푸는 것은 결정으로 남지만 조인 채로
// 시작하는 것은 아무 기록도 요구하지 않으므로, 기본값이 안전한 쪽이어야 처음
// 설치가 안전하다. 느슨하게 시작해 두면 아무도 조이지 않은 채로 굳는다.
const DEFAULT_PROJECT_MODE = 'human-only';

// 작업공간 바닥은 선언하지 않으면 제약하지 않는다. 여기서도 가장 조인 쪽을 기본으로
// 두면 모든 프로젝트가 사람만으로 얼어붙어, 조직이 아무것도 못 하고 결국 바닥을
// 통째로 꺼 버린다. 꺼진 바닥은 없는 바닥보다 나쁘다 — 껐다는 사실을 잊기 때문이다.
const DEFAULT_WORKSPACE_FLOOR = null;

function modeDefinition(name) {
  const definition = MODES[name];
  if (!definition) throw new Error(`등록되지 않은 승인 모드입니다: ${name || '(없음)'} (가능: ${MODE_NAMES.join(', ')})`);
  return definition;
}

// 모드 이름 하나가 조합 전체를 정한다. 조합의 일부만 바꾸는 길을 두지 않는다 — 두면
// 이름이 뜻을 잃고 "AI 우선인데 검증자가 하나"인 프로젝트가 생긴다.
function assertWholeMode(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') throw new Error('승인 모드는 이름 하나로 정합니다.');
  const keys = Object.keys(input);
  const extra = keys.filter((key) => key !== 'mode');
  if (extra.length) {
    throw new Error(`승인 모드는 이름으로만 정합니다. 조합을 부분적으로 바꿀 수 없습니다: ${extra.sort().join(', ')}`);
  }
  return input.mode;
}

function resolveMode(input) {
  const name = assertWholeMode(input);
  return Object.assign({ name }, modeDefinition(name));
}

// 바닥보다 푼 모드는 고를 수 없다. 바닥이 없으면 제약하지 않는다.
//
// 판정이 애매하면 더 조인 쪽으로 읽는다 — 모드를 알 수 없을 때 통과시키면, 오타 하나가
// 가장 푼 모드로 떨어지는 길이 된다.
function assertWithinFloor(name, floor) {
  if (!floor) return;
  const chosen = modeDefinition(name);
  const bottom = modeDefinition(floor);
  if (chosen.rank > bottom.rank) {
    throw new Error(`승인 모드를 바닥보다 풀 수 없습니다: 바닥 ${floor}, 시도 ${name}`);
  }
}

// 모드가 정하는 것은 검증 정책의 최소값이다. 파이프가 더 올릴 수 있고 내릴 수 없다.
function floorPolicy(name) {
  return Object.assign({}, modeDefinition(name).policy);
}

// 승인 근거의 자격을 모드가 정한다. 사람만 모드에서 판정을 근거로 받으면 AI 판정이
// 없는데 있는 것처럼 기록되고, AI만 모드에서 읽음을 근거로 받으면 사람이 읽지 않았는데
// 읽은 것으로 남는다. 둘 다 나중에 "그때 무엇에 기댔나"를 물을 수 없게 만든다.
function assertBasisAllowed(name, basisKinds) {
  const allowed = new Set(modeDefinition(name).basis);
  for (const kind of basisKinds || []) {
    if (!allowed.has(kind)) {
      throw new Error(`${name} 모드에서는 ${kind} 근거를 쓸 수 없습니다 (가능: ${Array.from(allowed).join(', ')})`);
    }
  }
  if (modeDefinition(name).requiresDelegation && !(basisKinds || []).includes('delegated')) {
    throw new Error(`${name} 모드의 승인에는 위임된 근거가 필요합니다.`);
  }
}

module.exports = {
  MODES, MODE_NAMES, DEFAULT_PROJECT_MODE, DEFAULT_WORKSPACE_FLOOR,
  modeDefinition, resolveMode, assertWithinFloor, floorPolicy, assertBasisAllowed
};
