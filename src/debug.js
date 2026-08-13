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

function appendDebug(start, event) {
  const file = logFile(start, event && event.project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safe = Object.assign({ at: new Date().toISOString() }, event);
  delete safe.prompt;
  delete safe.content;
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
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
    adoptionRate: actions.length ? Number((adopted / actions.length).toFixed(4)) : null
  };
}

module.exports = { appendDebug, recordTokens, debugSummary };
