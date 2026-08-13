'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const {
  REGULAR_TYPES, POLICY_STATES, normalizeProfile, migrateProfile,
  parseDocumentProfile, validateDocumentProfile, applyToProject, profileImpact
} = require('./document-profile');

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

  const omissionStatus = {};
  for (const type of profile.policy.disabled) {
    const omission = profile.omissions[type];
    if (omission.notApplicable) {
      omissionStatus[type] = { type, disposition: 'notApplicable', reason: omission.reason, satisfied: true };
      continue;
    }
    const targets = byType.get(omission.absorbedBy) || [];
    const missingSections = omission.sections.filter((section) => !targets.some((target) => hasSection(target.source, section)));
    const satisfied = targets.length > 0 && missingSections.length === 0;
    omissionStatus[type] = { type, disposition: 'absorbed', absorbedBy: omission.absorbedBy, sections: omission.sections, missingSections, satisfied };
    if (!targets.length) violations.push({ code: 'omission-target-missing', type, target: omission.absorbedBy, message: `${type} 생략 내용을 흡수할 ${omission.absorbedBy} 문서가 없습니다.` });
    else for (const section of missingSections) violations.push({ code: 'omission-section-missing', type, target: omission.absorbedBy, section, message: `${type} 생략 내용의 필수 섹션이 ${omission.absorbedBy}에 없습니다: ${section}` });
  }

  function dependencySatisfied(type) {
    if (present.has(type)) return true;
    if (profile.policy.disabled.includes(type)) return Boolean(omissionStatus[type] && omissionStatus[type].satisfied);
    return false;
  }
  for (const type of REGULAR_TYPES) {
    if (!present.has(type) || profile.policy.disabled.includes(type)) continue;
    for (const dependency of profile.rules[type].after) if (!dependencySatisfied(dependency)) {
      violations.push({ code: 'after-missing', type, dependency, message: `${type} 문서보다 먼저 ${dependency} 문서 또는 유효한 생략 처리가 필요합니다.` });
    }
  }

  const ready = [];
  const blocked = [];
  for (const type of REGULAR_TYPES) {
    const state = policyState(profile, type);
    if (state === 'disabled' || present.has(type)) continue;
    const waitingFor = profile.rules[type].after.filter((dependency) => !dependencySatisfied(dependency));
    const item = { type, state, after: profile.rules[type].after.slice(), waitingFor };
    if (waitingFor.length) blocked.push(item); else ready.push(item);
  }
  const rank = { required: 0, recommended: 1, onDemand: 2 };
  ready.sort((left, right) => rank[left.state] - rank[right.state] || REGULAR_TYPES.indexOf(left.type) - REGULAR_TYPES.indexOf(right.type));
  blocked.sort((left, right) => rank[left.state] - rank[right.state] || REGULAR_TYPES.indexOf(left.type) - REGULAR_TYPES.indexOf(right.type));
  return {
    enforcement: profile.enforcement,
    revision: profile.revision,
    present: Array.from(present).sort((left, right) => REGULAR_TYPES.indexOf(left) - REGULAR_TYPES.indexOf(right)),
    ready,
    blocked,
    absorbed: Object.values(omissionStatus),
    violations
  };
}

function loadDocumentContract(start, projectKey) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  const source = fs.readFileSync(project.charter, 'utf8');
  const validation = validateDocumentProfile(source);
  if (!validation.present) return { root: layout.root, project: project.key, status: 'legacy-unconfigured', profile: null, revision: null, enforcement: null, evaluation: null };
  if (validation.status === 'unsupported-schema' || validation.status === 'invalid') return { root: layout.root, project: project.key, status: validation.status, profile: validation.profile, revision: validation.profile && validation.profile.revision, enforcement: validation.profile && validation.profile.enforcement, errors: validation.errors, evaluation: null };
  const profile = validation.status === 'migration-required' ? migrateProfile(validation.profile) : validation.profile;
  const evaluation = evaluateDocumentContract(profile, projectArtifacts(project));
  return { root: layout.root, project: project.key, status: validation.status, profile, revision: profile.revision, enforcement: profile.enforcement, evaluation };
}

function assertDocumentCreationAllowed(start, projectKey, type) {
  const contract = loadDocumentContract(start, projectKey);
  if (contract.status === 'legacy-unconfigured') return contract;
  if (contract.status === 'invalid' || contract.status === 'unsupported-schema') throw new Error(`문서 계약이 ${contract.status} 상태입니다. rdl contract check로 수정하세요.`);
  const upper = String(type || '').toUpperCase();
  if (contract.profile.policy.disabled.includes(upper)) throw new Error(`문서 계약에서 ${upper} 유형은 비활성입니다. 생략 규칙의 대상 문서에 내용을 포함하세요.`);
  const item = contract.evaluation.ready.concat(contract.evaluation.blocked).find((candidate) => candidate.type === upper);
  if (item && item.waitingFor.length) throw new Error(`${upper} 문서를 만들기 전에 다음 문서 또는 유효한 생략 처리가 필요합니다: ${item.waitingFor.join(', ')}`);
  return contract;
}

function planDocumentContract(start, projectKey, input) {
  const current = loadDocumentContract(start, projectKey);
  const before = current.profile;
  const settings = input || {};
  const merged = Object.assign({}, before || {}, settings);
  if (before && settings.name && settings.name !== before.name && !Object.prototype.hasOwnProperty.call(settings, 'policy')) {
    delete merged.policy;
    delete merged.omissions;
  }
  const next = normalizeProfile(Object.assign(merged, {
    schemaVersion: 2,
    revision: before ? before.revision + 1 : 1,
    history: before ? before.history.concat(settings.name || before.name) : [settings.name || 'service']
  }));
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
  applyToProject(project.charter, planned.profile);
  return Object.assign(loadDocumentContract(layout.root, project.key), { impact: planned.impact });
}

module.exports = {
  projectArtifacts, hasSection, evaluateDocumentContract, loadDocumentContract,
  assertDocumentCreationAllowed, planDocumentContract, updateDocumentContract
};
