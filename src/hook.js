'use strict';

// 훅 판정부. 클라이언트마다 훅 이벤트의 페이로드가 다르지만 답은 같아야 하므로,
// 판정은 이 파일 하나이고 각 클라이언트의 훅 설정은 이것을 부르기만 한다. 판정을
// 훅 스크립트에 두면 클로드용과 코덱스용이 언젠가 다르게 답한다 — worker-contract가
// 사람 워커와 에이전트 워커를 한 함수로 판정하는 것과 같은 이유다.
//
// 훅이 여기 필요한 이유는 실측에서 나왔다. 따로 불러야 하는 통제는 전부 버스트 후
// 침묵했고(action 원장 3일치, 코드 브랜치 결박 1일치), 이미 부르는 명령의 부수효과인
// 것만 계속 살아 있었다. 훅은 "따로 부르는 것"을 "부수효과"로 바꾸는 기제다.
//
// 판정하지 못하면 통과시킨다. 훅이 판정을 지어내면 막지 말아야 할 것을 막고, 그렇게
// 한 번 겪은 훅은 꺼진다. 꺼진 훅은 없는 훅이다.

const fs = require('fs');
const path = require('path');
const { runGit } = require('./git');
const { readCommitBindings } = require('./task-commits');
const { runtimeWorkspace } = require('./runtime');

const { HOOK_EVENTS: EVENTS, HOOK_CLIENTS: CLIENTS, WORKTREE_IGNORE_RULES } = require('./vocabulary');
// 한 턴이 만드는 커밋 수의 상한이 아니라, 커서를 잃었을 때 거슬러 볼 창이다.
const NEW_COMMIT_WINDOW = 50;

function normalizeEvent(value) {
  const event = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!EVENTS.includes(event)) throw new Error(`지원하지 않는 훅 이벤트입니다: ${value || '(없음)'}. ${EVENTS.join(', ')} 중 하나여야 합니다.`);
  return event;
}

function normalizeClient(value) {
  if (!value) return null;
  const client = String(value).trim().toLowerCase();
  if (!CLIENTS.includes(client)) throw new Error(`지원하지 않는 클라이언트입니다: ${value}. ${CLIENTS.join(', ')} 중 하나여야 합니다.`);
  return client;
}

// 두 클라이언트의 필드 이름이 거의 같다. 다른 것만 흡수하고 없는 값은 없는 채로 둔다 —
// 빈 문자열로 채우면 "세션을 모른다"와 "세션 이름이 빈 문자열이다"가 같은 값이 된다.
function normalizePayload(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  return {
    event: input.hook_event_name || null,
    cwd: input.cwd || null,
    sessionId: input.session_id || null,
    stopHookActive: input.stop_hook_active === true,
    toolName: input.tool_name || null,
    command: typeof tool.command === 'string' ? tool.command : null,
    filePath: typeof tool.file_path === 'string' ? tool.file_path : null,
    source: input.source || input.trigger || null
  };
}

// runGit은 cwd가 없거나 git을 찾지 못하면 예외를 던진다. 훅은 그런 상황에서도 답해야
// 하므로 여기서만 삼킨다 — 판정하지 못하는 것과 위반이 없는 것은 다른 값이지만, 훅에서는
// 둘 다 통과다. 판정을 지어내는 것보다 지나가는 쪽이 싸다.
function safeGit(args, cwd) {
  try { return runGit(args, { cwd, allowFailure: true }); }
  catch (_) { return { status: 1, stdout: '', stderr: '' }; }
}

// 저장소를 못 찾는 것은 실패가 아니다. 세션 worktree나 저장소 밖에서도 훅은 돈다.
function repositoryOf(start) {
  const found = safeGit(['rev-parse', '--show-toplevel'], start);
  return found.status === 0 && found.stdout ? path.resolve(found.stdout.trim()) : null;
}

function branchOf(worktree) {
  const found = safeGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree);
  return found.status === 0 && found.stdout ? found.stdout.trim() : null;
}

function headOf(worktree) {
  const found = safeGit(['rev-parse', 'HEAD'], worktree);
  return found.status === 0 && found.stdout ? found.stdout.trim() : null;
}

function dirtyCount(worktree) {
  const found = safeGit(['status', '--porcelain'], worktree);
  if (found.status !== 0) return null;
  return found.stdout.split(/\r?\n/u).filter(Boolean).length;
}

// 본 작업 트리인가. linked worktree는 자기 git-dir이 공통 디렉터리와 다르다.
function isMainWorktree(worktree) {
  const own = safeGit(['rev-parse', '--absolute-git-dir'], worktree);
  const common = safeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree);
  if (own.status !== 0 || common.status !== 0) return null;
  return path.resolve(own.stdout.trim()).toLowerCase() === path.resolve(common.stdout.trim()).toLowerCase();
}

// 훅의 커서. 한 턴이 무엇을 새로 만들었는지는 지난번에 본 HEAD와의 차이로만 알 수
// 있다. 세션 식별자로 가르는 이유는 한 저장소에 세션이 여럿 붙기 때문이다.
function cursorFile(root, sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]+/gu, '-').slice(0, 64);
  return path.join(runtimeWorkspace(root).local, `hook-cursor-${safe}.json`);
}

function readCursor(root, sessionId) {
  try { return JSON.parse(fs.readFileSync(cursorFile(root, sessionId), 'utf8')); } catch (_) { return null; }
}

function writeCursor(root, sessionId, value) {
  const file = cursorFile(root, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
    return true;
  } catch (_) { return false; }
}

// 커서 이후에 생긴 커밋. 커서가 없으면 아무것도 세지 않는다 — 커서를 잃었다고 이력
// 전체를 한 턴의 결과로 읽으면, 처음 켠 훅이 과거 수백 건을 이 턴의 위반으로 보고한다.
function commitsSince(worktree, cursorHead) {
  if (!cursorHead) return [];
  const listed = safeGit(['rev-list', `${cursorHead}..HEAD`], worktree);
  if (listed.status !== 0) return [];
  return listed.stdout.split(/\r?\n/u).filter(Boolean).slice(0, NEW_COMMIT_WINDOW);
}

function openTaskCounts(root) {
  try {
    const { listTasks } = require('./agent-context');
    const listed = listTasks(root, {});
    const counts = {};
    for (const task of listed.tasks || []) counts[task.status] = (counts[task.status] || 0) + 1;
    return counts;
  } catch (_) { return null; }
}

function sessionSummary(root) {
  try {
    const { listSessions } = require('./session');
    return listSessions(root).sessions;
  } catch (_) { return null; }
}

function waitingRuns(root) {
  try {
    const { pendingRuns } = require('./run-pending');
    const pending = pendingRuns(root, {});
    return { waiting: (pending.waiting || []).length, drivable: (pending.drivable || []).length };
  } catch (_) { return null; }
}

// Rundol이 강제하는 추적 제외를 확인하고 없으면 채운다.
//
// 세션 worktree가 저장소 안에 서게 되면서 이 규칙은 편의가 아니라 전제가 됐다.
// 규칙이 없는 채로 자리를 옮기면 git add -A 한 번이 트리 전체를 커밋한다.
//
// 사람의 기억에 맡기지 않는 이유는 규칙보다 먼저 만들어진 저장소와 규칙을 지운
// 저장소가 있기 때문이다. 새로 clone한 곳에는 이미 있으므로 대개 아무 일도 하지
// 않고, 없을 때만 채우고 무엇을 채웠는지 말한다 — 조용히 고치면 추적 규칙이 언제
// 어디서 들어왔는지 아무도 답할 수 없다.
function ensureIgnoreRules(root) {
  const file = path.join(root, '.gitignore');
  let source = '';
  try { source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
  catch (_) { return null; }
  const present = new Set(source.split(/\r?\n/u).map((line) => line.trim()));
  const missing = WORKTREE_IGNORE_RULES.filter((rule) => !present.has(rule));
  if (!missing.length) return [];
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const base = source.replace(/[\r\n]+$/u, '');
  const block = [base, '', '# Rundol worktree 자리 — rdl hook이 채웠습니다'].concat(missing, ['']).join(eol);
  try { fs.writeFileSync(file, block, 'utf8'); } catch (_) { return null; }
  return missing;
}

// ── 이벤트 ───────────────────────────────────────────────────────────────

// 시작은 주입만 한다. 이 시점에는 판정할 사실이 없고, 막아 봐야 일을 못 하게 할 뿐이다.
//
// doing 개수를 매번 말하는 이유는 그것이 파생 사다리의 전제이기 때문이다. doing이
// 둘 이상이면 single-doing이 답하지 못하고, 그러면 저장마다 --task가 손으로 필요해진다.
// 그 사실이 지금은 rdl task list를 일부러 쳐야만 보인다.
function sessionStart(start, payload) {
  const root = repositoryOf(payload.cwd || start);
  const context = [];
  if (!root) return { block: false, context };
  const worktree = payload.cwd || root;
  const branch = branchOf(worktree);
  const main = isMainWorktree(worktree);
  context.push(`작업 트리: ${main === null ? '판정 불가' : main ? '본 트리' : '연결 트리'} · 브랜치 ${branch || '(detached)'}`);

  const counts = openTaskCounts(root);
  if (counts) {
    const doing = counts.doing || 0;
    const summary = Object.entries(counts).sort().map(([key, value]) => `${key} ${value}`).join(' · ');
    context.push(`열린 태스크: ${summary || '없음'}`);
    if (doing > 1) {
      context.push(`주의: doing이 ${doing}건이라 저장의 자동 파생이 답하지 못합니다. 커밋마다 --task가 필요합니다.`);
      context.push('  정리: rdl task list --project <key> --open');
    }
  }

  for (const item of sessionSummary(root) || []) {
    const life = item.alive === true ? '붙어 있음' : item.alive === false ? '종료됨(미정리)' : '등록 없음';
    context.push(`세션 ${item.short}: ${item.path} — ${life}`);
  }

  const runs = waitingRuns(root);
  if (runs && (runs.waiting || runs.drivable)) context.push(`런: 사람 대기 ${runs.waiting}건 · 진행 가능 ${runs.drivable}건`);

  // 본 트리에서만 채운다. 세션 worktree에서 고치면 같은 파일이 두 자리에서 갈리고,
  // 어느 쪽이 커밋될지는 그때 누가 저장하느냐에 달리게 된다.
  if (main) {
    const added = ensureIgnoreRules(root);
    if (added === null) context.push('.gitignore를 확인하지 못했습니다. 저장소 안 worktree가 추적될 수 있습니다.');
    else if (added.length) context.push(`.gitignore에 추적 제외 규칙을 채웠습니다: ${added.join(' · ')}`);
  }

  // 커서를 여기서 놓는다. 이 자리가 없으면 stop이 "이 턴이 만든 것"을 셀 기준을 갖지 못한다.
  writeCursor(root, payload.sessionId, { head: headOf(worktree), branch, at: new Date().toISOString() });
  return { block: false, context };
}

// 커밋이 실제로 만들어진 뒤 결박 여부를 그 자리에서 센다. 막지 않는다 — 계측이
// 목적이고, rdl check의 50건 창은 사후에만 답하기 때문이다.
function postToolUse(start, payload) {
  const root = repositoryOf(payload.cwd || start);
  if (!root) return { block: false, context: [], record: null };
  const isCommit = payload.toolName === 'Bash' && typeof payload.command === 'string' && /\bgit\b[\s\S]*\bcommit\b/u.test(payload.command);
  if (!isCommit) return { block: false, context: [], record: null };
  const worktree = payload.cwd || root;
  const head = headOf(worktree);
  if (!head) return { block: false, context: [], record: null };
  let binding = null;
  try {
    const scanned = readCommitBindings(worktree, head, { limit: 1 });
    binding = scanned.length ? scanned[0] : null;
  } catch (_) { binding = null; }
  if (!binding) return { block: false, context: [], record: null };
  const record = {
    type: 'hook',
    event: 'post-tool-use',
    sessionId: payload.sessionId || null,
    branch: branchOf(worktree),
    commit: binding.commit.slice(0, 12),
    binding: binding.binding,
    taskId: binding.taskId || null
  };
  // 기록 실패가 이미 끝난 도구 실행을 되돌리지는 않는다.
  try { require('./debug').appendDebug(root, record); } catch (_) { /* 무시 */ }
  return { block: false, context: [], record };
}

// 완료 주장을 Git으로 재확인한다. ADR-007이 결정해 둔 세 값 가운데 결박만 막고
// 나머지는 알린다 — 진행 중인 트리가 더러운 것은 정상이고, 그것까지 막으면 소음이 된다.
function stop(start, payload) {
  const root = repositoryOf(payload.cwd || start);
  if (!root) return { block: false, context: [] };
  const worktree = payload.cwd || root;
  const branch = branchOf(worktree);
  // 프로젝트 브랜치는 rdl save가 이미 결박을 강제한다. 두 번 막으면 어디서 막혔는지 흐려진다.
  if (branch && branch.startsWith('rundol/')) return { block: false, context: [] };

  const cursor = readCursor(root, payload.sessionId);
  const head = headOf(worktree);
  const fresh = commitsSince(worktree, cursor && cursor.head);
  const dirty = dirtyCount(worktree);
  const context = [];
  const advance = () => { if (head) writeCursor(root, payload.sessionId, { head, branch, at: new Date().toISOString() }); };
  if (dirty) context.push(`커밋되지 않은 변경 ${dirty}건이 ${branch || 'HEAD'}에 남아 있습니다.`);

  if (!fresh.length) { advance(); return { block: false, context }; }

  let unbound = [];
  try {
    const scanned = readCommitBindings(worktree, 'HEAD', { limit: Math.max(fresh.length, 1) });
    const wanted = new Set(fresh);
    unbound = scanned.filter((item) => wanted.has(item.commit) && item.binding === 'unbound');
  } catch (_) { unbound = []; }

  // 두 번째 회차는 통과시킨다. 한 턴에 한 번만 되돌리는 것이 이 훅의 계약이며,
  // 이것이 없으면 고치지 않는 모델과 훅이 무한히 주고받는다.
  if (payload.stopHookActive) {
    advance();
    if (unbound.length) context.push(`미결박 커밋 ${unbound.length}건을 그대로 남깁니다.`);
    return { block: false, context };
  }

  if (!unbound.length) { advance(); return { block: false, context }; }

  const sample = unbound.slice(0, 5).map((item) => item.commit.slice(0, 12)).join(', ');
  const reason = [
    `이 턴이 만든 커밋 ${unbound.length}건이 태스크 결박을 지나지 않았습니다: ${sample}`,
    '어느 태스크의 일인지 밝히거나 사유를 남기세요.',
    '  git commit --amend --trailer "Rundol-Task: <TASK-ID>"',
    '  또는  git commit --amend --trailer "Rundol-Task: none" --trailer "Rundol-Task-Reason: <사유>"'
  ].join('\n');
  return { block: true, reason, context };
}

// 닫는 자리에서는 말만 한다. rdl session end는 미커밋 변경이 있으면 거부하는 것이
// 계약인데 훅은 되물을 수 없어, 자동으로 부르면 --force로 밀거나 실패하거나 둘 중 하나가 된다.
function sessionEnd(start, payload) {
  const root = repositoryOf(payload.cwd || start);
  if (!root) return { block: false, context: [] };
  const context = [];
  for (const item of sessionSummary(root) || []) {
    const dirty = dirtyCount(item.path);
    const ahead = safeGit(['rev-list', '--count', `HEAD..${item.branch}`], root);
    const unmerged = ahead.status === 0 ? ahead.stdout.trim() : '확인 불가';
    context.push(`세션 ${item.short}: 미커밋 ${dirty === null ? '확인 불가' : `${dirty}건`} · 미병합 ${unmerged}건 — 정리하려면 rdl session end`);
  }
  return { block: false, context };
}

const HANDLERS = { 'session-start': sessionStart, 'post-tool-use': postToolUse, stop, 'session-end': sessionEnd };

function runHook(start, options) {
  const settings = options || {};
  const event = normalizeEvent(settings.event);
  const client = normalizeClient(settings.client);
  const payload = normalizePayload(settings.payload);
  const result = HANDLERS[event](start, payload);
  return Object.assign({ event, client, sessionId: payload.sessionId || null, block: false, context: [] }, result);
}

module.exports = { EVENTS, CLIENTS, normalizeEvent, normalizeClient, normalizePayload, runHook };
