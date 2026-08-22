'use strict';

const fs = require('fs');
const path = require('path');
const { runGit, refExists, gitRoot } = require('./git');

const { WORKSPACE_BRANCHES } = require('./vocabulary');

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function scalar(source, key) {
  const match = new RegExp(`^${key}:\\s*([^#\\r\\n]+)`, 'mu').exec(source);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function ensureCommit(root, remote, commit) {
  if (runGit(['cat-file', '-e', `${commit}^{commit}`], { cwd: root, allowFailure: true }).status === 0) return;
  const fetched = runGit(['fetch', '--no-tags', remote, commit], { cwd: root, allowFailure: true });
  if (fetched.status !== 0) throw new Error(`원격 Rundol commit을 읽지 못했습니다: ${(fetched.stderr || fetched.stdout).trim()}`);
}

function inspectProjectCommit(root, key, commit) {
  const result = runGit(['show', `${commit}:project.md`], { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new Error(`rundol/${key}에 project.md가 없습니다.`);
  if (!new RegExp(`^id:\\s*project:${key}\\s*$`, 'mu').test(result.stdout) || !/^type:\s*project\s*$/mu.test(result.stdout)) {
    throw new Error(`rundol/${key}의 project.md 계약이 유효하지 않습니다.`);
  }
}

function inspectWorkspaceCommit(root, branch, commit, refCommits) {
  const manifestResult = runGit(['show', `${commit}:workspace.yaml`], { cwd: root, allowFailure: true });
  if (manifestResult.status !== 0) throw new Error(`${branch}에 workspace.yaml이 없습니다.`);
  const schemaVersion = Number.parseInt(scalar(manifestResult.stdout, 'schemaVersion') || '', 10);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 3) throw new Error(`${branch}의 schemaVersion이 유효하지 않습니다.`);
  if (branch === 'rundol/workspace' && schemaVersion < 6) throw new Error('rundol/workspace는 schemaVersion 6 이상이어야 합니다.');
  const tree = runGit(['ls-tree', '-r', '--name-only', commit, 'projects'], { cwd: root, allowFailure: true });
  if (tree.status !== 0) throw new Error(`${branch}의 project registry를 읽지 못했습니다.`);
  const pattern = schemaVersion >= 6 ? /^projects\/project-([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/u : /^projects\/([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/u;
  const projects = [];
  for (const file of tree.stdout.split(/\r?\n/u).filter(Boolean)) {
    const match = pattern.exec(file);
    if (!match) continue;
    const key = match[1];
    const source = runGit(['show', `${commit}:${file}`], { cwd: root }).stdout;
    const manifestKey = scalar(source, 'key') || key;
    const ref = scalar(source, 'ref') || `refs/heads/rundol/${key}`;
    if (manifestKey !== key || ref !== `refs/heads/rundol/${key}`) throw new Error(`유효하지 않은 project registry입니다: ${file}`);
    if (refCommits && !refCommits[key]) throw new Error(`project branch가 없습니다: rundol/${key}`);
    if (refCommits) inspectProjectCommit(root, key, refCommits[key]);
    projects.push(key);
  }
  return { schemaVersion, projects: projects.sort() };
}

function relation(root, localCommit, remoteCommit) {
  if (localCommit === remoteCommit) return 'same';
  if (runGit(['merge-base', '--is-ancestor', localCommit, remoteCommit], { cwd: root, allowFailure: true }).status === 0) return 'remote-ahead';
  if (runGit(['merge-base', '--is-ancestor', remoteCommit, localCommit], { cwd: root, allowFailure: true }).status === 0) return 'local-ahead';
  return 'diverged';
}

function worktrees(root) {
  const result = runGit(['worktree', 'list', '--porcelain'], { cwd: root });
  return result.stdout.trim().split(/\r?\n\r?\n/u).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/u);
    const pathLine = lines.find((line) => line.startsWith('worktree '));
    const branchLine = lines.find((line) => line.startsWith('branch '));
    return { path: path.resolve(pathLine.slice(9).trim()), branch: branchLine ? branchLine.slice(7).trim() : null };
  });
}

function occupiedTarget(target, trees) {
  if (!fs.existsSync(target)) return false;
  if (trees.some((tree) => pathKey(tree.path) === pathKey(target))) return false;
  return fs.readdirSync(target).length > 0;
}

function localState(root) {
  const manifest = path.join(root, 'projects', 'workspace', 'workspace.yaml');
  const legacy = path.join(root, '.rundol', 'workspace.yaml');
  const manifestExists = fs.existsSync(manifest) || fs.existsSync(legacy);
  const branch = WORKSPACE_BRANCHES.find((item) => refExists(root, `refs/heads/${item}`)) || null;
  const commit = branch ? runGit(['rev-parse', `refs/heads/${branch}`], { cwd: root }).stdout : null;
  const trees = worktrees(root);
  const projectsRoot = `${pathKey(path.join(root, 'projects'))}${path.sep}`;
  const workspaceKey = pathKey(path.join(root, 'projects', 'workspace'));
  const workspaceTree = trees.find((item) => pathKey(item.path) === workspaceKey) || null;
  const projectTrees = trees.filter((item) => pathKey(item.path).startsWith(projectsRoot) && pathKey(item.path) !== workspaceKey);
  const projectRefs = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/rundol/'], { cwd: root }).stdout
    .split(/\r?\n/u).filter(Boolean).filter((item) => !WORKSPACE_BRANCHES.includes(item)).map((item) => item.slice('rundol/'.length));
  let inspected = { schemaVersion: null, projects: [] };
  let validationError = null;
  if (branch) {
    try {
      const localCommits = Object.fromEntries(projectRefs.map((key) => [key, runGit(['rev-parse', `refs/heads/rundol/${key}`], { cwd: root }).stdout]));
      inspected = inspectWorkspaceCommit(root, branch, commit, localCommits);
    }
    catch (error) { validationError = error.message; }
  }
  const workspaceProjects = inspected.projects;
  const invalidProjects = workspaceProjects.filter((key) => !projectRefs.includes(key));
  const mismatchedTrees = [];
  if (workspaceTree && workspaceTree.branch !== `refs/heads/${branch}`) mismatchedTrees.push(workspaceTree.path);
  for (const tree of projectTrees) {
    const key = path.basename(tree.path);
    if (!workspaceProjects.includes(key) || tree.branch !== `refs/heads/rundol/${key}`) mismatchedTrees.push(tree.path);
  }
  return { manifest: manifestExists, branch, commit, schemaVersion: inspected.schemaVersion, branchValid: !validationError, validationError, workspaceProjects, invalidProjects, mismatchedTrees, workspaceTree, projectTrees, projectRefs, trees };
}

function remoteState(root, remote) {
  const result = runGit(['ls-remote', '--heads', remote, 'refs/heads/rundol/*'], { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    const error = new Error(`원격 Rundol discovery 실패: ${(result.stderr || result.stdout).trim()}`);
    error.code = 'RDL-REMOTE-DISCOVERY';
    throw error;
  }
  const entries = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [commit, ref] = line.split(/\s+/u);
    return { commit, ref };
  });
  const refs = entries.map((item) => item.ref);
  const branch = WORKSPACE_BRANCHES.find((item) => refs.includes(`refs/heads/${item}`)) || null;
  const branchEntry = branch ? entries.find((item) => item.ref === `refs/heads/${branch}`) : null;
  const projectCommits = {};
  for (const entry of entries) {
    const match = /^refs\/heads\/rundol\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(entry.ref);
    if (match && !['workspace', 'settings'].includes(match[1])) projectCommits[match[1]] = entry.commit;
  }
  if (!branch) {
    if (Object.keys(projectCommits).length) throw new Error('원격에 project branch는 있지만 Workspace branch가 없습니다.');
    return { branch: null, commit: null, schemaVersion: null, projects: [], projectCommits, refs };
  }
  ensureCommit(root, remote, branchEntry.commit);
  for (const commit of Object.values(projectCommits)) ensureCommit(root, remote, commit);
  const inspected = inspectWorkspaceCommit(root, branch, branchEntry.commit, projectCommits);
  return { branch, commit: branchEntry.commit, schemaVersion: inspected.schemaVersion, projects: inspected.projects, projectCommits, refs };
}

function discoverWorkspace(start, options) {
  const settings = options || {};
  const root = path.resolve(gitRoot(start || process.cwd()));
  const local = localState(root);
  let remote = null;
  let remoteError = null;
  if (settings.remote !== false) {
    const remoteName = settings.remote || 'origin';
    const remotes = runGit(['remote'], { cwd: root }).stdout.split(/\r?\n/u).filter(Boolean);
    if (remotes.includes(remoteName)) {
      try { remote = Object.assign({ name: remoteName }, remoteState(root, remoteName)); }
      catch (error) { remoteError = error; }
    }
  }
  const project = settings.project || null;
  const localProjects = local.workspaceProjects;
  const remoteProjects = remote ? remote.projects : [];
  const available = Array.from(new Set(localProjects.concat(remoteProjects))).sort();
  let action = 'created';
  let workspaceRelation = null;
  if (!remoteError && local.branch && remote && remote.branch) {
    workspaceRelation = local.branch === remote.branch ? relation(root, local.commit, remote.commit) : 'diverged';
  }
  if ((local.branch && !local.branchValid) || local.invalidProjects.length || local.mismatchedTrees.length || (!local.branch && local.projectRefs.length) || workspaceRelation === 'diverged') action = 'conflict';
  else if (local.manifest && !local.branch) action = 'conflict';
  else if (local.manifest && local.branch) {
    const target = project ? pathKey(path.join(root, 'projects', project)) : null;
    const mounted = new Set(local.projectTrees.map((tree) => path.basename(tree.path).toLowerCase()));
    const missingProjects = localProjects.filter((key) => !mounted.has(key.toLowerCase()));
    const needsRepair = !local.workspaceTree || missingProjects.length > 0 || (target && !local.projectTrees.some((tree) => pathKey(tree.path) === target));
    action = needsRepair && !project && localProjects.length > 1 ? 'needs-selection' : (needsRepair ? 'repaired' : 'already-connected');
  } else if (remoteError) action = 'conflict';
  else if (remote && remote.branch) {
    if (!project && remoteProjects.length > 1) action = 'needs-selection';
    else action = 'attached';
  } else if (local.branch && !local.manifest) action = !project && localProjects.length > 1 ? 'needs-selection' : 'repaired';
  if (project && available.length && !available.includes(project)) action = 'conflict';
  let occupied = null;
  if (action === 'attached' || action === 'repaired') {
    const selected = project ? [project] : available;
    const targets = [path.join(root, 'projects', 'workspace')].concat(selected.map((key) => path.join(root, 'projects', key)));
    occupied = targets.find((target) => occupiedTarget(target, local.trees)) || null;
    if (occupied) action = 'conflict';
  }
  const error = occupied
    ? `Rundol worktree 대상 경로가 비어 있지 않습니다: ${occupied}`
    : (action === 'conflict' && remoteError ? remoteError.message : (local.validationError || (workspaceRelation === 'diverged' ? '로컬과 원격 Rundol Workspace ref가 분기되었습니다.' : null)));
  return { root, remote: settings.remote || 'origin', action, project, available, availableProjects: available.join(', '), workspaceRelation, local, remote, error };
}

module.exports = { discoverWorkspace, localState, remoteState, worktrees };
