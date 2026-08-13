'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-runtime-'));

function command(program, args, cwd, expectedStatus) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: runtimeHome }) });
  assert.strictEqual(result.status, expectedStatus === undefined ? 0 : expectedStatus, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(cwd, args) {
  return command('git', args, cwd).stdout.trim();
}

function rdl(cwd, args) {
  const result = command(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), root);
  return JSON.parse(result.stdout);
}

function testWorkspaceInitialization() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-init-'));
  try {
    git(temporary, ['init', '-b', 'main']);
    git(temporary, ['config', 'user.name', 'Rundol Test']);
    git(temporary, ['config', 'user.email', 'rundol@example.test']);
    fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n', 'utf8');
    git(temporary, ['add', 'README.md']);
    git(temporary, ['commit', '-m', 'initial']);

    const initialized = rdl(temporary, ['init', 'memo', '--name', '메모 앱']);
    assert.strictEqual(initialized.project, 'memo');
    assert.strictEqual(initialized.branch, 'rundol/memo');
    assert(!fs.existsSync(path.join(temporary, '.rundol')));
    assert(fs.existsSync(path.join(temporary, 'projects', 'workspace', 'workspace.yaml')));
    assert(fs.existsSync(path.join(temporary, 'projects', 'workspace', '.git')));
    const workspaceManifest = fs.readFileSync(path.join(temporary, 'projects', 'workspace', 'workspace.yaml'), 'utf8');
    assert(!workspaceManifest.includes('policies:'));
    assert(!workspaceManifest.includes('schemas:'));
    assert(fs.existsSync(path.join(temporary, 'projects', 'memo', '.git')));
    assert(fs.existsSync(path.join(temporary, 'projects', 'memo', 'project.md')));
    assert(fs.existsSync(path.join(temporary, 'projects', 'memo', '.obsidian', 'app.json')));
    assert(!fs.existsSync(path.join(temporary, 'projects', 'memo', 'docs', '.gitkeep')));
    const charter = fs.readFileSync(path.join(temporary, 'projects', 'memo', 'project.md'), 'utf8');
    assert(charter.includes('id: project:memo'));
    assert(charter.includes('# 메모 앱'));

    const initialCheck = rdl(temporary, ['check', '--strict']);
    assert.strictEqual(initialCheck.summary.errors, 0, JSON.stringify(initialCheck.diagnostics, null, 2));
    assert.strictEqual(initialCheck.summary.warnings, 0, JSON.stringify(initialCheck.diagnostics, null, 2));

    const added = rdl(temporary, ['project', 'add', 'tms', '--name', '차량 관제']);
    assert.strictEqual(added.project, 'tms');
    assert.strictEqual(added.branch, 'rundol/tms');
    assert(fs.existsSync(path.join(temporary, 'projects', 'tms', 'project.md')));
    assert(fs.existsSync(path.join(temporary, 'projects', 'tms', '.git')));
    const memoTree = git(temporary, ['ls-tree', '-r', '--name-only', 'refs/heads/rundol/memo']).split(/\r?\n/);
    const tmsTree = git(temporary, ['ls-tree', '-r', '--name-only', 'refs/heads/rundol/tms']).split(/\r?\n/);
    assert(memoTree.includes('project.md') && memoTree.includes('.gitignore') && !memoTree.includes('.obsidian/app.json'));
    assert(tmsTree.includes('project.md') && tmsTree.includes('.gitignore') && !tmsTree.includes('.obsidian/app.json'));
    const settingsTree = git(temporary, ['ls-tree', '-r', '--name-only', 'refs/heads/rundol/workspace']).split(/\r?\n/);
    assert(settingsTree.includes('projects/project-memo.yaml') && settingsTree.includes('projects/project-tms.yaml'));
    assert(!memoTree.some((file) => file.startsWith('tms/')));
    assert(!tmsTree.some((file) => file.startsWith('memo/')));
    const finalCheck = rdl(temporary, ['check', '--strict']);
    assert.deepStrictEqual(finalCheck.projects, ['memo', 'tms']);
    assert.strictEqual(finalCheck.summary.errors, 0, JSON.stringify(finalCheck.diagnostics, null, 2));
    assert.strictEqual(finalCheck.summary.warnings, 0, JSON.stringify(finalCheck.diagnostics, null, 2));

    const ambiguous = command(process.execPath, [cli, 'task', 'add', '모호한 태스크', '--acceptance', '완료', '--root', temporary, '--json'], root, 2);
    assert(ambiguous.stderr.includes('--project'));
    const task = rdl(temporary, ['task', 'add', 'TMS 태스크', '--project', 'tms', '--acceptance', '완료']);
    assert.strictEqual(task.task.project, 'tms');
    const memoTasks = JSON.parse(fs.readFileSync(path.join(temporary, 'projects', 'memo', '.rundol', 'state', 'tasks.json'), 'utf8'));
    const tmsTasks = JSON.parse(fs.readFileSync(path.join(temporary, 'projects', 'tms', '.rundol', 'state', 'tasks.json'), 'utf8'));
    assert.strictEqual(memoTasks.$schema, undefined);
    assert.strictEqual(Object.keys(memoTasks.tasks).length, 0);
    assert.strictEqual(Object.keys(tmsTasks.tasks).length, 1);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

testWorkspaceInitialization();
fs.rmSync(runtimeHome, { recursive: true, force: true });
process.stdout.write('init tests passed\n');
