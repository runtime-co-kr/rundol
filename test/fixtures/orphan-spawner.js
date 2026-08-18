'use strict';

// 자손 트리를 만드는 픽스처. 자식이 손자를 띄우고 자기도 계속 살아 있는다 —
// 종료 시점에 트리 전체가 살아 있는 상태를 결정적으로 만들기 위해서다.
//
// 처음에는 자식이 곧바로 끝나 손자를 고아로 만들게 했다. 그 시험은 비결정적이었다:
// 취소가 자식보다 먼저 도착하면 taskkill /T가 손자를 찾아 죽이고, 늦게 도착하면
// 손자는 살아남는다. 즉 고아 경우는 성질이 아니라 경쟁이고, Windows에서 종료를
// 보장할 수 없다는 것은 바로 그 경쟁을 이길 수 없다는 뜻이다. 이길 수 없는 경쟁을
// 단언으로 적으면 시험 자체가 비결정적이 된다.
//
// 그래서 여기서는 이길 수 있는 것만 잰다 — 살아 있는 자손 트리의 종료.

const { spawn } = require('child_process');
const path = require('path');

const [pidFile] = process.argv.slice(2);
if (!pidFile) {
  process.stderr.write('orphan-spawner에는 pid 파일 경로가 필요합니다.\n');
  process.exit(2);
}

spawn(process.execPath, [path.join(__dirname, 'orphan-grandchild.js'), pidFile], {
  detached: false,
  stdio: 'ignore',
  windowsHide: true
});

setTimeout(() => process.exit(0), 60000);
