'use strict';

const os = require('os');
const path = require('path');
// release:check의 test:install 단계에서 러너 없이 단독 실행된다. 런타임 저널이
// 실제 홈을 오염시키지 않게 src 로드 전에 격리한다. 밖에서 물려받은 홈은 이
// 테스트 소유가 아니므로 정리 대상에서 제외한다.
const ownRuntimeHome = !process.env.RUNDOL_HOME;
if (ownRuntimeHome) process.env.RUNDOL_HOME = path.join(os.tmpdir(), `rundol-tarball-runtime-${process.pid}`);

const assert = require('assert');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ledger = require('../src/run-ledger');
const eventStore = require('../src/event-store');
const { appendDriverEvent } = require('../src/driver-lease');
const { verdictEnvelope } = require('../src/verify');

// 0.28.1 — 마지막으로 배포된 버전. p15-compat의 worktree 빠른 경로와 달리 여기서는
// 실제 npm pack tarball을 설치해 배포 산출물 그대로를 신형 데이터와 교차 검증한다.
const BASELINE = '8d1c6df6d44f782e169fd4a7a3c726faa345ffe6';

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-tarball-compat-'));
const workspace = path.join(temporary, 'workspace');
const bare = path.join(temporary, 'origin.git');
const stagingDirectory = path.join(temporary, 'staging');
const packageDirectory = path.join(temporary, 'archives');
const prefix = path.join(temporary, 'old-cli');
const oldHome = path.join(temporary, 'old-rundol-home');
const homes = { codex: path.join(temporary, 'codex-home'), claude: path.join(temporary, 'claude-home'), copilot: path.join(temporary, 'copilot-home') };
const npmCache = process.env.RUNDOL_TEST_NPM_CACHE || path.join(temporary, 'npm-cache');
let oldTree = null;

function invoke(program, args, cwd) {
  return spawnSync(program, args, { cwd, encoding: 'utf8', windowsHide: true });
}

function command(program, args, cwd) {
  const result = invoke(program, args, cwd);
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function npm(args) {
  const npmCli = process.env.npm_execpath;
  const executable = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const commandArgs = npmCli ? [npmCli].concat(args) : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { npm_config_cache: npmCache }),
    windowsHide: true,
    shell: process.platform === 'win32' && !npmCli
  });
  assert.strictEqual(result.status, 0, JSON.stringify({ args, status: result.status, error: result.error && result.error.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
  return result.stdout.trim();
}

// 설치된 구버전 CLI는 별도 머신의 클라이언트다 — 홈과 런타임을 신버전과 공유하지 않는다.
function oldCli(args) {
  const binDirectory = path.join(prefix, 'node_modules', '.bin');
  const executable = process.platform === 'win32' ? path.join(binDirectory, 'rdl.cmd') : path.join(binDirectory, 'rdl');
  return spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      RUNDOL_HOME: oldHome,
      CODEX_HOME: homes.codex,
      CLAUDE_CONFIG_DIR: homes.claude,
      RUNDOL_COPILOT_HOME: homes.copilot,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH || ''}`
    }),
    windowsHide: true,
    shell: process.platform === 'win32'
  });
}

try {
  // 신버전(현재 소스) 클라이언트가 공유 workspace를 만들고 신형 이벤트를 남긴다.
  fs.mkdirSync(workspace, { recursive: true });
  command('git', ['init', '-b', 'main'], workspace);
  command('git', ['config', 'user.name', 'Rundol Test'], workspace);
  command('git', ['config', 'user.email', 'rundol@example.test'], workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# tarball compatibility\n', 'utf8');
  command('git', ['add', 'README.md'], workspace);
  command('git', ['commit', '-m', 'initial'], workspace);
  command('git', ['init', '--bare', '--initial-branch=main', bare], temporary);
  command('git', ['remote', 'add', 'origin', bare], workspace);
  command('git', ['push', '-u', 'origin', 'main'], workspace);
  command(process.execPath, [cli, 'init', 'crm', '--name', '타볼 호환성', '--profile', 'lean', '--root', workspace, '--json'], root);
  command(process.execPath, [cli, 'contract', 'set', '--project', 'crm', '--profile', 'lean', '--enforcement', 'advisory', '--root', workspace, '--json'], root);
  command(process.execPath, [cli, 'client', 'register', 'agent-a', '--name', '작성 에이전트', '--type', 'agent', '--owner', 'MEMBER-001', '--root', workspace, '--json'], root);
  command(process.execPath, [cli, 'client', 'register', 'desk-b', '--name', '인수 데스크톱', '--type', 'device', '--owner', 'MEMBER-001', '--root', workspace, '--json'], root);

  // 첫 런: canonical v2 전체 수명주기 + driver lease 사슬. 전부 프로덕션 기록 경로다.
  const settings = { schemaVersion: 1, contentHash: 'a'.repeat(64), safeResolved: {} };
  const procedure = {
    name: 'compat-flow', revision: 1, schemaVersion: 1,
    steps: [{ id: 'author', executor: 'adapter' }, { id: 'save', executor: 'cli' }]
  };
  const first = ledger.createRun(workspace, { project: 'crm', goal: '타볼 호환 런', clientId: 'agent-a', procedure, settings });
  assert.strictEqual(first.event.schemaVersion, 3, '픽스처 런은 이 판의 canonical 스키마여야 합니다.');
  const eventsRoot = path.join(workspace, 'projects', 'workspace', 'events');
  const lockDirectory = path.join(temporary, 'locks');
  const driverBase = { schemaVersion: 1, rootRequestId: ledger.newRequestId(), requestId: ledger.newRequestId(), clientId: 'agent-a', projectId: 'crm', runId: first.runId, leaseId: 'LEASE-00000000000000000D01', ownerToken: first.event.ownerToken };
  appendDriverEvent(eventsRoot, { ...driverBase, eventId: 'EVT-00000000000000000D01', type: 'driver.acquired', expiresAt: '2030-01-01T00:00:00.000Z' }, { lockDirectory });
  ledger.recordRunEvent(workspace, { project: 'crm', runId: first.runId, event: { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'agent-a' } });
  ledger.recordRunEvent(workspace, { project: 'crm', runId: first.runId, event: { type: 'run.step', stepId: 'save', executor: 'cli', exitCode: 0, clientId: 'agent-a' } });
  appendDriverEvent(eventsRoot, { ...driverBase, requestId: ledger.newRequestId(), eventId: 'EVT-00000000000000000D02', type: 'driver.released', previousDriverEventId: 'EVT-00000000000000000D01', reason: 'completed' }, { lockDirectory });
  const head = command('git', ['rev-parse', 'HEAD'], workspace).toLowerCase();
  ledger.recordRunEvent(workspace, { project: 'crm', runId: first.runId, event: { type: 'run.completed_local', commit: head, clientId: 'agent-a' } });

  // 둘째 런: 정지 후 인수 — epoch 전환 이벤트(run.takeover)가 공유 샤드에 남는다.
  const second = ledger.createRun(workspace, { project: 'crm', goal: '인수 사슬', clientId: 'agent-a', procedure, settings });
  ledger.recordRunEvent(workspace, { project: 'crm', runId: second.runId, event: { type: 'run.halted', reason: 'manual', atStep: 'author', resumable: true, clientId: 'agent-a' } });
  const taken = ledger.takeoverRun(workspace, { project: 'crm', runId: second.runId, clientId: 'desk-b' });
  assert.strictEqual(taken.basis, 'halted');
  ledger.recordRunEvent(workspace, { project: 'crm', runId: second.runId, event: { type: 'run.resumed', fromStep: 'author', clientId: 'desk-b' } });

  const verdict = verdictEnvelope({
    schemaVersion: 1, eventId: 'EVT-00000000000000000E01', type: 'verdict.recorded',
    rootRequestId: ledger.newRequestId(), requestId: ledger.newRequestId(),
    clientId: 'agent-a', projectId: 'crm', targetId: 'REQ-001', reviewedRevision: head,
    lens: 'satisfaction-v1', verdict: 'pass', findings: [],
    adapter: { name: 'fixture', instructionId: 'verify-satisfaction-v1', instructionRevision: 1, instructionDigest: 'b'.repeat(64) },
    validatorInstanceId: 'VAL-00000000000000000E01'
  }).shared;
  eventStore.appendEvent(eventsRoot, 'verdict', 'crm', 'agent-a', verdict, { lockDirectory });

  // 신버전 check가 스스로 만든 데이터에 진단 0인지 먼저 고정한다.
  const current = invoke(process.execPath, [cli, 'check', '--root', workspace, '--json'], root);
  assert.strictEqual(current.status, 0, current.stdout + current.stderr);
  for (const family of ['RDL-RUN-', 'RDL-DRIVER-', 'RDL-VERDICT-']) assert(!current.stdout.includes(family), current.stdout);

  // 공유 샤드가 실제로 workspace 상태 worktree에 있는지 고정한다. projects/*는
  // 루트 저장소에서 제외된 독립 worktree라, 구버전 클라이언트가 pull로 받는
  // 것이 정확히 이 디렉터리들의 내용이다 — p15-compat과 같은 같은-트리 모델로
  // 구버전을 실행하되, 여기서는 배포 산출물(tarball) 그대로를 쓴다.
  const sharedRunRoot = path.join(eventsRoot, 'run');
  assert(fs.existsSync(sharedRunRoot) && fs.readdirSync(sharedRunRoot).length >= 3, '공유 run 샤드가 없습니다 — 픽스처 기록이 실패했습니다.');
  assert(fs.existsSync(path.join(eventsRoot, 'driver')), '공유 driver 샤드가 없습니다.');

  // 배포 산출물 재현: 기준 커밋을 worktree로 꺼내 core → protocol → cli 순서로
  // npm pack하고, cli tarball을 실제로 설치한다. cli의 @rundol/* 의존성은 미배포
  // 버전이므로 install.test.js와 같은 file: 치환을 쓴다.
  oldTree = path.join(temporary, 'baseline');
  command('git', ['worktree', 'add', '--detach', oldTree, BASELINE], root);
  const oldVersion = JSON.parse(fs.readFileSync(path.join(oldTree, 'package.json'), 'utf8')).version;
  const build = invoke(process.execPath, [path.join(oldTree, 'packages', 'cli', 'scripts', 'build.js')], oldTree);
  assert.strictEqual(build.status, 0, build.stderr || build.stdout);
  fs.mkdirSync(stagingDirectory, { recursive: true });
  fs.mkdirSync(packageDirectory, { recursive: true });
  const archivesByPackage = new Map();
  for (const packageName of ['core', 'protocol', 'cli']) {
    const staged = path.join(stagingDirectory, packageName);
    fs.cpSync(path.join(oldTree, 'packages', packageName), staged, { recursive: true });
    const manifestFile = path.join(staged, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies || {})) {
      if (!dependency.startsWith('@rundol/')) continue;
      assert(archivesByPackage.has(dependency), `${manifest.name}의 선행 package ${dependency}가 pack되지 않았습니다.`);
      manifest.dependencies[dependency] = `file:${archivesByPackage.get(dependency)}`;
    }
    delete manifest.scripts;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const archiveName = npm(['pack', staged, '--pack-destination', packageDirectory, '--silent']).split(/\r?\n/).pop();
    archivesByPackage.set(manifest.name, path.join(packageDirectory, archiveName));
  }
  npm(['install', '--prefix', prefix, archivesByPackage.get('@rundol/cli')]);

  const version = oldCli(['--version']);
  assert.strictEqual(version.status, 0, version.stderr || version.stdout);
  assert.strictEqual(version.stdout.trim(), oldVersion, `설치된 tarball은 ${oldVersion}이어야 합니다: ${version.stdout}`);

  // 배포 산출물 그대로의 구버전 check/sync가 신형 데이터를 오진 없이 지나가야 한다.
  const oldCheck = oldCli(['check', '--root', workspace, '--json']);
  assert.strictEqual(oldCheck.status, 0, `${oldVersion} tarball check 실패:\n${oldCheck.stdout}\n${oldCheck.stderr}`);
  const oldReport = JSON.parse(oldCheck.stdout);
  assert.strictEqual(oldReport.summary.errors, 0, oldCheck.stdout);
  assert(!oldCheck.stdout.includes('RDL-LEASE-001'), oldCheck.stdout);
  assert(!oldCheck.stdout.includes('RDL-RUN-'), oldCheck.stdout);
  const oldSync = oldCli(['sync', '--root', workspace, '--project', 'crm', '--no-push', '--json']);
  assert.strictEqual(oldSync.status, 0, `${oldVersion} tarball sync 실패:\n${oldSync.stdout}\n${oldSync.stderr}`);

  process.stdout.write('tarball cross-version compatibility tests passed\n');
} finally {
  if (oldTree) {
    try { command('git', ['worktree', 'remove', '--force', oldTree], root); }
    catch (_) { try { spawnSync('git', ['worktree', 'prune'], { cwd: root, windowsHide: true }); } catch (_) {} }
  }
  for (const target of ownRuntimeHome ? [temporary, process.env.RUNDOL_HOME] : [temporary]) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { process.stderr.write(`tarball compat cleanup warning: ${target}: ${error.message}\n`); }
  }
}
