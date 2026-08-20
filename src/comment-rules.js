'use strict';

// 태스크 댓글의 판정부. require를 하나도 갖지 않는다 — 값만 보고 답한다.
//
// 이 모듈이 순수해야 하는 이유는 정리가 아니라 답의 일치다. 명령줄이 받는 판정과
// 보드가 받는 판정이 갈리면, 같은 댓글이 어디서 보느냐에 따라 다른 자격을 갖게 된다.
//
// 작성 주체는 댓글이 스스로 주장하지 않는다. 등록된 Client의 유형에서 파생된다.
// 주장하게 두면 에이전트가 사람이라고 적을 수 있고, 그 순간 ADR-020이 막으려 한
// 순환 — AI가 쓴 것을 AI가 읽고 승인 근거로 삼는 것 — 이 열린다.

/** 댓글 본문의 상한. 논의가 길어지면 태스크를 쪼개거나 결정으로 올린다. */
const MAX_COMMENT_LENGTH = 4000;

/** Client 유형에서 워커 종류로. 등록되지 않은 유형은 사람으로 올려 세지 않는다. */
const WORKER_KIND_BY_CLIENT = { human: 'human', device: 'human', agent: 'agent', service: 'agent' };

/**
 * Client 유형에서 작성 주체를 정한다. 모르는 유형은 에이전트로 본다 —
 * 사람으로 잘못 보면 AI가 쓴 것이 승인 근거 자격을 얻지만, 에이전트로 잘못 보면
 * 사람이 근거 자격을 잃을 뿐이다. 틀리는 방향을 고를 수 있으면 덜 위험한 쪽으로
 * 틀린다.
 */
function workerKindOf(clientType) {
  return WORKER_KIND_BY_CLIENT[String(clientType || '')] || 'agent';
}

/**
 * 댓글이 승인 근거가 될 수 있는가.
 *
 * ADR-020: AI가 쓴 것을 AI가 읽고 판정하면 근거가 순환하고, 그 순환은 겉보기에
 * 합의로 보인다. 그래서 자격은 작성 주체가 사람일 때만 준다.
 */
function canGroundApproval(comment) {
  return Boolean(comment) && comment.workerKind === 'human';
}

/** 제출 계약을 갖추지 못한 댓글의 거부 사유. */
class CommentViolation extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CommentViolation';
    this.code = code || 'invalid';
  }
}

/**
 * 댓글 입력을 검사해 저장할 값으로 만든다. 갖추지 못했으면 예외로 알린다.
 *
 * 값만 받는다. 태스크가 실재하는지, Client가 등록되어 있고 활성인지는 호출자가
 * 확인해 값으로 넘긴다 — 여기서 조회를 시작하면 표면마다 답이 갈린다.
 */
function composeComment(input) {
  const values = input || {};
  const body = typeof values.body === 'string' ? values.body.replace(/\r\n/gu, '\n').trim() : '';
  if (!body) throw new CommentViolation('댓글 내용이 비어 있습니다.', 'empty-body');
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new CommentViolation(
      `댓글이 ${body.length}자로 상한 ${MAX_COMMENT_LENGTH}자를 넘습니다. 길어지면 태스크를 쪼개거나 결정으로 올리세요.`,
      'body-too-long'
    );
  }
  if (!values.taskId) throw new CommentViolation('댓글을 달 태스크가 필요합니다.', 'missing-task');
  if (!values.clientId) throw new CommentViolation('작성한 Client가 필요합니다.', 'missing-client');
  if (!values.recordedAt) throw new CommentViolation('작성 시각이 필요합니다.', 'missing-time');

  const workerKind = workerKindOf(values.clientType);
  return {
    type: 'task.comment',
    taskId: String(values.taskId),
    body,
    // 작성 주체는 둘로 나눠 적는다. clientId는 누가 썼는지고 workerKind는 그것이
    // 어떤 종류인지다. 뒤엣것만 남기면 같은 종류의 여럿을 구분할 수 없고, 앞엣것만
    // 남기면 나중에 Client 등록이 바뀔 때 지난 댓글의 자격이 소급해서 흔들린다.
    clientId: String(values.clientId),
    workerKind,
    // 사람이 남긴 것이면 어느 구성원인지도 적는다. 없으면 Client 소유자를 쓴다.
    member: values.member ? String(values.member) : null,
    // 자격을 값으로 굳혀 둔다. 읽는 쪽마다 다시 계산하면 규칙이 바뀔 때 지난
    // 댓글의 자격이 조용히 달라진다.
    canGroundApproval: workerKind === 'human',
    recordedAt: String(values.recordedAt)
  };
}

/**
 * 저장된 댓글을 시간 순으로 정리한다. 같은 시각이면 Client 식별자로 가른다 —
 * 순서가 읽는 쪽마다 다르면 "위에서 세 번째 댓글"이라는 말이 통하지 않는다.
 */
function orderComments(events) {
  return (events || [])
    .filter((event) => event && event.type === 'task.comment' && event.taskId)
    .slice()
    .sort((left, right) => String(left.recordedAt).localeCompare(String(right.recordedAt))
      || String(left.clientId).localeCompare(String(right.clientId)));
}

/** 한 태스크의 댓글만 고른다. */
function commentsForTask(events, taskId) {
  const target = String(taskId || '');
  return orderComments(events).filter((event) => event.taskId === target);
}

/**
 * 태스크별 댓글 수와 마지막 작성 시각. 목록 화면이 "논의가 있는 태스크"를
 * 표시하려면 전체를 읽지 않고도 알 수 있어야 한다.
 */
function commentSummary(events) {
  const byTask = new Map();
  for (const event of orderComments(events)) {
    const entry = byTask.get(event.taskId) || { taskId: event.taskId, count: 0, human: 0, agent: 0, lastAt: null };
    entry.count += 1;
    if (event.workerKind === 'human') entry.human += 1; else entry.agent += 1;
    entry.lastAt = event.recordedAt;
    byTask.set(event.taskId, entry);
  }
  return Array.from(byTask.values()).sort((left, right) => left.taskId.localeCompare(right.taskId));
}

module.exports = {
  MAX_COMMENT_LENGTH, CommentViolation,
  workerKindOf, canGroundApproval, composeComment, orderComments, commentsForTask, commentSummary
};
