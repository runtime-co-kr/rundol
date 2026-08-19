'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { config: workspaceSettingsConfig } = require('./settings');
const { LENSES } = require('./instruction-registry');

const ADAPTER_ID = /^[a-z][a-z0-9.-]*$/u;
const CLIENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const LENS_ID = /^[a-z][a-z0-9.-]*$/u;
const PLACEHOLDER = /\{(?:instruction|context|result|operationId)\}/gu;
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'revision', 'sync', 'watch', 'lease', 'adapter', 'adapters', 'verify', 'drive']);
const SINGLETON_KEYS = {
  sync: new Set(['retryBackoffSeconds', 'maxAttempts']),
  watch: new Set(['scanIntervalSeconds', 'remoteIntervalSeconds']),
  lease: new Set(['ttlSeconds', 'renewFactor']),
  adapter: new Set(['timeoutSeconds', 'authorConcurrency']),
  verify: new Set(['defaultAdapter', 'defaultLenses', 'maxConcurrency']),
  drive: new Set(['schedulerClientId'])
};

const DEFAULT_HARNESS_SETTINGS = Object.freeze({
  schemaVersion: 1,
  sync: Object.freeze({ retryBackoffSeconds: Object.freeze([1, 2, 4]), maxAttempts: 3 }),
  watch: Object.freeze({ scanIntervalSeconds: 5, remoteIntervalSeconds: null }),
  lease: Object.freeze({ ttlSeconds: 300, renewFactor: 0.5 }),
  // 저작 병렬의 상한. 기본값이 보수적인 이유는 어댑터 하나가 격리 worktree 하나를
  // 쓰기 때문이다 — 상한을 올리면 디스크와 프로세스가 함께 늘어난다.
  adapter: Object.freeze({ timeoutSeconds: 600, authorConcurrency: 2 }),
  adapters: Object.freeze({}),
  // 기본값은 보수적으로 둔다. 빠르게 만드는 것보다 판정자 제공자의 호출 한도를
  // 넘지 않는 것이 우선이다 — 한도를 넘으면 빨라지는 것이 아니라 실패한다.
  verify: Object.freeze({ defaultAdapter: null, defaultLenses: Object.freeze(['satisfaction-v1', 'omission-v1', 'boundary-v1']), maxConcurrency: 2 }),
  drive: Object.freeze({ schedulerClientId: null })
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function parseJsonWithDuplicateCheck(source, file) {
  let offset = 0;
  function fail(message) { throw new Error(`${file}: ${message} (offset ${offset})`); }
  function whitespace() { while (/\s/u.test(source[offset] || '')) offset += 1; }
  function string() {
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset];
      offset += 1;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        try { return JSON.parse(source.slice(start, offset)); } catch (error) { fail(error.message); }
      } else if (character.charCodeAt(0) < 0x20) fail('JSON 문자열에 제어 문자를 사용할 수 없습니다.');
    }
    fail('닫히지 않은 JSON 문자열입니다.');
  }
  function value() {
    whitespace();
    if (source[offset] === '{') return object();
    if (source[offset] === '[') return array();
    if (source[offset] === '"') return string();
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(source.slice(offset));
    if (!match) fail('올바른 JSON 값이 아닙니다.');
    offset += match[0].length;
    return JSON.parse(match[0]);
  }
  function object() {
    const result = {};
    const keys = new Set();
    offset += 1;
    whitespace();
    if (source[offset] === '}') { offset += 1; return result; }
    while (offset < source.length) {
      whitespace();
      if (source[offset] !== '"') fail('객체 키는 문자열이어야 합니다.');
      const key = string();
      if (keys.has(key)) fail(`중복 JSON 키입니다: ${key}`);
      keys.add(key);
      whitespace();
      if (source[offset] !== ':') fail('객체 키 뒤에 콜론이 필요합니다.');
      offset += 1;
      result[key] = value();
      whitespace();
      if (source[offset] === '}') { offset += 1; return result; }
      if (source[offset] !== ',') fail('객체 항목 사이에 쉼표가 필요합니다.');
      offset += 1;
    }
    fail('닫히지 않은 JSON 객체입니다.');
  }
  function array() {
    const result = [];
    offset += 1;
    whitespace();
    if (source[offset] === ']') { offset += 1; return result; }
    while (offset < source.length) {
      result.push(value());
      whitespace();
      if (source[offset] === ']') { offset += 1; return result; }
      if (source[offset] !== ',') fail('배열 항목 사이에 쉼표가 필요합니다.');
      offset += 1;
    }
    fail('닫히지 않은 JSON 배열입니다.');
  }
  const parsed = value();
  whitespace();
  if (offset !== source.length) fail('JSON 문서 뒤에 데이터가 남아 있습니다.');
  return parsed;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}는 객체여야 합니다.`);
}

function exactKeys(value, allowed, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}에 알 수 없는 키가 있습니다: ${key}`);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label}는 ${minimum}-${maximum} 범위의 정수여야 합니다.`);
}

function validateBackoff(sync, label) {
  if (own(sync, 'retryBackoffSeconds')) {
    if (!Array.isArray(sync.retryBackoffSeconds) || sync.retryBackoffSeconds.length < 1 || sync.retryBackoffSeconds.length > 5) throw new Error(`${label}.retryBackoffSeconds는 1-5개 배열이어야 합니다.`);
    let total = 0;
    let previous = 0;
    for (const value of sync.retryBackoffSeconds) {
      integer(value, 1, 60, `${label}.retryBackoffSeconds`);
      if (value <= previous) throw new Error(`${label}.retryBackoffSeconds는 엄격히 증가해야 합니다.`);
      previous = value;
      total += value;
    }
    if (total > 120) throw new Error(`${label}.retryBackoffSeconds 합계는 120 이하여야 합니다.`);
  }
  if (own(sync, 'maxAttempts')) integer(sync.maxAttempts, 1, 5, `${label}.maxAttempts`);
}

function validateAdapter(name, adapter, label) {
  if (!ADAPTER_ID.test(name)) throw new Error(`${label} adapter ID가 올바르지 않습니다: ${name}`);
  assertObject(adapter, `${label}.${name}`);
  if (adapter.enabled === false) {
    exactKeys(adapter, new Set(['enabled']), `${label}.${name}`);
    return;
  }
  exactKeys(adapter, new Set(['command', 'argsTemplate', 'timeoutSeconds', 'enabled']), `${label}.${name}`);
  if (adapter.enabled !== true) throw new Error(`${label}.${name}.enabled는 true 또는 tombstone false여야 합니다.`);
  if (typeof adapter.command !== 'string' || adapter.command.length < 1 || adapter.command.length > 128 || /[\0\r\n]/u.test(adapter.command)) throw new Error(`${label}.${name}.command는 1-128자의 단일 문자열이어야 합니다.`);
  if (!Array.isArray(adapter.argsTemplate) || adapter.argsTemplate.length > 64) throw new Error(`${label}.${name}.argsTemplate은 최대 64개 문자열 배열이어야 합니다.`);
  for (const argument of adapter.argsTemplate) {
    if (typeof argument !== 'string' || argument.length > 2048 || /\0/u.test(argument)) throw new Error(`${label}.${name}.argsTemplate 항목은 0-2048자 문자열이어야 합니다.`);
    const remainder = argument.replace(PLACEHOLDER, '');
    if (/\{[^{}]+\}/u.test(remainder)) throw new Error(`${label}.${name}.argsTemplate에 지원하지 않는 placeholder가 있습니다.`);
  }
  integer(adapter.timeoutSeconds, 1, 3600, `${label}.${name}.timeoutSeconds`);
}

function validateLayer(value, label) {
  exactKeys(value, TOP_LEVEL_KEYS, label);
  if (value.schemaVersion !== 1) throw new Error(`${label}.schemaVersion은 정확히 1이어야 합니다.`);
  integer(value.revision, 1, Number.MAX_SAFE_INTEGER, `${label}.revision`);
  for (const [section, keys] of Object.entries(SINGLETON_KEYS)) if (own(value, section)) exactKeys(value[section], keys, `${label}.${section}`);
  if (own(value, 'sync')) validateBackoff(value.sync, `${label}.sync`);
  if (own(value, 'watch')) {
    if (own(value.watch, 'scanIntervalSeconds')) integer(value.watch.scanIntervalSeconds, 1, 3600, `${label}.watch.scanIntervalSeconds`);
    if (own(value.watch, 'remoteIntervalSeconds') && value.watch.remoteIntervalSeconds !== null) integer(value.watch.remoteIntervalSeconds, 300, 86400, `${label}.watch.remoteIntervalSeconds`);
  }
  if (own(value, 'lease')) {
    if (own(value.lease, 'ttlSeconds')) integer(value.lease.ttlSeconds, 60, 3600, `${label}.lease.ttlSeconds`);
    if (own(value.lease, 'renewFactor') && (typeof value.lease.renewFactor !== 'number' || value.lease.renewFactor < 0.1 || value.lease.renewFactor > 0.9)) throw new Error(`${label}.lease.renewFactor는 0.1-0.9여야 합니다.`);
  }
  if (own(value, 'adapter') && own(value.adapter, 'timeoutSeconds')) integer(value.adapter.timeoutSeconds, 1, 3600, `${label}.adapter.timeoutSeconds`);
  if (own(value, 'adapter') && own(value.adapter, 'authorConcurrency')) integer(value.adapter.authorConcurrency, 1, 8, `${label}.adapter.authorConcurrency`);
  if (own(value, 'adapters')) {
    assertObject(value.adapters, `${label}.adapters`);
    if (Object.keys(value.adapters).length > 32) throw new Error(`${label}.adapters는 최대 32개입니다.`);
    for (const [name, adapter] of Object.entries(value.adapters)) validateAdapter(name, adapter, `${label}.adapters`);
  }
  if (own(value, 'verify')) {
    if (own(value.verify, 'defaultAdapter') && value.verify.defaultAdapter !== null && (typeof value.verify.defaultAdapter !== 'string' || !ADAPTER_ID.test(value.verify.defaultAdapter))) throw new Error(`${label}.verify.defaultAdapter가 올바르지 않습니다.`);
    if (own(value.verify, 'defaultLenses')) {
      const lenses = value.verify.defaultLenses;
      if (!Array.isArray(lenses) || lenses.length < 1 || lenses.length > 16 || lenses.some((lens) => !LENS_ID.test(lens || '') || !Object.prototype.hasOwnProperty.call(LENSES, lens)) || new Set(lenses).size !== lenses.length) throw new Error(`${label}.verify.defaultLenses는 1-16개의 고유 registry ID여야 합니다.`);
    }
    if (own(value.verify, 'maxConcurrency') && (!Number.isSafeInteger(value.verify.maxConcurrency) || value.verify.maxConcurrency < 1 || value.verify.maxConcurrency > 16)) throw new Error(`${label}.verify.maxConcurrency는 1-16의 정수여야 합니다.`);
  }
  if (own(value, 'drive') && own(value.drive, 'schedulerClientId') && value.drive.schedulerClientId !== null && (typeof value.drive.schedulerClientId !== 'string' || !CLIENT_ID.test(value.drive.schedulerClientId))) throw new Error(`${label}.drive.schedulerClientId가 올바르지 않습니다.`);
  return value;
}

function readLayer(file, label) {
  if (!file || !fs.existsSync(file)) return null;
  return validateLayer(parseJsonWithDuplicateCheck(fs.readFileSync(file, 'utf8'), file), label);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeLayer(resolved, sources, layer, sourceName) {
  if (!layer) return;
  for (const section of Object.keys(SINGLETON_KEYS)) {
    if (!own(layer, section)) continue;
    for (const [key, value] of Object.entries(layer[section])) {
      resolved[section][key] = clone(value);
      sources[section][key] = sourceName;
    }
  }
  if (own(layer, 'adapters')) {
    for (const [name, value] of Object.entries(layer.adapters)) {
      resolved.adapters[name] = clone(value);
      sources.adapters[name] = sourceName;
    }
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function finalizeResolved(resolved) {
  validateBackoff(resolved.sync, 'resolved.sync');
  if (resolved.sync.maxAttempts !== resolved.sync.retryBackoffSeconds.length) throw new Error('resolved.sync.maxAttempts는 retryBackoffSeconds 길이와 같아야 합니다.');
  if (resolved.lease.ttlSeconds * resolved.lease.renewFactor < 10) throw new Error('resolved.lease 갱신 주기는 최소 10초여야 합니다.');
  if (Object.keys(resolved.adapters).length > 32) throw new Error('resolved.adapters는 최대 32개입니다.');
  if (resolved.verify.defaultAdapter !== null) {
    const selected = resolved.adapters[resolved.verify.defaultAdapter];
    if (!selected || selected.enabled !== true) throw new Error('verify.defaultAdapter는 활성 resolved adapter를 가리켜야 합니다.');
  }
}

function safeSnapshot(resolved) {
  const adapterRefs = {};
  for (const name of Object.keys(resolved.adapters).sort()) {
    const adapter = resolved.adapters[name];
    adapterRefs[name] = adapter.enabled === false ? { enabled: false } : {
      enabled: true,
      timeoutSeconds: adapter.timeoutSeconds,
      commandDigest: sha256(Buffer.from(adapter.command, 'utf8')),
      argsTemplateDigest: sha256(Buffer.from(canonicalJson(adapter.argsTemplate), 'utf8'))
    };
  }
  return {
    sync: clone(resolved.sync),
    adapter: clone(resolved.adapter),
    lease: clone(resolved.lease),
    verify: clone(resolved.verify),
    adapterRefs
  };
}

function resolveHarnessSettings(input) {
  const workspace = readLayer(input && input.workspaceFile, 'workspace harness.json');
  const project = readLayer(input && input.projectFile, 'project harness.json');
  const resolved = clone(DEFAULT_HARNESS_SETTINGS);
  const sources = {
    sync: { retryBackoffSeconds: 'built-in', maxAttempts: 'built-in' },
    watch: { scanIntervalSeconds: 'built-in', remoteIntervalSeconds: 'built-in' },
    lease: { ttlSeconds: 'built-in', renewFactor: 'built-in' },
    adapter: { timeoutSeconds: 'built-in', authorConcurrency: 'built-in' },
    adapters: {},
    verify: { defaultAdapter: 'built-in', defaultLenses: 'built-in', maxConcurrency: 'built-in' },
    drive: { schedulerClientId: 'built-in' }
  };
  mergeLayer(resolved, sources, workspace, 'workspace');
  mergeLayer(resolved, sources, project, 'project');
  finalizeResolved(resolved);
  const safeResolved = safeSnapshot(resolved);
  return {
    schemaVersion: 1,
    contentHash: sha256(Buffer.from(canonicalJson(safeResolved), 'utf8')),
    ...(workspace ? { workspaceRevision: workspace.revision } : {}),
    ...(project ? { projectRevision: project.revision } : {}),
    safeResolved,
    runtimeResolved: resolved,
    sources,
    files: { workspace: input && input.workspaceFile || null, project: input && input.projectFile || null }
  };
}

function loadHarnessSettings(start, options) {
  const settings = workspaceSettingsConfig(start);
  const project = selectProject(workspaceLayout(start), options && options.project, true);
  return resolveHarnessSettings({
    workspaceFile: settings ? path.join(settings.worktree, 'harness.json') : null,
    projectFile: path.join(project.root, 'harness.json')
  });
}

function retryPolicy(settings) {
  const source = settings && settings.safeResolved ? settings.safeResolved.sync : settings && settings.sync;
  return clone(source || DEFAULT_HARNESS_SETTINGS.sync);
}

module.exports = {
  DEFAULT_HARNESS_SETTINGS,
  parseJsonWithDuplicateCheck,
  validateLayer,
  resolveHarnessSettings,
  loadHarnessSettings,
  retryPolicy
};
