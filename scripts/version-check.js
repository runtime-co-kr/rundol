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
