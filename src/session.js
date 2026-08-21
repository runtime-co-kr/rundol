'use strict';

// 세션 작업 공간. 한 기계에서 여러 AI 세션이 같은 저장소를 동시에 고칠 때 나뉘어야
// 하는 것은 경로가 아니라 index와 HEAD다.
//
// 경로를 아무리 잘 나눠도 `git add <내 파일>`은 그 파일에 들어 있는 남의 줄까지
// 함께 스테이지한다 — 한 작업 트리의 index가 하나이기 때문이다. 그래서 "누가 무엇을
// 고치는가"를 나누는 것으로는 커밋 혼입이 막히지 않는다. worktree는 index와 HEAD를
// 세션마다 하나씩 준다.
//
// 브랜치 이름에 세션 식별자를 박는 이유는 추적이다. 커밋이 어느 세션의 일이었는지는
// 주석이 아니라 브랜치가 답해야 한다 — 주석은 파일에 누적되고 같은 줄에서 충돌하지만,
// 브랜치는 이력에 한 번 남고 병합과 함께 사라진다. 그리고 브랜치가 서면 태스크 결박이
// 따라온다(src/state.js의 파생 사다리가 브랜치로 작업 묶음을 찾는다).
//
// 목록은 저장하지 않고 계산한다. `git worktree list`가 이미 정본이므로 따로 적으면
// 두 곳이 같은 사실을 다르게 말하는 날이 온다.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runGit } = require('./git');
const { assertBranchName } = require('./workset');
const { runtimeWorkspace, acquireProcessLock, readProcessLock, processIsAlive } = require('./runtime');

const BRANCH_PREFIX = 'session/';
// 짧게 쓰는 이유는 매일 보는 이름이기 때문이다. 8자리 16진수는 한 기계에서 동시에
// 도는 세션 수에 비해 충분히 넓고, 좁더라도 조용히 실패하지 않는다 — 같은 이름의
// 브랜치가 이미 있으면 git이 거부한다.
const SHORT_LENGTH = 8;
// 호스트가 자기 세션 식별자를 어디에 두는지는 호스트마다 다르다. Rundol이 호스트별
// 변수 이름을 알아야 하면 클라이언트가 늘 때마다 이 파일이 바뀐다. 그래서 중립 변수를
// 먼저 보고, 확인된 호스트만 뒤에 둔다 — 새 클라이언트는 어댑터가 RUNDOL_SESSION_ID를
// 채우면 이 목록을 건드리지 않고 붙는다.
const SESSION_ENV = ['RUNDOL_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'];
// 세션이 살아 있는지는 그 세션을 띄운 프로세스가 답한다. rdl은 명령마다 죽으므로
// 자기 pid로는 아무것도 못 말한다 — 호스트가 알려주는 클라이언트 pid를 받아야
// "이 세션이 지금 붙어 있는가"가 성립한다. 식별자와 같은 이유로 중립 변수가 앞이다.
const SESSION_PID_ENV = ['RUNDOL_SESSION_PID', 'CLAUDE_PID'];
const LOCK_KIND = 'session';

function normalizeSessionId(value) {
  const normalized = String(value === undefined || value === null ? '' : value)
    .trim().toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!normalized || normalized.length > 128) throw new Error(`잘못된 세션 식별자입니다: ${value || '(없음)'}`);
  return normalized;
}

function shortSessionId(sessionId) {
  const compact = normalizeSessionId(sessionId).replace(/-/gu, '');
  if (!compact) throw new Error(`세션 식별자에서 이름을 만들 수 없습니다: ${sessionId}`);
  return compact.slice(0, SHORT_LENGTH);
}

// 호스트가 주면 받고, 없으면 만든다. 만드는 쪽이 있어야 사람이 손으로 쓸 때도 같은
// 명령이 동작한다 — 호스트 안에서만 되는 명령은 문서로 설명할 수 없다.
function resolveSessionId(preferred) {
  if (preferred) return { sessionId: normalizeSessionId(preferred), source: 'argument' };
  for (const name of SESSION_ENV) {
    if (process.env[name]) return { sessionId: normalizeSessionId(process.env[name]), source: name };
  }
  return { sessionId: crypto.randomBytes(8).toString('hex'), source: 'generated' };
}

function sessionBranch(short) {
  const branch = `${BRANCH_PREFIX}${short}`;
  assertBranchName(branch);
  return branch;
}

// 세션의 생존을 대신 말해 줄 프로세스. 없으면 없다고 답한다 — rdl 자신의 pid로
// 채우면 명령이 끝나는 순간 죽은 세션이 되고, 그것은 "모른다"를 "죽었다"로 바꿔
// 적는 일이다.
function resolveSessionPid() {
  for (const name of SESSION_PID_ENV) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (Number.isSafeInteger(value) && value > 0) return { pid: value, source: name };
  }
  return { pid: null, source: null };
}

function sessionLockFile(root, short) {
  return path.join(runtimeWorkspace(root).locks, `${LOCK_KIND}-${short}.lock`);
}

// 등록은 새 저장 형식을 만들지 않는다. 잠금 디렉터리가 이미 "누가 무엇을 쥐고 있는가"를
// pid와 함께 적는 자리이고, 세션 등록이 묻는 것도 같은 물음이다.
//
// 놓지 않고 남긴다. 세션은 명령보다 오래 살아야 하기 때문이며, 그 세션이 죽으면 pid
// 생존 확인이 대신 회수한다 — 사람이 손으로 풀어야 하는 상태를 만들지 않는다.
function registerSession(root, short, pid) {
  if (!pid) return { registered: false, reason: 'no-session-pid' };
  const workspace = runtimeWorkspace(root);
  try {
    acquireProcessLock(workspace.locks, { kind: LOCK_KIND, projectId: short, workspaceId: workspace.id, pid });
    return { registered: true, pid };
  } catch (error) {
    if (!error || error.code !== 'RDL_PROCESS_LOCKED') throw error;
    // 같은 세션이 다시 등록하는 것은 실패가 아니다. 다른 pid가 쥐고 있다면 같은 짧은
    // 이름을 쓰는 다른 세션이므로, 덮지 않고 누가 쥐고 있는지 말한다.
    const holder = error.lock && error.lock.pid;
    return holder === pid ? { registered: true, pid } : { registered: false, reason: 'held-by-other', pid: holder || null };
  }
}

// 등록되지 않은 세션과 죽은 세션은 다르다. 앞엣것은 이 명령을 지나지 않은 것이고
// 뒤엣것은 지났다가 끝난 것이다. null과 false로 갈라 적는다 — 하나로 접으면 worktree만
// 만들고 등록하지 않은 세션이 죽은 세션으로 읽힌다.
function sessionLiveness(root, short) {
  const file = sessionLockFile(root, short);
  if (!fs.existsSync(file)) return { pid: null, alive: null };
  let record;
  try { record = readProcessLock(file); } catch (_) { return { pid: null, alive: null }; }
  return { pid: record.pid, alive: processIsAlive(record.pid) };
}

function releaseSession(root, short) {
  try { fs.unlinkSync(sessionLockFile(root, short)); return true; } catch (_) { return false; }
}

// worktree 목록의 첫 블록이 본 저장소다. 세션 worktree 안에서 이 명령을 부를 수 있으므로
// gitRoot로는 안 된다 — 그러면 세션 worktree가 자기 자신을 본체로 알고 그 아래에 또
// 만든다.
function worktreeBlocks(start) {
  const output = runGit(['worktree', 'list', '--porcelain'], { cwd: start }).stdout;
  if (!output) return [];
  return output.split(/\r?\n\r?\n/u).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/u);
    const worktree = lines.find((line) => line.startsWith('worktree '));
    const branch = lines.find((line) => line.startsWith('branch refs/heads/'));
    const head = lines.find((line) => line.startsWith('HEAD '));
    return {
      path: worktree ? path.resolve(worktree.slice('worktree '.length).trim()) : null,
      branch: branch ? branch.slice('branch refs/heads/'.length).trim() : null,
      head: head ? head.slice('HEAD '.length).trim() : null,
      detached: lines.includes('detached')
    };
  });
}

function mainWorktree(start) {
  const blocks = worktreeBlocks(start);
  if (!blocks.length || !blocks[0].path) throw new Error('Git worktree 목록을 읽지 못했습니다.');
  return blocks[0].path;
}

function sameFile(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function defaultTarget(root, short) {
  // 저장소 안에 두지 않는다. 안에 두면 추적 제외를 따로 걸어야 하고, 그 규칙을 빠뜨린
  // 한 번에 세션 트리 전체가 커밋된다. 형제로 두면 그 실수가 불가능하다.
  return path.join(path.dirname(root), `${path.basename(root)}-${short}`);
}

function entry(sessionId, short, branch, target, base) {
  return { sessionId, short, branch, path: target, base: base || null };
}

// 등록 결과는 평평하게 싣는다. 사람이 읽는 출력이 중첩 객체를 통째로 건너뛰므로,
// 등록하지 못했다는 사실이 --json에서만 보이게 된다.
function registration(result, pid) {
  return {
    registered: result.registered,
    sessionPid: result.pid === undefined ? pid.pid : result.pid,
    sessionPidSource: pid.source,
    registerSkipped: result.registered ? null : result.reason
  };
}

/**
 * 세션의 작업 공간을 연다. 이미 열려 있으면 다시 만들지 않고 그 자리를 알려준다 —
 * 세션은 끊겼다 이어지므로, 두 번째 호출이 실패하면 이어붙이는 쪽이 상태를 따로
 * 기억해야 한다.
 */
function startSession(start, options) {
  const settings = options || {};
  const root = mainWorktree(start);
  const resolved = resolveSessionId(settings.sessionId);
  const short = shortSessionId(resolved.sessionId);
  const branch = sessionBranch(short);
  const target = settings.path ? path.resolve(settings.path) : defaultTarget(root, short);

  const existing = worktreeBlocks(start).find((item) => item.branch === branch || (item.path && sameFile(item.path, target)));
  if (existing) {
    // 같은 세션이 다시 부른 것과 남의 자리를 덮으려는 것은 다르다. 짝이 어긋나면
    // 만들지 않고 말한다 — 여기서 --force로 밀면 브랜치 하나가 두 작업 트리에
    // 체크아웃되고, 그때부터 한쪽의 커밋이 다른 쪽 HEAD를 조용히 옮긴다.
    if (existing.branch !== branch) throw new Error(`그 경로는 다른 브랜치의 worktree입니다: ${existing.path} (${existing.branch || 'detached'})`);
    // 자리를 지정하지 않았으면 이미 열린 자리가 답이다. 기본 경로와 다르다는 이유로
    // 거부하면 --path로 연 세션이 다시 들어올 수 없고, 재진입을 위해 만든 갈래가
    // 자리를 옮긴 세션에만 닫힌다.
    if (settings.path && !sameFile(existing.path, target)) throw new Error(`이 세션의 worktree가 이미 다른 경로에 있습니다: ${existing.path}`);
    const reusedPid = resolveSessionPid();
    return Object.assign(entry(resolved.sessionId, short, branch, existing.path, null), {
      action: 'reused', sessionIdSource: resolved.source, head: existing.head
    }, registration(registerSession(root, short, reusedPid.pid), reusedPid));
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`worktree 대상 경로가 비어 있지 않습니다: ${target}`);

  const from = settings.from || 'HEAD';
  const base = runGit(['rev-parse', from], { cwd: root, allowFailure: true });
  if (base.status !== 0) throw new Error(`분기할 기준을 찾지 못했습니다: ${from}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // --force를 쓰지 않는다. 기본 거부가 이 명령이 지키려는 바로 그 불변식이다 —
  // 한 브랜치는 한 작업 트리에만 있어야 한다.
  const added = runGit(['worktree', 'add', '-b', branch, target, base.stdout.trim()], { cwd: root, allowFailure: true });
  if (added.status !== 0) throw new Error(`worktree를 만들지 못했습니다: ${String(added.stderr || '').split(/\r?\n/u)[0] || '알 수 없는 오류'}`);

  const pid = resolveSessionPid();
  return Object.assign(entry(resolved.sessionId, short, branch, target, base.stdout.trim()), {
    action: 'created', sessionIdSource: resolved.source, head: base.stdout.trim()
  }, registration(registerSession(root, short, pid.pid), pid));
}

/** 열려 있는 세션 작업 공간. 저장된 목록이 아니라 Git이 아는 사실이다. */
function listSessions(start) {
  const root = mainWorktree(start);
  const sessions = worktreeBlocks(start)
    .filter((item) => item.branch && item.branch.startsWith(BRANCH_PREFIX))
    .map((item) => {
      const short = item.branch.slice(BRANCH_PREFIX.length);
      const live = sessionLiveness(root, short);
      return Object.assign(entry(null, short, item.branch, item.path, null), { head: item.head, sessionPid: live.pid, alive: live.alive });
    })
    .sort((left, right) => left.branch.localeCompare(right.branch));
  return { root, sessions };
}

// 본 작업 트리가 선 자리에서 보이지 않는 커밋 수. 기준을 본 작업 트리의 HEAD로 잡는
// 이유는 그것이 "합쳐졌는가"를 사람이 실제로 확인하는 자리이기 때문이다. 세지 못하면
// 세지 못했다고 답한다 — 0으로 접으면 못 본 것이 없는 것으로 읽힌다.
function unmergedCount(root, branch) {
  const counted = runGit(['rev-list', '--count', `HEAD..${branch}`], { cwd: root, allowFailure: true });
  if (counted.status !== 0) return null;
  const value = Number.parseInt(counted.stdout.trim(), 10);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 세션의 작업 공간을 닫는다. 커밋되지 않은 변경이 있으면 지우지 않는다 — 세션이
 * 끝났다는 것과 그 일이 끝났다는 것은 다르고, 앞엣것으로 뒤엣것을 버리면 잃은 줄도
 * 모른다.
 */
function endSession(start, options) {
  const settings = options || {};
  const root = mainWorktree(start);
  const resolved = resolveSessionId(settings.sessionId);
  const short = shortSessionId(resolved.sessionId);
  const branch = sessionBranch(short);
  const found = worktreeBlocks(start).find((item) => item.branch === branch);
  if (!found) throw new Error(`열려 있는 세션 worktree가 없습니다: ${branch}`);

  const dirty = runGit(['status', '--porcelain'], { cwd: found.path, allowFailure: true });
  const changes = dirty.status === 0 ? dirty.stdout.split(/\r?\n/u).filter(Boolean) : [];
  if (changes.length && !settings.force) {
    throw new Error(`커밋되지 않은 변경이 ${changes.length}건 있습니다: ${found.path}. 커밋하거나 --force를 쓰세요.`);
  }
  const removed = runGit(['worktree', 'remove', ...(settings.force ? ['--force'] : []), found.path], { cwd: root, allowFailure: true });
  if (removed.status !== 0) throw new Error(`worktree를 지우지 못했습니다: ${String(removed.stderr || '').split(/\r?\n/u)[0] || '알 수 없는 오류'}`);
  runGit(['worktree', 'prune'], { cwd: root, allowFailure: true });

  // 브랜치는 남긴다. 지우면 아직 병합하지 않은 커밋이 참조를 잃는다 — 작업 공간을
  // 닫는 것과 일을 버리는 것은 다른 결정이다.
  //
  // 다만 남긴 것을 세어서 말한다. worktree가 사라지면 이 세션은 list에서 빠지므로,
  // 병합하지 않은 커밋이 있다는 사실을 여기서 말하지 않으면 아무도 다시 묻지 않는다.
  // 등록도 함께 거둔다. 남기면 죽은 세션이 목록에 계속 살아 있는 것처럼 보이고,
  // 그 목록으로는 "지금 누가 붙어 있는가"를 답할 수 없다.
  const unregistered = releaseSession(root, short);
  return {
    action: 'removed', sessionId: resolved.sessionId, short, branch, path: found.path,
    discarded: changes.length, unmerged: unmergedCount(root, branch), unregistered
  };
}

module.exports = {
  BRANCH_PREFIX, SESSION_ENV, SESSION_PID_ENV, SHORT_LENGTH, LOCK_KIND,
  normalizeSessionId, shortSessionId, resolveSessionId, resolveSessionPid, sessionBranch,
  sessionLockFile, sessionLiveness, startSession, listSessions, endSession
};
