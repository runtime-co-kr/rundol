'use strict';

// 검사의 판정부. 파일을 읽지 않고 이미 읽어 둔 값만 보고 진단을 만든다.
//
// 이 분리가 필요한 이유는 코드 정리가 아니라 답의 일치다. 같은 저장소 상태에서
// 명령줄과 보드와 워커 어댑터가 다른 판정을 내면 사람과 에이전트는 같은 계층이
// 아니게 된다. 판정이 파일 읽기와 붙어 있는 한 각 표면은 자기 경로로 다시
// 구현하게 되고, 다시 구현한 것들은 조금씩 달라진다.
//
// 그래서 여기에는 파일에 닿는 require가 없다. 값을 만드는 일은 check.js가 하고, 그
// 값을 보고 옳고 그름을 말하는 일만 여기서 한다. worker-contract-purity.test.js가
// 전이 의존까지 따라가며 이 경계를 지킨다.

const { ruleSource } = require('./diagnostic-rules');

const REQUIRED_FIELDS = ['id', 'type', 'kind', 'title', 'description', 'owner', 'state', 'tags', 'aliases', 'related'];
const ID_PATTERN = /^[A-Z]{3}-\d{3,}$/u;
const FILE_PATTERN = /^[A-Z]{3}-\d{3,}-(?=.*[가-힣])[가-힣A-Za-z0-9]+(?:-[가-힣A-Za-z0-9]+)*\.md$/u;
const NON_CANONICAL_CODES = new Set(['NTE']);
const REQUIRED_TAG_NAMESPACES = ['rundol/', 'artifact/', 'domain/', 'feature/'];
const NOTE_TAG_NAMESPACES = ['rundol/'];
// 조인 키의 형식 판정. 정체성 모듈이 아니라 규칙 쪽에 두는 이유는, 이것이 값 하나를
// 보고 옳고 그름을 말하는 규칙이기 때문이다. 저장·부여는 정체성 모듈의 일이고
// 그 모듈은 파일을 읽으므로, 판정이 거기 있으면 판정도 함께 파일에 묶인다.
const DOCUMENT_UID = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

const GOVERNANCE_HEADINGS = ['미션', '목표', '범위', '역할', '프로젝트 팀원', '이해관계자', '책임 매트릭스', '의사결정과 에스컬레이션', '위험과 제약', '협업 리듬', '완료 정의'];
const GOVERNANCE_BLOCK_FIELDS = {
  ROLE: ['미션', '결정권', '주요 산출물', '에스컬레이션'],
  MEMBER: ['역할', '소속', '업무 계정', '책임 영역', '상태'],
  STAKEHOLDER: ['유형', '관심', '영향력', '참여 방식', '담당 역할']
};

function headingKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function wikiTarget(value) {
  if (typeof value !== 'string') return null;
  const match = /^\[\[([^|\]#]+)(?:#([^|\]]+))?(?:\|[^\]]+)?\]\]$/.exec(value.trim());
  return match ? { id: match[1], anchor: match[2] || null } : null;
}

function lineOf(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) return 1;
  return source.slice(0, index).split(/\r?\n/).length;
}

function diagnostic(list, values) {
  const entry = Object.assign({ severity: 'error', category: 'metadata', file: null, line: 1, artifactId: null, target: null }, values);
  // 진단이 자기 규칙의 정본 문서를 들고 다닌다. 없으면 사람도 에이전트도 이 코드가
  // 왜 존재하는지 알려면 검사기 소스를 뒤져야 한다. 모르는 코드에는 붙이지 않는다 —
  // 틀린 근거는 근거가 없는 것보다 나쁘다.
  const rule = ruleSource(entry.code);
  if (rule) entry.rule = rule;
  list.push(entry);
}

function resolveArtifact(registry, id) {
  return registry.get(id) || null;
}

function uniqueDocuments(documents) {
  const seen = new Set();
  return documents.filter((document) => {
    const key = document.file || document.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function governanceBlocks(doc) {
  const result = [];
  const pattern = /^###\s+(.+?)\s+\^(ROLE|MEMBER|STAKEHOLDER)-([A-Z0-9]+)\s*$/gm;
  const matches = Array.from(doc.body.matchAll(pattern));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextHeading = doc.body.slice(match.index + match[0].length).search(/^#{2,3}\s+/m);
    const end = nextHeading < 0 ? doc.body.length : match.index + match[0].length + nextHeading;
    const source = doc.body.slice(match.index, end);
    const fields = new Map();
    for (const field of source.matchAll(/^-\s+([^:]+):\s*(.*)$/gm)) fields.set(field[1].trim(), field[2].trim());
    result.push({ type: match[2], id: `${match[2]}-${match[3]}`, name: match[1].trim(), source, fields, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1 });
  }
  return result;
}

function checkProjectGovernance(list, projectDoc) {
  if (!projectDoc) return;
  for (const heading of GOVERNANCE_HEADINGS) {
    if (!projectDoc.headings.has(headingKey(heading))) diagnostic(list, { code: 'RDL-GOV-001', category: 'governance', file: projectDoc.relativeFile, artifactId: projectDoc.id, message: `프로젝트 거버넌스 필수 섹션이 없습니다: ${heading}` });
  }
  const blocks = governanceBlocks(projectDoc);
  for (const type of Object.keys(GOVERNANCE_BLOCK_FIELDS)) {
    if (!blocks.some((block) => block.type === type)) diagnostic(list, { code: 'RDL-GOV-002', category: 'governance', file: projectDoc.relativeFile, artifactId: projectDoc.id, message: `${type} 정의가 하나 이상 필요합니다.` });
  }
  for (const block of blocks) {
    for (const field of GOVERNANCE_BLOCK_FIELDS[block.type]) {
      if (!block.fields.has(field) || !block.fields.get(field)) diagnostic(list, { code: 'RDL-GOV-003', category: 'governance', file: projectDoc.relativeFile, line: block.line, artifactId: projectDoc.id, target: block.id, message: `${block.id}에 필수 필드가 없습니다: ${field}` });
    }
  }
}

function checkReference(list, fileRegistry, artifactRegistry, sourceDoc, rawValue, values) {
  const target = wikiTarget(rawValue);
  if (!target) {
    diagnostic(list, Object.assign({
      code: 'RDL-LINK-001', category: 'link', file: sourceDoc.relativeFile,
      line: lineOf(sourceDoc.source, String(rawValue)), artifactId: values.artifactId,
      message: `Wiki link 형식이 아닙니다: ${rawValue}`
    }, values));
    return;
  }
  const targetDoc = fileRegistry.get(target.id) || null;
  if (!targetDoc) {
    const aliasDoc = resolveArtifact(artifactRegistry, target.id);
    diagnostic(list, Object.assign({
      code: aliasDoc ? 'RDL-LINK-006' : 'RDL-LINK-002', category: 'link', file: sourceDoc.relativeFile,
      line: lineOf(sourceDoc.source, rawValue), artifactId: values.artifactId, target: target.id,
      message: aliasDoc
        ? `Obsidian link 대상은 alias가 아니라 실제 파일명이어야 합니다: [[${aliasDoc.fileStem}|${target.id}]]`
        : `존재하지 않는 Obsidian 파일을 참조합니다: ${target.id}`
    }, values));
    return;
  }
  if (target.anchor) {
    const exists = target.anchor.startsWith('^')
      ? targetDoc.blocks.has(target.anchor.slice(1))
      : targetDoc.headings.has(headingKey(target.anchor));
    if (!exists) {
      diagnostic(list, Object.assign({
        code: 'RDL-LINK-003', category: 'link', file: sourceDoc.relativeFile,
        line: lineOf(sourceDoc.source, rawValue), artifactId: values.artifactId, target: `${target.id}#${target.anchor}`,
        message: `존재하지 않는 섹션 또는 block을 참조합니다: ${target.id}#${target.anchor}`
      }, values));
    }
  }
}

function isDocumentUid(value) {
  return DOCUMENT_UID.test(String(value || ''));
}

/**
 * 문서 하나의 메타데이터 판정. 이미 읽어 둔 문서 값과 파일 이름만 보고 답한다.
 *
 * 파일을 여는 일은 호출자가 이미 끝냈다. 여기서 다시 열면 같은 문서를 두 번 읽게
 * 되고, 그보다 나쁘게는 이 판정이 파일 시스템에 묶여 보드나 워커 어댑터가 같은
 * 판정을 부를 수 없게 된다.
 *
 * 경계 계약과 구현 계약 판정은 각자 순수 모듈이 갖고 있으므로 그대로 위임한다.
 */
function checkDocumentMetadata(list, doc, fileName, delegates) {
  if (!doc.frontmatter) {
    diagnostic(list, { code: 'RDL-DOC-001', file: doc.relativeFile, message: 'YAML frontmatter가 없습니다.' });
    return null;
  }
  const meta = doc.frontmatter.data;
  const artifactId = typeof meta.id === 'string' ? meta.id : null;
  const locations = doc.frontmatter.locations;

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(meta, field) || meta[field] === '' || meta[field] === null) {
      diagnostic(list, { code: 'RDL-DOC-002', file: doc.relativeFile, line: locations[field] || 2, artifactId, message: `필수 메타 필드가 없습니다: ${field}` });
    }
  }
  if (!artifactId || !ID_PATTERN.test(artifactId)) diagnostic(list, { code: 'RDL-DOC-003', file: doc.relativeFile, line: locations.id || 2, artifactId, message: `문서 ID는 3자리 코드와 3자리 이상 숫자여야 합니다: ${artifactId || '(없음)'}` });
  if (!FILE_PATTERN.test(fileName)) diagnostic(list, { code: 'RDL-DOC-004', file: doc.relativeFile, artifactId, message: '파일명은 <3자리 코드>-<번호>-<한글 제목>.md 형식이어야 합니다.' });
  if (artifactId && !fileName.startsWith(`${artifactId}-`)) diagnostic(list, { code: 'RDL-DOC-005', file: doc.relativeFile, artifactId, message: `파일명의 ID가 frontmatter ID와 다릅니다: ${fileName}` });
  if (typeof meta.title === 'string' && /[A-Za-z]/u.test(meta.title)) diagnostic(list, { code: 'RDL-DOC-006', file: doc.relativeFile, line: locations.title, artifactId, message: '문서 title은 한글 중심으로 작성하고 영문 약어는 description 또는 본문에서 설명하세요.' });

  const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
  if (aliases[0] !== artifactId) diagnostic(list, { code: 'RDL-DOC-007', file: doc.relativeFile, line: locations.aliases, artifactId, message: 'aliases의 첫 값은 문서 ID와 같아야 합니다.' });

  // 조인 키는 번호가 아니라 uid다. 형식이 어긋난 값은 조용히 무시하면 그 문서가
  // 조인에서 사라지므로 진단한다. 부여 자체가 없는 것은 아직 이관하지 않은 문서일
  // 수 있어 경고로 둔다.
  if (meta.uid === undefined) diagnostic(list, { code: 'RDL-DOC-014', severity: 'warning', file: doc.relativeFile, artifactId, message: '문서 고유 식별자(uid)가 없습니다. rdl doc identity --apply로 부여하세요.' });
  else if (!isDocumentUid(meta.uid)) diagnostic(list, { code: 'RDL-DOC-015', file: doc.relativeFile, line: locations.uid, artifactId, message: `문서 고유 식별자 형식이 잘못되었습니다: ${meta.uid}` });

  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const namespaces = NON_CANONICAL_CODES.has(typeof artifactId === 'string' ? artifactId.slice(0, 3) : '') ? NOTE_TAG_NAMESPACES : REQUIRED_TAG_NAMESPACES;
  for (const namespace of namespaces) {
    if (!tags.some((tag) => typeof tag === 'string' && tag.startsWith(namespace))) {
      diagnostic(list, { code: 'RDL-DOC-008', file: doc.relativeFile, line: locations.tags, artifactId, message: `필수 태그 namespace가 없습니다: ${namespace}` });
    }
  }

  for (const issue of delegates.boundary(meta)) {
    diagnostic(list, { code: issue.code, category: 'granularity', file: doc.relativeFile, line: locations[issue.field] || 2, artifactId, message: issue.message });
  }
  for (const issue of delegates.implementation(doc)) {
    diagnostic(list, {
      code: issue.code, category: 'implementation', severity: issue.severity, file: doc.relativeFile,
      line: issue.line || locations.implementationContract || 2, artifactId, target: issue.target || null, message: issue.message
    });
  }
  return artifactId;
}

function referenceFromTask(list, registry, taskFile, taskId, value) {
  const parts = String(value).split('#');
  const targetDoc = resolveArtifact(registry, parts[0]);
  if (!targetDoc) {
    diagnostic(list, { code: 'RDL-TASK-008', category: 'task', file: taskFile, line: 1, artifactId: taskId, target: parts[0], message: `태스크가 존재하지 않는 Artifact를 참조합니다: ${value}` });
  } else if (parts[1] && !targetDoc.headings.has(headingKey(parts.slice(1).join('#')))) {
    diagnostic(list, { code: 'RDL-TASK-009', category: 'task', file: taskFile, line: 1, artifactId: taskId, target: value, message: `태스크가 존재하지 않는 문서 섹션을 참조합니다: ${value}` });
  }
}

module.exports = {
  GOVERNANCE_HEADINGS, GOVERNANCE_BLOCK_FIELDS, REQUIRED_FIELDS, ID_PATTERN, FILE_PATTERN,
  NON_CANONICAL_CODES, REQUIRED_TAG_NAMESPACES, NOTE_TAG_NAMESPACES,
  headingKey, wikiTarget, lineOf, diagnostic, resolveArtifact, uniqueDocuments, isDocumentUid,
  governanceBlocks, checkProjectGovernance, checkDocumentMetadata, checkReference, referenceFromTask
};
