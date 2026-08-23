'use strict';

// 작업 묶음. 여러 기능을 한 브랜치에 묶어 작업하고 하나의 병합 요청으로 함께
// 안착시키는 실제 개발 흐름의 단위다.
//
// 묶음은 저장하는 개체가 아니라 파생이다 — 같은 브랜치 참조를 가진 태스크 집합이
// 곧 묶음이고, 묶음을 만든다는 것은 태스크에 그 참조를 붙이는 일이다. 새 정본
// 파일도 새 검증 규칙도 늘지 않으며, "이 병합 요청에 무엇이 들어있나"는 저장된
// 목록이 아니라 조회 결과가 된다(ADR-009와 같은 계산형 추적 원칙).

const { REF_KINDS } = require('./vocabulary');
const { rollupNodes } = require('./workflow');

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
    // 묶음의 진행은 가장 덜 진행된 태스크가 정한다. 하나라도 남아 있으면 그
    // 묶음은 아직 안착하지 않았다.
    //
    // 예전에는 이 자리가 상태 이름 넷을 늘어놓고 어디에도 안 맞으면 'open'을
    // 지어냈다. TASK_STATES 여섯 중 어디에도 없는 일곱 번째 값이었고, 어휘
    // 파일이 정본이라고 선언해 놓고도 코드가 몰래 값을 만드는 모양이 그것이다.
    // 그 자리를 unclaimed가 그대로 받는다 — 지어낸 것이 아니라 어휘 안의 값이다.
    //
    // 그리고 끝난 것이 섞이는 경우가 새로 드러난다. 전부 끝났는데 완료와 취소가
    // 섞이면 예전에는 조용히 'open'이 되어 안착한 묶음이 열린 것으로 보였다.
    // 이제 답이 하나로 정해지지 않는다는 사실이 값으로 나온다.
    const rolled = rollupNodes(statuses);
    return {
      branch,
      pullRequests,
      tasks: sorted.map((task) => ({ id: task.id, title: task.title, status: task.status, project: task.project || null })),
      counts: statuses.reduce((totals, status) => Object.assign(totals, { [status]: (totals[status] || 0) + 1 }), {}),
      step: rolled.step,
      // 성취와 취소는 "더 손대지 않는다"는 점만 같고 뜻이 반대다. 섞였을 때
      // 한쪽을 고르면 그것은 이 파일이 정한 것이 되므로 고르지 않고 내보낸다.
      mixedTerminal: rolled.ambiguous ? rolled.mixed : null
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
