'use strict';

const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const repository = path.resolve(packageRoot, '..', '..');
const target = path.join(packageRoot, 'dist');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const directory of ['bin', 'src', 'docs', 'skills', 'scripts']) {
  fs.cpSync(path.join(repository, directory), path.join(target, directory), {
    recursive: true,
    filter: (source) => !path.relative(repository, source).replace(/\\/g, '/').startsWith('docs/issues')
  });
}
const rootPackage = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({ name: '@rundol/cli-runtime', version: rootPackage.version, type: 'commonjs' }, null, 2)}\n`, 'utf8');
