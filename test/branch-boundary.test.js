'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HOOK_MARKER, USER_HOOK_NAME, validatePushLines, branchBoundaryStatus } = require('../src/branch-boundary');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

function command(program, args, cwd, expectedStatus, input) {
  const result = spawnSync(program, args, { cwd, input, encoding: 'utf8' });
  assert.strictEqual(result.status, expectedStatus === undefined ? 0 : expectedStatus, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(cwd, args, expectedStatus) {
  return command('git', args, cwd, expectedStatus).stdout.trim();
}

function initializeRepository(directory) {
  git(directory, ['init', '-b', 'main']);
  git(directory, ['config', 'user.name', 'Rundol Test']);
  git(directory, ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(directory, 'README.md'), '# Boundary test\n', 'utf8');
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-m', 'initial']);
}

function rdl(directory, args, expectedStatus) {
  const result = command(process.execPath, [cli].concat(args, ['--root', directory, '--json']), root, expectedStatus);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function testPushValidation() {
  const sha = '1'.repeat(40);
  assert.strictEqual(validatePushLines(`refs/heads/main ${sha} refs/heads/main ${sha}\n`).valid, true);
  assert.strictEqual(validatePushLines(`refs/heads/rundol/demo ${sha} refs/heads/rundol/demo ${sha}\n`).valid, true);
  assert.strictEqual(validatePushLines(`refs/tags/v1 ${sha} refs/tags/v1 ${sha}\n`).valid, true);
  assert.strictEqual(validatePushLines(`refs/heads/main ${sha} refs/heads/rundol/demo ${sha}\n`).violations[0].code, 'RDL-PUSH-003');
  assert.strictEqual(validatePushLines(`refs/heads/rundol/demo ${sha} refs/heads/main ${sha}\n`).violations[0].code, 'RDL-PUSH-003');
  assert.strictEqual(validatePushLines(`(delete) ${'0'.repeat(40)} refs/heads/rundol/demo ${sha}\n`).violations[0].code, 'RDL-PUSH-002');
}

function testInstalledBoundary() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-boundary-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-boundary-remote-'));
  try {
    git(remote, ['init', '--bare']);
    initializeRepository(temporary);
    git(temporary, ['remote', 'add', 'origin', remote]);
    const initialized = rdl(temporary, ['init', 'demo', '--name', 'Demo']);
    assert.strictEqual(initialized.boundary.valid, true);
    assert.strictEqual(initialized.boundary.pushDefault, 'simple');
    assert.deepStrictEqual(initialized.boundary.roles.map((item) => `${item.role}:${item.branch}`), ['code:main', 'workspace:rundol/workspace', 'project:rundol/demo']);
    const hook = initialized.boundary.hook.file;
    assert(fs.readFileSync(hook, 'utf8').includes(HOOK_MARKER));
    const inspected = rdl(temporary, ['git', 'boundary', '--project', 'demo']);
    assert.strictEqual(inspected.valid, true);
    assert.strictEqual(branchBoundaryStatus(temporary, { project: 'demo' }).valid, true);
    assert.strictEqual(branchBoundaryStatus(path.join(temporary, 'projects', 'demo'), { project: 'demo' }).primaryBranch, 'main');
    assert.strictEqual(git(temporary, ['config', '--local', '--get', 'branch.rundol/demo.merge']), 'refs/heads/rundol/demo');
    assert.strictEqual(git(temporary, ['config', '--local', '--get', 'branch.rundol/workspace.merge']), 'refs/heads/rundol/workspace');

    git(temporary, ['push', 'origin', 'refs/heads/rundol/demo:refs/heads/rundol/demo']);
    const rejected = command('git', ['push', '--force', 'origin', 'refs/heads/main:refs/heads/rundol/demo'], temporary, 1);
    assert(rejected.stderr.includes('cross-branch push blocked'), rejected.stderr);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
}

function testExistingHookPreserved() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-boundary-hook-'));
  try {
    initializeRepository(temporary);
    const hooks = path.join(temporary, '.git', 'hooks');
    const original = '#!/bin/sh\necho existing-hook >&2\nexit 0\n';
    fs.writeFileSync(path.join(hooks, 'pre-push'), original, 'utf8');
    fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
    const initialized = rdl(temporary, ['init', 'demo', '--name', 'Demo']);
    assert.strictEqual(initialized.boundary.hook.preserved, true);
    assert.strictEqual(fs.readFileSync(path.join(hooks, USER_HOOK_NAME), 'utf8'), original);
    assert(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8').includes(HOOK_MARKER));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testUnbornPrimaryBranch() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-boundary-unborn-'));
  try {
    git(temporary, ['init', '-b', 'main']);
    git(temporary, ['config', 'user.name', 'Rundol Test']);
    git(temporary, ['config', 'user.email', 'rundol@example.test']);
    const initialized = rdl(temporary, ['init', 'blank', '--name', 'Blank']);
    assert.strictEqual(initialized.boundary.valid, true);
    assert.strictEqual(initialized.boundary.primaryBranch, 'main');
    assert.deepStrictEqual(initialized.boundary.roles.map((item) => item.branch), ['main', 'rundol/workspace', 'rundol/blank']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testRemoteDefaultBranch() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-boundary-default-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-boundary-default-remote-'));
  try {
    git(remote, ['init', '--bare']);
    initializeRepository(temporary);
    git(temporary, ['remote', 'add', 'origin', remote]);
    rdl(temporary, ['init', 'demo', '--name', 'Demo']);
    for (const branch of ['master', 'trunk']) {
      git(temporary, ['update-ref', `refs/remotes/origin/${branch}`, 'refs/heads/main']);
      git(temporary, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
      const status = branchBoundaryStatus(temporary, { project: 'demo', remote: 'origin' });
      assert.strictEqual(status.primaryBranch, branch);
      assert.strictEqual(status.currentCodeBranch, 'main');
      assert.strictEqual(status.valid, true);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
}

testPushValidation();
testInstalledBoundary();
testExistingHookPreserved();
testUnbornPrimaryBranch();
testRemoteDefaultBranch();
process.stdout.write('branch boundary tests passed\n');
