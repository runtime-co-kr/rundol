'use strict';

const fs = require('fs');
const path = require('path');
const { runGit, refExists } = require('./git');
const { discoverWorkspace } = require('./bootstrap');

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function manifestSource() {
  return 'schemaVersion: 6\nid: workspace\nname: Rundol Workspace\nmount: projects\n\nworkspace:\n  ref: refs/heads/rundol/workspace\n\npaths:\n  clients: clients\n  projects: projects\n  events: events\n\nclients:\n  obsidian:\n    vaultRoot: project\n    settingsPath: .obsidian\n';
}

function gitExclude(root) {
  const resolved = runGit(['rev-parse', '--git-path', 'info/exclude'], { cwd: root }).stdout;
  const file = path.isAbsolute(resolved) ? resolved : path.resolve(root, resolved);
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const rule = '/projects/*/';
  const lines = original.split(/\r?\n/u).filter((line) => line !== '/projects/');
  if (lines.includes(rule) && lines.length === original.split(/\r?\n/u).length) return { file, changed: false };
  const base = lines.join('\n').replace(/\n+$/u, '');
  atomicWrite(file, `${base}\n\n# Rundol linked project worktrees\n${rule}\n`);
  return { file, changed: true };
}

function connectDiscoveredCommit(root, branch, commit) {
  if (!commit || runGit(['cat-file', '-e', `${commit}^{commit}`], { cwd: root, allowFailure: true }).status !== 0) {
    throw new Error(`발견된 ${branch} commit을 로컬 object database에서 찾지 못했습니다.`);
  }
  const ref = `refs/heads/${branch}`;
  if (!refExists(root, ref)) runGit(['update-ref', ref, commit], { cwd: root });
  else {
    const local = runGit(['rev-parse', ref], { cwd: root }).stdout;
    if (local !== commit) {
      const fastForward = runGit(['merge-base', '--is-ancestor', local, commit], { cwd: root, allowFailure: true });
      if (fastForward.status !== 0) throw new Error(`${branch} 로컬 ref와 발견된 원격 commit이 분기되었습니다.`);
      runGit(['update-ref', ref, commit, local], { cwd: root });
    }
  }
  return commit;
}

function ensureWorktree(root, target, branch) {
  if (fs.existsSync(path.join(target, '.git'))) return false;
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`worktree 대상 경로가 비어 있지 않습니다: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  runGit(['worktree', 'prune'], { cwd: root });
  runGit(['worktree', 'add', '--force', target, branch], { cwd: root });
  return true;
}

function ensureTargetsVacant(root, targets) {
  const blocks = runGit(['worktree', 'list', '--porcelain'], { cwd: root }).stdout.trim().split(/\r?\n\r?\n/u).filter(Boolean);
  const registered = new Map(blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const pathLine = lines.find((line) => line.startsWith('worktree '));
    const branchLine = lines.find((line) => line.startsWith('branch '));
    return [path.resolve(pathLine.slice(9).trim()).toLowerCase(), branchLine ? branchLine.slice(7).trim() : null];
  }));
  for (const item of targets) {
    const resolved = path.resolve(item.target);
    if (registered.has(resolved.toLowerCase())) {
      if (registered.get(resolved.toLowerCase()) !== `refs/heads/${item.branch}`) throw new Error(`Rundol worktree branch가 일치하지 않습니다: ${resolved}`);
      continue;
    }
    if (!fs.existsSync(resolved)) continue;
    if (fs.readdirSync(resolved).length) throw new Error(`Rundol worktree 대상 경로가 비어 있지 않습니다: ${resolved}`);
  }
}

function attachWorkspace(start, options) {
  const settings = options || {};
  const remote = settings.remote || 'origin';
  const root = path.resolve(runGit(['rev-parse', '--show-toplevel'], { cwd: start }).stdout);
  const discovery = settings.discovery || discoverWorkspace(root, { remote, project: settings.project });
  if (discovery.action === 'already-connected') return { root, remote, action: 'already-connected', attached: [] };
  if (discovery.action === 'repaired' && (!discovery.remote || !discovery.remote.branch)) return repairWorkspace(root, settings);
  if (discovery.action === 'needs-selection' && !settings.project) return discovery;
  if (discovery.action === 'conflict') throw new Error(discovery.error || 'Rundol Workspace state is conflicting.');
  const remotes = runGit(['remote'], { cwd: root }).stdout.split(/\r?\n/u).filter(Boolean);
  if (!remotes.includes(remote)) throw new Error(`Git remote가 없습니다: ${remote}`);
  const workspaceBranch = discovery.remote && discovery.remote.branch;
  if (!workspaceBranch) throw new Error(`원격 ${remote}에서 Rundol Workspace branch를 찾지 못했습니다.`);
  const available = discovery.remote.projects;
  const selected = settings.project ? [settings.project] : available;
  if (!selected.length) throw new Error(`${workspaceBranch}에 등록된 프로젝트가 없습니다.`);
  for (const key of selected) if (!available.includes(key)) throw new Error(`프로젝트를 찾지 못했습니다: ${key}. 사용 가능: ${available.join(', ')}`);
  const workspace = path.join(root, 'projects', 'workspace');
  ensureTargetsVacant(root, [{ target: workspace, branch: workspaceBranch }].concat(selected.map((key) => ({ target: path.join(root, 'projects', key), branch: `rundol/${key}` }))));
  const workspaceCommit = connectDiscoveredCommit(root, workspaceBranch, discovery.remote.commit);
  ensureWorktree(root, workspace, workspaceBranch);
  const attached = selected.map((key) => {
    const branch = `rundol/${key}`;
    const commit = connectDiscoveredCommit(root, branch, discovery.remote.projectCommits[key]);
    const target = path.join(root, 'projects', key);
    const created = ensureWorktree(root, target, branch);
    return { project: key, branch, target, commit, created };
  });
  const exclude = gitExclude(root);
  return { root, remote, action: discovery.action === 'repaired' ? 'repaired' : 'attached', workspace: { branch: workspaceBranch, commit: workspaceCommit, worktree: workspace }, attached, exclude };
}

function repairWorkspace(start, options) {
  const settings = options || {};
  const root = path.resolve(runGit(['rev-parse', '--show-toplevel'], { cwd: start }).stdout);
  const discovery = settings.discovery || discoverWorkspace(root, { remote: false, project: settings.project });
  if (discovery.action === 'already-connected') return { root, action: 'already-connected', attached: [] };
  if (discovery.action !== 'repaired') throw new Error('복구할 수 있는 로컬 Rundol ref를 찾지 못했습니다.');
  const workspaceBranch = discovery.local.branch;
  const workspace = path.join(root, 'projects', 'workspace');
  const available = discovery.local.workspaceProjects;
  if (!settings.project && available.length > 1) return { root, action: 'needs-selection', available, attached: [] };
  const selected = settings.project ? [settings.project] : available;
  for (const key of selected) {
    if (!available.includes(key) || !refExists(root, `refs/heads/rundol/${key}`)) throw new Error(`복구할 프로젝트 ref를 찾지 못했습니다: ${key}`);
  }
  ensureTargetsVacant(root, [{ target: workspace, branch: workspaceBranch }].concat(selected.map((key) => ({ target: path.join(root, 'projects', key), branch: `rundol/${key}` }))));
  ensureWorktree(root, workspace, workspaceBranch);
  const attached = selected.map((key) => {
    const branch = `rundol/${key}`;
    const target = path.join(root, 'projects', key);
    return { project: key, branch, target, commit: runGit(['rev-parse', `refs/heads/${branch}`], { cwd: root }).stdout, created: ensureWorktree(root, target, branch) };
  });
  return { root, action: 'repaired', workspace: { branch: workspaceBranch, worktree: workspace }, attached, exclude: gitExclude(root) };
}

function detachWorkspace(start, options) {
  const settings = options || {};
  const root = path.resolve(runGit(['rev-parse', '--show-toplevel'], { cwd: start }).stdout);
  const key = settings.project;
  if (!key) throw new Error('rdl detach에는 프로젝트 키가 필요합니다.');
  const target = path.join(root, 'projects', key);
  if (!fs.existsSync(target)) return { root, project: key, detached: false };
  runGit(['worktree', 'remove', target], { cwd: root });
  return { root, project: key, detached: true, target };
}

module.exports = { manifestSource, gitExclude, attachWorkspace, repairWorkspace, detachWorkspace, ensureWorktree, discoverWorkspace };
