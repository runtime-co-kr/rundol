'use strict';

/**
 * "지금 누가 무엇을 해야 하는가"에 답한다. `run list`는 "이 프로젝트에 런이 무엇이
 * 있는가"를 묻고 fold 전체를 돌려주므로 세션 시작마다 주입할 수 없다. 두 물음을
 * 한 명령으로 접으면 둘 중 하나가 다른 하나의 옵션이 되고, 옵션이 된 쪽은
 * 기본값으로 죽는다.
 *
 * 갈래는 임의의 분류가 아니라 드라이버가 물어야 할 선택기 그 자체다 — 사람만
 * 풀 수 있는가(waiting), 기계가 이을 수 있는가(drivable), 이미 누가 몰고
 * 있는가(driving). 그래서 훅과 드라이버가 같은 판정을 한 곳에서 읽는다.
 */

const fs = require('fs');
const path = require('path');
const ledger = require('./run-ledger');
const driverLease = require('./driver-lease');
const runtime = require('./runtime');
const { findWorkspaceRoot, workspaceLayout, listProjects } = require('./workspace');
const session = require('./session');

// 사유의 정본은 원장이다. HALT_REASONS(src/run-ledger.js)를 여기서 다시
// 정의하지 않고 fold가 준 haltReason을 그대로 나른다.
const HUMAN_GATE = 'human-gate';
const SYNC_PENDING = 'sync-pending';

function quote(value) {
  return `<${value}>`;
}

function runArgs(fold) {
  return `--run ${fold.runId} --project ${fold.projectId}`;
}

/**
 * 갈래마다 그대로 붙여 실행할 수 있는 한 줄을 만든다. 훅이 쓸모 있으려면 다음
 * 명령을 모델이 유도하지 않아도 되어야 한다. 사람이 채워야 하는 값만 <>로 남긴다.
 */
function recoveryCommand(fold, reason) {
  const base = runArgs(fold);
  if (reason === HUMAN_GATE) return `rdl run approve ${base} --client-id ${quote('human-client-id')} --reason ${quote('사유')}`;
  if (reason === SYNC_PENDING) return `rdl sync --project ${fold.projectId} --client-id ${quote('client-id')}`;
  if (reason === 'ownership-conflict') {
    const conflict = fold.ownershipConflict && fold.ownershipConflict.conflictId;
    return `rdl run ownership resolve ${base} --conflict ${conflict || quote('digest')} --select ${quote('event-id')} --client-id ${quote('client-id')} --reason ${quote('사유')}`;
  }
  if (reason === 'operation-conflict') {
    const conflict = (fold.operationConflicts || [])[0] || null;
    const operation = conflict ? conflict.operationId : null;
    const digest = conflict ? conflict.conflictId : null;
    return `rdl run operation resolve ${base} --operation ${operation || quote('operation-id')} --conflict ${digest || quote('digest')} --select ${quote('event-id')} --client-id ${quote('client-id')} --reason ${quote('사유')}`;
  }
  return `rdl run resume ${base} --client-id ${quote('client-id')}`;
}

/**
 * 순수 함수다. 파일 시스템도 git도 만지지 않는다 — 갈래 판정을 픽스처 작업공간
 * 없이 시험으로 못 박을 수 있는 유일한 형태이며, 판정이 읽기 경로와 얽히면
 * 나중에 드라이버가 같은 물음에 두 번째 답을 갖게 된다.
 *
 * @param fold      ledger.foldRun 또는 foldSharedRun의 결과
 * @param liveness  { lease: boolean, lock: boolean } — 지금 이 런을 실제로 몰고
 *                  있는 사슬이 있는지. 호출자가 읽어서 넣는다.
 * @returns { bucket, reason, command } 또는 출력 대상이 아니면 null
 */
function classifyRun(fold, liveness) {
  if (!fold || !fold.status) return null;
  if (fold.status === 'missing') return null;

  // 해결되지 않은 operation 충돌은 상태가 무엇이든 먼저 나온다. 원장이 이 목록을
  // completed_local·synced에서도 비우지 않는 이유가 "목록을 비우면 충돌의 증거
  // 자체가 모든 소비자에게서 사라진다"이므로(src/run-ledger.js:1050), 여기서
  // 떨어뜨리면 이 명령이 바로 그 소비자가 된다. 완료한 런에 붙은 충돌에
  // "sync 하세요"라고 답하는 것은 틀린 안내다.
  if ((fold.operationConflicts || []).length) return { bucket: 'waiting', reason: 'operation-conflict', command: recoveryCommand(fold, 'operation-conflict') };

  // 병합까지 살아남은 런은 아무에게도 일을 만들지 않는다.
  if (fold.status === 'synced') return null;

  const live = Boolean(liveness && (liveness.lease || liveness.lock));

  // 이미 몰고 있는 런을 waiting이나 drivable로 내면, 훅이 돌고 있는 런을 다시
  // 몰라고 말한다. 사람 출력에는 넣지 않고 --json에만 실어 드라이버가 구별한다.
  if (live) return { bucket: 'driving', reason: 'driver-active', command: null };

  if (fold.status === 'halted') {
    const reason = fold.haltReason || 'manual';
    return { bucket: 'waiting', reason, command: recoveryCommand(fold, reason) };
  }
  if (fold.status === 'ownership-conflict') return { bucket: 'waiting', reason: 'ownership-conflict', command: recoveryCommand(fold, 'ownership-conflict') };
  if (fold.status === 'operation-conflict') return { bucket: 'waiting', reason: 'operation-conflict', command: recoveryCommand(fold, 'operation-conflict') };
  // 런의 완료는 저장이 아니라 병합 생존이다. completed_local은 아직 끝이 아니다.
  if (fold.status === 'completed_local') return { bucket: 'waiting', reason: SYNC_PENDING, command: recoveryCommand(fold, SYNC_PENDING) };

  if (fold.status !== 'running') return null;
  // 전진할 스텝이 없는 running은 완료 직전이거나 원장이 덜 접힌 것이다. 어느
  // 쪽이든 지금 누구에게도 일을 만들지 않는다.
  if (!fold.cursor || !fold.cursorStep) return null;

  // 사람 게이트 판정은 fold 안에서 끝난다. cursorStep이 결의된 스텝 객체를 들고
  // 있으므로 절차를 다시 결의할 필요가 없다 — 다시 결의하면 판정자가 둘이 된다.
  if (fold.cursorStep.human === true) return { bucket: 'waiting', reason: HUMAN_GATE, command: recoveryCommand(fold, HUMAN_GATE) };

  // 활성 소유권이 없으면 누구의 것도 아니다. *-conflict 상태와 같은 말이지만
  // 상태가 그것을 덮지 못하는 경로가 있으므로 명시한다.
  if (!fold.owner) return null;

  // 시도 예산은 여기서 세지 않는다. src/run-ledger.js가 예산 소진을 이미
  // status: halted / haltReason: attempt-limit으로 접는다.
  return { bucket: 'drivable', reason: 'cursor-ready', command: `rdl run drive ${runArgs(fold)} --client-id ${quote('agent-or-service-client-id')}` };
}

/**
 * 원장이 움직였는지를 재는 증거. 드라이버가 같은 런을 무한히 다시 미는 것을
 * 막는 유일한 수단이다.
 *
 * `runDrive`가 돌아왔는데 원장에 아무것도 남지 않는 경로가 여덟 있다 —
 * `ownership_lost`, `termination-unsafe`, gate·verification 환경 오류 넷,
 * 그리고 preflight의 던짐들. 그 런은 여전히 drivable이므로 다음 회전에 다시
 * 뽑히고 같은 자리에서 같은 일이 일어난다.
 *
 * `termination-unsafe`가 남을 수 없다는 것은 추측이 아니다. HALT_REASONS에
 * 그 값이 없어 기록하려 해도 거부된다. 그리고 Windows에서는 그것이 예외가
 * 아니라 기본 경로다 — terminationGuaranteed()가 옵트인 없이는 false다.
 *
 * 네 필드를 보며 하나라도 빼면 놓치는 경로가 생긴다.
 * - status: 위 여덟이 아닌 정상 종료 전부
 * - cursor: running 안에서의 전진
 * - completedSteps: 커서가 같은 id로 돌아왔으나 완료 집합이 다른 경우
 * - attempts: onFail.goto가 커서와 완료 집합을 같은 자리로 되돌린 경우
 *
 * 시계도 백오프도 재시도 상한도 쓰지 않는다. 상태가 바뀌었는지만 묻고, 그
 * 답은 fold 필드에서만 나온다.
 */
function progressWitness(fold) {
  if (!fold || !fold.status) return null;
  return ledger.canonicalJson([fold.status, fold.cursor || null, fold.completedSteps || [], fold.attempts || {}]);
}

/**
 * 지금 이 런을 실제로 몰고 있는 사슬이 있는지 본다. 판정은 이미 있는 것을 읽기만
 * 하고 새로 정의하지 않는다 — 활성의 정의는 driver-lease가 갖는다.
 *
 * 잠금을 잡지 않는다. `acquireProcessLock`을 부르면 상태를 묻는 명령이 상태를
 * 바꾼다.
 */
function driverLeaseActive(layout, projectKey, runId) {
  // schemaVersion 6 미만에는 정본 driver 이벤트 저장소가 없다. 없는 것은 활성이
  // 아니다.
  if (!layout || layout.schemaVersion < 6) return false;
  const eventsRoot = path.join(layout.root, 'projects', 'workspace', 'events');
  if (!fs.existsSync(eventsRoot)) return false;
  return driverLease.foldDriverLeases(driverLease.readDriverEvents(eventsRoot, projectKey, runId)).activeLeases.length > 0;
}

function driveLockAlive(layout, projectKey, runId) {
  let locks;
  try { locks = runtime.runtimeWorkspace(layout.root).locks; } catch (error) { return false; }
  // src/run.js:1184가 `drive-${project.key}-${run.toLowerCase()}`를 잠금 키로 쓴다.
  const file = path.join(locks, `drive-${projectKey}-${String(runId).toLowerCase()}.lock`);
  if (!fs.existsSync(file)) return false;
  let record;
  // 손상된 잠금은 누가 몰고 있다는 증거가 아니다. 그것을 활성으로 읽으면 깨진
  // 파일 하나가 런을 영영 숨긴다.
  try { record = runtime.readProcessLock(file); } catch (error) { return false; }
  return runtime.processIsAlive(record.pid);
}

/**
 * 로컬 원장과 공유 샤드를 합쳐 런 ID를 모은다. `.rundol/runs`는 git으로 전파되지
 * 않으므로 로컬만 세면 다른 기계가 시작한 런이 새 클론에서 영영 보이지 않는다.
 */
function runIdsFor(layout, project) {
  const ids = new Set();
  const root = ledger.runsRoot(project.root);
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) if (ledger.RUN_ID.test(name)) ids.add(name);
  }
  for (const runId of ledger.listSharedRunIds(layout, project.key)) ids.add(runId);
  return Array.from(ids).sort();
}

function item(project, fold, verdict) {
  return {
    project: project.key,
    runId: fold.runId,
    procedure: fold.procedure ? fold.procedure.name : null,
    cursor: fold.cursor || null,
    reason: verdict.reason,
    command: verdict.command
  };
}

/**
 * 작업공간 전체를 훑어 갈래별 목록을 만든다. 쓰지 않는다.
 *
 * `runContext`(src/run.js:18)를 쓰지 않는 이유가 여기 있다 — 그 함수는
 * `reconcileRun`을 부르고 reconcile은 원장에 append한다. 세션 시작마다 도는
 * 명령이 원장을 고치면, 무엇이 주의를 요구하는지 묻는 행위가 원장을 바꾸는
 * 행위가 된다. 보는 것과 고치는 것은 다른 일이다.
 */
function readRunFolds(start, options) {
  const settings = options || {};
  // 작업공간을 못 찾아도 세션은 답해야 하므로 빈 결과에 세션 자리를 함께 둔다.
  const empty = { workspace: null, waiting: [], drivable: [], driving: [], unreadable: [], sessions: [] };

  // 작업공간이 없는 것과 깨진 것은 다르다. 없는 곳에서 훅이 도는 것은 정상이며
  // "런이 없다"가 그 물음의 옳은 답이다. 깨진 것은 findWorkspaceRoot 다음에서
  // 던져 호출자가 2로 끝내게 둔다.
  let root;
  // 작업공간을 못 찾아도 세션은 답한다. 세션 worktree에는 projects/가 없으므로 여기서
  // 접으면, 정작 격리된 세션이 "나 말고 누가 있나"를 물을 수 없다 — 그 물음은 Rundol
  // 작업공간이 아니라 Git만 있으면 답할 수 있다.
  //
  // 다만 이 함수가 내는 모양은 런을 접은 결과다. 드라이버가 layout과 runs를 쓰므로
  // 그 둘을 비워서라도 담고, 세션은 곁들이로 얹는다.
  try { root = findWorkspaceRoot(start); } catch (error) { return { workspace: null, layout: null, runs: [], unreadable: [], sessions: liveSessions(start) }; }
  const layout = workspaceLayout(root);

  const all = listProjects(layout);
  const projects = settings.project ? all.filter((project) => project.key === settings.project) : all;
  if (settings.project && !projects.length) throw new Error(`${settings.project} 프로젝트를 작업공간에서 찾지 못했습니다.`);

  const runs = [];
  const unreadable = [];
  for (const project of projects) {
    for (const runId of runIdsFor(layout, project)) {
      // 한 런의 손상이 나머지를 멀게 하지 않는다. 전체를 던지면 깨진 런 하나가
      // 나머지 전부를 감추고, 그 사실을 아무도 모른다.
      try {
        const local = ledger.readRunEvents(ledger.runDirectory(project.root, runId));
        const shared = ledger.readSharedRunEvents(layout, project.key, runId);
        const events = ledger.unionRunEvents(local, shared);
        const fold = shared.length ? ledger.foldSharedRun(events) : ledger.foldRun(events);
        const liveness = { lease: driverLeaseActive(layout, project.key, runId), lock: driveLockAlive(layout, project.key, runId) };
        runs.push({ project, runId, fold, liveness });
      } catch (error) {
        unreadable.push({ project: project.key, runId, reason: 'unreadable', detail: error.message });
      }
    }
  }
  return { workspace: layout.root, layout, runs, unreadable, sessions: liveSessions(layout.root) };
}

function pendingRuns(start, options) {
  const read = readRunFolds(start, options);
  const result = { workspace: read.workspace, waiting: [], drivable: [], driving: [], unreadable: read.unreadable };
  for (const entry of read.runs) {
    const verdict = classifyRun(entry.fold, entry.liveness);
    if (!verdict) continue;
    result[verdict.bucket].push(item(entry.project, entry.fold, verdict));
  }
  // 세션은 런과 같은 물음의 다른 축이다. 접은 결과가 이미 담고 있으므로 다시 읽지 않는다.
  result.sessions = read.sessions || [];
  return result;
}

/**
 * 이 작업공간에 지금 붙어 있는 세션. 런과 같은 물음의 다른 축이다 — 무엇이 사람을
 * 기다리는가 옆에 누가 같이 있는가가 있어야 한다.
 *
 * 같은 저장소에서 세션 여럿이 부딪힌 사고는 전부 사후에 발견됐다. 시작할 때 아무도
 * 몰랐다는 것이 공통점이고, 이 목록이 채우려는 자리가 그것이다.
 *
 * 읽기만 한다. 등록은 세션 시작이 하고 여기서는 잠금 파일을 읽을 뿐이다 — 조회가
 * 등록을 겸하면 무엇이 주의를 요구하는지 묻는 행위가 상태를 바꾼다.
 */
function liveSessions(root) {
  try {
    return session.listSessions(root).sessions.filter((entry) => entry.alive === true)
      .map((entry) => ({ short: entry.short, branch: entry.branch, path: entry.path, sessionPid: entry.sessionPid }));
  } catch (error) {
    // 세션을 읽지 못한 것이 런을 못 읽은 것으로 번지면 안 된다. 이 줄은 곁들이
    // 정보이므로, 없으면 없는 채로 런의 답을 낸다.
    return [];
  }
}

module.exports = { classifyRun, progressWitness, readRunFolds, pendingRuns, liveSessions };
