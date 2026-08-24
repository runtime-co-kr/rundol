'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createBoardServer } = require('../src/board');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function request(port, pathname, token, method, body) {
  return new Promise((resolve, reject) => {
    const content = body === undefined ? null : JSON.stringify(body);
    const headers = content ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content), 'X-Rundol-Token': token } : {};
    // agent: false — 연결 재사용을 끈다. 이유는 board.test.js의 같은 자리에 적었다.
    const call = http.request({ hostname: '127.0.0.1', port, path: pathname, method: method || 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    call.on('error', reject);
    if (content) call.write(content);
    call.end();
  });
}

async function testWorkspaceBoard() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-board-workspace-'));
  try {
    command('git', ['init', '-b', 'main'], temporary);
    command('git', ['config', 'user.name', 'Rundol Test'], temporary);
    command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
    fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
    command('git', ['add', 'README.md'], temporary);
    command('git', ['commit', '-m', 'initial'], temporary);
    command(process.execPath, [cli, 'init', 'crm', '--name', 'CRM', '--defaults', '--root', temporary], repository);
    command(process.execPath, [cli, 'client', 'register', 'test-device', '--name', 'Test Device', '--type', 'device', '--owner', 'MEMBER-001', '--root', temporary], repository);
    const task = JSON.parse(command(process.execPath, [cli, 'task', 'add', 'API test', '--acceptance', 'works', '--project', 'crm', '--root', temporary, '--json'], repository));

    const board = createBoardServer(temporary, { project: 'crm', token: 'workspace-token' });
    await new Promise((resolve, reject) => { board.server.once('error', reject); board.server.listen(0, '127.0.0.1', resolve); });
    const port = board.server.address().port;
    try {
      const clients = await request(port, '/api/clients', board.token);
      assert.strictEqual(clients.status, 200);
      assert(clients.json.clients.some((client) => client.id === 'test-device'));

      const snapshot = await request(port, '/api/projects/crm/board-snapshot', board.token);
      assert.strictEqual(snapshot.status, 200);
      assert(Array.isArray(snapshot.json.documents));
      assert(Array.isArray(snapshot.json.attention));
      assert(Array.isArray(snapshot.json.clients));
      assert.strictEqual(typeof snapshot.json.revision.sync, 'string');
      assert.strictEqual(snapshot.json.contract.status, 'valid');
      assert.strictEqual(snapshot.json.contract.profile.schemaVersion, 2);
      assert.strictEqual(typeof snapshot.json.revision.contract, 'string');
      assert.strictEqual(typeof snapshot.json.revision.presentation, 'string');
      assert.strictEqual(snapshot.json.presentation.documentTypes.requirement.label, '요구사항');
      assert.strictEqual(snapshot.json.presentation.inheritance.workspace.configured, true);
      assert.strictEqual(snapshot.json.presentation.inheritance.project.configured, true);
      assert.deepStrictEqual(snapshot.json.contract.catalog.sections.SCR, ['진입', '사용자 흐름', '전이', '바인딩', '상태', '접근성과 반응형', '디자인에 없는 것']);
      const contract = await request(port, '/api/projects/crm/contract', board.token);
      assert.strictEqual(contract.status, 200);
      assert.strictEqual(contract.json.revision, 1);
      const contractPlan = await request(port, '/api/projects/crm/contract/plan', board.token, 'POST', { name: 'lean', enforcement: 'advisory' });
      assert.strictEqual(contractPlan.status, 200);
      assert.strictEqual(contractPlan.json.profile.enforcement, 'advisory');
      const contractUpdated = await request(port, '/api/projects/crm/contract', board.token, 'POST', { baseRevision: contract.json.revision, name: 'lean', enforcement: 'advisory' });
      assert.strictEqual(contractUpdated.status, 200);
      assert.strictEqual(contractUpdated.json.revision, 2);
      const contractStale = await request(port, '/api/projects/crm/contract', board.token, 'POST', { baseRevision: contract.json.revision, name: 'service' });
      assert.strictEqual(contractStale.status, 409);
      const contractMissingRevision = await request(port, '/api/projects/crm/contract', board.token, 'POST', { name: 'service' });
      assert.strictEqual(contractMissingRevision.status, 409);
      const editable = snapshot.json.documents.find((document) => document.id === 'project:crm');
      const edited = await request(port, '/api/projects/crm/documents/project%3Acrm', board.token, 'POST', { baseRevision: editable.revision, body: `${editable.body}\n\nBoard edit test.` });
      assert.strictEqual(edited.status, 200);
      assert(edited.json.body.includes('Board edit test.'));
      const staleDocument = await request(port, '/api/projects/crm/documents/project%3Acrm', board.token, 'POST', { baseRevision: editable.revision, body: editable.body });
      assert.strictEqual(staleDocument.status, 409);
      // 고치지 않은 문서를 저장하면 파일이 한 바이트도 달라지지 않아야 한다. 템플릿은
      // 닫는 --- 뒤에 빈 줄을 두는데, 저장이 그 줄을 지우면 손대지 않은 문서에도 diff가
      // 남아 실제 변경과 섞인다. 템플릿을 그대로 쓰는 문서로 확인해야 이 경로를 탄다.
      const created = JSON.parse(command(process.execPath, [cli, 'doc', 'create', 'ARC', '빈 줄 보존 확인', '--owner', 'MEMBER-001', '--scope', 'Board 저장 왕복 경계', '--exclude', '그 밖의 시스템 구조', '--project', 'crm', '--root', temporary, '--json'], repository));
      const untouchedPath = created.file;
      assert.ok(/\r?\n---\r?\n\r?\n/u.test(fs.readFileSync(untouchedPath, 'utf8')), '템플릿에 빈 줄이 없어 이 검사가 무의미합니다.');
      const refreshed = await request(port, '/api/projects/crm/board-snapshot', board.token);
      const untouched = refreshed.json.documents.find((document) => document.id === created.id);
      const before = fs.readFileSync(untouchedPath, 'utf8');
      const resaved = await request(port, `/api/projects/crm/documents/${encodeURIComponent(created.id)}`, board.token, 'POST', { baseRevision: untouched.revision, body: untouched.body });
      assert.strictEqual(resaved.status, 200);
      assert.strictEqual(fs.readFileSync(untouchedPath, 'utf8'), before, 'Board 저장이 내용을 바꾸지 않은 문서를 변형했습니다.');
      assert.strictEqual(resaved.json.revision, untouched.revision, '내용이 같은데 revision이 바뀌었습니다.');

      // 문서 편집 소프트 리스는 ADR-015로 폐기했다. 경로가 사라졌는지와, 그 자리를
      // 무엇이 대신하는지를 함께 본다 — 경로만 지우고 대체를 확인하지 않으면 동시
      // 편집이 조용히 덮어쓰이는 상태로 물러난다.
      const gone = await request(port, '/api/projects/crm/leases', board.token);
      assert.strictEqual(gone.status, 404, '폐기한 임대 경로가 살아 있습니다.');
      const goneAction = await request(port, '/api/projects/crm/leases/project%3Acrm/acquire', board.token, 'POST', { clientId: 'test-device' });
      assert.strictEqual(goneAction.status, 404, '폐기한 임대 획득 경로가 살아 있습니다.');

      const afterRetire = await request(port, "/api/projects/crm/board-snapshot", board.token);
      assert.strictEqual(afterRetire.json.leases, undefined, '스냅샷에 임대 영역이 남아 있습니다.');
      assert.strictEqual(afterRetire.json.revision.leases, undefined, '임대 영역 revision이 남아 있습니다.');

      // 대체 수단: 저장 시점의 revision 비교. 낡은 revision으로 쓰면 409와 함께
      // 최신 내용이 돌아오므로 조용히 덮어쓰이지 않는다.
      const target = afterRetire.json.documents.find((document) => document.id === 'project:crm');
      const first = await request(port, `/api/projects/crm/documents/project%3Acrm`, board.token, 'POST', { baseRevision: target.revision, body: `${target.body}\n\nConcurrent edit test.`, clientId: 'someone-else' });
      assert.strictEqual(first.status, 200);
      const staleConcurrent = await request(port, `/api/projects/crm/documents/project%3Acrm`, board.token, 'POST', { baseRevision: target.revision, body: `${target.body}\n\nStale write.`, clientId: 'test-device' });
      assert.strictEqual(staleConcurrent.status, 409, '낡은 revision 저장은 거절해야 합니다.');
      assert.ok(staleConcurrent.json.current, '거절 응답은 최신 내용을 함께 돌려줘야 합니다.');

      const current = await request(port, `/api/projects/crm/tasks/${task.taskId}`, board.token);
      assert.strictEqual(current.status, 200);
      const acceptanceCriteria = JSON.parse(JSON.stringify(current.json.acceptanceCriteria));
      acceptanceCriteria['AC-001'].done = true;
      const accepted = await request(port, `/api/projects/crm/tasks/${task.taskId}`, board.token, 'POST', { baseRevision: current.json.revision, acceptanceCriteria });
      assert.strictEqual(accepted.status, 200);
      assert.strictEqual(accepted.json.after.acceptanceCriteria['AC-001'].done, true);
      const stale = await request(port, `/api/projects/crm/tasks/${task.taskId}`, board.token, 'POST', { status: 'doing', baseRevision: 'stale' });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.json.current.id, task.taskId);

      // ── 프로젝트가 정의한 흐름이 화면까지 온다 ────────────────────────────
      //
      // 이 자리가 오래 비어 있었다. 스냅숏은 workflow.js의 모듈 최상위 뷰를 실었고
      // 그것은 transitions: null로 만든 내장 인스턴스라, 전환도 라벨도 언제나
      // 비어 있었다 — workflows.json을 고쳐도 화면은 그대로였다는 뜻이고, 설정 층은
      // 있는데 그 층을 보여 주는 화면이 없었다는 뜻이다.
      //
      // 이 프로젝트는 rdl init이 심은 workflows.json을 그대로 갖고 있다. 시드는
      // 노드에 이름을 붙이되 전환은 심지 않으므로, 여기서 확인하는 것은 "라벨이
      // 온다"와 "전환을 안 적은 흐름은 여전히 막지 않는다" 둘이다.
      const seeded = await request(port, '/api/projects/crm/board-snapshot', board.token);
      assert.strictEqual(seeded.json.workflow.id, 'task-default', '프로젝트가 받은 흐름이 이름째로 와야 합니다.');
      assert.strictEqual(seeded.json.workflow.origin, 'project');
      assert.strictEqual(seeded.json.workflow.error, null);
      assert.strictEqual(seeded.json.workflow.label, '태스크 기본 흐름');
      assert.strictEqual(seeded.json.workflow.nodes.todo.label, '할 일', '시드가 심은 라벨이 화면까지 와야 합니다.');
      assert.strictEqual(seeded.json.workflow.nodes.doing.label, '진행중');
      assert.strictEqual(seeded.json.workflow.nodes.review.label, '검토중');
      assert.strictEqual(seeded.json.workflow.transitions, null, '시드는 전환을 심지 않습니다 — 닫는 것은 팀이 합니다.');
      assert.deepStrictEqual(seeded.json.workflow.bindings, { '*': 'task-default' });
      // 출처는 업무 유형 패널이 쓰는 origins와 같은 모양이다. 모양이 갈리면 화면이
      // 같은 질문에 두 벌의 그림을 그리게 된다.
      assert.strictEqual(seeded.json.workflow.sources.workflows['task-default'].entry, 'project');
      assert.strictEqual(seeded.json.workflow.sources.workflows['task-default'].fields.nodes, 'project');
      assert.strictEqual(seeded.json.workflow.sources.bindings.task.entry, 'project');
      assert.strictEqual(seeded.json.workflow.sources.bindings.task.fields['*'], 'project');

      // ── 파일을 고치면 화면이 받는 값이 달라진다 ───────────────────────────
      //
      // 이 갈래가 고치는 것이 이 한 줄이다. 위층에 흐름을 하나 세워 두는 이유는
      // 출처가 층을 구분하는지 함께 보기 위해서다 — 구분하지 못하면 화면은 "이 값을
      // 여기서 되돌릴 수 있는가"에 답할 수 없다.
      fs.writeFileSync(path.join(temporary, 'projects', 'workspace', 'workflows.json'), `${JSON.stringify({
        schemaVersion: 1,
        workflows: {
          'task-strict': {
            targetKind: 'task',
            label: '엄격 흐름',
            nodes: { todo: { step: 'unclaimed' }, done: { step: 'completed', validity: 'valid', requiresOwner: true } }
          }
        }
      }, null, 2)}\n`);
      const projectFlowFile = path.join(temporary, 'projects', 'crm', 'workflows.json');
      const projectFlow = JSON.parse(fs.readFileSync(projectFlowFile, 'utf8'));
      projectFlow.workflows['task-default'].transitions = [
        { from: 'todo', to: 'doing', title: '착수' },
        { from: 'doing', to: 'review', title: '검토 요청' },
        { from: 'review', to: 'done', title: '승인', approval: { human: true } }
      ];
      fs.writeFileSync(projectFlowFile, `${JSON.stringify(projectFlow, null, 2)}\n`);

      const configured = await request(port, '/api/projects/crm/board-snapshot', board.token);
      assert.strictEqual(configured.json.workflow.transitions.length, 3, 'workflows.json을 고쳤는데 화면이 받는 값이 그대로입니다.');
      assert.deepStrictEqual(configured.json.workflow.transitions[0], { from: 'todo', to: 'doing', title: '착수', approval: false });
      assert.strictEqual(configured.json.workflow.transitions[2].approval, true, '사람 게이트는 전환에 붙어 와야 합니다.');
      assert.strictEqual(configured.json.workflow.sources.workflows['task-strict'].entry, 'workspace', '위층이 정의한 흐름은 위층의 것으로 표시되어야 합니다.');
      assert.strictEqual(configured.json.workflow.sources.workflows['task-default'].entry, 'project');

      // ── 판정 엔드포인트 ──────────────────────────────────────────────────
      //
      // 없으면 화면이 자체 판정을 만들고, 그 순간 JUDGMENT_SURFACES 넷 밖에 다섯
      // 번째 표면이 생긴다. 그래서 확인하는 것은 "답이 온다"가 아니라 "저장이 막는
      // 것과 같은 것을 막는다"이다.
      const unowned = await request(port, `/api/projects/crm/tasks/${task.taskId}/transitions?to=doing`, board.token);
      assert.strictEqual(unowned.status, 200);
      assert.strictEqual(unowned.json.workflow.id, 'task-default');
      assert.strictEqual(unowned.json.workflow.origin, 'project');
      assert.strictEqual(unowned.json.transitions.length, 1, '하나만 물으면 하나만 답합니다.');
      // 선언된 전환이어도 항목이 못 갖췄으면 막힌다. 둘은 다른 종류의 막힘이라 화면이
      // 구분해 그릴 수 있어야 하고, 그래서 origin이 규칙마다 붙어 온다.
      assert.strictEqual(unowned.json.transitions[0].declared, true);
      assert.strictEqual(unowned.json.transitions[0].allowed, false);
      assert.deepStrictEqual(unowned.json.transitions[0].blockers.map((blocker) => blocker.ruleId), ['claimed-requires-owner']);
      assert.strictEqual(unowned.json.transitions[0].blockers[0].origin, 'item-type');

      const beforeOwner = await request(port, `/api/projects/crm/tasks/${task.taskId}`, board.token);
      const owned = await request(port, `/api/projects/crm/tasks/${task.taskId}`, board.token, 'POST', { baseRevision: beforeOwner.json.revision, owner: 'MEMBER-001' });
      assert.strictEqual(owned.status, 200);

      const judged = await request(port, `/api/projects/crm/tasks/${task.taskId}/transitions`, board.token);
      assert.strictEqual(judged.status, 200);
      const toDoing = judged.json.transitions.find((item) => item.to === 'doing');
      assert.strictEqual(toDoing.declared, true);
      assert.strictEqual(toDoing.title, '착수', '전환의 이름이 화면까지 와야 단추에 무엇을 적을지 정해집니다.');
      assert.strictEqual(toDoing.allowed, true, '담당자를 채운 뒤에는 선언된 전환이 열려야 합니다.');
      const toDone = judged.json.transitions.find((item) => item.to === 'done');
      assert.strictEqual(toDone.declared, false, '선언되지 않은 전환은 후보에 남되 갈 수는 없습니다.');
      assert.strictEqual(toDone.allowed, false);
      // 갈 수 없는 자리에 "가면 무엇이 모자란가"를 함께 말하지 않는다. 말하면 사람은
      // 그 모자란 것을 채우려 들고, 채워도 여전히 못 간다.
      assert.deepStrictEqual(toDone.blockers.map((blocker) => blocker.code), ['RDL-FLOW-001']);

      // 저장도 같은 답을 내야 한다. 화면이 못 간다고 한 자리를 저장이 받으면 판정이
      // 두 벌이라는 뜻이고, 그 어긋남은 화면을 믿은 사람이 뒤늦게 만나게 된다.
      const beforeMove = await request(port, `/api/projects/crm/tasks/${task.taskId}`, board.token);
      const refused = await request(port, `/api/projects/crm/tasks/${task.taskId}`, board.token, 'POST', { baseRevision: beforeMove.json.revision, status: 'done' });
      assert.strictEqual(refused.status, 400, '화면이 못 간다고 한 자리는 저장도 막아야 합니다.');
      assert(refused.json.error.includes('전환이 이 워크플로에 없습니다'), `저장이 다른 이유로 막았습니다: ${refused.json.error}`);
      const allowedMove = await request(port, `/api/projects/crm/tasks/${task.taskId}`, board.token, 'POST', { baseRevision: beforeMove.json.revision, status: 'doing' });
      assert.strictEqual(allowedMove.status, 200, '화면이 갈 수 있다고 한 자리는 저장도 받아야 합니다.');

      // 설정이 깨져도 보드 전체가 닫히지는 않는다. 다만 조용히 내장으로 물러나면
      // 화면은 자기가 무엇을 보고 있는지 모르므로, 물러났다는 사실이 값에 남는다.
      fs.writeFileSync(projectFlowFile, '{ 이건 JSON이 아니다');
      const broken = await request(port, '/api/projects/crm/board-snapshot', board.token);
      assert.strictEqual(broken.status, 200, '설정 한 줄이 틀렸다고 보드가 닫히면 고칠 화면도 못 엽니다.');
      assert.strictEqual(broken.json.workflow.origin, 'builtin');
      assert.strictEqual(broken.json.workflow.transitions, null);
      assert(broken.json.workflow.error.includes('JSON을 읽지 못했습니다'), '내장으로 물러난 이유가 값에 없습니다.');
      // 직접 물은 물음에는 내장의 답을 돌려주지 않는다. 돌려주면 물은 사람은 자기
      // 설정이 도는 줄 알게 된다.
      const brokenJudgment = await request(port, `/api/projects/crm/tasks/${task.taskId}/transitions`, board.token);
      assert.strictEqual(brokenJudgment.status, 500);
      assert(brokenJudgment.json.error.includes('JSON을 읽지 못했습니다'));
    } finally {
      await new Promise((resolve) => board.server.close(resolve));
    }
    process.stdout.write('workspace board tests passed\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = testWorkspaceBoard();
