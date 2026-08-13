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

process.stdout.write('package boundary tests passed\n');
