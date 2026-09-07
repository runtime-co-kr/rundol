// wiki_link 노드의 화면. 자산 embed는 그림으로, 문서 참조는 글자로 보인다.
//
// 왜 이 파일이 있는가. 스키마의 toDOM은 embed를 `<span>이름.png</span>`으로 냈다.
// 붙여넣은 사람은 저장하고 읽기 화면으로 나가기 전까지 자기가 무엇을 넣었는지 볼 수
// 없었고, 여러 장을 넣거나 잘못 넣었을 때 그 자리에서 알 방법이 없었다. 넣는 일은
// 편집기 안에서 끝나므로 확인도 편집기 안에서 끝나야 한다.
//
// 문서 참조와 자산 embed를 무엇으로 가르는가. `!`다 — 스키마의 `embed` attr이 그것을
// 이미 담고 있고, 그 값은 원문의 느낌표에서 온다. 확장자로 가르지 않는 이유는 두
// 가지다. 첫째, 읽기 화면(app.js의 markdown())이 이미 `!`로 가른다. 편집기가 다른
// 기준을 쓰면 같은 글자가 두 화면에서 다른 것이 되고, 그것은 사람이 진단할 수 없는
// 어긋남이다. 둘째, 확장자는 이름의 성질이지 참조의 성질이 아니다. 확장자 없는
// 이름을 `![[…]]`로 적은 문서는 지금도 만들 수 있고, 그때 확장자 규칙은 그림을
// 문서 링크로 바꿔 버린다.
//
// 그러면 `![[REQ-001]]`(문서 전사)은 어떻게 되는가. 이 저장소에서 그것은 자산 참조로
// 읽힌다 — 읽기 화면이 그렇게 읽고, rdl check의 RDL-ASSET-001이 그렇게 검사한다.
// 그래서 여기서도 자산으로 읽고, 받지 못하면 받지 못했다고 말한다. 판정을 새로
// 만들지 않는 것이 이 파일의 규율이다.
//
// 못 받은 그림은 지어내지 않는다. 빈 자리는 "그림이 없다"와 "아직 안 왔다"를 가르지
// 못하므로, 세 상태를 각각 다르게 보인다 — 기다리는 중 · 받음 · 못 받음. 못 받은
// 것은 왜 못 받았는지까지 적는다. 자리를 몰라서인 것과 파일이 없어서인 것은 고치는
// 방법이 다르다.

/** 그림을 담을 자리와 이름표를 만든다. */
function embedDom(node) {
  const dom = document.createElement('span');
  dom.className = 'wiki-embed rdl-embed is-loading';
  dom.setAttribute('data-target', node.attrs.target);
  // 별칭이 있으면 이름표는 별칭이 되므로, 진짜 파일 이름은 툴팁이 갖는다.
  dom.title = node.attrs.target;

  const image = document.createElement('img');
  image.className = 'rdl-embed-image';
  image.alt = node.attrs.alias || node.attrs.target;
  // 안쪽 그림이 따로 끌리면 노드가 아니라 그림만 옮겨진다. 끌기는 바깥 노드의 일이다.
  image.draggable = false;

  const caption = document.createElement('span');
  caption.className = 'rdl-embed-caption';
  caption.textContent = node.attrs.alias || node.attrs.target;

  const note = document.createElement('span');
  note.className = 'rdl-embed-note';
  note.textContent = '불러오는 중…';

  dom.append(image, caption, note);
  return { dom, image, caption, note };
}

export class WikiLinkView {
  /**
   * @param {import('prosemirror-model').Node} node
   * @param {(name: string) => Promise<string|null>} resolve 자산 이름을 주소로
   */
  constructor(node, resolve) {
    this.node = node;
    this.resolve = resolve;
    // 요청마다 번호를 붙인다. 대상이 바뀌면 앞선 요청의 onload가 늦게 도착해 이미
    // 다른 그림이 된 자리에 옛 그림을 그릴 수 있다.
    this.token = 0;
    this.destroyed = false;

    if (!node.attrs.embed) {
      this.dom = document.createElement('span');
      this.dom.className = 'wiki-link';
      this.dom.setAttribute('data-target', node.attrs.target);
      this.dom.textContent = node.attrs.alias || node.attrs.target;
      return;
    }

    const parts = embedDom(node);
    this.dom = parts.dom;
    this.image = parts.image;
    this.caption = parts.caption;
    this.note = parts.note;
    this.load();
  }

  state(name, note) {
    this.dom.classList.remove('is-loading', 'is-ready', 'is-missing');
    this.dom.classList.add(name);
    this.note.textContent = note || '';
  }

  load() {
    const token = this.token + 1;
    this.token = token;
    const target = this.node.attrs.target;
    this.state('is-loading', '불러오는 중…');
    Promise.resolve()
      .then(() => this.resolve(target))
      .catch(() => null)
      .then((url) => {
        if (this.destroyed || token !== this.token) return;
        if (!url) {
          // 파일이 없는 것이 아니라 어디를 봐야 하는지를 모르는 것이다. 같은 말로
          // 적으면 사람은 없는 파일을 찾으러 간다.
          this.state('is-missing', '자산이 사는 자리를 알지 못했습니다');
          return;
        }
        this.image.onload = () => {
          if (this.destroyed || token !== this.token) return;
          this.state('is-ready', '');
        };
        this.image.onerror = () => {
          if (this.destroyed || token !== this.token) return;
          this.state('is-missing', '그림을 받지 못했습니다');
        };
        this.image.src = url;
      });
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    // embed가 뒤집히면 모양이 통째로 다르다. 고쳐 쓰는 것보다 다시 만드는 편이 낫다.
    if (node.attrs.embed !== this.node.attrs.embed) return false;
    const moved = node.attrs.target !== this.node.attrs.target;
    this.node = node;
    this.dom.setAttribute('data-target', node.attrs.target);
    if (!node.attrs.embed) {
      this.dom.textContent = node.attrs.alias || node.attrs.target;
      return true;
    }
    this.dom.title = node.attrs.target;
    this.caption.textContent = node.attrs.alias || node.attrs.target;
    this.image.alt = node.attrs.alias || node.attrs.target;
    if (moved) this.load();
    return true;
  }

  // 그림이 도착하면 DOM이 바뀐다. 알려 주지 않으면 ProseMirror가 그것을 사람의 편집으로
  // 읽어 문서를 DOM에서 다시 만든다 — atom의 안쪽은 문서에 없으므로 그 순간 노드가 깨진다.
  ignoreMutation() {
    return true;
  }

  destroy() {
    this.destroyed = true;
    if (!this.image) return;
    this.image.onload = null;
    this.image.onerror = null;
  }
}
