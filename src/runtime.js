'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGit, gitRoot } = require('./git');

function runtimeHome() {
  if (process.env.RUNDOL_HOME) return path.resolve(process.env.RUNDOL_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'rundol');
  return path.join(os.homedir(), '.local', 'share', 'rundol');
}

function repositoryRoot(start) {
  return path.resolve(gitRoot(path.resolve(start || process.cwd())));
}

function remoteUrl(root, remote) {
  const result = runGit(['remote', 'get-url', remote || 'origin'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : '';
}

function workspaceId(root, remote) {
  const repository = repositoryRoot(root);
  const identity = remoteUrl(repository, remote) || fs.realpathSync.native(repository).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function runtimeWorkspace(start, remote) {
  const root = repositoryRoot(start);
  const id = workspaceId(root, remote);
  const state = path.join(runtimeHome(), 'workspaces', id);
  return {
    id,
    root,
    state,
    manifest: path.join(state, 'workspace.yaml'),
    settings: path.join(state, 'settings'),
    index: path.join(state, 'index'),
    logs: path.join(state, 'logs'),
    pending: path.join(state, 'pending'),
    local: path.join(state, 'local'),
    locks: path.join(state, 'locks')
  };
}

function ensureRuntime(workspace) {
  for (const directory of [workspace.state, workspace.index, workspace.logs, workspace.pending, workspace.local, workspace.locks]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return workspace;
}

module.exports = { runtimeHome, repositoryRoot, remoteUrl, workspaceId, runtimeWorkspace, ensureRuntime };
