'use strict';

// 태스크 댓글의 저장과 조회. 판정은 comment-rules.js가 하고 여기서는 읽고 쓴다.
//
// 저장 자리를 이벤트 원장으로 고른 이유는 동시성이다. 두 세션이 같은 태스크에
// 동시에 댓글을 달아도 append-only 조각 파일이라 Git 병합이 그대로 푼다. 태스크
// 파일 안에 넣었다면 같은 줄을 두 세션이 고쳐 충돌이 났을 것이고, 그 충돌을
// 사람이 풀어야 했을 것이다. 논의 때문에 작업이 막히는 구조는 논의를 죽인다.
//
// 그리고 태스크 파일의 diff를 논의가 덮지 않는다. 태스크가 무엇이 바뀌었는지를
// 보여주는 그릇이라면, 그 위에 대화를 쌓는 순간 그 그릇이 안 보인다.

const crypto = require('crypto');
const path = require('path');
const eventStore = require('./event-store');
const { workspaceLayout, selectProject } = require('./workspace');
const { getClient } = require('./collaboration-store');
const { composeComment, commentsForTask, orderComments, commentSummary, CommentViolation } = require('./comment-rules');

const SIMPLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TASK_ID = /^TASK-[A-Z0-9]{8,26}$/u;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function eventsRootOf(layout) {
  return path.join(layout.root, 'projects', 'workspace', 'events');
}

// 판정에 쓰는 값은 다이제스트가 덮어야 한다. 덮지 않으면 같은 eventId의 내용을
// 나중에 고쳐도 상충으로 잡히지 않고, 그러면 "누가 무엇을 썼는가"가 흔들린다.
function commentEnvelope(input) {
  const canonical = {
    schemaVersion: 1,
    eventId: input.eventId,
    type: 'task.comment',
    clientId: input.clientId,
    projectId: input.projectId,
    taskId: input.taskId,
    body: input.body,
    workerKind: input.workerKind,
    member: input.member,
    canGroundApproval: input.canGroundApproval,
    recordedAt: input.recordedAt
  };
  const digest = sha256(Buffer.from(eventStore.canonicalJson(canonical), 'utf8'));
  return { canonical, shared: Object.assign({}, canonical, { canonicalDigest: digest }) };
}

/**
 * 태스크에 댓글을 남긴다.
 *
 * 작성 주체는 등록된 Client의 유형에서 파생한다. 호출자가 주장하는 값을 받지
 * 않는 이유는 ADR-020이 막으려 한 순환 때문이다 — 에이전트가 사람이라고 적을 수
 * 있으면, AI가 쓴 것을 AI가 읽고 승인 근거로 삼는 길이 열린다.
 */
function addComment(start, input) {
  const values = input || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, values.project, true);
  if (!SIMPLE_ID.test(values.clientId || '')) throw new CommentViolation('--client-id가 필요합니다.', 'missing-client');
  // 등록되지 않은 Client는 getClient가 던진다. 그 사유를 댓글 계약 위반으로
  // 바꿔 다시 던지는 이유는, 호출자가 두 종류의 오류를 구분해 다룰 수 있어야
  // 하기 때문이다 — 하나는 등록하면 풀리고 다른 하나는 내용을 고쳐야 풀린다.
  let client;
  try { client = getClient(layout.root, values.clientId); }
  catch (error) { throw new CommentViolation(error.message, 'unknown-client'); }
  if (client.status !== 'active') throw new CommentViolation(`비활성 Client는 댓글을 남길 수 없습니다: ${values.clientId}`, 'inactive-client');
  const taskId = String(values.taskId || '');
  if (!TASK_ID.test(taskId)) throw new CommentViolation(`태스크 식별자가 유효하지 않습니다: ${taskId || '(없음)'}`, 'missing-task');

  const composed = composeComment({
    taskId,
    body: values.body,
    clientId: values.clientId,
    clientType: client.type,
    member: values.member || client.owner || null,
    recordedAt: new Date().toISOString()
  });

  const envelope = commentEnvelope({
    eventId: `EVT-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
    clientId: composed.clientId,
    projectId: project.key,
    taskId: composed.taskId,
    body: composed.body,
    workerKind: composed.workerKind,
    member: composed.member,
    canGroundApproval: composed.canGroundApproval,
    recordedAt: composed.recordedAt
  });

  const file = eventStore.appendEvent(eventsRootOf(layout), 'comment', project.key, composed.clientId, envelope.shared, {
    lockDirectory: path.join(layout.root, 'projects', 'workspace', '.rundol', 'local', 'locks')
  });
  return { changed: true, project: project.key, file, comment: envelope.shared };
}

// 정정 이벤트의 다이제스트. 원본과 같은 규칙을 쓴다 — 판정에 쓰는 값은 덮어야 하고,
// 정정도 판정에 쓰이므로 예외가 아니다.
function correctionEnvelope(input) {
  const canonical = {
    schemaVersion: 1,
    eventId: input.eventId,
    type: 'task.comment.corrected',
    clientId: input.clientId,
    projectId: input.projectId,
    targetEventId: input.targetEventId,
    workerKind: input.workerKind,
    reason: input.reason,
    recordedAt: input.recordedAt
  };
  const digest = sha256(Buffer.from(eventStore.canonicalJson(canonical), 'utf8'));
  return { canonical, shared: Object.assign({}, canonical, { canonicalDigest: digest }) };
}

/**
 * 잘못 파생된 작성 주체를 바로잡는다. 원본을 고치지 않고 정정을 덧붙인다.
 *
 * 지난 기록을 고쳐 쓰지 않는 것이 이 저장소의 원칙인데, 파생이 틀렸던 기간에 쌓인
 * 기록은 틀린 채로 남아 승인 근거 자격을 계속 갖는다. 원칙을 지킨 대가가 "AI가 쓴
 * 것이 사람 것으로 남는다"이면 원칙이 막으려던 것을 원칙이 지키는 셈이 된다.
 *
 * 그래서 원본과 정정이 모두 원장에 남고, 판정은 둘을 접어 나온다. 무엇이 왜 바뀌었는지
 * 읽을 수 있고 이력은 지워지지 않는다.
 *
 * 사람으로 올리는 정정은 받지 않는다. 올릴 수 있으면 정정이 곧 주장이 되고, 주장을
 * 막으려고 파생을 쓴 것이 무의미해진다.
 */
function correctComment(start, input) {
  const values = input || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, values.project, true);
  if (!SIMPLE_ID.test(values.clientId || '')) throw new CommentViolation('--client-id가 필요합니다.', 'missing-client');
  let client;
  try { client = getClient(layout.root, values.clientId); }
  catch (error) { throw new CommentViolation(error.message, 'unknown-client'); }
  if (client.status !== 'active') throw new CommentViolation(`비활성 Client는 정정할 수 없습니다: ${values.clientId}`, 'inactive-client');

  const targetEventId = String(values.targetEventId || '');
  if (!/^EVT-[A-F0-9]{20}$/u.test(targetEventId)) throw new CommentViolation(`정정할 댓글 식별자가 유효하지 않습니다: ${targetEventId || '(없음)'}`, 'missing-target');
  if (values.workerKind !== 'agent') throw new CommentViolation('정정은 작성 주체를 에이전트로 내리는 방향만 받습니다.', 'invalid-direction');
  const reason = String(values.reason || '').trim();
  if (!reason) throw new CommentViolation('정정 사유가 필요합니다. 왜 바뀌었는지가 없으면 기록이 아니라 덮어쓰기입니다.', 'missing-reason');

  // 접힌 결과가 아니라 원본 이벤트에서 찾는다. 접기는 정정을 이미 적용하고 정정
  // 이벤트 자체를 걸러내므로, 접힌 것에서 찾으면 같은 댓글을 두 번 정정할 때
  // 두 번째가 "찾지 못했습니다"로 떨어진다.
  const raw = eventStore.readEvents(eventsRootOf(layout), 'comment', project.key, {});
  const rawEvents = raw.events || raw || [];
  const target = rawEvents.find((event) => event && event.eventId === targetEventId && event.type === 'task.comment');
  if (!target) throw new CommentViolation(`정정할 댓글을 찾지 못했습니다: ${targetEventId}`, 'unknown-target');
  if (target.workerKind === 'agent') throw new CommentViolation('이미 에이전트로 기록된 댓글입니다.', 'already-agent');

  const envelope = correctionEnvelope({
    eventId: `EVT-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
    clientId: values.clientId,
    projectId: project.key,
    targetEventId,
    workerKind: 'agent',
    reason,
    recordedAt: new Date().toISOString()
  });

  const file = eventStore.appendEvent(eventsRootOf(layout), 'comment', project.key, values.clientId, envelope.shared, {
    lockDirectory: path.join(layout.root, 'projects', 'workspace', '.rundol', 'local', 'locks')
  });
  return { changed: true, project: project.key, file, correction: envelope.shared };
}

function readCommentEvents(start, projectKey) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  const read = eventStore.readEvents(eventsRootOf(layout), 'comment', project.key, {});
  // 원장 조각은 여러 Client가 각자 쓴다. 읽는 쪽에서 하나의 시간 순서로 접는다.
  return { project: project.key, events: orderComments(read.events || read || []) };
}

/** 한 태스크의 댓글을 시간 순으로. */
function listComments(start, input) {
  const values = input || {};
  const { project, events } = readCommentEvents(start, values.project);
  const comments = values.taskId ? commentsForTask(events, values.taskId) : events;
  return { project, taskId: values.taskId || null, count: comments.length, comments };
}

/** 태스크별 댓글 수. 목록 화면이 전체를 읽지 않고 "논의가 있는 태스크"를 표시하게 한다. */
function summarizeComments(start, input) {
  const values = input || {};
  const { project, events } = readCommentEvents(start, values.project);
  const tasks = commentSummary(events);
  return { project, taskCount: tasks.length, total: events.length, tasks };
}

module.exports = { addComment, correctComment, listComments, summarizeComments, readCommentEvents, CommentViolation };
