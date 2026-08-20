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
    } finally {
      await new Promise((resolve) => board.server.close(resolve));
    }
    process.stdout.write('workspace board tests passed\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = testWorkspaceBoard();
