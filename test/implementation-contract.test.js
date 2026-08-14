'use strict';

const assert = require('assert');
const {
  validateImplementationDocument, validateImplementationTrace, implementationTrace, isIndexArtifact, REQUIRED_FIELDS_BY_TYPE
} = require('../src/implementation-contract');

const fields = ['입력', '출력', '업무 규칙', '상태와 전이', '권한과 승인', '정상·오류·취소', '감사 기록', '수용 기준'];
const testFields = ['사전 조건', '입력과 데이터', '실행 절차', '기대 결과', '오류와 취소', '증거', '수용 기준'];

function frontmatter(id, type, functionIds) {
  return `---\nid: ${id}\ntitle: 기능 계약\nimplementationContract: atomic-v1\nfunctionIds:\n${functionIds.map((value) => `  - ${value}`).join('\n')}\n---\n\n# 기능 계약\n`;
}

function feature(id, override) {
  return `\n### ${id}\n\n${fields.map((field) => `#### ${field}\n\n- ${(override && override[field]) || `${id}의 확정된 ${field} 내용`}`).join('\n\n')}\n`;
}

function testFeature(id) {
  return `\n### ${id}\n\n${testFields.map((field) => `#### ${field}\n\n- ${id}의 확정된 ${field} 내용`).join('\n\n')}\n`;
}

function document(source, file) {
  return { source, file: file || 'REQ-001-기능-계약.md', relativeFile: file || 'REQ-001-기능-계약.md' };
}

function testAtomicFunctionsInOneDocument() {
  const source = frontmatter('REQ-001', 'REQ', ['MEM-01', 'MEM-02']) + feature('MEM-01') + feature('MEM-02');
  assert.deepStrictEqual(validateImplementationDocument(document(source), { implementation: true }), []);
}

function testGroupedSpecificationRejected() {
  const source = frontmatter('REQ-001', 'REQ', ['MEM-01', 'MEM-02']) + '| 기능 ID | 기준 |\n|---|---|\n| MEM-01, MEM-02 | 원본 기능정의서 적용 |\n';
  const issues = validateImplementationDocument(document(source), { implementation: true });
  assert(issues.some((item) => item.code === 'RDL-IMPL-004' && item.severity === 'error'));
  assert(issues.filter((item) => item.code === 'RDL-IMPL-005').length === 2);
}

function testUnresolvedRuleRejectedAtReadiness() {
  const source = frontmatter('REQ-001', 'REQ', ['PAY-01']) + feature('PAY-01', { '업무 규칙': '추후 발주기관 확정' });
  const advisory = validateImplementationDocument(document(source), {});
  assert(advisory.some((item) => item.code === 'RDL-IMPL-006' && item.severity === 'warning'));
  const checkpoint = validateImplementationDocument(document(source), { implementation: true });
  assert(checkpoint.some((item) => item.code === 'RDL-IMPL-006' && item.severity === 'error'));
}

function testEveryImplementationTypeRequiresStandaloneFields() {
  for (const type of ['SCR', 'MOD', 'API', 'TST']) {
    const id = `${type}-001`;
    const functionId = 'PAY-01';
    const complete = frontmatter(id, type, [functionId]) + `\n### ${functionId}\n\n${REQUIRED_FIELDS_BY_TYPE[type].map((field) => `#### ${field}\n\n- ${functionId}의 확정된 ${field} 내용`).join('\n\n')}\n`;
    assert.deepStrictEqual(validateImplementationDocument(document(complete, `${id}-계약.md`), { implementation: true }), []);
    const incomplete = frontmatter(id, type, [functionId]) + `\n### ${functionId}\n\n#### ${REQUIRED_FIELDS_BY_TYPE[type][0]}\n\n- 확정 내용\n`;
    assert(validateImplementationDocument(document(incomplete, `${id}-계약.md`), { implementation: true }).some((item) => item.code === 'RDL-IMPL-006'));
  }
}

function testComputedTraceWithoutIndex() {
  const req = { id: 'REQ-001', type: 'REQ', file: 'REQ-001.md', source: frontmatter('REQ-001', 'REQ', ['PAY-01']) + feature('PAY-01') };
  const tst = { id: 'TST-001', type: 'TST', file: 'TST-001.md', source: frontmatter('TST-001', 'TST', ['PAY-01']) + testFeature('PAY-01') };
  const trace = implementationTrace([req, tst]);
  assert.strictEqual(trace.persistedIndex, false);
  assert.strictEqual(trace.entries[0].ready, true);
  assert.deepStrictEqual(validateImplementationTrace([req, tst], { implementation: true }).issues, []);
  assert(validateImplementationTrace([req], { implementation: true }).issues.some((item) => item.code === 'RDL-IMPL-012' && item.severity === 'error'));
}

function testIndexArtifactNames() {
  assert.strictEqual(isIndexArtifact('인덱스'), true);
  assert.strictEqual(isIndexArtifact('기능 추적표'), true);
  assert.strictEqual(isIndexArtifact('', 'INDEX.md'), true);
  assert.strictEqual(isIndexArtifact('대출 요구사항'), false);
  assert.strictEqual(isIndexArtifact('데이터베이스 인덱스 설계'), false);
}

testAtomicFunctionsInOneDocument();
testGroupedSpecificationRejected();
testUnresolvedRuleRejectedAtReadiness();
testEveryImplementationTypeRequiresStandaloneFields();
testComputedTraceWithoutIndex();
testIndexArtifactNames();
process.stdout.write('implementation contract tests passed\n');
