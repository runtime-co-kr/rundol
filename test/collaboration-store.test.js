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

  // 문서 편집 소프트 리스는 ADR-015로 폐기했다. 중앙 권위 없이 만료 시각에 기대는
  // 배타는 보장이 아니라 조언이었는데 명령은 잠금처럼 보였다. 폐기가 조용한 실종이
  // 되지 않도록, 부르면 왜 없어졌는지와 무엇이 대신하는지를 알린다.
  const retired = spawnSync(process.execPath, [cli, 'lease', 'list', '--project', 'crm', '--root', temporary, '--json'], { cwd: root, encoding: 'utf8' });
  assert.notStrictEqual(retired.status, 0, '폐기한 명령이 성공하면 안 됩니다.');
  assert(retired.stderr.includes('ADR-015'), `폐기 안내가 근거 문서를 가리켜야 합니다: ${retired.stderr}`);
  assert(!fs.existsSync(path.join(temporary, 'projects', 'workspace', 'events', 'lease-crm-laptop-a-000001.jsonl')), '폐기한 경로가 이벤트를 만들면 안 됩니다.');

  const localState = path.join(temporary, 'projects', 'crm', '.rundol');
  assert(fs.existsSync(path.join(localState, 'state', 'tasks.json')));
  const projectStatus = command('git', ['status', '--short'], path.join(temporary, 'projects', 'crm'));
  assert(!projectStatus.includes('.rundol'));
  process.stdout.write('collaboration store tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
