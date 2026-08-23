// 워크플로 판정 계약. 상태 기계를 데이터로 내리는 설계의 값 표현이다.
//
// 이 파일이 존재하는 이유는 편의가 아니라 경계다. 값 목록은 src/vocabulary.js가
// 갖지만 그 파일은 "필드가 가질 수 있는 값"만 담고 필드의 이름은 담지 않기로
// 되어 있다. 시그니처와 레코드는 필드의 이름이므로 여기 온다 — types/assignment.d.ts가
// 검수 판정에 같은 일을 하고 있다.
//
// 이 파일이 어휘와 같은 커밋에 드는 이유는 갈래 때문이다. 스텝을 배선하는 갈래와
// 발화 이력을 심는 갈래와 런에 대상 종류를 다는 갈래는 담당 파일이 겹치지 않지만
// 이 계약을 공유한다. 계약이 합의로 남으면 한쪽이 조용히 넓힌 것이 병합에서야
// 드러나므로, 갈래보다 이것이 먼저 커밋된다.
//
// 여기서 필드를 늘릴 때는 그 값이 판정이나 계측에 필요한지 먼저 묻는다 — 판정에
// 쓰이지 않는 값은 표면의 몫이다.

/** src/vocabulary.js의 WORKFLOW_STEPS. 코드가 읽는 유일한 진행 축이다. */
export type WorkflowStep = 'unclaimed' | 'in-progress' | 'in-approval' | 'completed' | 'dropped';

/** src/vocabulary.js의 COMPLETION_VALIDITIES. completed 스텝에서만 뜻이 있다. */
export type CompletionValidity = 'valid' | 'retired';

/** src/vocabulary.js의 VALIDATION_SOURCE_KINDS. 무엇을 보는가. */
export type ValidationSource =
  | 'field'
  | 'link'
  | 'link-field'
  | 'acceptance-criteria'
  | 'dependency'
  | 'bundle-item'
  | 'composite';

/** src/vocabulary.js의 VALIDATION_METHODS. 어떻게 보는가. 진단 코드가 이 축에 붙는다. */
export type ValidationMethod =
  | 'present'
  | 'equals'
  | 'type'
  | 'range'
  | 'count'
  | 'every'
  | 'some'
  | 'unique';

/** src/vocabulary.js의 RULE_ORIGINS. 규칙이 항목 유형에 걸렸는지 전환에 걸렸는지. */
export type RuleOrigin = 'item-type' | 'transition';

/** src/vocabulary.js의 JUDGMENT_SURFACES. 같은 판정 함수를 부르는 네 표면. */
export type JudgmentSurface = 'cli' | 'board' | 'check' | 'adapter';

/**
 * 판정이 보는 항목. 태스크 또는 문서이며, 이미 읽혀서 값으로 들어온다.
 *
 * 안쪽 모양을 여기서 못박지 않는다. 항목의 필드는 프로젝트가 정의하는 것이고,
 * 여기 적으면 사용자가 정의한 것이 다시 코드가 된다. 판정이 보장받는 것은
 * "파일이 아니라 값이 들어온다"는 사실 하나다.
 */
export type JudgedItem = Readonly<Record<string, unknown>>;

/** 판정이 보는 행위자. 클라이언트 · 멤버 · 역할이 이미 해석되어 값으로 들어온다. */
export type JudgedActor = Readonly<Record<string, unknown>>;

/**
 * 막는 규칙 하나.
 *
 * 네 표면이 이것만 보고 사람에게 무엇을 고쳐야 하는지 말할 수 있어야 한다.
 * 말하지 못하면 표면마다 항목을 다시 뒤지게 되고, 다시 뒤진 것들은 조금씩 달라진다.
 */
export interface Blocker {
  /** 규칙의 식별자. 발화 이력이 이것으로 죽은 규칙과 작동하는 규칙을 가른다. */
  ruleId: string;
  /** 진단 코드. 규칙이 아니라 방법에 붙는다 — RDL-VAL-003. */
  code: string;
  /** 항상 참이어야 하는 규칙인지, 이 전환에만 걸린 규칙인지. 고치는 길이 다르다. */
  origin: RuleOrigin;
  source: ValidationSource;
  method: ValidationMethod;
  /** 무엇이 걸렸나. 항목 식별자와 경로 — TASK-XXXX.acceptanceCriteria. */
  target: string;
  /** 사람이 읽는 말. */
  message: string;
}

/**
 * 전환 판정. 명령줄 · 보드 · 검사기 · 어댑터 네 표면이 같은 이 함수를 부른다.
 *
 * from과 to는 워크플로 노드이며 프로젝트가 정의한 값이다. 판정은 그 문자열을
 * 리터럴과 비교하지 않는다 — 비교하는 순간 사용자가 정의한 값이 코드로 돌아온다.
 * 노드에서 스텝을 얻는 것은 워크플로 정의가 하고, 코드가 읽는 것은 스텝이다.
 *
 * 파일을 읽지 않는다. 네 표면은 각자 경로를 갖고 있고, 판정이 경로를 알면 각
 * 표면이 자기 경로로 다시 구현하게 되며 다시 구현한 것들은 조금씩 달라진다.
 * 그래서 항목과 행위자는 이미 읽힌 값으로 들어온다.
 *
 * 시각도 읽지 않는다. 인자에 시계가 없는 것이 그 강제다. 어제와 오늘의 답이
 * 다르면 재현되지 않고, 재현되지 않는 판정은 막힌 사람에게 무엇을 고쳐야 하는지
 * 말해 주지 못한다. 시각이 필요한 규칙은 항목에 이미 적힌 값으로만 답한다.
 *
 * 막는 규칙을 전부 돌려준다. 반환이 불리언이 아니라 목록인 것이 그 강제다.
 * 태스크 열두 건을 완료로 옮길 때 RDL-TASK-019가 먼저 막고 하나를 면제하자
 * RDL-IMPL-021이 다시 막았다 — 두 규칙이 같은 사실에서 나오는데 한 화면에
 * 보이지 않아 두 번 왕복했다. 처음 걸린 것에서 멈추면 그 왕복이 그대로 남는다.
 *
 * 빈 목록이 통과다. 면제된 규칙은 목록에 오지 않는다.
 */
export type TransitionJudgment = (
  from: string,
  to: string,
  item: JudgedItem,
  actor: JudgedActor
) => ReadonlyArray<Blocker>;

/** 면제되어 판정을 건너뛴 규칙. 면제는 검증이 아니라 별도 축이라 Blocker가 아니다. */
export interface ExemptedRule {
  ruleId: string;
  /** 면제된 게이트의 이름. EXEMPTABLE_GATES 중 하나다. */
  gate: string;
  reason: string;
  /** 면제를 결정한 멤버. 없으면 설정이 미리 면제한 것이다. */
  decidedBy: string | null;
}

/**
 * 발화 이력 한 줄. 판정 함수 호출 하나가 레코드 하나다.
 *
 * 이 이력이 답하는 물음은 "어느 규칙이 죽었나"이고, 답은 세 갈래다.
 *
 *   evaluated에 한 번도 안 나옴   그 소스가 아무 항목에도 없거나 그 전환을 아무도
 *                                 안 밟는다. 가장 강한 뜻의 죽은 규칙이다
 *   evaluated에는 나오는데
 *   blocked에 한 번도 안 나옴     한 번도 막은 적이 없다. 다들 지키는 규칙일 수도,
 *                                 판정이 늘 참인 규칙일 수도 있다 — 그 둘은 이력이
 *                                 아니라 사람이 가른다
 *   blocked에 나옴                작동하는 규칙이다
 *
 * 그래서 blocked만 남기지 않는다. 막은 것만 적으면 "한 번도 안 막은 규칙"과
 * "한 번도 안 불린 규칙"이 같은 침묵이 되고, 그 둘은 정반대의 뜻이다 —
 * 놓쳤다는 사실은 아무 신호도 내지 않는다.
 *
 * 판정 함수는 이 레코드를 만들지 않는다. 만들면 판정이 시각과 클라이언트를 알아야
 * 하고, 그 순간 파일도 시계도 안 읽는다는 계약이 깨진다. 부른 표면이 판정의 답을
 * 받아 적는다.
 */
export interface FiringRecord {
  /** 원장 공통. ID_PATTERNS.event 표기를 따른다. */
  eventId: string;
  /** 원장 공통. 기록한 시각이며 판정의 입력이 아니다. */
  at: string;
  /** 원장 공통. 샤드 파일명에 박히는 값과 같아야 한다. */
  clientId: string;
  /** 누가 물었나. 넷 중 하나가 여기 한 번도 안 나오면 그 표면은 판정을 따로 갖고 있다. */
  surface: JudgmentSurface;
  /** 무엇을 판정했나. 태스크 또는 문서의 식별자다. */
  target: string;
  /** 항목 유형 규칙만 물었는지, 전환을 물었는지. */
  origin: RuleOrigin;
  /** 워크플로 노드. origin이 item-type이면 둘 다 null이다. */
  from: string | null;
  to: string | null;
  /** 이번 판정이 실제로 본 규칙 전부. 죽은 규칙은 여기 안 나오는 것으로 드러난다. */
  evaluated: ReadonlyArray<string>;
  /** 그중 막은 것. 판정 함수가 돌려준 목록을 그대로 싣는다. */
  blocked: ReadonlyArray<Blocker>;
  /** 면제되어 건너뛴 것. 면제가 어느 규칙을 조용히 죽이고 있는지가 여기서 보인다. */
  exempted: ReadonlyArray<ExemptedRule>;
}
