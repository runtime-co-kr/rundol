'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { commandCatalog, listTasks, agentContext } = require('../src/agent-context');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-agent-context-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

try {
  // 구조화 도움말은 usage 텍스트 하나에서 파생한다 — 사본이 아니라 파생이므로
  // CLI가 바뀌면 기계용 목록도 같이 바뀐다.
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd: repository, encoding: 'utf8' });
  assert.strictEqual(help.status, 0, help.stderr || help.stdout);
  const catalog = commandCatalog(help.stdout);
  assert.match(catalog.version, /^\d+\.\d+\.\d+$/u);
  assert(catalog.commands.length > 40, `명령 수가 비정상입니다: ${catalog.commands.length}`);
  const taskList = catalog.commands.find((entry) => entry.command === 'task list');
  assert(taskList, 'rdl task list가 카탈로그에 없습니다.');
  assert.deepStrictEqual(taskList.flags, ['--json', '--kind', '--open', '--project', '--round', '--status']);
  // 여러 줄로 이어진 명령은 하나의 항목으로 합쳐진다.
  const taskAdd = catalog.commands.find((entry) => entry.command === 'task add');
  assert(taskAdd.flags.includes('--reviewer') && taskAdd.flags.includes('--priority'), '이어진 줄의 플래그가 누락됐습니다.');
  assert(taskAdd.flags.includes('--kind'), '태스크 종류 플래그가 카탈로그에 있어야 합니다.');
  const taskSet = catalog.commands.find((entry) => entry.command === 'task set');
  assert(taskSet.flags.includes('--result'), '테스트 판정 플래그가 카탈로그에 있어야 합니다.');
  const testRounds = catalog.commands.find((entry) => entry.command === 'test rounds');
  assert(testRounds && testRounds.flags.includes('--round'), '테스트 차수 조회가 카탈로그에 있어야 합니다.');
  const rootOption = catalog.options.find((entry) => entry.flag === '--root');
  assert.strictEqual(rootOption.argument, '<path>');
  assert(rootOption.description.length > 0);
  assert.throws(() => commandCatalog('사용법 없음'), /Usage\/Options/u);

  const helpJson = JSON.parse(command(process.execPath, [cli, 'help', '--json'], repository));
  assert.strictEqual(helpJson.commands.length, catalog.commands.length, 'rdl help --json은 같은 카탈로그를 반환해야 합니다.');

  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# agent context\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['contract', 'set', '--project', 'crm', '--profile', 'lean', '--enforcement', 'advisory']);

  const first = rdl(['task', 'add', '첫 태스크', '--project', 'crm', '--acceptance', '완료조건', '--priority', 'high']);
  const second = rdl(['task', 'add', '두 번째 태스크', '--project', 'crm', '--acceptance', '완료조건', '--priority', 'low']);
  rdl(['task', 'set', second.taskId, '--project', 'crm', '--status', 'doing', '--owner', 'MEMBER-001']);

  const listed = listTasks(temporary, { project: 'crm' });
  assert.deepStrictEqual(listed.projects, ['crm']);
  assert.strictEqual(listed.total, 2);
  assert.deepStrictEqual(listed.counts, { todo: 1, doing: 1 });
  // 정렬은 상태(doing 우선) → 우선순위 → ID 순으로 결정적이다.
  assert.deepStrictEqual(listed.tasks.map((task) => task.id), [second.taskId, first.taskId]);
  assert.deepStrictEqual(listed.tasks[0].acceptance, { done: 0, total: 1 });
  assert.strictEqual(listed.tasks[0].project, 'crm');

  assert.deepStrictEqual(listTasks(temporary, { project: 'crm', status: 'todo' }).tasks.map((task) => task.id), [first.taskId]);
  assert.strictEqual(listTasks(temporary, { project: 'crm', open: true }).tasks.length, 2);
  // 카운트는 필터와 무관하게 전체를 센다 — 필터된 목록만 보고 남은 일의 양을 오해하지 않게.
  assert.deepStrictEqual(listTasks(temporary, { project: 'crm', status: 'todo' }).counts, { todo: 1, doing: 1 });

  const context = agentContext(temporary, { project: 'crm' });
  assert.strictEqual(context.root, temporary);
  assert.deepStrictEqual(context.projects.map((project) => project.key), ['crm']);
  assert.strictEqual(context.branch.current, 'main');
  assert.strictEqual(context.diagnostics.errors, 0);
  assert.deepStrictEqual(context.tasks.active.map((task) => task.id), [second.taskId]);
  assert.deepStrictEqual(context.tasks.todo.map((task) => task.id), [first.taskId]);
  // 다음 행동은 상태에서 결정적으로 계산된다 — 진행 중인 태스크가 있으면 그것부터다.
  assert(context.next[0].includes(second.taskId), `다음 행동이 진행 중 태스크를 가리키지 않습니다: ${context.next[0]}`);
  assert(context.commands.tasks.startsWith('rdl task list'));

  rdl(['task', 'set', second.taskId, '--project', 'crm', '--status', 'todo']);
  const idle = agentContext(temporary, { project: 'crm' });
  assert.strictEqual(idle.tasks.active.length, 0);
  assert(idle.next[0].includes('--status doing'), `진행 중 태스크가 없으면 시작 안내여야 합니다: ${idle.next[0]}`);

  const listedCli = JSON.parse(command(process.execPath, [cli, 'task', 'list', '--project', 'crm', '--root', temporary, '--open', '--json'], repository));
  assert.strictEqual(listedCli.tasks.length, 2);
  const contextCli = JSON.parse(command(process.execPath, [cli, 'context', '--project', 'crm', '--root', temporary, '--json'], repository));
  assert.strictEqual(contextCli.root, temporary);
  assert(Array.isArray(contextCli.next) && contextCli.next.length > 0);

  process.stdout.write('agent context tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
