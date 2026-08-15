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

console.log('board UI tests passed');
