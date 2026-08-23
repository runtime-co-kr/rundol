'use strict';

// 진단과 그 근거를 잇는 방향. 예전에는 제품이 진단 코드마다 런돌 요구 문서 번호를
// 들고 있었고 그것이 rdl check --json으로 남의 저장소까지 나갔다 — 그 저장소에 없는
// 문서를 가리키는 근거였다. 이제 문서가 자기 소관 진단을 선언하고 조회는 그 선언을
// 모은다. 그래서 이 시험이 지키는 것은 둘이다: 모은 답이 맞는가, 그리고 제품이 다시
// 남의 문서 번호를 알게 되지 않았는가.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DECLARATION_KEY, CODE_PATTERN, declaredCodes, collectDeclarations, ruleSource, codesForDocument, coverage
} = require('../src/diagnostic-rules');
const { diagnostic } = require('../src/check-rules');
const { parseFrontmatter } = require('../src/frontmatter');

const sourceRoot = path.resolve(__dirname, '..', 'src');

// ── 선언 형식 ────────────────────────────────────────────────────────────────

assert.strictEqual(DECLARATION_KEY, 'diagnostics', '선언 칸 이름은 문서 쪽 도구와 함께 쓰는 계약이다.');
assert(CODE_PATTERN.test('RDL-ASSET-005'));
assert(CODE_PATTERN.test('RDL-VERDICT-015'));
assert(!CODE_PATTERN.test('REQ-053'), '문서 번호를 진단 코드로 받아들이면 이름공간이 다시 섞인다.');
assert(!CODE_PATTERN.test('RDL-ASSET-5'), '자리수가 다른 것은 이 제품이 내는 코드가 아니다.');

// 형식이 틀린 값을 조용히 버리면 오타 하나가 "이 문서는 아무 진단도 근거 짓지 않는다"로
// 보이고, 그건 선언이 아예 없는 것과 구별되지 않는다.
assert.deepStrictEqual(
  declaredCodes({ diagnostics: ['RDL-ASSET-005', ' RDL-ASSET-002 ', 'RDL-ASSET-002', 'ASSET-9', ''] }),
  { codes: ['RDL-ASSET-002', 'RDL-ASSET-005'], invalid: ['ASSET-9'] }
);
assert.deepStrictEqual(declaredCodes({}), { codes: [], invalid: [] });
assert.deepStrictEqual(declaredCodes(null), { codes: [], invalid: [] });
assert.deepStrictEqual(declaredCodes({ diagnostics: 'RDL-ASSET-005' }), { codes: [], invalid: [] },
  '목록이 아닌 값을 목록처럼 읽으면 문자 하나씩을 코드로 센다.');

// ── 선언을 모은다 ────────────────────────────────────────────────────────────

const index = collectDeclarations([
  { id: 'DOC-A', meta: { functionIds: ['FN-002'], diagnostics: ['RDL-ASSET-005', 'RDL-ASSET-002'] } },
  { id: 'DOC-B', meta: { functionIds: ['FN-001'], diagnostics: ['RDL-ASSET-001'] } },
  { id: 'DOC-C', meta: { functionIds: ['FN-001'], diagnostics: ['RDL-ASSET-001', '아무거나'] } },
  { id: 'DOC-D', meta: { functionIds: ['FN-001'] } },
  { id: '', meta: { diagnostics: ['RDL-ASSET-009'] } },
  null
]);

// 기능은 선언한 문서에서 파생한다. 선언에 기능 ID를 또 적으면 같은 값이 두 곳에 살고,
// 한쪽만 고쳐지는 날 어느 쪽이 정본인지 말할 근거가 없다.
//
// 파생할 때 부모를 단다. 답은 그 문서 밖으로 나가고, 문서 안 표기는 문서를 떠나는
// 순간 어느 문서의 몇 번인지를 잃는다 — DOC-B와 DOC-C의 FN-001은 다른 기능이다.
assert.deepStrictEqual(ruleSource(index, 'RDL-ASSET-005'), { document: 'DOC-A', functionIds: ['DOC-A#FN-002'] });
assert.deepStrictEqual(ruleSource(index, 'RDL-ASSET-002'), { document: 'DOC-A', functionIds: ['DOC-A#FN-002'] });

// 두 문서가 같은 코드를 선언하면 이긴 쪽을 고르지 않는다. 디렉터리를 읽는 순서가 답을
// 정하는 조회는 추적성이 아니라 추적성처럼 보이는 것이다.
assert.strictEqual(ruleSource(index, 'RDL-ASSET-001'), null, '소관이 갈린 코드에 근거를 지어내면 안 된다.');
assert.deepStrictEqual(index.conflicts, [{ code: 'RDL-ASSET-001', documents: ['DOC-B', 'DOC-C'] }]);

// 어긋난 선언은 값으로 돌려준다. 어느 심각도로 어느 표면에서 알릴지는 이 조회를
// 명령줄에 잇는 쪽이 정할 일이다.
assert.deepStrictEqual(index.malformed, [{ document: 'DOC-C', codes: ['아무거나'] }]);

// 모르는 코드에 근거를 붙이지 않는다 — 틀린 근거는 근거가 없는 것보다 나쁘다.
assert.strictEqual(ruleSource(index, 'RDL-TASK-019'), null);
assert.strictEqual(ruleSource(index, undefined), null);
assert.strictEqual(ruleSource(null, 'RDL-ASSET-005'), null);

// 역방향. 요구를 고칠 때 어떤 검사가 흔들리는지 알 수 있어야 한다. 이 방향이 없으면
// 문서만 고치고 검사는 그대로 남는다.
assert.deepStrictEqual(codesForDocument(index, 'DOC-A'), ['RDL-ASSET-002', 'RDL-ASSET-005']);
assert.deepStrictEqual(codesForDocument(index, 'DOC-D'), [], '선언하지 않은 문서는 빈 목록이다.');
assert.deepStrictEqual(codesForDocument(index, 'DOC-없음'), []);
codesForDocument(index, 'DOC-A').push('RDL-오염-001');
assert.deepStrictEqual(codesForDocument(index, 'DOC-A'), ['RDL-ASSET-002', 'RDL-ASSET-005'],
  '돌려준 목록을 고쳐 색인이 바뀌면 조회한 순서에 따라 답이 달라진다.');

// 누구의 선언인지 모르는 선언은 역방향으로 쓸 수 없으므로 세지 않는다.
assert.strictEqual(ruleSource(index, 'RDL-ASSET-009'), null);

// ── 진단은 문서 번호를 나르지 않는다 ─────────────────────────────────────────

const list = [];
diagnostic(list, { code: 'RDL-IMPL-018', message: '시험' });
assert.strictEqual('rule' in list[0], false, '진단에 정본 문서가 다시 붙었습니다. 남의 저장소로 나갑니다.');
assert.strictEqual(list[0].code, 'RDL-IMPL-018');
assert.strictEqual(list[0].severity, 'error');
assert.strictEqual(list[0].category, 'metadata');
assert.strictEqual(list[0].line, 1);

// 제품 코드가 값으로 문서 번호를 들고 있지 않다. 무엇이 왜 사라졌는지 설명하는 글에는
// 남아도 되지만, 판정에 쓰이는 자리로 한 줄이라도 되돌아오면 같은 것이 다시 나간다.
{
  const DOC_ID = /(?<!RDL-)\b(REQ|TST|ADR|ARC|MOD|IFC|GLS|SCR|STD|NTE)-\d{3,}\b/u;
  const lines = fs.readFileSync(path.join(sourceRoot, 'diagnostic-rules.js'), 'utf8').split(/\r?\n/);
  let block = false;
  lines.forEach((line, offset) => {
    const text = line.trim();
    if (text.startsWith('/*')) block = true;
    const comment = block || text.startsWith('//') || text.startsWith('*');
    if (text.includes('*/')) block = false;
    if (comment) return;
    assert(!DOC_ID.test(line), `diagnostic-rules.js:${offset + 1}에 문서 번호가 값으로 남았습니다: ${text}`);
  });
}

// ── 남은 크기 ────────────────────────────────────────────────────────────────

// 남은 크기를 모르면 "이제 됐다"고 착각한다. 진단 코드는 제품이 세고, 그중 몇 개가
// 근거를 얻었는지는 문서 선언을 읽어야 안다.
const allCodes = fs.readdirSync(sourceRoot)
  .filter((file) => file.endsWith('.js'))
  .flatMap((file) => (fs.readFileSync(path.join(sourceRoot, file), 'utf8').match(/'RDL-[A-Z]+-\d+'/gu) || []))
  .map((quoted) => quoted.slice(1, -1));

const docsRoot = path.resolve(__dirname, '..', 'projects', 'rundol', 'docs');
const documents = [];
if (fs.existsSync(docsRoot)) {
  for (const directory of fs.readdirSync(docsRoot)) {
    const full = path.join(docsRoot, directory);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.md')) continue;
      const parsed = parseFrontmatter(fs.readFileSync(path.join(full, file), 'utf8'));
      if (parsed && parsed.data && parsed.data.id) documents.push({ id: String(parsed.data.id), meta: parsed.data });
    }
  }
}

const declarations = collectDeclarations(documents);
const measured = coverage(declarations, allCodes);
assert(measured.total > 200, `진단 코드 수가 예상보다 적습니다: ${measured.total}`);
assert.strictEqual(measured.declared + measured.undeclared.length, measured.total, '센 것과 남은 것의 합이 전체여야 한다.');
assert.deepStrictEqual(declarations.conflicts, [],
  `한 진단을 두 문서가 근거 짓고 있습니다: ${JSON.stringify(declarations.conflicts)}`);
assert.deepStrictEqual(declarations.malformed, [],
  `문서 선언에 진단 코드가 아닌 값이 있습니다: ${JSON.stringify(declarations.malformed)}`);

// 문서가 선언한 코드는 제품이 실제로 내는 코드여야 한다. 없는 코드를 선언하면 그 문서는
// 아무것도 근거 짓지 않으면서 근거 짓는 것처럼 보인다.
for (const [id, codes] of Object.entries(declarations.byDocument)) {
  for (const code of codes) {
    assert(allCodes.includes(code), `${id}이 제품이 내지 않는 진단을 선언합니다: ${code}`);
  }
}

process.stdout.write(`diagnostic rule tests passed (${measured.declared}/${measured.total} 선언 · 문서 ${documents.length}건)\n`);

// 진단이 무엇이 없는지만 말하면 사람은 무엇을 붙여야 하는지를 다시 조사해야 한다.
// 실측에서 태스크 하나를 닫는 데 드는 왕복의 상당수가 그 조사였고, 어느 문서가 그
// 기능을 덮는지는 이미 계산되는 값이므로 진단이 함께 들고 나가야 한다.
//
// 이 안내는 위에서 걷어낸 지도와 다르다. 지도는 제품이 남의 문서 번호를 미리 알고
// 있는 것이었고, 이것은 그 저장소를 읽어 그 자리에서 계산한 그 저장소의 문서다.
{
  const { validateTaskImplementationReadiness } = require('../src/implementation-contract');
  const coverage = { 'REQ-048#FN-001': { REQ: ['REQ-048'], TST: ['TST-020'] } };

  function frontmatter(id, ids) {
    return { data: { id, implementationContract: 'atomic-v1', functionIds: ids }, body: '', bodyStartLine: 1 };
  }

  // TST만 연결한 태스크: 어느 REQ가 그 기능을 덮는지 알려야 한다.
  const missingReq = validateTaskImplementationReadiness(
    [{ id: 'TST-020', source: '', frontmatter: frontmatter('TST-020', ['REQ-048#FN-001']) }],
    { coverage }
  );
  const req = missingReq.find((item) => item.code === 'RDL-IMPL-020');
  assert(req, 'REQ 누락을 진단해야 합니다.');
  assert(req.message.includes('REQ-048'), `어느 REQ가 덮는지 알려야 합니다: ${req.message}`);

  // REQ만 연결한 태스크: 어느 TST가 그 기능을 검증하는지 알려야 한다.
  const missingTst = validateTaskImplementationReadiness(
    [{ id: 'REQ-048', source: '', frontmatter: frontmatter('REQ-048', ['FN-001']) }],
    { coverage }
  );
  const tst = missingTst.find((item) => item.code === 'RDL-IMPL-021');
  assert(tst, 'TST 누락을 진단해야 합니다.');
  assert(tst.message.includes('TST-020'), `어느 TST가 덮는지 알려야 합니다: ${tst.message}`);

  // 덮는 문서를 모르면 추측하지 않는다. 없는 안내를 붙이면 사람이 그것을 찾으러 간다.
  const unknown = validateTaskImplementationReadiness(
    [{ id: 'TST-020', source: '', frontmatter: frontmatter('TST-020', ['REQ-999#FN-001']) }],
    { coverage }
  );
  const silent = unknown.find((item) => item.code === 'RDL-IMPL-020');
  assert(!silent.message.includes('덮는 문서'), `모르는 기능에 안내를 지어내면 안 됩니다: ${silent.message}`);

  // coverage를 주지 않으면 예전 그대로 동작한다. 안내는 덧붙임이지 계약 변경이 아니다.
  const bare = validateTaskImplementationReadiness([{ id: 'TST-020', source: '', frontmatter: frontmatter('TST-020', ['REQ-048#FN-001']) }]);
  assert(bare.some((item) => item.code === 'RDL-IMPL-020'), '안내 없이도 진단은 나와야 합니다.');
}
