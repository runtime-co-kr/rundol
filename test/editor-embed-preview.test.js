'use strict';

// 편집기 안에서 `![[…]]`가 그림으로 보이는지 본다.
//
// 이 시험이 있는 이유는 실측이다. 붙여넣기 업로드가 고쳐진 뒤에도 편집기 안에서는
// `<span class="wiki-embed">한글-그림.png</span>` — 파일 이름 글자만 떴다. 저장하고
// 읽기 화면으로 나가야 그림이 보였으므로, 붙여넣은 사람은 자기가 무엇을 넣었는지
// 저장 전에는 볼 수 없었다. 그 자리에서 확인할 수 없으면 잘못 넣은 것을 되돌리는
// 일이 저장 뒤로 밀린다.
//
// 여기서 재는 것은 네 가지다.
//
//   1. 자산 embed는 <img>가 되고 문서 참조는 글자로 남는가 — 가르는 기준은 `!`다
//   2. 못 받은 그림이 받은 그림과 다르게 보이는가 (빈 자리는 둘을 가르지 못한다)
//   3. 미리보기를 붙였다고 저장되는 문자열이 달라지지 않는가
//   4. 지우고 되돌렸을 때 노드도 미리보기도 그대로 돌아오는가
//
// jsdom은 그림을 실제로 받지 않는다. 그래서 주소를 만드는 곳까지는 진짜 코드가 돌고,
// 받았다/못 받았다는 load·error 이벤트를 직접 일으켜 가른다. 실제로 받는 것은 브라우저
// 확인이 보고, 이 층이 보는 것은 "무엇을 받으려 했고 그 결과를 어떻게 보이는가"다.

const assert = require('assert');
const { installDom, loadEditorModule: load } = require('./editor-dom');

const SOURCE = [
  '# 제목',
  '',
  '올린 그림: ![[한글-그림.png]]',
  '',
  '없는 그림: ![[없는-그림.png]]',
  '',
  '자리를 모르는 그림: ![[자리없음.png]]',
  '',
  '별칭 그림: ![[한글-그림.png|도표 1]]',
  '',
  '문서 참조: [[project#^MEMBER-001|강영준]]',
  '',
  '없는 문서: [[REQ-999]]'
].join('\n');

// 자산 디렉터리를 아는 자리를 흉내 낸다. 실제 구현(asset-url.mjs)은 스냅숏에 묻고,
// 묻지 못하면 null을 돌려준다 — `자리없음.png`가 그 갈래를 밟는다.
async function assetUrl(name) {
  if (name === '자리없음.png') return null;
  return `/api/projects/demo/assets/docs/assets/${encodeURIComponent(name)}`;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function embedsIn(mount) {
  return [...mount.querySelectorAll('.wiki-embed')];
}

function stateOf(element) {
  for (const name of ['is-loading', 'is-ready', 'is-missing']) {
    if (element.classList.contains(name)) return name;
  }
  return null;
}

async function main() {
  const { JSDOM } = require('jsdom');
  const window = installDom(JSDOM);

  const { openEditor } = await load('index.mjs');
  const mount = window.document.getElementById('surface');

  const handle = openEditor(mount, SOURCE, {
    assetUrl,
    linkCandidates: [{ id: 'MEMBER-001', title: '강영준', target: 'project#^MEMBER-001', kind: 'member' }]
  });

  try {
    // ── 1. 무엇이 그림이고 무엇이 글자인가 ──────────────────────────────
    const embeds = embedsIn(mount);
    assert.strictEqual(embeds.length, 4, `자산 embed 4개가 그림 자리를 가져야 합니다 (본 것: ${embeds.length})`);
    for (const embed of embeds) {
      assert.ok(embed.querySelector('img'), `${embed.getAttribute('data-target')}에 <img>가 없습니다 — 글자만 보이던 그때와 같습니다`);
    }

    const links = [...mount.querySelectorAll('.wiki-link')];
    assert.strictEqual(links.length, 2, '문서 참조 2건은 글자로 남아야 합니다');
    for (const link of links) {
      assert.strictEqual(link.querySelector('img'), null, '문서 참조를 그림으로 그리면 `[[REQ-001]]`이 깨진 그림이 됩니다');
    }

    // 별칭은 이름표가 되고, 진짜 파일 이름은 툴팁이 갖는다. 별칭만 남으면 어떤
    // 파일인지 알 수 없고, 별칭을 버리면 사람이 붙인 설명이 사라진다.
    const aliased = embeds.find((embed) => embed.querySelector('.rdl-embed-caption').textContent === '도표 1');
    assert.ok(aliased, '별칭이 이름표가 되어야 합니다');
    assert.strictEqual(aliased.getAttribute('title'), '한글-그림.png', '별칭 뒤의 파일 이름을 볼 자리가 있어야 합니다');

    // ── 2. 기다리는 중 · 받음 · 못 받음이 서로 달라야 한다 ───────────────
    // 주소를 묻는 일은 비동기다. 처음 그릴 때는 아직 아무것도 받지 않았다.
    const target = (name) => embeds.find((embed) => embed.getAttribute('data-target') === name);
    assert.strictEqual(stateOf(target('한글-그림.png')), 'is-loading', '주소를 받기 전에는 기다리는 중이어야 합니다');

    await tick();
    await tick();

    const ok = target('한글-그림.png');
    assert.strictEqual(
      ok.querySelector('img').getAttribute('src'),
      '/api/projects/demo/assets/docs/assets/%ED%95%9C%EA%B8%80-%EA%B7%B8%EB%A6%BC.png',
      '자산 주소는 밖에서 받은 해석기가 만든 그대로여야 합니다'
    );

    // 자리를 알아내지 못한 것은 파일이 없는 것과 다르다. 같은 말로 적으면 사람은
    // 없는 파일을 찾으러 간다.
    const unknown = target('자리없음.png');
    assert.strictEqual(stateOf(unknown), 'is-missing', '자산이 사는 자리를 모르면 그 사실이 보여야 합니다');
    assert.strictEqual(unknown.querySelector('.rdl-embed-note').textContent, '자산이 사는 자리를 알지 못했습니다');
    assert.strictEqual(unknown.querySelector('img').getAttribute('src'), null, '주소를 모르면서 주소를 지어내면 안 됩니다');

    ok.querySelector('img').dispatchEvent(new window.Event('load'));
    assert.strictEqual(stateOf(ok), 'is-ready', '받은 그림은 받았다고 보여야 합니다');
    assert.strictEqual(ok.querySelector('.rdl-embed-note').textContent, '', '받은 뒤에는 안내가 남으면 안 됩니다');

    const gone = target('없는-그림.png');
    gone.querySelector('img').dispatchEvent(new window.Event('error'));
    assert.strictEqual(stateOf(gone), 'is-missing', '못 받은 그림은 빈 자리가 아니라 못 받았다고 보여야 합니다');
    assert.strictEqual(gone.querySelector('.rdl-embed-note').textContent, '그림을 받지 못했습니다');
    // 이름이 남아야 어느 그림이 없는지 알 수 있다.
    assert.strictEqual(gone.querySelector('.rdl-embed-caption').textContent, '없는-그림.png');

    // ── 3. 대상이 없는 링크 표시는 문서 참조의 일이다 ────────────────────
    // 후보 목록은 문서와 구성원이고 그림은 둘 다 아니다. 가르지 않으면 올바르게
    // 넣은 그림까지 전부 "대상 없음"으로 붉어진다 — 실측에서 embed 3건이 그랬다.
    const unresolved = [...mount.querySelectorAll('.is-unresolved')];
    assert.strictEqual(unresolved.length, 1, `대상 없는 표시는 문서 참조 1건에만 붙어야 합니다 (본 것: ${unresolved.length})`);
    assert.ok(unresolved[0].classList.contains('wiki-link'), '자산 embed에 대상 없음 표시가 붙으면 안 됩니다');
    assert.strictEqual(unresolved[0].getAttribute('data-target'), 'REQ-999');

    // ── 4. 저장되는 문자열은 그대로다 ────────────────────────────────────
    assert.strictEqual(handle.getMarkdown(), SOURCE, '미리보기를 붙였다고 저장될 본문이 달라지면 안 됩니다');

    // ── 5. 지우기와 되돌리기 ────────────────────────────────────────────
    const { view } = handle;
    const wikiLink = view.state.schema.nodes.wiki_link;
    let at = null;
    view.state.doc.descendants((node, pos) => {
      if (at === null && node.type === wikiLink && node.attrs.embed && node.attrs.target === '한글-그림.png') at = pos;
    });
    assert.notStrictEqual(at, null, '자산 embed 노드를 찾지 못했습니다');

    // atom이므로 한 자리를 지우면 통째로 사라진다. 가운데만 지워지면 안 된다.
    view.dispatch(view.state.tr.delete(at, at + 1));
    assert.strictEqual(embedsIn(mount).length, 3, '지운 그림이 화면에 남아 있습니다');
    assert.ok(!handle.getMarkdown().includes('올린 그림: ![[한글-그림.png]]'), '지웠는데 본문에 남아 있습니다');

    const { undo } = await import('prosemirror-history');
    undo(view.state, view.dispatch);
    assert.strictEqual(handle.getMarkdown(), SOURCE, '되돌린 뒤의 본문이 원문과 다릅니다');

    await tick();
    await tick();
    const restored = embedsIn(mount);
    assert.strictEqual(restored.length, 4, '되돌린 뒤 그림 자리가 돌아오지 않았습니다');
    const back = restored.find((embed) => embed.getAttribute('data-target') === '한글-그림.png');
    assert.ok(back && back.querySelector('img'), '되돌린 그림에 <img>가 없습니다');
    assert.strictEqual(
      back.querySelector('img').getAttribute('src'),
      '/api/projects/demo/assets/docs/assets/%ED%95%9C%EA%B8%80-%EA%B7%B8%EB%A6%BC.png',
      '되돌린 그림이 주소를 다시 잡지 못했습니다'
    );

    // ── 6. 대상이 바뀌면 그림도 바뀐다 ──────────────────────────────────
    let movable = null;
    view.state.doc.descendants((node, pos) => {
      if (movable === null && node.type === wikiLink && node.attrs.embed && node.attrs.target === '없는-그림.png') movable = pos;
    });
    view.dispatch(view.state.tr.setNodeMarkup(movable, undefined, { target: '바뀐-그림.png', alias: null, embed: true }));
    await tick();
    await tick();
    const moved = embedsIn(mount).find((embed) => embed.getAttribute('data-target') === '바뀐-그림.png');
    assert.ok(moved, '대상을 바꾼 그림을 찾지 못했습니다');
    assert.strictEqual(
      moved.querySelector('img').getAttribute('src'),
      '/api/projects/demo/assets/docs/assets/%EB%B0%94%EB%80%90-%EA%B7%B8%EB%A6%BC.png',
      '대상이 바뀌었는데 옛 주소를 그대로 봅니다'
    );
    assert.strictEqual(stateOf(moved), 'is-loading', '새 대상은 다시 기다리는 중이어야 합니다');

    process.stdout.write('editor embed preview tests passed\n');
  } finally {
    handle.destroy();
  }
}

module.exports = main();
