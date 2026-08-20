// 선택 툴바 — 글자를 고르면 그 위에 뜬다.
//
// 조건은 Crepe와 같게 잡았다. 소스를 확인해 보니 비어 있지 않은 TextSelection일
// 때만 띄우고, 커서만 있을 때·NodeSelection일 때·포커스가 없을 때는 띄우지 않는다.
// 이 조건이 없으면 툴바가 문서를 읽는 내내 깜빡이며 따라다닌다.
//
// 위치도 같은 기준이다 — 커서가 아니라 선택 범위의 사각형 위. 아래에 두면 사람이
// 방금 고른 글자를 툴바가 가린다. 위쪽 공간이 모자라면 아래로 뒤집는다.

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import { schema } from './schema.mjs';

export const toolbarKey = new PluginKey('rundol-toolbar');

const ITEMS = [
  { label: 'B', title: '굵게 (Ctrl+B)', mark: 'strong', className: 'is-bold' },
  { label: 'I', title: '기울임 (Ctrl+I)', mark: 'em', className: 'is-italic' },
  { label: 'S', title: '취소선', mark: 'strike', className: 'is-strike' },
  { label: '<>', title: '코드 (Ctrl+`)', mark: 'code', className: 'is-code' }
];

function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks || $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}

class ToolbarView {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'rdl-toolbar';
    this.dom.style.display = 'none';

    this.buttons = ITEMS.map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `rdl-toolbar-button ${item.className}`;
      button.textContent = item.label;
      button.title = item.title;
      // pointerdown에 거는 이유는 click까지 가면 그 사이에 선택이 풀리기 때문이다.
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        toggleMark(schema.marks[item.mark])(view.state, view.dispatch);
        view.focus();
      });
      this.dom.append(button);
      return { item, button };
    });

    const host = view.dom.parentNode;
    if (!host.style.position) host.style.position = 'relative';
    host.append(this.dom);
    this.host = host;
  }

  shouldShow() {
    const { state, hasFocus } = this.view;
    if (!this.view.editable) return false;
    if (!hasFocus()) return false;
    const { selection } = state;
    if (!(selection instanceof TextSelection)) return false;
    if (selection.empty) return false;
    // 고른 범위에 글자가 없으면(빈 줄 여럿을 훑은 경우) 걸 서식이 없다.
    if (!state.doc.textBetween(selection.from, selection.to).length) return false;
    // 코드 블록 안에서는 서식이 의미가 없다. 마크가 걸리지도 않는다.
    if (selection.$from.parent.type.spec.code) return false;
    return true;
  }

  update() {
    if (!this.shouldShow()) {
      this.dom.style.display = 'none';
      return;
    }
    for (const { item, button } of this.buttons) {
      button.classList.toggle('is-active', markActive(this.view.state, schema.marks[item.mark]));
    }
    this.place();
  }

  place() {
    const { from, to } = this.view.state.selection;
    const start = this.view.coordsAtPos(from);
    const end = this.view.coordsAtPos(to, -1);
    const host = this.host.getBoundingClientRect();

    this.dom.style.display = 'flex';
    const box = this.dom.getBoundingClientRect();
    const centre = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
    const top = Math.min(start.top, end.top);

    // 위쪽 공간이 모자라면 선택 아래로 뒤집는다.
    const above = top - host.top - box.height - 8;
    const flipped = above < 0;
    this.dom.style.top = `${(flipped ? Math.max(start.bottom, end.bottom) - host.top + 8 : above) + this.host.scrollTop}px`;
    this.dom.style.left = `${Math.max(0, centre - host.left - box.width / 2)}px`;
  }

  destroy() { this.dom.remove(); }
}

export function toolbar() {
  return new Plugin({ key: toolbarKey, view: (view) => new ToolbarView(view) });
}
