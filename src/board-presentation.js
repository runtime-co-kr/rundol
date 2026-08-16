'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { REGULAR_TYPES, DEFAULT_POLICIES } = require('./document-profile');

const DOCUMENT_TYPE_KEYS = ['charter', 'prd', 'requirement', 'architecture', 'screen', 'model', 'api', 'decision', 'test', 'runbook', 'glossary', 'clipping'];
const DOCUMENT_STATE_KEYS = ['draft', 'proposed', 'active', 'review', 'approved', 'deprecated', 'archived', 'unread'];
// 계약이 저장하는 값은 ASCII 식별자이고 화면에 보이는 말은 그 값의 라벨이다. 둘을 섞으면
// 표기를 바꾸는 순간 저장된 계약이 깨진다. 여기 키는 언제나 저장값이고 label만 바뀐다.
const POLICY_STATE_KEYS = ['required', 'recommended', 'onDemand', 'disabled'];
const ENFORCEMENT_KEYS = ['advisory', 'checkpoint'];
const TASK_STATUS_KEYS = ['todo', 'doing', 'waiting', 'review', 'done', 'cancelled'];
const PRIORITY_KEYS = ['high', 'mid', 'low'];
const PROFILE_KEYS = ['lean', 'product', 'service', 'platform', 'assured'];
const ENTRY_FIELDS = ['label', 'description', 'order'];
const PRESENTATION_GROUPS = {
  documentTypes: DOCUMENT_TYPE_KEYS,
  documentStates: DOCUMENT_STATE_KEYS,
  policyStates: POLICY_STATE_KEYS,
  enforcementLevels: ENFORCEMENT_KEYS,
  taskStatuses: TASK_STATUS_KEYS,
  priorities: PRIORITY_KEYS,
  profiles: PROFILE_KEYS
};
const DEFAULT_PRESENTATION = {
  schemaVersion: 1,
  documentTypes: {
    charter: { label: '프로젝트 헌장', description: '프로젝트의 목표, 범위와 거버넌스', order: 0 },
    prd: { label: '제품 요구사항', description: '제품 목표, 사용자 가치와 범위', order: 10 },
    requirement: { label: '요구사항', description: '검증 가능한 기능과 품질 요구', order: 20 },
    architecture: { label: '아키텍처', description: '시스템 경계와 구조 결정', order: 30 },
    screen: { label: '화면 설계', description: '사용자 흐름, 화면 상태와 접근성', order: 40 },
    model: { label: '데이터 모델', description: '데이터 구조, 관계와 불변식', order: 50 },
    api: { label: '인터페이스', description: '요청, 응답, 오류와 호환성 계약', order: 60 },
    decision: { label: '의사결정 기록', description: '중요 결정과 대안, 근거와 결과', order: 70 },
    test: { label: '검증', description: '테스트 전략, 시나리오와 통과 기준', order: 80 },
    runbook: { label: '운영 가이드', description: '배포, 관측, 장애 대응과 복구', order: 90 },
    glossary: { label: '용어집', description: '프로젝트 공통 용어와 정의', order: 100 },
    clipping: { label: '수집 노트', description: '정규화 전 임시 참고 자료', order: 110 }
  },
  documentStates: {
    draft: { label: '초안', description: '작성 중이며 계약 검증이 끝나지 않음', order: 0 },
    proposed: { label: '제안', description: '검토를 위해 제안됨', order: 10 },
    review: { label: '검토 중', description: '책임자의 검토가 진행 중', order: 20 },
    approved: { label: '승인됨', description: '승인되어 적용 가능함', order: 30 },
    active: { label: '활성', description: '현재 유효한 정본', order: 40 },
    deprecated: { label: '폐기 예정', description: '대체 문서로 전환 중', order: 50 },
    archived: { label: '보관됨', description: '현재 사용하지 않는 기록', order: 60 },
    unread: { label: '미확인', description: '아직 검토되지 않은 수집 자료', order: 70 }
  },
  policyStates: {
    required: { label: '필수', description: '이 유형의 문서가 반드시 있어야 한다', order: 0 },
    recommended: { label: '권장', description: '없어도 막지 않지만 있는 편이 좋다', order: 10 },
    onDemand: { label: '필요할 때', description: '해당하는 상황에만 만든다', order: 20 },
    disabled: { label: '사용 안 함', description: '만들지 않고 내용을 다른 문서에 흡수한다', order: 30 }
  },
  enforcementLevels: {
    advisory: { label: '권고', description: '위반을 알리되 저장과 동기화를 막지 않는다', order: 0 },
    checkpoint: { label: '차단', description: '위반이 있으면 저장과 동기화를 막는다', order: 10 }
  },
  taskStatuses: {
    todo: { label: '할 일', description: '아직 시작하지 않음', order: 0 },
    doing: { label: '진행 중', description: '작업이 진행 중', order: 10 },
    waiting: { label: '대기', description: '사람이나 선행 작업을 기다리는 중', order: 20 },
    review: { label: '검토', description: '검토자의 확인을 기다리는 중', order: 30 },
    done: { label: '완료', description: '수용 조건이 충족되어 끝남', order: 40 },
    cancelled: { label: '반려', description: '하지 않기로 결정되어 닫힘', order: 50 }
  },
  priorities: {
    high: { label: '높음', description: '먼저 처리한다', order: 0 },
    mid: { label: '중간', description: '보통 순서로 처리한다', order: 10 },
    low: { label: '낮음', description: '여유가 있을 때 처리한다', order: 20 }
  },
  profiles: {
    lean: { label: '간소', description: '요구사항과 검증만으로 시작하는 최소 구성', order: 0 },
    product: { label: '제품', description: '제품 요구사항과 화면 설계까지 갖춘 구성', order: 10 },
    service: { label: '서비스', description: '아키텍처와 운영 가이드를 포함한 기본 구성', order: 20 },
    platform: { label: '플랫폼', description: '인터페이스와 데이터 모델을 함께 관리하는 구성', order: 30 },
    assured: { label: '보증', description: '모든 유형을 필수로 두는 가장 엄격한 구성', order: 40 }
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// 프로필은 다른 그룹과 달리 키가 열려 있다. 팀이 자기 프리셋을 만들 수 있어야 하기
// 때문이다. 대신 키는 저장값이므로 표시용 한글이 그대로 들어오지 않도록 형식을 못박고,
// 내장에 없는 이름은 정책을 반드시 함께 적게 한다. 정책 없는 커스텀 프로필은 조용히
// service로 되돌아가, 사용자가 만든 적 없는 계약이 저장된다.
const PROFILE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/u;
const PROFILE_ENTRY_FIELDS = ENTRY_FIELDS.concat(['policy']);

function validateProfilePolicy(key, policy, file) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error(`${file}: profiles.${key}.policy는 객체여야 합니다.`);
  for (const state of Object.keys(policy)) {
    if (!POLICY_STATE_KEYS.includes(state)) throw new Error(`${file}: 지원하지 않는 정책 상태입니다: profiles.${key}.policy.${state}`);
    if (!Array.isArray(policy[state])) throw new Error(`${file}: profiles.${key}.policy.${state}는 배열이어야 합니다.`);
    for (const type of policy[state]) if (!REGULAR_TYPES.includes(type)) throw new Error(`${file}: 알 수 없는 문서 유형입니다: profiles.${key}.policy.${state}의 ${type}`);
  }
  const seen = new Set();
  for (const state of POLICY_STATE_KEYS) for (const type of policy[state] || []) {
    if (seen.has(type)) throw new Error(`${file}: profiles.${key}.policy에서 ${type}이 두 상태에 걸쳐 있습니다.`);
    seen.add(type);
  }
  if (!seen.size) throw new Error(`${file}: profiles.${key}.policy가 비어 있습니다. 최소한 하나의 유형을 배치하세요.`);
}

function validateEntry(group, key, entry, file) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${file}: ${group}.${key}는 객체여야 합니다.`);
  const fields = group === 'profiles' ? PROFILE_ENTRY_FIELDS : ENTRY_FIELDS;
  for (const field of Object.keys(entry)) if (!fields.includes(field)) throw new Error(`${file}: 지원하지 않는 필드입니다: ${group}.${key}.${field}`);
  if (group === 'profiles') {
    if (!PROFILE_KEY_PATTERN.test(key)) throw new Error(`${file}: 프로필 이름은 영문 소문자와 숫자, 하이픈만 쓸 수 있습니다: ${key}`);
    if (entry.policy !== undefined) validateProfilePolicy(key, entry.policy, file);
    else if (!PROFILE_KEYS.includes(key)) throw new Error(`${file}: 내장에 없는 프로필 ${key}에는 policy가 필요합니다.`);
  }
  if (entry.label !== undefined && (typeof entry.label !== 'string' || !entry.label.trim())) throw new Error(`${file}: ${group}.${key}.label은 비어 있지 않은 문자열이어야 합니다.`);
  if (entry.description !== undefined && (typeof entry.description !== 'string' || !entry.description.trim())) throw new Error(`${file}: ${group}.${key}.description은 비어 있지 않은 문자열이어야 합니다.`);
  if (entry.order !== undefined && !Number.isInteger(entry.order)) throw new Error(`${file}: ${group}.${key}.order는 정수여야 합니다.`);
}

function readConfig(file) {
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file}: 올바른 JSON이 아닙니다: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: 설정 루트는 객체여야 합니다.`);
  const allowed = ['schemaVersion'].concat(Object.keys(PRESENTATION_GROUPS));
  for (const field of Object.keys(value)) if (!allowed.includes(field)) throw new Error(`${file}: 지원하지 않는 필드입니다: ${field}`);
  if (value.schemaVersion !== 1) throw new Error(`${file}: 지원하지 않는 board.json schemaVersion입니다: ${value.schemaVersion}`);
  for (const [group, keys] of Object.entries(PRESENTATION_GROUPS)) {
    const entries = value[group] || {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${file}: ${group}는 객체여야 합니다.`);
    for (const [key, entry] of Object.entries(entries)) {
      if (group !== 'profiles' && !keys.includes(key)) throw new Error(`${file}: 지원하지 않는 ${group} 키입니다: ${key}`);
      validateEntry(group, key, entry, file);
    }
  }
  return value;
}

function mergePresentation(target, source) {
  if (!source) return target;
  for (const group of Object.keys(PRESENTATION_GROUPS)) {
    for (const [key, entry] of Object.entries(source[group] || {})) target[group][key] = Object.assign({}, target[group][key], entry);
  }
  return target;
}

function loadBoardPresentation(start, projectKey) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  const workspaceFile = path.join(layout.root, 'projects', 'workspace', 'board.json');
  const projectFile = path.join(project.root, 'board.json');
  const workspace = readConfig(workspaceFile);
  const projectOverride = readConfig(projectFile);
  const effective = mergePresentation(mergePresentation(clone(DEFAULT_PRESENTATION), workspace), projectOverride);
  effective.inheritance = {
    builtin: true,
    workspace: { file: workspaceFile, configured: Boolean(workspace) },
    project: { file: projectFile, configured: Boolean(projectOverride) }
  };
  return effective;
}

// 내장 프리셋은 코드가, 팀 프리셋은 board.json이 갖는다. 계약이 저장하는 것은 프로필
// 이름 하나뿐이므로, 그 이름이 무슨 정책인지는 언제나 여기서 다시 계산된다.
function resolveProfilePresets(presentation) {
  const presets = {};
  for (const [name, policy] of Object.entries(DEFAULT_POLICIES)) presets[name] = JSON.parse(JSON.stringify(policy));
  for (const [name, entry] of Object.entries((presentation && presentation.profiles) || {})) {
    if (!entry || !entry.policy) continue;
    const policy = {};
    const seen = new Set();
    for (const state of POLICY_STATE_KEYS) {
      policy[state] = (entry.policy[state] || []).filter((type) => REGULAR_TYPES.includes(type) && !seen.has(type) && (seen.add(type), true));
    }
    // 어디에도 배치되지 않은 유형은 필요할 때로 둔다. 빠뜨린 유형이 조용히 사라지면
    // 그 유형은 계약에서 아예 없는 것이 되어 검사도 안내도 받지 못한다.
    for (const type of REGULAR_TYPES) if (!seen.has(type)) policy.onDemand.push(type);
    presets[name] = policy;
  }
  return presets;
}

function profileChoices(presentation) {
  const presets = resolveProfilePresets(presentation);
  const entries = (presentation && presentation.profiles) || {};
  return Object.keys(presets).sort((left, right) => {
    const leftOrder = entries[left] && Number.isInteger(entries[left].order) ? entries[left].order : 1000;
    const rightOrder = entries[right] && Number.isInteger(entries[right].order) ? entries[right].order : 1000;
    return leftOrder - rightOrder || (left < right ? -1 : left > right ? 1 : 0);
  }).map((name) => ({
    name,
    label: (entries[name] && entries[name].label) || name,
    description: (entries[name] && entries[name].description) || '',
    builtin: PROFILE_KEYS.includes(name),
    policy: presets[name]
  }));
}

function presentationFile(start, projectKey, scope) {
  const layout = workspaceLayout(start);
  if (scope === 'workspace') return path.join(layout.root, 'projects', 'workspace', 'board.json');
  if (scope === 'project') return path.join(selectProject(layout, projectKey, true).root, 'board.json');
  throw new Error(`알 수 없는 설정 범위입니다: ${scope}`);
}

// 화면에서 고친 표시 규칙을 그 범위의 board.json에 쓴다. 쓰기 전에 읽을 때와 같은
// 검증을 통과시킨다. 통과하지 못하면 파일을 건드리지 않는다. 반쯤 적용된 설정은
// 잘못된 설정보다 나쁘다.
function savePresentation(start, projectKey, scope, input) {
  const file = presentationFile(start, projectKey, scope);
  const next = { schemaVersion: 1 };
  for (const group of Object.keys(PRESENTATION_GROUPS)) {
    const supplied = (input && input[group]) || {};
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error(`${group}는 객체여야 합니다.`);
    next[group] = {};
    for (const [key, entry] of Object.entries(supplied)) {
      validateEntry(group, key, entry, file);
      next[group][key] = entry;
    }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return { file, scope };
}

function renderWorkspaceBoardConfig() {
  return `${JSON.stringify(DEFAULT_PRESENTATION, null, 2)}\n`;
}

function renderProjectBoardConfig() {
  const empty = { schemaVersion: 1 };
  for (const group of Object.keys(PRESENTATION_GROUPS)) empty[group] = {};
  return `${JSON.stringify(empty, null, 2)}\n`;
}

module.exports = {
  DOCUMENT_TYPE_KEYS, DOCUMENT_STATE_KEYS, POLICY_STATE_KEYS, ENFORCEMENT_KEYS,
  TASK_STATUS_KEYS, PRIORITY_KEYS, PRESENTATION_GROUPS, DEFAULT_PRESENTATION,
  readConfig, mergePresentation, loadBoardPresentation,
  resolveProfilePresets, profileChoices, presentationFile, savePresentation,
  renderWorkspaceBoardConfig, renderProjectBoardConfig
};
