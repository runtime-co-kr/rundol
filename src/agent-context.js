'use strict';

// 에이전트 발견 표면. AI 클라이언트가 명령과 상태를 소스 탐색으로 재발견하는
// 대신 한 번의 호출로 얻는 경로다. 인덱스도 상시 서버도 쓰지 않는 cold 경로이며,
// 여기서 고정하는 출력 계약을 이후 조회 인덱스가 같은 형태로 가속한다 —
// 계약이 먼저 있어야 인덱스가 표면을 바꾸지 않는다.

const { workspaceLayout, selectProject } = require('./workspace');
const { readTaskStore } = require('./tasks');

const vocabulary = require('./vocabulary');

const STATUS_ORDER = vocabulary.TASK_STATUS_ORDER;
const PRIORITY_ORDER = vocabulary.TASK_PRIORITIES;
const ACTIVE_STATES = new Set(vocabulary.ACTIVE_TASK_STATES);
const workflow = require('./workflow');
const OPEN_STATES = new Set(vocabulary.OPEN_TASK_STATES);

function rank(order, value) {
  const index = order.indexOf(value);
  return index < 0 ? order.length : index;
}

function taskEntry(id, task, projectKey) {
  const criteria = Object.values(task.acceptanceCriteria || {});
  return {
    id,
    project: task.project || projectKey,
    title: task.title || '',
    status: task.status || null,
    // 진행 상태와 판정은 다른 축이다. 값이 없는 옛 태스크는 일반 태스크로 읽는다.
    kind: task.kind || 'normal',
    result: task.result === undefined ? null : task.result,
    round: task.round === undefined ? null : task.round,
    priority: task.priority || null,
    owner: task.owner || null,
    links: Array.isArray(task.links) ? task.links.slice() : [],
    deps: Array.isArray(task.deps) ? task.deps.slice() : [],
    externalRefs: Array.isArray(task.externalRefs) ? task.externalRefs.slice() : [],
    acceptance: { done: criteria.filter((item) => item && item.done).length, total: criteria.length },
    waitingFor: task.blocker && task.blocker.waitingFor || null,
    updatedAt: task.updatedAt || null
  };
}

// --project를 주지 않으면 Workspace의 모든 프로젝트를 연다. 여러 프로젝트를 한
// 번에 보는 것이 통합 조회의 기본이고, 하나를 고르는 것이 좁히는 쪽이다.
function selectedProjects(layout, projectKey) {
  if (projectKey) return [selectProject(layout, projectKey, true)];
  return (layout.projects || []).slice();
}

function listTasks(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  const projects = selectedProjects(layout, settings.project);
  const tasks = [];
  const counts = {};
  // 테스트 판정 집계는 상태 집계와 같은 규칙을 따른다 — 선택된 프로젝트 범위에서
  // 세고 필터 이전 값을 쓴다. 판정이 아직 없는 테스트는 pending으로 센다.
  const results = {};
  for (const project of projects) {
    const store = readTaskStore(project.tasks);
    for (const [id, task] of Object.entries(store.tasks || {})) {
      const entry = taskEntry(id, task, project.key);
      // 차수는 필터가 아니라 범위다. project처럼 먼저 좁히고 그 안에서 집계한다 —
      // 2차를 물었는데 전체 차수의 집계가 돌아오면 답이 질문과 어긋난다. 차수를 물으면
      // 차수를 갖지 않는 일반 태스크는 애초에 범위 밖이다.
      if (settings.round !== undefined && settings.round !== null && entry.round !== settings.round) continue;
      counts[entry.status] = (counts[entry.status] || 0) + 1;
      if (entry.kind === 'test') {
        // 반려한 테스트는 수행하지 않기로 한 것이라 아직 돌리지 않은 것과 다르다.
        const bucket = entry.result || (workflow.stepOf(entry.status) === 'dropped' ? 'cancelled' : 'pending');
        results[bucket] = (results[bucket] || 0) + 1;
      }
      if (settings.kind && entry.kind !== settings.kind) continue;
      if (settings.status && entry.status !== settings.status) continue;
      if (settings.open && !OPEN_STATES.has(entry.status)) continue;
      tasks.push(entry);
    }
  }
  tasks.sort((left, right) => rank(STATUS_ORDER, left.status) - rank(STATUS_ORDER, right.status)
    || rank(PRIORITY_ORDER, left.priority) - rank(PRIORITY_ORDER, right.priority)
    || String(left.id).localeCompare(String(right.id)));
  return {
    root: layout.root,
    projects: projects.map((project) => project.key),
    counts,
    results,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    tasks
  };
}

// 도움말의 정본은 usage 텍스트 하나다. 구조화 출력은 그 텍스트에서 파생한다 —
// 목록을 둘로 두면 CLI가 바뀔 때 기계용 사본이 조용히 낡는다.
function commandCatalog(usageText) {
  const text = String(usageText || '').replace(/\r\n/gu, '\n');
  const version = (/^rdl\s+(\S+)/u.exec(text.trim()) || [])[1] || null;
  const block = /\nUsage:\n([\s\S]*?)\n\nOptions:\n([\s\S]*)$/u.exec(text);
  if (!block) throw new Error('usage 텍스트에서 Usage/Options 블록을 찾지 못했습니다.');
  const commands = [];
  for (const line of block[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^rdl(\s|$)/u.test(trimmed)) commands.push({ synopsis: trimmed });
    else if (commands.length) commands[commands.length - 1].synopsis += ` ${trimmed}`;
  }
  const options = [];
  for (const line of block[2].split('\n')) {
    const matched = /^\s+(--[a-z][a-z-]*)(?:\s+(<[^>]+>))?\s\s+(.+?)\s*$/u.exec(line);
    if (matched) options.push({ flag: matched[1], argument: matched[2] || null, description: matched[3] });
  }
  return {
    version,
    commands: commands.map((entry) => {
      const tokens = entry.synopsis.split(/\s+/u).slice(1);
      const name = [];
      for (const token of tokens) {
        if (!/^[a-z][a-z0-9-]*$/u.test(token)) break;
        name.push(token);
      }
      return {
        command: name.join(' ') || null,
        synopsis: entry.synopsis,
        flags: Array.from(new Set(entry.synopsis.match(/--[a-z][a-z-]*/gu) || [])).sort()
      };
    }),
    options
  };
}

function branchSummary(root) {
  try {
    const { currentBranch, primaryBranch } = require('./branch-boundary');
    return { current: currentBranch(root), primary: primaryBranch(root) };
  } catch (error) {
    return { current: null, primary: null, error: error.message };
  }
}

function diagnosticSummary(root, projectKey) {
  try {
    const { checkWorkspace } = require('./check');
    const result = checkWorkspace(root, projectKey ? { project: projectKey } : {});
    const diagnostics = result.diagnostics || [];
    return {
      errors: diagnostics.filter((item) => item.severity !== 'warning').length,
      warnings: diagnostics.filter((item) => item.severity === 'warning').length
    };
  } catch (error) {
    return { errors: null, warnings: null, error: error.message };
  }
}

// 다음 행동은 상태에서 결정적으로 계산한다. 무엇부터 볼지 스스로 추측하는 대신
// 같은 상태면 같은 안내를 받는다.
function nextActions(context) {
  const actions = [];
  if (context.diagnostics.errors) actions.push(`검사 오류 ${context.diagnostics.errors}건을 먼저 해소하세요: rdl check --json`);
  // 안내는 스텝으로 가른다. 상태 이름 셋을 늘어놓던 자리인데, 그러면 이름이
  // 하나 늘 때 그 상태의 태스크만 아무 안내도 받지 못하고 그 사실은 신호를
  // 내지 않는다. 막혀 있는가는 스텝이 아니라 blocker가 답한다 — 대기와 진행은
  // 같은 스텝에 서고, 둘을 가르는 것은 노드 이름이 아니라 그 필드다.
  for (const task of context.tasks.active) {
    const step = workflow.stepOf(task.status);
    if (step === 'in-progress' && task.blocker) {
      actions.push(`대기 중인 태스크의 해제 조건을 확인하세요: ${task.id} (${task.waitingFor || '대상 미상'})`);
    } else if (step === 'in-progress') {
      actions.push(`진행 중인 태스크를 이어서 작업하세요: ${task.id} ${task.title}`);
    } else if (step === 'in-approval') {
      actions.push(`검토 중인 태스크는 PR 병합 후 done으로 전환하세요: ${task.id}`);
    }
  }
  if (!context.tasks.active.length && context.tasks.todo.length) {
    const first = context.tasks.todo[0];
    actions.push(`할 일에서 하나를 골라 시작하세요: rdl task set ${first.id} --status doing --owner <MEMBER-ID>`);
  }
  if (!actions.length) actions.push('열린 태스크가 없습니다. rdl contract next로 다음 작성 대상을 확인하세요.');
  return actions;
}

function agentContext(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  // 기본은 정본 읽기다. 인덱스는 요청할 때만 쓴다 — 이 규모에서는 유효성 확인이
  // 읽기보다 비싸다. 어느 경로였는지는 결과의 source에 남는다.
  const listed = require('./query-index').queryTasks(start, { project: settings.project, index: settings.index });
  const open = listed.tasks.filter((task) => OPEN_STATES.has(task.status));
  const context = {
    root: layout.root,
    schemaVersion: layout.schemaVersion,
    projects: (layout.projects || []).map((project) => ({ key: project.key, branch: project.branch || null })),
    project: settings.project || null,
    branch: branchSummary(layout.root),
    diagnostics: diagnosticSummary(layout.root, settings.project),
    tasks: {
      // 어느 경로로 답했는지를 남긴다. 두 경로가 다른 답을 낸 경우를 사후에
      // 지목하려면 결과 자체가 출처를 들고 있어야 한다.
      source: listed.source,
      counts: listed.counts,
      active: open.filter((task) => ACTIVE_STATES.has(task.status)),
      todo: open.filter((task) => workflow.isUnclaimed(task.status))
    }
  };
  context.next = nextActions(context);
  // 에이전트가 이 컨텍스트 다음에 바로 쓰는 명령만 싣는다. 전체 목록은 rdl help가
  // usage 정본에서 파생해 제공한다.
  context.commands = {
    tasks: 'rdl task list --json [--project <key>] [--status <state>] [--open]',
    start: 'rdl task set <TASK-ID> --status doing --owner <MEMBER-ID> --json',
    acceptance: 'rdl task acceptance <TASK-ID> <AC-ID> --done --json',
    check: 'rdl check --json [--strict] [--implementation]',
    contract: 'rdl contract next --project <key> --json',
    help: 'rdl help --json',
    sync: 'rdl sync --project <key> --json'
  };
  return context;
}

module.exports = { STATUS_ORDER, ACTIVE_STATES, OPEN_STATES, listTasks, commandCatalog, agentContext };
