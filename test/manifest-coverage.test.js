'use strict';

// 목록에 없는 시험 파일은 돌지 않는다. 돌지 않는 시험은 통과한 시험과 구분되지 않는다.
//
// 이 시험이 생긴 이유는 실제 자국이다. run-driver.test.js가 만들어진 뒤 실행기가 그것을
// 부른 적이 없었고, 파일은 통과하는 상태로 디스크에 있었는데 아무도 그 사실을 몰랐다.
// 목록을 손으로 관리하는 한 같은 일이 또 일어나며, 빠졌다는 사실은 아무 신호도 내지 않는다.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PARALLEL, ASYNC, CHAIN, CHAIN_TAIL, INSTALL_ONLY } = require('./manifest');

const listed = [].concat(PARALLEL, ASYNC, CHAIN, CHAIN_TAIL, INSTALL_ONLY);

// 한 파일이 두 자리에 있으면 두 번 돌거나, 사슬에 있으면서 병렬로도 돌아 서로의
// 실패 원인이 된다.
const seen = new Set();
const duplicated = listed.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
assert.deepStrictEqual(duplicated, [], '한 시험은 목록에 한 번만 있다');

const onDisk = fs.readdirSync(__dirname)
  .filter((entry) => entry.endsWith('.test.js'))
  // 이 파일 자신도 목록에 있어야 한다. 목록을 검사하는 시험이 목록 밖에 있으면
  // 그것부터 돌지 않고, 돌지 않는 검사는 없는 검사다.
  .map((entry) => entry.replace(/\.test\.js$/u, ''));

const missing = onDisk.filter((name) => !seen.has(name));
assert.deepStrictEqual(missing, [], `목록에 없는 시험 파일: ${missing.join(', ')}`);

// 반대 방향도 본다. 지워진 파일이 목록에 남아 있으면 워커가 require에서 넘어지고,
// 그 실패는 시험의 실패처럼 보이지만 사실은 목록이 낡은 것이다.
const onDiskSet = new Set(onDisk);
const dangling = listed.filter((name) => !onDiskSet.has(name));
assert.deepStrictEqual(dangling, [], `파일이 없는 목록 항목: ${dangling.join(', ')}`);

console.log('manifest coverage tests passed');
