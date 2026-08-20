'use strict';

const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const repository = path.resolve(packageRoot, '..', '..');
const target = path.join(packageRoot, 'dist');

// 문서 편집기 번들을 먼저 만든다. src를 복사한 뒤에 만들면 배포물에는 빠진 채로
// 남고, 그 사실은 설치한 사람이 문서를 편집하려 할 때에야 드러난다.
require(path.join(repository, 'scripts', 'build-editor.js')).build({ quiet: true });

// 번들은 제3자 코드의 사본이다. MIT는 그 사본에 저작권 고지와 허가문을 함께
// 실으라고 요구하고, ProseMirror 소스에는 파일별 헤더 주석이 없어 번들러가
// 옮길 것이 없다. 그래서 여기서 모아 배포물에 함께 넣는다.
require(path.join(repository, 'scripts', 'build-licenses.js')).build({ quiet: true });
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const directory of ['bin', 'src', 'docs', 'skills', 'scripts']) {
  fs.cpSync(path.join(repository, directory), path.join(target, directory), {
    recursive: true,
    filter: (source) => !path.relative(repository, source).replace(/\\/g, '/').startsWith('docs/issues')
  });
}
const notice = path.join(repository, 'THIRD-PARTY-LICENSES.txt');
if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(target, 'THIRD-PARTY-LICENSES.txt'));

const rootPackage = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({ name: '@rundol/cli-runtime', version: rootPackage.version, type: 'commonjs' }, null, 2)}\n`, 'utf8');
