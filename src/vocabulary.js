'use strict';

// 저장되는 값의 목록. 이 저장소가 쓰는 모든 열거 어휘의 정본이다.
//
// 이 파일이 생긴 이유는 정리벽이 아니라 실제로 어긋난 자국이다. 태스크 상태 목록이
// 일곱 곳에 각각 선언되어 있었고, 그중 `@rundol/core`는 `cancelled`가 빠진 채로
// 최초 커밋 이후 한 번도 고쳐지지 않았다. 상태를 하나 늘린 커밋(1e9db63)은 열두
// 파일을 고치면서 그 하나를 지나쳤다. 고치는 비용이 문제가 아니라 놓치는 것이
// 문제였다 — 놓쳤다는 사실은 아무 신호도 내지 않는다.
//
// 같은 목록을 두 번째로 적을 수 있으면 언젠가 두 목록은 갈린다. 그래서 규칙은
// "중복된 것만 모은다"가 아니라 "값 목록은 전부 여기 있다"이다. 앞의 규칙은 적는
// 사람이 저장소 전체를 미리 색인해야 지킬 수 있고, 아무도 그렇게 하지 않는다.
// 실제로 state.js는 tasks.js를 이미 require 하면서도 같은 목록을 다른 이름으로
// 다시 선언했다 — 남이 붙인 이름을 맞혀야 찾을 수 있었기 때문이다.
//
// 여기 들어오는 것은 "필드가 가질 수 있는 값"이다. "필드의 이름"은 들어오지 않는다.
// BASE_FIELDS처럼 이벤트 종류마다 다른 필드 집합은 그 종류의 계약이지 공통 어휘가
// 아니며, 여기로 옮기면 서로 다른 것들이 한 이름 아래 모여 오히려 헷갈린다.
// 이 구분은 적는 시점에 판단할 수 있다 — 저장소를 뒤질 필요가 없다.
//
// 진단 코드는 여기 없다. 코드는 제약 종류에 붙고 그 제약을 판정하는 모듈이 소유하며,
// 코드에서 정본 문서로 가는 지도는 diagnostic-rules.js가 따로 갖는다.
//
// require를 하나도 갖지 않는다. 판정 계층(worker-contract, check-rules, item-type,
// approval-mode, diagnostic-rules)이 이것을 가져다 쓰므로, 여기가 파일이나 저장소에
// 닿는 순간 그 계층 전체의 순수성이 무너진다. worker-contract-purity.test.js가
// 전이 의존까지 따라가며 그 사실을 지킨다.

// ── 태스크 ──────────────────────────────────────────────────────────────

/** 태스크 상태의 저장값. 이 여섯이 전부이며 순서는 저장 순서다. */
const TASK_STATES = Object.freeze(['todo', 'doing', 'waiting', 'review', 'done', 'cancelled']);

/**
 * 표시 우선순위. TASK_STATES와 같은 집합이지만 순서가 다르다 — 손이 가야 하는 것이
 * 앞에 온다. 둘을 하나로 합치지 않는 이유는 저장 순서를 화면 사정으로 바꾸면
 * 이미 저장된 값의 정렬 기준이 조용히 달라지기 때문이다. 집합이 같다는 것은
 * vocabulary.test.js가 못박는다.
 */
const TASK_STATUS_ORDER = Object.freeze(['doing', 'review', 'waiting', 'todo', 'done', 'cancelled']);

/**
 * 끝난 상태. 완료와 반려는 이유가 다르지만 "더 손대지 않는다"는 점에서 같고,
 * 선행 태스크 판정과 목록 필터는 그 점만 본다.
 *
 * 이 목록이 세 파일에 TERMINAL_TASK_STATES · TERMINAL_TASK_STATUSES ·
 * TERMINAL_STATUSES 세 이름으로 있었다. 내용은 셋 다 같았다 — 아직 갈리지 않았을 뿐이다.
 */
const TERMINAL_TASK_STATES = Object.freeze(['done', 'cancelled']);

/**
 * 아직 열린 상태. 끝난 것의 여집합으로 계산한다 — 목록으로 적어 두면 상태가 늘 때
 * 여기 넣는 것을 잊을 수 있고, 잊으면 새 상태가 조용히 "끝난 것"으로 취급된다.
 */
const OPEN_TASK_STATES = Object.freeze(TASK_STATES.filter((state) => !TERMINAL_TASK_STATES.includes(state)));

/** 지금 누군가 붙어 있는 상태. 열린 것 중 아직 아무도 잡지 않은 todo를 뺀 것이다. */
const ACTIVE_TASK_STATES = Object.freeze(OPEN_TASK_STATES.filter((state) => state !== 'todo'));

const TASK_PRIORITIES = Object.freeze(['high', 'mid', 'low']);
const TASK_KINDS = Object.freeze(['normal', 'test']);
const TEST_RESULTS = Object.freeze(['pass', 'fail', 'blocked', 'skipped']);

// ── 문서 ────────────────────────────────────────────────────────────────

/**
 * 정규 문서 유형. 문서 식별자의 앞자리이며 저장값이다. 대문자인 것은 이미 저장된
 * 문서들이 그렇게 적혀 있기 때문이고, 표기를 바꾸면 링크가 전부 어긋난다.
 */
const REGULAR_TYPES = Object.freeze(['PRD', 'REQ', 'ARC', 'SCR', 'MOD', 'IFC', 'ADR', 'TST', 'RUN', 'STD', 'GLS']);

/** 구현 계약이 슬롯을 요구하는 유형. REGULAR_TYPES의 부분집합이다. */
const IMPLEMENTATION_TYPES = Object.freeze(['REQ', 'SCR', 'MOD', 'IFC', 'TST']);

/** 관련 문서 연결이 필수인 유형. REGULAR_TYPES의 부분집합이다. */
const RELATED_REQUIRED_TYPES = Object.freeze(['REQ', 'SCR', 'MOD', 'IFC', 'TST', 'RUN']);

/**
 * 보드가 쓰는 문서 분류 키. REGULAR_TYPES와 짝이 아니다 — charter와 clipping은
 * 정규 유형이 아니고, 이쪽은 긴 이름을 쓴다. 둘을 합치면 저장값과 분류가 한 이름
 * 아래 섞인다.
 */
const DOCUMENT_TYPE_KEYS = Object.freeze([
  'charter', 'prd', 'requirement', 'architecture', 'screen', 'model',
  'interface', 'decision', 'standard', 'test', 'runbook', 'glossary', 'clipping'
]);

const DOCUMENT_STATE_KEYS = Object.freeze(['draft', 'proposed', 'active', 'review', 'approved', 'deprecated', 'archived', 'unread']);

// ── 문서 계약 ───────────────────────────────────────────────────────────

const PROFILE_NAMES = Object.freeze(['lean', 'product', 'service', 'platform', 'assured']);
const POLICY_STATES = Object.freeze(['required', 'recommended', 'onDemand', 'disabled']);
const ENFORCEMENTS = Object.freeze(['advisory', 'checkpoint']);
const TRAITS = Object.freeze(['ui', 'data', 'api', 'component', 'operations', 'security-regulation', 'terminology']);

// ── 승인과 판정 ─────────────────────────────────────────────────────────

/** 승인 모드. approval-mode.js의 MODES 키와 같아야 하며 시험이 그것을 본다. */
const APPROVAL_MODES = Object.freeze(['human-only', 'ai-assisted', 'ai-first', 'ai-only']);

/** 승인 근거의 종류. */
const BASIS_KINDS = Object.freeze(['read', 'verdict', 'check', 'delegated']);

/** 검증 판정. 기권을 실패와 가르는 이유는 "보지 못했다"와 "보고 아니라 했다"가 다르기 때문이다. */
const VERDICTS = Object.freeze(['pass', 'refuted', 'abstain']);

/**
 * 실행 주체. procedure.js의 step.executor는 이것과 다른 어휘를 쓴다
 * (cli · client · adapter) — 같은 필드 이름이지만 뜻이 다르므로 합치지 않는다.
 */
const EXECUTORS = Object.freeze(['cli', 'llm', 'hybrid']);

// ── 실행 원장 ───────────────────────────────────────────────────────────

/**
 * 런의 상태. 원장 접기가 내는 값이며 state.js·run.js·doctor.js가 문자열로 비교한다.
 *
 * 상태 기계가 있는 유일한 자리인데 정작 어휘만 이름이 없었다. 옆의 CHECKPOINT_TYPES와
 * HALT_REASONS는 집합으로 선언되어 있었으므로, 빠진 것은 설계가 아니라 누락이다.
 */
const RUN_STATES = Object.freeze(['running', 'completed_local', 'synced', 'halted', 'ownership-conflict']);

const CHECKPOINT_TYPES = Object.freeze([
  'run.started', 'run.halted', 'run.resumed', 'run.completed_local',
  'run.synced', 'run.takeover', 'run.ownership_resolved'
]);

const HALT_REASONS = Object.freeze([
  'gate-failed', 'step-failed', 'merge-conflict', 'sync-failed', 'adapter-timeout',
  'lease-lost', 'attempt-limit', 'manual', 'settings-drift', 'ownership-conflict',
  'operation-conflict', 'legacy-conflict', 'verification-required'
]);

/** sync 실행자가 낼 수 있는 정지 사유. HALT_REASONS의 부분집합이다. */
const SYNC_HALT_REASONS = Object.freeze(['sync-failed', 'merge-conflict']);

const OUTCOME_KINDS = Object.freeze([
  'step-completed', 'gate-passed', 'gate-failed', 'verification-passed',
  'verification-refuted', 'verification-abstained', 'forced', 'step-failed'
]);

// ── 작업 계약 ───────────────────────────────────────────────────────────

const WORK_EVENT_TYPES = Object.freeze([
  'assignment.issued', 'assignment.rejected', 'assignment.closed',
  'report.submitted', 'report.rejected', 'report.verified'
]);

/** 워커의 종류. 사람과 에이전트는 같은 계층이며 이 값은 전달 경로만 정한다. */
const WORKER_KINDS = Object.freeze(['human', 'agent']);

// ── 업무 유형 ───────────────────────────────────────────────────────────

const CONSTRAINT_KINDS = Object.freeze(['fields', 'requiresLink', 'requiredWhen', 'unique', 'exempt']);
const EXEMPTABLE_GATES = Object.freeze(['implementation-readiness', 'done-requires-test-link']);
const FIELD_TYPES = Object.freeze(['string', 'integer']);

/** 표시 필드. 화면에 보이는 말은 전부 여기 있고, 저장값은 식별자뿐이다. */
const DISPLAY_FIELDS = Object.freeze(['label', 'description', 'order', 'disabled']);

// ── 저장소와 협업 ───────────────────────────────────────────────────────

const WORKSPACE_BRANCHES = Object.freeze(['rundol/workspace', 'rundol/settings']);
const SETTINGS_BRANCH = 'rundol/settings';
const WORKSPACE_BRANCH = 'rundol/workspace';

/** 협업 클라이언트의 종류. */
const CLIENT_TYPES = Object.freeze(['device', 'agent', 'service', 'human']);

/** 샤딩되는 원장. */
const LEDGERS = Object.freeze(['decision', 'delegation', 'approval', 'run', 'verdict', 'driver']);

/** 샤딩하지 않는 원장. 임대는 폐기했지만 이미 쌓인 기록이 남아 있다. */
const FLAT_LEDGERS = Object.freeze(['lease']);

const REF_KINDS = Object.freeze(['branch', 'pr', 'issue', 'other']);

/** 관례적 기본 브랜치 이름. 원격이 HEAD를 알려주지 않을 때만 쓴다. */
const CONVENTIONAL_PRIMARY = Object.freeze(['main', 'master', 'trunk']);

const ASSET_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// ── 식별자 표기 ─────────────────────────────────────────────────────────

/**
 * 원장 식별자의 표기. 여덟 파일이 같은 정규식을 각자 적고 있었고, check.js는
 * 파일명 패턴 안에 문자열로 한 번 더 적었다. 표기를 바꿀 일이 생기면 그 아홉 곳이
 * 함께 바뀌어야 하는데, 아홉 곳이라는 사실을 아는 사람이 없었다.
 */
const ID_PATTERNS = Object.freeze({
  run: 'RUN-[A-F0-9]{20}',
  event: 'EVT-[A-F0-9]{20}',
  request: 'REQ-[A-F0-9]{20}',
  member: 'MEMBER-\\d{3}'
});

/**
 * 제품 브랜치의 .gitignore가 들고 있어야 하는 추적 제외 규칙. 프로젝트 문서 worktree와
 * 코드 작업 worktree의 자리이며, 이 규칙이 있어야 저장소 안에 worktree를 둘 수 있다.
 *
 * 목록으로 두는 이유는 같은 두 경로를 쓰는 곳이 하나가 아니기 때문이다. attach.js는
 * 옛 저장소를 위해 info/exclude에도 같은 규칙을 쓴다 — 두 곳이 각자 문자열을 들고 있으면
 * 한쪽만 고쳐지는 날이 온다.
 */
const WORKTREE_IGNORE_RULES = Object.freeze(['/projects/*/', '.rundol/']);

/**
 * 제품 코드가 사는 경로. 본 작업 트리에서 이 아래를 고치려 할 때 훅이 막는다.
 *
 * 목록으로 두는 이유는 막는 자리가 하나가 아니기 때문이다. 훅이 쓰기 전에 막고,
 * 사람이 만든 pre-commit이 커밋에서 막는다면 둘은 같은 목록을 봐야 한다.
 */
const CODE_PATH_PREFIXES = Object.freeze([
  // 실행되는 코드
  'src/', 'bin/', 'packages/', 'scripts/',
  // 에이전트의 행동 계약. rdl skill install이 이것을 세 클라이언트의 홈에 복사하므로,
  // 한 줄을 고치면 그 저장소를 쓰는 모든 에이전트의 판단이 바뀐다. 실행되는 코드보다
  // 파급이 넓으면 넓었지 좁지 않다.
  'skills/',
  // 무엇이 언제 npm에 올라가는지를 정하는 자리. 실려 나가지는 않지만 실려 나가는 것을
  // 결정한다.
  '.github/',
  // 시험은 통제가 실제로 서 있는지를 판정하는 층이다. 여기가 자유로우면 통제를 지우는
  // 가장 조용한 길이 검사를 고치는 것이 된다.
  'test/'
  // docs/는 넣지 않는다. 이 저장소에서는 검사가 문서와 명령의 일치를 판정하지만 그것은
  // Rundol 자신의 결합이고, 이 목록은 Rundol을 쓰는 모든 프로젝트에 실려 나가는 기본값이다.
  // 남의 저장소에서 문서 한 줄 고치는 데 브랜치를 요구하는 것은 이 도구가 정할 일이 아니다.
]);

/**
 * 커밋 시점의 경계를 세우는 Git 훅. 브랜치와 경로는 메시지 없이 판정할 수 있어
 * pre-commit이 보고, 결박 트레일러는 메시지가 있어야 하므로 commit-msg가 본다.
 *
 * 목록으로 두는 이유는 설치와 진단이 같은 둘을 봐야 하기 때문이다. 하나만 서 있는
 * 상태를 어느 쪽도 알아채지 못하면 경계는 반쪽인 채로 초록이 된다.
 */
const COMMIT_BOUNDARY_HOOKS = Object.freeze(['pre-commit', 'commit-msg']);

// ── 하네스 훅 ──────────────────────────────────────────────────────────

/**
 * rdl hook이 받는 이벤트. 하네스가 부르는 이름이 아니라 Rundol이 판정하는 이름이며,
 * 클라이언트마다 다른 표기(PostToolUse / post-tool-use)를 여기 하나로 모은다.
 *
 * 클라이언트가 늘어도 이 목록은 늘지 않는다. Claude Code는 31종, Codex는 11종을
 * 내지만 Rundol이 판정하는 자리는 그 교집합 안의 넷뿐이다.
 */
const HOOK_EVENTS = Object.freeze(['session-start', 'pre-tool-use', 'post-tool-use', 'stop', 'session-end']);

/** 훅을 부르는 클라이언트. 페이로드 모양의 차이를 흡수할 때만 쓴다. */
const HOOK_CLIENTS = Object.freeze(['claude', 'codex']);

module.exports = Object.freeze({
  TASK_STATES,
  TASK_STATUS_ORDER,
  TERMINAL_TASK_STATES,
  OPEN_TASK_STATES,
  ACTIVE_TASK_STATES,
  TASK_PRIORITIES,
  TASK_KINDS,
  TEST_RESULTS,
  REGULAR_TYPES,
  IMPLEMENTATION_TYPES,
  RELATED_REQUIRED_TYPES,
  DOCUMENT_TYPE_KEYS,
  DOCUMENT_STATE_KEYS,
  PROFILE_NAMES,
  POLICY_STATES,
  ENFORCEMENTS,
  TRAITS,
  APPROVAL_MODES,
  BASIS_KINDS,
  VERDICTS,
  EXECUTORS,
  RUN_STATES,
  CHECKPOINT_TYPES,
  HALT_REASONS,
  SYNC_HALT_REASONS,
  OUTCOME_KINDS,
  WORK_EVENT_TYPES,
  WORKER_KINDS,
  CONSTRAINT_KINDS,
  EXEMPTABLE_GATES,
  FIELD_TYPES,
  DISPLAY_FIELDS,
  WORKSPACE_BRANCHES,
  SETTINGS_BRANCH,
  WORKSPACE_BRANCH,
  CLIENT_TYPES,
  LEDGERS,
  FLAT_LEDGERS,
  REF_KINDS,
  WORKTREE_IGNORE_RULES,
  CODE_PATH_PREFIXES,
  COMMIT_BOUNDARY_HOOKS,
  HOOK_EVENTS,
  HOOK_CLIENTS,
  CONVENTIONAL_PRIMARY,
  ASSET_EXTENSIONS,
  ID_PATTERNS
});
