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

    // ── 검토 줄의 순서와 길이 ──────────────────────────────────────────────
    //
    // 이 픽스처에는 승인 원장이 없어 서버를 통해서는 빈 줄만 나온다. 그래서 줄의 판정을
    // 직접 묻는다 — 아니면 정렬도, 대기 시각도, 뒤쪽 유형에 닿는지도 어느 시험도 확인하지
    // 못하고, 그 셋이 정확히 화면에서 깨져 있던 것들이다.
    const { reviewQueue } = require('../src/board');
    // 승인 상태 표는 approval.trustState가 내는 모양이다. 여기서 새로 짓는 것은 없고,
    // 줄이 그 값을 어떻게 세우는지만 본다.
    const trust = (status, submission) => ({
      status,
      approvedRevision: status === 'stale' ? 'b'.repeat(64) : null,
      approvedBy: status === 'stale' ? 'MEMBER-001' : null,
      approvals: status === 'stale' ? 1 : 0,
      submission: Object.assign({ state: 'none', revision: null, recordedAt: null, rejection: null, rejections: 0, submissions: 0 }, submission || {})
    });
    function queueOf(entries) {
      const states = {};
      const documents = entries.map((entry) => {
        states[entry.id] = entry.trust;
        const value = { id: entry.id, kind: 'adr', type: 'document', title: entry.id, file: `docs/${entry.id}.md` };
        // modifiedAt을 아예 안 주는 갈래가 있어야 한다. 값이 없는 문서가 어디에 서는지가
        // 이 줄이 답해야 하는 물음 하나다.
        if (entry.modifiedAt !== undefined) value.modifiedAt = entry.modifiedAt;
        return value;
      });
      return reviewQueue(documents, { states, reason: null });
    }

    // 1) 줄이 길어져도 뒤쪽 유형에 닿을 수 있다. 예전에는 앞 50건에서 잘랐는데 절단면이
    //    정렬 축과 겹쳐, 미승인이 50건을 넘으면 식별자가 뒤인 유형이 한 건도 실리지
    //    않았다 — 이 저장소에서 검증(TST) 47건이 통째로 그랬다. 화면의 거르개는 실린
    //    것을 거르므로 "미승인만"을 눌러도 그 뒤는 나타나지 않았다.
    //
    //    뒤 유형에 가장 늦은 대기 시각을 준다. 정렬로도 맨 뒤에 서는 줄이 실제로 실리는지를
    //    봐야 "자르지 않는다"가 확인되기 때문이다.
    {
      const entries = [];
      for (let index = 0; index < 60; index += 1) {
        entries.push({ id: `ADR-${String(index).padStart(3, '0')}`, trust: trust('unapproved'), modifiedAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z` });
      }
      for (let index = 0; index < 47; index += 1) {
        entries.push({ id: `TST-${String(index).padStart(3, '0')}`, trust: trust('unapproved'), modifiedAt: '2026-09-01T00:00:00.000Z' });
      }
      const queue = queueOf(entries);
      assert.strictEqual(queue.items.length, queue.total, '줄은 통째로 실린다 — 셈과 목록이 같은 수여야 한다.');
      assert.strictEqual(queue.items.length, 107, '107건이 모두 실린다.');
      assert.strictEqual(queue.items.filter((item) => item.id.startsWith('TST')).length, 47,
        '가장 늦게 온 유형도 한 건도 빠지지 않는다.');
    }

    // 2) 대기 시각을 못 구한 문서가 오래 기다린 것으로 보이면 안 된다. 없는 값을 0으로
    //    읽으면 모르는 문서가 줄의 맨 앞에서 가장 급한 것 행세를 한다 — 없는 것과 오래된
    //    것은 다르다.
    {
      const queue = queueOf([
        { id: 'ADR-001', trust: trust('unapproved') },
        { id: 'ADR-002', trust: trust('unapproved'), modifiedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'ADR-003', trust: trust('unapproved'), modifiedAt: '2026-09-01T00:00:00.000Z' }
      ]);
      assert.deepStrictEqual(queue.items.map((item) => item.id), ['ADR-002', 'ADR-003', 'ADR-001'],
        '오래 기다린 것이 먼저이고, 못 구한 것은 맨 뒤다.');
      assert.strictEqual(queue.items[2].waitingSince, null, '없는 값을 지어내지 않는다.');
    }

    // 3) 낡음 먼저는 대기 시간이 뒤집지 않는다. 낡음은 승인된 것이 흔들린 상태라 이미
    //    하류가 근거로 삼았고, 미승인은 아직 아무도 근거로 삼지 않았다 — 반년 묵은 초안이
    //    어제 흔들린 승인본을 앞지르면 그 뜻이 사라진다.
    {
      const queue = queueOf([
        { id: 'ADR-001', trust: trust('unapproved'), modifiedAt: '2020-01-01T00:00:00.000Z' },
        { id: 'ADR-002', trust: trust('stale'), modifiedAt: '2026-09-01T00:00:00.000Z' }
      ]);
      assert.deepStrictEqual(queue.items.map((item) => item.status), ['stale', 'unapproved'],
        '대기 시간은 낡음 먼저라는 축을 뒤집지 않고 그 안에서만 적용된다.');
    }

    // 4) 제출 축이 서 있으면 제출 시각이 더 정확한 "차례가 넘어온 시각"이다. 다만 지금
    //    파일이 제출한 판과 다르면(drifted) 그 시각은 이미 지나간 판의 것이라 쓰지 않는다 —
    //    승인자가 볼 것은 언제나 지금 파일이다.
    {
      const queue = queueOf([
        { id: 'ADR-001', trust: trust('unapproved', { state: 'pending', recordedAt: '2026-02-01T00:00:00.000Z' }), modifiedAt: '2026-08-01T00:00:00.000Z' },
        { id: 'ADR-002', trust: trust('unapproved', { state: 'drifted', recordedAt: '2026-01-01T00:00:00.000Z' }), modifiedAt: '2026-08-02T00:00:00.000Z' }
      ]);
      assert.strictEqual(queue.items[0].waitingSince, '2026-02-01T00:00:00.000Z', '올린 판이 지금 판이면 제출 시각부터 센다.');
      assert.strictEqual(queue.items[1].waitingSince, '2026-08-02T00:00:00.000Z', '지금 파일이 올린 판과 다르면 지금 판이 생긴 시각부터 센다.');
    }

    // 5) 줄은 문서의 kind를 함께 실는다. 화면의 유형 칩이 kind를 먼저 보기 때문이고
    //    (documentTypeLabel은 kind || type이다), type은 'document'라는 저장 종류라 문서
    //    전건이 같은 값이다 — 안 실으면 인박스의 칩이 전부 'document'로 떨어져 무엇이
    //    밀렸는지가 유형별로 읽히지 않고, 문서 목록과 인박스가 같은 문서에 다른 유형을 적는다.
    {
      const queue = queueOf([{ id: 'ADR-001', trust: trust('unapproved'), modifiedAt: '2026-01-01T00:00:00.000Z' }]);
      assert.strictEqual(queue.items[0].kind, 'adr', '인박스 줄은 문서의 kind를 함께 실는다.');
    }

    // 6) 반려된 문서는 줄에서 빠지되, 사라지지는 않는다. 빠지는 이유는 차례가
    //    작성자에게 넘어갔기 때문이고, 남기는 이유는 그 작성자에게는 그것이 할 일이기
    //    때문이다 — 수만 세고 버리면 「내가 고칠 것」이 설 자리가 없어진다. 셀은 그 줄에서
    //    파생해야 한다 — 따로 세면 언젠가 둘이 갈리고, 갈렸다는 사실은 아무 신호도 내지 않는다.
    {
      const queue = queueOf([
        { id: 'ADR-001', trust: trust('unapproved'), modifiedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'ADR-002', trust: trust('unapproved', { state: 'rejected', rejection: { rejectedBy: 'MEMBER-002', reason: '근거 부족', recordedAt: '2026-03-01T00:00:00.000Z' } }), modifiedAt: '2026-02-01T00:00:00.000Z' }
      ]);
      assert.deepStrictEqual(queue.items.map((item) => item.id), ['ADR-001'], '반려된 문서는 검토 줄에 서지 않는다.');
      assert.deepStrictEqual(queue.rejectedItems.map((item) => item.id), ['ADR-002'], '반려된 문서도 줄로는 남는다.');
      assert.strictEqual(queue.rejected, queue.rejectedItems.length, '반려 셀은 그 줄에서 파생한다.');
      assert.strictEqual(queue.rejectedItems[0].submission.rejectedBy, 'MEMBER-002', '누가 반려했는지가 줄에 실린다.');
      assert.strictEqual(queue.rejectedItems[0].submission.rejectedReason, '근거 부족', '왜 아닌지가 줄에 실린다.');
    }

    // ── 문서의 「내 차례」 ──────────────────────────────────
    //
    // 같은 줄을 사람 축으로 좁힌 값이다. 갈래를 가르는 규칙이 화면에 있으면 자격
    // 판정의 표면이 하나 더 생기고 그 표면은 아무도 시험하지 않으므로, 규칙은 여기 있고
    // 여기서 재다.
    const { documentTurns } = require('../src/board');
    const approverOf = (member) => [{ id: 'client-1', name: '개발용', owner: member }];
    function turnsOf(entries, approvers) {
      const states = {};
      const documents = entries.map((entry) => {
        states[entry.id] = entry.trust;
        return { id: entry.id, kind: 'adr', type: 'document', title: entry.id, file: `docs/${entry.id}.md`, ownerMember: entry.owner || null, modifiedAt: entry.modifiedAt || '2026-01-01T00:00:00.000Z' };
      });
      return documentTurns(reviewQueue(documents, { states, reason: null }), approvers);
    }

    // 7) 갈래 셋이 서로 다른 사실을 세고, 한 문서는 한 사람에게 한 갈래에만 선다.
    //    두 갈래에 세우면 셀이 실제 일의 양보다 크게 나오고 같은 문서를 두 번 지나친다.
    {
      const turns = turnsOf([
        // 내게 올라와 답을 기다리는 것
        { id: 'ADR-001', owner: 'MEMBER-002', trust: trust('unapproved', { state: 'pending', recordedAt: '2026-02-01T00:00:00.000Z' }) },
        // 내가 승인한 뒤 바뀐 것 — 소유자도 나라 「내가 고칠 것」에도 걸리지만,
        // 낡음에서 다음에 눌러야 할 단추는 재승인이므로 앞엎것이 가져간다.
        { id: 'ADR-002', owner: 'MEMBER-001', trust: trust('stale') },
        // 내 문서인데 반려됐다
        { id: 'ADR-003', owner: 'MEMBER-001', trust: trust('unapproved', { state: 'rejected', rejection: { rejectedBy: 'MEMBER-002', reason: '근거 부족', recordedAt: '2026-03-01T00:00:00.000Z' } }) },
        // 아무에게도 넘어가지 않은 미승인 — 어느 갈래에도 서지 않는다
        { id: 'ADR-004', owner: 'MEMBER-002', trust: trust('unapproved') }
      ], approverOf('MEMBER-001'));
      const laneOf = (id) => (turns.rows.find((row) => row.id === id) || { lanes: {} }).lanes['MEMBER-001'] || null;
      assert.deepStrictEqual(turns.approverMembers, ['MEMBER-001'], '승인 자격은 이미 조립된 목록에서 온다.');
      assert.strictEqual(laneOf('ADR-001'), 'awaiting', '올라온 판은 승인자의 차례다.');
      assert.strictEqual(laneOf('ADR-002'), 'restake', '내 승인이 낡은 것은 재승인 갈래가 가져간다.');
      assert.strictEqual(laneOf('ADR-003'), 'fix', '반려된 내 문서는 내가 고칠 것이다.');
      assert.strictEqual(laneOf('ADR-004'), null, '아무에게도 넘어가지 않은 미승인은 누구의 차례도 아니다.');
      const mine = turns.rows.filter((row) => row.lanes['MEMBER-001']);
      assert.strictEqual(mine.length, 3, '한 문서는 한 갈래에만 서므로 줄이 중복되지 않는다.');
      // 미승인 157건이 따라들어오면 「내 차례」가 다시 프로젝트 전체가 된다.
      assert.strictEqual(turns.rows.length, 3, '아무의 갈래에도 안 서는 줄은 싣지 않는다.');
    }

    // 8) 승인자가 아닌 사람에게는 「나를 기다리는 것」이 서지 않는다. 0건과 "자격이
    //    없다"는 다른 사실이므로 화면이 그 둘을 가를 근거가 값으로 있어야 한다.
    {
      const turns = turnsOf([
        { id: 'ADR-001', owner: 'MEMBER-002', trust: trust('unapproved', { state: 'pending', recordedAt: '2026-02-01T00:00:00.000Z' }) }
      ], approverOf('MEMBER-001'));
      assert.strictEqual((turns.rows[0].lanes || {})['MEMBER-002'], undefined, '올린 사람은 자기가 기다리는 중이지 차례가 아니다.');
      assert(!turns.approverMembers.includes('MEMBER-002'), '자격자 목록이 그 판정의 근거다.');
      // 갈래 목록은 서버가 준다. 화면은 require를 쓸 수 없어 적어 둔 목록은 갈래가
      // 늘 때 한쪽만 늘고, 그때 화면은 없는 갈래를 모르는 채 돌아간다.
      assert.deepStrictEqual(turns.lanes.map((lane) => lane.key), ['awaiting', 'restake', 'fix'],
        '갈래의 목록과 순서를 서버가 싣는다.');
      assert.strictEqual(turns.lanes[0].requiresApprover, true, '어느 갈래가 자격을 요구하는지도 서버가 말한다.');
    }

    // 9) 원장을 못 읽은 저장소에서는 「내 차례」도 줄을 세우지 않고 이유를 그대로 든다.
    //    여기서 0건으로 답하면 모르는 것이 "내 차례가 없다"로 읽힌다.
    {
      const turns = documentTurns(reviewQueue([], { states: null, reason: '이 작업공간은 승인 원장을 갖기 전 판입니다.' }), approverOf('MEMBER-001'));
      assert.strictEqual(turns.used, false);
      assert.strictEqual(typeof turns.unknown, 'string', '모르는 이유가 값으로 실린다.');
      assert.deepStrictEqual(turns.rows, []);
    }

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

    // ── 통합 검색 자리 ──────────────────────────────────────────────────────
    //
    // 검색은 스냅숏 밖이다. 질의마다 다른 값이라 폴링에 실을 수 없고, 실으면 폴링 한
    // 번이 검색 한 번이 되어 아무도 검색하지 않는 동안에도 문서 전건을 훑는다 —
    // 문서 차분·이력이 요청 시 계산인 것과 같은 규칙이다.
    assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshotValue, 'search'), false,
      '검색 결과가 스냅숏에 실리면 안 된다.');

    const searched = await request(port, `/api/projects/tms/search?q=${encodeURIComponent('태스크')}`);
    assert.strictEqual(searched.status, 200);
    const searchValue = JSON.parse(searched.body);
    assert.strictEqual(searchValue.status, 'ok');
    assert(searchValue.total > 0, '검색이 이 픽스처에서 한 건도 못 찾으면 안 된다.');
    // 결과마다 어디서 왔는지와 무엇에 붙은 것인지가 함께 와야 한다. 원장 줄은 붙은
    // 대상 없이는 읽을 수 없고, 문서·태스크와 모양이 갈리면 화면이 출처 줄을 두 벌 그린다.
    for (const hit of searchValue.results) {
      assert(hit.origin && typeof hit.origin.label === 'string', `출처가 없다: ${hit.id}`);
      assert(hit.attachedTo && typeof hit.attachedTo.kind === 'string', `붙은 대상 자리가 없다: ${hit.id}`);
      assert(hit.matches.length > 0 && hit.matches[0].excerpts.length > 0, `발췌가 없다: ${hit.id}`);
    }
    // 이 픽스처는 승인 원장을 갖기 전 판이다. 원장을 못 읽어도 문서·태스크는 나와야
    // 하고, 못 읽은 이유는 값에 실려야 한다 — 원장이 깨진 저장소와 원장을 안 쓰는
    // 저장소가 화면에서 같아 보이면 앞엣것을 아무도 모른다.
    assert.strictEqual(searchValue.counts.ledger, 0);
    assert.strictEqual(searchValue.scanned.ledger.read, false);
    assert.strictEqual(typeof searchValue.scanned.ledger.reason, 'string');

    // 한 글자에 전건이 나오면 그것은 검색이 아니라 목록이다. 다만 오류도 아니다 —
    // 두 글자를 치는 도중에 반드시 지나는 상태다.
    const tooShort = await request(port, '/api/projects/tms/search?q=a');
    assert.strictEqual(tooShort.status, 200);
    assert.strictEqual(JSON.parse(tooShort.body).status, 'too-short');
    assert.strictEqual(JSON.parse(tooShort.body).total, 0);
    const emptyQuery = await request(port, '/api/projects/tms/search');
    assert.strictEqual(emptyQuery.status, 200);
    assert.strictEqual(JSON.parse(emptyQuery.body).status, 'empty');
    // 모르는 갈래는 빈 결과가 아니라 거절이다. 빈 결과로 답하면 "그 갈래에 아무것도
    // 없다"로 읽힌다 — 없는 노드를 400으로 끊는 전환 판정과 같은 자리다.
    const unknownSource = await request(port, '/api/projects/tms/search?q=%ED%83%9C%EC%8A%A4%ED%81%AC&source=nope');
    assert.strictEqual(unknownSource.status, 400);
    assert.strictEqual(JSON.parse(unknownSource.body).code, 'unknown-source');

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

    // ── 문서 이력과 임의 비교 ──────────────────────────────────────────────
    //
    // 승인 판은 정해진 두 축만 답한다. 검토하다 보면 "세 판 전과 견주면 어떤가"와
    // "언제부터 이렇게 됐나"를 묻게 되는데, 앞엣것의 기준은 원장이 아니라 사람이 이력에서
    // 고르고 뒤엣것의 답은 이력에만 있다 — 축을 늘려서는 둘 다 답하지 못한다.

    // 시간축의 규칙 셋. 실제 원장으로는 같은 밀리초도 못 읽는 시각도 만들기 어렵고,
    // 만들 수 없는 것은 시험되지 않는다 — 시험되지 않는 규칙은 다음 사람이 지운다.
    {
      const { documentTimeline } = require('../src/board');
      const timeline = documentTimeline({
        approvals: [{ recordedAt: '2026-08-20T15:15:53.000Z', approvedBy: 'MEMBER-001', reviewedRevision: 'a'.repeat(64), reason: '승인', basis: [] }],
        submissions: [{ recordedAt: '2026-08-20T15:15:53.000Z', submittedBy: 'MEMBER-002', submittedRevision: 'b'.repeat(64), reason: '제출' }],
        rejections: [{ recordedAt: null, rejectedBy: 'MEMBER-003', rejectedRevision: 'c'.repeat(64), reason: '시각을 잃은 줄' }],
        commits: [
          { commit: 'f'.repeat(40), author: '지은이', at: '2026-08-20T15:15:53.000Z', subject: '같은 순간의 커밋' },
          { commit: 'e'.repeat(40), author: '지은이', at: '2026-09-06T21:21:42.000Z', subject: '가장 최근 커밋' }
        ]
      });
      // 시각을 못 읽는 줄은 맨 뒤다. 맨 앞은 "가장 최근에 일어난 일"이라는 자리인데
      // 읽을 수 없는 시각으로는 그 주장을 받칠 수 없고, 던지면 줄 하나가 이력 전체를 지운다.
      assert.deepStrictEqual(timeline.map((row) => row.kind), ['commit', 'approval', 'submission', 'commit', 'rejection'],
        `시간축의 순서가 규칙과 다릅니다: ${JSON.stringify(timeline.map((row) => `${row.kind}@${row.at}`))}`);
      // 같은 순간이면 원장이 커밋 위다. 원장 사건은 커밋된 리비전을 지목하므로 커밋이
      // 원인이고 원장이 결과이며, 최근이 위인 목록에서 결과는 원인 위에 온다.
      assert.strictEqual(timeline[3].kind, 'commit', '같은 순간의 커밋은 원장 줄 아래여야 합니다.');
      // 같은 순간의 원장 줄끼리는 들어온 차례를 지킨다 — 안정 정렬이라야 같은 이력이
      // 요청마다 같은 목록으로 온다. 흔들리면 사람은 방금 본 줄을 다시 찾지 못한다.
      assert.deepStrictEqual([timeline[1].who, timeline[2].who], ['MEMBER-001', 'MEMBER-002']);
      // 지목할 주소의 종류는 줄마다 다르다. 하나로 뭉개면 화면이 원장 줄을 커밋으로
      // 지목하려 들고, 그 지목은 어느 축에서도 답을 찾지 못한다.
      assert.deepStrictEqual(timeline.map((row) => row.pointKind), ['commit', 'revision', 'revision', 'commit', 'revision']);
    }
    const historyAnswer = await request(port, '/api/projects/tms/documents/ADR-001/history');
    // 이력 자리가 문서 조회 경로에 삼켜지지 않는다. `/documents/:id` 정규식이 뒤 조각까지
    // 먹으면 이 경로는 조용히 문서 하나를 돌려주고, 화면은 이력이 빈 채로 온 줄로 읽는다.
    assert.strictEqual(historyAnswer.headers['content-type'], 'application/json; charset=utf-8');
    // 이 픽스처는 schemaVersion 3이라 승인 원장 자체가 없다. 없는 것을 500으로 내면 화면은
    // "보드가 죽었다"로 읽고 무엇을 고쳐야 하는지 알 수 없다 — 못 읽은 이유를 그대로 내는
    // 것이 이 축의 규율이고, 차분 자리가 이미 지키는 선이다.
    assert.strictEqual(historyAnswer.status, 400, `원장을 못 읽는 것은 서버 결함이 아닙니다: ${historyAnswer.body}`);
    assert(/schemaVersion/u.test(JSON.parse(historyAnswer.body).error), `못 읽은 이유가 그대로 와야 합니다: ${historyAnswer.body}`);

    const { runGit } = require('../src/git');
    const tmsRoot = path.join(root, 'test', 'fixtures', 'workspace', 'projects', 'tms');
    const recent = runGit(['log', '-n', '2', '--format=%H'], { cwd: tmsRoot, allowFailure: true });
    const commits = (recent.status === 0 ? recent.stdout : '').split(/\r?\n/u).filter(Boolean);
    assert(commits.length >= 1, '픽스처가 사는 저장소에 커밋이 있어야 이 축을 잴 수 있습니다.');
    const rangeAt = (query) => request(port, `/api/projects/tms/documents/ADR-001/diff?axis=range&${query}`);

    // 지점 값은 그대로 git 인자가 된다. 모양에서 막지 않으면 조회 경로가 곧 임의의
    // 문자열을 git에 넘기는 경로가 되고, 그 사실은 넘어간 다음에야 드러난다.
    for (const query of [`from=zzzzzzz&to=${commits[0]}`, `from=${commits[0]}&to=..%2F..%2Fpackage.json`, `from=--output%3Dx&to=${commits[0]}`]) {
      const refused = await rangeAt(query);
      assert.strictEqual(refused.status, 400, `모양이 아닌 지점은 거부되어야 합니다(${query}): ${refused.body}`);
      assert.strictEqual(JSON.parse(refused.body).code, 'invalid-point');
    }
    // 지점이 하나만 오면 비교가 성립하지 않는다. 없는 쪽을 지금 리비전이나 HEAD로 메우면
    // 사람이 고르지 않은 기준으로 견준 차분을 사람이 고른 것으로 믿게 된다.
    for (const query of [`to=${commits[0]}`, `from=${commits[0]}`]) {
      const half = await rangeAt(query);
      assert.strictEqual(half.status, 400, `한 지점만으로는 비교가 성립하지 않습니다(${query}): ${half.body}`);
      assert.strictEqual(JSON.parse(half.body).code, 'missing-point');
    }

    // 값의 종류는 길이가 가른다. 리비전은 sha256이라 64자리이고 커밋은 40자리가 최대라
    // 두 집합이 겹치지 않는다 — 종류를 따로 받는 칸을 두면 화면이 그 칸을 틀리게 채우는
    // 갈래가 생기는데, 길이는 값 자신이 이미 말하고 있어 틀릴 수 없다.
    const unknownRevision = JSON.parse((await rangeAt(`from=${'a'.repeat(64)}&to=${commits[0]}`)).body);
    assert.strictEqual(unknownRevision.from.kind, 'revision', '64자리는 원장의 주소로 읽혀야 합니다.');
    assert.strictEqual(unknownRevision.to.kind, 'commit', '40자리는 git의 주소로 읽혀야 합니다.');
    // 못 찾은 지점에 빈 차분을 지어내지 않는다. "비교 기준 없음"과 "바뀐 것 없음"은 다른
    // 값이고, 앞엣것을 뒤엣것으로 그리면 사람은 아무것도 안 바뀐 줄 알고 승인한다.
    assert.strictEqual(unknownRevision.diff, null, '못 찾은 지점으로 차분을 지어내면 안 됩니다.');
    assert(/찾지 못했습니다/u.test(unknownRevision.reason), `못 찾았으면 이유가 있어야 합니다: ${JSON.stringify(unknownRevision.reason)}`);
    const unknownCommit = JSON.parse((await rangeAt(`from=${'0'.repeat(40)}&to=${commits[0]}`)).body);
    assert.strictEqual(unknownCommit.from.commit, null, '없는 커밋을 있는 것으로 답하면 안 됩니다.');
    assert(/찾지 못했습니다/u.test(unknownCommit.reason));

    // 같은 지점 둘은 사이가 없다. 이유 없이 빈 차분으로 그리면 "안 바뀌었다"로 읽힌다.
    const identical = JSON.parse((await rangeAt(`from=${commits[0]}&to=${commits[0]}`)).body);
    assert.strictEqual(identical.diff, '');
    assert(/같은 커밋/u.test(identical.reason), `같은 지점이라는 사실을 말해야 합니다: ${identical.reason}`);

    if (commits.length >= 2) {
      const between = JSON.parse((await rangeAt(`from=${commits[1]}&to=${commits[0]}`)).body);
      assert.strictEqual(between.axis, 'range');
      assert.strictEqual(between.from.commit, commits[1]);
      assert.strictEqual(between.to.commit, commits[0]);
      assert.strictEqual(typeof between.diff, 'string', `두 커밋 사이는 차분이 나와야 합니다: ${JSON.stringify(between.reason)}`);
    }

    // 모르는 축은 가능한 축을 말한다. 늘어난 축이 그 문장에 없으면 화면은 서버가 아는
    // 것보다 좁은 것만 물을 수 있는 줄로 읽는다.
    const unknownAxis = await request(port, '/api/projects/tms/documents/ADR-001/diff?axis=nonsense');
    assert.strictEqual(unknownAxis.status, 400);
    assert(/range/u.test(JSON.parse(unknownAxis.body).error), `가능한 축에 range가 있어야 합니다: ${unknownAxis.body}`);

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

    // ── 넣은 그림을 다시 볼 수 있는가 ────────────────────────────────────
    //
    // 넣기와 보기가 같은 이름 공간을 쓰는지가 이 두 경로의 유일한 계약이다. 실측에서
    // 화면은 `![[이름]]`을 문서 참조로 옮겨 `#document=이름`을 src에 넣었고, 넣기는
    // 200인데 보기는 404였다 — 사람에게는 그것이 "업로드가 안 되는 것"이다.
    //
    // 그래서 화면이 주소를 만드는 데 쓰는 값을 여기서 그대로 쓴다: 스냅숏이 말하는
    // 자산 디렉터리에 돌려받은 이름을 붙인 주소가 그 그림이어야 한다.
    {
      // 1x1 PNG. 여기서 재는 것은 그림의 내용이 아니라 넣기와 보기가 같은 이름을
      // 쓰는지이므로, 헤더 판별을 지나는 가장 작은 그림이면 된다.
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de'
        + '0000000c49444154789c6338a1a1010002d4011905508fa40000000049454e44ae426082',
        'hex'
      );
      const added = await request(port, '/api/projects/tms/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-rundol-token': 'test-session-token' },
        body: JSON.stringify({ name: '한글 갈무리.png', data: png.toString('base64') })
      });
      assert.strictEqual(added.status, 200, `그림을 넣지 못했습니다: ${added.body}`);
      const result = JSON.parse(added.body);
      // 한글 이름은 흔하다. 깨지면 검사와 화면이 서로 다른 이름을 보게 된다.
      assert.strictEqual(result.name, '한글-갈무리.png', `이름 규칙이 달라졌습니다: ${result.name}`);
      assert.strictEqual(result.embed, '![[한글-갈무리.png]]');
      try {
        const state = JSON.parse((await request(port, '/api/projects/tms/board-snapshot')).body);
        assert(state.assets && state.assets.directory, '스냅숏이 자산이 사는 자리를 말해야 화면이 주소를 만들 수 있습니다');
        const url = `/api/projects/tms/assets/${`${state.assets.directory}/${result.name}`.split('/').map(encodeURIComponent).join('/')}`;
        const served = await request(port, url);
        assert.strictEqual(served.status, 200, `넣은 그림을 그 주소에서 받지 못했습니다(${url}): ${served.status}`);
        assert.strictEqual(served.headers['content-type'], 'image/png');
      } finally {
        fs.rmSync(path.join(root, 'test', 'fixtures', 'workspace', 'projects', 'tms', 'docs', 'assets', result.name), { force: true });
      }
    }

    // 본문 한계를 넘으면 소켓을 끊는 대신 이유를 말한다. 끊으면 브라우저는 응답 대신
    // 네트워크 오류를 받고, 화면에는 "Failed to fetch"만 남는다.
    const oversize = await request(port, '/api/projects/tms/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rundol-token': 'test-session-token' },
      body: JSON.stringify({ name: 'huge.png', data: 'A'.repeat(34 * 1024 * 1024) })
    });
    assert.strictEqual(oversize.status, 413, `본문 한계 초과가 413이 아닙니다: ${oversize.status}`);
    assert(/KB를 넘을 수 없습니다/u.test(JSON.parse(oversize.body).error), `한계를 말해야 합니다: ${oversize.body}`);

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
