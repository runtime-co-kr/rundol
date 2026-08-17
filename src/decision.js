'use strict';

// 사람 결정의 기록. ADR-008이 정한 대로 질문은 대화가 아니라 상태다 — 요청과
// 답변이 공유 원장에 남아 어느 클라이언트에서나 읽고 답할 수 있고, 실행 원장과
// 함께 다시 읽을 때 왜 그렇게 되었는지가 복원된다. REQ-039가 규범이다.

const crypto = require('crypto');
const eventStore = require('./event-store');

const EVENT_ID = /^EVT-[A-F0-9]{20}$/u;
const REQUEST_ID = /^REQ-[A-F0-9]{20}$/u;
const DECISION_ID = /^DEC-[A-F0-9]{20}$/u;
const DELEGATION_ID = /^DLG-[A-F0-9]{20}$/u;
const SIMPLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MEMBER_ID = /^MEMBER-\d{3}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const OPTION_ID = /^[a-z][a-z0-9-]*$/u;

// 결정 카탈로그. 판정 기준은 작업의 종류가 아니라 성질이다 — 비가역성, 외부
// 노출, 권한 우회, 요청 범위 이탈. 목록이 길어지는 것은 성실함이 아니라 기본값
// 설계의 실패이므로, 검사가 판정할 수 있는 것과 안전한 기본값이 있는 것은 넣지
// 않는다. delegable=false는 위임해도 대신 정할 수 없다는 뜻이다.
const FAMILIES = Object.freeze({
  outward: '이 머신을 벗어난다',
  destructive: '정본 상태를 되돌릴 수 없게 바꾼다',
  governance: '무엇이 허용되는지를 바꾼다',
  authority: '다른 주체의 권한을 덮는다',
  scope: '요청에 없던 일을 한다'
});

const KINDS = Object.freeze({
  publish: { family: 'outward', delegable: false, summary: '패키지 배포와 릴리스 태그' },
  'push-shared': { family: 'outward', delegable: true, summary: '공유 브랜치 push' },
  'pr-open': { family: 'outward', delegable: true, summary: '병합 요청 생성' },
  'pr-merge': { family: 'outward', delegable: false, summary: '병합 요청 병합' },
  'doc-approve': { family: 'governance', delegable: true, summary: '정본 문서 승인' },
  'doc-replace': { family: 'destructive', delegable: true, summary: '정본 문서 삭제·대체·이동' },
  'task-cancel': { family: 'destructive', delegable: true, summary: '다른 주체가 소유한 태스크 반려' },
  'cleanup-apply': { family: 'destructive', delegable: true, summary: '구조 정리 적용' },
  'project-setup': { family: 'governance', delegable: true, summary: '초기 문서 목표와 설정' },
  'contract-change': { family: 'governance', delegable: true, summary: '문서 계약 정책과 강제 수준' },
  'procedure-override': { family: 'governance', delegable: true, summary: '절차 오버라이드' },
  'release-version': { family: 'governance', delegable: true, summary: '릴리스 버전 번호' },
  'harness-change': { family: 'governance', delegable: true, summary: '하네스 설정' },
  'force-takeover': { family: 'authority', delegable: false, summary: '정지하지 않은 런의 강제 인수' },
  'force-resolve': { family: 'authority', delegable: false, summary: '소유권·연산 강제 해소' },
  'gate-bypass': { family: 'authority', delegable: false, summary: '게이트 우회' },
  'delegation-grant': { family: 'authority', delegable: false, summary: '위임 부여' },
  'scope-change': { family: 'scope', delegable: true, summary: '요청 밖 작업 착수' },
  'dependency-add': { family: 'scope', delegable: true, summary: '새 외부 의존성' },
  'budget-continue': { family: 'scope', delegable: true, summary: '예산·시간 초과 후 계속' }
});

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function kindDefinition(kind) {
  const definition = KINDS[kind];
  if (!definition) throw new Error(`등록되지 않은 결정 종류입니다: ${kind || '(없음)'}`);
  return definition;
}

// 같은 결정 종류·범위·대상은 하나의 결정이다. 이 키가 재질문을 막고, 답변을
// 요청과 짝짓는다 — 요청 이벤트를 못 본 클라이언트도 키만으로 같은 결정임을 안다.
function decisionKey(input) {
  const kind = kindDefinition(input && input.kind) && input.kind;
  const project = String(input.project || '').trim();
  const subject = String(input.subject || '').trim();
  if (!subject) throw new Error('결정 대상(subject)이 필요합니다.');
  return sha256(`rundol.decision.v1\0${kind}\0${project}\0${subject}`);
}

function decisionIdFor(key) {
  if (!DIGEST.test(key || '')) throw new Error('결정 키가 유효하지 않습니다.');
  return `DEC-${key.slice(0, 20).toUpperCase()}`;
}

function normalizeText(value, label, limit) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\r\n/gu, '\n').trim();
  if (!text) throw new Error(`${label}이(가) 필요합니다.`);
  if (text.length > limit) throw new Error(`${label}은(는) ${limit}자 이하여야 합니다.`);
  if (/[\0]/u.test(text)) throw new Error(`${label}에 제어 문자를 쓸 수 없습니다.`);
  return text;
}

// 선택지는 닫힌 목록이다. 자유 서술이 필요하면 사유란에 적고 선택지 중 하나를
// 고른다 — 열린 답변은 기계가 적용할 수 없고, 결국 사람이 다시 읽어야 한다.
function normalizeOptions(value) {
  if (!Array.isArray(value) || value.length < 2) throw new Error('선택지는 2개 이상이어야 합니다.');
  if (value.length > 8) throw new Error('선택지는 8개를 넘을 수 없습니다.');
  const seen = new Set();
  return value.map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('선택지는 객체여야 합니다.');
    const extra = Object.keys(option).filter((key) => !['id', 'label'].includes(key));
    if (extra.length) throw new Error(`선택지에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
    if (!OPTION_ID.test(option.id || '')) throw new Error(`선택지 ID 형식이 잘못되었습니다: ${option.id || '(없음)'}`);
    if (seen.has(option.id)) throw new Error(`중복된 선택지 ID입니다: ${option.id}`);
    seen.add(option.id);
    return { id: option.id, label: normalizeText(option.label, '선택지 설명', 200) };
  });
}

// 권고 없는 질문은 묻는 것이 아니라 판단을 떠넘기는 것이다. 그래서 권고안과
// 그 근거는 선택이 아니라 요청의 구성요소다.
function normalizeRecommendation(value, options) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('권고안이 필요합니다.');
  const extra = Object.keys(value).filter((key) => !['option', 'because'].includes(key));
  if (extra.length) throw new Error(`권고안에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
  if (!options.some((option) => option.id === value.option)) throw new Error(`권고안이 선택지에 없습니다: ${value.option || '(없음)'}`);
  return { option: value.option, because: normalizeText(value.because, '권고 근거', 500) };
}

function normalizeImpact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('영향(impact)이 필요합니다.');
  const extra = Object.keys(value).filter((key) => !['reversible', 'blast'].includes(key));
  if (extra.length) throw new Error(`영향에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
  if (typeof value.reversible !== 'boolean') throw new Error('impact.reversible은 boolean이어야 합니다.');
  return { reversible: value.reversible, blast: normalizeText(value.blast, '영향 범위', 200) };
}

function normalizeEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('근거는 20개 이하의 배열이어야 합니다.');
  return value.map((item) => normalizeText(item, '근거', 300));
}

const BASE_FIELDS = ['schemaVersion', 'eventId', 'type', 'rootRequestId', 'requestId', 'clientId', 'projectId', 'decisionId', 'decisionKey', 'kind'];

// 답변은 결정 키가 아니라 "무엇에 답했는가"에 결박되어야 한다. 키에만 묶이면
// 답변 뒤에 상충 요청을 밀어 넣고 그 요청으로 갈아끼워, 예전 답을 전혀 다른
// 질문의 답으로 재사용할 수 있다 — 배포 승인이 운영 데이터 삭제 승인이 된다.
//
// 그래서 답변이 답한 요청의 내용 투영을 다이제스트로 싣고, 접기는 살아 있는
// 요청의 투영과 일치하는 답변만 인정한다. 질문이 바뀌면 답이 따라오지 않는다.
function requestProjection(request) {
  return eventStore.canonicalJson({
    question: request.question, options: request.options, recommendation: request.recommendation,
    impact: request.impact, evidence: request.evidence
  });
}

function requestDigestFor(request) {
  return sha256(requestProjection(request));
}

function normalizeDecisionEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('결정 이벤트는 객체여야 합니다.');
  if (!['decision.requested', 'decision.answered'].includes(input.type)) throw new Error(`알 수 없는 결정 이벤트 종류입니다: ${input.type || '(없음)'}`);
  const requested = input.type === 'decision.requested';
  const allowed = BASE_FIELDS.concat(requested ? ['question', 'options', 'recommendation', 'impact', 'evidence', 'supersedes'] : ['selectedOption', 'answeredBy', 'reason', 'supersedes', 'delegationId', 'requestDigest'], ['recordedAt', 'canonicalDigest', 'occurredAt']);
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${input.type}에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
  for (const field of BASE_FIELDS) if (input[field] === undefined) throw new Error(`${input.type}.${field}이(가) 필요합니다.`);
  if (input.schemaVersion !== 1 || !EVENT_ID.test(input.eventId || '') || !REQUEST_ID.test(input.rootRequestId || '') || !REQUEST_ID.test(input.requestId || '')
    || !SIMPLE_ID.test(input.clientId || '') || !SIMPLE_ID.test(input.projectId || '') || !DECISION_ID.test(input.decisionId || '') || !DIGEST.test(input.decisionKey || '')) {
    throw new Error(`${input.type}의 신원이 유효하지 않습니다.`);
  }
  kindDefinition(input.kind);
  if (decisionIdFor(input.decisionKey) !== input.decisionId) throw new Error('decisionId가 decisionKey에서 파생되지 않았습니다.');
  const normalized = {};
  for (const field of BASE_FIELDS) normalized[field] = input[field];
  if (requested) {
    normalized.question = normalizeText(input.question, '질문', 500);
    normalized.options = normalizeOptions(input.options);
    normalized.recommendation = normalizeRecommendation(input.recommendation, normalized.options);
    normalized.impact = normalizeImpact(input.impact);
    normalized.evidence = normalizeEvidence(input.evidence);
    // 요청도 대체될 수 있다. 답변 충돌에만 탈출구를 주고 요청 충돌은 그대로 두면
    // 상충 요청 하나가 그 결정을 영구 교착으로 만든다.
    if (input.supersedes !== undefined) {
      if (!EVENT_ID.test(input.supersedes || '')) throw new Error('대체 대상 요청이 유효하지 않습니다.');
      normalized.supersedes = input.supersedes;
    }
  } else {
    if (!OPTION_ID.test(input.selectedOption || '')) throw new Error('선택한 값이 유효하지 않습니다.');
    if (!MEMBER_ID.test(input.answeredBy || '')) throw new Error('답변자는 MEMBER-ID여야 합니다.');
    normalized.selectedOption = input.selectedOption;
    normalized.answeredBy = input.answeredBy;
    normalized.reason = normalizeText(input.reason, '사유', 1000);
    // 상충을 해소하는 답변은 자기가 대체하는 답변을 가리킨다. 그래야 fail-closed가
    // 교착이 아니라 상태가 된다.
    if (input.supersedes !== undefined) {
      if (!EVENT_ID.test(input.supersedes || '')) throw new Error('대체 대상 답변이 유효하지 않습니다.');
      normalized.supersedes = input.supersedes;
    }
    // 답변이 답한 요청의 내용 투영. 없으면 무엇에 답한 것인지 알 수 없다.
    if (!DIGEST.test(input.requestDigest || '')) throw new Error('답변에는 답한 요청의 requestDigest가 필요합니다.');
    normalized.requestDigest = input.requestDigest;
    // 명의가 Client 소유자와 다를 때 그 차이를 정당화하는 위임. 허용 목록에만
    // 넣고 복사하지 않으면 읽는 쪽은 위임을 보지 못하고 답변을 사칭으로 버린다.
    if (input.delegationId !== undefined) {
      if (!DELEGATION_ID.test(input.delegationId || '')) throw new Error('위임 식별자가 유효하지 않습니다.');
      normalized.delegationId = input.delegationId;
    }
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
function decisionEnvelope(input) {
  const canonical = normalizeDecisionEvent(input);
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
function appendDecisionEvent(eventsRoot, input, options) {
  const now = new Date().toISOString();
  const stamped = Object.assign({}, input,
    input && input.occurredAt === undefined ? { occurredAt: now } : {},
    input && input.recordedAt === undefined ? { recordedAt: now } : {});
  const envelope = decisionEnvelope(stamped);
  const file = eventStore.appendEvent(eventsRoot, 'decision', envelope.canonical.projectId, envelope.canonical.clientId, envelope.shared, {
    lockDirectory: options && options.lockDirectory,
    fsync: !options || options.fsync !== false
  });
  return { file, event: envelope.shared, canonicalBytes: envelope.canonicalBytes };
}

function readDecisionEvents(eventsRoot, projectId) {
  if (!SIMPLE_ID.test(projectId || '')) throw new Error('결정 읽기 신원이 유효하지 않습니다.');
  // 원시 레코드를 돌려준다 — 검증과 충돌 판정은 fold의 관용 경로가 단일 정의로
  // 수행한다. 읽기에서 던지면 손상 하나가 전체 조회를 막고 진단이 도달 불능이 된다.
  return eventStore.readEvents(eventsRoot, 'decision', projectId, { sort: 'file', dedupe: false });
}

// 결정 상태의 fold. 같은 결정 키의 요청은 하나로 접히고, 권한 있는 답변이
// 도착하면 해소된다. 답변 없는 결정의 기본은 언제나 정지다 — 무응답을 진행으로
// 해석하는 경로는 두지 않는다.
// 대체 관계 해소. 요청과 답변이 같은 규칙을 써야 한다 — 한쪽에만 탈출구를 주면
// 그 결정은 다른 쪽 충돌로 영구 교착이 되고, 한쪽에만 제약을 주면 다른 쪽이 새
// 공격면이 된다.
//
// 대체는 같은 묶음 안의 기존 항목만 가리킬 수 있고, 하나를 여럿이 대체할 수 없으며,
// 자기 자신이나 순환을 이룰 수 없다. 이 제약을 어긴 항목은 진단으로 끝내지 않고
// 무효로 둔다 — 해소에 실패한 기록이 그대로 살아남으면 그것이 상태를 바꾼다.
function resolveSuperseded(entries, diagnostics, codes) {
  const byEvent = new Map(entries.map((entry) => [entry.eventId, entry]));
  const supersededBy = new Map();
  const invalid = new Set();
  for (const entry of entries) {
    if (!entry.supersedes) continue;
    if (entry.supersedes === entry.eventId) {
      diagnostics.push({ code: codes.self, severity: 'error', eventId: entry.eventId, message: '기록이 자기 자신을 대체할 수 없습니다.' });
      invalid.add(entry.eventId);
      continue;
    }
    if (!byEvent.has(entry.supersedes)) {
      diagnostics.push({ code: codes.unknown, severity: 'error', eventId: entry.eventId, message: `대체 대상이 이 결정의 기록이 아닙니다: ${entry.supersedes}` });
      invalid.add(entry.eventId);
      continue;
    }
    if (supersededBy.has(entry.supersedes)) {
      diagnostics.push({ code: codes.fork, severity: 'error', eventId: entry.eventId, message: `한 기록을 둘 이상이 대체합니다: ${entry.supersedes}` });
      invalid.add(entry.eventId);
      invalid.add(supersededBy.get(entry.supersedes));
      continue;
    }
    supersededBy.set(entry.supersedes, entry.eventId);
  }
  const cyclic = new Set();
  for (const start of supersededBy.keys()) {
    const seen = new Set();
    let cursor = start;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = supersededBy.get(cursor);
      if (cursor && seen.has(cursor)) {
        for (const member of seen) cyclic.add(member);
        diagnostics.push({ code: codes.cycle, severity: 'error', eventId: cursor, message: '대체 관계에 순환이 있습니다.' });
      }
    }
  }
  const superseded = new Set(Array.from(supersededBy.keys()).filter((eventId) => !cyclic.has(eventId)));
  return entries.filter((entry) => !superseded.has(entry.eventId) && !cyclic.has(entry.eventId) && !invalid.has(entry.eventId));
}

function foldDecisions(events, options) {
  const settings = options || {};
  const authority = require('./authority').requireAuthority(settings, '결정');
  const members = settings.members ? new Set(settings.members) : (authority.members ? new Set(authority.members) : null);
  const diagnostics = [];
  const byEventId = new Map();
  for (const raw of events || []) {
    let event;
    try {
      event = normalizeDecisionEvent(raw);
      const expected = decisionEnvelope(event).canonicalDigest;
      if (raw.canonicalDigest !== undefined && raw.canonicalDigest !== expected) throw new Error('canonicalDigest 불일치');
      event.canonicalDigest = expected;
    } catch (error) {
      diagnostics.push({ code: 'RDL-DEC-014', severity: 'error', eventId: raw && raw.eventId || null, message: error.message });
      continue;
    }
    if (raw.occurredAt !== undefined) event.occurredAt = raw.occurredAt;
    if (!byEventId.has(event.eventId)) byEventId.set(event.eventId, event);
    else if (byEventId.get(event.eventId) && byEventId.get(event.eventId).canonicalDigest !== event.canonicalDigest) {
      byEventId.set(event.eventId, null);
      diagnostics.push({ code: 'RDL-DEC-015', severity: 'error', eventId: event.eventId, message: '같은 eventId에 상충하는 결정 기록이 있습니다.' });
    }
  }
  const valid = Array.from(byEventId.values()).filter(Boolean);
  const byKey = new Map();
  for (const event of valid) {
    if (!byKey.has(event.decisionKey)) byKey.set(event.decisionKey, { requests: [], answers: [] });
    byKey.get(event.decisionKey)[event.type === 'decision.requested' ? 'requests' : 'answers'].push(event);
  }
  const decisions = [];
  for (const [key, group] of Array.from(byKey).sort((left, right) => left[0].localeCompare(right[0]))) {
    // 요청도 인가한다. 인가하지 않으면 위조 요청 하나로 아무 결정이나 열린
    // 상태로 만들어 진행을 막을 수 있다 — 답변만 지키면 반쪽이다.
    const authorizedRequests = group.requests.filter((entry) => {
      const verdict = require('./authority').verifyActor(
        { clientId: entry.clientId, memberId: authority.owners.get(entry.clientId), recordedAt: entry.recordedAt },
        authority, { unknownClient: 'RDL-DEC-020', impersonation: 'RDL-DEC-021', delegation: 'RDL-DEC-026', member: 'RDL-DEC-002' });
      if (!verdict.ok) {
        diagnostics.push({ code: verdict.code, severity: 'error', eventId: entry.eventId, message: verdict.message });
        return false;
      }
      return true;
    });
    const liveRequests = resolveSuperseded(authorizedRequests, diagnostics, {
      self: 'RDL-DEC-027', unknown: 'RDL-DEC-028', fork: 'RDL-DEC-029', cycle: 'RDL-DEC-030'
    });
    // 대체된 요청도 이 결정에 실제로 있었던 질문이다. 그 목록을 잃으면 지나간
    // 질문에 답한 기록을 "없던 질문에 답한 것"으로 오인한다.
    const historicalRequests = authorizedRequests.slice();
    group.requests = liveRequests;
    const request = liveRequests.slice().sort((left, right) => left.eventId.localeCompare(right.eventId))[0] || null;
    if (!request) {
      diagnostics.push({ code: 'RDL-DEC-016', severity: 'error', message: `요청 없는 결정 답변입니다: ${decisionIdFor(key)}` });
      continue;
    }
    const optionIds = new Set(request.options.map((option) => option.id));
    const liveDigest = requestDigestFor(request);
    // 이 결정에 한 번이라도 존재한 요청들의 투영. 대체된 질문에 답한 기록은
    // 잘못된 것이 아니라 지나간 것이다 — 그때는 그 질문이 살아 있었다.
    const knownDigests = new Set(historicalRequests.map((entry) => requestDigestFor(entry)));
    // 검사 순서가 감사 기록을 정한다. 살아 있는 질문의 답변만 먼저 걸러 내면,
    // 지나간 질문을 겨냥해 사후에 끼워 넣은 사칭 답변이 상태를 바꾸지는 못하되
    // 진단도 없이 사라진다 — 원장에서 그런 시도가 있었다는 사실 자체가 지워진다.
    // 그래서 유효성과 권한을 먼저 보고, 살아 있는지는 마지막에 본다.
    const answers = group.answers.slice().sort((left, right) => left.eventId.localeCompare(right.eventId)).filter((answer) => {
      // 이 결정에 존재한 적 없는 질문에 답한 것은 그 자체로 잘못이다.
      if (answer.requestDigest !== liveDigest && !knownDigests.has(answer.requestDigest)) {
        diagnostics.push({ code: 'RDL-DEC-031', severity: 'error', eventId: answer.eventId, message: `이 결정에 없던 요청 내용에 대한 답변입니다: ${decisionIdFor(key)}` });
        return false;
      }
      // 선택지는 답변이 답한 질문의 것으로 본다. 지나간 질문의 답변을 지금
      // 질문의 선택지로 재면 엉뚱한 진단이 나온다.
      const answered = answer.requestDigest === liveDigest
        ? request
        : historicalRequests.find((entry) => requestDigestFor(entry) === answer.requestDigest) || request;
      const answeredOptionIds = answered === request ? optionIds : new Set(answered.options.map((option) => option.id));
      if (!answeredOptionIds.has(answer.selectedOption)) {
        diagnostics.push({ code: 'RDL-DEC-017', severity: 'error', eventId: answer.eventId, message: `선택지에 없는 값입니다: ${answer.selectedOption}` });
        return false;
      }
      // 권한 검증은 레지스트리를 가진 호출자가 목록을 넘겼을 때만 수행한다.
      // 순수 fold는 레지스트리를 볼 수 없고, 형태만으로 권한을 판정하지 않는다.
      if (members && !members.has(answer.answeredBy)) {
        diagnostics.push({ code: 'RDL-DEC-002', severity: 'error', eventId: answer.eventId, message: `등록된 멤버가 아닌 답변자입니다: ${answer.answeredBy}` });
        return false;
      }
      // 쓰기 경로의 결박만으로는 부족하다. 직접 append나 Git 병합으로 들어온
      // 이벤트는 그 경로를 지나지 않으므로, 읽는 쪽에서도 "이 Client가 이 멤버
      // 이름으로 행위할 수 있었는가"를 확인해야 한다. 확인할 수 없는 답변은
      // 상태를 바꾸지 못한다 — run 원장의 sync 전이 인가(RDL-RUN-005)와 같은 경계다.
      const verdict = require('./authority').verifyActor(
        { clientId: answer.clientId, memberId: answer.answeredBy, delegationId: answer.delegationId, kind: answer.kind, recordedAt: answer.recordedAt },
        authority, { unknownClient: 'RDL-DEC-020', impersonation: 'RDL-DEC-021', delegation: 'RDL-DEC-026', member: 'RDL-DEC-002' });
      if (!verdict.ok) {
        diagnostics.push({ code: verdict.code, severity: 'error', eventId: answer.eventId, message: verdict.message });
        return false;
      }
      // 여기까지 온 답변은 유효하고 권한도 있다. 다만 답한 질문이 대체됐다면
      // 지금 상태를 정하지는 못한다 — 잘못이 아니라 지나간 것이다.
      return answer.requestDigest === liveDigest;
    });
    // 서로 다른 선택이 동시에 도착하면 하나를 고르는 것은 결정이 아니라 은폐다.
    // 권한 결정에서 순서 결정성만으로는 부족하다 — 상충하는 답은 해소될 때까지
    // 열린 상태로 두고 진단으로 드러낸다(fail-closed).
    //
    // 다만 탈출구가 있어야 한다. 해소 수단 없이 닫기만 하면 그 결정은 영구
    // 교착이 되고, 그건 0.29의 무효 takeover에서 이미 겪은 실수다. 나중에
    // 도착한 해소 답변(supersedes)이 이전 답을 대체한다.
    // 대체는 같은 결정 안의 기존 답변만 가리킬 수 있고, 하나의 답변을 여럿이
    // 대체할 수 없으며, 자기 자신이나 순환을 이룰 수 없다. 이 제약이 없으면
    // 대체 관계로 임의의 답을 살리거나 죽일 수 있어 해소 경로가 새 공격면이 된다.
    const live = resolveSuperseded(answers, diagnostics, {
      self: 'RDL-DEC-022', unknown: 'RDL-DEC-023', fork: 'RDL-DEC-024', cycle: 'RDL-DEC-025'
    });
    const selections = new Set(live.map((entry) => entry.selectedOption));
    if (selections.size > 1) {
      diagnostics.push({ code: 'RDL-DEC-018', severity: 'error', message: `같은 결정에 서로 다른 답변이 있습니다: ${decisionIdFor(key)} (${Array.from(selections).sort().join(', ')}). 해소하려면 대체할 답변의 eventId를 supersedes로 지정하세요.` });
    }
    // 같은 결정 키에 서로 다른 요청이 들어오면 무엇에 답하는지가 갈린다. 질문
    // 문장만이 아니라 선택지·권고·영향까지 봐야 한다 — 선택지가 다르면 같은
    // 문장이라도 다른 결정이다.
    const projections = new Set(group.requests.map((entry) => eventStore.canonicalJson({
      question: entry.question, options: entry.options, recommendation: entry.recommendation, impact: entry.impact, evidence: entry.evidence
    })));
    if (projections.size > 1) {
      diagnostics.push({ code: 'RDL-DEC-019', severity: 'error', message: `같은 결정 키에 서로 다른 요청이 있습니다: ${decisionIdFor(key)}` });
    }
    const answer = selections.size > 1 || projections.size > 1 ? null : (live[0] || null);
    decisions.push({
      decisionId: request.decisionId,
      decisionKey: key,
      kind: request.kind,
      family: KINDS[request.kind].family,
      projectId: request.projectId,
      question: request.question,
      options: request.options,
      recommendation: request.recommendation,
      impact: request.impact,
      evidence: request.evidence,
      requestedBy: request.clientId,
      status: answer ? 'answered' : 'open',
      selectedOption: answer ? answer.selectedOption : null,
      answeredBy: answer ? answer.answeredBy : null,
      reason: answer ? answer.reason : null
    });
  }
  return {
    decisions,
    open: decisions.filter((decision) => decision.status === 'open'),
    answers: new Map(decisions.filter((decision) => decision.status === 'answered').map((decision) => [decision.decisionKey, decision])),
    diagnostics
  };
}

// ── Workspace 경로 ──────────────────────────────────────────────────────────
// 결정은 공유 원장에 남는다. 요청한 클라이언트가 아닌 곳에서 답할 수 있어야
// 하기 때문이다(ADR-008). 로컬에만 두면 사람이 자리를 옮기는 순간 질문이 사라진다.

function workspaceContext(start, projectKey) {
  const { workspaceLayout, selectProject } = require('./workspace');
  const { runtimeWorkspace } = require('./runtime');
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  if (layout.schemaVersion < 6) throw new Error('결정 기록에는 schemaVersion 6 이상의 Workspace가 필요합니다.');
  return {
    layout,
    project,
    eventsRoot: require('path').join(layout.root, 'projects', 'workspace', 'events'),
    lockDirectory: runtimeWorkspace(layout.root).locks
  };
}

function projectMembers(root, projectKey) {
  const { readCollaboration } = require('./collaboration');
  return readCollaboration(root, projectKey).members.map((member) => member.id);
}

// 등록된 Client의 소유 멤버. fold가 "이 Client가 이 멤버 이름으로 행위할 수
// 있었는가"를 확인하는 재료다 — 쓰기 경로를 지나지 않고 들어온 이벤트도 걸린다.
function clientOwnerMap(start) {
  const { listClients } = require('./collaboration-store');
  return (listClients(start).clients || []).filter((client) => client.status === 'active').map((client) => [client.id, client.owner]);
}

function foldContext(start, context, now) {
  return {
    members: projectMembers(context.layout.root, context.project.key),
    authority: require('./authority').authorityContext(start, context.project.key, { now: now === undefined ? Date.now() : now })
  };
}

function assertActiveClient(start, clientId) {
  const { getClient } = require('./collaboration-store');
  const client = getClient(start, clientId);
  if (client.status !== 'active') throw new Error(`비활성 Client는 결정을 다룰 수 없습니다: ${clientId}`);
  return client;
}

// 행위자와 권한 부여자는 다른 것이다. 하나로 뭉개면 두 가지가 동시에 깨진다:
// 사칭을 막으려고 "Client는 자기 owner 이름으로만"이라고 하면 위임받은 Client가
// 부여자 명의로 행위할 길이 사라지고, 반대로 부여자 명의를 허용하면 사칭이
// 열린다. 그래서 둘을 따로 둔다 —
//   행위자(actor) = 실행한 Client의 owner. 언제나 그 Client의 소유자다.
//   권한(authority) = 책임지는 멤버. 직접 행위면 행위자와 같고, 위임이면 부여자다.
function actingMember(client, members) {
  if (!members.includes(client.owner)) throw new Error(`Client 소유자가 project.md에 등록된 멤버가 아닙니다: ${client.owner || '(없음)'}`);
  return client.owner;
}

function assertAuthority(client, memberId, members, action, delegation) {
  if (!members.includes(memberId)) throw new Error(`project.md에 등록된 멤버만 ${action}할 수 있습니다: ${memberId || '(없음)'}`);
  const actor = actingMember(client, members);
  if (memberId === actor) return { actor, delegated: false };
  // 자기 소유가 아닌 멤버 명의로 행위하려면 그 멤버가 이 Client에 위임했어야 한다.
  if (!delegation) throw new Error(`Client는 자기 소유 멤버의 이름으로만 ${action}할 수 있습니다: ${client.id}의 소유자는 ${actor}입니다. 다른 멤버 명의로 행위하려면 그 멤버의 위임이 필요합니다.`);
  if (delegation.grantedBy !== memberId) throw new Error(`위임 부여자와 ${action} 명의가 다릅니다: ${delegation.grantedBy} != ${memberId}`);
  if (delegation.delegateClientId !== client.id) throw new Error(`이 Client에 부여된 위임이 아닙니다: ${delegation.delegateClientId} != ${client.id}`);
  return { actor, delegated: true };
}

// 기존 호출 형태 유지 — 위임 없는 경로의 결박이다.
function assertActingMember(client, memberId, members, action) {
  return assertAuthority(client, memberId, members, action, null);
}

function decisionIdentity(rootRequestId, childKey) {
  const requestJournal = require('./request-journal');
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  return { requestId, eventId: requestJournal.eventIdForRequest(requestId) };
}

function newRootRequestId() {
  return `REQ-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

function listDecisions(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const folded = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), foldContext(start, context));
  const decisions = settings.open ? folded.open : folded.decisions;
  return { project: context.project.key, open: folded.open.length, total: folded.decisions.length, decisions, diagnostics: folded.diagnostics };
}

// 이미 답한 결정은 다시 묻지 않는다. 재질문은 사람에게 같은 일을 두 번 시키는
// 것이고, 두 답이 갈리면 어느 쪽이 정본인지 알 수 없게 된다.
function requestDecision(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const clientId = String(settings.clientId || '').trim().toLowerCase();
  assertActiveClient(start, clientId);
  const key = decisionKey({ kind: settings.kind, project: context.project.key, subject: settings.subject });
  const decisionId = decisionIdFor(key);
  const before = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), foldContext(start, context));
  const existing = before.decisions.find((decision) => decision.decisionKey === key);
  // 이미 있는 결정에는 다시 묻지 않는다. 다만 요청 내용이 갈려 교착된 경우에는
  // 대체할 요청을 지목해 해소할 수 있어야 한다 — 탈출구 없는 fail-closed는
  // 교착이지 상태가 아니다.
  //
  // 그 탈출구는 교착에만 열려야 한다. 정상 결정에도 요청을 갈아끼울 수 있으면,
  // 이미 답변된 질문의 내용을 바꿔 그 답을 전혀 다른 질문의 답으로 만들 수 있다 —
  // "배포할까요"에 받은 승인이 "운영 데이터를 지울까요"의 승인이 된다. 해소
  // 수단이 그대로 공격면이 되는 것이고, 답변 대체에 걸어 둔 제약과 같은 이유다.
  if (existing && settings.supersedes) {
    const conflicted = (before.diagnostics || []).some((item) => item.code === 'RDL-DEC-019' && String(item.message || '').includes(decisionId));
    if (!conflicted) {
      throw new Error(`요청 대체는 상충하는 요청이 있을 때만 쓸 수 있습니다: ${decisionId} (RDL-DEC-019 없음)`);
    }
    if (existing.status === 'answered') {
      throw new Error(`이미 답변된 결정의 요청은 대체할 수 없습니다: ${decisionId}`);
    }
  }
  if (existing && !settings.supersedes) return { project: context.project.key, decision: existing, created: false };
  const rootRequestId = settings.rootRequestId || newRootRequestId();
  const identity = decisionIdentity(rootRequestId, `decision:${settings.kind}:${key}`);
  const stored = appendDecisionEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: identity.eventId, type: 'decision.requested', rootRequestId, requestId: identity.requestId,
    clientId, projectId: context.project.key, decisionId, decisionKey: key, kind: settings.kind,
    question: settings.question, options: settings.options, recommendation: settings.recommendation,
    impact: settings.impact, evidence: settings.evidence,
    ...(settings.supersedes ? { supersedes: settings.supersedes } : {})
  }, { lockDirectory: context.lockDirectory });
  // 위임은 질문을 없애되 기록을 없애지 않는다. 유효한 위임이 있으면 요청 직후
  // 부여자 명의의 답변을 함께 남긴다 — 감사 경로가 "물어본 결정"과 "위임된
  // 결정"으로 갈리면 나중에 둘을 맞춰 읽어야 한다. 선택은 권고안을 따른다.
  const delegation = require('./delegation').activeDelegationFor(start, { project: context.project.key, kind: settings.kind, clientId, now: settings.now });
  if (delegation) {
    const answerIdentity = decisionIdentity(rootRequestId, `decision-answer:${key}`);
    appendDecisionEvent(context.eventsRoot, {
      schemaVersion: 1, eventId: answerIdentity.eventId, type: 'decision.answered', rootRequestId, requestId: answerIdentity.requestId,
      clientId, projectId: context.project.key, decisionId, decisionKey: key, kind: settings.kind,
      selectedOption: settings.recommendation.option, answeredBy: delegation.grantedBy, delegationId: delegation.delegationId,
      // 다이제스트는 저장된 요청에서 뽑는다. 정규화 전 입력에서 뽑으면 공백이나
      // 개행만 있어도 값이 갈리고, 접기는 그 답변을 다른 질문의 답으로 보고 버린다 —
      // 위임된 결정이 정상 입력에서 열린 채로 남는다.
      requestDigest: requestDigestFor(stored.event),
      reason: `위임 ${delegation.delegationId}에 의한 자동 승인 (만료 ${delegation.expiresAt}): ${delegation.reason}`
    }, { lockDirectory: context.lockDirectory });
  }
  const folded = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), foldContext(start, context));
  const result = { project: context.project.key, decision: folded.decisions.find((item) => item.decisionKey === key), created: true, file: stored.file };
  return delegation ? Object.assign(result, { delegated: true, delegationId: delegation.delegationId }) : result;
}

function answerDecision(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const clientId = String(settings.clientId || '').trim().toLowerCase();
  const client = assertActiveClient(start, clientId);
  const members = projectMembers(context.layout.root, context.project.key);
  const context2 = foldContext(start, context, settings.now);
  const folded = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), context2);
  const decision = folded.decisions.find((item) => item.decisionId === settings.decisionId);
  if (!decision) throw new Error(`결정을 찾지 못했습니다: ${settings.decisionId || '(없음)'}`);
  if (decision.status === 'answered') return { project: context.project.key, decision, created: false };
  if (!decision.options.some((option) => option.id === settings.selectedOption)) {
    throw new Error(`선택지에 없는 값입니다: ${settings.selectedOption || '(없음)'} (가능: ${decision.options.map((option) => option.id).join(', ')})`);
  }
  // 명의가 이 Client의 소유자와 다르면 위임이 그 차이를 정당화해야 한다.
  // 쓰기와 읽기가 같은 규칙을 봐야 하므로 검증은 인가 모듈 하나만 쓴다.
  const delegation = settings.delegationId
    ? (context2.authority.delegations || []).find((item) => item.delegationId === settings.delegationId) || null
    : null;
  assertAuthority(client, settings.answeredBy, members, '답변', delegation);
  const rootRequestId = settings.rootRequestId || newRootRequestId();
  const identity = decisionIdentity(rootRequestId, `decision-answer:${decision.decisionKey}`);
  appendDecisionEvent(context.eventsRoot, Object.assign({
    schemaVersion: 1, eventId: identity.eventId, type: 'decision.answered', rootRequestId, requestId: identity.requestId,
    clientId, projectId: context.project.key, decisionId: decision.decisionId, decisionKey: decision.decisionKey, kind: decision.kind,
    selectedOption: settings.selectedOption, answeredBy: settings.answeredBy, reason: settings.reason,
    requestDigest: requestDigestFor(decision)
  }, settings.supersedes ? { supersedes: settings.supersedes } : {},
     settings.delegationId ? { delegationId: settings.delegationId } : {}), { lockDirectory: context.lockDirectory });
  const after = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), context2);
  return { project: context.project.key, decision: after.decisions.find((item) => item.decisionId === decision.decisionId), created: true };
}

module.exports = {
  FAMILIES, KINDS, DECISION_ID, assertActingMember, assertAuthority, actingMember,
  sha256, kindDefinition, decisionKey, decisionIdFor,
  normalizeDecisionEvent, decisionEnvelope, appendDecisionEvent, readDecisionEvents, foldDecisions, requestDigestFor,
  listDecisions, requestDecision, answerDecision
};
