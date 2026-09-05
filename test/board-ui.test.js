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
assert(app.includes("(task.reviewers || []).includes(state.currentMember)"), 'My Review must filter by reviewer identity');
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
assert(/\.app-header \.search:focus-within\s*\{/u.test(style), '접힌 검색은 초점이 오면 펼쳐져야 합니다');

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
// 목록을 한참 내려간 뒤에도 어느 화면인지와 주요 동작을 잃지 않아야 한다.
assert(/\.page-heading,\s*\.reader-heading\s*\{[^}]*position:\s*sticky/u.test(style), '본문 제목 줄도 스크롤 중 남아야 합니다');
assert(/\.page-heading,\s*\.reader-heading\s*\{[^}]*top:\s*var\(--header-Height\)/u.test(style), '본문 제목은 앱 헤더 아래에 붙어야 합니다');

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
  const render = app.slice(app.indexOf('function reviewRowHtml'), app.indexOf('function renderHome'));
  // 서버는 낡음을 앞에 두고 이미 정렬해 보낸다. 화면이 다시 정렬하면 두 순서가 갈리고,
  // 그때 화면이 말하는 "먼저 볼 것"은 근거 없는 순서가 된다.
  assert(!render.includes('.sort('), '서버가 정한 순서를 화면이 다시 정하면 안 됩니다');
  // 판정을 새로 짓지 않는다. 리비전을 비교하는 순간 rdl doc status와 보드가 같은 문서에
  // 다른 답을 내고, 그때 사람이 믿는 쪽은 화면이다.
  assert(!render.includes('revision'), '화면이 승인 판정을 다시 지으면 안 됩니다');
  assert(render.includes('data-document='), '펼친 자리에서 문서 화면으로 가는 길은 이미 있는 경로를 그대로 써야 합니다');
  // 펼치는 것과 승인하는 것은 같은 자리에 있어야 한다. 펼쳐 놓고 승인은 다른 화면에서
  // 하게 하면 인박스는 다시 목록이 된다.
  assert(render.includes('data-approve-open='), '행은 그 자리에서 펼쳐져야 합니다');
  assert(render.includes('approvalPanelHtml(item.id'), '펼친 자리에 승인 판이 서야 합니다');
}
assert(app.includes("if (button.dataset.document) return setView('document', button.dataset.document);"), '문서로 가는 길은 하나여야 합니다');

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
    dom.window.eval(app + '\n;window.__probe = { snapshot(value) { state.snapshot = value; }, view(name) { setView(name); } };');
    return dom;
  }
  function snapshot(reviewQueue, documents) {
    return {
      project: 'demo', documents: documents || [], tasks: { tasks: [] }, attention: [],
      people: { members: [{ id: 'MEMBER-001', name: '강윤정' }], stakeholders: [], roles: [] },
      presentation: { documentTypes: {}, documentStates: {} },
      reviewQueue
    };
  }
  function queueItems(count, staleCount) {
    const items = [];
    for (let index = 0; index < count; index += 1) {
      const stale = index < staleCount;
      items.push({
        status: stale ? 'stale' : 'unapproved', id: `ADR-${String(index).padStart(3, '0')}`,
        type: 'adr', title: `문서 ${index}`, file: 'docs/a.md',
        approvedBy: stale ? 'MEMBER-001' : null, approvals: stale ? 2 : 0
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

  // 1) 줄이 잘렸다는 사실. board.js가 셈은 전건으로 하고 목록만 자르는 이유가 이것이다 —
  //    화면이 "133건 중 50건"을 말할 수 있어야 줄의 길이가 보이고, 길이가 보여야 사람이
  //    승인을 관문으로 쓸지 판단한다. 목록의 길이를 줄의 길이로 적으면 그 판단이 막힌다.
  {
    const dom = open({ used: true, unknown: null, counts: { approved: 84, stale: 10, unapproved: 123 }, total: 133, items: queueItems(50, 10) }, []);
    const summary = textOf(dom, 'review-inbox-summary');
    assert(summary.includes('133건 중 50건'), `잘린 사실을 말해야 합니다: ${summary}`);
    assert(summary.includes('133') && summary.includes('10') && summary.includes('123') && summary.includes('84'), '전건 셈 넷이 헤더에 있어야 합니다');
    const rows = rowsOf(dom);
    assert.strictEqual(rows.length, 50, '실린 만큼만 그려야 합니다');
    // 서버가 낡음을 앞에 두고 보냈다. 그 순서가 그대로 살아 있어야 한다.
    assert.deepStrictEqual(rows.slice(0, 10).map((row) => row.querySelector('.tag').textContent), new Array(10).fill('낡음'), '낡음이 먼저여야 합니다');
    assert.strictEqual(rows[10].querySelector('.tag').textContent, '미승인', '미승인은 낡음 뒤에 서야 합니다');
    // 행의 첫 동작은 문서 화면으로 가는 것이 아니라 그 자리에서 펼치는 것이다. 인박스의
    // 값은 줄을 훑으면서 처리하는 데 있고, 한 건마다 화면을 오가면 훑던 자리를 매번
    // 잃는다 — 그러면 남는 것은 목록이지 인박스가 아니다. 문서로 가는 길은 펼친 안에 있다.
    assert.strictEqual(rows[0].dataset.approveOpen, 'ADR-000', '행은 그 문서의 승인 자리를 여는 손잡이여야 합니다');
    assert.strictEqual(rows[0].dataset.document, undefined, '행을 누르면 화면이 갈아치워지면 안 됩니다');
    assert(rows[0].textContent.includes('강윤정') && rows[0].textContent.includes('승인 2회'), '승인자와 승인 횟수가 행에 있어야 합니다');
    assert(rows[10].textContent.includes('승인 이력 없음'), '미승인 행은 빈 칸이 아니라 없다고 적어야 합니다');
    // 거르개의 수는 전건이다. 목록의 길이를 적으면 잘린 줄에서 두 수가 어긋난다.
    assert(textOf(dom, 'review-inbox-filter').includes('낡음 10') && textOf(dom, 'review-inbox-filter').includes('미승인 123'), '거르개는 전건을 세어야 합니다');
    dom.window.document.querySelector('[data-review-filter="stale"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(rowsOf(dom).length, 10, '낡음만 남아야 합니다');
    dom.window.close();
  }

  // 2) 거른 뒤에도 잘림은 그 갈래의 수로 말한다. 전체 기준으로만 말하면 낡음 60건 중
  //    50건을 보면서 화면은 아무 말도 하지 않게 된다.
  {
    const dom = open({ used: true, unknown: null, counts: { approved: 0, stale: 60, unapproved: 5 }, total: 65, items: queueItems(50, 50) }, []);
    dom.window.document.querySelector('[data-review-filter="stale"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert(textOf(dom, 'review-inbox-summary').includes('60건 중 50건'), '거른 갈래의 잘림도 말해야 합니다');
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
}

console.log('review inbox tests passed');

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
// 검토 인박스는 목록일 뿐이었고 행 안에 단추가 0개였다. 여기서 못박는 것은 셋이다 —
// 행을 펼치면 화면을 갈아치우지 않고 그 자리에서 차분이 보일 것, 비교 기준이 없을 때
// 빈 차분을 지어내지 않을 것, 거절당하면 왜 거절당했는지가 그대로 보일 것.
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
      submission: { state: submissionState || 'none', revision: null, submittedBy: null, reason: null, submissions: 0 }
    };
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

  // 1) 행을 펼치면 그 자리에서 차분이 보인다. 화면을 갈아치우지 않는 것이 핵심이다 —
  //    인박스의 값은 줄을 훑으면서 처리하는 데 있고, 한 건마다 화면을 오가면 그 값이 사라진다.
  {
    const stale = { status: 'stale', diff: 'diff --git a/docs/ADR-001.md b/docs/ADR-001.md\n@@ -1,3 +1,4 @@\n 그대로인 줄\n+더한 줄\n-지운 줄\n' };
    const { dom, calls } = open((path) => (/\/diff\?/u.test(path) ? { body: Object.assign({ axis: 'since-approval' }, stale) } : null),
      [documentValue('ADR-001', trust('stale'))],
      { used: true, unknown: null, counts: { approved: 0, stale: 1, unapproved: 0 }, total: 1,
        items: [{ status: 'stale', id: 'ADR-001', kind: 'adr', title: '문서 ADR-001', file: 'docs/ADR-001.md', approvedBy: 'MEMBER-001', approvals: 2 }] },
      'review-inbox');
    dom.window.document.querySelector('[data-approve-open="ADR-001"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    assert.strictEqual(dom.window.document.getElementById('review-inbox-view').hidden, false, '펼쳐도 인박스 화면에 머물러야 합니다');
    assert(calls.some((call) => call.path.includes('/documents/ADR-001/diff')), `차분을 물어야 합니다: ${calls.map((call) => call.path).join(', ')}`);
    const panel = dom.window.document.querySelector('#review-inbox-list .approval-panel');
    assert(panel, '펼친 행 안에 승인 판이 서야 합니다');
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
    // 문서 화면으로 가는 길은 남는다 — 펼치기가 그 길을 대신하는 것이 아니라 더한 것이다.
    assert(panel.querySelector('[data-document="ADR-001"]'), '문서 화면으로 가는 길이 있어야 합니다');
    // 한 번 더 누르면 접힌다.
    dom.window.document.querySelector('[data-approve-open="ADR-001"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(dom.window.document.querySelector('#review-inbox-list .approval-panel'), null, '다시 누르면 접혀야 합니다');
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
    dom.window.document.querySelector('[data-approve-open="ADR-002"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    const panel = dom.window.document.querySelector('#review-inbox-list .approval-panel');
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
    click('[data-approve-open="ADR-003"]');
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
    const failed = dom.window.document.querySelector('#review-inbox-list .approval-failure');
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
    // 이미 여기가 그 문서의 화면이므로 "문서 화면에서 열기"는 자기 자신으로 가는 단추다.
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

  console.log('document approval tests passed');
})();
