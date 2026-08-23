'use strict';

// 커밋 경계. 실제 git commit을 쳐서 확인한다.
//
// 훅은 셸이 실행하므로 함수를 부르는 것으로는 시험할 수 없다. 렌더링한 문자열만 보면
// set -e가 삼키는 실패처럼 셸에서만 드러나는 것을 놓친다 — 실제로 `grep && exit 0`이
// 사유를 출력하지 못하고 끝나던 버그가 그 방식으로는 보이지 않았다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { commitBoundaryStatus, installCommitBoundary, HOOKS } = require('../src/commit-boundary');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-commit-boundary-'));

function git(args) {
  return execFileSync('git', ['-C', temporary].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function attempt(args) {
  return spawnSync('git', ['-C', temporary].concat(args), { encoding: 'utf8' });
}

function put(relative, body) {
  const file = path.join(temporary, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

// 한 시도가 남긴 스테이지가 다음 시도에 섞이면 판정이 자기 것이 아니게 된다.
function commit(branch, relative, message) {
  attempt(['reset', '--hard', '-q']);
  attempt(['clean', '-qfd']);
  attempt(['checkout', '-q', '-B', branch]);
  put(relative, `${Math.random()}\n`);
  git(['add', '-A']);
  const result = attempt(['commit', '-m', message]);
  const said = (result.stderr || '').split(/\r?\n/u).filter((line) => line.startsWith('rdl:'));
  return { ok: result.status === 0, said: said.join(' ') };
}

try {
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'boundary@test.local']);
  git(['config', 'user.name', 'Boundary Test']);
  git(['config', 'core.autocrlf', 'false']);
  put('README.md', 'base\n');
  git(['add', '-A']);
  git(['commit', '-m', 'base']);

  // 기본 브랜치를 모르는 저장소에서는 판정하지 않는다. 추측해서 막으면 그 추측이 틀린
  // 저장소에서 아무 커밋도 할 수 없게 된다.
  installCommitBoundary(temporary);
  // 결박은 origin/HEAD와 무관하게 선다. 두 규칙을 한 커밋으로 재면 어느 쪽이 막았는지
  // 알 수 없으므로 트레일러를 붙여 브랜치 규칙만 남긴다.
  assert.ok(commit('main', 'src/early.js', 'feat: origin/HEAD 없이\n\nRundol-Task: TASK-0').ok, 'origin/HEAD가 없으면 브랜치 규칙이 서지 않는다');
  assert.strictEqual(commit('main', 'src/early2.js', 'feat: 결박 없이').ok, false, '결박 규칙은 기본 브랜치를 몰라도 선다');

  fs.mkdirSync(path.join(temporary, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  fs.writeFileSync(path.join(temporary, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/main\n', 'utf8');

  // ── 설치 상태 ────────────────────────────────────────────────────────

  const installed = commitBoundaryStatus(temporary);
  assert.deepStrictEqual(installed.map((item) => item.name), HOOKS, '두 훅을 각각 답한다');
  assert.ok(installed.every((item) => item.managed), '설치한 뒤에는 둘 다 관리형이다');

  // ── 브랜치 규칙 (pre-commit) ─────────────────────────────────────────

  const onMain = commit('main', 'src/a.js', 'feat: 코드');
  assert.strictEqual(onMain.ok, false, '기본 브랜치에서 제품 코드를 담을 수 없다');
  assert.ok(onMain.said.includes('rdl session start'), '사유가 다음 명령을 담는다');

  // 트레일러가 있어도 브랜치 규칙이 먼저다. 두 규칙은 다른 물음이며, 하나를 지켰다고
  // 다른 하나가 면제되면 경계는 둘 중 약한 쪽이 된다.
  assert.strictEqual(commit('main', 'src/b.js', 'feat: 코드\n\nRundol-Task: TASK-1').ok, false, '결박이 브랜치 규칙을 대신하지 않는다');

  assert.ok(commit('main', 'docs/a.md', 'docs: 문서').ok, '제품 코드가 아니면 기본 브랜치에서도 담는다');

  // ── 결박 규칙 (commit-msg) ───────────────────────────────────────────

  const unbound = commit('session/aabbccdd', 'src/c.js', 'feat: 결박 없는 코드');
  assert.strictEqual(unbound.ok, false, '제품 코드 커밋은 어느 태스크의 일인지 밝혀야 한다');
  assert.ok(unbound.said.includes('Rundol-Task'), '고치는 방법을 함께 준다');

  assert.ok(commit('session/aabbccdd', 'src/d.js', 'feat: 코드\n\nRundol-Task: TASK-2').ok, '결박한 커밋은 지난다');

  // 우회를 막으면 결박은 요금이 되고, 요금을 무는 통제는 우회된다. 사유가 남으면
  // 그것은 우회가 아니라 기록이다.
  assert.ok(
    commit('session/aabbccdd', 'src/e.js', 'feat: 코드\n\nRundol-Task: none\nRundol-Task-Reason: 긴급 배포').ok,
    '사유를 남긴 우회는 지난다'
  );

  assert.ok(commit('session/aabbccdd', 'docs/b.md', 'docs: 문서').ok, '제품 코드가 아니면 결박을 묻지 않는다');

  // 병합과 되돌리기는 사람이 새로 쓴 일이 아니므로 결박을 묻지 않는다.
  assert.ok(commit('session/aabbccdd', 'src/f.js', 'Merge branch x').ok, '병합 메시지에는 결박을 묻지 않는다');
  assert.ok(commit('session/aabbccdd', 'src/g.js', 'Revert "feat: 무언가"').ok, '되돌리기에도 묻지 않는다');

  // ── 세션 작업이 기본 브랜치에 안착한다 ────────────────────────────────

  // 막기만 하고 안착할 길이 없으면 경계가 아니라 벽이다.
  attempt(['reset', '--hard', '-q']);
  attempt(['clean', '-qfd']);
  attempt(['checkout', '-q', 'main']);
  const before = git(['rev-parse', 'HEAD']).trim();
  attempt(['checkout', '-q', '-B', 'session/landing', before]);
  put('src/landing.js', 'landing\n');
  git(['add', '-A']);
  assert.strictEqual(attempt(['commit', '-m', 'feat: 안착\n\nRundol-Task: TASK-3']).status, 0);
  attempt(['checkout', '-q', 'main']);
  assert.strictEqual(attempt(['merge', '--ff-only', 'session/landing']).status, 0, 'fast-forward로 안착한다');

  attempt(['checkout', '-q', '-B', 'session/landing2', before]);
  put('src/landing2.js', 'landing2\n');
  git(['add', '-A']);
  attempt(['commit', '-m', 'feat: 또 안착\n\nRundol-Task: TASK-4']);
  attempt(['checkout', '-q', 'main']);
  assert.strictEqual(attempt(['merge', '--no-ff', 'session/landing2', '-m', 'Merge session/landing2']).status, 0, '병합 커밋으로도 안착한다');

  // ── 남의 훅은 잃지 않는다 ────────────────────────────────────────────

  const hooksDir = path.join(temporary, '.git', 'hooks');
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
  const reinstalled = installCommitBoundary(temporary);
  const preCommit = reinstalled.find((item) => item.name === 'pre-commit');
  assert.ok(preCommit.preserved, '관리되지 않는 훅은 보존본으로 옮긴다');
  assert.ok(fs.existsSync(path.join(hooksDir, 'pre-commit.rundol-user')), '보존본이 자리에 있다');

  console.log('commit boundary tests passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
