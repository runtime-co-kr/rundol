// `@` 링크 선택기 — 문서와 사람을 이름으로 찾아 넣는다.
//
// 정본 문서의 상호참조는 `[[파일명|별칭]]`이고, 파일명은 한글이 섞인 긴 이름이다.
// 손으로 치면 틀리고, 틀린 링크는 저장한 뒤 rdl check가 알려 준다. 그때는 이미
// 문서를 떠난 뒤다. 여기서 고르게 하면 틀릴 자리가 없어진다.
//
// Crepe에는 이 기능이 없다. wikilink 자체가 Obsidian 문법이라 일반 편집기가 다룰
// 이유가 없기 때문이다. 편집기를 직접 만든 값의 상당 부분이 여기 있다.
//
// 대상 목록은 밖에서 받는다. 편집기가 저장소를 읽으면 브라우저에서 돌 수 없고,
// 보드는 이미 그 목록을 스냅샷으로 갖고 있다.

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from './schema.mjs';
import { guarded } from './guard.mjs';

export const linkPickerKey = new PluginKey('rundol-link-picker');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function score(candidate, needle) {
  const label = `${candidate.id} ${candidate.title} ${candidate.target}`.toLowerCase();
  const at = label.indexOf(needle);
  if (at < 0) return -1;
  // 앞에서 걸린 것이 먼저다. `REQ-011`을 치는 사람은 제목 가운데 걸린 문서보다
  // ID가 그것으로 시작하는 문서를 찾고 있다.
  return at === 0 ? 0 : at;
}

function filterCandidates(candidates, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return candidates.slice(0, 30);
  return candidates
    .map((candidate) => ({ candidate, rank: score(candidate, needle) }))
    .filter((entry) => entry.rank >= 0)
    .sort((left, right) => left.rank - right.rank)
    .slice(0, 30)
    .map((entry) => entry.candidate);
}

class LinkPickerView {
  constructor(view, options) {
    this.view = view;
    this.candidates = options.candidates || [];
    this.open = false;
    this.from = null;
    this.query = '';
    this.index = 0;
    this.items = [];

    this.dom = element('div', 'rdl-link-picker');
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
    if ((event.key === 'Enter' || event.key === 'Tab') && this.items.length) {
      event.preventDefault();
      return this.choose(this.items[this.index]);
    }
  }

  move(step) {
    if (!this.items.length) return;
    this.index = (this.index + step + this.items.length) % this.items.length;
    this.paint();
  }

  choose(candidate) {
    if (!candidate || this.from == null) return this.close();
    const to = this.from + 1 + this.query.length;
    const node = schema.nodes.wiki_link.create({
      target: candidate.target,
      // 별칭은 대상과 다를 때만 남긴다. 같으면 `[[a|a]]`가 되어 문서가 지저분해진다.
      alias: candidate.alias && candidate.alias !== candidate.target ? candidate.alias : null,
      embed: false
    });
    const tr = this.view.state.tr.replaceWith(this.from, Math.min(to, this.view.state.doc.content.size), node);
    this.view.dispatch(tr.scrollIntoView());
    this.close();
    this.view.focus();
  }

  paint() {
    this.dom.replaceChildren();
    if (!this.items.length) {
      this.dom.append(element('div', 'rdl-slash-empty', '맞는 문서나 사람이 없습니다'));
      return;
    }
    this.items.forEach((candidate, order) => {
      const item = element('button', `rdl-link-item${order === this.index ? ' is-active' : ''}`);
      item.type = 'button';
      item.append(
        element('span', `rdl-link-kind rdl-link-kind-${candidate.kind}`, candidate.id),
        element('span', 'rdl-link-title', candidate.title)
      );
      item.addEventListener('mousedown', (event) => { event.preventDefault(); this.choose(candidate); });
      this.dom.append(item);
    });
  }

  place() {
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
    guarded('link-picker', () => this.recompute(), () => this.close());
  }

  recompute() {
    const { state } = this.view;
    const { $from, empty } = state.selection;
    if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return this.open && this.close();

    // 커서 바로 앞의 `@`와 그 뒤 글자. 슬래시 메뉴와 달리 문단 처음일 필요는 없다 —
    // 링크는 글 가운데 들어가는 것이고, `@`는 문장에서 잘 쓰이지 않는다.
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 60), $from.parentOffset, undefined, '￼');
    const match = /@([^\s@[\]|]*)$/u.exec(before);
    if (!match) return this.open && this.close();

    this.from = $from.pos - match[0].length;
    this.query = match[1];
    this.items = filterCandidates(this.candidates, this.query);
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

/**
 * @param {{candidates?: Array<{id: string, title: string, target: string, alias?: string, kind: string}>}} options
 *   kind는 'document' 또는 'member'. 화면에서 무엇을 고르는지 구분하는 데만 쓴다.
 */
export function linkPicker(options = {}) {
  const known = new Set((options.candidates || []).map((candidate) => candidate.target));

  return new Plugin({
    key: linkPickerKey,
    view: (view) => new LinkPickerView(view, options),
    props: {
      // 대상이 없는 링크를 편집 중에 구분해 보인다. 저장한 뒤 검사가 알려 주는 것보다
      // 지금 보이는 편이 낫다 — 고칠 사람이 아직 그 문서 앞에 있기 때문이다.
      decorations(state) {
        if (!known.size) return null;
        const found = [];
        state.doc.descendants((node, pos) => {
          if (node.type !== schema.nodes.wiki_link) return;
          if (known.has(node.attrs.target)) return;
          found.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-unresolved' }));
        });
        return found.length ? DecorationSet.create(state.doc, found) : null;
      }
    }
  });
}
