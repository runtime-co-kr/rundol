'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { acquireProcessLock, readProcessLock, withProcessLock } = require('../src/runtime');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-watch-lock-'));
const running = (async () => { try {
  const runtime = { id: '0123456789abcdef', locks: path.join(temporary, 'locks') };
  const first = acquireProcessLock(runtime, 'watch-crm-app');
  assert.strictEqual(readProcessLock(first.file).token, first.token);
  assert.throws(() => acquireProcessLock(runtime, 'watch-crm-app'), (error) => error.code === 'RDL_PROCESS_LOCKED');

  const other = acquireProcessLock(runtime, 'watch-payments');
  assert.notStrictEqual(first.file, other.file, 'different projects must use different locks');
  assert.strictEqual(other.release(), true);
  assert.strictEqual(other.release(), false, 'release must be idempotent');

  assert.strictEqual(first.release(), true);
  const reacquired = acquireProcessLock(runtime, 'watch-crm-app');
  reacquired.release();

  fs.mkdirSync(runtime.locks, { recursive: true });
  const staleFile = path.join(runtime.locks, 'watch-stale.lock');
  fs.writeFileSync(staleFile, `${JSON.stringify({ schemaVersion: 1, kind: 'watch', workspaceId: runtime.id, projectId: 'stale', pid: 2147483647, token: 'a'.repeat(32) })}\n`, 'utf8');
  const recovered = acquireProcessLock(runtime, 'watch-stale');
  assert.notStrictEqual(recovered.token, 'a'.repeat(32));
  recovered.release();

  let observed = false;
  const result = withProcessLock(runtime.locks, { kind: 'watch', projectId: 'finally', workspaceId: runtime.id }, () => { observed = true; return 42; });
  assert.strictEqual(result, 42);
  assert.strictEqual(observed, true);
  assert.strictEqual(fs.existsSync(path.join(runtime.locks, 'watch-finally.lock')), false);

  const raceFile = path.join(runtime.locks, 'watch-race.lock');
  fs.writeFileSync(raceFile, `${JSON.stringify({ schemaVersion: 1, kind: 'watch', workspaceId: runtime.id, projectId: 'race', pid: 2147483647, token: 'b'.repeat(32) })}\n`, 'utf8');
  const worker = path.join(temporary, 'lock-worker.js');
  fs.writeFileSync(worker, [
    "'use strict';",
    "const fs = require('fs');",
    `const { acquireProcessLock } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'runtime'))});`,
    'const [locks, start] = process.argv.slice(2);',
    "while (!fs.existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);",
    "try { const lock = acquireProcessLock({ id: '0123456789abcdef', locks }, 'watch-race'); process.stdout.write('acquired\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); lock.release(); }",
    "catch (error) { process.stdout.write(`${error.code || 'error'}\\n`); }"
  ].join('\n'), 'utf8');
  const start = path.join(temporary, 'start');
  function contender() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, runtime.locks, start], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `worker exited ${code}`)));
    });
  }
  // 만들어진 직후의 빈 잠금 파일. 여는 것과 쓰는 것이 한 동작이 아니므로 실제로
  // 생기는 상태이고, 그때 읽으면 JSON이 아니다. 이것을 치명적 오류로 올리면
  // "이미 돌고 있다"가 파싱 오류로 보고된다 — 경쟁이 결함으로 둔갑한다.
  //
  // 경쟁으로 재현하면 기계마다 결과가 달라지므로 빈 파일을 직접 만들어 확인한다.
  {
    const partial = path.join(runtime.locks, 'watch-partial.lock');
    fs.writeFileSync(partial, '', 'utf8');
    const held = acquireProcessLock({ id: '0123456789abcdef', locks: runtime.locks }, 'watch-partial');
    assert.strictEqual(held.name, 'watch-partial');
    held.release();
    assert.strictEqual(fs.existsSync(partial), false, '잠금을 놓았는데 파일이 남았습니다');
  }

  // 끝내 읽을 수 없는 잠금은 유효한 점유가 아니다. 잠금을 쥔 프로세스는 자기 잠금을
  // 읽을 수 없게 두지 않으므로, 죽은 pid의 잠금과 같이 회수한다 — 회수하지 않으면
  // 파일 하나가 이 도구를 영영 막고 사람이 손으로 지우는 것 말고는 나갈 길이 없다.
  {
    const corrupt = path.join(runtime.locks, 'watch-corrupt.lock');
    fs.writeFileSync(corrupt, '{ this is not json', 'utf8');
    const held = acquireProcessLock({ id: '0123456789abcdef', locks: runtime.locks }, 'watch-corrupt');
    assert.deepStrictEqual(readProcessLock(corrupt).pid, process.pid, '깨진 잠금이 회수되지 않았습니다');
    held.release();
  }

  // 판단과 회수 사이의 틈. 죽었다고 읽은 뒤 옮기기 전에 다른 프로세스가 그 잠금을
  // 치우고 자기 것을 만들면, 우리가 옮기는 것은 살아 있는 잠금이다. 그대로 지우면
  // 둘 다 잠금을 쥔다 — 상호 배제가 깨지는 자리다.
  //
  // 경쟁으로 재현하면 기계마다 결과가 달라 게이트가 되지 못한다. isAlive 훅이
  // 불리는 순간에 파일을 바꿔치기해 그 틈을 결정적으로 만든다.
  {
    const raced = path.join(runtime.locks, 'watch-raced.lock');
    const dead = { schemaVersion: 1, kind: 'watch', workspaceId: '0123456789abcdef', projectId: 'raced', pid: 2147483646, token: 'c'.repeat(32) };
    const live = { schemaVersion: 1, kind: 'watch', workspaceId: '0123456789abcdef', projectId: 'raced', pid: process.pid, token: 'd'.repeat(32) };
    fs.writeFileSync(raced, `${JSON.stringify(dead)}
`, 'utf8');
    let swapped = false;
    let failure = null;
    try {
      acquireProcessLock(runtime.locks, {
        kind: 'watch', projectId: 'raced', workspaceId: '0123456789abcdef',
        isAlive(candidate) {
          // 죽은 잠금이라고 답하면서, 그 사이에 남이 살아 있는 잠금을 만들어 둔다.
          if (candidate === dead.pid && !swapped) {
            swapped = true;
            fs.writeFileSync(raced, `${JSON.stringify(live)}
`, 'utf8');
            return false;
          }
          return candidate === process.pid;
        }
      });
    } catch (error) { failure = error; }
    assert(swapped, '이 시험의 전제가 깨졌습니다. 회수 판단이 일어나지 않았습니다.');
    assert(failure, '살아 있는 잠금이 회수되어 두 프로세스가 모두 잠금을 쥐었습니다');
    assert.strictEqual(failure.code, 'RDL_PROCESS_LOCKED', failure.message);
    assert.strictEqual(readProcessLock(raced).token, live.token, '되돌려 놓아야 할 잠금이 사라졌습니다');
    fs.rmSync(raced, { force: true });
  }

  const contenders = [contender(), contender()];
  fs.writeFileSync(start, 'go', 'utf8');
  const outcomes = (await Promise.all(contenders)).sort();
  assert.deepStrictEqual(outcomes, ['RDL_PROCESS_LOCKED', 'acquired']);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
} })();

running.then(() => console.log('watch runtime tests passed'));
module.exports = running;
