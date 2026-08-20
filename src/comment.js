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

module.exports = { addComment, listComments, summarizeComments, readCommentEvents, CommentViolation };
