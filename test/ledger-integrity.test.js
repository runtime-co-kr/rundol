'use strict';

// canonicalDigest는 서명이 아니라 누구나 다시 계산할 수 있는 체크섬이다. 기존
// 행을 고치고 다이제스트를 새로 계산하면 파일 안에는 변형 하나만 남아, "같은
// eventId에 다른 다이제스트"라는 상충 검출이 아무것도 잡지 못한다.
//
// 이 시험은 파일이 덧붙여지기만 했는지를 Git 이력으로 판정하는 경로를 확인한다.
// 위조를 막지는 못하고 드러낼 뿐이다 — append-only 원장에서 기대할 수 있는
// 성질이 그것이다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isPrefix, shardViolations, appendOnlyViolations } = require('../src/ledger-integrity');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-integrity-'));

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

try {
  // 접두사 판정은 줄 단위다. 마지막 줄의 개행 유무 같은 차이가 위반이 되면
  // 정상 append도 위반으로 잡힌다.
  assert.strictEqual(isPrefix(['a'], ['a', 'b']), true);
  assert.strictEqual(isPrefix(['a', 'b'], ['a']), false);
  assert.strictEqual(isPrefix(['a', 'b'], ['a', 'c']), false);
  assert.strictEqual(isPrefix([], ['a']), true);

  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Rundol Test']);
  git(['config', 'user.email', 'rundol@example.test']);
  const shardDirectory = path.join(temporary, 'events', 'decision');
  fs.mkdirSync(shardDirectory, { recursive: true });
  const shard = path.join(shardDirectory, 'decision-crm-agent-a-000001.jsonl');

  fs.writeFileSync(shard, '{"eventId":"EVT-1","recordedAt":"2026-08-17T00:00:00.000Z"}\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', 'first event']);

  // 정상 append는 위반이 아니다.
  fs.appendFileSync(shard, '{"eventId":"EVT-2","recordedAt":"2026-08-18T00:00:00.000Z"}\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', 'second event']);
  assert.deepStrictEqual(shardViolations(temporary, shard), [], '덧붙이기만 한 샤드는 위반이 아닙니다.');

  // 커밋된 뒤 작업 트리에서 기존 행을 고치면 드러난다 — 시각 역기입이 정확히 이것이다.
  const tampered = fs.readFileSync(shard, 'utf8').replace('2026-08-18', '2026-08-16');
  fs.writeFileSync(shard, tampered, 'utf8');
  const workingViolations = shardViolations(temporary, shard);
  assert.strictEqual(workingViolations.length, 1, `작업 트리 변조가 드러나야 합니다: ${JSON.stringify(workingViolations)}`);
  assert.strictEqual(workingViolations[0].commit, null);

  // 커밋으로 덮어도 드러난다. 이력이 남기 때문이다.
  git(['add', '-A']);
  git(['commit', '-m', 'tampered']);
  const committedViolations = shardViolations(temporary, shard);
  assert.strictEqual(committedViolations.length, 1, `커밋된 변조가 드러나야 합니다: ${JSON.stringify(committedViolations)}`);
  assert(committedViolations[0].commit, '위반이 어느 커밋인지 지목해야 합니다.');

  // 기존 행 삭제도 같은 위반이다.
  fs.writeFileSync(shard, '{"eventId":"EVT-2","recordedAt":"2026-08-16T00:00:00.000Z"}\n', 'utf8');
  assert(shardViolations(temporary, shard).length >= 1, '기존 행 삭제도 위반이어야 합니다.');

  // Git 저장소가 아니면 조용히 빈 목록을 돌려준다 — 검사가 실패로 번지면 안 된다.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-integrity-bare-'));
  try {
    assert.deepStrictEqual(appendOnlyViolations(bare), []);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  process.stdout.write('ledger integrity tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
