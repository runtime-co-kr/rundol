'use strict';

// 무인 드라이버의 시험. 지금은 진행 증거만 담는다 — 회전과 상주 루프는 뒤 단계다.
//
// 진행 증거가 이 기능의 중심이다. runDrive가 돌아왔는데 원장이 하나도 움직이지
// 않는 경로가 여덟 있고, 그 런은 여전히 drivable이므로 다음 회전에 다시 뽑힌다.
// 격리 장치가 없으면 드라이버는 같은 런을 영원히 다시 민다.
//
// 이 기계에서 그것은 예외가 아니라 기본 경로다. terminationGuaranteed()가
// Windows에서 RUNDOL_ALLOW_WINDOWS_ADAPTER 없이는 false를 돌려주므로, 옵트인하지
// 않은 Windows에서 드라이버는 모든 drivable 런의 첫 어댑터 스텝에서
// termination-unsafe로 돌아온다. 그리고 그 사유는 HALT_REASONS에 없어 원장에
// 남을 수조차 없다.

const assert = require('assert');
const { progressWitness } = require('../src/run-pending');
const { HALT_REASONS } = require('../src/run-ledger');

function fold(overrides) {
  return Object.assign({
    status: 'running',
    cursor: 'author',
    completedSteps: ['plan', 'create'],
    attempts: { author: 1 }
  }, overrides || {});
}

// 증거가 없는 것과 증거가 있는 것은 다르다. 접히지 않은 런을 전진했다고 읽으면
// 격리가 풀린 것으로 오인된다.
assert.strictEqual(progressWitness(null), null);
assert.strictEqual(progressWitness({}), null);

// 같은 fold는 같은 증거를 낸다. 이것이 성립하지 않으면 격리가 매 회전 풀린다.
assert.strictEqual(progressWitness(fold()), progressWitness(fold()));

// 정규 직렬화를 쓴다. 키 순서가 다른 attempts가 다른 증거를 내면, 원장이 움직이지
// 않았는데도 격리가 풀려 뜨거운 순환이 그대로 돌아온다.
assert.strictEqual(
  progressWitness(fold({ attempts: { author: 1, 'mech-gate': 2 } })),
  progressWitness(fold({ attempts: { 'mech-gate': 2, author: 1 } })),
  '키 순서는 진행이 아니다'
);

// 네 필드가 각각 나머지 셋이 놓치는 것을 잡는다. 하나라도 다른데 증거가 같아지면
// 그 필드는 뺄 수 있다는 뜻이고, 뺄 수 없다는 것이 이 시험이다.
const base = progressWitness(fold());
const variants = {
  status: fold({ status: 'halted' }),
  // 커서만 전진한 경우. 완료 집합과 시도는 그대로일 수 있다.
  cursor: fold({ cursor: 'mech-gate' }),
  // 커서가 같은 id로 돌아왔지만 완료 집합이 달라진 경우.
  completedSteps: fold({ completedSteps: ['plan', 'create', 'author'] }),
  // onFail.goto가 커서와 완료 집합을 같은 자리로 되돌린 경우. 시도만 늘어난다.
  attempts: fold({ attempts: { author: 2 } })
};
for (const [field, value] of Object.entries(variants)) {
  assert.notStrictEqual(progressWitness(value), base, `${field}가 바뀌었는데 증거가 같습니다 — 이 필드는 뺄 수 없습니다`);
}

// 원장에 남을 수 없는 정지 사유가 실재한다는 것을 고정한다. 이 사실이 무너지면
// 진행 증거의 존재 이유 절반이 사라지므로, 주석이 아니라 시험이 지킨다.
//
// 조건부로 감싸지 않는다. export가 사라지면 단언이 조용히 건너뛰어지는 대신
// 여기서 죽어야 한다 — 조용히 건너뛰는 검사는 필요할 때 침묵한다.
assert.ok(HALT_REASONS instanceof Set, 'HALT_REASONS를 읽지 못하면 이 시험은 아무것도 재지 않습니다');
assert.ok(!HALT_REASONS.has('termination-unsafe'), 'termination-unsafe가 기록 가능해졌다면 진행 증거의 근거를 다시 써야 합니다');
assert.ok(HALT_REASONS.has('gate-failed'), 'HALT_REASONS를 읽고 있다는 대조군');

// 전진 없는 반환의 실제 모양. runDrive가 termination-unsafe로 돌아오면 원장이
// 그대로이므로 증거도 그대로다 — 격리가 이 등식으로 판정된다.
const before = progressWitness(fold());
const afterNoProgress = progressWitness(fold());
assert.strictEqual(afterNoProgress, before, '전진하지 않은 런은 같은 증거를 낸다');

// 사람이 resume하면 fold가 움직이고 격리가 스스로 풀린다. 백오프도 시계도 쓰지
// 않고 상태가 바뀌었는지만 묻는다.
const afterResume = progressWitness(fold({ attempts: { author: 2 } }));
assert.notStrictEqual(afterResume, before, '원장이 움직이면 격리가 풀린다');

// ── 2·3. 회전의 관문 셋 (주입, 파일 없음) ───────────────────────────────
// 판정의 순서를 재는 데 작업공간이 필요하지 않다. 읽기와 드라이브와 동의 조회를
// 주입하면 관문만 남고, 관문만 남아야 무엇이 관문이 아닌지도 드러난다.

const { driveRotation } = require('../src/run-driver');

function entry(overrides) {
  const base = {
    project: { key: 'memo' },
    runId: 'RUN-0123456789ABCDEF0123',
    fold: fold(),
    liveness: { lease: false, lock: false }
  };
  return Object.assign(base, overrides || {});
}

function reader(runs) {
  return () => ({ workspace: 'C:/ws', layout: null, runs, unreadable: [] });
}

function counting(result) {
  const calls = [];
  const drive = (start, input) => { calls.push(input); return Promise.resolve(result || { status: 'completed' }); };
  return { drive, calls };
}

(async () => {
  // 관문 1 — 동의하지 않은 프로젝트의 런은 접지도 않는다. 기본값이 null이므로
  // 아무것도 설정하지 않은 작업공간에서 드라이버는 한 런도 몰지 않는다.
  {
    const { drive, calls } = counting();
    const result = await driveRotation('C:/ws', { clientId: 'driver-a', quarantine: new Map() }, {
      drive, readRunFolds: reader([entry()]), projectConsents: () => false
    });
    assert.strictEqual(result.drove, false);
    assert.strictEqual(calls.length, 0, '동의 없는 프로젝트는 드라이브를 부르지 않는다');
    assert.strictEqual(result.skipped.consent, 1);
    assert.strictEqual(result.quarantineSize, 0, '동의 거절은 격리가 아니다');
  }

  // 관문 2 — drivable이 아닌 런은 몰지 않는다. 사람 게이트에 선 런이 대표다.
  {
    const { drive, calls } = counting();
    const result = await driveRotation('C:/ws', { clientId: 'driver-a', quarantine: new Map() }, {
      drive,
      readRunFolds: reader([entry({ fold: fold({ cursorStep: { id: 'sync-gate', human: true }, owner: 'driver-a' }) })]),
      projectConsents: () => true
    });
    assert.strictEqual(calls.length, 0, '사람 경계에 선 런은 기계가 밀지 않는다');
    assert.strictEqual(result.skipped.notDrivable, 1);
  }

  // 동의한 프로젝트의 drivable 런은 정확히 한 번 불린다. 그리고 --scheduled를
  // 넣어 부른다 — preflight가 같은 검사를 다시 하는 것이 실제 강제다.
  {
    const drivable = fold({ cursorStep: { id: 'author', human: false }, owner: 'driver-a' });
    const { drive, calls } = counting();
    const after = fold({ cursor: 'mech-gate', owner: 'driver-a', cursorStep: { id: 'mech-gate', human: false } });
    let phase = 0;
    const result = await driveRotation('C:/ws', { clientId: 'driver-a', quarantine: new Map() }, {
      drive,
      readRunFolds: () => ({ workspace: 'C:/ws', runs: [entry({ fold: phase++ === 0 ? drivable : after })], unreadable: [] }),
      projectConsents: () => true
    });
    assert.strictEqual(calls.length, 1, '후보 하나를 정확히 한 번 몬다');
    assert.strictEqual(calls[0].scheduled, true, '무인 실행임을 preflight가 알 수 있게 한다');
    assert.strictEqual(calls[0].clientId, 'driver-a');
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(result.quarantineSize, 0, '전진한 런은 격리되지 않는다');
  }

  // ── AC-003 — 전진하지 않으면 다시 밀지 않는다. 이 스위트의 중심 ──
  //
  // termination-unsafe는 원장에 남을 수 없고, Windows 기본 설정에서 그것이
  // 모든 drivable 런의 첫 어댑터 스텝이 만나는 경로다. 격리가 없으면 드라이버는
  // 첫날 밤에 같은 런을 수만 번 민다.
  {
    const stuck = fold({ cursorStep: { id: 'author', human: false }, owner: 'driver-a' });
    const quarantine = new Map();
    const { drive, calls } = counting({ status: 'halted', reason: 'termination-unsafe' });
    const deps = { drive, readRunFolds: reader([entry({ fold: stuck })]), projectConsents: () => true };
    const options = { clientId: 'driver-a', quarantine };

    const first = await driveRotation('C:/ws', options, deps);
    assert.strictEqual(calls.length, 1, '1회전은 몬다');
    assert.strictEqual(first.advanced, false, '원장이 움직이지 않았다');
    assert.strictEqual(quarantine.size, 1, '격리된다');

    await driveRotation('C:/ws', options, deps);
    await driveRotation('C:/ws', options, deps);
    assert.strictEqual(calls.length, 1, '2·3회전은 한 번도 몰지 않는다 — 뜨거운 순환이 없다');

    // preflight가 던지는 경우도 같은 결과다. 던짐과 전진 없는 반환이 한 관문으로
    // 처리되는지를 잰다 — 일곱 가지 던짐이 각각 다른 오류를 내지만 드라이버에게는
    // 전부 "원장이 안 움직였다"이다.
    const thrower = { drive: () => { throw new Error('settings drift'); }, readRunFolds: reader([entry({ fold: stuck })]), projectConsents: () => true };
    const fresh = new Map();
    const threw = await driveRotation('C:/ws', { clientId: 'driver-a', quarantine: fresh }, thrower);
    assert.strictEqual(threw.advanced, false, '던짐도 전진이 아니다');
    assert.strictEqual(fresh.size, 1, '던진 런도 격리된다');
  }

  // 격리는 스스로 풀린다. 사람이 resume하면 fold가 움직이고 다음 회전이 그 런을
  // 다시 집는다. 백오프도 시계도 쓰지 않고 상태가 바뀌었는지만 묻는다.
  {
    const stuck = fold({ cursorStep: { id: 'author', human: false }, owner: 'driver-a' });
    const resumed = fold({ cursorStep: { id: 'author', human: false }, owner: 'driver-a', attempts: { author: 2 } });
    const quarantine = new Map();
    const { drive, calls } = counting({ status: 'halted', reason: 'termination-unsafe' });
    const options = { clientId: 'driver-a', quarantine };

    await driveRotation('C:/ws', options, { drive, readRunFolds: reader([entry({ fold: stuck })]), projectConsents: () => true });
    assert.strictEqual(quarantine.size, 1);

    await driveRotation('C:/ws', options, { drive, readRunFolds: reader([entry({ fold: resumed })]), projectConsents: () => true });
    assert.strictEqual(calls.length, 2, '원장이 움직이면 격리가 풀리고 다시 몬다');
  }

  // ── 4. 상주 루프 ──────────────────────────────────────────────────────
  const { runDriver } = require('../src/run-driver');

  // --once는 잠금을 잡지 않는다. 한 번 돌고 끝나는 호출이 상주 프로세스의
  // 배타를 요구하면, 시험도 사람도 드라이버가 도는 동안 상태를 볼 수 없다.
  {
    const quarantine = new Map();
    const { drive, calls } = counting({ status: 'halted', reason: 'termination-unsafe' });
    const stuck = fold({ cursorStep: { id: 'author', human: false }, owner: 'driver-a' });
    const deps = { drive, readRunFolds: reader([entry({ fold: stuck })]), projectConsents: () => true };
    const options = { clientId: 'driver-a', once: true, quarantine };

    const first = await runDriver('C:/ws', options, deps);
    assert.strictEqual(first.once, true);
    assert.strictEqual(first.drove, true);
    assert.strictEqual(calls.length, 1);

    // 격리가 호출을 넘어 살아남는다. --once를 이어 부르는 것이 상주 루프의
    // 회전과 같은 결과를 내야 한다.
    const second = await runDriver('C:/ws', options, deps);
    assert.strictEqual(second.drove, false, '격리된 런은 다음 호출에서도 안 몰린다');
    assert.strictEqual(calls.length, 1);
  }

  // 상주 루프는 중단 신호에 멈춘다. 잠금과 신호는 주입해 실제 프로세스 잠금을
  // 잡지 않는다 — 시험이 기계의 잠금 디렉터리를 오염시키면 안 된다.
  {
    let released = 0;
    const controller = new AbortController();
    let rotations = 0;
    const fakeRuntime = {
      runtimeWorkspace: () => ({ id: 'ffffffffffffffff', locks: 'C:/ws/locks' }),
      acquireProcessLock: () => Promise.resolve(() => { released += 1; }),
      bindProcessLockSignals: () => {}
    };
    const result = await runDriver('C:/ws', { clientId: 'driver-a', interval: 5, signal: controller.signal }, {
      runtime: fakeRuntime,
      driveRotation: () => { rotations += 1; if (rotations >= 2) controller.abort(); return Promise.resolve({ drove: false }); },
      setTimeout: (fn) => setTimeout(fn, 0),
      clearTimeout
    });
    assert.strictEqual(result.once, false);
    assert.ok(result.rotations >= 2, `회전이 반복된다: ${result.rotations}`);
    assert.strictEqual(released, 1, '루프가 끝나면 잠금을 놓는다');
  }

  process.stdout.write('run driver tests passed\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
