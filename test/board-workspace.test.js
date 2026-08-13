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
    command(process.execPath, [cli, 'init', 'crm', '--name', 'CRM', '--root', temporary], repository);
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
      assert.deepStrictEqual(snapshot.json.contract.catalog.sections.SCR, ['진입', '사용자 흐름', '바인딩', '상태', '접근성과 반응형', '디자인에 없는 것']);
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

      const acquired = await request(port, '/api/projects/crm/leases/project%3Acrm/acquire', board.token, 'POST', { clientId: 'test-device' });
      assert.strictEqual(acquired.status, 200);
      const leases = await request(port, '/api/projects/crm/leases', board.token);
      assert.strictEqual(leases.json.leases.length, 1);

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
