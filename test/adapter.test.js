'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  INSTRUCTIONS,
  LENSES,
  getLens,
  pinInstruction,
  resolveInstructionPin
} = require('../src/instruction-registry');
const { runAdapterOnce, adapterEnvironment, resolveExecutable, validateResult, probeAdapter } = require('../src/adapter');

// 저장소 밖 OS 임시 디렉터리를 쓴다 — teardown이 Windows에서 실패해도(잔존 핸들·
// 읽기전용) 저장소가 오염되지 않고, 정리 실패가 스위트를 죽일 이유가 없어진다.
const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rundol-adapter-test-'));

function command(cwd, args) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return (result.stdout || '').trim();
}

function write(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processExists(pid);
}

function invocation(project, id, mode, fixtureMode, extra) {
  const instructionId = mode === 'author' ? 'author-v1' : 'verify-satisfaction-v1';
  const value = Object.assign({
    projectRoot: project,
    mode,
    adapter: {
      name: 'fixture',
      command: process.execPath,
      argsTemplate: [path.join(project, 'adapter fixture 테스트.js'), fixtureMode, '{instruction}', '{context}', '{result}', 'literal;&|$()'],
      timeoutSeconds: 5,
      enabled: true
    },
    instruction: pinInstruction(instructionId),
    targetPath: 'docs/REQ-001.md',
    allowedContextPaths: ['docs/TST-001.md'],
    contractHeadings: ['scope', 'acceptance criteria'],
    pin: { targetId: 'REQ-001', revision: command(project, ['git', 'rev-parse', 'HEAD']) },
    invocationId: id,
    ...(mode === 'author' ? { runId: 'RUN-00000000000000000001', stepId: 'author' } : {}),
    ...(mode === 'verify' ? { lensId: 'satisfaction-v1' } : {})
  }, extra || {});
  if (fixtureMode === 'timeout-tree' || fixtureMode === 'abort-tree') {
    const fixtureName = fs.readdirSync(project).find((name) => name.startsWith('adapter fixture '));
    value.adapter.argsTemplate = [path.join(project, fixtureName), fixtureMode, '{instruction}', '{context}', '{result}', 'literal;&|$()'];
    value.adapter.timeoutSeconds = 1;
  }
  return value;
}

const running = (async () => {
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  const project = path.join(temporary, 'project with spaces 한글');
  fs.mkdirSync(project, { recursive: true });
  command(project, ['git', 'init', '--quiet']);
  command(project, ['git', 'config', 'user.email', 'adapter@example.invalid']);
  command(project, ['git', 'config', 'user.name', 'Adapter Test']);
  write(path.join(project, '.gitignore'), '.rundol/\nsentinel-*\n');
  write(path.join(project, 'docs', 'REQ-001.md'), '# REQ-001\n');
  write(path.join(project, 'docs', 'TST-001.md'), '# TST-001\n');
  write(path.join(project, 'adapter fixture 테스트.js'), `'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const [mode, instruction, context, result, literal] = process.argv.slice(2);
JSON.parse(fs.readFileSync(instruction, 'utf8'));
JSON.parse(fs.readFileSync(context, 'utf8'));
if (literal !== 'literal;&|$()') process.exit(9);
if (mode === 'timeout') setTimeout(() => {}, 10000);
else if (mode === 'timeout-tree' || mode === 'abort-tree') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
  fs.writeFileSync(result + '.child-pid', String(child.pid));
  if (process.platform !== 'win32') process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
else if (mode === 'failure') { process.stderr.write('RAW-SECRET-OUTPUT'); process.exit(3); }
else if (mode === 'author') fs.writeFileSync(result, JSON.stringify({ claims: ['bounded claim'], artifactIds: ['REQ-001'] }));
else if (mode === 'sentinel') { fs.writeFileSync(require('path').join(process.cwd(), 'sentinel-spawned'), 'spawned'); fs.writeFileSync(result, JSON.stringify({ verdict: 'pass', findings: [] })); }
else if (mode === 'worktree-create') { fs.writeFileSync(require('path').join(process.cwd(), 'post-created.txt'), 'created'); fs.writeFileSync(result, JSON.stringify({ verdict: 'pass', findings: [] })); }
else if (mode === 'worktree-modify') { fs.writeFileSync(require('path').join(process.cwd(), 'docs', 'REQ-001.md'), '# changed!\\n'); fs.writeFileSync(result, JSON.stringify({ verdict: 'pass', findings: [] })); }
else if (mode === 'mutate-failure') { fs.writeFileSync(require('path').join(process.cwd(), 'docs', 'REQ-001.md'), '# mutated before failure\\n'); process.exit(3); }
else if (mode === 'worktree-delete') { fs.unlinkSync(require('path').join(process.cwd(), 'docs', 'TST-001.md')); fs.writeFileSync(result, JSON.stringify({ verdict: 'pass', findings: [] })); }
else if (mode === 'absolute') fs.writeFileSync(result, JSON.stringify({ verdict: 'refuted', findings: [{ summary: 'bad', location: { file: '/escape.md' } }] }));
else if (mode === 'extra') fs.writeFileSync(result, JSON.stringify({ verdict: 'pass', findings: [], transcript: 'forbidden' }));
else fs.writeFileSync(result, JSON.stringify({ verdict: 'pass', findings: [] }));
`);
  command(project, ['git', 'add', '.']);
  command(project, ['git', 'commit', '--quiet', '-m', 'fixture']);

  assert(Object.isFrozen(INSTRUCTIONS));
  assert(Object.isFrozen(INSTRUCTIONS['author-v1']));
  assert.strictEqual(LENSES['satisfaction-v1'], 'verify-satisfaction-v1');
  assert.strictEqual(getLens('boundary-v1').instructionId, 'verify-boundary-v1');
  assert.match(INSTRUCTIONS['author-v1'].instructionDigest, /^[0-9a-f]{64}$/u);
  assert.deepStrictEqual(resolveInstructionPin(pinInstruction('author-v1'), { mode: 'author' }), INSTRUCTIONS['author-v1']);
  assert.throws(() => resolveInstructionPin(pinInstruction('author-v1'), { mode: 'verify' }), /not allowed/u);
  assert.throws(() => resolveInstructionPin({ ...pinInstruction('author-v1'), revision: 2 }, { mode: 'author' }), /drift/u);

  assert.strictEqual(resolveExecutable(process.execPath), fs.realpathSync.native(process.execPath));
  const probe = probeAdapter({ command: process.execPath }, { cwd: project });
  assert.strictEqual(probe.status, 0);
  assert.match(probe.version, /^v\d+/u);
  // 자식은 allowlist에 있는 것만 물려받는다. 거기에 하나가 더 붙는다 — 자기가
  // 하네스 안에 있다는 표시. 사람 게이트를 스스로 지나가려는 시도를 그것으로 알아본다.
  const environment = adapterEnvironment({ PATH: 'safe', TOKEN: 'secret', HOME: 'home' });
  assert.deepStrictEqual(environment, { PATH: 'safe', HOME: 'home', RUNDOL_HARNESS_CHILD: '1' });

  const author = await runAdapterOnce(invocation(project, 'INV-00000000000000000001', 'author', 'author'));
  assert.strictEqual(author.exitCode, 0, JSON.stringify(author));
  assert.deepStrictEqual(author.result, { claims: ['bounded claim'], artifactIds: ['REQ-001'] });
  assert(fs.existsSync(path.join(author.invocationRoot, 'instruction.json')));
  assert(fs.existsSync(path.join(author.invocationRoot, 'context.json')));
  assert(fs.existsSync(path.join(author.invocationRoot, 'receipt.json')));
  assert(author.invocationRoot.includes(`${path.sep}.rundol${path.sep}runs${path.sep}`));
  const materializedInstruction = JSON.parse(fs.readFileSync(path.join(author.invocationRoot, 'instruction.json'), 'utf8'));
  assert.strictEqual(materializedInstruction.instructionDigest, INSTRUCTIONS['author-v1'].instructionDigest);
  const context = JSON.parse(fs.readFileSync(path.join(author.invocationRoot, 'context.json'), 'utf8'));
  assert.deepStrictEqual(context.allowedContextPaths, ['docs/TST-001.md']);
  assert(!JSON.stringify(context).includes('# REQ-001'));
  assert(!fs.existsSync(path.join(project, 'sentinel-unsafe')), 'shell metacharacters must remain literal');

  let spawnedVerifierPid;
  const verified = await runAdapterOnce(invocation(project, 'INV-00000000000000000002', 'verify', 'pass'), {
    onSpawn(pid) { spawnedVerifierPid = pid; }
  });
  assert.strictEqual(verified.exitCode, 0, JSON.stringify(verified));
  assert(Number.isSafeInteger(spawnedVerifierPid) && spawnedVerifierPid > 0, 'onSpawn must expose the actual adapter child PID');
  assert.deepStrictEqual(verified.result, { verdict: 'pass', findings: [] });
  assert(verified.invocationRoot.includes(`${path.sep}.rundol${path.sep}verify${path.sep}`));

  const extra = await runAdapterOnce(invocation(project, 'INV-00000000000000000003', 'verify', 'extra'));
  assert.strictEqual(extra.exitCode, 2);
  assert.strictEqual(extra.status, 'invalid-output');
  assert(!fs.existsSync(path.join(extra.invocationRoot, 'result.json')), 'untrusted result must be discarded');

  const absolute = await runAdapterOnce(invocation(project, 'INV-00000000000000000004', 'verify', 'absolute'));
  assert.strictEqual(absolute.exitCode, 2);
  assert.match(absolute.error, /escapes/u);

  const timeout = await runAdapterOnce(invocation(project, 'INV-00000000000000000005', 'author', 'timeout', {
    adapter: {
      name: 'fixture', command: process.execPath,
      argsTemplate: [path.join(project, 'adapter fixture 테스트.js'), 'timeout', '{instruction}', '{context}', '{result}', 'literal;&|$()'],
      timeoutSeconds: 1, enabled: true
    }
  }));
  assert.strictEqual(timeout.exitCode, 2);
  assert.strictEqual(timeout.status, 'timeout');

  const timeoutTree = await runAdapterOnce(invocation(project, 'INV-00000000000000000007', 'author', 'timeout-tree', {
    adapter: {
      name: 'fixture', command: process.execPath,
      argsTemplate: [path.join(project, 'adapter fixture ?뚯뒪??js'), 'timeout-tree', '{instruction}', '{context}', '{result}', 'literal;&|$()'],
      timeoutSeconds: 1, enabled: true
    }
  }));
  assert.strictEqual(timeoutTree.exitCode, 2);
  assert.strictEqual(timeoutTree.status, 'timeout');
  const descendantPid = Number(fs.readFileSync(path.join(timeoutTree.invocationRoot, 'result.json.child-pid'), 'utf8'));
  assert(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  assert.strictEqual(await waitForProcessExit(descendantPid, 3000), true, `timed-out descendant ${descendantPid} survived tree termination`);

  const abortController = new AbortController();
  setTimeout(() => abortController.abort(new Error('lease heartbeat failed')), 200);
  const abortedTree = await runAdapterOnce(invocation(project, 'INV-00000000000000000015', 'author', 'abort-tree', {
    adapter: {
      name: 'fixture', command: process.execPath,
      argsTemplate: [path.join(project, 'adapter fixture 테스트.js'), 'abort-tree', '{instruction}', '{context}', '{result}', 'literal;&|$()'],
      timeoutSeconds: 5, enabled: true
    }
  }), { signal: abortController.signal });
  assert.strictEqual(abortedTree.exitCode, 2);
  assert.strictEqual(abortedTree.status, 'cancelled');
  assert.deepStrictEqual(abortedTree.diagnosticCodes, ['ADAPTER_CANCELLED']);
  assert(!Object.hasOwn(abortedTree, 'error'), 'abort status must not expose the cancellation reason or process output');
  const abortedDescendantPid = Number(fs.readFileSync(path.join(abortedTree.invocationRoot, 'result.json.child-pid'), 'utf8'));
  assert.strictEqual(await waitForProcessExit(abortedDescendantPid, 3000), true, `aborted descendant ${abortedDescendantPid} survived tree termination`);

  const failed = await runAdapterOnce(invocation(project, 'INV-00000000000000000006', 'author', 'failure'));
  assert.strictEqual(failed.exitCode, 1);
  assert(!JSON.stringify(failed).includes('RAW-SECRET-OUTPUT'), 'raw adapter output must remain process-memory only');

  // Invalid verifier settings and a dirty pre-state must fail before spawn.
  const sentinel = path.join(project, 'sentinel-spawned');
  const invalidSettings = invocation(project, 'INV-00000000000000000008', 'verify', 'sentinel');
  invalidSettings.adapter.timeoutSeconds = 0;
  await assert.rejects(() => runAdapterOnce(invalidSettings), /timeoutSeconds/u);
  assert(!fs.existsSync(sentinel), 'invalid settings must not spawn an adapter');

  write(path.join(project, 'docs', 'REQ-001.md'), '# dirty before spawn\n');
  const dirtyBefore = await runAdapterOnce(invocation(project, 'INV-00000000000000000009', 'verify', 'sentinel'));
  assert.strictEqual(dirtyBefore.exitCode, 2);
  assert.strictEqual(dirtyBefore.status, 'invalid-output');
  assert(!fs.existsSync(path.join(dirtyBefore.invocationRoot, 'result.json')));
  assert(!fs.existsSync(sentinel), 'dirty pre-state must not spawn an adapter');
  write(path.join(project, 'docs', 'REQ-001.md'), '# REQ-001\n');

  // Simulate a replacement after initial inspection but before spawn. An array
  // accessor changes the target while adapter arguments are being prepared.
  const raced = invocation(project, 'INV-00000000000000000010', 'author', 'sentinel');
  const fixturePath = raced.adapter.argsTemplate[0];
  Object.defineProperty(raced.adapter.argsTemplate, 0, {
    configurable: true,
    get() {
      write(path.join(project, 'docs', 'REQ-001.md'), '# RACE-001\n');
      return fixturePath;
    }
  });
  const replacedBeforeSpawn = await runAdapterOnce(raced);
  assert.strictEqual(replacedBeforeSpawn.exitCode, 2);
  assert.match(replacedBeforeSpawn.error, /replaced or changed/u);
  assert(!fs.existsSync(sentinel), 'replaced target must be rejected before spawn');
  write(path.join(project, 'docs', 'REQ-001.md'), '# REQ-001\n');

  const racedContext = invocation(project, 'INV-00000000000000000014', 'author', 'sentinel');
  const contextFixturePath = racedContext.adapter.argsTemplate[0];
  Object.defineProperty(racedContext.adapter.argsTemplate, 0, {
    configurable: true,
    get() {
      write(path.join(project, 'docs', 'TST-001.md'), '# RACE-TST-001\n');
      return contextFixturePath;
    }
  });
  const replacedContextBeforeSpawn = await runAdapterOnce(racedContext);
  assert.strictEqual(replacedContextBeforeSpawn.exitCode, 2);
  // 이 교체는 두 계약을 동시에 어긴다: 근거 파일이 스폰 직전에 바뀌었고, 저작이
  // 시작되는 시점의 트리가 대상 밖에서 더럽다. 어느 쪽이 먼저 잡든 성질은 같다 —
  // 스폰 전에 거부되고 어댑터는 돌지 않는다. 그것을 sentinel이 증명한다.
  assert.match(replacedContextBeforeSpawn.error, /replaced or changed|clean outside the target/u);
  assert(!fs.existsSync(sentinel), 'replaced context must be rejected before spawn');
  write(path.join(project, 'docs', 'TST-001.md'), '# TST-001\n');

  const postCases = [
    ['worktree-create', 'INV-00000000000000000011'],
    ['worktree-modify', 'INV-00000000000000000012'],
    ['worktree-delete', 'INV-00000000000000000013']
  ];
  for (const [fixtureMode, id] of postCases) {
    const changed = await runAdapterOnce(invocation(project, id, 'verify', fixtureMode));
    assert.strictEqual(changed.exitCode, 2, `${fixtureMode}: ${JSON.stringify(changed)}`);
    assert.strictEqual(changed.status, 'invalid-output');
    assert(!fs.existsSync(path.join(changed.invocationRoot, 'result.json')), `${fixtureMode} result must be discarded`);
    if (fixtureMode === 'worktree-create') fs.rmSync(path.join(project, 'post-created.txt'), { force: true });
    if (fixtureMode === 'worktree-modify') write(path.join(project, 'docs', 'REQ-001.md'), '# REQ-001\n');
    if (fixtureMode === 'worktree-delete') write(path.join(project, 'docs', 'TST-001.md'), '# TST-001\n');
  }

  // verifier의 불변 계약은 실패 경로에서도 검사된다 — 파일을 바꾼 뒤 실패로 끝난
  // verifier는 실패 사유에 더해 변형 진단으로 귀속이 남아야 한다.
  const mutateFailure = await runAdapterOnce(invocation(project, 'INV-00000000000000000014', 'verify', 'mutate-failure'));
  assert.strictEqual(mutateFailure.exitCode, 1, JSON.stringify(mutateFailure));
  assert.strictEqual(mutateFailure.status, 'child-failure');
  assert(mutateFailure.diagnosticCodes.includes('ADAPTER_VERIFIER_MUTATED'), `실패한 verifier의 작업 트리 변형이 진단되지 않았습니다: ${JSON.stringify(mutateFailure.diagnosticCodes)}`);
  write(path.join(project, 'docs', 'REQ-001.md'), '# REQ-001\n');

  assert.throws(() => validateResult('author', '{"claims":[],"artifactIds":["REQ-001","REQ-001"]}', project), /unique/u);
  assert.throws(() => validateResult('verify', '{"verdict":"pass","findings":[],"rawOutput":"x"}', project), /unknown/u);
  process.stdout.write('adapter tests passed\n');
})().finally(() => {
  // 읽기전용 manifest를 풀고 넉넉히 재시도한다. 그래도 실패하면(타임아웃-킬된
  // 자식의 잔존 핸들 등) OS 임시 폴더에 남는 것뿐이므로 스위트를 죽이지 않는다.
  try {
    for (const entry of fs.readdirSync(temporary, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) { try { fs.chmodSync(path.join(entry.parentPath || entry.path, entry.name), 0o666); } catch {} }
    }
  } catch {}
  try {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    process.stderr.write(`adapter test teardown left temp dir (${error.code}): ${temporary}\n`);
  }
});

module.exports = running;
