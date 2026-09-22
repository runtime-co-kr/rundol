'use strict';

// 배포판 뷰어. 굳어 있는 값 하나를 읽고 그린다 — 네트워크도, 저장도, 쓰기도 없다.
//
// 본문은 만들 때 이미 HTML로 렌더링되어 왔다. 여기서 마크다운을 다시 파싱하지
// 않는 이유는 그 일이 굳히는 시점에 한 번이면 끝나기 때문이고, 그래서 이 파일은
// 라이브러리를 하나도 물지 않는다(다이어그램이 있으면 mermaid만 함께 온다).

(function () {
  var data = JSON.parse(document.getElementById('payload').textContent);
  var state = { tab: 'flow', selected: null, query: '', search: { open: false, active: -1, rows: [] } };
  var HIT_LIMIT = 8;

  function el(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var APPROVAL_LABEL = { approved: '승인됨', stale: '낡음', unapproved: '미승인', rejected: '반려됨' };
  var TASK_LABEL = { todo: '할 일', doing: '진행 중', waiting: '대기', review: '검토', done: '완료', cancelled: '취소' };
  var PRIORITY_LABEL = { high: '높음', mid: '보통', low: '낮음' };

  function memberName(id) {
    for (var i = 0; i < data.members.length; i += 1) if (data.members[i].id === id) return data.members[i].name;
    return id || '—';
  }

  function matches(text) {
    if (!state.query) return true;
    return String(text || '').toLowerCase().indexOf(state.query.toLowerCase()) !== -1;
  }

  function documentRows() {
    return data.documents.filter(function (item) { return matches(item.id + ' ' + item.title + ' ' + item.description); });
  }
  function taskRows() {
    return data.tasks.filter(function (item) { return matches(item.id + ' ' + item.title + ' ' + item.summary); });
  }

  function renderList() {
    var list = el('list');
    if (state.tab === 'flow') { list.innerHTML = ''; return; }
    var rows = state.tab === 'documents' ? documentRows() : taskRows();
    if (!rows.length) { list.innerHTML = '<p class="empty" style="padding:8px">찾는 것이 없습니다.</p>'; return; }
    list.innerHTML = rows.map(function (item) {
      var dot = '';
      var meta = '';
      if (state.tab === 'documents') {
        var status = item.approval ? item.approval.status : null;
        dot = '<i class="dot ' + escapeHtml(status || '') + '"></i>';
        meta = status ? (APPROVAL_LABEL[status] || status) : '상태 모름';
      } else {
        dot = '<i class="dot ' + escapeHtml(item.status || '') + '"></i>';
        meta = (TASK_LABEL[item.status] || item.status || '—') + ' · ' + memberName(item.owner)
          + (item.acceptance ? ' · 완료조건 ' + item.acceptance.done + '/' + item.acceptance.total : '');
      }
      return '<button class="row' + (state.selected === item.id ? ' active' : '') + '" data-id="' + escapeHtml(item.id) + '">'
        + '<span class="rid">' + escapeHtml(item.id) + '</span>'
        + '<span class="rtitle">' + escapeHtml(item.title) + '</span>'
        + '<small class="status">' + dot + escapeHtml(meta) + '</small></button>';
    }).join('');
  }

  function flowHtml() {
    var flow = data.flow;
    var rate = flow.totals.total ? Math.round((flow.totals.approved / flow.totals.total) * 100) : 0;
    var chain = flow.layers.map(function (group) {
      return '<div class="flow-layer">' + group.map(function (type) {
        var counts = flow.counts[type] || { total: 0, approved: 0 };
        var percent = counts.total ? Math.round((counts.approved / counts.total) * 100) : 0;
        var stalePercent = counts.total ? Math.round(((counts.stale || 0) / counts.total) * 100) : 0;
        return '<div class="flow-type"><b>' + escapeHtml(type) + '</b><span>승인 ' + counts.approved + '/' + counts.total
          + (counts.stale ? ' · 낡음 ' + counts.stale : '') + '</span>'
          + '<i class="bar"><i class="' + (percent === 100 ? 'done' : '') + '" style="width:' + percent + '%"></i>'
          + (stalePercent ? '<i class="stale" style="width:' + stalePercent + '%;margin-top:-4px;margin-left:' + percent + '%"></i>' : '')
          + '</i></div>';
      }).join('') + '</div>';
    }).join('<span class="flow-arrow">→</span>');

    var byStatus = {};
    for (var i = 0; i < data.tasks.length; i += 1) {
      var status = data.tasks[i].status || '—';
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    var stats = Object.keys(byStatus).sort().map(function (status) {
      return '<div class="stat"><b>' + byStatus[status] + '</b><span>' + escapeHtml(TASK_LABEL[status] || status) + '</span></div>';
    }).join('');

    return '<h1>' + escapeHtml(data.project.name) + ' 업무 현황</h1>'
      + '<p class="lede">문서 ' + data.documents.length + '건 · 태스크 ' + data.tasks.length + '건. 이 파일은 ' + escapeHtml(data.generatedAt.slice(0, 10)) + ' 시점의 사본이며 읽기 전용입니다.</p>'
      + '<div class="rate"><i class="bar"><i style="width:' + rate + '%"></i></i><span>승인 완결률 <b>' + rate + '%</b> — ' + flow.totals.approved + '/' + flow.totals.total + '건'
      + (flow.totals.stale ? ' · <b class="chip stale" style="padding:1px 8px">낡음 ' + flow.totals.stale + '건</b>' : '') + '</span></div>'
      + (data.approvalReason ? '<p class="chip warn">승인 원장을 읽지 못했습니다: ' + escapeHtml(data.approvalReason) + '</p>' : '')
      + '<h2 style="font-size:17px">작성-의존 흐름</h2>'
      + (chain ? '<div class="flow-chain">' + chain + '</div>' : '<p class="empty">그릴 흐름이 없습니다.</p>')
      + '<h2 style="font-size:17px;margin-top:28px">태스크 상태</h2>'
      + (stats ? '<div class="grid">' + stats + '</div>' : '<p class="empty">태스크가 없습니다.</p>')
      + '<h2 style="font-size:19px;margin-top:30px">진행 중인 일</h2>' + activeTaskTable()
      + '<h2 style="font-size:19px;margin-top:30px">승인 대기 문서</h2>' + pendingTable();
  }

  // 현황 면이 태스크를 수로만 말하면 "그래서 지금 무엇이 돌고 있나"에 답하지 못한다.
  // 끝나지 않은 일을 우선순위 순으로 세우고, 진척을 막대로 함께 보인다.
  function activeTaskTable() {
    var order = { doing: 0, review: 1, waiting: 2, todo: 3 };
    var active = data.tasks.filter(function (item) { return order[item.status] !== undefined; })
      .sort(function (a, b) {
        if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
        var rank = { high: 0, mid: 1, low: 2 };
        return (rank[a.priority] === undefined ? 3 : rank[a.priority]) - (rank[b.priority] === undefined ? 3 : rank[b.priority]);
      }).slice(0, 25);
    if (!active.length) return '<p class="empty">진행 중인 태스크가 없습니다.</p>';
    return '<table class="plain"><thead><tr><th>태스크</th><th>상태</th><th>담당</th><th>완료조건</th></tr></thead><tbody>'
      + active.map(function (item) {
        var percent = item.acceptance && item.acceptance.total ? Math.round((item.acceptance.done / item.acceptance.total) * 100) : 0;
        return '<tr><td><a href="#task=' + encodeURIComponent(item.id) + '">' + escapeHtml(item.title) + '</a></td>'
          + '<td><span class="status"><i class="dot ' + escapeHtml(item.status || '') + '"></i>' + escapeHtml(TASK_LABEL[item.status] || item.status) + '</span></td>'
          + '<td>' + escapeHtml(memberName(item.owner)) + '</td>'
          + '<td>' + (item.acceptance ? item.acceptance.done + '/' + item.acceptance.total
            + '<i class="bar"><i class="' + (percent === 100 ? 'done' : '') + '" style="width:' + percent + '%"></i></i>' : '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function pendingTable() {
    var pending = data.documents.filter(function (item) { return item.approval && item.approval.status !== 'approved'; }).slice(0, 20);
    if (!pending.length) return '<p class="empty">승인을 기다리는 문서가 없습니다.</p>';
    return '<table class="plain"><thead><tr><th>문서</th><th>제목</th><th>상태</th><th>소유자</th></tr></thead><tbody>'
      + pending.map(function (item) {
        return '<tr><td><a href="#doc=' + encodeURIComponent(item.id) + '">' + escapeHtml(item.id) + '</a></td>'
          + '<td>' + escapeHtml(item.title) + '</td>'
          + '<td><span class="status"><i class="dot ' + escapeHtml(item.approval.status) + '"></i>' + escapeHtml(APPROVAL_LABEL[item.approval.status] || item.approval.status) + '</span></td>'
          + '<td>' + escapeHtml(memberName(item.owner)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function documentHtml(id) {
    var item = null;
    for (var i = 0; i < data.documents.length; i += 1) if (data.documents[i].id === id) item = data.documents[i];
    if (!item) return '<p class="empty">문서를 찾지 못했습니다: ' + escapeHtml(id) + '</p>';
    var approval = item.approval
      ? '<span class="chip ' + (item.approval.status === 'approved' ? 'ok' : '') + '">' + escapeHtml(APPROVAL_LABEL[item.approval.status] || item.approval.status)
        + (item.approval.approvedBy ? ' · ' + escapeHtml(memberName(item.approval.approvedBy)) : '') + '</span>'
      : '<span class="chip">승인 상태 모름</span>';
    return '<h1>' + escapeHtml(item.title) + '</h1>'
      + '<p class="lede">' + escapeHtml(item.description) + '</p>'
      + '<div class="chips"><span class="chip">' + escapeHtml(item.id) + '</span>' + approval
      + '<span class="chip">소유자 ' + escapeHtml(memberName(item.owner)) + '</span>'
      + '<span class="chip">' + escapeHtml(item.file) + '</span></div>'
      + '<article class="doc">' + item.html + '</article>';
  }

  function documentTitle(id) {
    for (var i = 0; i < data.documents.length; i += 1) if (data.documents[i].id === id) return data.documents[i].title;
    return null;
  }

  function taskHtml(id) {
    var item = null;
    for (var i = 0; i < data.tasks.length; i += 1) if (data.tasks[i].id === id) item = data.tasks[i];
    if (!item) return '<p class="empty">태스크를 찾지 못했습니다: ' + escapeHtml(id) + '</p>';

    var chips = '<div class="chips">'
      + '<span class="chip">' + escapeHtml(item.id) + '</span>'
      + '<span class="chip status"><i class="dot ' + escapeHtml(item.status || '') + '"></i>' + escapeHtml(TASK_LABEL[item.status] || item.status || '—') + '</span>'
      + '<span class="chip">담당 ' + escapeHtml(memberName(item.owner)) + '</span>'
      + (item.priority ? '<span class="chip">우선순위 ' + escapeHtml(PRIORITY_LABEL[item.priority] || item.priority) + '</span>' : '')
      + (item.kind && item.kind !== 'normal' ? '<span class="chip">' + escapeHtml(item.kind) + (item.round ? ' · ' + item.round + '회차' : '') + '</span>' : '')
      + (item.result ? '<span class="chip ' + (item.result === 'pass' ? 'ok' : 'warn') + '">판정 ' + escapeHtml(item.result) + '</span>' : '')
      + '</div>';

    // 완료조건은 수가 아니라 문장이다. 무엇이 남았는지가 보여야 받는 사람이 그
    // 태스크의 진척을 자기 말로 설명할 수 있다.
    var acceptance = '';
    if (item.acceptance && item.acceptance.items && item.acceptance.items.length) {
      acceptance = '<div class="section"><h2>완료조건 ' + item.acceptance.done + '/' + item.acceptance.total + '</h2>'
        + '<i class="bar" style="height:6px"><i class="' + (item.acceptance.done === item.acceptance.total ? 'done' : '') + '" style="width:'
        + Math.round((item.acceptance.done / Math.max(item.acceptance.total, 1)) * 100) + '%"></i></i>'
        + '<ul class="ac">' + item.acceptance.items.map(function (row) {
          return '<li class="' + (row.done ? 'done' : '') + '"><span class="mark">' + (row.done ? '✓' : '') + '</span>'
            + '<span><span class="acid">' + escapeHtml(row.id) + '</span>' + escapeHtml(row.text) + '</span></li>';
        }).join('') + '</ul></div>';
    }

    // 왜 멈춰 있나. 대기 사유와 의존이 없으면 "대기"라는 상태는 아무것도 말하지 않는다.
    var blocked = '';
    if (item.blocker) {
      blocked = '<div class="section"><h2>대기</h2><p class="notice">'
        + (item.blocker.waitingFor ? escapeHtml(memberName(item.blocker.waitingFor)) + '을(를) 기다립니다. ' : '')
        + escapeHtml(item.blocker.condition || '')
        + (item.blocker.since ? ' (' + escapeHtml(String(item.blocker.since).slice(0, 10)) + '부터)' : '')
        + '</p></div>';
    }

    var relations = '';
    var linkRows = (item.links || []).map(function (link) {
      var title = documentTitle(link);
      return '<li><a href="#doc=' + encodeURIComponent(link) + '">' + escapeHtml(link) + '</a>'
        + (title ? ' — ' + escapeHtml(title) : ' <span class="empty">(이 배포판에 없는 문서)</span>') + '</li>';
    }).join('');
    var depRows = (item.deps || []).map(function (dep) { return '<li>' + escapeHtml(dep) + '</li>'; }).join('');
    if (linkRows || depRows) {
      relations = '<div class="section"><h2>연결</h2>'
        + (linkRows ? '<h3 style="font-size:15px;margin:0 0 6px">문서</h3><ul>' + linkRows + '</ul>' : '')
        + (depRows ? '<h3 style="font-size:15px;margin:14px 0 6px">선행 태스크</h3><ul>' + depRows + '</ul>' : '')
        + '</div>';
    }

    var meta = '<div class="section"><h2>속성</h2><dl class="kv">'
      + '<dt>상태</dt><dd>' + escapeHtml(TASK_LABEL[item.status] || item.status || '—') + '</dd>'
      + '<dt>담당</dt><dd>' + escapeHtml(memberName(item.owner)) + '</dd>'
      + (item.reviewers && item.reviewers.length ? '<dt>검토자</dt><dd>' + item.reviewers.map(memberName).map(escapeHtml).join(', ') + '</dd>' : '')
      + (item.updatedAt ? '<dt>마지막 변경</dt><dd>' + escapeHtml(String(item.updatedAt).slice(0, 10)) + '</dd>' : '')
      + '</dl></div>';

    return '<h1>' + escapeHtml(item.title) + '</h1>'
      + chips
      + (item.summary ? '<p>' + escapeHtml(item.summary) + '</p>' : '')
      + acceptance + blocked + relations + meta;
  }

  function renderMain() {
    var main = el('main');
    if (state.tab === 'flow' || !state.selected) main.innerHTML = state.tab === 'tasks' && !state.selected
      ? '<h1>태스크</h1><p class="lede">왼쪽에서 태스크를 고르세요.</p>'
      : (state.tab === 'documents' && !state.selected ? '<h1>문서</h1><p class="lede">왼쪽에서 문서를 고르세요.</p>' : flowHtml());
    else main.innerHTML = state.tab === 'documents' ? documentHtml(state.selected) : taskHtml(state.selected);
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    if (window.mermaid && main.querySelector('pre.mermaid')) {
      try { window.mermaid.run({ nodes: main.querySelectorAll('pre.mermaid') }); } catch (error) { /* 다이어그램 하나가 나머지를 멈추지 않는다 */ }
    }
  }

  // 물음에 맞는 조각을 짚어 준다. 제목 어디가 맞았는지 보이지 않으면 사람은 왜 이 줄이
  // 떴는지 스스로 찾아야 하고, 그 찾기가 검색의 값을 깎는다.
  function highlight(text, query) {
    var value = String(text || '');
    if (!query) return escapeHtml(value);
    var at = value.toLowerCase().indexOf(query.toLowerCase());
    if (at === -1) return escapeHtml(value);
    return escapeHtml(value.slice(0, at)) + '<mark>' + escapeHtml(value.slice(at, at + query.length)) + '</mark>' + escapeHtml(value.slice(at + query.length));
  }

  function searchHits() {
    if (!state.query) return { rows: [], counts: { documents: 0, tasks: 0 } };
    var docs = documentRows();
    var tasks = taskRows();
    var rows = docs.slice(0, HIT_LIMIT).map(function (item) { return { source: 'documents', item: item }; })
      .concat(tasks.slice(0, HIT_LIMIT).map(function (item) { return { source: 'tasks', item: item }; }));
    return { rows: rows, counts: { documents: docs.length, tasks: tasks.length } };
  }

  function renderDropdown() {
    var host = el('search-dropdown');
    var input = el('q');
    var visible = state.search.open && Boolean(state.query);
    host.hidden = !visible;
    input.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (!visible) { host.innerHTML = ''; state.search.rows = []; return; }
    var answer = searchHits();
    state.search.rows = answer.rows;
    if (!answer.rows.length) { host.innerHTML = '<p class="search-note">「' + escapeHtml(state.query) + '」에 맞는 것이 없습니다.</p>'; return; }
    var html = '';
    var openGroup = null;
    answer.rows.forEach(function (hit, index) {
      if (hit.source !== openGroup) {
        openGroup = hit.source;
        var carried = answer.rows.filter(function (row) { return row.source === hit.source; }).length;
        var total = answer.counts[hit.source];
        html += '<div class="search-group-head"><b>' + (hit.source === 'documents' ? '문서' : '태스크') + '</b>'
          + '<span>' + (carried === total ? total + '건' : total + '건 중 ' + carried + '건') + '</span></div>';
      }
      var meta = hit.source === 'documents'
        ? (hit.item.approval ? (APPROVAL_LABEL[hit.item.approval.status] || hit.item.approval.status) : '상태 모름')
        : ((TASK_LABEL[hit.item.status] || hit.item.status || '—') + ' · ' + memberName(hit.item.owner));
      html += '<button type="button" class="search-hit' + (index === state.search.active ? ' active' : '') + '" role="option"'
        + ' aria-selected="' + (index === state.search.active) + '" data-hit="' + index + '">'
        + '<span class="hid">' + highlight(hit.item.id, state.query) + '</span>'
        + '<span class="htitle">' + highlight(hit.item.title, state.query) + '</span>'
        + '<span class="hmeta">' + escapeHtml(meta) + '</span></button>';
    });
    html += '<div class="search-hint"><span><kbd>↑</kbd><kbd>↓</kbd> 이동</span><span><kbd>Enter</kbd> 열기</span><span><kbd>Esc</kbd> 닫기</span></div>';
    host.innerHTML = html;
  }

  function openHit(index) {
    var hit = state.search.rows[index];
    if (!hit) return;
    state.tab = hit.source;
    state.selected = hit.item.id;
    state.search.open = false;
    for (var i = 0; i < el('tabs').children.length; i += 1) el('tabs').children[i].classList.toggle('active', el('tabs').children[i].dataset.tab === state.tab);
    render();
  }

  function moveActive(step) {
    if (!state.search.rows.length) return;
    var next = state.search.active + step;
    state.search.active = next < 0 ? state.search.rows.length - 1 : (next >= state.search.rows.length ? 0 : next);
    renderDropdown();
    var node = el('search-dropdown').querySelector('.search-hit.active');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  function render() { renderList(); renderMain(); renderDropdown(); }

  el('tabs').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-tab]');
    if (!button) return;
    state.tab = button.dataset.tab;
    state.selected = null;
    for (var i = 0; i < el('tabs').children.length; i += 1) el('tabs').children[i].classList.toggle('active', el('tabs').children[i] === button);
    render();
  });

  el('list').addEventListener('click', function (event) {
    var row = event.target.closest('.row');
    if (!row) return;
    state.selected = row.dataset.id;
    render();
  });

  el('q').addEventListener('input', function (event) {
    state.query = event.target.value.trim();
    state.search.open = Boolean(state.query);
    state.search.active = -1;
    // 목록도 함께 좁힌다. 드롭다운은 타자 도중에 답하는 자리이고 목록은 훑는
    // 자리라, 같은 물음에 두 폭으로 답하는 것이 보드와 같은 규율이다.
    renderList();
    renderDropdown();
  });

  el('q').addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); state.search.open = true; return moveActive(event.key === 'ArrowDown' ? 1 : -1); }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (state.search.active >= 0) return openHit(state.search.active);
      if (state.search.rows.length) return openHit(0);
      return;
    }
    if (event.key === 'Escape') { state.search.open = false; renderDropdown(); event.target.blur(); }
  });

  el('q').addEventListener('focus', function () { if (state.query) { state.search.open = true; renderDropdown(); } });

  el('search-dropdown').addEventListener('click', function (event) {
    var hit = event.target.closest('[data-hit]');
    if (hit) openHit(Number(hit.dataset.hit));
  });

  // 바깥을 누르면 접힌다. 드롭다운이 켜진 채로 남으면 본문을 가린다.
  document.addEventListener('pointerdown', function (event) {
    if (event.target.closest('.search-shell')) return;
    if (!state.search.open) return;
    state.search.open = false;
    renderDropdown();
  });

  // 문서 사이 링크. 본문의 [[REQ-001]]이 #doc=REQ-001로 굳어 왔으므로 주소가 곧 이동이다.
  window.addEventListener('hashchange', adoptHash);
  function adoptHash() {
    var match = /^#(doc|task)=(.+)$/.exec(location.hash);
    if (!match) return;
    state.tab = match[1] === 'doc' ? 'documents' : 'tasks';
    state.selected = decodeURIComponent(match[2]);
    for (var i = 0; i < el('tabs').children.length; i += 1) el('tabs').children[i].classList.toggle('active', el('tabs').children[i].dataset.tab === state.tab);
    render();
  }

  el('stamp').textContent = data.generatedAt.slice(0, 16).replace('T', ' ') + ' 기준 · rundol ' + data.tool.version;
  if (window.mermaid) { try { window.mermaid.initialize({ startOnLoad: false, theme: 'default' }); } catch (error) { /* 없으면 코드블록으로 남는다 */ } }
  render();
  adoptHash();
}());
