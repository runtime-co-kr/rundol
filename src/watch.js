'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('./event-store');
const { runGit } = require('./git');
const { workspaceLayout, selectProject } = require('./workspace');
const { listDocuments } = require('./board-data');
const { checkWorkspace } = require('./check');
const { runtimeWorkspace } = require('./runtime');
const { loadHarnessSettings } = require('./harness-settings');

const DIGEST = /^[0-9a-f]{64}$/u;
const WATCH_TYPES = {
  'watch.scan.started': ['scanId', 'scanRevision', 'head', 'gitStatusDigest'],
  'watch.diagnostic': ['scanId', 'scanRevision', 'targetId', 'targetRevision', 'code', 'severity', 'category', 'message', 'dedupKey'],
  'watch.scan.completed': ['scanId', 'scanRevision', 'head', 'gitStatusDigest', 'activeDiagnosticKeys', 'summary'],
  'watch.remote.relation': ['scope', 'ref', 'localTip', 'remoteTip', 'ahead', 'behind', 'relation', 'relationKey'],
  'watch.error': ['phase', 'code', 'message', 'retryable']
};
const OPTIONAL_KEYS = { 'watch.diagnostic': new Set(['file', 'line']) };

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestJson(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function boundedMessage(value) {
  const normalized = String(value || '').replace(/\r\n?/gu, '\n').replace(/[\0\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').normalize('NFC').trim();
  return (normalized || 'Watch operation failed.').slice(0, 1000);
}

function relative(root, file) {
  return path.relative(root, file).replace(/\\/gu, '/');
}

function filesUnder(target) {
  if (!target || !fs.existsSync(target)) return [];
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...filesUnder(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function fileDigests(root, targets) {
  const files = [];
  for (const target of targets) for (const file of filesUnder(target)) files.push(file);
  return Array.from(new Set(files.map((file) => path.resolve(file))))
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)))
    .map((file) => [relative(root, file), sha256(fs.readFileSync(file))]);
}

function defaultInputSnapshot(context) {
  const { layout, project } = context;
  const head = runGit(['rev-parse', 'HEAD'], { cwd: project.root }).stdout;
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: project.root }).stdout
    .split(/\r?\n/u).filter(Boolean).sort();
  const listedDocuments = listDocuments(project);
  const documents = listedDocuments.map((document) => [document.id, document.revision]).sort((left, right) => left[0].localeCompare(right[0]));
  const projectConfigs = [project.manifest, project.charter, path.join(project.root, 'harness.json'), path.join(project.root, 'procedures.json'), path.join(project.root, 'board.json')];
  const workspaceRoot = path.join(layout.root, 'projects', 'workspace');
  const workspaceConfigs = [layout.manifest && layout.manifest.file, path.join(workspaceRoot, 'workspace.yaml'), path.join(workspaceRoot, 'harness.json'), path.join(workspaceRoot, 'procedures.json'), path.join(workspaceRoot, 'board.json'), layout.projectsDirectory];
  const eventsRoot = path.join(workspaceRoot, 'events');
  const taskShardDigests = fileDigests(layout.root, [project.tasks]);
  const projectConfigDigests = fileDigests(layout.root, projectConfigs);
  const workspaceConfigDigests = fileDigests(layout.root, workspaceConfigs);
  const registeredEventShardHeads = fileDigests(layout.root, filesUnder(eventsRoot).filter((file) => file.endsWith('.jsonl')));
  const knownDocumentRevisions = new Map(listedDocuments.map((document) => [relative(layout.root, path.resolve(project.root, document.file)), document.revision]));
  const documentSourceRevisions = filesUnder(project.root).filter((file) => file.endsWith('.md') && !relative(project.root, file).split('/').some((part) => ['.git', '.rundol', '.obsidian', 'views', 'templates'].includes(part)))
    .map((file) => {
      const name = relative(layout.root, file);
      return [name, knownDocumentRevisions.get(name) || sha256(fs.readFileSync(file))];
    });
  const sourceMap = new Map([...documentSourceRevisions, ...taskShardDigests, ...projectConfigDigests, ...workspaceConfigDigests, ...registeredEventShardHeads]);
  const diagnosticSourceRevisions = Array.from(sourceMap.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  return {
    head,
    gitStatusDigest: digestJson(status),
    documents,
    taskShardDigests,
    projectConfigDigests,
    workspaceConfigDigests,
    registeredEventShardHeads,
    diagnosticSourceRevisions
  };
}

function validateInputSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Watch inputSnapshot must be an object.');
  const keys = Object.keys(snapshot).sort();
  const expected = ['diagnosticSourceRevisions', 'documents', 'gitStatusDigest', 'head', 'projectConfigDigests', 'registeredEventShardHeads', 'taskShardDigests', 'workspaceConfigDigests'];
  if (canonicalJson(keys) !== canonicalJson(expected) || !/^[0-9a-f]{40,64}$/u.test(snapshot.head || '') || !DIGEST.test(snapshot.gitStatusDigest || '')) throw new Error('Watch inputSnapshot boundary is invalid.');
  for (const key of ['documents', 'taskShardDigests', 'projectConfigDigests', 'workspaceConfigDigests', 'registeredEventShardHeads', 'diagnosticSourceRevisions']) {
    const values = snapshot[key];
    if (!Array.isArray(values) || values.some((item) => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !item[0] || !DIGEST.test(item[1] || ''))) throw new Error(`Watch inputSnapshot ${key} is invalid.`);
    const sorted = values.slice().sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
    if (canonicalJson(values) !== canonicalJson(sorted) || new Set(values.map((item) => item[0])).size !== values.length) throw new Error(`Watch inputSnapshot ${key} must be sorted and unique.`);
  }
  return snapshot;
}

function scanRevision(snapshot) {
  return digestJson(validateInputSnapshot(snapshot));
}

function dedupKey(targetId, code, targetRevision) {
  return sha256(Buffer.from(`${targetId}\0${code}\0${targetRevision}`, 'utf8'));
}

function relationKey(scope, ref, localTip, remoteTip, ahead, behind, relation) {
  return sha256(Buffer.from(`${scope}\0${ref}\0${localTip}\0${remoteTip}\0${ahead}\0${behind}\0${relation}`, 'utf8'));
}

function relationName(ahead, behind) {
  if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) throw new Error('Remote relation counts must be non-negative integers.');
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'equal';
}

function remoteRelation(scope, ref, localTip, remoteTip, ahead, behind) {
  if (!['project', 'workspace'].includes(scope) || !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(ref || '') || !/^[0-9a-f]{40,64}$/u.test(localTip || '') || !/^[0-9a-f]{40,64}$/u.test(remoteTip || '')) throw new Error('Remote relation identity is invalid.');
  const relation = relationName(ahead, behind);
  return { scope, ref, localTip, remoteTip, ahead, behind, relation, relationKey: relationKey(scope, ref, localTip, remoteTip, ahead, behind, relation) };
}

function exactRecordKeys(record) {
  const required = WATCH_TYPES[record.type];
  if (!required) throw new Error(`Unknown watch record type: ${record.type}`);
  const allowed = new Set(['schemaVersion', 'type', 'watchId', 'sequence', 'project', ...required, ...(OPTIONAL_KEYS[record.type] || [])]);
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) throw new Error(`${record.type} has unknown or missing fields.`);
}

function validateWatchRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Watch record must be an object.');
  exactRecordKeys(record);
  if (record.schemaVersion !== 1 || !/^WATCH-[0-9A-F]{20}$/u.test(record.watchId || '') || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.project || '')) throw new Error('Watch common record fields are invalid.');
  if (record.type.startsWith('watch.scan.')) {
    if (!DIGEST.test(record.scanId || '') || record.scanId !== record.scanRevision || !DIGEST.test(record.scanRevision || '')) throw new Error('Watch scan identity is invalid.');
  }
  if (record.type === 'watch.scan.started' || record.type === 'watch.scan.completed') {
    if (!/^[0-9a-f]{40,64}$/u.test(record.head || '') || !DIGEST.test(record.gitStatusDigest || '')) throw new Error('Watch scan boundary is invalid.');
  }
  if (record.type === 'watch.diagnostic') {
    if (!record.targetId || !DIGEST.test(record.targetRevision || '') || !record.code || !['error', 'warning'].includes(record.severity) || !record.category || !record.message || !DIGEST.test(record.dedupKey || '')) throw new Error('Watch diagnostic is invalid.');
    if (record.dedupKey !== dedupKey(record.targetId, record.code, record.targetRevision)) throw new Error('Watch diagnostic dedupKey mismatch.');
    if (record.line !== undefined && (!Number.isSafeInteger(record.line) || record.line < 1)) throw new Error('Watch diagnostic line is invalid.');
  }
  if (record.type === 'watch.scan.completed') {
    if (!Array.isArray(record.activeDiagnosticKeys) || record.activeDiagnosticKeys.some((key) => !DIGEST.test(key)) || canonicalJson(record.activeDiagnosticKeys) !== canonicalJson(Array.from(new Set(record.activeDiagnosticKeys)).sort())) throw new Error('Watch activeDiagnosticKeys are invalid.');
    const summaryKeys = record.summary && Object.keys(record.summary).sort();
    if (canonicalJson(summaryKeys) !== canonicalJson(['errors', 'total', 'warnings']) || Object.values(record.summary).some((value) => !Number.isSafeInteger(value) || value < 0) || record.summary.total !== record.summary.errors + record.summary.warnings) throw new Error('Watch summary is invalid.');
  }
  if (record.type === 'watch.remote.relation') {
    const expected = remoteRelation(record.scope, record.ref, record.localTip, record.remoteTip, record.ahead, record.behind);
    if (canonicalJson(expected) !== canonicalJson({ scope: record.scope, ref: record.ref, localTip: record.localTip, remoteTip: record.remoteTip, ahead: record.ahead, behind: record.behind, relation: record.relation, relationKey: record.relationKey })) throw new Error('Watch remote relation is invalid.');
  }
  if (record.type === 'watch.error' && (!record.phase || !record.code || !record.message || typeof record.retryable !== 'boolean')) throw new Error('Watch error is invalid.');
  return record;
}

function emptyCache(project) {
  return { schemaVersion: 1, project, lastCompletedScanRevision: null, activeDiagnostics: {}, remoteRelationKeys: { project: null, workspace: null }, sequenceBase: 0 };
}

function cacheFile(project) {
  return path.join(project.root, '.rundol', 'state', 'watch', 'cache.json');
}

function loadCache(file, project) {
  if (!fs.existsSync(file)) return emptyCache(project);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Object.keys(value).sort();
    if (canonicalJson(keys) !== canonicalJson(['activeDiagnostics', 'lastCompletedScanRevision', 'project', 'remoteRelationKeys', 'schemaVersion', 'sequenceBase']) || value.schemaVersion !== 1 || value.project !== project || !Number.isSafeInteger(value.sequenceBase) || value.sequenceBase < 0) throw new Error('invalid cache');
    if (value.lastCompletedScanRevision !== null && !DIGEST.test(value.lastCompletedScanRevision)) throw new Error('invalid cache');
    if (!value.activeDiagnostics || typeof value.activeDiagnostics !== 'object' || Array.isArray(value.activeDiagnostics)) throw new Error('invalid cache');
    for (const [key, item] of Object.entries(value.activeDiagnostics)) {
      if (!DIGEST.test(key) || !item || canonicalJson(Object.keys(item).sort()) !== canonicalJson(['code', 'targetId', 'targetRevision']) || !DIGEST.test(item.targetRevision || '') || dedupKey(item.targetId, item.code, item.targetRevision) !== key) throw new Error('invalid cache');
    }
    if (!value.remoteRelationKeys || canonicalJson(Object.keys(value.remoteRelationKeys).sort()) !== canonicalJson(['project', 'workspace']) || Object.values(value.remoteRelationKeys).some((item) => item !== null && !DIGEST.test(item))) throw new Error('invalid cache');
    return value;
  } catch (_) {
    return emptyCache(project);
  }
}

function atomicCache(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.cache-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${canonicalJson(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
}

function responsibleRevision(diagnostic, inventory, revision) {
  const byId = new Map(inventory.documents.map((item) => [item[0], item[1]]));
  const candidateId = diagnostic.artifactId || diagnostic.target;
  if (candidateId && byId.has(candidateId)) return { targetId: candidateId, targetRevision: byId.get(candidateId) };
  const diagnosticFile = diagnostic.file && String(diagnostic.file).replace(/\\/gu, '/').replace(/^\.\//u, '');
  const source = diagnosticFile && inventory.diagnosticSourceRevisions.find((item) => item[0] === diagnosticFile || item[0].endsWith(`/${diagnosticFile}`));
  if (source) return { targetId: candidateId || `source:${source[0]}`, targetRevision: source[1] };
  return { targetId: candidateId || `project:${inventory.project}`, targetRevision: revision };
}

// 승인 낡음(승인 후 개정)을 감시 신호로 낸다.
//
// 새 레코드 타입을 열지 않고 기존 watch.diagnostic 축에 태운다. 이 신호가 성립하는 데
// 필요한 것이 그 축에 이미 다 있기 때문이다 — dedupKey가 같은 사실을 한 번만 울리게 하고,
// 해소는 다음 스캔의 activeDiagnosticKeys에서 빠지는 것으로 말한다. 재승인은 문서 리비전을
// 바꾸지 않으므로(승인 결과를 파일에 쓰지 않는다) 낡음의 해소는 "활성 집합에서 사라짐"
// 말고는 표현할 방법이 없고, 그 표현을 가진 축은 이것뿐이다. 새 타입을 열면 소비자마다
// 그 해소 규칙을 다시 배워야 하고, 배우지 않은 소비자에게는 한 번 운 낡음이 영영 남는다.
//
// 코드는 승인의 이름 공간에 둔다. 판정이 approval.js의 것이므로 코드를 들고 찾아갈 자리가
// 거기여야 한다. 01x(샤드 형식)와 02x(인가)는 check.js가 이미 쓰고 있고, 03x의 앞 둘은
// check-rules.js가 상류 신뢰(030 낡은 상류·031 미승인 상류)로 가져갔다.
//
// 그 둘과 이것은 붙여 두면 안 된다. 저쪽은 "네가 근거로 삼은 다른 문서가 흔들렸다"이고
// 이것은 "이 문서 자신이 승인 뒤에 바뀌었다"라, 같은 코드를 달면 진단을 세는 쪽이 상류
// 문제와 자기 문제를 한 숫자로 합친다.
//
// category가 workspace가 아니라 approval인 이유는 낡음이 작업공간 위생이 아니라 문서 하나의
// 상태여서다 — 승인 축을 쓰지 않는 프로젝트는 이 category를 한 번도 보지 않는다.
const STALE_CODE = 'RDL-APPROVE-032';

// 승인 원장을 접어 이 프로젝트의 문서별 승인 이력을 얻는다.
//
// 못 읽으면 null로 돌아가 낡음 신호 없이 그냥 돈다. 감시는 저장소 전체를 훑는 자리라
// 원장 하나에 인질이 되면 안 된다 — 여기서 던지면 판올림 전(schemaVersion 6 미만)이거나
// 원장이 깨진 저장소에서 감시가 통째로 서고, 낡음 하나를 못 보는 대신 나머지 진단을
// 전부 잃는다. check.js가 깨진 설정을 진단으로 싣고 검사를 계속하는 것과 같은 태도다.
function defaultApprovalHistories(layout, project) {
  try {
    if (layout.schemaVersion < 6) return null;
    const approval = require('./approval');
    const { authorityContext } = require('./authority');
    const events = approval.readApprovalEvents(path.join(layout.root, 'projects', 'workspace', 'events'), project.key);
    return approval.foldApprovals(events, { authority: authorityContext(layout.root, project.key, { now: Date.now() }) }).approvals;
  } catch (_) {
    return null;
  }
}

// 낡음만 신호다. 미승인은 아직 아무도 근거로 삼지 않은 "줄"이지 사건이 아니고, 승인 축을
// 쓰지 않는 프로젝트에서는 문서가 전건 미승인이라 그대로 태우면 신호가 문서 전건으로 찬다.
// board.js가 attention과 reviewQueue를 가른 선과 같은 선이며, 여기서 선을 다시 그으면
// 두 표면이 언젠가 다르게 답한다.
//
// 판정은 approval.js의 trustState가 한다. 리비전 비교 한 줄이라도 여기 다시 적으면
// rdl doc status와 감시가 같은 문서에 다른 답을 내는 날이 온다.
//
// 리비전은 스냅샷의 것을 쓴다. 여기서 문서를 다시 읽으면 그 값이 scanRevision이 결박한
// 스냅샷 밖에서 오고, 그러면 안정 판정을 지난 스캔이 스냅샷에 없는 리비전을 신호로 낸다.
function approvalDiagnostics(snapshot, histories) {
  if (!histories) return [];
  const { trustState } = require('./approval');
  const findings = [];
  for (const [id, revision] of snapshot.documents) {
    const state = trustState({ id, revision }, histories.get(id));
    if (state.status !== 'stale') continue;
    findings.push({
      artifactId: id,
      code: STALE_CODE,
      severity: 'warning',
      category: 'approval',
      message: `승인 후 개정 — 재승인이 필요합니다: ${id} (승인 ${state.approvedBy || '(미상)'} · 승인 리비전 ${String(state.approvedRevision || '').slice(0, 12)}). 차이: rdl doc diff ${id} --since-approval`
    });
  }
  return findings;
}

// 소견을 감시 레코드로 옮긴다. 받는 것이 검사 결과가 아니라 소견 목록인 이유는 이 자리에
// 검사 말고도 실려야 할 것이 생겼기 때문이다 — 승인 낡음은 checkWorkspace가 답하지 않는다.
function diagnosticsForScan(findings, snapshot, project, revision) {
  const inventory = { ...snapshot, project: project.key };
  const projectTargetRevision = digestJson({ documents: snapshot.documents, diagnosticSourceRevisions: snapshot.diagnosticSourceRevisions });
  return findings.filter((diagnostic) => !diagnostic.project || diagnostic.project === project.key).map((diagnostic) => {
    const responsible = responsibleRevision(diagnostic, inventory, projectTargetRevision || revision);
    const record = {
      targetId: String(responsible.targetId),
      targetRevision: responsible.targetRevision,
      code: String(diagnostic.code || 'RDL-WATCH-UNKNOWN'),
      severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
      category: String(diagnostic.category || 'unknown'),
      ...(diagnostic.file ? { file: String(diagnostic.file).replace(/\\/gu, '/') } : {}),
      ...(Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 ? { line: diagnostic.line } : {}),
      message: boundedMessage(diagnostic.message)
    };
    record.dedupKey = dedupKey(record.targetId, record.code, record.targetRevision);
    return record;
  }).sort((left, right) => left.dedupKey.localeCompare(right.dedupKey));
}

function writeNdjsonRecords(records, stream) {
  if (!records.length) return;
  const output = stream || process.stdout;
  const bytes = `${records.map((record) => canonicalJson(record)).join('\n')}\n`;
  return new Promise((resolve, reject) => {
    let callbackDone = false;
    let drainDone = true;
    let settled = false;
    const finish = () => {
      if (!settled && callbackDone && drainDone) { settled = true; output.removeListener('error', fail); resolve(); }
    };
    const fail = (error) => { if (!settled) { settled = true; output.removeListener('drain', drained); reject(error); } };
    const drained = () => { drainDone = true; finish(); };
    output.once('error', fail);
    const accepted = output.write(bytes, (error) => {
      if (error) { fail(error); return; }
      callbackDone = true;
      finish();
    });
    if (!accepted) {
      drainDone = false;
      output.once('drain', drained);
    }
  });
}

function defaultWriteRecords(records) {
  return writeNdjsonRecords(records, process.stdout);
}

function observeRemoteScope(scope, git) {
  const runner = git || runGit;
  const remote = scope.remote || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote)) throw new Error('Remote name is invalid.');
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(scope.ref || '') || scope.ref.includes('..') || scope.ref.includes('//') || /[/.]$/u.test(scope.ref)) throw new Error('Remote ref is invalid.');
  const tracking = `refs/remotes/${remote}/rundol-watch-${scope.scope}-${sha256(Buffer.from(scope.ref, 'utf8')).slice(0, 12)}`;
  const fetch = runner(['fetch', '--no-tags', '--no-write-fetch-head', remote, `+${scope.ref}:${tracking}`], { cwd: scope.root, allowFailure: true });
  if (fetch.status !== 0) throw new Error(`Remote ref is unavailable: ${scope.ref}`);
  const localTip = runner(['rev-parse', scope.localRef || 'HEAD'], { cwd: scope.root }).stdout;
  const remoteTip = runner(['rev-parse', tracking], { cwd: scope.root }).stdout;
  const counts = runner(['rev-list', '--left-right', '--count', `${localTip}...${remoteTip}`], { cwd: scope.root }).stdout.split(/\s+/u).map(Number);
  return remoteRelation(scope.scope, scope.ref, localTip, remoteTip, counts[0], counts[1]);
}

function defaultRemoteScopes(layout, project) {
  const workspaceRoot = path.join(layout.root, 'projects', 'workspace');
  return [
    { scope: 'project', root: project.root, remote: 'origin', ref: project.ref || `refs/heads/rundol/${project.key}`, localRef: 'HEAD' },
    { scope: 'workspace', root: fs.existsSync(workspaceRoot) ? workspaceRoot : layout.root, remote: 'origin', ref: 'refs/heads/rundol/workspace', localRef: 'HEAD' }
  ];
}

function createWatchSession(start, options, dependencies) {
  const settings = options || {};
  const deps = dependencies || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const file = cacheFile(project);
  let cache = loadCache(file, project.key);
  const state = { watchId: settings.watchId || `WATCH-${crypto.randomBytes(10).toString('hex').toUpperCase()}`, sequence: cache.sequenceBase };
  const writeRecords = deps.writeRecords || settings.write || defaultWriteRecords;
  const captureSnapshot = deps.inputSnapshot || defaultInputSnapshot;
  const checker = deps.checkWorkspace || checkWorkspace;
  const readApprovalHistories = deps.approvalHistories || defaultApprovalHistories;

  function recordsWithSequence(records) {
    let next = state.sequence;
    const sequenced = records.map((record) => validateWatchRecord({ schemaVersion: 1, ...record, watchId: state.watchId, sequence: ++next, project: project.key }));
    return { records: sequenced, sequence: next };
  }

  async function flush(records) {
    const sequenced = recordsWithSequence(records);
    await writeRecords(sequenced.records);
    state.sequence = sequenced.sequence;
    return sequenced.records;
  }

  async function scanOnce() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = validateInputSnapshot(captureSnapshot({ layout, project }));
      const revision = scanRevision(before);
      const result = await checker(layout.root, { project: project.key });
      // 원장 읽기는 안정 판정 창 안에 둔다. 승인 샤드는 스냅샷의 registeredEventShardHeads가
      // 덮으므로, 스캔 도중 승인이 들어오면 before와 after가 갈려 이 회차가 버려진다 —
      // 창 밖에서 읽으면 방금 승인된 문서를 낡음으로 울리고 그 신호가 리비전에 결박된 채 남는다.
      const histories = readApprovalHistories(layout, project);
      const after = validateInputSnapshot(captureSnapshot({ layout, project }));
      if (canonicalJson(before) !== canonicalJson(after)) continue;
      const diagnostics = diagnosticsForScan((result.diagnostics || []).concat(approvalDiagnostics(before, histories)), before, project, revision);
      const active = {};
      for (const diagnostic of diagnostics) active[diagnostic.dedupKey] = { targetId: diagnostic.targetId, targetRevision: diagnostic.targetRevision, code: diagnostic.code };
      const emitted = diagnostics.filter((diagnostic) => !Object.prototype.hasOwnProperty.call(cache.activeDiagnostics, diagnostic.dedupKey));
      const summary = {
        errors: diagnostics.filter((item) => item.severity === 'error').length,
        warnings: diagnostics.filter((item) => item.severity === 'warning').length,
        total: diagnostics.length
      };
      const records = [
        { type: 'watch.scan.started', scanId: revision, scanRevision: revision, head: before.head, gitStatusDigest: before.gitStatusDigest },
        ...emitted.map((diagnostic) => ({ type: 'watch.diagnostic', scanId: revision, scanRevision: revision, ...diagnostic })),
        { type: 'watch.scan.completed', scanId: revision, scanRevision: revision, head: before.head, gitStatusDigest: before.gitStatusDigest, activeDiagnosticKeys: Object.keys(active).sort(), summary }
      ];
      const output = await flush(records);
      cache = { ...cache, lastCompletedScanRevision: revision, activeDiagnostics: active, sequenceBase: state.sequence };
      atomicCache(file, cache);
      return { exitCode: 0, status: 'completed', attempt, scanRevision: revision, records: output, summary };
    }
    const output = await flush([{ type: 'watch.error', phase: 'scan', code: 'RDL-WATCH-UNSTABLE', message: 'Input changed during three consecutive scan attempts.', retryable: true }]);
    return { exitCode: 2, status: 'unstable', records: output };
  }

  async function observeRemote() {
    if (!settings.remote) return { records: [], skipped: true };
    const scopes = deps.remoteScopes || defaultRemoteScopes(layout, project);
    const records = [];
    for (const scope of scopes) {
      try {
        const relation = await (deps.observeRemoteScope || observeRemoteScope)(scope, deps.runGit);
        if (cache.remoteRelationKeys[scope.scope] === relation.relationKey) continue;
        const output = await flush([{ type: 'watch.remote.relation', ...relation }]);
        records.push(...output);
        cache = { ...cache, remoteRelationKeys: { ...cache.remoteRelationKeys, [scope.scope]: relation.relationKey }, sequenceBase: state.sequence };
        atomicCache(file, cache);
      } catch (error) {
        const output = await flush([{ type: 'watch.error', phase: `remote:${scope.scope}`, code: 'RDL-WATCH-REMOTE-REF', message: boundedMessage(error.message), retryable: true }]);
        records.push(...output);
      }
    }
    return { records, skipped: false };
  }

  return { layout, project, cacheFile: file, state, scanOnce, observeRemote, getCache: () => cache };
}

function acquireWatchLock(layout, project, deps) {
  if (deps && deps.acquireLock) return deps.acquireLock(layout, project);
  const runtime = require('./runtime');
  if (typeof runtime.acquireProcessLock !== 'function') throw new Error('Watch process lock support is unavailable.');
  return runtime.acquireProcessLock(runtimeWorkspace(layout.root), `watch-${project.key}`);
}

function releaseLock(lock) {
  if (typeof lock === 'function') lock();
  else if (lock && typeof lock.release === 'function') lock.release();
}

async function runContinuous(session, settings, deps) {
  const harness = loadHarnessSettings(session.layout.root, { project: session.project.key });
  const interval = harness.runtimeResolved.watch.scanIntervalSeconds * 1000;
  // remote 관찰은 자체 주기(remoteIntervalSeconds)를 따른다 — 설정만 검증하고
  // 적용하지 않으면 스캔 주기(기본 5초)마다 원격 fetch가 나간다. null이면
  // 스캔마다 관찰한다(기존 동작).
  const remoteIntervalMs = harness.runtimeResolved.watch.remoteIntervalSeconds ? harness.runtimeResolved.watch.remoteIntervalSeconds * 1000 : null;
  const currentInstant = deps.now || Date.now;
  let lastRemoteAt = null;
  const timers = { set: deps.setTimeout || setTimeout, clear: deps.clearTimeout || clearTimeout };
  const controller = settings.signal ? null : new AbortController();
  const signal = settings.signal || controller.signal;
  const interrupt = () => controller && controller.abort();
  if (controller) {
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
  }
  let wake = null;
  const watcherFactory = deps.watchFactory || ((root, callback) => fs.watch(root, callback));
  let watcher;
  try {
    watcher = watcherFactory(session.project.root, () => { if (wake) wake(); });
    while (!signal.aborted) {
      await session.scanOnce();
      if (!remoteIntervalMs || lastRemoteAt === null || currentInstant() - lastRemoteAt >= remoteIntervalMs) {
        await session.observeRemote();
        lastRemoteAt = currentInstant();
      }
      if (signal.aborted) break;
      await new Promise((resolve) => {
        let timer = timers.set(() => { wake = null; resolve(); }, interval);
        wake = () => {
          timers.clear(timer);
          timer = timers.set(() => { wake = null; resolve(); }, 50);
        };
        signal.addEventListener('abort', () => { timers.clear(timer); wake = null; resolve(); }, { once: true });
      });
    }
    return { exitCode: 0, status: 'stopped' };
  } finally {
    if (watcher && typeof watcher.close === 'function') watcher.close();
    if (controller) {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}

async function runWatch(start, options, dependencies) {
  const settings = options || {};
  const deps = dependencies || {};
  const session = createWatchSession(start, settings, deps);
  const lock = acquireWatchLock(session.layout, session.project, deps);
  try {
    if (settings.once) {
      const scan = await session.scanOnce();
      const remote = settings.remote ? await session.observeRemote() : { records: [], skipped: true };
      return { exitCode: scan.exitCode, status: scan.status, scanRevision: scan.scanRevision, summary: scan.summary, remoteRecords: remote.records.length };
    }
    return await runContinuous(session, settings, deps);
  } finally {
    releaseLock(lock);
  }
}

module.exports = {
  sha256,
  defaultInputSnapshot,
  validateInputSnapshot,
  scanRevision,
  dedupKey,
  relationKey,
  relationName,
  remoteRelation,
  validateWatchRecord,
  writeNdjsonRecords,
  emptyCache,
  loadCache,
  observeRemoteScope,
  createWatchSession,
  runWatch
};
