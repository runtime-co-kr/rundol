// 코드 블록 — 언어를 고르고, mermaid는 그린 것을 함께 본다.
//
// 정본 문서에 mermaid 블록이 16개 있고 읽기 화면은 이미 그린다. 편집 중에는 글자로만
// 보여서, 고친 결과를 확인하려면 저장하고 화면을 나갔다 와야 했다. 다이어그램은
// 표에서 파생한 보조 뷰라 자주 고치는 것인데 그 왕복이 매번 붙었다.
//
// 그리는 일은 보드가 이미 하는 것을 쓴다. mermaid는 화면이 전역으로 들고 있고,
// 테마 색도 그쪽이 맞춰 둔다. 편집기가 자기 mermaid를 들이면 번들이 커지고
// 읽기 화면과 편집 화면이 서로 다른 그림을 그리게 된다.

const LANGUAGES = [
  ['', '(없음)'],
  ['mermaid', 'mermaid'],
  ['text', 'text'],
  ['bash', 'bash'],
  ['json', 'json'],
  ['yaml', 'yaml'],
  ['javascript', 'javascript'],
  ['typescript', 'typescript'],
  ['sql', 'sql'],
  ['diff', 'diff']
];

export class CodeBlockView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.className = 'rdl-code-block';

    this.bar = document.createElement('div');
    this.bar.className = 'rdl-code-bar';
    this.bar.contentEditable = 'false';

    this.select = document.createElement('select');
    this.select.className = 'rdl-code-lang';
    this.select.title = '언어';
    for (const [value, label] of LANGUAGES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.select.append(option);
    }
    // 목록에 없는 언어를 쓰는 문서가 있다. 지우면 그 문서가 언어를 잃는다.
    if (node.attrs.lang && !LANGUAGES.some(([value]) => value === node.attrs.lang)) {
      const option = document.createElement('option');
      option.value = node.attrs.lang;
      option.textContent = node.attrs.lang;
      this.select.append(option);
    }
    this.select.value = node.attrs.lang || '';
    this.select.addEventListener('change', () => this.setLang(this.select.value));
    this.bar.append(this.select);

    this.preview = document.createElement('div');
    this.preview.className = 'rdl-code-preview';
    this.preview.contentEditable = 'false';
    this.preview.hidden = true;

    const pre = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    pre.append(this.contentDOM);

    this.dom.append(this.bar, pre, this.preview);
    this.paint();
  }

  setLang(lang) {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, lang }));
    this.view.focus();
  }

  paint() {
    const isDiagram = this.node.attrs.lang === 'mermaid';
    this.dom.classList.toggle('is-diagram', isDiagram);
    if (!isDiagram) { this.preview.hidden = true; return; }
    this.draw();
  }

  // 타자마다 그리면 아직 끝나지 않은 문장에서 mermaid가 오류를 내고, 그 오류가
  // 글을 쓰는 내내 깜빡인다. 손이 멈춘 뒤에 한 번만 그린다.
  draw() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), 700);
  }

  async render() {
    const source = this.node.textContent.trim();
    if (!source) { this.preview.hidden = true; return; }
    const engine = window.mermaid;
    if (!engine) { this.preview.hidden = true; return; }
    this.preview.hidden = false;
    try {
      // 같은 문서에 블록이 여럿이므로 id가 겹치면 안 된다. 위치가 곧 자리다.
      const id = `rdl-mermaid-${typeof this.getPos() === 'number' ? this.getPos() : 0}`;
      const { svg } = await engine.render(id, source);
      this.preview.innerHTML = svg;
      this.preview.classList.remove('is-error');
    } catch (error) {
      // 그리지 못한 것도 알려 준다. 조용히 빈 자리로 두면 사람은 문법이 맞는 줄 안다.
      this.preview.classList.add('is-error');
      this.preview.textContent = `다이어그램을 그리지 못했습니다: ${String(error && error.message || error).split('\n')[0]}`;
    }
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.select.value !== (node.attrs.lang || '')) this.select.value = node.attrs.lang || '';
    this.paint();
    return true;
  }

  // 언어 선택기와 미리보기는 문서가 아니다. ProseMirror가 그 안의 변화를 문서로 읽지 않게 한다.
  ignoreMutation(mutation) {
    return this.bar.contains(mutation.target) || this.preview.contains(mutation.target);
  }

  stopEvent(event) {
    return this.bar.contains(event.target) || this.preview.contains(event.target);
  }

  destroy() { clearTimeout(this.timer); }
}
