'use strict';

// 저장이 어느 태스크의 일인지 묻는 강제(REQ-046).
//
// 여기서 확인하는 것은 "막힌다"가 아니라 "막는 것이 실제로 이 검사인가"이다. 이전에
// 네 차례, 방어를 껐는데도 시험이 통과한 적이 있다 — 다른 이유로 멈춘 것을 이 방어가
// 막았다고 읽었기 때문이다. 그래서 거부 단언은 모두 RDL-TASK-03x 코드를 함께 본다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { taskEnforcementFrom } = require('../src/document-profile');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(cwd, args) {
  return command('git', args, cwd);
}

function rdl(cwd, args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), root));
}

function rdlFails(cwd, args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), { cwd: root, encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0, `실패를 기대했는데 성공했습니다: rdl ${args.join(' ')}\n${result.stdout}`);
  return `${result.stdout}\n${result.stderr}`;
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

function initializeWorkspace(workspace) {
  copyDirectory(path.join(root, 'test', 'fixtures', 'workspace'), workspace);
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'Rundol Test']);
  git(workspace, ['config', 'user.email', 'rundol@example.test']);
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'initial workspace']);
  rdl(workspace, ['git', 'init']);
}

function touch(workspace, note) {
  fs.appendFileSync(path.join(workspace, 'projects', 'tms', 'project.md'), `\n<!-- ${note} -->\n`);
}

function trailerOf(workspace, key) {
  const body = git(workspace, ['log', '-1', '--format=%B', 'refs/heads/rundol/tms']);
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, 'mu').exec(body);
  return match ? match[1].trim() : null;
}

// lean으로 고르는 이유는 이 시험의 대상이 문서 축이 아니기 때문이다. 문서가 모자라
// 막히면 태스크 축이 막았는지 문서 축이 막았는지 구분할 수 없다.
function setTaskEnforcement(workspace, level) {
  return rdl(workspace, ['contract', 'set', '--project', 'tms', '--profile', 'lean', '--task-enforcement', level]);
}

// 픽스처에는 이미 진행 중인 태스크가 있다. 추론을 시험하려면 무엇이 진행 중인지를
// 이 시험이 정해야 한다 — 픽스처가 정하면 픽스처가 바뀔 때 시험의 뜻이 바뀐다.
function clearDoingTasks(workspace) {
  const store = JSON.parse(fs.readFileSync(path.join(workspace, 'projects', 'tms', 'tasks.json'), 'utf8'));
  for (const [id, task] of Object.entries(store.tasks || {})) {
    if (task && task.status === 'doing') rdl(workspace, ['task', 'set', id, '--status', 'todo']);
  }
}

function addTask(workspace, title) {
  return rdl(workspace, ['task', 'add', title, '--summary', `${title}을(를) 검증한다.`, '--owner', 'MEMBER-001', '--acceptance', '검증된다.']);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-task-binding-'));
try {
  const workspace = path.join(temporary, 'workspace');
  initializeWorkspace(workspace);
  clearDoingTasks(workspace);

  // ── 경고 수준: 이 변경 전과 같은 동작 ─────────────────────────────────
  //
  // 태스크 축을 더한 것만으로 기존 프로젝트의 저장이 달라지면 안 된다. 계약에
  // taskEnforcement가 없는 상태가 바로 그 프로젝트다.
  assert.strictEqual(rdl(workspace, ['contract', 'show', '--project', 'tms']).taskEnforcement, 'advisory');
  touch(workspace, 'advisory-1');
  const advisory = rdl(workspace, ['save']);
  assert.strictEqual(advisory.changed, true);
  assert.strictEqual(advisory.task, null);
  assert(advisory.notices.some((item) => item.startsWith('RDL-TASK-034')), JSON.stringify(advisory.notices));
  // 경고 수준에서는 우회할 것이 없다. 아무것도 막지 않는 자리에 사유를 적는 습관만 남는다.
  touch(workspace, 'advisory-2');
  assert(rdlFails(workspace, ['save', '--no-task', '사유']).includes('RDL-TASK-031'));

  // ── 거부 수준 ───────────────────────────────────────────────────────
  setTaskEnforcement(workspace, 'checkpoint');
  assert.strictEqual(rdl(workspace, ['contract', 'show', '--project', 'tms']).taskEnforcement, 'checkpoint');
  // 계약 저장 자체가 작업 트리를 바꿨으므로 먼저 비운다. 이 시험이 보려는 것은
  // 계약 변경의 저장이 아니라 그 다음 저장이다.
  rdl(workspace, ['save', '--no-task', '계약 변경 반영']);

  touch(workspace, 'checkpoint-1');
  const blocked = rdlFails(workspace, ['save']);
  assert(blocked.includes('RDL-TASK-033'), blocked);
  // 막혔으면 커밋도 없어야 한다. 거부는 저장하지 않는 것이지 저장하고 알리는 것이 아니다.
  assert.strictEqual(git(workspace, ['log', '-1', '--format=%s', 'refs/heads/rundol/tms']), 'rdl: update workspace');

  // 없는 태스크로는 묶을 수 없다. 묶이지 않은 식별자를 적으면 결박이 있었다는
  // 기록만 남고 가리키는 곳이 없다.
  assert(rdlFails(workspace, ['save', '--task', 'TASK-ZZZZZZZZ']).includes('RDL-TASK-032'));
  assert(rdlFails(workspace, ['save', '--task', 'TASK-ZZZZZZZZ', '--no-task', '사유']).includes('RDL-TASK-030'));

  const first = addTask(workspace, '결박 대상 태스크');
  const bound = rdl(workspace, ['save', '--task', first.taskId]);
  assert.strictEqual(bound.task, first.taskId);
  assert.strictEqual(bound.taskInferred, false);
  assert.strictEqual(trailerOf(workspace, 'Rundol-Task'), first.taskId);

  // ── 추론 ────────────────────────────────────────────────────────────
  touch(workspace, 'infer-1');
  // 진행 중이 없으면 추론하지 않는다. 없는 것을 골라 주면 틀린 결박이 된다.
  assert(rdlFails(workspace, ['save']).includes('RDL-TASK-033'));
  rdl(workspace, ['task', 'set', first.taskId, '--status', 'doing']);
  const inferred = rdl(workspace, ['save']);
  assert.strictEqual(inferred.task, first.taskId);
  assert.strictEqual(inferred.taskInferred, true);
  assert(inferred.notices.some((item) => item.includes(first.taskId)), JSON.stringify(inferred.notices));

  // 둘 이상이면 추론하지 않는다. 틀린 결박은 결박이 없는 것보다 나쁘다.
  const second = addTask(workspace, '두 번째 진행 태스크');
  rdl(workspace, ['task', 'set', second.taskId, '--status', 'doing']);
  touch(workspace, 'infer-2');
  const ambiguous = rdlFails(workspace, ['save']);
  assert(ambiguous.includes('RDL-TASK-033') && ambiguous.includes(second.taskId), ambiguous);

  // ── 우회 ────────────────────────────────────────────────────────────
  const excused = rdl(workspace, ['save', '--no-task', '긴급 롤백이라 태스크를 만들 수 없었다']);
  assert.strictEqual(excused.task, null);
  assert.strictEqual(trailerOf(workspace, 'Rundol-Task'), 'none');
  assert.strictEqual(trailerOf(workspace, 'Rundol-Task-Reason'), '긴급 롤백이라 태스크를 만들 수 없었다');
  // 사유는 설정에 남지 않는다. 저장되는 우회는 한 번 켜면 계속 통한다.
  assert(!fs.readFileSync(path.join(workspace, 'projects', 'tms', 'project.md'), 'utf8').includes('긴급 롤백'));
  touch(workspace, 'after-excuse');
  assert(rdlFails(workspace, ['save']).includes('RDL-TASK-033'));

  // ── 끝난 태스크에는 묶을 수 없다 ─────────────────────────────────────
  //
  // 존재만 확인하면 결박이 증명하는 것은 "활성 작업에 속한다"가 아니라 "존재하는
  // 문자열이다"가 된다. 완료된 태스크를 가리키는 커밋은 그 태스크가 끝난 뒤에 생긴
  // 일이므로 그 태스크의 일일 수 없다.
  const finished = addTask(workspace, '끝난 태스크');
  rdl(workspace, ['task', 'set', finished.taskId, '--status', 'cancelled', '--reason', '다른 방향으로 결정']);
  touch(workspace, 'terminal-1');
  const terminal = rdlFails(workspace, ['save', '--task', finished.taskId]);
  assert(terminal.includes('RDL-TASK-037'), terminal);

  // ── 거부된 저장은 index에 흔적을 남기지 않는다 ────────────────────────
  //
  // 담은 뒤에 거부하면 그 저장은 실패했는데 다음 저장이 그 결과를 물려받는다.
  const worktreeRoot = path.join(workspace, 'projects', 'tms');
  assert.strictEqual(git(worktreeRoot, ['diff', '--cached', '--name-only']), '',
    '거부된 저장이 staged 변경을 남겼습니다');

  // ── 잘못 적힌 강제 수준은 조용히 약해지지 않는다 ──────────────────────
  //
  // 오타를 기본값으로 접으면, 켰다고 믿는 사람의 프로젝트가 아무것도 막지 않는
  // 상태로 돈다. 설정 실수가 강제 수준 약화로 이어지면 안 된다.
  {
    const charter = path.join(worktreeRoot, 'project.md');
    const original = fs.readFileSync(charter, 'utf8');
    try {
      fs.writeFileSync(charter, original.replace(/^  taskEnforcement: checkpoint$/mu, '  taskEnforcement: checkpont'), 'utf8');
      assert.notStrictEqual(fs.readFileSync(charter, 'utf8'), original, '이 시험의 전제가 깨졌습니다');
      const typo = rdlFails(workspace, ['save']);
      // 막히기만 하면 되는 것이 아니라 무엇이 틀렸는지 말해야 한다. 계약 검사가
      // 먼저 잡아도 좋지만, 그 검사를 지나오는 경로가 따로 있으므로 저장 경로도
      // 스스로 거부해야 한다 — 아래 단위 단언이 그것을 본다.
      assert(typo.includes('checkpont'), typo);
      assert.throws(() => taskEnforcementFrom(fs.readFileSync(charter, 'utf8')), /RDL-TASK-036/u,
        '저장 경로가 잘못 적힌 값을 조용히 advisory로 바꿨습니다');
    } finally {
      fs.writeFileSync(charter, original, 'utf8');
    }
  }

  // ── 방어를 끄면 시험이 실패하는가 ────────────────────────────────────
  //
  // 이 확인이 없으면 위의 거부 단언들이 다른 이유로 통과할 수 있다.
  {
    const source = path.join(root, 'src', 'state.js');
    const original = fs.readFileSync(source, 'utf8');
    const anchor = "  if (level === 'checkpoint') throw new Error(`RDL-TASK-033:";
    assert(original.includes(anchor), '방어 지점을 찾지 못했습니다. 이 시험의 전제가 깨졌습니다.');
    try {
      fs.writeFileSync(source, original.replace(anchor, "  if (false) throw new Error(`RDL-TASK-033:"), 'utf8');
      const result = spawnSync(process.execPath, [cli, 'save', '--root', workspace, '--json'], { cwd: root, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `방어를 껐는데도 저장이 막혔습니다. 막은 것은 이 검사가 아닙니다:\n${result.stdout}\n${result.stderr}`);
    } finally {
      fs.writeFileSync(source, original, 'utf8');
    }
  }

  // ── 사후 가시성 ──────────────────────────────────────────────────────
  //
  // Rundol의 저장을 지나지 않은 커밋에는 결박을 요구할 방법이 없다. 없앨 수 없는
  // 한계이므로 감추지 않고 검사가 드러낸다.
  const worktree = path.join(workspace, 'projects', 'tms');
  fs.appendFileSync(path.join(worktree, 'project.md'), '\n<!-- git으로 직접 만든 커밋 -->\n');
  git(worktree, ['add', '--', 'project.md']);
  git(worktree, ['commit', '-m', 'bypassed the save gate']);
  const checked = rdl(workspace, ['check']);
  const codes = checked.diagnostics.map((item) => item.code);
  // 우회는 막지 않는 통제다. 막지 않는 통제가 값을 가지려면 얼마나 쓰였는지 셀 수
  // 있어야 하고, 세려면 진단 목록이 아니라 요약에 있어야 한다 — 경고 수십 개 사이에
  // 묻힌 숫자는 아무도 세지 않고, 세지 않는 우회는 예외가 아니라 그냥 다른 길이 된다.
  const tally = checked.summary.taskBinding;
  assert(tally, '결박 집계가 요약에 없습니다');
  assert(tally.scanned > 0, JSON.stringify(tally));
  assert(tally.bound > 0, `결박된 커밋이 세어지지 않았습니다: ${JSON.stringify(tally)}`);
  assert(tally.excused > 0, `우회한 커밋이 세어지지 않았습니다: ${JSON.stringify(tally)}`);
  assert(tally.unbound > 0, `결박을 지나지 않은 커밋이 세어지지 않았습니다: ${JSON.stringify(tally)}`);
  assert.strictEqual(tally.scanned, tally.bound + tally.excused + tally.unbound,
    `집계가 스캔한 커밋 수와 맞지 않습니다: ${JSON.stringify(tally)}`);
  assert(codes.includes('RDL-TASK-034'), `게이트를 지나지 않은 커밋이 드러나지 않았습니다: ${codes.join(', ')}`);
  assert(codes.includes('RDL-TASK-035'), `우회로 저장된 커밋이 드러나지 않았습니다: ${codes.join(', ')}`);

  // trailer가 있다는 것과 그것이 가리키는 태스크가 있다는 것은 다른 사실이다.
  // 줄만 세면 Git으로 직접 만든 커밋에 아무 문자열이나 적어 이 검사를 지날 수 있고,
  // 그러면 검사가 세는 것은 결박이 아니라 그 줄을 적을 줄 아는 사람의 수다.
  touch(workspace, '위조된 결박');
  git(worktree, ['add', '--', 'project.md']);
  git(worktree, ['commit', '-m', `forged binding${String.fromCharCode(10, 10)}Rundol-Task: TASK-ZZZZZZZZ`]);
  const forged = rdl(workspace, ['check']).diagnostics.map((item) => item.code);
  assert(forged.includes('RDL-TASK-039'), `없는 태스크를 가리키는 커밋이 드러나지 않았습니다: ${forged.join(', ')}`);

  process.stdout.write('task binding tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
