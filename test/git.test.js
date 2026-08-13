'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mergeTaskDocuments } = require('../src/merge');
const { taskCreate, taskUpdate } = require('../src/state');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(cwd, args) {
  return command('git', args, cwd);
}

function rdl(cwd, args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), root));
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (path.basename(source) === '.rundol' && ['local', 'worktrees', 'pending', 'logs'].includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function initializeWorkspace(workspace, remote) {
  copyDirectory(path.join(root, 'test', 'fixtures', 'workspace'), workspace);
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'Rundol Test']);
  git(workspace, ['config', 'user.email', 'rundol@example.test']);
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'initial workspace']);
  if (remote) {
    git(workspace, ['remote', 'add', 'origin', remote]);
    git(workspace, ['push', '-u', 'origin', 'main']);
  }
}

function configureClone(workspace) {
  git(workspace, ['config', 'user.name', 'Rundol Test']);
  git(workspace, ['config', 'user.email', 'rundol@example.test']);
}

function testSemanticMerge() {
  const base = { schemaVersion: 1, tasks: { A: { status: 'todo', owner: null }, B: { status: 'todo', owner: null } } };
  const ours = JSON.parse(JSON.stringify(base));
  const theirs = JSON.parse(JSON.stringify(base));
  ours.tasks.A.status = 'doing';
  theirs.tasks.B.owner = 'MEMBER-001';
  const merged = mergeTaskDocuments(base, ours, theirs);
  assert.deepStrictEqual(merged.conflicts, []);
  assert.strictEqual(merged.value.tasks.A.status, 'doing');
  assert.strictEqual(merged.value.tasks.B.owner, 'MEMBER-001');

  const conflicting = JSON.parse(JSON.stringify(base));
  conflicting.tasks.A.status = 'done';
  const result = mergeTaskDocuments(base, ours, conflicting);
  assert(result.conflicts.some((item) => item.path === '/tasks/A/status'));
}

function testRemoteFailureDoesNotCreateBranch() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-remote-failure-'));
  const workspace = path.join(temporary, 'workspace');
  try {
    initializeWorkspace(workspace);
    git(workspace, ['remote', 'add', 'origin', path.join(temporary, 'missing.git')]);
    const result = spawnSync(process.execPath, [cli, 'git', 'init', '--root', workspace, '--json'], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 2);
    assert(result.stderr.includes('원격 workspace 브랜치를 확인하지 못했습니다'));
    const ref = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/rundol/tms'], { cwd: workspace, encoding: 'utf8' });
    assert.notStrictEqual(ref.status, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testStateBranchAndRemoteMerge() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-git-'));
  const remote = path.join(temporary, 'remote.git');
  const first = path.join(temporary, 'first');
  const second = path.join(temporary, 'second');
  try {
    git(temporary, ['init', '--bare', '--initial-branch=main', remote]);
    initializeWorkspace(first, remote);

    const initialized = rdl(first, ['git', 'init']);
    assert.strictEqual(initialized.branch, 'rundol/tms');
    assert.strictEqual(initialized.branchCreated, true);
    assert.strictEqual(initialized.branchSource, 'seed');
    assert.strictEqual(initialized.tasks, 11);
    assert(fs.existsSync(path.join(first, 'projects', 'tms', 'tasks.json')));
    const initialCommit = git(first, ['rev-parse', 'refs/heads/rundol/tms']);
    assert.strictEqual(git(first, ['rev-list', '--parents', '-n', '1', initialCommit]).split(/\s+/).length, 1);
    const workspaceFiles = git(first, ['ls-tree', '-r', '--name-only', initialCommit]).split(/\r?\n/);
    assert(workspaceFiles.includes('tasks.json'));
    assert(workspaceFiles.includes('project.md'));
    assert(!workspaceFiles.includes('README.md'));
    const repeated = rdl(first, ['git', 'init']);
    assert.strictEqual(repeated.branchCreated, false);
    assert.strictEqual(git(first, ['rev-parse', 'refs/heads/rundol/tms']), initialCommit);

    const cliCreated = rdl(first, ['task', 'add', 'CLI', '태스크', '--summary', 'CLI 생성 흐름을 검증한다.', '--owner', 'MEMBER-001', '--reviewer', 'MEMBER-002', '--stakeholder', 'STAKEHOLDER-001', '--priority', 'high', '--link', 'TST-001', '--acceptance', 'CLI에서 태스크가 생성된다.']);
    assert(/^TASK-[A-Z0-9]{20,32}$/.test(cliCreated.taskId));
    assert.strictEqual(cliCreated.task.title, 'CLI 태스크');
    assert.strictEqual(cliCreated.task.owner, 'MEMBER-001');
    assert.deepStrictEqual(cliCreated.task.reviewers, ['MEMBER-002']);
    assert.strictEqual(cliCreated.task.priority, 'high');

    const created = taskCreate(first, {
      title: '보드에서 생성한 태스크',
      summary: '태스크 생성과 전체 필드 수정을 검증한다.',
      owner: null,
      reviewers: [],
      stakeholders: [],
      status: 'todo',
      priority: 'mid',
      links: [],
      deps: [],
      acceptanceCriteria: { 'AC-001': { text: '생성 결과가 검증된다.', done: false } },
      blocker: null,
      externalRefs: []
    });
    assert(/^TASK-[A-Z0-9]{20,32}$/.test(created.taskId));
    const updated = taskUpdate(first, created.taskId, { title: '수정된 보드 태스크', priority: 'high' });
    assert.strictEqual(updated.changed, true);
    const projected = JSON.parse(fs.readFileSync(path.join(first, 'projects', 'tms', 'tasks.json'), 'utf8'));
    assert.strictEqual(projected.tasks[created.taskId].title, '수정된 보드 태스크');
    assert.strictEqual(projected.tasks[created.taskId].priority, 'high');
    fs.appendFileSync(path.join(first, 'projects', 'tms', 'project.md'), '\n<!-- save command test -->\n');
    const saved = rdl(first, ['save']);
    assert.strictEqual(saved.changed, true);
    const published = rdl(first, ['sync']);
    assert.strictEqual(published.action, 'publish-new');
    if (published.settings) {
      assert.strictEqual(
        git(first, ['rev-parse', `refs/remotes/origin/${published.settings.branch}`]),
        git(first, ['rev-parse', `refs/heads/${published.settings.branch}`])
      );
    }
    assert.strictEqual(
      git(first, ['rev-parse', `refs/remotes/origin/${published.branch}`]),
      git(first, ['rev-parse', `refs/heads/${published.branch}`])
    );

    git(temporary, ['clone', '--branch', 'main', remote, second]);
    configureClone(second);
    git(second, ['update-ref', '-d', 'refs/remotes/origin/rundol/tms']);
    const clonedState = rdl(second, ['git', 'init']);
    assert.strictEqual(clonedState.branchSource, 'refs/remotes/origin/rundol/tms');

    fs.appendFileSync(path.join(first, 'projects', 'tms', 'project.md'), '\n<!-- first document change -->\n');
    rdl(first, ['save']);
    assert.strictEqual(rdl(first, ['sync']).action, 'local-ahead');
    const secondDocument = fs.readdirSync(path.join(second, 'projects', 'tms', 'docs')).find((name) => name.endsWith('.md'));
    fs.appendFileSync(path.join(second, 'projects', 'tms', 'docs', secondDocument), '\n<!-- second document change -->\n');
    rdl(second, ['save']);
    assert.strictEqual(rdl(second, ['sync']).action, 'semantic-merge');
    assert.strictEqual(rdl(first, ['sync']).action, 'fast-forward');

    const firstChange = rdl(first, ['task', 'set', 'TASK-01J000000000000000000003', '--status', 'doing', '--owner', 'MEMBER-005']);
    assert.strictEqual(firstChange.changed, true);
    const noChange = rdl(first, ['task', 'set', 'TASK-01J000000000000000000003', '--status', 'doing', '--owner', 'MEMBER-005']);
    assert.strictEqual(noChange.changed, false);

    const secondChange = rdl(second, ['task', 'set', 'TASK-01J000000000000000000005', '--status', 'doing', '--owner', 'MEMBER-003']);
    assert.strictEqual(secondChange.changed, true);
    assert.strictEqual(rdl(first, ['sync']).action, 'local-ahead');
    const merged = rdl(second, ['sync']);
    assert.strictEqual(merged.action, 'semantic-merge');

    const state = JSON.parse(git(temporary, ['--git-dir', remote, 'show', 'refs/heads/rundol/tms:tasks.json']));
    assert.strictEqual(state.tasks['TASK-01J000000000000000000003'].status, 'doing');
    assert.strictEqual(state.tasks['TASK-01J000000000000000000005'].owner, 'MEMBER-003');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

testSemanticMerge();
testRemoteFailureDoesNotCreateBranch();
testStateBranchAndRemoteMerge();
process.stdout.write('git tests passed\n');
