// 편집기 조립. 화면에 붙는 유일한 진입점이다.
//
// 여기까지 오면 모델 계층(schema·from-markdown·to-markdown)은 이미 정본 문서
// 전체로 검증되어 있다. 이 파일이 더하는 것은 ProseMirror의 EditorView와
// 편집 명령뿐이고, 저장 규칙은 to-markdown이 그대로 갖는다.

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, chainCommands, exitCode } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import { gapCursor } from 'prosemirror-gapcursor';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { tableEditing, columnResizing, goToNextCell } from 'prosemirror-tables';

import { schema } from './schema.mjs';
import { fromMarkdown } from './from-markdown.mjs';
import { toMarkdown } from './to-markdown.mjs';
import { blockHandle } from './block-handle.mjs';
import { slashMenu } from './slash-menu.mjs';
import { rundolInputRules } from './input-rules.mjs';
import { linkPicker } from './link-picker.mjs';
import { toolbar } from './toolbar.mjs';
import { placeholder } from './placeholder.mjs';
import { ListItemView } from './list-item-view.mjs';
import { tableControls } from './table-controls.mjs';

function hardBreak(state, dispatch) {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
  return true;
}

// 목록에서 엔터를 치면 같은 종류의 항목이 이어져야 한다.
//
// splitListItem은 새 항목을 만들지만 attrs를 물려주지 않는다. 그래서 체크 목록에서
// 엔터를 치면 다음 줄이 `- [ ]`가 아니라 `-`가 되어, 수용 기준을 쓰다가 한 줄만
// 체크 상자를 잃는다. itemAttrs 인자는 이 버전에서 새 항목에 닿지 않으므로
// 나뉜 뒤에 직접 붙인다.
function splitListItemKeepingKind(state, dispatch) {
  const item = state.selection.$from.node(-1);
  const wasTask = item && item.type === schema.nodes.list_item && item.attrs.checked !== null;
  return splitListItem(schema.nodes.list_item)(state, (tr) => {
    if (wasTask) {
      const $pos = tr.selection.$from;
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        if ($pos.node(depth).type !== schema.nodes.list_item) continue;
        // 새 항목은 아직 끝나지 않은 일이다. 체크된 채로 시작하면 안 된다.
        tr.setNodeMarkup($pos.before(depth), undefined, { checked: false });
        break;
      }
    }
    if (dispatch) dispatch(tr.scrollIntoView());
  });
}

function editorKeymap() {
  return {
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-`': toggleMark(schema.marks.code),
    // 빈 항목에서는 나뉘지 않는다. 그때는 목록에서 빠져나오는 것이 사람이 기대하는
    // 동작이다 — 목록을 끝내려고 엔터를 두 번 치는 손버릇이 그것이다.
    Enter: chainCommands(splitListItemKeepingKind, liftListItem(schema.nodes.list_item)),
    'Shift-Enter': chainCommands(exitCode, hardBreak),
    Tab: goToNextCell(1),
    'Shift-Tab': goToNextCell(-1),
    'Mod-[': liftListItem(schema.nodes.list_item),
    'Mod-]': sinkListItem(schema.nodes.list_item)
  };
}

/**
 * 문서 편집기를 연다.
 *
 * @param {HTMLElement} mount 편집기가 들어갈 자리
 * @param {string} markdown 정본 문서의 본문 (frontmatter 제외)
 * @param {{onChange?: (info: {markdown: string, preserved: number, reserialized: number}) => void}} options
 */
export function openEditor(mount, markdown, options = {}) {
  // sources는 이 편집 세션 내내 살아 있어야 한다. 다시 만들면 그 순간 모든 블록이
  // "고친 것"이 되어 원문 보존이 사라진다.
  const { doc, sources, unknown } = fromMarkdown(markdown);

  const view = new EditorView(mount, {
    state: EditorState.create({
      doc,
      plugins: [
        history(),
        // 입력 규칙이 단축키보다 먼저다. `- ` 같은 손버릇은 키맵이 가로채기 전에
        // 걸려야 한다.
        rundolInputRules(),
        keymap(editorKeymap()),
        keymap(baseKeymap),
        gapCursor(),
        columnResizing(),
        tableEditing(),
        blockHandle(),
        slashMenu(),
        // 링크 후보는 밖에서 받는다. 편집기가 저장소를 읽으면 브라우저에서 돌 수 없고,
        // 보드는 이미 그 목록을 스냅샷으로 갖고 있다.
        linkPicker({ candidates: options.linkCandidates || [] }),
        toolbar(),
        placeholder(),
        tableControls()
      ]
    }),
    // 체크 상자를 눌러 상태를 바꾸려면 항목이 자기 DOM을 가져야 한다.
    nodeViews: {
      list_item: (node, editorView, getPos) => new ListItemView(node, editorView, getPos)
    },
    dispatchTransaction(transaction) {
      view.updateState(view.state.apply(transaction));
      if (options.onChange) options.onChange(current());
    }
  });

  function current() {
    return toMarkdown(view.state.doc, sources);
  }

  return {
    view,
    unknown,
    /** 저장할 markdown. 손대지 않은 블록은 원문 그대로 돌아온다. */
    getMarkdown: () => current().markdown,
    /** 몇 블록이 원문 그대로이고 몇 블록이 다시 써졌는지. 시험과 화면 표시에 쓴다. */
    stats: () => { const { preserved, reserialized } = current(); return { preserved, reserialized }; },
    destroy: () => view.destroy()
  };
}

export { schema, fromMarkdown, toMarkdown };
