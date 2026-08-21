'use strict';

// 블록 손잡이로 옮긴 블록이 어디에 어떤 모양으로 놓이는지 본다.
//
// 규칙이 두 겹이다. 어느 자리를 고르는가(chooseSpot)와, 고른 자리에 놓으면 문서가
// 무엇이 되는가(planMove). 앞의 것은 화면 좌표를 받지만 계산 자체는 순수하고, 뒤의
// 것은 화면과 아무 상관이 없다. 그래서 둘 다 브라우저 없이 볼 수 있다.
//
// 이 시험이 있는 이유는 이 규칙이 눈으로 확인되지 않기 때문이다. 브라우저에서 보이는
// 것은 "표시선이 어디 떴는가"까지다. 번호 목록에서 꺼낸 항목이 불릿이 되었는지, 빈
// 목록 껍데기가 남았는지, 손대지 않은 블록이 다시 써졌는지는 저장한 뒤 diff에서야
// 드러난다. 그때는 이미 정본 문서가 상해 있고, rdl check는 그것을 오류로 보지 않는다.
//
// 편집기 모듈은 remark(ESM 전용)에 기대므로 .mjs다. CI가 Node 20이라 require로는 못
// 읽고 동적 import를 쓴다. 그래서 이 파일은 promise를 내보내고 run.js가 기다린다.

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');

function load(name) {
  return import(pathToFileURL(path.join(root, 'src', 'board-ui', 'editor', name)).href);
}

/** 문서 안에서 그 글로 시작하는 노드의 위치. */
function locate(doc, typeName, text) {
  let hit = null;
  doc.descendants((node, pos) => {
    if (hit !== null) return false;
    if (node.type.name === typeName && node.textContent.startsWith(text)) { hit = pos; return false; }
    return true;
  });
  assert.notStrictEqual(hit, null, `${typeName}(${text})를 찾지 못했습니다`);
  return hit;
}

/** 그 노드 뒤 경계. 목록 항목이든 최상위 블록이든 같은 방식으로 잡는다. */
function behind(doc, typeName, text) {
  const pos = locate(doc, typeName, text);
  return pos + doc.nodeAt(pos).nodeSize;
}

async function main() {
  const { fromMarkdown } = await load('from-markdown.mjs');
  const { toMarkdown } = await load('to-markdown.mjs');
  const { chooseSpot, moveBlock } = await load('block-handle.mjs');
  const { EditorState } = await import('prosemirror-state');

  // 편집기를 여는 것과 같은 상태를 만든다. sources는 편집 세션 내내 살아 있어야
  // 하므로 여기서도 한 번만 만든다 — 다시 만들면 모든 블록이 "고친 것"이 된다.
  function open(markdown) {
    const { doc, sources } = fromMarkdown(markdown);
    let state = EditorState.create({ doc });
    const view = {
      get state() { return state; },
      dispatch(tr) { state = state.apply(tr); },
      focus() {}
    };
    return { view, out: () => toMarkdown(view.state.doc, sources) };
  }

  // ── 놓은 뒤의 문서 ────────────────────────────────────────────

  // 1. 최상위 블록의 순서. 가장 흔한 일이고, 원문 보존이 여기서 깨지면 diff가 죽는다.
  {
    const { view, out } = open('첫째\n\n둘째\n\n셋째\n');
    const first = locate(view.state.doc, 'paragraph', '첫째');
    assert.ok(moveBlock(view, first, behind(view.state.doc, 'paragraph', '셋째')));
    assert.strictEqual(out().markdown, '둘째\n\n셋째\n\n첫째');
    assert.strictEqual(out().reserialized, 0, '옮기기만 했는데 다시 써진 블록이 있습니다');
  }

  // 2. 제자리에 놓기. 지웠다 같은 자리에 넣는 트랜잭션이 되면 손대지 않은 블록이
  //    "고친 것"이 되어, 옮기다 만 것만으로 문서 전체가 다시 써진다.
  {
    const { view, out } = open('첫째\n\n둘째\n');
    const before = out().markdown;
    const first = locate(view.state.doc, 'paragraph', '첫째');
    assert.strictEqual(moveBlock(view, first, first), false);
    assert.strictEqual(out().markdown, before);
    assert.strictEqual(out().reserialized, 0);
  }

  // 3. 목록 항목은 항목 하나가 옮기는 단위다.
  {
    const { view, out } = open('- 하나\n- 둘\n- 셋\n');
    const one = locate(view.state.doc, 'list_item', '하나');
    assert.ok(moveBlock(view, one, behind(view.state.doc, 'list_item', '셋')));
    assert.strictEqual(out().markdown, '- 둘\n- 셋\n- 하나');
  }

  // 4. 들여쓰기. 앞 항목의 내용 끝에 놓으면 그 항목의 자식이 된다 — 목록이 아직
  //    없으므로 놓는 쪽이 목록을 만든다.
  {
    const { view, out } = open('- 하나\n- 둘\n');
    const one = locate(view.state.doc, 'list_item', '하나');
    const two = locate(view.state.doc, 'list_item', '둘');
    assert.ok(moveBlock(view, two, one + view.state.doc.nodeAt(one).nodeSize - 1));
    assert.strictEqual(out().markdown, '- 하나\n  - 둘');
  }

  // 5. 내어쓰기. 목록 밖으로 나온 항목은 항목일 수 없으므로 목록 껍데기를 되씌운다.
  {
    const { view, out } = open('- 하나\n  - 둘\n\n끝\n');
    const two = locate(view.state.doc, 'list_item', '둘');
    assert.ok(moveBlock(view, two, behind(view.state.doc, 'paragraph', '끝')));
    assert.strictEqual(out().markdown, '- 하나\n\n끝\n\n- 둘');
  }

  // 6. 되씌우는 껍데기는 원래 목록의 종류를 따른다. 번호 목록에서 꺼낸 항목이
  //    불릿이 되면 그것은 옮긴 것이 아니라 고친 것이다.
  {
    const { view, out } = open('1. 하나\n2. 둘\n\n끝\n');
    const two = locate(view.state.doc, 'list_item', '둘');
    assert.ok(moveBlock(view, two, behind(view.state.doc, 'paragraph', '끝')));
    assert.match(out().markdown, /^1\. 하나\n\n끝\n\n1\. 둘$/);
  }

  // 7. 항목 하나뿐인 목록을 비우면 껍데기까지 지운다. 빈 목록은 스키마가 인정하지
  //    않을 뿐 아니라, 남으면 문서에 빈 불릿 한 줄로 나타난다.
  {
    const { view, out } = open('- 하나\n\n끝\n');
    const one = locate(view.state.doc, 'list_item', '하나');
    assert.ok(moveBlock(view, one, behind(view.state.doc, 'paragraph', '끝')));
    assert.strictEqual(out().markdown, '끝\n\n- 하나');
    let lists = 0;
    view.state.doc.descendants((node) => { if (node.type.name === 'bullet_list') lists += 1; });
    assert.strictEqual(lists, 1, '빈 목록 껍데기가 남았습니다');
  }

  // 8. 목록 안으로 들어간 문단은 항목이 된다. 맞추지 않고 넣으면 스키마가 거절한다.
  {
    const { view, out } = open('- 하나\n\n바깥\n');
    const outside = locate(view.state.doc, 'paragraph', '바깥');
    assert.ok(moveBlock(view, outside, behind(view.state.doc, 'list_item', '하나')));
    assert.strictEqual(out().markdown, '- 하나\n- 바깥');
  }

  // 9. 체크 상태는 항목의 attrs다. 옮기다 잃으면 수용 기준의 증거가 사라진다.
  {
    const { view, out } = open('- [x] 끝난 일\n- [ ] 남은 일\n');
    const done = locate(view.state.doc, 'list_item', '끝난 일');
    assert.ok(moveBlock(view, done, behind(view.state.doc, 'list_item', '남은 일')));
    assert.strictEqual(out().markdown, '- [ ] 남은 일\n- [x] 끝난 일');
  }

  // ── 어느 자리를 고르는가 ──────────────────────────────────────
  //
  // 아래 좌표는 목록 하나를 손으로 그린 것이다. 항목 셋, 그중 "둘" 아래에 자식 목록.
  // 한 경계(y=184)에 층이 셋 있다는 것이 이 계산이 있는 이유 전부다.
  //
  //   y=100  ul         left=118
  //   y=100    li 하나  left=158
  //   y=128    li 둘    left=158
  //   y=156      ul     left=158
  //   y=156        li 가 left=198
  //   y=184    li 셋    left=158
  const RIGHT = 700;
  const spots = [
    { pos: 0, left: 118, width: RIGHT - 118, y: 100 },
    { pos: 1, left: 158, width: RIGHT - 158, y: 100 },
    { pos: 10, left: 158, width: RIGHT - 158, y: 128 },
    { pos: 20, left: 198, width: RIGHT - 198, y: 156 },
    { pos: 30, left: 198, width: RIGHT - 198, y: 184 }, // 자식 층
    { pos: 40, left: 158, width: RIGHT - 158, y: 184 }, // 형제 층
    { pos: 50, left: 118, width: RIGHT - 118, y: 184 }, // 최상위 층
    { pos: 60, left: 158, width: RIGHT - 158, y: 212 }
  ];
  const anywhere = () => true;

  // 10. 같은 높이에서 층을 고르는 것은 x다. 왼쪽일수록 얕고 오른쪽일수록 깊다.
  assert.strictEqual(chooseSpot(spots, 120, 184, anywhere).pos, 50, '왼쪽 끝에서 최상위 층이 아닙니다');
  assert.strictEqual(chooseSpot(spots, 158, 184, anywhere).pos, 40, '항목 왼쪽에서 형제 층이 아닙니다');
  assert.strictEqual(chooseSpot(spots, 210, 184, anywhere).pos, 30, '오른쪽에서 자식 층이 아닙니다');

  // 11. 글줄 위에서도 층이 잡혀야 한다. 여백에서만 되면 사람은 끌던 손을 왼쪽 밖으로
  //     빼야 하고, 그 자리에는 아무 표시도 없다.
  assert.strictEqual(chooseSpot(spots, 600, 184, anywhere).pos, 30, '글줄 오른쪽 끝에서 깊은 층이 잡히지 않습니다');

  // 12. 높이가 먼저다. 층을 고르려고 오른쪽으로 민 것이 한 줄 위 틈으로 뛰면,
  //     들여쓰기를 고르려던 손이 자리를 잃는다.
  assert.strictEqual(chooseSpot(spots, 600, 128, anywhere).pos, 10, '오른쪽으로 밀었더니 다른 틈으로 뛰었습니다');

  // 13. 놓을 수 없는 자리는 후보가 아니다. 표시선과 실제 놓기가 같은 판단을 보아야
  //     "선은 떴는데 놓아도 안 옮겨진다"가 없다.
  assert.strictEqual(chooseSpot(spots, 210, 184, (pos) => pos !== 30).pos, 40);
  assert.strictEqual(chooseSpot(spots, 200, 184, () => false), null);

  // 14. 표시선은 고른 후보의 가로 범위를 그대로 쓴다. 그것이 층을 보여 주는 유일한
  //     방법이다 — 선이 언제나 왼쪽 끝에서 시작하면 어느 층인지 볼 수 없다.
  const deep = chooseSpot(spots, 210, 184, anywhere);
  assert.strictEqual(deep.left, 198);
  assert.strictEqual(deep.width, RIGHT - 198);
  assert.strictEqual(chooseSpot(spots, 120, 184, anywhere).left, 118);

  process.stdout.write('editor block move tests passed (문서 규칙 9종, 자리 고르기 5종)\n');
}

module.exports = main();
