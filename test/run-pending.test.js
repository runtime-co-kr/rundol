'use strict';

// 갈래 판정만 잰다. classifyRun은 순수 함수이므로 픽스처 작업공간 없이 fold
// 모양만으로 계약을 못 박을 수 있다 — 읽기 경로가 끼어들기 전에 판정을 고정하는
// 것이 목적이다.

const assert = require('assert');
const { classifyRun } = require('../src/run-pending');

function fold(overrides) {
  return Object.assign({
    runId: 'RUN-0123456789ABCDEF0123',
    projectId: 'memo',
    status: 'running',
    cursor: 'create',
    cursorStep: { id: 'create', human: false },
    owner: 'laptop-a',
    haltReason: null,
    ownershipConflict: null,
    operationConflicts: []
  }, overrides || {});
}

const IDLE = { lease: false, lock: false };

// 끝난 런과 없는 런은 아무에게도 일을 만들지 않는다.
assert.strictEqual(classifyRun(fold({ status: 'synced' }), IDLE), null);
assert.strictEqual(classifyRun(fold({ status: 'missing', cursor: null, cursorStep: null }), IDLE), null);
assert.strictEqual(classifyRun(null, IDLE), null);

// 이미 몰고 있는 런은 waiting도 drivable도 아니다. 리스와 프로세스 잠금 어느
// 쪽이든 살아 있으면 같은 답을 낸다 — 둘은 같은 사실의 두 증거다.
for (const liveness of [{ lease: true, lock: false }, { lease: false, lock: true }, { lease: true, lock: true }]) {
  const driving = classifyRun(fold(), liveness);
  assert.strictEqual(driving.bucket, 'driving');
  assert.strictEqual(driving.command, null, 'driving은 사람이 칠 명령을 주지 않는다');
}
// 사람 게이트에 선 런도 누가 몰고 있는 동안에는 driving이다. 그 드라이버가 곧
// waiting_human으로 멈추고 리스를 놓으면 다음 조회가 waiting으로 낸다.
assert.strictEqual(classifyRun(fold({ cursorStep: { id: 'approve', human: true } }), { lease: true, lock: false }).bucket, 'driving');

// 정지 사유의 정본은 원장이다. 여기서 다시 정의하지 않고 그대로 나른다.
for (const reason of ['gate-failed', 'step-failed', 'merge-conflict', 'sync-failed', 'adapter-timeout', 'lease-lost', 'attempt-limit', 'manual', 'settings-drift', 'legacy-conflict', 'verification-required']) {
  const halted = classifyRun(fold({ status: 'halted', haltReason: reason }), IDLE);
  assert.strictEqual(halted.bucket, 'waiting');
  assert.strictEqual(halted.reason, reason, '정지 사유는 그대로 나른다');
  assert.ok(halted.command.startsWith('rdl run resume --run RUN-0123456789ABCDEF0123 --project memo'));
}

// 시도 예산은 여기서 세지 않는다. fold가 예산 소진을 halted/attempt-limit으로
// 접으므로, 상한에 걸린 런은 drivable이 아니라 waiting으로 나온다. 다시 세면
// 같은 물음에 판정자가 둘이 되고 둘은 언젠가 어긋난다.
const exhausted = classifyRun(fold({ status: 'halted', haltReason: 'attempt-limit', attempts: { create: 99 } }), IDLE);
assert.strictEqual(exhausted.bucket, 'waiting');
assert.strictEqual(exhausted.reason, 'attempt-limit');

// 복구 명령은 사람이 다시 조회하지 않아도 되게 충돌 식별자를 싣는다. 싣지 않으면
// 이 목록은 안내가 아니라 알림이 된다.
const ownership = classifyRun(fold({ status: 'ownership-conflict', ownershipConflict: { conflictId: 'deadbeef' } }), IDLE);
assert.strictEqual(ownership.bucket, 'waiting');
assert.strictEqual(ownership.reason, 'ownership-conflict');
assert.ok(ownership.command.includes('--conflict deadbeef'), '소유권 충돌 식별자를 싣는다');

const operation = classifyRun(fold({ status: 'operation-conflict', operationConflicts: [{ operationId: 'OP-7', conflictId: 'cafe1234' }] }), IDLE);
assert.strictEqual(operation.reason, 'operation-conflict');
assert.ok(operation.command.includes('--operation OP-7'), 'operation 식별자를 싣는다');
assert.ok(operation.command.includes('--conflict cafe1234'));

// 원장은 completed_local·synced에서도 충돌 목록을 비우지 않는다 — 비우면 충돌의
// 증거가 모든 소비자에게서 사라지기 때문이다(src/run-ledger.js:1050). 그 상태에서
// 상태만 보고 "sync 하세요"라고 답하면 이 명령이 바로 그 소비자가 된다.
for (const status of ['completed_local', 'synced']) {
  const lingering = classifyRun(fold({ status, cursor: null, cursorStep: null, operationConflicts: [{ operationId: 'OP-9', conflictId: 'beef0001' }] }), IDLE);
  assert.strictEqual(lingering.bucket, 'waiting', `${status}에 남은 충돌은 사라지지 않는다`);
  assert.strictEqual(lingering.reason, 'operation-conflict');
  assert.ok(lingering.command.includes('--operation OP-9'));
}
// 충돌은 누가 몰고 있어도 사람의 판단을 기다린다. 드라이버는 후보를 임의로
// 선택하지 않는다.
assert.strictEqual(classifyRun(fold({ operationConflicts: [{ operationId: 'OP-9', conflictId: 'beef0001' }] }), { lease: true, lock: false }).reason, 'operation-conflict');

// 런의 완료는 저장이 아니라 병합 생존이다. completed_local은 아직 끝이 아니다.
const local = classifyRun(fold({ status: 'completed_local', cursor: null, cursorStep: null }), IDLE);
assert.strictEqual(local.bucket, 'waiting');
assert.strictEqual(local.reason, 'sync-pending');
assert.ok(local.command.startsWith('rdl sync --project memo'));

// 사람 게이트 판정은 fold 안에서 끝난다. cursorStep이 결의된 스텝 객체를 들고
// 있으므로 절차를 다시 결의하지 않는다.
const human = classifyRun(fold({ cursorStep: { id: 'approve', human: true } }), IDLE);
assert.strictEqual(human.bucket, 'waiting');
assert.strictEqual(human.reason, 'human-gate');
assert.ok(human.command.startsWith('rdl run approve --run'));

// 전진할 스텝이 없는 running은 지금 누구에게도 일을 만들지 않는다.
assert.strictEqual(classifyRun(fold({ cursor: null }), IDLE), null);
assert.strictEqual(classifyRun(fold({ cursorStep: null }), IDLE), null);

// 활성 소유권이 없으면 누구의 것도 아니다.
assert.strictEqual(classifyRun(fold({ owner: null }), IDLE), null);

// 남은 하나가 기계가 이을 수 있는 런이다.
const drivable = classifyRun(fold(), IDLE);
assert.strictEqual(drivable.bucket, 'drivable');
assert.strictEqual(drivable.reason, 'cursor-ready');
assert.ok(drivable.command.startsWith('rdl run drive --run RUN-0123456789ABCDEF0123 --project memo'));

// ── CLI 계약 ──────────────────────────────────────────────────────────────
// 침묵과 작업공간 전체 열거는 프로세스 밖에서만 잴 수 있다. 훅이 보는 것이
// stdout이므로 stdout으로 잰다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.join(__dirname, '..', 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-run-pending-'));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function pendingRaw(args) {
  return spawnSync(process.execPath, [cli, 'run', 'pending'].concat(args || [], ['--root', temporary]), { cwd: temporary, encoding: 'utf8' });
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), temporary));
}

try {
  const bare = path.join(temporary, 'origin.git');
  command('git', ['init', '--bare', '--initial-branch=main', bare], temporary);
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  command('git', ['remote', 'add', 'origin', bare], temporary);
  command('git', ['push', 'origin', 'main'], temporary);
  rdl(['init', 'crm', '--name', '고객 관리', '--profile', 'lean']);

  // 침묵이 계약이다. 이 명령은 세션이 열릴 때마다 도는 자리에 쓰이므로 할 일이
  // 없을 때 한 글자라도 쓰면 그 표면은 곧 읽히지 않는다.
  const silent = pendingRaw();
  assert.strictEqual(silent.status, 0, silent.stderr);
  assert.strictEqual(silent.stdout, '', '주의를 요구하는 런이 없으면 stdout은 빈 문자열이다');

  // --json은 침묵하지 않는다. 기계 소비자는 "없음"과 "못 물어봄"을 갈라야 한다.
  const empty = pendingRaw(['--json']);
  assert.strictEqual(empty.status, 0, empty.stderr);
  const parsed = JSON.parse(empty.stdout);
  assert.deepStrictEqual(parsed.waiting, []);
  assert.deepStrictEqual(parsed.drivable, []);
  assert.deepStrictEqual(parsed.driving, []);
  assert.deepStrictEqual(parsed.unreadable, []);

  // 없는 프로젝트를 필터로 주면 조용히 비는 것이 아니라 인자 오류다. 조용히
  // 비면 오타 하나가 "할 일 없음"으로 읽힌다.
  const unknown = pendingRaw(['--project', 'nosuch', '--json']);
  assert.strictEqual(unknown.status, 2);

  // 손상 격리. 한 런이 깨져도 나머지는 계속 보고되고, 깨진 런은 드러난다.
  const runs = path.join(temporary, 'projects', 'crm', '.rundol', 'runs');
  const brokenId = 'RUN-FEDCBA98765432100000';
  fs.mkdirSync(path.join(runs, brokenId), { recursive: true });
  fs.writeFileSync(path.join(runs, brokenId, 'events.jsonl'), '{ 이것은 JSON이 아니다\n');
  const damaged = pendingRaw(['--json']);
  assert.strictEqual(damaged.status, 0, damaged.stderr);
  const damagedResult = JSON.parse(damaged.stdout);
  assert.strictEqual(damagedResult.unreadable.length, 1, '깨진 런은 unreadable로 드러난다');
  assert.strictEqual(damagedResult.unreadable[0].runId, brokenId);

  // 깨진 런은 사람 출력에서도 사라지지 않는다. 감추면 그 사실을 아무도 모른다.
  const damagedHuman = pendingRaw();
  assert.strictEqual(damagedHuman.status, 0);
  assert.ok(damagedHuman.stdout.includes(brokenId), '읽지 못한 런은 사람 출력에도 나온다');

  // 작업공간 전체. 프로젝트 둘에 각각 런이 있을 때 --project 없이 둘 다 나온다.
  // run list가 --project를 강제하는 것과 대비되는 지점이므로 같은 픽스처에서 잰다.
  rdl(['project', 'add', 'memo', '--name', '메모']);
  const memoBroken = 'RUN-AAAABBBBCCCCDDDD0000';
  const memoRuns = path.join(temporary, 'projects', 'memo', '.rundol', 'runs', memoBroken);
  fs.mkdirSync(memoRuns, { recursive: true });
  fs.writeFileSync(path.join(memoRuns, 'events.jsonl'), '{ 또 다른 파손\n');

  const both = JSON.parse(pendingRaw(['--json']).stdout);
  assert.ok(both.workspace, '작업공간 경로를 싣는다');
  const projectsSeen = new Set(both.unreadable.map((entry) => entry.project));
  assert.deepStrictEqual(Array.from(projectsSeen).sort(), ['crm', 'memo'], '--project 없이 두 프로젝트를 모두 훑는다');

  const filtered = JSON.parse(pendingRaw(['--project', 'crm', '--json']).stdout);
  assert.deepStrictEqual(filtered.unreadable.map((entry) => entry.runId), [brokenId], '--project는 열거 결과에 거는 필터다');
  const other = JSON.parse(pendingRaw(['--project', 'memo', '--json']).stdout);
  assert.deepStrictEqual(other.unreadable.map((entry) => entry.runId), [memoBroken], '다른 프로젝트의 런은 걸러진다');

  // 같은 픽스처에서 run list는 --project 없이 거부한다. 두 명령이 다른 물음을
  // 묻는다는 사실이 인터페이스에도 드러나야 한다.
  const listRefused = spawnSync(process.execPath, [cli, 'run', 'list', '--root', temporary, '--json'], { cwd: temporary, encoding: 'utf8' });
  assert.notStrictEqual(listRefused.status, 0, 'run list는 프로젝트를 강제한다');

  // 발견 표면. SKILL.md가 "명령을 모르면 rdl help --json을 돌리고 CLI 소스는
  // 읽지 말라"고 못 박았으므로, 이 카탈로그에 없는 명령은 에이전트에게 없는 것이다.
  const help = command(process.execPath, [cli, 'help', '--json'], temporary);
  assert.ok(help.includes('run pending'), 'rdl help --json 카탈로그에 run pending이 있다');

  // ── 살아 있는 실행이 있으면 drivable이 아니다 ──────────────────────────
  // 흉내가 아니라 실물로 잰다. 실제 런을 시작하고, 실제 잠금과 실제 리스를 쥔다.
  rdl(['client', 'register', 'agent-a', '--name', '저작 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);
  const started = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'agent-a', '--goal', '개입 대기 조회 시험']);
  const runId = started.runId || (started.run && started.run.runId);
  assert.ok(runId, `런 ID를 얻지 못했습니다: ${JSON.stringify(started).slice(0, 200)}`);

  const bucketOf = (id) => {
    const result = JSON.parse(pendingRaw(['--json']).stdout);
    for (const bucket of ['waiting', 'drivable', 'driving']) {
      if (result[bucket].some((entry) => entry.runId === id)) return bucket;
    }
    return null;
  };
  assert.strictEqual(bucketOf(runId), 'drivable', '갓 시작한 런의 커서는 사람 게이트가 아니므로 기계가 이을 수 있다');

  // 프로세스 잠금. src/run.js가 쓰는 키 규칙 그대로 실제로 쥔다.
  const runtime = require('../src/runtime');
  const workspace = runtime.runtimeWorkspace(temporary);
  const release = runtime.acquireProcessLock(workspace, `drive-crm-${runId.toLowerCase()}`);
  try {
    assert.strictEqual(bucketOf(runId), 'driving', '살아 있는 drive 잠금이 있으면 몰라고 말하지 않는다');
  } finally {
    if (typeof release === 'function') release();
    else if (release && typeof release.release === 'function') release.release();
  }
  assert.strictEqual(bucketOf(runId), 'drivable', '잠금을 놓으면 다시 이을 수 있다');

  // driver 리스. 만료는 시계 비교이므로 시각을 직접 심는다.
  const { appendDriverEvent } = require('../src/driver-lease');
  const eventsRoot = path.join(temporary, 'projects', 'workspace', 'events');
  const leaseIds = {
    rootRequestId: 'REQ-11111111111111111111', requestId: 'REQ-22222222222222222222',
    clientId: 'agent-a', projectId: 'crm', runId,
    leaseId: 'LEASE-0123456789ABCDEF0123', ownerToken: 'EVT-AAAAAAAAAAAAAAAAAAAA'
  };
  appendDriverEvent(eventsRoot, Object.assign({ schemaVersion: 1, eventId: 'EVT-11111111111111111111', type: 'driver.acquired', expiresAt: '2100-01-01T00:00:00.000Z' }, leaseIds));
  assert.strictEqual(bucketOf(runId), 'driving', '활성 리스가 있으면 몰라고 말하지 않는다');

  appendDriverEvent(eventsRoot, Object.assign({ schemaVersion: 1, eventId: 'EVT-22222222222222222222', type: 'driver.released', previousDriverEventId: 'EVT-11111111111111111111', reason: 'completed' }, leaseIds));
  assert.strictEqual(bucketOf(runId), 'drivable', '리스를 놓으면 다시 이을 수 있다');

  // 만료한 리스는 살아 있다는 증거가 아니다.
  appendDriverEvent(eventsRoot, Object.assign({ schemaVersion: 1, eventId: 'EVT-33333333333333333333', type: 'driver.acquired', expiresAt: '2000-01-01T00:00:00.000Z' }, leaseIds, { leaseId: 'LEASE-FEDCBA98765432100000' }));
  assert.strictEqual(bucketOf(runId), 'drivable', '만료한 리스는 실행 중이라는 뜻이 아니다');

  // ── 읽기 전용 증명 ────────────────────────────────────────────────────
  // runContext를 타면 reconcile이 원장에 append한다. 무엇이 주의를 요구하는지
  // 묻는 행위가 원장을 바꾸면, 보는 것과 고치는 것이 같은 일이 된다.
  const snapshot = () => {
    const files = [];
    const walk = (directory) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push([full, fs.readFileSync(full), fs.statSync(full).mtimeMs]);
      }
    };
    walk(path.join(temporary, 'projects', 'crm', '.rundol', 'runs'));
    walk(eventsRoot);
    return files.sort((left, right) => left[0].localeCompare(right[0]));
  };
  const before = snapshot();
  pendingRaw(['--json']);
  pendingRaw();
  const after = snapshot();
  assert.strictEqual(after.length, before.length, '조회가 파일을 만들거나 지우지 않는다');
  for (const [index, entry] of before.entries()) {
    assert.strictEqual(after[index][0], entry[0]);
    assert.ok(after[index][1].equals(entry[1]), `조회가 바이트를 바꿨습니다: ${entry[0]}`);
    assert.strictEqual(after[index][2], entry[2], `조회가 mtime을 바꿨습니다: ${entry[0]}`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('run pending classification passed\n');
