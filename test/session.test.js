'use strict';

// 세션 작업 공간. 식별자 파생은 순수하므로 값으로 재고, worktree 계약은 실제
// 저장소에서 잰다 — 이 모듈이 지키려는 불변식("한 브랜치는 한 작업 트리에만")은
// Git이 판정하므로 Git 없이 재면 재는 것이 없다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const session = require('../src/session');

// ── 식별자 파생 ──────────────────────────────────────────────────────────

assert.strictEqual(session.shortSessionId('7fdeb6de-00e3-4d34-9560-44ae0dd3aaff'), '7fdeb6de');
assert.strictEqual(session.shortSessionId('7FDEB6DE-00E3'), '7fdeb6de', '대소문자는 같은 이름을 만든다');
assert.strictEqual(session.sessionBranch('7fdeb6de'), 'session/7fdeb6de');
// 브랜치 이름 규칙은 workset이 갖는다. 여기서 다시 정의하지 않고 통과만 확인한다.
assert.throws(() => session.normalizeSessionId(''), /잘못된 세션 식별자/u);
assert.throws(() => session.normalizeSessionId('   '), /잘못된 세션 식별자/u);

// 파생 사다리. 인수가 환경을 이기고, 환경이 생성을 이긴다 — 명시한 값이 무시되면
// 어댑터가 세션을 지정할 방법이 없어진다.
{
  const saved = session.SESSION_ENV.map((name) => [name, process.env[name]]);
  for (const [name] of saved) delete process.env[name];

  const generated = session.resolveSessionId(null);
  assert.strictEqual(generated.source, 'generated');
  assert.ok(/^[a-f0-9]{16}$/u.test(generated.sessionId), `생성된 식별자 모양: ${generated.sessionId}`);

  process.env.CLAUDE_CODE_SESSION_ID = 'host-abc';
  assert.deepStrictEqual(session.resolveSessionId(null), { sessionId: 'host-abc', source: 'CLAUDE_CODE_SESSION_ID' });
  // 중립 변수가 호스트 변수를 이긴다. 어댑터가 채우는 자리가 늘 우선이어야 새
  // 클라이언트가 src/session.js를 고치지 않고 붙는다.
  process.env.RUNDOL_SESSION_ID = 'neutral-xyz';
  assert.strictEqual(session.resolveSessionId(null).source, 'RUNDOL_SESSION_ID');
  assert.deepStrictEqual(session.resolveSessionId('explicit-1'), { sessionId: 'explicit-1', source: 'argument' });

  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// 생존을 말해 줄 프로세스도 받는다. 없으면 없다고 답해야 한다 — rdl 자신의 pid로
// 채우면 명령이 끝나는 순간 죽은 세션이 되고, "모른다"가 "죽었다"로 바뀐다.
{
  const saved = session.SESSION_PID_ENV.map((name) => [name, process.env[name]]);
  for (const [name] of saved) delete process.env[name];
  assert.deepStrictEqual(session.resolveSessionPid(), { pid: null, source: null });
  process.env.CLAUDE_PID = '4242';
  assert.deepStrictEqual(session.resolveSessionPid(), { pid: 4242, source: 'CLAUDE_PID' });
  process.env.RUNDOL_SESSION_PID = '777';
  assert.strictEqual(session.resolveSessionPid().source, 'RUNDOL_SESSION_PID');
  // 값이 pid가 아니면 없는 것으로 읽는다. 0이나 음수를 그대로 실으면 생존 확인이
  // 무의미한 값을 묻게 된다.
  process.env.RUNDOL_SESSION_PID = '0';
  assert.strictEqual(session.resolveSessionPid().source, 'CLAUDE_PID');
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// ── worktree 계약 ────────────────────────────────────────────────────────

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-session-')));
const repository = path.join(temporary, 'repo');

function sameDir(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || repository, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

fs.mkdirSync(repository, { recursive: true });
git(['init', '--quiet', '-b', 'main']);
git(['config', 'user.email', 'session@test']);
git(['config', 'user.name', 'session-test']);
fs.writeFileSync(path.join(repository, 'a.txt'), 'a\n');
git(['add', '-A']);
git(['commit', '--quiet', '-m', 'init']);

const SID = 'aabbccdd-1111-2222-3333-444455556666';

// 등록은 잠금 디렉터리에 남으므로 런타임 홈을 격리한다. 격리하지 않으면 이 시험이
// 실제 작업에 쓰는 잠금 자리에 쓰게 된다.
const savedEnv = ['RUNDOL_HOME'].concat(session.SESSION_PID_ENV).map((name) => [name, process.env[name]]);
process.env.RUNDOL_HOME = path.join(temporary, 'runtime');
for (const name of session.SESSION_PID_ENV) delete process.env[name];
process.env.CLAUDE_PID = String(process.pid);

try {
  const created = session.startSession(repository, { sessionId: SID });
  assert.strictEqual(created.action, 'created');
  // 세션은 명령보다 오래 산다. 그래서 등록은 놓지 않고 남고, 생존은 호스트가 알려준
  // pid가 답한다.
  assert.strictEqual(created.registered, true);
  assert.strictEqual(created.sessionPid, process.pid);
  assert.strictEqual(created.sessionPidSource, 'CLAUDE_PID');
  assert.ok(fs.existsSync(session.sessionLockFile(repository, 'aabbccdd')), '등록은 잠금 파일로 남는다');
  assert.deepStrictEqual(session.sessionLiveness(repository, 'aabbccdd'), { pid: process.pid, alive: true });
  assert.strictEqual(created.short, 'aabbccdd');
  assert.strictEqual(created.branch, 'session/aabbccdd');
  assert.strictEqual(created.sessionIdSource, 'argument');
  // 기본 자리는 저장소의 형제다. 안에 두면 추적 제외를 빠뜨린 한 번에 세션 트리
  // 전체가 커밋된다.
  assert.strictEqual(path.dirname(created.path), path.dirname(repository));
  assert.ok(fs.existsSync(path.join(created.path, 'a.txt')), '작업 트리에 내용이 펼쳐진다');
  assert.strictEqual(git(['rev-parse', '--abbrev-ref', 'HEAD'], created.path), 'session/aabbccdd');

  // 두 번째 호출은 실패가 아니라 같은 자리다. 세션은 끊겼다 이어지므로 재진입이
  // 오류면 이어붙이는 쪽이 상태를 따로 기억해야 한다.
  const reused = session.startSession(repository, { sessionId: SID });
  assert.strictEqual(reused.action, 'reused');
  assert.strictEqual(reused.path, created.path);

  // 같은 세션을 다른 경로로 열려고 하면 거부한다. 여기서 받아 주면 한 브랜치가 두
  // 작업 트리에 체크아웃되고, 그때부터 한쪽의 커밋이 다른 쪽 HEAD를 조용히 옮긴다.
  assert.throws(
    () => session.startSession(repository, { sessionId: SID, path: path.join(temporary, 'elsewhere') }),
    /이미 다른 경로에 있습니다/u
  );

  // 자리를 지정해 연 세션은 자리를 지정하지 않고도 다시 들어온다. 기본 경로와
  // 다르다는 이유로 막으면 재진입 갈래가 자리를 옮긴 세션에만 닫힌다.
  {
    const custom = path.join(temporary, 'custom-space');
    const opened = session.startSession(repository, { sessionId: 'eeff0011-9999', path: custom });
    assert.strictEqual(opened.action, 'created');
    assert.ok(sameDir(opened.path, custom));
    const again = session.startSession(repository, { sessionId: 'eeff0011-9999' });
    assert.strictEqual(again.action, 'reused');
    assert.ok(sameDir(again.path, custom), '지정하지 않으면 이미 열린 자리가 답이다');

    // 둘이 함께 있는 상태. "나 말고 누가 있나"에 답하려면 이 목록이 정확해야 하고,
    // 오늘 난 사고는 전부 이 물음을 아무도 시작할 때 묻지 않아서 났다.
    const both = session.listSessions(repository).sessions;
    assert.strictEqual(both.length, 2, `동시 세션 둘을 다 본다: ${both.map((s) => s.short).join(',')}`);
    assert.deepStrictEqual(both.map((s) => s.alive), [true, true]);
    const live = require('../src/run-pending').liveSessions(repository);
    assert.strictEqual(live.length, 2, '조회 표면도 같은 답을 낸다');

    session.endSession(repository, { sessionId: 'eeff0011-9999' });
    assert.strictEqual(session.listSessions(repository).sessions.length, 1, '닫으면 목록에서 빠진다');
  }

  // 목록은 저장이 아니라 계산이다. 세션 worktree 안에서 물어도 본 저장소를 찾는다.
  for (const from of [repository, created.path]) {
    const listed = session.listSessions(from);
    assert.strictEqual(listed.root, repository, `본 저장소를 찾는다: ${from}`);
    assert.strictEqual(listed.sessions.length, 1);
    assert.strictEqual(listed.sessions[0].branch, 'session/aabbccdd');
    assert.strictEqual(listed.sessions[0].alive, true, '붙어 있는 세션은 살아 있다고 답한다');
    assert.strictEqual(listed.sessions[0].sessionPid, process.pid);
  }

  // 세션이 만든 커밋. 작업 공간을 닫아도 이건 남아야 하고, 남았다는 사실이
  // 출력에 있어야 한다 — worktree가 사라지면 이 세션은 list에서 빠지므로 여기서
  // 말하지 않으면 아무도 다시 묻지 않는다.
  fs.writeFileSync(path.join(created.path, 'c.txt'), 'c\n');
  git(['add', '-A'], created.path);
  git(['commit', '--quiet', '-m', 'session work'], created.path);

  // 커밋되지 않은 변경은 조용히 버리지 않는다. 세션이 끝난 것과 그 일이 끝난 것은
  // 다르고, 앞엣것으로 뒤엣것을 버리면 잃은 줄도 모른다.
  fs.writeFileSync(path.join(created.path, 'b.txt'), 'b\n');
  assert.throws(() => session.endSession(repository, { sessionId: SID }), /커밋되지 않은 변경이 1건/u);
  assert.ok(fs.existsSync(created.path), '거부했으면 지우지 않는다');

  const ended = session.endSession(repository, { sessionId: SID, force: true });
  assert.strictEqual(ended.action, 'removed');
  assert.strictEqual(ended.discarded, 1, '무엇을 버렸는지 세어서 알린다');
  assert.strictEqual(ended.unmerged, 1, '남긴 커밋도 세어서 알린다');
  assert.ok(!fs.existsSync(created.path));
  assert.strictEqual(session.listSessions(repository).sessions.length, 0);
  // 브랜치는 남는다. 작업 공간을 닫는 것과 일을 버리는 것은 다른 결정이다.
  assert.strictEqual(git(['rev-parse', '--verify', '--quiet', 'refs/heads/session/aabbccdd']).length, 40);

  assert.strictEqual(ended.unregistered, true, '닫으면 등록도 거둔다');
  assert.deepStrictEqual(session.sessionLiveness(repository, 'aabbccdd'), { pid: null, alive: null },
    '등록이 없는 것과 죽은 것은 다르게 답한다');

  assert.throws(() => session.endSession(repository, { sessionId: SID }), /열려 있는 세션 worktree가 없습니다/u);

  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log('session worktree contract passed');
