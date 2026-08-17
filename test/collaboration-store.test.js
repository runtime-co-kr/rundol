'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-collaboration-store-'));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) { return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), root)); }

try {
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  rdl(['init', 'crm', '--name', '고객 관리', '--defaults']);

  const registered = rdl(['client', 'register', 'laptop-a', '--name', '업무 노트북', '--type', 'device', '--owner', 'MEMBER-001']);
  assert.strictEqual(registered.id, 'laptop-a');
  assert(fs.existsSync(path.join(temporary, 'projects', 'workspace', 'clients', 'client-laptop-a.yaml')));
  assert.strictEqual(rdl(['client', 'show', 'laptop-a']).owner, 'MEMBER-001');

  const acquired = rdl(['lease', 'acquire', 'project:crm', '--project', 'crm', '--client-id', 'laptop-a']);
  assert.strictEqual(acquired.type, 'lease.acquired');
  const eventFile = path.join(temporary, 'projects', 'workspace', 'events', 'lease-crm-laptop-a-000001.jsonl');
  assert(fs.existsSync(eventFile));
  assert.strictEqual(rdl(['lease', 'list', '--project', 'crm']).leases.length, 1);
  assert.strictEqual(rdl(['lease', 'renew', 'project:crm', '--project', 'crm', '--client-id', 'laptop-a']).type, 'lease.renewed');
  assert.strictEqual(rdl(['lease', 'release', 'project:crm', '--project', 'crm', '--client-id', 'laptop-a']).type, 'lease.released');
  assert.strictEqual(rdl(['lease', 'list', '--project', 'crm']).leases.length, 0);

  const localState = path.join(temporary, 'projects', 'crm', '.rundol');
  assert(fs.existsSync(path.join(localState, 'state', 'tasks.json')));
  const projectStatus = command('git', ['status', '--short'], path.join(temporary, 'projects', 'crm'));
  assert(!projectStatus.includes('.rundol'));
  process.stdout.write('collaboration store tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
