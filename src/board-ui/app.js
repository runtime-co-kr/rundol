'use strict';

const token = document.querySelector('meta[name="rdl-token"]').content;
const state = { project: null, snapshot: null, view: 'home', selected: null, taskScope: 'all', currentMember: '', taskMode: 'list', documentFilter: '', query: '', polling: null, lastVisit: null, pendingTasks: new Map(), blockerResolve: null, cancellationResolve: null, newTaskBlocker: null, heldLease: null, leaseTimer: null, rejectedDraft: null };
const statusLabels = { todo: '할 일', doing: '진행 중', waiting: '대기', review: '검토', done: '완료', cancelled: '반려' };
// 완료와 반려는 게이트가 다르지만 둘 다 더 진행되지 않는다. 숨기기·접기·선행 판정은 같이 다룬다.
const TERMINAL_STATUSES = ['done', 'cancelled'];
const typeLabels = {
  project: '프로젝트', charter: '프로젝트 헌장', prd: '제품 요구사항', requirement: '요구사항',
  architecture: '아키텍처', screen: '화면 설계', model: '데이터 모델', api: 'API',
  adr: '의사결정 기록', decision: '의사결정 기록', test: '검증', runbook: '운영 가이드',
  glossary: '용어집', clipping: '수집 노트'
};
const documentStateLabels = {
  draft: '초안', proposed: '제안', active: '활성', review: '검토 중', approved: '승인됨',
  deprecated: '폐기 예정', archived: '보관됨', unread: '미확인'
};

function el(id) { return document.getElementById(id); }
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function message(value, error) { el('message').textContent = value || ''; el('message').style.color = error ? 'var(--red)' : ''; if (value) setTimeout(() => { if (el('message').textContent === value) el('message').textContent = ''; }, 5000); }
async function api(path, options) { const response = await fetch(path, options); const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value; }
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
  else if (state.view === 'home') renderHome();
  else if (state.view === 'people') renderPeople();
  else if (state.view === 'settings') renderSettings();
}

function documentCard(documentValue) {
  return `<button class="document-card" data-document="${escapeHtml(documentValue.id)}"><span class="eyebrow">${escapeHtml(documentValue.id)}</span><strong>${escapeHtml(documentValue.title)}</strong><small>${escapeHtml(documentValue.description || documentValue.file)}</small><span class="chip-row"><span class="chip">${escapeHtml(documentTypeLabel(documentValue))}</span><span class="chip">${escapeHtml(documentStateLabel(documentValue.state))}</span></span></button>`;
}
function renderHome() {
  const data = state.snapshot; const tasks = data.tasks.tasks; const documents = data.documents; const attention = data.attention;
  // 숫자를 보고 그 목록으로 갈 수 없으면 요약이 막다른 길이 된다. 지금까지 div였고
  // 눌러도 아무 일이 없었다. 각 지표를 그 수를 만든 화면으로 보낸다.
  const metrics = [
    [tasks.length, '전체 태스크', 'data-view="tasks"'],
    [documents.length, '프로젝트 문서', 'data-view="documents"'],
    [tasks.filter((task) => task.status === 'review').length, '검토 요청', 'data-view="review"'],
    [attention.length, '조치 필요', 'data-focus-attention="1"']
  ];
  el('metrics').innerHTML = metrics.map(([value, label, action]) => `<button type="button" class="metric" ${action}><strong>${value}</strong><span>${label}</span></button>`).join('');
  el('attention-count').textContent = attention.length;
  // 태스크는 그 태스크로 가고 동기화 항목은 동기화를 실행한다. 예전에는 둘 다 운영 상태
  // 화면으로 보냈는데 그 화면은 헤더와 이 목록의 중복이라 없앴다.
  el('attention-list').innerHTML = attention.length ? attention.slice(0, 12).map((item) => `<button class="attention-item" ${item.kind === 'task' ? `data-task="${escapeHtml(item.id)}"` : 'data-run-sync="1"'}><span class="severity ${item.severity}"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.reason)}</small></span><span>›</span></button>`).join('') : '<p class="empty-state">현재 조치가 필요한 항목이 없습니다.</p>';
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
  const mine = tasks.filter((task) => task.owner === state.currentMember && !TERMINAL_STATUSES.includes(task.status));
  const ready = mine.filter((task) => !taskBlockage(task));
  const blocked = mine.filter((task) => taskBlockage(task));
  const reviews = tasks.filter((task) => task.status === 'review' && (task.reviewers || []).includes(state.currentMember));
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

function renderDocuments() {
  const query = state.query.toLowerCase();
  const documents = state.snapshot.documents.filter((item) => (!state.documentFilter || (item.kind || item.type) === state.documentFilter) && (!query || `${item.id} ${item.title} ${item.description} ${item.file}`.toLowerCase().includes(query)));
  el('documents-list').innerHTML = documents.length ? documents.map((item) => `<button class="document-row" data-document="${escapeHtml(item.id)}"><span class="eyebrow">${escapeHtml(item.id)}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description || item.file)}</small><span class="chip">${escapeHtml(documentTypeLabel(item))} · ${escapeHtml(documentStateLabel(item.state))}</span></button>`).join('') : '<p class="empty-state">조건에 맞는 문서가 없습니다.</p>';
}

function ownerName(reference) { const match = /\|([^\]]+)\]\]/.exec(reference || ''); return match ? match[1] : reference || '미지정'; }
function personName(reference) { const person = state.snapshot.people.members.find((item) => item.id === reference) || state.snapshot.people.stakeholders.find((item) => item.id === reference); return person ? person.name : ownerName(reference); }
function contextSelect(field, current, options) { return `<select class="context-editor" data-task-field="${field}" aria-label="${field} 수정">${options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === (current || '') ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`; }
// 태스크 화면은 사이드와 전체화면 두 벌로 따로 있었고 구조가 서로 달라, 같은 태스크를
// 어디서 여느냐에 따라 다른 것이 보였다. 한 벌만 만들고 담는 그릇만 바꾼다.
// 순서는 제목 → 속성 → 내용이다. 속성은 짧고 개수가 고정이라 위에서 한눈에 지나가고,
// 길이를 알 수 없는 내용이 그 아래로 흐른다.
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
    row('상태', contextSelect('status', task.status, labelledEntries('taskStatuses', Object.keys(statusLabels)))),
    row('우선순위', contextSelect('priority', task.priority, labelledEntries('priorities', ['high', 'mid', 'low']))),
    row('소유자', contextSelect('owner', task.owner, members)),
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
    (task.externalRefs || []).length ? section('외부 참조', task.externalRefs.map((ref) => `<p>${escapeHtml(typeof ref === 'string' ? ref : JSON.stringify(ref))}</p>`).join('')) : ''
  ].filter(Boolean).join('');

  return `<article class="task-detail" data-task-detail="${escapeHtml(task.id)}">${head}${properties}${body}</article>`;
}

function renderContext(item, kind) {
  el('context-empty').hidden = true; el('context-content').hidden = false;
  if (kind === 'task') return void (el('context-content').innerHTML = taskDetailHtml(item, 'peek'));
  if (kind === 'document') {
    const linkedTasks = state.snapshot.tasks.tasks.filter((task) => (task.links || []).includes(item.id));
    el('context-content').innerHTML = `<section class="context-group"><h2>속성</h2><dl><div class="property"><dt>ID</dt><dd>${escapeHtml(item.id)}</dd></div><div class="property"><dt>유형</dt><dd>${escapeHtml(documentTypeLabel(item))}</dd></div><div class="property"><dt>상태</dt><dd>${escapeHtml(documentStateLabel(item.state))}</dd></div><div class="property"><dt>소유자</dt><dd>${escapeHtml(ownerName(item.owner))}</dd></div><div class="property"><dt>파일</dt><dd>${escapeHtml(item.file)}</dd></div></dl></section><section class="context-group"><h2>연결 태스크</h2>${linkedTasks.length ? linkedTasks.map((task) => `<button data-task="${task.id}">${escapeHtml(task.title)}</button>`).join('') : '<p class="empty-state">연결된 태스크 없음</p>'}</section><section class="context-group"><h2>검증</h2><p class="chip">strict snapshot 포함</p><small>${escapeHtml(item.revision.slice(0, 12))}</small></section>`;
  }
}
function renderDocument(id) { const item = state.snapshot.documents.find((documentValue) => documentValue.id === id); if (!item) return setView('documents'); el('document-breadcrumb').innerHTML = breadcrumb([{ label: state.project, view: 'home' }, { label: '문서', view: 'documents' }, { label: item.id }]);
  renderLeaseBanner(item.id); el('document-title').textContent = item.title; el('document-description').textContent = item.description; el('document-badges').innerHTML = [item.id, documentTypeLabel(item), documentStateLabel(item.state), ownerName(item.owner)].filter(Boolean).map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join(''); el('document-body').innerHTML = markdown(item.body); el('document-body').hidden = false; el('document-editor').hidden = true; el('edit-document').hidden = false; el('cancel-document-edit').hidden = true; el('save-document').hidden = true; renderContext(item, 'document'); renderMermaid(); }

// 무엇이 막혀 있는지가 목록에서 가장 먼저 읽혀야 한다. 사람 대기(blocker)는 값으로 있었지만
// 끝나지 않은 선행 태스크(deps)는 어디에도 보이지 않아, 목록만 보면 시작할 수 있는 일처럼 읽혔다.
function taskBlockage(task) {
  if (task.blocker) return { kind: 'waiting', label: `${personName(task.blocker.waitingFor)} 대기`, detail: task.blocker.condition || '' };
  const open = (task.deps || []).map((id) => state.snapshot.tasks.tasks.find((item) => item.id === id)).filter((item) => item && !TERMINAL_STATUSES.includes(item.status));
  if (!open.length) return null;
  return { kind: 'deps', label: `선행 ${open.length}건`, detail: open.map((item) => `${item.id} ${item.title}`).join('\n') };
}
function taskRow(task) {
  const completed = Object.values(task.acceptanceCriteria || {}).filter((item) => item.done).length;
  const total = Object.keys(task.acceptanceCriteria || {}).length;
  const blockage = taskBlockage(task);
  const badge = blockage ? `<span class="task-blocked" data-blocked="${blockage.kind}" title="${escapeHtml(blockage.detail)}">${escapeHtml(blockage.label)}</span>` : '';
  return `<button class="task-row" data-task="${task.id}"><span class="task-row-main"><span class="task-row-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>${badge}</span><span class="task-prio" data-prio="${escapeHtml(task.priority)}">${escapeHtml(priorityLabel(task.priority))}</span><span class="task-row-meta">${escapeHtml(personName(task.owner))} · ${completed}/${total}</span></button>`;
}
// 묶음. 평평한 목록은 33행이 한 벽으로 보여 무엇이 남았는지 읽히지 않는다.
// 상태로 묶으면 완료 묶음이 생기고 기본으로 접는다. 개수는 남으므로 진행감은 잃지 않는다.
const groupers = {
  status: { order: () => Object.keys(statusLabels), key: (task) => task.status, label: (key) => taskStatusLabel(key) },
  owner: { order: null, key: (task) => task.owner || '', label: (key) => personName(key) || '미지정' },
  priority: { order: () => ['high', 'mid', 'low'], key: (task) => task.priority, label: (key) => priorityLabel(key) }
};
function groupCollapsed(groupBy, key) {
  const saved = viewOption(`collapse.${groupBy}.${key}`, null);
  if (saved !== null) return saved === '1';
  return groupBy === 'status' && TERMINAL_STATUSES.includes(key);
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
      return `<section class="task-group${collapsed ? ' collapsed' : ''}"><button class="task-group-head" data-group-toggle="${escapeHtml(`${groupBy}.${key}`)}" aria-expanded="${!collapsed}"><span class="group-caret">${collapsed ? '▸' : '▾'}</span><span class="chip">${escapeHtml(grouper.label(key))}</span><span class="badge">${items.length}</span></button>${collapsed ? '' : items.map(taskRow).join('')}</section>`;
    })
    .join('');
}
function renderTasks() { const scopes = { all: ['전체 태스크', '프로젝트의 모든 작업을 목록과 Board로 확인합니다.'], mine: ['내 작업', '현재 사용자에게 할당된 작업입니다.'], review: ['내 검토', '현재 사용자가 검토자로 지정된 검토 대기 작업입니다.'] }; const [heading, description] = scopes[state.taskScope]; el('tasks-heading').textContent = heading; el('tasks-description').textContent = description; let tasks = state.snapshot.tasks.tasks; if (state.taskScope !== 'all' && !state.currentMember) { el('task-list').hidden = false; el('board').hidden = true; el('task-graph').hidden = true; el('task-list').innerHTML = '<p class="identity-prompt">헤더에서 보기 기준을 고르면 개인 작업과 검토 요청을 정확히 구분할 수 있습니다.</p>'; return; } if (state.taskScope === 'mine') tasks = tasks.filter((task) => task.owner === state.currentMember); if (state.taskScope === 'review') tasks = tasks.filter((task) => task.status === 'review' && (task.reviewers || []).includes(state.currentMember)); const query = state.query.toLowerCase(); tasks = tasks.filter((task) => (!query || `${task.id} ${task.title} ${task.summary || ''}`.toLowerCase().includes(query)) && (!el('owner').value || task.owner === el('owner').value) && (!el('priority').value || task.priority === el('priority').value));
  // 완료 숨기기는 접기와 다른 일을 한다. 접기는 묶음 머리글을 남기고, 숨기기는 항목을 뺀다.
  // 담당자나 우선순위로 묶으면 완료 묶음이 없으므로 그때는 이 필터가 그 역할을 한다.
  if (el('hide-done').checked) tasks = tasks.filter((task) => !TERMINAL_STATUSES.includes(task.status));
  el('task-list').hidden = state.taskMode !== 'list';
  el('board').hidden = state.taskMode !== 'board';
  el('task-graph').hidden = state.taskMode !== 'graph';
  // Board는 화면 높이에 고정되어 레인마다 따로 스크롤한다. 바깥이 스크롤되면 레인
  // 머리글이 위로 밀려 어느 열을 보고 있는지 놓친다. 그 배치를 body가 알아야 한다.
  document.body.classList.toggle('board-mode', state.taskMode === 'board');
  if (state.taskMode === 'list') el('task-list').innerHTML = tasks.length ? taskGroups(tasks) : '<p class="empty-state">조건에 맞는 태스크가 없습니다.</p>';
  else if (state.taskMode === 'board') renderBoard(tasks); else renderTaskGraph(tasks); }
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
  el('board').innerHTML = Object.keys(statusLabels).map((status) => {
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
    .map((task) => `  ${task.id}["${nodeLabel(`${task.status === 'done' ? '✓ ' : ''}${task.id} ${task.title}`)}"]`);
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
  el('task-page').innerHTML = taskDetailHtml(task, 'page');
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
  const open = tasks.filter((task) => !TERMINAL_STATUSES.includes(task.status));
  const documents = state.snapshot.documents.filter((item) => String(item.owner || '').includes(entry.id));
  return `<article class="task-detail"><header class="task-detail-head"><p class="eyebrow">${escapeHtml(labels[group] || group)} · ${escapeHtml(entry.id)}</p><h1>${escapeHtml(entry.name || entry.id)}</h1></header>`
    + `<dl class="task-properties">${fields.map(([label, value]) => `<div class="property"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(plainText(value))}</dd></div>`).join('') || '<div class="property"><dt>설명</dt><dd>없음</dd></div>'}</dl>`
    + `<section class="task-detail-section"><h2>맡은 태스크 <span class="badge">${open.length}/${tasks.length}</span></h2>${tasks.length ? `<div class="task-table">${tasks.slice(0, 8).map(taskRow).join('')}</div>` : '<p class="empty-state">연결된 태스크가 없습니다.</p>'}</section>`
    + `<section class="task-detail-section"><h2>소유 문서 <span class="badge">${documents.length}</span></h2>${documents.length ? `<div class="card-grid">${documents.slice(0, 6).map(documentCard).join('')}</div>` : '<p class="empty-state">소유한 문서가 없습니다.</p>'}</section>`
    + '<p class="control-hint">project.md가 정본입니다. 추가와 수정은 <code>rdl member</code> 명령이 담당합니다.</p></article>';
}

function populateControls() { const members = state.snapshot.people.members; el('owner').replaceChildren(new Option('모두', ''), ...members.map((item) => new Option(item.name, item.id)));
  // 저장해 둔 표시 옵션을 컨트롤에 되돌린다. 값이 사라진 담당자를 가리키면 무시한다.
  const savedOwner = viewOption('owner', '');
  el('owner').value = members.some((item) => item.id === savedOwner) ? savedOwner : '';
  el('priority').value = viewOption('priority', '');
  el('group-by').value = groupers[viewOption('groupBy', 'status')] ? viewOption('groupBy', 'status') : 'status';
  el('hide-done').checked = viewOption('hideDone', '') === '1'; el('task-owner').replaceChildren(new Option('미지정', ''), ...members.map((item) => new Option(item.name, item.id))); // 새로 만드는 태스크는 아직 끝나지도, 접히지도 않았다. 종료 상태를 고르게 두면
// 완료는 수용조건과 TST를, 반려는 사유를 요구해 생성이 그대로 거부된다.
el('task-status').replaceChildren(...labelledEntries('taskStatuses', Object.keys(statusLabels).filter((value) => !TERMINAL_STATUSES.includes(value))).map(([value, label]) => new Option(label, value))); const saved = localStorage.getItem(`rundol.currentMember.${state.project}`) || ''; state.currentMember = members.some((item) => item.id === saved) ? saved : ''; el('current-member').replaceChildren(new Option('사용자 선택', ''), ...members.map((item) => new Option(item.name, item.id))); el('current-member').value = state.currentMember; }
function updateHealth() { const count = state.snapshot.attention.length; const health = el('health'); health.className = `health ${count ? 'warning' : ''}`; el('health-label').textContent = count ? `조치 필요 ${count}` : '정상'; el('operation-count').textContent = count || ''; renderSyncStatus(); }

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
  el('sync-status').disabled = !sync || (!sync.ahead && !sync.behind && !sync.changedFiles && !(sync.conflicts || []).length);
  el('sync-status').title = sync ? `${sync.remoteRef || '원격 없음'} · ${sync.state}` : '';
}
// 편집 중에는 화면을 다시 그리지 않는다. setView가 renderDocument를 거쳐 편집기를 닫으므로
// 폴링이 3초마다 입력 중인 내용을 지워버린다. 스냅샷은 계속 받되 렌더링만 미룬다.
// 두 가드는 성격이 다르다. 문서 편집 중 스냅샷을 갈아끼우면 draft가 기반으로 삼은
// revision까지 최신이 되어 저장이 남의 변경을 조용히 덮어쓴다. 이건 안전 문제라 어떤
// 경로에서도 어기지 않는다. 반면 태스크 변경이 큐에 있는 동안의 폴링은 낙관적 표시를
// 지우는 표시 문제이고, 저장 직후 새 revision을 받는 경로는 오히려 갈아끼워야 한다.
function isDocumentEditing() { return !el('document-editor').hidden; }
function isEditing() { return isDocumentEditing() || state.pendingTasks.size > 0; }
async function loadSnapshot(silent, options) {
  try {
    const next = await api(projectPath('/board-snapshot'));
    if (isDocumentEditing()) return;
    if (state.pendingTasks.size > 0 && !(options && options.settlingTask)) return;
    const changed = !state.snapshot || JSON.stringify(state.snapshot.revision) !== JSON.stringify(next.revision);
    state.snapshot = next;
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
function startPolling() { stopPolling(); if (document.visibilityState === 'visible') state.polling = setInterval(() => loadSnapshot(true), POLL_INTERVAL); }
function stopPolling() { if (state.polling) clearInterval(state.polling); state.polling = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { loadSnapshot(true); startPolling(); return; }
  stopPolling();
  markVisit();
});
window.addEventListener('pagehide', markVisit);

document.addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; if (button.dataset.view) { if (button.dataset.view === 'tasks') state.taskScope = 'all'; return setView(button.dataset.view); } if (button.dataset.document) return setView('document', button.dataset.document); if (button.dataset.documentFilter !== undefined) { state.documentFilter = button.dataset.documentFilter; return setView('documents'); } // Plane의 side peek. 목록에서 고른 태스크는 화면을 갈아치우지 않고 Context 패널에 연다.
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
  if (status === 'waiting') {
    const blocker = await requestBlocker(task.blocker);
    if (!blocker) { input.value = task.status; return message('대기 사유를 입력하지 않아 상태를 바꾸지 않았습니다.'); }
    return queueTaskUpdate(task, Object.assign(cleared, { status, blocker }));
  }
  if (status === 'cancelled') {
    const cancellation = await requestCancellation(task.cancellation);
    if (!cancellation) { input.value = task.status; return message('반려 사유를 입력하지 않아 상태를 바꾸지 않았습니다.'); }
    return queueTaskUpdate(task, Object.assign(cleared, { status, cancellation }));
  }
  queueTaskUpdate(task, Object.assign(cleared, { status }));
});
el('global-search').addEventListener('input', (event) => { state.query = event.target.value.trim(); if (state.view !== 'documents' && state.view !== 'tasks') setView('documents'); else setView(state.view); });
el('project-switcher').addEventListener('change', async (event) => { markVisit(); state.project = event.target.value; state.snapshot = null; state.lastVisit = localStorage.getItem(visitKey()); await loadSnapshot(true); });
el('current-member').addEventListener('change', (event) => { state.currentMember = event.target.value; if (state.currentMember) localStorage.setItem(`rundol.currentMember.${state.project}`, state.currentMember); else localStorage.removeItem(`rundol.currentMember.${state.project}`); if (state.view === 'tasks') renderTasks(); if (state.view === 'home') renderHome(); if (el('settings-member').value !== state.currentMember) el('settings-member').value = state.currentMember; });
el('theme-system').addEventListener('click', () => applyTheme('system')); el('theme-dark').addEventListener('click', () => applyTheme('dark')); el('theme-light').addEventListener('click', () => applyTheme('light'));
for (const button of document.querySelectorAll('[data-task-scope]')) button.addEventListener('click', () => { state.taskScope = button.dataset.taskScope; setView('tasks'); });
// 설정 목차는 한 번에 한 묶음만 연다. 계약·표시 설정은 나중에 주입되므로 클릭 시점에 찾는다.
function showSettingsSection(name) {
  const target = name || 'settings-appearance';
  for (const item of document.querySelectorAll('[data-settings-section]')) item.classList.toggle('active', item.dataset.settingsSection === target);
  for (const panel of document.querySelectorAll('#settings-panels > .settings-panel')) panel.classList.toggle('active', panel.id === target);
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-settings-section]');
  if (button) showSettingsSection(button.dataset.settingsSection);
});
el('refresh').addEventListener('click', () => loadSnapshot(false));
for (const [id, option] of [['owner', 'owner'], ['priority', 'priority'], ['group-by', 'groupBy']]) {
  el(id).addEventListener('change', () => { setViewOption(option, el(id).value); renderTasks(); });
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
  if (el('task-status').value !== 'waiting') { state.newTaskBlocker = null; return; }
  const blocker = await requestBlocker(state.newTaskBlocker);
  if (blocker) { state.newTaskBlocker = blocker; return; }
  el('task-status').value = 'todo';
  state.newTaskBlocker = null;
  message('대기 사유를 입력하지 않아 상태를 할 일로 되돌렸습니다.');
});
// Plane의 quick add. 흔한 경우는 제목 하나뿐인데 모달을 열게 하면 매번 여섯 필드를 지나야 한다.
// 한 줄 추가는 없앴다. 태스크에는 완료조건이 반드시 있어야 하고, 그걸 한 줄에 끼워 넣으면
// 빠르지도 않으면서 대충 적게 만든다. 만드는 길은 다이얼로그 하나로 둔다.
el('new-task').addEventListener('click', () => { el('task-id').textContent = 'NEW TASK'; el('task-title').value = ''; el('task-summary').value = ''; el('task-acceptance').value = ''; el('task-links').value = ''; el('task-status').value = 'todo'; state.newTaskBlocker = null; el('task-dialog').showModal(); el('task-title').focus(); });
// ── 편집 lease ────────────────────────────────────────────
// 저장 시점의 revision 검사만으로는 데이터는 지켜도 작업은 지키지 못한다.
// 30분 편집한 뒤 거부되면 되돌릴 방법이 없으므로 시작 전에 lease를 잡는다.
function leasePath(documentId, action) { return projectPath(`/leases/${encodeURIComponent(documentId)}/${action}`); }
async function leaseAction(documentId, action) {
  return api(leasePath(documentId, action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
    body: JSON.stringify({ clientId: state.snapshot.client.id })
  });
}
function stopLeaseRenewal() { if (state.leaseTimer) clearInterval(state.leaseTimer); state.leaseTimer = null; }
async function releaseLease() {
  stopLeaseRenewal();
  const held = state.heldLease;
  state.heldLease = null;
  if (held) try { await leaseAction(held, 'release'); } catch (error) { message(error.message, true); }
}
function documentHolder(documentId) {
  return (state.snapshot.leases || []).find((item) => item.documentId === documentId && item.clientId !== state.snapshot.client.id) || null;
}
function renderLeaseBanner(documentId) {
  const holder = documentHolder(documentId);
  el('document-lease').innerHTML = holder
    ? `<span class="chip lease-held">${escapeHtml(personName(holder.memberId) || holder.clientId)} 편집 중 · ${escapeHtml(holder.expiresAt)}까지</span>`
    : (state.heldLease === documentId ? '<span class="chip lease-mine">내가 편집 중</span>' : '');
  el('edit-document').disabled = Boolean(holder);
}
function enterEditing(item) {
  el('document-editor').value = item.body;
  el('document-body').hidden = true;
  el('document-editor').hidden = false;
  el('edit-document').hidden = true;
  el('cancel-document-edit').hidden = false;
  el('save-document').hidden = false;
  el('document-editor').focus();
}
el('edit-document').addEventListener('click', async () => {
  const item = state.snapshot.documents.find((value) => value.id === state.selected);
  if (!item) return;
  // 등록되지 않은 Client는 lease를 만들 수 없다. 무엇을 해야 하는지 알려준다.
  if (!state.snapshot.client.registered) {
    return message(`이 기기를 Client로 등록해야 협업 편집을 시작할 수 있습니다: rdl client register ${state.snapshot.client.id} --name "<이름>" --type device --owner <MEMBER-ID>`, true);
  }
  const holder = documentHolder(item.id);
  if (holder) return message(`${personName(holder.memberId) || holder.clientId}가 편집 중입니다. ${holder.expiresAt}까지 유효합니다.`, true);
  // acquire는 자기 lease에도 실패한다. 브라우저가 갱신 중 죽으면 남은 lease 때문에
  // 자기 문서를 5분간 못 여는 셈이므로, 내 것이 남아 있으면 갱신으로 이어받는다.
  const mine = (state.snapshot.leases || []).find((lease) => lease.documentId === item.id && lease.clientId === state.snapshot.client.id);
  try {
    await leaseAction(item.id, mine ? 'renew' : 'acquire');
    state.heldLease = item.id;
    renderLeaseBanner(item.id);
    stopLeaseRenewal();
    // TTL이 5분이므로 그 절반마다 갱신한다. 브라우저가 닫히면 갱신이 멈춰 자동 만료된다.
    state.leaseTimer = setInterval(() => {
      leaseAction(item.id, 'renew').catch((error) => { message(`편집 임대 갱신 실패: ${error.message}`, true); stopLeaseRenewal(); });
    }, 150000);
    enterEditing(item);
  } catch (error) {
    message(error.message, true);
  }
});
el('cancel-document-edit').addEventListener('click', async () => { await releaseLease(); renderDocument(state.selected); });
// sendBeacon은 헤더를 실을 수 없어 인증 토큰이 빠지고 서버가 403으로 버린다. 임대는
// 풀리지 않은 채 TTL이 다 갈 때까지 남는다. keepalive fetch는 헤더를 그대로 보낸다.
window.addEventListener('beforeunload', () => {
  if (!state.heldLease) return;
  fetch(leasePath(state.heldLease, 'release'), {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
    body: JSON.stringify({ clientId: state.snapshot.client.id })
  }).catch(() => {});
});
el('save-document').addEventListener('click', async () => {
  const item = state.snapshot.documents.find((value) => value.id === state.selected);
  if (!item) return;
  const draft = el('document-editor').value;
  try {
    const saved = await api(projectPath(`/documents/${encodeURIComponent(item.id)}`), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify({ baseRevision: item.revision, body: draft, clientId: state.snapshot.client && state.snapshot.client.id }) });
    await releaseLease();
    // 저장은 편집의 끝이다. 편집기를 열어둔 채 스냅샷을 불러오면 isEditing() 가드에
    // 걸려 갱신이 통째로 건너뛰어지고, 다음 저장이 오래된 revision으로 나가 409가 난다.
    el('document-editor').hidden = true;
    state.rejectedDraft = null;
    await loadSnapshot(true);
    // 남의 lease와 어긋난 저장도 통과시킨다. 막으면 브라우저가 죽어 남은 5분짜리
    // lease가 그동안 저장을 통째로 잠근다. 대신 누구와 겹쳤는지는 반드시 알린다.
    const notice = saved && saved.leaseNotice;
    message(notice
      ? `문서를 저장했습니다. ${personName(notice.memberId) || notice.holder}님이 같은 문서를 열어 두었습니다(${notice.expiresAt}까지). 변경 내용을 서로 확인하세요.`
      : '문서를 저장하고 검증했습니다.', Boolean(notice));
  } catch (error) {
    // 저장이 거부돼도 편집기 내용은 남긴다. 여기서 지우면 작업이 사라진다.
    el('document-editor').value = draft;
    state.rejectedDraft = { id: item.id, body: draft };
    message(`${error.message} 편집 내용은 편집기에 그대로 있습니다.`, true);
  }
});
el('task-form').addEventListener('submit', async (event) => { event.preventDefault(); const status = el('task-status').value; if (status === 'waiting' && !state.newTaskBlocker) return message('대기 상태로 만들려면 대기 사유를 먼저 입력하세요.', true); const lines = el('task-acceptance').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const acceptanceCriteria = Object.fromEntries(lines.map((text, index) => [`AC-${String(index + 1).padStart(3, '0')}`, { text, done: false }])); try { await api(projectPath('/tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify({ title: el('task-title').value, summary: el('task-summary').value, status, priority: el('task-priority').value, owner: el('task-owner').value || null, blocker: status === 'waiting' ? state.newTaskBlocker : null, links: el('task-links').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), acceptanceCriteria }) }); el('task-dialog').close(); await loadSnapshot(true); message('태스크를 생성했습니다.'); } catch (error) { message(error.message, true); } });
// push는 이 화면에서 가장 되돌리기 어려운 동작이다. 무엇이 나가는지 보여주고 확인받는다.
async function runSync() {
  const sync = state.snapshot.sync;
  const lines = [];
  if (sync.changedFiles) lines.push(`로컬 변경 ${sync.changedFiles}건을 커밋합니다.`);
  if (sync.ahead) lines.push(`커밋 ${sync.ahead}건을 ${sync.remoteRef || '원격'}으로 올립니다.`);
  if (sync.behind) lines.push(`원격의 커밋 ${sync.behind}건을 받습니다.`);
  if ((sync.conflicts || []).length) lines.push(`충돌 ${sync.conflicts.length}건을 먼저 해결해야 합니다.`);
  if (!lines.length) return;
  if (!confirm(`${lines.join('\n')}\n\n계속할까요?`)) return;
  try {
    message('동기화를 실행하고 있습니다.');
    await api(projectPath('/sync'), { method: 'POST', headers: { 'X-Rundol-Token': token } });
    await loadSnapshot(true);
    message('동기화를 완료했습니다.');
  } catch (error) {
    message(error.message, true);
  }
}
el('sync-status').addEventListener('click', runSync);
document.addEventListener('click', (event) => { if (event.target.closest('[data-run-sync]')) runSync(); });
// 조치 필요는 옮겨 갈 화면이 따로 없다. 같은 화면 아래 목록이 그 내역이므로 그리로 데려간다.
document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-focus-attention]')) return;
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
  el('settings-panels').insertAdjacentHTML('beforeend', `<section id="contract-settings" class="settings-panel contract-settings"><header class="section-heading"><div><h2>문서 계획 계약</h2><p id="contract-summary"></p></div><div class="page-actions"><button id="save-preset" hidden>프리셋으로 저장</button><button id="save-contract" class="primary">계약 저장</button></div></header><div class="form-grid"><label>프로필<select id="contract-profile"></select><small id="contract-profile-hint" class="control-hint"></small></label><label>강제 수준<select id="contract-enforcement"></select><small id="contract-enforcement-hint" class="control-hint"></small></label></div><p id="implementation-contract-summary" class="control-hint"></p><p class="control-hint">AI 추천 문맥은 작성 품질을 돕는 참고 문서이며 생성·저장을 차단하지 않습니다.</p><div id="contract-rules" class="contract-table" aria-label="문서 계약 규칙"></div></section>`);
}
function contractComponent(value) { return `<span class="component-chip" data-contract-section="${escapeHtml(value)}"><span>${escapeHtml(value)}</span><button type="button" data-component-remove aria-label="${escapeHtml(value)} 제거">×</button></span>`; }
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
  const matches = Boolean(choice && choice.policy && samePolicy(choice.policy, rows));
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
function renderPresentationSettings() {
  let section = el('presentation-settings');
  if (!section) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="presentation-settings" class="settings-panel"><header><h2>문서 표시 규칙</h2><p>어떤 문서 타입을 어떤 이름과 순서로 보여줄지 정합니다. 설정 파일이라 여기서는 바꾸지 않고 <code>board.json</code>을 직접 편집합니다.</p></header><div class="settings-body"><div id="presentation-inheritance" class="inheritance-chain"></div><div id="presentation-source" class="presentation-source"></div><div id="presentation-types" class="presentation-types"></div></div></section>');
    section = el('presentation-settings');
  }
  const presentation = state.snapshot.presentation;
  const inherited = presentation.inheritance;
  el('presentation-inheritance').innerHTML = `<span class="inheritance-node active">내장 기본값</span><span>→</span><span class="inheritance-node ${inherited.workspace.configured ? 'active' : ''}">Workspace board.json</span><span>→</span><span class="inheritance-node ${inherited.project.configured ? 'active' : ''}">프로젝트 board.json</span>`;
  // 어느 파일을 열어야 하는지 알려주는 게 이 화면의 전부다. 경로를 tooltip에만 두면 찾을 수 없다.
  el('presentation-source').innerHTML = [['Workspace', inherited.workspace], ['프로젝트', inherited.project]]
    .map(([label, item]) => `<div class="property"><dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(item.file)}</code><small>${item.configured ? '이 파일이 값을 덮어쓰고 있습니다.' : '아직 없어 상위 값을 그대로 씁니다.'}</small></dd></div>`).join('');
  el('presentation-types').innerHTML = Object.entries(presentation.documentTypes).sort((left, right) => left[1].order - right[1].order).map(([kind, item]) => `<article><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(kind)} · ${escapeHtml(item.description)}</small></article>`).join('');
}
// 계약 준수. 규칙을 정하는 화면은 있었는데 그 규칙이 지켜지는지 보는 화면이 없었다.
// 여기 쓰는 값은 전부 스냅샷에 이미 실려 오던 것이라 새로 계산하지 않는다.
const enforcementNote = {
  advisory: '위반을 보고만 하고 저장·동기화를 막지 않습니다.',
  checkpoint: '위반이 남아 있으면 rdl save와 rdl sync가 차단됩니다.'
};
const policyNote = {
  required: '없으면 위반입니다.',
  recommended: '없으면 경고이며 checkpoint에서도 차단하지 않습니다.',
  onDemand: '필요할 때만 만듭니다.',
  disabled: '만들면 위반이며 흡수 규칙이 대신 담습니다.'
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

  // 흡수 판정은 유형 단위라 대상 문서 하나만 섹션을 가져도 satisfied가 된다. 그 하나 뒤에
  // 가려진 현황을 evaluator가 계산해 주므로 화면에서 다시 세지 않고 그대로 쓴다.
  // 일부만 가진 문서는 미완성이라 단정할 수 있어 눈에 띄게, 전혀 없는 문서는 판정 불가라 조용히.
  const absorbed = (evaluation.absorbed || []).filter((item) => item.disposition === 'absorbed').map((item) => {
    const complete = (item.complete || []).length;
    const partial = item.partial || [];
    const absent = (item.absent || []).length;
    const total = complete + partial.length + absent;
    const tone = partial.length ? 'warning' : item.satisfied ? 'ok' : 'error';
    return `<div class="compliance-item ${tone}"><strong>${escapeHtml(item.type)} → ${escapeHtml(item.absorbedBy)}</strong><span>${escapeHtml((item.sections || []).join(' · '))}</span><small>${escapeHtml(item.absorbedBy)} ${total}건 중 모두 보유 ${complete} · 일부만 ${partial.length} · 없음 ${absent}${partial.length ? ` — 일부만 가진 문서: ${escapeHtml(partial.join(', '))}` : ''}</small></div>`;
  });

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
    <section class="compliance-group"><h3>기능 추적성 — 준비 ${trace.summary.ready}/${trace.summary.functions}</h3>${complianceList(incomplete, '선언된 기능이 모두 REQ와 TST 계약을 갖췄습니다.')}</section>
    <section class="compliance-group"><h3>흡수 규칙</h3>${complianceList(absorbed, '비활성 유형이 없습니다.')}</section>`;
}
function renderSettings() {
  // 등록과 삭제는 CLI가 담당한다. 여기서는 활성 상태만 바꾼다 — 에이전트가 늘면 자주 쓰는 동작이다.
  const members = state.snapshot.people.members;
  const memberName = (id) => (members.find((item) => item.id === id) || {}).name || id || '미지정';
  el('clients').innerHTML = state.snapshot.clients.map((item) => {
    const self = item.id === state.snapshot.client.id;
    return `<div class="setting-row"><div><strong>${escapeHtml(item.name)}${self ? ' <span class="chip">이 기기</span>' : ''}</strong><p>${escapeHtml(item.id)} · ${escapeHtml(item.type)} · ${escapeHtml(memberName(item.owner))}</p></div><div class="setting-control"><span class="chip ${item.status === 'active' ? 'lease-mine' : ''}">${escapeHtml(item.status)}</span><button data-client-toggle="${escapeHtml(item.id)}" data-client-status="${item.status === 'active' ? 'disabled' : 'active'}">${item.status === 'active' ? '비활성화' : '활성화'}</button></div></div>`;
  }).join('') || `<p class="empty-state">등록된 Client가 없습니다. <code>rdl client register ${escapeHtml(state.snapshot.client.id)} --name "&lt;이름&gt;" --type device --owner &lt;MEMBER-ID&gt;</code></p>`;
  el('settings-member').replaceChildren(new Option('선택 안 함', ''), ...members.map((item) => new Option(item.name, item.id)));
  el('settings-member').value = state.currentMember || '';
  // 임대는 운영 상태 화면에 있었지만 그 화면의 나머지(SYNC·ATTENTION)는 헤더·홈과 중복이고
  // WATCH는 빈 자리표시자였다. 임대는 Workspace 범위이므로 Clients 옆이 제자리다.
  el('leases').innerHTML = state.snapshot.leases.map((item) => `<article class="entity-card"><strong>${escapeHtml(item.documentId)}</strong><small>${escapeHtml(documentHolder(item.documentId) || item.clientId)} · ${escapeHtml(relativeTime(item.expiresAt))} 만료</small></article>`).join('') || '<p class="empty-state">지금 편집 중인 문서가 없습니다.</p>';
  renderPresentationSettings(); renderContractSettings(); renderContractCompliance();
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
  if (row && suggestion) { addContractComponent(row, suggestion.dataset.componentSuggestion); return; }
  const remove = event.target.closest('[data-component-remove]');
  if (row && remove) { const component = remove.closest('[data-contract-section]'); const value = component.dataset.contractSection; component.remove(); setSuggestionState(row, value, false); return; }
  const add = event.target.closest('[data-component-add]');
  if (row && add) { const input = row.querySelector('[data-component-input]'); if (addContractComponent(row, input.value)) input.value = ''; return; }
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
