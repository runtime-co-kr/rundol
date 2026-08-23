'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-hook-'));
const home = path.join(temporary, 'runtime');
process.env.RUNDOL_HOME = home;

const { normalizeEvent, normalizePayload, runHook } = require('../src/hook');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function commit(message, trailer) {
  fs.writeFileSync(path.join(temporary, 'file.txt'), `${message}\n`, 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', trailer ? `${message}\n\n${trailer}` : message]);
  return git(['rev-parse', 'HEAD']);
}

function hook(event, payload) {
  return runHook(temporary, { event, client: 'claude', payload });
}

try {
  // ── 입력 판정 ──────────────────────────────────────────────────────────

  assert.strictEqual(normalizeEvent('Stop'), 'stop', '이벤트 이름은 대소문자를 가리지 않는다');
  assert.throws(() => normalizeEvent('PreToolUse'), /지원하지 않는 훅 이벤트/u, '아직 없는 이벤트는 거절한다');
  assert.throws(() => normalizeEvent(''), /지원하지 않는 훅 이벤트/u);

  // 두 클라이언트의 페이로드는 필드 이름이 같다. 없는 값은 없는 채로 둔다 —
  // 빈 문자열로 채우면 "모른다"와 "빈 이름"이 같은 값이 된다.
  const parsed = normalizePayload({ hook_event_name: 'Stop', cwd: 'c:/x', session_id: 's1', stop_hook_active: true });
  assert.strictEqual(parsed.sessionId, 's1');
  assert.strictEqual(parsed.stopHookActive, true);
  assert.strictEqual(normalizePayload({}).sessionId, null, '없는 세션은 null이다');
  assert.strictEqual(normalizePayload(null).stopHookActive, false, '깨진 입력도 판정을 지어내지 않는다');

  const tool = normalizePayload({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  assert.strictEqual(tool.command, 'git commit -m x');
  assert.strictEqual(normalizePayload({ tool_input: 'not-an-object' }).command, null, '객체가 아닌 tool_input은 무시한다');

  // ── 저장소 밖 ─────────────────────────────────────────────────────────

  const outside = runHook(os.tmpdir(), { event: 'stop', payload: { cwd: path.join(os.tmpdir(), 'no-such-rundol-repo') } });
  assert.strictEqual(outside.block, false, 'Git 저장소 밖에서는 막지 않는다');

  // ── 준비 ──────────────────────────────────────────────────────────────

  git(['init', '--initial-branch=main', temporary], os.tmpdir());
  git(['config', 'user.email', 'hook@test.local']);
  git(['config', 'user.name', 'Hook Test']);
  const base = commit('base', 'Rundol-Task: TASK-BASE');

  // ── session-start ─────────────────────────────────────────────────────

  const started = hook('session-start', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(started.block, false, '시작은 막지 않는다');
  assert.ok(started.context.some((line) => line.includes('main')), '현재 브랜치를 알린다');
  assert.ok(started.context.some((line) => line.includes('본 트리')), '본 작업 트리임을 알린다');

  // ── stop: 새 커밋이 없으면 통과 ────────────────────────────────────────

  const quiet = hook('stop', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(quiet.block, false, '커서 이후 커밋이 없으면 막을 것이 없다');

  // ── stop: 이 턴이 만든 미결박 커밋이 있으면 막는다 ────────────────────

  const loose = commit('unbound work');
  const blocked = hook('stop', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(blocked.block, true, '결박을 지나지 않은 새 커밋은 되돌린다');
  assert.ok(blocked.reason.includes(loose.slice(0, 12)), '어느 커밋인지 지목한다');
  assert.ok(blocked.reason.includes('Rundol-Task'), '고치는 방법을 함께 준다');

  // ── stop: 두 번째 회차는 통과하고 커서를 전진한다 ─────────────────────

  const second = hook('stop', { cwd: temporary, session_id: 'sess-1', stop_hook_active: true });
  assert.strictEqual(second.block, false, '한 턴에 한 번만 되돌린다');
  const third = hook('stop', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(third.block, false, '전진한 커서는 같은 커밋을 다시 막지 않는다');

  // ── stop: 결박된 커밋은 막지 않는다 ───────────────────────────────────

  commit('bound work', 'Rundol-Task: TASK-XYZ');
  assert.strictEqual(hook('stop', { cwd: temporary, session_id: 'sess-1' }).block, false, '결박된 커밋은 통과한다');

  // 우회도 결박을 지난 것이다. 사유를 남긴 커밋을 막으면 우회라는 갈래가 없어진다.
  commit('excused work', 'Rundol-Task: none\nRundol-Task-Reason: 긴급 배포');
  assert.strictEqual(hook('stop', { cwd: temporary, session_id: 'sess-1' }).block, false, '사유를 남긴 커밋도 통과한다');

  // ── stop: 커서가 없으면 아무것도 세지 않는다 ──────────────────────────

  commit('work with no cursor');
  const noCursor = hook('stop', { cwd: temporary, session_id: 'never-started' });
  assert.strictEqual(noCursor.block, false, '커서를 잃었다고 과거를 이 턴의 위반으로 읽지 않는다');

  // ── stop: 프로젝트 브랜치는 rdl save가 이미 강제한다 ──────────────────

  git(['checkout', '-b', 'rundol/demo']);
  hook('session-start', { cwd: temporary, session_id: 'sess-2' });
  commit('doc work');
  assert.strictEqual(hook('stop', { cwd: temporary, session_id: 'sess-2' }).block, false, '프로젝트 브랜치에서는 두 번 막지 않는다');
  git(['checkout', 'main']);

  // ── post-tool-use ─────────────────────────────────────────────────────

  hook('session-start', { cwd: temporary, session_id: 'sess-3' });
  const ignored = hook('post-tool-use', { cwd: temporary, tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.strictEqual(ignored.record, null, '커밋이 아닌 호출에는 아무것도 적지 않는다');
  assert.strictEqual(ignored.block, false);

  const recorded = hook('post-tool-use', { cwd: temporary, session_id: 'sess-3', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  assert.ok(recorded.record, '커밋 뒤에는 결박 여부를 적는다');
  assert.strictEqual(recorded.record.binding, 'unbound', 'HEAD의 실제 결박 상태를 적는다 — 보고가 아니라 커밋이 답한다');
  assert.strictEqual(recorded.block, false, '계측은 막지 않는다');

  // ── session-end ───────────────────────────────────────────────────────

  const ended = hook('session-end', { cwd: temporary, session_id: 'sess-3' });
  assert.strictEqual(ended.block, false, '닫는 자리에서는 말만 한다');

  assert.strictEqual(base.length, 40);
  console.log('hook tests passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
