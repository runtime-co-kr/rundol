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
  return { ok: result.status === 0, said: said.join(' '), stderr: result.stderr || '' };
}

// 훅이 무엇을 보고 그렇게 판정했는지. 셸 안에서 도는 판정은 실패해도 아무것도
// 남기지 않으므로, 어긋났을 때 이 값들이 없으면 다른 기계의 CI 한 판을 통째로
// 써서 같은 물음을 다시 물어야 한다. 실제로 macOS에서만 갈리던 판정이 그랬다.
function hookEvidence() {
  const file = path.join(temporary, '.git', 'hooks', 'pre-commit');
  let mode = '(없음)';
  try { mode = `0${(fs.statSync(file).mode & 0o777).toString(8)}`; } catch (_) { /* 위의 값이 답이다 */ }
  const ask = (args) => {
    const answer = attempt(args);
    return answer.status === 0 ? String(answer.stdout || '').trim() : `(실패 ${answer.status})`;
  };
  return [
    `platform=${process.platform}`,
    `pre-commit mode=${mode}`,
    `HEAD=${ask(['symbolic-ref', '--quiet', '--short', 'HEAD'])}`,
    `origin/HEAD=${ask(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])}`,
    `staged=${ask(['diff', '--cached', '--name-only']).replace(/\s+/gu, ',')}`
  ].join(' · ');
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

  // 한글 바로 앞의 변수는 중괄호로 묶여 있어야 한다.
  //
  // macOS의 /bin/sh는 bash 3.2이고 비UTF-8 로케일에서 뒤따르는 한글 바이트를 변수
  // 이름으로 빨아들인다. `$default에`는 "default에"라는 없는 변수가 되고 set -u가
  // 거기서 끝낸다 — 훅은 막지만 왜 막혔는지 말하지 못한다. 우리 안내문은 거의 다
  // 한글이므로 이 실수는 다음 훅에서도 자연스럽게 다시 나온다.
  //
  // 실제 커밋으로는 이 결함이 리눅스·윈도우에서 재현되지 않는다. 그래서 행동이
  // 아니라 설치된 바이트의 모양을 본다 — 어느 기계에서 돌든 같은 답이 나온다.
  // 전체 줄 주석은 셸이 확장하지 않으므로 검사에서 뺀다. 이 규칙을 설명하는 주석
  // 자신이 나쁜 모양을 담고 있어야 하기 때문이다. 이 훅들에는 heredoc이 없으므로
  // 첫 글자가 #인 줄은 언제나 주석이다.
  for (const item of installed) {
    const body = fs.readFileSync(item.file, 'utf8').replace(/^[ \t]*#.*$/gmu, '');
    const unbraced = body.match(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/gu) || [];
    assert.deepStrictEqual(unbraced, [], `${item.name}: 한글 앞의 변수를 중괄호로 묶으세요: ${unbraced.join(', ')}`);
  }

  // ── 브랜치 규칙 (pre-commit) ─────────────────────────────────────────

  const onMain = commit('main', 'src/a.js', 'feat: 코드');
  assert.strictEqual(onMain.ok, false, '기본 브랜치에서 제품 코드를 담을 수 없다');
  assert.ok(
    onMain.said.includes('rdl session start'),
    `사유가 다음 명령을 담는다 — ${hookEvidence()} · stderr=${JSON.stringify(onMain.stderr)}`
  );

  // 트레일러가 있어도 브랜치 규칙이 먼저다. 두 규칙은 다른 물음이며, 하나를 지켰다고
  // 다른 하나가 면제되면 경계는 둘 중 약한 쪽이 된다.
  assert.strictEqual(commit('main', 'src/b.js', 'feat: 코드\n\nRundol-Task: TASK-1').ok, false, '결박이 브랜치 규칙을 대신하지 않는다');

  // 문서는 대상이 아니다. 이 목록은 Rundol을 쓰는 모든 프로젝트에 실려 나가는 기본값이고,
  // 남의 저장소에서 문서 한 줄 고치는 데 브랜치를 요구하는 것은 이 도구가 정할 일이 아니다.
  assert.ok(commit('main', 'docs/a.md', 'docs: 문서').ok, '제품 코드가 아니면 기본 브랜치에서도 담는다');

  // 실행되는 코드만 제품 코드가 아니다. 스킬은 세 클라이언트의 홈에 복사되어 에이전트의
  // 판단을 바꾸고, 배포 워크플로는 무엇이 npm에 올라가는지를 정하며, 시험은 통제가 실제로
  // 서 있는지를 판정한다. 셋 다 기본 브랜치에서 조용히 바뀌면 안 되는 것들이다.
  for (const guarded of ['skills/rundol-project-governance/SKILL.md', '.github/workflows/release.yml', 'test/x.test.js']) {
    assert.strictEqual(commit('main', guarded, `chore: ${guarded}`).ok, false, `${guarded}는 기본 브랜치에서 담을 수 없다`);
  }

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

  // ── 멈춘 병합은 손으로 마칠 수 있다 ──────────────────────────────────
  //
  // 제 말로 적은 병합 메시지는 commit-msg의 문구 면제를 타지 못해 결박을 요구받고, 그
  // 요구는 병합을 중간에 세운다. 거기서 pre-commit까지 막으면 그 병합은 마칠 수도 없고,
  // 그 상태에서 "세션을 여세요"는 할 수 있는 일이 아니다 — 되돌리는 것 말고 길이 없다.
  //
  // 위의 병합 단언은 이 자리를 지나가지 않는다. git merge가 스스로 마치면 pre-commit은
  // 애초에 불리지 않기 때문이다.
  attempt(['checkout', '-q', '-B', 'session/landing3', before]);
  put('src/landing3.js', 'landing3\n');
  git(['add', '-A']);
  attempt(['commit', '-m', 'feat: 세 번째 안착\n\nRundol-Task: TASK-5']);
  attempt(['checkout', '-q', 'main']);
  const halted = attempt(['merge', '--no-ff', 'session/landing3', '-m', '병합: 제 말로 적은 메시지']);
  assert.notStrictEqual(halted.status, 0, '결박 없는 병합 메시지는 commit-msg가 세운다');
  assert.ok(fs.existsSync(path.join(temporary, '.git', 'MERGE_HEAD')), '멈춘 병합이 상태로 남는다');
  assert.strictEqual(
    attempt(['commit', '-m', '병합: 제 말로 적은 메시지\n\nRundol-Task: TASK-5']).status, 0,
    `멈춘 병합을 손으로 마칠 수 있어야 한다 — ${hookEvidence()}`
  );

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
