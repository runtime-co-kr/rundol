'use strict';

// 태스크 댓글 시험(REQ-059).
//
// 두 세션이 같은 저장소에서 도는데 서로에게 말을 걸 수단이 없었다. 여기서 보는
// 것은 그 자리가 실제로 생겼는가 — 그리고 ADR-020이 정한 제약, 곧 AI가 쓴 것이
// 승인 근거가 되지 않는다는 것이 값으로 지켜지는가이다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  MAX_COMMENT_LENGTH, CommentViolation,
  workerKindOf, canGroundApproval, composeComment, orderComments, commentsForTask, commentSummary
} = require('../src/comment-rules');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');

// ── 작성 주체 판정 ───────────────────────────────────────────────────────
//
// 주체는 댓글이 주장하지 않고 Client 유형에서 파생한다. 주장하게 두면 에이전트가
// 사람이라고 적을 수 있고, 그 순간 AI가 쓴 것을 AI가 읽고 승인 근거로 삼는 길이
// 열린다.

assert.strictEqual(workerKindOf('human'), 'human');
assert.strictEqual(workerKindOf('device'), 'human');
assert.strictEqual(workerKindOf('agent'), 'agent');
assert.strictEqual(workerKindOf('service'), 'agent');
// 모르는 유형은 에이전트로 본다. 사람으로 잘못 보면 근거 자격을 잘못 주지만,
// 에이전트로 잘못 보면 자격을 잘못 뺏을 뿐이다. 덜 위험한 쪽으로 틀린다.
assert.strictEqual(workerKindOf('unknown-kind'), 'agent');
assert.strictEqual(workerKindOf(undefined), 'agent');

assert.strictEqual(canGroundApproval({ workerKind: 'human' }), true);
assert.strictEqual(canGroundApproval({ workerKind: 'agent' }), false);
assert.strictEqual(canGroundApproval(null), false);

// ── 제출 계약 ────────────────────────────────────────────────────────────

function input(overrides) {
  return Object.assign({
    taskId: 'TASK-ABCD1234',
    body: '  이어서 하시면 됩니다.  ',
    clientId: 'laptop-a',
    clientType: 'device',
    member: 'MEMBER-001',
    recordedAt: '2026-08-21T00:00:00.000Z'
  }, overrides);
}

const composed = composeComment(input());
assert.strictEqual(composed.type, 'task.comment');
assert.strictEqual(composed.body, '이어서 하시면 됩니다.', '앞뒤 공백을 다듬어야 합니다.');
assert.strictEqual(composed.workerKind, 'human');
assert.strictEqual(composed.canGroundApproval, true);

// 에이전트가 남긴 것은 자격이 없다. 이것이 ADR-020의 제약이 값이 되는 자리다.
const byAgent = composeComment(input({ clientType: 'agent' }));
assert.strictEqual(byAgent.workerKind, 'agent');
assert.strictEqual(byAgent.canGroundApproval, false);

// 빈 내용은 받지 않는다. 빈 댓글은 알림만 만들고 아무것도 전하지 않는다.
assert.throws(() => composeComment(input({ body: '   ' })), (error) => error instanceof CommentViolation && error.code === 'empty-body');
assert.throws(() => composeComment(input({ body: 'x'.repeat(MAX_COMMENT_LENGTH + 1) })), (error) => error.code === 'body-too-long');
assert.throws(() => composeComment(input({ taskId: '' })), (error) => error.code === 'missing-task');
assert.throws(() => composeComment(input({ clientId: '' })), (error) => error.code === 'missing-client');
assert.throws(() => composeComment(input({ recordedAt: '' })), (error) => error.code === 'missing-time');

// 순수 함수다. 같은 입력이면 같은 답이고 입력을 바꾸지 않는다.
{
  const values = input();
  const frozen = JSON.stringify(values);
  const once = JSON.stringify(composeComment(values));
  assert.strictEqual(JSON.stringify(composeComment(values)), once);
  assert.strictEqual(JSON.stringify(values), frozen, '판정이 입력을 바꿨습니다.');
}

// ── 정렬과 집계 ──────────────────────────────────────────────────────────
//
// 순서가 읽는 쪽마다 다르면 "위에서 세 번째 댓글"이라는 말이 통하지 않는다.

function event(taskId, recordedAt, clientId, workerKind) {
  return { type: 'task.comment', taskId, recordedAt, clientId, workerKind, body: 'x' };
}

const ledger = [
  event('TASK-B', '2026-08-21T00:00:03.000Z', 'laptop-a', 'human'),
  event('TASK-A', '2026-08-21T00:00:01.000Z', 'agent-b', 'agent'),
  event('TASK-A', '2026-08-21T00:00:02.000Z', 'laptop-a', 'human'),
  // 같은 시각이면 Client 식별자로 가른다. 두 세션이 동시에 쓰면 실제로 생긴다.
  event('TASK-A', '2026-08-21T00:00:01.000Z', 'agent-a', 'agent'),
  { type: 'approval.granted', taskId: 'TASK-A' }
];

const ordered = orderComments(ledger);
assert.strictEqual(ordered.length, 4, '댓글이 아닌 이벤트를 세면 안 됩니다.');
assert.deepStrictEqual(
  ordered.map((item) => `${item.recordedAt}/${item.clientId}`),
  [
    '2026-08-21T00:00:01.000Z/agent-a',
    '2026-08-21T00:00:01.000Z/agent-b',
    '2026-08-21T00:00:02.000Z/laptop-a',
    '2026-08-21T00:00:03.000Z/laptop-a'
  ]
);

assert.deepStrictEqual(commentsForTask(ledger, 'TASK-A').map((item) => item.clientId), ['agent-a', 'agent-b', 'laptop-a']);
assert.deepStrictEqual(commentsForTask(ledger, 'TASK-없음'), []);

const summary = commentSummary(ledger);
assert.deepStrictEqual(summary, [
  { taskId: 'TASK-A', count: 3, human: 1, agent: 2, lastAt: '2026-08-21T00:00:02.000Z' },
  { taskId: 'TASK-B', count: 1, human: 1, agent: 0, lastAt: '2026-08-21T00:00:03.000Z' }
]);

// ── 명령 ─────────────────────────────────────────────────────────────────

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-comment-'));
try {
  const env = Object.assign({}, process.env, { RUNDOL_HOME: path.join(temporary, 'runtime') });
  const run = (args) => spawnSync(process.execPath, [cli].concat(args, ['--root', temporary]), { cwd: repository, encoding: 'utf8', env });
  const json = (args) => {
    const done = run(args.concat(['--json']));
    assert.strictEqual(done.status, 0, `rdl ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
    return JSON.parse(done.stdout);
  };
  const setup = (program, args) => {
    const done = spawnSync(program, args, { cwd: temporary, encoding: 'utf8', env });
    assert.strictEqual(done.status, 0, `${program} ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
  };
  setup('git', ['init', '-b', 'main']);
  setup('git', ['config', 'user.name', 'Rundol Test']);
  setup('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# comment\n', 'utf8');
  setup('git', ['add', 'README.md']);
  setup('git', ['commit', '-m', 'initial']);
  json(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  json(['client', 'register', 'laptop-a', '--name', '업무 노트북', '--type', 'device', '--owner', 'MEMBER-001']);
  json(['client', 'register', 'agent-a', '--name', '작업 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);
  const task = json(['task', 'add', '댓글 대상', '--project', 'crm', '--acceptance', '댓글이 달린다']);

  // 사람이 남긴 것과 에이전트가 남긴 것이 같은 자리에 쌓이되 자격이 갈린다.
  const human = json(['task', 'comment', task.taskId, '사람이 남긴 확인입니다.', '--project', 'crm', '--client-id', 'laptop-a']);
  assert.strictEqual(human.comment.workerKind, 'human');
  assert.strictEqual(human.comment.canGroundApproval, true);
  assert.strictEqual(human.comment.member, 'MEMBER-001', 'Client 소유자가 구성원으로 남아야 합니다.');

  const agent = json(['task', 'comment', task.taskId, '에이전트가 남긴 보고입니다.', '--project', 'crm', '--client-id', 'agent-a']);
  assert.strictEqual(agent.comment.workerKind, 'agent');
  assert.strictEqual(agent.comment.canGroundApproval, false, 'AI가 쓴 댓글에 승인 근거 자격을 주면 안 됩니다.');

  // 서로 다른 Client는 서로 다른 조각에 쓴다. 그래야 동시에 써도 병합이 푼다.
  assert.notStrictEqual(human.file, agent.file, '작성자별로 조각이 갈려야 합니다.');
  const shards = fs.readdirSync(path.join(temporary, 'projects', 'workspace', 'events', 'comment'));
  assert.strictEqual(shards.length, 2, `작성자 둘이면 조각도 둘이어야 합니다: ${shards.join(', ')}`);

  const listed = json(['task', 'comments', task.taskId, '--project', 'crm']);
  assert.strictEqual(listed.count, 2);
  assert.deepStrictEqual(listed.comments.map((item) => item.workerKind), ['human', 'agent'], '시간 순서를 지켜야 합니다.');

  const overview = json(['task', 'comments', '--project', 'crm']);
  assert.strictEqual(overview.taskCount, 1);
  assert.deepStrictEqual(overview.tasks[0], {
    taskId: task.taskId, count: 2, human: 1, agent: 1, lastAt: agent.comment.recordedAt
  });

  // 사람이 읽는 출력이 실제로 읽히는지 본다. 중첩 객체를 한 줄로 편 대화는
  // 아무도 안 읽고, 그러면 이 기능은 있어도 없는 것이다.
  const text = run(['task', 'comments', task.taskId, '--project', 'crm']);
  assert.strictEqual(text.status, 0, text.stderr);
  assert(text.stdout.includes('사람이 남긴 확인입니다.'), '댓글 본문이 보여야 합니다.');
  assert(text.stdout.includes('(사람)') && text.stdout.includes('(에이전트)'), '작성 주체가 보여야 합니다.');

  // 등록되지 않은 Client는 쓸 수 없다. 신원 없는 기록은 나중에 누구에게도 물을 수 없다.
  const unknown = run(['task', 'comment', task.taskId, '내용', '--project', 'crm', '--client-id', 'nobody']);
  assert.notStrictEqual(unknown.status, 0, '등록되지 않은 Client가 댓글을 남겼습니다.');

  // 비활성 Client도 막는다.
  json(['client', 'disable', 'agent-a']);
  const disabled = run(['task', 'comment', task.taskId, '내용', '--project', 'crm', '--client-id', 'agent-a']);
  assert.notStrictEqual(disabled.status, 0, '비활성 Client가 댓글을 남겼습니다.');
  assert(disabled.stderr.includes('비활성'), '거절 사유가 무엇인지 말해야 합니다.');

  // 태스크 식별자 형식을 지킨다. 없는 태스크에 붙은 댓글은 아무도 못 본다.
  const badTask = run(['task', 'comment', 'NOT-A-TASK', '내용', '--project', 'crm', '--client-id', 'laptop-a']);
  assert.notStrictEqual(badTask.status, 0, '잘못된 태스크 식별자를 받았습니다.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('comment tests passed\n');
