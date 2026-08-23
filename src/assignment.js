'use strict';

// 작업 할당과 보고의 저장과 조회. 판정은 worker-contract.js가 하고 여기서는
// 읽고 쓴다. comment-rules.js와 comment.js가 갈라선 것과 같은 경계다.
//
// 저장 자리를 Workspace 공유 이벤트 원장으로 고른 이유는 배제 때문이다.
// `assignmentOverlaps`가 답해야 할 물음은 "다른 워커가 이 경로를 이미 잡고
// 있는가"인데, 저장이 Git에 추적되지 않으면 다른 기계가 발급한 할당이 보이지
// 않는다. 배제가 필요한 바로 그때 눈이 머는 셈이다. `.rundol/`은 프로젝트
// .gitignore 첫 줄이 제외하므로 그 자리가 될 수 없다.
//
// 태스크 샤드도 될 수 없다. 그 파일은 제자리에서 덮어쓰이는 지도이고 할당
// 원장은 추가 전용이어야 한다. 둘을 한 파일에 두면 추가 전용이라는 성질이
// 덮어쓰기에 지워진다.

const crypto = require('crypto');
const path = require('path');
const eventStore = require('./event-store');
const { workspaceLayout, selectProject } = require('./workspace');
const { getClient } = require('./collaboration-store');
const { workerKindOf } = require('./comment-rules');
const { foldAssignments } = require('./worker-contract');

const SIMPLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ASSIGNMENT_ID = /^ASG-[A-Z0-9]{8}$/u;
const REPORT_ID = /^RPT-[A-Z0-9]{8}$/u;
// 식별자 알파벳은 문서 식별자와 같다. 사람이 손으로 치는 값이므로 눈으로 가르기
// 어려운 글자를 뺀 같은 규칙을 쓴다.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class AssignmentViolation extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AssignmentViolation';
    this.code = code || null;
  }
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function eventsRootOf(layout) {
  return path.join(layout.root, 'projects', 'workspace', 'events');
}

function lockDirectoryOf(layout) {
  return path.join(layout.root, 'projects', 'workspace', '.rundol', 'local', 'locks');
}

function newEventId() {
  return `EVT-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

function newShortId(prefix) {
  let value = '';
  for (const byte of crypto.randomBytes(8)) value += ALPHABET[byte % ALPHABET.length];
  return `${prefix}-${value}`;
}

/**
 * 이미 쓰인 식별자를 피해 다시 뽑는다. 결정론적 식별자를 쓰지 않는 이유는 취소
 * 뒤 같은 경로로 새 할당을 발급할 수 있어야 하기 때문이다 — 본문에서 유도한
 * 식별자는 그때 닫힌 할당과 충돌한다.
 */
function uniqueId(prefix, taken) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = newShortId(prefix);
    if (!taken.has(candidate)) return candidate;
  }
  throw new AssignmentViolation('식별자를 뽑지 못했습니다.', 'identifier-exhausted');
}

/**
 * 판정에 쓰는 값은 다이제스트가 덮어야 한다. 덮지 않으면 같은 eventId의 내용을
 * 나중에 고쳐도 상충으로 잡히지 않고, 그러면 "누가 무엇을 맡았는가"가 흔들린다.
 *
 * 봉투 구성은 comment.js의 commentEnvelope와 같은 모양이다 — canonical에는
 * 다이제스트가 없고 shared가 그것을 더한다.
 */
function assignmentEnvelope(input) {
  const canonical = Object.assign({
    schemaVersion: 1,
    eventId: input.eventId,
    type: input.type,
    clientId: input.clientId,
    projectId: input.projectId,
    recordedAt: input.recordedAt
  }, input.body || {});
  const digest = sha256(Buffer.from(eventStore.canonicalJson(canonical), 'utf8'));
  return { canonical, shared: Object.assign({}, canonical, { canonicalDigest: digest }) };
}

function appendWorkEvent(layout, projectKey, clientId, type, body) {
  const envelope = assignmentEnvelope({
    eventId: newEventId(),
    type,
    clientId,
    projectId: projectKey,
    recordedAt: new Date().toISOString(),
    body
  });
  const file = eventStore.appendEvent(eventsRootOf(layout), 'assignment', projectKey, clientId, envelope.shared, {
    lockDirectory: lockDirectoryOf(layout)
  });
  return { file, event: envelope.shared };
}

/**
 * 등록된 Client에서 워커 신원을 파생한다. 호출자가 주장하게 두면 에이전트가
 * 사람이라고 적을 수 있고, ADR-020이 막으려 한 순환이 열린다.
 *
 * WORKER_KIND_BY_CLIENT 표를 복사하지 않고 comment-rules에서 가져다 쓴다.
 * 복사하면 같은 물음에 표가 둘이 되고, 둘은 언젠가 어긋난다.
 */
function workerOf(client, member) {
  const kind = workerKindOf(client.type);
  const id = kind === 'human' ? String(member || client.owner || client.id) : String(client.id);
  return { kind, id };
}

function activeClient(layout, clientId) {
  if (!SIMPLE_ID.test(clientId || '')) throw new AssignmentViolation('--client-id가 필요합니다.', 'missing-client');
  let client;
  try { client = getClient(layout.root, clientId); }
  catch (error) { throw new AssignmentViolation(error.message, 'unknown-client'); }
  if (client.status !== 'active') throw new AssignmentViolation(`비활성 Client는 할당을 다룰 수 없습니다: ${clientId}`, 'inactive-client');
  return client;
}

/**
 * 한 프로젝트의 할당 원장을 읽어 접는다.
 *
 * 읽기는 쓰지 않는다. 이 경로가 원장을 고치면 무엇이 열려 있는지 묻는 행위가
 * 원장을 바꾸는 행위가 된다.
 */
function readAssignments(start, projectKey) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  const read = eventStore.readEvents(eventsRootOf(layout), 'assignment', project.key, {});
  const events = Array.isArray(read) ? read : (read.events || []);
  return Object.assign({ layout, project }, foldAssignments(events));
}

/**
 * 정규 문서가 선언한 기능 ID. 여기서 문서를 다시 훑지 않고 계약 추적을 부르는
 * 이유는, 다시 훑으면 `rdl contract trace`와 다른 답을 낼 수 있기 때문이다.
 *
 * 돌려주는 값은 부모를 단 표기다 — REQ-033#FN-001. 할당은 문서 밖에서 기능을
 * 가리키는 일이므로 부모 없이는 어느 요구의 기능인지가 정해지지 않는다.
 */
function declaredFunctionIds(project) {
  const { projectArtifacts } = require('./document-contract');
  const { implementationTrace } = require('./implementation-contract');
  return implementationTrace(projectArtifacts(project)).entries.map((entry) => entry.functionId);
}

/**
 * 절차를 이름과 revision으로 고정한다. 요청이 revision을 명시하게 두는 이유는,
 * 명시하지 않으면 "내가 보던 절차가 아니다"를 발급 시점에 알아차릴 방법이
 * 없기 때문이다.
 */
function pinProcedure(start, projectKey, requested) {
  const wanted = requested || {};
  if (!wanted.name) return null;
  let entry;
  try { entry = require('./procedure').loadProcedures(start, projectKey).resolve(wanted.name); }
  catch (error) { return null; }
  const revision = entry.resolved && entry.resolved.revision;
  if (wanted.revision !== undefined && Number(wanted.revision) !== Number(revision)) return null;
  return { name: entry.name, revision, digest: entry.contentHash };
}

/**
 * 할당을 발급한다. 거부되면 사유가 원장에 남되 할당은 생기지 않는다 —
 * `assignment.rejected`에 `assignmentId`가 없는 것이 그 사실의 표현이며,
 * 그래서 부분 발급이 남지 않는다.
 */
function issueAssignment(start, input) {
  const values = input || {};
  const state = readAssignments(start, values.project);
  const { layout, project } = state;
  const client = activeClient(layout, values.clientId);
  const issuedBy = workerOf(client, values.member);

  // 수임자도 등록된 Client에서 파생한다. 그래야 접수 때 sameWorker가 비교하는
  // 두 값이 같은 규칙에서 나온다.
  const assigneeClient = activeClient(layout, values.assigneeClientId);
  const assignee = workerOf(assigneeClient, values.assigneeMember);

  const request = {
    goal: values.goal,
    acceptance: values.acceptance,
    functionIds: values.functionIds,
    allowedPaths: values.allowedPaths,
    forbidden: Array.isArray(values.forbidden) ? values.forbidden : [],
    procedure: { name: values.procedureName, revision: values.procedureRevision },
    reportSchema: values.reportSchema,
    assignee
  };
  const pinned = pinProcedure(start, project.key, request.procedure);
  const composed = require('./worker-contract').composeAssignment(request, pinned, {
    declaredFunctionIds: declaredFunctionIds(project),
    openAssignments: state.assignments
  });

  if (composed.code) {
    const summary = { goal: values.goal || '', functionIds: values.functionIds || [], allowedPaths: values.allowedPaths || [] };
    const recorded = appendWorkEvent(layout, project.key, client.id, 'assignment.rejected', {
      code: composed.code,
      missing: composed.missing,
      unknownFunctionIds: composed.unknownFunctionIds,
      overlaps: composed.overlaps,
      requestedBy: issuedBy,
      summary
    });
    return { changed: false, project: project.key, rejected: composed, file: recorded.file };
  }

  const taken = new Set(state.assignments.map((item) => item.id));
  const assignmentId = uniqueId('ASG', taken);
  const recorded = appendWorkEvent(layout, project.key, client.id, 'assignment.issued', Object.assign({
    assignmentId,
    issuedBy,
    taskId: values.taskId || null
  }, composed));
  return { changed: true, project: project.key, assignmentId, file: recorded.file, assignment: recorded.event };
}

/**
 * 열린 할당을 닫는다. 닫힌 할당은 겹침 판정의 대상이 아니므로, 취소한 뒤 같은
 * 경로로 새 할당을 발급할 수 있다.
 */
function cancelAssignment(start, input) {
  const values = input || {};
  const state = readAssignments(start, values.project);
  const { layout, project } = state;
  const client = activeClient(layout, values.clientId);
  const target = state.assignments.find((item) => item.id === values.assignmentId);
  if (!target) throw new AssignmentViolation(`발급되지 않은 할당입니다: ${values.assignmentId || '(없음)'}`, 'unknown-assignment');
  if (target.state === 'closed') throw new AssignmentViolation(`이미 닫힌 할당입니다: ${target.id}`, 'assignment-closed');
  const reason = String(values.reason || '').trim();
  if (!reason) throw new AssignmentViolation('--reason <사유>가 필요합니다. 무엇을 보고 취소했는지가 기록되어야 합니다.', 'missing-reason');

  const recorded = appendWorkEvent(layout, project.key, client.id, 'assignment.closed', {
    assignmentId: target.id,
    reason: 'cancelled',
    detail: reason,
    closedBy: workerOf(client, values.member)
  });
  return { changed: true, project: project.key, assignmentId: target.id, file: recorded.file };
}

function findAssignment(state, assignmentId) {
  const target = state.assignments.find((item) => item.id === assignmentId);
  if (!target) throw new AssignmentViolation(`발급되지 않은 할당입니다: ${assignmentId || '(없음)'}`, 'unknown-assignment');
  return target;
}

/**
 * 보고를 제출한다. 접수 판정은 `acceptReport`가 하고 여기서는 값을 만들어 넘긴
 * 뒤 결과를 기록한다 — 판정을 다시 쓰면 명령줄과 보드와 워커 어댑터가 다른
 * 답을 낸다.
 *
 * 워커 신원은 등록된 Client에서 파생한다. 보고가 주장하게 두면 에이전트가
 * 사람이라고 적을 수 있고, 그러면 `sameWorker`가 비교하는 두 값의 근거가 갈린다.
 *
 * 절차 다이제스트와 스키마는 호출자가 반드시 밝힌다. 할당에서 끌어와 채우면
 * `procedure-mismatch`와 `schema-mismatch`가 영영 도달 불가가 된다 — 판정자를
 * 부르는 대신 우회하는 셈이다.
 */
function submitReport(start, input) {
  const values = input || {};
  const state = readAssignments(start, values.project);
  const { layout, project } = state;
  const client = activeClient(layout, values.clientId);
  const target = findAssignment(state, values.assignmentId);
  const worker = workerOf(client, values.member);

  const taken = new Set(state.assignments.flatMap((item) => item.reports.map((report) => report.id)));
  const report = {
    id: uniqueId('RPT', taken),
    assignmentId: target.id,
    worker,
    schema: values.schema,
    outcome: values.outcome,
    claims: Array.isArray(values.claims) ? values.claims : [],
    changed: Array.isArray(values.changed) ? values.changed : [],
    procedureDigest: values.procedureDigest
  };
  if (values.reason !== undefined) report.reason = values.reason;
  if (Array.isArray(values.forbiddenTouched)) report.forbiddenTouched = values.forbiddenTouched;

  const rejection = require('./worker-contract').acceptReport(target, report);
  if (rejection) {
    const recorded = appendWorkEvent(layout, project.key, client.id, 'report.rejected', {
      assignmentId: target.id,
      code: rejection.code,
      missing: rejection.missing,
      unclaimed: rejection.unclaimed,
      submittedBy: worker
    });
    return { changed: false, project: project.key, assignmentId: target.id, rejected: rejection, file: recorded.file };
  }

  const recorded = appendWorkEvent(layout, project.key, client.id, 'report.submitted', {
    assignmentId: target.id,
    reportId: report.id,
    report
  });
  return { changed: true, project: project.key, assignmentId: target.id, reportId: report.id, file: recorded.file };
}

/**
 * 접수된 마지막 보고를 검수한다. 통과하면 할당이 닫힌다 — 통과한 일을 열어 두면
 * 그 경로가 계속 배제되어 다음 할당이 막힌다.
 *
 * 대체된 보고를 판정하지 않는 이유는, 워커가 고쳐 다시 낸 뒤에도 옛 보고로
 * 판정하면 이미 고친 것을 반려하게 되기 때문이다.
 */
function verifyLatestReport(start, input) {
  const values = input || {};
  const state = readAssignments(start, values.project);
  const { layout, project } = state;
  const client = activeClient(layout, values.clientId);
  const target = findAssignment(state, values.assignmentId);
  if (!target.reports.length) throw new AssignmentViolation(`접수된 보고가 없습니다: ${target.id}`, 'no-report');
  const latest = target.reports[target.reports.length - 1];

  const verdict = require('./worker-contract').verifyReport(target, latest);
  const verifiedBy = workerOf(client, values.member);
  const recorded = appendWorkEvent(layout, project.key, client.id, 'report.verified', {
    assignmentId: target.id,
    reportId: latest.id,
    decision: verdict.decision,
    blocks: verdict.blocks,
    humanReasons: verdict.humanReasons,
    verifiedBy
  });

  let closed = null;
  if (verdict.decision === 'pass') {
    closed = appendWorkEvent(layout, project.key, client.id, 'assignment.closed', {
      assignmentId: target.id,
      reason: 'verified',
      detail: `보고 ${latest.id}가 수용 조건을 충족했습니다.`,
      closedBy: verifiedBy
    });
  }
  return {
    changed: true, project: project.key, assignmentId: target.id, reportId: latest.id,
    decision: verdict.decision, blocks: verdict.blocks, humanReasons: verdict.humanReasons,
    closed: Boolean(closed), file: recorded.file
  };
}

/**
 * 사람이 보는 표면에는 저장의 사실을 싣지 않는다. `clientId`·`schemaVersion` 같은
 * 어휘는 내부 개념이고, 표면에 나오면 그것을 아는 사람만 도구를 쓸 수 있게 된다.
 * surface-leak 시험이 이 어휘 목록을 지킨다.
 *
 * 워커 식별자는 남는다 — 누가 맡았는지는 사람이 알아야 하는 사실이고,
 * `assignee.id`는 Client 식별자와 값이 같아도 뜻이 다르다.
 */
function projectAssignment(assignment, taskStatuses) {
  return {
    id: assignment.id,
    goal: assignment.goal,
    state: assignment.state,
    acceptance: assignment.acceptance,
    functionIds: assignment.functionIds,
    allowedPaths: assignment.allowedPaths,
    forbidden: assignment.forbidden,
    procedure: assignment.procedure,
    reportSchema: assignment.reportSchema,
    assignee: assignment.assignee,
    issuedBy: assignment.issuedBy,
    issuedAt: assignment.issuedAt,
    closedReason: assignment.closedReason,
    closedAt: assignment.closedAt,
    task: assignment.taskId ? { id: assignment.taskId, status: taskStatuses.get(assignment.taskId) || null } : null,
    reportCount: assignment.reports.length,
    latestReport: assignment.reports.length ? projectReport(assignment.reports[assignment.reports.length - 1]) : null
  };
}

function projectReport(report) {
  return {
    id: report.id,
    worker: report.worker,
    outcome: report.outcome,
    claims: report.claims,
    changed: report.changed,
    reason: report.reason === undefined ? null : report.reason,
    forbiddenTouched: report.forbiddenTouched || [],
    recordedAt: report.recordedAt,
    supersededBy: report.supersededBy,
    procedureMatched: report.procedureMatched,
    verdict: report.verdict
  };
}

/**
 * 태스크 상태는 읽기 시점에 계산한다. 저장하면 태스크가 바뀔 때마다 두 곳을
 * 고쳐야 하고, 고치지 않은 쪽이 조용히 거짓말을 한다 — REQ-047이 파생 가능한
 * 값의 저장을 금지하는 이유다.
 *
 * 반려된 태스크가 할당을 닫지는 않는다. 닫음의 판정자가 셋이 되고 그중 하나가
 * 할당을 쳐다보지도 않는 명령에 살게 되기 때문이다. 상태는 보여 주되 판정은
 * 사람이 한다.
 */
function taskStatusMap(layout, project, assignments) {
  const wanted = new Set(assignments.map((item) => item.taskId).filter(Boolean));
  const statuses = new Map();
  if (!wanted.size) return statuses;
  let store;
  try { store = require('./tasks').readTaskStore(project.tasks); }
  catch (error) { return statuses; }
  for (const [id, task] of Object.entries((store && store.tasks) || {})) {
    if (wanted.has(id)) statuses.set(id, task.status || null);
  }
  return statuses;
}

/** 프로젝트의 할당 목록. 열린 것만 보려면 `open`을 준다. */
function listAssignments(start, input) {
  const values = input || {};
  const state = readAssignments(start, values.project);
  const statuses = taskStatusMap(state.layout, state.project, state.assignments);
  const selected = state.assignments.filter((item) => (values.open ? item.state === 'open' : true));
  return {
    project: state.project.key,
    count: selected.length,
    assignments: selected.map((item) => projectAssignment(item, statuses)),
    diagnostics: state.diagnostics
  };
}

/** 할당 하나와 그 보고 전부. 대체된 보고도 남는다. */
function showAssignment(start, input) {
  const values = input || {};
  const state = readAssignments(start, values.project);
  const target = findAssignment(state, values.assignmentId);
  const statuses = taskStatusMap(state.layout, state.project, [target]);
  return Object.assign(projectAssignment(target, statuses), {
    project: state.project.key,
    reports: target.reports.map(projectReport)
  });
}

module.exports = {
  ASSIGNMENT_ID,
  REPORT_ID,
  AssignmentViolation,
  assignmentEnvelope,
  appendWorkEvent,
  workerOf,
  activeClient,
  uniqueId,
  eventsRootOf,
  readAssignments,
  declaredFunctionIds,
  pinProcedure,
  issueAssignment,
  cancelAssignment,
  submitReport,
  verifyLatestReport,
  listAssignments,
  showAssignment
};
