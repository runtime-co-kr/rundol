'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { readCollaboration } = require('./collaboration');
const { reserveDocumentId } = require('./document-sequence');
const { CANONICAL_PATHS: TYPES } = require('./document-paths');
const { assertDocumentCreationAllowed } = require('./document-contract');
const { assertBoundaryInput } = require('./document-boundary');
const {
  IMPLEMENTATION_TYPES, FUNCTION_ID_PATTERN, isIndexArtifact,
  renderImplementationMetadata, renderFunctionContracts
} = require('./implementation-contract');

const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'docs', 'templates');
const RELATED_REQUIRED = new Set(['REQ', 'SCR', 'MOD', 'API', 'TST', 'RUN']);

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
  if (IMPLEMENTATION_TYPES.includes(type) && functionIds.length === 0) throw new Error(`${type} 문서는 --function-id <기능-ID>가 하나 이상 필요합니다. 여러 기능을 한 문서에 담을 수 있지만 기능별 계약은 독립적으로 작성해야 합니다.`);
  for (const functionId of functionIds) if (!FUNCTION_ID_PATTERN.test(functionId)) throw new Error(`기능 ID 형식이 잘못되었습니다: ${functionId}`);
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
  if (functionIds.length) source = source.replace(/^granularity:\s*bounded-v1\s*$/mu, `granularity: bounded-v1\n${renderImplementationMetadata(functionIds)}`);
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
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
  return { root: layout.root, project: project.key, id, type, title: title.title, file, relativeFile: path.relative(layout.root, file).replace(/\\/g, '/'), contractStatus: contract.status, boundary: boundary ? { version: boundary.version, scope: boundary.scope, excludes: boundary.excludes } : null, functionIds, implementationContract: functionIds.length ? 'atomic-v1' : null, granularityGuidance: boundary ? boundary.guidance : null };
}

function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = { TYPES, registry, createDocument };
