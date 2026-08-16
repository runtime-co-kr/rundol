'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('./event-store');

const REQUEST_ID = /^REQ-[A-F0-9]{20}$/u;
const EVENT_ID = /^EVT-[A-F0-9]{20}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function prefixedId(prefix, value) {
  return `${prefix}-${sha256(Buffer.from(value, 'utf8')).slice(0, 20).toUpperCase()}`;
}

function childRequestId(rootRequestId, childKey) {
  if (!REQUEST_ID.test(rootRequestId || '')) throw new Error(`invalid rootRequestId: ${rootRequestId || '(missing)'}`);
  if (!String(childKey || '').trim()) throw new Error('childKey is required');
  return prefixedId('REQ', `child\0${rootRequestId}\0${childKey}`);
}

function eventIdForRequest(requestId) {
  if (!REQUEST_ID.test(requestId || '')) throw new Error(`invalid requestId: ${requestId || '(missing)'}`);
  return prefixedId('EVT', `event\0${requestId}`);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } catch {} finally { fs.closeSync(directory); }
}

function journalFile(runtime, rootRequestId) {
  if (!REQUEST_ID.test(rootRequestId || '')) throw new Error(`invalid rootRequestId: ${rootRequestId || '(missing)'}`);
  return path.join(runtime.pending, 'requests', `${rootRequestId}.json`);
}

function loadJournal(runtime, rootRequestId) {
  const file = journalFile(runtime, rootRequestId);
  if (!fs.existsSync(file)) return null;
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (journal.schemaVersion !== 1 || journal.rootRequestId !== rootRequestId || !DIGEST.test(journal.commandDigest || '') || !journal.children || typeof journal.children !== 'object' || (journal.invocations !== undefined && (!journal.invocations || typeof journal.invocations !== 'object' || Array.isArray(journal.invocations)))) {
    throw new Error(`request journal corruption: ${rootRequestId}`);
  }
  return { file, journal };
}

function prepareRoot(runtime, input) {
  const file = journalFile(runtime, input.rootRequestId);
  const existing = loadJournal(runtime, input.rootRequestId);
  if (existing) {
    if (existing.journal.commandDigest !== input.commandDigest || existing.journal.clientId !== input.clientId) {
      throw new Error(`request journal command mismatch: ${input.rootRequestId}`);
    }
    return existing;
  }
  if (!DIGEST.test(input.commandDigest || '')) throw new Error('commandDigest must be a lowercase SHA-256 digest');
  const journal = { schemaVersion: 1, rootRequestId: input.rootRequestId, commandDigest: input.commandDigest, clientId: input.clientId, phase: 'prepared', children: {}, invocations: {} };
  atomicWriteJson(file, journal);
  return { file, journal };
}

function decodeChild(child, rootRequestId) {
  if (!child || !REQUEST_ID.test(child.requestId || '') || !EVENT_ID.test(child.eventId || '') || !DIGEST.test(child.canonicalDigest || '')) {
    throw new Error(`request journal child corruption: ${rootRequestId}`);
  }
  const bytes = Buffer.from(child.canonicalUtf8Base64 || '', 'base64');
  if (bytes.toString('base64') !== child.canonicalUtf8Base64 || sha256(bytes) !== child.canonicalDigest) {
    throw new Error(`request journal canonical bytes corruption: ${rootRequestId}`);
  }
  let canonical;
  try { canonical = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`request journal canonical JSON corruption: ${rootRequestId}: ${error.message}`); }
  const expectedRequestId = childRequestId(rootRequestId, child.childKey);
  if (canonicalJson(canonical) !== bytes.toString('utf8') || child.requestId !== expectedRequestId || child.eventId !== eventIdForRequest(expectedRequestId) || canonical.rootRequestId !== rootRequestId || canonical.requestId !== child.requestId || canonical.eventId !== child.eventId) {
    throw new Error(`request journal canonical identity corruption: ${rootRequestId}`);
  }
  return bytes;
}

function prepareChild(root, input) {
  const requestId = childRequestId(root.journal.rootRequestId, input.childKey);
  const eventId = eventIdForRequest(requestId);
  const bytes = Buffer.isBuffer(input.canonicalBytes) ? input.canonicalBytes : Buffer.from(input.canonicalBytes, 'utf8');
  const canonicalDigest = sha256(bytes);
  const current = root.journal.children[input.childKey];
  if (current) {
    const currentBytes = decodeChild(current, root.journal.rootRequestId);
    if (current.requestId !== requestId || current.eventId !== eventId || current.canonicalDigest !== canonicalDigest || !currentBytes.equals(bytes)) {
      throw new Error(`request journal child mismatch: ${input.childKey}`);
    }
    return current;
  }
  const child = {
    childKey: input.childKey,
    requestId,
    eventId,
    phase: 'prepared',
    canonicalUtf8Base64: bytes.toString('base64'),
    canonicalDigest,
    occurredAt: input.occurredAt
  };
  if (input.runId) child.runId = input.runId;
  root.journal.children[input.childKey] = child;
  root.journal.phase = 'pending';
  atomicWriteJson(root.file, root.journal);
  return child;
}

function updateChild(root, childKey, phase) {
  const child = root.journal.children[childKey];
  if (!child) throw new Error(`unknown request child: ${childKey}`);
  if (!['prepared', 'canonical-committed', 'complete'].includes(phase)) throw new Error(`invalid request child phase: ${phase}`);
  child.phase = phase;
  const invocations = Object.values(root.journal.invocations || {});
  root.journal.phase = Object.values(root.journal.children).every((entry) => entry.phase === 'complete') && invocations.every((entry) => entry.phase === 'complete') ? 'complete' : 'pending';
  atomicWriteJson(root.file, root.journal);
  return child;
}

function prepareInvocation(root, input) {
  if (!input || typeof input.invocationKey !== 'string' || !input.invocationKey) throw new Error('invocationKey is required');
  const descriptorBytes = Buffer.from(canonicalJson(input.descriptor), 'utf8');
  const descriptorDigest = sha256(descriptorBytes);
  root.journal.invocations = root.journal.invocations || {};
  const existing = root.journal.invocations[input.invocationKey];
  if (existing) {
    if (existing.descriptorDigest !== descriptorDigest || existing.descriptorCanonical !== descriptorBytes.toString('base64')) throw new Error(`request journal invocation mismatch: ${input.invocationKey}`);
    return existing;
  }
  const invocation = { invocationKey: input.invocationKey, phase: 'prepared', descriptorDigest, descriptorCanonical: descriptorBytes.toString('base64') };
  root.journal.invocations[input.invocationKey] = invocation;
  root.journal.phase = 'pending';
  atomicWriteJson(root.file, root.journal);
  return invocation;
}

function decodeInvocation(invocation, rootRequestId) {
  if (!invocation || !DIGEST.test(invocation.descriptorDigest || '') || typeof invocation.descriptorCanonical !== 'string') throw new Error(`request journal invocation corruption: ${rootRequestId}`);
  const bytes = Buffer.from(invocation.descriptorCanonical, 'base64');
  if (bytes.toString('base64') !== invocation.descriptorCanonical || sha256(bytes) !== invocation.descriptorDigest) throw new Error(`request journal invocation descriptor corruption: ${rootRequestId}`);
  const descriptor = JSON.parse(bytes.toString('utf8'));
  if (canonicalJson(descriptor) !== bytes.toString('utf8')) throw new Error(`request journal invocation descriptor is not canonical: ${rootRequestId}`);
  return descriptor;
}

function updateInvocation(root, invocationKey, phase, details) {
  const invocation = root.journal.invocations && root.journal.invocations[invocationKey];
  if (!invocation) throw new Error(`unknown request invocation: ${invocationKey}`);
  if (!['prepared', 'running', 'result-ready', 'complete', 'terminal'].includes(phase)) throw new Error(`invalid request invocation phase: ${phase}`);
  invocation.phase = phase;
  delete invocation.pid;
  delete invocation.failureCode;
  if (details && details.pid !== undefined) {
    if (!Number.isSafeInteger(details.pid) || details.pid < 1) throw new Error('invocation pid must be a positive integer');
    invocation.pid = details.pid;
  }
  if (details && details.failureCode !== undefined) invocation.failureCode = String(details.failureCode).slice(0, 100);
  const children = Object.values(root.journal.children);
  const invocations = Object.values(root.journal.invocations);
  root.journal.phase = children.every((entry) => entry.phase === 'complete') && invocations.every((entry) => entry.phase === 'complete') ? 'complete' : 'pending';
  atomicWriteJson(root.file, root.journal);
  return invocation;
}

module.exports = { REQUEST_ID, EVENT_ID, DIGEST, sha256, childRequestId, eventIdForRequest, journalFile, loadJournal, prepareRoot, prepareChild, decodeChild, updateChild, prepareInvocation, decodeInvocation, updateInvocation };
