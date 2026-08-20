// 블록 손잡이 — 최상위 블록 왼쪽의 `+`와 드래그 핸들, 그리고 놓을 자리 표시선.
//
// 손잡이를 편집 영역 밖에 두는 이유는 안에 두면 그것이 문서의 일부가 되기 때문이다.
// ProseMirror 문서에 없는 것을 그 안에 그리면 선택·복사·직렬화가 전부 그것을 만난다.
//
// 놓기를 직접 처리하는 이유는 기본 동작이 블록을 합치기 때문이다. ProseMirror는
// 좌표에서 나온 위치에 조각을 넣는데, 그 위치가 문단 안이면 끌어 온 블록이 그 문단에
// 녹아든다. 사람이 기대한 것은 "그 블록 위/아래"이지 "그 문단 가운데"가 아니다.
// 그래서 놓을 자리를 언제나 최상위 블록의 경계로 맞춘다.

import { Plugin, PluginKey, NodeSelection, Selection } from 'prosemirror-state';
import { menuItems, madeNodes, selectInside } from './blocks.mjs';

export const blockHandleKey = new PluginKey('rundol-block-handle');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** 마우스 아래의 최상위 블록. 여백에 있으면 x를 편집 영역 안으로 끌어와 찾는다. */
function blockAt(view, clientX, clientY) {
  const content = view.dom.getBoundingClientRect();
  const left = Math.min(Math.max(clientX, content.left + 4), content.right - 4);
  const found = view.posAtCoords({ left, top: clientY });
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
  const pos = $pos.depth === 0 ? found.inside : $pos.before(1);
  if (pos == null || pos < 0) return null;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return null;
  const dom = view.nodeDOM(pos);
  return { pos, node, dom: dom && dom.getBoundingClientRect ? dom : null };
}

/** 놓을 자리 — 가리킨 블록의 위 절반이면 그 앞, 아래 절반이면 그 뒤. */
function dropTarget(view, clientX, clientY) {
  const block = blockAt(view, clientX, clientY);
  if (!block) return null;
  const box = block.dom ? block.dom.getBoundingClientRect() : null;
  const after = box ? clientY > box.top + box.height / 2 : true;
  return { pos: after ? block.pos + block.node.nodeSize : block.pos, box, after };
}

class BlockHandleView {
  constructor(view, shared, options) {
    this.view = view;
    this.shared = shared;
    this.sections = (options && options.contractSections) || [];
    this.target = null;

    this.root = element('div', 'rdl-block-handle');
    this.root.style.display = 'none';
    this.add = element('button', 'rdl-block-add', '+');
    this.add.type = 'button';
    this.add.title = '아래에 블록 추가';
    this.grip = element('button', 'rdl-block-grip', '⠿');
    this.grip.type = 'button';
    this.grip.title = '끌어서 옮기기';
    this.grip.draggable = true;
    this.root.append(this.add, this.grip);

    this.menu = element('div', 'rdl-block-menu');
    this.menu.style.display = 'none';

    this.line = element('div', 'rdl-drop-line');
    this.line.style.display = 'none';

    const host = view.dom.parentNode;
    if (!host.style.position) host.style.position = 'relative';
    host.append(this.root, this.menu, this.line);
    this.host = host;
    shared.line = this.line;
    shared.host = host;

    this.onMove = (event) => this.track(event);
    // 손잡이는 편집 영역 왼쪽 여백에 있다. 편집 영역에만 mouseleave를 걸면 손잡이를
    // 누르러 가는 순간 그것이 사라진다 — 잡을 수 없는 손잡이가 된다.
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
    this.grip.addEventListener('dragend', () => this.endDrag());
    document.addEventListener('mousedown', this.onDocumentDown, true);
  }

  track(event) {
    // 메뉴가 열려 있으면 대상을 바꾸지 않는다. 마우스가 메뉴로 가는 동안 아래 블록이
    // 바뀌면 고른 항목이 방금 보고 있던 블록이 아닌 곳에 들어간다.
    if (this.menu.style.display !== 'none') return;
    const block = blockAt(this.view, event.clientX, event.clientY);
    if (!block || !block.dom) return this.hide();
    this.target = block;
    this.place(block.dom);
  }

  place(dom) {
    const host = this.host.getBoundingClientRect();
    const box = dom.getBoundingClientRect();
    this.root.style.display = 'flex';
    this.root.style.top = `${box.top - host.top + this.host.scrollTop}px`;
    this.root.style.left = `${box.left - host.left - 52}px`;
  }

  hide() {
    if (this.menu.style.display !== 'none') return;
    this.root.style.display = 'none';
    this.target = null;
  }

  paintMenu() {
    this.menu.replaceChildren();
    let group = null;
    for (const entry of menuItems(this.sections, this.view.state.doc)) {
      if (entry.group !== group) {
        group = entry.group;
        this.menu.append(element('div', 'rdl-block-menu-group', group));
      }
      const item = element('button', 'rdl-block-menu-item');
      item.type = 'button';
      item.append(element('span', 'rdl-block-menu-label', entry.label), element('span', 'rdl-block-menu-hint', entry.hint));
      item.addEventListener('click', () => this.insert(entry));
      this.menu.append(item);
    }
  }

  toggleMenu() {
    if (this.menu.style.display !== 'none') return this.closeMenu();
    if (!this.target) return;
    this.paintMenu();
    const handle = this.root.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    this.menu.style.display = 'block';
    this.menu.style.top = `${handle.bottom - host.top + this.host.scrollTop + 6}px`;
    this.menu.style.left = `${handle.left - host.left}px`;
  }

  closeMenu() { this.menu.style.display = 'none'; }

  insert(entry) {
    if (!this.target) return this.closeMenu();
    const at = this.target.pos + this.target.node.nodeSize;
    const tr = this.view.state.tr.insert(at, madeNodes(entry));
    this.view.dispatch(selectInside(tr, Selection, at).scrollIntoView());
    this.view.focus();
    this.closeMenu();
  }

  selectBlock() {
    if (!this.target) return;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, this.target.pos)));
    this.view.focus();
  }

  // 손잡이는 편집 영역 밖이라 ProseMirror가 이 drag의 시작을 보지 못한다.
  // 무엇을 끄는지 직접 알려 주어야 놓았을 때 그 블록이 옮겨진다.
  startDrag(event) {
    if (!this.target) return;
    const selection = NodeSelection.create(this.view.state.doc, this.target.pos);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    this.view.dragging = { slice: selection.content(), move: true };
    this.shared.dragFrom = this.target.pos;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', this.target.node.textContent.slice(0, 80));
    if (this.target.dom) event.dataTransfer.setDragImage(this.target.dom, 0, 0);
    this.closeMenu();
  }

  endDrag() {
    this.shared.dragFrom = null;
    this.line.style.display = 'none';
  }

  update() {
    if (!this.target || this.root.style.display === 'none') return;
    const dom = this.view.nodeDOM(this.target.pos);
    if (dom && dom.getBoundingClientRect) this.place(dom);
    else this.hide();
  }

  destroy() {
    this.host.removeEventListener('mousemove', this.onMove);
    this.host.removeEventListener('mouseleave', this.onLeave);
    document.removeEventListener('mousedown', this.onDocumentDown, true);
    this.root.remove();
    this.menu.remove();
    this.line.remove();
  }
}

export function blockHandle(options = {}) {
  // 손잡이(뷰)와 놓기 처리(props)가 같은 상태를 본다. 어느 블록을 끌고 있는지는
  // 뷰가 알고, 그것을 어디에 놓을지는 props가 정한다.
  const shared = { dragFrom: null, line: null, host: null };

  function showLine(view, target) {
    if (!shared.line || !shared.host || !target || !target.box) return;
    const host = shared.host.getBoundingClientRect();
    const y = target.after ? target.box.bottom : target.box.top;
    shared.line.style.display = 'block';
    shared.line.style.top = `${y - host.top + shared.host.scrollTop}px`;
    shared.line.style.left = `${target.box.left - host.left}px`;
    shared.line.style.width = `${target.box.width}px`;
  }

  return new Plugin({
    key: blockHandleKey,
    view: (view) => new BlockHandleView(view, shared, options),
    props: {
      handleDOMEvents: {
        dragover(view, event) {
          if (shared.dragFrom == null) return false;
          showLine(view, dropTarget(view, event.clientX, event.clientY));
          return false;
        },
        dragleave() {
          if (shared.line) shared.line.style.display = 'none';
          return false;
        }
      },

      handleDrop(view, event) {
        const from = shared.dragFrom;
        shared.dragFrom = null;
        if (shared.line) shared.line.style.display = 'none';
        if (from == null) return false;

        const target = dropTarget(view, event.clientX, event.clientY);
        const node = view.state.doc.nodeAt(from);
        if (!target || !node) return false;

        // 자기 자신 위나 자기 경계에 놓으면 아무 일도 하지 않는다. 그대로 두면
        // 지웠다 같은 자리에 넣는 트랜잭션이 되어 편집하지 않은 블록이 "고친 것"이 된다.
        if (target.pos >= from && target.pos <= from + node.nodeSize) return true;

        const tr = view.state.tr.delete(from, from + node.nodeSize);
        const at = tr.mapping.map(target.pos);
        tr.insert(at, node);
        tr.setSelection(NodeSelection.create(tr.doc, at));
        view.dispatch(tr.scrollIntoView());
        return true;
      }
    }
  });
}
