'use strict';

// 살아 있는 편집기에 트랜잭션을 넣어 본다.
//
// 이 시험이 있는 이유는 실제로 나간 결함 하나다. toolbar의 shouldShow가 view에서
// hasFocus를 구조 분해로 떼어 내 불렀다. this를 잃어 그 자리에서 던지는데, 이 함수는
// 트랜잭션마다 불린다. 문서는 이미 갱신된 뒤라 타이핑은 멀쩡해 보였고, 던진 예외는
// dispatch를 부른 쪽의 남은 일을 대신 죽였다. 블록 손잡이의 끌기가 그렇게 죽었다.
//
// 그때 있던 headless 확인은 열고·직렬화하고·닫는 것까지였다. 트랜잭션을 한 번도
// 일으키지 않았으므로 플러그인의 update()가 아예 돌지 않았고, 그래서 아무것도 잡지
// 못하면서 "편집기가 산다"를 확인한 것처럼 보였다.
//
// 그래서 여기서 보는 것은 문서가 무엇이 되는가가 아니다. 그것은 editor-roundtrip과
// editor-block-move가 본다. 여기서 보는 것은 **어떤 플러그인도 던지지 않는가**이다.
// 화면 없이 확인할 수 있는 마지막 층이고, 이 층이 비어 있으면 다음 결함도 브라우저를
// 열어 본 사람만 알게 된다.

const assert = require('assert');
const { installDom, loadEditorModule: load } = require('./editor-dom');

// 정본 문서가 실제로 쓰는 것을 한 문서에 모았다. 플러그인마다 다른 노드에서 도는
// 코드가 있으므로, 표나 목록이 없는 문서로는 그 코드가 한 번도 돌지 않는다.
const SOURCE = [
  '# 제목',
  '',
  '첫 문단이다. 담당은 [[project#^MEMBER-001|강영준]]이고 자산은 ![[diagram.png]]다.',
  '',
  '## 요구사항',
  '',
  '- 하나',
  '- [ ] 아직',
  '- [x] 마침',
  '',
  '| 코드 | 역할 |',
  '|---|---|',
  '| PRD | 제품 목표 |',
  '',
  '```mermaid',
  'erDiagram',
  '    A ||--o{ B : "가짐"',
  '```',
  '',
  '> 인용문이다.',
  '',
  '---'
].join('\n');

async function main() {
  const { JSDOM } = require('jsdom');
  installDom(JSDOM);

  const { openEditor } = await load('index.mjs');
  const { schema } = await load('schema.mjs');
  const { TextSelection, NodeSelection } = await import('prosemirror-state');

  const mount = global.document.getElementById('surface');
  const handle = openEditor(mount, SOURCE, {
    linkCandidates: [{ id: 'MEMBER-001', title: '강영준', target: 'project#^MEMBER-001', alias: '강영준', kind: 'member' }],
    contractSections: ['배경', '요구사항', '수용 기준']
  });

  try {
    assert.deepStrictEqual(handle.unknown, [], `스키마가 모르는 mdast 유형이 있습니다: ${handle.unknown.join(', ')}`);
    assert.strictEqual(handle.getMarkdown(), SOURCE, '열자마자 본문이 달라졌습니다');

    const { view } = handle;

    // 트랜잭션 하나하나가 모든 플러그인의 update()를 돌린다. 어느 하나가 던지면
    // 그 자리에서 이 시험이 멈춘다 — 그것이 이 시험의 전부다.
    const steps = [
      ['문단에 글자 넣기', () => {
        const at = findTextblock(view.state.doc, '첫 문단이다');
        return view.state.tr.insertText('!', at + 1);
      }],
      ['커서를 문단 안으로', () => {
        const at = findTextblock(view.state.doc, '첫 문단이다');
        return view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 2));
      }],
      ['범위를 고르기 — 툴바가 뜨는 조건', () => {
        const at = findTextblock(view.state.doc, '첫 문단이다');
        return view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1, at + 5));
      }],
      ['블록을 통째로 고르기 — 손잡이가 쓰는 선택', () => {
        let pos = null;
        view.state.doc.forEach((node, offset) => { if (pos === null && node.type.name === 'paragraph') pos = offset; });
        return view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos));
      }],
      ['빈 문단 만들기 — 안내 문구가 도는 조건', () => {
        const end = view.state.doc.content.size;
        return view.state.tr.insert(end, schema.nodes.paragraph.create());
      }],
      ['빈 문단으로 커서 옮기기', () => {
        const at = view.state.doc.content.size - 1;
        return view.state.tr.setSelection(TextSelection.create(view.state.doc, at));
      }],
      ['표 칸 안으로 커서 옮기기', () => {
        const at = findTextblock(view.state.doc, 'PRD');
        return view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1));
      }],
      ['코드 블록 안으로 커서 옮기기', () => {
        const at = findTextblock(view.state.doc, 'erDiagram');
        return view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1));
      }],
      ['슬래시 치기 — 메뉴가 열리는 조건', () => {
        const end = view.state.doc.content.size;
        const tr = view.state.tr.insert(end, schema.nodes.paragraph.create());
        const at = tr.doc.content.size - 1;
        return tr.insertText('/', at).setSelection(TextSelection.create(tr.doc, at + 1));
      }],
      ['골뱅이 치기 — 링크 선택기가 열리는 조건', () => {
        const end = view.state.doc.content.size;
        const tr = view.state.tr.insert(end, schema.nodes.paragraph.create());
        const at = tr.doc.content.size - 1;
        return tr.insertText('@', at).setSelection(TextSelection.create(tr.doc, at + 1));
      }]
    ];

    for (const [label, make] of steps) {
      try {
        view.dispatch(make());
      } catch (error) {
        assert.fail(`"${label}"에서 플러그인이 던졌습니다: ${error && error.message}\n${error && error.stack}`);
      }
      // 던지지 않았다는 것만으로는 모자란다. 던진 뒤에도 살아 있는 척하는 상태가
      // 있을 수 있으므로, 매번 저장 경로가 여전히 도는지 함께 본다.
      assert.strictEqual(typeof handle.getMarkdown(), 'string', `"${label}" 뒤 저장 경로가 멈췄습니다`);
    }

    // 되돌리기도 트랜잭션이다. 편집한 뒤 한 번 밟아 본다.
    const { undo } = await import('prosemirror-history');
    try { undo(view.state, view.dispatch); } catch (error) {
      assert.fail(`되돌리기에서 플러그인이 던졌습니다: ${error && error.message}`);
    }

    const stats = handle.stats();
    assert.ok(stats.preserved + stats.reserialized > 0, '블록 수를 세지 못했습니다');

    process.stdout.write(`editor live tests passed (트랜잭션 ${steps.length + 1}종)\n`);
  } finally {
    handle.destroy();
  }
}

function findTextblock(doc, text) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock && node.textContent.includes(text)) { found = pos; return false; }
    return true;
  });
  assert.notStrictEqual(found, null, `본문에서 "${text}"를 찾지 못했습니다`);
  return found;
}

module.exports = main();
