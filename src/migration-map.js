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

const { WORKFLOW_STEPS, OPEN_WORKFLOW_STEPS, COMPLETION_VALIDITIES, TASK_STATES, DOCUMENT_STATE_KEYS } = require('./vocabulary');

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

// ── 문서 상태 → 스텝 ────────────────────────────────────────────────────
//
// accepted는 어휘 밖 값인데 12건 살아 있다. 11절이 그것을 완료·유효로 정식화했으므로
// 여기서는 어휘에 없다는 이유로 미매핑이 아니다 — 오히려 이 줄이 그 값을 정식으로
// 만드는 자리다. declared 축이 그 사실(어휘에는 없음)을 따로 들고 있다.
//
// deprecated는 11절 표에 없지만 4절이 명시적으로 정했다: "안 하기로 함"이 아니라
// "했지만 이제 안 씀"이므로 dropped가 아니라 completed에 속하고 유효성 축이 유효와
// 폐기를 가른다. 실측 0건이지만 근거가 있는 매핑이라 넣는다.
//
// review · approved · archived · unread 넷은 어느 절도 정하지 않았다. 넣지 않는다.
const DOCUMENT_STATE_STEPS = Object.freeze({
  draft: Object.freeze({ step: 'in-progress', validity: null, source: '11절' }),
  proposed: Object.freeze({ step: 'in-approval', validity: null, source: '11절' }),
  active: Object.freeze({ step: 'completed', validity: 'valid', source: '11절' }),
  accepted: Object.freeze({ step: 'completed', validity: 'valid', source: '11절' }),
  deprecated: Object.freeze({ step: 'completed', validity: 'retired', source: '4절' })
});

// 지도가 어휘를 벗어나지 않는다는 것을 적재 시점에 못박는다.
//
// 이 갈래는 새 파일만 만들 수 있어 test/manifest.js에 시험을 등록할 수 없다.
// 등록하지 못한 시험 파일은 manifest-coverage가 잡아내고, 잡히지 않더라도 돌지 않는
// 시험은 통과한 시험과 구분되지 않는다. 그래서 검증을 시험이 아니라 모듈 자신에게
// 둔다 — 어휘가 갈리면 이 파일을 require하는 모든 실행이 그 자리에서 넘어진다.
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
assertWithinVocabulary(DOCUMENT_STATE_STEPS, '문서');

// 하나를 옮긴 결과. mapped가 거짓이면 그것이 이 검사기가 찾는 것이다.
function classify(table, declaredValues, value) {
  const key = value === undefined || value === null ? null : String(value);
  const target = key === null ? undefined : table[key];
  return {
    value: key,
    step: target ? target.step : null,
    validity: target ? target.validity : null,
    mapped: Boolean(target),
    // 어휘가 선언했는가. 매핑 여부와 독립이다 — accepted는 선언 밖인데 매핑되고,
    // unread는 선언 안인데 매핑되지 않는다. 두 축을 겹치면 그 둘이 같아 보인다.
    declared: key !== null && declaredValues.includes(key),
    source: target ? target.source : null
  };
}

function classifyTaskStatus(status) {
  return classify(TASK_STATUS_STEPS, TASK_STATES, status);
}

function classifyDocumentState(state) {
  return classify(DOCUMENT_STATE_STEPS, DOCUMENT_STATE_KEYS, state);
}

// 어휘가 선언했는데 지도에 없는 값. 실측 0건이어도 모델의 구멍이므로 값으로 내보낸다.
// 11절이 "옮길 것이 없다"로 넘긴 자리가 정확히 여기다.
function unmappedVocabulary() {
  return Object.freeze({
    taskStatuses: Object.freeze(TASK_STATES.filter((state) => !TASK_STATUS_STEPS[state])),
    documentStates: Object.freeze(DOCUMENT_STATE_KEYS.filter((state) => !DOCUMENT_STATE_STEPS[state]))
  });
}

// 지도에는 있는데 어휘가 선언하지 않은 값. accepted 하나가 여기 있고, 그것이 11절이
// "어휘 밖 값이 여기서 정식이 된다"고 적은 줄의 실체다.
function undeclaredMappings() {
  return Object.freeze({
    taskStatuses: Object.freeze(Object.keys(TASK_STATUS_STEPS).filter((state) => !TASK_STATES.includes(state))),
    documentStates: Object.freeze(Object.keys(DOCUMENT_STATE_STEPS).filter((state) => !DOCUMENT_STATE_KEYS.includes(state)))
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
  classifyTaskStatus,
  classifyDocumentState,
  unmappedVocabulary,
  undeclaredMappings,
  rollupStep,
  completionGateFindings
});
