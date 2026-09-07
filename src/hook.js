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

const {
  HOOK_EVENTS: EVENTS, HOOK_CLIENTS: CLIENTS, WORKTREE_IGNORE_RULES, CODE_PATH_PREFIXES, DOCUMENT_WRITE_TOOLS,
  DOCUMENT_LIFECYCLE_KEYS
} = require('./vocabulary');
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
    edits: normalizeEdits(tool),
    source: input.source || input.trigger || null
  };
}

// 이 쓰기가 무엇을 무엇으로 갈았는가. Edit는 한 쌍, MultiEdit는 여러 쌍을 든다.
//
// 여기 담기는 것이 파일 내용이 아니라 **바뀐 자리**라는 것이 요점이다. 쓰고 난 파일만
// 보면 지금 값이 무엇인지는 알아도 이 쓰기가 그 값을 만든 것인지 원래 있던 것인지
// 가를 수 없고, 그 구분 없이 말하면 훅은 같은 파일을 고칠 때마다 같은 말을 한다.
//
// Write에는 짝이 없다. 통째로 덮는 도구라 이전 내용이 페이로드에 없고, 그래서 이
// 함수는 빈 목록을 돌려준다 — 판정하지 못하는 것은 판정하지 않는다.
function normalizeEdits(tool) {
  const pairs = [];
  const push = (before, after) => {
    if (typeof before !== 'string' && typeof after !== 'string') return;
    pairs.push({ before: typeof before === 'string' ? before : '', after: typeof after === 'string' ? after : '' });
  };
  push(tool.old_string, tool.new_string);
  if (Array.isArray(tool.edits)) {
    for (const edit of tool.edits) {
      if (edit && typeof edit === 'object') push(edit.old_string, edit.new_string);
    }
  }
  return pairs;
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

// 경로를 실제 경로로 편다. git이 돌려주는 경로는 이미 펴져 있고 클라이언트 페이로드의
// 경로는 그렇지 않다 — Windows의 8.3 단축명(ADMINI~1)이나 심볼릭 링크(/tmp → /private/tmp)가
// 그대로 들어온다. 펴지 않고 비교하면 같은 파일이 프로젝트 밖으로 판정돼 훅이 조용히 입을
// 다물고, 그 침묵은 "낡지 않았다"와 구분되지 않는다.
function realPath(value) {
  try { return fs.realpathSync.native(value); }
  catch (_) { return path.resolve(value); }
}

// 이 경로가 저장소 안에 있는가. path.relative가 ..로 시작하면 밖이다.
function contains(root, file) {
  const relative = path.relative(realPath(root), realPath(file));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// 문서 frontmatter의 state 줄. 값만 뽑는다.
const STATE_LINE = /^state:[^\S\r\n]*([^\r\n]*)$/mu;

/**
 * 이 쓰기가 문서의 `state` 칸을 손으로 갈았는가. 아니면 null이다.
 *
 * 이 칸은 0.45에서 rdl 소유가 됐다. 승인·제출·반려가 원장에 사건을 적으면서 함께
 * 쓰고, 손으로 적은 값은 다음 사건에서 되돌아간다. 문제는 되돌아가기 전까지다 —
 * 어휘 안의 값을 손으로 적으면(`state: approved`) **아무 진단도 나지 않는다.**
 * RDL-DOC-018은 어휘 밖 값만 잡으므로, 아무도 승인하지 않은 문서가 파일에서 승인됨을
 * 주장하고 그 주장을 읽는 모든 화면이 그것을 옮긴다. 지금 그 사실을 말할 수 있는
 * 자리는 여기뿐이다.
 *
 * **rdl 자신의 쓰기와 갈린다.** 이 갈래는 payload.toolName이 DOCUMENT_WRITE_TOOLS일
 * 때만 들어오고, rdl의 투영은 CLI 프로세스 안의 fs 쓰기라 그 도구를 지나지 않는다
 * (도구 이름이 Bash다). 그래서 자기 명령마다 우는 일이 구조적으로 없다.
 *
 * 짝이 없는 쓰기는 판정하지 않는다. Write는 통째로 덮어 이전 내용이 페이로드에 없고,
 * 지금 값만으로는 이 쓰기가 그것을 만들었는지 원래 있던 것인지 가를 수 없다.
 *
 * 값을 지금 frontmatter의 state와 묶는 것은 본문 오탐을 막기 위해서다. 본문 코드
 * 블록의 `state: ...` 한 줄이 우연히 이 정규식에 걸려도, 그 값이 이 문서의 지금
 * state와 같지 않으면 말하지 않는다.
 */
function handEditedState(payload, current) {
  for (const edit of payload.edits || []) {
    const before = STATE_LINE.exec(edit.before);
    const after = STATE_LINE.exec(edit.after);
    if (!before && !after) continue;
    const from = before ? before[1].trim() : null;
    const to = after ? after[1].trim() : null;
    if (from === to) continue;
    // 새로 적힌 값이 지금 이 문서의 state여야 한다. 지운 경우(to가 null)는 지금 칸이
    // 없다는 것으로 같은 대조를 한다.
    if (to === null ? current === null : to !== current) continue;
    return { from, to };
  }
  return null;
}

// 방금 쓴 문서에 대해 이 자리에서 말할 수 있는 것. 말할 것이 없으면 null이다.
//
// 낡음만 본다. 미승인은 아직 아무도 근거로 삼지 않은 줄이지 사건이 아니고, 승인 축을
// 쓰지 않는 프로젝트에서는 문서가 전건 미승인이라 저장할 때마다 같은 말이 나온다 —
// 매번 우는 신호는 꺼진 신호와 같다. board.js와 watch.js가 그은 선과 같은 선이다.
//
// 판정은 approval.js가 한다. 여기서 리비전을 비교하면 rdl doc status와 훅이 같은 문서에
// 다른 답을 낼 수 있고, 그 둘이 갈리는 순간 사람은 어느 쪽도 믿지 않는다.
//
// listDocuments를 부르지 않고 쓴 파일 하나만 파싱하는 것은 비용 때문이다. 실측에서
// 문서 200건 기준 listDocuments가 120ms대인 반면 파일 하나 파싱은 1.5ms대였다. 훅은
// 저장마다 도는 자리라 문서 수에 비례해 자라는 비용을 여기 둘 수 없다.
//
// 세 판정이 한 파싱을 나눠 쓴다. 수명과 state는 이미 손에 든 frontmatter만 보므로
// 원장을 접는 비용이 붙지 않고, 승인 축을 갖기 전 판(schemaVersion 6 미만)에서도
// 답할 수 있다 — 두 칸은 원장이 아니라 파일의 사실이다.
//
// 어느 단계에서 못 읽어도 통과다. 훅이 판정을 지어내면 막지 말아야 할 것을 막고,
// 그렇게 한 번 겪은 훅은 꺼진다.
function documentWriteNotice(root, worktree, filePath, payload) {
  try {
    const resolved = path.resolve(worktree, filePath);
    if (!/\.md$/iu.test(resolved) || !fs.existsSync(resolved)) return null;
    // Workspace 탐색은 쓴 파일이 아니라 저장소 루트에서 시작한다. 층수만큼 덜 훑는
    // 것이 여전히 싸고, 훅은 저장마다 도는 자리라 그 차이가 곧 사람이 겪는 지연이 된다.
    //
    // 한때 이 자리가 훨씬 비쌌다. 찾기가 층마다 manifestPath를 부르고 못 찾은 층마다
    // runtimeWorkspace가 딸려 나왔으며 그 한 번이 git 프로세스 셋이라, 문서 파일에서
    // 시작하면 왕복이 층수만큼 쌓였다. 그 비용은 workspace.js가 없앴다 — 런타임 manifest가
    // 하나도 없으면 어떤 저장소를 물어도 답이 null이므로 신원을 계산하지 않는다.
    const { workspaceLayout } = require('./workspace');
    const layout = workspaceLayout(root);
    const project = (layout.projects || []).find((item) => item.root && contains(item.root, resolved));
    if (!project) return null;
    const { parseFrontmatter } = require('./frontmatter');
    const parsed = parseFrontmatter(fs.readFileSync(resolved, 'utf8'));
    if (!parsed || !parsed.data || !parsed.data.id) return null;
    const notice = { project: project.key, id: parsed.data.id, stale: null, lifecycle: null, state: null };

    // 값 없는 `lifecycle:` 한 줄을 파서가 빈 배열로 읽는다. board-data.js와 같은 규칙으로
    // 문자열만 값으로 받는다.
    const lifecycle = typeof parsed.data.lifecycle === 'string' && parsed.data.lifecycle.trim() ? parsed.data.lifecycle.trim() : null;
    if (lifecycle !== null && !DOCUMENT_LIFECYCLE_KEYS.includes(lifecycle)) notice.lifecycle = lifecycle;

    const state = typeof parsed.data.state === 'string' && parsed.data.state.trim() ? parsed.data.state.trim() : null;
    notice.state = handEditedState(payload, state);

    // 승인 원장을 갖기 전 판에서는 낡음이라는 사실 자체가 없다.
    if (layout.schemaVersion >= 6) {
      const approval = require('./approval');
      const { authorityContext } = require('./authority');
      const folded = approval.foldApprovals(
        approval.readApprovalEvents(path.join(layout.root, 'projects', 'workspace', 'events'), project.key),
        { authority: authorityContext(layout.root, project.key, { now: Date.now() }) }
      );
      // 리비전 표를 통째로 넘긴다. 판 2 값 하나만 주면 판 1로 기록된 옛 승인을 못 맞혀
      // 낡음으로 읽고, 훅은 승인이 멀쩡한 문서에 "승인 후 개정"을 저장할 때마다 외친다.
      // 그 헛울림은 막지도 않으면서 신뢰만 깎고, 한 번 그런 훅은 꺼진다.
      const { documentRevisions } = require('./board-data');
      const trust = approval.trustState({ id: parsed.data.id, revisions: documentRevisions(parsed.data, parsed.body) }, folded.approvals.get(parsed.data.id));
      if (trust.status === 'stale') notice.stale = { approvedBy: trust.approvedBy };
    }
    if (!notice.stale && !notice.lifecycle && !notice.state) return null;
    return notice;
  } catch (_) { return null; }
}

// 커밋이 실제로 만들어진 뒤 결박 여부를 그 자리에서 센다. 막지 않는다 — 계측이
// 목적이고, rdl check의 50건 창은 사후에만 답하기 때문이다.
//
// 문서를 쓴 직후도 같은 자리에서 받는다. 저장 시점이 "승인 대비 바뀌었다"를 말할 수 있는
// 가장 이른 자리이기 때문이다 — 감시는 다음 스캔까지 기다리고, rdl doc status는 일부러
// 쳐야 보인다. 사람이 문서를 고치고 나서 그 사실을 아는 데 걸리는 시간이 여기서 0이 된다.
function postToolUse(start, payload) {
  const root = repositoryOf(payload.cwd || start);
  if (!root) return { block: false, context: [], record: null };
  const worktree = payload.cwd || root;
  if (DOCUMENT_WRITE_TOOLS.includes(payload.toolName) && payload.filePath) {
    const notice = documentWriteNotice(root, worktree, payload.filePath, payload);
    if (!notice) return { block: false, context: [], record: null };
    const context = [];
    if (notice.stale) {
      context.push(`${notice.id}이(가) 승인 대비 바뀌었습니다 — 검토 필요 (승인: ${notice.stale.approvedBy || '(미상)'}).`);
      context.push(`  차이: rdl doc diff ${notice.id} --since-approval --project ${notice.project}`);
      context.push(`  재승인: rdl doc approve ${notice.id} --member <MEMBER-ID> --basis read --client-id <id> --project ${notice.project}`);
    }
    // state는 rdl이 원장에서 투영하는 칸이다. 어휘 안의 값을 손으로 적으면 아무 진단도
    // 나지 않으므로, 그 사실을 말할 수 있는 자리가 이 한 번뿐이다.
    if (notice.state) {
      context.push(`${notice.id}의 state를 손으로 고쳤습니다: ${notice.state.from || '(없음)'} → ${notice.state.to || '(없음)'}. 이 칸은 rdl이 승인 원장에서 투영합니다.`);
      context.push(`  올리려면: rdl doc submit ${notice.id} --client-id <id> --project ${notice.project}`);
      context.push('  내용의 수명을 말하려던 것이면 lifecycle 칸입니다.');
    }
    // 수명은 사람이 소유한다. 아무것도 이 값을 굴리지 않으므로 오타가 스스로 낫지
    // 않고, rdl check가 RDL-DOC-017 오류로 막는다 — state의 경고와 심각도가 다른 이유다.
    if (notice.lifecycle) {
      context.push(`${notice.id}의 lifecycle 값이 어휘 밖입니다: ${notice.lifecycle} (rdl check가 RDL-DOC-017 오류로 막습니다).`);
      context.push(`  가능한 값: ${DOCUMENT_LIFECYCLE_KEYS.join(' · ')} (또는 칸 자체를 두지 않습니다)`);
    }
    return { block: false, record: null, context };
  }
  const isCommit = payload.toolName === 'Bash' && typeof payload.command === 'string' && /\bgit\b[\s\S]*\bcommit\b/u.test(payload.command);
  if (!isCommit) return { block: false, context: [], record: null };
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

// 저장소의 기본 코드 브랜치. origin/HEAD가 가리키는 곳이며, 없으면 판정하지 않는다 —
// 기본 브랜치를 추측해서 막으면 그 추측이 틀린 저장소에서 아무 일도 할 수 없게 된다.
function defaultBranchOf(worktree) {
  const found = safeGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], worktree);
  if (found.status !== 0 || !found.stdout) return null;
  const name = found.stdout.trim();
  const slash = name.indexOf('/');
  return slash < 0 ? name : name.slice(slash + 1);
}

// 쓰기 전에 막는다. 되돌릴 것이 없는 유일한 시점이고, 커밋 시점에 막으면 작업은 이미
// 잘못된 자리에 쌓인 뒤다 — 옮기려면 stash와 cherry-pick이 필요하고 그 왕복 자체가
// 또 다른 사고 지점이다.
//
// 막는 조건은 셋이 모두 참일 때뿐이다. 본 작업 트리이고, 브랜치가 저장소의 기본 코드
// 브랜치이고, 대상이 제품 코드다. 하나라도 아니면 통과한다 — 문서를 고치는 것도,
// 세션 worktree에서 코드를 고치는 것도, 기능 브랜치에서 고치는 것도 막을 이유가 없다.
function preToolUse(start, payload) {
  if (!payload.filePath) return { block: false, context: [] };
  const root = repositoryOf(payload.cwd || start);
  if (!root) return { block: false, context: [] };
  const worktree = payload.cwd || root;
  if (isMainWorktree(worktree) !== true) return { block: false, context: [] };
  const branch = branchOf(worktree);
  const base = defaultBranchOf(worktree);
  if (!branch || !base || branch !== base) return { block: false, context: [] };
  const relative = path.relative(root, path.resolve(worktree, payload.filePath));
  // 저장소 밖의 파일은 이 저장소의 규칙이 닿는 자리가 아니다.
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { block: false, context: [] };
  const shown = relative.split(path.sep).join('/');
  if (!CODE_PATH_PREFIXES.some((prefix) => shown.startsWith(prefix))) return { block: false, context: [] };
  const reason = [
    `제품 코드는 ${base}의 본 작업 트리에서 고치지 않습니다: ${shown}`,
    '세션 worktree를 열고 그 안에서 고치세요.',
    '  rdl session start'
  ].join('\n');
  return { block: true, reason, context: [] };
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

const HANDLERS = { 'session-start': sessionStart, 'pre-tool-use': preToolUse, 'post-tool-use': postToolUse, stop, 'session-end': sessionEnd };

function runHook(start, options) {
  const settings = options || {};
  const event = normalizeEvent(settings.event);
  const client = normalizeClient(settings.client);
  const payload = normalizePayload(settings.payload);
  const result = HANDLERS[event](start, payload);
  return Object.assign({ event, client, sessionId: payload.sessionId || null, block: false, context: [] }, result);
}

module.exports = { EVENTS, CLIENTS, normalizeEvent, normalizeClient, normalizePayload, runHook };
