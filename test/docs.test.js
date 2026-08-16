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
assert.match(readme, /docs\/MIGRATION-0\.22\.md/);
assert.match(readme, /docs\/MIGRATION-0\.23\.md/);
assert.match(readme, /docs\/MIGRATION-0\.24\.md/);

// 호환성 파괴는 CHANGELOG와 migration 문서에 함께 적혀야 한다. 0.22.9가 그러지 않아
// 되돌렸던 일이 있다. 여기서 묶어 두면 같은 실수가 조용히 반복되지 않는다.
{
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const latest = changelog.slice(0, changelog.indexOf('## [0.23.0]'));
  assert.ok(latest.includes('호환성 파괴'), '0.24.0의 호환성 파괴를 명시해야 합니다');
  assert.ok(latest.includes('MIGRATION-0.24.md'), 'CHANGELOG가 migration 문서를 가리켜야 합니다');
  const guide = fs.readFileSync(path.join(root, 'docs', 'MIGRATION-0.24.md'), 'utf8');
  for (const token of ['rules', 'omissions', 'notApplicable', '0.23.0']) {
    assert.ok(guide.includes(token), `migration 문서에 ${token} 설명이 필요합니다`);
  }
}
assert.match(readme, /rundol\/workspace/);
assert.match(readme, /rundol\/<key>/);

const migration = fs.readFileSync(path.join(root, 'docs', 'MIGRATION-0.22.md'), 'utf8');
for (const version of ['0.21.1', '0.21.2', '0.21.3', '0.22.0', '0.22.1']) assert(migration.includes(version), `migration guide must cover ${version}`);
assert(migration.includes('DESIGN.md') && migration.includes('board.json'));
for (const command of ['rdl doc migrate', 'rdl contract plan', 'rdl contract set', 'rdl contract check', 'rdl check --strict', 'rdl sync']) assert(migration.includes(command), `migration guide must include ${command}`);
assert(migration.includes('advisory') && migration.includes('checkpoint'));
assert(migration.includes('롤백'));

const obsidian = fs.readFileSync(path.join(root, 'docs', 'OBSIDIAN-INTEGRATION.md'), 'utf8');
assert.match(obsidian, /projects\/<project-key>\//);
assert.match(obsidian, /\.obsidian/);
assert.doesNotMatch(obsidian, /저장소 루트 전체를 하나의 Obsidian Vault/);

// engines를 올리는 것은 설치 계약을 깨는 일이다. 0.22.9는 이 변경을 PATCH로, CHANGELOG
// 기록도 없이 내보냈다. 정책은 MINOR 승급과 migration 명시를 요구한다. 같은 일이 조용히
// 다시 일어나지 않도록, 지금 선언한 Node 하한이 문서·CI·CHANGELOG와 같은 말을 하는지 묶는다.
{
  const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines.node;
  const floor = /(\d+)/.exec(declared)[1];

  const install = fs.readFileSync(path.join(root, 'docs', 'INSTALLATION.md'), 'utf8');
  assert.ok(install.includes(`Node.js ${floor} 이상`), `설치 문서가 engines(${declared})와 다른 Node를 안내합니다`);

  const nodeMigration = fs.readFileSync(path.join(root, 'docs', 'MIGRATION-0.23.md'), 'utf8');
  assert.ok(nodeMigration.includes(`>=${floor}`), 'migration 문서가 실제 하한을 적어야 합니다');
  assert.ok(nodeMigration.includes('0.22.9') && nodeMigration.includes('0.22.10'), '잘못 분류된 배포를 명시해야 합니다');

  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const breaking = changelog.slice(0, changelog.indexOf('## [0.22.10]'));
  assert.ok(breaking.includes('호환성 파괴'), 'engines 변경은 호환성 파괴로 적어야 합니다');
  assert.ok(breaking.includes('MIGRATION-0.23.md'), 'CHANGELOG가 migration 문서를 가리켜야 합니다');

  const workflows = path.join(root, '.github', 'workflows');
  if (fs.existsSync(workflows)) {
    const ci = fs.readdirSync(workflows).map((name) => fs.readFileSync(path.join(workflows, name), 'utf8')).join('\n');
    assert.ok(!/node-version:\s*\[?\s*['"]?1[0-9]/u.test(ci), `CI가 Node ${floor} 미만을 검증하면 engines가 거짓이 됩니다`);
  }
}

process.stdout.write('documentation tests passed\n');
