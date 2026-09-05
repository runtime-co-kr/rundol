'use strict';

const assert = require('assert');
const fs = require('fs');
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
    // 헤더 라벨과 목록 제목은 같은 것을 가리키므로 이름도 같아야 한다.
    assert(page.body.includes('조치 필요'));
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

    // ── 검토 인박스 ────────────────────────────────────────────────────────
    //
    // 승인 상태는 원장의 사실이고 frontmatter의 state는 쓴 사람의 주장이다. 화면에 앞엣것이
    // 안 가면 문서를 열어도 승인 여부를 알 수 없고, "지금 뭐가 승인된 상태냐"를 매번
    // 명령으로 물어야 한다 — 그 물음이 검토를 미루게 만드는 자리다.
    assert(snapshotValue.documents.every((document) => Object.prototype.hasOwnProperty.call(document, 'approval')),
      '스냅숏의 문서마다 승인 상태 자리가 있다.');
    // 이 픽스처는 schemaVersion 3이라 승인 원장이 없다. 없는 것을 오류로 만들면 판올림 전
    // 저장소에서 보드가 통째로 서지 않으므로, 그때는 상태를 비워 보내고 화면이 "모른다"를
    // 그린다 — 모르는 것과 미승인은 다르고, 뒤엣것으로 답하면 화면이 없는 사실을 말한다.
    assert.strictEqual(snapshotValue.reviewQueue.total, 0, '승인 원장이 없는 저장소에서는 인박스가 비어 온다.');
    assert(snapshotValue.documents.every((document) => document.approval === null), '그 저장소의 문서는 승인 상태를 모른다고 답한다.');
    // 못 읽은 이유는 들고 나온다. 삼키면 원장이 깨진 저장소와 원장을 안 쓰는 저장소가
    // 화면에서 같아 보이고, 앞엣것은 고쳐야 할 사고인데 아무도 그것을 모른다.
    assert.strictEqual(typeof snapshotValue.reviewQueue.unknown, 'string', '모르는 이유가 값으로 실린다.');
    assert.strictEqual(snapshotValue.reviewQueue.used, false);
    // 미승인은 문제가 아니라 줄이다. attention에 섞으면 승인 축을 안 쓰는 프로젝트에서
    // 문서 전건이 문제 목록으로 쏟아져 진짜 문제를 덮는다.
    assert.strictEqual(snapshotValue.attention.filter((item) => item.reason === '검토 대기').length, 0,
      '검토 대기는 attention이 아니라 인박스가 든다.');
    // 인박스 행의 유형 칩은 kind를 본다(화면의 documentTypeLabel이 kind || type을 쓴다).
    // type은 'document'라는 저장 종류라 문서 130건이 모두 같은 값이고, kind를 안 실으면
    // 인박스의 유형 칩이 전부 'document'로 떨어져 무엇이 밀렸는지가 유형별로 읽히지 않는다 —
    // 문서 목록은 문서를 통째로 받아 kind를 갖고 있으므로 두 화면이 같은 문서에 다른 유형을
    // 적게 된다. 이 픽스처에는 승인 원장이 없어 줄이 비어 오므로, 싣는 자리를 원본에서 못박는다.
    const boardSource = fs.readFileSync(path.join(root, 'src', 'board.js'), 'utf8');
    const queueSource = boardSource.slice(boardSource.indexOf('function reviewQueue'), boardSource.indexOf('function attentionItems'));
    assert(/items\.push\(\{[^}]*kind: document\.kind/u.test(queueSource), '인박스 줄은 문서의 kind를 함께 실어야 한다.');

    // ── 스냅숏이 싣는 워크플로 ──────────────────────────────────────────────
    //
    // 이 픽스처에는 workflows.json이 없다. 설정을 안 쓴 저장소에서 답이 판올림 전과
    // 같아야 한다는 것이 설정 층이 건 계약이고, 화면이 받는 값도 그 계약 안에 있다.
    //
    // 다만 "같다"가 "모른다"여서는 안 된다. 예전에는 내장을 보고 있다는 사실이 값에
    // 없었고, 그래서 workflows.json을 고쳐도 화면이 그대로인 것과 설정이 없어서
    // 그대로인 것이 구분되지 않았다.
    assert.strictEqual(snapshotValue.workflow.id, null, '배정이 없으면 흐름 이름이 없다.');
    assert.strictEqual(snapshotValue.workflow.origin, 'builtin', '내장으로 떨어졌다는 사실이 값에 있어야 한다.');
    assert.strictEqual(snapshotValue.workflow.error, null, '설정이 없는 것은 오류가 아니다.');
    assert.strictEqual(snapshotValue.workflow.transitions, null, '전환을 선언하지 않은 흐름은 전환을 막지 않는다.');
    assert.deepStrictEqual(snapshotValue.workflow.bindings, {}, '배정 표는 파일이 없어도 서 있어야 한다.');
    assert.deepStrictEqual(snapshotValue.workflow.sources, { workflows: {}, bindings: {} }, '출처 그룹도 파일이 없어도 서 있어야 한다.');
    // 노드는 step만으로 부족하다. label과 requires가 함께 와야 화면이 상태 이름을
    // 비교하지 않고도 대기 다이얼로그를 열 수 있다.
    assert.deepStrictEqual(Object.keys(snapshotValue.workflow.nodes).sort(), ['cancelled', 'doing', 'done', 'review', 'todo', 'waiting']);
    assert.strictEqual(snapshotValue.workflow.nodes.waiting.label, null, '내장 노드에는 라벨이 없다 — 라벨은 설정이 심는다.');
    assert.deepStrictEqual(snapshotValue.workflow.nodes.waiting.requires, ['blocker']);
    assert.deepStrictEqual(snapshotValue.workflow.nodes.cancelled.requires, ['cancellation']);

    // ── 전환 판정 엔드포인트 ────────────────────────────────────────────────
    //
    // 없으면 화면이 자체 판정을 만들고, 그 순간 JUDGMENT_SURFACES 넷 밖에 다섯 번째
    // 표면이 생긴다. 그래서 이 시험이 확인하는 것은 "답이 온다"가 아니라 "저장이
    // 막는 것과 같은 것을 막는다"이다.
    const judgedTask = result.tasks[0];
    const judged = await request(port, `/api/projects/tms/tasks/${judgedTask.id}/transitions`);
    assert.strictEqual(judged.status, 200);
    const judgment = JSON.parse(judged.body);
    assert.strictEqual(judgment.task, judgedTask.id);
    assert.strictEqual(judgment.from, judgedTask.status);
    assert.strictEqual(judgment.workflow.origin, 'builtin');
    // 자기 자신을 뺀 나머지 노드가 전부 후보다. 선언이 없는 흐름에서 못 가는 자리를
    // 미리 지우면 화면은 "왜 이 단추가 없는가"에 답할 수 없다.
    assert.deepStrictEqual(judgment.transitions.map((item) => item.to).sort(), ['cancelled', 'done', 'review', 'todo', 'waiting']);
    assert(judgment.transitions.every((item) => item.declared === true), '전환 목록이 없는 흐름은 전부 열려 있다.');
    const toWaiting = judgment.transitions.find((item) => item.to === 'waiting');
    assert.strictEqual(toWaiting.allowed, false, '대기 사유 없이 대기로 가는 것은 저장이 막는다.');
    assert(toWaiting.blockers.some((blocker) => blocker.ruleId === 'waiting-requires-blocker'), '막는 규칙을 이유와 함께 돌려줘야 한다.');
    const toTodo = judgment.transitions.find((item) => item.to === 'todo');
    assert.strictEqual(toTodo.allowed, true);
    assert.deepStrictEqual(toTodo.blockers, []);

    // 하나만 묻는 것도 같은 자리가 답한다. 화면이 단추 하나를 두고 묻는 물음이다.
    const single = await request(port, `/api/projects/tms/tasks/${judgedTask.id}/transitions?to=waiting`);
    assert.strictEqual(single.status, 200);
    assert.strictEqual(JSON.parse(single.body).transitions.length, 1);
    assert.strictEqual(JSON.parse(single.body).transitions[0].to, 'waiting');

    // 없는 노드는 거절한다. 판정은 모르는 노드에 빈 목록으로 답하고 빈 목록은 "막는
    // 것이 없다"는 뜻이라, 그대로 내보내면 갈 수 없는 자리가 갈 수 있는 자리로 읽힌다.
    const unknownNode = await request(port, `/api/projects/tms/tasks/${judgedTask.id}/transitions?to=${encodeURIComponent('없는노드')}`);
    assert.strictEqual(unknownNode.status, 400);
    assert.strictEqual(JSON.parse(unknownNode.body).code, 'unknown-node');
    const unknownTask = await request(port, '/api/projects/tms/tasks/TASK-00000000/transitions');
    assert.strictEqual(unknownTask.status, 404);

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

    // ── 프로젝트 자산 경로 ────────────────────────────────────────────────
    //
    // 디스크에서 파일을 읽어 내보내는 경로다. 열어 준 범위가 곧 공격면이므로,
    // "그림이 보인다"만이 아니라 "그 밖은 안 보인다"를 함께 시험한다.
    //
    // 대상 파일은 이 시험이 만든다. 픽스처에 두면 안 되는 이유는 그 디렉터리가
    // .gitignore의 /projects/에 걸려 커밋되지 않기 때문이다 — 로컬에는 있고 CI에는
    // 없어서, 게이트가 초록인 채로 배포가 CI에서 깨진다. 실제로 그렇게 깨졌다.
    const assetDirectory = path.join(root, 'test', 'fixtures', 'workspace', 'projects', 'tms', 'docs');
    const imagePath = path.join(assetDirectory, 'sample.png');
    const textPath = path.join(assetDirectory, 'secret.txt');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(textPath, 'not an image\n', 'utf8');
    try {
      const image = await request(port, '/api/projects/tms/assets/docs/sample.png');
      assert.strictEqual(image.status, 200, `그림을 서빙하지 못했습니다: ${image.status}`);
      assert.strictEqual(image.headers['content-type'], 'image/png');
      assert.strictEqual(image.headers['x-content-type-options'], 'nosniff');

      // 그림이 아닌 파일은 확장자에서 막힌다. 이 경로로 문서·설정을 읽어 낼 수 없다.
      const text = await request(port, '/api/projects/tms/assets/docs/secret.txt');
      assert.strictEqual(text.status, 415, `그림이 아닌 파일이 서빙됐습니다: ${text.status}`);
    } finally {
      fs.rmSync(imagePath, { force: true });
      fs.rmSync(textPath, { force: true });
    }

    // 프로젝트 밖으로 올라가는 경로는 인코딩 여부와 무관하게 막힌다.
    for (const escape of ['../../../package.json', '..%2f..%2f..%2fpackage.json', '%2e%2e/%2e%2e/package.json']) {
      const outside = await request(port, `/api/projects/tms/assets/${escape}`);
      assert(outside.status >= 400, `프로젝트 밖 경로가 열렸습니다(${escape}): ${outside.status}`);
    }

    // 없는 파일은 404이고, 그것이 경로 존재 여부를 알려 주는 유일한 신호다.
    const missing = await request(port, '/api/projects/tms/assets/docs/none.png');
    assert.strictEqual(missing.status, 404);

    // 심링크로 밖을 가리키는 경우. 위의 문자열 검사(..)로는 잡히지 않으므로, 링크를
    // 따라간 뒤 다시 확인하는 가드만이 이것을 막는다. 그 가드를 껐을 때 이 시험이
    // 무너져야 가드가 실제로 일을 하고 있는 것이다.
    const linkPath = path.join(root, 'test', 'fixtures', 'workspace', 'projects', 'tms', 'docs', 'outside.png');
    let linked = false;
    let linkError = null;
    try {
      fs.rmSync(linkPath, { force: true });
      fs.symlinkSync(path.join(root, 'package.json'), linkPath, 'file');
      linked = true;
    } catch (error) { linkError = error; }
    assert(linked, `심링크를 만들지 못하면 이 시험은 경계에 대해 아무것도 말하지 못합니다: ${linkError && (linkError.code || linkError.message)}`);
    try {
      const escaped = await request(port, '/api/projects/tms/assets/docs/outside.png');
      assert.strictEqual(escaped.status, 403, `프로젝트 밖을 가리키는 심링크가 서빙됐습니다: ${escaped.status}`);
    } finally {
      fs.rmSync(linkPath, { force: true });
    }
  } finally {
    await new Promise((resolve) => board.server.close(resolve));
  }
  process.stdout.write('board tests passed\n');
}

module.exports = testBoard();
