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
// 그룹이 늘어날 때마다 이 목록을 손으로 고치면, 새 그룹을 빠뜨려도 테스트가 통과한다.
const emptyConfig = { schemaVersion: 1 };
for (const group of Object.keys(PRESENTATION_GROUPS)) emptyConfig[group] = {};
assert.deepStrictEqual(JSON.parse(renderProjectBoardConfig()), emptyConfig);
// 새로 만드는 board.json은 덮어쓴 것만 갖는다. 기본값을 파일에 복사해두면 유형을 하나
// 더할 때마다 공유 파일이 바뀌고, 같은 저장소를 보는 구버전이 모르는 키에서 멈춘다.
assert.deepStrictEqual(JSON.parse(renderWorkspaceBoardConfig()), emptyConfig);

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
  // 옛 키는 새 키로 읽힌다. 이름만 바꾸고 이관 경로를 내지 않으면 이미 저장된 board.json이
  // 거부되어 기존 Workspace가 통째로 멈춘다.
  const legacy = path.join(temporary, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({ schemaVersion: 1, documentTypes: { api: { label: '규격' } } }), 'utf8');
  const legacyRead = readConfig(legacy);
  assert.strictEqual(legacyRead.documentTypes.interface.label, '규격');
  assert.strictEqual(legacyRead.documentTypes.api, undefined);
  // 옛 키와 새 키가 함께 있으면 새 키가 이긴다. 지운 줄 알았던 값이 되살아나면 안 된다.
  const both = path.join(temporary, 'both.json');
  fs.writeFileSync(both, JSON.stringify({ schemaVersion: 1, documentTypes: { api: { label: '옛 이름' }, interface: { label: '새 이름' } } }), 'utf8');
  assert.strictEqual(readConfig(both).documentTypes.interface.label, '새 이름');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

// 프리셋은 내장 다섯 개로 끝나지 않는다. 팀이 board.json에 자기 프리셋을 정의하면
// 그 이름이 계약에 저장되고 CLI와 화면 모두에서 고를 수 있어야 한다.
{
  const { resolveProfilePresets, profileChoices } = require('../src/board-presentation');
  const { DEFAULT_POLICIES, REGULAR_TYPES } = require('../src/document-profile');

  const builtin = resolveProfilePresets(null);
  assert.deepStrictEqual(Object.keys(builtin).sort(), Object.keys(DEFAULT_POLICIES).sort(), '설정이 없으면 내장 프리셋만 남습니다');

  const custom = resolveProfilePresets({ profiles: { 'our-team': { label: '우리 팀', policy: { required: ['REQ', 'TST'], disabled: ['SCR'] } } } });
  assert.deepStrictEqual(custom['our-team'].required, ['REQ', 'TST']);
  assert.deepStrictEqual(custom['our-team'].disabled, ['SCR']);
  // 어디에도 배치되지 않은 유형이 사라지면 그 유형은 계약에서 없는 것이 되어 검사도 안내도 못 받는다.
  const placed = new Set([].concat(custom['our-team'].required, custom['our-team'].recommended, custom['our-team'].onDemand, custom['our-team'].disabled));
  assert.deepStrictEqual(Array.from(placed).sort(), REGULAR_TYPES.slice().sort(), '빠뜨린 유형은 필요할 때로 들어가야 합니다');
  assert.ok(builtin.lean && custom.lean, '커스텀을 더해도 내장은 남아야 합니다');

  const choices = profileChoices({ profiles: { 'our-team': { label: '우리 팀', order: 5, policy: { required: ['REQ'] } } } });
  const ours = choices.find((item) => item.name === 'our-team');
  assert.strictEqual(ours.label, '우리 팀');
  assert.strictEqual(ours.builtin, false, '커스텀 프리셋은 내장으로 표시되면 안 됩니다');
  assert.strictEqual(choices.find((item) => item.name === 'lean').builtin, true);

  // 커스텀 프로필 키는 저장값이므로 표시용 한글이 그대로 들어오면 안 된다.
  const bad = path.join(os.tmpdir(), 'rundol-preset-bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, profiles: { '우리팀': { label: 'x', policy: { required: ['REQ'] } } } }), 'utf8');
  assert.throws(() => readConfig(bad), /프로필 이름은 영문 소문자/u);
  // 정책 없는 커스텀 프로필은 조용히 service로 되돌아가므로 아예 거절한다.
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, profiles: { 'our-team': { label: '우리 팀' } } }), 'utf8');
  assert.throws(() => readConfig(bad), /policy가 필요합니다/u);
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, profiles: { 'our-team': { policy: { required: ['REQ'], recommended: ['REQ'] } } } }), 'utf8');
  assert.throws(() => readConfig(bad), /두 상태에 걸쳐/u);
  fs.rmSync(bad, { force: true });
}

process.stdout.write('board presentation tests passed\n');
