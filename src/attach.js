'use strict';

const fs = require('fs');
const path = require('path');
const { runGit, refExists } = require('./git');

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

function fetchBranch(root, remote, branch) {
  const ref = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const fetched = runGit(['fetch', '--no-tags', remote, `+${ref}:${remoteRef}`], { cwd: root, allowFailure: true });
  if (fetched.status !== 0) throw new Error(`원격 ${branch} 브랜치를 찾지 못했습니다: ${(fetched.stderr || fetched.stdout).trim()}`);
  const commit = runGit(['rev-parse', remoteRef], { cwd: root }).stdout;
  if (!refExists(root, ref)) {
    runGit(['update-ref', ref, commit], { cwd: root });
  } else {
    const local = runGit(['rev-parse', ref], { cwd: root }).stdout;
    if (local !== commit) {
      const fastForward = runGit(['merge-base', '--is-ancestor', local, commit], { cwd: root, allowFailure: true });
      if (fastForward.status !== 0) {
        throw new Error(`${branch} 로컬 브랜치와 원격 브랜치가 분기되었습니다. rdl sync로 충돌을 먼저 해소하세요.`);
      }
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

function projectKeys(settings) {
  const directory = path.join(settings, 'projects');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^project-[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/u.test(name)).map((name) => name.slice(8, -5)).sort();
}

function attachWorkspace(start, options) {
  const settings = options || {};
  const remote = settings.remote || 'origin';
  const root = path.resolve(runGit(['rev-parse', '--show-toplevel'], { cwd: start }).stdout);
  const remotes = runGit(['remote'], { cwd: root }).stdout.split(/\r?\n/u).filter(Boolean);
  if (!remotes.includes(remote)) throw new Error(`Git remote가 없습니다: ${remote}`);
  let workspaceBranch = 'rundol/workspace';
  let workspaceCommit;
  try { workspaceCommit = fetchBranch(root, remote, workspaceBranch); }
  catch (error) {
    workspaceBranch = 'rundol/settings';
    workspaceCommit = fetchBranch(root, remote, workspaceBranch);
  }
  const workspace = path.join(root, 'projects', 'workspace');
  ensureWorktree(root, workspace, workspaceBranch);
  const available = workspaceBranch === 'rundol/workspace'
    ? projectKeys(workspace)
    : fs.readdirSync(path.join(workspace, 'projects')).filter((name) => name.endsWith('.yaml')).map((name) => name.slice(0, -5)).sort();
  const selected = settings.project ? [settings.project] : available;
  if (!selected.length) throw new Error(`${workspaceBranch}에 등록된 프로젝트가 없습니다.`);
  for (const key of selected) if (!available.includes(key)) throw new Error(`프로젝트를 찾지 못했습니다: ${key}. 사용 가능: ${available.join(', ')}`);
  const attached = selected.map((key) => {
    const branch = `rundol/${key}`;
    const commit = fetchBranch(root, remote, branch);
    const target = path.join(root, 'projects', key);
    const created = ensureWorktree(root, target, branch);
    return { project: key, branch, target, commit, created };
  });
  const exclude = gitExclude(root);
  return { root, remote, workspace: { branch: workspaceBranch, commit: workspaceCommit, worktree: workspace }, attached, exclude };
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

module.exports = { manifestSource, gitExclude, attachWorkspace, detachWorkspace, ensureWorktree };
