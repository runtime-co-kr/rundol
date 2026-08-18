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
  const driven = rdlRaw(['run', 'drive', '--run', started.runId, '--project', 'crm', '--client-id', 'agent-a'],
    { RUNDOL_STUB_ARTIFACT: document.id, RUNDOL_STUB_VERDICT: 'pass' });
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

  process.stdout.write('drive end-to-end tests passed\n');
} finally {
  if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
