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
assert(html.includes('id="task-documents"'), 'Task detail must expose linked documents');
assert(html.includes('id="theme-system"'), 'Settings must provide system theme mode');
assert(html.includes('id="theme-dark"'), 'Settings must provide dark theme mode');
assert(html.includes('id="theme-light"'), 'Settings must provide light theme mode');
assert(app.includes('id="contract-settings"'), 'Settings must expose the document contract editor');
assert(app.includes('data-contract-status'), 'Contract editor must expose document policy status');
assert(app.includes('data-contract-target'), 'Contract editor must expose omission absorption targets');
assert(app.includes('data-contract-components'), 'Contract editor must expose absorbed component requirements');
assert(!app.includes('data-contract-after'), 'Contract editor must not expose a hard prerequisite graph');
assert(app.includes('AI 추천 문맥'), 'Contract editor must present non-blocking AI context guidance');
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
assert(app.includes("document.body.classList.remove('context-collapsed')"), 'Opening mobile Context must recover from desktop collapse state');
assert(app.includes("document.body.classList.remove('context-open')"), 'Desktop Context must recover from mobile open state');
assert(app.includes("charter: '프로젝트 헌장'"), 'Document type vocabulary must include project charters');
assert(app.includes("prd: '제품 요구사항'"), 'Document type vocabulary must include PRDs');
assert(app.includes("draft: '초안'"), 'Document state vocabulary must map draft status');
assert(app.includes("active: '활성'"), 'Document state vocabulary must map active status');
assert(app.includes("state.snapshot.presentation[group]"), 'Document vocabulary must allow resolved Board presentation overrides');
assert(app.includes('Workspace board.json'), 'Settings must show Workspace presentation inheritance');
assert(app.includes('프로젝트 board.json'), 'Settings must show project presentation inheritance');
assert(app.includes('documentTypeLabel(documentValue)'), 'Document cards must use the shared type vocabulary');
assert(app.includes('documentStateLabel(documentValue.state)'), 'Document cards must use the shared state vocabulary');
assert(html.includes('data-view="operations">운영 상태'), 'Sidebar management labels must use consistent Korean terminology');
assert(html.includes('data-view="settings">설정'), 'Sidebar settings label must use consistent Korean terminology');
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
assert(/#board\s*\{[^}]*grid-auto-flow:\s*row/u.test(style), 'Task Board columns must wrap without an inner scrollbar');
assert(/#board\s*\{[^}]*overflow:\s*visible/u.test(style), 'Task Board must not add an inner scrollbar');
assert(style.includes('.markdown-body code'), 'Markdown code must use a theme-aware foreground token');
assert(style.includes('color: var(--code-TextColor)'), 'Markdown code colour must come from the theme');
assert(style.includes('color: var(--on-accent-TextColor)'), 'Primary buttons must use a theme-aware foreground token');
assert(/pre\.mermaid\s*\{[^}]*var\(--surface-01-BackgroundColor\)/u.test(style), 'Mermaid blocks must use the panel surface instead of the code background');
assert(/\.mermaid \.marker circle\s*\{[^}]*var\(--surface-01-BackgroundColor\)/u.test(style), 'Mermaid cardinality markers must not keep their hardcoded white fill');

// 목록 행은 겹침을 막는 두 속성이 항상 같이 있어야 한다.
assert(/\.task-row > \*[^{]*\{[^}]*min-width:\s*0/u.test(style), 'List cells must be allowed to shrink below their content');
assert(/\.task-row > \*[^{]*\{[^}]*text-overflow:\s*ellipsis/u.test(style), 'List cells must truncate instead of overflowing their track');
assert(style.includes('.theme-options button.active'), 'The theme picker must show which mode is selected');
assert(app.includes("theme: 'base', themeVariables: mermaidThemeVariables()"), 'Mermaid must render with the Board palette instead of its built-in themes');
assert(app.includes("lineColor: themeToken('--muted')"), 'Mermaid relationship lines must follow the Board palette');
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
assert(app.includes('queueTaskUpdate(task, task.blocker ? { status, blocker: null } : { status })'), 'Leaving waiting must clear the blocker in the same change');
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

// Client 등록·삭제는 CLI가 소유하고 Board는 활성 상태만 바꾼다.
assert(app.includes('data-client-toggle'), 'Client는 Board에서 활성 상태를 바꿀 수 있어야 합니다');
assert(app.includes("'/enable' : '/disable'") || app.includes("? 'enable' : 'disable'"), 'Client 상태 변경은 전용 API를 씁니다');
assert(app.includes('rdl client register'), '등록 방법은 CLI 명령으로 안내해야 합니다');

// 문서 표시 규칙은 설정 파일이라 Board에서 편집하지 않는다. 어느 파일을 열지 알려주는 게 이 화면의 일이다.
assert(app.includes('presentation-source'), '문서 표시 규칙은 board.json 경로를 본문에 보여야 합니다');
assert(!app.includes('data-presentation-edit'), '문서 표시 규칙은 Board에서 편집하지 않습니다');

// 막힘은 목록에서 바로 읽혀야 한다. blocker뿐 아니라 끝나지 않은 선행 태스크도 막힘이다.
assert(app.includes('function taskBlockage'), '막힘 판정은 한 곳에서 계산해야 합니다');
assert(app.includes("task.status !== 'done'"), '선행 태스크가 끝나지 않으면 막힘입니다');
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

// AI 추천 문맥은 편집 가능하되 생성 게이트가 아니다.
assert(app.includes('data-context-toggle'), 'AI 추천 문맥은 프로젝트마다 바꿀 수 있어야 합니다');
assert(app.includes('생성을 막지 않습니다'), 'AI 추천 문맥이 게이트가 아님을 화면에서 밝혀야 합니다');
assert(app.includes('[data-context-toggle][aria-pressed="true"]'), '추천 문맥은 저장 payload에 실려야 합니다');
assert(style.includes(".guidance-chip[aria-pressed='true']"), '켜진 추천 문맥은 구별되어야 합니다');

console.log('board UI tests passed');
