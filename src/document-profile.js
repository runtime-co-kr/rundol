'use strict';

const fs = require('fs');

const REGULAR_TYPES = ['PRD', 'REQ', 'ARC', 'SCR', 'MOD', 'API', 'ADR', 'TST', 'RUN', 'GLS'];
const PROFILE_NAMES = ['lean', 'product', 'service', 'platform', 'assured'];
const POLICY_STATES = ['required', 'recommended', 'onDemand', 'disabled'];
const TRAITS = ['ui', 'data', 'api', 'component', 'operations', 'security-regulation', 'terminology'];
const DEFAULT_POLICIES = {
  lean: { required: ['PRD', 'REQ'], recommended: ['ARC', 'TST'], onDemand: ['API', 'ADR', 'RUN', 'GLS', 'SCR', 'MOD'], disabled: [] },
  product: { required: ['PRD', 'REQ', 'SCR'], recommended: ['ARC', 'TST'], onDemand: ['MOD', 'ADR', 'API', 'RUN', 'GLS'], disabled: [] },
  service: { required: ['PRD', 'REQ', 'API', 'RUN'], recommended: ['ARC', 'MOD', 'TST'], onDemand: ['SCR', 'ADR', 'GLS'], disabled: [] },
  platform: { required: ['PRD', 'REQ', 'ARC', 'API', 'MOD'], recommended: ['ADR', 'TST', 'RUN'], onDemand: ['SCR', 'GLS'], disabled: [] },
  assured: { required: REGULAR_TYPES.slice(), recommended: [], onDemand: [], disabled: [] }
};

function parseList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const match = /^\[(.*)\]$/.exec(value.trim());
  return (match ? match[1].split(',') : value.split(',')).map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function parseDocumentProfile(source) {
  const text = String(source || '').replace(/^\uFEFF/u, '');
  const result = { schemaVersion: 1, revision: 1, name: 'service', traits: [], history: [], policy: {} };
  const frontmatter = text.startsWith('---\n') ? text.slice(4, text.indexOf('\n---\n', 4)) : text;
  const lines = frontmatter.split(/\r?\n/u);
  let section = null;
  for (const line of lines) {
    const top = /^documentProfile:\s*$/u.test(line);
    if (top) { section = 'profile'; continue; }
    if (section !== 'profile') continue;
    const field = /^  (schemaVersion|revision|name|traits|history):\s*(.*)$/u.exec(line);
    if (field) {
      if (field[1] === 'schemaVersion' || field[1] === 'revision') result[field[1]] = Number.parseInt(field[2], 10) || 1;
      else if (field[1] === 'traits') result.traits = parseList(field[2]);
      else if (field[1] === 'history') result.history = parseList(field[2]);
      else result.name = field[2].trim().replace(/^['"]|['"]$/g, '') || result.name;
      continue;
    }
    const policy = /^  policy:\s*$/u.exec(line);
    if (policy) { section = 'policy'; continue; }
    if (section === 'policy') {
      const item = /^    (required|recommended|onDemand|disabled):\s*(.*)$/u.exec(line);
      if (item) result.policy[item[1]] = parseList(item[2]);
    }
  }
  return normalizeProfile(result);
}

function validateDocumentProfile(source) {
  const text = String(source || '').replace(/\r\n/g, '\n');
  if (!/^documentProfile:\s*$/mu.test(text)) return { present: false, errors: [], profile: null };
  const errors = [];
  const profile = parseDocumentProfile(text);
  const start = text.search(/^documentProfile:\s*$/mu);
  const tail = text.slice(start).split('\n');
  const blockLines = [tail[0]];
  for (const line of tail.slice(1)) {
    if (/^(?:---|[^ \t\r\n][^:]*:)\s*$/u.test(line)) break;
    blockLines.push(line);
  }
  const block = blockLines.join('\n');
  const occurrences = new Map();
  for (const state of POLICY_STATES) {
    const match = new RegExp(`^    ${state}:\\s*(.*)$`, 'mu').exec(block);
    if (!match) {
      errors.push(`policy.${state}가 없습니다.`);
      continue;
    }
    for (const type of parseList(match[1])) {
      if (!REGULAR_TYPES.includes(type)) errors.push(`알 수 없는 문서 유형입니다: ${type}`);
      occurrences.set(type, (occurrences.get(type) || []).concat(state));
    }
  }
  for (const type of REGULAR_TYPES) if ((occurrences.get(type) || []).length !== 1) errors.push(`${type}은(는) 정확히 하나의 정책 상태에 있어야 합니다.`);
  const rawName = /^  name:\s*(.*)$/mu.exec(block);
  if (!rawName || !PROFILE_NAMES.includes(rawName[1].trim())) errors.push(`지원하지 않는 프로필입니다: ${rawName ? rawName[1].trim() : '(없음)'}`);
  const rawSchema = /^  schemaVersion:\s*(\d+)$/mu.exec(block);
  if (!rawSchema || Number.parseInt(rawSchema[1], 10) !== 1) errors.push(`지원하지 않는 documentProfile schemaVersion입니다: ${rawSchema ? rawSchema[1] : '(없음)'}`);
  const rawTraits = /^  traits:\s*(.*)$/mu.exec(block);
  for (const trait of parseList(rawTraits ? rawTraits[1] : '')) if (!TRAITS.includes(trait)) errors.push(`지원하지 않는 project trait입니다: ${trait}`);
  const rawRevision = /^  revision:\s*(.*)$/mu.exec(block);
  if (rawRevision && (!/^\d+$/u.test(rawRevision[1].trim()) || Number.parseInt(rawRevision[1], 10) < 1)) errors.push(`documentProfile revision은 1 이상의 정수여야 합니다: ${rawRevision[1].trim()}`);
  const rawHistory = /^  history:\s*(.*)$/mu.exec(block);
  for (const item of parseList(rawHistory ? rawHistory[1] : '')) if (!PROFILE_NAMES.includes(item)) errors.push(`documentProfile history에 지원하지 않는 프로필이 있습니다: ${item}`);
  return { present: true, errors, profile };
}

function normalizeProfile(input) {
  const value = input || {};
  const name = PROFILE_NAMES.includes(value.name) ? value.name : 'service';
  const base = DEFAULT_POLICIES[name];
  const policy = {};
  for (const state of POLICY_STATES) {
    const supplied = value.policy && Object.prototype.hasOwnProperty.call(value.policy, state);
    policy[state] = (supplied ? parseList(value.policy[state]) : base[state].slice()).sort((left, right) => REGULAR_TYPES.indexOf(left) - REGULAR_TYPES.indexOf(right));
  }
  const seen = new Map();
  for (const state of POLICY_STATES) {
    policy[state] = policy[state].filter((type) => REGULAR_TYPES.includes(type) && !seen.has(type) && (seen.set(type, state), true));
  }
  for (const type of REGULAR_TYPES) if (!seen.has(type)) policy.onDemand.push(type);
  const traits = Array.from(new Set(parseList(value.traits))).sort((left, right) => TRAITS.indexOf(left) - TRAITS.indexOf(right));
  if (!value.policy) {
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
  for (const state of POLICY_STATES) policy[state].sort((left, right) => REGULAR_TYPES.indexOf(left) - REGULAR_TYPES.indexOf(right));
  const history = parseList(value.history);
  return { schemaVersion: 1, revision: Number.isInteger(value.revision) ? value.revision : 1, name, traits, history: history.length ? history : [name], policy };
}

function assertProfileInput(input) {
  const value = input || {};
  if (value.name !== undefined && !PROFILE_NAMES.includes(value.name)) throw new Error(`지원하지 않는 문서 프로필입니다: ${value.name}`);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error(`지원하지 않는 documentProfile schemaVersion입니다: ${value.schemaVersion}`);
  for (const trait of parseList(value.traits)) if (!TRAITS.includes(trait)) throw new Error(`지원하지 않는 project trait입니다: ${trait}`);
  if (!value.policy) return;
  const seen = new Map();
  for (const state of POLICY_STATES) {
    if (!Object.prototype.hasOwnProperty.call(value.policy, state)) throw new Error(`policy.${state}가 없습니다.`);
    for (const type of parseList(value.policy[state])) {
      if (!REGULAR_TYPES.includes(type)) throw new Error(`알 수 없는 문서 유형입니다: ${type}`);
      if (seen.has(type)) throw new Error(`${type}가 policy.${seen.get(type)}와 policy.${state}에 중복 지정되었습니다.`);
      seen.set(type, state);
    }
  }
  for (const type of REGULAR_TYPES) if (!seen.has(type)) throw new Error(`${type}의 정책 상태가 없습니다.`);
}

function renderDocumentProfile(input) {
  assertProfileInput(input);
  const profile = normalizeProfile(input);
  const lines = ['documentProfile:', `  schemaVersion: ${profile.schemaVersion}`, `  revision: ${profile.revision}`, `  name: ${profile.name}`, `  traits: [${profile.traits.join(', ')}]`, `  history: [${profile.history.join(', ')}]`, '  policy:'];
  for (const state of POLICY_STATES) lines.push(`    ${state}: [${profile.policy[state].join(', ')}]`);
  return lines.join('\n');
}

function applyToProject(projectFile, input) {
  assertProfileInput(input);
  const profile = normalizeProfile(input);
  const original = fs.readFileSync(projectFile, 'utf8');
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = (bom ? original.slice(1) : original).replace(/\r\n/g, '\n');
  const block = renderDocumentProfile(profile);
  let output = content;
  if (/^documentProfile:\s*$/mu.test(output)) {
    output = output.replace(/^documentProfile:\s*$[\s\S]*?(?=^\S|^---\s*$)/mu, block);
  } else if (output.startsWith('---\n')) {
    const end = output.indexOf('\n---\n', 4);
    if (end < 0) throw new Error('project.md frontmatter closing marker가 없습니다.');
    output = `${output.slice(0, end)}\n${block}\n${output.slice(end)}`;
  } else throw new Error('project.md에 YAML frontmatter가 필요합니다.');
  fs.writeFileSync(projectFile, `${bom}${output}`, 'utf8');
  return { file: projectFile, profile };
}

function reconfigureProject(projectFile, name, overrides) {
  const source = fs.readFileSync(projectFile, 'utf8');
  const validation = validateDocumentProfile(source);
  const existing = parseDocumentProfile(source);
  const history = validation.present ? existing.history.concat(name) : [name];
  const settings = overrides || {};
  return Object.assign(applyToProject(projectFile, {
    name,
    traits: settings.traits || existing.traits,
    policy: settings.policy,
    revision: validation.present ? existing.revision + 1 : 1,
    history
  }), { legacyUnconfigured: !validation.present });
}

function missingActions(profile, presentTypes) {
  const present = new Set(presentTypes || []);
  return profile.policy.required.filter((type) => !present.has(type)).map((type) => ({
    type,
    command: `rdl doc create ${type} "<제목>" --project <key> --owner <MEMBER-ID>${['REQ', 'SCR', 'MOD', 'API', 'TST', 'RUN'].includes(type) ? ' --related <ARTIFACT-ID>' : ''}`
  }));
}

module.exports = { REGULAR_TYPES, PROFILE_NAMES, POLICY_STATES, TRAITS, DEFAULT_POLICIES, normalizeProfile, assertProfileInput, parseDocumentProfile, validateDocumentProfile, renderDocumentProfile, applyToProject, reconfigureProject, missingActions };
