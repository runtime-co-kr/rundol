'use strict';

// 이관 동등성. 옛 판정을 참조 구현으로 옮겨 적고 새 해석기와 견준다.
//
// 라벨이 아니라 실질을 견주는 이유는 코드 이름이 바뀐 것이 이관의 의도이기 때문이다.
// 이름이 달라진 것은 회귀가 아니고, 잡히는 대상과 개수가 달라지는 것만 회귀다.
//
// 실제 저장소 태스크로 견주지 않는 이유는 그것이 전부 깨끗해 0 대 0이 되기 때문이다.
// 아무것도 증명하지 못하는 대조는 통과해도 뜻이 없으므로 위반을 담은 형태를 직접 만든다.
// 그리고 실제 태스크는 이 기계에 붙은 작업공간의 것이라 통합 검사가 기댈 수 없다.
const assert = require('assert');
const { evaluateItemTypes, normalizeItemTypes, BUILTIN_ITEM_TYPES } = require('../src/item-type');

const definitions = normalizeItemTypes(BUILTIN_ITEM_TYPES);
const KINDS = ['normal', 'test'];
const RESULTS = ['pass', 'fail', 'blocked', 'skipped'];
const tested = (task) => (task.links || []).filter((link) => /^TST-\d{3,}$/u.test(String(link)));

function legacy(tasks) {
  const hits = {};
  const bump = (id) => { hits[id] = (hits[id] || 0) + 1; };
  const owners = new Map();
  for (const [id, task] of Object.entries(tasks)) {
    const kind = task.kind || 'normal';
    const result = task.result === undefined ? null : task.result;
    const round = task.round === undefined ? null : task.round;
    const links = tested(task);
    if (!KINDS.includes(kind)) bump(id);
    if (result !== null && kind !== 'test') bump(id);
    if (result !== null && kind === 'test' && !RESULTS.includes(result)) bump(id);
    if (kind === 'test' && task.status === 'done' && result === null) bump(id);
    if (kind === 'test' && links.length !== 1) bump(id);
    if (kind === 'test' && (!Number.isInteger(round) || round < 1)) bump(id);
    if (kind !== 'test' && round !== null) bump(id);
    if (kind === 'test' && task.status !== 'cancelled' && Number.isInteger(round) && links.length === 1) {
      const key = `${links[0]}@${round}`;
      if (owners.has(key)) bump(id); else owners.set(key, id);
    }
  }
  return hits;
}

function modern(tasks) {
  const hits = {};
  for (const issue of evaluateItemTypes(tasks, definitions, {})) {
    hits[issue.artifactId] = (hits[issue.artifactId] || 0) + 1;
  }
  return hits;
}

const fixtures = {
  '정상 일반': { A: { status: 'todo', kind: 'normal', links: [] } },
  '정상 검증': { A: { status: 'todo', kind: 'test', round: 1, links: ['TST-001'] } },
  '완료 검증 판정 있음': { A: { status: 'done', kind: 'test', round: 1, result: 'pass', links: ['TST-001'] } },
  '완료 검증 판정 없음': { A: { status: 'done', kind: 'test', round: 1, links: ['TST-001'] } },
  '판정 값 잘못': { A: { status: 'todo', kind: 'test', round: 1, result: 'weird', links: ['TST-001'] } },
  '일반에 판정': { A: { status: 'todo', kind: 'normal', result: 'pass', links: [] } },
  '일반에 차수': { A: { status: 'todo', kind: 'normal', round: 2, links: [] } },
  '검증에 차수 없음': { A: { status: 'todo', kind: 'test', links: ['TST-001'] } },
  '검증에 차수 0': { A: { status: 'todo', kind: 'test', round: 0, links: ['TST-001'] } },
  '검증 링크 없음': { A: { status: 'todo', kind: 'test', round: 1, links: [] } },
  '검증 링크 둘': { A: { status: 'todo', kind: 'test', round: 1, links: ['TST-001', 'TST-002'] } },
  '같은 차수 중복': {
    A: { status: 'todo', kind: 'test', round: 1, links: ['TST-001'] },
    B: { status: 'todo', kind: 'test', round: 1, links: ['TST-001'] }
  },
  '반려는 자리를 비움': {
    A: { status: 'cancelled', kind: 'test', round: 1, links: ['TST-001'] },
    B: { status: 'todo', kind: 'test', round: 1, links: ['TST-001'] }
  },
  '다른 차수는 겹치지 않음': {
    A: { status: 'todo', kind: 'test', round: 1, links: ['TST-001'] },
    B: { status: 'todo', kind: 'test', round: 2, links: ['TST-001'] }
  },
  '모르는 유형': { A: { status: 'todo', kind: 'spike', links: [] } },
  '여럿이 동시에 어긋남': {
    A: { status: 'done', kind: 'test', links: [] },
    B: { status: 'todo', kind: 'normal', round: 3, result: 'pass', links: [] }
  }
};

for (const [label, tasks] of Object.entries(fixtures)) {
  assert.deepStrictEqual(modern(tasks), legacy(tasks), `이관 전후 판정이 다릅니다: ${label}`);
}

// 참조 구현이 실제로 무언가를 잡고 있어야 이 대조가 뜻을 갖는다. 전부 빈 결과면
// 두 구현이 아무것도 안 해도 통과한다.
const flagged = Object.values(fixtures).filter((tasks) => Object.keys(legacy(tasks)).length).length;
assert.ok(flagged >= 10, `위반을 담은 형태가 너무 적습니다: ${flagged}건`);

process.stdout.write('item type migration tests passed\n');
