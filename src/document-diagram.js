'use strict';

const DIAGRAM_VERSION = 'diagram-v1';
const SCREEN_ID_PATTERN = /^SCR-\d{3,}$/u;

const DIAGRAM_CONVENTIONS = Object.freeze({
  MOD: Object.freeze({
    section: '관계',
    kinds: Object.freeze(['erDiagram']),
    authority: 'table',
    codes: Object.freeze({ missing: 'RDL-MODEL-001', duplicate: 'RDL-MODEL-002' }),
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
  }),
  SCR: Object.freeze({
    section: '전이',
    kinds: Object.freeze(['flowchart']),
    authority: 'table',
    codes: Object.freeze({ missing: 'RDL-SCREEN-001', node: 'RDL-SCREEN-002', selfEdge: 'RDL-SCREEN-003', foreignEdge: 'RDL-SCREEN-004' }),
    note: '다이어그램은 전이 표에서 파생한 보조 뷰이며 트리거·조건·대상의 정본은 표입니다.',
    nodeRule: '노드는 이동 대상 SCR 식별자만 사용하고 화면 안의 표시 변화는 상태 표에 남깁니다.',
    scopeRule: '다른 SCR로 나가는 간선만 그리고 같은 화면에 머무는 변화는 상태 표가 정본입니다.',
    selection: Object.freeze([
      Object.freeze({
        element: '노드',
        question: '사용자가 다른 화면으로 이동하는가?',
        include: '이동 대상 SCR 식별자만 노드로 둡니다.',
        exclude: '같은 화면의 loading·empty·error 같은 표시 변화는 상태 표가 정본입니다.'
      }),
      Object.freeze({
        element: '간선',
        question: '이 화면이 그 이동을 시작하는가?',
        include: '이 화면에서 나가는 이동만 그립니다.',
        exclude: '들어오는 이동은 출발 화면이 소유하므로 그리지 않고 진입 조건만 적습니다.'
      }),
      Object.freeze({
        element: '조건',
        question: '이동 여부를 가르는 판정인가?',
        include: '이동을 가르는 조건만 간선 라벨에 적습니다.',
        exclude: '오류 문구, 검증 규칙과 권한 차이는 바인딩 표와 디자인에 없는 것이 정본입니다.'
      })
    ]),
    excluded: Object.freeze([
      '한 경로를 끝까지 밟은 기대 결과는 전이가 아니므로 TST 시나리오를 정본으로 남깁니다.'
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

function nodeId(token) {
  return String(token || '').trim().replace(/[[({>"].*$/u, '').trim();
}

function flowchartEdges(block) {
  const edges = [];
  for (const raw of String(block || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%') || /^(?:flowchart|graph|subgraph|end)\b/u.test(line)) continue;
    const match = /^(.+?)\s*[-=.]{2,}>\s*(?:\|([^|]*)\|\s*)?(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const from = nodeId(match[1]);
    const to = nodeId(match[3]);
    if (from && to) edges.push({ from, label: String(match[2] || '').trim(), to });
  }
  return edges;
}

function erDiagramEntities(block) {
  const entities = new Map();
  let current = null;
  for (const raw of String(block || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    if (current) {
      if (line === '}') { current = null; continue; }
      entities.get(current).push(line);
      continue;
    }
    const open = /^([A-Za-z_][\w-]*)\s*\{$/u.exec(line);
    if (open) {
      current = open[1];
      if (!entities.has(current)) entities.set(current, []);
    }
  }
  return entities;
}

function erDiagramRelationships(block) {
  const relationships = [];
  for (const raw of String(block || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    const match = /^([A-Za-z_][\w-]*)\s+([|}{o]+(?:--|\.\.)[|}{o]+)\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (match) relationships.push({ from: match[1], cardinality: match[2], to: match[3], label: match[4].trim().replace(/^"|"$/gu, '') });
  }
  return relationships;
}

const DIAGRAM_RULES = {
  MOD: (block, convention) => annotatedAttributes(block).map((line) => ({
    code: convention.codes.duplicate,
    target: line,
    message: `${convention.kinds[0]} 속성 주석이 표와 중복됩니다: ${line} — ${convention.attributeRule}`
  })),
  SCR: (block, convention, artifactId) => {
    const issues = [];
    for (const edge of flowchartEdges(block)) {
      const unknown = Array.from(new Set([edge.from, edge.to].filter((node) => !SCREEN_ID_PATTERN.test(node))));
      for (const node of unknown) issues.push({
        code: convention.codes.node,
        target: node,
        message: `전이 노드가 SCR 식별자가 아닙니다: ${node} — ${convention.nodeRule}`
      });
      if (unknown.length) continue;
      if (edge.from === edge.to) {
        issues.push({
          code: convention.codes.selfEdge,
          target: edge.from,
          message: `같은 화면으로 돌아오는 간선은 전이가 아닙니다: ${edge.from} — ${convention.scopeRule}`
        });
        continue;
      }
      // 출발이 이 문서가 아니면 그 간선은 출발 화면이 선언해야 한다. 이 검사가 없으면
      // 화면마다 자기 출구를 선언한다는 전제가 깨져 합성 그래프에서 빠진 것을 찾을 수 없다.
      if (artifactId && edge.from !== artifactId) issues.push({
        code: convention.codes.foreignEdge,
        target: edge.from,
        message: `다른 화면에서 출발하는 간선입니다: ${edge.from} -> ${edge.to} — ${convention.scopeRule}`
      });
    }
    return issues;
  }
};

function diagramGuidance(type) {
  const convention = DIAGRAM_CONVENTIONS[String(type || '').toUpperCase()];
  return convention ? Object.assign({ type: String(type).toUpperCase() }, JSON.parse(JSON.stringify(convention))) : null;
}

function validateDocumentDiagram(type, source, artifactId) {
  const upper = String(type || '').toUpperCase();
  const convention = DIAGRAM_CONVENTIONS[upper];
  if (!convention) return [];
  const section = sectionBody(source, convention.section);
  if (section === null) return [];
  const kinds = convention.kinds.slice();
  const blocks = diagramBlocks(section, kinds);
  if (!blocks.length) {
    return [{
      code: convention.codes.missing,
      target: convention.section,
      message: `${upper} 문서의 '${convention.section}' 섹션에 ${kinds.join(' 또는 ')} 다이어그램이 없습니다. ${convention.note}`
    }];
  }
  const rule = DIAGRAM_RULES[upper];
  if (!rule) return [];
  const issues = [];
  for (const block of blocks) issues.push(...rule(block, convention, artifactId));
  return issues;
}

module.exports = {
  DIAGRAM_VERSION, DIAGRAM_CONVENTIONS, SCREEN_ID_PATTERN,
  sectionBody, mermaidBlocks, diagramBlocks, annotatedAttributes, flowchartEdges, erDiagramEntities, erDiagramRelationships,
  diagramGuidance, validateDocumentDiagram
};
