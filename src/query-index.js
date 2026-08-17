'use strict';

// 조회 인덱스. REQ-041의 계약대로 이것은 삭제 가능한 캐시이고, 정확성의 기준은
// 언제나 무인덱스 경로다 — 인덱스는 같은 답을 빠르게 할 뿐 바꾸지 못한다.
//
// 저장 형식은 지금 JSON 스냅숏이다. 캐시이므로 형식이 바뀌면 마이그레이션 없이
// 버리고 다시 만든다. SQLite 같은 것은 실제 병목이 측정된 뒤에 넣는다 — 네이티브
// 의존성이나 런타임 상향은 그때 치를 값이지 지금 치를 값이 아니다.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runGit } = require('./git');

// 형식이 바뀌면 올린다. 낡은 형식은 읽지 않고 버린다.
const INDEX_VERSION = 1;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// 유효성 지문. Rundol의 정본은 하나의 Git HEAD가 아니다 — 프로젝트마다 별도
// worktree가 있고, 커밋되지 않은 작업 내용도 조회 결과에 들어가며, 공유 이벤트
// 원장은 또 다른 입력이다. 그중 하나라도 빠지면 낡은 인덱스가 유효하다고
// 판정되어 인덱스가 틀린 답을 자신 있게 내놓는다.
function indexFingerprint(layout) {
  const inputs = { version: INDEX_VERSION, schemaVersion: layout.schemaVersion, projects: [] };
  for (const project of (layout.projects || []).slice().sort((left, right) => left.key.localeCompare(right.key))) {
    const head = runGit(['rev-parse', 'HEAD'], { cwd: project.root, allowFailure: true });
    const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: project.root, allowFailure: true });
    inputs.projects.push({
      key: project.key,
      head: head.status === 0 ? head.stdout : null,
      // 커밋되지 않은 변경도 입력이다. 내용까지 읽지 않고 상태 목록의 지문만 쓴다 —
      // 파일이 바뀌면 상태 줄이 바뀌므로 낡음을 잡기에 충분하다.
      dirty: status.status === 0 ? sha256(status.stdout) : null
    });
  }
  // 공유 원장은 git 밖에서도 갱신된다(로컬 append 후 아직 커밋 전). 파일 목록과
  // 크기·수정 시각을 지문에 넣어 그 변화를 잡는다.
  inputs.events = eventsFingerprint(path.join(layout.root, 'projects', 'workspace', 'events'));
  return sha256(canonical(inputs));
}

function eventsFingerprint(eventsRoot) {
  if (!fs.existsSync(eventsRoot)) return null;
  const entries = [];
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(target, name); continue; }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(target);
      entries.push([name, stat.size, Math.trunc(stat.mtimeMs)]);
    }
  };
  walk(eventsRoot, '');
  return sha256(canonical(entries));
}

function indexFile(root) {
  const { runtimeWorkspace } = require('./runtime');
  return path.join(runtimeWorkspace(root).state, 'query-index.json');
}

// 인덱스의 내부 키는 문서 고유 식별자다. 번호는 빌드 시점에 식별자로 해석하고
// 저장하지 않는다 — 나중에 번호를 정리해도 인덱스 스키마가 그대로 남는다.
function buildSnapshot(start, layout) {
  const { listTasks } = require('./agent-context');
  const { listDocuments } = require('./board-data');
  const { documentUid } = require('./document-identity');
  const { parseFrontmatter } = require('./frontmatter');
  const documents = [];
  const byDisplayId = {};
  for (const project of layout.projects || []) {
    for (const document of listDocuments(project)) {
      const parsed = parseFrontmatter(fs.readFileSync(path.join(project.root, document.file), 'utf8'));
      const uid = documentUid(parsed && parsed.data);
      documents.push({ uid, id: document.id, project: project.key, type: document.type, title: document.title, file: document.file, revision: document.revision });
      if (uid) byDisplayId[`${project.key}/${document.id}`] = uid;
    }
  }
  const listed = listTasks(start, {});
  return {
    version: INDEX_VERSION,
    documents: documents.sort((left, right) => String(left.id).localeCompare(String(right.id))),
    documentUidByDisplayId: byDisplayId,
    tasks: listed.tasks,
    taskCounts: listed.counts,
    projects: listed.projects
  };
}

function buildIndex(start, options) {
  const settings = options || {};
  const { workspaceLayout } = require('./workspace');
  const layout = workspaceLayout(start);
  const fingerprint = indexFingerprint(layout);
  const snapshot = buildSnapshot(start, layout);
  const index = { fingerprint, builtFrom: layout.root, ...snapshot };
  if (settings.write !== false) {
    const file = indexFile(layout.root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(index)}\n`, 'utf8');
  }
  return index;
}

// 읽기는 절대 던지지 않는다. 손상·형식 불일치·낡음은 전부 "쓸 수 없음"이고,
// 그때 호출자는 무인덱스 경로로 답한다 — 인덱스 실패가 조회 실패가 되면
// 캐시가 정확성의 조건이 되어버린다.
function readIndex(start) {
  const { workspaceLayout } = require('./workspace');
  const layout = workspaceLayout(start);
  const file = indexFile(layout.root);
  const fingerprint = indexFingerprint(layout);
  if (!fs.existsSync(file)) return { status: 'missing', fingerprint, index: null, file };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { status: 'corrupt', fingerprint, index: null, file, reason: error.message }; }
  if (parsed.version !== INDEX_VERSION) return { status: 'outdated', fingerprint, index: null, file };
  if (parsed.fingerprint !== fingerprint) return { status: 'stale', fingerprint, index: null, file };
  return { status: 'valid', fingerprint, index: parsed, file };
}

function clearIndex(start) {
  const { workspaceLayout } = require('./workspace');
  const file = indexFile(workspaceLayout(start).root);
  const existed = fs.existsSync(file);
  if (existed) fs.rmSync(file, { force: true });
  return { file, removed: existed };
}

function indexStatus(start) {
  const read = readIndex(start);
  return {
    file: read.file,
    status: read.status,
    fingerprint: read.fingerprint,
    documents: read.index ? read.index.documents.length : null,
    tasks: read.index ? read.index.tasks.length : null,
    ...(read.reason ? { reason: read.reason } : {})
  };
}

// 조회는 유효한 인덱스가 있으면 그것을 쓰고 없으면 정본을 직접 읽는다. 어느
// 경로로 답했는지를 결과에 남겨, 두 경로가 다른 답을 낸 경우를 사후에 지목할
// 수 있게 한다.
function queryTasks(start, options) {
  const settings = options || {};
  const { listTasks } = require('./agent-context');
  if (settings.cold !== true) {
    const read = readIndex(start);
    if (read.status === 'valid') {
      const tasks = read.index.tasks.filter((task) => (!settings.project || task.project === settings.project)
        && (!settings.status || task.status === settings.status)
        && (!settings.open || ['todo', 'doing', 'waiting', 'review'].includes(task.status)));
      return { source: 'index', fingerprint: read.fingerprint, root: read.index.builtFrom, projects: settings.project ? [settings.project] : read.index.projects, counts: read.index.taskCounts, total: read.index.tasks.length, tasks };
    }
  }
  return Object.assign({ source: 'cold' }, listTasks(start, settings));
}

module.exports = { INDEX_VERSION, indexFingerprint, buildIndex, readIndex, clearIndex, indexStatus, queryTasks, indexFile };
