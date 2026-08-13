'use strict';

const assert = require('assert');
const path = require('path');
const { validateVersion, checkVersion } = require('../scripts/version-check');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;

assert.strictEqual(validateVersion('0.17.0'), true);
assert.strictEqual(validateVersion('0.1000.0'), true);
assert.strictEqual(validateVersion('1.2.3-rc.1'), true);
assert.strictEqual(validateVersion('01.2.3'), false);
assert.strictEqual(validateVersion('1.2'), false);

assert.strictEqual(checkVersion(root).valid, true);
assert.strictEqual(checkVersion(root, `v${version}`).valid, true);
assert.strictEqual(checkVersion(root, 'v999.0.0').valid, false);

process.stdout.write('release tests passed\n');
