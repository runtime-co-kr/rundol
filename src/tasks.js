'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TASKS_PER_SHARD = 500;

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function normalizeClientId(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized.length > 64) throw new Error(`잘못된 Rundol client ID입니다: ${value || '(없음)'}`);
  return normalized;
}

function clientId(root, preferred) {
  if (preferred) return normalizeClientId(preferred);
  const file = path.join(root, '.rundol', 'state', 'client-id');
  if (fs.existsSync(file)) return normalizeClientId(fs.readFileSync(file, 'utf8'));
  const generated = normalizeClientId(`${process.env.COMPUTERNAME || process.env.HOSTNAME || 'client'}-${crypto.randomBytes(5).toString('hex')}`);
  atomicWrite(file, `${generated}\n`);
  return generated;
}

function shardFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const client of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!client.isDirectory() || client.name.startsWith('.')) continue;
    const clientRoot = path.join(directory, client.name);
    for (const entry of fs.readdirSync(clientRoot, { withFileTypes: true })) {
      if (entry.isFile() && /^\d{6}\.json$/u.test(entry.name)) files.push(path.join(clientRoot, entry.name));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function parseDocument(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)) throw new Error(`${file}의 tasks는 객체여야 합니다.`);
  return parsed;
}

function readTaskStore(target) {
  if (!target || !fs.existsSync(target)) return { schemaVersion: 3, tasks: {}, sources: {} };
  if (fs.statSync(target).isFile()) {
    const parsed = parseDocument(target);
    return { schemaVersion: parsed.schemaVersion || 1, tasks: parsed.tasks, sources: Object.fromEntries(Object.keys(parsed.tasks).map((id) => [id, target])) };
  }
  const tasks = {};
  const sources = {};
  for (const file of shardFiles(target)) {
    const parsed = parseDocument(file);
    for (const [id, task] of Object.entries(parsed.tasks)) {
      if (Object.prototype.hasOwnProperty.call(tasks, id)) throw new Error(`중복 태스크 ID가 여러 샤드에 있습니다: ${id}`);
      tasks[id] = task;
      sources[id] = file;
    }
  }
  return { schemaVersion: 3, tasks, sources };
}

function nextShard(directory, id, maxItems) {
  const clientRoot = path.join(directory, normalizeClientId(id));
  fs.mkdirSync(clientRoot, { recursive: true });
  const files = fs.readdirSync(clientRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{6}\.json$/u.test(entry.name))
    .map((entry) => path.join(clientRoot, entry.name))
    .sort();
  const last = files[files.length - 1];
  if (last) {
    const parsed = parseDocument(last);
    if (Object.keys(parsed.tasks).length < maxItems) return { file: last, document: parsed };
  }
  const number = last ? Number.parseInt(path.basename(last, '.json'), 10) + 1 : 1;
  return {
    file: path.join(clientRoot, `${String(number).padStart(6, '0')}.json`),
    document: { schemaVersion: 1, clientId: normalizeClientId(id), segment: number, tasks: {} }
  };
}

function createTaskInStore(target, root, taskId, task, preferredClientId, maxItems) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    const original = fs.readFileSync(target, 'utf8');
    const document = JSON.parse(original);
    document.tasks = document.tasks || {};
    document.tasks[taskId] = task;
    atomicWrite(target, canonicalJson(document));
    return { file: target, original, clientId: null };
  }
  const id = clientId(root, preferredClientId);
  const selected = nextShard(target, id, maxItems || MAX_TASKS_PER_SHARD);
  const original = fs.existsSync(selected.file) ? fs.readFileSync(selected.file, 'utf8') : null;
  selected.document.tasks[taskId] = task;
  atomicWrite(selected.file, canonicalJson(selected.document));
  return { file: selected.file, original, clientId: id };
}

function updateTaskInStore(target, taskId, task) {
  const store = readTaskStore(target);
  const file = store.sources[taskId];
  if (!file) throw new Error(`태스크를 찾지 못했습니다: ${taskId}`);
  const original = fs.readFileSync(file, 'utf8');
  const document = JSON.parse(original);
  document.tasks[taskId] = task;
  atomicWrite(file, canonicalJson(document));
  return { file, original };
}

function restoreStoreWrite(change) {
  if (change.original === null) {
    if (fs.existsSync(change.file)) fs.unlinkSync(change.file);
  } else atomicWrite(change.file, change.original);
}

function materializeTaskStore(target, projection) {
  const store = readTaskStore(target);
  atomicWrite(projection, canonicalJson({ schemaVersion: 3, generated: true, tasks: store.tasks }));
  return { projection, tasks: Object.keys(store.tasks).length };
}

function migrateTaskStore(legacyFile, directory, root, preferredClientId, maxItems) {
  if (!fs.existsSync(legacyFile)) throw new Error(`마이그레이션할 tasks.json이 없습니다: ${legacyFile}`);
  if (fs.existsSync(directory) && shardFiles(directory).length > 0) throw new Error(`태스크 샤드 경로가 비어 있지 않습니다: ${directory}`);
  const document = parseDocument(legacyFile);
  const id = clientId(root, preferredClientId);
  const entries = Object.entries(document.tasks);
  const size = maxItems || MAX_TASKS_PER_SHARD;
  for (let offset = 0; offset < entries.length; offset += size) {
    const segment = Math.floor(offset / size) + 1;
    const tasks = Object.fromEntries(entries.slice(offset, offset + size));
    atomicWrite(path.join(directory, id, `${String(segment).padStart(6, '0')}.json`), canonicalJson({ schemaVersion: 1, clientId: id, segment, tasks }));
  }
  if (entries.length === 0) atomicWrite(path.join(directory, id, '000001.json'), canonicalJson({ schemaVersion: 1, clientId: id, segment: 1, tasks: {} }));
  return { clientId: id, tasks: entries.length, shards: Math.max(1, Math.ceil(entries.length / size)), directory };
}

module.exports = {
  MAX_TASKS_PER_SHARD,
  clientId,
  readTaskStore,
  shardFiles,
  createTaskInStore,
  updateTaskInStore,
  restoreStoreWrite,
  materializeTaskStore,
  migrateTaskStore
};
