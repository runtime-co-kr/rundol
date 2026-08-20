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

try {
  const created = session.startSession(repository, { sessionId: SID });
  assert.strictEqual(created.action, 'created');
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
    session.endSession(repository, { sessionId: 'eeff0011-9999' });
  }

  // 목록은 저장이 아니라 계산이다. 세션 worktree 안에서 물어도 본 저장소를 찾는다.
  for (const from of [repository, created.path]) {
    const listed = session.listSessions(from);
    assert.strictEqual(listed.root, repository, `본 저장소를 찾는다: ${from}`);
    assert.strictEqual(listed.sessions.length, 1);
    assert.strictEqual(listed.sessions[0].branch, 'session/aabbccdd');
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

  assert.throws(() => session.endSession(repository, { sessionId: SID }), /열려 있는 세션 worktree가 없습니다/u);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log('session worktree contract passed');
