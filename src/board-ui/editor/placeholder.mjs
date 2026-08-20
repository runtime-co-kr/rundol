// 빈 블록 안내 — 커서가 놓인 빈 블록에 무엇을 쓰는 자리인지 적는다.
//
// Crepe도 같은 방식이다: 떠다니는 UI가 아니라 Decoration으로 클래스와 data 속성을
// 붙이고 CSS `::before`가 글자를 그린다. 문서에 글자를 넣지 않는다는 점이 중요하다 —
// 넣으면 그것이 선택·복사·직렬화를 전부 만난다.
//
// 런돌은 여기에 한 걸음 더 간다. 계약 문서는 절마다 쓰는 것이 정해져 있으므로,
// 바로 위 제목을 보고 안내문을 바꾼다. `#### 수용 기준` 아래 빈 줄에는 "무엇이
// 참이어야 하는지"라고 적히는 편이 "내용을 입력하세요"보다 낫다.

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const placeholderKey = new PluginKey('rundol-placeholder');

// 정본 문서의 절 이름에서 뽑았다. 없는 이름은 기본 문구를 쓴다.
const BY_HEADING = new Map(Object.entries({
  '배경': '왜 이 문서가 필요한지',
  '요구사항': '무엇이 되어야 하는지',
  '사전조건': '무엇이 갖춰져 있어야 하는지',
  '동작 규칙': '어떤 순서로 판정하는지',
  '상태와 예외': '어떤 상황에서 무엇이 되는지',
  '수용 기준': '무엇이 참이어야 하는지',
  '비기능 요구': '어떤 품질을 어떻게 재는지',
  '제외 범위': '이 문서가 다루지 않는 것',
  '입력': '무엇을 받는지',
  '출력': '무엇을 돌려주는지',
  '업무 규칙': '어떤 규칙으로 판단하는지',
  '상태와 전이': '어떤 상태가 무엇으로 바뀌는지',
  '권한과 승인': '누가 할 수 있는지',
  '정상·오류·취소': '세 갈래로 무엇이 일어나는지',
  '감사 기록': '무엇이 남는지',
  '엔티티': '어떤 것을 저장하는지',
  '관계': '무엇이 무엇을 가리키는지',
  '불변조건': '언제나 참이어야 하는 것',
  '결정 기준': '무엇을 보고 골랐는지',
  '선택지': '어떤 안들을 놓고 비교했는지',
  '결정': '무엇으로 정했는지',
  '결과': '그래서 무엇이 달라지는지',
  '시나리오': '어떤 경로를 밟는지',
  '통과 기준': '무엇이 참이면 통과인지'
}));

const DEFAULT_TEXT = '내용을 쓰거나 슬래시로 블록을 넣습니다';

function headingAbove(doc, index) {
  for (let at = index - 1; at >= 0; at -= 1) {
    const node = doc.child(at);
    if (node.type.name === 'heading') return node.textContent.trim();
  }
  return null;
}

export function placeholder() {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state) {
        const { selection } = state;
        // 커서만 있을 때다. 범위를 고른 상태에서 안내가 뜨면 지우려는 사람을 방해한다.
        if (!selection.empty) return null;
        const $from = selection.$from;
        // 최상위 블록에서만. 목록 항목이나 표 셀마다 안내가 뜨면 문서가 안내로 덮인다.
        if ($from.depth !== 1) return null;
        const parent = $from.parent;
        if (!parent.isTextblock || parent.content.size > 0) return null;
        if (parent.type.spec.code) return null;

        const index = $from.index(0);
        const heading = headingAbove(state.doc, index);
        const text = (heading && BY_HEADING.get(heading)) || DEFAULT_TEXT;
        const before = $from.before(1);
        return DecorationSet.create(state.doc, [
          Decoration.node(before, before + parent.nodeSize, { class: 'rdl-placeholder', 'data-placeholder': text })
        ]);
      }
    }
  });
}
