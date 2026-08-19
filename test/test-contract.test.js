'use strict';

const assert = require('assert');
const { validateTestDocument, scenarioTable } = require('../src/test-contract');

function document(scenarioSection, criteriaSection) {
  return `---\nid: TST-001\n---\n\n# 검증\n\n## 시나리오\n\n${scenarioSection}\n\n## 통과 기준\n\n${criteriaSection}\n\n## 기능별 검증 계약\n`;
}

const table = [
  '| ID | 사전조건 | 실행 | 기대 결과 | 우선순위 |',
  '|---|---|---|---|---|',
  '| S-01 | 인덱스 없음 | 조회 | 정본 경로로 답한다 | 높음 |',
  '| S-02 | 유효한 인덱스 | 조회 | 정본 경로로 답한다 | 높음 |'
].join('\n');

const criteria = '- 모든 인덱스 상태에서 조회가 성공한다.';

function codes(issues) {
  return issues.map((issue) => issue.code).sort();
}

function testCleanDocumentPasses() {
  assert.deepStrictEqual(validateTestDocument('TST', document(table, criteria), 'TST-001', { implementation: true }), []);
  // TST가 아닌 유형은 이 계약의 대상이 아니다.
  assert.deepStrictEqual(validateTestDocument('REQ', document('- 목록으로 적은 시나리오', '- [x] 통과함'), 'REQ-001', {}), []);
}

// 목록으로 적은 시나리오는 문서 밖에서 가리킬 수 없다. 실행 기록이 결과를 붙일 자리가 없다.
function testScenarioMustBeAddressableTable() {
  const bullets = '- 인덱스가 없어도 조회가 성공한다.\n- 손상된 인덱스에서 정본으로 물러난다.';
  const advisory = validateTestDocument('TST', document(bullets, criteria), 'TST-001', {});
  assert.deepStrictEqual(advisory.map((issue) => [issue.code, issue.severity]), [['RDL-SCENARIO-001', 'warning']]);
  assert.deepStrictEqual(
    validateTestDocument('TST', document(bullets, criteria), 'TST-001', { implementation: true }).map((issue) => issue.severity),
    ['error']
  );
  // 헤더와 구분선만 있고 행이 없는 표도 가리킬 대상이 없기는 마찬가지다.
  const empty = '| ID | 사전조건 |\n|---|---|';
  assert.deepStrictEqual(codes(validateTestDocument('TST', document(empty, criteria), 'TST-001', {})), ['RDL-SCENARIO-001']);
}

function testScenarioIdFormatAndUniqueness() {
  const spaced = table.replace('| S-01 |', '| S 01 |');
  const spacedIssues = validateTestDocument('TST', document(spaced, criteria), 'TST-001', {});
  assert.deepStrictEqual(codes(spacedIssues), ['RDL-SCENARIO-002']);
  assert.strictEqual(spacedIssues[0].target, 'S 01');

  const blank = table.replace('| S-01 |', '|  |');
  assert.deepStrictEqual(codes(validateTestDocument('TST', document(blank, criteria), 'TST-001', {})), ['RDL-SCENARIO-002']);

  const duplicate = table.replace('| S-02 |', '| S-01 |');
  const duplicateIssues = validateTestDocument('TST', document(duplicate, criteria), 'TST-001', {});
  assert.deepStrictEqual(codes(duplicateIssues), ['RDL-SCENARIO-003']);
  assert.strictEqual(duplicateIssues[0].target, 'S-01');

  // 형식은 한 가지로 강제하지 않는다. 참조에 필요한 것은 통일성이 아니라 안정성과
  // 유일성이므로, 이미 쓰이는 규칙들이 그대로 통과해야 한다.
  for (const id of ['S-01', 'WSP01-01', 'COL-01-S01', 'TST-CONTRACT-001', 'DEC-S05']) {
    const renamed = table.replace('| S-01 |', `| ${id} |`);
    assert.deepStrictEqual(validateTestDocument('TST', document(renamed, criteria), 'TST-001', { implementation: true }), [], id);
  }
}

// 통과 기준은 무엇이 참이어야 하는지를 적는다. 이번에 실제로 통과했는지는 실행 기록이
// 답한다. 체크박스를 문서에 두면 재실행할 때마다 정본을 고쳐야 하고 이력이 남지 않는다.
function testPassCriteriaCarriesNoResult() {
  const checked = '- [x] 자동 검증이 통과한다.\n- [ ] 설치 회귀가 통과한다.';
  const issues = validateTestDocument('TST', document(table, checked), 'TST-001', {});
  assert.deepStrictEqual(codes(issues), ['RDL-SCENARIO-004']);
  assert(issues[0].message.includes('2개'));
  assert.strictEqual(issues[0].artifactId, 'TST-001');
}

// 섹션 이름은 프로젝트가 board.json에서 바꿀 수 있다. 없는 섹션을 요구하면 이름을 바꾼
// 팀에게 거짓 위반이 된다.
function testMissingSectionsStaySilent() {
  const source = '---\nid: TST-001\n---\n\n# 검증\n\n## 검증 항목\n\n- 자유 형식\n';
  assert.deepStrictEqual(validateTestDocument('TST', source, 'TST-001', { implementation: true }), []);
}

function testScenarioTableParsing() {
  const parsed = scenarioTable(table);
  assert.deepStrictEqual(parsed.header[0], 'ID');
  assert.deepStrictEqual(parsed.data.map((row) => row[0]), ['S-01', 'S-02']);
  assert.strictEqual(scenarioTable('- 목록뿐'), null);
}

testCleanDocumentPasses();
testScenarioMustBeAddressableTable();
testScenarioIdFormatAndUniqueness();
testPassCriteriaCarriesNoResult();
testMissingSectionsStaySilent();
testScenarioTableParsing();
process.stdout.write('test contract tests passed\n');
