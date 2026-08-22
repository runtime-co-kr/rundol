'use strict';

// 업무 유형 정의의 정규화와 제약 판정. 값 목록의 정본(vocabulary) 말고는 require를
// 갖지 않는다 — 값만 보고 답한다. 정본은 스스로 require가 없으므로 그 성질을 깨지 않는다.
//
// 순수해야 하는 이유는 코드 취향이 아니라 답의 일치다. 유형 규칙을 명령줄과 보드와
// 검사기가 각자 읽으면 같은 태스크가 어디서 보느냐에 따라 다른 판정을 받고, 그때
// 사람 워커와 에이전트 워커는 같은 계층이 아니게 된다.
//
// 유형 하나를 늘리는 비용은 이미 측정되어 있다. 검증 유형이 들어올 때 열거값 하나,
// 필드 셋, 검사 분기 일곱, 명령 하나, 목록 필터가 함께 들어왔다. 다음 유형에서 같은
// 일이 되풀이되지 않으려면 유형이 늘 때 늘어나는 것이 정의 한 줄뿐이어야 한다.
//
// 그래서 진단 코드까지 데이터로 만들지는 않는다. 코드 목록이 설정에 따라 달라지면
// 어제 본 코드가 오늘 없을 수 있고, 그런 목록은 문서도 도구도 참조할 수 없다. 코드는
// 제약 종류에 붙고, 어느 유형이 위반했는지는 진단의 대상이 나른다.

/**
 * 제약 카탈로그. 이 다섯이 전부이며 파일이 여기에 이름을 더할 수 없다.
 *
 * 카탈로그 밖의 종류를 무시하지 않고 거부하는 이유는, 무시하면 오타로 적은 제약이
 * 조용히 적용되지 않고 그 사실이 규칙이 필요해진 시점에야 드러나기 때문이다.
 */
const { CONSTRAINT_KINDS, DISPLAY_FIELDS, EXEMPTABLE_GATES, FIELD_TYPES } = require('./vocabulary');
const ENTRY_KEYS = Object.freeze(DISPLAY_FIELDS.concat(['constraints']));

/**
 * 유형 식별자는 저장값이다. 라틴 소문자와 숫자와 붙임표만 쓴다 — 표기를 바꾸는 것만으로
 * 이미 저장된 태스크의 유형이 갈리면 안 되고, 표시 문구는 label이 갖는다.
 */
const ITEM_TYPE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * 면제할 수 있는 게이트의 전부. 금지 목록이 아니라 허용 목록인 이유는, 금지 목록으로
 * 두면 새 게이트가 생길 때마다 금지에 넣는 것을 잊는 경로가 남고 잊으면 그 게이트가
 * 면제 가능해지기 때문이다.
 *
 * 여기 있는 둘은 각각 실제로 막힌 자리에서 나왔다. 구현 준비도 게이트는 검증 실행
 * 태스크가 구현하지 않고 시나리오를 밟을 뿐인데도 요구 문서를 끌고 다니게 만들었고,
 * 완료 시 검증 문서 연결은 결정 문서만 저작한 태스크가 수용조건을 모두 채우고도
 * 완료되지 못하게 만들었다. 규칙을 지우지 않고 유형으로 푸는 자리가 그 둘이다.
 *
 * 경계 층 게이트는 여기 없다. 유형 정의로 사람 승인이나 위임 불가 티어를 열 수 있으면
 * 유형을 하나 더 만드는 것이 경계 우회 수단이 된다.
 */

/**
 * 진단 코드는 제약 종류마다 하나다. 유형이 열 개여도 코드는 다섯이다.
 *
 * exempt에 코드가 붙어 있지만 이 모듈은 그것을 내지 않는다. 면제는 판정하고 결과를
 * 감추는 것이 아니라 판정 자체를 돌지 않는 것이므로 낼 진단이 없다. 그래도 자리를
 * 비워 두지 않는 이유는, 비워 두면 다음 사람이 이 번호를 다른 뜻으로 쓰고 그때부터
 * 코드와 제약 종류의 일대일이 깨지기 때문이다.
 */
const ITEM_DIAGNOSTICS = Object.freeze({
  fields: 'RDL-ITEM-001',
  requiresLink: 'RDL-ITEM-002',
  requiredWhen: 'RDL-ITEM-003',
  unique: 'RDL-ITEM-004',
  exempt: 'RDL-ITEM-005'
});

/**
 * 유형 자체를 쓸 수 없는 태스크. 정의에 없는 유형이거나 사용 안 함으로 표시된 유형이다.
 *
 * 제약 코드 다섯과 따로 두는 이유는 이것이 제약 위반이 아니기 때문이다. 유형이 몇 개든
 * 이 코드도 하나이므로 "유형이 늘어도 코드가 늘지 않는다"는 성질은 그대로다.
 */
const UNUSABLE_ITEM_TYPE = 'RDL-ITEM-006';

const FIELD_SPEC_KEYS = Object.freeze(['values', 'type', 'min', 'max', 'required']);
// 태스크 필드 이름. 저장된 태스크가 쓰는 표기를 그대로 가리킨다.
const FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/u;
// 문서 유형은 문서 식별자의 앞자리다. 유형 식별자와 달리 대문자인 것은 이미 저장된
// 문서들이 그렇게 적혀 있기 때문이며, 여기서 표기를 바꾸면 링크가 전부 어긋난다.
const DOCUMENT_TYPE_PATTERN = /^[A-Z][A-Z0-9]*$/u;
const CONSTRAINT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const LINK_ANCHOR = /#.*$/u;

// 조건식으로 읽히는 것들. 파라미터가 이것을 받는 순간 이 설계는 규칙 언어가 되고,
// 규칙을 읽으려면 규칙 언어를 먼저 읽어야 한다.
const OPERATOR_KEY_PATTERN = /^\$/u;
const OPERATOR_TEXT_PATTERN = /[<>=!~]/u;

/**
 * 내장 유형 정의. 내장이라고 모양이 다르면 이관이 끝난 뒤에도 판정 경로가 둘 남고,
 * 둘은 반드시 어긋난다. 그래서 여기 있는 것도 파일 정의와 같은 정규화를 지난다.
 *
 * 검증 유형의 규칙 일곱이 이 다섯으로 남김없이 표현되는지가 카탈로그를 다섯으로 둔
 * 근거다. 표현되지 않고 남는 규칙이 있으면 그 규칙은 영원히 코드에 남는다.
 *
 * 허용 판정값과 반려 상태 이름을 여기 다시 적는 것은 src/tasks.js가 파일에 닿기
 * 때문이다. 값만 보고 답해야 하는 모듈이 저장 계층을 끌어오면 그 순간 순수성이
 * 깨지므로, 두 목록이 어긋나지 않는지는 시험이 대조한다.
 */
const BUILTIN_ITEM_TYPES = Object.freeze({
  normal: {
    label: '일반',
    description: '문서를 저작하거나 코드를 고치는 보통의 일',
    order: 10
  },
  test: {
    label: '검증',
    description: '검증 문서 하나를 정해진 차수에 밟는 일',
    order: 20,
    constraints: {
      // 판정은 네 값 중 하나이고, 차수는 1 이상의 정수다. 진행 상태와 판정은 다른
      // 축이므로 여기서 섞지 않는다 — 실패한 검증도 수행은 끝났다.
      fields: {
        result: { values: ['pass', 'fail', 'blocked', 'skipped'] },
        round: { type: 'integer', min: 1, required: true }
      },
      // 차수 하나에 검증 문서 하나가 태스크 하나다. 여럿을 묶으면 판정이 하나뿐이라
      // 어느 것이 실패했는지 알 수 없고, 없으면 무엇을 검증했는지 알 수 없다.
      requiresLink: { TST: { min: 1, max: 1 } },
      // 반려는 수행하지 않기로 한 것이므로 판정을 요구하지 않는다. 완료만 요구한다.
      requiredWhen: { result: { field: 'status', is: ['done'] } },
      // 재실행은 새 태스크가 아니라 같은 태스크의 판정이 바뀌는 일이다. 반려한 것이
      // 자리를 붙잡으면 잘못 만든 것을 되돌릴 방법이 차수를 올리는 것뿐이게 된다.
      unique: { 'round-slot': { fields: ['round'], links: ['TST'], releasedBy: ['cancelled'] } },
      // 검증 실행은 구현하지 않는다. 걸어두면 실행 기록마다 요구 문서를 끌고 다닌다.
      exempt: ['implementation-readiness']
    }
  }
});

/** 거부는 파일 경로와 키 경로와 이유를 함께 문다. 이름만 알리면 오타로 여기고 철자를 고친다. */
function reject(context, at, reason) {
  return new Error(`${context.file}: ${at}: ${reason}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 파라미터 안에 조건식이 있는지 훑는다. 구조 검사보다 먼저 도는 이유는, 나중에 돌면
 * `$ne` 같은 것이 "알 수 없는 키"라는 엉뚱한 이름으로 거부되고 그 메시지를 받은
 * 사람은 철자를 고치려 들기 때문이다.
 */
function assertNoExpressions(value, context, at) {
  if (typeof value === 'string' && (OPERATOR_KEY_PATTERN.test(value) || OPERATOR_TEXT_PATTERN.test(value))) {
    throw reject(context, at, `파라미터는 값과 이름만 받습니다. 조건식으로 읽히는 값입니다: ${value}`);
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoExpressions(item, context, `${at}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (OPERATOR_KEY_PATTERN.test(key)) {
      throw reject(context, `${at}.${key}`, `파라미터는 값과 이름만 받습니다. 조건 연산자를 쓸 수 없습니다: ${key}`);
    }
    assertNoExpressions(child, context, `${at}.${key}`);
  }
}

function assertScalar(value, context, at) {
  const type = typeof value;
  if (type !== 'string' && type !== 'number' && type !== 'boolean') {
    throw reject(context, at, '파라미터는 값과 이름만 받습니다. 여기에는 값 하나가 와야 합니다.');
  }
  if (type === 'number' && !Number.isFinite(value)) throw reject(context, at, '유한한 수여야 합니다.');
  return value;
}

function assertNameList(value, context, at, pattern, label) {
  if (!Array.isArray(value) || value.length === 0) throw reject(context, at, `${label}는 비어 있지 않은 이름 배열이어야 합니다.`);
  return value.map((name, index) => {
    if (typeof name !== 'string' || !pattern.test(name)) {
      throw reject(context, `${at}[${index}]`, `${label} 형식이 아닙니다: ${String(name)}`);
    }
    return name;
  });
}

function assertAllowedKeys(value, allowed, context, at, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw reject(context, `${at}.${key}`, `알 수 없는 키입니다: ${key} (${label}: ${allowed.join(', ')})`);
  }
}

/**
 * `fields`는 그 유형이 갖는 추가 필드와 허용값을 정한다.
 *
 * 허용값 나열과 정수 범위 둘 다 받는 이유는 검증 유형의 규칙 둘이 각각 그 모양이기
 * 때문이다 — 판정은 네 값 중 하나이고 차수는 1 이상의 정수다. 둘 중 하나만 두면
 * 나머지 규칙이 코드에 남는다.
 */
function normalizeFields(value, context, at) {
  if (!isPlainObject(value)) throw reject(context, at, 'fields는 필드 이름을 키로 갖는 객체여야 합니다.');
  const fields = {};
  for (const name of Object.keys(value).sort()) {
    const spec = value[name];
    const where = `${at}.${name}`;
    if (!FIELD_NAME_PATTERN.test(name)) throw reject(context, where, `필드 이름 형식이 아닙니다: ${name}`);
    if (!isPlainObject(spec)) throw reject(context, where, '필드 정의는 객체여야 합니다.');
    assertAllowedKeys(spec, FIELD_SPEC_KEYS, context, where, '필드 정의가 받는 키');
    const normalized = {};
    if (spec.values !== undefined) {
      if (!Array.isArray(spec.values) || spec.values.length === 0) throw reject(context, `${where}.values`, 'values는 비어 있지 않은 배열이어야 합니다.');
      normalized.values = spec.values.map((item, index) => assertScalar(item, context, `${where}.values[${index}]`));
    }
    if (spec.type !== undefined) {
      if (!FIELD_TYPES.includes(spec.type)) throw reject(context, `${where}.type`, `지원하지 않는 필드 형식입니다: ${String(spec.type)} (${FIELD_TYPES.join(', ')})`);
      normalized.type = spec.type;
    }
    for (const bound of ['min', 'max']) {
      if (spec[bound] === undefined) continue;
      if (!Number.isInteger(spec[bound])) throw reject(context, `${where}.${bound}`, `${bound}는 정수여야 합니다.`);
      normalized[bound] = spec[bound];
    }
    if (normalized.min !== undefined && normalized.max !== undefined && normalized.min > normalized.max) {
      throw reject(context, where, 'min이 max보다 큽니다.');
    }
    if (spec.required !== undefined) {
      if (spec.required !== true) throw reject(context, `${where}.required`, 'required는 true만 쓸 수 있습니다. 요구하지 않으려면 그 줄을 지우세요.');
      normalized.required = true;
    }
    if (Object.keys(normalized).length === 0) throw reject(context, where, '필드 정의가 비어 있습니다. 아무것도 정하지 않는 선언은 규칙이 아닙니다.');
    fields[name] = normalized;
  }
  return fields;
}

/** `requiresLink`는 대상 문서 유형을 최소 몇 개, 최대 몇 개 연결해야 하는지 정한다. */
function normalizeRequiresLink(value, context, at) {
  if (!isPlainObject(value)) throw reject(context, at, 'requiresLink는 문서 유형을 키로 갖는 객체여야 합니다.');
  const links = {};
  for (const type of Object.keys(value).sort()) {
    const spec = value[type];
    const where = `${at}.${type}`;
    if (!DOCUMENT_TYPE_PATTERN.test(type)) throw reject(context, where, `문서 유형 형식이 아닙니다: ${type}`);
    if (!isPlainObject(spec)) throw reject(context, where, '연결 제약은 객체여야 합니다.');
    assertAllowedKeys(spec, ['min', 'max'], context, where, '연결 제약이 받는 키');
    if (!Number.isInteger(spec.min) || spec.min < 0) throw reject(context, `${where}.min`, 'min은 0 이상의 정수여야 합니다.');
    // max를 적지 않으면 위가 열린다. 열린 쪽을 큰 수로 적게 하면 그 수가 무슨 뜻인지를
    // 다시 설명해야 하고, 설명이 필요한 값은 값이 아니라 관례가 된다.
    if (spec.max !== undefined && (!Number.isInteger(spec.max) || spec.max < spec.min)) {
      throw reject(context, `${where}.max`, 'max는 min 이상의 정수여야 합니다.');
    }
    links[type] = spec.max === undefined ? { min: spec.min } : { min: spec.min, max: spec.max };
  }
  return links;
}

/**
 * `requiredWhen`은 조건 필드가 특정 값일 때 요구 필드가 채워져야 함을 정한다.
 *
 * 조건은 값의 나열이지 식이 아니다. "완료면 판정이 필요"는 `status`가 `done`이라는
 * 값 하나로 적히고, 그 자리에 비교 연산자를 받으면 규칙 언어가 열린다.
 */
function normalizeRequiredWhen(value, context, at) {
  if (!isPlainObject(value)) throw reject(context, at, 'requiredWhen은 요구 필드를 키로 갖는 객체여야 합니다.');
  const rules = {};
  for (const name of Object.keys(value).sort()) {
    const spec = value[name];
    const where = `${at}.${name}`;
    if (!FIELD_NAME_PATTERN.test(name)) throw reject(context, where, `필드 이름 형식이 아닙니다: ${name}`);
    if (!isPlainObject(spec)) throw reject(context, where, '조건부 제약은 객체여야 합니다.');
    assertAllowedKeys(spec, ['field', 'is'], context, where, '조건부 제약이 받는 키');
    if (typeof spec.field !== 'string' || !FIELD_NAME_PATTERN.test(spec.field)) {
      throw reject(context, `${where}.field`, `조건 필드 이름 형식이 아닙니다: ${String(spec.field)}`);
    }
    if (!Array.isArray(spec.is) || spec.is.length === 0) throw reject(context, `${where}.is`, 'is는 비어 있지 않은 값 배열이어야 합니다.');
    rules[name] = { field: spec.field, is: spec.is.map((item, index) => assertScalar(item, context, `${where}.is[${index}]`)) };
  }
  return rules;
}

/**
 * `unique`는 필드 조합이 프로젝트 안에서 유일해야 함을 정한다.
 *
 * 조합에 연결 문서를 넣을 수 있어야 한다. 검증 유형의 유일성은 "같은 검증 문서의 같은
 * 차수는 하나"이고, 그 왼쪽 절반은 필드가 아니라 링크에 있다. 경로식 대신 문서 유형
 * 이름을 따로 받는 이유는 경로식이 곧 규칙 언어이기 때문이다.
 *
 * `releasedBy`는 유일성을 놓아주는 상태 값의 나열이다. "취소가 아닌 것들 사이에서만
 * 유일"이 아니라 "이 상태들은 집계에서 뺀다"로 적는다 — 같은 것을 뜻하지만 뒤엣것만
 * 조건식 없이 표현된다.
 */
function normalizeUnique(value, context, at) {
  if (!isPlainObject(value)) throw reject(context, at, 'unique는 제약 이름을 키로 갖는 객체여야 합니다.');
  const rules = {};
  for (const name of Object.keys(value).sort()) {
    const spec = value[name];
    const where = `${at}.${name}`;
    if (!CONSTRAINT_NAME_PATTERN.test(name)) throw reject(context, where, `제약 이름 형식이 아닙니다: ${name}`);
    if (!isPlainObject(spec)) throw reject(context, where, '유일성 제약은 객체여야 합니다.');
    assertAllowedKeys(spec, ['fields', 'links', 'releasedBy'], context, where, '유일성 제약이 받는 키');
    const rule = {};
    if (spec.fields !== undefined) rule.fields = assertNameList(spec.fields, context, `${where}.fields`, FIELD_NAME_PATTERN, '필드 이름');
    if (spec.links !== undefined) rule.links = assertNameList(spec.links, context, `${where}.links`, DOCUMENT_TYPE_PATTERN, '문서 유형');
    if (!rule.fields && !rule.links) throw reject(context, where, '유일성 조합이 비어 있습니다. fields나 links 중 하나는 있어야 합니다.');
    if (spec.releasedBy !== undefined) {
      if (!Array.isArray(spec.releasedBy) || spec.releasedBy.length === 0) throw reject(context, `${where}.releasedBy`, 'releasedBy는 비어 있지 않은 상태 값 배열이어야 합니다.');
      rule.releasedBy = spec.releasedBy.map((item, index) => {
        const status = assertScalar(item, context, `${where}.releasedBy[${index}]`);
        if (typeof status !== 'string') throw reject(context, `${where}.releasedBy[${index}]`, '놓아주는 상태는 상태 값의 이름이어야 합니다.');
        return status;
      });
    }
    rules[name] = rule;
  }
  return rules;
}

/** `exempt`는 게이트 이름의 나열이다. 이름은 코드가 정한 면제 가능 목록 안에 있어야 한다. */
function normalizeExempt(value, context, at) {
  if (!Array.isArray(value)) throw reject(context, at, 'exempt는 게이트 이름 배열이어야 합니다.');
  const gates = [];
  value.forEach((gate, index) => {
    const where = `${at}[${index}]`;
    if (typeof gate !== 'string') throw reject(context, where, '게이트 이름은 문자열이어야 합니다.');
    if (!context.exemptable.includes(gate)) {
      throw reject(context, where, `면제할 수 없는 게이트입니다: ${gate}. 면제는 허용 목록 안에서만 선언되며(${context.exemptable.join(', ')}), 되돌릴 수 없는 관문은 그 목록에 없습니다 — 유형을 더하는 것이 경계를 우회하는 수단이 되면 안 되기 때문입니다.`);
    }
    if (!gates.includes(gate)) gates.push(gate);
  });
  return gates;
}

const CONSTRAINT_NORMALIZERS = {
  fields: normalizeFields,
  requiresLink: normalizeRequiresLink,
  requiredWhen: normalizeRequiredWhen,
  unique: normalizeUnique,
  exempt: normalizeExempt
};

function normalizeConstraints(value, context, at) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw reject(context, at, 'constraints는 객체여야 합니다.');
  for (const kind of Object.keys(value)) {
    if (!CONSTRAINT_KINDS.includes(kind)) {
      throw reject(context, `${at}.${kind}`, `카탈로그에 없는 제약 종류입니다: ${kind} (${CONSTRAINT_KINDS.join(', ')})`);
    }
  }
  assertNoExpressions(value, context, at);
  const constraints = {};
  // 카탈로그 순서로 담는다. 같은 정의면 같은 결과여야 하고, 결과가 객체 키 순서에
  // 기대면 파일에 적은 순서가 진단 순서를 바꾼다.
  for (const kind of CONSTRAINT_KINDS) {
    if (!Object.prototype.hasOwnProperty.call(value, kind)) continue;
    constraints[kind] = CONSTRAINT_NORMALIZERS[kind](value[kind], context, `${at}.${kind}`);
  }
  return constraints;
}

function normalizeEntry(id, entry, context) {
  const at = `${context.path}.${id}`;
  if (!ITEM_TYPE_ID_PATTERN.test(id)) {
    throw reject(context, at, `유형 식별자 형식이 아닙니다: ${id}. 식별자는 저장값이므로 라틴 소문자와 숫자와 붙임표만 쓰고, 표시 문구는 label에 둡니다.`);
  }
  if (!isPlainObject(entry)) throw reject(context, at, '유형 정의는 객체여야 합니다.');
  for (const key of Object.keys(entry)) {
    if (ENTRY_KEYS.includes(key)) continue;
    // 제약을 항목에 곧바로 적은 경우를 따로 짚는다. "알 수 없는 키"로만 알리면 이름이
    // 맞는데 왜 거부되는지 알 수 없어 철자를 고치려 든다.
    if (CONSTRAINT_KINDS.includes(key)) throw reject(context, `${at}.${key}`, `제약은 constraints 아래에 둡니다: ${key}`);
    throw reject(context, `${at}.${key}`, `알 수 없는 키입니다: ${key}. 유형 정의는 표시 필드(${DISPLAY_FIELDS.join(', ')})와 constraints만 담습니다.`);
  }
  for (const field of ['label', 'description']) {
    if (entry[field] === undefined) continue;
    if (typeof entry[field] !== 'string' || !entry[field].trim()) throw reject(context, `${at}.${field}`, `${field}은 비어 있지 않은 문자열이어야 합니다.`);
  }
  if (entry.order !== undefined && !Number.isInteger(entry.order)) throw reject(context, `${at}.order`, 'order는 정수여야 합니다.');
  // 사용 안 함은 값이 아니라 항목의 상태다. 맵 병합에는 삭제가 없으므로 상속받은 유형을
  // 하위가 없애려면 없앤다고 적어야 하고, 없앴다는 판단이 파일에 남아야 나중에 왜
  // 없앴는지 답할 수 있다.
  if (entry.disabled !== undefined && entry.disabled !== true) {
    throw reject(context, `${at}.disabled`, 'disabled는 true만 쓸 수 있습니다. 되살리려면 그 줄을 지우세요.');
  }
  // 적지 않은 표시 필드는 결과에도 없다. 기본값으로 채우면 "적지 않음"과 "기본값을
  // 적음"이 같은 모양이 되고, 그러면 병합에서 하위가 제약 하나만 덮었을 때 상위가 정한
  // 라벨이 기본값에 덮인다.
  const normalized = { id };
  for (const field of DISPLAY_FIELDS) {
    if (entry[field] !== undefined) normalized[field] = entry[field];
  }
  normalized.constraints = normalizeConstraints(entry.constraints, context, `${at}.constraints`);
  return normalized;
}

/**
 * 유형 정의 맵을 정규화한다. 표시 필드와 제약이 나뉘어 담기고, 위반이 있으면 예외다.
 *
 * 파라미터 검사는 형태만 본다. 값이 가리키는 대상이 실재하는지는 판정 시점의 일이다 —
 * 저장 시점에 대조하면 아직 만들지 않은 문서를 가리키는 정의를 저장할 수 없다.
 *
 * 면제 가능 목록은 호출자가 넘길 수 있지만 좁힐 수만 있다. 넓힐 수 있으면 그 목록을
 * 부르는 쪽이 자기 허용 목록을 선언하는 것이 되어, 코드가 목록을 갖는다는 말이 빈다.
 */
function normalizeItemTypes(definitions, options) {
  const settings = options || {};
  if (!isPlainObject(definitions)) throw new Error(`${settings.file || '(내장 정의)'}: 유형 정의는 맵이어야 합니다.`);
  const context = {
    file: settings.file || '(내장 정의)',
    path: settings.path || 'itemTypes',
    exemptable: EXEMPTABLE_GATES.slice()
  };
  if (settings.exemptableGates !== undefined) {
    const supplied = Array.from(settings.exemptableGates);
    for (const gate of supplied) {
      if (!EXEMPTABLE_GATES.includes(gate)) {
        throw reject(context, context.path, `면제 가능 목록에 없는 게이트를 허용하려 했습니다: ${gate}. 목록은 코드가 갖습니다.`);
      }
    }
    context.exemptable = supplied;
  }
  const normalized = {};
  // 식별자 순서로 돈다. 같은 정의면 같은 결과여야 하며, 거부도 같은 자리에서 나야
  // 재현이 된다 — 첫 위반에서 멈추는 판정에서 순서가 흔들리면 무엇이 먼저 걸리는지가
  // 실행마다 달라진다.
  for (const id of Object.keys(definitions).sort()) {
    normalized[id] = normalizeEntry(id, definitions[id], context);
  }
  return normalized;
}

/**
 * 계층별 정규화 결과를 겹친다. 뒤에 오는 계층이 이긴다.
 *
 * 제약은 종류 단위로 덮는다. 항목 단위로만 덮으면 하위가 제약 하나를 적는 순간 상위가
 * 정한 나머지 넷이 사라지고, 그러면 하위는 물려받은 규칙을 전부 다시 적어야 한다.
 * 반대로 파라미터 단위까지 파고들면 "이 유형의 규칙"을 정의 한 곳에서 읽을 수 없게
 * 된다 — 한 제약의 파라미터가 두 계층에 흩어지기 때문이다.
 */
function mergeItemTypes(layers) {
  const merged = {};
  for (const layer of layers || []) {
    for (const [id, entry] of Object.entries(layer || {})) {
      const before = merged[id];
      const constraints = Object.assign({}, before && before.constraints, entry.constraints);
      merged[id] = Object.assign({}, before, entry, { constraints });
    }
  }
  const ordered = {};
  for (const id of Object.keys(merged).sort()) ordered[id] = merged[id];
  return ordered;
}

/**
 * 정의가 형태 판정을 지났는지 본다. 사전조건 위반이므로 방어적 검사다.
 *
 * 지나지 않은 정의를 그대로 판정하면 진단이 아니라 예외가 엉뚱한 자리에서 터지고,
 * 그때 메시지는 정의가 틀렸다는 말 대신 속성이 없다는 말을 한다.
 */
function assertNormalized(definitions) {
  if (!isPlainObject(definitions)) throw new Error('유형 정의가 형태 판정을 지나지 않았습니다: 맵이 아닙니다.');
  for (const [id, entry] of Object.entries(definitions)) {
    if (!isPlainObject(entry) || entry.id !== id || !isPlainObject(entry.constraints)) {
      throw new Error(`유형 정의가 형태 판정을 지나지 않았습니다: ${id}. normalizeItemTypes를 먼저 부르세요.`);
    }
  }
}

function itemDiagnostic(list, values) {
  list.push(Object.assign({ severity: 'error', category: 'item-type', artifactId: null, target: null, field: null }, values));
}

/**
 * 판정 대상을 식별자 순으로 세운다.
 *
 * 다섯 중 유일성만 집합 전체를 훑어야 답이 나오고, 그래서 이 판정만 순서가 결과에
 * 영향을 준다. 입력이 어떤 순서로 오든 같은 쪽이 "먼저"여야 하므로 저장 순서가 아니라
 * 식별자로 세운다 — 저장 순서에 기대면 샤드를 다시 읽는 것만으로 어느 태스크를
 * 고치라는 말이 바뀐다.
 */
function taskEntries(tasks) {
  const list = Array.isArray(tasks)
    ? tasks.map((task) => ({ id: String((task && task.id) || ''), task: task || {} }))
    : Object.entries(tasks || {}).map(([id, task]) => ({ id: String(id), task: task || {} }));
  return list.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

/** 태스크가 연 문서 중 그 유형에 해당하는 것. 앵커는 문서가 아니라 문서 안의 자리다. */
function linkedDocuments(task, type) {
  const pattern = new RegExp(`^${type}-\\d{3,}$`, 'u');
  return (Array.isArray(task.links) ? task.links : [])
    .map((link) => String(link).replace(LINK_ANCHOR, ''))
    .filter((link) => pattern.test(link));
}

/**
 * 어떤 유형이든 한 번은 선언한 필드의 전부.
 *
 * 선언하지 않은 필드에 값이 있다는 것은 유형을 바꾸고 값을 남긴 것이다. 그것을 잡으려면
 * "이 유형이 선언하지 않았다"만으로는 부족하고 "다른 유형이 선언한 것이다"까지 알아야
 * 한다 — 그러지 않으면 제목이나 담당자처럼 유형과 무관한 필드까지 전부 위반이 된다.
 */
function declaredFieldNames(definitions) {
  const names = new Set();
  for (const entry of Object.values(definitions)) {
    for (const name of Object.keys(entry.constraints.fields || {})) names.add(name);
  }
  return names;
}

function checkFields(list, entry, task, taskId, foreignFields) {
  const fields = entry.constraints.fields || {};
  const code = ITEM_DIAGNOSTICS.fields;
  const base = { code, artifactId: taskId, target: entry.id };
  for (const name of Object.keys(fields).sort()) {
    const spec = fields[name];
    const value = task[name];
    if (!hasValue(value)) {
      if (spec.required) itemDiagnostic(list, Object.assign({}, base, { field: name, message: `${entry.id} 유형에는 ${name}이(가) 필요합니다.` }));
      continue;
    }
    if (spec.values && !spec.values.includes(value)) {
      itemDiagnostic(list, Object.assign({}, base, { field: name, message: `${entry.id} 유형의 ${name}이(가) 허용값 밖입니다: ${String(value)} (${spec.values.join(', ')})` }));
      continue;
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      itemDiagnostic(list, Object.assign({}, base, { field: name, message: `${entry.id} 유형의 ${name}은(는) 정수여야 합니다: ${String(value)}` }));
      continue;
    }
    if (spec.type === 'string' && typeof value !== 'string') {
      itemDiagnostic(list, Object.assign({}, base, { field: name, message: `${entry.id} 유형의 ${name}은(는) 문자열이어야 합니다: ${String(value)}` }));
      continue;
    }
    if (spec.min !== undefined && typeof value === 'number' && value < spec.min) {
      itemDiagnostic(list, Object.assign({}, base, { field: name, message: `${entry.id} 유형의 ${name}은(는) ${spec.min} 이상이어야 합니다: ${String(value)}` }));
      continue;
    }
    if (spec.max !== undefined && typeof value === 'number' && value > spec.max) {
      itemDiagnostic(list, Object.assign({}, base, { field: name, message: `${entry.id} 유형의 ${name}은(는) ${spec.max} 이하여야 합니다: ${String(value)}` }));
    }
  }
  for (const name of Array.from(foreignFields).sort()) {
    if (Object.prototype.hasOwnProperty.call(fields, name) || !hasValue(task[name])) continue;
    itemDiagnostic(list, Object.assign({}, base, { field: name, message: `${entry.id} 유형은 ${name}을(를) 선언하지 않는데 값이 있습니다: ${String(task[name])}. 유형을 바꾸고 값을 남긴 것입니다.` }));
  }
}

function checkRequiresLink(list, entry, task, taskId) {
  const links = entry.constraints.requiresLink || {};
  for (const type of Object.keys(links).sort()) {
    const spec = links[type];
    const count = linkedDocuments(task, type).length;
    if (count >= spec.min && (spec.max === undefined || count <= spec.max)) continue;
    const bound = spec.max === undefined ? `최소 ${spec.min}건` : (spec.min === spec.max ? `정확히 ${spec.min}건` : `${spec.min}~${spec.max}건`);
    itemDiagnostic(list, {
      code: ITEM_DIAGNOSTICS.requiresLink, artifactId: taskId, target: entry.id, field: type,
      message: `${entry.id} 유형은 ${type} 문서를 ${bound} 연결해야 합니다: 현재 ${count}건`
    });
  }
}

function checkRequiredWhen(list, entry, task, taskId) {
  const rules = entry.constraints.requiredWhen || {};
  for (const name of Object.keys(rules).sort()) {
    const rule = rules[name];
    // 조건이 맞지 않으면 아무것도 판정하지 않는다. 비어 있는지조차 보지 않는다.
    if (!rule.is.includes(task[rule.field])) continue;
    if (hasValue(task[name])) continue;
    itemDiagnostic(list, {
      code: ITEM_DIAGNOSTICS.requiredWhen, artifactId: taskId, target: entry.id, field: name,
      message: `${entry.id} 유형은 ${rule.field}이(가) ${String(task[rule.field])}일 때 ${name}이(가) 필요합니다.`
    });
  }
}

/**
 * 유일성 조합의 열쇠. 조합을 이루는 값 중 하나라도 비어 있으면 열쇠를 만들지 않는다.
 *
 * 빈 값을 열쇠에 넣으면 값이 없는 태스크들끼리 서로 충돌하고, 그 진단은 "차수가
 * 겹친다"고 말하지만 실제 결함은 차수가 없다는 것이다. 없는 것은 fields가 이미 말한다.
 */
function uniqueKey(rule, task) {
  const parts = [];
  for (const name of rule.fields || []) {
    if (!hasValue(task[name])) return null;
    parts.push(`${name}=${String(task[name])}`);
  }
  for (const type of rule.links || []) {
    const documents = linkedDocuments(task, type).slice().sort();
    if (documents.length === 0) return null;
    parts.push(`${type}=${documents.join('+')}`);
  }
  return parts.join('|');
}

function checkUnique(list, entry, task, taskId, claimed) {
  const rules = entry.constraints.unique || {};
  for (const name of Object.keys(rules).sort()) {
    const rule = rules[name];
    // 놓아주는 상태의 항목은 집계에서 빠진다. 자리를 차지하지도 않고 남의 자리를
    // 침범하지도 않으므로 같은 조합을 다시 쓸 수 있다.
    if ((rule.releasedBy || []).includes(task.status)) continue;
    const key = uniqueKey(rule, task);
    if (key === null) continue;
    const slot = `${entry.id}/${name}/${key}`;
    const owner = claimed.get(slot);
    if (owner === undefined) {
      claimed.set(slot, taskId);
      continue;
    }
    itemDiagnostic(list, {
      code: ITEM_DIAGNOSTICS.unique, artifactId: taskId, target: entry.id, field: name,
      message: `${entry.id} 유형의 ${name} 조합이 겹칩니다: ${key} (${owner}에 이미 있음)`
    });
  }
}

/**
 * 태스크 집합을 유형 정의로 판정해 진단 목록을 낸다.
 *
 * 첫 위반에서 멈추지 않는다. 태스크 여럿이 어긋나 있으면 전부 낸다 — 하나씩 알리면
 * 고치고 다시 돌리는 왕복이 위반 수만큼 생긴다.
 *
 * 게이트는 이 모듈 밖에 있다. 이름으로 부르고 이름으로 면제하는 이유는, 진단 코드로
 * 면제하면 한 게이트가 코드 둘을 내는 순간 절반만 면제되기 때문이다.
 */
function evaluateItemTypes(tasks, definitions, options) {
  assertNormalized(definitions);
  const settings = options || {};
  const gates = settings.gates || {};
  const defaultType = settings.defaultType || 'normal';
  const foreignFields = declaredFieldNames(definitions);
  const diagnostics = [];
  const claimed = new Map();
  for (const { id, task } of taskEntries(tasks)) {
    const typeId = String(task.kind === undefined || task.kind === null ? defaultType : task.kind);
    const entry = definitions[typeId];
    if (!entry) {
      // 모르는 유형의 태스크를 조용히 건너뛰면 그 태스크만 규칙 없이 통과한다. 유형을
      // 데이터로 옮긴 이유가 바로 그 구멍을 없애는 것이었다.
      itemDiagnostic(diagnostics, {
        code: UNUSABLE_ITEM_TYPE, artifactId: id, target: typeId,
        message: `정의에 없는 업무 유형입니다: ${typeId}`
      });
      continue;
    }
    // 사용 안 함으로 표시된 유형은 정의가 남아 있으므로 판정할 수 있다. 정의를 지우지
    // 않고 표식만 두는 이유가 여기서도 쓰인다 — 지웠으면 이 태스크는 모르는 유형이 되어
    // 무엇이 어긋났는지 말할 수 없다.
    if (entry.disabled === true) {
      itemDiagnostic(diagnostics, {
        code: UNUSABLE_ITEM_TYPE, artifactId: id, target: typeId,
        message: `사용 안 함으로 표시된 업무 유형의 태스크입니다: ${typeId}`
      });
    }
    checkFields(diagnostics, entry, task, id, foreignFields);
    checkRequiresLink(diagnostics, entry, task, id);
    checkRequiredWhen(diagnostics, entry, task, id);
    checkUnique(diagnostics, entry, task, id, claimed);
    const exempt = entry.constraints.exempt || [];
    for (const gate of Object.keys(gates).sort()) {
      // 면제는 판정하고 결과를 감추는 것이 아니라 판정 자체를 돌지 않는 것이다. 감추는
      // 방식이면 통계와 목록에는 위반이 남아 두 숫자가 어긋난다.
      if (exempt.includes(gate)) continue;
      for (const issue of gates[gate](task, entry) || []) {
        itemDiagnostic(diagnostics, {
          code: issue.code, severity: issue.severity || 'error', artifactId: id, target: typeId,
          field: issue.target === undefined ? null : issue.target, gate, message: issue.message
        });
      }
    }
  }
  return diagnostics;
}

module.exports = {
  CONSTRAINT_KINDS,
  DISPLAY_FIELDS,
  EXEMPTABLE_GATES,
  ITEM_DIAGNOSTICS,
  UNUSABLE_ITEM_TYPE,
  BUILTIN_ITEM_TYPES,
  normalizeItemTypes,
  mergeItemTypes,
  evaluateItemTypes
};
