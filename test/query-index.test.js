'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { INDEX_VERSION, indexFingerprint, buildIndex, readIndex, clearIndex, queryTasks, indexFile } = require('../src/query-index');
const { workspaceLayout } = require('../src/workspace');
const { listTasks } = require('../src/agent-context');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-query-index-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

// 인덱스 경로는 RUNDOL_HOME 아래다. 테스트 프로세스가 직접 부르는 API도 같은
// 홈을 봐야 하므로 환경을 맞춘다.
const previousHome = process.env.RUNDOL_HOME;
process.env.RUNDOL_HOME = home;

try {
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# index\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  const first = rdl(['task', 'add', '첫 태스크', '--project', 'crm', '--acceptance', '완료조건', '--priority', 'high']);
  rdl(['task', 'add', '둘째 태스크', '--project', 'crm', '--acceptance', '완료조건']);

  // 인덱스가 없어도 조회는 답한다 — 정확성의 기준은 무인덱스 경로다.
  assert.strictEqual(readIndex(temporary).status, 'missing');
  const cold = queryTasks(temporary, {});
  assert.strictEqual(cold.source, 'cold');
  assert.strictEqual(cold.tasks.length, 2);

  // 인덱스가 있어도 같은 답이 나온다. 인덱스는 답을 바꾸지 못한다.
  const built = buildIndex(temporary);
  assert.strictEqual(built.version, INDEX_VERSION);
  assert.strictEqual(readIndex(temporary).status, 'valid');
  const indexed = queryTasks(temporary, {});
  assert.strictEqual(indexed.source, 'index');
  assert.deepStrictEqual(indexed.tasks, cold.tasks, '인덱스 경로와 무인덱스 경로의 답이 같아야 합니다.');
  assert.deepStrictEqual(indexed.counts, cold.counts);

  // 필터도 같은 결과를 낸다.
  for (const filter of [{ project: 'crm' }, { status: 'todo' }, { open: true }]) {
    const viaIndex = queryTasks(temporary, filter);
    const viaCold = queryTasks(temporary, Object.assign({ cold: true }, filter));
    assert.deepStrictEqual(viaIndex.tasks, viaCold.tasks, `필터 결과가 갈립니다: ${JSON.stringify(filter)}`);
  }

  // 지워도 데이터가 사라지지 않고 조회는 계속된다.
  const cleared = clearIndex(temporary);
  assert.strictEqual(cleared.removed, true);
  assert.strictEqual(readIndex(temporary).status, 'missing');
  assert.deepStrictEqual(queryTasks(temporary, {}).tasks, cold.tasks, '인덱스를 지워도 같은 답이 나와야 합니다.');

  // 손상된 인덱스는 조회를 실패시키지 않는다 — 캐시가 정확성의 조건이 되면 안 된다.
  buildIndex(temporary);
  fs.writeFileSync(indexFile(temporary), '{깨진 JSON', 'utf8');
  assert.strictEqual(readIndex(temporary).status, 'corrupt');
  assert.strictEqual(queryTasks(temporary, {}).source, 'cold', '손상된 인덱스는 무인덱스 경로로 물러나야 합니다.');

  // 형식이 바뀌면 마이그레이션하지 않고 버린다.
  const stored = JSON.parse(JSON.stringify(buildIndex(temporary)));
  fs.writeFileSync(indexFile(temporary), `${JSON.stringify(Object.assign({}, stored, { version: INDEX_VERSION + 1 }))}\n`, 'utf8');
  assert.strictEqual(readIndex(temporary).status, 'outdated');

  // 낡음 판정: 커밋되지 않은 변경도 정본 입력이다. 이것을 지문에서 빠뜨리면
  // 낡은 인덱스가 유효하다고 판정되어 틀린 답을 자신 있게 내놓는다.
  buildIndex(temporary);
  assert.strictEqual(readIndex(temporary).status, 'valid');
  const layout = workspaceLayout(temporary);
  const documentRoot = path.join(temporary, 'projects', 'crm', 'docs');
  fs.mkdirSync(documentRoot, { recursive: true });
  fs.writeFileSync(path.join(documentRoot, 'untracked-note.md'), '커밋되지 않은 변경\n', 'utf8');
  assert.strictEqual(readIndex(temporary).status, 'stale', '커밋되지 않은 변경이 지문에 반영되어야 합니다.');
  fs.rmSync(path.join(documentRoot, 'untracked-note.md'), { force: true });
  assert.strictEqual(readIndex(temporary).status, 'valid', '변경을 되돌리면 다시 유효해야 합니다.');

  // 태스크 추가는 공유 원장이 아니라 프로젝트 worktree를 바꾸므로 지문이 달라진다.
  const beforeTaskAdd = indexFingerprint(layout);
  rdl(['task', 'add', '셋째 태스크', '--project', 'crm', '--acceptance', '완료조건']);
  assert.notStrictEqual(indexFingerprint(workspaceLayout(temporary)), beforeTaskAdd, '태스크 변경이 지문에 반영되어야 합니다.');
  assert.strictEqual(readIndex(temporary).status, 'stale');
  assert.strictEqual(queryTasks(temporary, {}).tasks.length, 3, '낡은 인덱스 대신 정본을 읽어야 합니다.');

  // 인덱스 내부 키는 문서 고유 식별자다 — 번호를 정리해도 스키마가 남는다.
  const rebuilt = buildIndex(temporary);
  assert(rebuilt.documents.length > 0);
  for (const document of rebuilt.documents) assert(document.uid, `문서에 식별자가 없습니다: ${document.id}`);
  assert.strictEqual(Object.keys(rebuilt.documentUidByDisplayId).length, rebuilt.documents.length);

  // CLI 표면.
  const status = rdl(['index', 'status']);
  assert.strictEqual(status.status, 'valid');
  assert.strictEqual(status.tasks, 3);
  const removed = rdl(['index', 'clear']);
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(rdl(['index', 'status']).status, 'missing');
  assert.strictEqual(rdl(['task', 'list', '--project', 'crm']).tasks.length, 3, '인덱스 없이도 조회는 답해야 합니다.');
  assert.strictEqual(rdl(['index', 'rebuild']).tasks, 3);

  // 인덱스는 정본이 아니라 런타임 홈의 로컬 파생물이다. Workspace의 추적 대상
  // 경로(projects/)에 놓이면 커밋되어 정본을 오염시킨다.
  const location = path.resolve(indexFile(temporary));
  assert(location.startsWith(path.resolve(home) + path.sep), `인덱스는 런타임 홈 아래여야 합니다: ${location}`);
  assert(!location.startsWith(path.resolve(temporary, 'projects') + path.sep), '인덱스가 정본 경로에 있으면 안 됩니다.');

  process.stdout.write('query index tests passed\n');
} finally {
  if (previousHome === undefined) delete process.env.RUNDOL_HOME;
  else process.env.RUNDOL_HOME = previousHome;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
