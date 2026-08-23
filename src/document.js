'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { readCollaboration } = require('./collaboration');
const { reserveDocumentId } = require('./document-sequence');
const { newDocumentUid, insertUid } = require('./document-identity');
const { CANONICAL_PATHS: TYPES } = require('./document-paths');
const { assertDocumentCreationAllowed } = require('./document-contract');
const { assertBoundaryInput } = require('./document-boundary');
const {
  IMPLEMENTATION_TYPES, GROUPING_POLICY, isIndexArtifact,
  FUNCTION_SUB_KIND, FUNCTION_SOURCE_TYPE, LOCAL_FUNCTION_ID_PATTERN, QUALIFIED_FUNCTION_ID_PATTERN,
  renderImplementationMetadata, renderGroupingMetadata, renderFunctionContracts
} = require('./implementation-contract');

const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'docs', 'templates');
const { RELATED_REQUIRED_TYPES, SUB_ID_SEPARATOR } = require('./vocabulary');
const RELATED_REQUIRED = new Set(RELATED_REQUIRED_TYPES);

function markdownFiles(root, output) {
  const result = output || [];
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) markdownFiles(file, result);
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(file);
  }
  return result;
}

function registry(project) {
  const values = new Map();
  for (const file of markdownFiles(project.root)) {
    const source = fs.readFileSync(file, 'utf8');
    const match = /^id:\s*([^\r\n]+)/mu.exec(source);
    if (match) values.set(match[1].trim().replace(/^['"]|['"]$/g, ''), path.basename(file, '.md'));
  }
  return values;
}

function safeTitle(value) {
  const title = String(value || '').trim();
  if (!title) throw new Error('문서 제목이 필요합니다.');
  if (isIndexArtifact(title)) throw new Error('별도 인덱스·목록·추적표 문서는 만들지 않습니다. 직접 링크와 rdl contract trace를 사용하세요.');
  const filename = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!filename) throw new Error(`파일명으로 사용할 수 없는 문서 제목입니다: ${title}`);
  return { title, filename };
}

// 채번 예약은 유지한다. ADR-009는 번호를 표시값으로 내리기로 했지만, 조인이
// 실제로 uid로 옮겨가기 전까지 번호는 여전히 사실상의 키다 — 태스크 links,
// related 위키 링크, 추적성, 승인 대상이 모두 번호로 조인한다. 조인이 남아
// 있는 채로 예약만 없애면 두 클라이언트가 같은 번호를 만들어 한쪽이 조용히
// 덮인다. 조율 제거는 uid 전환을 마친 뒤다.
function nextId(layout, project, type) {
  let maximum = 0;
  for (const id of registry(project).keys()) {
    const match = new RegExp(`^${type}-(\\d{3})$`).exec(id);
    if (match) maximum = Math.max(maximum, Number.parseInt(match[1], 10));
  }
  if (maximum >= 999) throw new Error(`${type} 문서 번호 999를 초과할 수 없습니다.`);
  return reserveDocumentId(layout.root, project.key, type, maximum);
}

function wikiLinks(ids, artifacts) {
  return ids.map((id) => {
    const stem = artifacts.get(id);
    if (!stem) throw new Error(`related 문서를 찾지 못했습니다: ${id}`);
    return `  - "[[${stem}|${id}]]"`;
  });
}

function createDocument(start, input) {
  const type = String(input.type || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(TYPES, type)) throw new Error(`지원하지 않는 문서 유형입니다: ${type}`);
  const layout = workspaceLayout(start);
  const project = selectProject(layout, input.project, true);
  const contract = assertDocumentCreationAllowed(layout.root, project.key, type);
  const title = safeTitle(input.title);
  const boundary = type === 'NTE' ? null : assertBoundaryInput(type, { scope: input.scope, excludes: input.excludes });
  const functionIds = Array.from(new Set((input.functionIds || []).map((value) => String(value).trim()).filter(Boolean)));
  if (IMPLEMENTATION_TYPES.includes(type) && functionIds.length === 0) throw new Error(`${type} 문서는 --function-id <기능-ID>가 하나 이상 필요합니다.`);
  // 만드는 자리에서도 표기는 부모가 자명한지로 갈린다. 검사에서만 가르면 어긋난 표기가
  // 파일에 먼저 들어가고, 사람은 방금 만든 문서에서 진단을 처음 만난다.
  const ownsFunctions = type === FUNCTION_SOURCE_TYPE;
  for (const functionId of functionIds) {
    if (ownsFunctions ? LOCAL_FUNCTION_ID_PATTERN.test(functionId) : QUALIFIED_FUNCTION_ID_PATTERN.test(functionId)) continue;
    throw new Error(ownsFunctions
      ? `${type} 문서는 자기 기능을 문서 안 표기로 적습니다: ${functionId} (부모는 이 문서 자신이므로 ${FUNCTION_SUB_KIND}-001)`
      : `${type} 문서는 원천 계약을 부모로 단 기능 ID가 필요합니다: ${functionId} (${FUNCTION_SOURCE_TYPE}-033${SUB_ID_SEPARATOR}${FUNCTION_SUB_KIND}-001)`);
  }
  // 문서 1개 = 기능 1개가 기본이다. 합침은 --grouped --reason의 명시적 opt-in이고,
  // forbidden 유형(REQ·SCR)은 선언으로도 열리지 않는다 — 분리가 유일한 길이다.
  const groupingReason = String(input.reason || '').trim();
  if (functionIds.length > 1) {
    if (GROUPING_POLICY[type] === 'forbidden') throw new Error(`${type} 문서는 기능 1개만 나릅니다. 기능마다 문서를 분리하세요: ${functionIds.join(', ')}`);
    if (!input.grouped) throw new Error(`기능 ${functionIds.length}개를 한 문서에 담으려면 --grouped와 --reason <합침 사유>로 명시해야 합니다.`);
    if (!groupingReason) throw new Error('--grouped에는 --reason <합침 사유>가 필요합니다.');
  } else if (input.grouped) throw new Error('--grouped는 --function-id가 2개 이상일 때만 의미가 있습니다.');
  const collaboration = readCollaboration(layout.root, project.key);
  const owner = collaboration.members.find((member) => member.id === input.owner);
  if (!owner) throw new Error(`project.md에 등록된 --owner <MEMBER-ID>가 필요합니다: ${input.owner || '(없음)'}`);
  const related = Array.from(new Set(input.related || []));
  if (RELATED_REQUIRED.has(type) && related.length === 0) throw new Error(`${type} 문서는 --related <ARTIFACT-ID>가 하나 이상 필요합니다.`);
  const artifacts = registry(project);
  const id = nextId(layout, project, type);
  const relatedLines = wikiLinks(related, artifacts);
  const folder = TYPES[type] === 'inbox' ? path.join(project.root, 'inbox') : path.join(project.documents, TYPES[type]);
  const file = path.join(folder, `${id}-${title.filename}.md`);
  if (fs.existsSync(file)) throw new Error(`문서가 이미 존재합니다: ${file}`);
  let source = fs.readFileSync(path.join(TEMPLATE_ROOT, `${type}.template.md`), 'utf8');
  if (type === 'PRD') source = source.replaceAll('<프로젝트명> 제품 요구사항', title.title);
  source = source.replace(new RegExp(`id: ${type}-\\d{3}`), `id: ${id}`)
    .replace(new RegExp(`  - ${type}-\\d{3}`), `  - ${id}`)
    .replace(/owner:\s*"[^"]*"/u, `owner: "[[project#^${owner.id}|${owner.name || owner.id}]]"`)
    .replace(/related:\s*\[\]/u, relatedLines.length ? `related:\n${relatedLines.join('\n')}` : 'related: []')
    .replace(/related:\s*\r?\n(?:\s+-[^\r\n]*\r?\n)+/u, relatedLines.length ? `related:\n${relatedLines.join('\n')}\n` : 'related: []\n')
    .replaceAll('<domain>', input.domain || project.key)
    .replaceAll('<feature>', input.feature || title.filename.toLowerCase())
    .replaceAll('<topic>', input.feature || title.filename.toLowerCase());
  if (boundary) source = source.replace(/^scope:\s*.*$/mu, `scope: ${yamlQuote(boundary.scope)}`)
    .replace(/^excludes:\s*\r?\n(?:\s{2}-[^\r\n]*\r?\n?)+/mu, `excludes:\n${boundary.excludes.map((value) => `  - ${yamlQuote(value)}`).join('\n')}\n`);
  if (functionIds.length) source = source.replace(/^granularity:\s*bounded-v1\s*$/mu, `granularity: bounded-v1\n${renderImplementationMetadata(functionIds)}${functionIds.length > 1 ? `\n${renderGroupingMetadata(groupingReason, functionIds)}` : ''}`);
  // 기능별 계약은 유형의 하부 요소가 아니라 기능의 계약이다. 아래 하부 요소 재구성이
  // 건드리지 않도록 맨 마지막에 붙인다. 유형마다 제목이 달라(설계/검증) 문구로 찾으면 놓친다.
  const functionContracts = IMPLEMENTATION_TYPES.includes(type) ? renderFunctionContracts(type, functionIds) : '';
  const titleTokens = ['<프로젝트명>', '<제품명>', '<요구사항 제목>', '<화면 또는 상호작용 제목>', '<데이터 영역 제목>', '<인터페이스 제목>', '<결정 제목>', '<검증 범위 제목>', '<서비스/작업 운영 절차>', '<노트 제목>'];
  for (const token of titleTokens) source = source.replaceAll(token, title.title);
  source = source.replace(/<([^>]+)>/g, (_, hint) => `작성 필요 — ${hint}`);
  // 프리셋의 하부 요소는 기본값을 더하는 것이 아니라 대체하는 계약이다. 더하기만 하면
  // 팀이 뺀 절이 뼈대에 그대로 남아, 만들어진 문서와 contract show가 말하는 목록이 달라진다.
  // 템플릿에 있던 절이라도 프리셋에 없으면 뼈대에서 뺀다. 순서도 프리셋을 따른다.
  const { loadBoardPresentation, resolveProfileSections } = require('./board-presentation');
  const presetSections = resolveProfileSections(loadBoardPresentation(layout.root, project.key), contract.profile ? contract.profile.name : null);
  const wanted = presetSections[type] || [];
  if (wanted.length) {
    const lines = source.split(/\r?\n/u);
    const heads = lines.map((line, index) => ({ index, match: /^##\s+(.+?)\s*#*\s*$/u.exec(line) })).filter((item) => item.match);
    if (heads.length) {
      const first = heads[0].index;
      const bodyOf = (name) => {
        const at = heads.find((item) => item.match[1].trim() === name);
        if (!at) return null;
        const next = heads.find((item) => item.index > at.index);
        return lines.slice(at.index, next ? next.index : lines.length).join('\n').replace(/\s*$/u, '');
      };
      const rebuilt = wanted.map((section) => bodyOf(section) || `## ${section}\n`).join('\n\n');
      source = `${lines.slice(0, first).join('\n').replace(/\s*$/u, '')}\n\n${rebuilt}\n`;
    }
  }
  if (functionContracts) source += functionContracts;
  // 조인 키는 번호가 아니라 uid다. 번호와 제목을 나중에 다시 정리해도 이 값을
  // 가리키는 연결은 살아남는다.
  const uid = newDocumentUid();
  source = insertUid(source, uid);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
  return { root: layout.root, project: project.key, id, uid, type, title: title.title, file, relativeFile: path.relative(layout.root, file).replace(/\\/g, '/'), contractStatus: contract.status, boundary: boundary ? { version: boundary.version, scope: boundary.scope, excludes: boundary.excludes } : null, functionIds, implementationContract: functionIds.length ? 'atomic-v1' : null, granularityGuidance: boundary ? boundary.guidance : null };
}

function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = { TYPES, registry, createDocument };
