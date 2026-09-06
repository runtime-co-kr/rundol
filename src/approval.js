'use strict';

// 사람 승인과 신뢰 상태. AI가 쓴 초안과 사람이 책임지는 정본의 경계를 만든다.
//
// 승인은 "읽었다"의 증거가 아니라 "내가 책임진다"의 선언이다. 그래서 위조
// 가능성은 요구를 없앨 이유가 아니라 드러나게 만들 이유다 — 승인을 그 시점의
// 내용 리비전에 결박하면 나중에 "그건 다른 버전이었다"가 통하지 않는다.
//
// 판정은 저장하지 않고 파생한다. 파생이라야 AI가 state를 손으로 적어도 소용이 없다 —
// 게이트는 파일이 아니라 원장을 본다.
//
// 그러면서도 문서의 state 칸은 이제 원장에서 투영한다. 오래 그 칸은 사람이 적는
// 주장이었고 아무것도 그것을 굴리지 않아, 원장이 승인이라 말하는 문서가 파일에서는
// 초안으로 남았다 — 화면이 같은 문서에 두 말을 했다. 그래서 승인·제출·반려가 원장에
// 사건을 적으면서 그 칸을 함께 쓴다.
//
// 그 쓰기가 자기 승인을 무효화하지 않는 것은 리비전 계산이 그 칸을 빼기 때문이다
// (board-data.js의 판 2). 빼지 않으면 승인이 state를 쓰고, 그 쓰기가 리비전을 바꾸고,
// 방금 승인한 리비전이 더 이상 이 문서가 아니게 된다.
//
// 정본은 여전히 원장이다. 파일의 칸은 파생 캐시이며 손으로 고쳐도 다음 사건에서
// 되돌아간다. 위조를 막는 것은 그 칸이 아니라 원장의 봉투와 인가이므로, 이 파일의
// 어느 판정도 그 칸을 읽지 않는다.

const crypto = require('crypto');
const fs = require('fs');
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
const { BASIS_KINDS, SUBMISSION_STATES, REVISION_FORMULAS, DEFAULT_REVISION_FORMULA, CURRENT_REVISION_FORMULA } = require('./vocabulary');
const BASE_FIELDS = ['schemaVersion', 'eventId', 'type', 'rootRequestId', 'requestId', 'clientId', 'projectId', 'targetId', 'reviewedRevision'];

/**
 * 이 사건이 어느 판으로 잰 리비전을 결박했는가.
 *
 * BASE_FIELDS에 넣지 않는다 — 넣으면 필수가 되고, 그러면 판을 적지 않은 옛 사건이
 * 전부 형태에서 거절되어 RDL-APPROVE-014로 울린다. 없으면 판 1이라는 규약이 그
 * 되돌림이고, 그 규약의 정본은 vocabulary의 DEFAULT_REVISION_FORMULA다.
 *
 * 칸이 없는 사건은 canonical에도 키가 없으므로 봉투 다이제스트가 예전 그대로다.
 * 여기가 이 판올림의 가장 가는 자리였다 — 옛 사건의 다이제스트가 1비트라도 달라지면
 * 이미 공유된 원장 전체가 손상으로 잡힌다. 그래서 칸을 "있으면 그 값, 없으면 판 1"로
 * 두었고, 새 사건만 값을 적는다.
 *
 * 그러면서도 적힌 값은 canonical 안이라 다이제스트가 덮는다. 밖에 두면 판만 1로
 * 바꿔치기해 판 2로 잰 승인을 판 1로 재게 만들 수 있고, 그것은 승인을 다른 문서에
 * 옮겨 붙이는 것과 같다.
 */
const REVISION_FORMULA_FIELD = 'revisionFormula';

function assignRevisionFormula(normalized, input) {
  if (input[REVISION_FORMULA_FIELD] === undefined) return normalized;
  if (!REVISION_FORMULAS.includes(input[REVISION_FORMULA_FIELD])) {
    throw new Error(`지원하지 않는 리비전 계산 판입니다: ${input[REVISION_FORMULA_FIELD]} (가능: ${REVISION_FORMULAS.join(', ')})`);
  }
  normalized[REVISION_FORMULA_FIELD] = input[REVISION_FORMULA_FIELD];
  return normalized;
}

/**
 * 그 사건이 결박한 판으로 잰 문서 리비전.
 *
 * 문서가 판마다의 표(listDocuments의 revisions)를 들고 있으면 그 판의 값을 쓰고, 표가
 * 없으면 들고 있는 한 값으로 답한다. 표 없이 부르는 자리(훅·감시)는 리비전을 스스로
 * 계산해 넘기므로 판을 가릴 수단이 없고, 그때는 넘어온 값이 곧 그 자리의 답이다.
 */
function boundRevision(document, formula) {
  const table = document && document.revisions;
  const measured = table && table[formula === undefined || formula === null ? DEFAULT_REVISION_FORMULA : formula];
  return measured || (document ? document.revision : null);
}

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
// 반려는 같은 원장의 세 번째 종류다. 제출이 원장을 나누지 않은 이유가 그대로
// 적용된다 — 제출·승인·반려는 한 리비전을 두고 벌어지는 한 사슬이고, "올렸는데
// 반려됐고 그 뒤 다시 올렸다"는 셋 중 어느 하나로도 답할 수 없다. 순서를 맞춰야
// 나오는데, 원장이 여럿이면 그 순서를 파일들의 시각으로 맞춰야 하고 이 저장소는
// 시계로 상태를 정하지 않는다. 한 원장 안에서는 순서가 원장 자신의 성질이다.
const REJECTION_TYPE = 'approval.rejected';

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
  const allowed = BASE_FIELDS.concat(['submittedBy', 'reason', REVISION_FORMULA_FIELD, 'recordedAt', 'canonicalDigest', 'occurredAt']);
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
  assignRevisionFormula(normalized, input);
  if (input.recordedAt !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.recordedAt || '')) throw new Error('기록 시각은 밀리초 단위 ISO-8601 UTC여야 합니다.');
    normalized.recordedAt = input.recordedAt;
  }
  return normalized;
}

// 반려는 검토자가 "아니오"를 말하는 자리다. 이 자리가 없는 동안 반려는 댓글이나
// 태스크로 샜고, 그러면 그 판단은 원장에 없으므로 상태를 만들지 못한다.
//
// 사유가 필수인 것이 승인과 갈리는 자리다. 승인에서 사유가 선택인 것은 근거(basis)가
// 따로 있어서인데, 반려는 사유가 내용 전부다 — 왜 아닌지를 안 남기면 작성자는 무엇을
// 고쳐야 할지 모르고, 그러면 반려는 침묵과 같아진다. 그래서 형태에서 거부한다:
// 쓰기 경로에서만 막으면 병합으로 들어온 사유 없는 반려가 그대로 채택된다.
//
// 명의 칸은 rejectedBy 하나다. 승인이 approvedBy와 actorMemberId를 가르는 이유는
// 위임이 "누가 눌렀나"와 "누가 책임지나"를 갈라놓기 때문인데, 반려는 정본을 만들지
// 않으므로 옮길 책임이 없다 — 제출과 같은 자리다. 칸을 하나 더 두면 둘이 어긋난
// 기록의 뜻을 정해야 하는데 정할 뜻이 없다.
//
// 리비전 칸도 reviewedRevision을 그대로 쓴다. 이 원장의 모든 이벤트가 (targetId,
// reviewedRevision)으로 문서의 한 리비전을 지목한다는 불변식이 유지되어야 리비전을
// 보는 소비자가 종류별 분기를 갖지 않는다.
function normalizeRejectionEvent(input) {
  const allowed = BASE_FIELDS.concat(['rejectedBy', 'reason', REVISION_FORMULA_FIELD, 'recordedAt', 'canonicalDigest', 'occurredAt']);
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`반려 이벤트에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
  for (const field of BASE_FIELDS.concat(['rejectedBy', 'reason'])) if (input[field] === undefined) throw new Error(`${REJECTION_TYPE}.${field}이(가) 필요합니다.`);
  if (input.schemaVersion !== 1 || !EVENT_ID.test(input.eventId || '') || !REQUEST_ID.test(input.rootRequestId || '') || !REQUEST_ID.test(input.requestId || '')
    || !SIMPLE_ID.test(input.clientId || '') || !SIMPLE_ID.test(input.projectId || '') || !ARTIFACT_ID.test(input.targetId || '') || !REVISION.test(input.reviewedRevision || '')) {
    throw new Error('반려 이벤트의 신원이 유효하지 않습니다.');
  }
  if (!MEMBER_ID.test(input.rejectedBy || '')) throw new Error('반려자는 MEMBER-ID여야 합니다.');
  const normalized = {};
  for (const field of BASE_FIELDS) normalized[field] = input[field];
  normalized.rejectedBy = input.rejectedBy;
  // 공백뿐인 사유는 사유가 아니다. normalizeText가 다듬은 뒤에 재므로 " " 하나로
  // 관문을 지나는 길이 없다.
  const reason = normalizeText(input.reason, '반려 사유', 1000);
  if (!reason) throw new Error('반려에는 사유가 필요합니다. 왜 아닌지를 남기지 않으면 작성자는 무엇을 고쳐야 할지 알 수 없고, 그때 반려는 침묵과 같아집니다.');
  normalized.reason = reason;
  assignRevisionFormula(normalized, input);
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
  if (input.type === REJECTION_TYPE) return normalizeRejectionEvent(input);
  if (input.type !== APPROVAL_TYPE) throw new Error(`알 수 없는 승인 이벤트 종류입니다: ${input.type || '(없음)'}`);
  const allowed = BASE_FIELDS.concat(['approvedBy', 'actorMemberId', 'basis', 'reason', 'delegationId', REVISION_FORMULA_FIELD, 'recordedAt', 'canonicalDigest', 'occurredAt']);
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
  assignRevisionFormula(normalized, input);
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
    // 올린 적 없는 것을 자기 몫으로 본다. 반려도 같다 — 위조된 반려는 작성자를
    // 아무도 내리지 않은 판단으로 되돌려 보낸다.
    const actorMemberId = event.type === APPROVAL_TYPE ? event.actorMemberId
      : event.type === SUBMISSION_TYPE ? event.submittedBy : event.rejectedBy;
    const actor = verify({ clientId: event.clientId, memberId: actorMemberId, recordedAt: event.recordedAt }, authority, codes);
    if (!actor.ok || actor.delegated) {
      diagnostics.push({ code: actor.code || 'RDL-APPROVE-021', severity: 'error', eventId: event.eventId, message: actor.message || '행위자를 위임으로 대신할 수 없습니다.' });
      return false;
    }
    // 위임 판정은 승인에만 있다. 제출과 반려는 책임을 옮기지 않아 명의가 곧 행위자다.
    if (event.type !== APPROVAL_TYPE) return true;
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
  // 종류를 이름으로 고른다. 한때 "제출이 아닌 것"이었는데, 그 여집합은 종류가 셋이
  // 되는 순간 반려를 승인 이력으로 끌어들인다 — 반려 한 건이 문서를 approved로
  // 만드는 모양이고, 여집합으로 적힌 판정은 그 사실을 아무 신호 없이 바꾼다.
  for (const [targetId, events] of group((event) => event.type === APPROVAL_TYPE)) {
    approvals.set(targetId, inOrder(events).map((event) => ({
      targetId,
      reviewedRevision: event.reviewedRevision,
      // 판을 접힌 항목까지 나른다. 여기서 떨어뜨리면 판정 자리가 "어느 판으로 잰
      // 리비전인가"를 물을 수 없고, 물을 수 없으면 옛 승인을 지금 판으로 재게 된다 —
      // 그 순간 다시 만들 수 없는 판단이 통째로 낡음이 된다.
      revisionFormula: event.revisionFormula || DEFAULT_REVISION_FORMULA,
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
      revisionFormula: event.revisionFormula || DEFAULT_REVISION_FORMULA,
      submittedBy: event.submittedBy,
      reason: event.reason || null,
      recordedAt: event.recordedAt || null,
      eventId: event.eventId,
      clientId: event.clientId
    })));
  }
  // 반려도 같은 접기에서 나온다. 따로 접으면 두 결과가 서로 다른 시점의 원장을 볼 수
  // 있고, 그러면 "반려됐는데 그 뒤 다시 올렸다"가 순서 없이 보인다 — 제출 축의 값이
  // 정확히 그 순서로 정해지므로 순서를 잃으면 값이 뒤집힌다.
  const rejections = new Map();
  for (const [targetId, events] of group((event) => event.type === REJECTION_TYPE)) {
    rejections.set(targetId, inOrder(events).map((event) => ({
      targetId,
      rejectedRevision: event.reviewedRevision,
      revisionFormula: event.revisionFormula || DEFAULT_REVISION_FORMULA,
      rejectedBy: event.rejectedBy,
      reason: event.reason,
      recordedAt: event.recordedAt || null,
      eventId: event.eventId,
      clientId: event.clientId
    })));
  }
  return { approvals, submissions, rejections, diagnostics };
}

// 제출 축의 판정. 값의 정본과 뜻은 vocabulary의 SUBMISSION_STATES가 갖는다.
//
// drifted가 이 갈래의 핵심이다. 오너가 겪은 "계속 확인하면서 처음부터 다시 탄"
// 감각의 정체가 그것인데, 여태 그 사실을 드러내는 값이 아무 데도 없었다 —
// 승인자가 보던 것과 지금 파일이 다르다는 것을 도구가 말하지 않으면 사람은 매번
// 문서 전체를 다시 읽어야 하고, 그러면 읽지 않고 승인하게 된다.
//
// rejected가 이 축의 다섯 번째 값이다. 값을 늘리기 전에 짝으로 답할 수 있는지 먼저
// 따졌다 — "낡음인데 재제출됨"은 신뢰 상태 × 제출 축의 짝이 이미 답하므로 값을 늘리지
// 않았다. 반려는 그 짝으로 답하지 못한다: 신뢰 상태는 반려를 담지 않고(담으면 반려가
// 승인을 되돌리는 것이 되어 셋의 뜻이 바뀐다), 제출 축의 기존 넷 중 어느 것도 "검토를
// 거쳐 작성자에게 돌아왔다"를 뜻하지 않는다. none은 아무에게도 올린 적 없다는 뜻이라
// 검토를 거친 사실을 지우고, drifted는 "승인자가 볼 것과 지금 파일이 다르다"는 승인자
// 쪽 경고이며, settled는 판정이 났다는 뜻이지만 화면과 게이트가 그것을 승인으로 읽는다.
//
// 그래서 값 하나를 늘리고, 그 값이 답하는 네 물음은 이렇다.
//
//   반려 뒤 다시 제출하면    제출이 반려보다 뒤에 오므로 다시 pending이다. 사람이
//                            다시 볼 수 있어야 반려가 막다른 길이 아니게 된다.
//   반려 뒤 아무것도 안 하면 rejected로 남고 검토 줄에서는 빠진다. 「내 차례」가 아니라
//                            「작성자 차례」로 넘어간 것이고, 그 줄에 계속 세우면
//                            검토자는 자기가 이미 답한 것을 매번 다시 지나쳐야 한다.
//   반려 뒤 고치기만 하면    여전히 rejected다. drifted로 떨어뜨리고 싶어지지만 그 값은
//                            "승인자가 볼 것과 지금 파일이 다르다"는 경고이고, 반려된
//                            뒤에는 볼 사람이 줄에 서 있지 않다 — 고쳤다는 사실은 차례를
//                            옮기지 않는다. 차례를 옮기는 것은 다시 올리는 행위다.
//   같은 리비전을 다시 반려  뜻이 없다. 원장이 아무 사실도 더하지 않는 줄로 불어날 뿐이고,
//                            같은 리비전의 재승인·재제출을 기록하지 않는 것과 같은 이유다.
//                            그 판정은 rejectDocument가 한다.
//
// 승인은 반려를 이긴다. approvedRevisions 검사가 먼저 서 있으므로 반려된 리비전이 나중에
// 승인되면 settled가 되고, 그것이 옳다 — 신뢰 상태의 정본은 승인이고 반려는 그것을
// 되돌리지 않는다.
function submissionState(document, approvals, submissions, rejections) {
  // 견줌은 언제나 그 사건의 판으로 잰 값과 한다. 지금 판으로만 재면 판을 안 적은 옛
  // 승인이 전부 어긋나고, 어긋난 승인은 사람이 다시 만들어야 하는데 만들 수 없다.
  const settledHere = approvals.some((entry) => entry.reviewedRevision === boundRevision(document, entry.revisionFormula));
  const latest = submissions.length ? submissions[submissions.length - 1] : null;
  const denied = rejections.length ? rejections[rejections.length - 1] : null;
  // 마지막 말이 무엇이었나. 둘이 한 원장에 있어 순서가 원장 자신의 성질이므로, 파일들의
  // 시각을 견주지 않고도 "올린 뒤 반려됐다"와 "반려된 뒤 다시 올렸다"를 가른다.
  //
  // 기준은 접기가 쓴 것과 같아야 한다(기록 시각, 같으면 eventId). 여기서만 시각을 보면
  // 시각이 없는 옛 기록이나 같은 밀리초에 든 두 기록에서 두 순서가 갈리고, 그때 축의
  // 값은 목록의 순서와 다른 답을 낸다 — 같은 원장을 보고 두 가지를 말하게 된다.
  const later = (left, right) => String(left.recordedAt || '').localeCompare(String(right.recordedAt || ''))
    || String(left.eventId || '').localeCompare(String(right.eventId || ''));
  const deniedLast = Boolean(denied) && (!latest || later(denied, latest) > 0);
  const state = !latest && !denied ? 'none'
    : settledHere ? 'settled'
      : deniedLast ? 'rejected'
        : latest.submittedRevision === boundRevision(document, latest.revisionFormula) ? 'pending' : 'drifted';
  return {
    state,
    revision: latest ? latest.submittedRevision : null,
    submittedBy: latest ? latest.submittedBy : null,
    submittedByClient: latest ? latest.clientId : null,
    reason: latest ? latest.reason : null,
    recordedAt: latest ? latest.recordedAt : null,
    submissions: submissions.length,
    // 반려의 내용은 별도 칸으로 싣는다. 위의 reason 칸에 겹쳐 쓰면 "왜 올렸나"와
    // "왜 아닌가"가 한 자리에서 섞이고, 그 둘은 읽는 사람도 쓰는 사람도 다르다.
    rejection: denied ? {
      revision: denied.rejectedRevision,
      rejectedBy: denied.rejectedBy,
      rejectedByClient: denied.clientId,
      reason: denied.reason,
      recordedAt: denied.recordedAt
    } : null,
    rejections: rejections.length
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
//
// 반려도 마찬가지다. 반려된 문서는 여전히 미승인이며 낡음이 미승인으로 바뀌지도
// 않는다 — 반려는 제출 축의 사건이다. 셋의 이름·뜻·계산을 건드리면 그것을 읽는
// 곳(보드·documentStatus·검토 리포트·상류 진단·감시)이 전부 흔들린다.
function trustState(document, history, submissionHistory, rejectionHistory) {
  const entries = history || [];
  const submissions = submissionHistory || [];
  const rejections = rejectionHistory || [];
  // 판마다 재는 자리가 여기다. 승인 사건이 결박한 리비전을 그 사건의 판으로 잰 지금
  // 문서와 견주므로, 판 1로 기록된 승인은 판올림 뒤에도 판 1로 재어 그대로 유효하다.
  const matched = entries.filter((entry) => entry.reviewedRevision === boundRevision(document, entry.revisionFormula));
  // "마지막 승인"은 eventId 사전순의 끝이 아니다 — 그건 시간 순서가 아니라 해시
  // 순서다. 승인은 문서가 커밋된 순서를 따르므로, 낡음 상태에서 무엇으로
  // 되돌아갈지는 이력의 실제 순서(기록 순)로 판정한다.
  const last = entries[entries.length - 1];
  const trust = !entries.length
    ? { status: 'unapproved', approvedRevision: null, approvedBy: null, approvals: 0 }
    : matched.length
      // 승인된 리비전은 그 승인이 적은 값을 그대로 낸다. document.revision을 실으면
      // 판 1로 승인된 문서가 판 2의 값을 승인 리비전으로 말하게 되고, 그 값으로는
      // 승인본을 담은 커밋을 영영 찾지 못한다.
      ? { status: 'approved', approvedRevision: matched[matched.length - 1].reviewedRevision, approvedBy: matched[matched.length - 1].approvedBy, approvals: entries.length }
      : { status: 'stale', approvedRevision: last.reviewedRevision, approvedBy: last.approvedBy, approvals: entries.length };
  return Object.assign(trust, {
    submission: submissionState(document, entries, submissions, rejections),
    // 판 번호는 반려를 세지 않는다. 큰 자리는 승인 횟수, 작은 자리는 마지막 승인 이후
    // 올린 횟수이고 반려는 올린 것이 아니다 — 반려를 세면 같은 판이 검토를 왕복할
    // 때마다 번호가 올라 "몇 판째인가"가 "몇 번 거절당했나"로 바뀐다.
    versionLabel: versionLabel(entries, submissions)
  });
}

// ── 원장에서 문서로: state 투영 ─────────────────────────────────────────────
//
// 정본은 원장이고 파일의 칸은 파생 캐시다. 이 층이 존재하는 이유는 파일만 열어도 지금
// 상태를 알 수 있어야 하기 때문이고 — 사람은 문서를 편집기에서 열지 rdl doc status로
// 열지 않는다 — 그 이상은 아니다. 판정은 아무 데서도 이 칸을 읽지 않는다.

/**
 * 두 축을 한 칸으로 접는다. 손실은 결함이 아니라 이 칸의 정의다.
 *
 * 원장은 신뢰(승인됨·낡음·미승인)와 제출(none·pending·drifted·settled·rejected)을 따로
 * 알지만 파일의 한 칸은 그것을 다 담지 못한다. 캐시는 파일을 연 사람이 읽을 한 낱말이면
 * 되고, 두 축이 다 필요한 자리는 원장을 묻는다 — 어휘 주석이 그렇게 정해 두었다.
 *
 * 우선순위와 그 이유.
 *
 *   승인됨   가장 강한 사실이다. 승인된 판은 제출 축이 무엇이든 승인된 판이고,
 *            그 축의 값(settled)은 승인의 그림자라 따로 말할 것이 없다.
 *   반려     승인 다음이다. 차례가 작성자에게 넘어갔다는 것이 이 문서를 여는 사람이
 *            가장 먼저 알아야 할 사실이고, 그 사람이 곧 작성자다.
 *   제출됨   pending과 drifted를 한 낱말로 접는다. 파일을 여는 쪽에 필요한 것은
 *            "지금 남의 검토를 기다린다"이고, 승인자가 볼 것과 지금 파일이 다르다는
 *            경고는 승인자 쪽 물음이라 원장이 답한다.
 *   낡음     승인이 있었지만 지금 판은 그것이 아니다. 제출 뒤라면 위에서 이미
 *            제출됨으로 답했으므로, 여기 남는 것은 "고쳐 놓고 아직 안 올렸다"이다.
 *   초안     나머지. 아무에게도 올린 적 없고 승인된 적도 없다.
 *
 * 다섯 값이 정확히 DOCUMENT_STATE_KEYS 다섯이고 전부 실제로 나온다. 안 나오는 값을
 * 어휘에 두면 그 칸은 죽고, 죽은 칸은 아무도 그것이 죽었다는 사실을 모른다.
 */
function projectedDocumentState(state) {
  const submission = (state && state.submission && state.submission.state) || 'none';
  if (state && state.status === 'approved') return 'approved';
  if (submission === 'rejected') return 'rejected';
  if (submission === 'pending' || submission === 'drifted') return 'proposed';
  if (state && state.status === 'stale') return 'stale';
  return 'draft';
}

/**
 * frontmatter의 state 한 줄만 갈아 끼운 원본. 바꿀 것이 없으면 원본 그대로 돌려준다.
 *
 * 줄 하나만 손대는 이유는 나머지가 전부 리비전이기 때문이다. 파싱해서 다시 쓰면 따옴표
 * 표기나 줄 순서 같은 것이 조용히 정규화되고, 그 정규화는 판 2에서도 리비전을 바꿔
 * 이 문서에 걸린 모든 승인을 낡음으로 만든다. 줄바꿈도 그 문서가 쓰던 것을 그대로 둔다 —
 * [^\r\n]*는 CRLF의 \r을 먹지 않는다.
 *
 * 칸이 없으면 만든다. 없는 채로 두면 그 문서만 영영 투영을 못 받는데, 원장에 승인이
 * 있는 문서가 파일에서 아무 말도 하지 않는 것이 이 갈래가 없애려는 상태 그 자체다.
 */
function withProjectedState(source, value) {
  if (!/^---\r?\n/u.test(source)) return null;
  const close = /\r?\n---[^\S\r\n]*(?:\r?\n|$)/u.exec(source);
  if (!close) return null;
  const head = source.slice(0, close.index);
  const tail = source.slice(close.index);
  const line = `state: ${value}`;
  if (/^state:[^\r\n]*$/mu.test(head)) {
    const replaced = head.replace(/^state:[^\r\n]*$/mu, line);
    return replaced === head ? source : `${replaced}${tail}`;
  }
  return `${head}${head.includes('\r\n') ? '\r\n' : '\n'}${line}${tail}`;
}

/**
 * 원장에 적힌 것을 문서 파일에 투영한다. 부르는 쪽은 사건을 실제로 남긴 뒤에만 부른다.
 *
 * **원장이 먼저다.** 파일이 원장에 없는 것을 주장하면 안 되므로 쓰기 순서는 뒤집을 수
 * 없다. 그래서 이 쓰기는 사건이 이미 원장에 든 뒤에 일어나고, 여기서 실패해도 승인·
 * 제출·반려 자체는 성립한다 — 실패를 예외로 올리면 사람은 "승인이 실패했다"로 읽고 다시
 * 누르는데, 그 판단은 이미 원장에 있다. 그래서 실패는 값으로 나른다(projectionError).
 *
 * 문서를 못 쓴다고 승인을 막지 않는 이유도 같다. 읽기 전용 파일이나 잠긴 파일은 사람이
 * 내린 판단의 유효성과 아무 상관이 없고, 캐시를 못 썼다고 판단을 버리면 도구가 판단보다
 * 캐시를 중히 여기는 것이 된다. 다음 사건이 같은 자리에 다시 쓴다.
 *
 * **사건을 남기지 않은 호출에서는 쓰지 않는다.** 이것이 옛 승인을 지키는 자리다 —
 * 판 1로 기록된 승인이 서 있는 문서에 state를 쓰면 그 파일의 판 1 리비전이 달라져
 * 승인이 그 자리에서 낡음이 된다. 세 명령 모두 이미 승인된 판에서는 사건을 남기지
 * 않으므로(승인·제출은 created:false, 반려는 거절), 쓰기는 그 상태에 닿지 않는다.
 * 그래서 옛 승인이 붙은 문서의 칸은 다음 사건이 실제로 날 때까지 그대로 둔다.
 *
 * 실패는 명령의 결과에 평평한 칸으로 실린다. 중첩 객체로 실으면 사람이 보는 출력이
 * 그것을 통째로 건너뛰어(printOperation의 규칙) 쓰기 실패가 화면에서 사라지고, 사람은
 * 파일이 갱신된 줄 안다 — 값으로 나르기로 한 결정이 거기서 반쪽이 된다.
 *
 * 이미 그 값이면 쓰지 않는다. 같은 내용을 다시 써서 파일 시각만 흔들면 그것을 보는
 * 감시와 훅이 바뀐 것 없는 변경을 신호로 낸다.
 */
function projectDocumentState(project, document, state) {
  const projectedState = projectedDocumentState(state);
  try {
    const file = path.resolve(project.root, document.file);
    const source = fs.readFileSync(file, 'utf8');
    const next = withProjectedState(source, projectedState);
    if (next === null) return { projectedState, projectionError: `frontmatter가 없어 ${document.file}에 state를 투영할 자리가 없습니다.` };
    if (next === source) return { projectedState };
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, next, 'utf8');
      fs.renameSync(temporary, file);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      throw error;
    }
    return { projectedState };
  } catch (error) {
    // 원장에는 이미 들어갔다. 여기서 던지면 사람은 "승인이 실패했다"로 읽고 다시 누르는데,
    // 그 판단은 이미 원장에 있다 — 실패는 값으로 나르고 명령 자체는 성립시킨다.
    return { projectedState, projectionError: `문서의 state를 갱신하지 못했습니다(${document.file}): ${error.message}. 원장에는 기록되었으므로 판정은 그대로입니다.` };
  }
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
  return { project: context.project.key, approvals: folded.approvals, submissions: folded.submissions, rejections: folded.rejections, diagnostics: folded.diagnostics };
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
  }, trustState(document, folded.approvals.get(document.id), folded.submissions.get(document.id), folded.rejections.get(document.id))));
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
  const state = trustState(document, history, submissions, folded.rejections.get(document.id));
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
    targetId: document.id, reviewedRevision: document.revision, revisionFormula: CURRENT_REVISION_FORMULA,
    submittedBy, reason: settings.reason
  }, { lockDirectory: context.lockDirectory });
  const after = foldedApprovalLedger(start, context.project.key).folded;
  const projected = trustState(document, after.approvals.get(document.id), after.submissions.get(document.id), after.rejections.get(document.id));
  return Object.assign({
    project: context.project.key,
    document: Object.assign({ id: document.id, revision: document.revision }, projected),
    created: true
  }, projectDocumentState(context.project, document, projected));
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
  const state = trustState(document, folded.approvals.get(document.id), folded.submissions.get(document.id), folded.rejections.get(document.id));
  if (state.status === 'approved') return { project: context.project.key, document: Object.assign({ id: document.id, revision: document.revision }, state), created: false };
  const requestJournal = require('./request-journal');
  const rootRequestId = settings.rootRequestId || `REQ-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const childKey = `approval:${document.id}:${document.revision}`;
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  appendApprovalEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: requestJournal.eventIdForRequest(requestId), type: 'approval.granted',
    rootRequestId, requestId, clientId, projectId: context.project.key,
    targetId: document.id, reviewedRevision: document.revision, revisionFormula: CURRENT_REVISION_FORMULA,
    approvedBy: settings.approvedBy, actorMemberId: authority.actor, basis: settings.basis, reason: settings.reason,
    ...(settings.delegationId ? { delegationId: settings.delegationId } : {})
  }, { lockDirectory: context.lockDirectory });
  const after = foldedApprovalLedger(start, context.project.key).folded;
  const projected = trustState(document, after.approvals.get(document.id), after.submissions.get(document.id), after.rejections.get(document.id));
  return Object.assign({
    project: context.project.key,
    document: Object.assign({ id: document.id, revision: document.revision }, projected),
    created: true
  }, projectDocumentState(context.project, document, projected));
}

/**
 * 반려는 검토자가 "아니오"를 말하는 자리다.
 *
 * 이 자리가 없는 동안 「승인」 옆에 짝이 없었고, 그래서 아니라는 판단은 댓글이나
 * 태스크로 샜다. 새는 순간 그 판단은 원장 밖의 말이 되어 상태를 만들지 못하고,
 * 작성자는 자기 문서가 검토를 통과했는지 아닌지를 사람에게 물어야 알게 된다.
 *
 * 사람 게이트는 승인과 같은 것을 쓴다. 반려도 내용에 대한 사람의 판단이라 자격이
 * 같아야 하고, 무엇보다 표면마다 판정을 따로 두면 그중 느슨한 쪽이 게이트의 실제
 * 높이가 된다 — 에이전트가 자기 초안을 스스로 정본으로 만들 수 있었던 결함이
 * 정확히 그 모양이었다. 반려에서 그 반대편도 같다: 자격 없는 반려가 통하면
 * 에이전트가 사람의 판단을 흉내 내어 남의 문서를 줄에서 내릴 수 있다.
 *
 * 신뢰 상태는 건드리지 않는다. 반려된 문서는 여전히 미승인이고, 승인된 리비전이
 * 있었다면 여전히 낡음이다 — 반려는 제출 축의 사건이다.
 */
function rejectDocument(start, input) {
  const settings = input || {};
  // 사유부터 본다. 자격 판정보다 앞에 두는 이유는 이것이 형태이기 때문이다 —
  // 저장소를 한 번도 읽지 않고 답할 수 있는 거절을 뒤로 미루면, 사유 없이 누른
  // 사람이 "자격이 없다"는 엉뚱한 문장을 먼저 받는다.
  const reason = normalizeText(settings.reason, '반려 사유', 1000);
  if (!reason) throw new Error('반려에는 --reason이 필요합니다. 왜 아닌지를 남기지 않으면 작성자는 무엇을 고쳐야 할지 알 수 없고, 그때 반려는 침묵과 같아집니다.');
  const context = workspaceContext(start, settings.project);
  const { getClient, assertProjectHumanApprover } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const clientId = String(settings.clientId || '').trim().toLowerCase();
  const client = getClient(start, clientId);
  assertProjectHumanApprover(context.layout.root, context.project.key, client, '반려');
  const members = readCollaboration(context.layout.root, context.project.key).members.map((member) => member.id);
  // 명의는 고를 여지가 없다. 위임(doc-approve)은 승인 책임을 옮기는 것이고 반려는
  // 옮길 책임이 없으므로, 반려에는 위임이 설 자리가 없다 — 제출과 같은 자리다.
  const rejectedBy = settings.rejectedBy || require('./decision').actingMember(client, members);
  require('./decision').assertAuthority(client, rejectedBy, members, '반려', null);
  const document = findDocument(context.project, settings.targetId);
  const folded = foldedApprovalLedger(start, context.project.key).folded;
  const rejections = folded.rejections.get(document.id) || [];
  const state = trustState(document, folded.approvals.get(document.id), folded.submissions.get(document.id), rejections);
  // 승인된 리비전은 반려로 되돌리지 않는다. 되돌리려면 신뢰 상태를 반려가 바꿔야
  // 하는데, 그 셋의 뜻을 바꾸면 그것을 읽는 곳이 전부 흔들린다. 승인을 물리는 일은
  // 반려가 아니라 별건이며, 여기서 조용히 대신하면 그 별건은 영영 열리지 않는다.
  if (state.status === 'approved') {
    throw new Error(`이미 승인된 리비전입니다: ${document.id}. 반려는 승인을 되돌리지 않습니다 — 본문을 고치면 이 승인은 낡음이 되고, 그 뒤 올라온 판을 반려할 수 있습니다.`);
  }
  // 같은 판을 두 번 반려하는 것은 원장에 아무 사실도 더하지 않는다. 같은 리비전의
  // 재승인·재제출을 기록하지 않는 것과 같은 이유다.
  const denied = rejections.length ? rejections[rejections.length - 1] : null;
  if (state.submission.state === 'rejected' && denied && denied.rejectedRevision === boundRevision(document, denied.revisionFormula)) {
    return { project: context.project.key, document: Object.assign({ id: document.id, revision: document.revision }, state), created: false };
  }
  const requestJournal = require('./request-journal');
  const rootRequestId = settings.rootRequestId || `REQ-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  // 반려 횟수를 키에 넣는 이유는 제출과 같다. 리비전만으로 키를 만들면 "A 반려 →
  // 고침 → A로 되돌림 → 다시 반려"가 첫 반려와 같은 eventId를 만들고, 기록 시각이
  // 달라 봉투 다이제스트가 어긋나 append가 eventId 손상으로 거부된다.
  const childKey = `rejection:${document.id}:${document.revision}:${rejections.length}`;
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  appendApprovalEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: requestJournal.eventIdForRequest(requestId), type: REJECTION_TYPE,
    rootRequestId, requestId, clientId, projectId: context.project.key,
    targetId: document.id, reviewedRevision: document.revision, revisionFormula: CURRENT_REVISION_FORMULA,
    rejectedBy, reason
  }, { lockDirectory: context.lockDirectory });
  const after = foldedApprovalLedger(start, context.project.key).folded;
  const projected = trustState(document, after.approvals.get(document.id), after.submissions.get(document.id), after.rejections.get(document.id));
  return Object.assign({
    project: context.project.key,
    document: Object.assign({ id: document.id, revision: document.revision }, projected),
    created: true
  }, projectDocumentState(context.project, document, projected));
}

// git은 "무엇이 언제", 원장은 "왜 그리고 누구 책임"을 안다. 이력의 값은 둘을
// 붙이는 데 있다 — 특히 태스크도 승인도 없이 바뀐 정본을 드러내는 데 있다.
function documentHistory(start, input) {
  const settings = input || {};
  const { context, folded } = foldedApprovalLedger(start, settings.project);
  const document = findDocument(context.project, settings.targetId);
  const history = folded.approvals.get(document.id) || [];
  const submissions = folded.submissions.get(document.id) || [];
  const rejections = folded.rejections.get(document.id) || [];
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
  const state = trustState(document, history, submissions, rejections);
  const unexplained = state.status !== 'approved' && linked.length === 0 && commits.length > 0;
  return {
    project: context.project.key,
    document: Object.assign({ id: document.id, title: document.title, file: document.file, revision: document.revision }, state),
    approvals: history,
    submissions,
    // 반려 이력도 함께 낸다. 이력이 "왜 그리고 누구 책임"을 답하는 자리인데 거절만
    // 빠지면, 두 번 되돌아온 문서의 이력이 "그냥 세 번 올렸다"로 읽힌다.
    rejections,
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
//
// 판을 묻지 않고 판 전부로 잰다. 이 함수가 답하는 것은 "이 해시를 담은 커밋이
// 무엇인가"이지 "이 문서가 승인되었나"가 아니고, 해시는 판을 가로질러 유일하다 —
// 부르는 쪽마다 판을 함께 나르게 하면 그 배선이 하나 빠지는 날 옛 승인본의 커밋을
// 못 찾아 차분이 통째로 사라진다.
//
// 소유 칸만 다른 커밋 여럿이 판 2에서 같은 값을 낼 수 있다. 그때는 가장 최근 것이
// 잡히고, 그것이 옳다 — 차분의 기준은 내용이 같은 것 중 가장 가까운 커밋이어야
// state 투영이 만든 커밋이 차분에 섞이지 않는다.
function commitForRevision(root, file, revision, candidates) {
  if (!revision) return null;
  const { documentRevisions } = require('./board-data');
  const { parseFrontmatter } = require('./frontmatter');
  for (const commit of candidates || revisionCandidates(root, file)) {
    // runGit은 stdout을 trim한다. 파일 내용을 그렇게 읽으면 후행 개행이 잘려
    // 리비전이 달라지고, 그 리비전을 담은 커밋이 있어도 영영 못 찾는다 —
    // 내용은 바이트 그대로 읽어야 한다.
    const shown = showFileAtCommit(root, commit, file);
    if (shown === null) continue;
    const parsed = parseFrontmatter(shown);
    if (!parsed || !Object.values(documentRevisions(parsed.data, parsed.body)).includes(revision)) continue;
    return commit;
  }
  return null;
}

function diffSinceApproval(start, input) {
  const settings = input || {};
  const { context, folded } = foldedApprovalLedger(start, settings.project);
  const document = findDocument(context.project, settings.targetId);
  const history = folded.approvals.get(document.id) || [];
  const state = trustState(document, history, folded.submissions.get(document.id), folded.rejections.get(document.id));
  if (state.status === 'unapproved') return { project: context.project.key, targetId: document.id, status: state.status, diff: null, reason: '승인 기록이 없어 비교 기준이 없습니다.' };
  if (state.status === 'approved') return { project: context.project.key, targetId: document.id, status: state.status, diff: '', reason: '현재 리비전이 승인되어 있습니다.' };
  const approvedRevision = state.approvedRevision;
  const commit = commitForRevision(context.project.root, document.file, approvedRevision);
  if (!commit) return { project: context.project.key, targetId: document.id, status: state.status, approvedRevision, approvedBy: state.approvedBy, baseCommit: null, diff: null, reason: '승인된 리비전을 담은 커밋을 찾지 못했습니다. 승인 이후 커밋되지 않았을 수 있습니다.' };
  // core.quotepath=false를 준다. 이 저장소의 정본 파일명은 한글이고, git은 기본으로
  // 비ASCII 바이트를 8진수로 이스케이프해 diff 머리 네 줄을 사람이 못 읽는 문자열로
  // 만든다. 세 자리(승인본↔작업본·승인본↔제출본·임의 두 지점)가 같은 문제를 갖고,
  // 한 곳만 고치면 같은 문서의 차분이 축마다 다르게 보인다.
  const diff = runGit(['-c', 'core.quotepath=false', 'diff', `${commit}`, '--', document.file], { cwd: context.project.root, allowFailure: true });
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
  const state = trustState(document, history, folded.submissions.get(document.id), folded.rejections.get(document.id));
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
  const diff = runGit(['-c', 'core.quotepath=false', 'diff', approvedCommit, submittedCommit, '--', document.file], { cwd: context.project.root, allowFailure: true });
  return Object.assign(shared, { approvedCommit, submittedCommit, diff: diff.status === 0 ? diff.stdout : null });
}

module.exports = {
  BASIS_KINDS, SUBMISSION_STATES, SUBMISSION_TYPE, APPROVAL_TYPE, REJECTION_TYPE,
  normalizeApprovalEvent, approvalEnvelope, appendApprovalEvent, readApprovalEvents,
  foldApprovals, trustState, commitForRevision, revisionCandidates, projectedDocumentState, withProjectedState,
  documentApprovals, documentStatus, submitDocument, approveDocument, rejectDocument, documentHistory,
  diffSinceApproval, diffSubmission
};
