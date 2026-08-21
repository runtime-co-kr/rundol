// 표 손잡이 — 행 왼쪽과 열 위에 뜨는 잡이, 그리고 그 잡이가 여는 조작 묶음.
//
// 정본 문서에 표가 242개 있고, MOD와 SCR에서는 표가 다이어그램의 정본이다. 표를
// 못 고치면 그 두 유형은 편집기로 다룰 수 없다.
//
// 상호작용은 Crepe의 것을 따랐다. 소스를 확인해 보니 선택이 아니라 pointermove로
// 셀을 찾고, 셀 경계 가까이에서는 손잡이 대신 끼워넣기 단추를 띄운다. 이 구분이
// 없으면 "이 열을 지운다"와 "여기에 열을 넣는다"가 같은 자리를 다투게 된다.
//
// 열 정렬은 머리 행의 셀 값이 파일로 나간다. 그래서 정렬은 열 전체에 건다 —
// 화면에서는 모든 셀이 따라야 하고, 파일에서는 머리 행 하나가 그 열을 대표한다.

import { Plugin, PluginKey } from 'prosemirror-state';
import { guarded } from './guard.mjs';
import {
  CellSelection, TableMap, cellAround,
  addColumnBefore, addColumnAfter, deleteColumn,
  addRowBefore, addRowAfter, deleteRow,
  setCellAttr, moveTableColumn, moveTableRow
} from 'prosemirror-tables';

export const tableControlsKey = new PluginKey('rundol-table-controls');

// 셀 경계로부터 이 거리 안에 있으면 끼워넣기 자리로 본다.
const EDGE = 8;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className, text, title, onClick) {
  const node = element('button', className, text);
  node.type = 'button';
  node.title = title;
  node.addEventListener('pointerdown', (event) => { event.preventDefault(); onClick(); });
  return node;
}

/** 마우스 아래 셀의 표·행·열 좌표. 표 밖이면 null. */
function locate(view, clientX, clientY) {
  const found = view.posAtCoords({ left: clientX, top: clientY });
  if (!found) return null;
  const $cell = cellAround(view.state.doc.resolve(found.pos));
  if (!$cell) return null;

  // 표는 최상위일 수도 목록 안일 수도 있다. 이름으로 찾아 올라간다.
  let depth = $cell.depth - 1;
  while (depth > 0 && $cell.node(depth).type.spec.tableRole !== 'table') depth -= 1;
  if (depth < 1) return null;

  const table = $cell.node(depth);
  const tableStart = $cell.start(depth);
  const map = TableMap.get(table);
  const cell = map.findCell($cell.pos - tableStart);
  return { table, tableStart, map, cellPos: $cell.pos, row: cell.top, col: cell.left };
}

class TableControlsView {
  constructor(view) {
    this.view = view;
    this.spot = null;
    this.mode = null; // 'row' | 'col'

    this.rowHandle = element('div', 'rdl-table-handle rdl-table-row-handle');
    this.colHandle = element('div', 'rdl-table-handle rdl-table-col-handle');
    this.insert = element('button', 'rdl-table-insert', '+');
    this.insert.type = 'button';
    this.group = element('div', 'rdl-table-group');
    for (const node of [this.rowHandle, this.colHandle, this.insert, this.group]) node.style.display = 'none';

    this.rowHandle.draggable = true;
    this.colHandle.draggable = true;

    const host = view.dom.parentNode;
    if (!host.style.position) host.style.position = 'relative';
    host.append(this.rowHandle, this.colHandle, this.insert, this.group);
    this.host = host;

    this.onMove = (event) => this.track(event);
    this.onLeave = (event) => {
      const to = event.relatedTarget;
      if (to && (this.group.contains(to) || to === this.rowHandle || to === this.colHandle || to === this.insert)) return;
      // Crepe도 바로 감추지 않는다. 손잡이로 가는 동안 사라지면 잡을 수 없다.
      this.timer = setTimeout(() => this.hide(), 200);
    };
    host.addEventListener('mousemove', this.onMove);
    host.addEventListener('mouseleave', this.onLeave);

    this.rowHandle.addEventListener('pointerdown', (event) => { event.preventDefault(); this.selectRow(); });
    this.colHandle.addEventListener('pointerdown', (event) => { event.preventDefault(); this.selectCol(); });
    this.rowHandle.addEventListener('dragstart', (event) => this.startDrag(event, 'row'));
    this.colHandle.addEventListener('dragstart', (event) => this.startDrag(event, 'col'));
    this.rowHandle.addEventListener('dragover', (event) => event.preventDefault());
    this.colHandle.addEventListener('dragover', (event) => event.preventDefault());
    this.insert.addEventListener('pointerdown', (event) => { event.preventDefault(); this.runInsert(); });

    this.onDocumentDown = (event) => {
      if (this.group.contains(event.target) || event.target === this.rowHandle || event.target === this.colHandle) return;
      this.group.style.display = 'none';
    };
    document.addEventListener('mousedown', this.onDocumentDown, true);
  }

  track(event) {
    clearTimeout(this.timer);
    const spot = locate(this.view, event.clientX, event.clientY);
    if (!spot) return this.hide();
    this.spot = spot;

    const dom = this.view.nodeDOM(spot.cellPos);
    if (!dom || !dom.getBoundingClientRect) return this.hide();
    const box = dom.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    const top = () => box.top - host.top + this.host.scrollTop;
    const left = () => box.left - host.left;

    const nearLeft = event.clientX - box.left <= EDGE;
    const nearRight = box.right - event.clientX <= EDGE;
    const nearTop = event.clientY - box.top <= EDGE;
    const nearBottom = box.bottom - event.clientY <= EDGE;

    // 경계 가까이면 끼워넣기 자리다. 머리 행 위쪽에는 넣지 않는다 —
    // 머리 행 위의 행은 표에 머리가 둘이라는 뜻이 된다.
    if (nearLeft || nearRight) {
      this.showInsert('col', nearLeft ? spot.col : spot.col + 1, left() + (nearLeft ? 0 : box.width), top(), box.height);
      return;
    }
    if ((nearTop && spot.row > 0) || nearBottom) {
      this.showInsert('row', nearTop ? spot.row : spot.row + 1, left(), top() + (nearTop ? 0 : box.height), box.width);
      return;
    }

    this.insert.style.display = 'none';
    this.rowHandle.style.display = 'block';
    this.rowHandle.style.top = `${top()}px`;
    this.rowHandle.style.left = `${left() - 14}px`;
    this.rowHandle.style.height = `${box.height}px`;

    // 열 손잡이는 그 열의 머리 셀 위에 붙는다. 어느 셀에 있든 열은 하나다.
    const headPos = spot.tableStart + spot.map.map[spot.col];
    const headDom = this.view.nodeDOM(headPos);
    const headBox = headDom && headDom.getBoundingClientRect ? headDom.getBoundingClientRect() : box;
    this.colHandle.style.display = 'block';
    this.colHandle.style.top = `${headBox.top - host.top + this.host.scrollTop - 14}px`;
    this.colHandle.style.left = `${headBox.left - host.left}px`;
    this.colHandle.style.width = `${headBox.width}px`;
  }

  showInsert(kind, index, left, top, span) {
    this.rowHandle.style.display = 'none';
    this.colHandle.style.display = 'none';
    this.insert.style.display = 'flex';
    this.insert.dataset.kind = kind;
    this.insert.dataset.index = String(index);
    this.insert.style.left = `${left - 10}px`;
    this.insert.style.top = `${top - 10}px`;
    this.insert.title = kind === 'col' ? '여기에 열 넣기' : '여기에 행 넣기';
    this.insertSpan = span;
  }

  hide() {
    if (this.group.style.display !== 'none') return;
    for (const node of [this.rowHandle, this.colHandle, this.insert]) node.style.display = 'none';
    this.spot = null;
  }

  // 조작을 걸려면 먼저 그 행·열을 고른 상태여야 한다. prosemirror-tables의 명령이
  // 전부 선택을 보고 움직이기 때문이다.
  selectionFor(kind) {
    if (!this.spot) return null;
    const { tableStart, map, row, col } = this.spot;
    const anchor = this.view.state.doc.resolve(tableStart + map.map[kind === 'col' ? col : row * map.width]);
    const headIndex = kind === 'col' ? (map.height - 1) * map.width + col : row * map.width + (map.width - 1);
    const head = this.view.state.doc.resolve(tableStart + map.map[headIndex]);
    return kind === 'col' ? CellSelection.colSelection(anchor, head) : CellSelection.rowSelection(anchor, head);
  }

  select(kind) {
    const selection = this.selectionFor(kind);
    if (!selection) return false;
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    this.mode = kind;
    return true;
  }

  selectRow() { if (this.select('row')) this.showGroup('row'); }
  selectCol() { if (this.select('col')) this.showGroup('col'); }

  run(command) {
    command(this.view.state, this.view.dispatch);
    this.view.focus();
    this.group.style.display = 'none';
  }

  align(value) {
    // 정렬은 열 전체에 건다. 파일로 나가는 것은 머리 행의 값이지만, 화면에서
    // 머리만 옮겨 가고 아래는 그대로면 사람이 자기가 무엇을 바꿨는지 헷갈린다.
    setCellAttr('alignment', value)(this.view.state, this.view.dispatch);
    this.view.focus();
    this.group.style.display = 'none';
  }

  showGroup(kind) {
    this.group.replaceChildren();
    if (kind === 'col') {
      this.group.append(
        button('rdl-table-button', '⇤', '왼쪽 정렬', () => this.align('left')),
        button('rdl-table-button', '⇔', '가운데 정렬', () => this.align('center')),
        button('rdl-table-button', '⇥', '오른쪽 정렬', () => this.align('right')),
        element('span', 'rdl-table-divider'),
        button('rdl-table-button', '←+', '왼쪽에 열 추가', () => this.run(addColumnBefore)),
        button('rdl-table-button', '+→', '오른쪽에 열 추가', () => this.run(addColumnAfter)),
        button('rdl-table-button is-danger', '✕', '열 삭제', () => this.run(deleteColumn))
      );
    } else {
      this.group.append(
        button('rdl-table-button', '↑+', '위에 행 추가', () => this.run(addRowBefore)),
        button('rdl-table-button', '+↓', '아래에 행 추가', () => this.run(addRowAfter)),
        button('rdl-table-button is-danger', '✕', '행 삭제', () => this.run(deleteRow))
      );
    }
    const anchor = (kind === 'col' ? this.colHandle : this.rowHandle).getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    this.group.style.display = 'flex';
    const box = this.group.getBoundingClientRect();
    this.group.style.top = `${anchor.top - host.top + this.host.scrollTop - box.height - 8}px`;
    this.group.style.left = `${Math.max(0, anchor.left - host.left + anchor.width / 2 - box.width / 2)}px`;
  }

  runInsert() {
    if (!this.spot) return;
    const kind = this.insert.dataset.kind;
    const index = Number(this.insert.dataset.index);
    const { tableStart, map } = this.spot;
    // 넣을 자리의 이웃 셀을 골라 두어야 명령이 어디에 넣을지 안다.
    const neighbour = kind === 'col'
      ? Math.min(index, map.width - 1)
      : Math.min(index, map.height - 1);
    const cellIndex = kind === 'col' ? neighbour : neighbour * map.width;
    const $cell = this.view.state.doc.resolve(tableStart + map.map[cellIndex]);
    const selection = kind === 'col'
      ? CellSelection.colSelection($cell, $cell)
      : CellSelection.rowSelection($cell, $cell);
    this.view.dispatch(this.view.state.tr.setSelection(selection));

    const before = kind === 'col' ? index <= neighbour : index <= neighbour;
    const command = kind === 'col'
      ? (before ? addColumnBefore : addColumnAfter)
      : (before ? addRowBefore : addRowAfter);
    command(this.view.state, this.view.dispatch);
    this.view.focus();
    this.insert.style.display = 'none';
  }

  startDrag(event, kind) {
    if (!this.spot) return;
    this.dragging = { kind, index: kind === 'col' ? this.spot.col : this.spot.row, tableStart: this.spot.tableStart };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', kind);
  }

  finishDrag(event) {
    const dragging = this.dragging;
    this.dragging = null;
    if (!dragging) return false;
    const spot = locate(this.view, event.clientX, event.clientY);
    if (!spot || spot.tableStart !== dragging.tableStart) return false;
    const to = dragging.kind === 'col' ? spot.col : spot.row;
    if (to === dragging.index) return true;
    const move = dragging.kind === 'col' ? moveTableColumn : moveTableRow;
    const rect = { tableStart: spot.tableStart, map: spot.map, table: spot.table };
    try {
      const tr = move(this.view.state, rect, [dragging.index], to);
      if (tr) this.view.dispatch(tr);
    } catch (_) { /* 옮기지 못하면 그대로 둔다 */ }
    return true;
  }

  update() { guarded('table-controls', () => { if (this.spot) this.hide(); }); }

  destroy() {
    clearTimeout(this.timer);
    this.host.removeEventListener('mousemove', this.onMove);
    this.host.removeEventListener('mouseleave', this.onLeave);
    document.removeEventListener('mousedown', this.onDocumentDown, true);
    for (const node of [this.rowHandle, this.colHandle, this.insert, this.group]) node.remove();
  }
}

export function tableControls() {
  let controls = null;
  return new Plugin({
    key: tableControlsKey,
    view(view) { controls = new TableControlsView(view); return controls; },
    props: {
      handleDOMEvents: {
        drop(view, event) {
          if (!controls) return false;
          return controls.finishDrag(event);
        },
        dragover(view, event) {
          if (controls && controls.dragging) event.preventDefault();
          return false;
        }
      }
    }
  });
}
