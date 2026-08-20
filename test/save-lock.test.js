'use strict';

// 저장의 배타. 프로젝트 worktree는 프로젝트마다 하나뿐이므로 두 저장이 겹치면 뒤엣것의
// `git add -A`가 앞엣것이 아직 커밋하지 못한 변경까지 담는다. 여기서 재는 것은 그 겹침이
// 실제로 거절되는가, 그리고 거절이 기다림이 아니라 즉시인가이다.
//
// 락은 프로세스 경계에서만 의미가 있으므로 자식 프로세스로 잰다. 같은 프로세스 안에서
// 부르면 잠금을 쥔 채 다시 부르는 것이 되어 실제 시나리오와 다르다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-save-lock-'));
const home = path.join(temporary, 'runtime');

function environment() {
  return Object.assign({}, process.env, { RUNDOL_HOME: home });
}

function run(program, args, cwd) {
  return spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: environment() });
}

function command(program, args, cwd) {
  const result = run(program, args, cwd);
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(args) { return command('git', args); }
function rdl(args) { return run(process.execPath, [cli].concat(args, ['--root', temporary]), repository); }

try {
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Rundol Test']);
  git(['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  command(process.execPath, [cli, 'init', 'crm', '--name', 'CRM', '--profile', 'lean', '--root', temporary, '--json'], repository);
  // 문서 강제는 이 시험의 대상이 아니다. 켜 두면 저장이 잠금과 무관한 이유로 막혀
  // 배타를 재지 못한다.
  command(process.execPath, [cli, 'contract', 'set', '--project', 'crm', '--profile', 'lean', '--enforcement', 'advisory', '--root', temporary, '--json'], repository);

  // 잠금은 CLI가 보는 것과 같은 자리에 걸어야 한다. RUNDOL_HOME이 갈리면 두 쪽이
  // 서로 다른 파일을 보고 이 시험은 아무것도 재지 않는다.
  const savedHome = process.env.RUNDOL_HOME;
  process.env.RUNDOL_HOME = home;
  const { runtimeWorkspace, acquireProcessLock } = require('../src/runtime');
  const workspace = runtimeWorkspace(temporary);

  // 잠긴 동안에는 거절한다. pid를 이 시험 프로세스로 두어 자식이 생존 확인을 통과하게
  // 한다 — 죽은 잠금이면 자식이 회수하고 지나가므로 배타를 재지 못한다.
  const held = acquireProcessLock(workspace.locks, { kind: 'save', projectId:'crm', workspaceId: workspace.id, pid: process.pid });
  const blocked = rdl(['save', '--project', 'crm']);
  assert.notStrictEqual(blocked.status, 0, `잠긴 저장은 성공하면 안 됩니다\n${blocked.stdout}\n${blocked.stderr}`);
  const blockedOutput = `${blocked.stdout}\n${blocked.stderr}`;
  assert.ok(/RDL-SAVE-012/u.test(blockedOutput), `거절 코드가 드러나야 합니다: ${blockedOutput}`);
  assert.ok(/crm/u.test(blockedOutput), `무엇이 잠겼는지 말해야 합니다: ${blockedOutput}`);
  assert.ok(new RegExp(`pid ${process.pid}`, 'u').test(blockedOutput), `누가 쥐고 있는지 말해야 합니다: ${blockedOutput}`);

  // 기다리지 않는다. 붙잡아 두면 그 세션이 통째로 멈추므로 거절이 즉시여야 한다.
  const startedAt = process.hrtime.bigint();
  const again = rdl(['save', '--project', 'crm']);
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
  assert.notStrictEqual(again.status, 0);
  assert.ok(elapsedMs < 30000, `거절은 기다림이 아니라 즉시여야 합니다: ${elapsedMs}ms`);

  // 놓으면 지나간다. 잠금이 남아 실패가 계속되면 그것은 배타가 아니라 고장이다.
  held.release();
  const allowed = rdl(['save', '--project', 'crm', '--json']);
  assert.strictEqual(allowed.status, 0, `잠금을 놓은 뒤에는 저장됩니다\n${allowed.stdout}\n${allowed.stderr}`);
  assert.ok(!fs.existsSync(held.file), '저장이 끝나면 잠금 파일이 남지 않습니다');

  // 프로젝트가 다르면 서로 막지 않는다. 한 프로젝트의 저장이 다른 프로젝트를 멈추면
  // 이 잠금은 배타가 아니라 병목이다.
  command(process.execPath, [cli, 'project', 'add', 'ops', '--name', 'Ops', '--profile', 'lean', '--root', temporary, '--json'], repository);
  const other = acquireProcessLock(workspace.locks, { kind: 'save', projectId:'ops', workspaceId: workspace.id, pid: process.pid });
  const unrelated = rdl(['save', '--project', 'crm', '--json']);
  assert.strictEqual(unrelated.status, 0, `다른 프로젝트의 잠금은 막지 않습니다\n${unrelated.stdout}\n${unrelated.stderr}`);
  other.release();

  if (savedHome === undefined) delete process.env.RUNDOL_HOME;
  else process.env.RUNDOL_HOME = savedHome;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log('save lock tests passed');
