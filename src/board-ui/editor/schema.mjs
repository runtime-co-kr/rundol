// 문서 편집기의 ProseMirror 스키마.
//
// 이 스키마가 정하는 것은 "편집기가 무엇을 문서로 인정하는가"다. 스키마에 없는 것은
// 불러올 때 조용히 사라지므로, 정본 문서가 실제로 쓰는 것은 빠짐없이 있어야 한다.
// 무엇을 쓰는지는 짐작하지 않고 저장소에서 셌다 — 표 1427줄, mermaid 13블록,
// 본문 wikilink 80건, 자산 embed 6건.
//
// wiki_link가 1급 노드인 이유가 이 설계의 핵심이다. 평문으로 두면 직렬화기가 `[[`를
// 링크로 오해될 수 있는 글자로 보고 `\[\[`로 이스케이프한다. 실측에서 본문 링크가
// 그렇게 죽었고 rdl check는 통과했다. 노드로 세우면 직렬화기가 자기 규칙으로 되쓴다.

import { Schema } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

const listNodes = {
  bullet_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { marker: { default: '-' } },
    toDOM: () => ['ul', 0],
    parseDOM: [{ tag: 'ul' }]
  },
  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { start: { default: 1 } },
    toDOM: (node) => ['ol', node.attrs.start === 1 ? {} : { start: node.attrs.start }, 0],
    parseDOM: [{ tag: 'ol' }]
  },
  list_item: {
    // 문단만이 아니라 블록을 담는다. 중첩 목록과 목록 안의 표가 실제 문서에 있다.
    content: 'block+',
    defining: true,
    attrs: { checked: { default: null } },
    toDOM: (node) => ['li', node.attrs.checked === null ? {} : { 'data-checked': String(node.attrs.checked) }, 0],
    parseDOM: [{ tag: 'li' }]
  }
};

const nodes = {
  doc: { content: 'block+' },

  paragraph: {
    group: 'block',
    content: 'inline*',
    toDOM: () => ['p', 0],
    parseDOM: [{ tag: 'p' }]
  },

  heading: {
    group: 'block',
    content: 'inline*',
    attrs: { level: { default: 1 } },
    defining: true,
    toDOM: (node) => [`h${node.attrs.level}`, 0],
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } }))
  },

  blockquote: {
    group: 'block',
    content: 'block+',
    defining: true,
    toDOM: () => ['blockquote', 0],
    parseDOM: [{ tag: 'blockquote' }]
  },

  // 울타리 블록. mermaid도 여기 들어간다. 안쪽은 손대지 않는 평문이다.
  code_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { lang: { default: '' } },
    toDOM: (node) => ['pre', { 'data-lang': node.attrs.lang || null }, ['code', 0]],
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }]
  },

  horizontal_rule: {
    group: 'block',
    toDOM: () => ['hr'],
    parseDOM: [{ tag: 'hr' }]
  },

  ...listNodes,

  ...tableNodes({
    tableGroup: 'block',
    cellContent: 'inline*',
    cellAttributes: {
      // GFM 표의 열 정렬. 이것을 잃으면 표를 고칠 때마다 정렬이 초기화된다.
      alignment: { default: null, getFromDOM: (dom) => dom.style.textAlign || null, setDOMAttr: (value, attrs) => { if (value) attrs.style = `text-align: ${value}`; } }
    }
  }),

  text: { group: 'inline' },

  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    toDOM: () => ['br'],
    parseDOM: [{ tag: 'br' }]
  },

  image: {
    group: 'inline',
    inline: true,
    draggable: true,
    attrs: { src: {}, alt: { default: '' }, title: { default: null } },
    toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
    parseDOM: [{ tag: 'img[src]', getAttrs: (dom) => ({ src: dom.getAttribute('src'), alt: dom.getAttribute('alt') || '', title: dom.getAttribute('title') }) }]
  },

  // Obsidian wikilink. atom으로 두어 편집 중에 가운데가 지워지지 않게 한다.
  // embed는 `![[...]]` 형태이고 자산을 가리킨다.
  wiki_link: {
    group: 'inline',
    inline: true,
    atom: true,
    draggable: true,
    attrs: { target: {}, alias: { default: null }, embed: { default: false } },
    toDOM: (node) => ['span', {
      class: node.attrs.embed ? 'wiki-embed' : 'wiki-link',
      'data-target': node.attrs.target
    }, node.attrs.alias || node.attrs.target],
    parseDOM: [{
      tag: 'span[data-target]',
      getAttrs: (dom) => ({
        target: dom.getAttribute('data-target'),
        alias: dom.textContent === dom.getAttribute('data-target') ? null : dom.textContent,
        embed: dom.classList.contains('wiki-embed')
      })
    }]
  }
};

const marks = {
  strong: { toDOM: () => ['strong', 0], parseDOM: [{ tag: 'strong' }, { tag: 'b' }] },
  em: { toDOM: () => ['em', 0], parseDOM: [{ tag: 'em' }, { tag: 'i' }] },
  strike: { toDOM: () => ['del', 0], parseDOM: [{ tag: 'del' }, { tag: 's' }] },
  code: { code: true, excludes: '_', toDOM: () => ['code', 0], parseDOM: [{ tag: 'code' }] },
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title }, 0],
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: dom.getAttribute('href'), title: dom.getAttribute('title') }) }]
  }
};

export const schema = new Schema({ nodes, marks });
