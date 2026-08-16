'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');

const RUN_ID = /^RUN-[A-F0-9]{20}$/u;
const CHECKPOINT_TYPES = new Set(['run.started', 'run.halted', 'run.resumed', 'run.completed_local']);
const HALT_REASONS = new Set(['gate-failed', 'merge-conflict', 'sync-failed', 'adapter-timeout', 'lease-lost', 'attempt-limit', 'manual']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function newRunId() {
  return `RUN-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

function runsRoot(projectRoot) {
  return path.join(projectRoot, '.rundol', 'runs');
}

function runDirectory(projectRoot, runId) {
  if (!RUN_ID.test(runId || '')) throw new Error(`잘못된 run ID입니다: ${runId || '(없음)'}`);
  return path.join(runsRoot(projectRoot), runId);
}

// 절차 최소 형태 검증: P1의 평가기 이전에도 fold가 커서를 계산할 수 있는 만큼만 요구한다.
function validateProcedure(procedure) {
  if (!procedure || typeof procedure !== 'object') throw new Error('절차 정의가 필요합니다.');
  if (!/^[a-z][a-z0-9.-]*$/u.test(procedure.name || '')) throw new Error(`잘못된 절차 이름입니다: ${procedure.name || '(없음)'}`);
  if (!Number.isInteger(procedure.revision) || procedure.revision < 1) throw new Error('절차 revision은 1 이상의 정수여야 합니다.');
  if (!Array.isArray(procedure.steps) || procedure.steps.length === 0) throw new Error('절차에는 1개 이상의 스텝이 필요합니다.');
  const seen = new Set();
  for (const step of procedure.steps) {
    if (!/^[a-z][a-z0-9-]*$/u.test(step.id || '')) throw new Error(`잘못된 스텝 ID입니다: ${step.id || '(없음)'}`);
    if (seen.has(step.id)) throw new Error(`중복된 스텝 ID입니다: ${step.id}`);
    seen.add(step.id);
    if (step.onFail) {
      if (!seen.has(step.onFail.goto)) throw new Error(`onFail.goto는 앞선 스텝만 가리킬 수 있습니다: ${step.id} → ${step.onFail.goto}`);
      if (!Number.isInteger(step.onFail.maxAttempts) || step.onFail.maxAttempts < 1) throw new Error(`onFail.maxAttempts는 1 이상의 정수여야 합니다: ${step.id}`);
    }
  }
  return procedure;
}

// 크래시 절단 복구: 파일이 개행으로 끝나지 않으면 마지막 개행 이후를 잘라낸다.
// 읽기의 관용적 꼬리 무시와 같은 의미론을 쓰기 쪽에서 결정적으로 적용한 것이다 —
// 복구 없이 append하면 절단분과 새 이벤트가 한 줄로 붙어 원장이 파손된다.
function repairTail(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  if (!content || content.endsWith('\n')) return;
  const cut = content.lastIndexOf('\n');
  fs.truncateSync(file, cut < 0 ? 0 : Buffer.byteLength(content.slice(0, cut + 1), 'utf8'));
}

function appendRunEvent(directory, event) {
  if (!event || !event.type) throw new Error('이벤트 type이 필요합니다.');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'events.jsonl');
  repairTail(file);
  const safe = Object.assign({
    schemaVersion: 1,
    eventId: `EVT-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
    occurredAt: new Date().toISOString()
  }, event);
  delete safe.prompt;
  delete safe.content;
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
  if (CHECKPOINT_TYPES.has(safe.type)) {
    const descriptor = fs.openSync(file, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  return { file, event: safe };
}

// 관용적 꼬리 파싱: 마지막 줄의 불완전 JSON은 크래시 절단으로 보고 무시한다.
// 중간 줄 손상은 원장 파손이므로 오류다.
function readRunEvents(directory) {
  const file = path.join(directory, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).map((line, index) => ({ line, index })).filter((entry) => entry.line.trim());
  const events = [];
  for (const [position, entry] of lines.entries()) {
    try {
      events.push(JSON.parse(entry.line));
    } catch (error) {
      if (position === lines.length - 1) break;
      throw new Error(`${file}:${entry.index + 1}의 이벤트를 파싱할 수 없습니다: ${error.message}`);
    }
  }
  return events;
}

function createRun(start, input) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, input.project, true);
  const procedure = validateProcedure(input.procedure);
  const clientId = String(input.clientId || '').trim().toLowerCase();
  if (!clientId) throw new Error('--client-id <Client ID>가 필요합니다.');
  const runId = newRunId();
  const directory = runDirectory(project.root, runId);
  const contentHash = crypto.createHash('sha256').update(canonicalJson(procedure)).digest('hex');
  const appended = appendRunEvent(directory, {
    type: 'run.started',
    runId,
    projectId: project.key,
    clientId,
    goal: String(input.goal || '').trim() || null,
    procedure: {
      name: procedure.name,
      revision: procedure.revision,
      schemaVersion: procedure.schemaVersion || 1,
      contentHash,
      resolved: procedure
    }
  });
  return { runId, project: project.key, directory, file: appended.file };
}

// 순수 결정적 fold. 이벤트 배열(파일 순서 = 정본 순서)만으로 커서를 재현한다.
// attempts는 이벤트의 자기 보고가 아니라 실패한 gate 이벤트의 개수로 계산한다.
function foldRun(events) {
  if (!events.length) return { status: 'missing', cursor: null };
  const started = events[0];
  if (started.type !== 'run.started') throw new Error('원장이 run.started로 시작하지 않습니다.');
  const steps = started.procedure.resolved.steps;
  const order = steps.map((step) => step.id);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const completed = new Set();
  let attempts = {};
  const forcedSteps = [];
  let lastGate = null;
  let status = 'running';
  let haltReason = null;

  for (const event of events.slice(1)) {
    if (event.type === 'run.step' && event.exitCode === 0) completed.add(event.stepId);
    else if (event.type === 'run.gate') {
      lastGate = { stepId: event.stepId, exitCode: event.exitCode, diagnostics: event.diagnostics || [] };
      if (event.exitCode === 0) completed.add(event.stepId);
      else {
        attempts[event.stepId] = (attempts[event.stepId] || 0) + 1;
        const step = byId.get(event.stepId);
        if (step && step.onFail) {
          const from = order.indexOf(step.onFail.goto);
          for (const identifier of order.slice(from)) completed.delete(identifier);
        }
      }
    } else if (event.type === 'run.forced') {
      completed.add(event.stepId);
      forcedSteps.push({ stepId: event.stepId, reason: event.reason || null });
    } else if (event.type === 'run.halted') {
      status = 'halted';
      haltReason = HALT_REASONS.has(event.reason) ? event.reason : 'manual';
    } else if (event.type === 'run.resumed') {
      // 재개는 사람 개입이다: 새 시도 예산을 준다. 리셋도 이벤트에서 결정되므로 fold는 순수하다.
      status = 'running';
      haltReason = null;
      attempts = {};
    } else if (event.type === 'run.completed_local') status = 'completed_local';
  }

  // fold가 시도 상한을 강제한다: halted 이벤트가 없어도 상한 도달이면 전진 불가.
  // 이미 통과한(완료된) 스텝의 과거 실패는 소급 적용하지 않는다.
  for (const step of steps) {
    if (step.onFail && !completed.has(step.id) && (attempts[step.id] || 0) >= step.onFail.maxAttempts && status === 'running') {
      status = 'halted';
      haltReason = 'attempt-limit';
    }
  }

  const cursor = status === 'completed_local' ? null : (order.find((identifier) => !completed.has(identifier)) || null);
  return {
    runId: started.runId,
    projectId: started.projectId,
    procedure: { name: started.procedure.name, revision: started.procedure.revision, contentHash: started.procedure.contentHash },
    status,
    cursor,
    cursorStep: cursor ? byId.get(cursor) || null : null,
    completedSteps: order.filter((identifier) => completed.has(identifier)),
    attempts,
    forcedSteps,
    lastGate,
    haltReason
  };
}

function listRuns(projectRoot) {
  const root = runsRoot(projectRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => RUN_ID.test(name)).sort().map((runId) => {
    const fold = foldRun(readRunEvents(path.join(root, runId)));
    return Object.assign({ runId }, fold);
  });
}

module.exports = { RUN_ID, CHECKPOINT_TYPES, newRunId, runDirectory, validateProcedure, appendRunEvent, readRunEvents, createRun, foldRun, listRuns };
