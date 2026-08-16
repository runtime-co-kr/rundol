'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const journal = require('../src/request-journal');
const {
  normalizeVerdictEvent,
  verdictEnvelope,
  validatorInstanceId,
  foldVerdicts,
  invocationDescriptor,
  consumeInvocationResult,
  pidAlive
} = require('../src/verify');

const rootRequestId = 'REQ-11111111111111111111';
const reviewedRevision = 'a'.repeat(40);
const adapter = { name: 'fixture', instructionId: 'verify-satisfaction-v1', instructionRevision: 1, instructionDigest: 'b'.repeat(64) };

function event(overrides) {
  const lens = overrides && overrides.lens || 'satisfaction-v1';
  const slot = overrides && overrides.slot || 1;
  const changes = Object.assign({}, overrides || {});
  delete changes.slot;
  return Object.assign({
    schemaVersion: 1,
    eventId: `EVT-${String(slot).padStart(20, 'A')}`,
    type: 'verdict.recorded',
    rootRequestId,
    requestId: `REQ-${String(slot).padStart(20, 'B')}`,
    clientId: 'agent-one',
    projectId: 'sample',
    targetId: 'REQ-010',
    reviewedRevision,
    lens,
    verdict: 'pass',
    findings: [],
    adapter,
    validatorInstanceId: validatorInstanceId(rootRequestId, 'REQ-010', reviewedRevision, lens, slot)
  }, changes);
}

const normalized = normalizeVerdictEvent(event());
assert.strictEqual(normalized.verdict, 'pass');
const envelope = verdictEnvelope(event());
assert.match(envelope.canonicalDigest, /^[a-f0-9]{64}$/u);
assert.strictEqual(envelope.shared.canonicalDigest, envelope.canonicalDigest);
assert(!Object.prototype.hasOwnProperty.call(envelope.canonical, 'canonicalDigest'));

assert.throws(() => normalizeVerdictEvent(Object.assign(event(), { transcript: 'forbidden' })), /unknown fields/u);
assert.throws(() => normalizeVerdictEvent(Object.assign(event(), { findings: [{ summary: 'x', location: { file: '../secret' } }] })), /project-relative/u);
assert.throws(() => normalizeVerdictEvent(Object.assign(event(), { adapter: Object.assign({}, adapter, { name: 'fixture', prompt: 'forbidden' }) })), /unknown fields/u);

const policy = { rootRequestId, targetId: 'REQ-010', reviewedRevision, lenses: ['satisfaction-v1'], allowedAdapters: ['fixture'] };
assert.strictEqual(foldVerdicts([event()], policy).status, 'passed');
assert.strictEqual(foldVerdicts([event({ verdict: 'refuted', findings: [{ summary: 'not satisfied' }] })], policy).status, 'refuted');
assert.strictEqual(foldVerdicts([event({ verdict: 'abstain' })], policy).status, 'human_required');
assert.strictEqual(foldVerdicts([], policy).status, 'human_required');

const majority = {
  rootRequestId, targetId: 'REQ-010', reviewedRevision, lenses: ['satisfaction-v1'], allowedAdapters: ['fixture'],
  perLens: { 'satisfaction-v1': { validators: 3, quorum: 2, maxRefuted: 0, maxAbstain: 1, requireAdapterDiversity: false } }
};
assert.strictEqual(foldVerdicts([event({ slot: 1 }), event({ slot: 2 }), event({ slot: 3, verdict: 'abstain' })], majority).status, 'passed');
assert.strictEqual(foldVerdicts([event({ slot: 1 }), event({ slot: 2 })], majority).status, 'human_required');

const duplicate = event({ slot: 1 });
const conflict = Object.assign({}, duplicate, { eventId: 'EVT-CCCCCCCCCCCCCCCCCCCC', requestId: 'REQ-DDDDDDDDDDDDDDDDDDDD', verdict: 'refuted' });
const duplicateFold = foldVerdicts([duplicate, conflict], policy);
assert.strictEqual(duplicateFold.status, 'human_required');
assert(duplicateFold.diagnostics.some((item) => item.code === 'RDL-VERDICT-002'));

const otherRoot = event({ rootRequestId: 'REQ-22222222222222222222' });
assert.strictEqual(foldVerdicts([otherRoot], policy).status, 'human_required', 'another root request must not satisfy this policy');
const inventedSlot = event({ validatorInstanceId: 'VAL-FFFFFFFFFFFFFFFFFFFF' });
const inventedFold = foldVerdicts([inventedSlot], policy);
assert.strictEqual(inventedFold.status, 'human_required');
assert(inventedFold.diagnostics.some((item) => item.code === 'RDL-VERDICT-003'));

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-verify-resume-'));
try {
  const invocationKey = `verdict:REQ-010:${reviewedRevision}:satisfaction-v1:1`;
  const descriptor = invocationDescriptor({
    childKey: invocationKey,
    invocationId: 'INV-11111111111111111111',
    validatorInstanceId: validatorInstanceId(rootRequestId, 'REQ-010', reviewedRevision, 'satisfaction-v1', 1),
    lens: 'satisfaction-v1', slot: 1, targetPath: 'REQ-010.md',
    instruction: { id: adapter.instructionId, revision: adapter.instructionRevision, instructionDigest: adapter.instructionDigest },
    adapter,
    command: { project: 'sample', targetId: 'REQ-010', reviewedRevision, clientId: 'agent-one', adapter: 'fixture', lenses: ['satisfaction-v1'] }
  });
  const runtime = { pending: path.join(temporary, 'pending') };
  const root = journal.prepareRoot(runtime, { rootRequestId, commandDigest: 'c'.repeat(64), clientId: 'agent-one' });
  journal.prepareInvocation(root, { invocationKey, descriptor });
  assert.strictEqual(root.journal.phase, 'pending');
  journal.updateInvocation(root, invocationKey, 'running', { pid: process.pid });
  assert.strictEqual(pidAlive(process.pid), true);
  assert.deepStrictEqual(journal.decodeInvocation(root.journal.invocations[invocationKey], rootRequestId), descriptor);

  const directory = path.join(temporary, '.rundol', 'verify', descriptor.invocationId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'instruction.json'), JSON.stringify({ id: adapter.instructionId, revision: adapter.instructionRevision, instructionDigest: adapter.instructionDigest }), 'utf8');
  fs.writeFileSync(path.join(directory, 'context.json'), JSON.stringify({ target: descriptor.targetPath, lensId: descriptor.lens, pin: { targetId: 'REQ-010', reviewedRevision }, instructionId: adapter.instructionId }), 'utf8');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ verdict: 'pass', findings: [] }), 'utf8');
  const consumed = consumeInvocationResult({ root: temporary }, descriptor);
  assert.strictEqual(consumed.state, 'result', 'a complete strict result left by a dead child must be consumable without respawn');
  assert.strictEqual(consumed.result.verdict, 'pass');
  fs.writeFileSync(path.join(directory, 'result.json'), '{"verdict":', 'utf8');
  assert.throws(() => consumeInvocationResult({ root: temporary }, descriptor), /JSON|Unexpected|invalid/u, 'a partial result must be terminal rather than overwritten');
  journal.updateInvocation(root, invocationKey, 'complete');
  assert.strictEqual(root.journal.phase, 'complete');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('verify tests passed');
