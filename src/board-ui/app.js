'use strict';

const token = document.querySelector('meta[name="rdl-token"]').content;
const state = { project: null, snapshot: null, view: 'home', selected: null, taskScope: 'all', currentMember: '', taskMode: 'list', documentFilter: '', documentQuery: '', taskQuery: '', polling: null, lastVisit: null, pendingTasks: new Map(), blockerResolve: null, cancellationResolve: null, clientIntent: null, commentComposer: null, newTaskBlocker: null, rejectedDraft: null, attentionFilter: 'all', reviewFilter: 'all', reviewScope: 'all', reviewExpanded: false, reviewFrom: null, documentSearchScope: 'name', documentSort: 'id', documentApproval: 'all', presentationScope: 'project', presentationSettling: false, runs: null, runsError: '', approvingRun: null, review: null, docApproval: null,
  // 검색의 두 자리는 상태도 둘이다. 같은 물음이라도 자르는 폭이 다르고(12건과 200건)
  // 사는 시간도 다르다 — 드롭다운은 타자와 함께 사라지고 전용 화면은 주소에 남는다.
  // seq/applied는 늦게 온 답이 먼저 온 답을 덮지 않게 하는 순번이고, controller는
  // 이미 나간 요청을 끊는 자리다. 둘 다 필요하다: 취소해도 답이 이미 길 위에 있을 수 있다.
  search: { query: '', answer: null, error: null, loading: false, open: false, active: -1, timer: null, controller: null, seq: 0, applied: 0 },
  searchPage: { query: '', source: null, answer: null, answerQuery: null, scoped: null, scopedSource: null, scopedQuery: null, error: null, errorQuery: null, loading: false, timer: null, controller: null, seq: 0, applied: 0, scopedSeq: 0, scopedApplied: 0 } };
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
// 수명 어휘의 옛 스냅숏용 대비책. 정본은 src/vocabulary.js의 DOCUMENT_LIFECYCLE_KEYS이고
// 보이는 말은 스냅숏의 표시 규칙(documentLifecycles)이 준다. 여기 적힌 것은 그 규칙을 아직
// 안 싣는 스냅숏을 만났을 때 영문 값이 그대로 뜨는 것을 막기 위한 것뿐이다.
const documentLifecycleLabels = {
  active: '유효', accepted: '채택됨', superseded: '대체됨', deprecated: '폐기 예정', archived: '보관됨'
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
// 실패는 실패로 보여야 한다. 이 자리는 오래 style.color로 색을 칠했는데, 보드가
// 내려보내는 CSP가 style-src 'self'라 브라우저가 그 칠하기를 막았고(콘솔에 그대로
// 찍힌다), 쓰던 --red는 테마를 다시 쓰면서 사라진 이름이었다. 그래서 "그림을 넣지
// 못했습니다"가 "넣었습니다"와 한 글자도 다르지 않게 보였다 — 사람은 실패를 못 보고
// 같은 일을 다시 한다. 칠하기는 CSS가 하고 여기서는 종류만 말한다.
function message(value, error) { const host = el('message'); host.textContent = value || ''; host.classList.toggle('is-error', Boolean(value) && Boolean(error)); if (value) setTimeout(() => { if (host.textContent === value) { host.textContent = ''; host.classList.remove('is-error'); } }, 5000); }
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
// 수명은 상태와 다른 축이다. state는 rdl이 승인 원장에서 투영하는 칸("이 파일이 승인된
// 판과 같은가")이고 lifecycle은 사람이 적는 칸("이 내용이 지금 효력이 있는가")이다. ADR이
// accepted였다가 superseded가 되는 것은 승인과 무관한 사건이라, 두 축을 한 칩으로 합치면
// 「승인됨이면서 대체됨」인 문서를 화면이 말할 수 없게 된다.
//
// 값이 없으면 빈 문자열을 돌려주고 부르는 쪽이 그리지 않는다. 없는 것과 active는 다르다 —
// 문서 158건 중 72건만 이 칸을 갖고, 없는 것을 「유효」로 메우면 화면이 사람이 하지도 않은
// 주장을 대신 하게 된다.
function documentLifecycleLabel(value) { return value ? presentationLabel('documentLifecycles', value, documentLifecycleLabels[value] || value) : ''; }
function documentLifecycleHtml(value) {
  if (!value) return '';
  const hint = presentationHint('documentLifecycles', value);
  return `<span class="chip lifecycle"${hint ? ` title="${escapeHtml(hint)}"` : ''}>${escapeHtml(documentLifecycleLabel(value))}</span>`;
}
// 고를 수 있는 수명 값. 어휘의 정본은 vocabulary.js이고 이 화면은 그것을 직접 읽지
// 못하므로 표시 규칙이 아는 값을 함께 세운다 — 화면이 목록을 두 번째로 적어 두면
// 값이 느는 날 그 값만 영영 안 뜨고, 그 사실은 아무 신호도 내지 않는다.
function documentLifecycleKeys() {
  const group = (state.snapshot && state.snapshot.presentation && state.snapshot.presentation.documentLifecycles) || {};
  const known = Object.keys(documentLifecycleLabels);
  return known.concat(Object.keys(group).filter((key) => !known.includes(key)));
}
// 계약과 태스크가 저장하는 값은 required, checkpoint, todo 같은 ASCII 식별자다. 그 값을
// 화면에 그대로 내보내면 읽는 사람이 뜻을 유추해야 한다. 저장값은 그대로 두고 보이는
// 말만 표시 규칙에서 가져온다. 표기를 바꿔도 저장된 계약은 한 글자도 달라지지 않는다.
function policyStateLabel(value) { return presentationLabel('policyStates', value, value); }
function enforcementLabel(value) { return presentationLabel('enforcementLevels', value, value); }
function taskStatusLabel(value) { return presentationLabel('taskStatuses', value, statusLabels[value] || value); }
function priorityLabel(value) { return presentationLabel('priorities', value, value); }
// 업무 유형의 이름은 프로젝트가 정하고 스냅숏이 실어 준다. 화면이 「일반·테스트」를 적어
// 두면 유형이 늘어나는 날 새 유형은 화면에 영영 나타나지 않는다 — 실제로 HTML의 옵션이
// test를 「테스트」라 불렀는데 프로젝트가 정한 이름은 「검증」이라, 화면 하나만 다른 말을
// 쓰고 있었다.
function taskKindLabel(value) { const types = (state.snapshot && state.snapshot.presentation && state.snapshot.presentation.itemTypes) || {}; return (types[value] && types[value].label) || value; }
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

// `![[이름]]`이 가리키는 그림의 주소. 자산이 사는 자리는 프로젝트가 정하고 스냅숏이
// 실어 준다 — 화면이 `docs/assets`를 사본으로 적으면 문서 뿌리를 옮긴 날 그림만
// 조용히 깨진다. 스냅숏이 아직 없을 때만 매니페스트 기본값으로 물러선다.
function assetUrl(name) {
  const directory = (state.snapshot && state.snapshot.assets && state.snapshot.assets.directory) || 'docs/assets';
  const segments = `${directory}/${String(name || '').trim()}`.split('/').filter((part) => part && part !== '.');
  return `/api/projects/${encodeURIComponent(state.project)}/assets/${segments.map(encodeURIComponent).join('/')}`;
}

function markdown(source) {
  if (!window.marked || !window.DOMPurify) return `<pre>${escapeHtml(source || '')}</pre>`;
  const renderer = new window.marked.Renderer();
  renderer.code = ({ text, lang }) => String(lang || '').toLowerCase() === 'mermaid' ? `<pre class="mermaid">${escapeHtml(text)}</pre>` : `<pre><code class="language-${escapeHtml(lang || '')}">${escapeHtml(text)}</code></pre>`;
  // 자산 embed가 문서 참조보다 먼저다. `![[그림.png]]`의 느낌표를 보지 않고 문서
  // 규칙으로 옮기면 `![그림.png](#document=그림.png)`이 되어, 넣기는 성공했는데
  // 화면에는 깨진 그림만 남는다 — 사람에게는 그것이 "업로드가 안 된 것"이다.
  const prepared = String(source || '')
    // 자산 이름에는 #이 들어갈 수 있다. 여기서 배제하면 `![[a#b.png]]`이 이 규칙에
    // 안 걸리고 아래 문서 규칙이 그것을 `![a](#document=a)`로 옮겨 깨진 그림이 된다.
    // 편집기의 ASSET_EMBED는 #을 허용하므로, 배제하면 같은 글자를 두 화면이 다르게
    // 읽는다 — 그 어긋남은 사람이 진단할 수 없다.
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_match, target, label) => `![${String(label || target).replace(/[[\]]/gu, '')}](${assetUrl(target)})`)
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target, label) => `[${label || target}](#document=${encodeURIComponent(target)})`);
  const html = window.marked.parse(prepared, { gfm: true, breaks: false, renderer });
  const clean = window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  // 표는 자기 최소 폭 아래로 줄지 못한다. 그런데 본문에는 넘친 것을 담을 자리가 없어,
  // 좁아진 본문에서 표의 오른쪽이 갈 곳 없이 흘러넘쳤다 — 승인 판을 연 GLS-002에서 본문이
  // 620px이 되자 664px짜리 용어 표의 마지막 열(「사용하지 않을 표현」)이 판 밑으로 들어가
  // 사라졌고, 스크롤 막대가 어디에도 없어 되찾을 방법이 없었다. 세로로 살아 있어도 가로로
  // 죽으면 같은 결함이다.
  //
  // 상자를 씌워 그 안에서만 가로로 스크롤하게 한다. 흐름도(.task-graph)·Board·코드 블록이
  // 이미 쓰는 규칙이고 표만 예외였다. 표 자체에 display:block을 주는 손도 있지만 그러면
  // width:100%가 죽어 좁은 표가 본문 폭을 채우지 못하므로, 진짜 상자를 하나 세운다.
  //
  // sanitize 뒤에 DOM으로 감싼다. 문자열을 이어 붙이면 그 조각은 소독을 거치지 않은 HTML이
  // 되고, 소독 전에 감싸면 DOMPurify가 그 상자를 모르는 태그로 보고 지울 수 있다.
  const holder = document.createElement('div');
  holder.innerHTML = clean;
  for (const table of holder.querySelectorAll('table')) {
    const box = document.createElement('div');
    box.className = 'table-scroll';
    table.replaceWith(box);
    box.appendChild(table);
  }
  return holder.innerHTML;
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

// 옆으로 나온 승인 판은 문서 상세의 것이다. 화면을 옮길 때 표식을 안 지우면 본문이 없는
// 화면에서도 오른쪽 여백이 그대로 남아, 아무것도 없는 자리가 목록의 폭을 먹는다.
//
// 펼쳐 둔 판 자체도 함께 버린다. 이 판이 사는 화면은 문서 상세뿐이라 다른 화면으로
// 나가면 그릴 자리가 없는데, 들고 다니면 적던 사유가 남아 있다가 다음에 연 문서에
// 그대로 붙는다 — 프로젝트를 바꿀 때 이미 같은 이유로 비운다.
function dismissApprovalSurface(view) {
  if (view === 'document') return;
  document.body.classList.remove('approval-open');
  state.docApproval = null;
}
function setView(view, selected) {
  if (!state.snapshot) return;
  if (view === 'my-work') { state.view = 'tasks'; state.taskScope = 'mine'; }
  else if (view === 'review') { state.view = 'tasks'; state.taskScope = 'review'; }
  else state.view = view;
  state.selected = selected || null;
  // 「인박스에서 왔다」는 그 문서를 보는 동안만 참이다. 안 지우면 나중에 문서 목록에서
  // 연 문서까지 breadcrumb이 인박스에서 온 것으로 말하고, 돌아가는 길이 거짓이 된다.
  if (state.view !== 'document') state.reviewFrom = null;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `${state.view}-view`;
  markViewOnBody(state.view);
  dismissApprovalSurface(state.view);
  for (const button of document.querySelectorAll('[data-view]')) { const activeTaskView = state.view === 'tasks' && ((state.taskScope === 'mine' && button.dataset.view === 'my-work') || (state.taskScope === 'review' && button.dataset.view === 'review') || (state.taskScope === 'all' && button.dataset.view === 'tasks')); button.classList.toggle('active', activeTaskView || (state.view !== 'tasks' && button.dataset.view === state.view)); }
  const params = new URLSearchParams({ project: state.project || '', view: state.view });
  if (state.view === 'tasks' && state.taskScope !== 'all') params.set('scope', state.taskScope);
  // 검토 인박스의 범위도 같은 칸에 싣는다. 축을 하나 더 만들면 같은 물음("누구의 줄인가")이
  // 화면마다 다른 이름으로 주소에 적히고, 그러면 링크를 받은 사람은 그 이름을 매번 다시 배운다.
  // 한 칸을 나눠 써도 섞이지 않는 것은 값을 읽을 때 view가 함께 있기 때문이다.
  if (state.view === 'review-inbox' && state.reviewScope !== 'all') params.set('scope', state.reviewScope);
  // 검색 화면의 주소는 질의 그 자체다. entity에 실지 않는 이유는 이것이 어떤 항목의
  // 식별자가 아니라 물음이기 때문이고, 태스크 범위(scope)가 같은 규약으로 이미 실리고
  // 있어 축을 하나 더 만들 이유가 없다. 이 두 값이 주소에 있어야 결과를 남에게 준다.
  if (state.view === 'search') {
    if (state.searchPage.query) params.set('q', state.searchPage.query);
    if (state.searchPage.source) params.set('source', state.searchPage.source);
  }
  if (selected) params.set('entity', selected);
  history.replaceState(null, '', `#${params}`);
  // 목록 거르개는 화면마다 자기 값을 갖는다. 한 값을 둘이 나눠 쓰던 때에는 문서에서 친
  // 낱말이 태스크 목록까지 줄여 놓고, 화면을 옮긴 사람은 자기가 무엇을 걸어 두었는지
  // 볼 자리가 없었다. 값이 같을 때 다시 넣지 않는 것은 캐럿을 앞으로 되돌리지 않기 위해서다.
  syncFieldValue('documents-filter', state.documentQuery);
  syncFieldValue('tasks-filter', state.taskQuery);
  if (state.view === 'document' && selected) renderDocument(selected);
  else if (state.view === 'documents') renderDocuments();
  else if (state.view === 'task' && selected) renderTask(selected);
  else if (state.view === 'tasks') { for (const button of document.querySelectorAll('[data-task-scope]')) button.classList.toggle('active', button.dataset.taskScope === state.taskScope); renderTasks(); }
  else if (state.view === 'runs') { renderRuns(); loadRuns(true); }
  else if (state.view === 'home') renderHome();
  else if (state.view === 'review-inbox') renderReviewInbox();
  else if (state.view === 'search') renderSearchPage();
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

// 한 번에 그리는 줄 수. 태스크 묶음의 미리보기와 같은 뜻이고 수만 다르다 — 인박스는
// 무엇이 얼마나 기다리는지를 훑어 고르는 자리라, 여섯 줄로는 고를 것이 남지 않는다.
const REVIEW_PAGE = 25;

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

// 얼마나 기다렸나. relativeTime과 같은 눈금을 쓰되 말이 다르다 — "3일 전"은 사건이 언제
// 있었나이고, 줄에서 물어야 하는 것은 "그 뒤로 얼마나 지났나"다. 순서가 대기 시간으로
// 정해지므로 줄에 적히는 말도 그 축을 가리켜야 사람이 순서의 근거를 읽는다.
//
// 분 미만은 눈금을 내리지 않는다. SCR-002가 분 단위 이상만 표시하도록 정해 두었고,
// 초 단위는 폴링마다 값이 바뀌어 줄 전체가 깜빡이는 것처럼 보인다.
//
// 값이 없으면 null을 돌려준다. 여기서 "0분"이나 빈 문자열로 메우면 대기 시각을 못 구한
// 문서가 방금 올라온 것처럼 보이고, 서버가 그런 줄을 맨 뒤로 보낸 이유가 화면에서 사라진다.
function waitingLabel(value) {
  const stamp = Date.parse(value || '');
  if (Number.isNaN(stamp)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000));
  if (minutes < 60) return `${minutes}분 기다림`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}시간 기다림`;
  return `${Math.round(minutes / 1440)}일 기다림`;
}

function reviewRowHtml(item) {
  // 승인자와 승인 횟수는 낡음에만 값이 있다. 미승인은 승인 이력 자체가 없으므로 빈
  // 자리를 남기지 않고 없다고 적는다 — 빈 칸은 "못 읽었다"로도 읽힌다.
  const trail = item.approvals
    ? `${escapeHtml(personName(item.approvedBy))} · 승인 ${escapeHtml(item.approvals)}회`
    : '승인 이력 없음';
  // 기다린 시간은 줄의 순서를 정하는 값이라 줄에 보여야 한다. 안 보이면 사람은 위에서부터
  // 읽으면서 왜 이 순서인지 알 수 없고, 그때 순서는 근거 없는 것으로 읽힌다.
  //
  // 못 구한 것은 "모름"이라 적는다. 빈 칸은 "방금 올라왔다"로도 "못 읽었다"로도 읽히는데
  // 둘 다 사실이 아니다 — 승인 자취를 빈 칸으로 두지 않는 것과 같은 자리다. 정확한 시각은
  // title에 함께 넣는다. 훑을 때는 "3일"이 빠르고 따질 때는 그 값이 필요하다.
  const waited = waitingLabel(item.waitingSince);
  const wait = waited
    ? `<span class="review-wait" title="${escapeHtml(item.waitingSince)}부터">${escapeHtml(waited)}</span>`
    : '<span class="review-wait unknown">대기 시간 모름</span>';
  // 줄의 첫 동작은 그 문서의 검토 자리로 가는 것이다. 오래 이 자리는 눌러서 펼치는
  // 손잡이였고 펼치면 차분과 승인 폼이 나왔는데, 본문은 그 안 어디에도 없었다 — 차분은
  // "무엇이 바뀌었나"에만 답하고 "이게 맞는 문서인가"는 본문에만 있다. 근거 어휘에
  // read(읽고 판단했다)를 두고서 읽을 자리를 주지 않은 채 그것을 고르게 하고 있었다는
  // 뜻이라, 승인을 받는 자리를 본문이 보이는 화면 하나로 모은다.
  //
  // 문서로 가는 길은 하나뿐이므로(data-document) 새 경로를 파지 않고 그 길에 표식만
  // 얹는다. data-review-origin이 "인박스에서 왔다"를 말하고, 그 표식이 있을 때만 도착한
  // 화면이 승인 판을 열어 두고 breadcrumb을 인박스로 돌려놓는다 — 문서 목록에서 그냥
  // 열어 본 사람은 검토하러 온 것이 아니라, 그 사람에게는 둘 다 하면 안 된다.
  return `<button class="document-row review-inbox-row" data-document="${escapeHtml(item.id)}" data-review-origin="1">`
    + `<span class="tag ${REVIEW_STATUS_TONES[item.status] || 'info'}">${escapeHtml(REVIEW_STATUS_LABELS[item.status] || item.status)}</span>`
    + `<span class="eyebrow">${escapeHtml(item.id)}</span>`
    + `<strong>${escapeHtml(item.title)}</strong>`
    + `<span class="chip">${escapeHtml(documentTypeLabel(item))}</span>`
    + wait
    + `<small>${trail}</small>`
    + `<span class="row-chevron" aria-hidden="true">${CHEVRON_ICON}</span></button>`;
}

// ── 검토 줄을 훑는 길 ───────────────────────────────────────────────────────
//
// 인박스에서 온 사람은 한 건을 보러 온 것이 아니라 줄을 훑는 중이다. 도착한 화면이 그
// 사실을 모르면 한 건 처리할 때마다 손으로 인박스를 다시 찾아 어디까지 봤는지 되짚어야
// 하고, 그러면 인박스는 목록으로 되돌아간다 — 줄을 훑으며 처리하는 것이 그 화면의 값이다.

// 지금 인박스에 서 있는 줄. 거르개를 걸어 둔 사람에게 다음 차례를 물으면 그 갈래 안에서
// 답해야 하므로, 목록을 그리는 자리와 같은 함수를 쓴다 — 두 곳에 따로 적으면 화면이 보여
// 준 줄과 「다음 대기 건」이 가리키는 줄이 갈리고, 거른 적 없는 문서로 사람이 끌려간다.
function reviewVisibleItems() {
  const queue = state.snapshot.reviewQueue;
  if (reviewMode(queue) !== 'ready') return [];
  // 「내 차례」로 좁혀 놓고 훑는 사람에게 다음 차례를 물으면 그 좁힌 줄 안에서 답해야
  // 한다. 프로젝트 전체에서 답하면 자기가 고른 적 없는 남의 줄로 끌려가고, 그때 「다음
  // 대기 건」은 훑던 자리를 잃게 만드는 단추가 된다 — 거르개를 걸어 둔 사람에게 그 갈래
  // 안에서 답하는 것과 같은 이유이고, 여기가 그 한 자리라 두 화면이 갈릴 수 없다.
  if (state.reviewScope === 'mine') {
    const turns = state.snapshot.documentTurns;
    if (!turns || !state.currentMember) return [];
    return turns.rows.filter((row) => row.lanes[state.currentMember]);
  }
  return state.reviewFilter === 'all' ? queue.items : queue.items.filter((item) => item.status === state.reviewFilter);
}

// 이 문서가 줄의 몇 번째이고 다음이 무엇인가. 판정이 끝나 줄에서 빠진 뒤에는 맨 앞이
// 다음 차례다 — 서버가 급한 순으로 정렬해 보냈으므로 그 앞이 곧 먼저 볼 것이고, 사라진
// 자리의 "그 다음"을 화면이 지어내는 것보다 정확하다.
function reviewNeighbors(id) {
  const items = reviewVisibleItems();
  const index = items.findIndex((item) => item.id === id);
  return { index, total: items.length, next: (index >= 0 ? items[index + 1] : items[0]) || null };
}

// 돌아가는 길과 다음 차례. breadcrumb도 인박스를 가리키지만 그것은 "돌아간다"만 말하고
// 줄의 어디쯤인지도, 다음이 무엇인지도 말하지 못한다 — 승인·반려한 뒤 이어질 곳이 화면에
// 없으면 사람은 매번 목록으로 되돌아가 자기가 어디까지 봤는지 다시 찾는다.
//
// 인박스에서 온 경우에만 선다. 문서 목록에서 열어 본 사람에게 이 띠를 세우면 자기가 서
// 있지도 않은 줄의 순번을 읽게 되고, 「다음 대기 건」은 그 사람이 하려던 일이 아니다.
function renderReviewNav(id) {
  const host = el('document-review-nav');
  const active = state.reviewFrom === id && reviewMode(state.snapshot.reviewQueue) === 'ready';
  host.hidden = !active;
  // 비울 때도 내용을 지운다. hidden만 걸면 인박스를 거치지 않고 다음에 연 문서에서
  // 이전 문서의 순번이 DOM에 남고, 그것은 화면 안 읽는 값이라 언젠가 다시 보인다.
  if (!active) return void (host.innerHTML = '');
  const { index, total, next } = reviewNeighbors(id);
  // 줄에서 빠진 것을 "0번째"나 빈 칸으로 적지 않는다. 방금 자기가 무엇을 했는지가 그
  // 자리에 남아야 다음으로 넘어가는 것이 이어지는 동작으로 읽힌다.
  const place = index >= 0 ? `${index + 1} / ${total}` : `이 줄에서 빠짐 · 남은 ${total}건`;
  host.innerHTML = '<button type="button" data-view="review-inbox">← 검토 인박스</button>'
    + `<span class="review-nav-place">${escapeHtml(place)}</span>`
    + (next
      ? `<button type="button" class="review-nav-next" data-document="${escapeHtml(next.id)}" data-review-origin="1">다음 대기 건 ${escapeHtml(next.id)} →</button>`
      : '<span class="review-nav-place">이 줄의 마지막 건입니다.</span>');
}

// 인박스에서 온 사람에게는 판이 열린 채로 도착한다. 검토하러 온 것이기 때문이고, 문서
// 목록에서 그냥 열어 본 사람에게는 열지 않는다 — 그 사람이 온 이유는 읽는 것인데 옆으로
// 나온 판은 본문의 폭을 그만큼 가져간다. 온 곳을 가르는 값이 data-review-origin이다.
//
// 이미 승인된 판에는 열 폼이 없다. 인박스의 줄에는 승인된 문서가 서지 않으므로 보통은
// 걸리지 않지만, 폴링 사이에 다른 사람이 승인한 건을 누르면 "승인할 것이 없다"는 안내만
// 옆에 세워 본문을 좁히게 된다.
function openReviewApproval(id) {
  const item = (state.snapshot.documents || []).find((value) => value.id === id);
  if (!item || !item.approval || item.approval.status === 'approved') return;
  if (!approvalPanel(id)) toggleApproval(id);
}

// ── 문서 승인 ───────────────────────────────────────────────────────────────
//
// 승인하는 자리는 문서 상세 하나다. 검토 인박스도 오래 같은 폼을 줄에서 펼쳤는데 그
// 자리에는 본문이 없었다 — 승인은 읽고 나서 하는 일이고, 무엇을 승인하는지가 화면에
// 없으면 그 승인은 "읽었다"의 증거가 되지 못한다(런 게이트 대화상자가 대상 문서를
// 함께 그리는 것과 같은 이유다). 그래서 폼은 한 벌만 두고 인박스는 그 자리로 데려간다.
//
// 한 번에 한 건만 연다. 여럿을 열어 두면 어느 폼에 무엇을 적었는지가 화면에서
// 흐려지고, 승인은 "이것을 내가 책임진다"는 선언이라 대상이 흐려지면 안 된다.

// 근거의 우리말. 목록 자체는 서버가 싣는다(approvalCatalog.basisKinds) — 화면이 목록을
// 적으면 그것은 vocabulary.js의 정본 사본이 되고, 근거 종류가 느는 날 화면만 모른 채
// 돈다. 표에 없는 종류는 저장값을 그대로 보여 준다.
const BASIS_LABELS = { read: '읽고 판단했다', verdict: '검증 판정을 봤다', check: '검사를 통과했다', delegated: '위임받았다' };
// 비교 축 둘. 묻는 것이 다르다 — 앞엣것은 "승인 이후 무엇이 바뀌었나"이고 뒤엣것은
// "승인 후보가 승인본과 무엇이 다른가"다. 승인자가 판정해야 하는 것은 작업본이 아니라
// 후보이므로, 제출이 서 있으면 뒤엣것이 먼저다. 키 목록이 곧 단추의 목록이다.
//
// 임의 비교(range)는 여기 없다. 이 표의 축들은 기준이 원장에 못박혀 있어 누구나 같은
// 것을 보지만, 임의 비교의 기준은 사람이 이력에서 고른다 — 단추 하나로 세우면 무엇과
// 무엇을 견주는 축인지가 이름에 없게 된다. 그래서 그쪽은 이력 탭에서 지점을 골라 연다.
const DIFF_AXIS_LABELS = { 'since-approval': '승인 이후 변경', submission: '제출본 비교' };
// 판의 탭 둘. 승인은 "지금 이것을 책임질까"를 묻고 이력은 "어쩌다 이렇게 됐나"를 묻는다.
// 같은 표면에 두는 이유는 renderDocumentApprovalPanel의 머리말에 적어 두었다.
const PANEL_TABS = { approve: '검토하고 승인', history: '이력과 비교' };
// 이력 줄의 종류. 원장 사건 셋과 커밋 하나가 한 시간축에 섞여 선다 — 값이 아니라 표시
// 이름이므로 키 목록이 곧 화면이 아는 종류의 목록이다.
const HISTORY_KIND_LABELS = { approval: '승인', submission: '제출', rejection: '반려', commit: '커밋' };
// 줄의 색. 목록에서 쓰는 태그 색을 그대로 물려받는다 — 같은 뜻에 화면마다 다른 색을 주면
// 사용자는 그것을 다른 종류로 읽는다. 색만으로 갈리지 않게 이름도 함께 적는다.
const HISTORY_KIND_TONES = { approval: 'pass', submission: 'warning', rejection: 'error', commit: 'info' };
// 한 번에 그리는 이력 줄의 수. 오래된 정본은 커밋만 수십 줄이라 통째로 그리면 판이
// 스크롤 덩어리가 되고, 이력을 여는 이유(가장 최근에 무슨 일이 있었나)는 맨 위에 있다.
// 나머지는 「더 보기」로 한 번에 편다 — 인박스와 태스크 묶음이 쓰는 그 수법이다.
const HISTORY_PAGE = 12;

function approvalPanel(id) { return state.docApproval && state.docApproval.id === id ? state.docApproval : null; }
function basisChoices() { return (state.snapshot.approvalCatalog && state.snapshot.approvalCatalog.basisKinds) || Object.keys(BASIS_LABELS); }

// 열려 있으면 그 판을 쓰고 없으면 만든다. 판의 상태를 부르는 자리마다 새로 짓지 않는
// 이유는, 갈아 끼우면 그 안의 다른 값이 함께 사라지기 때문이다 — 예전 판은 축을 바꿀
// 때마다 객체를 새로 만들고 폼만 손으로 옮겨 담았는데, 옮길 것이 늘 때마다 빠뜨리는
// 자리가 하나씩 생긴다. 지금은 이력·고른 지점·임의 비교 결과까지 이 안에 산다.
function documentPanel(id) {
  const open = approvalPanel(id);
  if (open) return open;
  const approvers = state.snapshot.approvers || [];
  state.docApproval = {
    id,
    tab: 'approve',
    axis: 'since-approval', diff: null, reason: '', error: '', loading: false,
    busy: false, failure: '',
    history: null, historyLoading: false, historyError: '', historyExpanded: false,
    // 고른 두 지점과 그 사이의 차분. pick은 사람이 고른 것이고 range는 서버가 답한 것이라
    // 따로 둔다 — 합치면 "고르는 중"과 "못 찾았다"가 같은 빈 값이 되어 구분되지 않는다.
    pick: { from: null, to: null }, range: null,
    form: { clientId: (approvers[0] && approvers[0].id) || '', basis: basisChoices()[0] || '', detail: '', reason: '' },
    // 수명 폼은 승인 폼과 칸을 나눠 쓰지 않는다. 두 축이 다른 원장(그리고 다른 자리)로
    // 나가므로 사유도 다른 문장이고, 한 칸을 나눠 쓰면 승인 사유로 적은 문장이 수명
    // 전환의 사유로 커밋에 실린다.
    lifecycle: { value: lifecycleOf(id), reason: '', ack: false, busy: false, failure: '' }
  };
  return state.docApproval;
}

function lifecycleOf(id) {
  const item = (state.snapshot.documents || []).find((value) => value.id === id);
  return (item && item.lifecycle) || '';
}

// 늦게 온 답이 먼저 온 답을 덮지 않게 하는 표. 판 객체를 갈아 끼우지 않게 되면서
// 객체 동일성만으로는 요청을 가릴 수 없어졌다 — 축을 빨리 두 번 누르면 먼저 나간
// 요청이 나중에 돌아와 화면이 사람이 고르지 않은 축의 차분을 보이게 된다.
let panelRequest = 0;

// 펼치기·접기. 제출본이 서 있으면 그 축으로 연다 — 승인자가 볼 것은 승인 후보이고,
// 후보와 작업본이 다를 수 있다는 사실 자체가 관문의 핵심이다.
//
// 탭을 인자로 받는다. 같은 탭을 다시 누르면 접고, 다른 탭이면 접지 않고 옮긴다 —
// 열린 판을 닫았다 다시 여는 왕복은 사람에게 "안 열린다"로 보인다.
function toggleApproval(id, tab) {
  const wanted = PANEL_TABS[tab] ? tab : 'approve';
  const open = approvalPanel(id);
  if (open && open.tab === wanted) { state.docApproval = null; return redrawApproval(); }
  if (!open) {
    const item = (state.snapshot.documents || []).find((value) => value.id === id);
    const submission = item && item.approval && item.approval.submission;
    const staged = submission && (submission.state === 'pending' || submission.state === 'drifted');
    documentPanel(id).axis = staged ? 'submission' : 'since-approval';
  }
  selectPanelTab(id, wanted);
}

// 탭이 자기 값을 열 때 한 번만 물어 온다. 오갈 때마다 물으면 문서마다 git 이력이 그만큼
// 다시 돌고, 그 값은 사람이 탭을 누르는 사이에 바뀌지 않는다. 반대로 열지 않은 탭의 값을
// 미리 물으면, 이력만 보러 온 사람이 쓰지도 않을 차분 계산을 매번 치른다.
//
// "물은 적이 있는가"는 답이 아니라 표로 안다. 차분은 없음(null)도 답이라 값으로는 아직
// 안 물은 것과 기준이 없다는 답을 가를 수 없다.
function selectPanelTab(id, tab) {
  const panel = documentPanel(id);
  panel.tab = PANEL_TABS[tab] ? tab : 'approve';
  if (panel.tab === 'history') loadDocumentHistory(id);
  else if (!panel.diffTicket) return void loadApprovalDiff(id, panel.axis);
  redrawApproval();
}

// 차분은 스냅숏에 없다. 문서마다 git 이력을 도는 계산이라 폴링에 실으면 보드가 서므로,
// 펼친 그 건에 대해서만 물어 온다.
async function loadApprovalDiff(id, axis) {
  const panel = documentPanel(id);
  // 축을 바꿔도 쓰던 것은 남긴다. 여기서 비우면 사유를 적다가 다른 축을 눌러 본
  // 사람이 자기가 쓴 문장을 잃는다.
  Object.assign(panel, { axis, diff: null, reason: '', error: '', loading: true });
  const ticket = panel.diffTicket = ++panelRequest;
  redrawApproval();
  try {
    const value = await api(`${projectPath(`/documents/${encodeURIComponent(id)}/diff`)}?axis=${encodeURIComponent(axis)}`);
    if (state.docApproval !== panel || panel.diffTicket !== ticket) return;
    panel.diff = value.diff === undefined ? null : value.diff;
    panel.reason = value.reason || '';
  } catch (error) {
    if (state.docApproval !== panel || panel.diffTicket !== ticket) return;
    panel.error = error.message;
  }
  panel.loading = false;
  redrawApproval();
}

// 이력도 스냅숏에 없다. 문서마다 git log --follow를 도는 값이라 폴링에 실으면 문서 수에
// 비례해 보드가 서고, 그 사실은 문서가 몇 건 안 되는 저장소에서는 드러나지 않는다.
async function loadDocumentHistory(id) {
  const panel = documentPanel(id);
  if (panel.history || panel.historyLoading) return;
  panel.historyLoading = true;
  panel.historyError = '';
  const ticket = panel.historyTicket = ++panelRequest;
  redrawApproval();
  try {
    const value = await api(projectPath(`/documents/${encodeURIComponent(id)}/history`));
    if (state.docApproval !== panel || panel.historyTicket !== ticket) return;
    panel.history = value;
    applyDefaultPick(panel);
  } catch (error) {
    if (state.docApproval !== panel || panel.historyTicket !== ticket) return;
    panel.historyError = error.message;
  }
  panel.historyLoading = false;
  redrawApproval();
  if (panel.pick.from && panel.pick.to && !panel.range) loadRangeDiff(id);
}

/**
 * 원장 사건과 커밋을 한 시간축에 세운다.
 *
 * 따로 세우면 사람이 머리로 합쳐야 한다. 그 합치기는 두 목록의 시각을 눈으로 번갈아
 * 훑는 일이라 줄이 늘면 곧 실패하고, 실패하면 "승인 뒤에 저 커밋이 왔나 앞에 왔나"를
 * 알 수 없다 — 이력을 여는 이유가 바로 그 물음이라 거기서 값이 통째로 사라진다.
 *
 * 원장 줄은 누가·왜를 알고(승인자·사유·근거) 커밋 줄은 무엇이·언제를 안다. 둘을
 * 나란히 두는 것이 이 화면의 값이므로 종류를 지우지 않고 표시로 갈라 둔다.
 *
 * 지목할 주소도 종류마다 다르다. 원장 줄은 자기가 판정한 리비전만 알고 커밋 줄은 커밋
 * 해시만 안다 — 한 종류로 통일하려면 화면이 커밋마다 문서를 다시 재야 하는데, 그것은
 * 화면이 판정을 다시 짓는 일이라 이 보드가 하지 않기로 한 것이다. 그래서 주소를 둘 다
 * 싣고 어느 쪽인지를 함께 적는다.
 */
function historyRows(history) {
  // 시간축은 서버가 세운다. 여기서 다시 세우지 않는 이유는 두 축의 시각 표기가 달라서다 —
  // 원장은 UTC로 적고 git은 `+09:00`으로 준다. 문자열로 견주면 같은 순간이 아홉 시간
  // 어긋난 자리에 놓이고, ADR-020에서 실제로 승인이 그보다 13분 앞선 커밋 위로 올라갔다.
  //
  // 순서만 받는 것이 아니라 못 읽는 시각과 같은 순간의 처리까지 함께 받는다. 그 규칙을
  // 화면이 따로 가지면 목록과 비교가 서로 다른 차례를 말하는 날이 온다.
  const timeline = (history && history.timeline) || null;
  if (timeline) {
    // 명의만 화면이 붙인다. 커밋의 author는 git이 아는 이름이라 MEMBER-ID가 아니고,
    // 원장 명의와 같은 함수를 지나가게 두면 다음 사람은 두 축의 신원이 같은 것이라 읽는다.
    return timeline.map((row) => Object.assign({}, row, { who: row.kind === 'commit' ? (row.who || '') : personName(row.who) }));
  }
  // 옛 판 서버는 timeline을 모른다. 그때는 목록을 직접 세우되, 위의 어긋남이 남는다는
  // 것을 알고 쓴다 — 지어내는 것보다 옛 차례라도 보이는 편이 낫다.
  const rows = [];
  for (const item of (history && history.approvals) || []) {
    rows.push({ kind: 'approval', at: item.recordedAt, who: personName(item.approvedBy), point: item.reviewedRevision, pointKind: 'revision', detail: item.reason || '', basis: item.basis || [] });
  }
  for (const item of (history && history.submissions) || []) {
    rows.push({ kind: 'submission', at: item.recordedAt, who: personName(item.submittedBy), point: item.submittedRevision, pointKind: 'revision', detail: item.reason || '', basis: [] });
  }
  for (const item of (history && history.rejections) || []) {
    rows.push({ kind: 'rejection', at: item.recordedAt, who: personName(item.rejectedBy), point: item.rejectedRevision, pointKind: 'revision', detail: item.reason || '', basis: [] });
  }
  for (const item of (history && history.commits) || []) {
    rows.push({ kind: 'commit', at: item.at, who: item.author || '', point: item.commit, pointKind: 'commit', detail: item.subject || '', basis: [] });
  }
  // 최근이 위다. 이력을 여는 물음("언제부터 이렇게 됐나")은 지금에서 거슬러 올라가는
  // 물음이고, 「더 보기」로 뒤를 접는 것도 그 방향이라야 접힌 쪽이 오래된 쪽이 된다.
  return rows.sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')));
}

// 이력을 열면 흔히 묻는 것이 이미 골라져 있다. 승인본 ↔ 가장 최근 커밋이 그것이다 —
// 「승인 이후 변경」과 다른 점은 오른쪽이 작업본이 아니라 커밋이라는 것이고, 그래서
// 두 지점 모두 다시 볼 수 있는 주소를 갖는다.
//
// 승인이 없으면 최근 두 커밋을 고른다. 아무것도 안 고른 채 열면 사람은 무엇을 눌러야
// 무엇이 나오는지 모른 채 목록만 보게 된다 — 첫 화면이 답을 하나 보여야 그 다음 물음을
// 만들 수 있다. 고를 것이 둘도 안 되면 비워 둔다: 없는 지점을 지어내지 않는다.
function applyDefaultPick(panel) {
  if (panel.pick.from || panel.pick.to) return;
  const rows = historyRows(panel.history);
  const approvedRevision = panel.history && panel.history.document && panel.history.document.approvedRevision;
  const approved = approvedRevision ? rows.find((row) => row.kind === 'approval' && row.point === approvedRevision) : null;
  const commits = rows.filter((row) => row.kind === 'commit');
  if (approved && commits.length) { panel.pick = { from: pickOf('approval', approved.point), to: pickOf('commit', commits[0].point) }; return; }
  if (commits.length >= 2) panel.pick = { from: pickOf('commit', commits[1].point), to: pickOf('commit', commits[0].point) };
}

// 고른 지점의 이름은 줄의 종류에서 온다. 해시 앞자리만으로는 어느 줄을 골랐는지
// 되짚을 수 없고, 되짚지 못하면 "무엇과 무엇을 견주고 있는가"가 화면에서 사라진다.
function pickOf(rowKind, point) {
  return { kind: rowKind === 'commit' ? 'commit' : 'revision', value: point, label: `${HISTORY_KIND_LABELS[rowKind] || rowKind} ${String(point || '').slice(0, 8)}` };
}

// 고른 두 지점 사이의 차분. 서버가 값의 종류를 길이로 가르므로 화면은 고른 주소를 그대로
// 보내기만 한다 — 종류를 따로 실으면 화면이 그 칸을 틀리게 채우는 갈래가 생긴다.
async function loadRangeDiff(id) {
  const panel = documentPanel(id);
  const from = panel.pick.from;
  const to = panel.pick.to;
  if (!from || !to) { panel.range = null; return redrawApproval(); }
  panel.range = { loading: true, diff: null, reason: '', error: '' };
  const ticket = panel.rangeTicket = ++panelRequest;
  redrawApproval();
  try {
    const value = await api(`${projectPath(`/documents/${encodeURIComponent(id)}/diff`)}?axis=range&from=${encodeURIComponent(from.value)}&to=${encodeURIComponent(to.value)}`);
    if (state.docApproval !== panel || panel.rangeTicket !== ticket) return;
    panel.range = { loading: false, diff: value.diff === undefined ? null : value.diff, reason: value.reason || '', error: '' };
  } catch (error) {
    if (state.docApproval !== panel || panel.rangeTicket !== ticket) return;
    panel.range = { loading: false, diff: null, reason: '', error: error.message };
  }
  redrawApproval();
}

// 지점을 고른다. 이미 그 칸에 있는 것을 다시 누르면 놓는다 — 잘못 고른 것을 무르는 길이
// 없으면 사람은 판을 닫았다 다시 여는 것으로 무르게 되고, 그때 쓰던 사유까지 잃는다.
function pickHistoryPoint(id, slot, rowKind, value) {
  const panel = documentPanel(id);
  const current = panel.pick[slot];
  panel.pick = Object.assign({}, panel.pick, { [slot]: current && current.value === value ? null : pickOf(rowKind, value) });
  panel.range = null;
  if (panel.pick.from && panel.pick.to) return void loadRangeDiff(id);
  redrawApproval();
}

// 문서 상세의 승인 판은 본문을 밀어내지 않는다.
//
// 오래 이 판은 본문 바로 앞의 블록이었다. 열면 685px짜리 판이 본문 위에 끼어들어 본문을
// 뷰포트 밖으로 밀어냈고(1500×1000에서 본문의 보이는 높이가 584px → 0px), 사람이 보기에는
// "문서를 눌렀는데 문서가 안 열리고 승인만 나온다"였다. DOM에는 그대로 있고 hidden도
// 아니지만, 화면에서 사라진 것과 없는 것은 사람에게 같다.
//
// 그래서 흐름에서 뺀다. 자리는 태스크·사람 peek이 쓰는 그 오른쪽 표면이고 폭도 같은
// 토큰을 쓴다 — 옆으로 나오는 표면이 화면마다 다른 폭을 가지면 사용자는 그것을 다른
// 종류의 표면으로 읽는다. 본문은 그만큼 오른쪽 여백을 얻어 가려지지 않는다.
//
// 모달로 만들지 않았다. 모달은 차분을 넓게 볼 수 있지만 본문을 통째로 가리는데, 검토는
// 차분과 본문을 나란히 보는 일이다 — 차분은 "무엇이 바뀌었나"에만 답하고 "그래서 이 문서가
// 말이 되나"는 본문에만 있다. 가리면 이 결함이 모양만 바꿔 돌아온다.
//
// 바깥을 눌러도 닫지 않는다. 사유를 적다가 본문을 짚어 읽는 것이 이 화면에서 하는 일이고,
// 그때 판이 닫히면 쓰던 문장을 잃는다 — peek의 바깥 클릭 규칙을 그대로 물려받지 않는 이유다.
//
// 이력과 임의 비교도 이 판의 탭으로 들어온다. 모달로 세우지 않은 이유는 승인 판과 같다:
// 모달은 이력을 넓게 볼 수 있지만 본문을 통째로 가리는데, "언제부터 이렇게 됐나"를 묻는
// 사람은 그 답을 본문의 어느 문단에 겹쳐 읽는다 — 가리면 오너가 겪은 그 결함("문서를
// 눌렀는데 문서가 안 열린다")이 모양만 바꿔 돌아온다.
//
// 표면을 하나 더 세우지도 않았다. 이력과 승인은 같은 판단의 앞뒤라 나란히 서면 둘 다
// 본문의 폭을 가져가고, 그러면 본문이 다시 읽을 수 없는 폭이 된다 — 옆으로 나오는 표면은
// 화면에 하나여야 한다는 규칙이 서 있는 자리가 여기다. 그래서 같은 판을 탭으로 나눈다.
function renderDocumentApprovalPanel(id) {
  const open = Boolean(approvalPanel(id));
  el('document-approval-panel').innerHTML = open ? approvalPanelHtml(id) : '';
  document.body.classList.toggle('approval-open', open);
}

// 펼친 자리만 다시 그린다. 문서 상세에서 본문까지 다시 그리면 읽던 자리를 잃고,
// 그 화면은 지금 읽고 승인하는 자리다.
//
// 검토 줄의 띠도 함께 다시 그린다. 승인이나 반려가 끝나면 이 문서는 줄에서 빠지므로
// 「몇 번째인가」와 「다음 대기 건」이 그 자리에서 바뀌어야 하고, 안 바꾸면 방금 처리한
// 건을 다음 차례로 가리킨 채 남는다.
function redrawApproval() {
  if (state.view !== 'document' || !state.selected) return;
  const item = (state.snapshot.documents || []).find((value) => value.id === state.selected);
  if (!item) return;
  el('document-approval').innerHTML = documentApprovalHtml(item);
  renderDocumentApprovalPanel(item.id);
  renderReviewNav(item.id);
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

// 차분 한 벌을 두 자리가 나눠 쓴다. 정해진 축(승인 탭)과 고른 두 지점(이력 탭)은 기준을
// 정하는 방법만 다르고 그려야 할 것은 같다 — 두 벌 만들면 한쪽만 "기준 없음"과 "변경
// 없음"을 가르게 되고, 그 차이는 사람이 잘못 승인한 다음에야 드러난다. 그래서 받는 것을
// 판이 아니라 {loading, error, diff, reason} 모양으로 좁혔다.
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

function approvalFormHtml(id, panel) {
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
    // 칸 이름이 "승인자"가 아니라 "판정자"인 것은 이 자리에서 나가는 답이 둘이기
    // 때문이다. 반려도 같은 사람 게이트를 지나므로 고르는 자격도 같고, 칸을 둘로
    // 나누면 같은 목록이 두 벌이 되어 한쪽만 낡는다.
    + `<label>판정자<select data-approve-field="clientId">${approvers.map((client) =>
      `<option value="${escapeHtml(client.id)}"${client.id === form.clientId ? ' selected' : ''}>${escapeHtml(client.name || client.id)} (${escapeHtml(client.id)})</option>`).join('')}</select></label>`
    // 근거는 화면에서도 필수다. 나중에 "AI 검토가 놓쳤나 사람이 건너뛰었나"를 가르려면
    // 그 값이 있어야 하고, 그 구분이 없으면 승인 이력은 누가 눌렀다는 목록에 그친다.
    + `<label>근거<select data-approve-field="basis">${basisChoices().map((kind) =>
      `<option value="${escapeHtml(kind)}"${kind === form.basis ? ' selected' : ''}${kind === 'delegated' ? ' disabled' : ''}>`
      + `${escapeHtml(BASIS_LABELS[kind] || kind)}${kind === 'delegated' ? ' — 위임 식별자가 필요해 명령줄에서만' : ''}</option>`).join('')}</select></label>`
    + `<label>근거 상세<input data-approve-field="detail" maxlength="300" placeholder="예: 3장 전체 재독" value="${escapeHtml(form.detail || '')}"></label>`
    // 사유 칸은 둘이 나눠 쓴다. 승인에서는 선택이지만 반려에서는 필수다 — 승인에는
    // 근거라는 별도 칸이 있고 반려는 사유가 내용 전부이기 때문이다.
    + `<label>사유<textarea data-approve-field="reason" rows="2" maxlength="1000" placeholder="승인이면 무엇을 보고 승인했는지, 반려면 왜 아닌지">${escapeHtml(form.reason || '')}</textarea></label>`
    + '<div class="approval-form-actions">'
    // 「반려」가 「승인」 옆에 선다. 이 단추가 없는 동안 검토자가 "아니오"를 말할 자리가
    // 화면에 없었고, 그래서 그 판단은 댓글이나 태스크로 샜다 — 새면 원장 밖의 말이
    // 되어 상태를 만들지 못한다. 기본 단추로 두지 않는 이유는 엔터가 반려로 떨어지면
    // 안 되기 때문이다: 되돌릴 수 없는 판단은 눌러서만 나가야 한다.
    + `<button type="button" data-approve-reject="${escapeHtml(id)}"${panel.busy ? ' disabled' : ''}>${panel.busy ? '보내는 중…' : '반려'}</button>`
    + `<button type="submit" class="primary"${panel.busy ? ' disabled' : ''}>${panel.busy ? '승인하는 중…' : '승인'}</button></div>`
    // 근거가 승인에만 쓰인다는 것은 적어 둔다. 폼이 하나라 반려할 때도 근거 칸이 보이는데,
    // 그것을 고르고 반려한 사람은 자기가 남긴 근거가 원장에 있다고 믿게 된다.
    + '<p class="ledger-note">반려에는 사유만 남습니다. 근거는 승인이 무엇에 기댔는지를 가르는 값이라 반려에는 실리지 않고, 반려는 신뢰 상태를 바꾸지 않습니다 — 이 문서는 여전히 미승인이며 차례만 작성자에게 넘어갑니다.</p>'
    // 거절은 서버의 말 그대로 옮긴다. "승인 실패"로 바꾸면 사람 게이트에 걸린 것인지
    // 근거가 모자란 것인지 알 수 없어 같은 단추를 다시 누르게 된다.
    + (panel.failure ? `<p class="approval-failure">${escapeHtml(panel.failure)}</p>` : '')
    + '</form>';
}

// 이 판은 본문 옆으로 나온다(위 renderDocumentApprovalPanel). 옆으로 나온 표면은 자기가
// 무엇인지와 닫는 길을 스스로 갖고 있어야 한다 — 여는 손잡이는 본문 위 상태 줄에 있어서,
// 판을 열고 스크롤을 내리면 그 손잡이가 화면 밖으로 나간다.
//
// 표면을 가리는 인자는 없앴다. 인박스가 줄에서 같은 판을 펼치던 동안에는 머리를 둘지
// 말지가 갈렸는데, 이제 이 판이 서는 자리는 문서 상세 하나뿐이다 — 갈래가 없어졌는데
// 인자를 남겨 두면 다음 사람은 어딘가에 다른 표면이 있는 줄로 읽는다.
function approvalPanelHtml(id) {
  const panel = approvalPanel(id);
  if (!panel) return '';
  const head = `<div class="approval-panel-head"><h2>문서 검토</h2><span class="eyebrow">${escapeHtml(id)}</span><button type="button" class="icon-button" data-approve-open="${escapeHtml(id)}" aria-label="검토 판 닫기">${CLOSE_ICON}</button></div>`;
  // 탭은 판의 머리 바로 아래 하나뿐이다. 두 물음이 한 표면을 나눠 쓰므로 어느 쪽을 보고
  // 있는지가 언제나 화면에 있어야 하고, 그 표시가 곧 옮겨 가는 손잡이여야 한다.
  const tabs = Object.keys(PANEL_TABS).map((key) =>
    `<button type="button" data-approve-open="${escapeHtml(id)}" data-approve-tab="${key}"${key === panel.tab ? ' class="active"' : ''}>${escapeHtml(PANEL_TABS[key])}</button>`).join('');
  const body = panel.tab === 'history' ? historyTabHtml(id, panel) : approveTabHtml(id, panel);
  return `<div class="approval-panel">${head}<div class="segmented approval-tabs" aria-label="검토 판 탭">${tabs}</div>${body}</div>`;
}

function approveTabHtml(id, panel) {
  const axes = Object.keys(DIFF_AXIS_LABELS).map((key) =>
    `<button type="button" data-approve-axis="${key}"${key === panel.axis ? ' class="active"' : ''}>${escapeHtml(DIFF_AXIS_LABELS[key])}</button>`).join('');
  return `<div class="segmented approval-axis" aria-label="비교 축">${axes}</div>`
    + approvalDiffHtml(panel) + approvalFormHtml(id, panel) + lifecycleFormHtml(id, panel);
}

/**
 * 수명은 승인 옆에 선다. 같은 판이지 같은 축이 아니다.
 *
 * 두 축을 한 폼으로 합치지 않는 이유는 화면이 이미 두 칩으로 갈라 그린 이유와 같다 —
 * 승인은 "이 판을 누가 책임졌나"이고 수명은 "이 내용이 아직 서 있나"다. 「승인됨이면서
 * 대체됨」이 실재하므로(ADR-020·ADR-021) 한 손잡이로 접으면 화면이 그 짝을 말할 수 없다.
 *
 * 「수명 없음」이 고르개의 첫 항목이고 그것이 곧 지우는 갈래다. 비어 있는 것과 active는
 * 다른 값이라 지우는 길이 고르는 길과 나란히 있어야 하고, 손잡이를 따로 두면 고르개와
 * 손잡이가 서로 다른 축이 되어 「수명 없음」을 고른 사람이 왜 안 지워지는지 묻게 된다.
 */
function lifecycleFormHtml(id, panel) {
  const item = (state.snapshot.documents || []).find((value) => value.id === id);
  if (!item) return '';
  const form = panel.lifecycle;
  const current = item.lifecycle || '';
  const chosen = form.value === undefined ? current : form.value;
  const moving = chosen !== current;
  // 살아 있는 승인이 걸린 문서에서 수명을 바꾸는 것은 그 승인을 쓰는 일이다. 수명 값이
  // 리비전 해시 안에 있어(계산 판 2가 빼는 것은 state 하나다) 이 칸이 움직이면 승인이
  // 그 자리에서 낡는다 — 결함이 아니라 축이고, 그래서 **누르기 전에** 말한다.
  const approved = Boolean(item.approval && item.approval.status === 'approved');
  const warn = approved && moving;
  const options = [['', '수명 없음 — 이 칸을 지웁니다']].concat(documentLifecycleKeys().map((key) => [key, documentLifecycleLabel(key)]));
  return '<form class="lifecycle-form" data-lifecycle-form="' + escapeHtml(id) + '">'
    + '<h3>수명</h3>'
    + `<p class="ledger-note">승인과 다른 축입니다. 승인은 「이 판을 누가 책임졌나」이고 수명은 「이 내용이 아직 서 있나」입니다. 지금 값: ${current ? escapeHtml(documentLifecycleLabel(current)) : '없음'}</p>`
    + `<label>옮길 값<select data-lifecycle-field="value">${options.map(([key, label]) =>
      `<option value="${escapeHtml(key)}"${key === chosen ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>`
    // 사유가 이 축의 값 전부다. 「대체됨」이 적혀도 왜 대체했는지가 남지 않는 것이
    // 지금까지의 상태였고, 그 사유는 이 변경을 담은 커밋 메시지에 실린다.
    + `<label>사유<textarea data-lifecycle-field="reason" rows="2" maxlength="1000" placeholder="예: ADR-026이 이 결정을 대체함">${escapeHtml(form.reason || '')}</textarea></label>`
    + (warn ? '<p class="lifecycle-warning"><b>이 변경은 지금 승인을 낡게 합니다.</b> '
      + `${escapeHtml(personName(item.approval.approvedBy))}의 승인이 낡음이 되고, 다시 누르려면 그 사람이 이 문서를 다시 봐야 합니다. `
      + '수명 값이 리비전 해시 안에 있어 생기는 일이며 결함이 아니라 축입니다 — 내용이 바뀌면 다시 봐야 합니다.</p>'
      + `<label class="lifecycle-ack"><input type="checkbox" data-lifecycle-field="ack"${form.ack ? ' checked' : ''}>이 승인이 낡는 것을 알고 바꿉니다</label>` : '')
    + '<div class="lifecycle-form-actions">'
    + `<button type="submit" ${panel.busy || form.busy || !moving ? 'disabled' : ''}>${form.busy ? '옮기는 중…' : moving ? '수명 옮기기' : '바꿀 것이 없습니다'}</button></div>`
    + (form.failure ? `<p class="approval-failure">${escapeHtml(form.failure)}</p>` : '')
    + '</form>';
}

/**
 * 이력과 임의 비교.
 *
 * 고른 지점을 이력보다 먼저 그린다. 두 번째를 고르기 전에도 화면이 무엇을 기다리는지
 * 말해야 하는데, 그 말이 목록 아래에 있으면 이력이 길어질수록 화면 밖으로 나간다 —
 * 기다린다는 말이 안 보이면 사람은 한 번 누른 뒤 아무 일도 안 일어난 줄로 읽는다.
 */
function historyTabHtml(id, panel) {
  if (panel.historyLoading) return '<p class="ledger-note">이력을 읽는 중입니다…</p>';
  if (panel.historyError) return `<p class="approval-failure">이력을 읽지 못했습니다: ${escapeHtml(panel.historyError)}</p>`;
  if (!panel.history) return '<p class="ledger-note">이력을 아직 읽지 않았습니다.</p>';
  const rows = historyRows(panel.history);
  const shown = panel.historyExpanded ? rows : rows.slice(0, HISTORY_PAGE);
  const lines = [historyPickHtml(id, panel)];
  // 승인도 태스크도 없이 바뀐 정본은 이력이 답할 수 없는 변경이다. 삼키면 이 화면이
  // 그 사실을 아는 유일한 자리인데도 아무 말을 하지 않게 된다.
  if (panel.history.warning) lines.push(`<p class="approval-failure">${escapeHtml(panel.history.warning)}</p>`);
  if (!rows.length) lines.push('<p class="ledger-note">원장 사건도 커밋도 없습니다. 이 문서는 아직 저장소의 이력에 남은 적이 없습니다.</p>');
  else lines.push(`<ol class="history-list">${shown.map((row) => historyRowHtml(id, panel, row)).join('')}</ol>`);
  if (rows.length > shown.length) lines.push(`<button type="button" class="review-inbox-more" data-history-expand="${escapeHtml(id)}">${rows.length - shown.length}개 더 보기</button>`);
  // 연결 태스크는 "왜 바뀌었나"의 다른 갈래다. 원장에 승인이 없어도 태스크가 있으면 그
  // 변경에는 답할 기록이 있고, 그 사실이 화면에 없으면 위의 경고만 보고 겁먹게 된다.
  const tasks = panel.history.tasks || [];
  if (tasks.length) lines.push(`<p class="ledger-note">연결 태스크 ${tasks.length}건: ${tasks.map((task) => `<code>${escapeHtml(task.id)}</code>`).join(' ')}</p>`);
  return lines.join('');
}

function historyPickHtml(id, panel) {
  const from = panel.pick.from;
  const to = panel.pick.to;
  const slot = (key, label, value) => `<span class="history-slot"><b>${label}</b> ${value ? escapeHtml(value.label) : '고르지 않음'}`
    + (value ? `<button type="button" class="history-slot-clear" data-history-clear="${key}" data-history-document="${escapeHtml(id)}" aria-label="${label} 지점 놓기">${CLOSE_ICON}</button>` : '') + '</span>';
  const waiting = from && to ? ''
    : `<p class="ledger-note">${from ? '기준을 골랐습니다. 이력에서 「대상」을 하나 더 고르면 그 사이를 견줍니다.'
      : to ? '대상을 골랐습니다. 이력에서 「기준」을 하나 더 고르면 그 사이를 견줍니다.'
        : '이력에서 「기준」과 「대상」을 하나씩 고르면 그 두 지점 사이를 견줍니다.'}</p>`;
  // 작업본은 이 비교에 서지 않는다. 두 지점 모두 커밋된 주소라야 사람이 본 것과 결박되고,
  // 커밋되지 않은 작업본까지 견주는 물음은 승인 탭의 「승인 이후 변경」이 이미 답한다.
  const note = from && to ? '' : '<p class="ledger-note">아직 커밋하지 않은 작업본과 견주려면 「검토하고 승인」 탭의 「승인 이후 변경」을 보십시오.</p>';
  return `<div class="history-pick">${slot('from', '기준', from)}<span class="history-slot-arrow" aria-hidden="true">→</span>${slot('to', '대상', to)}</div>`
    + waiting + note + (from && to ? approvalDiffHtml(panel.range || { loading: true, diff: null, reason: '', error: '' }) : '');
}

function historyRowHtml(id, panel, row) {
  const picked = (slot) => panel.pick[slot] && panel.pick[slot].value === row.point;
  // 지목할 주소가 없는 줄은 고를 수 없다. 없는 지점을 만들어 보내면 서버가 거절하고,
  // 그 거절은 사람이 누른 뒤에야 온다 — 고를 수 없는 것은 고르는 손잡이를 두지 않는다.
  const pick = row.point
    ? `<span class="history-pick-buttons">${['from', 'to'].map((slot) =>
      `<button type="button" data-history-pick="${slot}" data-history-document="${escapeHtml(id)}" data-history-kind="${escapeHtml(row.kind)}" data-history-point="${escapeHtml(row.point)}"${picked(slot) ? ' class="active"' : ''}>${slot === 'from' ? '기준' : '대상'}</button>`).join('')}</span>`
    : '';
  const basis = (row.basis || []).map((item) => BASIS_LABELS[item.kind] || item.kind).join(' · ');
  return `<li class="history-row history-${escapeHtml(row.kind)}">`
    + `<span class="history-head"><span class="tag ${HISTORY_KIND_TONES[row.kind] || 'info'}">${escapeHtml(HISTORY_KIND_LABELS[row.kind] || row.kind)}</span>`
    + `<span class="history-who">${escapeHtml(row.who || '이름 없음')}</span>`
    + `<time class="history-at">${escapeHtml(historyStamp(row.at))}</time>${pick}</span>`
    + (row.detail ? `<span class="history-detail">${escapeHtml(row.detail)}</span>` : '')
    + (basis ? `<span class="history-detail">근거: ${escapeHtml(basis)}</span>` : '')
    + `<code class="history-point">${escapeHtml(String(row.point || '').slice(0, 12) || '주소 없음')}</code></li>`;
}

// 이력의 시각은 절대값이 먼저다. "언제부터 이렇게 됐나"는 달력의 물음이라 "3일 전"으로는
// 답하지 못하고, 그래도 최근인지는 알아야 하므로 상대값을 함께 붙인다.
function historyStamp(value) {
  const stamp = Date.parse(value || '');
  if (Number.isNaN(stamp)) return '시각 없음';
  return `${String(value).slice(0, 10)} · ${relativeTime(value)}`;
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

// 반려도 같은 자리에서 나간다. 폼을 따로 만들지 않는 이유는 승인과 같다 — 화면마다
// 폼을 두면 한쪽만 사유를 받거나 한쪽만 거절 문장을 삼키고, 그 차이는 눌러 본 다음에야
// 드러난다.
//
// 사유가 비면 보내지 않는다. 서버도 막지만 왕복이 아깝고, 무엇보다 왕복하는 동안
// 사람은 자기가 무엇을 빠뜨렸는지 모른 채 기다린다.
async function rejectOpenDocument(id) {
  const panel = approvalPanel(id);
  if (!panel || panel.busy) return;
  const form = panel.form;
  if (!form.clientId) return message('판정자를 고르세요. 활성 human Client만 반려할 수 있습니다.', true);
  if (!String(form.reason || '').trim()) return message('왜 아닌지 사유가 필요합니다. 사유 없는 반려는 작성자에게 침묵과 같습니다.', true);
  panel.busy = true;
  panel.failure = '';
  redrawApproval();
  try {
    // 근거는 보내지 않는다. 반려 이벤트에 그 칸이 없고, 화면만 보내면 서버가 모르는
    // 필드로 거절한다 — 폼이 하나라고 해서 계약도 하나인 것은 아니다.
    const result = await api(projectPath(`/documents/${encodeURIComponent(id)}/reject`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
      body: JSON.stringify({ clientId: form.clientId, reason: String(form.reason).trim() })
    });
    state.docApproval = null;
    message(`${id}을(를) 반려했습니다. ${result.document.submission.rejection.rejectedBy}의 판단이며, 이 문서는 여전히 미승인입니다 — 차례가 작성자에게 넘어갔습니다.`);
    // 승인과 같은 이유로 스냅숏을 다시 읽는다. 화면이 상태를 직접 고치면 그것이 두 번째
    // 진실 원천이 되고, 서버가 아니라고 답해도 화면은 반려됐다고 말한다.
    await loadSnapshot(true);
    redrawApproval();
  } catch (error) {
    panel.busy = false;
    panel.failure = error.message;
    redrawApproval();
  }
}

/**
 * 수명을 옮긴다. 승인과 같은 자리에서 나가지만 다른 원장도 다른 축도 아니다 —
 * 이 변경은 문서 내용이라 파일과 커밋으로 남는다.
 *
 * 사유가 비면 보내지 않는다. 서버도 막지만 왕복이 아깝고, 무엇보다 왕복하는 동안 사람은
 * 자기가 무엇을 빠뜨렸는지 모른 채 기다린다 — 반려 단추가 쓰는 규칙과 같다.
 *
 * 낡음 확인은 화면에서도 먼저 받는다. 서버의 거절이 정본이지만, 그 거절을 받아야만
 * 경고를 보는 흐름이면 사람은 "누르기 전에" 안 것이 아니라 눌러 보고 안 것이 된다.
 */
async function applyDocumentLifecycle(id) {
  const panel = approvalPanel(id);
  if (!panel || panel.busy || panel.lifecycle.busy) return;
  const item = (state.snapshot.documents || []).find((value) => value.id === id);
  if (!item) return;
  const form = panel.lifecycle;
  const current = item.lifecycle || '';
  const chosen = form.value === undefined ? current : form.value;
  if (chosen === current) return message('옮길 값이 지금 값과 같습니다.', true);
  if (!String(form.reason || '').trim()) return message('수명을 옮기는 사유가 필요합니다. 값만 옮기면 왜 옮겼는지가 어디에도 남지 않습니다.', true);
  if (item.approval && item.approval.status === 'approved' && !form.ack) {
    return message('이 변경은 지금 승인을 낡게 합니다. 그 사실을 확인해야 보낼 수 있습니다.', true);
  }
  form.busy = true;
  form.failure = '';
  redrawApproval();
  try {
    const result = await api(projectPath(`/documents/${encodeURIComponent(id)}/lifecycle`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
      body: JSON.stringify({ lifecycle: chosen, reason: String(form.reason).trim(), ackStale: Boolean(form.ack) })
    });
    state.docApproval = null;
    message(`${id}의 수명을 ${result.to ? documentLifecycleLabel(result.to) : '없음'}(으)로 옮겼습니다. 사유는 커밋 ${String(result.commit || '').slice(0, 12)}에 남았습니다.`);
    // 승인과 같은 이유로 스냅숏을 다시 읽는다. 화면이 상태를 직접 고치면 그것이 두 번째
    // 진실 원천이 되고, 서버가 아니라고 답해도 화면은 옮겨졌다고 말한다.
    await loadSnapshot(true);
    redrawApproval();
  } catch (error) {
    form.busy = false;
    form.failure = error.message;
    redrawApproval();
  }
}

// 셈과 줄이 어긋나면 왜 어긋나는지를 말한다. 이유는 둘이고 뭉치면 안 된다 — 접힌 것은
// "한 번에 다 안 그렸다"이고 반려된 것은 "이미 답했다"라, 앞엣것만 적으면 자기가 방금
// 반려한 문서를 스냅숏이 삼킨 줄로 읽는다.
//
// 세 번째 이유였던 절단은 없앴다. 스냅숏이 줄을 통째로 싣게 되어 "잘려서 없다"는 갈래
// 자체가 사라졌고, 없어진 사실을 설명하는 안내를 남겨 두면 화면은 일어나지 않는 일을
// 계속 설명하게 된다.
//
// 접힌 것은 되돌릴 수 있으므로 안내가 목록 밖에 서고 손잡이는 목록 끝에 선다. 안내만
// 두면 펴는 길이 없고, 손잡이만 두면 머리의 셈과 그려진 줄이 어긋난 채로 사람이 목록
// 끝까지 내려가야 그 이유를 만난다 — 그 사이에 화면은 틀린 것처럼 보인다.
//
// 한 문장으로 답이 되면 거기서 멈춘다. 같은 사실을 두 문단으로 적으면 읽는 사람은
// 둘이 다른 사실인 줄 알고 두 번 센다.
function reviewGapNotes(queue, shown, listed, full) {
  const note = (text) => `<p class="review-inbox-note">${text}</p>`;
  const rejectedNote = `<b>${queue.rejected}건</b>은 반려되어 이 줄에서 빠졌습니다. 차례가 작성자에게 넘어간 것이고, 고쳐서 다시 올리면 돌아옵니다 — <code>rdl doc status --submission rejected</code>로 봅니다.`;
  const foldedNote = `<b>${listed}건 중 ${shown}건</b>을 그리고 있습니다. 나머지는 목록 끝의 「더 보기」로 폅니다.`;
  const missing = listed < full ? note(`<b>${full}건 중 ${listed}건</b>이 줄에 서 있습니다. 나머지는 반려되어 작성자 차례로 넘어갔습니다.`) : '';
  return (shown < listed ? note(foldedNote) : '') + missing + (queue.rejected ? note(rejectedNote) : '');
}

function renderReviewInbox() {
  const queue = state.snapshot.reviewQueue;
  const mode = reviewMode(queue);
  const filters = el('review-inbox-filter');
  const summary = el('review-inbox-summary');
  const list = el('review-inbox-list');
  // 범위를 먼저 정한다. 주소로 들어온 값이 무엇이든 이 화면이 아는 범위는 둘이고, 모르는
  // 값을 그대로 들면 그 뒤의 모든 판정이 "둘 다 아닌" 상태로 돌아 아무 줄도 서지 않는다.
  const scope = state.reviewScope === 'mine' ? 'mine' : 'all';
  state.reviewScope = scope;
  for (const button of document.querySelectorAll('#review-inbox-scope [data-review-scope]')) button.classList.toggle('active', button.dataset.reviewScope === scope);
  // 제목과 설명이 범위를 따라간다. 태스크 화면이 범위마다 제목을 갈아 끼우는 것과 같은
  // 자리다 — 같은 물음에 답하는 화면 둘이 다른 모양이면 배우는 비용이 두 배다.
  el('review-inbox-heading').textContent = scope === 'mine' ? '내 차례' : '검토 인박스';
  el('review-inbox-description').innerHTML = scope === 'mine'
    ? '이 프로젝트의 검토 줄에서 <b>지금 나에게 넘어온 것</b>만 갈래로 나눠 봅니다. 갈래마다 해야 할 일이 다릅니다. 판정은 <code>rdl doc status</code>와 같은 값이고, 이 화면은 그 값을 사람 축으로 좁혀 그립니다.'
    : '승인 원장과 어긋난 문서를 모아 봅니다. 판정과 순서는 <code>rdl doc status</code>와 같은 값이며, 이 화면은 그 값을 옮겨 그립니다.';
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
  // 여기부터가 줄이 서는 갈래다. 위의 셋(없음·모름·안 씀)은 프로젝트 전체의 사실이라
  // 범위를 안 가린다 — 원장을 못 읽은 것은 내 차례로 좁힌다고 읽히지 않는다.
  if (scope === 'mine') return renderReviewTurns();
  const counts = queue.counts;
  const filter = state.reviewFilter === 'all' || REVIEW_STATUS_TONES[state.reviewFilter] ? state.reviewFilter : 'all';
  state.reviewFilter = filter;
  // 거르개의 수는 전건이다. 그린 줄의 수를 적으면 접힌 목록에서 두 수가 어긋나고, 그때
  // 사람은 접혔다는 사실이 아니라 화면이 틀렸다는 인상을 받는다.
  filters.innerHTML = [['all', '전체', queue.total]].concat(Object.keys(REVIEW_STATUS_TONES).map((key) => [key, REVIEW_STATUS_LABELS[key], counts[key]]))
    .map(([key, label, count]) => `<button type="button" data-review-filter="${key}"${key === filter ? ' class="active"' : ''}>${key === 'all' ? '' : '<span class="severity-dot" aria-hidden="true"></span>'}${escapeHtml(label)} ${count}</button>`).join('');
  // 서버는 낡음을 앞에 두고 대기 시간 순으로 정렬해 보냈다. 여기서 다시 정렬하면 두 순서가
  // 갈리고, 그때 화면이 말하는 "먼저 볼 것"은 근거 없는 순서가 된다. 거르기만 한다.
  //
  // 거르는 것은 줄 전체에서 고른다. 예전에는 서버가 앞 50건만 실었고 이 자리는 그 50건을
  // 걸렀다 — 그래서 "미승인만"을 눌러도 잘린 뒤의 유형은 영영 나타나지 않았다. 이제 줄이
  // 통째로 오므로 이 한 줄이 전건을 본다.
  const visible = filter === 'all' ? queue.items : queue.items.filter((item) => item.status === filter);
  // 한 번에 그리는 줄 수는 화면이 정한다. 149줄을 한 벽으로 세우면 훑을 수 있는 목록이
  // 아니게 된다. 태스크 화면이 묶음마다 쓰는 수법과 같다 — 앞의 몇 줄만 두고 나머지는
  // 「더 보기」로 한 번에 편다.
  //
  // 편 상태는 거르개를 바꾸면 풀린다. 다른 갈래의 줄은 다른 목록이라, 낡음 2건을 보려고
  // 누른 「더 보기」가 미승인 149건에 그대로 걸리면 사람이 요청하지 않은 벽이 선다.
  const shown = state.reviewExpanded ? visible : visible.slice(0, REVIEW_PAGE);
  // 셈은 전건이다. 줄에 선 수와 그린 수와 전건이 서로 다를 수 있고 어긋나는 이유가
  // 저마다 다르므로, 셋을 함께 넘겨 안내가 그 이유를 가르게 한다.
  const full = filter === 'all' ? queue.total : counts[filter];
  summary.innerHTML = `<div class="review-inbox-counts">${[['검토 대기', queue.total], [REVIEW_STATUS_LABELS.stale, counts.stale], [REVIEW_STATUS_LABELS.unapproved, counts.unapproved], [REVIEW_STATUS_LABELS.approved, counts.approved]]
    .map(([label, count]) => `<span class="review-inbox-stat"><b>${count}</b> ${escapeHtml(label)}</span>`).join('')}</div>`
    + reviewGapNotes(queue, shown.length, visible.length, full);
  list.innerHTML = shown.length
    ? shown.map(reviewRowHtml).join('')
      + (visible.length > shown.length ? `<button type="button" class="review-inbox-more" data-review-expand="1">${visible.length - shown.length}개 더 보기</button>` : '')
    : `<p class="empty-state">${filter === 'all' ? '검토를 기다리는 문서가 없습니다. 문서 전건이 지금 리비전으로 승인되어 있습니다.' : '이 상태인 문서가 없습니다.'}</p>`;
}

// ── 「내 차례」로 좁힌 검토 줄 ───────────────────────────
//
// 갈래를 가르는 규칙도 갈래의 목록도 서버가 갖는다(board.js의 documentTurns). 여기서
// 다시 가르면 자격 판정("이 사람이 승인자인가")의 표면이 하나 더 생기고, 화면의 판정은
// 아무도 시험하지 않는다. 이 함수가 하는 일은 내 줄을 고르고 갈래마다 묶어 그리는 것뿐이다.

// 언제부터 내 차례였나. 갈래마다 그 시각이 다르다 — 반려된 문서에서 차례가 작성자에게
// 넘어온 시각은 원장이 적은 반려 시각이고, 그 밖에는 지금 판이 검토자 앞에 놓인 시각이다
// (서버의 waitingSince). 한 값으로 뭉개면 어제 반려된 문서가 파일을 마지막으로 고친
// 시각으로 재어져 실제 기다린 시간과 다른 수를 말한다.
function turnWaitedAt(row, lane) {
  return lane.key === 'fix' && row.submission.rejectedAt ? row.submission.rejectedAt : row.waitingSince;
}

// 이 줄이 왜 이 갈래에 있는가. 상태 이름만으로는 답이 안 된다 — 「낡음」은 세 갈래 중
// 둘에 다 나타나고, 그 둘은 눌러야 할 단추가 다르다. 그래서 사실(누가·무엇을)로 적는다.
function turnReasonHtml(row, lane) {
  if (lane.key === 'awaiting') {
    return `${escapeHtml(personName(row.submission.submittedBy))}이(가) 올림 — 내 답을 기다립니다`;
  }
  if (lane.key === 'restake') {
    return `내 승인 뒤 개정 — 누적 승인 ${escapeHtml(row.approvals)}회`;
  }
  if (row.submission.rejectedBy) {
    // 반려 사유는 줄에 십는다. 왜 아닌지를 모르면 문서를 열기 전까지 무엇을 고쳐야
    // 할지 알 수 없고, 그러면 이 줄은 "무언가 잘못됐다"까지만 말하는 셈이다.
    return `${escapeHtml(personName(row.submission.rejectedBy))} 반려${row.submission.rejectedReason ? ` — ${escapeHtml(row.submission.rejectedReason)}` : ''}`;
  }
  return `${escapeHtml(personName(row.approvedBy))}의 승인이 낡음 — 고쳐서 다시 올릴 차례`;
}

// 소유자도 나라는 사실은 갈래가 가져가지 않은 쪽의 사실이다. 한 문서는 한 갈래에만
// 서므로(서버의 우선순위) 「내 승인이 쓰인 것」이 가져간 줄에서 "이건 내 문서이기도
// 하다"가 사라지는데, 그 사실이 있고 없고에 따라 다음 동작이 달라진다 — 남의 문서라면
// 재승인 여부만 정하면 되고 내 문서라면 고치는 것도 내 일이다.
function turnAlsoHtml(row, lane) {
  if (lane.key !== 'restake' || row.owner !== state.currentMember) return '';
  return '<span class="chip">소유자도 나</span>';
}

function turnRowHtml(row, lane) {
  const at = turnWaitedAt(row, lane);
  const waited = waitingLabel(at);
  const wait = waited
    ? `<span class="review-wait" title="${escapeHtml(at)}부터">${escapeHtml(waited)}</span>`
    : '<span class="review-wait unknown">대기 시간 모름</span>';
  // 길은 인박스의 줄과 같은 길이다(data-document · data-review-origin). 새 경로를 파면
  // 도착한 화면이 "줄을 훑는 중"이라는 사실을 잃고, 한 건 처리할 때마다 손으로 이 화면을
  // 다시 찾아 어디까지 봤는지 되짚어야 한다.
  // 칸 수는 인박스의 줄과 같아야 한다. 격자가 일곱 칸로 잡혀 있어 하나를 더하면 그대로
  // 밀려 제목이 폭 0으로 눈리는데, 글자는 DOM에 그대로 있어 어느 시험도 그것을 못 본다.
  // 그래서 칩 둘은 한 칸 안에 넣는다 — 둘 다 "이게 무슨 문서인가"를 말하므로 같은 칸이 맞다.
  return `<button class="document-row review-inbox-row" data-document="${escapeHtml(row.id)}" data-review-origin="1">`
    + `<span class="tag ${REVIEW_STATUS_TONES[row.status] || 'info'}">${escapeHtml(REVIEW_STATUS_LABELS[row.status] || row.status)}</span>`
    + `<span class="eyebrow">${escapeHtml(row.id)}</span>`
    + `<strong>${escapeHtml(row.title)}</strong>`
    + `<span class="turn-chips"><span class="chip">${escapeHtml(documentTypeLabel(row))}</span>${turnAlsoHtml(row, lane)}</span>`
    + wait
    + `<small>${turnReasonHtml(row, lane)}</small>`
    + `<span class="row-chevron" aria-hidden="true">${CHEVRON_ICON}</span></button>`;
}

// 자격이 없는 사람에게 0건을 보이지 않는다. 0건은 "지금은 볼 것이 없다"이고 자격 없음은
// "이 프로젝트에서는 앞으로도 여기에 아무것도 서지 않는다"라, 앞엎것으로 그리면 사람은
// 오지 않을 줄을 계속 기다린다. 어느 갈래가 자격을 요구하는지는 서버가 말한다.
function turnLaneHtml(lane, items, approver) {
  const blocked = lane.requiresApprover && !approver;
  const body = blocked
    ? '<p class="empty-state">이 갈래는 승인 자격이 있어야 섭니다. 0건이 아니라 셀 수 없는 갈래입니다 — 자격이 없는 동안에는 문서가 나에게 넘어오지 않습니다.</p>'
    : items.length ? items.map((row) => turnRowHtml(row, lane)).join('') : `<p class="empty-state">${escapeHtml(lane.empty)}</p>`;
  return `<section class="queue-bucket turn-lane"><div class="section-heading"><h3>${escapeHtml(lane.label)} <span class="badge">${blocked ? '—' : items.length}</span></h3><small>${escapeHtml(lane.hint)}</small></div><div class="document-list">${body}</div></section>`;
}

// 이 화면의 수가 프로젝트 전체 줄의 어디쌄인가. 좁힌 화면만 보면 "3건"이 적은 것인지
// 많은 것인지 알 수 없고, 좁혔다는 사실 자체가 화면에서 사라진다.
//
// 두 수를 한 문장으로 누르지 않는다. 반려된 문서는 인박스의 줄에서 빠져 있으므로 내
// 차례 건수가 그 줄의 부분집합이 아니고, "159건 중 3건"으로 적으면 그 순간 거짓이 된다.
function turnScopeNotes(turns, rows, approver) {
  const queue = state.snapshot.reviewQueue;
  const note = (text) => `<p class="review-inbox-note">${text}</p>`;
  const scale = note(`지금 내 차례인 문서는 <b>${rows.length}건</b>입니다. 이 프로젝트의 검토 대기 줄은 <b>${queue.total}건</b>이고, 그 전체는 <button type="button" class="inline-link" data-review-scope="all">프로젝트 전체</button>에서 봅니다.${queue.rejected ? ` 반려되어 그 줄에서 빠진 <b>${queue.rejected}건</b>은 저쪽에 서지 않고 소유자 차례로 여기에 섭니다.` : ''}`);
  if (approver) return scale;
  // 승인자가 누구인지까지 말한다. "당신은 아닙니다"만 남기면 그 사람은 누구에게 말해야
  // 하는지 모른 채 화면을 떠나고, 그 물음의 답은 이미 스냅숏에 있다.
  const names = turns.approverMembers.map(personName).join(', ');
  return scale + note(`<b>나는 이 프로젝트의 문서 승인자가 아닙니다.</b> 승인할 수 있는 사람은 ${escapeHtml(names || '아직 없습니다')}입니다. 자격은 활성 human Client와 그 소유 멤버로 정해지며, 설정 화면의 Client 목록에서 봅니다.`);
}

function renderReviewTurns() {
  const turns = state.snapshot.documentTurns;
  const summary = el('review-inbox-summary');
  const list = el('review-inbox-list');
  const filters = el('review-inbox-filter');
  // 상태 거르개는 이 범위에서 내린다. 갈래가 이미 상태를 품고 있어(「내 승인이 쓰인 것」은
  // 언제나 낡음이다) 그 위에 상태 거르개를 얹으면 묶음 셋이 통째로 비는 조합이 생기고,
  // 그때 화면은 내 차례가 없다고 말한다.
  filters.hidden = true;
  filters.innerHTML = '';
  // 이 Board 서버가 사람 축을 아직 싣지 않는 판이다. 빈 목록으로 그리면 "내 차례가 없다"로
  // 읽히는데, 그것은 서버가 답하지 못한 물음에 화면이 대신 답하는 셈이다.
  if (!turns) {
    summary.innerHTML = '<p class="empty-state">이 Board 서버는 문서의 「내 차례」를 아직 싣지 않습니다. 서버를 다시 시작하세요.</p>';
    list.hidden = true;
    list.innerHTML = '';
    return;
  }
  // 사람을 안 고른 상태를 0건으로 그리지 않는다. 태스크 화면이 같은 자리에 긋는 선과
  // 같게 하되, 좁히기 전의 줄로 돌아가는 길을 함께 둔다 — 개인화는 좁히는 것이지 막는
  // 것이 아니고, 프로젝트 전체 대기는 사람을 고르지 않아도 볼 수 있어야 한다.
  if (!state.currentMember) {
    summary.innerHTML = '<p class="identity-prompt">헤더에서 보기 기준을 고르면 내가 승인할 것과 내가 고칠 것을 갈래로 나누어 보여줍니다. 프로젝트 전체 검토 대기는 사람을 고르지 않아도 볼 수 있습니다.</p>'
      + '<div class="review-inbox-actions"><button type="button" data-review-scope="all">프로젝트 전체 보기</button></div>';
    list.hidden = true;
    list.innerHTML = '';
    return;
  }
  list.hidden = false;
  const member = state.currentMember;
  const approver = turns.approverMembers.includes(member);
  const rows = turns.rows.filter((row) => row.lanes[member]);
  // 갈래의 순서는 서버가 준 순서다. 여기서 다시 정하면 "먼저 볼 것"이 두 자리에서 갈리고,
  // 그 순서의 근거(되돌리는 비용)는 판정 쪽에 있지 화면에 있지 않다.
  const groups = turns.lanes.map((lane) => ({ lane, items: rows.filter((row) => row.lanes[member] === lane.key) }));
  summary.innerHTML = `<div class="review-inbox-counts">${groups
    .map(({ lane, items }) => `<span class="review-inbox-stat"><b>${lane.requiresApprover && !approver ? '—' : items.length}</b> ${escapeHtml(lane.label)}</span>`).join('')}</div>`
    + turnScopeNotes(turns, rows, approver);
  // 줄이 하나도 없어도 묶음 셋은 그대로 섬다. 비었다고 묶음을 지우면 "내 차례가 없다"와
  // "그런 갈래가 없다"가 화면에서 같아 보이고, 그러면 이 화면이 무엇을 세는지 배울 자리가
  // 사라진다 — 갈래마다 비었을 때 할 말이 다른 것도 그 때문이다.
  list.innerHTML = groups.map(({ lane, items }) => turnLaneHtml(lane, items, approver)).join('');
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
  const query = state.documentQuery.toLowerCase();
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
      // 목록에서도 수명을 말한다. 상세에만 두면 "이 목록에 효력 없는 것이 섞여 있나"를
      // 물으려고 158건을 한 건씩 열어야 하고, 그 물음이야말로 목록이 답할 물음이다.
      + documentLifecycleHtml(item.lifecycle)
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
  // 이력으로 가는 손잡이가 승인 옆에 선다. 승인 원장 줄은 "지금 어떤 상태인가"만 말하는데,
  // 검토하다 보면 "언제부터 이렇게 됐나"를 묻게 되고 그 답은 여기서 열리는 이력에만 있다 —
  // 손잡이를 안 두면 그 물음은 다시 명령줄로 나가고, 그 왕복이 검토를 미루는 자리였다.
  const history = approvalPanel(item.id) && approvalPanel(item.id).tab === 'history';
  // 손잡이는 원장 줄이 아니라 그 제목 줄에 선다. 원장 줄에 두면 단추 높이(34px)가 그 줄을
  // 통째로 키워, 바로 아래 오는 안내 문장이 단추 바닥에 붙는다 — 실측 간격 0px이었다.
  // 제목 줄의 오른쪽은 비어 있으므로 옮기는 것만으로 두 문제가 함께 풀린다.
  const lines = [`<div class="document-approval-head"><h2>승인 원장</h2><div class="document-approval-actions">`
    // 승인 손잡이가 먼저다. 이 줄에서 먼저 읽혀야 하는 것은 "지금 이것을 어떻게 할까"이고,
    // 이력은 그 판단이 막혔을 때 찾는 자리다 — 순서를 뒤집으면 훑는 눈이 매번 이력을 먼저
    // 지나간다.
    // 이름은 열려 있든 아니든 그대로다. 손잡이가 둘이 되면서 열린 쪽만 「접기」로 바꾸면
    // 나란히 선 두 단추가 "검토하고 승인"과 "접기"가 되어, 무엇을 접는다는 것인지가 이름에
    // 없어진다 — 자리로 기억하는 손잡이의 이름을 상태에 따라 갈면 자리도 함께 흔들린다.
    // 열려 있다는 사실은 눌린 표시와 aria-expanded가 말한다.
    + `<button type="button" class="approval-open${open && !history ? ' active' : ''}" data-approve-open="${escapeHtml(item.id)}" aria-expanded="${open && !history}">검토하고 승인</button>`
    + `<button type="button"${history ? ' class="active"' : ''} data-approve-open="${escapeHtml(item.id)}" data-approve-tab="history" aria-expanded="${history}">이력과 비교</button></div></div><p class="document-approval-line">${approvalTagHtml(approval.status)}<span>${approvalFacts(approval).join(' · ')}</span></p>`];
  if (claimsUnbacked(item)) {
    lines.push(`<p class="ledger-note">frontmatter는 <code>${escapeHtml(item.state)}</code>(${escapeHtml(documentStateLabel(item.state))})라고 적었지만 원장은 이 리비전을 승인한 적이 없습니다. 앞엣것은 작성자의 주장이고 뒤엣것이 원장의 사실이라, 어긋난 채로 둘 수 있습니다.</p>`);
  }
  if (approval.status === 'stale') {
    // 차분은 이제 이 화면이 싣는다. 다만 지어내지는 않는다 — 값은 서버가 요청 시 계산해
    // 주는 그것이고, 같은 값을 명령줄에서도 볼 수 있다는 것을 함께 적어 둔다.
    lines.push(`<p class="ledger-note">승인 이후 본문이 바뀌었습니다. 무엇이 바뀌었는지는 위 단추로 이 자리에서 보고 재승인할 수 있고, 같은 값을 <code>rdl doc diff ${escapeHtml(item.id)} --since-approval</code>로도 봅니다.</p>`);
  }
  // 반려는 검토 인박스에서 빠지므로, 여기서 말하지 않으면 그 판단이 화면 어디에도
  // 남지 않는다 — 승인 옆에 반려가 없던 때와 같은 자리다. 사유를 함께 적는다: 사유가
  // 반려의 내용 전부이고, 작성자가 무엇을 고쳐야 하는지는 그 문장에만 있다.
  const rejection = approval.submission && approval.submission.state === 'rejected' ? approval.submission.rejection : null;
  if (rejection) {
    lines.push(`<p class="ledger-note"><b>${escapeHtml(personName(rejection.rejectedBy))}이(가) 반려했습니다.</b> ${escapeHtml(rejection.reason)}`
      + ' — 신뢰 상태는 그대로이고 차례가 작성자에게 넘어갔습니다. 고쳐서 다시 올리면(<code>rdl doc submit</code>) 검토 줄로 돌아옵니다.</p>');
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
    // 연결 태스크는 클래스 없는 맨 button이라 전역 button 규칙(고정 높이·nowrap)을 그대로
    // 물려받아, 제목이 접히지 못하고 패널 밖으로 자랐다. 칸은 267px인데 카드는 438px까지
    // 갔고 #context-content가 overflow: auto라 그 넘침이 패널 전체의 가로 스크롤이 되어
    // 속성표까지 함께 끌려갔다. 목록을 제 상자에 담고 칸마다 카드 클래스를 붙여, 조판이
    // 그 둘을 되돌릴 자리를 만든다.
    el('context-content').innerHTML = `<section class="context-group"><h2>속성</h2><dl><div class="property"><dt>ID</dt><dd>${escapeHtml(item.id)}</dd></div><div class="property"><dt>유형</dt><dd>${escapeHtml(documentTypeLabel(item))}</dd></div><div class="property"><dt>문서 상태</dt><dd>${escapeHtml(documentStateLabel(item.state))}</dd></div>${item.lifecycle ? `<div class="property"><dt>수명</dt><dd title="${escapeHtml(presentationHint('documentLifecycles', item.lifecycle))}">${escapeHtml(documentLifecycleLabel(item.lifecycle))}</dd></div>` : ''}${ledgerRows}<div class="property"><dt>소유자</dt><dd>${escapeHtml(ownerName(item.owner))}</dd></div><div class="property"><dt>파일</dt><dd>${escapeHtml(item.file)}</dd></div></dl></section><section class="context-group"><h2>연결 태스크</h2>${linkedTasks.length ? `<div class="linked-task-list">${linkedTasks.map((task) => `<button class="linked-task-card" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button>`).join('')}</div>` : '<p class="empty-state">연결된 태스크 없음</p>'}</section><section class="context-group"><h2>검증</h2><p class="chip">strict snapshot 포함</p><small>${escapeHtml(item.revision.slice(0, 12))}</small></section>`;
  }
}
function renderDocument(id) { const item = state.snapshot.documents.find((documentValue) => documentValue.id === id); if (!item) return setView('documents');
  // 왔던 곳으로 돌아간다. 인박스에서 온 사람을 「문서」로 돌려보내면 훑던 줄과 걸어 둔
  // 거르개를 잃고, 그러면 인박스의 값(줄을 훑으며 처리하는 것)이 한 건마다 사라진다.
  const origin = state.reviewFrom === id ? { label: '검토 인박스', view: 'review-inbox' } : { label: '문서', view: 'documents' };
  el('document-breadcrumb').innerHTML = breadcrumb([{ label: state.project, view: 'home' }, origin, { label: item.id }]);
  closeBlockEditor(); renderEditAvailability(); el('document-title').textContent = item.title; el('document-description').textContent = item.description; // 수명 칩은 상태 칩 바로 뒤에 선다. 두 축을 붙여 세워야 「승인됨이면서 대체됨」 같은
// 조합이 한눈에 읽히고, 떨어뜨려 두면 사람은 둘 중 하나만 보고 문서의 효력을 판단한다.
// 값이 없으면 자리도 없다 — 대부분의 문서는 수명을 따로 말할 것이 없다.
el('document-badges').innerHTML = [item.id, documentTypeLabel(item), documentStateLabel(item.state)].filter(Boolean).map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join('')
  + documentLifecycleHtml(item.lifecycle)
  + `<span class="chip">${escapeHtml(ownerName(item.owner))}</span>`; el('document-approval').innerHTML = documentApprovalHtml(item); renderDocumentApprovalPanel(item.id); el('document-body').innerHTML = markdown(item.body); resolveDocumentImages(el('document-body'), item.file, state.project); el('document-body').hidden = false; el('document-editor').hidden = true; el('document-editor-surface').hidden = true; el('edit-document').hidden = false; el('cancel-document-edit').hidden = true; el('save-document').hidden = true; renderContext(item, 'document'); renderMermaid(); renderReviewNav(item.id); }

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

// ── 다음에 뭘 하지 ──────────────────────────────────────────────────────────
//
// 열린 태스크가 54건인데 화면에 보이는 것은 묶음마다 여섯 줄, 모두 열두 줄이다. 그
// 열둘을 가르던 근거는 우선순위였는데 144건 중 95건이 「높음」이라 사실상 무작위였다.
// 그래서 목록은 "무엇이 있다"까지만 말하고 "다음에 뭘 하지"에는 답하지 못했다.
//
// 없는 값을 지어내지 않는다. 여기서 쓰는 것은 전부 스냅숏이 실어 준 값이다 —
// blocker·deps(막혔는가), acceptanceCriteria(어디까지 했는가), 워크플로 스텝(승인
// 대기인가), attention(서버가 이미 붙인 담당자·검토자·완료조건 결함), statusChangedAt
// (며칠째 그대로인가). 판정이 이미 서버에 있는 셋은 여기서 다시 계산하지 않는다 —
// 화면이 자기 판정을 지으면 홈의 「조치 필요」와 이 자리가 같은 태스크에 다른 답을 낸다.
//
// 순서는 "남은 일이 적은 것부터"다. 완료조건을 다 채운 것은 할 일이 상태 한 칸뿐이고,
// 손대다 만 것은 문맥이 아직 머리에 남아 있다. 아직 안 잡은 것이 뒤인 이유는 그것만
// 문맥을 새로 만들어야 하기 때문이고, 막힌 것이 맨 뒤인 이유는 그것이 "다음에 할 것"이
// 아니라 "누가 풀어 줘야 하는 것"이기 때문이다.
// 선언 순서가 곧 등수다(다음 차례별 묶음이 이 순서로 선다). 맨 앞이 검토자 없음인 이유는
// 그것이 한 번의 조치로 풀리면서 안 풀면 영영 안 움직이는 유일한 갈래여서다 — 아무도
// 보고 있지 않다는 뜻이므로 시간이 지나도 저절로 나아지지 않는다.
const NEXT_RANKS = { unreviewed: 1, closable: 2, resuming: 3, approving: 4, started: 5, 'no-criteria': 6, unowned: 7, waiting: 8, blocked: 9 };
const NEXT_LABELS = {
  unreviewed: '검토자 없음', closable: '닫기만 남음', resuming: '이어서 하기', approving: '검토 대기',
  started: '진행 중', 'no-criteria': '완료조건 없음', unowned: '담당자 없음', waiting: '아직 안 잡음', blocked: '막힘'
};
// 행에 이름표를 다는 것은 둘뿐이다. 나머지는 행이 이미 말하고 있거나(0/6은 손을 안 댔다는
// 뜻이다) 묶음 머리글이 말한다. 다 달면 쉰 줄이 전부 이름표를 걸치고, 그러면 이름표가
// 우선순위의 빨강과 같은 운명이 된다 — 모두에게 붙은 표식은 표식이 아니다.
const NEXT_MARKS = { closable: 1, unreviewed: 1 };

function acceptanceProgress(task) {
  const values = Object.values(task.acceptanceCriteria || {});
  return { done: values.filter((item) => item.done).length, total: values.length };
}
// 서버가 이 태스크에 붙인 조치 사유. reason은 "선행 태스크 미완료: TASK-X"처럼 뒤에
// 대상을 달고 오므로 앞머리만 본다 — 홈의 조치 필요 목록이 태그를 만드는 방식과 같다.
function attentionReasons(id) {
  return ((state.snapshot && state.snapshot.attention) || [])
    .filter((item) => item.kind === 'task' && item.id === id)
    .map((item) => String(item.reason || '').split(':')[0].trim());
}
function standingDays(task) {
  const since = Date.parse(task.statusChangedAt || task.updatedAt || '');
  return Number.isNaN(since) ? 0 : Math.max(0, Math.floor((Date.now() - since) / 86400000));
}
// 끝난 태스크는 다음 차례가 없다. null을 돌려주는 것으로 "이 축에 서지 않는다"를 말한다 —
// 완료 태스크도 완료조건이 다 찍혀 있으므로, 거르지 않으면 완료 묶음의 여든네 줄이
// 전부 「닫기만 남음」이 된다.
function taskNextKey(task) {
  if (isTerminalStatus(task.status)) return null;
  if (taskBlockage(task)) return 'blocked';
  const reasons = attentionReasons(task.id);
  // 승인 스텝은 완료조건보다 먼저 본다. 완료조건을 다 채운 채 승인 대기에 선 태스크는
  // "닫기만 남은 것"이 아니라 "검토를 기다리는 것"이고, 그 둘은 사람이 할 일이 다르다.
  // 순서를 반대로 두었더니 이 저장소에서 검토자 없이 멈춰 선 단 한 건이 「닫기만 남음」
  // 열일곱 건 속으로 숨어 버렸다.
  if (inStep(task.status, 'in-approval')) return reasons.indexOf('검토자 없음') >= 0 ? 'unreviewed' : 'approving';
  const { done, total } = acceptanceProgress(task);
  if (total && done === total) return 'closable';
  if (reasons.indexOf('완료조건 없음') >= 0) return 'no-criteria';
  if (done) return 'resuming';
  if (workflowView().activeSteps.indexOf(stepOf(task.status)) >= 0) return 'started';
  if (reasons.indexOf('담당자 없음') >= 0) return 'unowned';
  return 'waiting';
}
function nextReason(task) {
  const { done, total } = acceptanceProgress(task);
  const days = standingDays(task);
  const standing = days ? `${days}일째 그대로입니다` : '오늘 움직였습니다';
  const blockage = taskBlockage(task);
  const reasons = {
    closable: () => `완료조건 ${done}/${total}을 다 채웠는데 아직 ${taskStatusLabel(task.status)}입니다. 닫기만 남았습니다.`,
    unreviewed: () => `승인 스텝에 섰는데 검토자가 없습니다. 아무도 보고 있지 않으므로 사람을 걸지 않으면 움직이지 않습니다.`,
    approving: () => `승인 스텝에서 ${standing}. 검토가 끝나야 다음으로 갑니다.`,
    resuming: () => `완료조건 ${done}/${total}까지 했습니다. 이어서 하면 되는 일입니다.`,
    started: () => `${taskStatusLabel(task.status)}인데 완료조건 ${total}개 중 한 칸도 안 찍혔고 ${standing}.`,
    'no-criteria': () => `완료조건이 없어 무엇이 끝인지 판단할 수 없습니다. 조건을 먼저 적어야 합니다.`,
    unowned: () => `담당자가 없어 아무도 잡지 않았습니다. ${standing}.`,
    waiting: () => `${priorityLabel(task.priority)} 우선순위로 아직 안 잡은 일입니다. ${standing}.`,
    blocked: () => `${blockage ? blockage.label : '막힘'} — ${blockage && blockage.detail ? blockage.detail.split('\n')[0] : '풀리기 전에는 손댈 수 없습니다'}.`
  };
  const key = taskNextKey(task);
  return key ? reasons[key]() : '';
}
// 같은 갈래 안에서는 멀리 간 것, 그다음 우선순위, 그다음 오래 멈춘 순이다.
// 멀리 간 것이 먼저인 이유는 그것이 끝까지 남은 거리가 짧아서다 — 완료조건을 다 채운
// 열일곱 건 중에 승인 대기와 할 일이 섞여 있고, 승인 대기 쪽이 한 칸 덜 남았다.
// 우선순위가 안 갈리는 프로젝트(여기가 그렇다)에서는 사실상 오래 멈춘 순이 되는데
// 그것도 맞다 — 같은 이유로 서 있는 것들 사이에 남은 근거는 방치된 기간뿐이다.
function compareNext(left, right) {
  const order = groupers.priority.order();
  const steps = workflowView().steps;
  return NEXT_RANKS[taskNextKey(left)] - NEXT_RANKS[taskNextKey(right)]
    || steps.indexOf(stepOf(right.status)) - steps.indexOf(stepOf(left.status))
    || order.indexOf(left.priority) - order.indexOf(right.priority)
    || standingDays(right) - standingDays(left)
    || left.id.localeCompare(right.id);
}

// 우선순위 색은 "이건 급하다"는 표식이다. 표식이 과반에 붙으면 그것은 표식이 아니라
// 배경이다 — 이 저장소의 「높음」은 144건 중 95건(66%)이고, 그 빨강은 아무것도 가르지
// 못한 채 목록 전체를 물들였다. 없애지는 않는다. 우선순위가 실제로 갈리는 프로젝트에서
// 그 빨강은 일하고, 지워 두면 급한 것을 찾을 표식이 사라진다.
//
// 그래서 과반을 차지한 값과 그보다 낮은 값이 함께 색을 잃는다. 과반값 하나만 지우면
// 그 아래 값이 화면에서 가장 진한 색을 갖게 되어 「높음」은 회색이고 「중간」은 주황인
// 목록이 나온다 — 강조를 고치려다 강조를 뒤집는 것이다.
const PRIORITY_MUTE = { source: null, values: [] };
function priorityIsBackground(value) {
  const tasks = (state.snapshot && state.snapshot.tasks && state.snapshot.tasks.tasks) || [];
  if (PRIORITY_MUTE.source !== tasks) {
    const order = groupers.priority.order();
    const dominant = order.findIndex((key) => tasks.filter((task) => task.priority === key).length * 2 > tasks.length);
    PRIORITY_MUTE.source = tasks;
    PRIORITY_MUTE.values = dominant < 0 ? [] : order.slice(dominant);
  }
  return PRIORITY_MUTE.values.indexOf(value) >= 0;
}
function priorityCell(task) {
  return `<span class="task-prio" data-prio="${escapeHtml(task.priority)}"${priorityIsBackground(task.priority) ? ' data-background' : ''}>${escapeHtml(priorityLabel(task.priority))}</span>`;
}

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
  const key = taskNextKey(task);
  const mark = NEXT_MARKS[key] ? `<span class="task-mark" data-mark="${key}" title="${escapeHtml(nextReason(task))}">${escapeHtml(NEXT_LABELS[key])}</span>` : '';
  return `<button class="task-row" data-task="${task.id}"><span class="task-row-main"><span class="task-row-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>${round}${verdict}${mark}${badge}</span>${priorityCell(task)}<span class="task-row-meta">${escapeHtml(personName(task.owner))} · ${completed}/${total}</span></button>`;
}
// 묶음. 평평한 목록은 33행이 한 벽으로 보여 무엇이 남았는지 읽히지 않는다.
// 상태로 묶으면 완료 묶음이 생기고 기본으로 접는다. 개수는 남으므로 진행감은 잃지 않는다.
const groupers = {
  status: { order: () => statusKeys(), key: (task) => task.status, label: (key) => taskStatusLabel(key) },
  owner: { order: null, key: (task) => task.owner || '', label: (key) => personName(key) || '미지정' },
  priority: { order: () => ['high', 'mid', 'low'], key: (task) => task.priority, label: (key) => priorityLabel(key) },
  // 테스트는 차수로 읽는다. 같은 TST가 1차·2차에 각각 태스크를 가지므로, 차수로 묶어야
  // "이번 회차가 어디까지 왔나"가 한눈에 보인다. 차수 없는 일반 태스크는 한 통에 모은다.
  round: { order: null, key: (task) => (Number.isInteger(task.round) ? String(task.round) : ''), label: (key) => (key ? `${key}차` : '차수 없음') },
  // 상태별 묶음은 "어디까지 왔나"를 말하고 이 묶음은 "무엇을 하면 움직이나"를 말한다.
  // 둘은 다른 물음이다 — 진행 중 스무 건 중 열둘이 완료조건을 다 채운 채 서 있다는 것은
  // 상태로 묶으면 절대 보이지 않고, 그 열둘이야말로 지금 손을 대면 바로 닫히는 것들이다.
  next: { order: () => Object.keys(NEXT_RANKS).concat(''), key: (task) => taskNextKey(task) || '', label: (key) => NEXT_LABELS[key] || '끝남' }
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
  // 끝난 것은 기본으로 접는다. 다음 차례로 묶었을 때의 「끝남」도 같은 묶음이라
  // 같이 접는다 — 안 접으면 여든네 건짜리 통이 열린 것들 아래에 그대로 서서,
  // 다음 차례를 물으려고 바꾼 묶음이 다시 완료 목록이 된다.
  return (groupBy === 'status' && isTerminalStatus(key)) || (groupBy === 'next' && key === '');
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
// 보기 방식 셋. 「의존」은 "같은 목록을 어떻게 늘어놓을까"의 하나인데, 이 저장소에서는
// 144건 중 의존 관계가 0건이라 언제나 빈 화면이었다. 빈 상태 문구 자체는 좋다 — 문제는
// 그것을 보려고 탭을 눌러야 안다는 것이고, 최상위 셋 중 하나가 늘 그 값이면 그 자리는
// 나머지 둘의 폭을 깎는 일만 한다.
//
// 거르개와 같은 규칙에 태운다: 그릴 것이 하나도 없으면 서지 않고, 관계가 하나라도 생기면
// 그날 다시 선다. 접힘을 말하지 않는 이유도 거르개와 같다 — 값이 0인 축은 알릴 사실
// 자체가 없다. 판정은 범위가 아니라 프로젝트 전체로 한다. 의존이 있는데 지금 범위에만
// 없는 경우는 그림의 빈 상태 문구가 이미 정확히 그 말을 하고 있고, 범위를 옮길 때마다
// 최상위 탭이 나타났다 사라지면 그것대로 읽을 수 없는 화면이 된다.
const taskModes = { list: 'task-list-mode', board: 'task-board-mode', graph: 'task-graph-mode' };
function syncTaskModes() {
  const linked = state.snapshot.tasks.tasks.some((task) => (task.deps || []).length);
  el(taskModes.graph).hidden = !linked;
  // 서 있지 않은 방식에 머물러 있으면 화면은 빈 채로 남고 되돌릴 단추도 함께 사라진다.
  if (!linked && state.taskMode === 'graph') state.taskMode = 'list';
  for (const [mode, id] of Object.entries(taskModes)) el(id).classList.toggle('active', mode === state.taskMode);
}

// 「다음 하나」. 목록은 무엇이 있는지까지만 말하고 무엇을 먼저 볼지는 말하지 않았다.
// 한 건을 고르고 고른 이유를 함께 적는다 — 이유 없이 고른 하나는 다음 하나가 아니라
// 그냥 첫 줄이고, 사람은 첫 줄을 믿을 이유가 없다.
//
// 아래 줄은 열린 것들의 갈래별 수다. 하나만 내밀면 "왜 하필 이것이냐"에 답할 수 없고,
// 같은 이유로 서 있는 것이 열일곱 건이라는 사실 자체가 이 프로젝트에 대한 답이다.
// 그 갈래로 목록을 다시 묶고 싶으면 「묶는 기준」의 다음 차례별이 같은 표를 편다.
function renderTaskNext(tasks) {
  const panel = el('task-next');
  const open = tasks.filter((task) => taskNextKey(task));
  // 목록 모드에서만 선다. Board는 화면 높이에 고정되어 레인마다 따로 스크롤하므로 위에
  // 띠를 얹으면 레인이 그만큼 짧아지고, 의존 보기는 목록이 아니라 그림이라 이 띠가
  // 가리킬 줄이 없다.
  //
  // 열린 것이 한 건이면 서지 않는다. 고를 것이 하나뿐일 때 "다음 하나"는 고른 것이
  // 아니라 목록을 한 번 더 그린 것이고, 실제로 검토 대기 범위에서 같은 태스크가 띠와
  // 바로 아래 줄에 두 번 섰다. 고른 이유는 그 줄의 이름표가 이미 달고 있다.
  panel.hidden = state.taskMode !== 'list' || open.length < 2;
  if (panel.hidden) return void (panel.replaceChildren());
  const ordered = open.slice().sort(compareNext);
  const pick = ordered[0];
  const shape = new Map();
  for (const task of ordered) shape.set(taskNextKey(task), (shape.get(taskNextKey(task)) || 0) + 1);
  panel.innerHTML = `<p class="task-next-head">다음 하나<span class="badge">열린 ${open.length}건</span></p>`
    + `<button class="task-next-pick" data-task="${escapeHtml(pick.id)}"><span class="task-next-title">${escapeHtml(pick.title)}</span>`
    + `<span class="task-next-reason">${escapeHtml(nextReason(pick))}</span></button>`
    + `<p class="task-next-shape">${Array.from(shape).map(([key, count]) => `<span data-shape="${escapeHtml(key)}"><b>${count}</b> ${escapeHtml(NEXT_LABELS[key])}</span>`).join('')}</p>`;
}
// 범위 셋. review가 세는 것은 홈의 「검토 요청 태스크」가 세는 것과 같아야 한다 — 카드는
// 프로젝트 전체에서 승인 스텝에 선 태스크를 세는데 이 자리가 "내가 검토자인 것"만 걸렀고,
// 그래서 1을 눌러 도착하면 0건이었다. 게다가 이 저장소의 그 1건은 같은 홈 화면이 "검토자
// 없음"이라 적은 태스크라, 누구를 골라도 영원히 0건이었다.
//
// 카드가 아니라 목적지를 맞춘다. 승인 스텝에 서 있다는 것은 태스크의 사실이고 누가 보는가와
// 무관하며, SCR-005도 이 지표를 "태스크가 승인 스텝에 선 수"라고 적어 두었다. 카드를 내
// 것만 세게 하면 검토자 없이 멈춰 선 태스크는 어느 수에도 안 잡혀 화면에서 사라진다 —
// 그 태스크야말로 아무도 안 보고 있다는 뜻이라 가장 먼저 보여야 하는 것이다.
//
// 그래서 이 범위는 사람을 고르지 않아도 선다. 신원이 필요한 것은 "내 작업"뿐이고, 내가
// 검토자인 것만 추리는 자리는 홈의 「내 차례」가 이미 갖고 있다.
function renderTasks() { redrawTaskPeek(); const scopes = { all: ['전체 태스크', '프로젝트의 모든 작업을 목록과 Board로 확인합니다.'], mine: ['내 작업', '현재 사용자에게 할당된 작업입니다.'], review: ['검토 대기', '승인 스텝에 서 있는 작업 전체입니다. 홈의 「검토 요청 태스크」가 세는 것과 같은 줄입니다.'] }; const [heading, description] = scopes[state.taskScope]; el('tasks-heading').textContent = heading; syncTaskModes(); let tasks = state.snapshot.tasks.tasks; if (state.taskScope === 'mine' && !state.currentMember) { renderTaskFilters([]); renderTaskNext([]); el('tasks-description').textContent = description; el('task-list').hidden = false; el('board').hidden = true; el('task-graph').hidden = true; el('task-list').innerHTML = '<p class="identity-prompt">헤더에서 보기 기준을 고르면 내게 배정된 작업만 추려 보여줍니다. 검토 대기는 사람을 고르지 않아도 볼 수 있습니다.</p>'; return; } if (state.taskScope === 'mine') tasks = tasks.filter((task) => task.owner === state.currentMember); if (state.taskScope === 'review') tasks = tasks.filter((task) => inStep(task.status, 'in-approval'));
  // 사람을 골랐으면 그중 내 것이 몇 건인지 함께 적는다. 목록을 좁히지는 않는다 — 좁히면
  // 카드의 수와 다시 어긋나고, 이 화면이 답하는 물음은 "무엇이 검토를 기다리나"이지
  // "내가 볼 것이 무엇인가"가 아니다. 뒤엣것은 홈의 「내 차례」가 답한다.
  el('tasks-description').textContent = state.taskScope === 'review' && state.currentMember
    ? `${description} 그중 ${tasks.filter((task) => (task.reviewers || []).includes(state.currentMember)).length}건이 내가 검토자입니다.`
    : description;
  // 거르개는 여기서 다시 그린다. 판정 대상은 「범위」까지만 좁힌 이 목록이고, 아래의
  // 검색·거르개·완료 숨기기는 그다음에 온다 — 그 뒤의 목록으로 판정하면 거르개가 자기가
  // 한 일 때문에 사라진다.
  renderTaskFilters(tasks);
  const query = state.taskQuery.toLowerCase(); tasks = tasks.filter((task) => (!query || `${task.id} ${task.title} ${task.summary || ''}`.toLowerCase().includes(query)) && (!el('owner').value || task.owner === el('owner').value) && (!el('priority').value || task.priority === el('priority').value)
    && (!el('task-kind').value || (task.kind || 'normal') === el('task-kind').value)
    && (!el('task-round').value || String(task.round) === el('task-round').value));
  // 완료 숨기기는 접기와 다른 일을 한다. 접기는 묶음 머리글을 남기고, 숨기기는 항목을 뺀다.
  // 담당자나 우선순위로 묶으면 완료 묶음이 없으므로 그때는 이 필터가 그 역할을 한다.
  if (el('hide-done').checked) tasks = tasks.filter((task) => !isTerminalStatus(task.status));
  // 열린 것은 "다음에 볼 순서"로 세운다. 서버가 준 순서는 우선순위 → id인데 66%가
  // 「높음」이라 그 순서는 사실상 id순이었고, 묶음마다 앞의 여섯 줄만 보이는 화면에서
  // 그것은 "쉰 건 중 아무 열둘"을 뜻했다. 끝난 것은 서버 순서를 그대로 둔다 — 완료
  // 묶음은 기본으로 접혀 있고, 끝난 일에는 다음 차례가 없다.
  const served = new Map(tasks.map((task, index) => [task.id, index]));
  tasks = tasks.slice().sort((left, right) => {
    const openLeft = !isTerminalStatus(left.status);
    if (openLeft !== !isTerminalStatus(right.status)) return openLeft ? -1 : 1;
    return openLeft ? compareNext(left, right) : served.get(left.id) - served.get(right.id);
  });
  renderTaskNext(tasks);
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
    + priorityCell(task)
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
  for (const axis of Object.values(TASK_FILTERS)) el(axis.control).toggleAttribute('data-on', Boolean(el(axis.control).value));
}

// ── 거르개는 값이 갈릴 때만 선다 ─────────────────────────────────────────────
//
// 거르개 넷이 화면 폭 한 줄을 통째로 쓰는데 이 저장소에서는 넷 다 사실상 아무것도
// 거르지 못했다 — 담당자는 144건 중 137건이 한 사람, 종류는 142건이 일반, 차수는
// 시험 태스크 2건에만 있었다. 그렇다고 "쓸모없으니 지운다"가 답은 아니다. 다인
// 프로젝트에서 담당자 거르개는 이 화면에서 가장 먼저 누르는 칸이고, 업무 유형이
// 켜지면 종류 거르개도 그날부터 실제로 일하기 시작한다.
//
// 그래서 지우는 대신 조건을 건다. 고를 값이 둘 이상일 때만 선다 — 값이 하나뿐인 축은
// 눌러도 목록이 그대로이므로 컨트롤이 아니라 이름표이고, 값이 없는 축은 빈 칸이다.
//
// 판정 대상은 「범위」로만 좁힌 목록이다. 거르개 자신과 검색·완료 숨기기까지 판정에
// 넣으면 거르개가 자기가 한 일 때문에 사라진다 — 담당자를 고르는 순간 그 축은 값이
// 하나가 되어 칸이 없어지고, 그러면 목록이 왜 짧은지도 어떻게 되돌리는지도 화면에
// 남지 않는다. 범위는 제목까지 바꾸는 "무엇을 보는가"이고 나머지는 그 안에서 줄이는
// 것이라, 이 선이 거르개의 존재를 정하는 자리로 옳다.
//
// 값 목록은 스냅숏이 실어 준 태스크에서 센다. 화면이 자기 목록을 적어 두면(지금 HTML에
// 박혀 있던 높음·중간·낮음이 그랬다) 저장값이 늘어도 화면은 모른 채 돌고, 없는 값을
// 고를 수 있는 것처럼 그린다.
//
// 값의 순서도 화면이 지어내지 않는다. rank는 그 축의 정본 순서에서 온다 — 우선순위는
// 높음·중간·낮음, 종류는 업무 유형이 적어 둔 order, 담당자는 project.md의 멤버 차례다.
// 알파벳으로 세우면 「높음 · 낮음 · 중간」이 되어, 축이 순서를 가진다는 사실이 사라진다.
const TASK_FILTERS = {
  owner: { control: 'owner', option: 'owner', label: '담당자', value: (task) => task.owner || '', name: (key) => personName(key),
    rank: (key) => state.snapshot.people.members.findIndex((item) => item.id === key) },
  priority: { control: 'priority', option: 'priority', label: '우선순위', value: (task) => task.priority || '', name: (key) => priorityLabel(key),
    rank: (key) => groupers.priority.order().indexOf(key) },
  kind: { control: 'task-kind', option: 'taskKind', label: '종류', value: (task) => task.kind || 'normal', name: (key) => taskKindLabel(key),
    rank: (key) => { const known = ((state.snapshot.presentation && state.snapshot.presentation.itemTypes) || {})[key]; return known && Number.isFinite(known.order) ? known.order : -1; } },
  // 차수는 종류의 하부 축이다. 시험 태스크만 갖는 값이라, 종류를 일반으로 걸어 둔
  // 사람에게 차수 칸을 세워 봤자 무엇을 골라도 0건이다. 그래서 이 축만은 종류 거르개가
  // 걸러 낸 뒤의 목록에서 센다 — 반대 방향은 없으므로(차수를 골라도 종류는 그대로다)
  // 거르개가 자기를 지우는 고리가 생기지 않는다.
  round: { control: 'task-round', option: 'taskRound', label: '차수', value: (task) => (Number.isInteger(task.round) ? String(task.round) : ''), name: (key) => `${key}차`,
    rank: (key) => Number(key),
    within: (tasks) => (el('task-kind').value ? tasks.filter((task) => (task.kind || 'normal') === el('task-kind').value) : tasks) }
};

function axisCounts(tasks, axis) {
  const counts = new Map();
  for (const task of (axis.within ? axis.within(tasks) : tasks)) {
    const value = axis.value(task);
    // 값이 비어 있는 태스크는 세지 않는다. 담당자 없는 4건과 차수 없는 142건은 축의
    // 값이 아니라 값이 없는 것이고, 그것을 한 갈래로 세면 담당자가 한 사람뿐인
    // 프로젝트에서도 축이 둘로 보여 규칙이 아무것도 접지 못한다.
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

// 접힘을 말할지. 조용히 사라지면 "있었는데 없어졌다"로 읽힌다 — 범위를 「내 작업」으로
// 바꾸는 순간 담당자 칸이 눈앞에서 없어지는 경우가 그렇다. 그래서 말한다. 다만 값이
// 하나뿐이라 접은 축만 말한다. 값이 아예 없는 축은 알릴 사실 자체가 없어 빈 문장이
// 되고, 없던 것이 없다는 말은 화면에 자리만 차지한다.
//
// 그리고 말하는 김에 그 하나가 무엇인지까지 적는다. "담당자 거르개를 접었다"보다
// "담당자가 강영준 한 사람이다"가 더 많은 것을 말하고, 뒤엣것이 곧 접은 이유다.
function renderTaskFilters(scoped) {
  const collapsed = [];
  let standing = 0;
  for (const axis of Object.values(TASK_FILTERS)) {
    const control = el(axis.control);
    const counts = axisCounts(scoped, axis);
    // 정본 순서를 모르는 값(멤버 목록에서 빠진 담당자, 유형 표에 없는 종류)은 뒤로 보낸다.
    // 앞에 세우면 이름이 사라진 값 하나가 목록 첫 줄을 차지한다.
    const place = (key) => (axis.rank(key) < 0 ? Number.MAX_SAFE_INTEGER : axis.rank(key));
    const values = Array.from(counts.keys()).sort((left, right) => place(left) - place(right) || left.localeCompare(right));
    // 옵션을 갈아 끼우면 고른 값이 날아간다. 지금 걸린 값을 먼저 집고, 첫 그림처럼
    // 아직 아무것도 안 걸렸으면 저장해 둔 표시 옵션에서 되찾는다.
    const chosen = control.value || viewOption(axis.option, '');
    control.replaceChildren(new Option(axis.label, ''), ...values.map((value) => new Option(`${axis.name(value)} ${counts.get(value)}`, value)));
    control.value = counts.has(chosen) ? chosen : '';
    // 없어진 값을 저장소에 남겨 두면 다음에 그 값이 다시 생기는 날 사람이 걸지도 않은
    // 거르개가 걸린 채로 화면이 열린다.
    if (chosen && !control.value) setViewOption(axis.option, '');
    // 걸려 있는 값이 있으면 개수와 무관하게 남긴다. 걸어 둔 거르개가 사라지면 목록이
    // 짧은 이유도, 그것을 되돌리는 길도 화면에서 함께 없어진다.
    control.hidden = values.length < 2 && !control.value;
    // 접힌 사실을 말하는 것은 "그 값을 여럿이 나눠 갖고 있을 때"뿐이다. 목록에 한 건만
    // 남은 범위(검토 대기가 그렇다)에서는 축마다 값이 하나인 것이 당연하고, 그때 이
    // 문장은 그 한 줄이 이미 말한 것을 축 이름을 바꿔 가며 세 번 반복한다.
    if (control.hidden && values.length === 1 && counts.get(values[0]) > 1) collapsed.push(`${axis.label}: ${axis.name(values[0])}`);
    standing += control.hidden ? 0 : 1;
  }
  const note = el('filter-note');
  note.hidden = collapsed.length === 0;
  note.textContent = collapsed.length ? `값이 하나뿐이라 접었습니다 — ${collapsed.join(' · ')}` : '';
  // 구분선은 범위와 거르개를 가르는 선이다. 거르개가 하나도 안 서고 할 말도 없으면
  // 가를 것이 없어, 남겨 두면 아무것도 나누지 않는 선 하나가 툴바에 떠 있게 된다.
  el('filter-divider').hidden = standing === 0 && note.hidden;
  markFilters();
}

function populateControls() { const members = state.snapshot.people.members;
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
async function initialize() { applyTheme(localStorage.getItem('rundol.theme') || 'system'); matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (document.body.classList.contains('theme-system') && state.view === 'document' && state.selected) renderDocument(state.selected); }); const projects = await api('/api/projects'); el('project-switcher').replaceChildren(...projects.map((item) => new Option(item.name || item.key, item.key))); const hash = new URLSearchParams(location.hash.slice(1)); state.project = hash.get('project') || projects[0].key; state.view = hash.get('view') || 'home'; const scope = hash.get('scope') || 'all'; state.taskScope = state.view === 'review-inbox' ? 'all' : scope; state.reviewScope = scope === 'mine' ? 'mine' : 'all'; state.selected = hash.get('entity'); adoptSearchAddress(hash); el('project-switcher').value = state.project; state.lastVisit = localStorage.getItem(visitKey()); await loadSnapshot(true); startPolling(); }

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

document.addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; if (button.dataset.view) { if (button.dataset.view === 'tasks') state.taskScope = 'all'; return setView(button.dataset.view); } if (button.dataset.document) {
    // 문서로 가는 길은 여전히 하나다. 인박스에서 왔는지는 그 길에 얹은 표식으로만
    // 가른다 — 검토하러 온 사람에게는 승인 판이 열려 있어야 하고, 목록에서 열어 본
    // 사람에게는 본문이 온전한 폭을 가져야 한다. 경로를 둘로 파면 그 차이가 아니라
    // 화면 전체가 갈리고, 그때 두 길 중 한쪽만 고쳐지는 날이 온다.
    state.reviewFrom = button.dataset.reviewOrigin ? button.dataset.document : null;
    setView('document', button.dataset.document);
    if (state.reviewFrom) openReviewApproval(state.reviewFrom);
    return;
  } if (button.dataset.documentFilter !== undefined) { state.documentFilter = button.dataset.documentFilter; return setView('documents'); } if (button.dataset.documentScope) { state.documentSearchScope = button.dataset.documentScope; return setView('documents'); } if (button.dataset.documentSort) { state.documentSort = button.dataset.documentSort; return setView('documents'); } if (button.dataset.documentApproval) { state.documentApproval = button.dataset.documentApproval; return setView('documents'); } // Plane의 side peek. 목록에서 고른 태스크는 화면을 갈아치우지 않고 Context 패널에 연다.
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
    // 자산이 사는 자리를 아는 곳은 여기 하나다. 안 넘기면 편집기가 board-snapshot을
    // 한 번 더 불러 같은 값을 다시 알아내고, 그 순간 정본이 둘이 된다.
    assetUrl,
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
// 목록 거르개 둘. 예전에는 헤더의 한 칸이 이 일을 겸했는데, 그 칸은 지금 작업공간 전체를
// 찾는 자리가 되었다. 겸하게 두면 타자 한 번이 화면을 문서 목록으로 끌고 가면서 동시에
// 드롭다운을 여는, 서로를 방해하는 두 일을 한다.
el('documents-filter').addEventListener('input', (event) => { state.documentQuery = event.target.value.trim(); renderDocuments(); });
el('tasks-filter').addEventListener('input', (event) => { state.taskQuery = event.target.value.trim(); renderTasks(); });
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
el('current-member').addEventListener('change', (event) => { state.currentMember = event.target.value; if (state.currentMember) localStorage.setItem(`rundol.currentMember.${state.project}`, state.currentMember); else localStorage.removeItem(`rundol.currentMember.${state.project}`); if (state.view === 'tasks') renderTasks(); if (state.view === 'home') renderHome(); if (state.view === 'review-inbox') renderReviewInbox(); if (el('settings-member').value !== state.currentMember) el('settings-member').value = state.currentMember; });
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
// 거르개 넷의 옵션과 서고 접히는 판정은 renderTasks가 다시 그린다. 여기서는 고른 값을
// 저장하고 다시 그리라고만 말한다 — 종류를 바꾸면 차수의 값 목록이 달라지는 것 같은
// 축 사이의 관계도 그 한곳이 갖는다.
for (const [id, option] of [['owner', 'owner'], ['priority', 'priority'], ['group-by', 'groupBy'], ['task-kind', 'taskKind'], ['task-round', 'taskRound']]) {
  el(id).addEventListener('change', () => {
    setViewOption(option, el(id).value);
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
// 어느 방식이 켜져 있는지 표시하는 일은 syncTaskModes가 갖는다. 여기서 따로 칠하면
// 의존 탭이 접히며 목록으로 돌아가는 경우에 표시만 옛 자리에 남는다.
for (const [mode, id] of Object.entries(taskModes)) {
  el(id).addEventListener('click', () => { state.taskMode = mode; renderTasks(); });
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
// 옆으로 나온 승인 판도 Esc로 닫힌다. 덮거나 밀어내는 표면은 닫는 길이 분명해야 한다는
// 관례를 따르되, 바깥 클릭은 닫지 않는다 — 본문을 짚어 읽는 것이 이 화면에서 하는 일이다.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (state.view !== 'document' || !state.docApproval) return;
  state.docApproval = null;
  redrawApproval();
});
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
    blockEditor = window.RundolEditor.openEditor(el('document-editor-surface'), item.body, { linkCandidates: linkCandidates(), contractSections: sectionsFor(item), onChange: () => scheduleDocumentCheck(item), uploadImage, assetUrl, onMessage: message });
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
// 더 보기는 그 자리에서 끝까지 편다. 스물다섯씩 또 나누면 찾는 것을 만날 때까지 몇 번을
// 눌러야 하고, 몇 번 눌렀는지도 남지 않는다 — 태스크 묶음의 더 보기와 같은 규칙이다.
// 편 상태를 저장하지 않는 것은 다르다. 태스크의 묶음은 사람이 정한 보기 방식이라 남기지만,
// 인박스의 줄은 폴링마다 길이가 바뀌는 목록이라 다음에 열었을 때 편 채로 서 있으면
// 그 사이에 늘어난 줄까지 함께 쏟아진다.
document.addEventListener('click', (event) => {
  const more = event.target.closest('[data-review-expand]');
  if (!more) return;
  state.reviewExpanded = true;
  renderReviewInbox();
});

// 검토 인박스의 범위. 단추는 머리에도 서고 안내문 안에도 서므로 위임으로 받는다 —
// 머리의 단추에만 손잡이를 달면 다시 그려지는 자리에 선 단추(「프로젝트 전체 보기」)는
// 눌러도 아무 일도 일어나지 않는다. 누를 수 있게 생긴 단추가 아무 일도 안 하는 것은
// 보이지 않는 결함이라, 한 자리에서 받아 둘 다 살린다.
//
// 접힌 상태를 푸는 이유는 거르개를 바꿀 때와 같다. 범위가 바뀌면 다른 목록이므로,
// 전체 줄에서 펜 「더 보기」가 내 차례의 세 묶음에 그대로 걸릴 이유가 없다.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-scope]');
  if (!button) return;
  state.reviewScope = button.dataset.reviewScope;
  state.reviewExpanded = false;
  // setView를 통하는 이유는 주소다. 이 화면을 남에게 줄 수 있으려면 범위가 해시에
  // 실려야 하고, 그 일을 하는 자리는 하나다 — 여기서 따로 적으면 두 규약이 생긴다.
  setView('review-inbox');
});

// 검토 인박스의 거르개. 셈은 전건에서 오고 목록은 접힌 것에서 오므로 거르고 나면 두 수가
// 달라진다 — 그 차이를 말하는 자리도 같이 다시 그려야 하므로 화면 전체를 다시 그린다.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-filter]');
  if (!button) return;
  state.reviewFilter = button.dataset.reviewFilter;
  // 다른 갈래는 다른 목록이다. 낡음 2건을 보려고 편 것이 미승인 149건에 그대로 걸리면
  // 사람이 요청하지 않은 벽이 선다.
  state.reviewExpanded = false;
  renderReviewInbox();
});
// 승인 자리를 여닫고 비교 축을 고르는 곳. 인박스와 문서 상세가 같은 자리를 쓰므로
// 손잡이도 하나여야 한다 — 화면마다 두면 한쪽만 축을 바꿀 수 있게 되고, 그 차이는
// 승인하러 온 사람이 자기가 무엇을 보고 있는지 헷갈리는 것으로 나타난다.
document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-approve-open]');
  if (opener) return void toggleApproval(opener.dataset.approveOpen, opener.dataset.approveTab);
  const axis = event.target.closest('[data-approve-axis]');
  if (axis && state.docApproval) return void loadApprovalDiff(state.docApproval.id, axis.dataset.approveAxis);
  // 이력에서 지점을 고르는 자리. 문서 ID를 손잡이에 실어 보내는 이유는 판이 닫혔다
  // 열리는 사이에 다른 문서로 옮겨 갔을 수 있어서다 — state에서 꺼내면 그때 엉뚱한
  // 문서의 이력을 견주게 되고, 화면은 그것을 아무 신호 없이 그린다.
  const pick = event.target.closest('[data-history-pick]');
  if (pick) return void pickHistoryPoint(pick.dataset.historyDocument, pick.dataset.historyPick, pick.dataset.historyKind, pick.dataset.historyPoint);
  const clear = event.target.closest('[data-history-clear]');
  if (clear) {
    const panel = approvalPanel(clear.dataset.historyDocument);
    if (!panel) return;
    panel.pick = Object.assign({}, panel.pick, { [clear.dataset.historyClear]: null });
    panel.range = null;
    return void redrawApproval();
  }
  // 더 보기는 그 자리에서 끝까지 편다. 열둘씩 또 나누면 찾는 것을 만날 때까지 몇 번을
  // 눌러야 하고, 몇 번 눌렀는지도 남지 않는다 — 인박스와 태스크 묶음이 쓰는 규칙과 같다.
  const expand = event.target.closest('[data-history-expand]');
  if (expand) {
    const panel = approvalPanel(expand.dataset.historyExpand);
    if (!panel) return;
    panel.historyExpanded = true;
    return void redrawApproval();
  }
  // 반려는 폼의 submit이 아니라 눌러서만 나간다. submit에 얹으면 사유 칸에서 엔터를
  // 친 사람이 반려를 보내게 되고, 판단은 실수로 나가면 안 된다.
  const reject = event.target.closest('[data-approve-reject]');
  if (reject) return void rejectOpenDocument(reject.dataset.approveReject);
});
// 폼의 값은 DOM이 아니라 state가 갖는다. 차분이 도착하거나 축을 바꾸면 이 자리를 다시
// 그리는데, DOM에 두면 그때마다 적던 사유가 사라진다 — 댓글 칸을 state로 옮긴 것과 같은 이유다.
function rememberApprovalField(event) {
  const field = event.target.closest('[data-approve-field]');
  if (!field || !state.docApproval) return;
  state.docApproval.form[field.dataset.approveField] = field.value;
}
// 수명 폼도 같은 이유로 값을 state에 둔다. 다만 낡음 확인은 체크박스라 value가 아니라
// checked를 봐야 한다 — value로 읽으면 언제나 'on'이라 끄는 일이 화면에 반영되지 않는다.
function rememberLifecycleField(event) {
  const field = event.target.closest('[data-lifecycle-field]');
  if (!field || !state.docApproval) return;
  const key = field.dataset.lifecycleField;
  state.docApproval.lifecycle[key] = field.type === 'checkbox' ? field.checked : field.value;
  // 고를 값을 바꾸면 판을 다시 그린다. 경고와 확인 칸이 「지금 값과 다른가」에 걸려
  // 있으므로, 다시 그리지 않으면 되돌린 뒤에도 경고가 남아 사람을 겁준다.
  if (key === 'value') redrawApproval();
}
document.addEventListener('input', rememberApprovalField);
document.addEventListener('change', rememberApprovalField);
document.addEventListener('input', rememberLifecycleField);
document.addEventListener('change', rememberLifecycleField);
document.addEventListener('submit', (event) => {
  const lifecycle = event.target.closest('[data-lifecycle-form]');
  if (lifecycle) {
    event.preventDefault();
    return void applyDocumentLifecycle(lifecycle.dataset.lifecycleForm);
  }
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
  // 수명은 사람이 적는 축이라 이름을 팀이 고칠 자리가 있어야 한다. 이 표에 없으면
  // 그룹이 오류 없이 조용히 빠져 — 순회 대상이 이 표라 — 설정 화면에서 보이지도
  // 고쳐지지도 않는다. 저장 계층은 이미 그 그룹을 받고 있으므로 빠진 것은 표면뿐이고,
  // 빠졌다는 사실은 아무 신호도 내지 않는다.
  documentLifecycles: '문서 수명',
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
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="item-type-settings" class="settings-panel"><header><h2>업무 유형</h2><p>유형 하나가 필드와 규칙과 화면을 함께 끌고 옵니다. 규칙은 코드가 가진 다섯 가지 제약 종류에 값을 채우는 방식이라, 새 유형을 만드는 데 코드 변경이 필요하지 않습니다. 유형 정의는 표시가 아니라 정책이라 저장이 계약 변경 결정을 요구합니다. 그 결정은 이제 아래 <b>사람 결정</b>에서 답할 수 있습니다. 다만 이 화면에는 아직 유형을 고치는 자리가 없어, 지금은 <code>board.json</code>의 <code>itemTypes</code>를 고치고 <code>rdl save</code>로 남깁니다.</p></header><div class="settings-body"><div id="item-type-list"></div><div id="item-type-derived"></div></div></section>');
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
    + '<p class="approval-note" id="workflow-graph-dirty" hidden><b>고친 것은 아직 저장되지 않습니다.</b> 이 그림은 고친 값을 되돌려 보내는 길이 아직 없습니다 — 옮긴 자리는 화면을 떠나면 사라집니다. 지금은 <code>workflows.json</code>을 고치고 <code>rdl save</code>로 남깁니다.</p>';
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

// ── 사람 결정 ──────────────────────────────────────────────────────────
//
// 정책 층을 바꾸는 저장은 계약 변경 결정을 요구한다(REQ-058). 그 결정을 여는 것은
// 막힌 표면이 하고, 답하는 것은 사람만 할 수 있다. 답할 자리가 화면에 없으면 게이트는
// 탈출구 없는 문이 된다 — 막힌 사람이 하던 일을 접고 명령줄로 가야 하고, 그 왕복이
// 정책 변경을 미루는 자리다.
//
// 원장은 프로젝트가 소유하므로 이 자리도 프로젝트 범위다.
const decisionState = { loaded: null, open: true, busy: null, error: null, form: {} };

function decisionOptionLabel(option) {
  return option && (option.label || option.id) ? String(option.label || option.id) : '';
}

async function loadDecisions() {
  try {
    decisionState.loaded = await api(projectPath(`/decisions${decisionState.open ? '?open' : ''}`));
    decisionState.error = null;
  } catch (error) {
    // 못 읽은 이유를 그대로 싣는다. 빈 목록으로 그리면 "결정이 없다"와 "못 읽었다"가
    // 같은 화면이 되고, 앞엣것은 넘어가도 되지만 뒤엣것은 넘어가면 안 된다.
    decisionState.loaded = null;
    decisionState.error = error.message;
  }
  renderDecisionSettings();
}

async function answerDecision(decisionId, selectedOption) {
  const form = decisionState.form[decisionId] || {};
  decisionState.busy = decisionId;
  renderDecisionSettings();
  try {
    await api(projectPath(`/decisions/${encodeURIComponent(decisionId)}/answer`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundol-Token': token },
      body: JSON.stringify({ selectedOption, answeredBy: form.answeredBy || '', reason: form.reason || '' })
    });
    message('결정에 답했습니다. 막혀 있던 저장을 다시 하면 통과합니다.');
    decisionState.form[decisionId] = {};
    await loadDecisions();
  } catch (error) {
    message(`답하지 못했습니다: ${error.message}`, true);
  } finally {
    decisionState.busy = null;
    renderDecisionSettings();
  }
}

function renderDecisionSettings() {
  if (!el('decision-settings')) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="decision-settings" class="settings-panel"><header><h2>사람 결정</h2><p>정책 층을 바꾸는 저장은 계약 변경 결정을 함께 남겨야 통과합니다. 여는 것은 막힌 표면이 하고 <b>답하는 것은 사람만</b> 할 수 있습니다 — 에이전트 자격은 여기서 계약상 거절되며, 그것은 결함이 아니라 이 관문의 전부입니다. 답한 뒤 같은 저장을 다시 하면 통과합니다. 같은 결정이 다른 저장을 열지는 못합니다.</p></header><div class="settings-body"><div id="decision-controls" class="chip-row"></div><div id="decision-list"></div></div></section>');
    el('decision-settings').addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-decision-scope]');
      if (toggle) { decisionState.open = toggle.dataset.decisionScope === 'open'; loadDecisions(); return; }
      const answer = event.target.closest('[data-decision-answer]');
      if (answer) { answerDecision(answer.dataset.decisionAnswer, answer.dataset.decisionOption); }
    });
    el('decision-settings').addEventListener('input', (event) => {
      const field = event.target.closest('[data-decision-field]');
      if (!field) return;
      const id = field.dataset.decisionId;
      decisionState.form[id] = Object.assign({}, decisionState.form[id], { [field.dataset.decisionField]: field.value });
    });
  }

  el('decision-controls').innerHTML = [['open', '답을 기다리는 것'], ['all', '전부']]
    .map(([scope, label]) => `<button type="button" class="chip${(scope === 'open') === decisionState.open ? ' active' : ''}" data-decision-scope="${scope}">${escapeHtml(label)}</button>`).join('');

  const host = el('decision-list');
  if (decisionState.error) {
    host.innerHTML = `<p class="empty-state">결정 원장을 읽지 못했습니다: ${escapeHtml(decisionState.error)}</p>`;
    return;
  }
  if (!decisionState.loaded) {
    host.innerHTML = '<p class="empty-state">읽는 중입니다.</p>';
    return;
  }
  const list = decisionState.loaded.decisions || [];
  if (!list.length) {
    host.innerHTML = decisionState.open
      ? '<p class="empty-state">답을 기다리는 결정이 없습니다. 정책 층 저장이 막히면 그 저장이 여기에 결정을 엽니다.</p>'
      : '<p class="empty-state">이 프로젝트의 결정 원장이 비어 있습니다.</p>';
    return;
  }
  host.innerHTML = list.map((decision) => {
    const answered = decision.status === 'answered';
    const form = decisionState.form[decision.decisionId] || {};
    const busy = decisionState.busy === decision.decisionId;
    // 근거는 이전 값과 새 값이다. 그것이 없으면 되돌릴 수 없고, 되돌릴 수 없는 기록은
    // 기록이 아니다 — 그래서 접지 않고 그대로 싣는다.
    const evidence = (decision.evidence || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
    const options = (decision.options || []).map((option) =>
      `<button type="button"${busy ? ' disabled' : ''} class="${option.id === 'approve' ? 'primary' : ''}" data-decision-answer="${escapeHtml(decision.decisionId)}" data-decision-option="${escapeHtml(option.id)}">${escapeHtml(decisionOptionLabel(option))}</button>`).join('');
    const answerForm = answered ? '' : `<div class="decision-form">`
      + `<label>명의<input data-decision-field="answeredBy" data-decision-id="${escapeHtml(decision.decisionId)}" value="${escapeHtml(form.answeredBy || '')}" placeholder="MEMBER-001"></label>`
      + `<label>사유<input data-decision-field="reason" data-decision-id="${escapeHtml(decision.decisionId)}" value="${escapeHtml(form.reason || '')}" placeholder="왜 이 답인지"></label>`
      + `<div class="decision-actions">${options}</div></div>`;
    return `<article class="decision-card${answered ? ' is-answered' : ''}">`
      + `<header><span class="chip">${escapeHtml(decision.kind || '')}</span>`
      + `<strong>${escapeHtml(decision.question || decision.subject || decision.decisionId)}</strong>`
      + `<small>${escapeHtml(decision.decisionId)}</small></header>`
      + (evidence ? `<ul class="decision-evidence">${evidence}</ul>` : '')
      + (answered
        ? `<p class="approval-note">답: <b>${escapeHtml(decision.selectedOption || '')}</b> · ${escapeHtml(personName(decision.answeredBy))}${decision.reason ? ` — ${escapeHtml(decision.reason)}` : ''}</p>`
        : answerForm)
      + '</article>';
  }).join('');
}

function renderWorkflowSettings() {
  if (!el('workflow-settings')) {
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="workflow-settings" class="settings-panel"><header><h2>워크플로</h2><p>노드와 전환이 <b>무엇이 허용되는지</b>를 정합니다. 상태 이름은 이 프로젝트가 정의하는 값이고, 코드가 보는 것은 그 이름이 매핑된 스텝뿐입니다. 흐름 정의는 표시가 아니라 정책이라 저장이 계약 변경 결정을 요구합니다. 그 결정은 이제 아래 <b>사람 결정</b>에서 답할 수 있습니다. 다만 이 화면의 흐름도는 아직 고친 그래프를 되돌려 보내지 못해 — 그림에서 옮긴 자리는 저장되지 않습니다. 지금은 <code>workflows.json</code>을 고치고 <code>rdl save</code>로 남깁니다.</p></header><div class="settings-body"><div id="workflow-current" class="presentation-source"></div><div id="workflow-diagram"></div><div id="workflow-nodes"></div><div id="workflow-transitions"></div><div id="workflow-layers"></div><div id="workflow-scope"></div></div></section>');
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
    el('settings-panels').insertAdjacentHTML('beforeend', '<section id="approval-settings" class="settings-panel"><header><h2>승인과 파이프</h2><p>모드는 AI를 얼마나 믿느냐의 눈금이 아니라 <b>사람의 주의를 어디에 쓸지의 배분표</b>입니다. 되돌릴 수 있는 구간을 흘려보내야 남은 게이트가 실제로 읽힙니다. 승인 모드도 정책이라 저장이 계약 변경 결정을 요구합니다. 그 결정은 아래 <b>사람 결정</b>에서 답할 수 있습니다. 지금은 <code>board.json</code>의 <code>approval</code>을 고치고 <code>rdl save</code>로 남깁니다.</p></header><div class="settings-body"><div id="approval-current" class="presentation-source"></div><div id="approval-modes" class="approval-modes"></div><div id="approval-pipes"></div></div></section>');
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
  renderPresentationSettings(); renderApprovalSettings(); renderDecisionSettings(); loadDecisions(); renderItemTypeSettings(); renderWorkflowSettings(); renderContractSettings(); renderContractCompliance();
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

// ── 통합 검색 ─────────────────────────────────────────────────────────────
//
// 화면은 둘이고 엔진은 하나다. 머리 입력 밑의 드롭다운은 타자 도중에 답하는 자리이고,
// 전용 화면(#view=search)은 결과 전부를 출처별로 펴 놓고 어느 칸이 맞았는지까지 싣는
// 자리다. 둘은 같은 엔드포인트에 같은 질의를 보내고 limit만 다르다 — 화면마다 거르기를
// 다시 적으면 같은 낱말이 두 자리에서 다른 답을 낸다.
//
// 판정은 여기 없다. 무엇을 대상에 넣는지, 어떤 순서로 세우는지, 자를 때 갈래마다 몇
// 자리를 남기는지는 전부 search.js가 갖는다. 이 파일이 하는 일은 그 답을 그리는 것과
// 언제 묻는지를 정하는 것뿐이다.

// 언제 묻는가. 한 글자마다 보내면 문서 본문 전체를 훑는 질의가 타자 속도로 돈다.
// 이 저장소에서 실제로 재 보면 질의 한 번이 90~130ms이고(문서 158건·태스크 62건·원장
// 2천여 줄을 인덱스 없이 정본에서 바로 읽는다), 보드의 HTTP 서버는 한 줄이라 요청이
// 줄을 선다 — 다섯 글자를 이어 친 다섯 요청이 443ms 동안 서버를 물고 있었고 그 사이에
// 도착한 스냅숏 폴링은 1.0초를 기다렸다. 그동안 보드 전체가 멈춘 채다.
//
// 200ms인 이유는 한 낱말을 치는 동안의 글자 간격보다는 길고(한글 IME에서 한 글자는 대개
// 120~200ms) 손이 멈춘 뒤의 기다림으로는 느껴지지 않는 폭이기 때문이다. 결과적으로 한
// 낱말이 요청 한 번이 된다.
//
// 최소 길이는 화면이 정하지 않는다. 한 글자짜리 질의를 엔진은 거절이 아니라 too-short
// 상태로 답하고(5ms, 파일을 한 개도 열지 않는다) 그 답에 자기 기준(minLength)을 실어
// 준다. 화면이 여기 2를 적어 두면 기준이 두 곳에 살고, 언젠가 갈린다.
const SEARCH_DEBOUNCE = 200;
// 드롭다운에 싣는 수. 자르는 축은 화면이 아니라 엔진이 갖는다 — limit을 그대로 넘기면
// 엔진이 관련도로 자르되 갈래마다 최소 자리를 남긴다(search.js의 selectResults).
// 받아 온 목록 위에서 화면이 다시 앞 N건을 끊으면 절단면이 정렬 축과 겹쳐 특정 갈래가
// 통째로 사라지는데, 검토 인박스가 실제로 그렇게 무너졌다. 이 저장소의 흔한 검색어가
// 정확히 그 갈래다: 「승인」은 문서 107·태스크 14·원장 4, 「니다」는 문서 73·태스크 2·
// 원장 13이라, 점수 상위 12건만 끊으면 태스크와 원장이 한 줄도 안 남는 질의가 실재한다.
const SEARCH_DROPDOWN_LIMIT = 12;
// 전용 화면은 엔진의 상한(MAX_LIMIT=200)까지 받는다. 그보다 많으면 서버가 truncated로
// 말해 주고 화면은 그 사실을 적는다 — 안 적으면 사람은 200건이 전부인 줄 안다.
const SEARCH_PAGE_LIMIT = 200;
// 갈래의 이름과 차례는 서버가 낸다(응답의 sources). 화면이 사본을 들면 어휘가 두 곳에
// 살고, 갈래를 하나 더하는 날 서버는 내는데 화면은 그 묶음을 안 그리는 상태가 된다.
// 결과마다 오는 origin.label은 원장에서 「승인 사유」·「댓글」처럼 더 좁은 이름이라
// 묶음 머리글로는 쓸 수 없다.
//
// 아래 표는 옛 서버가 sources를 안 실을 때만 쓰는 물러섬이다. 그때도 화면이 비지 않게.
const SEARCH_SOURCE_FALLBACK = { document: '정본 문서', task: '태스크', ledger: '원장' };
function searchSourceEntries() {
  const sent = state.searchSources;
  return Array.isArray(sent) && sent.length
    ? sent
    : Object.keys(SEARCH_SOURCE_FALLBACK).map((value) => ({ value, label: SEARCH_SOURCE_FALLBACK[value] }));
}
function searchSourceValues() { return searchSourceEntries().map((entry) => entry.value); }
function searchSourceLabel(value) {
  const found = searchSourceEntries().find((entry) => entry.value === value);
  return found ? found.label : value;
}
// 답이 올 때마다 갈래 표를 갈아 둔다. 두 화면(드롭다운·전용)이 같은 표를 쓰게 하는 자리다.
function rememberSearchSources(answer) {
  if (answer && Array.isArray(answer.sources) && answer.sources.length) state.searchSources = answer.sources;
}
const SEARCH_ATTACHMENT_LABELS = { document: '정본 문서', task: '태스크', comment: '댓글' };

// 같은 값을 다시 넣지 않는다. 넣으면 브라우저가 캐럿을 문자열 끝으로 옮겨, 가운데를
// 고치던 사람의 손이 렌더마다 뒤로 밀린다.
//
// 손이 올라가 있는 칸은 아예 건드리지 않는다. 이 칸의 값은 디바운스가 끝나야 상태에
// 들어가므로, 그 사이에 폴링이 스냅숏을 갈아 끼우고 화면을 다시 그리면(loadSnapshot이
// 바뀐 리비전마다 setView를 부른다) 아직 상태에 못 들어간 글자가 통째로 되돌아간다.
// 댓글을 쓰는 중에 폴링이 편집기를 갈아치우지 않는 것과 같은 자리다.
function syncFieldValue(id, value) {
  const field = el(id);
  if (!field || field.value === value) return;
  if (field === document.activeElement) return;
  field.value = value;
}

// 주소가 곧 질의다. 남이 준 링크로 들어온 사람이 같은 결과를 보려면 이 둘이 화면이
// 서기 전에 상태로 들어와 있어야 한다.
function adoptSearchAddress(hash) {
  if (state.view !== 'search') return;
  state.searchPage.query = (hash.get('q') || '').trim();
  const source = hash.get('source');
  state.searchPage.source = searchSourceValues().includes(source) ? source : null;
  syncFieldValue('global-search', state.searchPage.query);
  syncFieldValue('search-page-input', state.searchPage.query);
}

function searchPath(query, options) {
  const params = new URLSearchParams({ q: query, limit: String(options.limit) });
  if (options.source) params.set('source', options.source);
  return projectPath(`/search?${params}`);
}

function abortedSearch(error) {
  return Boolean(error) && (error.name === 'AbortError' || /aborted/iu.test(error.message || ''));
}

/**
 * 발췌의 강조를 DOM으로 만든다.
 *
 * 서버는 <mark>를 주지 않는다. 검색 대상이 문서 본문이라 강조를 HTML로 실으면 본문에
 * 적힌 것이 그대로 마크업이 되고, 그 순간 문서를 쓸 수 있는 사람이 보드를 여는 모든
 * 사람의 브라우저에 스크립트를 넣을 수 있다. 그래서 서버는 자리(ranges)만 주고 화면이
 * 그 자리에 요소를 만든다 — 문자열을 이어 붙여 innerHTML에 넣는 순간 이 방어가 통째로
 * 무너지므로 이 함수에는 문자열 연결이 한 줄도 없다.
 *
 * 범위가 글자 밖을 가리키면 그 범위만 버리고 글자는 남긴다. 강조 하나가 어긋났다고
 * 발췌를 통째로 버리면 사람은 왜 맞았는지를 볼 자리를 잃는다.
 */
function excerptNode(excerpt) {
  const node = document.createElement('span');
  node.className = 'search-excerpt';
  const text = String((excerpt && excerpt.text) || '');
  let cursor = 0;
  for (const range of (excerpt && excerpt.ranges) || []) {
    const offset = Array.isArray(range) ? Number(range[0]) : NaN;
    const length = Array.isArray(range) ? Number(range[1]) : NaN;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) continue;
    if (offset < cursor || offset >= text.length) continue;
    const end = Math.min(text.length, offset + length);
    if (offset > cursor) node.appendChild(document.createTextNode(text.slice(cursor, offset)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(offset, end);
    node.appendChild(mark);
    cursor = end;
  }
  if (cursor < text.length) node.appendChild(document.createTextNode(text.slice(cursor)));
  return node;
}

function textNode(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value === undefined || value === null ? '' : String(value);
  return node;
}

// 맞은 칸 하나. 라벨은 서버가 지은 것을 그대로 쓴다 — 「완료조건 AC-002」·「승인 근거(read)」
// 처럼 어느 자리인지까지 담고 있어서, 화면이 다시 지으면 그만큼이 사라진다.
function matchNode(match, excerptLimit) {
  const node = document.createElement('div');
  node.className = 'search-match';
  node.appendChild(textNode('span', 'search-match-label', match.label || match.field));
  for (const excerpt of (match.excerpts || []).slice(0, excerptLimit)) node.appendChild(excerptNode(excerpt));
  return node;
}

// 원장 줄은 그 자체로는 읽을 수 없다. 무엇에 붙은 것인지가 있어야 뜻이 서고, 붙을 자리를
// 못 찾은 줄은 그 사실을 적는다 — 지워진 태스크의 댓글과 아직 안 읽은 태스크의 댓글은
// 다르고, 앞엣것을 조용히 감추면 그 논의는 어느 화면에도 다시 서지 않는다.
function attachmentNode(hit) {
  const attached = hit.attachedTo;
  if (!attached || hit.source !== 'ledger' || !attached.id) return null;
  const node = document.createElement('span');
  node.className = attached.found ? 'search-hit-attached' : 'search-hit-attached missing';
  const label = SEARCH_ATTACHMENT_LABELS[attached.kind] || attached.kind;
  const title = attached.found ? (attached.title || '') : '찾지 못함';
  node.textContent = title ? `${label} ${attached.id} · ${title}` : `${label} ${attached.id}`;
  return node;
}

function searchHitMeta(hit) {
  const parts = [];
  if (hit.source === 'document') {
    if (hit.documentKind) parts.push(documentTypeLabel({ kind: hit.documentKind }));
    if (hit.state) parts.push(documentStateLabel(hit.state));
  }
  if (hit.source === 'task') {
    if (hit.status) parts.push(taskStatusLabel(hit.status));
    if (hit.priority) parts.push(priorityLabel(hit.priority));
  }
  if (hit.source === 'ledger') {
    if (hit.by) parts.push(personName(hit.by));
    if (hit.recordedAt) parts.push(shortDate(hit.recordedAt));
  }
  return parts.filter(Boolean).join(' · ');
}

/**
 * 결과 한 줄. 드롭다운과 전용 화면이 같은 함수를 쓴다 — 두 벌을 두면 한쪽만 고쳐지는
 * 날이 오고, 그날 같은 결과가 자리에 따라 다른 것을 말한다. 다른 것은 몇 칸까지 펴
 * 보이느냐뿐이다.
 */
function searchHitNode(hit, index, options) {
  const node = document.createElement(options.option ? 'div' : 'button');
  node.className = 'search-hit';
  if (options.option) {
    node.setAttribute('role', 'option');
    node.id = `search-hit-${index}`;
    node.setAttribute('aria-selected', 'false');
  } else {
    node.type = 'button';
  }
  node.dataset.searchIndex = String(index);
  const head = document.createElement('span');
  head.className = 'search-hit-head';
  // 출처는 줄마다 보인다. 「데이터소스랑 문서가 같이 표현되면 좋겠다」가 가리키는 것이
  // 이 칩이고, 원장 줄에서는 갈래보다 좁은 이름(승인 사유·댓글 정정)이 나온다.
  head.appendChild(textNode('span', `chip search-hit-origin source-${hit.source}`, (hit.origin && hit.origin.label) || searchSourceLabel(hit.source)));
  if (hit.source !== 'ledger') head.appendChild(textNode('span', 'search-hit-id', hit.id));
  head.appendChild(textNode('span', 'search-hit-title', hit.title || hit.id));
  node.appendChild(head);
  const attached = attachmentNode(hit);
  const meta = searchHitMeta(hit);
  if (attached || meta) {
    const line = document.createElement('span');
    line.className = 'search-hit-where';
    if (attached) line.appendChild(attached);
    if (meta) line.appendChild(textNode('span', 'search-hit-meta', meta));
    node.appendChild(line);
  }
  const matches = hit.matches || [];
  for (const match of matches.slice(0, options.matchLimit)) node.appendChild(matchNode(match, options.excerptLimit));
  // 남은 칸을 알리는 줄은 펴 보는 자리에만 세운다. 드롭다운에서 한 줄이 늘면 보이는
  // 결과가 하나씩 줄고, 이 자리에서 하는 일은 읽는 것이 아니라 고르는 것이다.
  if (!options.option && matches.length > options.matchLimit) node.appendChild(textNode('span', 'search-hit-more', `맞은 칸 ${matches.length - options.matchLimit}개 더`));
  return node;
}

// 결과를 눌렀을 때 열 자리. 원장 줄에는 자기 화면이 없으므로 붙은 대상으로 간다.
function searchHitTarget(hit) {
  if (hit.source === 'document') return { view: 'document', id: hit.id };
  if (hit.source === 'task') return { view: 'task', id: hit.id };
  const attached = hit.attachedTo;
  if (!attached || !attached.found || !attached.id) return null;
  if (attached.kind === 'document') return { view: 'document', id: attached.id };
  if (attached.kind === 'task') return { view: 'task', id: attached.id };
  return null;
}

function openSearchHit(hit) {
  if (!hit) return;
  const target = searchHitTarget(hit);
  // 열 자리가 없는 줄은 반응 없이 두지 않고 이유를 말한다. 눌러도 아무 일이 없는 줄은
  // 고장으로 읽히는데, 여기서는 고장이 아니라 대상이 사라진 원장 줄이라는 사실이다.
  if (!target) return message(`${hit.title || '이 줄'}은 붙은 대상을 찾지 못해 열 자리가 없습니다. 원장에는 남아 있고 대상이 지워졌거나 아직 읽히지 않은 줄입니다.`, true);
  const known = target.view === 'document'
    ? ((state.snapshot && state.snapshot.documents) || []).some((item) => item.id === target.id)
    : ((state.snapshot && state.snapshot.tasks && state.snapshot.tasks.tasks) || []).some((item) => item.id === target.id);
  // 검색은 정본을 바로 읽고 화면은 스냅숏을 든다. 둘이 어긋난 순간에 그냥 보내면 목록
  // 화면으로 튕겨 나가고, 사람은 자기가 무엇을 눌렀는지 모른 채 다른 화면에 서 있다.
  if (!known) return message(`${target.id}을 지금 보드가 든 스냅숏에서 찾지 못했습니다. 검색은 정본을 바로 읽으므로 아직 읽어 오지 않은 것일 수 있습니다 — 새로 읽은 뒤 다시 눌러 보세요.`, true);
  closeSearchDropdown();
  setView(target.view, target.id);
}

// 못 읽은 원장은 결과 0건과 다르다. 서버가 그 둘을 값으로 갈라 주므로 화면은 옮기기만
// 하면 된다 — 삼키면 깨진 저장소와 아직 아무 일도 없던 저장소가 화면에서 같아 보인다.
function ledgerNoteNode(answer) {
  const ledger = (answer && answer.scanned && answer.scanned.ledger) || null;
  if (!ledger || ledger.read || !ledger.reason) return null;
  return textNode('p', 'search-note warning', `원장을 읽지 못했습니다: ${ledger.reason}`);
}

function searchErrorNode(error) {
  // 서버가 거절한 이유는 그대로 옮긴다. 다듬으면 무엇을 고쳐야 하는지가 사라지고,
  // 지어내면 화면이 서버가 답한 적 없는 것을 말한다.
  const node = textNode('p', 'search-note error', error.message);
  if (error.code) node.appendChild(textNode('span', 'search-note-code', error.code));
  return node;
}

// ── 머리 입력 밑 드롭다운 ─────────────────────────────────────────────────

/**
 * 화면에 서는 순서.
 *
 * 서버는 관련도로 정렬해 보내고 화면은 갈래로 묶어 그린다. 두 순서를 그대로 두면 ↓가
 * 눈에 보이는 다음 줄이 아니라 점수의 다음 줄로 뛴다 — 실제로 문서 첫 줄에서 ↓ 한 번에
 * 화면 아래쪽 태스크 묶음으로 건너뛰고, 다시 ↑를 누르면 위쪽 문서로 돌아왔다. 갈래 안의
 * 순서는 서버가 준 그대로 두고 묶음의 차례만 맞춘다.
 */
function orderBySource(results) {
  const ordered = [];
  for (const source of searchSourceValues()) for (const hit of results) if (hit.source === source) ordered.push(hit);
  // 모르는 갈래는 버리지 않고 뒤에 붙인다. 엔진이 갈래를 하나 늘리는 날 화면에서 조용히
  // 사라지면, 그 갈래는 아무 신호도 없이 없는 것이 된다.
  for (const hit of results) if (!searchSourceValues().includes(hit.source)) ordered.push(hit);
  return ordered;
}

function searchDropdownRows() {
  const answer = state.search.answer;
  return orderBySource((answer && answer.results) || []);
}

function scheduleDropdownSearch(raw) {
  const search = state.search;
  clearTimeout(search.timer);
  const query = String(raw || '').trim();
  // 비운 것은 물음이 아니다. 지우는 동작이 가장 비싼 동작이 되면 안 되므로 요청도 보내지
  // 않고 자리도 접는다.
  if (!query) {
    search.query = '';
    search.answer = null;
    search.error = null;
    search.loading = false;
    if (search.controller) { search.controller.abort(); search.controller = null; }
    return closeSearchDropdown();
  }
  search.timer = setTimeout(() => runDropdownSearch(query), SEARCH_DEBOUNCE);
}

function runDropdownSearch(query) {
  const search = state.search;
  search.query = query;
  search.loading = true;
  search.open = true;
  // 이미 나간 요청은 취소한다. 취소해도 답이 이미 길 위에 있을 수 있으므로 순번도 함께
  // 든다 — 둘 중 하나만으로는 늦게 온 답이 먼저 온 답을 덮는 갈래가 남는다.
  if (search.controller) search.controller.abort();
  search.controller = typeof AbortController === 'function' ? new AbortController() : null;
  const seq = (search.seq += 1);
  renderSearchDropdown();
  api(searchPath(query, { limit: SEARCH_DROPDOWN_LIMIT }), search.controller ? { signal: search.controller.signal } : undefined)
    .then((answer) => applyDropdownAnswer(seq, query, answer, null))
    .catch((error) => { if (!abortedSearch(error)) applyDropdownAnswer(seq, query, null, error); });
}

function applyDropdownAnswer(seq, query, answer, error) {
  const search = state.search;
  // 물은 순서와 답이 오는 순서는 같지 않다. 순번이 뒤진 답은 버린다 — 마지막으로 친
  // 글자의 답만이 지금 화면이 말해야 하는 것이고, 뒤진 답이 이기면 화면은 사용자가
  // 이미 지운 낱말의 결과를 보여 준다.
  if (seq <= search.applied) return;
  search.applied = seq;
  search.loading = false;
  rememberSearchSources(answer);
  search.answer = answer;
  search.error = error ? { message: error.message, code: error.code || null } : null;
  search.active = -1;
  search.open = query === search.query;
  renderSearchDropdown();
}

function closeSearchDropdown() {
  state.search.open = false;
  state.search.active = -1;
  renderSearchDropdown();
}

function dropdownStateNode(answer, error, loading, query) {
  if (error) return searchErrorNode(error);
  if (!answer) return loading ? textNode('p', 'search-note', '찾는 중…') : null;
  // 두 글자가 안 된 것은 결과가 없는 것이 아니라 아직 물을 수 없는 것이다. 기준은 서버가
  // 답에 실어 준 값을 그대로 읽는다.
  if (answer.status === 'too-short') return textNode('p', 'search-note', `${answer.minLength}자 이상 입력하면 찾습니다.`);
  if (answer.status !== 'ok' || answer.total) return null;
  // 못 찾은 것과 못 물어본 것은 다르다. 무엇을 훑고도 없었는지를 함께 적어야 앞엣것이 된다.
  const scanned = answer.scanned || {};
  const ledger = scanned.ledger || {};
  return textNode('p', 'search-note', `‘${query}’과 맞는 것이 없습니다. 문서 ${scanned.documents || 0}건·태스크 ${scanned.tasks || 0}건·원장 ${ledger.records || 0}줄을 훑었습니다.`);
}

function renderSearchDropdown() {
  const host = el('search-dropdown');
  const input = el('global-search');
  const search = state.search;
  host.replaceChildren();
  const visible = search.open && Boolean(search.query);
  host.hidden = !visible;
  input.setAttribute('aria-expanded', visible ? 'true' : 'false');
  if (!visible) return input.removeAttribute('aria-activedescendant');
  const answer = search.answer;
  const note = dropdownStateNode(answer, search.error, search.loading, search.query);
  if (note) host.appendChild(note);
  const ledgerNote = ledgerNoteNode(answer);
  if (ledgerNote) host.appendChild(ledgerNote);
  const rows = searchDropdownRows();
  if (rows.length) {
    const list = document.createElement('div');
    list.className = 'search-dropdown-list';
    list.id = 'search-dropdown-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '검색 결과');
    // 줄을 한 번만 훑으며 갈래가 바뀔 때 머리글을 세운다. 목록을 갈래별로 다시 걸러
    // 그리면 그리는 순서와 세는 순서가 갈리고, 그 틈으로 키보드가 눈에 안 보이는 줄을
    // 짚는다. 머리글이 전건을 함께 말하므로 몇 건이 실렸든 그 갈래에 원래 몇 건이
    // 있는지는 언제나 보인다.
    let openGroup = null;
    rows.forEach((hit, index) => {
      if (hit.source !== openGroup) {
        openGroup = hit.source;
        const head = document.createElement('div');
        head.className = 'search-group-head';
        head.appendChild(textNode('span', null, searchSourceLabel(hit.source)));
        const carried = rows.filter((item) => item.source === hit.source).length;
        const total = (answer.counts || {})[hit.source] || carried;
        head.appendChild(textNode('span', 'search-group-count', carried === total ? `${total}건` : `${total}건 중 ${carried}건`));
        list.appendChild(head);
      }
      const node = searchHitNode(hit, index, { option: true, matchLimit: 1, excerptLimit: 1 });
      if (index === search.active) { node.classList.add('active'); node.setAttribute('aria-selected', 'true'); }
      list.appendChild(node);
    });
    host.appendChild(list);
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'search-more';
    more.dataset.searchMore = '1';
    // 잘렸으면 잘렸다고 적는다. 이 손잡이가 전용 화면으로 가는 길이므로, 몇 건을 두고 온
    // 것인지 말하지 않으면 사람은 지금 본 것이 전부인 줄 안다.
    more.textContent = rows.length < answer.total
      ? `전체 ${answer.total}건 보기 (지금 ${rows.length}건)`
      : `검색 화면에서 ${answer.total}건 펴 보기`;
    host.appendChild(more);
  }
  if (search.active >= 0 && rows[search.active]) input.setAttribute('aria-activedescendant', `search-hit-${search.active}`);
  else input.removeAttribute('aria-activedescendant');
}

function moveSearchActive(step) {
  const rows = searchDropdownRows();
  if (!rows.length) return;
  const next = state.search.active + step;
  // 위로 벗어나면 입력으로 돌아온다(-1). 아래로는 마지막에서 멈춘다 — 되감으면 목록의
  // 끝이 어디인지 손으로 알 수 없다.
  state.search.active = next < -1 ? -1 : Math.min(next, rows.length - 1);
  renderSearchDropdown();
  const node = state.search.active >= 0 ? el(`search-hit-${state.search.active}`) : null;
  if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
}

function openSearchPageWith(query) {
  const value = String(query || '').trim();
  state.searchPage.query = value;
  state.searchPage.source = null;
  syncFieldValue('search-page-input', value);
  closeSearchDropdown();
  setView('search');
  const field = el('search-page-input');
  if (field && field.focus) field.focus();
}

el('global-search').addEventListener('input', (event) => scheduleDropdownSearch(event.target.value));
el('global-search').addEventListener('focus', () => {
  if (!state.search.query || state.search.open) return;
  state.search.open = true;
  renderSearchDropdown();
});
el('global-search').addEventListener('keydown', (event) => {
  const search = state.search;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    // ↓는 입력에서 결과로 들어가는 길이다. 기본 동작(캐럿을 끝으로)이 남으면 목록을
    // 훑는 동안 글자가 조용히 잘리거나 커서가 튄다.
    event.preventDefault();
    if (!search.open && search.query) { search.open = true; search.active = -1; }
    return moveSearchActive(event.key === 'ArrowDown' ? 1 : -1);
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const rows = searchDropdownRows();
    // 짚은 줄이 있으면 그 줄을 열고, 없으면 전용 화면으로 간다. 치고 나서 Enter가
    // 「전부 보기」의 가장 짧은 길이다.
    if (search.active >= 0 && rows[search.active]) return openSearchHit(rows[search.active]);
    if (search.query) return openSearchPageWith(search.query);
    return;
  }
  if (event.key === 'Escape') {
    if (!search.open) return;
    // 여기서 멈춰 세운다. 안 그러면 같은 Esc가 peek까지 닫아, 드롭다운을 접으려던 손이
    // 옆에 열어 둔 것을 함께 잃는다.
    event.stopPropagation();
    event.preventDefault();
    return closeSearchDropdown();
  }
  if (event.key === 'Tab') closeSearchDropdown();
});
el('search-dropdown').addEventListener('click', (event) => {
  if (event.target.closest('[data-search-more]')) return openSearchPageWith(state.search.query);
  const row = event.target.closest('[data-search-index]');
  if (row) openSearchHit(searchDropdownRows()[Number(row.dataset.searchIndex)]);
});
// 마우스로 짚은 줄과 키보드로 짚은 줄이 갈리면 Enter가 어느 것을 열지 눈으로 알 수 없다.
el('search-dropdown').addEventListener('pointermove', (event) => {
  const row = event.target.closest('[data-search-index]');
  if (!row) return;
  const index = Number(row.dataset.searchIndex);
  if (index === state.search.active) return;
  state.search.active = index;
  renderSearchDropdown();
});
document.addEventListener('pointerdown', (event) => {
  if (!state.search.open) return;
  if (event.target.closest('.search-shell')) return;
  closeSearchDropdown();
});

// ── 전용 검색 화면 ────────────────────────────────────────────────────────

function searchPageNeedsLoad() {
  const page = state.searchPage;
  if (!page.query || page.loading) return false;
  if (page.error) return page.errorQuery !== page.query;
  return !page.answer || page.answerQuery !== page.query;
}

function loadSearchPage() {
  const page = state.searchPage;
  const query = page.query;
  const seq = (page.seq += 1);
  page.loading = true;
  page.error = null;
  if (page.controller) page.controller.abort();
  page.controller = typeof AbortController === 'function' ? new AbortController() : null;
  // 셈은 언제나 거르개 없는 질의에서 온다. 출처를 걸어 물으면 그 갈래만 세어 돌아오므로
  // (엔진의 counts는 실제로 실은 결과에서 세어진다) 나머지 칸이 전부 0으로 보인다 —
  // 거르개가 자기 옆의 수를 거짓으로 적는 셈이다.
  api(searchPath(query, { limit: SEARCH_PAGE_LIMIT }), page.controller ? { signal: page.controller.signal } : undefined)
    .then((answer) => applySearchPageAnswer(seq, query, answer, null))
    .catch((error) => { if (!abortedSearch(error)) applySearchPageAnswer(seq, query, null, error); });
}

function applySearchPageAnswer(seq, query, answer, error) {
  const page = state.searchPage;
  if (seq <= page.applied) return;
  page.applied = seq;
  page.loading = false;
  rememberSearchSources(answer);
  page.answer = answer;
  page.answerQuery = query;
  page.scoped = null;
  page.scopedSource = null;
  page.error = error ? { message: error.message, code: error.code || null } : null;
  page.errorQuery = error ? query : null;
  if (state.view === 'search') renderSearchPage();
  if (!error) ensureScopedSearch();
}

/**
 * 잘린 갈래만 다시 묻는다.
 *
 * 거르개 없는 질의가 그 갈래를 이미 전부 실었다면 다시 물을 것이 없다 — 들고 있는 목록에서
 * 그 갈래만 남기면 같은 답이다. 잘렸을 때만 다르다: 엔진은 갈래마다 최소 자리를 남기고
 * 자르므로, 원장 17건 중 5건만 실린 채로 「원장만」을 누르면 셈이 17이라고 말한 목록에서
 * 5건만 보인다. 그 자리에서만 출처를 걸어 다시 묻는다.
 */
function ensureScopedSearch() {
  const page = state.searchPage;
  const answer = page.answer;
  const source = page.source;
  if (!source || !answer || answer.status !== 'ok' || page.answerQuery !== page.query) return;
  const carried = (answer.results || []).filter((hit) => hit.source === source).length;
  if (carried >= ((answer.counts || {})[source] || 0)) return;
  if (page.scopedSource === source && page.scoped && page.scopedQuery === page.query) return;
  const seq = (page.scopedSeq += 1);
  const query = page.query;
  api(searchPath(query, { limit: SEARCH_PAGE_LIMIT, source }))
    .then((scoped) => {
      if (seq <= page.scopedApplied) return;
      page.scopedApplied = seq;
      page.scoped = scoped;
      page.scopedSource = source;
      page.scopedQuery = query;
      if (state.view === 'search') renderSearchPage();
    })
    .catch((error) => {
      if (abortedSearch(error) || seq <= page.scopedApplied) return;
      page.scopedApplied = seq;
      page.scoped = null;
      page.error = { message: error.message, code: error.code || null };
      page.errorQuery = query;
      if (state.view === 'search') renderSearchPage();
    });
}

function searchPageRows() {
  const page = state.searchPage;
  const answer = page.answer;
  if (!answer) return [];
  if (!page.source) return orderBySource(answer.results || []);
  // 잘린 갈래는 다시 물은 답을 쓰고, 안 잘린 갈래는 이미 들고 있는 목록에서 고른다.
  if (page.scoped && page.scopedSource === page.source && page.scopedQuery === page.query) return orderBySource(page.scoped.results || []);
  return orderBySource(answer.results || []).filter((hit) => hit.source === page.source);
}

function renderSearchSourceFilter(answer) {
  const host = el('search-source-filter');
  const page = state.searchPage;
  host.replaceChildren();
  host.hidden = !answer || answer.status !== 'ok';
  if (host.hidden) return;
  const counts = answer.counts || {};
  const entries = [['', '전체', answer.total]].concat(searchSourceValues().map((source) => [source, searchSourceLabel(source), counts[source] || 0]));
  for (const [value, label, count] of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.searchSource = value;
    button.textContent = `${label} ${count}`;
    if ((page.source || '') === value) button.className = 'active';
    host.appendChild(button);
  }
}

function renderSearchPage() {
  const page = state.searchPage;
  syncFieldValue('search-page-input', page.query);
  const summary = el('search-summary');
  const notes = el('search-notes');
  const results = el('search-results');
  summary.replaceChildren();
  notes.replaceChildren();
  results.replaceChildren();
  if (searchPageNeedsLoad()) loadSearchPage();
  if (!page.query) {
    el('search-source-filter').hidden = true;
    summary.appendChild(textNode('p', 'empty-state', '찾을 낱말을 입력하세요. 정본 문서의 제목·설명·본문, 태스크의 제목·요약·완료조건·사유, 그리고 원장에 남은 승인·제출·반려 사유와 댓글이 대상입니다.'));
    return;
  }
  if (page.error && page.errorQuery === page.query) {
    el('search-source-filter').hidden = true;
    summary.appendChild(searchErrorNode(page.error));
    return;
  }
  const answer = page.answer && page.answerQuery === page.query ? page.answer : null;
  if (!answer) {
    el('search-source-filter').hidden = true;
    summary.appendChild(textNode('p', 'search-note', '찾는 중…'));
    return;
  }
  if (answer.status === 'too-short') {
    el('search-source-filter').hidden = true;
    summary.appendChild(textNode('p', 'search-note', `${answer.minLength}자 이상 입력하면 찾습니다.`));
    return;
  }
  renderSearchSourceFilter(answer);
  const rows = searchPageRows();
  const scanned = answer.scanned || {};
  const ledger = scanned.ledger || {};
  const head = document.createElement('p');
  head.className = 'search-summary-line';
  head.appendChild(textNode('strong', null, `‘${answer.query}’ ${answer.total}건`));
  head.appendChild(textNode('span', null, searchSourceValues().map((source) => `${searchSourceLabel(source)} ${(answer.counts || {})[source] || 0}`).join(' · ')));
  summary.appendChild(head);
  summary.appendChild(textNode('p', 'search-scanned', `문서 ${scanned.documents || 0}건·태스크 ${scanned.tasks || 0}건·원장 ${ledger.records || 0}줄을 정본에서 바로 읽었습니다.`));
  if (answer.truncated) {
    // 자른 것은 화면이 아니라 엔진이다. 몇 건에서 잘렸는지를 적지 않으면 사람은 이것이
    // 전부인 줄 알고, 못 본 것이 있다는 사실조차 모른다.
    notes.appendChild(textNode('p', 'search-note warning', `엔진이 ${answer.limit}건에서 잘랐습니다. 갈래마다 최소 자리를 남기고 자르므로 어느 출처도 통째로 사라지지는 않지만 ${answer.total - (answer.results || []).length}건은 이 목록에 없습니다 — 출처로 좁히거나 낱말을 좁히면 남은 것을 볼 수 있습니다.`));
  }
  const ledgerNote = ledgerNoteNode(answer);
  if (ledgerNote) notes.appendChild(ledgerNote);
  if (!answer.total) {
    results.appendChild(textNode('p', 'empty-state', `‘${answer.query}’과 맞는 것이 없습니다. 해시·시각·태그·경로는 검색 대상이 아닙니다 — 사람이 쓴 글과 사람이 부르는 이름만 찾습니다.`));
    return;
  }
  for (const source of page.source ? [page.source] : searchSourceValues()) {
    const group = rows.filter((hit) => hit.source === source);
    const total = (answer.counts || {})[source] || 0;
    if (!group.length && !total) continue;
    const section = document.createElement('section');
    section.className = 'search-section';
    const heading = document.createElement('h2');
    heading.appendChild(textNode('span', null, searchSourceLabel(source)));
    heading.appendChild(textNode('span', 'search-group-count', group.length === total ? `${total}건` : `${total}건 중 ${group.length}건`));
    section.appendChild(heading);
    if (!group.length) {
      section.appendChild(textNode('p', 'empty-state', `이 출처의 ${total}건은 잘려서 이 목록에 없습니다. 위의 출처 거르개로 이 갈래만 물으면 볼 수 있습니다.`));
      results.appendChild(section);
      continue;
    }
    const list = document.createElement('div');
    list.className = 'search-list';
    for (const hit of group) list.appendChild(searchHitNode(hit, rows.indexOf(hit), { option: false, matchLimit: 4, excerptLimit: 3 }));
    section.appendChild(list);
    results.appendChild(section);
  }
}

el('search-page-input').addEventListener('input', (event) => {
  const value = event.target.value;
  clearTimeout(state.searchPage.timer);
  // 전용 화면도 같은 규칙으로 기다린다. 여기서 부르는 질의는 200건까지 실어 오므로
  // 오히려 더 비싸다.
  state.searchPage.timer = setTimeout(() => {
    state.searchPage.query = String(value || '').trim();
    state.searchPage.source = null;
    syncFieldValue('global-search', state.searchPage.query);
    setView('search');
  }, SEARCH_DEBOUNCE);
});
el('search-source-filter').addEventListener('click', (event) => {
  const button = event.target.closest('[data-search-source]');
  if (!button) return;
  state.searchPage.source = button.dataset.searchSource || null;
  setView('search');
  ensureScopedSearch();
});
el('search-results').addEventListener('click', (event) => {
  const row = event.target.closest('[data-search-index]');
  if (row) openSearchHit(searchPageRows()[Number(row.dataset.searchIndex)]);
});
