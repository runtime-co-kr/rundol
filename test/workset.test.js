'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeExternalRef, refOf, assertBranchName, suggestBranchName, worksets, listWorksets } = require('../src/workset');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-workset-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

function attempt(args) {
  return spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
}

try {
  // 예전 문자열 참조는 버리지 않고 종류 없는 참조로 읽힌다 — 마이그레이션 없이 공존한다.
  assert.deepStrictEqual(normalizeExternalRef('https://example.test/pr/1'), { kind: 'other', value: 'https://example.test/pr/1' });
  assert.deepStrictEqual(normalizeExternalRef('branch=feature/x'), { kind: 'branch', value: 'feature/x' });
  assert.deepStrictEqual(normalizeExternalRef({ kind: 'pr', value: 'https://example.test/pr/1' }), { kind: 'pr', value: 'https://example.test/pr/1' });
  assert.deepStrictEqual(normalizeExternalRef({ kind: '지어낸종류', value: 'x' }), { kind: 'other', value: 'x' });

  assert.strictEqual(assertBranchName('feature/query-engine'), 'feature/query-engine');
  for (const invalid of ['', '/leading', 'trailing/', 'double//slash', 'has space', 'dot.', 'tilde~name']) {
    assert.throws(() => assertBranchName(invalid), /브랜치 이름/u, `허용되면 안 되는 이름입니다: ${invalid}`);
  }
  // 권고안은 규약에서 만든다 — 사람에게 빈칸을 내밀지 않는다.
  assert.strictEqual(suggestBranchName({ taskId: 'TASK-00MSWGFOSX374D9E3EE72A1AE8', title: '에이전트 발견 표면' }), 'task/00MSWGFO/에이전트-발견-표면');
  assert.strictEqual(suggestBranchName({ prefix: 'feature', title: 'Query Engine!!' }), 'feature/query-engine');

  // 묶음은 같은 브랜치 참조를 가진 태스크 집합이다. 참조가 없으면 어떤 묶음에도 속하지 않는다.
  const tasks = [
    { id: 'TASK-A', title: '첫째', status: 'done', externalRefs: [{ kind: 'branch', value: 'feature/x' }, { kind: 'pr', value: 'https://example.test/pr/1' }] },
    { id: 'TASK-B', title: '둘째', status: 'review', externalRefs: [{ kind: 'branch', value: 'feature/x' }, { kind: 'pr', value: 'https://example.test/pr/1' }] },
    { id: 'TASK-C', title: '셋째', status: 'doing', externalRefs: [{ kind: 'branch', value: 'feature/y' }] },
    { id: 'TASK-D', title: '넷째', status: 'todo', externalRefs: [] }
  ];
  const computed = worksets(tasks);
  assert.deepStrictEqual(computed.worksets.map((entry) => entry.branch), ['feature/x', 'feature/y']);
  assert.deepStrictEqual(computed.worksets[0].tasks.map((task) => task.id), ['TASK-A', 'TASK-B']);
  assert.deepStrictEqual(computed.worksets[0].pullRequests, ['https://example.test/pr/1'], '하나의 병합 요청이 여러 태스크를 나른다');
  // 묶음의 상태는 가장 덜 진행된 태스크가 정한다 — 하나라도 남으면 안착하지 않았다.
  assert.strictEqual(computed.worksets[0].status, 'review');
  assert.strictEqual(computed.worksets[1].status, 'doing');
  assert.deepStrictEqual(computed.unassigned.map((task) => task.id), ['TASK-D']);
  assert.strictEqual(refOf(tasks[0], 'pr'), 'https://example.test/pr/1');
  assert.strictEqual(refOf(tasks[3], 'branch'), null);

  // 실제 Workspace: 참조 부착으로 묶음이 생기고 review 전이가 도달 가능해진다.
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# workset\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);

  const first = rdl(['task', 'add', '첫 기능', '--project', 'crm', '--acceptance', '완료조건']);
  const second = rdl(['task', 'add', '둘째 기능', '--project', 'crm', '--acceptance', '완료조건']);
  const solo = rdl(['task', 'add', '묶이지 않은 일', '--project', 'crm', '--acceptance', '완료조건']);

  // review 상태는 병합 요청 참조를 요구한다(RDL-TASK-020). 참조 없이는 전이가 거부된다.
  const refused = attempt(['task', 'set', first.taskId, '--project', 'crm', '--status', 'review', '--owner', 'MEMBER-001']);
  assert.notStrictEqual(refused.status, 0, 'PR 참조 없는 review 전이는 거부되어야 합니다.');

  for (const taskId of [first.taskId, second.taskId]) {
    rdl(['task', 'set', taskId, '--project', 'crm', '--external-ref', 'branch=feature/bundle', '--owner', 'MEMBER-001']);
  }
  const listedBranch = rdl(['workset', 'list', '--project', 'crm']);
  assert.strictEqual(listedBranch.total, 1);
  assert.strictEqual(listedBranch.worksets[0].branch, 'feature/bundle');
  assert.deepStrictEqual(listedBranch.worksets[0].tasks.map((task) => task.id).sort(), [first.taskId, second.taskId].sort());
  assert.deepStrictEqual(listedBranch.unassigned.map((task) => task.id), [solo.taskId]);

  // 병합 요청 참조가 붙으면 묶인 태스크가 함께 review로 간다.
  for (const taskId of [first.taskId, second.taskId]) {
    rdl(['task', 'set', taskId, '--project', 'crm', '--external-ref', 'pr=https://example.test/pr/7']);
    rdl(['task', 'set', taskId, '--project', 'crm', '--status', 'review', '--owner', 'MEMBER-001']);
  }
  const reviewing = rdl(['workset', 'list', '--project', 'crm', '--branch', 'feature/bundle']);
  assert.strictEqual(reviewing.worksets[0].status, 'review');
  assert.deepStrictEqual(reviewing.worksets[0].pullRequests, ['https://example.test/pr/7']);

  assert.strictEqual(listWorksets(temporary, { project: 'crm' }).total, 1);
  const checked = rdl(['check']);
  assert.strictEqual(checked.summary.errors, 0, JSON.stringify(checked.diagnostics));

  process.stdout.write('workset tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
