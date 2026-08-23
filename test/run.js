'use strict';

// 시험 실행기. 파일을 워커 프로세스로 나누어 돌린다.
//
// 나누기 전에는 78개 파일을 한 프로세스에서 순차로 require했고 40분이 걸렸다. 시험
// 내용이 무거워서가 아니라 대부분이 `node bin/rdl.js`를 spawn하기 때문이다 — 한 번
// 띄울 때마다 Node 런타임이 새로 오르고 src의 수십 개 모듈을 다시 읽고 git을 또 여러 번
// 띄운다. Windows에서 프로세스 생성은 특히 비싸다. 코어를 놀리면서 그 비용을 순서대로
// 치를 이유가 없다.
//
// 격리는 이미 있었다. 각 시험이 자기 임시 디렉터리를 쓰고 RUNDOL_HOME이 pid로 갈리므로,
// 프로세스를 나누는 것만으로 서로를 보지 않는다.
//
// 순서가 필요한 것은 사슬 하나뿐이다. 프로세스를 띄우고 포트를 잡고 잠금을 다투는
// 시험들이며, 동시에 돌리면 서로의 실패 원인이 된다. 그 사슬은 한 워커에 그대로 둔다.
//
// RUNDOL_TEST_JOBS=1이면 예전처럼 한 프로세스에서 순차로 돈다. 나눈 것이 원인인 실패를
// 만났을 때 되돌려 확인할 자리가 없으면, 병렬은 진단할 수 없는 층이 된다.

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PARALLEL, ASYNC, CHAIN, CHAIN_TAIL } = require('./manifest');

const WORKER = path.join(__dirname, 'worker.js');
const startedAt = Date.now();

function jobCount() {
  const requested = Number.parseInt(process.env.RUNDOL_TEST_JOBS || '', 10);
  if (Number.isSafeInteger(requested) && requested > 0) return requested;
  // 상한이 4인 이유는 코어가 아니라 프로세스 때문이다. 워커 하나가 node와 git을 쉴 새
  // 없이 spawn하므로, 코어 수만큼 채우면 Windows가 프로세스 생성에서 무너진다 —
  // 실제로 8개로 돌렸을 때 git init이 0xC0000142(DLL 초기화 실패)로 끝났다. 그 실패는
  // 시험의 실패처럼 보이지만 시험과 무관하고, 다시 돌리면 사라져 진단할 수도 없다.
  //
  // 더 늘리고 싶으면 RUNDOL_TEST_JOBS로 올린다. 기본값이 감당하지 못하는 실패를 만드는
  // 것보다, 감당하는 값을 두고 필요한 사람이 올리는 편이 낫다.
  return Math.max(2, Math.min(4, (os.cpus() || []).length - 1 || 2));
}

// 나누는 방식은 라운드로빈이다. 파일별 소요를 모르므로 균등하게 나눌 수 없고, 목록
// 순서가 곧 무게 순서도 아니다. 붙어 있는 무거운 시험들이 한 워커에 몰리지 않는 것이
// 이 방식이 주는 전부이며, 그것으로 충분하다.
function shard(items, buckets) {
  const result = Array.from({ length: buckets }, () => []);
  items.forEach((item, index) => result[index % buckets].push(item));
  return result.filter((bucket) => bucket.length);
}

function runWorker(label, names) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER].concat(names), { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (error) => {
      process.stderr.write(`[FAIL] ${label} 워커를 띄우지 못했습니다: ${error.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) process.stderr.write(`[FAIL] ${label} 워커가 ${signal}으로 끝났습니다.\n`);
      resolve(signal ? 1 : code || 0);
    });
  });
}

async function main() {
  const jobs = jobCount();
  // 사슬은 한 워커에 통째로 둔다. 순서가 계약이므로 나눌 수 없다.
  const chainNames = CHAIN.concat(CHAIN_TAIL);
  if (jobs === 1) {
    const code = await runWorker('전체', PARALLEL.concat(ASYNC, chainNames));
    finish([code]);
    return;
  }
  const buckets = shard(PARALLEL.concat(ASYNC), Math.max(1, jobs - 1));
  process.stdout.write(`시험 워커 ${buckets.length + 1}개 (병렬 ${PARALLEL.length + ASYNC.length}건 · 사슬 ${chainNames.length}건)\n`);
  const codes = await Promise.all(
    buckets.map((names, index) => runWorker(`병렬 ${index + 1}`, names))
      .concat([runWorker('사슬', chainNames)])
  );
  finish(codes);
}

function finish(codes) {
  const failed = codes.filter((code) => code !== 0).length;
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (failed) {
    process.stderr.write(`\n워커 ${failed}개가 실패했습니다 (${seconds}초). 위의 [FAIL] 줄이 어느 시험인지 말합니다.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n모든 시험이 통과했습니다 (${seconds}초).\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
