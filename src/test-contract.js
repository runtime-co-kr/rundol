'use strict';

const { sectionBody } = require('./document-diagram');

// 검증 문서는 명세만 갖는다. 무엇이 참이어야 통과인지는 문서가 정하고, 이번에 실제로
// 통과했는지는 실행 기록이 답한다. 둘을 한 파일에 두면 재실행할 때마다 정본을 고쳐야
// 하고, 그러면 "지난주에는 실패했다"가 남지 않는다. 근거는 ADR-013의 후속 결정이다.
const SCENARIO_SECTION = '시나리오';
const CRITERIA_SECTION = '통과 기준';
// 시나리오 ID는 문서 밖에서 `TST-017#S-03` 형태로 참조된다. 문서 식별자가 앞에 붙으므로
// ID 자체에 문서 이름을 다시 넣을 필요는 없고, 구분자와 공백만 없으면 된다. 형식을 한
// 가지로 강제하지 않는 이유는 이미 쓰이는 규칙이 프로젝트마다 다르고, 참조에 필요한
// 성질은 통일성이 아니라 안정성과 유일성이기 때문이다.
const SCENARIO_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;
const SCENARIO_ID_MAX = 32;
const CHECKBOX_PATTERN = /^\s*[-*]\s+\[[ xX]\]/u;
const SEPARATOR_PATTERN = /^\|[\s:|-]+\|$/u;

function tableCells(row) {
  return row.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
}

function scenarioTable(section) {
  const lines = String(section || '').split('\n').map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith('|'));
  if (start < 0) return null;
  const rows = [];
  for (let index = start; index < lines.length && lines[index].startsWith('|'); index += 1) rows.push(lines[index]);
  if (rows.length < 3 || !SEPARATOR_PATTERN.test(rows[1])) return null;
  return { header: tableCells(rows[0]), data: rows.slice(2).map(tableCells) };
}

function validateScenarioTable(section, issues, severity) {
  const table = scenarioTable(section);
  if (!table) {
    issues.push({
      code: 'RDL-SCENARIO-001', severity, target: SCENARIO_SECTION,
      message: `'${SCENARIO_SECTION}' 섹션은 첫 열이 ID인 표여야 합니다. 목록으로 적은 시나리오는 문서 밖에서 가리킬 수 없어 실행 기록이 결과를 붙일 자리가 없습니다.`
    });
    return;
  }
  const seen = new Map();
  table.data.forEach((row, index) => {
    const line = index + 1;
    const id = row[0] || '';
    if (!id || id.length > SCENARIO_ID_MAX || !SCENARIO_ID_PATTERN.test(id)) {
      issues.push({
        code: 'RDL-SCENARIO-002', severity, target: id || `${line}행`,
        message: `시나리오 ID가 참조할 수 있는 형식이 아닙니다: ${id ? `'${id}'` : `${line}행이 비었습니다`} (영문자로 시작하고 공백 없이 ${SCENARIO_ID_MAX}자 이내)`
      });
      return;
    }
    if (seen.has(id)) {
      issues.push({
        code: 'RDL-SCENARIO-003', severity, target: id,
        message: `시나리오 ID가 문서 안에서 중복됩니다: ${id} (${seen.get(id)}행에 이미 있음)`
      });
      return;
    }
    seen.set(id, line);
  });
}

function validateTestDocument(type, source, artifactId, options) {
  if (String(type || '').toUpperCase() !== 'TST') return [];
  const severity = (options && options.implementation) ? 'error' : 'warning';
  const issues = [];
  // 섹션 이름은 프로젝트가 board.json에서 바꿀 수 있다. 없는 섹션을 요구하면 이름을 바꾼
  // 팀에게 거짓 위반이 되므로, 여기서는 있는 섹션의 모양만 본다.
  const scenarios = sectionBody(source, SCENARIO_SECTION);
  if (scenarios !== null) validateScenarioTable(scenarios, issues, severity);
  const criteria = sectionBody(source, CRITERIA_SECTION);
  if (criteria !== null) {
    const boxes = criteria.split('\n').filter((line) => CHECKBOX_PATTERN.test(line)).length;
    if (boxes > 0) issues.push({
      code: 'RDL-SCENARIO-004', severity, target: CRITERIA_SECTION,
      message: `'${CRITERIA_SECTION}' 섹션이 실행 결과를 담고 있습니다: 체크박스 ${boxes}개. 통과 기준은 무엇이 참이어야 하는지를 적고, 실제로 통과했는지는 실행 기록이 답합니다.`
    });
  }
  return issues.map((issue) => Object.assign({ artifactId: artifactId || null }, issue));
}

module.exports = { SCENARIO_SECTION, CRITERIA_SECTION, SCENARIO_ID_PATTERN, scenarioTable, validateTestDocument };
