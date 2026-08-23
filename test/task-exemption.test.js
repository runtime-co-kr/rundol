'use strict';

// 완료 게이트의 면제. 닫히지 않는 태스크를 사람이 사유를 대고 닫는 자리다.
//
// 판정만 시험한다. CLI를 띄우지 않는 이유는 여기서 물을 것이 값을 보고 나오는 답뿐이기
// 때문이고, 프로세스를 띄우는 시험은 같은 답을 훨씬 비싸게 얻는다.

const assert = require('assert');
const { assertExemptionConsistency } = require('../src/tasks');
const { DEFAULT_TASK_GATES } = require('../src/check-rules');
const { EXEMPTABLE_GATES } = require('../src/vocabulary');

const GATE = 'done-requires-test-link';
const gate = DEFAULT_TASK_GATES[GATE];

function exemption(overrides) {
  return Object.assign({
    gate: GATE,
    reason: '편집기 검증 문서가 아직 없다.',
    decidedBy: 'MEMBER-001',
    at: '2026-08-23T00:00:00.000Z'
  }, overrides || {});
}

// ── 저장 계층의 불변식 ────────────────────────────────────────────────────

assert.doesNotThrow(() => assertExemptionConsistency(null, { status: 'done', exemption: exemption() }), '갖춰진 면제는 받는다');
assert.doesNotThrow(() => assertExemptionConsistency({ status: 'doing' }, {}), '면제가 없으면 볼 것이 없다');

// 면제는 완료를 위한 것이다. 다른 상태에 남겨 두면 무엇을 면제한 것인지가 사라지고,
// 되살아난 태스크가 옛 사유를 들고 다시 닫힌다.
assert.throws(
  () => assertExemptionConsistency(null, { status: 'doing', exemption: exemption() }),
  /완료 상태가 아닌 태스크에는 게이트 면제를 둘 수 없습니다/u,
  '진행 중인 태스크에는 면제를 둘 수 없다'
);

// 허용 목록 밖의 게이트는 거절한다. 되돌릴 수 없는 관문은 그 목록에 없으며, 그것이
// 면제가 경계를 여는 수단이 되지 않게 하는 유일한 장치다.
assert.throws(
  () => assertExemptionConsistency(null, { status: 'done', exemption: exemption({ gate: 'no-such-gate' }) }),
  /면제할 수 없는 게이트입니다/u,
  '목록 밖 게이트는 면제할 수 없다'
);
assert.ok(EXEMPTABLE_GATES.includes(GATE), '이 시험이 보는 게이트는 허용 목록 안이다');

// 사유와 결정자를 강제하지 않으면 면제가 완료 게이트를 우회하는 조용한 통로가 된다.
for (const [field, label] of [['reason', '면제 사유'], ['decidedBy', '결정자'], ['at', '결정 시각']]) {
  assert.throws(
    () => assertExemptionConsistency(null, { status: 'done', exemption: exemption({ [field]: '' }) }),
    new RegExp(`${label}가 필요합니다`, 'u'),
    `${label}가 없으면 면제되지 않는다`
  );
  assert.throws(
    () => assertExemptionConsistency(null, { status: 'done', exemption: exemption({ [field]: '   ' }) }),
    new RegExp(`${label}가 필요합니다`, 'u'),
    `공백만 있는 ${label}는 없는 것과 같다`
  );
}

// ── 게이트 판정 ───────────────────────────────────────────────────────────

assert.deepStrictEqual(gate({ status: 'doing', links: [] }), [], '완료가 아니면 묻지 않는다');
assert.deepStrictEqual(gate({ status: 'done', links: ['TST-001'] }), [], '연결이 있으면 지난다');

const unlinked = gate({ status: 'done', links: [] });
assert.strictEqual(unlinked.length, 1, '연결도 면제도 없으면 막는다');
assert.strictEqual(unlinked[0].code, 'RDL-TASK-019');

assert.deepStrictEqual(gate({ status: 'done', links: [], exemption: exemption() }), [], '면제한 게이트는 판정하지 않는다');

// 면제는 지목한 게이트 하나에만 걸린다. 이름이 다르면 남의 면제이고, 그것으로 이
// 게이트가 열리면 면제 하나가 목록 전체를 여는 열쇠가 된다.
assert.strictEqual(
  gate({ status: 'done', links: [], exemption: exemption({ gate: 'implementation-readiness' }) }).length,
  1,
  '다른 게이트의 면제로는 열리지 않는다'
);

// 사유 없는 면제는 면제가 아니다. 저장 계층이 막지만 판정도 같은 답을 내야 한다 —
// 두 층이 다르게 답하면 어느 쪽이 사실인지 다투게 된다.
assert.strictEqual(
  gate({ status: 'done', links: [], exemption: exemption({ reason: '' }) }).length,
  1,
  '사유 없는 면제는 판정을 열지 않는다'
);

console.log('task exemption tests passed');
