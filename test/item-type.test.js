'use strict';

// 업무 유형 정의의 저장 형태(TST-033)와 제약 판정(TST-034)의 검증.
//
// 두 목록은 시험이 다시 적지 않고 코드에서 가져온다. 다시 적으면 목록이 늘어날 때 새
// 항목이 검증되지 않은 채 남고, 그때 이 시험은 통과하지만 아무것도 증명하지 못한다.
// 경계 층 목록도 마찬가지로 코드에서 가져와, 그중 하나라도 면제 가능 목록에 들어오면
// 여기서 넘어지게 한다.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONSTRAINT_KINDS,
  DISPLAY_FIELDS,
  EXEMPTABLE_GATES,
  ITEM_DIAGNOSTICS,
  UNUSABLE_ITEM_TYPE,
  BUILTIN_ITEM_TYPES,
  normalizeItemTypes,
  mergeItemTypes,
  evaluateItemTypes
} = require('../src/item-type');
const { BOUNDARY_KEYS } = require('../src/board-presentation');
const { TASK_KINDS, TEST_RESULTS } = require('../src/tasks');

const FILE = 'projects/rundol/board.json';

function normalize(definitions, options) {
  return normalizeItemTypes(definitions, Object.assign({ file: FILE }, options));
}

function rejects(definitions, pattern, label) {
  assert.throws(() => normalize(definitions), (error) => pattern.test(error.message), `${label}: ${pattern.source}`);
}

// 정의 하나로 그 유형의 규칙을 다 말할 수 있어야 한다. 이 정의가 이 시험 전체의 기준선이다.
const REVIEW = {
  label: '검토',
  description: '남이 낸 것을 읽고 판정하는 일',
  order: 30,
  constraints: {
    fields: { verdict: { values: ['accept', 'reject'] } },
    requiresLink: { REQ: { min: 1, max: 2 } },
    exempt: ['implementation-readiness']
  }
};

// ---------------------------------------------------------------------------
// TST-033 정규화 구역
// ---------------------------------------------------------------------------

// RDLITEMSHAPE01 카탈로그 안의 제약만 있으면 정규화되고 표시 필드와 제약이 나뉜다.
{
  const normalized = normalize({ review: REVIEW });
  assert.deepStrictEqual(Object.keys(normalized), ['review']);
  const entry = normalized.review;
  assert.strictEqual(entry.id, 'review');
  assert.strictEqual(entry.label, '검토');
  assert.strictEqual(entry.order, 30);
  // 나뉘어 담긴다: 표시 필드는 항목에, 제약은 constraints 아래에.
  for (const field of DISPLAY_FIELDS) assert.strictEqual(field in entry.constraints, false, `표시 필드가 제약에 섞였습니다: ${field}`);
  for (const kind of Object.keys(entry.constraints)) assert(CONSTRAINT_KINDS.includes(kind), `카탈로그 밖의 종류가 담겼습니다: ${kind}`);
  assert.deepStrictEqual(entry.constraints.fields, { verdict: { values: ['accept', 'reject'] } });
  assert.deepStrictEqual(entry.constraints.requiresLink, { REQ: { min: 1, max: 2 } });
  // 같은 정의면 같은 결과다. 결과가 키 순서에 기대면 파일에 적은 순서가 판정을 바꾼다.
  assert.strictEqual(JSON.stringify(normalize({ review: REVIEW })), JSON.stringify(normalized));
}

// RDLITEMSHAPE02 카탈로그에 없는 제약 종류는 거부되고 종류 이름과 키 경로가 담긴다.
{
  const definitions = { review: { constraints: { requireLink: { REQ: { min: 1 } } } } };
  assert.throws(() => normalize(definitions), (error) => {
    assert(error.message.includes('requireLink'), `종류 이름이 없습니다: ${error.message}`);
    assert(error.message.includes('itemTypes.review.constraints.requireLink'), `키 경로가 없습니다: ${error.message}`);
    assert(error.message.includes(FILE), `파일 경로가 없습니다: ${error.message}`);
    return true;
  });
  // 무시하지 않는다. 무시하면 오타로 적은 제약이 조용히 적용되지 않는다.
  rejects({ review: { constraints: { fields: {}, unqiue: {} } } }, /카탈로그에 없는 제약 종류/u, '오타 종류');
  // 제약을 항목에 곧바로 적으면 이름이 맞는데 왜 거부되는지 알려 준다.
  rejects({ review: { fields: {} } }, /제약은 constraints 아래에 둡니다/u, '평평하게 적은 제약');
  rejects({ review: { colour: 'red' } }, /알 수 없는 키입니다/u, '알 수 없는 키');
}

// RDLITEMSHAPE03 파라미터가 조건식 형태면 거부되고 값과 이름만 받는다고 알린다.
{
  rejects(
    { review: { constraints: { unique: { slot: { fields: ['round'], releasedBy: [{ $ne: 'cancelled' }] } } } } },
    /값과 이름만 받습니다/u, '$ 연산자'
  );
  rejects(
    { review: { constraints: { requiredWhen: { verdict: { field: 'status', is: ['>= done'] } } } } },
    /값과 이름만 받습니다/u, '비교 연산자 문자열'
  );
  rejects(
    { review: { constraints: { fields: { round: { min: { $gt: 0 } } } } } },
    /값과 이름만 받습니다/u, '중첩된 연산자'
  );
}

// RDLITEMSHAPE04 면제 가능 목록 안의 게이트는 면제가 선언된다.
{
  for (const gate of EXEMPTABLE_GATES) {
    const normalized = normalize({ review: { constraints: { exempt: [gate] } } });
    assert.deepStrictEqual(normalized.review.constraints.exempt, [gate], `면제가 선언되지 않았습니다: ${gate}`);
  }
  // 호출자는 목록을 좁힐 수만 있다. 넓힐 수 있으면 코드가 목록을 갖는다는 말이 빈다.
  const narrowed = normalizeItemTypes({ review: { constraints: { exempt: [EXEMPTABLE_GATES[0]] } } }, { file: FILE, exemptableGates: [EXEMPTABLE_GATES[0]] });
  assert.deepStrictEqual(narrowed.review.constraints.exempt, [EXEMPTABLE_GATES[0]]);
  assert.throws(
    () => normalizeItemTypes({ review: {} }, { file: FILE, exemptableGates: EXEMPTABLE_GATES.concat(['approvalRequired']) }),
    /면제 가능 목록에 없는 게이트를 허용하려 했습니다/u,
    '호출자가 목록을 넓힐 수 있으면 안 됩니다.'
  );
}

// RDLITEMSHAPE05 경계 층 게이트를 면제에 적으면 거부되고 면제 대상이 아닌 이유가 담긴다.
{
  assert.throws(() => normalize({ review: { constraints: { exempt: ['approvalRequired'] } } }), (error) => {
    assert(error.message.includes('approvalRequired'), `게이트 이름이 없습니다: ${error.message}`);
    assert(/되돌릴 수 없는 관문/u.test(error.message), `면제 대상이 아닌 이유가 없습니다: ${error.message}`);
    assert(error.message.includes('itemTypes.review.constraints.exempt[0]'), `키 경로가 없습니다: ${error.message}`);
    return true;
  });
  // 판수를 올려도, 이름을 여러 개 섞어도 열리지 않는다. 우회 경로가 없다.
  rejects({ review: { constraints: { exempt: [EXEMPTABLE_GATES[0], 'humanGate'] } } }, /면제할 수 없는 게이트/u, '뒤에 숨긴 경계 게이트');
}

// RDLITEMSHAPE06 면제 가능 목록 전체를 훑어 경계 층 게이트가 하나도 없음을 전수로 확인한다.
{
  for (const gate of EXEMPTABLE_GATES) {
    assert(!BOUNDARY_KEYS.includes(gate), `면제 가능 목록에 경계 층 게이트가 있습니다: ${gate}`);
  }
  for (const key of BOUNDARY_KEYS) {
    assert(!EXEMPTABLE_GATES.includes(key), `경계 층 게이트가 면제 가능 목록에 들어왔습니다: ${key}`);
    rejects({ review: { constraints: { exempt: [key] } } }, /면제할 수 없는 게이트/u, `경계 게이트 ${key}`);
  }
}

// RDLITEMSHAPE07 내장 유형 정의도 파일 정의와 같은 정규화를 지나 같은 결과 형태를 낸다.
{
  const builtin = normalizeItemTypes(BUILTIN_ITEM_TYPES, { file: '(내장 정의)' });
  const fromFile = normalize({ review: REVIEW });
  const shape = (entry) => Object.keys(entry).sort();
  assert.deepStrictEqual(shape(builtin.test), shape(fromFile.review), '내장이라고 모양이 다르면 판정 경로가 둘 남는다.');
  assert.strictEqual(builtin.test.id, 'test');
  assert.deepStrictEqual(Object.keys(builtin).sort(), ['normal', 'test']);
  // 내장이 저장 계층의 목록과 어긋나면 이관한 순간 판정이 갈린다. 두 목록을 대조한다.
  assert.deepStrictEqual(builtin.test.constraints.fields.result.values, TEST_RESULTS.slice());
  assert.deepStrictEqual(Object.keys(builtin).sort(), TASK_KINDS.slice().sort());
}

// RDLITEMSHAPE08 상위가 정의한 유형에 하위가 제약 하나만 덮으면 그 제약만 덮인다.
{
  const upper = normalize({ review: REVIEW }, { file: 'projects/workspace/board.json' });
  const lower = normalize({ review: { constraints: { requiresLink: { REQ: { min: 2, max: 2 } } } } });
  const merged = mergeItemTypes([upper, lower]);
  assert.strictEqual(merged.review.label, '검토', '표시 필드가 하위의 기본값에 덮였습니다.');
  assert.strictEqual(merged.review.order, 30);
  assert.deepStrictEqual(merged.review.constraints.requiresLink, { REQ: { min: 2, max: 2 } });
  assert.deepStrictEqual(merged.review.constraints.fields, { verdict: { values: ['accept', 'reject'] } }, '덮지 않은 제약이 사라졌습니다.');
  assert.deepStrictEqual(merged.review.constraints.exempt, ['implementation-readiness']);
}

// RDLITEMSHAPE09 하위가 새 유형 키를 더하면 상위 유형과 새 유형이 함께 남는다.
{
  const merged = mergeItemTypes([
    normalize({ review: REVIEW }),
    normalize({ spike: { label: '탐색', constraints: { exempt: EXEMPTABLE_GATES.slice() } } })
  ]);
  assert.deepStrictEqual(Object.keys(merged), ['review', 'spike']);
  assert.strictEqual(merged.review.label, '검토');
  assert.strictEqual(merged.spike.label, '탐색');
}

// RDLITEMSHAPE10 하위가 상속 유형에 사용 안 함을 명시하면 결과에 남되 사용 안 함으로 표시된다.
{
  const merged = mergeItemTypes([normalize({ review: REVIEW }), normalize({ review: { disabled: true } })]);
  assert.strictEqual(merged.review.disabled, true);
  assert.deepStrictEqual(merged.review.constraints.fields, { verdict: { values: ['accept', 'reject'] } }, '지운 것이 아니라 표시한 것이므로 정의는 남는다.');
  // 되살리기는 그 줄을 지우는 것이지 false를 적는 것이 아니다. 맵 병합에는 삭제가 없다.
  rejects({ review: { disabled: false } }, /disabled는 true만 쓸 수 있습니다/u, 'disabled: false');
}

// RDLITEMSHAPE11 유형 식별자에 한글이 들어가면 거부되고 식별자 형식을 알린다.
{
  assert.throws(() => normalize({ 검토: REVIEW }), (error) => {
    assert(/라틴 소문자와 숫자와 붙임표/u.test(error.message), `식별자 형식을 알리지 않았습니다: ${error.message}`);
    return true;
  });
  for (const bad of ['Review', 'code review', 'review_', '-review', 'review--x']) {
    rejects({ [bad]: {} }, /유형 식별자 형식이 아닙니다/u, `식별자 ${bad}`);
  }
  for (const good of ['review', 'code-review', 'r2']) normalize({ [good]: {} });
}

// RDLITEMSHAPE12 아직 없는 문서를 가리키는 파라미터는 형태만 보므로 통과한다.
{
  const normalized = normalize({
    review: {
      constraints: {
        requiresLink: { ADR: { min: 1, max: 1 } },
        fields: { covers: { values: ['TST-999'] } }
      }
    }
  });
  assert.deepStrictEqual(normalized.review.constraints.requiresLink, { ADR: { min: 1, max: 1 } });
  assert.deepStrictEqual(normalized.review.constraints.fields.covers.values, ['TST-999']);
}

// 거부는 첫 위반에서 멈춘다. 형태 판정이 애매하면 거부한다.
{
  let thrown = null;
  try { normalize({ review: { constraints: { requireLink: {}, exempt: ['approvalRequired'] } } }); }
  catch (error) { thrown = error; }
  assert(thrown && /카탈로그에 없는 제약 종류/u.test(thrown.message), `첫 위반에서 멈춰야 합니다: ${thrown && thrown.message}`);
  for (const bad of [null, [], 'review', 42]) {
    assert.throws(() => normalize({ review: bad }), /유형 정의는 객체여야 합니다/u, `판정 불능 입력: ${String(bad)}`);
  }
}

// 판정 계층은 값만 보고 답한다. 파일에 닿으면 표면마다 답이 갈린다.
{
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'item-type.js'), 'utf8');
  assert(!/require\s*\(/u.test(source), 'item-type은 값만으로 판정해야 하는데 require를 갖고 있습니다.');
}

// ---------------------------------------------------------------------------
// TST-034 제약 판정 구역
// ---------------------------------------------------------------------------

const BUILTIN = normalizeItemTypes(BUILTIN_ITEM_TYPES, { file: '(내장 정의)' });

function testTask(id, overrides) {
  return Object.assign({ id, kind: 'test', status: 'doing', round: 1, links: ['TST-001'] }, overrides);
}

function codesOf(diagnostics) {
  return diagnostics.map((item) => item.code);
}

// RDLITEMRULE01 필드 값이 허용 집합 밖이면 필드 제약 진단이 나고 대상에 유형과 필드가 담긴다.
{
  const [found, ...rest] = evaluateItemTypes([testTask('TASK-01', { status: 'done', result: 'green' })], BUILTIN);
  assert.deepStrictEqual(rest, [], '진단이 더 났습니다.');
  assert.strictEqual(found.code, ITEM_DIAGNOSTICS.fields);
  assert.strictEqual(found.target, 'test', '위반한 유형이 대상으로 전달되어야 합니다.');
  assert.strictEqual(found.field, 'result');
  assert.strictEqual(found.artifactId, 'TASK-01');
  assert(found.message.includes('green'), found.message);
  // 허용값 안이면 아무 진단도 없다.
  for (const result of TEST_RESULTS) {
    assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-01', { status: 'done', result })], BUILTIN), []);
  }
}

// RDLITEMRULE02 선언하지 않은 필드에 값이 있으면 필드 제약 진단이 난다.
{
  const found = evaluateItemTypes([{ id: 'TASK-02', kind: 'normal', status: 'done', result: 'pass' }], BUILTIN);
  assert.deepStrictEqual(codesOf(found), [ITEM_DIAGNOSTICS.fields]);
  assert.strictEqual(found[0].target, 'normal');
  assert.strictEqual(found[0].field, 'result');
  const withRound = evaluateItemTypes([{ id: 'TASK-02', kind: 'normal', status: 'todo', round: 2 }], BUILTIN);
  assert.deepStrictEqual(codesOf(withRound), [ITEM_DIAGNOSTICS.fields]);
  assert.strictEqual(withRound[0].field, 'round');
  // 유형과 무관한 필드는 대상이 아니다. 아니면 제목과 담당자까지 전부 위반이 된다.
  assert.deepStrictEqual(evaluateItemTypes([{ id: 'TASK-02', kind: 'normal', title: '무엇', owner: 'MEMBER-001' }], BUILTIN), []);
}

// RDLITEMRULE03 연결 개수가 범위 밖이면 연결 제약 진단이 나고 현재 개수가 담긴다.
{
  const none = evaluateItemTypes([testTask('TASK-03', { links: [] })], BUILTIN);
  assert.deepStrictEqual(codesOf(none), [ITEM_DIAGNOSTICS.requiresLink]);
  assert.strictEqual(none[0].field, 'TST');
  assert(none[0].message.includes('0건'), none[0].message);
  const many = evaluateItemTypes([testTask('TASK-03', { links: ['TST-001', 'TST-002'] })], BUILTIN);
  assert(many.some((item) => item.code === ITEM_DIAGNOSTICS.requiresLink && item.message.includes('2건')), '현재 개수를 담아야 합니다.');
  // 앵커는 문서가 아니라 문서 안의 자리다. 같은 문서를 가리키는 링크의 개수는 하나다.
  assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-03', { links: ['TST-001#S-01'] })], BUILTIN), []);
  // 범위 안이면 진단하지 않는다.
  assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-03', { links: ['REQ-001', 'TST-001'] })], BUILTIN), []);
}

// RDLITEMRULE04 조건이 맞고 요구 필드가 비면 조건부 제약 진단이 난다.
{
  const found = evaluateItemTypes([testTask('TASK-04', { status: 'done' })], BUILTIN);
  assert.deepStrictEqual(codesOf(found), [ITEM_DIAGNOSTICS.requiredWhen]);
  assert.strictEqual(found[0].target, 'test');
  assert.strictEqual(found[0].field, 'result');
}

// RDLITEMRULE05 조건이 맞지 않으면 아무 진단도 나지 않는다.
{
  for (const status of ['todo', 'doing', 'review', 'waiting']) {
    assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-05', { status })], BUILTIN), [], `조건 밖 상태에서 진단이 났습니다: ${status}`);
  }
  // 반려는 수행하지 않기로 한 것이므로 판정을 요구하지 않는다.
  assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-05', { status: 'cancelled' })], BUILTIN), []);
}

// RDLITEMRULE06 같은 조합이 둘이면 유일성 진단이 나고 먼저 차지한 태스크가 담긴다.
{
  const pair = [testTask('TASK-06A'), testTask('TASK-06B')];
  const found = evaluateItemTypes(pair, BUILTIN);
  assert.deepStrictEqual(codesOf(found), [ITEM_DIAGNOSTICS.unique]);
  assert.strictEqual(found[0].artifactId, 'TASK-06B');
  assert(found[0].message.includes('TASK-06A'), `먼저 차지한 태스크를 담아야 합니다: ${found[0].message}`);
  assert.strictEqual(found[0].field, 'round-slot');
  // 차수가 다르거나 문서가 다르면 겹치지 않는다.
  assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-06A'), testTask('TASK-06B', { round: 2 })], BUILTIN), []);
  assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-06A'), testTask('TASK-06B', { links: ['TST-002'] })], BUILTIN), []);
}

// RDLITEMRULE07 입력 순서를 뒤집어도 먼저 차지한 쪽이 같게 정해진다.
{
  const pair = [testTask('TASK-07A'), testTask('TASK-07B')];
  const forward = evaluateItemTypes(pair, BUILTIN);
  const backward = evaluateItemTypes(pair.slice().reverse(), BUILTIN);
  assert.deepStrictEqual(backward, forward, '입력 순서가 판정을 바꿉니다.');
  // 맵으로 넘겨도, 키 순서를 뒤집어도 같다. 저장 순서에 기대면 샤드를 다시 읽는
  // 것만으로 어느 태스크를 고치라는 말이 바뀐다.
  const asMap = evaluateItemTypes({ 'TASK-07B': testTask('TASK-07B'), 'TASK-07A': testTask('TASK-07A') }, BUILTIN);
  assert.deepStrictEqual(asMap, forward);
}

// RDLITEMRULE14 같은 조합 둘 중 하나가 놓아주는 상태면 유일성 진단이 나지 않는다.
{
  const released = testTask('TASK-14A', { status: 'cancelled' });
  assert.deepStrictEqual(evaluateItemTypes([released, testTask('TASK-14B')], BUILTIN), []);
  assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-14B'), released], BUILTIN), []);
}

// RDLITEMRULE15 놓아준 자리에 새 항목을 만들면 진단 없이 통과한다.
{
  const tasks = [
    testTask('TASK-15A', { status: 'cancelled' }),
    testTask('TASK-15B', { status: 'cancelled' }),
    testTask('TASK-15C', { status: 'done', result: 'pass' })
  ];
  assert.deepStrictEqual(evaluateItemTypes(tasks, BUILTIN), []);
}

// RDLITEMRULE16 놓아주는 상태 목록에 비교 연산자를 적으면 거부된다.
{
  // "취소가 아닌 것들 사이에서만 유일"이 아니라 "이 상태들은 집계에서 뺀다"로 적는다.
  for (const bad of [[{ $ne: 'cancelled' }], ['!cancelled'], ['status != cancelled'], [{ not: 'cancelled' }]]) {
    rejects(
      { review: { constraints: { unique: { slot: { fields: ['round'], releasedBy: bad } } } } },
      /값과 이름만 받습니다|상태 값의 이름이어야 합니다|비어 있지 않은 상태 값 배열/u,
      `releasedBy ${JSON.stringify(bad)}`
    );
  }
  normalize({ review: { constraints: { unique: { slot: { fields: ['round'], releasedBy: ['cancelled'] } } } } });
}

// RDLITEMRULE08 면제된 게이트는 돌지 않고 통과로도 세지 않는다.
{
  const seen = [];
  const gates = {
    'implementation-readiness': (task) => {
      seen.push(task.id);
      return [{ code: 'RDL-IMPL-020', message: '구현 준비도 대상 태스크에는 REQ 문서가 필요합니다.' }];
    }
  };
  const tasks = [testTask('TASK-08A'), { id: 'TASK-08B', kind: 'normal', status: 'done' }];
  const found = evaluateItemTypes(tasks, BUILTIN, { gates });
  // 판정하고 감추는 것이 아니라 판정 자체를 돌지 않는다. 감추면 통계와 목록이 어긋난다.
  assert.deepStrictEqual(seen, ['TASK-08B'], '면제한 유형의 태스크에서 게이트가 돌았습니다.');
  assert.deepStrictEqual(found.map((item) => [item.artifactId, item.code]), [['TASK-08B', 'RDL-IMPL-020']]);
  // 면제는 게이트 이름으로 판정한다. 코드로 하면 한 게이트가 코드 둘을 내는 순간
  // 절반만 면제된다.
  assert.strictEqual(found[0].gate, 'implementation-readiness');
  // 기존 게이트 코드는 그대로 나른다. 코드를 재배열하면 이미 기록된 진단과 그것을
  // 참조한 문서가 함께 흔들린다.
  assert(!Object.values(ITEM_DIAGNOSTICS).includes(found[0].code));
}

// RDLITEMRULE09 유형을 다섯 더 정의해도 진단 코드 수가 늘지 않는다.
{
  assert.strictEqual(Object.keys(ITEM_DIAGNOSTICS).length, CONSTRAINT_KINDS.length, '제약 종류마다 코드 하나여야 합니다.');
  assert.deepStrictEqual(Object.keys(ITEM_DIAGNOSTICS).sort(), CONSTRAINT_KINDS.slice().sort());
  assert.strictEqual(new Set(Object.values(ITEM_DIAGNOSTICS)).size, CONSTRAINT_KINDS.length, '두 종류가 코드를 나눠 씁니다.');

  const extras = {};
  const tasks = [];
  for (let index = 0; index < 5; index += 1) {
    const id = `kind-${index}`;
    extras[id] = {
      label: `유형 ${index}`,
      constraints: {
        fields: { grade: { values: ['a', 'b'] } },
        requiresLink: { REQ: { min: 1, max: 1 } },
        requiredWhen: { grade: { field: 'status', is: ['done'] } },
        unique: { slot: { fields: ['grade'], links: ['REQ'] } }
      }
    };
    tasks.push({ id: `TASK-09${index}`, kind: id, status: 'done', grade: 'z', links: [] });
  }
  const definitions = mergeItemTypes([BUILTIN, normalize(extras)]);
  const found = evaluateItemTypes(tasks.concat([testTask('TASK-09X', { status: 'done', result: 'green' })]), definitions);
  const known = new Set(Object.values(ITEM_DIAGNOSTICS).concat([UNUSABLE_ITEM_TYPE]));
  for (const item of found) assert(known.has(item.code), `유형이 늘면서 코드가 늘었습니다: ${item.code}`);
  assert(new Set(codesOf(found)).size <= known.size);
  // 어느 유형이 위반했는지는 대상이 나른다. 코드에 유형 이름을 섞지 않는다.
  for (const item of found) assert(!item.code.includes(item.target), `코드에 유형 이름이 섞였습니다: ${item.code}`);
}

// RDLITEMRULE10 태스크 셋이 어긋나 있으면 셋이 모두 진단된다. 첫 위반에서 멈추지 않는다.
{
  const found = evaluateItemTypes([
    testTask('TASK-10A', { status: 'done' }),
    testTask('TASK-10B', { links: [] }),
    testTask('TASK-10C', { round: 0 })
  ], BUILTIN);
  assert.deepStrictEqual(
    found.map((item) => item.artifactId).sort(),
    ['TASK-10A', 'TASK-10B', 'TASK-10C'],
    '어긋난 태스크 전부가 나와야 합니다.'
  );
  // 한 태스크가 여러 제약을 어기면 그것도 전부 낸다.
  const several = evaluateItemTypes([testTask('TASK-10D', { status: 'done', links: [], round: null })], BUILTIN);
  assert.deepStrictEqual(
    codesOf(several).sort(),
    [ITEM_DIAGNOSTICS.fields, ITEM_DIAGNOSTICS.requiredWhen, ITEM_DIAGNOSTICS.requiresLink].sort()
  );
}

// RDLITEMRULE11 사용 안 함 유형의 태스크가 있으면 진단이 난다.
{
  const definitions = mergeItemTypes([BUILTIN, normalize({ test: { disabled: true } })]);
  const found = evaluateItemTypes([testTask('TASK-11A', { status: 'done', result: 'green' })], definitions);
  assert.strictEqual(found[0].code, UNUSABLE_ITEM_TYPE);
  assert.strictEqual(found[0].target, 'test');
  // 정의가 남아 있으므로 판정도 계속한다. 지웠으면 무엇이 어긋났는지 말할 수 없다.
  assert(found.some((item) => item.code === ITEM_DIAGNOSTICS.fields), '사용 안 함 유형도 제약 판정은 돈다.');
  // 정의에 아예 없는 유형도 조용히 넘기지 않는다. 넘기면 그 태스크만 규칙 없이 통과한다.
  const unknown = evaluateItemTypes([{ id: 'TASK-11B', kind: 'spike' }], BUILTIN);
  assert.deepStrictEqual(codesOf(unknown), [UNUSABLE_ITEM_TYPE]);
  assert.strictEqual(unknown[0].target, 'spike');
}

// 사전조건 위반은 진단이 아니라 예외다. 방어적 검사이므로 엉뚱한 자리에서 터지지 않게 한다.
{
  assert.throws(() => evaluateItemTypes([], { test: BUILTIN_ITEM_TYPES.test }), /형태 판정을 지나지 않았습니다/u);
  assert.throws(() => evaluateItemTypes([], null), /형태 판정을 지나지 않았습니다/u);
}

// 같은 입력이면 같은 목록과 같은 순서다.
{
  const tasks = [testTask('TASK-D1', { status: 'done' }), testTask('TASK-D2'), testTask('TASK-D3', { round: 0 })];
  assert.deepStrictEqual(evaluateItemTypes(tasks, BUILTIN), evaluateItemTypes(tasks, BUILTIN));
}

// ---------------------------------------------------------------------------
// 이관 동등성 구역 — RDLITEMRULE12, RDLITEMRULE13
// ---------------------------------------------------------------------------

// 표의 왼쪽은 코드에서 가져온 현재 진단 코드다. 지금 검사기에 없는 코드를 왼쪽에 적으면
// 대조가 아무것도 증명하지 못하므로, 코드가 실제로 그 자리에 있는지 먼저 확인한다.
const CURRENT_RULES = ['check-rules', 'implementation-contract']
  .map((name) => fs.readFileSync(path.resolve(__dirname, '..', 'src', `${name}.js`), 'utf8'))
  .join('\n');

// REQ-063 "검증 유형 규칙의 재현" 일곱 줄. 일곱이 다섯으로 남김없이 옮겨진다.
const REPRODUCTION = [
  { rule: '판정은 네 값 중 하나', legacy: 'RDL-TASK-027', constraint: 'fields' },
  { rule: '차수는 1 이상의 정수', legacy: 'RDL-TASK-030', constraint: 'fields' },
  { rule: '검증 문서를 정확히 하나 연결', legacy: 'RDL-TASK-029', constraint: 'requiresLink' },
  { rule: '완료한 검증 태스크에는 판정이 필요', legacy: 'RDL-TASK-028', constraint: 'requiredWhen' },
  { rule: '같은 검증 문서의 같은 차수는 하나', legacy: 'RDL-TASK-032', constraint: 'unique' },
  { rule: '반려된 검증 태스크는 차수 슬롯을 놓아줌', legacy: 'RDL-TASK-032', constraint: 'unique' },
  { rule: '구현 준비도 게이트 면제', legacy: 'RDL-IMPL-020', constraint: 'exempt' }
];

// RDLITEMRULE13 일곱이 모두 대응하는 제약으로 잡힌다.
{
  for (const line of REPRODUCTION) {
    assert(CURRENT_RULES.includes(`'${line.legacy}'`), `현재 검사기에 없는 코드를 표에 적었습니다: ${line.legacy}`);
    assert(CONSTRAINT_KINDS.includes(line.constraint), `카탈로그 밖의 제약으로 옮겼습니다: ${line.constraint}`);
  }
  assert.strictEqual(REPRODUCTION.length, 7);
  assert.strictEqual(new Set(REPRODUCTION.map((line) => line.constraint)).size, CONSTRAINT_KINDS.length, '다섯 중 쓰이지 않은 제약이 있습니다 — 카탈로그가 절반짜리라는 뜻입니다.');

  const kindOf = (diagnostics) => diagnostics.map((item) => Object.keys(ITEM_DIAGNOSTICS).find((kind) => ITEM_DIAGNOSTICS[kind] === item.code));
  // 판정은 네 값 중 하나
  assert.deepStrictEqual(kindOf(evaluateItemTypes([testTask('TASK-R1', { status: 'done', result: 'green' })], BUILTIN)), ['fields']);
  // 차수는 1 이상의 정수
  for (const round of [0, -1, 1.5, '1', null, undefined]) {
    assert.deepStrictEqual(kindOf(evaluateItemTypes([testTask('TASK-R2', { round })], BUILTIN)), ['fields'], `차수 ${String(round)}`);
  }
  // 검증 문서를 정확히 하나 연결
  assert.deepStrictEqual(kindOf(evaluateItemTypes([testTask('TASK-R3', { links: ['TST-001', 'TST-002'] })], BUILTIN)), ['requiresLink']);
  // 완료한 검증 태스크에는 판정이 필요
  assert.deepStrictEqual(kindOf(evaluateItemTypes([testTask('TASK-R4', { status: 'done' })], BUILTIN)), ['requiredWhen']);
  // 같은 검증 문서의 같은 차수는 하나
  assert.deepStrictEqual(kindOf(evaluateItemTypes([testTask('TASK-R5A'), testTask('TASK-R5B')], BUILTIN)), ['unique']);
  // 반려된 검증 태스크는 차수 슬롯을 놓아줌
  assert.deepStrictEqual(evaluateItemTypes([testTask('TASK-R6A', { status: 'cancelled' }), testTask('TASK-R6B')], BUILTIN), []);
  // 구현 준비도 게이트 면제
  assert.deepStrictEqual(BUILTIN.test.constraints.exempt, ['implementation-readiness']);
}

/**
 * 이관 전 판정. src/check-rules.js의 검증 유형 분기를 그대로 옮겨 적은 것이다.
 *
 * 고정된 진단 목록 대신 참조 구현을 두는 이유는, 고정값은 태스크 하나를 더할 때마다
 * 다시 떠야 하고 다시 뜨는 순간 그것이 무엇의 증거였는지가 흐려지기 때문이다.
 */
function legacyVerdicts(tasks) {
  const found = [];
  const roundOwners = new Map();
  for (const task of tasks) {
    const kind = task.kind || 'normal';
    const result = task.result === undefined ? null : task.result;
    const round = task.round === undefined ? null : task.round;
    const tested = (task.links || []).map((link) => String(link).split('#')[0]).filter((link) => /^TST-\d{3,}$/u.test(link));
    if (result !== null && kind !== 'test') found.push(`${task.id}:RDL-TASK-027`);
    if (result !== null && kind === 'test' && !TEST_RESULTS.includes(result)) found.push(`${task.id}:RDL-TASK-027`);
    if (kind === 'test' && task.status === 'done' && result === null) found.push(`${task.id}:RDL-TASK-028`);
    if (kind === 'test' && tested.length !== 1) found.push(`${task.id}:RDL-TASK-029`);
    if (kind === 'test' && (!Number.isInteger(round) || round < 1)) found.push(`${task.id}:RDL-TASK-030`);
    if (kind !== 'test' && round !== null) found.push(`${task.id}:RDL-TASK-031`);
    if (kind === 'test' && task.status !== 'cancelled' && Number.isInteger(round) && tested.length === 1) {
      const key = `${tested[0]}@${round}`;
      if (roundOwners.has(key)) found.push(`${task.id}:RDL-TASK-032`);
      else roundOwners.set(key, task.id);
    }
  }
  return found.sort();
}

/** 새 진단을 이관 전 코드로 되읽는다. 대조가 성립하려면 이 지도가 있어야 한다. */
function asLegacy(diagnostic) {
  if (diagnostic.code === ITEM_DIAGNOSTICS.fields && diagnostic.field === 'result') return 'RDL-TASK-027';
  if (diagnostic.code === ITEM_DIAGNOSTICS.fields && diagnostic.field === 'round') return diagnostic.target === 'test' ? 'RDL-TASK-030' : 'RDL-TASK-031';
  if (diagnostic.code === ITEM_DIAGNOSTICS.requiresLink) return 'RDL-TASK-029';
  if (diagnostic.code === ITEM_DIAGNOSTICS.requiredWhen) return 'RDL-TASK-028';
  if (diagnostic.code === ITEM_DIAGNOSTICS.unique) return 'RDL-TASK-032';
  return diagnostic.code;
}

// RDLITEMRULE12 이관 전 태스크 집합을 새 판정으로 검사하면 이관 전 진단 결과와 같다.
{
  const cancellation = { reason: '잘못 만듦', decidedBy: 'MEMBER-001', at: '2026-08-20T00:00:00Z' };
  const corpus = [
    { id: 'TASK-M01', kind: 'normal', status: 'todo', links: ['REQ-001'] },
    { id: 'TASK-M02', kind: 'normal', status: 'done', links: ['TST-001'], result: 'pass' },
    { id: 'TASK-M03', kind: 'normal', status: 'todo', round: 3 },
    { id: 'TASK-M04', kind: 'test', status: 'done', round: 1, links: ['TST-010'], result: 'pass' },
    { id: 'TASK-M05', kind: 'test', status: 'done', round: 1, links: ['TST-011'] },
    { id: 'TASK-M06', kind: 'test', status: 'doing', round: 1, links: ['TST-012', 'TST-013'] },
    { id: 'TASK-M07', kind: 'test', status: 'doing', links: ['TST-014'] },
    { id: 'TASK-M08', kind: 'test', status: 'doing', round: 0, links: ['TST-015'] },
    { id: 'TASK-M09', kind: 'test', status: 'done', round: 2, links: ['TST-016'], result: 'green' },
    { id: 'TASK-M10', kind: 'test', status: 'doing', round: 3, links: ['TST-017'] },
    { id: 'TASK-M11', kind: 'test', status: 'doing', round: 3, links: ['TST-017'] },
    { id: 'TASK-M12', kind: 'test', status: 'cancelled', round: 4, links: ['TST-018'], cancellation },
    { id: 'TASK-M13', kind: 'test', status: 'doing', round: 4, links: ['TST-018'] },
    { id: 'TASK-M14', kind: 'test', status: 'done', round: 5, links: ['TST-019#S-02'], result: 'fail' },
    { id: 'TASK-M15', kind: 'test', status: 'doing', round: 6, links: [] },
    // 한 태스크가 둘을 어기는 경우도 넣는다. 첫 위반에서 멈추던 자리가 있었다면
    // 여기서 개수가 갈린다.
    { id: 'TASK-M16', kind: 'test', status: 'doing', links: [] }
  ];
  const before = legacyVerdicts(corpus);
  const after = evaluateItemTypes(corpus, BUILTIN).map((item) => `${item.artifactId}:${asLegacy(item)}`).sort();
  assert.deepStrictEqual(after, before, '이관 전후로 같은 태스크 집합에 같은 진단이 나와야 합니다.');
  // 대조가 빈 집합끼리 맞아떨어진 것이 아님을 확인한다.
  assert(before.length >= 10, `이관 전 진단이 너무 적어 대조가 의미 없습니다: ${before.length}`);
  assert.strictEqual(new Set(before.map((entry) => entry.split(':')[1])).size, 6, '검증 유형 코드 여섯이 모두 나와야 합니다.');
}

process.stdout.write('item type tests passed\n');
