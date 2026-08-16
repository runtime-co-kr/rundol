'use strict';

const crypto = require('crypto');

const INSTRUCTION_ID = /^[a-z][a-z0-9.-]*-v[1-9][0-9]*$/u;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalJson(value), 'utf8')).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const DEFINITIONS = {
  'author-v1': {
    revision: 1,
    allowedMode: 'author',
    evidenceStance: 'Make only the requested bounded artifact change and report explicit claims and artifact identifiers.',
    requiredContractHeadings: ['scope', 'acceptance criteria', 'traceability'],
    instruction: 'Read only the paths listed in context.json. Implement the bounded contract at the pinned target. Do not change governance metadata outside that target. Write result.json with exactly claims and artifactIds.'
  },
  'verify-satisfaction-v1': {
    revision: 1,
    allowedMode: 'verify',
    evidenceStance: 'Judge only whether the pinned target supplies direct evidence for every stated acceptance obligation; absence is not success.',
    requiredContractHeadings: ['acceptance criteria'],
    instruction: 'Inspect the pinned target and allowed context paths independently. Check each acceptance obligation against direct evidence. Write result.json with exactly verdict and findings. Do not modify the worktree.'
  },
  'verify-omission-v1': {
    revision: 1,
    allowedMode: 'verify',
    evidenceStance: 'Look for required contract material that is missing, silently absorbed, or replaced by an unsupported not-applicable claim.',
    requiredContractHeadings: ['scope', 'out of scope', 'acceptance criteria'],
    instruction: 'Inspect the pinned target and allowed context paths independently for required but omitted material. Write result.json with exactly verdict and findings. Do not modify the worktree.'
  },
  'verify-boundary-v1': {
    revision: 1,
    allowedMode: 'verify',
    evidenceStance: 'Judge whether the target preserves its declared responsibility boundary and avoids unsupported adjacent responsibilities.',
    requiredContractHeadings: ['scope', 'out of scope', 'related'],
    instruction: 'Inspect the pinned target and allowed context paths independently for boundary leaks, over-grouping, and conflicting ownership. Write result.json with exactly verdict and findings. Do not modify the worktree.'
  }
};

const entries = {};
for (const [id, definition] of Object.entries(DEFINITIONS)) {
  if (!INSTRUCTION_ID.test(id)) throw new Error(`Invalid immutable instruction ID: ${id}`);
  const canonical = { id, ...definition };
  entries[id] = deepFreeze({ ...canonical, instructionDigest: digest(canonical) });
}

const INSTRUCTIONS = deepFreeze(entries);
const LENSES = deepFreeze({
  'satisfaction-v1': 'verify-satisfaction-v1',
  'omission-v1': 'verify-omission-v1',
  'boundary-v1': 'verify-boundary-v1'
});

function getInstruction(id) {
  const entry = INSTRUCTIONS[id];
  if (!entry) throw new Error(`Unknown immutable instruction registry ID: ${id}`);
  return entry;
}

function getLens(id) {
  const instructionId = LENSES[id];
  if (!instructionId) throw new Error(`Unknown immutable lens registry ID: ${id}`);
  return deepFreeze({ id, instructionId, instruction: getInstruction(instructionId) });
}

function pinInstruction(id) {
  const entry = getInstruction(id);
  return deepFreeze({ id: entry.id, revision: entry.revision, instructionDigest: entry.instructionDigest });
}

function resolveInstructionPin(value, options) {
  const settings = options || {};
  const descriptor = typeof value === 'string' ? pinInstruction(value) : value;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('A pinned instruction descriptor is required.');
  const keys = Object.keys(descriptor).sort();
  if (canonicalJson(keys) !== canonicalJson(['id', 'instructionDigest', 'revision'])) throw new Error('Pinned instruction has unknown or missing fields.');
  const entry = getInstruction(descriptor.id);
  if (descriptor.revision !== entry.revision || descriptor.instructionDigest !== entry.instructionDigest) throw new Error(`Pinned instruction registry drift: ${descriptor.id}`);
  if (settings.mode && entry.allowedMode !== settings.mode) throw new Error(`Instruction ${entry.id} is not allowed in ${settings.mode} mode.`);
  if (settings.lensId) {
    const lens = getLens(settings.lensId);
    if (lens.instructionId !== entry.id) throw new Error(`Lens ${settings.lensId} is immutably mapped to ${lens.instructionId}.`);
  }
  return entry;
}

module.exports = {
  INSTRUCTIONS,
  LENSES,
  getInstruction,
  getLens,
  pinInstruction,
  resolveInstructionPin
};
