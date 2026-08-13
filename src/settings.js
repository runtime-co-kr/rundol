'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGit, refExists, gitRoot } = require('./git');
const { findWorkspaceRoot, readWorkspaceManifest, yamlNestedValue, yamlValue, safeRelative } = require('./workspace');
const { ensureIgnore } = require('./init');
const { runtimeWorkspace } = require('./runtime');

function config(start) {
  const root = findWorkspaceRoot(start);
  const manifest = readWorkspaceManifest(root).source;
  const schemaVersion = Number.parseInt(yamlValue(manifest, 'schemaVersion') || '1', 10) || 1;
  if (schemaVersion < 4) return null;
  const repositoryRoot = fs.realpathSync.native(path.resolve(gitRoot(root))).toLowerCase();
  const workspaceRoot = fs.realpathSync.native(path.resolve(root)).toLowerCase();
  if (repositoryRoot !== workspaceRoot) throw new Error('Rundol Workspace 루트는 Git 저장소 루트와 같아야 합니다.');
  if (schemaVersion >= 6) {
    const ref = yamlNestedValue(manifest, 'workspace', 'ref') || 'refs/heads/rundol/workspace';
    if (ref !== 'refs/heads/rundol/workspace') throw new Error('workspace.ref는 refs/heads/rundol/workspace여야 합니다.');
    return { root, ref, branch: 'rundol/workspace', mountRelative: 'projects/workspace', runtime: null, worktree: path.join(root, 'projects', 'workspace'), domain: 'workspace' };
  }
  const runtime = path.join(root, '.rundol', 'workspace.yaml') === readWorkspaceManifest(root).file ? null : runtimeWorkspace(root);
  const mountRelative = runtime ? null : safeRelative(yamlNestedValue(manifest, 'settings', 'mount') || '.rundol/settings', 'settings.mount');
  const ref = yamlNestedValue(manifest, 'settings', 'ref') || 'refs/heads/rundol/settings';
  if (ref !== 'refs/heads/rundol/settings') throw new Error('settings.ref는 refs/heads/rundol/settings여야 합니다.');
  return { root, ref, branch: 'rundol/settings', mountRelative, runtime, worktree: runtime ? runtime.settings : path.join(root, mountRelative), domain: 'settings' };
}

function remoteNames(root) {
  const output = runGit(['remote'], { cwd: root }).stdout;
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function missingRef(result) {
  return /couldn't find remote ref|remote ref does not exist|not found/i.test(`${result.stderr}\n${result.stdout}`);
}

function seedTree(settings) {
  if (!fs.existsSync(settings.worktree)) throw new Error(`Rundol settings seed가 없습니다: ${settings.worktree}`);
  const index = path.join(settings.runtime ? settings.runtime.state : os.tmpdir(), `rundol-workspace-index-${process.pid}-${Date.now()}`);
  try {
    runGit([`--work-tree=${settings.worktree}`, 'read-tree', '--empty'], { cwd: settings.root, env: { GIT_INDEX_FILE: index } });
    runGit([`--work-tree=${settings.worktree}`, 'add', '-A', '-f', '--', '.'], { cwd: settings.root, env: { GIT_INDEX_FILE: index } });
    return runGit(['write-tree'], { cwd: settings.root, env: { GIT_INDEX_FILE: index } }).stdout;
  } finally {
    if (fs.existsSync(index)) fs.unlinkSync(index);
  }
}

function ensureRef(settings, remote) {
  if (refExists(settings.root, settings.ref)) return { created: false, source: settings.ref };
  if (remoteNames(settings.root).includes(remote)) {
    const remoteRef = `refs/remotes/${remote}/${settings.branch}`;
    const fetched = runGit(['fetch', '--no-tags', remote, `+${settings.ref}:${remoteRef}`], { cwd: settings.root, allowFailure: true });
    if (fetched.status === 0) {
      const commit = runGit(['rev-parse', remoteRef], { cwd: settings.root }).stdout;
      runGit(['update-ref', settings.ref, commit], { cwd: settings.root });
      return { created: true, source: remoteRef };
    }
    if (!missingRef(fetched)) throw new Error(`원격 settings 브랜치를 확인하지 못했습니다: ${(fetched.stderr || fetched.stdout).trim()}`);
  }
  const tree = seedTree(settings);
  const commit = runGit(['commit-tree', tree, '-m', `rdl: initialize ${settings.domain}`], { cwd: settings.root }).stdout;
  runGit(['update-ref', settings.ref, commit], { cwd: settings.root });
  return { created: true, source: 'seed' };
}

function validWorktree(settings) {
  if (!fs.existsSync(path.join(settings.worktree, '.git'))) return false;
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: settings.worktree, allowFailure: true });
  return result.status === 0 && result.stdout === settings.branch;
}

function ensureWorktree(settings) {
  if (validWorktree(settings)) return false;
  let backup = null;
  if (fs.existsSync(settings.worktree) && fs.readdirSync(settings.worktree).length) {
    backup = path.join(settings.runtime ? settings.runtime.state : os.tmpdir(), `rundol-workspace-backup-${process.pid}-${Date.now()}`);
    fs.renameSync(settings.worktree, backup);
  }
  fs.mkdirSync(path.dirname(settings.worktree), { recursive: true });
  try {
    runGit(['worktree', 'prune'], { cwd: settings.root });
    runGit(['worktree', 'add', '--force', settings.worktree, settings.branch], { cwd: settings.root });
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(settings.worktree)) fs.rmSync(settings.worktree, { recursive: true, force: true });
    if (backup) fs.renameSync(backup, settings.worktree);
    throw error;
  }
  return true;
}

function initSettings(start, options) {
  const settings = config(start);
  if (!settings) return null;
  const state = ensureRef(settings, (options && options.remote) || 'origin');
  const worktreeCreated = ensureWorktree(settings);
  return { branch: settings.branch, branchCreated: state.created, branchSource: state.source, worktree: settings.worktree, worktreeCreated, commit: runGit(['rev-parse', settings.ref], { cwd: settings.root }).stdout };
}

function saveSettings(start) {
  const settings = config(start);
  if (!settings) return null;
  initSettings(start);
  const status = runGit(['status', '--porcelain'], { cwd: settings.worktree }).stdout;
  if (!status) return { branch: settings.branch, changed: false, commit: runGit(['rev-parse', 'HEAD'], { cwd: settings.worktree }).stdout };
  runGit(['add', '-A', '--', '.'], { cwd: settings.worktree });
  runGit(['commit', '-m', `rdl: update ${settings.domain}`], { cwd: settings.worktree });
  return { branch: settings.branch, changed: true, commit: runGit(['rev-parse', 'HEAD'], { cwd: settings.worktree }).stdout };
}

function syncSettings(start, options) {
  const settings = config(start);
  if (!settings) return null;
  const remote = (options && options.remote) || 'origin';
  const saved = saveSettings(start);
  if (!remoteNames(settings.root).includes(remote)) throw new Error(`Git remote가 없습니다: ${remote}`);
  // FETCH_HEAD is repository-global and can be overwritten by a concurrent
  // project sync. Fetch into the branch-specific remote-tracking ref instead.
  const remoteRef = `refs/remotes/${remote}/${settings.branch}`;
  const fetch = runGit(['fetch', '--no-tags', remote, `+${settings.ref}:${remoteRef}`], { cwd: settings.root, allowFailure: true });
  let action = 'unchanged';
  if (fetch.status === 0) {
    const remoteCommit = runGit(['rev-parse', remoteRef], { cwd: settings.root }).stdout;
    const local = runGit(['rev-parse', 'HEAD'], { cwd: settings.worktree }).stdout;
    if (local !== remoteCommit) {
      const merge = runGit(['merge', '--no-edit', remoteCommit], { cwd: settings.worktree, allowFailure: true });
      if (merge.status !== 0) {
        runGit(['merge', '--abort'], { cwd: settings.worktree, allowFailure: true });
        throw new Error(`${settings.domain} 브랜치 충돌은 프로젝트 동기화 전에 해결해야 합니다.`);
      }
      action = 'merged';
    }
  } else if (!missingRef(fetch)) throw new Error(`${settings.domain} fetch 실패: ${fetch.stderr}`);
  else action = 'publish-new';
  if (!options || options.push !== false) runGit(['push', remote, `${settings.ref}:${settings.ref}`], { cwd: settings.root });
  return { branch: settings.branch, action, saved: saved.changed, pushed: !options || options.push !== false, commit: runGit(['rev-parse', 'HEAD'], { cwd: settings.worktree }).stdout };
}

function migrateSettings(start) {
  const root = findWorkspaceRoot(start);
  const manifest = readWorkspaceManifest(root);
  const schemaVersion = Number.parseInt(yamlValue(manifest.source, 'schemaVersion') || '1', 10) || 1;
  if (schemaVersion >= 6) return { root, migrated: false, reason: 'already-current' };
  if (schemaVersion === 5) {
    const legacy = config(root);
    const target = path.join(root, 'projects', 'workspace');
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`Workspace 대상 경로가 비어 있지 않습니다: ${target}`);
    ensureIgnore(root);
    fs.mkdirSync(path.join(target, 'clients'), { recursive: true });
    fs.mkdirSync(path.join(target, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(target, 'events'), { recursive: true });
    fs.writeFileSync(path.join(target, 'workspace.yaml'), 'schemaVersion: 6\nid: workspace\nname: Rundol Workspace\nmount: projects\n\nworkspace:\n  ref: refs/heads/rundol/workspace\n\npaths:\n  clients: clients\n  projects: projects\n  events: events\n\nclients:\n  obsidian:\n    vaultRoot: project\n    settingsPath: .obsidian\n', 'utf8');
    const legacyProjects = path.join(legacy.worktree, 'projects');
    if (!fs.existsSync(legacyProjects)) throw new Error(`기존 프로젝트 등록 경로가 없습니다: ${legacyProjects}`);
    for (const name of fs.readdirSync(legacyProjects).filter((value) => value.endsWith('.yaml'))) {
      let source = fs.readFileSync(path.join(legacyProjects, name), 'utf8');
      if (!/^schemaVersion:/mu.test(source)) source = `schemaVersion: 1\nrevision: 1\n${source}`;
      const key = yamlValue(source, 'key') || name.slice(0, -5);
      fs.writeFileSync(path.join(target, 'projects', `project-${key}.yaml`), source, 'utf8');
    }
    const index = path.join(os.tmpdir(), `rundol-workspace-migrate-${process.pid}-${Date.now()}`);
    try {
      runGit([`--work-tree=${target}`, 'read-tree', '--empty'], { cwd: root, env: { GIT_INDEX_FILE: index } });
      runGit([`--work-tree=${target}`, 'add', '-A', '-f', '--', '.'], { cwd: root, env: { GIT_INDEX_FILE: index } });
      const tree = runGit(['write-tree'], { cwd: root, env: { GIT_INDEX_FILE: index } }).stdout;
      const commit = runGit(['commit-tree', tree, '-m', 'rdl: migrate settings to workspace'], { cwd: root }).stdout;
      runGit(['update-ref', 'refs/heads/rundol/workspace', commit], { cwd: root });
      fs.rmSync(target, { recursive: true, force: true });
      runGit(['worktree', 'add', '--force', target, 'rundol/workspace'], { cwd: root });
      return { root, migrated: true, from: 'rundol/settings', branch: 'rundol/workspace', commit, worktree: target };
    } finally {
      if (fs.existsSync(index)) fs.unlinkSync(index);
    }
  }
  if (schemaVersion >= 4) return { root, migrated: false, reason: 'legacy-current' };
  if (schemaVersion !== 3) throw new Error('settings 마이그레이션은 schemaVersion 3 Workspace만 지원합니다.');
  const settingsRoot = path.join(root, '.rundol', 'settings');
  if (fs.existsSync(settingsRoot) && fs.readdirSync(settingsRoot).length) throw new Error(`settings 경로가 비어 있지 않습니다: ${settingsRoot}`);
  const legacyProjects = path.join(root, '.rundol', 'projects');
  const legacyObsidian = path.join(root, '.rundol', 'obsidian');
  if (!fs.existsSync(legacyProjects)) throw new Error(`기존 프로젝트 등록 경로가 없습니다: ${legacyProjects}`);
  ensureIgnore(root);
  fs.mkdirSync(settingsRoot, { recursive: true });
  fs.renameSync(legacyProjects, path.join(settingsRoot, 'projects'));
  if (fs.existsSync(legacyObsidian)) fs.renameSync(legacyObsidian, path.join(settingsRoot, 'obsidian'));
  const next = manifest.source
    .replace(/^schemaVersion:\s*3\s*$/mu, 'schemaVersion: 4')
    .replace(/^projects:\s*\r?\n\s{2}path:\s*\.rundol\/projects\s*$/mu, 'settings:\n  mount: .rundol/settings\n  ref: refs/heads/rundol/settings\n\nprojects:\n  path: .rundol/settings/projects');
  try {
    const temporary = `${manifest.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, next, 'utf8');
    fs.renameSync(temporary, manifest.file);
    const initialized = initSettings(root);
    return { root, migrated: true, branch: initialized.branch, commit: initialized.commit, worktree: initialized.worktree };
  } catch (error) {
    fs.writeFileSync(manifest.file, manifest.source, 'utf8');
    if (fs.existsSync(path.join(settingsRoot, 'projects')) && !fs.existsSync(legacyProjects)) fs.renameSync(path.join(settingsRoot, 'projects'), legacyProjects);
    if (fs.existsSync(path.join(settingsRoot, 'obsidian')) && !fs.existsSync(legacyObsidian)) fs.renameSync(path.join(settingsRoot, 'obsidian'), legacyObsidian);
    throw error;
  }
}

module.exports = { config, initSettings, saveSettings, syncSettings, migrateSettings };
