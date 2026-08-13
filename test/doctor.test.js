'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { doctor, classifyGitFailure } = require('../src/doctor');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'test', 'fixtures', 'workspace');

assert.strictEqual(classifyGitFailure('HTTP Basic: Access denied'), 'authentication');
assert.strictEqual(classifyGitFailure('curl 56 HTTP/2 stream 5 was reset'), 'http-reset');
assert.strictEqual(classifyGitFailure('Could not resolve host: example.invalid'), 'dns');
assert.strictEqual(classifyGitFailure('SSL certificate problem'), 'tls');
assert.strictEqual(classifyGitFailure('Repository not found'), 'not-found');

const result = doctor(fixture);
assert.strictEqual(result.summary.errors, 0, JSON.stringify(result.checks, null, 2));
assert.strictEqual(result.checks.find((item) => item.id === 'postinstall').status, 'ok');
assert.strictEqual(result.checks.find((item) => item.id === 'package').status, 'ok');
assert.strictEqual(result.checks.find((item) => item.id === 'workspace').status, 'ok');

const cli = spawnSync(process.execPath, [path.join(root, 'bin', 'rdl.js'), 'doctor', '--root', fixture, '--json'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
assert.strictEqual(JSON.parse(cli.stdout).summary.errors, 0);

process.stdout.write('doctor tests passed\n');
