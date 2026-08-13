'use strict';

const BOUNDARY_VERSION = 'bounded-v1';
const PLACEHOLDER_PATTERN = /(?:작성\s*필요|미정|todo|tbd|<[^>]+>)/iu;
const VAGUE_SCOPE_PATTERN = /(?:^(?:일반|기타|프로젝트|시스템|서비스|문서)$|(?:^|[\s·,])(?:전체|통합|종합|모든)(?:$|[\s·,])|\b(?:all|overall|general)\b)/iu;
const EMPTY_EXCLUSION_PATTERN = /^(?:없음|해당\s*없음|없다|none|n\/a)$/iu;

const TYPE_GUIDANCE = Object.freeze({
  PRD: '하나의 제품 목표와 성공 기준',
  REQ: '하나의 사용자·업무 능력 또는 독립 검증 가능한 동작',
  ARC: '하나의 시스템 경계 또는 함께 변경되는 구조',
  SCR: '하나의 사용자 목표를 완결하는 화면·상호작용 흐름',
  MOD: '하나의 일관된 데이터 수명주기와 불변식',
  API: '하나의 소비자 목적을 제공하는 인터페이스 집합',
  ADR: '독립적으로 승인·폐기·재검토할 수 있는 단일 결정',
  TST: '하나의 요구사항 묶음 또는 품질 위험에 대한 검증 범위',
  RUN: '하나의 운영 목표를 완결하는 실행·복구 절차',
  GLS: '하나의 업무·기술 문맥에서 공유하는 용어 집합'
});

const SPLIT_SIGNALS = Object.freeze([
  '소유자나 승인자가 다르다',
  '독립된 수용 기준이나 완료 시점이 있다',
  '변경·폐기·재검토 주기가 다르다',
  '주요 소비자나 관련 문서 집합이 다르다'
]);

function clean(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ');
}

function boundaryGuidance(type) {
  const upper = String(type || '').toUpperCase();
  return {
    type: upper,
    primaryResponsibility: TYPE_GUIDANCE[upper] || '하나의 독립 검토 가능한 책임',
    splitWhen: SPLIT_SIGNALS.slice()
  };
}

function validateBoundaryInput(input) {
  const values = input || {};
  const scope = clean(values.scope);
  const rawExcludes = Array.isArray(values.excludes) ? values.excludes : values.excludes ? [values.excludes] : [];
  const excludes = Array.from(new Set(rawExcludes.map(clean).filter(Boolean)));
  const errors = [];
  if (!scope) errors.push('--scope에 이 문서가 책임지는 단일 검토 단위를 작성하세요.');
  else {
    if (scope.length < 8) errors.push('--scope는 책임 경계를 식별할 수 있도록 8자 이상 작성하세요.');
    if (scope.length > 160) errors.push('--scope는 한 가지 책임에 집중해 160자 이내로 작성하세요.');
    if (PLACEHOLDER_PATTERN.test(scope) || VAGUE_SCOPE_PATTERN.test(scope)) errors.push('--scope에 전체·통합 같은 포괄 표현 대신 독립 검토 가능한 책임을 작성하세요.');
  }
  if (excludes.length === 0) errors.push('--exclude에 인접하지만 이 문서가 책임지지 않는 범위를 하나 이상 작성하세요.');
  for (const value of excludes) {
    if (value.length < 2 || PLACEHOLDER_PATTERN.test(value) || EMPTY_EXCLUSION_PATTERN.test(value)) errors.push('--exclude에는 실제 제외 범위를 작성하세요.');
  }
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), boundary: { version: BOUNDARY_VERSION, scope, excludes } };
}

function assertBoundaryInput(type, input) {
  const result = validateBoundaryInput(input);
  if (!result.valid) {
    const guidance = boundaryGuidance(type);
    throw new Error(`${result.errors.join(' ')} ${type}의 권장 책임 단위: ${guidance.primaryResponsibility}.`);
  }
  return Object.assign(result.boundary, { guidance: boundaryGuidance(type) });
}

function validateBoundaryMetadata(meta) {
  const values = meta || {};
  const touched = Object.prototype.hasOwnProperty.call(values, 'granularity');
  if (!touched) return [];
  const issues = [];
  if (values.granularity !== BOUNDARY_VERSION) issues.push({ code: 'RDL-DOC-012', field: 'granularity', message: `granularity는 ${BOUNDARY_VERSION}이어야 합니다.` });
  const result = validateBoundaryInput({ scope: values.scope, excludes: Array.isArray(values.excludes) ? values.excludes : [] });
  for (const message of result.errors) {
    const field = message.startsWith('--exclude') ? 'excludes' : 'scope';
    issues.push({ code: field === 'scope' ? 'RDL-DOC-013' : 'RDL-DOC-014', field, message: message.replace(/^--(?:scope|exclude)\s*/u, '') });
  }
  return issues;
}

module.exports = { BOUNDARY_VERSION, TYPE_GUIDANCE, SPLIT_SIGNALS, boundaryGuidance, validateBoundaryInput, assertBoundaryInput, validateBoundaryMetadata };
