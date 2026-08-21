// 블록 손잡이 — 블록 왼쪽의 `+`와 드래그 핸들, 그리고 놓을 자리 표시선.
//
// 손잡이를 편집 영역 밖에 두는 이유는 안에 두면 그것이 문서의 일부가 되기 때문이다.
// ProseMirror 문서에 없는 것을 그 안에 그리면 선택·복사·직렬화가 전부 그것을 만난다.
//
// 놓을 자리를 직접 고르는 이유는 기본 동작에 층(들여쓰기)이 없기 때문이다. 목록 항목
// 아래 경계에는 "그 항목의 자식", "그 항목의 형제", "그 목록의 형제"가 전부 같은
// 높이에 있다. y만 보면 그중 하나를 프로그램이 임의로 고르게 되고, 사람이 고른 적
// 없는 층에 블록이 놓인다 — 항목을 옮길 때마다 최상위로 튀어나오던 것이 그것이다.
//
// 층을 따로 세지는 않는다. 화면이 이미 알고 있기 때문이다: 깊이 들어간 블록일수록 그
// DOM이 오른쪽에서 시작한다. 그래서 블록마다 위·아래 모서리를 자리 후보로 두고, 그
// 블록의 가로 범위를 후보와 함께 들고 다닌다. 어느 틈인지는 y가, 그 틈의 어느 층인지는
// x가 고르고, 표시선은 고른 후보의 가로 범위를 그대로 그린다. 그래서 놓기 전에 어느
// 층으로 들어가는지가 눈에 보인다. Crepe(prosemirror-drop-indicator)의 방법이다.
//
// 다른 점은 옮길 것을 받는 자리의 모양에 맞춘다는 것이다(fit). Crepe는 조각을 그대로
// 넣어 번호 목록에서 꺼낸 항목이 불릿이 되는데, 그것은 옮긴 것이 아니라 고친 것이다.

import { Plugin, PluginKey, NodeSelection, Selection } from 'prosemirror-state';
import { Fragment } from 'prosemirror-model';
import { schema } from './schema.mjs';
import { menuItems, madeNodes, selectInside } from './blocks.mjs';
import { pickImage } from './image-drop.mjs';

export const blockHandleKey = new PluginKey('rundol-block-handle');

// 손잡이가 서는 왼쪽 여백의 너비. 자리를 잡을 때와 "아직 손잡이 곁에 있다"를 따질 때가
// 같은 수를 써야 한다. 둘이 어긋나면 손잡이로 가는 길 위에서 손잡이가 사라진다.
const GUTTER = 56;
// 여백 가장자리에서 손이 조금 흔들려도 숨기지 않는 여유.
const EDGE = 16;
// 같은 틈으로 볼 높이 차이. 한 경계에서 위 블록의 아래 모서리와 아래 블록의 위 모서리는
// 블록 사이 여백만큼 어긋나 있다.
const SAME_GAP = 6;
// 한 번의 dragover에서 살펴볼 후보의 수. 문서가 길어져도 드는 값이 커지지 않게 막는다.
const LOOK = 80;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function isList(node) {
  return node && (node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list);
}

function isItem(node) {
  return node && node.type === schema.nodes.list_item;
}

/** 블록 첫 줄의 높이. 손잡이를 문단 꼭대기가 아니라 첫 글자 옆에 세우는 데 쓴다. */
function firstLineHeight(dom) {
  const style = window.getComputedStyle(dom);
  const line = parseFloat(style.lineHeight);
  if (Number.isFinite(line)) return line;
  const size = parseFloat(style.fontSize);
  return Number.isFinite(size) ? size * 1.5 : 24;
}

/**
 * 마우스 아래의 "끌 수 있는 한 덩어리".
 *
 * 목록 항목은 항목 하나가 덩어리다. 목록 전체만 끌 수 있으면 순서를 바꾸려고 항목
 * 하나를 옮기는 가장 흔한 일을 할 수 없다. 다만 목록 사슬 밖(표 칸·인용 안)까지
 * 따라 들어가지는 않는다 — 그 안쪽에는 손잡이를 세울 여백이 없다.
 */
function unitAt(view, clientX, clientY) {
  const content = view.dom.getBoundingClientRect();
  const left = Math.min(Math.max(clientX, content.left + 4), content.right - 4);
  const found = view.posAtCoords({ left, top: clientY });
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
  let item = 0;
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const node = $pos.node(depth);
    if (isItem(node)) item = depth;
    else if (!isList(node)) break;
  }
  const pos = item ? $pos.before(item) : ($pos.depth === 0 ? found.inside : $pos.before(1));
  if (pos == null || pos < 0) return null;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return null;
  const dom = view.nodeDOM(pos);
  return { pos, node, dom: dom && dom.getBoundingClientRect ? dom : null };
}

/** 들여쓰기 한 칸 — 항목이 자기 목록에서 밀려난 만큼. 체크 목록과 불릿이 다르다. */
function stepOf(dom, box) {
  const parent = dom.parentElement;
  if (!parent) return 24;
  const step = box.left - parent.getBoundingClientRect().left;
  return step >= 12 ? step : 24;
}

/** 놓을 수 있는 자리 전부 — 블록마다 위 모서리와 아래 모서리를, 그 블록의 가로 범위와 함께. */
function dropTargets(view) {
  const found = new Map();
  // 한 자리를 여러 블록의 모서리가 가리킨다. 목록 항목의 마지막 문단 뒤와 그 항목
  // 안의 끝은 같은 수다. 그중 가장 깊은 것(오른쪽에서 시작하는 것)이 그 자리에
  // 실제로 들어갈 그릇이므로, 같은 자리면 깊은 쪽을 남긴다.
  const keep = (pos, left, width, y) => {
    const had = found.get(pos);
    if (!had || left > had.left) found.set(pos, { pos, left, width, y });
  };
  const walk = (node, pos) => {
    if (pos >= 0) {
      const dom = view.nodeDOM(pos);
      const box = dom && dom.getBoundingClientRect ? dom.getBoundingClientRect() : null;
      if (box && box.width) {
        keep(pos, box.left, box.width, box.top);
        keep(pos + node.nodeSize, box.left, box.width, box.bottom);
        // 아직 자식 목록이 없는 항목에는 "그 안"을 가리키는 DOM이 없다. 그 자리를
        // 만들지 않으면 이미 자식이 있는 항목에만 들여쓰기가 되고, 새 층은 영영
        // 만들 수 없다 — 오른쪽으로 끌어도 아무 일이 없는 것이 그것이다.
        if (isItem(node) && !isList(node.lastChild)) {
          const step = stepOf(dom, box);
          keep(pos + node.nodeSize - 1, box.left + step, Math.max(24, box.width - step), box.bottom);
        }
      }
    }
    // 글줄 안으로는 들어가지 않는다. 문단 가운데는 블록이 놓일 자리가 아니다.
    if (!node.isBlock || node.isTextblock) return;
    let child = pos + 1;
    node.forEach((inner) => { walk(inner, child); child += inner.nodeSize; });
  };
  walk(view.state.doc, -1);
  return [...found.values()];
}

/**
 * 후보들 가운데 지금 가리키는 곳에 맞는 하나.
 *
 * y로 틈을 먼저 정하고 그 틈 안에서 x로 층을 고른다. 둘을 하나의 거리로 합치면
 * 오른쪽으로 조금 움직인 것이 한 줄 위 틈으로 뛴다 — 층을 고르려던 손이 자리를 잃는다.
 * accepts는 놓을 수 있는 자리인지 묻는다. 놓을 수 없는 자리가 틈을 차지하면 그 아래
 * 있는 멀쩡한 후보가 가려진다.
 */
export function chooseSpot(spots, clientX, clientY, accepts) {
  const sorted = spots
    .map((spot) => ({ ...spot, dy: Math.abs(spot.y - clientY) }))
    .sort((a, b) => a.dy - b.dy || Math.abs(a.left - clientX) - Math.abs(b.left - clientX));

  let gap = null;
  let best = null;
  let looked = 0;
  for (const spot of sorted) {
    if (gap !== null && spot.dy > gap + SAME_GAP) break;
    if (looked >= LOOK) break;
    looked += 1;
    if (!accepts(spot.pos)) continue;
    if (gap === null) gap = spot.dy;
    if (!best || Math.abs(spot.left - clientX) < Math.abs(best.left - clientX)) best = spot;
  }
  return best;
}

/** 지울 범위. 항목 하나만 남은 목록은 껍데기까지 같이 지운다 — 빈 목록은 문서가 아니다. */
function removalRange(doc, pos) {
  const node = doc.nodeAt(pos);
  const $pos = doc.resolve(pos);
  let from = pos;
  let to = pos + node.nodeSize;
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    const parent = $pos.node(depth);
    if (parent.childCount !== 1 || !(isList(parent) || isItem(parent))) break;
    from = $pos.before(depth);
    to = $pos.after(depth);
  }
  return { from, to };
}

/**
 * 옮길 것을 받을 자리의 모양에 맞춘다.
 *
 * 같은 블록이라도 목록 안에서는 항목이어야 하고 목록 밖에서는 항목일 수 없다.
 * 맞추지 않고 넣으면 스키마가 거절하거나, 더 나쁘게는 조용히 다른 것이 된다.
 * 항목을 밖으로 낼 때 원래 목록의 종류(불릿/번호)를 되씌우는 이유는 번호 목록에서
 * 꺼낸 항목이 불릿으로 바뀌면 그것은 옮긴 것이 아니라 고친 것이기 때문이다.
 */
function fit(parent, node, list) {
  if (isList(parent)) return isItem(node) ? node : schema.nodes.list_item.create(null, [node]);
  if (!isItem(node)) return node;
  const type = isList(list) ? list.type : schema.nodes.bullet_list;
  return type.create(isList(list) ? list.attrs : null, [node]);
}

/**
 * from의 블록을 target 자리로 옮기는 트랜잭션. 놓을 수 없는 자리면 null.
 *
 * 표시선을 그릴 때와 실제로 놓을 때가 같은 함수를 본다. 둘을 따로 두면 "선은 떴는데
 * 놓아도 안 옮겨진다"가 생기고, 그것은 사람이 자기 손을 의심하게 만든다.
 */
export function planMove(state, from, target) {
  const doc = state.doc;
  const node = doc.nodeAt(from);
  if (!node) return null;
  const cut = removalRange(doc, from);
  // 자기 안이나 자기 경계에 놓으면 아무 일도 하지 않는다. 그대로 두면 지웠다 같은
  // 자리에 넣는 트랜잭션이 되어 편집하지 않은 블록이 "고친 것"이 된다.
  if (target >= cut.from && target <= cut.to) return null;

  const tr = state.tr.delete(cut.from, cut.to);
  const at = tr.mapping.map(target);
  const $at = tr.doc.resolve(at);
  if ($at.parent.isTextblock) return null;
  const piece = fit($at.parent, node, doc.resolve(from).parent);
  if (!$at.parent.canReplace($at.index(), $at.index(), Fragment.from(piece))) return null;
  tr.insert(at, piece);
  try { tr.setSelection(NodeSelection.create(tr.doc, at)); } catch (_) { /* 고를 수 없는 자리면 선택은 두고 간다 */ }
  return tr.scrollIntoView();
}

/** 블록 하나를 옮긴다. 자리 계산과 떼어 두어 화면 없이도 시험할 수 있다. */
export function moveBlock(view, from, target) {
  const tr = planMove(view.state, from, target);
  if (!tr) return false;
  view.dispatch(tr);
  view.focus();
  return true;
}

class BlockHandleView {
  constructor(view, options) {
    this.view = view;
    this.sections = (options && options.contractSections) || [];
    this.target = null;
    this.drag = null;
    this.targets = null;

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

    this.onMove = (event) => this.track(event);
    // 손잡이는 편집 영역 왼쪽 여백, 곧 편집 영역 밖에 서 있다. 그래서 "편집 영역을
    // 벗어났다"를 숨김의 신호로 삼으면 손잡이를 잡으러 가는 손이 손잡이를 지운다 —
    // 여백을 건너는 몇 픽셀 동안 마우스는 편집 영역에도 손잡이에도 얹혀 있지 않다.
    // 대신 편집 영역과 그 왼쪽 여백을 하나의 자리로 보고, 그 밖에서만 숨긴다.
    // 창을 벗어나는 것(relatedTarget이 없는 mouseout)은 그 자리를 떠난 것으로 친다.
    this.onWindowOut = (event) => { if (!event.relatedTarget) this.hide(); };
    // 스크롤이나 창 크기로 블록이 움직이면 손잡이도 따라가야 한다. 제자리에 남으면
    // 엉뚱한 블록 옆에 서서 그 블록을 가리키는 것처럼 보인다.
    this.onReflow = () => this.update();
    this.onDocumentDown = (event) => {
      if (!this.menu.contains(event.target) && event.target !== this.add) this.closeMenu();
    };
    // 끄는 동안의 dragover·drop은 문서 전체에서 잡는다. 편집 영역에만 걸면 손잡이가
    // 선 왼쪽 여백 위에서는 표시선도 놓기도 없다 — 정작 끌기가 시작된 자리다.
    this.onDragOver = (event) => this.dragOver(event);
    this.onDrop = (event) => this.drop(event);

    document.addEventListener('mousemove', this.onMove, true);
    document.addEventListener('mouseout', this.onWindowOut);
    window.addEventListener('scroll', this.onReflow, true);
    window.addEventListener('resize', this.onReflow);
    this.add.addEventListener('click', (event) => { event.preventDefault(); this.toggleMenu(); });
    this.grip.addEventListener('click', (event) => { event.preventDefault(); this.selectBlock(); });
    this.grip.addEventListener('dragstart', (event) => this.startDrag(event));
    this.grip.addEventListener('dragend', () => this.endDrag());
    document.addEventListener('mousedown', this.onDocumentDown, true);
  }

  track(event) {
    // 메뉴가 열려 있으면 대상을 바꾸지 않는다. 마우스가 메뉴로 가는 동안 아래 블록이
    // 바뀌면 고른 항목이 방금 보고 있던 블록이 아닌 곳에 들어간다.
    if (this.menu.style.display !== 'none' || this.drag) return;
    if (!this.inZone(event.clientX, event.clientY)) return this.hide();
    const block = unitAt(this.view, event.clientX, event.clientY);
    if (!block || !block.dom) return this.hide();
    this.target = block;
    this.place(block.dom);
  }

  /** 손잡이가 살아 있는 자리 — 편집 영역과 손잡이가 선 왼쪽 여백을 합친 것. */
  inZone(x, y) {
    const host = this.host.getBoundingClientRect();
    if (!host.width && !host.height) return false;
    return x >= host.left - GUTTER - EDGE && x <= host.right + EDGE
      && y >= host.top - EDGE && y <= host.bottom + EDGE;
  }

  place(dom) {
    const host = this.host.getBoundingClientRect();
    const box = dom.getBoundingClientRect();
    this.root.style.display = 'flex';
    // 문단 꼭대기가 아니라 첫 줄 한가운데에 맞춘다. 줄 사이가 넓으면 꼭대기에 선
    // 손잡이는 자기 블록이 아니라 위 블록에 붙어 보인다.
    const lift = Math.max(0, (firstLineHeight(dom) - this.root.offsetHeight) / 2);
    this.root.style.top = `${box.top - host.top + this.host.scrollTop + lift}px`;
    this.root.style.left = `${box.left - host.left - GUTTER}px`;
  }

  hide() {
    if (this.menu.style.display !== 'none' || this.drag) return;
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
    if (entry.action === 'image') { this.closeMenu(); return pickImage(this.view); }
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
    if (!this.target || !this.target.dom) return;
    const { pos, node, dom } = this.target;
    this.drag = { from: pos };
    this.targets = null;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', node.textContent.slice(0, 80));
    event.dataTransfer.setDragImage(dom, 0, 0);
    this.closeMenu();
    document.addEventListener('dragover', this.onDragOver, true);
    document.addEventListener('drop', this.onDrop, true);
    // 지금 감추면 크롬이 끌기 자체를 취소한다. 끌기 이미지가 잡힌 다음에 감춘다.
    setTimeout(() => { if (this.drag) this.root.style.display = 'none'; }, 0);
    // 끌기에 필요한 것을 다 갖춘 뒤에 문서를 건드린다. dispatch는 모든 플러그인의
    // update를 부르고, 그중 하나가 던지면 이 함수의 나머지가 실행되지 않는다.
    // 그렇게 되면 끌기는 시작되었는데 놓을 곳을 아무도 듣지 않는 상태가 된다.
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
  }

  /** 후보 자리. 문서는 끄는 동안 바뀌지 않으므로 한 번만 재고, 스크롤하면 다시 잰다. */
  spots() {
    const anchor = this.view.dom.getBoundingClientRect().top;
    if (!this.targets || this.anchorY !== anchor) {
      this.targets = dropTargets(this.view);
      this.anchorY = anchor;
    }
    return this.targets;
  }

  /** 지금 가리키는 곳에 놓으면 어디로 가는가. 놓을 수 없는 자리는 후보가 아니다 —
   *  표 칸이나 자기 안쪽이 여기서 걸러진다. */
  spotFor(clientX, clientY) {
    const state = this.view.state;
    const from = this.drag.from;
    return chooseSpot(this.spots(), clientX, clientY, (pos) => Boolean(planMove(state, from, pos)));
  }

  dragOver(event) {
    if (!this.drag) return;
    // 브라우저에 "여기 놓을 수 있다"고 알리는 유일한 방법이 preventDefault다.
    event.preventDefault();
    // ProseMirror의 기본 놓기까지 가면 층을 무시한 자리에 한 번 더 넣는다.
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const spot = this.inZone(event.clientX, event.clientY) ? this.spotFor(event.clientX, event.clientY) : null;
    if (!spot) return this.hideLine();
    const host = this.host.getBoundingClientRect();
    this.line.style.display = 'block';
    this.line.style.top = `${spot.y - host.top + this.host.scrollTop - 1}px`;
    this.line.style.left = `${spot.left - host.left}px`;
    this.line.style.width = `${spot.width}px`;
  }

  hideLine() { this.line.style.display = 'none'; }

  drop(event) {
    if (!this.drag) return;
    event.preventDefault();
    event.stopPropagation();
    const from = this.drag.from;
    const spot = this.inZone(event.clientX, event.clientY) ? this.spotFor(event.clientX, event.clientY) : null;
    this.endDrag();
    if (spot) moveBlock(this.view, from, spot.pos);
  }

  endDrag() {
    this.drag = null;
    this.targets = null;
    this.hideLine();
    this.root.style.display = 'none';
    this.target = null;
    document.removeEventListener('dragover', this.onDragOver, true);
    document.removeEventListener('drop', this.onDrop, true);
  }

  update() {
    if (!this.target || this.drag || this.root.style.display === 'none') return;
    if (this.target.pos > this.view.state.doc.content.size) return this.hide();
    const dom = this.view.nodeDOM(this.target.pos);
    if (dom && dom.getBoundingClientRect) this.place(dom);
    else this.hide();
  }

  destroy() {
    document.removeEventListener('mousemove', this.onMove, true);
    document.removeEventListener('mouseout', this.onWindowOut);
    window.removeEventListener('scroll', this.onReflow, true);
    window.removeEventListener('resize', this.onReflow);
    document.removeEventListener('mousedown', this.onDocumentDown, true);
    document.removeEventListener('dragover', this.onDragOver, true);
    document.removeEventListener('drop', this.onDrop, true);
    this.root.remove();
    this.menu.remove();
    this.line.remove();
  }
}

export function blockHandle(options = {}) {
  return new Plugin({
    key: blockHandleKey,
    view: (view) => new BlockHandleView(view, options)
  });
}
