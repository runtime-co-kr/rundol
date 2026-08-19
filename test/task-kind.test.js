'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertKindConsistency, assertRoundUniqueness, TASK_KINDS, TEST_RESULTS } = require('../src/tasks');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

function throwsWith(fn, pattern) {
  assert.throws(fn, (error) => pattern.test(error.message) && error.statusCode === 400, pattern.source);
}

// 진행 상태와 판정은 다른 축이다. 실패한 테스트도 수행은 끝난 것이라 done이고 판정이
// fail이며, 그 둘을 한 필드에 두면 "실패를 확인한 테스트"와 "아직 안 돌린 테스트"가
// 같은 값이 되어 테스트만 모아 성공 여부를 묻는 일이 처음부터 불가능해진다.
function testStatusAndResultAreSeparateAxes() {
  assertKindConsistency(null, { kind: 'test', round: 1, links: ['TST-001'], status: 'done', result: 'fail' });
  assertKindConsistency(null, { kind: 'test', round: 1, links: ['TST-001'], status: 'doing', result: null });
  assertKindConsistency(null, { kind: 'test', round: 1, links: ['TST-001'], status: 'doing', result: 'blocked' });
  for (const result of TEST_RESULTS) assertKindConsistency(null, { kind: 'test', round: 1, links: ['TST-001'], status: 'done', result });
}

function testKindDefaultsToNormal() {
  assertKindConsistency(null, { status: 'done' });
  assertKindConsistency(null, { kind: 'normal', status: 'done', result: null });
  assert.deepStrictEqual(TASK_KINDS.slice(), ['normal', 'test']);
  throwsWith(() => assertKindConsistency(null, { kind: 'unit' }), /지원하지 않는 태스크 종류/u);
}

function testOnlyTestTasksCarryResults() {
  throwsWith(() => assertKindConsistency(null, { kind: 'normal', result: 'pass' }), /테스트 태스크가 아니면/u);
  throwsWith(() => assertKindConsistency(null, { result: 'pass' }), /테스트 태스크가 아니면/u);
  throwsWith(() => assertKindConsistency(null, { kind: 'test', round: 1, links: ['TST-001'], result: 'green' }), /지원하지 않는 테스트 판정/u);
  // 이미 테스트인 태스크에 판정만 얹는 변경도 현재 값과 합쳐 판정한다.
  assertKindConsistency({ kind: 'test', round: 1, links: ['TST-001'], status: 'doing' }, { result: 'pass' });
  throwsWith(() => assertKindConsistency({ kind: 'normal', status: 'doing' }, { result: 'pass' }), /테스트 태스크가 아니면/u);
}

function testDoneTestNeedsVerdictButCancelledDoesNot() {
  throwsWith(() => assertKindConsistency(null, { kind: 'test', round: 1, links: ['TST-001'], status: 'done' }), /완료한 테스트 태스크에는 판정이 필요/u);
  throwsWith(() => assertKindConsistency({ kind: 'test', round: 1, links: ['TST-001'], status: 'doing' }, { status: 'done' }), /완료한 테스트 태스크에는 판정이 필요/u);
  // 반려는 수행하지 않기로 한 것이므로 판정을 요구하지 않는다.
  assertKindConsistency(null, { kind: 'test', round: 1, links: ['TST-001'], status: 'cancelled', cancellation: { reason: 'x', decidedBy: 'MEMBER-001', at: 'now' } });
  // 일반 태스크의 완료는 이 계약과 무관하다.
  assertKindConsistency(null, { kind: 'normal', status: 'done' });
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (path.basename(source) === '.rundol' && ['local', 'worktrees', 'pending', 'logs'].includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), { cwd: root, encoding: 'utf8' });
  return { ok: result.status === 0, out: result.stdout, err: result.stderr, json: result.status === 0 ? JSON.parse(result.stdout) : null };
}

// 차수는 실행 회차를 가리키는 프로젝트 전역 번호다. 같은 TST를 같은 차수에 두 번
// 검증하는 태스크는 둘 수 없지만, 반려한 태스크는 자리를 비운다 — 붙잡으면 잘못 만든
// 것을 되돌릴 방법이 차수를 올리는 것뿐이게 된다.
function testRoundIsRequiredAndWellFormed() {
  throwsWith(() => assertKindConsistency(null, { kind: 'test', links: ['TST-001'], status: 'todo' }), /1 이상의 정수 차수/u);
  for (const round of [0, -1, 1.5, '1', null]) {
    throwsWith(() => assertKindConsistency(null, { kind: 'test', round, links: ['TST-001'], status: 'todo' }), /1 이상의 정수 차수/u);
  }
  throwsWith(() => assertKindConsistency(null, { kind: 'normal', round: 1, status: 'todo' }), /차수를 둘 수 없습니다/u);
  // 차수 하나에 TST 하나가 태스크 하나다.
  throwsWith(() => assertKindConsistency(null, { kind: 'test', round: 1, links: ['TST-001', 'TST-002'], status: 'todo' }), /정확히 하나/u);
  throwsWith(() => assertKindConsistency(null, { kind: 'test', round: 1, links: ['REQ-001'], status: 'todo' }), /정확히 하나/u);
}

function testRoundSlotIsUniquePerDocument() {
  const existing = { A: { kind: 'test', round: 1, links: ['TST-001'], status: 'done', result: 'pass' } };
  throwsWith(() => assertRoundUniqueness(existing, 'B', { kind: 'test', round: 1, links: ['TST-001'], status: 'todo' }), /1차 검증 태스크가 이미 있습니다/u);
  // 다른 차수, 다른 문서, 자기 자신은 충돌이 아니다.
  assertRoundUniqueness(existing, 'B', { kind: 'test', round: 2, links: ['TST-001'], status: 'todo' });
  assertRoundUniqueness(existing, 'B', { kind: 'test', round: 1, links: ['TST-002'], status: 'todo' });
  assertRoundUniqueness(existing, 'A', { kind: 'test', round: 1, links: ['TST-001'], status: 'doing' });
  // 반려한 태스크는 자리를 비우고, 새 태스크도 반려 상태면 자리를 잡지 않는다.
  const cancelled = { A: { kind: 'test', round: 1, links: ['TST-001'], status: 'cancelled' } };
  assertRoundUniqueness(cancelled, 'B', { kind: 'test', round: 1, links: ['TST-001'], status: 'todo' });
  assertRoundUniqueness(existing, 'B', { kind: 'test', round: 1, links: ['TST-001'], status: 'cancelled' });
}

function testEndToEndThroughTheCli() {
  const workspace = path.join(os.tmpdir(), `rundol-task-kind-${process.pid}`);
  fs.rmSync(workspace, { recursive: true, force: true });
  try {
    copyDirectory(path.join(root, 'test', 'fixtures', 'workspace'), workspace);
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Rundol Test'], ['config', 'user.email', 'rundol@example.test'], ['add', '.'], ['commit', '-m', 'initial']]) {
      assert.strictEqual(spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }).status, 0, args.join(' '));
    }
    assert(run(workspace, ['git', 'init']).ok);

    // 테스트 태스크는 무엇을 검증했는지 가리키지 않으면 모아 세도 의미가 없다.
    const missingLink = run(workspace, ['task', 'add', '링크 없는 검증', '--owner', 'MEMBER-001', '--kind', 'test', '--round', '1', '--acceptance', 'x']);
    assert(!missingLink.ok && /정확히 하나/u.test(missingLink.err), missingLink.err);
    const missingRound = run(workspace, ['task', 'add', '차수 없는 검증', '--owner', 'MEMBER-001', '--kind', 'test', '--link', 'TST-001', '--acceptance', 'x']);
    assert(!missingRound.ok && /--round 차수가 필요/u.test(missingRound.err), missingRound.err);
    const strayRound = run(workspace, ['task', 'add', '일반인데 차수', '--owner', 'MEMBER-001', '--round', '1', '--link', 'TST-001', '--acceptance', 'x']);
    assert(!strayRound.ok && /--kind test에만/u.test(strayRound.err), strayRound.err);
    const badRound = run(workspace, ['task', 'add', '0차', '--owner', 'MEMBER-001', '--kind', 'test', '--round', '0', '--link', 'TST-001', '--acceptance', 'x']);
    assert(!badRound.ok && /1 이상의 정수/u.test(badRound.err), badRound.err);

    const created = run(workspace, ['task', 'add', '회귀 실행', '--owner', 'MEMBER-001', '--kind', 'test', '--round', '1', '--link', 'TST-001', '--acceptance', '시나리오를 수행한다.']);
    assert(created.ok, created.err);
    assert.strictEqual(created.json.task.kind, 'test');
    assert.strictEqual(created.json.task.result, null);
    // 구현 준비도는 구현을 시작해도 되는지를 묻는 게이트다. 실행 태스크는 대상이 아니다.
    assert.strictEqual(created.json.task.implementationReadiness, undefined);
    const id = created.json.taskId;

    const normal = run(workspace, ['task', 'add', '일반 작업', '--owner', 'MEMBER-001', '--link', 'TST-001', '--acceptance', '구현한다.']);
    assert(normal.ok, normal.err);
    assert.strictEqual(normal.json.task.kind, 'normal');
    assert.strictEqual(normal.json.task.implementationReadiness, 'atomic-v1');
    const rejected = run(workspace, ['task', 'set', normal.json.taskId, '--result', 'pass']);
    assert(!rejected.ok && /테스트 태스크가 아니면/u.test(rejected.err), rejected.err);

    assert(run(workspace, ['task', 'acceptance', id, 'AC-001', '--done']).ok);
    const withoutVerdict = run(workspace, ['task', 'set', id, '--status', 'done']);
    assert(!withoutVerdict.ok && /판정이 필요/u.test(withoutVerdict.err), withoutVerdict.err);
    const finished = run(workspace, ['task', 'set', id, '--status', 'done', '--result', 'fail']);
    assert(finished.ok, finished.err);
    // 실패한 테스트도 수행은 완료다. 두 축이 각자의 값을 갖는다.
    assert.deepStrictEqual(finished.json.after, { status: 'done', result: 'fail' });

    const tests = run(workspace, ['task', 'list', '--kind', 'test']);
    assert(tests.ok, tests.err);
    assert.deepStrictEqual(tests.json.tasks.map((task) => task.kind), ['test']);
    assert.strictEqual(tests.json.results.fail, 1);
    assert.strictEqual(tests.json.results.pending, undefined);

    const everything = run(workspace, ['task', 'list']);
    assert(everything.json.tasks.length > tests.json.tasks.length, '종류 필터가 목록을 좁혀야 합니다');
    // 판정 집계는 상태 집계와 같은 규칙이다 — 필터 이전 범위에서 센다.
    assert.deepStrictEqual(everything.json.results, tests.json.results);

    const unknown = run(workspace, ['task', 'list', '--kind', 'unit']);
    assert(!unknown.ok && /지원하지 않는 태스크 종류/u.test(unknown.err), unknown.err);

    // 같은 TST를 같은 차수에 두 번 검증할 수 없다. 차수를 올리면 별개 실행이다.
    const duplicate = run(workspace, ['task', 'add', '같은 차수 재실행', '--owner', 'MEMBER-001', '--kind', 'test', '--round', '1', '--link', 'TST-001', '--acceptance', 'x']);
    assert(!duplicate.ok && /1차 검증 태스크가 이미 있습니다/u.test(duplicate.err), duplicate.err);
    const second = run(workspace, ['task', 'add', '2차 실행', '--owner', 'MEMBER-001', '--kind', 'test', '--round', '2', '--link', 'TST-001', '--acceptance', 'x']);
    assert(second.ok, second.err);

    // 차수는 필터가 아니라 범위다 — 2차를 물으면 2차 안에서 센다.
    const secondRound = run(workspace, ['task', 'list', '--kind', 'test', '--round', '2']);
    assert.deepStrictEqual(secondRound.json.tasks.map((task) => task.round), [2]);
    assert.deepStrictEqual(secondRound.json.results, { pending: 1 });
    const firstRound = run(workspace, ['task', 'list', '--kind', 'test', '--round', '1']);
    assert.deepStrictEqual(firstRound.json.results, { fail: 1 });

    // 차수 대상 목록은 저장하지 않는다. 태스크가 있는 것이 범위이고 나머지가 빠진 것이다.
    const rounds = run(workspace, ['test', 'rounds']);
    assert(rounds.ok, rounds.err);
    assert.deepStrictEqual(rounds.json.rounds, [1, 2]);
    assert.strictEqual(rounds.json.latest, 2);
    const detail = run(workspace, ['test', 'rounds', '--round', '1']);
    assert.strictEqual(detail.json.coverage.covered, 1);
    assert.strictEqual(detail.json.coverage.total, detail.json.documents);
    assert(!detail.json.coverage.missing.some((document) => document.id === 'TST-001'), '태스크가 있는 문서는 빠진 것이 아닙니다');
    assert.strictEqual(detail.json.coverage.missing.length, detail.json.documents - 1);
  }
  finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

testStatusAndResultAreSeparateAxes();
testKindDefaultsToNormal();
testOnlyTestTasksCarryResults();
testDoneTestNeedsVerdictButCancelledDoesNot();
testRoundIsRequiredAndWellFormed();
testRoundSlotIsUniquePerDocument();
testEndToEndThroughTheCli();
process.stdout.write('task kind tests passed\n');
