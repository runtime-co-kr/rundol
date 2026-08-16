'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeDriverEvent,
  driverEnvelope,
  appendDriverEvent,
  appendJournaledDriverEvent,
  readDriverEvents,
  foldDriverLeases
} = require('../src/driver-lease');
const requestJournal = require('../src/request-journal');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-driver-lease-'));
const ids = {
  rootRequestId: 'REQ-11111111111111111111',
  requestId: 'REQ-22222222222222222222',
  clientId: 'agent-a',
  projectId: 'crm',
  runId: 'RUN-0123456789ABCDEF0123',
  leaseId: 'LEASE-0123456789ABCDEF0123',
  ownerToken: 'EVT-AAAAAAAAAAAAAAAAAAAA'
};
function event(type, eventId, extra) {
  return Object.assign({ schemaVersion: 1, eventId, type }, ids, extra || {});
}

try {
  const acquired = event('driver.acquired', 'EVT-11111111111111111111', { expiresAt: '2030-01-01T00:00:00.000Z' });
  const renewed = event('driver.renewed', 'EVT-22222222222222222222', { previousDriverEventId: acquired.eventId, expiresAt: '2030-01-01T00:05:00.000Z' });
  const released = event('driver.released', 'EVT-33333333333333333333', { previousDriverEventId: renewed.eventId, reason: 'completed' });
  assert.strictEqual(normalizeDriverEvent(acquired).expiresAt, acquired.expiresAt);
  assert.match(driverEnvelope(acquired).canonicalDigest, /^[a-f0-9]{64}$/u);
  assert.throws(() => normalizeDriverEvent({ ...acquired, transcript: 'forbidden' }), /unknown fields/u);
  assert.throws(() => normalizeDriverEvent({ ...acquired, expiresAt: '2030-01-01T00:00:00Z' }), /milliseconds/u);

  let folded = foldDriverLeases([renewed, acquired], { now: '2029-01-01T00:00:00.000Z' });
  assert.strictEqual(folded.activeLeases.length, 1);
  assert.strictEqual(folded.activeLeases[0].currentEventId, renewed.eventId);
  folded = foldDriverLeases([released, renewed, acquired], { now: '2029-01-01T00:00:00.000Z' });
  assert.strictEqual(folded.activeLeases.length, 0);
  assert.strictEqual(folded.leases[0].status, 'released');

  const other = event('driver.acquired', 'EVT-44444444444444444444', { clientId: 'agent-b', leaseId: 'LEASE-FFFFFFFFFFFFFFFFFFFF', expiresAt: '2030-01-01T00:00:00.000Z' });
  folded = foldDriverLeases([other, acquired], { now: '2029-01-01T00:00:00.000Z' });
  assert.deepStrictEqual(folded.activeLeases.map((lease) => lease.leaseId), ['LEASE-0123456789ABCDEF0123', 'LEASE-FFFFFFFFFFFFFFFFFFFF'], 'partitioned active leases must all remain visible');

  const fork = event('driver.renewed', 'EVT-55555555555555555555', { previousDriverEventId: acquired.eventId, expiresAt: '2030-01-01T00:10:00.000Z' });
  folded = foldDriverLeases([acquired, renewed, fork], { now: '2029-01-01T00:00:00.000Z' });
  assert.strictEqual(folded.activeLeases.length, 0);
  assert(folded.diagnostics.some((item) => item.code === 'RDL-DRIVER-003'));

  const eventsRoot = path.join(temporary, 'events');
  const lockDirectory = path.join(temporary, 'locks');
  const stored = appendDriverEvent(eventsRoot, acquired, { lockDirectory });
  assert.strictEqual(stored.file, path.join(eventsRoot, 'driver', `driver-crm-agent-a-${ids.runId}-000001.jsonl`));
  appendDriverEvent(eventsRoot, acquired, { lockDirectory });
  assert.strictEqual(fs.readFileSync(stored.file, 'utf8').split(/\r?\n/u).filter(Boolean).length, 1, 'driver append must be idempotent');
  assert.strictEqual(readDriverEvents(eventsRoot, 'crm', ids.runId).length, 1);

  const journalEventsRoot = path.join(temporary, 'journal-events');
  const journalRuntime = { pending: path.join(temporary, 'runtime', 'pending') };
  const journalRootRequestId = 'REQ-AAAAAAAAAAAAAAAAAAAA';
  const commandDigest = 'b'.repeat(64);
  const operationId = 'c'.repeat(64);
  const acquireChildKey = `driver:${operationId}:acquire:`;
  const acquireRequestId = requestJournal.childRequestId(journalRootRequestId, acquireChildKey);
  const journalAcquire = {
    ...acquired,
    rootRequestId: journalRootRequestId,
    requestId: acquireRequestId,
    eventId: requestJournal.eventIdForRequest(acquireRequestId),
    operationId,
    expiresAt: '2031-01-01T00:00:00.000Z'
  };
  assert.throws(() => appendJournaledDriverEvent(journalEventsRoot, journalAcquire, {
    runtime: journalRuntime, rootRequestId: journalRootRequestId, childKey: acquireChildKey, commandDigest, lockDirectory,
    afterSharedAppend() { throw new Error('simulated crash after shared append'); }
  }), /simulated crash/u);
  let journal = requestJournal.loadJournal(journalRuntime, journalRootRequestId).journal;
  assert.strictEqual(journal.children[acquireChildKey].phase, 'prepared');
  const firstDriverEvent = readDriverEvents(journalEventsRoot, 'crm', ids.runId)[0];
  const replayed = appendJournaledDriverEvent(journalEventsRoot, { ...journalAcquire, expiresAt: '2040-01-01T00:00:00.000Z' }, {
    runtime: journalRuntime, rootRequestId: journalRootRequestId, childKey: acquireChildKey, commandDigest, lockDirectory
  });
  assert.strictEqual(replayed.replayed, true);
  assert.strictEqual(replayed.event.expiresAt, journalAcquire.expiresAt, 'retry must replay the prepared expiresAt instead of extending the lease');
  assert.strictEqual(replayed.event.canonicalDigest, firstDriverEvent.canonicalDigest);
  assert.strictEqual(readDriverEvents(journalEventsRoot, 'crm', ids.runId).length, 1, 'shared append retry remains idempotent');

  function journalIdentity(childKey) {
    const requestId = requestJournal.childRequestId(journalRootRequestId, childKey);
    return { rootRequestId: journalRootRequestId, requestId, eventId: requestJournal.eventIdForRequest(requestId) };
  }
  const renewChildKey = `driver:${operationId}:renew:${replayed.event.eventId}`;
  const journalRenew = { ...renewed, ...journalIdentity(renewChildKey), previousDriverEventId: replayed.event.eventId, operationId, expiresAt: '2031-01-01T00:05:00.000Z' };
  appendJournaledDriverEvent(journalEventsRoot, journalRenew, { runtime: journalRuntime, rootRequestId: journalRootRequestId, childKey: renewChildKey, commandDigest, lockDirectory });
  const releaseChildKey = `release:${operationId}:completed:${journalRenew.eventId}`;
  const journalRelease = { ...released, ...journalIdentity(releaseChildKey), previousDriverEventId: journalRenew.eventId, operationId };
  appendJournaledDriverEvent(journalEventsRoot, journalRelease, { runtime: journalRuntime, rootRequestId: journalRootRequestId, childKey: releaseChildKey, commandDigest, lockDirectory });
  journal = requestJournal.loadJournal(journalRuntime, journalRootRequestId).journal;
  assert.deepStrictEqual(Object.fromEntries(Object.entries(journal.children).map(([key, child]) => [key, child.phase])), {
    [acquireChildKey]: 'complete', [renewChildKey]: 'complete', [releaseChildKey]: 'complete'
  });

  const conflicting = { ...acquired, expiresAt: '2030-01-02T00:00:00.000Z' };
  folded = foldDriverLeases([acquired, conflicting, acquired], { now: '2029-01-01T00:00:00.000Z' });
  assert.strictEqual(folded.activeLeases.length, 0);
  assert(folded.diagnostics.some((item) => item.code === 'RDL-DRIVER-002'));

  const mismatchedRun = 'RUN-FFFFFFFFFFFFFFFFFFFF';
  const wrongEnvelope = driverEnvelope({ ...acquired, runId: mismatchedRun });
  fs.writeFileSync(path.join(eventsRoot, 'driver', `driver-crm-agent-a-${ids.runId}-000002.jsonl`), `${JSON.stringify(wrongEnvelope.shared)}\n`, 'utf8');
  assert.throws(() => readDriverEvents(eventsRoot, 'crm', mismatchedRun), /runId does not match/u);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('driver lease tests passed');
