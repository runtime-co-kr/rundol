'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { REGULAR_TYPES, DEFAULT_POLICIES, DEFAULT_SECTIONS } = require('./document-profile');

const DOCUMENT_TYPE_KEYS = ['charter', 'prd', 'requirement', 'architecture', 'screen', 'model', 'interface', 'decision', 'standard', 'test', 'runbook', 'glossary', 'clipping'];
const DOCUMENT_STATE_KEYS = ['draft', 'proposed', 'active', 'review', 'approved', 'deprecated', 'archived', 'unread'];
// 계약이 저장하는 값은 ASCII 식별자이고 화면에 보이는 말은 그 값의 라벨이다. 둘을 섞으면
// 표기를 바꾸는 순간 저장된 계약이 깨진다. 여기 키는 언제나 저장값이고 label만 바뀐다.
const POLICY_STATE_KEYS = ['required', 'recommended', 'onDemand', 'disabled'];
const ENFORCEMENT_KEYS = ['advisory', 'checkpoint'];
const TASK_STATUS_KEYS = ['todo', 'doing', 'waiting', 'review', 'done', 'cancelled'];
const PRIORITY_KEYS = ['high', 'mid', 'low'];
const PROFILE_KEYS = ['lean', 'product', 'service', 'platform', 'assured'];
const ENTRY_FIELDS = ['label', 'description', 'order', 'disabled'];
// 되돌릴 수 없는 관문의 이름. 화면에 두지 않는 것만으로는 파일로 우회하는 길이
// 남는다 — 파일은 손으로 고칠 수 있고 병합으로도 흘러들어온다. 그래서 읽는
// 시점에 거부한다. 무시하지 않는 이유는 무시가 최악이기 때문이다: 적은 사람은
// 적용됐다고 믿고, 믿음과 실제가 어긋난 사실은 사고 뒤에야 드러난다.
//
// 이 목록은 허용 목록의 반대편이 아니라 그 자체로 완결이다. 여기 있는 이름이
// 설정 파일 어디에 나오든 거부한다.
const BOUNDARY_KEYS = Object.freeze([
  'approvalRequired', 'humanGate', 'gateBypass', 'delegationGrant',
  'forceTakeover', 'forceResolve', 'publish', 'prMerge', 'approvalRevisionBinding'
]);
// 정책 필드는 그룹마다 다르고 코드가 갖는다. 파일이 자기 허용 목록을 선언할 수
// 있으면 아무 필드나 허용된다고 적으면 그만이다.
//
// 프로필의 policy와 sections는 이름을 얻기 전부터 정책 필드였다. 표시 항목 안에
// 동작을 정하는 값이 형제로 앉는 형태가 이 파일에서 이미 쓰이고 있었다는 뜻이고,
// 새 정책 필드도 같은 자리에 온다.
const POLICY_FIELDS = Object.freeze({ profiles: ['policy', 'sections'] });
// 판수 1 시절부터 저장되던 정책 필드. 이름을 뒤늦게 붙였다고 이미 있는 파일을
// 거부할 수는 없다. 판수 요구는 이 집합 밖의 새 정책 필드에만 건다.
const GRANDFATHERED_POLICY_FIELDS = new Set(['profiles.policy', 'profiles.sections']);

// 범위 전체에 하나뿐인 정책 값은 최상위 키에 둔다. 항목에 붙지 않는 값을 억지로
// 항목 안에 넣으면 어느 항목에 넣을지가 임의가 되고, 임의로 정한 자리는 다음 사람이
// 다른 자리에 넣는다. 그룹 이름과 겹치지 않아야 두 모양이 섞이지 않는다.
const SCALAR_KEYS = Object.freeze(['approval']);

// 승인 모드는 이름 하나가 조합 전체를 정한다. 조합의 일부를 여기서 적을 수 있으면
// 이름이 뜻을 잃고 "AI 우선인데 검증자가 하나"인 프로젝트가 생긴다. 그래서 이 자리는
// 이름만 받고 손잡이 값을 받지 않는다.
//
// mode는 프로젝트가 고르는 값이고 floor는 작업공간이 까는 바닥이다. 한 파일에 둘 다
// 있어도 막지 않는다 — 범위마다 무엇을 읽을지는 읽는 쪽이 정하고, 파일이 그것까지
// 강제하면 작업공간 파일을 프로젝트로 복사하는 흔한 일이 거부된다.
const APPROVAL_FIELDS = Object.freeze(['mode', 'floor']);
const APPROVAL_MODE_NAMES = Object.freeze(['human-only', 'ai-assisted', 'ai-first', 'ai-only']);

function validateApproval(value, file) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: approval은 객체여야 합니다.`);
  for (const field of Object.keys(value)) {
    if (!APPROVAL_FIELDS.includes(field)) throw new Error(`${file}: 지원하지 않는 필드입니다: approval.${field} (가능: ${APPROVAL_FIELDS.join(', ')})`);
    const name = value[field];
    if (name === null) continue;
    if (!APPROVAL_MODE_NAMES.includes(name)) {
      throw new Error(`${file}: 알 수 없는 승인 모드입니다: approval.${field} = ${name} (가능: ${APPROVAL_MODE_NAMES.join(', ')})`);
    }
  }
}
// 표시 키의 옛 이름. 유형 이름을 바꾸면서 이관 경로를 함께 내지 않으면, 이름을 바꾼 것만으로
// 이미 저장된 board.json이 "지원하지 않는 키"로 거부되어 기존 Workspace가 멈춘다.
const LEGACY_GROUP_KEYS = { documentTypes: { api: 'interface' } };
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
    interface: { label: '인터페이스', description: '요청, 응답, 오류와 호환성 계약', order: 60 },
    standard: { label: '표준', description: '팀이 지켜야 할 규칙과 준수 판정', order: 95 },
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
    onDemand: { label: '선택', description: '만들어도 되고 만들지 않아도 된다. 어느 쪽이든 알리지 않는다', order: 20 },
    disabled: { label: '사용 안 함', description: '이 프로젝트에서는 만들지 않는다. 생성이 차단된다', order: 30 }
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
const PROFILE_ENTRY_FIELDS = ENTRY_FIELDS.concat(['policy', 'sections']);

// 하부 요소는 유형마다 그 문서가 채워야 하는 절이다. 흡수 시절에는 "사용 안 함"인
// 유형에만 붙어 있었는데, 정작 필요한 곳은 실제로 만드는 유형이다.
function validateProfileSections(key, sections, file) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) throw new Error(`${file}: profiles.${key}.sections는 객체여야 합니다.`);
  for (const [type, list] of Object.entries(sections)) {
    if (!REGULAR_TYPES.includes(type)) throw new Error(`${file}: 알 수 없는 문서 유형입니다: profiles.${key}.sections.${type}`);
    if (!Array.isArray(list)) throw new Error(`${file}: profiles.${key}.sections.${type}는 배열이어야 합니다.`);
    for (const item of list) if (typeof item !== 'string' || !item.trim()) throw new Error(`${file}: profiles.${key}.sections.${type}에 빈 값이 있습니다.`);
  }
}

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
    if (entry.sections !== undefined) validateProfileSections(key, entry.sections, file);
  }
  if (entry.label !== undefined && (typeof entry.label !== 'string' || !entry.label.trim())) throw new Error(`${file}: ${group}.${key}.label은 비어 있지 않은 문자열이어야 합니다.`);
  if (entry.description !== undefined && (typeof entry.description !== 'string' || !entry.description.trim())) throw new Error(`${file}: ${group}.${key}.description은 비어 있지 않은 문자열이어야 합니다.`);
  if (entry.order !== undefined && !Number.isInteger(entry.order)) throw new Error(`${file}: ${group}.${key}.order는 정수여야 합니다.`);
  // 사용 안 함은 값이 아니라 항목의 상태다. 맵 병합에는 삭제가 없으므로 상속받은
  // 키를 하위가 없애려면 없앤다고 적어야 한다 — 파일에서 빼면 "선언하지 않음"이
  // 되어 상위 값이 그대로 내려온다. 없앴다는 판단이 파일에 남아야 나중에 왜
  // 없앴는지 답할 수 있고, 정책 상태의 사용 안 함이 이미 같은 뜻으로 쓰인다.
  if (entry.disabled !== undefined && entry.disabled !== true) throw new Error(`${file}: ${group}.${key}.disabled는 true만 쓸 수 있습니다. 되살리려면 그 줄을 지우세요.`);
}

// 경계 층 이름은 그룹이든 항목이든 필드든 어디에 나와도 거부한다. 대조는 정확히
// 일치할 때만 한다 — 접두 일치를 쓰면 우연히 경계 이름으로 시작하는 정책 키가
// 영원히 막힌다.
function assertNoBoundaryKeys(value, file, path) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (BOUNDARY_KEYS.includes(key)) {
      throw new Error(`${file}: ${path}${key}는 되돌릴 수 없는 관문이라 설정 대상이 아닙니다. 이 값은 파일로 바꿀 수 없습니다.`);
    }
    if (child && typeof child === 'object' && !Array.isArray(child)) assertNoBoundaryKeys(child, file, `${path}${key}.`);
  }
}

// 값 하나가 어느 계층에서 왔는지는 병합 결과가 아니라 계층별 원본이 답한다. 값을
// 견주면 상위와 같은 값을 명시한 경우를 상속으로 잘못 읽고, 그 둘은 상위가 바뀔
// 때 다르게 행동하므로 같게 다루면 되돌리기라는 조작 자체가 성립하지 않는다.
function computeOrigins(sources) {
  const origins = {};
  for (const group of Object.keys(PRESENTATION_GROUPS)) {
    origins[group] = {};
    const layers = [['builtin', sources.builtin], ['workspace', sources.workspace], ['project', sources.project]];
    for (const [layer, config] of layers) {
      const entries = (config && config[group]) || {};
      for (const [key, entry] of Object.entries(entries)) {
        const current = origins[group][key] || { entry: layer, fields: {} };
        current.entry = layer;
        for (const field of Object.keys(entry || {})) current.fields[field] = layer;
        origins[group][key] = current;
      }
    }
  }
  return origins;
}

function readConfig(file) {
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file}: 올바른 JSON이 아닙니다: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: 설정 루트는 객체여야 합니다.`);
  const allowed = ['schemaVersion'].concat(SCALAR_KEYS, Object.keys(PRESENTATION_GROUPS));
  for (const field of Object.keys(value)) if (!allowed.includes(field)) throw new Error(`${file}: 지원하지 않는 필드입니다: ${field}`);
  validateApproval(value.approval, file);
  // 경계 판정이 허용 필드 판정보다 먼저 돈다. 나중에 돌면 경계 이름이 "지원하지
  // 않는 필드"라는 엉뚱한 이름으로 거부되고, 그 메시지를 받은 사용자는 철자를
  // 고치려 든다. 판수도 보지 않는다 — 보면 판수를 올리는 것이 잠금 해제로 보인다.
  assertNoBoundaryKeys(value, file, '');
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new Error(`${file}: 지원하지 않는 board.json schemaVersion입니다: ${value.schemaVersion}`);
  // 새 정책 필드는 판수 2를 선언한 파일에서만 받는다. 다만 프로필의 policy와
  // sections는 판수 1 시절부터 유효했으므로 그대로 둔다 — 뒤늦게 정책 필드라는
  // 이름을 붙였다고 이미 저장된 팀 프리셋을 거부하면, 이름 하나 바꾼 것만으로
  // 남의 파일이 열리지 않는다. 이름은 새로 붙이되 판정은 그날 이후 것에만 건다.
  if (value.schemaVersion === 1) {
    for (const [group, fields] of Object.entries(POLICY_FIELDS)) {
      for (const [key, entry] of Object.entries(value[group] || {})) {
        for (const field of fields) {
          if (GRANDFATHERED_POLICY_FIELDS.has(`${group}.${field}`)) continue;
          if (entry && Object.prototype.hasOwnProperty.call(entry, field)) {
            throw new Error(`${file}: ${group}.${key}.${field}는 정책 필드입니다. schemaVersion을 2로 올리세요.`);
          }
        }
      }
    }
  }
  for (const [group, keys] of Object.entries(PRESENTATION_GROUPS)) {
    const entries = value[group] || {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${file}: ${group}는 객체여야 합니다.`);
    const aliases = LEGACY_GROUP_KEYS[group] || {};
    const resolved = {};
    for (const [key, entry] of Object.entries(entries)) {
      const canonical = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
      if (group !== 'profiles' && !keys.includes(canonical)) throw new Error(`${file}: 지원하지 않는 ${group} 키입니다: ${key}`);
      validateEntry(group, canonical, entry, file);
      // 옛 키와 새 키가 함께 있으면 새 키가 이긴다. 옛 키를 지우지 않은 파일에서
      // 지운 줄 알았던 값이 되살아나면 안 된다.
      if (canonical === key || !Object.prototype.hasOwnProperty.call(entries, canonical)) resolved[canonical] = entry;
    }
    if (Object.keys(entries).length) value[group] = resolved;
  }
  return value;
}

function mergePresentation(target, source) {
  if (!source) return target;
  // 최상위 스칼라도 계층을 탄다. 그룹만 합치면 작업공간이 깐 바닥이 프로젝트에
  // 닿지 않고, 바닥은 선언했는데 아무것도 막지 않는 상태가 된다.
  if (source.approval) target.approval = Object.assign({}, target.approval, source.approval);
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
  // 합쳐진 값만으로는 편집할 수 없다. 어떤 항목이 이 범위에서 덮인 것이고 어떤 것이
  // 위에서 내려온 것인지 구분해야, 지운다는 뜻과 같은 값으로 덮는다는 뜻이 갈린다.
  effective.sources = { builtin: clone(DEFAULT_PRESENTATION), workspace, project: projectOverride };
  // 출처는 화면이 다시 계산하지 않는다. 합쳐진 값과 계층별 원본이 둘 다 여기
  // 있으므로 판정도 여기서 끝내는 편이, 읽는 쪽마다 제 나름의 판정을 두는 것보다
  // 낫다 — 판정이 흩어지면 화면과 검사가 다른 답을 낸다.
  effective.origins = computeOrigins(effective.sources);
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

// 프리셋이 하부 요소를 따로 정하지 않으면 실제 문서에서 뽑은 기본값을 쓴다.
function resolveProfileSections(presentation, name) {
  const entry = (presentation && presentation.profiles && presentation.profiles[name]) || {};
  const sections = {};
  for (const type of REGULAR_TYPES) {
    const supplied = entry.sections && entry.sections[type];
    sections[type] = Array.isArray(supplied) ? supplied.slice() : (DEFAULT_SECTIONS[type] || []).slice();
  }
  return sections;
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
    policy: presets[name],
    sections: resolveProfileSections(presentation, name)
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
// 키 순서와 공백은 변경이 아니다. 그대로 견주면 아무것도 바꾸지 않은 저장이
// 결정을 요구하고, 그런 요구가 몇 번 반복되면 사람은 내용을 보지 않고 누른다.
function stableJson(value) {
  if (value === undefined) return ' ';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

// 정책 차이만 결정을 요구한다. 표시 문구까지 결정을 요구하면 라벨의 오타를 고치는
// 데도 결정이 필요해지고, 형식이 된 결정은 그 안에 담긴 정책 변경까지 함께 가린다.
// 층을 나눈 이유가 여기서 쓰인다 — 표시 층은 판정에 쓰이지 않으므로 기록을 요구할
// 근거가 없다.
//
// 조이는 변경과 푸는 변경을 가리지 않는다. 무엇이 조이는 것인지는 값의 의미를
// 알아야 정하고, 그 판정을 기록 요구의 조건으로 삼으면 판정이 틀리는 순간 기록이
// 조용히 사라진다.
function policyDifferences(previous, next) {
  const differences = [];
  for (const group of Object.keys(PRESENTATION_GROUPS)) {
    const before = (previous && previous[group]) || {};
    const after = (next && next[group]) || {};
    const fields = POLICY_FIELDS[group] || [];
    for (const key of Array.from(new Set(Object.keys(before).concat(Object.keys(after)))).sort()) {
      for (const field of fields) {
        const from = before[key] ? before[key][field] : undefined;
        const to = after[key] ? after[key][field] : undefined;
        if (stableJson(from) !== stableJson(to)) differences.push({ group, key, field, from, to });
      }
      // 사용 안 함은 어느 그룹에서나 정책이다. 항목을 없애는 것은 표기가 아니라
      // 그 항목을 쓸 수 있는지를 바꾸므로, 표시 층으로 새면 되돌릴 수 없는 값이
      // 기록 없이 사라진다.
      const fromDisabled = Boolean(before[key] && before[key].disabled);
      const toDisabled = Boolean(after[key] && after[key].disabled);
      if (fromDisabled !== toDisabled) differences.push({ group, key, field: 'disabled', from: fromDisabled, to: toDisabled });
    }
  }
  return differences;
}

// 판수는 담긴 것이 정한다. 정책 필드가 없으면 1로 남겨 구버전이 계속 읽는다.
function schemaVersionFor(next) {
  for (const [group, fields] of Object.entries(POLICY_FIELDS)) {
    for (const entry of Object.values(next[group] || {})) {
      for (const field of fields) {
        if (GRANDFATHERED_POLICY_FIELDS.has(`${group}.${field}`)) continue;
        if (entry && Object.prototype.hasOwnProperty.call(entry, field)) return 2;
      }
    }
  }
  return 1;
}

function savePresentation(start, projectKey, scope, input, options) {
  const file = presentationFile(start, projectKey, scope);
  const previous = readConfig(file);
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
  if (input && input.approval !== undefined) {
    validateApproval(input.approval, file);
    next.approval = input.approval;
  } else if (previous && previous.approval !== undefined) {
    // 저장 요청이 approval을 담지 않았다고 지우지 않는다. 표시 문구 한 줄 고치는
    // 저장이 승인 모드를 조용히 없애면, 없어진 것을 아무도 알아채지 못한다.
    next.approval = previous.approval;
  }
  next.schemaVersion = schemaVersionFor(next);
  // 정책이 바뀌는데 결정이 없으면 저장하지 않는다. 어떤 필드가 결정을 요구하는지
  // 함께 알린다 — 이름만 알리면 무엇을 되돌려야 하는지 알 수 없다.
  const policyChanges = policyDifferences(previous, next);
  if (policyChanges.length && !(options && options.decisionId)) {
    const where = policyChanges.map((item) => `${item.group}.${item.key}.${item.field}`).join(', ');
    throw new Error(`정책 층 변경은 계약 변경 결정이 필요합니다: ${where}`);
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  // 무엇이 바뀌었는지를 돌려준다. 부르는 쪽이 이것을 결정 원장에 싣는다 — 이전
  // 값과 새 값이 함께 남아야 복원할 수 있고, 복원할 수 없는 기록은 기록이 아니다.
  return { file, scope, policyChanges };
}

// board.json은 덮어쓴 것만 갖는다. 기본값을 파일에 복사해두면 유형을 하나 더할 때마다
// 공유 파일이 바뀌고, 같은 저장소를 보는 구버전이 모르는 키에서 멈춘다. 기본값은 코드가
// 갖고 파일은 사람이 바꾼 것만 갖는다 — 그래야 무엇이 덮인 것인지도 파일에서 보인다.
function renderEmptyBoardConfig() {
  const empty = { schemaVersion: 1 };
  for (const group of Object.keys(PRESENTATION_GROUPS)) empty[group] = {};
  return `${JSON.stringify(empty, null, 2)}\n`;
}

function renderWorkspaceBoardConfig() {
  return renderEmptyBoardConfig();
}

function renderProjectBoardConfig() {
  return renderEmptyBoardConfig();
}

module.exports = {
  DOCUMENT_TYPE_KEYS, DOCUMENT_STATE_KEYS, POLICY_STATE_KEYS, ENFORCEMENT_KEYS,
  TASK_STATUS_KEYS, PRIORITY_KEYS, PRESENTATION_GROUPS, DEFAULT_PRESENTATION,
  BOUNDARY_KEYS, POLICY_FIELDS, SCALAR_KEYS, APPROVAL_MODE_NAMES,
  readConfig, mergePresentation, loadBoardPresentation, computeOrigins, policyDifferences,
  resolveProfilePresets, resolveProfileSections, profileChoices, presentationFile, savePresentation,
  renderWorkspaceBoardConfig, renderProjectBoardConfig
};
