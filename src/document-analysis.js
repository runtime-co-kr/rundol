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
  const { qualifiedFunctionIds } = require('./implementation-contract');
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
  //
  // 조인 키는 부모를 단 표기다. 요구는 문서 안 표기로 적고 검증은 부모를 달아 적으므로
  // 적힌 글자 그대로 맞추면 둘은 영원히 만나지 않는다. 표기를 맞추는 규칙은 한 곳에만
  // 있어야 하므로 여기서 다시 세우지 않고 구현 계약의 것을 가져다 쓴다.
  const byFunction = new Map();
  const functionIdsOf = new Map();
  for (const document of documents) {
    const parsed = parseFrontmatter(fs.readFileSync(path.join(project.root, document.file), 'utf8'));
    // 유형은 식별자에서 읽는다. frontmatter의 type은 'document'이지 문서 유형 코드가
    // 아니고, 그것을 그대로 넘기면 원천 문서가 원천으로 읽히지 않아 조인이 통째로 빈다.
    const declared = qualifiedFunctionIds(String(document.id).slice(0, 3), document.id, parsed && parsed.data);
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

// ── 파이프라인 점검 ─────────────────────────────────────────────────────────
//
// 문서 생성 파이프라인의 흐름대로 한 번에 훑는 자리. 개발 도중 "지금 어디까지 굳었고
// 무엇이 어긋났나"를 묻는 왕복이 지금은 명령 넷(doc status · doc analyze ·
// contract trace · check)으로 흩어져 있고, 흩어진 점검은 국면마다 사람이 순서를
// 기억해야 해서 결국 안 돈다.
//
// rdl doc analyze의 플래그가 아니라 형제 명령인 이유. analyze의 --orphans와
// --unexplained는 같은 행 집합을 거르는 필터이고, 이것은 행이 아니라 층을 답한다 —
// 한 명령이 두 모양의 JSON을 내면 그것을 읽는 쪽이 먼저 모양을 판별해야 하고,
// --orphans --pipeline 같은 뜻 없는 조합이 형식적으로 성립한다. 물음이 다르면
// 명령이 다르고, 계산은 같은 모듈에 둔다.
//
// 이름을 review로 두지 않는 것도 축이 달라서다. 검토 인박스는 승인 축("무엇이 내
// 검토를 기다리나")이고 이것은 계층 축("하류가 상류를 앞질렀나")이다.
//
// 추적성은 다시 계산하지 않는다. rdl contract trace가 이미 그 값을 내므로 그 계산을
// 부르고, 여기서 다시 세면 두 화면이 같은 프로젝트에 다른 숫자를 답한다.
function documentPipeline(start, options) {
  const settings = options || {};
  const { workspaceLayout, selectProject } = require('./workspace');
  const { listDocuments } = require('./board-data');
  const { foldApprovals, readApprovalEvents, trustState } = require('./approval');
  const { documentLayer, documentTypeCode, relatedTargetId, upstreamTrustIssues } = require('./check-rules');
  const { REGULAR_TYPES } = require('./vocabulary');
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const eventsRoot = path.join(layout.root, 'projects', 'workspace', 'events');
  const documents = listDocuments(project);
  const approvals = foldApprovals(readApprovalEvents(eventsRoot, project.key), {
    authority: require('./authority').authorityContext(start, project.key, { now: Date.now() })
  });
  const trust = new Map(documents.map((document) => [document.id, trustState(document, approvals.approvals.get(document.id)).status]));
  const evaluated = upstreamTrustIssues({ documents, trust });

  // 층은 유형이 정하고 유형 순서는 문서 계약이 안다. 여기서 층을 다시 세면 계약이
  // 유형 하나를 옮길 때 이 화면만 옛 순서를 그린다.
  const byLayer = new Map();
  for (const type of REGULAR_TYPES) {
    const layer = documentLayer(type);
    if (layer === null) continue;
    if (!byLayer.has(layer)) byLayer.set(layer, { layer, types: [], documents: 0, approved: 0, stale: 0, unapproved: 0 });
    byLayer.get(layer).types.push(type);
  }
  for (const document of documents) {
    const layer = documentLayer(documentTypeCode(document.id));
    if (layer === null || !byLayer.has(layer)) continue;
    const bucket = byLayer.get(layer);
    bucket.documents += 1;
    const status = trust.get(document.id);
    if (status) bucket[status] += 1;
  }
  // types를 문자열로 내는 이유는 사람 출력 때문이다. 중첩 배열은 요약 출력에서
  // 통째로 사라지고, 그러면 층에 어떤 유형이 서는지가 --json 에서만 보인다.
  const layers = Array.from(byLayer.values()).sort((left, right) => left.layer - right.layer)
    .map((bucket) => Object.assign({}, bucket, { types: bucket.types.join(',') }));

  // 끊긴 연결. 가리키는 대상이 없는 related와, 아무도 가리키지 않는 문서 둘이다 —
  // 앞엣것은 파이프라인이 끊어진 자리이고 뒤엣것은 아직 이어지지 않은 자리다.
  //
  // 고아 판정은 analyze가 이미 한다. 표시 링크만이 아니라 태스크와 기능 ID까지 보므로
  // 여기서 다시 세면 TST 전부를 고아로 부르게 된다 — analyze의 머리말이 그 실측이다.
  const analysis = analyzeDocuments(start, { project: project.key });
  const knownIds = new Set(documents.map((document) => document.id));
  const broken = [];
  for (const document of documents) {
    for (const value of document.related || []) {
      // 링크에서 식별자를 뽑는 규칙은 판정부의 것을 그대로 쓴다. 여기서 다시 적으면
      // 같은 related 값을 두 규칙이 다르게 읽는 날이 온다.
      const target = relatedTargetId(value);
      if (!target || knownIds.has(target)) continue;
      broken.push({ id: document.id, reason: 'unresolved-related', target });
    }
  }
  for (const entry of analysis.documents.filter((item) => item.orphan)) broken.push({ id: entry.id, reason: 'orphan', target: null });
  broken.sort((left, right) => left.id.localeCompare(right.id) || left.reason.localeCompare(right.reason) || String(left.target).localeCompare(String(right.target)));

  let traceability = null;
  try {
    const contract = require('./document-contract').loadDocumentContract(start, project.key);
    traceability = contract.traceability ? contract.traceability.summary : null;
  } catch (error) {
    traceability = null;
  }

  const ahead = evaluated.issues.map((issue) => ({
    code: issue.code, status: issue.status, downstream: issue.artifactId, upstream: issue.target, message: issue.message
  }));
  return {
    project: project.key,
    // 승인 축을 쓰지 않는 프로젝트에서 전 문서가 미승인인 것은 상태가 아니라 그 축을
    // 안 쓴다는 뜻이다. 값으로 말해야 화면이 "0건"과 "해당 없음"을 가를 수 있다.
    used: evaluated.used,
    total: documents.length,
    // 층 밖의 문서 수. 프로젝트 차터와 클리핑은 정규 유형이 아니라 어느 층에도 서지
    // 않는데, 그 수를 내지 않으면 total과 층의 합이 어긋난 채로 보이고 읽는 사람은
    // 어느 쪽이 틀렸는지 알 수 없다.
    outside: documents.filter((document) => documentLayer(documentTypeCode(document.id)) === null).length,
    counts: evaluated.counts,
    layers,
    // 여기서 다시 거르지 않는다. 미승인 상류를 언제 말하지 않을지는 규칙이 이미 정했고,
    // 그 판정을 한 번 더 하면 낡은 상류까지 함께 사라진다 — 그것은 축을 굴리든 놓았든
    // 누군가 승인한 것이 흔들린 사건이라 언제나 말해야 한다.
    ahead,
    broken,
    traceability,
    next: nextPipelineStep({ used: evaluated.used, issues: evaluated.issues, documents, trust, broken, traceability })
  };
}

// 지금 사람이 볼 다음 한 가지. 목록을 주고 고르라고 하면 고르는 일이 다시 사람의
// 부담이 되고, 실측에서 밀린 것은 작성이 아니라 검토였다.
//
// 순서는 되돌리는 비용이 큰 것부터다. 낡음이 먼저인 이유는 이미 그 문서를 근거로 삼은
// 하류가 있어서이고(승인된 것이 흔들렸다는 뜻이다), 미승인은 아직 아무도 근거로 삼지
// 않았다 — 보드의 attention과 reviewQueue가 그은 것과 같은 선이다.
function nextPipelineStep(input) {
  const { documentLayer, documentTypeCode } = require('./check-rules');
  const dependents = new Map();
  for (const issue of input.issues) {
    if (!dependents.has(issue.target)) dependents.set(issue.target, { target: issue.target, status: issue.status, count: 0 });
    dependents.get(issue.target).count += 1;
  }
  const pick = (status) => Array.from(dependents.values()).filter((entry) => entry.status === status)
    .sort((left, right) => right.count - left.count
      || (documentLayer(documentTypeCode(left.target)) || 0) - (documentLayer(documentTypeCode(right.target)) || 0)
      || left.target.localeCompare(right.target))[0] || null;
  const stale = pick('stale');
  if (stale) return `재승인 ${stale.target} — 하류 ${stale.count}건이 이 문서를 근거로 삼는데 승인 후 개정되었습니다. rdl doc diff ${stale.target} --since-approval로 바뀐 곳만 보세요.`;
  const unapproved = pick('unapproved');
  if (unapproved) return `승인 ${unapproved.target} — 하류 ${unapproved.count}건이 아직 확정되지 않은 이 문서 위에 서 있습니다. 여기를 승인하면 그 하류는 다시 타지 않습니다.`;
  if (!input.used) {
    // 승인 축을 안 쓰는 프로젝트에는 상류부터 한 건 승인하라고 말한다. 이 상태에서
    // "문제 없음"이라고 답하면 승인이 없는 것이 승인된 것과 같아 보인다.
    const first = input.documents.filter((document) => documentLayer(documentTypeCode(document.id)) !== null)
      .sort((left, right) => (documentLayer(documentTypeCode(left.id)) - documentLayer(documentTypeCode(right.id))) || left.id.localeCompare(right.id))[0];
    return first
      ? `승인 축을 아직 쓰지 않습니다. 가장 상류인 ${first.id}부터 승인하면 그 지점이 "여기부터는 다시 타지 않는다"가 됩니다.`
      : '아직 정규 문서가 없습니다. rdl contract next로 무엇부터 쓸지 보세요.';
  }
  // 끊긴 연결이 승인보다 먼저다. 상류가 무엇인지 모르는 채로 승인하면 그 승인이
  // 무엇을 잠근 것인지도 모른다.
  const unresolved = input.broken.find((entry) => entry.reason === 'unresolved-related');
  if (unresolved) return `연결 복구 ${unresolved.id} — related가 가리키는 ${unresolved.target}을(를) 찾지 못합니다.`;
  // 앞선 하류가 없으면 다음은 파이프라인의 선두다 — 아직 확정되지 않은 가장 얕은 층.
  // 여기를 승인하는 것이 국면별 소량 승인이고, 그것이 "여기부터는 다시 안 탄다"는
  // 커밋 포인트를 만든다.
  const pending = input.documents
    .map((document) => ({ id: document.id, layer: documentLayer(documentTypeCode(document.id)), status: input.trust.get(document.id) }))
    .filter((entry) => entry.layer !== null && entry.status === 'unapproved')
    .sort((left, right) => left.layer - right.layer || left.id.localeCompare(right.id));
  if (pending.length) {
    const front = pending.filter((entry) => entry.layer === pending[0].layer);
    return `승인 ${front[0].id}${front.length > 1 ? ` 외 ${front.length - 1}건` : ''} — 층 ${pending[0].layer}에 아직 확정되지 않은 문서가 있습니다. 이 층을 닫으면 하류는 다시 타지 않습니다.`;
  }
  if (input.traceability && input.traceability.incomplete > 0) return `검증 연결 — 기능 ${input.traceability.incomplete}건에 TST가 없습니다. rdl contract trace로 어느 기능인지 보세요.`;
  const orphan = input.broken.find((entry) => entry.reason === 'orphan');
  if (orphan) return `연결 확인 ${orphan.id} — 아무도 가리키지 않고 연결된 태스크도 없습니다.`;
  return '하류가 상류를 앞선 곳이 없습니다. 다음 국면으로 갑니다.';
}

module.exports = { referencedIds, changesSinceApproval, analyzeDocuments, documentPipeline };
