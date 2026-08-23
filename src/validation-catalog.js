'use strict';

// 검증 카탈로그 — 소스 × 방법. 무엇을 보는가와 어떻게 보는가를 갈라 두고 그 조합으로
// 규칙을 적는다.
//
// 검사를 평평한 "종류" 목록으로 두면 새 검사가 필요할 때마다 목록이 는다. 지금 제약
// 카탈로그 다섯 중 넷이 그 모양이고, 이미 표현하지 못하는 규칙이 둘 있다 — 링크된
// TST가 전부 pass인가, 선행 태스크가 전부 종료됐는가. 수용조건 전부 done과 묶음의
// 항목 전부 종료까지 넷을 평평한 모델에 넣으면 종류가 넷 늘지만, 갈라 놓으면 방법
// 하나(every) × 소스 넷이다. 목록은 안 늘고 조합만 는다.
//
// 조합의 가부를 소스 × 방법 표로 적지 않는다. 소스의 성질이 쓸 수 있는 방법을 정하므로
// 그 표는 성질을 거쳐 소스 하나에 한 줄로 접힌다. 성질이 안 맞는 조합(unique ×
// acceptance-criteria)은 판정이 아니라 설정 파싱에서 거부된다. 판정 시점까지 끌고 가면
// 그 규칙은 아무 항목에도 맞지 않는 채로 조용히 살고, 사는 동안 아무 신호도 내지 않는다.
//
// 순수해야 하는 이유는 코드 취향이 아니라 답의 일치다. 같은 규칙을 명령줄과 보드와
// 검사기와 어댑터가 각자 읽으면 같은 항목이 어디서 보느냐에 따라 다른 판정을 받는다.
// 그래서 값 목록의 정본(vocabulary) 말고는 require를 갖지 않는다.
//
// 파일을 읽지 않는다. 네 표면은 각자 경로를 갖고 있고, 판정이 경로를 알면 각 표면이
// 자기 경로로 다시 구현하게 된다. 시각도 읽지 않는다 — 어제와 오늘의 답이 다르면
// 재현되지 않고, 재현되지 않는 판정은 막힌 사람에게 무엇을 고쳐야 하는지 말해 주지
// 못한다. 인자에 시계가 없는 것이 그 강제다. types/workflow.d.ts의 판정 계약이다.
//
// 이 파일은 카탈로그와 규칙 하나의 판정까지다. 네 표면이 부르는 (from, to, item, actor)는
// 워크플로 정의가 서야 만들어지므로 배선의 몫이고, 여기는 그 함수가 규칙마다 부르는
// 반쪽이다. 반쪽을 먼저 세울 수 있는 것은 VALIDATION_METHODS_BY_NATURE가 데이터로
// 서 있기 때문이다 — 성질이 코드였다면 배선을 기다려야 했다.

const {
  VALIDATION_SOURCE_KINDS,
  VALIDATION_METHODS,
  VALIDATION_SOURCE_NATURE,
  VALIDATION_METHODS_BY_NATURE,
  FIELD_TYPES,
  RULE_ORIGINS
} = require('./vocabulary');

/**
 * 진단 코드는 방법에 붙는다. 소스가 열 종이어도 코드는 여덟이고, 어느 소스가 걸렸는지는
 * 코드가 아니라 진단의 대상이 나른다. 코드 목록이 소스마다 늘면 어제 본 코드가 오늘
 * 없을 수 있고, 그런 목록은 문서도 도구도 참조할 수 없다.
 *
 * 번호는 VALIDATION_METHODS의 자리를 따르되 파생하지 않고 적는다. 파생하면 목록의
 * 순서를 바꾸는 것만으로 어제의 RDL-VAL-003이 오늘 다른 뜻이 되고, 그 사실은 아무
 * 신호도 내지 않는다. 코드는 목록보다 오래 산다 — 문서와 도구가 이 글자를 들고 있다.
 */
const VALIDATION_DIAGNOSTICS = Object.freeze({
  present: 'RDL-VAL-001',
  equals: 'RDL-VAL-002',
  type: 'RDL-VAL-003',
  range: 'RDL-VAL-004',
  count: 'RDL-VAL-005',
  every: 'RDL-VAL-006',
  some: 'RDL-VAL-007',
  unique: 'RDL-VAL-008'
});

// 진단 코드에서 방법으로 돌아오는 길. VALIDATION_DIAGNOSTICS의 역방향이며 목록을 다시
// 적지 않고 뒤집는다 — 다시 적으면 코드를 하나 더할 때 한쪽만 고쳐진다.
// item-type.js의 KIND_BY_DIAGNOSTIC이 제약 종류에 대해 같은 일을 한다.
const METHOD_BY_DIAGNOSTIC = Object.freeze(
  Object.fromEntries(Object.entries(VALIDATION_DIAGNOSTICS).map(([method, code]) => [code, method]))
);

// 방법과 코드의 일대일이 깨졌는지 부를 때가 아니라 실릴 때 안다. 코드 없는 방법은
// 판정할 수는 있어도 진단을 낼 수 없고, 그 규칙은 막으면서 이유를 말하지 못한다.
// 어휘가 방법을 늘리면 여기가 먼저 넘어져야 그 사실이 신호를 낸다.
for (const method of VALIDATION_METHODS) {
  if (!VALIDATION_DIAGNOSTICS[method]) throw new Error(`검증 방법에 진단 코드가 없습니다: ${method}`);
}
for (const method of Object.keys(VALIDATION_DIAGNOSTICS)) {
  if (!VALIDATION_METHODS.includes(method)) throw new Error(`어휘에 없는 검증 방법에 진단 코드가 붙었습니다: ${method}`);
}

/**
 * 소스가 받는 파라미터. 소스는 "무엇을 보는가"이므로 여기 있는 것은 볼 자리의 이름이다.
 *
 * 이름을 규칙이 대는 이유는 필드가 프로젝트의 것이기 때문이다. 판정기가 'result'나
 * 'status'를 알면 사용자가 정의한 것이 다시 코드가 된다.
 */
const SOURCE_PARAMS = Object.freeze({
  field: Object.freeze(['field']),
  link: Object.freeze(['linkType']),
  'link-field': Object.freeze(['linkType', 'field']),
  'acceptance-criteria': Object.freeze([]),
  dependency: Object.freeze([]),
  'bundle-item': Object.freeze([]),
  composite: Object.freeze(['fields', 'links'])
});

/** 방법이 받는 파라미터. 방법은 "어떻게 보는가"이므로 여기 있는 것은 견줄 값이다. */
const METHOD_PARAMS = Object.freeze({
  present: Object.freeze([]),
  equals: Object.freeze(['values']),
  type: Object.freeze(['type']),
  range: Object.freeze(['min', 'max']),
  count: Object.freeze(['min', 'max']),
  every: Object.freeze(['element']),
  some: Object.freeze(['element']),
  unique: Object.freeze(['releasedBy'])
});

/**
 * 소스가 항목의 어느 칸을 읽는가.
 *
 * 이 이름들은 프로젝트가 정의하는 값이 아니라 제품이 정한 기본 필드다(check-rules.js의
 * REQUIRED_TASK_FIELDS). 그래서 규칙이 대지 않고 여기가 든다 — 규칙이 대게 하면 같은
 * 칸을 가리키는 표기가 저장소마다 갈리고, 갈린 표기는 카탈로그를 하나로 두는 뜻을 지운다.
 *
 * items만 아직 저장 실체가 없다. 묶음은 workset.js가 외부참조에서 파생하고 있으므로,
 * 파생한 묶음을 값으로 실어 주는 쪽이 그 칸에 담는다. 자리를 비워 두지 않는 이유는
 * 비워 두면 bundle-item 소스가 선언은 되고 판정은 되지 않는 채로 남기 때문이다.
 */
const SOURCE_CONTAINER = Object.freeze({
  link: 'links',
  'link-field': 'links',
  'acceptance-criteria': 'acceptanceCriteria',
  dependency: 'deps',
  'bundle-item': 'items'
});

/** 선언한 타입의 판정. 이름 목록은 FIELD_TYPES가 갖고 여기는 그 이름마다의 물음이다. */
const TYPE_CHECKS = Object.freeze({
  string: (value) => typeof value === 'string',
  integer: (value) => Number.isInteger(value)
});

// 사람이 읽는 타입 요구. 이름이 아니라 문장을 드는 것은 조사가 이름마다 다르기
// 때문이다 — item-type.js가 같은 두 규칙에 쓰는 말과 같아야 두 진단이 한 말로 읽힌다.
const TYPE_TEXTS = Object.freeze({ string: '문자열이어야 합니다', integer: '정수여야 합니다' });

/**
 * 규칙 이름. 규칙 식별자가 `자리.이름`이므로 이름에 점이 들어가면 자리와 이름의 경계가
 * 흐려지고, 흐려진 식별자는 발화 이력에서 두 규칙을 한 규칙으로 세게 만든다.
 */
const VALIDATION_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// 항목의 필드 이름. 저장된 항목이 쓰는 표기를 그대로 가리킨다.
const FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/u;
// 문서 유형은 문서 식별자의 앞자리다. 이미 저장된 문서들이 대문자로 적혀 있다.
const DOCUMENT_TYPE_PATTERN = /^[A-Z][A-Z0-9]*$/u;
const LINK_ANCHOR = /#.*$/u;
// 조건식으로 읽히는 키. 파라미터가 이것을 받는 순간 이 설계는 규칙 언어가 되고,
// 규칙을 읽으려면 규칙 언어를 먼저 읽어야 한다.
const OPERATOR_KEY_PATTERN = /^\$/u;

/** 거부는 파일 경로와 키 경로와 이유를 함께 문다. 이름만 알리면 오타로 여기고 철자를 고친다. */
function reject(context, at, reason) {
  return new Error(`${context.file}: ${at}: ${reason}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function isScalar(value) {
  const type = typeof value;
  return type === 'string' || type === 'boolean' || (type === 'number' && Number.isFinite(value));
}

function assertAllowedKeys(value, allowed, context, at, label) {
  for (const key of Object.keys(value)) {
    // 조건 연산자를 먼저 가른다. 나중에 가르면 `$ne`가 "알 수 없는 키"라는 엉뚱한
    // 이름으로 거부되고, 그 메시지를 받은 사람은 철자를 고치려 든다.
    if (OPERATOR_KEY_PATTERN.test(key)) {
      throw reject(context, `${at}.${key}`, `파라미터는 값과 이름만 받습니다. 조건 연산자를 쓸 수 없습니다: ${key}`);
    }
    if (!allowed.includes(key)) throw reject(context, `${at}.${key}`, `알 수 없는 키입니다: ${key} (${label}: ${allowed.join(', ')})`);
  }
}

function assertName(value, context, at, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw reject(context, at, `${label} 형식이 아닙니다: ${String(value)}`);
  return value;
}

function assertNameList(value, context, at, pattern, label) {
  if (!Array.isArray(value) || value.length === 0) throw reject(context, at, `${label}는 비어 있지 않은 이름 배열이어야 합니다.`);
  return value.map((name, index) => assertName(name, context, `${at}[${index}]`, pattern, label));
}

function assertScalarList(value, context, at, label) {
  if (!Array.isArray(value) || value.length === 0) throw reject(context, at, `${label}는 비어 있지 않은 배열이어야 합니다.`);
  return value.map((entry, index) => {
    if (!isScalar(entry)) throw reject(context, `${at}[${index}]`, '파라미터는 값과 이름만 받습니다. 여기에는 값 하나가 와야 합니다.');
    return entry;
  });
}

function assertBound(value, context, at, floor) {
  if (!Number.isInteger(value)) throw reject(context, at, `정수여야 합니다: ${String(value)}`);
  if (value < floor) throw reject(context, at, `${floor} 이상이어야 합니다: ${String(value)}`);
  return value;
}

// ── 파싱 ────────────────────────────────────────────────────────────────

/**
 * 소스가 볼 자리를 읽는다. 소스마다 필요한 이름이 다르고, 없으면 판정이 무엇을 볼지
 * 모르는 채로 서게 되므로 여기서 막는다.
 */
function normalizeSource(rule, value, context, at) {
  if (rule.source === 'field' || rule.source === 'link-field') {
    rule.field = assertName(value.field, context, `${at}.field`, FIELD_NAME_PATTERN, '필드 이름');
  }
  if (rule.source === 'link' || rule.source === 'link-field') {
    rule.linkType = assertName(value.linkType, context, `${at}.linkType`, DOCUMENT_TYPE_PATTERN, '문서 유형');
  }
  if (rule.source !== 'composite') return;
  // 조합은 필드와 링크 중 어느 쪽이든 될 수 있지만 둘 다 비면 조합이 아니다. 빈 조합의
  // 유일성은 항목 전부가 서로 겹친다는 뜻이 되어 아무 말도 하지 못한다.
  rule.fields = value.fields === undefined ? [] : assertNameList(value.fields, context, `${at}.fields`, FIELD_NAME_PATTERN, '필드 이름');
  rule.links = value.links === undefined ? [] : assertNameList(value.links, context, `${at}.links`, DOCUMENT_TYPE_PATTERN, '문서 유형');
  if (rule.fields.length === 0 && rule.links.length === 0) {
    throw reject(context, at, 'composite 소스는 fields나 links 중 하나 이상을 조합해야 합니다.');
  }
}

/**
 * 원소를 무엇으로 보는가. every · some이 받는 유일한 조건이며 없으면 "채워짐"이다.
 *
 * 조건을 여기 두는 것과 전환에 두는 것은 다르다. 전환에 걸린 규칙의 "언제"는 전환이
 * 답하지만, 원소 하나하나를 무엇으로 볼지는 목록 안쪽의 물음이라 전환이 답하지 못한다.
 */
function normalizeElement(value, context, at) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) throw reject(context, at, '원소 조건은 객체여야 합니다.');
  assertAllowedKeys(value, ['field', 'values'], context, at, '원소 조건이 받는 키');
  const element = {};
  if (value.field !== undefined) element.field = assertName(value.field, context, `${at}.field`, FIELD_NAME_PATTERN, '필드 이름');
  if (value.values !== undefined) element.values = assertScalarList(value.values, context, `${at}.values`, '허용값');
  if (element.field === undefined && element.values === undefined) {
    throw reject(context, at, '원소 조건은 field나 values 중 하나 이상을 정해야 합니다. 둘 다 없으면 조건을 적지 마세요.');
  }
  return Object.freeze(element);
}

function normalizeMethod(rule, value, context, at) {
  if (rule.method === 'equals') {
    rule.values = assertScalarList(value.values, context, `${at}.values`, '허용값');
  }
  if (rule.method === 'type') {
    const declared = value.type;
    if (!FIELD_TYPES.includes(declared)) throw reject(context, `${at}.type`, `알 수 없는 타입입니다: ${String(declared)} (${FIELD_TYPES.join(', ')})`);
    // 어휘가 타입을 늘렸는데 판정이 그 타입을 모를 수 있다. 그때 조용히 통과시키면
    // 선언한 타입을 아무도 보지 않는 규칙이 되므로 정의를 받는 자리에서 막는다.
    if (!TYPE_CHECKS[declared]) throw reject(context, `${at}.type`, `판정기가 아직 보지 못하는 타입입니다: ${declared}`);
    rule.type = declared;
  }
  if (rule.method === 'range' || rule.method === 'count') {
    // 개수는 음수가 될 수 없고 범위는 될 수 있다. 같은 min·max를 쓰면서도 바닥이
    // 다른 이유가 그것이며, 두 방법을 하나로 접지 않은 이유이기도 하다.
    const floor = rule.method === 'count' ? 0 : Number.MIN_SAFE_INTEGER;
    if (value.min !== undefined) rule.min = assertBound(value.min, context, `${at}.min`, floor);
    if (value.max !== undefined) rule.max = assertBound(value.max, context, `${at}.max`, floor);
    if (rule.min === undefined && rule.max === undefined) throw reject(context, at, `${rule.method}는 min이나 max 중 하나 이상이 필요합니다.`);
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) {
      throw reject(context, at, `min이 max보다 큽니다: ${rule.min} > ${rule.max}`);
    }
  }
  if (rule.method === 'every' || rule.method === 'some') {
    rule.element = normalizeElement(value.element, context, `${at}.element`);
  }
  if (rule.method !== 'unique') return;
  if (value.releasedBy === undefined) {
    rule.releasedBy = null;
    return;
  }
  // 놓아주는 자리를 항목이 아니라 규칙이 댄다. 판정기가 'status'를 알면 태스크만
  // 판정할 수 있게 되고, 카탈로그 하나가 태스크와 문서에 함께 걸린다는 전제가 깨진다.
  if (!isPlainObject(value.releasedBy)) throw reject(context, `${at}.releasedBy`, '놓아주는 조건은 { field, values } 객체여야 합니다.');
  assertAllowedKeys(value.releasedBy, ['field', 'values'], context, `${at}.releasedBy`, '놓아주는 조건이 받는 키');
  rule.releasedBy = Object.freeze({
    field: assertName(value.releasedBy.field, context, `${at}.releasedBy.field`, FIELD_NAME_PATTERN, '필드 이름'),
    values: assertScalarList(value.releasedBy.values, context, `${at}.releasedBy.values`, '놓아주는 값')
  });
}

function normalizeRule(name, value, context) {
  const at = `${context.path}.${name}`;
  assertName(name, context, at, VALIDATION_NAME_PATTERN, '규칙 이름');
  if (!isPlainObject(value)) throw reject(context, at, '검증 규칙은 객체여야 합니다.');
  const source = value.source;
  if (!VALIDATION_SOURCE_KINDS.includes(source)) {
    throw reject(context, `${at}.source`, `알 수 없는 검증 소스입니다: ${String(source)} (${VALIDATION_SOURCE_KINDS.join(', ')})`);
  }
  const method = value.method;
  if (!VALIDATION_METHODS.includes(method)) {
    throw reject(context, `${at}.method`, `알 수 없는 검증 방법입니다: ${String(method)} (${VALIDATION_METHODS.join(', ')})`);
  }
  // 조합의 가부는 여기서 끝난다. 성질이 쓸 수 있는 방법을 정하므로 소스 × 방법 표를
  // 두지 않고, 안 맞는 조합은 판정까지 가지 못한다.
  const nature = VALIDATION_SOURCE_NATURE[source];
  const usable = VALIDATION_METHODS_BY_NATURE[nature] || [];
  if (!usable.includes(method)) {
    throw reject(context, `${at}.method`, `${source} 소스는 성질이 ${nature}이므로 ${method}로 볼 수 없습니다: 쓸 수 있는 방법은 ${usable.join(', ')}입니다.`);
  }
  assertAllowedKeys(value, ['source', 'method'].concat(SOURCE_PARAMS[source], METHOD_PARAMS[method]), context, at, `${source} × ${method}가 받는 키`);
  const rule = { name, source, method, nature };
  normalizeSource(rule, value, context, at);
  normalizeMethod(rule, value, context, at);
  if (Array.isArray(rule.fields)) rule.fields = Object.freeze(rule.fields);
  if (Array.isArray(rule.links)) rule.links = Object.freeze(rule.links);
  if (Array.isArray(rule.values)) rule.values = Object.freeze(rule.values);
  return Object.freeze(rule);
}

/**
 * 규칙 선언을 판정할 수 있는 모양으로 만든다. 이름을 키로 갖는 맵이며, 이름이 규칙
 * 식별자의 뒷자리가 된다.
 *
 * 이름 순서로 돈다. 같은 정의면 같은 결과여야 하고 거부도 같은 자리에서 나야 재현이
 * 된다 — 첫 위반에서 멈추는 파싱에서 순서가 흔들리면 무엇이 먼저 걸리는지가 실행마다
 * 달라진다.
 */
function normalizeValidations(declarations, options) {
  const settings = options || {};
  const context = { file: settings.file || '(내장 정의)', path: settings.path || 'validations' };
  if (!isPlainObject(declarations)) throw reject(context, context.path, '검증 규칙은 이름을 키로 갖는 맵이어야 합니다.');
  const normalized = {};
  for (const name of Object.keys(declarations).sort()) normalized[name] = normalizeRule(name, declarations[name], context);
  return normalized;
}

// ── 소스 읽기 ───────────────────────────────────────────────────────────

/**
 * 목록 칸의 원소. 수용조건은 맵이고 링크와 선행은 배열이라 둘 다 받는다.
 *
 * 칸이 없으면 빈 목록이다. 없는 것과 못 읽는 것은 다르다 — 선행이 없는 태스크는
 * 선행을 전부 만족한 것이고, 그것을 판정하지 못한 것으로 세면 이 규칙이 아무 항목에도
 * 닿지 않은 것처럼 보인다.
 */
function elementsOf(container) {
  if (Array.isArray(container)) return container.slice();
  if (isPlainObject(container)) return Object.values(container);
  return [];
}

/** 항목이 연 문서 중 그 유형에 해당하는 것. 앵커는 문서가 아니라 문서 안의 자리다. */
function linkedIds(item, linkType) {
  const pattern = new RegExp(`^${linkType}-\\d{3,}$`, 'u');
  return elementsOf(item.links)
    .map((link) => String(link).replace(LINK_ANCHOR, ''))
    .filter((link) => pattern.test(link));
}

/**
 * 소스가 가리키는 값. 스칼라 하나이거나 원소 목록이다.
 *
 * 남의 항목을 가리키는 소스는 related로 받는다. 판정이 파일을 읽지 않으므로 링크된
 * 문서와 선행 태스크의 값은 부른 표면이 이미 읽어서 실어 준다. 실어 주지 않으면
 * 판정하지 못한 것으로 남기고 판정한 척하지 않는다 — 통과로 세면 아무도 안 지키는
 * 규칙이 지켜지는 규칙으로 보인다.
 */
function resolveSource(rule, item, settings) {
  if (rule.source === 'field') return { ok: true, value: item[rule.field] };
  if (rule.source === 'composite') {
    // 유일성은 항목 하나로 답할 수 없다. 자리를 나눠 갖는 장부를 부른 쪽이 들고 온다.
    if (!(settings.claimed instanceof Map)) return { ok: false, reason: '유일성은 프로젝트 전체를 보아야 답할 수 있습니다. claimed가 필요합니다.' };
    return { ok: true, value: item };
  }
  const container = item[SOURCE_CONTAINER[rule.source]];
  if (rule.source === 'link') return { ok: true, elements: linkedIds(item, rule.linkType) };
  if (rule.source === 'link-field') {
    const related = settings.related || {};
    const values = [];
    for (const id of linkedIds(item, rule.linkType)) {
      if (!isPlainObject(related[id])) return { ok: false, reason: `링크된 항목의 값이 실려 있지 않습니다: ${id}` };
      values.push(related[id][rule.field]);
    }
    return { ok: true, elements: values };
  }
  const elements = elementsOf(container);
  // 원소의 필드를 묻는 조건은 원소가 값일 때 답할 수 없다. 선행과 묶음 항목은 식별자로
  // 적히므로 그 항목이 실려 있어야 한다.
  if (!rule.element || rule.element.field === undefined) return { ok: true, elements };
  const related = settings.related || {};
  const resolved = [];
  for (const entry of elements) {
    if (isPlainObject(entry)) { resolved.push(entry); continue; }
    const found = related[String(entry)];
    if (!isPlainObject(found)) return { ok: false, reason: `원소로 가리킨 항목의 값이 실려 있지 않습니다: ${String(entry)}` };
    resolved.push(found);
  }
  return { ok: true, elements: resolved };
}

/** 판정이 무엇을 봤는지 사람에게 말하는 경로. 진단의 대상이 어느 소스였는지를 나른다. */
function sourcePath(rule, target) {
  if (rule.source === 'field') return `${target}.${rule.field}`;
  if (rule.source === 'link') return `${target}.links[${rule.linkType}]`;
  if (rule.source === 'link-field') return `${target}.links[${rule.linkType}].${rule.field}`;
  if (rule.source === 'composite') {
    return `${target}.${rule.fields.concat(rule.links.map((type) => `links[${type}]`)).join('+')}`;
  }
  return `${target}.${SOURCE_CONTAINER[rule.source]}`;
}

// ── 판정 ────────────────────────────────────────────────────────────────

function boundText(rule, unit) {
  if (rule.min !== undefined && rule.max !== undefined) {
    return rule.min === rule.max ? `정확히 ${rule.min}${unit}` : `${rule.min}~${rule.max}${unit}`;
  }
  return rule.min === undefined ? `최대 ${rule.max}${unit}` : `최소 ${rule.min}${unit}`;
}

/**
 * 원소 조건을 사람이 읽는 말로. 대괄호로 묶는 것은 조건이 필드 이름과 값으로 이루어져
 * 있어 문장에 그냥 풀면 어디까지가 조건인지 흐려지기 때문이다.
 */
function elementText(element) {
  if (!element) return '값이 채워짐';
  if (element.values === undefined) return `${element.field} 채워짐`;
  const values = element.values.length === 1 ? String(element.values[0]) : `${element.values.join(', ')} 중 하나`;
  return element.field === undefined ? values : `${element.field} = ${values}`;
}

function satisfies(entry, element) {
  const value = !element || element.field === undefined ? entry : (isPlainObject(entry) ? entry[element.field] : undefined);
  if (!element || element.values === undefined) return hasValue(value);
  return element.values.includes(value);
}

/**
 * 유일성 조합의 열쇠. 조합을 이루는 값 중 하나라도 비어 있으면 열쇠를 만들지 않는다.
 *
 * 빈 값을 열쇠에 넣으면 값이 없는 항목들끼리 서로 충돌하고, 그 진단은 "조합이 겹친다"고
 * 말하지만 실제 결함은 값이 없다는 것이다. 없는 것은 present가 이미 말한다.
 */
function uniqueKey(rule, item) {
  const parts = [];
  for (const name of rule.fields) {
    if (!hasValue(item[name])) return null;
    parts.push(`${name}=${String(item[name])}`);
  }
  for (const type of rule.links) {
    const documents = linkedIds(item, type).sort();
    if (documents.length === 0) return null;
    parts.push(`${type}=${documents.join('+')}`);
  }
  return parts.join('|');
}

function judgeUnique(rule, item, settings, path) {
  // 놓아주는 값의 항목은 집계에서 빠진다. 자리를 차지하지도 남의 자리를 침범하지도
  // 않으므로 같은 조합을 다시 쓸 수 있다.
  if (rule.releasedBy && rule.releasedBy.values.includes(item[rule.releasedBy.field])) return null;
  const key = uniqueKey(rule, item);
  if (key === null) return null;
  const slot = `${settings.owner}/${rule.name}/${key}`;
  const holder = settings.claimed.get(slot);
  if (holder === undefined) {
    settings.claimed.set(slot, settings.target);
    return null;
  }
  // 같은 항목을 두 번 판정한 것은 겹친 것이 아니다. 판정이 몇 번 불리는지는 표면이
  // 정하는 것이고, 부를 때마다 답이 달라지면 그 답은 항목의 성질이 아니게 된다.
  if (holder === settings.target) return null;
  return `${path} 조합이 겹칩니다: ${key} (${holder}에 이미 있음)`;
}

/**
 * 규칙 하나의 답. 막지 않으면 null이고 막으면 사람이 읽는 말이다.
 *
 * 스칼라를 보는 방법 중 present만 빈 값을 막는다. equals · type · range는 값이 있을 때만
 * 견준다 — 없는 것을 방법마다 말하면 한 결함에 진단이 셋 서고, 그 셋을 받은 사람은
 * 무엇이 하나의 문제인지 알 수 없다. 없다는 말은 present 하나가 한다.
 */
function judge(rule, resolved, settings, path) {
  if (rule.source === 'composite') return judgeUnique(rule, resolved.value, settings, path);
  if (rule.nature === 'scalar') {
    const value = resolved.value;
    if (rule.method === 'present') return hasValue(value) ? null : `${path}에 값이 필요합니다.`;
    if (!hasValue(value)) return null;
    if (rule.method === 'equals') {
      return rule.values.includes(value) ? null : `${path}이(가) 허용값 밖입니다: ${String(value)} (${rule.values.join(', ')})`;
    }
    if (rule.method === 'type') {
      return TYPE_CHECKS[rule.type](value) ? null : `${path}은(는) ${TYPE_TEXTS[rule.type]}: ${String(value)}`;
    }
    if (typeof value !== 'number') return `${path}은(는) 수여야 범위를 볼 수 있습니다: ${String(value)}`;
    if (rule.min !== undefined && value < rule.min) return `${path}은(는) ${rule.min} 이상이어야 합니다: ${String(value)}`;
    if (rule.max !== undefined && value > rule.max) return `${path}은(는) ${rule.max} 이하여야 합니다: ${String(value)}`;
    return null;
  }
  const elements = resolved.elements;
  if (rule.method === 'count') {
    const count = elements.length;
    if (rule.min !== undefined && count < rule.min) return `${path}은(는) ${boundText(rule, '건')}이어야 합니다: 현재 ${count}건`;
    if (rule.max !== undefined && count > rule.max) return `${path}은(는) ${boundText(rule, '건')}이어야 합니다: 현재 ${count}건`;
    return null;
  }
  if (rule.method === 'every') {
    // 빈 목록은 참이다. 없어서 통과한 것과 다 만족해서 통과한 것을 가르는 것은 개수의
    // 물음이고, 두 물음을 한 방법에 접으면 어느 쪽으로 걸렸는지 말할 수 없다.
    const failed = elements.filter((entry) => !satisfies(entry, rule.element)).length;
    if (failed === 0) return null;
    return `${path}의 원소가 모두 [${elementText(rule.element)}]여야 합니다: ${elements.length}건 중 ${failed}건이 어긋납니다`;
  }
  const met = elements.some((entry) => satisfies(entry, rule.element));
  return met ? null : `${path}에 [${elementText(rule.element)}] 원소가 하나 이상 있어야 합니다: ${elements.length}건 중 없습니다`;
}

// ── 규칙 이름 ───────────────────────────────────────────────────────────

/**
 * 데이터로 정의된 규칙의 식별자. 규칙이 걸린 자리와 그 자리에서의 이름이다.
 *
 * item-type.js의 constraintRuleId가 `유형.제약종류`로 쓰는 표기를 그대로 따른다. 카탈로그가
 * 하나이므로 이름공간도 하나여야 하고, 갈리면 발화 이력이 같은 규칙을 두 이름으로 센다.
 * 그래서 이름공간이 겹친다는 사실도 함께 남는다 — 유형 test에 unique라는 이름의 검증
 * 규칙을 걸면 그 식별자는 제약 규칙 test.unique와 같아진다. 여기서 막지 않는 이유는
 * 막으려면 이 파일이 제약 종류 목록을 두 번째로 선언해야 하기 때문이고, 겹치지 않게
 * 하는 것은 규칙을 받는 자리(배선)의 몫이다.
 */
function validationRuleId(owner, name) {
  return `${owner}.${name}`;
}

// ── 판정 진입 ───────────────────────────────────────────────────────────

/**
 * 규칙이 형태 판정을 지났는지 본다. 사전조건 위반이므로 방어적 검사다.
 *
 * 지나지 않은 규칙을 그대로 판정하면 진단이 아니라 예외가 엉뚱한 자리에서 터지고,
 * 그때 메시지는 정의가 틀렸다는 말 대신 속성이 없다는 말을 한다.
 */
function assertNormalized(rules) {
  if (!isPlainObject(rules)) throw new Error('검증 규칙이 형태 판정을 지나지 않았습니다: 맵이 아닙니다.');
  for (const [name, rule] of Object.entries(rules)) {
    if (!isPlainObject(rule) || rule.name !== name || !VALIDATION_METHODS.includes(rule.method) || !VALIDATION_SOURCE_KINDS.includes(rule.source)) {
      throw new Error(`검증 규칙이 형태 판정을 지나지 않았습니다: ${name}. normalizeValidations를 먼저 부르세요.`);
    }
  }
}

/**
 * 항목 하나를 규칙들로 판정한다.
 *
 * 막는 규칙을 전부 돌려준다. 처음 걸린 것에서 멈추면 이 설계가 고치려는 왕복이 그대로
 * 남는다 — 태스크 열두 건을 완료로 옮길 때 한 규칙이 막고 그것을 면제하자 다음 규칙이
 * 다시 막았고, 두 규칙이 같은 사실에서 나오는데 한 화면에 보이지 않아 두 번 돌았다.
 *
 * 세 갈래로 답한다. evaluated는 실제로 본 규칙이고 blocked는 그중 막은 것이며,
 * unresolved는 값이 실려 오지 않아 보지 못한 것이다. 못 본 것을 본 것으로 세면 발화
 * 이력이 "한 번도 안 막은 규칙"과 "한 번도 안 불린 규칙"을 가르지 못하고, 통과로 세면
 * 배선이 값을 안 실어 준 저장소에서 규칙이 조용히 죽는다.
 *
 * 레코드는 만들지 않는다. 만들면 판정이 시각과 클라이언트를 알아야 하고, 그 순간 파일도
 * 시계도 안 읽는다는 계약이 깨진다. 부른 표면이 이 답을 받아 적는다.
 */
function evaluateValidations(rules, item, options) {
  assertNormalized(rules);
  const settings = options || {};
  if (!isPlainObject(item)) throw new Error('판정할 항목이 값으로 들어오지 않았습니다.');
  if (!RULE_ORIGINS.includes(settings.origin)) {
    throw new Error(`규칙이 걸린 자리를 알 수 없습니다: ${String(settings.origin)} (${RULE_ORIGINS.join(', ')})`);
  }
  if (!hasValue(settings.owner) || !hasValue(settings.target)) {
    throw new Error('판정에는 규칙이 걸린 자리(owner)와 판정 대상(target)이 필요합니다.');
  }
  const evaluated = [];
  const blocked = [];
  const unresolved = [];
  // 이름 순서로 돈다. 전부 돌려주는 판정이라 순서가 답을 바꾸지는 않지만, 순서가
  // 흔들리면 같은 판정의 발화 레코드가 매번 다른 것으로 접혀 원장이 활동량만큼 자란다.
  for (const name of Object.keys(rules).sort()) {
    const rule = rules[name];
    const ruleId = validationRuleId(settings.owner, name);
    const resolved = resolveSource(rule, item, settings);
    if (!resolved.ok) {
      unresolved.push({ ruleId, source: rule.source, method: rule.method, reason: resolved.reason });
      continue;
    }
    evaluated.push(ruleId);
    const path = sourcePath(rule, settings.target);
    const message = judge(rule, resolved, settings, path);
    if (message === null) continue;
    blocked.push({
      ruleId,
      code: VALIDATION_DIAGNOSTICS[rule.method],
      origin: settings.origin,
      source: rule.source,
      method: rule.method,
      target: path,
      message
    });
  }
  return { evaluated, blocked, unresolved };
}

module.exports = {
  VALIDATION_SOURCE_KINDS,
  VALIDATION_METHODS,
  VALIDATION_DIAGNOSTICS,
  METHOD_BY_DIAGNOSTIC,
  validationRuleId,
  normalizeValidations,
  evaluateValidations
};
