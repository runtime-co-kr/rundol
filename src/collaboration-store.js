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

// ── 사람 게이트의 자격 ──────────────────────────────────────────────────────
//
// 승인 자격의 정의는 한 곳에만 둔다. 표면마다 판정을 따로 두면 그중 느슨한 쪽이
// 게이트의 실제 높이가 된다 — 실제로 그랬다: 런의 사람 게이트는 유형·상태·멤버십
// 셋을 다 보는데 문서 승인(approval.js)은 status만 봐서, 에이전트 Client로 정본
// 문서를 승인할 수 있었다. "AI가 쓴 초안과 사람이 책임지는 정본의 경계"를 선언한
// 파일에 그 경계가 없었다.
//
// 자격의 조건은 셋이다: 등록된 human 유형일 것, 활성일 것, 그리고 그 자격을 가진
// 멤버가 이 프로젝트의 활성 멤버일 것. human 자격은 어느 프로젝트에나 등록될 수
// 있으므로 마지막 조건이 없으면 옆 프로젝트의 검토자가 이 프로젝트를 승인한다.
//
// 자리가 여기인 이유는 판정의 주어가 Client이기 때문이다. 판정을 쓰는 쪽은 승인
// 원장(approval.js) · 공유 게이트(state.js) · 보드(board.js) 셋이고, 그중 어느
// 하나에 두면 나머지 둘이 그 하나를 require하게 되어 방향이 뒤집힌다.
function activeMemberIds(members) {
  return new Set((members || []).filter((member) => member.fields && member.fields['상태'] === 'active').map((member) => member.id));
}

// 값만 보는 술어. 목록을 내는 쪽과 한 건을 묻는 쪽이 같은 문장을 쓰게 하려고
// 따로 떼어 둔다 — 조건을 한 줄이라도 다시 적으면 그것이 네 번째 표면이 된다.
function clientIsProjectHuman(client, members) {
  return Boolean(client) && client.type === 'human' && client.status === 'active' && members.has(client.owner);
}

// project.md를 못 읽는 저장소에서는 자격자가 없다고 답한다. 던지면 승인자 목록을
// 곁들이는 화면 전체가 서지 않고, 그때 화면은 "승인할 수 없다"가 아니라 "보드가
// 죽었다"를 보여 준다 — 없는 자격과 못 읽은 명단은 어느 쪽도 승인을 허락하지 않으므로
// 게이트의 높이는 같다.
function projectMembers(start, projectKey) {
  try { return require('./collaboration').readCollaboration(start, projectKey).members; } catch (_) { return []; }
}

/** 이미 읽어 둔 Client·멤버 목록에서 자격자를 고른다. 스냅숏처럼 둘 다 손에 있는 자리용. */
function humanApproversFrom(clients, members) {
  const active = activeMemberIds(members);
  return (clients || []).filter((client) => clientIsProjectHuman(client, active))
    .map((client) => ({ id: client.id, name: client.name, owner: client.owner }));
}

/** 이 프로젝트의 승인 자격자 목록. 런 승인과 문서 승인이 같은 목록을 쓴다. */
function projectHumanApprovers(start, projectKey) {
  let clients = [];
  try { clients = listClients(start).clients; } catch (_) { clients = []; }
  return humanApproversFrom(clients, projectMembers(start, projectKey));
}

/** 이 Client가 자격자인가. 던지지 않는다 — 모르는 것도 자격 없음으로 답한다. */
function isProjectHumanApprover(start, projectKey, clientId) {
  if (!clientId) return false;
  try { return clientIsProjectHuman(getClient(start, clientId), activeMemberIds(projectMembers(start, projectKey))); } catch (_) { return false; }
}

/**
 * 자격이 없으면 왜 없는지까지 말하고 거절한다.
 *
 * 이유를 붙이는 이유는 형식이 아니다. "승인할 수 없습니다"만 돌려주면 사람은
 * 자기 Client가 agent로 등록된 것인지, 비활성인지, 소유 멤버가 이 프로젝트에서
 * 빠진 것인지 알 수 없어 같은 단추를 다시 누른다 — 화면이 그 문장을 그대로 옮기므로
 * 여기서 삼키면 화면에서도 사라진다.
 */
function assertProjectHumanApprover(start, projectKey, client, action) {
  if (clientIsProjectHuman(client, activeMemberIds(projectMembers(start, projectKey)))) return client;
  const id = (client && client.id) || '(없음)';
  const why = !client ? '등록되지 않았습니다'
    : client.type !== 'human' ? `유형이 ${client.type}입니다 — 에이전트가 쓴 초안을 사람이 책임지는 것이 이 관문의 전부입니다`
      : client.status !== 'active' ? `상태가 ${client.status}입니다`
        : `소유 멤버 ${client.owner || '(없음)'}이(가) 이 프로젝트의 활성 멤버가 아닙니다`;
  throw new Error(`활성 human Client만 ${action}할 수 있습니다: ${id}은(는) ${why}.`);
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

module.exports = {
  listClients, getClient, registerClient, setClientStatus, readEvents,
  humanApproversFrom, projectHumanApprovers, isProjectHumanApprover, assertProjectHumanApprover
};
