'use strict';

// 태스크 식별자 이관. 옛 식별자는 `TASK-` 다음에 26자가 붙어 사람이 옮겨 적을 수
// 없었고, 그 길이는 저장하는 작업이 어느 태스크의 일인지 밝히도록 요구하는 순간
// 곧바로 문제가 된다 — 칠 수 없는 식별자를 요구하는 통제는 우회된다.
//
// 이관은 전부 성공하거나 아무것도 바꾸지 않는다. 태스크만 바꾸고 참조를 남기면
// 연결이 끊기고, 그 상태는 어느 쪽도 아닌 채로 남는다.

const fs = require('fs');
const path = require('path');
const { newDocumentUid } = require('./document-identity');

const LEGACY = /^TASK-[A-Z0-9]{20,32}$/u;
const SHORT = /^TASK-[0-9A-HJKMNP-TV-Z]{8}$/u;

function isLegacyTaskId(value) {
  return LEGACY.test(String(value || '')) && !SHORT.test(String(value || ''));
}

// 옛 식별자에서 새 식별자로 가는 표. 새 식별자끼리도, 남아 있는 옛 식별자와도
// 겹치지 않아야 한다.
function planTaskIdMigration(taskIds) {
  const taken = new Set(taskIds);
  const plan = new Map();
  for (const id of taskIds.slice().sort()) {
    if (!isLegacyTaskId(id)) continue;
    let next;
    do { next = `TASK-${newDocumentUid()}`; } while (taken.has(next));
    taken.add(next);
    plan.set(id, next);
  }
  return plan;
}

function listFiles(directory, extension) {
  const found = [];
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, extension));
    else if (entry.isFile() && full.toLowerCase().endsWith(extension)) found.push(full);
  }
  return found;
}

// 치환은 파일 내용의 문자열 교체다. 옛 식별자는 26자 고유 문자열이라 다른 것과
// 겹치지 않으므로, 태스크 샤드든 문서 본문이든 같은 방법으로 안전하게 바뀐다.
// 산문 속 참조까지 함께 바꾸는 이유는, 태스크만 바꾸면 그 참조가 없는 태스크를
// 가리키게 되기 때문이다.
function rewriteFile(file, plan) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [from, to] of plan) {
    if (after.includes(from)) after = after.split(from).join(to);
  }
  return after === before ? null : after;
}

function migrateTaskIds(projectRoot, options) {
  const settings = options || {};
  const taskDirectory = path.join(projectRoot, 'tasks');
  const legacyFile = path.join(projectRoot, 'tasks.json');
  const shards = fs.existsSync(taskDirectory) ? listFiles(taskDirectory, '.json') : [];
  const stores = shards.length ? shards : (fs.existsSync(legacyFile) ? [legacyFile] : []);
  if (!stores.length) return { migrated: 0, files: [], plan: {} };

  const ids = [];
  for (const file of stores) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    ids.push(...Object.keys(parsed.tasks || {}));
  }
  const plan = planTaskIdMigration(ids);
  if (!plan.size) return { migrated: 0, files: [], plan: {} };

  // 태스크 저장소와, 태스크를 가리키는 문서를 함께 모은다. 한쪽만 바꾸면 연결이 끊긴다.
  const candidates = stores.concat(listFiles(path.join(projectRoot, 'docs'), '.md'));
  const writes = [];
  for (const file of candidates) {
    const next = rewriteFile(file, plan);
    if (next !== null) writes.push([file, next]);
  }
  if (settings.dryRun) {
    return { migrated: plan.size, files: writes.map(([file]) => path.relative(projectRoot, file).split(path.sep).join('/')), plan: Object.fromEntries(plan) };
  }

  // 전부 성공하거나 아무것도 바꾸지 않는다. 쓰기 도중 실패하면 이미 쓴 것을 되돌린다.
  const originals = new Map();
  try {
    for (const [file, next] of writes) {
      originals.set(file, fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, next, 'utf8');
    }
  } catch (error) {
    for (const [file, before] of originals) {
      try { fs.writeFileSync(file, before, 'utf8'); } catch (_) {}
    }
    throw error;
  }
  return { migrated: plan.size, files: writes.map(([file]) => path.relative(projectRoot, file).split(path.sep).join('/')), plan: Object.fromEntries(plan) };
}

module.exports = { isLegacyTaskId, planTaskIdMigration, migrateTaskIds };
