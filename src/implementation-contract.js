'use strict';

const path = require('path');
const { parseFrontmatter } = require('./frontmatter');

const CONTRACT_VERSION = 'atomic-v1';
const IMPLEMENTATION_TYPES = Object.freeze(['REQ', 'SCR', 'MOD', 'IFC', 'TST']);
// 문서 1개 = 기능 1개가 기본 계약이다. 합침은 groupingReason 선언이 있는 opt-in이며
// 유형별 정책을 따른다. 근거는 실사용 정본 측정이다: TST가 기능 여럿을 검증하는 것은
// 자연스럽고(TST-002=11), REQ가 기능 여럿을 요구하는 것은 과합침이다(REQ-010=5).
// forbidden 유형은 선언이 있어도 다기능을 거부한다 — 분리가 유일한 해소다.
const GROUPING_POLICY = Object.freeze({ REQ: 'forbidden', SCR: 'forbidden', TST: 'declared', MOD: 'declared', IFC: 'declared' });
const FUNCTION_ID_PATTERN = /^[A-Z][A-Z0-9]{1,7}-\d{2,4}$/u;
const ARTIFACT_ID_PATTERN = /\b([A-Z]{3}-\d{3,})\b/u;
const FUNCTION_ID_GLOBAL = /\b[A-Z][A-Z0-9]{1,7}-\d{2,4}\b/gu;
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

function functionIds(meta) {
  return unique((Array.isArray(meta && meta.functionIds) ? meta.functionIds : []).map((value) => String(value).trim()).filter(Boolean));
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
    const match = /^(?:기능\s+)?([A-Z][A-Z0-9]{1,7}-\d{2,4})$/u.exec(heading);
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
  const lines = String(body || '').replace(/\r\n/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const ids = unique(Array.from(line.matchAll(FUNCTION_ID_GLOBAL), (match) => match[0])).filter((id) => declared.has(id));
    const rangeMatch = /\b([A-Z][A-Z0-9]{1,7})-(\d{2,4})\s*(?:~|～|–|—)\s*(?:\1-)?(\d{2,4})\b/u.exec(line);
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
  for (const id of ids) if (!FUNCTION_ID_PATTERN.test(id)) issues.push({ code: 'RDL-IMPL-003', severity: 'error', target: id, message: `기능 ID 형식이 잘못되었습니다: ${id}` });
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
  return { id: artifact.id, type: artifact.type, file: artifact.file, source: artifact.source, meta, functionIds: functionIds(meta), related: relatedArtifactIds(meta), contract: meta.implementationContract || null };
}

function implementationTrace(artifactInput) {
  const artifacts = (artifactInput || []).map(artifactImplementation);
  const functions = new Map();
  for (const artifact of artifacts) for (const id of artifact.functionIds) {
    if (!functions.has(id)) functions.set(id, { functionId: id, artifacts: {} });
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
  const reqOwners = new Map();
  for (const artifact of artifacts.filter((item) => item.type === 'REQ')) for (const id of artifact.functionIds) {
    if (reqOwners.has(id)) issues.push({ code: 'RDL-IMPL-009', severity: 'error', target: id, artifactId: artifact.id, message: `기능 ID가 여러 REQ에 중복 정의되었습니다: ${id}` });
    else reqOwners.set(id, artifact.id);
  }
  // 기능 정본 유일성: 한 기능이 같은 유형의 문서 여럿에 흩어지는 것을 막는다.
  // REQ는 009가 이미 상시 오류로 지키고 있고, 나머지 유형은 새 계약이므로 단계 도입한다.
  for (const type of ['SCR', 'MOD', 'IFC', 'TST']) {
    const owners = new Map();
    for (const artifact of artifacts.filter((item) => item.type === type)) for (const id of artifact.functionIds) {
      if (owners.has(id)) issues.push({ code: 'RDL-IMPL-016', severity: settings.implementation ? 'error' : 'warning', target: id, artifactId: artifact.id, message: `기능 ID가 여러 ${type} 문서에 중복 선언되었습니다: ${id} (${owners.get(id)}에 이미 있음)` });
      else owners.set(id, artifact.id);
    }
  }
  const trace = implementationTrace(artifactInput);
  for (const entry of trace.entries) {
    if ((!entry.artifacts.REQ || entry.artifacts.REQ.length === 0) && Object.keys(entry.artifacts).some((type) => type !== 'REQ')) issues.push({ code: 'RDL-IMPL-011', severity: 'error', target: entry.functionId, message: `REQ 원천 계약 없이 하위 산출물이 기능 ID를 참조합니다: ${entry.functionId}` });
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

  const linkedIds = unique(implementationArtifacts.flatMap((artifact) => functionIds(artifact.frontmatter && artifact.frontmatter.data)));
  if (requirements.length === 0) issues.push({ code: 'RDL-IMPL-020', severity: 'error', message: `구현 준비도 대상 태스크에는 REQ 문서가 필요합니다.${suggest(linkedIds, 'REQ')}` });
  if (tests.length === 0) issues.push({ code: 'RDL-IMPL-021', severity: 'error', message: `구현 준비도 대상 태스크에는 TST 문서가 필요합니다.${suggest(linkedIds, 'TST')}` });
  for (const artifact of implementationArtifacts) for (const issue of validateImplementationDocument(artifact, { implementation: true })) issues.push(Object.assign({ artifactId: artifact.id }, issue));
  const requiredIds = unique(requirements.flatMap((artifact) => functionIds(artifact.frontmatter && artifact.frontmatter.data)));
  const testedIds = new Set(tests.flatMap((artifact) => functionIds(artifact.frontmatter && artifact.frontmatter.data)));
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
  CONTRACT_VERSION, IMPLEMENTATION_TYPES, FUNCTION_ID_PATTERN, GROUPING_POLICY, REQUIRED_FUNCTION_FIELDS, REQUIRED_FIELDS_BY_TYPE,
  functionIds, isIndexArtifact, validateImplementationDocument, implementationTrace, validateImplementationTrace,
  validateTaskImplementationReadiness, renderImplementationMetadata, renderGroupingMetadata, renderFunctionContracts, renderTestCoverage
};
