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
 * 그쪽 어휘는 아래 EXECUTION_UNIT_KINDS가 이름을 갖는다.
 */
const EXECUTORS = Object.freeze(['cli', 'llm', 'hybrid']);

// ── 워크플로 ────────────────────────────────────────────────────────────
//
// 상태 기계를 데이터로 내리는 설계의 닫힌 축이다. 상태 이름은 팀마다 다르므로
// 설정으로 나가고, 코드는 그 이름을 모른 채 아래 목록만 읽는다.
//
// 이 축들이 한 덩어리로 앉는 이유는 갈래가 여기서 뻗기 때문이다. 스텝을 표면에
// 배선하는 일과 검증 카탈로그를 세우는 일과 런에 대상 종류를 다는 일은 담당 파일이
// 한 개도 겹치지 않지만 셋 다 이 파일을 require한다 — 지금 이 파일을 직접
// require하는 것이 23개이고 그 셋의 담당 파일 다섯이 그 안에 있다. 그래서 갈래는
// 파일이 아니라 어휘에서 갈라진다. 말로 맞춘 어휘는 한쪽이 조용히 넓힌 것이
// 병합에서야 드러나므로, 목록이 갈래보다 먼저 커밋된다.
//
// 값은 여기 다 있고 판정은 아직 아무 데도 없다. 그것이 이 상태의 정의다.
// 시그니처와 레코드 모양은 값이 아니라 필드 이름이므로 types/workflow.d.ts가 갖는다.

/**
 * 워크플로 스텝. 코드가 읽는 유일한 진행 축이며 이 다섯이 전부다.
 *
 *   unclaimed    아직 아무도 안 잡음
 *   in-progress  지금 누군가 붙어 있음
 *   in-approval  다른 행위자의 동의를 기다림
 *   completed    성취로 끝남 — COMPLETION_VALIDITIES 축을 갖는다
 *   dropped      하지 않기로 하고 끝남
 *
 * 상태 이름(todo · 배포완료)은 프로젝트가 정의하는 값이 되고, 그 이름 하나하나가
 * 이 다섯 중 하나에 매핑된다. 코드는 매핑된 스텝만 본다. 지금 src/ 안에서 상태
 * 이름을 문자열로 비교하는 33곳 중 "끝났나 · 붙어 있나 · 아직 안 잡았나"를 묻는
 * 11곳이 이 목록으로 답한다.
 *
 * 여섯으로 늘리지 않는다. 태스크가 안 쓰는 칸을 만들면 그 칸은 죽는다 —
 * DOCUMENT_STATE_KEYS 여덟 중 다섯(review · approved · deprecated · archived ·
 * unread)이 정본 문서 127건에서 0건인 것이 그 결과이고, 반대로 어휘에 없는
 * accepted가 12건 살아 있다. 칸을 늘리는 쪽이 아니라 축을 붙이는 쪽으로 푼다.
 *
 * 이름을 지금 쓰는 상태값과 일부러 하나도 겹치지 않게 지었다. 겹치면 배선이 끝난
 * 뒤에도 `=== 'done'`이 그대로 컴파일되고 통과해서, 그 줄이 스텝으로 옮겨진 것인지
 * 빠뜨린 것인지 아무도 구분하지 못한다. 33곳이 실제로 사라졌는지 확인할 방법이
 * 남아 있어야 한다. 겹치지 않는다는 사실은 vocabulary.test.js가 못박는다.
 */
const WORKFLOW_STEPS = Object.freeze(['unclaimed', 'in-progress', 'in-approval', 'completed', 'dropped']);

/**
 * 끝난 스텝. 완료와 취소는 이유가 다르지만 "더 손대지 않는다"는 점에서 같고,
 * 선행 판정과 목록 필터는 그 점만 본다. TERMINAL_TASK_STATES가 상태 이름으로
 * 답하던 물음을 이쪽이 스텝으로 답한다.
 */
const TERMINAL_WORKFLOW_STEPS = Object.freeze(['completed', 'dropped']);

/**
 * 아직 끝나지 않은 스텝. 끝난 것의 여집합으로 계산한다 — 목록으로 적어 두면 축이
 * 바뀔 때 여기 넣는 것을 잊을 수 있고, 잊으면 새 스텝이 조용히 "끝난 것"이 된다.
 */
const OPEN_WORKFLOW_STEPS = Object.freeze(WORKFLOW_STEPS.filter((step) => !TERMINAL_WORKFLOW_STEPS.includes(step)));

/** 지금 누군가 붙어 있는 스텝. 열린 것 중 아직 아무도 잡지 않은 unclaimed를 뺀 것이다. */
const ACTIVE_WORKFLOW_STEPS = Object.freeze(OPEN_WORKFLOW_STEPS.filter((step) => step !== 'unclaimed'));

/**
 * 완료의 유효성. completed 스텝에서만 뜻이 있고 나머지 넷에는 없다.
 *
 * 문서는 끝난 뒤에도 산다. deprecated는 "안 하기로 함"이 아니라 "했지만 이제 안
 * 씀"이므로 dropped가 아니라 completed에 속하고, 그 안에서 이 축이 유효와 폐기를
 * 가른다. 이 축이 없으면 폐기 문서를 취소로 접게 되는데, 취소는 성취를 지운다.
 */
const COMPLETION_VALIDITIES = Object.freeze(['valid', 'retired']);

/**
 * 검증 소스의 종류. 무엇을 보는가다.
 *
 *   field                필드 하나
 *   link                 links[유형]
 *   link-field           링크된 항목의 필드 — links[TST].result
 *   acceptance-criteria  태스크 수용조건
 *   dependency           선행 태스크
 *   bundle-item          묶음(워크셋 · 릴리스)의 항목
 *   composite            필드와 링크의 조합 — unique의 대상
 *
 * 검사를 평평한 "종류" 목록으로 두면 새 검사가 필요할 때마다 목록이 는다. 소스와
 * 방법으로 가르면 목록은 안 늘고 조합만 는다. "수용조건 전부 done", "묶음의 태스크
 * 전부 종료", "링크된 TST 전부 pass", "선행 태스크 전부 종료" 넷은 평평한 모델에서
 * 종류 넷이지만 여기서는 방법 하나(every) × 소스 넷이다 — 그리고 뒤의 둘은 지금
 * 표현조차 되지 않는다.
 *
 * CONSTRAINT_KINDS 다섯 중 넷이 이 축과 VALIDATION_METHODS로 분해될 자리다.
 */
const VALIDATION_SOURCE_KINDS = Object.freeze([
  'field', 'link', 'link-field', 'acceptance-criteria', 'dependency', 'bundle-item', 'composite'
]);

/** 소스의 성질. 어떤 방법을 쓸 수 있는지를 이것이 정한다. */
const VALIDATION_SOURCE_NATURES = Object.freeze(['scalar', 'collection', 'link', 'composite']);

/**
 * 소스마다의 성질. 조합의 가부를 소스 × 방법 표로 적지 않는 이유는 그 표가 소스
 * 하나에 방법 수만큼 늘기 때문이다. 성질을 거치면 소스 하나에 한 줄이다.
 *
 * 성질이 안 맞는 조합(unique × acceptance-criteria)은 설정 파싱에서 거부된다.
 * item-type.js가 알 수 없는 키를 파일 경로와 키 경로와 이유까지 붙여 거부하는
 * 방식 그대로이며, 판정 시점까지 끌고 가지 않는다.
 */
const VALIDATION_SOURCE_NATURE = Object.freeze({
  field: 'scalar',
  link: 'link',
  'link-field': 'link',
  'acceptance-criteria': 'collection',
  dependency: 'collection',
  'bundle-item': 'collection',
  composite: 'composite'
});

/**
 * 검증 방법. 어떻게 보는가다.
 *
 *   present  채워짐
 *   equals   값이 일치함
 *   type     선언한 타입임
 *   range    선언한 범위 안임
 *   count    개수가 min~max 안임
 *   every    원소가 모두 만족함
 *   some     원소가 하나라도 만족함
 *   unique   프로젝트 안에서 유일함
 *
 * 진단 코드는 이 축에 붙는다. 소스가 열 종이어도 코드는 여덟이고, 어느 소스가
 * 걸렸는지는 코드가 아니라 진단의 대상이 나른다. 코드 목록이 소스마다 늘면
 * 어제 본 코드가 오늘 없을 수 있고, 그런 목록은 문서도 도구도 참조할 수 없다.
 *
 * exempt는 여기 없다. 면제는 검증이 아니라 판정을 건너뛰는 것이라 분해되지 않고
 * 별도 축에 남는다.
 */
const VALIDATION_METHODS = Object.freeze(['present', 'equals', 'type', 'range', 'count', 'every', 'some', 'unique']);

/**
 * 성질마다 쓸 수 있는 방법. 컬렉션과 링크가 같은 셋을 갖는 것은 우연이 아니라
 * 지금 그 둘을 가르는 규칙이 없기 때문이다 — 갈리는 날이 오면 그때 갈린다.
 */
const VALIDATION_METHODS_BY_NATURE = Object.freeze({
  scalar: Object.freeze(['present', 'equals', 'type', 'range']),
  collection: Object.freeze(['count', 'every', 'some']),
  link: Object.freeze(['count', 'every', 'some']),
  composite: Object.freeze(['unique'])
});

/**
 * 규칙이 걸린 자리. 카탈로그는 하나이고 걸리는 자리가 둘이다 — 규칙이 두 군데
 * 사는 것이 아니라 한 카탈로그가 두 자리에 걸린다.
 *
 *   item-type   항상 참이어야 함 — 검증 유형은 TST를 정확히 하나 링크한다
 *   transition  그 전환을 밟을 때만 — 완료로 가려면 수용조건이 전부 done
 *
 * 막힌 사람에게 이 구분이 필요하다. 항상 참이어야 하는 것은 지금 고쳐야 하고,
 * 전환에만 걸린 것은 다른 전환으로 갈 수도 있다.
 */
const RULE_ORIGINS = Object.freeze(['item-type', 'transition']);

/**
 * 판정을 부르는 표면. 네 표면이 같은 판정 함수를 부른다는 것이 이 설계의 전제이고,
 * 발화 이력이 이 값을 함께 남기므로 그 전제가 실제로 서 있는지를 나중에 물을 수 있다.
 * 넷 중 하나가 이력에 한 번도 안 나오면 그 표면은 자기 판정을 따로 갖고 있는 것이다.
 *
 * cli · adapter는 EXECUTION_UNIT_KINDS와 글자가 같지만 다른 필드의 값이다. 한쪽은
 * "누가 물었나"이고 다른 쪽은 "무엇이 실행되나"다.
 */
const JUDGMENT_SURFACES = Object.freeze(['cli', 'board', 'check', 'adapter']);

/**
 * 실행 단위의 종류. 전환의 슬롯이 이 중 하나로 컴파일된다.
 *
 *   gate     항목만 보고 답한다
 *   client   사람이나 에이전트가 새로 댈 값이 있다
 *   cli      항목 밖을 바꾼다
 *   adapter  항목 밖을 바꾼다
 *   human    다른 행위자의 동의를 기다린다
 *
 * 이 다섯은 지금 procedure.js의 stepClass()가 함수 안에서 반환하는 문자열로만
 * 존재한다. 목록이 아니라 분기라서 두 번째 선언을 막는 어휘 시험의 스캐너에도
 * 잡히지 않았다 — "값 목록은 전부 여기 있다"가 새는 모양이 이것이다.
 *
 * 승인은 마스터가 아니라 이 목록의 한 값이다. 전환과 실행 단위 사이의 N:M 하나가
 * 입력 · 검증 · 수행 · 승인을 다 태우므로 승인에 별도 관계를 두지 않는다. 승인
 * 기록은 런 스텝 기록의 한 행이고, 거기 판정(VERDICTS)과 근거(BASIS_KINDS)와
 * 행위자가 붙는다. 승인 정책은 APPROVAL_MODES가 이미 갖고 있으므로 다시 짓지 않는다.
 */
const EXECUTION_UNIT_KINDS = Object.freeze(['gate', 'client', 'cli', 'adapter', 'human']);

/**
 * 런을 열지 않는 종류. 경계는 "규칙이 있는가"가 아니라 "판정 함수가 혼자 답할 수
 * 없는 것이 있는가"로 긋는다. "규칙이 없으면 즉시"로 그으면 검증만 있는 전환이
 * 런을 열고, 그 런은 판정 함수가 이미 답한 것을 다시 묻는다.
 */
const JUDGMENT_ONLY_UNIT_KINDS = Object.freeze(['gate']);

/**
 * 런을 여는 종류. 여집합으로 계산한다 — 새 종류를 여기 넣는 것을 잊었을 때
 * 기록이 남는 쪽으로 기울어야 한다. 기록이 없는 실행은 나중에 물을 수 없다.
 */
const RUN_OPENING_UNIT_KINDS = Object.freeze(EXECUTION_UNIT_KINDS.filter((kind) => !JUDGMENT_ONLY_UNIT_KINDS.includes(kind)));

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

/**
 * 같은 밀리초에 기록된 사건들의 순서. 기록 시각만으로는 순서가 갈리지 않고,
 * 그때 무엇으로 가르느냐가 접기의 답을 바꾼다 — 무작위 식별자로 가르면 보고가
 * 발급보다 앞서고, 앞선 보고는 가리킬 할당이 없어 버려진다.
 *
 * 그래서 시각이 같을 때는 인과가 가른다. 있어야 가리킬 수 있고, 접수되어야
 * 판정할 수 있고, 판정되어야 닫힌다. 이 목록의 자리가 그 순서다.
 *
 * WORK_EVENT_TYPES와 집합이 같아야 한다. 갈리면 새 유형이 순서 없이 들어오고,
 * 순서 없는 유형은 다시 무작위로 갈린다 — 어휘 시험이 그것을 지킨다.
 */
const WORK_EVENT_CAUSAL_ORDER = Object.freeze([
  'assignment.issued', 'assignment.rejected',
  'report.submitted', 'report.rejected',
  'report.verified',
  'assignment.closed'
]);

/** 워커의 종류. 사람과 에이전트는 같은 계층이며 이 값은 전달 경로만 정한다. */
const WORKER_KINDS = Object.freeze(['human', 'agent']);

// ── 업무 유형 ───────────────────────────────────────────────────────────

/**
 * 제약의 종류. 넷(fields · requiresLink · requiredWhen · unique)은
 * VALIDATION_SOURCE_KINDS와 VALIDATION_METHODS로 분해될 자리이고, 분해가 끝나면
 * exempt만 남는다 — 면제는 검증이 아니라 판정을 건너뛰는 것이라 분해되지 않는다.
 */
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

/**
 * 샤딩되는 원장. event-store.js의 KINDS와 같은 등록부의 두 쪽이고, 이쪽은 무엇이
 * 추가 전용 검사의 대상인지를 정한다.
 *
 * firing은 제약과 전환의 발화 이력이다. 아직 어느 파일도 그 이름을 갖지 않는데
 * 먼저 여기 두는 이유는, 이력을 심는 갈래가 이 파일을 건드리지 않고 뻗을 수
 * 있어야 하기 때문이다 — 그 갈래는 event-store.js의 KINDS에 같은 이름을 등록하고
 * 샤드를 쓰기 시작한다. 없는 이름은 아무 파일에도 맞지 않으므로 오늘의 판정은
 * 달라지지 않는다. 레코드의 모양은 types/workflow.d.ts의 FiringRecord다.
 *
 * 이력을 원장에 두는 이유는 물음이 프로젝트 전체의 것이기 때문이다. "이 규칙이
 * 한 번도 안 불렸나"는 내 기계에서만 세면 답이 나오지 않는다. 로컬 계측으로 두면
 * 각자 자기 침묵만 보게 되고, 침묵은 원래 아무 신호도 내지 않는다.
 *
 * 두 쪽이 실제로 갈려 있다 — KINDS에는 comment와 assignment가 있는데 여기에는
 * 없고, 그래서 그 두 원장의 샤드는 isLedgerShard가 알아보지 못한다. 고치면 추가
 * 전용 판정의 대상이 늘어나므로 목록만 두는 이 커밋의 몫이 아니다.
 */
const LEDGERS = Object.freeze(['decision', 'delegation', 'approval', 'run', 'verdict', 'driver', 'firing']);

/** 샤딩하지 않는 원장. 임대는 폐기했지만 이미 쌓인 기록이 남아 있다. */
const FLAT_LEDGERS = Object.freeze(['lease']);

const REF_KINDS = Object.freeze(['branch', 'pr', 'issue', 'other']);

/** 관례적 기본 브랜치 이름. 원격이 HEAD를 알려주지 않을 때만 쓴다. */
const CONVENTIONAL_PRIMARY = Object.freeze(['main', 'master', 'trunk']);

const ASSET_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// ── 서브 ────────────────────────────────────────────────────────────────
//
// 문서와 태스크의 정형화된 세부항목에 부모를 다는 축이다. 마스터 열둘 중 닫힌
// 다섯의 마지막이고, 닫히는 것은 종류 코드뿐이다 — 부모도 일련도 데이터다.
//
// 지금 이 자리가 가장 느슨하다. 정본 문서가 선언한 고유 기능 ID는 56개인데 그
// 앞자리는 19종이고(HRN 11 · TSK 6 · BRD 5 · DCP 5 …) 어휘도 검사도 없다. 새
// 요구를 쓸 때마다 사람이 세 글자를 짓는다. 형태가 AAA-99로 100% 일치하는 것은
// 관행이 있을 뿐 강제가 없어서이고, 중복도 고아도 0건인 것 역시 규칙이 막아서가
// 아니다. "임의로 관리되고 있다"가 정확히 이 모양이다.
//
// 부모가 없어서 진단이 둘 서 있다. RDL-IMPL-009는 기능 ID가 여러 REQ에 중복
// 정의되는 것을 막고, RDL-IMPL-011은 REQ 원천 계약 없이 하위 산출물이 참조하는
// 것을 막는다. 둘 다 범위가 전역이다. 반면 시나리오는 이미 부모를 달고 있어서
// (TST-017#S-03) 같은 성격의 RDL-SCENARIO-003은 문서 하나만 본다. 셋째가 답이다 —
// 이 어휘는 규칙을 더하는 것이 아니라 한쪽만 어긋나 있던 것을 맞추는 것이고,
// 부모를 달면 중복이 검사로 막히는 것이 아니라 애초에 일어나지 못한다.
//
// 값은 여기 다 있고 판정은 아직 아무 데도 없다. 그것이 이 상태의 정의다.
// 레코드의 모양은 값이 아니라 필드 이름이므로 types/sub.d.ts가 갖는다.

/**
 * 서브 종류. 세부항목이 부모 아래에서 자기를 가리킬 때 쓰는 닫힌 축이다.
 *
 *   FN  기능      REQ가 선언하고 하위 산출물이 참조한다 — REQ-033#FN-001
 *   SC  시나리오  검증 문서가 선언한다 — TST-017#SC-003
 *   AC  수용조건  태스크가 선언한다 — TASK-XXXX#AC-001
 *
 * 종류만 코드가 소유하는 이유는 문서 코드와 개발 코드를 가른 선 그대로다. 부모
 * 문서 유형은 프로젝트가 정의하지만 서브 종류는 팀이 달라도 같아야 도구가 참조한다.
 *
 * 두 글자인 것은 우연이 아니다. 정규 문서 유형은 세 글자(REQ · TST …)이므로 두
 * 글자로 두면 FN-001이 문서 식별자로 읽힐 길이 없다. 겹치면 참조에서 부모의 경계를
 * 찾을 수 없고, 경계를 못 찾으면 부모를 달았다는 사실 자체가 뜻을 잃는다.
 * 겹치지 않는다는 사실은 vocabulary.test.js가 못박는다.
 *
 * 늘리는 것은 코드를 고치는 일이다. 사람이 세 글자를 짓던 자리를 닫는 것이 이
 * 목록의 목적이므로, 새 종류가 필요하면 여기서 한 번 검토된 뒤에 들어온다.
 */
const SUB_KINDS = Object.freeze(['FN', 'SC', 'AC']);

/**
 * 부모와 서브를 잇는 구분자. 시나리오가 이미 이 표기를 쓴다 — TST-017#S-03.
 *
 * 하이픈을 쓰지 않는 이유는 종류와 일련을 이미 하이픈이 가르기 때문이다.
 * REQ-033-FN-001로 적으면 어디까지가 부모인지 문자열만으로는 알 수 없다. 실제로
 * 지금 기능 ID를 훑는 정규식은 그 한 줄에서 REQ-033과 FN-001을 각각 독립된 ID로
 * 집어낸다 — 참조 하나가 ID 둘로 세어지는 것이다. 구분자가 다르면 그 모호함이
 * 생기지 않고, 그래서 이미 그렇게 쓰고 있는 시나리오의 표기를 넓힌다.
 */
const SUB_ID_SEPARATOR = '#';

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
  member: 'MEMBER-\\d{3}',
  /**
   * 서브 식별자의 문서 안 표기 — FN-001. 부모는 여기 없다. 문서 식별자든 태스크
   * 식별자든 그 형태는 프로젝트가 정하는 것이고, 여기 넣으면 사용자가 정의한 값이
   * 다시 코드가 된다. 문서 밖 표기는 이 앞에 부모와 SUB_ID_SEPARATOR를 붙인 것이다.
   *
   * 일련은 데이터이므로 번호는 정하지 않고 자릿수만 정한다. 자릿수를 열어 두면
   * FN-1과 FN-001이 같은 항목을 뜻하면서 문자열로는 다른 값이 되고, 그러면 부모를
   * 달아 없앤 중복이 표기 차이로 되돌아온다.
   */
  sub: `(?:${SUB_KINDS.join('|')})-\\d{3,}`
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
  WORKFLOW_STEPS,
  TERMINAL_WORKFLOW_STEPS,
  OPEN_WORKFLOW_STEPS,
  ACTIVE_WORKFLOW_STEPS,
  COMPLETION_VALIDITIES,
  VALIDATION_SOURCE_KINDS,
  VALIDATION_SOURCE_NATURES,
  VALIDATION_SOURCE_NATURE,
  VALIDATION_METHODS,
  VALIDATION_METHODS_BY_NATURE,
  RULE_ORIGINS,
  JUDGMENT_SURFACES,
  EXECUTION_UNIT_KINDS,
  JUDGMENT_ONLY_UNIT_KINDS,
  RUN_OPENING_UNIT_KINDS,
  RUN_STATES,
  CHECKPOINT_TYPES,
  HALT_REASONS,
  SYNC_HALT_REASONS,
  OUTCOME_KINDS,
  WORK_EVENT_TYPES,
  WORK_EVENT_CAUSAL_ORDER,
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
  SUB_KINDS,
  SUB_ID_SEPARATOR,
  ID_PATTERNS
});
