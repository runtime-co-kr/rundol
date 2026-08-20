// 작업 보고와 검수 판정 계약. REQ-049(WRK-02)와 REQ-050(WRK-03)의 값 표현이다.
//
// 사람이 쓰든 에이전트가 쓰든 보고는 이 하나의 형태다. 형태가 둘로 갈리면
// 검수 로직도 둘이 되고, 그 순간 두 워커는 같은 계층이 아니게 된다.

import type { Worker } from './assignment';

/** 보고가 주장하는 결과. 차단과 반려는 실패가 아니라 정의된 결과다. */
export type ReportOutcome = 'done' | 'blocked' | 'rejected';

/** 수용 조건 하나에 대한 워커의 주장. */
export interface AcceptanceClaim {
  /** 할당이 선언한 수용 조건의 식별자. */
  id: string;
  met: boolean;
  /**
   * 충족을 뒷받침하는 증거 참조. 검수는 이 값의 존재를 보며 가리키는 산출물을 열지 않는다.
   * met가 true인데 비어 있으면 반려다 — 선언만으로 충족을 인정하지 않는다.
   */
  evidence: string;
}

/** 접수된 보고. 검수 판정이 받는 두 값 중 하나다. */
export interface Report {
  id: string;
  assignmentId: string;
  worker: Worker;
  outcome: ReportOutcome;
  /** 할당이 선언한 수용 조건 전부를 언급해야 한다. 침묵으로 충족을 주장할 수 없다. */
  claims: AcceptanceClaim[];
  /** 워커가 바꾼 경로 또는 산출물 식별자. 범위 위반 판정의 대상이다. */
  changed: string[];
  /** 실제로 사용한 절차의 다이제스트. 할당의 고정 값과 다르면 사람 판단 대상이다. */
  procedureDigest: string;
  /** outcome이 blocked 또는 rejected이면 필수. */
  reason?: string;
  /** 워커가 스스로 밝힌 금지 항목 위반. 밝히면 반려한다. */
  forbiddenTouched?: string[];
}

/** 제출 계약을 갖추지 못한 보고의 접수 거부 사유. */
export type ReportRejectionCode =
  | 'missing-field'
  | 'unclaimed-acceptance'
  | 'missing-reason'
  | 'assignment-closed'
  | 'not-assignee';

export interface ReportRejection {
  code: ReportRejectionCode;
  missing: string[];
  /** 보고가 언급하지 않은 수용 조건 식별자. */
  unclaimed: string[];
}

// ── 검수 판정 ────────────────────────────────────────────────────────────
//
// 아래 값은 오직 Assignment와 Report에서만 파생된다. 시각도 난수도 환경 변수도
// 입력이 아니다. 같은 두 값이면 언제 어디서 호출해도 같은 판정이 나와야 한다.

/**
 * 판정 구분. 셋 모두 정상 결과이며 오류가 아니다.
 * 판정할 수 없는 입력은 판정 구분이 아니라 예외로 알린다.
 */
export type VerdictDecision = 'pass' | 'reject' | 'needs-human';

/** 기계가 판정할 수 있는 실패 사유. */
export type BlockCode =
  | 'unmet-acceptance'
  | 'missing-evidence'
  | 'path-out-of-scope'
  | 'forbidden-touched';

export interface Block {
  code: BlockCode;
  /** 막힌 대상. 수용 조건 식별자 또는 변경 대상 경로다. */
  target: string;
}

/** 기계가 판정하지 않고 사람에게 넘기는 사유. */
export type HumanReasonCode = 'worker-blocked' | 'worker-rejected' | 'procedure-mismatch';

export interface HumanReason {
  code: HumanReasonCode;
  /** 워커가 남긴 사유 또는 불일치 설명. */
  detail: string;
  /** procedure-mismatch일 때 할당의 고정 다이제스트. */
  expectedDigest?: string;
  /** procedure-mismatch일 때 보고가 밝힌 다이제스트. */
  actualDigest?: string;
}

/**
 * 검수 판정 결과.
 * blocks가 비지 않으면 decision은 reject다 — 기계가 판정할 수 있는 실패가
 * 사람 판단보다 앞선다.
 */
export interface Verdict {
  decision: VerdictDecision;
  blocks: Block[];
  humanReasons: HumanReason[];
}
