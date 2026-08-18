'use strict';

// Windows에서는 자식 프로세스 트리의 종료를 보장할 수 없다. taskkill /T는 부모-자식
// 관계를 스냅숏으로 훑는 최선 노력이고, 권한이 부족하면 거부된다. 그러면 취소는
// 끝났다고 보고되지만 자손은 살아남아 정본을 계속 쓸 수 있다 — 외부 검증에서 일반
// 권한으로 실제 재현됐다.
//
// POSIX는 성질이 다르다. 프로세스 그룹에 신호를 보내므로 커널이 트리를 소유하고,
// 최선 노력이 아니다. 그래서 이 게이트는 Windows에만 건다 — 다만 그것이 "POSIX는
// 검증됐다"는 뜻은 아니다. 세 OS의 검증 행렬은 별도 태스크로 열려 있다.
//
// 제대로 된 해소는 Job Object로 트리를 소유하는 것이고 네이티브 확장을 요구한다.
// 그때까지는 취소를 전제로 한 자동 실행을 열지 않는다.

const assert = require('assert');
const { unguaranteedTermination, driveStepClass } = require('../src/run');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapter = require('../src/adapter');

const previous = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;

async function main() {
try {
  // 분류는 플랫폼과 무관하다 — 게이트는 분류 뒤에 붙는다.
  assert.strictEqual(driveStepClass({ id: 'a', executor: 'adapter', adapter: 'fixture' }), 'adapter');
  assert.strictEqual(driveStepClass({ id: 'h', human: true }), 'human');

  // 사람 스텝과 게이트는 자식 프로세스를 띄우지 않으므로 막히지 않는다.
  delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  assert.strictEqual(unguaranteedTermination('human'), false);
  assert.strictEqual(unguaranteedTermination('gate'), false);

  if (process.platform === 'win32') {
    // 옵트인이 없으면 자식 프로세스를 띄우는 분류가 전부 막힌다. verify도
    // 외부 어댑터 프로세스를 띄우므로 같은 위험이다 — 분류만 다르다.
    assert.strictEqual(unguaranteedTermination('adapter'), true, 'Windows에서 어댑터 자동 실행은 기본으로 막혀야 합니다.');
    assert.strictEqual(unguaranteedTermination('cli'), true, 'CLI 스텝도 자식 프로세스를 띄웁니다.');
    assert.strictEqual(unguaranteedTermination('verify'), true, '검증도 외부 어댑터 프로세스를 띄웁니다.');
    // 공개 명령도 같은 판정을 거쳐야 한다. drive만 막고 명령이 열려 있으면
    // 차단이 아니라 우회로 안내다.
    assert.throws(() => require('../src/adapter').assertTerminationGuaranteed('rdl adapter run'), /RUNDOL_ALLOW_WINDOWS_ADAPTER/u);
    // 위험을 아는 사람이 명시적으로 켤 수 있다.
    process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';
    assert.strictEqual(unguaranteedTermination('adapter'), false, '명시적 옵트인은 게이트를 연다.');
    assert.strictEqual(unguaranteedTermination('verify'), false);
    assert.doesNotThrow(() => require('../src/adapter').assertTerminationGuaranteed('rdl adapter run'));
  } else {
    // POSIX는 프로세스 그룹으로 트리를 소유하므로 이 게이트를 걸지 않는다.
    assert.strictEqual(unguaranteedTermination('adapter'), false);
    assert.strictEqual(unguaranteedTermination('cli'), false);
    assert.strictEqual(unguaranteedTermination('verify'), false);
  }

  // 게이트가 실제 실행 경로에 붙어 있는지 확인한다. 술어만 시험하면 술어가
  // 맞는데 아무도 부르지 않는 상태를 통과시킨다 — 이번 라운드에 네 번 겪었다.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'run.js'), 'utf8');
  assert(/if \(unguaranteedTermination\(classification\)\)/u.test(source), '게이트가 tickRun의 분류 직후에 붙어 있어야 합니다.');
  assert(/reason: 'termination-unsafe'/u.test(source), '막힌 이유가 상태로 남아야 합니다.');

  // 기본 안전 모드를 실제로 검증한다. 전체 러너가 옵트인을 전역 설정하므로,
  // 그 안에서만 확인하면 "기본은 막힌다"가 한 번도 시험되지 않는다 — 게이트가
  // 자기가 지켜야 할 상태를 가리는 셈이다. 그래서 자식 프로세스로 확인한다.
  if (process.platform === 'win32') {
    const { spawnSync } = require('child_process');
    const clean = Object.assign({}, process.env);
    delete clean.RUNDOL_ALLOW_WINDOWS_ADAPTER;
    const probe = spawnSync(process.execPath, ['-e', "process.exitCode = require('./src/adapter').terminationGuaranteed() ? 0 : 7;"],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: clean });
    assert.strictEqual(probe.status, 7, `옵트인 없는 프로세스에서는 보장되지 않아야 합니다: ${probe.stdout}${probe.stderr}`);
    const opted = spawnSync(process.execPath, ['-e', "process.exitCode = require('./src/adapter').terminationGuaranteed() ? 0 : 7;"],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: Object.assign({}, clean, { RUNDOL_ALLOW_WINDOWS_ADAPTER: '1' }) });
    assert.strictEqual(opted.status, 0, '옵트인한 프로세스에서는 열려야 합니다.');
  }


  // ── 고아 손자는 실제로 살아남는가 ────────────────────────────────────────
  //
  // 이 파일의 머리말은 "taskkill /T는 스냅숏이라 고아 손자가 빠진다"고 단정하지만,
  // 지금까지 그것을 잰 시험은 없었다. 주장과 측정은 다르고, 이 게이트 전체가 그
  // 주장 위에 서 있다. 재 본다.
  //
  // POSIX에서는 프로세스 그룹에 신호가 가므로 커널이 트리를 소유한다 — 손자가
  // 고아가 되어도 그룹은 그대로다. 그래서 여기서는 죽어야 하고, 그것이
  // "POSIX는 최선 노력이 아니다"라는 이 파일의 다른 주장을 처음으로 확인한다.
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  const pidFile = path.join(os.tmpdir(), `rundol-orphan-${process.pid}-${Date.now()}.pid`);
  let orphanPid = null;
  try {
    const previousOptIn = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
    process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';
    const controller = new AbortController();
    const execution = adapter.executeOnce(process.execPath,
      [path.join(__dirname, 'fixtures', 'orphan-spawner.js'), pidFile],
      { cwd: path.join(__dirname, '..'), env: process.env, timeoutSeconds: 30, signal: controller.signal });
    // 손자가 자기 pid를 남길 때까지 기다린다. 남기지 못했다면 이 시험은 아무것도
    // 재지 못한 것이므로, 조용히 통과시키지 않는다.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !fs.existsSync(pidFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert(fs.existsSync(pidFile), '손자가 뜨지 않았다면 이 시험은 종료에 대해 아무것도 말하지 못합니다.');
    orphanPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    assert(Number.isInteger(orphanPid) && orphanPid > 0, `손자 pid를 읽지 못했습니다: ${orphanPid}`);
    controller.abort();
    await execution;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    if (previousOptIn === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
    else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = previousOptIn;

    const survived = alive(orphanPid);
    // 살아 있는 자손 트리는 두 플랫폼 모두에서 죽어야 한다. POSIX는 프로세스 그룹이,
    // Windows는 taskkill /T의 스냅숏이 이 경우를 덮는다.
    //
    // 덮지 못하는 경우 — 자식이 먼저 끝나 손자가 고아가 되는 경우 — 는 여기서
    // 단언하지 않는다. 그것은 성질이 아니라 경쟁이고, Windows에서 종료를 보장할 수
    // 없다는 말의 내용이 바로 그 경쟁을 이길 수 없다는 것이다. 이길 수 없는 경쟁을
    // 단언으로 적으면 시험이 비결정적이 되고, 비결정적 시험은 게이트가 아니다.
    // 그 경우를 실제로 닫으려면 Job Object가 필요하고, 그때까지 기본 차단이 답이다.
    assert.strictEqual(survived, false,
      `${process.platform}에서 살아 있는 자손 트리가 종료되지 않았습니다 (pid ${orphanPid}).`);
  } finally {
    if (orphanPid && alive(orphanPid)) { try { process.kill(orphanPid, 'SIGKILL'); } catch (_) {} }
    try { fs.rmSync(pidFile, { force: true }); } catch (_) {}
  }
  process.stdout.write('windows termination tests passed\n');
} finally {
  if (previous === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = previous;
}
}

module.exports = main();
