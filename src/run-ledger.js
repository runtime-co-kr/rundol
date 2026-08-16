'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { saveSettings } = require('./settings');
const { runtimeWorkspace } = require('./runtime');
const { getClient } = require('./collaboration-store');
const eventStore = require('./event-store');
const requestJournal = require('./request-journal');

const RUN_ID = /^RUN-[A-F0-9]{20}$/u;
const EVENT_ID = /^EVT-[A-F0-9]{20}$/u;
const REQUEST_ID = /^REQ-[A-F0-9]{20}$/u;
const SIMPLE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const STEP_ID = /^[a-z][a-z0-9-]*$/u;
const MEMBER_ID = /^MEMBER-\d{3}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
const CHECKPOINT_TYPES = new Set(['run.started', 'run.halted', 'run.resumed', 'run.completed_local', 'run.synced', 'run.takeover', 'run.ownership_resolved']);
const HALT_REASONS = new Set(['gate-failed', 'merge-conflict', 'sync-failed', 'adapter-timeout', 'lease-lost', 'attempt-limit', 'manual', 'settings-drift', 'ownership-conflict', 'operation-conflict', 'legacy-conflict', 'verification-required']);
const TYPE_FIELDS = {
  'run.started': { required: ['ownerToken', 'procedure', 'settings'], optional: ['goal'] },
  'run.step': { required: ['ownerToken', 'stepId', 'executor', 'exitCode', 'artifactIds'], optional: ['operation'] },
  'run.gate': { required: ['ownerToken', 'stepId', 'command', 'args', 'exitCode', 'diagnostics', 'attempt'], optional: ['operation'] },
  'run.forced': { required: ['ownerToken', 'stepId', 'reason'], optional: ['operation'] },
  'run.halted': { required: ['reason', 'resumable'], optional: ['ownerToken', 'atStep', 'operation'] },
  'run.resumed': { required: ['ownerToken', 'fromStep'], optional: [] },
  'run.takeover': { required: ['ownerToken', 'previousClientId', 'previousOwnerToken', 'previousOwnerHeadEventId', 'basis'], optional: ['reason'] },
  'run.ownership_resolved': { required: ['conflictId', 'candidates', 'selectedDecisionEventId', 'selectedOwnerToken', 'resolverMemberId', 'reason', 'forced'], optional: [] },
  'run.operation_resolved': { required: ['ownerToken', 'operationId', 'conflictId', 'candidates', 'selectedDecisionEventId', 'selectedOutcomeDigest', 'resolverMemberId', 'reason', 'forced'], optional: [] },
  'run.completed_local': { required: ['ownerToken', 'commit', 'artifactIds'], optional: [] },
  'run.synced': { required: ['ownerToken', 'commit', 'remoteRef'], optional: [] }
};
const BASE_FIELDS = ['schemaVersion', 'eventId', 'type', 'rootRequestId', 'requestId', 'clientId', 'projectId', 'runId'];
const OUTCOME_KINDS = new Set(['step-completed', 'gate-passed', 'gate-failed', 'verification-passed', 'verification-refuted', 'verification-abstained', 'forced', 'step-failed']);

function canonicalJson(value) {
  return eventStore.canonicalJson(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function newRunId() {
  return `RUN-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

function newRequestId() {
  return `REQ-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

function deterministicRunId(rootRequestId) {
  if (!REQUEST_ID.test(rootRequestId || '')) throw new Error(`invalid rootRequestId: ${rootRequestId || '(missing)'}`);
  return `RUN-${sha256(Buffer.from(`run-start\0${rootRequestId}`, 'utf8')).slice(0, 20).toUpperCase()}`;
}

function runsRoot(projectRoot) {
  return path.join(projectRoot, '.rundol', 'runs');
}

function runDirectory(projectRoot, runId) {
  if (!RUN_ID.test(runId || '')) throw new Error(`invalid run ID: ${runId || '(missing)'}`);
  return path.join(runsRoot(projectRoot), runId);
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function assertExactKeys(value, allowed, name) {
  assertObject(value, name);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${name} has unknown fields: ${extras.sort().join(', ')}`);
}

function normalizeText(value, name, max, singleLine) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  let normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) throw new Error(`${name} contains control characters`);
  if (singleLine) normalized = normalized.replace(/\s*\n\s*/gu, ' ');
  if (normalized.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return normalized;
}

function normalizeStringArray(value, name, sorted) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be an array of strings`);
  const normalized = value.map((item, index) => normalizeText(item, `${name}[${index}]`, 2048, true));
  return sorted ? Array.from(new Set(normalized)).sort() : normalized;
}

function normalizeCandidates(value) {
  if (!Array.isArray(value) || value.length < 2) throw new Error('candidates must contain at least two entries');
  const normalized = value.map((candidate, index) => {
    assertExactKeys(candidate, ['decisionEventId', 'selectedOwnerToken'], `candidates[${index}]`);
    if (!EVENT_ID.test(candidate.decisionEventId || '') || !EVENT_ID.test(candidate.selectedOwnerToken || '')) throw new Error('candidate IDs are invalid');
    return { decisionEventId: candidate.decisionEventId, selectedOwnerToken: candidate.selectedOwnerToken };
  }).sort((a, b) => a.decisionEventId.localeCompare(b.decisionEventId) || a.selectedOwnerToken.localeCompare(b.selectedOwnerToken));
  const keys = normalized.map((item) => `${item.decisionEventId}\0${item.selectedOwnerToken}`);
  if (new Set(keys).size !== keys.length) throw new Error('candidates must be unique');
  return normalized;
}

function normalizeOperationCandidates(value) {
  if (!Array.isArray(value) || value.length < 2) throw new Error('operation candidates must contain at least two entries');
  const normalized = value.map((candidate, index) => {
    assertExactKeys(candidate, ['decisionEventId', 'selectedOutcomeDigest'], `operation candidates[${index}]`);
    if (!EVENT_ID.test(candidate.decisionEventId || '') || !DIGEST.test(candidate.selectedOutcomeDigest || '')) throw new Error('operation candidate identity is invalid');
    return { decisionEventId: candidate.decisionEventId, selectedOutcomeDigest: candidate.selectedOutcomeDigest };
  }).sort((left, right) => left.decisionEventId.localeCompare(right.decisionEventId) || left.selectedOutcomeDigest.localeCompare(right.selectedOutcomeDigest));
  if (new Set(normalized.map((item) => `${item.decisionEventId}\0${item.selectedOutcomeDigest}`)).size !== normalized.length) throw new Error('operation candidates must be unique');
  return normalized;
}

function normalizeOperation(value) {
  assertExactKeys(value, ['operationId', 'logicalAttempt', 'outcomeKind', 'outcomeDigest', 'boundedResultDecision'], 'operation');
  if (!DIGEST.test(value.operationId || '') || !DIGEST.test(value.outcomeDigest || '')) throw new Error('operation digests must be lowercase SHA-256');
  if (!Number.isSafeInteger(value.logicalAttempt) || value.logicalAttempt < 1) throw new Error('operation.logicalAttempt must be a positive safe integer');
  if (!OUTCOME_KINDS.has(value.outcomeKind)) throw new Error('operation.outcomeKind is invalid');
  return {
    operationId: value.operationId,
    logicalAttempt: value.logicalAttempt,
    outcomeKind: normalizeText(value.outcomeKind, 'operation.outcomeKind', 100, true),
    outcomeDigest: value.outcomeDigest,
    boundedResultDecision: value.boundedResultDecision
  };
}

function normalizeOperationDecision(kind, value) {
  assertObject(value, 'boundedResultDecision');
  const exact = (keys) => {
    const actual = Object.keys(value).sort();
    if (canonicalJson(actual) !== canonicalJson(keys.slice().sort())) throw new Error(`boundedResultDecision is invalid for ${kind}`);
  };
  if (kind === 'step-completed') {
    exact(['artifactIds']);
    return { artifactIds: normalizeStringArray(value.artifactIds, 'boundedResultDecision.artifactIds', true) };
  }
  if (['gate-passed', 'gate-failed'].includes(kind)) {
    exact(['diagnostics']);
    return { diagnostics: normalizeStringArray(value.diagnostics, 'boundedResultDecision.diagnostics', true) };
  }
  if (['verification-passed', 'verification-abstained'].includes(kind)) {
    exact(['verdictSetDigest']);
    if (!DIGEST.test(value.verdictSetDigest || '')) throw new Error('verdictSetDigest is invalid');
    return { verdictSetDigest: value.verdictSetDigest };
  }
  if (kind === 'verification-refuted') {
    exact(['verdictSetDigest', 'findingsDigest']);
    if (!DIGEST.test(value.verdictSetDigest || '') || !DIGEST.test(value.findingsDigest || '')) throw new Error('verification digests are invalid');
    return { verdictSetDigest: value.verdictSetDigest, findingsDigest: value.findingsDigest };
  }
  if (kind === 'forced') {
    exact(['reasonDigest']);
    if (!DIGEST.test(value.reasonDigest || '')) throw new Error('reasonDigest is invalid');
    return { reasonDigest: value.reasonDigest };
  }
  exact(['failureCode']);
  const failureCode = normalizeText(value.failureCode, 'failureCode', 100, true);
  if (!/^[A-Z][A-Z0-9_-]*$/u.test(failureCode)) throw new Error('failureCode is invalid');
  return { failureCode };
}

function operationIdFor(input) {
  if (!input || !RUN_ID.test(input.runId || '') || !DIGEST.test(input.procedureContentHash || '') || !STEP_ID.test(input.stepId || '') || !Number.isSafeInteger(input.logicalAttempt) || input.logicalAttempt < 1) throw new Error('operation identity input is invalid');
  return sha256(Buffer.concat([Buffer.from('rundol.operation-id.v1\0', 'utf8'), Buffer.from(canonicalJson([input.runId, input.procedureContentHash, input.stepId, input.logicalAttempt]), 'utf8')]));
}

function outcomeDigestFor(input) {
  if (!input || !DIGEST.test(input.operationId || '') || !STEP_ID.test(input.stepId || '') || !Number.isSafeInteger(input.logicalAttempt) || input.logicalAttempt < 1 || !OUTCOME_KINDS.has(input.outcomeKind) || !Number.isSafeInteger(input.exitCode) || input.exitCode < 0) throw new Error('operation outcome input is invalid');
  const normalized = {
    operationId: input.operationId,
    stepId: input.stepId,
    logicalAttempt: input.logicalAttempt,
    outcomeKind: input.outcomeKind,
    exitCode: input.exitCode,
    sortedArtifactIds: normalizeStringArray(input.sortedArtifactIds || [], 'sortedArtifactIds', true),
    sortedDiagnosticCodes: normalizeStringArray(input.sortedDiagnosticCodes || [], 'sortedDiagnosticCodes', true),
    boundedResultDecision: normalizeOperationDecision(input.outcomeKind, input.boundedResultDecision)
  };
  return sha256(Buffer.from(canonicalJson(normalized), 'utf8'));
}

function createOperation(input) {
  const operationId = input.operationId || operationIdFor(input);
  const boundedResultDecision = normalizeOperationDecision(input.outcomeKind, input.boundedResultDecision);
  return {
    operationId,
    logicalAttempt: input.logicalAttempt,
    outcomeKind: input.outcomeKind,
    outcomeDigest: outcomeDigestFor({ ...input, operationId, boundedResultDecision }),
    boundedResultDecision
  };
}

function validateEventOperation(event) {
  if (!event.operation) return;
  const stepId = event.stepId || event.atStep;
  if (!stepId) throw new Error('operation event requires a step identity');
  const artifactIds = event.artifactIds || [];
  const diagnostics = event.diagnostics || [];
  const expected = outcomeDigestFor({
    operationId: event.operation.operationId,
    stepId,
    logicalAttempt: event.operation.logicalAttempt,
    outcomeKind: event.operation.outcomeKind,
    exitCode: event.exitCode === undefined ? (event.type === 'run.forced' ? 0 : 1) : event.exitCode,
    sortedArtifactIds: artifactIds,
    sortedDiagnosticCodes: diagnostics,
    boundedResultDecision: event.operation.boundedResultDecision
  });
  if (expected !== event.operation.outcomeDigest) throw new Error('operation.outcomeDigest mismatch');
}

function normalizeProcedure(value) {
  assertExactKeys(value, ['name', 'revision', 'schemaVersion', 'contentHash', 'resolved'], 'procedure');
  if (!SIMPLE_ID.test(value.name || '') || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 || !DIGEST.test(value.contentHash || '')) {
    throw new Error('procedure pin is invalid');
  }
  assertObject(value.resolved, 'procedure.resolved');
  return { name: value.name, revision: value.revision, schemaVersion: value.schemaVersion, contentHash: value.contentHash, resolved: value.resolved };
}

function normalizeSettings(value) {
  assertExactKeys(value, ['schemaVersion', 'contentHash', 'workspaceRevision', 'projectRevision', 'safeResolved'], 'settings');
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 || !DIGEST.test(value.contentHash || '')) throw new Error('settings pin is invalid');
  assertObject(value.safeResolved, 'settings.safeResolved');
  const result = { schemaVersion: value.schemaVersion, contentHash: value.contentHash };
  if (value.workspaceRevision !== undefined) {
    if (!Number.isSafeInteger(value.workspaceRevision) || value.workspaceRevision < 1) throw new Error('settings.workspaceRevision is invalid');
    result.workspaceRevision = value.workspaceRevision;
  }
  if (value.projectRevision !== undefined) {
    if (!Number.isSafeInteger(value.projectRevision) || value.projectRevision < 1) throw new Error('settings.projectRevision is invalid');
    result.projectRevision = value.projectRevision;
  }
  result.safeResolved = value.safeResolved;
  return result;
}

function normalizeRunEvent(event) {
  assertObject(event, 'run event');
  if (event.schemaVersion !== 2) throw new Error('canonical run events require schemaVersion 2');
  const definition = TYPE_FIELDS[event.type];
  if (!definition) throw new Error(`unknown canonical run event type: ${event.type || '(missing)'}`);
  const allowed = BASE_FIELDS.concat(definition.required, definition.optional, ['canonicalDigest', 'occurredAt', 'localDetail']);
  assertExactKeys(event, allowed, event.type);
  for (const field of BASE_FIELDS.concat(definition.required)) if (event[field] === undefined) throw new Error(`${event.type}.${field} is required`);
  if (!EVENT_ID.test(event.eventId || '') || !REQUEST_ID.test(event.rootRequestId || '') || !REQUEST_ID.test(event.requestId || '') || !SIMPLE_ID.test(event.clientId || '') || !SIMPLE_ID.test(event.projectId || '') || !RUN_ID.test(event.runId || '')) throw new Error(`${event.type} contains an invalid identity`);
  const normalized = {};
  for (const field of BASE_FIELDS) normalized[field] = event[field];
  const owner = () => {
    if (!EVENT_ID.test(event.ownerToken || '')) throw new Error(`${event.type}.ownerToken is invalid`);
    return event.ownerToken;
  };
  if (event.type === 'run.started') {
    if (owner() !== event.eventId) throw new Error('run.started ownerToken must equal eventId');
    normalized.ownerToken = event.ownerToken;
    if (event.goal !== undefined) normalized.goal = normalizeText(event.goal, 'goal', 500, false);
    normalized.procedure = normalizeProcedure(event.procedure);
    normalized.settings = normalizeSettings(event.settings);
  } else if (event.type === 'run.step') {
    normalized.ownerToken = owner();
    if (!STEP_ID.test(event.stepId || '') || !['cli', 'adapter', 'client'].includes(event.executor) || !Number.isSafeInteger(event.exitCode) || event.exitCode < 0) throw new Error('run.step fields are invalid');
    normalized.stepId = event.stepId; normalized.executor = event.executor; normalized.exitCode = event.exitCode;
    normalized.artifactIds = normalizeStringArray(event.artifactIds, 'artifactIds', true);
    if (event.operation !== undefined) normalized.operation = normalizeOperation(event.operation);
  } else if (event.type === 'run.gate') {
    normalized.ownerToken = owner();
    if (!STEP_ID.test(event.stepId || '') || !SIMPLE_ID.test(event.command || '') || !Number.isSafeInteger(event.exitCode) || event.exitCode < 0 || !Number.isSafeInteger(event.attempt) || event.attempt < 1) throw new Error('run.gate fields are invalid');
    normalized.stepId = event.stepId; normalized.command = event.command; normalized.args = normalizeStringArray(event.args, 'args', false); normalized.exitCode = event.exitCode;
    normalized.diagnostics = normalizeStringArray(event.diagnostics, 'diagnostics', true); normalized.attempt = event.attempt;
    if (event.operation !== undefined) normalized.operation = normalizeOperation(event.operation);
  } else if (event.type === 'run.forced') {
    normalized.ownerToken = owner();
    if (!STEP_ID.test(event.stepId || '')) throw new Error('run.forced.stepId is invalid');
    normalized.stepId = event.stepId; normalized.reason = normalizeText(event.reason, 'reason', 1000, false);
    if (!normalized.reason) throw new Error('run.forced.reason is required');
    if (event.operation !== undefined) normalized.operation = normalizeOperation(event.operation);
  } else if (event.type === 'run.halted') {
    if (event.ownerToken !== undefined) normalized.ownerToken = owner();
    normalized.reason = normalizeText(event.reason, 'reason', 1000, true);
    if (!normalized.reason || typeof event.resumable !== 'boolean') throw new Error('run.halted fields are invalid');
    if (event.atStep !== undefined) {
      if (!STEP_ID.test(event.atStep || '')) throw new Error('run.halted.atStep is invalid');
      normalized.atStep = event.atStep;
    }
    normalized.resumable = event.resumable;
    if (event.operation !== undefined) normalized.operation = normalizeOperation(event.operation);
  } else if (event.type === 'run.resumed') {
    normalized.ownerToken = owner();
    if (!STEP_ID.test(event.fromStep || '')) throw new Error('run.resumed.fromStep is invalid');
    normalized.fromStep = event.fromStep;
  } else if (event.type === 'run.takeover') {
    if (owner() !== event.eventId || !SIMPLE_ID.test(event.previousClientId || '') || !EVENT_ID.test(event.previousOwnerToken || '') || !EVENT_ID.test(event.previousOwnerHeadEventId || '') || !['halted', 'forced'].includes(event.basis)) throw new Error('run.takeover fields are invalid');
    normalized.ownerToken = event.ownerToken; normalized.previousClientId = event.previousClientId; normalized.previousOwnerToken = event.previousOwnerToken; normalized.previousOwnerHeadEventId = event.previousOwnerHeadEventId; normalized.basis = event.basis;
    if (event.reason !== undefined) {
      normalized.reason = normalizeText(event.reason, 'reason', 1000, false);
      if (!normalized.reason) throw new Error('run.takeover.reason cannot be empty');
    }
    if (event.basis === 'forced' && !normalized.reason) throw new Error('forced takeover requires reason');
  } else if (event.type === 'run.ownership_resolved') {
    if (!DIGEST.test(event.conflictId || '') || !EVENT_ID.test(event.selectedDecisionEventId || '') || !EVENT_ID.test(event.selectedOwnerToken || '') || !MEMBER_ID.test(event.resolverMemberId || '') || typeof event.forced !== 'boolean') throw new Error('run.ownership_resolved fields are invalid');
    normalized.conflictId = event.conflictId; normalized.candidates = normalizeCandidates(event.candidates); normalized.selectedDecisionEventId = event.selectedDecisionEventId; normalized.selectedOwnerToken = event.selectedOwnerToken; normalized.resolverMemberId = event.resolverMemberId;
    normalized.reason = normalizeText(event.reason, 'reason', 1000, false); normalized.forced = event.forced;
    const selected = normalized.candidates.find((candidate) => candidate.decisionEventId === normalized.selectedDecisionEventId);
    if (!normalized.reason || !selected || selected.selectedOwnerToken !== normalized.selectedOwnerToken) throw new Error('ownership resolution selection is invalid');
  } else if (event.type === 'run.operation_resolved') {
    normalized.ownerToken = owner();
    for (const field of ['operationId', 'conflictId', 'selectedOutcomeDigest']) if (!DIGEST.test(event[field] || '')) throw new Error(`${field} must be a lowercase SHA-256 digest`);
    if (!EVENT_ID.test(event.selectedDecisionEventId || '') || !MEMBER_ID.test(event.resolverMemberId || '') || typeof event.forced !== 'boolean') throw new Error('run.operation_resolved fields are invalid');
    normalized.operationId = event.operationId; normalized.conflictId = event.conflictId; normalized.candidates = normalizeOperationCandidates(event.candidates); normalized.selectedDecisionEventId = event.selectedDecisionEventId; normalized.selectedOutcomeDigest = event.selectedOutcomeDigest; normalized.resolverMemberId = event.resolverMemberId; normalized.reason = normalizeText(event.reason, 'reason', 1000, false); normalized.forced = event.forced;
    const selected = normalized.candidates.find((candidate) => candidate.decisionEventId === normalized.selectedDecisionEventId);
    if (!normalized.reason || !selected || selected.selectedOutcomeDigest !== normalized.selectedOutcomeDigest) throw new Error('operation resolution selection is invalid');
  } else if (event.type === 'run.completed_local') {
    normalized.ownerToken = owner();
    if (!REVISION.test(event.commit || '')) throw new Error('run.completed_local.commit is invalid');
    normalized.commit = event.commit; normalized.artifactIds = normalizeStringArray(event.artifactIds, 'artifactIds', true);
  } else if (event.type === 'run.synced') {
    normalized.ownerToken = owner();
    if (!REVISION.test(event.commit || '')) throw new Error('run.synced.commit is invalid');
    normalized.commit = event.commit; normalized.remoteRef = normalizeText(event.remoteRef, 'remoteRef', 500, true);
    if (!normalized.remoteRef) throw new Error('run.synced.remoteRef is required');
  }
  validateEventOperation(normalized);
  return normalized;
}

function createEventEnvelope(event) {
  const canonical = normalizeRunEvent(event);
  const canonicalBytes = Buffer.from(canonicalJson(canonical), 'utf8');
  const canonicalDigest = sha256(canonicalBytes);
  if (event.canonicalDigest !== undefined && event.canonicalDigest !== canonicalDigest) throw new Error(`canonicalDigest mismatch for ${event.eventId}`);
  const shared = Object.assign({}, canonical, { canonicalDigest });
  if (event.occurredAt !== undefined) shared.occurredAt = event.occurredAt;
  const local = Object.assign({}, shared);
  if (event.localDetail !== undefined) local.localDetail = event.localDetail;
  return { canonical, canonicalBytes, canonicalDigest, shared, local };
}

function legacyRecord(event) {
  const partial = ['canonicalDigest', 'rootRequestId', 'requestId', 'ownerToken'].filter((field) => event[field] !== undefined);
  if (event.schemaVersion !== undefined && event.schemaVersion !== 1) throw new Error('RDL-RUN-021 legacy-malformed: invalid schemaVersion');
  if (partial.length) throw new Error('RDL-RUN-021 legacy-malformed: partial canonical envelope');
  if (!EVENT_ID.test(event.eventId || '') || !RUN_ID.test(event.runId || '') || !SIMPLE_ID.test(event.projectId || '') || !SIMPLE_ID.test(event.clientId || '') || typeof event.type !== 'string') throw new Error('RDL-RUN-021 legacy-malformed: invalid identity');
  const normalized = {};
  for (const [key, value] of Object.entries(event)) if (!['occurredAt', 'canonicalDigest', 'localDetail'].includes(key) && value !== undefined) normalized[key] = value;
  normalized.schemaVersion = 1;
  const legacyDigest = sha256(Buffer.concat([Buffer.from('rundol.run-legacy.v1\0', 'utf8'), Buffer.from(canonicalJson(normalized), 'utf8')]));
  return { event, canonical: normalized, digest: legacyDigest, legacy: true, ownerToken: null };
}

function canonicalRecord(event) {
  const envelope = createEventEnvelope(event);
  return { event: envelope.local, canonical: envelope.canonical, digest: envelope.canonicalDigest, legacy: false, ownerToken: envelope.canonical.ownerToken || null };
}

function normalizeRecords(events) {
  const records = [];
  const diagnostics = [];
  const groups = new Map();
  for (const event of events) {
    let record;
    try { record = event.schemaVersion === 2 ? canonicalRecord(event) : legacyRecord(event); }
    catch (error) {
      diagnostics.push({ code: 'RDL-RUN-021', severity: 'error', eventId: event && event.eventId, message: error.message });
      continue;
    }
    if (!groups.has(record.canonical.eventId)) groups.set(record.canonical.eventId, []);
    groups.get(record.canonical.eventId).push(record);
  }
  for (const [eventId, variants] of groups) {
    const digests = new Set(variants.map((record) => record.digest));
    if (digests.size > 1) {
      diagnostics.push({ code: variants.some((record) => record.legacy) ? 'RDL-RUN-018' : 'RDL-RUN-017', severity: 'error', eventId, message: 'eventId has conflicting canonical projections' });
      continue;
    }
    const selected = variants.find((record) => record.event.localDetail !== undefined) || variants[0];
    records.push(selected);
  }
  return { records, diagnostics };
}

function validateProcedure(procedure) {
  if (!procedure || typeof procedure !== 'object') throw new Error('procedure is required');
  if (!/^[a-z][a-z0-9.-]*$/u.test(procedure.name || '')) throw new Error(`invalid procedure name: ${procedure.name || '(missing)'}`);
  if (!Number.isInteger(procedure.revision) || procedure.revision < 1) throw new Error('절차 revision은 1 이상의 정수여야 합니다.');
  if (!Array.isArray(procedure.steps) || procedure.steps.length === 0) throw new Error('procedure must have at least one step');
  const seen = new Set();
  for (const step of procedure.steps) {
    if (!STEP_ID.test(step.id || '')) throw new Error(`invalid step ID: ${step.id || '(missing)'}`);
    if (seen.has(step.id)) throw new Error(`duplicate step ID: ${step.id}`);
    seen.add(step.id);
    if (step.onFail) {
      if (!seen.has(step.onFail.goto)) throw new Error(`onFail.goto는 앞선 스텝만 가리킬 수 있습니다: ${step.id} -> ${step.onFail.goto}`);
      if (!Number.isInteger(step.onFail.maxAttempts) || step.onFail.maxAttempts < 1) throw new Error(`onFail.maxAttempts must be positive: ${step.id}`);
    }
  }
  return procedure;
}

function repairTail(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  if (!content || content.endsWith('\n')) return;
  const cut = content.lastIndexOf('\n');
  fs.truncateSync(file, cut < 0 ? 0 : Buffer.byteLength(content.slice(0, cut + 1), 'utf8'));
}

function readRunEvents(directory) {
  const file = path.join(directory, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).map((line, index) => ({ line, index })).filter((entry) => entry.line.trim());
  const events = [];
  for (const [position, entry] of lines.entries()) {
    try { events.push(JSON.parse(entry.line)); }
    catch (error) {
      if (position === lines.length - 1) break;
      throw new Error(`${file}:${entry.index + 1}: 이벤트를 파싱할 수 없습니다: ${error.message}`);
    }
  }
  return events;
}

function appendRunEvent(directory, event) {
  if (!event || !event.type) throw new Error('event.type is required');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'events.jsonl');
  repairTail(file);
  let safe;
  if (event.schemaVersion === 2) safe = createEventEnvelope(event).local;
  else {
    safe = Object.assign({ schemaVersion: 1, eventId: `EVT-${crypto.randomBytes(10).toString('hex').toUpperCase()}`, occurredAt: new Date().toISOString() }, event);
    delete safe.prompt; delete safe.content;
  }
  for (const current of readRunEvents(directory)) {
    if (current.eventId !== safe.eventId) continue;
    const currentRecord = current.schemaVersion === 2 ? canonicalRecord(current) : legacyRecord(current);
    const safeRecord = safe.schemaVersion === 2 ? canonicalRecord(safe) : legacyRecord(safe);
    if (currentRecord.digest !== safeRecord.digest) throw new Error(`eventId corruption: ${safe.eventId}`);
    if (current.localDetail === undefined && safe.localDetail !== undefined) {
      fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
      return { file, event: safe };
    }
    return { file, event: current };
  }
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
  if (CHECKPOINT_TYPES.has(safe.type)) {
    const descriptor = fs.openSync(file, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  return { file, event: safe };
}

function candidateConflictId(candidates) {
  return sha256(Buffer.from(canonicalJson(normalizeCandidates(candidates)), 'utf8'));
}

function sameCandidates(left, right) {
  try { return canonicalJson(normalizeCandidates(left)) === canonicalJson(normalizeCandidates(right)); } catch { return false; }
}

function legacyOwnership(records, diagnostics) {
  const legacy = records.filter((record) => record.legacy);
  if (!legacy.length) return { records, start: null };
  const starts = legacy.filter((record) => record.canonical.type === 'run.started');
  if (starts.length !== 1) {
    diagnostics.push({ code: 'RDL-RUN-019', severity: 'error', message: 'legacy ownership requires exactly one run.started' });
    return { records, start: starts[0] || null, ambiguous: true };
  }
  const start = starts[0];
  start.ownerToken = start.canonical.eventId;
  const visitedClients = new Set([start.canonical.clientId]);
  let clientId = start.canonical.clientId;
  let token = start.ownerToken;
  for (;;) {
    for (const record of legacy.filter((candidate) => candidate.canonical.clientId === clientId && candidate.canonical.type !== 'run.takeover')) record.ownerToken = token;
    const children = legacy.filter((record) => record.canonical.type === 'run.takeover' && record.canonical.previousClientId === clientId);
    if (!children.length) break;
    if (children.length !== 1 || visitedClients.has(children[0].canonical.clientId)) {
      diagnostics.push({ code: 'RDL-RUN-019', severity: 'error', eventId: children[0] && children[0].canonical.eventId, message: 'legacy ownership chain is ambiguous' });
      return { records, start, ambiguous: true };
    }
    const child = children[0];
    child.ownerToken = child.canonical.eventId;
    child.previousOwnerToken = token;
    clientId = child.canonical.clientId;
    token = child.ownerToken;
    visitedClients.add(clientId);
  }
  const unmapped = legacy.filter((record) => !record.ownerToken && record.canonical.type !== 'run.ownership_resolved');
  if (unmapped.length) {
    diagnostics.push({ code: 'RDL-RUN-019', severity: 'error', eventId: unmapped[0].canonical.eventId, message: 'legacy ownership chain is broken' });
    return { records, start, ambiguous: true };
  }
  return { records, start };
}

function ownershipState(events) {
  const normalized = normalizeRecords(events);
  const diagnostics = normalized.diagnostics.slice();
  const legacyMapped = legacyOwnership(normalized.records, diagnostics);
  const records = legacyMapped.records;
  const starts = records.filter((record) => record.canonical.type === 'run.started');
  if (starts.length !== 1 || legacyMapped.ambiguous) {
    if (starts.length !== 1 && !diagnostics.some((item) => item.code === 'RDL-RUN-019')) diagnostics.push({ code: 'RDL-RUN-019', severity: 'error', message: 'run requires exactly one start event' });
    return { mode: 'legacy-conflict', status: 'CONFLICT', diagnostics, visibleEvents: starts.map((record) => record.event), staleEvents: records.filter((record) => !starts.includes(record)).map((record) => record.event), ownerToken: null, ownerClientId: null, token: null, client: null, parentClient: null, candidates: [], conflictId: null };
  }
  const start = starts[0];
  start.ownerToken = start.ownerToken || start.canonical.ownerToken;
  const byToken = new Map([[start.ownerToken, start]]);
  for (const record of records.filter((item) => item.canonical.type === 'run.takeover')) byToken.set(record.ownerToken || record.canonical.ownerToken, record);
  const visible = [start];
  const selectedTokens = new Set([start.ownerToken]);
  let activeToken = start.ownerToken;
  let activeClientId = start.canonical.clientId;
  let parentClientId = activeClientId;
  let conflict = null;
  const epochRecords = (token) => records.filter((record) => record.ownerToken === token && !['run.started', 'run.takeover', 'run.ownership_resolved'].includes(record.canonical.type));
  for (let guard = 0; guard < records.length + 2; guard += 1) {
    const children = records.filter((record) => record.canonical.type === 'run.takeover' && (record.previousOwnerToken || record.canonical.previousOwnerToken) === activeToken);
    const validChildren = [];
    for (const child of children) {
      const canonical = child.canonical;
      if (!child.legacy && canonical.previousClientId !== activeClientId) continue;
      if (!child.legacy) {
        const predecessor = [byToken.get(activeToken)].concat(epochRecords(activeToken)).filter(Boolean);
        const headIndex = predecessor.findIndex((record) => record.canonical.eventId === canonical.previousOwnerHeadEventId);
        if (headIndex < 0) {
          diagnostics.push({ code: 'RDL-RUN-020', severity: 'error', eventId: canonical.eventId, message: 'takeover cutoff head is missing from predecessor epoch' });
          continue;
        }
        child.cutoffIndex = headIndex;
      }
      validChildren.push(child);
    }
    if (!validChildren.length) {
      visible.push(...epochRecords(activeToken));
      break;
    }
    const predecessor = [byToken.get(activeToken)].concat(epochRecords(activeToken)).filter(Boolean);
    const cutoff = Math.min(...validChildren.map((child) => child.legacy ? predecessor.length - 1 : child.cutoffIndex));
    visible.push(...predecessor.slice(1, cutoff + 1));
    if (validChildren.length === 1) {
      const child = validChildren[0];
      visible.push(child);
      activeToken = child.ownerToken || child.canonical.ownerToken;
      activeClientId = child.canonical.clientId;
      parentClientId = activeClientId;
      selectedTokens.add(activeToken);
      continue;
    }
    let candidates = validChildren.map((child) => ({ decisionEventId: child.canonical.eventId, selectedOwnerToken: child.ownerToken || child.canonical.ownerToken }));
    let conflictId = candidateConflictId(candidates);
    const conflictedParentToken = activeToken;
    const conflictedParentClientId = activeClientId;
    for (let resolutionGuard = 0; resolutionGuard < records.length + 2; resolutionGuard += 1) {
      const resolutions = records.filter((record) => record.canonical.type === 'run.ownership_resolved' && record.canonical.conflictId === conflictId && sameCandidates(record.canonical.candidates, candidates));
      const valid = resolutions.filter((record) => {
        const tuple = candidates.find((candidate) => candidate.decisionEventId === record.canonical.selectedDecisionEventId);
        return tuple && tuple.selectedOwnerToken === record.canonical.selectedOwnerToken && byToken.has(tuple.selectedOwnerToken);
      });
      if (!valid.length) {
        conflict = { conflictId, parentToken: conflictedParentToken, parentClientId: conflictedParentClientId, candidates: normalizeCandidates(candidates) };
        break;
      }
      visible.push(...valid);
      const bySelection = new Map();
      for (const resolution of valid) {
        const token = resolution.canonical.selectedOwnerToken;
        if (!bySelection.has(token)) bySelection.set(token, resolution);
      }
      if (bySelection.size === 1) {
        activeToken = Array.from(bySelection.keys())[0];
        const selectedDecision = byToken.get(activeToken);
        if (selectedDecision && !visible.includes(selectedDecision)) visible.push(selectedDecision);
        activeClientId = byToken.get(activeToken).canonical.clientId;
        parentClientId = activeClientId;
        selectedTokens.add(activeToken);
        break;
      }
      candidates = Array.from(bySelection.values()).map((resolution) => ({ decisionEventId: resolution.canonical.eventId, selectedOwnerToken: resolution.canonical.selectedOwnerToken }));
      conflictId = candidateConflictId(candidates);
    }
    if (conflict) break;
    continue;
  }
  const visibleSet = new Set(visible.map((record) => record.canonical.eventId));
  const stale = records.filter((record) => !visibleSet.has(record.canonical.eventId));
  for (const record of stale.filter((item) => item.legacy && item.ownerToken)) diagnostics.push({ code: 'RDL-RUN-020', severity: 'warning', eventId: record.canonical.eventId, message: 'legacy event is after the immutable ownership cutoff' });
  const result = {
    mode: conflict ? 'ownership-conflict' : 'active',
    status: conflict ? 'CONFLICT' : 'ACTIVE',
    conflict,
    diagnostics,
    ownerToken: conflict ? null : activeToken,
    ownerClientId: conflict ? null : activeClientId,
    parentToken: conflict ? conflict.parentToken : activeToken,
    parentClientId: conflict ? conflict.parentClientId : parentClientId,
    visibleEvents: visible.map((record) => record.event),
    staleEvents: stale.map((record) => record.event),
    ownerHeadEventId: conflict ? null : (visible.filter((record) => record.ownerToken === activeToken || record.canonical.ownerToken === activeToken).pop() || byToken.get(activeToken)).canonical.eventId
  };
  result.token = result.ownerToken;
  result.client = result.ownerClientId;
  result.parentClient = conflict ? conflict.parentClientId : result.ownerClientId;
  result.candidates = conflict ? conflict.candidates : [];
  result.conflictId = conflict ? conflict.conflictId : null;
  return result;
}

function transitionKind(step) {
  if (step && step.gate) return 'gate';
  if (step && (step.verify || step.lenses)) return 'verify';
  if (step && step.human === true) return 'human';
  return 'step';
}

function foldProgress(events, ownership) {
  if (!events.length) return { status: 'missing', cursor: null, diagnostics: ownership ? ownership.diagnostics : [] };
  const started = events.find((event) => event.type === 'run.started');
  if (!started) throw new Error('run ledger must begin with run.started');
  const steps = started.procedure.resolved.steps;
  const order = steps.map((step) => step.id);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const completed = new Set();
  let attempts = {};
  const forcedSteps = [];
  const artifactIds = [];
  const diagnostics = ownership ? ownership.diagnostics.slice() : [];
  let lastGate = null;
  let status = ownership && ownership.status === 'CONFLICT' ? 'ownership-conflict' : 'running';
  let haltReason = status === 'ownership-conflict' ? 'ownership-conflict' : null;
  const strict = started.schemaVersion === 2;
  const cursor = () => order.find((identifier) => !completed.has(identifier)) || null;
  for (const event of events.filter((item) => !['run.started', 'run.takeover', 'run.ownership_resolved'].includes(item.type))) {
    if (status === 'ownership-conflict') break;
    const current = cursor();
    const step = current ? byId.get(current) : null;
    const invalid = (message) => diagnostics.push({ code: 'RDL-RUN-022', severity: 'error', eventId: event.eventId, message });
    if (['run.step', 'run.gate', 'run.forced'].includes(event.type) && strict) {
      if (status !== 'running' || event.stepId !== current) { invalid('progress event does not target the active cursor'); continue; }
      const kind = transitionKind(step);
      if (event.type === 'run.step' && kind !== 'step') { invalid(`run.step cannot complete a ${kind} step`); continue; }
      if (event.type === 'run.gate' && kind !== 'gate' && kind !== 'verify') { invalid('run.gate requires a gate or verification cursor'); continue; }
    }
    if (event.type === 'run.step' && event.exitCode === 0) {
      completed.add(event.stepId);
      for (const artifactId of event.artifactIds || []) if (!artifactIds.includes(artifactId)) artifactIds.push(artifactId);
    } else if (event.type === 'run.gate') {
      lastGate = { stepId: event.stepId, exitCode: event.exitCode, diagnostics: event.diagnostics || [] };
      if (event.exitCode === 0) completed.add(event.stepId);
      else if (event.exitCode === 1 || !strict) {
        attempts[event.stepId] = (attempts[event.stepId] || 0) + 1;
        const definition = byId.get(event.stepId);
        if (definition && definition.onFail) {
          const from = order.indexOf(definition.onFail.goto);
          for (const identifier of order.slice(from)) completed.delete(identifier);
        }
      } else invalid('gate exit 2 is an invocation failure and cannot advance or count as a verdict');
    } else if (event.type === 'run.forced') {
      completed.add(event.stepId); forcedSteps.push({ stepId: event.stepId, reason: event.reason || null });
    } else if (event.type === 'run.halted') {
      status = 'halted'; haltReason = HALT_REASONS.has(event.reason) ? event.reason : 'manual';
    } else if (event.type === 'run.resumed') {
      status = 'running'; haltReason = null; attempts = {};
    } else if (event.type === 'run.completed_local') status = 'completed_local';
    else if (event.type === 'run.synced') status = 'synced';
  }
  for (const step of steps) if (step.onFail && !completed.has(step.id) && (attempts[step.id] || 0) >= step.onFail.maxAttempts && status === 'running') { status = 'halted'; haltReason = 'attempt-limit'; }
  const current = status === 'completed_local' || status === 'synced' ? null : cursor();
  return {
    runId: started.runId, projectId: started.projectId,
    procedure: { name: started.procedure.name, revision: started.procedure.revision, contentHash: started.procedure.contentHash },
    status, cursor: current, cursorStep: current ? byId.get(current) || null : null,
    completedSteps: order.filter((identifier) => completed.has(identifier)), attempts, forcedSteps, artifactIds, lastGate, haltReason,
    ownerToken: ownership ? ownership.ownerToken : null, owner: ownership ? ownership.ownerClientId : null,
    ownershipConflict: ownership ? ownership.conflict : null,
    staleEventIds: ownership ? ownership.staleEvents.map((event) => event.eventId).filter(Boolean).sort() : [], diagnostics
  };
}

function operationConflictId(candidates) {
  return sha256(Buffer.from(canonicalJson(normalizeOperationCandidates(candidates)), 'utf8'));
}

function sameOperationCandidates(left, right) {
  try { return canonicalJson(normalizeOperationCandidates(left)) === canonicalJson(normalizeOperationCandidates(right)); } catch { return false; }
}

function operationOutcomeState(visibleEvents) {
  const outcomes = (visibleEvents || []).filter((event) => event.operation && event.type !== 'run.operation_resolved');
  const resolutions = (visibleEvents || []).filter((event) => event.type === 'run.operation_resolved');
  const byOperation = new Map();
  for (const event of outcomes) {
    const list = byOperation.get(event.operation.operationId) || [];
    list.push(event);
    byOperation.set(event.operation.operationId, list);
  }
  const excluded = new Set();
  const applied = new Map();
  const conflicts = [];
  for (const [operationId, events] of byOperation) {
    const byDigest = new Map();
    for (const event of events) {
      const list = byDigest.get(event.operation.outcomeDigest) || [];
      list.push(event);
      byDigest.set(event.operation.outcomeDigest, list);
    }
    for (const event of events) excluded.add(event.eventId);
    if (byDigest.size === 1) {
      const selected = events.slice().sort((left, right) => left.eventId.localeCompare(right.eventId))[0];
      excluded.delete(selected.eventId); applied.set(operationId, selected);
      continue;
    }
    let candidates = Array.from(byDigest.entries()).map(([selectedOutcomeDigest, variants]) => ({ decisionEventId: variants.map((event) => event.eventId).sort()[0], selectedOutcomeDigest })).sort((left, right) => left.decisionEventId.localeCompare(right.decisionEventId));
    let conflictId = operationConflictId(candidates);
    let resolvedDigest = null;
    for (let guard = 0; guard < resolutions.length + 2; guard += 1) {
      const valid = resolutions.filter((event) => event.operationId === operationId && event.conflictId === conflictId && sameOperationCandidates(event.candidates, candidates)).filter((event) => {
        const tuple = candidates.find((candidate) => candidate.decisionEventId === event.selectedDecisionEventId);
        return tuple && tuple.selectedOutcomeDigest === event.selectedOutcomeDigest;
      });
      if (!valid.length) break;
      const selections = new Map();
      for (const event of valid) if (!selections.has(event.selectedOutcomeDigest)) selections.set(event.selectedOutcomeDigest, event);
      if (selections.size === 1) { resolvedDigest = Array.from(selections.keys())[0]; break; }
      candidates = Array.from(selections.values()).map((event) => ({ decisionEventId: event.eventId, selectedOutcomeDigest: event.selectedOutcomeDigest })).sort((left, right) => left.decisionEventId.localeCompare(right.decisionEventId));
      conflictId = operationConflictId(candidates);
    }
    if (resolvedDigest && byDigest.has(resolvedDigest)) {
      const selected = byDigest.get(resolvedDigest).slice().sort((left, right) => left.eventId.localeCompare(right.eventId))[0];
      excluded.delete(selected.eventId); applied.set(operationId, selected);
    } else conflicts.push({ operationId, conflictId, candidates: normalizeOperationCandidates(candidates) });
  }
  return { effectiveEvents: (visibleEvents || []).filter((event) => !excluded.has(event.eventId)), applied, conflicts };
}

function logicalAttemptForStep(events, stepId) {
  if (!STEP_ID.test(stepId || '')) throw new Error('logicalAttempt requires a valid stepId');
  const ownership = ownershipState(events);
  if (ownership.status !== 'ACTIVE') throw new Error('logicalAttempt requires ACTIVE ownership');
  const operationState = operationOutcomeState(ownership.visibleEvents);
  const started = operationState.effectiveEvents.find((event) => event.type === 'run.started');
  if (!started) throw new Error('logicalAttempt requires run.started');
  const steps = started.procedure.resolved.steps;
  const order = steps.map((step) => step.id);
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (!byId.has(stepId)) throw new Error(`unknown procedure step: ${stepId}`);
  const completed = new Set();
  const seen = new Set();
  let count = 0;
  const cursor = () => order.find((id) => !completed.has(id)) || null;
  for (const event of operationState.effectiveEvents) {
    if (!event.eventId || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const current = cursor();
    if (event.type === 'run.step' && event.stepId === current && transitionKind(byId.get(current)) === 'step' && event.exitCode === 0) completed.add(current);
    else if (event.type === 'run.gate' && event.stepId === current && ['gate', 'verify'].includes(transitionKind(byId.get(current)))) {
      if (event.exitCode === 0) completed.add(current);
      else if (event.exitCode === 1) {
        const failed = byId.get(current);
        if (!failed.onFail || !byId.has(failed.onFail.goto)) continue;
        const from = order.indexOf(failed.onFail.goto);
        const through = order.indexOf(current);
        if (from <= order.indexOf(stepId) && order.indexOf(stepId) <= through) count += 1;
        for (const id of order.slice(from)) completed.delete(id);
      }
    } else if (event.type === 'run.forced' && event.stepId === current) completed.add(current);
  }
  return 1 + count;
}

function foldRun(events) {
  if (!events.length) return { status: 'missing', cursor: null };
  const hasOwnership = events.some((event) => event.type === 'run.takeover' || event.type === 'run.ownership_resolved' || event.schemaVersion === 2);
  if (!hasOwnership) return foldProgress(events, null);
  const ownership = ownershipState(events);
  const operationState = operationOutcomeState(ownership.visibleEvents);
  const result = foldProgress(operationState.effectiveEvents, ownership);
  if (operationState.conflicts.length && !['completed_local', 'synced'].includes(result.status)) {
    result.status = 'operation-conflict'; result.haltReason = 'operation-conflict'; result.operationConflicts = operationState.conflicts;
  } else result.operationConflicts = [];
  return result;
}

function orderSharedEvents(events) {
  return ownershipState(events).visibleEvents;
}

function foldSharedRun(events) {
  const ownership = ownershipState(events);
  const operationState = operationOutcomeState(ownership.visibleEvents);
  const result = foldProgress(operationState.effectiveEvents, ownership);
  if (operationState.conflicts.length && !['completed_local', 'synced'].includes(result.status)) {
    result.status = 'operation-conflict'; result.haltReason = 'operation-conflict'; result.operationConflicts = operationState.conflicts;
  } else result.operationConflicts = [];
  return result;
}

function runOwner(events) {
  const state = ownershipState(events);
  return state.ownerClientId;
}

function listRuns(projectRoot) {
  const root = runsRoot(projectRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => RUN_ID.test(name)).sort().map((runId) => Object.assign({ runId }, foldRun(readRunEvents(path.join(root, runId)))));
}

function workspaceEventsRoot(layout) {
  if (layout.schemaVersion < 6) return null;
  return path.join(layout.root, 'projects', 'workspace', 'events');
}

function mirrorRunEvent(layout, projectKey, event) {
  const eventsRoot = workspaceEventsRoot(layout);
  if (!eventsRoot) return null;
  if (!event.clientId) throw new Error('shared run event requires clientId');
  const shared = event.schemaVersion === 2 ? createEventEnvelope(event).shared : event;
  const file = eventStore.appendEvent(eventsRoot, 'run', projectKey, event.clientId, shared, { runId: event.runId, lockDirectory: runtimeWorkspace(layout.root).locks, fsync: CHECKPOINT_TYPES.has(event.type) });
  if (CHECKPOINT_TYPES.has(event.type)) saveSettings(layout.root);
  return file;
}

function readSharedRunEvents(layout, projectKey, runId) {
  const eventsRoot = workspaceEventsRoot(layout);
  if (!eventsRoot) return [];
  return eventStore.readEvents(eventsRoot, 'run', projectKey, { sort: 'file' }).filter((event) => event.runId === runId);
}

function unionRunEvents(localEvents, sharedEvents) {
  const normalized = normalizeRecords(localEvents.concat(sharedEvents));
  if (normalized.diagnostics.some((item) => item.code === 'RDL-RUN-017' || item.code === 'RDL-RUN-018')) throw new Error(normalized.diagnostics.find((item) => item.code === 'RDL-RUN-017' || item.code === 'RDL-RUN-018').message);
  return normalized.records.map((record) => record.event);
}

function reconcileRun(start, input) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, input.project, true);
  const directory = runDirectory(project.root, input.runId);
  const local = readRunEvents(directory);
  const shared = readSharedRunEvents(layout, project.key, input.runId);
  const localIds = new Map(local.map((event) => [event.eventId, event]));
  const repaired = [];
  for (const event of shared) {
    if (localIds.has(event.eventId)) continue;
    appendRunEvent(directory, event);
    repaired.push(event.eventId);
  }
  return { project: project.key, runId: input.runId, events: unionRunEvents(readRunEvents(directory), shared), repaired };
}

function prepareV2Event(start, project, runId, input) {
  const rootRequestId = input.rootRequestId || input.event.rootRequestId || newRequestId();
  const childKey = input.childKey || `event:${input.event.type}:${runId}`;
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  const eventId = input.event.eventId || requestJournal.eventIdForRequest(requestId);
  const base = Object.assign({}, input.event, { schemaVersion: 2, rootRequestId, requestId, eventId, runId, projectId: project.key });
  let state = null;
  let fold = null;
  if ((!base.ownerToken && !['run.started', 'run.ownership_resolved'].includes(base.type)) || base.type === 'run.gate') {
    const reconciled = reconcileRun(start, { project: project.key, runId });
    state = ownershipState(reconciled.events);
    if (state.status !== 'ACTIVE') throw new Error('run ownership is conflicted');
    if (!base.ownerToken) base.ownerToken = state.ownerToken;
    fold = foldProgress(state.visibleEvents, state);
  }
  if (base.type === 'run.gate') {
    const step = fold && fold.cursorStep;
    if (base.command === undefined && step && step.gate) base.command = step.gate.command;
    if (base.args === undefined && step && step.gate) base.args = step.gate.args || [];
    if (base.attempt === undefined) base.attempt = ((fold && fold.attempts[base.stepId]) || 0) + 1;
  }
  if (base.type === 'run.started') base.ownerToken = eventId;
  if (base.type === 'run.takeover') base.ownerToken = eventId;
  if (base.type === 'run.step' && base.artifactIds === undefined) base.artifactIds = [];
  if (base.type === 'run.completed_local' && base.artifactIds === undefined) base.artifactIds = [];
  return { base, rootRequestId, childKey };
}

function recordRunEvent(start, input) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, input.project, true);
  if (!RUN_ID.test(input.runId || '')) throw new Error(`invalid run ID: ${input.runId || '(missing)'}`);
  const existingShared = readSharedRunEvents(layout, project.key, input.runId);
  const v2 = input.event.schemaVersion === 2 || input.rootRequestId || input.event.rootRequestId || existingShared.some((event) => event.schemaVersion === 2);
  if (!v2) {
    const legacy = Object.assign({ runId: input.runId, projectId: project.key }, input.event);
    const appended = appendRunEvent(runDirectory(project.root, input.runId), legacy);
    const shared = mirrorRunEvent(layout, project.key, appended.event);
    return { project: project.key, event: appended.event, file: appended.file, shared };
  }
  const prepared = prepareV2Event(start, project, input.runId, input);
  const envelope = createEventEnvelope(prepared.base);
  const runtime = runtimeWorkspace(layout.root);
  const commandDigest = input.commandDigest || sha256(Buffer.from(canonicalJson({ projectId: project.key, runId: input.runId, type: prepared.base.type, clientId: prepared.base.clientId }), 'utf8'));
  const root = requestJournal.prepareRoot(runtime, { rootRequestId: prepared.rootRequestId, commandDigest, clientId: prepared.base.clientId });
  const child = requestJournal.prepareChild(root, { childKey: prepared.childKey, canonicalBytes: envelope.canonicalBytes, occurredAt: prepared.base.occurredAt, runId: input.runId });
  if (child.eventId !== prepared.base.eventId || child.requestId !== prepared.base.requestId) throw new Error('request journal identity mismatch');
  const shared = mirrorRunEvent(layout, project.key, envelope.shared);
  requestJournal.updateChild(root, prepared.childKey, 'canonical-committed');
  try {
    const appended = appendRunEvent(runDirectory(project.root, input.runId), envelope.local);
    requestJournal.updateChild(root, prepared.childKey, 'complete');
    return { project: project.key, event: appended.event, file: appended.file, shared, canonicalCommitted: true, projectionDegraded: false, rootRequestId: prepared.rootRequestId, requestId: prepared.base.requestId };
  } catch (error) {
    return { project: project.key, event: envelope.shared, file: null, shared, canonicalCommitted: true, projectionDegraded: true, projectionError: error.message, rootRequestId: prepared.rootRequestId, requestId: prepared.base.requestId };
  }
}

function createRun(start, input) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, input.project, true);
  const procedure = validateProcedure(input.procedure);
  const clientId = String(input.clientId || '').trim().toLowerCase();
  if (!clientId) throw new Error('--client-id is required');
  if (workspaceEventsRoot(layout)) {
    const client = getClient(start, clientId);
    if (client.status !== 'active') throw new Error(`inactive client cannot start a run: ${clientId}`);
  }
  const v2 = Boolean(input.rootRequestId || input.settings);
  const rootRequestId = input.rootRequestId || (v2 ? newRequestId() : null);
  const runId = input.runId || (v2 ? deterministicRunId(rootRequestId) : newRunId());
  const contentHash = sha256(Buffer.from(canonicalJson(procedure), 'utf8'));
  const event = {
    type: 'run.started', runId, projectId: project.key, clientId,
    goal: String(input.goal || '').trim() || undefined,
    procedure: { name: procedure.name, revision: procedure.revision, schemaVersion: procedure.schemaVersion || 1, contentHash, resolved: procedure }
  };
  if (v2) {
    if (!input.settings) throw new Error('canonical run start requires pinned settings');
    event.settings = input.settings;
    const recorded = recordRunEvent(start, { project: project.key, runId, rootRequestId, childKey: `event:run.started:${runId}`, commandDigest: input.commandDigest, event });
    return { runId, project: project.key, directory: runDirectory(project.root, runId), file: recorded.file, shared: recorded.shared, event: recorded.event, rootRequestId: recorded.rootRequestId, requestId: recorded.requestId, canonicalCommitted: recorded.canonicalCommitted, projectionDegraded: recorded.projectionDegraded };
  }
  const appended = appendRunEvent(runDirectory(project.root, runId), event);
  const shared = mirrorRunEvent(layout, project.key, appended.event);
  return { runId, project: project.key, directory: runDirectory(project.root, runId), file: appended.file, shared };
}

function takeoverRun(start, input) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, input.project, true);
  const clientId = String(input.clientId || '').trim().toLowerCase();
  if (!clientId) throw new Error('--client-id is required');
  const client = getClient(start, clientId);
  if (client.status !== 'active') throw new Error(`inactive client cannot take over a run: ${clientId}`);
  const reconciled = reconcileRun(start, { project: project.key, runId: input.runId });
  const state = ownershipState(reconciled.events);
  if (state.status !== 'ACTIVE') throw new Error('소유권 충돌을 먼저 해결해야 인수할 수 있습니다.');
  if (state.ownerClientId === clientId) throw new Error(`${clientId}는 이미 이 런의 소유자입니다.`);
  const fold = foldProgress(state.visibleEvents, state);
  let basis = 'halted';
  if (fold.status !== 'halted') {
    if (!input.force) throw new Error('정지하지 않은 런은 자동으로 인수할 수 없습니다. --force --reason을 사용하세요.');
    if (!String(input.reason || '').trim()) throw new Error('--force takeover requires --reason');
    basis = 'forced';
  }
  const rootRequestId = input.rootRequestId || input.requestId || newRequestId();
  const childKey = `event:run.takeover:${input.runId}`;
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  const eventId = requestJournal.eventIdForRequest(requestId);
  const recorded = recordRunEvent(start, {
    project: project.key, runId: input.runId, rootRequestId, childKey,
    event: { type: 'run.takeover', eventId, clientId, ownerToken: eventId, previousClientId: state.ownerClientId, previousOwnerToken: state.ownerToken, previousOwnerHeadEventId: state.ownerHeadEventId, basis, reason: basis === 'forced' ? String(input.reason).trim() : undefined }
  });
  reconcileRun(start, { project: project.key, runId: input.runId });
  return { runId: input.runId, project: project.key, clientId, previousClientId: state.ownerClientId, previousOwnerToken: state.ownerToken, ownerToken: eventId, basis, event: recorded.event, rootRequestId, requestId };
}

function projectMember(project, memberId) {
  return fs.existsSync(project.charter) && new RegExp(`\\^${memberId}(?:\\s|$)`, 'mu').test(fs.readFileSync(project.charter, 'utf8'));
}

function resolveOwnership(start, input) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, input.project, true);
  const clientId = String(input.clientId || '').trim().toLowerCase();
  const client = getClient(start, clientId);
  if (client.status !== 'active' || !projectMember(project, client.owner)) throw new Error('resolver client must be active and owned by an active project member');
  const reconciled = reconcileRun(start, { project: project.key, runId: input.runId });
  const state = ownershipState(reconciled.events);
  if (state.status !== 'CONFLICT' || !state.conflict) throw new Error('run is not in ownership conflict');
  if (input.conflictId !== state.conflict.conflictId) throw new Error('stale ownership conflict');
  const selected = state.conflict.candidates.find((candidate) => candidate.decisionEventId === input.selectedDecisionEventId);
  if (!selected) throw new Error('selected decision is not a current conflict candidate');
  const parentClient = getClient(start, state.conflict.parentClientId);
  const isParentClient = clientId === state.conflict.parentClientId;
  if (!isParentClient) {
    if (!input.force || !['agent', 'service'].includes(client.type) || client.type === 'device') throw new Error('a non-parent resolver requires an agent/service client with --force');
    if (!String(input.reason || '').trim()) throw new Error('forced ownership resolution requires reason');
    if (client.owner === parentClient.owner && client.type === 'device') throw new Error('a non-parent device cannot force ownership resolution');
  }
  const reason = normalizeText(input.reason || '', 'reason', 1000, false);
  if (!reason) throw new Error('ownership resolution requires reason');
  const rootRequestId = input.rootRequestId || input.requestId || newRequestId();
  const childKey = `event:run.ownership_resolved:${input.runId}`;
  const recorded = recordRunEvent(start, {
    project: project.key, runId: input.runId, rootRequestId, childKey,
    event: { type: 'run.ownership_resolved', clientId, conflictId: state.conflict.conflictId, candidates: state.conflict.candidates, selectedDecisionEventId: selected.decisionEventId, selectedOwnerToken: selected.selectedOwnerToken, resolverMemberId: client.owner, reason, forced: !isParentClient }
  });
  return { runId: input.runId, project: project.key, conflictId: state.conflict.conflictId, selectedDecisionEventId: selected.decisionEventId, selectedOwnerToken: selected.selectedOwnerToken, event: recorded.event, rootRequestId, requestId: recorded.requestId };
}

module.exports = {
  RUN_ID, EVENT_ID, REQUEST_ID, DIGEST, CHECKPOINT_TYPES, canonicalJson, sha256, newRunId, newRequestId, deterministicRunId,
  runDirectory, validateProcedure, normalizeRunEvent, createEventEnvelope, appendRunEvent, readRunEvents, createRun,
  foldRun, runOwner, listRuns, recordRunEvent, mirrorRunEvent, readSharedRunEvents, unionRunEvents, reconcileRun,
  candidateConflictId, ownershipState, orderSharedEvents, foldSharedRun, takeoverRun, resolveOwnership,
  normalizeOperationDecision, operationIdFor, outcomeDigestFor, createOperation,
  normalizeOperationCandidates, operationConflictId, operationOutcomeState, logicalAttemptForStep
};
