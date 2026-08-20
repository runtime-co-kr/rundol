'use strict';

// 태스크의 문서 링크 편집. 이 경로가 없으면 태스크 수명주기에 막다른 길이 생긴다.
//
// RDL-TASK-019는 done 태스크에 TST 링크를 요구하는데, 링크는 생성 시점에만 정할 수
// 있었다. 그래서 링크 없이 만든 태스크는 명령줄로 영원히 닫히지 않았고, 가리키던
// 문서가 폐기되면 그 참조를 지울 방법도 없어 검사가 계속 실패했다. 실제로 문서
// 소프트 리스를 폐기할 때 이 두 상황이 한꺼번에 일어났다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-task-link-'));
try {
  const workspace = path.join(temporary, 'workspace');
  copyDirectory(path.join(root, 'test', 'fixtures', 'workspace'), workspace);
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'Rundol Test']);
  git(workspace, ['config', 'user.email', 'rundol@example.test']);
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'initial workspace']);
  rdl(workspace, ['git', 'init']);

  const created = rdl(workspace, ['task', 'add', '링크 편집 시험', '--project', 'tms', '--acceptance', '링크를 고칠 수 있다.']);
  const id = created.taskId;
  assert.deepStrictEqual(created.task.links, [], '링크 없이 만든 태스크가 시작점이다.');

  // 같은 호출 안의 중복도 한 번만 남는다. 이미 있는 것과의 중복만 막으면 링크가
  // 없던 태스크에 같은 값을 두 번 준 경우가 그대로 통과한다 — 걸러 낼 기존 목록이
  // 비어 있기 때문이다.
  const doubled = rdl(workspace, ['task', 'set', id, '--project', 'tms', '--link', 'REQ-001', '--link', 'REQ-001']);
  assert.deepStrictEqual(doubled.after.links, ['REQ-001'], '한 호출 안의 중복이 그대로 들어갔습니다.');
  rdl(workspace, ['task', 'set', id, '--project', 'tms', '--unlink', 'REQ-001']);

  // 붙이기. 생성 이후에도 링크를 더할 수 있어야 done 게이트에 도달할 수 있다.
  const added = rdl(workspace, ['task', 'set', id, '--project', 'tms', '--link', 'REQ-001']);
  assert.deepStrictEqual(added.after.links, ['REQ-001']);

  // 여러 개를 한 번에, 그리고 같은 링크를 두 번 붙여도 한 번만 남는다.
  const many = rdl(workspace, ['task', 'set', id, '--project', 'tms', '--link', 'TST-001', '--link', 'REQ-001', '--link', 'ARC-001']);
  assert.deepStrictEqual(many.after.links, ['REQ-001', 'TST-001', 'ARC-001'], '중복은 합치고 기존 순서를 앞에 둔다.');

  // 떼기. 폐기된 문서를 가리키는 참조를 지울 수 있어야 검사가 다시 통과한다.
  const removed = rdl(workspace, ['task', 'set', id, '--project', 'tms', '--unlink', 'ARC-001']);
  assert.deepStrictEqual(removed.after.links, ['REQ-001', 'TST-001']);

  // 붙이기와 떼기를 한 번에. 떼기가 먼저 적용되어야 같은 호출에서 교체가 된다.
  const swapped = rdl(workspace, ['task', 'set', id, '--project', 'tms', '--unlink', 'REQ-001', '--link', 'REQ-001']);
  assert.deepStrictEqual(swapped.after.links, ['TST-001', 'REQ-001']);

  // 없는 링크를 떼려는 시도는 조용히 넘기지 않는다. 조용히 넘기면 오타로 지운 줄
  // 알고 넘어가고, 정작 끊긴 참조는 그대로 남는다.
  assert(rdlFails(workspace, ['task', 'set', id, '--project', 'tms', '--unlink', 'MOD-999']).includes('MOD-999'));

  // 변경 인자가 하나도 없으면 무엇이 필요한지 알린다.
  assert(rdlFails(workspace, ['task', 'set', id, '--project', 'tms']).includes('--link'));

  // 변경이 원장에 남는다. 링크 편집도 태스크 커밋을 만든다.
  assert(typeof swapped.commit === 'string' && swapped.commit.length > 0, '링크 변경이 커밋을 남겨야 한다.');

  process.stdout.write('task link tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
