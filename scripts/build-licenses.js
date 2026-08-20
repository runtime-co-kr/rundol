'use strict';

// 번들에 들어간 제3자 코드의 라이선스 고지를 모은다.
//
// 편집기 번들은 ProseMirror와 remark 계열 수십 개를 하나의 파일로 만든다. MIT는
// 그 사본에 저작권 고지와 허가문을 함께 실으라고 요구하는데, ProseMirror 소스에는
// 파일별 라이선스 헤더 주석이 없어 번들러가 옮길 것이 없다. esbuild의
// legal-comments로는 자동으로 되지 않는다 — 실제로 걸어 보고 크기가 그대로였다.
//
// 그래서 의존 트리를 훑어 각 패키지의 LICENSE 원문을 직접 모은다. 헤더 주석이
// 없다는 사실이 고지 의무를 없애 주지는 않는다.

const fs = require('fs');
const path = require('path');

const repository = path.resolve(__dirname, '..');
const modules = path.join(repository, 'node_modules');

// 번들에 실제로 들어가는 것만 모은다. 전체 devDependencies를 담으면 시험 도구와
// 타입 검사기까지 고지에 들어가고, 그러면 이 파일은 무엇이 배포되는지 알려주는
// 문서가 아니라 설치 목록의 사본이 된다.
const BUNDLED_PREFIXES = [
  'prosemirror-', 'orderedmap', 'w3c-keyname', 'rope-sequence',
  'remark-', 'unified', 'mdast-', 'micromark', 'unist-', 'vfile',
  'bail', 'devlop', 'extend', 'is-plain-obj', 'trough', 'zwitch',
  'ccount', 'character-entities', 'decode-named-character-reference',
  'longest-streak', 'markdown-table', 'escape-string-regexp',
  'stringify-entities', 'trim-lines', 'parse-entities'
];

function bundled(name) {
  return BUNDLED_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix));
}

function licenseText(directory) {
  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE']) {
    const file = path.join(directory, candidate);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  }
  return null;
}

function collect() {
  if (!fs.existsSync(modules)) return [];
  const found = [];
  for (const entry of fs.readdirSync(modules)) {
    if (entry.startsWith('.') || entry.startsWith('@')) continue;
    if (!bundled(entry)) continue;
    const directory = path.join(modules, entry);
    const manifest = path.join(directory, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch (_) { continue; }
    found.push({
      name: data.name || entry,
      version: data.version || '',
      license: typeof data.license === 'string' ? data.license : (data.license && data.license.type) || '(명시 없음)',
      text: licenseText(directory)
    });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

function render(packages) {
  const lines = [
    'Rundol 문서 편집기 번들에 포함된 제3자 소프트웨어',
    '',
    'Rundol 자체는 Apache License 2.0으로 배포합니다. 아래 목록은 보드 문서',
    '편집기 번들(src/board-ui/generated/)에 함께 들어가는 제3자 코드와 그',
    '라이선스 원문입니다.',
    '',
    `패키지 ${packages.length}개`,
    ''
  ];
  for (const item of packages) lines.push(`  ${item.name}@${item.version}  ${item.license}`);
  lines.push('', '='.repeat(72), '');
  for (const item of packages) {
    lines.push(`${item.name}@${item.version} — ${item.license}`, '');
    lines.push(item.text || '(패키지에 라이선스 원문 파일이 없습니다. package.json의 license 필드를 따릅니다.)');
    lines.push('', '-'.repeat(72), '');
  }
  return `${lines.join('\n')}\n`;
}

function build({ quiet } = {}) {
  const packages = collect();
  if (!packages.length) {
    process.stderr.write('licenses: 번들 의존성을 찾지 못했습니다. npm install 후 다시 시도하세요.\n');
    return false;
  }
  const target = path.join(repository, 'THIRD-PARTY-LICENSES.txt');
  fs.writeFileSync(target, render(packages), 'utf8');
  const missing = packages.filter((item) => !item.text);
  if (!quiet) {
    process.stdout.write(`licenses: ${packages.length}개 패키지, ${Math.round(fs.statSync(target).size / 1024)}KB\n`);
    if (missing.length) process.stdout.write(`licenses: 원문 파일이 없는 패키지 ${missing.length}개 — ${missing.map((item) => item.name).join(', ')}\n`);
  }
  return true;
}

if (require.main === module) process.exitCode = build() ? 0 : 1;

module.exports = { build };
