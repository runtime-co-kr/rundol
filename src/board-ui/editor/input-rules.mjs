// 입력 규칙 — 마크다운을 치던 손버릇이 그대로 통하게 한다.
//
// 블록 메뉴가 있어도 사람은 `## `을 친다. 그 손버릇이 안 통하면 편집기가 마크다운을
// 다루는 물건이라는 감각이 깨지고, 메뉴를 매번 열게 되어 오히려 느려진다.
//
// 규칙은 정본 문서가 실제로 쓰는 문법으로 한정한다. 편집기가 문서에 없던 형태를
// 만들기 시작하면 그것이 곧 문서 표준이 되어 버린다.

import { InputRule, inputRules, wrappingInputRule, textblockTypeInputRule } from 'prosemirror-inputrules';
import { schema } from './schema.mjs';

// 마크용 규칙은 prosemirror-inputrules가 주지 않는다. 잡은 범위에서 표시 문자를
// 걷어내고 그 자리에 mark를 입힌다.
function markRule(pattern, markType) {
  return new InputRule(pattern, (state, match, start, end) => {
    const captured = match[match.length - 1];
    if (!captured) return null;
    const tr = state.tr;
    const textStart = start + match[0].indexOf(captured);
    const textEnd = textStart + captured.length;
    if (textEnd < end) tr.delete(textEnd, end);
    if (textStart > start) tr.delete(start, textStart);
    const to = start + captured.length;
    tr.addMark(start, to, markType.create());
    // 이어 치는 글자까지 굵어지면 안 된다. 규칙이 끝나는 자리에서 mark를 끊는다.
    tr.removeStoredMark(markType);
    return tr;
  });
}

// `- [ ] `과 `- [x] `. 목록으로 감싸면서 항목의 체크 상태까지 정해야 하므로
// wrappingInputRule 대신 직접 만든다.
function checkboxRule() {
  return new InputRule(/^\s*[-+*]\s\[([ xX])\]\s$/u, (state, match, start, end) => {
    const checked = match[1].toLowerCase() === 'x';
    const item = schema.nodes.list_item.create({ checked }, schema.nodes.paragraph.create());
    const list = schema.nodes.bullet_list.create(null, [item]);
    const tr = state.tr.delete(start, end).replaceSelectionWith(list);
    const inside = tr.doc.resolve(start + 2);
    return tr.setSelection(state.selection.constructor.near(inside));
  });
}

export function rundolInputRules() {
  return inputRules({
    rules: [
      // 블록 ---------------------------------------------------------
      // `# `부터 `###### `까지. 정본 문서는 기능 계약에서 4단계까지 쓴다.
      textblockTypeInputRule(/^(#{1,6})\s$/u, schema.nodes.heading, (match) => ({ level: match[1].length })),
      // 체크 목록이 일반 목록보다 먼저다. `- ` 규칙이 먼저 걸리면 `[ ]`를 칠 기회가 없다.
      checkboxRule(),
      wrappingInputRule(/^\s*([-+*])\s$/u, schema.nodes.bullet_list),
      wrappingInputRule(/^(\d+)\.\s$/u, schema.nodes.ordered_list,
        (match) => ({ start: Number(match[1]) }),
        (match, node) => node.childCount + node.attrs.start === Number(match[1])),
      wrappingInputRule(/^\s*>\s$/u, schema.nodes.blockquote),
      textblockTypeInputRule(/^```([a-zA-Z0-9+-]*)\s$/u, schema.nodes.code_block, (match) => ({ lang: match[1] || '' })),
      new InputRule(/^(?:---|\*\*\*|___)\s$/u, (state, match, start, end) =>
        state.tr.delete(start, end).replaceSelectionWith(schema.nodes.horizontal_rule.create())),

      // 마크 ---------------------------------------------------------
      // 굵게가 기울임보다 먼저다. `**a**`를 기울임 규칙이 먼저 보면 `*` 하나만 먹는다.
      markRule(/(?:^|[^*])\*\*([^*]+)\*\*$/u, schema.marks.strong),
      markRule(/(?:^|[^*])\*([^*]+)\*$/u, schema.marks.em),
      markRule(/(?:^|[^~])~~([^~]+)~~$/u, schema.marks.strike),
      markRule(/(?:^|[^`])`([^`]+)`$/u, schema.marks.code)
    ]
  });
}
