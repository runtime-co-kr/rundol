// 체크 목록의 상자를 눌러 상태를 바꾼다.
//
// 수용 기준은 `- [ ]`로 쓰고 증거가 생기면 `- [x]`가 된다. 그것을 바꾸려고 원문
// 편집기를 열던 것이 지금까지의 방식이다. 눌러서 바꿀 수 있어야 한다.
//
// Crepe도 NodeView로 같은 일을 한다 — 떠다니는 UI 없이 항목 왼쪽에 라벨을 항상
// 그리고, checked가 null이 아닐 때만 그 라벨이 눌린다. 불릿 목록의 점은 눌러도
// 아무 일도 없어야 한다.
//
// 상자는 contentEditable을 끈다. 켜 두면 사람이 그 안에 글자를 칠 수 있고, 그
// 글자는 문서 어디에도 속하지 않는다.

export class ListItemView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('li');
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'rdl-list-content';

    if (node.attrs.checked === null) {
      this.dom.append(this.contentDOM);
      return;
    }

    this.dom.className = 'rdl-task-item';
    this.box = document.createElement('span');
    this.box.className = 'rdl-task-box';
    this.box.contentEditable = 'false';
    this.box.setAttribute('role', 'checkbox');
    // pointerdown에 거는 이유는 click까지 가면 그 사이에 커서가 상자 쪽으로 옮겨져
    // 선택이 엉뚱한 곳에 놓이기 때문이다.
    this.box.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.toggle();
    });
    this.paint();
    this.dom.append(this.box, this.contentDOM);
  }

  paint() {
    if (!this.box) return;
    const checked = Boolean(this.node.attrs.checked);
    this.box.textContent = checked ? '☑' : '☐';
    this.box.setAttribute('aria-checked', String(checked));
    this.dom.classList.toggle('is-checked', checked);
  }

  toggle() {
    if (!this.view.editable) return;
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const attrs = { ...this.node.attrs, checked: !this.node.attrs.checked };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, attrs));
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    // 체크 상자가 생기거나 사라지는 것은 DOM 구조가 바뀌는 일이라 새로 만들게 둔다.
    if ((node.attrs.checked === null) !== (this.node.attrs.checked === null)) return false;
    this.node = node;
    this.paint();
    return true;
  }

  // 상자는 문서가 아니다. ProseMirror가 그 안의 변화를 문서로 읽지 않게 한다.
  ignoreMutation(mutation) {
    return Boolean(this.box) && this.box.contains(mutation.target);
  }

  stopEvent(event) {
    return Boolean(this.box) && this.box.contains(event.target);
  }
}
