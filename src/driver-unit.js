'use strict';

// 부팅 유닛의 본문을 만든다. **만들기만 하고 놓지 않는다.**
//
// REQ-066은 "운영체제 유닛의 설치"를 범위 밖으로 두면서 그 자리를 이렇게 적었다 —
// 문서로 본문을 싣되 도구가 넣지 않는다. 이 모듈이 그 문장의 코드 쪽이다. 본문을
// 내고, 어디에 놓는지 말하고, 거기서 멈춘다. 놓는 것은 사람의 명시적 행위다.
//
// 이 파일에 fs도 child_process도 없다는 사실이 그 약속의 유일한 강제다. 규율을
// 주석으로 적으면 다음 사람이 "한 줄이면 되는데"로 넘고, 넘은 뒤에는 넘었다는 것을
// 아무도 모른다. 그래서 이 모듈은 순수 모듈 목록에 올라 있고
// (test/worker-contract-purity.test.js), fs를 부르는 순간 시험이 죽는다.
//
// 유닛이 하나인 이유는 드라이버가 상주 프로세스이기 때문이다. 주기 실행 유닛으로
// 같은 일을 하려면 회전마다 새 프로세스를 띄워야 하고, 그러면 `driver-workspace`
// 잠금이 두 번째부터 전부 거절해 스케줄러 이력에 실패만 쌓인다. 부팅 때 한 번
// 띄우고 죽으면 다시 띄우는 것 — 그것이 유닛이 할 일의 전부다.

// 값 어휘는 정본에서 가져온다. 여기 사본을 두면 `--unit`이 받는 값과 도움말이 말하는
// 값이 갈릴 수 있고, 갈린 뒤에는 어느 쪽이 참인지 물을 자리가 없다.
const { DRIVER_UNIT_KINDS: UNIT_KINDS } = require('./vocabulary');

/** 상주 루프가 받는 유휴 주기의 하한. bin/rdl.js의 거절과 같은 값이어야 한다. */
const MINIMUM_INTERVAL = 5;

const LAUNCHD_LABEL = 'dev.rundol.driver';
const SYSTEMD_UNIT = 'rundol-driver.service';
const SCHTASKS_NAME = 'Rundol Driver';

function required(value, message) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) throw new Error(message);
  return text;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

// systemd의 ExecStart는 따옴표 안에서 C 형식 이스케이프를 쓴다. 공백이 든 경로가
// 인자 둘로 갈리는 것이 여기서 가장 흔한 고장이라 전부 따옴표로 싼다.
function quoteSystemd(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

// schtasks의 /TR은 명령줄 전체를 한 인자로 받고, 그 안의 따옴표는 백슬래시로 뺀다.
function quoteSchtasks(value) {
  return `\\"${String(value).replace(/"/gu, '')}\\"`;
}

/**
 * 유닛이 띄울 명령. `rdl run driver`가 실제로 받는 인자만 싣는다.
 *
 * `--once`를 넣지 않는다. 넣으면 한 회전 뒤에 끝나는 프로세스가 되고, 그러면 바깥에
 * 주기 트리거가 다시 필요해진다 — 이 기능이 없애려던 바로 그 바깥이다.
 *
 * `--root`를 넣는 이유는 WorkingDirectory를 믿지 않기 때문이다. 부팅 시점의 작업
 * 디렉터리는 유닛 종류마다 다르고, 틀리면 드라이버는 작업공간을 찾지 못한 채 조용히
 * 아무것도 몰지 않는다.
 */
function driverArguments(settings) {
  const argv = [settings.node, settings.cli, 'run', 'driver', '--root', settings.root, '--client-id', settings.clientId];
  if (settings.project) argv.push('--project', settings.project);
  argv.push('--interval', String(settings.interval));
  return argv;
}

function launchdBody(settings, argv) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(settings.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>'
  ];
  for (const item of argv) lines.push(`    <string>${escapeXml(item)}</string>`);
  lines.push(
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(settings.root)}</string>`,
    // 부팅 때 한 번 띄우고, 죽으면 다시 띄운다. StartInterval도 StartCalendarInterval도
    // 두지 않는다 — 주기 기동은 잠금이 전부 거절한다.
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(settings.log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(settings.errorLog)}</string>`,
    '</dict>',
    '</plist>',
    ''
  );
  return lines.join('\n');
}

function systemdBody(settings, argv) {
  return [
    '[Unit]',
    'Description=Rundol 무인 드라이버 — 사람이 없는 동안 런을 민다',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${settings.root}`,
    `ExecStart=${argv.map(quoteSystemd).join(' ')}`,
    // 정상 종료도 다시 띄운다. 드라이버가 스스로 끝나는 경로는 중단 신호뿐이고,
    // 그 신호는 사람이 유닛을 멈출 때 온다 — 그때는 systemd가 다시 띄우지 않는다.
    'Restart=always',
    'RestartSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

function schtasksBody(settings, argv) {
  const command = argv.map((item) => (/[ \t"]/u.test(item) ? quoteSchtasks(item) : item)).join(' ');
  return [
    ':: Windows 11 — 작업 스케줄러, ONLOGON',
    `schtasks /Create /F /TN "${SCHTASKS_NAME}" /SC ONLOGON /RL LIMITED ^`,
    `  /TR "${command}"`,
    ''
  ].join('\n');
}

/**
 * 유닛 하나를 만든다. 놓을 자리와 사람이 칠 명령을 함께 돌려주되 아무것도 놓지 않는다.
 *
 * `installs: false`는 장식이 아니라 계약이다. 부르는 쪽이 이 값을 보고 "이 호출은
 * 파일을 만들지 않는다"를 알 수 있어야, 이 경로가 언젠가 설치 경로로 변질될 때
 * 그것이 값의 변화로 드러난다.
 */
function driverUnit(options) {
  const input = options || {};
  const kind = required(input.kind, `유닛 종류가 필요합니다. ${UNIT_KINDS.join(', ')} 중 하나여야 합니다.`);
  if (!UNIT_KINDS.includes(kind)) throw new Error(`지원하지 않는 유닛 종류입니다: ${kind}. ${UNIT_KINDS.join(', ')} 중 하나여야 합니다.`);

  const settings = {
    kind,
    clientId: required(input.clientId, '유닛 본문에는 --client-id <id>가 필요합니다. 드라이버가 누구 명의로 도는지가 유닛의 첫 값입니다.'),
    project: input.project ? String(input.project) : null,
    root: required(input.root, '유닛 본문에는 작업공간 경로가 필요합니다.'),
    node: required(input.node, '유닛 본문에는 node 실행 파일 경로가 필요합니다.'),
    cli: required(input.cli, '유닛 본문에는 rdl.js 경로가 필요합니다.'),
    label: input.label ? String(input.label) : LAUNCHD_LABEL
  };
  const interval = Number(input.interval === undefined || input.interval === null ? 60 : input.interval);
  if (!Number.isInteger(interval) || interval < MINIMUM_INTERVAL) {
    throw new Error(`--interval은 ${MINIMUM_INTERVAL}초 이상의 정수여야 합니다.`);
  }
  settings.interval = interval;
  // 로그는 작업공간 안에 둔다. `.rundol/`은 이미 추적 제외 대상이라 유닛이 만든
  // 로그가 커밋될 수 없고, 유닛이 뜨지 않은 이유를 볼 자리가 한 곳으로 모인다.
  settings.log = `${settings.root}/.rundol/driver.log`;
  settings.errorLog = `${settings.root}/.rundol/driver.err.log`;

  const argv = driverArguments(settings);

  if (kind === 'launchd') {
    const filename = `${settings.label}.plist`;
    return {
      kind, label: settings.label, filename,
      path: `~/Library/LaunchAgents/${filename}`,
      argv, installs: false,
      body: launchdBody(settings, argv),
      install: [
        `mkdir -p "${settings.root}/.rundol" ~/Library/LaunchAgents`,
        `rdl run driver --root "${settings.root}" --client-id ${settings.clientId} --unit launchd > ~/Library/LaunchAgents/${filename}`,
        `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${filename}`
      ]
    };
  }

  if (kind === 'systemd') {
    return {
      kind, label: SYSTEMD_UNIT, filename: SYSTEMD_UNIT,
      path: `~/.config/systemd/user/${SYSTEMD_UNIT}`,
      argv, installs: false,
      body: systemdBody(settings, argv),
      install: [
        'mkdir -p ~/.config/systemd/user',
        `rdl run driver --root "${settings.root}" --client-id ${settings.clientId} --unit systemd > ~/.config/systemd/user/${SYSTEMD_UNIT}`,
        'systemctl --user daemon-reload',
        `systemctl --user enable --now ${SYSTEMD_UNIT}`,
        // 로그인 없이 부팅 때 뜨려면 linger가 필요하다. 이 줄이 없으면 유닛은
        // 만들어졌는데 재부팅 뒤에 뜨지 않고, 그 침묵은 "몰 런이 없다"와 같아 보인다.
        'loginctl enable-linger "$USER"'
      ]
    };
  }

  return {
    kind, label: SCHTASKS_NAME, filename: null,
    path: null,
    argv, installs: false,
    body: schtasksBody(settings, argv),
    install: [
      // ONSTART가 아니라 ONLOGON이다. ONSTART는 사용자 프로필 없이 SYSTEM으로 돌고,
      // 그러면 LOCALAPPDATA가 달라 AI 클라이언트의 자격 증명이 없다.
      '위 명령을 관리자 아닌 사용자 셸에서 그대로 실행합니다.',
      '재시작은 작업 속성의 "실패 시 다시 시작"으로 둡니다.'
    ]
  };
}

module.exports = { driverUnit, UNIT_KINDS, MINIMUM_INTERVAL, LAUNCHD_LABEL, SYSTEMD_UNIT, SCHTASKS_NAME };
