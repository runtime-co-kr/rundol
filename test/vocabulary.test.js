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
  ['RUN_OPENING_UNIT_KINDS', 'EXECUTION_UNIT_KINDS']
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
  // 그 모듈 안에서만 뜻이 있는 목록
  'ENV_ALLOWLIST', 'SESSION_ENV', 'SESSION_PID_ENV', 'LAYOUT_FLAGS', 'GENERATED',
  'GOVERNANCE_HEADINGS', 'REQUIRED_TAG_NAMESPACES', 'NOTE_TAG_NAMESPACES',
  'NON_CANONICAL_CODES', 'SHARD_LEVEL_LEDGER_CODES', 'SPLIT_SIGNALS',
  'RESERVED_PROJECT_KEYS', 'CONVERGING_COMMANDS', 'COMMIT_PRODUCING_COMMANDS',
  'COMMIT_REQUIRED_STEPS', 'FAN_OUT_SOURCES', 'SUPPORTED_SCHEMA',
  // 보드 화면은 브라우저에서 그대로 실행되므로 CommonJS를 require할 수 없다.
  // 면제하는 대신 아래에서 값이 정본과 같은지를 직접 확인한다 — 면제만 하고
  // 확인하지 않으면 화면만 조용히 갈린다.
  'TERMINAL_STATUSES'
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

// ── 브라우저 쪽 값이 정본과 같은가 ──────────────────────────────────────
//
// 화면은 require를 쓸 수 없으니 선언이 남는다. 그렇다고 소스에 그 글자가 있는지만
// 보면(app.includes("const X = [...]")) 아무것도 증명하지 못한다 — 띄어쓰기만
// 바뀌어도 깨지고, 값이 틀려도 글자가 같으면 통과한다. 값을 꺼내서 비교한다.

const appSource = fs.readFileSync(path.join(sourceRoot, 'board-ui', 'app.js'), 'utf8');

function browserArray(name) {
  const found = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'u').exec(appSource);
  assert(found, `보드 화면에 ${name} 선언이 없습니다.`);
  return (found[1].match(/'[^']*'/gu) || []).map((quoted) => quoted.slice(1, -1));
}

assert.deepStrictEqual(
  browserArray('TERMINAL_STATUSES').slice().sort(),
  vocabulary.TERMINAL_TASK_STATES.slice().sort(),
  '보드 화면의 종료 상태가 정본과 다릅니다.'
);

// ── 타입 선언이 정본과 같은가 ──────────────────────────────────────────
//
// types/workflow.d.ts는 판정 계약의 필드 이름이 사는 자리이고, 정본은 값 목록만
// 갖는다. 그래서 같은 값이 두 번 적히며, 두 번 적힌 것은 언젠가 갈린다. 화면에 쓴
// 방법을 그대로 쓴다 — 글자가 있는지가 아니라 값을 꺼내서 비교한다.

const declarations = fs.readFileSync(path.resolve(__dirname, '..', 'types', 'workflow.d.ts'), 'utf8');

function declaredUnion(name) {
  const found = new RegExp(`export type ${name}\\s*=([^;]*);`, 'u').exec(declarations);
  assert(found, `types/workflow.d.ts에 ${name} 선언이 없습니다.`);
  return (found[1].match(/'[^']*'/gu) || []).map((quoted) => quoted.slice(1, -1));
}

const declaredUnions = [
  ['WorkflowStep', 'WORKFLOW_STEPS'],
  ['CompletionValidity', 'COMPLETION_VALIDITIES'],
  ['ValidationSource', 'VALIDATION_SOURCE_KINDS'],
  ['ValidationMethod', 'VALIDATION_METHODS'],
  ['RuleOrigin', 'RULE_ORIGINS'],
  ['JudgmentSurface', 'JUDGMENT_SURFACES']
];
for (const [declared, canonical] of declaredUnions) {
  assert.deepStrictEqual(
    declaredUnion(declared).slice().sort(),
    vocabulary[canonical].slice().sort(),
    `types/workflow.d.ts의 ${declared}이 ${canonical}과 다릅니다.`
  );
}

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
