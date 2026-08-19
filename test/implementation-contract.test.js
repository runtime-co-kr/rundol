'use strict';

const assert = require('assert');
const {
  validateImplementationDocument, validateImplementationTrace, validateTaskImplementationReadiness,
  implementationTrace, isIndexArtifact, REQUIRED_FIELDS_BY_TYPE
} = require('../src/implementation-contract');

const fields = ['입력', '출력', '업무 규칙', '상태와 전이', '권한과 승인', '정상·오류·취소', '감사 기록', '수용 기준'];
const testFields = ['사전 조건', '입력과 데이터', '실행 절차', '기대 결과', '오류와 취소', '증거', '수용 기준'];

function frontmatter(id, type, functionIds, grouping) {
  const declaration = grouping ? `\ngroupingReason: ${JSON.stringify(grouping.reason || '')}\ngroupingFunctions:\n${(grouping.functions || functionIds).map((value) => `  - ${value}`).join('\n')}` : '';
  return `---\nid: ${id}\ntitle: 기능 계약\nimplementationContract: atomic-v1\nfunctionIds:\n${functionIds.map((value) => `  - ${value}`).join('\n')}${declaration}\n---\n\n# 기능 계약\n`;
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

// 문서 1개 = 기능 1개가 기본 계약이다. 다기능이 무결하던 옛 계약은
// 유형 정책과 grouping 선언의 opt-in으로 바뀌었다.
function testSingleFunctionRemainsClean() {
  const source = frontmatter('REQ-001', 'REQ', ['MEM-01']) + feature('MEM-01');
  assert.deepStrictEqual(validateImplementationDocument(document(source), { implementation: true }), []);
}

function testGranularityContract() {
  // REQ 다기능: 완전한 선언이 있어도 금지 — 분리가 유일한 해소.
  const req = frontmatter('REQ-001', 'REQ', ['MEM-01', 'MEM-02'], { reason: '정당한 사유' }) + feature('MEM-01') + feature('MEM-02');
  const reqIssues = validateImplementationDocument(document(req), { implementation: true });
  assert(reqIssues.some((item) => item.code === 'RDL-IMPL-014' && item.severity === 'error'));

  // 선언 없는 다기능은 위반이고, 일반 검사에서는 경고로 단계 도입된다.
  const undeclared = frontmatter('TST-001', 'TST', ['MEM-01', 'MEM-02']) + testFeature('MEM-01') + testFeature('MEM-02');
  assert(validateImplementationDocument(document(undeclared, 'TST-001-검증.md'), { implementation: true }).some((item) => item.code === 'RDL-IMPL-013' && item.severity === 'error'));
  assert(validateImplementationDocument(document(undeclared, 'TST-001-검증.md'), {}).some((item) => item.code === 'RDL-IMPL-013' && item.severity === 'warning'));

  // TST는 선언이 완전하면 조용히 통과한다.
  const declared = frontmatter('TST-001', 'TST', ['MEM-01', 'MEM-02'], { reason: '한 시나리오 흐름의 검증 묶음' }) + testFeature('MEM-01') + testFeature('MEM-02');
  assert.deepStrictEqual(validateImplementationDocument(document(declared, 'TST-001-검증.md'), { implementation: true }), []);

  // 사유가 비었거나 범위가 functionIds와 다르면 형식 위반이다.
  const emptyReason = frontmatter('TST-001', 'TST', ['MEM-01', 'MEM-02'], { reason: '  ' }) + testFeature('MEM-01') + testFeature('MEM-02');
  assert(validateImplementationDocument(document(emptyReason, 'TST-001-검증.md'), { implementation: true }).some((item) => item.code === 'RDL-IMPL-013'));
  const mismatched = frontmatter('TST-001', 'TST', ['MEM-01', 'MEM-02'], { reason: '사유', functions: ['MEM-01'] }) + testFeature('MEM-01') + testFeature('MEM-02');
  assert(validateImplementationDocument(document(mismatched, 'TST-001-검증.md'), { implementation: true }).some((item) => item.code === 'RDL-IMPL-015'));

  // 단일 기능 문서의 grouping 선언은 군더더기가 아니라 위반이다.
  const stray = frontmatter('TST-001', 'TST', ['MEM-01'], { reason: '사유' }) + testFeature('MEM-01');
  assert(validateImplementationDocument(document(stray, 'TST-001-검증.md'), { implementation: true }).some((item) => item.code === 'RDL-IMPL-015'));

  // MOD·API는 선언으로 허용하되 사유를 경고로 항상 표면화한다.
  const modFields = REQUIRED_FIELDS_BY_TYPE.MOD.map((field) => (id) => `#### ${field}\n\n- ${id}의 확정된 ${field} 내용`);
  const modBody = (id) => `\n### ${id}\n\n${modFields.map((render) => render(id)).join('\n\n')}\n`;
  const mod = frontmatter('MOD-001', 'MOD', ['MEM-01', 'MEM-02'], { reason: '같은 집계의 상태를 공유' }) + modBody('MEM-01') + modBody('MEM-02');
  const modIssues = validateImplementationDocument(document(mod, 'MOD-001-모델.md'), { implementation: true });
  assert(modIssues.some((item) => item.code === 'RDL-IMPL-017' && item.severity === 'warning'));
  assert(!modIssues.some((item) => item.severity === 'error'));
}

function testFunctionCanonicalUniqueness() {
  // 같은 기능 ID가 같은 유형 문서 둘 이상에 흩어지면 위반이다 (REQ는 기존 009가 지킨다).
  const first = { id: 'TST-001', type: 'TST', file: 'TST-001.md', source: frontmatter('TST-001', 'TST', ['PAY-01']) + testFeature('PAY-01') };
  const second = { id: 'TST-002', type: 'TST', file: 'TST-002.md', source: frontmatter('TST-002', 'TST', ['PAY-01']) + testFeature('PAY-01') };
  const req = { id: 'REQ-001', type: 'REQ', file: 'REQ-001.md', source: frontmatter('REQ-001', 'REQ', ['PAY-01']) + feature('PAY-01') };
  const issues = validateImplementationTrace([req, first, second], { implementation: true }).issues;
  assert(issues.some((item) => item.code === 'RDL-IMPL-016' && item.severity === 'error' && item.target === 'PAY-01'));
  assert.deepStrictEqual(validateImplementationTrace([req, first, second], {}).issues.filter((item) => item.code === 'RDL-IMPL-016').map((item) => item.severity), ['warning']);
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
  for (const type of ['SCR', 'MOD', 'IFC', 'TST']) {
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

function completeImplementationArtifact(type, artifactId, functionId) {
  const required = REQUIRED_FIELDS_BY_TYPE[type];
  const body = `\n### ${functionId}\n\n${required.map((field) => `#### ${field}\n\n- ${functionId} has a complete ${field} contract`).join('\n\n')}\n`;
  return { id: artifactId, type, file: `${artifactId}.md`, source: frontmatter(artifactId, type, [functionId]) + body };
}

function testTaskReadinessChecksEveryLinkedImplementationType() {
  const req = completeImplementationArtifact('REQ', 'REQ-001', 'PAY-01');
  const tst = completeImplementationArtifact('TST', 'TST-001', 'PAY-01');
  const brokenApi = {
    id: 'IFC-001', type: 'IFC', file: 'IFC-001.md',
    source: frontmatter('IFC-001', 'IFC', ['PAY-01']) + `\n### PAY-01\n\n#### ${REQUIRED_FIELDS_BY_TYPE.IFC[0]}\n\n- complete\n`
  };
  const issues = validateTaskImplementationReadiness([req, brokenApi, tst]);
  assert(issues.some((item) => item.artifactId === 'IFC-001' && item.code === 'RDL-IMPL-006' && item.severity === 'error'));
  assert.deepStrictEqual(validateTaskImplementationReadiness([req, tst]), []);
}

// 화면이 있는 기능은 화면을 근거로 검증되어야 한다. 다만 그 요구를 TST의 필수 관계로
// 바꾸면 화면 없는 기능이 검증 대상에서 빠지므로, 화면 정본이 실제로 있을 때만 요구한다.
function testTestReferencesScreenWhenOneExists() {
  const withRelated = (id, type, ids, related) => ({
    id, type, file: `${id}.md`,
    source: `---\nid: ${id}\nimplementationContract: atomic-v1\nfunctionIds:\n${ids.map((value) => `  - ${value}`).join('\n')}\nrelated:\n${related.map((value) => `  - "[[${value}-어떤-제목|${value}]]"`).join('\n')}\n---\n\n# ${id}\n`
  });
  const req = withRelated('REQ-001', 'REQ', ['PAY-01'], ['PRD-001']);
  const screen = withRelated('SCR-001', 'SCR', ['PAY-01'], ['REQ-001']);

  // 화면이 있는데 참조하지 않으면 잡는다. 일반 검사는 경고, 준비도 게이트는 오류다.
  const blind = withRelated('TST-001', 'TST', ['PAY-01'], ['REQ-001']);
  const advisory = validateImplementationTrace([req, screen, blind], {}).issues.filter((item) => item.code === 'RDL-IMPL-018');
  assert.deepStrictEqual(advisory.map((item) => [item.severity, item.target, item.artifactId]), [['warning', 'PAY-01', 'TST-001']]);
  assert(validateImplementationTrace([req, screen, blind], { implementation: true }).issues
    .some((item) => item.code === 'RDL-IMPL-018' && item.severity === 'error'));

  // 참조하면 통과한다.
  const grounded = withRelated('TST-001', 'TST', ['PAY-01'], ['REQ-001', 'SCR-001']);
  assert.deepStrictEqual(validateImplementationTrace([req, screen, grounded], { implementation: true }).issues
    .filter((item) => item.code === 'RDL-IMPL-018'), []);

  // 화면이 없는 기능 — 인증·배치·웹훅 같은 것 — 은 REQ 관계만으로 충분하다.
  const headlessReq = withRelated('REQ-002', 'REQ', ['AUTH-01'], ['PRD-001']);
  const headlessTst = withRelated('TST-002', 'TST', ['AUTH-01'], ['REQ-002']);
  assert.deepStrictEqual(validateImplementationTrace([headlessReq, headlessTst], { implementation: true }).issues
    .filter((item) => item.code === 'RDL-IMPL-018'), []);

  // 한 문서가 화면 있는 기능과 없는 기능을 함께 검증하면 화면 있는 쪽만 걸린다.
  const mixed = withRelated('TST-003', 'TST', ['PAY-01', 'AUTH-01'], ['REQ-001', 'REQ-002']);
  assert.deepStrictEqual(validateImplementationTrace([req, screen, headlessReq, mixed], {}).issues
    .filter((item) => item.code === 'RDL-IMPL-018').map((item) => item.target), ['PAY-01']);
}

function testIndexArtifactNames() {
  assert.strictEqual(isIndexArtifact('인덱스'), true);
  assert.strictEqual(isIndexArtifact('기능 추적표'), true);
  assert.strictEqual(isIndexArtifact('', 'INDEX.md'), true);
  assert.strictEqual(isIndexArtifact('대출 요구사항'), false);
  assert.strictEqual(isIndexArtifact('데이터베이스 인덱스 설계'), false);
}

testSingleFunctionRemainsClean();
testGranularityContract();
testFunctionCanonicalUniqueness();
testGroupedSpecificationRejected();
testUnresolvedRuleRejectedAtReadiness();
testEveryImplementationTypeRequiresStandaloneFields();
testComputedTraceWithoutIndex();
testTaskReadinessChecksEveryLinkedImplementationType();
testTestReferencesScreenWhenOneExists();
testIndexArtifactNames();
process.stdout.write('implementation contract tests passed\n');
