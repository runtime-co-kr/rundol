'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parseJsonWithDuplicateCheck, loadHarnessSettings } = require('./harness-settings');
const { canonicalJson } = require('./run-ledger');
const { resolveInstructionPin } = require('./instruction-registry');
const { runGit } = require('./git');

const INVOCATION_ID = /^INV-[0-9A-F]{20}$/u;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ADAPTER_ID = /^[a-z][a-z0-9.-]*$/u;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_COLLECTION = 256;
const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'NODE_PATH'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const keys = Object.keys(value).sort();
  const expected = Array.from(allowed).sort();
  if (canonicalJson(keys) !== canonicalJson(expected)) throw new Error(`${label} has unknown or missing fields.`);
}

function normalizedRelative(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || /[\0\r\n]/u.test(value)) throw new Error(`${label} must be a bounded relative path.`);
  const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (path.isAbsolute(value) || normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.split('/').includes('')) throw new Error(`${label} escapes the project root.`);
  return normalized;
}

function contained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} is outside its trusted root.`);
  return candidate;
}

function rejectLink(stat, label) {
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link or junction.`);
  if (typeof stat.isDirectory === 'function' && !stat.isDirectory() && !stat.isFile()) throw new Error(`${label} has an unsupported filesystem type.`);
}

function inspectExistingComponents(trustedRoot, candidate, finalKind) {
  contained(trustedRoot, candidate, 'path');
  const relative = path.relative(trustedRoot, candidate);
  let current = trustedRoot;
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    rejectLink(stat, current);
    const final = index === parts.length - 1;
    if ((!final || finalKind === 'directory') && !stat.isDirectory()) throw new Error(`${current} must be a directory.`);
    if (final && finalKind === 'file' && !stat.isFile()) throw new Error(`${current} must be a regular file.`);
  }
}

function regularRealFile(trustedRoot, relative, label) {
  const file = path.resolve(trustedRoot, relative);
  contained(trustedRoot, file, label);
  inspectExistingComponents(trustedRoot, file, 'file');
  const stat = fs.lstatSync(file);
  rejectLink(stat, label);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  const real = fs.realpathSync.native(file);
  contained(trustedRoot, real, label);
  return { relative, file: real, stat };
}

function trustedFileSnapshot(trustedRoot, relative, label) {
  const inspected = regularRealFile(trustedRoot, relative, label);
  return {
    relative,
    real: inspected.file,
    dev: inspected.stat.dev,
    ino: inspected.stat.ino,
    size: inspected.stat.size,
    hash: hashFile(inspected.file)
  };
}

function revalidateTrustedFile(trustedRoot, snapshot, label) {
  const inspected = regularRealFile(trustedRoot, snapshot.relative, label);
  if (inspected.file !== snapshot.real
    || inspected.stat.dev !== snapshot.dev
    || inspected.stat.ino !== snapshot.ino
    || inspected.stat.size !== snapshot.size
    || hashFile(inspected.file) !== snapshot.hash) {
    throw new Error(`${label} was replaced or changed during adapter preparation.`);
  }
  return inspected.file;
}

function makeDirectoriesExclusive(trustedRoot, parent, leaf) {
  contained(trustedRoot, parent, 'invocation parent');
  inspectExistingComponents(trustedRoot, parent, 'directory');
  const relative = path.relative(trustedRoot, parent);
  let current = trustedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    rejectLink(stat, current);
    if (!stat.isDirectory()) throw new Error(`${current} must be a directory.`);
  }
  const directory = path.join(parent, leaf);
  fs.mkdirSync(directory, { recursive: false });
  inspectExistingComponents(trustedRoot, directory, 'directory');
  const real = fs.realpathSync.native(directory);
  contained(trustedRoot, real, 'invocation directory');
  return real;
}

function executableCandidates(command, environment) {
  if (path.isAbsolute(command)) return [command];
  if (command.includes('/') || command.includes('\\')) throw new Error('Adapter command must be an absolute path or a PATH executable name.');
  const env = environment || process.env;
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE').split(';').filter(Boolean).concat([''])
    : [''];
  const candidates = [];
  for (const directory of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) candidates.push(path.join(directory.replace(/^"|"$/gu, ''), `${command}${extension}`));
  }
  return candidates;
}

function resolveExecutable(command, environment) {
  if (typeof command !== 'string' || command.length < 1 || command.length > 128 || /[\0\r\n]/u.test(command)) throw new Error('Adapter command is invalid.');
  const candidates = executableCandidates(command, environment);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    rejectLink(stat, candidate);
    if (!stat.isFile()) continue;
    const real = fs.realpathSync.native(candidate);
    const extension = path.extname(real).toLowerCase();
    if (['.bat', '.cmd', '.ps1', '.sh'].includes(extension)) throw new Error('Shell wrapper adapters are not executable with shell:false. Configure the underlying executable.');
    if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) throw new Error('Adapter command is not executable.');
    return real;
  }
  throw new Error(`Adapter executable was not found: ${command}`);
}

function adapterEnvironment(source) {
  const environment = {};
  for (const key of ENV_ALLOWLIST) if (source && source[key] !== undefined) environment[key] = source[key];
  return environment;
}

function safeMetadata(value, label, depth) {
  const level = depth || 0;
  if (level > 4) throw new Error(`${label} is too deeply nested.`);
  if (value === null || typeof value === 'boolean' || Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    if (value.length > 256 || /[\0\r]/u.test(value)) throw new Error(`${label} has an unsafe string value.`);
    return value.normalize('NFC');
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw new Error(`${label} has too many values.`);
    return value.map((item, index) => safeMetadata(item, `${label}[${index}]`, level + 1));
  }
  if (!value || typeof value !== 'object') throw new Error(`${label} is not JSON-safe metadata.`);
  const keys = Object.keys(value);
  if (keys.length > 32) throw new Error(`${label} has too many fields.`);
  const result = {};
  for (const key of keys.sort()) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key) || /(?:prompt|transcript|credential|secret|rawOutput|documentBody)/iu.test(key)) throw new Error(`${label} has a forbidden metadata field: ${key}`);
    result[key] = safeMetadata(value[key], `${label}.${key}`, level + 1);
  }
  return result;
}

function boundedText(value, maximum, label, singleLine) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  let normalized = value.replace(/\r\n?/gu, '\n').normalize('NFC').trim();
  if (singleLine) normalized = normalized.replace(/\s*\n\s*/gu, ' ');
  if (!normalized || normalized.length > maximum || /[\0\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) throw new Error(`${label} is empty, oversized, or contains control characters.`);
  return normalized;
}

function boundedStringArray(value, label, maximumLength) {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION) throw new Error(`${label} must be a bounded array.`);
  return value.map((item, index) => boundedText(item, maximumLength, `${label}[${index}]`, true));
}

function validateResult(mode, source, projectRoot) {
  const parsed = parseJsonWithDuplicateCheck(source, 'result.json');
  if (mode === 'author') {
    exactKeys(parsed, new Set(['claims', 'artifactIds']), 'author result');
    const claims = boundedStringArray(parsed.claims, 'claims', 1000);
    const artifactIds = boundedStringArray(parsed.artifactIds, 'artifactIds', 128);
    if (new Set(artifactIds).size !== artifactIds.length) throw new Error('artifactIds must be unique.');
    return { claims, artifactIds };
  }
  exactKeys(parsed, new Set(['verdict', 'findings']), 'verify result');
  if (!['pass', 'refuted', 'abstain'].includes(parsed.verdict)) throw new Error('verify result verdict is invalid.');
  if (!Array.isArray(parsed.findings) || parsed.findings.length > MAX_COLLECTION) throw new Error('findings must be a bounded array.');
  const findings = parsed.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new Error(`findings[${index}] must be an object.`);
    const allowed = finding.location === undefined ? new Set(['summary']) : new Set(['summary', 'location']);
    exactKeys(finding, allowed, `findings[${index}]`);
    const output = { summary: boundedText(finding.summary, 1000, `findings[${index}].summary`, true) };
    if (finding.location !== undefined) {
      if (!finding.location || typeof finding.location !== 'object' || Array.isArray(finding.location)) throw new Error(`findings[${index}].location must be an object.`);
      const locationKeys = Object.keys(finding.location);
      if (!locationKeys.includes('file') || locationKeys.some((key) => !['file', 'heading', 'blockId'].includes(key))) throw new Error(`findings[${index}].location has unknown or missing fields.`);
      const file = normalizedRelative(finding.location.file, `findings[${index}].location.file`);
      contained(projectRoot, path.resolve(projectRoot, file), `findings[${index}].location.file`);
      output.location = { file };
      if (finding.location.heading !== undefined) output.location.heading = boundedText(finding.location.heading, 200, `findings[${index}].location.heading`, true);
      if (finding.location.blockId !== undefined) output.location.blockId = boundedText(finding.location.blockId, 200, `findings[${index}].location.blockId`, true);
    }
    return output;
  });
  return { verdict: parsed.verdict, findings };
}

function readStableResult(file, invocationRoot) {
  const before = fs.lstatSync(file);
  rejectLink(before, 'result.json');
  if (!before.isFile()) throw new Error('result.json must be a regular file.');
  const real = fs.realpathSync.native(file);
  contained(invocationRoot, real, 'result.json');
  const descriptor = fs.openSync(real, 'r');
  try {
    const first = fs.fstatSync(descriptor);
    if (!first.isFile() || first.size > MAX_RESULT_BYTES) throw new Error('result.json exceeds the size limit.');
    const buffer = Buffer.alloc(first.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const second = fs.fstatSync(descriptor);
    if (offset !== buffer.length || first.size !== second.size || first.dev !== second.dev || first.ino !== second.ino) throw new Error('result.json changed while it was read.');
    return buffer;
  } finally {
    fs.closeSync(descriptor);
  }
}

function gitSnapshot(projectRoot) {
  const head = runGit(['rev-parse', 'HEAD'], { cwd: projectRoot }).stdout;
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: projectRoot }).stdout;
  const diff = runGit(['diff', '--binary', '--no-ext-diff'], { cwd: projectRoot }).stdout;
  return { head, status, diffHash: sha256(Buffer.from(diff, 'utf8')) };
}

function writeExclusiveJson(file, value, readOnly) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  if (readOnly) {
    try { fs.chmodSync(file, 0o400); } catch (_) {}
  }
  return sha256(bytes);
}

function substituteArgs(template, values) {
  return template.map((argument) => String(argument).replace(/\{(instruction|context|result|operationId)\}/gu, (whole, key) => {
    if (values[key] === undefined || values[key] === null) throw new Error(`Adapter argument placeholder has no value: ${whole}`);
    return values[key];
  }));
}

function capture(stream) {
  let value = Buffer.alloc(0);
  if (stream) stream.on('data', (chunk) => {
    if (value.length >= MAX_CAPTURE_BYTES) return;
    const remaining = MAX_CAPTURE_BYTES - value.length;
    value = Buffer.concat([value, Buffer.from(chunk).subarray(0, remaining)]);
  });
  return () => value.toString('utf8').replace(/[\0\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim();
}

// Windows에서는 자식 프로세스 트리의 종료를 보장할 수 없다. taskkill /T는 부모-자식
// 관계를 스냅숏으로 훑는 최선 노력이고 권한이 부족하면 거부된다. 취소를 전제로 한
// 실행은 그 상태에서 열지 않는다 — 판정은 여기 한 곳에만 둔다.
function terminationGuaranteed() {
  if (process.platform !== 'win32') return true;
  return process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER === '1';
}

function assertTerminationGuaranteed(what) {
  if (terminationGuaranteed()) return;
  throw new Error(`${what}: Windows에서는 자식 프로세스 트리의 종료를 보장할 수 없습니다. 위험을 알고 켜려면 RUNDOL_ALLOW_WINDOWS_ADAPTER=1을 설정하세요.`);
}

function terminateTree(child) {
  if (!child || !child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    // taskkill /T는 부모-자식 관계를 스냅숏으로 훑는다. 중간 프로세스가 먼저
    // 끝나면 손자는 고아가 되어 그 스냅숏에서 빠지고, 그러면 취소했는데도
    // 자손이 살아남는다.
    //
    // 여기서 그 경우를 추측으로 메우지 않는다. 대신 실패를 조용히 넘기지
    // 않는다 — 트리 종료가 실패한 것은 실제 운영 사건이고, 아무 말도 남기지
    // 않으면 나중에 "왜 살아남았는가"에 답할 근거가 없다.
    const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, encoding: 'utf8' });
    if (killed.status === 0) return Promise.resolve();
    // taskkill이 접근 거부 등으로 실패했는데 성공한 것처럼 돌려주면, 취소는
    // 끝났다고 보고되고 자손은 살아 있다. 실패했으면 남은 수단을 쓰고, 그래도
    // 안 되면 그 사실이 드러나야 한다.
    const reason = String(killed.stderr || killed.stdout || '').trim() || `exit ${killed.status}`;
    process.stderr.write(`rundol: 프로세스 트리 종료가 실패했습니다 (pid ${child.pid}): ${reason}\n`);
    try { child.kill('SIGKILL'); } catch (_) { try { child.kill(); } catch (_) {} }
    return new Promise((resolve) => setTimeout(() => {
      const retry = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, encoding: 'utf8' });
      if (retry.status !== 0 && !child.killed) {
        process.stderr.write(`rundol: 프로세스 트리가 아직 살아 있습니다 (pid ${child.pid}). 자손 프로세스를 직접 확인하세요.\n`);
      }
      resolve();
    }, 500));
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} }
  // Keep the event loop alive for the full grace period. The group leader may
  // close on SIGTERM while a descendant ignores it; the group still needs the
  // unconditional SIGKILL fallback.
  return new Promise((resolve) => setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
    resolve();
  }, 1000));
}

function executeOnce(executable, args, options) {
  return new Promise((resolve) => {
    let settled = false;
    let stopCategory = null;
    let timer;
    let child;
    let closeResult;
    let termination;
    const signal = options.signal;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    };
    const finishStop = () => {
      if (settled || !termination) return;
      termination.then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const closed = closeResult || {};
        resolve({ category: stopCategory, code: closed.code, signal: closed.signal, stdout: stdout(), stderr: stderr() });
      });
    };
    const stop = (category) => {
      if (settled || stopCategory) return;
      stopCategory = category;
      clearTimeout(timer);
      termination = terminateTree(child);
      finishStop();
    };
    const abort = () => stop('cancelled');
    if (signal && signal.aborted) {
      resolve({ category: 'cancelled' });
      return;
    }
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (typeof options.onSpawn === 'function') options.onSpawn(child.pid);
    } catch (error) {
      if (child) terminateTree(child);
      resolve({ category: 'spawn-error', error });
      return;
    }
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    timer = setTimeout(() => stop('timeout'), options.timeoutSeconds * 1000);
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    child.once('error', (error) => {
      if (settled) return;
      if (stopCategory) {
        closeResult = { error };
        finishStop();
        return;
      }
      settled = true;
      cleanup();
      resolve({ category: 'spawn-error', error, stdout: stdout(), stderr: stderr() });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (stopCategory) {
        closeResult = { code, signal };
        finishStop();
        return;
      }
      settled = true;
      cleanup();
      resolve({ category: code === 0 ? 'success' : 'child-failure', code, signal, stdout: stdout(), stderr: stderr() });
    });
  });
}

function invocationDirectory(projectRoot, invocation) {
  const instanceId = invocation.instanceId || invocation.invocationId;
  if (!INVOCATION_ID.test(instanceId || '')) throw new Error('A kernel-generated INV- identifier is required.');
  if (invocation.runId !== undefined) {
    if (!SAFE_COMPONENT.test(invocation.runId || '') || !SAFE_COMPONENT.test(invocation.stepId || '')) throw new Error('Run and step IDs are unsafe for an invocation path.');
    return { instanceId, parent: path.join(projectRoot, '.rundol', 'runs', invocation.runId, 'steps', invocation.stepId, 'invocations') };
  }
  return { instanceId, parent: path.join(projectRoot, '.rundol', 'verify') };
}

function failureReceipt(directory, base, category, resultHash) {
  const receipt = { ...base, exitCategory: category, ...(resultHash ? { resultHash } : {}) };
  writeExclusiveJson(path.join(directory, 'receipt.json'), receipt, false);
  return receipt;
}

async function runAdapterOnce(invocation, executionOptions) {
  if (!invocation || typeof invocation !== 'object') throw new Error('Adapter invocation is required.');
  if (!['author', 'verify'].includes(invocation.mode)) throw new Error('Adapter mode must be author or verify.');
  if (invocation.mode === 'author' && invocation.runId === undefined) throw new Error('Author adapters are run-bound; standalone invocation is verification-only.');
  if (!invocation.adapter || !ADAPTER_ID.test(invocation.adapter.name || '') || invocation.adapter.enabled === false) throw new Error('An enabled adapter with a valid name is required.');
  const projectRoot = fs.realpathSync.native(path.resolve(invocation.projectRoot));
  if (!fs.statSync(projectRoot).isDirectory()) throw new Error('Project root must be a directory.');
  const instruction = resolveInstructionPin(invocation.instruction, { mode: invocation.mode, lensId: invocation.lensId });
  const targetRelative = normalizedRelative(invocation.targetPath, 'targetPath');
  const target = trustedFileSnapshot(projectRoot, targetRelative, 'targetPath');
  const contexts = Array.from(new Set((invocation.allowedContextPaths || []).map((item) => normalizedRelative(item, 'allowedContextPaths')))).sort();
  const contextSnapshots = contexts.map((context) => trustedFileSnapshot(projectRoot, context, `context ${context}`));
  const headings = boundedStringArray(invocation.contractHeadings || instruction.requiredContractHeadings, 'contractHeadings', 200);
  if (headings.length === 0 || headings.length > 32 || new Set(headings).size !== headings.length) throw new Error('contractHeadings must be 1-32 unique values.');
  const pin = safeMetadata(invocation.pin || {}, 'pin');
  const executable = resolveExecutable(invocation.adapter.command, process.env);
  const timeoutSeconds = invocation.adapter.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error('Adapter timeoutSeconds is invalid.');
  if (!Array.isArray(invocation.adapter.argsTemplate) || invocation.adapter.argsTemplate.length > 64 || invocation.adapter.argsTemplate.some((item) => typeof item !== 'string' || item.length > 2048 || /\0/u.test(item))) throw new Error('Adapter argsTemplate is invalid.');
  const beforeGit = gitSnapshot(projectRoot);
  const location = invocationDirectory(projectRoot, invocation);
  inspectExistingComponents(projectRoot, location.parent, 'directory');
  const directory = makeDirectoriesExclusive(projectRoot, location.parent, location.instanceId);
  const instructionFile = path.join(directory, 'instruction.json');
  const contextFile = path.join(directory, 'context.json');
  const resultFile = path.join(directory, 'result.json');
  const instructionManifest = {
    schemaVersion: 1,
    id: instruction.id,
    revision: instruction.revision,
    instructionDigest: instruction.instructionDigest,
    allowedMode: instruction.allowedMode,
    evidenceStance: instruction.evidenceStance,
    requiredContractHeadings: instruction.requiredContractHeadings,
    instruction: instruction.instruction
  };
  const contextManifest = {
    schemaVersion: 1,
    target: target.relative,
    pin,
    instructionId: instruction.id,
    ...(invocation.lensId ? { lensId: invocation.lensId } : {}),
    contractHeadings: headings,
    allowedContextPaths: contexts,
    ...(invocation.operationId ? { operationId: invocation.operationId } : {})
  };
  const instructionHash = writeExclusiveJson(instructionFile, instructionManifest, true);
  const contextHash = writeExclusiveJson(contextFile, contextManifest, true);
  const baseReceipt = {
    schemaVersion: 1,
    instanceId: location.instanceId,
    adapter: { name: invocation.adapter.name, instructionId: instruction.id, instructionRevision: instruction.revision, instructionDigest: instruction.instructionDigest },
    manifestHashes: { instruction: instructionHash, context: contextHash }
  };
  const responseBase = { adapter: baseReceipt.adapter, instanceId: location.instanceId, invocationRoot: directory };
  try {
    if (invocation.mode === 'verify' && beforeGit.status) throw new Error('Verifier requires a clean project worktree.');
    for (const [file, expected] of [[instructionFile, instructionHash], [contextFile, contextHash]]) {
      inspectExistingComponents(directory, file, 'file');
      if (hashFile(file) !== expected) throw new Error(`${path.basename(file)} changed before spawn.`);
    }
    if (fs.existsSync(resultFile)) throw new Error('result.json must not exist before the adapter starts.');
    const args = substituteArgs(invocation.adapter.argsTemplate, {
      instruction: instructionFile,
      context: contextFile,
      result: resultFile,
      operationId: invocation.operationId
    });
    // These are the last filesystem operations before spawn. Re-resolve every
    // trusted input so a symlink/file replacement between configuration and
    // execution cannot silently change the verifier's evidence set.
    revalidateTrustedFile(projectRoot, target, 'targetPath');
    for (const context of contextSnapshots) revalidateTrustedFile(projectRoot, context, `context ${context.relative}`);
    const signal = executionOptions && executionOptions.signal || invocation.signal;
    const execution = await executeOnce(executable, args, { cwd: projectRoot, env: adapterEnvironment(process.env), timeoutSeconds, signal, onSpawn: executionOptions && executionOptions.onSpawn });
    if (execution.category !== 'success') {
      let resultHash;
      if (fs.existsSync(resultFile)) {
        try { resultHash = sha256(readStableResult(resultFile, directory)); } catch (_) {}
        try { fs.unlinkSync(resultFile); } catch (_) {}
      }
      const category = execution.category;
      // verifier의 작업 트리 불변 계약은 실패 경로에서도 검사한다 — 성공 경로만
      // 지키면 파일을 바꾼 뒤 실패·timeout으로 끝난 verifier의 위반이 조용히
      // 사라진다. 위반은 실패 사유에 더해 별도 진단으로 귀속을 남긴다.
      const mutated = invocation.mode === 'verify' && canonicalJson(gitSnapshot(projectRoot)) !== canonicalJson(beforeGit);
      const receipt = failureReceipt(directory, baseReceipt, category, resultHash);
      const diagnosticCode = category === 'child-failure'
        ? 'ADAPTER_CHILD_FAILED'
        : category === 'timeout'
          ? 'ADAPTER_TIMEOUT'
          : category === 'cancelled' ? 'ADAPTER_CANCELLED' : 'ADAPTER_SPAWN_FAILED';
      return { ...responseBase, exitCode: category === 'child-failure' ? 1 : 2, status: category, receipt, diagnosticCodes: mutated ? [diagnosticCode, 'ADAPTER_VERIFIER_MUTATED'] : [diagnosticCode] };
    }
    if (!fs.existsSync(resultFile)) throw new Error('Adapter exited successfully without result.json.');
    // 실행 뒤 대상 파일 재검증은 검증 모드에만 건다. 저작 어댑터는 그 파일을
    // 고치는 것이 일이므로, 바뀌지 않았는지 확인하면 저작이 성공할 때마다
    // 무효 출력으로 거부된다 — 저작 어댑터가 자기가 써야 할 문서를 쓸 수 없다.
    //
    // 스폰 직전 재검증(위)은 두 모드 모두에 남긴다. 그것은 스냅숏과 실행 사이의
    // 교체를 막는 것이고 저작 여부와 무관하다. 근거 파일(context)도 두 모드에서
    // 그대로 검증한다 — 읽기 입력이지 저작 대상이 아니다.
    if (invocation.mode === 'verify') revalidateTrustedFile(projectRoot, target, 'targetPath');
    for (const context of contextSnapshots) revalidateTrustedFile(projectRoot, context, `context ${context.relative}`);
    const resultBytes = readStableResult(resultFile, directory);
    const resultHash = sha256(resultBytes);
    const result = validateResult(invocation.mode, resultBytes.toString('utf8'), projectRoot);
    for (const [file, expected] of [[instructionFile, instructionHash], [contextFile, contextHash]]) {
      inspectExistingComponents(directory, file, 'file');
      const real = fs.realpathSync.native(file);
      contained(directory, real, path.basename(file));
      if (hashFile(real) !== expected) throw new Error(`${path.basename(file)} changed during adapter execution.`);
    }
    if (invocation.mode === 'verify') revalidateTrustedFile(projectRoot, target, 'targetPath');
    for (const context of contextSnapshots) revalidateTrustedFile(projectRoot, context, `context ${context.relative}`);
    const afterGit = gitSnapshot(projectRoot);
    if (invocation.mode === 'verify' && canonicalJson(afterGit) !== canonicalJson(beforeGit)) throw new Error('Verifier modified the project worktree.');
    const receipt = { ...baseReceipt, exitCategory: 'success', resultHash };
    writeExclusiveJson(path.join(directory, 'receipt.json'), receipt, false);
    return { ...responseBase, exitCode: 0, status: 'success', result, receipt };
  } catch (error) {
    let resultHash;
    if (fs.existsSync(resultFile)) {
      try { resultHash = sha256(readStableResult(resultFile, directory)); } catch (_) {}
      try { fs.unlinkSync(resultFile); } catch (_) {}
    }
    let receipt;
    if (!fs.existsSync(path.join(directory, 'receipt.json'))) receipt = failureReceipt(directory, baseReceipt, 'invalid-output', resultHash);
    return { ...responseBase, exitCode: 2, status: 'invalid-output', receipt, error: error.message };
  }
}

function generateInvocationId() {
  return `INV-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

async function runAdapterCommand(start, options) {
  assertTerminationGuaranteed('rdl adapter run');
  const run = require('./run');
  const context = run.runContext(start, options);
  const client = run.authorizeClient(start, context.project, options.clientId, ['agent', 'service']);
  if (!context.ownership || context.ownership.status !== 'ACTIVE' || context.owner !== client.id) throw new Error('The adapter client must be the active run owner.');
  const step = context.fold.cursorStep;
  if (!step || step.id !== options.step) throw new Error('The adapter step must be the active run cursor.');
  const inferredMode = step.verify || step.lenses ? 'verify' : 'author';
  if (options.mode !== inferredMode) throw new Error(`The pinned step requires ${inferredMode} mode.`);
  if (step.executor !== 'adapter' && !step.adapter) throw new Error('The active run step is not an adapter step.');
  const settings = loadHarnessSettings(start, { project: context.project.key });
  // 스텝이 어댑터 이름을 지정하지 않으면 하네스가 정한 기본 어댑터로 떨어진다.
  // 내장 절차는 프로젝트가 무엇을 쓰는지 알 수 없으므로 이름을 박지 않는다.
  const adapterName = options.adapter || options.name
    || (typeof step.adapter === 'string' ? step.adapter : step.adapter && step.adapter.name)
    || settings.runtimeResolved.verify.defaultAdapter;
  if (!ADAPTER_ID.test(adapterName || '')) throw new Error('A valid pinned adapter name is required.');
  const started = context.events.find((event) => event.type === 'run.started');
  if (!started || canonicalJson(started.settings.safeResolved) !== canonicalJson(settings.safeResolved)) throw new Error('settings-drift');
  const adapter = settings.runtimeResolved.adapters[adapterName];
  if (!adapter || adapter.enabled !== true) throw new Error(`Adapter is not enabled: ${adapterName}`);
  const lenses = step.verify && Array.isArray(step.verify.lenses) ? step.verify.lenses : [];
  if (inferredMode === 'verify' && lenses.length !== 1 && !(step.verify && step.verify.lens)) throw new Error('Public adapter run cannot choose among multiple verification lenses; use rdl verify.');
  const lensId = inferredMode === 'verify' ? ((step.verify && step.verify.lens) || lenses[0]) : undefined;
  const instruction = step.instruction || (step.verify && (step.verify.instruction || (step.verify.instructions && step.verify.instructions[lensId])));
  const artifactId = context.fold.artifactIds[context.fold.artifactIds.length - 1];
  const document = artifactId ? require('./board-data').listDocuments(context.project).find((item) => item.id === artifactId) : null;
  const targetPath = step.targetPath || (step.verify && step.verify.targetPath) || (document && document.file);
  if (!targetPath) throw new Error('The pinned adapter step has no targetPath.');
  const result = await runAdapterOnce({
    projectRoot: context.project.root,
    mode: inferredMode,
    adapter: { name: adapterName, ...adapter },
    instruction,
    targetPath,
    allowedContextPaths: step.allowedContextPaths || [],
    contractHeadings: step.contractHeadings,
    pin: { runId: context.fold.runId, procedureContentHash: started.procedure.contentHash, settingsContentHash: started.settings.contentHash },
    instanceId: generateInvocationId(),
    runId: context.fold.runId,
    stepId: step.id,
    lensId,
    operationId: options.operationId
  }, { signal: options.signal });
  return {
    exitCode: result.exitCode,
    status: result.status,
    ...(result.result ? { result: inferredMode === 'author' ? { artifactIds: result.result.artifactIds } : result.result } : {}),
    adapter: result.adapter,
    instanceId: result.instanceId,
    receipt: result.receipt,
    diagnosticCodes: result.diagnosticCodes || (result.exitCode === 2 ? ['ADAPTER_INVALID_OUTPUT'] : []),
    // 왜 무효인지를 호출자에게 넘긴다. 코드만 남으면 설정을 고칠 근거가 없다.
    ...(result.error ? { error: result.error } : {})
  };
}

function probeAdapter(adapter, options) {
  const settings = options || {};
  const executable = resolveExecutable(adapter.command, process.env);
  const result = spawnSync(executable, ['--version'], {
    cwd: settings.cwd,
    env: adapterEnvironment(process.env),
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: Math.min(settings.timeout || 5000, 10000),
    maxBuffer: MAX_CAPTURE_BYTES
  });
  const output = String(result.stdout || result.stderr || '').replace(/[\r\n]+/gu, ' ').trim().slice(0, 300);
  return { executable, status: result.status, error: result.error ? result.error.code || result.error.message : null, version: output };
}

module.exports = {
  ENV_ALLOWLIST,
  terminationGuaranteed,
  assertTerminationGuaranteed,
  resolveExecutable,
  adapterEnvironment,
  validateResult,
  executeOnce,
  runAdapterOnce,
  runAdapterCommand,
  probeAdapter,
  generateInvocationId
};
