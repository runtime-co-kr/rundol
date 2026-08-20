// 넣을 수 있는 블록의 목록. `+` 메뉴와 슬래시 메뉴가 같은 것을 본다.
//
// Crepe는 이 목록을 textGroup·listGroup·advancedGroup 셋으로 나눈다. 같은 갈래를
// 쓰되 항목은 정본 문서가 실제로 쓰는 것만 둔다 — 편집기가 문서에 없던 형태를
// 만들기 시작하면 그것이 곧 문서 표준이 되기 때문이다.
//
// keywords는 슬래시 메뉴가 거르는 데 쓴다. 한글로 치는 사람과 영문으로 치는 사람이
// 같은 것을 찾아야 하므로 둘 다 담는다.

import { schema } from './schema.mjs';

function emptyTable(columns, rows) {
  const header = schema.nodes.table_row.create(null,
    Array.from({ length: columns }, () => schema.nodes.table_header.create(null, [])));
  const body = Array.from({ length: rows }, () => schema.nodes.table_row.create(null,
    Array.from({ length: columns }, () => schema.nodes.table_cell.create(null, []))));
  return schema.nodes.table.create(null, [header, ...body]);
}

function listOf(type, attrs, itemAttrs) {
  return schema.nodes[type].create(attrs, [
    schema.nodes.list_item.create(itemAttrs || null, [schema.nodes.paragraph.create()])
  ]);
}

export const BLOCK_GROUPS = [
  {
    name: '텍스트',
    items: [
      { label: '문단', hint: '본문', keywords: ['문단', 'text', 'p', '본문'], make: () => schema.nodes.paragraph.create() },
      { label: '제목 2', hint: '## 절', keywords: ['제목', 'heading', 'h2', '절'], make: () => schema.nodes.heading.create({ level: 2 }) },
      { label: '제목 3', hint: '### 기능 ID', keywords: ['제목', 'heading', 'h3', '기능'], make: () => schema.nodes.heading.create({ level: 3 }) },
      { label: '제목 4', hint: '#### 계약 항목', keywords: ['제목', 'heading', 'h4', '계약'], make: () => schema.nodes.heading.create({ level: 4 }) },
      { label: '인용', hint: '> 개정 기록', keywords: ['인용', 'quote', 'blockquote'], make: () => schema.nodes.blockquote.create(null, [schema.nodes.paragraph.create()]) }
    ]
  },
  {
    name: '목록',
    items: [
      { label: '목록', hint: '- 항목', keywords: ['목록', 'list', 'bullet', 'ul'], make: () => listOf('bullet_list') },
      { label: '체크 목록', hint: '- [ ] 수용 기준', keywords: ['체크', 'todo', 'task', 'check', '수용'], make: () => listOf('bullet_list', null, { checked: false }) },
      { label: '번호 목록', hint: '1. 동작 규칙', keywords: ['번호', 'ordered', 'ol', '순서'], make: () => listOf('ordered_list', { start: 1 }) }
    ]
  },
  {
    name: '고급',
    items: [
      { label: '표', hint: '3열 표', keywords: ['표', 'table', '테이블'], make: () => emptyTable(3, 2) },
      { label: '코드', hint: '``` 블록', keywords: ['코드', 'code', 'pre'], make: () => schema.nodes.code_block.create({ lang: '' }) },
      { label: 'mermaid', hint: '다이어그램', keywords: ['mermaid', '다이어그램', 'diagram', 'erd', 'flow'], make: () => schema.nodes.code_block.create({ lang: 'mermaid' }) },
      { label: '구분선', hint: '---', keywords: ['구분', 'divider', 'hr', 'rule'], make: () => schema.nodes.horizontal_rule.create() }
    ]
  }
];

export const BLOCK_ITEMS = BLOCK_GROUPS.flatMap((group) => group.items.map((item) => ({ ...item, group: group.name })));

/** 슬래시 메뉴가 이어 친 글자로 거를 때 쓴다. 빈 질의는 전부를 돌려준다. */
export function filterBlocks(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return BLOCK_ITEMS;
  return BLOCK_ITEMS.filter((item) =>
    item.label.toLowerCase().includes(needle)
    || item.keywords.some((keyword) => keyword.toLowerCase().includes(needle)));
}

/**
 * 새 블록 안으로 커서를 옮긴다. 넣기만 하고 커서를 두면 사람이 방금 만든 것을
 * 다시 찾아 눌러야 한다.
 */
export function selectInside(tr, Selection, at) {
  try {
    const $inside = tr.doc.resolve(Math.min(at + 1, tr.doc.content.size));
    return tr.setSelection(Selection.near($inside));
  } catch (_) {
    return tr;
  }
}
