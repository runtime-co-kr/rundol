'use strict';

const token = document.querySelector('meta[name="rdl-token"]').content;
const state = { project: null, snapshot: null, view: 'home', selected: null, taskScope: 'all', currentMember: '', taskMode: 'list', documentFilter: '', query: '', polling: null, pendingTasks: new Map(), blockerResolve: null, newTaskBlocker: null, heldLease: null, leaseTimer: null, rejectedDraft: null };
const statusLabels = { todo: '할 일', doing: '진행 중', waiting: '대기', review: '검토', done: '완료' };
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

function markdown(source) {
  if (!window.marked || !window.DOMPurify) return `<pre>${escapeHtml(source || '')}</pre>`;
  const renderer = new window.marked.Renderer();
  renderer.code = ({ text, lang }) => String(lang || '').toLowerCase() === 'mermaid' ? `<pre class="mermaid">${escapeHtml(text)}</pre>` : `<pre><code class="language-${escapeHtml(lang || '')}">${escapeHtml(text)}</code></pre>`;
  const prepared = String(source || '').replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target, label) => `[${label || target}](#document=${encodeURIComponent(target)})`);
  const html = window.marked.parse(prepared, { gfm: true, breaks: false, renderer });
  return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

function lightTheme() { return document.body.classList.contains('theme-light') || (document.body.classList.contains('theme-system') && matchMedia('(prefers-color-scheme: light)').matches); }
function themeToken(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }
function mermaidThemeVariables() {
  return {
    darkMode: !lightTheme(),
    background: themeToken('--panel'), mainBkg: themeToken('--panel2'), tertiaryColor: themeToken('--panel'),
    primaryColor: themeToken('--panel2'), primaryTextColor: themeToken('--text'), primaryBorderColor: themeToken('--muted'),
    nodeBorder: themeToken('--muted'), lineColor: themeToken('--muted'), textColor: themeToken('--text'),
    edgeLabelBackground: themeToken('--panel'),
    attributeBackgroundColorOdd: themeToken('--panel'), attributeBackgroundColorEven: themeToken('--panel2')
  };
}
async function renderMermaid() { if (!window.mermaid) return; const nodes = Array.from(document.querySelectorAll('.mermaid')); if (!nodes.length) return; try { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: mermaidThemeVariables() }); await window.mermaid.run({ nodes }); } catch (error) { message(`Mermaid 렌더링 실패: ${error.message}`, true); } }
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

function queueTaskUpdate(task, changes) { let pending = state.pendingTasks.get(task.id); if (!pending) pending = { baseRevision: task.revision, changes: {}, timer: null }; Object.assign(pending.changes, changes); Object.assign(task, changes); clearTimeout(pending.timer); pending.timer = setTimeout(() => flushTaskUpdate(task.id), 500); state.pendingTasks.set(task.id, pending); if (state.view === 'task' && state.selected === task.id) renderTask(task.id); }
async function flushTaskUpdate(taskId) { const pending = state.pendingTasks.get(taskId); if (!pending) return; pending.timer = null; try { await api(projectPath(`/tasks/${encodeURIComponent(taskId)}`), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify(Object.assign({ baseRevision: pending.baseRevision }, pending.changes)) }); state.pendingTasks.delete(taskId); await loadSnapshot(true); if (state.view === 'task' && state.selected === taskId) renderTask(taskId); message('태스크 변경을 파일에 저장했습니다.'); } catch (error) { state.pendingTasks.delete(taskId); await loadSnapshot(true); if (state.view === 'task' && state.selected === taskId) renderTask(taskId); message(`변경을 되돌렸습니다: ${error.message}`, true); } }

// 화면 이름을 body에 남겨 선택 대상이 없는 화면에서 Context 패널을 접는다.
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
function markViewOnBody(view) {
  for (const name of Array.from(document.body.classList)) if (name.startsWith('view-')) document.body.classList.remove(name);
  document.body.classList.add(`view-${view}`);
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
  else if (state.view === 'operations') renderOperations();
  else if (state.view === 'settings') renderSettings();
}

function documentCard(documentValue) {
  return `<button class="document-card" data-document="${escapeHtml(documentValue.id)}"><span class="eyebrow">${escapeHtml(documentValue.id)}</span><strong>${escapeHtml(documentValue.title)}</strong><small>${escapeHtml(documentValue.description || documentValue.file)}</small><span class="chip-row"><span class="chip">${escapeHtml(documentTypeLabel(documentValue))}</span><span class="chip">${escapeHtml(documentStateLabel(documentValue.state))}</span></span></button>`;
}
function renderHome() {
  const data = state.snapshot; const tasks = data.tasks.tasks; const documents = data.documents; const attention = data.attention;
  el('metrics').innerHTML = [[tasks.length, '전체 태스크'], [documents.length, '프로젝트 문서'], [tasks.filter((task) => task.status === 'review').length, '검토 요청'], [attention.length, '조치 필요']].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
  el('attention-count').textContent = attention.length;
  el('attention-list').innerHTML = attention.length ? attention.slice(0, 12).map((item) => `<button class="attention-item" data-${item.kind === 'task' ? 'task' : 'view'}="${escapeHtml(item.kind === 'task' ? item.id : 'operations')}"><span class="severity ${item.severity}"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.reason)}</small></span><span>›</span></button>`).join('') : '<p class="empty-state">현재 조치가 필요한 항목이 없습니다.</p>';
  el('home-documents').innerHTML = documents.slice().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 6).map(documentCard).join('');
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
function renderContext(item, kind) {
  el('context-empty').hidden = true; el('context-content').hidden = false;
  if (kind === 'document') {
    const linkedTasks = state.snapshot.tasks.tasks.filter((task) => (task.links || []).includes(item.id));
    el('context-content').innerHTML = `<section class="context-group"><h2>속성</h2><dl><div class="property"><dt>ID</dt><dd>${escapeHtml(item.id)}</dd></div><div class="property"><dt>유형</dt><dd>${escapeHtml(documentTypeLabel(item))}</dd></div><div class="property"><dt>상태</dt><dd>${escapeHtml(documentStateLabel(item.state))}</dd></div><div class="property"><dt>소유자</dt><dd>${escapeHtml(ownerName(item.owner))}</dd></div><div class="property"><dt>파일</dt><dd>${escapeHtml(item.file)}</dd></div></dl></section><section class="context-group"><h2>연결 태스크</h2>${linkedTasks.length ? linkedTasks.map((task) => `<button data-task="${task.id}">${escapeHtml(task.title)}</button>`).join('') : '<p class="empty-state">연결된 태스크 없음</p>'}</section><section class="context-group"><h2>검증</h2><p class="chip">strict snapshot 포함</p><small>${escapeHtml(item.revision.slice(0, 12))}</small></section>`;
  } else {
    const members = [['', '미지정']].concat(state.snapshot.people.members.map((member) => [member.id, member.name])); const pending = state.pendingTasks.has(item.id); el('context-content').innerHTML = `<section class="context-group"><h2>Task</h2><dl><div class="property"><dt>ID</dt><dd>${escapeHtml(item.id)}</dd></div><div class="property"><dt>상태</dt><dd>${contextSelect('status', item.status, Object.entries(statusLabels))}</dd></div><div class="property"><dt>우선순위</dt><dd>${contextSelect('priority', item.priority, [['high', '높음'], ['mid', '중간'], ['low', '낮음']])}</dd></div><div class="property"><dt>소유자</dt><dd>${contextSelect('owner', item.owner, members)}</dd></div><div class="property"><dt>검토자</dt><dd>${escapeHtml((item.reviewers || []).map(personName).join(', ') || '미지정')}</dd></div><div class="property"><dt>이해관계자</dt><dd>${escapeHtml((item.stakeholders || []).map(personName).join(', ') || '미지정')}</dd></div><div class="property"><dt>저장</dt><dd><span class="save-state ${pending ? 'pending' : ''}">${pending ? '● 파일 반영 대기' : '✓ 저장됨'}</span></dd></div><div class="property"><dt>Revision</dt><dd>${escapeHtml(item.revision || '-')}</dd></div></dl></section>`;
  }
}
function renderDocument(id) { const item = state.snapshot.documents.find((documentValue) => documentValue.id === id); if (!item) return setView('documents'); el('document-breadcrumb').innerHTML = breadcrumb([{ label: state.project, view: 'home' }, { label: '문서', view: 'documents' }, { label: item.id }]);
  renderLeaseBanner(item.id); el('document-title').textContent = item.title; el('document-description').textContent = item.description; el('document-badges').innerHTML = [item.id, documentTypeLabel(item), documentStateLabel(item.state), ownerName(item.owner)].filter(Boolean).map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join(''); el('document-body').innerHTML = markdown(item.body); el('document-body').hidden = false; el('document-editor').hidden = true; el('edit-document').hidden = false; el('cancel-document-edit').hidden = true; el('save-document').hidden = true; renderContext(item, 'document'); renderMermaid(); }

function taskRow(task) { const completed = Object.values(task.acceptanceCriteria || {}).filter((item) => item.done).length; const total = Object.keys(task.acceptanceCriteria || {}).length; return `<button class="task-row" data-task="${task.id}"><span class="task-row-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span><span class="task-prio" data-prio="${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span><span class="task-row-meta">${escapeHtml(personName(task.owner))}· ${completed}/${total}</span></button>`; }
// 상태별 묶음. 평평한 목록은 33행이 한 벽으로 보여 무엇이 남았는지 읽히지 않는다.
// 묶음 머리글에 개수를 붙이고 스크롤 중에도 머리글을 붙여 둔다.
function taskGroups(tasks) {
  return Object.keys(statusLabels)
    .map((status) => [status, tasks.filter((task) => task.status === status)])
    .filter(([, items]) => items.length)
    .map(([status, items]) => `<section class="task-group"><header class="task-group-head"><span class="chip">${escapeHtml(statusLabels[status])}</span><span class="badge">${items.length}</span></header>${items.map(taskRow).join('')}</section>`)
    .join('');
}
function renderTasks() { const scopes = { all: ['전체 태스크', '프로젝트의 모든 작업을 목록과 Board로 확인합니다.'], mine: ['내 작업', '현재 사용자에게 할당된 작업입니다.'], review: ['내 검토', '현재 사용자가 검토자로 지정된 검토 대기 작업입니다.'] }; const [heading, description] = scopes[state.taskScope]; el('tasks-heading').textContent = heading; el('tasks-description').textContent = description; let tasks = state.snapshot.tasks.tasks; if (state.taskScope !== 'all' && !state.currentMember) { el('task-list').hidden = false; el('board').hidden = true; el('task-list').innerHTML = '<p class="identity-prompt">상단에서 현재 사용자를 선택하면 개인 작업과 검토 요청을 정확히 구분할 수 있습니다.</p>'; return; } if (state.taskScope === 'mine') tasks = tasks.filter((task) => task.owner === state.currentMember); if (state.taskScope === 'review') tasks = tasks.filter((task) => task.status === 'review' && (task.reviewers || []).includes(state.currentMember)); const query = state.query.toLowerCase(); tasks = tasks.filter((task) => (!query || `${task.id} ${task.title} ${task.summary || ''}`.toLowerCase().includes(query)) && (!el('owner').value || task.owner === el('owner').value) && (!el('priority').value || task.priority === el('priority').value)); if (state.taskMode === 'list') { el('task-list').hidden = false; el('board').hidden = true; el('task-list').innerHTML = tasks.length ? taskGroups(tasks) : '<p class="empty-state">조건에 맞는 태스크가 없습니다.</p>'; } else { el('task-list').hidden = true; el('board').hidden = false; el('board').innerHTML = Object.keys(statusLabels).map((status) => `<section class="column"><h2>${statusLabels[status]}</h2>${tasks.filter((task) => task.status === status).map((task) => `<button class="task-card" data-task="${task.id}"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.owner || '미지정')}</small></button>`).join('')}</section>`).join(''); } }
function renderTask(id) { const task = state.snapshot.tasks.tasks.find((item) => item.id === id); if (!task) return setView('tasks'); const documents = (task.links || []).map((link) => state.snapshot.documents.find((item) => item.id === link)).filter(Boolean); const dependencies = (task.deps || []).map((dependency) => state.snapshot.tasks.tasks.find((item) => item.id === dependency)).filter(Boolean); el('task-breadcrumb').innerHTML = breadcrumb([{ label: state.project, view: 'home' }, { label: '태스크', view: 'tasks' }, { label: task.id }]); el('task-detail-title').textContent = task.title; el('task-detail-summary').textContent = task.summary || '설명이 등록되지 않았습니다.'; el('task-detail-badges').innerHTML = [task.id, statusLabels[task.status] || task.status, task.priority, `담당 ${personName(task.owner)}`].filter(Boolean).map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join(''); const criteria = Object.entries(task.acceptanceCriteria || {}); el('task-acceptance-list').innerHTML = criteria.length ? criteria.map(([key, value]) => `<article class="acceptance-item ${value.done ? 'done' : ''}"><button class="acceptance-toggle" data-task-acceptance="${escapeHtml(key)}" aria-pressed="${value.done}" aria-label="${escapeHtml(key)} 완료 상태 변경">${value.done ? '✓' : '○'}</button><span><strong>${escapeHtml(key)}</strong><br>${escapeHtml(value.text)}</span></article>`).join('') : '<p class="empty-state">완료 조건이 없습니다.</p>'; el('task-documents').innerHTML = documents.length ? documents.map(documentCard).join('') : '<p class="empty-state">연결된 문서가 없습니다.</p>'; el('task-dependencies').innerHTML = dependencies.length ? dependencies.map(taskRow).join('') : '<p class="empty-state">의존 태스크가 없습니다.</p>'; el('task-blocker').textContent = blockerText(task.blocker); el('task-external-refs').innerHTML = (task.externalRefs || []).length ? task.externalRefs.map((ref) => `<p>${escapeHtml(typeof ref === 'string' ? ref : JSON.stringify(ref))}</p>`).join('') : '<p class="empty-state">없음</p>'; el('task-timestamps').innerHTML = [['생성', task.createdAt], ['수정', task.updatedAt], ['상태 변경', task.statusChangedAt]].map(([label, value]) => `<div class="property"><dt>${label}</dt><dd>${escapeHtml(value || '-')}</dd></div>`).join(''); renderContext(task, 'task'); }
function renderPeople() { const people = state.snapshot.people; for (const [id, values] of [['members', people.members], ['roles', people.roles], ['stakeholders', people.stakeholders]]) el(id).innerHTML = values.map((item) => `<article class="person-card"><span class="eyebrow">${item.id}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || Object.values(item.fields || {}).join(' · '))}</small></article>`).join(''); }
function renderOperations() { const sync = state.snapshot.sync; el('operation-status').innerHTML = `<article class="operation-card"><p class="eyebrow">SYNC</p><h2>${escapeHtml(sync.state)}</h2><p>${sync.ahead ?? '—'} ahead · ${sync.behind ?? '—'} behind</p><small>${escapeHtml(sync.head.slice(0, 12))}</small></article><article class="operation-card"><p class="eyebrow">ATTENTION</p><h2>${state.snapshot.attention.length}</h2><p>현재 조치 필요 항목</p></article><article class="operation-card"><p class="eyebrow">WATCH</p><h2>외부 CLI</h2><p>watch 상태는 다음 Snapshot 계약에서 연결됩니다.</p></article>`; el('leases').innerHTML = state.snapshot.leases.map((item) => `<article class="entity-card"><strong>${escapeHtml(item.documentId)}</strong><small>${escapeHtml(item.clientId)} · ${escapeHtml(item.expiresAt)}</small></article>`).join('') || '<p class="empty-state">활성 임대가 없습니다.</p>'; }

function populateControls() { const members = state.snapshot.people.members; el('owner').replaceChildren(new Option('모든 담당자', ''), ...members.map((item) => new Option(item.name, item.id))); el('task-owner').replaceChildren(new Option('미지정', ''), ...members.map((item) => new Option(item.name, item.id))); el('task-status').replaceChildren(...Object.entries(statusLabels).map(([value, label]) => new Option(label, value))); const saved = localStorage.getItem(`rundol.currentMember.${state.project}`) || ''; state.currentMember = members.some((item) => item.id === saved) ? saved : ''; el('current-member').replaceChildren(new Option('사용자 선택', ''), ...members.map((item) => new Option(item.name, item.id))); el('current-member').value = state.currentMember; }
function updateHealth() { const count = state.snapshot.attention.length; const health = el('health'); health.className = `health ${count ? 'warning' : ''}`; el('health-label').textContent = count ? `조치 필요 ${count}` : '정상'; el('operation-count').textContent = count || ''; }
// 편집 중에는 화면을 다시 그리지 않는다. setView가 renderDocument를 거쳐 편집기를 닫으므로
// 폴링이 3초마다 입력 중인 내용을 지워버린다. 스냅샷은 계속 받되 렌더링만 미룬다.
function isEditing() { return !el('document-editor').hidden || state.pendingTasks.size > 0; }
async function loadSnapshot(silent) {
  try {
    const next = await api(projectPath('/board-snapshot'));
    const changed = !state.snapshot || JSON.stringify(state.snapshot.revision) !== JSON.stringify(next.revision);
    state.snapshot = next;
    if (changed && !isEditing()) { renderNavigation(); populateControls(); updateHealth(); setView(state.view, state.selected); }
    if (!silent) message('Workspace를 새로 읽었습니다.');
  } catch (error) {
    message(error.message, true);
  }
}
async function initialize() { applyTheme(localStorage.getItem('rundol.theme') || 'system'); matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (document.body.classList.contains('theme-system') && state.view === 'document' && state.selected) renderDocument(state.selected); }); const projects = await api('/api/projects'); el('project-switcher').replaceChildren(...projects.map((item) => new Option(item.name || item.key, item.key))); const hash = new URLSearchParams(location.hash.slice(1)); state.project = hash.get('project') || projects[0].key; state.view = hash.get('view') || 'home'; state.taskScope = hash.get('scope') || 'all'; state.selected = hash.get('entity'); el('project-switcher').value = state.project; await loadSnapshot(true); state.polling = setInterval(() => loadSnapshot(true), 3000); }

document.addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; if (button.dataset.view) { if (button.dataset.view === 'tasks') state.taskScope = 'all'; return setView(button.dataset.view); } if (button.dataset.document) return setView('document', button.dataset.document); if (button.dataset.documentFilter !== undefined) { state.documentFilter = button.dataset.documentFilter; return setView('documents'); } // Plane의 side peek. 목록에서 고른 태스크는 화면을 갈아치우지 않고 Context 패널에 연다.
  // 목록 맥락을 잃지 않고 항목 사이를 옮겨 다닐 수 있다.
  if (button.dataset.task) {
    const peeked = state.snapshot.tasks.tasks.find((item) => item.id === button.dataset.task);
    if (peeked && state.view === 'tasks') {
      state.selected = button.dataset.task;
      document.body.classList.remove('context-collapsed');
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
  if (status !== 'waiting') return queueTaskUpdate(task, task.blocker ? { status, blocker: null } : { status });
  const blocker = await requestBlocker(task.blocker);
  if (!blocker) { input.value = task.status; return message('대기 사유를 입력하지 않아 상태를 바꾸지 않았습니다.'); }
  queueTaskUpdate(task, { status, blocker });
});
el('global-search').addEventListener('input', (event) => { state.query = event.target.value.trim(); if (state.view !== 'documents' && state.view !== 'tasks') setView('documents'); else setView(state.view); });
el('project-switcher').addEventListener('change', async (event) => { state.project = event.target.value; state.snapshot = null; await loadSnapshot(true); });
el('current-member').addEventListener('change', (event) => { state.currentMember = event.target.value; if (state.currentMember) localStorage.setItem(`rundol.currentMember.${state.project}`, state.currentMember); else localStorage.removeItem(`rundol.currentMember.${state.project}`); if (state.view === 'tasks') renderTasks(); });
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
el('refresh').addEventListener('click', () => loadSnapshot(false)); el('owner').addEventListener('change', () => renderTasks()); el('priority').addEventListener('change', () => renderTasks());
el('task-list-mode').addEventListener('click', () => { state.taskMode = 'list'; el('task-list-mode').classList.add('active'); el('task-board-mode').classList.remove('active'); renderTasks(); }); el('task-board-mode').addEventListener('click', () => { state.taskMode = 'board'; el('task-board-mode').classList.add('active'); el('task-list-mode').classList.remove('active'); renderTasks(); });
el('collapse-nav').addEventListener('click', () => document.body.classList.toggle('nav-collapsed')); el('collapse-context').addEventListener('click', () => { if (matchMedia('(max-width: 1050px)').matches) document.body.classList.remove('context-open'); else { document.body.classList.remove('context-open'); document.body.classList.toggle('context-collapsed'); } });
el('menu-button').addEventListener('click', () => document.body.classList.toggle('nav-open'));
el('context-button').addEventListener('click', () => { document.body.classList.remove('context-collapsed'); document.body.classList.toggle('context-open'); });
addEventListener('resize', () => { if (matchMedia('(max-width: 1050px)').matches) document.body.classList.remove('context-collapsed'); else document.body.classList.remove('context-open'); });
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
el('task-status').addEventListener('change', async () => {
  if (el('task-status').value !== 'waiting') { state.newTaskBlocker = null; return; }
  const blocker = await requestBlocker(state.newTaskBlocker);
  if (blocker) { state.newTaskBlocker = blocker; return; }
  el('task-status').value = 'todo';
  state.newTaskBlocker = null;
  message('대기 사유를 입력하지 않아 상태를 할 일로 되돌렸습니다.');
});
// Plane의 quick add. 흔한 경우는 제목 하나뿐인데 모달을 열게 하면 매번 여섯 필드를 지나야 한다.
el('quick-add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = el('quick-add-title').value.trim();
  if (!title) return;
  el('quick-add-save').disabled = true;
  try {
    await api(projectPath('/tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify({ title, status: 'todo', priority: 'mid', owner: state.currentMember || null }) });
    el('quick-add-title').value = '';
    await loadSnapshot(false);
    el('quick-add-title').focus();
  } catch (error) {
    message(error.message, true);
  } finally {
    el('quick-add-save').disabled = false;
  }
});
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
window.addEventListener('beforeunload', () => {
  if (!state.heldLease) return;
  navigator.sendBeacon(leasePath(state.heldLease, 'release'), new Blob([JSON.stringify({ clientId: state.snapshot.client.id })], { type: 'application/json' }));
});
el('save-document').addEventListener('click', async () => {
  const item = state.snapshot.documents.find((value) => value.id === state.selected);
  if (!item) return;
  const draft = el('document-editor').value;
  try {
    await api(projectPath(`/documents/${encodeURIComponent(item.id)}`), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify({ baseRevision: item.revision, body: draft }) });
    await releaseLease();
    await loadSnapshot(true);
    message('문서를 저장하고 검증했습니다.');
  } catch (error) {
    // 저장이 거부돼도 편집기 내용은 남긴다. 여기서 지우면 작업이 사라진다.
    el('document-editor').value = draft;
    state.rejectedDraft = { id: item.id, body: draft };
    message(`${error.message} 편집 내용은 편집기에 그대로 있습니다.`, true);
  }
});
el('task-form').addEventListener('submit', async (event) => { event.preventDefault(); const status = el('task-status').value; if (status === 'waiting' && !state.newTaskBlocker) return message('대기 상태로 만들려면 대기 사유를 먼저 입력하세요.', true); const lines = el('task-acceptance').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const acceptanceCriteria = Object.fromEntries(lines.map((text, index) => [`AC-${String(index + 1).padStart(3, '0')}`, { text, done: false }])); try { await api(projectPath('/tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token }, body: JSON.stringify({ title: el('task-title').value, summary: el('task-summary').value, status, priority: el('task-priority').value, owner: el('task-owner').value || null, blocker: status === 'waiting' ? state.newTaskBlocker : null, links: el('task-links').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), acceptanceCriteria }) }); el('task-dialog').close(); await loadSnapshot(true); message('태스크를 생성했습니다.'); } catch (error) { message(error.message, true); } });
el('sync').addEventListener('click', async () => { try { message('동기화를 실행하고 있습니다.'); await api(projectPath('/sync'), { method: 'POST', headers: { 'X-Rundol-Token': token } }); await loadSnapshot(true); message('동기화를 완료했습니다.'); } catch (error) { message(error.message, true); } });
function ensureContractSettings() {
  if (el('contract-settings')) return;
  el('settings-panels').insertAdjacentHTML('beforeend', `<section id="contract-settings" class="settings-panel contract-settings"><div class="section-heading"><div><h2>문서 계획 계약</h2><p id="contract-summary"></p></div><button id="save-contract" class="primary">계약 저장</button></div><div class="form-grid"><label>프로필<select id="contract-profile"><option>lean</option><option>product</option><option>service</option><option>platform</option><option>assured</option></select></label><label>강제 수준<select id="contract-enforcement"><option value="advisory">advisory</option><option value="checkpoint">checkpoint</option></select></label></div><p id="implementation-contract-summary" class="control-hint"></p><p class="control-hint">AI 추천 문맥은 작성 품질을 돕는 참고 문서이며 생성·저장을 차단하지 않습니다.</p><div id="contract-rules" class="contract-table" aria-label="문서 계약 규칙"></div></section>`);
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
  const disabled = row.querySelector('[data-contract-status]').value === 'disabled';
  const omission = row.querySelector('[data-contract-omission]');
  omission.hidden = !disabled;
  for (const control of omission.querySelectorAll('select,input')) control.disabled = !disabled;
}
function renderContractSettings() {
  ensureContractSettings();
  const contract = state.snapshot.contract;
  if (!contract || !contract.profile) { el('contract-summary').textContent = contract ? contract.status : 'legacy-unconfigured'; el('implementation-contract-summary').textContent = ''; el('contract-rules').innerHTML = ''; return; }
  const profile = contract.profile;
  el('contract-profile').value = profile.name;
  el('contract-enforcement').value = profile.enforcement;
  el('contract-summary').textContent = `${contract.status} · revision ${profile.revision} · 위반 ${contract.evaluation.violations.length}건`;
  const catalog = contract.catalog;
  const trace = contract.traceability && contract.traceability.summary;
  el('implementation-contract-summary').textContent = `${catalog.implementation.version} · 기능별 독립 명세(묶음 금지) · 계산된 추적성 ${trace ? `${trace.ready}/${trace.functions} 준비` : '0/0 준비'} · 별도 인덱스 없음`;
  el('contract-rules').innerHTML = catalog.documentTypes.map((type) => {
    const status = Object.keys(profile.policy).find((key) => profile.policy[key].includes(type));
    const omission = profile.omissions[type] || catalog.defaultOmissions[type];
    const selectedComponents = omission.sections || [];
    const targetOptions = catalog.documentTypes.filter((candidate) => candidate !== type).map((candidate) => `<option value="${candidate}" ${candidate === omission.absorbedBy ? 'selected' : ''}>${candidate}</option>`).join('');
    const recommendedContext = profile.rules[type].after;
    const context = recommendedContext.length ? recommendedContext.map((value) => `<span class="guidance-chip">${escapeHtml(value)}</span>`).join('') : '<span class="guidance-empty">바로 작성 가능</span>';
    const suggestions = catalog.sections[type].map((value) => `<button type="button" class="suggestion-chip" data-component-suggestion="${escapeHtml(value)}" ${selectedComponents.includes(value) ? 'disabled' : ''}>+ ${escapeHtml(value)}</button>`).join('');
    return `<article class="contract-row" data-contract-type="${type}"><header><strong>${type}</strong><label>정책 상태<select data-contract-status aria-label="${type} 정책 상태">${catalog.policyStates.map((value) => `<option value="${value}" ${status === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label></header><div class="contract-guidance"><span>AI 추천 문맥</span><div class="guidance-chips">${context}</div></div><div class="contract-omission" data-contract-omission ${status === 'disabled' ? '' : 'hidden'}><label>흡수 대상<select data-contract-target aria-label="${type} 흡수 대상">${targetOptions}</select></label><section class="contract-components" aria-label="${type} 필수 구성요소"><strong>필수 구성요소</strong><div class="component-list" data-contract-components>${selectedComponents.map(contractComponent).join('')}</div><div class="component-add"><input data-component-input aria-label="${type} 구성요소 직접 추가" placeholder="구성요소 직접 추가"><button type="button" data-component-add>추가</button></div><div class="component-suggestions"><small>템플릿 제안</small><div>${suggestions}</div></div></section><p class="control-hint">템플릿 제안을 사용하거나 프로젝트에 필요한 항목을 자유롭게 추가·삭제할 수 있습니다.</p></div></article>`;
  }).join('');
  for (const row of document.querySelectorAll('[data-contract-type]')) syncContractRow(row);
}
function renderPresentationSettings() {
  let section = el('presentation-settings');
  if (!section) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="presentation-settings" class="settings-panel presentation-settings"><div class="section-heading"><div><h2>문서 표시 설정</h2><p>내장 기본값 다음 Workspace와 프로젝트 board.json을 순서대로 적용합니다.</p></div></div><div id="presentation-inheritance" class="inheritance-chain"></div><div id="presentation-types" class="presentation-types"></div></section>');
    section = el('presentation-settings');
  }
  const presentation = state.snapshot.presentation;
  const inherited = presentation.inheritance;
  el('presentation-inheritance').innerHTML = `<span class="inheritance-node active">내장 기본값</span><span>→</span><span class="inheritance-node ${inherited.workspace.configured ? 'active' : ''}">Workspace board.json</span><span>→</span><span class="inheritance-node ${inherited.project.configured ? 'active' : ''}">프로젝트 board.json</span>`;
  el('presentation-types').innerHTML = Object.entries(presentation.documentTypes).sort((left, right) => left[1].order - right[1].order).map(([kind, item]) => `<article><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(kind)} · ${escapeHtml(item.description)}</small></article>`).join('');
  section.title = `${inherited.workspace.file}\n${inherited.project.file}`;
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
    .map((name) => `<div class="property"><dt>${escapeHtml(name)}</dt><dd>${escapeHtml((profile.policy[name] || []).join(', ') || '없음')}<small>${escapeHtml(policyNote[name])}</small></dd></div>`).join('');

  const violations = (evaluation.violations || []).map((item) => `<div class="compliance-item error"><strong>${escapeHtml(item.code)}</strong><span>${escapeHtml(item.message)}</span></div>`);
  const findings = (diagnostics.items || []).map((item) => `<div class="compliance-item ${escapeHtml(item.severity)}"><strong>${escapeHtml(item.code)}</strong><span>${escapeHtml(item.message)}</span><small>${escapeHtml(item.artifactId || item.file || '')}</small></div>`);
  const incomplete = (trace.entries || []).filter((entry) => !entry.ready)
    .map((entry) => `<div class="compliance-item warning"><strong>${escapeHtml(entry.functionId)}</strong><span>미준비: ${escapeHtml((entry.missing || []).join(', ') || '연결 문서 부족')}</span></div>`);

  // 흡수 판정은 타입 단위라 REQ 하나만 섹션을 가져도 satisfied가 된다. 실제로 몇 개가 갖고 있는지 보여준다.
  const absorbed = (evaluation.absorbed || []).map((item) => {
    const all = state.snapshot.documents.filter((doc) => doc.id.startsWith(`${item.absorbedBy}-`));
    const holders = all.filter((doc) => (item.sections || []).every((section) => (doc.body || '').includes(`## ${section}`)));
    return `<div class="compliance-item ${item.satisfied ? 'ok' : 'error'}"><strong>${escapeHtml(item.type)} → ${escapeHtml(item.absorbedBy)}</strong><span>${escapeHtml((item.sections || []).join(' · '))}</span><small>${holders.length}/${all.length} ${escapeHtml(item.absorbedBy)}가 네 섹션을 모두 갖고 있습니다</small></div>`;
  });

  const diagrams = contract.catalog && contract.catalog.diagrams
    ? `<div class="property"><dt>다이어그램</dt><dd>${escapeHtml(contract.catalog.diagrams.version)} · ${escapeHtml(contract.catalog.diagrams.types.join(', '))}<small>${escapeHtml(contract.catalog.diagrams.authority || '')}</small></dd></div>` : '';

  el('compliance-body').innerHTML = `
    <section class="compliance-group"><h3>계약 상태</h3><dl>
      <div class="property"><dt>강제 수준</dt><dd>${escapeHtml(contract.enforcement)}<small>${escapeHtml(enforcementNote[contract.enforcement] || '')}</small></dd></div>
      <div class="property"><dt>revision</dt><dd>${escapeHtml(String(profile.revision))}<small>계약을 바꿀 때마다 1씩 오릅니다.</small></dd></div>
      <div class="property"><dt>프로필 이력</dt><dd>${escapeHtml((profile.history || []).join(' → '))}</dd></div>${diagrams}
    </dl></section>
    <section class="compliance-group"><h3>정책 상태별 의미</h3><dl>${policyRows}</dl></section>
    <section class="compliance-group"><h3>계약 위반 ${violations.length}</h3>${complianceList(violations, '위반이 없습니다.')}</section>
    <section class="compliance-group"><h3>검사 결과 — 오류 ${diagnostics.summary.errors} · 경고 ${diagnostics.summary.warnings}</h3>${complianceList(findings, 'rdl check --strict가 오류와 경고 없이 통과합니다.')}</section>
    <section class="compliance-group"><h3>기능 추적성 — 준비 ${trace.summary.ready}/${trace.summary.functions}</h3>${complianceList(incomplete, '선언된 기능이 모두 REQ와 TST 계약을 갖췄습니다.')}</section>
    <section class="compliance-group"><h3>흡수 규칙</h3>${complianceList(absorbed, '비활성 유형이 없습니다.')}</section>`;
}
function renderSettings() { el('clients').innerHTML = state.snapshot.clients.map((item) => `<article class="entity-card"><span class="eyebrow">${escapeHtml(item.id)}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.type)} · ${escapeHtml(item.status)}</small></article>`).join('') || '<p class="empty-state">등록된 Client가 없습니다.</p>'; renderPresentationSettings(); renderContractSettings(); renderContractCompliance(); const current = document.querySelector('[data-settings-section].active'); showSettingsSection(current ? current.dataset.settingsSection : 'settings-appearance'); }
function contractInput() {
  const policy = { required: [], recommended: [], onDemand: [], disabled: [] };
  const rules = {}; const omissions = {};
  for (const row of document.querySelectorAll('[data-contract-type]')) {
    const type = row.dataset.contractType; const status = row.querySelector('[data-contract-status]').value;
    policy[status].push(type); rules[type] = { after: state.snapshot.contract.profile.rules[type].after.slice() };
    if (status === 'disabled') omissions[type] = { absorbedBy: row.querySelector('[data-contract-target]').value, sections: Array.from(row.querySelectorAll('[data-contract-section]')).map((item) => item.dataset.contractSection) };
  }
  return { baseRevision: state.snapshot.contract.revision, name: el('contract-profile').value, enforcement: el('contract-enforcement').value, policy, rules, omissions };
}
document.addEventListener('change', (event) => {
  const status = event.target.closest('[data-contract-status]');
  if (status) syncContractRow(status.closest('[data-contract-type]'));
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
