'use strict';

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeValue(base, ours, theirs, path, conflicts) {
  if (equal(ours, theirs)) return ours;
  if (equal(ours, base)) return theirs;
  if (equal(theirs, base)) return ours;
  if (object(ours) && object(theirs) && (base === undefined || object(base))) {
    const result = {};
    const keys = new Set(Object.keys(base || {}).concat(Object.keys(ours), Object.keys(theirs)));
    for (const key of Array.from(keys).sort()) {
      const merged = mergeValue(base ? base[key] : undefined, ours[key], theirs[key], `${path}/${key}`, conflicts);
      if (merged !== undefined) result[key] = merged;
    }
    return result;
  }
  conflicts.push({ path: path || '/', base, ours, theirs });
  return ours;
}

function mergeTaskDocuments(base, ours, theirs) {
  const conflicts = [];
  const value = mergeValue(base, ours, theirs, '', conflicts);
  return { value, conflicts };
}

module.exports = { mergeTaskDocuments };
