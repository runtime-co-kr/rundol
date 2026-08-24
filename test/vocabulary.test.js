'use strict';

// 값 어휘의 정본 불변식. 파일 하나를 만드는 것만으로는 어휘가 하나가 되지 않는다 —
// 두 번째 선언을 막는 것이 이 시험이고, 그것이 없으면 다음 사람이 여덟 번째 이름을
// 만든다. 실제로 종료 상태는 세 이름으로 있었다.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vocabulary = require('../src/vocabulary');

const sourceRoot = path.resolve(__dirname, '..', 'src');

// ── 정본 내부의 불변식 ──────────────────────────────────────────────────

// 저장 순서와 표시 순서는 순서만 다르고 집합은 같아야 한다. 갈리면 어떤 화면은
// 존재하는 상태를 아예 그리지 않는다.
assert.deepStrictEqual(
  vocabulary.TASK_STATES.slice().sort(),
  vocabulary.TASK_STATUS_ORDER.slice().sort(),
  'TASK_STATES와 TASK_STATUS_ORDER의 집합이 다릅니다.'
);

// 사건 유형과 그 인과 순서는 순서만 다르고 집합은 같아야 한다. 갈리면 새 유형이
// 순서 없이 들어오고, 순서 없는 유형은 같은 밀리초에서 무작위로 갈린다 — 그것이
// 0.39.8 배포를 멈춘 결함의 모습이었다.
assert.deepStrictEqual(
  vocabulary.WORK_EVENT_TYPES.slice().sort(),
  vocabulary.WORK_EVENT_CAUSAL_ORDER.slice().sort(),
  'WORK_EVENT_TYPES와 WORK_EVENT_CAUSAL_ORDER의 집합이 다릅니다.'
);

// 끝난 것과 열린 것은 서로의 여집합이다.
assert.deepStrictEqual(
  vocabulary.OPEN_TASK_STATES.concat(vocabulary.TERMINAL_TASK_STATES).sort(),
  vocabulary.TASK_STATES.slice().sort(),
  '열린 상태와 끝난 상태를 합쳐도 전체가 되지 않습니다.'
);

// 스텝도 끝난 것과 열린 것이 서로의 여집합이다.
assert.deepStrictEqual(
  vocabulary.OPEN_WORKFLOW_STEPS.concat(vocabulary.TERMINAL_WORKFLOW_STEPS).sort(),
  vocabulary.WORKFLOW_STEPS.slice().sort(),
  '열린 스텝과 끝난 스텝을 합쳐도 전체가 되지 않습니다.'
);

// 스텝 이름은 지금 쓰는 상태값과 하나도 겹치지 않아야 한다. 겹치면 배선이 끝난
// 뒤에도 `=== 'done'`이 그대로 통과해서, 그 줄이 스텝으로 옮겨진 것인지 빠뜨린
// 것인지 구분할 방법이 없어진다 — 33곳이 사라졌는지 세는 일이 그 구분에 달려 있다.
const storedStateValues = new Set([...vocabulary.TASK_STATES, ...vocabulary.DOCUMENT_STATE_KEYS]);
for (const step of vocabulary.WORKFLOW_STEPS) {
  assert(!storedStateValues.has(step), `워크플로 스텝 ${step}이 상태값과 겹칩니다.`);
}

// 실행 단위도 런을 여는 것과 안 여는 것이 서로의 여집합이다.
assert.deepStrictEqual(
  vocabulary.RUN_OPENING_UNIT_KINDS.concat(vocabulary.JUDGMENT_ONLY_UNIT_KINDS).sort(),
  vocabulary.EXECUTION_UNIT_KINDS.slice().sort(),
  '런을 여는 종류와 안 여는 종류를 합쳐도 전체가 되지 않습니다.'
);

// 슬롯마다 컴파일되는 실행 단위 종류가 정해져 있어야 한다. 빠진 슬롯은 전환에 걸려도
// 아무것으로도 컴파일되지 않고, 아무것으로도 컴파일되지 않는 슬롯은 설정에 적을 수는
// 있으나 아무 일도 하지 않는다 — 죽은 칸이 생기는 경로가 그것이다.
assert.deepStrictEqual(
  Object.keys(vocabulary.TRANSITION_SLOT_UNIT_KINDS).sort(),
  vocabulary.TRANSITION_SLOTS.slice().sort(),
  '전환 슬롯과 실행 단위 표의 집합이 다릅니다.'
);

// 실행 단위 종류 다섯은 슬롯 표에 정확히 한 번씩 나와야 한다. 두 번 나오면 그 종류를
// 어느 슬롯이 무는지가 갈리고, 한 번도 안 나오면 그 종류는 어느 슬롯에도 걸리지 못해
// 죽는다 — 성질이 못 쓰는 검증 방법을 잡는 단언과 같은 물음이다.
const slottedUnitKinds = [];
for (const [slot, kinds] of Object.entries(vocabulary.TRANSITION_SLOT_UNIT_KINDS)) {
  for (const kind of kinds) {
    assert(vocabulary.EXECUTION_UNIT_KINDS.includes(kind), `${slot}의 실행 단위 종류 ${kind}가 정본에 없습니다.`);
    slottedUnitKinds.push(kind);
  }
}
assert.deepStrictEqual(
  slottedUnitKinds.slice().sort(),
  vocabulary.EXECUTION_UNIT_KINDS.slice().sort(),
  '실행 단위 종류가 슬롯 표에 한 번씩 나오지 않습니다. 두 번 나오면 무는 슬롯이 갈리고, 안 나오면 그 종류는 죽습니다.'
);

// 슬롯도 런을 여는 것과 안 여는 것이 서로의 여집합이다.
assert.deepStrictEqual(
  vocabulary.RUN_OPENING_SLOTS.concat(vocabulary.JUDGMENT_ONLY_SLOTS).sort(),
  vocabulary.TRANSITION_SLOTS.slice().sort(),
  '런을 여는 슬롯과 안 여는 슬롯을 합쳐도 전체가 되지 않습니다.'
);

// ADR-023이 그은 경계를 값으로 못박는다. 위 단언들은 표가 서로 맞물리는지만 보므로,
// 표를 통째로 바꾸면 전부 통과한 채 경계가 옮겨간다. 제한과 검증은 런을 열지 않고
// 나머지 셋은 연다는 것이 그 결정이고, 결정이 바뀌면 이 줄이 먼저 걸려야 한다 —
// 걸리지 않으면 갈래 셋이 서로 다른 경계 위에서 각자 배선한다.
assert.deepStrictEqual(
  Array.from(vocabulary.JUDGMENT_ONLY_SLOTS),
  ['restriction', 'validation'],
  '런을 열지 않는 슬롯이 ADR-023의 결정과 다릅니다.'
);
assert.deepStrictEqual(
  Array.from(vocabulary.RUN_OPENING_SLOTS),
  ['input', 'execution', 'approval'],
  '런을 여는 슬롯이 ADR-023의 결정과 다릅니다.'
);

// 소스마다 성질이 하나씩 있어야 한다. 빠진 소스는 쓸 수 있는 방법이 없어 설정에서
// 늘 거부되고, 늘 거부되는 소스는 목록에 있으나 없으나 같다.
assert.deepStrictEqual(
  Object.keys(vocabulary.VALIDATION_SOURCE_NATURE).sort(),
  vocabulary.VALIDATION_SOURCE_KINDS.slice().sort(),
  '검증 소스와 성질 표의 집합이 다릅니다.'
);
for (const [source, nature] of Object.entries(vocabulary.VALIDATION_SOURCE_NATURE)) {
  assert(vocabulary.VALIDATION_SOURCE_NATURES.includes(nature), `${source}의 성질 ${nature}가 정본에 없습니다.`);
}

// 성질마다 쓸 수 있는 방법이 있어야 하고, 어느 성질도 못 쓰는 방법이 있으면 안 된다.
// 그런 방법은 진단 코드를 하나 차지하고도 한 번도 발화하지 않는다.
assert.deepStrictEqual(
  Object.keys(vocabulary.VALIDATION_METHODS_BY_NATURE).sort(),
  vocabulary.VALIDATION_SOURCE_NATURES.slice().sort(),
  '성질과 방법 표의 집합이 다릅니다.'
);
const reachableMethods = new Set();
for (const [nature, methods] of Object.entries(vocabulary.VALIDATION_METHODS_BY_NATURE)) {
  for (const method of methods) {
    assert(vocabulary.VALIDATION_METHODS.includes(method), `${nature}의 방법 ${method}가 정본에 없습니다.`);
    reachableMethods.add(method);
  }
}
assert.deepStrictEqual(
  Array.from(reachableMethods).sort(),
  vocabulary.VALIDATION_METHODS.slice().sort(),
  '어느 성질도 쓸 수 없는 검증 방법이 있습니다.'
);

// 서브 종류는 정규 문서 유형과 겹치지 않아야 한다. 겹치면 문서 안 표기 FN-001이
// 문서 식별자로도 읽히고, 그러면 참조에서 부모의 경계를 찾을 수 없다 — 부모를 단
// 것 자체가 뜻을 잃는다. 정규 유형이 세 글자이므로 두 글자로 두는 것이 그 강제다.
for (const kind of vocabulary.SUB_KINDS) {
  assert(!vocabulary.REGULAR_TYPES.includes(kind), `서브 종류 ${kind}가 문서 유형과 겹칩니다.`);
  assert(/^[A-Z]{2}$/u.test(kind), `서브 종류 ${kind}가 대문자 두 글자가 아닙니다.`);
}

// 부모와 서브를 잇는 구분자는 종류와 일련을 가르는 하이픈과 달라야 한다. 같으면
// REQ-033-FN-001에서 어디까지가 부모인지 문자열만으로는 알 수 없고, 실제로 지금
// 기능 ID를 훑는 정규식이 그 한 줄에서 REQ-033과 FN-001을 각각 독립된 ID로 집어낸다.
assert.notStrictEqual(vocabulary.SUB_ID_SEPARATOR, '-', '서브 구분자가 하이픈과 같습니다.');

// 문서 안 표기는 서브 종류만 받고, 지금 사람이 짓던 접두와 두 자리 일련은 받지 않아야
// 한다. 받으면 이 어휘가 무엇을 닫았는지가 흐려지고 옮겨진 것과 안 옮겨진 것을 셀 수
// 없다 — 스텝 이름을 상태값과 겹치지 않게 지은 것과 같은 이유다.
const subPattern = new RegExp(`^${vocabulary.ID_PATTERNS.sub}$`, 'u');
for (const kind of vocabulary.SUB_KINDS) {
  assert(subPattern.test(`${kind}-001`), `문서 안 표기가 ${kind}-001을 받지 않습니다.`);
}
for (const rejected of ['HRN-02', 'TSK-01', 'S-03', 'FN-1', 'REQ-033']) {
  assert(!subPattern.test(rejected), `문서 안 표기가 ${rejected}을 받습니다.`);
}

const subsets = [
  ['ACTIVE_TASK_STATES', 'OPEN_TASK_STATES'],
  ['TERMINAL_TASK_STATES', 'TASK_STATES'],
  ['IMPLEMENTATION_TYPES', 'REGULAR_TYPES'],
  ['RELATED_REQUIRED_TYPES', 'REGULAR_TYPES'],
  ['SYNC_HALT_REASONS', 'HALT_REASONS'],
  ['TERMINAL_WORKFLOW_STEPS', 'WORKFLOW_STEPS'],
  ['OPEN_WORKFLOW_STEPS', 'WORKFLOW_STEPS'],
  ['ACTIVE_WORKFLOW_STEPS', 'OPEN_WORKFLOW_STEPS'],
  ['JUDGMENT_ONLY_UNIT_KINDS', 'EXECUTION_UNIT_KINDS'],
  ['RUN_OPENING_UNIT_KINDS', 'EXECUTION_UNIT_KINDS'],
  ['JUDGMENT_ONLY_SLOTS', 'TRANSITION_SLOTS'],
  ['RUN_OPENING_SLOTS', 'TRANSITION_SLOTS']
];
for (const [child, parent] of subsets) {
  for (const value of vocabulary[child]) {
    assert(vocabulary[parent].includes(value), `${child}의 ${value}가 ${parent}에 없습니다.`);
  }
}

// 얼려 두지 않으면 어느 소비자가 배열을 제자리에서 정렬하는 순간 다른 소비자의
// 순서가 바뀐다. 그런 결함은 부른 쪽이 아니라 엉뚱한 곳에서 드러난다. 표는 배열을
// 값으로 가지므로, 바깥만 얼리면 안쪽은 그대로 열려 있다.
for (const [name, value] of Object.entries(vocabulary)) {
  if (!value || typeof value !== 'object') continue;
  assert(Object.isFrozen(value), `${name}이 얼어 있지 않습니다.`);
  if (Array.isArray(value)) continue;
  for (const [key, inner] of Object.entries(value)) {
    if (Array.isArray(inner)) assert(Object.isFrozen(inner), `${name}.${key}가 얼어 있지 않습니다.`);
  }
}

// ── 소비자가 정본에서 파생되는가 ────────────────────────────────────────
//
// 소스 문자열 매칭이 아니라 값으로 비교한다. 문자열 매칭은 띄어쓰기만 바뀌어도
// 깨지고, 값이 틀려도 글자가 같으면 통과한다 — 무엇도 증명하지 못한다.

const { ALLOWED_TASK_STATES } = require('../src/check-rules');
assert.deepStrictEqual(
  Array.from(ALLOWED_TASK_STATES).sort(),
  vocabulary.TASK_STATES.slice().sort(),
  'check-rules의 허용 상태가 정본과 다릅니다.'
);

const { TERMINAL_TASK_STATES } = require('../src/tasks');
assert.deepStrictEqual(
  Array.from(TERMINAL_TASK_STATES),
  Array.from(vocabulary.TERMINAL_TASK_STATES),
  'tasks의 종료 상태가 정본과 다릅니다.'
);

const { STATUSES } = require('../src/board');
assert.deepStrictEqual(Array.from(STATUSES), Array.from(vocabulary.TASK_STATES), '보드의 상태 목록이 정본과 다릅니다.');

const { STATUS_ORDER, OPEN_STATES, ACTIVE_STATES } = require('../src/agent-context');
assert.deepStrictEqual(Array.from(STATUS_ORDER), Array.from(vocabulary.TASK_STATUS_ORDER), 'agent-context의 표시 순서가 정본과 다릅니다.');
assert.deepStrictEqual(Array.from(OPEN_STATES).sort(), vocabulary.OPEN_TASK_STATES.slice().sort(), 'agent-context의 열린 상태가 정본과 다릅니다.');
assert.deepStrictEqual(Array.from(ACTIVE_STATES).sort(), vocabulary.ACTIVE_TASK_STATES.slice().sort(), 'agent-context의 활성 상태가 정본과 다릅니다.');

const { REGULAR_TYPES, PROFILE_NAMES, POLICY_STATES, ENFORCEMENTS } = require('../src/document-profile');
assert.deepStrictEqual(Array.from(REGULAR_TYPES), Array.from(vocabulary.REGULAR_TYPES), '문서 유형이 정본과 다릅니다.');
assert.deepStrictEqual(Array.from(PROFILE_NAMES), Array.from(vocabulary.PROFILE_NAMES), '프로필 이름이 정본과 다릅니다.');
assert.deepStrictEqual(Array.from(POLICY_STATES), Array.from(vocabulary.POLICY_STATES), '정책 상태가 정본과 다릅니다.');
assert.deepStrictEqual(Array.from(ENFORCEMENTS), Array.from(vocabulary.ENFORCEMENTS), '강제 수준이 정본과 다릅니다.');

// 승인 모드는 정의가 객체라 키가 곧 목록이다. 목록과 정의가 갈리면 어떤 모드는
// 이름만 있고 정책이 없거나 그 반대가 된다.
const { MODE_NAMES } = require('../src/approval-mode');
assert.deepStrictEqual(Array.from(MODE_NAMES).sort(), vocabulary.APPROVAL_MODES.slice().sort(), '승인 모드가 정본과 다릅니다.');

// ── 두 번째 선언을 막는다 ───────────────────────────────────────────────

/**
 * 값 어휘가 아닌 열거형. 여기 이름을 올리는 것은 "이것은 필드가 가질 수 있는 값이
 * 아니라 필드의 이름이거나 그 모듈만의 목록"이라는 선언이다.
 *
 * 허용 목록으로 두는 이유는 금지 목록으로 두면 새 어휘가 생길 때 넣는 것을 잊는
 * 경로가 남고, 잊으면 그 어휘가 조용히 정본 밖에 머물기 때문이다.
 */
const NOT_VOCABULARY = new Set([
  // 필드 이름 목록 — 이벤트·문서·보고의 모양이지 값이 아니다
  'BASE_FIELDS', 'REQUIRED_FIELDS', 'REQUIRED_TASK_FIELDS', 'ASSIGNMENT_FIELDS',
  'REPORT_FIELDS', 'FIELD_SPEC_KEYS', 'TOP_LEVEL_KEYS', 'BOUNDARY_KEYS',
  'APPROVAL_FIELDS', 'ENTRY_KEYS', 'GRANDFATHERED_POLICY_FIELDS', 'SCALAR_KEYS', 'MAP_KEYS',
  // workflows.json이 받는 키 이름들. 설정의 모양이지 값이 아니다 — 여기 적힌 것은
  // 사용자가 고를 값이 아니라 사용자가 적을 칸이고, 칸을 늘리는 것은 코드를 고치는 일이다.
  'WORKFLOW_ENTRY_KEYS', 'NODE_ENTRY_KEYS', 'TRANSITION_KEYS', 'APPROVAL_KEYS', 'ROOT_KEYS',
  // 그 모듈 안에서만 뜻이 있는 목록
  'ENV_ALLOWLIST', 'SESSION_ENV', 'SESSION_PID_ENV', 'LAYOUT_FLAGS', 'GENERATED',
  'GOVERNANCE_HEADINGS', 'REQUIRED_TAG_NAMESPACES', 'NOTE_TAG_NAMESPACES',
  'NON_CANONICAL_CODES', 'SHARD_LEVEL_LEDGER_CODES', 'SPLIT_SIGNALS',
  'RESERVED_PROJECT_KEYS', 'CONVERGING_COMMANDS', 'COMMIT_PRODUCING_COMMANDS',
  'COMMIT_REQUIRED_STEPS', 'FAN_OUT_SOURCES', 'SUPPORTED_SCHEMA',
  // 보드 화면의 종료 상태 사본은 없앴다. 서버가 스냅숏에 워크플로를 실어 주므로
  // 화면이 적어 둘 목록이 없고, 그래서 면제할 이름도 없다. 사본이 정말 사라졌는지는
  // 아래에서 확인한다 — 면제 목록에서 이름만 지우면 사본이 남아도 아무 신호가 없다.
]);

// 모듈 최상위 선언만 본다. 함수 안의 지역 변수는 어휘가 아니라 계산의 중간값이다.
const TOP_LEVEL_DECL = /^const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:Object\.freeze\(\s*)?(?:new\s+Set\(\s*)?\[([^\]]*)\]/gmu;

function sourceFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue; // 번들 산출물은 저작물이 아니다
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.(js|mjs)$/u.test(entry.name)) found.push(full);
  }
  return found;
}

const violations = [];
for (const file of sourceFiles(sourceRoot)) {
  if (path.basename(file) === 'vocabulary.js') continue;
  const source = fs.readFileSync(file, 'utf8');
  TOP_LEVEL_DECL.lastIndex = 0;
  let match = TOP_LEVEL_DECL.exec(source);
  while (match) {
    const [, name, body] = match;
    const items = body.match(/'[^']*'/gu) || [];
    const onlyStrings = items.length > 0 && body.replace(/'[^']*'/gu, '').replace(/[\s,]/gu, '') === '';
    if (onlyStrings && !NOT_VOCABULARY.has(name)) {
      violations.push({
        file: path.relative(path.dirname(sourceRoot), file).replace(/\\/gu, '/'),
        line: source.slice(0, match.index).split('\n').length,
        name
      });
    }
    match = TOP_LEVEL_DECL.exec(source);
  }
}

assert.strictEqual(
  violations.length,
  0,
  `값 어휘는 src/vocabulary.js가 소유해야 합니다. 정본에서 가져오거나, 값 어휘가 아니면 NOT_VOCABULARY에 이유와 함께 올리세요.\n${
    violations.map((item) => `  ${item.file}:${item.line}  ${item.name}`).join('\n')}`
);

// ── 브라우저 쪽에 사본이 남지 않았는가 ──────────────────────────────────
//
// 화면은 require를 쓸 수 없으니 예전에는 종료 상태를 그대로 적어 두었고, 이 시험은
// 그 사본이 정본과 같은지를 값으로 확인했다. 이제 서버가 스냅숏에 워크플로를 실어
// 주므로 사본 자체가 없어야 한다 — 확인할 것이 "같은가"에서 "없는가"로 바뀐다.
//
// 그리고 사본을 재는 것만으로는 모자란다. 사본이 없어도 화면이 상태 이름을 그 자리에
// 직접 적어 비교하면 같은 일이 벌어지기 때문이다. 그래서 이름이 아니라 비교를 잰다 —
// 상태를 리터럴과 견주는 자리가 화면에 하나도 없어야 한다.
//
// 정규식을 쓰지 않는다. 이 판정은 "status를 따옴표와 비교하는가" 하나이고, 그것은
// 부분 문자열로 답할 수 있다. 값이 틀려도 글자가 같으면 통과하는 종류의 확인이
// 아니다 — 여기서 세는 것은 값이 아니라 자리 자체다.

const appSource = fs.readFileSync(path.join(sourceRoot, 'board-ui', 'app.js'), 'utf8');
const appLines = appSource.split('\n').map((line) => line.replace('\r', ''));

// 자국은 "status를 태스크 상태값과 견주는가"다. 화면에는 다른 축의 status도 산다 —
// 클라이언트의 active와 하부 요소의 disabled가 그렇고, 그것들은 태스크 상태가 아니라
// 이 갈래의 대상이 아니다. 견주는 값까지 봐야 그 둘을 가른다.
//
// 화면 이름(view · taskScope)이 우연히 상태와 같은 글자를 쓰지만 그쪽은 state.view와
// dataset.view를 견주므로 아래 자국에 걸리지 않는다. 글자가 같다는 이유로 세면 이
// 시험은 고칠 수 없는 것을 고치라고 말하게 된다.
const COMPARISON_MARKS = [];
for (const operator of ['===', '!==', '==', '!=']) {
  for (const state of vocabulary.TASK_STATES) COMPARISON_MARKS.push(`status ${operator} '${state}'`);
}
const browserStateSites = [];
appLines.forEach((line, index) => {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
  for (const mark of COMPARISON_MARKS) {
    if (line.includes(mark)) browserStateSites.push(`  app.js:${index + 1}  ${mark}`);
  }
  if (line.includes('TERMINAL_STATUSES')) browserStateSites.push(`  app.js:${index + 1}  TERMINAL_STATUSES`);
});

assert.deepStrictEqual(
  browserStateSites,
  [],
  `보드 화면이 상태 이름을 비교합니다. 스냅숏의 workflow가 준 스텝으로 물으세요.\n${browserStateSites.join('\n')}`
);

// 사본을 지우기만 하고 대신 읽을 것을 안 만들면 화면은 아무것도 가르지 못한다.
// 서버가 준 워크플로를 실제로 읽는지, 그리고 서버가 그것을 싣는지를 함께 본다.
// 한쪽만 있으면 화면은 늘 빈 워크플로를 보고 모든 태스크가 같은 칸에 선다.
assert(
  appSource.includes('state.snapshot && state.snapshot.workflow'),
  '보드 화면이 스냅숏의 workflow를 읽지 않습니다.'
);
const boardSource = fs.readFileSync(path.join(sourceRoot, 'board.js'), 'utf8');
assert(
  boardSource.includes('workflow: workflow.taskWorkflowView()'),
  '보드 스냅숏이 워크플로를 싣지 않습니다.'
);

// ── 타입 선언이 정본과 같은가 ──────────────────────────────────────────
//
// types/workflow.d.ts는 판정 계약의 필드 이름이 사는 자리이고, 정본은 값 목록만
// 갖는다. 그래서 같은 값이 두 번 적히며, 두 번 적힌 것은 언젠가 갈린다. 화면에 쓴
// 방법을 그대로 쓴다 — 글자가 있는지가 아니라 값을 꺼내서 비교한다.

const declarationSources = new Map();

function declaredUnion(file, name) {
  if (!declarationSources.has(file)) {
    declarationSources.set(file, fs.readFileSync(path.resolve(__dirname, '..', 'types', file), 'utf8'));
  }
  const found = new RegExp(`export type ${name}\\s*=([^;]*);`, 'u').exec(declarationSources.get(file));
  assert(found, `types/${file}에 ${name} 선언이 없습니다.`);
  return (found[1].match(/'[^']*'/gu) || []).map((quoted) => quoted.slice(1, -1));
}

const declaredUnions = [
  ['workflow.d.ts', 'WorkflowStep', 'WORKFLOW_STEPS'],
  ['workflow.d.ts', 'CompletionValidity', 'COMPLETION_VALIDITIES'],
  ['workflow.d.ts', 'ValidationSource', 'VALIDATION_SOURCE_KINDS'],
  ['workflow.d.ts', 'ValidationMethod', 'VALIDATION_METHODS'],
  ['workflow.d.ts', 'RuleOrigin', 'RULE_ORIGINS'],
  ['workflow.d.ts', 'JudgmentSurface', 'JUDGMENT_SURFACES'],
  ['workflow.d.ts', 'TargetKind', 'TARGET_KINDS'],
  ['workflow.d.ts', 'ExecutionUnitKind', 'EXECUTION_UNIT_KINDS'],
  ['workflow.d.ts', 'TransitionSlot', 'TRANSITION_SLOTS'],
  ['workflow.d.ts', 'BasisKind', 'BASIS_KINDS'],
  ['workflow.d.ts', 'Verdict', 'VERDICTS'],
  // 서브는 workflow.d.ts에 얹지 않았다. 진행 축을 갖지 않으므로 판정 계약과 한
  // 파일에 두면 읽는 사람이 서브의 전환을 찾게 되고, 없는 것을 찾는 일은 대개
  // 만들어 넣는 것으로 끝난다. 파일이 둘이 되었으므로 읽는 자리도 파일을 받는다.
  ['sub.d.ts', 'SubKind', 'SUB_KINDS']
];
for (const [file, declared, canonical] of declaredUnions) {
  assert.deepStrictEqual(
    declaredUnion(file, declared).slice().sort(),
    vocabulary[canonical].slice().sort(),
    `types/${file}의 ${declared}이 ${canonical}과 다릅니다.`
  );
}

// 전환 항목의 칸 이름은 슬롯 값과 같은 글자여야 한다. 갈리면 설정에 적는 칸과 N:M이
// 나르는 슬롯 값 사이에 사람이 외워야 하는 대응표가 하나 생기고, 외우는 대응표는
// 한쪽만 늘어난다 — 그리고 늘어난 쪽은 아무 신호도 내지 않는다.
//
// 위의 유니온 표는 `export type`만 보므로 인터페이스의 속성 이름은 그 그물에 걸리지
// 않는다. 그래서 여기서 한 번 더 본다. 주석을 먼저 걷어내는 것은 설명 안의 중괄호가
// 본문의 끝으로 읽히기 때문이고, 값을 꺼내 비교한다는 원칙은 그대로다 — 글자가 있는지가
// 아니라 꺼낸 이름이 정본에 있는지를 묻는다.
// 위 표가 이미 읽어 둔 원본을 그대로 쓴다. 다시 읽으면 두 번 읽은 것이 같은 파일인지를
// 아무도 지키지 않는다.
const workflowTypes = declarationSources.get('workflow.d.ts');
const slotsBody = /export interface TransitionSlots\s*\{([^}]*)\}/u.exec(workflowTypes.replace(/\/\*[\s\S]*?\*\//gu, ''));
assert(slotsBody, 'types/workflow.d.ts에 TransitionSlots 선언이 없습니다.');

const slotCans = (slotsBody[1].match(/^\s*([A-Za-z][A-Za-z0-9]*)\??:/gmu) || [])
  .map((line) => line.trim().replace(/\??:$/u, ''));
assert(slotCans.length > 0, 'TransitionSlots에서 칸을 하나도 읽지 못했습니다. 선언 모양이 바뀌었다면 이 확인도 함께 고치세요.');
for (const can of slotCans) {
  assert(vocabulary.TRANSITION_SLOTS.includes(can), `전환 항목의 칸 ${can}이 슬롯 정본에 없습니다.`);
}

// restriction만 칸을 갖지 않는다. 그 슬롯이 컴파일되는 것은 실행 단위가 아니라 "전환
// 목록에서 제외"이고, 목록에 있는가 없는가가 곧 그 슬롯의 데이터이기 때문이다. 이 줄이
// 없으면 칸이 넷인 것이 결정인지 빠뜨린 것인지 다음 사람이 구분하지 못한다.
assert.deepStrictEqual(
  vocabulary.TRANSITION_SLOTS.filter((slot) => !slotCans.includes(slot)),
  ['restriction'],
  '칸을 갖지 않는 슬롯이 restriction 하나가 아닙니다.'
);

// ── 게시되는 패키지가 정본과 같은가 ────────────────────────────────────
//
// @rundol/core는 협업 노드가 채워질 자리이고, 게시될 때 저장소의 src/를 싣지
// 않으므로 정본을 require할 수 없다. 같은 값을 두 번 적는 대신 여기서 묶는다.
//
// 이 단언이 없던 동안 core의 TASK_STATES는 cancelled가 빠진 채 최초 커밋부터
// 방치되었다. 아무도 쓰지 않아 아무 신호도 나지 않았고, 그래서 "정본을 자처하는데
// 틀린 값"이 남았다. 쓰이지 않는다는 것은 틀려도 된다는 뜻이 아니다 — 다음에
// 쓰기 시작하는 사람이 그 값을 믿는다.

const core = require('../packages/core/src/index');

assert.deepStrictEqual(
  Array.from(core.TASK_STATES),
  Array.from(vocabulary.TASK_STATES),
  '@rundol/core의 TASK_STATES가 정본과 갈렸습니다. 정본을 먼저 고치고 그 결과를 옮기세요.'
);
assert.deepStrictEqual(
  Array.from(core.EXECUTORS),
  Array.from(vocabulary.EXECUTORS),
  '@rundol/core의 EXECUTORS가 정본과 갈렸습니다.'
);

// 브랜치는 목록이 아니라 규칙이라 값 비교만으로는 부족하다. 규칙이 실제로 내는
// 이름을 정본의 상수와 맞춘다.
assert.strictEqual(core.BRANCHES.settings, vocabulary.SETTINGS_BRANCH, '@rundol/core의 설정 브랜치가 정본과 다릅니다.');
assert.strictEqual(core.BRANCHES.project('crm'), 'rundol/crm', '프로젝트 브랜치 규칙이 바뀌었습니다.');
assert(
  vocabulary.WORKSPACE_BRANCHES.includes(core.BRANCHES.settings),
  '설정 브랜치가 작업공간 브랜치 목록에 없습니다.'
);

process.stdout.write('vocabulary tests passed\n');
