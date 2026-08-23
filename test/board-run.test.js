'use strict';

// TST-039. 사람 게이트를 웹에서 지나는 표면을 검증한다.
//
// 이 스위트가 지켜야 하는 것은 두 가지다. 조회가 원장을 바꾸지 않는다는 것과, 승인이
// 명령줄과 똑같은 자격 판정 위에 선다는 것. 두 번째가 무너지면 게이트는 남아 있어도
// 높이가 표면마다 달라지고, 그때 실제 높이는 가장 낮은 표면이 정한다.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createBoardServer } = require('../src/board');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-board-run-'));
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-board-run-runtime-'));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: runtimeHome }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  const output = command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository);
  return output ? JSON.parse(output) : null;
}

function request(port, pathname, options) {
  const settings = Object.assign({ method: 'GET', headers: {} }, options || {});
  return new Promise((resolve, reject) => {
    // agent: false는 board.test.js와 같은 이유다. keep-alive 소켓이 서버의 유휴
    // 타임아웃 뒤에 재사용되면 부하가 걸린 전체 실행에서만 ECONNRESET으로 터진다.
    const call = http.request({ hostname: '127.0.0.1', port, path: pathname, method: settings.method, headers: settings.headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    call.on('error', (error) => reject(new Error(`${settings.method} ${pathname} 실패: ${error.code || error.message}`)));
    if (settings.body) call.write(settings.body);
    call.end();
  });
}

function post(port, pathname, body, headers) {
  const payload = JSON.stringify(body);
  return request(port, pathname, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers || {}),
    body: payload
  });
}

// 원장이 움직였는지는 파일 내용으로 판정한다. 이벤트 개수만 세면 같은 개수로 덮어쓰는
// 경로를 놓치고, fold 결과만 보면 읽기 경로의 버그가 쓰기의 부재로 읽힌다.
function ledgerSnapshot() {
  const roots = [
    path.join(temporary, 'projects', 'crm', '.rundol', 'runs'),
    path.join(temporary, 'projects', 'workspace', 'events')
  ];
  const files = {};
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        files[path.relative(temporary, full).replace(/\\/gu, '/')] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  return JSON.stringify(files);
}

async function testBoardRuns() {
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Board Run Test'], temporary);
  command('git', ['config', 'user.email', 'board-run@example.invalid'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Board run fixture\n', 'utf8');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  rdl(['init', 'crm', '--name', 'CRM', '--defaults']);
  rdl(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'device-a', '--name', 'Device A', '--type', 'device', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'reviewer-a', '--name', '검토자', '--type', 'human', '--owner', 'MEMBER-001']);
  // 이 프로젝트의 활성 멤버가 아닌 사람이 소유한 human Client. 유형만으로 승인을
  // 허용하면 이것이 지나가고, 그때 게이트는 "사람이면 된다"가 된다.
  rdl(['client', 'register', 'stranger-a', '--name', '외부 검토자', '--type', 'human', '--owner', 'MEMBER-404']);

  const project = path.join(temporary, 'projects', 'crm');
  fs.writeFileSync(path.join(project, 'procedures.json'), `${JSON.stringify({
    schemaVersion: 1,
    procedures: {
      'board.fixture': { revision: 1, targetKind: 'document', steps: [{ id: 'approval', human: true }, { id: 'author', executor: 'client' }] }
    }
  }, null, 2)}\n`, 'utf8');
  command('git', ['add', 'procedures.json'], project);
  command('git', ['commit', '-m', 'add board run fixture'], project);

  const artifact = rdl(['doc', 'create', 'PRD', '승인 대상 문서', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '승인 화면이 보여 줄 본문', '--exclude', '구현 상세']);
  const started = rdl(['run', 'start', 'board.fixture', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', artifact.id]);
  const runId = started.runId;

  const board = createBoardServer(temporary, { token: 'board-run-token' });
  await new Promise((resolve, reject) => {
    board.server.once('error', reject);
    board.server.listen(0, '127.0.0.1', resolve);
  });
  const port = board.server.address().port;
  const approvePath = `/api/projects/crm/runs/${runId}/approve`;
  try {
    // BOP-03-S01. 사람 게이트에서 멈춘 런이 대기 갈래에 사유와 함께 나온다.
    const before = ledgerSnapshot();
    const listed = await request(port, '/api/projects/crm/runs');
    assert.strictEqual(listed.status, 200, listed.body);
    const runs = JSON.parse(listed.body);
    const waiting = runs.waiting.find((item) => item.runId === runId);
    assert(waiting, `사람 게이트에서 멈춘 런이 대기 갈래에 없습니다: ${listed.body}`);
    assert.strictEqual(waiting.reason, 'human-gate');
    assert.strictEqual(waiting.cursor, 'approval');
    assert.strictEqual(waiting.procedure, 'board.fixture');

    // BOP-03-S10. 승인자로 제시되는 것은 활성 human Client뿐이고, 그 owner가 이
    // 프로젝트의 활성 멤버여야 한다. 기기·에이전트 신원은 여기에 없다.
    assert.deepStrictEqual(runs.approvers.map((client) => client.id), ['reviewer-a']);

    // BOP-03-S02. 조회는 원장을 바꾸지 않는다. 화면이 같은 물음을 되풀이해 던지므로
    // 여기서 한 바이트라도 움직이면 보고 있는 것만으로 상태가 흐른다.
    await request(port, '/api/projects/crm/runs');
    assert.strictEqual(ledgerSnapshot(), before, '조회가 런 원장을 바꿨습니다');

    // BOP-03-S08. 토큰 없는 변경은 본문을 적용하기 전에 막힌다.
    const untokened = await post(port, approvePath, { clientId: 'reviewer-a', reason: '검토했습니다' });
    assert.strictEqual(untokened.status, 403, untokened.body);
    assert.strictEqual(ledgerSnapshot(), before, '토큰 없는 요청이 원장을 바꿨습니다');

    const token = { 'X-Rundol-Token': 'board-run-token' };

    // BOP-03-S05. 사유 없는 승인은 거부한다. 무엇을 보고 승인했는지가 없는 승인은
    // 나중에 "AI 검토가 놓쳤나 사람이 건너뛰었나"에 답할 수 없다.
    const reasonless = await post(port, approvePath, { clientId: 'reviewer-a', reason: '   ' }, token);
    assert.strictEqual(reasonless.status, 400, reasonless.body);
    assert.strictEqual(JSON.parse(reasonless.body).code, 'missing-reason');
    assert.strictEqual(ledgerSnapshot(), before, '사유 없는 요청이 원장을 바꿨습니다');

    // 승인자를 고르지 않은 요청도 같은 자리에서 막힌다.
    const nameless = await post(port, approvePath, { reason: '검토했습니다' }, token);
    assert.strictEqual(nameless.status, 400, nameless.body);
    assert.strictEqual(JSON.parse(nameless.body).code, 'missing-approver');

    // BOP-03-S04. human이 아닌 자격은 거부한다. 이 판정은 rdl run approve와 같은
    // 함수가 내리므로, 표면이 늘어도 게이트 높이는 하나로 남는다.
    const device = await post(port, approvePath, { clientId: 'device-a', reason: '기기로 승인' }, token);
    assert.notStrictEqual(device.status, 200);
    assert(JSON.parse(device.body).error.includes('유형(device)'), device.body);
    assert.strictEqual(ledgerSnapshot(), before, 'device 자격 요청이 원장을 바꿨습니다');

    // BOP-03-S06. 유형이 human이어도 이 프로젝트의 활성 멤버가 아니면 거부한다.
    const stranger = await post(port, approvePath, { clientId: 'stranger-a', reason: '외부에서 승인' }, token);
    assert.notStrictEqual(stranger.status, 200);
    assert.strictEqual(ledgerSnapshot(), before, '비멤버 요청이 원장을 바꿨습니다');

    // BOP-03-S09. 하네스가 띄운 Board는 조회는 하고 승인은 하지 않는다. human 자격을
    // 하네스가 들 수 없다는 것이 사람 게이트의 전부이므로, 이 표면이 그 자격을
    // 빌려주면 게이트는 이름만 남는다.
    const previousHarness = process.env.RUNDOL_HARNESS_CHILD;
    process.env.RUNDOL_HARNESS_CHILD = '1';
    try {
      const harnessListed = await request(port, '/api/projects/crm/runs');
      assert.strictEqual(harnessListed.status, 200, harnessListed.body);
      const harnessApproval = await post(port, approvePath, { clientId: 'reviewer-a', reason: '하네스가 승인' }, token);
      assert.strictEqual(harnessApproval.status, 403, harnessApproval.body);
      assert.strictEqual(JSON.parse(harnessApproval.body).code, 'harness-board');
    } finally {
      if (previousHarness === undefined) delete process.env.RUNDOL_HARNESS_CHILD;
      else process.env.RUNDOL_HARNESS_CHILD = previousHarness;
    }
    assert.strictEqual(ledgerSnapshot(), before, '하네스 표시 아래의 요청이 원장을 바꿨습니다');

    // BOP-03-S11. 승인 화면이 읽는 내막. 무엇을 승인하는지가 여기서 나오지 않으면
    // 사람은 런 ID만 보고 누르게 되고, 그 승인은 "읽었다"의 증거가 되지 못한다.
    const detailResponse = await request(port, `/api/projects/crm/runs/${runId}`);
    assert.strictEqual(detailResponse.status, 200, detailResponse.body);
    const detail = JSON.parse(detailResponse.body);
    assert.strictEqual(detail.cursor, 'approval');
    assert.strictEqual(detail.cursorStep.human, true);
    assert.deepStrictEqual(detail.artifactIds, [artifact.id], detailResponse.body);
    assert.deepStrictEqual(detail.trail.map((entry) => entry.type), ['run.started']);
    assert.deepStrictEqual(detail.approvers.map((client) => client.id), ['reviewer-a']);

    // BOP-03-S12. 살펴보는 것도 원장을 바꾸지 않는다. 승인하려고 열어 본 것이 상태를
    // 바꾸면 살펴보기와 승인의 경계가 사라진다.
    await request(port, `/api/projects/crm/runs/${runId}`);
    assert.strictEqual(ledgerSnapshot(), before, '내막 조회가 런 원장을 바꿨습니다');

    // BOP-03-S13. 없는 런은 없다고 답한다.
    const missing = await request(port, '/api/projects/crm/runs/RUN-00000000000000000000');
    assert.strictEqual(missing.status, 404, missing.body);

    // BOP-03-S03. 자격과 사유를 갖춘 승인만 기록되고 커서가 전진한다.
    const approved = await post(port, approvePath, { clientId: 'reviewer-a', reason: '초안을 읽고 책임집니다' }, token);
    assert.strictEqual(approved.status, 200, approved.body);
    const result = JSON.parse(approved.body);
    assert.strictEqual(result.stepId, 'approval');
    assert.strictEqual(result.approvedBy, 'reviewer-a');
    assert.strictEqual(result.approved, true);
    assert.notStrictEqual(ledgerSnapshot(), before, '승인이 원장에 남지 않았습니다');

    const afterApproval = ledgerSnapshot();
    const relisted = JSON.parse((await request(port, '/api/projects/crm/runs')).body);
    assert.strictEqual(relisted.waiting.find((item) => item.runId === runId), undefined, '승인한 런이 여전히 사람을 기다립니다');
    assert(relisted.drivable.find((item) => item.runId === runId), '승인 뒤에는 이어서 몰 수 있어야 합니다');

    // BOP-03-S07. 사람 게이트가 아닌 스텝은 승인으로 지날 수 없다. 승인을 "막힌 것을
    // 미는 단추"로 쓰면 원장은 "사람이 무엇을 승인했는가"에 답하지 못하게 된다.
    const nonGate = await post(port, approvePath, { clientId: 'reviewer-a', reason: '한 번 더' }, token);
    assert.notStrictEqual(nonGate.status, 200);
    assert.strictEqual(ledgerSnapshot(), afterApproval, '사람 게이트가 아닌 스텝의 승인 시도가 원장을 바꿨습니다');
  } finally {
    await new Promise((resolve) => board.server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
  process.stdout.write('board run tests passed\n');
}

module.exports = testBoardRuns();
