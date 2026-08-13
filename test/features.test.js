'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createTaskInStore, readTaskStore, shardFiles } = require('../src/tasks');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(cwd, args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), root));
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function testShardsAtScale() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-shards-'));
  try {
    const directory = path.join(temporary, 'tasks');
    for (let index = 0; index < 1001; index += 1) createTaskInStore(directory, temporary, `TASK-${String(index).padStart(20, '0')}`, { title: `태스크 ${index}` }, 'client-a', 500);
    assert.strictEqual(shardFiles(directory).length, 3);
    assert.strictEqual(Object.keys(readTaskStore(directory).tasks).length, 1001);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testDocumentAndDebugCommands() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-features-'));
  try {
    command('git', ['init', '-b', 'main'], temporary);
    command('git', ['config', 'user.name', 'Rundol Test'], temporary);
    command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
    fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n', 'utf8');
    command('git', ['add', 'README.md'], temporary);
    command('git', ['commit', '-m', 'initial'], temporary);
    rdl(temporary, ['init', 'memo', '--name', '메모 앱', '--profile', 'lean', '--enforcement', 'advisory']);
  const prd = rdl(temporary, ['doc', 'create', 'PRD', '메모 제품 요구사항', '--owner', 'MEMBER-001', '--scope', '메모 제품의 사용자 문제와 성공 기준', '--exclude', '개별 메모 작성 동작']);
    assert.strictEqual(prd.id, 'PRD-001');
    assert(prd.relativeFile.includes('/docs/prd/'));
  const req = rdl(temporary, ['doc', 'create', 'REQ', '메모 작성', '--owner', 'MEMBER-001', '--scope', '사용자가 새 메모를 저장하는 동작', '--exclude', '메모 검색과 삭제', '--related', 'PRD-001']);
    assert.strictEqual(req.id, 'REQ-001');
    assert(req.relativeFile.includes('/docs/requirements/'));
    const checked = rdl(temporary, ['check', '--strict']);
    assert.strictEqual(checked.summary.errors, 0, JSON.stringify(checked.diagnostics, null, 2));
    rdl(temporary, ['debug', 'record', '--provider', 'test', '--model', 'model-a', '--input-tokens', '120', '--output-tokens', '30', '--cached-tokens', '10']);
    const summary = rdl(temporary, ['debug', 'summary']);
    assert.strictEqual(summary.totalTokens, 150);
    assert.strictEqual(summary.cachedTokens, 10);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testSettingsMigration() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-settings-'));
  try {
    copyDirectory(path.join(root, 'test', 'fixtures', 'workspace'), temporary);
    command('git', ['init', '-b', 'main'], temporary);
    command('git', ['config', 'user.name', 'Rundol Test'], temporary);
    command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
    command('git', ['add', '.'], temporary);
    command('git', ['commit', '-m', 'initial'], temporary);
    const migrated = rdl(temporary, ['settings', 'migrate']);
    assert.strictEqual(migrated.migrated, true);
    assert.strictEqual(migrated.branch, 'rundol/settings');
    assert(fs.existsSync(path.join(temporary, '.rundol', 'settings', 'projects', 'tms.yaml')));
    assert(fs.readFileSync(path.join(temporary, '.rundol', 'workspace.yaml'), 'utf8').includes('schemaVersion: 4'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

testShardsAtScale();
testDocumentAndDebugCommands();
testSettingsMigration();
process.stdout.write('feature tests passed\n');
