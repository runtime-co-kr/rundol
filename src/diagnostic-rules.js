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
// 지금 덮는 범위는 계약 계열 둘(IMPL, PROFILE)이다. 나머지 열 계열은 같은 방식으로
// 채워 나간다. 모르는 코드에 억지로 문서를 붙이지 않는다 — 틀린 근거는 근거가
// 없는 것보다 나쁘다.

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
  'RDL-IMPL-023': { document: 'REQ-034', functionId: 'HRN-02' },
  // 계산형 기능 추적성: 기능 식별자를 REQ와 TST가 함께 덮는지
  'RDL-IMPL-012': { document: 'REQ-036', functionId: 'HRN-04' },
  // 구현 준비도 태스크 게이트: 태스크가 구현에 들어가도 되는지
  'RDL-IMPL-020': { document: 'REQ-035', functionId: 'HRN-03' },
  'RDL-IMPL-021': { document: 'REQ-035', functionId: 'HRN-03' },
  'RDL-IMPL-022': { document: 'REQ-035', functionId: 'HRN-03' }
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
