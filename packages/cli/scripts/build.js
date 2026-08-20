'use strict';

const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const repository = path.resolve(packageRoot, '..', '..');
const target = path.join(packageRoot, 'dist');

// 문서 편집기 번들을 먼저 만든다. src를 복사한 뒤에 만들면 배포물에는 빠진 채로
// 남고, 그 사실은 설치한 사람이 문서를 편집하려 할 때에야 드러난다.
require(path.join(repository, 'scripts', 'build-editor.js')).build({ quiet: true });
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
