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
const HALT_REASONS = new Set(['gate-failed', 'step-failed', 'merge-conflict', 'sync-failed', 'adapter-timeout', 'lease-lost', 'attempt-limit', 'manual', 'settings-drift', 'ownership-conflict', 'operation-conflict', 'legacy-conflict', 'verification-required']);
const TYPE_FIELDS = {
  'run.started': { required: ['ownerToken', 'procedure', 'settings'], optional: ['goal', 'targetArtifactId'] },
  'run.step': { required: ['ownerToken', 'stepId', 'executor', 'exitCode', 'artifactIds'], optional: ['commit', 'operation'] },
  'run.gate': { required: ['ownerToken', 'stepId', 'command', 'args', 'exitCode', 'diagnostics', 'attempt'], optional: ['operation'] },
  'run.forced': { required: ['ownerToken', 'stepId', 'reason'], optional: ['basis', 'commit', 'operation'] },
  'run.halted': { required: ['reason', 'resumable', 'ownerToken'], optional: ['atStep', 'operation'] },
  'run.resumed': { required: ['ownerToken', 'fromStep'], optional: ['grantedAttempts', 'reason'] },
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
    // 커밋을 만든 스텝은 그 커밋도 결정의 일부다. 결정에서 빠지면 재시도가 되풀이한
    // 결과에 커밋이 없고, 검증은 무엇을 판정할지 다시 주변에서 주워 와야 한다.
    const keys = canonicalJson(Object.keys(value).sort());
    if (keys !== canonicalJson(['artifactIds']) && keys !== canonicalJson(['artifactIds', 'commit'])) throw new Error(`boundedResultDecision is invalid for ${kind}`);
    const decision = { artifactIds: normalizeStringArray(value.artifactIds, 'boundedResultDecision.artifactIds', true) };
    if (value.commit !== undefined) {
      if (!/^[a-f0-9]{40,64}$/u.test(String(value.commit))) throw new Error('boundedResultDecision.commit must be a lowercase Git revision');
      decision.commit = value.commit;
    }
    return decision;
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
  // 토큰 없는 v2 halted는 어느 epoch에도 속하지 못해 조용히 소멸하던 형태다 —
  // 스키마가 거부하고 전용 코드로 진단한다.
  if (event.type === 'run.halted' && event.ownerToken === undefined) {
    const error = new Error('run.halted requires ownerToken');
    error.rdlCode = 'RDL-RUN-024';
    throw error;
  }
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
    // 이 런이 다루는 정본 문서. 절차의 {artifact}가 여기서 온다.
    if (event.targetArtifactId !== undefined) {
      if (!/^[A-Z]{3}-\d{3,}$/u.test(String(event.targetArtifactId))) throw new Error('targetArtifactId는 정본 문서 ID여야 합니다.');
      normalized.targetArtifactId = event.targetArtifactId;
    }
    normalized.procedure = normalizeProcedure(event.procedure);
    normalized.settings = normalizeSettings(event.settings);
  } else if (event.type === 'run.step') {
    normalized.ownerToken = owner();
    if (!STEP_ID.test(event.stepId || '') || !['cli', 'adapter', 'client'].includes(event.executor) || !Number.isSafeInteger(event.exitCode) || event.exitCode < 0) throw new Error('run.step fields are invalid');
    normalized.stepId = event.stepId; normalized.executor = event.executor; normalized.exitCode = event.exitCode;
    normalized.artifactIds = normalizeStringArray(event.artifactIds, 'artifactIds', true);
    // 이 스텝이 만든 커밋. 검증이 결박될 대상이자, sync가 "아직 공유하면 안 되는
    // 커밋"을 알아보는 근거다. 없으면 그 스텝은 커밋을 만들지 않은 것이다.
    if (event.commit !== undefined) {
      if (!/^[a-f0-9]{40,64}$/u.test(String(event.commit))) throw new Error('run.step.commit must be a lowercase Git revision');
      normalized.commit = event.commit;
    }
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
    // 사람의 승인과 운영자의 우회는 둘 다 스텝을 지나가게 하지만 같은 일이 아니다.
    // 구분이 없으면 "사람이 승인했다"는 원장에서 읽어 낼 수 없고, 공유를 물을 때
    // 답할 근거가 사라진다. human-approval은 무엇을 승인했는지도 함께 말한다.
    if (event.basis !== undefined) {
      if (!['human-approval', 'operator-override'].includes(event.basis)) throw new Error('run.forced.basis is invalid');
      normalized.basis = event.basis;
    }
    if (event.commit !== undefined) {
      if (!REVISION.test(String(event.commit))) throw new Error('run.forced.commit must be a lowercase Git revision');
      normalized.commit = event.commit;
    }
    if (normalized.basis === 'human-approval' && !normalized.commit) throw new Error('human-approval must name the commit it approves');
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
    // 시도 예산을 다시 여는 것은 재개의 부수 효과가 아니라 그 자체로 하나의 결정이다.
    // 어느 스텝의 예산을 왜 열었는지가 함께 기록되지 않으면, 예산은 halt·resume을
    // 되풀이하는 것만으로 무한이 되고 절차가 선언한 상한은 사문이 된다.
    if (event.grantedAttempts !== undefined) {
      normalized.grantedAttempts = normalizeStringArray(event.grantedAttempts, 'grantedAttempts', true);
      if (!normalized.grantedAttempts.length || normalized.grantedAttempts.some((item) => !STEP_ID.test(item))) throw new Error('run.resumed.grantedAttempts must name procedure steps');
      normalized.reason = normalizeText(event.reason, 'reason', 1000, false);
    } else if (event.reason !== undefined) throw new Error('run.resumed.reason is only recorded with grantedAttempts');
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
      // v2 레코드의 canonical 손상은 legacy-malformed(021)가 아니라 자기 계열(017)로
      // 진단한다 — digest 정의는 정규화 하나뿐이고, 그에 어긋난 v2 레코드를 legacy로
      // 낙인하면 혼합 버전 조사가 엉뚱한 곳을 파게 된다.
      diagnostics.push({ code: error.rdlCode || (event && event.schemaVersion === 2 ? 'RDL-RUN-017' : 'RDL-RUN-021'), severity: 'error', eventId: event && event.eventId, message: error.message });
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
  const content = fs.readFileSync(file, 'utf8');
  // 크래시 절단은 개행 없는 꼬리로만 나타난다. append는 이벤트와 개행을 한 번에
  // 쓰므로, 개행으로 끝난 malformed 마지막 행은 절단이 아니라 원장 파손이다 —
  // 관용하면 완결된 파일의 영구 손상이 조용히 숨는다.
  const truncatedTail = !content.endsWith('\n');
  const lines = content.split(/\r?\n/u).map((line, index) => ({ line, index })).filter((entry) => entry.line.trim());
  const events = [];
  for (const [position, entry] of lines.entries()) {
    try { events.push(JSON.parse(entry.line)); }
    catch (error) {
      if (position === lines.length - 1 && truncatedTail) break;
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
  // 순서의 정본은 병합 배열의 위치가 아니라 각 작성자 샤드의 append 순서다.
  // 입력은 공유-우선으로 결합되므로(unionRunEvents) 작성자 내부 순서는 어떤
  // 열거에서도 동일하고, fold는 이벤트 집합의 함수가 된다.
  const writerSequence = new Map();
  for (const record of records) {
    const writer = record.canonical.clientId;
    if (!writerSequence.has(writer)) writerSequence.set(writer, []);
    record.writerIndex = writerSequence.get(writer).length;
    writerSequence.get(writer).push(record);
  }
  const isEpochRecord = (record) => !['run.started', 'run.takeover', 'run.ownership_resolved'].includes(record.canonical.type);
  // epoch 소속은 (ownerToken, 소유자 clientId) 결박이다. 소유자 자신의 이벤트와
  // 인가된 외래 전이(sync 실행자의 synced/halted)만 epoch에 들어온다. 그 밖의
  // 토큰 재사용은 진단과 함께 stale이 되어 상태를 바꿀 수 없다.
  const epochOwn = (token, ownerClientId) => (writerSequence.get(ownerClientId) || []).filter((record) => record.ownerToken === token && isEpochRecord(record));
  const epochForeign = (token, ownerClientId) => records.filter((record) => record.ownerToken === token && isEpochRecord(record) && record.canonical.clientId !== ownerClientId);
  const foreignTransitionEventIds = new Set();
  // 외래 halted의 인가 형태는 sync가 만드는 것뿐이다. 신원(활성 agent/service 멤버)
  // 검증은 쓰기 경로의 몫이고, 순수한 fold는 형태만 제한한다 — 그 밖의 사유를 단
  // 외래 halted는 토큰을 재사용한 침입으로 진단된다.
  const SYNC_HALT_REASONS = new Set(['sync-failed', 'merge-conflict']);
  const admitForeign = (token, ownerClientId) => {
    for (const record of epochForeign(token, ownerClientId)) {
      if (record.canonical.type === 'run.synced' || (record.canonical.type === 'run.halted' && SYNC_HALT_REASONS.has(record.canonical.reason))) {
        foreignTransitionEventIds.add(record.canonical.eventId);
        visible.push(record);
      } else if (record.canonical.type === 'run.operation_resolved') {
        // 인가 매트릭스가 허용한 비소유자 forced 해소다. 정당성은 여기가 아니라
        // operationOutcomeState의 conflictId·후보 대조가 검증한다.
        visible.push(record);
      } else if (record.canonical.type === 'run.forced' && record.canonical.basis === 'human-approval' && record.canonical.commit) {
        // 사람의 승인은 소유자가 쓰지 않는다. 런을 모는 것과 그것을 승인하는 것은
        // 다른 역할이고, 같은 자격이 둘 다 하면 게이트는 이름만 남는다. 그래서
        // 승인은 인가된 외래 전이다.
        //
        // 순수한 fold는 형태만 제한한다 — 승인자가 실제로 human 유형 활성 Client인지는
        // 원장만 보고 알 수 없고, 그 대조는 registry를 쥔 check가 한다(RDL-RUN-031).
        //
        // foreignTransitionEventIds에는 넣지 않는다. 그 집합은 진행 계산에서 빼고
        // 우선순위로 따로 적용하는 전이(synced·halted)용이고, 승인은 커서를 전진
        // 시켜야 하므로 본 루프가 그대로 처리해야 한다.
        visible.push(record);
      } else {
        diagnostics.push({ code: 'RDL-RUN-023', severity: 'error', eventId: record.canonical.eventId, message: 'event clientId does not match the epoch owner' });
      }
    }
  };
  const visible = [start];
  const selectedTokens = new Set([start.ownerToken]);
  let activeToken = start.ownerToken;
  let activeClientId = start.canonical.clientId;
  let parentClientId = activeClientId;
  let conflict = null;
  for (let guard = 0; guard < records.length + 2; guard += 1) {
    const children = records.filter((record) => record.canonical.type === 'run.takeover' && (record.previousOwnerToken || record.canonical.previousOwnerToken) === activeToken);
    const ownSequence = [byToken.get(activeToken)].concat(epochOwn(activeToken, activeClientId)).filter(Boolean);
    const validChildren = [];
    for (const child of children) {
      const canonical = child.canonical;
      if (!child.legacy && canonical.previousClientId !== activeClientId) {
        diagnostics.push({ code: 'RDL-RUN-025', severity: 'error', eventId: canonical.eventId, message: 'takeover previousClientId does not match the epoch owner' });
        continue;
      }
      if (!child.legacy) {
        // cutoff는 병합 배열 인덱스가 아니라 이전 소유자 자기 시퀀스에서의 위치다.
        const headIndex = ownSequence.findIndex((record) => record.canonical.eventId === canonical.previousOwnerHeadEventId);
        if (headIndex < 0) {
          diagnostics.push({ code: 'RDL-RUN-020', severity: 'error', eventId: canonical.eventId, message: 'takeover cutoff head is missing from predecessor epoch' });
          continue;
        }
        child.cutoffIndex = headIndex;
      }
      validChildren.push(child);
    }
    if (!validChildren.length) {
      visible.push(...ownSequence.slice(1));
      admitForeign(activeToken, activeClientId);
      // takeover 시도가 있었는데 유효한 것이 하나도 없으면 fail-closed다 — 진단만
      // 남기고 ACTIVE로 두면 무효 인수가 조용히 무시된다. 올바른 head의 유효
      // takeover가 도착하면 이 충돌은 자연 해소된다(자기 치유). 그 유효 takeover를
      // 쓸 수 있도록 부모 epoch의 head를 충돌에 노출한다 — 없으면 탈출 이벤트를
      // 구성할 정보가 API 밖에 존재하지 않아 충돌이 영구 교착이 된다.
      if (children.length) {
        conflict = {
          conflictId: null, parentToken: activeToken, parentClientId: activeClientId, candidates: [], invalidTakeover: true,
          parentHeadEventId: (ownSequence[ownSequence.length - 1] || byToken.get(activeToken)).canonical.eventId
        };
      }
      break;
    }
    const cutoff = Math.min(...validChildren.map((child) => child.legacy ? ownSequence.length - 1 : child.cutoffIndex));
    // legacy takeover에는 cutoff head가 없어 선행자 꼬리를 구조적으로 자를 수 없다.
    // 침묵 대신 경고로 표면화한다 — v2 takeover(head 필수)로만 완전한 fence가 가능하다.
    if (validChildren.some((child) => child.legacy) && ownSequence.length > 1) {
      diagnostics.push({ code: 'RDL-RUN-027', severity: 'warning', eventId: validChildren.find((child) => child.legacy).canonical.eventId, message: 'legacy takeover has no cutoff head; the predecessor tail cannot be fenced' });
    }
    visible.push(...ownSequence.slice(1, cutoff + 1));
    admitForeign(activeToken, activeClientId);
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
  // ownerHead는 소유자 자기 시퀀스의 마지막 가시 이벤트다 — 외래 전이나 병합
  // 배열 위치가 아니라 작성자 append 순서에서 결정되므로, takeover에 기록되는
  // cutoff가 열거 순서에 오염되지 않는다.
  const ownVisible = conflict ? [] : [byToken.get(activeToken)].concat(epochOwn(activeToken, activeClientId)).filter(Boolean).filter((record) => visibleSet.has(record.canonical.eventId));
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
    foreignTransitionEventIds,
    ownerHeadEventId: conflict ? null : (ownVisible[ownVisible.length - 1] || byToken.get(activeToken)).canonical.eventId
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
  const stepCommits = {};
  const producedCommits = [];
  // 런 시작 시 고정한 대상 문서가 있으면 그것이 첫 산출물이다. 절차가 문서를
  // 만들지 않고 이미 있는 것을 다루기 때문이다.
  const artifactIds = [];
  // 루프는 run.started를 걸러 내고 돈다. 그래서 시드는 루프 안이 아니라 여기다 —
  // 안에 두면 절대 실행되지 않는 코드가 된다.
  const startedEvent = events.find((item) => item.type === 'run.started');
  if (startedEvent && startedEvent.targetArtifactId) artifactIds.push(startedEvent.targetArtifactId);
  // 사람의 승인은 소유자가 아닌 클라이언트가 쓴다. 그래서 병합 배열에서의 위치가
  // 소유자 이벤트와 어떤 순서로 놓일지는 시계 없이 정할 수 없다 — 외래 전이를
  // 위치가 아니라 우선순위로 적용하는 것과 같은 이유다. 위치로 적용하면 같은
  // 이벤트 집합이 읽는 순서에 따라 승인되기도, 안 되기도 한다.
  //
  // 순서에 기대지 않고도 안전한 이유는 결박이 시각이 아니라 커밋이기 때문이다.
  // 승인이 지목한 커밋과 검증·완료의 커밋이 같은지는 순서와 무관하게 답할 수 있고,
  // 그 대조가 이 승인이 무엇에 대한 것이었는지를 정한다.
  const humanApprovalEvents = events.filter((item) => item.type === 'run.forced'
    && item.basis === 'human-approval' && item.commit
    && byId.get(item.stepId) && byId.get(item.stepId).human === true);
  const humanApprovalIds = new Set(humanApprovalEvents.map((item) => item.eventId));
  for (const event of humanApprovalEvents) {
    completed.add(event.stepId);
    forcedSteps.push({ stepId: event.stepId, reason: event.reason || null, basis: 'human-approval', commit: event.commit });
  }
  const diagnostics = ownership ? ownership.diagnostics.slice() : [];
  let lastGate = null;
  // 소유권 충돌이어도 가시 이벤트까지의 진행(커서·완료)은 계산해 보존한다 —
  // 충돌을 해소하려는 사람이 "진행이 없던 런"으로 오독하지 않게. 상태 덮어쓰기는 맨 끝에서.
  let status = 'running';
  let haltReason = null;
  const cursor = () => order.find((identifier) => !completed.has(identifier)) || null;
  const foreignSet = ownership && ownership.foreignTransitionEventIds ? ownership.foreignTransitionEventIds : new Set();
  const foreignTransitions = [];
  let completedLocalSeen = false;
  const completedLocals = [];
  let spareResumes = 0;
  for (const event of events.filter((item) => !['run.started', 'run.takeover', 'run.ownership_resolved'].includes(item.type))) {
    if (foreignSet.has(event.eventId)) { foreignTransitions.push(event); continue; }
    // 사람의 승인은 루프 밖에서 이미 적용했다. 여기서 다시 보면 커서 검사에 걸려
    // 무효로 기록된다 — 소유자 이벤트보다 뒤에 놓였다는 이유만으로.
    if (humanApprovalIds.has(event.eventId)) continue;
    const current = cursor();
    const step = current ? byId.get(current) : null;
    const invalid = (message) => diagnostics.push({ code: 'RDL-RUN-022', severity: 'error', eventId: event.eventId, message });
    // strict는 런이 아니라 이벤트의 스키마를 따른다 — legacy로 시작한 런이라도
    // v2 이벤트에는 v2 커서·종류 검증이 적용된다.
    if (['run.step', 'run.gate', 'run.forced'].includes(event.type) && event.schemaVersion === 2) {
      if (status !== 'running' || event.stepId !== current) { invalid('progress event does not target the active cursor'); continue; }
      const kind = transitionKind(step);
      if (event.type === 'run.step' && kind !== 'step') { invalid(`run.step cannot complete a ${kind} step`); continue; }
      if (event.type === 'run.gate' && kind !== 'gate' && kind !== 'verify') { invalid('run.gate requires a gate or verification cursor'); continue; }
    }
    if (event.type === 'run.step' && event.exitCode === 0) {
      completed.add(event.stepId);
      // 어느 스텝이 어느 커밋을 만들었는지는 fold가 쥔다. 검증은 이것으로 "저장이
      // 방금 만든 커밋"을 지목하고, sync는 이것으로 "아직 사람이 승인하지 않은
      // 커밋"을 알아본다. 주변의 현재 HEAD를 믿으면 둘 다 할 수 없다.
      if (event.commit) { stepCommits[event.stepId] = event.commit; if (!producedCommits.includes(event.commit)) producedCommits.push(event.commit); }
      for (const artifactId of event.artifactIds || []) if (!artifactIds.includes(artifactId)) artifactIds.push(artifactId);
    } else if (event.type === 'run.gate') {
      lastGate = { stepId: event.stepId, exitCode: event.exitCode, diagnostics: event.diagnostics || [] };
      if (event.exitCode === 0) completed.add(event.stepId);
      else if (event.exitCode === 1 || event.schemaVersion !== 2) {
        attempts[event.stepId] = (attempts[event.stepId] || 0) + 1;
        const definition = byId.get(event.stepId);
        if (definition && definition.onFail) {
          const from = order.indexOf(definition.onFail.goto);
          for (const identifier of order.slice(from)) completed.delete(identifier);
        }
      } else invalid('gate exit 2 is an invocation failure and cannot advance or count as a verdict');
    } else if (event.type === 'run.forced') {
      completed.add(event.stepId); forcedSteps.push({ stepId: event.stepId, reason: event.reason || null, basis: event.basis || 'operator-override', commit: event.commit || null });
    } else if (event.type === 'run.halted') {
      status = 'halted'; haltReason = HALT_REASONS.has(event.reason) ? event.reason : 'manual';
    } else if (event.type === 'run.resumed') {
      if (status !== 'halted') spareResumes += 1;
      // 시도 횟수는 그냥 재개한다고 지워지지 않는다. 지우면 halt → resume을 되풀이
      // 하는 것만으로 maxAttempts가 무한이 된다 — 절차가 선언한 예산이 사문이 된다.
      // 예산을 다시 여는 것은 명시적으로 그렇게 말한 재개만 할 수 있고, 그때도
      // 지목된 스텝만 열리며 사유가 원장에 남는다.
      status = 'running'; haltReason = null;
      // 사유 없는 개방은 fold가 무시한다. CLI에서 막는 것만으로는 부족하다 —
      // git으로 병합되어 들어온 이벤트는 쓰기 경로를 지나오지 않는다.
      const granted = Array.isArray(event.grantedAttempts) ? event.grantedAttempts : [];
      if (granted.length && !String(event.reason || '').trim()) {
        diagnostics.push({ code: 'RDL-RUN-027', severity: 'error', eventId: event.eventId, message: 'run.resumed granted an attempt budget without a reason and was ignored' });
      } else for (const stepId of granted) delete attempts[stepId];
    } else if (event.type === 'run.completed_local') { status = 'completed_local'; completedLocalSeen = true; completedLocals.push({ ownerToken: event.ownerToken || null, commit: event.commit || null }); }
    else if (event.type === 'run.synced') status = 'synced';
  }
  // 외래 전이(sync 실행자의 synced/halted)는 위치가 아니라 우선순위로 적용한다 —
  // 다른 샤드의 기록과 소유자 시퀀스 사이의 순서는 시계 없이 정할 수 없기 때문이다.
  // 효력은 자기 epoch에 결박된다: synced는 같은 ownerToken의 가시 completed_local과
  // commit이 일치할 때만, halted는 활성 epoch의 토큰을 지닐 때만 상태를 바꾼다.
  // 구 epoch 커밋에 대한 늦은 synced가 새 epoch의 완료와 결합해 런 전체를 synced로
  // 만드는 일은 없어야 한다.
  if (foreignTransitions.length && status !== 'ownership-conflict') {
    const activeToken = ownership ? ownership.ownerToken : null;
    const foreignHalts = foreignTransitions
      .filter((event) => event.type === 'run.halted' && (event.ownerToken || null) === activeToken)
      .sort((left, right) => String(left.eventId).localeCompare(String(right.eventId)));
    // synced의 효력 기준은 "어떤 completed_local이든"이 아니라 상태를 결정한 마지막
    // completed_local이다 — 구 epoch에서 완료됐던 커밋의 늦은 synced가 신 epoch의
    // 완료와 결합해 런을 synced로 만들면 안 된다.
    const lastCompleted = completedLocals[completedLocals.length - 1] || null;
    const effectiveSynced = foreignTransitions.filter((event) => event.type === 'run.synced'
      && lastCompleted && lastCompleted.ownerToken === (event.ownerToken || null) && lastCompleted.commit === (event.commit || null));
    const ignoredSynced = foreignTransitions.filter((event) => event.type === 'run.synced' && !effectiveSynced.includes(event));
    const effectiveHalts = Math.max(0, foreignHalts.length - spareResumes);
    if (effectiveHalts > 0 && status !== 'synced') {
      const last = foreignHalts[foreignHalts.length - 1];
      status = 'halted';
      haltReason = HALT_REASONS.has(last.reason) ? last.reason : 'sync-failed';
    }
    if (effectiveSynced.length) { status = 'synced'; haltReason = null; }
    for (const event of ignoredSynced) diagnostics.push({ code: 'RDL-RUN-026', severity: 'warning', eventId: event.eventId, message: 'run.synced does not match a visible run.completed_local of its epoch (commit·ownerToken) and was ignored' });
  }
  for (const step of steps) if (step.onFail && !completed.has(step.id) && (attempts[step.id] || 0) >= step.onFail.maxAttempts && status === 'running') { status = 'halted'; haltReason = 'attempt-limit'; }
  // 검증이 결박된 커밋. 이것이 이 런이 "봤다"고 말할 수 있는 유일한 상태다.
  let verifiedCommit = null;
  for (const step of steps) {
    const pin = step.verify && step.verify.revisionPin;
    if (!pin) continue;
    if (pin.strategy === 'step-output-commit') verifiedCommit = stepCommits[pin.step] || null;
    else if (pin.strategy === 'git-commit') verifiedCommit = pin.reviewedRevision || null;
  }
  const humanSteps = forcedSteps.filter((item) => { const step = byId.get(item.stepId); return Boolean(step && step.human === true); });
  const humanApprovals = humanSteps.filter((item) => item.basis === 'human-approval').map((item) => ({ stepId: item.stepId, commit: item.commit }));
  // 사람이 승인한 커밋과 검증이 본 커밋이 다르면, 승인은 검증되지 않은 상태에 붙은
  // 것이다. 검증 통과 뒤에 HEAD가 움직였다는 뜻이고, 공유되는 것은 판정된 적 없는
  // 내용이 된다. 이것을 말하지 않으면 원장은 "검증하고 승인했다"고 읽힌다.
  for (const approval of humanApprovals) {
    if (verifiedCommit && approval.commit && approval.commit !== verifiedCommit) {
      diagnostics.push({ code: 'RDL-RUN-028', severity: 'error', message: `사람이 승인한 커밋이 검증이 본 커밋과 다릅니다: ${approval.stepId} 승인 ${approval.commit} vs 검증 ${verifiedCommit}` });
    }
  }
  const current = status === 'completed_local' || status === 'synced' ? null : cursor();
  // 충돌 상태 덮어쓰기는 진행 계산이 끝난 뒤다 — completed·cursor는 보존된다.
  if (ownership && ownership.status === 'CONFLICT') { status = 'ownership-conflict'; haltReason = 'ownership-conflict'; }
  return {
    runId: started.runId, projectId: started.projectId,
    procedure: { name: started.procedure.name, revision: started.procedure.revision, contentHash: started.procedure.contentHash },
    status, cursor: current, cursorStep: current ? byId.get(current) || null : null,
    completedSteps: order.filter((identifier) => completed.has(identifier)), attempts, forcedSteps, artifactIds, lastGate, haltReason,
    stepCommits, producedCommits: producedCommits.slice(),
    verifiedCommit, humanApprovals, humanGateSteps: steps.filter((step) => step.human === true).map((step) => step.id),
    completedCommit: completedLocals.length ? completedLocals[completedLocals.length - 1].commit : null,
    // 사람 게이트를 사람의 승인이 아닌 방법으로 지나간 런. 지나가긴 했으나 누가
    // 무엇을 승인했는지 원장이 답하지 못하므로, 공유 단계에서 다시 묻는다.
    unapprovedHumanSteps: humanSteps.filter((item) => item.basis !== 'human-approval').map((item) => item.stepId),
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

// operation 충돌은 상태를 덮지 못하는 경우(이미 completed_local/synced)에도
// 항상 노출된다 — 목록을 비우면 충돌의 증거 자체가 모든 소비자에게서 사라진다.
function finalizeFold(result, operationState) {
  result.operationConflicts = operationState.conflicts;
  if (!operationState.conflicts.length) return result;
  if (['completed_local', 'synced'].includes(result.status)) {
    result.diagnostics.push({ code: 'RDL-RUN-028', severity: 'warning', message: 'operation outcome conflict persists after completion; resolve it with run operation resolve' });
  } else {
    result.status = 'operation-conflict';
    result.haltReason = 'operation-conflict';
  }
  return result;
}

function foldRun(events) {
  if (!events.length) return { status: 'missing', cursor: null };
  // legacy 전용 런도 같은 경로다 — 우회하면 소유권·dedup·진단(017/018/019)이
  // 호출 지점에 따라 달라지는 이중 평가기가 된다.
  const ownership = ownershipState(events);
  const operationState = operationOutcomeState(ownership.visibleEvents);
  return finalizeFold(foldProgress(operationState.effectiveEvents, ownership), operationState);
}

function orderSharedEvents(events) {
  return ownershipState(events).visibleEvents;
}

function foldSharedRun(events) {
  const ownership = ownershipState(events);
  const operationState = operationOutcomeState(ownership.visibleEvents);
  return finalizeFold(foldProgress(operationState.effectiveEvents, ownership), operationState);
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
  // 파일 수준 runId 필터 + dedupe 없음: 다른 런 샤드의 손상이 이 런의 읽기를
  // 오염시키지 못하고(격리), 같은 런의 충돌은 예외가 아니라 normalizeRecords의
  // 진단(RDL-RUN-017/018)으로 fold에 흐른다. digest 검증도 kind-인지 정규화
  // 한 곳에서만 수행된다 — 같은 레코드에 digest 정의가 둘이면 외부 레코드가
  // 잘못된 코드로 낙인된다.
  return eventStore.readEvents(eventsRoot, 'run', projectKey, { sort: 'file', runId: runId, dedupe: false }).filter((event) => event.runId === runId);
}

// 공유 run 샤드에서 프로젝트의 run ID를 열거한다. 로컬 .rundol/runs는 git으로
// 전파되지 않으므로, 로컬 열거만 쓰는 소비자는 다른 클라이언트가 만든 런을
// 새 clone에서 영영 보지 못한다.
function listSharedRunIds(layout, projectKey) {
  const eventsRoot = workspaceEventsRoot(layout);
  if (!eventsRoot) return [];
  const directory = path.join(eventsRoot, 'run');
  if (!fs.existsSync(directory)) return [];
  const ids = new Set();
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(`run-${projectKey}-`)) continue;
    const match = /-(RUN-[A-F0-9]{20})-\d{6}\.jsonl$/u.exec(name);
    if (match) ids.add(match[1]);
  }
  return Array.from(ids).sort();
}

function stripNoncanonical(event) {
  const projected = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (['canonicalDigest', 'occurredAt', 'localDetail'].includes(key) || value === undefined) continue;
    projected[key] = value;
  }
  return projected;
}

function unionRunEvents(localEvents, sharedEvents) {
  // 공유 샤드를 앞에 둔다. 작성자별 append 순서의 정본은 그 작성자의 공유 샤드이고,
  // 로컬 파일은 복구 재기록으로 순서가 어긋날 수 있다. 정확히 같은 레코드만
  // 접어서 합치고, 같은 eventId의 상충 변형은 둘 다 보존한다 — 충돌은 여기서
  // 던질 일이 아니라 fold의 진단(RDL-RUN-017/018)이 판정할 일이다.
  const sharedById = new Map();
  for (const event of sharedEvents) {
    if (!event || !event.eventId) continue;
    if (!sharedById.has(event.eventId)) sharedById.set(event.eventId, []);
    sharedById.get(event.eventId).push(event);
  }
  const sameRecord = (twin, event) => ((twin.canonicalDigest && event.canonicalDigest)
    ? twin.canonicalDigest === event.canonicalDigest
    : canonicalJson(stripNoncanonical(twin)) === canonicalJson(stripNoncanonical(event)));
  // 정확히 같은 레코드의 로컬 변형이 localDetail을 들고 있으면 그 변형을 쓴다 —
  // localDetail은 canonical 밖의 로컬 payload라 공유 샤드에는 없다.
  const detailTwin = new Map();
  const localOnly = localEvents.filter((event) => {
    if (!event || !event.eventId) return true;
    const twins = sharedById.get(event.eventId);
    if (!twins) return true;
    const matched = twins.some((twin) => sameRecord(twin, event));
    if (matched && event.localDetail !== undefined) detailTwin.set(event.eventId, event);
    return !matched;
  });
  return sharedEvents.map((event) => {
    const twin = event && event.eventId ? detailTwin.get(event.eventId) : undefined;
    return twin && sameRecord(event, twin) ? twin : event;
  }).concat(localOnly);
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
  const runtime = runtimeWorkspace(layout.root);
  // 재시도는 준비된 canonical 바이트를 그대로 재사용한다 — attempt처럼 fold에
  // 의존하는 값을 다시 계산하면 크래시 이후의 재시도가 다른 바이트를 만들어
  // 멱등성이 깨진다. driver-lease가 이미 쓰는 decode-재사용 패턴과 같다.
  const replayRootId = input.rootRequestId || input.event.rootRequestId || null;
  const replayChildKey = input.childKey || `event:${input.event.type}:${input.runId}`;
  let prepared = null;
  let envelope = null;
  let root = null;
  if (replayRootId && fs.existsSync(requestJournal.journalFile(runtime, replayRootId))) {
    const existingRoot = requestJournal.loadJournal(runtime, replayRootId);
    const existingChild = existingRoot.journal.children[replayChildKey];
    if (existingChild) {
      // 재생은 같은 요청일 때만이다. 다른 인자(commandDigest)나 다른 payload로 같은
      // root를 재사용하면 과거 결과를 조용히 돌려주는 대신 exit 2로 거부한다.
      if (input.commandDigest && input.commandDigest !== existingRoot.journal.commandDigest) throw new Error('request journal root command digest mismatch');
      const bytes = requestJournal.decodeChild(existingChild, replayRootId);
      const replayEvent = JSON.parse(bytes.toString('utf8'));
      const GENERATED = new Set(['schemaVersion', 'eventId', 'rootRequestId', 'requestId', 'occurredAt', 'localDetail', 'projectId', 'runId', 'attempt', 'command', 'args']);
      for (const [key, value] of Object.entries(input.event)) {
        if (GENERATED.has(key) || value === undefined) continue;
        if (canonicalJson(value) !== canonicalJson(replayEvent[key])) throw new Error(`request journal child payload mismatch: ${key}`);
      }
      envelope = createEventEnvelope(replayEvent);
      if (envelope.canonicalDigest !== existingChild.canonicalDigest || envelope.canonical.eventId !== existingChild.eventId) throw new Error('request journal child digest mismatch');
      prepared = { base: Object.assign({}, replayEvent, { requestId: existingChild.requestId }), rootRequestId: replayRootId, childKey: replayChildKey };
      root = existingRoot;
    }
  }
  if (!prepared) {
    prepared = prepareV2Event(start, project, input.runId, input);
    envelope = createEventEnvelope(prepared.base);
  }
  const commandDigest = input.commandDigest || sha256(Buffer.from(canonicalJson({ projectId: project.key, runId: input.runId, type: prepared.base.type, clientId: prepared.base.clientId }), 'utf8'));
  if (!root) root = requestJournal.prepareRoot(runtime, { rootRequestId: prepared.rootRequestId, commandDigest, clientId: prepared.base.clientId });
  const child = requestJournal.prepareChild(root, { childKey: prepared.childKey, canonicalBytes: envelope.canonicalBytes, occurredAt: prepared.base.occurredAt, runId: input.runId });
  if (child.eventId !== envelope.canonical.eventId || (prepared.base.requestId && child.requestId !== prepared.base.requestId)) throw new Error('request journal identity mismatch');
  const shared = existingShared.some((event) => event.eventId === envelope.canonical.eventId)
    ? null
    : mirrorRunEvent(layout, project.key, envelope.shared);
  requestJournal.updateChild(root, prepared.childKey, 'canonical-committed');
  try {
    const directory = runDirectory(project.root, input.runId);
    const alreadyLocal = readRunEvents(directory).some((event) => event.eventId === envelope.canonical.eventId);
    const appended = alreadyLocal ? { event: envelope.local, file: path.join(directory, 'events.jsonl') } : appendRunEvent(directory, envelope.local);
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
    targetArtifactId: String(input.targetArtifactId || '').trim() || undefined,
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
  // 무효 takeover만 있는 CONFLICT는 유효한 takeover가 유일한 해소 수단이다 —
  // 여기서도 막으면 그 이벤트를 쓸 수 있는 API가 없어 런이 영구 교착된다.
  // 후보가 있는 실제 분기 충돌은 여전히 resolveOwnership이 먼저다.
  const invalidTakeoverOnly = state.status === 'CONFLICT' && state.conflict && state.conflict.invalidTakeover === true;
  if (state.status !== 'ACTIVE' && !invalidTakeoverOnly) throw new Error('소유권 충돌을 먼저 해결해야 인수할 수 있습니다.');
  const previousClientId = invalidTakeoverOnly ? state.conflict.parentClientId : state.ownerClientId;
  const previousOwnerToken = invalidTakeoverOnly ? state.conflict.parentToken : state.ownerToken;
  const previousOwnerHeadEventId = invalidTakeoverOnly ? state.conflict.parentHeadEventId : state.ownerHeadEventId;
  if (previousClientId === clientId) throw new Error(`${clientId}는 이미 이 런의 소유자입니다.`);
  const fold = foldProgress(state.visibleEvents, state);
  let basis = 'halted';
  if (fold.status !== 'halted') {
    if (!input.force) throw new Error(invalidTakeoverOnly
      ? '무효 takeover 충돌의 인수는 사람의 결정입니다. --force --reason을 사용하세요.'
      : '정지하지 않은 런은 자동으로 인수할 수 없습니다. --force --reason을 사용하세요.');
    if (!String(input.reason || '').trim()) throw new Error('--force takeover requires --reason');
    basis = 'forced';
  }
  const rootRequestId = input.rootRequestId || input.requestId || newRequestId();
  const childKey = `event:run.takeover:${input.runId}`;
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  const eventId = requestJournal.eventIdForRequest(requestId);
  const recorded = recordRunEvent(start, {
    project: project.key, runId: input.runId, rootRequestId, childKey,
    event: { type: 'run.takeover', eventId, clientId, ownerToken: eventId, previousClientId, previousOwnerToken, previousOwnerHeadEventId, basis, reason: basis === 'forced' ? String(input.reason).trim() : undefined }
  });
  reconcileRun(start, { project: project.key, runId: input.runId });
  return { runId: input.runId, project: project.key, clientId, previousClientId, previousOwnerToken, ownerToken: eventId, basis, event: recorded.event, rootRequestId, requestId };
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
    if (!input.force || !['agent', 'service'].includes(client.type)) throw new Error('a non-parent resolver requires an agent/service client with --force');
    if (!String(input.reason || '').trim()) throw new Error('forced ownership resolution requires reason');
    // 인가 매트릭스: force는 「다른 멤버」의 agent/service만이다 — 부모 epoch 소유
    // 멤버가 자기 소유의 다른 클라이언트로 자기 충돌을 승인하는 길을 막는다.
    if (client.owner === parentClient.owner) throw new Error('the parent epoch owner member cannot force-resolve through their own client');
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
  foldRun, runOwner, listRuns, listSharedRunIds, recordRunEvent, mirrorRunEvent, readSharedRunEvents, unionRunEvents, reconcileRun,
  candidateConflictId, ownershipState, orderSharedEvents, foldSharedRun, takeoverRun, resolveOwnership,
  normalizeOperationDecision, operationIdFor, outcomeDigestFor, createOperation,
  normalizeOperationCandidates, operationConflictId, operationOutcomeState, logicalAttemptForStep
};
