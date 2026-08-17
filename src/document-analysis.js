'use strict';

// 문서 분석. 목적은 읽을 것을 줄이는 것이지 읽기를 대신하는 것이 아니다 —
// AI 요약으로 원문 읽기를 대체하면 승인 모델의 취지가 무너진다. 그래서 여기
// 있는 것은 전부 기계가 판정할 수 있는 구조적 사실뿐이다.
//
// 판단이 필요한 품질 평가는 이 자리가 아니라 rdl verify의 렌즈가 맡는다.

const path = require('path');

// 문서 사이의 참조는 related의 위키 링크와 본문의 링크 표기에서 나온다. 표시
// 링크가 정본이므로 여기서도 표시 ID로 읽고, 조인 키가 필요한 곳에서만
// 식별자로 해석한다.
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gu;
const ARTIFACT_ID = /^[A-Z]{3}-\d{3,}$/u;

function referencedIds(document, knownIds) {
  const found = new Set();
  const scan = (text) => {
    for (const match of String(text || '').matchAll(WIKI_LINK)) {
      const target = match[1].trim();
      const direct = ARTIFACT_ID.test(target) ? target : (/^([A-Z]{3}-\d{3,})-/u.exec(target) || [])[1];
      if (direct && knownIds.has(direct) && direct !== document.id) found.add(direct);
    }
  };
  scan(document.body);
  for (const related of document.related || []) scan(related);
  return Array.from(found).sort();
}

// 안정성: 승인 이후 몇 번 바뀌었는가. 자주 바뀌는 정본은 아직 설계가 굳지 않은
// 신호이지 잘못이 아니다 — 그래서 오류가 아니라 지표로 낸다.
function changesSinceApproval(commits, approvedCommit) {
  if (!approvedCommit) return null;
  const index = commits.findIndex((commit) => commit.commit === approvedCommit);
  return index < 0 ? null : index;
}

function analyzeDocuments(start, options) {
  const settings = options || {};
  const { workspaceLayout, selectProject } = require('./workspace');
  const { listDocuments } = require('./board-data');
  const { foldApprovals, readApprovalEvents, trustState } = require('./approval');
  const { queryTasks } = require('./query-index');
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const eventsRoot = path.join(layout.root, 'projects', 'workspace', 'events');
  const documents = listDocuments(project);
  const knownIds = new Set(documents.map((document) => document.id));
  const approvals = foldApprovals(readApprovalEvents(eventsRoot, project.key));
  const tasks = queryTasks(start, { project: project.key }).tasks;

  // 역참조는 계산한다. 저장된 목록을 두면 문서를 고칠 때마다 어긋난다.
  const inbound = new Map(documents.map((document) => [document.id, []]));
  const outbound = new Map();
  for (const document of documents) {
    const targets = referencedIds(document, knownIds);
    outbound.set(document.id, targets);
    for (const target of targets) inbound.get(target).push(document.id);
  }

  const entries = documents.map((document) => {
    const history = approvals.approvals.get(document.id) || [];
    const state = trustState(document, history);
    const linkedTasks = tasks.filter((task) => (task.links || []).includes(document.id)).map((task) => task.id);
    return {
      id: document.id,
      type: document.type,
      title: document.title,
      file: document.file,
      trust: state.status,
      approvals: history.length,
      referencedBy: inbound.get(document.id).slice().sort(),
      references: outbound.get(document.id),
      tasks: linkedTasks,
      // 고아: 아무도 참조하지 않고 연결된 태스크도 없다. 지워야 한다는 뜻이
      // 아니라 살아 있는지 확인해야 한다는 신호다.
      orphan: inbound.get(document.id).length === 0 && linkedTasks.length === 0,
      // 승인도 태스크도 없이 존재하는 정본. 왜 이런 내용인지 답할 기록이 없다.
      unexplained: state.status !== 'approved' && linkedTasks.length === 0
    };
  });

  return {
    project: project.key,
    total: entries.length,
    summary: {
      unapproved: entries.filter((entry) => entry.trust === 'unapproved').length,
      stale: entries.filter((entry) => entry.trust === 'stale').length,
      approved: entries.filter((entry) => entry.trust === 'approved').length,
      orphans: entries.filter((entry) => entry.orphan).length,
      unexplained: entries.filter((entry) => entry.unexplained).length
    },
    documents: settings.orphans ? entries.filter((entry) => entry.orphan)
      : settings.unexplained ? entries.filter((entry) => entry.unexplained)
        : entries
  };
}

module.exports = { referencedIds, changesSinceApproval, analyzeDocuments };
