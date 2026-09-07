'use strict';

// 설정 화면이 정책을 저장하는 길 전체를 서버 표면에서 잰다. 게이트 자체는
// policy-gate 시험이 단위로 덮으므로 여기서 묻는 것은 다르다 — 화면이 받은 값을
// 그대로 되돌려 보낼 수 있는가, 막혔을 때 무엇을 해야 하는지가 응답에 있는가,
// 그리고 한 번 받은 결정이 다음 저장을 열지 않는가.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { createBoardServer } = require('../src/board');
const { clientId } = require('../src/tasks');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-board-policy-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-board-policy-home-'));
const TOKEN = 'test-session-token';

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

function call(port, pathname, options) {
  const settings = Object.assign({ method: 'GET', headers: {} }, options || {});
  const headers = Object.assign({ 'x-rundol-token': TOKEN }, settings.headers);
  if (settings.body) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method: settings.method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
        resolve({ status: response.statusCode, body: parsed, text });
      });
    });
    request.on('error', (error) => reject(new Error(`${settings.method} ${pathname}: ${error.code || error.message}`)));
    if (settings.body) request.write(settings.body);
    request.end();
  });
}

module.exports = (async () => {
  let board = null;
  try {
    command('git', ['init', '-b', 'main']);
    command('git', ['config', 'user.name', 'Rundol Test']);
    command('git', ['config', 'user.email', 'rundol@example.test']);
    fs.writeFileSync(path.join(temporary, 'README.md'), '# board policy\n', 'utf8');
    command('git', ['add', 'README.md']);
    command('git', ['commit', '-m', 'initial']);
    rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);

    // Board는 자격을 지어내지 않고 이 기기의 등록된 Client를 쓴다. 그러므로 시험도
    // 그 값을 알아내 등록해야 하고, 사람이어야 결정에 답할 수 있다 — 문서 승인과
    // 같은 판정 함수를 지나기 때문이다.
    const projectRoot = path.join(temporary, 'projects', 'crm');
    const deskId = clientId(projectRoot);
    rdl(['client', 'register', deskId, '--name', '사람 데스크', '--type', 'human', '--owner', 'MEMBER-001']);

    board = createBoardServer(temporary, { token: TOKEN, project: 'crm' });
    await new Promise((resolve, reject) => {
      board.server.once('error', reject);
      board.server.listen(0, '127.0.0.1', resolve);
    });
    const port = board.server.address().port;

    // ── 화면이 받은 값을 그대로 되돌려 보낼 수 있어야 한다 ──────────────────
    //
    // 병합 결과만 내주면 못 한다. 정규화가 executionUnits를 units로 바꾸므로 받은
    // 것을 그대로 POST하면 저장이 "알 수 없는 키"로 거절하고, 화면은 자기가 방금
    // 받은 값조차 저장하지 못하는 상태가 된다.
    const loaded = await call(port, '/api/projects/crm/workflows');
    assert.strictEqual(loaded.status, 200, loaded.text);
    assert(Array.isArray(loaded.body.layers), '층별 원본이 실려야 화면이 무엇을 고치는지 압니다');
    assert(loaded.body.baseRevision, '겨룰 값이 있어야 남이 먼저 고친 것을 잡습니다');

    const layer = loaded.body.layers.find((item) => item.scope === 'project') || { content: null };
    const own = layer.content || {};
    const unchanged = await call(port, '/api/projects/crm/workflows', {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', baseRevision: loaded.body.baseRevision, workflows: own.workflows, bindings: own.bindings })
    });
    assert.strictEqual(unchanged.status, 200, `받은 값을 그대로 되돌려주지 못하면 화면은 아무것도 저장할 수 없습니다: ${unchanged.text}`);

    // ── 정책이 바뀌면 저장하지 않고, 무엇을 해야 하는지를 응답에 담는다 ──────
    const before = await call(port, '/api/projects/crm/workflows');
    const flow = {
      targetKind: 'task',
      label: '검증 흐름',
      nodes: { todo: { step: 'unclaimed' }, doing: { step: 'in-progress' }, done: { step: 'completed', validity: 'valid' } },
      transitions: [{ from: 'todo', to: 'doing' }, { from: 'doing', to: 'done' }]
    };
    const change = { scope: 'project', workflows: { 'flow-a': flow }, bindings: { task: { '*': 'flow-a' } } };
    const blocked = await call(port, '/api/projects/crm/workflows', {
      method: 'POST', body: JSON.stringify(Object.assign({ baseRevision: before.body.baseRevision }, change))
    });
    assert.strictEqual(blocked.status, 409, blocked.text);
    assert.strictEqual(blocked.body.reason, 'decision-required', `막힌 이유가 이름으로 갈려야 합니다: ${blocked.text}`);
    assert(blocked.body.decisionId, '풀 방법을 안 주면 화면은 막혔다고만 말하고 길은 명령줄에만 남습니다');
    assert(Array.isArray(blocked.body.changes) && blocked.body.changes.length, '무엇이 바뀌는지가 함께 와야 사람이 판단합니다');

    // 저장이 정말 일어나지 않았다. 이 단언이 없으면 위의 409는 화면에만 막힌
    // 시늉이고 파일은 이미 바뀐 상태일 수 있다.
    const afterBlock = await call(port, '/api/projects/crm/workflows');
    assert.strictEqual(JSON.stringify(afterBlock.body.layers), JSON.stringify(before.body.layers), '결정 없이 정책이 바뀌면 게이트가 없는 것입니다');

    // ── 연 결정을 화면이 읽는다 ─────────────────────────────────────────────
    const open = await call(port, '/api/projects/crm/decisions?open');
    assert.strictEqual(open.status, 200, open.text);
    assert(open.body.decisions.some((item) => item.decisionId === blocked.body.decisionId), '연 결정을 못 읽으면 답할 자리가 없습니다');

    // ── 사람이 답하면 같은 저장이 통과한다 ──────────────────────────────────
    const answered = await call(port, `/api/projects/crm/decisions/${blocked.body.decisionId}/answer`, {
      method: 'POST', body: JSON.stringify({ selectedOption: 'approve', answeredBy: 'MEMBER-001', reason: '검증 흐름을 세운다' })
    });
    assert.strictEqual(answered.status, 200, answered.text);
    assert.strictEqual(answered.body.decision.status, 'answered');

    const saved = await call(port, '/api/projects/crm/workflows', {
      method: 'POST', body: JSON.stringify(Object.assign({ baseRevision: before.body.baseRevision, decisionId: blocked.body.decisionId }, change))
    });
    assert.strictEqual(saved.status, 200, saved.text);
    assert.strictEqual(saved.body.bindings.task['*'], 'flow-a', '답변된 결정으로는 저장이 통과해야 합니다');

    // ── 한 번 받은 결정이 다음 저장을 열지 않는다 ───────────────────────────
    //
    // 이것이 없으면 결정은 한 번 받아 두고 그 뒤로 아무거나 저장하는 통행증이 된다.
    const latest = await call(port, '/api/projects/crm/workflows');
    const widened = Object.assign({}, flow, { nodes: Object.assign({}, flow.nodes, { waiting: { step: 'in-progress' } }) });
    const reused = await call(port, '/api/projects/crm/workflows', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'project', baseRevision: latest.body.baseRevision, decisionId: blocked.body.decisionId,
        workflows: { 'flow-a': widened }, bindings: { task: { '*': 'flow-a' } }
      })
    });
    assert.strictEqual(reused.status, 400, `다른 변경을 같은 결정으로 저장하면 안 됩니다: ${reused.status} ${reused.text}`);

    process.stdout.write('board policy tests passed\n');
  } finally {
    if (board) await new Promise((resolve) => board.server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})();
