'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');

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

function validateEntry(group, key, entry, file) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${file}: ${group}.${key}는 객체여야 합니다.`);
  for (const field of Object.keys(entry)) if (!ENTRY_FIELDS.includes(field)) throw new Error(`${file}: 지원하지 않는 필드입니다: ${group}.${key}.${field}`);
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
      if (!keys.includes(key)) throw new Error(`${file}: 지원하지 않는 ${group} 키입니다: ${key}`);
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
  renderWorkspaceBoardConfig, renderProjectBoardConfig
};
