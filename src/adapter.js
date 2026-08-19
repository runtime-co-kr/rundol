'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
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
  // 하네스가 띄운 자식은 자기가 하네스 안에 있다는 것을 안다. 사람 게이트를 스스로
  // 지나가려는 시도를 여기서 알아본다.
  //
  // 이것은 경계가 아니라 난간이다. 자식이 자기 자식에게 이 표시를 지운 env를 주면
  // 그만이므로, 적대적인 어댑터는 막지 못한다. 막는 것은 sync의 공유 차단이고,
  // 이 표시는 에이전트가 무심코 하는 일을 그 자리에서 멈춘다.
  environment.RUNDOL_HARNESS_CHILD = '1';
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

// 어떤 경로가 더럽혀졌는지를 이름으로 센다. porcelain status를 파싱하지 않는 이유가
// 둘 있다. 상태 문자 두 칸은 앞이 공백일 수 있는데 runGit이 stdout을 trim하므로 첫
// 항목의 경로가 한 칸 잘리고, 기본 출력은 공백·따옴표가 든 경로를 인용해서 낸다.
// 경로만 내보내는 세 명령의 합집합은 두 문제가 다 없다.
function statusPaths(projectRoot, pathspec) {
  const spec = pathspec ? ['--', pathspec.split(path.sep).join('/')] : [];
  const paths = new Set();
  for (const args of [
    ['diff', '--name-only', '-z'],
    ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z']
  ]) {
    for (const entry of String(runGit(args.concat(spec), { cwd: projectRoot }).stdout || '').split('\0')) {
      if (entry) paths.add(entry);
    }
  }
  return paths;
}

// 대상 밖에서 변한 경로. git이 내는 경로는 저장소 최상위 기준이고 프로젝트 루트
// 기준이 아니다 — 둘을 손으로 환산하면 Windows의 짧은 경로·심링크에서 어긋난다.
// 그래서 같은 git에게 두 번 물어 차집합을 구한다: 전체와, 대상으로 좁힌 것.
//
// 대상이 여럿일 수 있다. 형제 문서를 동시에 저작하면 먼저 끝난 저작의 결과가 본
// 트리에 떠 있고, 그것을 남의 변경으로 읽으면 나머지 저작이 시작하지 못한다 —
// 격리는 이미 있는데 복귀가 직렬이라 병렬이 되지 않던 자리가 여기다. 같은 fan-out에
// 속한 형제의 변경은 남의 변경이 아니다.
function foreignChangedPaths(projectRoot, targetReals) {
  const targets = Array.isArray(targetReals) ? targetReals : [targetReals];
  const all = statusPaths(projectRoot, null);
  for (const target of targets) {
    if (!target) continue;
    for (const item of statusPaths(projectRoot, target)) all.delete(item);
  }
  return Array.from(all).sort();
}

// 같은 fan-out에 속한 대상들의 실제 경로. 선언하지 않으면 자기 대상 하나이고,
// 그때의 동작은 fan-out이 없던 때와 같다.
//
// 형제 목록에 없는 파일이 떠 있으면 여전히 거부한다. 병렬이 저작의 경계를 넓히지는
// 않는다 — 넓어지는 것은 "무엇이 남의 변경인가"의 기준뿐이다.
function fanOutSiblings(projectRoot, invocation, targetRelative, targetReal) {
  const declared = Array.isArray(invocation.fanOutTargets) ? invocation.fanOutTargets : null;
  if (!declared || !declared.length) return [targetReal];
  if (declared.length > MAX_COLLECTION) throw new Error('fanOutTargets is too large.');
  const reals = new Set([targetReal]);
  let found = false;
  for (const item of declared) {
    const relative = normalizedRelative(item, 'fanOutTargets');
    if (relative === targetRelative) { found = true; continue; }
    // 형제가 아직 없을 수 있다. 아직 만들어지지 않은 대상은 청결 기준에 넣을 것이
    // 없으므로 건너뛴다 — 없는 파일을 근거로 남의 변경을 눈감아 주지는 않는다.
    const resolved = path.resolve(projectRoot, relative);
    if (!fs.existsSync(resolved)) continue;
    reals.add(regularRealFile(projectRoot, relative, 'fanOutTargets').file);
  }
  if (!found) throw new Error('fanOutTargets must contain targetPath.');
  return Array.from(reals);
}

function withoutSiblings(paths, siblingPaths) {
  return paths.filter((item) => !siblingPaths.has(item));
}

// 저작 시도는 성공하거나 흔적을 남기지 않아야 한다. 실패한 시도가 반쯤 쓴 문서를
// 작업 트리에 남기면 다음 저장이 그것을 커밋하고, 절차는 자기가 무엇을 저장했는지
// 모르게 된다 — operation-id 재시도가 약속하는 "같은 시도는 같은 결과"도 깨진다.
const AUTHOR_ROLLBACK_LIMIT = 16 * 1024 * 1024;

// 저작은 일회용 git worktree 안에서 돈다. 검사만으로는 부족하다는 것이 이유다 —
// 대상 밖 변경을 발견해 실행을 거부해도, 그 변경은 이미 작업 트리에 있고 어댑터가
// 스스로 만든 커밋은 이미 브랜치에 있다. 발견은 되돌림이 아니다.
//
// detached worktree 안에서는 어댑터가 무엇을 쓰든 무엇을 커밋하든 프로젝트 브랜치에
// 닿지 않는다. 끝나면 대상 파일 하나만 본 트리로 옮기고 나머지는 worktree와 함께
// 버린다. 이것은 OS 샌드박스가 아니다 — 어댑터는 절대 경로로 어디든 쓸 수 있다.
// 다만 하네스가 받아들이는 것이 대상 하나로 좁혀지고, git을 통한 오염이 막힌다.
function createAuthorSandbox(projectRoot, instanceId) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-author-'));
  const tree = path.join(base, 'w');
  runGit(['worktree', 'add', '--detach', tree, 'HEAD'], { cwd: projectRoot });
  return { base, root: fs.realpathSync.native(tree) };
}

function removeAuthorSandbox(projectRoot, sandbox) {
  if (!sandbox) return;
  try { runGit(['worktree', 'remove', '--force', sandbox.root], { cwd: projectRoot, allowFailure: true }); } catch (_) {}
  try { fs.rmSync(sandbox.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  try { runGit(['worktree', 'prune'], { cwd: projectRoot, allowFailure: true }); } catch (_) {}
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
    // 자식이 스스로 먼저 끝났으면 taskkill은 "그런 프로세스 없음"으로 실패한다.
    // 그것은 실패가 아니라 이미 이룬 상태다. 여기서 경고를 내면 정상 종료마다
    // 거짓 경고가 쌓이고, 그러면 진짜 경고 — 자손이 살아남았다는 그 한 줄 — 도
    // 같이 무시된다. 경고를 지키려면 경고를 아껴야 한다.
    let stillThere = true;
    try { process.kill(child.pid, 0); } catch (error) { stillThere = error.code === 'EPERM'; }
    if (!stillThere) return Promise.resolve();
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
  const mainTarget = trustedFileSnapshot(projectRoot, targetRelative, 'targetPath');
  // 청결 검사의 기준은 이 저작의 대상 하나가 아니라 같은 fan-out에 속한 대상 전체다.
  // 형제가 먼저 끝나 본 트리에 결과를 올려 두었을 수 있고, 그것은 남의 변경이 아니다.
  // 선언하지 않으면 자기 대상 하나이므로 지금까지의 동작이 그대로 남는다.
  const siblingReals = fanOutSiblings(projectRoot, invocation, targetRelative, mainTarget.real);
  // 저작이 시작되는 시점에 본 트리가 fan-out 대상 밖에서 더러우면 시작하지 않는다.
  // 격리 worktree를 쓰더라도 이 검사는 남는다 — 뒤따르는 save가 대상 전체를 커밋하므로,
  // 저작과 무관한 변경이 떠 있으면 그것이 이 런의 결과에 섞인다.
  if (invocation.mode === 'author') {
    const foreign = foreignChangedPaths(projectRoot, siblingReals);
    if (foreign.length) throw new Error(`Author adapters require a project worktree clean outside the target: ${foreign.slice(0, 5).join(', ')}`);
  }
  const headings = boundedStringArray(invocation.contractHeadings || instruction.requiredContractHeadings, 'contractHeadings', 200);
  if (headings.length === 0 || headings.length > 32 || new Set(headings).size !== headings.length) throw new Error('contractHeadings must be 1-32 unique values.');
  const pin = safeMetadata(invocation.pin || {}, 'pin');
  const executable = resolveExecutable(invocation.adapter.command, process.env);
  const timeoutSeconds = invocation.adapter.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error('Adapter timeoutSeconds is invalid.');
  if (!Array.isArray(invocation.adapter.argsTemplate) || invocation.adapter.argsTemplate.length > 64 || invocation.adapter.argsTemplate.some((item) => typeof item !== 'string' || item.length > 2048 || /\0/u.test(item))) throw new Error('Adapter argsTemplate is invalid.');
  // 저작은 대상 문서를 고치는 일이므로, 옮겨 담으려면 지금 바이트가 필요하다.
  if (invocation.mode === 'author' && mainTarget.size > AUTHOR_ROLLBACK_LIMIT) throw new Error('Author target is too large to sandbox.');
  const authorBytes = invocation.mode === 'author' ? fs.readFileSync(mainTarget.real) : null;
  const sandbox = invocation.mode === 'author' ? createAuthorSandbox(projectRoot) : null;
  // 저작이 보고 쓰는 트리. 격리 worktree는 HEAD 상태이므로, 본 트리에서 아직 커밋되지
  // 않은 대상 내용을 그대로 옮겨 놓는다 — 재시도가 이전 시도의 결과 위에서 이어져야 한다.
  const workRoot = sandbox ? sandbox.root : projectRoot;
  if (sandbox) fs.writeFileSync(path.resolve(workRoot, targetRelative), authorBytes);
  const target = trustedFileSnapshot(workRoot, targetRelative, 'targetPath');
  const contexts = Array.from(new Set((invocation.allowedContextPaths || []).map((item) => normalizedRelative(item, 'allowedContextPaths')))).sort();
  const contextSnapshots = contexts.map((context) => trustedFileSnapshot(workRoot, context, `context ${context}`));
  const beforeGit = gitSnapshot(workRoot);
  // 격리 worktree는 어댑터의 자연스러운 쓰기를 가둘 뿐, OS 샌드박스가 아니다 —
  // 어댑터는 넘겨받은 절대 경로에서 본 저장소를 역산해 직접 쓸 수 있다. 그것을 막지는
  // 못하지만 알아차리지 못한 채 성공으로 보고하는 것은 다른 문제다. 본 저장소의
  // 상태도 함께 스냅숏해서, 탈출한 저작은 실패로 끝나게 한다.
  const mainBefore = sandbox ? { git: gitSnapshot(projectRoot), paths: Array.from(statusPaths(projectRoot, null)).sort() } : null;
  // 형제가 복귀시킨 파일은 이 저작이 만든 변경이 아니지만 탈출도 아니다. 빼지 않으면
  // 병렬을 켠 순간 모든 저작이 서로를 탈출로 고발한다.
  // 빼는 것은 형제의 경로뿐이고 자기 대상은 빼지 않는다. 자기 대상까지 빼면 격리를
  // 벗어나 본 트리의 그 파일을 직접 고친 저작이 탈출 검사를 지나간다 — 병렬을 위해
  // 넓힌 것은 "무엇이 남의 변경인가"의 기준이지 감시 범위가 아니다.
  //
  // fan-out이 아닐 때 이 집합은 비고, git을 한 번도 부르지 않는다. 형제가 없는데도
  // 물으면 저작 한 번마다 git 호출 셋이 늘고, 그 지연이 자식 spawn을 늦춘다.
  const siblingPaths = new Set(siblingReals.filter((real) => real !== mainTarget.real)
    .flatMap((real) => Array.from(statusPaths(projectRoot, real))));
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
    revalidateTrustedFile(workRoot, target, 'targetPath');
    for (const context of contextSnapshots) revalidateTrustedFile(workRoot, context, `context ${context.relative}`);
    // 저작은 격리 worktree에서 돌지만 결과는 본 트리의 대상 파일로 돌아간다. 그 자리가
    // 스냅숏 이후 바뀌었다면 지금 멈춘다 — 나중에 덮어쓰면 남의 편집이 조용히 사라지고,
    // 어댑터를 한 번 돌린 값도 버려진다.
    if (sandbox) {
      revalidateTrustedFile(projectRoot, mainTarget, 'targetPath');
      // 본 트리 청결 검사를 스폰 직전에 한 번 더 한다. 격리 worktree는 HEAD에서
      // 만들어지므로 근거 파일(context)은 커밋된 내용이다. 본 트리가 대상 밖에서
      // 더러우면 저작이 읽은 근거와 저장될 내용이 달라지고, 그 차이는 아무 데도
      // 기록되지 않는다. 앞선 검사만으로는 그 사이에 생긴 변경을 못 본다.
      const foreign = foreignChangedPaths(projectRoot, siblingReals);
      if (foreign.length) throw new Error(`Author adapters require a project worktree clean outside the target: ${foreign.slice(0, 5).join(', ')}`);
    }
    const signal = executionOptions && executionOptions.signal || invocation.signal;
    const execution = await executeOnce(executable, args, { cwd: workRoot, env: adapterEnvironment(process.env), timeoutSeconds, signal, onSpawn: executionOptions && executionOptions.onSpawn });
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
      // 저작이 실패하면 되돌릴 것이 없다. 저작은 격리 worktree에서만 썼고, 본 트리로
      // 옮기는 것은 성공 경로에서만 하기 때문이다. worktree는 finally에서 통째로 버린다.
      const receipt = failureReceipt(directory, baseReceipt, category, resultHash);
      const diagnosticCode = category === 'child-failure'
        ? 'ADAPTER_CHILD_FAILED'
        : category === 'timeout'
          ? 'ADAPTER_TIMEOUT'
          : category === 'cancelled' ? 'ADAPTER_CANCELLED' : 'ADAPTER_SPAWN_FAILED';
      const codes = [diagnosticCode];
      if (mutated) codes.push('ADAPTER_VERIFIER_MUTATED');
      return { ...responseBase, exitCode: category === 'child-failure' ? 1 : 2, status: category, receipt, diagnosticCodes: codes };
    }
    if (!fs.existsSync(resultFile)) throw new Error('Adapter exited successfully without result.json.');
    // 실행 뒤 대상 파일 재검증은 검증 모드에만 건다. 저작 어댑터는 그 파일을
    // 고치는 것이 일이므로, 바뀌지 않았는지 확인하면 저작이 성공할 때마다
    // 무효 출력으로 거부된다 — 저작 어댑터가 자기가 써야 할 문서를 쓸 수 없다.
    //
    // 스폰 직전 재검증(위)은 두 모드 모두에 남긴다. 그것은 스냅숏과 실행 사이의
    // 교체를 막는 것이고 저작 여부와 무관하다. 근거 파일(context)도 두 모드에서
    // 그대로 검증한다 — 읽기 입력이지 저작 대상이 아니다.
    if (invocation.mode === 'verify') revalidateTrustedFile(workRoot, target, 'targetPath');
    // 저작 모드에서 내용은 바뀌어도 된다 — 그게 저작이다. 그러나 그 자리가 여전히
    // 트리 안의 보통 파일이어야 한다. 해시 하나만 빼고 나머지 계약은 그대로다.
    else regularRealFile(workRoot, target.relative, 'targetPath');
    for (const context of contextSnapshots) revalidateTrustedFile(workRoot, context, `context ${context.relative}`);
    const resultBytes = readStableResult(resultFile, directory);
    const resultHash = sha256(resultBytes);
    const result = validateResult(invocation.mode, resultBytes.toString('utf8'), workRoot);
    for (const [file, expected] of [[instructionFile, instructionHash], [contextFile, contextHash]]) {
      inspectExistingComponents(directory, file, 'file');
      const real = fs.realpathSync.native(file);
      contained(directory, real, path.basename(file));
      if (hashFile(real) !== expected) throw new Error(`${path.basename(file)} changed during adapter execution.`);
    }
    if (invocation.mode === 'verify') revalidateTrustedFile(workRoot, target, 'targetPath');
    else regularRealFile(workRoot, target.relative, 'targetPath');
    for (const context of contextSnapshots) revalidateTrustedFile(workRoot, context, `context ${context.relative}`);
    const afterGit = gitSnapshot(workRoot);
    if (invocation.mode === 'verify' && canonicalJson(afterGit) !== canonicalJson(beforeGit)) throw new Error('Verifier modified the project worktree.');
    // HEAD는 두 모드 모두에서 움직이면 안 된다. 어댑터가 스스로 커밋하면 절차의 저장
    // 스텝은 자기가 무엇을 커밋했는지 말할 수 없고, 검증이 결박될 커밋을 하네스가
    // 정하지 못한다 — 무엇이 판정됐는지가 어댑터의 손에 넘어간다. 저작의 커밋은
    // 격리 worktree의 detached HEAD에 남으므로 프로젝트 브랜치에는 닿지 않는다.
    if (afterGit.head !== beforeGit.head) throw new Error('Adapter moved project HEAD.');
    // 저작이 만질 수 있는 것은 자기 대상 하나다. 대상 밖 변경은 격리 worktree와 함께
    // 버려지지만, 버리는 것으로 끝내지 않고 거부한다 — 조용히 지워진 시도는 다음에
    // 또 일어나고, 무엇이 왜 빠졌는지 아무도 모르게 된다.
    if (invocation.mode === 'author') {
      const strayed = foreignChangedPaths(workRoot, target.real);
      if (strayed.length) throw new Error(`Author adapter changed files outside its target: ${strayed.slice(0, 5).join(', ')}`);
    }
    // 격리를 빠져나가 본 저장소를 직접 고친 저작은 성공일 수 없다. 여기서 묻지
    // 않으면 어댑터는 main HEAD를 옮기고 파일을 고친 뒤에도 성공을 돌려주고,
    // 하네스는 자기가 무엇을 승인했는지 모른 채 다음 스텝으로 넘어간다.
    if (sandbox) {
      const mainAfter = { git: gitSnapshot(projectRoot), paths: Array.from(statusPaths(projectRoot, null)).sort() };
      if (mainAfter.git.head !== mainBefore.git.head || canonicalJson(withoutSiblings(mainAfter.paths, siblingPaths)) !== canonicalJson(withoutSiblings(mainBefore.paths, siblingPaths))) {
        const error = new Error('Author adapter modified the main project repository from outside its sandbox.');
        error.rdlCode = 'ADAPTER_ESCAPED_SANDBOX';
        throw error;
      }
    }
    // 여기까지 온 저작만 본 트리에 닿는다. 옮기는 것은 대상 파일 하나뿐이다.
    //
    // 돌았는데 쓸 것이 없던 저작과 아예 돌지 못한 저작은 다른 값이다. 구분하지 않으면
    // 아무것도 하지 않고 "변경 없음"이라 말하는 것이 완료로 가는 가장 싼 길이 된다.
    let changed = null;
    if (sandbox) {
      const produced = fs.readFileSync(target.real);
      const destination = regularRealFile(projectRoot, targetRelative, 'targetPath').file;
      if (hashFile(destination) !== mainTarget.hash) throw new Error('targetPath changed in the project worktree during authoring.');
      changed = sha256(produced) !== mainTarget.hash;
      if (changed) fs.writeFileSync(destination, produced);
    }
    const receipt = { ...baseReceipt, exitCategory: 'success', resultHash };
    writeExclusiveJson(path.join(directory, 'receipt.json'), receipt, false);
    return { ...responseBase, exitCode: 0, status: 'success', result, receipt, ...(changed === null ? {} : { changed }) };
  } catch (error) {
    let resultHash;
    if (fs.existsSync(resultFile)) {
      try { resultHash = sha256(readStableResult(resultFile, directory)); } catch (_) {}
      try { fs.unlinkSync(resultFile); } catch (_) {}
    }
    // 계약 위반으로 끝난 저작은 본 트리에 아무것도 남기지 않는다. 되돌릴 일이 없는
    // 것은 애초에 본 트리에 쓴 적이 없기 때문이다 — 옮기기는 성공 경로에만 있다.
    let receipt;
    if (!fs.existsSync(path.join(directory, 'receipt.json'))) receipt = failureReceipt(directory, baseReceipt, 'invalid-output', resultHash);
    return { ...responseBase, exitCode: 2, status: 'invalid-output', receipt, error: error.message, ...(error.rdlCode ? { diagnosticCodes: [error.rdlCode] } : {}) };
  } finally {
    removeAuthorSandbox(projectRoot, sandbox);
  }
}

// 형제 문서를 동시에 저작한다. 격리는 이미 있었다 — 저작은 일회용 detached worktree
// 에서 돌고 끝나면 대상 파일 하나만 본 트리로 옮긴다. 병렬이 되지 않던 이유는 격리가
// 아니라 복귀였고, 그 자리는 위의 청결·탈출 검사가 fan-out 대상 전체를 기준으로
// 삼으면서 열렸다.
//
// 실행되지 못한 대상과 실행되었으나 변경이 없던 대상을 구분해 남긴다. 구분하지
// 않으면 결과를 지어내는 것이 완료로 가는 가장 싼 길이 된다 — 아무것도 하지 않고도
// "변경 없음"이라고 말하면 통과이기 때문이다.
async function runAuthorFanOut(targets, options) {
  const settings = options || {};
  const list = Array.isArray(targets) ? targets.slice() : [];
  if (list.length > MAX_COLLECTION) throw new Error('Author fan-out target set is too large.');
  const limit = Math.min(Math.max(1, settings.maxConcurrency || 1), Math.max(1, list.length));
  const runner = settings.runAdapterOnce || runAdapterOnce;
  const fanOutTargets = list.map((item) => item.targetPath);
  const results = new Array(list.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next; next += 1;
      const target = list[index];
      try {
        const outcome = await runner(Object.assign({}, target.invocation, { targetPath: target.targetPath, fanOutTargets }), settings.executionOptions);
        results[index] = { targetPath: target.targetPath, dispatched: true, outcome, error: null };
      } catch (error) {
        // 하나가 실패해도 나머지를 중단하지 않는다. 이미 복귀한 결과는 본 트리에
        // 남아 있고, 그것을 버리면 다음 시도가 처음부터 다시 저작한다.
        results[index] = { targetPath: target.targetPath, dispatched: true, outcome: null, error: error.message };
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  // 준비 완료 집합이 비면 아무 것도 하지 않는다. 빈 집합은 실패가 아니다.
  const undispatched = list.filter((item, index) => results[index] === null).map((item) => item.targetPath);
  const settled = results.filter(Boolean);
  return {
    targets: fanOutTargets,
    // 실행되었으나 변경이 없던 대상. 어댑터가 성공했는데 대상 파일이 그대로면 그것은
    // 실패가 아니라 "쓸 것이 없었다"이고, 실행되지 못한 것과 같은 값이 아니다.
    unchanged: settled.filter((item) => item.outcome && item.outcome.exitCode === 0 && item.outcome.changed === false).map((item) => item.targetPath),
    undispatched,
    failed: settled.filter((item) => item.error || !item.outcome || item.outcome.exitCode !== 0).map((item) => ({ targetPath: item.targetPath, reason: item.error || (item.outcome && item.outcome.status) || 'unknown' })),
    results: settled
  };
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
  runAuthorFanOut,
  runAdapterCommand,
  probeAdapter,
  generateInvocationId
};
