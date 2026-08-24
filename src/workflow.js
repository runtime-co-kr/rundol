'use strict';

// 워크플로 스텝과 전환 판정. 상태 기계가 코드 안에서 사는 자리다.
//
// 이 파일이 하는 일은 둘이다.
//
//   1. 상태 이름을 스텝으로 옮긴다. 코드는 노드 이름을 모르고 스텝만 읽는다.
//   2. 막는 규칙을 전부 돌려준다. 네 표면이 이 함수 하나를 부른다.
//
// ── 왜 이 파일이 생겼나 ────────────────────────────────────────────────
//
// 태스크 상태를 바꾸는 일에 워크플로가 없었다. 막고 싶은 규칙 넷이 세 파일에
// 흩어져 있었고, 흩어짐이 실제로 비용을 냈다 — 태스크 열둘을 완료로 옮길 때
// RDL-TASK-019가 먼저 막고, 하나를 면제하자 RDL-IMPL-021이 다시 막았다.
// 두 규칙이 같은 사실에서 나오는데 한 화면에 보이지 않아 두 번 왕복했다.
//
// 그 왕복의 기계는 판정이 아니라 판정을 꺼내는 자리에 있었다. 검사는 진단을
// 전부 만들어 놓고, 저장 게이트가 그중 첫 줄만 꺼내 던졌다. 그래서 이 파일의
// 반환은 불리언이 아니라 목록이고, 부르는 쪽도 목록을 통째로 내보낸다.
//
// ── 무엇을 안 하나 ─────────────────────────────────────────────────────
//
// 파일을 읽지 않는다. 네 표면은 각자 경로를 갖고 있고, 판정이 경로를 알면 각
// 표면이 자기 경로로 다시 구현하게 되며 다시 구현한 것들은 조금씩 달라진다.
//
// 시각을 읽지 않는다. 인자에 시계가 없는 것이 그 강제다. 어제와 오늘의 답이
// 다르면 재현되지 않고, 재현되지 않는 판정은 막힌 사람에게 무엇을 고쳐야
// 하는지 말해 주지 못한다.
//
// 발화 레코드를 만들지 않는다. 만들면 판정이 시각과 클라이언트를 알아야 하고,
// 그 순간 위 두 줄이 깨진다. 부른 표면이 판정의 답을 받아 적는다.
//
// require는 정본과 판정기뿐이다. check-rules.js가 check.js와 갈라선 것과 같은
// 규율이고, worker-contract-purity.test.js가 전이 의존까지 따라가며 지킨다.
// validation-catalog.js도 vocabulary 하나만 물고 있으므로 전이 폐포가 늘지 않는다 —
// 검증 슬롯의 판정기를 여기서 다시 짓지 않는 것이 그 파일을 무는 유일한 이유다.

const {
  WORKFLOW_STEPS, TERMINAL_WORKFLOW_STEPS, OPEN_WORKFLOW_STEPS, ACTIVE_WORKFLOW_STEPS,
  COMPLETION_VALIDITIES, RULE_ORIGINS, TASK_STATES, EXEMPTABLE_GATES, TARGET_KINDS,
  TRANSITION_SLOTS, TRANSITION_SLOT_UNIT_KINDS, RUN_OPENING_SLOTS,
  EXECUTION_UNIT_KINDS, BASIS_KINDS, VERDICTS
} = require('./vocabulary');
const {
  VALIDATION_DIAGNOSTICS, normalizeValidations, evaluateValidations
} = require('./validation-catalog');

// ── 내장 태스크 워크플로 ────────────────────────────────────────────────
//
// 3단계에서 workflows.json이 이 표를 대체한다. 지금은 프로젝트가 정의하는 층이
// 없으므로 내장 하나이며, 그래서 이 표는 "지금 저장된 여섯 상태가 어느 스텝에
// 서는가"만 답한다.
//
// ratified 축을 따로 두는 이유는 근거의 무게가 다르기 때문이다. 넷은 보고서
// 11절이 실측 위에서 정했고, 둘(waiting · review)은 어느 절도 정하지 않았다.
// 11절은 그 둘을 "0건이라 옮길 것이 없다"로 넘겼고 실제로 0건이다.
//
// 그런데 이관 지도와 달리 제품은 비워 둘 수 없다. 어휘가 여섯을 선언했으므로
// 저장은 여섯을 받고, 받은 값에 대해 "끝났나 · 붙어 있나"에 답하지 못하면 그
// 태스크는 어느 목록에도 들지 않는다 — 매핑을 비우는 것은 답을 미루는 것이
// 아니라 틀린 답을 내는 것이다. 그래서 채우되, 채웠다는 사실을 값에 남긴다.
// migration-map.js의 source 축이 하던 일과 같고, 아직 안 정해진 것을 정해진
// 것처럼 보이게 하지 않는 것이 그 축의 목적이다.
//
//   waiting  → in-progress   누군가 붙어 있되 막혀 있다. blocker.waitingFor가
//                            사람을 가리키므로 아무도 안 잡은 것은 아니다.
//   review   → in-approval   다른 행위자의 동의를 기다린다. RDL-TASK-020이
//                            병합 요청 참조를 요구하는 것이 그 뜻이다.
// requiresOwner를 스텝이 아니라 노드가 든다. 스텝으로 물으면 대기와 진행이 같은
// 칸에 서므로 둘을 가를 수 없는데, 지금 규칙은 그 둘을 가른다 — 대기는 담당자 없이도
// 성립한다. 아무도 안 잡은 일이 바깥 사정에 막혀 있는 경우가 그것이다.
//
// 이 값이 옳은지는 이 갈래가 답하지 않는다. 여기서 정하면 상태 문자열을 걷어내는 일이
// 규칙을 넓히는 일과 한 커밋에 섞이고, 그러면 나중에 무엇이 어느 쪽 때문에 바뀌었는지
// 답할 수 없다. 지금 도는 판정을 그대로 옮기고, 그 판정이 값으로 보이게만 한다 —
// 예전에는 이것이 규칙 안에 손으로 적힌 노드 넷이었고 목록이라 읽히지도 않았다.
const TASK_NODES = Object.freeze({
  todo: Object.freeze({ step: 'unclaimed', validity: null, requiresOwner: false, ratified: '11절' }),
  doing: Object.freeze({ step: 'in-progress', validity: null, requiresOwner: true, ratified: '11절' }),
  waiting: Object.freeze({ step: 'in-progress', validity: null, requiresOwner: false, ratified: null }),
  review: Object.freeze({ step: 'in-approval', validity: null, requiresOwner: true, ratified: null }),
  done: Object.freeze({ step: 'completed', validity: 'valid', requiresOwner: true, ratified: '11절' }),
  cancelled: Object.freeze({ step: 'dropped', validity: null, requiresOwner: true, ratified: '11절' })
});

// 내장 워크플로가 어휘를 벗어나지 않는다는 것을 적재 시점에 못박는다. 시험이
// 아니라 모듈 자신에게 두는 이유는, 돌지 않은 시험은 통과한 시험과 구분되지
// 않기 때문이다 — 어휘가 갈리면 이 파일을 require하는 모든 실행이 그 자리에서
// 넘어진다. migration-map.js가 같은 수법을 쓴다.
for (const [node, target] of Object.entries(TASK_NODES)) {
  if (!TASK_STATES.includes(node)) throw new Error(`내장 워크플로가 어휘 밖 노드를 갖습니다: ${node}`);
  if (!WORKFLOW_STEPS.includes(target.step)) throw new Error(`내장 워크플로가 어휘 밖 스텝을 가리킵니다: ${node} → ${target.step}`);
  if (target.validity !== null && !COMPLETION_VALIDITIES.includes(target.validity)) {
    throw new Error(`내장 워크플로가 어휘 밖 유효성을 가리킵니다: ${node} → ${target.validity}`);
  }
  // 유효성은 completed에서만 뜻이 있다. 다른 스텝에 붙으면 그 값을 읽는 쪽이
  // 없는 축을 있는 것으로 다룬다.
  if (target.validity !== null && target.step !== 'completed') {
    throw new Error(`내장 워크플로가 completed가 아닌 스텝에 유효성을 붙였습니다: ${node} → ${target.step}`);
  }
}
// 어휘가 선언한 값에 설 자리가 없으면 그 값을 가진 태스크는 어느 목록에도 들지
// 않는다. 목록에서 빠졌다는 사실은 아무 신호도 내지 않으므로 여기서 막는다.
for (const state of TASK_STATES) {
  if (!TASK_NODES[state]) throw new Error(`어휘가 선언한 상태에 스텝이 없습니다: ${state}`);
}

// ── 설정으로 정의하는 워크플로 ──────────────────────────────────────────
//
// 위 표는 내장이다. workflows.json이 그것을 대체하며, 대체하지 않으면 내장이
// 그대로 답한다. 설정이 없는 저장소에서 판정이 달라지지 않는 것이 이 층의 계약이다.
//
// 정규화가 판정보다 먼저 도는 이유는 item-type.js와 같다 — 알 수 없는 키를 판정
// 시점까지 끌고 가면 그 규칙은 아무 항목에도 맞지 않는 채로 살고, 그렇게 사는 동안
// 아무 신호도 내지 않는다. 파일 경로와 키 경로와 이유를 함께 물어 거부한다.
//
// 전환 목록이 없는 워크플로는 전환을 막지 않는다. 비면 전부 막는 쪽이 형식적으로는
// 깔끔하지만, 그러면 노드에 이름만 붙이려던 프로젝트가 자기 태스크를 하나도 못 옮기게
// 된다. 닫는 것은 선언으로 하고, 선언하지 않은 것은 지금 동작을 유지한다.
const TRANSITION_WILDCARD = '(ALL)';
const WORKFLOW_ENTRY_KEYS = Object.freeze(['targetKind', 'nodes', 'executionUnits', 'transitions', 'label', 'description', 'disabled']);
const NODE_ENTRY_KEYS = Object.freeze(['step', 'validity', 'requiresOwner', 'label', 'description', 'order', 'disabled']);

// ── 전환의 슬롯 ─────────────────────────────────────────────────────────
//
// 칸 목록을 손으로 적지 않고 어휘의 표에서 계산한다. 손으로 적으면 어휘가 슬롯을
// 늘렸는데 설정이 그 칸을 못 받는 날이 오고, 그 사실은 아무 신호도 내지 않는다 —
// 새 슬롯은 아무 전환에도 걸리지 않은 채 선언만 되어 산다.
//
// restriction만 칸이 없다. 그 슬롯이 컴파일되는 것은 실행 단위가 아니라 "전환 목록에서
// 제외"이고, 목록에 있는가 없는가가 곧 그 슬롯의 데이터다. 그래서 빈 종류 목록을 가진
// 슬롯을 걸러 내면 칸 넷이 남으며, 넷이라는 사실이 결정인지 빠뜨린 것인지는 시험이 가른다.
const SLOT_KEYS = Object.freeze(TRANSITION_SLOTS.filter((slot) => TRANSITION_SLOT_UNIT_KINDS[slot].length > 0));
// 이름 목록으로 실행 단위를 가리키는 슬롯. 승인만 빠진다 — 그 칸은 설정을 이미 쓰는
// 저장소에 `{ human: true }`로 서 있고, 이름 목록으로 수렴시키는 것은 그 저장소를
// 건드리는 일이라 계약이 "빠진 것이 아니라 뒤처져 있다"고 적어 두고 멈췄다.
const NAMED_SLOT_KEYS = Object.freeze(SLOT_KEYS.filter((slot) => slot !== 'approval'));
const TRANSITION_KEYS = Object.freeze(['from', 'to', 'title', 'description'].concat(SLOT_KEYS));
const APPROVAL_KEYS = Object.freeze(['human', 'reason']);
// 어느 슬롯이 이 종류를 무는가. 어휘의 표를 뒤집은 것이고, 뒤집어 두면 종류가 슬롯에
// 안 맞을 때 "이 종류는 어느 칸에 적어야 하는가"를 거부 메시지가 말할 수 있다.
const SLOT_BY_UNIT_KIND = Object.freeze(
  EXECUTION_UNIT_KINDS.reduce((table, kind) => {
    const slot = TRANSITION_SLOTS.find((name) => TRANSITION_SLOT_UNIT_KINDS[name].includes(kind));
    return Object.assign(table, { [kind]: slot || null });
  }, {})
);

function rejectAt(context, at, reason) {
  return new Error(`${(context && context.file) || 'workflows.json'}: ${at}: ${reason}`);
}

/**
 * 이 전환을 밟으면 런이 열리는가. 슬롯마다 손으로 적지 않고 어휘가 계산해 둔 경계를 읽는다.
 *
 * 경계는 "규칙이 있는가"가 아니라 "판정 함수가 혼자 답할 수 없는 것이 있는가"이고, 그
 * 물음의 답은 이미 실행 단위 종류가 갖고 있다. 여기 다시 적으면 슬롯이 무는 종류를
 * 바꾸는 날 이 값만 옛 답을 들고 남는다.
 *
 * 판정은 이 값을 보지 않는다. 런을 여는 것은 밟는 일이지 막는 일이 아니므로 여는
 * 슬롯이 걸렸다는 사실만으로 Blocker를 내면, 실행 계층이 서기 전까지 그 전환은 다시
 * 벽이 된다. 그래서 이 값은 밟는 표면에 실어 보내고 판정은 승인만 묻는다.
 */
function transitionOpensRun(transition) {
  return RUN_OPENING_SLOTS.some((slot) => (slot === 'approval'
    ? Boolean(transition.approval && transition.approval.human)
    : Boolean(transition[slot] && transition[slot].length)));
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(entry, allowed, context, at) {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) throw rejectAt(context, `${at}.${key}`, `알 수 없는 키입니다. 쓸 수 있는 것: ${allowed.join(' · ')}`);
  }
}

// disabled는 true만 받는다. 되살리려면 그 줄을 지운다 — 사용 안 함은 값이 아니라
// 항목의 상태이고, 없앴다는 판단이 파일에 남아야 나중에 왜 없앴는지 답할 수 있다.
function checkDisabled(entry, context, at) {
  if (entry.disabled !== undefined && entry.disabled !== true) {
    throw rejectAt(context, `${at}.disabled`, 'disabled는 true만 쓸 수 있습니다. 되살리려면 그 줄을 지우세요.');
  }
}

function normalizeNode(raw, context, at) {
  if (!plainObject(raw)) throw rejectAt(context, at, '노드 정의는 객체여야 합니다.');
  unknownKeys(raw, NODE_ENTRY_KEYS, context, at);
  checkDisabled(raw, context, at);
  if (raw.disabled === true) return { disabled: true };
  if (!WORKFLOW_STEPS.includes(raw.step)) {
    throw rejectAt(context, `${at}.step`, `스텝은 다음 중 하나여야 합니다: ${WORKFLOW_STEPS.join(' · ')}`);
  }
  const validity = raw.validity === undefined ? null : raw.validity;
  if (validity !== null) {
    if (!COMPLETION_VALIDITIES.includes(validity)) {
      throw rejectAt(context, `${at}.validity`, `유효성은 다음 중 하나여야 합니다: ${COMPLETION_VALIDITIES.join(' · ')}`);
    }
    // 유효성은 completed에서만 뜻이 있다. 다른 스텝에 붙으면 그 값을 읽는 쪽이
    // 없는 축을 있는 것으로 다룬다.
    if (raw.step !== 'completed') {
      throw rejectAt(context, `${at}.validity`, '유효성은 completed 스텝에서만 쓸 수 있습니다.');
    }
  }
  if (raw.requiresOwner !== undefined && typeof raw.requiresOwner !== 'boolean') {
    throw rejectAt(context, `${at}.requiresOwner`, 'requiresOwner는 참 또는 거짓이어야 합니다.');
  }
  return {
    step: raw.step,
    validity,
    requiresOwner: raw.requiresOwner === true,
    label: raw.label === undefined ? null : String(raw.label),
    ratified: null
  };
}

/**
 * 이름 붙인 실행 단위. 전환이 슬롯에서 이 이름을 가리키고, 한 단위가 전환 여럿에 걸린다.
 *
 * 전환마다 검사를 처음부터 다시 적게 하면 워크플로가 비대해진다 — 지라가 전환 N:M을
 * 두지 않아 validator를 전환마다 다시 적는 자리가 그것이다. 이름을 붙여 두면 같은 검사가
 * 한 줄이고, 그 줄을 고치면 그것을 가리키는 전환이 전부 따라간다.
 *
 * gate 단위의 몸통은 소스 × 방법 선언이다. 그 판정기는 validation-catalog.js에 이미 있고
 * 순수 함수이므로 여기서 다시 짓지 않는다 — 두 벌이 되면 같은 규칙이 어디서 보느냐에 따라
 * 다른 판정을 받는다. 성질에 안 맞는 조합(unique × acceptance-criteria)이 판정이 아니라
 * 여기서 거부되는 것도 그 파일이 이미 하는 일이다.
 */
function normalizeUnits(raw, context, at) {
  if (raw === undefined || raw === null) return {};
  if (!plainObject(raw)) throw rejectAt(context, at, '실행 단위 목록은 객체여야 합니다.');
  // 실행 단위가 공통으로 갖는 칸. 나머지 칸은 종류가 정한다 — gate의 몸통은 소스 × 방법
  // 선언이고 그 키 목록은 validation-catalog.js가 든다.
  const commonKeys = ['kind', 'label', 'description', 'disabled'];
  const extraKeys = { human: ['reason'] };
  const units = {};
  const gates = {};
  for (const [name, entry] of Object.entries(raw)) {
    const where = `${at}.${name}`;
    if (!plainObject(entry)) throw rejectAt(context, where, '실행 단위는 객체여야 합니다.');
    checkDisabled(entry, context, where);
    if (entry.disabled === true) { units[name] = { disabled: true }; continue; }
    if (!EXECUTION_UNIT_KINDS.includes(entry.kind)) {
      throw rejectAt(context, `${where}.kind`, `실행 단위 종류는 다음 중 하나여야 합니다: ${EXECUTION_UNIT_KINDS.join(' · ')}`);
    }
    // 승인은 아직 이름 목록을 받지 않는다. 받는 척하면 human 단위를 선언한 사람은
    // 자기가 건 게이트가 도는 줄 알지만 어느 전환도 그 이름을 가리키지 못한다.
    if (entry.kind === 'human') {
      throw rejectAt(context, `${where}.kind`, 'human 단위는 아직 이름으로 가리킬 수 없습니다. 사람 게이트는 전환의 approval 칸에 직접 적으세요.');
    }
    const unit = { kind: entry.kind, label: entry.label === undefined ? null : String(entry.label) };
    if (entry.kind !== 'gate') {
      unknownKeys(entry, commonKeys.concat(extraKeys[entry.kind] || []), context, where);
      units[name] = unit;
      continue;
    }
    // 선언은 카탈로그가 읽는다. 공통 칸만 떼어 내고 나머지는 손대지 않은 채로 넘긴다 —
    // 여기서 키를 골라 담으면 카탈로그가 늘린 파라미터를 이 파일이 조용히 버린다.
    const declaration = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!commonKeys.includes(key)) declaration[key] = value;
    }
    gates[name] = declaration;
    units[name] = unit;
  }
  // 카탈로그를 한 번에 부른다. 이름 순서로 도는 것이 그 함수의 규율이라 하나씩 부르면
  // 거부가 나는 자리가 실행마다 달라진다. gate 단위의 이름은 그 자리에서 규칙 이름으로
  // 읽히므로 카탈로그의 표기를 따른다 — 이름이 규칙 식별자의 뒷자리가 되기 때문이고,
  // 그래서 다른 종류의 단위보다 이름 규칙이 좁다.
  const rules = normalizeValidations(gates, { file: (context && context.file) || 'workflows.json', path: at });
  for (const [name, rule] of Object.entries(rules)) {
    // 유일성은 프로젝트 전체를 보아야 답한다. 판정 계약이 항목 하나와 행위자만 나르므로
    // 전환에 걸면 영원히 "보지 못했다"로 남고, 보지 못한 규칙은 아무도 안 지키는 채로 산다.
    // 걸 자리가 없는 것이 아니라 자리가 다르다 — 유일성은 항상 참이어야 하므로 항목 유형이 든다.
    if (rule.source === 'composite') {
      throw rejectAt(context, `${at}.${name}.source`, 'composite 소스는 전환이 아니라 항목 유형에 겁니다. 유일성은 항목 하나만 보고 답할 수 없습니다.');
    }
    units[name].rule = rule;
  }
  return units;
}

/** 슬롯 하나가 가리키는 이름 목록. 값은 이름의 배열이고 순서는 목록의 순서다. */
function normalizeSlot(raw, slot, units, context, at) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw rejectAt(context, `${at}.${slot}`, `${slot} 슬롯은 비어 있지 않은 이름 배열이어야 합니다. 걸지 않으려면 그 줄을 지우세요.`);
  }
  const allowed = TRANSITION_SLOT_UNIT_KINDS[slot];
  const names = [];
  raw.forEach((value, index) => {
    const name = String(value);
    const where = `${at}.${slot}[${index}]`;
    if (names.includes(name)) throw rejectAt(context, where, `한 슬롯에 같은 실행 단위를 두 번 걸 수 없습니다: ${name}`);
    const unit = units[name];
    if (!unit) throw rejectAt(context, where, `이 워크플로에 없는 실행 단위입니다: ${name}`);
    if (!allowed.includes(unit.kind)) {
      const home = SLOT_BY_UNIT_KIND[unit.kind];
      throw rejectAt(context, where, `${slot} 슬롯은 ${allowed.join(' · ')} 단위만 받습니다. ${name}은 ${unit.kind}이므로 ${home} 칸에 겁니다.`);
    }
    names.push(name);
  });
  return Object.freeze(names);
}

function normalizeTransition(raw, nodeIds, units, context, at) {
  if (!plainObject(raw)) throw rejectAt(context, at, '전환은 객체여야 합니다.');
  unknownKeys(raw, TRANSITION_KEYS, context, at);
  const from = raw.from === undefined ? TRANSITION_WILDCARD : String(raw.from);
  const to = raw.to === undefined ? '' : String(raw.to);
  // (ALL)의 범위는 이 워크플로의 노드 목록 안이다. 바깥으로 열면 노드를 하나
  // 더하는 것만으로 기존 전환이 조용히 바뀐다 — 지라의 global transition이
  // 사고 나는 자리가 그것이다.
  if (from !== TRANSITION_WILDCARD && !nodeIds.includes(from)) {
    throw rejectAt(context, `${at}.from`, `이 워크플로에 없는 노드입니다: ${from}`);
  }
  if (!nodeIds.includes(to)) throw rejectAt(context, `${at}.to`, `이 워크플로에 없는 노드입니다: ${to || '(비었음)'}`);
  let approval = null;
  if (raw.approval !== undefined) {
    if (!plainObject(raw.approval)) throw rejectAt(context, `${at}.approval`, '승인 슬롯은 객체여야 합니다.');
    unknownKeys(raw.approval, APPROVAL_KEYS, context, `${at}.approval`);
    if (raw.approval.human !== true) {
      throw rejectAt(context, `${at}.approval.human`, '승인 슬롯은 human: true만 쓸 수 있습니다. 걸지 않으려면 approval을 지우세요.');
    }
    approval = { human: true, reason: raw.approval.reason === undefined ? null : String(raw.approval.reason) };
  }
  const transition = { from, to, title: raw.title === undefined ? null : String(raw.title), approval };
  for (const slot of NAMED_SLOT_KEYS) transition[slot] = normalizeSlot(raw[slot], slot, units, context, at);
  return transition;
}

/**
 * 설정 한 층을 판정이 읽을 수 있는 모양으로 옮긴다. 파일을 읽지 않는다 — 읽는
 * 일은 workflow-config.js가 맡고 이 파일은 값만 보고 답한다.
 */
function normalizeWorkflows(raw, options) {
  const context = options || {};
  if (raw === undefined || raw === null) return {};
  if (!plainObject(raw)) throw rejectAt(context, 'workflows', '워크플로 정의는 객체여야 합니다.');
  const out = {};
  for (const [id, entry] of Object.entries(raw)) {
    const at = `workflows.${id}`;
    if (!plainObject(entry)) throw rejectAt(context, at, '워크플로 정의는 객체여야 합니다.');
    unknownKeys(entry, WORKFLOW_ENTRY_KEYS, context, at);
    checkDisabled(entry, context, at);
    if (entry.disabled === true) { out[id] = { disabled: true }; continue; }
    if (entry.targetKind !== undefined && !TARGET_KINDS.includes(entry.targetKind)) {
      throw rejectAt(context, `${at}.targetKind`, `대상 종류는 다음 중 하나여야 합니다: ${TARGET_KINDS.join(' · ')}`);
    }
    const nodes = {};
    const rawNodes = entry.nodes === undefined ? {} : entry.nodes;
    if (!plainObject(rawNodes)) throw rejectAt(context, `${at}.nodes`, '노드 목록은 객체여야 합니다.');
    for (const [nodeId, node] of Object.entries(rawNodes)) nodes[nodeId] = normalizeNode(node, context, `${at}.nodes.${nodeId}`);
    out[id] = {
      targetKind: entry.targetKind === undefined ? 'task' : entry.targetKind,
      label: entry.label === undefined ? null : String(entry.label),
      nodes,
      // 실행 단위는 층마다 푼다. 노드와 같이 항목 단위로 겹치는 값이고, 몸통의 거부는
      // 그것을 적은 파일을 물어야 한다 — 합친 뒤에 풀면 상위 층의 오타가 하위 층의
      // 파일 이름을 달고 나온다.
      units: normalizeUnits(entry.executionUnits, context, `${at}.executionUnits`),
      // 전환은 층을 합친 뒤에 푼다. 상위가 선언한 노드를 하위 전환이 가리킬 수
      // 있어야 하는데, 층마다 풀면 그 참조가 자기 층 안에서만 성립한다.
      rawTransitions: entry.transitions === undefined ? null : entry.transitions
    };
  }
  return out;
}

/**
 * 3단 상속. 내장 → workspace → project 순으로 겹친다.
 *
 * 노드는 항목 단위로 합치고 전환은 층 단위로 갈아탄다. 전환을 항목 단위로 합치면
 * 하위가 상위의 전환 하나만 지우려 해도 목록 전체를 다시 적어야 하는데, 그렇게 적은
 * 목록은 상위가 바뀔 때 따라가지 못한다. 흐름은 통째로 읽히는 것이 낫다 —
 * JSON 한 덩어리를 읽으면 그 흐름이 전부 보여야 하기 때문이다.
 */
function mergeWorkflows(layers) {
  const merged = {};
  for (const layer of layers || []) {
    for (const [id, entry] of Object.entries(layer || {})) {
      const before = merged[id];
      if (entry.disabled === true) { merged[id] = { disabled: true }; continue; }
      const inherited = before && before.disabled !== true ? before : null;
      const nodes = Object.assign({}, inherited && inherited.nodes, entry.nodes);
      const units = Object.assign({}, inherited && inherited.units, entry.units);
      merged[id] = Object.assign({}, inherited, entry, { nodes, units });
      if ((entry.rawTransitions === null || entry.rawTransitions === undefined) && inherited && inherited.rawTransitions) {
        merged[id].rawTransitions = inherited.rawTransitions;
      }
    }
  }
  const out = {};
  for (const id of Object.keys(merged).sort()) {
    const entry = merged[id];
    if (entry.disabled === true) continue;
    const nodes = {};
    // 없앤 노드를 따로 센다. 없앤 것과 오타는 다르게 다뤄야 하기 때문이다 —
    // 없앤 노드를 가리키던 전환은 갈 곳을 잃었으므로 함께 사라지고, 없던 노드를
    // 가리키는 전환은 사람이 틀린 것이므로 막는다. 둘을 같이 처리하면 한쪽은
    // 지우려던 것을 못 지우고 다른 쪽은 오타가 조용히 통과한다.
    const removed = [];
    for (const [nodeId, node] of Object.entries(entry.nodes || {})) {
      if (node.disabled === true) { removed.push(nodeId); continue; }
      nodes[nodeId] = node;
    }
    // 없앤 실행 단위는 노드와 다르게 다룬다. 갈 곳을 잃은 전환은 함께 사라지는 것이
    // 맞지만, 검사 하나를 잃은 전환은 여전히 갈 곳이 있으므로 사라지면 안 된다 — 그
    // 전환은 남고 검사만 조용히 빠지며, 빠졌다는 사실은 아무 신호도 내지 않는다.
    // 그래서 아직 가리키는 전환이 있으면 거부한다. 함께 지우는 것이 하위 층의 일이다.
    const units = {};
    const removedUnits = [];
    for (const [name, unit] of Object.entries(entry.units || {})) {
      if (unit.disabled === true) { removedUnits.push(name); continue; }
      units[name] = unit;
    }
    const nodeIds = Object.keys(nodes);
    let transitions = null;
    if (entry.rawTransitions !== null && entry.rawTransitions !== undefined) {
      if (!Array.isArray(entry.rawTransitions)) throw rejectAt({}, `workflows.${id}.transitions`, '전환 목록은 배열이어야 합니다.');
      transitions = entry.rawTransitions
        .filter((item) => {
          if (!plainObject(item)) return true;
          const ends = [item.from, item.to].filter((value) => value !== undefined && value !== null).map(String);
          return !ends.some((value) => removed.includes(value));
        })
        .map((item, index) => {
          const at = `workflows.${id}.transitions[${index}]`;
          for (const slot of NAMED_SLOT_KEYS) {
            const names = Array.isArray(item && item[slot]) ? item[slot].map(String) : [];
            const gone = names.filter((name) => removedUnits.includes(name));
            if (gone.length) throw rejectAt({}, `${at}.${slot}`, `없앤 실행 단위를 아직 가리킵니다: ${gone.join(' · ')}. 그 전환도 함께 고치세요.`);
          }
          return normalizeTransition(item, nodeIds, units, {}, at);
        });
    }
    out[id] = { targetKind: entry.targetKind || 'task', label: entry.label || null, nodes, units, transitions };
  }
  return out;
}


// ── 노드에서 스텝으로 ───────────────────────────────────────────────────

/** 노드(상태 이름) 하나의 스텝. 모르는 노드는 null이다 — 지어내지 않는다. */
function stepOf(node) {
  const target = TASK_NODES[node === undefined || node === null ? '' : String(node)];
  return target ? target.step : null;
}

/** 완료의 유효성. completed가 아닌 스텝에서는 언제나 null이다. */
function validityOf(node) {
  const target = TASK_NODES[node === undefined || node === null ? '' : String(node)];
  return target ? target.validity : null;
}

// 아래 넷이 "끝났나 · 붙어 있나 · 아직 안 잡았나"를 묻던 자리를 받는다. 스텝
// 이름을 리터럴로 비교하는 것은 여기서만 하며, 그 이름은 닫힌 어휘라 팀이
// 달라도 같다. 노드 이름을 비교하는 것과 다른 종류의 일이다.

/** 더 손대지 않는 항목인가. 완료와 취소는 이유가 다르지만 이 점에서 같다. */
function isTerminal(node) {
  const step = stepOf(node);
  return step !== null && TERMINAL_WORKFLOW_STEPS.includes(step);
}

/** 아직 끝나지 않았는가. */
function isOpen(node) {
  const step = stepOf(node);
  return step !== null && OPEN_WORKFLOW_STEPS.includes(step);
}

/** 지금 누군가 붙어 있는가. 열린 것 중 아직 아무도 안 잡은 것을 뺀 것이다. */
function isActive(node) {
  const step = stepOf(node);
  return step !== null && ACTIVE_WORKFLOW_STEPS.includes(step);
}

/** 아직 아무도 안 잡았는가. */
function isUnclaimed(node) {
  return stepOf(node) === 'unclaimed';
}

/** 그 스텝에 서는 노드들. 목록 필터가 스텝으로 묻고 노드로 좁힐 때 쓴다. */
function nodesForStep(step) {
  return Object.keys(TASK_NODES).filter((node) => TASK_NODES[node].step === step);
}

/**
 * 화면에 실어 보낼 워크플로. 보드 화면은 브라우저에서 그대로 돌아 require를
 * 쓸 수 없으므로, 서버가 스냅숏에 실어 준다. 화면이 자기 목록을 따로 적으면
 * 저장값이 늘어도 화면은 그것을 모른 채 돈다 — board-presentation.js가 키
 * 목록을 정본에서 가져오는 것과 같은 이유다.
 */
function taskWorkflowView() {
  const nodes = {};
  for (const [node, target] of Object.entries(TASK_NODES)) {
    // requires는 그 노드에서만 채워야 하는 필드다. 화면이 "이 노드가 waiting인가"를
    // 묻는 대신 "이 노드가 blocker를 요구하는가"를 묻게 하려고 싣는다. 앞쪽으로
    // 물으면 노드 이름이 화면에 박히고, 프로젝트가 이름을 정의하는 날 그 화면은
    // 남의 이름을 들고 있게 된다.
    nodes[node] = {
      step: target.step,
      validity: target.validity,
      requires: Object.keys(NODE_EXCLUSIVE_FIELDS).filter((field) => NODE_EXCLUSIVE_FIELDS[field].node === node)
    };
  }
  return {
    targetKind: 'task',
    nodes,
    steps: WORKFLOW_STEPS.slice(),
    terminalSteps: TERMINAL_WORKFLOW_STEPS.slice(),
    openSteps: OPEN_WORKFLOW_STEPS.slice(),
    activeSteps: ACTIVE_WORKFLOW_STEPS.slice()
  };
}

/**
 * 묶음의 롤업. 가장 덜 진행된 원소가 묶음을 정한다 — 하나라도 남아 있으면 그
 * 묶음은 아직 안착하지 않았다.
 *
 * 진행 순서를 여기 다시 적지 않는다. WORKFLOW_STEPS가 이미 그 순서로 선언되어
 * 있고 끝난 것은 TERMINAL_WORKFLOW_STEPS가 가른다. 같은 목록을 두 번째로 적을
 * 수 있으면 언젠가 두 목록은 갈린다.
 *
 * 전부 끝났는데 completed와 dropped가 섞이면 답이 하나로 정해지지 않는다.
 * 성취와 취소는 "더 손대지 않는다"는 점만 같고 뜻이 반대이므로, 여기서 한쪽을
 * 고르지 않고 섞였다는 사실을 내보낸다 — 결정이 필요한 자리는 결정으로 남긴다.
 *
 * 이 계산은 migration-audit.js가 이관 시점에 쓰는 migration-map.js의 것과 같은
 * 규칙이다. 두 벌인 이유는 한쪽이 이관 산출물이라 언젠가 사라지기 때문이고,
 * 사라질 파일을 제품이 require하면 그 파일은 사라지지 못한다.
 */
function rollupStep(steps) {
  const list = (steps || []).filter((step) => WORKFLOW_STEPS.includes(step));
  if (!list.length) return { step: null, ambiguous: false };
  for (const step of OPEN_WORKFLOW_STEPS) {
    if (list.includes(step)) return { step, ambiguous: false };
  }
  const unique = Array.from(new Set(list));
  if (unique.length === 1) return { step: unique[0], ambiguous: false };
  return { step: null, ambiguous: true, mixed: unique.sort() };
}

/** 노드 목록에서 바로 롤업한다. 부르는 쪽이 스텝으로 옮기는 일을 되풀이하지 않는다. */
function rollupNodes(nodes) {
  return rollupStep((nodes || []).map(stepOf).filter(Boolean));
}

// ── 규칙 카탈로그 ───────────────────────────────────────────────────────
//
// 카탈로그는 하나이고 걸리는 자리가 둘이다 — 규칙이 두 군데 사는 것이 아니라
// 한 카탈로그가 두 자리에 걸린다. 그래서 origin이 규칙마다 붙는다.
//
//   item-type   항상 참이어야 함. 지금 고쳐야 한다.
//   transition  그 전환을 밟을 때만. 다른 전환으로 갈 수도 있다.
//
// 막힌 사람에게 이 구분이 필요하다. origin은 규칙의 성질이지 언제 도는지를
// 정하는 스위치가 아니다 — 완료에 앉아 있는 태스크가 TST를 안 걸고 있으면 그
// 사실은 전환을 밟지 않아도 여전히 참이고, 검사는 그것을 말해야 한다.
//
// 진단 코드는 지금 것을 그대로 쓴다. 06절이 코드를 검증 방법 축(RDL-VAL-*)에
// 붙이자고 한 것은 옳지만 그 재편은 소스 × 방법 카탈로그를 세우는 갈래의 일이고,
// 여기서 미리 바꾸면 그 갈래가 두 번 옮기게 된다. source · method 칸은 지금
// 채워 둔다 — 값이 있어야 그 갈래가 무엇을 어디에 이어야 하는지 보인다.

// 노드 하나에만 붙는 필드. "그 노드면 있어야 하고 아니면 없어야 한다"는 짝이
// 규칙 둘이 아니라 선언 하나에서 나온다. 짝을 두 줄로 적으면 한 줄만 고쳐지는
// 날이 오고, 실제로 이 짝은 저장 계층과 검사 계층에 서로 다른 강도로 있었다.
const NODE_EXCLUSIVE_FIELDS = Object.freeze({
  blocker: Object.freeze({
    node: 'waiting',
    parts: Object.freeze({ waitingFor: '대기 대상', condition: '해제 조건', since: '대기 시작 시각' }),
    missingRule: 'waiting-requires-blocker',
    missingCode: 'RDL-TASK-014',
    missingMessage: '대기 상태로 바꾸려면 대기 대상(waitingFor), 해제 조건(condition), 대기 시작 시각(since)이 필요합니다.',
    strayRule: 'blocker-only-when-waiting',
    strayCode: 'RDL-TASK-015',
    strayMessage: '대기 상태가 아닌 태스크에는 blocker를 둘 수 없습니다.'
  }),
  cancellation: Object.freeze({
    node: 'cancelled',
    parts: Object.freeze({ reason: '반려 사유', decidedBy: '결정자', at: '결정 시각' }),
    missingRule: 'dropped-requires-cancellation',
    missingCode: 'RDL-TASK-023',
    missingMessage: '반려에는 반려 사유(reason), 결정자(decidedBy), 결정 시각(at)이 모두 필요합니다.',
    strayRule: 'cancellation-only-when-dropped',
    strayCode: 'RDL-TASK-024',
    strayMessage: '반려 상태가 아닌 태스크에는 cancellation을 둘 수 없습니다.'
  })
});

function filled(value) {
  return Boolean(value) && String(value).trim() !== '';
}

function completeParts(value, parts) {
  return Boolean(value) && typeof value === 'object' && Object.keys(parts).every((part) => filled(value[part]));
}

function criteriaOf(item) {
  const criteria = item && item.acceptanceCriteria;
  return criteria && typeof criteria === 'object' ? Object.values(criteria) : [];
}

function linksOf(item) {
  return Array.isArray(item && item.links) ? item.links : [];
}

// 면제 기록은 gates 배열이 정본이고 gate 하나만 든 옛 기록도 읽는다.
function exemptionGates(exemption) {
  if (!exemption) return [];
  if (Array.isArray(exemption.gates)) return exemption.gates.filter(Boolean).map(String);
  return exemption.gate ? [String(exemption.gate)] : [];
}

/** 사람이 사유를 대고 면제한 게이트인가. 면제된 규칙은 막는 목록에 오지 않는다. */
function exempted(item, ruleId) {
  const exemption = item && item.exemption;
  if (!exemption || !exemption.reason) return false;
  return exemptionGates(exemption).includes(ruleId);
}

// 규칙 하나. appliesTo는 노드와 스텝을 둘 다 받는다 — 대부분은 스텝으로 답하고,
// 노드 하나에만 붙는 필드 짝만 노드로 답한다. 그 둘을 억지로 한 축에 밀어 넣으면
// waiting과 doing이 같은 스텝이라는 사실 때문에 blocker 규칙이 doing에도 걸린다.
const TASK_RULES = [];

TASK_RULES.push({
  ruleId: 'claimed-requires-owner',
  code: 'RDL-TASK-007',
  origin: 'item-type',
  source: 'field',
  method: 'present',
  path: 'owner',
  // 어느 노드가 담당자를 요구하는지는 워크플로가 든다. 예전에는 이 자리에 노드
  // 넷이 손으로 적혀 있었고, 목록이 규칙 안에 있으면 그 목록이 무엇을 빠뜨렸는지
  // 읽을 방법이 없다. 3단계에서 workflows.json이 이 칸을 받는다.
  appliesTo: (node, step, nodes) => { const table = nodes || TASK_NODES; return Boolean(table[node] && table[node].requiresOwner); },
  holds: (item) => filled(item.owner),
  message: (item) => `${item.status} 상태에는 owner가 필요합니다.`
});

for (const [field, spec] of Object.entries(NODE_EXCLUSIVE_FIELDS)) {
  TASK_RULES.push({
    ruleId: spec.missingRule,
    code: spec.missingCode,
    origin: 'item-type',
    source: 'field',
    method: 'present',
    path: field,
    appliesTo: (node) => node === spec.node,
    holds: (item) => completeParts(item[field], spec.parts),
    message: () => spec.missingMessage
  });
  TASK_RULES.push({
    ruleId: spec.strayRule,
    code: spec.strayCode,
    origin: 'item-type',
    source: 'field',
    method: 'present',
    path: field,
    appliesTo: (node) => node !== spec.node,
    holds: (item) => !item[field],
    message: () => spec.strayMessage
  });
}

TASK_RULES.push({
  ruleId: 'exemption-only-when-completed',
  code: 'RDL-TASK-026',
  origin: 'item-type',
  source: 'field',
  method: 'present',
  path: 'exemption',
  // 면제는 완료를 위한 것이다. 다른 스텝에 남겨 두면 무엇을 면제한 것인지가
  // 사라지고, 되살아난 태스크가 옛 사유를 들고 다시 닫힌다.
  appliesTo: (node, step) => step !== 'completed',
  holds: (item) => !item.exemption,
  message: () => '완료 상태가 아닌 태스크에는 게이트 면제를 둘 수 없습니다.'
});

TASK_RULES.push({
  ruleId: 'completion-requires-acceptance',
  code: 'RDL-TASK-018',
  origin: 'transition',
  source: 'acceptance-criteria',
  method: 'every',
  path: 'acceptanceCriteria',
  // 조건을 다 채우지 않고 완료로 넘어갈 수 없다. 어느 항목 유형이든 같으므로
  // 유형 정의로 내리지 않는다.
  appliesTo: (node, step) => step === 'completed',
  holds: (item) => criteriaOf(item).every((criterion) => criterion && criterion.done),
  message: () => 'done 태스크에 미완료 수용조건이 있습니다.'
});

TASK_RULES.push({
  ruleId: 'done-requires-test-link',
  code: 'RDL-TASK-019',
  origin: 'transition',
  source: 'link',
  method: 'some',
  path: 'links',
  // 이름이 붙은 게이트다. 이름으로 부르고 이름으로 면제하므로 유형 해석기가
  // 게이트 표를 통해 이 규칙을 부르고, 검사기는 같은 규칙을 두 번 내지 않는다.
  gate: true,
  appliesTo: (node, step) => step === 'completed',
  holds: (item) => linksOf(item).some((link) => String(link).startsWith('TST-')),
  message: () => 'done 태스크는 TST 문서를 연결해야 합니다.'
});

TASK_RULES.push({
  ruleId: 'approval-requires-external-ref',
  code: 'RDL-TASK-020',
  origin: 'transition',
  source: 'field',
  method: 'count',
  path: 'externalRefs',
  appliesTo: (node, step) => step === 'in-approval',
  holds: (item) => Array.isArray(item.externalRefs) && item.externalRefs.length > 0,
  message: () => 'review 태스크는 PR 또는 검토 대상 externalRef가 필요합니다.'
});

// 규칙과 목록 둘 다 얼린다. 목록만 얼리면 안쪽 규칙의 판정을 밖에서 갈아끼울 수
// 있고, 그런 결함은 바꾼 곳이 아니라 엉뚱한 표면에서 드러난다.
TASK_RULES.forEach(Object.freeze);
Object.freeze(TASK_RULES);

// 카탈로그가 어휘를 벗어나지 않는지 적재 시점에 본다. 규칙 이름이 어휘에 없는
// origin을 들면 발화 이력이 그 규칙을 어느 축에도 넣지 못한다.
for (const rule of TASK_RULES) {
  if (!RULE_ORIGINS.includes(rule.origin)) throw new Error(`규칙이 어휘 밖 origin을 갖습니다: ${rule.ruleId} → ${rule.origin}`);
}
// 면제할 수 있는 게이트는 카탈로그 안의 규칙을 가리켜야 한다. 가리키는 규칙이
// 없으면 그 면제는 아무것도 열지 않으면서 사유만 받아 간다.
const RULE_IDS = TASK_RULES.map((rule) => rule.ruleId);
for (const gate of EXEMPTABLE_GATES) {
  // 구현 준비도 게이트는 아직 이 카탈로그 밖에 있다. 문서 선언을 읽어야 답하는
  // 규칙이라 항목만 보고는 답할 수 없고, 그것을 여기 넣으면 판정이 문서를 읽게
  // 된다. 넘어간다는 사실을 값으로 남긴다.
  if (gate === 'implementation-readiness') continue;
  if (!RULE_IDS.includes(gate)) throw new Error(`면제 가능한 게이트에 대응하는 규칙이 없습니다: ${gate}`);
}

// ── 판정 ────────────────────────────────────────────────────────────────

/**
 * 이름이 붙은 게이트인가. 유형 해석기가 게이트 표로 부르는 규칙이며, 검사기는
 * 같은 규칙을 직접 내지 않는다 — 두 자리가 같은 규칙을 내면 한 위반이 진단
 * 둘로 보이고, 사람은 고칠 것이 둘이라고 읽는다.
 */
function isGateRule(ruleId) {
  return TASK_RULES.some((rule) => rule.ruleId === ruleId && rule.gate === true);
}

function applicableRules(node) {
  const step = stepOf(node);
  if (step === null) return [];
  return TASK_RULES.filter((rule) => rule.appliesTo(node, step));
}

/**
 * 이번 판정이 실제로 본 규칙 전부. 막은 것만 적으면 "한 번도 안 막은 규칙"과
 * "한 번도 안 불린 규칙"이 같은 침묵이 되고, 그 둘은 정반대의 뜻이다.
 */
function evaluatedRules(node) {
  return applicableRules(node).map((rule) => rule.ruleId);
}

/** 면제되어 판정을 건너뛴 규칙. 면제는 검증이 아니라 별도 축이라 Blocker가 아니다. */
function exemptedRules(node, item) {
  const exemption = item && item.exemption;
  if (!exemption) return [];
  const gates = exemptionGates(exemption);
  return applicableRules(node)
    .filter((rule) => gates.includes(rule.ruleId))
    .map((rule) => ({
      ruleId: rule.ruleId,
      gate: rule.ruleId,
      reason: exemption.reason || null,
      decidedBy: exemption.decidedBy || null
    }));
}

/**
 * 전환 판정. 명령줄 · 보드 · 검사기 · 어댑터 네 표면이 같은 이 함수를 부른다.
 *
 * from이 null이면 항목 유형 판정이다 — 움직이지 않고 지금 자리에서 참이어야
 * 하는 것을 묻는다. 발화 이력이 origin을 item-type으로 적는 자리와 같다.
 *
 * item은 이미 읽힌 값이고, 전환을 물을 때는 옮긴 뒤의 모습이어야 한다. 옮기기
 * 전의 값을 넘기면 "옮겨도 되는가"가 아니라 "지금 괜찮은가"를 묻게 된다.
 *
 * 막는 규칙을 전부 돌려준다. 반환이 불리언이 아니라 목록인 것이 그 강제이고,
 * 빈 목록이 통과다. 면제된 규칙은 목록에 오지 않는다.
 *
 * actor는 계약이 정한 자리다. 지금 카탈로그에 행위자를 보는 규칙이 없어 쓰이지
 * 않지만, 인자를 빼면 그 규칙이 생기는 날 네 표면을 전부 고쳐야 한다.
 */
function judgeTransition(from, to, item, actor) {
  const node = to === undefined || to === null ? null : String(to);
  if (node === null || stepOf(node) === null) return [];
  const subject = item || {};
  const target = subject.id ? String(subject.id) : node;
  const blockers = [];
  for (const rule of applicableRules(node)) {
    if (exempted(subject, rule.ruleId)) continue;
    if (rule.holds(subject)) continue;
    blockers.push({
      ruleId: rule.ruleId,
      code: rule.code,
      origin: rule.origin,
      source: rule.source,
      method: rule.method,
      target: rule.path ? `${target}.${rule.path}` : target,
      message: rule.message(subject)
    });
  }
  return blockers;
}

/**
 * 지금 자리에서 참이어야 하는 것만 묻는다. 계약의 from = null 관용을 이름으로
 * 감싼 것이며 두 번째 계약이 아니다 — 부르는 쪽이 null을 손으로 적으면 그것이
 * 무슨 뜻인지 자리마다 다시 설명해야 한다.
 */
function judgeItem(item, actor) {
  return judgeTransition(null, item && item.status, item, actor);
}

/**
 * 막는 규칙 목록을 사람이 읽는 한 덩어리로 만든다. 표면마다 자기 방식으로
 * 이어 붙이면 어떤 표면은 첫 줄만 보여 주게 되고, 그 순간 왕복이 돌아온다.
 */
function blockerReport(blockers) {
  const list = blockers || [];
  if (!list.length) return '';
  if (list.length === 1) return `${list[0].code} ${list[0].message}`;
  return `막는 규칙 ${list.length}건: ${list.map((blocker) => `${blocker.code} ${blocker.message}`).join(' / ')}`;
}

// ── 승인 근거 ───────────────────────────────────────────────────────────
//
// 승인 슬롯은 "다른 행위자가 동의했는가"를 묻는다. 그 물음은 항목이 무엇을 갖췄는지로
// 답할 수 없으므로 규칙 카탈로그가 아니라 전환이 들고, 답은 근거가 값으로 실려 와야 선다.
//
// 판정은 여전히 파일도 시각도 읽지 않는다. 승인 기록의 정본은 런 스텝 원장이고, 그것을
// 읽어 이 모양으로 실어 주는 것은 부른 표면의 몫이다 — validation-catalog.js가 링크된
// 항목의 값을 related로 받는 것과 같은 갈라섬이며, 판정기와 배선을 가르는 것이 이
// 저장소가 이미 쓰는 수법이다.
//
// 실려 오지 않으면 막힌 채로 둔다. 없는 동의를 있는 것으로 세면 게이트가 아니라 통과
// 도장이 되기 때문이다. 그래서 "근거가 없다"와 "근거가 있는데 모자라다"는 같은 코드로
// 막되 다른 말을 한다 — 막힌 사람이 무엇을 해야 하는지가 그 둘 사이에서 갈린다.
//
// 어휘를 새로 짓지 않는다. 근거의 종류는 BASIS_KINDS이고 판정은 VERDICTS이며 둘 다
// approval-mode.js가 이미 쓰고 있다. 전환이 자기 어휘를 세우면 같은 물음에 두 벌의 답이
// 생기고, 두 벌은 갈린다. 정족수와 검증자 수도 여기서 정하지 않는다 — 그것은 승인 모드가
// 이미 든 손잡이이고, 전환이 다시 들면 같은 이름이 프로젝트마다 다른 뜻을 갖는다.

/** 항목에 실려 온 승인 근거. 값이 없으면 빈 목록이고, 없는 것과 모자란 것은 아래에서 갈린다. */
function approvalBases(item) {
  const list = item && item.approvals;
  return (Array.isArray(list) ? list : []).filter(plainObject);
}

/**
 * 근거 한 줄이 읽을 수 있는 모양인가. 모양이 아닌 줄은 세지 않는다 — 세면 아무 필드나
 * 담은 빈 객체 하나가 사람 게이트를 여는 길이 된다.
 *
 * 위임된 근거는 누구에게서 왔는지가 근거의 일부다. delegated인데 그 자리가 비면 책임이
 * 어디로 갔는지 아무도 답할 수 없고, 답할 수 없는 승인은 승인이 아니다.
 */
function usableBasis(basis) {
  if (!BASIS_KINDS.includes(basis.kind) || !VERDICTS.includes(basis.verdict)) return false;
  if (!filled(basis.actor)) return false;
  return basis.kind !== 'delegated' || filled(basis.delegatedFrom);
}

/**
 * 판정이 보는 행위자의 신원. 클라이언트 · 멤버 · 역할이 이미 해석되어 값으로 들어오므로
 * 여기서는 그중 책임을 지는 이름을 고른다 — 승인의 책임은 멤버가 진다.
 *
 * 모르면 null이다. 모르는 것을 같다고 세면 행위자를 안 싣는 표면에서 게이트가 다시
 * 벽이 되고, 다르다고 세면 자기 승인이 그 표면에서만 통과한다. 그래서 같다는 것이
 * 드러났을 때만 막는다 — 근거에 적힌 이름은 원장이 이미 검증한 값이다.
 */
function actorIdentity(actor) {
  if (typeof actor === 'string') return filled(actor) ? actor : null;
  if (!plainObject(actor)) return null;
  for (const field of ['memberId', 'id', 'clientId']) {
    if (filled(actor[field])) return String(actor[field]);
  }
  return null;
}

/**
 * 승인 슬롯이 채워졌는가. 채워졌으면 null이고 아니면 무엇이 모자란지다.
 *
 * 통과를 null로 두고 모자람을 문자열로 두는 것은 빈 문자열도 답이기 때문이다 — 근거가
 * 한 줄도 안 실려 온 것은 덧붙일 말이 없는 모자람이고, 그때 슬롯의 사유가 그대로 선다.
 * 부르는 쪽은 null과 견준다.
 *
 * 반려는 근거가 있어도 막는다. 기권과 가른 이유가 그것이다 — "보지 못했다"는 아직
 * 답이 아니지만 "보고 아니라 했다"는 답이며, 그 답을 다른 동의로 덮으면 가른 뜻이 없다.
 */
function approvalShortfall(item, actor) {
  const bases = approvalBases(item).filter(usableBasis);
  const refuted = bases.find((basis) => basis.verdict === 'refuted');
  if (refuted) return `${refuted.actor}이(가) 반려했습니다. 반려는 다른 동의로 덮이지 않습니다.`;
  const asker = actorIdentity(actor);
  const passed = bases.filter((basis) => basis.verdict === 'pass');
  if (passed.some((basis) => asker === null || String(basis.actor) !== asker)) return null;
  if (passed.length) return '자기 자신의 동의는 승인이 아닙니다. 다른 행위자의 동의가 필요합니다.';
  const abstained = bases.filter((basis) => basis.verdict === 'abstain').length;
  if (abstained) return `기권 ${abstained}건뿐입니다. 보지 못했다는 것은 동의가 아닙니다.`;
  return '';
}

// ── 워크플로 인스턴스 ───────────────────────────────────────────────────
//
// 노드 표를 인자로 받아 같은 판정을 돌린다. 내장도 이 팩토리를 거치므로 설정이
// 있는 저장소와 없는 저장소가 서로 다른 코드를 타지 않는다 — 두 벌이 되면 한쪽만
// 고쳐지는 날이 오고, 그날 어느 쪽이 정본인지 말할 근거가 없다.
//
// 규칙 카탈로그는 나누지 않는다. 노드 이름은 프로젝트가 정의하지만 "완료로 가려면
// 무엇이 필요한가"는 제품이 정하므로, 카탈로그 하나가 모든 인스턴스에 걸린다.
function createWorkflow(definition) {
  const nodes = (definition && definition.nodes) || {};
  const units = (definition && definition.units) || {};
  const transitions = (definition && definition.transitions) || null;
  const targetKind = (definition && definition.targetKind) || 'task';

  function stepOfNode(node) {
    const target = nodes[node === undefined || node === null ? '' : String(node)];
    return target ? target.step : null;
  }

  function validityOfNode(node) {
    const target = nodes[node === undefined || node === null ? '' : String(node)];
    return target && target.step === 'completed' ? target.validity : null;
  }

  function nodesForStepIn(step) {
    return Object.keys(nodes).filter((node) => nodes[node].step === step);
  }

  function rulesFor(node) {
    const step = stepOfNode(node);
    if (step === null) return [];
    return TASK_RULES.filter((rule) => rule.appliesTo(node, step, nodes));
  }

  /**
   * 이 전환이 선언되어 있는가. 전환 목록이 없으면 막지 않는다.
   *
   * 자기 자신은 (ALL)에 들지 않는다. A→(ALL)에 A→A가 있으면 "제자리 걸음"이 모든
   * 워크플로에 조용히 생기고, 그 전환은 아무도 선언한 적이 없다.
   */
  function transitionFor(from, to) {
    if (!transitions) return null;
    const source = from === undefined || from === null ? null : String(from);
    const target = String(to);
    return transitions.find((item) => {
      if (item.to !== target) return false;
      if (item.from === TRANSITION_WILDCARD) return source === null || source !== target;
      return item.from === source;
    }) || null;
  }

  /**
   * 검증 슬롯의 답. 판정기는 validation-catalog.js가 갖고 여기는 그것을 부르는 자리다.
   *
   * 못 본 규칙을 통과로 세지 않는다. 남의 항목을 가리키는 소스는 그 값이 실려 와야
   * 답할 수 있고, 실려 오지 않았는데 통과시키면 아무도 안 지키는 규칙이 지켜지는
   * 규칙으로 보인다. 그래서 판정하지 못한 것도 막는 목록에 오되, 무엇이 안 실렸는지를
   * 말한다 — 받는 사람이 고칠 곳은 항목이 아니라 부른 표면이다.
   *
   * 면제는 여기 걸리지 않는다. 면제할 수 있는 게이트는 어휘가 든 닫힌 목록이고 데이터로
   * 정의된 규칙은 그 목록에 들 수 없으므로, 면제를 여기서도 보면 저장이 받지 않는 면제를
   * 판정만 받아 주는 자리가 생긴다.
   */
  function validationBlockers(transition, subject, target) {
    if (!transition || !transition.validation) return [];
    const rules = {};
    for (const name of transition.validation) {
      const unit = units[name];
      if (unit && unit.rule) rules[name] = unit.rule;
    }
    if (!Object.keys(rules).length) return [];
    const answer = evaluateValidations(rules, subject, {
      origin: 'transition',
      // 규칙이 걸린 자리는 이 전환이다. item-type.js가 `유형.제약종류`로 쓰는 표기를
      // 그대로 따르며, 자리가 이름공간이라 같은 단위를 두 전환에 걸어도 발화 이력이
      // 두 규칙으로 세지 않고 어느 전환에서 걸렸는지를 답한다.
      owner: `${transition.from}→${transition.to}`,
      target,
      // 남의 항목의 값은 부른 표면이 이미 읽어서 실어 준다. 판정이 파일을 읽지 않으므로
      // 그 값은 항목을 타고 들어올 수밖에 없다 — 맵이 아니면 안 실린 것으로 본다.
      related: plainObject(subject.related) ? subject.related : {}
    });
    return answer.blocked.concat(answer.unresolved.map((entry) => ({
      ruleId: entry.ruleId,
      code: VALIDATION_DIAGNOSTICS[entry.method],
      origin: 'transition',
      source: entry.source,
      method: entry.method,
      target,
      message: `${entry.reason} 판정하지 못한 규칙은 통과로 세지 않습니다.`
    })));
  }

  function transitionAllowed(from, to) {
    if (!transitions) return true;
    // from이 없으면 항목 판정이다 — 움직이지 않으므로 전환 목록을 묻지 않는다.
    if (from === undefined || from === null) return true;
    if (String(from) === String(to)) return true;
    return Boolean(transitionFor(from, to));
  }

  /**
   * 전환 판정. 막는 규칙을 전부 돌려주며 빈 목록이 통과다.
   *
   * 순서가 있다. 선언되지 않은 전환이면 그 사실 하나만 돌려준다 — 갈 수 없는 자리에
   * 대해 "가면 무엇이 모자란가"를 함께 말하면 사람은 그 모자란 것을 채우려 들고,
   * 채워도 여전히 못 간다.
   */
  function judge(from, to, item, actor) {
    const node = to === undefined || to === null ? null : String(to);
    if (node === null || stepOfNode(node) === null) return [];
    const subject = item || {};
    const target = subject.id ? String(subject.id) : node;
    if (!transitionAllowed(from, node)) {
      return [{
        ruleId: 'transition-not-declared',
        code: 'RDL-FLOW-001',
        origin: 'transition',
        source: 'field',
        method: 'equals',
        target: `${target}.status`,
        message: `${from} 에서 ${node} 로 가는 전환이 이 워크플로에 없습니다.`
      }];
    }
    const blockers = [];
    for (const rule of rulesFor(node)) {
      if (exempted(subject, rule.ruleId)) continue;
      if (rule.holds(subject)) continue;
      blockers.push({
        ruleId: rule.ruleId,
        code: rule.code,
        origin: rule.origin,
        source: rule.source,
        method: rule.method,
        target: rule.path ? `${target}.${rule.path}` : target,
        message: rule.message(subject)
      });
    }
    // 움직이지 않으면 전환을 묻지 않는다. transitionAllowed가 이미 그렇게 하고 있고,
    // 여기서만 묻으면 (ALL) 전환에 걸린 슬롯이 그 노드에 앉아 있는 항목에도 걸린다 —
    // 같은 규칙이 출발을 적은 전환에서는 안 걸리므로, 답이 규칙의 성질이 아니라 그
    // 전환이 (ALL)로 적혔는가에 달리게 된다.
    const transition = from === undefined || from === null ? null : transitionFor(from, node);
    // 검증 슬롯은 판정 함수가 항목만 보고 답한다. 그래서 런을 열지 않고 여기서 끝난다 —
    // "규칙이 없으면 즉시"로 경계를 그으면 검증만 걸린 전환이 런을 열고, 그 런은 판정
    // 함수가 이미 답한 것을 다시 묻는다.
    blockers.push(...validationBlockers(transition, subject, target));
    // 승인 슬롯은 규칙 카탈로그가 아니라 전환이 든다. 카탈로그는 "항목이 무엇을
    // 갖췄는가"를 묻고 승인은 "다른 행위자가 동의했는가"를 묻는데, 뒤엣것은 항목만
    // 보고 답할 수 없다. 그 답은 근거가 값으로 실려 와야 서고, 실려 오면 슬롯이 열린다 —
    // 열리지 않으면 게이트가 아니라 벽이다.
    if (transition && transition.approval && transition.approval.human) {
      const shortfall = approvalShortfall(subject, actor);
      if (shortfall !== null) {
        const head = transition.approval.reason
          || `${transition.title || `${from} → ${node}`} 전환은 다른 행위자의 승인이 필요합니다.`;
        blockers.push({
          ruleId: 'transition-requires-approval',
          code: 'RDL-FLOW-002',
          origin: 'transition',
          source: 'field',
          method: 'present',
          target: `${target}.status`,
          human: true,
          message: shortfall ? `${head} ${shortfall}` : head
        });
      }
    }
    return blockers;
  }

  /** 화면에 실어 보낼 워크플로. 화면이 자기 목록을 따로 적으면 저장값이 늘어도 모른다. */
  function view() {
    const out = {};
    for (const [node, target] of Object.entries(nodes)) {
      out[node] = {
        step: target.step,
        validity: target.validity,
        label: target.label || null,
        requires: Object.keys(NODE_EXCLUSIVE_FIELDS).filter((field) => NODE_EXCLUSIVE_FIELDS[field].node === node)
      };
    }
    const namedUnits = {};
    for (const [name, unit] of Object.entries(units)) namedUnits[name] = { kind: unit.kind, label: unit.label || null };
    return {
      targetKind,
      nodes: out,
      // 실행 단위도 실린다. 전환이 이름으로 가리키므로 이름만 실어 보내면 화면이 그
      // 이름이 무엇인지 물을 자리가 없다.
      executionUnits: namedUnits,
      transitions: transitions
        ? transitions.map((item) => Object.assign(
          { from: item.from, to: item.to, title: item.title, approval: Boolean(item.approval && item.approval.human) },
          // 슬롯은 이름 목록 그대로 싣는다. 화면이 목록을 다시 만들면 저장값이 늘어도
          // 모르고, 그 사실은 아무 신호도 내지 않는다.
          NAMED_SLOT_KEYS.reduce((slots, slot) => Object.assign(slots, { [slot]: item[slot] ? item[slot].slice() : null }), {}),
          // 이 전환을 밟으면 런이 열리는가. 목록으로 적지 않고 어휘의 경계에서 계산한다 —
          // 다시 적으면 슬롯이 무는 종류를 바꾸는 날 이 값만 옛 답을 들고 남는다.
          { opensRun: transitionOpensRun(item) }
        ))
        : null,
      steps: WORKFLOW_STEPS.slice(),
      terminalSteps: TERMINAL_WORKFLOW_STEPS.slice(),
      openSteps: OPEN_WORKFLOW_STEPS.slice(),
      activeSteps: ACTIVE_WORKFLOW_STEPS.slice()
    };
  }

  return {
    nodes,
    units,
    transitions,
    targetKind,
    stepOf: stepOfNode,
    validityOf: validityOfNode,
    isTerminal: (node) => TERMINAL_WORKFLOW_STEPS.includes(stepOfNode(node)),
    isOpen: (node) => OPEN_WORKFLOW_STEPS.includes(stepOfNode(node)),
    isActive: (node) => ACTIVE_WORKFLOW_STEPS.includes(stepOfNode(node)),
    isUnclaimed: (node) => stepOfNode(node) === 'unclaimed',
    nodesForStep: nodesForStepIn,
    transitionAllowed,
    transitionFor,
    evaluatedRules: (node) => rulesFor(node).map((rule) => rule.ruleId),
    exemptedRules: (node, item) => {
      const exemption = item && item.exemption;
      if (!exemption) return [];
      const gates = exemptionGates(exemption);
      return rulesFor(node)
        .filter((rule) => gates.includes(rule.ruleId))
        .map((rule) => ({ ruleId: rule.ruleId, gate: rule.ruleId, reason: exemption.reason || null, decidedBy: exemption.decidedBy || null }));
    },
    judgeTransition: judge,
    judgeItem: (item, actor) => judge(null, item && item.status, item, actor),
    rollupNodes: (list) => rollupStep((list || []).map(stepOfNode).filter(Boolean)),
    taskWorkflowView: view
  };
}

// 내장 인스턴스. 설정이 없는 저장소가 타는 길이며, 아래 export가 전부 이것을 가리킨다.
const BUILTIN = createWorkflow({ nodes: TASK_NODES, transitions: null, targetKind: 'task' });

module.exports = Object.assign({}, BUILTIN, {
  TASK_NODES,
  TRANSITION_WILDCARD,
  SLOT_KEYS,
  NAMED_SLOT_KEYS,
  createWorkflow,
  normalizeWorkflows,
  mergeWorkflows,
  transitionOpensRun,
  approvalShortfall,
  isGateRule,
  exemptionGates,
  exempted,
  rollupStep,
  blockerReport
});
