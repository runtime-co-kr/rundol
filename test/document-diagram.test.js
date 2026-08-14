'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DIAGRAM_VERSION, DIAGRAM_CONVENTIONS, sectionBody, mermaidBlocks, annotatedAttributes, flowchartEdges, diagramGuidance, validateDocumentDiagram } = require('../src/document-diagram');
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

function screen(transitionSection) {
  return `# 화면\n\n## 사용자 흐름\n\n1. 행동\n\n## 전이\n\n${transitionSection}\n\n## 바인딩\n\n표\n`;
}

// edge parsing keeps the node identifier and drops the bracket label and the edge condition
assert.deepStrictEqual(flowchartEdges('flowchart LR\n    SCR-001 --> SCR-002'), [{ from: 'SCR-001', label: '', to: 'SCR-002' }]);
assert.deepStrictEqual(flowchartEdges('SCR-001["로그인"] -->|자격 유효| SCR-002["대시보드"]'), [{ from: 'SCR-001', label: '자격 유효', to: 'SCR-002' }]);
assert.deepStrictEqual(flowchartEdges('SCR-001 -.-> SCR-002\n    SCR-001 ==> SCR-003'), [{ from: 'SCR-001', label: '', to: 'SCR-002' }, { from: 'SCR-001', label: '', to: 'SCR-003' }]);
assert.deepStrictEqual(flowchartEdges('%% 주석\nsubgraph 묶음\nend'), []);

// RDL-SCREEN-001: SCR without a flowchart in 전이, and an erDiagram does not satisfy it
assert.deepStrictEqual(codes(validateDocumentDiagram('SCR', screen('| 트리거 | 대상 |\n|---|---|'))), ['RDL-SCREEN-001']);
assert.deepStrictEqual(codes(validateDocumentDiagram('SCR', screen(diagram('erDiagram\n    A ||--o{ B : "관계"')))), ['RDL-SCREEN-001']);

// compliant transitions report nothing and a SCR without the section is left alone
assert.deepStrictEqual(validateDocumentDiagram('SCR', screen(diagram('flowchart LR\n    SCR-001["로그인"] -->|자격 유효| SCR-002["대시보드"]\n    SCR-001 -->|취소| SCR-003'))), []);
assert.deepStrictEqual(validateDocumentDiagram('SCR', '# 화면\n\n## 진입\n\n경로\n'), []);

// RDL-SCREEN-002: a screen-internal state drawn as a transition
const internal = validateDocumentDiagram('SCR', screen(diagram('flowchart LR\n    SCR-001 -->|자격 무효| error')));
assert.deepStrictEqual(codes(internal), ['RDL-SCREEN-002']);
assert.strictEqual(internal[0].target, 'error');
assert.match(internal[0].message, /상태 표/u);

// RDL-SCREEN-003: an edge returning to the same screen belongs to 상태, and it is not double-reported as an unknown node
assert.deepStrictEqual(codes(validateDocumentDiagram('SCR', screen(diagram('flowchart LR\n    SCR-001 -->|재시도| SCR-001')))), ['RDL-SCREEN-003']);
assert.deepStrictEqual(codes(validateDocumentDiagram('SCR', screen(diagram('flowchart LR\n    loading --> loading')))), ['RDL-SCREEN-002']);

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

// the screen convention exposes its own selection criterion
assert.deepStrictEqual(diagramGuidance('SCR').selection.map((rule) => rule.element), ['노드', '간선', '조건']);
assert.strictEqual(diagramGuidance('SCR').codes.missing, 'RDL-SCREEN-001');

const catalog = documentContractCatalog();
assert.strictEqual(catalog.diagrams.version, DIAGRAM_VERSION);
assert.deepStrictEqual(catalog.diagrams.types, Object.keys(DIAGRAM_CONVENTIONS));
assert.deepStrictEqual(catalog.diagrams.types, ['MOD', 'SCR']);
assert.strictEqual(catalog.diagrams.conventions.MOD.section, '관계');
assert.deepStrictEqual(catalog.diagrams.conventions.MOD.kinds, ['erDiagram']);
assert.deepStrictEqual(catalog.diagrams.conventions.MOD.selection.map((rule) => rule.element), ['엔티티', '관계', '카디널리티']);
assert.strictEqual(catalog.diagrams.conventions.SCR.section, '전이');
assert.deepStrictEqual(catalog.diagrams.conventions.SCR.kinds, ['flowchart']);

// both templates ship a conforming scaffold
const template = fs.readFileSync(path.join(repository, 'docs', 'templates', 'MOD.template.md'), 'utf8');
assert.match(template, /erDiagram/u);
assert.deepStrictEqual(annotatedAttributes(mermaidBlocks(sectionBody(template, '관계'))[0]), []);

const screenTemplate = fs.readFileSync(path.join(repository, 'docs', 'templates', 'SCR.template.md'), 'utf8');
assert.deepStrictEqual(validateDocumentDiagram('SCR', screenTemplate), []);
assert.match(sectionBody(screenTemplate, '전이'), /flowchart/u);
assert.ok(catalog.sections.SCR.includes('전이'), 'the contract catalog must expose the 전이 section');

// the skill and its reference state the same rule
const skill = fs.readFileSync(path.join(repository, 'skills', 'rundol-project-governance', 'SKILL.md'), 'utf8');
assert.match(skill, /erDiagram/u);
assert.match(skill, /catalog\.diagrams/u);
const reference = fs.readFileSync(path.join(repository, 'skills', 'rundol-project-governance', 'references', 'governance-contract.md'), 'utf8');
for (const token of ['RDL-MODEL-001', 'RDL-MODEL-002', 'RDL-SCREEN-001', 'RDL-SCREEN-002', 'RDL-SCREEN-003', 'erDiagram', 'flowchart', DIAGRAM_VERSION, 'selection']) assert.ok(reference.includes(token), `governance-contract.md must document ${token}`);

// the selection criterion reaches both the skill and the published standard
const standard = fs.readFileSync(path.join(repository, 'docs', 'DOCUMENT-STANDARD.md'), 'utf8');
for (const source of [skill, reference, standard]) {
  for (const element of ['엔티티', '관계', '카디널리티']) assert.ok(source.includes(element) || /Cardinality/u.test(source), `diagram selection must cover ${element}`);
}
for (const source of [reference, standard]) assert.ok(/저장 시점|write time/u.test(source), 'stored-versus-read cardinality must be stated');

// the screen transition boundary against 상태 reaches the same three surfaces
for (const source of [skill, reference, standard]) {
  assert.ok(/전이/u.test(source), 'the screen transition section must be named');
  assert.ok(/RDL-SCREEN-00[123]/u.test(source) || /상태/u.test(source), 'the transition-versus-state boundary must be stated');
}

process.stdout.write('document diagram tests passed\n');
