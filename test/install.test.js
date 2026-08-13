'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-install-'));
const packageDirectory = path.join(temporary, 'package');
const stagingDirectory = path.join(temporary, 'staging');
const prefix = path.join(temporary, 'integrated');
const separatePrefix = path.join(temporary, 'separate-global');
const codexHome = path.join(temporary, 'codex-home');
const claudeHome = path.join(temporary, 'claude-home');
const copilotHome = path.join(temporary, 'copilot-home');
const npmCache = process.env.RUNDOL_TEST_NPM_CACHE || path.join(temporary, 'npm-cache');

function npm(args) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const commandArgs = npmCli ? [npmCli].concat(args) : args;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      RUNDOL_COPILOT_HOME: copilotHome,
      npm_config_cache: npmCache
    }),
    windowsHide: true,
    shell: process.platform === 'win32' && !npmCli
  });
  assert.strictEqual(result.status, 0, JSON.stringify({ args, status: result.status, error: result.error && result.error.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
  return result.stdout.trim();
}

function cli(name, args, options = {}) {
  const activePrefix = options.separate ? separatePrefix : path.join(prefix, 'node_modules', '.bin');
  const executable = process.platform === 'win32'
    ? path.join(activePrefix, `${name}.cmd`)
    : path.join(activePrefix, name);
  const executableDirectory = activePrefix;
  const result = spawnSync(executable, args, {
    cwd: path.join(root, 'test', 'fixtures', 'workspace', 'projects', 'tms', 'docs'),
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      RUNDOL_COPILOT_HOME: copilotHome,
      PATH: `${executableDirectory}${path.delimiter}${process.env.PATH || ''}`
    }),
    windowsHide: true,
    shell: process.platform === 'win32'
  });
  assert.strictEqual(result.status, 0, result.error || result.stderr || result.stdout);
  return result.stdout.trim();
}

try {
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.mkdirSync(stagingDirectory, { recursive: true });
  const archivesByPackage = new Map();
  for (const packageName of ['core', 'protocol', 'cli', 'node', 'rundol']) {
    const source = path.join(root, 'packages', packageName);
    const staged = path.join(stagingDirectory, packageName);
    if (packageName === 'cli') {
      const build = spawnSync(process.execPath, [path.join(source, 'scripts', 'build.js')], { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.strictEqual(build.status, 0, build.stderr || build.stdout);
    }
    fs.cpSync(source, staged, { recursive: true });
    const manifestFile = path.join(staged, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const [dependency, dependencyVersion] of Object.entries(manifest.dependencies || {})) {
      if (!dependency.startsWith('@rundol/')) continue;
      assert(archivesByPackage.has(dependency), `${manifest.name}의 선행 package ${dependency}가 pack되지 않았습니다.`);
      manifest.dependencies[dependency] = `file:${archivesByPackage.get(dependency)}`;
      assert.notStrictEqual(manifest.dependencies[dependency], dependencyVersion);
    }
    delete manifest.scripts;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const archiveName = npm(['pack', staged, '--pack-destination', packageDirectory, '--silent']).split(/\r?\n/).pop();
    archivesByPackage.set(manifest.name, path.join(packageDirectory, archiveName));
  }

  const archives = fs.readdirSync(packageDirectory).filter((file) => file.endsWith('.tgz'));
  assert.strictEqual(archives.length, 5, '배포 package tarball은 5개여야 합니다.');
  npm(['install', '--prefix', prefix, archivesByPackage.get('rundol')]);

  const version = require('../package.json').version;
  assert.strictEqual(cli('rdl', ['--version']), version);
  assert.strictEqual(cli('rundol', ['--version']), version);
  assert.strictEqual(cli('rundol-node', ['--version']), version);

  const installedDistribution = path.join(prefix, 'node_modules', 'rundol');
  assert(fs.statSync(installedDistribution).isDirectory());
  assert(!fs.lstatSync(installedDistribution).isSymbolicLink(), 'rundol package는 임시 clone link가 아니어야 합니다.');

  const doctor = JSON.parse(cli('rdl', ['doctor', '--json']));
  assert.strictEqual(doctor.summary.errors, 0, JSON.stringify(doctor.checks, null, 2));
  assert.strictEqual(doctor.checks.find((item) => item.id === 'postinstall').status, 'ok');

  // 일반 명령 모듈이 손상돼도 doctor는 먼저 실행되어 패키지 손상을 진단해야 한다.
  const installedCheck = path.join(doctor.packageRoot, 'src', 'check.js');
  const checkBackup = fs.readFileSync(installedCheck);
  fs.unlinkSync(installedCheck);
  const executableDirectory = path.join(prefix, 'node_modules', '.bin');
  const brokenExecutable = process.platform === 'win32' ? path.join(executableDirectory, 'rdl.cmd') : path.join(executableDirectory, 'rdl');
  const broken = spawnSync(brokenExecutable, ['doctor', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      PATH: `${executableDirectory}${path.delimiter}${process.env.PATH || ''}`
    }),
    windowsHide: true,
    shell: process.platform === 'win32'
  });
  assert.strictEqual(broken.status, 1, broken.stderr || broken.stdout);
  assert.strictEqual(JSON.parse(broken.stdout).checks.find((item) => item.id === 'package').status, 'error');
  fs.writeFileSync(installedCheck, checkBackup);

  // 스킬은 postinstall이 아니라 명시적 명령으로 설치한다.
  assert(!fs.existsSync(path.join(codexHome, 'skills', 'rundol-project-governance')));
  cli('rdl', ['skill', 'install']);
  assert(fs.existsSync(path.join(codexHome, 'skills', 'rundol-project-governance', 'SKILL.md')));
  assert(fs.existsSync(path.join(claudeHome, 'skills', 'rundol-project-governance', 'SKILL.md')));
  assert(fs.existsSync(path.join(copilotHome, 'skills', 'rundol-project-governance', 'SKILL.md')));

  const checked = JSON.parse(cli('rdl', ['check', '--json']));
  assert.strictEqual(checked.summary.errors, 0);
  assert.strictEqual(checked.root, path.join(root, 'test', 'fixtures', 'workspace'));

  const separateArchives = [archivesByPackage.get('@rundol/cli'), archivesByPackage.get('@rundol/node')];
  npm(['install', '--global', '--prefix', separatePrefix].concat(separateArchives));
  assert.strictEqual(cli('rdl', ['--version'], { separate: true }), version);
  assert.strictEqual(cli('rundol-node', ['--version'], { separate: true }), version);
  process.stdout.write('global package install tests passed\n');
} finally {
  if (process.env.RUNDOL_KEEP_INSTALL_TEST !== '1') fs.rmSync(temporary, { recursive: true, force: true });
  else process.stderr.write(`install test retained: ${temporary}\n`);
}
