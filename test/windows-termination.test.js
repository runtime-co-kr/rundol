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

const previous = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;

try {
  // 분류는 플랫폼과 무관하다 — 게이트는 분류 뒤에 붙는다.
  assert.strictEqual(driveStepClass({ id: 'a', executor: 'adapter', adapter: 'fixture' }), 'adapter');
  assert.strictEqual(driveStepClass({ id: 'h', human: true }), 'human');

  // 사람 스텝과 게이트는 자식 프로세스를 띄우지 않으므로 막히지 않는다.
  delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  assert.strictEqual(unguaranteedTermination('human'), false);
  assert.strictEqual(unguaranteedTermination('gate'), false);
  assert.strictEqual(unguaranteedTermination('verify'), false);

  if (process.platform === 'win32') {
    // 옵트인이 없으면 자식 프로세스를 띄우는 분류가 막힌다.
    assert.strictEqual(unguaranteedTermination('adapter'), true, 'Windows에서 어댑터 자동 실행은 기본으로 막혀야 합니다.');
    assert.strictEqual(unguaranteedTermination('cli'), true, 'CLI 스텝도 자식 프로세스를 띄웁니다.');
    // 위험을 아는 사람이 명시적으로 켤 수 있다.
    process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';
    assert.strictEqual(unguaranteedTermination('adapter'), false, '명시적 옵트인은 게이트를 연다.');
  } else {
    // POSIX는 프로세스 그룹으로 트리를 소유하므로 이 게이트를 걸지 않는다.
    assert.strictEqual(unguaranteedTermination('adapter'), false);
    assert.strictEqual(unguaranteedTermination('cli'), false);
  }

  // 게이트가 실제 실행 경로에 붙어 있는지 확인한다. 술어만 시험하면 술어가
  // 맞는데 아무도 부르지 않는 상태를 통과시킨다 — 이번 라운드에 네 번 겪었다.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'run.js'), 'utf8');
  assert(/if \(unguaranteedTermination\(classification\)\)/u.test(source), '게이트가 tickRun의 분류 직후에 붙어 있어야 합니다.');
  assert(/reason: 'termination-unsafe'/u.test(source), '막힌 이유가 상태로 남아야 합니다.');

  process.stdout.write('windows termination tests passed\n');
} finally {
  if (previous === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = previous;
}
