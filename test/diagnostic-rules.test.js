'use strict';

// 진단에서 규칙의 정본 문서로 가는 링크. 추적성을 계산으로 유지한다면서 정작
// 규칙에서 근거로 가는 방향이 비어 있었다.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RULES, ruleSource, codesForDocument, coverage } = require('../src/diagnostic-rules');
const { diagnostic } = require('../src/check-rules');

const sourceRoot = path.resolve(__dirname, '..', 'src');

// 정본 문서를 아는 코드는 붙이고, 모르는 코드는 붙이지 않는다. 추측해서 붙이면
// 근거가 없는 것보다 나쁘다 — 틀린 근거를 보고 엉뚱한 문서를 고치게 된다.
assert.deepStrictEqual(ruleSource('RDL-IMPL-018'), { document: 'REQ-034', functionId: 'HRN-02' });
assert.deepStrictEqual(ruleSource('RDL-IMPL-012'), { document: 'REQ-036', functionId: 'HRN-04' });
assert.deepStrictEqual(ruleSource('RDL-PROFILE-002'), { document: 'REQ-026', functionId: 'DCP-02' });
assert.deepStrictEqual(ruleSource('RDL-TASK-019'), { document: 'REQ-018', functionId: 'TSK-02' });
// 같은 계열 안에서도 소관이 갈린다. 생성·전환·결박을 한 문서로 뭉치면 역방향
// 계산이 "이 요구를 고치면 태스크 진단 전부가 흔들린다"는 쓸모없는 답을 낸다.
assert.deepStrictEqual(ruleSource('RDL-TASK-002'), { document: 'REQ-017', functionId: 'TSK-01' });
assert.deepStrictEqual(ruleSource('RDL-TASK-034'), { document: 'REQ-046', functionId: 'TSK-04' });
assert.deepStrictEqual(ruleSource('RDL-DEC-021'), { document: 'REQ-040', functionId: 'DEC-02' });
assert.deepStrictEqual(ruleSource('RDL-DEC-010'), { document: 'REQ-039', functionId: 'DEC-01' });
// 소관을 확인하지 못한 것은 비워 둔다. 테스트 태스크 계열이 지금 그 자리다.
assert.strictEqual(ruleSource('RDL-TASK-028'), null);
assert.strictEqual(ruleSource('없는코드'), null);
assert.strictEqual(ruleSource(undefined), null);

// 역방향. 요구를 고칠 때 어떤 검사가 흔들리는지 계산할 수 있어야 한다. 이 방향이
// 없으면 문서만 고치고 검사는 그대로 남는다.
const impl = codesForDocument('REQ-034');
assert(impl.includes('RDL-IMPL-018'));
assert(!impl.includes('RDL-IMPL-012'), 'REQ-036 소관 코드가 REQ-034에 섞였습니다.');
assert.deepStrictEqual(impl, impl.slice().sort(), '역방향 결과는 정렬되어야 재현 가능하다.');
assert.deepStrictEqual(codesForDocument('REQ-999'), []);

// 진단이 실제로 링크를 달고 나간다. 지도만 맞고 진단에 안 실리면 아무도 못 본다.
const list = [];
diagnostic(list, { code: 'RDL-IMPL-018', message: '시험' });
diagnostic(list, { code: 'RDL-LINK-001', message: '시험' });
assert.deepStrictEqual(list[0].rule, { document: 'REQ-034', functionId: 'HRN-02' });
assert.strictEqual('rule' in list[1], false, '정본을 모르는 코드에 빈 필드를 만들지 않는다.');

// 지도가 가리키는 문서가 실제로 존재해야 한다. 문서를 폐기했는데 지도가 남으면
// 진단이 없는 문서를 가리킨다.
const docsRoot = path.resolve(__dirname, '..', 'projects', 'rundol', 'docs');
if (fs.existsSync(docsRoot)) {
  const present = new Set();
  for (const directory of fs.readdirSync(docsRoot)) {
    const full = path.join(docsRoot, directory);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      const match = /^([A-Z]{3}-\d{3,})-/u.exec(file);
      if (match) present.add(match[1]);
    }
  }
  for (const [code, rule] of Object.entries(RULES)) {
    assert(present.has(rule.document), `${code}이 없는 문서를 가리킵니다: ${rule.document}`);
  }
}

// 덮인 범위를 세어 둔다. 남은 크기를 모르면 "이제 됐다"고 착각한다.
const allCodes = fs.readdirSync(sourceRoot)
  .filter((file) => file.endsWith('.js'))
  .flatMap((file) => (fs.readFileSync(path.join(sourceRoot, file), 'utf8').match(/'RDL-[A-Z]+-\d+'/gu) || []))
  .map((quoted) => quoted.slice(1, -1));

const measured = coverage(allCodes);
assert(measured.total > 200, `진단 코드 수가 예상보다 적습니다: ${measured.total}`);
assert(measured.mapped >= 125, `연결된 코드가 줄었습니다: ${measured.mapped}`);

// 소관이 확정된 계열은 빠짐없이 덮여야 한다. 한 계열 안에서 몇 개만 붙어 있으면
// 역방향 계산이 "이 요구가 영향을 주는 진단"을 실제보다 적게 답한다.
const SETTLED = /^RDL-(IMPL|PROFILE|DLG|VERDICT|BRANCH|PUSH|CLIENT|DEC|SCENARIO|SCREEN|MODEL)-/u;
for (const code of allCodes) {
  if (SETTLED.test(code)) assert(ruleSource(code), `소관이 확정된 계열인데 정본 문서가 없습니다: ${code}`);
}

// 폐기한 기능의 진단은 붙이지 않는다. 없어진 규칙에 근거를 달면 그 문서를 읽고
// 다시 살리려는 시도가 나온다.
for (const code of allCodes) {
  if (/^RDL-LEASE-/u.test(code)) assert.strictEqual(ruleSource(code), null, `폐기한 기능에 근거가 붙었습니다: ${code}`);
}

process.stdout.write(`diagnostic rule tests passed (${measured.mapped}/${measured.total} 연결)\n`);
