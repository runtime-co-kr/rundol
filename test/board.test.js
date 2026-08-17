'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { createBoardServer } = require('../src/board');

const root = path.resolve(__dirname, '..');

function request(port, pathname, options) {
  const settings = Object.assign({ method: 'GET', headers: {} }, options || {});
  return new Promise((resolve, reject) => {
    // agent: false로 연결 재사용을 끈다. Node의 globalAgent는 keep-alive가 기본이라
    // 소켓이 풀에 남는데, 서버의 유휴 연결 타임아웃(5초)이 먼저 지나면 서버가 그
    // 소켓을 닫는다. 전체 스위트를 동시에 돌려 부하가 걸리면 요청 사이 간격이 그
    // 시간을 넘고, 클라이언트가 죽은 소켓을 재사용하면서 ECONNRESET으로 터진다.
    // 단독 실행에서는 재현되지 않아 게이트만 간헐적으로 무너뜨린다.
    const call = http.request({ hostname: '127.0.0.1', port, path: pathname, method: settings.method, headers: settings.headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // 어느 요청이 터졌는지 이름을 붙인다. 익명 ECONNRESET은 어디를 고쳐야
    // 하는지 알려주지 않아 추측만 늘린다.
    call.on('error', (error) => reject(new Error(`${settings.method} ${pathname} 실패: ${error.code || error.message}`)));
    if (settings.body) call.write(settings.body);
    call.end();
  });
}

async function testBoard() {
  const board = createBoardServer(path.join(root, 'test', 'fixtures', 'workspace'), { token: 'test-session-token' });
  await new Promise((resolve, reject) => {
    board.server.once('error', reject);
    board.server.listen(0, '127.0.0.1', resolve);
  });
  const port = board.server.address().port;
  try {
    const page = await request(port, '/');
    assert.strictEqual(page.status, 200);
    assert(page.body.includes('Rundol Workspace'));
    assert(page.body.includes('새 태스크'));
    assert(page.body.includes('프로젝트 문서'));
    assert(page.body.includes('Needs Attention'));
    // 운영 상태 화면은 없앴다. 동기화와 조치 필요는 헤더가, 그 목록은 홈이 갖는다.
    assert(page.body.includes('동기화 상태'));
    assert(page.body.includes('설정'));
    assert(page.body.includes('test-session-token'));
    assert(page.headers['content-security-policy'].includes("default-src 'self'"));

    const mermaid = await request(port, '/mermaid.js');
    assert.strictEqual(mermaid.status, 200);
    assert(mermaid.body.includes('mermaid'));
    const marked = await request(port, '/marked.js');
    assert.strictEqual(marked.status, 200);
    const purifier = await request(port, '/dompurify.js');
    assert.strictEqual(purifier.status, 200);
    const theme = await request(port, '/theme.css');
    assert.strictEqual(theme.status, 200);

    const tasks = await request(port, '/api/tasks?status=doing&limit=2');
    assert.strictEqual(tasks.status, 200);
    const result = JSON.parse(tasks.body);
    assert(result.total >= 1);
    assert(result.tasks.length <= 2);
    assert(result.tasks.every((task) => task.status === 'doing'));
    // todo, doing, waiting, review, done, cancelled — 완료와 반려는 별개의 종료 상태다
    assert.deepStrictEqual(result.statuses, ['todo', 'doing', 'waiting', 'review', 'done', 'cancelled']);

    // 스냅샷은 화면이 클라이언트에서 걸러 쓰는 작업 집합 전체다. 페이지 나눔이 끼면
    // 101번째부터가 목록·내 작업·조치 필요·선행 판정에서 아무 표시 없이 사라진다.
    const { workspaceSnapshot } = require('../src/board');
    const fixture = path.join(root, 'test', 'fixtures', 'workspace');
    const whole = workspaceSnapshot(fixture, 'tms', new URLSearchParams());
    assert.strictEqual(whole.tasks.tasks.length, whole.tasks.total, '스냅샷은 태스크를 잘라내지 않는다');
    assert.strictEqual(whole.tasks.offset, 0);
    const capped = workspaceSnapshot(fixture, 'tms', new URLSearchParams('limit=1&offset=5'));
    assert.strictEqual(capped.tasks.tasks.length, capped.tasks.total, '스냅샷은 limit·offset 질의에도 잘리지 않는다');

    const projects = await request(port, '/api/projects');
    assert.strictEqual(projects.status, 200);
    assert(JSON.parse(projects.body).some((project) => project.key === 'tms'));

    const snapshot = await request(port, '/api/projects/tms/board-snapshot');
    assert.strictEqual(snapshot.status, 200);
    const snapshotValue = JSON.parse(snapshot.body);
    assert.strictEqual(snapshotValue.project, 'tms');
    assert(Array.isArray(snapshotValue.documents));
    assert(Array.isArray(snapshotValue.attention));
    assert.strictEqual(typeof snapshotValue.revision.documents, 'string');
    assert.strictEqual(typeof snapshotValue.revision.tasks, 'string');
    assert(snapshotValue.documents.some((document) => typeof document.body === 'string'));

    const documents = await request(port, '/api/projects/tms/documents');
    assert.strictEqual(documents.status, 200);
    assert(JSON.parse(documents.body).documents.some((document) => document.id === 'project:tms'));

    const revision = await request(port, '/api/revision');
    assert.strictEqual(revision.status, 200);
    assert(/^[a-f0-9]{40}$/.test(JSON.parse(revision.body).revision));

    const collaboration = await request(port, '/api/collaboration');
    assert.strictEqual(collaboration.status, 200);
    const directory = JSON.parse(collaboration.body);
    assert(directory.members.length >= 1);
    assert(directory.roles.length >= 1);
    assert(directory.stakeholders.length >= 1);

    const invalidTask = await request(port, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': 'test-session-token' },
      body: '{}'
    });
    assert.strictEqual(invalidTask.status, 400);

    const unregisteredAssignee = await request(port, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': 'test-session-token' },
      body: JSON.stringify({ title: '잘못된 할당', owner: 'MEMBER-999', acceptanceCriteria: { 'AC-001': { text: '검증한다.', done: false } } })
    });
    assert.strictEqual(unregisteredAssignee.status, 400);
    assert(JSON.parse(unregisteredAssignee.body).error.includes('등록되지 않은 담당자'));

    const taskHeaders = { 'Content-Type': 'application/json', 'X-Rundol-Token': 'test-session-token' };
    const acceptanceCriteria = { 'AC-001': { text: '검증한다.', done: false } };
    const waitingWithoutBlocker = await request(port, '/api/tasks', {
      method: 'POST',
      headers: taskHeaders,
      body: JSON.stringify({ title: '대기 전환', status: 'waiting', acceptanceCriteria })
    });
    assert.strictEqual(waitingWithoutBlocker.status, 400);
    assert(JSON.parse(waitingWithoutBlocker.body).error.includes('대기 상태로 바꾸려면'));

    const incompleteBlocker = await request(port, '/api/tasks', {
      method: 'POST',
      headers: taskHeaders,
      body: JSON.stringify({ title: '대기 전환', status: 'waiting', blocker: { waitingFor: 'MEMBER-001' }, acceptanceCriteria })
    });
    assert.strictEqual(incompleteBlocker.status, 400);
    assert(JSON.parse(incompleteBlocker.body).error.includes('대기 사유에는'));

    const unregisteredWaitingFor = await request(port, '/api/tasks', {
      method: 'POST',
      headers: taskHeaders,
      body: JSON.stringify({ title: '대기 전환', status: 'waiting', blocker: { waitingFor: 'MEMBER-999', condition: '승인', since: '2026-08-14T00:00:00.000Z' }, acceptanceCriteria })
    });
    assert.strictEqual(unregisteredWaitingFor.status, 400);
    assert(JSON.parse(unregisteredWaitingFor.body).error.includes('등록되지 않은 대기 대상'));

    const blockerWithoutWaiting = await request(port, '/api/tasks', {
      method: 'POST',
      headers: taskHeaders,
      body: JSON.stringify({ title: '대기 아님', status: 'todo', blocker: { waitingFor: 'MEMBER-001', condition: '승인', since: '2026-08-14T00:00:00.000Z' }, acceptanceCriteria })
    });
    assert.strictEqual(blockerWithoutWaiting.status, 400);
    assert(JSON.parse(blockerWithoutWaiting.body).error.includes('대기 상태가 아닌'));

    const rejected = await request(port, '/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': 'wrong' }, body: '{}' });
    assert.strictEqual(rejected.status, 403);
  } finally {
    await new Promise((resolve) => board.server.close(resolve));
  }
  process.stdout.write('board tests passed\n');
}

module.exports = testBoard();
