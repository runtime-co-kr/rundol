#!/usr/bin/env node
'use strict';

const { doctor } = require('../src/doctor');

const args = process.argv.slice(2);
const gitUrlIndex = args.indexOf('--git-url');
const gitUrl = gitUrlIndex >= 0 ? args[gitUrlIndex + 1] : null;
if (gitUrlIndex >= 0 && !gitUrl) {
  process.stderr.write('install-doctor: --git-url 값이 필요합니다.\n');
  process.exitCode = 2;
} else {
  const result = doctor(process.cwd(), { gitUrl });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.summary.errors > 0 ? 1 : 0;
}
