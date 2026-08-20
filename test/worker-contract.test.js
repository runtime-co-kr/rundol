'use strict';

// 워커 계약 판정부의 동작 시험. TST-020(WRK-01 겹침·필수 항목)과
// TST-022(WRK-03 검수 판정)의 단위·속성 수준을 담는다.

const assert = require('assert');
const {
  matchesPath, patternsOverlap, assignmentOverlaps, missingAssignmentFields,
  unclaimedAcceptance, acceptReport, verifyReport, ContractViolation
} = require('../src/worker-contract');

const DIGEST = 'a'.repeat(64);

function assignment(overrides) {
  return Object.assign({
    id: 'ASG-001',
    goal: '검색이 제목과 본문을 모두 찾는다',
    acceptance: [
      { id: 'AC-001', text: '제목으로 찾는다' },
      { id: 'AC-002', text: '본문으로 찾는다' }
    ],
    functionIds: ['WRK-01'],
    allowedPaths: ['src/search/**', 'test/search/**'],
    forbidden: ['인덱스 스키마 변경'],
    procedure: { name: 'impl', revision: 3, digest: DIGEST },
    reportSchema: 'report-v1',
    assignee: { kind: 'agent', id: 'claude-code' },
    state: 'open'
  }, overrides);
}

function report(overrides) {
  return Object.assign({
    id: 'RPT-001',
    assignmentId: 'ASG-001',
    worker: { kind: 'agent', id: 'claude-code' },
    schema: 'report-v1',
    outcome: 'done',
    claims: [
      { id: 'AC-001', met: true, evidence: 'test:search.test.js#title' },
      { id: 'AC-002', met: true, evidence: 'test:search.test.js#body' }
    ],
    changed: ['src/search/query.js'],
    procedureDigest: DIGEST
  }, overrides);
}

// ── 경로 패턴 ────────────────────────────────────────────────────────────

assert.strictEqual(matchesPath('src/search/**', 'src/search/query.js'), true);
assert.strictEqual(matchesPath('src/search/**', 'src/search/deep/nested.js'), true);
assert.strictEqual(matchesPath('src/search/**', 'src/other/query.js'), false);
// `*`가 구분자를 넘으면 범위 판정이 실제보다 넓어진다.
assert.strictEqual(matchesPath('src/*.js', 'src/a.js'), true);
assert.strictEqual(matchesPath('src/*.js', 'src/nested/a.js'), false);
assert.strictEqual(matchesPath('src/search/query.js', 'src/search/query.js'), true);

assert.strictEqual(patternsOverlap('src/search/**', 'src/search/**'), true);
assert.strictEqual(patternsOverlap('src/search/**', 'src/search/deep/**'), true);
assert.strictEqual(patternsOverlap('src/search/**', 'src/board/**'), false);

// ── 겹침 계산 ────────────────────────────────────────────────────────────

const openOther = assignment({ id: 'ASG-002', allowedPaths: ['src/search/**'] });
assert.deepStrictEqual(
  assignmentOverlaps(['src/search/query/**'], [openOther]),
  [{ assignmentId: 'ASG-002', paths: ['src/search/**'] }]
);
assert.deepStrictEqual(assignmentOverlaps(['src/board/**'], [openOther]), []);
// 닫힌 할당은 겹침 대상이 아니다. 닫힌 것까지 세면 경로가 영원히 잠긴다.
assert.deepStrictEqual(assignmentOverlaps(['src/search/**'], [assignment({ id: 'ASG-003', state: 'closed' })]), []);
// 겹친 패턴을 모두 돌려주어야 통제자가 어디를 좁힐지 안다.
const wide = assignment({ id: 'ASG-004', allowedPaths: ['src/search/**', 'src/search/index/**'] });
assert.strictEqual(assignmentOverlaps(['src/search/**'], [wide])[0].paths.length, 2);

// ── 필수 항목 ────────────────────────────────────────────────────────────

assert.deepStrictEqual(missingAssignmentFields(assignment()), []);
assert.deepStrictEqual(missingAssignmentFields(assignment({ functionIds: [] })), ['functionIds']);
// 첫 항목에서 멈추면 워커가 왕복을 여러 번 한다.
assert.deepStrictEqual(missingAssignmentFields(assignment({ goal: '  ', functionIds: [] })), ['goal', 'functionIds']);
// forbidden은 비어도 되지만 존재는 해야 한다.
assert.deepStrictEqual(missingAssignmentFields(assignment({ forbidden: [] })), []);
assert.deepStrictEqual(missingAssignmentFields(assignment({ forbidden: undefined })), ['forbidden']);

// ── 접수 판정 ────────────────────────────────────────────────────────────

assert.deepStrictEqual(unclaimedAcceptance(assignment(), report()), []);
assert.deepStrictEqual(
  unclaimedAcceptance(assignment(), report({ claims: [{ id: 'AC-001', met: true, evidence: 'x' }] })),
  ['AC-002']
);

// ── 검수 판정 ────────────────────────────────────────────────────────────

assert.deepStrictEqual(verifyReport(assignment(), report()), { decision: 'pass', blocks: [], humanReasons: [] });

const unmet = verifyReport(assignment(), report({
  claims: [{ id: 'AC-001', met: false, evidence: '' }, { id: 'AC-002', met: true, evidence: 'e' }]
}));
assert.strictEqual(unmet.decision, 'reject');
assert.deepStrictEqual(unmet.blocks, [{ code: 'unmet-acceptance', target: 'AC-001' }]);

// 선언만으로 충족을 인정하지 않는다.
const noEvidence = verifyReport(assignment(), report({
  claims: [{ id: 'AC-001', met: true, evidence: '' }, { id: 'AC-002', met: true, evidence: 'e' }]
}));
assert.deepStrictEqual(noEvidence.blocks, [{ code: 'missing-evidence', target: 'AC-001' }]);

const outOfScope = verifyReport(assignment(), report({ changed: ['src/search/query.js', 'src/board/ui.js'] }));
assert.strictEqual(outOfScope.decision, 'reject');
assert.deepStrictEqual(outOfScope.blocks, [{ code: 'path-out-of-scope', target: 'src/board/ui.js' }]);

const forbidden = verifyReport(assignment(), report({ forbiddenTouched: ['인덱스 스키마 변경'] }));
assert.deepStrictEqual(forbidden.blocks, [{ code: 'forbidden-touched', target: '인덱스 스키마 변경' }]);

// 차단은 실패가 아니라 사람이 판단할 일이다.
const blocked = verifyReport(assignment(), report({ outcome: 'blocked', reason: '외부 응답 없음' }));
assert.strictEqual(blocked.decision, 'needs-human');
assert.deepStrictEqual(blocked.humanReasons, [{ code: 'worker-blocked', detail: '외부 응답 없음' }]);

// 다른 절차로 실행된 결과의 인정 여부는 기계가 정하지 않는다.
const mismatch = verifyReport(assignment(), report({ procedureDigest: 'b'.repeat(64) }));
assert.strictEqual(mismatch.decision, 'needs-human');
assert.strictEqual(mismatch.humanReasons[0].code, 'procedure-mismatch');
assert.strictEqual(mismatch.humanReasons[0].expectedDigest, DIGEST);
assert.strictEqual(mismatch.humanReasons[0].actualDigest, 'b'.repeat(64));

// 반려가 사람 판단보다 앞선다. 기계가 답할 수 있는 질문을 사람에게 넘기지 않는다.
const both = verifyReport(assignment(), report({
  outcome: 'blocked',
  reason: '막힘',
  claims: [{ id: 'AC-001', met: false, evidence: '' }, { id: 'AC-002', met: true, evidence: 'e' }]
}));
assert.strictEqual(both.decision, 'reject');
assert.strictEqual(both.humanReasons.length, 1);

// ── 결정성 ───────────────────────────────────────────────────────────────

const first = JSON.stringify(verifyReport(assignment(), report()));
for (let index = 0; index < 100; index += 1) {
  assert.strictEqual(JSON.stringify(verifyReport(assignment(), report())), first);
}
// 보고가 수용 조건을 어떤 순서로 담든 판정 결과의 순서가 흔들리면 안 된다.
const reversed = report({ claims: report().claims.slice().reverse() });
assert.strictEqual(JSON.stringify(verifyReport(assignment(), reversed)), first);
// 환경 변수와 시각이 판정을 바꾸지 않는다.
process.env.RUNDOL_PURITY_PROBE = String(Date.now());
assert.strictEqual(JSON.stringify(verifyReport(assignment(), report())), first);
delete process.env.RUNDOL_PURITY_PROBE;

// ── 계약 위반은 판정 구분으로 섞지 않는다 ────────────────────────────────

assert.throws(() => verifyReport(assignment({ acceptance: [] }), report()), ContractViolation);
assert.throws(
  () => verifyReport(assignment(), report({ claims: [{ id: 'AC-001', met: true, evidence: 'e' }] })),
  (error) => error instanceof ContractViolation && error.message.includes('AC-002')
);
assert.throws(() => verifyReport(null, report()), ContractViolation);

// ── 접수 계약 ────────────────────────────────────────────────────────────
//
// 접수는 "이 보고를 이 할당에 대해 판정할 수 있는가"를 묻고, 검수는 "판정해 보니
// 통과인가"를 묻는다. 둘을 같은 값으로 뭉개면 보고를 잘못 만든 것과 일을 통과시키지
// 못한 것이 구분되지 않고, 그러면 워커 종류별 형식 위반율을 잴 수 없다.

// 계약을 갖춘 보고는 거부 사유가 없다.
assert.strictEqual(acceptReport(assignment(), report()), null);

function rejects(overrides, code, extra) {
  const verdict = acceptReport(assignment(extra && extra.assignment), report(overrides));
  assert(verdict, `거부를 기대했는데 접수되었습니다: ${code}`);
  assert.strictEqual(verdict.code, code);
  return verdict;
}

// 필수 항목이 빠지면 하나씩이 아니라 전부 돌려준다. 하나씩 알려주면 워커가 왕복을
// 여러 번 한다.
const missing = rejects({ id: '', procedureDigest: '' }, 'missing-field');
assert.deepStrictEqual(missing.missing, ['id', 'procedureDigest']);
// changed는 비어 있어도 되지만 없으면 안 된다. 막혀서 아무것도 못 바꾼 보고가
// 정상이기 때문이며, 그것과 "무엇을 바꿨는지 말하지 않음"은 다르다.
assert.strictEqual(acceptReport(assignment(), report({ changed: [] })), null);
assert.deepStrictEqual(rejects({ changed: undefined }, 'missing-field').missing, ['changed']);
// 보고가 따른 스키마를 밝히지 않으면 접수하지 않는다. 밝히지 않으면 할당의
// reportSchema는 아무도 읽지 않는 필수 항목이 된다.
assert.deepStrictEqual(rejects({ schema: '' }, 'missing-field').missing, ['schema']);

// 다른 할당을 향한 보고로 이 할당을 닫을 수 없다.
rejects({ assignmentId: 'ASG-999' }, 'wrong-assignment');
// 닫힌 할당에는 접수하지 않는다.
rejects({}, 'assignment-closed', { assignment: { state: 'closed' } });
// 할당받지 않은 워커의 보고는 접수하지 않는다. 식별자가 같아도 종류가 다르면
// 다른 워커다 — 사람 MEMBER-001과 에이전트 MEMBER-001은 같은 주체가 아니다.
rejects({ worker: { kind: 'agent', id: 'other-agent' } }, 'not-assignee');
rejects({ worker: { kind: 'human', id: 'claude-code' } }, 'not-assignee');
// 할당이 고정한 스키마와 다른 것을 따랐으면 접수하지 않는다. 이름만 같고 뜻이
// 다른 필드를 판정하면 조용히 틀린다.
rejects({ schema: 'report-v2' }, 'schema-mismatch');
// 차단과 반려는 사람에게 넘기는 결과이므로 사유 없이 넘길 수 없다.
rejects({ outcome: 'blocked' }, 'missing-reason');
rejects({ outcome: 'rejected' }, 'missing-reason');
assert.strictEqual(acceptReport(assignment(), report({ outcome: 'blocked', reason: '외부 API가 응답하지 않습니다.' })), null);
// 침묵으로 충족을 주장할 수 없다.
assert.deepStrictEqual(
  rejects({ claims: [{ id: 'AC-001', met: true, evidence: 'e' }] }, 'unclaimed-acceptance').unclaimed,
  ['AC-002']
);

// 순수 함수다. 같은 입력이면 같은 답이고 입력을 바꾸지 않는다.
{
  const target = assignment();
  const submitted = report({ schema: 'report-v2' });
  const frozen = JSON.stringify([target, submitted]);
  const once = JSON.stringify(acceptReport(target, submitted));
  assert.strictEqual(JSON.stringify(acceptReport(target, submitted)), once);
  assert.strictEqual(JSON.stringify([target, submitted]), frozen, '접수 판정이 입력을 바꿨습니다.');
}

// 검수는 접수를 통과한 보고만 받는다. 접수에서 걸릴 보고를 검수가 판정하면
// 계약 결함이 반려로 위장된다.
for (const broken of [{ assignmentId: 'ASG-999' }, { schema: 'report-v2' }, { worker: { kind: 'human', id: 'x' } }]) {
  assert.throws(() => verifyReport(assignment(), report(broken)), ContractViolation);
}

process.stdout.write('worker contract tests passed\n');
