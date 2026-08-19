'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { workspaceLayout, selectProject, yamlValue } = require('./workspace');
const { saveSettings } = require('./settings');
const { runGit } = require('./git');
const { runtimeWorkspace } = require('./runtime');
const eventStore = require('./event-store');

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MEMBER = /^MEMBER-\d{3}$/u;
// human은 자동 실행의 주체가 아니라 책임의 주체다. 이 유형의 전부는 "하네스가
// 쥘 수 없는 자격"이라는 것이고, 그것도 Rundol이 보장하는 게 아니라 등록한
// 사람들이 지키기로 한 약속이다 — 사람을 탐지할 방법은 없으므로 이것은 인증이
// 아니라 귀속이다. 대신 그 자격으로는 자동 실행 명령 자체가 거부된다.
const TYPES = new Set(['device', 'agent', 'service', 'human']);
const CLIENT_FILE = /^client-([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/u;

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function quote(value) {
  return JSON.stringify(String(value));
}

function workspaceStore(start) {
  const layout = workspaceLayout(start);
  if (layout.schemaVersion < 6) throw new Error('Client와 임대 기능은 schemaVersion 6 Workspace가 필요합니다. rdl workspace migrate를 실행하세요.');
  const root = path.join(layout.root, 'projects', 'workspace');
  return { layout, root, clients: path.join(root, 'clients'), events: path.join(root, 'events') };
}

function clientFile(store, id) {
  if (!ID.test(id || '')) throw new Error(`잘못된 Client ID입니다: ${id || '(없음)'}`);
  return path.join(store.clients, `client-${id}.yaml`);
}

function parseClient(file) {
  const source = fs.readFileSync(file, 'utf8');
  return {
    id: yamlValue(source, 'id'), name: yamlValue(source, 'name'), type: yamlValue(source, 'type'),
    owner: yamlValue(source, 'owner'), status: yamlValue(source, 'status'), file
  };
}

function listClients(start) {
  const store = workspaceStore(start);
  if (!fs.existsSync(store.clients)) return { clients: [] };
  const clients = fs.readdirSync(store.clients).filter((name) => CLIENT_FILE.test(name)).sort().map((name) => parseClient(path.join(store.clients, name)));
  return { root: store.layout.root, clients };
}

function getClient(start, id) {
  const store = workspaceStore(start);
  const file = clientFile(store, id);
  if (!fs.existsSync(file)) throw new Error(`등록되지 않은 Client입니다: ${id}`);
  const client = parseClient(file);
  if (client.id !== id) throw new Error(`Client 파일명과 id가 일치하지 않습니다: ${file}`);
  return client;
}

function registerClient(start, input) {
  const store = workspaceStore(start);
  const id = String(input.id || '').trim().toLowerCase();
  const type = String(input.type || '').trim().toLowerCase();
  const owner = String(input.owner || '').trim().toUpperCase();
  if (!TYPES.has(type)) throw new Error('--type <device|agent|service|human>가 필요합니다.');
  if (!MEMBER.test(owner)) throw new Error('--owner <MEMBER-ID>가 필요합니다.');
  if (!String(input.name || '').trim()) throw new Error('--name <Client 이름>이 필요합니다.');
  const file = clientFile(store, id);
  if (fs.existsSync(file)) throw new Error(`이미 등록된 Client입니다: ${id}`);
  // 프로젝트 키와 Client ID가 둘 다 하이픈을 담을 수 있고 샤드 파일명은 하이픈으로
  // 잇는다. 겹치는 짝은 완전히 같은 파일명을 만들어 두 짝의 이벤트가 한 파일에 섞이고,
  // 그때는 파일을 보고 구분할 수 없다 — 이름이 같기 때문이다. 이름을 정하는 지금 막는다.
  {
    const existing = (listClients(start).clients || []).map((client) => client.id);
    const pairs = [];
    for (const project of store.layout.projects || []) for (const clientId of existing.concat([id])) pairs.push({ project: project.key, clientId });
    const collision = require('./event-store').shardPrefixCollision(pairs);
    if (collision) throw new Error(`RDL-EVENT-010: 이 Client ID는 샤드 파일명이 다른 짝과 겹칩니다. ${collision.first.project}+${collision.first.clientId}와 ${collision.second.project}+${collision.second.clientId}가 모두 ${collision.key}를 만듭니다. 하이픈 경계가 다른 ID를 쓰세요.`);
  }
  const now = new Date().toISOString();
  atomicWrite(file, `schemaVersion: 1\nrevision: 1\nid: ${id}\nname: ${quote(input.name)}\ntype: ${type}\nowner: ${owner}\nstatus: active\nregisteredAt: ${quote(now)}\nregisteredBy: ${owner}\n`);
  const saved = saveSettings(store.layout.root);
  return { id, file, status: 'active', commit: saved.commit };
}

function setClientStatus(start, id, status) {
  const store = workspaceStore(start);
  const file = clientFile(store, id);
  if (!fs.existsSync(file)) throw new Error(`등록되지 않은 Client입니다: ${id}`);
  const source = fs.readFileSync(file, 'utf8');
  const current = yamlValue(source, 'status');
  if (current === status) return { id, status, changed: false };
  const revision = Number.parseInt(yamlValue(source, 'revision') || '1', 10) + 1;
  atomicWrite(file, source.replace(/^revision:\s*\d+$/mu, `revision: ${revision}`).replace(/^status:\s*\S+$/mu, `status: ${status}`));
  const saved = saveSettings(store.layout.root);
  return { id, status, changed: true, commit: saved.commit };
}

function projectMember(project, memberId) {
  if (!fs.existsSync(project.charter)) return false;
  return new RegExp(`\\^${memberId}(?:\\s|$)`, 'mu').test(fs.readFileSync(project.charter, 'utf8'));
}

function documentExists(project, documentId) {
  function markdownFiles(root) {
    if (!fs.existsSync(root)) return [];
    if (fs.statSync(root).isFile()) return [root];
    const files = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) files.push(...markdownFiles(target));
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target);
    }
    return files;
  }
  const roots = [project.charter, project.documents];
  for (const root of roots) {
    for (const file of markdownFiles(root)) if (new RegExp(`^id:\\s*["']?${documentId}["']?\\s*$`, 'mu').test(fs.readFileSync(file, 'utf8'))) return true;
  }
  return false;
}

function readEvents(store, scope) {
  return eventStore.readEvents(store.events, 'lease', scope);
}

function activeLeases(events, now) {
  const leases = new Map();
  for (const event of events) {
    if (event.type === 'lease.acquired') leases.set(event.documentId, event);
    else if (event.type === 'lease.renewed' && leases.get(event.documentId)?.leaseId === event.leaseId) leases.set(event.documentId, Object.assign({}, leases.get(event.documentId), event));
    else if (['lease.released', 'lease.force_released', 'lease.conflicted'].includes(event.type) && leases.get(event.documentId)?.leaseId === event.leaseId) leases.delete(event.documentId);
  }
  const at = now || Date.now();
  return Array.from(leases.values()).filter((lease) => Date.parse(lease.expiresAt) > at);
}

function appendLease(start, action, input) {
  const store = workspaceStore(start);
  const project = selectProject(store.layout, input.project, true);
  const client = getClient(start, input.clientId);
  if (client.status !== 'active') throw new Error(`비활성 Client는 임대를 변경할 수 없습니다: ${client.id}`);
  if (!projectMember(project, client.owner)) throw new Error(`${client.owner}는 ${project.key} project.md에 등록된 멤버가 아닙니다.`);
  if (!documentExists(project, input.documentId)) throw new Error(`문서를 찾지 못했습니다: ${input.documentId}`);
  const leases = activeLeases(readEvents(store, project.key));
  const active = leases.find((lease) => lease.documentId === input.documentId);
  if (action === 'acquire' && active) throw new Error(`${input.documentId}은 ${active.clientId}가 임대 중입니다: ${active.expiresAt}`);
  if (action !== 'acquire' && (!active || active.clientId !== client.id)) throw new Error(`${client.id}가 보유한 유효 임대가 없습니다: ${input.documentId}`);
  const now = new Date();
  const leaseId = active ? active.leaseId : `LEASE-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const type = { acquire: 'lease.acquired', renew: 'lease.renewed', release: 'lease.released' }[action];
  const event = {
    schemaVersion: 1, eventId: `EVT-${crypto.randomBytes(10).toString('hex').toUpperCase()}`, type,
    scope: 'project', projectId: project.key, documentId: input.documentId, clientId: client.id,
    memberId: client.owner, leaseId, baseRevision: runGit(['rev-parse', 'HEAD'], { cwd: project.root }).stdout,
    occurredAt: now.toISOString(), expiresAt: action === 'release' ? null : new Date(now.getTime() + 5 * 60 * 1000).toISOString()
  };
  // append와 세그먼트 롤오버는 머신 단위 락으로 직렬화한다 — 같은 client의
  // 동시 CLI 프로세스가 같은 샤드를 두고 경합하는 것은 clientId만으로 막지 못한다.
  const file = eventStore.appendEvent(store.events, 'lease', project.key, client.id, event, {
    lockDirectory: runtimeWorkspace(store.layout.root).locks
  });
  const saved = saveSettings(store.layout.root);
  return { project: project.key, documentId: input.documentId, clientId: client.id, leaseId, type, expiresAt: event.expiresAt, file, commit: saved.commit };
}

function listLeases(start, projectKey) {
  const store = workspaceStore(start);
  const project = selectProject(store.layout, projectKey, true);
  return { project: project.key, leases: activeLeases(readEvents(store, project.key)) };
}

module.exports = { listClients, getClient, registerClient, setClientStatus, appendLease, listLeases, readEvents, activeLeases };
