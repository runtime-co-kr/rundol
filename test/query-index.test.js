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
  // 인덱스가 유효해도 기본 경로는 정본이다 — 이 규모에서는 유효성 확인이 읽기보다
  // 비싸다. 인덱스는 요청할 때만 쓴다.
  assert.strictEqual(queryTasks(temporary, {}).source, 'cold', '기본 경로는 정본이어야 합니다.');
  const indexed = queryTasks(temporary, { index: true });
  assert.strictEqual(indexed.source, 'index');
  assert.deepStrictEqual(indexed.tasks, cold.tasks, '인덱스 경로와 무인덱스 경로의 답이 같아야 합니다.');
  assert.deepStrictEqual(indexed.counts, cold.counts);

  // 필터도 같은 결과를 낸다.
  for (const filter of [{ project: 'crm' }, { status: 'todo' }, { open: true }]) {
    const viaIndex = queryTasks(temporary, Object.assign({ index: true }, filter));
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
  assert.strictEqual(queryTasks(temporary, { index: true }).source, 'cold', '손상된 인덱스는 무인덱스 경로로 물러나야 합니다.');

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
  assert.strictEqual(queryTasks(temporary, { index: true }).tasks.length, 3, '낡은 인덱스 대신 정본을 읽어야 합니다.');

  // 내용을 덮지 않는 지문은 낡음을 놓친다. git status는 "무엇이 바뀌었나"만
  // 말하고 "무엇으로 바뀌었나"는 말하지 않으므로, 이미 M으로 표시된 파일을 다시
  // 고치면 상태 줄이 그대로다. 그러면 낡은 인덱스가 유효로 판정되어 조회가
  // 성공하면서 틀린 답을 돌려준다 — 이 기능에서 가장 나쁜 실패다.
  const dirtyFile = path.join(documentRoot, 'dirty-note.md');
  fs.writeFileSync(dirtyFile, '첫 내용\n', 'utf8');
  buildIndex(temporary);
  assert.strictEqual(readIndex(temporary).status, 'valid');
  fs.writeFileSync(dirtyFile, '완전히 다른 내용\n', 'utf8');
  assert.strictEqual(readIndex(temporary).status, 'stale', '이미 dirty인 파일의 내용 변경도 낡음이어야 합니다.');
  fs.rmSync(dirtyFile, { force: true });

  // JSON으로 파싱된다는 것과 쓸 수 있다는 것은 다르다. 형태를 확인하지 않으면
  // 조회가 터진다 — 캐시 손상이 조회 실패가 되면 캐시가 정확성의 조건이 된다.
  buildIndex(temporary);
  const shapeBroken = JSON.parse(fs.readFileSync(indexFile(temporary), 'utf8'));
  shapeBroken.tasks = null;
  fs.writeFileSync(indexFile(temporary), `${JSON.stringify(shapeBroken)}\n`, 'utf8');
  assert.strictEqual(readIndex(temporary).status, 'corrupt', '형태가 깨진 인덱스는 손상으로 봐야 합니다.');
  assert.strictEqual(queryTasks(temporary, { index: true }).source, 'cold', '형태가 깨져도 조회는 정본으로 답해야 합니다.');

  // 인덱스 내부 키는 문서 고유 식별자다 — 번호를 정리해도 스키마가 남는다.
  const rebuilt = buildIndex(temporary);
  assert(rebuilt.documents.length > 0);
  for (const document of rebuilt.documents) assert(document.uid, `문서에 식별자가 없습니다: ${document.id}`);
  assert.strictEqual(Object.keys(rebuilt.documentUidByDisplayId).length, rebuilt.documents.length);

  // 인덱스는 실제 조회 명령에서 쓸 수 있어야 한다. 만들어 놓고 부를 방법이 없으면
  // 아무것도 가속하지 않는 죽은 코드다. 다만 기본값은 아니다 — 측정 결과 이 규모에서는
  // 유효성 확인이 읽기보다 비싸다.
  buildIndex(temporary);
  assert.strictEqual(rdl(['task', 'list', '--project', 'crm']).source, 'cold', '기본 경로는 정본이어야 합니다.');
  const viaCli = rdl(['task', 'list', '--project', 'crm', '--index']);
  assert.strictEqual(viaCli.source, 'index', '--index는 유효한 인덱스를 써야 합니다.');
  const viaColdCli = rdl(['task', 'list', '--project', 'crm', '--cold']);
  assert.strictEqual(viaColdCli.source, 'cold');
  assert.deepStrictEqual(viaCli.tasks, viaColdCli.tasks, 'CLI의 두 경로가 같은 답을 내야 합니다.');
  const contextCli = rdl(['context', '--project', 'crm']);
  assert.strictEqual(contextCli.tasks.counts.todo, viaColdCli.counts.todo, 'context도 같은 집계를 써야 합니다.');
  // 두 경로가 다른 답을 낸 경우를 사후에 지목하려면 결과가 출처를 들고 있어야 한다.
  assert.strictEqual(contextCli.tasks.source, 'cold', 'context가 어느 경로로 답했는지 남겨야 합니다.');
  const contextIndexed = rdl(['context', '--project', 'crm', '--index']);
  assert.strictEqual(contextIndexed.tasks.source, 'index');
  assert.strictEqual(contextIndexed.tasks.counts.todo, viaColdCli.counts.todo, 'context의 두 경로가 같은 집계를 내야 합니다.');

  // CLI 표면.
  const status = rdl(['index', 'status']);
  assert.strictEqual(status.status, 'valid');
  assert.strictEqual(status.tasks, 3);
  const removed = rdl(['index', 'clear']);
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(rdl(['index', 'status']).status, 'missing');
  assert.strictEqual(rdl(['task', 'list', '--project', 'crm', '--index']).tasks.length, 3, '인덱스 없이도 조회는 답해야 합니다.');
  assert.strictEqual(rdl(['index', 'rebuild']).tasks, 3);

  // 등가성은 목록만이 아니라 응답 전체여야 한다. 프로젝트가 하나뿐인 Workspace에서
  // 목록만 비교하면 집계가 갈리는 것을 볼 수 없다 — 실제로 인덱스는 프로젝트
  // 필터를 무시하고 Workspace 전체 집계를 돌려주고 있었고, 그래서 같은 응답 안의
  // 목록과 집계가 서로 다른 질문에 답했다.
  rdl(['project', 'add', 'ops', '--name', 'Ops', '--profile', 'lean']);
  rdl(['task', 'add', '운영 일감', '--project', 'ops', '--acceptance', '완료조건']);
  rdl(['task', 'add', '운영 둘째', '--project', 'ops', '--acceptance', '완료조건', '--priority', 'high']);
  rdl(['index', 'rebuild']);
  for (const filter of [{}, { project: 'crm' }, { project: 'ops' }, { project: 'crm', status: 'todo' }, { project: 'ops', open: true }]) {
    const viaIndex = queryTasks(temporary, Object.assign({ index: true }, filter));
    const viaCold = queryTasks(temporary, Object.assign({ cold: true }, filter));
    const label = JSON.stringify(filter);
    assert.strictEqual(viaIndex.source, 'index', `인덱스 경로여야 합니다: ${label}`);
    assert.deepStrictEqual(viaIndex.tasks, viaCold.tasks, `목록이 갈립니다: ${label}`);
    assert.deepStrictEqual(viaIndex.counts, viaCold.counts, `집계가 갈립니다: ${label}`);
    assert.strictEqual(viaIndex.total, viaCold.total, `총계가 갈립니다: ${label}`);
    assert.deepStrictEqual(viaIndex.projects, viaCold.projects, `프로젝트 목록이 갈립니다: ${label}`);
  }

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
