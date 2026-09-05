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
const { BASIS_KINDS, SUBMISSION_STATES } = require('./vocabulary');
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

// 제출은 같은 원장의 두 번째 이벤트 종류다. 원장을 나누지 않은 이유는 상태가 둘을
// 함께 접어야만 나오기 때문이다 — "제출됐고 그 뒤 또 고쳤다"는 제출 이벤트 하나로도,
// 승인 이벤트 하나로도 답할 수 없고 둘의 순서를 맞춰야 나온다. 원장이 둘이면 그
// 순서를 두 파일의 시각으로 맞춰야 하는데, 이 저장소는 시계로 상태를 정하지 않는다.
// 한 원장 안에서는 같은 recordedAt 규약과 같은 봉투·다이제스트를 쓰므로 순서가
// 원장 자신의 성질이 된다.
//
// 덤으로 check.js의 events/approval 검증 루프(파일명 패턴·Client 대조·봉투
// 다이제스트)가 그대로 제출에도 걸린다. 원장을 새로 열었다면 그 루프를 복제해야
// 했고, 복제를 잊는 순간 위조된 제출이 아무 데서도 안 걸린다.
const SUBMISSION_TYPE = 'approval.submitted';
const APPROVAL_TYPE = 'approval.granted';

// 제출자는 사람이 아니어도 된다. 이 도구의 협업 모형은 "에이전트가 쓰고 사람이
// 책임진다"이고 제출은 그 앞쪽이다 — 제출까지 사람 전용으로 막으면 관문이 아니라
// 병목이 된다. 승인만 사람 몫이다.
//
// 그래서 제출에는 approvedBy/actorMemberId 두 칸이 없고 submittedBy 하나뿐이다.
// 승인이 둘을 가르는 이유는 위임이 "누가 눌렀나"와 "누가 책임지나"를 갈라놓기
// 때문인데, 제출은 책임을 옮기지 않으므로 갈릴 것이 없다. 칸을 하나 더 두면 둘이
// 어긋난 기록의 뜻을 정해야 하는데 정할 뜻이 없다.
//
// 리비전 칸은 reviewedRevision을 그대로 쓴다. 이름을 "검토된"이 아니라 "이 이벤트가
// 결박한 내용 리비전"으로 읽어야 한다 — 이 원장의 모든 이벤트가 (targetId,
// reviewedRevision)으로 문서의 한 리비전을 지목한다는 불변식이 유지되어야, 리비전을
// 보는 소비자(check의 리비전 해소, 커밋 역추적)가 종류별 분기를 갖지 않는다.
function normalizeSubmissionEvent(input) {
  const allowed = BASE_FIELDS.concat(['submittedBy', 'reason', 'recordedAt', 'canonicalDigest', 'occurredAt']);
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`제출 이벤트에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
  for (const field of BASE_FIELDS.concat(['submittedBy'])) if (input[field] === undefined) throw new Error(`${SUBMISSION_TYPE}.${field}이(가) 필요합니다.`);
  if (input.schemaVersion !== 1 || !EVENT_ID.test(input.eventId || '') || !REQUEST_ID.test(input.rootRequestId || '') || !REQUEST_ID.test(input.requestId || '')
    || !SIMPLE_ID.test(input.clientId || '') || !SIMPLE_ID.test(input.projectId || '') || !ARTIFACT_ID.test(input.targetId || '') || !REVISION.test(input.reviewedRevision || '')) {
    throw new Error('제출 이벤트의 신원이 유효하지 않습니다.');
  }
  if (!MEMBER_ID.test(input.submittedBy || '')) throw new Error('제출자는 MEMBER-ID여야 합니다.');
  const normalized = {};
  for (const field of BASE_FIELDS) normalized[field] = input[field];
  normalized.submittedBy = input.submittedBy;
  // 사유는 선택이다. 승인 근거와 달리 제출에는 강제할 근거가 없다 — 무엇에 기대어
  // 올렸는가는 검토자가 물을 것이지 제출자가 미리 증명할 것이 아니다.
  const reason = normalizeText(input.reason, '사유', 1000);
  if (reason) normalized.reason = reason;
  if (input.recordedAt !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.recordedAt || '')) throw new Error('기록 시각은 밀리초 단위 ISO-8601 UTC여야 합니다.');
    normalized.recordedAt = input.recordedAt;
  }
  return normalized;
}

function normalizeApprovalEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('승인 이벤트는 객체여야 합니다.');
  // 종류 분기를 봉투 바깥이 아니라 여기 두는 이유는 approvalEnvelope·
  // appendApprovalEvent·check.js가 전부 이 함수 하나를 지나기 때문이다. 종류마다
  // 검증기를 따로 부르게 만들면 그중 하나가 새 종류를 모르는 채로 남는다.
  if (input.type === SUBMISSION_TYPE) return normalizeSubmissionEvent(input);
  if (input.type !== APPROVAL_TYPE) throw new Error(`알 수 없는 승인 이벤트 종류입니다: ${input.type || '(없음)'}`);
  const allowed = BASE_FIELDS.concat(['approvedBy', 'actorMemberId', 'basis', 'reason', 'delegationId', 'recordedAt', 'canonicalDigest', 'occurredAt']);
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
  // 인가 판정에 쓰는 기록 시각. canonical 안에 있으므로 고치면 다이제스트가 달라진다.
  if (input.recordedAt !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.recordedAt || '')) throw new Error('기록 시각은 밀리초 단위 ISO-8601 UTC여야 합니다.');
    normalized.recordedAt = input.recordedAt;
  }
  return normalized;
}

// 판정에 쓰는 값은 다이제스트가 덮어야 한다. occurredAt은 표시·정렬용이고
// canonical 밖이라 같은 이벤트의 시각만 바꿔도 다이제스트가 그대로다 — 그 값으로
// 권한을 판정하면 취소된 위임을 취소 전으로 되돌려 다시 쓸 수 있다. 그래서 인가에
// 쓰는 시각은 canonical 안의 별도 필드로 둔다.
//
// 이렇게 하면 기록된 시각을 고치는 순간 다이제스트가 달라진다. 원본이 이미 공유된
// 뒤라면 같은 eventId에 다른 다이제스트가 생겨 상충으로 잡히고, 그 기록은 상태를
// 바꾸지 못한다(fail-closed).
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
  const now = new Date().toISOString();
  const stamped = Object.assign({}, input,
    input && input.occurredAt === undefined ? { occurredAt: now } : {},
    input && input.recordedAt === undefined ? { recordedAt: now } : {});
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
    // 제출은 명의가 곧 행위자이므로 그 한 칸이 같은 검사를 받는다. 인가 기계를
    // 재사용하지 않으면 위조된 제출이 검토 인박스에 그대로 서고, 승인자는 아무도
    // 올린 적 없는 것을 자기 몫으로 본다.
    const actorMemberId = event.type === SUBMISSION_TYPE ? event.submittedBy : event.actorMemberId;
    const actor = verify({ clientId: event.clientId, memberId: actorMemberId, recordedAt: event.recordedAt }, authority, codes);
    if (!actor.ok || actor.delegated) {
      diagnostics.push({ code: actor.code || 'RDL-APPROVE-021', severity: 'error', eventId: event.eventId, message: actor.message || '행위자를 위임으로 대신할 수 없습니다.' });
      return false;
    }
    if (event.type === SUBMISSION_TYPE) return true;
    if (event.approvedBy === event.actorMemberId) return true;
    // 책임자가 행위자와 다르면 그 차이를 위임이 정당화해야 한다.
    const responsible = verify({ clientId: event.clientId, memberId: event.approvedBy, delegationId: event.delegationId, kind: APPROVAL_DELEGATION_KIND, recordedAt: event.recordedAt }, authority, codes);
    if (!responsible.ok) {
      diagnostics.push({ code: responsible.code, severity: 'error', eventId: event.eventId, message: responsible.message });
      return false;
    }
    return true;
  });
  // 정렬 기준은 canonical 안의 기록 시각이다. 표시용 occurredAt으로 정렬하면
  // 다이제스트를 건드리지 않고 "마지막 승인"을 바꿀 수 있고, 그 값이 낡음
  // 판정과 차분 기준을 정하므로 표시용이 아니라 상태를 정하는 값이 된다.
  // 없는 기록은 뒤로 보내고, 같은 시각이면 eventId로 결정성을 얻는다.
  const inOrder = (events) => events.slice().sort((left, right) => String(left.recordedAt || '').localeCompare(String(right.recordedAt || ''))
    || left.eventId.localeCompare(right.eventId));
  const group = (predicate) => {
    const byTarget = new Map();
    for (const event of authorized.filter(predicate)) {
      if (!byTarget.has(event.targetId)) byTarget.set(event.targetId, []);
      byTarget.get(event.targetId).push(event);
    }
    return byTarget;
  };
  const approvals = new Map();
  for (const [targetId, events] of group((event) => event.type !== SUBMISSION_TYPE)) {
    approvals.set(targetId, inOrder(events).map((event) => ({
      targetId,
      reviewedRevision: event.reviewedRevision,
      approvedBy: event.approvedBy,
      basis: event.basis,
      reason: event.reason || null,
      delegationId: event.delegationId || null,
      recordedAt: event.recordedAt || null,
      eventId: event.eventId,
      clientId: event.clientId
    })));
  }
  // 제출 이력은 승인 이력과 같은 접기에서 나온다. 두 번 접으면 두 결과가 서로 다른
  // 시점의 원장을 볼 수 있고, 그러면 "제출됐는데 그 뒤 승인됐다"가 순서 없이 보인다.
  const submissions = new Map();
  for (const [targetId, events] of group((event) => event.type === SUBMISSION_TYPE)) {
    submissions.set(targetId, inOrder(events).map((event) => ({
      targetId,
      submittedRevision: event.reviewedRevision,
      submittedBy: event.submittedBy,
      reason: event.reason || null,
      recordedAt: event.recordedAt || null,
      eventId: event.eventId,
      clientId: event.clientId
    })));
  }
  return { approvals, submissions, diagnostics };
}

// 제출 축의 판정. 값의 정본과 뜻은 vocabulary의 SUBMISSION_STATES가 갖는다.
//
// drifted가 이 갈래의 핵심이다. 오너가 겪은 "계속 확인하면서 처음부터 다시 탄"
// 감각의 정체가 그것인데, 여태 그 사실을 드러내는 값이 아무 데도 없었다 —
// 승인자가 보던 것과 지금 파일이 다르다는 것을 도구가 말하지 않으면 사람은 매번
// 문서 전체를 다시 읽어야 하고, 그러면 읽지 않고 승인하게 된다.
function submissionState(document, approvals, submissions) {
  const approvedRevisions = new Set(approvals.map((entry) => entry.reviewedRevision));
  const latest = submissions.length ? submissions[submissions.length - 1] : null;
  const state = !latest ? 'none'
    : approvedRevisions.has(document.revision) ? 'settled'
      : latest.submittedRevision === document.revision ? 'pending' : 'drifted';
  return {
    state,
    revision: latest ? latest.submittedRevision : null,
    submittedBy: latest ? latest.submittedBy : null,
    submittedByClient: latest ? latest.clientId : null,
    reason: latest ? latest.reason : null,
    recordedAt: latest ? latest.recordedAt : null,
    submissions: submissions.length
  };
}

// 사람이 읽는 버전 번호. 큰 자리는 승인 횟수, 작은 자리는 마지막 승인 이후 올린
// 횟수다. 문서에도 원장에도 저장하지 않는다 — 저장하는 순간 그 번호가 두 번째 진실
// 원천이 되어 원장과 갈리고, 갈렸다는 사실은 아무 신호도 내지 않는다. 신뢰 상태를
// 저장하지 않고 파생하는 것과 같은 이유다.
//
// "마지막 승인 이후"를 판정하려면 두 종류의 순서가 필요한데, 둘이 같은 원장에 있어
// 순서가 원장 자신의 성질이다 — 승인 이력에서 "마지막 승인"을 정할 때와 같은 기준
// (canonical 안의 recordedAt)을 쓴다. 원장이 둘이었다면 이 한 줄이 두 파일을 시계로
// 엮는 자리가 됐을 것이고, 그 시각은 어느 쪽도 상대의 것을 검증하지 못한다.
function versionLabel(approvals, submissions) {
  const last = approvals.length ? approvals[approvals.length - 1] : null;
  const since = last
    ? submissions.filter((entry) => String(entry.recordedAt || '').localeCompare(String(last.recordedAt || '')) > 0)
    : submissions;
  return `${approvals.length}.${since.length}`;
}

// 신뢰 상태는 셋 중 하나이고 전부 파생이다. 제출 정보는 그 셋을 건드리지 않고
// 별도 칸으로 실린다 — 세 값의 이름과 뜻은 그대로다.
function trustState(document, history, submissionHistory) {
  const entries = history || [];
  const submissions = submissionHistory || [];
  const matched = entries.filter((entry) => entry.reviewedRevision === document.revision);
  // "마지막 승인"은 eventId 사전순의 끝이 아니다 — 그건 시간 순서가 아니라 해시
  // 순서다. 승인은 문서가 커밋된 순서를 따르므로, 낡음 상태에서 무엇으로
  // 되돌아갈지는 이력의 실제 순서(기록 순)로 판정한다.
  const last = entries[entries.length - 1];
  const trust = !entries.length
    ? { status: 'unapproved', approvedRevision: null, approvedBy: null, approvals: 0 }
    : matched.length
      ? { status: 'approved', approvedRevision: document.revision, approvedBy: matched[matched.length - 1].approvedBy, approvals: entries.length }
      : { status: 'stale', approvedRevision: last.reviewedRevision, approvedBy: last.approvedBy, approvals: entries.length };
  return Object.assign(trust, {
    submission: submissionState(document, entries, submissions),
    versionLabel: versionLabel(entries, submissions)
  });
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

// 원장 경로와 인가 컨텍스트 조립은 한 자리에만 둔다. 이 세 줄을 부르는 쪽이 각자
// 복사하면(실제로 다른 갈래가 복사했다) 그 사본이 approval.js와 어긋나는 날 승인
// 사유나 인가 판정이 조용히 달라진다 — 부르는 쪽은 자기가 낡은 규칙을 쓰고 있다는
// 사실을 알 방법이 없다.
function foldedApprovalLedger(start, projectKey) {
  const context = workspaceContext(start, projectKey);
  const folded = foldApprovals(readApprovalEvents(context.eventsRoot, context.project.key), { authority: approvalAuthority(start, context.project.key) });
  return { context, folded };
}

// 접힌 원장만 내는 읽기 자리. 문서 목록을 다시 읽거나 trustState를 돌리지 않는다 —
// 그것이 필요한 쪽은 documentStatus를 부르면 되고, 여기까지 그 일을 하면 승인 사유
// 하나가 필요한 소비자가 문서 전량 읽기까지 떠안는다.
//
// 제출 이력을 함께 내는 이유는 원장이 하나이기 때문이다. 승인만 내면 부르는 쪽이
// 제출을 얻으려고 같은 원장을 한 번 더 접게 되고, 두 접기는 서로 다른 시점을 볼 수 있다.
function documentApprovals(start, options) {
  const settings = options || {};
  const { context, folded } = foldedApprovalLedger(start, settings.project);
  return { project: context.project.key, approvals: folded.approvals, submissions: folded.submissions, diagnostics: folded.diagnostics };
}

function documentStatus(start, options) {
  const settings = options || {};
  const { context, folded } = foldedApprovalLedger(start, settings.project);
  const documents = projectDocuments(context.project).map((document) => Object.assign({
    id: document.id,
    type: document.type,
    title: document.title,
    file: document.file,
    revision: document.revision
  }, trustState(document, folded.approvals.get(document.id), folded.submissions.get(document.id))));
  const matches = (document) => (!settings.status || document.status === settings.status)
    && (!settings.submission || document.submission.state === settings.submission);
  const filtered = documents.filter(matches);
  const counts = documents.reduce((totals, document) => Object.assign(totals, { [document.status]: (totals[document.status] || 0) + 1 }), {});
  // 제출 축은 0으로 채워서 낸다. 없는 키를 빼면 "검토 대기 0건"과 "제출 축을 안
  // 쓰는 프로젝트"가 화면에서 같아 보이고, 그 둘은 전혀 다른 사정이다.
  const submissionCounts = documents.reduce((totals, document) => Object.assign(totals, { [document.submission.state]: totals[document.submission.state] + 1 }),
    SUBMISSION_STATES.reduce((seed, state) => Object.assign(seed, { [state]: 0 }), {}));
  return { project: context.project.key, counts, submissionCounts, total: documents.length, documents: filtered, diagnostics: folded.diagnostics };
}

function findDocument(project, targetId) {
  const document = projectDocuments(project).find((item) => item.id === targetId);
  if (!document) throw new Error(`문서를 찾지 못했습니다: ${targetId || '(없음)'}`);
  return document;
}

// 제출은 "이 리비전을 승인 후보로 올린다"를 원장에 남긴다. 이것이 없으면 관문 앞에
// 줄 설 자리가 없다 — 문서는 정본에 바로 커밋되며 전진하고, 승인자는 무엇이 자기
// 검토를 기다리는지 볼 곳이 없어 승인이 맨 끝으로 밀린다(사용기 리포트 §8).
//
// 승인과 달리 사람 Client를 요구하지 않는다. 에이전트가 쓰고 사람이 책임지는 것이
// 이 도구의 협업 모형이고, 제출은 그 앞쪽이다. 제출까지 사람 전용이면 사람이 줄을
// 세우는 일까지 해야 하고, 그것은 관문이 아니라 병목이다.
function submitDocument(start, input) {
  const settings = input || {};
  const { context, folded } = foldedApprovalLedger(start, settings.project);
  const { getClient } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const clientId = String(settings.clientId || '').trim().toLowerCase();
  const client = getClient(start, clientId);
  if (client.status !== 'active') throw new Error(`비활성 Client는 제출할 수 없습니다: ${clientId}`);
  const members = readCollaboration(context.layout.root, context.project.key).members.map((member) => member.id);
  const decision = require('./decision');
  // 제출 명의는 고를 여지가 없다 — 책임을 옮기지 않으므로 위임이 설 자리도 없고,
  // 명의는 언제나 이 Client의 소유자다. --member를 받는 것은 스크립트가 그 사실을
  // 명시적으로 적을 수 있게 하기 위함이고, 다르면 assertAuthority가 거부한다.
  const submittedBy = settings.submittedBy || decision.actingMember(client, members);
  decision.assertAuthority(client, submittedBy, members, '제출', null);
  const document = findDocument(context.project, settings.targetId);
  const history = folded.approvals.get(document.id) || [];
  const submissions = folded.submissions.get(document.id) || [];
  const state = trustState(document, history, submissions);
  // 이미 승인된 리비전은 올릴 것이 없고, 같은 리비전을 두 번 올리는 것도 줄을 두 번
  // 세우는 일일 뿐이다. approveDocument가 같은 리비전의 재승인을 기록하지 않는 것과
  // 같은 이유 — 원장이 아무 사실도 더하지 않는 줄로 불어난다.
  if (state.status === 'approved' || state.submission.state === 'pending') {
    return { project: context.project.key, document: Object.assign({ id: document.id, revision: document.revision }, state), created: false };
  }
  const requestJournal = require('./request-journal');
  const rootRequestId = settings.rootRequestId || `REQ-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  // 제출 횟수를 키에 넣는다. 리비전만으로 키를 만들면 "A 제출 → B로 고침 → A로
  // 되돌림 → 다시 제출"이 첫 제출과 같은 eventId를 만들고, 기록 시각이 달라 봉투
  // 다이제스트가 어긋나 append가 eventId 손상으로 거부된다.
  const childKey = `submission:${document.id}:${document.revision}:${submissions.length}`;
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  appendApprovalEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: requestJournal.eventIdForRequest(requestId), type: SUBMISSION_TYPE,
    rootRequestId, requestId, clientId, projectId: context.project.key,
    targetId: document.id, reviewedRevision: document.revision,
    submittedBy, reason: settings.reason
  }, { lockDirectory: context.lockDirectory });
  const after = foldedApprovalLedger(start, context.project.key).folded;
  return {
    project: context.project.key,
    document: Object.assign({ id: document.id, revision: document.revision },
      trustState(document, after.approvals.get(document.id), after.submissions.get(document.id))),
    created: true
  };
}

function approveDocument(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const { getClient, assertProjectHumanApprover } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const clientId = String(settings.clientId || '').trim().toLowerCase();
  const client = getClient(start, clientId);
  // 사람 게이트. 이 파일 맨 위가 선언한 "AI가 쓴 초안과 사람이 책임지는 정본의 경계"가
  // 여기다 — 그런데 오래 status만 보고 type을 보지 않아, 에이전트 Client가 자기 초안을
  // 스스로 정본으로 만들 수 있었다. 판정은 collaboration-store가 소유하고 런 승인·
  // 공유 게이트·보드의 승인자 목록이 같은 것을 쓴다. 표면마다 판정을 따로 두면 그중
  // 느슨한 쪽이 게이트의 실제 높이가 되고, 이 결함이 정확히 그 모양이었다.
  //
  // 제출(submitDocument)에는 걸지 않는다. 에이전트가 초안을 올리고 사람이 책임지는 것이
  // 이 도구의 협업 모형이라, 제출까지 막으면 관문이 아니라 병목이 된다.
  assertProjectHumanApprover(context.layout.root, context.project.key, client, '승인');
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
  const folded = foldedApprovalLedger(start, context.project.key).folded;
  const state = trustState(document, folded.approvals.get(document.id), folded.submissions.get(document.id));
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
  const after = foldedApprovalLedger(start, context.project.key).folded;
  return { project: context.project.key, document: Object.assign({ id: document.id, revision: document.revision }, trustState(document, after.approvals.get(document.id), after.submissions.get(document.id))), created: true };
}

// git은 "무엇이 언제", 원장은 "왜 그리고 누구 책임"을 안다. 이력의 값은 둘을
// 붙이는 데 있다 — 특히 태스크도 승인도 없이 바뀐 정본을 드러내는 데 있다.
function documentHistory(start, input) {
  const settings = input || {};
  const { context, folded } = foldedApprovalLedger(start, settings.project);
  const document = findDocument(context.project, settings.targetId);
  const history = folded.approvals.get(document.id) || [];
  const submissions = folded.submissions.get(document.id) || [];
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
  const state = trustState(document, history, submissions);
  const unexplained = state.status !== 'approved' && linked.length === 0 && commits.length > 0;
  return {
    project: context.project.key,
    document: Object.assign({ id: document.id, title: document.title, file: document.file, revision: document.revision }, state),
    approvals: history,
    submissions,
    tasks: linked,
    commits,
    ...(unexplained ? { warning: '이 문서의 현재 리비전은 승인도 연결된 태스크도 없습니다. 왜 바뀌었는지 답할 기록이 없습니다.' } : {})
  };
}

// 승인 이후 바뀐 부분만 보여준다. 이것이 없으면 한 글자를 고칠 때마다 문서
// 전체를 다시 읽어야 하고, 그러면 사람은 읽지 않고 승인한다 — 엄격한 무효화는
// 재승인이 쌀 때만 유지된다.
// 그 파일을 건드린 커밋만 후보다 — 전체 이력을 계산하지 않는다. 후보 목록을 따로
// 빼는 이유는 승인본과 제출본을 한 비교에서 둘 다 찾을 때 git log를 두 번 부르지
// 않기 위해서다.
function revisionCandidates(root, file) {
  const log = runGit(['log', '--follow', '--format=%H', '--', file], { cwd: root, allowFailure: true });
  return (log.status === 0 ? log.stdout : '').split(/\r?\n/u).filter(Boolean);
}

// 리비전 해시 → 그 해시를 담은 커밋. "버전"은 파일이 아니라 (내용 해시, 그 해시를
// 담은 커밋)의 짝으로 이미 주소가 있고, 그 짝을 만드는 자리는 하나여야 한다 —
// 승인본 전용 루프로 두면 제출본을 같은 방식으로 지목할 수 없어 사본 설계로 밀린다.
function commitForRevision(root, file, revision, candidates) {
  if (!revision) return null;
  const { documentRevision } = require('./board-data');
  const { parseFrontmatter } = require('./frontmatter');
  for (const commit of candidates || revisionCandidates(root, file)) {
    // runGit은 stdout을 trim한다. 파일 내용을 그렇게 읽으면 후행 개행이 잘려
    // 리비전이 달라지고, 그 리비전을 담은 커밋이 있어도 영영 못 찾는다 —
    // 내용은 바이트 그대로 읽어야 한다.
    const shown = showFileAtCommit(root, commit, file);
    if (shown === null) continue;
    const parsed = parseFrontmatter(shown);
    if (!parsed || documentRevision(parsed.data, parsed.body) !== revision) continue;
    return commit;
  }
  return null;
}

function diffSinceApproval(start, input) {
  const settings = input || {};
  const { context, folded } = foldedApprovalLedger(start, settings.project);
  const document = findDocument(context.project, settings.targetId);
  const history = folded.approvals.get(document.id) || [];
  const state = trustState(document, history, folded.submissions.get(document.id));
  if (state.status === 'unapproved') return { project: context.project.key, targetId: document.id, status: state.status, diff: null, reason: '승인 기록이 없어 비교 기준이 없습니다.' };
  if (state.status === 'approved') return { project: context.project.key, targetId: document.id, status: state.status, diff: '', reason: '현재 리비전이 승인되어 있습니다.' };
  const approvedRevision = state.approvedRevision;
  const commit = commitForRevision(context.project.root, document.file, approvedRevision);
  if (!commit) return { project: context.project.key, targetId: document.id, status: state.status, approvedRevision, approvedBy: state.approvedBy, baseCommit: null, diff: null, reason: '승인된 리비전을 담은 커밋을 찾지 못했습니다. 승인 이후 커밋되지 않았을 수 있습니다.' };
  const diff = runGit(['diff', `${commit}`, '--', document.file], { cwd: context.project.root, allowFailure: true });
  return { project: context.project.key, targetId: document.id, status: state.status, approvedRevision, approvedBy: state.approvedBy, baseCommit: commit, diff: diff.status === 0 ? diff.stdout : null };
}

// 승인본 ↔ 제출본. --since-approval이 "승인본 ↔ 작업본"이라면 이쪽은 "승인본 ↔
// 승인 후보"다. 승인자가 판정해야 하는 것은 작업본이 아니라 후보이고, 그 둘이 다를
// 수 있다는 사실 자체가 관문의 핵심이다.
//
// 제출본이 커밋되어 있어야 한다는 것은 결함이 아니라 관문의 정의다. 유동적인
// 작업본은 다음 순간 달라질 수 있어 승인자가 본 것과 승인된 것을 결박할 수 없다 —
// 승인은 그 결박 위에만 선다. 그래서 커밋을 못 찾으면 지어내지 않고 이유를 낸다.
function diffSubmission(start, input) {
  const settings = input || {};
  const { context, folded } = foldedApprovalLedger(start, settings.project);
  const document = findDocument(context.project, settings.targetId);
  const history = folded.approvals.get(document.id) || [];
  const state = trustState(document, history, folded.submissions.get(document.id));
  const base = {
    project: context.project.key, targetId: document.id, status: state.status,
    submission: state.submission, versionLabel: state.versionLabel
  };
  if (state.submission.state === 'none') {
    return Object.assign(base, { diff: null, reason: '제출 기록이 없습니다. 승인 후보로 올린 리비전이 없으면 비교할 제출본이 없습니다 — rdl doc submit으로 먼저 올리십시오.' });
  }
  const submittedRevision = state.submission.revision;
  const approvedRevision = state.approvedRevision;
  const shared = Object.assign(base, { submittedRevision, submittedBy: state.submission.submittedBy, approvedRevision, approvedBy: state.approvedBy });
  if (state.status === 'unapproved') {
    return Object.assign(shared, { approvedCommit: null, submittedCommit: null, diff: null, reason: '승인 기록이 없어 비교 기준이 될 승인본이 없습니다. 첫 제출은 문서 전체가 검토 대상입니다.' });
  }
  if (approvedRevision === submittedRevision) {
    return Object.assign(shared, { approvedCommit: null, submittedCommit: null, diff: '', reason: '제출된 리비전이 이미 승인되어 있습니다.' });
  }
  const candidates = revisionCandidates(context.project.root, document.file);
  const approvedCommit = commitForRevision(context.project.root, document.file, approvedRevision, candidates);
  const submittedCommit = commitForRevision(context.project.root, document.file, submittedRevision, candidates);
  if (!approvedCommit || !submittedCommit) {
    const missing = !approvedCommit && !submittedCommit ? '승인본과 제출본' : approvedCommit ? '제출본' : '승인본';
    return Object.assign(shared, {
      approvedCommit, submittedCommit, diff: null,
      reason: `${missing}의 리비전을 담은 커밋을 찾지 못했습니다. 비교는 커밋된 리비전 사이에서만 성립합니다 — 아직 커밋하지 않은 작업본은 다음 순간 달라질 수 있어 승인자가 본 것과 결박되지 않습니다.`
    });
  }
  const diff = runGit(['diff', approvedCommit, submittedCommit, '--', document.file], { cwd: context.project.root, allowFailure: true });
  return Object.assign(shared, { approvedCommit, submittedCommit, diff: diff.status === 0 ? diff.stdout : null });
}

module.exports = {
  BASIS_KINDS, SUBMISSION_STATES, SUBMISSION_TYPE, APPROVAL_TYPE,
  normalizeApprovalEvent, approvalEnvelope, appendApprovalEvent, readApprovalEvents,
  foldApprovals, trustState, commitForRevision,
  documentApprovals, documentStatus, submitDocument, approveDocument, documentHistory,
  diffSinceApproval, diffSubmission
};
