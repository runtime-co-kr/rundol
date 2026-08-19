'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { projectArtifacts } = require('./document-contract');
const { getClient } = require('./collaboration-store');
const { runtimeWorkspace } = require('./runtime');
const { runGit } = require('./git');
const { loadHarnessSettings } = require('./harness-settings');
const { getLens, pinInstruction, LENS_APPROACHES } = require('./instruction-registry');
const eventStore = require('./event-store');
const ledger = require('./run-ledger');
const journal = require('./request-journal');

const ARTIFACT_ID = /^[A-Z]{3}-\d{3,}$/u;
const SIMPLE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const CLIENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RUN_ID = /^RUN-[A-F0-9]{20}$/u;
const REQUEST_ID = /^REQ-[A-F0-9]{20}$/u;
const EVENT_ID = /^EVT-[A-F0-9]{20}$/u;
const VALIDATOR_ID = /^VAL-[A-F0-9]{20}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const VERDICTS = new Set(['pass', 'refuted', 'abstain']);
const BASE_FIELDS = ['schemaVersion', 'eventId', 'type', 'rootRequestId', 'requestId', 'clientId', 'projectId', 'targetId', 'reviewedRevision', 'lens', 'verdict', 'findings', 'adapter', 'validatorInstanceId'];

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error(`${label} has unknown fields: ${extra.sort().join(', ')}`);
}
function text(value, label, maximum, singleLine) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  let result = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(result)) throw new Error(`${label} contains control characters`);
  if (singleLine) result = result.replace(/\s*\n\s*/gu, ' ');
  if (!result || result.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters`);
  return result;
}
function relativeFile(value, label) {
  const normalized = text(value, label, 2048, true).replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized) || normalized.split('/').includes('..')) throw new Error(`${label} must be a project-relative path`);
  return normalized;
}
function normalizeFinding(value, index) {
  exactObject(value, ['summary', 'location', 'reproduce'], `findings[${index}]`);
  const result = { summary: text(value.summary, `findings[${index}].summary`, 1000, false) };
  // 발견을 확인하려면 판정자가 무엇을 했는지 알아야 한다. 요약만 있으면 읽는 사람은
  // 그 판정을 믿거나 처음부터 다시 조사하는 두 길밖에 없다.
  if (value.reproduce !== undefined) result.reproduce = text(value.reproduce, `findings[${index}].reproduce`, 1000, false);
  if (value.location !== undefined) {
    exactObject(value.location, ['file', 'heading', 'blockId'], `findings[${index}].location`);
    const location = { file: relativeFile(value.location.file, `findings[${index}].location.file`) };
    if (value.location.heading !== undefined) location.heading = text(value.location.heading, `findings[${index}].location.heading`, 200, true);
    if (value.location.blockId !== undefined) location.blockId = text(value.location.blockId, `findings[${index}].location.blockId`, 200, true);
    result.location = location;
  }
  return result;
}
function normalizeFindings(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('findings must be an array of at most 100 items');
  const findings = value.map(normalizeFinding).sort((a, b) => {
    const left = a.location || {}; const right = b.location || {};
    return String(left.file || '').localeCompare(String(right.file || '')) || String(left.heading || '').localeCompare(String(right.heading || '')) || String(left.blockId || '').localeCompare(String(right.blockId || '')) || a.summary.localeCompare(b.summary);
  });
  if (new Set(findings.map((item) => eventStore.canonicalJson(item))).size !== findings.length) throw new Error('findings must be unique');
  return findings;
}
function normalizeAdapter(value) {
  exactObject(value, ['name', 'instructionId', 'instructionRevision', 'instructionDigest'], 'adapter');
  if (!SIMPLE_ID.test(value.name || '') || !SIMPLE_ID.test(value.instructionId || '') || !Number.isSafeInteger(value.instructionRevision) || value.instructionRevision < 1 || !DIGEST.test(value.instructionDigest || '')) throw new Error('adapter metadata is invalid');
  return { name: value.name, instructionId: value.instructionId, instructionRevision: value.instructionRevision, instructionDigest: value.instructionDigest };
}
function normalizeOperation(value) {
  exactObject(value, ['operationId', 'logicalAttempt', 'outcomeKind', 'outcomeDigest', 'boundedResultDecision'], 'operation');
  if (!DIGEST.test(value.operationId || '') || !DIGEST.test(value.outcomeDigest || '') || !Number.isSafeInteger(value.logicalAttempt) || value.logicalAttempt < 1 || !['verification-passed', 'verification-refuted', 'verification-abstained'].includes(value.outcomeKind)) throw new Error('verification operation is invalid');
  return { operationId: value.operationId, logicalAttempt: value.logicalAttempt, outcomeKind: value.outcomeKind, outcomeDigest: value.outcomeDigest, boundedResultDecision: value.boundedResultDecision };
}
function normalizeVerdictEvent(input) {
  exactObject(input, BASE_FIELDS.concat(['approach', 'runId', 'ownerToken', 'operation', 'canonicalDigest', 'occurredAt']), 'verdict.recorded');
  if (input.schemaVersion !== 1 || input.type !== 'verdict.recorded' || !EVENT_ID.test(input.eventId || '') || !REQUEST_ID.test(input.rootRequestId || '') || !REQUEST_ID.test(input.requestId || '') || !CLIENT_ID.test(input.clientId || '') || !SIMPLE_ID.test(input.projectId || '') || !ARTIFACT_ID.test(input.targetId || '') || !REVISION.test(input.reviewedRevision || '') || !SIMPLE_ID.test(input.lens || '') || !VERDICTS.has(input.verdict) || !VALIDATOR_ID.test(input.validatorInstanceId || '')) throw new Error('verdict.recorded identity or enum is invalid');
  const result = {};
  for (const key of BASE_FIELDS) result[key] = input[key];
  result.findings = normalizeFindings(input.findings);
  result.adapter = normalizeAdapter(input.adapter);
  // 선택 필드다. 필수로 두면 이 판 이전에 기록된 판정이 전부 무효가 된다.
  if (input.approach !== undefined) {
    if (!LENS_APPROACHES.includes(input.approach)) throw new Error(`verdict approach is invalid: ${input.approach}`);
    result.approach = input.approach;
  }
  const runBound = input.runId !== undefined || input.ownerToken !== undefined;
  if (runBound) {
    if (!RUN_ID.test(input.runId || '') || !EVENT_ID.test(input.ownerToken || '')) throw new Error('run-bound verdict requires runId and ownerToken');
    result.runId = input.runId; result.ownerToken = input.ownerToken;
  }
  if (input.operation !== undefined) {
    if (!runBound) throw new Error('standalone verdict cannot contain operation');
    result.operation = normalizeOperation(input.operation);
  }
  return result;
}
function verdictEnvelope(input) {
  const canonical = normalizeVerdictEvent(input);
  const canonicalDigest = sha256(Buffer.from(eventStore.canonicalJson(canonical), 'utf8'));
  return { canonical, shared: Object.assign({}, canonical, { canonicalDigest }, input.occurredAt ? { occurredAt: input.occurredAt } : {}), canonicalDigest, canonicalBytes: Buffer.from(eventStore.canonicalJson(canonical), 'utf8') };
}
function verdictEventsRoot(layout) { return path.join(layout.root, 'projects', 'workspace', 'events'); }
function readVerdicts(start, input) {
  const layout = workspaceLayout(start); const project = selectProject(layout, input.project, true);
  if (layout.schemaVersion < 6) return [];
  // 원시 레코드를 돌려준다 — 검증·dedup·충돌 진단은 foldVerdicts의 관용 경로가
  // 단일 정의로 수행한다 (RDL-VERDICT-001/004). 읽기에서 던지면 손상 하나가
  // 전체 verdict 경로를 오염시킨다.
  return eventStore.readEvents(verdictEventsRoot(layout), 'verdict', project.key, { sort: 'file', dedupe: false }).filter((event) => event && (!input.targetId || event.targetId === input.targetId) && (!input.runId || event.runId === input.runId));
}
function verifyCommandDigest(input) {
  const normalized = { command: 'verify', projectId: input.project, targetId: input.targetId, reviewedRevision: input.reviewedRevision, clientId: input.clientId, adapter: input.adapter, lenses: Array.from(new Set(input.lenses || [])).sort() };
  if (input.runId) normalized.runId = input.runId;
  return sha256(Buffer.from(eventStore.canonicalJson(normalized), 'utf8'));
}
function validatorInstanceId(rootRequestId, targetId, reviewedRevision, lens, slot) {
  return `VAL-${sha256(Buffer.from(`validator\0${rootRequestId}\0${targetId}\0${reviewedRevision}\0${lens}\0${slot}`, 'utf8')).slice(0, 20).toUpperCase()}`;
}
function invocationId(validatorId) {
  if (!VALIDATOR_ID.test(validatorId || '')) throw new Error('invalid validator instance ID');
  return `INV-${sha256(Buffer.from(`invocation\0${validatorId}`, 'utf8')).slice(0, 20).toUpperCase()}`;
}
function invocationDirectory(project, descriptor) {
  return descriptor.command.runId
    ? path.join(project.root, '.rundol', 'runs', descriptor.command.runId, 'steps', descriptor.command.stepId, 'invocations', descriptor.invocationId)
    : path.join(project.root, '.rundol', 'verify', descriptor.invocationId);
}
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readRegularJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invocation component is not a regular file: ${path.basename(file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function validateExistingManifests(directory, descriptor) {
  const allowed = new Set(['instruction.json', 'context.json', 'result.json', 'receipt.json']);
  const entries = fs.readdirSync(directory).sort();
  if (entries.some((entry) => !allowed.has(entry))) throw new Error('invocation directory contains an unknown component');
  const instructionFile = path.join(directory, 'instruction.json');
  const contextFile = path.join(directory, 'context.json');
  if (fs.existsSync(instructionFile)) {
    const instruction = readRegularJson(instructionFile);
    if (instruction.id !== descriptor.instruction.id || instruction.revision !== descriptor.instruction.revision || instruction.instructionDigest !== descriptor.instruction.instructionDigest) throw new Error('existing invocation instruction manifest drift');
  }
  if (fs.existsSync(contextFile)) {
    const context = readRegularJson(contextFile);
    if (context.target !== descriptor.targetPath || context.lensId !== descriptor.lens || !context.pin || context.pin.targetId !== descriptor.command.targetId || context.pin.reviewedRevision !== descriptor.command.reviewedRevision || context.instructionId !== descriptor.instruction.id) throw new Error('existing invocation context manifest drift');
  }
  return { entries, instructionFile, contextFile, resultFile: path.join(directory, 'result.json'), receiptFile: path.join(directory, 'receipt.json') };
}
function consumeInvocationResult(project, descriptor) {
  const directory = invocationDirectory(project, descriptor);
  if (!fs.existsSync(directory)) return { state: 'absent', directory };
  const files = validateExistingManifests(directory, descriptor);
  const hasResult = fs.existsSync(files.resultFile); const hasReceipt = fs.existsSync(files.receiptFile);
  if (!hasReceipt && !hasResult) return { state: 'retryable-empty', directory };
  if (hasResult && !hasReceipt) {
    const resultBytes = fs.readFileSync(files.resultFile);
    const result = require('./adapter').validateResult('verify', resultBytes.toString('utf8'), project.root);
    return { state: 'result', directory, result, adapter: descriptor.adapter };
  }
  if (!hasResult) throw new Error('existing invocation has a partial result and is terminal');
  const receipt = readRegularJson(files.receiptFile);
  exactObject(receipt, ['schemaVersion', 'instanceId', 'adapter', 'manifestHashes', 'exitCategory', 'resultHash'], 'adapter receipt');
  if (receipt.schemaVersion !== 1 || receipt.instanceId !== descriptor.invocationId || receipt.exitCategory !== 'success') throw new Error('existing invocation receipt is not a successful compatible receipt');
  const expectedAdapter = descriptor.adapter;
  if (eventStore.canonicalJson(receipt.adapter) !== eventStore.canonicalJson(expectedAdapter)) throw new Error('existing invocation adapter receipt drift');
  const instructionBytes = fs.readFileSync(files.instructionFile); const contextBytes = fs.readFileSync(files.contextFile); const resultBytes = fs.readFileSync(files.resultFile);
  if (!receipt.manifestHashes || receipt.manifestHashes.instruction !== sha256(instructionBytes) || receipt.manifestHashes.context !== sha256(contextBytes) || receipt.resultHash !== sha256(resultBytes)) throw new Error('existing invocation receipt hash mismatch');
  const result = require('./adapter').validateResult('verify', resultBytes.toString('utf8'), project.root);
  return { state: 'result', directory, result, adapter: receipt.adapter };
}
function invocationDescriptor(input) {
  const descriptor = {
    schemaVersion: 1,
    invocationKey: input.childKey,
    invocationId: input.invocationId,
    validatorInstanceId: input.validatorInstanceId,
    lens: input.lens,
    slot: input.slot,
    targetPath: input.targetPath,
    instruction: input.instruction,
    adapter: input.adapter,
    command: input.command
  };
  return descriptor;
}
function recordVerdict(start, input) {
  const layout = workspaceLayout(start); const project = selectProject(layout, input.project, true);
  if (layout.schemaVersion < 6) throw new Error('verdict storage requires workspace schemaVersion 6');
  const childKey = `verdict:${input.targetId}:${input.reviewedRevision}:${input.lens}:${input.validatorSlot}`;
  const requestId = journal.childRequestId(input.rootRequestId, childKey); const eventId = journal.eventIdForRequest(requestId);
  const envelope = verdictEnvelope(Object.assign({}, input.event, { schemaVersion: 1, eventId, type: 'verdict.recorded', rootRequestId: input.rootRequestId, requestId, clientId: input.clientId, projectId: project.key, targetId: input.targetId, reviewedRevision: input.reviewedRevision, lens: input.lens, validatorInstanceId: validatorInstanceId(input.rootRequestId, input.targetId, input.reviewedRevision, input.lens, input.validatorSlot) }));
  const runtime = runtimeWorkspace(layout.root); const root = journal.prepareRoot(runtime, { rootRequestId: input.rootRequestId, commandDigest: input.commandDigest, clientId: input.clientId });
  const child = journal.prepareChild(root, { childKey, canonicalBytes: envelope.canonicalBytes, occurredAt: input.event.occurredAt });
  if (child.phase === 'complete') {
    const existing = readVerdicts(start, { project: project.key, targetId: input.targetId }).find((event) => event.eventId === child.eventId);
    if (!existing || verdictEnvelope(existing).canonicalDigest !== child.canonicalDigest) throw new Error(`completed verdict child is missing its canonical event: ${childKey}`);
    return { event: existing, canonicalCommitted: true, projectionDegraded: false, rootRequestId: input.rootRequestId, requestId: child.requestId, eventId: child.eventId };
  }
  const file = eventStore.appendEvent(verdictEventsRoot(layout), 'verdict', project.key, input.clientId, envelope.shared, { lockDirectory: runtime.locks, fsync: true });
  journal.updateChild(root, childKey, 'canonical-committed'); journal.updateChild(root, childKey, 'complete');
  void file;
  return { event: envelope.canonical, canonicalCommitted: true, projectionDegraded: false, rootRequestId: input.rootRequestId, requestId: child.requestId, eventId: child.eventId };
}

function resumeVerdictJournalChild(start, input) {
  const canonical = normalizeVerdictEvent(input.canonical);
  const layout = workspaceLayout(start); const project = selectProject(layout, canonical.projectId, true);
  const child = input.child; const digest = verdictEnvelope(canonical).canonicalDigest;
  if (canonical.rootRequestId !== input.root.journal.rootRequestId || canonical.requestId !== child.requestId || canonical.eventId !== child.eventId || digest !== child.canonicalDigest) throw new Error(`verdict request journal identity mismatch: ${child.childKey}`);
  const shared = readVerdicts(start, { project: project.key, targetId: canonical.targetId });
  const committed = shared.find((event) => event.eventId === canonical.eventId);
  if (committed && verdictEnvelope(committed).canonicalDigest !== child.canonicalDigest) throw new Error(`verdict event corruption: ${canonical.eventId}`);
  if (child.phase === 'canonical-committed' && !committed) throw new Error(`canonical-committed verdict is missing from shared storage: ${child.childKey}`);
  if (!committed) {
    eventStore.appendEvent(verdictEventsRoot(layout), 'verdict', project.key, canonical.clientId, Object.assign({}, canonical, { canonicalDigest: child.canonicalDigest }, child.occurredAt ? { occurredAt: child.occurredAt } : {}), { lockDirectory: runtimeWorkspace(layout.root).locks, fsync: true });
    journal.updateChild(input.root, child.childKey, 'canonical-committed');
  }
  journal.updateChild(input.root, child.childKey, 'complete');
  return { event: canonical, status: committed ? 'verdict-projection-repaired' : 'verdict-canonical-replayed' };
}
function lensPolicy(policy, lens) {
  // perLens가 없으면 최상위 flat 값이 모든 lens에 적용된다 — 절차 pin의
  // policy는 flat 형태(BUILTIN 참조)이므로 이 폴백이 그 유일한 소비 지점이다.
  const source = policy.perLens && policy.perLens[lens] || policy.lensPolicies && policy.lensPolicies[lens]
    || { validators: policy.validators, quorum: policy.quorum, maxRefuted: policy.maxRefuted, maxAbstain: policy.maxAbstain, requireAdapterDiversity: policy.requireAdapterDiversity };
  const result = { validators: source.validators === undefined ? 1 : source.validators, quorum: source.quorum === undefined ? 1 : source.quorum, maxRefuted: source.maxRefuted === undefined ? 0 : source.maxRefuted, maxAbstain: source.maxAbstain === undefined ? 0 : source.maxAbstain, requireAdapterDiversity: source.requireAdapterDiversity === true };
  for (const key of ['validators', 'quorum', 'maxRefuted', 'maxAbstain']) if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'quorum' || key === 'validators' ? 1 : 0)) throw new Error(`${lens}.${key} is invalid`);
  if (result.quorum > result.validators || result.maxRefuted > result.validators || result.maxAbstain > result.validators) throw new Error(`${lens} policy exceeds validators`);
  return result;
}
function foldVerdicts(events, policy) {
  const requiredLenses = Array.from(new Set(policy.lenses || policy.requiredLenses || [])).sort();
  if (!REQUEST_ID.test(policy.rootRequestId || '') || !ARTIFACT_ID.test(policy.targetId || '') || !REVISION.test(policy.reviewedRevision || policy.currentRevision || '') || !requiredLenses.length || requiredLenses.some((lens) => !SIMPLE_ID.test(lens))) throw new Error('verdict policy identity is invalid');
  const revision = policy.reviewedRevision || policy.currentRevision; const allowed = policy.allowedAdapters ? new Set(policy.allowedAdapters) : null;
  // run 결박 정책은 ownerToken 없이는 성립하지 않는다 — 조용한 전량 필터로
  // human_required로 강등되는 대신 명시적 오류다.
  if (policy.runId && !policy.ownerToken) throw new Error('run-bound verdict fold requires the run ownerToken');
  const diagnostics = []; const accepted = [];
  // eventId 충돌은 예외가 아니라 진단이다: 같은 eventId의 상충 변형은 전부 제외하고
  // RDL-VERDICT-004로 남긴다. 정확 중복은 하나로 접는다.
  const byEventId = new Map(); const conflicted = new Set(); const anonymous = [];
  for (const raw of events || []) {
    const key = raw && raw.eventId;
    if (!key) { anonymous.push(raw); continue; }
    const previous = byEventId.get(key);
    if (!previous) { byEventId.set(key, raw); continue; }
    const same = (previous.canonicalDigest && raw.canonicalDigest)
      ? previous.canonicalDigest === raw.canonicalDigest
      : eventStore.canonicalJson(previous) === eventStore.canonicalJson(raw);
    if (!same && !conflicted.has(key)) { conflicted.add(key); diagnostics.push({ code: 'RDL-VERDICT-004', eventId: key, message: 'verdict eventId has conflicting canonical projections' }); }
  }
  const deduplicated = anonymous.concat(Array.from(byEventId.entries()).filter(([key]) => !conflicted.has(key)).map(([, value]) => value));
  for (const raw of deduplicated) {
    let event; try { event = normalizeVerdictEvent(raw); } catch (error) { diagnostics.push({ code: 'RDL-VERDICT-001', message: error.message }); continue; }
    if (event.rootRequestId !== policy.rootRequestId || event.targetId !== policy.targetId || event.reviewedRevision !== revision || !requiredLenses.includes(event.lens) || (allowed && !allowed.has(event.adapter.name)) || (policy.runId && (event.runId !== policy.runId || event.ownerToken !== policy.ownerToken))) continue;
    accepted.push(event);
  }
  const lenses = []; const allFindings = []; let overall = 'passed';
  for (const lens of requiredLenses) {
    const required = lensPolicy(policy, lens);
    const officialInstances = new Set(Array.from({ length: required.validators }, (_, index) => validatorInstanceId(policy.rootRequestId, policy.targetId, revision, lens, index + 1)));
    const candidates = accepted.filter((event) => event.lens === lens && (() => {
      if (officialInstances.has(event.validatorInstanceId)) return true;
      diagnostics.push({ code: 'RDL-VERDICT-003', lens, validatorInstanceId: event.validatorInstanceId, message: 'unrecognized validator slot excluded' });
      return false;
    })());
    const byInstance = new Map();
    for (const event of candidates) {
      const list = byInstance.get(event.validatorInstanceId) || []; list.push(event); byInstance.set(event.validatorInstanceId, list);
    }
    const unique = [];
    for (const [instanceId, list] of byInstance) {
      if (list.length !== 1) { diagnostics.push({ code: 'RDL-VERDICT-002', lens, validatorInstanceId: instanceId, message: 'duplicate validator instance excluded' }); continue; }
      unique.push(list[0]);
    }
    const counts = { pass: unique.filter((event) => event.verdict === 'pass').length, refuted: unique.filter((event) => event.verdict === 'refuted').length, abstain: unique.filter((event) => event.verdict === 'abstain').length, valid: unique.length };
    // 다양성은 통과 판정을 낸 어댑터 이름의 가짓수다. 반박과 기권은 기여하지 않는다 —
    // 통과를 뒷받침하는 근거의 폭을 세는 값이기 때문이다. 한 어댑터를 여러 번 불러
    // 부풀릴 수 없는 것은 중복 validator 인스턴스가 이미 위에서 제외되기 때문이다.
    const diversity = new Set(unique.filter((event) => event.verdict === 'pass').map((event) => event.adapter.name)).size;
    // 판정자가 실행되지 못한 것과 실행되어 할 말이 없던 것은 다른 값이다. 앞은
    // undispatched이고 뒤는 abstain이다. 둘을 한 값으로 접으면 "확인 못 함"이
    // "이상 없음"과 같은 자리에 들어간다.
    const descriptor = lensDescriptor(lens);
    let status = 'passed';
    if (!counts.valid && descriptor.required === false) status = 'undispatched';
    else if (counts.refuted > required.maxRefuted) status = 'refuted';
    else if (counts.abstain > required.maxAbstain || counts.valid < required.validators || counts.pass < required.quorum || (required.requireAdapterDiversity && diversity < required.quorum)) status = 'human_required';
    // 선택 렌즈의 미실행은 검증을 미완으로 만들지 않는다. 다만 결과에서 사라지지도
    // 않는다 — 보고 없이 지나가면 그 렌즈는 켜 둔 적도 없는 것이 된다.
    if (status === 'refuted') overall = 'refuted'; else if (status === 'human_required' && overall === 'passed') overall = 'human_required';
    for (const event of unique.filter((item) => item.verdict === 'refuted')) allFindings.push(...event.findings);
    lenses.push({ lens, status, counts, required, diversity, approach: descriptor.approach, lensRequired: descriptor.required });
  }
  return { status: overall, targetId: policy.targetId, reviewedRevision: revision, lenses, findings: normalizeFindings(allFindings), diagnostics };
}
// 등록되지 않은 렌즈 이름으로도 집계는 돌아야 한다. 정책이 부르는 이름과 registry가
// 아는 이름이 어긋났다고 집계 전체가 멈추면, 이름 하나 때문에 이미 나온 판정을 읽지
// 못한다. 모르는 렌즈는 필수로 본다 — 모르는 것을 선택으로 접으면 조용히 건너뛴다.
function lensDescriptor(lens) {
  try { const entry = getLens(lens); return { approach: entry.approach, required: entry.required }; }
  catch (_) { return { approach: null, required: true }; }
}

// 어댑터는 하나로도 목록으로도 고정된다. 두 형태를 부르는 쪽마다 풀면 어느 쪽이
// 정본인지가 자리마다 달라진다.
function adapterList(value) {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : [value];
  const names = list.map((item) => String(item || '').trim()).filter(Boolean);
  if (!names.length) return null;
  if (new Set(names).size !== names.length) throw new Error('verification adapters must be unique');
  return names;
}

// slot에서 어댑터로 가는 배분은 순수 함수다. 무작위로 고르면 재개했을 때 다른
// 어댑터가 뽑히고, 그 순간 invocation 계약이 깨진다 — 같은 slot이 다른 판정자의
// 결과를 재사용하게 된다.
function adapterForSlot(names, slot) {
  return names[(slot - 1) % names.length];
}

// 만족될 수 없는 정책은 선언 시점에 거부한다. 런타임에 실패로 나타나게 두면
// 오설정과 정상 판정이 같은 얼굴을 한다 — 다양성을 켰는데 어댑터가 하나뿐이면
// 결과가 계속 "사람 판단 필요"로 나오고, 켠 사람은 그것이 판정인지 설정 실수인지
// 알 수 없다.
function assertPolicySatisfiable(policy, lenses, adaptersFor, label) {
  for (const lens of lenses) {
    const required = lensPolicy(policy, lens);
    if (!required.requireAdapterDiversity) continue;
    const names = adaptersFor(lens) || [];
    if (names.length < required.quorum) {
      throw new Error(`${label}: ${lens}의 requireAdapterDiversity는 quorum(${required.quorum}) 이상의 어댑터를 요구하는데 ${names.length}개만 고정되어 있습니다.`);
    }
    if (required.validators < required.quorum) {
      throw new Error(`${label}: ${lens}의 validators(${required.validators})가 quorum(${required.quorum})보다 적어 다양성을 만족시킬 수 없습니다.`);
    }
  }
}

// 상한이 있는 동시 실행. 실패를 모아서 받는 이유는, 하나가 실패했다고 나머지를
// 중단하면 이미 끝난 판정까지 버려지고 다음 시도가 처음부터 다시 부르기 때문이다.
// 성공한 판정은 이미 원장에 남았으므로, 다음 실행은 실패한 것만 다시 부른다.
//
// 그래도 마지막에는 던진다. 일부가 실패한 검증은 미완이고, 미완을 통과로 접으면
// "확인 못 함"과 "이상 없음"이 같은 값이 된다.
async function runBounded(items, limit, task) {
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next; next += 1;
      try { await task(items[index], index); }
      catch (error) { failures.push({ index, error }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
  if (!failures.length) return;
  // 가장 앞선 호출의 실패를 대표로 던진다. 실행 순서가 달라져도 같은 실패가 보고되어야
  // 호출자가 재시도 판단을 동시성에 흔들리지 않고 내릴 수 있다.
  failures.sort((left, right) => left.index - right.index);
  throw failures[0].error;
}
function projectMember(project, memberId) { return fs.existsSync(project.charter) && new RegExp(`\\^${memberId}(?:\\s|$)`, 'mu').test(fs.readFileSync(project.charter, 'utf8')); }
function cleanSnapshot(project) {
  const head = runGit(['rev-parse', 'HEAD'], { cwd: project.root }).stdout.toLowerCase();
  if (!REVISION.test(head)) throw new Error('project HEAD is not a supported Git revision');
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: project.root }).stdout;
  if (status) { const error = new Error(`verification requires a clean worktree: ${status.split(/\r?\n/u).slice(0, 20).join(', ')}`); error.code = 'dirty-worktree'; throw error; }
  return { head, status };
}
function assertVerificationGuard(start, project, input) {
  const settings = loadHarnessSettings(start, { project: project.key });
  if (settings.contentHash !== input.settingsHash) { const error = new Error('settings-drift'); error.code = 'settings-drift'; throw error; }
  if (!input.runId) return settings;
  const reconciled = ledger.reconcileRun(start, { project: project.key, runId: input.runId });
  const ownership = ledger.ownershipState(reconciled.events);
  if (ownership.status !== 'ACTIVE' || ownership.ownerClientId !== input.clientId || ownership.ownerToken !== input.ownerToken) throw new Error('run ownership changed during verification');
  const started = reconciled.events.find((event) => event.type === 'run.started');
  if (!started || !started.settings || started.settings.contentHash !== settings.contentHash) { const error = new Error('settings-drift'); error.code = 'settings-drift'; throw error; }
  return settings;
}
async function verifyArtifact(start, input) {
  // 검증도 외부 어댑터 프로세스를 띄운다. drive의 adapter·cli만 막고 verify를
  // 통과시키면 같은 위험이 다른 이름으로 지나간다.
  require('./adapter').assertTerminationGuaranteed('rdl verify');
  const layout = workspaceLayout(start); const project = selectProject(layout, input.project, true); const clientId = String(input.clientId || '').trim().toLowerCase();
  const client = getClient(start, clientId);
  if (client.status !== 'active' || !['agent', 'service'].includes(client.type) || !projectMember(project, client.owner)) throw new Error('verify client must be an active project-member agent/service');
  if (!ARTIFACT_ID.test(input.targetId || '')) throw new Error('invalid verification target ID');
  const artifact = projectArtifacts(project).find((item) => item.id === input.targetId); if (!artifact) throw new Error(`verification target not found: ${input.targetId}`);
  const observed = cleanSnapshot(project); let ownerToken; let step; let runEvents; let runFold = null;
  if (input.runId) {
    const reconciled = ledger.reconcileRun(start, { project: project.key, runId: input.runId }); const ownership = ledger.ownershipState(reconciled.events); const fold = runFold = ledger.foldSharedRun(reconciled.events);
    if (ownership.status !== 'ACTIVE' || ownership.ownerClientId !== clientId) throw new Error('run-bound verify requires the active owner');
    if (!fold.cursorStep || !(fold.cursorStep.verify || fold.cursorStep.lenses)) throw new Error('run cursor is not a verification step');
    const target = fold.artifactIds[fold.artifactIds.length - 1]; if (!target || target !== input.targetId) throw new Error('run-bound verification target must equal the latest pinned artifact');
    ownerToken = ownership.ownerToken; step = fold.cursorStep; runEvents = reconciled.events;
  }
  const settings = loadHarnessSettings(start, { project: project.key });
  if (runEvents) {
    const started = runEvents.find((event) => event.type === 'run.started'); if (!started || !started.settings || started.settings.contentHash !== settings.contentHash) { const error = new Error('settings-drift'); error.code = 'settings-drift'; throw error; }
  }
  const pinnedLenses = step ? (step.lenses || step.verify && step.verify.lenses || []) : null;
  const lenses = Array.from(new Set((input.lenses && input.lenses.length ? input.lenses : pinnedLenses && pinnedLenses.length ? pinnedLenses : settings.runtimeResolved.verify.defaultLenses))).sort();
  if (!lenses.length || lenses.some((lens) => !SIMPLE_ID.test(lens))) throw new Error('at least one valid lens is required');
  if (pinnedLenses && input.lenses && eventStore.canonicalJson(lenses) !== eventStore.canonicalJson(Array.from(new Set(pinnedLenses)).sort())) throw new Error('run-bound lenses must match the pinned procedure step');
  // 검증 스텝은 어댑터를 하나가 아니라 목록으로 고정할 수 있다. 하나만 쓰면 판정이
  // 아무리 여러 번 나와도 같은 판정자의 같은 편향을 여러 번 세는 것이고, 다양성은
  // 셀 수 없다.
  const pinnedAdapters = adapterList(step && step.verify && step.verify.adapters) || adapterList(step && (step.adapter || step.verify && step.verify.adapter));
  const requestedAdapters = adapterList(input.adapters) || adapterList(input.adapter);
  const adapterNames = requestedAdapters || pinnedAdapters || adapterList(settings.runtimeResolved.verify.defaultAdapter);
  if (!adapterNames || !adapterNames.length) throw new Error('verification adapter is missing or differs from the pinned step');
  if (pinnedAdapters && requestedAdapters && eventStore.canonicalJson(requestedAdapters) !== eventStore.canonicalJson(pinnedAdapters)) throw new Error('verification adapter is missing or differs from the pinned step');
  const adapterConfigs = new Map();
  for (const name of adapterNames) {
    const config = settings.runtimeResolved.adapters[name];
    if (config && config.enabled === true) adapterConfigs.set(name, config);
  }
  // 렌즈마다 다른 판정자를 쓸 수 있다. 재현 렌즈는 스크립트 실행기가, 누락 렌즈는
  // 읽는 판정자가 답한다 — 하나의 목록으로 묶으면 둘 중 하나는 자기가 할 수 없는
  // 물음을 받는다.
  const lensAdapterOverrides = (step && step.verify && step.verify.lensAdapters) || input.lensAdapters || {};
  const usableAdapters = new Map();
  const undispatched = [];
  for (const lens of lenses) {
    const declared = adapterList(lensAdapterOverrides[lens]) || adapterNames;
    for (const name of declared) {
      if (adapterConfigs.has(name)) continue;
      const config = settings.runtimeResolved.adapters[name];
      if (config && config.enabled === true) adapterConfigs.set(name, config);
    }
    const usable = declared.filter((name) => adapterConfigs.has(name));
    // 필수 렌즈가 실행되지 못하면 검증은 완료되지 않는다. 선택 렌즈는 완료하되
    // 미실행으로 보고한다 — 보고 없이 지나가면 켜 둔 적도 없는 것이 된다.
    if (!usable.length) {
      if (lensDescriptor(lens).required !== false) throw new Error(`verification adapter is disabled or unknown: ${declared.join(', ')}`);
      undispatched.push(lens);
      continue;
    }
    usableAdapters.set(lens, usable);
  }
  const adapterName = adapterNames[0];
  const revisionPin = step && step.verify && step.verify.revisionPin;
  // 판정 대상은 원장이 정한다. step-output-commit은 "지목된 스텝이 만들었다고
  // 원장에 기록된 커밋"으로 풀린다 — 주변의 현재 HEAD가 아니다. 그래야 저장과
  // 검증 사이에 다른 프로세스가 커밋해도 저작 결과가 아닌 것이 판정되지 않는다.
  // 아래의 observed.head 일치 검사가 그 창을 실패로 바꾼다.
  const stepOutput = revisionPin && revisionPin.strategy === 'step-output-commit';
  const reviewedRevision = !input.runId
    ? observed.head
    : stepOutput
      ? (runFold && runFold.stepCommits && runFold.stepCommits[revisionPin.step]) || null
      : revisionPin && revisionPin.strategy === 'git-commit' && revisionPin.reviewedRevision;
  if (!REVISION.test(reviewedRevision || '')) throw new Error('run-bound verification is missing its procedure revision pin');
  if (observed.head !== reviewedRevision) throw new Error('project HEAD differs from the pinned verification revision');
  // 절차가 pin한 quorum·validator·diversity policy는 lenses·instructions·adapter와
  // 같은 지위다 — 병합하지 않으면 pin이 사문이 되어 기본값으로 검증된다.
  const pinnedPolicy = step && step.verify && step.verify.policy || null;
  if (pinnedPolicy && input.policy && eventStore.canonicalJson(input.policy) !== eventStore.canonicalJson(pinnedPolicy)) throw new Error('run-bound verification policy must match the pinned procedure step');
  const rootRequestId = input.rootRequestId || ledger.newRequestId(); const policy = Object.assign({}, pinnedPolicy || input.policy || {}, { rootRequestId, targetId: input.targetId, reviewedRevision, lenses, allowedAdapters: adapterNames.slice() }, input.runId ? { runId: input.runId, ownerToken } : {});
  // 허용 집합은 고정된 목록 전체다. 하나로 좁히면 다른 어댑터가 낸 판정이 집계에서
  // 조용히 버려지고, 다양성은 영원히 1이 된다.
  assertPolicySatisfiable(policy, Array.from(usableAdapters.keys()), (lens) => usableAdapters.get(lens), '검증 정책');
  const commandDigest = verifyCommandDigest({ project: project.key, targetId: input.targetId, reviewedRevision, clientId, adapter: adapterNames.length === 1 ? adapterName : adapterNames.slice(), lenses, runId: input.runId });
  let root = journal.prepareRoot(runtimeWorkspace(layout.root), { rootRequestId, commandDigest, clientId });
  const runner = input.runAdapterOnce || require('./adapter').runAdapterOnce; const recorded = [];
  // 판정 호출은 서로의 결과를 읽지 않는다. 순차로 짜여 있던 것은 설계가 아니라 루프
  // 하나였고, 그 루프 때문에 판정자를 늘릴 때마다 시간이 선형으로 늘었다 — 독립성을
  // 얻는 대가로 속도를 잃으면, 느려진 통제는 결국 꺼진다.
  //
  // 원장 접근이 안전한 이유는 락이 아니라 이 함수 몸통에 await가 하나뿐이기 때문이다.
  // 어댑터 호출 말고는 전부 동기이므로 다른 호출이 그 사이를 비집고 들어올 수 없다.
  // 대신 root는 재할당되므로 살아 있는 값을 함수로 읽는다 — 낡은 객체에 쓰면 그
  // 사이에 기록된 판정을 지운다.
  const currentRoot = () => root;
  const work = [];
  for (const lens of lenses) {
    if (!usableAdapters.has(lens)) continue;
    const required = lensPolicy(policy, lens);
    for (let slot = 1; slot <= required.validators; slot += 1) work.push({ lens, slot });
  }
  async function runSlot({ lens, slot }) {
      const childKey = `verdict:${input.targetId}:${reviewedRevision}:${lens}:${slot}`;
      const existingChild = currentRoot().journal.children[childKey];
      if (existingChild) {
        const after = cleanSnapshot(project); if (after.head !== reviewedRevision) throw new Error('project HEAD differs from the pinned verification revision');
        assertVerificationGuard(start, project, { settingsHash: settings.contentHash, runId: input.runId, clientId, ownerToken });
        const canonical = JSON.parse(journal.decodeChild(existingChild, rootRequestId).toString('utf8'));
        const resumed = resumeVerdictJournalChild(start, { root: currentRoot(), child: existingChild, canonical });
        if (currentRoot().journal.invocations && currentRoot().journal.invocations[childKey]) journal.updateInvocation(currentRoot(), childKey, 'complete');
        recorded.push({ lens, slot, event: resumed.event, canonicalCommitted: true, projectionDegraded: false, rootRequestId, requestId: existingChild.requestId, eventId: existingChild.eventId });
        return;
      }
      const validator = validatorInstanceId(rootRequestId, input.targetId, reviewedRevision, lens, slot);
      const lensEntry = getLens(lens);
      const slotAdapter = adapterForSlot(usableAdapters.get(lens), slot);
      const slotAdapterConfig = adapterConfigs.get(slotAdapter);
      const pinnedInstruction = step && step.verify && step.verify.instructions && step.verify.instructions[lens] || pinInstruction(lensEntry.instructionId);
      const relativeTarget = path.relative(project.root, artifact.file).replace(/\\/gu, '/');
      const expectedAdapter = { name: slotAdapter, instructionId: pinnedInstruction.id, instructionRevision: pinnedInstruction.revision, instructionDigest: pinnedInstruction.instructionDigest };
      const descriptor = invocationDescriptor({
        childKey, invocationId: invocationId(validator), validatorInstanceId: validator, lens, slot, targetPath: relativeTarget,
        instruction: pinnedInstruction, adapter: expectedAdapter,
        command: Object.assign({ project: project.key, targetId: input.targetId, reviewedRevision, clientId, adapter: slotAdapter, lenses }, input.runId ? { runId: input.runId, stepId: step.id } : {})
      });
      let invocation = journal.prepareInvocation(currentRoot(), { invocationKey: childKey, descriptor });
      let outcome;
      if (invocation.phase === 'terminal') throw new Error(`verification invocation is terminal: ${invocation.failureCode || childKey}`);
      if (invocation.phase === 'running' && pidAlive(invocation.pid)) { const error = new Error(`verification invocation is still live: ${descriptor.invocationId}`); error.code = 'invocation-live'; throw error; }
      if (invocation.phase !== 'prepared') {
        try {
          const existing = consumeInvocationResult(project, descriptor);
          if (existing.state === 'result') {
            outcome = { exitCode: 0, status: 'success', result: existing.result, adapter: existing.adapter };
            journal.updateInvocation(currentRoot(), childKey, 'result-ready');
          } else if (existing.state === 'retryable-empty' || existing.state === 'absent') {
            if (invocation.phase === 'result-ready') throw new Error('result-ready invocation has no valid result');
            if (existing.state === 'retryable-empty') fs.rmSync(existing.directory, { recursive: true, force: false });
          }
        } catch (error) {
          journal.updateInvocation(currentRoot(), childKey, 'terminal', { failureCode: 'invalid-existing-result' });
          throw error;
        }
      }
      if (!outcome) {
        journal.updateInvocation(currentRoot(), childKey, 'running', { pid: process.pid });
        try {
          outcome = await runner({ projectRoot: project.root, projectId: project.key, mode: 'verify', adapter: Object.assign({ name: slotAdapter }, slotAdapterConfig), instruction: pinnedInstruction, targetPath: relativeTarget, allowedContextPaths: [relativeTarget], pin: { targetId: input.targetId, reviewedRevision }, instanceId: descriptor.invocationId, validatorInstanceId: validator, rootRequestId, runId: input.runId, stepId: step && step.id, lensId: lens }, {
            onSpawn(pid) { journal.updateInvocation(currentRoot(), childKey, 'running', { pid }); }
          });
        } catch (error) {
          journal.updateInvocation(currentRoot(), childKey, 'terminal', { failureCode: 'adapter-threw' });
          throw error;
        }
        if (!outcome || outcome.exitCode !== 0 || !outcome.result) {
          journal.updateInvocation(currentRoot(), childKey, 'terminal', { failureCode: outcome && outcome.status || 'invalid-result' });
          const error = new Error(`adapter verification failed: ${outcome && outcome.status || 'invalid-result'}`); error.code = 'adapter-failed'; throw error;
        }
        journal.updateInvocation(currentRoot(), childKey, 'result-ready');
      }
      const after = cleanSnapshot(project); if (after.head !== reviewedRevision) throw new Error('verifier changed project HEAD');
      assertVerificationGuard(start, project, { settingsHash: settings.contentHash, runId: input.runId, clientId, ownerToken });
      const event = { verdict: outcome.result.verdict, findings: outcome.result.findings, adapter: outcome.adapter, approach: lensEntry.approach };
      if (input.runId) { event.runId = input.runId; event.ownerToken = ownerToken; }
      recorded.push(Object.assign({ lens, slot }, recordVerdict(start, { project: project.key, rootRequestId, commandDigest, clientId, targetId: input.targetId, reviewedRevision, lens, validatorSlot: slot, event })));
      root = journal.loadJournal(runtimeWorkspace(layout.root), rootRequestId);
      journal.updateInvocation(currentRoot(), childKey, 'complete');
  }
  await runBounded(work, Math.max(1, settings.runtimeResolved.verify.maxConcurrency || 1), runSlot);
  // 완료 순서는 동시 실행에서 비결정적이다. 같은 입력에 같은 출력을 내려면 여기서
  // 다시 세운다 — 판정 내용은 원장이 정하지만, 돌려주는 목록의 순서도 결과다.
  recorded.sort((left, right) => String(left.lens).localeCompare(String(right.lens)) || left.slot - right.slot);
  const fold = foldVerdicts(readVerdicts(start, { project: project.key, targetId: input.targetId, runId: input.runId }), policy);
  return { exitCode: fold.status === 'passed' ? 0 : 1, status: fold.status, targetId: input.targetId, reviewedRevision, rootRequestId, commandDigest, adapters: adapterNames.slice(), undispatchedLenses: undispatched.slice(), verdicts: recorded.map((item) => item.event), fold };
}

async function resumeVerificationRequest(start, loaded) {
  const invocations = Object.values(loaded.journal.invocations || {}).sort((left, right) => left.invocationKey.localeCompare(right.invocationKey));
  if (!invocations.length) throw new Error('verification request has no resumable invocation descriptor');
  const descriptors = invocations.map((entry) => journal.decodeInvocation(entry, loaded.journal.rootRequestId));
  const command = descriptors[0].command;
  for (const descriptor of descriptors) {
    if (eventStore.canonicalJson(descriptor.command) !== eventStore.canonicalJson(command)) throw new Error('verification request invocation commands disagree');
  }
  if (command.clientId !== loaded.journal.clientId) throw new Error('verification request client identity mismatch');
  return verifyArtifact(start, {
    project: command.project,
    targetId: command.targetId,
    clientId: command.clientId,
    adapter: command.adapter,
    lenses: command.lenses,
    runId: command.runId,
    rootRequestId: loaded.journal.rootRequestId
  });
}

module.exports = { normalizeFinding, normalizeFindings, normalizeVerdictEvent, verdictEnvelope, validatorInstanceId, invocationId, verifyCommandDigest, recordVerdict, resumeVerdictJournalChild, resumeVerificationRequest, readVerdicts, foldVerdicts, invocationDescriptor, consumeInvocationResult, pidAlive, verifyArtifact };
