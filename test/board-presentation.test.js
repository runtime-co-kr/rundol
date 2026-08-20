'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_PRESENTATION, PRESENTATION_GROUPS, readConfig, mergePresentation,
  renderWorkspaceBoardConfig, renderProjectBoardConfig, policyDifferences
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

// 정책 층. 경계 층 이름은 파일 어디에 나와도 거부하고, 사용 안 함 표식은 상속을
// 없애는 유일한 경로이며, 출처는 로더가 계산해 화면이 다시 판정하지 않게 한다.
{
  const file = path.join(os.tmpdir(), 'rundol-policy-layer.json');

  // 경계 층은 화면에 없는 것만으로 못 막는다. 파일로 우회하는 길을 읽는 시점에 닫는다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, priorities: { high: { label: 'x', humanGate: false } } }), 'utf8');
  assert.throws(() => readConfig(file), /되돌릴 수 없는 관문/u, '경계 층 키가 거부되어야 합니다');

  // 판수를 올려도 열리지 않는다. 열리면 판수 올리기가 잠금 해제로 보인다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, priorities: { high: { label: 'x', gateBypass: true } } }), 'utf8');
  assert.throws(() => readConfig(file), /되돌릴 수 없는 관문/u, '판수와 무관하게 거부되어야 합니다');

  // 접두만 같은 이름은 경계가 아니다. 정확히 일치할 때만 막는다 — 접두 일치를 쓰면
  // 우연히 경계 이름으로 시작하는 정책 키가 영원히 막힌다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, priorities: { humanGateStyle: { label: 'x' } } }), 'utf8');
  assert.throws(() => readConfig(file), /지원하지 않는/u, '접두 일치는 허용 필드 판정으로 가야 합니다');

  // 판수 2를 받는다. 판수 1도 그대로 유효하다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, priorities: { high: { label: '높음' } } }), 'utf8');
  assert.strictEqual(readConfig(file).priorities.high.label, '높음');

  // 프로필 policy는 판수 1 시절부터 있었다. 이름을 뒤늦게 붙였다고 남의 파일을 거부하면 안 된다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, profiles: { 'our-team': { label: '우리 팀', policy: { required: ['REQ'] } } } }), 'utf8');
  assert.strictEqual(readConfig(file).profiles['our-team'].label, '우리 팀', '판수 1의 기존 프리셋이 계속 열려야 합니다');

  // 사용 안 함은 참만 쓴다. 거짓을 허용하면 되살리는 뜻과 안 적은 뜻이 섞인다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, priorities: { high: { disabled: false } } }), 'utf8');
  assert.throws(() => readConfig(file), /true만 쓸 수 있습니다/u);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, priorities: { high: { disabled: true } } }), 'utf8');
  assert.strictEqual(readConfig(file).priorities.high.disabled, true);

  fs.rmSync(file, { force: true });

  // 표식은 병합을 타고 남는다. 결과에서 지우면 상위에 원래 있었는지, 하위가 없앤
  // 것인지를 구분할 수 없고 되돌리는 조작을 걸 자리도 없다.
  const tombstoned = mergePresentation(JSON.parse(JSON.stringify(DEFAULT_PRESENTATION)), { schemaVersion: 1, priorities: { low: { disabled: true } } });
  assert.strictEqual(tombstoned.priorities.low.disabled, true, '사용 안 함 표식이 병합 결과에 남아야 합니다');
  assert.strictEqual(tombstoned.priorities.low.label, '낮음', '표식이 붙어도 상위 값은 남아야 합니다');
  assert.strictEqual(tombstoned.priorities.high.disabled, undefined, '표식이 이웃 항목에 번지면 안 됩니다');
}

// 정책 변경만 결정을 요구한다. 표시 문구까지 요구하면 라벨의 오타를 고치는 데도
// 결정이 필요해지고, 형식이 된 결정은 그 안에 담긴 정책 변경까지 함께 가린다.
{
  const where = (previous, next) => policyDifferences(previous, next).map((item) => `${item.group}.${item.key}.${item.field}`).join(', ');

  assert.strictEqual(where({ priorities: { high: { label: '높음' } } }, { priorities: { high: { label: '아주 높음' } } }), '', '표시 변경은 결정을 요구하지 않아야 합니다');
  assert.strictEqual(where({ profiles: { t: { policy: { required: ['REQ'] } } } }, { profiles: { t: { policy: { required: ['REQ', 'ARC'] } } } }), 'profiles.t.policy');

  // 키 순서와 공백은 변경이 아니다. 그대로 견주면 아무것도 바꾸지 않은 저장이
  // 결정을 요구하고, 그런 요구가 반복되면 사람은 내용을 보지 않고 누른다.
  assert.strictEqual(where(
    { profiles: { t: { policy: { required: ['REQ'], recommended: [] } } } },
    { profiles: { t: { policy: { recommended: [], required: ['REQ'] } } } }
  ), '', '키 순서 차이가 변경으로 보이면 안 됩니다');

  // 조이는 방향도 기록을 요구한다. 무엇이 조이는 것인지는 값의 의미를 알아야 정하고,
  // 그 판정을 기록 조건으로 삼으면 판정이 틀리는 순간 기록이 조용히 사라진다.
  assert.strictEqual(where(
    { profiles: { t: { policy: { required: ['REQ', 'ARC'] } } } },
    { profiles: { t: { policy: { required: ['REQ', 'ARC', 'TST'] } } } }
  ), 'profiles.t.policy', '조이는 변경도 기록을 요구해야 합니다');

  // 사용 안 함은 어느 그룹에서나 정책이다. 표시 층으로 새면 되돌릴 수 없는 값이
  // 기록 없이 사라진다.
  assert.strictEqual(where({ priorities: { low: { label: '낮음' } } }, { priorities: { low: { label: '낮음', disabled: true } } }), 'priorities.low.disabled');
  assert.strictEqual(where({ priorities: { low: { disabled: true } } }, { priorities: { low: {} } }), 'priorities.low.disabled', '표식을 떼는 것도 정책입니다');
}

// 업무 유형은 최상위 맵이다. 표시 그룹에 넣지 않는 이유는 그쪽이 라벨·설명·순서만
// 받기 때문이고, 유형 정의의 검증은 유형 모듈이 이미 갖고 있어 거기 위임한다.
{
  const { BUILTIN_ITEM_TYPES } = require('../src/item-type');
  const file = path.join(os.tmpdir(), 'rundol-item-types.json');

  // 내장이 병합의 바닥이다. 없으면 파일이 아무것도 안 적었을 때 유형이 하나도 없고,
  // 그러면 모든 태스크가 "정의에 없는 유형"이 된다.
  assert.deepStrictEqual(
    Object.keys(DEFAULT_PRESENTATION.itemTypes).sort(),
    Object.keys(BUILTIN_ITEM_TYPES).sort(),
    '내장 유형이 기본 표시에 실려야 합니다'
  );

  // 맵이므로 하위가 새 키를 더하면 상위 키와 함께 남는다. 통째로 덮으면 유형 하나를
  // 더하려고 상위 전부를 다시 적어야 한다.
  const added = mergePresentation(JSON.parse(JSON.stringify(DEFAULT_PRESENTATION)), {
    schemaVersion: 1,
    itemTypes: { spike: { label: '스파이크', constraints: {} } }
  });
  assert.ok(added.itemTypes.spike, '하위가 더한 유형이 남아야 합니다');
  assert.ok(added.itemTypes.test, '상위 유형이 함께 남아야 합니다');

  // 제약은 종류 단위로 덮는다. 항목 단위면 하위가 제약 하나를 적는 순간 나머지가 사라진다.
  const tweaked = mergePresentation(JSON.parse(JSON.stringify(DEFAULT_PRESENTATION)), {
    schemaVersion: 1,
    itemTypes: { test: { constraints: { exempt: [] } } }
  });
  assert.deepStrictEqual(tweaked.itemTypes.test.constraints.exempt, [], '덮은 제약이 반영되어야 합니다');
  assert.ok(tweaked.itemTypes.test.constraints.unique, '덮지 않은 제약이 남아야 합니다');
  assert.ok(tweaked.itemTypes.test.constraints.requiresLink, '덮지 않은 제약이 남아야 합니다');

  // 잘못된 정의는 읽는 시점에 거부한다. 병합까지 흘러가면 그때 나는 오류는 어느 파일
  // 탓인지 말하지 못한다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, itemTypes: { x: { constraints: { mystery: {} } } } }), 'utf8');
  assert.throws(() => readConfig(file), /mystery/u, '카탈로그 밖 제약이 거부되어야 합니다');

  // 조건식은 규칙 언어로 가는 문이다. 받는 순간 규칙을 읽으려면 규칙 언어를 먼저 읽어야 한다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, itemTypes: { x: { constraints: { unique: { fields: ['a'], releasedBy: ['$ne'] } } } } }), 'utf8');
  assert.throws(() => readConfig(file), /조건식/u, '조건식 파라미터가 거부되어야 합니다');

  // 식별자는 저장값이다. 표시 문구가 들어가면 표기를 바꾸는 순간 저장된 정의가 깨진다.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, itemTypes: { '스파이크': { constraints: {} } } }), 'utf8');
  assert.throws(() => readConfig(file), /라틴 소문자/u);

  fs.rmSync(file, { force: true });
}

process.stdout.write('board presentation tests passed\n');
