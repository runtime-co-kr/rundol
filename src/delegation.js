'use strict';

// 결정 위임. 위임은 편의 설정이 아니라 권한 부여다 — 그래서 개인 설정처럼 로컬에
// 두지 않고 부여자·범위·만료·사유와 함께 공유 원장에 남는다. 볼 수 없는 위임은
// 통제를 잃은 것이고, 만료 없는 위임은 아무도 기억하지 못하는 권한이다.
//
// 위임은 질문을 없애되 기록을 없애지 않는다. 위임이 걸린 결정도 요청과 답변이
// 남고, 그 답변이 어느 위임으로 자동 승인됐는지 사유에 남는다 — 감사 경로가
// 둘로 갈리지 않게 하려는 것이다.

const crypto = require('crypto');
const eventStore = require('./event-store');
const { KINDS, kindDefinition } = require('./decision');

const EVENT_ID = /^EVT-[A-F0-9]{20}$/u;
const REQUEST_ID = /^REQ-[A-F0-9]{20}$/u;
const DELEGATION_ID = /^DLG-[A-F0-9]{20}$/u;
const SIMPLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MEMBER_ID = /^MEMBER-\d{3}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

// 만료는 기본값이지 선택이 아니다. 갱신하지 않으면 사라지는 것이 위임의 안전
// 성질이고, 상한을 두어 "한 번 주고 잊는" 권한이 생기지 않게 한다.
const DEFAULT_EXPIRY_DAYS = 7;
const MAXIMUM_EXPIRY_DAYS = 30;

const BASE_FIELDS = ['schemaVersion', 'eventId', 'type', 'rootRequestId', 'requestId', 'clientId', 'projectId', 'delegationId', 'kind'];

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function delegationIdFor(input) {
  const digest = sha256(`rundol.delegation.v1\0${input.kind}\0${input.projectId}\0${input.delegateClientId}\0${input.grantedBy}\0${input.expiresAt}`);
  return `DLG-${digest.slice(0, 20).toUpperCase()}`;
}

function normalizeText(value, label, limit) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\r\n/gu, '\n').trim();
  if (!text) throw new Error(`${label}이(가) 필요합니다.`);
  if (text.length > limit) throw new Error(`${label}은(는) ${limit}자 이하여야 합니다.`);
  return text;
}

function assertExpiry(value, grantedAt) {
  if (!INSTANT.test(value || '')) throw new Error('만료 시각은 밀리초 단위 ISO-8601 UTC여야 합니다.');
  const expires = Date.parse(value);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== value) throw new Error('만료 시각이 유효하지 않습니다.');
  if (grantedAt !== undefined) {
    if (expires <= grantedAt) throw new Error('만료 시각은 부여 시각보다 뒤여야 합니다.');
    if (expires - grantedAt > MAXIMUM_EXPIRY_DAYS * 86400000) throw new Error(`위임 기간은 ${MAXIMUM_EXPIRY_DAYS}일을 넘을 수 없습니다.`);
  }
  return value;
}

function normalizeDelegationEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('위임 이벤트는 객체여야 합니다.');
  if (!['delegation.granted', 'delegation.revoked'].includes(input.type)) throw new Error(`알 수 없는 위임 이벤트 종류입니다: ${input.type || '(없음)'}`);
  const granted = input.type === 'delegation.granted';
  const allowed = BASE_FIELDS.concat(granted ? ['delegateClientId', 'grantedBy', 'grantedAt', 'expiresAt', 'reason'] : ['previousDelegationEventId', 'revokedBy', 'reason'], ['recordedAt', 'canonicalDigest', 'occurredAt']);
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${input.type}에 알 수 없는 필드가 있습니다: ${extra.sort().join(', ')}`);
  for (const field of BASE_FIELDS) if (input[field] === undefined) throw new Error(`${input.type}.${field}이(가) 필요합니다.`);
  if (input.schemaVersion !== 1 || !EVENT_ID.test(input.eventId || '') || !REQUEST_ID.test(input.rootRequestId || '') || !REQUEST_ID.test(input.requestId || '')
    || !SIMPLE_ID.test(input.clientId || '') || !SIMPLE_ID.test(input.projectId || '') || !DELEGATION_ID.test(input.delegationId || '')) {
    throw new Error(`${input.type}의 신원이 유효하지 않습니다.`);
  }
  const definition = kindDefinition(input.kind);
  const normalized = {};
  for (const field of BASE_FIELDS) normalized[field] = input[field];
  if (granted) {
    // 위임 불가 종류는 부여 자체를 거부한다. 이 티어가 없으면 카탈로그 전체가
    // 위임 한 번으로 무력화된다.
    if (!definition.delegable) throw new Error(`RDL-DEC-004 위임할 수 없는 결정입니다: ${input.kind}`);
    if (!SIMPLE_ID.test(input.delegateClientId || '')) throw new Error('수임 Client가 유효하지 않습니다.');
    if (!MEMBER_ID.test(input.grantedBy || '')) throw new Error('부여자는 MEMBER-ID여야 합니다.');
    if (!INSTANT.test(input.grantedAt || '')) throw new Error('부여 시각은 밀리초 단위 ISO-8601 UTC여야 합니다.');
    normalized.delegateClientId = input.delegateClientId;
    normalized.grantedBy = input.grantedBy;
    normalized.grantedAt = input.grantedAt;
    normalized.expiresAt = assertExpiry(input.expiresAt, Date.parse(input.grantedAt));
    normalized.reason = normalizeText(input.reason, '사유', 1000);
    // 식별자는 내용에서 파생된다. 재대조하지 않으면 임의의 식별자를 선언한
    // 이벤트가 유효한 위임으로 채택되고, 취소는 그 식별자를 가리키므로
    // 실제로 꺼야 할 권한을 끄지 못한다.
    const derived = delegationIdFor({ kind: input.kind, projectId: input.projectId, delegateClientId: input.delegateClientId, grantedBy: input.grantedBy, expiresAt: normalized.expiresAt });
    if (derived !== input.delegationId) throw new Error(`위임 식별자가 내용에서 파생되지 않았습니다: ${input.delegationId} != ${derived}`);
  } else {
    if (!EVENT_ID.test(input.previousDelegationEventId || '')) throw new Error('취소 대상 위임 이벤트가 유효하지 않습니다.');
    if (!MEMBER_ID.test(input.revokedBy || '')) throw new Error('취소자는 MEMBER-ID여야 합니다.');
    normalized.previousDelegationEventId = input.previousDelegationEventId;
    normalized.revokedBy = input.revokedBy;
    normalized.reason = normalizeText(input.reason, '사유', 1000);
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
function delegationEnvelope(input) {
  const canonical = normalizeDelegationEvent(input);
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
function appendDelegationEvent(eventsRoot, input, options) {
  const now = new Date().toISOString();
  const stamped = Object.assign({}, input,
    input && input.occurredAt === undefined ? { occurredAt: now } : {},
    input && input.recordedAt === undefined ? { recordedAt: now } : {});
  const envelope = delegationEnvelope(stamped);
  const file = eventStore.appendEvent(eventsRoot, 'delegation', envelope.canonical.projectId, envelope.canonical.clientId, envelope.shared, {
    lockDirectory: options && options.lockDirectory,
    fsync: !options || options.fsync !== false
  });
  return { file, event: envelope.shared };
}

function readDelegationEvents(eventsRoot, projectId) {
  if (!SIMPLE_ID.test(projectId || '')) throw new Error('위임 읽기 신원이 유효하지 않습니다.');
  return eventStore.readEvents(eventsRoot, 'delegation', projectId, { sort: 'file', dedupe: false });
}

// 유효한 위임은 부여됐고, 취소되지 않았고, 아직 만료되지 않은 것이다. 만료는
// 시각 비교이므로 fold의 입력으로 받는다 — 벽시계를 fold 안에 숨기지 않는다.
// 부여자 검증에 필요한 최소 컨텍스트. 위임은 위임할 수 없으므로 여기서는
// Client 소유자 목록만 있으면 된다.
function delegationAuthority(start, projectKey) {
  const { listClients } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const { workspaceLayout } = require('./workspace');
  // 귀속은 등록 이력 전체에서 찾는다. 비활성화는 앞으로를 막는 것이지 과거를
  // 없던 일로 만드는 것이 아니다.
  const clients = listClients(start).clients || [];
  const root = workspaceLayout(start).root;
  return {
    clientOwners: clients.map((client) => [client.id, client.owner]),
    members: projectKey ? readCollaboration(root, projectKey).members.map((member) => member.id) : null
  };
}

function foldDelegations(events, options) {
  const settings = options || {};
  // 만료 판정 시각은 호출자가 준다. fold 안에서 벽시계를 읽으면 같은 이벤트가
  // 언제 읽느냐에 따라 다른 결과를 내고, 원장이 지키는 성질이 위임에서만 깨진다.
  if (settings.now === undefined) throw new Error('위임 fold에는 현재 시각(now)이 필요합니다.');
  // 위조된 위임 부여는 그 자체로 권한을 만든다. 쓰기 경로에서만 막으면 Git 병합으로
  // 들어온 부여가 그대로 active가 된다 — 실제로 그랬다.
  const authority = require('./authority').requireAuthority(settings, '위임');
  const nowValue = settings.now;
  const now = nowValue instanceof Date ? nowValue.getTime() : typeof nowValue === 'string' ? Date.parse(nowValue) : Number(nowValue);
  if (!Number.isFinite(now)) throw new Error('위임 fold에는 유효한 현재 시각이 필요합니다.');
  const diagnostics = [];
  const byEventId = new Map();
  for (const raw of events || []) {
    let event;
    try {
      event = normalizeDelegationEvent(raw);
      const expected = delegationEnvelope(event).canonicalDigest;
      if (raw.canonicalDigest !== undefined && raw.canonicalDigest !== expected) throw new Error('canonicalDigest 불일치');
      event.canonicalDigest = expected;
      // 기록 시각은 canonical 밖이지만 취소가 언제 일어났는지를 알아야 "이 행위가
      // 취소 전이었는가"를 판정할 수 있다. 정규화가 벗겨낸 값을 되붙인다.
      if (raw.occurredAt !== undefined) event.occurredAt = raw.occurredAt;
    } catch (error) {
      diagnostics.push({ code: 'RDL-DLG-014', severity: 'error', eventId: raw && raw.eventId || null, message: error.message });
      continue;
    }
    if (!byEventId.has(event.eventId)) byEventId.set(event.eventId, event);
    else if (byEventId.get(event.eventId) && byEventId.get(event.eventId).canonicalDigest !== event.canonicalDigest) {
      byEventId.set(event.eventId, null);
      diagnostics.push({ code: 'RDL-DLG-015', severity: 'error', eventId: event.eventId, message: '같은 eventId에 상충하는 위임 기록이 있습니다.' });
    }
  }
  const authorized = Array.from(byEventId.values()).filter(Boolean).filter((event) => {
    // 부여자·취소자는 그 기록을 남긴 Client의 소유자여야 한다. 위임은 위임할 수
    // 없으므로(delegation-grant는 위임 불가 종류다) 여기서 위임은 근거가 되지 못한다.
    const memberId = event.type === 'delegation.granted' ? event.grantedBy : event.revokedBy;
    const verdict = require('./authority').verifyActor({ clientId: event.clientId, memberId }, authority,
      { unknownClient: 'RDL-DLG-020', impersonation: 'RDL-DLG-021', delegation: 'RDL-DLG-021' });
    if (!verdict.ok) {
      diagnostics.push({ code: verdict.code, severity: 'error', eventId: event.eventId, message: verdict.message });
      return false;
    }
    if (verdict.delegated) {
      diagnostics.push({ code: 'RDL-DLG-021', severity: 'error', eventId: event.eventId, message: '위임을 근거로 위임을 부여하거나 취소할 수 없습니다.' });
      return false;
    }
    // 권한을 받는 쪽도 등록된 주체여야 한다. 레지스트리에 없는 Client에게 준
    // 위임은 누구에게 준 것인지 알 수 없고, 그 이름으로 아무나 행위할 수 있다.
    if (event.type === 'delegation.granted' && !authority.owners.has(event.delegateClientId)) {
      diagnostics.push({ code: 'RDL-DLG-022', severity: 'error', eventId: event.eventId, message: `등록되지 않은 수임 Client입니다: ${event.delegateClientId}` });
      return false;
    }
    return true;
  });
  const valid = authorized;
  const grantByEventId = new Map(valid.filter((event) => event.type === 'delegation.granted').map((event) => [event.eventId, event]));
  // 취소는 자기가 가리키는 부여와 같은 위임·종류여야 한다. 이전 이벤트 ID만 맞으면
  // 되게 두면 다른 위임의 취소로 엉뚱한 권한이 꺼진다.
  const revoked = new Map();
  for (const event of valid.filter((item) => item.type === 'delegation.revoked')) {
    const grant = grantByEventId.get(event.previousDelegationEventId);
    if (!grant) {
      diagnostics.push({ code: 'RDL-DLG-016', severity: 'error', eventId: event.eventId, message: '취소 대상 위임 부여를 찾지 못했습니다.' });
      continue;
    }
    if (grant.delegationId !== event.delegationId || grant.kind !== event.kind) {
      diagnostics.push({ code: 'RDL-DLG-017', severity: 'error', eventId: event.eventId, message: `취소가 다른 위임을 가리킵니다: ${event.delegationId} != ${grant.delegationId}` });
      continue;
    }
    // 취소 시각은 기록 시각이다. 이 값으로 "이 행위가 취소 전이었는가"를 판정한다.
    revoked.set(grant.eventId, event.recordedAt || null);
  }
  const grants = valid.filter((event) => event.type === 'delegation.granted')
    .sort((left, right) => left.eventId.localeCompare(right.eventId))
    .map((event) => {
      const expiresAt = Date.parse(event.expiresAt);
      const status = revoked.has(event.eventId) ? 'revoked' : expiresAt <= now ? 'expired' : 'active';
      const revokedAt = revoked.has(event.eventId) ? revoked.get(event.eventId) : null;
      return {
        delegationId: event.delegationId,
        eventId: event.eventId,
        kind: event.kind,
        family: KINDS[event.kind].family,
        projectId: event.projectId,
        delegateClientId: event.delegateClientId,
        grantedBy: event.grantedBy,
        grantedAt: event.grantedAt,
        expiresAt: event.expiresAt,
        reason: event.reason,
        revokedAt,
        status
      };
    });
  // 같은 범위(종류·수임 Client)에 활성 위임이 둘 이상이면 어느 것이 근거인지
  // 갈린다. 하나를 조용히 고르는 대신 진단하고 그 범위를 비운다 — 권한 판단은
  // 모호할 때 열리는 것이 아니라 닫혀야 한다.
  const active = grants.filter((grant) => grant.status === 'active');
  const ambiguous = new Set();
  const byScope = new Map();
  for (const grant of active) {
    const scope = `${grant.kind}\0${grant.delegateClientId}`;
    if (byScope.has(scope)) ambiguous.add(scope);
    else byScope.set(scope, grant);
  }
  for (const scope of ambiguous) {
    const [kind, delegateClientId] = scope.split('\0');
    diagnostics.push({ code: 'RDL-DLG-018', severity: 'error', message: `같은 범위에 활성 위임이 둘 이상입니다: ${kind} → ${delegateClientId}` });
  }
  return {
    delegations: grants,
    active: active.filter((grant) => !ambiguous.has(`${grant.kind}\0${grant.delegateClientId}`)),
    ambiguous: Array.from(ambiguous).map((scope) => ({ kind: scope.split('\0')[0], delegateClientId: scope.split('\0')[1] })),
    diagnostics
  };
}

function findDelegation(folded, kind, clientId) {
  return folded.active.find((grant) => grant.kind === kind && grant.delegateClientId === clientId) || null;
}

// ── Workspace 경로 ──────────────────────────────────────────────────────────

function workspaceContext(start, projectKey) {
  const { workspaceLayout, selectProject } = require('./workspace');
  const { runtimeWorkspace } = require('./runtime');
  const layout = workspaceLayout(start);
  const project = selectProject(layout, projectKey, true);
  if (layout.schemaVersion < 6) throw new Error('위임 기록에는 schemaVersion 6 이상의 Workspace가 필요합니다.');
  return {
    layout,
    project,
    eventsRoot: require('path').join(layout.root, 'projects', 'workspace', 'events'),
    lockDirectory: runtimeWorkspace(layout.root).locks
  };
}

function identity(rootRequestId, childKey) {
  const requestJournal = require('./request-journal');
  const requestId = requestJournal.childRequestId(rootRequestId, childKey);
  return { requestId, eventId: requestJournal.eventIdForRequest(requestId) };
}

function newRootRequestId() {
  return `REQ-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

function listDelegations(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const folded = foldDelegations(readDelegationEvents(context.eventsRoot, context.project.key), { now: settings.now === undefined ? Date.now() : settings.now, authority: delegationAuthority(start, context.project.key) });
  return {
    project: context.project.key,
    active: folded.active.length,
    total: folded.delegations.length,
    delegations: settings.active ? folded.active : folded.delegations,
    diagnostics: folded.diagnostics
  };
}

function grantDelegation(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const { getClient } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const recorder = String(settings.clientId || '').trim().toLowerCase();
  const delegate = String(settings.delegateClientId || '').trim().toLowerCase();
  const recordingClient = getClient(start, recorder);
  if (recordingClient.status !== 'active') throw new Error(`비활성 Client는 위임을 부여할 수 없습니다: ${recorder}`);
  if (getClient(start, delegate).status !== 'active') throw new Error(`비활성 Client에는 위임할 수 없습니다: ${delegate}`);
  const members = readCollaboration(context.layout.root, context.project.key).members.map((member) => member.id);
  require('./decision').assertActingMember(recordingClient, settings.grantedBy, members, '위임');
  const grantedAtValue = settings.grantedAt || new Date().toISOString();
  const days = settings.days === undefined ? DEFAULT_EXPIRY_DAYS : Number(settings.days);
  if (!Number.isFinite(days) || days <= 0 || days > MAXIMUM_EXPIRY_DAYS) throw new Error(`위임 기간은 1일 이상 ${MAXIMUM_EXPIRY_DAYS}일 이하여야 합니다.`);
  const expiresAt = settings.expiresAt || new Date(Date.parse(grantedAtValue) + days * 86400000).toISOString();
  const delegationId = delegationIdFor({ kind: settings.kind, projectId: context.project.key, delegateClientId: delegate, grantedBy: settings.grantedBy, expiresAt });
  const rootRequestId = settings.rootRequestId || newRootRequestId();
  const ids = identity(rootRequestId, `delegation:${delegationId}`);
  const stored = appendDelegationEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: ids.eventId, type: 'delegation.granted', rootRequestId, requestId: ids.requestId,
    clientId: recorder, projectId: context.project.key, delegationId, kind: settings.kind,
    delegateClientId: delegate, grantedBy: settings.grantedBy, grantedAt: grantedAtValue, expiresAt, reason: settings.reason
  }, { lockDirectory: context.lockDirectory });
  const folded = foldDelegations(readDelegationEvents(context.eventsRoot, context.project.key), { now: settings.now || Date.parse(grantedAtValue), authority: delegationAuthority(start, context.project.key) });
  return { project: context.project.key, delegation: folded.delegations.find((grant) => grant.eventId === stored.event.eventId) };
}

function revokeDelegation(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const { getClient } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const recorder = String(settings.clientId || '').trim().toLowerCase();
  const recordingClient = getClient(start, recorder);
  if (recordingClient.status !== 'active') throw new Error(`비활성 Client는 위임을 취소할 수 없습니다: ${recorder}`);
  const members = readCollaboration(context.layout.root, context.project.key).members.map((member) => member.id);
  require('./decision').assertActingMember(recordingClient, settings.revokedBy, members, '취소');
  const folded = foldDelegations(readDelegationEvents(context.eventsRoot, context.project.key), { now: settings.now === undefined ? Date.now() : settings.now, authority: delegationAuthority(start, context.project.key) });
  const target = folded.delegations.find((grant) => grant.delegationId === settings.delegationId);
  if (!target) throw new Error(`위임을 찾지 못했습니다: ${settings.delegationId || '(없음)'}`);
  if (target.status === 'revoked') return { project: context.project.key, delegation: target, changed: false };
  const rootRequestId = settings.rootRequestId || newRootRequestId();
  const ids = identity(rootRequestId, `delegation-revoke:${target.delegationId}`);
  appendDelegationEvent(context.eventsRoot, {
    schemaVersion: 1, eventId: ids.eventId, type: 'delegation.revoked', rootRequestId, requestId: ids.requestId,
    clientId: recorder, projectId: context.project.key, delegationId: target.delegationId, kind: target.kind,
    previousDelegationEventId: target.eventId, revokedBy: settings.revokedBy, reason: settings.reason
  }, { lockDirectory: context.lockDirectory });
  const after = foldDelegations(readDelegationEvents(context.eventsRoot, context.project.key), { now: settings.now === undefined ? Date.now() : settings.now, authority: delegationAuthority(start, context.project.key) });
  return { project: context.project.key, delegation: after.delegations.find((grant) => grant.delegationId === target.delegationId), changed: true };
}

// 결정 경로가 묻는다: 이 종류를 이 클라이언트가 위임받았는가. 받았으면 질문을
// 건너뛰되 기록은 남긴다.
function activeDelegationFor(start, input) {
  const settings = input || {};
  const context = workspaceContext(start, settings.project);
  const folded = foldDelegations(readDelegationEvents(context.eventsRoot, context.project.key), { now: settings.now === undefined ? Date.now() : settings.now, authority: delegationAuthority(start, context.project.key) });
  return findDelegation(folded, settings.kind, String(settings.clientId || '').trim().toLowerCase());
}

module.exports = {
  DEFAULT_EXPIRY_DAYS, MAXIMUM_EXPIRY_DAYS, DELEGATION_ID,
  delegationIdFor, normalizeDelegationEvent, delegationEnvelope, appendDelegationEvent, readDelegationEvents,
  foldDelegations, findDelegation, listDelegations, grantDelegation, revokeDelegation, activeDelegationFor
};
