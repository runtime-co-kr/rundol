'use strict';

// TASK-CFS127VF AC-005 — 재부팅 복구가 OS 유닛 하나로 끝난다.
//
// 이 시험이 지키는 것은 세 문장이다.
//
//   1. 유닛은 **하나**이고 상주다. 주기 기동 유닛이 아니다.
//   2. 유닛을 내는 경로가 유닛을 **놓지 않는다**. REQ-066이 설치를 범위 밖에 두고
//      "문서로 본문을 싣되 도구가 넣지 않는다"고 적은 자리다.
//   3. 재부팅 뒤 남은 잠금이 그 하나를 막지 않는다. 막으면 사람이 손으로 치워야
//      하고, 그러면 복구는 유닛 하나로 끝나지 않는다.
//
// 3번이 이 AC의 진짜 내용이다. 1·2는 유닛의 모양이지만 3은 유닛이 뜬 다음의
// 사실이며, 그것이 성립하지 않으면 유닛을 아무리 잘 써도 아침마다 사람이 잠금을
// 지우게 된다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const { driverUnit, UNIT_KINDS } = require('../src/driver-unit');

const base = { clientId: 'driver-a', root: '/ws', node: '/usr/bin/node', cli: '/ws/bin/rdl.js' };

// ── 1. 유닛은 하나이고 상주다 ─────────────────────────────────────────────

for (const kind of UNIT_KINDS) {
  const unit = driverUnit(Object.assign({ kind }, base));

  // 유닛이 띄우는 것은 상주 루프다. `--once`가 들어가면 한 회전 뒤에 끝나는
  // 프로세스가 되고, 그러면 바깥에 주기 트리거가 다시 필요해진다 — 이 기능이
  // 없애려던 바로 그 바깥이다.
  assert(!unit.argv.includes('--once'), `${kind}: 유닛이 한 번만 도는 프로세스를 띄우면 안 됩니다`);
  assert.deepStrictEqual(unit.argv.slice(2, 4), ['run', 'driver'], `${kind}: 유닛은 rdl run driver를 띄웁니다`);
  assert(unit.argv.includes('--client-id') && unit.argv.includes('driver-a'), `${kind}: 드라이버 명의가 유닛에 실려야 합니다`);
  // WorkingDirectory를 믿지 않는다. 부팅 시점의 작업 디렉터리는 유닛 종류마다
  // 다르고, 틀리면 드라이버는 작업공간을 찾지 못한 채 조용히 아무것도 몰지 않는다.
  assert(unit.argv.includes('--root') && unit.argv.includes('/ws'), `${kind}: 작업공간을 명시해야 합니다`);

  // 놓는 것은 사람이다. 이 값이 true로 바뀌는 날 그것은 값의 변화로 드러난다.
  assert.strictEqual(unit.installs, false, `${kind}: 유닛 생성이 설치를 겸하면 안 됩니다`);
  assert(unit.body.length > 0 && unit.install.length > 0, `${kind}: 본문과 놓는 방법이 함께 나와야 합니다`);
}

// launchd — 부팅 때 한 번 띄우고 죽으면 다시 띄운다. 주기 기동 열쇠는 없다.
{
  const unit = driverUnit(Object.assign({ kind: 'launchd' }, base));
  assert(unit.body.includes('<key>RunAtLoad</key>'), unit.body);
  assert(unit.body.includes('<key>KeepAlive</key>'), unit.body);
  for (const periodic of ['StartInterval', 'StartCalendarInterval']) {
    // 주기 기동은 회전마다 새 프로세스를 띄운다. `driver-workspace` 잠금이 두
    // 번째부터 전부 거절하므로 남는 것은 실패 이력뿐이다.
    assert(!unit.body.includes(periodic), `launchd 유닛에 주기 기동 열쇠가 있습니다: ${periodic}`);
  }
  assert.strictEqual(unit.path, '~/Library/LaunchAgents/dev.rundol.driver.plist');
  // 경로에 XML 특수문자가 들어도 plist가 깨지지 않아야 한다. 깨진 plist는 조용히
  // 적재되지 않고, 그 침묵은 "몰 런이 없다"와 구분되지 않는다.
  const awkward = driverUnit(Object.assign({}, base, { kind: 'launchd', root: '/ws/a&b<c>' }));
  assert(awkward.body.includes('/ws/a&amp;b&lt;c&gt;'), awkward.body);
  assert(!/<string>[^<]*[<&][^<]*<\/string>/u.test(awkward.body.replace(/&(amp|lt|gt|quot);/gu, '')), '이스케이프되지 않은 문자가 남았습니다');
}

// systemd — 타이머 유닛이 아니라 서비스 유닛 하나다.
{
  const unit = driverUnit(Object.assign({ kind: 'systemd' }, base));
  assert(unit.body.includes('Type=simple'), unit.body);
  assert(unit.body.includes('Restart=always'), unit.body);
  assert(unit.body.includes('WantedBy=default.target'), unit.body);
  for (const timer of ['[Timer]', 'OnBootSec', 'OnUnitActiveSec', 'OnCalendar']) {
    assert(!unit.body.includes(timer), `systemd 유닛이 타이머로 바뀌었습니다: ${timer}`);
  }
  // 공백이 든 경로가 인자 둘로 갈리지 않아야 한다.
  const spaced = driverUnit(Object.assign({}, base, { kind: 'systemd', root: '/ws/My Work' }));
  assert(spaced.body.includes('"/ws/My Work"'), spaced.body);
  // 로그인 없이 부팅 때 뜨려면 linger가 필요하다. 이 줄이 없으면 유닛은 만들어졌는데
  // 재부팅 뒤에 뜨지 않는다 — 사람이 로그인할 때까지 조용하다.
  assert(unit.install.some((line) => line.includes('enable-linger')), unit.install.join('\n'));
}

// schtasks — ONSTART가 아니라 ONLOGON. ONSTART는 사용자 프로필 없이 SYSTEM으로 돌고,
// 그러면 AI 클라이언트의 자격 증명이 없는 채로 드라이버가 돈다.
{
  const unit = driverUnit(Object.assign({ kind: 'schtasks' }, base));
  assert(unit.body.includes('/SC ONLOGON'), unit.body);
  assert(!unit.body.includes('ONSTART'), unit.body);
  assert(!/\/SC\s+MINUTE/u.test(unit.body), '주기 기동은 잠금이 전부 거절합니다');
}

// 인자 오류는 실패로 끝난다. 자격 없이 조용히 도는 유닛보다 시끄럽게 실패하는 편이 낫다.
for (const input of [
  { kind: 'bogus' },
  { kind: 'launchd', clientId: '' },
  { kind: 'launchd', interval: 3 },
  { kind: 'launchd', interval: 'soon' }
]) {
  assert.throws(() => driverUnit(Object.assign({}, base, input)), `거부해야 합니다: ${JSON.stringify(input)}`);
}

// ── 2. 유닛을 내는 경로가 유닛을 놓지 않는다 ────────────────────────────

// 순수성이 그 약속의 강제다. 규율을 주석으로 적으면 다음 사람이 "한 줄이면 되는데"로
// 넘고, 넘은 뒤에는 넘었다는 것을 아무도 모른다. fs가 없으면 넘을 수 없다.
{
  const source = fs.readFileSync(path.join(root, 'src', 'driver-unit.js'), 'utf8');
  for (const forbidden of ['fs', 'child_process', 'os', 'path']) {
    assert(!new RegExp(`require\\(\\s*'${forbidden}'\\s*\\)`, 'u').test(source),
      `유닛을 만드는 모듈이 ${forbidden}에 닿으면 그 경로는 언젠가 설치 경로가 됩니다`);
  }
}

// 명령줄도 놓지 않는다. 본문은 stdout으로만 나오고 파일은 하나도 생기지 않는다.
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-driver-unit-'));
  try {
    const target = path.join(temporary, 'LaunchAgents');
    const done = spawnSync(process.execPath, [cli, 'run', 'driver', '--client-id', 'driver-a', '--unit', 'launchd', '--root', temporary],
      { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { HOME: temporary }) });
    assert.strictEqual(done.status, 0, done.stderr);
    assert(done.stdout.startsWith('<?xml version="1.0"'), `본문만 stdout으로 나와야 합니다: ${done.stdout.slice(0, 60)}`);
    // 놓는 방법은 stderr로 간다. 그래야 stdout을 그대로 리다이렉트해 유닛 파일을
    // 만들 수 있고, 만드는 행위는 사람의 손에 남는다.
    assert(done.stderr.includes('Rundol은 이 유닛을 놓지 않습니다'), done.stderr);
    assert.strictEqual(fs.existsSync(target), false, '유닛을 내는 명령이 자리를 만들면 안 됩니다');
    assert.deepStrictEqual(fs.readdirSync(temporary), [], '유닛을 내는 명령이 파일을 남기면 안 됩니다');

    const structured = spawnSync(process.execPath, [cli, 'run', 'driver', '--client-id', 'driver-a', '--unit', 'systemd', '--root', temporary, '--json'],
      { cwd: root, encoding: 'utf8' });
    assert.strictEqual(structured.status, 0, structured.stderr);
    const parsed = JSON.parse(structured.stdout);
    assert.strictEqual(parsed.installs, false);
    assert.strictEqual(parsed.kind, 'systemd');

    for (const args of [['--unit', 'bogus'], ['--unit', 'launchd', '--interval', '3']]) {
      const refused = spawnSync(process.execPath, [cli, 'run', 'driver', '--client-id', 'driver-a', '--root', temporary].concat(args),
        { cwd: root, encoding: 'utf8' });
      assert.strictEqual(refused.status, 2, `거부해야 합니다: ${args.join(' ')}\n${refused.stdout}${refused.stderr}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// ── 3. 재부팅 뒤 남은 잠금이 유닛 하나를 막지 않는다 ────────────────────
//
// 강제 종료된 드라이버는 `driver-workspace` 잠금을 놓지 못한다. 재부팅 뒤 유닛이
// 띄운 드라이버가 그 잠금에서 거절되면, 복구는 유닛 하나가 아니라 "유닛 하나 +
// 사람이 잠금을 지우기"가 된다.
//
// 잠금 디렉터리는 임시 자리로 주입한다. 시험이 기계의 잠금 디렉터리를 건드리면
// 시험을 돌린 것만으로 그 기계의 드라이버가 기동하지 못할 수 있다(TST-038).

(async () => {
  const { runDriver } = require('../src/run-driver');
  const runtime = require('../src/runtime');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-driver-reboot-'));
  try {
    const workspace = { id: 'ffffffffffffffff', locks: path.join(temporary, 'locks') };
    fs.mkdirSync(workspace.locks, { recursive: true });

    // 재부팅 전의 드라이버가 남긴 잠금. 그 pid는 이제 없다.
    const dead = runtime.acquireProcessLock(workspace, 'driver-workspace', );
    dead.release();
    const lockFile = dead.file;
    fs.writeFileSync(lockFile, `${JSON.stringify({
      schemaVersion: 1, kind: 'driver', workspaceId: workspace.id, projectId: 'workspace',
      pid: 999999, token: 'a'.repeat(32)
    })}\n`, 'utf8');
    assert.strictEqual(fs.existsSync(lockFile), true, '재부팅 전 잠금을 세우지 못했습니다');

    const controller = new AbortController();
    let rotations = 0;
    const result = await runDriver(temporary, { clientId: 'driver-a', interval: 5, signal: controller.signal }, {
      runtime: Object.assign({}, runtime, { runtimeWorkspace: () => workspace }),
      driveRotation: () => { rotations += 1; controller.abort(); return Promise.resolve({ drove: false }); },
      setTimeout: (fn) => setTimeout(fn, 0),
      clearTimeout
    });
    assert.strictEqual(result.once, false);
    assert.ok(result.rotations >= 1, '재부팅 뒤 첫 회전이 돌아야 합니다');
    // 잠금을 회수했고, 끝나면서 다시 놓았다. 다음 재부팅도 같은 유닛 하나로 끝난다.
    assert.strictEqual(fs.existsSync(lockFile), false, '루프가 끝나면 잠금을 놓아야 합니다');

    // 살아 있는 드라이버는 여전히 둘째 기동을 막는다. 죽은 잠금을 회수한다는 것이
    // 잠금을 무시한다는 뜻이면 AC-004가 무너진다.
    const live = runtime.acquireProcessLock(workspace, 'driver-workspace');
    try {
      await assert.rejects(() => runDriver(temporary, { clientId: 'driver-b', interval: 5, signal: new AbortController().signal }, {
        runtime: Object.assign({}, runtime, { runtimeWorkspace: () => workspace }),
        driveRotation: () => Promise.resolve({ drove: false }),
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout
      }), /already running/u, '살아 있는 드라이버가 있으면 둘째 기동은 거절됩니다');
    } finally {
      live.release();
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  process.stdout.write('driver unit tests passed\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
