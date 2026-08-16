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

// doctor가 통과라고 하는데 실행이 깨지면 진단이 거짓말이 된다. engines와 같은 값을 봐야 한다.
{
  const source = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'doctor.js'), 'utf8');
  const declared = Number.parseInt(String(require('../package.json').engines.node).replace(/[^\d]/gu, ''), 10);
  const floor = Number.parseInt((/^const NODE_FLOOR = (\d+);$/mu.exec(source) || [])[1], 10);
  assert.strictEqual(floor, declared, `doctor의 Node 하한(${floor})이 engines(${declared})와 어긋납니다`);
  assert.ok(!/nodeMajor >= \d+/u.test(source), 'Node 하한을 판정식에 직접 박으면 안 됩니다');
}

process.stdout.write('doctor tests passed\n');
