'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject, yamlValue } = require('./workspace');
const { saveSettings } = require('./settings');
const eventStore = require('./event-store');

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MEMBER = /^MEMBER-\d{3}$/u;
// human은 자동 실행의 주체가 아니라 책임의 주체다. 이 유형의 전부는 "하네스가
// 쥘 수 없는 자격"이라는 것이고, 그것도 Rundol이 보장하는 게 아니라 등록한
// 사람들이 지키기로 한 약속이다 — 사람을 탐지할 방법은 없으므로 이것은 인증이
// 아니라 귀속이다. 대신 그 자격으로는 자동 실행 명령 자체가 거부된다.
const TYPES = new Set(require('./vocabulary').CLIENT_TYPES);
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
  if (layout.schemaVersion < 6) throw new Error('Client 기능은 schemaVersion 6 Workspace가 필요합니다. rdl workspace migrate를 실행하세요.');
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

// 문서 편집 소프트 리스의 획득·갱신·해제와 그 접기는 ADR-015로 폐기했다. 중앙
// 권위 없이 만료 시각에 기대는 배타는 보장이 아니라 조언이었고, 조언을 보장처럼
// 다루느라 만료·회수·자기 임대 이어받기 같은 예외를 계속 쌓고 있었다. 임대 획득의
// 사전조건이던 멤버 확인과 문서 존재 확인도 부르는 곳이 없어져 함께 걷어냈다.
//
// 이미 쌓인 이벤트는 지우지 않는다. 지난 기록을 고쳐 쓰지 않는 것이 이 제품의
// 원칙이며, event-store가 그 샤드를 계속 읽을 수 있게 둔다. 다만 새로 쓰지 않으므로
// 여기서는 읽기 함수만 남긴다.
function readEvents(store, scope) {
  return eventStore.readEvents(store.events, 'lease', scope);
}

module.exports = { listClients, getClient, registerClient, setClientStatus, readEvents };
