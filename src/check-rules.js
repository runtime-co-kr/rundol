'use strict';

// 검사의 판정부. 파일을 읽지 않고 이미 읽어 둔 값만 보고 진단을 만든다.
//
// 이 분리가 필요한 이유는 코드 정리가 아니라 답의 일치다. 같은 저장소 상태에서
// 명령줄과 보드와 워커 어댑터가 다른 판정을 내면 사람과 에이전트는 같은 계층이
// 아니게 된다. 판정이 파일 읽기와 붙어 있는 한 각 표면은 자기 경로로 다시
// 구현하게 되고, 다시 구현한 것들은 조금씩 달라진다.
//
// 그래서 여기에는 require가 없다. 값을 만드는 일은 check.js가 하고, 그 값을 보고
// 옳고 그름을 말하는 일만 여기서 한다. worker-contract-purity.test.js가 전이
// 의존까지 따라가며 이 경계를 지킨다.

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
  list.push(Object.assign({ severity: 'error', category: 'metadata', file: null, line: 1, artifactId: null, target: null }, values));
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
  GOVERNANCE_HEADINGS, GOVERNANCE_BLOCK_FIELDS,
  headingKey, wikiTarget, lineOf, diagnostic, resolveArtifact, uniqueDocuments,
  governanceBlocks, checkProjectGovernance, checkReference, referenceFromTask
};
