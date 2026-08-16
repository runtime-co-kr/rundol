'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-sync-finalization-'));
const remote = path.join(temporary, 'origin.git');
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(args, cwd) { return command('git', args, cwd || temporary); }
function rdl(args) { return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository)); }

try {
  git(['init', '--bare', '--initial-branch=main', remote]);
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Rundol Test']);
  git(['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', 'origin', 'main']);

  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['contract', 'set', '--project', 'crm', '--profile', 'lean', '--enforcement', 'advisory']);
  rdl(['client', 'register', 'device-a', '--name', 'Device A', '--type', 'device', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'sync-agent', '--name', 'Sync Agent', '--type', 'agent', '--owner', 'MEMBER-001']);
  fs.writeFileSync(path.join(temporary, 'projects', 'crm', 'procedures.json'), `${JSON.stringify({
    schemaVersion: 1,
    procedures: { 'quick-sync': { revision: 1, steps: [{ id: 'author', executor: 'client' }] } }
  }, null, 2)}\n`, 'utf8');

  const started = rdl(['run', 'start', 'quick-sync', '--project', 'crm', '--client-id', 'device-a']);
  rdl(['run', 'step', '--run', started.runId, '--project', 'crm', '--client-id', 'device-a']);
  rdl(['run', 'complete', '--run', started.runId, '--project', 'crm', '--client-id', 'device-a']);
  const synced = rdl(['sync', '--project', 'crm', '--client-id', 'sync-agent']);
  assert.strictEqual(synced.pushed, true);
  assert.strictEqual(synced.settings.pushed, true);
  assert.strictEqual(synced.transitions.length, 1);
  assert.strictEqual(synced.transitions[0].type, 'run.synced');
  const remoteEvents = git(['--git-dir', remote, 'grep', '-n', 'run.synced', 'refs/heads/rundol/workspace'], temporary);
  assert(remoteEvents.includes(started.runId), 'the same sync must publish run.synced to the workspace ref');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('sync finalization tests passed\n');
