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
  // 승인은 실행 주체가 할 수 없다. 런을 모는 자격과 그것을 승인하는 자격이 같으면
  // 사람 게이트는 이름만 남는다.
  rdl(['client', 'register', 'reviewer-1', '--name', '검토자', '--type', 'human', '--owner', 'MEMBER-001']);

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

  // 실행 주체는 승인할 수 없다. 환경 표시가 아니라 자격으로 막는다 — 환경 표시는
  // 자식이 지울 수 있지만, agent 자격으로 승인 명령을 실행하는 것은 지울 수 없다.
  const selfApproved = rdlRaw(['run', 'approve', '--run', started.runId, '--project', 'crm', '--client-id', 'agent-a', '--reason', '에이전트 자가 승인']);
  assert.notStrictEqual(selfApproved.status, 0, 'agent Client의 자가 승인이 막히지 않았습니다');
  assert.match(`${selfApproved.stdout}${selfApproved.stderr}`, /유형\(agent\)/u, `${selfApproved.stdout}${selfApproved.stderr}`);

  // 거꾸로도 막힌다. human 자격으로는 자동 실행 명령을 수행할 수 없다 — 그래야
  // 하네스가 이 자격을 들고 자기를 승인하는 길이 닫힌다.
  const humanDrive = rdlRaw(['run', 'drive', '--run', started.runId, '--project', 'crm', '--client-id', 'reviewer-1']);
  assert.notStrictEqual(humanDrive.status, 0, 'human Client의 자동 실행이 막히지 않았습니다');
  assert.match(`${humanDrive.stdout}${humanDrive.stderr}`, /실행 명령을 수행할 수 없습니다/u,
    `${humanDrive.stdout}${humanDrive.stderr}`);

  // 승인은 상태에 붙는다. 검증이 본 커밋과 지금 HEAD가 다르면 승인할 수 없다 —
  // 그 상태는 판정된 적이 없기 때문이다. 이것이 없으면 "검증 A가 통과한 뒤 HEAD가
  // B로 바뀌어도 완료와 공유는 B를 내보낸다"가 성립한다.
  git(['commit', '--allow-empty', '-m', '런과 무관한 커밋'], projectRoot);
  const drifted = rdlRaw(['run', 'approve', '--run', started.runId, '--project', 'crm', '--client-id', 'reviewer-1', '--reason', '내용을 읽고 승인한다']);
  assert.notStrictEqual(drifted.status, 0, 'HEAD가 움직인 뒤의 승인이 허용됐습니다');
  assert.match(`${drifted.stdout}${drifted.stderr}`, /판정된 적이 없으므로/u, `${drifted.stdout}${drifted.stderr}`);
  git(['reset', '--hard', 'HEAD~1'], projectRoot);

  // 사람이 승인하면 공유된다. 우회 없이. 이것이 정상 경로이고, 정상 경로가
  // --share-unverified를 요구한다면 그 우회는 이미 우회가 아니다.
  const approved = rdl(['run', 'approve', '--run', started.runId, '--project', 'crm', '--client-id', 'reviewer-1', '--reason', '내용을 읽고 승인한다']);
  assert.strictEqual(approved.commit, saveEvent.commit, '승인이 검증된 커밋에 붙지 않았습니다');
  rdl(['run', 'complete', '--run', started.runId, '--project', 'crm', '--client-id', 'agent-a']);
  const shared = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  assert.strictEqual(shared.status, 0, `사람이 승인한 런의 공유가 막혔습니다: ${shared.stdout}${shared.stderr}`);

  // --force는 운영자의 우회이지 사람의 승인이 아니다. 지나가긴 하지만 원장은
  // 누가 무엇을 승인했는지 답하지 못하고, 그래서 공유는 여전히 막힌다.
  const overrideRun = rdl(['run', 'start', 'document.verified', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', document.id]);
  rdlRaw(['run', 'drive', '--run', overrideRun.runId, '--project', 'crm', '--client-id', 'agent-a']);
  rdl(['run', 'step', '--run', overrideRun.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', '운영자 우회']);
  rdl(['run', 'complete', '--run', overrideRun.runId, '--project', 'crm', '--client-id', 'agent-a']);
  const stillBlocked = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  assert.notStrictEqual(stillBlocked.status, 0, 'forced 사람 게이트의 런이 공유를 막지 않았습니다');
  assert.match(`${stillBlocked.stdout}${stillBlocked.stderr}`, /RDL-SYNC-030/u,
    `${stillBlocked.stdout}${stillBlocked.stderr}`);

  // 우회도 사람의 판단이어야 한다. 사유 문자열만으로 지나가면 에이전트가 자기
  // 판단으로 사람 게이트를 넘는 것이고, 그것이 막으려던 바로 그 일이다.
  const agentShare = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a', '--share-unverified', '에이전트가 스스로 판단한다']);
  assert.notStrictEqual(agentShare.status, 0, '사람 없이 우회가 통과했습니다');
  assert.match(`${agentShare.stdout}${agentShare.stderr}`, /RDL-SYNC-031/u, `${agentShare.stdout}${agentShare.stderr}`);
  const agentAsHuman = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a', '--share-unverified', '사람인 척', '--approved-by', 'agent-a']);
  assert.notStrictEqual(agentAsHuman.status, 0, 'agent를 승인자로 내세운 우회가 통과했습니다');
  assert.match(`${agentAsHuman.stdout}${agentAsHuman.stderr}`, /RDL-SYNC-031/u, `${agentAsHuman.stdout}${agentAsHuman.stderr}`);
  const forcedShare = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a', '--share-unverified', '운영자 우회로 지난 런을 그대로 공유한다', '--approved-by', 'reviewer-1']);
  assert.doesNotMatch(`${forcedShare.stdout}${forcedShare.stderr}`, /RDL-SYNC-03[01]/u,
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

  // 격리 탈출. worktree는 cwd를 가둘 뿐 OS 샌드박스가 아니므로, 어댑터는 넘겨받은
  // 절대 경로에서 본 저장소를 역산해 직접 쓸 수 있다. 막지는 못한다 — 그러나 그것을
  // 알아차리지 못한 채 성공으로 보고하면, 하네스는 자기가 무엇을 승인했는지 모른다.
  const escapeRun = rdl(['run', 'start', 'document.verified', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', document.id]);
  stubControl({ artifactId: document.id, verdict: 'pass', escape: 'ESCAPED.txt' });
  const escapeDrive = rdlRaw(['run', 'drive', '--run', escapeRun.runId, '--project', 'crm', '--client-id', 'agent-a']);
  const escapeOutcome = escapeDrive.stdout ? JSON.parse(escapeDrive.stdout) : { status: 'no-output', stderr: escapeDrive.stderr };
  assert.notStrictEqual(escapeOutcome.status, 'waiting_human', `격리를 빠져나간 저작이 완주했습니다: ${JSON.stringify(escapeOutcome)}`);
  assert.match(String(escapeOutcome.detail || ''), /ADAPTER_ESCAPED_SANDBOX|outside its sandbox/u,
    `막은 이유가 격리 탈출이어야 합니다: ${JSON.stringify(escapeOutcome)}`);
  assert(fs.existsSync(path.join(projectRoot, 'ESCAPED.txt')), '픽스처가 실제로 탈출하지 않았다면 이 시험은 아무것도 증명하지 않습니다');
  fs.rmSync(path.join(projectRoot, 'ESCAPED.txt'));

  // 런이 시킨 저장은 그 런의 대상 하나에만 닿는다. 대상 밖이 더러우면 담지 않는
  // 것으로 끝내지 않고 멈춘다 — 조용히 남겨 두면 다음 저장에 섞이고, 그때는 어느
  // 런의 것인지 아무도 모른다.
  fs.writeFileSync(path.join(projectRoot, 'UNRELATED.txt'), '런과 무관한 파일\n', 'utf8');
  const scoped = rdlRaw(['save', '--project', 'crm', '--run', strayRun.runId]);
  assert.notStrictEqual(scoped.status, 0, '런 범위 밖 변경이 있는데 저장이 통과했습니다');
  assert.match(`${scoped.stdout}${scoped.stderr}`, /RDL-SAVE-010/u, `${scoped.stdout}${scoped.stderr}`);
  fs.rmSync(path.join(projectRoot, 'UNRELATED.txt'));

  // 기대한 커밋 위에서만 쌓는다. 그 사이 HEAD가 움직였다면 결과 커밋이 무엇 위에
  // 있는지 하네스가 알던 것과 달라진다.
  const staleHead = rdlRaw(['save', '--project', 'crm', '--run', strayRun.runId, '--expect-head', 'b'.repeat(40)]);
  assert.notStrictEqual(staleHead.status, 0, '기대 HEAD가 달라도 저장이 통과했습니다');
  assert.match(`${staleHead.stdout}${staleHead.stderr}`, /RDL-SAVE-011/u, `${staleHead.stdout}${staleHead.stderr}`);

  // 다른 클라이언트의 판정은 git 병합으로 들어온다. 그 클라이언트의 프로젝트 커밋이
  // 함께 오지 않으면, 여기에는 풀 수 없는 리비전을 지목한 판정만 남는다. 쓰기 경로로는
  // 막을 수 없으므로 — 병합은 CLI를 지나오지 않는다 — 읽을 때 판정해야 한다.
  const verdictDirectory = path.join(temporary, 'projects', 'workspace', 'events', 'verdict');
  const verdictFile = fs.readdirSync(verdictDirectory).find((name) => name.startsWith('verdict-crm-'));
  assert(verdictFile, `verdict 샤드를 찾지 못했습니다: ${fs.readdirSync(verdictDirectory).join(', ')}`);
  const sample = JSON.parse(fs.readFileSync(path.join(verdictDirectory, verdictFile), 'utf8').split(/\r?\n/u).filter(Boolean)[0]);
  const unreachable = 'a'.repeat(40);
  const foreign = Object.assign({}, sample, { reviewedRevision: unreachable });
  delete foreign.canonicalDigest;
  fs.appendFileSync(path.join(verdictDirectory, verdictFile), `${JSON.stringify(require(path.join(repository, 'src', 'verify')).verdictEnvelope(foreign).shared)}\n`, 'utf8');
  const audited = rdlRaw(['check', '--strict', '--json']);
  const codes = JSON.parse(audited.stdout).diagnostics.filter((item) => item.code.startsWith('RDL-VERDICT-')).map((item) => item.code);
  assert(codes.includes('RDL-VERDICT-015'), `풀 수 없는 리비전을 지목한 판정이 진단되지 않았습니다: ${codes.join(', ') || '(없음)'}`);
  // 스키마·봉투는 멀쩡하다. 잡힌 것이 형식 오류가 아니라 "여기서 확인할 수 없는
  // 판정"이어야 이 진단이 자기 몫을 한 것이다.
  assert(!codes.includes('RDL-VERDICT-014'), `형식 오류로 잡혔습니다: ${codes.join(', ')}`);

  // 위조된 승인. 에이전트가 basis: human-approval 이벤트를 원장에 직접 써 넣는다.
  // 쓰기 경로를 지나오지 않으므로 CLI의 human 자격 검사는 이 이벤트를 보지 못한다 —
  // git 병합으로 들어오는 남의 이벤트와 같은 처지다. 그래서 공유를 정하는 쪽이
  // 승인자의 신원을 registry에 다시 물어야 한다.
  stubControl({ artifactId: document.id, verdict: 'pass' });
  const forgedRun = rdl(['run', 'start', 'document.verified', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', document.id]);
  rdlRaw(['run', 'drive', '--run', forgedRun.runId, '--project', 'crm', '--client-id', 'agent-a']);
  const forgedLog = rdl(['run', 'log', '--run', forgedRun.runId, '--project', 'crm']);
  const forgedStart = forgedLog.events.find((event) => event.type === 'run.started');
  const forgedHead = git(['rev-parse', 'HEAD'], projectRoot).toLowerCase();
  const shardDirectory = path.join(temporary, 'projects', 'workspace', 'events', 'run');
  const shard = fs.readdirSync(shardDirectory).find((name) => name.includes(forgedRun.runId) && name.includes('agent-a'));
  assert(shard, `위조 대상 샤드를 찾지 못했습니다: ${fs.readdirSync(shardDirectory).join(', ')}`);
  const forged = {
    schemaVersion: forgedStart.schemaVersion, eventId: 'EVT-0000000000000000FA01', type: 'run.forced',
    rootRequestId: 'REQ-0000000000000000FA01', requestId: 'REQ-0000000000000000FA02',
    clientId: 'agent-a', projectId: 'crm', runId: forgedRun.runId, ownerToken: forgedStart.ownerToken,
    stepId: 'sync-gate', reason: '에이전트가 스스로 적은 승인', basis: 'human-approval', commit: forgedHead
  };
  const ledgerModule = require(path.join(repository, 'src', 'run-ledger'));
  fs.appendFileSync(path.join(shardDirectory, shard), `${JSON.stringify(ledgerModule.createEventEnvelope(forged).shared)}\n`, 'utf8');
  rdl(['run', 'complete', '--run', forgedRun.runId, '--project', 'crm', '--client-id', 'agent-a']);
  const forgedSync = rdlRaw(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  assert.notStrictEqual(forgedSync.status, 0, '위조된 사람 승인으로 공유가 통과했습니다');
  // "막혔다"만으로는 부족하다. 앞선 런들이 이미 공유를 막고 있으므로, 위조 런이
  // 통과했더라도 sync는 실패한다 — 이 시험은 위조 런이 차단 대상으로 지목되는지를
  // 물어야 한다. 그래야 신원 검사를 끄면 시험이 무너진다.
  const forgedOutput = `${forgedSync.stdout}${forgedSync.stderr}`;
  assert(forgedOutput.includes(forgedRun.runId),
    `위조 승인 런이 차단 대상으로 지목되지 않았습니다. 앞선 런이 막았을 뿐입니다:\n${forgedOutput}`);

  process.stdout.write('drive end-to-end tests passed\n');
} finally {
  if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
