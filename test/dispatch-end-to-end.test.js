'use strict';

// 자동 전환 큐의 종단 경로. "AI가 할 수 있다고 정의된 영역의 태스크가 사람 없이
// 런에 올라 실행되고 다음 노드로 움직이는가"에 실제 프로세스로 답한다.
//
// 두 모드를 본다. ai-first에서는 드라이버 회전이 묻지 않고 열어 몰고, 태스크가
// 움직인다. ai-assisted에서는 드라이버가 열지 않고, 제안이 목록에 서고, 에이전트
// 수락은 거절되고, 사람 수락이 기계 명의의 런을 연다.
//
// 모델은 부르지 않는다. 실행 단위는 수렴하는 cli 명령(save)이고, 배선이 도는지가
// 물음이다 — 스텁으로 돌지 않으면 실제 어댑터로도 돌지 않는다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PREVIOUS_WINDOWS_ADAPTER = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-dispatch-e2e-'));
const home = path.join(temporary, 'runtime');

function environment() {
  return Object.assign({}, process.env, { RUNDOL_HOME: home });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8', env: environment() });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdlRaw(args) {
  return spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: repository, encoding: 'utf8', env: environment() });
}

function rdl(args) {
  const result = rdlRaw(args);
  assert.strictEqual(result.status, 0, `rdl ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function taskStatus(taskId) {
  const listed = rdl(['task', 'list', '--project', 'crm']);
  const found = (listed.tasks || []).find((entry) => entry.id === taskId);
  assert(found, `태스크가 목록에 없습니다: ${taskId}\n${JSON.stringify(listed).slice(0, 500)}`);
  return found.status;
}

const projectRoot = path.join(temporary, 'projects', 'crm');

function writeProjectFile(name, value) {
  fs.writeFileSync(path.join(projectRoot, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  git(['add', name], projectRoot);
  git(['commit', '-m', `set ${name}`], projectRoot);
}

try {
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Rundol Test']);
  git(['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# dispatch e2e\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'driver-a', '--name', '무인 드라이버', '--type', 'agent', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'reviewer-1', '--name', '검토자', '--type', 'human', '--owner', 'MEMBER-001']);

  // 프로필이 요구하는 문서를 갖춘다. 수행 스텝의 save가 workspace 검증을 지나므로,
  // 필수 문서가 없으면 실행이 절차의 문제가 아니라 프로젝트의 문제로 멈춘다.
  const prd = rdl(['doc', 'create', 'PRD', '종단 큐 대상', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '자동 전환 큐가 도는지 보는 문서', '--exclude', '그 밖']);
  rdl(['doc', 'create', 'REQ', '종단 큐 요구', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '자동 전환 큐가 도는지에 대한 요구', '--exclude', '그 밖',
    '--related', prd.id, '--function-id', 'FN-001']);

  // 계약층 — 어느 전환이 기계 전용인가. todo→doing이 auto이고, 수행 단위는 몸통
  // (command·retrySafety)을 든 cli다.
  writeProjectFile('workflows.json', {
    schemaVersion: 1,
    workflows: {
      'auto-flow': {
        targetKind: 'task',
        nodes: {
          todo: { step: 'unclaimed' },
          doing: { step: 'in-progress', requiresOwner: true },
          done: { step: 'completed', validity: 'valid', requiresOwner: true },
          cancelled: { step: 'dropped', requiresOwner: true }
        },
        executionUnits: {
          'noop-save': { kind: 'cli', command: 'save', args: ['--project', '{project}'], retrySafety: { mode: 'converging' } }
        },
        transitions: [
          { from: 'todo', to: 'doing', title: '자동 착수', execution: ['noop-save'], auto: true }
        ]
      }
    },
    bindings: { task: { '*': 'auto-flow' } }
  });
  // 머신 동의 — 이 작업공간에서 무인으로 열고 몰아도 되는 기계.
  writeProjectFile('harness.json', {
    schemaVersion: 1,
    revision: 1,
    drive: { schedulerClientId: 'driver-a' }
  });
  // 조직 동의 — AI 우선: 묻지 않고 연다.
  writeProjectFile('board.json', { schemaVersion: 2, approval: { mode: 'ai-first' } });

  const first = rdl(['task', 'add', '자동 실행 대상', '--project', 'crm', '--owner', 'MEMBER-001', '--acceptance', '런이 자동으로 열리고 태스크가 움직인다']);
  assert.strictEqual(taskStatus(first.taskId), 'todo');

  // ── ai-first: 회전 1이 열고, 회전 2가 몰고, 태스크가 움직인다 ─────────────
  const opened = rdl(['run', 'driver', '--client-id', 'driver-a', '--once']);
  assert(opened.queued && opened.queued.runId, `회전이 런을 열어야 합니다: ${JSON.stringify(opened)}`);
  assert.strictEqual(opened.queued.taskId, first.taskId);
  assert.strictEqual(opened.drove, false, '여는 회전은 몰지 않는다 — 열기와 몰기는 다른 회전이다.');

  const driven = rdl(['run', 'driver', '--client-id', 'driver-a', '--once']);
  assert.strictEqual(driven.drove, true, `두 번째 회전이 몰아야 합니다: ${JSON.stringify(driven)}`);
  assert.strictEqual(driven.runId, opened.queued.runId, '연 런을 그대로 몬다.');
  assert.strictEqual(driven.advanced, true, `원장이 움직여야 합니다: ${JSON.stringify(driven)}`);

  // 완주의 정의 — 태스크가 to 노드에 서 있다. 런의 마지막 스텝(apply-transition)이
  // 이것을 했고, 사람은 아무것도 하지 않았다.
  assert.strictEqual(taskStatus(first.taskId), 'doing', '자동 전환이 적용되어야 합니다.');
  const log = rdl(['run', 'log', '--run', opened.queued.runId, '--project', 'crm']);
  const applied = log.events.find((event) => event.type === 'run.step' && event.stepId === 'apply-transition' && event.exitCode === 0);
  assert(applied, `적용이 원장의 스텝으로 남아야 합니다: ${JSON.stringify(log.events.map((event) => event.stepId || event.type))}`);

  // 다시 열지 않는다. 태스크는 이제 doing이라 어느 auto 전환 앞에도 서 있지 않다.
  const third = rdl(['run', 'driver', '--client-id', 'driver-a', '--once']);
  assert(!third.queued, `움직인 태스크를 재큐잉하면 안 됩니다: ${JSON.stringify(third.queued || null)}`);

  // ── ai-assisted: 드라이버는 열지 않고, 사람 수락이 기계 명의로 연다 ────────
  writeProjectFile('board.json', { schemaVersion: 2, approval: { mode: 'ai-assisted' } });
  const second = rdl(['task', 'add', '제안 대상', '--project', 'crm', '--owner', 'MEMBER-001', '--acceptance', '사람 수락으로 런이 열린다']);

  const held = rdl(['run', 'driver', '--client-id', 'driver-a', '--once']);
  assert(!held.queued, `혼합 모드에서 드라이버가 열면 안 됩니다: ${JSON.stringify(held.queued || null)}`);

  const listed = rdl(['run', 'dispatch', '--project', 'crm']);
  const proposal = listed.candidates.find((entry) => entry.taskId === second.taskId);
  assert(proposal, `제안이 목록에 서야 합니다: ${JSON.stringify(listed.candidates)}`);
  assert.strictEqual(proposal.initiation, 'proposed');

  // 에이전트 수락은 거절된다. 제안의 수락이 곧 큐잉이고, 그 결정은 사람의 것이다.
  const refused = rdlRaw(['run', 'dispatch', '--project', 'crm', '--task', second.taskId, '--client-id', 'driver-a']);
  assert.notStrictEqual(refused.status, 0, '에이전트 수락이 막히지 않았습니다');
  assert.match(`${refused.stdout}${refused.stderr}`, /human 클라이언트만/u, `${refused.stdout}${refused.stderr}`);

  // 사람이 수락하면 런은 기계 명의로 열린다 — human은 실행 명령을 수행할 수 없고
  // 소유자만 몰 수 있으므로, 사람 명의로 열면 아무도 못 모는 런이 된다.
  const accepted = rdl(['run', 'dispatch', '--project', 'crm', '--task', second.taskId, '--client-id', 'reviewer-1']);
  assert(accepted.runId, `수락이 런을 열어야 합니다: ${JSON.stringify(accepted)}`);

  const acceptedDriven = rdl(['run', 'driver', '--client-id', 'driver-a', '--once']);
  assert.strictEqual(acceptedDriven.drove, true, `수락된 런을 드라이버가 몰아야 합니다: ${JSON.stringify(acceptedDriven)}`);
  assert.strictEqual(taskStatus(second.taskId), 'doing', '수락된 제안도 완주하면 태스크가 움직인다.');

  // ── human-only: 큐가 서지 않는다. 제안조차 없다 ────────────────────────────
  writeProjectFile('board.json', { schemaVersion: 2, approval: { mode: 'human-only' } });
  rdl(['task', 'add', '사람만 대상', '--project', 'crm', '--owner', 'MEMBER-001', '--acceptance', '큐가 서지 않는다']);
  const silent = rdl(['run', 'dispatch', '--project', 'crm']);
  assert.deepStrictEqual(silent.candidates, [], `사람만 모드에서는 후보가 없어야 합니다: ${JSON.stringify(silent.candidates)}`);

  console.log('dispatch end-to-end: ok');
} finally {
  if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
  fs.rmSync(temporary, { recursive: true, force: true });
}
