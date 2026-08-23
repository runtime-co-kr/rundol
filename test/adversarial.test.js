'use strict';

// 적대적 시험. 정상 경로가 도는지가 아니라, 원장에 손댄 클라이언트가 무엇을 얻는지
// 묻는다.
//
// 이 묶음이 필요한 이유는 기록해 둘 만하다. 11회의 외부 검증이 매번 실질 결함을
// 찾는 동안 내부 게이트는 한 번도 그것을 미리 잡지 못했다. 차이는 능력이 아니라
// 질문이었다 — 게이트는 "이 경로가 도는가"를 물었고 검증자는 "이것을 공격하면
// 무엇이 되는가"를 물었다. 그 질문을 게이트 안으로 옮긴다.
//
// 여기서 다루는 공격은 전부 쓰기 경로를 지나오지 않는다. git 병합으로 들어온 남의
// 이벤트가 정확히 그런 처지이므로, 이것은 가상의 위협이 아니라 이 시스템의 일상이다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ledger = require('../src/run-ledger');
const eventStore = require('../src/event-store');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-adversarial-'));
const home = path.join(temporary, 'runtime');

// 이 스위트는 실제 자식 프로세스를 띄운다. Windows 기본 차단을 여기서만 켜고
// 끝날 때 되돌린다 2014 켜는 것과 켠 채로 두는 것은 다른 일이다.
const PREVIOUS_WINDOWS_ADAPTER = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdlRaw(args) {
  return spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), {
    cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home })
  });
}

function rdl(args) {
  const result = rdlRaw(args);
  assert.strictEqual(result.status, 0, `rdl ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

// 공유 샤드에 이벤트를 직접 써 넣는다. CLI를 지나오지 않으므로 쓰기 경로의 검사는
// 전부 건너뛴다 — 접기와 그 소비자만이 이것을 판정할 수 있다.
function injectShared(runId, event) {
  const { workspaceLayout } = require('../src/workspace');
  const layout = workspaceLayout(temporary);
  eventStore.appendEvent(path.join(layout.root, 'projects', 'workspace', 'events'), 'run', 'crm', event.clientId,
    ledger.createEventEnvelope(event).shared, { runId, lockDirectory: path.join(temporary, '.adv-locks') });
}

try {
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Rundol Test']);
  git(['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# adversarial\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  const remote = path.join(temporary, 'origin.git');
  fs.mkdirSync(remote, { recursive: true });
  git(['init', '--bare'], remote);
  git(['remote', 'add', 'origin', remote]);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', '실행 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'reviewer-1', '--name', '검토자', '--type', 'human', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'retired-1', '--name', '퇴사한 검토자', '--type', 'human', '--owner', 'MEMBER-001']);
  const document = rdl(['doc', 'create', 'PRD', '적대 시험 대상', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '적대 시험이 다루는 문서', '--exclude', '그 밖']);
  rdl(['doc', 'create', 'REQ', '적대 시험 요구', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '적대 시험 요구', '--exclude', '그 밖', '--related', document.id, '--function-id', 'FN-001']);
  const projectRoot = path.join(temporary, 'projects', 'crm');
  // 승인 검사를 보려면 런이 실제로 커밋을 만들어야 한다. 커밋이 없는 런은 공유할
  // 것도 없으므로 애초에 막히지 않고, 그러면 이 시험은 승인에 대해 아무것도 묻지
  // 못한다. 스텁 어댑터로 저장까지 몰고 간다.
  const stub = path.join(__dirname, 'fixtures', 'stub-adapter.js');
  fs.writeFileSync(path.join(projectRoot, 'harness.json'), `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    adapters: { stub: { enabled: true, command: process.execPath, argsTemplate: [stub, '{instruction}', '{context}', '{result}'], timeoutSeconds: 30 } },
    verify: { defaultAdapter: 'stub', defaultLenses: ['satisfaction-v1'] }
  }, null, 2)}\n`, 'utf8');
  fs.mkdirSync(path.join(projectRoot, '.rundol'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.rundol', 'stub-control.json'), `${JSON.stringify({ artifactId: document.id, verdict: 'pass' })}\n`, 'utf8');
  git(['add', '.'], projectRoot);
  git(['commit', '-m', 'add stub adapter'], projectRoot);

  // 사람 게이트 앞까지 몰고 간 런 하나를 만든다.
  function drivenRun() {
    const run = rdl(['run', 'start', 'document.verified', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', document.id]);
    const driven = rdlRaw(['run', 'drive', '--run', run.runId, '--project', 'crm', '--client-id', 'agent-a']);
    const outcome = driven.stdout ? JSON.parse(driven.stdout) : { status: 'no-output', stderr: driven.stderr };
    assert.strictEqual(outcome.status, 'waiting_human', `런을 사람 게이트까지 몰지 못했습니다: ${JSON.stringify(outcome)}`);
    const started = rdl(['run', 'log', '--run', run.runId, '--project', 'crm']).events.find((event) => event.type === 'run.started');
    return { runId: run.runId, started };
  }

  // 런은 먼저 전부 몰아 둔다. 주입된 나쁜 이벤트는 workspace 검증을 실패시키고,
  // 그러면 뒤따르는 런의 save가 멈춘다 — 그것은 옳은 동작이지만, 한 워크스페이스
  // 안에서 여러 공격을 보려면 오염 이전에 재료를 다 만들어 두어야 한다.
  const disabledDriven = drivenRun();
  const ghostDriven = drivenRun();
  const tampered0 = drivenRun();
  const victimRun = drivenRun();

  // ── 1. 비활성 human Client의 승인 ────────────────────────────────────────
  //
  // 자격을 한 번 받았다는 것과 지금 그 자격이 살아 있다는 것은 다르다. 퇴사한
  // 검토자의 Client로 승인이 통과하면, 자격 회수라는 조치 자체가 무의미해진다.
  rdl(['client', 'disable', 'retired-1']);
  const disabledRun = { runId: disabledDriven.runId };
  const disabledApprove = rdlRaw(['run', 'approve', '--run', disabledRun.runId, '--project', 'crm', '--client-id', 'retired-1', '--reason', '퇴사자가 승인한다']);
  assert.notStrictEqual(disabledApprove.status, 0, '비활성 human Client의 승인이 통과했습니다');
  assert.match(`${disabledApprove.stdout}${disabledApprove.stderr}`, /비활성/u, `${disabledApprove.stdout}${disabledApprove.stderr}`);

  // 접기와 공유도 같은 답을 내야 한다. 쓰기 경로만 막으면 병합으로 들어온 같은
  // 이벤트가 그대로 통한다.
  const started = disabledDriven.started;
  const head = git(['rev-parse', 'HEAD'], projectRoot).toLowerCase();
  injectShared(disabledRun.runId, {
    schemaVersion: started.schemaVersion, eventId: 'EVT-0000000000000000AD01', type: 'run.forced',
    rootRequestId: 'REQ-0000000000000000AD01', requestId: 'REQ-0000000000000000AD02',
    clientId: 'retired-1', projectId: 'crm', runId: disabledRun.runId, ownerToken: started.ownerToken,
    stepId: 'sync-gate', reason: '병합으로 들어온 퇴사자 승인', basis: 'human-approval', commit: head
  });
  const disabledSync = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  assert.notStrictEqual(disabledSync.status, 0, '비활성 승인자의 런이 공유를 통과했습니다');
  assert(`${disabledSync.stdout}${disabledSync.stderr}`.includes(disabledRun.runId),
    `비활성 승인자의 런이 차단 대상으로 지목되지 않았습니다:\n${disabledSync.stdout}${disabledSync.stderr}`);

  // ── 2. 등록되지 않은 승인자 ──────────────────────────────────────────────
  //
  // registry에 없는 이름으로 승인하면, 신원 대조는 "모른다"로 끝나야 하고
  // 모르는 승인은 승인이 아니다.
  const ghostRun = { runId: ghostDriven.runId };
  const ghostStart = ghostDriven.started;
  injectShared(ghostRun.runId, {
    schemaVersion: ghostStart.schemaVersion, eventId: 'EVT-0000000000000000AD11', type: 'run.forced',
    rootRequestId: 'REQ-0000000000000000AD11', requestId: 'REQ-0000000000000000AD12',
    clientId: 'agent-a', projectId: 'crm', runId: ghostRun.runId, ownerToken: ghostStart.ownerToken,
    stepId: 'sync-gate', reason: '존재하지 않는 승인자', basis: 'human-approval', commit: head
  });
  const ghostSync = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  assert.notStrictEqual(ghostSync.status, 0, '등록되지 않은 승인자의 런이 공유를 통과했습니다');

  // ── 3. 승인 이벤트 사후 변조 ─────────────────────────────────────────────
  //
  // 이미 기록된 승인의 커밋만 바꿔치기하면, 승인은 자기가 본 적 없는 상태를
  // 승인한 것이 된다. canonicalDigest가 그것을 덮어야 한다.
  const tamperedRun = { runId: tampered0.runId };
  const tamperedStart = tampered0.started;
  const approval = ledger.createEventEnvelope({
    schemaVersion: tamperedStart.schemaVersion, eventId: 'EVT-0000000000000000AD21', type: 'run.forced',
    rootRequestId: 'REQ-0000000000000000AD21', requestId: 'REQ-0000000000000000AD22',
    clientId: 'reviewer-1', projectId: 'crm', runId: tamperedRun.runId, ownerToken: tamperedStart.ownerToken,
    stepId: 'sync-gate', reason: '정상 승인', basis: 'human-approval', commit: head
  }).shared;
  const { workspaceLayout } = require('../src/workspace');
  const shardRoot = path.join(workspaceLayout(temporary).root, 'projects', 'workspace', 'events', 'run');
  eventStore.appendEvent(path.join(workspaceLayout(temporary).root, 'projects', 'workspace', 'events'), 'run', 'crm', 'reviewer-1',
    approval, { runId: tamperedRun.runId, lockDirectory: path.join(temporary, '.adv-locks') });
  const shardName = fs.readdirSync(shardRoot).find((name) => name.includes(tamperedRun.runId) && name.includes('reviewer-1'));
  assert(shardName, `변조 대상 샤드를 찾지 못했습니다: ${fs.readdirSync(shardRoot).join(', ')}`);
  const shardFile = path.join(shardRoot, shardName);
  const tampered = fs.readFileSync(shardFile, 'utf8').replace(head, 'f'.repeat(40));
  assert.notStrictEqual(tampered, fs.readFileSync(shardFile, 'utf8'), '변조가 실제로 일어나지 않았다면 이 시험은 아무것도 증명하지 않습니다');
  fs.writeFileSync(shardFile, tampered, 'utf8');
  const audit = rdlRaw(['check', '--strict']);
  assert(/RDL-RUN-033/u.test(audit.stdout), `사후 변조가 진단되지 않았습니다:\n${audit.stdout}`);

  // ── 4. 변조된 원장 위에서는 공유가 멈춘다 ────────────────────────────────
  //
  // 변조가 진단으로 남는 것과 그 위에서 일이 계속 진행되는 것은 다르다. 다이제스트가
  // 맞지 않는 이벤트를 하나라도 안고 있는 런은 무엇이 사실인지 말할 수 없으므로,
  // 그 상태에서 공유를 진행하면 하네스는 자기가 무엇을 내보내는지 모른다.
  const tamperedSync = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  assert.notStrictEqual(tamperedSync.status, 0, '변조된 원장 위에서 공유가 진행됐습니다');
  assert.match(`${tamperedSync.stdout}${tamperedSync.stderr}`, /canonicalDigest|RDL-RUN-0(17|33)/u,
    `변조가 공유를 멈추지 못했습니다:\n${tamperedSync.stdout}${tamperedSync.stderr}`);

  process.stdout.write('adversarial tests passed\n');
} finally {
  if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
