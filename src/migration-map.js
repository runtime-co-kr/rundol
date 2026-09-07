'use strict';

// 지금 저장된 상태값을 워크플로 스텝으로 옮기는 지도. 이관의 판정부다.
//
// 이관은 모델의 첫 시험이다 — 옮길 자리가 없는 항목이 나오면 모델이 틀린 것이므로,
// 이 지도가 하는 일의 절반은 "옮긴다"가 아니라 "옮길 자리가 없다고 말한다"이다.
// 그래서 매핑되지 않는 값을 조용히 기본값으로 접지 않는다. 접는 순간 이관 스크립트가
// 답하지 않은 질문을 대신 답해 버리고, 그 사실은 아무 신호도 내지 않는다.
//
// 여기는 파일을 읽지 않는다. check-rules.js가 check.js와 갈라선 것과 같은 이유다 —
// 값을 만드는 일과 그 값을 보고 옳고 그름을 말하는 일이 붙어 있으면 표면마다 다시
// 구현하게 되고, 다시 구현한 것들은 조금씩 달라진다. require는 vocabulary 하나뿐이다.
//
// ── 지도의 출처를 값에 적는다 ──────────────────────────────────────────
//
// 각 줄에 source를 단다. 어느 절이 그 매핑을 정했는지가 값으로 남아야, 나중에 이
// 표를 고칠 때 "누가 정했는지 모르지만 원래 이랬다"가 되지 않는다. 11절이 정한 것과
// 4절이 정한 것은 근거의 무게가 다르고, 아무도 정하지 않은 것은 여기 없다.

const {
  WORKFLOW_STEPS, OPEN_WORKFLOW_STEPS, COMPLETION_VALIDITIES,
  TASK_STATES, DOCUMENT_STATE_KEYS, DOCUMENT_LIFECYCLE_KEYS
} = require('./vocabulary');

// ── 태스크 상태 → 스텝 ──────────────────────────────────────────────────
//
// 11절 "쉬운 절반"이 정한 넷이 전부다. waiting과 review는 여기 없다 — 11절은 그 둘을
// "0건이라 옮길 것이 없다"로 넘겼고, 실제로 0건이다. 그러나 0건인 것과 매핑이 정해진
// 것은 다르다. 지금 넣어 두면 아무도 검토하지 않은 매핑이 정본이 되므로, 비워 두고
// 검사기가 "명세에 없음"으로 뱉게 한다. 값이 하나라도 생기는 날 그 사실이 드러난다.
const TASK_STATUS_STEPS = Object.freeze({
  todo: Object.freeze({ step: 'unclaimed', validity: null, source: '11절' }),
  doing: Object.freeze({ step: 'in-progress', validity: null, source: '11절' }),
  done: Object.freeze({ step: 'completed', validity: 'valid', source: '11절' }),
  cancelled: Object.freeze({ step: 'dropped', validity: null, source: '11절' })
});

// ── 문서: 축이 둘이므로 지도도 둘이다 ──────────────────────────────────
//
// 0.45.0이 문서의 상태 칸을 둘로 갈랐다. state는 rdl이 원장에서 투영하는 진행 축이고,
// lifecycle은 원장이 모르는 내용 수명 축이라 사람이 적는다.
//
// 그 전까지 이 지도는 한 칸을 보고 다섯 줄을 답했다. 그런데 완료 쪽 세 줄
// (active · accepted · deprecated)의 값이 lifecycle로 옮겨 가면서 그 세 줄은 어떤
// 문서로도 닿지 않게 되었다 — 지도의 절반이 죽었고, 죽었다는 사실은 아무 신호도 내지
// 않았다. classifyDocumentState는 계속 답을 냈고 그 답에 그 세 줄이 없었을 뿐이다.
//
// ADR-026이 그 어긋남을 실측으로 적고 고칠 자리로 들었다 — "승인 축의 지도와 수명
// 축의 지도를 갈라 세운다". 같은 문서가 이유도 적었다: **완료 쪽 세 줄은 처음부터
// 수명 값이었다.** valid와 retired는 수명 축의 롤업이었고, 한 칸에 섞여 있는 동안에는
// 그렇게 보이지 않았을 뿐이다.
//
// 그래서 갈라 세우되 줄은 **옮기기만** 한다. 11절이 active · accepted에 대해 정한
// 것과 4절이 deprecated에 대해 정한 것은 그 값이 어느 칸에 사는지와 무관하게 그대로
// 서 있다. source도 그대로 둔다 — 축이 갈렸다는 이유로 남의 결정에 새 출처를 달면
// 그것은 옮긴 것이 아니라 새로 정한 것이 된다.
//
// 두 지도를 하나로 접지 않는다. 접으려면 "승인된 문서가 폐기됐다" 또는 "초안이
// 채택됐다"에서 어느 축이 이기는지를 정해야 하는데, ADR-026이 그것을 자기가 답하지
// 않은 것으로 명시했다("롤업 하나만 낼 수 있는 자리에서 어느 축이 이기는지를 재는
// 실측이 아직 없다"). 여기서 대신 답하면 이 파일이 결정 문서가 된다.

// 승인 축. state 칸이 답하는 진행이다.
//
// 두 줄뿐이다. approved · stale · rejected 셋의 스텝은 어느 절도 ADR-026도 정하지
// 않았다. 실측 0건이지만 곧 나올 값이다 — 이 저장소의 승인 원장은 이미 승인 1건과
// 낡음 2건을 알고 있고, 투영이 그 사실을 파일에 쓰는 날 세 값이 파일에 나타난다.
// 그날 unmappedVocabulary()가 그 셋을 들고, 자리를 못 찾은 문서가 이관 검사를
// 떨어뜨린다. 그것이 이 지도가 하는 일의 절반이다.
const DOCUMENT_STATE_STEPS = Object.freeze({
  draft: Object.freeze({ step: 'in-progress', validity: null, source: '11절' }),
  proposed: Object.freeze({ step: 'in-approval', validity: null, source: '11절' })
});

// 수명 축. lifecycle 칸이 답하는, 끝난 뒤의 유효성이다.
//
// 세 줄은 옛 지도에서 그대로 옮겨 온 것이고 source가 그 사실을 나른다.
//
// superseded와 archived는 옛 지도에도 없었고 지금도 정한 절이 없다. deprecated 옆에
// 두면 셋 다 completed · retired로 보이지만, 그렇게 보이는 것과 누가 정한 것은 다르다 —
// 4절이 deprecated에 대해 적은 근거("안 하기로 함이 아니라 했지만 이제 안 씀")를
// 옆 값에 옮겨 적는 일은 4절이 아니라 이 파일이 하는 판단이다.
//
// 이 칸은 비어 있을 수 있다. 어휘가 그렇게 정했고("없는 것과 active는 다르다"),
// 그래서 값이 없는 문서는 자리를 못 찾은 것이 아니라 이 축에 대해 아무 말도 하지
// 않은 것이다. 그 구분은 이 지도가 아니라 부르는 쪽이 한다 — 지도는 값 하나를 받아
// 답할 뿐이고, 칸이 선택인지 필수인지는 칸의 성질이지 지도의 성질이 아니다.
const DOCUMENT_LIFECYCLE_STEPS = Object.freeze({
  active: Object.freeze({ step: 'completed', validity: 'valid', source: '11절' }),
  accepted: Object.freeze({ step: 'completed', validity: 'valid', source: '11절' }),
  deprecated: Object.freeze({ step: 'completed', validity: 'retired', source: '4절' })
});

// 지도가 어휘를 벗어나지 않는다는 것을 적재 시점에 못박는다.
//
// 시험이 없어서가 아니다 — test/migration-map.test.js가 아래 판단을 따로 덮는다.
// 적재 시점에 두는 이유는 보호가 걸리는 범위다. 시험만 가진 보호는 시험이 도는
// 순간에만 서 있고 목록에서 빠지는 날 조용히 없어지지만, 여기 두면 이 파일을
// require하는 모든 실행이 어휘가 갈린 그 자리에서 넘어진다.
//
// 지도가 둘로 갈린 뒤에도 같은 보호를 받아야 한다. 새 지도가 이 단언을 지나지 않으면
// 갈라 세운 쪽만 검사를 잃고, 잃었다는 사실은 아무 신호도 내지 않는다.
function assertWithinVocabulary(table, label) {
  for (const [value, target] of Object.entries(table)) {
    if (!WORKFLOW_STEPS.includes(target.step)) {
      throw new Error(`${label} 지도가 어휘 밖 스텝을 가리킵니다: ${value} → ${target.step}`);
    }
    if (target.validity !== null && !COMPLETION_VALIDITIES.includes(target.validity)) {
      throw new Error(`${label} 지도가 어휘 밖 유효성을 가리킵니다: ${value} → ${target.validity}`);
    }
    // 유효성은 completed에서만 뜻이 있다. 다른 스텝에 붙으면 그 값을 읽는 쪽이
    // 없는 축을 있는 것으로 다루게 된다.
    if (target.validity !== null && target.step !== 'completed') {
      throw new Error(`${label} 지도가 completed가 아닌 스텝에 유효성을 붙였습니다: ${value} → ${target.step}`);
    }
  }
}
assertWithinVocabulary(TASK_STATUS_STEPS, '태스크');
assertWithinVocabulary(DOCUMENT_STATE_STEPS, '문서 상태');
assertWithinVocabulary(DOCUMENT_LIFECYCLE_STEPS, '문서 수명');

// 하나를 옮긴 결과. mapped가 거짓이면 그것이 이 검사기가 찾는 것이다.
function classify(table, declaredValues, value) {
  const key = value === undefined || value === null ? null : String(value);
  const target = key === null ? undefined : table[key];
  return {
    value: key,
    step: target ? target.step : null,
    validity: target ? target.validity : null,
    mapped: Boolean(target),
    // 어휘가 선언했는가. 매핑 여부와 독립이다 — approved는 선언 안인데 매핑되지
    // 않고(스텝을 정한 절이 없다), 반대로 지도가 어휘를 앞질러 가면 선언 밖인데
    // 매핑되는 값이 생긴다. 축이 갈리기 전 accepted가 그 자리에 있었고, 어휘가
    // 따라오면서 지금은 비었다. 두 축을 겹치면 그 둘이 같아 보이고, 같아 보이면
    // "어휘에 없다"와 "옮길 자리가 없다"를 한 신호로 읽게 된다.
    declared: key !== null && declaredValues.includes(key),
    source: target ? target.source : null
  };
}

function classifyTaskStatus(status) {
  return classify(TASK_STATUS_STEPS, TASK_STATES, status);
}

// 문서는 두 번 묻는다. 한 번에 두 칸을 받는 함수를 두지 않는 이유는 서명이 아니라
// 답이다 — 두 칸을 함께 받으면 답도 하나여야 하고, 그러려면 두 축이 다른 말을 할 때
// 어느 쪽이 이기는지를 이 함수가 정해야 한다. 그 판단은 ADR-026이 미뤄 둔 것이다.
// 그래서 축마다 자기 물음에만 답하고, 접는 일은 접을 근거가 생기는 날 생긴다.
function classifyDocumentState(state) {
  return classify(DOCUMENT_STATE_STEPS, DOCUMENT_STATE_KEYS, state);
}

function classifyDocumentLifecycle(lifecycle) {
  return classify(DOCUMENT_LIFECYCLE_STEPS, DOCUMENT_LIFECYCLE_KEYS, lifecycle);
}

// 어휘가 선언했는데 지도에 없는 값. 실측 0건이어도 모델의 구멍이므로 값으로 내보낸다.
// 11절이 "옮길 것이 없다"로 넘긴 자리가 정확히 여기다.
function unmappedVocabulary() {
  return Object.freeze({
    taskStatuses: Object.freeze(TASK_STATES.filter((state) => !TASK_STATUS_STEPS[state])),
    documentStates: Object.freeze(DOCUMENT_STATE_KEYS.filter((state) => !DOCUMENT_STATE_STEPS[state])),
    documentLifecycles: Object.freeze(DOCUMENT_LIFECYCLE_KEYS.filter((value) => !DOCUMENT_LIFECYCLE_STEPS[value]))
  });
}

// 지도에는 있는데 어휘가 선언하지 않은 값. 지금은 세 축 모두 비어 있다.
//
// 예전에는 accepted 하나가 여기 있었고, 그것이 11절이 "어휘 밖 값이 여기서 정식이
// 된다"고 적은 줄의 실체였다. 그 문장은 이제 참이 아니다 — 0.45.0이 축을 가르면서
// accepted가 DOCUMENT_LIFECYCLE_KEYS로 들어갔고, 그래서 그 값은 어휘 안이다.
// 지도가 어휘를 앞질러 가던 자리를 어휘가 따라와 메웠다.
//
// 비었다고 함수를 지우지 않는다. 이것이 재는 것은 "지금 몇 건인가"가 아니라 "지도와
// 어휘가 갈렸는가"이고, 갈리는 날 값이 나와야 한다.
function undeclaredMappings() {
  return Object.freeze({
    taskStatuses: Object.freeze(Object.keys(TASK_STATUS_STEPS).filter((state) => !TASK_STATES.includes(state))),
    documentStates: Object.freeze(Object.keys(DOCUMENT_STATE_STEPS).filter((state) => !DOCUMENT_STATE_KEYS.includes(state))),
    documentLifecycles: Object.freeze(Object.keys(DOCUMENT_LIFECYCLE_STEPS).filter((value) => !DOCUMENT_LIFECYCLE_KEYS.includes(value)))
  });
}

// ── 묶음 롤업을 스텝 공간에서 다시 계산한다 ────────────────────────────
//
// 11절 어려운 절반 4번이 요구한 것이다. workset.js의 롤업은 TASK_STATES 여섯 중
// 어디에도 없는 'open'을 만들어 내므로 옮길 대상이 없고, 옮기는 대신 다시 계산해야
// 한다.
//
// 규칙은 원래 것과 같다 — "가장 덜 진행된 것이 묶음을 정한다". 달라지는 것은 그
// 판단이 지어낸 일곱 번째 값이 아니라 어휘 안의 스텝으로 떨어진다는 점이다.
// 'open'이 답하던 자리를 unclaimed가 그대로 받는다.
//
// 진행 순서를 여기 다시 적지 않는다. WORKFLOW_STEPS가 이미 그 순서로 선언되어 있고,
// 끝난 것은 TERMINAL_WORKFLOW_STEPS가 가른다. 같은 목록을 두 번째로 적을 수 있으면
// 언젠가 두 목록은 갈린다 — 이 저장소가 vocabulary.js를 만든 이유 그대로다.
function rollupStep(steps) {
  const list = (steps || []).filter((step) => WORKFLOW_STEPS.includes(step));
  if (!list.length) return { step: null, ambiguous: false };
  for (const step of OPEN_WORKFLOW_STEPS) {
    if (list.includes(step)) return { step, ambiguous: false };
  }
  // 남은 것은 전부 끝난 스텝이다. 전부 같으면 그것이 답이고, completed와 dropped가
  // 섞이면 답이 하나로 정해지지 않는다 — 성취와 취소는 "더 손대지 않는다"는 점만
  // 같고 뜻이 반대다. 여기서 한쪽을 고르면 그것은 이 갈래가 정한 것이 되므로,
  // 고르지 않고 섞였다는 사실을 내보낸다. 결정이 필요한 자리는 결정으로 남긴다.
  const unique = Array.from(new Set(list));
  if (unique.length === 1) return { step: unique[0], ambiguous: false };
  return { step: null, ambiguous: true, mixed: unique.sort() };
}

// ── 소급 적용될 →완료 검증 ──────────────────────────────────────────────
//
// 11절이 실제로 재 본 둘이다. 값만 받아 답한다 — 게이트가 어디에 걸리는지는 이
// 모듈이 정하지 않는다.
function completionGateFindings(task) {
  const findings = [];
  const criteria = task && task.acceptanceCriteria ? Object.values(task.acceptanceCriteria) : [];
  if (criteria.length && criteria.some((item) => !item || item.done !== true)) {
    findings.push('acceptance-not-all-done');
  }
  const links = Array.isArray(task && task.links) ? task.links : [];
  if (!links.some((link) => String(link).startsWith('TST-'))) findings.push('no-test-link');
  return findings;
}

module.exports = Object.freeze({
  TASK_STATUS_STEPS,
  DOCUMENT_STATE_STEPS,
  DOCUMENT_LIFECYCLE_STEPS,
  classifyTaskStatus,
  classifyDocumentState,
  classifyDocumentLifecycle,
  unmappedVocabulary,
  undeclaredMappings,
  rollupStep,
  completionGateFindings
});
