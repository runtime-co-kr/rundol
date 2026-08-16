'use strict';

const { appendDebug } = require('./debug');

const EXECUTORS = new Set(['cli', 'llm', 'hybrid']);
const ACTIONS = {
  'workspace.init': { recommendedExecutor: 'cli', commandHint: 'rdl init <project-key> --name <project-name>', reason: 'Workspace와 Git branch/worktree 계약을 CLI가 원자적으로 생성합니다.' },
  'project.add': { recommendedExecutor: 'cli', commandHint: 'rdl project add <project-key> --name <project-name>', reason: '프로젝트 등록과 branch/worktree 생성을 CLI가 검증합니다.' },
  'project.charter.edit': { recommendedExecutor: 'hybrid', commandHint: 'rdl check --project <key> --strict', reason: 'LLM이 실제 내용을 작성하고 CLI가 거버넌스 계약을 검증합니다.' },
  'document.create': { recommendedExecutor: 'cli', commandHint: 'rdl doc create <TYPE> <title> --owner <MEMBER-ID> --related <ARTIFACT-ID>', reason: 'ID, 경로, owner, tag와 related link를 CLI가 검증합니다.' },
  'document.edit': { recommendedExecutor: 'hybrid', commandHint: 'rdl save --project <key>', reason: 'LLM이 본문을 작성하고 CLI가 검증·저장합니다.' },
  'task.create': { recommendedExecutor: 'cli', commandHint: 'rdl task add <title> --acceptance <criterion>', reason: '담당자, 문서 link와 shard 저장을 CLI가 검증합니다.' },
  'task.update': { recommendedExecutor: 'cli', commandHint: 'rdl task set <TASK-ID> --status <state>', reason: '태스크 변경, operation과 commit을 CLI가 함께 기록합니다.' },
  'task.acceptance': { recommendedExecutor: 'cli', commandHint: 'rdl task acceptance <TASK-ID> <AC-ID> --done|--undone', reason: '수용조건 변경과 완료 상태 검증을 CLI가 수행합니다.' },
  'code.edit': { recommendedExecutor: 'llm', commandHint: null, reason: 'Rundol은 범용 소스 코드 편집기를 제공하지 않습니다.' },
  'test.run': { recommendedExecutor: 'cli', commandHint: 'npm test', reason: '재현 가능한 명령 실행 결과를 사용합니다.' }
};

const ALIASES = { 'doc.create': 'document.create', 'doc.edit': 'document.edit', 'task.add': 'task.create', 'task.set': 'task.update' };

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return ALIASES[action] || action;
}

function resolveAction(value) {
  const action = normalizeAction(value);
  const definition = ACTIONS[action];
  if (!definition) throw new Error(`지원하지 않는 표준 액션입니다: ${value || '(없음)'}`);
  return Object.assign({ action }, definition);
}

function recordAction(start, input) {
  const resolved = resolveAction(input.action);
  const plannedExecutor = String(input.plannedExecutor || resolved.recommendedExecutor).toLowerCase();
  const actualExecutor = String(input.actualExecutor || '').toLowerCase();
  if (!EXECUTORS.has(plannedExecutor)) throw new Error(`잘못된 planned executor입니다: ${plannedExecutor || '(없음)'}`);
  if (!EXECUTORS.has(actualExecutor)) throw new Error(`--actual-executor <cli|llm|hybrid>가 필요합니다.`);
  const fallbackReason = input.fallbackReason ? String(input.fallbackReason).trim() : null;
  const adopted = plannedExecutor === actualExecutor || plannedExecutor === 'hybrid';
  if (!adopted && !fallbackReason) throw new Error('권장 executor와 실제 executor가 다르면 --fallback-reason이 필요합니다.');
  const record = {
    type: 'action', project: input.project || null, action: resolved.action, plannedExecutor, actualExecutor, adopted,
    artifactId: input.artifactId || null, taskId: input.taskId || null, fallbackReason
  };
  // 런에 속한 액션은 원장과 상관시킨다. 미제공 시 기존 출력과 바이트 단위로 동일하다.
  if (input.runId) record.runId = String(input.runId);
  return appendDebug(start, record);
}

module.exports = { ACTIONS, EXECUTORS, normalizeAction, resolveAction, recordAction };
