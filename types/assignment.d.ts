// 작업 할당 계약. REQ-048(WRK-01)의 값 표현이다.
//
// 이 파일이 존재하는 이유는 편의가 아니라 경계다. 할당과 보고가 값의 형태로
// 못박혀야 검수 판정이 파일을 모를 수 있고, 검수가 파일을 몰라야 명령줄과
// 보드와 워커 어댑터가 같은 답을 낸다. 여기서 필드를 늘릴 때는 그 값이
// 판정에 필요한지 먼저 묻는다 — 판정에 쓰이지 않는 값은 표면의 몫이다.

/** 워커의 종류. 사람과 에이전트는 같은 계층이며 이 값은 전달 경로만 정한다. */
export type WorkerKind = 'human' | 'agent';

export interface Worker {
  kind: WorkerKind;
  /** 워커 식별자. 사람은 MEMBER-ID, 에이전트는 클라이언트 식별자를 쓴다. */
  id: string;
}

/** 할당이 선언하는 수용 조건 하나. */
export interface AcceptanceCriterion {
  /** 할당 안에서 유일한 식별자. 보고는 이 식별자로 충족 여부를 말한다. */
  id: string;
  text: string;
}

/**
 * 절차 고정 참조. 이름이 아니라 다이제스트가 정본이다.
 * 절차 본문이 나중에 바뀌어도 이미 발급된 할당의 실행 내용은 변하지 않는다.
 */
export interface PinnedProcedure {
  name: string;
  revision: number;
  /** 고정 시점의 절차 내용 다이제스트. 재현성의 근거다. */
  digest: string;
}

/** 발급되어 열린 할당. 검수 판정이 받는 두 값 중 하나다. */
export interface Assignment {
  id: string;
  goal: string;
  acceptance: AcceptanceCriterion[];
  /**
   * 이 할당이 덮는 정규 문서의 기능 식별자. 비어 있으면 발급하지 않는다.
   * 요구 조항과 작업을 잇는 자리가 여기이며, 이 값이 없으면 근거 없는 작업이 된다.
   */
  functionIds: string[];
  /** 워커가 변경해도 되는 경로 패턴. 겹침 판정과 범위 위반 판정의 기준이다. */
  allowedPaths: string[];
  /** 이 할당에서 하지 않아야 할 일. 비어 있을 수 있다. */
  forbidden: string[];
  procedure: PinnedProcedure;
  /** 완료 보고가 따라야 할 스키마의 이름. */
  reportSchema: string;
  assignee: Worker;
  state: 'open' | 'closed';
}

/** 발급 요청. Assignment에서 발급이 채우는 값을 뺀 것이다. */
export interface AssignmentRequest {
  goal: string;
  acceptance: AcceptanceCriterion[];
  functionIds: string[];
  allowedPaths: string[];
  forbidden: string[];
  procedure: { name: string; revision: number };
  reportSchema: string;
  assignee: Worker;
}

/** 발급 거부 사유. 각 사유는 서로 구분되며 침묵하지 않는다. */
export type AssignmentRejectionCode =
  | 'missing-field'
  | 'missing-function-id'
  | 'unknown-function-id'
  | 'path-overlap'
  | 'procedure-unpinnable';

export interface AssignmentOverlap {
  /** 겹치는 열린 할당의 식별자. */
  assignmentId: string;
  /** 실제로 겹친 경로 패턴. 통제자가 다시 판단할 근거다. */
  paths: string[];
}

export interface AssignmentRejection {
  code: AssignmentRejectionCode;
  /** 비어 있는 필수 항목 이름. 첫 항목에서 멈추지 않고 모두 담는다. */
  missing: string[];
  /** 정규 문서에 선언되지 않은 기능 식별자. */
  unknownFunctionIds: string[];
  overlaps: AssignmentOverlap[];
}
