'use strict';

const path = require('path');
const { parseFrontmatter } = require('./frontmatter');

const CONTRACT_VERSION = 'atomic-v1';
const { IMPLEMENTATION_TYPES, SUB_ID_SEPARATOR } = require('./vocabulary');
// 문서 1개 = 기능 1개가 기본 계약이다. 합침은 groupingReason 선언이 있는 opt-in이며
// 유형별 정책을 따른다. 근거는 실사용 정본 측정이다: TST가 기능 여럿을 검증하는 것은
// 자연스럽고(TST-002=11), REQ가 기능 여럿을 요구하는 것은 과합침이다(REQ-010=5).
// forbidden 유형은 선언이 있어도 다기능을 거부한다 — 분리가 유일한 해소다.
const GROUPING_POLICY = Object.freeze({ REQ: 'forbidden', SCR: 'forbidden', TST: 'declared', MOD: 'declared', IFC: 'declared' });
// 기능은 서브 종류 FN이다. 부모와 종류와 일련 세 자리 중 코드가 소유하는 것은
// 가운데뿐이고, 그 계약은 types/sub.d.ts가 갖는다.
const FUNCTION_SUB_KIND = 'FN';
// 기능의 원천 계약을 나르는 유형. 이 유형의 문서 안에서는 부모가 문서 자신이므로
// 부모를 적지 않는다. RDL-IMPL-011이 "REQ 원천 계약"이라 부르던 자리가 여기다.
const FUNCTION_SOURCE_TYPE = 'REQ';
/**
 * 문서 안 표기 — FN-001. 부모가 자명하므로 붙이지 않는다.
 *
 * 사람이 짓던 접두(HRN·TSK·BRD …)와 두 자리 일련은 받지 않는다. 받으면 이 표기가
 * 무엇을 닫았는지가 흐려지고, 옮겨진 것과 안 옮겨진 것을 셀 수 없다.
 */
const LOCAL_FUNCTION_ID_PATTERN = new RegExp(`^${FUNCTION_SUB_KIND}-\\d{3,}$`, 'u');
/**
 * 문서 밖 표기 — REQ-033#FN-001. 부모의 형태는 못박지 않는다. 문서 식별자의 형태는
 * 프로젝트가 정하는 값이므로, 여기 적으면 사용자가 정의한 것이 다시 코드가 된다.
 */
const QUALIFIED_FUNCTION_ID_PATTERN = new RegExp(`^[^\\s${SUB_ID_SEPARATOR}]+${SUB_ID_SEPARATOR}${FUNCTION_SUB_KIND}-\\d{3,}$`, 'u');
/** 본문 기능 계약 절의 제목. 그 문서가 frontmatter에 적은 표기를 그대로 쓴다. */
const FUNCTION_HEADING_PATTERN = new RegExp(`^(?:기능\\s+)?((?:[^\\s${SUB_ID_SEPARATOR}]+${SUB_ID_SEPARATOR})?${FUNCTION_SUB_KIND}-\\d{3,})$`, 'u');
/** 한 행에 범위로 묶인 기능. FN-001 ~ 003과 REQ-033#FN-001 ~ 003을 함께 집는다. */
const FUNCTION_RANGE_PATTERN = new RegExp(`((?:[^\\s|,]+${SUB_ID_SEPARATOR})?${FUNCTION_SUB_KIND})-(\\d{3,})\\s*(?:~|～|–|—)\\s*(?:\\1-)?(\\d{3,})`, 'u');
const ARTIFACT_ID_PATTERN = /\b([A-Z]{3}-\d{3,})\b/u;
const PLACEHOLDER_PATTERN = /(?:작성\s*필요|미정|추후[^\r\n]{0,40}확정|별도[^\r\n]{0,40}확정|원본(?:\s+문서)?\s*(?:기준|적용|참조)|todo|tbd|<[^>]+>)/iu;
const INDEX_TITLE_PATTERN = /^(?:(?:문서|기능|요구사항|설계|테스트)\s*)?(?:인덱스|목록|카탈로그|추적표|추적성\s*매트릭스|index|catalog|traceability\s*matrix)(?:\s*문서)?$/iu;
const REQUIRED_FIELDS_BY_TYPE = Object.freeze({
  REQ: Object.freeze(['입력', '출력', '업무 규칙', '상태와 전이', '권한과 승인', '정상·오류·취소', '감사 기록', '수용 기준']),
  SCR: Object.freeze(['사용자와 진입 조건', '표시와 입력', '상호작용', '화면 상태와 전이', '검증·오류·취소', '권한과 접근성', '수용 기준']),
  MOD: Object.freeze(['책임과 소유 데이터', '필드와 타입', '키와 식별자', '관계와 카디널리티', '상태와 전이', '불변식과 계산식', '감사와 보존', '수용 기준']),
  IFC: Object.freeze(['오퍼레이션과 경로', '권한', '요청', '응답', '업무 규칙', '오류·취소·멱등성', '감사와 보안', '수용 기준']),
  TST: Object.freeze(['사전 조건', '입력과 데이터', '실행 절차', '기대 결과', '오류와 취소', '증거', '수용 기준'])
});
const REQUIRED_FUNCTION_FIELDS = REQUIRED_FIELDS_BY_TYPE.REQ;

function unique(values) {
  return Array.from(new Set(values));
}

function escapeForPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 문서가 적은 그대로의 기능 ID. 표기를 맞추는 것은 qualifiedFunctionIds가 한다. */
function functionIds(meta) {
  return unique((Array.isArray(meta && meta.functionIds) ? meta.functionIds : []).map((value) => String(value).trim()).filter(Boolean));
}

/** 부모를 단 표기에서 부모를 떼어 낸다. 그 값이 이 기능의 원천 계약이다. */
function subParent(value) {
  const text = String(value || '');
  const at = text.indexOf(SUB_ID_SEPARATOR);
  return at < 0 ? null : text.slice(0, at);
}

/**
 * 부모를 단 표기로 맞춘 기능 ID. 원천 문서는 부모가 자기 자신이므로 여기서 달고,
 * 하위 산출물은 이미 달고 온다.
 *
 * 이 함수를 지나면 값 하나가 어느 문서의 몇 번 기능인지를 스스로 말한다. 그래서
 * 주인이 누구인지 되짚는 조회가 사라지고, 주인이 둘이거나 없는 경우도 함께 사라진다 —
 * 진단 둘이 막고 있던 것이 여기서 일어나지 못하는 것이 된다.
 *
 * 표기가 어긋난 값은 여기서 뺀다. 조용하지 않은 이유는 같은 값을
 * validateImplementationDocument가 RDL-IMPL-003으로 잡기 때문이고, 어긋난 값을 추적에
 * 들이면 부모 없는 항목이 다시 생겨 방금 없앤 진단이 다시 필요해지기 때문이다.
 */
function qualifiedFunctionIds(type, artifactId, meta) {
  const ids = functionIds(meta);
  if (String(type || '').toUpperCase() !== FUNCTION_SOURCE_TYPE) return ids.filter((id) => QUALIFIED_FUNCTION_ID_PATTERN.test(id));
  return ids.filter((id) => LOCAL_FUNCTION_ID_PATTERN.test(id)).map((id) => `${artifactId}${SUB_ID_SEPARATOR}${id}`);
}

function isIndexArtifact(title, file) {
  const stem = path.basename(String(file || ''), path.extname(String(file || ''))).replace(/^[A-Z]{3}-\d{3,}-/u, '').replace(/[-_]+/gu, ' ').trim();
  return INDEX_TITLE_PATTERN.test(String(title || '').trim()) || INDEX_TITLE_PATTERN.test(stem);
}

function headingName(line, level) {
  const match = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`, 'u').exec(line);
  return match ? match[1].trim() : null;
}

function functionSections(body) {
  const lines = String(body || '').replace(/\r\n/gu, '\n').split('\n');
  const result = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingName(lines[index], 3);
    if (!heading) continue;
    const match = FUNCTION_HEADING_PATTERN.exec(heading);
    if (!match) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{2,3}\s+/u.test(lines[end])) end += 1;
    result.set(match[1], { startLine: index + 1, lines: lines.slice(index + 1, end) });
  }
  return result;
}

function fieldContent(section, field) {
  const lines = section.lines;
  for (let index = 0; index < lines.length; index += 1) {
    if (headingName(lines[index], 4) !== field) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{3,4}\s+/u.test(lines[end])) end += 1;
    return lines.slice(index + 1, end).join('\n').trim();
  }
  return '';
}

function groupedFunctionLines(body, declaredIds) {
  const findings = [];
  const declared = new Set(declaredIds || []);
  // 훑는 패턴을 선언된 값에서 만든다. 표기에서 부모의 형태를 짐작하면 그 순간
  // 사용자가 정의한 것이 다시 코드가 되고, 짐작이 빗나가는 프로젝트에서는 이 검사가
  // 아무 말도 없이 죽는다.
  const wanted = Array.from(declared).map((id) => ({ id, pattern: new RegExp(`(?<![\\w${SUB_ID_SEPARATOR}-])${escapeForPattern(id)}(?![\\w-])`, 'u') }));
  const lines = String(body || '').replace(/\r\n/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const ids = wanted.filter((item) => item.pattern.test(line)).map((item) => item.id);
    const rangeMatch = FUNCTION_RANGE_PATTERN.exec(line);
    const rangeTouchesDeclared = Boolean(rangeMatch && (declared.has(`${rangeMatch[1]}-${rangeMatch[2]}`) || declared.has(`${rangeMatch[1]}-${rangeMatch[3]}`)));
    if (rangeTouchesDeclared || ids.length > 1) findings.push({ line: index + 1, value: line.trim() });
  }
  return findings;
}

function validateImplementationDocument(document, options) {
  const settings = options || {};
  const source = document.source || '';
  const parsed = document.frontmatter || parseFrontmatter(source);
  if (!parsed) return [];
  const meta = parsed.data;
  const type = String((meta.id || '').slice(0, 3)).toUpperCase();
  const issues = [];
  if (isIndexArtifact(meta.title, document.file || document.relativeFile)) issues.push({ code: 'RDL-IMPL-010', severity: 'error', message: '별도 인덱스·목록·추적표 문서는 정본으로 만들지 않습니다. 직접 링크와 계산된 추적성을 사용하세요.' });
  if (!IMPLEMENTATION_TYPES.includes(type)) return issues;
  const strictSeverity = settings.implementation ? 'error' : 'warning';
  if (meta.implementationContract !== CONTRACT_VERSION) {
    issues.push({ code: 'RDL-IMPL-001', severity: strictSeverity, message: `구현 문서는 implementationContract: ${CONTRACT_VERSION}가 필요합니다.` });
    return issues;
  }
  const ids = functionIds(meta);
  if (ids.length === 0) issues.push({ code: 'RDL-IMPL-002', severity: 'error', message: '구현 문서는 functionIds에 기능 ID를 하나 이상 선언해야 합니다.' });
  // 표기는 부모가 자명한지로 갈린다. 원천 문서 안에서는 문서 안 표기이고 그 밖에서는
  // 부모를 단 표기다. 한 자리에서 한 가지만 받는 이유는, 둘 다 받으면 같은 기능을
  // 가리키는 글자가 둘이 되고 부모를 달아 없앤 중복이 표기 차이로 되돌아오기 때문이다.
  const owns = type === FUNCTION_SOURCE_TYPE;
  for (const id of ids) {
    if (owns ? LOCAL_FUNCTION_ID_PATTERN.test(id) : QUALIFIED_FUNCTION_ID_PATTERN.test(id)) continue;
    issues.push({
      code: 'RDL-IMPL-003', severity: 'error', target: id,
      message: owns
        ? `기능 ID는 이 문서 안의 표기여야 합니다: ${id} (부모는 이 문서 자신이므로 ${FUNCTION_SUB_KIND}-001처럼 적습니다)`
        : `기능 ID는 원천 계약을 부모로 달아야 합니다: ${id} (${FUNCTION_SOURCE_TYPE}-033${SUB_ID_SEPARATOR}${FUNCTION_SUB_KIND}-001)`
    });
  }
  // 문서 1개 = 기능 1개 기본. 다기능은 groupingReason+groupingFunctions 평면 키로
  // 선언한 opt-in만 허용하고, 유형 정책이 선언의 효력을 정한다. 진단은 001/006과 같은
  // 단계 도입이다 — 일반 검사에서는 경고, 구현 준비도 게이트에서는 오류. 정본 분해가
  // 끝나면 상시 오류로 승격을 검토한다.
  const groupingReason = String(meta.groupingReason || '').trim();
  const groupingFunctions = unique((Array.isArray(meta.groupingFunctions) ? meta.groupingFunctions : []).map((value) => String(value).trim()).filter(Boolean));
  if (ids.length > 1) {
    const policy = GROUPING_POLICY[type];
    if (policy === 'forbidden') issues.push({ code: 'RDL-IMPL-014', severity: strictSeverity, message: `${type} 문서는 기능 1개만 나릅니다. 기능마다 문서를 분리하세요.` });
    else if (!groupingReason) issues.push({ code: 'RDL-IMPL-013', severity: strictSeverity, message: `기능 ${ids.length}개를 나르는 문서에는 groupingReason 선언이 필요합니다. 문서 1개가 기능 1개를 나르는 것이 기본입니다.` });
    else {
      const declared = new Set(groupingFunctions);
      const idSet = new Set(ids);
      const mismatch = groupingFunctions.length === 0 || groupingFunctions.some((id) => !idSet.has(id)) || ids.some((id) => !declared.has(id));
      if (mismatch) issues.push({ code: 'RDL-IMPL-015', severity: strictSeverity, message: 'groupingFunctions는 functionIds와 같은 집합이어야 합니다. 합친 범위를 정확히 선언하세요.' });
      else if (type === 'MOD' || type === 'IFC') issues.push({ code: 'RDL-IMPL-017', severity: 'warning', message: `${type} 다기능 묶음입니다. 사유를 검토하세요: ${groupingReason}` });
    }
  } else if (groupingReason || groupingFunctions.length) {
    issues.push({ code: 'RDL-IMPL-015', severity: strictSeverity, message: '단일 기능 문서에는 grouping 선언을 두지 않습니다.' });
  }
  for (const grouped of groupedFunctionLines(parsed.body, ids)) issues.push({ code: 'RDL-IMPL-004', severity: 'error', line: parsed.bodyStartLine + grouped.line - 1, message: `기능 ID를 한 행이나 범위로 묶어 명세할 수 없습니다. 같은 문서 안에서도 각 기능을 독립 계약으로 작성하세요: ${grouped.value}` });
  if (IMPLEMENTATION_TYPES.includes(type)) {
    const sections = functionSections(parsed.body);
    for (const id of ids) {
      const section = sections.get(id);
      if (!section) {
        issues.push({ code: 'RDL-IMPL-005', severity: strictSeverity, target: id, message: `기능 ID별 계약 섹션이 없습니다: ### ${id}` });
        continue;
      }
      for (const field of REQUIRED_FIELDS_BY_TYPE[type]) {
        const content = fieldContent(section, field);
        if (!content || PLACEHOLDER_PATTERN.test(content)) issues.push({ code: 'RDL-IMPL-006', severity: strictSeverity, target: id, line: parsed.bodyStartLine + section.startLine - 1, message: `${id}의 구현 계약이 확정되지 않았습니다: ${field}` });
      }
    }
    for (const id of sections.keys()) if (!ids.includes(id)) issues.push({ code: 'RDL-IMPL-007', severity: 'error', target: id, message: `본문 기능 ID가 functionIds에 선언되지 않았습니다: ${id}` });
  }
  return issues;
}

function relatedArtifactIds(meta) {
  return unique((Array.isArray(meta && meta.related) ? meta.related : []).map((value) => {
    const match = ARTIFACT_ID_PATTERN.exec(String(value));
    return match ? match[1] : null;
  }).filter(Boolean));
}

function artifactImplementation(artifact) {
  const parsed = parseFrontmatter(artifact.source || '');
  const meta = parsed ? parsed.data : {};
  return { id: artifact.id, type: artifact.type, file: artifact.file, source: artifact.source, meta, functionIds: qualifiedFunctionIds(artifact.type, artifact.id, meta), related: relatedArtifactIds(meta), contract: meta.implementationContract || null };
}

function implementationTrace(artifactInput) {
  const artifacts = (artifactInput || []).map(artifactImplementation);
  const functions = new Map();
  for (const artifact of artifacts) for (const id of artifact.functionIds) {
    if (!functions.has(id)) functions.set(id, { functionId: id, source: subParent(id), artifacts: {} });
    const entry = functions.get(id);
    if (!entry.artifacts[artifact.type]) entry.artifacts[artifact.type] = [];
    entry.artifacts[artifact.type].push(artifact.id);
  }
  const entries = Array.from(functions.values()).sort((left, right) => left.functionId.localeCompare(right.functionId)).map((entry) => Object.assign(entry, {
    ready: Boolean(entry.artifacts.REQ && entry.artifacts.REQ.length && entry.artifacts.TST && entry.artifacts.TST.length),
    missing: ['REQ', 'TST'].filter((type) => !entry.artifacts[type] || entry.artifacts[type].length === 0)
  }));
  return { generated: true, persistedIndex: false, entries, summary: { functions: entries.length, ready: entries.filter((entry) => entry.ready).length, incomplete: entries.filter((entry) => !entry.ready).length } };
}

function validateImplementationTrace(artifactInput, options) {
  const settings = options || {};
  const artifacts = (artifactInput || []).map(artifactImplementation);
  const issues = [];
  // 여기 있던 RDL-IMPL-009 — 기능 ID가 여러 REQ에 중복 정의됨 — 는 사라졌다. 부모를
  // 달면 REQ-012#FN-001과 REQ-013#FN-001은 같은 값이 될 수 없고, 한 REQ 안의 중복은
  // 유일성이 지운다. 검사로 막던 것이 애초에 일어나지 못하는 것이 되었다.
  //
  // 기능 정본 유일성: 한 기능이 같은 유형의 문서 여럿에 흩어지는 것을 막는다.
  // REQ가 이 목록에 없는 것도 같은 이유다 — REQ의 선언은 자기 번호로 갈리므로
  // 애초에 흩어질 수 없고, 없앤 진단을 유형 목록으로 되살릴 이유도 없다.
  for (const type of ['SCR', 'MOD', 'IFC', 'TST']) {
    const owners = new Map();
    for (const artifact of artifacts.filter((item) => item.type === type)) for (const id of artifact.functionIds) {
      if (owners.has(id)) issues.push({ code: 'RDL-IMPL-016', severity: settings.implementation ? 'error' : 'warning', target: id, artifactId: artifact.id, message: `기능 ID가 여러 ${type} 문서에 중복 선언되었습니다: ${id} (${owners.get(id)}에 이미 있음)` });
      else owners.set(id, artifact.id);
    }
  }
  const trace = implementationTrace(artifactInput);
  // 여기 있던 RDL-IMPL-011 — REQ 원천 계약 없이 하위 산출물이 참조함 — 도 사라졌다.
  // 하위 산출물은 이제 부모를 적지 않고는 기능을 가리킬 수 없으므로, 원천을 밝히지
  // 않은 참조라는 것이 표기로 존재하지 못한다. 시나리오가 이미 그렇게 살고 있고
  // RDL-SCENARIO-003의 범위가 문서 하나인 것이 그 결과다.
  //
  // 적힌 부모가 실제로 그 기능을 선언했는지는 남는다. 그러나 그것은 "원천이 없다"가
  // 아니라 "가리킨 것이 해결되지 않는다"이며, 참조 해결은 링크 계층의 물음이다.
  // 이름을 옮겼을 뿐인 진단을 여기 다시 세우면 걷어낸 것을 이름만 바꿔 되돌리게 된다.
  for (const entry of trace.entries) {
    if (entry.artifacts.REQ && entry.artifacts.REQ.length && (!entry.artifacts.TST || entry.artifacts.TST.length === 0)) issues.push({ code: 'RDL-IMPL-012', severity: settings.implementation ? 'error' : 'warning', target: entry.functionId, artifactId: entry.artifacts.REQ[0], message: `기능 ID를 검증하는 TST가 없습니다: ${entry.functionId}` });
  }
  // 화면이 있는 기능은 화면을 근거로 검증되어야 한다. 다만 TST의 필수 관계를 SCR로
  // 바꾸면 화면 없는 기능(인증·배치·웹훅·공개 API)이 검증 대상에서 통째로 빠지므로,
  // 그 기능에 SCR 정본이 실제로 있을 때만 참조를 요구한다. 근거는 ADR-013이다.
  const screenOwners = new Map();
  for (const entry of trace.entries) if (entry.artifacts.SCR && entry.artifacts.SCR.length) screenOwners.set(entry.functionId, entry.artifacts.SCR);
  for (const artifact of artifacts.filter((item) => item.type === 'TST')) for (const id of artifact.functionIds) {
    const screens = screenOwners.get(id);
    if (!screens || screens.some((screen) => artifact.related.includes(screen))) continue;
    // 이 계열 진단은 파일 위치 없이 표시되므로, 어느 문서를 고쳐야 하는지가
    // 메시지 안에서 끝나야 한다. 기능 ID만 알려주면 TST를 다시 찾아야 한다.
    issues.push({ code: 'RDL-IMPL-018', severity: settings.implementation ? 'error' : 'warning', target: id, artifactId: artifact.id, message: `기능 ID의 화면 정본을 검증 문서가 참조하지 않습니다: ${id} (${artifact.id}에 ${screens.join(', ')} 관계 필요)` });
  }
  return { trace, issues };
}

function validateTaskImplementationReadiness(artifactInput, options) {
  const artifacts = (artifactInput || []).map((artifact) => ({
    id: artifact.id,
    type: String(artifact.id || '').slice(0, 3),
    file: artifact.file,
    relativeFile: artifact.relativeFile,
    source: artifact.source,
    frontmatter: artifact.frontmatter || parseFrontmatter(artifact.source || '')
  }));
  const issues = [];
  const implementationArtifacts = artifacts.filter((artifact) => IMPLEMENTATION_TYPES.includes(artifact.type));
  const requirements = implementationArtifacts.filter((artifact) => artifact.type === 'REQ');
  const tests = implementationArtifacts.filter((artifact) => artifact.type === 'TST');
  // 무엇이 없는지만 말하면 사람은 무엇을 붙여야 하는지를 다시 조사해야 한다. 실측에서
  // 태스크 하나를 닫는 데 드는 왕복의 상당수가 그 조사였다. 어느 문서가 그 기능을
  // 덮는지는 이미 계산되는 값이므로 진단이 함께 들고 나간다.
  const coverage = (options && options.coverage) || null;
  const suggest = (ids, type) => {
    if (!coverage || !ids.length) return '';
    const found = unique(ids.flatMap((id) => (coverage[id] && coverage[id][type]) || []));
    return found.length ? ` 이 기능을 덮는 문서: ${found.join(', ')}` : '';
  };

  const linkedIds = unique(implementationArtifacts.flatMap((artifact) => qualifiedFunctionIds(artifact.type, artifact.id, artifact.frontmatter && artifact.frontmatter.data)));
  if (requirements.length === 0) issues.push({ code: 'RDL-IMPL-020', severity: 'error', message: `구현 준비도 대상 태스크에는 REQ 문서가 필요합니다.${suggest(linkedIds, 'REQ')}` });
  if (tests.length === 0) issues.push({ code: 'RDL-IMPL-021', severity: 'error', message: `구현 준비도 대상 태스크에는 TST 문서가 필요합니다.${suggest(linkedIds, 'TST')}` });
  for (const artifact of implementationArtifacts) for (const issue of validateImplementationDocument(artifact, { implementation: true })) issues.push(Object.assign({ artifactId: artifact.id }, issue));
  const requiredIds = unique(requirements.flatMap((artifact) => qualifiedFunctionIds(artifact.type, artifact.id, artifact.frontmatter && artifact.frontmatter.data)));
  const testedIds = new Set(tests.flatMap((artifact) => qualifiedFunctionIds(artifact.type, artifact.id, artifact.frontmatter && artifact.frontmatter.data)));
  for (const id of requiredIds) if (!testedIds.has(id)) issues.push({ code: 'RDL-IMPL-022', severity: 'error', target: id, message: `태스크의 REQ 기능 ID를 연결된 TST가 검증하지 않습니다: ${id}.${suggest([id], 'TST')}` });
  return issues;
}

function renderImplementationMetadata(ids) {
  return `implementationContract: ${CONTRACT_VERSION}\nfunctionIds:\n${ids.map((id) => `  - ${id}`).join('\n')}`;
}

// grouping 선언은 평면 키다 — parseFrontmatter는 중첩 맵을 읽지 않는다.
function renderGroupingMetadata(reason, ids) {
  return `groupingReason: ${JSON.stringify(String(reason).trim())}\ngroupingFunctions:\n${ids.map((id) => `  - ${id}`).join('\n')}`;
}

function renderFunctionContracts(type, ids) {
  const heading = type === 'TST' ? '기능별 검증 계약' : '기능별 설계 계약';
  return `\n## ${heading}\n\n${ids.map((id) => `### ${id}\n\n${REQUIRED_FIELDS_BY_TYPE[type].map((field) => `#### ${field}\n\n- 작성 필요: ${id} ${field}`).join('\n\n')}`).join('\n\n')}\n`;
}

function renderTestCoverage(ids) {
  return renderFunctionContracts('TST', ids);
}

module.exports = {
  CONTRACT_VERSION, IMPLEMENTATION_TYPES, GROUPING_POLICY, REQUIRED_FUNCTION_FIELDS, REQUIRED_FIELDS_BY_TYPE,
  FUNCTION_SUB_KIND, FUNCTION_SOURCE_TYPE, LOCAL_FUNCTION_ID_PATTERN, QUALIFIED_FUNCTION_ID_PATTERN,
  functionIds, qualifiedFunctionIds, subParent, isIndexArtifact, validateImplementationDocument, implementationTrace, validateImplementationTrace,
  validateTaskImplementationReadiness, renderImplementationMetadata, renderGroupingMetadata, renderFunctionContracts, renderTestCoverage
};
