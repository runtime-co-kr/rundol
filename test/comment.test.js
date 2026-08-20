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
// device는 사람이 아니다. 기계의 종류이지 행위 주체가 아니라, 같은 데스크톱을 사람도
// 쓰고 AI도 쓴다. 실제로 그렇게 터졌다 — AI가 device Client로 댓글을 남겼더니 사람이
// 쓴 것으로 기록되고 승인 근거 자격까지 붙었다. 모르는 유형과 같은 처지이므로 같은
// 규칙을 적용한다.
assert.strictEqual(workerKindOf('device'), 'agent');
// 사람이 근거 자격을 원하면 human 유형 Client를 등록한다. 그것이 자격을 얻는 길이고,
// 기계 종류를 사람으로 올려세우는 것은 그 길이 아니다.
assert.strictEqual(workerKindOf('human'), 'human');
assert.strictEqual(workerKindOf('agent'), 'agent');
assert.strictEqual(workerKindOf('service'), 'agent');
// 모르는 유형은 에이전트로 본다. 사람으로 잘못 보면 근거 자격을 잘못 주지만,
// 에이전트로 잘못 보면 자격을 잘못 뺏을 뿐이다. 덜 위험한 쪽으로 틀린다.
assert.strictEqual(workerKindOf('unknown-kind'), 'agent');

// 정정. 파생이 틀렸던 기간에 쌓인 기록은 틀린 채로 남아 승인 근거 자격을 계속 갖는다.
// 지난 기록을 고쳐 쓰지 않는 원칙을 지킨 대가가 "AI가 쓴 것이 사람 것으로 남는다"이면,
// 원칙이 막으려던 것을 원칙이 지키는 셈이 된다. 그래서 원본을 두고 정정을 덧붙인다.
{
  const { applyCorrections } = require('../src/comment-rules');
  const original = {
    type: 'task.comment', eventId: 'EVT-AAAAAAAAAAAAAAAAAAAA', taskId: 'TASK-ABCD1234',
    body: '기록', workerKind: 'human', canGroundApproval: true, recordedAt: '2026-08-21T00:00:00.000Z', clientId: 'a'
  };
  const correction = {
    type: 'task.comment.corrected', eventId: 'EVT-BBBBBBBBBBBBBBBBBBBB',
    targetEventId: 'EVT-AAAAAAAAAAAAAAAAAAAA', workerKind: 'agent', reason: '기계 종류에서 잘못 파생됨',
    recordedAt: '2026-08-21T01:00:00.000Z', clientId: 'a'
  };

  const applied = applyCorrections([original, correction]);
  const fixed = applied.find((event) => event.eventId === original.eventId);
  assert.strictEqual(fixed.workerKind, 'agent', '정정이 작성 주체를 내려야 합니다.');
  assert.strictEqual(fixed.canGroundApproval, false, '정정이 승인 근거 자격을 함께 빼야 합니다.');
  assert.strictEqual(fixed.correctedBy, correction.eventId, '어느 정정이 고쳤는지 남아야 합니다.');
  assert.strictEqual(fixed.correctionReason, correction.reason, '왜 바뀌었는지가 없으면 기록이 아니라 덮어쓰기입니다.');

  // 원본은 변형되지 않는다. 원장은 append-only이고 접기가 값을 만들 뿐이다.
  assert.strictEqual(original.workerKind, 'human', '원본이 변형되면 이력이 지워집니다.');

  // 사람으로 올리는 정정은 받지 않는다. 올릴 수 있으면 정정이 곧 주장이 되고,
  // 주장을 막으려고 파생을 쓴 것이 무의미해진다.
  const upgrade = Object.assign({}, correction, { eventId: 'EVT-CCCCCCCCCCCCCCCCCCCC', workerKind: 'human' });
  const notUpgraded = applyCorrections([Object.assign({}, original, { workerKind: 'agent', canGroundApproval: false }), upgrade]);
  assert.strictEqual(notUpgraded.find((e) => e.eventId === original.eventId).workerKind, 'agent', '사람으로 올리는 정정은 무시되어야 합니다.');

  // 정정이 없으면 그대로다.
  assert.strictEqual(applyCorrections([original])[0].workerKind, 'human');
}
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
    clientType: 'human',
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
  // 사람 사례는 human 유형으로 등록한다. device로 두면 이 시험이 "기계 종류를 사람으로
  // 올려세운다"를 고정하게 되고, 그것이 바로 고친 결함이다.
  json(['client', 'register', 'laptop-a', '--name', '업무 노트북', '--type', 'human', '--owner', 'MEMBER-001']);
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

// ── 보드 ─────────────────────────────────────────────────────────────────
//
// 명령줄로만 읽을 수 있는 댓글은 보드에서 일하는 사람에게 없는 것과 같다.
// 세션 간 소통이 목적이었으므로, 보이지 않으면 기능이 아니라 껍데기다.
//
// 낡은 픽스처를 쓰지 않고 작업공간을 새로 만드는 이유는, 픽스처가 Client 개념이
// 없던 시절의 것이라 여기서 재려는 것 자체가 없기 때문이다.

const boardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-comment-board-'));
const boardEnv = Object.assign({}, process.env, { RUNDOL_HOME: path.join(boardRoot, 'runtime') });

function boardSetup(program, args) {
  const done = spawnSync(program, args, { cwd: boardRoot, encoding: 'utf8', env: boardEnv });
  assert.strictEqual(done.status, 0, `${program} ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
  return done.stdout;
}

boardSetup('git', ['init', '-b', 'main']);
boardSetup('git', ['config', 'user.name', 'Rundol Test']);
boardSetup('git', ['config', 'user.email', 'rundol@example.test']);
fs.writeFileSync(path.join(boardRoot, 'README.md'), '# board comment\n', 'utf8');
boardSetup('git', ['add', 'README.md']);
boardSetup('git', ['commit', '-m', 'initial']);
boardSetup(process.execPath, [cli, 'init', 'crm', '--name', 'CRM', '--profile', 'lean', '--root', boardRoot, '--json']);
const boardTask = JSON.parse(boardSetup(process.execPath, [cli, 'task', 'add', '보드 댓글 대상', '--project', 'crm',
  '--acceptance', '보드에서 댓글이 달린다', '--root', boardRoot, '--json'])).taskId;

(async () => {
  const { createBoardServer } = require('../src/board');
  const board = createBoardServer(boardRoot, { project: 'crm', token: 'comment-test-token' });
  await new Promise((resolve) => board.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${board.server.address().port}`;
  try {
    const snapshot = await (await fetch(`${base}/api/projects/crm/board-snapshot`)).json();
    // 스냅숏이 댓글을 실어야 화면이 두 번 묻지 않는다.
    assert(Array.isArray(snapshot.comments), '스냅숏에 comments가 없습니다.');
    // 영역 revision이 따로 있어야 댓글만 늘었을 때 태스크 목록을 다시 그리지 않는다.
    assert.strictEqual(typeof snapshot.revision.comments, 'string', 'comments 영역 revision이 없습니다.');

    const post = (text) => fetch(`${base}/api/tasks/${boardTask}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': board.token },
      body: JSON.stringify({ body: text })
    });

    // 쓰기에는 세션 토큰이 필요하다.
    const denied = await fetch(`${base}/api/tasks/${boardTask}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: '토큰 없이' })
    });
    assert.notStrictEqual(denied.status, 201, '토큰 없이 댓글이 저장됐습니다.');

    // 이 기기가 Client로 등록되지 않았으면 남길 수 없다. 신원 없는 기록은 나중에
    // 누구에게도 물을 수 없기 때문이다. 다만 그것은 서버 결함이 아니므로 500이
    // 아니라 무엇을 해야 하는지 알려주는 응답이어야 한다.
    assert.strictEqual(snapshot.client.registered, false, '갓 만든 작업공간의 기기가 이미 등록돼 있습니다.');
    const refused = await post('등록 전에 남긴 댓글');
    assert.strictEqual(refused.status, 403, `등록되지 않은 기기에 403이 아닙니다: ${refused.status}`);
    const detail = await refused.json();
    assert.strictEqual(detail.code, 'unknown-client');
    assert(detail.error.includes('rdl client register'), '무엇을 해야 하는지 알려야 합니다.');

    // 등록하면 풀린다.
    boardSetup(process.execPath, [cli, 'client', 'register', snapshot.client.id, '--name', '보드 시험 기기',
      '--type', 'device', '--owner', 'MEMBER-001', '--root', boardRoot, '--json']);

    const created = await post('보드에서 남긴 댓글입니다.');
    assert.strictEqual(created.status, 201, `보드에서 댓글을 남기지 못했습니다: ${created.status}`);
    const saved = (await created.json()).comment;
    assert.strictEqual(saved.taskId, boardTask);
    // 화면에서 왔다고 사람이 되는 것이 아니다. 주체는 Client 유형에서 파생한다.
    assert.strictEqual(saved.workerKind, 'agent', 'device 유형은 행위 주체를 담지 않으므로 에이전트로 떨어져야 합니다.');
    // 자격도 함께 빠진다. 이 둘이 갈리면 "에이전트가 쓴 것으로 기록되는데 승인 근거는
    // 된다"가 되어, 종류를 바로잡은 것이 아무것도 막지 못한다.
    assert.strictEqual(saved.canGroundApproval, false, '에이전트가 쓴 댓글에 승인 근거 자격을 주면 안 됩니다.');

    const listed = await (await fetch(`${base}/api/tasks/${boardTask}/comments`)).json();
    assert.strictEqual(listed.count, 1);
    assert.strictEqual(listed.comments[0].body, '보드에서 남긴 댓글입니다.');

    // 다시 부른 스냅숏에 반영되어야 폴링으로 다른 세션의 댓글이 보인다.
    const after = await (await fetch(`${base}/api/projects/crm/board-snapshot`)).json();
    assert.strictEqual(after.comments.length, 1, '스냅숏이 새 댓글을 싣지 않았습니다.');
    assert.notStrictEqual(after.revision.comments, snapshot.revision.comments, '댓글이 늘었는데 영역 revision이 그대로입니다.');
  } finally {
    board.server.close();
  }
})().then(() => {
  process.stdout.write('comment tests passed\n');
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(boardRoot, { recursive: true, force: true });
});
