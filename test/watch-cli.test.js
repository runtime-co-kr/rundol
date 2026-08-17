'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-watch-cli-'));
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-watch-cli-runtime-'));

function command(program, args, cwd, expectedStatus) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { RUNDOL_HOME: runtimeHome })
  });
  assert.strictEqual(result.status, expectedStatus === undefined ? 0 : expectedStatus, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Watch Test'], temporary);
  command('git', ['config', 'user.email', 'watch@example.invalid'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Watch CLI fixture\n', 'utf8');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  command(process.execPath, [cli, 'init', 'memo', '--name', 'Memo', '--defaults', '--json'], temporary);

  const once = command(process.execPath, [cli, 'watch', '--project', 'memo', '--once', '--json'], temporary);
  const records = once.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert(records.some((record) => record.type === 'watch.scan.started'));
  assert(records.some((record) => record.type === 'watch.scan.completed'));
  assert(records.some((record) => record.type === 'watch.diagnostic'), 'diagnostics must be emitted without changing the successful watch exit status');
  assert(records.every((record) => record.schemaVersion === 1 && record.project === 'memo'));

  const remote = command(process.execPath, [cli, 'watch', '--project', 'memo', '--remote', '--once', '--json'], temporary);
  const remoteRecords = remote.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert(remoteRecords.some((record) => record.type === 'watch.error' && record.phase.startsWith('remote:')), 'boolean --remote must activate tip observation without becoming a remote name');

  const namedRemote = command(process.execPath, [cli, 'watch', '--project', 'memo', '--remote', 'origin', '--once'], temporary, 2);
  assert(namedRemote.stderr.includes('origin'));
  const missingProject = command(process.execPath, [cli, 'watch', '--once'], temporary, 2);
  assert(missingProject.stderr.includes('--project'));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(runtimeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

process.stdout.write('watch CLI tests passed\n');
