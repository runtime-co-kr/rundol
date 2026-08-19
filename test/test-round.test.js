'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testRounds } = require('../src/test-round');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

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

function rdl(cwd, args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), { cwd: root, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${args.join(' ')} :: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// 차수 대상 목록은 저장하지 않는다. 태스크를 만든 것이 곧 범위이고, 빠진 것은 TST 문서
// 전체와 대조해 계산한다. 저장하면 정본이 둘이 되어 조용히 어긋난다.
function testRoundScopeIsDerivedNotDeclared() {
  const workspace = path.join(os.tmpdir(), `rundol-test-round-${process.pid}`);
  fs.rmSync(workspace, { recursive: true, force: true });
  try {
    copyDirectory(path.join(root, 'test', 'fixtures', 'workspace'), workspace);
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Rundol Test'], ['config', 'user.email', 'rundol@example.test'], ['add', '.'], ['commit', '-m', 'initial']]) {
      assert.strictEqual(spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }).status, 0, args.join(' '));
    }
    rdl(workspace, ['git', 'init']);

    const empty = testRounds(workspace, {});
    assert.deepStrictEqual(empty.rounds, []);
    assert.strictEqual(empty.latest, null);
    assert(empty.documents > 0, '픽스처에 TST 문서가 있어야 합니다');

    const created = rdl(workspace, ['task', 'add', '1차 실행', '--owner', 'MEMBER-001', '--kind', 'test', '--round', '1', '--link', 'TST-001', '--acceptance', '수행한다.']);
    rdl(workspace, ['task', 'acceptance', created.taskId, 'AC-001', '--done']);
    rdl(workspace, ['task', 'set', created.taskId, '--status', 'done', '--result', 'pass']);

    const listed = testRounds(workspace, {});
    assert.deepStrictEqual(listed.rounds, [1]);
    assert.strictEqual(listed.latest, 1);
    assert.deepStrictEqual(listed.summary[0].results, { pass: 1 });
    assert.strictEqual(listed.summary[0].covered, 1);

    const detail = testRounds(workspace, { round: 1 });
    assert.strictEqual(detail.tasks.length, 1);
    assert.strictEqual(detail.tasks[0].document, 'TST-001');
    assert.strictEqual(detail.coverage.covered, 1);
    assert.strictEqual(detail.coverage.total, detail.documents);
    assert.strictEqual(detail.coverage.missing.length, detail.documents - 1);
    assert(!detail.coverage.missing.some((document) => document.id === 'TST-001'));
    assert(detail.coverage.missing.every((document) => /^TST-\d{3,}$/u.test(document.id)));

    // 태스크가 하나도 없는 차수를 물으면 전부 빠진 것으로 답한다. 빈 결과가 아니라
    // "아무것도 안 돌렸다"가 답이다.
    const untouched = testRounds(workspace, { round: 9 });
    assert.deepStrictEqual(untouched.tasks, []);
    assert.strictEqual(untouched.coverage.covered, 0);
    assert.strictEqual(untouched.coverage.missing.length, untouched.documents);

    // 반려한 태스크는 범위를 차지하지 않는다.
    const cancelled = rdl(workspace, ['task', 'add', '2차 실행', '--owner', 'MEMBER-001', '--kind', 'test', '--round', '2', '--link', 'TST-001', '--acceptance', '수행한다.']);
    rdl(workspace, ['task', 'set', cancelled.taskId, '--status', 'cancelled', '--reason', '범위에서 제외', '--decided-by', 'MEMBER-001']);
    const second = testRounds(workspace, { round: 2 });
    assert.deepStrictEqual(second.results, { cancelled: 1 });
    assert.strictEqual(second.coverage.covered, 1, '반려해도 태스크가 있으면 그 차수에 다뤄진 것으로 셉니다');
  }
  finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

testRoundScopeIsDerivedNotDeclared();
process.stdout.write('test round tests passed' + String.fromCharCode(10));
