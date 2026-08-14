'use strict';

const DIAGRAM_VERSION = 'diagram-v1';

const DIAGRAM_CONVENTIONS = Object.freeze({
  MOD: Object.freeze({
    section: '관계',
    kinds: Object.freeze(['erDiagram']),
    authority: 'table',
    note: '다이어그램은 표에서 파생한 보조 뷰이며 카디널리티·필드 제약·수명주기의 정본은 표입니다.',
    attributeRule: '속성에는 타입과 PK·FK 키만 적고 제약·기본값·수명주기 주석은 표에만 둡니다.',
    scopeRule: '문서가 소유하지 않은 엔티티는 속성 없이 관계선에만 표시하고 소유 문서를 본문에서 링크합니다.',
    selection: Object.freeze([
      Object.freeze({
        element: '엔티티',
        question: '이 문서가 수명주기를 소유하는가?',
        include: '소유하면 속성을 포함하고, 인접하면 속성 없이 노드만 둡니다.',
        exclude: '속성을 가진 엔티티가 여럿 필요하면 독립 수명이 없는 aggregate인지 확인하고, 아니면 문서를 나눕니다.'
      }),
      Object.freeze({
        element: '관계',
        question: '저장된 필드가 이 참조를 만드는가?',
        include: 'FK나 식별자로 저장된 참조만 그립니다.',
        exclude: '재생·계산으로만 성립하는 관계는 그리지 않고 해당 계산 섹션을 정본으로 남깁니다.'
      }),
      Object.freeze({
        element: '카디널리티',
        question: '저장 시점 제약인가 조회 시점 제약인가?',
        include: '저장 시점 제약만 관계선에 표기합니다.',
        exclude: '현재 유효한 것만 세는 조회 시점 제약은 불변식이나 계산 섹션이 정본입니다.'
      })
    ]),
    excluded: Object.freeze([
      '상태 전이는 관계형 표기에 자리가 없으므로 기능별 상태와 전이 계약을 정본으로 남깁니다.'
    ])
  })
});

function normalizeSource(source) {
  return String(source || '').replace(/^﻿/u, '').replace(/\r\n/g, '\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function sectionBody(source, heading) {
  const lines = normalizeSource(source).split('\n');
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*#*\\s*$`, 'u');
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/u.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

function mermaidBlocks(source) {
  const blocks = [];
  for (const match of normalizeSource(source).matchAll(/^[ \t]*```mermaid[ \t]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gmu)) blocks.push(match[1]);
  return blocks;
}

function diagramBlocks(source, kinds) {
  return mermaidBlocks(source).filter((block) => kinds.some((kind) => new RegExp(`^\\s*${escapeRegExp(kind)}\\b`, 'mu').test(block)));
}

function annotatedAttributes(block) {
  const found = [];
  let depth = 0;
  for (const raw of String(block || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    if (depth > 0 && line === '}') { depth -= 1; continue; }
    if (/\{\s*$/u.test(line)) { depth += 1; continue; }
    if (depth > 0 && /"[^"]*"\s*$/u.test(line)) found.push(line);
  }
  return found;
}

function diagramGuidance(type) {
  const convention = DIAGRAM_CONVENTIONS[String(type || '').toUpperCase()];
  return convention ? Object.assign({ type: String(type).toUpperCase() }, JSON.parse(JSON.stringify(convention))) : null;
}

function validateDocumentDiagram(type, source) {
  const upper = String(type || '').toUpperCase();
  const convention = DIAGRAM_CONVENTIONS[upper];
  if (!convention) return [];
  const section = sectionBody(source, convention.section);
  if (section === null) return [];
  const kinds = convention.kinds.slice();
  const blocks = diagramBlocks(section, kinds);
  if (!blocks.length) {
    return [{
      code: 'RDL-MODEL-001',
      target: convention.section,
      message: `${upper} 문서의 '${convention.section}' 섹션에 ${kinds.join(' 또는 ')} 다이어그램이 없습니다. ${convention.note}`
    }];
  }
  const issues = [];
  for (const block of blocks) {
    for (const line of annotatedAttributes(block)) {
      issues.push({
        code: 'RDL-MODEL-002',
        target: line,
        message: `${kinds[0]} 속성 주석이 표와 중복됩니다: ${line} — ${convention.attributeRule}`
      });
    }
  }
  return issues;
}

module.exports = {
  DIAGRAM_VERSION, DIAGRAM_CONVENTIONS,
  sectionBody, mermaidBlocks, diagramBlocks, annotatedAttributes, diagramGuidance, validateDocumentDiagram
};
