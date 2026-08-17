'use strict';

// 문서 분석. 목적은 읽을 것을 줄이는 것이지 읽기를 대신하는 것이 아니다 —
// AI 요약으로 원문 읽기를 대체하면 승인 모델의 취지가 무너진다. 그래서 여기
// 있는 것은 전부 기계가 판정할 수 있는 구조적 사실뿐이다.
//
// 여기서 내는 것은 "기록이 있는가 없는가"이지 "지금 이 내용이 왜 이렇게
// 됐는가"가 아니다. 후자는 리비전별로 태스크·승인·커밋을 조인해야 답할 수
// 있고 그 조인은 아직 없다. 있는 것보다 크게 말하면 없는 보증을 파는 셈이다.
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
  const { parseFrontmatter } = require('./frontmatter');
  const fs = require('fs');
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const eventsRoot = path.join(layout.root, 'projects', 'workspace', 'events');
  const documents = listDocuments(project);
  const knownIds = new Set(documents.map((document) => document.id));
  const approvals = foldApprovals(readApprovalEvents(eventsRoot, project.key), {
    authority: require('./authority').authorityContext(start, project.key, { now: Date.now() })
  });
  const tasks = queryTasks(start, { project: project.key }).tasks;

  // 역참조는 계산한다. 저장된 목록을 두면 문서를 고칠 때마다 어긋난다.
  const inbound = new Map(documents.map((document) => [document.id, []]));
  const outbound = new Map();
  for (const document of documents) {
    const targets = referencedIds(document, knownIds);
    outbound.set(document.id, targets);
    for (const target of targets) inbound.get(target).push(document.id);
  }

  // 추적성도 연결이다. 요구가 기능 ID를 선언하고 검증이 같은 ID를 덮으면 둘은
  // 이어져 있다 — 화살표가 검증에서 요구로만 향할 뿐이다. 표시 링크만 보면
  // 모든 TST가 잎 노드라 고아로 잡히고, 그러면 이 신호는 문서 종류 하나를
  // 통째로 잘못 지목하며 죽는다.
  const byFunction = new Map();
  const functionIdsOf = new Map();
  for (const document of documents) {
    const parsed = parseFrontmatter(fs.readFileSync(path.join(project.root, document.file), 'utf8'));
    const declared = (parsed && Array.isArray(parsed.data.functionIds)) ? parsed.data.functionIds : [];
    functionIdsOf.set(document.id, declared);
    for (const functionId of declared) {
      if (!byFunction.has(functionId)) byFunction.set(functionId, []);
      byFunction.get(functionId).push(document.id);
    }
  }
  const traceability = new Map(documents.map((document) => {
    const peers = new Set();
    for (const functionId of functionIdsOf.get(document.id)) {
      for (const peer of byFunction.get(functionId) || []) if (peer !== document.id) peers.add(peer);
    }
    return [document.id, Array.from(peers).sort()];
  }));

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
      traceability: traceability.get(document.id),
      tasks: linkedTasks,
      // 고아: 아무도 참조하지 않고, 연결된 태스크도 없고, 기능 ID로 이어진
      // 문서도 없다. 지워야 한다는 뜻이 아니라 살아 있는지 확인해야 한다는 신호다.
      //
      // 프로젝트 문서는 뿌리라 묻지 않는다. 아무도 가리키지 않는 것이 정상이고,
      // 실제로는 모든 문서의 소유자 필드가 이것을 가리키지만 그 링크 형태를
      // 표시 링크 스캐너가 읽지 않는다. 뿌리를 고아로 부르면 신호가 아니라 잡음이다.
      orphan: document.type !== 'project'
        && inbound.get(document.id).length === 0
        && linkedTasks.length === 0
        && traceability.get(document.id).length === 0,
      // 승인도 연결된 태스크도 없는 정본. 이 문서에 대해 남은 기록이 아무것도
      // 없다는 뜻이고, 그 이상은 아니다.
      //
      // 이것은 "지금 이 내용이 왜 이렇게 됐는가"에 답하지 못한다. 연결된
      // 태스크는 과거 어느 시점의 것이라도 세므로, 태스크가 하나 붙어 있으면
      // 그 뒤 리비전이 몇 번 바뀌었든 설명된 것으로 나온다. 리비전별로
      // 태스크·승인·커밋을 조인해야 그 질문에 답할 수 있고, 그 조인은 아직 없다.
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
