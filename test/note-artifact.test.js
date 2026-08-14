'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../src/frontmatter');

const repository = path.resolve(__dirname, '..');
const templateRoot = path.join(repository, 'docs', 'templates');

// every shipped template must close its frontmatter, or rdl doc create emits an unparseable document
for (const name of fs.readdirSync(templateRoot).filter((entry) => entry.endsWith('.template.md'))) {
  const source = fs.readFileSync(path.join(templateRoot, name), 'utf8');
  assert.ok(parseFrontmatter(source), `${name}의 frontmatter가 닫히지 않았습니다.`);
}

const note = fs.readFileSync(path.join(templateRoot, 'NTE.template.md'), 'utf8');
const parsed = parseFrontmatter(note);

// rdl doc create fills owner by replacing an existing quoted owner line, so the template must carry one
assert.match(note, /^owner:\s*"\[\[project#\^MEMBER-\d{3}\|[^\]]+\]\]"$/mu, 'NTE 템플릿에 치환 가능한 owner 줄이 필요합니다.');
for (const field of ['id', 'type', 'kind', 'title', 'description', 'owner', 'state', 'tags', 'aliases', 'related']) {
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.data, field), `NTE 템플릿에 필수 메타 필드가 없습니다: ${field}`);
}
assert.strictEqual(parsed.data.aliases[0], parsed.data.id);
assert.ok(parsed.body.trim().length > 0, 'NTE 템플릿에 본문이 필요합니다.');

// a note stays outside the artifact taxonomy: rundol/ only, never artifact/domain/feature
const tags = parsed.data.tags;
assert.ok(tags.some((tag) => tag.startsWith('rundol/')), 'NTE 템플릿에 rundol/ 태그가 필요합니다.');
for (const namespace of ['artifact/', 'domain/', 'feature/']) {
  assert.ok(!tags.some((tag) => tag.startsWith(namespace)), `NTE는 비정규 노트이므로 ${namespace} 태그를 갖지 않습니다.`);
}

// the reduced namespace requirement is what lets that template pass RDL-DOC-008
const check = fs.readFileSync(path.join(repository, 'src', 'check.js'), 'utf8');
assert.match(check, /NON_CANONICAL_CODES\s*=\s*new Set\(\['NTE'\]\)/u);
assert.match(check, /NOTE_TAG_NAMESPACES\s*=\s*\['rundol\/'\]/u);

// the published standard states that notes are non-canonical
const standard = fs.readFileSync(path.join(repository, 'docs', 'DOCUMENT-STANDARD.md'), 'utf8');
assert.ok(standard.includes('NTE'), 'DOCUMENT-STANDARD.md가 NTE를 설명해야 합니다.');

process.stdout.write('note artifact tests passed\n');
