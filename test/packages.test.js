'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const rootManifest = require('../package.json');
const version = rootManifest.version;
const names = ['core', 'protocol', 'cli', 'node', 'board', 'rundol'];
const manifests = new Map(names.map((name) => [name, JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8'))]));

for (const manifest of manifests.values()) assert.strictEqual(manifest.version, version);
assert.strictEqual(rootManifest.name, '@rundol/monorepo');
assert.strictEqual(rootManifest.private, true);
assert.strictEqual(rootManifest.bin, undefined);
assert.strictEqual(rootManifest.files, undefined);
assert.deepStrictEqual(rootManifest.workspaces, ['packages/*']);
const packageNames = [rootManifest.name].concat(Array.from(manifests.values(), (manifest) => manifest.name));
assert.strictEqual(new Set(packageNames).size, packageNames.length, `duplicate package name: ${packageNames.join(', ')}`);
assert.strictEqual(packageNames.filter((name) => name === 'rundol').length, 1);
const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
assert(npmrc.includes('workspaces=false'));
assert(npmrc.includes('install-links=true'));
assert.strictEqual(manifests.get('rundol').dependencies['@rundol/cli'], version);
assert.strictEqual(manifests.get('rundol').dependencies['@rundol/node'], version);
assert(!manifests.get('core').dependencies);

const nodeVersion = spawnSync(process.execPath, [path.join(root, 'bin', 'rundol-node.js'), '--version'], { encoding: 'utf8' });
assert.strictEqual(nodeVersion.status, 0, nodeVersion.stderr);
assert.strictEqual(nodeVersion.stdout.trim(), version);

const build = spawnSync(process.execPath, [path.join(root, 'packages', 'cli', 'scripts', 'build.js')], { encoding: 'utf8' });
assert.strictEqual(build.status, 0, build.stderr);
const cliVersion = spawnSync(process.execPath, [path.join(root, 'packages', 'cli', 'dist', 'bin', 'rdl.js'), '--version'], { encoding: 'utf8' });
assert.strictEqual(cliVersion.status, 0, cliVersion.stderr);
assert.strictEqual(cliVersion.stdout.trim(), version);

// 지원 Node 버전은 세 곳이 같은 말을 해야 한다. 선언과 의존성과 실제 검증이 어긋나면
// 설치는 되는데 동작하지 않는 조합이 생긴다. 실제로 engines가 >=14인 채로 Node 20을
// 요구하는 marked에 직접 의존하고 있었고, 설치 문서도 14라고 안내하고 있었다.
{
  const floor = (range) => Number.parseInt(String(range).replace(/[^\d]/gu, ''), 10);
  const manifests = ['package.json'].concat(
    fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, 'packages', entry.name, 'package.json')))
      .map((entry) => path.join('packages', entry.name, 'package.json'))
  ).map((relative) => ({ relative, json: JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) }));

  const declared = manifests.filter((item) => item.json.engines && item.json.engines.node);
  assert.ok(declared.length, 'engines.node를 선언해야 합니다.');
  const floors = new Set(declared.map((item) => floor(item.json.engines.node)));
  assert.strictEqual(floors.size, 1, `패키지마다 engines.node가 다릅니다: ${declared.map((i) => `${i.json.name}=${i.json.engines.node}`).join(', ')}`);
  const supported = floors.values().next().value;

  for (const item of manifests) {
    for (const name of Object.keys(item.json.dependencies || {})) {
      const manifest = path.join(root, 'node_modules', name, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const required = JSON.parse(fs.readFileSync(manifest, 'utf8')).engines;
      if (!required || !required.node) continue;
      assert.ok(floor(required.node) <= supported, `${item.json.name}의 의존성 ${name}은 Node ${required.node}를 요구하는데 선언은 >=${supported}입니다.`);
    }
  }

  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const tested = [...ci.matchAll(/node:\s*'(\d+)'/gu)].map((match) => Number(match[1]));
  assert.ok(tested.length, 'CI가 검증하는 Node 버전을 읽지 못했습니다.');
  assert.strictEqual(Math.min(...tested), supported, `CI는 Node ${Math.min(...tested)}부터 검증하는데 선언은 >=${supported}입니다.`);

  for (const file of ['docs/INSTALLATION.md', 'docs/CLI.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const stated = [...text.matchAll(/Node\.js (\d+) 이상/gu)].map((match) => Number(match[1]));
    for (const value of stated) assert.strictEqual(value, supported, `${file}이 Node ${value} 이상이라고 안내하는데 선언은 >=${supported}입니다.`);
  }
}

process.stdout.write('package boundary tests passed\n');
