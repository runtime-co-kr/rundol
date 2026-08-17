'use strict';

// 사람 결정의 기록. ADR-008이 정한 대로 질문은 대화가 아니라 상태다 — 요청과
// 답변이 공유 원장에 남아 어느 클라이언트에서나 읽고 답할 수 있고, 실행 원장과
// 함께 다시 읽을 때 왜 그렇게 되었는지가 복원된다. REQ-039가 규범이다.

const crypto = require('crypto');
const eventStore = require('./event-store');

const EVENT_ID = /^EVT-[A-F0-9]{20}$/u;
const REQUEST_ID = /^REQ-[A-F0-9]{20}$/u;
const DECISION_ID = /^DEC-[A-F0-9]{20}$/u;
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

function normalizeDecisionEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('결정 이벤트는 객체여야 합니다.');
  if (!['decision.requested', 'decision.answered'].includes(input.type)) throw new Error(`알 수 없는 결정 이벤트 종류입니다: ${input.type || '(없음)'}`);
  const requested = input.type === 'decision.requested';
  const allowed = BASE_FIELDS.concat(requested ? ['question', 'options', 'recommendation', 'impact', 'evidence'] : ['selectedOption', 'answeredBy', 'reason'], ['canonicalDigest', 'occurredAt']);
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
  } else {
    if (!OPTION_ID.test(input.selectedOption || '')) throw new Error('선택한 값이 유효하지 않습니다.');
    if (!MEMBER_ID.test(input.answeredBy || '')) throw new Error('답변자는 MEMBER-ID여야 합니다.');
    normalized.selectedOption = input.selectedOption;
    normalized.answeredBy = input.answeredBy;
    normalized.reason = normalizeText(input.reason, '사유', 1000);
  }
  return normalized;
}

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

function appendDecisionEvent(eventsRoot, input, options) {
  const envelope = decisionEnvelope(input);
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
function foldDecisions(events, options) {
  const settings = options || {};
  const members = settings.members ? new Set(settings.members) : null;
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
    const request = group.requests.slice().sort((left, right) => left.eventId.localeCompare(right.eventId))[0] || null;
    if (!request) {
      diagnostics.push({ code: 'RDL-DEC-016', severity: 'error', message: `요청 없는 결정 답변입니다: ${decisionIdFor(key)}` });
      continue;
    }
    const optionIds = new Set(request.options.map((option) => option.id));
    const answers = group.answers.slice().sort((left, right) => left.eventId.localeCompare(right.eventId)).filter((answer) => {
      if (!optionIds.has(answer.selectedOption)) {
        diagnostics.push({ code: 'RDL-DEC-017', severity: 'error', eventId: answer.eventId, message: `선택지에 없는 값입니다: ${answer.selectedOption}` });
        return false;
      }
      // 권한 검증은 레지스트리를 가진 호출자가 멤버 목록을 넘겼을 때만 수행한다.
      // 순수 fold는 레지스트리를 볼 수 없고, 형태만으로 권한을 판정하지 않는다.
      if (members && !members.has(answer.answeredBy)) {
        diagnostics.push({ code: 'RDL-DEC-002', severity: 'error', eventId: answer.eventId, message: `등록된 멤버가 아닌 답변자입니다: ${answer.answeredBy}` });
        return false;
      }
      return true;
    });
    const answer = answers[0] || null;
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

function assertActiveClient(start, clientId) {
  const { getClient } = require('./collaboration-store');
  const client = getClient(start, clientId);
  if (client.status !== 'active') throw new Error(`비활성 Client는 결정을 다룰 수 없습니다: ${clientId}`);
  return client;
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
  const folded = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), { members: projectMembers(context.layout.root, context.project.key) });
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
  const existing = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), { members: projectMembers(context.layout.root, context.project.key) })
    .decisions.find((decision) => decision.decisionKey === key);
  if (existing) return { project: context.project.key, decision: existing, created: false };
  const rootRequestId = settings.rootRequestId || newRootRequestId();
  const identity = decisionIdentity(rootRequestId, `decision:${settings.kind}:${key}`);
  const stored = appendDecisionEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: identity.eventId, type: 'decision.requested', rootRequestId, requestId: identity.requestId,
    clientId, projectId: context.project.key, decisionId, decisionKey: key, kind: settings.kind,
    question: settings.question, options: settings.options, recommendation: settings.recommendation,
    impact: settings.impact, evidence: settings.evidence
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
      selectedOption: settings.recommendation.option, answeredBy: delegation.grantedBy,
      reason: `위임 ${delegation.delegationId}에 의한 자동 승인 (만료 ${delegation.expiresAt}): ${delegation.reason}`
    }, { lockDirectory: context.lockDirectory });
  }
  const folded = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), { members: projectMembers(context.layout.root, context.project.key) });
  const result = { project: context.project.key, decision: folded.decisions.find((item) => item.decisionKey === key), created: true, file: stored.file };
  return delegation ? Object.assign(result, { delegated: true, delegationId: delegation.delegationId }) : result;
}

function answerDecision(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const clientId = String(settings.clientId || '').trim().toLowerCase();
  assertActiveClient(start, clientId);
  const members = projectMembers(context.layout.root, context.project.key);
  if (!members.includes(settings.answeredBy)) throw new Error(`project.md에 등록된 멤버만 답할 수 있습니다: ${settings.answeredBy || '(없음)'}`);
  const folded = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), { members });
  const decision = folded.decisions.find((item) => item.decisionId === settings.decisionId);
  if (!decision) throw new Error(`결정을 찾지 못했습니다: ${settings.decisionId || '(없음)'}`);
  if (decision.status === 'answered') return { project: context.project.key, decision, created: false };
  if (!decision.options.some((option) => option.id === settings.selectedOption)) {
    throw new Error(`선택지에 없는 값입니다: ${settings.selectedOption || '(없음)'} (가능: ${decision.options.map((option) => option.id).join(', ')})`);
  }
  const rootRequestId = settings.rootRequestId || newRootRequestId();
  const identity = decisionIdentity(rootRequestId, `decision-answer:${decision.decisionKey}`);
  appendDecisionEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: identity.eventId, type: 'decision.answered', rootRequestId, requestId: identity.requestId,
    clientId, projectId: context.project.key, decisionId: decision.decisionId, decisionKey: decision.decisionKey, kind: decision.kind,
    selectedOption: settings.selectedOption, answeredBy: settings.answeredBy, reason: settings.reason
  }, { lockDirectory: context.lockDirectory });
  const after = foldDecisions(readDecisionEvents(context.eventsRoot, context.project.key), { members });
  return { project: context.project.key, decision: after.decisions.find((item) => item.decisionId === decision.decisionId), created: true };
}

module.exports = {
  FAMILIES, KINDS, DECISION_ID,
  sha256, kindDefinition, decisionKey, decisionIdFor,
  normalizeDecisionEvent, decisionEnvelope, appendDecisionEvent, readDecisionEvents, foldDecisions,
  listDecisions, requestDecision, answerDecision
};
