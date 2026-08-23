'use strict';

// 시험 워커. 실행기가 넘겨 준 파일만 한 프로세스에서 돈다.
//
// RUNDOL_HOME을 pid로 가르는 것은 예전 실행기가 이미 하던 일이다. 워커마다 pid가
// 다르므로 나누는 것만으로 격리가 따라온다 — 새로 만들 것이 없다.

const os = require('os');
const path = require('path');

process.env.RUNDOL_HOME = path.join(os.tmpdir(), `rundol-test-runtime-${process.pid}`);

const names = process.argv.slice(2);
if (!names.length) {
  process.stderr.write('worker: 돌릴 시험이 없습니다.\n');
  process.exit(2);
}

// 어느 파일에서 넘어졌는지 말한다. 워커가 여럿이면 출력이 섞이므로, 스택만으로는
// 어느 시험의 실패인지 읽는 사람이 되짚어야 한다.
function fail(name, error) {
  process.stderr.write(`\n[FAIL] ${name}\n${(error && (error.stack || error.message)) || error}\n`);
  process.exitCode = 1;
}

async function main() {
  for (const name of names) {
    try {
      // 시험이 promise를 내보내면 기다린다. 기다리지 않으면 다음 시험이 겹쳐 돌고,
      // 겹친 실패는 어느 쪽의 것인지 알 수 없다.
      const loaded = require(`./${name}.test`);
      if (loaded && typeof loaded.then === 'function') await loaded;
    } catch (error) {
      fail(name, error);
      // 다음 파일로 넘어간다. 한 파일이 넘어졌다고 워커를 멈추면 그 워커가 맡은
      // 나머지가 통째로 돌지 않고, 돌지 않은 시험은 통과한 시험과 구분되지 않는다.
    }
  }
}

main().catch((error) => fail('worker', error));
