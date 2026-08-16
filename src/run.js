'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { workspaceLayout, selectProject } = require('./workspace');
const { runGit } = require('./git');
const ledger = require('./run-ledger');
const { loadProcedures, substituteArgs, pinProcedureVerificationRevision, validateClosedDriveGate } = require('./procedure');
const { getClient } = require('./collaboration-store');
const { loadHarnessSettings } = require('./harness-settings');
const { runtimeWorkspace } = require('./runtime');
const requestJournal = require('./request-journal');
const driverLease = require('./driver-lease');

const CLI = path.join(__dirname, '..', 'bin', 'rdl.js');

function runContext(start, options) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, options.project, true);
  const directory = ledger.runDirectory(project.root, options.run);
  const reconciled = typeof ledger.reconcileRun === 'function' ? ledger.reconcileRun(start, { project: project.key, runId: options.run }) : null;
  const localEvents = ledger.readRunEvents(directory);
  const sharedEvents = ledger.readSharedRunEvents(layout, project.key, options.run);
  const events = reconciled ? reconciled.events : (typeof ledger.unionRunEvents === 'function' ? ledger.unionRunEvents(localEvents, sharedEvents) : localEvents);
  if (!events.length) throw new Error(`런을 찾지 못했습니다: ${options.run}`);
  const ownership = typeof ledger.ownershipState === 'function' ? ledger.ownershipState(events) : null;
  const fold = typeof ledger.foldSharedRun === 'function' && sharedEvents.length ? ledger.foldSharedRun(events) : ledger.foldRun(events);
  const owner = ownership && ownership.status === 'ACTIVE' ? ownership.ownerClientId : ledger.runOwner(events);
  return { layout, project, directory, events, localEvents, sharedEvents, ownership, fold, owner };
}

// 명령을 내리는 주체는 런의 현재 소유자다. --client-id를 명시하면 소유자와
// 일치해야 한다 — 다른 클라이언트는 takeover를 거쳐야만 쓸 수 있다 (LAW-1).
function projectMember(project, memberId) {
  const fs = require('fs');
  if (!project.charter || !fs.existsSync(project.charter)) return false;
  return new RegExp(`\\^${memberId}(?:\\s|$)`, 'mu').test(fs.readFileSync(project.charter, 'utf8'));
}

function authorizeClient(start, project, clientId, allowedTypes) {
  const requested = String(clientId || '').trim().toLowerCase();
  if (!requested) throw new Error('--client-id <id>가 필요합니다. 공유 이벤트 작성자는 명시해야 합니다.');
  const client = getClient(start, requested);
  if (client.status !== 'active') throw new Error(`비활성 Client는 런을 변경할 수 없습니다: ${requested}`);
  if (Array.isArray(allowedTypes) && !allowedTypes.includes(client.type)) throw new Error(`${requested}의 Client 유형(${client.type})은 이 명령을 실행할 수 없습니다.`);
  if (!projectMember(project, client.owner)) throw new Error(`${client.owner}은 ${project.key} 프로젝트의 활성 멤버가 아닙니다.`);
  return client;
}

function actorClient(context, start, options, allowedTypes) {
  const client = authorizeClient(start, context.project, options.clientId, allowedTypes);
  if (context.ownership && context.ownership.status !== 'ACTIVE') {
    throw new Error(`런 소유권이 충돌 상태입니다. rdl run ownership resolve로 복구하세요: ${(context.ownership.conflict && context.ownership.conflict.conflictId) || '(unknown)'}`);
  }
  if (context.owner && client.id !== context.owner) {
    throw new Error(`${client.id}는 이 런의 소유자가 아닙니다. 현재 소유자: ${context.owner}. rdl run takeover를 사용하세요.`);
  }
  return client;
}

function actorClientId(context, start, options, allowedTypes) {
  return actorClient(context, start, options, allowedTypes).id;
}

function ownershipFields(context) {
  const started = context.events && context.events.find((event) => event.type === 'run.started');
  return started && started.schemaVersion === 2 && context.ownership && context.ownership.ownerToken
    ? { ownerToken: context.ownership.ownerToken }
    : {};
}

function substitutionContext(context) {
  return {
    project: context.project.key,
    runId: context.fold.runId,
    artifact: context.fold.artifactIds[context.fold.artifactIds.length - 1] || null
  };
}

function startRun(start, options) {
  if (options.positional.length !== 1) throw new Error('rdl run start에는 절차 이름 하나가 필요합니다.');
  const procedures = loadProcedures(start, options.project);
  const resolved = procedures.resolve(options.positional[0]);
  const layout = workspaceLayout(start);
  const project = selectProject(layout, options.project, true);
  authorizeClient(start, project, options.clientId);
  const projectHead = runGit(['rev-parse', 'HEAD'], { cwd: project.root }).stdout.trim().toLowerCase();
  const pinnedProcedure = pinProcedureVerificationRevision(resolved.resolved, projectHead);
  const harness = loadHarnessSettings(start, { project: options.project });
  const settings = {
    schemaVersion: harness.schemaVersion,
    contentHash: harness.contentHash,
    safeResolved: harness.safeResolved
  };
  if (harness.workspaceRevision !== undefined) settings.workspaceRevision = harness.workspaceRevision;
  if (harness.projectRevision !== undefined) settings.projectRevision = harness.projectRevision;
  return ledger.createRun(start, {
    project: options.project, goal: options.goal, clientId: options.clientId, procedure: pinnedProcedure,
    settings, rootRequestId: options.requestId
  });
}

// 클라이언트 중립 인터페이스: 어떤 클라이언트든 이것만 물으면 된다. 커서 스텝의
// 실행 방법(명령 argv, 게이트, 사람 게이트 여부)을 fold에서 재계산해 반환한다.
function nextStep(start, options) {
  const context = runContext(start, options);
  const fold = context.fold;
  const step = fold.cursorStep;
  const substitution = substitutionContext(context);
  const response = {
    runId: fold.runId,
    project: context.project.key,
    procedure: fold.procedure,
    status: fold.status,
    haltReason: fold.haltReason,
    cursor: fold.cursor,
    completedSteps: fold.completedSteps,
    attempts: fold.attempts,
    artifactIds: fold.artifactIds,
    owner: context.owner,
    ownerToken: context.ownership && context.ownership.ownerToken || null,
    ownershipStatus: context.ownership && context.ownership.status || 'ACTIVE',
    ownershipConflict: context.ownership && context.ownership.status !== 'ACTIVE' ? {
      conflictId: context.ownership.conflict && context.ownership.conflict.conflictId,
      candidates: context.ownership.conflict && context.ownership.conflict.candidates
    } : null,
    step: null
  };
  if (!step) return response;
  response.step = {
    id: step.id,
    executor: step.executor || (step.gate ? 'gate' : 'client'),
    human: step.human === true,
    command: step.command || null,
    args: step.args ? trySubstitute(step.args, substitution) : null,
    gate: step.gate ? { command: step.gate.command, args: trySubstitute(step.gate.args, substitution) } : null,
    onFail: step.onFail || null
  };
  return response;
}

// 아직 채워지지 않은 placeholder({artifact} 등)는 다음 스텝 안내에서 원문 그대로
// 보여 준다 — 값이 생기기 전의 안내가 오류일 이유는 없다. 실행 시점(runGate)에는
// 치환 실패가 오류다.
function trySubstitute(args, substitution) {
  try {
    return substituteArgs(args, substitution);
  } catch {
    return args;
  }
}

function reportStep(start, options) {
  const context = runContext(start, options);
  if (context.fold.status !== 'running') throw new Error(`실행 중인 런만 step을 보고할 수 있습니다: ${context.fold.status}`);
  const stepId = options.step || context.fold.cursor;
  if (!stepId) throw new Error('보고할 스텝이 없습니다. 런이 이미 완료됐습니다.');
  if (stepId !== context.fold.cursor) throw new Error(`현재 cursor 스텝만 보고할 수 있습니다: ${context.fold.cursor} (요청: ${stepId})`);
  const definition = context.fold.cursorStep;
  if (!definition) throw new Error(`현재 cursor의 절차 정의를 찾지 못했습니다: ${stepId}`);
  const clientId = actorClientId(context, start, options);
  const restricted = definition.human === true || definition.verify || definition.executor === 'adapter';
  if (definition.gate) throw new Error(`게이트 스텝은 rdl run gate로만 전진합니다: ${stepId}`);
  if (restricted) {
    const reason = String(options.reason || '').trim();
    if (!options.force || !reason) throw new Error(`${stepId}은 전용 실행 경로가 필요한 스텝입니다. 명시적 승인이라면 --force --reason <사유>를 사용하세요.`);
    const forced = ledger.recordRunEvent(start, {
      project: options.project,
      runId: options.run,
      rootRequestId: options.requestId,
      event: Object.assign({ type: 'run.forced', stepId, reason, clientId }, ownershipFields(context))
    });
    return { runId: options.run, stepId, forced: true, reason, event: forced.event };
  }
  const exitCode = options.exit === undefined ? 0 : Number.parseInt(options.exit, 10);
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error('--exit는 0 이상의 정수여야 합니다.');
  const event = Object.assign({
    type: 'run.step',
    stepId,
    executor: definition ? definition.executor || 'client' : 'client',
    exitCode,
    clientId
  }, ownershipFields(context));
  if (options.artifactId) event.artifactIds = [options.artifactId];
  return ledger.recordRunEvent(start, { project: options.project, runId: options.run, rootRequestId: options.requestId, event });
}

function runGate(start, options) {
  const context = runContext(start, options);
  if (context.fold.status === 'halted') throw new Error(`정지한 런입니다(${context.fold.haltReason}). rdl run resume을 사용하세요.`);
  const stepId = options.step || context.fold.cursor;
  const step = (context.fold.cursorStep && context.fold.cursorStep.id === stepId && context.fold.cursorStep) || null;
  if (!step || !step.gate) throw new Error(`커서의 게이트 스텝이 아닙니다: ${stepId || '(없음)'}`);
  const clientId = actorClientId(context, start, options);
  if (options.force) {
    const reason = String(options.reason || '').trim();
    if (!reason) throw new Error('--force 게이트 우회에는 --reason이 필요합니다.');
    const forced = ledger.recordRunEvent(start, { project: options.project, runId: options.run, rootRequestId: options.requestId, event: Object.assign({ type: 'run.forced', stepId, reason, clientId }, ownershipFields(context)) });
    return { runId: options.run, stepId, forced: true, reason, exitCode: 0, event: forced.event };
  }
  const args = substituteArgs(step.gate.args, substitutionContext(context));
  // 게이트는 rdl 자기 자신의 하위 명령으로 제한한다. 임의 실행 파일 allowlist는
  // 자기실행 단계의 일이다. 셸을 경유하지 않는다.
  const invocation = [CLI, step.gate.command].concat(args, ['--root', context.layout.root, '--json']);
  const result = spawnSync(process.execPath, invocation, { encoding: 'utf8' });
  if (result.error) throw result.error;
  const exitCode = result.status === null ? 2 : result.status;
  let diagnostics = [];
  try {
    const parsed = JSON.parse(result.stdout);
    diagnostics = Array.from(new Set((parsed.diagnostics || []).filter((item) => item.severity === 'error').map((item) => item.code)));
  } catch {}
  ledger.recordRunEvent(start, {
    project: options.project,
    runId: options.run,
    rootRequestId: options.requestId,
    event: Object.assign({
      type: 'run.gate', stepId, command: step.gate.command, args, exitCode, diagnostics,
      attempt: (context.fold.attempts[stepId] || 0) + 1, clientId
    }, ownershipFields(context))
  });
  const fold = ledger.foldRun(ledger.readRunEvents(context.directory));
  return { runId: options.run, stepId, exitCode, diagnostics, status: fold.status, haltReason: fold.haltReason, cursor: fold.cursor, attempts: fold.attempts };
}

function resumeRun(start, options) {
  const context = runContext(start, options);
  if (context.fold.status !== 'halted') throw new Error(`정지 상태가 아닌 런은 재개할 수 없습니다: ${context.fold.status}`);
  const event = Object.assign({ type: 'run.resumed', fromStep: context.fold.cursor, clientId: actorClientId(context, start, options) }, ownershipFields(context));
  const recorded = ledger.recordRunEvent(start, { project: options.project, runId: options.run, rootRequestId: options.requestId, event });
  return { runId: options.run, fromStep: event.fromStep, event: recorded.event };
}

function haltRun(start, options) {
  const context = runContext(start, options);
  if (context.fold.status !== 'running') throw new Error(`실행 중이 아닌 런은 정지할 수 없습니다: ${context.fold.status}`);
  const event = Object.assign({ type: 'run.halted', reason: 'manual', atStep: context.fold.cursor, resumable: true, clientId: actorClientId(context, start, options) }, ownershipFields(context));
  const recorded = ledger.recordRunEvent(start, { project: options.project, runId: options.run, rootRequestId: options.requestId, event });
  return { runId: options.run, atStep: event.atStep, event: recorded.event };
}

function completeRun(start, options) {
  const context = runContext(start, options);
  const fold = context.fold;
  if (fold.status !== 'running') throw new Error(`실행 중이 아닌 런은 완료할 수 없습니다: ${fold.status}`);
  const started = context.events.find((event) => event.type === 'run.started');
  const steps = started.procedure.resolved.steps.map((step) => step.id);
  const incomplete = steps.filter((identifier) => !fold.completedSteps.includes(identifier));
  if (incomplete.length) throw new Error(`완료되지 않은 스텝이 있습니다: ${incomplete.join(', ')}`);
  const commit = runGit(['rev-parse', 'HEAD'], { cwd: context.project.root }).stdout.trim();
  const recorded = ledger.recordRunEvent(start, {
    project: options.project,
    runId: options.run,
    rootRequestId: options.requestId,
    event: Object.assign({ type: 'run.completed_local', commit, artifactIds: fold.artifactIds, clientId: actorClientId(context, start, options) }, ownershipFields(context))
  });
  return { runId: options.run, commit, event: recorded.event };
}

function takeoverRunCommand(start, options) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, options.project, true);
  authorizeClient(start, project, options.clientId);
  return ledger.takeoverRun(start, {
    project: options.project, runId: options.run, clientId: options.clientId,
    force: options.force, reason: options.reason, rootRequestId: options.requestId
  });
}

function resolveOwnershipCommand(start, options) {
  if (typeof ledger.resolveOwnership !== 'function') throw new Error('현재 커널은 ownership resolution API를 제공하지 않습니다.');
  const context = runContext(start, options);
  const client = authorizeClient(start, context.project, options.clientId);
  const reason = String(options.reason || '').trim();
  if (!reason) throw new Error('--reason <사유>가 필요합니다.');
  if (!options.conflict) throw new Error('--conflict <digest>가 필요합니다.');
  if (!options.select) throw new Error('--select <candidate-event-id>가 필요합니다.');
  if (!context.ownership || context.ownership.status === 'ACTIVE') throw new Error('ACTIVE 런에는 ownership resolve를 사용할 수 없습니다.');
  const conflict = context.ownership.conflict;
  if (!conflict || conflict.conflictId !== options.conflict) throw new Error(`현재 ownership conflict와 일치하지 않습니다: ${conflict && conflict.conflictId}`);
  const parentClientId = conflict.parentClientId;
  const isParent = client.id === parentClientId;
  if (!isParent && (!options.force || !['agent', 'service'].includes(client.type))) {
    throw new Error('부모 epoch Client가 아닌 resolver는 active agent/service와 --force가 필요합니다.');
  }
  if (!isParent && client.type === 'device') throw new Error('부모 epoch가 아닌 device Client는 ownership conflict를 강제 해결할 수 없습니다.');
  return ledger.resolveOwnership(start, {
    project: options.project,
    runId: options.run,
    conflictId: options.conflict,
    selectedDecisionEventId: options.select,
    clientId: client.id,
    resolverMemberId: client.owner,
    reason,
    force: options.force === true,
    rootRequestId: options.requestId
  });
}

function recordVerificationResult(start, options, result) {
  if (!options.run) return result;
  const context = runContext(start, options);
  const clientId = actorClientId(context, start, options, ['agent', 'service']);
  const rootRequestId = result.rootRequestId || options.requestId;
  const prior = rootRequestId && context.events.find((event) => event.rootRequestId === rootRequestId && (
    (event.type === 'run.gate' && event.command === 'verify') ||
    (event.type === 'run.halted' && ['verification-required', 'adapter-timeout'].includes(event.reason))
  ));
  if (prior) return Object.assign({}, result, {
    transition: prior.type,
    transitionEventId: prior.eventId,
    canonicalCommitted: true,
    projectionDegraded: false
  });
  const step = context.fold.cursorStep;
  if (!step || step.id !== (options.step || context.fold.cursor) || !(step.verify || step.lenses)) {
    throw new Error('검증 결과는 현재 verify cursor에만 연결할 수 있습니다.');
  }
  const targetId = result.targetId || options.positional && options.positional[0];
  const pinnedTarget = context.fold.artifactIds[context.fold.artifactIds.length - 1];
  if (!targetId || targetId !== pinnedTarget) throw new Error(`검증 대상은 런이 pin한 최신 artifact여야 합니다: ${pinnedTarget || '(없음)'}`);
  const loaded = rootRequestId ? requestJournal.loadJournal(runtimeWorkspace(context.layout.root), rootRequestId) : null;
  const shared = {
    project: context.project.key,
    runId: options.run,
    rootRequestId,
    commandDigest: loaded && loaded.journal.commandDigest
  };
  let recorded;
  if (result.status === 'passed') {
    recorded = ledger.recordRunEvent(start, Object.assign({}, shared, {
      event: Object.assign({
        type: 'run.gate', stepId: step.id, command: 'verify',
        args: [targetId].concat((result.fold && result.fold.lenses || []).map((lens) => lens.lens).sort()),
        exitCode: 0, diagnostics: [], attempt: (context.fold.attempts[step.id] || 0) + 1, clientId
      }, ownershipFields(context))
    }));
  } else if (result.status === 'refuted') {
    recorded = ledger.recordRunEvent(start, Object.assign({}, shared, {
      event: Object.assign({
        type: 'run.gate', stepId: step.id, command: 'verify',
        args: [targetId].concat((result.fold && result.fold.lenses || []).map((lens) => lens.lens).sort()),
        exitCode: 1, diagnostics: ['verification-refuted'], attempt: (context.fold.attempts[step.id] || 0) + 1, clientId
      }, ownershipFields(context))
    }));
  } else if (result.status === 'human_required') {
    recorded = ledger.recordRunEvent(start, Object.assign({}, shared, {
      event: Object.assign({ type: 'run.halted', reason: 'verification-required', atStep: step.id, resumable: true, clientId }, ownershipFields(context))
    }));
  } else if (result.exitCode === 2 && /timeout/u.test(String(result.status || ''))) {
    recorded = ledger.recordRunEvent(start, Object.assign({}, shared, {
      event: Object.assign({ type: 'run.halted', reason: 'adapter-timeout', atStep: step.id, resumable: true, clientId }, ownershipFields(context))
    }));
  } else if (result.exitCode === 2) {
    recorded = ledger.recordRunEvent(start, Object.assign({}, shared, {
      event: Object.assign({
        type: 'run.gate', stepId: step.id, command: 'verify', args: [targetId],
        exitCode: 1, diagnostics: ['verification-invalid'], attempt: (context.fold.attempts[step.id] || 0) + 1, clientId
      }, ownershipFields(context))
    }));
  } else {
    throw new Error(`run에 연결할 수 없는 verification status입니다: ${result.status}`);
  }
  return Object.assign({}, result, {
    transition: recorded.event.type,
    transitionEventId: recorded.event.eventId,
    canonicalCommitted: recorded.canonicalCommitted,
    projectionDegraded: recorded.projectionDegraded
  });
}

function requestSummary(journal) {
  const children = Object.values(journal.children).map((child) => {
    const bytes = requestJournal.decodeChild(child, journal.rootRequestId);
    const canonical = JSON.parse(bytes.toString('utf8'));
    return {
      childKey: child.childKey,
      requestId: child.requestId,
      eventId: child.eventId,
      canonicalDigest: child.canonicalDigest,
      phase: child.phase,
      type: canonical.type || null,
      projectId: canonical.projectId || null,
      runId: canonical.runId || child.runId || null
    };
  }).sort((left, right) => left.childKey.localeCompare(right.childKey));
  return {
    rootRequestId: journal.rootRequestId,
    commandDigest: journal.commandDigest,
    clientId: journal.clientId,
    phase: journal.phase,
    children
  };
}

function listRunRequests(start, options) {
  const runtime = runtimeWorkspace(workspaceLayout(start).root);
  const directory = path.join(runtime.pending, 'requests');
  if (!require('fs').existsSync(directory)) return { requests: [] };
  const requests = require('fs').readdirSync(directory)
    .filter((name) => /^REQ-[A-F0-9]{20}\.json$/u.test(name))
    .sort()
    .map((name) => requestJournal.loadJournal(runtime, name.slice(0, -5)).journal)
    .filter((journal) => !options.pending || journal.phase !== 'complete')
    .map(requestSummary);
  return { pendingOnly: options.pending === true, requests };
}

async function resumeRunRequest(start, options) {
  const rootRequestId = options.positional[1];
  if (!requestJournal.REQUEST_ID.test(rootRequestId || '')) throw new Error('rdl run request resume에는 유효한 <rootRequestId>가 필요합니다.');
  const runtime = runtimeWorkspace(workspaceLayout(start).root);
  let loaded = requestJournal.loadJournal(runtime, rootRequestId);
  if (!loaded) throw new Error(`request journal을 찾지 못했습니다: ${rootRequestId}`);
  const requestedClientId = String(options.clientId || '').trim().toLowerCase();
  if (!requestedClientId) throw new Error('--client-id <id>가 필요합니다.');
  if (requestedClientId !== loaded.journal.clientId) throw new Error(`request resume은 원래 실행 Client만 사용할 수 있습니다: ${loaded.journal.clientId}`);
  const client = getClient(start, requestedClientId);
  if (client.status !== 'active') throw new Error(`비활성 Client는 request를 재개할 수 없습니다: ${requestedClientId}`);

  let verification;
  const invocations = Object.values(loaded.journal.invocations || {});
  const invocationDescriptors = invocations.map((entry) => requestJournal.decodeInvocation(entry, rootRequestId));
  const verificationCommand = invocationDescriptors[0] && invocationDescriptors[0].command;
  let transitionExists = false;
  if (verificationCommand && verificationCommand.runId) {
    const context = runContext(start, { project: verificationCommand.project, run: verificationCommand.runId });
    transitionExists = context.events.some((event) => event.rootRequestId === rootRequestId && ((event.type === 'run.gate' && event.command === 'verify') || (event.type === 'run.halted' && ['verification-required', 'adapter-timeout'].includes(event.reason))));
  }
  if (invocations.length && (invocations.some((entry) => entry.phase !== 'complete') || (verificationCommand && verificationCommand.runId && !transitionExists))) {
    verification = await require('./verify').resumeVerificationRequest(start, loaded);
    if (verificationCommand.runId) {
      verification = recordVerificationResult(start, {
        project: verificationCommand.project,
        run: verificationCommand.runId,
        clientId: requestedClientId,
        requestId: rootRequestId,
        positional: [verificationCommand.targetId]
      }, verification);
    }
    loaded = requestJournal.loadJournal(runtime, rootRequestId);
  }

  const results = [];
  for (const child of Object.values(loaded.journal.children).sort((left, right) => left.childKey.localeCompare(right.childKey))) {
    const canonical = JSON.parse(requestJournal.decodeChild(child, rootRequestId).toString('utf8'));
    const layout = workspaceLayout(start);
    const project = canonical.projectId ? selectProject(layout, canonical.projectId, true) : null;
    if (project) authorizeClient(start, project, requestedClientId);
    if (canonical.rootRequestId !== rootRequestId || canonical.requestId !== child.requestId || canonical.eventId !== child.eventId || canonical.clientId !== requestedClientId) {
      throw new Error(`request journal identity mismatch: ${child.childKey}`);
    }
    if (child.phase === 'complete') {
      results.push({ childKey: child.childKey, requestId: child.requestId, eventId: child.eventId, phase: child.phase, status: 'already-complete' });
      continue;
    }
    const canonicalRunEvent = project && canonical.runId && canonical.type && canonical.type.startsWith('run.');
    const canonicalVerdict = project && canonical.type === 'verdict.recorded';
    if (canonicalVerdict && ['prepared', 'canonical-committed'].includes(child.phase)) {
      try {
        const repaired = require('./verify').resumeVerdictJournalChild(start, { root: loaded, child, canonical });
        results.push({ childKey: child.childKey, requestId: child.requestId, eventId: child.eventId, phase: 'complete', status: repaired.status });
        continue;
      } catch (error) {
        if (child.phase === 'canonical-committed') throw error;
        results.push({ childKey: child.childKey, requestId: child.requestId, eventId: child.eventId, phase: child.phase, status: 'unsupported-future-child' });
        continue;
      }
    }
    if (child.phase === 'canonical-committed' && canonicalRunEvent) {
      const shared = ledger.readSharedRunEvents(layout, project.key, canonical.runId);
      const committed = shared.find((event) => event.eventId === canonical.eventId && event.canonicalDigest === child.canonicalDigest);
      if (!committed) throw new Error(`canonical-committed child가 공유 원장에 없습니다: ${child.childKey}`);
      ledger.reconcileRun(start, { project: project.key, runId: canonical.runId });
      requestJournal.updateChild(loaded, child.childKey, 'complete');
      results.push({ childKey: child.childKey, requestId: child.requestId, eventId: child.eventId, phase: 'complete', status: 'projection-repaired' });
      continue;
    }
    if (child.phase === 'prepared' && canonicalRunEvent) {
      const recorded = ledger.recordRunEvent(start, {
        project: project.key,
        runId: canonical.runId,
        rootRequestId,
        childKey: child.childKey,
        commandDigest: loaded.journal.commandDigest,
        event: canonical
      });
      loaded = requestJournal.loadJournal(runtime, rootRequestId);
      results.push({ childKey: child.childKey, requestId: child.requestId, eventId: child.eventId, phase: recorded.projectionDegraded ? 'canonical-committed' : 'complete', status: recorded.projectionDegraded ? 'canonical-replayed-projection-pending' : 'canonical-replayed' });
      continue;
    }
    const canonicalDriverEvent = project && canonical.runId && typeof canonical.type === 'string' && canonical.type.startsWith('driver.');
    if (canonicalDriverEvent && ['prepared', 'canonical-committed'].includes(child.phase)) {
      driverLease.appendJournaledDriverEvent(driverEventsRoot({ layout }), canonical, {
        lockDirectory: runtime.locks,
        runtime,
        rootRequestId,
        childKey: child.childKey,
        commandDigest: loaded.journal.commandDigest
      });
      loaded = requestJournal.loadJournal(runtime, rootRequestId);
      results.push({ childKey: child.childKey, requestId: child.requestId, eventId: child.eventId, phase: 'complete', status: 'canonical-replayed' });
      continue;
    }
    if (['prepared', 'canonical-committed'].includes(child.phase)) {
      results.push({ childKey: child.childKey, requestId: child.requestId, eventId: child.eventId, phase: child.phase, status: 'unsupported-future-child' });
      continue;
    }
    throw new Error(`지원하지 않는 request child phase입니다: ${child.phase}`);
  }
  return Object.assign({ rootRequestId, clientId: requestedClientId, phase: loaded.journal.phase, children: results }, verification ? { verification } : {});
}

function listRunsCommand(start, options) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, options.project, true);
  return { project: project.key, runs: ledger.listRuns(project.root) };
}

function runLog(start, options) {
  const context = runContext(start, options);
  return { runId: options.run, project: context.project.key, events: context.events };
}

function listProceduresCommand(start, options) {
  const procedures = loadProcedures(start, options.project);
  return { procedures: procedures.names.map((name) => {
    const resolved = procedures.resolve(name);
    return { name, revision: resolved.resolved.revision, source: resolved.source, idempotent: resolved.resolved.idempotent === true, contentHash: resolved.contentHash };
  }) };
}

function driveStepClass(step) {
  const classes = [];
  if (step && step.human === true) classes.push('human');
  if (step && step.gate) classes.push('gate');
  if (step && !step.gate && step.human !== true && ['cli', 'adapter'].includes(step.executor)) classes.push(step.executor);
  if (classes.length !== 1) throw new Error(`drive step classification is invalid: ${step && step.id || '(missing)'}`);
  return classes[0];
}

function validateDriveGate(step) {
  return validateClosedDriveGate(step, 'drive preflight');
}

function preflightDriveProcedure(procedure) {
  if (!procedure || procedure.idempotent !== true || !Array.isArray(procedure.steps) || !procedure.steps.length) throw new Error('drive requires a pinned idempotent procedure');
  const byId = new Map(procedure.steps.map((step) => [step.id, step]));
  for (const step of procedure.steps) {
    const classification = driveStepClass(step);
    if (classification === 'human') continue;
    if (classification === 'gate') { validateDriveGate(step); continue; }
    if (!step.retrySafety || typeof step.retrySafety !== 'object' || Array.isArray(step.retrySafety) || !['operation-id', 'gate-recheck'].includes(step.retrySafety.mode)) throw new Error(`drive executable step requires retrySafety: ${step.id}`);
    if (step.retrySafety.mode === 'operation-id') {
      if (ledger.canonicalJson(Object.keys(step.retrySafety).sort()) !== ledger.canonicalJson(['mode'])) throw new Error(`operation-id retrySafety has unknown fields: ${step.id}`);
      const count = (step.args || []).reduce((total, value) => total + (String(value).match(/\{operationId\}/gu) || []).length, 0);
      if (classification === 'cli' && count !== 1) throw new Error(`drive CLI operation-id step requires exactly one placeholder: ${step.id}`);
      if (classification === 'adapter' && count !== 0) throw new Error(`drive adapter operation-id is injected through context.json only: ${step.id}`);
    } else {
      if (ledger.canonicalJson(Object.keys(step.retrySafety).sort()) !== ledger.canonicalJson(['gateStep', 'mode'])) throw new Error(`gate-recheck retrySafety has unknown fields: ${step.id}`);
      if ((step.args || []).some((argument) => String(argument).includes('{operationId}'))) throw new Error(`gate-recheck step cannot consume operationId: ${step.id}`);
      const gate = byId.get(step.retrySafety.gateStep);
      if (!gate || driveStepClass(gate) !== 'gate') throw new Error(`gate-recheck target is not a deterministic gate: ${step.id}`);
      validateDriveGate(gate);
    }
  }
  return procedure;
}

function driveSubstitution(context, operationId) {
  return { ...substitutionContext(context), operationId };
}

function substituteDriveArgs(args, values) {
  return (args || []).map((value) => String(value).replace(/\{(project|runId|artifact|operationId)\}/gu, (whole, key) => {
    if (values[key] === undefined || values[key] === null) throw new Error(`missing drive placeholder value: ${whole}`);
    return String(values[key]);
  }));
}

async function executeDriveCli(context, step, operationId, options) {
  const settings = options || {};
  const args = substituteDriveArgs(step.args, driveSubstitution(context, operationId));
  const timeoutSeconds = settings.timeoutSeconds === undefined ? 600 : settings.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error('drive CLI timeoutSeconds is invalid');
  const adapterKernel = require('./adapter');
  const result = await adapterKernel.executeOnce(settings.executable || process.execPath, [settings.cliEntry || CLI, step.command].concat(args, ['--root', context.layout.root, '--json']), {
    cwd: context.layout.root,
    env: adapterKernel.adapterEnvironment(process.env),
    timeoutSeconds,
    signal: settings.signal
  });
  if (!['success', 'child-failure'].includes(result.category)) {
    const diagnostic = result.category === 'timeout'
      ? 'DRIVE_CLI_TIMEOUT'
      : result.category === 'cancelled' ? 'DRIVE_CLI_CANCELLED' : 'DRIVE_SPAWN_FAILED';
    return { exitCode: 2, diagnosticCodes: [diagnostic], artifactIds: [] };
  }
  const exitCode = Number.isSafeInteger(result.code) && [0, 1, 2].includes(result.code) ? result.code : 2;
  let parsed;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch { return { exitCode: 2, diagnosticCodes: ['DRIVE_CLI_INVALID_OUTPUT'], artifactIds: [] }; }
  const artifactIds = Array.from(new Set([].concat(parsed.artifactIds || [], parsed.id || []).filter(Boolean).map(String))).sort();
  return { exitCode, artifactIds, diagnosticCodes: [] };
}

function executeDriveGate(context, step) {
  const args = substituteDriveArgs(step.gate.args, driveSubstitution(context, null));
  const result = spawnSync(process.execPath, [CLI, 'check'].concat(args, ['--root', context.layout.root, '--json']), { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error) return { exitCode: 2, diagnosticCodes: ['DRIVE_GATE_SPAWN_FAILED'] };
  const exitCode = result.status === null ? 2 : result.status;
  let diagnostics = [];
  try { diagnostics = Array.from(new Set((JSON.parse(result.stdout || '{}').diagnostics || []).filter((item) => item.severity === 'error').map((item) => item.code))).sort(); } catch {}
  return { exitCode, diagnosticCodes: diagnostics, args };
}

function operationForStep(context, step, outcomeKind, exitCode, values) {
  const logicalAttempt = ledger.logicalAttemptForStep(context.events, step.id);
  const operationId = ledger.operationIdFor({ runId: context.fold.runId, procedureContentHash: context.fold.procedure.contentHash, stepId: step.id, logicalAttempt });
  const input = values || {};
  return ledger.createOperation({
    operationId, stepId: step.id, logicalAttempt, outcomeKind, exitCode,
    sortedArtifactIds: input.artifactIds || [], sortedDiagnosticCodes: input.diagnosticCodes || [],
    boundedResultDecision: input.boundedResultDecision
  });
}

function driverEventsRoot(context) {
  if (!context.layout || context.layout.schemaVersion < 6) throw new Error('drive requires a canonical workspace driver event store');
  return path.join(context.layout.root, 'projects', 'workspace', 'events');
}

function driverEventIdentity(rootRequestId, childKey) {
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  return { rootRequestId, requestId, eventId: requestJournal.eventIdForRequest(requestId) };
}

// leaseId는 (operationId, clientId, ownerToken, rootRequestId)의 함수다 — 파티션의
// 두 실행자도, 크래시 후 새 root로 재기동한 같은 실행자도 각자 별도의 유효 사슬을
// 갖는다(규범: 여러 유효 사슬은 전부 노출). operationId 하나로 파생하면 그 모든
// 경우가 한 사슬에 충돌해 사슬 전체가 invalid로 오염된다.
function driverLeaseId(operationId, clientId, ownerToken, rootRequestId) {
  return `LEASE-${crypto.createHash('sha256').update(`drive-lease\0${operationId}\0${clientId}\0${ownerToken}\0${rootRequestId}`).digest('hex').slice(0, 20).toUpperCase()}`;
}

function driveChildKey(category, operationId, mutationKind, predecessorEventId) {
  if (!['driver', 'outcome', 'halt', 'release'].includes(category)) throw new Error(`invalid drive child category: ${category}`);
  if (!/^[a-f0-9]{64}$/u.test(operationId || '')) throw new Error('drive child operationId must be a lowercase SHA-256 digest');
  if (!/^[a-z][a-z0-9-]*$/u.test(mutationKind || '')) throw new Error(`invalid drive child mutation kind: ${mutationKind || '(missing)'}`);
  const predecessor = predecessorEventId || '';
  if (predecessor && !/^EVT-[A-F0-9]{20}$/u.test(predecessor)) throw new Error(`invalid drive child predecessor: ${predecessor}`);
  return `${category}:${operationId}:${mutationKind}:${predecessor}`;
}

function driveCommandDigest(context, options) {
  return ledger.sha256(Buffer.from(ledger.canonicalJson({
    command: 'run.drive',
    projectId: context.project.key,
    runId: context.fold.runId,
    clientId: options.clientId,
    scheduled: options.scheduled === true
  }), 'utf8'));
}

function driverExpiry(now, ttlSeconds) {
  const instant = typeof now === 'function' ? now() : Date.now();
  const milliseconds = instant instanceof Date ? instant.getTime() : Number(instant);
  if (!Number.isFinite(milliseconds)) throw new Error('drive lease clock is invalid');
  return new Date(milliseconds + ttlSeconds * 1000).toISOString();
}

function defaultLeaseSettings(start, context, dependencies) {
  return dependencies.leaseSettings
    || dependencies.pinnedHarness && dependencies.pinnedHarness.runtimeResolved.lease
    || loadHarnessSettings(start, { project: context.project.key }).runtimeResolved.lease;
}

function defaultSyncSettings(start, context, dependencies) {
  return dependencies.syncSettings
    || dependencies.pinnedHarness && dependencies.pinnedHarness.runtimeResolved.sync
    || loadHarnessSettings(start, { project: context.project.key }).runtimeResolved.sync;
}

function defaultDriverStore(context, dependencies) {
  return {
    api: dependencies.driverLease || driverLease,
    eventsRoot: dependencies.driverEventsRoot || driverEventsRoot(context),
    lockDirectory: dependencies.driverLockDirectory || runtimeWorkspace(context.layout.root).locks,
    runtime: dependencies.driverRuntime || runtimeWorkspace(context.layout.root)
  };
}

function acquireDefaultDriverLease(start, options, context, step, operationId, commandDigest, dependencies) {
  const settings = defaultLeaseSettings(start, context, dependencies);
  const childKey = driveChildKey('driver', operationId, 'acquire');
  const identity = driverEventIdentity(options.requestId, childKey);
  const leaseId = driverLeaseId(operationId, options.clientId, context.ownership.ownerToken, options.requestId);
  const expiresAt = driverExpiry(dependencies.now, settings.ttlSeconds);
  const store = defaultDriverStore(context, dependencies);
  const recorded = store.api.acquireDriverLease(store.eventsRoot, {
    schemaVersion: 1, ...identity, type: 'driver.acquired', clientId: options.clientId,
    projectId: context.project.key, runId: context.fold.runId, leaseId,
    ownerToken: context.ownership.ownerToken, operationId, expiresAt
  }, { lockDirectory: store.lockDirectory, runtime: store.runtime, rootRequestId: options.requestId, childKey, commandDigest });
  return { leaseId, currentEventId: recorded.event.eventId, renewal: 0, expiresAt, settings };
}

function renewDefaultDriverLease(start, options, context, operationId, commandDigest, lease, dependencies) {
  const renewal = lease.renewal + 1;
  const childKey = driveChildKey('driver', operationId, 'renew', lease.currentEventId);
  const identity = driverEventIdentity(options.requestId, childKey);
  const expiresAt = driverExpiry(dependencies.now, lease.settings.ttlSeconds);
  const store = defaultDriverStore(context, dependencies);
  const recorded = store.api.renewDriverLease(store.eventsRoot, {
    schemaVersion: 1, ...identity, type: 'driver.renewed', clientId: options.clientId,
    projectId: context.project.key, runId: context.fold.runId, leaseId: lease.leaseId,
    ownerToken: context.ownership.ownerToken, operationId,
    previousDriverEventId: lease.currentEventId, expiresAt
  }, { lockDirectory: store.lockDirectory, runtime: store.runtime, rootRequestId: options.requestId, childKey, commandDigest });
  lease.currentEventId = recorded.event.eventId;
  lease.renewal = renewal;
  lease.expiresAt = expiresAt;
  return lease;
}

function releaseDefaultDriverLease(start, options, context, operationId, commandDigest, lease, reason, dependencies) {
  const childKey = driveChildKey('release', operationId, reason, lease.currentEventId);
  const identity = driverEventIdentity(options.requestId, childKey);
  const store = defaultDriverStore(context, dependencies);
  return store.api.releaseDriverLease(store.eventsRoot, {
    schemaVersion: 1, ...identity, type: 'driver.released', clientId: options.clientId,
    projectId: context.project.key, runId: context.fold.runId, leaseId: lease.leaseId,
    ownerToken: context.ownership.ownerToken, operationId,
    previousDriverEventId: lease.currentEventId, reason
  }, { lockDirectory: store.lockDirectory, runtime: store.runtime, rootRequestId: options.requestId, childKey, commandDigest });
}

function synchronizeDefaultDriverLease(start, context, dependencies) {
  return require('./settings').finalizeSettings(start, { retryPolicy: defaultSyncSettings(start, context, dependencies) });
}

function startLeaseHeartbeat(input) {
  let active = true;
  let timer = null;
  let rejectFailure;
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  const clear = input.clearTimer || clearTimeout;
  const scheduleTimer = input.setTimer || setTimeout;
  const schedule = () => {
    timer = scheduleTimer(async () => {
      timer = null;
      if (!active) return;
      try {
        await input.beat();
      } catch (error) {
        if (!active) return;
        active = false;
        rejectFailure(error);
        input.abort(error);
        return;
      }
      if (active) schedule();
    }, input.intervalMs);
  };
  schedule();
  return {
    failure,
    stop() {
      if (!active) return;
      active = false;
      if (timer !== null) clear(timer);
      timer = null;
    }
  };
}

async function tickRun(start, options, dependencies) {
  const deps = dependencies || {};
  const context = deps.runContext ? await deps.runContext(start, options) : runContext(start, options);
  const commandDigest = deps.driveCommandDigest || driveCommandDigest(context, options);
  if (!context.ownership || context.ownership.status !== 'ACTIVE' || context.owner !== options.clientId) return { exitCode: 1, status: 'ownership_lost' };
  if (context.fold.status === 'operation-conflict') return { exitCode: 1, status: 'operation_conflict', conflicts: context.fold.operationConflicts };
  if (['completed_local', 'synced'].includes(context.fold.status) || (!context.fold.cursor && context.fold.status === 'running')) return { exitCode: 0, status: 'completed' };
  if (context.fold.status === 'halted') return { exitCode: 1, status: 'halted', reason: context.fold.haltReason };
  if (context.fold.status !== 'running') return { exitCode: 1, status: context.fold.status };
  const step = context.fold.cursorStep;
  const classification = driveStepClass(step);
  if (classification === 'human') return { exitCode: 0, status: 'waiting_human', step: step.id };
  const record = async (event, childKey) => {
    if (deps.recordEvent) return deps.recordEvent(context, event, childKey);
    return ledger.recordRunEvent(start, { project: context.project.key, runId: context.fold.runId, rootRequestId: options.requestId, childKey, commandDigest, event });
  };
  const gateExecutor = deps.executeGate || ((input) => executeDriveGate(context, input.step));
  if (classification === 'gate') {
    const attempt = ledger.logicalAttemptForStep(context.events, step.id);
    const operationId = ledger.operationIdFor({ runId: context.fold.runId, procedureContentHash: context.fold.procedure.contentHash, stepId: step.id, logicalAttempt: attempt });
    const result = await gateExecutor({ context, step, operationId, recheck: false });
    if (![0, 1, 2].includes(result.exitCode)) throw new Error('drive gate returned an invalid exit code');
    if (result.exitCode === 2) return { exitCode: 2, status: 'error', code: 'gate-environment' };
    const kind = result.exitCode === 0 ? 'gate-passed' : 'gate-failed';
    const diagnostics = Array.from(new Set(result.diagnosticCodes || [])).sort();
    const operation = ledger.createOperation({ operationId, stepId: step.id, logicalAttempt: attempt, outcomeKind: kind, exitCode: result.exitCode, sortedArtifactIds: [], sortedDiagnosticCodes: diagnostics, boundedResultDecision: { diagnostics } });
    await record({ type: 'run.gate', stepId: step.id, command: 'check', args: substituteDriveArgs(step.gate.args, driveSubstitution(context, null)), exitCode: result.exitCode, diagnostics, clientId: options.clientId, ownerToken: context.ownership.ownerToken, operation }, driveChildKey('outcome', operationId, kind));
    if (result.exitCode === 1) {
      await record({ type: 'run.halted', reason: 'gate-failed', atStep: step.id, resumable: true, clientId: options.clientId, ownerToken: context.ownership.ownerToken }, driveChildKey('halt', operationId, 'gate-failed'));
      return { exitCode: 1, status: 'halted', reason: 'gate-failed', operationId };
    }
    return { exitCode: 0, status: 'continue', operationId };
  }
  const logicalAttempt = ledger.logicalAttemptForStep(context.events, step.id);
  const operationId = ledger.operationIdFor({ runId: context.fold.runId, procedureContentHash: context.fold.procedure.contentHash, stepId: step.id, logicalAttempt });
  if (step.retrySafety.mode === 'gate-recheck') {
    const started = context.events.find((event) => event.type === 'run.started');
    const recheck = started.procedure.resolved.steps.find((candidate) => candidate.id === step.retrySafety.gateStep);
    const result = await gateExecutor({ context, step: recheck, operationId, recheck: true });
    if (result.exitCode === 2) return { exitCode: 2, status: 'error', code: 'gate-recheck-environment', operationId };
    if (result.exitCode === 0) {
      const artifactIds = context.fold.artifactIds.slice().sort();
      const operation = ledger.createOperation({ operationId, stepId: step.id, logicalAttempt, outcomeKind: 'step-completed', exitCode: 0, sortedArtifactIds: artifactIds, sortedDiagnosticCodes: [], boundedResultDecision: { artifactIds } });
      await record({ type: 'run.step', stepId: step.id, executor: step.executor, exitCode: 0, artifactIds, clientId: options.clientId, ownerToken: context.ownership.ownerToken, operation }, driveChildKey('outcome', operationId, 'step-completed'));
      return { exitCode: 0, status: 'continue', operationId, rechecked: true };
    }
  }
  let lease;
  const usesDefaultLease = !deps.acquireLease;
  try {
    lease = deps.acquireLease
      ? await deps.acquireLease({ context, step, operationId, logicalAttempt })
      : acquireDefaultDriverLease(start, options, context, step, operationId, commandDigest, deps);
  } catch (error) {
    await record({ type: 'run.halted', reason: 'lease-lost', atStep: step.id, resumable: true, clientId: options.clientId, ownerToken: context.ownership.ownerToken }, driveChildKey('halt', operationId, 'lease-lost'));
    return { exitCode: 1, status: 'halted', reason: 'lease-lost', operationId };
  }
  // acquire 후 read-back: 기록만 하고 다시 읽지 않는 lease는 소프트 조정조차 아니다.
  // 자기 사슬이 invalid면 진행하지 않고, 파티션의 다른 유효 사슬은 상호 배제 약속이
  // 아니라 가시성으로 결과에 노출한다 — 실행 안전은 operationId 멱등성이 보증한다.
  let leaseContention = [];
  const readBackStore = usesDefaultLease && lease && lease.leaseId ? defaultDriverStore(context, deps) : null;
  if (readBackStore && typeof readBackStore.api.readDriverEvents === 'function' && typeof readBackStore.api.foldDriverLeases === 'function') {
    const store = readBackStore;
    const nowValue = deps.now === undefined ? Date.now() : (typeof deps.now === 'function' ? deps.now() : deps.now);
    const leaseFold = store.api.foldDriverLeases(store.api.readDriverEvents(store.eventsRoot, context.project.key, context.fold.runId), { now: nowValue });
    const mine = leaseFold.leases.find((entry) => entry.leaseId === lease.leaseId);
    if (!mine || mine.status === 'invalid') {
      await record({ type: 'run.halted', reason: 'lease-lost', atStep: step.id, resumable: true, clientId: options.clientId, ownerToken: context.ownership.ownerToken }, driveChildKey('halt', operationId, 'lease-lost'));
      return { exitCode: 1, status: 'halted', reason: 'lease-lost', operationId };
    }
    leaseContention = (leaseFold.activeLeases || []).filter((entry) => entry.leaseId !== lease.leaseId).map((entry) => ({ leaseId: entry.leaseId, clientId: entry.clientId }));
  }
  let leaseReleased = false;
  const releaseLease = async (reason) => {
    if (!lease || leaseReleased) return;
    leaseReleased = true;
    if (deps.releaseLease) await deps.releaseLease({ lease, reason, context, operationId });
    else if (usesDefaultLease) await releaseDefaultDriverLease(start, options, context, operationId, commandDigest, lease, reason, deps);
  };
  let result;
  const controller = new AbortController();
  const leaseSettings = lease && lease.settings
    || deps.leaseSettings
    || (usesDefaultLease ? defaultLeaseSettings(start, context, deps) : { ttlSeconds: 300, renewFactor: 0.5 });
  const intervalMs = deps.heartbeatIntervalMs === undefined
    ? Math.round(leaseSettings.ttlSeconds * leaseSettings.renewFactor * 1000)
    : deps.heartbeatIntervalMs;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('drive lease heartbeat interval is invalid');
  const heartbeat = startLeaseHeartbeat({
    intervalMs,
    setTimer: deps.setHeartbeatTimer,
    clearTimer: deps.clearHeartbeatTimer,
    abort: (reason) => controller.abort(reason),
    beat: async () => {
      if (deps.renewLease) await deps.renewLease({ lease, context, step, operationId });
      else if (usesDefaultLease) renewDefaultDriverLease(start, options, context, operationId, commandDigest, lease, deps);
      if (deps.syncLease) {
        const retryPolicy = deps.syncSettings || deps.pinnedHarness && deps.pinnedHarness.runtimeResolved.sync;
        await deps.syncLease({ lease, context, step, operationId, ...(retryPolicy ? { retryPolicy } : {}) });
      }
      else if (usesDefaultLease) await synchronizeDefaultDriverLease(start, context, deps);
    }
  });
  try {
    const action = classification === 'cli'
      ? (deps.executeCli || ((input) => executeDriveCli(context, input.step, input.operationId, {
        signal: input.signal,
        timeoutSeconds: deps.cliTimeoutSeconds !== undefined
          ? deps.cliTimeoutSeconds
          : deps.pinnedHarness && deps.pinnedHarness.runtimeResolved.adapter.timeoutSeconds,
        cliEntry: deps.driveCliEntry,
        executable: deps.driveCliExecutable
      })))({ context, step, operationId, signal: controller.signal })
      : (deps.executeAdapter || ((input) => require('./adapter').runAdapterCommand(start, { ...options, step: step.id, mode: step.verify ? 'verify' : 'author', adapter: typeof step.adapter === 'string' ? step.adapter : step.adapter && step.adapter.name, operationId, signal: input.signal })))({ context, step, operationId, signal: controller.signal });
    const actionPromise = Promise.resolve(action);
    try {
      result = await Promise.race([actionPromise, heartbeat.failure]);
    } catch (error) {
      controller.abort(error);
      await actionPromise.catch(() => {});
      throw error;
    } finally {
      heartbeat.stop();
    }
  } catch (error) {
    heartbeat.stop();
    try { await releaseLease('lost'); } catch {}
    await record({ type: 'run.halted', reason: 'lease-lost', atStep: step.id, resumable: true, clientId: options.clientId, ownerToken: context.ownership.ownerToken }, driveChildKey('halt', operationId, 'lease-lost'));
    return { exitCode: 1, status: 'halted', reason: 'lease-lost', operationId };
  }
  let releaseReason = 'error';
  try {
    if (!result || !Number.isSafeInteger(result.exitCode) || result.exitCode < 0) throw new Error('drive executor returned an invalid result');
    if (result.exitCode === 2) {
      return { exitCode: 2, status: 'error', code: 'executor-environment', operationId };
    }
    const artifactIds = Array.from(new Set((result.result && result.result.artifactIds || result.artifactIds || []).map(String))).sort();
    const diagnosticCodes = Array.from(new Set(result.diagnosticCodes || [])).sort();
    const kind = result.exitCode === 0 ? 'step-completed' : 'step-failed';
    const boundedResultDecision = kind === 'step-completed' ? { artifactIds } : { failureCode: result.failureCode || 'DRIVE_STEP_FAILED' };
    const operation = ledger.createOperation({ operationId, stepId: step.id, logicalAttempt, outcomeKind: kind, exitCode: result.exitCode, sortedArtifactIds: artifactIds, sortedDiagnosticCodes: diagnosticCodes, boundedResultDecision });
    await record({ type: 'run.step', stepId: step.id, executor: step.executor, exitCode: result.exitCode, artifactIds, clientId: options.clientId, ownerToken: context.ownership.ownerToken, operation }, driveChildKey('outcome', operationId, kind));
    releaseReason = result.exitCode === 0 ? 'completed' : 'halted';
    return { exitCode: result.exitCode === 0 ? 0 : 1, status: result.exitCode === 0 ? 'continue' : 'halted', reason: result.exitCode === 0 ? undefined : 'step-failed', operationId, ...(leaseContention.length ? { leaseContention } : {}) };
  } finally {
    await releaseLease(releaseReason);
  }
}

function pinnedDrivePreflight(start, options) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, options.project, true);
  const local = ledger.readRunEvents(ledger.runDirectory(project.root, options.run));
  const shared = ledger.readSharedRunEvents(layout, project.key, options.run);
  const events = ledger.unionRunEvents(local, shared);
  const started = events.find((event) => event.type === 'run.started');
  if (!started) throw new Error(`run not found: ${options.run}`);
  preflightDriveProcedure(started.procedure.resolved);
  const client = authorizeClient(start, project, options.clientId, ['agent', 'service']);
  const ownership = ledger.ownershipState(events);
  if (ownership.status !== 'ACTIVE') throw new Error('drive requires unambiguous ACTIVE ownership');
  if (ownership.ownerClientId !== client.id) throw new Error(`drive client is not the current owner: ${ownership.ownerClientId}`);
  const harness = loadHarnessSettings(start, { project: project.key });
  if (ledger.canonicalJson(started.settings.safeResolved) !== ledger.canonicalJson(harness.safeResolved)) throw new Error('settings-drift');
  if (options.scheduled && harness.runtimeResolved.drive.schedulerClientId !== client.id) throw new Error('scheduled drive client does not match drive.schedulerClientId');
  for (const step of started.procedure.resolved.steps.filter((item) => item.executor === 'adapter' && item.retrySafety && item.retrySafety.mode === 'operation-id')) {
    const name = typeof step.adapter === 'string' ? step.adapter : step.adapter && step.adapter.name;
    const adapter = name && harness.runtimeResolved.adapters[name];
    if (!adapter || adapter.enabled !== true) throw new Error(`drive adapter is not enabled: ${name || step.id}`);
    if (adapter.argsTemplate.some((argument) => String(argument).includes('{operationId}'))) throw new Error(`drive adapter operationId must use context.json, not argv: ${name}`);
  }
  return { layout, project, started, client, harness };
}

async function runDrive(start, options, dependencies) {
  const deps = dependencies || {};
  const preflight = deps.preflight ? await deps.preflight(start, options) : pinnedDrivePreflight(start, options);
  const driveDependencies = preflight.harness && !deps.pinnedHarness ? { ...deps, pinnedHarness: preflight.harness } : deps;
  const lock = deps.acquireLock
    ? await deps.acquireLock({ preflight, options })
    : require('./runtime').acquireProcessLock(runtimeWorkspace(preflight.layout.root), `drive-${preflight.project.key}-${options.run.toLowerCase()}`);
  const requestId = options.requestId || ledger.newRequestId();
  try {
    for (;;) {
      const result = await tickRun(start, { ...options, requestId }, driveDependencies);
      if (result.status !== 'continue') return { ...result, rootRequestId: requestId };
    }
  } finally {
    if (typeof lock === 'function') await lock();
    else if (lock && typeof lock.release === 'function') await lock.release();
  }
}

async function resolveOperation(start, options) {
  const context = runContext(start, options);
  const client = authorizeClient(start, context.project, options.clientId, ['agent', 'service']);
  if (!context.ownership || context.ownership.status !== 'ACTIVE') throw new Error('operation resolution requires ACTIVE ownership');
  const state = ledger.operationOutcomeState(context.ownership.visibleEvents);
  const conflict = state.conflicts.find((item) => item.operationId === options.operation && item.conflictId === options.conflict);
  if (!conflict) throw new Error('stale or unknown operation conflict');
  const selected = conflict.candidates.find((item) => item.decisionEventId === options.select);
  if (!selected) throw new Error('selected event is not a current operation candidate');
  const isOwner = client.id === context.owner;
  if (!isOwner && !options.force) throw new Error('a non-owner operation resolver requires --force');
  const reason = String(options.reason || '').trim();
  if (!reason) throw new Error('operation resolution requires --reason');
  const recorded = ledger.recordRunEvent(start, {
    project: context.project.key, runId: options.run, rootRequestId: options.requestId,
    childKey: `operation-resolve:${options.operation}:${options.conflict}`,
    event: { type: 'run.operation_resolved', clientId: client.id, ownerToken: context.ownership.ownerToken, operationId: options.operation, conflictId: conflict.conflictId, candidates: conflict.candidates, selectedDecisionEventId: selected.decisionEventId, selectedOutcomeDigest: selected.selectedOutcomeDigest, resolverMemberId: client.owner, reason, forced: !isOwner }
  });
  return { exitCode: 0, status: 'resolved', operationId: options.operation, conflictId: conflict.conflictId, event: recorded.event };
}

module.exports = {
  startRun, nextStep, reportStep, runGate, resumeRun, haltRun, completeRun,
  takeoverRunCommand, resolveOwnershipCommand, listRunRequests, resumeRunRequest,
  recordVerificationResult,
  listRunsCommand, runLog, listProceduresCommand,
  runContext, authorizeClient,
  driveStepClass, validateDriveGate, preflightDriveProcedure, substituteDriveArgs,
  driveCommandDigest, driveChildKey, executeDriveCli, tickRun, runDrive, resolveOperation
};
