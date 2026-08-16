'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const {
  REGULAR_TYPES, POLICY_STATES, PROFILE_NAMES, ENFORCEMENTS, DOCUMENT_SECTION_CATALOG, DEFAULT_OMISSIONS, DEFAULT_RULES, normalizeProfile, migrateProfile,
  parseDocumentProfile, validateDocumentProfile, applyToProject, profileImpact
} = require('./document-profile');
const { BOUNDARY_VERSION, TYPE_GUIDANCE, SPLIT_SIGNALS } = require('./document-boundary');
const { CONTRACT_VERSION, IMPLEMENTATION_TYPES, REQUIRED_FIELDS_BY_TYPE, implementationTrace } = require('./implementation-contract');
const { DIAGRAM_VERSION, DIAGRAM_CONVENTIONS } = require('./document-diagram');
const { loadBoardPresentation, resolveProfilePresets, profileChoices } = require('./board-presentation');

function documentContractCatalog() {
  const templateRoot = path.resolve(__dirname, '..', 'docs', 'templates');
  const sections = {};
  for (const type of REGULAR_TYPES) {
    const template = path.join(templateRoot, `${type}.template.md`);
    const source = fs.existsSync(template) ? fs.readFileSync(template, 'utf8') : '';
    const headings = source.split(/\r?\n/u).map((line) => /^##\s+(.+?)\s*#*\s*$/u.exec(line)).filter(Boolean).map((match) => match[1].trim());
    sections[type] = headings.length ? headings : DOCUMENT_SECTION_CATALOG[type].slice();
  }
  return JSON.parse(JSON.stringify({
    documentTypes: REGULAR_TYPES,
    policyStates: POLICY_STATES,
    profiles: PROFILE_NAMES,
    enforcements: ENFORCEMENTS,
    granularity: {
      version: BOUNDARY_VERSION,
      requiredFields: ['scope', 'excludes'],
      typeResponsibilities: TYPE_GUIDANCE,
      splitWhen: SPLIT_SIGNALS
    },
    implementation: {
      version: CONTRACT_VERSION,
      types: IMPLEMENTATION_TYPES,
      requiredFunctionFields: REQUIRED_FIELDS_BY_TYPE,
      grouping: '여러 기능을 한 문서에 둘 수 있지만 범위·행·수용 기준·테스트에서 기능 ID를 묶지 않고 각각 완전하게 작성합니다.',
      traceability: '기능 ID와 문서 직접 링크에서 계산하며 별도 인덱스 문서를 저장하지 않습니다.'
    },
    diagrams: {
      version: DIAGRAM_VERSION,
      types: Object.keys(DIAGRAM_CONVENTIONS),
      conventions: DIAGRAM_CONVENTIONS,
      authority: '다이어그램은 표에서 파생한 보조 뷰이며 표와 어긋나면 표를 따릅니다.'
    },
    sections,
    defaultOmissions: DEFAULT_OMISSIONS
  }));
}

function markdownFiles(root, output) {
  const result = output || [];
  if (!root || !fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) markdownFiles(file, result);
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(file);
  }
  return result;
}

function projectArtifacts(project) {
  const artifacts = [];
  for (const root of [project.documents, path.join(project.root, 'inbox')]) {
    for (const file of markdownFiles(root)) {
      const source = fs.readFileSync(file, 'utf8');
      const idMatch = /^id:\s*([^\r\n]+)/mu.exec(source);
      const id = idMatch ? idMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
      const typeMatch = /^([A-Z]{3})-\d{3,}$/u.exec(id || '');
      if (typeMatch) artifacts.push({ id, type: typeMatch[1], file, source });
    }
  }
  return artifacts.sort((left, right) => left.id.localeCompare(right.id));
}

function hasSection(source, section) {
  const wanted = String(section).trim().toLocaleLowerCase('ko-KR');
  return String(source || '').split(/\r?\n/u).some((line) => {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    return heading && heading[1].trim().toLocaleLowerCase('ko-KR') === wanted;
  });
}

function policyState(profile, type) {
  return POLICY_STATES.find((state) => profile.policy[state].includes(type));
}

function evaluateDocumentContract(profileInput, artifactInput) {
  const profile = migrateProfile(profileInput);
  const artifacts = (artifactInput || []).map((item) => typeof item === 'string' ? { id: item, type: item } : item);
  const byType = new Map(REGULAR_TYPES.map((type) => [type, artifacts.filter((item) => item.type === type)]));
  const present = new Set(REGULAR_TYPES.filter((type) => byType.get(type).length > 0));
  const violations = [];
  for (const type of profile.policy.required) if (!present.has(type)) violations.push({ code: 'required-missing', type, message: `필수 문서가 없습니다: ${type}` });
  for (const type of profile.policy.recommended) if (!present.has(type)) violations.push({ code: 'recommended-missing', type, message: `권장 문서가 없습니다: ${type}` });
  for (const type of profile.policy.disabled) if (present.has(type)) violations.push({ code: 'disabled-present', type, message: `비활성 문서가 존재합니다: ${type}` });

  // 사용 안 함은 이제 "만들지 않는다" 하나만 뜻한다. 흡수 판정은 제목 문자열만 보고
  // 내용을 보지 않아 빈 제목으로도 통과했고, 나중에 그 유형을 켜면 흡수해 둔 내용을
  // 옮기라고 알려주는 경로도 없었다. 보증이 없는 규칙에 유형마다 설정을 달고 있었다.
  function dependencySatisfied(type) { return present.has(type); }
  const ready = [];
  for (const type of REGULAR_TYPES) {
    const state = policyState(profile, type);
    if (state === 'disabled' || present.has(type)) continue;
    // 작성 순서 지식은 프로젝트마다 다르지 않아 상수로 둔다. 예전에는 프로젝트가 이 값을
    // 들고 다녔는데, 아무것도 막지 않으면서 유형마다 설정 항목을 하나씩 만들고 저장할
    // 때마다 보존해야 했다. 보존을 빠뜨리면 조용히 빈 값이 되는 종류의 상태였다.
    const recommendedContext = (DEFAULT_RULES[type] || []).slice();
    const missingRecommendedContext = recommendedContext.filter((dependency) => !dependencySatisfied(dependency));
    ready.push({ type, state, recommendedContext, missingRecommendedContext, after: recommendedContext, waitingFor: [] });
  }
  const rank = { required: 0, recommended: 1, onDemand: 2 };
  ready.sort((left, right) => rank[left.state] - rank[right.state] || REGULAR_TYPES.indexOf(left.type) - REGULAR_TYPES.indexOf(right.type));
  return {
    enforcement: profile.enforcement,
    revision: profile.revision,
    present: Array.from(present).sort((left, right) => REGULAR_TYPES.indexOf(left) - REGULAR_TYPES.indexOf(right)),
    ready,
    blocked: [],
    absorbed: [],
    violations
  };
}

function loadDocumentContract(start, projectKey) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  const source = fs.readFileSync(project.charter, 'utf8');
  // 어떤 프로필이 있는지는 코드가 아니라 board.json 상속이 정한다. 팀이 만든 프리셋도
  // 유효한 이름이어야 계약이 그 이름을 지키고, 화면도 그 목록을 그대로 보여 준다.
  const presentation = loadBoardPresentation(layout.root, project.key);
  const presets = resolveProfilePresets(presentation);
  const validation = validateDocumentProfile(source, presets);
  const catalog = Object.assign(documentContractCatalog(), { profiles: Object.keys(presets), profileChoices: profileChoices(presentation) });
  if (!validation.present) return { root: layout.root, project: project.key, status: 'legacy-unconfigured', profile: null, revision: null, enforcement: null, evaluation: null, catalog };
  if (validation.status === 'unsupported-schema' || validation.status === 'invalid') return { root: layout.root, project: project.key, status: validation.status, profile: validation.profile, revision: validation.profile && validation.profile.revision, enforcement: validation.profile && validation.profile.enforcement, errors: validation.errors, evaluation: null, catalog };
  const profile = validation.status === 'migration-required' ? migrateProfile(validation.profile) : validation.profile;
  const artifacts = projectArtifacts(project);
  const evaluation = evaluateDocumentContract(profile, artifacts);
  const traceability = implementationTrace(artifacts);
  return { root: layout.root, project: project.key, status: validation.status, profile, revision: profile.revision, enforcement: profile.enforcement, evaluation, traceability, catalog };
}

function assertDocumentCreationAllowed(start, projectKey, type) {
  const contract = loadDocumentContract(start, projectKey);
  if (contract.status === 'legacy-unconfigured') return contract;
  if (contract.status === 'invalid' || contract.status === 'unsupported-schema') throw new Error(`문서 계약이 ${contract.status} 상태입니다. rdl contract check로 수정하세요.`);
  const upper = String(type || '').toUpperCase();
  if (contract.profile.policy.disabled.includes(upper)) throw new Error(`문서 계약에서 ${upper} 유형은 사용 안 함입니다. 이 유형이 필요하면 계약에서 상태를 먼저 바꾸세요.`);
  return contract;
}

// 흡수 처분은 유형마다 따로 세운 결정이다. 보내온 값이 그 결정을 담고 있지 않으면
// 지금 것을 그대로 둔다. 통째로 갈아끼우면, 계약 화면이 표현하지 못하는 처분(해당 없음과
// 그 사유)이 저장 한 번에 카탈로그 기본값으로 바뀌어 사라진다.
function planDocumentContract(start, projectKey, input) {
  const current = loadDocumentContract(start, projectKey);
  const before = current.profile;
  const settings = input || {};
  const merged = Object.assign({}, before || {}, settings);
  if (before && settings.name && settings.name !== before.name && !Object.prototype.hasOwnProperty.call(settings, 'policy')) {
    delete merged.policy;
  }
  const presets = resolveProfilePresets(loadBoardPresentation(workspaceLayout(start).root, projectKey));
  if (settings.name && !Object.prototype.hasOwnProperty.call(presets, settings.name)) {
    const error = new Error(`알 수 없는 문서 프로필입니다: ${settings.name}. board.json에 정의하거나 내장 프로필 중에서 고르세요.`);
    error.statusCode = 400;
    throw error;
  }
  const next = normalizeProfile(Object.assign(merged, {
    schemaVersion: 2,
    revision: before ? before.revision + 1 : 1,
    history: before ? before.history.concat(settings.name || before.name) : [settings.name || 'service']
  }), presets);
  const evaluation = evaluateDocumentContract(next, projectArtifacts(selectProject(workspaceLayout(start), projectKey, true)));
  return { root: current.root, project: current.project, baseRevision: current.revision, profile: next, impact: profileImpact(before, next), evaluation };
}

function updateDocumentContract(start, projectKey, input) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  const current = loadDocumentContract(layout.root, project.key);
  if (!input || !Object.prototype.hasOwnProperty.call(input, 'baseRevision') || input.baseRevision !== current.revision) {
    const error = new Error('문서 계약이 다른 실행 주체에 의해 변경되었습니다. 최신 revision을 확인하세요.');
    error.statusCode = 409;
    error.current = current;
    throw error;
  }
  const planned = planDocumentContract(layout.root, project.key, input);
  applyToProject(project.charter, planned.profile, resolveProfilePresets(loadBoardPresentation(layout.root, project.key)));
  return Object.assign(loadDocumentContract(layout.root, project.key), { impact: planned.impact });
}

module.exports = {
  projectArtifacts, hasSection, evaluateDocumentContract, loadDocumentContract,
  documentContractCatalog, assertDocumentCreationAllowed, planDocumentContract, updateDocumentContract
};
