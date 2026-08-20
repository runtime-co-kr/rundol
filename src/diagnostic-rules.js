'use strict';

// 진단 코드에서 그 규칙의 정본 문서로 가는 지도.
//
// 지금까지 진단은 코드와 메시지만 내보냈다. 그래서 `RDL-IMPL-018`이 왜 존재하는지
// 알려면 검사기 소스를 뒤져야 했고, 반대로 요구를 고칠 때 어떤 진단이 영향을 받는지도
// 알 수 없었다. 추적성을 계산으로 유지한다면서 정작 규칙에서 근거로 가는 링크가
// 비어 있었던 셈이다.
//
// 이 모듈은 값만 보고 답한다 — 코드 문자열을 받아 문서와 기능 식별자를 돌려줄 뿐이다.
// 파일을 읽지 않으므로 명령줄과 보드와 지속적 통합이 같은 답을 얻는다.
//
// 계열 전체를 한 덩어리로 붙이지 않는다. 같은 계열 안에서도 소관이 갈리기 때문이다 —
// 태스크 계열은 생성·전환·결박 셋으로, 결정 계열은 요청·응답과 권한 경계 둘로 나뉜다.
// 코드가 실제로 무엇을 판정하는지를 보고 나눠야 역방향 계산이 쓸모 있어진다.
//
// 모르는 코드에 억지로 문서를 붙이지 않는다 — 틀린 근거는 근거가 없는 것보다 나쁘고,
// 그걸 보고 엉뚱한 문서를 고치게 된다. 테스트 태스크 계열(026~032)처럼 소관을 아직
// 확인하지 못한 것은 비워 둔다.

const RULES = Object.freeze({
  // 문서 계약 평가: 필수·권장·비활성 상태와 그 위반 판정
  'RDL-PROFILE-001': { document: 'REQ-026', functionId: 'DCP-02' },
  'RDL-PROFILE-002': { document: 'REQ-026', functionId: 'DCP-02' },
  'RDL-PROFILE-003': { document: 'REQ-026', functionId: 'DCP-02' },
  'RDL-PROFILE-004': { document: 'REQ-026', functionId: 'DCP-02' },
  'RDL-PROFILE-009': { document: 'REQ-026', functionId: 'DCP-02' },
  // 프리셋 상속 해석: 옛 계약이 들고 있던 설정의 이관
  'RDL-PROFILE-008': { document: 'REQ-027', functionId: 'DCP-03' },
  'RDL-PROFILE-012': { document: 'REQ-027', functionId: 'DCP-03' },
  'RDL-PROFILE-013': { document: 'REQ-027', functionId: 'DCP-03' },

  // 구현 문서 계약 검사: 기능별 슬롯이 실제로 채워졌는지
  'RDL-IMPL-001': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-002': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-003': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-004': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-005': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-006': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-007': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-009': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-010': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-011': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-013': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-014': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-015': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-016': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-017': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-IMPL-018': { document: 'REQ-034', functionId: 'HRN-02' },
  // 업무 유형 제약. 진단 코드는 제약 종류마다 하나이고 유형에 따라 늘지 않는다 —
  // 코드 목록이 설정에 따라 달라지면 문서와 도구가 그것을 따라갈 수 없다.
  'RDL-ITEM-001': { document: 'REQ-063', functionId: 'ITM-02' },
  'RDL-ITEM-002': { document: 'REQ-063', functionId: 'ITM-02' },
  'RDL-ITEM-003': { document: 'REQ-063', functionId: 'ITM-02' },
  'RDL-ITEM-004': { document: 'REQ-063', functionId: 'ITM-02' },
  'RDL-ITEM-005': { document: 'REQ-063', functionId: 'ITM-02' },
  'RDL-ITEM-006': { document: 'REQ-063', functionId: 'ITM-02' },
  // 유형별 계약도 같은 검사의 소관이다. REQ-034가 "각 기능의 유형별 필드를 모두
  // 검사한다"이므로, 시험 문서의 시나리오 표와 화면·모델 문서의 다이어그램 규칙은
  // 별도 규칙이 아니라 그 유형의 계약이 무엇인지를 말하는 조항이다.
  'RDL-SCENARIO-001': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-SCENARIO-002': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-SCENARIO-003': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-SCENARIO-004': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-SCREEN-001': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-SCREEN-002': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-SCREEN-003': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-SCREEN-004': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-MODEL-001': { document: 'REQ-034', functionId: 'HRN-02' },
  'RDL-MODEL-002': { document: 'REQ-034', functionId: 'HRN-02' },
  // 계산형 기능 추적성: 기능 식별자를 REQ와 TST가 함께 덮는지
  'RDL-IMPL-012': { document: 'REQ-036', functionId: 'HRN-04' },
  // 구현 준비도 태스크 게이트: 태스크가 구현에 들어가도 되는지
  'RDL-IMPL-020': { document: 'REQ-035', functionId: 'HRN-03' },
  'RDL-IMPL-021': { document: 'REQ-035', functionId: 'HRN-03' },
  'RDL-IMPL-022': { document: 'REQ-035', functionId: 'HRN-03' },

  // 태스크 생성과 샤드 저장: 저장소를 읽고 태스크의 정체를 확인한다
  'RDL-TASK-001': { document: 'REQ-017', functionId: 'TSK-01' },
  'RDL-TASK-002': { document: 'REQ-017', functionId: 'TSK-01' },
  'RDL-TASK-003': { document: 'REQ-017', functionId: 'TSK-01' },
  'RDL-TASK-004': { document: 'REQ-017', functionId: 'TSK-01' },
  'RDL-TASK-005': { document: 'REQ-017', functionId: 'TSK-01' },
  'RDL-TASK-022': { document: 'REQ-017', functionId: 'TSK-01' },
  // 태스크 상태와 완료 전환: 상태·담당·링크·완료조건·반려의 판정
  'RDL-TASK-006': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-007': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-008': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-009': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-010': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-011': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-012': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-013': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-014': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-015': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-016': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-017': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-018': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-019': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-020': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-021': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-023': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-024': { document: 'REQ-018', functionId: 'TSK-02' },
  'RDL-TASK-025': { document: 'REQ-018', functionId: 'TSK-02' },
  // 작업의 태스크 결박: 커밋이 어느 태스크의 일인지
  'RDL-TASK-031': { document: 'REQ-046', functionId: 'TSK-04' },
  'RDL-TASK-033': { document: 'REQ-046', functionId: 'TSK-04' },
  'RDL-TASK-034': { document: 'REQ-046', functionId: 'TSK-04' },

  // 사람 결정 요청과 응답
  'RDL-DEC-010': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-011': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-012': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-013': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-014': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-015': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-016': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-017': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-018': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-019': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-022': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-023': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-024': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-025': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-027': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-028': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-029': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-030': { document: 'REQ-039', functionId: 'DEC-01' },
  'RDL-DEC-031': { document: 'REQ-039', functionId: 'DEC-01' },
  // 결정 위임과 권한 경계: 그 주체가 이 결정을 할 수 있는가
  'RDL-DEC-002': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DEC-020': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DEC-021': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DEC-026': { document: 'REQ-040', functionId: 'DEC-02' },
  // 위임 이벤트의 형식과 수임 주체 판정도 같은 결정의 소관이다
  'RDL-DLG-010': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-011': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-012': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-013': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-014': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-015': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-016': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-017': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-018': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-020': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-021': { document: 'REQ-040', functionId: 'DEC-02' },
  'RDL-DLG-022': { document: 'REQ-040', functionId: 'DEC-02' },

  // 검증 판정의 독립성: 한 검증기의 결과가 다른 검증기를 물들이지 않는지
  'RDL-VERDICT-001': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-002': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-003': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-004': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-010': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-011': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-012': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-013': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-014': { document: 'REQ-042', functionId: 'HRN-07' },
  'RDL-VERDICT-015': { document: 'REQ-042', functionId: 'HRN-07' },

  // 브랜치와 worktree 경계: 무엇이 어느 ref를 소유하는가
  'RDL-BRANCH-001': { document: 'REQ-037', functionId: 'HRN-05' },
  'RDL-BRANCH-002': { document: 'REQ-037', functionId: 'HRN-05' },
  'RDL-BRANCH-003': { document: 'REQ-037', functionId: 'HRN-05' },
  'RDL-BRANCH-004': { document: 'REQ-037', functionId: 'HRN-05' },
  'RDL-BRANCH-005': { document: 'REQ-037', functionId: 'HRN-05' },
  // push 차단도 같은 경계를 지키는 장치다. 경계를 정한 문서가 하나이므로 소관도 하나다
  'RDL-PUSH-001': { document: 'REQ-037', functionId: 'HRN-05' },
  'RDL-PUSH-002': { document: 'REQ-037', functionId: 'HRN-05' },
  'RDL-PUSH-003': { document: 'REQ-037', functionId: 'HRN-05' },

  // 협업 클라이언트 등록: 실행 주체의 정체와 상태
  'RDL-CLIENT-001': { document: 'REQ-019', functionId: 'COL-01' },
  'RDL-CLIENT-002': { document: 'REQ-019', functionId: 'COL-01' },
  'RDL-CLIENT-003': { document: 'REQ-019', functionId: 'COL-01' },
  'RDL-CLIENT-004': { document: 'REQ-019', functionId: 'COL-01' },
  'RDL-CLIENT-005': { document: 'REQ-019', functionId: 'COL-01' },

  // 그림 자산: 참조 해결과 규격 한계. 들여오기(AST-03)는 절차라 진단을 내지 않고
  // 그 자리에서 예외로 알리므로 여기 없다.
  'RDL-ASSET-001': { document: 'REQ-052', functionId: 'AST-01' },
  'RDL-ASSET-002': { document: 'REQ-053', functionId: 'AST-02' },
  'RDL-ASSET-003': { document: 'REQ-053', functionId: 'AST-02' },
  'RDL-ASSET-004': { document: 'REQ-053', functionId: 'AST-02' },
  'RDL-ASSET-005': { document: 'REQ-053', functionId: 'AST-02' }
});

/** 진단 코드의 정본 문서. 모르는 코드는 null이며 추측하지 않는다. */
function ruleSource(code) {
  return RULES[code] || null;
}

/**
 * 정본 문서가 영향을 주는 진단 코드. 요구를 고칠 때 어떤 검사가 흔들리는지를
 * 역방향으로 계산한다. 이 방향이 없으면 문서만 고치고 검사는 그대로 남는다.
 */
function codesForDocument(documentId) {
  const id = String(documentId || '');
  return Object.keys(RULES).filter((code) => RULES[code].document === id).sort();
}

/** 아직 정본 문서가 붙지 않은 코드. 남은 작업의 크기를 세는 데 쓴다. */
function coverage(allCodes) {
  const codes = Array.from(new Set(allCodes || []));
  const mapped = codes.filter((code) => Boolean(RULES[code]));
  return {
    total: codes.length,
    mapped: mapped.length,
    unmapped: codes.filter((code) => !RULES[code]).sort()
  };
}

module.exports = { RULES, ruleSource, codesForDocument, coverage };
