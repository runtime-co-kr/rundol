'use strict';

const token = document.querySelector('meta[name="rdl-token"]').content;
const state = { project: null, snapshot: null, view: 'home', selected: null, taskScope: 'all', currentMember: '', taskMode: 'list', documentFilter: '', query: '', polling: null, lastVisit: null, pendingTasks: new Map(), blockerResolve: null, cancellationResolve: null, clientIntent: null, commentComposer: null, newTaskBlocker: null, rejectedDraft: null, attentionFilter: 'all', reviewFilter: 'all', documentSearchScope: 'name', documentSort: 'id', documentApproval: 'all', presentationScope: 'project', presentationSettling: false, runs: null, runsError: '', approvingRun: null, review: null, docApproval: null };
const statusLabels = { todo: '할 일', doing: '진행 중', waiting: '대기', review: '검토', done: '완료', cancelled: '반려' };
// 완료와 반려는 게이트가 다르지만 둘 다 더 진행되지 않는다. 숨기기·접기·선행 판정은 같이 다룬다.
// 워크플로는 서버가 스냅숏에 실어 준다. 화면은 브라우저에서 그대로 돌아 require를
// 쓸 수 없고, 그래서 예전에는 종료 상태 사본을 여기 적어 두었다 — 정본과 같은지를
// 시험이 값으로 확인해야 했던 이유가 그것이다. 실어 주면 확인할 사본이 없다.
//
// 상태 이름을 비교하지 않는다. 이름은 프로젝트가 정의하는 값이고, 화면이 그 값을
// 알면 남의 이름이 화면에 박힌다. 화면이 묻는 것은 스텝과 노드의 요구 필드다.
const EMPTY_WORKFLOW = { nodes: {}, steps: [], terminalSteps: [], openSteps: [], activeSteps: [] };
function workflowView() { return (state.snapshot && state.snapshot.workflow) || EMPTY_WORKFLOW; }
function workflowNode(status) { return workflowView().nodes[status] || null; }
function stepOf(status) { const node = workflowNode(status); return node ? node.step : null; }
function inStep(status, step) { return stepOf(status) === step; }
function isTerminalStatus(status) { const step = stepOf(status); return step !== null && workflowView().terminalSteps.indexOf(step) >= 0; }
// 그 노드에서만 채워야 하는 필드를 요구하는가. 대기와 반려가 저마다 다이얼로그를
// 여는 자리가 이것을 묻는다.
function nodeRequires(status, field) { const node = workflowNode(status); return Boolean(node) && (node.requires || []).indexOf(field) >= 0; }
// 상태 목록은 서버가 준 것이 정본이다. 화면이 자기 목록을 따로 적으면 저장값이
// 늘어도 화면은 그것을 모른 채 돈다. 라벨은 표시의 몫이라 statusLabels에 남는다.
function statusKeys() { const keys = Object.keys(workflowView().nodes); return keys.length ? keys : Object.keys(statusLabels); }
function statusesInStep(step) { return statusKeys().filter((key) => inStep(key, step)); }
function defaultStatus() { return statusesInStep('unclaimed')[0] || statusKeys()[0] || 'todo'; }
const typeLabels = {
  project: '프로젝트', charter: '프로젝트 헌장', prd: '제품 요구사항', requirement: '요구사항',
  architecture: '아키텍처', screen: '화면 설계', model: '데이터 모델', interface: '인터페이스',
  standard: '표준',
  adr: '의사결정 기록', decision: '의사결정 기록', test: '검증', runbook: '운영 가이드',
  glossary: '용어집', clipping: '수집 노트'
};
const documentStateLabels = {
  draft: '초안', proposed: '제안', active: '활성', review: '검토 중', approved: '승인됨',
  deprecated: '폐기 예정', archived: '보관됨', unread: '미확인',
  // accepted는 vocabulary.js의 여덟 값에 없는데 정본 15건이 쓰고 있다. 라벨이 없으면 칩에
  // 영문이 그대로 뜨고, 사람은 그것을 "아직 번역 안 된 값"이 아니라 다른 종류의 상태로 읽는다.
  // 어휘를 고치는 것은 이 화면의 일이 아니므로 저장값은 그대로 두고 보이는 말만 준다.
  //
  // '승인됨'으로 적지 않는다. 그것은 승인 원장이 쓰는 말이고 frontmatter의 accepted는
  // 작성자의 주장이다. 두 축이 화면에서 같은 말을 쓰면, 이 화면이 갈라 놓은 것이 도로 붙는다.
  accepted: '채택'
};

function el(id) { return document.getElementById(id); }
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function message(value, error) { el('message').textContent = value || ''; el('message').style.color = error ? 'var(--red)' : ''; if (value) setTimeout(() => { if (el('message').textContent === value) el('message').textContent = ''; }, 5000); }
// 거절은 문장만이 아니라 종류도 들고 온다. 문장으로 종류를 되짚으면 말을 다듬는
// 순간 판정이 깨지므로, 서버가 붙인 code를 그대로 옮긴다 — 미등록 기기를 화면의
// 등록으로 데려가는 판단이 이 값에 걸려 있다.
async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (response.ok) return value;
  const error = new Error(value.error || `HTTP ${response.status}`);
  error.code = value.code || null;
  error.status = response.status;
  error.payload = value;
  throw error;
}
// 목록에서 훑을 때 쓰는 짧은 날짜. 값이 없으면 자리만 비운다.
function shortDate(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function projectPath(path) { return `/api/projects/${encodeURIComponent(state.project)}${path}`; }
function presentationLabel(group, value, fallback) { const configured = state.snapshot && state.snapshot.presentation && state.snapshot.presentation[group] && state.snapshot.presentation[group][value]; return configured && (configured.label || configured) || fallback; }
function documentTypeLabel(item) { const value = item && (item.kind || item.type); return presentationLabel('documentTypes', value, typeLabels[value] || value || '문서'); }
function documentStateLabel(value) { return presentationLabel('documentStates', value, documentStateLabels[value] || value || '상태 없음'); }
// 계약과 태스크가 저장하는 값은 required, checkpoint, todo 같은 ASCII 식별자다. 그 값을
// 화면에 그대로 내보내면 읽는 사람이 뜻을 유추해야 한다. 저장값은 그대로 두고 보이는
// 말만 표시 규칙에서 가져온다. 표기를 바꿔도 저장된 계약은 한 글자도 달라지지 않는다.
function policyStateLabel(value) { return presentationLabel('policyStates', value, value); }
function enforcementLabel(value) { return presentationLabel('enforcementLevels', value, value); }
function taskStatusLabel(value) { return presentationLabel('taskStatuses', value, statusLabels[value] || value); }
function priorityLabel(value) { return presentationLabel('priorities', value, value); }
function presentationHint(group, value) { const configured = state.snapshot && state.snapshot.presentation && state.snapshot.presentation[group] && state.snapshot.presentation[group][value]; return (configured && configured.description) || ''; }
function labelledEntries(group, keys) { return keys.map((key) => [key, presentationLabel(group, key, key)]); }

// 문서 안의 상대 경로 그림을 보드가 서빙하는 주소로 옮긴다. 문서마다 자기 파일
// 위치가 다르므로 기준은 그 문서가 놓인 폴더다 — 프로젝트 루트를 기준으로 삼으면
// docs/ 아래의 문서가 쓴 ./images/a.png가 엉뚱한 곳을 가리킨다.
//
// 절대 URL(http, data 등)은 그대로 둔다. 문서가 바깥 그림을 가리키는 것은 그 문서의
// 선택이고, 여기서 조용히 바꾸면 무엇을 보고 있는지가 달라진다.
function resolveDocumentImages(container, documentFile, projectKey) {
  const base = String(documentFile || '').replace(/\\/gu, '/').split('/').slice(0, -1);
  for (const image of container.querySelectorAll('img')) {
    const source = image.getAttribute('src') || '';
    if (!source || /^[a-z][a-z0-9+.-]*:/iu.test(source) || source.startsWith('//') || source.startsWith('/')) continue;
    const segments = base.slice();
    for (const part of source.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') segments.pop();
      else segments.push(part);
    }
    image.setAttribute('src', `/api/projects/${encodeURIComponent(projectKey)}/assets/${segments.map(encodeURIComponent).join('/')}`);
    image.setAttribute('loading', 'lazy');
  }
}

function markdown(source) {
  if (!window.marked || !window.DOMPurify) return `<pre>${escapeHtml(source || '')}</pre>`;
  const renderer = new window.marked.Renderer();
  renderer.code = ({ text, lang }) => String(lang || '').toLowerCase() === 'mermaid' ? `<pre class="mermaid">${escapeHtml(text)}</pre>` : `<pre><code class="language-${escapeHtml(lang || '')}">${escapeHtml(text)}</code></pre>`;
  const prepared = String(source || '').replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target, label) => `[${label || target}](#document=${encodeURIComponent(target)})`);
  const html = window.marked.parse(prepared, { gfm: true, breaks: false, renderer });
  return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

function lightTheme() { return document.body.classList.contains('theme-light') || (document.body.classList.contains('theme-system') && matchMedia('(prefers-color-scheme: light)').matches); }
// 토큰 이름이 바뀌면 빈 문자열이 돌아오고, mermaid는 그걸 색으로 받아 통째로 렌더링에
// 실패한다. 실제로 theme.css를 다시 쓰면서 --panel·--text 같은 옛 이름이 사라져
// 본문 다이어그램이 전부 그려지지 않고 있었다. 빈 값이면 그 항목을 넘긴다.
function themeToken(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback || '';
}
// mermaid가 svg 안에 심는 스타일이 적용되지 않아 글자가 브라우저 기본 monospace 16px로
// 그려진다. mermaid는 자기 기본 글꼴로 상자 크기를 재므로 잰 폭과 그린 폭이 어긋나
// 액터 이름이 상자 밖으로 삐져나왔다. 재는 글꼴과 그리는 글꼴을 같은 값으로 못박는다.
const DIAGRAM_FONT = 'Inter, Pretendard, "Noto Sans KR", system-ui, sans-serif';

function mermaidThemeVariables() {
  const surface = themeToken('--surface-01-BackgroundColor');
  const raised = themeToken('--surface-02-BackgroundColor');
  const text = themeToken('--primary-TextColor');
  const line = themeToken('--divider-BorderColor');
  const variables = {
    fontFamily: DIAGRAM_FONT,
    darkMode: !lightTheme(),
    background: surface, mainBkg: raised, tertiaryColor: surface,
    primaryColor: raised, primaryTextColor: text, primaryBorderColor: line,
    nodeBorder: line, lineColor: line, textColor: text,
    edgeLabelBackground: surface,
    attributeBackgroundColorOdd: surface, attributeBackgroundColorEven: raised
  };
  // 값이 하나라도 비면 mermaid가 "Unsupported color format"으로 전체를 포기한다.
  // 못 채운 항목은 넘기고 mermaid의 기본값을 쓰게 둔다. 색이 조금 어긋나도 그림은 나온다.
  return Object.fromEntries(Object.entries(variables).filter(([, value]) => value !== ''));
}
async function renderMermaid() {
  if (!window.mermaid) return;
  const nodes = Array.from(document.querySelectorAll('.mermaid'));
  if (!nodes.length) return;
  try {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: DIAGRAM_FONT, themeVariables: mermaidThemeVariables() });
    await window.mermaid.run({ nodes });
    for (const node of nodes) fitDiagram(node.querySelector('svg'));
  } catch (error) {
    message(`Mermaid 렌더링 실패: ${error.message}`, true);
  }
}
// mermaid는 svg에 width="100%"를 붙여 본문 폭까지 늘린다. 356px짜리 그림이 909px로
// 펴지면 글자와 선이 2.5배로 커져 읽기 나쁘다. viewBox가 고유 크기를 알려주므로
// 그보다 크게 늘리지 않고, 좁은 화면에서만 줄어들게 한다.
// mermaid의 기본 글꼴은 16px이다. 폭에 맞춰 무한정 줄이면 넓은 흐름도는 실효 7px까지
// 내려가 글자가 사라진다. 아래로는 줄이지 않고 가로 스크롤로 넘긴다. 읽을 수 없는 그림을
// 다 보여주는 것보다 읽을 수 있는 그림을 밀어 보는 편이 낫다.
const DIAGRAM_BASE_FONT = 16;
const DIAGRAM_MIN_FONT = 11;

function fitDiagram(svg) {
  if (!svg) return;
  const intrinsic = Number((svg.getAttribute('viewBox') || '').split(/\s+/u)[2]);
  if (!Number.isFinite(intrinsic) || intrinsic <= 0) return;
  const floor = Math.ceil(intrinsic * (DIAGRAM_MIN_FONT / DIAGRAM_BASE_FONT));
  svg.style.width = 'auto';
  svg.style.minWidth = `min(${floor}px, ${Math.ceil(intrinsic)}px)`;
  svg.style.maxWidth = `min(100%, ${Math.ceil(intrinsic)}px)`;
  svg.removeAttribute('height');
}
function applyTheme(theme) { const selected = ['system', 'dark', 'light'].includes(theme) ? theme : 'system'; document.body.classList.remove('theme-system', 'theme-dark', 'theme-light'); document.body.classList.add(`theme-${selected}`); localStorage.setItem('rundol.theme', selected); for (const value of ['system', 'dark', 'light']) if (el(`theme-${value}`)) el(`theme-${value}`).classList.toggle('active', value === selected); if (state.snapshot && state.view === 'document' && state.selected) renderDocument(state.selected); }

function blockerCandidates() { return state.snapshot.people.members.concat(state.snapshot.people.stakeholders).map((item) => [item.id, item.name]); }
function blockerSinceValue(value) { const parsed = value ? new Date(value) : new Date(); const stamp = Number.isNaN(parsed.getTime()) ? new Date() : parsed; return new Date(stamp.getTime() - stamp.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function blockerText(blocker) { return blocker ? `${personName(blocker.waitingFor)} 대기 · ${blocker.condition} · ${blocker.since}` : '없음'; }
function requestBlocker(current) {
  const candidates = blockerCandidates();
  el('blocker-waiting-for').replaceChildren(...candidates.map(([id, name]) => new Option(`${name} · ${id}`, id)));
  el('blocker-waiting-for').value = (current && current.waitingFor) || (candidates[0] ? candidates[0][0] : '');
  el('blocker-condition').value = (current && current.condition) || '';
  el('blocker-since').value = blockerSinceValue(current && current.since);
  el('blocker-dialog').showModal();
  return new Promise((resolve) => { state.blockerResolve = resolve; });
}
function resolveBlocker(value) { const resolve = state.blockerResolve; state.blockerResolve = null; if (resolve) resolve(value); }

// 반려는 완료와 반대 방향의 게이트다. 완료조건이 남아 있어도 닫히지만 사유가 없으면 닫히지 않는다.
function cancellationText(cancellation) { return cancellation ? `${personName(cancellation.decidedBy)} 반려 · ${cancellation.reason}` : '없음'; }
function requestCancellation(current) {
  const members = state.snapshot.people.members;
  el('cancellation-decided-by').replaceChildren(...members.map((item) => new Option(`${item.name} · ${item.id}`, item.id)));
  el('cancellation-decided-by').value = (current && current.decidedBy) || state.currentMember || (members[0] ? members[0].id : '');
  el('cancellation-reason').value = (current && current.reason) || '';
  el('cancellation-dialog').showModal();
  return new Promise((resolve) => { state.cancellationResolve = resolve; });
}
function resolveCancellation(value) { const resolve = state.cancellationResolve; state.cancellationResolve = null; if (resolve) resolve(value); }

// 낙관적 변경은 보고 있는 곳에 바로 비쳐야 한다. peek에서 완료조건을 눌렀는데 전체화면만
// 다시 그리면 체크가 다음 polling까지 반영되지 않아 눌리지 않은 것처럼 보인다.
function redrawTask(taskId) {
  if (state.selected !== taskId) return;
  if (state.view === 'task') return renderTask(taskId);
  const task = state.snapshot.tasks.tasks.find((item) => item.id === taskId);
  if (task && state.view === 'tasks') renderContext(task, 'task');
}
function queueTaskUpdate(task, changes) { let pending = state.pendingTasks.get(task.id); if (!pending) pending = { baseRevision: task.revision, changes: {}, timer: null }; Object.assign(pending.changes, changes); Object.assign(task, changes); clearTimeout(pending.timer); pending.timer = setTimeout(() => flushTaskUpdate(task.id), 500); state.pendingTasks.set(task.id, pending); redrawTask(task.id); }
// 보내는 동안 사용자가 또 누르면 그 변경은 같은 pending에 쌓인다. 응답이 온 뒤 taskId로
// 지우면 그 사이 쌓인 것까지 사라지고, 반대로 남겨두면 이미 낡은 revision을 달고 나간다.
// 보낸 것만 확정하고, 남은 것은 새 revision을 받은 뒤에 다시 큐에 넣는다.
async function flushTaskUpdate(taskId) {
  const pending = state.pendingTasks.get(taskId);
  if (!pending || pending.sending) return;
  pending.timer = null;
  pending.sending = true;
  const sent = Object.assign({}, pending.changes);
  try {
    await api(projectPath(`/tasks/${encodeURIComponent(taskId)}`), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify(Object.assign({ baseRevision: pending.baseRevision }, sent)) });
    // 최신 revision을 받을 때까지 이 pending을 살려 둔다. 여기서 먼저 지우면 스냅샷을
    // 받는 사이의 클릭이 갱신 전 revision으로 새 pending을 만들어, 그 다음 요청이
    // 낡은 revision을 달고 나가 409로 거절된다.
    await loadSnapshot(true, { settlingTask: true });
    const later = takePendingTask(taskId, sent);
    if (later) {
      const task = state.snapshot.tasks.tasks.find((item) => item.id === taskId);
      if (task) queueTaskUpdate(task, later);
    }
    redrawTask(taskId);
    if (!state.pendingTasks.has(taskId)) message('태스크 변경을 파일에 저장했습니다.');
  } catch (error) {
    await loadSnapshot(true, { settlingTask: true });
    takePendingTask(taskId, null);
    redrawTask(taskId);
    message(`변경을 되돌렸습니다: ${error.message}`, true);
  }
}
// 스냅샷을 받은 뒤에 부른다. 보낸 것과 다른 필드만 남겨 돌려주고 대기열을 정리한다.
// 살아 있는 동안 쌓인 타이머도 함께 끈다. 두면 지워진 항목을 향해 한 번 더 발화한다.
function takePendingTask(taskId, sent) {
  const pending = state.pendingTasks.get(taskId);
  if (!pending) return null;
  clearTimeout(pending.timer);
  state.pendingTasks.delete(taskId);
  return sent ? remainingChanges(pending, sent) : null;
}
// 보내는 사이 값이 또 바뀐 필드만 골라낸다. 없으면 null.
function remainingChanges(pending, sent) {
  const fields = Object.keys(pending.changes).filter((field) => JSON.stringify(pending.changes[field]) !== JSON.stringify(sent[field]));
  return fields.length ? Object.fromEntries(fields.map((field) => [field, pending.changes[field]])) : null;
}

// 화면 이름을 body에 남겨 선택 대상이 없는 화면에서 Context 패널을 접는다.
// 표시 옵션은 지금까지 아무데도 남지 않아 새로고침마다 초기화됐다.
// 프로젝트마다 일하는 방식이 다르므로 프로젝트별로 기억한다.
// 읽는 순서는 URL 해시 > 내 저장값 > 기본값이다. URL로 들어온 값은 저장하지 않는다 —
// 남의 링크를 한 번 열었다고 내 기본이 바뀌면 안 된다.
function viewOptionKey(name) { return `rundol.view.${state.project}.${name}`; }
function viewOption(name, fallback) {
  const hash = new URLSearchParams(location.hash.slice(1)).get(name);
  if (hash !== null) return hash;
  const saved = localStorage.getItem(viewOptionKey(name));
  return saved === null ? fallback : saved;
}
function setViewOption(name, value) {
  if (value === null || value === undefined || value === '') localStorage.removeItem(viewOptionKey(name));
  else localStorage.setItem(viewOptionKey(name), String(value));
}
function resetViewOptions() {
  const prefix = `rundol.view.${state.project}.`;
  for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
}

// 화면 아이콘은 글자가 아니라 그림이다. ›·▸·×는 본문 글꼴을 따라가므로 크기도 굵기도
// 제 뜻대로 정할 수 없고, 14px 글리프 하나는 누를 수 있는 곳으로 읽히지 않는다.
// 헤더·탐색과 같은 24 격자·2px 선을 쓰고, 크기와 방향은 CSS가 정한다.
// 화살표는 오른쪽 하나만 두고 펼친 상태는 돌려서 만든다. 두 벌을 두면 둘이 어긋난다.
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.75 6.75 17.25 17.25M17.25 6.75 6.75 17.25"/></svg>';

// breadcrumb은 지금까지 textContent라 눌러도 아무 일이 없었다.
// 마디마다 돌아갈 곳이 있어야 들어갔다 나오는 길이 생긴다.
function breadcrumb(parts) {
  return parts.map((part, index) => {
    const last = index === parts.length - 1;
    const node = last || !part.view
      ? `<span>${escapeHtml(part.label)}</span>`
      : `<button data-view="${escapeHtml(part.view)}"${part.entity ? ` data-breadcrumb-entity="${escapeHtml(part.entity)}"` : ''}>${escapeHtml(part.label)}</button>`;
    return index ? `<span class="breadcrumb-sep">›</span>${node}` : node;
  }).join('');
}
// 어떤 화면이 어떤 종류의 peek을 열 수 있는지. 여기 없는 화면은 peek을 갖지 않는다.
const PEEK_VIEWS = { tasks: 'task', people: 'person' };
function markViewOnBody(view) {
  for (const name of Array.from(document.body.classList)) if (name.startsWith('view-')) document.body.classList.remove(name);
  document.body.classList.add(`view-${view}`);
  // peek은 그 화면의 목록에서 고른 항목을 여는 자리다. 화면을 옮기면 그 항목은 지금
  // 목록에 없다. tasks와 people을 한꺼번에 허용했더니 태스크 peek을 연 채 People로
  // 가면 선택은 풀렸는데 패널은 남아, 없는 선택의 내용을 계속 보여주고 본문 폭까지
  // 좁힌 채였다. 화면과 종류가 맞고 고른 항목이 있을 때만 남긴다.
  if (state.selected && PEEK_VIEWS[view] === document.body.dataset.peekKind) return;
  dismissPeek();
}
function setView(view, selected) {
  if (!state.snapshot) return;
  if (view === 'my-work') { state.view = 'tasks'; state.taskScope = 'mine'; }
  else if (view === 'review') { state.view = 'tasks'; state.taskScope = 'review'; }
  else state.view = view;
  state.selected = selected || null;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `${state.view}-view`;
  markViewOnBody(state.view);
  for (const button of document.querySelectorAll('[data-view]')) { const activeTaskView = state.view === 'tasks' && ((state.taskScope === 'mine' && button.dataset.view === 'my-work') || (state.taskScope === 'review' && button.dataset.view === 'review') || (state.taskScope === 'all' && button.dataset.view === 'tasks')); button.classList.toggle('active', activeTaskView || (state.view !== 'tasks' && button.dataset.view === state.view)); }
  const params = new URLSearchParams({ project: state.project || '', view: state.view });
  if (state.view === 'tasks' && state.taskScope !== 'all') params.set('scope', state.taskScope);
  if (selected) params.set('entity', selected);
  history.replaceState(null, '', `#${params}`);
  if (state.view === 'document' && selected) renderDocument(selected);
  else if (state.view === 'documents') renderDocuments();
  else if (state.view === 'task' && selected) renderTask(selected);
  else if (state.view === 'tasks') { for (const button of document.querySelectorAll('[data-task-scope]')) button.classList.toggle('active', button.dataset.taskScope === state.taskScope); renderTasks(); }
  else if (state.view === 'runs') { renderRuns(); loadRuns(true); }
  else if (state.view === 'home') renderHome();
  else if (state.view === 'review-inbox') renderReviewInbox();
  else if (state.view === 'people') renderPeople();
  else if (state.view === 'settings') renderSettings();
}

function documentCard(documentValue) {
  return `<button class="document-card" data-document="${escapeHtml(documentValue.id)}"><span class="eyebrow">${escapeHtml(documentValue.id)}</span><strong>${escapeHtml(documentValue.title)}</strong><small>${escapeHtml(documentValue.description || documentValue.file)}</small><span class="chip-row"><span class="chip">${escapeHtml(documentTypeLabel(documentValue))}</span><span class="chip">${escapeHtml(documentStateLabel(documentValue.state))}</span></span></button>`;
}
// 문제 하나가 한 줄이면 같은 태스크가 세 번 네 번 반복된다. 사람은 문제가 아니라
// 태스크 단위로 일하므로 태스크로 묶고, 무엇이 걸렸는지는 태그로 늘어놓는다.
// 등급은 서버가 이미 붙여 보내므로(error·warning·info) 여기서 다시 판단하지 않는다.
const ATTENTION_LABELS = { '깨진 문서 연결': '깨진 연결', '선행 태스크 미완료': '선행 대기' };
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
function attentionGroups(attention) {
  const groups = new Map();
  for (const item of attention) {
    // kind를 들고 간다. 조치 필요는 태스크와 문서 둘을 함께 담는데(board.js의 attentionItems),
    // 여기서 버리면 목록이 전부 태스크로 그려지고 문서 항목을 누른 사람은 아무 안내도 없이
    // 태스크 화면으로 떨어진다 — 지금 낡음 문서 2건이 그 자리에 서 있다.
    const group = groups.get(item.id) || { id: item.id, kind: item.kind, title: item.title, tags: new Map(), severity: 'info' };
    const head = String(item.reason || '').split(':')[0].trim();
    const label = ATTENTION_LABELS[head] || head;
    const tag = group.tags.get(label) || { label, severity: item.severity, count: 0 };
    tag.count += 1;
    group.tags.set(label, tag);
    if (SEVERITY_RANK[item.severity] < SEVERITY_RANK[group.severity]) group.severity = item.severity;
    groups.set(item.id, group);
  }
  // 급한 것이 위로 온다. 지금까지는 태스크 순서 그대로라 깨진 연결이 아래에 묻혔다.
  return [...groups.values()]
    .map((group) => ({ ...group, tags: [...group.tags.values()].sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]) }))
    .sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || right.tags.length - left.tags.length || left.title.localeCompare(right.title));
}

function renderAttention(attention) {
  const groups = attentionGroups(attention);
  const counts = { all: groups.length, error: 0, warning: 0, info: 0 };
  for (const group of groups) for (const severity of new Set(group.tags.map((tag) => tag.severity))) counts[severity] += 1;
  const filter = counts[state.attentionFilter] ? state.attentionFilter : 'all';
  state.attentionFilter = filter;
  const labels = [['all', '전체'], ['error', '오류'], ['warning', '경고'], ['info', '정보']];
  // 개수를 달아 두면 누르기 전에 규모를 안다. 0건인 등급은 고를 이유가 없으므로 숨긴다.
  // 등급 단추는 목록의 태그와 같은 색 점을 앞에 달아 무슨 색이 무슨 등급인지 알린다.
  el('attention-filter').innerHTML = labels.filter(([key]) => counts[key]).map(([key, label]) =>
    `<button type="button" data-attention-severity="${key}"${key === filter ? ' class="active"' : ''}>${key === 'all' ? '' : '<span class="severity-dot" aria-hidden="true"></span>'}${label} ${counts[key]}</button>`).join('');
  const visible = filter === 'all' ? groups : groups.filter((group) => group.tags.some((tag) => tag.severity === filter));
  el('attention-list').innerHTML = visible.length ? visible.map((group) =>
    `<button class="attention-item" data-${group.kind === 'document' ? 'document' : 'task'}="${escapeHtml(group.id)}"><span><strong>${escapeHtml(group.title)}</strong>    <span class="tagline">${group.tags.map((tag) => `<span class="tag ${tag.severity}">${escapeHtml(tag.label)}${tag.count > 1 ? ` ${tag.count}` : ''}</span>`).join('')}</span>    </span><span class="row-chevron" aria-hidden="true">${CHEVRON_ICON}</span></button>`).join('') : '<p class="empty-state">이 등급에는 조치할 항목이 없습니다.</p>';
}

// ── 검토 인박스 ─────────────────────────────────────────────────────────────
//
// 스냅숏의 reviewQueue를 옮겨 그린다. 판정도 정렬도 서버가 이미 했다 — 화면이 자기
// 판정을 지으면 rdl doc status와 보드가 같은 문서에 다른 답을 내고, 그때 사람이 믿는
// 쪽은 화면이다. 여기서 새로 하는 일은 갈래를 가르고 줄의 길이를 말하는 것뿐이다.
//
// 홈의 "검토 요청 태스크"와 같은 수가 아니다. 저것은 태스크가 승인 스텝에 선 것이고
// 이것은 문서가 승인 원장과 어긋난 것이다. 한 수로 합치면 어느 쪽을 처리해야 줄이
// 줄어드는지가 화면에서 사라진다.
const REVIEW_STATUS_LABELS = { approved: '승인됨', stale: '낡음', unapproved: '미승인' };
// 낡음이 경고색인 이유는 승인된 것이 흔들렸다는 뜻이라서다 — 이미 그 문서를 근거로 삼은
// 하류가 있다. 미승인은 아직 아무도 근거로 삼지 않았으므로 문제가 아니라 줄이다. 색은
// 조치 필요 목록의 등급과 같은 토큰을 쓴다. 같은 뜻에 다른 색을 주면 화면을 오갈 때마다
// 색의 뜻을 다시 배워야 한다.
//
// 승인된 것은 줄에 서지 않으므로 이 표에 없다. 거를 수 있는 것도 이 둘이고 서버가 보내는
// 순서도 이 순서라, 이 표가 곧 거르개의 목록이다 — 따로 적으면 상태가 늘 때 한쪽만 는다.
const REVIEW_STATUS_TONES = { stale: 'warning', unapproved: 'info' };

// 문서 화면(목록·상세·컨텍스트)이 쓰는 원장 색. 인박스의 표를 그대로 물려받고 승인됨만
// 얹는다 — 인박스는 승인된 문서를 줄에 세우지 않아 그 색을 가질 일이 없었고, 저 표는 곧
// 인박스 거르개의 목록이라 거기에 승인됨을 더하면 누를 것 없는 단추가 하나 생긴다.
// 물려받는 쪽으로 적어야 상태가 늘 때 두 화면이 한 번에 는다.
//
// 거르개의 목록도 이 표의 키다. 목록을 따로 적으면 그것은 vocabulary.js의
// DOCUMENT_TRUST_STATES 사본이 되는데, 화면은 브라우저에서 돌아 require로 정본을 가져올 수
// 없다. 가져올 수 없는 목록은 적지 않는 것이 낫다 — 적어 두면 상태가 느는 날 정본과 갈리고,
// 그때 화면은 없는 상태를 모르는 채로 돈다. 표는 어차피 하나 있어야 하므로 그 키를 쓴다.
//
// 키 순서가 곧 거르개 순서다. 승인됨 → 낡음 → 미승인은 "믿을 수 있는 것 → 흔들린 것 →
// 아직 아닌 것"이라 신뢰도 순이고, 승인됨을 앞에 얹는 Object.assign이 그 순서를 만든다.
const DOCUMENT_APPROVAL_TONES = Object.assign({ approved: 'pass' }, REVIEW_STATUS_TONES);
// 승인 상태는 문서마다의 값이지만, 읽었는가는 스냅숏 전체의 성질이다 — board.js의
// documentApprovals가 상태 표를 통째로 읽거나 통째로 못 읽거나 둘 중 하나이기 때문이다.
// null은 미승인이 아니라 "모른다"이므로, 그때는 축 자체를 그리지 않는다.
function approvalStatusOf(item) { return item && item.approval ? item.approval.status : null; }
function approvalTagHtml(status) { return `<span class="tag ${DOCUMENT_APPROVAL_TONES[status] || 'info'}">${escapeHtml(REVIEW_STATUS_LABELS[status] || status)}</span>`; }
// frontmatter의 어떤 값이 어떤 원장 상태를 주장하는가. 값 어휘가 아니라 두 축을 잇는 읽기
// 규칙이라 vocabulary.js가 가질 수 없다 — 오른쪽은 승인 원장의 상태이고 왼쪽은 문서 상태라,
// 어느 한쪽 어휘에도 속하지 않는다. accepted가 왼쪽에 있는 것이 그 증거다: 어휘의 여덟 값에
// 없는데도 정본 15건이 쓰고 있고, 어휘에 있는 값만 보면 지금 어긋난 15건이 통째로 안 세어진다.
//
// 어긋남 자체가 봐야 할 신호다. 주장과 사실이 갈렸다는 뜻이고, 화면이 그것을 말하지 않으면
// 칩만 보고 승인된 문서로 알고 그 위에 작업을 쌓게 된다.
const STATE_APPROVAL_CLAIM = { approved: 'approved', accepted: 'approved' };
function claimsUnbacked(item) { const status = approvalStatusOf(item); const claim = STATE_APPROVAL_CLAIM[item.state]; return Boolean(status && claim) && status !== claim; }

// 이 화면이 갈라야 하는 갈래 넷. 서로 다른 사실이라 뭉갤 수 없다 — 특히 unknown과
// unused를 같이 그리면 원장이 깨진 저장소와 원장을 안 쓰는 저장소가 화면에서 같아
// 보이고, 앞엣것은 고쳐야 할 사고인데 아무도 그것을 모르게 된다.
function reviewMode(queue) {
  if (!queue) return 'absent';
  if (queue.unknown) return 'unknown';
  if (!queue.used) return 'unused';
  return 'ready';
}
// 헤더 요약이 낼 수. 모르는 상태와 승인 축을 안 쓰는 상태에서는 수를 내지 않는다 —
// 0은 "볼 것이 없다"는 거짓이고, 그때의 문서 전건은 "전부 내 검토를 기다린다"는 거짓이다.
function reviewWaiting(queue) { return reviewMode(queue) === 'ready' ? queue.total : null; }

function reviewRowHtml(item) {
  // 승인자와 승인 횟수는 낡음에만 값이 있다. 미승인은 승인 이력 자체가 없으므로 빈
  // 자리를 남기지 않고 없다고 적는다 — 빈 칸은 "못 읽었다"로도 읽힌다.
  const trail = item.approvals
    ? `${escapeHtml(personName(item.approvedBy))} · 승인 ${escapeHtml(item.approvals)}회`
    : '승인 이력 없음';
  // 행을 누르면 화면을 갈아치우지 않고 그 자리에서 펼친다. 인박스의 값은 줄을 훑으면서
  // 처리하는 데 있고, 한 건마다 문서 화면을 오가면 훑던 자리를 매번 잃는다 — 그러면
  // 목록은 있으나 인박스가 아니다. 문서 화면으로 가는 길은 펼친 안에 그대로 둔다.
  const open = Boolean(approvalPanel(item.id));
  return `<div class="review-inbox-item${open ? ' open' : ''}">`
    + `<button class="document-row review-inbox-row" data-approve-open="${escapeHtml(item.id)}" aria-expanded="${open}">`
    + `<span class="tag ${REVIEW_STATUS_TONES[item.status] || 'info'}">${escapeHtml(REVIEW_STATUS_LABELS[item.status] || item.status)}</span>`
    + `<span class="eyebrow">${escapeHtml(item.id)}</span>`
    + `<strong>${escapeHtml(item.title)}</strong>`
    + `<span class="chip">${escapeHtml(documentTypeLabel(item))}</span>`
    + `<small>${trail}</small>`
    + `<span class="row-chevron" aria-hidden="true">${CHEVRON_ICON}</span></button>`
    + approvalPanelHtml(item.id, 'inbox')
    + '</div>';
}

// ── 문서 승인 ───────────────────────────────────────────────────────────────
//
// 승인하는 자리는 하나만 만들고 검토 인박스와 문서 상세가 나눠 쓴다. 화면마다 폼을
// 따로 그리면 한쪽만 근거를 받거나 한쪽만 거절 문장을 삼키게 되고, 그 차이는 승인이
// 거절된 다음에야 드러난다 — 서버에서 자격 판정을 표면마다 두지 않는 것과 같은 이유다.
//
// 한 번에 한 건만 펼친다. 여럿을 열어 두면 어느 폼에 무엇을 적었는지가 화면에서
// 흐려지고, 승인은 "이것을 내가 책임진다"는 선언이라 대상이 흐려지면 안 된다.

// 근거의 우리말. 목록 자체는 서버가 싣는다(approvalCatalog.basisKinds) — 화면이 목록을
// 적으면 그것은 vocabulary.js의 정본 사본이 되고, 근거 종류가 느는 날 화면만 모른 채
// 돈다. 표에 없는 종류는 저장값을 그대로 보여 준다.
const BASIS_LABELS = { read: '읽고 판단했다', verdict: '검증 판정을 봤다', check: '검사를 통과했다', delegated: '위임받았다' };
// 비교 축 둘. 묻는 것이 다르다 — 앞엣것은 "승인 이후 무엇이 바뀌었나"이고 뒤엣것은
// "승인 후보가 승인본과 무엇이 다른가"다. 승인자가 판정해야 하는 것은 작업본이 아니라
// 후보이므로, 제출이 서 있으면 뒤엣것이 먼저다. 키 목록이 곧 단추의 목록이다.
const DIFF_AXIS_LABELS = { 'since-approval': '승인 이후 변경', submission: '제출본 비교' };

function approvalPanel(id) { return state.docApproval && state.docApproval.id === id ? state.docApproval : null; }
function basisChoices() { return (state.snapshot.approvalCatalog && state.snapshot.approvalCatalog.basisKinds) || Object.keys(BASIS_LABELS); }

// 펼치기·접기. 제출본이 서 있으면 그 축으로 연다 — 승인자가 볼 것은 승인 후보이고,
// 후보와 작업본이 다를 수 있다는 사실 자체가 관문의 핵심이다.
function toggleApproval(id) {
  if (approvalPanel(id)) { state.docApproval = null; return redrawApproval(); }
  const item = (state.snapshot.documents || []).find((value) => value.id === id);
  const submission = item && item.approval && item.approval.submission;
  const staged = submission && (submission.state === 'pending' || submission.state === 'drifted');
  loadApprovalDiff(id, staged ? 'submission' : 'since-approval');
}

// 차분은 스냅숏에 없다. 문서마다 git 이력을 도는 계산이라 폴링에 실으면 보드가 서므로,
// 펼친 그 건에 대해서만 물어 온다.
async function loadApprovalDiff(id, axis) {
  const approvers = state.snapshot.approvers || [];
  const kept = state.docApproval && state.docApproval.id === id ? state.docApproval.form : null;
  const panel = {
    id,
    axis,
    diff: null,
    reason: '',
    error: '',
    failure: '',
    loading: true,
    busy: false,
    // 축을 바꿔도 쓰던 것은 남긴다. 여기서 비우면 사유를 적다가 다른 축을 눌러 본
    // 사람이 자기가 쓴 문장을 잃는다.
    form: kept || { clientId: (approvers[0] && approvers[0].id) || '', basis: basisChoices()[0] || '', detail: '', reason: '' }
  };
  state.docApproval = panel;
  redrawApproval();
  try {
    const value = await api(`${projectPath(`/documents/${encodeURIComponent(id)}/diff`)}?axis=${encodeURIComponent(axis)}`);
    if (state.docApproval !== panel) return;
    panel.diff = value.diff === undefined ? null : value.diff;
    panel.reason = value.reason || '';
  } catch (error) {
    if (state.docApproval !== panel) return;
    panel.error = error.message;
  }
  panel.loading = false;
  redrawApproval();
}

// 펼친 자리만 다시 그린다. 문서 상세에서 본문까지 다시 그리면 읽던 자리를 잃고,
// 그 화면은 지금 읽고 승인하는 자리다.
function redrawApproval() {
  if (state.view === 'review-inbox') return renderReviewInbox();
  if (state.view !== 'document' || !state.selected) return;
  const item = (state.snapshot.documents || []).find((value) => value.id === state.selected);
  if (!item) return;
  el('document-approval').innerHTML = documentApprovalHtml(item);
  el('document-approval-panel').innerHTML = approvalPanelHtml(item.id, 'document');
}

// git diff를 줄 단위로 칠한다. 무엇이 늘고 줄었는지는 색이 먼저 말해 주고, 그 다음에
// 글자를 읽는다 — 색이 없으면 승인자는 전문을 처음부터 다시 읽는 것과 같아진다.
function diffLinesHtml(text) {
  return String(text).split('\n').map((line) => {
    const tone = /^(?:diff |index |--- |\+\+\+ )/u.test(line) ? 'meta'
      : line.startsWith('@@') ? 'hunk'
        : line.startsWith('+') ? 'add'
          : line.startsWith('-') ? 'del' : '';
    return `<span class="diff-line${tone ? ` diff-${tone}` : ''}">${escapeHtml(line)}</span>`;
  // 줄마다 block으로 세우므로 사이에 개행을 두면 안 된다. pre 안에서 그 개행은
  // 글자로 남아 줄마다 빈 줄이 하나씩 더 생긴다.
  }).join('');
}

function approvalDiffHtml(panel) {
  if (panel.loading) return '<p class="ledger-note">무엇이 달라졌는지 읽는 중입니다…</p>';
  if (panel.error) return `<p class="approval-failure">차이를 읽지 못했습니다: ${escapeHtml(panel.error)}</p>`;
  // 비교 기준이 없는 것과 바뀐 것이 없는 것은 다른 값이다. 앞엣것을 빈 차분으로 그리면
  // 사람은 아무것도 안 바뀐 줄 알고 승인한다 — 서버가 이유를 함께 내는 이유가 그것이고,
  // 화면은 그 이유를 그대로 옮긴다.
  if (panel.diff === null) return `<p class="ledger-note"><b>비교 기준이 없습니다.</b> ${escapeHtml(panel.reason || '이 축으로는 견줄 것이 없습니다.')}</p>`;
  if (panel.diff === '') return `<p class="ledger-note"><b>바뀐 것이 없습니다.</b> ${escapeHtml(panel.reason || '')}</p>`;
  return `<pre class="approval-diff">${diffLinesHtml(panel.diff)}</pre>`;
}

function approvalFormHtml(id, panel, surface) {
  const approvers = state.snapshot.approvers || [];
  // 지금 이 판이 이미 승인되어 있으면 승인할 것이 없다. 폼을 그대로 두면 눌러도 원장이
  // 늘지 않는 단추가 되고, 아무 일도 하지 않는 단추는 다음에 진짜로 필요할 때도 안 눌린다.
  const item = (state.snapshot.documents || []).find((value) => value.id === id);
  if (item && item.approval && item.approval.status === 'approved') {
    return `<p class="ledger-note"><b>지금 판은 이미 승인되어 있습니다.</b> ${escapeHtml(personName(item.approval.approvedBy))}이(가) 책임집니다 — 본문이 바뀌면 이 승인은 낡음이 되고 그때 다시 이 자리가 섭니다.</p>`;
  }
  // 고를 수 없는 것을 화면에 두면 사람은 거절당한 뒤에야 그것을 안다. 자격자가 없으면
  // 폼 대신 자격이 무엇인지와 어떻게 만드는지를 적는다.
  if (!approvers.length) {
    return '<p class="ledger-note"><b>이 프로젝트에는 승인 자격을 가진 Client가 없습니다.</b> '
      + '승인은 활성 human Client만 할 수 있고, 그 소유 멤버가 이 프로젝트의 활성 멤버여야 합니다. '
      + '설정의 Client 목록에서 human 자격을 등록하거나, 비활성이 된 자격을 다시 켜십시오.</p>'
      + '<div class="approval-form-actions"><button type="button" data-view="settings">설정 열기</button></div>';
  }
  const form = panel.form;
  return `<form class="approval-form" data-approve-form="${escapeHtml(id)}">`
    + `<label>승인자<select data-approve-field="clientId">${approvers.map((client) =>
      `<option value="${escapeHtml(client.id)}"${client.id === form.clientId ? ' selected' : ''}>${escapeHtml(client.name || client.id)} (${escapeHtml(client.id)})</option>`).join('')}</select></label>`
    // 근거는 화면에서도 필수다. 나중에 "AI 검토가 놓쳤나 사람이 건너뛰었나"를 가르려면
    // 그 값이 있어야 하고, 그 구분이 없으면 승인 이력은 누가 눌렀다는 목록에 그친다.
    + `<label>근거<select data-approve-field="basis">${basisChoices().map((kind) =>
      `<option value="${escapeHtml(kind)}"${kind === form.basis ? ' selected' : ''}${kind === 'delegated' ? ' disabled' : ''}>`
      + `${escapeHtml(BASIS_LABELS[kind] || kind)}${kind === 'delegated' ? ' — 위임 식별자가 필요해 명령줄에서만' : ''}</option>`).join('')}</select></label>`
    + `<label>근거 상세<input data-approve-field="detail" maxlength="300" placeholder="예: 3장 전체 재독" value="${escapeHtml(form.detail || '')}"></label>`
    + `<label>사유<textarea data-approve-field="reason" rows="2" maxlength="1000" placeholder="무엇을 보고 승인했는지">${escapeHtml(form.reason || '')}</textarea></label>`
    + '<div class="approval-form-actions">'
    + (surface === 'inbox' ? `<button type="button" data-document="${escapeHtml(id)}">문서 화면에서 열기</button>` : '')
    + `<button type="submit" class="primary"${panel.busy ? ' disabled' : ''}>${panel.busy ? '승인하는 중…' : '승인'}</button></div>`
    // 거절은 서버의 말 그대로 옮긴다. "승인 실패"로 바꾸면 사람 게이트에 걸린 것인지
    // 근거가 모자란 것인지 알 수 없어 같은 단추를 다시 누르게 된다.
    + (panel.failure ? `<p class="approval-failure">${escapeHtml(panel.failure)}</p>` : '')
    + '</form>';
}

function approvalPanelHtml(id, surface) {
  const panel = approvalPanel(id);
  if (!panel) return '';
  const axes = Object.keys(DIFF_AXIS_LABELS).map((key) =>
    `<button type="button" data-approve-axis="${key}"${key === panel.axis ? ' class="active"' : ''}>${escapeHtml(DIFF_AXIS_LABELS[key])}</button>`).join('');
  return `<div class="approval-panel"><div class="segmented approval-axis" aria-label="비교 축">${axes}</div>`
    + approvalDiffHtml(panel) + approvalFormHtml(id, panel, surface) + '</div>';
}

async function approveOpenDocument(id) {
  const panel = approvalPanel(id);
  if (!panel || panel.busy) return;
  const form = panel.form;
  if (!form.clientId) return message('승인자를 고르세요. 활성 human Client만 승인할 수 있습니다.', true);
  if (!form.basis) return message('무엇에 기대어 승인하는지 근거를 고르세요.', true);
  if (!String(form.reason || '').trim()) return message('무엇을 보고 승인했는지 사유가 필요합니다.', true);
  panel.busy = true;
  panel.failure = '';
  redrawApproval();
  try {
    const result = await api(projectPath(`/documents/${encodeURIComponent(id)}/approve`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
      body: JSON.stringify({ clientId: form.clientId, basis: [{ kind: form.basis, detail: form.detail }], reason: String(form.reason).trim() })
    });
    state.docApproval = null;
    message(`${id}을(를) ${result.document.approvedBy} 자격으로 승인했습니다.`);
    // 승인 뒤 화면은 새 상태를 그려야 한다. 판정은 원장에서 파생하므로 스냅숏을 다시
    // 읽는 것 말고 화면이 할 일이 없다 — 여기서 상태를 직접 고치면 그것이 두 번째
    // 진실 원천이 되고, 서버가 아니라고 답해도 화면은 승인됐다고 말한다.
    await loadSnapshot(true);
    redrawApproval();
  } catch (error) {
    panel.busy = false;
    panel.failure = error.message;
    redrawApproval();
  }
}

function renderReviewInbox() {
  const queue = state.snapshot.reviewQueue;
  const mode = reviewMode(queue);
  const filters = el('review-inbox-filter');
  const summary = el('review-inbox-summary');
  const list = el('review-inbox-list');
  // 줄이 서지 않는 갈래에서는 거르개도 목록도 없앤다. 빈 목록 위의 거르개는 누를 것이
  // 있다는 약속인데, 여기서는 지킬 것이 없다.
  filters.hidden = mode !== 'ready';
  list.hidden = mode !== 'ready';
  if (mode !== 'ready') { filters.innerHTML = ''; list.innerHTML = ''; }
  if (mode === 'absent') {
    // 스냅숏에 줄 자체가 없는 판이다. 빈 목록으로 그리면 "검토할 것이 없다"로 읽히고,
    // 그것은 이 서버가 답하지 못한 물음에 화면이 대신 답하는 셈이 된다.
    summary.innerHTML = '<p class="empty-state">이 Board 서버는 검토 줄을 아직 싣지 않습니다. 서버를 다시 시작하세요.</p>';
    return;
  }
  if (mode === 'unknown') {
    // 못 읽은 이유를 그대로 옮긴다. 삼키면 원장이 깨진 저장소와 원장을 안 쓰는 저장소가
    // 화면에서 같아 보이고, 모르는 것이 미승인으로 읽힌다.
    summary.innerHTML = '<p class="review-inbox-note"><b>승인 상태를 읽지 못했습니다.</b> '
      + escapeHtml(queue.unknown) + '</p>'
      + '<p class="review-inbox-note">모르는 것과 미승인은 다른 값이라, 읽지 못한 문서를 검토 대기로 세지 않습니다. 이 자리가 비어 있다고 해서 검토할 것이 없다는 뜻은 아닙니다.</p>';
    return;
  }
  if (mode === 'unused') {
    // 승인 기록이 한 건도 없으면 문서 전건이 미승인으로 선다. 그것은 문서마다의 상태가
    // 아니라 이 프로젝트가 승인 축을 안 쓴다는 뜻이고, 줄로 늘어놓으면 인박스가 첫날부터
    // 문서 전건으로 차 정작 검토할 것을 가린다. 근거는 스냅숏이 주고 판단은 여기서 한다.
    summary.innerHTML = '<p class="review-inbox-note"><b>이 프로젝트는 아직 승인을 관문으로 쓰지 않습니다.</b> '
      + `승인 기록이 한 건도 없어 문서 ${escapeHtml(state.snapshot.documents.length)}건이 모두 미승인으로 서 있지만, 그것은 문서마다의 상태가 아니라 이 프로젝트가 승인 축을 쓰지 않는다는 뜻입니다. 그래서 검토 대기 줄로 늘어놓지 않습니다.</p>`
      + '<p class="review-inbox-note">한 건이라도 승인하면 그때부터 이 줄이 뜻을 갖습니다. 승인은 <code>rdl doc approve</code>가 담당합니다.</p>'
      + '<div class="review-inbox-actions"><button type="button" data-view="documents">문서 목록 열기</button></div>';
    return;
  }
  const counts = queue.counts;
  const filter = state.reviewFilter === 'all' || REVIEW_STATUS_TONES[state.reviewFilter] ? state.reviewFilter : 'all';
  state.reviewFilter = filter;
  // 거르개의 수는 전건이다. 목록의 길이를 적으면 잘린 줄에서 두 수가 어긋나고, 그때
  // 사람은 잘렸다는 사실이 아니라 화면이 틀렸다는 인상을 받는다.
  filters.innerHTML = [['all', '전체', queue.total]].concat(Object.keys(REVIEW_STATUS_TONES).map((key) => [key, REVIEW_STATUS_LABELS[key], counts[key]]))
    .map(([key, label, count]) => `<button type="button" data-review-filter="${key}"${key === filter ? ' class="active"' : ''}>${key === 'all' ? '' : '<span class="severity-dot" aria-hidden="true"></span>'}${escapeHtml(label)} ${count}</button>`).join('');
  // 서버는 낡음을 앞에 두고 정렬해 보냈다. 여기서 다시 정렬하면 두 순서가 갈리고, 그때
  // 화면이 말하는 "먼저 볼 것"은 근거 없는 순서가 된다. 거르기만 한다.
  const visible = filter === 'all' ? queue.items : queue.items.filter((item) => item.status === filter);
  // 셈은 전건이고 목록만 잘린다. 두 수가 다르다는 사실을 화면이 말해야 줄의 길이가
  // 보이고, 길이가 보여야 사람이 승인을 관문으로 쓸지 판단한다.
  const full = filter === 'all' ? queue.total : counts[filter];
  summary.innerHTML = `<div class="review-inbox-counts">${[['검토 대기', queue.total], [REVIEW_STATUS_LABELS.stale, counts.stale], [REVIEW_STATUS_LABELS.unapproved, counts.unapproved], [REVIEW_STATUS_LABELS.approved, counts.approved]]
    .map(([label, count]) => `<span class="review-inbox-stat"><b>${count}</b> ${escapeHtml(label)}</span>`).join('')}</div>`
    + (visible.length < full
      ? `<p class="review-inbox-note"><b>${full}건 중 ${visible.length}건</b>만 실려 있습니다. 스냅숏은 줄이 길어져도 앞 ${queue.items.length}건까지만 싣습니다 — 나머지는 <code>rdl doc status</code>로 봅니다.</p>`
      : '');
  list.innerHTML = visible.length
    ? visible.map(reviewRowHtml).join('')
    : `<p class="empty-state">${filter === 'all' ? '검토를 기다리는 문서가 없습니다. 문서 전건이 지금 리비전으로 승인되어 있습니다.' : '이 상태인 문서가 없습니다.'}</p>`;
}

function renderHome() {
  const data = state.snapshot; const tasks = data.tasks.tasks; const documents = data.documents; const attention = data.attention;
  // 숫자를 보고 그 목록으로 갈 수 없으면 요약이 막다른 길이 된다. 지금까지 div였고
  // 눌러도 아무 일이 없었다. 각 지표를 그 수를 만든 화면으로 보낸다.
  // 문서 축의 검토 대기. 아래 검토 요청과 이름이 갈려 있어야 두 수가 같은 것을 세는 줄로
  // 읽히지 않는다 — 하나는 태스크가 승인 스텝에 선 것이고, 하나는 문서가 승인 원장과
  // 어긋난 것이다. 모를 때와 승인 축을 안 쓸 때는 수를 내지 않는다.
  const waiting = reviewWaiting(data.reviewQueue);
  const metrics = [
    [tasks.length, '전체 태스크', 'data-view="tasks"'],
    [documents.length, '프로젝트 문서', 'data-view="documents"'],
    [tasks.filter((task) => inStep(task.status, 'in-approval')).length, '검토 요청 태스크', 'data-view="review"'],
    [waiting === null ? '—' : waiting, '검토 대기 문서', 'data-view="review-inbox"'],
    [attention.length, '조치 필요', 'data-focus-attention="1"']
  ];
  el('metrics').innerHTML = metrics.map(([value, label, action]) => `<button type="button" class="metric" ${action}><strong>${value}</strong><span>${label}</span></button>`).join('');
  // 태스크는 그 태스크로 가고 동기화 항목은 동기화를 실행한다. 예전에는 둘 다 운영 상태
  // 화면으로 보냈는데 그 화면은 헤더와 이 목록의 중복이라 없앴다.
  renderAttention(attention);
  el('home-documents').innerHTML = documents.slice().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 6).map(documentCard).join('');
  renderMyQueue(tasks);
  renderRecentChanges(tasks, documents);
}

// 홈은 프로젝트 전체를 요약할 뿐 "그래서 내가 지금 뭘 하면 되나"에는 답하지 않았다.
// 막힌 일과 시작할 수 있는 일을 갈라 놓아야 그 답이 된다.
function renderMyQueue(tasks) {
  if (!state.currentMember) {
    el('my-queue').innerHTML = '<p class="identity-prompt">헤더에서 보기 기준을 고르면 내 작업과 검토 요청을 여기 모아 보여줍니다.</p>';
    return;
  }
  const mine = tasks.filter((task) => task.owner === state.currentMember && !isTerminalStatus(task.status));
  const ready = mine.filter((task) => !taskBlockage(task));
  const blocked = mine.filter((task) => taskBlockage(task));
  const reviews = tasks.filter((task) => inStep(task.status, 'in-approval') && (task.reviewers || []).includes(state.currentMember));
  const buckets = [
    ['지금 시작할 수 있는 일', ready, '내게 배정되었고 막힌 것이 없는 작업입니다.'],
    ['내 검토 대기', reviews, '내가 검토자로 지정된 작업입니다.'],
    ['막혀 있는 내 일', blocked, '사람을 기다리거나 선행 작업이 끝나지 않았습니다.']
  ].filter(([, items]) => items.length);
  el('my-queue').innerHTML = buckets.length
    ? buckets.map(([label, items, hint]) => `<section class="queue-bucket"><div class="section-heading"><h3>${escapeHtml(label)} <span class="badge">${items.length}</span></h3><small>${escapeHtml(hint)}</small></div><div class="task-table">${items.slice(0, 5).map(taskRow).join('')}</div>${items.length > 5 ? `<small class="queue-more">외 ${items.length - 5}건은 태스크 화면에서 볼 수 있습니다.</small>` : ''}</section>`).join('')
    : '<p class="empty-state">지금 내 차례인 작업이 없습니다.</p>';
}

// 마지막으로 이 프로젝트를 열어 본 시각을 브라우저에 남긴다. 서버에 저장하면
// 기기마다 다른 "마지막 방문"이 하나로 합쳐져 오히려 놓치는 변경이 생긴다.
// 값은 프로젝트를 열 때 한 번만 읽는다. 매번 다시 읽으면 방금 찍은 시각과 비교하게 되어
// 목록이 항상 비어 보인다.
function visitKey() { return `rundol.lastVisit.${state.project}`; }
function markVisit() { if (state.project) localStorage.setItem(visitKey(), new Date().toISOString()); }
function renderRecentChanges(tasks, documents) {
  const since = state.lastVisit;
  if (!since) {
    el('changes-since').textContent = '';
    el('recent-changes').innerHTML = '<p class="empty-state">이 브라우저에서 처음 열었습니다. 다음 방문부터 그동안 바뀐 것을 모아 보여줍니다.</p>';
    return;
  }
  const changedTasks = tasks.filter((task) => (task.updatedAt || '') > since);
  const changedDocuments = documents.filter((item) => (item.modifiedAt || '') > since);
  el('changes-since').textContent = changedTasks.length + changedDocuments.length || '';
  const rows = changedDocuments.slice(0, 8).map((item) => `<button class="task-row" data-document="${escapeHtml(item.id)}"><span class="task-row-main"><span class="task-row-title">${escapeHtml(item.title)}</span></span><span class="task-prio">${escapeHtml(item.id)}</span><span class="task-row-meta">${escapeHtml(relativeTime(item.modifiedAt))}</span></button>`)
    .concat(changedTasks.slice(0, 8).map(taskRow));
  el('recent-changes').innerHTML = rows.length ? rows.join('') : `<p class="empty-state">${escapeHtml(relativeTime(since))} 이후 바뀐 것이 없습니다.</p>`;
}
function relativeTime(value) {
  const stamp = Date.parse(value || '');
  if (Number.isNaN(stamp)) return value || '-';
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}시간 전`;
  return `${Math.round(minutes / 1440)}일 전`;
}

function renderNavigation() {
  const documents = state.snapshot.documents;
  const counts = new Map(); for (const documentValue of documents) counts.set(documentValue.kind || documentValue.type, (counts.get(documentValue.kind || documentValue.type) || 0) + 1);
  const order = (kind) => state.snapshot.presentation && state.snapshot.presentation.documentTypes[kind] ? state.snapshot.presentation.documentTypes[kind].order : 999;
  el('document-filters').innerHTML = `<button data-document-filter="">모든 문서 <span>${documents.length}</span></button>` + Array.from(counts).sort((left, right) => order(left[0]) - order(right[0]) || left[0].localeCompare(right[0])).map(([kind, count]) => `<button data-document-filter="${escapeHtml(kind)}">${escapeHtml(documentTypeLabel({ kind }))} <span>${count}</span></button>`).join('');
  el('recent-documents').innerHTML = documents.slice().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 5).map((item) => `<button data-document="${escapeHtml(item.id)}"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(documentTypeLabel(item))}</small></button>`).join('');
}

// 본문에만 있는 용어는 지금까지 검색되지 않았다. 대상이 ID·제목·설명·파일 경로
// 넷뿐이었기 때문이다. 본문은 이미 스냅숏에 있으므로 새로 계산할 것이 없다.
//
// 범위를 나누는 이유는 목적이 둘이기 때문이다 — 아는 문서로 이동하는 것과, 어떤
// 용어를 어디에 어떻게 썼는지 추적하는 것. 후자에서는 제목만 봐서는 답이 안 나오고,
// 전자에서는 본문까지 뒤지면 결과가 넘친다.
function documentMatches(item, query, scope) {
  if (!query) return true;
  const name = `${item.id} ${item.title} ${item.description || ''} ${item.file}`.toLowerCase();
  if (scope === 'body') return name.includes(query) || String(item.body || '').toLowerCase().includes(query);
  return name.includes(query);
}

// 본문에서 맞은 자리를 한 줄 보여 준다. 어느 문서인지만 알려 주면 결국 하나씩 열어
// 확인해야 하고, 그러면 검색이 목록 필터에 그친다.
function bodyExcerpt(item, query) {
  if (!query) return '';
  const body = String(item.body || '');
  const at = body.toLowerCase().indexOf(query);
  if (at < 0) return '';
  const start = Math.max(0, at - 40);
  const raw = body.slice(start, at + query.length + 60).replace(/\s+/gu, ' ').trim();
  return `${start > 0 ? '… ' : ''}${raw}${at + query.length + 60 < body.length ? ' …' : ''}`;
}

// 목록의 안내문. 갈래마다 말할 것이 다르고, 말하지 않으면 화면이 대신 거짓을 말한다 —
// 원장을 못 읽었을 때의 빈 축은 "미승인"으로 읽히고, 승인 축을 안 쓰는 프로젝트의 전건
// 미승인은 "전부 밀렸다"로 읽힌다. 검토 인박스가 같은 갈래를 같은 말로 가른다.
function documentLedgerNotes(visible, ledger, used) {
  const notes = [];
  if (!ledger) {
    const reason = state.snapshot.reviewQueue && state.snapshot.reviewQueue.unknown;
    return [`<p class="ledger-note"><b>승인 상태를 읽지 못했습니다.</b>${reason ? ` ${escapeHtml(reason)}` : ''} 모르는 것과 미승인은 다른 값이라, 이 목록은 승인 축을 그리지도 거르지도 않습니다.</p>`];
  }
  if (!used) {
    notes.push('<p class="ledger-note"><b>이 프로젝트는 아직 승인을 관문으로 쓰지 않습니다.</b> 승인 기록이 한 건도 없어 문서가 모두 미승인으로 섭니다 — 문서마다의 상태가 아니라 이 축을 쓰지 않는다는 뜻입니다. 승인은 <code>rdl doc approve</code>가 담당합니다.</p>');
  }
  // 세는 대상은 지금 목록에 실제로 서 있는 줄이다. 거르기 전의 수를 적으면 낡음 2줄만 걸러
  // 놓고 "15건"을 읽게 되고, "그 문서의 상태 칩에 표시해 두었다"는 말이 가리킬 칩이 화면에
  // 없다. 안내는 화면에 있는 것을 가리켜야 한다.
  const unbacked = visible.filter(claimsUnbacked).length;
  if (unbacked) {
    notes.push(`<p class="ledger-note"><b>${unbacked}건</b>은 frontmatter가 승인을 주장하지만 원장은 그 리비전을 승인한 적이 없습니다. 그 문서의 상태 칩에 표시해 두었습니다 — 주장과 사실이 갈린 자리입니다.</p>`);
  }
  return notes;
}

function renderDocuments() {
  const query = state.query.toLowerCase();
  const scope = state.documentSearchScope || 'name';
  // 유형·검색으로 먼저 좁히고 승인 갈래는 그 위에서 센다. 순서가 반대면 거르개에 적힌 수와
  // 눌렀을 때 남는 줄의 수가 어긋난다. "요구사항 중 낡은 것"을 물을 수 있으려면 두 축이
  // 직교해야 하고, 직교한다는 것은 한 축의 셈이 다른 축을 이미 통과한 것들의 셈이라는 뜻이다.
  const scoped = state.snapshot.documents
    .filter((item) => (!state.documentFilter || (item.kind || item.type) === state.documentFilter) && documentMatches(item, query, scope));
  const ledger = state.snapshot.documents.some((item) => item.approval);
  // "이 프로젝트가 승인 축을 쓰는가"는 프로젝트 전체의 성질이라 거르개를 통과한 것들로 세면
  // 안 된다. 유형을 요구사항으로 좁히면 그 안에는 승인된 것도 낡은 것도 없어, 승인을 쓰는
  // 프로젝트가 갑자기 안 쓰는 것으로 화면에 뜬다. 판정 규칙은 board.js의 reviewQueue.used와
  // 같고(승인됨이나 낡음이 한 건이라도 있는가), 문서에서 직접 세어 스냅숏이 그 줄을 안 실어도 선다.
  const used = state.snapshot.documents.some((item) => item.approval && item.approval.status !== 'unapproved');
  const counts = { all: scoped.length, approved: 0, stale: 0, unapproved: 0 };
  for (const item of scoped) { const status = approvalStatusOf(item); if (status) counts[status] += 1; }
  // 원장을 못 읽으면 거르개가 서지 않는다. 모르는 것을 "미승인 133건"으로 세어 단추에 적으면
  // 화면이 서버가 답하지 못한 물음에 대신 답하는 셈이 된다.
  const branches = Object.keys(DOCUMENT_APPROVAL_TONES);
  const approvalFilter = ledger && branches.includes(state.documentApproval) ? state.documentApproval : 'all';
  state.documentApproval = approvalFilter;
  const filters = el('document-approval-filter');
  filters.hidden = !ledger;
  filters.innerHTML = ledger
    ? [['all', '전체', counts.all]].concat(branches.map((key) => [key, REVIEW_STATUS_LABELS[key], counts[key]]))
      .map(([key, label, count]) => `<button type="button" data-document-approval="${key}"${key === approvalFilter ? ' class="active"' : ''}>${key === 'all' ? '' : '<span class="severity-dot" aria-hidden="true"></span>'}${escapeHtml(label)} ${count}</button>`).join('')
    : '';
  const documents = (approvalFilter === 'all' ? scoped : scoped.filter((item) => approvalStatusOf(item) === approvalFilter))
    .sort((left, right) => (state.documentSort === 'modified'
      ? String(right.modifiedAt || '').localeCompare(String(left.modifiedAt || ''))
      : String(left.id).localeCompare(String(right.id))));
  const notes = documentLedgerNotes(documents, ledger, used);
  el('documents-note').innerHTML = notes.join('');
  el('documents-note').hidden = !notes.length;
  // 고른 것이 어느 쪽인지 화면이 말해야 한다. 동작만 바뀌고 표시가 그대로면 사용자는
  // 자기가 무엇을 보고 있는지 모른다 — index.html의 active가 정적으로 박혀 있어서
  // 첫 항목이 늘 선택된 것처럼 보였다.
  for (const button of document.querySelectorAll('#document-scope [data-document-scope]')) {
    button.classList.toggle('active', button.dataset.documentScope === scope);
  }
  for (const button of document.querySelectorAll('#document-sort [data-document-sort]')) {
    button.classList.toggle('active', button.dataset.documentSort === (state.documentSort || 'id'));
  }
  // 원장을 못 읽는 저장소에서는 태그가 한 줄도 서지 않는다. 그때 머리 열을 비워 두면 133줄이
  // 통째로 56px씩 밀린 채 아무것도 안 담는다 — 열 자체를 접는다.
  el('documents-list').classList.toggle('with-ledger', ledger);
  el('documents-list').innerHTML = documents.length ? documents.map((item) => {
    // 내용 요약 칸은 「본문 전체」로 검색할 때만 선다. 그때의 발췌는 "왜 이 문서가 걸렸나"를
    // 말하는 값이라 폭을 벌 자격이 있고, 평소의 description은 잘려서 읽히지도 않으면서 행
    // 가운데를 통째로 먹어 오른쪽 메타를 화면 밖으로 밀어냈다.
    const excerpt = scope === 'body' ? bodyExcerpt(item, query) : '';
    const status = approvalStatusOf(item);
    // 두 축을 나란히 세운다. 원장은 행의 머리에 태그로 서고(검토 인박스와 같은 자리·같은
    // 말·같은 색), frontmatter의 주장은 뒤쪽 칩으로 남는다. 하나로 합치면 지금과 같은
    // 거짓말이 다른 모양으로 다시 생긴다 — 화면이 주장을 사실처럼 말하게 된다.
    const unbacked = claimsUnbacked(item);
    return `<button class="document-row${excerpt ? ' with-excerpt' : ''}" data-document="${escapeHtml(item.id)}">`
      + (status ? approvalTagHtml(status) : '')
      + `<span class="eyebrow">${escapeHtml(item.id)}</span>`
      + `<strong>${escapeHtml(item.title)}</strong>`
      + (excerpt ? `<small>${escapeHtml(excerpt)}</small>` : '')
      + `<span class="document-row-meta"><time datetime="${escapeHtml(item.modifiedAt || '')}">${escapeHtml(shortDate(item.modifiedAt))}</time>`
      + `<span class="chip">${escapeHtml(documentTypeLabel(item))}</span>`
      + `<span class="chip${unbacked ? ' claim-unbacked' : ''}"${unbacked ? ` title="frontmatter는 승인을 주장하지만 승인 원장은 ${escapeHtml(REVIEW_STATUS_LABELS[status])}입니다"` : ''}>${escapeHtml(documentStateLabel(item.state))}</span>`
      + '</span></button>';
  }).join('') : '<p class="empty-state">조건에 맞는 문서가 없습니다.</p>';
}

function ownerName(reference) { const match = /\|([^\]]+)\]\]/.exec(reference || ''); return match ? match[1] : reference || '미지정'; }
function personName(reference) { const person = state.snapshot.people.members.find((item) => item.id === reference) || state.snapshot.people.stakeholders.find((item) => item.id === reference); return person ? person.name : ownerName(reference); }
function contextSelect(field, current, options) { return `<select class="context-editor" data-task-field="${field}" aria-label="${field} 수정">${options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === (current || '') ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`; }
// 태스크 화면은 사이드와 전체화면 두 벌로 따로 있었고 구조가 서로 달라, 같은 태스크를
// 어디서 여느냐에 따라 다른 것이 보였다. 한 벌만 만들고 담는 그릇만 바꾼다.
// 순서는 제목 → 속성 → 내용이다. 속성은 짧고 개수가 고정이라 위에서 한눈에 지나가고,
// 길이를 알 수 없는 내용이 그 아래로 흐른다.
// 태스크 댓글. 작성 주체를 지우지 않는 것이 이 화면의 계약이다 — 에이전트가 남긴
// 것과 사람이 남긴 것이 같아 보이면, 승인 근거가 될 수 없다는 판정이 화면에서
// 사라진다. 그래서 이름 옆에 종류를 붙이고 자격 없는 것은 그 사실을 표시한다.
// 아바타 색은 이름에서 뽑는다. 무작위로 주면 새로고침마다 색이 바뀌어 얼굴 역할을
// 하지 못한다. 같은 사람은 어느 화면에서도 같은 색이어야 목록을 훑을 때 눈이 쉰다.
function avatarTone(seed) {
  let hash = 0;
  for (const char of String(seed || '?')) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}
// 이니셜은 첫 글자 하나다. 한글은 두 글자를 넣으면 원 안에서 뭉개지고, 라틴 이름의
// 성까지 넣으면 같은 성을 쓰는 사람이 구분되지 않는다.
function avatarHtml(name, agent) {
  const label = String(name || '?').trim().slice(0, 1).toUpperCase();
  return `<span class="comment-avatar${agent ? ' agent' : ''}" style="--tone: ${avatarTone(name)}" aria-hidden="true">${escapeHtml(label)}</span>`;
}
// 작성자 이름. 사람이면 구성원 이름을, 에이전트면 어느 Client인지를 보인다 — 에이전트를
// 사람 이름으로 부르면 누가 한 말인지가 화면에서 흐려지고, 그 구분이 승인 근거 판정이다.
function commentAuthor(item) {
  if (item.workerKind !== 'human') return item.clientId;
  const member = (state.snapshot.people.members || []).find((person) => person.id === item.member);
  return (member && member.name) || item.member || item.clientId;
}
// 시각은 두 벌로 적는다. 훑을 때는 "3시간 전"이 빠르고, 따질 때는 정확한 값이 필요하다.
function commentTimeHtml(item) {
  const exact = String(item.recordedAt || '').replace('T', ' ').slice(0, 16);
  return `<time datetime="${escapeHtml(item.recordedAt || '')}" title="${escapeHtml(exact)}">${escapeHtml(relativeTime(item.recordedAt))}</time>`;
}
function commentItemHtml(item, taskId, reply) {
  const agent = item.workerKind !== 'human';
  const author = commentAuthor(item);
  // 정정된 댓글은 그 사실을 남긴다. 조용히 바꾸면 지난 화면을 본 사람과 지금 보는
  // 사람이 다른 기록을 읽게 된다.
  const corrected = item.correctedBy
    ? `<p class="comment-correction">작성 주체가 정정되었습니다: ${escapeHtml(item.correctionReason || '사유 없음')}</p>`
    : '';
  // 답글 단추는 뿌리에만 둔다. 깊이는 하나이고, 답글에도 두면 사람은 계단이 생길 것이라
  // 기대하지만 저장은 같은 줄기로 접는다 — 화면이 없는 구조를 약속하는 셈이 된다.
  const actions = reply ? '' : `<div class="comment-actions"><button type="button" data-comment-reply="${escapeHtml(item.eventId || '')}" data-comment-task="${escapeHtml(taskId)}">답글</button></div>`;
  return `<li class="comment-item${agent ? ' agent' : ''}${reply ? ' reply' : ''}" data-comment="${escapeHtml(item.eventId || '')}">`
    + `<div class="comment-head">${avatarHtml(author, agent)}`
    + `<strong class="comment-author">${escapeHtml(author)}</strong>`
    + `<span class="comment-kind">${agent ? '에이전트' : '사람'}</span>`
    + commentTimeHtml(item)
    + '</div>'
    + `<div class="comment-body">${markdown(String(item.body || ''))}</div>`
    + corrected + actions;
}
// 스레드로 접는 규칙은 comment-rules가 갖는다. 화면이 자기 방식으로 다시 접으면 같은
// 원장이 자리마다 다르게 보인다. 여기서는 같은 규칙을 그대로 따른다 — 부모를 찾지
// 못한 답글은 숨기지 않고 뿌리로 올린다. 기록을 화면에서 지우면 남은 것이 전부인 줄 알게 된다.
function commentThreadsOf(taskId) {
  const all = (state.snapshot && state.snapshot.comments) || [];
  const mine = all.filter((item) => item.taskId === taskId);
  const known = new Set(mine.map((item) => item.eventId));
  const replies = new Map();
  for (const item of mine) {
    if (!item.parentId || !known.has(item.parentId)) continue;
    replies.set(item.parentId, (replies.get(item.parentId) || []).concat(item));
  }
  return mine
    .filter((item) => !item.parentId || !known.has(item.parentId))
    .map((item) => ({ comment: item, replies: replies.get(item.eventId) || [] }));
}
// 입력칸은 평소에 한 줄이다. 항상 펼쳐 두면 목록보다 입력칸이 커 보이고, 읽으러 온
// 사람에게 쓰라고 재촉하는 화면이 된다.
//
// 펼침 여부는 state가 갖는다. DOM에 두면 폴링이 다시 그릴 때마다 접히고, 쓰던 사람은
// 자기가 뭘 잘못 눌렀는지 찾게 된다.
function composerOpenFor(taskId, parentId) {
  const open = state.commentComposer;
  return Boolean(open) && open.taskId === taskId && (open.parentId || null) === (parentId || null);
}
function commentComposerHtml(taskId, parentId) {
  const attributes = `data-comment-form="${escapeHtml(taskId)}"${parentId ? ` data-comment-parent="${escapeHtml(parentId)}"` : ''}`;
  if (!composerOpenFor(taskId, parentId)) {
    return `<div class="comment-composer" ${attributes}>`
      + `<button type="button" class="comment-composer-open">${parentId ? '답글 남기기…' : '댓글 남기기…'}</button></div>`;
  }
  // 편집기는 여기에 붙는다. RundolEditor가 없으면 textarea가 그 자리를 대신한다 —
  // 번들이 없다고 댓글을 못 남기면, 편집기 빌드 실패가 논의를 막는 사고가 된다.
  return `<form class="comment-composer open" ${attributes}>`
    + '<div class="comment-editor" data-comment-editor hidden></div>'
    + '<textarea name="body" rows="3" placeholder="남길 말. 그림은 붙여넣고 문서는 [[로 링크합니다" aria-label="댓글 내용"></textarea>'
    + '<div class="comment-composer-actions"><button type="button" class="comment-composer-cancel">취소</button>'
    + `<button type="submit" class="primary">${parentId ? '답글' : '댓글'} 남기기</button></div></form>`;
}
function commentSectionHtml(taskId) {
  const threads = commentThreadsOf(taskId);
  const list = threads.length
    ? `<ol class="comment-list">${threads.map((thread) => {
      const replies = thread.replies.length
        ? `<ol class="comment-replies">${thread.replies.map((item) => commentItemHtml(item, taskId, true)).join('')}</ol>`
        : '';
      // 답글 입력칸은 그 줄기 안에 둔다. 목록 맨 아래에 두면 어느 댓글에 답하는지가
      // 화면에서 사라지고, 사람은 자기가 쓴 답글이 엉뚱한 데 붙었다고 읽는다.
      const composer = composerOpenFor(taskId, thread.comment.eventId) ? commentComposerHtml(taskId, thread.comment.eventId) : '';
      return `${commentItemHtml(thread.comment, taskId, false)}${replies}${composer}</li>`;
    }).join('')}</ol>`
    : '<p class="empty-state">아직 댓글이 없습니다.</p>';
  return list + commentComposerHtml(taskId, null);
}
function taskDetailHtml(task, mode) {
  const members = [['', '미지정']].concat(state.snapshot.people.members.map((member) => [member.id, member.name]));
  const criteria = Object.entries(task.acceptanceCriteria || {});
  const doneCount = criteria.filter(([, value]) => value.done).length;
  const pending = state.pendingTasks.has(task.id);
  const documents = (task.links || []).map((link) => state.snapshot.documents.find((item) => item.id === link)).filter(Boolean);
  const dependencies = (task.deps || []).map((id) => state.snapshot.tasks.tasks.find((item) => item.id === id)).filter(Boolean);
  const blockage = taskBlockage(task);

  // peek에서는 크게 보기가 패널 크롬(× 옆)에 있으므로 머리글에 또 두지 않는다.
  const head = `<header class="task-detail-head"><p class="eyebrow">${escapeHtml(task.id)}</p><h1>${escapeHtml(task.title)}</h1>${mode === 'page' ? '<div class="task-detail-actions"><button data-view="tasks">목록으로</button></div>' : ''}</header>`;

  const row = (label, value) => `<div class="property"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  const properties = `<dl class="task-properties">${[
    row('상태', contextSelect('status', task.status, labelledEntries('taskStatuses', statusKeys()))),
    row('우선순위', contextSelect('priority', task.priority, labelledEntries('priorities', ['high', 'mid', 'low']))),
    row('소유자', contextSelect('owner', task.owner, members)),
    // 종류·차수·판정은 테스트 태스크만 갖는다. 일반 태스크에 "일반 / 차수 없음 / 판정 없음"을
    // 세 줄이나 늘어놓으면 늘 비어 있는 칸이 속성 목록의 절반을 차지한다.
    // 판정은 아직 화면에서 바꿀 수 없다. 보드 API가 쓰기를 받는 항목에 result가 없어
    // 고르게 두면 눌러도 저장되지 않는다. 그래서 고르는 칸이 아니라 읽는 줄로 둔다.
    (task.kind || 'normal') === 'test' ? row('종류', '테스트') : '',
    (task.kind || 'normal') === 'test' && Number.isInteger(task.round) ? row('차수', `${task.round}차`) : '',
    (task.kind || 'normal') === 'test'
      ? row('판정', `<span class="tag ${escapeHtml(task.result || 'pending')}">${escapeHtml(TEST_RESULT_LABELS[task.result] || '미수행')}</span>`)
      : '',
    row('검토자', escapeHtml((task.reviewers || []).map(personName).join(', ') || '미지정')),
    row('이해관계자', escapeHtml((task.stakeholders || []).map(personName).join(', ') || '미지정')),
    blockage ? row('막힘', `<span class="task-blocked" data-blocked="${blockage.kind}">${escapeHtml(blockage.label)}</span> ${escapeHtml(blockage.detail.split('\n')[0])}`) : '',
    task.blocker ? row('차단 사유', escapeHtml(blockerText(task.blocker))) : '',
    task.cancellation ? row('반려 사유', escapeHtml(cancellationText(task.cancellation))) : '',
    row('변경', escapeHtml(relativeTime(task.updatedAt))),
    row('저장', `<span class="save-state ${pending ? 'pending' : ''}">${pending ? '● 파일 반영 대기' : '✓ 저장됨'}</span>`)
  ].filter(Boolean).join('')}</dl>`;

  const section = (title, body, badge) => `<section class="task-detail-section"><h2>${escapeHtml(title)}${badge ? ` <span class="badge">${escapeHtml(badge)}</span>` : ''}</h2>${body}</section>`;
  const body = [
    `<div class="task-detail-summary">${task.summary ? markdown(task.summary) : '<p class="empty-state">설명이 등록되지 않았습니다.</p>'}</div>`,
    section('완료조건', criteria.length
      // 행 전체가 버튼이다. 글자를 눌러도 켜지고, 상태는 글리프가 아니라 네모칸으로 보인다.
      ? `<div class="acceptance-list">${criteria.map(([key, value]) => `<button class="acceptance-item ${value.done ? 'done' : ''}" data-task-acceptance="${escapeHtml(key)}" aria-pressed="${value.done}" aria-label="${escapeHtml(key)} ${escapeHtml(value.text)}"><span class="acceptance-box" aria-hidden="true"></span><span class="acceptance-text"><strong>${escapeHtml(key)}</strong><br>${escapeHtml(value.text)}</span></button>`).join('')}</div>`
      : '<p class="empty-state">완료조건이 없습니다.</p>', criteria.length ? `${doneCount}/${criteria.length}` : ''),
    section('연결 문서', documents.length ? `<div class="card-grid">${documents.map(documentCard).join('')}</div>` : '<p class="empty-state">연결된 문서가 없습니다.</p>'),
    section('의존 태스크', dependencies.length ? `<div class="task-table">${dependencies.map(taskRow).join('')}</div>` : '<p class="empty-state">선행 태스크가 없습니다.</p>'),
    section('댓글', commentSectionHtml(task.id), String(((state.snapshot && state.snapshot.comments) || []).filter((item) => item.taskId === task.id).length || '')),
    (task.externalRefs || []).length ? section('외부 참조', task.externalRefs.map((ref) => `<p>${escapeHtml(typeof ref === 'string' ? ref : JSON.stringify(ref))}</p>`).join('')) : ''
  ].filter(Boolean).join('');

  return `<article class="task-detail" data-task-detail="${escapeHtml(task.id)}">${head}${properties}${body}</article>`;
}

// 태스크 상세를 다시 그릴 때 쓰다 만 댓글을 살린다. 스냅샷은 5초마다 도는데 그때마다
// 사람이 치고 있던 글이 지워지면 이 화면에서는 긴 댓글을 쓸 수 없다. 값과 캐럿, 그리고
// 포커스가 그 칸에 있었는지까지 되돌린다 — 포커스를 잃으면 다음 글자가 엉뚱한 데로 간다.
function withCommentDraft(host, redraw) {
  const before = host.querySelector('[data-comment-form] [name="body"]');
  const kept = before && before.value
    ? { value: before.value, start: before.selectionStart, end: before.selectionEnd, focused: document.activeElement === before }
    : null;
  redraw();
  if (!kept) return;
  const after = host.querySelector('[data-comment-form] [name="body"]');
  if (!after) return;
  after.value = kept.value;
  if (!kept.focused) return;
  after.focus();
  after.setSelectionRange(kept.start, kept.end);
}

// 옆에 열어둔 태스크는 목록과 함께 다시 그린다. 목록만 갱신하면 peek은 예전 스냅샷을
// 계속 들고 있어, 방금 남긴 댓글이 저장되고도 그 자리에서는 보이지 않는다 — 사람은
// 댓글이 사라진 것으로 읽고 같은 글을 다시 쓴다.
function redrawTaskPeek() {
  if (document.body.dataset.peekKind !== 'task' || !state.selected) return;
  const task = state.snapshot.tasks.tasks.find((item) => item.id === state.selected);
  if (!task) return;
  withCommentDraft(el('context-content'), () => renderContext(task, 'task'));
  mountOpenComposer();
}
// 목록을 다시 그리면 어느 줄을 열어 두었는지 표시가 사라진다. 옆 패널은 그 태스크를
// 보여주는데 목록에서는 아무것도 골라지지 않은 것처럼 보여, 둘이 다른 것을 가리키는
// 것으로 읽힌다. 다시 그린 뒤에 그 표시를 되돌린다.
function markPeekedRow() {
  if (document.body.dataset.peekKind !== 'task' || !state.selected) return;
  for (const row of document.querySelectorAll('.task-row')) row.classList.toggle('peeked', row.dataset.task === state.selected);
}

// 상세와 컨텍스트가 함께 쓰는 원장의 사실. 목록이 태그 하나로 말한 것을 여기서는 근거까지
// 편다 — 누가, 몇 번, 어느 리비전을 승인했는가. 값은 스냅숏의 document.approval 그대로이며
// 화면이 리비전을 비교해 판정을 다시 짓지 않는다. 지으면 rdl doc status와 보드가 같은 문서에
// 다른 답을 내고, 그때 사람이 믿는 쪽은 화면이다.
function approvalFacts(approval) {
  const facts = approval.approvals
    ? [`승인자 ${escapeHtml(personName(approval.approvedBy))}`, `승인 ${escapeHtml(approval.approvals)}회`]
    : ['승인 이력 없음'];
  // 승인된 리비전은 낡음일 때 "무엇으로 되돌아갈 수 있는가"를 가리키고, 승인됨일 때 지금
  // 리비전과 같다는 사실을 가리킨다. 미승인은 그런 리비전 자체가 없어 자리를 만들지 않는다.
  if (approval.approvedRevision) facts.push(`승인된 리비전 <code>${escapeHtml(String(approval.approvedRevision).slice(0, 12))}</code>`);
  return facts;
}
function documentApprovalHtml(item) {
  const approval = item.approval;
  if (!approval) {
    // 못 읽은 것을 미승인으로 적지 않는다. 모르는 것과 아직 아닌 것은 다른 값이고, 앞엣것은
    // 고쳐야 할 사고인데 미승인으로 적으면 아무도 그것을 모른다.
    const reason = state.snapshot.reviewQueue && state.snapshot.reviewQueue.unknown;
    return `<h2>승인 원장</h2><p class="ledger-note"><b>승인 상태를 읽지 못했습니다.</b>${reason ? ` ${escapeHtml(reason)}` : ''} 그래서 이 문서를 미승인으로 적지 않습니다.</p>`;
  }
  const open = Boolean(approvalPanel(item.id));
  // 승인은 문서를 읽은 자리에서 이어져야 한다. 인박스를 거치지 않고 문서를 연 사람도
  // 여기서 승인할 수 있어야 하고, 그러지 않으면 "승인은 명령줄에서"가 되어 화면을 보던
  // 사람이 도구를 갈아타야 한다 — 그 왕복이 승인을 맨 뒤로 미루는 자리였다.
  const lines = [`<h2>승인 원장</h2><p class="document-approval-line">${approvalTagHtml(approval.status)}<span>${approvalFacts(approval).join(' · ')}</span>`
    + `<button type="button" class="approval-open" data-approve-open="${escapeHtml(item.id)}" aria-expanded="${open}">${open ? '접기' : '검토하고 승인'}</button></p>`];
  if (claimsUnbacked(item)) {
    lines.push(`<p class="ledger-note">frontmatter는 <code>${escapeHtml(item.state)}</code>(${escapeHtml(documentStateLabel(item.state))})라고 적었지만 원장은 이 리비전을 승인한 적이 없습니다. 앞엣것은 작성자의 주장이고 뒤엣것이 원장의 사실이라, 어긋난 채로 둘 수 있습니다.</p>`);
  }
  if (approval.status === 'stale') {
    // 차분은 이제 이 화면이 싣는다. 다만 지어내지는 않는다 — 값은 서버가 요청 시 계산해
    // 주는 그것이고, 같은 값을 명령줄에서도 볼 수 있다는 것을 함께 적어 둔다.
    lines.push(`<p class="ledger-note">승인 이후 본문이 바뀌었습니다. 무엇이 바뀌었는지는 위 단추로 이 자리에서 보고 재승인할 수 있고, 같은 값을 <code>rdl doc diff ${escapeHtml(item.id)} --since-approval</code>로도 봅니다.</p>`);
  }
  return lines.join('');
}

function renderContext(item, kind) {
  el('context-empty').hidden = true; el('context-content').hidden = false;
  if (kind === 'task') return void (el('context-content').innerHTML = taskDetailHtml(item, 'peek'));
  if (kind === 'document') {
    const linkedTasks = state.snapshot.tasks.tasks.filter((task) => (task.links || []).includes(item.id));
    // 속성표에도 두 축을 갈라 적는다. "상태" 한 줄만 있으면 그것이 승인 상태로 읽히는데,
    // 그 값은 frontmatter의 주장이라 원장과 어긋날 수 있다 — 그래서 dt를 "문서 상태"로
    // 이름 붙이고 원장의 사실을 그 아래에 따로 세운다. 검토 인박스에서 "낡음"이라 부른
    // 문서를 눌러 도착한 자리가 여기라, 여기서 말이 갈리면 인박스가 거짓말한 것이 된다.
    const approval = item.approval;
    const ledgerRows = approval
      ? `<div class="property"><dt>승인 원장</dt><dd>${approvalTagHtml(approval.status)}</dd></div>`
        + (approval.approvals ? `<div class="property"><dt>승인자</dt><dd>${escapeHtml(personName(approval.approvedBy))} · ${escapeHtml(approval.approvals)}회</dd></div>` : '')
        + (approval.approvedRevision ? `<div class="property"><dt>승인 리비전</dt><dd>${escapeHtml(String(approval.approvedRevision).slice(0, 12))}</dd></div>` : '')
      : '<div class="property"><dt>승인 원장</dt><dd>읽지 못함</dd></div>';
    el('context-content').innerHTML = `<section class="context-group"><h2>속성</h2><dl><div class="property"><dt>ID</dt><dd>${escapeHtml(item.id)}</dd></div><div class="property"><dt>유형</dt><dd>${escapeHtml(documentTypeLabel(item))}</dd></div><div class="property"><dt>문서 상태</dt><dd>${escapeHtml(documentStateLabel(item.state))}</dd></div>${ledgerRows}<div class="property"><dt>소유자</dt><dd>${escapeHtml(ownerName(item.owner))}</dd></div><div class="property"><dt>파일</dt><dd>${escapeHtml(item.file)}</dd></div></dl></section><section class="context-group"><h2>연결 태스크</h2>${linkedTasks.length ? linkedTasks.map((task) => `<button data-task="${task.id}">${escapeHtml(task.title)}</button>`).join('') : '<p class="empty-state">연결된 태스크 없음</p>'}</section><section class="context-group"><h2>검증</h2><p class="chip">strict snapshot 포함</p><small>${escapeHtml(item.revision.slice(0, 12))}</small></section>`;
  }
}
function renderDocument(id) { const item = state.snapshot.documents.find((documentValue) => documentValue.id === id); if (!item) return setView('documents'); el('document-breadcrumb').innerHTML = breadcrumb([{ label: state.project, view: 'home' }, { label: '문서', view: 'documents' }, { label: item.id }]);
  closeBlockEditor(); renderEditAvailability(); el('document-title').textContent = item.title; el('document-description').textContent = item.description; el('document-badges').innerHTML = [item.id, documentTypeLabel(item), documentStateLabel(item.state), ownerName(item.owner)].filter(Boolean).map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join(''); el('document-approval').innerHTML = documentApprovalHtml(item); el('document-approval-panel').innerHTML = approvalPanelHtml(item.id, 'document'); el('document-body').innerHTML = markdown(item.body); resolveDocumentImages(el('document-body'), item.file, state.project); el('document-body').hidden = false; el('document-editor').hidden = true; el('document-editor-surface').hidden = true; el('edit-document').hidden = false; el('cancel-document-edit').hidden = true; el('save-document').hidden = true; renderContext(item, 'document'); renderMermaid(); }

// 무엇이 막혀 있는지가 목록에서 가장 먼저 읽혀야 한다. 사람 대기(blocker)는 값으로 있었지만
// 끝나지 않은 선행 태스크(deps)는 어디에도 보이지 않아, 목록만 보면 시작할 수 있는 일처럼 읽혔다.
function taskBlockage(task) {
  if (task.blocker) return { kind: 'waiting', label: `${personName(task.blocker.waitingFor)} 대기`, detail: task.blocker.condition || '' };
  const open = (task.deps || []).map((id) => state.snapshot.tasks.tasks.find((item) => item.id === id)).filter((item) => item && !isTerminalStatus(item.status));
  if (!open.length) return null;
  return { kind: 'deps', label: `선행 ${open.length}건`, detail: open.map((item) => `${item.id} ${item.title}`).join('\n') };
}
// 진행(status)과 판정(result)은 다른 축이다. 완료+실패는 "돌렸는데 실패"이고 할일은
// "아직 안 돌림"이다. 하나로 합치면 고칠 일과 할 일이 구분되지 않는다. 판정이 없는
// 테스트는 아직 돌리지 않은 것이므로 빈칸이 아니라 미수행이라고 적는다.
const TEST_RESULT_LABELS = { pass: '통과', fail: '실패', blocked: '막힘', skipped: '건너뜀' };

function taskRow(task) {
  const completed = Object.values(task.acceptanceCriteria || {}).filter((item) => item.done).length;
  const total = Object.keys(task.acceptanceCriteria || {}).length;
  const blockage = taskBlockage(task);
  const badge = blockage ? `<span class="task-blocked" data-blocked="${blockage.kind}" title="${escapeHtml(blockage.detail)}">${escapeHtml(blockage.label)}</span>` : '';
  // 테스트 태스크만 차수와 판정을 갖는다. 일반 태스크에 빈 자리를 만들면 목록이
  // 성기게 뜨므로 제목 옆에 붙여 있는 것만 보이게 한다.
  const test = (task.kind || 'normal') === 'test';
  const round = test && Number.isInteger(task.round) ? `<span class="task-round">${task.round}차</span>` : '';
  const verdict = test ? `<span class="tag ${escapeHtml(task.result || 'pending')}">${escapeHtml(TEST_RESULT_LABELS[task.result] || '미수행')}</span>` : '';
  return `<button class="task-row" data-task="${task.id}"><span class="task-row-main"><span class="task-row-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>${round}${verdict}${badge}</span><span class="task-prio" data-prio="${escapeHtml(task.priority)}">${escapeHtml(priorityLabel(task.priority))}</span><span class="task-row-meta">${escapeHtml(personName(task.owner))} · ${completed}/${total}</span></button>`;
}
// 묶음. 평평한 목록은 33행이 한 벽으로 보여 무엇이 남았는지 읽히지 않는다.
// 상태로 묶으면 완료 묶음이 생기고 기본으로 접는다. 개수는 남으므로 진행감은 잃지 않는다.
const groupers = {
  status: { order: () => statusKeys(), key: (task) => task.status, label: (key) => taskStatusLabel(key) },
  owner: { order: null, key: (task) => task.owner || '', label: (key) => personName(key) || '미지정' },
  priority: { order: () => ['high', 'mid', 'low'], key: (task) => task.priority, label: (key) => priorityLabel(key) },
  // 테스트는 차수로 읽는다. 같은 TST가 1차·2차에 각각 태스크를 가지므로, 차수로 묶어야
  // "이번 회차가 어디까지 왔나"가 한눈에 보인다. 차수 없는 일반 태스크는 한 통에 모은다.
  round: { order: null, key: (task) => (Number.isInteger(task.round) ? String(task.round) : ''), label: (key) => (key ? `${key}차` : '차수 없음') }
};
// 실무에서는 한 묶음이 백 줄을 넘는다. 다 그리면 아래 묶음들이 화면 밖으로 밀려나서
// "검토가 몇 건인가"를 알려면 스크롤을 한참 내려야 한다. 묶음마다 앞의 몇 줄만 두면
// 전체 모양이 한 화면에 들어온다. 행은 우선순위 순으로 서 있으므로 앞의 몇 줄이
// 곧 급한 것들이다. 아홉 줄까지는 그대로 둔다 - "2개 더 보기"는 누를 이유가 없다.
const TASK_PREVIEW = 6;
const TASK_PREVIEW_MIN = 9;

function groupExpanded(groupBy, key) {
  return viewOption(`expand.${groupBy}.${key}`, '') === '1';
}

function previewRows(groupBy, key, items) {
  if (groupExpanded(groupBy, key) || items.length <= TASK_PREVIEW_MIN) return items.map(taskRow).join('');
  const rest = items.length - TASK_PREVIEW;
  return items.slice(0, TASK_PREVIEW).map(taskRow).join('')
    + `<button class="task-group-more" data-group-expand="${escapeHtml(`${groupBy}.${key}`)}">${rest}개 더 보기</button>`;
}

function groupCollapsed(groupBy, key) {
  const saved = viewOption(`collapse.${groupBy}.${key}`, null);
  if (saved !== null) return saved === '1';
  return groupBy === 'status' && isTerminalStatus(key);
}
function taskGroups(tasks) {
  const groupBy = viewOption('groupBy', 'status');
  const grouper = groupers[groupBy] || groupers.status;
  const keys = grouper.order ? grouper.order() : Array.from(new Set(tasks.map(grouper.key))).sort();
  return keys
    .map((key) => [key, tasks.filter((task) => grouper.key(task) === key)])
    .filter(([, items]) => items.length)
    .map(([key, items]) => {
      const collapsed = groupCollapsed(groupBy, key);
      return `<section class="task-group${collapsed ? ' collapsed' : ''}"><button class="task-group-head" data-group-toggle="${escapeHtml(`${groupBy}.${key}`)}" aria-expanded="${!collapsed}"><span class="group-caret" aria-hidden="true">${CHEVRON_ICON}</span><span class="chip">${escapeHtml(grouper.label(key))}</span><span class="badge">${items.length}</span></button>${collapsed ? '' : previewRows(groupBy, key, items)}</section>`;
    })
    .join('');
}
function renderTasks() { redrawTaskPeek(); const scopes = { all: ['전체 태스크', '프로젝트의 모든 작업을 목록과 Board로 확인합니다.'], mine: ['내 작업', '현재 사용자에게 할당된 작업입니다.'], review: ['내 검토', '현재 사용자가 검토자로 지정된 검토 대기 작업입니다.'] }; const [heading, description] = scopes[state.taskScope]; el('tasks-heading').textContent = heading; el('tasks-description').textContent = description; let tasks = state.snapshot.tasks.tasks; if (state.taskScope !== 'all' && !state.currentMember) { el('task-list').hidden = false; el('board').hidden = true; el('task-graph').hidden = true; el('task-list').innerHTML = '<p class="identity-prompt">헤더에서 보기 기준을 고르면 개인 작업과 검토 요청을 정확히 구분할 수 있습니다.</p>'; return; } if (state.taskScope === 'mine') tasks = tasks.filter((task) => task.owner === state.currentMember); if (state.taskScope === 'review') tasks = tasks.filter((task) => inStep(task.status, 'in-approval') && (task.reviewers || []).includes(state.currentMember)); const query = state.query.toLowerCase(); tasks = tasks.filter((task) => (!query || `${task.id} ${task.title} ${task.summary || ''}`.toLowerCase().includes(query)) && (!el('owner').value || task.owner === el('owner').value) && (!el('priority').value || task.priority === el('priority').value)
    && (!el('task-kind').value || (task.kind || 'normal') === el('task-kind').value)
    && (!el('task-round').value || String(task.round) === el('task-round').value));
  // 완료 숨기기는 접기와 다른 일을 한다. 접기는 묶음 머리글을 남기고, 숨기기는 항목을 뺀다.
  // 담당자나 우선순위로 묶으면 완료 묶음이 없으므로 그때는 이 필터가 그 역할을 한다.
  if (el('hide-done').checked) tasks = tasks.filter((task) => !isTerminalStatus(task.status));
  el('task-list').hidden = state.taskMode !== 'list';
  el('board').hidden = state.taskMode !== 'board';
  el('task-graph').hidden = state.taskMode !== 'graph';
  // Board는 화면 높이에 고정되어 레인마다 따로 스크롤한다. 바깥이 스크롤되면 레인
  // 머리글이 위로 밀려 어느 열을 보고 있는지 놓친다. 그 배치를 body가 알아야 한다.
  document.body.classList.toggle('board-mode', state.taskMode === 'board');
  if (state.taskMode === 'list') el('task-list').innerHTML = tasks.length ? taskGroups(tasks) : '<p class="empty-state">조건에 맞는 태스크가 없습니다.</p>';
  else if (state.taskMode === 'board') renderBoard(tasks); else renderTaskGraph(tasks);
  markPeekedRow(); }
// Trello를 따른다. 카드는 제목 두 줄로 높이를 맞춰 눈이 한 칸씩 훑을 수 있게 하고,
// 막힌 태스크만 표식을 더한다. 높이가 제각각이면 열끼리 줄이 어긋나 비교가 안 된다.
function boardCard(task) {
  const blockage = taskBlockage(task);
  const total = Object.keys(task.acceptanceCriteria || {}).length;
  const completed = Object.values(task.acceptanceCriteria || {}).filter((item) => item.done).length;
  return `<button class="task-card" data-task="${escapeHtml(task.id)}" title="${escapeHtml(task.title)}">`
    + `<span class="task-card-title">${escapeHtml(task.title)}</span>`
    + `<span class="task-card-meta">`
    + `<span class="task-prio" data-prio="${escapeHtml(task.priority)}">${escapeHtml(priorityLabel(task.priority))}</span>`
    + `<span class="task-card-owner">${escapeHtml(personName(task.owner))}</span>`
    + (total ? `<span class="task-card-progress">${completed}/${total}</span>` : '')
    + (blockage ? `<span class="task-blocked" data-blocked="${blockage.kind}" title="${escapeHtml(blockage.detail)}">${escapeHtml(blockage.label)}</span>` : '')
    + `</span></button>`;
}
function renderBoard(tasks) {
  el('board').innerHTML = statusKeys().map((status) => {
    const items = tasks.filter((task) => task.status === status);
    return `<section class="column"><header class="column-head"><h2 title="${escapeHtml(presentationHint('taskStatuses', status))}">${escapeHtml(taskStatusLabel(status))}</h2><span class="badge">${items.length}</span></header>`
      + `<div class="column-cards">${items.length ? items.map(boardCard).join('') : '<p class="column-empty">없음</p>'}</div></section>`;
  }).join('');
}
// 의존 관계는 태스크마다 deps 값으로만 있어, 어디서 순서가 막히는지는 한 건씩 열어봐야 알 수 있었다.
// 목록·Board와 같은 필터를 받아 지금 보는 범위의 순서만 그린다.
// 태스크 제목은 사람이 자유롭게 쓴다. 큰따옴표가 그대로 들어가면 노드 라벨이 닫혀 파싱이 깨진다.
function nodeLabel(value) { return String(value).replace(/"/gu, '#quot;').replace(/[\r\n]+/gu, ' '); }
function renderTaskGraph(tasks) {
  const visible = new Set(tasks.map((task) => task.id));
  const edges = tasks.flatMap((task) => (task.deps || []).filter((id) => visible.has(id)).map((id) => `  ${id} --> ${task.id}`));
  if (!edges.length) return void (el('task-graph').innerHTML = '<p class="empty-state">지금 보이는 태스크 사이에 의존 관계가 없습니다. 태스크 상세에서 선행 작업을 연결하면 여기에 순서가 그려집니다.</p>');
  // 색은 테마를 따라가야 하므로 mermaid classDef 대신 라벨로 상태를 말한다.
  const nodes = tasks.filter((task) => (task.deps || []).some((id) => visible.has(id)) || tasks.some((other) => (other.deps || []).includes(task.id)))
    .map((task) => `  ${task.id}["${nodeLabel(`${inStep(task.status, 'completed') ? '✓ ' : ''}${task.id} ${task.title}`)}"]`);
  const diagram = ['flowchart LR'].concat(nodes, edges).join('\n');
  el('task-graph').innerHTML = `<pre class="mermaid">${escapeHtml(diagram)}</pre>`;
  renderMermaid();
}
// 전체화면은 peek과 같은 컴포넌트를 넓은 그릇에 담을 뿐이다. 편집 컨트롤이 두 곳에
// 동시에 살아 있으면 어느 쪽 값이 저장되는지 알 수 없으므로, 전체화면에서는 peek을 비운다.
function renderTask(id) {
  const task = state.snapshot.tasks.tasks.find((item) => item.id === id);
  if (!task) return setView('tasks');
  el('task-breadcrumb').innerHTML = breadcrumb([{ label: state.project, view: 'home' }, { label: '태스크', view: 'tasks' }, { label: task.id }]);
  withCommentDraft(el('task-page'), () => { el('task-page').innerHTML = taskDetailHtml(task, 'page'); });
  mountOpenComposer();
  el('context-content').hidden = true;
  el('context-empty').hidden = false;
  renderMermaid();
}
// 사람·역할·이해관계자는 성격이 다르다. 멤버는 이름이 짧고 수가 적어 카드가 맞지만,
// 역할과 이해관계자는 책임 문장이 길어 카드에 넣으면 두 줄에서 잘린다. 목록 행으로 둔다.
// project.md의 값에는 [[project#^ROLE-001|제품·기술 책임자]] 같은 Obsidian 링크가 들어 있다.
// 그대로 두면 화면에 대괄호와 앵커가 그대로 나온다. 보이는 이름만 남긴다.
function plainText(value) { return String(value || '').replace(/\[\[[^\]|]*\|([^\]]+)\]\]/gu, '$1').replace(/\[\[([^\]]+)\]\]/gu, '$1'); }
// 필드를 전부 이어붙이면 한 줄이 문단이 된다. 종류마다 그 사람을 가장 잘 말하는 하나만 쓴다.
const personSummaryField = { members: '책임 영역', roles: '미션', stakeholders: '관심' };
function personSummary(item, group) {
  const fields = item.fields || {};
  const preferred = fields[personSummaryField[group]];
  return plainText(item.description || preferred || Object.values(fields)[0] || '');
}
function personRow(item, group) {
  return `<button class="person-row" data-person="${escapeHtml(group)}:${escapeHtml(item.id)}"><span class="person-row-main"><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(personSummary(item, group) || '설명 없음')}</small></span><span class="eyebrow">${escapeHtml(item.id)}</span></button>`;
}
function renderPeople() {
  const people = state.snapshot.people;
  // 명단만 다시 그리면 옆에 열어둔 사람의 태스크·문서 수가 예전 값으로 남는다.
  if (state.selected && document.body.dataset.peekKind === 'person') redrawPerson(state.selected);
  el('members').innerHTML = people.members.map((item) => `<button class="person-card" data-person="members:${escapeHtml(item.id)}"><span class="eyebrow">${escapeHtml(item.id)}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(plainText((item.fields || {})['역할']) || '역할 미지정')}</small><small>${escapeHtml(personSummary(item, 'members') || '설명 없음')}</small></button>`).join('') || '<p class="empty-state">등록된 멤버가 없습니다.</p>';
  el('roles').innerHTML = people.roles.map((item) => personRow(item, 'roles')).join('') || '<p class="empty-state">정의된 역할이 없습니다.</p>';
  el('stakeholders').innerHTML = people.stakeholders.map((item) => personRow(item, 'stakeholders')).join('') || '<p class="empty-state">등록된 이해관계자가 없습니다.</p>';
}
// 태스크와 같은 방식으로 옆에서 연다. 화면을 갈아치우면 명단 맥락을 잃고,
// 사람 하나를 보려고 화면을 오갈 만큼 내용이 많지도 않다.
function redrawPerson(id) {
  for (const group of ['members', 'roles', 'stakeholders']) {
    const entry = (state.snapshot.people[group] || []).find((item) => item.id === id);
    if (entry) { el('context-content').innerHTML = personDetailHtml(entry, group); return; }
  }
  // project.md에서 지워진 사람이다. 옛 내용을 그대로 두면 없는 사람을 보고 있게 된다.
  closePeek();
  message('이 사람은 project.md에서 사라졌습니다.');
}
function personDetailHtml(entry, group) {
  const labels = { members: '멤버', roles: '역할', stakeholders: '이해관계자' };
  const fields = Object.entries(entry.fields || {}).filter(([, value]) => String(value || '').trim());
  const tasks = state.snapshot.tasks.tasks.filter((task) => task.owner === entry.id || (task.reviewers || []).includes(entry.id) || (task.stakeholders || []).includes(entry.id));
  const open = tasks.filter((task) => !isTerminalStatus(task.status));
  const documents = state.snapshot.documents.filter((item) => String(item.owner || '').includes(entry.id));
  return `<article class="task-detail"><header class="task-detail-head"><p class="eyebrow">${escapeHtml(labels[group] || group)} · ${escapeHtml(entry.id)}</p><h1>${escapeHtml(entry.name || entry.id)}</h1></header>`
    + `<dl class="task-properties">${fields.map(([label, value]) => `<div class="property"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(plainText(value))}</dd></div>`).join('') || '<div class="property"><dt>설명</dt><dd>없음</dd></div>'}</dl>`
    + `<section class="task-detail-section"><h2>맡은 태스크 <span class="badge">${open.length}/${tasks.length}</span></h2>${tasks.length ? `<div class="task-table">${tasks.slice(0, 8).map(taskRow).join('')}</div>` : '<p class="empty-state">연결된 태스크가 없습니다.</p>'}</section>`
    + `<section class="task-detail-section"><h2>소유 문서 <span class="badge">${documents.length}</span></h2>${documents.length ? `<div class="card-grid">${documents.slice(0, 6).map(documentCard).join('')}</div>` : '<p class="empty-state">소유한 문서가 없습니다.</p>'}</section>`
    + '<p class="control-hint">project.md가 정본입니다. 추가와 수정은 <code>rdl member</code> 명령이 담당합니다.</p></article>';
}

// 거르개는 이름표를 칸 안에 넣었다. 고른 값이 있으면 이름표가 값으로 바뀌어 사라지므로,
// 지금 걸러져 있다는 것을 칸의 생김새로 남긴다. 그러지 않으면 목록이 짧은 이유를 알 수 없다.
function markFilters() {
  for (const id of ['owner', 'priority', 'task-kind', 'task-round']) el(id).toggleAttribute('data-on', Boolean(el(id).value));
}

function syncRoundField(available) {
  const count = available === undefined ? el('task-round').options.length - 1 : available;
  el('task-round').hidden = count === 0 || el('task-kind').value === 'normal';
  if (el('task-round').hidden) el('task-round').value = '';
}

function populateControls() { const members = state.snapshot.people.members; el('owner').replaceChildren(new Option('담당자', ''), ...members.map((item) => new Option(item.name, item.id)));
  // 저장해 둔 표시 옵션을 컨트롤에 되돌린다. 값이 사라진 담당자를 가리키면 무시한다.
  const savedOwner = viewOption('owner', '');
  el('owner').value = members.some((item) => item.id === savedOwner) ? savedOwner : '';
  el('priority').value = viewOption('priority', '');
  // 차수는 테스트 태스크만 갖는다. 테스트가 없는 프로젝트에서는 늘 비어 있는 칸이므로
  // 아예 감춘다. 일반만 보고 있을 때도 차수는 고를 것이 없어 같이 감춘다.
  const rounds = Array.from(new Set(state.snapshot.tasks.tasks.map((task) => task.round).filter((round) => Number.isInteger(round)))).sort((left, right) => left - right);
  el('task-round').replaceChildren(new Option('차수', ''), ...rounds.map((round) => new Option(`${round}차`, String(round))));
  el('task-kind').value = viewOption('taskKind', '');
  const savedRound = viewOption('taskRound', '');
  el('task-round').value = rounds.some((round) => String(round) === savedRound) ? savedRound : '';
  syncRoundField(rounds.length);
  markFilters();
  el('group-by').value = groupers[viewOption('groupBy', 'status')] ? viewOption('groupBy', 'status') : 'status';
  el('hide-done').checked = viewOption('hideDone', '') === '1'; el('task-owner').replaceChildren(new Option('미지정', ''), ...members.map((item) => new Option(item.name, item.id))); // 새로 만드는 태스크는 아직 끝나지도, 접히지도 않았다. 종료 상태를 고르게 두면
// 완료는 수용조건과 TST를, 반려는 사유를 요구해 생성이 그대로 거부된다.
el('task-status').replaceChildren(...labelledEntries('taskStatuses', statusKeys().filter((value) => !isTerminalStatus(value))).map(([value, label]) => new Option(label, value))); const saved = localStorage.getItem(`rundol.currentMember.${state.project}`) || ''; state.currentMember = members.some((item) => item.id === saved) ? saved : ''; el('current-member').replaceChildren(new Option('사용자 선택', ''), ...members.map((item) => new Option(item.name, item.id))); el('current-member').value = state.currentMember; }
function updateHealth() { const count = state.snapshot.attention.length; const health = el('health'); health.className = `health ${count ? 'warning' : ''}`; el('health-label').textContent = count ? '조치 필요' : '정상'; el('operation-count').textContent = count || ''; renderSyncStatus(); }

// 동기화는 값을 바꾸는 설정이 아니라 되돌리기 어려운 동작이다. 설정 화면이 아니라
// 상태 옆에 두어, 무엇이 원격으로 나가는지 보고 나서 누르게 한다.
function syncSummary(sync) {
  if (!sync) return { text: '동기화 상태', tone: '' };
  if ((sync.conflicts || []).length) return { text: `충돌 ${sync.conflicts.length}건`, tone: 'error' };
  const parts = [];
  if (sync.changedFiles) parts.push(`로컬 변경 ${sync.changedFiles}`);
  if (sync.ahead) parts.push(`올릴 것 ${sync.ahead}`);
  if (sync.behind) parts.push(`받을 것 ${sync.behind}`);
  return parts.length ? { text: parts.join(' · '), tone: 'warning' } : { text: '원격과 같음', tone: '' };
}
function renderSyncStatus() {
  const sync = state.snapshot.sync;
  const summary = syncSummary(sync);
  el('sync-status').className = `sync-status ${summary.tone}`;
  el('sync-label').textContent = summary.text;
  // 충돌은 이 단추로 풀 수 없다. 누르면 서버까지 갔다가 실패하고, 그 전에 뜨는 확인창은
  // "먼저 해결해야 합니다"와 "계속할까요?"를 한 화면에서 같이 묻는다. 할 수 없는 일을
  // 물어보지 않는다. 무엇을 해야 하는지는 제목이 말한다.
  const conflicts = (sync && sync.conflicts) || [];
  const nothingToDo = !sync || (!sync.ahead && !sync.behind && !sync.changedFiles);
  el('sync-status').disabled = nothingToDo || conflicts.length > 0;
  el('sync-status').title = conflicts.length
    ? `충돌은 보드에서 풀 수 없습니다. 작업 폴더에서 해결한 뒤 다시 시도하세요.\n${conflicts.join('\n')}`
    : (sync ? `${sync.remoteRef || '원격 없음'} · ${sync.state}` : '');
}
// 편집 중에는 화면을 다시 그리지 않는다. setView가 renderDocument를 거쳐 편집기를 닫으므로
// 폴링이 3초마다 입력 중인 내용을 지워버린다. 스냅샷은 계속 받되 렌더링만 미룬다.
// 두 가드는 성격이 다르다. 문서 편집 중 스냅샷을 갈아끼우면 draft가 기반으로 삼은
// revision까지 최신이 되어 저장이 남의 변경을 조용히 덮어쓴다. 이건 안전 문제라 어떤
// 경로에서도 어기지 않는다. 반면 태스크 변경이 큐에 있는 동안의 폴링은 낙관적 표시를
// 지우는 표시 문제이고, 저장 직후 새 revision을 받는 경로는 오히려 갈아끼워야 한다.
function isDocumentEditing() { return Boolean(blockEditor) || !el('document-editor').hidden; }
function isEditing() { return isDocumentEditing() || state.pendingTasks.size > 0; }
async function loadSnapshot(silent, options) {
  try {
    const next = await api(projectPath('/board-snapshot'));
    // 댓글을 쓰는 중에도 갈아치우지 않는다. 편집기 인스턴스가 다시 그리기에 통째로
    // 버려지므로, 폴링 한 번이 쓰던 글을 지우는 일이 된다.
    if (isDocumentEditing() || isPresentationEditing() || isCommentComposing()) return;
    if (state.pendingTasks.size > 0 && !(options && options.settlingTask)) return;
    const changed = !state.snapshot || JSON.stringify(state.snapshot.revision) !== JSON.stringify(next.revision);
    state.snapshot = next;
    // 저장 직후 경로는 대기열이 남아 있어도 스냅샷을 갈아끼운다. 그러면 아직 보내지 않은
    // 다른 태스크의 낙관적 변경이 서버 값으로 되돌아가고, 그 뒤에 만들어지는 payload는
    // 되돌아간 값을 기준으로 하므로 먼저 누른 변경이 조용히 사라진다. 대기열에 남아 있는
    // 변경을 새 객체에 다시 얹어 화면과 다음 payload가 같은 것을 보게 한다.
    for (const [taskId, pending] of state.pendingTasks) {
      const task = next.tasks.tasks.find((item) => item.id === taskId);
      if (task) Object.assign(task, pending.changes);
    }
    if (changed) { renderNavigation(); populateControls(); updateHealth(); setView(state.view, state.selected); }
    if (!silent) message('Workspace를 새로 읽었습니다.');
  } catch (error) {
    message(error.message, true);
  }
}
async function initialize() { applyTheme(localStorage.getItem('rundol.theme') || 'system'); matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (document.body.classList.contains('theme-system') && state.view === 'document' && state.selected) renderDocument(state.selected); }); const projects = await api('/api/projects'); el('project-switcher').replaceChildren(...projects.map((item) => new Option(item.name || item.key, item.key))); const hash = new URLSearchParams(location.hash.slice(1)); state.project = hash.get('project') || projects[0].key; state.view = hash.get('view') || 'home'; state.taskScope = hash.get('scope') || 'all'; state.selected = hash.get('entity'); el('project-switcher').value = state.project; state.lastVisit = localStorage.getItem(visitKey()); await loadSnapshot(true); startPolling(); }

// 3초 고정 폴링은 탭을 열어만 두어도 하루 종일 스냅샷을 다시 계산하게 만든다.
// 보이지 않을 때는 멈추고, 다시 보일 때 한 번 당겨온다.
const POLL_INTERVAL = 5000;
function startPolling() { stopPolling(); if (document.visibilityState === 'visible') state.polling = setInterval(() => { loadSnapshot(true); if (state.view === 'runs') loadRuns(true); }, POLL_INTERVAL); }
function stopPolling() { if (state.polling) clearInterval(state.polling); state.polling = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { loadSnapshot(true); startPolling(); return; }
  stopPolling();
  markVisit();
});
window.addEventListener('pagehide', markVisit);

document.addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; if (button.dataset.view) { if (button.dataset.view === 'tasks') state.taskScope = 'all'; return setView(button.dataset.view); } if (button.dataset.document) return setView('document', button.dataset.document); if (button.dataset.documentFilter !== undefined) { state.documentFilter = button.dataset.documentFilter; return setView('documents'); } if (button.dataset.documentScope) { state.documentSearchScope = button.dataset.documentScope; return setView('documents'); } if (button.dataset.documentSort) { state.documentSort = button.dataset.documentSort; return setView('documents'); } if (button.dataset.documentApproval) { state.documentApproval = button.dataset.documentApproval; return setView('documents'); } // Plane의 side peek. 목록에서 고른 태스크는 화면을 갈아치우지 않고 Context 패널에 연다.
  // 목록 맥락을 잃지 않고 항목 사이를 옮겨 다닐 수 있다.
  if (button.dataset.person) {
    const [group, id] = button.dataset.person.split(':');
    const entry = (state.snapshot.people[group] || []).find((item) => item.id === id);
    if (!entry) return;
    state.selected = id;
    document.body.classList.remove('context-collapsed');
    document.body.classList.add('peek-open');
    document.body.dataset.peekKind = 'person';
    for (const row of document.querySelectorAll('[data-person]')) row.classList.toggle('peeked', row.dataset.person === button.dataset.person);
    el('context-empty').hidden = true;
    el('context-content').hidden = false;
    el('context-content').innerHTML = personDetailHtml(entry, group);
    return;
  }
  if (button.dataset.task) {
    const peeked = state.snapshot.tasks.tasks.find((item) => item.id === button.dataset.task);
    if (button.dataset.taskFull) return setView('task', button.dataset.task);
    if (peeked && state.view === 'tasks') {
      state.selected = button.dataset.task;
      document.body.classList.remove('context-collapsed');
      document.body.classList.add('peek-open');
      document.body.dataset.peekKind = 'task';
      for (const row of document.querySelectorAll('.task-row')) row.classList.toggle('peeked', row.dataset.task === state.selected);
      return renderContext(peeked, 'task');
    }
    return setView('task', button.dataset.task);
  } });
// 댓글 입력칸의 여닫이. 어느 태스크의, 어느 댓글에 붙는 칸이 열려 있는지는 state가
// 갖는다 — DOM에 두면 5초마다 도는 폴링이 다시 그릴 때 접히고, 쓰던 사람은 자기가
// 무엇을 잘못 눌렀는지 찾게 된다.
let commentEditor = null;
function isCommentComposing() { return Boolean(state.commentComposer); }
// 편집기는 문서 편집과 같은 것을 쓴다. 그림 붙여넣기와 문서 링크가 이미 그 안에 있고,
// 댓글용으로 따로 들이면 같은 그림이 자리마다 다른 규격으로 저장된다.
function mountCommentEditor(form, initial) {
  const host = form.querySelector('[data-comment-editor]');
  const fallback = form.querySelector('[name="body"]');
  if (!host || !window.RundolEditor) {
    // 편집기 번들이 없으면 textarea가 그 자리를 대신한다. 빌드 실패가 논의를 막는
    // 사고가 되면 안 된다.
    if (fallback) { fallback.value = initial || ''; fallback.focus(); }
    return;
  }
  host.hidden = false;
  if (fallback) fallback.hidden = true;
  commentEditor = window.RundolEditor.openEditor(host, initial || '', {
    linkCandidates: linkCandidates(),
    uploadImage,
    onMessage: message
  });
  commentEditor.view.focus();
}
// 다시 그리면 편집기의 DOM은 통째로 버려진다. 열린 칸이 있으면 그 자리에 다시 붙이되
// 쓰던 글은 마크다운으로 받아 옮긴다 — 다시 그렸다는 이유로 사람이 쓴 것을 잃지 않는다.
function mountOpenComposer() {
  const form = document.querySelector('.comment-composer.open[data-comment-form]');
  if (!form) { if (commentEditor) { commentEditor.destroy(); commentEditor = null; } return; }
  if (commentEditor && document.contains(commentEditor.view.dom)) return;
  const kept = commentEditor ? commentEditor.getMarkdown() : '';
  if (commentEditor) { commentEditor.destroy(); commentEditor = null; }
  mountCommentEditor(form, kept);
}
function closeCommentComposer() {
  if (commentEditor) { commentEditor.destroy(); commentEditor = null; }
  state.commentComposer = null;
}
// 쓰는 중에는 화면을 갈아치우지 않는다. 문서 편집이 이미 같은 규칙을 쓴다 — 폴링이
// 다시 그리면 편집기 인스턴스가 통째로 사라지고, 그 안의 글도 같이 사라진다.
function commentBodyOf(form) {
  if (commentEditor) return commentEditor.getMarkdown();
  const field = form.querySelector('[name="body"]');
  return field ? field.value : '';
}
document.addEventListener('click', (event) => {
  const opener = event.target.closest('.comment-composer-open');
  if (opener) {
    const host = opener.closest('[data-comment-form]');
    closeCommentComposer();
    state.commentComposer = { taskId: host.dataset.commentForm, parentId: host.dataset.commentParent || null };
    return redrawTaskDetail();
  }
  const reply = event.target.closest('[data-comment-reply]');
  if (reply) {
    closeCommentComposer();
    state.commentComposer = { taskId: reply.dataset.commentTask, parentId: reply.dataset.commentReply };
    return redrawTaskDetail();
  }
  if (event.target.closest('.comment-composer-cancel')) {
    closeCommentComposer();
    return redrawTaskDetail();
  }
});
// 태스크 상세를 지금 열려 있는 자리에 다시 그린다. peek과 전체화면 중 어디에 있는지는
// 화면이 알고 있으므로, 부르는 쪽이 그것을 따지지 않게 한 곳에서 가른다.
function redrawTaskDetail() {
  if (state.view === 'task' && state.selected) return renderTask(state.selected);
  redrawTaskPeek();
}

// 댓글 제출. 태스크 리비전을 싣지 않는 이유는 append-only라 남의 댓글을 덮을 수
// 없기 때문이다. 리비전을 요구하면 두 사람이 동시에 쓸 때 한 명이 거절당하고,
// 그러면 논의 때문에 논의가 막힌다.
//
// 보내기를 함수로 떼어 둔 이유는 미등록 때문이다. 등록하고 나면 같은 댓글을 다시
// 보내야 하는데, 그때 화면은 이미 새로 그려져 사람이 쓰던 입력칸은 사라진 뒤다.
// 내용은 함수가 인자로 들고 있으므로 다시 쓰게 하지 않는다.
function clearCommentDraft(taskId) {
  for (const form of document.querySelectorAll('[data-comment-form]')) {
    if (form.dataset.commentForm !== taskId) continue;
    const field = form.querySelector('[name="body"]');
    if (field) field.value = '';
  }
}
async function postComment(taskId, body, options) {
  const settings = options || {};
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
      // 답글이 붙을 자리는 요청이 싣는다. 실재하는 댓글인지, 같은 태스크의 것인지는
      // 저장이 판정한다 — 화면이 그 판정을 흉내 내면 두 답이 갈린다.
      body: JSON.stringify({ body, parentId: settings.parentId || undefined })
    });
    // 보낸 댓글은 스냅샷을 다시 읽기 전에 지운다. 다시 그리기는 쓰다 만 초안을 살려
    // 주므로, 순서를 뒤집으면 방금 보낸 글이 입력칸에 그대로 남아 두 번 보내게 된다.
    // 지우는 대상을 화면에서 찾는 이유는 등록 뒤 재시도 때문이다 — 그때 처음 쓰던
    // 입력칸은 이미 사라졌고, 살아 있는 것은 다시 그려진 쪽이다.
    clearCommentDraft(taskId);
    // 입력칸을 먼저 닫는다. 열어 둔 채로 스냅샷을 읽으면 "쓰는 중"으로 보고 갱신을
    // 건너뛰어, 방금 남긴 댓글이 화면에 나타나지 않는다.
    closeCommentComposer();
    await loadSnapshot(true);
    message('댓글을 남겼습니다.');
    return true;
  } catch (error) {
    // 미등록은 내용의 문제가 아니라 신원의 문제다. 화면에서 등록을 받고 쓰던 댓글을
    // 그대로 다시 보낸다. 등록 직후의 재시도는 한 번뿐이다 — 그때도 미등록이면 원인은
    // 다른 데 있고, 되풀이하면 사람은 같은 대화상자만 계속 본다.
    if (error.code === 'unknown-client' && !settings.retried) {
      openClientRegistration('댓글에는 누가 썼는지가 남아야 합니다. 이 기기를 등록하면 쓰던 댓글을 이어서 남깁니다.', () => postComment(taskId, body, { retried: true, parentId: settings.parentId || null }));
      return false;
    }
    message(error.message, true);
    return false;
  }
}
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-comment-form]');
  if (!form) return;
  event.preventDefault();
  const body = String(commentBodyOf(form) || '').trim();
  if (!body) return message('댓글 내용을 입력하세요.', true);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  // 실패하면 쓴 글을 그대로 둔다. 여기서 칸을 닫으면 거절당한 사람이 처음부터 다시 쓴다.
  try { await postComment(form.dataset.commentForm, body, { parentId: form.dataset.commentParent || null }); }
  finally { button.disabled = false; }
});


document.addEventListener('click', (event) => { const button = event.target.closest('[data-task-acceptance]'); if (!button) return; const task = state.snapshot.tasks.tasks.find((item) => item.id === state.selected); if (!task) return; const acceptanceCriteria = JSON.parse(JSON.stringify(task.acceptanceCriteria)); const criterion = acceptanceCriteria[button.dataset.taskAcceptance]; if (!criterion) return; criterion.done = !criterion.done; queueTaskUpdate(task, { acceptanceCriteria }); });
document.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-task-field]');
  if (!input) return;
  const task = state.snapshot.tasks.tasks.find((item) => item.id === state.selected);
  if (!task) return;
  const field = input.dataset.taskField;
  if (field !== 'status') return queueTaskUpdate(task, { [field]: input.value || null });
  const status = input.value;
  if (status === task.status) return;
  // 상태를 벗어날 때 그 상태에만 허용된 부가 정보를 같이 지운다. 남겨두면 저장 시 검증이 막는다.
  const cleared = Object.assign({}, task.blocker ? { blocker: null } : null, task.cancellation ? { cancellation: null } : null);
  if (nodeRequires(status, 'blocker')) {
    const blocker = await requestBlocker(task.blocker);
    if (!blocker) { input.value = task.status; return message('대기 사유를 입력하지 않아 상태를 바꾸지 않았습니다.'); }
    return queueTaskUpdate(task, Object.assign(cleared, { status, blocker }));
  }
  if (nodeRequires(status, 'cancellation')) {
    const cancellation = await requestCancellation(task.cancellation);
    if (!cancellation) { input.value = task.status; return message('반려 사유를 입력하지 않아 상태를 바꾸지 않았습니다.'); }
    return queueTaskUpdate(task, Object.assign(cleared, { status, cancellation }));
  }
  queueTaskUpdate(task, Object.assign(cleared, { status }));
});
el('global-search').addEventListener('input', (event) => { state.query = event.target.value.trim(); if (state.view !== 'documents' && state.view !== 'tasks') setView('documents'); else setView(state.view); });
// 프로젝트를 바꾸면 이전 프로젝트의 것은 무엇도 넘어오지 않아야 한다. 예약된 태스크 저장이
// 남아 있으면 새 프로젝트 경로로 나가고, 열어 둔 패널은 지금 목록에 없는 항목을 계속 보여준다.
el('project-switcher').addEventListener('change', async (event) => {
  markVisit();
  // 방금 누른 변경이 아직 대기열에 있으면 먼저 보낸다. 그냥 버리면 사용자가 눌렀다고
  // 믿는 것이 경고도 없이 사라진다. 보내지 못하면 무엇이 남았는지 알리고 되돌린다.
  const waiting = Array.from(state.pendingTasks.keys());
  for (const taskId of waiting) {
    const pending = state.pendingTasks.get(taskId);
    if (pending) clearTimeout(pending.timer);
    try { await flushTaskUpdate(taskId); } catch { /* 아래에서 남은 것으로 함께 알린다 */ }
  }
  const stranded = Array.from(state.pendingTasks.keys());
  if (stranded.length) {
    for (const [, pending] of state.pendingTasks) clearTimeout(pending.timer);
    state.pendingTasks.clear();
    message(`저장하지 못한 태스크 변경 ${stranded.length}건을 버리고 프로젝트를 바꿉니다: ${stranded.join(', ')}`, true);
  }
  closePeek();
  state.project = event.target.value;
  state.snapshot = null;
  state.selected = null;
  // 펼쳐 둔 승인 자리는 이전 프로젝트의 문서를 가리킨다. 들고 가면 그 문서가 없는
  // 프로젝트에서 적던 사유만 남아 있다가 엉뚱한 대상에 붙는다.
  state.docApproval = null;
  state.lastVisit = localStorage.getItem(visitKey());
  await loadSnapshot(true);
});
el('current-member').addEventListener('change', (event) => { state.currentMember = event.target.value; if (state.currentMember) localStorage.setItem(`rundol.currentMember.${state.project}`, state.currentMember); else localStorage.removeItem(`rundol.currentMember.${state.project}`); if (state.view === 'tasks') renderTasks(); if (state.view === 'home') renderHome(); if (el('settings-member').value !== state.currentMember) el('settings-member').value = state.currentMember; });
el('theme-system').addEventListener('click', () => applyTheme('system')); el('theme-dark').addEventListener('click', () => applyTheme('dark')); el('theme-light').addEventListener('click', () => applyTheme('light'));
for (const button of document.querySelectorAll('[data-task-scope]')) button.addEventListener('click', () => { state.taskScope = button.dataset.taskScope; setView('tasks'); });
// 설정 목차는 한 번에 한 묶음만 연다. 계약·표시 설정은 나중에 주입되므로 클릭 시점에 찾는다.
function showSettingsSection(name) {
  const target = name || 'settings-appearance';
  for (const item of document.querySelectorAll('[data-settings-section]')) item.classList.toggle('active', item.dataset.settingsSection === target);
  for (const panel of document.querySelectorAll('#settings-panels > .settings-panel')) panel.classList.toggle('active', panel.id === target);
  // 흐름도는 열린 뒤에 다시 그린다. 숨은 자리에서 그린 그림은 크기를 0으로 재고, 그렇게
  // 접힌 그림은 열어도 스스로 펴지지 않는다 — mermaid가 이미 처리 표시를 남겼기 때문이다.
  if (target === 'workflow-settings' && state.snapshot && state.snapshot.workflow) renderWorkflowDiagram(state.snapshot.workflow);
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-settings-section]');
  if (button) showSettingsSection(button.dataset.settingsSection);
});
el('refresh').addEventListener('click', () => loadSnapshot(false));
for (const [id, option] of [['owner', 'owner'], ['priority', 'priority'], ['group-by', 'groupBy'], ['task-kind', 'taskKind'], ['task-round', 'taskRound']]) {
  el(id).addEventListener('change', () => {
    setViewOption(option, el(id).value);
    if (id === 'task-kind') { syncRoundField(); setViewOption('taskRound', el('task-round').value); }
    markFilters();
    renderTasks();
  });
}
el('hide-done').addEventListener('change', () => { setViewOption('hideDone', el('hide-done').checked ? '1' : ''); renderTasks(); });
// 묶음 접기. 상태로 묶었을 때 완료는 기본으로 접히고, 사용자가 바꾸면 그 선택이 이긴다.
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-group-toggle]');
  if (!toggle) return;
  const [groupBy, key] = toggle.dataset.groupToggle.split('.');
  setViewOption(`collapse.${groupBy}.${key}`, groupCollapsed(groupBy, key) ? '0' : '1');
  renderTasks();
});

// 더 보기는 그 묶음만 끝까지 편다. 여섯 줄씩 또 나누면 찾는 것을 만날 때까지 몇 번을
// 눌러야 하고, 몇 번 눌렀는지도 남지 않는다. 편 상태는 접기와 같은 곳에 기억해 두어
// 화면을 옮겼다 돌아와도 그대로다.
document.addEventListener('click', (event) => {
  const more = event.target.closest('[data-group-expand]');
  if (!more) return;
  const [groupBy, key] = more.dataset.groupExpand.split('.');
  setViewOption(`expand.${groupBy}.${key}`, '1');
  renderTasks();
});
const taskModes = { list: 'task-list-mode', board: 'task-board-mode', graph: 'task-graph-mode' };
for (const [mode, id] of Object.entries(taskModes)) {
  el(id).addEventListener('click', () => {
    state.taskMode = mode;
    for (const [other, otherId] of Object.entries(taskModes)) el(otherId).classList.toggle('active', other === mode);
    renderTasks();
  });
}
// peek이 본문을 덮으므로 닫는 길이 분명해야 한다. 겹쳐 띄우는 UI의 관례를 따른다.
// 패널을 접는 일과 선택을 푸는 일을 나눈다. 화면 전환은 setView가 이미 선택을
// 정했으므로, 거기서 다시 지우면 방금 연 항목까지 함께 지워진다.
function dismissPeek() {
  document.body.classList.remove('peek-open');
  delete document.body.dataset.peekKind;
  for (const row of document.querySelectorAll('.peeked')) row.classList.remove('peeked');
  el('context-content').hidden = true;
  el('context-empty').hidden = false;
}
function closePeek() {
  if (!document.body.classList.contains('peek-open')) return false;
  dismissPeek();
  state.selected = null;
  return true;
}
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) closePeek(); });
document.addEventListener('pointerdown', (event) => {
  if (!document.body.classList.contains('peek-open')) return;
  if (event.target.closest('.context-panel') || event.target.closest('[data-task]') || event.target.closest('[data-person]')) return;
  closePeek();
});
// 양쪽 패널 모두 사라지지 않고 레일로 좁아지므로, 접기 손잡이가 언제나 제자리에 있다.
// 겹쳐 띄우는 방식이 없으니 화면 폭에 따라 동작이 갈리지도 않는다.
el('collapse-context').addEventListener('click', () => { if (closePeek()) return; document.body.classList.toggle('context-collapsed'); });
// 크게 보기는 peek이 덮고 있는 그 태스크를 전체화면으로 옮긴다.
el('expand-context').addEventListener('click', () => { if (state.selected) setView('task', state.selected); });
el('collapse-nav').addEventListener('click', () => document.body.classList.toggle('nav-collapsed'));
document.addEventListener('click', (event) => { const button = event.target.closest('[data-dialog-cancel]'); if (!button) return; el(button.dataset.dialogCancel).close('cancel'); });
el('blocker-dialog').addEventListener('close', () => resolveBlocker(null));
el('blocker-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const since = el('blocker-since').value;
  const waitingFor = el('blocker-waiting-for').value;
  const condition = el('blocker-condition').value.trim();
  if (!waitingFor || !condition || !since) return message('대기 대상, 해제 조건과 대기 시작 시각을 모두 입력하세요.', true);
  resolveBlocker({ waitingFor, condition, since: new Date(since).toISOString() });
  el('blocker-dialog').close();
});
el('cancellation-dialog').addEventListener('close', () => resolveCancellation(null));
el('cancellation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const reason = el('cancellation-reason').value.trim();
  const decidedBy = el('cancellation-decided-by').value;
  if (!reason || !decidedBy) return message('반려 사유와 결정자를 모두 입력하세요.', true);
  resolveCancellation({ reason, decidedBy, at: new Date().toISOString() });
  el('cancellation-dialog').close();
});
el('task-status').addEventListener('change', async () => {
  if (!nodeRequires(el('task-status').value, 'blocker')) { state.newTaskBlocker = null; return; }
  const blocker = await requestBlocker(state.newTaskBlocker);
  if (blocker) { state.newTaskBlocker = blocker; return; }
  el('task-status').value = defaultStatus();
  state.newTaskBlocker = null;
  message('대기 사유를 입력하지 않아 상태를 할 일로 되돌렸습니다.');
});
// Plane의 quick add. 흔한 경우는 제목 하나뿐인데 모달을 열게 하면 매번 여섯 필드를 지나야 한다.
// 한 줄 추가는 없앴다. 태스크에는 완료조건이 반드시 있어야 하고, 그걸 한 줄에 끼워 넣으면
// 빠르지도 않으면서 대충 적게 만든다. 만드는 길은 다이얼로그 하나로 둔다.
el('new-task').addEventListener('click', () => { el('task-id').textContent = 'NEW TASK'; el('task-title').value = ''; el('task-summary').value = ''; el('task-acceptance').value = ''; el('task-links').value = ''; el('task-status').value = defaultStatus(); state.newTaskBlocker = null; el('task-dialog').showModal(); el('task-title').focus(); });
// ── 편집 시작 ─────────────────────────────────────────────
// 문서 편집 소프트 리스는 ADR-015로 폐기했다. 만료 시각에 기대는 배타는 중앙 권위
// 없이 보장되지 않는데 화면은 그것을 잠금처럼 보여 주었고, 브라우저가 갱신 중 죽으면
// 남은 5분이 남의 저장을 그동안 통째로 잠갔다.
//
// 지금 편집을 지키는 것은 저장 시점의 revision 비교다. 겹치는 작업은 할당 발급
// 시점에 수정 가능 경로로 걸러지므로, 화면이 먼저 잡아 둘 것이 없다.
function renderEditAvailability() {
  el('edit-document').disabled = false;
}
// 블록 편집기가 실려 있으면 그것으로 연다. 번들이 없으면(설치 없이 tarball만 푼
// 경우) 원문 편집기로 물러난다 — 편집을 못 하게 되는 것보다 낫다.
let blockEditor = null;

// 링크 선택기가 쓸 후보. 스냅샷에 이미 있는 것을 모양만 바꾼다.
function linkCandidates() {
  const documents = (state.snapshot.documents || []).map((item) => ({
    id: item.id,
    title: item.title || item.id,
    // Obsidian link 대상은 alias가 아니라 실제 파일명이다.
    target: String(item.file || '').replace(/^.*\//u, '').replace(/\.md$/u, ''),
    alias: item.id,
    kind: 'document'
  })).filter((item) => item.target);
  // 사람은 문서가 아니라 project.md의 block anchor를 가리킨다. 역할과 이해관계자도
  // 같은 방식으로 연결되므로 셋을 함께 넣는다.
  const groups = state.snapshot.people || {};
  const people = [].concat(groups.members || [], groups.roles || [], groups.stakeholders || []).map((person) => ({
    id: person.id,
    title: person.name || person.id,
    target: `project#^${person.id}`,
    alias: person.name || person.id,
    kind: 'member'
  }));
  return documents.concat(people);
}

// 문서 유형이 요구하는 절. 계약은 프로필마다 다르고 자주 바뀌지 않으므로 한 번 읽어 둔다.
// 못 읽으면 빈 목록으로 둔다 — 계약을 몰라도 편집은 되어야 한다.
let contractSectionsByType = null;
async function loadContractSections() {
  if (contractSectionsByType) return contractSectionsByType;
  try {
    const contract = await api(projectPath('/contract'));
    const choices = (contract.catalog && contract.catalog.profileChoices) || [];
    const active = contract.profile && contract.profile.name;
    const chosen = choices.find((choice) => choice.name === active) || choices[0];
    contractSectionsByType = (chosen && chosen.sections) || {};
  } catch (_) {
    contractSectionsByType = {};
  }
  return contractSectionsByType;
}

// 문서 ID의 앞 세 글자가 유형이다. 계약은 그 코드로 절을 갖고 있다.
function sectionsFor(item) {
  const code = String(item.id || '').slice(0, 3).toUpperCase();
  return (contractSectionsByType && contractSectionsByType[code]) || [];
}

// frontmatter는 편집기가 다루지 않는다. 저장 경로가 그 부분을 통째로 보존하기
// 때문인데, 화면이 그 사실을 말하지 않으면 사람은 제목이나 담당을 여기서 고치려
// 하다가 그것이 본문에 글자로 들어간다.
function frontmatterNotice() {
  const notice = document.createElement('p');
  notice.className = 'editor-frontmatter-notice';
  notice.textContent = 'ID·제목·담당·태그 같은 문서 속성은 여기서 고치지 않습니다. 오른쪽 Context에서 확인하세요.';
  return notice;
}

// 저장 전 검사. 서버가 같은 판정으로 답하므로 "저장을 눌러 봐야 아는" 상태가 없어진다.
// 타자마다 부르면 검사가 초당 여러 번 도는데 rdl check는 몇 초가 걸린다. 손이
// 멈춘 뒤에 한 번만 부른다.
let checkTimer = null;
let lastCheckedBody = null;
function scheduleDocumentCheck(item) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => runDocumentCheck(item), 1200);
}
async function runDocumentCheck(item) {
  if (!blockEditor) return;
  const body = blockEditor.getMarkdown();
  if (body === lastCheckedBody) return;
  lastCheckedBody = body;
  try {
    const result = await api(projectPath(`/documents/${encodeURIComponent(item.id)}/check`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
      body: JSON.stringify({ body })
    });
    renderDocumentCheck(result);
  } catch (_) {
    // 검사를 못 불렀다고 편집을 막지는 않는다. 저장 시점에 서버가 다시 본다.
    renderDocumentCheck(null);
  }
}

function renderDocumentCheck(result) {
  const strip = el('document-check');
  if (!strip) return;
  if (!result) { strip.hidden = true; return; }
  const list = result.diagnostics || [];
  strip.hidden = false;
  strip.className = `editor-check ${result.blocking ? 'is-blocking' : (list.length ? 'is-warning' : 'is-clear')}`;
  if (!list.length) { strip.textContent = '검사 통과 — 지금 저장할 수 있습니다.'; return; }
  strip.replaceChildren();
  const head = document.createElement('strong');
  head.textContent = result.blocking ? '저장을 막는 문제가 있습니다' : '저장은 되지만 볼 것이 있습니다';
  strip.append(head);
  for (const item of list.slice(0, 5)) {
    const line = document.createElement('div');
    line.className = `editor-check-line is-${item.severity}`;
    line.textContent = `${item.code}${item.line ? ` (${item.line}줄)` : ''} ${item.message}`;
    strip.append(line);
  }
  if (list.length > 5) {
    const more = document.createElement('div');
    more.className = 'editor-check-line';
    more.textContent = `외 ${list.length - 5}건`;
    strip.append(more);
  }
}

// 편집기가 넘긴 그림을 자산으로 들인다. 검증과 축소는 서버의 rdl asset add가 한다.
async function uploadImage(input) {
  return api(projectPath('/assets'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
    body: JSON.stringify({ name: input.name, data: input.data })
  });
}

function closeBlockEditor() {
  if (!blockEditor) return;
  clearTimeout(checkTimer);
  lastCheckedBody = null;
  const strip = el('document-check');
  if (strip) strip.hidden = true;
  blockEditor.destroy();
  blockEditor = null;
  el('document-editor-surface').replaceChildren();
  el('document-editor-surface').hidden = true;
}

async function enterEditing(item) {
  el('document-body').hidden = true;
  el('edit-document').hidden = true;
  el('cancel-document-edit').hidden = false;
  el('save-document').hidden = false;

  closeBlockEditor();
  if (window.RundolEditor) {
    await loadContractSections();
    el('document-editor').hidden = true;
    el('document-editor-surface').hidden = false;
    el('document-editor-surface').append(frontmatterNotice());
    blockEditor = window.RundolEditor.openEditor(el('document-editor-surface'), item.body, { linkCandidates: linkCandidates(), contractSections: sectionsFor(item), onChange: () => scheduleDocumentCheck(item), uploadImage, onMessage: message });
    blockEditor.view.focus();
    return;
  }
  el('document-editor').value = item.body;
  el('document-editor').hidden = false;
  el('document-editor').focus();
}

// 저장할 본문. 편집기가 열려 있으면 손대지 않은 블록은 원문 조각 그대로 돌아온다.
function editingBody() {
  return blockEditor ? blockEditor.getMarkdown() : el('document-editor').value;
}
el('edit-document').addEventListener('click', async () => {
  const item = state.snapshot.documents.find((value) => value.id === state.selected);
  if (!item) return;
  // 등록되지 않은 Client는 정본을 바꿀 수 없다. 명령줄 문자열을 건네는 대신 이 화면에서
  // 등록을 받고, 끝나면 누르려던 편집을 그대로 이어 준다 — 사람이 하려던 일은 편집이지
  // 등록이 아니다.
  if (!state.snapshot.client.registered) {
    return openClientRegistration('편집한 내용에 누가 고쳤는지가 남아야 합니다. 이 기기를 등록하면 이어서 편집합니다.', async () => {
      // 대상은 새 스냅샷에서 다시 찾는다. 등록 뒤 스냅샷을 다시 읽었으므로 누르기 전의
      // 객체는 낡은 revision을 들고 있고, 그대로 저장하면 바뀐 것이 없는데도 충돌이 난다.
      const fresh = state.snapshot.documents.find((value) => value.id === item.id);
      if (fresh) await enterEditing(fresh);
    });
  }

  await enterEditing(item);
});
el('cancel-document-edit').addEventListener('click', () => { renderDocument(state.selected); });
el('save-document').addEventListener('click', async () => {
  const item = state.snapshot.documents.find((value) => value.id === state.selected);
  if (!item) return;
  const draft = editingBody();
  try {
    const saved = await api(projectPath(`/documents/${encodeURIComponent(item.id)}`), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify({ baseRevision: item.revision, body: draft, clientId: state.snapshot.client && state.snapshot.client.id }) });
    // 저장은 편집의 끝이다. 편집기를 열어둔 채 스냅샷을 불러오면 isEditing() 가드에
    // 걸려 갱신이 통째로 건너뛰어지고, 다음 저장이 오래된 revision으로 나가 409가 난다.
    closeBlockEditor();
    el('document-editor').hidden = true;
    state.rejectedDraft = null;
    await loadSnapshot(true);
    // 동시 편집은 저장 시점의 revision 비교가 잡는다. 어긋나면 409와 함께 최신
    // 내용이 돌아오므로 조용히 덮어쓰이는 경우는 없다.
    message('문서를 저장하고 검증했습니다.');
  } catch (error) {
    // 저장이 거부돼도 편집기 내용은 남긴다. 여기서 지우면 작업이 사라진다.
    el('document-editor').value = draft;
    state.rejectedDraft = { id: item.id, body: draft };
    // 충돌은 다른 거절과 다르다. 내용이 틀린 것이 아니라 바탕이 낡은 것이므로,
    // 사람이 할 일이 "고쳐서 다시 저장"이 아니라 "무엇이 달라졌는지 보고 합치기"다.
    // 그 차이를 말해 주지 않으면 사람은 같은 버튼을 다시 누르고 같은 답을 받는다.
    if (/외부에서 변경/u.test(error.message)) {
      renderDocumentCheck({
        blocking: true,
        diagnostics: [{
          code: '409', severity: 'error', line: null,
          message: '다른 곳에서 이 문서가 바뀌었습니다. 편집 내용은 그대로 두었습니다. 새 창에서 최신 내용을 보고 합친 뒤 저장하세요.'
        }]
      });
      return message('문서가 외부에서 변경되어 저장하지 않았습니다. 편집 내용은 그대로 있습니다.', true);
    }
    message(`${error.message} 편집 내용은 편집기에 그대로 있습니다.`, true);
  }
});
el('task-form').addEventListener('submit', async (event) => { event.preventDefault(); const status = el('task-status').value; if (nodeRequires(status, 'blocker') && !state.newTaskBlocker) return message('대기 상태로 만들려면 대기 사유를 먼저 입력하세요.', true); const lines = el('task-acceptance').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const acceptanceCriteria = Object.fromEntries(lines.map((text, index) => [`AC-${String(index + 1).padStart(3, '0')}`, { text, done: false }])); try { await api(projectPath('/tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify({ title: el('task-title').value, summary: el('task-summary').value, status, priority: el('task-priority').value, owner: el('task-owner').value || null, blocker: nodeRequires(status, 'blocker') ? state.newTaskBlocker : null, links: el('task-links').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), acceptanceCriteria }) }); el('task-dialog').close(); await loadSnapshot(true); message('태스크를 생성했습니다.'); } catch (error) { message(error.message, true); } });
// push는 이 화면에서 가장 되돌리기 어려운 동작이다. 무엇이 나가는지 보여주고 확인받는다.
async function runSync() {
  const sync = state.snapshot.sync;
  const lines = [];
  if (sync.changedFiles) lines.push(`로컬 변경 ${sync.changedFiles}건을 커밋합니다.`);
  if (sync.ahead) lines.push(`커밋 ${sync.ahead}건을 ${sync.remoteRef || '원격'}으로 올립니다.`);
  if (sync.behind) lines.push(`원격의 커밋 ${sync.behind}건을 받습니다.`);
  // 충돌이면 단추가 꺼져 있어 여기까지 오지 않는다. 폴링과 클릭 사이의 틈으로
  // 들어오더라도, 풀 수 없는 일을 두고 계속할지 묻지 않는다.
  if ((sync.conflicts || []).length) return;
  if (!lines.length) return;
  if (!confirm(`${lines.join('\n')}\n\n계속할까요?`)) return;
  try {
    message('동기화를 실행하고 있습니다.');
    await api(projectPath('/sync'), { method: 'POST', headers: { 'X-Rundol-Token': token } });
    await loadSnapshot(true);
    message('동기화를 완료했습니다.');
  } catch (error) {
    // 동기화는 공유 이벤트를 남기므로 실행 주체가 있어야 한다. 미등록이면 그 자리에서
    // 등록을 받는다. 다시 물어보는 확인은 그대로 둔다 — push는 되돌리기 어려운 동작이고,
    // 확인은 등록 때문에 건너뛸 이유가 없다.
    if (error.code === 'unknown-client') return openClientRegistration('동기화 기록에는 누가 올렸는지가 남아야 합니다. 이 기기를 등록하면 이어서 동기화합니다.', () => runSync());
    message(error.message, true);
  }
}
el('sync-status').addEventListener('click', runSync);
// 동기화는 이제 목록에 없다. 헤더의 동기화 버튼이 그 일을 갖는다.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-attention-severity]');
  if (!button) return;
  state.attentionFilter = button.dataset.attentionSeverity;
  renderAttention(state.snapshot.attention);
});
// 검토 인박스의 거르개. 셈은 전건에서 오고 목록은 잘린 것에서 오므로 거르고 나면 두 수가
// 달라진다 — 그 차이를 말하는 자리도 같이 다시 그려야 하므로 화면 전체를 다시 그린다.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-filter]');
  if (!button) return;
  state.reviewFilter = button.dataset.reviewFilter;
  renderReviewInbox();
});
// 승인 자리를 여닫고 비교 축을 고르는 곳. 인박스와 문서 상세가 같은 자리를 쓰므로
// 손잡이도 하나여야 한다 — 화면마다 두면 한쪽만 축을 바꿀 수 있게 되고, 그 차이는
// 승인하러 온 사람이 자기가 무엇을 보고 있는지 헷갈리는 것으로 나타난다.
document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-approve-open]');
  if (opener) return void toggleApproval(opener.dataset.approveOpen);
  const axis = event.target.closest('[data-approve-axis]');
  if (axis && state.docApproval) return void loadApprovalDiff(state.docApproval.id, axis.dataset.approveAxis);
});
// 폼의 값은 DOM이 아니라 state가 갖는다. 차분이 도착하거나 축을 바꾸면 이 자리를 다시
// 그리는데, DOM에 두면 그때마다 적던 사유가 사라진다 — 댓글 칸을 state로 옮긴 것과 같은 이유다.
function rememberApprovalField(event) {
  const field = event.target.closest('[data-approve-field]');
  if (!field || !state.docApproval) return;
  state.docApproval.form[field.dataset.approveField] = field.value;
}
document.addEventListener('input', rememberApprovalField);
document.addEventListener('change', rememberApprovalField);
document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-approve-form]');
  if (!form) return;
  event.preventDefault();
  approveOpenDocument(form.dataset.approveForm);
});
// 조치 필요는 옮겨 갈 화면이 따로 없다. 같은 화면 아래 목록이 그 내역이므로 그리로 데려간다.
document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-focus-attention]')) return;
  // 목록은 홈 화면 안에 있다. 다른 화면에서 눌렀다면 먼저 홈으로 옮겨야 스크롤이 먹는다.
  if (state.view !== 'home') setView('home');
  const list = el('attention-list');
  list.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const first = list.querySelector('.attention-item');
  if (first) first.focus();
});
// 보기 기준은 설정에도 두되 헤더의 것과 값을 공유한다.
el('settings-member').addEventListener('change', (event) => { el('current-member').value = event.target.value; el('current-member').dispatchEvent(new Event('change')); });
el('reset-view-options').addEventListener('click', () => { resetViewOptions(); populateControls(); setView(state.view, state.selected); message('이 프로젝트의 표시 설정을 초기값으로 되돌렸습니다.'); });
function ensureContractSettings() {
  if (el('contract-settings')) return;
  el('settings-panels').insertAdjacentHTML('beforeend', `<section id="contract-settings" class="settings-panel contract-settings"><header class="section-heading"><div><h2>문서 계획 계약</h2><p id="contract-summary"></p></div><div class="page-actions"><button id="save-preset" hidden>프리셋으로 저장</button><button id="save-contract" class="primary">계약 저장</button></div></header><div class="form-grid"><label>프로필<select id="contract-profile"></select><small id="contract-profile-hint" class="control-hint"></small></label><label>강제 수준<select id="contract-enforcement"></select><small id="contract-enforcement-hint" class="control-hint"></small></label></div><p id="implementation-contract-summary" class="control-hint"></p><div id="contract-rules" class="contract-table" aria-label="문서 계약 규칙"></div></section>`);
}
function contractComponent(value) { return `<span class="component-chip" data-contract-section="${escapeHtml(value)}"><span>${escapeHtml(value)}</span><button type="button" data-component-remove aria-label="${escapeHtml(value)} 제거">${CLOSE_ICON}</button></span>`; }
function setSuggestionState(row, value, selected) {
  for (const suggestion of row.querySelectorAll('[data-component-suggestion]')) if (suggestion.dataset.componentSuggestion === value) suggestion.disabled = selected;
}
function addContractComponent(row, value) {
  const component = String(value || '').trim();
  if (!component) return false;
  const values = Array.from(row.querySelectorAll('[data-contract-section]')).map((item) => item.dataset.contractSection);
  if (values.includes(component)) return false;
  row.querySelector('[data-contract-components]').insertAdjacentHTML('beforeend', contractComponent(component));
  setSuggestionState(row, component, true);
  return true;
}
function syncContractRow(row) {
  const status = row.querySelector('[data-contract-status]');
  const disabled = status.value === 'disabled';
  // 만들지 않는 유형에는 하부 요소를 물을 이유가 없다.
  const sections = row.querySelector('[data-contract-sections]');
  if (sections) { sections.hidden = disabled; for (const control of sections.querySelectorAll('input,button')) control.disabled = disabled; }
  // 상태를 바꾸면 그 상태가 무슨 뜻인지도 따라가야 한다. 고정된 설명은 곧 거짓말이 된다.
  const hint = status.closest('label').querySelector('.control-hint');
  if (hint) hint.textContent = presentationHint('policyStates', status.value);
}
// 프리셋을 고르면 그 프리셋이 무엇인지 아래에서 바로 보여야 한다. 지금까지는 선택만
// 바뀌고 정책 상태는 그대로라, 무엇이 달라지는지 저장해 봐야 알 수 있었다. 화면에서
// 미리 칠하고 실제 반영은 계약 저장에서 한다.
function profileChoice(name) { return (state.profileChoices || []).find((item) => item.name === name) || null; }
// 지금 고른 프리셋이 정한 하부 요소. 프로필을 바꾸면 이 목록도 함께 따라온다.
function currentPresetSections() {
  const chosen = profileChoice(el('contract-profile') && el('contract-profile').value);
  return (chosen && chosen.sections) || {};
}
function currentPolicyFromRows() {
  const policy = { required: [], recommended: [], onDemand: [], disabled: [] };
  for (const row of document.querySelectorAll('[data-contract-type]')) {
    const status = row.querySelector('[data-contract-status]').value;
    if (policy[status]) policy[status].push(row.dataset.contractType);
  }
  return policy;
}
function currentSectionsFromRows() {
  const sections = {};
  for (const row of document.querySelectorAll('[data-contract-type]')) {
    sections[row.dataset.contractType] = Array.from(row.querySelectorAll('[data-contract-section]')).map((item) => item.dataset.contractSection);
  }
  return sections;
}
// 이 범위에서 덮은 값만 보낸다. 합쳐진 결과를 통째로 보내면 위에서 내려온 값까지
// 이 범위 파일에 박혀, 나중에 상위 기본값이 나아져도 반영되지 않는다.
//
// patch의 null은 "이 범위에서 그 항목을 지운다"는 뜻이다. Object.assign으로는 지움을
// 표현할 수 없어 표식을 하나 두고 여기서 걷어낸다 — 표식이 없으면 되돌리기가 "빈
// 객체로 덮기"가 되는데, 빈 객체는 상속이 아니라 이 범위가 항목을 선언했다는 뜻이라
// 되돌린 다음에도 이 파일이 그 항목을 계속 붙들고 있게 된다.
function presentationInput(scope, patch) {
  const sources = (state.snapshot.presentation && state.snapshot.presentation.sources) || {};
  const own = sources[scope] || {};
  const next = { scope, baseRevision: state.snapshot.revision.presentation };
  for (const group of Object.keys(PRESENTATION_GROUP_LABELS)) {
    const merged = Object.assign({}, own[group], (patch && patch[group]) || {});
    for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
    next[group] = merged;
  }
  return next;
}
function samePolicy(left, right) {
  return ['required', 'recommended', 'onDemand', 'disabled']
    .every((state_) => JSON.stringify((left[state_] || []).slice().sort()) === JSON.stringify((right[state_] || []).slice().sort()));
}
function applyProfilePreset(name) {
  const choice = profileChoice(name);
  if (!choice || !choice.policy) return false;
  for (const row of document.querySelectorAll('[data-contract-type]')) {
    const type = row.dataset.contractType;
    const next = ['required', 'recommended', 'onDemand', 'disabled'].find((key) => (choice.policy[key] || []).includes(type)) || 'onDemand';
    row.querySelector('[data-contract-status]').value = next;
    syncContractRow(row);
  }
  return true;
}
// 행을 직접 손대면 더 이상 어느 프리셋과도 같지 않다. 그때는 프리셋 이름을 그대로 두어
// 사용자가 고르지 않은 구성이 그 이름으로 저장되게 두지 않고, 이름을 붙일 길을 연다.
function refreshProfileState() {
  const selected = el('contract-profile').value;
  const choice = profileChoice(selected);
  const rows = currentPolicyFromRows();
  // 정책만 비교하면 하부 요소를 고쳐도 프리셋과 같다고 보아 저장할 길이 열리지 않는다.
  // 프리셋이 정하는 것은 정책과 하부 요소 둘이므로 둘 다 봐야 한다.
  const matches = Boolean(choice && choice.policy && samePolicy(choice.policy, rows)
    && JSON.stringify(choice.sections || {}) === JSON.stringify(currentSectionsFromRows()));
  const hint = el('contract-profile-hint');
  const save = el('save-preset');
  if (!document.querySelector('[data-contract-type]')) return;
  hint.textContent = matches
    ? (choice && choice.description) || presentationHint('profiles', selected)
    : `${(choice && choice.label) || selected}와 달라진 구성입니다. 이대로 계약을 저장하면 이 프로젝트에만 적용되고, 다시 쓰려면 프리셋으로 이름을 붙이세요.`;
  hint.classList.toggle('diverged', !matches);
  if (save) save.hidden = matches || !choice;
}
function renderContractSettings() {
  ensureContractSettings();
  const contract = state.snapshot.contract;
  if (!contract || !contract.profile) { el('contract-summary').textContent = contract ? contract.status : 'legacy-unconfigured'; el('implementation-contract-summary').textContent = ''; el('contract-rules').innerHTML = ''; return; }
  const profile = contract.profile;
  const catalog = contract.catalog;
  // 선택지의 value는 계약에 저장되는 값이고 보이는 글자는 표시 규칙이 정한다. 예전에는
  // 선택지에 value 없이 프로필 이름만 적어 표시값이 곧 저장값이었고, 표기를 바꾸면
  // 계약이 깨졌다. 이제 value는 고정이고 label만 설정을 따라간다.
  // 고를 수 있는 프로필은 내장 다섯 개가 아니라 board.json 상속이 정한 목록이다.
  // 팀이 만든 프리셋은 라벨과 설명을 함께 들고 온다.
  const choices = catalog.profileChoices || catalog.profiles.map((name) => ({ name, label: presentationLabel('profiles', name, name), description: '' }));
  state.profileChoices = choices;
  el('contract-profile').replaceChildren(...choices.map((item) => new Option(item.label || presentationLabel('profiles', item.name, item.name), item.name)));
  el('contract-enforcement').replaceChildren(...catalog.enforcements.map((name) => new Option(enforcementLabel(name), name)));
  el('contract-profile').value = profile.name;
  el('contract-enforcement').value = profile.enforcement;
  el('contract-enforcement-hint').textContent = presentationHint('enforcementLevels', profile.enforcement);
  el('contract-summary').textContent = `${contract.status} · revision ${profile.revision} · 위반 ${contract.evaluation.violations.length}건`;
  const trace = contract.traceability && contract.traceability.summary;
  el('implementation-contract-summary').textContent = `${catalog.implementation.version} · 기능별 독립 명세(묶음 금지) · 계산된 추적성 ${trace ? `${trace.ready}/${trace.functions} 준비` : '0/0 준비'} · 별도 인덱스 없음`;
  el('contract-rules').innerHTML = catalog.documentTypes.map((type) => {
    const status = Object.keys(profile.policy).find((key) => profile.policy[key].includes(type));
    // 하부 요소는 프리셋이 갖는다. 흡수 시절에는 "사용 안 함"인 유형에만 붙어 있었는데,
    // 정작 필요한 곳은 실제로 만드는 유형이다. 이 유형의 문서를 쓸 때 무엇을 채워야
    // 하는지가 프리셋의 일부이고, 프로필을 바꾸면 이 목록도 함께 따라온다.
    const sections = (currentPresetSections()[type] || []).slice();
    const suggestions = catalog.sections[type].filter((value) => !sections.includes(value))
      .map((value) => `<button type="button" class="suggestion-chip" data-component-suggestion="${escapeHtml(value)}">+ ${escapeHtml(value)}</button>`).join('');
    return `<article class="contract-row" data-contract-type="${type}"><header><strong>${type}</strong><label>정책 상태<select data-contract-status aria-label="${type} 정책 상태">${catalog.policyStates.map((value) => `<option value="${value}" ${status === value ? 'selected' : ''}>${escapeHtml(policyStateLabel(value))}</option>`).join('')}</select><small class="control-hint">${escapeHtml(presentationHint('policyStates', status))}</small></label></header><section class="contract-components" data-contract-sections aria-label="${type} 하부 요소"${status === 'disabled' ? ' hidden' : ''}><strong>하부 요소</strong><div class="component-list" data-contract-components>${sections.map(contractComponent).join('')}</div><div class="component-add"><input data-component-input aria-label="${type} 하부 요소 직접 추가" placeholder="하부 요소 직접 추가"><button type="button" data-component-add>추가</button></div>${suggestions ? `<div class="component-suggestions"><small>이 프로젝트 문서에서 발견된 것</small><div>${suggestions}</div></div>` : ''}</section></article>`;
  }).join('');
  for (const row of document.querySelectorAll('[data-contract-type]')) syncContractRow(row);
  refreshProfileState();
}
// 표시 그룹은 일곱인데 화면은 문서 유형 하나만 그리고 있었다. 나머지 여섯은
// board.json에 정의가 있는데도 파일을 직접 열어야만 보였다 — 정의가 있는 것과
// 보이는 것은 다르다.
const PRESENTATION_GROUP_LABELS = {
  documentTypes: '문서 유형',
  documentStates: '문서 상태',
  policyStates: '정책 상태',
  enforcementLevels: '강제 수준',
  taskStatuses: '태스크 상태',
  priorities: '우선순위',
  profiles: '프로필'
};
// 출처는 로더가 계산해 스냅샷에 실어 준다. 화면이 다시 판정하면 같은 질문에
// 두 답이 생기고, 둘이 갈라지는 날 어느 쪽이 맞는지 알 수 없다. 스냅샷에 없으면
// 내장으로 읽는다 — 옛 스냅샷을 만난 화면이 빈 값을 그리지 않게.
function presentationOrigin(origins, group, key) {
  const entry = origins && origins[group] && origins[group][key];
  return (entry && entry.entry) || 'builtin';
}
const ORIGIN_LABELS = { builtin: '내장', workspace: 'Workspace', project: '이 프로젝트' };
// 채움 개수가 계층이다. 색만으로 구분하면 흑백 인쇄와 색각 차이에서 정보가 사라진다.
function originIndicator(origin) {
  const filled = { builtin: 1, workspace: 2, project: 3 }[origin];
  const cells = [1, 2, 3].map((step) => `<i class="${step <= filled ? 'on' : ''}"></i>`).join('');
  return `<span class="origin origin-${origin}" title="${escapeHtml(ORIGIN_LABELS[origin])}에서 온 값"><span class="origin-bars">${cells}</span><span class="origin-label">${escapeHtml(ORIGIN_LABELS[origin])}</span></span>`;
}
// 되돌릴 수 없는 관문은 설정이 아니다. 잠긴 항목으로 두면 언젠가 잠금을 푸는
// 요청을 부르므로 목록에 넣지 않고, 대신 왜 없는지만 읽기 전용으로 남긴다.
const BOUNDARY_ITEMS = [
  ['패키지 배포와 릴리스 태그', '되돌릴 수 없고 이 머신을 벗어난다'],
  ['병합 요청 병합', '되돌릴 수 없고 공유 상태를 바꾼다'],
  ['게이트 우회', '게이트를 끌 수 있으면 게이트가 아니다'],
  ['정지하지 않은 런의 강제 인수', '다른 주체의 권한을 덮는다'],
  ['소유권과 연산의 강제 해소', '다른 주체의 권한을 덮는다'],
  ['위임 부여', '권한을 넘기는 행위는 위임으로 넘길 수 없다'],
  ['사람 게이트 제거', '하위 계층은 조일 수만 있다'],
  ['승인의 리비전 결박 해제', '풀면 지난 승인이 다른 내용에 붙는다']
];
// 승인 모드. 사람 게이트를 어디에 둘지가 처리량을 정한다 — 촘촘하게 깔면 사람은
// 게이트를 읽지 않고 누르기 시작하고, 그 순간 통제도 함께 사라진다. 그래서 이 화면은
// 신뢰의 눈금이 아니라 주의의 배분표로 읽혀야 한다.
const APPROVAL_MODE_LABELS = {
  'human-only': '사람만',
  'ai-assisted': 'AI 혼합',
  'ai-first': 'AI 우선',
  'ai-only': 'AI만'
};
const APPROVAL_BASIS_LABELS = { read: '읽음', check: '검사', verdict: '판정', delegated: '위임됨' };

// 업무 유형. 유형 하나가 필드·규칙·화면을 함께 끌고 오므로, 이 화면이 보여줄 것은
// 이름 목록이 아니라 "이 유형이 무엇을 요구하는가"다.
const CONSTRAINT_LABELS = {
  fields: '필드와 허용값',
  requiresLink: '문서 연결 요구',
  requiredWhen: '조건부 필수',
  unique: '조합 유일성',
  exempt: '게이트 면제'
};
const GATE_LABELS = {
  'implementation-readiness': '구현 준비도',
  'done-requires-test-link': '완료 시 검증 문서 연결'
};

// 제약 값을 사람이 읽는 말로. 원본 JSON을 그대로 보이면 무엇을 뜻하는지 읽는 사람이
// 매번 해석해야 하고, 해석이 필요한 화면은 결국 파일을 여는 것과 다르지 않다.
function describeConstraint(kind, value) {
  if (kind === 'fields') {
    return Object.entries(value || {}).map(([name, spec]) => {
      if (spec && Array.isArray(spec.values)) return `${name}: ${spec.values.join(' · ')}`;
      if (spec && spec.type === 'integer') return `${name}: 정수${spec.min === undefined ? '' : ` ${spec.min} 이상`}`;
      return name;
    });
  }
  if (kind === 'requiresLink') {
    return Object.entries(value || {}).map(([type, range]) => {
      const min = range && range.min;
      const max = range && range.max;
      if (min !== undefined && min === max) return `${type} 정확히 ${min}개`;
      if (max === undefined) return `${type} 최소 ${min}개`;
      return `${type} ${min}~${max}개`;
    });
  }
  if (kind === 'requiredWhen') {
    return Object.entries(value || {}).map(([field, when]) => {
      const values = when && Array.isArray(when.is) ? when.is.join(' 또는 ') : '';
      return `${when && when.field}이(가) ${values}이면 ${field} 필요`;
    });
  }
  if (kind === 'unique') {
    const parts = [].concat(value && value.links || [], value && value.fields || []);
    const released = value && value.releasedBy;
    const base = `[${parts.join(', ')}] 조합이 유일`;
    return [released && released.length ? `${base} — ${released.join(', ')} 상태는 자리를 놓아줌` : base];
  }
  if (kind === 'exempt') return (value || []).map((gate) => GATE_LABELS[gate] || gate);
  return [JSON.stringify(value)];
}

function renderItemTypeSettings() {
  if (!el('item-type-settings')) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="item-type-settings" class="settings-panel"><header><h2>업무 유형</h2><p>유형 하나가 필드와 규칙과 화면을 함께 끌고 옵니다. 규칙은 코드가 가진 다섯 가지 제약 종류에 값을 채우는 방식이라, 새 유형을 만드는 데 코드 변경이 필요하지 않습니다. 유형 정의는 표시가 아니라 정책이라 이 화면에서 바꾸지 않습니다 — 정책 층 변경은 계약 변경 결정을 함께 남겨야 저장되고, Board에는 아직 그 결정을 남길 자리가 없습니다. 지금은 <code>board.json</code>의 <code>itemTypes</code>를 고치고 <code>rdl save</code>로 남깁니다.</p></header><div class="settings-body"><div id="item-type-list"></div><div id="item-type-derived"></div></div></section>');
  }
  const snapshot = state.snapshot;
  const types = (snapshot.presentation && snapshot.presentation.itemTypes) || null;
  const catalog = snapshot.itemTypeCatalog;
  if (!types || !catalog) {
    el('item-type-list').innerHTML = '<p class="empty-state">이 Board 서버는 업무 유형을 아직 싣지 않습니다. 서버를 다시 시작하세요.</p>';
    el('item-type-derived').innerHTML = '';
    return;
  }
  const origins = snapshot.presentation.origins || {};

  el('item-type-list').innerHTML = Object.keys(types).sort().map((id) => {
    const entry = types[id] || {};
    const constraints = entry.constraints || {};
    const kinds = catalog.kinds.filter((kind) => constraints[kind] !== undefined);
    const origin = presentationOrigin(origins, 'itemTypes', id);
    const rows = kinds.length
      ? kinds.map((kind) => `<div class="presentation-row"><div class="presentation-row-main"><strong>${escapeHtml(CONSTRAINT_LABELS[kind] || kind)}</strong><small><code>${escapeHtml(kind)}</code> · ${describeConstraint(kind, constraints[kind]).map(escapeHtml).join(' / ')}</small></div></div>`).join('')
      : '<div class="presentation-row"><div class="presentation-row-main"><small>제약 없음 — 기본 유형입니다.</small></div></div>';
    return `<section class="presentation-group"><h3>${escapeHtml(entry.label || id)}<span class="group-count"><code>${escapeHtml(id)}</code> · 제약 ${kinds.length}종${entry.disabled ? ' · 사용 안 함' : ''}</span></h3>`
      + `<div class="presentation-rows">${rows}</div>`
      + `<div class="item-type-origin">${originIndicator(origin)}</div></section>`;
  }).join('');

  // 유형 추가로 무엇이 따라오고 무엇이 안 따라오는지 함께 적는다. 이 선을 긋지 않으면
  // "유형만 추가하면 다 된다"는 기대가 생기고, 기대가 깨지는 지점이 매번 다르게 나타난다.
  el('item-type-derived').innerHTML = '<h3 class="approval-heading">유형을 더하면 따라오는 것</h3>'
    + `<p class="approval-note">제약 다섯 종류(<code>${catalog.kinds.join('</code>, <code>')}</code>)로 규칙을 적으면 검사가 그대로 판정합니다. 면제할 수 있는 게이트는 <code>${catalog.exemptable.join('</code>, <code>')}</code>뿐이며, 되돌릴 수 없는 관문은 목록에 없습니다 — 유형 추가가 경계 우회 수단이 되면 안 되기 때문입니다.</p>`
    + '<div class="split-note"><div class="note-block"><h4>자동으로 생깁니다</h4><ul><li>목록의 유형 필터</li><li>선언한 필드의 입력 칸</li><li>연결 요구에 맞는 문서 선택기</li><li>조건부 필수 안내</li></ul></div>'
    + '<div class="note-block absent"><h4>생기지 않습니다</h4><ul><li>유형 전용 집계 화면</li><li>유형의 의미를 알아야 만들 수 있는 통계</li></ul></div></div>';
}

// ── 워크플로 ────────────────────────────────────────────────────────────
//
// 노드 이름과 전환은 프로젝트가 workflows.json에 정의하는 값이고, 코드가 보는 것은 그
// 이름이 매핑된 스텝뿐이다. 그래서 이 패널은 자기 목록을 하나도 갖지 않는다 — 스냅숏의
// workflow가 정본이고, 거기 없는 것은 여기서도 없다. 사본을 두면 설정을 고쳐도 화면은
// 그대로이던 버그가 그 자리에 다시 선다. 종료 상태 사본을 걷어내면서 어휘 시험의 면제
// 목록에서 이름까지 지운 것이 그 규율이다.
//
// 업무 유형 패널과 같은 조각으로 그린다 — 같은 물음("이 값이 어느 층에서 왔는가")에 두
// 벌의 그림이 생기면 언젠가 한 벌만 고쳐진다.
const STEP_LABELS = { unclaimed: '안 잡음', 'in-progress': '진행 중', 'in-approval': '승인 대기', completed: '완료', dropped: '취소' };
const COMPLETION_VALIDITY_LABELS = { valid: '유효', retired: '폐기' };
// 슬롯 이름과 실행 단위 종류는 닫힌 어휘다. 라벨만 들고 목록은 들지 않는다 — 라벨 없는
// 이름은 받은 그대로 보이고, 그 편이 안 보이는 것보다 낫다.
const TRANSITION_SLOT_LABELS = { validation: '검증', input: '입력', execution: '수행' };
const UNIT_KIND_LABELS = { gate: '게이트', client: 'Client', cli: '명령', adapter: '어댑터', human: '사람' };
const NODE_FIELD_LABELS = { blocker: '대기 사유', cancellation: '취소 결정' };

// 어느 칸이 슬롯인지를 목록으로 적지 않고 값의 모양으로 가른다. 슬롯은 실행 단위 이름의
// 목록으로 실려 오고 나머지 칸은 문자열이거나 참·거짓이다. 목록을 적어 두면 어휘가
// 슬롯을 늘린 날 그 칸만 조용히 안 보인다.
function transitionSlots(transition) {
  return Object.keys(transition).filter((key) => Array.isArray(transition[key]) && transition[key].length > 0);
}

// 실행 단위 하나를 사람이 읽는 말로. 스냅숏이 이름과 함께 종류를 실어 주므로 화면이
// 이름만 보고 무엇인지 추측하지 않는다.
function executionUnitText(view, name) {
  const unit = (view.executionUnits || {})[name] || null;
  if (!unit) return `${name} · 선언되지 않은 단위`;
  return `${unit.label || name} · ${UNIT_KIND_LABELS[unit.kind] || unit.kind}`;
}

// 전환의 출발과 도착을 이름으로. 이 흐름의 노드가 아니면 받은 값을 그대로 보이고 그
// 사실을 곁에 적는다 — 출발을 적지 않은 전환이 그렇게 실려 오며, 그 표기를 화면이 알고
// 있으면 표기가 바뀌는 날 화면만 옛 이름을 들고 남는다.
function workflowNodeText(view, node) {
  const key = node === null || node === undefined ? '' : String(node);
  const entry = view.nodes[key];
  if (entry) return `<b>${escapeHtml(entry.label || taskStatusLabel(key))}</b> <code>${escapeHtml(key)}</code>`;
  return `<b>${escapeHtml(key)}</b> <small>출발을 적지 않은 전환</small>`;
}

// 스텝이 어느 갈래인가. 갈래 목록도 스냅숏이 실어 준 것을 쓴다 — 화면이 "끝난 스텝은 이
// 둘"이라고 적으면 그 둘이 바뀌는 날 화면만 옛 답을 들고 남는다.
function workflowStepNote(view, step) {
  if ((view.terminalSteps || []).indexOf(step) >= 0) return '끝난 스텝 — 더 손대지 않습니다';
  if ((view.activeSteps || []).indexOf(step) >= 0) return '누군가 붙어 있는 스텝입니다';
  if ((view.openSteps || []).indexOf(step) >= 0) return '열려 있고 아직 아무도 안 잡았습니다';
  return '스냅숏이 이 스텝을 어느 갈래로도 세지 않았습니다';
}

// 앞서 세운 종이를 걷는 함수. 다시 그릴 때 안 걷으면 같은 자리에 한 장씩 쌓인다.
let workflowGraphTeardown = null;

function renderWorkflowDiagram(view) {
  const host = el('workflow-diagram');
  if (!host) return;
  const note = '<h3 class="approval-heading">흐름도</h3>'
    + '<p class="approval-note">노드를 끌어 옮기고 화살표 끝을 다른 노드에 다시 붙일 수 있습니다. 화살표에 붙은 말은 전환의 이름이고, 사람 승인이 걸린 전환과 런을 여는 전환은 그 사실을 함께 답니다. 이 그림은 목록과 같은 값에서 나오므로 둘이 갈리지 않습니다.</p>'
    + '<p class="approval-note" id="workflow-graph-dirty" hidden><b>고친 것은 아직 저장되지 않습니다.</b> 정책 층 변경은 계약 변경 결정을 함께 남겨야 저장되고, Board에는 아직 그 결정을 올릴 자리가 없습니다 — 지금은 <code>workflows.json</code>을 고치고 <code>rdl save</code>로 남깁니다.</p>';
  if (!view.transitions) {
    host.innerHTML = note + '<p class="empty-state">이 흐름은 전환을 선언하지 않았습니다. 그릴 화살표가 없으므로 그림 대신 노드 목록이 답합니다 — 선언하지 않은 흐름은 어느 노드에서 어느 노드로든 갑니다.</p>';
    return;
  }
  if (!view.transitions.length) {
    host.innerHTML = note + '<p class="empty-state">전환 목록이 비어 있습니다. 빈 목록도 선언이라 같은 노드에 머무는 것 말고는 전부 막히며, 막힌 흐름은 그릴 화살표가 없습니다.</p>';
    return;
  }
  host.innerHTML = note + '<div id="workflow-graph" class="workflow-graph"></div>';
  // 앞의 종이를 걷는다. 안 걷으면 다시 그릴 때마다 같은 자리에 한 장씩 쌓인다.
  if (workflowGraphTeardown) { workflowGraphTeardown(); workflowGraphTeardown = null; }
  if (!window.RundolWorkflowGraph) {
    el('workflow-graph').innerHTML = '<p class="empty-state">흐름도 번들이 없습니다. <code>npm install</code> 뒤 다시 시작하세요.</p>';
    return;
  }
  // 화면에 올라온 뒤에 그린다. 숨은 자리에서는 종이의 폭이 0이라 그림이 접히고, 접힌
  // 그림은 도형이 다 있는 채로 크기만 잃어 아무 오류도 내지 않는다 — mermaid로 그리던
  // 때 이 자리가 16×16으로 접혀 있었고 열어 보기 전에는 드러나지 않았다.
  if (host.getBoundingClientRect().width === 0) return;
  try {
    workflowGraphTeardown = window.RundolWorkflowGraph.mount(el('workflow-graph'), view, {
      onDirty: () => { const mark = el('workflow-graph-dirty'); if (mark) mark.hidden = false; }
    });
  } catch (error) {
    el('workflow-graph').innerHTML = `<p class="empty-state">흐름도를 그리지 못했습니다: ${escapeHtml(error.message)}</p>`;
  }
}

function renderWorkflowSettings() {
  if (!el('workflow-settings')) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="workflow-settings" class="settings-panel"><header><h2>워크플로</h2><p>노드와 전환이 <b>무엇이 허용되는지</b>를 정합니다. 상태 이름은 이 프로젝트가 정의하는 값이고, 코드가 보는 것은 그 이름이 매핑된 스텝뿐입니다. 흐름 정의는 표시가 아니라 정책이라 이 화면에서 바꾸지 않습니다 — 정책 층 변경은 계약 변경 결정을 함께 남겨야 저장되고, Board에는 아직 그 결정을 남길 자리가 없습니다. 지금은 <code>workflows.json</code>을 고치고 <code>rdl save</code>로 남깁니다.</p></header><div class="settings-body"><div id="workflow-current" class="presentation-source"></div><div id="workflow-diagram"></div><div id="workflow-nodes"></div><div id="workflow-transitions"></div><div id="workflow-layers"></div><div id="workflow-scope"></div></div></section>');
  }
  // workflowView()를 쓰지 않는다. 그쪽은 못 받았을 때 빈 워크플로를 돌려주어 부르는
  // 쪽이 판정을 이어가게 하는 자리이고, 여기서 필요한 것은 그 반대다 — "안 실렸다"와
  // "실렸는데 비었다"가 같아 보이면 화면은 옛 서버를 흐름 없는 프로젝트로 그린다.
  const view = state.snapshot.workflow;
  if (!view || !view.nodes) {
    // 빈 화면 대신 무엇이 없는지 말한다. 빈 화면은 흐름이 없다는 뜻으로 읽힌다.
    el('workflow-current').innerHTML = '<p class="empty-state">이 Board 서버는 워크플로를 아직 싣지 않습니다. 서버를 다시 시작하세요.</p>';
    for (const host of ['workflow-diagram', 'workflow-nodes', 'workflow-transitions', 'workflow-layers', 'workflow-scope']) el(host).innerHTML = '';
    return;
  }

  const current = [
    `<div class="property"><dt>흐름</dt><dd><strong>${escapeHtml(view.label || view.id || '내장 흐름')}</strong><small>${view.id ? `<code>${escapeHtml(view.id)}</code> · 이 프로젝트의 기본 배정입니다.` : '설정이 이 대상 종류를 잡지 않아 내장 흐름이 섭니다.'}</small></dd></div>`,
    `<div class="property"><dt>정의한 층</dt><dd>${originIndicator(view.origin || 'builtin')}<small>흐름을 마지막으로 적은 층입니다.</small></dd></div>`,
    `<div class="property"><dt>대상 종류</dt><dd><strong>${escapeHtml(view.targetKind || '알 수 없음')}</strong><small>이 흐름이 붙는 마스터입니다. 보드가 그리는 판은 태스크입니다.</small></dd></div>`
  ];
  // 내장으로 떨어졌다는 사실을 값으로 싣는 이유가 이 줄이다. 조용히 물러서면 화면은
  // 자기가 무엇을 보고 있는지 모른 채 그린다.
  if (view.error) current.push(`<div class="property"><dt>설정 오류</dt><dd><strong class="workflow-error">내장 흐름으로 물러섰습니다</strong><small>${escapeHtml(view.error)}</small></dd></div>`);
  el('workflow-current').innerHTML = current.join('');

  renderWorkflowDiagram(view);

  const nodeEntries = Object.entries(view.nodes);
  const placed = new Set();
  const groups = (view.steps || []).map((step) => {
    const nodes = nodeEntries.filter((entry) => entry[1].step === step);
    for (const entry of nodes) placed.add(entry[0]);
    return { key: step, label: STEP_LABELS[step] || step, note: workflowStepNote(view, step), nodes };
  });
  // 어느 스텝에도 안 걸린 노드는 따로 세운다. 안 보이면 그 노드에 앉은 태스크가 어느
  // 칸에도 서지 않는데 화면은 아무 신호도 내지 않는다.
  const stray = nodeEntries.filter((entry) => !placed.has(entry[0]));
  if (stray.length) groups.push({ key: null, label: '스텝이 없는 노드', note: '코드가 이 노드를 어느 칸으로도 세지 못합니다', nodes: stray });

  el('workflow-nodes').innerHTML = '<h3 class="approval-heading">노드와 그 노드가 선 스텝</h3>'
    + '<p class="approval-note">이름은 이 프로젝트의 것이고 스텝은 코드의 것입니다. 스텝은 닫힌 어휘라 프로젝트가 늘리지 못하며, 늘리는 것은 이름 쪽입니다 — 이름 하나하나가 이 다섯 중 하나에 매핑되고 코드는 매핑된 스텝만 봅니다.</p>'
    + groups.map((group) => {
      const rows = group.nodes.length
        ? group.nodes.map((entry) => {
          const node = entry[1];
          const parts = [`<code>${escapeHtml(entry[0])}</code>`];
          if (node.validity) parts.push(`완료 유효성 ${escapeHtml(COMPLETION_VALIDITY_LABELS[node.validity] || node.validity)}`);
          if ((node.requires || []).length) parts.push(`${node.requires.map((field) => escapeHtml(NODE_FIELD_LABELS[field] || field)).join(' · ')} 필요`);
          return `<div class="presentation-row"><div class="presentation-row-main"><strong>${escapeHtml(node.label || taskStatusLabel(entry[0]))}</strong><small>${parts.join(' · ')}</small></div></div>`;
        }).join('')
        : '<div class="presentation-row"><div class="presentation-row-main"><small>이 스텝에 선 노드가 이 흐름에 없습니다.</small></div></div>';
      return `<section class="presentation-group"><h3>${escapeHtml(group.label)}<span class="group-count">${group.key ? `<code>${escapeHtml(group.key)}</code> · ` : ''}${escapeHtml(group.note)}</span></h3><div class="presentation-rows">${rows}</div></section>`;
    }).join('');

  const transitionNote = '<h3 class="approval-heading">전환과 그 전환이 부르는 것</h3>'
    + '<p class="approval-note">전환은 <b>어느 노드에서 어느 노드로 갈 수 있는가</b>이고, 슬롯은 <b>그때 무엇을 부르는가</b>입니다. 검증은 항목만 보고 답하므로 그 자리에서 끝나고, 입력·수행·승인은 판정 함수가 혼자 답할 수 없어 런을 엽니다. 어느 전환이 런을 여는지는 서버가 어휘의 경계에서 계산해 실어 주므로 이 화면이 다시 세지 않습니다.</p>';
  if (!view.transitions) {
    el('workflow-transitions').innerHTML = transitionNote + '<p class="empty-state">이 흐름은 전환을 선언하지 않았습니다. 선언하지 않은 흐름은 전환을 막지 않으므로 어느 노드에서 어느 노드로든 갑니다 — 닫는 것은 선언으로 합니다.</p>';
  } else if (!view.transitions.length) {
    el('workflow-transitions').innerHTML = transitionNote + '<p class="empty-state">전환 목록이 비어 있습니다. 빈 목록도 선언이라, 같은 노드에 머무는 것 말고는 전부 막힙니다.</p>';
  } else {
    el('workflow-transitions').innerHTML = transitionNote + `<div class="workflow-transitions">${view.transitions.map((item) => {
      const chips = transitionSlots(item).map((slot) => item[slot]
        .map((name) => `<span class="chip"><b>${escapeHtml(TRANSITION_SLOT_LABELS[slot] || slot)}</b> ${escapeHtml(executionUnitText(view, name))}</span>`).join('')).join('');
      // 승인은 이름 목록이 아니라 참·거짓으로 실려 온다. 그 칸이 아직 이름으로 수렴하지
      // 않았다는 사실이 계약에 적혀 있고, 화면은 실려 온 모양대로 그린다.
      const approval = item.approval ? '<span class="chip workflow-gate"><b>승인</b> 사람 게이트</span>' : '';
      const run = typeof item.opensRun === 'boolean'
        ? `<span class="chip">${item.opensRun ? '런이 열립니다' : '런 없이 판정으로 끝납니다'}</span>`
        : '';
      const called = (chips || approval)
        ? `${chips}${approval}${run}`
        : `<span class="guidance-empty">부르는 것이 없습니다 — 도착 노드가 요구하는 필드만 봅니다</span>${run}`;
      return '<article class="workflow-transition">'
        + `<header><span class="workflow-endpoint">${workflowNodeText(view, item.from)}</span><span class="workflow-arrow" aria-hidden="true">→</span><span class="workflow-endpoint">${workflowNodeText(view, item.to)}</span></header>`
        + `<strong>${escapeHtml(item.title || '이름 없는 전환')}</strong><div class="chip-row">${called}</div></article>`;
    }).join('')}</div>`;
  }

  const workflowSources = (view.sources && view.sources.workflows) || {};
  const bindingSources = ((view.sources && view.sources.bindings) || {})[view.targetKind] || null;
  const bindings = view.bindings || {};
  const itemTypes = (state.snapshot.presentation && state.snapshot.presentation.itemTypes) || {};

  const workflowRows = Object.keys(workflowSources).sort().map((id) => {
    const entry = workflowSources[id] || {};
    const fields = Object.keys(entry.fields || {});
    const detail = fields.length
      ? fields.map((field) => `${field} ← ${ORIGIN_LABELS[entry.fields[field]] || entry.fields[field]}`).join(' · ')
      : '적은 칸이 없습니다';
    return `<div class="presentation-row"><div class="presentation-row-main"><strong><code>${escapeHtml(id)}</code>${id === view.id ? ' — 이 판이 쓰는 흐름' : ''}</strong><small>${escapeHtml(detail)}</small></div>${originIndicator(entry.entry || 'builtin')}</div>`;
  }).join('');

  const bindingRows = Object.keys(bindings).sort().map((typeId) => {
    const origin = (bindingSources && bindingSources.fields && bindingSources.fields[typeId]) || 'builtin';
    const known = itemTypes[typeId];
    const note = known ? `업무 유형 ${known.label || typeId}` : '이 프로젝트의 업무 유형 목록에 없는 키입니다';
    return `<div class="presentation-row"><div class="presentation-row-main"><strong><code>${escapeHtml(typeId)}</code> → <code>${escapeHtml(bindings[typeId])}</code></strong><small>${escapeHtml(note)}</small></div>${originIndicator(origin)}</div>`;
  }).join('');

  el('workflow-layers').innerHTML = '<h3 class="approval-heading">정의한 층</h3>'
    + '<p class="approval-note">흐름은 <b>내장 → Workspace → 이 프로젝트</b> 순으로 겹칩니다. 노드는 항목 단위로 합쳐지고 전환은 층 단위로 갈아탑니다 — 하위가 전환 하나만 지우려 해도 목록 전체를 다시 적어야 한다는 뜻입니다. 아래 표시는 서버가 층별 원본을 따로 읽어 계산한 것이라, 상위와 같은 값을 명시한 경우도 상속이 아니라 명시로 보입니다.</p>'
    + `<section class="presentation-group"><h3>흐름 정의<span class="group-count">설정이 적은 흐름 ${Object.keys(workflowSources).length}개</span></h3><div class="presentation-rows">${workflowRows || '<div class="presentation-row"><div class="presentation-row-main"><small>설정 파일이 흐름을 적지 않았습니다. 내장 흐름이 그대로 답합니다.</small></div></div>'}</div></section>`
    + `<section class="presentation-group"><h3>유형별 배정<span class="group-count">${Object.keys(bindings).length}줄</span></h3><p class="approval-note">배정 키는 업무 유형의 id입니다. 어느 유형에도 안 맞는 항목이 탈 기본을 적는 키가 따로 있고, 그 키가 무엇인지는 이 화면이 정하지 않습니다 — 스냅숏이 배정 표를 그대로 실어 줍니다.</p><div class="presentation-rows">${bindingRows || '<div class="presentation-row"><div class="presentation-row-main"><small>배정이 없습니다. 모든 태스크가 내장 흐름을 탑니다.</small></div></div>'}</div></section>`;

  // 못 하는 것을 말하지 않는 화면은 사람이 되는 줄 알고 시도한다. 업무 유형 패널이 유형
  // 추가로 무엇이 따라오지 않는지를 적는 것과 같은 자리다.
  el('workflow-scope').innerHTML = '<h3 class="approval-heading">이 화면이 하는 것과 안 하는 것</h3>'
    + '<p class="approval-note">이 판은 <b>이 프로젝트의 기본 배정</b> 하나를 그립니다. 유형마다 흐름이 갈리는 프로젝트에서 "이 태스크는 어느 흐름인가"는 태스크마다 판정 엔드포인트가 답하며, 그 답을 여기서 미리 그리면 같은 물음에 두 답이 생깁니다.</p>'
    + '<div class="split-note"><div class="note-block"><h4>여기서 보입니다</h4><ul><li>노드와 그 노드가 선 스텝</li><li>노드가 요구하는 필드</li><li>전환과 그 전환이 부르는 실행 단위</li><li>전환이 런을 여는지</li><li>각 값을 적은 층</li></ul></div>'
    + '<div class="note-block absent"><h4>여기서 바꾸지 않습니다</h4><ul><li>노드 추가와 이름 변경</li><li>전환 추가·삭제와 슬롯 배선</li><li>유형별 흐름 배정</li><li>승인 슬롯을 걸고 푸는 일</li></ul></div></div>';
}

function renderApprovalSettings() {
  if (!el('approval-settings')) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="approval-settings" class="settings-panel"><header><h2>승인과 파이프</h2><p>모드는 AI를 얼마나 믿느냐의 눈금이 아니라 <b>사람의 주의를 어디에 쓸지의 배분표</b>입니다. 되돌릴 수 있는 구간을 흘려보내야 남은 게이트가 실제로 읽힙니다. 승인 모드도 정책이라 이 화면에서 바꾸지 않습니다 — 정책 층 변경은 계약 변경 결정을 함께 남겨야 저장됩니다. 지금은 <code>board.json</code>의 <code>approval</code>을 고치고 <code>rdl save</code>로 남깁니다.</p></header><div class="settings-body"><div id="approval-current" class="presentation-source"></div><div id="approval-modes" class="approval-modes"></div><div id="approval-pipes"></div></div></section>');
  }
  const snapshot = state.snapshot;
  const catalog = snapshot.approvalCatalog;
  // 모드 표가 없으면 옛 서버다. 빈 화면 대신 무엇이 없는지 말한다.
  if (!catalog) {
    el('approval-current').innerHTML = '<p class="empty-state">이 Board 서버는 승인 모드를 아직 싣지 않습니다. 서버를 다시 시작하세요.</p>';
    el('approval-modes').innerHTML = '';
    el('approval-pipes').innerHTML = '';
    return;
  }
  const approval = (snapshot.presentation && snapshot.presentation.approval) || {};
  const modes = catalog.modes;
  const order = Object.keys(modes).sort((left, right) => modes[left].rank - modes[right].rank);
  const chosen = approval.mode || catalog.defaultMode;
  const floor = approval.floor || catalog.defaultFloor;

  el('approval-current').innerHTML = [
    ['이 프로젝트', chosen, approval.mode ? '이 프로젝트가 골랐습니다.' : '선언하지 않아 기본값을 씁니다.'],
    ['Workspace 바닥', floor, approval.floor ? '이보다 푼 모드는 고를 수 없습니다.' : '선언하지 않아 제약하지 않습니다.']
  ].map(([label, name, note]) => `<div class="property"><dt>${escapeHtml(label)}</dt><dd><strong>${escapeHtml(name ? (APPROVAL_MODE_LABELS[name] || name) : '없음')}</strong><small>${escapeHtml(note)}</small></dd></div>`).join('');

  el('approval-modes').innerHTML = order.map((name) => {
    const mode = modes[name];
    // 바닥보다 푼 모드는 고를 수 없다. 잠긴 이유를 곁에 적지 않으면 사용자는 결함으로 읽는다.
    const locked = floor && mode.rank > modes[floor].rank;
    const state = locked ? '잠김 · 바닥보다 푼 쪽' : (name === chosen ? '현재' : '고를 수 있음');
    const basis = (mode.basis || []).map((kind) => APPROVAL_BASIS_LABELS[kind] || kind).join(' · ');
    return `<article class="approval-mode${name === chosen ? ' current' : ''}${locked ? ' locked' : ''}">`
      + `<span class="mode-state">${escapeHtml(state)}</span>`
      + `<strong>${escapeHtml(APPROVAL_MODE_LABELS[name] || name)}</strong>`
      + `<dl><div><dt>사람 게이트</dt><dd>${mode.humanGate === 'required' ? '필수' : '없음'}</dd></div>`
      + `<div><dt>검증자</dt><dd>${mode.policy.validators}</dd></div>`
      + `<div><dt>정족수</dt><dd>${mode.policy.quorum}</dd></div>`
      + `<div><dt>다양성</dt><dd>${mode.policy.requireAdapterDiversity ? '요구' : '—'}</dd></div>`
      + `<div><dt>승인 근거</dt><dd>${escapeHtml(basis)}</dd></div>`
      + `<div><dt>위임</dt><dd>${mode.requiresDelegation ? '사전 위임 필수' : '불필요'}</dd></div></dl></article>`;
  }).join('');

  // 바닥은 올리는 것이지 벽이 아니다. 이 사실을 화면이 말하지 않으면 사용자는 절차가
  // 선언한 값과 실제 값이 다른 것을 결함으로 읽는다.
  const effective = { validators: 0, quorum: 0, diversity: false };
  for (const name of [floor, chosen].filter(Boolean)) {
    const policy = modes[name] && modes[name].policy;
    if (!policy) continue;
    effective.validators = Math.max(effective.validators, policy.validators);
    effective.quorum = Math.max(effective.quorum, policy.quorum);
    effective.diversity = effective.diversity || policy.requireAdapterDiversity;
  }
  el('approval-pipes').innerHTML = '<h3 class="approval-heading">파이프에 적용되는 실효 바닥</h3>'
    + `<p class="approval-note">모드와 바닥 중 <b>더 조인 쪽</b>이 이깁니다. 절차의 스텝이 이보다 낮은 값을 선언하고 있으면 거부하지 않고 여기까지 <b>끌어올립니다</b> — 거부하면 바닥을 까는 순간 기존 절차가 열리지 않고, 그러면 사람들은 바닥을 꺼 버립니다. 끌어올린 값은 해석 결과에만 있고 파일에는 쓰지 않으므로, 모드를 되돌리면 원래 값으로 돌아갑니다.</p>`
    + `<div class="presentation-rows"><div class="presentation-row"><div class="presentation-row-main"><strong>최소 검증자</strong><small>스텝이 더 올릴 수 있고 내릴 수 없습니다</small></div><span class="origin-label">${effective.validators}명</span></div>`
    + `<div class="presentation-row"><div class="presentation-row-main"><strong>정족수</strong><small>검증자를 넘지 않도록 함께 맞춥니다</small></div><span class="origin-label">${effective.quorum}명</span></div>`
    + `<div class="presentation-row"><div class="presentation-row-main"><strong>어댑터 다양성</strong><small>켠 것은 스텝이 끌 수 없습니다</small></div><span class="origin-label">${effective.diversity ? '요구' : '요구 안 함'}</span></div></div>`;
}

// 표시 규칙 편집. 칸에 적는 값은 "고른 범위가 덮은 것"이고 상위에서 내려온 값은
// placeholder로만 보인다. 합쳐진 결과를 칸에 채워 두고 그대로 저장하면 손대지 않은
// 상위 값까지 이 범위 파일에 박히고, 그러면 나중에 상위 기본값이 나아져도 내려오지
// 않는다 — 화면이 편집하지 않은 것을 payload에 실으면 안 된다는 규칙이 여기서도 같다.
//
// 칸을 비우는 것이 곧 되돌리기다. 지우기를 따로 두면 "이 범위에서 정하지 않음"과
// "빈 값으로 덮음"이 두 조작이 되는데, 빈 라벨은 애초에 저장할 수 없으므로 둘은 같은
// 뜻이어야 한다. 되돌리기 버튼은 그 칸들을 한 번에 비우는 손잡이일 뿐이다.
const PRESENTATION_EDIT_FIELDS = [['label', '표시 문구'], ['description', '설명'], ['order', '정렬 순서']];
const PRESENTATION_SCOPE_LABELS = { workspace: 'Workspace', project: '이 프로젝트' };

function presentationSources() { return (state.snapshot.presentation && state.snapshot.presentation.sources) || {}; }
function presentationScope() { return state.presentationScope === 'workspace' ? 'workspace' : 'project'; }
// 이 범위가 실제로 파일에 적어 둔 것. 없으면 null이고, null과 빈 객체는 다르다 —
// 없는 것은 상속이고 빈 객체는 이 범위가 항목을 선언했다는 뜻이다.
function ownPresentationEntry(group, key, scope) {
  const own = presentationSources()[scope];
  const entry = own && own[group] && own[group][key];
  return entry && typeof entry === 'object' ? entry : null;
}
// 이 범위가 아무 말도 하지 않을 때 내려오는 값. 저장 범위보다 위에 있는 층만 합친다.
function inheritedPresentationEntry(group, key, scope) {
  const sources = presentationSources();
  const layers = scope === 'workspace' ? ['builtin'] : ['builtin', 'workspace'];
  return layers.reduce((merged, layer) => Object.assign(merged, (sources[layer] && sources[layer][group] && sources[layer][group][key]) || {}), {});
}
// 프로필만 키가 열려 있어 상위 범위가 만든 프리셋이 내려온다. 그 표시 문구를 하위에서
// 덮으려면 정책까지 함께 적어야 하는데(정책 없는 커스텀 프로필은 거부된다), 정책을
// 옮겨 적는 순간 그것은 표시가 아니라 정책 변경이다. 그래서 잠그고, 그 프리셋을 가진
// 범위를 고르라고 말한다.
function presentationEditable(group, key, scope) {
  if (group !== 'profiles') return true;
  if (ownPresentationEntry(group, key, scope)) return true;
  const builtin = presentationSources().builtin || {};
  return Boolean(builtin.profiles && builtin.profiles[key]);
}
function presentationDirty() {
  return Array.from(document.querySelectorAll('[data-presentation-field]')).some((input) => input.value.trim() !== input.dataset.initial);
}
// 편집 중에는 폴링이 화면을 갈아끼우지 않는다. 문서 편집과 같은 규칙이다 — 갈아끼우면
// 적던 값이 사라지고 baseRevision까지 함께 바뀌어, 무엇을 기준으로 저장하는지 흐려진다.
function isPresentationEditing() { return !state.presentationSettling && presentationDirty(); }
function presentationFieldHtml(group, key, field, label, own, inherited, editable) {
  const numeric = field === 'order';
  const value = own && own[field] !== undefined ? own[field] : '';
  const placeholder = inherited[field] === undefined ? '정하지 않음' : String(inherited[field]);
  const id = `presentation-${group}-${key}-${field}`;
  return `<label class="presentation-field" for="${escapeHtml(id)}"><span>${escapeHtml(label)}</span>`
    + `<input id="${escapeHtml(id)}" data-presentation-field="${escapeHtml(field)}" type="${numeric ? 'number' : 'text'}"${numeric ? ' step="1"' : ''}`
    + ` value="${escapeHtml(value)}" data-initial="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"${editable ? '' : ' disabled'}></label>`;
}
function presentationRowHtml(group, key, item, origin, scope) {
  const own = ownPresentationEntry(group, key, scope);
  const inherited = inheritedPresentationEntry(group, key, scope);
  const editable = presentationEditable(group, key, scope);
  const notes = [];
  // 사용 안 함은 값이 아니라 항목의 상태이고 정책 층이다. 여기서 끄고 켤 수 있으면
  // 표시 문구를 고치러 온 사람이 항목을 없앨 수 있게 되므로, 보여만 주고 잠근다.
  if (item.disabled) notes.push('이 항목은 사용 안 함으로 표시되어 있습니다. 되살리는 것은 정책이라 여기서 하지 않습니다.');
  if (!editable) notes.push('상위 범위가 만든 프리셋입니다. 그 범위를 골라 고치세요.');
  else if (scope === 'workspace' && origin === 'project') notes.push('이 프로젝트가 같은 항목을 덮고 있어, 저장해도 이 화면의 값은 그대로입니다.');
  return `<div class="presentation-row origin-row-${origin}" data-presentation-group="${escapeHtml(group)}" data-presentation-entry="${escapeHtml(key)}">`
    + `<div class="presentation-row-main"><strong>${escapeHtml(item.label || key)}</strong><small><code>${escapeHtml(key)}</code>${item.description ? ' · ' + escapeHtml(item.description) : ''}</small>`
    + `<div class="presentation-fields">${PRESENTATION_EDIT_FIELDS.map(([field, label]) => presentationFieldHtml(group, key, field, label, own, inherited, editable)).join('')}</div>`
    + (notes.length ? `<small class="presentation-note">${notes.map(escapeHtml).join(' ')}</small>` : '')
    + '</div>'
    + `<div class="presentation-row-side">${originIndicator(origin)}`
    + `${own && editable ? '<button type="button" data-presentation-reset>되돌리기</button>' : ''}</div></div>`;
}
// 저장 payload는 바뀐 항목만 담는다. 바뀌지 않은 항목은 presentationInput이 이 범위의
// 원본을 그대로 실어 보내므로 여기서 다시 적을 이유가 없다.
function presentationPatch(scope) {
  const patch = {};
  for (const row of document.querySelectorAll('[data-presentation-entry]')) {
    const inputs = Array.from(row.querySelectorAll('[data-presentation-field]'));
    if (!inputs.some((input) => input.value.trim() !== input.dataset.initial)) continue;
    const group = row.dataset.presentationGroup;
    const key = row.dataset.presentationEntry;
    // 이 범위의 원본에서 시작한다. 표시 필드만 갈아끼우면 사용 안 함 표식과 프리셋
    // 정의가 그대로 남고, 표시 문구를 고치는 저장이 정책을 지우는 일이 되지 않는다.
    const next = Object.assign({}, ownPresentationEntry(group, key, scope));
    for (const input of inputs) {
      const field = input.dataset.presentationField;
      const value = input.value.trim();
      if (!value) { delete next[field]; continue; }
      if (field === 'order' && !/^-?\d+$/u.test(value)) throw new Error(`정렬 순서는 정수여야 합니다: ${PRESENTATION_GROUP_LABELS[group]}의 ${key}`);
      next[field] = field === 'order' ? Number(value) : value;
    }
    // 남은 것이 하나도 없으면 이 범위는 그 항목에 대해 아무 말도 하지 않는다. 정책
    // 값이 남아 있으면 비어 있지 않으므로 항목이 통째로 지워지는 경로는 열리지 않는다.
    patch[group] = patch[group] || {};
    patch[group][key] = Object.keys(next).length ? next : null;
  }
  return patch;
}
async function savePresentationEdits() {
  const scope = presentationScope();
  let patch;
  try { patch = presentationPatch(scope); }
  catch (error) { return message(error.message, true); }
  if (!Object.keys(patch).length) return message('바뀐 표시 규칙이 없습니다.');
  try {
    await api(projectPath('/presentation'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
      body: JSON.stringify(presentationInput(scope, patch))
    });
    message(`${PRESENTATION_SCOPE_LABELS[scope]} 표시 규칙을 저장했습니다. 커밋은 rdl save가 맡습니다.`);
  } catch (error) {
    message(error.message, true);
  }
  // 성공이든 실패든 파일이 답이다. 편집 상태를 버리고 다시 읽어야 409로 막힌 뒤에도
  // 최신 revision을 들고 다시 시도할 수 있다. 유효 값이 그대로인 저장 — 상위와 같은
  // 값을 이 범위에 명시하는 경우 — 은 revision이 바뀌지 않으므로 여기서 직접 다시 그린다.
  state.presentationSettling = true;
  try { await loadSnapshot(true); } finally { state.presentationSettling = false; }
  if (state.view === 'settings') renderPresentationSettings();
}
function renderPresentationSettings() {
  let section = el('presentation-settings');
  if (!section) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="presentation-settings" class="settings-panel"><header class="section-heading"><div><h2>표시 규칙</h2><p>화면에 보이는 말과 순서입니다. 저장값이 아니라 표시이므로 판정에 영향이 없고, 그래서 여기서 바로 고칩니다. 칸에 적은 값만 고른 범위의 <code>board.json</code>에 덮이고 비운 칸은 상위에서 내려온 값(옅은 글씨)을 그대로 씁니다. 항목을 없애거나 되살리는 것은 표시가 아니라 정책이라 여기 없습니다.</p></div><div class="page-actions"><label class="presentation-scope">저장 범위<select id="presentation-scope"><option value="project">이 프로젝트</option><option value="workspace">Workspace</option></select></label><button id="save-presentation" class="primary">표시 규칙 저장</button></div></header><div class="settings-body"><div id="presentation-inheritance" class="inheritance-chain"></div><div id="presentation-source" class="presentation-source"></div><p id="presentation-scope-hint" class="control-hint"></p><div id="presentation-groups" class="presentation-groups"></div><div id="presentation-boundary" class="boundary-block"></div></div></section>');
    section = el('presentation-settings');
  }
  const presentation = state.snapshot.presentation;
  const chain = presentation.inheritance;
  const origins = presentation.origins;
  const scope = presentationScope();
  el('presentation-scope').value = scope;
  el('presentation-inheritance').innerHTML = `<span class="inheritance-node active">내장 기본값</span><span>→</span><span class="inheritance-node ${chain.workspace.configured ? 'active' : ''}">Workspace board.json</span><span>→</span><span class="inheritance-node ${chain.project.configured ? 'active' : ''}">프로젝트 board.json</span>`;
  // 어느 파일을 여는지 알려주는 게 이 화면의 절반이다. 경로를 tooltip에만 두면 찾을 수 없다.
  el('presentation-source').innerHTML = [['Workspace', chain.workspace], ['프로젝트', chain.project]]
    .map(([label, item]) => `<div class="property"><dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(item.file)}</code><small>${item.configured ? '이 파일이 값을 덮어쓰고 있습니다.' : '아직 없어 상위 값을 그대로 씁니다.'}</small></dd></div>`).join('');
  el('presentation-scope-hint').innerHTML = `저장하면 <code>${escapeHtml((scope === 'workspace' ? chain.workspace : chain.project).file)}</code>에 씁니다. 커밋은 <code>rdl save</code>가 맡습니다.`;
  el('presentation-groups').innerHTML = Object.keys(PRESENTATION_GROUP_LABELS).map((group) => {
    const entries = Object.entries(presentation[group] || {}).sort((left, right) => (left[1].order || 0) - (right[1].order || 0));
    if (!entries.length) return '';
    const overridden = entries.filter(([key]) => presentationOrigin(origins, group, key) !== 'builtin').length;
    const rows = entries.map(([key, item]) => presentationRowHtml(group, key, item, presentationOrigin(origins, group, key), scope)).join('');
    return `<section class="presentation-group"><h3>${escapeHtml(PRESENTATION_GROUP_LABELS[group])}<span class="group-count">${entries.length}개${overridden ? ' · ' + overridden + '개 덮음' : ''}</span></h3><div class="presentation-rows">${rows}</div></section>`;
  }).join('');
  el('presentation-boundary').innerHTML = `<h3>여기 없는 것</h3><p>아래는 되돌릴 수 없는 행위의 관문입니다. 잠긴 항목으로 두지 않고 설정에서 뺐습니다 — 잠긴 항목은 언젠가 잠금을 푸는 요청을 부르지만, 없는 항목은 그 대상이 되지 않습니다.</p><div class="boundary-list">${BOUNDARY_ITEMS.map(([name, why]) => `<div class="boundary-item"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(why)}</small></div>`).join('')}</div>`;
}
// 범위를 바꾸면 칸의 뜻이 바뀐다 — 같은 글자라도 어느 파일에 적히느냐가 달라지므로
// 적던 것을 그대로 옮겨 담지 않고 버린다. 버리기 전에는 반드시 묻는다.
document.addEventListener('change', (event) => {
  if (event.target.id !== 'presentation-scope') return;
  if (presentationDirty() && !confirm('저장하지 않은 표시 규칙 편집이 있습니다. 범위를 바꾸면 사라집니다. 계속할까요?')) {
    event.target.value = presentationScope();
    return;
  }
  state.presentationScope = event.target.value;
  renderPresentationSettings();
});
document.addEventListener('input', (event) => {
  if (!event.target.matches('[data-presentation-field]')) return;
  const row = event.target.closest('[data-presentation-entry]');
  const changed = Array.from(row.querySelectorAll('[data-presentation-field]')).some((input) => input.value.trim() !== input.dataset.initial);
  row.classList.toggle('presentation-row-edited', changed);
});
document.addEventListener('click', (event) => {
  const reset = event.target.closest('[data-presentation-reset]');
  if (reset) {
    const row = reset.closest('[data-presentation-entry]');
    for (const input of row.querySelectorAll('[data-presentation-field]')) input.value = '';
    row.classList.add('presentation-row-edited');
    message('저장을 누르면 이 항목은 상위 범위에서 내려온 값으로 돌아갑니다.');
    return;
  }
  if (event.target.closest('#save-presentation')) savePresentationEdits();
});
// 계약 준수. 규칙을 정하는 화면은 있었는데 그 규칙이 지켜지는지 보는 화면이 없었다.
// 여기 쓰는 값은 전부 스냅샷에 이미 실려 오던 것이라 새로 계산하지 않는다.
const enforcementNote = {
  advisory: '위반을 보고만 하고 저장·동기화를 막지 않습니다.',
  checkpoint: '위반이 남아 있으면 rdl save와 rdl sync가 차단됩니다.'
};
// 표시 규칙에 설명이 없을 때만 쓰는 최후 문구. 평소에는 presentationHint가 이긴다.
const policyNote = {
  required: '없으면 위반입니다.',
  recommended: '없으면 경고이며 checkpoint에서도 차단하지 않습니다.',
  onDemand: '있어도 없어도 알리지 않습니다.',
  disabled: '만들면 위반이며 생성이 차단됩니다.'
};
function complianceList(items, empty) {
  return items.length ? `<div class="compliance-list">${items.join('')}</div>` : `<p class="empty-state">${escapeHtml(empty)}</p>`;
}
function renderContractCompliance() {
  if (!el('contract-compliance')) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="contract-compliance" class="settings-panel"><header><h2>계약 준수</h2><p>이 프로젝트가 지금 계약을 지키고 있는지 보여줍니다. 모두 계산 결과이며 여기서 바꾸지 않습니다.</p></header><div class="settings-body" id="compliance-body"></div></section>');
  }
  const contract = state.snapshot.contract;
  const diagnostics = state.snapshot.diagnostics || { summary: { errors: 0, warnings: 0 }, items: [] };
  const evaluation = contract.evaluation || {};
  const trace = contract.traceability || { entries: [], summary: { functions: 0, ready: 0 } };
  const profile = contract.profile;

  const policyRows = ['required', 'recommended', 'onDemand', 'disabled']
    .map((name) => `<div class="property"><dt>${escapeHtml(policyStateLabel(name))}</dt><dd>${escapeHtml((profile.policy[name] || []).join(', ') || '없음')}<small>${escapeHtml(presentationHint('policyStates', name) || policyNote[name])}</small></dd></div>`).join('');

  const violations = (evaluation.violations || []).map((item) => `<div class="compliance-item error"><strong>${escapeHtml(item.code)}</strong><span>${escapeHtml(item.message)}</span></div>`);
  const findings = (diagnostics.items || []).map((item) => `<div class="compliance-item ${escapeHtml(item.severity)}"><strong>${escapeHtml(item.code)}</strong><span>${escapeHtml(item.message)}</span><small>${escapeHtml(item.artifactId || item.file || '')}</small></div>`);
  const incomplete = (trace.entries || []).filter((entry) => !entry.ready)
    .map((entry) => `<div class="compliance-item warning"><strong>${escapeHtml(entry.functionId)}</strong><span>미준비: ${escapeHtml((entry.missing || []).join(', ') || '연결 문서 부족')}</span></div>`);

  const diagrams = contract.catalog && contract.catalog.diagrams
    ? `<div class="property"><dt>다이어그램</dt><dd>${escapeHtml(contract.catalog.diagrams.version)} · ${escapeHtml(contract.catalog.diagrams.types.join(', '))}<small>${escapeHtml(contract.catalog.diagrams.authority || '')}</small></dd></div>` : '';

  el('compliance-body').innerHTML = `
    <section class="compliance-group"><h3>계약 상태</h3><dl>
      <div class="property"><dt>강제 수준</dt><dd>${escapeHtml(enforcementLabel(contract.enforcement))}<small>${escapeHtml(presentationHint('enforcementLevels', contract.enforcement) || enforcementNote[contract.enforcement] || '')}</small></dd></div>
      <div class="property"><dt>revision</dt><dd>${escapeHtml(String(profile.revision))}<small>계약을 바꿀 때마다 1씩 오릅니다.</small></dd></div>
      <div class="property"><dt>프로필 이력</dt><dd>${escapeHtml((profile.history || []).map((name) => presentationLabel('profiles', name, name)).join(' → '))}</dd></div>${diagrams}
    </dl></section>
    <section class="compliance-group"><h3>정책 상태별 의미</h3><dl>${policyRows}</dl></section>
    <section class="compliance-group"><h3>계약 위반 ${violations.length}</h3>${complianceList(violations, '위반이 없습니다.')}</section>
    <section class="compliance-group"><h3>검사 결과 — 오류 ${diagnostics.summary.errors} · 경고 ${diagnostics.summary.warnings}</h3>${complianceList(findings, 'rdl check --strict가 오류와 경고 없이 통과합니다.')}</section>
    <section class="compliance-group"><h3>기능 추적성 — 준비 ${trace.summary.ready}/${trace.summary.functions}</h3>${complianceList(incomplete, '선언된 기능이 모두 REQ와 TST 계약을 갖췄습니다.')}</section>`;
}
// 이 기기가 등록되어 있지 않으면 화면에서 등록한다.
//
// 전에는 "명령줄로 등록하세요"라고만 알렸다. 그런데 미등록이 드러나는 자리는 대개
// 무언가를 하려던 순간 — 댓글을 남기거나 저장하려던 때 — 이고, 그때 사람을 터미널로
// 보내면 하던 일이 끊긴다. 등록은 이 기기의 신원을 적는 일이지 위험한 일이 아니다.
//
// 다만 식별자는 고르게 하지 않는다. 이 기기의 식별자는 프로젝트가 이미 알고 있고,
// 사람이 고르게 두면 다른 기기의 것을 적어 두 기기가 한 신원을 공유할 수 있다.
//
// 유형 기본값을 device로 두지 않는다. device는 기계의 종류일 뿐 행위 주체를 담지
// 않아서, 그 값으로 파생한 판정이 틀린 적이 있다 — 사람이 쓰는 기기면 human을,
// AI가 쓰면 agent를 고르게 하고 기본값을 비워 둔다.
function clientRegisterFormHtml(identity, members) {
  return '<div class="client-register-grid">'
    + `<label>식별자<input id="register-client-id" value="${escapeHtml(identity.id)}" readonly><small>이 기기의 값이라 고를 수 없습니다.</small></label>`
    + '<label>이름<input id="register-client-name" placeholder="예: 개발 데스크톱"><small>사람이 알아볼 이름입니다.</small></label>'
    + '<label>유형<select id="register-client-type"><option value="">고르세요</option><option value="human">사람이 직접 씁니다</option><option value="agent">AI 에이전트가 씁니다</option><option value="device">기기 자동 실행</option><option value="service">서비스</option></select>'
    + '<small>사람이 쓰면 <b>사람</b>을 고르세요. 그래야 남긴 댓글이 승인 근거가 됩니다.</small></label>'
    + `<label>소유 구성원<select id="register-client-owner"><option value="">고르세요</option>${members.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}</select><small>이 기기의 행위가 누구에게 귀속되는지입니다.</small></label>`
    + '</div>'
    + '<div class="dialog-actions"><button type="button" data-dialog-cancel="client-dialog">나중에</button><button id="register-client" type="button" class="primary">이 기기 등록</button></div>';
}

// 미등록이 드러나는 자리는 대개 무언가를 하려던 순간 — 편집을 누르거나 댓글을 쓰려던
// 때 — 이다. 그때 명령줄 문자열을 건네면 사람은 하던 일을 접고 터미널을 찾아야 하고,
// 돌아와서는 무엇을 하려던 참이었는지부터 다시 세워야 한다. 등록은 이 기기의 신원을
// 적는 일이지 위험한 일이 아니므로, 그 자리에서 받고 하려던 일로 이어 준다.
//
// 이어갈 일은 값이 아니라 함수로 받는다. 등록 뒤에는 스냅샷을 다시 읽어 화면이 새로
// 그려지므로, 누르기 전에 손에 쥐고 있던 객체는 이미 낡았다 — 이어갈 때 새 스냅샷에서
// 대상을 다시 찾아야 옛 revision으로 저장이 나가지 않는다.
function openClientRegistration(reason, intent) {
  const identity = state.snapshot && state.snapshot.client;
  // 식별자가 없는 것은 등록의 문제가 아니라 프로젝트가 준비되지 않은 것이다. 없는 값을
  // 채우라고 하면 사람은 채울 수 없는 칸 앞에 선다.
  if (!identity || !identity.id) {
    message('이 기기의 Client ID가 없습니다. 명령줄에서 rdl git init으로 프로젝트를 먼저 준비하세요.', true);
    return false;
  }
  if (identity.registered) {
    if (intent) intent();
    return true;
  }
  state.clientIntent = intent || null;
  el('client-dialog-reason').textContent = reason || '이 기기를 등록해야 남기는 기록에 누가 했는지가 붙습니다.';
  el('client-dialog-body').innerHTML = clientRegisterFormHtml(identity, (state.snapshot.people && state.snapshot.people.members) || []);
  el('client-dialog').showModal();
  el('register-client-name').focus();
  return false;
}
// 닫으면 이어갈 일도 함께 버린다. 남겨두면 나중의 등록이 예전에 누르던 일을 되살린다.
el('client-dialog').addEventListener('close', () => { state.clientIntent = null; });

// 설정 화면은 등록으로 들어가는 또 하나의 문일 뿐, 입력 칸을 따로 갖지 않는다. 같은
// id의 칸이 화면에 둘이면 무엇이 저장될지는 사람이 채운 칸이 아니라 먼저 그려진 칸이
// 정한다. 칸은 대화상자 하나가 갖고, 들어오는 문만 여럿 둔다.
function renderClientRegistration() {
  const identity = state.snapshot.client;
  const host = el('client-registration');
  if (!host) return;
  if (!identity || !identity.id || identity.registered) {
    host.innerHTML = '';
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = '<div class="client-register"><h3>이 기기가 아직 등록되지 않았습니다</h3>'
    + `<p>등록해야 댓글과 저장에 누가 했는지가 남습니다. 등록되지 않은 기기는 기록을 남길 수 없습니다. 이 기기의 식별자는 <code>${escapeHtml(identity.id)}</code>입니다.</p>`
    + '<div class="client-register-actions"><button id="open-client-register" type="button" class="primary">이 기기 등록</button></div></div>';
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('#open-client-register')) return;
  openClientRegistration('등록하면 이 기기가 남기는 편집과 댓글에 누가 했는지가 붙습니다.', null);
});

function renderSettings() {
  // 활성 상태 전환은 여기서 한다 — 에이전트가 늘면 자주 쓰는 동작이다. 삭제는 여전히
  // 명령줄이 갖는다. 지운 Client의 기록은 남는데 그 신원을 화면에서 지울 수 있으면
  // 무엇이 남긴 기록인지 물을 수 없게 된다.
  const members = state.snapshot.people.members;
  const memberName = (id) => (members.find((item) => item.id === id) || {}).name || id || '미지정';
  el('clients').innerHTML = state.snapshot.clients.map((item) => {
    const self = item.id === state.snapshot.client.id;
    return `<div class="setting-row"><div><strong>${escapeHtml(item.name)}${self ? ' <span class="chip">이 기기</span>' : ''}</strong><p>${escapeHtml(item.id)} · ${escapeHtml(item.type)} · ${escapeHtml(memberName(item.owner))}</p></div><div class="setting-control"><span class="chip ${item.status === 'active' ? 'status-active' : ''}">${escapeHtml(item.status)}</span><button data-client-toggle="${escapeHtml(item.id)}" data-client-status="${item.status === 'active' ? 'disabled' : 'active'}">${item.status === 'active' ? '비활성화' : '활성화'}</button></div></div>`;
  }).join('') || '<p class="empty-state">등록된 Client가 없습니다. 위 단추로 이 기기를 등록하세요.</p>';
  el('settings-member').replaceChildren(new Option('선택 안 함', ''), ...members.map((item) => new Option(item.name, item.id)));
  el('settings-member').value = state.currentMember || '';
  renderClientRegistration();
  renderPresentationSettings(); renderApprovalSettings(); renderItemTypeSettings(); renderWorkflowSettings(); renderContractSettings(); renderContractCompliance();
  const current = document.querySelector('[data-settings-section].active');
  showSettingsSection(current ? current.dataset.settingsSection : 'settings-appearance');
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-client-toggle]');
  if (!button) return;
  try {
    await api(`/api/clients/${encodeURIComponent(button.dataset.clientToggle)}/${button.dataset.clientStatus === 'active' ? 'enable' : 'disable'}`, { method: 'POST', headers: { 'X-Rundol-Token': token } });
    await loadSnapshot(true);
    message('Client 상태를 바꿨습니다.');
  } catch (error) {
    message(error.message, true);
  }
});

// 이 기기 등록. 식별자는 서버가 아는 값을 그대로 보내고 사람이 고르지 않는다 —
// 고르게 두면 다른 기기의 것을 적어 두 기기가 한 신원을 공유할 수 있다.
async function submitClientRegistration() {
  const name = (el('register-client-name').value || '').trim();
  const type = el('register-client-type').value;
  const owner = el('register-client-owner').value;
  // 빠진 것을 하나씩 알린다. 한 번에 모아 알리면 무엇부터 채워야 하는지 흐려진다.
  if (!name) { message('이 기기를 알아볼 이름이 필요합니다.', true); return; }
  if (!type) { message('유형을 고르세요. 사람이 쓰면 사람을 고르세요 — 그래야 남긴 댓글이 승인 근거가 됩니다.', true); return; }
  if (!owner) { message('소유 구성원을 고르세요. 이 기기의 행위가 누구에게 귀속되는지입니다.', true); return; }
  try {
    await api('/api/clients', {
      method: 'POST',
      headers: { 'X-Rundol-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.snapshot.client.id, name, type, owner })
    });
    await loadSnapshot(true);
    // 이어갈 일은 대화상자를 닫고 나서 부른다. 편집으로 이어지는 경우 편집기가 열리는데,
    // 그 위에 모달이 남아 있으면 사람이 자기가 쓸 곳을 누를 수 없다.
    //
    // 닫기가 intent를 비우므로 부를 것을 먼저 손에 쥔다. 순서를 뒤집으면 등록은 됐는데
    // 하려던 일만 조용히 사라지고, 사람은 같은 단추를 다시 누른다.
    const intent = state.clientIntent;
    state.clientIntent = null;
    if (el('client-dialog').open) el('client-dialog').close();
    message('이 기기를 등록했습니다. 이제 댓글과 저장에 누가 했는지가 남습니다.');
    if (intent) await intent();
  } catch (error) {
    message(error.message, true);
  }
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('#register-client')) return;
  submitClientRegistration();
});
// 칸에서 Enter를 치는 것도 등록이다. dialog 안의 form은 기본 동작이 "닫기"라서, 막지
// 않으면 다 채운 사람이 Enter 한 번에 등록 없이 대화상자만 닫고 처음부터 다시 채운다.
el('client-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitClientRegistration();
});


function contractInput() {
  const policy = { required: [], recommended: [], onDemand: [], disabled: [] };
  for (const row of document.querySelectorAll('[data-contract-type]')) {
    policy[row.querySelector('[data-contract-status]').value].push(row.dataset.contractType);
  }
  return { baseRevision: state.snapshot.contract.revision, name: el('contract-profile').value, enforcement: el('contract-enforcement').value, policy };
}
document.addEventListener('change', (event) => {
  const status = event.target.closest('[data-contract-status]');
  if (status) { syncContractRow(status.closest('[data-contract-type]')); refreshProfileState(); }
  // 프리셋을 고르면 그 구성을 아래에 즉시 칠한다. 저장은 계약 저장 버튼이 한다.
  if (event.target.id === 'contract-profile') { applyProfilePreset(event.target.value); refreshProfileState(); }
  if (event.target.id === 'contract-enforcement') el('contract-enforcement-hint').textContent = presentationHint('enforcementLevels', event.target.value);
});
document.addEventListener('click', async (event) => {
  const row = event.target.closest('[data-contract-type]');
  const suggestion = event.target.closest('[data-component-suggestion]');
  if (row && suggestion) { addContractComponent(row, suggestion.dataset.componentSuggestion); refreshProfileState(); return; }
  const remove = event.target.closest('[data-component-remove]');
  if (row && remove) { const component = remove.closest('[data-contract-section]'); const value = component.dataset.contractSection; component.remove(); setSuggestionState(row, value, false); refreshProfileState(); return; }
  const add = event.target.closest('[data-component-add]');
  if (row && add) { const input = row.querySelector('[data-component-input]'); if (addContractComponent(row, input.value)) { input.value = ''; refreshProfileState(); } return; }
  // 지금 화면 구성을 이름 붙여 프리셋으로 남긴다. 프리셋은 프로젝트가 아니라 board.json이
  // 소유하므로 계약 저장과 다른 곳에 쓴다. 계약은 그 이름을 가리키게만 바꾼다.
  if (event.target.closest('#save-preset')) {
    const key = (prompt('프리셋 이름 (영문 소문자·숫자·하이픈)', 'our-team') || '').trim();
    if (!key) return;
    if (!/^[a-z][a-z0-9-]*$/u.test(key)) return message('프리셋 이름은 영문 소문자로 시작하고 숫자와 하이픈만 쓸 수 있습니다.', true);
    const label = (prompt('화면에 보일 이름', key) || key).trim();
    try {
      await api(projectPath('/presentation'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
        body: JSON.stringify(presentationInput('project', { profiles: { [key]: { label, policy: currentPolicyFromRows(), sections: currentSectionsFromRows() } } }))
      });
      // 프리셋은 board.json에, 계약은 project.md에 쓰므로 한 번에 끝나지 않는다. 둘째가
      // 실패하면 프리셋만 남는데, 그 상태에서 화면이 옛 revision을 들고 있으면 다시 눌러도
      // 충돌로 막힌다. 실패해도 스냅샷을 새로 받아 재시도가 가능하게 두고, 무엇이 됐고
      // 무엇이 남았는지 말한다.
      const contractPayload = Object.assign(contractInput(), { name: key });
      try {
        await api(projectPath('/contract'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify(contractPayload) });
        await loadSnapshot(true);
        message(`프리셋 ${label}으로 저장하고 이 프로젝트 계약을 그 프리셋으로 바꿨습니다.`);
      } catch (error) {
        await loadSnapshot(true);
        message(`프리셋 ${label}은 저장했지만 계약을 바꾸지 못했습니다: ${error.message} 프로필에서 ${label}을 고르고 계약 저장을 다시 누르세요.`, true);
      }
    } catch (error) { message(error.message, true); }
    return;
  }
  if (!event.target.closest('#save-contract')) return;
  try { await api(projectPath('/contract'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify(contractInput()) }); await loadSnapshot(true); message('문서 계획 계약을 저장했습니다.'); }
  catch (error) { message(error.message, true); }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.target.matches('[data-component-input]')) return;
  event.preventDefault();
  const row = event.target.closest('[data-contract-type]');
  if (addContractComponent(row, event.target.value)) event.target.value = '';
});
initialize().catch((error) => message(error.message, true));

// ── 런 ────────────────────────────────────────────────────────────────────
// 사람 게이트는 런을 멈추게 하려고 있는 것이고, 그것을 지나는 유일한 경로는 human
// 자격의 승인이다. 그 경로가 명령줄에만 있으면 승인해야 하는 사람이 런 ID를 옮겨
// 적어야 하고, 옮겨 적기 전까지 절차는 멈춘 채로 남는다.
//
// 갈래와 사유는 서버가 원장 판정으로 답한 값을 그대로 그린다. 화면이 상태를 보고 다시
// 판정하면 같은 런에 명령줄과 다른 답을 내는 두 번째 판정자가 생긴다.
const RUN_REASON_LABELS = {
  'human-gate': '사람 승인 대기', 'sync-pending': '동기화 대기', 'ownership-conflict': '소유권 충돌',
  'operation-conflict': 'operation 충돌', 'gate-failed': '게이트 실패', 'step-failed': '스텝 실패',
  'merge-conflict': '병합 충돌', 'sync-failed': '동기화 실패', 'adapter-timeout': '어댑터 시간 초과',
  'lease-lost': 'lease 상실', 'attempt-limit': '시도 예산 소진', manual: '수동 정지',
  'settings-drift': '설정 변경', 'legacy-conflict': '구형 충돌', 'verification-required': '검증 필요',
  'cursor-ready': '이어서 몰 수 있음', 'driver-active': '구동 중'
};
function runReasonLabel(reason) { return RUN_REASON_LABELS[reason] || reason || '사유 없음'; }

async function loadRuns(silent) {
  try {
    state.runs = await api(projectPath('/runs'));
    state.runsError = '';
    if (!silent) message('런을 새로 읽었습니다.');
  } catch (error) {
    state.runs = null;
    state.runsError = error.message;
    if (!silent) message(error.message, true);
  }
  if (state.view === 'runs') renderRuns();
}

// 승인은 사람 게이트에서만 열린다. 나머지 대기 사유는 보드가 할 수 있는 일이 아니므로
// 무엇을 실행해야 하는지를 그대로 보여 준다 — 여기서 흉내 내면 화면이 할 수 없는 일을
// 할 수 있는 것처럼 보이고, 누른 사람은 아무 일도 일어나지 않은 이유를 알 수 없다.
function runRowHtml(item, approvable) {
  const chips = [runReasonLabel(item.reason), item.procedure ? `절차 ${item.procedure}` : '', item.cursor ? `스텝 ${item.cursor}` : '']
    .filter(Boolean).map((label) => `<span class="chip">${escapeHtml(label)}</span>`).join('');
  const action = approvable && item.reason === 'human-gate'
    ? `<button class="primary" data-run-approve="${escapeHtml(item.runId)}">승인</button>`
    : '';
  const command = !action && item.command ? `<code>${escapeHtml(item.command)}</code>` : '';
  return `<div class="run-row"><div><strong>${escapeHtml(item.runId)}</strong><div class="chip-row">${chips}</div>${command}</div><div>${action}</div></div>`;
}

function runSectionHtml(title, description, items, approvable, empty) {
  const rows = (items || []).map((item) => runRowHtml(item, approvable)).join('');
  const body = rows ? `<div class="run-list">${rows}</div>` : `<p class="empty-state">${escapeHtml(empty)}</p>`;
  return `<section class="content-section run-section"><div class="section-heading"><h2>${escapeHtml(title)}</h2><span class="badge">${(items || []).length || ''}</span></div><p class="control-hint">${escapeHtml(description)}</p>${body}</section>`;
}

function renderRuns() {
  const body = el('runs-body');
  if (!body) return;
  const runs = state.runs;
  if (!runs) { body.innerHTML = `<p class="empty-state">${escapeHtml(state.runsError || '런을 읽는 중입니다.')}</p>`; return; }
  const unreadable = (runs.unreadable || []).length
    ? `<section class="content-section run-section"><div class="section-heading"><h2>읽지 못한 런</h2><span class="badge">${runs.unreadable.length}</span></div><div class="run-list">${runs.unreadable.map((item) => `<div class="run-row"><div><strong>${escapeHtml(item.runId)}</strong><div class="chip-row"><span class="chip">${escapeHtml(item.detail || '읽기 실패')}</span></div></div><div></div></div>`).join('')}</div></section>`
    : '';
  body.innerHTML = runSectionHtml('사람을 기다림', '사람만 풀 수 있는 런입니다. 사람 게이트는 여기서 승인하고, 나머지 사유는 적힌 명령이 풀어야 합니다.', runs.waiting, true, '사람을 기다리는 런이 없습니다.')
    + runSectionHtml('이어서 몰 수 있음', '기계가 이을 수 있는 런입니다. 구동은 명령줄이 담당합니다.', runs.drivable, false, '이어서 몰 수 있는 런이 없습니다.')
    + runSectionHtml('구동 중', '지금 누군가 몰고 있는 런입니다.', runs.driving, false, '구동 중인 런이 없습니다.')
    + unreadable;
}

// 승인자는 요청이 주장하는 값이 아니라 사람이 고른 자격이다. 목록에 활성 human Client만
// 두는 이유는 이 기기의 작성자 신원으로는 승인이 거부되기 때문이다 — 그 신원을 human으로
// 바꾸면 같은 기기의 실행 명령이 전부 막히므로, 승인용 자격은 따로 있어야 한다.
//
// 대화상자는 먼저 열고 내막은 뒤따라 채운다. 읽어 온 뒤에 열면 누른 것과 열리는 것 사이가
// 비어 사람은 눌리지 않았다고 생각하고 다시 누른다.
function openRunApproval(runId) {
  const item = ((state.runs && state.runs.waiting) || []).find((entry) => entry.runId === runId);
  if (!item) return message('그 런은 지금 사람을 기다리고 있지 않습니다. 다시 읽어 보세요.', true);
  state.approvingRun = item;
  state.review = { runId, detail: null, artifact: null };
  el('run-approve-id').textContent = item.runId;
  el('run-approve-step').textContent = `${item.procedure || '절차 없음'} · 지금 멈춘 스텝: ${item.cursor || '없음'}`;
  el('run-approve-goal').textContent = '';
  el('run-approve-reason').value = '';
  renderRunApprovers((state.runs && state.runs.approvers) || []);
  renderRunReview();
  el('run-approve-dialog').showModal();
  loadRunReview(runId);
}

function renderRunApprovers(approvers) {
  el('run-approve-client').replaceChildren(...approvers.map((client) => new Option(`${client.name || client.id} (${client.id})`, client.id)));
  el('run-approve-client').disabled = approvers.length === 0;
  el('run-approve-client-hint').textContent = approvers.length
    ? '실행 명령을 수행할 수 없는 자격만 여기 있습니다. 이 기기의 작성자 신원은 승인자가 될 수 없습니다.'
    : '이 프로젝트에 승인할 수 있는 활성 human Client가 없습니다. 설정 → Clients에서 사람이 쓰는 Client를 등록하세요.';
}

async function loadRunReview(runId) {
  try {
    const detail = await api(projectPath(`/runs/${encodeURIComponent(runId)}`));
    // 읽는 동안 사람이 다른 런을 열었을 수 있다. 늦게 온 답이 지금 보는 것을 갈아치우면,
    // 화면에 있는 문서와 승인 단추가 가리키는 런이 서로 다른 것이 된다.
    if (!state.review || state.review.runId !== runId) return;
    state.review.detail = detail;
    state.review.artifact = (detail.artifactIds || [])[0] || null;
    if (detail.approvers) renderRunApprovers(detail.approvers);
    renderRunReview();
  } catch (error) {
    if (!state.review || state.review.runId !== runId) return;
    state.review.error = error.message;
    renderRunReview();
  }
}

// 문서는 스냅샷이 이미 본문까지 들고 있다. 대화상자용으로 따로 받아 오면 같은 문서의 두
// 벌이 화면에 생기고, 어느 쪽이 최신인지 묻는 자리가 하나 더 늘어난다.
function reviewDocument(id) { return (state.snapshot.documents || []).find((item) => item.id === id) || null; }

function runTrailHtml(trail) {
  const rows = (trail || []).slice().reverse().slice(0, 12).map((entry) => {
    const label = entry.stepId ? `${entry.type} · ${entry.stepId}` : entry.type;
    const detail = [entry.clientId, entry.reason].filter(Boolean).join(' · ');
    return `<li><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</li>`;
  });
  return rows.length ? `<h3>이 런이 한 일</h3><ol class="review-trail">${rows.join('')}</ol>` : '';
}

function renderRunReview() {
  const review = state.review;
  const tabs = el('run-review-tabs');
  const body = el('run-review-document');
  const facts = el('run-review-facts');
  const trail = el('run-review-trail');
  if (!review) return;
  const detail = review.detail;
  if (!detail) {
    tabs.innerHTML = '';
    body.innerHTML = `<p class="empty-state">${escapeHtml(review.error || '승인할 내용을 읽는 중입니다.')}</p>`;
    facts.innerHTML = '';
    trail.innerHTML = '';
    return;
  }
  el('run-approve-goal').textContent = detail.goal || '';
  const task = detail.taskId ? (state.snapshot.tasks.tasks || []).find((item) => item.id === detail.taskId) : null;
  const rows = [
    ['절차', detail.procedure ? `${detail.procedure.name} rev.${detail.procedure.revision}` : '없음'],
    ['멈춘 스텝', detail.cursor || '없음'],
    ['지나온 스텝', (detail.completedSteps || []).join(' → ') || '없음'],
    ['태스크', task ? `${task.id} ${task.title}` : (detail.taskId || '결박 없음')],
    ['소유 Client', detail.owner || '없음']
  ];
  facts.innerHTML = '<h3>무엇을 승인하는가</h3><dl class="review-facts">' + rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('') + '</dl>';
  trail.innerHTML = runTrailHtml(detail.trail);
  const artifacts = detail.artifactIds || [];
  tabs.innerHTML = artifacts.map((id) => {
    const item = reviewDocument(id);
    return `<button type="button" data-review-artifact="${escapeHtml(id)}" class="${id === review.artifact ? 'active' : ''}">${escapeHtml(id)}${item ? ' ' + escapeHtml(item.title) : ''}</button>`;
  }).join('');
  tabs.hidden = artifacts.length < 2;
  if (!artifacts.length) {
    body.innerHTML = '<p class="empty-state">이 런은 문서를 지목하지 않았습니다. 무엇을 승인하는지는 위의 목표와 스텝 이력으로 판단하세요.</p>';
    return;
  }
  const documentValue = reviewDocument(review.artifact);
  if (!documentValue) {
    body.innerHTML = `<p class="empty-state">${escapeHtml(review.artifact)} 문서를 이 프로젝트에서 찾지 못했습니다. 아직 저장되지 않았거나 다른 브랜치에 있습니다.</p>`;
    return;
  }
  body.innerHTML = `<div class="review-document-head"><p class="eyebrow">${escapeHtml(documentValue.id)}</p><h3>${escapeHtml(documentValue.title)}</h3><div class="chip-row"><span class="chip">${escapeHtml(documentTypeLabel(documentValue))}</span><span class="chip">${escapeHtml(documentStateLabel(documentValue.state))}</span></div></div>` + markdown(documentValue.body);
  resolveDocumentImages(body, documentValue.file, state.project);
  renderMermaid();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-artifact]');
  if (!button || !state.review) return;
  state.review.artifact = button.dataset.reviewArtifact;
  renderRunReview();
});

el('open-run-document').addEventListener('click', () => {
  const artifact = state.review && state.review.artifact;
  if (!artifact) return message('열어 볼 문서가 없습니다.', true);
  el('run-approve-dialog').close();
  setView('document', artifact);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-run-approve]');
  if (!button) return;
  openRunApproval(button.dataset.runApprove);
});

el('refresh-runs').addEventListener('click', () => loadRuns(false));

el('run-approve-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const item = state.approvingRun;
  if (!item) return;
  const clientId = el('run-approve-client').value;
  const reason = el('run-approve-reason').value.trim();
  // 빠진 것을 하나씩 알린다. 사유를 강제하는 이유는 형식이 아니라, 나중에 "AI 검토가
  // 놓쳤나 사람이 건너뛰었나"를 구분할 수 있는 유일한 자리가 그 문장이기 때문이다.
  if (!clientId) return message('승인자를 고르세요. 활성 human Client만 사람 게이트를 지날 수 있습니다.', true);
  if (!reason) return message('무엇을 보고 승인했는지 사유가 필요합니다.', true);
  try {
    const result = await api(projectPath(`/runs/${encodeURIComponent(item.runId)}/approve`), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
      body: JSON.stringify({ clientId, reason })
    });
    el('run-approve-dialog').close();
    state.approvingRun = null;
    message(`${result.stepId} 스텝을 ${result.approvedBy} 자격으로 승인했습니다.`);
    await loadRuns(true);
  } catch (error) {
    // 거절은 그대로 옮긴다. 사람 게이트가 아닌 스텝, 검증이 본 커밋과 다른 HEAD,
    // 비활성 소유권은 서로 다른 문제이고, 한 문장으로 뭉개면 무엇을 고쳐야 하는지 사라진다.
    message(error.message, true);
  }
});
