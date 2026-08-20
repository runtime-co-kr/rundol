// Markdown 본문을 ProseMirror 문서로 옮긴다.
//
// 옮기는 일보다 중요한 것이 같이 만드는 sources Map이다. 최상위 블록마다 그것이
// 나온 원문 조각을 노드 객체를 키로 기록해 둔다. 저장할 때 그 노드가 그대로면
// 다시 직렬화하지 않고 이 조각을 그대로 쓴다 — 손대지 않은 블록의 바이트가 살아남는
// 이유가 여기다.
//
// 노드 객체를 키로 쓸 수 있는 근거는 ProseMirror 문서가 영속 자료구조라는 점이다.
// 한 블록을 고치면 새 문서가 생기지만 나머지 블록은 같은 객체로 재사용된다.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import { schema } from './schema.mjs';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // 별칭 구분자를 알려주지 않으면 target과 alias가 한 덩어리로 들어온다.
  // 그러면 왕복은 되지만 링크 대상을 알 수 없어 @ 선택기도 검증도 못 세운다.
  .use(remarkWikiLink, { aliasDivider: '|' });

// 자산 참조 `![[이름]]`을 글자에서 뽑아 노드로 만든다.
//
// remark-wiki-link는 `[[이름]]`만 안다. 앞에 느낌표가 붙으면 micromark가 그것을
// 그림 시작으로 보아 위키링크 확장이 걸리지 않고, 결과는 통째로 글자다. 글자로 두면
// 되쓸 때 `[`가 이스케이프되어 `!\[\[…`가 되고 참조가 사라진다. 실측에서 저장소의
// 자산 참조 6건이 그 자리에 있었다.
//
// 확장자를 가리지 않고 모든 `![[…]]`를 노드로 만든다. 자산인지 문서인지는 검사
// 규칙이 정하는 것이고, 여기서 그 판정을 다시 하면 두 곳이 같은 글자를 다르게
// 읽는 날이 온다. 편집기가 지켜야 하는 것은 바이트이고, 그것은 `!`를 붙여 되쓰면
// 지켜진다.
const ASSET_EMBED = /!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/gu;

function assetEmbeds(value, marks) {
  ASSET_EMBED.lastIndex = 0;
  if (!ASSET_EMBED.test(value)) return [schema.text(value, marks)];
  ASSET_EMBED.lastIndex = 0;
  const out = [];
  let at = 0;
  let match = ASSET_EMBED.exec(value);
  while (match) {
    if (match.index > at) out.push(schema.text(value.slice(at, match.index), marks));
    out.push(schema.nodes.wiki_link.create({ target: match[1], alias: match[2] || null, embed: true }));
    at = match.index + match[0].length;
    match = ASSET_EMBED.exec(value);
  }
  if (at < value.length) out.push(schema.text(value.slice(at), marks));
  return out;
}

function marksFor(type, mark) {
  return mark ? mark.concat(schema.marks[type].create()) : [schema.marks[type].create()];
}

// mdast의 인라인을 PM 인라인 배열로. marks는 상위에서 물려 내린다.
function inline(node, marks = []) {
  switch (node.type) {
    case 'text':
      return node.value ? assetEmbeds(node.value, marks) : [];
    case 'inlineCode':
      return [schema.text(node.value, marks.concat(schema.marks.code.create()))];
    case 'strong':
      return children(node, marks.concat(schema.marks.strong.create()));
    case 'emphasis':
      return children(node, marks.concat(schema.marks.em.create()));
    case 'delete':
      return children(node, marks.concat(schema.marks.strike.create()));
    case 'link':
      return children(node, marks.concat(schema.marks.link.create({ href: node.url, title: node.title || null })));
    case 'image':
      return [schema.nodes.image.create({ src: node.url, alt: node.alt || '', title: node.title || null })];
    case 'break':
      return [schema.nodes.hard_break.create()];
    case 'wikiLink':
      return [schema.nodes.wiki_link.create({
        target: node.value,
        alias: node.data && node.data.alias !== node.value ? node.data.alias : null,
        embed: false
      })];
    case 'html':
      // 원시 HTML은 편집기가 다루지 않는다. 글자로 남겨 두면 최소한 사라지지는 않는다.
      return node.value ? [schema.text(node.value, marks)] : [];
    default:
      return children(node, marks);
  }
}

function children(node, marks = []) {
  const out = [];
  for (const child of node.children || []) out.push(...inline(child, marks));
  return out;
}

function listItem(node) {
  const content = node.children.length
    ? node.children.map(block).filter(Boolean)
    : [schema.nodes.paragraph.create()];
  return schema.nodes.list_item.create({ checked: typeof node.checked === 'boolean' ? node.checked : null }, content);
}

function tableOf(node) {
  const rows = node.children.map((row, index) => {
    const cells = row.children.map((cell, column) => {
      const type = index === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
      return type.create({ alignment: (node.align && node.align[column]) || null }, children(cell));
    });
    return schema.nodes.table_row.create(null, cells);
  });
  return schema.nodes.table.create(null, rows);
}

// mdast 블록 하나를 PM 블록 하나로. 모르는 것은 null을 돌려 호출자가 판단하게 한다.
function block(node) {
  switch (node.type) {
    case 'paragraph': return schema.nodes.paragraph.create(null, children(node));
    case 'heading': return schema.nodes.heading.create({ level: node.depth }, children(node));
    case 'blockquote': return schema.nodes.blockquote.create(null, node.children.map(block).filter(Boolean));
    case 'code': return schema.nodes.code_block.create({ lang: node.lang || '' }, node.value ? [schema.text(node.value)] : []);
    case 'thematicBreak': return schema.nodes.horizontal_rule.create();
    case 'list': return node.ordered
      ? schema.nodes.ordered_list.create({ start: node.start == null ? 1 : node.start }, node.children.map(listItem))
      : schema.nodes.bullet_list.create(null, node.children.map(listItem));
    case 'table': return tableOf(node);
    case 'html': return schema.nodes.paragraph.create(null, node.value ? [schema.text(node.value)] : []);
    default: return null;
  }
}

/**
 * @param {string} source 정본 문서의 본문 (frontmatter 제외)
 * @returns {{doc: import('prosemirror-model').Node, sources: Map, unknown: string[]}}
 */
export function fromMarkdown(source) {
  const tree = processor.runSync(processor.parse(source));
  const blocks = [];
  const sources = new Map();
  const unknown = [];

  for (const node of tree.children) {
    const made = block(node);
    if (!made) { unknown.push(node.type); continue; }
    blocks.push(made);
    // 원문 조각은 위치 정보에서 그대로 떠 온다. 다시 만들지 않는다 —
    // 다시 만드는 순간 그것은 원문이 아니라 우리가 쓴 것이 된다.
    const { start, end } = node.position;
    sources.set(made, source.slice(start.offset, end.offset));
  }

  const doc = schema.nodes.doc.create(null, blocks.length ? blocks : [schema.nodes.paragraph.create()]);
  return { doc, sources, unknown };
}
