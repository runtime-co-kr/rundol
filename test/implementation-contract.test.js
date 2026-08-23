'use strict';

// 기능은 부모를 단 서브다. 원천 계약인 REQ는 자기 문서 안에서 FN-001로 적고, 그 기능을
// 설계하거나 검증하는 문서는 밖에서 REQ-001#FN-001로 적는다. 이 시험이 지키는 것은 그
// 표기 자체가 아니라 표기가 없애 준 것이다 — 중복 정의와 원천 없는 참조는 이제 검사로
// 막는 것이 아니라 쓸 수가 없다.

const assert = require('assert');
const {
  validateImplementationDocument, validateImplementationTrace, validateTaskImplementationReadiness,
  implementationTrace, isIndexArtifact, qualifiedFunctionIds, REQUIRED_FIELDS_BY_TYPE
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

// ── 표기 ─────────────────────────────────────────────────────────────────────

// 부모가 자명한 자리와 그렇지 않은 자리는 표기가 다르다. 한 자리에서 둘 다 받으면 같은
// 기능을 가리키는 글자가 둘이 되고, 부모를 달아 없앤 중복이 표기 차이로 되돌아온다.
function testNotationDependsOnWhoOwnsTheFunction() {
  const req = frontmatter('REQ-001', 'REQ', ['FN-001']) + feature('FN-001');
  assert.deepStrictEqual(validateImplementationDocument(document(req), { implementation: true }), []);

  // 원천 문서가 부모를 적으면 자기 번호를 두 곳에 적는 것이다.
  const redundant = frontmatter('REQ-001', 'REQ', ['REQ-001#FN-001']) + feature('REQ-001#FN-001');
  assert(validateImplementationDocument(document(redundant), { implementation: true })
    .some((item) => item.code === 'RDL-IMPL-003' && item.target === 'REQ-001#FN-001'));

  // 사람이 짓던 접두는 어느 자리에서도 받지 않는다. 받으면 무엇이 옮겨졌는지 셀 수 없다.
  const legacy = frontmatter('REQ-001', 'REQ', ['HRN-02']) + feature('HRN-02');
  assert(validateImplementationDocument(document(legacy), { implementation: true })
    .some((item) => item.code === 'RDL-IMPL-003' && item.target === 'HRN-02'));

  // 하위 산출물은 부모 없이 기능을 가리킬 수 없다. 이것이 RDL-IMPL-011이 막던 것을
  // 표기가 대신 막는 자리다 — 원천을 밝히지 않은 참조라는 것이 쓰일 수가 없다.
  const orphan = frontmatter('TST-001', 'TST', ['FN-001']) + testFeature('FN-001');
  const orphanIssues = validateImplementationDocument(document(orphan, 'TST-001-검증.md'), { implementation: true });
  assert(orphanIssues.some((item) => item.code === 'RDL-IMPL-003' && item.target === 'FN-001'));

  const grounded = frontmatter('TST-001', 'TST', ['REQ-001#FN-001']) + testFeature('REQ-001#FN-001');
  assert.deepStrictEqual(validateImplementationDocument(document(grounded, 'TST-001-검증.md'), { implementation: true }), []);
}

// 표기를 맞추는 자리는 하나다. 두 곳이 각자 맞추면 조인 키가 갈리고, 갈린 키는
// "이어져 있는데 안 이어진 것처럼 보인다"로 끝난다.
function testQualificationHasOnePlace() {
  assert.deepStrictEqual(qualifiedFunctionIds('REQ', 'REQ-033', { functionIds: ['FN-001'] }), ['REQ-033#FN-001']);
  assert.deepStrictEqual(qualifiedFunctionIds('TST', 'TST-017', { functionIds: ['REQ-033#FN-001'] }), ['REQ-033#FN-001']);
  // 어긋난 표기는 추적에 들이지 않는다. 들이면 부모 없는 항목이 다시 생기고,
  // 그때 방금 걷어낸 진단이 다시 필요해진다. 조용하지 않은 것은 003이 같은 값을 잡기 때문이다.
  assert.deepStrictEqual(qualifiedFunctionIds('REQ', 'REQ-033', { functionIds: ['HRN-02'] }), []);
  assert.deepStrictEqual(qualifiedFunctionIds('TST', 'TST-017', { functionIds: ['FN-001'] }), []);
}

// ── 걷어낸 진단 둘 ───────────────────────────────────────────────────────────

// RDL-IMPL-009는 기능 ID가 여러 REQ에 중복 정의되는 것을 막았다. 부모를 달면
// REQ-001#FN-001과 REQ-002#FN-001은 같은 값이 될 수 없으므로 막을 것이 없다.
function testDuplicateAcrossRequirementsCannotExist() {
  const first = { id: 'REQ-001', type: 'REQ', file: 'REQ-001.md', source: frontmatter('REQ-001', 'REQ', ['FN-001']) + feature('FN-001') };
  const second = { id: 'REQ-002', type: 'REQ', file: 'REQ-002.md', source: frontmatter('REQ-002', 'REQ', ['FN-001']) + feature('FN-001') };
  const result = validateImplementationTrace([first, second], { implementation: true });

  assert.deepStrictEqual(result.issues.filter((item) => item.code === 'RDL-IMPL-009'), [],
    '부모를 달았는데 중복 정의 진단이 살아 있으면 표기가 아무것도 바꾸지 못한 것이다.');
  assert.deepStrictEqual(result.trace.entries.map((entry) => entry.functionId), ['REQ-001#FN-001', 'REQ-002#FN-001'],
    '같은 일련이라도 부모가 다르면 다른 기능이다.');
  assert.deepStrictEqual(result.trace.entries.map((entry) => entry.source), ['REQ-001', 'REQ-002'],
    '원천은 표기에서 나온다 — 어느 REQ가 주인인지 되짚는 조회가 없다.');
}

// RDL-IMPL-011은 REQ 원천 계약 없이 하위 산출물이 참조하는 것을 막았다. 이제 하위
// 산출물의 참조는 부모를 적지 않고는 성립하지 않으므로 그 진단이 설 자리가 없다.
function testReferenceWithoutSourceCannotBeWritten() {
  const tst = { id: 'TST-001', type: 'TST', file: 'TST-001.md', source: frontmatter('TST-001', 'TST', ['REQ-001#FN-001']) + testFeature('REQ-001#FN-001') };
  const issues = validateImplementationTrace([tst], { implementation: true }).issues;
  assert.deepStrictEqual(issues.filter((item) => item.code === 'RDL-IMPL-011'), []);

  // 부모를 뗀 참조는 추적에 닿기 전에 표기에서 걸린다.
  const bare = { id: 'TST-002', type: 'TST', file: 'TST-002.md', source: frontmatter('TST-002', 'TST', ['FN-001']) + testFeature('FN-001') };
  assert.deepStrictEqual(implementationTrace([bare]).entries, []);
  assert(validateImplementationDocument({ source: bare.source, file: 'TST-002.md' }, { implementation: true })
    .some((item) => item.code === 'RDL-IMPL-003'));
}

// ── 이하 기존 계약 ───────────────────────────────────────────────────────────

// 문서 1개 = 기능 1개가 기본 계약이다. 다기능이 무결하던 옛 계약은
// 유형 정책과 grouping 선언의 opt-in으로 바뀌었다.
function testSingleFunctionRemainsClean() {
  const source = frontmatter('REQ-001', 'REQ', ['FN-001']) + feature('FN-001');
  assert.deepStrictEqual(validateImplementationDocument(document(source), { implementation: true }), []);
}

function testGranularityContract() {
  // REQ 다기능: 완전한 선언이 있어도 금지 — 분리가 유일한 해소.
  const req = frontmatter('REQ-001', 'REQ', ['FN-001', 'FN-002'], { reason: '정당한 사유' }) + feature('FN-001') + feature('FN-002');
  const reqIssues = validateImplementationDocument(document(req), { implementation: true });
  assert(reqIssues.some((item) => item.code === 'RDL-IMPL-014' && item.severity === 'error'));

  const covered = ['REQ-001#FN-001', 'REQ-001#FN-002'];

  // 선언 없는 다기능은 위반이고, 일반 검사에서는 경고로 단계 도입된다.
  const undeclared = frontmatter('TST-001', 'TST', covered) + testFeature(covered[0]) + testFeature(covered[1]);
  assert(validateImplementationDocument(document(undeclared, 'TST-001-검증.md'), { implementation: true }).some((item) => item.code === 'RDL-IMPL-013' && item.severity === 'error'));
  assert(validateImplementationDocument(document(undeclared, 'TST-001-검증.md'), {}).some((item) => item.code === 'RDL-IMPL-013' && item.severity === 'warning'));

  // TST는 선언이 완전하면 조용히 통과한다.
  const declared = frontmatter('TST-001', 'TST', covered, { reason: '한 시나리오 흐름의 검증 묶음' }) + testFeature(covered[0]) + testFeature(covered[1]);
  assert.deepStrictEqual(validateImplementationDocument(document(declared, 'TST-001-검증.md'), { implementation: true }), []);

  // 사유가 비었거나 범위가 functionIds와 다르면 형식 위반이다.
  const emptyReason = frontmatter('TST-001', 'TST', covered, { reason: '  ' }) + testFeature(covered[0]) + testFeature(covered[1]);
  assert(validateImplementationDocument(document(emptyReason, 'TST-001-검증.md'), { implementation: true }).some((item) => item.code === 'RDL-IMPL-013'));
  const mismatched = frontmatter('TST-001', 'TST', covered, { reason: '사유', functions: [covered[0]] }) + testFeature(covered[0]) + testFeature(covered[1]);
  assert(validateImplementationDocument(document(mismatched, 'TST-001-검증.md'), { implementation: true }).some((item) => item.code === 'RDL-IMPL-015'));

  // 단일 기능 문서의 grouping 선언은 군더더기가 아니라 위반이다.
  const stray = frontmatter('TST-001', 'TST', [covered[0]], { reason: '사유' }) + testFeature(covered[0]);
  assert(validateImplementationDocument(document(stray, 'TST-001-검증.md'), { implementation: true }).some((item) => item.code === 'RDL-IMPL-015'));

  // MOD·API는 선언으로 허용하되 사유를 경고로 항상 표면화한다.
  const modFields = REQUIRED_FIELDS_BY_TYPE.MOD.map((field) => (id) => `#### ${field}\n\n- ${id}의 확정된 ${field} 내용`);
  const modBody = (id) => `\n### ${id}\n\n${modFields.map((render) => render(id)).join('\n\n')}\n`;
  const mod = frontmatter('MOD-001', 'MOD', covered, { reason: '같은 집계의 상태를 공유' }) + modBody(covered[0]) + modBody(covered[1]);
  const modIssues = validateImplementationDocument(document(mod, 'MOD-001-모델.md'), { implementation: true });
  assert(modIssues.some((item) => item.code === 'RDL-IMPL-017' && item.severity === 'warning'));
  assert(!modIssues.some((item) => item.severity === 'error'));
}

function testFunctionCanonicalUniqueness() {
  // 같은 기능이 같은 유형 문서 둘 이상에 흩어지면 위반이다. REQ가 이 목록에 없는 것은
  // 봐주는 것이 아니라 REQ의 선언이 자기 번호로 갈려 흩어질 수 없기 때문이다.
  const covered = 'REQ-001#FN-001';
  const first = { id: 'TST-001', type: 'TST', file: 'TST-001.md', source: frontmatter('TST-001', 'TST', [covered]) + testFeature(covered) };
  const second = { id: 'TST-002', type: 'TST', file: 'TST-002.md', source: frontmatter('TST-002', 'TST', [covered]) + testFeature(covered) };
  const req = { id: 'REQ-001', type: 'REQ', file: 'REQ-001.md', source: frontmatter('REQ-001', 'REQ', ['FN-001']) + feature('FN-001') };
  const issues = validateImplementationTrace([req, first, second], { implementation: true }).issues;
  assert(issues.some((item) => item.code === 'RDL-IMPL-016' && item.severity === 'error' && item.target === covered));
  assert.deepStrictEqual(validateImplementationTrace([req, first, second], {}).issues.filter((item) => item.code === 'RDL-IMPL-016').map((item) => item.severity), ['warning']);
}

function testGroupedSpecificationRejected() {
  const source = frontmatter('REQ-001', 'REQ', ['FN-001', 'FN-002']) + '| 기능 ID | 기준 |\n|---|---|\n| FN-001, FN-002 | 원본 기능정의서 적용 |\n';
  const issues = validateImplementationDocument(document(source), { implementation: true });
  assert(issues.some((item) => item.code === 'RDL-IMPL-004' && item.severity === 'error'));
  assert(issues.filter((item) => item.code === 'RDL-IMPL-005').length === 2);

  // 범위 표기도 같다. 부모를 단 표기에서도 일련만 흘려 적는 것을 잡아야 한다.
  const ranged = frontmatter('TST-001', 'TST', ['REQ-001#FN-001', 'REQ-001#FN-002'], { reason: '검증 묶음' })
    + '\n- REQ-001#FN-001 ~ 002는 원본 문서 적용\n';
  assert(validateImplementationDocument(document(ranged, 'TST-001-검증.md'), { implementation: true })
    .some((item) => item.code === 'RDL-IMPL-004'));
}

function testUnresolvedRuleRejectedAtReadiness() {
  const source = frontmatter('REQ-001', 'REQ', ['FN-001']) + feature('FN-001', { '업무 규칙': '추후 발주기관 확정' });
  const advisory = validateImplementationDocument(document(source), {});
  assert(advisory.some((item) => item.code === 'RDL-IMPL-006' && item.severity === 'warning'));
  const checkpoint = validateImplementationDocument(document(source), { implementation: true });
  assert(checkpoint.some((item) => item.code === 'RDL-IMPL-006' && item.severity === 'error'));
}

function testEveryImplementationTypeRequiresStandaloneFields() {
  for (const type of ['SCR', 'MOD', 'IFC', 'TST']) {
    const id = `${type}-001`;
    const functionId = 'REQ-001#FN-001';
    const complete = frontmatter(id, type, [functionId]) + `\n### ${functionId}\n\n${REQUIRED_FIELDS_BY_TYPE[type].map((field) => `#### ${field}\n\n- ${functionId}의 확정된 ${field} 내용`).join('\n\n')}\n`;
    assert.deepStrictEqual(validateImplementationDocument(document(complete, `${id}-계약.md`), { implementation: true }), []);
    const incomplete = frontmatter(id, type, [functionId]) + `\n### ${functionId}\n\n#### ${REQUIRED_FIELDS_BY_TYPE[type][0]}\n\n- 확정 내용\n`;
    assert(validateImplementationDocument(document(incomplete, `${id}-계약.md`), { implementation: true }).some((item) => item.code === 'RDL-IMPL-006'));
  }
}

function testComputedTraceWithoutIndex() {
  const req = { id: 'REQ-001', type: 'REQ', file: 'REQ-001.md', source: frontmatter('REQ-001', 'REQ', ['FN-001']) + feature('FN-001') };
  const tst = { id: 'TST-001', type: 'TST', file: 'TST-001.md', source: frontmatter('TST-001', 'TST', ['REQ-001#FN-001']) + testFeature('REQ-001#FN-001') };
  const trace = implementationTrace([req, tst]);
  assert.strictEqual(trace.persistedIndex, false);
  assert.strictEqual(trace.entries[0].functionId, 'REQ-001#FN-001');
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
  const req = completeImplementationArtifact('REQ', 'REQ-001', 'FN-001');
  const tst = completeImplementationArtifact('TST', 'TST-001', 'REQ-001#FN-001');
  const brokenApi = {
    id: 'IFC-001', type: 'IFC', file: 'IFC-001.md',
    source: frontmatter('IFC-001', 'IFC', ['REQ-001#FN-001']) + `\n### REQ-001#FN-001\n\n#### ${REQUIRED_FIELDS_BY_TYPE.IFC[0]}\n\n- complete\n`
  };
  const issues = validateTaskImplementationReadiness([req, brokenApi, tst]);
  assert(issues.some((item) => item.artifactId === 'IFC-001' && item.code === 'RDL-IMPL-006' && item.severity === 'error'));
  assert.deepStrictEqual(validateTaskImplementationReadiness([req, tst]), []);

  // REQ가 요구한 기능을 TST가 덮지 않으면 잡는다. 대조가 부모를 단 표기로 이뤄지므로
  // 다른 REQ의 같은 일련을 덮은 것은 덮은 것이 아니다.
  const strayTst = completeImplementationArtifact('TST', 'TST-002', 'REQ-002#FN-001');
  assert(validateTaskImplementationReadiness([req, strayTst]).some((item) => item.code === 'RDL-IMPL-022' && item.target === 'REQ-001#FN-001'));
}

// 화면이 있는 기능은 화면을 근거로 검증되어야 한다. 다만 그 요구를 TST의 필수 관계로
// 바꾸면 화면 없는 기능이 검증 대상에서 빠지므로, 화면 정본이 실제로 있을 때만 요구한다.
function testTestReferencesScreenWhenOneExists() {
  const withRelated = (id, type, ids, related) => ({
    id, type, file: `${id}.md`,
    source: `---\nid: ${id}\nimplementationContract: atomic-v1\nfunctionIds:\n${ids.map((value) => `  - ${value}`).join('\n')}\nrelated:\n${related.map((value) => `  - "[[${value}-어떤-제목|${value}]]"`).join('\n')}\n---\n\n# ${id}\n`
  });
  const covered = 'REQ-001#FN-001';
  const req = withRelated('REQ-001', 'REQ', ['FN-001'], ['PRD-001']);
  const screen = withRelated('SCR-001', 'SCR', [covered], ['REQ-001']);

  // 화면이 있는데 참조하지 않으면 잡는다. 일반 검사는 경고, 준비도 게이트는 오류다.
  const blind = withRelated('TST-001', 'TST', [covered], ['REQ-001']);
  const advisory = validateImplementationTrace([req, screen, blind], {}).issues.filter((item) => item.code === 'RDL-IMPL-018');
  assert.deepStrictEqual(advisory.map((item) => [item.severity, item.target, item.artifactId]), [['warning', covered, 'TST-001']]);
  assert(validateImplementationTrace([req, screen, blind], { implementation: true }).issues
    .some((item) => item.code === 'RDL-IMPL-018' && item.severity === 'error'));

  // 참조하면 통과한다.
  const grounded = withRelated('TST-001', 'TST', [covered], ['REQ-001', 'SCR-001']);
  assert.deepStrictEqual(validateImplementationTrace([req, screen, grounded], { implementation: true }).issues
    .filter((item) => item.code === 'RDL-IMPL-018'), []);

  // 화면이 없는 기능 — 인증·배치·웹훅 같은 것 — 은 REQ 관계만으로 충분하다.
  const headlessReq = withRelated('REQ-002', 'REQ', ['FN-001'], ['PRD-001']);
  const headlessTst = withRelated('TST-002', 'TST', ['REQ-002#FN-001'], ['REQ-002']);
  assert.deepStrictEqual(validateImplementationTrace([headlessReq, headlessTst], { implementation: true }).issues
    .filter((item) => item.code === 'RDL-IMPL-018'), []);

  // 한 문서가 화면 있는 기능과 없는 기능을 함께 검증하면 화면 있는 쪽만 걸린다.
  const mixed = withRelated('TST-003', 'TST', [covered, 'REQ-002#FN-001'], ['REQ-001', 'REQ-002']);
  assert.deepStrictEqual(validateImplementationTrace([req, screen, headlessReq, mixed], {}).issues
    .filter((item) => item.code === 'RDL-IMPL-018').map((item) => item.target), [covered]);
}

function testIndexArtifactNames() {
  assert.strictEqual(isIndexArtifact('인덱스'), true);
  assert.strictEqual(isIndexArtifact('기능 추적표'), true);
  assert.strictEqual(isIndexArtifact('', 'INDEX.md'), true);
  assert.strictEqual(isIndexArtifact('대출 요구사항'), false);
  assert.strictEqual(isIndexArtifact('데이터베이스 인덱스 설계'), false);
}

testNotationDependsOnWhoOwnsTheFunction();
testQualificationHasOnePlace();
testDuplicateAcrossRequirementsCannotExist();
testReferenceWithoutSourceCannotBeWritten();
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
