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
  const contenders = [contender(), contender()];
  fs.writeFileSync(start, 'go', 'utf8');
  const outcomes = (await Promise.all(contenders)).sort();
  assert.deepStrictEqual(outcomes, ['RDL_PROCESS_LOCKED', 'acquired']);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
} })();

running.then(() => console.log('watch runtime tests passed'));
module.exports = running;
