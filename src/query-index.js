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
const INDEX_VERSION = 3;

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
      // 커밋되지 않은 변경도 입력이다. 상태 목록만으로는 부족하다 — 이미 M으로
      // 표시된 파일을 다시 고치면 상태 줄이 그대로여서 지문이 변하지 않고,
      // 낡은 인덱스가 유효로 판정되어 틀린 답을 자신 있게 내놓는다. 그래서
      // 변경된 파일의 내용까지 지문에 넣는다. 대상은 status가 지목한 파일뿐이라
      // 비용은 작업 중인 파일 수에 비례한다.
      dirty: status.status === 0 ? sha256(dirtyDigest(project.root, status.stdout)) : null
    });
  }
  // 공유 원장은 git 밖에서도 갱신된다(로컬 append 후 아직 커밋 전). 파일 목록과
  // 크기·수정 시각을 지문에 넣어 그 변화를 잡는다.
  inputs.events = eventsFingerprint(path.join(layout.root, 'projects', 'workspace', 'events'));
  return sha256(canonical(inputs));
}

// 상태 목록이 지목한 파일의 내용을 함께 읽는다. 읽을 수 없는 항목(삭제됨,
// 디렉터리)은 경로만 남긴다 — 존재하지 않는다는 사실 자체가 입력이다.
function dirtyDigest(root, porcelain) {
  const entries = [];
  for (const line of String(porcelain || '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const relative = line.slice(3).trim().replace(/^"|"$/gu, '');
    const target = path.join(root, relative.includes(' -> ') ? relative.split(' -> ').pop() : relative);
    let content = null;
    try {
      const stat = fs.statSync(target);
      if (stat.isFile()) content = sha256(fs.readFileSync(target));
    } catch (error) { content = null; }
    entries.push([line, content]);
  }
  return canonical(entries);
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
  const shape = schemaProblem(parsed);
  if (shape) return { status: 'corrupt', fingerprint, index: null, file, reason: shape };
  if (parsed.fingerprint !== fingerprint) return { status: 'stale', fingerprint, index: null, file };
  return { status: 'valid', fingerprint, index: parsed, file };
}

// JSON으로 파싱된다는 것과 쓸 수 있다는 것은 다르다. 형태를 확인하지 않으면
// tasks가 null인 인덱스가 유효로 통과한 뒤 조회에서 터진다 — 캐시 손상이
// 조회 실패가 되면 캐시가 정확성의 조건이 되어버린다.
function schemaProblem(index) {
  if (!index || typeof index !== 'object') return '인덱스가 객체가 아닙니다.';
  if (!Array.isArray(index.tasks)) return 'tasks가 배열이 아닙니다.';
  if (!Array.isArray(index.documents)) return 'documents가 배열이 아닙니다.';
  if (!Array.isArray(index.projects)) return 'projects가 배열이 아닙니다.';
  if (!index.taskCounts || typeof index.taskCounts !== 'object') return 'taskCounts가 객체가 아닙니다.';
  if (index.documentUidByDisplayId && typeof index.documentUidByDisplayId !== 'object') return 'documentUidByDisplayId가 객체가 아닙니다.';
  for (const task of index.tasks) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string' || typeof task.project !== 'string') {
      return '태스크 항목의 형태가 다릅니다.';
    }
  }
  return null;
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

// 조회의 기본 경로는 정본이다. 인덱스는 요청할 때만 쓴다.
//
// 이 저장소에서 실제로 재 보니 정본 경로는 4ms인데 인덱스 유효성 확인만
// 280ms다 — git rev-parse와 git status 두 번의 하위 프로세스가 비용의 전부이고,
// 인덱스가 아끼려던 일(문서 66개를 읽고 접는 것)이 이미 4ms다. 아끼는 것보다
// 확인하는 것이 비싸면 캐시는 가속이 아니라 감속이다.
//
// 그래서 기본값을 되돌린다. 인덱스를 지우지는 않는다 — 정본 읽기 비용은 문서
// 수에 비례해 늘지만 유효성 확인 비용은 늘지 않으므로 언젠가 교차점이 온다.
// 그때 이 기본값을 다시 뒤집으면 되고, 그 판단의 근거는 추측이 아니라 측정이어야
// 한다. 두 경로의 답이 같다는 것은 등가성 시험이 계속 지킨다.
function queryTasks(start, options) {
  const settings = options || {};
  const { listTasks } = require('./agent-context');
  if (settings.index === true && settings.cold !== true) {
    const read = readIndex(start);
    if (read.status === 'valid') {
      // 차수는 필터가 아니라 범위다 — 무인덱스 경로가 그렇게 좁히므로 여기서도 집계
      // 이전에 좁힌다. 두 경로가 갈리면 같은 질문에 다른 답이 나온다.
      const scoped = read.index.tasks.filter((task) => (!settings.project || task.project === settings.project)
        && (settings.round === undefined || settings.round === null || (task.round === undefined ? null : task.round) === settings.round));
      const tasks = scoped.filter((task) => (!settings.kind || (task.kind || 'normal') === settings.kind)
        && (!settings.status || task.status === settings.status)
        && (!settings.open || ['todo', 'doing', 'waiting', 'review'].includes(task.status)));
      // 집계는 선택된 프로젝트 범위에서 세고 상태 필터 이전 값을 쓴다 — 무인덱스
      // 경로가 정확히 그렇게 센다. 여기서 갈리면 같은 응답의 목록과 집계가
      // 서로 다른 질문에 답한다.
      const counts = {};
      const results = {};
      for (const task of scoped) {
        counts[task.status] = (counts[task.status] || 0) + 1;
        if ((task.kind || 'normal') === 'test') {
          const bucket = task.result || (task.status === 'cancelled' ? 'cancelled' : 'pending');
          results[bucket] = (results[bucket] || 0) + 1;
        }
      }
      return { source: 'index', fingerprint: read.fingerprint, root: read.index.builtFrom, projects: settings.project ? [settings.project] : read.index.projects, counts, results, total: scoped.length, tasks };
    }
  }
  return Object.assign({ source: 'cold' }, listTasks(start, settings));
}

module.exports = { INDEX_VERSION, indexFingerprint, buildIndex, readIndex, clearIndex, indexStatus, queryTasks, indexFile };
