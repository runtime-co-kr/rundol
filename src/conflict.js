'use strict';

const fs = require('fs');
const path = require('path');
const { stateConfig, canonicalJson } = require('./state');
const { runGit } = require('./git');
const { mergeTaskDocuments } = require('./merge');
const { checkWorkspace } = require('./check');

function conflictPath(config) {
  return path.join(config.pending, 'merge-conflicts.json');
}

function readConflict(start, project) {
  const config = stateConfig(start, project);
  const file = conflictPath(config);
  if (!fs.existsSync(file)) return { root: config.root, project: config.project || null, file, exists: false, conflicts: [] };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.assign({ root: config.root, project: config.project || null, file, exists: true }, value);
}

function setPointer(value, pointer, next) {
  const parts = pointer.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let target = value;
  for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
  const key = parts[parts.length - 1];
  if (next === undefined) delete target[key];
  else target[key] = next;
}

function showJson(config, ref, relative) {
  return JSON.parse(runGit(['show', `${ref}:${relative}`], { cwd: config.root }).stdout);
}

function resolveConflict(start, options) {
  const strategy = options.strategy;
  if (!['ours', 'theirs'].includes(strategy)) throw new Error('--strategy는 ours 또는 theirs여야 합니다.');
  const config = stateConfig(start, options.project);
  const pending = readConflict(config.root, config.project);
  if (!pending.exists) throw new Error('해결할 Rundol 충돌이 없습니다.');
  const merge = runGit(['merge', '--no-commit', '--no-ff', pending.theirs], { cwd: config.worktree, allowFailure: true });
  const unmerged = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: config.worktree }).stdout.split(/\r?\n/).filter(Boolean);
  try {
    if (pending.version === 2) {
      const allowed = new Set((pending.files || []).map(String));
      const unexpected = unmerged.filter((file) => !allowed.has(file));
      if (unexpected.length) throw new Error(`기록되지 않은 문서 충돌은 수동 확인이 필요합니다: ${unexpected.join(', ')}`);
      for (const file of unmerged) runGit(['checkout', `--${strategy}`, '--', file], { cwd: config.worktree });
      if (unmerged.length) runGit(['add', '--'].concat(unmerged), { cwd: config.worktree });
    } else {
      const base = showJson(config, pending.base, config.taskRelative);
      const ours = showJson(config, pending.ours, config.taskRelative);
      const theirs = showJson(config, pending.theirs, config.taskRelative);
      const result = mergeTaskDocuments(base, ours, theirs);
      for (const item of result.conflicts) setPointer(result.value, item.path, item[strategy]);
      fs.writeFileSync(path.join(config.worktree, config.taskRelative), canonicalJson(result.value), 'utf8');
      runGit(['add', '--', config.taskRelative], { cwd: config.worktree });
      const unexpected = unmerged.filter((file) => file !== config.taskRelative);
      if (unexpected.length) throw new Error(`문서 충돌은 수동 확인이 필요합니다: ${unexpected.join(', ')}`);
    }
    const checked = checkWorkspace(config.root, { project: config.project, strict: true });
    if (checked.summary.errors) throw new Error(`충돌 해결 후 검증 오류가 있습니다: ${checked.diagnostics.find((item) => item.severity === 'error').message}`);
    runGit(['commit', '-m', `rdl: resolve conflicts using ${strategy}`], { cwd: config.worktree });
    fs.unlinkSync(pending.file);
    return { root: config.root, project: config.project || null, strategy, resolved: pending.conflicts.length, commit: runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout };
  } catch (error) {
    if (merge.status !== 0 || runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: config.worktree, allowFailure: true }).status === 0) runGit(['merge', '--abort'], { cwd: config.worktree, allowFailure: true });
    throw error;
  }
}

function clearConflict(start, project) {
  const value = readConflict(start, project);
  if (value.exists) fs.unlinkSync(value.file);
  return { root: value.root, project: value.project, cleared: value.exists };
}

module.exports = { readConflict, resolveConflict, clearConflict };
