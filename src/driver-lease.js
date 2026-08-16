'use strict';

const crypto = require('crypto');
const eventStore = require('./event-store');
const requestJournal = require('./request-journal');

const EVENT_ID = /^EVT-[A-F0-9]{20}$/u;
const REQUEST_ID = /^REQ-[A-F0-9]{20}$/u;
const RUN_ID = /^RUN-[A-F0-9]{20}$/u;
const LEASE_ID = /^LEASE-[A-F0-9]{20}$/u;
const SIMPLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const BASE_FIELDS = ['schemaVersion', 'eventId', 'type', 'rootRequestId', 'requestId', 'clientId', 'projectId', 'runId', 'leaseId', 'ownerToken'];
const TYPE_FIELDS = {
  'driver.acquired': { required: ['expiresAt'], optional: ['operationId'] },
  'driver.renewed': { required: ['previousDriverEventId', 'expiresAt'], optional: ['operationId'] },
  'driver.released': { required: ['previousDriverEventId', 'reason'], optional: ['operationId'] }
};

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function exactObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${label} has unknown fields: ${extras.sort().join(', ')}`);
}
function exactExpiry(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new Error('expiresAt must be ISO-8601 UTC with milliseconds');
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) throw new Error('expiresAt is invalid');
  return value;
}
function normalizeDriverEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('driver event must be an object');
  const definition = TYPE_FIELDS[input.type];
  if (!definition) throw new Error(`unknown driver event type: ${input.type || '(missing)'}`);
  exactObject(input, BASE_FIELDS.concat(definition.required, definition.optional, ['canonicalDigest', 'occurredAt']), input.type);
  for (const field of BASE_FIELDS.concat(definition.required)) if (input[field] === undefined) throw new Error(`${input.type}.${field} is required`);
  if (input.schemaVersion !== 1 || !EVENT_ID.test(input.eventId || '') || !REQUEST_ID.test(input.rootRequestId || '') || !REQUEST_ID.test(input.requestId || '') || !SIMPLE_ID.test(input.clientId || '') || !SIMPLE_ID.test(input.projectId || '') || !RUN_ID.test(input.runId || '') || !LEASE_ID.test(input.leaseId || '') || !EVENT_ID.test(input.ownerToken || '')) throw new Error(`${input.type} identity is invalid`);
  const normalized = {};
  for (const field of BASE_FIELDS) normalized[field] = input[field];
  if (input.type === 'driver.acquired') normalized.expiresAt = exactExpiry(input.expiresAt);
  if (input.type === 'driver.renewed') {
    if (!EVENT_ID.test(input.previousDriverEventId || '')) throw new Error('driver.renewed predecessor is invalid');
    normalized.previousDriverEventId = input.previousDriverEventId;
    normalized.expiresAt = exactExpiry(input.expiresAt);
  }
  if (input.type === 'driver.released') {
    if (!EVENT_ID.test(input.previousDriverEventId || '') || !['completed', 'halted', 'lost', 'error'].includes(input.reason)) throw new Error('driver.released fields are invalid');
    normalized.previousDriverEventId = input.previousDriverEventId;
    normalized.reason = input.reason;
  }
  if (input.operationId !== undefined) {
    if (!DIGEST.test(input.operationId || '')) throw new Error('operationId must be a lowercase SHA-256 digest');
    normalized.operationId = input.operationId;
  }
  return normalized;
}
function driverEnvelope(input) {
  const canonical = normalizeDriverEvent(input);
  const canonicalBytes = Buffer.from(eventStore.canonicalJson(canonical), 'utf8');
  const canonicalDigest = sha256(canonicalBytes);
  return {
    canonical,
    canonicalBytes,
    canonicalDigest,
    shared: Object.assign({}, canonical, { canonicalDigest }, input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt })
  };
}
function appendDriverEvent(eventsRoot, input, options) {
  const envelope = driverEnvelope(input);
  const file = eventStore.appendEvent(eventsRoot, 'driver', envelope.canonical.projectId, envelope.canonical.clientId, envelope.shared, {
    runId: envelope.canonical.runId,
    lockDirectory: options && options.lockDirectory,
    fsync: options && options.fsync !== false
  });
  return { file, event: envelope.shared, canonicalBytes: envelope.canonicalBytes };
}

function replayComparable(event) {
  const normalized = normalizeDriverEvent(event);
  if (normalized.type === 'driver.acquired' || normalized.type === 'driver.renewed') delete normalized.expiresAt;
  return normalized;
}

function appendJournaledDriverEvent(eventsRoot, input, options) {
  const settings = options || {};
  if (!settings.runtime || !settings.rootRequestId || !settings.childKey || !DIGEST.test(settings.commandDigest || '')) throw new Error('journaled driver append requires runtime, rootRequestId, childKey, and commandDigest');
  const root = requestJournal.prepareRoot(settings.runtime, { rootRequestId: settings.rootRequestId, commandDigest: settings.commandDigest, clientId: input.clientId });
  const existing = root.journal.children[settings.childKey];
  let envelope;
  let child;
  if (existing) {
    const canonicalBytes = requestJournal.decodeChild(existing, settings.rootRequestId);
    const canonical = JSON.parse(canonicalBytes.toString('utf8'));
    if (eventStore.canonicalJson(replayComparable(canonical)) !== eventStore.canonicalJson(replayComparable(input))) throw new Error(`driver request journal child mismatch: ${settings.childKey}`);
    envelope = driverEnvelope(canonical);
    if (!envelope.canonicalBytes.equals(canonicalBytes)) throw new Error(`driver request journal canonical bytes mismatch: ${settings.childKey}`);
    child = existing;
  } else {
    envelope = driverEnvelope(input);
    child = requestJournal.prepareChild(root, { childKey: settings.childKey, canonicalBytes: envelope.canonicalBytes, occurredAt: input.occurredAt, runId: envelope.canonical.runId });
  }
  const stored = appendDriverEvent(eventsRoot, envelope.canonical, settings);
  if (!stored.canonicalBytes.equals(envelope.canonicalBytes)) throw new Error(`driver canonical replay changed bytes: ${settings.childKey}`);
  if (typeof settings.afterSharedAppend === 'function') settings.afterSharedAppend(stored);
  requestJournal.updateChild(root, settings.childKey, 'canonical-committed');
  if (typeof settings.afterCanonicalCommit === 'function') settings.afterCanonicalCommit(stored);
  requestJournal.updateChild(root, settings.childKey, 'complete');
  return { ...stored, rootRequestId: settings.rootRequestId, requestId: child.requestId, eventId: child.eventId, childKey: settings.childKey, replayed: Boolean(existing), canonicalCommitted: true };
}
function readDriverEvents(eventsRoot, projectId, runId) {
  if (!SIMPLE_ID.test(projectId || '') || !RUN_ID.test(runId || '')) throw new Error('driver read identity is invalid');
  // 원시 레코드를 돌려준다 — 검증·dedup·충돌 판정은 foldDriverLeases의 관용
  // 경로(RDL-DRIVER-001/002)가 단일 정의로 수행한다. 읽기에서 던지면 손상
  // 하나가 전체 읽기 경로를 오염시키고, 진단으로 설계된 코드가 도달 불능이 된다.
  // 파일 수준 runId 필터가 다른 런 샤드의 손상을 격리한다.
  return eventStore.readEvents(eventsRoot, 'driver', projectId, { sort: 'file', runId, dedupe: false })
    .filter((event) => event && event.runId === runId);
}
function foldDriverLeases(input, options) {
  const diagnostics = [];
  const byEventId = new Map();
  for (const raw of input || []) {
    let event;
    try {
      event = normalizeDriverEvent(raw);
      const expected = driverEnvelope(event).canonicalDigest;
      if (raw.canonicalDigest !== undefined && raw.canonicalDigest !== expected) throw new Error('canonicalDigest mismatch');
      event.canonicalDigest = expected;
    } catch (error) {
      diagnostics.push({ code: 'RDL-DRIVER-001', severity: 'error', eventId: raw && raw.eventId || null, message: error.message });
      continue;
    }
    if (!byEventId.has(event.eventId)) byEventId.set(event.eventId, event);
    else {
      const previous = byEventId.get(event.eventId);
      if (!previous || previous.canonicalDigest === event.canonicalDigest) continue;
      byEventId.set(event.eventId, null);
      diagnostics.push({ code: 'RDL-DRIVER-002', severity: 'error', eventId: event.eventId, message: 'driver eventId has conflicting canonical projections' });
    }
  }
  const validEvents = Array.from(byEventId.values()).filter(Boolean);
  const groups = new Map();
  for (const event of validEvents) {
    const list = groups.get(event.leaseId) || [];
    list.push(event);
    groups.set(event.leaseId, list);
  }
  const nowValue = options && options.now !== undefined ? options.now : Date.now();
  const now = nowValue instanceof Date ? nowValue.getTime() : typeof nowValue === 'string' ? Date.parse(nowValue) : Number(nowValue);
  if (!Number.isFinite(now)) throw new Error('driver lease fold requires a valid current instant');
  const leases = [];
  for (const [leaseId, events] of Array.from(groups).sort((left, right) => left[0].localeCompare(right[0]))) {
    const acquired = events.filter((event) => event.type === 'driver.acquired');
    let invalidReason = null;
    if (acquired.length !== 1) invalidReason = 'lease chain must contain exactly one acquire';
    let current = acquired[0] || null;
    const consumed = new Set(current ? [current.eventId] : []);
    let closed = false;
    while (current && !invalidReason) {
      const children = events.filter((event) => event.previousDriverEventId === current.eventId);
      if (children.length > 1) { invalidReason = 'lease chain has concurrent children'; break; }
      if (children.length === 0) break;
      const child = children[0];
      if (closed) { invalidReason = 'lease chain continues after release'; break; }
      if (child.clientId !== current.clientId || child.ownerToken !== current.ownerToken || child.projectId !== current.projectId || child.runId !== current.runId) { invalidReason = 'lease successor identity differs from predecessor'; break; }
      consumed.add(child.eventId);
      current = child;
      if (child.type === 'driver.released') closed = true;
    }
    if (!invalidReason && consumed.size !== events.length) invalidReason = 'lease chain contains an orphan or skipped predecessor';
    if (invalidReason) {
      diagnostics.push({ code: 'RDL-DRIVER-003', severity: 'error', leaseId, message: invalidReason });
      leases.push({ leaseId, status: 'invalid', active: false, eventIds: events.map((event) => event.eventId).sort() });
      continue;
    }
    const expiresAt = current.type === 'driver.released' ? null : current.expiresAt;
    const active = !closed && Date.parse(expiresAt) > now;
    leases.push({
      leaseId,
      projectId: current.projectId,
      runId: current.runId,
      clientId: current.clientId,
      ownerToken: current.ownerToken,
      status: closed ? 'released' : active ? 'active' : 'expired',
      active,
      currentEventId: current.eventId,
      expiresAt,
      operationId: current.operationId || null,
      reason: current.type === 'driver.released' ? current.reason : null
    });
  }
  return { leases, activeLeases: leases.filter((lease) => lease.active), diagnostics };
}
function appendMutation(eventsRoot, input, options) {
  return options && options.runtime
    ? appendJournaledDriverEvent(eventsRoot, input, options)
    : appendDriverEvent(eventsRoot, input, options);
}
function acquireDriverLease(eventsRoot, input, options) { return appendMutation(eventsRoot, Object.assign({}, input, { type: 'driver.acquired' }), options); }
function renewDriverLease(eventsRoot, input, options) { return appendMutation(eventsRoot, Object.assign({}, input, { type: 'driver.renewed' }), options); }
function releaseDriverLease(eventsRoot, input, options) { return appendMutation(eventsRoot, Object.assign({}, input, { type: 'driver.released' }), options); }

module.exports = {
  EVENT_ID, REQUEST_ID, RUN_ID, LEASE_ID, DIGEST,
  normalizeDriverEvent, driverEnvelope, appendDriverEvent, appendJournaledDriverEvent, readDriverEvents, foldDriverLeases,
  acquireDriverLease, renewDriverLease, releaseDriverLease
};
