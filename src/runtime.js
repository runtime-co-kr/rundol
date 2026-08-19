'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGit, gitRoot } = require('./git');

function runtimeHome() {
  if (process.env.RUNDOL_HOME) return path.resolve(process.env.RUNDOL_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'rundol');
  return path.join(os.homedir(), '.local', 'share', 'rundol');
}

function repositoryRoot(start) {
  return path.resolve(gitRoot(path.resolve(start || process.cwd())));
}

function remoteUrl(root, remote) {
  const result = runGit(['remote', 'get-url', remote || 'origin'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : '';
}

function workspaceId(root, remote) {
  const repository = repositoryRoot(root);
  const identity = remoteUrl(repository, remote) || fs.realpathSync.native(repository).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function runtimeWorkspace(start, remote) {
  const root = repositoryRoot(start);
  const id = workspaceId(root, remote);
  const state = path.join(runtimeHome(), 'workspaces', id);
  return {
    id,
    root,
    state,
    manifest: path.join(state, 'workspace.yaml'),
    settings: path.join(state, 'settings'),
    index: path.join(state, 'index'),
    logs: path.join(state, 'logs'),
    pending: path.join(state, 'pending'),
    local: path.join(state, 'local'),
    locks: path.join(state, 'locks')
  };
}

function ensureRuntime(workspace) {
  for (const directory of [workspace.state, workspace.index, workspace.logs, workspace.pending, workspace.local, workspace.locks]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return workspace;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function processLockName(kind, projectId) {
  if (!/^[a-z][a-z0-9-]*$/u.test(kind || '')) throw new Error(`invalid process lock kind: ${kind || '(missing)'}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(projectId || '')) throw new Error(`invalid process lock project: ${projectId || '(missing)'}`);
  return `${kind}-${projectId}`;
}

function readProcessLock(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    const wrapped = new Error(`process lock is corrupt: ${file}: ${error.message}`);
    wrapped.code = error.code;
    throw wrapped;
  }
  const keys = Object.keys(value || {}).sort();
  const expected = ['kind', 'pid', 'projectId', 'schemaVersion', 'token', 'workspaceId'];
  if (JSON.stringify(keys) !== JSON.stringify(expected) || value.schemaVersion !== 1 || !/^[a-z][a-z0-9-]*$/u.test(value.kind || '') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.projectId || '') || !/^[a-f0-9]{16}$/u.test(value.workspaceId || '') || !Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[a-f0-9]{32}$/u.test(value.token || '')) {
    throw new Error(`process lock is corrupt: ${file}`);
  }
  return value;
}

// 동기 경로에서 잠깐 물러선다. 잠금 획득은 비동기가 아니므로 await로 쉴 수 없다.
function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// 만들어진 직후의 빈 잠금은 곧 읽힌다. 이만큼 다시 봐도 못 읽으면 경쟁이 아니다.
const UNREADABLE_LOCK_RETRIES = 8;

// 유효하지 않은 잠금을 치운다. 없어졌거나 남이 먼저 치운 경우는 실패가 아니다.
function reclaim(file) {
  const stale = `${file}.stale-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.renameSync(file, stale);
    try { fs.unlinkSync(stale); } catch {}
  } catch (renameError) {
    if (!['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(renameError.code)) throw renameError;
  }
}

function acquireProcessLock(lockDirectory, input) {
  let settings = input || {};
  if (lockDirectory && typeof lockDirectory === 'object' && typeof input === 'string') {
    const separator = input.indexOf('-');
    const kind = separator > 0 ? input.slice(0, separator) : '';
    const projectId = separator > 0 ? input.slice(separator + 1) : '';
    if (!/^[a-z][a-z0-9]*$/u.test(kind) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(projectId) || !lockDirectory.locks || !lockDirectory.id) throw new Error(`invalid process lock key: ${input}`);
    settings = { kind, projectId, workspaceId: lockDirectory.id };
    lockDirectory = lockDirectory.locks;
  }
  const kind = settings.kind || 'watch';
  const name = processLockName(kind, settings.projectId);
  if (!/^[a-f0-9]{16}$/u.test(settings.workspaceId || '')) throw new Error('process lock requires a workspaceId');
  const pid = settings.pid === undefined ? process.pid : settings.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('process lock requires a positive PID');
  const token = settings.token || crypto.randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/u.test(token)) throw new Error('process lock token is invalid');
  const alive = settings.isAlive || processIsAlive;
  fs.mkdirSync(lockDirectory, { recursive: true });
  const file = path.join(lockDirectory, `${name}.lock`);
  const record = { schemaVersion: 1, kind, workspaceId: settings.workspaceId, projectId: settings.projectId, pid, token };
  const maximumAttempts = 128;
  let acquired = false;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      acquired = true;
      break;
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
      if (error.code !== 'EEXIST') throw error;
      let current = null;
      try { current = readProcessLock(file); } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        // 잠금 파일은 만들어진 직후 잠깐 비어 있다. 여는 것과 쓰는 것이 한 동작이
        // 아니기 때문이다. 그 틈에 읽으면 JSON이 아니고, 그것을 치명적 오류로 올리면
        // "이미 돌고 있다"가 파싱 오류로 보고된다 — 경쟁이 결함으로 둔갑한다.
        //
        // 그래서 먼저 몇 번 다시 본다. 쓰기가 끝나면 읽히기 때문이다.
        if (readError.code !== undefined) throw readError;
        if (attempt <= UNREADABLE_LOCK_RETRIES) { pause(2); continue; }
        // 그래도 못 읽으면 그것은 경쟁이 아니라 남은 쓰레기다. 잠금을 쥔 프로세스는
        // 자기 잠금을 읽을 수 없게 두지 않는다. 죽은 pid의 잠금과 같이 회수한다 —
        // 회수하지 않으면 읽을 수 없는 파일 하나가 이 도구를 영영 막고, 사람이
        // 손으로 지우는 것 말고는 나갈 길이 없다.
        current = null;
      }
      if (current === null) {
        reclaim(file);
        continue;
      }
      if (current.kind !== kind || current.workspaceId !== settings.workspaceId || current.projectId !== settings.projectId) throw new Error(`process lock identity mismatch: ${file}`);
      if (alive(current.pid)) {
        const locked = new Error(`${kind} is already running for project ${settings.projectId} (pid ${current.pid})`);
        locked.code = 'RDL_PROCESS_LOCKED';
        locked.lock = current;
        throw locked;
      }
      reclaim(file);
    }
  }
  if (!acquired) {
    const error = new Error(`process lock recovery did not converge: ${file}`);
    error.code = 'RDL_PROCESS_LOCK_BUSY';
    throw error;
  }
  let released = false;
  function release() {
    if (released) return false;
    let current;
    try { current = readProcessLock(file); } catch (error) {
      if (error.code === 'ENOENT' || !fs.existsSync(file)) { released = true; return false; }
      throw error;
    }
    if (current.pid !== pid || current.token !== token) {
      const error = new Error(`process lock ownership changed: ${file}`);
      error.code = 'RDL_PROCESS_LOCK_LOST';
      throw error;
    }
    fs.unlinkSync(file);
    released = true;
    return true;
  }
  return { file, name, pid, token, record, release };
}

function withProcessLock(lockDirectory, input, action) {
  const lock = acquireProcessLock(lockDirectory, input);
  let result;
  try { result = action(lock); } catch (error) { lock.release(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(() => lock.release());
  lock.release();
  return result;
}

function bindProcessLockSignals(lock, signals) {
  if (!lock || typeof lock.release !== 'function') throw new Error('a process lock handle is required');
  const selected = signals || ['SIGINT', 'SIGTERM'];
  const handlers = new Map();
  for (const signal of selected) {
    const handler = () => { try { lock.release(); } catch {} };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return function unbind() {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

module.exports = {
  runtimeHome, repositoryRoot, remoteUrl, workspaceId, runtimeWorkspace, ensureRuntime,
  processIsAlive, processLockName, readProcessLock, acquireProcessLock, withProcessLock, bindProcessLockSignals
};
