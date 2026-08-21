'use strict';

// 사람이 없는 동안 런을 미는 드라이버. 판정은 run-pending.js가 하고 여기서는
// 고르고 부르고 잰다.
//
// `rdl run drive`는 `--scheduled`가 daemon을 띄우지 않는다고 못박아 트리거를
// 바깥에 뒀다. 이 모듈이 그 바깥이다. tick도 원장도 그대로 두고, 몰 수 있는
// 런을 고르는 순회만 얹는다.
//
// 회전은 순차이며 동시에 도는 runDrive는 언제나 정확히 하나다. 희소 자원이
// 벽시계가 아니라 계정 사용량이기 때문이고, 바깥 타임아웃을 걸면 프로세스
// 트리를 죽여야 하는데 그 보장은 아직 열린 문제이기 때문이다. 드라이버는
// 시작한 드라이브를 반드시 끝까지 기다린다.

const { readRunFolds, classifyRun, progressWitness } = require('./run-pending');
const { loadHarnessSettings } = require('./harness-settings');

/**
 * 1관문 — 프로젝트 동의. 이것은 fold 판정이 **아니다**.
 *
 * AC-001이 요구하는 것은 "몰 수 있는 런의 판정"이고 프로젝트 동의는 런에 대한
 * 물음이 아니다. 이 구분을 적어 두지 않으면 다음 사람이 이 검사를 classifyRun에
 * 밀어 넣는다.
 *
 * 새 설정 키를 만들지 않는다. `drive.schedulerClientId`가 이미 그 뜻이고
 * 기본값이 null이므로, 아무것도 설정하지 않은 작업공간에서 드라이버는 한 런도
 * 몰지 않는다. 실제 강제는 여전히 preflight(src/run.js:1167)가 한다 — 여기는
 * 그 거절을 미리 걸러 조용하게 만드는 거름망이지 두 번째 판정자가 아니다.
 */
function projectConsents(start, projectKey, driverClientId) {
  let settings;
  try { settings = loadHarnessSettings(start, { project: projectKey }); }
  catch (error) { return false; }
  const configured = settings && settings.runtimeResolved && settings.runtimeResolved.drive && settings.runtimeResolved.drive.schedulerClientId;
  return Boolean(configured) && configured === driverClientId;
}

/**
 * 3관문 — 진행 증거. 원장이 움직이지 않은 채 돌아온 런을 다시 집지 않는다.
 *
 * 격리는 프로세스 기억이며 저장하지 않는다. 저장하면 새 저장 형식이 생기고 그
 * 형식은 원장이 이미 말하는 것을 다시 말한다. 프로세스가 죽으면 격리도 사라지고
 * 다음 기동이 한 번 더 시도한다 — 한 번은 뜨거운 순환이 아니다.
 *
 * 자기 해제가 핵심이다. 사람이 resume하거나 설정 표류를 고치면 fold가 움직이고
 * 다음 회전이 그 런을 다시 집는다. 백오프도 재시도 상한도 시계도 쓰지 않는다.
 */
function quarantined(quarantine, key, witness) {
  if (!quarantine.has(key)) return false;
  if (quarantine.get(key) === witness) return true;
  // 증거가 달라졌다 — 원장이 움직였으므로 격리를 푼다.
  quarantine.delete(key);
  return false;
}

function candidateKey(entry) {
  return `${entry.project.key}/${entry.runId}`;
}

/**
 * 회전 한 번. 관문 셋을 지나 후보 하나를 골라 몰고, 증거를 재고, 결과를 돌려준다.
 *
 * `dependencies.drive`로 `runDrive`를 주입할 수 있다. 시험이 자식 프로세스 없이
 * 판정을 재기 위해서이고, `test/drive.test.js`가 `deps.preflight`로 쓰는 것과
 * 같은 이음매다.
 */
async function driveRotation(start, options, dependencies) {
  const settings = options || {};
  const deps = dependencies || {};
  const drive = deps.drive || ((root, input) => require('./run').runDrive(root, input));
  const readFolds = deps.readRunFolds || readRunFolds;
  // 동의 조회도 주입한다. 관문 1은 fold가 아니라 설정을 읽으므로, 주입하지 않으면
  // 관문의 순서를 재는 시험이 작업공간과 harness.json을 통째로 세워야 한다.
  const consents = deps.projectConsents || projectConsents;
  const quarantine = settings.quarantine instanceof Map ? settings.quarantine : new Map();
  const clientId = settings.clientId;

  const read = readFolds(start, settings.project ? { project: settings.project } : {});
  const skipped = { consent: 0, notDrivable: 0, quarantined: 0 };
  let chosen = null;

  for (const entry of read.runs) {
    // 관문 1 — 동의하지 않은 프로젝트의 런은 접지도 않는다.
    if (!consents(start, entry.project.key, clientId)) { skipped.consent += 1; continue; }
    // 관문 2 — classifyRun의 drivable, 그대로. 아무것도 더하지 않는다.
    const verdict = classifyRun(entry.fold, entry.liveness);
    if (!verdict || verdict.bucket !== 'drivable') { skipped.notDrivable += 1; continue; }
    // 관문 3 — 전진하지 않은 채 돌아온 런은 건너뛴다.
    const witness = progressWitness(entry.fold);
    if (quarantined(quarantine, candidateKey(entry), witness)) { skipped.quarantined += 1; continue; }
    chosen = { entry, witness };
    break;
  }

  if (!chosen) {
    return { workspace: read.workspace, drove: false, skipped, unreadable: read.unreadable, quarantineSize: quarantine.size };
  }

  const { entry, witness } = chosen;
  let outcome;
  // preflight의 던짐과 전진 없는 반환을 한 관문으로 처리한다. 일곱 가지 던짐이
  // 각각 다른 오류를 내지만 드라이버에게는 전부 "원장이 안 움직였다"이다.
  try {
    outcome = await drive(start, {
      run: entry.runId, project: entry.project.key, clientId, scheduled: true
    });
  } catch (error) {
    outcome = { exitCode: 2, status: 'rejected', reason: error.message };
  }

  // 증거를 다시 잰다. 몰기 전 fold가 아니라 지금 원장을 다시 읽는다 — 드라이브가
  // 무엇을 남겼는지는 반환값이 아니라 원장이 말한다.
  const after = readFolds(start, { project: entry.project.key });
  const moved = after.runs.find((item) => item.runId === entry.runId) || null;
  const afterWitness = moved ? progressWitness(moved.fold) : null;
  const advanced = afterWitness !== witness;
  if (!advanced) quarantine.set(candidateKey(entry), witness);

  return {
    workspace: read.workspace,
    drove: true,
    project: entry.project.key,
    runId: entry.runId,
    status: outcome && outcome.status,
    reason: outcome && outcome.reason,
    advanced,
    skipped,
    unreadable: read.unreadable,
    quarantineSize: quarantine.size
  };
}

/**
 * 상주 루프. 잠금 하나를 쥐고 회전을 반복한다.
 *
 * 잠금 이름이 `driver-workspace`인 이유는 AC-004의 "하나"를 이름으로 강제하기
 * 위해서다. `workspace`는 예약된 프로젝트 키라 실제 프로젝트가 될 수 없으므로
 * (src/workspace.js:76), 이 잠금은 어떤 프로젝트의 잠금과도 충돌하지 않고
 * 이름 자체가 "작업공간 하나에 드라이버 하나"라고 말한다. 두 번째 드라이버는
 * 잠금에서 즉시 거절되며 누가 쥐고 있는지 pid를 말한다.
 *
 * `fs.watch`를 쓰지 않는다. 드라이버를 깨우는 것은 파일 변경이 아니라 원장
 * 상태이고, 원장은 다른 기계에서 git으로도 들어온다. 파일 감시는 그 경로를
 * 보지 못한다.
 *
 * 런별 배타는 `runDrive`가 이미 잡는 잠금이 한다. 드라이버는 그 위에 아무것도
 * 더하지 않는다.
 */
async function runDriver(start, options, dependencies) {
  const settings = options || {};
  const deps = dependencies || {};
  const rotate = deps.driveRotation || driveRotation;
  const runtime = deps.runtime || require('./runtime');
  const timers = { set: deps.setTimeout || setTimeout, clear: deps.clearTimeout || clearTimeout };
  const intervalMs = Math.max(5, Number(settings.interval) || 60) * 1000;
  // 격리는 프로세스 기억이다. 호출자가 넘길 수 있어야 --once를 이어 부르는
  // 시험이 격리를 관찰한다.
  const quarantine = settings.quarantine instanceof Map ? settings.quarantine : new Map();

  const rotateOnce = () => rotate(start, {
    clientId: settings.clientId, project: settings.project, quarantine
  }, deps);

  if (settings.once === true) {
    const result = await rotateOnce();
    return Object.assign({ once: true }, result);
  }

  const workspace = deps.runtimeWorkspace ? deps.runtimeWorkspace(start) : runtime.runtimeWorkspace(start);
  const lock = await runtime.acquireProcessLock(workspace, 'driver-workspace');
  const controller = settings.signal ? null : new AbortController();
  const signal = settings.signal || controller.signal;
  const interrupt = () => controller && controller.abort();
  if (controller) {
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
  }
  if (runtime.bindProcessLockSignals) runtime.bindProcessLockSignals(lock);

  let rotations = 0;
  try {
    while (!signal.aborted) {
      await rotateOnce();
      rotations += 1;
      if (signal.aborted) break;
      // 유휴 회전은 아무것도 쓰지 않는다. 상주 프로세스가 회전마다 한 줄씩 쓰면
      // 로그는 곧 읽히지 않고, 읽히지 않는 표면은 없는 것과 같다.
      await new Promise((resolve) => {
        const timer = timers.set(resolve, intervalMs);
        signal.addEventListener('abort', () => { timers.clear(timer); resolve(); }, { once: true });
      });
    }
  } finally {
    if (controller) {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
    if (typeof lock === 'function') await lock();
    else if (lock && typeof lock.release === 'function') await lock.release();
  }
  return { once: false, rotations, quarantineSize: quarantine.size };
}

module.exports = { driveRotation, runDriver, projectConsents };
