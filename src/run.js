'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { workspaceLayout, selectProject } = require('./workspace');
const { runGit } = require('./git');
const ledger = require('./run-ledger');
const { loadProcedures, substituteArgs } = require('./procedure');

const CLI = path.join(__dirname, '..', 'bin', 'rdl.js');

function runContext(start, options) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, options.project, true);
  const directory = ledger.runDirectory(project.root, options.run);
  const events = ledger.readRunEvents(directory);
  if (!events.length) throw new Error(`런을 찾지 못했습니다: ${options.run}`);
  return { layout, project, directory, events, fold: ledger.foldRun(events), owner: ledger.runOwner(events) };
}

// 명령을 내리는 주체는 런의 현재 소유자다. --client-id를 명시하면 소유자와
// 일치해야 한다 — 다른 클라이언트는 takeover를 거쳐야만 쓸 수 있다 (LAW-1).
function actorClientId(context, options) {
  const requested = options.clientId ? String(options.clientId).trim().toLowerCase() : null;
  if (requested && context.owner && requested !== context.owner) {
    throw new Error(`${requested}는 이 런의 소유자가 아닙니다. 현재 소유자: ${context.owner}. rdl run takeover를 사용하세요.`);
  }
  return requested || context.owner;
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
  return ledger.createRun(start, { project: options.project, goal: options.goal, clientId: options.clientId, procedure: resolved.resolved });
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
  if (context.fold.status === 'halted') throw new Error(`정지한 런입니다(${context.fold.haltReason}). rdl run resume을 사용하세요.`);
  const stepId = options.step || context.fold.cursor;
  if (!stepId) throw new Error('보고할 스텝이 없습니다. 런이 이미 완료됐습니다.');
  const definition = context.fold.cursorStep && context.fold.cursorStep.id === stepId ? context.fold.cursorStep : null;
  if (definition && definition.gate) throw new Error(`게이트 스텝은 rdl run gate로만 전진합니다: ${stepId}`);
  const exitCode = options.exit === undefined ? 0 : Number.parseInt(options.exit, 10);
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error('--exit는 0 이상의 정수여야 합니다.');
  const event = {
    type: 'run.step',
    stepId,
    executor: definition ? definition.executor || 'client' : 'client',
    exitCode,
    clientId: actorClientId(context, options)
  };
  if (options.artifactId) event.artifactIds = [options.artifactId];
  return ledger.recordRunEvent(start, { project: options.project, runId: options.run, event });
}

function runGate(start, options) {
  const context = runContext(start, options);
  if (context.fold.status === 'halted') throw new Error(`정지한 런입니다(${context.fold.haltReason}). rdl run resume을 사용하세요.`);
  const stepId = options.step || context.fold.cursor;
  const step = (context.fold.cursorStep && context.fold.cursorStep.id === stepId && context.fold.cursorStep) || null;
  if (!step || !step.gate) throw new Error(`커서의 게이트 스텝이 아닙니다: ${stepId || '(없음)'}`);
  const clientId = actorClientId(context, options);
  if (options.force) {
    const reason = String(options.reason || '').trim();
    if (!reason) throw new Error('--force 게이트 우회에는 --reason이 필요합니다.');
    const forced = ledger.recordRunEvent(start, { project: options.project, runId: options.run, event: { type: 'run.forced', stepId, reason, clientId } });
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
    event: { type: 'run.gate', stepId, exitCode, diagnostics, clientId }
  });
  const fold = ledger.foldRun(ledger.readRunEvents(context.directory));
  return { runId: options.run, stepId, exitCode, diagnostics, status: fold.status, haltReason: fold.haltReason, cursor: fold.cursor, attempts: fold.attempts };
}

function resumeRun(start, options) {
  const context = runContext(start, options);
  if (context.fold.status !== 'halted') throw new Error(`정지 상태가 아닌 런은 재개할 수 없습니다: ${context.fold.status}`);
  const event = { type: 'run.resumed', fromStep: context.fold.cursor, clientId: actorClientId(context, options) };
  const recorded = ledger.recordRunEvent(start, { project: options.project, runId: options.run, event });
  return { runId: options.run, fromStep: event.fromStep, event: recorded.event };
}

function haltRun(start, options) {
  const context = runContext(start, options);
  if (context.fold.status !== 'running') throw new Error(`실행 중이 아닌 런은 정지할 수 없습니다: ${context.fold.status}`);
  const event = { type: 'run.halted', reason: 'manual', atStep: context.fold.cursor, resumable: true, clientId: actorClientId(context, options) };
  const recorded = ledger.recordRunEvent(start, { project: options.project, runId: options.run, event });
  return { runId: options.run, atStep: event.atStep, event: recorded.event };
}

function completeRun(start, options) {
  const context = runContext(start, options);
  const fold = context.fold;
  if (fold.status !== 'running') throw new Error(`실행 중이 아닌 런은 완료할 수 없습니다: ${fold.status}`);
  const steps = context.events[0].procedure.resolved.steps.map((step) => step.id);
  const incomplete = steps.filter((identifier) => !fold.completedSteps.includes(identifier));
  if (incomplete.length) throw new Error(`완료되지 않은 스텝이 있습니다: ${incomplete.join(', ')}`);
  const commit = runGit(['rev-parse', 'HEAD'], { cwd: context.project.root }).stdout.trim();
  const recorded = ledger.recordRunEvent(start, {
    project: options.project,
    runId: options.run,
    event: { type: 'run.completed_local', commit, clientId: actorClientId(context, options) }
  });
  return { runId: options.run, commit, event: recorded.event };
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

module.exports = { startRun, nextStep, reportStep, runGate, resumeRun, haltRun, completeRun, listRunsCommand, runLog, listProceduresCommand };
