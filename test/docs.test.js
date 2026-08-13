'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  path.join(root, 'README.md'),
  ...fs.readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md') && !name.startsWith('COMPETITOR-'))
    .map((name) => path.join(root, 'docs', name))
];

for (const file of files) {
  const markdown = fs.readFileSync(file, 'utf8');
  const links = markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
  for (const match of links) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || target.startsWith('#') || /^[a-z]+:\/\//i.test(target)) continue;
    const relative = decodeURIComponent(target.split('#')[0]);
    if (!relative) continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), relative)), `${path.relative(root, file)}의 링크 대상이 없습니다: ${target}`);
  }
}

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
assert.match(readme, /rdl doctor/);
assert.match(readme, /docs\/RELEASES\.md/);
assert.match(readme, /rundol\/workspace/);
assert.match(readme, /rundol\/<key>/);

const obsidian = fs.readFileSync(path.join(root, 'docs', 'OBSIDIAN-INTEGRATION.md'), 'utf8');
assert.match(obsidian, /projects\/<project-key>\//);
assert.match(obsidian, /\.obsidian/);
assert.doesNotMatch(obsidian, /저장소 루트 전체를 하나의 Obsidian Vault/);

process.stdout.write('documentation tests passed\n');
