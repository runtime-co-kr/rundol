'use strict';

// 종단 경로가 실제로 도는가. 지금까지 이 물음에 답한 적이 없다.
//
// 내장 절차는 오래 idempotent: false였고 그래서 drive 진입 자체가 거부됐다.
// 진입을 열어도 그것은 "들어갈 수 있다"일 뿐 "완주한다"가 아니다. 이 시험은
// 완주를 본다 — author → mech-gate → verify → save → 사람 앞에서 정지.
//
// 모델은 부르지 않는다. 배선이 도는지와 렌즈가 판별하는지는 다른 물음이고,
// 전자는 스텁으로 증명된다. 스텁으로 돌지 않으면 실제 어댑터로도 돌지 않는다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 이 스위트는 실제 자식 프로세스를 띄운다. Windows 기본 차단을 여기서만 켜고
// 끝날 때 되돌린다.
const PREVIOUS_WINDOWS_ADAPTER = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const stub = path.join(__dirname, 'fixtures', 'stub-adapter.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-drive-e2e-'));
const home = path.join(temporary, 'runtime');

function environment(extra) {
  return Object.assign({}, process.env, { RUNDOL_HOME: home }, extra || {});
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8', env: environment() });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdlRaw(args, extra) {
  return spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: repository, encoding: 'utf8', env: environment(extra) });
}

function rdl(args, extra) {
  const result = rdlRaw(args, extra);
  assert.strictEqual(result.status, 0, `rdl ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

try {
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Rundol Test']);
  git(['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# e2e\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  // 공유 차단을 보려면 나갈 곳이 있어야 한다. 원격이 없으면 sync는 차단에 닿기 전에
  // 원격 부재로 먼저 끝난다 — 막힌 것이 무엇인지 시험이 구분하지 못한다.
  const remote = path.join(temporary, 'origin.git');
  fs.mkdirSync(remote, { recursive: true });
  git(['init', '--bare'], remote);
  git(['remote', 'add', 'origin', remote]);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', '저작 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);

  // 무엇을 만들 것인가는 사람이 정한다. 절차는 이미 있는 문서를 다룬다.
  const document = rdl(['doc', 'create', 'PRD', '종단 검증 대상', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '종단 경로가 도는지 보는 문서', '--exclude', '그 밖']);

  // 프로필이 요구하는 문서를 갖춘다. save가 workspace 검증을 지나므로, 필수
  // 문서가 없으면 저장 스텝에서 멈춘다 — 절차의 문제가 아니라 프로젝트의 문제다.
  rdl(['doc', 'create', 'REQ', '종단 검증 요구', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '종단 경로가 도는지에 대한 요구', '--exclude', '그 밖',
    '--related', document.id, '--function-id', 'E2E-01']);

  const projectRoot = path.join(temporary, 'projects', 'crm');
  // 스텁의 행동은 파일로 시킨다. 환경 변수는 어댑터 경계를 넘지 못한다 — 하네스가
  // 닫힌 allowlist만 자식에게 넘기기 때문이다. 그것을 모르고 환경으로 시키면 스텁은
  // 조용히 기본값으로 돌고, 시험은 자기가 무엇을 시켰는지 모르는 채 통과한다.
  function stubControl(value) {
    const directory = path.join(projectRoot, '.rundol');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'stub-control.json'), `${JSON.stringify(value)}\n`, 'utf8');
  }
  fs.writeFileSync(path.join(projectRoot, 'harness.json'), `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    adapters: { stub: { enabled: true, command: process.execPath, argsTemplate: [stub, '{instruction}', '{context}', '{result}'], timeoutSeconds: 30 } },
    verify: { defaultAdapter: 'stub', defaultLenses: ['satisfaction-v1'] }
  }, null, 2)}\n`, 'utf8');
  git(['add', '.'], projectRoot);
  git(['commit', '-m', 'add stub adapter'], projectRoot);

  const started = rdl(['run', 'start', 'document.verified', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', document.id]);
  assert(started.runId, `런이 시작되지 않았습니다: ${JSON.stringify(started)}`);

  // drive는 멈출 자리에 닿을 때까지 자율로 돈다. 어디서 멈추는지가 이 시험의 답이다.
  stubControl({ artifactId: document.id, verdict: 'pass' });
  const driven = rdlRaw(['run', 'drive', '--run', started.runId, '--project', 'crm', '--client-id', 'agent-a']);
  const outcome = driven.stdout ? JSON.parse(driven.stdout) : { status: 'no-output', stderr: driven.stderr };

  const log = rdl(['run', 'log', '--run', started.runId, '--project', 'crm']);
  const reached = log.events.filter((event) => ['run.step', 'run.gate'].includes(event.type)).map((event) => `${event.stepId}:${event.exitCode}`);

  // 완주의 정의: 사람 스텝 앞에서 멈춘다. 그 전 스텝이 전부 지나갔다는 뜻이다.
  assert.strictEqual(outcome.status, 'waiting_human',
    `사람 스텝 앞에서 멈춰야 합니다. 실제: ${JSON.stringify(outcome)}\n지나간 스텝: ${reached.join(' → ') || '(없음)'}`);
  assert.strictEqual(outcome.step, 'sync-gate', `멈춘 자리가 sync-gate여야 합니다: ${JSON.stringify(outcome)}`);
  for (const stepId of ['mech-gate', 'verify', 'save']) {
    assert(reached.some((entry) => entry.startsWith(`${stepId}:`)), `${stepId}을 지나지 않았습니다: ${reached.join(' → ')}`);
  }

  // 검증이 무엇을 봤는가. 저장이 자기 커밋을 원장에 남기지 않았다면 검증은 결박될
  // 곳이 없고, 그 자리는 조용히 "지금 HEAD"로 채워진다 — 그 사이 다른 프로세스가
  // 커밋하면 저작 결과가 아닌 것이 판정된다. 이 값이 있어야 그 창이 닫힌다.
  const saveEvent = log.events.filter((event) => event.type === 'run.step' && event.stepId === 'save' && event.exitCode === 0).pop();
  assert(saveEvent, '저장 스텝이 기록되지 않았습니다');
  assert.match(String(saveEvent.commit || ''), /^[a-f0-9]{40}$/u, `저장은 자기 커밋을 남겨야 합니다: ${JSON.stringify(saveEvent)}`);

  // 사람 게이트를 지나기 전에는 공유되지 않는다. 이것이 지켜지지 않으면 "검증되지
  // 않은 내용은 이 기계를 벗어나지 않는다"는 말은 성립하지 않는다.
  const blocked = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  assert.notStrictEqual(blocked.status, 0, 'sync가 막히지 않았습니다');
  assert.match(`${blocked.stdout}${blocked.stderr}`, /RDL-SYNC-030/u,
    `사람 게이트 전 공유는 RDL-SYNC-030으로 막혀야 합니다: ${blocked.stdout}${blocked.stderr}`);

  // 하네스가 띄운 자식은 사람 게이트를 스스로 지나갈 수 없다. 난간이지 경계는
  // 아니다 — 표시를 지운 자식은 통과하고, 그것은 위의 공유 차단이 잡는다.
  const selfApproved = rdlRaw(['run', 'step', '--run', started.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', '에이전트 자가 승인'],
    { RUNDOL_HARNESS_CHILD: '1' });
  assert.notStrictEqual(selfApproved.status, 0, '하네스 자식의 사람 게이트 자가 승인이 막히지 않았습니다');
  assert.match(`${selfApproved.stdout}${selfApproved.stderr}`, /스스로 승인할 수 없습니다/u,
    `${selfApproved.stdout}${selfApproved.stderr}`);

  // --force로 지나간 사람 게이트는 통과가 아니다. 런이 로컬 완료가 되어도 공유는
  // 여전히 막힌다 — 사람이 승인했다는 근거가 원장에 없기 때문이다.
  rdl(['run', 'step', '--run', started.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', '시험 픽스처의 사람 승인']);
  rdl(['run', 'complete', '--run', started.runId, '--project', 'crm', '--client-id', 'agent-a']);
  const stillBlocked = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  assert.notStrictEqual(stillBlocked.status, 0, 'forced 사람 게이트의 런이 공유를 막지 않았습니다');
  assert.match(`${stillBlocked.stdout}${stillBlocked.stderr}`, /RDL-SYNC-030/u,
    `${stillBlocked.stdout}${stillBlocked.stderr}`);

  // 우회는 있지만 사유를 말해야 하고, 매번 다시 말해야 한다. 여기서는 원격이
  // 없으므로 뒤에서 실패하지만, 그 실패가 RDL-SYNC-030이 아니어야 한다.
  const forcedShare = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a', '--share-unverified', '시험이라 원격 없이 공유를 시도한다']);
  assert.doesNotMatch(`${forcedShare.stdout}${forcedShare.stderr}`, /RDL-SYNC-030/u,
    `--share-unverified가 예선 검사를 지나지 못했습니다: ${forcedShare.stdout}${forcedShare.stderr}`);

  // 저작은 자기 대상만 쓴다. 대상 밖에 쓰면 그 시도는 거부되고, 쓴 것은 저장에
  // 실리지 않는다 — 실리면 문서 한 편의 권한이 프로젝트 전체 쓰기가 된다.
  const strayRun = rdl(['run', 'start', 'document.verified', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', document.id]);
  stubControl({ artifactId: document.id, verdict: 'pass', stray: 'docs/STRAY.md' });
  const strayDrive = rdlRaw(['run', 'drive', '--run', strayRun.runId, '--project', 'crm', '--client-id', 'agent-a']);
  const strayOutcome = strayDrive.stdout ? JSON.parse(strayDrive.stdout) : { status: 'no-output', stderr: strayDrive.stderr };
  // 멈췄다는 것만으로는 부족하다. 저장이 다른 이유로 실패해도 멈추기 때문이다 —
  // 무엇이 막았는지를 묻지 않으면 이 시험은 엉뚱한 이유로 통과한다.
  assert.notStrictEqual(strayOutcome.status, 'waiting_human', `대상 밖에 쓴 저작이 완주했습니다: ${JSON.stringify(strayOutcome)}`);
  assert.match(String(strayOutcome.detail || ''), /outside its target/u,
    `막은 이유가 대상 밖 변경이어야 합니다: ${JSON.stringify(strayOutcome)}`);
  const strayLog = rdl(['run', 'log', '--run', strayRun.runId, '--project', 'crm']);
  assert(!strayLog.events.some((event) => event.type === 'run.step' && event.exitCode === 0),
    '거부된 저작이 진행으로 기록됐습니다');
  assert.strictEqual(git(['log', '-1', '--name-only', '--format='], projectRoot).includes('STRAY.md'), false,
    '대상 밖 파일이 커밋됐습니다');

  process.stdout.write('drive end-to-end tests passed\n');
} finally {
  if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
