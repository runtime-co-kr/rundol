// 슬래시 메뉴 — 빈 문단에서 `/`를 치면 열리고, 이어 친 글자로 걸러진다.
//
// `+` 메뉴와 같은 목록을 본다. 두 곳이 각자 목록을 들면 어느 날 한쪽에만 항목이
// 늘어나고, 사람은 왜 여기서는 되고 저기서는 안 되는지 모른 채 쓰게 된다.
//
// 빈 문단에서만 여는 이유는 `/`가 글에 실제로 쓰이는 글자이기 때문이다.
// `POST /api/...`를 칠 때마다 메뉴가 뜨면 그 메뉴는 곧 꺼진다.

import { Plugin, PluginKey, Selection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { filterBlocks, menuItems, madeNodes, selectInside } from './blocks.mjs';
import { pickImage } from './image-drop.mjs';
import { guarded } from './guard.mjs';

export const slashMenuKey = new PluginKey('rundol-slash-menu');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

class SlashMenuView {
  constructor(view, options) {
    this.view = view;
    this.sections = (options && options.contractSections) || [];
    this.open = false;
    this.from = null;   // `/`가 놓인 자리
    this.query = '';
    this.index = 0;
    this.items = [];

    this.dom = element('div', 'rdl-slash-menu');
    this.dom.style.display = 'none';
    const host = view.dom.parentNode;
    if (!host.style.position) host.style.position = 'relative';
    host.append(this.dom);
    this.host = host;

    this.onKeyDown = (event) => this.keydown(event);
    view.dom.addEventListener('keydown', this.onKeyDown, true);
  }

  keydown(event) {
    if (!this.open) return;
    if (event.key === 'Escape') { event.preventDefault(); return this.close(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); return this.move(1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); return this.move(-1); }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (!this.items.length) return;
      event.preventDefault();
      return this.choose(this.items[this.index]);
    }
  }

  move(step) {
    if (!this.items.length) return;
    this.index = (this.index + step + this.items.length) % this.items.length;
    this.paint();
  }

  choose(entry) {
    if (!entry || this.from == null) return this.close();
    if (entry.action === 'image') {
      // 슬래시와 이어 친 글자는 지운다. 그림이 들어갈 자리에 명령이 남으면 안 된다.
      const to = this.from + 1 + this.query.length;
      this.view.dispatch(this.view.state.tr.delete(this.from, Math.min(to, this.view.state.doc.content.size)));
      this.close();
      return pickImage(this.view);
    }
    const { state } = this.view;
    // `/`와 이어 친 글자를 지우고 그 자리를 고른 블록으로 바꾼다.
    const to = this.from + 1 + this.query.length;
    const tr = state.tr.delete(this.from, Math.min(to, state.doc.content.size));
    const at = this.from;
    // 빈 문단만 남았으면 그 문단을 새 블록으로 갈아 끼운다.
    const $at = tr.doc.resolve(at);
    const parent = $at.parent;
    const made = madeNodes(entry);
    if (parent.isTextblock && parent.content.size === 0) {
      const start = $at.before();
      tr.replaceWith(start, start + parent.nodeSize, made);
      this.view.dispatch(selectInside(tr, Selection, start).scrollIntoView());
    } else {
      tr.insert(at, made);
      this.view.dispatch(selectInside(tr, Selection, at).scrollIntoView());
    }
    this.close();
    this.view.focus();
  }

  paint() {
    this.dom.replaceChildren();
    if (!this.items.length) {
      this.dom.append(element('div', 'rdl-slash-empty', '맞는 블록이 없습니다'));
      return;
    }
    let group = null;
    this.items.forEach((entry, order) => {
      if (entry.group !== group) {
        group = entry.group;
        this.dom.append(element('div', 'rdl-block-menu-group', group));
      }
      const item = element('button', `rdl-block-menu-item${order === this.index ? ' is-active' : ''}`);
      item.type = 'button';
      item.append(element('span', 'rdl-block-menu-label', entry.label), element('span', 'rdl-block-menu-hint', entry.hint));
      item.addEventListener('mousedown', (event) => { event.preventDefault(); this.choose(entry); });
      this.dom.append(item);
    });
  }

  place() {
    if (this.from == null) return;
    const coords = this.view.coordsAtPos(this.from);
    const host = this.host.getBoundingClientRect();
    this.dom.style.display = 'block';
    this.dom.style.top = `${coords.bottom - host.top + this.host.scrollTop + 6}px`;
    this.dom.style.left = `${coords.left - host.left}px`;
  }

  close() {
    this.open = false;
    this.from = null;
    this.query = '';
    this.index = 0;
    this.dom.style.display = 'none';
  }

  update() {
    guarded('slash-menu', () => this.recompute(), () => this.close());
  }

  recompute() {
    const { state } = this.view;
    const { $from, empty } = state.selection;
    if (!empty || !$from.parent.isTextblock) return this.open && this.close();

    // 커서 앞의 글자에서 `/`와 그 뒤를 읽는다. 문단 처음에 있을 때만 연다.
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
    const match = /^\/([^\s/]*)$/u.exec(before);
    if (!match) return this.open && this.close();

    this.from = $from.start();
    this.query = match[1];
    this.items = filterBlocks(this.query, menuItems(this.sections, state.doc));
    if (this.index >= this.items.length) this.index = 0;
    this.open = true;
    this.paint();
    this.place();
  }

  destroy() {
    this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
    this.dom.remove();
  }
}

export function slashMenu(options = {}) {
  return new Plugin({
    key: slashMenuKey,
    view: (view) => new SlashMenuView(view, options),
    props: {
      // 메뉴를 여는 `/`가 화면에서 티나야 사람이 그것이 명령이라는 것을 안다.
      decorations(state) {
        const { $from, empty } = state.selection;
        if (!empty || !$from.parent.isTextblock) return null;
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
        if (!/^\/([^\s/]*)$/u.test(before)) return null;
        const start = $from.start();
        return DecorationSet.create(state.doc, [
          Decoration.inline(start, start + before.length, { class: 'rdl-slash-token' })
        ]);
      }
    }
  });
}
