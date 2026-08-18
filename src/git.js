'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 저장소가 "어디 있는가"만 캐시한다. "무엇이 들어 있는가"는 캐시하지 않는다.
//
// 이 구분이 유일하게 안전한 선이다. Rundol의 저장소는 이 프로세스만 바꾸는 것이
// 아니다 — 다른 클라이언트, 사용자의 손 커밋, 그리고 Rundol 자신이 띄우는 자식
// 프로세스가 같은 저장소를 바꾼다. 그래서 HEAD·ref·log처럼 내용을 말하는 질의를
// 캐시하면 낡은 답을 자신 있게 내놓게 된다. 반면 저장소 루트와 git 디렉터리
// 경로는 프로세스가 사는 동안 바뀌지 않으므로 다시 물을 이유가 없다.
//
// 실측 근거: `rdl save` 한 번에 rev-parse --show-toplevel이 5회 나가고 그것만으로
// 200ms다. 내용 질의를 캐시하지 않아도 중복의 대부분이 여기에 있다.
const cache = new Map();
const rootCache = new Map();
const DISABLED = process.env.RUNDOL_NO_GIT_CACHE === '1';

// 저장소의 위치·구조를 답하는 rev-parse 플래그. 내용과 무관하다.
const LAYOUT_FLAGS = new Set(['--show-toplevel', '--is-inside-work-tree', '--git-dir', '--git-common-dir', '--show-cdup', '--show-prefix']);

function cacheable(args, settings) {
  if (DISABLED || settings.input !== undefined) return false;
  if (args[0] !== 'rev-parse') return false;
  const rest = args.slice(1);
  if (rest.length === 1 && LAYOUT_FLAGS.has(rest[0])) return true;
  // --git-path는 경로 해석이라 내용을 읽지 않는다.
  return rest.length === 2 && rest[0] === '--git-path';
}

// worktree 생성처럼 레이아웃을 바꾸는 호출이 나가면 위치 캐시도 버린다.
function invalidates(args) {
  return args[0] === 'worktree' || args[0] === 'init' || args[0] === 'clone';
}

function repositoryDirectory(start) {
  const resolved = path.resolve(start);
  if (rootCache.has(resolved)) return rootCache.get(resolved);
  let current = resolved;
  let answer = resolved;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) { answer = current; break; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  rootCache.set(resolved, answer);
  return answer;
}

function spawnGit(args, settings) {
  const safeDirectory = settings.cwd ? repositoryDirectory(settings.cwd).split(path.sep).join('/') : null;
  const gitArgs = ['-c', 'http.version=HTTP/1.1'];
  if (safeDirectory) gitArgs.push('-c', `safe.directory=${safeDirectory}`);
  gitArgs.push(...args);
  const result = spawnSync('git', gitArgs, {
    cwd: settings.cwd,
    input: settings.input,
    encoding: 'utf8',
    env: Object.assign({}, process.env, settings.env || {})
  });
  if (result.error) throw new Error(`Git을 실행할 수 없습니다: ${result.error.message}`);
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function runGit(args, options) {
  const settings = options || {};
  let outcome;
  if (cacheable(args, settings)) {
    const key = `${settings.cwd || ''}${JSON.stringify(settings.env || null)}${args.join('')}`;
    if (cache.has(key)) outcome = cache.get(key);
    else { outcome = spawnGit(args, settings); cache.set(key, outcome); }
  } else {
    outcome = spawnGit(args, settings);
    // 실행 뒤에 버린다. 이 호출이 만든 변화까지 지운 상태에서 다음 질의가 나가야 한다.
    if (invalidates(args)) { cache.clear(); rootCache.clear(); }
  }
  // 던지기 판정은 캐시와 무관하게 호출마다 다시 한다 — 같은 질의를 allowFailure
  // 있이·없이 부르는 자리가 있고, 캐시가 그 차이를 삼키면 안 된다.
  if (outcome.status !== 0 && !settings.allowFailure) {
    const detail = (outcome.stderr || outcome.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} 실패${detail ? `: ${detail}` : ''}`);
  }
  return { status: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr };
}

function clearGitCache() {
  cache.clear();
  rootCache.clear();
}

function refExists(root, ref) {
  return runGit(['show-ref', '--verify', '--quiet', ref], { cwd: root, allowFailure: true }).status === 0;
}

function gitRoot(start) {
  return runGit(['rev-parse', '--show-toplevel'], { cwd: start }).stdout;
}

module.exports = { runGit, refExists, gitRoot, clearGitCache };
