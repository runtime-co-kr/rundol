'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DIAGRAM_VERSION, DIAGRAM_CONVENTIONS, sectionBody, mermaidBlocks, annotatedAttributes, diagramGuidance, validateDocumentDiagram } = require('../src/document-diagram');
const { documentContractCatalog } = require('../src/document-contract');

const repository = path.resolve(__dirname, '..');

function model(relationSection) {
  return `# 데이터 모델\n\n## 엔티티\n\n| 엔티티 | 필드 |\n|---|---|\n| Client | id |\n\n## 관계\n\n${relationSection}\n\n## 불변식\n\n- 규칙\n`;
}

const fence = '```';
function diagram(body) {
  return `${fence}mermaid\n${body}\n${fence}`;
}

function codes(issues) {
  return issues.map((issue) => issue.code);
}

const compliant = diagram(`erDiagram
    WORKSPACE ||--o{ CLIENT : "등록"
    MEMBER ||--o{ CLIENT : "소유"

    CLIENT {
        string id PK
        integer revision
        string owner FK
    }`);

const annotated = diagram(`erDiagram
    WORKSPACE ||--o{ CLIENT : "등록"

    CLIENT {
        string id PK "소문자 kebab-case"
        integer revision "생성 시 1"
        string owner FK
    }`);

// section extraction stops at the next level-two heading and ignores deeper ones
assert.match(sectionBody(model(compliant), '관계'), /erDiagram/u);
assert.doesNotMatch(sectionBody(model(compliant), '관계'), /불변식/u);
assert.strictEqual(sectionBody(model(compliant), '없는 섹션'), null);
assert.doesNotMatch(sectionBody('## 관계\n\n표\n\n### 관계와 카디널리티\n\n세부\n', '관계'), /^##\s/mu);

// fenced block extraction
assert.strictEqual(mermaidBlocks(model(compliant)).length, 1);
assert.strictEqual(mermaidBlocks(model('본문만 있음')).length, 0);

// relationship labels are quoted but are not attribute annotations
assert.deepStrictEqual(annotatedAttributes('erDiagram\n    A ||--o{ B : "관계"\n'), []);
assert.strictEqual(annotatedAttributes(annotated.replace(/```mermaid\n|\n```/gu, '')).length, 2);

// RDL-MODEL-001: MOD without an erDiagram in 관계
assert.deepStrictEqual(codes(validateDocumentDiagram('MOD', model('| 출발 | 대상 |\n|---|---|\n| A | B |'))), ['RDL-MODEL-001']);

// a flowchart does not satisfy the erDiagram requirement
assert.deepStrictEqual(codes(validateDocumentDiagram('MOD', model(diagram('flowchart LR\n    A --> B')))), ['RDL-MODEL-001']);

// compliant document reports nothing
assert.deepStrictEqual(validateDocumentDiagram('MOD', model(compliant)), []);

// RDL-MODEL-002: attribute comments duplicate the entity table
const duplicated = validateDocumentDiagram('MOD', model(annotated));
assert.deepStrictEqual(codes(duplicated), ['RDL-MODEL-002', 'RDL-MODEL-002']);
assert.match(duplicated[0].message, /속성 주석/u);

// only covered types are evaluated, and a MOD without the section is left alone
assert.deepStrictEqual(validateDocumentDiagram('REQ', model('표만 있음')), []);
assert.deepStrictEqual(validateDocumentDiagram('MOD', '# 제목\n\n## 엔티티\n\n표\n'), []);

// guidance and catalog expose the convention to AI clients
assert.strictEqual(diagramGuidance('mod').type, 'MOD');
assert.strictEqual(diagramGuidance('mod').authority, 'table');
assert.strictEqual(diagramGuidance('PRD'), null);

// the selection criterion is one question per element, and guidance hands back a mutable copy
const selection = diagramGuidance('MOD').selection;
assert.deepStrictEqual(selection.map((rule) => rule.element), ['엔티티', '관계', '카디널리티']);
for (const rule of selection) for (const field of ['question', 'include', 'exclude']) assert.ok(rule[field], `selection.${rule.element}.${field} must be stated`);
selection.push({ element: '변조' });
assert.strictEqual(diagramGuidance('MOD').selection.length, 3);
assert.ok(diagramGuidance('MOD').excluded.some((item) => item.includes('상태 전이')));

const catalog = documentContractCatalog();
assert.strictEqual(catalog.diagrams.version, DIAGRAM_VERSION);
assert.deepStrictEqual(catalog.diagrams.types, Object.keys(DIAGRAM_CONVENTIONS));
assert.strictEqual(catalog.diagrams.conventions.MOD.section, '관계');
assert.deepStrictEqual(catalog.diagrams.conventions.MOD.kinds, ['erDiagram']);
assert.deepStrictEqual(catalog.diagrams.conventions.MOD.selection.map((rule) => rule.element), ['엔티티', '관계', '카디널리티']);

// the MOD template ships a conforming scaffold
const template = fs.readFileSync(path.join(repository, 'docs', 'templates', 'MOD.template.md'), 'utf8');
assert.match(template, /erDiagram/u);
assert.deepStrictEqual(annotatedAttributes(mermaidBlocks(sectionBody(template, '관계'))[0]), []);

// the skill and its reference state the same rule
const skill = fs.readFileSync(path.join(repository, 'skills', 'rundol-project-governance', 'SKILL.md'), 'utf8');
assert.match(skill, /erDiagram/u);
assert.match(skill, /catalog\.diagrams/u);
const reference = fs.readFileSync(path.join(repository, 'skills', 'rundol-project-governance', 'references', 'governance-contract.md'), 'utf8');
for (const token of ['RDL-MODEL-001', 'RDL-MODEL-002', 'erDiagram', DIAGRAM_VERSION, 'selection']) assert.ok(reference.includes(token), `governance-contract.md must document ${token}`);

// the selection criterion reaches both the skill and the published standard
const standard = fs.readFileSync(path.join(repository, 'docs', 'DOCUMENT-STANDARD.md'), 'utf8');
for (const source of [skill, reference, standard]) {
  for (const element of ['엔티티', '관계', '카디널리티']) assert.ok(source.includes(element) || /Cardinality/u.test(source), `diagram selection must cover ${element}`);
}
for (const source of [reference, standard]) assert.ok(/저장 시점|write time/u.test(source), 'stored-versus-read cardinality must be stated');

process.stdout.write('document diagram tests passed\n');
