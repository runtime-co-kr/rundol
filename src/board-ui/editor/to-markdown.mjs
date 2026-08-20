// ProseMirror 문서를 Markdown 본문으로 되돌린다.
//
// 이 파일이 이 설계의 전부다. 최상위 블록마다 두 경로 중 하나를 탄다.
//
//   손대지 않은 블록 → 불러올 때 떠 둔 원문 조각을 그대로
//   고친 블록        → mdast를 거쳐 remark로 직렬화
//
// 전체를 다시 쓰는 편집기는 한 글자만 고쳐도 불릿 기호와 표 정렬을 자기 기본값으로
// 바꾼다. 실측에서 ADR-005가 41줄, MOD-002가 61줄이었고 그중 실제 편집은 0줄이었다.
// 그 diff는 검토를 죽인다. 이 저장소에서 diff는 검토 수단이므로 그것을 지킨다.
//
// 블록 사이 간격도 원문에서 떠 온다. 인접한 두 블록을 그대로 두고 사이만 `\n\n`으로
// 다시 쓰면, 원래 빈 줄이 둘이던 자리가 하나가 되어 손대지 않은 문서에 diff가 남는다.

import { toMarkdown as mdastToMarkdown } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';

const BLOCK_GAP = '\n\n';

// wikilink는 mdast 표준 노드가 아니므로 직렬화 규칙을 직접 준다.
// 이것이 없으면 평문으로 떨어지고, 평문의 `[[`는 다시 `\[\[`로 이스케이프된다.
const wikiLinkHandler = (node) => {
  const inner = node.alias && node.alias !== node.value ? `${node.value}|${node.alias}` : node.value;
  return `${node.embed ? '!' : ''}[[${inner}]]`;
};

const serializeOptions = {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  listItemIndent: 'one',
  // 셀 폭 맞춤을 끈다. 기본값은 셀을 글자 수로 재어 채우는데, 한글은 글자 수와 보이는
  // 폭이 달라 "정렬"한 결과가 오히려 어긋난다. 게다가 표 하나를 고치면 그 표 전체가
  // 다시 써져 실제 편집분이 묻힌다. 정본 문서의 표는 원래 채우지 않는 형태다.
  extensions: [gfmToMarkdown({ tablePipeAlign: false, tableCellPadding: true })],
  handlers: { wikiLink: wikiLinkHandler },
  // 우리 노드는 인라인 자리에 온다. 알려 주지 않으면 문단 안에서 줄이 끊긴다.
  unsafe: []
};

// 구분줄을 정본 문서가 쓰는 모양으로 되돌린다. remark는 폭 맞춤을 끄면 `| - | - |`로
// 쓰는데 저장소의 표는 전부 `|---|---|`다. 둘 다 올바른 GFM이지만, 표 하나를 고쳤을
// 때 그 표만 다른 모양이 되면 사람이 무엇을 고쳤는지 대신 무엇이 달라 보이는지를 본다.
function normalizeDelimiterRow(markdown) {
  return markdown.replace(/^\|(?:\s*:?-+:?\s*\|)+$/gmu, (line) => {
    const cells = line.slice(1, -1).split('|').map((cell) => {
      const value = cell.trim();
      if (value.startsWith(':') && value.endsWith(':')) return ':---:';
      if (value.startsWith(':')) return ':---';
      if (value.endsWith(':')) return '---:';
      return '---';
    });
    return `|${cells.join('|')}|`;
  });
}

// code mark는 감싸는 것이 아니라 잎 자체를 바꾼다. mdast의 inlineCode는 자식을
// 가질 수 없으므로 묶음 계산에서 빼고 잎에서 처리한다.
function leafToMdast(node) {
  if (node.isText) {
    return node.marks.some((mark) => mark.type.name === 'code')
      ? { type: 'inlineCode', value: node.text }
      : { type: 'text', value: node.text };
  }
  switch (node.type.name) {
    case 'wiki_link': return { type: 'wikiLink', value: node.attrs.target, alias: node.attrs.alias, embed: node.attrs.embed };
    case 'image': return { type: 'image', url: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title };
    case 'hard_break': return { type: 'break' };
    default: return { type: 'text', value: node.textContent };
  }
}

function wrappingMarks(node) {
  return node.marks.filter((mark) => mark.type.name !== 'code');
}

function wrap(mark, children) {
  switch (mark.type.name) {
    case 'strong': return { type: 'strong', children };
    case 'em': return { type: 'emphasis', children };
    case 'strike': return { type: 'delete', children };
    case 'link': return { type: 'link', url: mark.attrs.href, title: mark.attrs.title, children };
    default: return { type: 'emphasis', children };
  }
}

// 같은 mark를 공유하는 이웃을 하나로 묶는다.
//
// 텍스트 조각마다 따로 감싸면 `**앞 `코드` 뒤**`가 `**앞 **`코드`** 뒤**`가 되고,
// remark는 그 사이를 띄어쓰기 실체 참조로 메운다. ProseMirror는 인라인을 조각으로
// 들고 있으므로, 조각이 아니라 범위로 되돌리는 일은 이쪽이 해야 한다.
function group(nodes, depth) {
  const out = [];
  let index = 0;
  while (index < nodes.length) {
    const marks = wrappingMarks(nodes[index]);
    if (marks.length <= depth) { out.push(leafToMdast(nodes[index])); index += 1; continue; }
    const mark = marks[depth];
    let end = index + 1;
    while (end < nodes.length) {
      const next = wrappingMarks(nodes[end]);
      if (next.length <= depth || !next[depth].eq(mark)) break;
      end += 1;
    }
    out.push(wrap(mark, group(nodes.slice(index, end), depth + 1)));
    index = end;
  }
  return out;
}

function inlineChildren(node) {
  const nodes = [];
  node.forEach((child) => nodes.push(child));
  return group(nodes, 0);
}

function blockToMdast(node) {
  switch (node.type.name) {
    case 'paragraph': return { type: 'paragraph', children: inlineChildren(node) };
    case 'heading': return { type: 'heading', depth: node.attrs.level, children: inlineChildren(node) };
    case 'blockquote': return { type: 'blockquote', children: blockChildren(node) };
    case 'code_block': return { type: 'code', lang: node.attrs.lang || null, value: node.textContent };
    case 'horizontal_rule': return { type: 'thematicBreak' };
    case 'bullet_list': return { type: 'list', ordered: false, spread: false, children: listChildren(node) };
    case 'ordered_list': return { type: 'list', ordered: true, start: node.attrs.start, spread: false, children: listChildren(node) };
    case 'table': return tableToMdast(node);
    default: return { type: 'paragraph', children: inlineChildren(node) };
  }
}

function blockChildren(node) {
  const out = [];
  node.forEach((child) => out.push(blockToMdast(child)));
  return out;
}

function listChildren(node) {
  const out = [];
  node.forEach((item) => out.push({
    type: 'listItem',
    checked: item.attrs.checked,
    spread: false,
    children: blockChildren(item)
  }));
  return out;
}

function tableToMdast(node) {
  const align = [];
  const rows = [];
  node.forEach((row, _offset, rowIndex) => {
    const cells = [];
    row.forEach((cell, _cellOffset, column) => {
      if (rowIndex === 0) align[column] = cell.attrs.alignment || null;
      cells.push({ type: 'tableCell', children: inlineChildren(cell) });
    });
    rows.push({ type: 'tableRow', children: cells });
  });
  return { type: 'table', align, children: rows };
}

/** 블록 하나를 markdown으로. 실제로 편집된 블록만 이 경로를 탄다. */
export function serializeBlock(node) {
  const tree = { type: 'root', children: [blockToMdast(node)] };
  return normalizeDelimiterRow(mdastToMarkdown(tree, serializeOptions)).replace(/\n+$/u, '');
}

/**
 * @param {import('prosemirror-model').Node} doc 편집 후의 PM 문서
 * @param {Map} sources fromMarkdown이 만든 노드→원문 조각 Map
 * @returns {{markdown: string, preserved: number, reserialized: number}}
 */
export function toMarkdown(doc, sources) {
  // Map은 삽입 순서를 지키므로 이 배열이 곧 원래 블록 순서다.
  const originals = [...sources.keys()];
  const pieces = [];
  let preserved = 0;
  let reserialized = 0;

  // 객체가 같으면 손대지 않은 블록이다. 그런데 되돌리기는 역단계를 적용해 문서를
  // 되돌리므로 내용이 같아도 노드는 새로 만들어진다. 객체만 보면 "고쳤다 되돌린"
  // 블록이 영영 고친 블록으로 남아, 되돌렸는데도 diff가 생긴다.
  // 그래서 내용이 같은 원본이 있으면 그것의 조각을 쓴다. 같은 자리를 먼저 보는
  // 이유는 내용이 같은 블록이 문서에 여럿일 때 남의 자리 조각을 가져오지 않기 위해서다.
  function originalFor(node, index) {
    const direct = sources.get(node);
    if (direct !== undefined) return direct;
    const atIndex = originals[index];
    if (atIndex && atIndex.eq(node)) return sources.get(atIndex);
    for (const candidate of originals) if (candidate.eq(node)) return sources.get(candidate);
    return undefined;
  }

  doc.forEach((node, _offset, index) => {
    const original = originalFor(node, index);
    if (original === undefined) {
      pieces.push(serializeBlock(node));
      reserialized += 1;
      return;
    }
    pieces.push(original);
    preserved += 1;
  });

  return { markdown: pieces.join(BLOCK_GAP), preserved, reserialized };
}
