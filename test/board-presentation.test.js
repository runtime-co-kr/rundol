'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_PRESENTATION, PRESENTATION_GROUPS, readConfig, mergePresentation,
  renderWorkspaceBoardConfig, renderProjectBoardConfig
} = require('../src/board-presentation');

const merged = mergePresentation(JSON.parse(JSON.stringify(DEFAULT_PRESENTATION)), {
  schemaVersion: 1,
  documentTypes: { prd: { label: '프로젝트 제품 요구사항' } },
  documentStates: { draft: { order: 99 } }
});
assert.strictEqual(merged.documentTypes.prd.label, '프로젝트 제품 요구사항');
assert.strictEqual(merged.documentTypes.prd.description, DEFAULT_PRESENTATION.documentTypes.prd.description);
assert.strictEqual(merged.documentStates.draft.order, 99);
assert.strictEqual(JSON.parse(renderWorkspaceBoardConfig()).documentTypes.requirement.label, '요구사항');
// 그룹이 늘어날 때마다 이 목록을 손으로 고치면, 새 그룹을 빠뜨려도 테스트가 통과한다.
const emptyProject = { schemaVersion: 1 };
for (const group of Object.keys(PRESENTATION_GROUPS)) emptyProject[group] = {};
assert.deepStrictEqual(JSON.parse(renderProjectBoardConfig()), emptyProject);

// 저장값은 ASCII 식별자이고 화면에 보이는 말은 라벨이다. 라벨을 바꿔도 계약과 태스크가
// 저장한 값은 달라지지 않아야 하므로, 모든 그룹의 키가 실제 저장값과 같은지 묶는다.
{
  const { POLICY_STATES, ENFORCEMENTS } = require('../src/document-profile');
  const { STATUSES } = require('../src/board');
  assert.deepStrictEqual(Object.keys(DEFAULT_PRESENTATION.policyStates).sort(), POLICY_STATES.slice().sort(), '정책 상태 라벨 키는 저장값과 같아야 합니다');
  assert.deepStrictEqual(Object.keys(DEFAULT_PRESENTATION.enforcementLevels).sort(), ENFORCEMENTS.slice().sort(), '강제 수준 라벨 키는 저장값과 같아야 합니다');
  assert.deepStrictEqual(Object.keys(DEFAULT_PRESENTATION.taskStatuses).sort(), STATUSES.slice().sort(), '태스크 상태 라벨 키는 저장값과 같아야 합니다');
  for (const [group, keys] of Object.entries(PRESENTATION_GROUPS)) {
    assert.deepStrictEqual(Object.keys(DEFAULT_PRESENTATION[group]).sort(), keys.slice().sort(), `${group}의 기본 라벨이 키 목록과 어긋납니다`);
    for (const [key, entry] of Object.entries(DEFAULT_PRESENTATION[group])) {
      assert.ok(entry.label && entry.description, `${group}.${key}에 라벨과 설명이 필요합니다`);
      assert.ok(!/^[a-z][A-Za-z]*$/u.test(entry.label), `${group}.${key}.label이 저장값 그대로입니다: ${entry.label}`);
    }
  }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-board-presentation-'));
try {
  const valid = path.join(temporary, 'valid.json');
  fs.writeFileSync(valid, JSON.stringify({ schemaVersion: 1, documentTypes: { prd: { label: '제품 명세' } }, documentStates: {} }), 'utf8');
  assert.strictEqual(readConfig(valid).documentTypes.prd.label, '제품 명세');
  const unknown = path.join(temporary, 'unknown.json');
  fs.writeFileSync(unknown, JSON.stringify({ schemaVersion: 1, documentTypes: { custom: { label: '사용자 정의' } } }), 'utf8');
  assert.throws(() => readConfig(unknown), /지원하지 않는 documentTypes 키/u);
  const invalid = path.join(temporary, 'invalid.json');
  fs.writeFileSync(invalid, '{', 'utf8');
  assert.throws(() => readConfig(invalid), /올바른 JSON/u);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('board presentation tests passed\n');
