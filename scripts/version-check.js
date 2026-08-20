'use strict';

const fs = require('fs');
const path = require('path');

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validateVersion(version) {
  return typeof version === 'string' && SEMVER_PATTERN.test(version);
}

function checkVersion(root = path.resolve(__dirname, '..'), tag = process.env.CI_COMMIT_TAG || '') {
  const issues = [];
  const packageFile = path.join(root, 'package.json');
  const changelogFile = path.join(root, 'CHANGELOG.md');
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const version = packageJson.version;
  const workspaceDirectory = path.join(root, 'packages');
  const workspaceManifests = fs.existsSync(workspaceDirectory)
    ? fs.readdirSync(workspaceDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(workspaceDirectory, entry.name, 'package.json')))
      .map((entry) => JSON.parse(fs.readFileSync(path.join(workspaceDirectory, entry.name, 'package.json'), 'utf8')))
    : [];

  if (!validateVersion(version)) {
    issues.push(`package.json version이 SemVer 형식이 아닙니다: ${version}`);
  }

  if (packageJson.scripts && Object.prototype.hasOwnProperty.call(packageJson.scripts, 'postinstall')) {
    issues.push('핵심 package 설치와 선택 기능을 분리하기 위해 postinstall script를 둘 수 없습니다.');
  }

  if (packageJson.name !== '@rundol/monorepo' || packageJson.private !== true) {
    issues.push('루트 package는 @rundol/monorepo 이름과 private: true를 사용해야 합니다.');
  }
  if (packageJson.bin || packageJson.files) {
    issues.push('private monorepo 루트는 bin 또는 배포용 files를 가질 수 없습니다.');
  }

  const packageNames = [packageJson.name].concat(workspaceManifests.map((manifest) => manifest.name));
  const duplicateNames = packageNames.filter((name, index) => packageNames.indexOf(name) !== index);
  if (duplicateNames.length) issues.push(`중복 package name이 있습니다: ${Array.from(new Set(duplicateNames)).join(', ')}`);
  if (packageNames.filter((name) => name === 'rundol').length !== 1) {
    issues.push('배포 package name rundol은 packages/rundol에서 정확히 한 번만 선언해야 합니다.');
  }
  for (const manifest of workspaceManifests) {
    if (manifest.version !== version) issues.push(`${manifest.name} version ${manifest.version}이 release version ${version}과 다릅니다.`);
    if (manifest.scripts && Object.prototype.hasOwnProperty.call(manifest.scripts, 'postinstall')) {
      issues.push(`${manifest.name}에 postinstall script를 둘 수 없습니다.`);
    }
  }

  const lockFile = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (lock.version !== version) issues.push(`package-lock.json version ${lock.version}이 release version ${version}과 다릅니다.`);
    const lockedPackages = lock.packages || {};
    if (lockedPackages[''] && lockedPackages[''].version !== version) {
      issues.push(`package-lock.json 루트 항목 version ${lockedPackages[''].version}이 release version ${version}과 다릅니다.`);
    }
    for (const manifest of workspaceManifests) {
      const entry = Object.entries(lockedPackages).find(([key, value]) => key.startsWith('packages/') && value && value.name === manifest.name);
      if (entry && entry[1].version !== version) issues.push(`package-lock.json의 ${manifest.name} version ${entry[1].version}이 release version ${version}과 다릅니다.`);
    }

    // 워크스페이스 내부 의존이 선언과 잠금에서 갈리면 npm ci가 거부한다. 그
    // 거부는 태그를 단 뒤 릴리즈 워크플로에서 처음 보이므로, 여기서 먼저 본다.
    for (const manifest of [packageJson].concat(workspaceManifests)) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, range] of Object.entries((manifest[field] || {}))) {
          if (!name.startsWith('@rundol/') && name !== 'rundol') continue;
          if (range !== version) issues.push(`${manifest.name}의 ${name} 의존 ${range}이 release version ${version}과 다릅니다.`);
        }
      }
    }

    // 서드파티 항목의 잠금 버전이 그 항목이 가리키는 tarball과 같은지 본다.
    // 판올림이 경로 접두만 보고 워크스페이스를 고르면 packages/cli/node_modules/marked
    // 같은 중첩 의존까지 잡아 릴리즈 버전으로 덮는데, 그 오염은 위의 검사들을
    // 전부 통과하고 태그를 단 뒤 릴리즈 워크플로의 npm ci에서 처음 드러난다.
    //
    // 대조 상대를 설치본이 아니라 resolved URL로 둔 이유는, 오염된 바로 그 항목이
    // 로컬에 설치돼 있지 않은 경우가 있기 때문이다. 없는 것과는 대조할 수 없고,
    // 대조하지 못한 항목을 조용히 건너뛰는 검사는 필요할 때 침묵한다.
    for (const [key, value] of Object.entries(lockedPackages)) {
      if (!key.includes('node_modules/') || !value || !value.version) continue;
      if (typeof value.resolved !== 'string' || !value.resolved.endsWith('.tgz')) continue;
      const file = value.resolved.slice(value.resolved.lastIndexOf('/') + 1, -'.tgz'.length);
      const unscoped = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length).split('/').pop();
      const inTarball = file.startsWith(`${unscoped}-`) ? file.slice(unscoped.length + 1) : null;
      if (inTarball && inTarball !== value.version) {
        issues.push(`package-lock.json의 ${key} version ${value.version}이 tarball ${file}과 다릅니다.`);
      }
    }
  }

  if (!fs.existsSync(changelogFile)) {
    issues.push('CHANGELOG.md가 없습니다.');
  } else {
    const changelog = fs.readFileSync(changelogFile, 'utf8');
    const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^## \\[${escaped}\\](?:\\s|$)`, 'm').test(changelog)) {
      issues.push(`CHANGELOG.md에 [${version}] 항목이 없습니다.`);
    }
  }

  if (tag && tag !== `v${version}`) {
    issues.push(`Git tag ${tag}와 package version ${version}이 일치하지 않습니다.`);
  }

  return { valid: issues.length === 0, version, tag: tag || null, issues };
}

if (require.main === module) {
  const result = checkVersion();
  if (result.valid) {
    process.stdout.write(`version check passed: ${result.version}${result.tag ? ` (${result.tag})` : ''}\n`);
  } else {
    result.issues.forEach((issue) => process.stderr.write(`ERROR: ${issue}\n`));
    process.exitCode = 1;
  }
}

module.exports = { SEMVER_PATTERN, validateVersion, checkVersion };
