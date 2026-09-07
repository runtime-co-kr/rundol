'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const uiRoot = path.join(__dirname, '..', 'src', 'board-ui');
const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(uiRoot, 'app.js'), 'utf8');
const style = fs.readFileSync(path.join(uiRoot, 'style.css'), 'utf8');

assert(html.includes('id="current-member"'), 'Board must expose the current-member selector');
assert(html.includes('id="task-view"'), 'Board must provide a dedicated task detail view');
// 태스크 상세는 사이드와 전체화면이 같은 컴포넌트를 쓴다. 구조는 HTML의 빈 자리가 아니라
// taskDetailHtml 하나가 소유하므로, 화면마다 다른 id를 두지 않는다.
assert(html.includes('id="task-page"'), '전체화면은 같은 컴포넌트를 담는 그릇이어야 합니다');
assert(app.includes('function taskDetailHtml'), '태스크 상세는 한 곳에서 만들어야 합니다');
assert(app.includes("taskDetailHtml(item, 'peek')") && app.includes("taskDetailHtml(task, 'page')"), '사이드와 전체화면이 같은 함수를 써야 합니다');
assert(app.includes('연결 문서'), 'Task detail must expose linked documents');
assert(html.includes('id="theme-system"'), 'Settings must provide system theme mode');
assert(html.includes('id="theme-dark"'), 'Settings must provide dark theme mode');
assert(html.includes('id="theme-light"'), 'Settings must provide light theme mode');
assert(app.includes('id="contract-settings"'), 'Settings must expose the document contract editor');
assert(app.includes('data-contract-status'), 'Contract editor must expose document policy status');
// 흡수를 없앴으므로 흡수 대상 선택도 없다. 하부 요소는 흡수가 아니라 프리셋이 갖는다.
assert(!app.includes('data-contract-target'), '흡수 대상 선택은 남으면 안 됩니다');
assert(app.includes('data-contract-components'), 'Contract editor must expose the per-type sections');
assert(app.includes('data-contract-sections'), '하부 요소는 만드는 유형에 붙어야 합니다');
assert(!app.includes('data-contract-after'), 'Contract editor must not expose a hard prerequisite graph');
assert(!app.includes('AI 추천 문맥'), 'AI 추천 문맥은 설정 화면에서 빠져야 합니다');
assert(app.includes('data-contract-section'), 'Contract editor must expose required component values');
assert(app.includes('data-component-input'), 'Contract editor must allow free-form required components');
assert(app.includes('data-component-suggestion'), 'Contract editor must suggest template-derived components');
assert(app.includes('data-component-remove'), 'Contract editor must allow required component removal');
assert(app.includes('implementation-contract-summary'), 'Contract settings must expose implementation contract status');
assert(app.includes('기능별 독립 명세(묶음 금지)'), 'Contract settings must make the no-grouping rule visible');
assert(app.includes("status === 'disabled'"), 'Omission choices must only activate for disabled document types');
assert(!app.includes('placeholder="사용자 흐름, 접근성"'), 'Contract editor must not present placeholder text as contract data');
assert(app.includes("projectPath('/contract')"), 'Contract editor must persist through the typed contract API');
assert(html.includes('src="/mermaid.js"'), 'Board must load the bundled Mermaid runtime');
assert(html.includes('src="/marked.js"'), 'Board must load the bundled Markdown parser');
assert(html.includes('src="/dompurify.js"'), 'Board must load the bundled HTML sanitizer');
assert(html.includes('href="/theme.css"'), 'Theme-specific header styles must be external CSP-safe CSS');
assert(!html.includes('<style>'), 'Board HTML must not use CSP-blocked inline styles');
assert(html.includes('data-task-scope="mine"'), 'My Work must be a task filter instead of a top-level screen');
assert(!html.includes('data-view="my-work"'), 'My Work must not duplicate the task screen in top navigation');
assert(app.includes("task.owner === state.currentMember"), 'My Work must filter by the current member');
// 내가 검토자인 것만 추리는 자리는 홈의 「내 차례」다. 태스크 화면의 검토 범위는 홈 카드가
// 세는 것과 같은 줄(승인 스텝에 선 태스크 전체)을 보여야 하므로 그 축으로 거르지 않는다 —
// 카드가 프로젝트 전체를 세는데 목적지가 내 것만 거르면 수를 눌러 도착한 곳이 0건이 된다.
{
  const queue = app.slice(app.indexOf('function renderMyQueue'), app.indexOf('function visitKey'));
  assert(queue.includes("(task.reviewers || []).includes(state.currentMember)"), '내 차례는 검토자 신원으로 걸러야 합니다');
}
assert(app.includes("return setView('task', button.dataset.task)"), 'Task selection must open task detail');
assert(app.includes('documents.map(documentCard)'), 'Task links must resolve to navigable document cards');
assert(app.includes('data-task-acceptance'), 'Acceptance criteria must render interactive checkboxes');
assert(app.includes('baseRevision: pending.baseRevision'), 'Optimistic updates must use the captured revision');
assert(app.includes('queueTaskUpdate(task'), 'Task fields must use optimistic projection before file persistence');
assert(app.includes('data-task-field'), 'Task Context must expose editable property selectors');
assert(app.includes('파일 반영 대기'), 'Optimistic changes must expose pending file state');
assert(app.includes('window.mermaid.run'), 'Markdown Mermaid blocks must be rendered');
assert(app.includes('window.marked.parse'), 'Markdown documents must use the standard parser');
assert(app.includes('window.DOMPurify.sanitize'), 'Rendered Markdown must be sanitized');
// 겹쳐 띄우는 경로를 없앴다. 양쪽 패널 모두 레일로 좁아지므로 화면 폭에 따라 동작이
// 갈리지 않고, 접힘 상태와 띄움 상태가 어긋나 서로를 되돌릴 일도 없다.
assert(!app.includes("'context-open'") && !app.includes("'nav-open'"), '패널을 본문 위에 띄우지 않습니다');
assert(!html.includes('mobile-bar') && !html.includes('mobile-only'), '띄우기 전용 버튼이 남으면 안 됩니다');
assert(app.includes("document.body.classList.toggle('context-collapsed')"), 'Context는 접었다 펼 수 있어야 합니다');
assert(app.includes("charter: '프로젝트 헌장'"), 'Document type vocabulary must include project charters');
assert(app.includes("prd: '제품 요구사항'"), 'Document type vocabulary must include PRDs');
assert(app.includes("draft: '초안'"), 'Document state vocabulary must map draft status');
assert(app.includes("active: '활성'"), 'Document state vocabulary must map active status');
assert(app.includes("state.snapshot.presentation[group]"), 'Document vocabulary must allow resolved Board presentation overrides');
assert(app.includes('Workspace board.json'), 'Settings must show Workspace presentation inheritance');
assert(app.includes('프로젝트 board.json'), 'Settings must show project presentation inheritance');
assert(app.includes('documentTypeLabel(documentValue)'), 'Document cards must use the shared type vocabulary');
assert(app.includes('documentStateLabel(documentValue.state)'), 'Document cards must use the shared state vocabulary');
// 운영 상태 화면은 없앴다. SYNC와 ATTENTION은 헤더·홈과 중복이었고 WATCH는 빈 자리표시자였다.
assert(!html.includes('data-view="operations"'), '운영 상태 화면은 헤더와 홈의 중복이라 두지 않습니다');
assert(!app.includes('renderOperations'), '운영 상태 렌더러가 남아 있으면 안 됩니다');
assert(!app.includes('다음 Snapshot 계약에서 연결됩니다'), '빈 자리표시자를 화면에 두지 않습니다');

// 편집 임대는 ADR-015로 폐기했다. 화면에 잠금처럼 보이는 표시를 남겨 두면 사람은
// 없어진 보장을 계속 믿는다. 편집을 지키는 것은 저장 시점의 revision 비교다.
assert(!html.includes('settings-leases'), '폐기한 편집 임대 화면이 남아 있습니다');
assert(!html.includes('document-lease'), '폐기한 편집 임대 배너가 남아 있습니다');
assert(!app.includes('leaseAction'), '폐기한 임대 호출이 남아 있습니다');
assert(!app.includes('heldLease'), '폐기한 임대 상태가 남아 있습니다');
// 드라이버 lease는 폐기한 편집 임대와 다른 개념이다. 런이 lease를 잃고 멈춘 사유는
// 원장이 내는 값이고 화면은 그 값을 옮겨 적을 뿐이므로, 그 한 쌍만 빼고 검사한다.
// 빼는 문자열을 정확히 적어야 이 예외가 다른 임대 흔적까지 덮지 않는다.
const editLeaseTraces = app.split("'lease-lost': 'lease 상실',").join('');
assert(!/\blease/i.test(editLeaseTraces), '화면 코드에 임대 흔적이 남아 있습니다');
// 승인은 읽고 나서 하는 일이다. 모달이 런 ID만 보여 주면 사람은 무엇을 승인하는지
// 모른 채 누르게 되고, 그 승인은 "읽었다"의 증거가 되지 못한다.
assert(html.includes('id="run-review-document"'), '승인 모달은 대상 문서를 담아야 합니다');
assert(html.includes('id="run-approve-goal"'), '승인 모달은 런의 목표를 보여야 합니다');
assert(app.includes('markdown(documentValue.body)'), '승인 모달의 본문은 문서 화면과 같은 렌더 경로를 써야 합니다');
assert(app.includes('function renderRunReview'), '승인 검토 렌더러가 있어야 합니다');
assert(html.includes('id="settings-button"'), '설정으로 가는 길이 있어야 합니다');
const theme = fs.readFileSync(path.join(uiRoot, 'theme.css'), 'utf8');

// 구조 스타일시트는 색을 직접 쓰지 않는다. 하나라도 hex가 있으면 테마 전환이 그 지점에서 깨진다.
const structuralHex = style.split('\n').filter((line) => /#[0-9a-fA-F]{3,8}\b/.test(line) && !line.trim().startsWith('/*'));
assert.deepStrictEqual(structuralHex, [], `style.css는 색 토큰만 참조해야 합니다: ${structuralHex.join(' | ')}`);

// 문서 머리의 190px 벽은 「편집」과 같은 높이에 서는 것만 받는다. 승인 줄이 그 벽을 받으면
// 오른끝으로 미는 margin-left:auto가 벽 앞에서 멈춰(실측 947, 「편집」은 1137) 단추 두 개가
// 어긋난 자리에 뜬다. 두 규칙은 특정도가 같아 순서가 판정을 뒤집으므로 순서까지 잰다.
{
  // 문서 머리와 목록 제목 줄이 한 규칙을 나눠 쓰고 있었다. 그래서 한쪽을 고치면
  // 있었고, 그래서 한쪽을 고치면 다른 쪽이 함께 바뀌었다 — 실제로 이 결함을 고치다
  // 목록 제목까지 떼어 버렸다. 갈라 둔 것을 값으로 못박는다.
  //
  // 재는 것은 화면이 아니라 규칙이다. 시험은 jsdom이라 붙임을 실제로 재지 못한다.
  {
    const blockAfter = (selector) => {
      const at = style.indexOf(selector);
      assert(at !== -1, `규칙을 찾지 못했습니다: ${selector}`);
      return style.slice(at, style.indexOf('}', at) + 1);
    };
    assert(blockAfter('.reader-heading {').includes('position: sticky'),
      '문서 머리는 통째로 붙어야 합니다 — 읽으며 판단하고 그 자리에서 승인하는 흐름이 이 화면의 전부입니다');
    assert(blockAfter('.page-heading {').includes('position: sticky'),
      '목록 제목 줄은 한 줄이라 붙어도 화면을 거의 안 먹습니다 — 함께 떼면 안 됩니다');
  }
  // 이력의 차례는 서버가 세운 것을 쓴다. 화면이 다시 세우면 두 축의 시각 표기가 달라
  // 어긋난다 — 원장은 UTC로 적고 git은 +09:00으로 준다. 문자열로 견주면 같은 순간이
  // 아홉 시간 어긋난 자리에 놓이고, ADR-020에서 승인이 그보다 13분 앞선 커밋 위로
  // 올라갔다. 못 읽는 시각과 같은 순간의 처리까지 그 한 자리가 갖는다.
  assert(app.includes('history.timeline'), '이력 차례는 서버가 세운 시간축을 써야 합니다');
  assert(app.includes("row.kind === 'commit' ? (row.who"), '커밋의 이름은 git의 것이라 원장 명의와 같은 함수를 지나면 안 됩니다');
  // 검토 손잡이는 원장 줄이 아니라 그 제목 줄에 선다. 원장 줄에 두면 34px짜리 단추가
  // 그 줄을 통째로 키워 바로 아래 안내 문장이 단추 바닥에 붙는다(실측 간격 0px).
  assert(app.includes('document-approval-head'), '손잡이는 제목 줄에 서야 아래 문장과 안 붙습니다');
  assert(app.indexOf('document-approval-actions') < app.indexOf('class="document-approval-line"'),
    '손잡이가 원장 줄보다 앞에 그려져야 위에 섭니다');
  // 머리 안의 문단은 .reader-heading p가 납작하게 만든다. 설명 한 줄을 위한 규칙인데
  // 승인 블록의 문단까지 눌러 두 문장이 한 덩어리로 읽혔다. 특정도로 되찾는다.
  assert(style.includes('.reader-heading .document-approval-line { margin-bottom:'),
    '원장 줄은 자기 여백을 되찾아야 아래 문장과 갈립니다');
  const wall = style.indexOf('.reader-heading > :not(.reader-actions) { padding-right: 190px; }');
  const relief = style.indexOf('.reader-heading > .document-approval { padding-right: 0; }');
  assert(wall !== -1, '머리 벽 규칙이 있어야 합니다');
  assert(relief !== -1, '승인 줄은 그 벽에서 빠져야 오른끝에 붙습니다');
  assert(relief > wall, '특정도가 같으므로 예외가 벽보다 뒤에 와야 이깁니다');
}

// 색 토큰은 theme.css가 소유하고 세 모드를 모두 정의한다.
assert(theme.includes('body.theme-light'), 'theme.css must map the fixed light theme');
assert(theme.includes('prefers-color-scheme: light'), 'theme.css must map system light through the media query');
for (const token of ['--code-TextColor', '--on-accent-TextColor', '--surface-01-BackgroundColor', '--ui-hover-OverlayColor']) {
  const occurrences = theme.split(token).length - 1;
  assert(occurrences >= 3, `${token}은 다크와 라이트 두 경로 모두에서 정의되어야 합니다 (현재 ${occurrences}회)`);
}

// hover는 표면마다 색을 새로 짓지 않고 오버레이 토큰 하나를 공유한다.
assert(style.includes('var(--ui-hover-OverlayColor)'), 'Interactive surfaces must share the hover overlay token');

assert(style.includes('max-width: none'), 'Markdown documents must use the available reader width');
// 상태가 여섯이 되면서 줄바꿈으로는 한 줄에 담을 수 없어졌다. 칸반은 접히면 진행 순서를
// 잃으므로 폭이 모자라면 가로로 스크롤한다. 대신 본문 자체는 가로로 밀리지 않아야 한다.
assert(/#board\s*\{[^}]*grid-auto-flow:\s*column/u.test(style), 'Task Board must keep its columns on one row');
assert(/#board\s*\{[^}]*overflow-x:\s*auto/u.test(style), 'Task Board must scroll inside itself instead of wrapping');
assert(/\.task-card\s*\{[^}]*min-width:\s*0/u.test(style), 'Board cards must shrink instead of widening their column');
assert(style.includes('.markdown-body code'), 'Markdown code must use a theme-aware foreground token');
assert(style.includes('color: var(--code-TextColor)'), 'Markdown code colour must come from the theme');
assert(style.includes('color: var(--on-accent-TextColor)'), 'Primary buttons must use a theme-aware foreground token');
assert(/pre\.mermaid\s*\{[^}]*var\(--surface-01-BackgroundColor\)/u.test(style), 'Mermaid blocks must use the panel surface instead of the code background');
assert(/\.mermaid svg \.marker circle,[^{]*\{[^}]*var\(--surface-01-BackgroundColor\)/u.test(style), 'Mermaid cardinality markers must not keep their hardcoded white fill');
// 간선을 채우면 곡선 안쪽이 메워져 거대한 검은 쐐기가 된다. flowchart의 간선은
// .edgePath가 아니라 path.flowchart-link로 나오므로 그 이름을 반드시 포함해야 한다.
assert(/\.mermaid svg \.flowchart-link,[\s\S]*?\{[^}]*fill:\s*none/u.test(style), 'Flowchart edges must be stroked, not filled');
// 도형 채움 규칙이 text·tspan까지 잡으면 라벨이 상자와 같은 색이 되어 사라진다.
assert(!/\.mermaid svg \.actor\s*[,{]/u.test(style), 'Shape fills must not match text.actor');
assert(/\.mermaid svg text,\s*\.mermaid svg tspan\s*\{[^}]*var\(--primary-TextColor\)/u.test(style), 'Diagram text must use the primary text colour');
// ER 관계 표식과 sequence의 갈래 머리는 선으로 그린 기호라 채우면 검은 덩어리가 된다.
assert(/marker\[id\*='_er-'\] path/u.test(style), 'ER cardinality markers must stay unfilled');
// 레인은 자기 안에서만 세로로 스크롤한다. 바깥이 스크롤되면 레인 머리글이 사라진다.
assert(/\.column-cards\s*\{[^}]*overflow-y:\s*auto/u.test(style), 'Board lanes must scroll inside themselves');
assert(/\.column-cards\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u.test(style), 'Board lanes must not let cards widen past the lane');
assert(/body\.view-tasks\.board-mode \.main-content\s*\{[^}]*height:\s*calc\(100vh/u.test(style), 'Board must be pinned to the viewport height');
// 전역 button 규칙의 nowrap을 되돌리지 않으면 제목이 한 줄에서 잘려 읽히지 않는다.
assert(/\.task-card-title\s*\{[^}]*white-space:\s*normal/u.test(style), 'Board card titles must wrap instead of clipping');
assert(/\.task-card\s*\{[^}]*justify-content:\s*stretch/u.test(style), "Board cards must override button's centred track");

// 목록 행은 겹침을 막는 두 속성이 항상 같이 있어야 한다.
assert(/\.task-row > \*[^{]*\{[^}]*min-width:\s*0/u.test(style), 'List cells must be allowed to shrink below their content');
assert(/\.task-row > \*[^{]*\{[^}]*text-overflow:\s*ellipsis/u.test(style), 'List cells must truncate instead of overflowing their track');
assert(style.includes('.theme-options button.active'), 'The theme picker must show which mode is selected');
assert(app.includes("theme: 'base'") && app.includes('themeVariables: mermaidThemeVariables()'), 'Mermaid must render with the Board palette instead of its built-in themes');
// mermaid는 config 글꼴로 상자 크기를 재는데 svg 안 스타일이 적용되지 않아 글자는
// 브라우저 기본 monospace로 그려졌다. 잰 폭과 그린 폭이 달라 액터 이름이 상자를 넘쳤다.
assert(app.includes('fontFamily: DIAGRAM_FONT'), 'Mermaid must measure with the font the diagram is drawn in');
assert(/\.mermaid svg text,\s*\.mermaid svg tspan\s*\{[^}]*font-family:\s*Inter/u.test(style), 'Diagram text must be drawn in the font mermaid measured with');
// 토큰 이름이 바뀌면 빈 문자열이 돌아오고 mermaid는 "Unsupported color format"으로 전체를
// 포기한다. 실제로 theme.css를 다시 쓰며 --panel·--text가 사라져 본문 다이어그램이 전부
// 죽어 있었다. 이름은 theme.css에 실재해야 하고, 빈 값은 넘겨서 그림은 나오게 한다.
{
  const used = [...app.matchAll(/themeToken\('(--[\w-]+)'/gu)].map((match) => match[1]);
  assert(used.length, 'Mermaid 팔레트가 토큰을 참조해야 합니다');
  for (const name of used) assert(theme.includes(`${name}:`), `theme.css에 없는 토큰입니다: ${name}`);
  assert(app.includes("filter(([, value]) => value !== '')"), '빈 값은 넘겨야 다이어그램 하나가 전체를 죽이지 않습니다');
}
// mermaid가 svg 안에 심는 스타일이 적용되지 않아 도형이 두 테마 모두 검정으로 칠해졌다.
// 색은 우리 토큰으로 직접 주어야 테마 전환에도 따라온다.
assert(/\.mermaid svg \.node rect[\s\S]{0,200}fill:\s*var\(--surface-02-BackgroundColor\)/u.test(style), '다이어그램 도형은 토큰으로 칠해야 합니다');
assert(/\.mermaid svg text[\s\S]{0,200}fill:\s*var\(--primary-TextColor\)/u.test(style), '다이어그램 글자는 본문과 같은 색이어야 합니다');
// mermaid는 svg에 width="100%"를 붙여 356px 그림을 909px로 펴 글자를 2.5배로 키운다.
assert(app.includes('function fitDiagram'), '다이어그램은 고유 크기보다 커지지 않아야 합니다');
assert(app.includes('min(100%, ${Math.ceil(intrinsic)}px)'), 'viewBox의 고유 폭을 상한으로 씁니다');
assert(/\.mermaid svg\s*\{[^}]*display:\s*block/u.test(style), 'inline이면 max-width가 적용되지 않습니다');
assert(!app.includes("theme: lightTheme() ? 'default' : 'dark'"), 'Mermaid must not fall back to its unthemed built-in palettes');
assert(html.includes('id="close-dialog" type="button"'), 'Dialog close must not submit the task form');
assert(html.includes('<button type="button" data-dialog-cancel="task-dialog">취소</button>'), 'Task dialog cancel must not submit the task form');
assert(!html.includes('<button value="cancel">취소</button>'), 'Cancel must not rely on form submission with required fields present');
assert(app.includes("el(button.dataset.dialogCancel).close('cancel')"), 'Dialog cancel must close the dialog explicitly');
assert(html.includes('id="blocker-dialog"'), 'Waiting transitions must provide a blocker input dialog');
assert(html.includes('id="blocker-waiting-for"'), 'Blocker input must capture the waiting target');
assert(html.includes('id="blocker-condition"'), 'Blocker input must capture the release condition');
assert(html.includes('id="blocker-since"'), 'Blocker input must capture the waiting start time');
assert(app.includes('requestBlocker(task.blocker)'), 'Switching a task to waiting must collect blocker details first');
assert(app.includes('task.blocker ? { blocker: null } : null'), 'Leaving waiting must clear the blocker in the same change');
assert(app.includes('blockerText(task.blocker)'), 'Task detail must render structured blocker information');

// 동기화는 되돌리기 어렵다. 무엇이 나가는지 보여주고 확인을 받은 뒤에만 실행한다.
assert(html.includes('id="sync-status"'), '동기화 상태는 사이드바에서 상시 보여야 합니다');
assert(!html.includes('data-settings-section="settings-sync"'), '동기화는 설정 항목이 아니라 동작입니다');
assert(app.includes("el('sync-status').addEventListener"), '동기화는 상태 표시 자체가 실행 지점이어야 합니다');
assert(app.includes('confirm(`${lines.join('), 'push 전에 무엇이 나가는지 확인을 받아야 합니다');
assert(app.includes("projectPath('/sync')"), '동기화는 프로젝트 sync API를 씁니다');

// 설정은 범위별로 묶는다. 브라우저에만 남는 값과 저장소에 커밋되는 값이 섞이면 무엇이 공유되는지 알 수 없다.
assert(html.includes('<h2>내 브라우저</h2>'), '설정은 저장 범위별로 묶여야 합니다');
assert(html.includes('<h2>Workspace</h2>'), '설정은 저장 범위별로 묶여야 합니다');
assert(html.includes('id="settings-member"'), '보기 기준은 설정에서도 고를 수 있어야 합니다');
assert(html.includes('id="reset-view-options"'), '표시 기본값은 되돌릴 수 있어야 합니다');
assert(app.includes('resetViewOptions(); populateControls();'), '초기화는 저장값과 컨트롤을 함께 되돌려야 합니다');

// Client 삭제는 여전히 CLI가 소유한다. 지운 Client의 기록은 남는데 그 신원을 화면에서
// 지울 수 있으면 무엇이 남긴 기록인지 물을 수 없게 된다.
//
// 등록은 화면으로 옮겼다. 미등록이 드러나는 자리는 대개 무언가를 하려던 순간이고,
// 그때 사람을 터미널로 보내면 하던 일이 끊긴다. 등록은 신원을 적는 일이지 위험한
// 일이 아니다.
assert(app.includes('data-client-toggle'), 'Client는 Board에서 활성 상태를 바꿀 수 있어야 합니다');
assert(app.includes("'/enable' : '/disable'") || app.includes("? 'enable' : 'disable'"), 'Client 상태 변경은 전용 API를 씁니다');
assert(app.includes('function renderClientRegistration'), '미등록 기기는 화면에서 등록할 수 있어야 합니다');
assert(app.includes("closest('#register-client')"), '등록 단추가 동작에 묶여야 합니다');
assert(app.includes("api('/api/clients'"), '등록은 기존 Client API를 씁니다');
// 식별자는 사람이 고르지 않는다. 고르게 두면 다른 기기의 것을 적어 두 기기가 한
// 신원을 공유할 수 있고, 그러면 누가 남긴 기록인지 물을 수 없다.
assert(app.includes('id: state.snapshot.client.id'), '식별자는 이 기기의 값을 그대로 보내야 합니다');
assert(app.includes('readonly'), '식별자 칸은 고칠 수 없어야 합니다');
// 유형 기본값을 두지 않는다. device는 기계의 종류일 뿐 행위 주체를 담지 않아서,
// 그 값으로 파생한 판정이 실제로 틀린 적이 있다.
assert(!/register-client-type[^]{0,400}?<option value="device" selected/u.test(app), '유형에 기본값을 두면 안 됩니다');

// 미등록은 하려던 일 앞에서 드러난다. 그 자리에서 명령줄 문자열을 건네면 사람은 하던
// 일을 접고 터미널을 찾아야 한다. 화면이 등록을 받고 하려던 일로 이어 준다.
assert(!/rdl client register/u.test(app), '화면은 등록 명령줄을 건네지 않습니다');
assert(html.includes('id="client-dialog"'), '등록은 하던 일 위에서 바로 받아야 합니다');
assert(html.includes('id="client-dialog-body"'), '등록 칸은 대화상자가 담아야 합니다');
assert(app.includes('function openClientRegistration'), '등록으로 들어가는 길은 한 곳이어야 합니다');
// 등록 칸은 한 벌만 만든다. 같은 id의 입력이 화면에 둘이면 무엇이 저장될지는 사람이
// 채운 칸이 아니라 먼저 그려진 칸이 정한다.
assert(app.includes('function clientRegisterFormHtml'), '등록 칸은 한 곳에서 만들어야 합니다');
assert(app.split('register-client-name" placeholder').length === 2, '등록 칸은 화면에 한 벌만 있어야 합니다');
assert(app.includes("closest('#open-client-register')"), '설정 화면은 같은 등록 대화상자로 들어가야 합니다');
// 등록은 목적이 아니라 중간에 낀 일이다. 끝나면 누르려던 것으로 이어져야 한다.
assert(app.includes('if (intent) await intent();'), '등록을 마치면 하려던 일로 이어져야 합니다');
assert(app.includes('const fresh = state.snapshot.documents.find'), '이어갈 대상은 새 스냅샷에서 다시 찾아야 합니다');
assert(app.includes("state.clientIntent = null"), '대화상자를 닫으면 이어갈 일도 버려야 합니다');
// 거절의 종류는 문장이 아니라 code로 읽는다. 문장으로 되짚으면 말을 다듬는 순간 판정이 깨진다.
assert(app.includes('error.code = value.code'), '서버가 붙인 거절 종류를 화면이 읽어야 합니다');
assert(app.includes("error.code === 'unknown-client'"), '미등록 거절은 등록 절차로 이어져야 합니다');
assert(app.includes('async function postComment'), '쓰던 댓글은 등록 뒤 다시 쓰게 하면 안 됩니다');
// dialog 안의 form은 Enter의 기본 동작이 "닫기"다. 막지 않으면 다 채운 사람이 Enter 한
// 번에 등록 없이 대화상자만 닫고 처음부터 다시 채운다.
assert(app.includes("el('client-form').addEventListener('submit'"), '등록 칸에서 Enter는 등록이어야 합니다');
assert(app.includes('async function submitClientRegistration'), '단추와 Enter는 같은 등록을 불러야 합니다');

// 옆에서 연 태스크(peek)는 목록과 함께 다시 그려야 한다. 목록만 갱신하면 peek은 예전
// 스냅샷을 들고 있어, 방금 남긴 댓글이 저장되고도 그 자리에서는 보이지 않는다.
assert(app.includes('function redrawTaskPeek'), '옆에 열어둔 태스크도 다시 그려야 합니다');
assert(app.includes('function renderTasks() { redrawTaskPeek();'), '목록을 그릴 때 peek도 함께 그려야 합니다');
// 스냅샷은 5초마다 돈다. 그때마다 쓰던 글이 지워지면 이 화면에서는 긴 댓글을 쓸 수 없다.
assert(app.includes('function withCommentDraft'), '다시 그려도 쓰다 만 댓글은 남아야 합니다');
assert(app.includes("withCommentDraft(el('task-page')"), '전체화면 상세도 초안을 지키며 다시 그려야 합니다');
assert(app.includes("withCommentDraft(el('context-content')"), 'peek도 초안을 지키며 다시 그려야 합니다');
// 보낸 댓글은 다시 읽기 전에 지운다. 순서가 뒤집히면 초안 복원이 방금 보낸 글을
// 입력칸에 되살려 두 번 보내게 된다.
{
  const post = app.slice(app.indexOf('async function postComment'));
  assert(post.indexOf('clearCommentDraft(taskId)') < post.indexOf('await loadSnapshot(true)'), '보낸 댓글은 다시 읽기 전에 지워야 합니다');
  // 입력칸을 열어 둔 채 스냅샷을 읽으면 '쓰는 중'으로 보고 갱신을 건너뛴다. 그러면
  // 방금 남긴 댓글이 화면에 나타나지 않는다.
  assert(post.indexOf('closeCommentComposer()') < post.indexOf('await loadSnapshot(true)'), '입력칸을 닫은 뒤에 다시 읽어야 합니다');
}
// 댓글은 누가·언제·무엇을 세 가지로 읽힌다. 아바타 색은 이름에서 뽑아 같은 사람이 늘
// 같은 색이어야 얼굴 역할을 한다 — 무작위면 새로고침마다 색이 바뀐다.
assert(app.includes('function avatarTone'), '아바타 색은 이름에서 뽑아야 합니다');
assert(!/avatarTone[^]{0,200}Math\.random/u.test(app), '아바타 색이 무작위면 얼굴 역할을 하지 못합니다');
assert(app.includes('function commentAuthor'), '사람은 구성원 이름으로, 에이전트는 Client로 불러야 합니다');
assert(app.includes('function commentTimeHtml') && app.includes('relativeTime(item.recordedAt)'), '시각은 상대시간으로 읽히고 정확한 값은 함께 남아야 합니다');
// 스레드는 깊이 하나다. 답글 단추가 답글에도 있으면 화면이 없는 구조를 약속하게 된다.
assert(app.includes('function commentThreadsOf'), '댓글은 줄기로 접혀야 합니다');
assert(app.includes("const actions = reply ? '' :"), '답글 단추는 뿌리에만 있어야 합니다');
assert(style.includes('.comment-replies'), '답글 줄기는 눈에 보이는 선을 가져야 합니다');
assert(style.includes('.comment-item:hover .comment-actions'), '액션은 평소에 숨어야 목록이 단추밭이 되지 않습니다');
assert(style.includes('.comment-avatar'), '아바타는 스타일을 가져야 합니다');
// 입력칸은 평소에 한 줄이고 펼침 여부는 state가 갖는다. DOM에 두면 폴링이 접어 버린다.
assert(app.includes('function commentComposerHtml') && app.includes('comment-composer-open'), '입력칸은 평소에 접혀 있어야 합니다');
assert(app.includes('state.commentComposer'), '펼침 여부는 state가 가져야 다시 그려도 남습니다');
// 댓글 편집기는 문서 편집기와 같은 것을 쓴다. 따로 들이면 같은 그림이 자리마다 다른
// 규격으로 저장되고, 마크다운 방언도 두 벌이 된다.
assert(app.includes('window.RundolEditor.openEditor(host, initial'), '댓글은 문서와 같은 편집기를 써야 합니다');
assert(/mountCommentEditor[^]{0,600}uploadImage/u.test(app), '댓글에 붙인 그림도 같은 자산 경로로 들어가야 합니다');
assert(app.includes('if (fallback) { fallback.value = initial'), '편집기 번들이 없어도 댓글은 남길 수 있어야 합니다');

// 자산 embed는 문서 참조가 아니다. `![[그림.png]]`을 문서 규칙으로 옮기면
// `![그림.png](#document=그림.png)`이 되고, marked는 그것을 그대로 <img>로 그린다.
// 실측에서 문서 본문은 404, 댓글은 깨진 그림이었다 — 넣기는 200인데 화면에는 아무것도
// 안 보이므로 사람에게는 그것이 "업로드가 안 되는 것"이다. 느낌표 있는 것을 먼저 본다.
assert(app.includes('function assetUrl'), '자산 embed는 자산 주소로 옮겨져야 합니다');
{
  const start = app.indexOf('function markdown');
  const body = app.slice(start, app.indexOf('window.marked.parse', start));
  assert(body.includes('assetUrl(target)'), '`![[이름]]`은 자산 주소가 되어야 합니다');
  const embedRule = body.indexOf('.replace(/!\\[\\[');
  const linkRule = body.indexOf('.replace(/\\[\\[');
  assert(embedRule >= 0 && linkRule >= 0, '두 규칙이 모두 있어야 합니다');
  assert(embedRule < linkRule, '자산 embed를 문서 참조보다 먼저 옮겨야 합니다');
}
// 자산이 사는 자리는 프로젝트 매니페스트가 정한다. 화면이 docs/assets를 사본으로
// 적으면 문서 뿌리를 옮긴 날 그림만 조용히 깨지고, 아무도 그것을 시험하지 않는다.
assert(app.includes('state.snapshot.assets && state.snapshot.assets.directory'), '자산이 사는 자리는 스냅숏이 실어 준 값이어야 합니다');
assert(style.includes('.markdown-body img') && style.includes('.comment-body img'), '문서와 댓글의 그림은 본문 폭을 넘지 않아야 합니다');

// 실패한 알림은 성공과 달라야 한다. 이 자리는 오래 style.color로 색을 칠했는데 보드가
// 내려보내는 CSP가 style-src 'self'라 브라우저가 그 칠하기를 막았고, 쓰던 --red는
// 테마를 다시 쓰면서 사라진 이름이었다. 그래서 "그림을 넣지 못했습니다"가 "넣었습니다"와
// 똑같이 보였고, 사람은 실패를 못 본 채 같은 일을 다시 했다.
assert(!/function message\([^)]*\)[^\n]*style\.color/u.test(app), '알림 색은 CSP가 막는 인라인 스타일로 칠하면 안 됩니다');
assert(/function message\([^)]*\)[^\n]*classList\.toggle\('is-error'/u.test(app), '실패한 알림은 종류를 클래스로 말해야 합니다');
assert(style.includes('#message.is-error'), '실패한 알림은 성공과 다른 모양을 가져야 합니다');
assert(!app.includes('var(--red)'), 'theme.css에 없는 색 이름은 아무 색도 칠하지 않습니다');


// 표시 규칙은 이제 Board에서 고친다. 판정에 쓰이지 않는 층이라 결정을 요구할 근거가
// 없고, 근거 없는 읽기 전용은 사람을 파일로 보낼 뿐이다. 다만 어느 파일에 쓰는지는
// 계속 보여야 한다 — 화면이 어디에 쓰는지 말하지 않으면 편집은 추측이 된다.
assert(app.includes('presentation-source'), '표시 규칙은 board.json 경로를 본문에 보여야 합니다');
assert(app.includes('id="presentation-scope"'), '표시 규칙은 어느 범위에 저장할지 고르게 해야 합니다');
assert(app.includes('id="save-presentation"'), '표시 규칙은 화면에서 저장할 수 있어야 합니다');
assert(app.includes('data-presentation-field'), '표시 규칙의 문구·설명·순서는 칸으로 편집해야 합니다');
assert(app.includes('data-presentation-reset'), '이 범위에서 덮은 값을 되돌릴 수 있어야 합니다');
assert(app.includes('function savePresentationEdits'), '표시 규칙 저장은 한 곳에서 만들어야 합니다');
// 칸의 값은 이 범위가 덮은 것뿐이다. 합쳐진 값을 칸에 채워 그대로 저장하면 손대지 않은
// 상위 값까지 이 범위 파일에 박혀, 나중에 상위 기본값이 나아져도 내려오지 않는다.
assert(app.includes("own && own[field] !== undefined ? own[field] : ''"), '칸은 이 범위가 덮은 값만 담아야 합니다');
assert(app.includes('inheritedPresentationEntry'), '상위에서 내려온 값은 placeholder로만 보여야 합니다');
assert(app.includes('function isPresentationEditing'), '편집 중에는 폴링이 칸을 갈아끼우면 안 됩니다');
// 정책 층은 여기서 바꾸지 않는다. 표시 문구를 고치러 온 사람이 항목을 없애거나 승인
// 모드를 바꿀 수 있으면, 결정을 요구하는 규칙이 화면 하나로 우회된다.
assert(!app.includes('data-presentation-disabled'), '사용 안 함은 표시가 아니라 정책이라 여기서 바꾸지 않습니다');
assert(app.includes('계약 변경 결정'), '정책 층을 왜 여기서 못 바꾸는지 화면이 말해야 합니다');

// 막힘은 목록에서 바로 읽혀야 한다. blocker뿐 아니라 끝나지 않은 선행 태스크도 막힘이다.
assert(app.includes('function taskBlockage'), '막힘 판정은 한 곳에서 계산해야 합니다');
// 종료 판정은 서버가 실어 준 워크플로의 스텝이 답한다. 화면에 상태 이름 사본을
// 두던 자리이고, 사본은 정본이 늘어도 따라가지 않았다.
assert(app.includes('!isTerminalStatus(item.status)'), '끝나지 않은 선행 태스크는 막힘입니다');
assert(app.includes('class="task-blocked"'), '막힌 태스크는 목록에서 배지로 구분되어야 합니다');
assert(style.includes(".task-blocked[data-blocked='deps']"), '사람 대기와 선행 대기는 구분되어야 합니다');

// 의존 그래프는 목록·Board와 같은 필터를 받는다.
assert(html.includes('id="task-graph-mode"'), '태스크는 의존 관계 보기를 제공해야 합니다');
assert(app.includes('function renderTaskGraph'), '의존 그래프는 지금 보이는 범위만 그려야 합니다');
assert(app.includes('nodeLabel('), '태스크 제목의 따옴표가 노드 라벨을 깨뜨리면 안 됩니다');

// 홈은 "내가 지금 뭘 하면 되나"에 답해야 한다.
assert(html.includes('id="my-queue"'), '홈은 내 차례를 보여야 합니다');
assert(app.includes('지금 시작할 수 있는 일'), '막힌 일과 시작할 수 있는 일은 갈라져야 합니다');
assert(html.includes('id="recent-changes"'), '홈은 지난 방문 이후 바뀐 것을 보여야 합니다');
assert(app.includes('state.lastVisit'), '마지막 방문 시각은 한 번만 읽어야 합니다');
assert(app.includes('function markVisit'), '마지막 방문 시각은 떠날 때 기록해야 합니다');

// 탭이 보이지 않는 동안 스냅샷을 다시 계산할 이유가 없다.
assert(app.includes("document.addEventListener('visibilitychange'"), '폴링은 탭이 보이지 않으면 멈춰야 합니다');
assert(app.includes('function stopPolling'), '폴링은 멈출 수 있어야 합니다');
assert(!app.includes('setInterval(() => loadSnapshot(true), 3000)'), '고정 3초 폴링은 유지하지 않습니다');

// AI 추천 문맥은 프로젝트가 들고 다니던 상태에서 상수로 옮겼다. 유형마다 토글 아홉 개씩
// 아흔 개를 두고 있었는데, 아무것도 막지 않고 아직 만들지 않은 유형에만 나타나며 기본값
// 그대로 쓰였다. 설정에서 빼고 저장 payload에서도 뺀다. 남겨 두면 저장할 때마다 보존해야
// 하고, 빠뜨리면 조용히 빈 값이 되는 종류의 상태가 하나 더 늘어난다.
assert(!app.includes('data-context-toggle'), 'AI 추천 문맥 토글은 설정 화면에서 빠져야 합니다');
assert(!/rules\[type\]|profile\.rules/u.test(app), '화면이 더 이상 rules를 읽으면 안 됩니다');
assert(!/name: el\('contract-profile'\)[^;]*rules/u.test(app), '저장 payload에 rules가 실리면 안 됩니다');

// 반려는 완료와 반대 방향의 게이트다. 완료조건이 남아도 닫히지만 사유가 없으면 닫히지 않는다.
assert(html.includes('id="cancellation-dialog"'), '반려는 사유를 받는 입력이 필요합니다');
assert(html.includes('id="cancellation-reason"'), '반려 사유를 입력할 수 있어야 합니다');
assert(html.includes('id="cancellation-decided-by"'), '반려 결정자를 지정할 수 있어야 합니다');
assert(app.includes("cancelled: '반려'"), '상태 어휘에 반려가 있어야 합니다');
assert(app.includes('requestCancellation(task.cancellation)'), '반려 전환은 사유를 먼저 받아야 합니다');
assert(app.includes('task.cancellation ? { cancellation: null } : null'), '반려를 벗어나면 사유를 같은 변경에서 지워야 합니다');
assert(app.includes('cancellationText(task.cancellation)'), '태스크 상세는 반려 사유를 보여야 합니다');
// 완료와 반려를 함께 종료로 다루는 일은 이제 서버가 실어 준 terminalSteps가 답한다.
// 화면이 목록을 적어 두면 그 목록은 정본과 갈리고, 갈렸다는 사실은 신호를 내지 않는다.
assert(app.includes('workflowView().terminalSteps'), '완료와 반려는 함께 종료로 다뤄야 합니다');
assert(!app.includes("task.status !== 'done')"), '종료 판정에 done만 쓰면 반려된 태스크가 열린 것으로 남습니다');

// Notion 순서: 제목 → 속성 → 내용. 속성은 짧고 고정이라 위에서 한눈에 지나가고,
// 길이를 알 수 없는 내용이 그 아래로 흐른다. peek이 속성만 보여주던 문제의 해결이기도 하다.
const detail = app.slice(app.indexOf('function taskDetailHtml'), app.indexOf('function renderContext'));
assert(detail.indexOf('task-detail-head') < detail.indexOf('task-properties'), '제목이 속성보다 먼저 와야 합니다');
assert(detail.indexOf('task-properties') < detail.indexOf('task-detail-summary'), '속성이 내용보다 먼저 와야 합니다');
assert(html.includes('title="크게 보기"'), '전체화면으로 가는 동작은 크게 보기입니다');
assert(app.includes('function redrawTask'), '낙관적 변경은 보고 있는 화면에 바로 반영되어야 합니다');
assert(style.includes('.task-detail-head h1'), '상세 제목은 속성 라벨과 다르게 보여야 합니다');

// 헤더는 프로젝트를 가리지 않는 것만, 사이드바는 프로젝트 안에서의 이동을 갖는다.
const header = html.slice(html.indexOf('<header class="app-header"'), html.indexOf('</header>'));
const sidebar = html.slice(html.indexOf('<aside class="navigation-panel"'), html.indexOf('</aside>'));
for (const id of ['global-search', 'sync-status', 'current-member', 'settings-button']) {
  assert(header.includes(`id="${id}"`), `${id}는 헤더에 있어야 합니다`);
}
for (const id of ['project-switcher', 'collapse-nav', 'document-filters', 'recent-documents']) {
  assert(sidebar.includes(`id="${id}"`), `${id}는 사이드바에 있어야 합니다`);
}
assert(sidebar.includes('data-view="tasks"'), '주요 이동은 사이드바가 갖습니다');
assert(!header.includes('data-view="tasks"'), '헤더에 주요 이동까지 넣으면 줄바꿈되어 자리가 흔들립니다');
assert(style.includes('--header-Height') && theme.includes('--header-Height'), '헤더 높이는 토큰이어야 합니다');

// 검색은 오른쪽 묶음의 글자 길이가 바뀌어도 같은 자리에 있어야 한다. flex 가운데나
// 1fr 나눗셈에 맡기면 상태 글자가 길어질 때마다 검색이 따라 움직인다.
assert(/\.app-header\s*\{[^}]*display:\s*grid/u.test(style), '헤더는 격자여야 검색이 고정됩니다');
// 왼쪽 칸은 검색 폭만큼만 갖고, 오른쪽 칸은 내용만큼의 바닥을 가진다. 바닥이 없으면
// 오른쪽 묶음이 내용보다 좁게 무너져 검색칸 위로 올라탄다.
assert(/\.app-header\s*\{[^}]*grid-template-columns:\s*minmax\(0, 480px\) minmax\(min-content, 1fr\)/u.test(style), '검색은 왼쪽 칸에 고정되고 오른쪽은 내용만큼의 바닥을 가져야 합니다');
// 좁은 폭에서는 검색을 아이콘으로 접되, 초점이 오면 다시 펼쳐져야 한다. 접기만 하고
// 펼칠 길을 두지 않으면 그 폭에서 검색을 아예 쓸 수 없다.
//
// 펴지는 대상은 입력이 아니라 껍데기다. 드롭다운이 그 껍데기에 매달려 있어서, 입력만
// 띄우면 결과 목록은 34px짜리 아이콘 칸에 매달린 채 남는다 — 좁은 폭에서만 검색이
// 반쪽이 되는 갈래라 눈으로는 좀처럼 안 걸린다.
assert(/\.app-header \.search-shell:focus-within\s*\{/u.test(style), '접힌 검색은 초점이 오면 펼쳐져야 합니다');
assert(/\.app-header \.search-shell:focus-within \.search input\s*\{[^}]*width:\s*100%/u.test(style), '펴진 껍데기 안에서 입력도 폭을 되찾아야 합니다');

// 접힌 사이드바는 사라지지 않고 아이콘 레일로 좁아진다.
assert(theme.includes('--nav-rail-Width'), '레일 폭 토큰이 있어야 합니다');
assert(/body\.nav-collapsed \.workspace-shell\s*\{[^}]*var\(--nav-rail-Width\)/u.test(style), '접으면 레일 폭으로 좁아져야 합니다');
assert(!/body\.nav-collapsed \.navigation-panel\s*\{[^}]*display:\s*none/u.test(style), '접은 사이드바를 숨기면 다시 펼 손잡이가 사라집니다');
assert(style.includes('body.nav-collapsed .nav-label'), '접히면 라벨만 사라지고 아이콘은 남아야 합니다');
assert(html.includes('class="nav-icon"'), '레일에 남을 아이콘이 필요합니다');
assert(app.includes("el('collapse-nav').addEventListener"), '접기 손잡이는 접히는 대상 옆에 있어야 합니다');

// peek은 흐름 밖에서 오른쪽을 덮으므로 본문이 그 아래에 가려진다.
assert(/body\.peek-open \.main-content\s*\{[^}]*padding-right:\s*calc\(var\(--peek-Width\)/u.test(style), 'peek이 덮은 만큼 본문 중심이 왼쪽으로 옮겨가야 합니다');

// 접기 버튼은 class만 토글한다. 받는 CSS가 없으면 아무 일도 일어나지 않는다.
for (const name of ['nav-collapsed', 'context-collapsed']) {
  assert(style.includes(`body.${name}`), `${name} 상태를 받는 CSS 규칙이 필요합니다`);
  assert(new RegExp(`body\\.${name} \\.workspace-shell\\s*\\{[^}]*grid-template-columns`, 'u').test(style), `${name}은 셸의 열 정의를 바꿔야 합니다`);
  assert(!new RegExp(`body\\.${name} \\.(?:navigation|context)-panel\\s*\\{[^}]*display:\\s*none`, 'u').test(style), `${name}에서 패널을 숨기면 다시 펼 손잡이가 사라집니다`);
}
// 양쪽 다 레일로 좁아진다. 한쪽만 그러면 접는 동작이 자리마다 다르게 느껴진다.
assert(/body\.context-collapsed \.workspace-shell\s*\{[^}]*var\(--nav-rail-Width\)/u.test(style), 'Context도 레일로 좁아져야 합니다');
assert(style.includes('body.context-collapsed #collapse-context'), '접힌 Context에도 펼 손잡이가 남아야 합니다');

// :not()의 특이도는 인자를 따라간다. 두 번 겹친 (0,2,1)이 .search input(0,1,1)을 이겨
// 컴포넌트의 테두리 제거가 통째로 무시됐다. :where()로 감싸 요소 하나의 특이도로 되돌린다.
assert(!/input:not\(\[type=/u.test(style), '전역 input 규칙은 컴포넌트 규칙을 이기면 안 됩니다');
assert(style.includes("input:not(:where([type='checkbox'], [type='radio']))"), '전역 input 규칙은 :where()로 특이도를 낮춰야 합니다');
assert(style.includes('.search input'), '.search input 규칙이 있어야 합니다');

// 태스크 peek은 속성 패널 폭으로는 완료조건이 읽히지 않는다.
assert(app.includes("classList.add('peek-open')"), '태스크를 열면 읽을 폭을 확보해야 합니다');
// 예전에는 tasks와 people을 한꺼번에 허용해, 태스크 peek을 연 채 People로 가면
// 패널이 그대로 남았다. 남기는 조건은 아래 PEEK_VIEWS 단정이 맡는다.
assert(!app.includes("view !== 'tasks' && view !== 'people'"), '화면 종류를 묶어서 허용하면 서로의 패널이 남습니다');
// 사람도 태스크와 같은 방식으로 옆에서 연다. 화면을 갈아치우면 명단 맥락을 잃는다.
assert(app.includes('function personDetailHtml'), '사람은 옆에서 열려야 합니다');
assert(app.includes('data-person='), '명단 항목이 선택 가능해야 합니다');
assert(html.includes('id="roles" class="person-list"'), '역할은 책임 문장이 길어 카드가 아니라 행이어야 합니다');
assert(style.includes('.person-row'), '명단 행 스타일이 필요합니다');
// 열로 만들어 밀어내면 peek을 넓힐수록 목록이 좁아져 둘 다 못 읽는다. 겹쳐야 한다.
assert(/body\.peek-open \.context-panel\s*\{[^}]*position:\s*fixed/u.test(style), 'peek은 본문을 밀어내지 말고 덮어야 합니다');
assert(/body\.peek-open \.context-panel\s*\{[^}]*width:\s*var\(--peek-Width\)/u.test(style), 'peek 폭은 토큰으로 정의해야 합니다');
assert(/--peek-Width:\s*clamp\(\d+px,\s*50vw/u.test(theme), 'peek은 화면의 절반을 차지해야 합니다');
// 패널을 흐름에서 빼면 남은 열도 같이 정리해야 빈 자리가 남지 않는다.
assert(/body\.peek-open \.workspace-shell\s*\{[^}]*grid-template-columns:\s*var\(--nav-Width\) minmax\(0, 1fr\)/u.test(style), 'peek이 열리면 셸은 두 열이어야 합니다');
// 덮는 UI는 닫는 길이 분명해야 한다.
assert(app.includes('function closePeek'), 'peek을 닫는 경로가 하나로 모여야 합니다');
assert(app.includes("event.key === 'Escape'"), 'Esc로 peek을 닫을 수 있어야 합니다');
assert(app.includes("event.target.closest('.context-panel')"), '바깥을 누르면 peek이 닫혀야 합니다');

// flex/grid 자식의 기본 min-width는 내용 크기다. 줄이지 않으면 사이드바를 밀고 나간다.
assert(/\.search\s*\{[^}]*min-width:\s*0/u.test(style), '검색 상자는 사이드바 폭 안에서 줄어야 합니다');
assert(/\.search input\s*\{[^}]*min-width:\s*0/u.test(style), '검색 입력은 기본 min-width를 버려야 합니다');
assert(/\.navigation-panel,\s*\.context-panel\s*\{[^}]*min-width:\s*0/u.test(style), '탐색 패널은 열 폭을 넘지 않아야 합니다');

// 한 줄 추가는 없앴다. 완료조건 없이 보내 API가 항상 400으로 되돌리고 있었고, 완료조건을
// 한 줄에 끼워 넣으면 빠르지도 않으면서 대충 적게 만든다. 만드는 길은 다이얼로그 하나다.
assert(!html.includes('id="quick-add"'), '한 줄 추가는 두지 않습니다');
assert(!app.includes("el('quick-add')"), '한 줄 추가 처리기가 남으면 안 됩니다');
assert(html.includes('id="new-task"'), '태스크를 만드는 길은 있어야 합니다');
assert(html.includes('id="task-acceptance"'), '생성 다이얼로그가 완료조건을 받아야 합니다');

// 편집 중 스냅샷을 갈아끼우면 draft가 최신 revision을 달고 저장되어 남의 변경을 덮어쓴다.
// 표시 규칙 편집도 같은 자리에 선다 — 칸에 적던 값이 사라지는 것보다, baseRevision이
// 소리 없이 바뀌어 무엇을 기준으로 저장하는지 흐려지는 쪽이 더 나쁘다.
const load = app.slice(app.indexOf('async function loadSnapshot'), app.indexOf('async function loadSnapshot') + 900);
// 댓글을 쓰는 중에도 같은 자리에 선다. 편집기 인스턴스는 다시 그리기에 통째로 버려지므로,
// 폴링 한 번이 쓰던 글을 지우는 일이 된다.
const guard = 'if (isDocumentEditing() || isPresentationEditing() || isCommentComposing()) return;';
assert(load.includes(guard), '편집 중에는 스냅샷을 교체하지 않아야 합니다');
assert(load.indexOf(guard) < load.indexOf('state.snapshot = next'), '가드가 교체보다 먼저여야 합니다');

// ✓와 ○는 같은 자리에 같은 크기로 그려져 멀리서 구분되지 않았고, 20px 글리프만
// 누를 수 있어 계속 빗나갔다. 행 전체를 버튼으로 두고 상태는 네모칸으로 그린다.
assert(app.includes('class="acceptance-item') && app.includes('data-task-acceptance'), '완료조건 행 전체가 버튼이어야 합니다');
assert(!app.includes('acceptance-toggle'), '작은 글리프 버튼은 남기지 않습니다');
assert(app.includes('acceptance-box'), '완료 상태는 네모칸으로 보여야 합니다');
assert(/\.acceptance-item\.done \.acceptance-box\s*\{[^}]*background:\s*var\(--accent-BackgroundColor\)/u.test(style), '완료된 칸은 채워져야 합니다');
assert(/\.acceptance-item\.done \.acceptance-box::after/u.test(style), '완료된 칸에는 체크가 있어야 합니다');
assert(/\.acceptance-item:hover/u.test(style), '행 전체가 눌린다는 것이 보여야 합니다');

// peek에서 display를 block으로 되돌리면 세로 flex가 풀려 본문에 높이 제약이 사라지고,
// 내용이 패널 밖으로 자라 overflow: hidden에 잘려 스크롤이 아예 생기지 않는다.
assert(/body\.peek-open \.context-panel\s*\{[^}]*display:\s*flex/u.test(style), 'peek에서도 세로 flex를 유지해야 스크롤됩니다');
assert(!/body\.peek-open \.context-panel\s*\{[^}]*padding:/u.test(style), '여백은 패널이 아니라 각 칸이 갖습니다');
// height:auto가 top·bottom에서 풀리기를 기대하면 안 된다. 그 해석이 어긋나는 순간
// 패널이 내용 높이로 자라고 안쪽 flex:1이 잡을 기준이 사라져 스크롤이 통째로 죽는다.
assert(/body\.peek-open \.context-panel\s*\{[^}]*height:\s*calc\(100vh - var\(--header-Height\)\)/u.test(style), 'peek 높이는 못박아야 합니다');
assert(!/body\.peek-open \.context-panel\s*\{[^}]*height:\s*auto/u.test(style), 'peek 높이를 auto로 두면 스크롤이 죽습니다');

// 덮고 있을 때는 접는 게 아니라 닫는 것이다. ›는 옆으로 민다는 뜻이라 맞지 않는다.
assert(html.includes('class="when-peek"') && html.includes('class="when-docked"'), '덮을 때와 붙어 있을 때의 손잡이가 달라야 합니다');
assert(style.includes('body.peek-open .when-peek'), '덮을 때는 ×를 보여야 합니다');
assert(html.includes('id="expand-context"'), '× 옆에 크게 보기가 있어야 합니다');
assert(app.includes("el('expand-context').addEventListener"), '크게 보기가 동작해야 합니다');
assert(app.includes("dataset.peekKind = 'task'") && app.includes("dataset.peekKind = 'person'"), 'peek에 담긴 것이 무엇인지 표시해야 합니다');
assert(style.includes("body.peek-open[data-peek-kind='task'] #expand-context"), '전체화면이 없는 대상에는 크게 보기를 띄우지 않습니다');

// 스크롤해도 지금 무엇을 보고 있는지와 접는 손잡이를 잃지 않아야 한다.
assert(/\.navigation-panel,\s*\.context-panel\s*\{[^}]*flex-direction:\s*column/u.test(style), '패널은 머리글과 본문을 나눠야 합니다');
assert(/\.sidebar-body,[^{]*\{[^}]*overflow:\s*auto/u.test(style), '패널은 본문만 스크롤해야 합니다');
assert(/\.task-detail-head\s*\{[^}]*position:\s*sticky/u.test(style), '태스크 제목은 스크롤해도 남아야 합니다');
assert(style.includes('body.view-task .task-detail-head'), '전체화면에서는 앱 헤더 아래에 붙어야 합니다');
// 목록을 한참 내려간 뒤에도 어느 화면인지와 주요 동작을 잃지 않아야 한다. 다만 그것은
// 목록의 제목 줄에만 해당한다 — 한 줄이라 붙어도 화면을 거의 안 먹는다.
//
// 문서 머리는 여기서 빠졌다. 전에는 같은 규칙을 나눠 쓰며 함께 붙어 있었는데, 그 블록은
// breadcrumb·제목·설명·배지 줄·승인 원장 줄을 다 담아 실측 249px이고 670px 창의 37%다.
// 읽으라고 연 화면에서 읽을 자리를 그만큼 계속 가져가는 값이 붙임이 주는 값을 넘지
// 못한다. 대가는 승인 단추가 위로 흘러가는 것이고, 그 왕복이 문제가 되면 249px을 붙이는
// 대신 좁은 띠를 따로 세운다.
assert(/\.page-heading\s*\{[^}]*position:\s*sticky/u.test(style), '목록 제목 줄은 스크롤 중 남아야 합니다');
assert(/\.page-heading\s*\{[^}]*top:\s*var\(--header-Height\)/u.test(style), '목록 제목은 앱 헤더 아래에 붙어야 합니다');

// 문서 Context의 「연결 태스크」. 클래스 없는 맨 button이라 전역 button 규칙의 고정
// 높이(--control-Height)와 white-space: nowrap을 그대로 물려받고 있었다. 그러면 제목이
// 접히지 못하고 옆으로 자란다 — 267px 칸에서 438px까지 나가, #context-content가
// overflow: auto인 탓에 그 넘침이 패널 전체의 가로 스크롤이 되고 속성표와 검증 묶음까지
// 함께 옆으로 끌려갔다. 카드끼리 여백도 0px이라 테두리가 맞붙어 한 덩어리로 읽혔다.
// jsdom은 레이아웃을 못 재므로 그 넘침을 만들었던 규칙 자체를 잡는다.
assert(app.includes('class="linked-task-list"'), '연결 태스크는 제 상자에 담아야 세로 간격을 줄 자리가 생깁니다');
assert(app.includes('class="linked-task-card"'), '카드 클래스가 있어야 전역 button 규칙을 되돌릴 수 있습니다');
assert(/\.linked-task-list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u.test(style), '트랙을 못박지 않으면 암시적 트랙이 max-content가 되어 카드가 칸보다 넓어집니다');
assert(/\.linked-task-list\s*\{[^}]*gap:\s*var\(--spacing-/u.test(style), '카드 사이 간격은 간격 토큰이어야 합니다');
assert(!/\.linked-task-list\s*\{[^}]*gap:\s*\d/u.test(style), '간격에 임의의 px을 새로 적으면 안 됩니다');
assert(/\.linked-task-card\s*\{[^}]*white-space:\s*normal/u.test(style), '제목은 접혀야 합니다. nowrap이면 카드가 칸 밖으로 자랍니다');
assert(/\.linked-task-card,[^{]*\{[^}]*height:\s*auto/u.test(style), '고정 높이를 되돌려야 두 줄짜리 제목이 담깁니다');
assert(style.indexOf('.linked-task-card,') < style.indexOf('.linked-task-card {'), '되돌리는 규칙이 앞에 서야 같은 특이도에서 카드 규칙이 이깁니다');
// 넘침은 감추는 것이 아니라 갈 곳을 주는 것이다. 잘라 내면 그 안의 내용이 신호 없이 사라진다.
assert(!/\.linked-task-card\s*\{[^}]*overflow:\s*hidden/u.test(style), '카드가 제목을 잘라 내면 안 됩니다');
assert(!/\.linked-task-card\s*\{[^}]*line-clamp/u.test(style), '제목을 몇 줄로 못박아 자르면 안 됩니다');

// 규칙만 맞고 마크업이 안 따라오면 카드는 그대로 깨진 채 남는다. 실제로 그 모양으로
// 그려지는지, 그리고 연결이 없을 때 빈 격자를 세우지는 않는지 함께 본다.
{
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  dom.window.fetch = () => new Promise(() => {});
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.eval(`${app}\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name, selected) { setView(name, selected); } };`);
  const documentValue = (id) => ({
    id, kind: 'adr', type: 'document', title: `문서 ${id}`, description: '설명', file: `docs/${id}.md`,
    state: 'accepted', owner: 'MEMBER-001', modifiedAt: '2026-08-20T00:00:00Z', revision: 'a'.repeat(64),
    body: '# 본문', tags: [], related: [],
    approval: { status: 'approved', approvedRevision: 'a'.repeat(64), approvedBy: 'MEMBER-001', approvals: 1, submission: { state: 'none', rejection: null } }
  });
  // 대괄호 접두어가 붙은 긴 제목이 이 결함을 드러낸 실제 모양이다(정본 144건 중 90건).
  const linkedTask = (id) => ({
    id, title: '[기능] 에이전트 발견 표면 — 태스크 목록·구조화 도움말·컨텍스트 명령',
    status: 'todo', priority: 'mid', owner: 'MEMBER-001', links: ['ADR-100'], acceptanceCriteria: {}
  });
  dom.window.__probe.snapshot({
    project: 'demo', documents: [documentValue('ADR-100'), documentValue('ADR-101')],
    tasks: { tasks: [linkedTask('TASK-0001'), linkedTask('TASK-0002')] }, attention: [],
    people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
    presentation: { documentTypes: {}, documentStates: {} }, approvers: [],
    reviewQueue: { used: true, unknown: null, counts: { approved: 1, stale: 0, unapproved: 0 }, total: 1, rejected: 0, items: [] }
  });
  dom.window.__probe.view('document', 'ADR-100');
  const list = dom.window.document.querySelector('#context-content .linked-task-list');
  assert(list, '연결 태스크는 제 상자 안에 서야 합니다');
  assert.strictEqual(list.children.length, 2, '카드는 그 상자의 바로 밑 자식이어야 gap이 먹습니다');
  assert.strictEqual(list.querySelectorAll('.linked-task-card[data-task]').length, 2, '카드는 여전히 그 태스크로 가는 문이어야 합니다');
  assert(list.textContent.includes('컨텍스트 명령'), '제목을 접어 담는 것이지 뒤를 잘라 내는 것이 아닙니다');

  dom.window.__probe.view('document', 'ADR-101');
  assert.strictEqual(dom.window.document.querySelector('#context-content .linked-task-list'), null, '연결이 없는데 빈 상자를 세우면 격자만 남습니다');
  assert(dom.window.document.getElementById('context-content').textContent.includes('연결된 태스크 없음'), '연결이 없다는 사실은 그대로 말해야 합니다');
  dom.window.close();
}


// 참고 항목이 문서 유형 목록의 2열 격자에 걸려 레일에서 가운데로 서지 못했다.
assert(!/\.nav-list button,\s*\.utility-nav button\s*\{[^}]*grid-template-columns/u.test(style), '참고 항목은 문서 유형 목록과 배치가 다릅니다');

// 저장은 편집의 끝이다. 편집기를 열어둔 채 스냅샷을 부르면 isEditing() 가드에 걸려
// 갱신이 통째로 건너뛰어지고, 다음 저장이 오래된 revision으로 나가 409가 난다.
const saveStart = app.indexOf("el('save-document').addEventListener");
const save = app.slice(saveStart, app.indexOf('});', app.indexOf('catch', saveStart)));
assert(save.includes("el('document-editor').hidden = true"), '저장에 성공하면 편집 모드를 끝내야 합니다');
assert(save.indexOf("el('document-editor').hidden = true") < save.indexOf('loadSnapshot'), '편집을 끝낸 뒤에 스냅샷을 불러야 합니다');

// 보내는 동안 다시 누르면 그 변경은 같은 pending에 쌓인다. 지우면 유실되고, 남겨두면
// 낡은 revision으로 나가 409가 난다. 최신 revision을 받은 뒤에 다시 큐에 넣어야 한다.
assert(app.includes('function remainingChanges'), '전송 중 쌓인 변경을 따로 갈무리해야 합니다');
assert(app.includes('pending.sending'), '같은 태스크를 두 번 동시에 보내지 않아야 합니다');
{
  const flush = app.slice(app.indexOf('async function flushTaskUpdate'), app.indexOf('function takePendingTask'));
  assert(flush.indexOf('await loadSnapshot(true, { settlingTask: true })') < flush.indexOf('queueTaskUpdate(task, later)'), '남은 변경은 최신 revision을 받은 뒤에 보내야 합니다');
  assert(!flush.includes('setTimeout'), '스냅샷 갱신을 기다리지 않는 타이머로 이어 보내면 낡은 revision이 나갑니다');
  // 대기열을 스냅샷보다 먼저 비우면, 스냅샷을 받는 사이의 클릭이 갱신 전 revision으로
  // 새 대기열을 만든다. 그 요청은 낡은 revision을 달고 나가 409로 거절된다.
  assert(flush.indexOf('await loadSnapshot(true, { settlingTask: true })') < flush.indexOf('takePendingTask(taskId, sent)'), '대기열은 최신 revision을 받은 뒤에 비워야 합니다');
  assert(!flush.includes('state.pendingTasks.delete'), '대기열 정리는 takePendingTask 한 곳이 맡아야 합니다');
}
// 저장 직후 경로는 대기열이 남아 있어도 스냅샷을 갈아끼워야 새 revision을 받는다.
// 반면 문서 편집 중에는 어떤 경로에서도 갈아끼우지 않는다. draft의 base revision까지
// 최신이 되어 저장이 남의 변경을 조용히 덮어쓰기 때문이다.
assert(app.includes('function isDocumentEditing'), '두 가드는 성격이 달라 나뉘어야 합니다');
{
  const load = app.slice(app.indexOf('async function loadSnapshot'), app.indexOf('async function initialize'));
  assert(load.includes('if (isDocumentEditing() || isPresentationEditing() || isCommentComposing()) return;'), '문서 편집 가드는 우회 경로가 없어야 합니다');
  assert(/state\.pendingTasks\.size > 0 && !\(options && options\.settlingTask\)/u.test(load), '태스크 대기열 가드는 저장 직후 경로에서만 열려야 합니다');
}

// peek을 연 채 다른 화면으로 가면 선택은 풀리는데 패널이 남아, 없는 선택의 내용을
// 계속 보여주고 본문 폭까지 좁힌 채였다. 화면과 종류가 맞고 고른 항목이 있을 때만 남긴다.
assert(app.includes('const PEEK_VIEWS'), '어떤 화면이 어떤 peek을 갖는지 한곳에 두어야 합니다');
assert(app.includes('function dismissPeek'), '패널을 접는 일과 선택을 푸는 일은 나뉘어야 합니다');
{
  const mark = app.slice(app.indexOf('function markViewOnBody'), app.indexOf('function setView(view, selected)'));
  assert(/state\.selected && PEEK_VIEWS\[view\] === document\.body\.dataset\.peekKind/u.test(mark), 'peek은 선택과 종류가 모두 맞을 때만 남아야 합니다');
  assert(mark.includes('dismissPeek()'), '맞지 않으면 패널을 접어야 합니다');
  assert(!mark.includes('closePeek()'), 'setView가 이미 정한 선택을 여기서 다시 지우면 안 됩니다');
}

// 새로 만드는 태스크는 아직 끝나지도 접히지도 않았다. 종료 상태는 고를 수 없어야 한다.
assert(app.includes('!isTerminalStatus(value)'), '생성 화면에 종료 상태를 두면 안 됩니다');

// 명단만 다시 그리면 옆에 열어둔 사람의 태스크·문서 수가 예전 값으로 남는다.
assert(app.includes('function redrawPerson'), '열어둔 사람도 갱신되어야 합니다');
assert(app.includes("document.body.dataset.peekKind === 'person'"), '사람 peek이 열려 있을 때만 다시 그려야 합니다');

// 헤더와 패널은 같은 표면색이라 경계에서 붙어 보인다. 본문만 헤더에서 떨어져 시작하면
// 세 열의 시작선이 어긋난다. 패널 머리글도 본문과 같은 위 여백을 갖는다.
assert(/\.sidebar-head,\s*\.panel-title\s*\{[^}]*padding:\s*var\(--spacing-4\)/u.test(style), '패널 머리글도 본문과 같은 높이에서 시작해야 합니다');
assert(/\.main-content\s*\{[^}]*padding:\s*var\(--spacing-4\)/u.test(style), '본문 위 여백이 기준입니다');

// .view의 margin: 0 auto는 flex 세로 컨테이너 안에서 내용 크기로 줄어든다. 그래서 설정
// 탭을 옮길 때마다 폭이 265px씩 튀었다. 폭을 못박아야 고정된다.
assert(/body\.view-settings #settings-view\s*\{[^}]*width:\s*100%/u.test(style), '설정 화면 폭은 탭에 따라 변하면 안 됩니다');
assert(/body\.view-settings #settings-view\s*\{[^}]*display:\s*flex/u.test(style), '설정은 세로 flex로 나뉩니다');

// 내부 스크롤 상자가 여럿이라 막대가 화면 곳곳에 세로줄로 남는다. overflow는 건드리지
// 않으므로 휠·터치·키보드 이동은 그대로다.
// 앱 크롬에서만 감춘다. 전역으로 감추면 표·코드처럼 가로로 넘치는 내용에서 스크롤
// 가능 여부를 알 단서가 사라진다.
assert(style.includes('scrollbar-width: none'), '앱 크롬의 스크롤 막대는 감춥니다');
assert(!/^\*\s*\{[^}]*scrollbar-width:\s*none/mu.test(style), '전역으로 막대를 감추면 안 됩니다');
assert(style.includes('.context-panel::-webkit-scrollbar'), 'WebKit 계열에서도 크롬 막대를 감춰야 합니다');

// 같은 선택자를 두 곳에서 선언하면 어느 쪽이 이기는지 읽어야 알 수 있다. 이 파일에서
// 이 실수로 다섯 번 물렸다. 카드 설명은 두 줄 말줄임이어야 하는데 metric-grid 규칙에
// 딸려 들어가 display: grid로 덮여 있었다.
assert(!/\.person-card small,\s*\.metric-grid/u.test(style), '카드 설명이 metric-grid 규칙에 딸려 들어가면 안 됩니다');
assert(/\.entity-card small,\s*\.document-card small,\s*\.person-card small\s*\{[^}]*line-clamp/u.test(style), '카드 설명은 두 줄까지만 보입니다');
{
  // 최상위 규칙에서 같은 선택자가 같은 속성을 두 번 선언하는지 훑는다.
  // 리셋 후 다시 지정하는 것은 의도된 패턴이라 리셋 규칙은 제외한다.
  const stripped = style.replace(/\/\*[\s\S]*?\*\//gu, '');
  const rules = [];
  let depth = 0, start = 0, selector = '', inAt = false;
  for (let i = 0; i < stripped.length; i += 1) {
    if (stripped[i] === '{') {
      if (depth === 0) { selector = stripped.slice(start, i).trim(); inAt = selector.startsWith('@'); start = i + 1; }
      depth += 1;
    } else if (stripped[i] === '}') {
      depth -= 1;
      if (depth === 0) { if (!inAt) rules.push({ selector, body: stripped.slice(start, i) }); start = i + 1; }
    }
  }
  // 앞 규칙을 일부러 되돌리는 곳은 제외한다. 공통 필드·버튼 모양을 깔고 특정 컴포넌트가
  // 그중 몇 가지만 되돌리는 것은 의도된 패턴이다. 문제는 같은 대상을 두 곳에서
  // 따로 정의해 어느 쪽이 이기는지 읽어야 아는 경우다.
  const overrides = new Set(['textarea', 'select', 'button', 'input:not(:where([type=\'checkbox\']', '[type=\'radio\']))']);
  const isReset = (rule) => rule.body.includes('height: auto') && rule.body.includes('box-shadow: none');
  const seen = new Map();
  for (const rule of rules) {
    if (isReset(rule)) continue;
    for (const part of rule.selector.split(',').map((value) => value.trim()).filter(Boolean)) {
      if (overrides.has(part)) continue;
      const declared = new Set(rule.body.split(';').map((d) => d.split(':')[0].trim()).filter(Boolean));
      if (!seen.has(part)) { seen.set(part, declared); continue; }
      const before = seen.get(part);
      const clash = [...declared].filter((name) => before.has(name));
      assert.strictEqual(clash.length, 0, `${part}이 ${clash.join(', ')}를 두 번 선언합니다. 한곳에 모으세요.`);
      for (const name of declared) before.add(name);
    }
  }
}

// sendBeacon은 헤더를 실을 수 없어 토큰이 빠지고 서버가 403으로 버린다. 종료 시
// 임대를 풀던 keepalive 요청은 임대 폐기(ADR-015)와 함께 사라졌지만, sendBeacon 금지는
// 남는다 — 인증이 필요한 요청에 헤더를 못 싣는 수단을 쓰면 조용히 403이 된다.
assert(!app.includes('navigator.sendBeacon'), '인증이 필요한 요청에 sendBeacon을 쓰면 안 됩니다');

// 프로젝트 선택기는 사이드바에만 있다. 좁은 화면에서 레일을 강제하면 바꿀 길이 사라진다.
const narrow = style.slice(style.indexOf('@media (max-width: 720px)'));
assert(!/\.sidebar-head select[^{]*\{[^}]*display:\s*none/u.test(narrow), '좁은 화면에서 프로젝트 선택기를 감추면 안 됩니다');
assert(/\.workspace-shell,[^{]*\{[^}]*var\(--nav-Width\)/u.test(narrow), '좁은 화면에서도 기본은 펼친 사이드바여야 합니다');

// 계약과 태스크가 저장하는 값은 ASCII 식별자이고 화면에 보이는 말은 표시 규칙이 정한다.
// 둘을 섞으면 표기를 바꾸는 순간 저장된 계약이 깨진다. 예전 <option>lean</option>은
// 표시값이 곧 저장값이라 정확히 그 구조였다.
assert(!/<option>(lean|product|service|platform|assured)<\/option>/u.test(app), '프로필 선택지는 표시값을 저장값으로 쓰면 안 됩니다');
assert(!/<option value="(advisory|checkpoint)">\1<\/option>/u.test(app), '강제 수준 선택지는 표시값을 저장값으로 쓰면 안 됩니다');
for (const helper of ['policyStateLabel', 'enforcementLabel', 'taskStatusLabel', 'priorityLabel']) {
  assert(app.includes(`function ${helper}`), `${helper}로 저장값과 표시값을 갈라야 합니다`);
}
// 라벨은 표시 규칙에서 오고, 규칙에 없으면 저장값을 그대로 보여 준다(끊기지 않게).
assert(/function policyStateLabel\(value\) \{ return presentationLabel\('policyStates', value, value\); \}/u.test(app), '정책 상태 라벨은 표시 규칙에서 와야 합니다');
assert(!/\{ high: '높음', mid: '중간', low: '낮음' \}/u.test(app), '우선순위 라벨을 코드에 박아 두면 설정에서 바꿀 수 없습니다');

console.log('board UI tests passed');

// 저장 직후 경로는 대기열이 남아 있어도 스냅샷을 갈아끼운다. 그때 아직 보내지 않은 다른
// 태스크의 낙관적 변경이 서버 값으로 되돌아가면, 그 뒤 payload가 되돌아간 값을 기준으로
// 만들어져 먼저 누른 변경이 조용히 사라진다.
{
  const load = app.slice(app.indexOf('async function loadSnapshot'), app.indexOf('async function initialize'));
  assert(/for \(const \[taskId, pending\] of state\.pendingTasks\)/u.test(load), '스냅샷 교체 뒤 대기열을 다시 얹어야 합니다');
  assert(load.indexOf('state.snapshot = next') < load.indexOf('of state.pendingTasks'), '교체한 새 객체에 얹어야 합니다');
  assert(load.indexOf('of state.pendingTasks') < load.indexOf('setView(state.view'), '그리기 전에 얹어야 합니다');
}

// 프로젝트를 바꾸면 이전 프로젝트의 것은 무엇도 넘어오지 않아야 한다. 예약된 저장이 남으면
// 새 프로젝트 경로로 나가고, 열어 둔 패널은 지금 목록에 없는 항목을 계속 보여준다.
{
  const start = app.indexOf("el('project-switcher').addEventListener");
  const swap = app.slice(start, app.indexOf("el('current-member').addEventListener", start));
  assert(swap.includes('clearTimeout(pending.timer)'), '예약 타이머를 꺼야 합니다');
  assert(swap.includes('closePeek()'), '이전 프로젝트 패널을 닫아야 합니다');
  // 그냥 버리면 사용자가 눌렀다고 믿는 변경이 경고 없이 사라진다. 먼저 보내고, 못 보내면 알린다.
  assert(swap.includes('await flushTaskUpdate(taskId)'), '대기 중인 변경을 먼저 보내야 합니다');
  assert(/message\(`저장하지 못한 태스크 변경/u.test(swap), '버리는 변경이 있으면 알려야 합니다');
}

// 편집 UI만 있고 저장 경로가 없으면 눌러도 아무 일이 없다.
assert(app.includes("projectPath('/presentation')"), '프리셋 저장은 표시 설정 API로 나가야 합니다');
assert(app.includes('function presentationInput'), '이 범위에서 덮은 값만 보내야 합니다');
assert(app.includes('function currentSectionsFromRows'), '화면의 하부 요소를 모아야 합니다');

// ── 검토 인박스 ─────────────────────────────────────────────────────────────
//
// 0.43.0부터 스냅숏은 reviewQueue를 싣는데 화면은 그 값을 한 번도 읽지 않았다. 서버는
// 답을 내고 있는데 그 답을 볼 자리가 없었다는 뜻이고, 그래서 승인은 계속 밀렸다.
assert(html.includes('id="review-inbox-view"'), '검토 인박스 화면이 있어야 합니다');
assert(html.includes('data-view="review-inbox"'), '탐색에 검토 인박스로 가는 길이 있어야 합니다');
assert(app.includes("else if (state.view === 'review-inbox') renderReviewInbox();"), '화면 전환이 이 화면을 그려야 합니다');
// 태스크 축과 문서 축은 세는 대상이 다르다. 한 수로 합치면 어느 쪽을 처리해야 줄이
// 줄어드는지가 화면에서 사라진다 — 이름부터 갈라 놓아야 두 수가 같은 것으로 읽히지 않는다.
assert(app.includes("'검토 요청 태스크'") && app.includes("'검토 대기 문서'"), '두 축의 요약은 이름이 갈려야 합니다');
assert(style.includes('.review-inbox-row'), '검토 인박스 행 스타일이 필요합니다');
{
  const render = app.slice(app.indexOf('function reviewRowHtml'), app.indexOf('function reviewVisibleItems'));
  // 서버는 낡음을 앞에 두고 이미 정렬해 보낸다. 화면이 다시 정렬하면 두 순서가 갈리고,
  // 그때 화면이 말하는 "먼저 볼 것"은 근거 없는 순서가 된다.
  assert(!render.includes('.sort('), '서버가 정한 순서를 화면이 다시 정하면 안 됩니다');
  // 판정을 새로 짓지 않는다. 리비전을 비교하는 순간 rdl doc status와 보드가 같은 문서에
  // 다른 답을 내고, 그때 사람이 믿는 쪽은 화면이다.
  assert(!render.includes('revision'), '화면이 승인 판정을 다시 지으면 안 됩니다');
  // 줄의 첫 동작이 바뀌었다. 오래 이 자리는 그 줄에서 펼치는 손잡이였고 펼치면 차분과
  // 승인 폼이 나왔는데, 본문은 그 안 어디에도 없었다 — 차분은 "무엇이 바뀌었나"에만
  // 답하고 "이게 맞는 문서인가"는 본문에만 있다. 근거 어휘에 read(읽고 판단했다)를 두고
  // 읽을 자리를 주지 않은 채 그것을 고르게 하고 있었다는 뜻이라, 줄은 이제 본문이 보이는
  // 검토 자리로 데려간다. 그 자리는 문서 상세이고 승인 판은 본문 옆에 선다.
  assert(render.includes('data-document='), '줄을 누르면 그 문서의 검토 자리로 가야 합니다');
  assert(render.includes('data-review-origin='), '인박스에서 왔다는 것이 그 길에 실려야 합니다');
  assert(!render.includes('data-approve-open='), '본문 없는 자리에서 승인을 받으면 안 됩니다');
  assert(!render.includes('approvalPanelHtml'), '승인 판은 본문이 있는 화면에만 서야 합니다');
}
// 문서로 가는 길은 여전히 하나다. 인박스에서 왔는지는 그 길에 얹은 표식으로만 갈린다 —
// 경로를 둘로 파면 온 곳의 차이가 아니라 화면 전체가 갈리고, 그때 두 길 중 한쪽만
// 고쳐지는 날이 온다.
assert.strictEqual(app.split("setView('document', button.dataset.document)").length - 1, 1, '문서로 가는 길은 하나여야 합니다');
assert(app.includes('state.reviewFrom = button.dataset.reviewOrigin ? button.dataset.document : null;'), '온 곳은 그 하나의 길에 얹은 표식으로 갈라야 합니다');

// 여기부터는 글자가 있는지가 아니라 실제로 무엇이 그려지는지를 본다. 이 화면이 가르는
// 갈래 셋(승인 축을 안 쓰는 프로젝트 · 원장을 못 읽은 경우 · 줄이 잘린 경우)은 어느 것도
// 문자열이 파일에 있다는 것만으로는 지켜지지 않는다 — 어느 갈래로 갔는가가 답이기 때문이다.
{
  const { JSDOM } = require('jsdom');
  function mount() {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    // 부팅을 첫 await에서 세워 둔다. 여기서 보는 것은 부팅이 아니라 그리기이고, 부팅이
    // 거절되면 그 실패가 창을 닫은 뒤에 안내를 그리려다 시험 프로세스를 통째로 죽인다.
    // app.js는 'use strict'라 eval 안의 선언이 밖으로 새지 않으므로, 밖에서 고쳐 끼울 수
    // 있는 자리는 창의 전역뿐이다 — 그래서 둘 다 eval 전에 세운다.
    dom.window.fetch = () => new Promise(() => {});
    // jsdom은 matchMedia를 갖지 않는다. 없으면 부팅이 첫 await에 닿기도 전에 던진다.
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // const는 그 eval의 렉시컬 스코프에만 산다. state를 만지려면 같은 문자열 끝에
    // 붙어야 하고, 그래서 손잡이도 여기서 함께 만든다.
    dom.window.eval(app + '\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name, selected) { setView(name, selected); } };');
    return dom;
  }
  function snapshot(reviewQueue, documents) {
    return {
      project: 'demo', documents: documents || [], tasks: { tasks: [] }, attention: [],
      people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
      presentation: { documentTypes: {}, documentStates: {} },
      // 승인 자격자가 없으면 판이 폼 대신 "자격자가 없습니다"만 그린다. 판이 열렸는가는
      // 그때도 확인할 수 있지만, 그 화면은 이 갈래에서 보려는 화면이 아니다.
      approvers: [{ id: 'CLIENT-1', name: '개발용' }],
      reviewQueue
    };
  }
  // 줄에 선 문서의 상세. 스냅숏의 documents와 reviewQueue.items는 같은 문서의 다른 축이라
  // 한쪽만 채우면 줄을 눌러 도착한 화면이 빈 문서가 된다 — 실제 서버는 둘을 함께 싣는다.
  function queueDocuments(items) {
    return items.map((item) => ({
      id: item.id, kind: 'adr', title: item.title, description: '설명', file: 'docs/a.md',
      state: 'accepted', owner: 'MEMBER-001', modifiedAt: '2026-08-20T00:00:00Z', revision: 'a'.repeat(64),
      body: `# ${item.id}\n\n읽어야 할 내용이 여기 있다.`, tags: [], related: [],
      approval: {
        status: item.status, approvedRevision: 'b'.repeat(64), approvedBy: item.approvedBy,
        approvals: item.approvals, submission: { state: 'none', rejection: null }
      }
    }));
  }
  // 대기 시각은 서버가 싣는 값이고 줄의 순서를 정하는 축이다. 시험이 그 값을 안 주면
  // 여기서 그리는 모든 줄이 "대기 시간 모름"으로 서고, 그러면 값이 있는 줄과 없는 줄을
  // 가르는 갈래를 이 파일이 확인하지 못한다.
  function queueItems(count, staleCount, prefix) {
    const items = [];
    for (let index = 0; index < count; index += 1) {
      const stale = index < staleCount;
      items.push({
        status: stale ? 'stale' : 'unapproved', id: `${prefix || 'ADR'}-${String(index).padStart(3, '0')}`,
        type: 'adr', title: `${prefix || '문서'} ${index}`, file: 'docs/a.md',
        approvedBy: stale ? 'MEMBER-001' : null, approvals: stale ? 2 : 0,
        waitingSince: new Date(Date.UTC(2026, 0, 1) + index * 3600000).toISOString()
      });
    }
    return items;
  }
  function open(queue, documents, view) {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot(queue, documents));
    dom.window.__probe.view(view || 'review-inbox');
    return dom;
  }
  const rowsOf = (dom) => Array.from(dom.window.document.querySelectorAll('#review-inbox-list .review-inbox-row'));
  const textOf = (dom, id) => dom.window.document.getElementById(id).textContent;

  // 1) 줄은 통째로 오고 화면이 접는다. 예전에는 서버가 앞 50건에서 잘랐고, 잘린 뒤는
  //    화면 어디에서도 볼 수 없어 명령으로만 봤다 — 잘려서 없는 것과 접혀서 안 그린 것은
  //    다르고, 뒤엣것은 목록 끝의 「더 보기」가 그 자리에서 편다. 셈은 여전히 전건이다.
  {
    const dom = open({ used: true, unknown: null, counts: { approved: 84, stale: 10, unapproved: 123 }, total: 133, rejected: 0, items: queueItems(133, 10) }, []);
    const summary = textOf(dom, 'review-inbox-summary');
    assert(summary.includes('133건 중 25건'), `접은 사실을 말해야 합니다: ${summary}`);
    assert(summary.includes('133') && summary.includes('10') && summary.includes('123') && summary.includes('84'), '전건 셈 넷이 헤더에 있어야 합니다');
    const rows = rowsOf(dom);
    assert.strictEqual(rows.length, 25, '한 번에 그리는 만큼만 그려야 합니다');
    // 서버가 낡음을 앞에 두고 보냈다. 그 순서가 그대로 살아 있어야 한다.
    assert.deepStrictEqual(rows.slice(0, 10).map((row) => row.querySelector('.tag').textContent), new Array(10).fill('낡음'), '낡음이 먼저여야 합니다');
    assert.strictEqual(rows[10].querySelector('.tag').textContent, '미승인', '미승인은 낡음 뒤에 서야 합니다');
    // 행의 첫 동작은 그 문서의 검토 자리로 가는 것이다. 그 자리에서 펼치던 때에는 본문
    // 없이 승인을 받았고, 그것은 승인 근거로 read(읽고 판단했다)를 고를 수 있는 화면이
    // 정작 읽을 자리를 주지 않았다는 뜻이다.
    assert.strictEqual(rows[0].dataset.document, 'ADR-000', '행은 그 문서로 가는 손잡이여야 합니다');
    assert.strictEqual(rows[0].dataset.reviewOrigin, '1', '인박스에서 왔다는 표식이 행에 있어야 합니다');
    assert.strictEqual(rows[0].dataset.approveOpen, undefined, '본문 없는 자리에서 승인 폼을 펼치면 안 됩니다');
    assert(rows[0].textContent.includes('강윤정') && rows[0].textContent.includes('승인 2회'), '승인자와 승인 횟수가 행에 있어야 합니다');
    assert(rows[10].textContent.includes('승인 이력 없음'), '미승인 행은 빈 칸이 아니라 없다고 적어야 합니다');
    // 거르개의 수는 전건이다. 목록의 길이를 적으면 잘린 줄에서 두 수가 어긋난다.
    assert(textOf(dom, 'review-inbox-filter').includes('낡음 10') && textOf(dom, 'review-inbox-filter').includes('미승인 123'), '거르개는 전건을 세어야 합니다');
    // 나머지는 그 자리에서 펴진다. 예전에는 잘린 뒤가 화면에 아예 없어 명령으로만 봤다.
    assert.strictEqual(dom.window.document.querySelector('[data-review-expand]').textContent, '108개 더 보기', '남은 수를 손잡이에 적어야 합니다');
    dom.window.document.querySelector('[data-review-expand]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(rowsOf(dom).length, 133, '더 보기는 나머지를 끝까지 펴야 합니다');
    dom.window.document.querySelector('[data-review-filter="stale"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(rowsOf(dom).length, 10, '낡음만 남아야 합니다');
    // 거르개를 바꾸면 편 상태가 풀린다. 다른 갈래는 다른 목록이라, 낡음 10건을 보려고 편
    // 것이 미승인 123건에 그대로 걸리면 사람이 요청하지 않은 벽이 선다.
    dom.window.document.querySelector('[data-review-filter="unapproved"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(rowsOf(dom).length, 25, '거르개를 바꾸면 다시 접혀야 합니다');
    dom.window.close();
  }

  // 2) 거른 뒤에도 접힘은 그 갈래의 수로 말한다. 전체 기준으로만 말하면 낡음 60건 중
  //    25건을 보면서 화면은 아무 말도 하지 않게 된다.
  {
    const dom = open({ used: true, unknown: null, counts: { approved: 0, stale: 60, unapproved: 5 }, total: 65, rejected: 0, items: queueItems(65, 60) }, []);
    dom.window.document.querySelector('[data-review-filter="stale"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert(textOf(dom, 'review-inbox-summary').includes('60건 중 25건'), '거른 갈래의 접힘도 말해야 합니다');
    dom.window.close();
  }

  // 2-1) 거르개는 줄 전체에서 고른다. 예전에는 서버가 앞 50건만 실었고 화면은 그 50건을
  //      걸렀다 — 미승인이 149건인 이 저장소에서 SCR·STD·TST로 시작하는 문서는 "미승인만"을
  //      눌러도 한 건도 나타나지 않았다. 검증 문서만 47건이 그랬다. 셈이 말하는 수와 눌러서
  //      닿을 수 있는 것이 다르면 요약은 막다른 길이 된다.
  {
    const items = queueItems(60, 2).concat(queueItems(47, 0, 'TST'));
    const dom = open({ used: true, unknown: null, counts: { approved: 0, stale: 2, unapproved: 105 }, total: 107, rejected: 0, items }, []);
    dom.window.document.querySelector('[data-review-filter="unapproved"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    dom.window.document.querySelector('[data-review-expand]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const ids = rowsOf(dom).map((row) => row.dataset.document);
    assert.strictEqual(ids.length, 105, '미승인 전건이 줄에 서야 합니다');
    assert.strictEqual(ids.filter((id) => id.startsWith('TST')).length, 47, '뒤쪽 유형에 거르개로 닿을 수 있어야 합니다');
    dom.window.close();
  }

  // 2-2) 대기 시간. 줄의 순서를 정하는 값이라 줄에 보여야 하고, 못 구한 것은 "모름"이라
  //      적어야 한다 — 빈 칸이나 "0분"으로 메우면 값이 없는 문서가 방금 올라온 것처럼
  //      보이고, 서버가 그런 줄을 맨 뒤로 보낸 이유가 화면에서 사라진다.
  {
    const day = 24 * 60 * 60 * 1000;
    const items = [
      { status: 'unapproved', id: 'ADR-001', type: 'adr', title: '오래 기다린 것', file: 'docs/a.md', approvedBy: null, approvals: 0, waitingSince: new Date(Date.now() - 3 * day).toISOString() },
      { status: 'unapproved', id: 'ADR-002', type: 'adr', title: '모르는 것', file: 'docs/b.md', approvedBy: null, approvals: 0, waitingSince: null }
    ];
    const dom = open({ used: true, unknown: null, counts: { approved: 0, stale: 0, unapproved: 2 }, total: 2, rejected: 0, items }, []);
    const rows = rowsOf(dom);
    assert(rows[0].textContent.includes('3일 기다림'), `기다린 시간이 줄에 보여야 합니다: ${rows[0].textContent}`);
    assert(rows[1].textContent.includes('대기 시간 모름'), '못 구한 값은 없다고 적어야 합니다');
    assert(rows[1].querySelector('.review-wait').classList.contains('unknown'), '모르는 것과 오래된 것을 같은 모양으로 그리면 안 됩니다');
    dom.window.close();
  }

  // 3) 원장을 못 읽은 경우. 이유를 삼키면 원장이 깨진 저장소와 원장을 안 쓰는 저장소가
  //    화면에서 같아 보이고, 앞엣것은 고쳐야 할 사고인데 아무도 그것을 모른다.
  {
    const reason = '이 작업공간은 승인 원장을 갖기 전 판입니다.';
    const dom = open({ used: false, unknown: reason, counts: null, total: 0, items: [] }, [{ id: 'ADR-001' }]);
    assert(textOf(dom, 'review-inbox-summary').includes(reason), '못 읽은 이유를 그대로 내야 합니다');
    assert.strictEqual(rowsOf(dom).length, 0, '모르는 것을 미승인으로 세어 늘어놓으면 안 됩니다');
    assert(dom.window.document.getElementById('review-inbox-list').hidden, '줄이 서지 않으면 목록도 없어야 합니다');
    assert(dom.window.document.getElementById('review-inbox-filter').hidden, '거를 것이 없으면 거르개도 없어야 합니다');
    dom.window.close();
  }

  // 4) 승인 축을 한 번도 쓰지 않은 프로젝트. 그때 문서 전건이 미승인으로 서는데, 그것을
  //    검토 대기 줄로 늘어놓으면 인박스가 첫날부터 문서 전건으로 차 정작 검토할 것을 가린다.
  //    근거는 스냅숏이 주고(used) 판단은 화면이 한다.
  {
    const documents = new Array(19).fill(0).map((value, index) => ({ id: `ADR-${index}` }));
    const dom = open({ used: false, unknown: null, counts: { approved: 0, stale: 0, unapproved: 19 }, total: 19, items: queueItems(19, 0) }, documents);
    const summary = textOf(dom, 'review-inbox-summary');
    assert(summary.includes('아직 승인을 관문으로 쓰지 않습니다'), `안내로 갈라야 합니다: ${summary}`);
    assert.strictEqual(rowsOf(dom).length, 0, '문서 전건을 줄로 늘어놓으면 안 됩니다');
    dom.window.close();
  }

  // 5) 홈 요약. 모를 때와 축을 안 쓸 때는 수를 내지 않는다 — 0은 "볼 것이 없다"는 거짓이고,
  //    그때의 문서 전건은 "전부 내 검토를 기다린다"는 거짓이다.
  {
    const ready = open({ used: true, unknown: null, counts: { approved: 1, stale: 2, unapproved: 3 }, total: 5, items: [] }, [], 'home');
    assert(textOf(ready, 'metrics').includes('5검토 대기 문서'), '쓰는 프로젝트에서는 줄의 길이를 낸다');
    ready.window.close();
    const unused = open({ used: false, unknown: null, counts: { approved: 0, stale: 0, unapproved: 3 }, total: 3, items: [] }, [], 'home');
    assert(textOf(unused, 'metrics').includes('—검토 대기 문서'), '축을 안 쓰면 수를 내지 않는다');
    unused.window.close();
    const unknown = open({ used: false, unknown: '읽지 못했습니다', counts: null, total: 0, items: [] }, [], 'home');
    assert(textOf(unknown, 'metrics').includes('—검토 대기 문서'), '모를 때도 수를 내지 않는다');
    unknown.window.close();
  }

  // 6) 줄을 누르면 문서 검토 자리로 간다. 오래 이 줄은 그 자리에서 펼쳐 차분과 승인 폼을
  //    냈고 본문은 어디에도 없었다 — 차분은 "무엇이 바뀌었나"에만 답하므로, 그 화면은
  //    승인 근거로 read(읽고 판단했다)를 고르게 하면서 정작 읽을 자리를 주지 않았다.
  //
  //    여기서 보는 것은 넷이고 어느 것도 문자열로는 지켜지지 않는다 — 본문이 서는가,
  //    판이 열린 채로 도착하는가, 돌아갈 곳이 인박스인가, 다음 차례가 화면에 있는가.
  {
    const items = queueItems(3, 1);
    const dom = open({ used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 2 }, total: 3, rejected: 0, items }, queueDocuments(items));
    const doc = dom.window.document;
    rowsOf(dom)[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(doc.getElementById('document-view').hidden, false, '줄을 누르면 문서 화면이 열려야 합니다');
    assert(doc.getElementById('document-body').textContent.includes('읽어야 할 내용'), '검토하러 온 자리에 본문이 있어야 합니다');
    // 판이 닫힌 채로 도착하면 본문 앞에서 한 번 더 눌러야 하고, 인박스에서 온 사람에게
    // 그 한 번은 이유가 없다 — 그 사람은 읽으러 온 것이 아니라 판정하러 왔다.
    assert(doc.body.classList.contains('approval-open'), '인박스에서 온 사람에게는 승인 판이 열려 있어야 합니다');
    assert(doc.getElementById('document-approval-panel').textContent.includes('검토하고 승인'), '옆으로 나온 판이 서야 합니다');
    // 돌아갈 곳은 문서 목록이 아니라 인박스다. 「문서」로 돌려보내면 훑던 줄과 걸어 둔
    // 거르개를 잃고, 그러면 인박스의 값이 한 건마다 사라진다.
    assert(doc.getElementById('document-breadcrumb').textContent.includes('검토 인박스'), 'breadcrumb은 왔던 곳으로 돌려보내야 합니다');
    const nav = doc.getElementById('document-review-nav');
    assert.strictEqual(nav.hidden, false, '줄을 훑는 띠가 서야 합니다');
    assert(nav.textContent.includes('1 / 3'), `줄의 어디쯤인지를 말해야 합니다: ${nav.textContent}`);
    assert.strictEqual(nav.querySelector('.review-nav-next').dataset.document, 'ADR-001', '다음 대기 건은 줄의 다음 줄이어야 합니다');

    // 다음 대기 건도 같은 길을 쓴다. 표식이 함께 실리지 않으면 두 번째 문서부터는 판이
    // 닫힌 채로 도착하고, 그때 사람은 자기가 무엇을 잘못 눌렀는지 찾게 된다.
    nav.querySelector('.review-nav-next').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert(doc.body.classList.contains('approval-open'), '다음 건에서도 판이 열려 있어야 합니다');
    assert(doc.getElementById('document-review-nav').textContent.includes('2 / 3'), '순번이 함께 움직여야 합니다');

    // 띠의 손잡이는 실제로 인박스를 연다. 줄도 그대로여야 한다 — 돌아온 곳이 다른 목록이면
    // 훑던 자리를 잃는 것은 매한가지다.
    doc.getElementById('document-review-nav').querySelector('[data-view="review-inbox"]')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(doc.getElementById('review-inbox-view').hidden, false, '띠의 손잡이는 인박스로 돌아가야 합니다');
    assert.strictEqual(rowsOf(dom).length, 3, '돌아온 줄은 그대로여야 합니다');
    dom.window.close();
  }

  // 6-2) 판정이 끝나면 이 문서는 줄에서 빠진다. 그때 순번을 그대로 두면 화면은 이미
  //      처리한 건을 아직 기다리는 것으로 말하고, 빈 칸으로 두면 방금 자기가 무엇을 했는지가
  //      사라진다. 빠졌다고 적고 다음 차례는 줄의 맨 앞으로 잡는다 — 서버가 급한 순으로
  //      정렬해 보냈으므로 그 앞이 곧 먼저 볼 것이다.
  {
    const items = queueItems(3, 1);
    const documents = queueDocuments(items);
    const dom = open({ used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 2 }, total: 3, rejected: 0, items }, documents);
    const doc = dom.window.document;
    rowsOf(dom)[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    // 승인이 나간 뒤 서버가 주는 것과 같은 줄. 처리한 건만 빠지고 나머지는 그대로다.
    const left = items.slice(1);
    dom.window.__probe.snapshot(Object.assign(snapshot({ used: true, unknown: null, counts: { approved: 1, stale: 0, unapproved: 2 }, total: 2, rejected: 0, items: left }, documents)));
    dom.window.__probe.view('document', 'ADR-000');
    const nav = doc.getElementById('document-review-nav');
    assert.strictEqual(nav.hidden, false, '줄에서 빠져도 돌아갈 길은 남아야 합니다');
    assert(nav.textContent.includes('이 줄에서 빠짐'), `방금 무엇을 했는지가 남아야 합니다: ${nav.textContent}`);
    assert(nav.textContent.includes('남은 2건'), '남은 줄의 길이를 말해야 합니다');
    assert.strictEqual(nav.querySelector('.review-nav-next').dataset.document, 'ADR-001', '빠진 뒤의 다음 차례는 줄의 맨 앞입니다');
    dom.window.close();
  }

  // 6-1) 문서 목록에서 그냥 열어 본 사람은 검토하러 온 것이 아니다. 그 사람에게 판을 열면
  //      읽으러 온 화면의 폭을 판이 가져가고, 줄의 순번을 보여 주면 자기가 서 있지도 않은
  //      줄을 읽게 된다. 온 곳을 가르지 못하면 이 둘이 한 화면으로 뭉개진다.
  {
    const items = queueItems(3, 1);
    const dom = open({ used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 2 }, total: 3, rejected: 0, items }, queueDocuments(items), 'documents');
    const doc = dom.window.document;
    doc.querySelector('#documents-list [data-document]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(doc.getElementById('document-view').hidden, false, '문서 목록의 줄도 문서를 열어야 합니다');
    assert.strictEqual(doc.body.classList.contains('approval-open'), false, '읽으러 온 사람의 본문 폭을 판이 가져가면 안 됩니다');
    assert.strictEqual(doc.getElementById('document-review-nav').hidden, true, '서 있지도 않은 줄의 순번을 보여주면 안 됩니다');
    assert(doc.getElementById('document-breadcrumb').textContent.includes('문서'), '문서 목록에서 온 사람은 문서 목록으로 돌아갑니다');
    dom.window.close();
  }
}

console.log('review inbox tests passed');

// ── 문서의 「내 차례」 ──────────────────────────────────────
//
// 태스크는 오래전부터 사람 축으로 좁혀졌는데(owner·reviewers) 문서에는 그 칸이 없어
// 검토 인박스가 프로젝트 전체를 셀다. 이 저장소에서는 159건이 한 벽으로 서고, 그중
// 지금 이 사람이 손댑 것이 무엇인지는 어느 화면에도 적혀 있지 않았다.
//
// 이 갈래가 묻는 것은 갈래를 잘 가르는가가 아니다 — 그것은 서버의 일이고 board 시험이
// 재다. 여기서 묻는 것은 화면이 그 값을 받아 무엇을 말하는가이고, 특히 사람을 안 고른
// 상태와 자격이 없는 상태를 0건으로 그리지 않는가다. 둘 다 0건으로 그리면 거짓이다.
{
  const { JSDOM } = require('jsdom');
  function mount() {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.eval(`${app}\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name, selected) { setView(name, selected); }, member(id) { state.currentMember = id; }, scope(value) { state.reviewScope = value; } };`);
    return dom;
  }
  // 서버가 실어 보내는 모양 그대로다(board.js의 documentTurns). 갈래의 말과 순서까지
  // 서버가 실는 이유는 화면이 require를 쓸 수 없어서고, 그래서 시험도 그 값을 준다.
  const lanes = [
    { key: 'awaiting', label: '나를 기다리는 것', hint: '읽고 승인하거나 반려합니다.', empty: '나에게 올라온 것이 없습니다.', requiresApprover: true },
    { key: 'restake', label: '내 승인이 쓰인 것', hint: '다시 승인할지 정합니다.', empty: '바뀜 것이 없습니다.', requiresApprover: false },
    { key: 'fix', label: '내가 고칠 것', hint: '고쳐서 다시 올립니다.', empty: '돌아온 내 문서가 없습니다.', requiresApprover: false }
  ];
  const day = 24 * 60 * 60 * 1000;
  const turnRows = [
    {
      status: 'stale', id: 'ADR-020', kind: 'adr', type: 'document', title: '설정 자유도', file: 'docs/adr/ADR-020.md',
      owner: 'MEMBER-001', approvedBy: 'MEMBER-001', approvals: 1,
      submission: { state: 'none', submittedBy: null, submittedAt: null, rejectedBy: null, rejectedAt: null, rejectedReason: null },
      waitingSince: new Date(Date.now() - 2 * day).toISOString(), lanes: { 'MEMBER-001': 'restake' }
    },
    {
      status: 'unapproved', id: 'REQ-090', kind: 'req', type: 'document', title: '올라온 요구', file: 'docs/req/REQ-090.md',
      owner: 'MEMBER-002', approvedBy: null, approvals: 0,
      submission: { state: 'pending', submittedBy: 'MEMBER-002', submittedAt: new Date(Date.now() - 5 * day).toISOString(), rejectedBy: null, rejectedAt: null, rejectedReason: null },
      waitingSince: new Date(Date.now() - 5 * day).toISOString(), lanes: { 'MEMBER-001': 'awaiting' }
    },
    {
      status: 'unapproved', id: 'REQ-091', kind: 'req', type: 'document', title: '반려된 요구', file: 'docs/req/REQ-091.md',
      owner: 'MEMBER-002', approvedBy: null, approvals: 0,
      submission: { state: 'rejected', submittedBy: 'MEMBER-002', submittedAt: new Date(Date.now() - 9 * day).toISOString(), rejectedBy: 'MEMBER-001', rejectedAt: new Date(Date.now() - day).toISOString(), rejectedReason: '근거 부족' },
      waitingSince: new Date(Date.now() - 9 * day).toISOString(), lanes: { 'MEMBER-002': 'fix' }
    }
  ];
  function snapshot(options) {
    const turns = (options || {}).turns === null ? undefined : Object.assign({
      used: true, unknown: null, lanes, approverMembers: ['MEMBER-001'], rows: turnRows
    }, (options || {}).turns || {});
    const value = {
      project: 'demo',
      documents: turnRows.map((row) => ({
        id: row.id, kind: row.kind, title: row.title, description: '설명', file: row.file,
        state: 'draft', owner: `[[project#^${row.owner}|이름]]`, modifiedAt: '2026-08-20T00:00:00Z', revision: 'a'.repeat(64),
        body: `# ${row.id}\n\n읽어야 할 내용이 여기 있다.`, tags: [], related: [],
        approval: { status: row.status, approvedRevision: 'b'.repeat(64), approvedBy: row.approvedBy, approvals: row.approvals, submission: { state: row.submission.state, rejection: null } }
      })),
      tasks: { tasks: [] }, attention: [],
      people: { members: [{ id: 'MEMBER-001', name: '강윤정' }, { id: 'MEMBER-002', name: '류승호' }], stakeholders: [], roles: [] },
      presentation: { documentTypes: {}, documentStates: {} },
      approvers: [{ id: 'CLIENT-1', name: '개발용', owner: 'MEMBER-001' }],
      reviewQueue: { used: true, unknown: null, counts: { approved: 1, stale: 1, unapproved: 2 }, total: 2, rejected: 1, items: turnRows.slice(0, 2), rejectedItems: turnRows.slice(2) }
    };
    if (turns) value.documentTurns = turns;
    return value;
  }
  function open(member, options) {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot(options));
    if (member) dom.window.__probe.member(member);
    dom.window.__probe.scope('mine');
    dom.window.__probe.view('review-inbox');
    return dom;
  }
  const lanesOf = (dom) => Array.from(dom.window.document.querySelectorAll('#review-inbox-list .turn-lane'));
  const textOf = (dom, id) => dom.window.document.getElementById(id).textContent;

  // 0) 범위 단추가 태스크와 같은 모양으로 서고, 주소에 실려 남에게 건네질 수 있어야 한다.
  //    같은 물음("내 차례가 뭔지")에 두 화면이 다른 모양으로 답하면 배우는 비용이 두 배다.
  {
    assert(html.includes('data-review-scope="mine"'), '검토 인박스에 「내 차례」 범위가 있어야 합니다');
    assert(html.includes('data-review-scope="all"'), '프로젝트 전체로 돌아가는 길이 있어야 합니다');
    const dom = mount();
    dom.window.__probe.snapshot(snapshot());
    dom.window.__probe.member('MEMBER-001');
    dom.window.__probe.view('review-inbox');
    assert(!dom.window.location.hash.includes('scope='), '기본 범위는 주소를 더럽힐 이유가 없습니다');
    dom.window.document.querySelector('[data-review-scope="mine"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert(dom.window.location.hash.includes('view=review-inbox'), '화면이 주소에 실려야 합니다');
    assert(dom.window.location.hash.includes('scope=mine'), '범위도 주소에 실려 복사해 남에게 줄 수 있어야 합니다');
    // 상태 거르개는 이 범위에서 내린다. 갈래가 이미 상태를 품고 있어(「내 승인이
    // 쓰인 것」은 언제나 낡음이다) 그 위에 상태 거르개를 얹으면 묶음 셋이 통째로 비는
    // 조합이 생기고, 그때 화면은 내 차례가 없다고 말한다.
    assert(dom.window.document.getElementById('review-inbox-filter').hidden, '갈래가 상태를 품은 범위에서는 상태 거르개가 서지 않습니다');
    dom.window.close();
  }

  // 1) 사람을 안 고른 상태를 0건으로 그리지 않는다. 태스크 화면이 같은 자리에 긋는
  //    선과 같고, 다만 좁히기 전의 줄로 돌아가는 길을 함께 둔다 — 개인화는 좁히는 것이지
  //    막는 것이 아니고, 프로젝트 전체 대기는 사람을 고르지 않아도 볼 수 있어야 한다.
  {
    const dom = open(null);
    const summary = textOf(dom, 'review-inbox-summary');
    assert(summary.includes('헤더에서 보기 기준을 고르면'), `사람을 고르라고 말해야 합니다: ${summary}`);
    assert.strictEqual(lanesOf(dom).length, 0, '사람을 고르기 전에 갈래를 0건으로 세우면 안 됩니다');
    const back = dom.window.document.querySelector('#review-inbox-summary [data-review-scope="all"]');
    assert(back, '좁히기 전의 줄로 돌아가는 길이 그 자리에 있어야 합니다');
    // 그 단추는 실제로 동작해야 한다. 다시 그려지는 자리에 선 단추가 아무 일도 안 하는
    // 것은 보이지 않는 결함이다 — 누를 수 있게 생겼으므로 사람은 누른다.
    back.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert(textOf(dom, 'review-inbox-heading').includes('검토 인박스'), '안내문 안의 길도 실제로 열려야 합니다');
    assert.strictEqual(dom.window.document.querySelectorAll('#review-inbox-list .review-inbox-row').length, 2, '프로젝트 전체 줄은 사람을 고르지 않아도 보입니다');
    dom.window.close();
  }

  // 2) 승인자의 화면. 갈래 셋이 각자 서고, 줄마다 왜 이 갈래인지·얼마나 기다렸는지·
  //    누가 관련되는지·그 자리로 가는 길이 있어야 한다. 네 중 하나라도 빠지면 줄은 "무언가
  //    있다"까지만 말하고, 그러면 문서를 열기 전까지 무엇을 할지 알 수 없다.
  {
    const dom = open('MEMBER-001');
    const sections = lanesOf(dom);
    assert.strictEqual(sections.length, 3, '갈래 셋은 비어도 그대로 섬니다');
    assert(sections[0].textContent.includes('나를 기다리는 것'), '갈래의 순서는 서버가 준 순서입니다');
    assert(sections[1].textContent.includes('내 승인이 쓰인 것'));
    assert(sections[2].textContent.includes('내가 고칠 것'));

    const awaiting = sections[0].querySelectorAll('.review-inbox-row');
    assert.strictEqual(awaiting.length, 1, '올라온 판은 승인자의 차례로 섭니다');
    assert.strictEqual(awaiting[0].dataset.document, 'REQ-090', '줄은 그 문서로 가는 손잡이여야 합니다');
    assert.strictEqual(awaiting[0].dataset.reviewOrigin, '1', '줄을 훑는 중이라는 표식이 길에 실려야 합니다');
    assert(awaiting[0].textContent.includes('류승호'), `누가 올렸는지가 줄에 있어야 합니다: ${awaiting[0].textContent}`);
    assert(awaiting[0].textContent.includes('5일 기다림'), '얼마나 기다렸는지가 줄에 있어야 합니다');

    const restake = sections[1].querySelectorAll('.review-inbox-row');
    assert.strictEqual(restake.length, 1);
    assert(restake[0].textContent.includes('내 승인 뒤 개정'), `왜 이 갈래인지가 줄에 있어야 합니다: ${restake[0].textContent}`);
    // 한 문서는 한 갈래에만 선다. 그래서 가져가지 않은 쪽의 사실(소유자도 나)은
    // 줄 안의 컨텍스트로 남아야 한다 — 남의 문서라면 재승인 여부만 정하면 되지만 내
    // 문서라면 고치는 것도 내 일이다.
    assert(restake[0].textContent.includes('소유자도 나'), '갈래가 가져가지 않은 사실이 줄에 남아야 합니다');

    // 줄의 칸 수는 인박스의 줄과 같아야 한다. 둘은 같은 격자(.review-inbox-row)를 쓰는데
    // 그 격자는 칸 일곱으로 잡혀 있어, 하나만 더해도 마지막 칸이 밀려 제목이 폭 0으로 눈린다.
    // 실제로 그랬고, 글자는 DOM에 그대로 있어 textContent를 재는 시험은 전부 통과했다 —
    // 보이지 않는 결함이라 칸 수 자체를 못박는다.
    {
      const inboxDom = mount();
      inboxDom.window.__probe.snapshot(snapshot());
      inboxDom.window.__probe.member('MEMBER-001');
      inboxDom.window.__probe.scope('all');
      inboxDom.window.__probe.view('review-inbox');
      const inboxRow = inboxDom.window.document.querySelector('#review-inbox-list .review-inbox-row');
      assert.strictEqual(restake[0].children.length, inboxRow.children.length,
        `「내 차례」의 줄과 인박스의 줄은 같은 칸을 갖어야 합니다: ${restake[0].children.length} ≠ ${inboxRow.children.length}`);
      // 제목은 줄이 답하는 "무엇인가"라 자리가 뒤로 밀려도 안 된다.
      assert.strictEqual(restake[0].querySelector('strong').textContent, '설정 자유도', '줄은 문서 제목을 갖는다');
      inboxDom.window.close();
    }

    // 이 사람의 차례가 아닌 줄은 서지 않는다. 서면 「내 차례」가 다시 프로젝트 전체가 된다.
    assert.strictEqual(sections[2].querySelectorAll('.review-inbox-row').length, 0, '남의 차례를 내 갈래에 세우면 안 됩니다');
    assert(sections[2].textContent.includes('돌아온 내 문서가 없습니다'), '비었을 때 할 말은 갈래마다 다릅니다');

    // 좁혔다는 사실이 화면에 남아야 한다. 좁힌 화면만 보면 "2건"이 적은 것인지
    // 많은 것인지 알 수 없고, 전체로 돌아가는 길도 사라진다.
    const summary = textOf(dom, 'review-inbox-summary');
    assert(summary.includes('2건'), `내 차례의 수를 말해야 합니다: ${summary}`);
    assert(summary.includes('프로젝트 전체'), '좁히기 전의 줄로 가는 길이 있어야 합니다');
    dom.window.close();
  }

  // 3) 승인자가 아닌 사람에게 「나를 기다리는 것」을 0건으로 보이면 안 된다. 0건은
  //    "지금은 볼 것이 없다"이고 자격 없음은 "앞으로도 여기에는 서지 않는다"라, 앞엎것으로
  //    그리면 그 사람은 오지 않을 줄을 계속 기다린다. 누가 승인자인지까지 말해야 다음 동작이 생긴다.
  {
    const dom = open('MEMBER-002');
    const sections = lanesOf(dom);
    assert(sections[0].textContent.includes('승인 자격이 있어야'), `자격과 0건을 가르지 못했습니다: ${sections[0].textContent}`);
    assert(!sections[0].textContent.includes('나에게 올라온 것이 없습니다'), '자격이 없는 것을 "볼 것이 없다"로 적으면 안 됩니다');
    assert(sections[0].querySelector('.badge').textContent.includes('\u2014'), '셀 수 없는 갈래에 0을 적으면 안 됩니다');
    const summary = textOf(dom, 'review-inbox-summary');
    assert(summary.includes('승인자가 아닙니다'), `자격이 없다는 사실을 말해야 합니다: ${summary}`);
    assert(summary.includes('강윤정'), '누가 승인할 수 있는지까지 말해야 다음 동작이 생깁니다');
    // 그래도 자기 갈래는 섬니다. 승인자가 아니라는 것과 할 일이 없다는 것은 다릅니다.
    const fix = sections[2].querySelectorAll('.review-inbox-row');
    assert.strictEqual(fix.length, 1, '자격이 없어도 내가 고칠 것은 내 차례입니다');
    assert(fix[0].textContent.includes('반려'), `왜 돌아왔는지가 줄에 있어야 합니다: ${fix[0].textContent}`);
    assert(fix[0].textContent.includes('근거 부족'), '무엇을 고쳐야 하는지가 줄에 있어야 합니다');
    // 반려된 문서의 "기다린 시간"은 차례가 작성자에게 넘어온 시각부터다. 올린
    // 시각(9일 전)에서 세면 이미 지나간 판을 기다린 시간이 지금 판의 것으로 적힌다.
    assert(fix[0].textContent.includes('1일 기다림'), `반려 시각부터 세야 합니다: ${fix[0].textContent}`);
    dom.window.close();
  }

  // 4) 줄을 훑는 띄도 좁힌 줄 안에서 답해야 한다. 프로젝트 전체에서 답하면 자기가 고른 적
  //    없는 남의 줄로 끌려가고, 그때 「다음 대기 건」은 훑던 자리를 잃게 만드는 단추가 된다.
  {
    const dom = open('MEMBER-001');
    const doc = dom.window.document;
    lanesOf(dom)[0].querySelector('.review-inbox-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const nav = doc.getElementById('document-review-nav');
    assert.strictEqual(nav.hidden, false, '줄을 훑는 띄가 서야 합니다');
    // 내 차례는 2건이다(프로젝트 전체 줄은 더 길다). 띄가 그 2를 말해야 좁힌 줄을 훑는 것이 된다.
    assert(nav.textContent.includes('/ 2'), `좁힌 줄의 길이를 말해야 합니다: ${nav.textContent}`);
    dom.window.close();
  }

  // 5) 서버가 사람 축을 아직 안 실는 판. 빈 목록으로 그리면 "내 차례가 없다"로 읽히는데,
  //    그것은 서버가 답하지 못한 물음에 화면이 대신 답하는 셈이다.
  {
    const dom = open('MEMBER-001', { turns: null });
    assert(textOf(dom, 'review-inbox-summary').includes('서버를 다시 시작'), '서버가 안 실은 것을 0건으로 그리면 안 됩니다');
    assert.strictEqual(lanesOf(dom).length, 0);
    dom.window.close();
  }
}

console.log('document turn tests passed');

// ── 홈의 「검토 요청 태스크」와 그 목적지 ────────────────────────────────────
//
// 카드는 프로젝트 전체에서 승인 스텝에 선 태스크를 세는데 목적지는 "내가 검토자인 것"만
// 걸렀다. 그래서 1을 눌러 도착하면 0건이었고, 이 저장소의 그 1건은 같은 홈 화면이
// "검토자 없음"이라 적은 태스크라 누구를 골라도 영원히 0건이었다 — 수를 보고 그 수를
// 만든 목록으로 갈 수 없으면 요약은 막다른 길이 된다.
//
// 여기서 못박는 것은 두 수가 같다는 것이다. 어느 쪽으로 맞췄는지가 아니라 어긋나지
// 않는다는 것이 계약이고, 어긋나는 순간 카드는 다시 막다른 길이 된다.
{
  const { JSDOM } = require('jsdom');
  function mount() {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.eval(`${app}\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name) { setView(name); }, member(id) { state.currentMember = id; } };`);
    return dom;
  }
  // 워크플로는 서버가 싣는다. 화면은 상태 이름을 모르고 스텝으로 묻는다 — 실어 주지
  // 않으면 승인 스텝에 선 태스크가 한 건도 없는 것으로 보여 이 시험이 0 = 0으로 통과한다.
  const workflow = {
    nodes: {
      todo: { step: 'unclaimed', validity: null, label: null, requires: [] },
      doing: { step: 'in-progress', validity: null, label: null, requires: [] },
      review: { step: 'in-approval', validity: null, label: null, requires: [] },
      done: { step: 'completed', validity: 'valid', label: null, requires: [] }
    },
    steps: ['unclaimed', 'in-progress', 'in-approval', 'completed'],
    terminalSteps: ['completed'], openSteps: ['unclaimed', 'in-progress', 'in-approval'], activeSteps: ['in-progress', 'in-approval']
  };
  const task = (id, status, reviewers) => ({
    id, title: `${id} 제목`, status, priority: 'mid', owner: 'MEMBER-001', reviewers, deps: [], links: [], acceptanceCriteria: {}
  });
  const snapshot = {
    project: 'demo', documents: [], attention: [], workflow,
    tasks: { tasks: [
      // 이 저장소의 그 1건이다. 검토자가 없어 어떤 신원으로도 걸러지지 않는다.
      task('TASK-AAAAAAAA', 'review', []),
      task('TASK-BBBBBBBB', 'review', ['MEMBER-002']),
      task('TASK-CCCCCCCC', 'doing', [])
    ] },
    people: { members: [{ id: 'MEMBER-001', name: '강윤정' }, { id: 'MEMBER-002', name: '류승호' }], stakeholders: [], roles: [] },
    presentation: { documentTypes: {}, documentStates: {} },
    reviewQueue: { used: true, unknown: null, counts: { approved: 0, stale: 0, unapproved: 0 }, total: 0, rejected: 0, items: [] }
  };
  const click = (dom, element) => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const metricOf = (dom) => Array.from(dom.window.document.querySelectorAll('#metrics .metric'))
    .find((button) => button.textContent.includes('검토 요청 태스크'));
  const taskRowsOf = (dom) => Array.from(dom.window.document.querySelectorAll('#task-list .task-row'));

  // 1) 사람을 안 골랐을 때. 승인 스텝에 서 있다는 것은 태스크의 사실이고 누가 보는가와
  //    무관하므로, 신원 안내로 목록을 가리지 않는다 — 가리면 카드의 수는 2인데 목적지는
  //    아무것도 안 보여 준다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.view('home');
    const metric = metricOf(dom);
    assert.strictEqual(metric.querySelector('strong').textContent, '2', '카드는 프로젝트 전체에서 승인 스텝에 선 수를 센다');
    click(dom, metric);
    assert.strictEqual(dom.window.document.getElementById('tasks-heading').textContent, '검토 대기', '목적지의 이름이 세는 것과 같아야 합니다');
    assert.strictEqual(taskRowsOf(dom).length, 2, '카드의 수와 목적지의 줄 수가 같아야 합니다');
    assert.strictEqual(dom.window.document.querySelectorAll('#task-list .identity-prompt').length, 0, '사람을 안 골라도 검토 대기는 보여야 합니다');
    dom.window.close();
  }

  // 2) 사람을 골랐을 때도 두 수는 같다. 내가 검토자인 것만 남기면 검토자 없이 멈춰 선
  //    태스크가 어느 수에도 안 잡혀 화면에서 사라지는데, 그 태스크야말로 아무도 안 보고
  //    있다는 뜻이라 가장 먼저 보여야 하는 것이다. 대신 그중 몇 건이 내 것인지를 적는다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.member('MEMBER-002');
    dom.window.__probe.view('home');
    click(dom, metricOf(dom));
    assert.strictEqual(taskRowsOf(dom).length, 2, '신원을 골라도 목적지가 세는 것은 그대로여야 합니다');
    assert(dom.window.document.getElementById('tasks-description').textContent.includes('1건이 내가 검토자'),
      '그중 몇 건이 내 것인지는 말해야 합니다');
    dom.window.close();
  }

  // 3) 「내 작업」은 여전히 신원을 요구한다. 담당은 사람 없이는 물을 수 없는 축이라
  //    검토 대기와 같은 규칙을 쓰면 안 된다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.view('my-work');
    assert.strictEqual(dom.window.document.querySelectorAll('#task-list .identity-prompt').length, 1, '내 작업은 신원을 먼저 물어야 합니다');
    dom.window.close();
  }
}

console.log('review request metric tests passed');

// ── 승인 판이 본문 폭을 반으로 줄일 때 넓은 것이 갈 곳 ───────────────────────
//
// 아래의 승인 판 시험은 반쪽이었다. "판을 열어도 본문의 보이는 높이가 0이 아닌가"만 쟀고
// 남은 폭에서 실제로 읽히는가는 재지 않았다. 세로로 살아 있어도 가로로 죽으면 같은 결함이다.
//
// 실측(뷰포트 1500, GLS-002): 판을 열면 본문이 1189px에서 620px이 된다. 그런데 그 문서의
// 용어 표는 자기 최소 폭이 664px이라 620px 아래로 줄지 못하고, 본문에는 넘친 것을 담을
// 자리가 없어 마지막 열(「사용하지 않을 표현」)이 판 밑으로 들어가 사라졌다 — 스크롤 막대가
// 어디에도 없어 되찾을 방법이 없었다. 그동안 본문의 보이는 높이는 584px이었다. 높이만 재는
// 검사로는 이 결함이 한 번도 안 잡힌다.
//
// 그래서 재는 것을 바꾼다. 넓은 것이 자기 상자를 갖는가, 그 상자가 가로로 스크롤하는가.
{
  assert(/\.table-scroll \{[^}]*overflow-x: auto/u.test(style),
    '표는 자기 안에서 가로로 스크롤해야 합니다. 상자가 없으면 좁아진 본문에서 넘친 열은 갈 곳이 없어 사라집니다');
  // 열의 바닥이 없으면 표는 셀마다 가장 긴 낱말 폭까지 눌린다. 넘치지는 않지만 모든 셀이
  // 서너 줄로 접혀, "보이기는 하는데 읽을 수 없는" 자리로 돌아간다.
  assert(/\.markdown-body th,\s*\r?\n\.markdown-body td \{[^}]*min-width:/u.test(style),
    '표의 열에는 최소 폭이 있어야 합니다. 없으면 좁은 본문에서 모든 셀이 서너 줄로 접힙니다');
  assert(/\.markdown-body th \{[^}]*word-break: keep-all/u.test(style),
    '머리글은 낱말 중간에서 꺾이면 안 됩니다. 한글은 기본 규칙에서 음절마다 끊깁니다');

  // 상자를 씌우는 것은 markdown() 하나다. CSS만 있고 상자가 안 씌워지면 그 규칙은 아무 데도
  // 걸리지 않는데, 파일에 문자열이 있다는 것만으로는 그 사실이 드러나지 않는다.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.fetch = () => new Promise(() => {});
  dom.window.eval(app + '\n;window.__markdown = markdown;');
  // 파서와 소독기는 브라우저가 따로 싣는다. 여기서 재는 것은 그 둘의 결과를 받은 뒤 화면이
  // 표를 어떻게 담는가 하나이므로, 그 둘의 자리에는 최소한의 답만 놓는다.
  dom.window.marked = { Renderer: function Renderer() {}, parse: () => '<p>글</p><table><thead><tr><th>가</th></tr></thead><tbody><tr><td>나</td></tr></tbody></table>' };
  dom.window.DOMPurify = { sanitize: (value) => value };
  const holder = dom.window.document.createElement('div');
  holder.innerHTML = dom.window.__markdown('| 가 |\n| --- |\n| 나 |\n');
  const table = holder.querySelector('table');
  assert(table, '표는 그대로 남아야 합니다');
  assert.strictEqual(table.parentElement.className, 'table-scroll', '표는 스크롤 상자 안에 들어가야 합니다');
  assert.strictEqual(holder.querySelectorAll('.table-scroll').length, 1, '표 하나에 상자 하나입니다');
  assert(holder.textContent.includes('글'), '표 밖의 본문은 그대로여야 합니다');
  dom.window.close();
}

console.log('approval panel width tests passed');

// ── 문서의 수명 축 ──────────────────────────────────────────────────────────
//
// state와 lifecycle은 다른 축이다. state는 rdl이 승인 원장에서 투영하는 칸("이 파일이
// 승인된 판과 같은가")이고 lifecycle은 사람이 적는 칸("이 내용이 지금 효력이 있는가")이다.
// 이관으로 72건에 값이 들어갔는데 화면은 그 축을 아예 모르고 있었다 — lifecycle: accepted를
// 든 ADR 15건이 화면에서는 「초안」으로만 보였다.
//
// 못박는 것은 셋이다. 두 축이 각각 그려지는가, 값이 없는 것과 active를 가르는가, 그리고
// 라벨이 화면의 사본이 아니라 표시 규칙에서 오는가.
{
  const { JSDOM } = require('jsdom');
  function mount() {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.eval(app + '\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name, selected) { setView(name, selected); } };');
    return dom;
  }
  const documentValue = (id, lifecycle) => ({
    id, kind: 'adr', type: 'document', title: '문서 ' + id, description: '설명', file: 'docs/' + id + '.md',
    state: 'draft', owner: 'MEMBER-001', modifiedAt: '2026-08-20T00:00:00Z', revision: 'a'.repeat(64), body: '본문',
    lifecycle: lifecycle || null, approval: null
  });
  const snapshot = {
    project: 'demo', attention: [], tasks: { tasks: [] },
    documents: [documentValue('ADR-001', 'accepted'), documentValue('ADR-002', null)],
    people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
    // 라벨은 표시 규칙이 준다. 화면이 자기 사본을 쓰면 팀이 이름을 고쳐도 화면만 옛말을 쓴다.
    presentation: { documentTypes: {}, documentStates: {}, documentLifecycles: { accepted: { label: '채택됨', description: '이 결정이 채택되어 서 있습니다' } } },
    reviewQueue: { used: false, unknown: null, counts: { approved: 0, stale: 0, unapproved: 0 }, total: 0, items: [] }
  };
  const lifecycleChips = (dom, root) => Array.from(dom.window.document.querySelectorAll(root + ' .chip.lifecycle')).map((chip) => chip.textContent);

  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.view('document', 'ADR-001');
    const badges = Array.from(dom.window.document.querySelectorAll('#document-badges .chip')).map((chip) => chip.textContent);
    assert(badges.includes('초안'), '상태 칩은 그대로 있어야 합니다: ' + badges.join(' · '));
    assert.deepStrictEqual(lifecycleChips(dom, '#document-badges'), ['채택됨'], '수명은 자기 칩으로 서야 합니다');
    // 한 칩으로 합치면 「승인됨이면서 대체됨」인 문서를 화면이 말할 수 없다. 두 축이 각각의
    // 자리를 갖는지는 개수로 재야 한다 — 글자만 세면 둘을 이어 붙인 칩 하나도 통과한다.
    assert.strictEqual(badges.filter((value) => value === '초안' || value === '채택됨').length, 2, '두 축은 각각 자기 칩을 가져야 합니다');
    // Context 패널도 같은 축을 갖는다. 배지에만 두면 속성 목록이 문서의 절반만 말한다.
    assert(dom.window.document.getElementById('context-content').textContent.includes('채택됨'), 'Context도 수명을 말해야 합니다');
    dom.window.close();
  }

  // 값이 없는 것과 active는 다르다. 없는 것을 「유효」로 메우면 화면이 사람이 하지도 않은
  // 주장을 대신 하게 되고, 그 주장은 파일 어디에도 근거가 없다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.view('document', 'ADR-002');
    assert.deepStrictEqual(lifecycleChips(dom, '#document-badges'), [], '수명이 없는 문서에는 수명 칩이 없어야 합니다');
    assert(!dom.window.document.getElementById('context-content').textContent.includes('수명'), '없는 축은 Context에도 없어야 합니다');
    dom.window.close();
  }

  // 목록에서도 말한다. 상세에만 두면 "이 목록에 효력 없는 것이 섞여 있나"를 물으려고 문서를
  // 한 건씩 열어야 하고, 그 물음이야말로 목록이 답할 물음이다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.view('documents');
    assert.deepStrictEqual(lifecycleChips(dom, '#documents-list'), ['채택됨'], '목록도 수명을 말하고, 없는 문서에는 칩이 없어야 합니다');
    dom.window.close();
  }
}

console.log('document lifecycle tests passed');

// ── 수명을 지정하는 자리 ────────────────────────────────────────────────────
//
// 화면이 수명을 그리기만 하고 옮기지는 못했다. 값을 옮기는 길이 frontmatter 손편집뿐이라
// 「이 결정은 대체됐다」는 판단이 도구 밖에서 일어났고, 그래서 **왜** 대체했는지가 어디에도
// 남지 않았다(ADR-026).
//
// 못박는 것은 셋이다. 지정하는 자리가 승인 옆에 있는가, 지우는 길이 고르는 길과 나란한가,
// 그리고 살아 있는 승인이 낡는다는 사실을 **누르기 전에** 말하는가.
{
  const { JSDOM } = require('jsdom');
  function mount() {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.eval(app + '\n;window.__probe = { snapshot(value) { state.snapshot = value; },'
      + ' view(name, selected) { setView(name, selected); },'
      + ' open(id) { toggleApproval(id, "approve"); },'
      + ' choose(value) { state.docApproval.lifecycle.value = value; redrawApproval(); } };');
    return dom;
  }
  const approval = (status) => ({
    status, approvedBy: status === 'unapproved' ? null : 'MEMBER-001', approvals: status === 'unapproved' ? 0 : 1,
    approvedRevision: status === 'unapproved' ? null : 'b'.repeat(64),
    submission: { state: 'none', rejection: null }
  });
  const documentValue = (id, lifecycle, status) => ({
    id, kind: 'adr', type: 'document', title: '문서 ' + id, description: '설명', file: 'docs/' + id + '.md',
    state: 'draft', owner: 'MEMBER-001', modifiedAt: '2026-08-20T00:00:00Z', revision: 'a'.repeat(64), body: '본문',
    lifecycle: lifecycle || null, approval: approval(status)
  });
  const snapshot = {
    project: 'demo', attention: [], tasks: { tasks: [] }, approvers: [],
    documents: [documentValue('ADR-001', 'accepted', 'approved'), documentValue('ADR-002', null, 'unapproved')],
    people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
    presentation: { documentTypes: {}, documentStates: {}, documentLifecycles: { accepted: { label: '채택됨' }, superseded: { label: '대체됨' } } },
    reviewQueue: { used: true, unknown: null, counts: { approved: 1, stale: 0, unapproved: 1 }, total: 1, items: [] }
  };
  const form = (dom) => dom.window.document.querySelector('[data-lifecycle-form]');

  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.view('document', 'ADR-002');
    dom.window.__probe.open('ADR-002');
    const lifecycle = form(dom);
    assert(lifecycle, '검토 판에 수명을 지정하는 자리가 있어야 합니다');
    // 승인 폼과 한 폼으로 합치지 않는다. 두 축이 다른 자리로 나가므로 사유도 다른
    // 문장이고, 한 칸을 나눠 쓰면 승인 사유로 적은 문장이 수명 커밋에 실린다.
    assert(!lifecycle.querySelector('[data-approve-field]'), '수명 폼이 승인 칸을 나눠 쓰면 안 됩니다');
    const options = Array.from(lifecycle.querySelectorAll('[data-lifecycle-field="value"] option')).map((option) => option.value);
    // 지우는 길이 고르는 길과 나란히 있어야 한다. 비어 있는 것과 active는 다른 값이라,
    // 지우는 길이 없으면 잘못 적은 수명을 되돌릴 방법이 손편집뿐이 된다.
    assert.strictEqual(options[0], '', '「수명 없음」이 첫 항목이고 그것이 지우는 갈래입니다');
    for (const key of ['active', 'accepted', 'superseded', 'deprecated', 'archived']) {
      assert(options.includes(key), `어휘의 값이 빠졌습니다: ${key}`);
    }
    assert(lifecycle.querySelector('[data-lifecycle-field="reason"]'), '사유 칸이 있어야 합니다');
    // 미승인 문서에는 낡을 승인이 없으므로 경고도 확인 칸도 없다. 늘 띄우면 그 경고는
    // 곧 아무도 안 읽는다.
    dom.window.__probe.choose('deprecated');
    assert(!form(dom).querySelector('.lifecycle-warning'), '잃을 승인이 없으면 겁주지 않습니다');
    assert(!form(dom).querySelector('[data-lifecycle-field="ack"]'), '확인 칸도 없어야 합니다');
    dom.window.close();
  }

  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.view('document', 'ADR-001');
    dom.window.__probe.open('ADR-001');
    // 지금 값과 같으면 보낼 것이 없다. 눌러도 아무 일도 하지 않는 단추는 다음에 진짜로
    // 필요할 때도 안 눌린다.
    assert(form(dom).querySelector('button[type="submit"]').disabled, '바꿀 것이 없으면 보낼 수 없어야 합니다');
    assert(!form(dom).querySelector('.lifecycle-warning'), '고르기 전에는 경고도 없습니다');
    dom.window.__probe.choose('superseded');
    const warning = form(dom).querySelector('.lifecycle-warning');
    // 살아 있는 승인이 걸린 문서에서 수명을 바꾸는 것은 그 승인을 쓰는 일이다. 수명 값이
    // 리비전 해시 안에 있어 생기는 일이며, 사람은 그것을 **누르기 전에** 알아야 한다.
    assert(warning, '승인이 살아 있는 문서에서는 낡는다는 사실을 눌러 보기 전에 말해야 합니다');
    assert(warning.textContent.includes('강윤정'), `누구의 승인이 낡는지 이름으로 말해야 합니다: ${warning.textContent}`);
    assert(form(dom).querySelector('[data-lifecycle-field="ack"]'), '확인 없이 지나가면 경고는 장식이 됩니다');
    assert(!form(dom).querySelector('button[type="submit"]').disabled);
    dom.window.close();
  }
}

console.log('document lifecycle surface tests passed');

// ── 태스크 화면: 거르개는 값이 갈릴 때만 선다 ────────────────────────────────
//
// 거르개 넷이 화면 폭 한 줄을 통째로 쓰는데 이 저장소에서는 넷 다 사실상 아무것도 거르지
// 못했다 — 담당자는 144건 중 137건이 한 사람, 종류는 142건이 일반, 차수는 시험 태스크
// 2건에만 있었다. 그렇다고 지우는 것이 답은 아니다. 다인 프로젝트에서 담당자 거르개는 가장
// 먼저 누르는 칸이고, 업무 유형이 켜지면 종류 거르개도 그날부터 일한다.
//
// 그래서 재는 것은 "지웠는가"가 아니라 "값이 갈릴 때만 서는가"다.
{
  const { JSDOM } = require('jsdom');
  const workflow = {
    nodes: {
      todo: { step: 'unclaimed', validity: null, label: null, requires: [] },
      doing: { step: 'in-progress', validity: null, label: null, requires: [] },
      review: { step: 'in-approval', validity: null, label: null, requires: [] },
      done: { step: 'completed', validity: 'valid', label: null, requires: [] }
    },
    steps: ['unclaimed', 'in-progress', 'in-approval', 'completed'],
    terminalSteps: ['completed'], openSteps: ['unclaimed', 'in-progress', 'in-approval'], activeSteps: ['in-progress', 'in-approval']
  };
  function mount() {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.eval(app + '\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name) { setView(name); }, render() { renderTasks(); }, mode(value) { state.taskMode = value; } };');
    return dom;
  }
  function taskValue(id, extra) {
    return Object.assign({
      id, title: id + ' 제목', status: 'todo', priority: 'high', owner: 'MEMBER-001',
      reviewers: [], deps: [], links: [], acceptanceCriteria: {}, statusChangedAt: '2026-08-01T00:00:00Z'
    }, extra || {});
  }
  function snapshotOf(tasks, attention) {
    return {
      project: 'demo', documents: [], attention: attention || [], workflow, tasks: { tasks },
      people: { members: [{ id: 'MEMBER-001', name: '강윤정' }, { id: 'MEMBER-002', name: '류승호' }], stakeholders: [], roles: [] },
      presentation: { documentTypes: {}, documentStates: {}, itemTypes: { normal: { label: '일반', order: 10 }, test: { label: '검증', order: 20 } } },
      reviewQueue: { used: false, unknown: null, counts: { approved: 0, stale: 0, unapproved: 0 }, total: 0, items: [] }
    };
  }
  const open = (tasks, attention) => {
    const dom = mount();
    dom.window.__probe.snapshot(snapshotOf(tasks, attention));
    dom.window.__probe.view('tasks');
    return dom;
  };
  const control = (dom, id) => dom.window.document.getElementById(id);
  const optionTexts = (dom, id) => Array.from(control(dom, id).options).map((option) => option.text);

  // 1) 담당자가 둘이면 서고, 하나뿐이면 접힌다. 값이 아예 없는 「차수」도 접힌다.
  {
    const dom = open([taskValue('TASK-A'), taskValue('TASK-B'), taskValue('TASK-C', { owner: 'MEMBER-002' })]);
    assert.strictEqual(control(dom, 'owner').hidden, false, '담당자가 둘이면 거르개가 서야 합니다');
    // 개수를 함께 적는다. 누르기 전에 그 축이 실제로 무엇을 가르는지 알 수 있어야
    // 「높음 95 · 중간 45」 같은 쏠림이 눌러 보기 전에 보인다.
    assert.deepStrictEqual(optionTexts(dom, 'owner'), ['담당자', '강윤정 2', '류승호 1'], '선택지는 스냅숏의 값과 개수에서 와야 합니다');
    assert.strictEqual(control(dom, 'priority').hidden, true, '우선순위가 한 종류뿐이면 접혀야 합니다');
    assert.strictEqual(control(dom, 'task-round').hidden, true, '차수 값이 없으면 접혀야 합니다');
    // 값이 하나뿐이라 접은 축만 말한다. 값이 아예 없는 축은 알릴 사실 자체가 없고,
    // 조용히 사라진 축은 "있었는데 없어졌다"로 읽힌다.
    const note = control(dom, 'filter-note');
    assert.strictEqual(note.hidden, false, '접힌 축은 말해야 합니다');
    assert(note.textContent.includes('우선순위: high'), '접힌 축과 그 하나뿐인 값을 적어야 합니다: ' + note.textContent);
    assert(!note.textContent.includes('차수'), '값이 아예 없는 축은 말할 것이 없습니다');
    dom.window.close();
  }

  // 2) 종류는 지우지 않는다. 다른 갈래가 업무 유형을 켜면 그날부터 이 축이 일하고, 그때
  //    이름과 차례는 화면이 아니라 프로젝트가 정한 것이어야 한다.
  {
    const dom = open([taskValue('TASK-A'), taskValue('TASK-B', { kind: 'test', round: 1 })]);
    assert.strictEqual(control(dom, 'task-kind').hidden, false, '종류가 갈리면 서야 합니다');
    assert.deepStrictEqual(optionTexts(dom, 'task-kind'), ['종류', '일반 1', '검증 1'], '종류의 이름과 차례는 업무 유형 정의에서 와야 합니다');
    dom.window.close();
  }

  // 3) 걸어 둔 거르개는 값이 하나가 되어도 남는다. 사라지면 목록이 짧은 이유도, 되돌리는
  //    길도 화면에서 함께 없어진다.
  {
    const dom = open([taskValue('TASK-A'), taskValue('TASK-B')]);
    assert.strictEqual(control(dom, 'owner').hidden, true, '담당자가 한 사람이면 접힙니다');
    control(dom, 'owner').value = 'MEMBER-001';
    dom.window.__probe.render();
    assert.strictEqual(control(dom, 'owner').hidden, false, '값이 걸려 있으면 개수와 무관하게 남아야 합니다');
    assert.strictEqual(control(dom, 'owner').value, 'MEMBER-001', '걸어 둔 값이 옵션을 다시 그리면서 날아가면 안 됩니다');
    dom.window.close();
  }
}

console.log('task filter tests passed');

// ── 태스크 화면: 우선순위 표시 · 의존 탭 · 「다음 하나」 ──────────────────────
{
  const { JSDOM } = require('jsdom');
  const workflow = {
    nodes: {
      todo: { step: 'unclaimed', validity: null, label: null, requires: [] },
      doing: { step: 'in-progress', validity: null, label: null, requires: [] },
      review: { step: 'in-approval', validity: null, label: null, requires: [] },
      done: { step: 'completed', validity: 'valid', label: null, requires: [] }
    },
    steps: ['unclaimed', 'in-progress', 'in-approval', 'completed'],
    terminalSteps: ['completed'], openSteps: ['unclaimed', 'in-progress', 'in-approval'], activeSteps: ['in-progress', 'in-approval']
  };
  function mount() {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.eval(app + '\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name) { setView(name); }, mode(value) { state.taskMode = value; }, unfold(groupBy, key) { setViewOption("collapse." + groupBy + "." + key, "0"); } };');
    return dom;
  }
  function taskValue(id, extra) {
    return Object.assign({
      id, title: id + ' 제목', status: 'todo', priority: 'high', owner: 'MEMBER-001',
      reviewers: [], deps: [], links: [], acceptanceCriteria: {}, statusChangedAt: '2026-08-01T00:00:00Z'
    }, extra || {});
  }
  const criteria = (done, total) => Object.fromEntries(Array.from({ length: total }, (value, index) => ['AC-' + index, { text: 'x', done: index < done }]));
  function snapshotOf(tasks, attention) {
    return {
      project: 'demo', documents: [], attention: attention || [], workflow, tasks: { tasks },
      people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
      presentation: { documentTypes: {}, documentStates: {}, itemTypes: {} },
      reviewQueue: { used: false, unknown: null, counts: { approved: 0, stale: 0, unapproved: 0 }, total: 0, items: [] }
    };
  }
  const open = (tasks, attention) => {
    const dom = mount();
    dom.window.__probe.snapshot(snapshotOf(tasks, attention));
    dom.window.__probe.view('tasks');
    return dom;
  };

  // 1) 「높음」이 66%면 그 빨강은 신호가 아니라 배경이다. 과반을 차지한 값과 그보다 낮은
  //    값이 함께 색을 잃는다 — 과반값만 지우면 그 아래 값이 화면에서 가장 진한 색을 갖게
  //    되어, 「높음」은 회색이고 「중간」은 주황인 목록이 나온다.
  {
    const dom = open([taskValue('TASK-A'), taskValue('TASK-B'), taskValue('TASK-C', { priority: 'mid' })]);
    const cells = Array.from(dom.window.document.querySelectorAll('#task-list .task-prio'));
    assert.strictEqual(cells.length, 3, '우선순위 칸은 행마다 그대로 있어야 합니다');
    assert(cells.every((cell) => cell.hasAttribute('data-background')), '과반값과 그 아래는 색을 잃어야 합니다');
    assert(cells.every((cell) => cell.hasAttribute('data-prio')), '색만 뺄 뿐 값은 그대로 말해야 합니다');
    dom.window.close();
  }
  // 우선순위가 실제로 갈리는 프로젝트에서는 그 색이 일한다. 없애는 것이 아니다.
  {
    const dom = open([taskValue('TASK-A'), taskValue('TASK-B', { priority: 'mid' }), taskValue('TASK-C', { priority: 'low' })]);
    const cells = Array.from(dom.window.document.querySelectorAll('#task-list .task-prio'));
    assert(cells.every((cell) => !cell.hasAttribute('data-background')), '과반이 없으면 색은 그대로 일해야 합니다');
    dom.window.close();
  }

  // 2) 의존 보기는 그릴 것이 있을 때만 선다. 144건 중 의존 관계가 0건인데 최상위 탭 하나가
  //    늘 빈 화면이었고, 그 사실은 눌러야만 알 수 있었다.
  {
    const dom = open([taskValue('TASK-A'), taskValue('TASK-B')]);
    assert.strictEqual(dom.window.document.getElementById('task-graph-mode').hidden, true, '의존이 없으면 탭이 서지 않아야 합니다');
    dom.window.close();
  }
  {
    const dom = open([taskValue('TASK-A'), taskValue('TASK-B', { deps: ['TASK-A'] })]);
    assert.strictEqual(dom.window.document.getElementById('task-graph-mode').hidden, false, '의존이 하나라도 있으면 탭이 서야 합니다');
    dom.window.close();
  }
  // 서 있지 않은 방식에 머물러 있으면 화면은 빈 채로 남고 되돌릴 단추도 함께 사라진다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshotOf([taskValue('TASK-A'), taskValue('TASK-B')]));
    dom.window.__probe.mode('graph');
    dom.window.__probe.view('tasks');
    assert.strictEqual(dom.window.document.getElementById('task-list').hidden, false, '접힌 방식에 머물러 있으면 목록으로 돌아와야 합니다');
    assert(dom.window.document.getElementById('task-list-mode').classList.contains('active'), '돌아온 자리를 표시도 따라와야 합니다');
    dom.window.close();
  }

  // 3) 「다음 하나」. 열린 것이 쉰 건인데 묶음마다 여섯 줄만 보이고, 그 여섯을 가르던 근거가
  //    우선순위라 사실상 무작위였다. 사다리에서 못박을 것은 순서다 — 승인 스텝에 섰는데
  //    검토자가 없는 것은 아무도 보고 있지 않다는 뜻이라 완료조건을 다 채운 것보다 먼저다.
  //    순서를 반대로 두었더니 그 한 건이 「닫기만 남음」 열일곱 건 속으로 숨어 버렸다.
  {
    const tasks = [
      taskValue('TASK-CLOSE', { status: 'doing', acceptanceCriteria: criteria(5, 5) }),
      taskValue('TASK-REVIEW', { status: 'review', acceptanceCriteria: criteria(4, 4) }),
      taskValue('TASK-TODO', { acceptanceCriteria: criteria(0, 3) })
    ];
    const dom = open(tasks, [{ severity: 'warning', kind: 'task', id: 'TASK-REVIEW', title: 'x', reason: '검토자 없음' }]);
    const panel = dom.window.document.getElementById('task-next');
    assert.strictEqual(panel.hidden, false, '열린 것이 여럿이면 다음 하나가 서야 합니다');
    assert.strictEqual(panel.querySelector('.task-next-pick').dataset.task, 'TASK-REVIEW', '검토자 없이 선 것이 먼저입니다');
    assert(panel.querySelector('.task-next-reason').textContent.includes('검토자'), '고른 이유를 함께 적어야 합니다');
    // 갈래별 수. 하나만 내밀면 "왜 하필 이것이냐"에 답할 수 없다.
    const shape = Array.from(panel.querySelectorAll('.task-next-shape span')).map((item) => item.dataset.shape);
    assert.deepStrictEqual(shape, ['unreviewed', 'closable', 'waiting'], '갈래는 사다리 차례로 서야 합니다');
    // 행의 이름표는 둘뿐이다. 다 달면 쉰 줄이 전부 이름표를 걸치고, 그러면 이름표가
    // 우선순위의 빨강과 같은 운명이 된다.
    const marks = Array.from(dom.window.document.querySelectorAll('#task-list .task-mark')).map((mark) => mark.dataset.mark);
    assert.deepStrictEqual(marks.slice().sort(), ['closable', 'unreviewed'], '이름표는 손 한 번이면 움직이는 갈래에만 답니다');
    dom.window.close();
  }
  // 끝난 태스크에는 다음 차례가 없다. 안 거르면 완료 묶음의 여든네 줄이 전부 「닫기만 남음」이
  // 된다 — 완료 태스크도 완료조건은 다 찍혀 있기 때문이다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshotOf([
      taskValue('TASK-DONE', { status: 'done', acceptanceCriteria: criteria(3, 3) }),
      taskValue('TASK-A', { acceptanceCriteria: criteria(0, 2) }),
      taskValue('TASK-B', { acceptanceCriteria: criteria(0, 2) })
    ]));
    // 완료 묶음은 기본으로 접혀 있다. 접힌 줄은 그려지지 않으므로 보고 재려면 먼저 펌다.
    dom.window.__probe.unfold('status', 'done');
    dom.window.__probe.view('tasks');
    const rows = Array.from(dom.window.document.querySelectorAll('#task-list .task-row'));
    const doneRow = rows.find((row) => row.dataset.task === 'TASK-DONE');
    assert(doneRow, '완료 태스크도 목록에는 있어야 합니다');
    assert.strictEqual(doneRow.querySelector('.task-mark'), null, '끝난 것에는 다음 차례 이름표가 없어야 합니다');
    dom.window.close();
  }
  // 고를 것이 하나뿐이면 「다음 하나」는 고른 것이 아니라 목록을 한 번 더 그린 것이다.
  {
    const dom = open([taskValue('TASK-ONLY'), taskValue('TASK-DONE', { status: 'done' })]);
    assert.strictEqual(dom.window.document.getElementById('task-next').hidden, true, '열린 것이 하나면 띠가 서지 않아야 합니다');
    dom.window.close();
  }
}

console.log('task next tests passed');

// ── 문서 상세의 승인 판이 본문을 밀어내지 않는가 ─────────────────────────────
//
// 오너가 여기서 막혔다. 「검토하고 승인」을 누르면 685px짜리 판이 본문 앞에 끼어들어 본문을
// 뷰포트 밖으로 밀어냈고(1500×1000에서 본문의 보이는 높이가 584px → 0px), 사람이 보기에는
// "문서를 눌렀는데 문서가 안 열리고 승인만 나온다"였다. 본문은 DOM에 그대로 있고 hidden도
// 아니었으므로, 있는지를 세는 검사로는 하나도 안 잡힌다.
//
// jsdom은 조판을 계산하지 않아 픽셀로는 못 잰다. 그래서 픽셀을 만드는 두 가지를 각각
// 못박는다 — 판이 열렸다는 것을 body가 표식으로 알리는가(동작), 그리고 그 표식이 판을
// 흐름에서 빼고 본문에 그만큼 여백을 주는가(조판). 둘 중 하나만 있으면 본문은 다시
// 밀려나거나 판에 덮인다.
{
  // 조판. 흐름에서 빼는 것과 본문이 비켜 주는 것은 언제나 같이 가야 하고, 폭과 여백은
  // 같은 수여야 한다 — 두 곳에 따로 적으면 한쪽만 고쳐지는 날 판이 본문을 덮는다.
  const surface = style.slice(style.indexOf('body.approval-open {'), style.indexOf('.approval-panel-head {'));
  assert(/body\.approval-open #document-approval-panel \{[^}]*position: fixed/u.test(surface),
    '승인 판은 본문 흐름에서 빠져야 합니다. 흐름에 두면 열 때마다 본문이 그만큼 아래로 밀립니다');
  assert(/body\.approval-open #document-approval-panel \{[^}]*width: var\(--approval-Width\)/u.test(surface)
    && /body\.approval-open \.main-content \{[^}]*padding-right: calc\(var\(--approval-Width\)/u.test(surface),
    '판의 폭과 본문이 비켜 줄 여백은 같은 값에서 와야 합니다. 갈리면 판이 본문을 덮거나 빈 띠가 남습니다');
  assert(/body\.approval-open \.workspace-shell \{[^}]*grid-template-columns/u.test(surface),
    'Context 열을 정리해야 합니다. 안 하면 빈 300px이 판 뒤에 남아 본문 폭만 깎습니다');

  // 동작. 판을 열면 body에 표식이 서고, 화면을 옮기면 사라진다.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  dom.window.fetch = () => new Promise(() => {});
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.eval(`${app}\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name, selected) { setView(name, selected); } };`);
  const item = {
    id: 'ADR-020', kind: 'adr', type: 'document', title: '설정 자유도를 가역성으로 나눈다', description: '설명',
    file: 'docs/adr/ADR-020.md', state: 'accepted', owner: 'MEMBER-001', modifiedAt: '2026-08-20T00:00:00Z',
    revision: 'a'.repeat(64), body: '# 본문\n\n읽어야 할 내용이 여기 있다.', tags: [], related: [],
    approval: { status: 'stale', approvedRevision: 'b'.repeat(64), approvedBy: 'MEMBER-001', approvals: 1, submission: { state: 'none', rejection: null } }
  };
  dom.window.__probe.snapshot({
    project: 'demo', documents: [item], tasks: { tasks: [] }, attention: [],
    people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
    presentation: { documentTypes: {}, documentStates: {} },
    approvers: [{ id: 'CLIENT-1', name: '개발용' }],
    reviewQueue: { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 0 }, total: 1, rejected: 0, items: [] }
  });
  dom.window.__probe.view('document', 'ADR-020');
  const body = dom.window.document.getElementById('document-body');
  const panel = dom.window.document.getElementById('document-approval-panel');
  assert.strictEqual(dom.window.document.body.classList.contains('approval-open'), false, '열기 전에는 표식이 없어야 합니다');
  assert.strictEqual(panel.innerHTML, '', '열기 전에는 판이 비어 있어야 합니다');

  dom.window.document.querySelector('#document-approval [data-approve-open]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(dom.window.document.body.classList.contains('approval-open'),
    '판을 열면 body가 그 사실을 알려야 합니다. 조판이 판을 흐름에서 빼는 근거가 이 표식뿐입니다');
  assert(panel.textContent.includes('검토하고 승인'), '옆으로 나온 판은 자기가 무엇인지 말해야 합니다');
  assert(panel.querySelector('[data-approve-open]'), '덮는 표면은 자기 안에 닫는 길을 가져야 합니다');
  // 본문은 그대로다. 밀려나는 것은 조판의 문제라 여기서는 "지워지지 않았다"까지만 본다.
  assert.strictEqual(body.hidden, false, '본문을 감추지 않습니다');
  assert(body.textContent.includes('읽어야 할 내용'), '본문이 그대로 서 있어야 합니다');

  // 화면을 옮기면 표식이 사라진다. 안 지우면 본문이 없는 화면에서도 오른쪽 여백이 남아,
  // 아무것도 없는 자리가 목록의 폭을 먹는다.
  dom.window.__probe.view('documents');
  assert.strictEqual(dom.window.document.body.classList.contains('approval-open'), false, '화면을 옮기면 자리를 돌려줘야 합니다');
  dom.window.close();
}

console.log('document approval surface tests passed');

// ── 문서 목록의 승인 축 ──────────────────────────────────────────────────────
//
// 화면이 원장과 반대로 말하고 있었다. 행의 두 번째 칩은 frontmatter의 state, 곧 문서를 쓴
// 사람의 주장인데 화면에는 그것만 갔고, 원장이 "낡음"이라 아는 문서가 목록에서는 accepted로
// 떠 있었다. 스냅숏은 0.43.0부터 document.approval을 싣는데 화면이 그것을 한 번도 읽지 않았다.
//
// 여기서 못박는 것은 두 축이 갈려 있다는 것이다. 하나로 합치면 같은 거짓말이 다른 모양으로
// 다시 생긴다 — 화면이 주장을 사실처럼 말하게 된다.
assert(html.includes('id="document-approval-filter"'), '문서 목록에 승인 거르개 자리가 있어야 합니다');
assert(html.includes('id="document-approval"'), '문서 상세에 승인 원장 자리가 있어야 합니다');
{
  const render = app.slice(app.indexOf('function renderDocuments'), app.indexOf('function ownerName'));
  // 판정을 새로 짓지 않는다. 리비전을 비교하는 순간 rdl doc status와 보드가 같은 문서에
  // 다른 답을 내고, 그때 사람이 믿는 쪽은 화면이다.
  assert(!render.includes('revision'), '목록이 승인 판정을 다시 지으면 안 됩니다');
  // 두 축이 한 행에 함께 서야 한다. state 칩을 없애면 누가 무엇을 주장했는지가 사라지고,
  // 원장 칩을 안 세우면 지금까지처럼 주장이 사실 행세를 한다.
  assert(render.includes('documentStateLabel(item.state)') && render.includes('approvalTagHtml(status)'), '주장과 사실이 함께 서야 합니다');
}
// 원장의 말과 색은 검토 인박스의 표에서 온다. 같은 상태가 두 화면에서 다른 말·다른 색이면
// 사용자는 그것을 다른 것으로 읽는다. 물려받는 쪽으로 적어야 상태가 늘 때 둘이 함께 는다.
assert(/const DOCUMENT_APPROVAL_TONES = Object\.assign\(\{ approved: 'pass' \}, REVIEW_STATUS_TONES\)/u.test(app), '원장 색은 인박스의 표를 물려받아야 합니다');
// 승인됨을 인박스의 표에 얹으면 그 표가 곧 인박스 거르개의 목록이라, 누를 것 없는 단추가 생긴다.
assert(!/REVIEW_STATUS_TONES = \{[^}]*\bapproved:/u.test(app), '인박스 거르개에 승인됨이 들어가면 안 됩니다');
// 거르개의 목록도 그 표의 키다. 따로 적으면 vocabulary.js의 DOCUMENT_TRUST_STATES 사본이
// 되는데 화면은 브라우저에서 돌아 require로 정본을 가져올 수 없다 — 가져올 수 없는 목록은
// 적지 않는 것이 낫다. 적어 두면 상태가 느는 날 정본과 갈리고, 화면은 그것을 모른 채 돈다.
assert(app.includes('Object.keys(DOCUMENT_APPROVAL_TONES)'), '거르개 목록은 색 표의 키에서 와야 합니다');
{
  const { JSDOM } = require('jsdom');
  function mount() {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // app.js는 'use strict'라 eval 안의 선언이 밖으로 새지 않는다. 밖에서 부를 수 있는 자리는
    // 창의 전역뿐이라 손잡이를 같은 문자열 끝에 붙인다.
    dom.window.eval(`${app}\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name, selected) { setView(name, selected); }, nav() { renderNavigation(); }, stateLabel(value) { return documentStateLabel(value); } };`);
    return dom;
  }
  // 문서 하나. approval은 스냅숏이 붙여 주는 값이고 null이면 "모른다"이다 — 미승인이 아니다.
  function documentValue(id, frontmatterState, approval, extra) {
    return Object.assign({
      id, kind: 'adr', type: 'document', title: `문서 ${id}`, description: '설명', file: `docs/${id}.md`,
      state: frontmatterState, owner: 'MEMBER-001', modifiedAt: '2026-08-20T00:00:00Z', revision: 'a'.repeat(64), body: '본문',
      approval
    }, extra || {});
  }
  function snapshotOf(documents, queue) {
    return {
      project: 'demo', documents, tasks: { tasks: [] }, attention: [],
      people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
      presentation: { documentTypes: {}, documentStates: {} },
      reviewQueue: queue || { used: true, unknown: null, counts: { approved: 1, stale: 1, unapproved: 1 }, total: 2, items: [] }
    };
  }
  function open(documents, queue) {
    const dom = mount();
    dom.window.__probe.snapshot(snapshotOf(documents, queue));
    // 유형 거르개는 사이드바에 살고 loadSnapshot이 renderNavigation으로 세운다. 실제 경로와
    // 같은 순서로 세워야 두 축을 함께 거는 판을 여기서 시험할 수 있다.
    dom.window.__probe.nav();
    dom.window.__probe.view('documents');
    return dom;
  }
  const rowsOf = (dom) => Array.from(dom.window.document.querySelectorAll('#documents-list .document-row'));
  const textOf = (dom, id) => dom.window.document.getElementById(id).textContent;
  const click = (dom, selector) => dom.window.document.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  // 1) 두 축이 갈려 있다. 원장이 미승인이라 아는 문서가 frontmatter로는 accepted를 주장한다 —
  //    지금 이 저장소의 정본 15건이 그 상태다. 행은 그 둘을 함께 말해야 하고, 어긋났다는
  //    사실도 말해야 한다. 어긋남 자체가 봐야 할 신호이기 때문이다.
  {
    const dom = open([
      documentValue('ADR-001', 'accepted', { status: 'unapproved', approvedRevision: null, approvedBy: null, approvals: 0 }),
      documentValue('ADR-002', 'accepted', { status: 'stale', approvedRevision: 'b'.repeat(64), approvedBy: 'MEMBER-001', approvals: 2 }),
      documentValue('ADR-003', 'active', { status: 'approved', approvedRevision: 'a'.repeat(64), approvedBy: 'MEMBER-001', approvals: 1 })
    ]);
    const rows = rowsOf(dom);
    assert.strictEqual(rows.length, 3, '세 문서가 모두 서야 합니다');
    // 원장의 말은 인박스의 말과 같다.
    assert.deepStrictEqual(rows.map((row) => row.querySelector('.tag').textContent), ['미승인', '낡음', '승인됨'], '원장 상태가 행마다 서야 합니다');
    // 색도 같은 등급 토큰이다. 승인됨만 인박스에 설 일이 없어 여기서 더해졌다.
    assert.deepStrictEqual(rows.map((row) => row.querySelector('.tag').className), ['tag info', 'tag warning', 'tag pass'], '색은 인박스와 같은 등급 토큰이어야 합니다');
    // frontmatter의 주장은 지워지지 않는다. 지우면 누가 무엇을 주장했는지가 사라진다.
    assert(rows[0].textContent.includes('채택'), 'accepted의 주장이 행에 남아야 합니다');
    // accepted는 어휘에 없어 라벨이 없으면 영문이 그대로 뜬다. 그렇다고 '승인됨'으로 적으면
    // 원장의 말과 같아져 두 축이 도로 붙는다.
    assert(!rows[0].textContent.includes('accepted'), '어휘 밖 값도 우리말로 적어야 합니다');
    assert.notStrictEqual(dom.window.__probe.stateLabel('accepted'), '승인됨', '주장과 사실이 같은 말을 쓰면 안 됩니다');
    // 어긋난 둘에만 표시가 붙는다. 승인된 문서는 주장과 사실이 같으므로 붙지 않는다.
    assert.deepStrictEqual(rows.map((row) => Boolean(row.querySelector('.chip.claim-unbacked'))), [true, true, false], '어긋난 행에만 표시가 붙어야 합니다');
    assert(textOf(dom, 'documents-note').includes('2건'), `어긋난 수를 말해야 합니다: ${textOf(dom, 'documents-note')}`);
    dom.window.close();
  }

  // 2) 거르개. 값은 document.approval.status에 이미 있고 유형 거르개와 직교해야 한다 —
  //    "요구사항 중 낡은 것"을 물을 수 있어야 하기 때문이다. 각 갈래의 수는 눌렀을 때 남는
  //    줄의 수와 같아야 한다. 다르면 사람은 잘렸다는 사실이 아니라 화면이 틀렸다는 인상을 받는다.
  {
    const dom = open([
      documentValue('ADR-001', 'draft', { status: 'unapproved', approvedRevision: null, approvedBy: null, approvals: 0 }),
      documentValue('ADR-002', 'draft', { status: 'stale', approvedRevision: 'b'.repeat(64), approvedBy: 'MEMBER-001', approvals: 2 }),
      documentValue('REQ-001', 'draft', { status: 'stale', approvedRevision: 'b'.repeat(64), approvedBy: 'MEMBER-001', approvals: 1 }, { kind: 'requirement' })
    ]);
    const filter = textOf(dom, 'document-approval-filter');
    assert(filter.includes('전체 3') && filter.includes('승인됨 0') && filter.includes('낡음 2') && filter.includes('미승인 1'), `갈래마다 수를 내야 합니다: ${filter}`);
    click(dom, '[data-document-approval="stale"]');
    assert.deepStrictEqual(rowsOf(dom).map((row) => row.dataset.document), ['ADR-002', 'REQ-001'], '낡음만 남아야 합니다');
    // 유형 축과 직교한다. 승인 거르개를 켠 채 유형을 좁혀도 둘 다 살아 있어야 한다.
    click(dom, '[data-document-filter="requirement"]');
    assert.deepStrictEqual(rowsOf(dom).map((row) => row.dataset.document), ['REQ-001'], '유형과 승인이 함께 걸려야 합니다');
    // 좁힌 뒤의 수도 그 범위의 것이다. 전건으로 적으면 눌렀을 때 남는 줄과 어긋난다.
    assert(textOf(dom, 'document-approval-filter').includes('전체 1'), '수는 유형을 통과한 것들의 수여야 합니다');
    dom.window.close();
  }

  // 3) 원장을 못 읽는 저장소. approval이 null인 것은 미승인이 아니라 "모른다"이다. 그때
  //    거르개가 서면 화면이 서버가 답하지 못한 물음에 대신 답하는 셈이 되고, 모르는 133건이
  //    미승인 133건으로 읽힌다. 검토 인박스가 unknown을 다루는 선과 같다.
  {
    const reason = '이 작업공간은 승인 원장을 갖기 전 판입니다.';
    const dom = open(
      [documentValue('ADR-001', 'accepted', null), documentValue('ADR-002', 'draft', null)],
      { used: false, unknown: reason, counts: null, total: 0, items: [] }
    );
    assert(dom.window.document.getElementById('document-approval-filter').hidden, '모를 때는 거르개가 서면 안 됩니다');
    assert.strictEqual(rowsOf(dom).length, 2, '목록 자체는 그대로 서야 합니다');
    assert.strictEqual(rowsOf(dom)[0].querySelector('.tag'), null, '모르는 것을 상태로 그리면 안 됩니다');
    assert(!rowsOf(dom)[0].textContent.includes('미승인'), '모르는 것을 미승인으로 적으면 안 됩니다');
    // 어긋남도 판정하지 않는다. 원장을 모르면 주장이 어긋났는지도 모른다.
    assert.strictEqual(rowsOf(dom)[0].querySelector('.chip.claim-unbacked'), null, '모를 때 어긋남을 지어내면 안 됩니다');
    assert(textOf(dom, 'documents-note').includes(reason), '못 읽은 이유를 그대로 내야 합니다');
    // 태그가 한 줄도 서지 않으면 그 열을 열어 두지 않는다. 빈 열이 목록 전체를 밀기만 한다.
    assert(!dom.window.document.getElementById('documents-list').classList.contains('with-ledger'), '빈 원장 열을 열어 두면 안 됩니다');
    dom.window.close();
  }

  // 4) 승인 축을 한 번도 안 쓴 프로젝트에서 전건 미승인은 문서마다의 상태가 아니다. 다만 그
  //    판정은 프로젝트 전체의 성질이라, 유형으로 좁혀 그 안에 승인된 것이 없다고 해서
  //    "이 프로젝트는 승인을 안 쓴다"고 말하면 안 된다.
  {
    const unused = open([documentValue('ADR-001', 'draft', { status: 'unapproved', approvedRevision: null, approvedBy: null, approvals: 0 })]);
    assert(textOf(unused, 'documents-note').includes('아직 승인을 관문으로 쓰지 않습니다'), '축을 안 쓰면 그렇다고 말해야 합니다');
    unused.window.close();
    const mixed = open([
      documentValue('ADR-001', 'draft', { status: 'stale', approvedRevision: 'b'.repeat(64), approvedBy: 'MEMBER-001', approvals: 1 }),
      documentValue('REQ-001', 'draft', { status: 'unapproved', approvedRevision: null, approvedBy: null, approvals: 0 }, { kind: 'requirement' })
    ]);
    click(mixed, '[data-document-filter="requirement"]');
    assert(!textOf(mixed, 'documents-note').includes('아직 승인을 관문으로 쓰지 않습니다'), '유형을 좁혔다고 프로젝트의 성질이 바뀌면 안 됩니다');
    mixed.window.close();
  }

  // 5) 상세와 컨텍스트도 같은 말을 해야 한다. 인박스가 "낡음"이라 부른 문서를 눌러 도착하는
  //    자리가 여기라, 여기가 원장을 말하지 않으면 인박스가 거짓말한 것이 된다. 셋 다 고쳐야
  //    한 문서에 세 답이 생기지 않는다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshotOf(
      [documentValue('ADR-020', 'accepted', { status: 'stale', approvedRevision: `${'b'.repeat(63)}c`, approvedBy: 'MEMBER-001', approvals: 2 })],
      { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 0 }, total: 1, items: [] }
    ));
    dom.window.__probe.view('document', 'ADR-020');
    const detail = textOf(dom, 'document-approval');
    assert(detail.includes('낡음') && detail.includes('강윤정') && detail.includes('승인 2회'), `상세가 원장을 말해야 합니다: ${detail}`);
    assert(detail.includes('b'.repeat(12)), '승인된 리비전을 내야 합니다');
    // 낡음에서 "승인 이후 무엇이 바뀌었나"로 가는 길. diff 본문은 스냅숏에 없으므로 명령을
    // 안내하는 데서 멈춘다 — 없는 것을 화면이 지어내면 그것을 믿고 재승인한 사람이 자기가
    // 무엇을 승인했는지 모르게 된다.
    assert(detail.includes('rdl doc diff ADR-020 --since-approval'), '승인 이후 변경으로 가는 길을 안내해야 합니다');
    assert(!textOf(dom, 'document-body').includes('--since-approval'), '없는 diff 본문을 화면이 지어내면 안 됩니다');
    // 컨텍스트 패널의 "상태" 한 줄은 그것만 있으면 승인 상태로 읽힌다. 이름을 갈라야 한다.
    const context = textOf(dom, 'context-content');
    assert(context.includes('문서 상태') && context.includes('승인 원장'), `속성표도 두 축을 갈라야 합니다: ${context}`);
    assert(context.includes('강윤정 · 2회'), '컨텍스트가 승인자와 횟수를 내야 합니다');
    dom.window.close();
  }

  // 6) 원장을 못 읽었을 때의 상세·컨텍스트도 같은 선을 긋는다.
  {
    const dom = mount();
    dom.window.__probe.snapshot(snapshotOf(
      [documentValue('ADR-001', 'accepted', null)],
      { used: false, unknown: '원장을 읽지 못했습니다', counts: null, total: 0, items: [] }
    ));
    dom.window.__probe.view('document', 'ADR-001');
    assert(textOf(dom, 'document-approval').includes('읽지 못했습니다'), '상세도 모르는 것을 미승인으로 적으면 안 됩니다');
    // 상태 태그 자체가 서면 안 된다. 안내문이 "미승인으로 적지 않는다"고 말하는 것과
    // 상태를 하나 골라 붙이는 것은 다른 일이다.
    assert.strictEqual(dom.window.document.querySelector('#document-approval .tag'), null, '모르는 것에 상태를 지어 붙이면 안 됩니다');
    assert(textOf(dom, 'context-content').includes('읽지 못함'), '컨텍스트도 같은 선을 그어야 합니다');
    dom.window.close();
  }

  // 7) 조치 필요의 문서 항목. attentionItems는 태스크와 문서를 함께 담는데 목록이 전부
  //    태스크로 그려져, 낡음 문서를 누르면 오류도 안내도 없이 141건짜리 태스크 목록으로 떨어졌다.
  {
    const dom = mount();
    const snapshot = snapshotOf([], { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 0 }, total: 1, items: [] });
    snapshot.attention = [{ severity: 'warning', kind: 'document', id: 'ADR-020', title: '설정 자유도', reason: '승인 후 개정 — 재승인 필요' }];
    dom.window.__probe.snapshot(snapshot);
    dom.window.__probe.view('home');
    const item = dom.window.document.querySelector('#attention-list .attention-item');
    assert.strictEqual(item.dataset.document, 'ADR-020', '문서 항목은 문서로 가야 합니다');
    assert.strictEqual(item.dataset.task, undefined, '문서를 태스크로 그리면 안 됩니다');
    dom.window.close();
  }
}

console.log('document ledger tests passed');

// ── 화면에서 비교하고 승인한다 ──────────────────────────────────────────────
//
// 오너가 계속 요구한 자리다: "상세 페이지에서 승인을 어떻게 하고 비교를 어떻게 하고".
// 검토 인박스는 목록일 뿐이었고 행 안에 단추가 0개였다. 여기서 못박는 것은 넷이다 —
// 인박스의 줄을 누르면 본문이 보이는 검토 자리로 갈 것, 그 자리에서 차분이 본문 옆에
// 설 것, 비교 기준이 없을 때 빈 차분을 지어내지 않을 것, 거절당하면 왜 거절당했는지가
// 그대로 보일 것.
//
// 셋에서 넷이 된 것은 계약이 바뀌어서다. 오래 이 판은 인박스의 줄 안에서 펼쳐졌는데 그
// 자리에는 본문이 없었고, 그래서 근거로 read(읽고 판단했다)를 고르면서 정작 읽을 자리는
// 없는 화면이었다. 승인을 받는 자리는 이제 본문이 있는 문서 상세 하나다.
//
// 이 갈래들은 문자열이 파일에 있다는 것만으로는 지켜지지 않는다. 어느 갈래로 갔는가가
// 답이고, 그것은 실제로 그려 봐야 안다.
module.exports = (async () => {
  const { JSDOM } = require('jsdom');
  const APPROVERS = [{ id: 'desk-h', name: '강윤정 데스크', owner: 'MEMBER-001' }];

  function documentValue(id, approval, extra) {
    return Object.assign({
      id, kind: 'adr', type: 'document', title: `문서 ${id}`, description: '설명', file: `docs/${id}.md`,
      state: 'draft', owner: 'MEMBER-001', modifiedAt: '2026-08-20T00:00:00Z', revision: 'a'.repeat(64), body: '본문',
      approval
    }, extra || {});
  }
  function trust(status, submissionState) {
    return {
      status,
      approvedRevision: status === 'unapproved' ? null : 'b'.repeat(64),
      approvedBy: status === 'unapproved' ? null : 'MEMBER-001',
      approvals: status === 'unapproved' ? 0 : 2,
      versionLabel: '2.0',
      submission: { state: submissionState || 'none', revision: null, submittedBy: null, reason: null, submissions: 0, rejection: null, rejections: 0 }
    };
  }
  // 반려된 판. 신뢰 상태는 그대로이고 제출 축만 바뀐다 — 그것이 이 갈래의 전부다.
  function rejectedTrust(status, reason) {
    const value = trust(status);
    value.submission = Object.assign({}, value.submission, {
      state: 'rejected', rejections: 1,
      rejection: { revision: 'c'.repeat(64), rejectedBy: 'MEMBER-001', rejectedByClient: 'desk-h', reason, recordedAt: '2026-09-05T00:00:00.000Z' }
    });
    return value;
  }
  function snapshotOf(documents, queue, approvers) {
    return {
      project: 'demo', documents, tasks: { tasks: [] }, attention: [],
      people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
      presentation: { documentTypes: {}, documentStates: {} },
      approvers: approvers === undefined ? APPROVERS : approvers,
      approvalCatalog: { basisKinds: ['read', 'verdict', 'check', 'delegated'] },
      reviewQueue: queue || { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 0 }, total: 1, items: [] }
    };
  }
  // 서버의 답을 손으로 준다. 실제 서버를 띄우는 쪽은 approval.test.js가 맡고, 여기서는
  // 그 답을 받은 화면이 어느 갈래로 가는지를 본다.
  function mount(answer) {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const calls = [];
    dom.window.fetch = (path, options) => {
      calls.push({ path: String(path), options: options || {} });
      const given = answer(String(path), options || {});
      // 답을 안 주면 그 요청은 영영 안 온 것으로 둔다 — 부팅의 첫 await를 세우는 데도 쓴다.
      if (!given) return new Promise(() => {});
      return Promise.resolve({ ok: given.ok !== false, status: given.status || 200, json: () => Promise.resolve(given.body) });
    };
    dom.window.eval(`${app}\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name, selected) { setView(name, selected); }, panel() { return state.docApproval; } };`);
    return { dom, calls };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  function open(answer, documents, queue, view, selected, approvers) {
    const mounted = mount(answer);
    mounted.dom.window.__probe.snapshot(snapshotOf(documents, queue, approvers));
    mounted.dom.window.__probe.view(view, selected);
    return mounted;
  }
  const text = (dom, id) => dom.window.document.getElementById(id).textContent;

  // 1) 줄을 누르면 그 문서의 검토 자리로 가고, 본문 옆에 차분과 폼이 선다. 이 순서가
  //    핵심이다 — 차분은 "무엇이 바뀌었나"에만 답하고 "이게 맞는 문서인가"는 본문에만
  //    있어서, 본문 없이 받은 승인은 읽었다는 증거가 되지 못한다.
  {
    const stale = { status: 'stale', diff: 'diff --git a/docs/ADR-001.md b/docs/ADR-001.md\n@@ -1,3 +1,4 @@\n 그대로인 줄\n+더한 줄\n-지운 줄\n' };
    const { dom, calls } = open((path) => (/\/diff\?/u.test(path) ? { body: Object.assign({ axis: 'since-approval' }, stale) } : null),
      [documentValue('ADR-001', trust('stale'))],
      { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 0 }, total: 1,
        items: [{ status: 'stale', id: 'ADR-001', kind: 'adr', title: '문서 ADR-001', file: 'docs/ADR-001.md', approvedBy: 'MEMBER-001', approvals: 2 }] },
      'review-inbox');
    dom.window.document.querySelector('#review-inbox-list [data-document="ADR-001"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    assert.strictEqual(dom.window.document.getElementById('document-view').hidden, false, '줄을 누르면 그 문서의 검토 자리로 가야 합니다');
    assert(dom.window.document.getElementById('document-body').textContent.includes('본문'), '판정하는 자리에 본문이 있어야 합니다');
    assert(calls.some((call) => call.path.includes('/documents/ADR-001/diff')), `차분을 물어야 합니다: ${calls.map((call) => call.path).join(', ')}`);
    const panel = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert(panel, '인박스에서 왔으면 승인 판이 열린 채로 도착해야 합니다');
    assert(panel.querySelector('.approval-diff').textContent.includes('더한 줄'), '차분이 그 자리에 보여야 합니다');
    assert.strictEqual(panel.querySelectorAll('.diff-add').length, 1, '늘어난 줄은 색으로 갈려야 합니다');
    assert.strictEqual(panel.querySelectorAll('.diff-del').length, 1, '줄어든 줄도 색으로 갈려야 합니다');
    // 폼 셋. 근거를 안 받으면 나중에 "AI 검토가 놓쳤나 사람이 건너뛰었나"를 가를 수 없다.
    assert(panel.querySelector('[data-approve-field="clientId"]'), '승인자를 골라야 합니다');
    assert(panel.querySelector('[data-approve-field="basis"]'), '근거를 골라야 합니다');
    assert(panel.querySelector('[data-approve-field="reason"]'), '사유를 적어야 합니다');
    // 자격 없는 Client는 애초에 목록에 없다. 고를 수 없는 것을 화면에 두면 사람은
    // 거절당한 뒤에야 그것을 안다.
    assert.deepStrictEqual(Array.from(panel.querySelectorAll('[data-approve-field="clientId"] option')).map((option) => option.value), ['desk-h']);
    // 위임 근거는 위임 식별자가 필요해 화면이 실어 나를 수 없다. 안 되는 것을 고를 수
    // 있게 두면 눌러 본 사람만 그 사실을 알게 된다.
    assert(panel.querySelector('[data-approve-field="basis"] option[value="delegated"]').disabled, '화면이 못 하는 것은 고를 수 없어야 합니다');
    // 「문서 화면에서 열기」는 없앴다. 판이 서는 곳이 곧 그 문서의 화면이라 자기 자신으로
    // 가는 단추가 되고, 아무 데도 데려가지 않는 단추는 다음에 진짜 필요할 때도 안 눌린다.
    assert.strictEqual(panel.querySelector('[data-document="ADR-001"]'), null, '지금 보고 있는 화면으로 가는 단추를 두면 안 됩니다');
    // 덮는 표면은 자기 안에 닫는 길을 갖는다. 여는 손잡이는 본문 위 상태 줄에 있어서,
    // 판을 열고 스크롤을 내리면 그 손잡이가 화면 밖으로 나간다.
    panel.querySelector('.approval-panel-head [data-approve-open="ADR-001"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(dom.window.document.querySelector('#document-approval-panel .approval-panel'), null, '닫는 손잡이를 누르면 접혀야 합니다');
    dom.window.close();
  }

  // 2) 미승인은 비교 기준이 없다. 빈 차분을 그리면 사람은 아무것도 안 바뀐 줄 알고
  //    승인한다 — "비교 기준 없음"과 "바뀐 것 없음"은 다른 값이고, 서버가 그 사실을
  //    이유와 함께 내므로 화면은 그것을 옮기기만 하면 된다.
  {
    const reason = '승인 기록이 없어 비교 기준이 없습니다.';
    const { dom } = open((path) => (/\/diff\?/u.test(path) ? { body: { axis: 'since-approval', status: 'unapproved', diff: null, reason } } : null),
      [documentValue('ADR-002', trust('unapproved'))],
      { used: true, unknown: null, counts: { approved: 1, stale: 0, unapproved: 1 }, total: 1,
        items: [{ status: 'unapproved', id: 'ADR-002', kind: 'adr', title: '문서 ADR-002', file: 'docs/ADR-002.md', approvedBy: null, approvals: 0 }] },
      'review-inbox');
    dom.window.document.querySelector('#review-inbox-list [data-document="ADR-002"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    const panel = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert.strictEqual(panel.querySelector('.approval-diff'), null, '비교 기준이 없으면 빈 차분을 그리면 안 됩니다');
    assert(panel.textContent.includes('비교 기준이 없습니다'), '기준이 없다는 사실을 말해야 합니다');
    assert(panel.textContent.includes(reason), `서버의 이유를 그대로 옮겨야 합니다: ${panel.textContent}`);
    // 기준이 없어도 승인은 할 수 있어야 한다. 첫 승인이 바로 그 자리다.
    assert(panel.querySelector('button[type="submit"]'), '미승인 문서도 승인할 수 있어야 합니다');
    dom.window.close();
  }

  // 3) 승인이 실제로 나가고, 거절당하면 그 문장이 그대로 보인다. 사람 게이트에 걸렸으면
  //    왜 걸렸는지가 보여야 한다 — "승인 실패"로 뭉개면 무엇을 고쳐야 하는지 사라진다.
  {
    const refusal = '활성 human Client만 승인할 수 있습니다: agent-a은(는) 유형이 agent입니다.';
    let approved = null;
    const { dom } = open((path, options) => {
      if (/\/diff\?/u.test(path)) return { body: { axis: 'since-approval', status: 'stale', diff: '@@ -1 +1 @@\n+한 줄\n' } };
      if (/\/approve$/u.test(path)) {
        approved = JSON.parse(options.body);
        return approved.reason === '거절 볼 차례'
          ? { ok: false, status: 400, body: { error: refusal, code: 'approval-refused' } }
          : { body: { created: true, document: { id: 'ADR-003', status: 'approved', approvedBy: 'MEMBER-001' } } };
      }
      return null;
    },
    [documentValue('ADR-003', trust('stale'))],
    { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 0 }, total: 1,
      items: [{ status: 'stale', id: 'ADR-003', kind: 'adr', title: '문서 ADR-003', file: 'docs/ADR-003.md', approvedBy: 'MEMBER-001', approvals: 1 }] },
    'review-inbox');
    const click = (selector) => dom.window.document.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    click('#review-inbox-list [data-document="ADR-003"]');
    await settle();
    const fill = (field, value) => {
      const input = dom.window.document.querySelector(`[data-approve-field="${field}"]`);
      input.value = value;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    // 사유 없이 누르면 나가지 않는다. 사유를 받는 이유는 형식이 아니라, 훑기와 판단이
    // 같은 동작이 되지 않게 하는 유일한 자리이기 때문이다.
    dom.window.document.querySelector('[data-approve-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.strictEqual(approved, null, '사유 없이 승인이 나가면 안 됩니다');
    fill('reason', '거절 볼 차례');
    dom.window.document.querySelector('[data-approve-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.deepStrictEqual(approved.basis, [{ kind: 'read', detail: '' }], '근거가 함께 나가야 합니다');
    assert.strictEqual(approved.clientId, 'desk-h');
    const failed = dom.window.document.querySelector('#document-approval-panel .approval-failure');
    assert(failed, '거절이 화면에 남아야 합니다');
    assert.strictEqual(failed.textContent, refusal, '서버의 말을 삼키면 안 됩니다');
    // 쓴 것은 그대로 남는다. 거절당한 사람이 처음부터 다시 쓰게 하면 안 된다.
    assert.strictEqual(dom.window.document.querySelector('[data-approve-field="reason"]').value, '거절 볼 차례');
    dom.window.close();
  }

  // 4) 문서 상세에도 같은 자리가 있다. 인박스를 안 거치고 문서를 열어도 승인할 수
  //    있어야 하고, 그러지 않으면 화면을 보던 사람이 승인할 때마다 터미널로 갈아탄다.
  {
    const { dom } = open((path) => (/\/diff\?/u.test(path) ? { body: { axis: 'since-approval', status: 'stale', diff: '@@\n+상세에서 본 줄\n' } } : null),
      [documentValue('ADR-020', trust('stale'))], null, 'document', 'ADR-020');
    assert(dom.window.document.querySelector('#document-approval [data-approve-open="ADR-020"]'), '상세에도 승인으로 가는 손잡이가 있어야 합니다');
    dom.window.document.querySelector('#document-approval [data-approve-open="ADR-020"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    const panel = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert(panel, '상세에서도 그 자리에서 펼쳐져야 합니다');
    assert(panel.querySelector('.approval-diff').textContent.includes('상세에서 본 줄'), '상세도 차분을 실어야 합니다');
    // 판이 서는 곳이 곧 그 문서의 화면이라 "문서 화면에서 열기"는 자기 자신으로 가는 단추다.
    assert.strictEqual(panel.querySelector('[data-document="ADR-020"]'), null, '지금 보고 있는 화면으로 가는 단추를 두면 안 됩니다');
    // 두 축을 여기서 갈아탈 수 있어야 한다. 승인자가 판정해야 하는 것은 작업본이 아니라
    // 승인 후보이고, 그 둘이 다를 수 있다는 사실이 관문의 핵심이다.
    assert.strictEqual(panel.querySelectorAll('[data-approve-axis]').length, 2, '비교 축 둘을 고를 수 있어야 합니다');
    assert.strictEqual(text(dom, 'document-body').includes('상세에서 본 줄'), false, '차분이 본문을 덮으면 안 됩니다');
    dom.window.close();
  }

  // 5) 승인된 판에는 승인할 것이 없다. 아무 일도 하지 않는 단추를 두면 다음에 진짜로
  //    필요할 때도 안 눌린다.
  {
    const { dom } = open((path) => (/\/diff\?/u.test(path) ? { body: { axis: 'since-approval', status: 'approved', diff: '', reason: '현재 리비전이 승인되어 있습니다.' } } : null),
      [documentValue('ADR-030', trust('approved'))], null, 'document', 'ADR-030');
    dom.window.document.querySelector('#document-approval [data-approve-open="ADR-030"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    const panel = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert.strictEqual(panel.querySelector('[data-approve-form]'), null, '이미 승인된 판에 폼을 두면 안 됩니다');
    assert(panel.textContent.includes('이미 승인되어 있습니다'), '왜 폼이 없는지 말해야 합니다');
    assert(panel.textContent.includes('바뀐 것이 없습니다'), '빈 차분은 "바뀐 것이 없다"로 읽혀야 합니다');
    dom.window.close();
  }

  // 6) 자격자가 하나도 없으면 폼 대신 자격이 무엇인지를 적는다. 빈 선택 상자를 두면
  //    사람은 눌러 보고 나서야 승인할 수 없다는 것을 안다.
  {
    const { dom } = open((path) => (/\/diff\?/u.test(path) ? { body: { axis: 'since-approval', status: 'stale', diff: '@@\n+줄\n' } } : null),
      [documentValue('ADR-040', trust('stale'))], null, 'document', 'ADR-040', []);
    dom.window.document.querySelector('#document-approval [data-approve-open="ADR-040"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    const panel = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert.strictEqual(panel.querySelector('[data-approve-form]'), null, '고를 자격자가 없으면 폼을 세우면 안 됩니다');
    assert(panel.textContent.includes('활성 human Client'), '자격이 무엇인지 말해야 합니다');
    dom.window.close();
  }

  // 7) 「반려」가 「승인」 옆에 선다. 이 단추가 없는 동안 검토자가 "아니오"를 말할 자리가
  //    화면에 없었고, 그래서 그 판단은 댓글이나 태스크로 샜다 — 새면 원장 밖의 말이 되어
  //    상태를 만들지 못한다.
  {
    const refusal = '활성 human Client만 반려할 수 있습니다: agent-a은(는) 유형이 agent입니다.';
    let sent = null;
    const { dom } = open((path, options) => {
      if (/\/diff\?/u.test(path)) return { body: { axis: 'since-approval', status: 'stale', diff: '@@\n+반려당할 줄\n' } };
      if (/\/reject$/u.test(path)) {
        sent = JSON.parse(options.body);
        return { ok: false, status: 400, body: { error: refusal, code: 'rejection-refused' } };
      }
      return null;
    },
    [documentValue('ADR-050', trust('stale'))],
    { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 0 }, total: 1, rejected: 0,
      items: [{ status: 'stale', id: 'ADR-050', kind: 'adr', title: '문서 ADR-050', file: 'docs/ADR-050.md', approvedBy: 'MEMBER-001', approvals: 1 }] },
    'review-inbox');
    const click = (selector) => dom.window.document.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    click('#review-inbox-list [data-document="ADR-050"]');
    await settle();
    const panel = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert(panel.querySelector('[data-approve-reject="ADR-050"]'), '승인 옆에 반려가 서야 합니다');
    // 반려는 기본 단추가 아니다. 사유 칸에서 엔터를 친 사람이 반려를 보내게 되면 안 된다 —
    // 되돌릴 수 없는 판단은 눌러서만 나가야 한다.
    assert.strictEqual(panel.querySelector('[data-approve-reject]').getAttribute('type'), 'button', '반려가 폼의 기본 동작이 되면 안 됩니다');
    // 사유가 비면 보내지 않는다. 서버도 막지만 왕복하는 동안 사람은 자기가 무엇을
    // 빠뜨렸는지 모른 채 기다린다.
    click('[data-approve-reject="ADR-050"]');
    await settle();
    assert.strictEqual(sent, null, '사유 없이 반려가 나가면 안 됩니다');
    const reason = dom.window.document.querySelector('[data-approve-field="reason"]');
    reason.value = '   ';
    reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    click('[data-approve-reject="ADR-050"]');
    await settle();
    assert.strictEqual(sent, null, '공백뿐인 사유도 사유가 아닙니다');
    reason.value = '결정 근거가 헌장과 어긋납니다.';
    reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    click('[data-approve-reject="ADR-050"]');
    await settle();
    assert.strictEqual(sent.reason, '결정 근거가 헌장과 어긋납니다.');
    assert.strictEqual(sent.clientId, 'desk-h');
    // 근거는 반려의 칸이 아니다. 폼을 승인과 같이 쓰지만 계약은 둘이라, 화면이 근거를
    // 실어 보내면 서버가 모르는 필드로 거절한다.
    assert.strictEqual(sent.basis, undefined, '반려에 근거를 실어 보내면 안 됩니다');
    // 거절은 서버의 말 그대로 남는다. "반려 실패"로 뭉개면 무엇이 걸렸는지 사라진다.
    assert.strictEqual(dom.window.document.querySelector('#document-approval-panel .approval-failure').textContent, refusal);
    dom.window.close();
  }

  // 8) 반려한 문서는 검토 줄에서 빠지고 문서 화면이 그 사실을 말한다. 조용히 빼면 그
  //    판단이 어느 화면에도 남지 않고, 그것은 승인 옆에 반려가 없던 때와 같은 자리다.
  {
    const said = '3장의 범위가 헌장과 어긋납니다.';
    const { dom } = open((path) => (/\/diff\?/u.test(path) ? { body: { axis: 'since-approval', status: 'stale', diff: '@@\n+줄\n' } } : null),
      [documentValue('ADR-060', rejectedTrust('stale', said))], null, 'document', 'ADR-060');
    const detail = text(dom, 'document-approval');
    // 신뢰 상태의 말은 그대로다. 반려는 그 축을 건드리지 않는다.
    assert(detail.includes('낡음'), `신뢰 상태는 그대로여야 합니다: ${detail}`);
    assert(detail.includes('반려했습니다'), '반려 사실이 문서 화면에 서야 합니다');
    assert(detail.includes(said), '무엇을 고쳐야 하는지는 사유에만 있습니다');
    assert(detail.includes('rdl doc submit'), '되돌아올 길을 안내해야 합니다');
    dom.window.close();

    const inbox = open(() => null, [],
      { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 2 }, total: 1, rejected: 2,
        items: [{ status: 'stale', id: 'ADR-070', kind: 'adr', title: '문서 ADR-070', file: 'docs/ADR-070.md', approvedBy: 'MEMBER-001', approvals: 1 }] },
      'review-inbox');
    const summary = text(inbox.dom, 'review-inbox-summary');
    assert(summary.includes('2건') && summary.includes('반려되어'), `줄에서 빠진 수를 말해야 합니다: ${summary}`);
    // 셈과 줄이 어긋나는 이유가 둘이라 뭉치면 안 된다. 여기서 빠진 것은 잘린 것이
    // 아니라 반려된 것이고, 잘림으로 적으면 검토자는 자기가 방금 내린 판단을 스냅숏이
    // 삼킨 줄로 읽는다.
    inbox.dom.window.document.querySelector('[data-review-filter="unapproved"]').dispatchEvent(new inbox.dom.window.MouseEvent('click', { bubbles: true }));
    const filtered = text(inbox.dom, 'review-inbox-summary');
    assert(filtered.includes('2건 중 0건'), `거른 갈래에서도 어긋남을 말해야 합니다: ${filtered}`);
    assert(filtered.includes('작성자 차례로 넘어갔습니다') && !filtered.includes('앞 1건까지만'), `빠진 이유가 잘림이면 안 됩니다: ${filtered}`);
    inbox.dom.window.close();
  }

  console.log('document approval tests passed');

  // 9) 이력은 원장 사건과 커밋을 한 시간축에 낸다. 따로 세우면 사람이 두 목록의 시각을
  //    눈으로 번갈아 훑으며 머리로 합쳐야 하고, 그 합치기는 줄이 늘면 곧 실패한다 —
  //    실패하면 "승인 뒤에 저 커밋이 왔나 앞에 왔나"를 알 수 없고, 이력을 여는 이유가
  //    바로 그 물음이라 거기서 값이 통째로 사라진다.
  function historyValue(extra) {
    return Object.assign({
      project: 'demo',
      document: { id: 'ADR-080', title: '문서 ADR-080', file: 'docs/ADR-080.md', revision: 'a'.repeat(64), status: 'stale', approvedRevision: 'b'.repeat(64), approvedBy: 'MEMBER-001', approvals: 2 },
      approvals: [{ targetId: 'ADR-080', reviewedRevision: 'b'.repeat(64), approvedBy: 'MEMBER-001', basis: [{ kind: 'read', detail: '' }], reason: '읽고 책임집니다', recordedAt: '2026-08-10T00:00:00.000Z', eventId: 'EVT-A' }],
      submissions: [{ targetId: 'ADR-080', submittedRevision: 'c'.repeat(64), submittedBy: 'MEMBER-001', reason: '고쳐서 올립니다', recordedAt: '2026-08-20T00:00:00.000Z', eventId: 'EVT-S' }],
      rejections: [{ targetId: 'ADR-080', rejectedRevision: 'c'.repeat(64), rejectedBy: 'MEMBER-001', reason: '3장이 헌장과 어긋납니다', recordedAt: '2026-08-25T00:00:00.000Z', eventId: 'EVT-R' }],
      tasks: [{ id: 'TASK-0001', title: '3장 고치기', status: 'doing' }],
      commits: [
        { commit: 'f'.repeat(40), author: '강윤정', at: '2026-08-30T00:00:00.000Z', subject: '3장을 고쳤다' },
        { commit: 'e'.repeat(40), author: '강윤정', at: '2026-08-15T00:00:00.000Z', subject: '2장을 더했다' },
        { commit: 'd'.repeat(40), author: '강윤정', at: '2026-08-05T00:00:00.000Z', subject: '문서를 만들었다' }
      ]
    }, extra || {});
  }
  {
    const rangeDiff = 'diff --git a/docs/ADR-080.md b/docs/ADR-080.md\n@@ -1,2 +1,2 @@\n+세 판 전과 달라진 줄\n-옛 줄\n';
    let rangeQuery = null;
    const { dom, calls } = open((path) => {
      if (/\/history$/u.test(path)) return { body: historyValue({ warning: '이 문서의 현재 리비전은 승인도 연결된 태스크도 없습니다.' }) };
      if (/axis=range/u.test(path)) { rangeQuery = String(path); return { body: { axis: 'range', from: { kind: 'revision', value: 'b'.repeat(64), commit: '1'.repeat(40) }, to: { kind: 'commit', value: 'f'.repeat(40), commit: 'f'.repeat(40) }, diff: rangeDiff } }; }
      if (/\/diff\?/u.test(path)) return { body: { axis: 'since-approval', status: 'stale', diff: '@@\n+승인 이후 줄\n' } };
      return null;
    }, [documentValue('ADR-080', trust('stale'))], null, 'document', 'ADR-080');

    // 이력으로 가는 손잡이는 승인 옆에 선다. 승인 원장 줄은 "지금 어떤 상태인가"만 말하는데,
    // 검토하다 보면 "언제부터 이렇게 됐나"를 묻게 되고 그 답은 이력에만 있다.
    const historyOpener = dom.window.document.querySelector('#document-approval [data-approve-tab="history"]');
    assert(historyOpener, '문서 상세에 이력으로 가는 손잡이가 있어야 합니다');
    historyOpener.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    await settle();
    assert(calls.some((call) => call.path.includes('/documents/ADR-080/history')), `이력을 물어야 합니다: ${calls.map((call) => call.path).join(', ')}`);
    // 이력만 보러 온 사람에게 승인 축의 차분까지 미리 물으면, 쓰지도 않을 git 계산을 매번
    // 치른다 — 이 값들이 스냅숏 밖에 있는 이유가 그 비용이다.
    assert(!calls.some((call) => /axis=since-approval/u.test(call.path)), `열지 않은 탭의 값을 미리 물으면 안 됩니다: ${calls.map((call) => call.path).join(', ')}`);

    const panel = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert(panel, '이력도 본문 옆의 같은 판에서 열려야 합니다');
    // 모달이 아니라 같은 판의 탭이다. 모달은 이력을 넓게 볼 수 있지만 본문을 통째로
    // 가리는데, "언제부터 이렇게 됐나"를 묻는 사람은 그 답을 본문의 어느 문단에 겹쳐 읽는다.
    assert.strictEqual(dom.window.document.getElementById('document-body').hidden, false, '이력이 본문을 감추면 안 됩니다');
    assert(dom.window.document.getElementById('document-body').textContent.includes('본문'), '이력을 열어도 본문은 그대로 서야 합니다');
    assert.strictEqual(panel.querySelectorAll('.approval-tabs [data-approve-tab]').length, 2, '한 판이 두 물음을 탭으로 나눠 가져야 합니다');

    // 한 축이다. 종류를 지우지 않고 표시로 가르되 목록은 하나여야 한다.
    const rows = Array.from(panel.querySelectorAll('.history-list .history-row'));
    assert.strictEqual(panel.querySelectorAll('.history-list').length, 1, '원장 사건과 커밋이 한 목록에 서야 합니다');
    assert.deepStrictEqual(
      rows.map((row) => Array.from(row.classList).find((name) => name.startsWith('history-') && name !== 'history-row')),
      ['history-commit', 'history-rejection', 'history-submission', 'history-commit', 'history-approval', 'history-commit'],
      '한 시간축이라면 두 종류가 시각 순서대로 섞여 서야 합니다'
    );
    // 원장 줄은 누가·왜를 알고 커밋 줄은 무엇이·언제를 안다. 둘을 나란히 두는 것이 값이다.
    assert(rows[1].textContent.includes('3장이 헌장과 어긋납니다'), '반려의 사유가 그 줄에 있어야 합니다');
    assert(rows[4].textContent.includes('읽고 판단했다'), '승인의 근거가 그 줄에 있어야 합니다');
    assert(rows[0].textContent.includes('3장을 고쳤다'), '커밋의 제목이 그 줄에 있어야 합니다');
    assert(rows[0].textContent.includes('2026-08-30'), '언제인지는 달력의 값으로도 읽혀야 합니다');
    // 경고를 삼키지 않는다. 승인도 태스크도 없이 바뀐 정본은 이력이 답할 수 없는 변경이고,
    // 이 화면이 그 사실을 아는 유일한 자리다.
    assert(panel.textContent.includes('승인도 연결된 태스크도 없습니다'), '경고를 삼키면 안 됩니다');
    assert(panel.textContent.includes('TASK-0001'), '연결 태스크도 "왜 바뀌었나"의 갈래입니다');

    // 이력을 열면 흔히 묻는 것이 이미 골라져 있다 — 승인본 ↔ 가장 최근 커밋.
    assert(rangeQuery, '기본으로 고른 두 지점을 물어야 합니다');
    assert(rangeQuery.includes(`from=${'b'.repeat(64)}`), `기준은 승인본이어야 합니다: ${rangeQuery}`);
    assert(rangeQuery.includes(`to=${'f'.repeat(40)}`), `대상은 가장 최근 커밋이어야 합니다: ${rangeQuery}`);
    assert(panel.querySelector('.approval-diff').textContent.includes('세 판 전과 달라진 줄'), '고른 두 지점 사이의 차분이 보여야 합니다');
    // 차분 렌더링은 승인 판의 것을 그대로 쓴다. 두 벌 만들면 한쪽만 "기준 없음"과
    // "변경 없음"을 가르게 되고, 그 차이는 사람이 잘못 승인한 다음에야 드러난다.
    assert.strictEqual(panel.querySelectorAll('.diff-add').length, 1, '늘어난 줄은 승인 판과 같은 색으로 갈려야 합니다');

    // 두 번째를 고르기 전에도 화면은 무엇을 기다리는지 말한다. 안 말하면 사람은 한 번
    // 누른 뒤 아무 일도 안 일어난 줄로 읽는다.
    panel.querySelector('[data-history-clear="to"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    const waiting = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert(waiting.textContent.includes('「대상」을 하나 더 고르면'), `무엇을 기다리는지 말해야 합니다: ${waiting.textContent.slice(0, 200)}`);
    assert.strictEqual(waiting.querySelector('.approval-diff'), null, '지점이 하나뿐이면 차분을 지어내면 안 됩니다');

    // 다른 지점을 고르면 그 사이를 다시 묻는다. 커밋 줄은 커밋 해시로, 원장 줄은 리비전
    // 해시로 지목된다 — 종류를 하나로 통일하면 이력의 절반이 고를 수 없는 줄이 된다.
    rangeQuery = null;
    waiting.querySelector(`[data-history-pick="to"][data-history-point="${'e'.repeat(40)}"]`).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    assert(rangeQuery && rangeQuery.includes(`to=${'e'.repeat(40)}`), `고른 지점으로 다시 물어야 합니다: ${rangeQuery}`);
    dom.window.close();
  }

  // 10) 이력이 길면 앞쪽만 그리고 나머지는 「더 보기」로 편다. 오래된 정본은 커밋만 수십
  //     줄이라 통째로 그리면 판이 스크롤 덩어리가 되고, 이력을 여는 이유는 맨 위에 있다.
  {
    const many = [];
    for (let index = 0; index < 24; index += 1) {
      many.push({ commit: String(index).padStart(40, '0'), author: '강윤정', at: `2026-08-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`, subject: `커밋 ${index}` });
    }
    const { dom } = open((path) => {
      if (/\/history$/u.test(path)) return { body: historyValue({ approvals: [], submissions: [], rejections: [], tasks: [], commits: many }) };
      if (/axis=range/u.test(path)) return { body: { axis: 'range', from: {}, to: {}, diff: '' } };
      return null;
    }, [documentValue('ADR-081', trust('stale'))], null, 'document', 'ADR-081');
    dom.window.document.querySelector('#document-approval [data-approve-tab="history"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    await settle();
    const panel = () => dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert.strictEqual(panel().querySelectorAll('.history-row').length, 12, '한 번에 그리는 수를 정해야 합니다');
    const more = panel().querySelector('[data-history-expand]');
    assert(more, '나머지를 보는 길이 있어야 합니다');
    assert(more.textContent.includes('12개 더 보기'), `몇 개가 남았는지 말해야 합니다: ${more.textContent}`);
    // 더 보기는 그 자리에서 끝까지 편다. 열둘씩 또 나누면 찾는 것을 만날 때까지 몇 번을
    // 눌러야 하고, 몇 번 눌렀는지도 남지 않는다 — 인박스와 태스크 묶음이 쓰는 규칙과 같다.
    more.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    assert.strictEqual(panel().querySelectorAll('.history-row').length, 24, '더 보기는 끝까지 펴야 합니다');
    assert.strictEqual(panel().querySelector('[data-history-expand]'), null, '다 폈으면 손잡이가 남으면 안 됩니다');
    dom.window.close();
  }

  // 11) 이력을 못 읽으면 그 이유를 그대로 낸다. 삼키면 원장이 깨진 저장소와 아직 아무
  //     일도 없던 저장소가 화면에서 같아 보이고, 앞엣것은 고쳐야 할 사고인데 아무도 모른다.
  {
    const said = '승인 기록에는 schemaVersion 6 이상의 Workspace가 필요합니다.';
    const { dom } = open((path) => (/\/history$/u.test(path) ? { ok: false, status: 400, body: { error: said } } : null),
      [documentValue('ADR-082', trust('stale'))], null, 'document', 'ADR-082');
    dom.window.document.querySelector('#document-approval [data-approve-tab="history"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    await settle();
    const panel = dom.window.document.querySelector('#document-approval-panel .approval-panel');
    assert(panel.textContent.includes(said), `못 읽은 이유가 그대로 와야 합니다: ${panel.textContent.slice(0, 200)}`);
    assert.strictEqual(panel.querySelector('.history-list'), null, '못 읽었으면 빈 이력을 지어내면 안 됩니다');
    // 이력을 못 읽어도 승인 자리는 그대로다. 탭 하나가 막혔다고 판정하는 자리까지 잃으면
    // 사람은 화면을 떠나 명령줄로 가야 한다.
    dom.window.document.querySelector('.approval-tabs [data-approve-tab="approve"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    assert(dom.window.document.querySelector('#document-approval-panel [data-approve-form]'), '다른 탭이 막혀도 승인은 할 수 있어야 합니다');
    dom.window.close();
  }

  console.log('document history tests passed');
})();

// ── 통합 검색 ────────────────────────────────────────────────────────────────
//
// 사람이 요구한 것은 둘이었다. "검색어를 입력하면 아래쪽에 UI가 나타나고, 데이터소스랑
// 문서가 같이 표현되면" 그리고 "별도 검색 페이지". 그래서 여기서 못박는 것도 둘의 성질이다.
//
// 이 화면이 가르는 갈래는 글자가 파일에 있다는 것만으로는 하나도 지켜지지 않는다 —
// 못 찾은 것과 못 물어본 것, 결과 0건과 원장을 못 읽은 것, 잘린 목록과 전부인 목록,
// 늦게 온 답과 지금 답. 어느 갈래로 갔는가가 답이라 실제로 그려 보고 잰다.

// 두 자리와 목록 거르개 둘. 자리표시자가 없으면 렌더러가 그릴 곳이 없다.
assert(html.includes('id="search-view"'), '전용 검색 화면이 있어야 합니다');
assert(html.includes('id="search-dropdown"'), '머리 입력 밑에 열리는 자리가 있어야 합니다');
assert(html.includes('id="search-page-input"'), '전용 화면은 자기 입력을 가져야 합니다');
assert(html.includes('class="search-shell"'), '드롭다운은 입력과 같은 자리를 잡는 껍데기에 매달려야 합니다');
// 헤더의 칸은 목록 거르개를 겸하지 않는다. 겸하면 타자 한 번이 화면을 옮기면서 동시에
// 드롭다운을 여는, 서로를 방해하는 두 일을 한다.
assert(html.includes('id="documents-filter"') && html.includes('id="tasks-filter"'), '목록을 줄이는 입력은 그 화면이 가져야 합니다');
assert(!app.includes('state.query'), '한 값을 두 목록이 나눠 쓰면 화면을 옮길 때 같은 낱말이 다른 일을 합니다');
assert(app.includes('state.documentQuery') && app.includes('state.taskQuery'), '목록 거르개는 화면마다 자기 값을 가져야 합니다');

// 드롭다운은 헤더 밖으로 흘러나온다. 흐름에 두면 헤더가 결과 높이만큼 자라 본문이 통째로
// 아래로 밀리고, 밀린 만큼 보던 자리를 잃는다. jsdom은 조판을 계산하지 않으므로 픽셀을
// 만드는 규칙 자체를 잡는다.
assert(/\.search-dropdown\s*\{[^}]*position:\s*absolute/u.test(style), '드롭다운은 본문 흐름에서 빠져야 합니다');
assert(/\.search-dropdown\s*\{[^}]*left:\s*0/u.test(style), '드롭다운의 왼끝은 입력에 맞아야 합니다');
assert(/\.search-dropdown\s*\{[^}]*overflow-y:\s*auto/u.test(style), '결과가 길면 자기 안에서 스크롤해야 합니다');
// 전용 화면에서는 한 칸에 발췌가 셋까지 온다. flex 한 줄에 나눠 세우면 접지 않는 발췌가
// 좁은 칸 안에서 네댓 줄로 접혀, 읽는 차례가 없는 신문 단이 된다.
assert(/\.search-list \.search-match\s*\{[^}]*display:\s*grid/u.test(style), '펴 보는 자리에서는 발췌가 세로로 쌓여야 합니다');
assert(/\.search-list \.search-excerpt\s*\{[^}]*white-space:\s*normal/u.test(style), '전용 화면의 발췌는 한 줄에서 끊기지 않아야 합니다');
// 강조는 브라우저 기본 mark(노랑 바탕·검정 글자)로 두면 다크에서 그 줄만 튀어나온다.
assert(/mark\s*\{[^}]*background:\s*var\(--accent-subtle-BackgroundColor\)/u.test(style), '강조 색은 테마 토큰에서 와야 합니다');

(async () => {
  const { JSDOM } = require('jsdom');
  // 서버의 답을 손으로 준다. 실제 엔진은 search.test.js가 맡고, 여기서는 그 답을 받은
  // 화면이 어느 갈래로 가는지를 본다. defer를 단 답은 시험이 원하는 차례에 도착시킨다 —
  // 늦게 온 답이 먼저 온 답을 덮는 갈래는 그 차례를 손으로 잡아야만 재현된다.
  function mount(answer, hash) {
    const dom = new JSDOM(html, { url: `http://127.0.0.1/${hash || ''}`, runScripts: 'outside-only' });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const calls = [];
    dom.window.fetch = (path, options) => {
      const record = { path: String(path), options: options || {} };
      calls.push(record);
      const given = answer(String(path));
      if (!given) return new Promise(() => {});
      const reply = (value) => ({ ok: value.ok !== false, status: value.status || 200, json: () => Promise.resolve(value.body) });
      if (given.defer) return new Promise((resolve) => { record.send = (value) => resolve(reply(value)); });
      return Promise.resolve(reply(given));
    };
    dom.window.eval(`${app}\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name, selected) { setView(name, selected); }, state() { return state; } };`);
    return { dom, calls };
  }
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0));
  // 디바운스보다 넉넉히 기다린다. 이 수가 SEARCH_DEBOUNCE보다 작아지면 시험이 "요청이
  // 안 나갔다"를 통과시키는데, 그것은 기다림이 짧았다는 뜻이지 억눌렀다는 뜻이 아니다.
  const DEBOUNCED = 320;
  function snapshotOf(documents, tasks) {
    return {
      project: 'demo', documents: documents || [], tasks: { tasks: tasks || [] }, attention: [],
      people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
      presentation: { documentTypes: {}, documentStates: {} },
      approvers: [],
      reviewQueue: { used: false, unknown: null, counts: { approved: 0, stale: 0, unapproved: 0 }, total: 0, items: [] }
    };
  }
  function answerOf(overrides) {
    return Object.assign({
      root: '/w', projects: ['demo'], query: '가역성', source: null, minLength: 2, limit: 12,
      total: 0, truncated: false, counts: { document: 0, task: 0, ledger: 0 }, results: [],
      index: { used: false, reason: '정본을 읽습니다.' },
      scanned: { documents: 160, tasks: 144, ledger: { read: true, reason: null, ledgers: [], records: 21 } },
      status: 'ok'
    }, overrides);
  }
  function excerpt(text, ranges) { return { text, ranges }; }
  function hitOf(source, id, overrides) {
    const self = { kind: source === 'ledger' ? 'document' : source, id, title: `${id} 제목`, found: true };
    return Object.assign({
      source, kind: source, id, title: `${id} 제목`,
      origin: { kind: source, label: { document: '정본 문서', task: '태스크', ledger: '승인 사유' }[source] },
      attachedTo: self, score: 100, matchCount: 1,
      matches: [{ field: 'title', label: '제목', score: 100, count: 1, excerpts: [excerpt(`${id} 제목`, [[0, 2]])] }]
    }, overrides);
  }
  function type(dom, value) {
    const input = dom.window.document.getElementById('global-search');
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  const press = (dom, key, id) => dom.window.document.getElementById(id || 'global-search')
    .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const click = (dom, node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const searchCalls = (calls) => calls.filter((call) => call.path.includes('/search?'));
  const rowsOf = (dom, scope) => Array.from(dom.window.document.querySelectorAll(`${scope} .search-hit`));

  // 1) 언제 묻는가. 한 글자마다 보내면 문서 본문 전체를 훑는 질의가 타자 속도로 돈다 —
  //    이 저장소에서 질의 하나가 90~130ms이고 서버는 한 줄이라, 다섯 글자를 이어 치면
  //    다섯 요청이 서버를 물고 그 사이 스냅숏 폴링이 1초를 기다렸다. 손이 멈춘 뒤 한 번만 묻는다.
  {
    const { dom, calls } = mount((path) => (path.includes('/search?') ? { body: answerOf({ query: '가역성' }) } : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '가');
    type(dom, '가역');
    type(dom, '가역성');
    assert.strictEqual(searchCalls(calls).length, 0, '타자 도중에는 묻지 않아야 합니다');
    // 디바운스보다 짧은 시간을 실제로 지나 보낸다. 「친 직후」만 재면 setTimeout(…, 0)도
    // 통과하는데, 그것은 억누른 것이 아니라 한 틱 미룬 것이다.
    await settle(60);
    assert.strictEqual(searchCalls(calls).length, 0, `손이 멈추기 전에는 묻지 않아야 합니다: ${searchCalls(calls).map((call) => call.path).join(', ')}`);
    await settle(DEBOUNCED);
    assert.strictEqual(searchCalls(calls).length, 1, '손이 멈춘 뒤 한 번만 물어야 합니다');
    assert(searchCalls(calls)[0].path.includes('q=%EA%B0%80%EC%97%AD%EC%84%B1'), '마지막으로 친 낱말을 물어야 합니다');
    // 비운 것은 물음이 아니다. 지우는 동작이 가장 비싼 동작이 되면 안 된다.
    type(dom, '');
    await settle(DEBOUNCED);
    assert.strictEqual(searchCalls(calls).length, 1, '입력을 비우면 묻지 않아야 합니다');
    assert.strictEqual(dom.window.document.getElementById('search-dropdown').hidden, true, '비우면 자리도 접혀야 합니다');
    dom.window.close();
  }

  // 2) 늦게 온 답이 먼저 온 답을 덮지 않는다. 물은 순서와 답이 오는 순서는 같지 않고,
  //    뒤진 답이 이기면 화면은 사용자가 이미 지운 낱말의 결과를 보여 준다.
  {
    const { dom, calls } = mount((path) => (path.includes('/search?') ? { defer: true } : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '가역');
    await settle(DEBOUNCED);
    type(dom, '가역성');
    await settle(DEBOUNCED);
    const sent = searchCalls(calls);
    assert.strictEqual(sent.length, 2, '두 낱말을 각각 물었어야 합니다');
    // 나중 질의가 먼저 도착하고, 먼저 나간 질의가 뒤늦게 도착한다.
    sent[1].send({ body: answerOf({ query: '가역성', total: 1, counts: { document: 1, task: 0, ledger: 0 }, results: [hitOf('document', 'ADR-020')] }) });
    await settle();
    sent[0].send({ body: answerOf({ query: '가역', total: 1, counts: { document: 1, task: 0, ledger: 0 }, results: [hitOf('document', 'REQ-999')] }) });
    await settle();
    const shown = rowsOf(dom, '#search-dropdown').map((row) => row.textContent);
    assert(shown.length === 1 && shown[0].includes('ADR-020'), `마지막에 친 낱말의 답만 서 있어야 합니다: ${shown.join(' | ')}`);
    dom.window.close();
  }

  // 3) 강조는 서버가 준 자리로 화면이 만든다. 서버는 <mark>를 주지 않는다 — 검색 대상이
  //    문서 본문이라 강조를 HTML로 실으면 문서를 쓸 수 있는 사람이 보드를 여는 모든
  //    사람의 브라우저에 스크립트를 넣을 수 있다.
  {
    // 맞은 자리 안에 마크업이 든 경우. 이것이 없으면 강조를 문자열로 붙여도 시험이
    // 통과한다 — 사람이 문서에 적힌 태그를 그대로 검색하는 일은 실제로 일어난다.
    const nasty = '<img src=x onerror=alert(1)> <b>가역성</b>이 낮은 설정';
    const { dom } = mount((path) => (path.includes('/search?')
      ? { body: answerOf({ total: 1, counts: { document: 1, task: 0, ledger: 0 }, results: [hitOf('document', 'ADR-020', {
        matches: [{ field: 'body', label: '본문', score: 30, count: 2, excerpts: [
          excerpt(nasty, [[nasty.indexOf('<b>'), 10]]),
          // 글자 밖을 가리키는 범위는 그것만 버리고 글자는 남긴다.
          excerpt('짧은 글', [[99, 3]])
        ] }]
      })] }) }
      : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '가역성');
    await settle(DEBOUNCED);
    const row = rowsOf(dom, '#search-dropdown')[0];
    const marks = Array.from(row.querySelectorAll('mark'));
    assert.strictEqual(marks.length, 1, '맞은 자리에 강조 요소가 서야 합니다');
    assert.strictEqual(marks[0].textContent, '<b>가역성</b>', '강조는 서버가 준 자리와 길이여야 하고, 그 안의 글자도 글자로 남아야 합니다');
    assert.strictEqual(row.querySelectorAll('b').length, 0, '강조 안의 태그가 요소가 되면 안 됩니다');
    // 발췌에 적힌 태그는 글자로만 남는다. 요소가 되면 그 순간 문서 본문이 마크업이 된다.
    assert.strictEqual(row.querySelectorAll('img').length, 0, '발췌의 태그가 요소가 되면 안 됩니다');
    assert(row.textContent.includes('<img src=x onerror=alert(1)>'), '태그는 글자 그대로 보여야 합니다');
    dom.window.close();
  }

  // 4) 자르는 축과 정렬 축이 겹치면 특정 갈래가 통째로 도달 불가가 된다. 검토 인박스가
  //    그렇게 무너졌다. 자르는 일은 엔진이 갈래마다 최소 자리를 남기며 하고(limit을 그대로
  //    넘긴다), 화면은 받은 것을 다시 끊지 않는다.
  {
    // 서버가 주는 차례는 관련도순이라 갈래가 섞여 있다. 묶여서 오는 목록을 주면
    // 순서를 맞추는 코드가 없어도 시험이 통과해, 붙잡으려던 결함이 그대로 빠져나간다.
    const results = [];
    for (let index = 0; index < 8; index += 1) {
      results.push(hitOf('document', `REQ-${String(index).padStart(3, '0')}`));
      if (index === 0) results.push(hitOf('task', 'TASK-A'));
      if (index === 1) results.push(hitOf('ledger', 'EV-1', { title: 'ADR-020의 승인 사유', attachedTo: { kind: 'document', id: 'ADR-020', title: '설정 자유도', found: true } }));
      if (index === 4) results.push(hitOf('task', 'TASK-B'));
      if (index === 6) results.push(hitOf('ledger', 'EV-2', { title: 'TASK-A의 댓글', origin: { kind: 'task.comment', label: '댓글' }, attachedTo: { kind: 'task', id: 'TASK-A', title: '태스크 하나', found: true } }));
    }
    const { dom, calls } = mount((path) => (path.includes('/search?')
      ? { body: answerOf({ total: 125, truncated: true, counts: { document: 107, task: 14, ledger: 4 }, results }) }
      : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '승인');
    await settle(DEBOUNCED);
    assert(searchCalls(calls)[0].path.includes('limit=12'), '자르는 폭은 엔진에 그대로 넘겨야 합니다');
    const drop = dom.window.document.getElementById('search-dropdown');
    const heads = Array.from(drop.querySelectorAll('.search-group-head')).map((head) => head.textContent);
    assert.strictEqual(heads.length, 3, `갈래 셋이 한 번씩만 서야 합니다: ${heads.join(' | ')}`);
    // 갈래 안에서는 서버가 준 차례가 그대로 살아 있어야 한다. 묶느라 순서를 새로 지으면
    // 관련도가 사라지고, 그때 목록의 위아래는 아무 뜻도 없는 줄이 된다.
    const documentIds = rowsOf(dom, '#search-dropdown').filter((row) => row.textContent.includes('REQ-')).map((row) => row.querySelector('.search-hit-id').textContent);
    assert.deepStrictEqual(documentIds, ['REQ-000', 'REQ-001', 'REQ-002', 'REQ-003', 'REQ-004', 'REQ-005', 'REQ-006', 'REQ-007'], '갈래 안의 차례는 서버가 준 그대로여야 합니다');
    assert(heads[0].includes('107건 중 8건') && heads[1].includes('14건 중 2건') && heads[2].includes('4건 중 2건'),
      `묶음 머리글은 실린 수와 전건을 함께 말해야 합니다: ${heads.join(' | ')}`);
    // 눈에 보이는 차례와 키보드가 짚는 차례는 같아야 한다. 서버는 관련도로 보내고 화면은
    // 갈래로 묶으므로, 순서를 맞추지 않으면 ↓ 한 번이 화면 아래쪽 묶음으로 건너뛴다.
    const visual = rowsOf(dom, '#search-dropdown').map((row) => row.id);
    const walked = [];
    const input = dom.window.document.getElementById('global-search');
    for (let index = 0; index < visual.length; index += 1) { press(dom, 'ArrowDown'); walked.push(input.getAttribute('aria-activedescendant')); }
    assert.deepStrictEqual(walked, visual, '↓는 눈에 보이는 다음 줄로 가야 합니다');
    // 끝에서는 멈춘다. 되감으면 목록의 끝이 어디인지 손으로 알 수 없다.
    press(dom, 'ArrowDown');
    assert.strictEqual(input.getAttribute('aria-activedescendant'), visual[visual.length - 1], '마지막 줄에서 멈춰야 합니다');
    // 잘렸으면 잘렸다고 적는다. 이 손잡이가 전용 화면으로 가는 길이다.
    const more = drop.querySelector('.search-more');
    assert(more.textContent.includes('125') && more.textContent.includes('12'), `몇 건을 두고 왔는지 적어야 합니다: ${more.textContent}`);
    click(dom, more);
    assert.strictEqual(dom.window.document.getElementById('search-view').hidden, false, '더 보기는 전용 화면으로 가야 합니다');
    assert(dom.window.location.hash.includes('view=search'), `주소가 화면을 말해야 합니다: ${dom.window.location.hash}`);
    dom.window.close();
  }

  // 5) 키보드. 드롭다운은 마우스만으로 쓰는 물건이 아니다. Esc는 여기서 멈춰 세워야
  //    한다 — 안 그러면 같은 Esc가 옆에 열어 둔 peek까지 닫는다.
  {
    const { dom } = mount((path) => (path.includes('/search?')
      ? { body: answerOf({ total: 2, counts: { document: 1, task: 1, ledger: 0 }, results: [hitOf('document', 'ADR-020'), hitOf('task', 'TASK-A')] }) }
      : null));
    // 연 문서는 상세가 실제로 그려지는 데 필요한 칸을 다 갖는다. 빠지면 여는 것까지는
    // 되고 그 뒤가 조용히 던져, 시험은 통과하는데 화면은 반쪽으로 선다.
    dom.window.__probe.snapshot(snapshotOf(
      [{ id: 'ADR-020', kind: 'adr', type: 'document', title: '설정 자유도', description: '설명', file: 'docs/a.md', state: 'accepted', owner: 'MEMBER-001', modifiedAt: '2026-08-20T00:00:00Z', revision: 'a'.repeat(64), body: '본문', tags: [], related: [] }],
      [{ id: 'TASK-A', title: '태스크 하나', status: 'todo', priority: 'high', acceptanceCriteria: {}, links: [] }]));
    const input = dom.window.document.getElementById('global-search');
    type(dom, '가역성');
    await settle(DEBOUNCED);
    assert.strictEqual(input.getAttribute('aria-expanded'), 'true', '열린 자리는 그 사실을 알려야 합니다');
    // 짚은 줄이 없을 때의 Enter는 전용 화면으로 간다 — 치고 나서 Enter가 「전부 보기」의
    // 가장 짧은 길이다.
    press(dom, 'Enter');
    assert.strictEqual(dom.window.document.getElementById('search-view').hidden, false, '짚은 줄이 없으면 Enter는 전용 화면을 엽니다');
    type(dom, '가역성');
    await settle(DEBOUNCED);
    press(dom, 'ArrowDown');
    press(dom, 'ArrowDown');
    assert.strictEqual(input.getAttribute('aria-activedescendant'), 'search-hit-1', '↓ 두 번이면 둘째 줄이어야 합니다');
    press(dom, 'ArrowUp');
    press(dom, 'ArrowUp');
    assert.strictEqual(input.getAttribute('aria-activedescendant'), null, '↑로 입력까지 돌아올 수 있어야 합니다');
    press(dom, 'ArrowDown');
    press(dom, 'Enter');
    assert.strictEqual(dom.window.document.getElementById('document-view').hidden, false, 'Enter는 짚은 줄을 엽니다');
    assert(dom.window.location.hash.includes('entity=ADR-020'), `연 것이 주소에 남아야 합니다: ${dom.window.location.hash}`);
    // Esc는 드롭다운만 접고 거기서 멈춘다.
    type(dom, '가역성');
    await settle(DEBOUNCED);
    let escaped = false;
    dom.window.document.addEventListener('keydown', (event) => { if (event.key === 'Escape') escaped = true; });
    press(dom, 'Escape');
    assert.strictEqual(dom.window.document.getElementById('search-dropdown').hidden, true, 'Esc는 자리를 접어야 합니다');
    assert.strictEqual(escaped, false, 'Esc는 여기서 멈춰야 합니다. 안 그러면 옆에 열어 둔 것까지 함께 닫힙니다');
    dom.window.close();
  }

  // 6) 못 찾은 것과 못 물어본 것과 서버가 거절한 것은 서로 다른 상태다. 한 문장으로
  //    뭉개면 무엇을 해야 하는지가 사라진다.
  {
    // 두 글자가 안 된 것은 거절이 아니라 아직 이른 것이고, 기준은 서버가 답에 실어 준다.
    const { dom } = mount((path) => (path.includes('/search?') ? { body: answerOf({ status: 'too-short', query: '가', minLength: 2 }) } : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '가');
    await settle(DEBOUNCED);
    assert(dom.window.document.getElementById('search-dropdown').textContent.includes('2자 이상'), '아직 이른 상태를 안내해야 합니다');
    dom.window.close();
  }
  {
    const { dom } = mount((path) => (path.includes('/search?') ? { body: answerOf({ query: '없는낱말', total: 0 }) } : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '없는낱말');
    await settle(DEBOUNCED);
    const text = dom.window.document.getElementById('search-dropdown').textContent;
    // 훑은 양을 함께 적어야 "없다"가 된다. 안 적으면 못 읽은 것과 구분되지 않는다.
    assert(text.includes('맞는 것이 없습니다'), `없다고 말해야 합니다: ${text}`);
    assert(text.includes('160') && text.includes('144') && text.includes('21'), `무엇을 훑었는지 적어야 합니다: ${text}`);
    dom.window.close();
  }
  {
    // 서버의 거절은 그대로 옮긴다. 다듬으면 무엇을 고쳐야 하는지가 사라진다.
    const said = '검색어는 200자 이하여야 합니다.';
    const { dom } = mount((path) => (path.includes('/search?') ? { ok: false, status: 400, body: { error: said, code: 'query-too-long' } } : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '가'.repeat(210));
    await settle(DEBOUNCED);
    const drop = dom.window.document.getElementById('search-dropdown');
    assert(drop.textContent.includes(said), `거절 문장이 그대로 와야 합니다: ${drop.textContent}`);
    assert(drop.textContent.includes('query-too-long'), '거절의 종류도 함께 보여야 합니다');
    assert.strictEqual(drop.querySelector('.search-hit'), null, '거절당했으면 결과를 지어내면 안 됩니다');
    dom.window.close();
  }
  {
    // 원장 결과 0건과 원장을 못 읽은 것은 다르다. 삼키면 깨진 저장소와 아직 아무 일도
    // 없던 저장소가 화면에서 같아 보인다.
    const reason = '이 작업공간은 원장을 갖기 전 판입니다.';
    const { dom } = mount((path) => (path.includes('/search?')
      ? { body: answerOf({ total: 1, counts: { document: 1, task: 0, ledger: 0 }, results: [hitOf('document', 'ADR-020')], scanned: { documents: 160, tasks: 144, ledger: { read: false, reason, ledgers: [], records: 0 } } }) }
      : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '가역성');
    await settle(DEBOUNCED);
    assert(dom.window.document.getElementById('search-dropdown').textContent.includes(reason), '원장을 못 읽은 이유가 그대로 와야 합니다');
    dom.window.close();
  }

  // 7) 전용 화면. 결과 전부를 출처별로 갈라 놓고, 어느 칸이 맞았는지와 그 문맥을 함께 싣는다.
  {
    const results = [
      hitOf('document', 'REQ-064', { documentKind: 'requirements', state: 'draft', matches: [
        { field: 'title', label: '제목', score: 100, count: 1, excerpts: [excerpt('승인 모드 네 가지', [[0, 2]])] },
        { field: 'body', label: '본문', score: 30, count: 2, excerpts: [excerpt('승인 근거의 종류', [[0, 2]]), excerpt('재승인이 쌀 때만', [[1, 2]])] }
      ] }),
      hitOf('task', 'TASK-A', { status: 'todo', priority: 'high' }),
      hitOf('ledger', 'EV-1', { title: 'ADR-020의 승인 사유', by: 'MEMBER-001', recordedAt: '2026-08-21T00:00:00Z',
        attachedTo: { kind: 'document', id: 'ADR-020', title: '설정 자유도', found: true } })
    ];
    const { dom, calls } = mount((path) => (path.includes('/search?')
      ? { body: answerOf({ query: '승인', limit: 200, total: 217, truncated: true, counts: { document: 136, task: 78, ledger: 3 }, results }) }
      : null));
    dom.window.__probe.snapshot(snapshotOf());
    dom.window.__probe.state().searchPage.query = '승인';
    dom.window.__probe.view('search');
    await settle();
    const asked = searchCalls(calls);
    assert(asked[0].path.includes('limit=200'), '전용 화면은 엔진의 상한까지 받아야 합니다');
    assert(!asked[0].path.includes('source='), '셈을 얻으려면 거르개 없이 물어야 합니다');
    const sections = Array.from(dom.window.document.querySelectorAll('#search-results .search-section'));
    assert.strictEqual(sections.length, 3, '결과는 출처별로 갈려야 합니다');
    assert(sections[0].querySelector('h2').textContent.includes('136건 중 1건'), '갈래마다 전건과 실린 수를 말해야 합니다');
    // 어느 칸이 맞았는지(label)와 그 문맥(excerpts)이 함께 실려야 한다.
    const first = sections[0].querySelector('.search-hit');
    const labels = Array.from(first.querySelectorAll('.search-match-label')).map((node) => node.textContent);
    assert.deepStrictEqual(labels, ['제목', '본문'], `맞은 칸의 이름이 서야 합니다: ${labels.join(', ')}`);
    assert.strictEqual(first.querySelectorAll('.search-excerpt').length, 3, '한 칸에서 여러 군데가 맞으면 모두 실어야 합니다');
    assert.strictEqual(first.querySelectorAll('mark').length, 3, '발췌마다 맞은 자리가 강조돼야 합니다');
    // 원장 줄은 그 자체로 읽을 수 없다. 무엇에 붙은 것인지가 있어야 뜻이 선다.
    const ledgerRow = sections[2].querySelector('.search-hit');
    assert(ledgerRow.textContent.includes('정본 문서 ADR-020'), `원장 줄은 붙은 대상을 말해야 합니다: ${ledgerRow.textContent}`);
    assert(ledgerRow.textContent.includes('승인 사유'), '어느 원장 줄인지도 말해야 합니다');
    // 자른 것은 엔진이다. 몇 건을 두고 왔는지 안 적으면 사람은 이것이 전부인 줄 안다.
    assert(dom.window.document.getElementById('search-notes').textContent.includes('200건에서 잘랐습니다'), '잘렸으면 잘렸다고 적어야 합니다');
    dom.window.close();
  }

  // 8) 출처 거르개. 셈은 언제나 거르개 없는 질의에서 오고, 그 갈래가 잘렸을 때만 다시 묻는다.
  //    안 잘린 갈래를 다시 묻는 것은 이미 들고 있는 답을 또 사 오는 일이다.
  {
    const results = [hitOf('document', 'REQ-064'), hitOf('task', 'TASK-A'), hitOf('ledger', 'EV-1')];
    const { dom, calls } = mount((path) => {
      if (!path.includes('/search?')) return null;
      if (path.includes('source=document')) return { body: answerOf({ query: '승인', limit: 200, source: 'document', total: 136, counts: { document: 136, task: 0, ledger: 0 }, results: [hitOf('document', 'REQ-064'), hitOf('document', 'REQ-075')] }) };
      return { body: answerOf({ query: '승인', limit: 200, total: 138, truncated: true, counts: { document: 136, task: 1, ledger: 1 }, results }) };
    });
    dom.window.__probe.snapshot(snapshotOf());
    dom.window.__probe.state().searchPage.query = '승인';
    dom.window.__probe.view('search');
    await settle();
    await settle();
    const chips = Array.from(dom.window.document.querySelectorAll('#search-source-filter button')).map((node) => node.textContent);
    assert.deepStrictEqual(chips, ['전체 138', '정본 문서 136', '태스크 1', '원장 1'], `거르개는 전건을 세어야 합니다: ${chips.join(' | ')}`);
    // 안 잘린 갈래(태스크 1건 중 1건)는 다시 묻지 않는다.
    const before = searchCalls(calls).length;
    click(dom, dom.window.document.querySelector('[data-search-source="task"]'));
    await settle();
    assert.strictEqual(searchCalls(calls).length, before, '이미 다 들고 있는 갈래를 다시 물으면 안 됩니다');
    assert.strictEqual(dom.window.document.querySelectorAll('#search-results .search-section').length, 1, '고른 갈래만 서야 합니다');
    assert(dom.window.location.hash.includes('source=task'), `고른 갈래가 주소에 남아야 합니다: ${dom.window.location.hash}`);
    // 잘린 갈래(문서 136건 중 1건)는 그 갈래만 걸어 다시 묻는다. 안 그러면 셈이 136이라
    // 말한 목록에서 1건만 보인다 — 검토 인박스가 겪은 바로 그 자리다.
    click(dom, dom.window.document.querySelector('[data-search-source="document"]'));
    await settle();
    await settle();
    const scoped = searchCalls(calls).pop();
    assert(scoped.path.includes('source=document'), `잘린 갈래는 그 갈래만 다시 물어야 합니다: ${scoped.path}`);
    assert.strictEqual(rowsOf(dom, '#search-results').length, 2, '다시 물어 온 목록이 서야 합니다');
    // 거르개의 수는 여전히 전건이다. 거르개를 건 답에서 세면 나머지 칸이 전부 0이 된다.
    const after = Array.from(dom.window.document.querySelectorAll('#search-source-filter button')).map((node) => node.textContent);
    assert.deepStrictEqual(after, chips, '거르개의 수는 거르개 없는 질의에서 와야 합니다');
    dom.window.close();
  }

  // 9) 주소가 곧 질의다. 남에게 준 링크로 들어온 사람이 같은 결과를 봐야 한다.
  {
    const { dom, calls } = mount((path) => {
      if (path === '/api/projects') return { body: [{ key: 'demo', name: 'Demo' }] };
      if (path.includes('/search?')) return { body: answerOf({ query: '가역성', limit: 200, total: 1, counts: { document: 0, task: 0, ledger: 1 }, results: [hitOf('ledger', 'EV-1')] }) };
      // 스냅숏은 영영 안 온 것으로 둔다. 여기서 보는 것은 부팅이 아니라 주소다.
      return null;
    }, '#project=demo&view=search&q=%EA%B0%80%EC%97%AD%EC%84%B1&source=ledger');
    await settle(20);
    const page = dom.window.__probe.state().searchPage;
    assert.strictEqual(page.query, '가역성', '주소의 질의가 상태로 들어와야 합니다');
    assert.strictEqual(page.source, 'ledger', '주소의 출처도 함께 들어와야 합니다');
    assert.strictEqual(dom.window.document.getElementById('search-page-input').value, '가역성', '전용 화면의 입력이 그 질의를 들고 있어야 합니다');
    assert.strictEqual(dom.window.document.getElementById('global-search').value, '가역성', '머리 입력도 같은 질의를 들고 있어야 합니다');
    dom.window.__probe.snapshot(snapshotOf());
    dom.window.__probe.view('search');
    await settle();
    assert(searchCalls(calls).some((call) => call.path.includes('q=%EA%B0%80%EC%97%AD%EC%84%B1')), '주소의 질의를 실제로 물어야 합니다');
    assert(dom.window.location.hash.includes('source=ledger'), `고른 갈래가 주소에 남아야 합니다: ${dom.window.location.hash}`);
    dom.window.close();
  }

  // 10) 폴링이 치던 글자를 지우지 않는다. 이 칸의 값은 디바운스가 끝나야 상태에 들어가므로,
  //     그 사이에 스냅숏이 바뀌어 화면을 다시 그리면 아직 상태에 없는 글자가 통째로 되돌아간다.
  //     댓글을 쓰는 중에 폴링이 편집기를 갈아치우지 않는 것과 같은 자리다.
  {
    const { dom } = mount((path) => (path.includes('/search?')
      ? { body: answerOf({ query: '가역성', limit: 200, total: 1, counts: { document: 1, task: 0, ledger: 0 }, results: [hitOf('document', 'ADR-020')] }) }
      : null));
    dom.window.__probe.snapshot(snapshotOf());
    dom.window.__probe.state().searchPage.query = '가역성';
    dom.window.__probe.view('search');
    await settle();
    const field = dom.window.document.getElementById('search-page-input');
    field.focus();
    field.value = '가역성 이후';
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    // 디바운스가 끝나기 전에 폴링이 화면을 다시 그린다.
    dom.window.__probe.view('search');
    assert.strictEqual(field.value, '가역성 이후', '치던 글자를 폴링이 되돌리면 안 됩니다');
    // 손이 없는 칸은 그대로 맞춘다 — 머리 입력과 전용 화면의 입력은 같은 질의를 들어야 한다.
    await settle(DEBOUNCED);
    assert.strictEqual(dom.window.document.getElementById('global-search').value, '가역성 이후', '두 입력은 같은 질의를 들고 있어야 합니다');
    dom.window.close();
  }

  // 11) 붙을 자리를 못 찾은 원장 줄. 눌러도 아무 일이 없는 줄은 고장으로 읽히므로,
  //     열 자리가 없다는 사실과 그 이유를 말한다 — 지워진 대상을 지어내지도 않는다.
  {
    const orphan = hitOf('ledger', 'EV-9', { title: '댓글 정정', attachedTo: { kind: 'comment', id: 'EV-0', title: null, found: false } });
    const { dom } = mount((path) => (path.includes('/search?')
      ? { body: answerOf({ total: 1, counts: { document: 0, task: 0, ledger: 1 }, results: [orphan] }) }
      : null));
    dom.window.__probe.snapshot(snapshotOf());
    type(dom, '가역성');
    await settle(DEBOUNCED);
    const row = rowsOf(dom, '#search-dropdown')[0];
    assert(row.textContent.includes('찾지 못함'), `못 찾은 대상은 그 사실을 적어야 합니다: ${row.textContent}`);
    // 서 있던 화면이 그대로여야 한다. 「문서 상세가 안 열렸다」만 재면 목록 화면으로
    // 튕기는 갈래가 그대로 빠져나간다 — 사람이 보기에는 그것도 「누르니 딴 데로 갔다」다.
    const standing = () => Array.from(dom.window.document.querySelectorAll('.view')).filter((view) => !view.hidden).map((view) => view.id);
    const before = standing();
    click(dom, row);
    assert.deepStrictEqual(standing(), before, '갈 곳이 없으면 화면을 옮기면 안 됩니다');
    assert(dom.window.document.getElementById('message').textContent.includes('열 자리가 없습니다'), '왜 안 열리는지 말해야 합니다');
    dom.window.close();
  }

  console.log('unified search tests passed');
})();
