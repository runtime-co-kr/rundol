'use strict';

// TASK-M0EJ7A89 — 세션 시작 훅이 대기 런을 드러낸다.
//
// 이 시험이 지키는 것은 **남의 설정 파일을 고치는 일의 규율**이다. 기능이 아니라
// 규율이 위험이다. 훅이 하는 일은 한 줄이고, 그 한 줄을 남의 파일에 넣는 방법이
// 이 태스크의 전부다.
//
//   AC-001 덮어쓰지 않고 병합한다
//   AC-002 넣은 구간만 표시되고 그것만 제거할 수 있다
//   AC-003 훅은 조회만 하고 런을 몰지 않는다
//   AC-004 사용자가 직접 쓴 훅과 설정이 보존된다
//   AC-005 설치가 실패하면 조용히 퇴화하지 않고 드러낸다
//
// 픽스처는 임시 디렉터리에 세운다. 실제 사용자 설정(`~/.claude`, `~/.codex`)에는
// 한 글자도 쓰지 않는다 — 시험이 그것을 건드리면 시험을 돌린 것만으로 그 기계의
// 클라이언트 설정이 달라지고, 그 변화는 아무 신호 없이 일어난다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const install = require('../src/hook-install');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-hook-install-'));

function target(name) {
  return { client: name === 'claude' ? 'claude' : 'codex', label: name, file: path.join(temporary, `${name}.json`) };
}

function write(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function settings(name) {
  return { targets: [target(name)], node: '/usr/bin/node', cli: '/repo/bin/rdl.js' };
}

try {
  // ── AC-003 — 훅은 조회만 하고 런을 몰지 않는다 ─────────────────────────
  //
  // 먼저 잰다. 훅이 무엇을 부르는지가 나머지 넷의 전제다 — 미는 훅을 잘 병합해 봐야
  // 잘못된 것을 잘 설치한 것이다.
  {
    const entry = install.sessionStartEntry({ client: 'claude', node: '/usr/bin/node', cli: '/repo/bin/rdl.js' });
    const args = entry.hooks[0].args;
    assert.deepStrictEqual(args.slice(1), ['hook', 'session-start', '--client', 'claude'],
      '훅은 트리거만 담는다. 판정이 여기 들어가면 클라이언트마다 답이 갈린다');
    // 미는 명령은 하나도 없다. 드라이버는 사람이 없을 때 돌고 이 훅은 사람이 앉는
    // 순간에 돈다 — 두 자리가 섞이면 세션을 여는 것만으로 런이 전진한다.
    for (const forbidden of ['drive', 'driver', 'step', 'gate', 'approve', 'resume', 'complete', 'save', 'sync']) {
      assert(!args.includes(forbidden), `세션 시작 훅이 런을 몹니다: ${forbidden}`);
    }
    assert.strictEqual(entry.hooks[0].command, '/usr/bin/node');
    assert.strictEqual(entry.matcher, 'startup|resume', 'Claude Code는 startup·resume에서만 건다');
    // Codex의 SessionStart에는 matcher가 없다. 없는 자리에 넣으면 항목이 조용히
    // 무시되거나 설정이 거부되고, 둘 다 "설치했는데 안 돈다"로 보인다.
    assert.strictEqual(install.sessionStartEntry({ client: 'codex', node: 'n', cli: 'c' }).matcher, undefined);
  }

  // 판정 쪽도 같은 약속을 지켜야 한다. 훅이 조회만 한다는 것은 훅 스크립트의
  // 인자뿐 아니라 그 인자가 부르는 코드의 성질이기도 하다.
  {
    const source = fs.readFileSync(path.join(root, 'src', 'hook.js'), 'utf8');
    for (const forbidden of ['run-driver', 'runDrive', 'driveRotation', 'run-dispatch']) {
      assert(!source.includes(forbidden), `훅 판정부가 런을 미는 경로에 닿습니다: ${forbidden}`);
    }
    // 반대로 대기 런을 읽는 경로는 있어야 한다. 없으면 이 태스크의 제목이 거짓이 된다.
    assert(source.includes('pendingRuns'), '세션 시작 훅이 대기 런을 읽지 않습니다');
  }

  // ── AC-001 · AC-004 — 덮어쓰지 않고 병합하며, 사용자의 것은 보존된다 ──
  {
    const file = target('claude').file;
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(git status)'] },
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo', args: ['mine'] }] },
          { hooks: [{ type: 'command', command: 'echo', args: ['second'] }] }
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'echo', args: ['stop'] }] }]
      }
    };
    write(file, original);
    const before = fs.readFileSync(file, 'utf8');

    const result = install.installHooks(settings('claude'));
    assert.strictEqual(result.targets[0].status, 'merged');

    const after = read(file);
    // 최상위의 다른 열쇠가 그대로다. 설정 파일은 훅만 담는 파일이 아니다.
    assert.strictEqual(after.model, 'opus');
    assert.deepStrictEqual(after.permissions, original.permissions);
    // 다른 이벤트가 그대로다.
    assert.deepStrictEqual(after.hooks.Stop, original.hooks.Stop);
    // 같은 이벤트의 사용자 항목이 **순서까지** 그대로다. 순서를 바꾸면 먼저 돌던
    // 훅이 나중에 돌고, 그 차이는 설치 로그 어디에도 남지 않는다.
    assert.deepStrictEqual(after.hooks.SessionStart.slice(0, 2), original.hooks.SessionStart);
    assert.strictEqual(after.hooks.SessionStart.length, 3);
    assert.strictEqual(after.hooks.SessionStart[2][install.MARKER], install.SESSION_START_REGION);

    // 두 번 설치해도 구간은 하나다. 둘이 되면 컨텍스트가 두 벌 주입되고, 사람은
    // 그것을 훅의 결함으로 읽는다.
    install.installHooks(settings('claude'));
    const twice = read(file);
    assert.strictEqual(twice.hooks.SessionStart.filter((entry) => entry[install.MARKER]).length, 1, '재설치가 구간을 늘리면 안 됩니다');
    assert.strictEqual(twice.hooks.SessionStart.length, 3);
    // 같은 내용이면 파일을 다시 쓰지도 않는다.
    assert.strictEqual(install.installHooks(settings('claude')).targets[0].status, 'unchanged');

    // ── AC-002 — 넣은 구간만 표시되고 그것만 제거할 수 있다 ───────────
    const shown = install.hookInstallStatus(settings('claude')).targets[0];
    assert.strictEqual(shown.status, 'installed');
    assert.deepStrictEqual(shown.regions, [install.SESSION_START_REGION]);
    // 남을 것이 몇 건인지 말할 수 있어야 "그것만 지운다"를 확인할 수 있다.
    assert.strictEqual(shown.userEntries, 2);

    const removed = install.removeHooks(settings('claude')).targets[0];
    assert.strictEqual(removed.status, 'removed');
    assert.strictEqual(removed.removed, 1);
    assert.strictEqual(removed.deleted, false, '사람의 설정이 남은 파일을 지우면 안 됩니다');
    // 되돌린 뒤의 내용이 원본과 같다. 이것이 이 태스크의 중심 단언이다.
    assert.deepStrictEqual(read(file), original, '되돌린 설정이 원본과 달라졌습니다');
    // 원본이 이미 정규 직렬화였으므로 바이트까지 같다.
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, '되돌린 설정의 바이트가 달라졌습니다');

    // 없는 것을 지우는 것은 실패가 아니다. 이미 되돌린 자리를 다시 되돌릴 수 있다.
    assert.strictEqual(install.removeHooks(settings('claude')).targets[0].status, 'absent');
  }

  // 설정 파일이 아예 없던 자리. 만들고, 되돌리면 자국을 남기지 않는다.
  {
    const file = target('codex').file;
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(install.installHooks(settings('codex')).targets[0].status, 'created');
    assert.strictEqual(read(file).hooks.SessionStart.length, 1);

    const removed = install.removeHooks(settings('codex')).targets[0];
    assert.strictEqual(removed.deleted, true, '우리가 만든 파일은 되돌릴 때 치웁니다');
    // 빈 객체 하나는 설정이 아니라 우리가 지나간 자국이다. 자국을 남기면
    // "되돌렸다"가 참이 아니게 된다.
    assert.strictEqual(fs.existsSync(file), false);
  }

  // 사용자가 직접 쓴 rdl 훅은 보존하고 우리 것을 넣지 않는다. 넣으면 세션마다
  // 훅이 두 번 돈다. `rdl skill install`이 표 없는 스킬 디렉터리를 보존하는 것과
  // 같은 판단이다.
  {
    const file = target('claude').file;
    const mine = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: ['/repo/bin/rdl.js', 'hook', 'session-start'] }] }] }
    };
    write(file, mine);
    const before = fs.readFileSync(file, 'utf8');
    const result = install.installHooks(settings('claude')).targets[0];
    assert.strictEqual(result.status, 'preserved');
    assert(result.reason.includes('두 번'), result.reason);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, '보존은 한 바이트도 쓰지 않는 것입니다');
    fs.rmSync(file, { force: true });
  }

  // ── AC-005 — 설치가 실패하면 조용히 퇴화하지 않고 드러낸다 ────────────
  //
  // 조용히 퇴화하는 방법은 둘이다 — 덮어쓰거나, 건너뛰고 성공이라 말하거나.
  // 둘 다 결과가 같다: 사람은 훅이 설치된 줄 알고, 설치되지 않은 훅은 없는 훅이다.
  {
    const file = target('claude').file;
    for (const broken of [
      '{ "hooks": { "SessionStart": [] }',            // 닫히지 않은 JSON
      '[]',                                            // 최상위가 배열
      '{ "hooks": [] }',                               // hooks가 배열
      '{ "hooks": { "SessionStart": {} } }'            // 이벤트가 객체
    ]) {
      write(file, broken);
      const result = install.installHooks(settings('claude')).targets[0];
      assert.strictEqual(result.status, 'failed', `읽지 못한 설정을 성공으로 넘겼습니다: ${broken}`);
      assert(result.reason && result.reason.length, '실패에는 사유가 있어야 합니다');
      // 그리고 그 파일은 한 글자도 달라지지 않는다. 이해하지 못한 설정을 새
      // 내용으로 덮어쓰면 사람의 설정이 사라진다.
      assert.strictEqual(fs.readFileSync(file, 'utf8'), broken, `읽지 못한 설정을 건드렸습니다: ${broken}`);
      // 조회와 제거도 같은 자리에서 같은 말을 한다.
      assert.strictEqual(install.hookInstallStatus(settings('claude')).targets[0].status, 'unreadable');
      assert.strictEqual(install.removeHooks(settings('claude')).targets[0].status, 'failed');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), broken);
    }
    fs.rmSync(file, { force: true });
  }

  // 한 대상이 실패해도 다른 대상은 시도된다. 첫 실패에서 멈추면 "무엇이 설치됐고
  // 무엇이 안 됐나"에 답할 수 없다.
  {
    const claude = target('claude');
    const codex = target('codex');
    write(claude.file, '{ not json');
    const result = install.installHooks({ targets: [claude, codex], node: 'n', cli: 'c' });
    assert.strictEqual(result.targets[0].status, 'failed');
    assert.strictEqual(result.targets[1].status, 'created', '앞이 실패했다고 뒤를 건너뛰면 안 됩니다');
    fs.rmSync(claude.file, { force: true });
    fs.rmSync(codex.file, { force: true });
  }

  // ── 명령줄 — 실패가 종료 상태로 드러난다 ──────────────────────────────
  {
    const clientHome = fs.mkdtempSync(path.join(temporary, 'home-'));
    const claudeHome = path.join(clientHome, 'claude');
    const codexHome = path.join(clientHome, 'codex');
    const environment = Object.assign({}, process.env, {
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: codexHome,
      RUNDOL_COPILOT_HOME: path.join(clientHome, 'copilot')
    });
    const rdl = (args) => spawnSync(process.execPath, [cli].concat(args), { cwd: root, encoding: 'utf8', env: environment });

    const installed = rdl(['skill', 'install', '--json']);
    assert.strictEqual(installed.status, 0, installed.stderr);
    const parsed = JSON.parse(installed.stdout);
    assert.strictEqual(parsed.hooks.targets.length, 2);
    assert(parsed.hooks.targets.every((item) => ['created', 'merged'].includes(item.status)), installed.stdout);
    assert(fs.existsSync(path.join(claudeHome, 'settings.json')));

    // --no-hooks는 스킬만 놓는다. 훅 병합을 원하지 않는 사람에게 나갈 길이 있어야
    // 하고, 나갈 길이 없는 병합은 강요다.
    fs.rmSync(path.join(claudeHome, 'settings.json'), { force: true });
    fs.rmSync(path.join(codexHome, 'hooks.json'), { force: true });
    const skipped = rdl(['skill', 'install', '--no-hooks', '--json']);
    assert.strictEqual(skipped.status, 0, skipped.stderr);
    assert.strictEqual(JSON.parse(skipped.stdout).hooks, null);
    assert.strictEqual(fs.existsSync(path.join(claudeHome, 'settings.json')), false);

    // 깨진 설정 위에서는 0으로 끝나지 않는다. 종료 상태가 0이면 자동화는 설치가
    // 끝난 것으로 읽고, 그것이 조용한 퇴화의 정확한 모양이다.
    fs.mkdirSync(claudeHome, { recursive: true });
    write(path.join(claudeHome, 'settings.json'), '{ "hooks": ');
    const loud = rdl(['skill', 'install']);
    assert.strictEqual(loud.status, 2, `실패를 성공으로 끝냈습니다:\n${loud.stdout}\n${loud.stderr}`);
    assert(loud.stderr.includes('훅 병합 실패'), loud.stderr);
    assert.strictEqual(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'), '{ "hooks": ');
    // 그래도 다른 대상은 설치된다. 실패가 전부를 멈추지 않는다.
    assert(fs.existsSync(path.join(codexHome, 'hooks.json')));

    const status = rdl(['skill', 'hooks']);
    assert.strictEqual(status.status, 2, '읽지 못한 대상이 있으면 조회도 조용히 끝나지 않습니다');
    assert(status.stdout.includes('unreadable'), status.stdout);

    fs.rmSync(path.join(claudeHome, 'settings.json'), { force: true });
    const clean = rdl(['skill', 'hooks']);
    assert.strictEqual(clean.status, 0, clean.stderr);
    assert(clean.stdout.includes(install.SESSION_START_REGION), clean.stdout);

    const reverted = rdl(['skill', 'hooks', '--remove', '--json']);
    assert.strictEqual(reverted.status, 0, reverted.stderr);
    assert.strictEqual(fs.existsSync(path.join(codexHome, 'hooks.json')), false, '우리가 만든 파일은 되돌릴 때 사라집니다');
  }

  process.stdout.write('hook install tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
