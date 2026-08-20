// 블록 손잡이 — 최상위 블록 왼쪽에 뜨는 `+`와 드래그 핸들.
//
// 노션에서 사람이 가장 먼저 만지는 것이 이 둘이다. 특별한 기술은 없고, 마우스 아래에
// 있는 최상위 블록을 찾아 그 자리에 떠 있는 단추를 놓는 일이다. Crepe도 같은 일을
// Vue 컴포넌트로 한다 — 우리는 보드가 vanilla라 DOM으로 직접 그린다.
//
// 손잡이를 편집 영역 밖에 두는 이유는 안에 두면 그것이 문서의 일부가 되기 때문이다.
// ProseMirror 문서에 없는 것을 그 안에 그리면 선택·복사·직렬화가 전부 그것을 만난다.

import { Plugin, PluginKey, NodeSelection } from 'prosemirror-state';
import { schema } from './schema.mjs';

export const blockHandleKey = new PluginKey('rundol-block-handle');

// `+` 메뉴가 넣을 수 있는 것들. 정본 문서가 실제로 쓰는 것만 둔다 —
// 쓰지 않는 블록을 메뉴에 두면 문서에 없던 형태가 문서에 들어온다.
const INSERTABLE = [
  { label: '문단', hint: '본문', make: () => schema.nodes.paragraph.create() },
  { label: '제목 2', hint: '## 절', make: () => schema.nodes.heading.create({ level: 2 }) },
  { label: '제목 3', hint: '### 기능 ID', make: () => schema.nodes.heading.create({ level: 3 }) },
  { label: '제목 4', hint: '#### 계약 항목', make: () => schema.nodes.heading.create({ level: 4 }) },
  { label: '목록', hint: '- 항목', make: () => schema.nodes.bullet_list.create(null, [schema.nodes.list_item.create(null, [schema.nodes.paragraph.create()])]) },
  { label: '체크 목록', hint: '- [ ] 수용 기준', make: () => schema.nodes.bullet_list.create(null, [schema.nodes.list_item.create({ checked: false }, [schema.nodes.paragraph.create()])]) },
  { label: '번호 목록', hint: '1. 동작 규칙', make: () => schema.nodes.ordered_list.create({ start: 1 }, [schema.nodes.list_item.create(null, [schema.nodes.paragraph.create()])]) },
  { label: '표', hint: '3열 표', make: () => makeTable(3, 2) },
  { label: '인용', hint: '> 개정 기록', make: () => schema.nodes.blockquote.create(null, [schema.nodes.paragraph.create()]) },
  { label: '코드', hint: '``` 블록', make: () => schema.nodes.code_block.create({ lang: '' }) },
  { label: 'mermaid', hint: '다이어그램', make: () => schema.nodes.code_block.create({ lang: 'mermaid' }) },
  { label: '구분선', hint: '---', make: () => schema.nodes.horizontal_rule.create() }
];

function makeTable(columns, rows) {
  const header = schema.nodes.table_row.create(null,
    Array.from({ length: columns }, () => schema.nodes.table_header.create(null, [])));
  const bodyRows = Array.from({ length: rows }, () => schema.nodes.table_row.create(null,
    Array.from({ length: columns }, () => schema.nodes.table_cell.create(null, []))));
  return schema.nodes.table.create(null, [header, ...bodyRows]);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

class BlockHandleView {
  constructor(view) {
    this.view = view;
    this.target = null; // { pos, node, dom }

    this.root = element('div', 'rdl-block-handle');
    this.root.style.display = 'none';

    this.add = element('button', 'rdl-block-add', '+');
    this.add.title = '아래에 블록 추가';
    this.add.type = 'button';

    this.grip = element('button', 'rdl-block-grip', '⠿');
    this.grip.title = '끌어서 옮기기';
    this.grip.type = 'button';
    this.grip.draggable = true;

    this.root.append(this.add, this.grip);

    this.menu = element('div', 'rdl-block-menu');
    this.menu.style.display = 'none';
    for (const entry of INSERTABLE) {
      const item = element('button', 'rdl-block-menu-item');
      item.type = 'button';
      item.append(element('span', 'rdl-block-menu-label', entry.label), element('span', 'rdl-block-menu-hint', entry.hint));
      item.addEventListener('click', () => this.insert(entry));
      this.menu.append(item);
    }

    const host = view.dom.parentNode;
    host.style.position = host.style.position || 'relative';
    host.append(this.root, this.menu);
    this.host = host;

    this.onMove = (event) => this.track(event);
    // 손잡이는 편집 영역 왼쪽 여백에 있다. 편집 영역에만 mouseleave를 걸면 손잡이를
    // 누르러 가는 순간 그 손잡이가 사라진다 — 잡을 수 없는 손잡이가 된다.
    // 그래서 여백까지 포함하는 바깥 상자에 걸고, 손잡이나 메뉴로 나가는 것은 셈에서 뺀다.
    this.onLeave = (event) => {
      const to = event.relatedTarget;
      if (to && (this.root.contains(to) || this.menu.contains(to))) return;
      this.hide();
    };
    this.onDocumentDown = (event) => {
      if (!this.menu.contains(event.target) && event.target !== this.add) this.closeMenu();
    };

    host.addEventListener('mousemove', this.onMove);
    host.addEventListener('mouseleave', this.onLeave);
    this.add.addEventListener('click', (event) => { event.preventDefault(); this.toggleMenu(); });
    this.grip.addEventListener('click', (event) => { event.preventDefault(); this.selectBlock(); });
    this.grip.addEventListener('dragstart', (event) => this.startDrag(event));
    document.addEventListener('mousedown', this.onDocumentDown, true);
  }

  // 마우스 아래의 최상위 블록을 찾는다. 중첩된 목록 항목이나 표 셀 위에 있어도
  // 손잡이가 붙는 것은 언제나 최상위 블록이다 — 저장 단위가 그것이기 때문이다.
  track(event) {
    // 메뉴가 열려 있으면 대상을 바꾸지 않는다. 마우스가 메뉴로 가는 동안 아래 블록이
    // 바뀌면, 고른 항목이 방금 보고 있던 블록이 아닌 곳에 들어간다.
    if (this.menu.style.display !== 'none') return;

    // 여백에는 문서가 없어 posAtCoords가 아무것도 못 찾는다. x를 편집 영역 안으로
    // 끌어와 같은 높이의 블록을 찾는다 — 사람이 보고 있는 것은 그 줄이기 때문이다.
    const content = this.view.dom.getBoundingClientRect();
    const left = Math.min(Math.max(event.clientX, content.left + 4), content.right - 4);
    const found = this.view.posAtCoords({ left, top: event.clientY });
    if (!found) return this.hide();
    const $pos = this.view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
    if ($pos.depth === 0 && found.inside < 0) return this.hide();
    const depth = Math.min(1, $pos.depth);
    const pos = depth === 0 ? found.inside : $pos.before(1);
    if (pos == null || pos < 0) return this.hide();

    const dom = this.view.nodeDOM(pos);
    if (!dom || !dom.getBoundingClientRect) return this.hide();

    this.target = { pos, node: this.view.state.doc.nodeAt(pos), dom };
    this.place(dom);
  }

  place(dom) {
    const host = this.view.dom.parentNode.getBoundingClientRect();
    const box = dom.getBoundingClientRect();
    this.root.style.display = 'flex';
    this.root.style.top = `${box.top - host.top + this.view.dom.parentNode.scrollTop}px`;
    this.root.style.left = `${box.left - host.left - 52}px`;
  }

  hide() {
    if (this.menu.style.display !== 'none') return; // 메뉴가 열려 있으면 붙잡아 둔다
    this.root.style.display = 'none';
    this.target = null;
  }

  toggleMenu() {
    if (this.menu.style.display !== 'none') return this.closeMenu();
    if (!this.target) return;
    const handle = this.root.getBoundingClientRect();
    const host = this.view.dom.parentNode.getBoundingClientRect();
    this.menu.style.display = 'block';
    this.menu.style.top = `${handle.bottom - host.top + 6}px`;
    this.menu.style.left = `${handle.left - host.left}px`;
  }

  closeMenu() {
    this.menu.style.display = 'none';
  }

  insert(entry) {
    if (!this.target) return this.closeMenu();
    const { pos, node } = this.target;
    const at = pos + node.nodeSize; // 고른 블록 바로 아래
    const made = entry.make();
    const tr = this.view.state.tr.insert(at, made);
    // 새로 넣은 블록 안으로 커서를 옮긴다. 넣기만 하고 커서를 두면
    // 사람이 방금 만든 것을 다시 찾아 눌러야 한다.
    try {
      const inside = tr.doc.resolve(at + 1);
      tr.setSelection(inside.parent.isTextblock ? this.view.state.selection.constructor.near(inside) : NodeSelection.create(tr.doc, at));
    } catch (_) { /* 커서를 못 옮겨도 삽입은 유효하다 */ }
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
    this.closeMenu();
  }

  selectBlock() {
    if (!this.target) return;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, this.target.pos)));
    this.view.focus();
  }

  // 손잡이는 편집 영역 밖에 있으므로 ProseMirror가 이 drag의 시작을 보지 못한다.
  // 무엇을 끌고 있는지 직접 알려 주어야 놓았을 때 그 블록이 옮겨진다.
  startDrag(event) {
    if (!this.target) return;
    const selection = NodeSelection.create(this.view.state.doc, this.target.pos);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    this.view.dragging = { slice: selection.content(), move: true };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', this.target.node.textContent.slice(0, 80));
    if (this.target.dom.nodeType === 1) event.dataTransfer.setDragImage(this.target.dom, 0, 0);
    this.closeMenu();
  }

  update() {
    if (this.target && this.root.style.display !== 'none') {
      const dom = this.view.nodeDOM(this.target.pos);
      if (dom && dom.getBoundingClientRect) this.place(dom);
      else this.hide();
    }
  }

  destroy() {
    this.host.removeEventListener('mousemove', this.onMove);
    this.host.removeEventListener('mouseleave', this.onLeave);
    document.removeEventListener('mousedown', this.onDocumentDown, true);
    this.root.remove();
    this.menu.remove();
  }
}

export function blockHandle() {
  return new Plugin({ key: blockHandleKey, view: (view) => new BlockHandleView(view) });
}
