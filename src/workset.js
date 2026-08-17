'use strict';

// 작업 묶음. 여러 기능을 한 브랜치에 묶어 작업하고 하나의 병합 요청으로 함께
// 안착시키는 실제 개발 흐름의 단위다.
//
// 묶음은 저장하는 개체가 아니라 파생이다 — 같은 브랜치 참조를 가진 태스크 집합이
// 곧 묶음이고, 묶음을 만든다는 것은 태스크에 그 참조를 붙이는 일이다. 새 정본
// 파일도 새 검증 규칙도 늘지 않으며, "이 병합 요청에 무엇이 들어있나"는 저장된
// 목록이 아니라 조회 결과가 된다(ADR-009와 같은 계산형 추적 원칙).

const REF_KINDS = Object.freeze(['branch', 'pr', 'issue', 'other']);
const BRANCH_NAME = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*[\\~^: ?*[\]])[\w.\-/]+(?<![./])$/u;

// externalRefs는 문자열과 객체를 모두 받아 왔다. 종류를 가진 항목으로 정규화하되
// 예전 문자열은 버리지 않고 종류 없는 참조로 남긴다 — 마이그레이션 없이 읽힌다.
function normalizeExternalRef(value) {
  if (typeof value === 'string') {
    const separator = value.indexOf('=');
    if (separator > 0 && REF_KINDS.includes(value.slice(0, separator))) {
      return { kind: value.slice(0, separator), value: value.slice(separator + 1) };
    }
    return { kind: 'other', value };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.value === 'string') {
    return { kind: REF_KINDS.includes(value.kind) ? value.kind : 'other', value: value.value };
  }
  return { kind: 'other', value: JSON.stringify(value) };
}

function externalRefs(task) {
  return (Array.isArray(task && task.externalRefs) ? task.externalRefs : []).map(normalizeExternalRef);
}

function refOf(task, kind) {
  const found = externalRefs(task).find((ref) => ref.kind === kind);
  return found ? found.value : null;
}

function assertBranchName(value) {
  const name = String(value === undefined || value === null ? '' : value).trim();
  if (!name) throw new Error('브랜치 이름이 필요합니다.');
  if (name.length > 200) throw new Error('브랜치 이름은 200자 이하여야 합니다.');
  if (!BRANCH_NAME.test(name)) throw new Error(`브랜치 이름 형식이 잘못되었습니다: ${name}`);
  return name;
}

// 브랜치 이름은 지어낼 수 없는 필수 입력이지만, 사람에게 빈칸을 내미는 대신
// 규약에서 만든 권고안을 제시한다. 승인이든 수정이든 사람의 한 번의 확인이
// 남는다는 점은 같다.
function suggestBranchName(input) {
  const settings = input || {};
  const prefix = settings.prefix || 'task';
  const slug = String(settings.title || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/u, '');
  const identifier = String(settings.taskId || '').replace(/^TASK-/u, '').slice(0, 8);
  return [prefix, identifier, slug].filter(Boolean).join('/').replace(/\/+/gu, '/');
}

// 태스크 집합에서 묶음을 계산한다. 브랜치 참조가 없는 태스크는 어떤 묶음에도
// 속하지 않는다 — 묶이지 않은 일을 묶음처럼 보이게 하지 않는다.
function worksets(tasks) {
  const groups = new Map();
  const unassigned = [];
  for (const task of tasks || []) {
    const branch = refOf(task, 'branch');
    if (!branch) { unassigned.push(task); continue; }
    if (!groups.has(branch)) groups.set(branch, []);
    groups.get(branch).push(task);
  }
  const result = Array.from(groups).sort((left, right) => left[0].localeCompare(right[0])).map(([branch, members]) => {
    const sorted = members.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const pullRequests = Array.from(new Set(sorted.map((task) => refOf(task, 'pr')).filter(Boolean))).sort();
    const statuses = sorted.map((task) => task.status);
    return {
      branch,
      pullRequests,
      tasks: sorted.map((task) => ({ id: task.id, title: task.title, status: task.status, project: task.project || null })),
      counts: statuses.reduce((totals, status) => Object.assign(totals, { [status]: (totals[status] || 0) + 1 }), {}),
      // 묶음의 상태는 가장 덜 진행된 태스크가 정한다. 하나라도 남아 있으면 그
      // 묶음은 아직 안착하지 않았다.
      status: statuses.every((status) => status === 'done') ? 'done'
        : statuses.some((status) => status === 'doing') ? 'doing'
          : statuses.every((status) => ['review', 'done'].includes(status)) ? 'review' : 'open'
    };
  });
  return { worksets: result, unassigned: unassigned.map((task) => ({ id: task.id, title: task.title, status: task.status })) };
}

function listWorksets(start, options) {
  const settings = options || {};
  const { listTasks } = require('./agent-context');
  const listed = listTasks(start, { project: settings.project });
  const computed = worksets(listed.tasks);
  const filtered = settings.branch ? computed.worksets.filter((entry) => entry.branch === settings.branch) : computed.worksets;
  return {
    root: listed.root,
    projects: listed.projects,
    total: computed.worksets.length,
    worksets: filtered,
    unassigned: settings.branch ? [] : computed.unassigned
  };
}

module.exports = { REF_KINDS, normalizeExternalRef, externalRefs, refOf, assertBranchName, suggestBranchName, worksets, listWorksets };
