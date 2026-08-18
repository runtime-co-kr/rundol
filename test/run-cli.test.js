'use strict';

// 이 스위트는 실제 자식 프로세스를 띄운다. Windows에서 그 실행은 기본으로 막혀
// 있으므로 여기서만 켜고, 끝나면 반드시 되돌린다.
//
// 되돌리지 않으면 같은 프로세스에서 뒤이어 도는 스위트로 새어 나가 전체 게이트가
// 위험 모드에서 돈다 — 실제로 그랬고, "기본 차단에서 검증된다"는 말이 거짓이 됐다.
// 환경변수를 켜는 것과 켠 채로 두는 것은 다른 일이다.
const PREVIOUS_WINDOWS_ADAPTER = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';
function restoreWindowsAdapterOptIn() {
  if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
  else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
}

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadProcedures, validateOverride, validateDriveSafety } = require('../src/procedure');
const { runtimeWorkspace } = require('../src/runtime');
const requestJournal = require('../src/request-journal');
const { canonicalJson } = require('../src/event-store');
const runLedger = require('../src/run-ledger');
const driverLease = require('../src/driver-lease');
const { recordVerificationResult } = require('../src/run');
const { verifyCommandDigest, validatorInstanceId, invocationId, invocationDescriptor } = require('../src/verify');
const { pinInstruction } = require('../src/instruction-registry');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-run-cli-'));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), root));
}

function rdlRaw(args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: root, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertOverrideRejected(parentStep, childStep, pattern) {
  const parent = { steps: [parentStep] };
  const child = { steps: [childStep] };
  assert.throws(() => validateOverride('safe-flow', parent, child, 'fixture'), pattern);
}

// Inheritance is monotonic: a project layer may tighten safety, never remove it.
assertOverrideRejected(
  { id: 'gate', gate: { command: 'check', args: ['REQ-001', '--strict'] }, onFail: { goto: 'gate', maxAttempts: 3, carry: ['finding'] } },
  { id: 'gate', gate: { command: 'check', args: ['REQ-001', '--strict'] } },
  /onFail/u
);
assertOverrideRejected(
  { id: 'verify', executor: 'adapter', lenses: ['satisfaction-v1', 'boundary-v1'], refutedThreshold: 1, abstainThreshold: 1 },
  { id: 'verify', executor: 'adapter', lenses: ['satisfaction-v1'], refutedThreshold: 2, abstainThreshold: 1 },
  /lens|Threshold/u
);
assertOverrideRejected(
  { id: 'write', executor: 'cli', args: ['apply', '--operation', '{operationId}'], retrySafety: { mode: 'operation-id' } },
  { id: 'write', executor: 'cli', args: ['apply'], retrySafety: { mode: 'operation-id' } },
  /operationId/u
);
assertOverrideRejected(
  { id: 'write', executor: 'cli', retrySafety: { mode: 'gate-recheck', gateStep: 'check-written' } },
  { id: 'write', executor: 'cli', retrySafety: { mode: 'gate-recheck', gateStep: 'check-other' } },
  /gate-recheck/u
);
assertOverrideRejected(
  { id: 'approve', human: true },
  { id: 'approve', executor: 'client' },
  /분류|사람/u
);
assert.throws(() => validateDriveSafety({
  name: 'unsafe-drive', revision: 1, idempotent: true,
  steps: [{ id: 'write', executor: 'cli', args: ['apply'] }]
}), /retrySafety/u);
assert.throws(() => validateDriveSafety({
  name: 'unsafe-placeholder', revision: 1, idempotent: true,
  steps: [{ id: 'write', executor: 'cli', args: ['apply', '{operationId}', '{operationId}'], retrySafety: { mode: 'operation-id' } }]
}), /정확히 한 번/u);
assert.doesNotThrow(() => validateDriveSafety({
  name: 'safe-drive', revision: 1, idempotent: true,
  steps: [
    { id: 'check-written', gate: { command: 'check', args: ['{artifact}', '--strict'] } },
    { id: 'write', executor: 'cli', args: ['apply'], retrySafety: { mode: 'gate-recheck', gateStep: 'check-written' } }
  ]
}));
assert.throws(() => validateDriveSafety({
  name: 'unsafe-drive-gate', revision: 1, idempotent: true,
  steps: [{ id: 'unsafe', gate: { command: 'check', args: ['REQ-001', '--fix'] } }]
}), /closed read-only allowlist/u);
assert.throws(() => validateDriveSafety({
  name: 'ambiguous-drive-step', revision: 1, idempotent: true,
  steps: [{ id: 'ambiguous', executor: 'cli', gate: { command: 'check', args: ['REQ-001', '--strict'] } }]
}), /exactly one drive class/u);

try {
  const bare = path.join(temporary, 'origin.git');
  command('git', ['init', '--bare', '--initial-branch=main', bare], temporary);
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  command('git', ['remote', 'add', 'origin', bare], temporary);
  command('git', ['push', 'origin', 'main'], temporary);
  rdl(['init', 'crm', '--name', '고객 관리', '--profile', 'lean']);
  rdl(['contract', 'set', '--project', 'crm', '--profile', 'lean', '--enforcement', 'advisory']);
  rdl(['client', 'register', 'laptop-a', '--name', '업무 노트북', '--type', 'device', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'agent-a', '--name', '동기화 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);

  // 문서 1개 = 기능 1개 기본: REQ에 기능 2개는 --grouped로도 열리지 않는다.
  const resumeArtifact = rdl(['doc', 'create', 'PRD', '재개 검증', '--project', 'crm', '--owner', 'MEMBER-001', '--scope', '검증 요청 재개 흐름', '--exclude', '외부 시스템 연동']);
  const projectRoot = path.join(temporary, 'projects', 'crm');
  fs.writeFileSync(path.join(projectRoot, 'harness.json'), `${JSON.stringify({ schemaVersion: 1, revision: 1, adapters: { fixture: { enabled: true, command: process.execPath, argsTemplate: [], timeoutSeconds: 5 } }, verify: { defaultAdapter: 'fixture', defaultLenses: ['satisfaction-v1'] } }, null, 2)}\n`, 'utf8');
  command('git', ['add', '.'], projectRoot); command('git', ['commit', '-m', 'add verify resume fixture'], projectRoot);
  const resumeRevision = command('git', ['rev-parse', 'HEAD'], projectRoot);
  const resumeRootId = 'REQ-91919191919191919191'; const resumeLens = 'satisfaction-v1'; const resumeInstruction = pinInstruction('verify-satisfaction-v1');
  const resumeAdapter = { name: 'fixture', instructionId: resumeInstruction.id, instructionRevision: resumeInstruction.revision, instructionDigest: resumeInstruction.instructionDigest };
  const resumeDigest = verifyCommandDigest({ project: 'crm', targetId: resumeArtifact.id, reviewedRevision: resumeRevision, clientId: 'agent-a', adapter: 'fixture', lenses: [resumeLens] });
  const resumeJournal = requestJournal.prepareRoot(runtimeWorkspace(temporary), { rootRequestId: resumeRootId, commandDigest: resumeDigest, clientId: 'agent-a' });
  const resumeValidator = validatorInstanceId(resumeRootId, resumeArtifact.id, resumeRevision, resumeLens, 1); const resumeInvocationId = invocationId(resumeValidator); const resumeChildKey = `verdict:${resumeArtifact.id}:${resumeRevision}:${resumeLens}:1`;
  const resumeDescriptor = invocationDescriptor({ childKey: resumeChildKey, invocationId: resumeInvocationId, validatorInstanceId: resumeValidator, lens: resumeLens, slot: 1, targetPath: path.relative(projectRoot, resumeArtifact.file).replace(/\\/gu, '/'), instruction: resumeInstruction, adapter: resumeAdapter, command: { project: 'crm', targetId: resumeArtifact.id, reviewedRevision: resumeRevision, clientId: 'agent-a', adapter: 'fixture', lenses: [resumeLens] } });
  requestJournal.prepareInvocation(resumeJournal, { invocationKey: resumeChildKey, descriptor: resumeDescriptor }); requestJournal.updateInvocation(resumeJournal, resumeChildKey, 'running', { pid: process.pid });
  const resumeDirectory = path.join(projectRoot, '.rundol', 'verify', resumeInvocationId); fs.mkdirSync(resumeDirectory, { recursive: true });
  const resumeInstructionBytes = Buffer.from(JSON.stringify({ id: resumeInstruction.id, revision: resumeInstruction.revision, instructionDigest: resumeInstruction.instructionDigest }), 'utf8');
  const resumeContextBytes = Buffer.from(JSON.stringify({ target: resumeDescriptor.targetPath, lensId: resumeLens, pin: { targetId: resumeArtifact.id, reviewedRevision: resumeRevision }, instructionId: resumeInstruction.id }), 'utf8');
  const resumeResultBytes = Buffer.from(JSON.stringify({ verdict: 'pass', findings: [] }), 'utf8');
  fs.writeFileSync(path.join(resumeDirectory, 'instruction.json'), resumeInstructionBytes);
  fs.writeFileSync(path.join(resumeDirectory, 'context.json'), resumeContextBytes);
  fs.writeFileSync(path.join(resumeDirectory, 'result.json'), resumeResultBytes);
  fs.writeFileSync(path.join(resumeDirectory, 'receipt.json'), JSON.stringify({
    schemaVersion: 1, instanceId: resumeInvocationId, adapter: resumeAdapter,
    manifestHashes: { instruction: sha256(resumeInstructionBytes), context: sha256(resumeContextBytes) },
    exitCategory: 'success', resultHash: sha256(resumeResultBytes)
  }), 'utf8');
  const liveResume = rdlRaw(['run', 'request', 'resume', resumeRootId, '--client-id', 'agent-a']); assert.strictEqual(liveResume.status, 2); assert(/still live/u.test(liveResume.stderr));
  requestJournal.updateInvocation(resumeJournal, resumeChildKey, 'running', { pid: 2147483646 });
  const resumedVerification = rdl(['run', 'request', 'resume', resumeRootId, '--client-id', 'agent-a']);
  assert.strictEqual(resumedVerification.verification.status, 'passed');
  assert.strictEqual(resumedVerification.children.length, 1, 'resuming an invocation must preserve the recorded verdict child');
  assert.strictEqual(resumedVerification.children[0].phase, 'complete');
  const resumedJournal = requestJournal.loadJournal(runtimeWorkspace(temporary), resumeRootId).journal;
  assert.strictEqual(resumedJournal.children[resumeChildKey].phase, 'complete');
  assert.strictEqual(resumedJournal.invocations[resumeChildKey].phase, 'complete');

  const rejectedCreate = rdlRaw(['doc', 'create', 'REQ', '결제 요구', '--project', 'crm', '--owner', 'MEMBER-001', '--scope', '결제 승인 요구', '--exclude', '환불 흐름', '--function-id', 'PAY-01', '--function-id', 'PAY-02', '--grouped', '--reason', '사유']);
  assert.notStrictEqual(rejectedCreate.status, 0);
  assert(/기능 1개만/u.test(rejectedCreate.stderr), rejectedCreate.stderr);

  // 내장 절차가 단일 소스로 열거된다.
  const procedures = rdl(['run', 'procedures', '--project', 'crm']);
  const authored = procedures.procedures.find((item) => item.name === 'document.authored');
  assert(authored, '내장 절차 document.authored가 없습니다');
  assert.strictEqual(authored.source, '내장');
  const verified = procedures.procedures.find((item) => item.name === 'document.verified');
  assert(verified, 'P1.5 내장 절차 document.verified가 없습니다');
  const verifiedDefinition = loadProcedures(temporary, 'crm').resolve('document.verified').resolved;
  const authorStep = verifiedDefinition.steps.find((step) => step.id === 'author');
  const verifyStep = verifiedDefinition.steps.find((step) => step.id === 'verify');
  assert.deepStrictEqual(Object.keys(authorStep.instruction).sort(), ['id', 'instructionDigest', 'revision']);
  assert.deepStrictEqual(Object.keys(verifyStep.verify.instructions).sort(), ['boundary-v1', 'omission-v1', 'satisfaction-v1']);
  // 저작을 포함하는 절차의 검증은 저장이 만든 커밋을 본다. run 시작 시점으로
  // 굳히면 저작 결과를 볼 수 없다.
  assert.deepStrictEqual(verifyStep.verify.revisionPin, { strategy: 'step-head' });

  // Run-bound verification result is converted to a deterministic run.gate child under the same root request.
  // revision 2는 문서를 만들지 않는다. 대상 문서를 run 시작 시 고정하고, 절차는
  // 그것을 쓰고·검사하고·검증하고·저장한 뒤 사람 앞에서 멈춘다.
  const verificationRun = rdl(['run', 'start', 'document.verified', '--project', 'crm', '--client-id', 'agent-a', '--artifact-id', resumeArtifact.id]);
  const startedPin = rdl(['run', 'log', '--run', verificationRun.runId, '--project', 'crm']).events.find((item) => item.type === 'run.started').procedure.resolved.steps.find((item) => item.id === 'verify').verify.revisionPin;
  // step-head는 run 시작 시점에 굳히지 않는다 — 검증 스텝이 도는 시점에 풀린다.
  assert.strictEqual(startedPin.strategy, 'step-head');
  assert.strictEqual(startedPin.reviewedRevision, undefined);
  // revision 2의 첫 스텝은 author다 — plan·create가 없다.
  rdl(['run', 'step', '--run', verificationRun.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', 'fixture author bypass']);
  rdl(['run', 'gate', '--run', verificationRun.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', 'fixture mechanical gate bypass']);
  // 저장이 검증보다 앞이다 — 검증은 저장이 만든 커밋을 본다.
  rdl(['run', 'step', '--run', verificationRun.runId, '--project', 'crm', '--client-id', 'agent-a', '--force', '--reason', 'fixture save bypass']);
  const verificationRootId = 'REQ-CCCCCCCCCCCCCCCCCCCC';
  const verificationDigest = 'c'.repeat(64);
  requestJournal.prepareRoot(runtimeWorkspace(temporary), { rootRequestId: verificationRootId, commandDigest: verificationDigest, clientId: 'agent-a' });
  const transition = recordVerificationResult(temporary, {
    project: 'crm', run: verificationRun.runId, clientId: 'agent-a', positional: [resumeArtifact.id]
  }, {
    exitCode: 0, status: 'passed', targetId: resumeArtifact.id, rootRequestId: verificationRootId, commandDigest: verificationDigest,
    fold: { lenses: [{ lens: 'satisfaction-v1' }, { lens: 'omission-v1' }, { lens: 'boundary-v1' }] }
  });
  assert.strictEqual(transition.transition, 'run.gate');
  const repeatedTransition = recordVerificationResult(temporary, {
    project: 'crm', run: verificationRun.runId, clientId: 'agent-a', positional: [resumeArtifact.id]
  }, {
    exitCode: 0, status: 'passed', targetId: resumeArtifact.id, rootRequestId: verificationRootId, commandDigest: verificationDigest,
    fold: { lenses: [{ lens: 'satisfaction-v1' }, { lens: 'omission-v1' }, { lens: 'boundary-v1' }] }
  });
  assert.strictEqual(repeatedTransition.transitionEventId, transition.transitionEventId, 'same verification root must reuse its run transition');
  // 검증이 끝나면 남는 것은 사람 스텝뿐이다 — 저장은 그 앞에서 이미 지나갔다.
  assert.strictEqual(rdl(['run', 'next', '--run', verificationRun.runId, '--project', 'crm']).step.id, 'sync-gate');

  // 게이트를 제거하는 프로젝트 오버라이드는 로드 시점에 거부된다.
  const proceduresFile = path.join(temporary, 'projects', 'crm', 'procedures.json');
  fs.writeFileSync(proceduresFile, `${JSON.stringify({
    schemaVersion: 1,
    procedures: {
      'document.authored': {
        revision: 2,
        steps: [
          { id: 'plan', executor: 'cli', command: 'contract', args: ['next', '--project', '{project}', '--json'] },
          { id: 'create', executor: 'cli', command: 'doc', args: ['create'] },
          { id: 'author', executor: 'client' },
          { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}'] },
          { id: 'sync-gate', human: true }
        ]
      }
    }
  }, null, 2)}\n`, 'utf8');
  const rejected = rdlRaw(['run', 'procedures', '--project', 'crm']);
  assert.notStrictEqual(rejected.status, 0);
  assert(/게이트를 제거할 수 없습니다|스텝을 제거할 수 없습니다/u.test(rejected.stderr), rejected.stderr);

  // 스텝을 더하고 시도 상한을 조이는 오버라이드는 허용되고 revision이 갈린다.
  fs.writeFileSync(proceduresFile, `${JSON.stringify({
    schemaVersion: 1,
    procedures: {
      'document.authored': {
        revision: 2,
        steps: [
          { id: 'plan', executor: 'cli', command: 'contract', args: ['next', '--project', '{project}', '--json'] },
          { id: 'create', executor: 'cli', command: 'doc', args: ['create'] },
          { id: 'author', executor: 'client' },
          { id: 'peer-note', executor: 'client' },
          { id: 'mech-gate', gate: { command: 'check', args: ['{artifact}', '--strict'] }, onFail: { goto: 'author', maxAttempts: 2 } },
          { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}'] },
          { id: 'sync-gate', human: true }
        ]
      }
    }
  }, null, 2)}\n`, 'utf8');
  const overridden = rdl(['run', 'procedures', '--project', 'crm']);
  const local = overridden.procedures.find((item) => item.name === 'document.authored');
  assert.strictEqual(local.revision, 2);
  assert.notStrictEqual(local.contentHash, authored.contentHash);

  // 런 시작: 오버라이드된 절차가 pin된다.
  const started = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'laptop-a', '--goal', '결제 REQ']);
  const runId = started.runId;
  assert(/^RUN-[A-F0-9]{20}$/u.test(runId));

  const procedureFixture = JSON.parse(fs.readFileSync(proceduresFile, 'utf8'));
  procedureFixture.procedures['environment.gate'] = {
    revision: 1,
    steps: [{ id: 'env-gate', gate: { command: 'check', args: ['--definitely-unknown'] } }]
  };
  fs.writeFileSync(proceduresFile, `${JSON.stringify(procedureFixture, null, 2)}\n`, 'utf8');
  const environmentRootId = 'REQ-BBBBBBBBBBBBBBBBBBBB';
  const environmentRun = rdl(['run', 'start', 'environment.gate', '--project', 'crm', '--client-id', 'laptop-a', '--request-id', environmentRootId]);
  assert.strictEqual(environmentRun.rootRequestId, environmentRootId);
  const environmentJournal = requestJournal.loadJournal(runtimeWorkspace(temporary), environmentRun.rootRequestId);
  const environmentChild = Object.values(environmentJournal.journal.children)[0];
  const environmentLocalFile = path.join(temporary, 'projects', 'crm', '.rundol', 'runs', environmentRun.runId, 'events.jsonl');
  fs.rmSync(environmentLocalFile);
  requestJournal.updateChild(environmentJournal, environmentChild.childKey, 'canonical-committed');
  const pendingRequests = rdl(['run', 'requests', '--pending']);
  assert(pendingRequests.requests.some((item) => item.rootRequestId === environmentRun.rootRequestId));
  const wrongResumeClient = rdlRaw(['run', 'request', 'resume', environmentRun.rootRequestId, '--client-id', 'agent-a']);
  assert.strictEqual(wrongResumeClient.status, 2);
  assert.strictEqual(fs.existsSync(environmentLocalFile), false);
  const repairedRequest = rdl(['run', 'request', 'resume', environmentRun.rootRequestId, '--client-id', 'laptop-a']);
  assert.strictEqual(repairedRequest.children[0].status, 'projection-repaired');
  const repairedEvent = JSON.parse(fs.readFileSync(environmentLocalFile, 'utf8').trim());
  assert.strictEqual(repairedEvent.eventId, environmentChild.eventId);
  assert.strictEqual(rdl(['run', 'request', 'resume', environmentRun.rootRequestId, '--client-id', 'laptop-a']).children[0].status, 'already-complete');

  // Prepared semantic children use their canonical type, not a historical child-key prefix, when resuming.
  const semanticRun = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'agent-a']);
  const semanticStarted = rdl(['run', 'log', '--run', semanticRun.runId, '--project', 'crm']).events.find((event) => event.type === 'run.started');
  const transitionRootId = 'REQ-DDDDDDDDDDDDDDDDDDDD';
  const transitionChildKey = `transition:crm:${semanticRun.runId}:none:run.halted`;
  const transitionRequestId = requestJournal.childRequestId(transitionRootId, transitionChildKey);
  const transitionEventId = requestJournal.eventIdForRequest(transitionRequestId);
  const transitionRoot = requestJournal.prepareRoot(runtimeWorkspace(temporary), { rootRequestId: transitionRootId, commandDigest: 'd'.repeat(64), clientId: 'agent-a' });
  const transitionEnvelope = runLedger.createEventEnvelope({
    schemaVersion: 2, eventId: transitionEventId, type: 'run.halted', rootRequestId: transitionRootId,
    requestId: transitionRequestId, clientId: 'agent-a', projectId: 'crm', runId: semanticRun.runId,
    ownerToken: semanticStarted.ownerToken, reason: 'manual', resumable: true
  });
  requestJournal.prepareChild(transitionRoot, { childKey: transitionChildKey, canonicalBytes: transitionEnvelope.canonicalBytes, runId: semanticRun.runId });
  const resumedTransition = rdl(['run', 'request', 'resume', transitionRootId, '--client-id', 'agent-a']);
  assert.strictEqual(resumedTransition.children[0].status, 'canonical-replayed');
  assert.strictEqual(requestJournal.loadJournal(runtimeWorkspace(temporary), transitionRootId).journal.phase, 'complete');
  assert(rdl(['run', 'log', '--run', semanticRun.runId, '--project', 'crm']).events.some((event) => event.eventId === transitionEventId));

  const driverRootId = 'REQ-EEEEEEEEEEEEEEEEEEEE';
  const operationId = 'f'.repeat(64);
  const driverChildKey = `driver:${operationId}:acquire:`;
  const driverRequestId = requestJournal.childRequestId(driverRootId, driverChildKey);
  const driverEventId = requestJournal.eventIdForRequest(driverRequestId);
  const driverRoot = requestJournal.prepareRoot(runtimeWorkspace(temporary), { rootRequestId: driverRootId, commandDigest: 'e'.repeat(64), clientId: 'agent-a' });
  const preparedDriver = {
    schemaVersion: 1, eventId: driverEventId, type: 'driver.acquired', rootRequestId: driverRootId,
    requestId: driverRequestId, clientId: 'agent-a', projectId: 'crm', runId: semanticRun.runId,
    leaseId: 'LEASE-EEEEEEEEEEEEEEEEEEEE', ownerToken: semanticStarted.ownerToken,
    expiresAt: '2031-01-01T00:00:00.000Z', operationId
  };
  requestJournal.prepareChild(driverRoot, { childKey: driverChildKey, canonicalBytes: driverLease.driverEnvelope(preparedDriver).canonicalBytes, runId: semanticRun.runId });
  const resumedDriver = rdl(['run', 'request', 'resume', driverRootId, '--client-id', 'agent-a']);
  assert.strictEqual(resumedDriver.children[0].status, 'canonical-replayed');
  assert.strictEqual(requestJournal.loadJournal(runtimeWorkspace(temporary), driverRootId).journal.phase, 'complete');
  const driverEvents = driverLease.readDriverEvents(path.join(temporary, 'projects', 'workspace', 'events'), 'crm', semanticRun.runId);
  assert(driverEvents.some((event) => event.eventId === driverEventId));

  const unsupportedRootId = 'REQ-AAAAAAAAAAAAAAAAAAAA';
  const unsupportedRoot = requestJournal.prepareRoot(runtimeWorkspace(temporary), {
    rootRequestId: unsupportedRootId,
    commandDigest: 'a'.repeat(64),
    clientId: 'laptop-a'
  });
  const unsupportedChildKey = 'verdict:REQ-001:revision:lens:1';
  const unsupportedRequestId = requestJournal.childRequestId(unsupportedRootId, unsupportedChildKey);
  const unsupportedEventId = requestJournal.eventIdForRequest(unsupportedRequestId);
  requestJournal.prepareChild(unsupportedRoot, {
    childKey: unsupportedChildKey,
    canonicalBytes: Buffer.from(canonicalJson({
      schemaVersion: 1, rootRequestId: unsupportedRootId, requestId: unsupportedRequestId,
      eventId: unsupportedEventId, type: 'verdict.recorded', clientId: 'laptop-a', projectId: 'crm'
    }), 'utf8')
  });
  const unsupportedResume = rdl(['run', 'request', 'resume', unsupportedRootId, '--client-id', 'laptop-a']);
  assert.strictEqual(unsupportedResume.children[0].status, 'unsupported-future-child');
  assert.strictEqual(requestJournal.loadJournal(runtimeWorkspace(temporary), unsupportedRootId).journal.children[unsupportedChildKey].phase, 'prepared');

  const environmentGate = rdlRaw(['run', 'gate', '--run', environmentRun.runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert.strictEqual(environmentGate.status, 2, environmentGate.stdout + environmentGate.stderr);
  assert(environmentGate.stdout.trim(), environmentGate.stderr);
  assert.strictEqual(JSON.parse(environmentGate.stdout).exitCode, 2);

  const missingClient = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm']);
  assert.strictEqual(missingClient.status, 2, missingClient.stdout + missingClient.stderr);
  const futureStep = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'create', '--client-id', 'laptop-a']);
  assert.strictEqual(futureStep.status, 2, futureStep.stdout + futureStep.stderr);

  // 절차 정의가 삭제돼도 진행 중 런은 pin으로 완주한다.
  fs.rmSync(proceduresFile);

  // next → step 보고의 대화형 루프. plan/create/author를 진행한다.
  let next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'plan');
  assert.deepStrictEqual(next.step.args, ['next', '--project', 'crm', '--json']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'create', '--artifact-id', 'REQ-001', '--client-id', 'laptop-a']);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'author');
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'peer-note', '--client-id', 'laptop-a']);

  // 게이트 스텝은 step 보고로 전진할 수 없다.
  const wrongStep = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'mech-gate', '--client-id', 'laptop-a']);
  assert.notStrictEqual(wrongStep.status, 0);

  // 게이트 실제 실행: 필수 필드가 빠진 REQ-001 문서를 심어 진짜 check 실패를 만든다.
  const brokenDocument = path.join(temporary, 'projects', 'crm', 'REQ-001-결제요구.md');
  fs.writeFileSync(brokenDocument, '---\nid: REQ-001\ntype: REQ\n---\n\n# 결제 요구\n', 'utf8');
  const gate = rdlRaw(['run', 'gate', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert.strictEqual(gate.status, 1, gate.stdout + gate.stderr);
  const gateResult = JSON.parse(gate.stdout);
  assert.strictEqual(gateResult.exitCode > 0, true);
  assert(gateResult.diagnostics.length > 0, '게이트가 진단 코드를 수집하지 못했습니다');
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'author');
  assert.strictEqual(next.attempts['mech-gate'], 1);

  // 재작업 후 사람이 사유와 함께 게이트를 우회하면 forced로 기록되고 전진한다.
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'peer-note', '--client-id', 'laptop-a']);
  const noReason = rdlRaw(['run', 'gate', '--run', runId, '--project', 'crm', '--force', '--client-id', 'laptop-a']);
  assert.notStrictEqual(noReason.status, 0);
  const forced = rdl(['run', 'gate', '--run', runId, '--project', 'crm', '--force', '--reason', '테스트 픽스처에는 실제 문서가 없다', '--client-id', 'laptop-a']);
  assert.strictEqual(forced.forced, true);
  fs.rmSync(brokenDocument);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'save');

  // 수동 정지와 재개.
  rdl(['run', 'halt', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  const haltedNext = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(haltedNext.status, 'halted');
  const blockedStep = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert.notStrictEqual(blockedStep.status, 0);
  rdl(['run', 'resume', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);

  // save와 sync-gate(사람 게이트)를 보고하고 완료한다.
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'save', '--client-id', 'laptop-a']);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.human, true);
  const humanWithoutAcknowledgement = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'sync-gate', '--client-id', 'laptop-a']);
  assert.strictEqual(humanWithoutAcknowledgement.status, 2);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'sync-gate', '--client-id', 'laptop-a', '--force', '--reason', '수동 동기화 승인']);
  const completed = rdl(['run', 'complete', '--run', runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert(completed.commit);

  // 미완료 스텝이 있으면 complete가 거부되는지는 두 번째 런으로 확인한다.
  const second = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'laptop-a']);
  const incomplete = rdlRaw(['run', 'complete', '--run', second.runId, '--project', 'crm', '--client-id', 'laptop-a']);
  assert.notStrictEqual(incomplete.status, 0);
  assert(/완료되지 않은 스텝/u.test(incomplete.stderr));

  // sync가 성공하면 completed_local 런이 synced로 전이한다 — 두 번째 완료.
  rdl(['sync', '--project', 'crm', '--client-id', 'agent-a']);
  const listed = rdl(['run', 'list', '--project', 'crm']);
  const syncedRun = listed.runs.find((item) => item.runId === runId);
  assert.strictEqual(syncedRun.status, 'synced');
  const stillRunning = listed.runs.find((item) => item.runId === second.runId);
  assert.strictEqual(stillRunning.status, 'running');

  // 원장 열람.
  const log = rdl(['run', 'log', '--run', runId, '--project', 'crm']);
  assert(log.events.some((event) => event.type === 'run.forced'));
  assert(log.events.some((event) => event.type === 'run.synced'));

  process.stdout.write('run CLI tests passed\n');
} finally {
  restoreWindowsAdapterOptIn();
  fs.rmSync(temporary, { recursive: true, force: true });
}
