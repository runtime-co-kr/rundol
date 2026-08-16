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
const { getLens, pinInstruction } = require('./instruction-registry');
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
  exactObject(value, ['summary', 'location'], `findings[${index}]`);
  const result = { summary: text(value.summary, `findings[${index}].summary`, 1000, false) };
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
  exactObject(input, BASE_FIELDS.concat(['runId', 'ownerToken', 'operation', 'canonicalDigest', 'occurredAt']), 'verdict.recorded');
  if (input.schemaVersion !== 1 || input.type !== 'verdict.recorded' || !EVENT_ID.test(input.eventId || '') || !REQUEST_ID.test(input.rootRequestId || '') || !REQUEST_ID.test(input.requestId || '') || !CLIENT_ID.test(input.clientId || '') || !SIMPLE_ID.test(input.projectId || '') || !ARTIFACT_ID.test(input.targetId || '') || !REVISION.test(input.reviewedRevision || '') || !SIMPLE_ID.test(input.lens || '') || !VERDICTS.has(input.verdict) || !VALIDATOR_ID.test(input.validatorInstanceId || '')) throw new Error('verdict.recorded identity or enum is invalid');
  const result = {};
  for (const key of BASE_FIELDS) result[key] = input[key];
  result.findings = normalizeFindings(input.findings);
  result.adapter = normalizeAdapter(input.adapter);
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
  return eventStore.readEvents(verdictEventsRoot(layout), 'verdict', project.key, { sort: 'file' }).map(normalizeVerdictEvent).filter((event) => (!input.targetId || event.targetId === input.targetId) && (!input.runId || event.runId === input.runId));
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
  const source = policy.perLens && policy.perLens[lens] || policy.lensPolicies && policy.lensPolicies[lens] || {};
  const result = { validators: source.validators === undefined ? 1 : source.validators, quorum: source.quorum === undefined ? 1 : source.quorum, maxRefuted: source.maxRefuted === undefined ? 0 : source.maxRefuted, maxAbstain: source.maxAbstain === undefined ? 0 : source.maxAbstain, requireAdapterDiversity: source.requireAdapterDiversity === true };
  for (const key of ['validators', 'quorum', 'maxRefuted', 'maxAbstain']) if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'quorum' || key === 'validators' ? 1 : 0)) throw new Error(`${lens}.${key} is invalid`);
  if (result.quorum > result.validators || result.maxRefuted > result.validators || result.maxAbstain > result.validators) throw new Error(`${lens} policy exceeds validators`);
  return result;
}
function foldVerdicts(events, policy) {
  const requiredLenses = Array.from(new Set(policy.lenses || policy.requiredLenses || [])).sort();
  if (!REQUEST_ID.test(policy.rootRequestId || '') || !ARTIFACT_ID.test(policy.targetId || '') || !REVISION.test(policy.reviewedRevision || policy.currentRevision || '') || !requiredLenses.length || requiredLenses.some((lens) => !SIMPLE_ID.test(lens))) throw new Error('verdict policy identity is invalid');
  const revision = policy.reviewedRevision || policy.currentRevision; const allowed = policy.allowedAdapters ? new Set(policy.allowedAdapters) : null;
  const diagnostics = []; const accepted = [];
  for (const raw of events || []) {
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
    const diversity = new Set(unique.filter((event) => event.verdict === 'pass').map((event) => event.adapter.name)).size;
    let status = 'passed';
    if (counts.refuted > required.maxRefuted) status = 'refuted';
    else if (counts.abstain > required.maxAbstain || counts.valid < required.validators || counts.pass < required.quorum || (required.requireAdapterDiversity && diversity < required.quorum)) status = 'human_required';
    if (status === 'refuted') overall = 'refuted'; else if (status === 'human_required' && overall === 'passed') overall = 'human_required';
    for (const event of unique.filter((item) => item.verdict === 'refuted')) allFindings.push(...event.findings);
    lenses.push({ lens, status, counts, required });
  }
  return { status: overall, targetId: policy.targetId, reviewedRevision: revision, lenses, findings: normalizeFindings(allFindings), diagnostics };
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
  const layout = workspaceLayout(start); const project = selectProject(layout, input.project, true); const clientId = String(input.clientId || '').trim().toLowerCase();
  const client = getClient(start, clientId);
  if (client.status !== 'active' || !['agent', 'service'].includes(client.type) || !projectMember(project, client.owner)) throw new Error('verify client must be an active project-member agent/service');
  if (!ARTIFACT_ID.test(input.targetId || '')) throw new Error('invalid verification target ID');
  const artifact = projectArtifacts(project).find((item) => item.id === input.targetId); if (!artifact) throw new Error(`verification target not found: ${input.targetId}`);
  const observed = cleanSnapshot(project); let ownerToken; let step; let runEvents;
  if (input.runId) {
    const reconciled = ledger.reconcileRun(start, { project: project.key, runId: input.runId }); const ownership = ledger.ownershipState(reconciled.events); const fold = ledger.foldSharedRun(reconciled.events);
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
  const pinnedAdapter = step && (step.adapter || step.verify && step.verify.adapter); const adapterName = input.adapter || pinnedAdapter || settings.runtimeResolved.verify.defaultAdapter;
  if (!adapterName || (pinnedAdapter && input.adapter && input.adapter !== pinnedAdapter)) throw new Error('verification adapter is missing or differs from the pinned step');
  const adapterConfig = settings.runtimeResolved.adapters[adapterName]; if (!adapterConfig || adapterConfig.enabled !== true) throw new Error(`verification adapter is disabled or unknown: ${adapterName}`);
  const revisionPin = step && step.verify && step.verify.revisionPin;
  const reviewedRevision = input.runId ? revisionPin && revisionPin.strategy === 'git-commit' && revisionPin.reviewedRevision : observed.head;
  if (!REVISION.test(reviewedRevision || '')) throw new Error('run-bound verification is missing its procedure revision pin');
  if (observed.head !== reviewedRevision) throw new Error('project HEAD differs from the pinned verification revision');
  const rootRequestId = input.rootRequestId || ledger.newRequestId(); const policy = Object.assign({}, input.policy || {}, { rootRequestId, targetId: input.targetId, reviewedRevision, lenses, allowedAdapters: [adapterName] }, input.runId ? { runId: input.runId, ownerToken } : {});
  const commandDigest = verifyCommandDigest({ project: project.key, targetId: input.targetId, reviewedRevision, clientId, adapter: adapterName, lenses, runId: input.runId });
  let root = journal.prepareRoot(runtimeWorkspace(layout.root), { rootRequestId, commandDigest, clientId });
  const runner = input.runAdapterOnce || require('./adapter').runAdapterOnce; const recorded = [];
  for (const lens of lenses) {
    const required = lensPolicy(policy, lens);
    for (let slot = 1; slot <= required.validators; slot += 1) {
      const childKey = `verdict:${input.targetId}:${reviewedRevision}:${lens}:${slot}`;
      const existingChild = root.journal.children[childKey];
      if (existingChild) {
        const after = cleanSnapshot(project); if (after.head !== reviewedRevision) throw new Error('project HEAD differs from the pinned verification revision');
        assertVerificationGuard(start, project, { settingsHash: settings.contentHash, runId: input.runId, clientId, ownerToken });
        const canonical = JSON.parse(journal.decodeChild(existingChild, rootRequestId).toString('utf8'));
        const resumed = resumeVerdictJournalChild(start, { root, child: existingChild, canonical });
        if (root.journal.invocations && root.journal.invocations[childKey]) journal.updateInvocation(root, childKey, 'complete');
        recorded.push({ event: resumed.event, canonicalCommitted: true, projectionDegraded: false, rootRequestId, requestId: existingChild.requestId, eventId: existingChild.eventId });
        continue;
      }
      const validator = validatorInstanceId(rootRequestId, input.targetId, reviewedRevision, lens, slot);
      const lensEntry = getLens(lens);
      const pinnedInstruction = step && step.verify && step.verify.instructions && step.verify.instructions[lens] || pinInstruction(lensEntry.instructionId);
      const relativeTarget = path.relative(project.root, artifact.file).replace(/\\/gu, '/');
      const expectedAdapter = { name: adapterName, instructionId: pinnedInstruction.id, instructionRevision: pinnedInstruction.revision, instructionDigest: pinnedInstruction.instructionDigest };
      const descriptor = invocationDescriptor({
        childKey, invocationId: invocationId(validator), validatorInstanceId: validator, lens, slot, targetPath: relativeTarget,
        instruction: pinnedInstruction, adapter: expectedAdapter,
        command: Object.assign({ project: project.key, targetId: input.targetId, reviewedRevision, clientId, adapter: adapterName, lenses }, input.runId ? { runId: input.runId, stepId: step.id } : {})
      });
      let invocation = journal.prepareInvocation(root, { invocationKey: childKey, descriptor });
      let outcome;
      if (invocation.phase === 'terminal') throw new Error(`verification invocation is terminal: ${invocation.failureCode || childKey}`);
      if (invocation.phase === 'running' && pidAlive(invocation.pid)) { const error = new Error(`verification invocation is still live: ${descriptor.invocationId}`); error.code = 'invocation-live'; throw error; }
      if (invocation.phase !== 'prepared') {
        try {
          const existing = consumeInvocationResult(project, descriptor);
          if (existing.state === 'result') {
            outcome = { exitCode: 0, status: 'success', result: existing.result, adapter: existing.adapter };
            journal.updateInvocation(root, childKey, 'result-ready');
          } else if (existing.state === 'retryable-empty' || existing.state === 'absent') {
            if (invocation.phase === 'result-ready') throw new Error('result-ready invocation has no valid result');
            if (existing.state === 'retryable-empty') fs.rmSync(existing.directory, { recursive: true, force: false });
          }
        } catch (error) {
          journal.updateInvocation(root, childKey, 'terminal', { failureCode: 'invalid-existing-result' });
          throw error;
        }
      }
      if (!outcome) {
        journal.updateInvocation(root, childKey, 'running', { pid: process.pid });
        try {
          outcome = await runner({ projectRoot: project.root, projectId: project.key, mode: 'verify', adapter: Object.assign({ name: adapterName }, adapterConfig), instruction: pinnedInstruction, targetPath: relativeTarget, allowedContextPaths: [relativeTarget], pin: { targetId: input.targetId, reviewedRevision }, instanceId: descriptor.invocationId, validatorInstanceId: validator, rootRequestId, runId: input.runId, stepId: step && step.id, lensId: lens }, {
            onSpawn(pid) { journal.updateInvocation(root, childKey, 'running', { pid }); }
          });
        } catch (error) {
          journal.updateInvocation(root, childKey, 'terminal', { failureCode: 'adapter-threw' });
          throw error;
        }
        if (!outcome || outcome.exitCode !== 0 || !outcome.result) {
          journal.updateInvocation(root, childKey, 'terminal', { failureCode: outcome && outcome.status || 'invalid-result' });
          const error = new Error(`adapter verification failed: ${outcome && outcome.status || 'invalid-result'}`); error.code = 'adapter-failed'; throw error;
        }
        journal.updateInvocation(root, childKey, 'result-ready');
      }
      const after = cleanSnapshot(project); if (after.head !== reviewedRevision) throw new Error('verifier changed project HEAD');
      assertVerificationGuard(start, project, { settingsHash: settings.contentHash, runId: input.runId, clientId, ownerToken });
      const event = { verdict: outcome.result.verdict, findings: outcome.result.findings, adapter: outcome.adapter };
      if (input.runId) { event.runId = input.runId; event.ownerToken = ownerToken; }
      recorded.push(recordVerdict(start, { project: project.key, rootRequestId, commandDigest, clientId, targetId: input.targetId, reviewedRevision, lens, validatorSlot: slot, event }));
      root = journal.loadJournal(runtimeWorkspace(layout.root), rootRequestId);
      journal.updateInvocation(root, childKey, 'complete');
    }
  }
  const fold = foldVerdicts(readVerdicts(start, { project: project.key, targetId: input.targetId, runId: input.runId }), policy);
  return { exitCode: fold.status === 'passed' ? 0 : 1, status: fold.status, targetId: input.targetId, reviewedRevision, rootRequestId, commandDigest, verdicts: recorded.map((item) => item.event), fold };
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
