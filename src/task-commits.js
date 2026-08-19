'use strict';

// 커밋이 어느 태스크의 일이었는지는 커밋 자신이 답한다(REQ-046). 이 파일은 그 답을
// 읽는 한 곳이다.
//
// 검사와 조회가 트레일러를 각자 파싱하면 두 곳이 같은 커밋을 다르게 읽는 날이 온다.
// 결박은 "무엇이 사실인가"를 다투지 않아야 값을 갖는 통제이므로, 읽는 규칙은 하나여야
// 한다.
//
// 브랜치를 지워도 답이 남는 이유는 프로젝트 ref의 이력을 읽기 때문이다. 작업 브랜치는
// 지워지지만 저장이 만든 커밋은 프로젝트 ref에 남는다.

const { runGit } = require('./git');

const TASK_TRAILER = /^Rundol-Task:[ \t]*(.+)$/mu;
const REASON_TRAILER = /^Rundol-Task-Reason:[ \t]*(.+)$/mu;
const RECORD = '\x1e';
const FIELD = '\x1f';

// 창은 기본으로 두되 넓힐 수 있다. 전체 이력을 걷는 조회는 프로젝트가 자랄수록 느려지고,
// 대개 묻는 것은 최근의 일이다. 다만 "이 태스크가 만든 커밋 전부"를 물을 때는 창이
// 답을 잘라서는 안 되므로 호출자가 정할 수 있어야 한다.
const DEFAULT_WINDOW = 200;

function parseCommitBindings(stdout) {
  const commits = [];
  for (const record of String(stdout || '').split(RECORD)) {
    const [rawCommit, rawAt, body] = record.split(FIELD);
    const commit = String(rawCommit || '').trim();
    if (!commit) continue;
    const trailer = TASK_TRAILER.exec(body || '');
    const value = trailer ? trailer[1].trim() : null;
    const reason = REASON_TRAILER.exec(body || '');
    const subject = String(body || '').split(/\r?\n/u)[0] || '';
    commits.push({
      commit,
      at: String(rawAt || '').trim() || null,
      subject,
      // 셋을 구분한다. 결박을 지나 태스크에 묶인 것, 지났으나 사유로 우회한 것,
      // 아예 지나지 않은 것. 마지막은 Git을 직접 써서 만든 커밋이다.
      binding: !trailer ? 'unbound' : value === 'none' ? 'excused' : 'bound',
      taskId: !trailer || value === 'none' ? null : value,
      reason: reason ? reason[1].trim() : null
    });
  }
  return commits;
}

// 창을 채웠으면 더 있을 수 있다. 잘린 목록을 "전부"인 것처럼 돌려주면 오래된 태스크의
// 커밋이 조용히 사라지고, 읽는 사람은 없다고 믿는다 — 못 본 것과 없는 것은 다른 값이다.
function readCommitBindings(root, ref, options) {
  const settings = options || {};
  const window = Number.isSafeInteger(settings.limit) && settings.limit > 0 ? settings.limit : DEFAULT_WINDOW;
  const args = ['log', '--no-merges', `--max-count=${window}`, `--format=%H${FIELD}%cI${FIELD}%B${RECORD}`, ref];
  const log = runGit(args, { cwd: root, allowFailure: true });
  // 조회하지 못한 것과 결과가 없는 것은 다른 값이다. 빈 목록으로 접으면 이력을 읽지
  // 못한 저장소가 "커밋이 없는" 저장소와 같은 얼굴을 한다.
  if (log.status !== 0) {
    const error = new Error(`${ref} 이력을 읽을 수 없습니다: ${String(log.stderr || '').split(/\r?\n/u)[0] || '알 수 없는 오류'}`);
    error.code = 'RDL-TASK-038';
    throw error;
  }
  const commits = parseCommitBindings(log.stdout);
  commits.truncated = commits.length >= window;
  commits.window = window;
  return commits;
}

// 태스크 하나가 만든 커밋. 없는 태스크를 물으면 빈 목록이 아니라 그 사실을 말한다 —
// 없는 것을 "커밋이 없다"로 답하면 오타가 정상 응답이 된다.
function commitsForTask(root, ref, taskId, options) {
  const scanned = readCommitBindings(root, ref, options);
  return { taskId, ref, window: scanned.window, truncated: scanned.truncated, commits: scanned.filter((item) => item.taskId === taskId) };
}

// 태스크별 커밋 대응 전체. 결박되지 않은 것과 우회한 것도 함께 낸다 — 묶인 것만 세면
// 무엇이 빠졌는지 알 수 없다.
function commitBindingSummary(root, ref, options) {
  const commits = readCommitBindings(root, ref, options);
  const byTask = new Map();
  for (const item of commits) {
    if (!item.taskId) continue;
    if (!byTask.has(item.taskId)) byTask.set(item.taskId, []);
    byTask.get(item.taskId).push(item);
  }
  return {
    ref,
    scanned: commits.length,
    window: commits.window,
    truncated: commits.truncated,
    tasks: Array.from(byTask.entries()).sort((left, right) => left[0].localeCompare(right[0])).map(([taskId, list]) => ({ taskId, commits: list })),
    excused: commits.filter((item) => item.binding === 'excused'),
    unbound: commits.filter((item) => item.binding === 'unbound')
  };
}

module.exports = { parseCommitBindings, readCommitBindings, commitsForTask, commitBindingSummary, DEFAULT_WINDOW };
