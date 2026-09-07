'use strict';

// 이관 지도의 불변식. 이 지도가 답하는 물음은 "이 항목이 워크플로 스텝 어디에 있고,
// 완료라면 그 완료가 유효한가"이고, 이 시험이 지키는 것은 그 물음이 **닿는지**다.
//
// 이 파일이 생긴 이유는 자국이다. 0.45.0이 문서의 상태 칸을 state와 lifecycle 둘로
// 가른 뒤에도 지도는 한 칸짜리 그대로였다. 완료 쪽 세 줄의 값(active·accepted·
// deprecated)이 lifecycle로 옮겨 갔으므로 그 세 줄은 어떤 문서로도 닿지 않았는데,
// classifyDocumentState는 계속 답을 냈다 — 그 답에 완료가 없었을 뿐이다. **답이 나온다는
// 것과 답이 맞다는 것은 다르고, 죽은 줄은 아무 신호도 내지 않는다.**
//
// 그래서 여기서 세는 것은 함수가 던지지 않는다는 사실이 아니라 어휘의 값 하나하나가
// 실제로 어디로 떨어지는가다. 어휘가 늘거나 축이 다시 갈리면 이 시험이 먼저 걸린다.

const assert = require('assert');
const map = require('../src/migration-map');
const {
  TASK_STATES, DOCUMENT_STATE_KEYS, DOCUMENT_LIFECYCLE_KEYS,
  WORKFLOW_STEPS, COMPLETION_VALIDITIES
} = require('../src/vocabulary');

// ── 지도가 어휘 안에 있는가 ─────────────────────────────────────────────
//
// 모듈 자신이 적재 시점에 같은 것을 단언한다. 여기서 한 번 더 세는 이유는 그 단언이
// 실제로 걸려 있는지를 확인하는 것이 아니라, 세 지도 **전부**가 그 보호를 지나는지를
// 세기 위해서다. 지도를 하나 더 세우면서 단언을 안 걸면 그 지도만 조용히 검사를 잃는다.
const TABLES = [
  ['태스크 상태', map.TASK_STATUS_STEPS],
  ['문서 상태', map.DOCUMENT_STATE_STEPS],
  ['문서 수명', map.DOCUMENT_LIFECYCLE_STEPS]
];

for (const [label, table] of TABLES) {
  assert.ok(Object.isFrozen(table), `${label} 지도가 얼려 있지 않습니다.`);
  for (const [value, target] of Object.entries(table)) {
    assert.ok(WORKFLOW_STEPS.includes(target.step), `${label} 지도의 ${value}가 어휘 밖 스텝을 가리킵니다: ${target.step}`);
    assert.ok(target.source, `${label} 지도의 ${value}에 출처가 없습니다. 아무도 정하지 않은 매핑은 지도에 없어야 합니다.`);
    if (target.validity === null) continue;
    assert.ok(COMPLETION_VALIDITIES.includes(target.validity), `${label} 지도의 ${value}가 어휘 밖 유효성을 가리킵니다: ${target.validity}`);
    // 유효성은 completed에서만 뜻이 있다. 다른 스텝에 붙으면 읽는 쪽이 없는 축을
    // 있는 것으로 다룬다.
    assert.strictEqual(target.step, 'completed', `${label} 지도의 ${value}가 completed가 아닌 스텝에 유효성을 붙였습니다.`);
  }
}

// 적재 시점 단언이 실제로 서 있는지 값으로 확인한다. 지도를 얼려 두었으므로 이
// 시험에서 어휘 밖 줄을 끼워 넣어 다시 require할 수는 없고, 대신 그 단언이 검사하는
// 성질(위 루프)과 같은 것을 모듈이 내보내는 표에 대고 잰다.
assert.deepStrictEqual(
  TABLES.map(([label]) => label),
  ['태스크 상태', '문서 상태', '문서 수명'],
  '지도가 셋이 아닙니다. 새 지도를 세웠다면 적재 시점 단언과 이 시험이 함께 그것을 덮어야 합니다.'
);

// ── 축이 둘로 갈렸다 — 완료가 어느 칸에서 오는가 ────────────────────────
//
// 이 저장소가 실제로 그렇다: state는 draft 152건과 proposed 5건뿐이고 완료 쪽 값은
// 하나도 없다. 완료는 lifecycle이 답한다.

// 승인 축은 완료를 만들지 않는다. 만드는 날이 오면 그것은 결정이므로 이 줄이 먼저 걸린다.
for (const [value, target] of Object.entries(map.DOCUMENT_STATE_STEPS)) {
  assert.notStrictEqual(target.step, 'completed', `승인 축의 ${value}가 완료를 주장합니다. 완료 유효성은 수명 축이 가릅니다(ADR-026).`);
  assert.strictEqual(target.validity, null, `승인 축의 ${value}가 유효성을 답합니다. 그 축은 lifecycle의 것입니다.`);
}

// 수명 축은 완료 안쪽만 가른다. 진행을 답하기 시작하면 두 축이 한 스텝 축에 겹쳐 앉는다.
for (const [value, target] of Object.entries(map.DOCUMENT_LIFECYCLE_STEPS)) {
  assert.strictEqual(target.step, 'completed', `수명 축의 ${value}가 완료 밖 스텝을 가리킵니다.`);
  assert.ok(COMPLETION_VALIDITIES.includes(target.validity), `수명 축의 ${value}가 유효성을 답하지 않습니다.`);
}

// 완료·유효와 완료·폐기 둘 다 닿아야 한다. 한쪽만 닿으면 지도는 살아 있는 것처럼
// 보이면서 실제로는 절반이 죽어 있다 — 그것이 이 파일이 고친 결함의 모습이다.
const reachedValidities = new Set(Object.values(map.DOCUMENT_LIFECYCLE_STEPS).map((target) => target.validity));
assert.deepStrictEqual(
  Array.from(reachedValidities).sort(),
  COMPLETION_VALIDITIES.slice().sort(),
  '완료 유효성 가운데 어느 문서로도 닿지 않는 값이 있습니다.'
);

// 한 값이 두 지도에 동시에 있으면 어느 칸을 읽었느냐로 답이 갈린다.
const overlap = Object.keys(map.DOCUMENT_STATE_STEPS).filter((value) => map.DOCUMENT_LIFECYCLE_STEPS[value]);
assert.deepStrictEqual(overlap, [], `한 값이 두 축의 지도에 함께 있습니다: ${overlap.join(' · ')}`);

// ── 값 하나하나가 어디로 떨어지는가 ─────────────────────────────────────
//
// 표를 그대로 적는다. 계산으로 적으면 지도를 고칠 때 이 시험도 같이 따라 움직여
// 아무것도 못 막는다.

const DOCUMENT_STATE_LANDINGS = {
  draft: { step: 'in-progress', validity: null, mapped: true },
  proposed: { step: 'in-approval', validity: null, mapped: true },
  // 아래 셋은 어느 절도 ADR-026도 스텝을 정하지 않았다. 실측 0건이지만 원장은 이미
  // 승인 1건과 낡음 2건을 알고 있어 곧 나올 값이고, 나오는 날 이관 검사가 떨어진다.
  // 그 자리를 메우는 것은 결정이므로, 메우는 커밋에서 이 줄이 함께 바뀌어야 한다.
  approved: { step: null, validity: null, mapped: false },
  stale: { step: null, validity: null, mapped: false },
  rejected: { step: null, validity: null, mapped: false }
};

const DOCUMENT_LIFECYCLE_LANDINGS = {
  active: { step: 'completed', validity: 'valid', mapped: true },
  accepted: { step: 'completed', validity: 'valid', mapped: true },
  deprecated: { step: 'completed', validity: 'retired', mapped: true },
  // deprecated 옆에 두면 셋 다 폐기로 보이지만, 그렇게 보이는 것과 누가 정한 것은 다르다.
  superseded: { step: null, validity: null, mapped: false },
  archived: { step: null, validity: null, mapped: false }
};

// 표가 어휘를 빠짐없이 덮는가. 어휘가 늘면 이 줄이 먼저 걸리고, 그러면 새 값이
// 어디로 떨어지는지를 아무도 안 정한 채로 지나가지 못한다.
assert.deepStrictEqual(
  Object.keys(DOCUMENT_STATE_LANDINGS).sort(),
  DOCUMENT_STATE_KEYS.slice().sort(),
  '문서 상태 어휘와 이 시험의 표가 갈렸습니다.'
);
assert.deepStrictEqual(
  Object.keys(DOCUMENT_LIFECYCLE_LANDINGS).sort(),
  DOCUMENT_LIFECYCLE_KEYS.slice().sort(),
  '문서 수명 어휘와 이 시험의 표가 갈렸습니다.'
);

for (const [value, expected] of Object.entries(DOCUMENT_STATE_LANDINGS)) {
  const got = map.classifyDocumentState(value);
  assert.strictEqual(got.step, expected.step, `state ${value}의 스텝이 다릅니다.`);
  assert.strictEqual(got.validity, expected.validity, `state ${value}의 유효성이 다릅니다.`);
  assert.strictEqual(got.mapped, expected.mapped, `state ${value}의 매핑 여부가 다릅니다.`);
  assert.strictEqual(got.declared, true, `state ${value}가 어휘 밖으로 판정됩니다.`);
}

for (const [value, expected] of Object.entries(DOCUMENT_LIFECYCLE_LANDINGS)) {
  const got = map.classifyDocumentLifecycle(value);
  assert.strictEqual(got.step, expected.step, `lifecycle ${value}의 스텝이 다릅니다.`);
  assert.strictEqual(got.validity, expected.validity, `lifecycle ${value}의 유효성이 다릅니다.`);
  assert.strictEqual(got.mapped, expected.mapped, `lifecycle ${value}의 매핑 여부가 다릅니다.`);
  assert.strictEqual(got.declared, true, `lifecycle ${value}가 어휘 밖으로 판정됩니다.`);
}

// 태스크 축은 이 갈래가 건드리지 않았다. 안 건드렸다는 것도 값으로 남긴다 —
// 문서 축을 고치면서 옆 표가 함께 움직이면 그 사실이 diff에서만 보인다.
const TASK_LANDINGS = {
  todo: { step: 'unclaimed', validity: null, mapped: true },
  doing: { step: 'in-progress', validity: null, mapped: true },
  waiting: { step: null, validity: null, mapped: false },
  review: { step: null, validity: null, mapped: false },
  done: { step: 'completed', validity: 'valid', mapped: true },
  cancelled: { step: 'dropped', validity: null, mapped: true }
};
assert.deepStrictEqual(Object.keys(TASK_LANDINGS).sort(), TASK_STATES.slice().sort(), '태스크 어휘와 이 시험의 표가 갈렸습니다.');
for (const [value, expected] of Object.entries(TASK_LANDINGS)) {
  const got = map.classifyTaskStatus(value);
  assert.strictEqual(got.step, expected.step, `status ${value}의 스텝이 다릅니다.`);
  assert.strictEqual(got.validity, expected.validity, `status ${value}의 유효성이 다릅니다.`);
  assert.strictEqual(got.mapped, expected.mapped, `status ${value}의 매핑 여부가 다릅니다.`);
}

// ── 값이 없는 것과 어휘 밖인 것 ─────────────────────────────────────────
//
// 지도는 둘을 같게 답한다(자리 없음). 가르는 것은 부르는 쪽의 일이고, 무엇으로
// 가르는지가 값에 남아 있어야 한다 — declared 축이 그 자리다.
for (const absent of [undefined, null]) {
  const state = map.classifyDocumentState(absent);
  assert.strictEqual(state.value, null, '값 없음이 null로 오지 않습니다.');
  assert.strictEqual(state.mapped, false);
  assert.strictEqual(state.declared, false);
  const lifecycle = map.classifyDocumentLifecycle(absent);
  assert.strictEqual(lifecycle.value, null, '수명 칸 없음이 null로 오지 않습니다.');
  assert.strictEqual(lifecycle.mapped, false);
}

// 어휘 밖 값은 매핑도 선언도 아니다. 옛 한 칸 시절의 값이 남아 있는 파일이 그 모습이다.
const strayLifecycleValue = map.classifyDocumentState('active');
assert.strictEqual(strayLifecycleValue.mapped, false, 'state 칸의 수명 값이 승인 축 지도에 닿습니다. 두 축이 겹쳐 앉았습니다.');
assert.strictEqual(strayLifecycleValue.declared, false, 'state 칸의 수명 값이 상태 어휘 안으로 판정됩니다.');
const strayStateValue = map.classifyDocumentLifecycle('draft');
assert.strictEqual(strayStateValue.mapped, false, 'lifecycle 칸의 상태 값이 수명 축 지도에 닿습니다.');
assert.strictEqual(strayStateValue.declared, false, 'lifecycle 칸의 상태 값이 수명 어휘 안으로 판정됩니다.');

// ── 모델의 구멍을 값으로 내보내는가 ─────────────────────────────────────
//
// 실측 0건이어도 내보낸다. 0건인 것과 매핑이 정해진 것은 다르고, 지금 넣어 두면
// 아무도 검토하지 않은 매핑이 정본이 된다.
const holes = map.unmappedVocabulary();
assert.deepStrictEqual(holes.taskStatuses.slice().sort(), ['review', 'waiting'], '태스크 축의 구멍이 달라졌습니다.');
assert.deepStrictEqual(holes.documentStates.slice().sort(), ['approved', 'rejected', 'stale'], '승인 축의 구멍이 달라졌습니다.');
assert.deepStrictEqual(holes.documentLifecycles.slice().sort(), ['archived', 'superseded'], '수명 축의 구멍이 달라졌습니다.');

// 축이 갈리기 전에는 accepted 하나가 여기 있었다. 어휘가 그 값을 따라잡았으므로
// 지금은 셋 다 비어 있다. 비었다는 것 자체가 재는 값이다.
const undeclared = map.undeclaredMappings();
assert.deepStrictEqual(undeclared.taskStatuses, [], '태스크 지도가 어휘를 앞질러 갔습니다.');
assert.deepStrictEqual(undeclared.documentStates, [], '승인 축 지도가 어휘를 앞질러 갔습니다.');
assert.deepStrictEqual(undeclared.documentLifecycles, [], '수명 축 지도가 어휘를 앞질러 갔습니다.');

// ── 스텝 공간의 롤업 ────────────────────────────────────────────────────
//
// "가장 덜 진행된 것이 묶음을 정한다". 어휘 밖 값은 세지 않고, 완료와 취소가 섞이면
// 고르지 않는다 — 성취와 취소는 뜻이 반대라 한쪽을 고르면 이 파일이 결정을 내린 것이 된다.
assert.deepStrictEqual(map.rollupStep([]), { step: null, ambiguous: false });
assert.deepStrictEqual(map.rollupStep(['made-up']), { step: null, ambiguous: false }, '어휘 밖 스텝이 롤업에 셉니다.');
assert.deepStrictEqual(map.rollupStep(['completed', 'unclaimed']), { step: 'unclaimed', ambiguous: false });
assert.deepStrictEqual(map.rollupStep(['completed', 'in-approval']), { step: 'in-approval', ambiguous: false });
assert.deepStrictEqual(map.rollupStep(['completed', 'completed']), { step: 'completed', ambiguous: false });
assert.deepStrictEqual(
  map.rollupStep(['completed', 'dropped']),
  { step: null, ambiguous: true, mixed: ['completed', 'dropped'] },
  '성취와 취소가 섞였는데 한쪽을 골랐습니다.'
);

// ── 소급 적용될 →완료 검증 ──────────────────────────────────────────────
assert.deepStrictEqual(map.completionGateFindings({ links: ['TST-001'] }), []);
assert.deepStrictEqual(map.completionGateFindings({ links: [] }), ['no-test-link']);
assert.deepStrictEqual(
  map.completionGateFindings({ acceptanceCriteria: { a: { done: true }, b: { done: false } }, links: ['TST-001'] }),
  ['acceptance-not-all-done']
);
// 수용조건이 아예 없으면 위반이 아니다. 없는 조건을 안 지켰다고 말하면 그 신호는 곧 무시된다.
assert.deepStrictEqual(map.completionGateFindings({ acceptanceCriteria: {}, links: ['TST-002'] }), []);

process.stdout.write('migration-map tests passed\n');
