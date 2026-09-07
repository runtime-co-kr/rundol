'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { readCollaboration } = require('./collaboration');
const { reserveDocumentId } = require('./document-sequence');
const { newDocumentUid, insertUid } = require('./document-identity');
const { CANONICAL_PATHS: TYPES } = require('./document-paths');
const { assertDocumentCreationAllowed, projectArtifacts } = require('./document-contract');
const { INITIAL_DOCUMENT_STATE } = require('./document-migration');
const { assertBoundaryInput } = require('./document-boundary');
const {
  IMPLEMENTATION_TYPES, GROUPING_POLICY, isIndexArtifact,
  FUNCTION_SUB_KIND, FUNCTION_SOURCE_TYPE, LOCAL_FUNCTION_ID_PATTERN, QUALIFIED_FUNCTION_ID_PATTERN,
  qualifiedFunctionIds, subParent,
  renderImplementationMetadata, renderGroupingMetadata, renderFunctionContracts
} = require('./implementation-contract');
const { parseFrontmatter } = require('./frontmatter');

const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'docs', 'templates');
const { RELATED_REQUIRED_TYPES, SUB_ID_SEPARATOR, DOCUMENT_LIFECYCLE_KEYS, REVISION_FORMULAS } = require('./vocabulary');
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

/**
 * 기능 ID의 부모가 실재하고 그 기능을 선언했는가.
 *
 * related는 오래전부터 실재를 확인받았다 — 없는 문서를 가리키면 만들어지지 않는다.
 * 기능 ID에는 그 대칭이 없어서, 없는 REQ를 가리켜도(REQ-999#FN-001) 있는 REQ이지만 그
 * REQ가 선언한 적 없는 기능을 가리켜도(REQ-001#FN-099) 문서가 만들어졌고 검사는 통과했다.
 *
 * 둘 다 막는다. 하나만 막으면 남은 쪽이 더 나쁘다 — 부모 문서가 실재하는 값은 사람에게
 * 확인된 것처럼 보이는데, 그 기능은 원천 계약 없이 존재하기 때문이다. 부모가 그 기능을
 * 선언해야 한다는 요구는 새 규율이 아니라 이미 있는 것이다: 기능의 원천은 REQ이고,
 * 하위 산출물은 원천을 부모로 달아야만 기능을 가리킬 수 있다.
 *
 * 채번 앞에 선다. 뒤에 두면 거절당한 시도마다 문서 번호가 하나씩 예약된 채로 남는다.
 */
function assertFunctionParents(project, functionIds) {
  const sources = new Map(projectArtifacts(project).map((artifact) => [artifact.id, artifact]));
  for (const functionId of functionIds) {
    const parent = subParent(functionId);
    const source = parent ? sources.get(parent) : null;
    if (!source) throw new Error(`기능 ID의 원천 문서를 찾지 못했습니다: ${functionId} (${parent}이(가) 이 프로젝트에 없습니다)`);
    const parsed = parseFrontmatter(source.source || '');
    const declared = qualifiedFunctionIds(source.type, source.id, (parsed && parsed.data) || {});
    if (declared.includes(functionId)) continue;
    // 그 문서가 선언한 기능을 함께 말한다. 없는 자리라는 말만 하면 사람은 무엇으로
    // 고쳐야 하는지 다시 조사해야 하고, 그 답은 방금 읽은 값 안에 이미 있다.
    throw new Error(declared.length
      ? `${parent}이(가) 선언하지 않은 기능입니다: ${functionId} (${parent}의 기능: ${declared.join(', ')})`
      : `${parent}이(가) 선언하지 않은 기능입니다: ${functionId} (${parent}은(는) 기능을 하나도 선언하지 않았습니다)`);
  }
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
  // 거는 자리는 검사와 같다. REQ는 지나간다 — 기능의 원천이라 자기 기능을 선언하는
  // 것이지 남을 가리키는 것이 아니고, 그 표기(FN-001)에는 부모가 없다. 기능 ID를
  // 나르는 유형이 아니면 애초에 물음이 없다. 두 자리의 조건이 갈리면 만드는 자리가
  // 막는 것과 검사가 말하는 것이 달라지고, 그 차이는 아무 데도 적히지 않는다.
  if (!ownsFunctions && IMPLEMENTATION_TYPES.includes(type) && functionIds.length) assertFunctionParents(project, functionIds);
  const id = nextId(layout, project, type);
  const relatedLines = wikiLinks(related, artifacts);
  const folder = TYPES[type] === 'inbox' ? path.join(project.root, 'inbox') : path.join(project.documents, TYPES[type]);
  const file = path.join(folder, `${id}-${title.filename}.md`);
  if (fs.existsSync(file)) throw new Error(`문서가 이미 존재합니다: ${file}`);
  let source = fs.readFileSync(path.join(TEMPLATE_ROOT, `${type}.template.md`), 'utf8');
  // state는 rdl이 소유하고 원장에서 투영하는 칸이다. 방금 만든 문서는 원장에 사건이
  // 하나도 없으므로 투영은 바닥값이고, 뼈대가 그보다 높은 값을 적으면 그 문서는
  // 태어나는 순간부터 원장에 없는 사실을 말한다 — ADR 뼈대의 `proposed`가 정확히
  // 그랬다. 제출은 rdl doc submit이 원장에 사건을 적을 때 일어나는 일이지 파일을
  // 만들 때 정해지는 값이 아니다.
  //
  // 뼈대 파일 열세 벌을 이미 고쳤는데도 여기서 다시 쓰는 이유는, 그중 하나가 다시
  // 갈리는 날 아무 신호도 나지 않기 때문이다. 만드는 자리는 한 곳이므로 판정도 한
  // 곳에 둔다. 이관이 쓰는 바닥값과 같은 상수를 쓰는 것도 같은 이유다 — 값이 갈리면
  // 만든 문서와 옮긴 문서가 서로 다른 바닥에 선다.
  //
  // lifecycle은 여기서 적지 않는다. 사람이 적는 선택 칸이고 비어 있는 것과 active는
  // 다르다. 뼈대가 미리 적으면 모든 새 문서가 말한 적 없는 수명을 주장하게 되고,
  // 그러면 "수명을 말한 문서"를 찾는 조회가 전 문서를 답한다.
  // 줄 끝의 \r는 그대로 돌려준다. 한 줄만 LF로 바꾸면 나머지가 CRLF인 파일에 섞인
  // 줄 끝이 하나 생기고, 그 파일을 다음에 손대는 도구마다 다르게 읽는다.
  source = source.replace(/^state:[ \t]*.*?(\r?)$/mu, (whole, eol) => `state: ${INITIAL_DOCUMENT_STATE}${eol}`);
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

// ── 문서 수명(lifecycle) 축 ─────────────────────────────────────────────────
//
// 이 칸을 옮기는 길이 지금까지 하나도 없었다. 값을 쓰는 코드는 이관 하나뿐이고
// (document-migration.js가 옛 state 값을 옮길 때만 쓴다), 명령도 화면도 없어서
// 「이 결정은 대체됐다」를 말하는 유일한 길이 frontmatter를 손으로 고치는 것이었다.
// ADR-026이 그 자리를 실측으로 세었고, 그 문서가 답을 요구한 것은 값이 아니라
// **전환과 사유**다 — 「중복」은 어휘에 더할 값이 아니라 대체 전환의 사유다.
//
// 판정을 여기 한 곳에 둔다. 명령줄과 Board가 같은 답을 내야 하는데, 두 자리가 각자
// 어휘를 검사하고 각자 frontmatter를 고치면 어느 쪽이 정본인지 물을 자리가 없다.
//
// **state는 건드리지 않는다.** 그 칸은 rdl이 승인 원장에서 투영하고(REQ-078 규칙 2·3),
// 수명은 원장이 모르는 다른 축이다. 한 함수가 두 칸을 다루면 언젠가 한쪽이 다른 쪽을
// 덮고, 그때 파일은 원장에 없는 사실을 말하게 된다.

const LIFECYCLE_LINE = /^lifecycle:[^\r\n]*$/mu;
const STATE_LINE = /^state:[^\r\n]*$/mu;
// 커밋 메시지의 기계 판독 줄. 이름을 상수로 두는 이유는 Rundol-Task와 같다 — 철자가
// 갈리면 이 줄을 되짚는 쪽이 아무 신호 없이 빈손으로 돌아온다.
const LIFECYCLE_TRAILER = 'Rundol-Lifecycle';

/**
 * frontmatter의 lifecycle 한 줄만 갈아 끼운 원본. 바꿀 것이 없으면 원본 그대로다.
 *
 * 줄 하나만 손대는 것은 approval.js의 `withProjectedState`가 쓰는 방법이고 이유도 같다 —
 * 파싱해서 다시 쓰면 따옴표 표기나 줄 순서가 조용히 정규화되고, 그 정규화만으로 리비전이
 * 움직여 이 문서에 걸린 승인이 전부 낡는다. 줄바꿈도 그 문서가 쓰던 것을 그대로 둔다:
 * [^\r\n]*는 CRLF의 \r을 먹지 않는다.
 *
 * value가 null이면 줄을 지운다. **비어 있는 것과 active는 다르므로**(vocabulary.js) 지우는
 * 길이 값을 고르는 길과 나란히 있어야 한다. 값만 비운 `lifecycle:` 한 줄을 남기지 않는
 * 이유는 파서가 그것을 빈 배열로 읽어 어휘 밖 값이 되기 때문이다(RDL-DOC-017).
 *
 * 새로 넣는 자리는 state 바로 아래다. 이관이 같은 자리에 넣으므로, 옮겨 온 문서와 여기서
 * 적은 문서의 frontmatter 모양이 갈리지 않는다.
 */
function withDocumentLifecycle(source, value) {
  if (!/^---\r?\n/u.test(source)) return null;
  const close = /\r?\n---[^\S\r\n]*(?:\r?\n|$)/u.exec(source);
  if (!close) return null;
  const head = source.slice(0, close.index);
  const tail = source.slice(close.index);
  if (value === null) {
    if (!LIFECYCLE_LINE.test(head)) return source;
    // 앞의 줄바꿈까지 함께 지운다. 줄만 비우면 frontmatter에 빈 줄이 하나 남고, 그
    // 빈 줄은 아무 뜻도 없으면서 리비전을 움직인다.
    return `${head.replace(/\r?\nlifecycle:[^\r\n]*/u, '')}${tail}`;
  }
  const line = `lifecycle: ${value}`;
  if (LIFECYCLE_LINE.test(head)) {
    const replaced = head.replace(LIFECYCLE_LINE, line);
    return replaced === head ? source : `${replaced}${tail}`;
  }
  const eol = head.includes('\r\n') ? '\r\n' : '\n';
  if (STATE_LINE.test(head)) return `${head.replace(STATE_LINE, (whole) => `${whole}${eol}${line}`)}${tail}`;
  return `${head}${eol}${line}${tail}`;
}

/**
 * 옮길 값. 어휘 밖은 여기서 막는다.
 *
 * 뒤에서 RDL-DOC-017이 다시 잡지만 그 검사는 파일이 이미 그 값을 든 뒤에 도는 것이고,
 * 그때는 커밋이 한 번 나 있다. 어휘를 두 번째로 적지 않는 이유는 이 저장소가
 * vocabulary.js를 만든 이유 그대로다.
 */
function lifecycleTarget(input) {
  const raw = input.lifecycle === undefined || input.lifecycle === null ? '' : String(input.lifecycle).trim();
  if (input.clear === true) {
    if (raw) throw new Error(`수명 값과 지우기를 함께 지정할 수 없습니다: ${raw}. 옮길 값을 대거나 칸을 지우거나 둘 중 하나입니다.`);
    return null;
  }
  if (!raw) throw new Error(`옮길 문서 수명 값이 필요합니다 (가능: ${DOCUMENT_LIFECYCLE_KEYS.join(', ')}, 또는 --clear로 칸 자체를 지웁니다).`);
  if (!DOCUMENT_LIFECYCLE_KEYS.includes(raw)) throw new Error(`문서 수명 어휘 밖의 값입니다: ${raw} (가능: ${DOCUMENT_LIFECYCLE_KEYS.join(', ')}, 또는 --clear로 칸 자체를 지웁니다).`);
  return raw;
}

/**
 * 이 변경이 낡게 만들 승인. 누르기 전에 **이름으로** 말해야 하는 값이다.
 *
 * 수명은 리비전 해시 안에 있다 — 판 2가 빼는 것은 `state` 하나뿐이다(REVISION_OWNED_FIELDS).
 * 그러므로 수명을 옮기면 그 문서에 걸린 승인이 그 자리에서 낡는다. 이것은 결함이 아니라
 * 축이고(REQ-079 규칙 8 · ADR-026 · MIGRATION-0.45), 그래서 막는 것이 아니라 먼저 말한다.
 *
 * 단정하지 않고 실제로 잰다. rdl doc migrate가 이관 계획에서 쓰는 방법 그대로이고 이유도
 * 같다 — 재지 않고 겁만 주는 목록은 곧 아무도 안 읽는다. 그리고 건수가 아니라 누구의
 * 승인인지를 말한다. "지금 다시 승인할 수 있나"는 이름 없이는 판단할 수 없다.
 */
function lifecycleApprovalRisk(start, project, document, source, next) {
  let ledger;
  try { ledger = require('./approval').documentStatus(start, { project: project.key }); }
  catch (error) { return { atRisk: null, note: `승인 영향을 재지 못했습니다: ${error.message}. 이 변경이 어느 승인을 낡게 하는지 알 수 없습니다.` }; }
  const entry = (ledger.documents || []).find((item) => item.id === document.id);
  if (!entry || entry.status !== 'approved') {
    return { atRisk: null, note: `낡는 승인은 없습니다. ${document.id}은(는) ${entry ? `지금 ${entry.status}이므로` : '원장이 모르는 문서이므로'} 잃을 승인이 없습니다.` };
  }
  const { documentRevisions } = require('./board-data');
  const revisionsOf = (text) => {
    const front = parseFrontmatter(String(text).replace(/^\uFEFF/u, ''));
    return front ? documentRevisions(front.data, front.body) : null;
  };
  const before = revisionsOf(source);
  const after = revisionsOf(next);
  const moved = before && after ? REVISION_FORMULAS.filter((formula) => before[formula] !== after[formula]) : REVISION_FORMULAS.slice();
  if (!moved.length) return { atRisk: null, note: `낡는 승인은 없습니다. 이 쓰기는 ${document.id}의 리비전을 움직이지 않습니다.` };
  const atRisk = {
    id: document.id,
    file: document.file,
    approvedBy: entry.approvedBy || null,
    movedFormulas: moved.join('·')
  };
  return {
    atRisk,
    note: `이 변경으로 ${document.id}의 승인 1건이 낡습니다(${atRisk.approvedBy || '승인자 미상'}). 낡은 승인은 사람이 다시 눌러야 합니다. 수명 값이 리비전 해시 안에 있어 생기는 일이며(REQ-079 규칙 8) 결함이 아니라 축입니다 — 내용이 바뀌면 다시 봐야 합니다.`
  };
}

/**
 * 쓰기 전의 계획. 저장하지 않고 무엇이 달라지는지와 무엇을 잃는지만 답한다.
 *
 * 계획을 따로 세우는 이유는 화면과 명령줄이 "누르기 전"에 같은 문장을 말해야 하기
 * 때문이다. 두 자리가 각자 경고를 지어내면 둘은 갈리고, 갈린 날 사람은 자기가 무엇을
 * 잃는지 화면마다 다르게 듣는다.
 */
function planDocumentLifecycle(start, input) {
  const settings = input || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const to = lifecycleTarget(settings);
  const reason = String(settings.reason == null ? '' : settings.reason).trim();
  // 사유가 이 축의 값 전부다. ADR-026이 물은 것은 어휘에 값을 더할지가 아니라 대체
  // 전환의 사유를 어디에 남길지였고, 사유 없이 값만 옮기는 명령은 지금 손으로 고치는
  // 것을 한 번 더 만드는 일이다 — 그러면 이 갈래는 아무것도 사지 않는다.
  if (!reason) throw new Error('수명을 옮기는 사유가 필요합니다. 값만 옮기면 왜 옮겼는지가 어디에도 남지 않습니다.');
  if (reason.length > 1000) throw new Error(`수명 사유가 너무 깁니다: ${reason.length}자 (1000자까지).`);
  const targetId = String(settings.targetId || '').trim();
  const document = require('./board-data').listDocuments(project).find((item) => item.id === targetId);
  if (!document) throw new Error(`문서를 찾지 못했습니다: ${targetId || '(없음)'}`);
  const file = path.resolve(project.root, document.file);
  if (!file.startsWith(`${path.resolve(project.root)}${path.sep}`)) throw new Error(`프로젝트 경로 밖의 문서에는 수명을 적을 수 없습니다: ${document.file}`);
  const source = fs.readFileSync(file, 'utf8');
  const next = withDocumentLifecycle(source, to);
  if (next === null) throw new Error(`표준 frontmatter가 없어 수명을 적을 자리가 없습니다: ${document.file}`);
  const changed = next !== source;
  const risk = changed
    ? lifecycleApprovalRisk(start, project, document, source, next)
    : { atRisk: null, note: '바꿀 것이 없으므로 낡는 승인도 없습니다.' };
  const plan = {
    root: layout.root, project: project.key, id: document.id, file: document.file,
    from: document.lifecycle, to, changed, reason,
    approvalsAtRisk: risk.atRisk ? [risk.atRisk] : [], approvalNote: risk.note,
    applied: false, commit: null
  };
  // 원본과 쓸 내용은 결과에 싣지 않는다. printOperation이 긴 문자열을 그대로 뱉으면
  // 사람이 읽을 답이 파일 두 벌에 묻힌다. 쓰는 쪽만 쓰도록 감춘 칸으로 넘긴다.
  Object.defineProperty(plan, 'sourceText', { value: source, enumerable: false });
  Object.defineProperty(plan, 'nextText', { value: next, enumerable: false });
  Object.defineProperty(plan, 'absoluteFile', { value: file, enumerable: false });
  Object.defineProperty(plan, 'projectRoot', { value: project.root, enumerable: false });
  return plan;
}

/**
 * 사유가 사는 자리는 커밋 메시지다.
 *
 * ADR-026은 이 축의 사건을 결정 원장의 `doc-replace`로 나르자고 **권고**했다. 그 문서는
 * 아직 제안이고(state: proposed, "이 문서는 제안이며 채택은 오너가 한다"), 그 권고를
 * 세우는 데 필요한 것 — 수명 그래프의 간선 목록, 전환마다 요구할 입력, 한 문서를 같은
 * 자리에서 두 번 옮길 때 결정 키가 갈리는 규칙 — 이 그 문서의 후속 작업으로 남아 있다.
 * 그것들이 정해지기 전에 결정 사건을 적기 시작하면 사건은 추가 전용이라 지울 수 없다
 * ("여는 것은 되돌릴 수 있고 쓰는 것은 되돌리기 어렵다", ADR-025·ADR-026).
 *
 * 그래서 지금 사유는 커밋 메시지가 나른다. 근거는 ADR-026 자신이 적어 두었다 —
 * **"수명 값이 내용 안에 있으므로 그 값이 바뀐 커밋이 곧 그 전환의 주소다."** 주소가
 * 이미 커밋이므로 사유를 그 주소에 붙이면 사유와 전환이 같은 자리에 선다. 새 원장도 새
 * 사건 종류도 만들지 않는다는 선택지 D의 성질도 그대로 유지된다.
 *
 * 값과 사유는 같이 서거나 같이 안 선다. 커밋이 실패하면 쓰기를 되돌리는 이유가 그것이다 —
 * 사유 없이 값만 남는 것이 ADR-026이 세어 낸 바로 그 상태이고, 이 명령이 없애려는 것이다.
 */
function lifecycleCommitMessage(plan) {
  const from = plan.from || 'none';
  const to = plan.to || 'none';
  return `rdl: ${plan.id} 수명 ${from} → ${to}\n\n${plan.reason}\n\n${LIFECYCLE_TRAILER}: ${plan.id} ${from} -> ${to}`;
}

// 그 문서 하나만 담는다. `git commit -- <path>`는 index를 쓰지 않고 넘긴 경로만 담으므로,
// 같은 worktree에서 사람이 편집 중인 다른 문서가 이 커밋에 딸려 들어가지 않는다. 문서와
// 태스크는 프로젝트마다 한 worktree를 공유하기로 한 자리라(ADR-007) 범위를 좁히는 쪽이
// 유일한 답이다.
function commitDocumentLifecycle(root, relativeFile, message) {
  const { runGit } = require('./git');
  runGit(['add', '--', relativeFile], { cwd: root });
  runGit(['commit', '-m', message, '--', relativeFile], { cwd: root });
  return runGit(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
}

/**
 * 값 검증 · frontmatter 쓰기 · 커밋. 세 표면이 부르는 한 자리다.
 *
 * 살아 있는 승인을 낡게 만드는 변경은 `ackStale` 없이는 거절한다. 막는 관문이 아니라
 * **누르기 전에 말하는 자리**다 — 거절 문장이 누구의 승인이 낡는지를 이름으로 말하고,
 * 같은 명령에 그 표시를 붙이면 그대로 지나간다. 사람의 주의를 유한한 예산으로 다루는
 * 자리이며(ADR-026 결정 기준), 그 예산을 쓰는 것은 사람이 정한다.
 *
 * **사람 자격은 묻지 않는다.** 근거는 셋이다. (1) 이 축을 입력으로 읽는 판정이 지금
 * 하나도 없다 — RDL-DOC-017의 값 검사뿐이고, 그것은 인가가 아니라 오타 판정이다
 * (ADR-026 「부분 도입이 성립하는가」의 실측). (2) 이 칸은 frontmatter 한 줄이라 아무
 * 편집기나 닿는다. 명령에만 관문을 세우면 그 관문은 옆에 열린 문을 둔 울타리이고,
 * ADR-027이 같은 모양을 두고 "화면의 게이트는 울타리가 아니라 장식이다"라고 적었다.
 * (3) 이 저장소의 사람 게이트는 승인 축에 걸려 있다(`assertProjectHumanApprover`).
 * 제출은 일부러 그 게이트를 지나지 않는데, 에이전트가 쓰고 사람이 책임지는 분업에서
 * 앞쪽까지 사람 전용이면 관문이 아니라 병목이 되기 때문이다 — 수명은 그 앞쪽이다.
 *
 * 관문을 세워야 할 근거가 생기는 자리는 따로 있다. ADR-026의 권고가 채택되어 수명
 * 전환이 결정 원장의 `doc-replace`(가족 destructive)로 나가는 날이고, 그 원장의 답변은
 * 이미 사람 자격을 요구한다. 그때 관문은 이 함수가 아니라 그 사건이 갖는다.
 */
function setDocumentLifecycle(start, input) {
  const settings = input || {};
  const plan = planDocumentLifecycle(start, settings);
  // 이미 그 값이면 쓰지 않는다. 같은 내용을 다시 써서 파일 시각만 흔들면 그것을 보는
  // 감시와 훅이 바뀐 것 없는 변경을 신호로 내고, 커밋도 빈 커밋이 된다.
  if (!plan.changed) return plan;
  if (plan.approvalsAtRisk.length && settings.ackStale !== true) {
    const error = new Error(`${plan.approvalNote} 알고 바꾸려면 이 변경에 낡음 확인을 함께 주십시오(명령줄은 --ack-stale).`);
    error.code = 'approval-at-risk';
    error.statusCode = 409;
    error.approvalsAtRisk = plan.approvalsAtRisk;
    error.approvalNote = plan.approvalNote;
    throw error;
  }
  // 쓰기와 커밋을 rdl save가 쓰는 그 자물쇠 안에 넣는다. 같은 프로젝트 worktree를
  // 공유하기로 한 자리라(ADR-007) 저장이 겹치면 그쪽의 `git add -A`가 방금 쓴 수명 줄을
  // 자기 커밋에 담아 가고, 그러면 값은 남는데 사유는 남지 않는다 — 이 명령이 없애려던
  // 바로 그 상태다. 기다리지 않고 거절하는 것도 저장과 같은 판단이다: 붙잡아 두면
  // 부르는 쪽이 통째로 멈추고, 누가 쥐고 있는지 말해 주면 다시 부를지는 그쪽이 정한다.
  const { runtimeWorkspace, withProcessLock } = require('./runtime');
  try {
    withProcessLock(runtimeWorkspace(plan.root), `save-${plan.project}`, () => writeDocumentLifecycle(plan));
  } catch (error) {
    if (!error || error.code !== 'RDL_PROCESS_LOCKED') throw error;
    const holder = error.lock && error.lock.pid;
    const locked = new Error(`같은 프로젝트를 다른 저장이 쓰고 있습니다: ${plan.project}${holder ? ` (pid ${holder})` : ''}. 그 저장이 끝난 뒤 다시 실행하세요.`);
    locked.code = 'RDL-SAVE-012';
    locked.statusCode = 409;
    throw locked;
  }
  plan.applied = true;
  return plan;
}

function writeDocumentLifecycle(plan) {
  const file = plan.absoluteFile;
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, plan.nextText, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
  try {
    plan.commit = commitDocumentLifecycle(plan.projectRoot, plan.file, lifecycleCommitMessage(plan));
  } catch (error) {
    // 값과 사유는 같이 서거나 같이 안 선다. 커밋이 안 되면 남는 것은 사유 없는 수명
    // 값이고, 그것이 이 명령이 없애려던 상태다.
    fs.writeFileSync(file, plan.sourceText, 'utf8');
    throw new Error(`수명을 커밋하지 못해 쓰기를 되돌렸습니다(${plan.file}): ${error.message}. 사유 없이 값만 남기지 않기 위해서입니다.`);
  }
}

function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = { TYPES, registry, createDocument, withDocumentLifecycle, planDocumentLifecycle, setDocumentLifecycle };
