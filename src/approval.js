'use strict';

// 사람 승인과 신뢰 상태. AI가 쓴 초안과 사람이 책임지는 정본의 경계를 만든다.
//
// 승인은 "읽었다"의 증거가 아니라 "내가 책임진다"의 선언이다. 그래서 위조
// 가능성은 요구를 없앨 이유가 아니라 드러나게 만들 이유다 — 승인을 그 시점의
// 내용 리비전에 결박하면 나중에 "그건 다른 버전이었다"가 통하지 않는다.
//
// 신뢰 상태는 저장하지 않고 파생한다. 승인 결과를 frontmatter에 쓰면 그 쓰기가
// 리비전을 바꿔 방금 한 승인을 스스로 무효화한다(documentRevision은 metadata를
// 포함한다). 그리고 파생이라야 AI가 state를 active로 적어도 소용이 없다 —
// 게이트는 파일이 아니라 원장을 본다.

const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const eventStore = require('./event-store');
const { runGit } = require('./git');

// 커밋 시점의 파일 내용을 바이트 그대로 읽는다. 공용 runGit은 stdout을 trim하기
// 때문에 내용 조회에는 쓸 수 없다 — 후행 개행 하나가 리비전을 바꾼다.
function showFileAtCommit(root, commit, relativeFile) {
  const result = spawnSync('git', ['show', `${commit}:${relativeFile}`], { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

const EVENT_ID = /^EVT-[A-F0-9]{20}$/u;
const REQUEST_ID = /^REQ-[A-F0-9]{20}$/u;
const SIMPLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MEMBER_ID = /^MEMBER-\d{3}$/u;
const ARTIFACT_ID = /^[A-Z]{3}-\d{3,}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const DELEGATION_ID = /^DLG-[A-F0-9]{20}$/u;

// 승인이 무엇에 기댔는지는 필수다. 사유 문장은 선택이다 — 강제하면 "확인함"
// 같은 빈 문장이 채워질 뿐이고, 그것으로는 나중에 "AI 검토가 놓쳤나 사람이
// 건너뛰었나"를 구분할 수 없다. 개선하려면 그 구분이 필요하다.
const BASIS_KINDS = Object.freeze(['read', 'verdict', 'check', 'delegated']);
const BASE_FIELDS = ['schemaVersion', 'eventId', 'type', 'rootRequestId', 'requestId', 'clientId', 'projectId', 'targetId', 'reviewedRevision'];

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function normalizeText(value, label, limit) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\r\n/gu, '\n').trim();
  if (text.length > limit) throw new Error(`${label}은(는) ${limit}자 이하여야 합니다.`);
  return text;
}

function normalizeBasis(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('승인 근거가 하나 이상 필요합니다.');
  if (value.length > 10) throw new Error('승인 근거는 10개 이하여야 합니다.');
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('승인 근거는 객체여야 합니다.');
    const extra = Object.keys(item).filter((key) => !['kind', 'detail'].includes(key));
    if (extra.length) throw new Error(`승인 근거에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
    if (!BASIS_KINDS.includes(item.kind)) throw new Error(`지원하지 않는 승인 근거입니다: ${item.kind || '(없음)'} (가능: ${BASIS_KINDS.join(', ')})`);
    const detail = normalizeText(item.detail, '근거 상세', 300);
    const key = `${item.kind}\0${detail}`;
    if (seen.has(key)) throw new Error(`중복된 승인 근거입니다: ${item.kind}`);
    seen.add(key);
    return detail ? { kind: item.kind, detail } : { kind: item.kind };
  });
}

function normalizeApprovalEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('승인 이벤트는 객체여야 합니다.');
  if (input.type !== 'approval.granted') throw new Error(`알 수 없는 승인 이벤트 종류입니다: ${input.type || '(없음)'}`);
  const allowed = BASE_FIELDS.concat(['approvedBy', 'actorMemberId', 'basis', 'reason', 'delegationId', 'canonicalDigest', 'occurredAt']);
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`승인 이벤트에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
  for (const field of BASE_FIELDS.concat(['approvedBy', 'actorMemberId', 'basis'])) if (input[field] === undefined) throw new Error(`approval.granted.${field}이(가) 필요합니다.`);
  if (input.schemaVersion !== 1 || !EVENT_ID.test(input.eventId || '') || !REQUEST_ID.test(input.rootRequestId || '') || !REQUEST_ID.test(input.requestId || '')
    || !SIMPLE_ID.test(input.clientId || '') || !SIMPLE_ID.test(input.projectId || '') || !ARTIFACT_ID.test(input.targetId || '') || !REVISION.test(input.reviewedRevision || '')) {
    throw new Error('승인 이벤트의 신원이 유효하지 않습니다.');
  }
  if (!MEMBER_ID.test(input.approvedBy || '')) throw new Error('승인자는 MEMBER-ID여야 합니다.');
  if (!MEMBER_ID.test(input.actorMemberId || '')) throw new Error('행위자는 MEMBER-ID여야 합니다.');
  // 행위자와 승인자가 다르면 위임이 그 차이를 정당화해야 한다. 위임 없이 다른
  // 멤버 명의로 남은 기록은 형태만으로도 거부한다 — 병합으로 흘러들어와도.
  if (input.approvedBy !== input.actorMemberId && input.delegationId === undefined) {
    throw new Error('행위자와 승인자가 다르면 근거가 된 위임이 필요합니다.');
  }
  const normalized = {};
  for (const field of BASE_FIELDS) normalized[field] = input[field];
  normalized.approvedBy = input.approvedBy;
  normalized.actorMemberId = input.actorMemberId;
  normalized.basis = normalizeBasis(input.basis);
  const reason = normalizeText(input.reason, '사유', 1000);
  if (reason) normalized.reason = reason;
  if (input.delegationId !== undefined) {
    if (!DELEGATION_ID.test(input.delegationId || '')) throw new Error('위임 식별자가 유효하지 않습니다.');
    normalized.delegationId = input.delegationId;
  }
  return normalized;
}

function approvalEnvelope(input) {
  const canonical = normalizeApprovalEvent(input);
  const canonicalBytes = Buffer.from(eventStore.canonicalJson(canonical), 'utf8');
  const canonicalDigest = sha256(canonicalBytes);
  if (input.canonicalDigest !== undefined && input.canonicalDigest !== canonicalDigest) throw new Error(`canonicalDigest가 일치하지 않습니다: ${input.eventId}`);
  return {
    canonical,
    canonicalBytes,
    canonicalDigest,
    shared: Object.assign({}, canonical, { canonicalDigest }, input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt })
  };
}

// 기록 시각을 남긴다. 위임이 이 행위의 시점에 살아 있었는지 판정하려면 행위가
// 언제 기록됐는지가 필요하고, 지금까지 세 원장 모두 그것을 남기지 않았다.
// canonical 밖이라 기존 다이제스트는 바뀌지 않는다.
//
// 이것은 상태를 시각으로 판정하는 것이 아니라 사실을 기록하는 것이다. 판정은
// 접기가 하고, 접기는 이 값과 위임의 부여·만료·취소 시각을 비교할 뿐 읽는
// 시점의 시계를 보지 않는다 — 같은 이벤트를 언제 읽어도 같은 답이 나온다.
function appendApprovalEvent(eventsRoot, input, options) {
  const stamped = input && input.occurredAt === undefined
    ? Object.assign({}, input, { occurredAt: new Date().toISOString() })
    : input;
  const envelope = approvalEnvelope(stamped);
  const file = eventStore.appendEvent(eventsRoot, 'approval', envelope.canonical.projectId, envelope.canonical.clientId, envelope.shared, {
    lockDirectory: options && options.lockDirectory,
    fsync: !options || options.fsync !== false
  });
  return { file, event: envelope.shared };
}

function readApprovalEvents(eventsRoot, projectId) {
  if (!SIMPLE_ID.test(projectId || '')) throw new Error('승인 읽기 신원이 유효하지 않습니다.');
  return eventStore.readEvents(eventsRoot, 'approval', projectId, { sort: 'file', dedupe: false });
}

// 승인을 위임할 때 쓰는 결정 종류. 문자열을 여기저기 적으면 하나만 어긋나도
// 조회가 조용히 빈 결과를 내고 위임이 없는 것처럼 보인다.
const APPROVAL_DELEGATION_KIND = 'doc-approve';

// 인가 컨텍스트는 접기의 조건이다. 여기서 한 번 만들어 모든 읽기 경로가 같은 것을 쓴다.
function approvalAuthority(start, projectKey, now) {
  return require('./authority').authorityContext(start, projectKey, { now: now === undefined ? Date.now() : now });
}

function foldApprovals(events, options) {
  // 위조된 승인은 문서를 approved로 만들고 그 판정이 분석과 게이트로 흘러간다.
  // 쓰기 경로에서만 막으면 Git 병합으로 들어온 승인이 그대로 채택된다.
  const authority = require('./authority').requireAuthority(options, '승인');
  const diagnostics = [];
  const byEventId = new Map();
  for (const raw of events || []) {
    let event;
    try {
      event = normalizeApprovalEvent(raw);
      const expected = approvalEnvelope(event).canonicalDigest;
      if (raw.canonicalDigest !== undefined && raw.canonicalDigest !== expected) throw new Error('canonicalDigest 불일치');
      event.canonicalDigest = expected;
      // 기록 시각은 canonical 밖이지만 이력 순서에는 필요하다. 정규화가 벗겨낸
      // 값을 여기서 되붙인다 — 상태 판정이 아니라 표시 순서에만 쓴다.
      if (raw.occurredAt !== undefined) event.occurredAt = raw.occurredAt;
    } catch (error) {
      diagnostics.push({ code: 'RDL-APPROVE-014', severity: 'error', eventId: raw && raw.eventId || null, message: error.message });
      continue;
    }
    if (!byEventId.has(event.eventId)) byEventId.set(event.eventId, event);
    else if (byEventId.get(event.eventId) && byEventId.get(event.eventId).canonicalDigest !== event.canonicalDigest) {
      byEventId.set(event.eventId, null);
      diagnostics.push({ code: 'RDL-APPROVE-015', severity: 'error', eventId: event.eventId, message: '같은 eventId에 상충하는 승인 기록이 있습니다.' });
    }
  }
  const authorized = Array.from(byEventId.values()).filter(Boolean).filter((event) => {
    const verify = require('./authority').verifyActor;
    const codes = { unknownClient: 'RDL-APPROVE-020', impersonation: 'RDL-APPROVE-021', delegation: 'RDL-APPROVE-022', member: 'RDL-APPROVE-023' };
    // 행위자는 언제나 이 Client의 소유자여야 한다. 행위자 자리에는 위임이 서지 못한다 —
    // 위임은 누가 책임지는가를 옮길 뿐 누가 실제로 눌렀는가를 바꾸지 못한다.
    const actor = verify({ clientId: event.clientId, memberId: event.actorMemberId, recordedAt: event.occurredAt }, authority, codes);
    if (!actor.ok || actor.delegated) {
      diagnostics.push({ code: actor.code || 'RDL-APPROVE-021', severity: 'error', eventId: event.eventId, message: actor.message || '행위자를 위임으로 대신할 수 없습니다.' });
      return false;
    }
    if (event.approvedBy === event.actorMemberId) return true;
    // 책임자가 행위자와 다르면 그 차이를 위임이 정당화해야 한다.
    const responsible = verify({ clientId: event.clientId, memberId: event.approvedBy, delegationId: event.delegationId, kind: APPROVAL_DELEGATION_KIND, recordedAt: event.occurredAt }, authority, codes);
    if (!responsible.ok) {
      diagnostics.push({ code: responsible.code, severity: 'error', eventId: event.eventId, message: responsible.message });
      return false;
    }
    return true;
  });
  const byTarget = new Map();
  for (const event of authorized) {
    if (!byTarget.has(event.targetId)) byTarget.set(event.targetId, []);
    byTarget.get(event.targetId).push(event);
  }
  const approvals = new Map();
  for (const [targetId, events] of byTarget) {
    // 정렬 기준은 기록된 시각이고, 같은 시각이면 eventId로 결정성을 얻는다.
    // eventId만으로 정렬하면 해시 순서가 시간 순서를 가장해 "마지막 승인"이
    // 실제 마지막이 아니게 된다. occurredAt이 없는 기록은 뒤로 보낸다.
    approvals.set(targetId, events.slice().sort((left, right) => String(left.occurredAt || '').localeCompare(String(right.occurredAt || ''))
      || left.eventId.localeCompare(right.eventId)).map((event) => ({
      targetId,
      reviewedRevision: event.reviewedRevision,
      approvedBy: event.approvedBy,
      basis: event.basis,
      reason: event.reason || null,
      delegationId: event.delegationId || null,
      eventId: event.eventId,
      clientId: event.clientId
    })));
  }
  return { approvals, diagnostics };
}

// 신뢰 상태는 셋 중 하나이고 전부 파생이다.
function trustState(document, history) {
  const entries = history || [];
  if (!entries.length) return { status: 'unapproved', approvedRevision: null, approvedBy: null, approvals: 0 };
  const matched = entries.filter((entry) => entry.reviewedRevision === document.revision);
  // "마지막 승인"은 eventId 사전순의 끝이 아니다 — 그건 시간 순서가 아니라 해시
  // 순서다. 승인은 문서가 커밋된 순서를 따르므로, 낡음 상태에서 무엇으로
  // 되돌아갈지는 이력의 실제 순서(기록 순)로 판정한다.
  const last = entries[entries.length - 1];
  return matched.length
    ? { status: 'approved', approvedRevision: document.revision, approvedBy: matched[matched.length - 1].approvedBy, approvals: entries.length }
    : { status: 'stale', approvedRevision: last.reviewedRevision, approvedBy: last.approvedBy, approvals: entries.length };
}

// ── Workspace 경로 ──────────────────────────────────────────────────────────

function workspaceContext(start, projectKey) {
  const { workspaceLayout, selectProject } = require('./workspace');
  const { runtimeWorkspace } = require('./runtime');
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  if (layout.schemaVersion < 6) throw new Error('승인 기록에는 schemaVersion 6 이상의 Workspace가 필요합니다.');
  return { layout, project, eventsRoot: path.join(layout.root, 'projects', 'workspace', 'events'), lockDirectory: runtimeWorkspace(layout.root).locks };
}

function projectDocuments(project) {
  return require('./board-data').listDocuments(project);
}

function documentStatus(start, options) {
  const settings = options || {};
  const context = workspaceContext(start, settings.project);
  const folded = foldApprovals(readApprovalEvents(context.eventsRoot, context.project.key), { authority: approvalAuthority(start, context.project.key) });
  const documents = projectDocuments(context.project).map((document) => Object.assign({
    id: document.id,
    type: document.type,
    title: document.title,
    file: document.file,
    revision: document.revision
  }, trustState(document, folded.approvals.get(document.id))));
  const filtered = settings.status ? documents.filter((document) => document.status === settings.status) : documents;
  const counts = documents.reduce((totals, document) => Object.assign(totals, { [document.status]: (totals[document.status] || 0) + 1 }), {});
  return { project: context.project.key, counts, total: documents.length, documents: filtered, diagnostics: folded.diagnostics };
}

function findDocument(project, targetId) {
  const document = projectDocuments(project).find((item) => item.id === targetId);
  if (!document) throw new Error(`문서를 찾지 못했습니다: ${targetId || '(없음)'}`);
  return document;
}

function approveDocument(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const { getClient } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const clientId = String(settings.clientId || '').trim().toLowerCase();
  const client = getClient(start, clientId);
  if (client.status !== 'active') throw new Error(`비활성 Client는 승인할 수 없습니다: ${clientId}`);
  const members = readCollaboration(context.layout.root, context.project.key).members.map((member) => member.id);
  // delegated 근거는 실제 위임과 결박한다. 결박하지 않으면 "위임받아 승인했다"는
  // 주장만으로 책임이 옮겨가고, 위임의 만료·취소가 승인에 아무 영향을 주지 못한다.
  const delegated = (settings.basis || []).some((item) => item && item.kind === 'delegated');
  if (delegated && !settings.delegationId) throw new Error('delegated 근거에는 근거가 된 위임(--delegation)이 필요합니다.');
  if (!delegated && settings.delegationId) throw new Error('위임을 근거로 쓰려면 --basis delegated가 필요합니다.');
  let delegation = null;
  if (delegated) {
    delegation = require('./delegation').activeDelegationFor(start, { project: context.project.key, kind: APPROVAL_DELEGATION_KIND, clientId, now: settings.now });
    if (!delegation || delegation.delegationId !== settings.delegationId) {
      throw new Error(`유효한 위임이 아닙니다: ${settings.delegationId} (만료·취소되었거나 이 Client의 위임이 아닙니다)`);
    }
  }
  // 행위자는 이 Client의 소유자이고, 책임은 approvedBy가 진다. 위임이면 둘이
  // 다를 수 있고, 그때 위임이 그 차이를 정당화한다.
  const authority = require('./decision').assertAuthority(client, settings.approvedBy, members, '승인', delegation);
  const document = findDocument(context.project, settings.targetId);
  const folded = foldApprovals(readApprovalEvents(context.eventsRoot, context.project.key), { authority: approvalAuthority(start, context.project.key) });
  const state = trustState(document, folded.approvals.get(document.id));
  if (state.status === 'approved') return { project: context.project.key, document: Object.assign({ id: document.id, revision: document.revision }, state), created: false };
  const requestJournal = require('./request-journal');
  const rootRequestId = settings.rootRequestId || `REQ-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const childKey = `approval:${document.id}:${document.revision}`;
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  appendApprovalEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: requestJournal.eventIdForRequest(requestId), type: 'approval.granted',
    rootRequestId, requestId, clientId, projectId: context.project.key,
    targetId: document.id, reviewedRevision: document.revision,
    approvedBy: settings.approvedBy, actorMemberId: authority.actor, basis: settings.basis, reason: settings.reason,
    ...(settings.delegationId ? { delegationId: settings.delegationId } : {})
  }, { lockDirectory: context.lockDirectory });
  const after = foldApprovals(readApprovalEvents(context.eventsRoot, context.project.key), { authority: approvalAuthority(start, context.project.key) });
  return { project: context.project.key, document: Object.assign({ id: document.id, revision: document.revision }, trustState(document, after.approvals.get(document.id))), created: true };
}

// git은 "무엇이 언제", 원장은 "왜 그리고 누구 책임"을 안다. 이력의 값은 둘을
// 붙이는 데 있다 — 특히 태스크도 승인도 없이 바뀐 정본을 드러내는 데 있다.
function documentHistory(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const document = findDocument(context.project, settings.targetId);
  const folded = foldApprovals(readApprovalEvents(context.eventsRoot, context.project.key), { authority: approvalAuthority(start, context.project.key) });
  const history = folded.approvals.get(document.id) || [];
  const log = runGit(['log', '--follow', '--format=%H%an%aI%s', '--', document.file], { cwd: context.project.root, allowFailure: true });
  const commits = (log.status === 0 ? log.stdout : '').split(/\r?\n/u).filter(Boolean).map((line) => {
    const [commit, author, at, subject] = line.split('');
    return { commit, author, at, subject };
  });
  // git은 무엇이 언제, 원장은 왜와 누구 책임을 안다. 이력의 값은 둘을 붙이는 데
  // 있고, 특히 어느 쪽도 답하지 않는 변경 — 태스크도 승인도 없이 바뀐 정본 —을
  // 드러내는 데 있다.
  const linked = require('./query-index').queryTasks(start, { project: context.project.key }).tasks
    .filter((task) => (task.links || []).includes(document.id))
    .map((task) => ({ id: task.id, title: task.title, status: task.status }));
  const state = trustState(document, history);
  const unexplained = state.status !== 'approved' && linked.length === 0 && commits.length > 0;
  return {
    project: context.project.key,
    document: Object.assign({ id: document.id, title: document.title, file: document.file, revision: document.revision }, state),
    approvals: history,
    tasks: linked,
    commits,
    ...(unexplained ? { warning: '이 문서의 현재 리비전은 승인도 연결된 태스크도 없습니다. 왜 바뀌었는지 답할 기록이 없습니다.' } : {})
  };
}

// 승인 이후 바뀐 부분만 보여준다. 이것이 없으면 한 글자를 고칠 때마다 문서
// 전체를 다시 읽어야 하고, 그러면 사람은 읽지 않고 승인한다 — 엄격한 무효화는
// 재승인이 쌀 때만 유지된다.
function diffSinceApproval(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const document = findDocument(context.project, settings.targetId);
  const folded = foldApprovals(readApprovalEvents(context.eventsRoot, context.project.key), { authority: approvalAuthority(start, context.project.key) });
  const history = folded.approvals.get(document.id) || [];
  const state = trustState(document, history);
  if (state.status === 'unapproved') return { project: context.project.key, targetId: document.id, status: state.status, diff: null, reason: '승인 기록이 없어 비교 기준이 없습니다.' };
  if (state.status === 'approved') return { project: context.project.key, targetId: document.id, status: state.status, diff: '', reason: '현재 리비전이 승인되어 있습니다.' };
  // 승인된 리비전을 담은 커밋을 찾는다. 리비전은 내용 해시라 커밋과 1:1이 아니고,
  // 그 파일을 건드린 커밋만 후보다 — 전체 이력을 계산하지 않는다.
  const approvedRevision = state.approvedRevision;
  const { documentRevision } = require('./board-data');
  const { parseFrontmatter } = require('./frontmatter');
  const log = runGit(['log', '--follow', '--format=%H', '--', document.file], { cwd: context.project.root, allowFailure: true });
  const commits = (log.status === 0 ? log.stdout : '').split(/\r?\n/u).filter(Boolean);
  for (const commit of commits) {
    // runGit은 stdout을 trim한다. 파일 내용을 그렇게 읽으면 후행 개행이 잘려
    // 리비전이 달라지고, 승인된 리비전을 담은 커밋이 있어도 영영 못 찾는다 —
    // 내용은 바이트 그대로 읽어야 한다.
    const shown = showFileAtCommit(context.project.root, commit, document.file);
    if (shown === null) continue;
    const parsed = parseFrontmatter(shown);
    if (!parsed || documentRevision(parsed.data, parsed.body) !== approvedRevision) continue;
    const diff = runGit(['diff', `${commit}`, '--', document.file], { cwd: context.project.root, allowFailure: true });
    return { project: context.project.key, targetId: document.id, status: state.status, approvedRevision, approvedBy: state.approvedBy, baseCommit: commit, diff: diff.status === 0 ? diff.stdout : null };
  }
  return { project: context.project.key, targetId: document.id, status: state.status, approvedRevision, approvedBy: state.approvedBy, baseCommit: null, diff: null, reason: '승인된 리비전을 담은 커밋을 찾지 못했습니다. 승인 이후 커밋되지 않았을 수 있습니다.' };
}

module.exports = {
  BASIS_KINDS, normalizeApprovalEvent, approvalEnvelope, appendApprovalEvent, readApprovalEvents,
  foldApprovals, trustState, documentStatus, approveDocument, documentHistory, diffSinceApproval
};
