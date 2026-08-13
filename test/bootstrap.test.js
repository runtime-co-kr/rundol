'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { discoverWorkspace } = require('../src/bootstrap');
const { initializeWorkspace } = require('../src/init');
const { initState } = require('../src/state');

function git(cwd, args, allowFailure) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFailure) assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-bootstrap-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Rundol Test']);
  git(root, ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# test\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'initial']);
  return root;
}

function testCreatedAndStableDiscovery() {
  const root = setup();
  try {
    const before = git(root, ['show-ref']);
    const result = discoverWorkspace(root, { remote: false });
    assert.strictEqual(result.action, 'created');
    assert.deepStrictEqual(result.available, []);
    assert.strictEqual(git(root, ['show-ref']), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testConflictManifestWithoutRef() {
  const root = setup();
  try {
    fs.mkdirSync(path.join(root, 'projects', 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', 'workspace', 'workspace.yaml'), 'schemaVersion: 6\n');
    const result = discoverWorkspace(root, { remote: false });
    assert.strictEqual(result.action, 'conflict');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testRemoteSelectionDoesNotWriteRefs() {
  const root = setup();
  const source = setup();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-bootstrap-remote-'));
  try {
    git(remote, ['init', '--bare']);
    fs.mkdirSync(path.join(source, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(source, 'workspace.yaml'), 'schemaVersion: 6\nid: workspace\nmount: projects\n', 'utf8');
    for (const key of ['alpha', 'beta']) fs.writeFileSync(path.join(source, 'projects', `project-${key}.yaml`), `key: ${key}\nref: refs/heads/rundol/${key}\n`, 'utf8');
    git(source, ['add', '.']); git(source, ['commit', '-m', 'workspace']);
    const workspaceCommit = git(source, ['rev-parse', 'HEAD']);
    for (const key of ['alpha', 'beta']) {
      git(source, ['checkout', '--orphan', `project-${key}`]);
      git(source, ['rm', '-rf', '.']);
      fs.writeFileSync(path.join(source, 'project.md'), `---\nid: project:${key}\ntype: project\n---\n# ${key}\n`, 'utf8');
      git(source, ['add', 'project.md']); git(source, ['commit', '-m', key]);
      git(source, ['push', remote, `HEAD:refs/heads/rundol/${key}`]);
    }
    git(source, ['push', remote, `${workspaceCommit}:refs/heads/rundol/workspace`]);
    git(root, ['remote', 'add', 'origin', remote]);
    const before = git(root, ['show-ref']);
    const result = discoverWorkspace(root, { remote: 'origin' });
    assert.strictEqual(result.action, 'needs-selection');
    assert.deepStrictEqual(result.available, ['alpha', 'beta']);
    assert.strictEqual(git(root, ['show-ref']), before);
    assert(!fs.existsSync(path.join(root, 'projects')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
}

function testInvalidWorkspaceRefConflicts() {
  const root = setup();
  try {
    git(root, ['branch', 'rundol/workspace', 'HEAD']);
    const result = discoverWorkspace(root, { remote: false });
    assert.strictEqual(result.action, 'conflict');
    assert.strictEqual(result.local.branchValid, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testWrongWorktreeBranchConflicts() {
  const root = setup();
  try {
    initializeWorkspace(root, 'demo', 'Demo');
    initState(root, { project: 'demo' });
    git(root, ['worktree', 'remove', path.join(root, 'projects', 'demo')]);
    git(root, ['branch', 'wrong', 'main']);
    git(root, ['worktree', 'add', path.join(root, 'projects', 'demo'), 'wrong']);
    const result = discoverWorkspace(root, { remote: false, project: 'demo' });
    assert.strictEqual(result.action, 'conflict');
    assert.strictEqual(result.local.mismatchedTrees.length, 1);
    assert.strictEqual(path.basename(result.local.mismatchedTrees[0]), 'demo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testMissingProjectWorktreeRepairs() {
  const root = setup();
  try {
    initializeWorkspace(root, 'demo', 'Demo');
    initState(root, { project: 'demo' });
    git(root, ['worktree', 'remove', path.join(root, 'projects', 'demo')]);
    const result = discoverWorkspace(root, { remote: false, project: 'demo' });
    assert.strictEqual(result.action, 'repaired');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testDivergedWorkspaceConflicts() {
  const root = setup();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-bootstrap-diverged-'));
  try {
    initializeWorkspace(root, 'demo', 'Demo');
    initState(root, { project: 'demo' });
    git(remote, ['init', '--bare']);
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['push', 'origin', 'refs/heads/rundol/workspace', 'refs/heads/rundol/demo']);
    const workspace = path.join(root, 'projects', 'workspace');
    const base = git(workspace, ['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(workspace, 'workspace.yaml'), '\nremoteMarker: true\n');
    git(workspace, ['add', 'workspace.yaml']); git(workspace, ['commit', '-m', 'remote workspace']); git(workspace, ['push', 'origin', 'rundol/workspace']);
    git(workspace, ['reset', '--hard', base]);
    fs.appendFileSync(path.join(workspace, 'workspace.yaml'), '\nlocalMarker: true\n');
    git(workspace, ['add', 'workspace.yaml']); git(workspace, ['commit', '-m', 'local workspace']);
    const result = discoverWorkspace(root, { remote: 'origin' });
    assert.strictEqual(result.action, 'conflict');
    assert.strictEqual(result.workspaceRelation, 'diverged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
}

testCreatedAndStableDiscovery();
testConflictManifestWithoutRef();
testRemoteSelectionDoesNotWriteRefs();
testInvalidWorkspaceRefConflicts();
testWrongWorktreeBranchConflicts();
testMissingProjectWorktreeRepairs();
testDivergedWorkspaceConflicts();
process.stdout.write('bootstrap tests passed\n');
