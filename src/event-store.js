'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  verdict: { flat: false, pattern: new RegExp(`^verdict-(${PART})-(${PART})-(\\d{6})\\.jsonl$`, 'u') },
  driver: { flat: false, runScoped: true, pattern: new RegExp(`^driver-(${PART})-(${PART})-(${RUN_ID})-(\\d{6})\\.jsonl$`, 'u') },
  decision: { flat: false, pattern: new RegExp(`^decision-(${PART})-(${PART})-(\\d{6})\\.jsonl$`, 'u') },
  delegation: { flat: false, pattern: new RegExp(`^delegation-(${PART})-(${PART})-(\\d{6})\\.jsonl$`, 'u') },
  approval: { flat: false, pattern: new RegExp(`^approval-(${PART})-(${PART})-(\\d{6})\\.jsonl$`, 'u') }
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalProjection(event) {
  const projected = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (['canonicalDigest', 'occurredAt', 'localDetail'].includes(key) || value === undefined) continue;
    projected[key] = value;
  }
  return projected;
}

function projectionDigest(event) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalJson(canonicalProjection(event)), 'utf8')).digest('hex');
}

function validateProjection(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('event must be an object');
  if (!event.canonicalDigest) return null;
  if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest)) throw new Error(`invalid canonicalDigest for ${event.eventId || '(missing eventId)'}`);
  const computed = projectionDigest(event);
  if (computed !== event.canonicalDigest) throw new Error(`canonicalDigest mismatch for ${event.eventId || '(missing eventId)'}`);
  return computed;
}

function deduplicateEvents(events) {
  const byId = new Map();
  const result = [];
  for (const event of events) {
    validateProjection(event);
    if (!event.eventId) {
      result.push(event);
      continue;
    }
    const previous = byId.get(event.eventId);
    if (!previous) {
      byId.set(event.eventId, event);
      result.push(event);
      continue;
    }
    if (previous.canonicalDigest && event.canonicalDigest && previous.canonicalDigest === event.canonicalDigest) continue;
    if (!previous.canonicalDigest && !event.canonicalDigest && canonicalJson(canonicalProjection(previous)) === canonicalJson(canonicalProjection(event))) continue;
    throw new Error(`eventId corruption: ${event.eventId}`);
  }
  return result;
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
  // runId 파일 필터: run 스코프 kind는 파일명에 runId가 박혀 있어, 다른 런 샤드의
  // 손상이 이 런의 읽기 경로를 오염시키지 못하게 격리할 수 있다.
  const runFilter = options && options.runId ? `-${options.runId}-` : null;
  if (runFilter && !definition.runScoped) throw new Error(`${kind} events are not run-scoped`);
  const events = [];
  for (const name of fs.readdirSync(directory).filter((value) => value.startsWith(prefix) && definition.pattern.test(value) && (!runFilter || value.includes(runFilter))).sort()) {
    for (const [index, line] of fs.readFileSync(path.join(directory, name), 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (!name.startsWith(shardPrefix(kind, scope, event.clientId))) throw new Error(`${name}:${index + 1}의 clientId가 파일명과 일치하지 않습니다.`);
      if (definition.runScoped && !name.startsWith(shardPrefix(kind, scope, event.clientId, event.runId))) throw new Error(`${name}:${index + 1} runId does not match the shard filename.`);
      events.push(event);
    }
  }
  // dedupe:false는 kind-인지 소비자(run/driver fold)가 검증·dedup·충돌 진단을
  // 단일 정의로 수행하는 경로다 — 원시 레코드를 그대로 돌려준다.
  const unique = options && options.dedupe === false ? events : deduplicateEvents(events);
  if (options && options.sort === 'file') return unique;
  return unique.sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || String(a.eventId).localeCompare(String(b.eventId)));
}

// 프로젝트 키와 Client ID는 둘 다 하이픈을 담을 수 있고 파일명은 하이픈으로 잇는다.
// 그래서 프로젝트 `a` + 클라이언트 `b-c`와 프로젝트 `a-b` + 클라이언트 `c`가 완전히
// 같은 파일명을 만든다. 두 짝의 이벤트가 한 파일에 섞이고, 읽을 때 clientId 대조가
// 시끄럽게 실패하지만 그때는 이미 섞인 뒤다.
//
// 파일을 보고는 구분할 수 없다 — 이름이 같기 때문이다. 그래서 이름을 정하는 자리에서
// 막는다. 파일명 문법을 바꾸면 이미 있는 샤드를 읽던 구버전이 멈추므로 형식은 그대로 둔다.
function shardPrefixCollision(pairs) {
  const seen = new Map();
  for (const { project, clientId } of pairs) {
    const key = `${project}-${clientId}`;
    const previous = seen.get(key);
    if (previous && (previous.project !== project || previous.clientId !== clientId)) return { key, first: previous, second: { project, clientId } };
    seen.set(key, { project, clientId });
  }
  return null;
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
    if (event && event.localDetail !== undefined) throw new Error('localDetail cannot be written to a shared event shard');
    validateProjection(event);
    const definition = kindDefinition(kind);
    const directory = eventsDirectory(eventsRoot, kind);
    if (fs.existsSync(directory) && event.eventId) {
      const prefix = shardPrefix(kind, scope);
      for (const name of fs.readdirSync(directory).filter((value) => value.startsWith(prefix) && definition.pattern.test(value)).sort()) {
        const file = path.join(directory, name);
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean)) {
          const current = JSON.parse(line);
          if (current.eventId !== event.eventId) continue;
          validateProjection(current);
          const same = current.canonicalDigest && event.canonicalDigest
            ? current.canonicalDigest === event.canonicalDigest
            : canonicalJson(canonicalProjection(current)) === canonicalJson(canonicalProjection(event));
          if (!same) throw new Error(`eventId corruption: ${event.eventId}`);
          return file;
        }
      }
    }
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
  const lockName = kind === 'driver'
    ? `append-driver-${scope}-${clientId}-${options && options.runId}`
    : `events-${kind}-${scope}-${options && options.runId ? options.runId : clientId}`;
  return withAppendLock(lockDirectory, lockName, write);
}

module.exports = { shardPrefixCollision, MAX_EVENTS, MAX_BYTES, KINDS, eventsDirectory, canonicalJson, canonicalProjection, projectionDigest, validateProjection, deduplicateEvents, readEvents, selectShard, appendEvent, withAppendLock };
