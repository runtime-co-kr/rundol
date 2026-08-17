'use strict';

// 문서 정체성. ADR-009가 정한 대로 문서를 가리키는 키를 조율 없는 짧은 식별자로
// 두고, 번호와 제목은 표시로 내린다.
//
// 지금은 순차 번호 하나가 파일 이름·조인 키·사람이 읽는 이름을 겸한다. 그래서
// 번호를 다시 매기면 그것을 가리키던 모든 연결이 깨지고, 번호를 안전하게 나눠
// 주려면 문서를 하나 만들 때마다 원격에 예약을 밀어 넣어야 한다 — Rundol에 남은
// 유일한 원격 조율 지점이다.
//
// 식별자는 내용 해시가 아니라 난수다. 내용 해시는 문서를 고칠 때마다 정체성이
// 바뀌므로 키가 될 수 없다. 길이는 로그가 아니라 사람이 명령줄과 변경 이력에서
// 읽는 값이라는 점을 고려해 짧게 잡고, 남는 충돌 가능성은 조용한 손상이 아니라
// 검사 진단으로 드러낸다.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Crockford base32: 눈으로 헷갈리는 I·L·O·U를 뺀다. 8자 = 40비트로, 프로젝트
// 범위(문서 수백·태스크 수천)에서 충돌 확률이 0.001% 수준이다.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const UID_LENGTH = 8;
const UID = /^[0-9A-HJKMNP-TV-Z]{8}$/u;
const DOCUMENT_ID = /^([A-Z]{3})-(\d{3,})$/u;

function newDocumentUid() {
  const bytes = crypto.randomBytes(UID_LENGTH);
  let uid = '';
  for (const byte of bytes) uid += ALPHABET[byte % ALPHABET.length];
  return uid;
}

function isDocumentUid(value) {
  return UID.test(String(value || ''));
}

// frontmatter의 uid는 저장값이지만 표시가 아니다 — 사람은 계속 번호와 제목으로
// 읽고, 도구만 이 값으로 조인한다. 파일 이름을 바꾸지 않는 이유가 그것이다.
function documentUid(metadata) {
  const value = metadata && metadata.uid;
  return isDocumentUid(value) ? String(value) : null;
}

// uid는 id 바로 다음 줄에 넣는다. 사람이 frontmatter를 읽을 때 정체성 관련
// 값들이 흩어져 있지 않게 하려는 것이다.
function insertUid(source, uid) {
  const text = String(source || '');
  if (!isDocumentUid(uid)) throw new Error(`문서 식별자 형식이 잘못되었습니다: ${uid || '(없음)'}`);
  const matched = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/u.exec(text);
  if (!matched) throw new Error('frontmatter를 찾지 못했습니다.');
  if (/^uid:\s*\S+/mu.test(matched[2])) return text;
  const newline = matched[1].includes('\r\n') ? '\r\n' : '\n';
  const body = matched[2].replace(/^(id:\s*\S+)$/mu, `$1${newline}uid: ${uid}`);
  const inserted = body === matched[2] ? `uid: ${uid}${newline}${matched[2]}` : body;
  return text.slice(0, matched.index) + matched[1] + inserted + matched[3] + text.slice(matched.index + matched[0].length);
}

// 번호는 이제 표시값이라 조율 없이 로컬 최대값에서 계산한다. 구멍은 표시상의
// 빈칸일 뿐 정체성을 깨뜨리지 않으므로, 원격 왕복을 문서 생성마다 할 이유가 없다.
function localNextNumber(documents, type) {
  let maximum = 0;
  for (const document of documents || []) {
    const matched = DOCUMENT_ID.exec(String(document.id || ''));
    if (matched && matched[1] === type) maximum = Math.max(maximum, Number.parseInt(matched[2], 10) || 0);
  }
  return maximum + 1;
}

function documentIdFor(type, number) {
  if (!/^[A-Z]{3}$/u.test(type || '')) throw new Error(`문서 유형이 잘못되었습니다: ${type || '(없음)'}`);
  if (!Number.isSafeInteger(number) || number < 1 || number > 999) throw new Error(`문서 번호가 범위를 벗어났습니다: ${number}`);
  return `${type}-${String(number).padStart(3, '0')}`;
}

// 충돌은 조용한 손상이 아니라 진단이다. 같은 uid를 가진 문서가 둘이면 조인이
// 갈리므로, 검사가 두 문서를 모두 지목한다.
function duplicateUids(documents) {
  const byUid = new Map();
  for (const document of documents || []) {
    const uid = documentUid(document.metadata || document);
    if (!uid) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(document.id);
  }
  return Array.from(byUid).filter(([, ids]) => ids.length > 1).map(([uid, ids]) => ({ uid, ids: ids.slice().sort() }));
}

// 소급 부여는 문서 내용을 바꾸므로 리비전이 바뀐다 — 곧 기존 승인이 전부 낡는다.
// 그래서 마이그레이션은 명시적 실행이어야 하고, 무엇이 바뀔지 먼저 보여준다.
function planUidMigration(project) {
  const { parseFrontmatter } = require('./frontmatter');
  const { listDocuments } = require('./board-data');
  const pending = [];
  const assigned = new Set();
  for (const document of listDocuments(project)) {
    const file = path.join(project.root, document.file);
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const existing = documentUid(parsed && parsed.data);
    if (existing) { assigned.add(existing); continue; }
    let uid = newDocumentUid();
    while (assigned.has(uid)) uid = newDocumentUid();
    assigned.add(uid);
    pending.push({ id: document.id, file: document.file, uid, revision: document.revision });
  }
  return { project: project.key, pending, assigned: assigned.size };
}

function applyUidMigration(project, plan) {
  const applied = [];
  for (const entry of plan.pending) {
    const file = path.join(project.root, entry.file);
    const source = fs.readFileSync(file, 'utf8');
    const updated = insertUid(source, entry.uid);
    if (updated === source) continue;
    fs.writeFileSync(file, updated, 'utf8');
    applied.push({ id: entry.id, uid: entry.uid, file: entry.file });
  }
  return { project: project.key, applied };
}

function migrateDocumentUids(start, options) {
  const settings = options || {};
  const { workspaceLayout, selectProject } = require('./workspace');
  const project = selectProject(workspaceLayout(start), settings.project, true);
  const plan = planUidMigration(project);
  if (!settings.apply) {
    return Object.assign({ applied: [], planned: plan.pending.length }, plan, {
      note: plan.pending.length ? '식별자 부여는 문서 내용을 바꾸므로 기존 승인이 낡습니다. --apply로 실행하세요.' : '모든 문서에 식별자가 있습니다.'
    });
  }
  return Object.assign({ planned: plan.pending.length }, applyUidMigration(project, plan));
}

module.exports = {
  ALPHABET, UID_LENGTH, UID, newDocumentUid, isDocumentUid, documentUid, insertUid,
  localNextNumber, documentIdFor, duplicateUids, planUidMigration, applyUidMigration, migrateDocumentUids
};
