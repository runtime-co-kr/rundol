#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const target = require.resolve('@rundol/cli/dist/bin/rdl.js');
const result = spawnSync(process.execPath, [target].concat(process.argv.slice(2)), { stdio: 'inherit' });
process.exitCode = result.status === null ? 1 : result.status;
