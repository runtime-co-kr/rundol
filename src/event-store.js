'use strict';

const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 500;
const MAX_BYTES = 1024 * 1024;
const SEGMENT = /-(\d{6})\.jsonl$/u;
const PART = '[a-z0-9]+(?:-[a-z0-9]+)*';
const RUN_ID = 'RUN-[A-F0-9]{20}';

// kind 등록부가 파일 배치와 파일명 문법의 정본이다.
// lease는 하위 호환을 위해 events/ 평면에 남는다. 새 kind는 events/<kind>/ 아래에 두어
// 구버전 checkWorkspaceStore가 디렉터리를 건너뛰는 성질로 혼합 버전 오진을 차단한다.
const KINDS = {
  lease: { flat: true, pattern: new RegExp(`^lease-(${PART})-(${PART})-(\\d{6})\\.jsonl$`, 'u') },
  run: { flat: false, runScoped: true, pattern: new RegExp(`^run-(${PART})-(${PART})-(${RUN_ID})-(\\d{6})\\.jsonl$`, 'u') },
  verdict: { flat: false, pattern: new RegExp(`^verdict-(${PART})-(${PART})-(\\d{6})\\.jsonl$`, 'u') }
};

function kindDefinition(kind) {
  const definition = KINDS[kind];
  if (!definition) throw new Error(`등록되지 않은 이벤트 종류입니다: ${kind}`);
  return definition;
}

function eventsDirectory(eventsRoot, kind) {
  return kindDefinition(kind).flat ? eventsRoot : path.join(eventsRoot, kind);
}

function shardPrefix(kind, scope, clientId, runId) {
  const base = clientId ? `${kind}-${scope}-${clientId}-` : `${kind}-${scope}-`;
  return runId ? `${base}${runId}-` : base;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// append와 세그먼트 롤오버("읽고→판단→append")를 같은 머신의 동시 프로세스 사이에서 직렬화한다.
// clientId는 실행 주체 단위라 프로세스 경합을 막지 못하므로 파일 시스템 락이 필요하다.
function withAppendLock(lockDirectory, name, action) {
  fs.mkdirSync(lockDirectory, { recursive: true });
  const lock = path.join(lockDirectory, `${name}.lock`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      // Windows에서는 다른 프로세스의 rmdir과 겹친 mkdir이 EEXIST 대신 일시적
      // EPERM/EACCES/ENOENT를 던질 수 있다. 전부 재시도 대상이다.
      if (!['EEXIST', 'EPERM', 'EACCES', 'ENOENT'].includes(error.code)) throw error;
      if (Date.now() > deadline) throw new Error(`이벤트 저장 락을 얻지 못했습니다: ${lock}`);
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > 30000;
      } catch {}
      if (stale) {
        try { fs.rmdirSync(lock); } catch {}
        continue;
      }
      sleep(10);
    }
  }
  try {
    return action();
  } finally {
    try { fs.rmdirSync(lock); } catch {}
  }
}

// 기본 정렬은 occurredAt+eventId 표시용 병합이다(lease 소비자 불변).
// { sort: 'file' }은 파일명·줄 순서 그대로 반환한다 — 단일 작성자 샤드에서는
// 클라이언트 내부 순서의 정본이며, 시계에 의존하지 않는 fold의 입력이 된다.
function readEvents(eventsRoot, kind, scope, options) {
  const definition = kindDefinition(kind);
  const directory = eventsDirectory(eventsRoot, kind);
  if (!fs.existsSync(directory)) return [];
  const prefix = shardPrefix(kind, scope);
  const events = [];
  for (const name of fs.readdirSync(directory).filter((value) => value.startsWith(prefix) && definition.pattern.test(value)).sort()) {
    for (const [index, line] of fs.readFileSync(path.join(directory, name), 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (!name.startsWith(shardPrefix(kind, scope, event.clientId))) throw new Error(`${name}:${index + 1}의 clientId가 파일명과 일치하지 않습니다.`);
      events.push(event);
    }
  }
  if (options && options.sort === 'file') return events;
  return events.sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || String(a.eventId).localeCompare(String(b.eventId)));
}

function selectShard(eventsRoot, kind, scope, clientId, options) {
  const definition = kindDefinition(kind);
  const runId = options && options.runId;
  if (definition.runScoped && !runId) throw new Error(`${kind} 이벤트에는 runId가 필요합니다.`);
  const directory = eventsDirectory(eventsRoot, kind);
  fs.mkdirSync(directory, { recursive: true });
  const prefix = shardPrefix(kind, scope, clientId, runId);
  const files = fs.readdirSync(directory).filter((name) => name.startsWith(prefix) && definition.pattern.test(name)).sort();
  const last = files[files.length - 1];
  if (last) {
    const file = path.join(directory, last);
    const count = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).length;
    if (count < MAX_EVENTS && fs.statSync(file).size < MAX_BYTES) return file;
  }
  const segment = last ? Number.parseInt(SEGMENT.exec(last)[1], 10) + 1 : 1;
  return path.join(directory, `${prefix}${String(segment).padStart(6, '0')}.jsonl`);
}

function appendEvent(eventsRoot, kind, scope, clientId, event, options) {
  const write = () => {
    const file = selectShard(eventsRoot, kind, scope, clientId, options);
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    if (options && options.fsync) {
      const descriptor = fs.openSync(file, 'r+');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    return file;
  };
  const lockDirectory = options && options.lockDirectory;
  if (!lockDirectory) return write();
  return withAppendLock(lockDirectory, `events-${kind}-${scope}-${clientId}`, write);
}

module.exports = { MAX_EVENTS, MAX_BYTES, KINDS, eventsDirectory, readEvents, selectShard, appendEvent, withAppendLock };
