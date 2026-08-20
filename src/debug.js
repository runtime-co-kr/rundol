'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');

function logFile(start, projectKey) {
  const layout = workspaceLayout(start);
  if (layout.schemaVersion < 6) {
    const legacy = path.join(layout.root, '.rundol', 'logs', 'debug.jsonl');
    return layout.runtime ? path.join(layout.runtime.logs, 'debug.jsonl') : legacy;
  }
  let project = null;
  if (projectKey) project = selectProject(layout, projectKey, true);
  else {
    const current = path.resolve(start || process.cwd()).toLowerCase();
    project = layout.projects.find((item) => current === item.root.toLowerCase() || current.startsWith(`${item.root.toLowerCase()}${path.sep}`));
    if (!project && layout.projects.length === 1) project = layout.projects[0];
  }
  if (!project) throw new Error('로그를 기록하려면 --project <프로젝트키>가 필요합니다.');
  return path.join(project.root, '.rundol', 'logs', 'debug.jsonl');
}

// 로그는 진단이지 정본이 아니다. 무제한으로 자라게 두면 계측을 기본으로 켜는 순간
// 로컬 디스크를 조용히 먹는다. 상한에 닿으면 오래된 줄부터 버린다 — 편익 계측은
// 최근 흐름을 보는 일이라 앞부분이 사라져도 답이 달라지지 않는다.
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const KEEP_RATIO = 0.7;

function trimLog(file) {
  let size;
  try { size = fs.statSync(file).size; } catch (_) { return; }
  if (size <= MAX_LOG_BYTES) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  // 줄 수가 아니라 바이트로 자른다. 줄 길이가 고르지 않아 줄 수로 자르면 상한이
  // 지켜지지 않는다. 그리고 바이트는 Buffer.byteLength로 세야 한다 — 문자열의
  // length는 UTF-16 코드 단위라서 한글 로그에서는 실제 파일 크기를 3분의 1로
  // 세고, 그만큼 상한을 넘긴 채로 남는다.
  const budget = Math.floor(MAX_LOG_BYTES * KEEP_RATIO);
  const kept = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    used += Buffer.byteLength(lines[index], 'utf8') + 1;
    if (used > budget) break;
    kept.unshift(lines[index]);
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
  fs.renameSync(temporary, file);
}

function appendDebug(start, event) {
  const file = logFile(start, event && event.project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safe = Object.assign({ at: new Date().toISOString() }, event);
  delete safe.prompt;
  delete safe.content;
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
  trimLog(file);
  return { file, event: safe };
}

function recordTokens(start, input) {
  const inputTokens = Number.parseInt(input.inputTokens || '0', 10);
  const outputTokens = Number.parseInt(input.outputTokens || '0', 10);
  const cachedTokens = Number.parseInt(input.cachedTokens || '0', 10);
  for (const [name, value] of Object.entries({ inputTokens, outputTokens, cachedTokens })) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name}은 0 이상의 정수여야 합니다.`);
  }
  const reported = input.unreported !== true;
  if (!reported && (inputTokens !== 0 || outputTokens !== 0 || cachedTokens !== 0)) throw new Error('--unreported 토큰 이벤트의 수치는 모두 0이어야 합니다.');
  return appendDebug(start, {
    project: input.project || null,
    type: 'token-usage', provider: input.provider || 'unknown', model: input.model || 'unknown',
    client: input.client || 'unknown', reported, inputTokens, outputTokens, cachedTokens,
    totalTokens: inputTokens + outputTokens
  });
}

// 사람 개입 횟수 집계. PRD-001이 1차 편익으로 건 "할당부터 검수 통과까지 사람이
// 개입한 횟수"의 계측 수단이다.
//
// 값만 받는 순수 함수로 둔 이유는 두 가지다. 하나는 파일 없이 시험할 수 있어야
// 하기 때문이고, 다른 하나는 이 수치를 나중에 보드와 보고서가 각자 계산하지 않고
// 같은 함수를 부르게 하기 위해서다. 편익 수치가 표면마다 다르면 그 수치로 아무것도
// 판단할 수 없다.
//
// 사람 개입의 정의는 실행 주체가 cli 또는 hybrid인 행위다. hybrid를 사람으로 세는
// 이유는 그 경우 사람이 실제로 손을 댔기 때문이며, 개입을 적게 세면 편익이 실제보다
// 좋아 보인다. 계측은 자기에게 유리한 쪽으로 반올림하지 않는다.
//
// 이 값의 이름은 turn이 아니라 action이다. 세는 것이 사람의 개입 횟수가 아니라
// 사람이 실행한 행위의 수이기 때문이다. 둘은 같지 않다 — 한 번 마음먹고 명령을
// 셋 치면 개입은 한 번이고 행위는 셋이다. 이름을 turn으로 두면 그 차이가 지워지고,
// 지워진 채로 PRD의 편익 판단에 들어간다. 셀 수 없는 것을 센 척하느니 셀 수 있는
// 것의 이름을 정확히 붙인다.
//
// 그래서 이 집계가 보지 못하는 것을 여기 적어 둔다. 보드나 편집기에서 사람이
// 손을 댔지만 action 이벤트가 남지 않으면 세지 못한다. 즉 이 값은 실제 개입의
// 하한이다. 편익이 좋아 보이는 쪽으로 틀리는 방향이므로, 이 수치로 편익을
// 주장할 때는 하한이라는 것을 함께 말해야 한다.
function humanInterventionSummary(events) {
  const actions = (events || []).filter((event) => event && event.type === 'action');
  const byTask = new Map();
  for (const event of actions) {
    if (!event.taskId) continue;
    const entry = byTask.get(event.taskId) || { taskId: event.taskId, actions: 0, humanActions: 0 };
    entry.actions += 1;
    if (event.actualExecutor === 'cli' || event.actualExecutor === 'hybrid') entry.humanActions += 1;
    byTask.set(event.taskId, entry);
  }
  const tasks = Array.from(byTask.values()).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const sorted = tasks.map((item) => item.humanActions).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length === 0 ? null
    : (sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
  return {
    tasks,
    taskCount: tasks.length,
    medianHumanActions: median,
    // 태스크에 결박되지 않은 행위는 집계에서 빠진다. 그 수를 함께 내보내지 않으면
    // 중앙값이 전체를 대표하는 것처럼 읽힌다.
    unattributedActions: actions.filter((event) => !event.taskId).length,
    // 계측이 보지 못하는 경로를 값으로 밝힌다. 주석에만 적으면 JSON을 읽는 쪽은
    // 이 수치를 실제 개입 횟수로 읽는다.
    measures: 'task-bound-cli-actions',
    lowerBound: true
  };
}

function debugSummary(start, project) {
  const file = logFile(start, project);
  const events = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  const usage = events.filter((event) => event.type === 'token-usage');
  const actions = events.filter((event) => event.type === 'action');
  const executorCounts = (field) => ['cli', 'llm', 'hybrid'].reduce((result, executor) => {
    result[executor] = actions.filter((event) => event[field] === executor).length;
    return result;
  }, {});
  const adopted = actions.filter((event) => event.adopted === true).length;
  return {
    file,
    events: events.length,
    tokenEvents: usage.length,
    reportedTokenEvents: usage.filter((event) => event.reported !== false).length,
    unreportedTokenEvents: usage.filter((event) => event.reported === false).length,
    inputTokens: usage.reduce((sum, item) => sum + (item.inputTokens || 0), 0),
    outputTokens: usage.reduce((sum, item) => sum + (item.outputTokens || 0), 0),
    cachedTokens: usage.reduce((sum, item) => sum + (item.cachedTokens || 0), 0),
    totalTokens: usage.reduce((sum, item) => sum + (item.totalTokens || 0), 0),
    actionEvents: actions.length,
    plannedExecutors: executorCounts('plannedExecutor'),
    actualExecutors: executorCounts('actualExecutor'),
    adoptedActions: adopted,
    fallbackActions: actions.filter((event) => event.fallbackReason).length,
    adoptionRate: actions.length ? Number((adopted / actions.length).toFixed(4)) : null,
    humanInterventions: humanInterventionSummary(events)
  };
}

module.exports = { appendDebug, recordTokens, debugSummary, humanInterventionSummary, MAX_LOG_BYTES };
