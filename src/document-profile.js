'use strict';

const fs = require('fs');

const REGULAR_TYPES = ['PRD', 'REQ', 'ARC', 'SCR', 'MOD', 'API', 'ADR', 'TST', 'RUN', 'GLS'];
const PROFILE_NAMES = ['lean', 'product', 'service', 'platform', 'assured'];
const POLICY_STATES = ['required', 'recommended', 'onDemand', 'disabled'];
const ENFORCEMENTS = ['advisory', 'checkpoint'];
const TRAITS = ['ui', 'data', 'api', 'component', 'operations', 'security-regulation', 'terminology'];
const DEFAULT_POLICIES = {
  lean: { required: ['PRD', 'REQ'], recommended: ['ARC', 'TST'], onDemand: ['API', 'ADR', 'RUN', 'GLS', 'SCR', 'MOD'], disabled: [] },
  product: { required: ['PRD', 'REQ', 'SCR'], recommended: ['ARC', 'TST'], onDemand: ['MOD', 'ADR', 'API', 'RUN', 'GLS'], disabled: [] },
  service: { required: ['PRD', 'REQ', 'API', 'RUN'], recommended: ['ARC', 'MOD', 'TST'], onDemand: ['SCR', 'ADR', 'GLS'], disabled: [] },
  platform: { required: ['PRD', 'REQ', 'ARC', 'API', 'MOD'], recommended: ['ADR', 'TST', 'RUN'], onDemand: ['SCR', 'GLS'], disabled: [] },
  assured: { required: REGULAR_TYPES.slice(), recommended: [], onDemand: [], disabled: [] }
};
const DEFAULT_RULES = {
  PRD: [], REQ: ['PRD'], ARC: ['REQ'], SCR: ['REQ'], MOD: ['REQ'], API: ['REQ'],
  ADR: ['ARC'], TST: ['REQ'], RUN: ['REQ'], GLS: []
};
const DOCUMENT_SECTION_CATALOG = {
  PRD: ['문제와 배경', '사용자', '목표와 성공 지표', '범위', '제약과 가정', '마일스톤'],
  REQ: ['배경', '요구사항', '사전조건', '동작 규칙', '상태와 예외', '수용 기준', '비기능 요구', '제외 범위'],
  ARC: ['컨텍스트와 경계', '컴포넌트', '데이터 흐름', '실행과 배포', '품질 속성', '보안과 개인정보', '알려진 제약'],
  SCR: ['진입', '사용자 흐름', '전이', '바인딩', '상태', '접근성과 반응형', '디자인에 없는 것'],
  MOD: ['엔티티', '관계', '불변식', '인덱스와 조회', '보존과 개인정보', '마이그레이션'],
  API: ['엔드포인트', '오류 계약', '호환성과 버전', '제약'],
  ADR: ['맥락', '결정 기준', '선택지', '결정', '결과'],
  TST: ['목적과 범위', '테스트 수준', '시나리오', '비기능 검증', '테스트 데이터와 환경', '통과 기준'],
  RUN: ['대상과 책임', '배포', '관측', '장애 대응', '롤백과 복구', '정기 작업'],
  GLS: ['용어', '식별자와 코드']
};
const DEFAULT_OMISSIONS = {
  PRD: { absorbedBy: 'REQ', sections: ['문제와 배경', '사용자', '목표와 성공 지표', '범위'] },
  REQ: { absorbedBy: 'PRD', sections: ['요구사항', '상태와 예외', '수용 기준', '비기능 요구'] },
  ARC: { absorbedBy: 'REQ', sections: ['컨텍스트와 경계', '컴포넌트', '실행과 배포', '품질 속성'] },
  SCR: { absorbedBy: 'REQ', sections: ['사용자 흐름', '전이', '바인딩', '상태', '접근성과 반응형', '디자인에 없는 것'] },
  MOD: { absorbedBy: 'REQ', sections: ['엔티티', '관계', '불변식', '보존과 개인정보', '마이그레이션'] },
  API: { absorbedBy: 'REQ', sections: ['엔드포인트', '오류 계약', '호환성과 버전'] },
  ADR: { absorbedBy: 'ARC', sections: ['맥락', '선택지', '결정', '결과'] },
  TST: { absorbedBy: 'REQ', sections: ['목적과 범위', '시나리오', '통과 기준'] },
  RUN: { absorbedBy: 'ARC', sections: ['대상과 책임', '배포', '관측', '장애 대응', '롤백과 복구'] },
  GLS: { absorbedBy: 'PRD', sections: ['용어', '식별자와 코드'] }
};

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  const match = /^\[(.*)\]$/u.exec(value.trim());
  return (match ? match[1].split(',') : value.split(',')).map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function scalar(value) {
  return String(value == null ? '' : value).trim().replace(/^['"]|['"]$/g, '');
}

function profileBlock(source) {
  const text = String(source || '').replace(/^\uFEFF/u, '').replace(/\r\n/g, '\n');
  const start = text.search(/^documentProfile:\s*$/mu);
  if (start < 0) return null;
  const tail = text.slice(start).split('\n');
  const lines = [tail[0]];
  for (const line of tail.slice(1)) {
    if (/^(?:---\s*|\S[^:]*:\s*)$/u.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function parseRawProfile(source) {
  const block = profileBlock(source);
  if (!block) return null;
  const raw = { schemaVersion: null, revision: null, name: null, enforcement: null, traits: [], history: [], policy: {}, rules: {}, omissions: {} };
  let section = 'profile';
  let currentType = null;
  for (const line of block.split('\n').slice(1)) {
    const top = /^  (schemaVersion|revision|name|enforcement|traits|history):\s*(.*)$/u.exec(line);
    if (top) {
      raw[top[1]] = ['traits', 'history'].includes(top[1]) ? parseList(top[2]) : scalar(top[2]);
      section = 'profile';
      continue;
    }
    const group = /^  (policy|rules|omissions):\s*$/u.exec(line);
    if (group) { section = group[1]; currentType = null; continue; }
    if (section === 'policy') {
      const item = /^    (required|recommended|onDemand|disabled):\s*(.*)$/u.exec(line);
      if (item) raw.policy[item[1]] = parseList(item[2]);
    } else if (section === 'rules') {
      const type = /^    ([A-Z]{3}):\s*$/u.exec(line);
      if (type) { currentType = type[1]; raw.rules[currentType] = {}; continue; }
      const after = /^      after:\s*(.*)$/u.exec(line);
      if (after && currentType) raw.rules[currentType].after = parseList(after[1]);
    } else if (section === 'omissions') {
      const type = /^    ([A-Z]{3}):\s*$/u.exec(line);
      if (type) { currentType = type[1]; raw.omissions[currentType] = {}; continue; }
      const field = /^      (absorbedBy|sections|reason|notApplicable):\s*(.*)$/u.exec(line);
      if (field && currentType) {
        if (field[1] === 'sections') raw.omissions[currentType].sections = parseList(field[2]);
        else if (field[1] === 'notApplicable') raw.omissions[currentType].notApplicable = scalar(field[2]) === 'true';
        else raw.omissions[currentType][field[1]] = scalar(field[2]);
      }
    }
  }
  return raw;
}

function ordered(values) {
  return Array.from(new Set(values || [])).sort((left, right) => REGULAR_TYPES.indexOf(left) - REGULAR_TYPES.indexOf(right));
}

function normalizePolicy(name, supplied, traits, presets) {
  const table = presets || DEFAULT_POLICIES;
  const base = table[name] || DEFAULT_POLICIES.service;
  const policy = {};
  for (const state of POLICY_STATES) {
    const explicit = supplied && Object.prototype.hasOwnProperty.call(supplied, state);
    policy[state] = ordered(explicit ? parseList(supplied[state]) : base[state]);
  }
  const seen = new Set();
  for (const state of POLICY_STATES) policy[state] = policy[state].filter((type) => REGULAR_TYPES.includes(type) && !seen.has(type) && (seen.add(type), true));
  for (const type of REGULAR_TYPES) if (!seen.has(type)) policy.onDemand.push(type);
  if (!supplied) {
    const promote = (type, state) => {
      for (const current of POLICY_STATES) policy[current] = policy[current].filter((item) => item !== type);
      policy[state].push(type);
    };
    if (traits.includes('ui')) promote('SCR', 'recommended');
    if (traits.includes('data')) promote('MOD', 'recommended');
    if (traits.includes('api')) promote('API', 'recommended');
    if (traits.includes('component')) { promote('ARC', 'recommended'); promote('API', 'recommended'); }
    if (traits.includes('operations')) promote('RUN', 'required');
    if (traits.includes('security-regulation')) { promote('ADR', 'required'); promote('TST', 'required'); }
    if (traits.includes('terminology')) promote('GLS', 'recommended');
  }
  for (const state of POLICY_STATES) policy[state] = ordered(policy[state]);
  return policy;
}

// presets가 오면 팀이 board.json에 정의한 프로필까지 유효한 이름으로 본다. 없으면
// 내장 다섯 개만 남는다. 모르는 이름을 service로 되돌리는 규칙은 그대로 두되, 판단
// 근거를 코드가 아니라 넘겨받은 목록으로 옮긴 것이다.
function normalizeProfile(input, presets) {
  const value = input || {};
  const known = presets ? Object.keys(presets) : PROFILE_NAMES;
  const schemaVersion = value.schemaVersion === 1 ? 1 : 2;
  const name = known.includes(value.name) ? value.name : 'service';
  const traits = Array.from(new Set(parseList(value.traits).filter((trait) => TRAITS.includes(trait)))).sort((left, right) => TRAITS.indexOf(left) - TRAITS.indexOf(right));
  const policy = normalizePolicy(name, value.policy, traits, presets);
  const history = parseList(value.history);
  const result = {
    schemaVersion,
    revision: Number.isInteger(value.revision) && value.revision >= 1 ? value.revision : 1,
    name,
    traits,
    history: history.length ? history : [name],
    policy
  };
  if (schemaVersion === 1) return result;
  result.enforcement = ENFORCEMENTS.includes(value.enforcement) ? value.enforcement : 'checkpoint';
  result.rules = {};
  for (const type of REGULAR_TYPES) {
    const supplied = value.rules && value.rules[type];
    result.rules[type] = { after: ordered(supplied && supplied.after !== undefined ? parseList(supplied.after) : DEFAULT_RULES[type]) };
  }
  result.omissions = {};
  for (const type of policy.disabled) {
    const supplied = value.omissions && value.omissions[type];
    if (supplied && supplied.notApplicable === true) {
      result.omissions[type] = { notApplicable: true, reason: scalar(supplied.reason) };
      continue;
    }
    const fallback = DEFAULT_OMISSIONS[type];
    const active = POLICY_STATES.slice(0, 3).flatMap((state) => policy[state]);
    const absorbedBy = scalar(supplied && supplied.absorbedBy) || (active.includes(fallback.absorbedBy) ? fallback.absorbedBy : active.find((candidate) => candidate !== type));
    result.omissions[type] = {
      absorbedBy,
      sections: parseList(supplied && supplied.sections).length ? parseList(supplied.sections) : fallback.sections.slice()
    };
  }
  return result;
}

function parseDocumentProfile(source, presets) {
  const raw = parseRawProfile(source);
  if (!raw) return null;
  const schemaVersion = Number.parseInt(raw.schemaVersion, 10) || 1;
  return normalizeProfile({
    schemaVersion,
    revision: Number.parseInt(raw.revision, 10) || 1,
    name: raw.name,
    enforcement: raw.enforcement,
    traits: raw.traits,
    history: raw.history,
    policy: raw.policy,
    rules: raw.rules,
    omissions: raw.omissions
  }, presets);
}

function validateDocumentProfile(source, presets) {
  const raw = parseRawProfile(source);
  if (!raw) return { present: false, errors: [], profile: null, status: 'legacy-unconfigured' };
  // 팀이 정의한 프리셋도 유효한 이름이다. 목록을 넘겨받지 못하면 내장 다섯 개만 인정한다.
  const known = presets ? Object.keys(presets) : PROFILE_NAMES;
  const errors = [];
  const schemaVersion = Number.parseInt(raw.schemaVersion, 10);
  if (!Number.isInteger(schemaVersion)) errors.push('documentProfile.schemaVersion이 필요합니다.');
  else if (![1, 2].includes(schemaVersion)) errors.push(`지원하지 않는 documentProfile schemaVersion입니다: ${raw.schemaVersion}`);
  if (!known.includes(raw.name)) errors.push(`지원하지 않는 문서 프로필입니다: ${raw.name || '(없음)'}`);
  for (const trait of raw.traits) if (!TRAITS.includes(trait)) errors.push(`지원하지 않는 project trait입니다: ${trait}`);
  if (raw.revision !== null && (!/^\d+$/u.test(raw.revision) || Number.parseInt(raw.revision, 10) < 1)) errors.push(`documentProfile revision은 1 이상의 정수여야 합니다: ${raw.revision}`);
  // 이력은 지난 기록이라 지금 없는 프리셋 이름이 남아 있을 수 있다. 그것 때문에
  // 계약 전체가 invalid가 되면, 프리셋 하나를 지웠다고 프로젝트가 멈춘다.
  for (const item of raw.history) if (!/^[a-z][a-z0-9-]*$/u.test(item)) errors.push(`documentProfile history에 올바르지 않은 프로필 이름이 있습니다: ${item}`);
  const occurrences = new Map();
  for (const state of POLICY_STATES) {
    if (!Object.prototype.hasOwnProperty.call(raw.policy, state)) { errors.push(`policy.${state}가 없습니다.`); continue; }
    for (const type of raw.policy[state]) {
      if (!REGULAR_TYPES.includes(type)) errors.push(`지원하지 않는 문서 유형입니다: ${type}`);
      occurrences.set(type, (occurrences.get(type) || []).concat(state));
    }
  }
  for (const type of REGULAR_TYPES) if ((occurrences.get(type) || []).length !== 1) errors.push(`${type}은 정확히 하나의 정책 상태에 있어야 합니다.`);
  if (schemaVersion === 2) {
    if (!ENFORCEMENTS.includes(raw.enforcement)) errors.push(`지원하지 않는 enforcement입니다: ${raw.enforcement || '(없음)'}`);
    for (const type of REGULAR_TYPES) {
      if (!raw.rules[type] || !Array.isArray(raw.rules[type].after)) { errors.push(`rules.${type}.after가 없습니다.`); continue; }
      for (const dependency of raw.rules[type].after) {
        if (!REGULAR_TYPES.includes(dependency)) errors.push(`rules.${type}.after에 지원하지 않는 유형이 있습니다: ${dependency}`);
        if (dependency === type) errors.push(`rules.${type}.after는 자기 자신을 참조할 수 없습니다.`);
      }
    }
    for (const type of raw.policy.disabled || []) {
      const omission = raw.omissions[type];
      if (!omission) { errors.push(`omissions.${type}의 생략 처리가 없습니다.`); continue; }
      if (omission.notApplicable === true) {
        if (!scalar(omission.reason)) errors.push(`omissions.${type}.reason이 필요합니다.`);
      } else {
        if (!REGULAR_TYPES.includes(omission.absorbedBy) || omission.absorbedBy === type) errors.push(`omissions.${type}.absorbedBy가 올바르지 않습니다.`);
        const targetStates = (occurrences.get(omission.absorbedBy) || []);
        if (targetStates.includes('disabled')) errors.push(`omissions.${type}.absorbedBy는 비활성 문서일 수 없습니다: ${omission.absorbedBy}`);
        if (!Array.isArray(omission.sections) || omission.sections.length === 0) errors.push(`omissions.${type}.sections가 필요합니다.`);
      }
    }
    for (const type of Object.keys(raw.omissions)) if (!(raw.policy.disabled || []).includes(type)) errors.push(`활성 문서에는 omission을 지정할 수 없습니다: ${type}`);
  }
  const profile = parseDocumentProfile(source, presets);
  let status = errors.length ? 'invalid' : schemaVersion === 1 ? 'migration-required' : 'valid';
  if (Number.isInteger(schemaVersion) && schemaVersion > 2) status = 'unsupported-schema';
  return { present: true, errors: Array.from(new Set(errors)), profile, status };
}

function assertProfileInput(input, presets) {
  const value = input || {};
  const known = presets ? Object.keys(presets) : PROFILE_NAMES;
  if (value.name !== undefined && !known.includes(value.name)) throw new Error(`지원하지 않는 문서 프로필입니다: ${value.name}`);
  if (value.schemaVersion !== undefined && ![1, 2].includes(value.schemaVersion)) throw new Error(`지원하지 않는 documentProfile schemaVersion입니다: ${value.schemaVersion}`);
  if (value.enforcement !== undefined && !ENFORCEMENTS.includes(value.enforcement)) throw new Error(`지원하지 않는 enforcement입니다: ${value.enforcement}`);
  for (const trait of parseList(value.traits)) if (!TRAITS.includes(trait)) throw new Error(`지원하지 않는 project trait입니다: ${trait}`);
  if (value.policy) {
    const seen = new Map();
    for (const state of POLICY_STATES) {
      if (!Object.prototype.hasOwnProperty.call(value.policy, state)) throw new Error(`policy.${state}가 없습니다.`);
      for (const type of parseList(value.policy[state])) {
        if (!REGULAR_TYPES.includes(type)) throw new Error(`지원하지 않는 문서 유형입니다: ${type}`);
        if (seen.has(type)) throw new Error(`${type}이 policy.${seen.get(type)}과 policy.${state}에 중복 지정되었습니다.`);
        seen.set(type, state);
      }
    }
    for (const type of REGULAR_TYPES) if (!seen.has(type)) throw new Error(`${type}의 정책 상태가 없습니다.`);
  }
  const profile = normalizeProfile(value);
  const rendered = renderDocumentProfileUnchecked(profile);
  const validation = validateDocumentProfile(`---\n${rendered}\n---\n`);
  if (validation.errors.length) throw new Error(validation.errors[0]);
}

function renderDocumentProfileUnchecked(profile) {
  const lines = ['documentProfile:', `  schemaVersion: ${profile.schemaVersion}`, `  revision: ${profile.revision}`, `  name: ${profile.name}`];
  if (profile.schemaVersion === 2) lines.push(`  enforcement: ${profile.enforcement}`);
  lines.push(`  traits: [${profile.traits.join(', ')}]`, `  history: [${profile.history.join(', ')}]`, '  policy:');
  for (const state of POLICY_STATES) lines.push(`    ${state}: [${profile.policy[state].join(', ')}]`);
  if (profile.schemaVersion === 2) {
    lines.push('  rules:');
    for (const type of REGULAR_TYPES) lines.push(`    ${type}:`, `      after: [${profile.rules[type].after.join(', ')}]`);
    lines.push('  omissions:');
    for (const type of profile.policy.disabled) {
      const omission = profile.omissions[type];
      lines.push(`    ${type}:`);
      if (omission.notApplicable) lines.push('      notApplicable: true', `      reason: "${omission.reason.replace(/"/g, '\\"')}"`);
      else lines.push(`      absorbedBy: ${omission.absorbedBy}`, `      sections: [${omission.sections.join(', ')}]`);
    }
  }
  return lines.join('\n');
}

function renderDocumentProfile(input) {
  assertProfileInput(input);
  return renderDocumentProfileUnchecked(normalizeProfile(input));
}

function migrateProfile(input) {
  const existing = normalizeProfile(Object.assign({}, input, { schemaVersion: input && input.schemaVersion === 1 ? 1 : 2 }));
  if (existing.schemaVersion === 2) return existing;
  return normalizeProfile({
    schemaVersion: 2,
    revision: existing.revision,
    name: existing.name,
    traits: existing.traits,
    history: existing.history,
    policy: existing.policy,
    enforcement: 'checkpoint'
  });
}

function applyToProject(projectFile, input, presets) {
  assertProfileInput(input, presets);
  const profile = normalizeProfile(input, presets);
  const original = fs.readFileSync(projectFile, 'utf8');
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = (bom ? original.slice(1) : original).replace(/\r\n/g, '\n');
  const block = renderDocumentProfileUnchecked(profile);
  let output = content;
  if (/^documentProfile:\s*$/mu.test(output)) output = output.replace(/^documentProfile:\s*$[\s\S]*?(?=^\S|^---\s*$)/mu, `${block}\n`);
  else if (output.startsWith('---\n')) {
    const end = output.indexOf('\n---\n', 4);
    if (end < 0) throw new Error('project.md frontmatter closing marker가 없습니다.');
    output = `${output.slice(0, end)}\n${block}\n${output.slice(end)}`;
  } else throw new Error('project.md에 YAML frontmatter가 필요합니다.');
  fs.writeFileSync(projectFile, `${bom}${output}`, 'utf8');
  return { file: projectFile, profile };
}

function profileImpact(before, after) {
  const changes = [];
  if (!before) changes.push({ field: 'contract', from: null, to: 'configured' });
  else {
    for (const field of ['name', 'enforcement']) if (before[field] !== after[field]) changes.push({ field, from: before[field], to: after[field] });
    for (const type of REGULAR_TYPES) {
      const oldState = before && POLICY_STATES.find((state) => before.policy[state].includes(type));
      const newState = POLICY_STATES.find((state) => after.policy[state].includes(type));
      if (oldState !== newState) changes.push({ field: `policy.${type}`, from: oldState, to: newState });
      const oldAfter = before && before.rules && before.rules[type] ? before.rules[type].after : [];
      if (JSON.stringify(oldAfter) !== JSON.stringify(after.rules[type].after)) changes.push({ field: `rules.${type}.after`, from: oldAfter, to: after.rules[type].after });
    }
  }
  return changes;
}

function reconfigureProject(projectFile, name, overrides) {
  const source = fs.readFileSync(projectFile, 'utf8');
  const validation = validateDocumentProfile(source);
  const existing = validation.present ? parseDocumentProfile(source) : null;
  const migrated = existing ? migrateProfile(existing) : null;
  const settings = overrides || {};
  const next = normalizeProfile({
    schemaVersion: 2,
    name,
    enforcement: settings.enforcement || (migrated && migrated.enforcement) || 'checkpoint',
    traits: settings.traits || (migrated && migrated.traits) || [],
    policy: settings.policy || undefined,
    rules: settings.rules || (migrated && migrated.rules),
    omissions: settings.omissions || (settings.policy ? undefined : migrated && migrated.omissions),
    revision: existing ? existing.revision + 1 : 1,
    history: existing ? existing.history.concat(name) : [name]
  });
  const impact = profileImpact(migrated, next);
  return Object.assign(applyToProject(projectFile, next), { legacyUnconfigured: !validation.present, migratedFrom: existing && existing.schemaVersion === 1 ? 1 : null, impact });
}

function missingActions(profile, presentTypes) {
  const present = new Set(presentTypes || []);
  return profile.policy.required.filter((type) => !present.has(type)).map((type) => ({
    type,
    command: `rdl doc create ${type} "<제목>" --project <key> --owner <MEMBER-ID> --scope "<단일 책임>" --exclude "<제외 범위>"${['REQ', 'SCR', 'MOD', 'API', 'TST'].includes(type) ? ' --function-id <기능-ID>' : ''}${['REQ', 'SCR', 'MOD', 'API', 'TST', 'RUN'].includes(type) ? ' --related <ARTIFACT-ID>' : ''}`
  }));
}

module.exports = {
  REGULAR_TYPES, PROFILE_NAMES, POLICY_STATES, ENFORCEMENTS, TRAITS, DEFAULT_POLICIES, DEFAULT_RULES, DOCUMENT_SECTION_CATALOG, DEFAULT_OMISSIONS,
  normalizeProfile, assertProfileInput, parseDocumentProfile, validateDocumentProfile, renderDocumentProfile,
  migrateProfile, applyToProject, reconfigureProject, profileImpact, missingActions
};
