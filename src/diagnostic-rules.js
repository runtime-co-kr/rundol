'use strict';

// 진단 코드가 왜 존재하는지는 문서가 말한다. 제품은 문서 번호를 모른다.
//
// 이 파일은 전에 반대 방향을 들고 있었다 — 진단 코드 136개에 런돌 요구 문서 16개의
// 번호를 붙인 표였고, 그것이 rdl check --json의 rule 필드에 실려 남의 저장소까지
// 나갔다. 그 저장소에 REQ-053은 없다. 없는 문서를 가리키는 근거는 근거가 아니라
// 오답이고, 그걸 보고 있지도 않은 문서를 찾으러 간다.
//
// 표를 설정 파일로 내려도 고쳐지지 않는다. 자리를 옮길 뿐 여전히 제품이 남의 문서
// 번호를 아는 것이기 때문이다. RDL-ASSET-005를 내는 일은 런돌이 하는 일이고,
// 그 진단이 REQ-053 때문에 존재한다는 사실은 런돌을 만드는 일이다. 뒤엣것이 사는
// 곳은 제품 코드가 아니라 런돌의 다른 개발 산출물이 사는 곳 — 문서 브랜치다.
//
// 원래 목적은 방향을 뒤집어 지킨다. RDL-IMPL-018이 왜 있는지 알려고 검사기 소스를
// 뒤지지 않아야 하고, 요구를 고칠 때 어떤 진단이 흔들리는지 알 수 있어야 한다.
// 그 둘은 문서가 자기 소관 진단을 선언하면 그대로 선다. 여기서 하는 일은 그 선언을
// 모으는 것뿐이다. 그래서 이 파일이 읽고 내보내는 값에는 문서 번호가 하나도 없다.
// 아래에 REQ 번호가 보이는 자리는 무엇이 왜 사라졌는지를 말하는 글과, 문서가 자기
// 번호를 자기 frontmatter에 적는 모습을 보이는 형식 예뿐이다. 판정에 쓰이는 값으로
// 한 줄이라도 되돌아오는 순간 같은 것이 다시 남의 저장소로 나간다.
//
// 값만 보고 답한다. 파일을 읽지 않으므로 명령줄과 보드와 지속적 통합이 같은 답을 얻는다.

// ── 선언 형식 ────────────────────────────────────────────────────────────────
//
// 문서 frontmatter의 diagnostics 칸에 진단 코드를 나열한다.
//
//     ---
//     id: REQ-053
//     functionIds:
//       - AST-02
//     diagnostics:
//       - RDL-ASSET-002
//       - RDL-ASSET-003
//       - RDL-ASSET-004
//       - RDL-ASSET-005
//     ---
//
// 본문이 아니라 frontmatter인 이유. 지금도 정본 12건이 본문에 진단 코드를 적고
// 있지만 그것은 설명이지 선언이 아니다 — 동작 규칙 항목에도 있고 시나리오 표 칸에도
// 있고 반례를 드는 자리에도 있다. REQ-052의 "`![[diagram.png]]`가 RDL-LINK-004로
// 잡히지 않는다"를 소관으로 읽으면 역방향 조회가 정반대를 답한다. 사람이 읽는 글에서
// 소관을 추론하면 추론이 틀리는 날 아무 신호도 나지 않는다.
// 기계가 읽는 칸은 이미 frontmatter다(functionIds·implementationContract가 거기 산다).
// 본문의 언급은 그대로 둔다 — 비공식으로 하던 것을 지우는 게 아니라 공식 자리를 여는 것이다.
//
// 기능 ID를 함께 적지 않는 이유. 옛 표는 코드마다 { document, functionId }를 들었는데,
// 문서 16개 전부에서 그 functionId가 선언 문서 자신의 functionIds와 같았다. 같은 값을
// 두 곳에 적으면 한쪽만 고쳐지는 날이 오고, 그때 어느 쪽이 정본인지 말할 근거가 없다.
// 선언은 코드만 나르고 기능은 선언한 문서에서 파생한다.
//
// 코드 형식은 제품이 판정한다. 진단 이름공간은 제품 것이므로 "이건 내가 내는 코드의
// 꼴이 아니다"는 제품이 말할 수 있다 — 남의 문서 번호를 아는 것과는 다른 일이다.

/** 선언이 적히는 frontmatter 칸. 문서 쪽 도구도 이 이름을 여기서 가져다 쓴다. */
const DECLARATION_KEY = 'diagnostics';

/** 계열 + 세 자리. 지금 src/가 내는 코드 236개가 모두 이 꼴이다. */
const CODE_PATTERN = /^RDL-[A-Z][A-Z0-9]*-\d{3}$/u;

function textOf(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort();
}

/**
 * 한 문서의 선언을 정규화한다. 형식이 틀린 값은 조용히 버리지 않고 invalid로
 * 돌려준다 — 버리면 오타 하나가 "이 문서는 아무 진단도 근거 짓지 않는다"로 보이고,
 * 그건 선언이 없는 것과 구별되지 않는다.
 */
function declaredCodes(meta) {
  const raw = meta && Array.isArray(meta[DECLARATION_KEY]) ? meta[DECLARATION_KEY] : [];
  const codes = [];
  const invalid = [];
  for (const value of raw) {
    const code = textOf(value);
    if (!code) continue;
    if (CODE_PATTERN.test(code)) codes.push(code);
    else invalid.push(code);
  }
  return { codes: sortedUnique(codes), invalid: sortedUnique(invalid) };
}

function functionIdsOf(meta) {
  const raw = meta && Array.isArray(meta.functionIds) ? meta.functionIds : [];
  return sortedUnique(raw.map(textOf).filter(Boolean));
}

/**
 * 선언을 모아 색인을 만든다. 입력은 이미 읽어 둔 문서 값이다 — { id, meta } 꼴이면
 * 되고 meta는 파싱된 frontmatter다. 파일 경로도 저장소 위치도 필요 없다.
 *
 * 한 코드를 두 문서가 선언하면 이긴 쪽을 고르지 않는다. 디렉터리를 읽는 순서에 따라
 * 답이 달라지는 조회는 추적성이 아니라 추적성처럼 보이는 것이다. 그런 코드는 색인에서
 * 빼고 conflicts에 남겨 사람이 소관을 가르게 한다.
 *
 * 어긋난 선언에 진단 코드를 붙이지 않고 값으로만 돌려준다. 어느 심각도로 어느 표면에서
 * 알릴지는 이 조회를 명령줄에 잇는 쪽이 정할 일이다.
 */
function collectDeclarations(documents) {
  const claims = new Map();
  const byDocument = {};
  const malformed = [];
  for (const document of documents || []) {
    if (!document) continue;
    const id = textOf(document.id);
    if (!id) continue;
    const meta = document.meta || document;
    const { codes, invalid } = declaredCodes(meta);
    if (invalid.length) malformed.push({ document: id, codes: invalid });
    if (!codes.length) continue;
    byDocument[id] = codes;
    const functionIds = functionIdsOf(meta);
    for (const code of codes) {
      if (!claims.has(code)) claims.set(code, []);
      claims.get(code).push({ document: id, functionIds });
    }
  }

  const byCode = {};
  const conflicts = [];
  for (const code of Array.from(claims.keys()).sort()) {
    const claimed = claims.get(code);
    const documents = sortedUnique(claimed.map((claim) => claim.document));
    if (documents.length > 1) conflicts.push({ code, documents });
    else byCode[code] = claimed[0];
  }

  return { byCode, byDocument, conflicts, malformed: malformed.sort((left, right) => left.document.localeCompare(right.document)) };
}

/**
 * 이 진단의 근거를 선언한 문서. 선언이 없거나 갈리면 null이며 추측하지 않는다 —
 * 틀린 근거는 근거가 없는 것보다 나쁘다.
 *
 * 색인을 인자로 받는다. 예전 서명은 코드만 받고 표를 뒤졌으므로, 옮겨 오지 않은
 * 호출부는 여기서 조용히 null을 받는 대신 인자가 모자라 눈에 띄어야 한다.
 */
function ruleSource(index, code) {
  const key = textOf(code);
  if (!key || !index || !index.byCode) return null;
  return index.byCode[key] || null;
}

/**
 * 이 문서가 근거 짓는 진단. 요구를 고칠 때 어떤 검사가 흔들리는지를 역방향으로
 * 계산한다. 이 방향이 없으면 문서만 고치고 검사는 그대로 남는다.
 */
function codesForDocument(index, documentId) {
  const key = textOf(documentId);
  if (!key || !index || !index.byDocument) return [];
  return (index.byDocument[key] || []).slice();
}

/** 아직 아무 문서도 근거 짓지 않은 코드. 남은 크기를 모르면 "이제 됐다"고 착각한다. */
function coverage(index, allCodes) {
  const codes = sortedUnique((allCodes || []).map(textOf).filter(Boolean));
  const byCode = (index && index.byCode) || {};
  return {
    total: codes.length,
    declared: codes.filter((code) => Boolean(byCode[code])).length,
    undeclared: codes.filter((code) => !byCode[code])
  };
}

module.exports = { DECLARATION_KEY, CODE_PATTERN, declaredCodes, collectDeclarations, ruleSource, codesForDocument, coverage };
