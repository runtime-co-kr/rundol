'use strict';

// 인가는 쓰기 경로만으로 지킬 수 없다. 직접 append나 Git 병합으로 들어온 이벤트는
// CLI를 지나지 않으므로, 읽는 쪽 — 모든 소비자가 거치는 접기 — 에서도 "이 Client가
// 이 멤버 이름으로 행위할 수 있었는가"를 확인해야 한다.
//
// 그 확인을 원장마다 따로 두면 하나가 빠졌을 때 아무도 모른다. 실제로 그랬다.
// 그래서 확인을 여기 한 곳에 모으고, 컨텍스트를 선택이 아니라 필수로 만든다.
// 안전한 경로가 opt-in이면 언젠가 꺼진다.
//
// ── 시간 의미론 ───────────────────────────────────────────────────────
//
// 처음 이 모듈을 쓸 때 인가를 "지금 유효한가"로 판정했다. 그것이 두 가지를
// 동시에 깨뜨렸다. 만료·취소된 위임이 영원히 통했고(상태를 아예 보지 않았다),
// 반대로 Client를 비활성화하면 그 장치가 과거에 정상적으로 남긴 기록이 통째로
// 탈락했다. 하나는 너무 느슨하고 하나는 너무 엄격한데 원인은 같다 — 원장의
// 과거 사실을 현재 상태로 판정한 것이다.
//
// 그래서 둘을 분리한다.
//
//   현재 권한  — 지금 새 기록을 남길 수 있는가. 쓰기 경로(CLI)가 본다.
//   역사적 귀속 — 그 기록이 남던 시점에 남길 수 있었는가. 접기가 본다.
//
// 접기는 후자만 본다. Client 소유자는 등록 이력 전체에서 찾고(비활성화가 과거를
// 지우지 않는다), 위임은 그 행위가 기록된 시점 기준으로 만료·취소를 판정한다
// (취소는 미래에만 작용한다).
//
// ── 이 설계가 보장하지 않는 것 ────────────────────────────────────────
//
// 이 원장에는 단조 시퀀스가 없다. 순서는 기록 시각(occurredAt)이 정하고 그 값은
// canonical 밖이므로, 수임 Client가 자기 샤드에 남기는 행위의 시각을 스스로
// 앞당겨 적을 수 있다. 즉 이 방식은 "취소된 뒤의 행위"를 "취소 전에 한 것처럼"
// 위장하는 것까지는 막지 못한다. 막을 수 있는 것은 그보다 흔한 두 가지다 —
// 위임 없이 남의 이름을 쓰는 것, 그리고 만료·취소된 위임을 그대로 다시 쓰는 것.
//
// 이 잔여 위험을 없애려면 원장에 인과 순서(공유 시퀀스나 이전 이벤트 해시 사슬)가
// 필요하고, 그것은 이 모듈이 아니라 event-store가 정할 일이다.

const MEMBER_ID = /^MEMBER-[A-Z0-9]{3,}$/u;

function authorityContext(start, projectKey, options) {
  const settings = options || {};
  if (settings.now === undefined) throw new Error('인가 컨텍스트에는 현재 시각(now)이 필요합니다.');
  const { listClients } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const { workspaceLayout } = require('./workspace');
  const root = workspaceLayout(start).root;

  // 귀속은 등록 이력 전체에서 찾는다. 비활성화는 앞으로를 막는 것이지 과거를
  // 없던 일로 만드는 것이 아니다 — 장치를 폐기했다고 그 장치로 한 승인이
  // 사라지면 원장이 append-only가 아니게 된다.
  const clients = listClients(start).clients || [];
  const clientOwners = clients.map((client) => [client.id, client.owner]);
  const activeClients = clients.filter((client) => client.status === 'active').map((client) => client.id);

  const delegations = require('./delegation')
    .foldDelegations(require('./delegation').readDelegationEvents(eventsRootOf(root), projectKey), {
      now: settings.now,
      authority: { clientOwners, members: readCollaboration(root, projectKey).members.map((member) => member.id) }
    })
    .delegations;

  return {
    project: projectKey,
    now: settings.now,
    members: readCollaboration(root, projectKey).members.map((member) => member.id),
    clientOwners,
    activeClients,
    delegations
  };
}

function eventsRootOf(root) {
  const path = require('path');
  return path.join(root, 'projects', 'workspace', 'events');
}

// 컨텍스트 없이 접으려는 시도는 조용히 통과시키지 않는다. 인가를 끈 채 읽은
// 결과는 인가를 지킨 결과와 구분되지 않으면서 상태만 바꾼다.
function requireAuthority(options, ledger) {
  const settings = options || {};
  const authority = settings.authority || (settings.clientOwners ? { clientOwners: settings.clientOwners, members: settings.members } : null);
  if (!authority || !authority.clientOwners) {
    throw new Error(`${ledger} fold에는 인가 컨텍스트(authority.clientOwners)가 필요합니다. 인가를 끈 접기는 위조된 이벤트를 채택합니다.`);
  }
  return {
    owners: new Map(authority.clientOwners),
    members: authority.members ? new Set(authority.members) : null,
    delegations: authority.delegations || [],
    now: authority.now
  };
}

function timeOf(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// 위임이 이 행위의 시점에 살아 있었는가. "지금 활성인가"가 아니다 — 그렇게 보면
// 어제 정당하게 한 승인이 오늘 취소로 사라지고, 만료된 위임은 영원히 통한다.
function delegationValidAt(delegation, recordedAt) {
  const at = timeOf(recordedAt);
  const granted = timeOf(delegation.grantedAt);
  const expires = timeOf(delegation.expiresAt);
  const revoked = delegation.revokedAt ? timeOf(delegation.revokedAt) : null;
  if (at === null) return '행위 시각이 없어 위임의 유효 구간을 판정할 수 없습니다.';
  if (granted !== null && at < granted) return '위임이 부여되기 전의 행위입니다.';
  if (expires !== null && at >= expires) return `위임 만료 뒤의 행위입니다 (만료 ${delegation.expiresAt}).`;
  if (revoked !== null && at >= revoked) return `위임 취소 뒤의 행위입니다 (취소 ${delegation.revokedAt}).`;
  return null;
}

// 행위자 확인. 명의가 Client 소유자와 같으면 그대로 통과하고, 다르면 그 차이를
// 정당화하는 위임이 이벤트에 적혀 있어야 한다. 위임 식별자만 적어서는 안 되고
// 부여자·수임 Client·종류가 모두 맞아야 하며, 그 위임이 이 행위의 시점에 살아
// 있었어야 한다.
function verifyActor(input, authority, codes) {
  const clientId = input.clientId;
  const memberId = input.memberId;
  const owner = authority.owners.get(clientId);
  if (owner === undefined) {
    return { ok: false, code: codes.unknownClient, message: `등록되지 않은 Client의 기록입니다: ${clientId}` };
  }
  if (!MEMBER_ID.test(memberId || '')) {
    return { ok: false, code: codes.impersonation, message: `멤버 식별자가 유효하지 않습니다: ${memberId || '(없음)'}` };
  }
  // 멤버 경계는 원장마다 같아야 한다. 한 원장만 검사하면 다른 원장으로 우회된다.
  if (authority.members && !authority.members.has(memberId)) {
    return { ok: false, code: codes.member || codes.impersonation, message: `이 프로젝트에 등록된 멤버가 아닙니다: ${memberId}` };
  }
  if (owner === memberId) return { ok: true, delegated: false };
  if (!input.delegationId) {
    return { ok: false, code: codes.impersonation, message: `Client 소유자가 아닌 멤버 명의의 기록입니다: ${clientId}(${owner}) → ${memberId}` };
  }
  const delegation = (authority.delegations || []).find((item) => item.delegationId === input.delegationId);
  if (!delegation) {
    return { ok: false, code: codes.delegation, message: `기록에 없는 위임입니다: ${input.delegationId}` };
  }
  if (delegation.grantedBy !== memberId) {
    return { ok: false, code: codes.delegation, message: `위임 부여자가 명의와 다릅니다: ${delegation.grantedBy} != ${memberId}` };
  }
  if (delegation.delegateClientId !== clientId) {
    return { ok: false, code: codes.delegation, message: `이 Client에게 부여된 위임이 아닙니다: ${delegation.delegateClientId} != ${clientId}` };
  }
  if (input.kind && delegation.kind !== input.kind) {
    return { ok: false, code: codes.delegation, message: `위임된 종류가 아닙니다: ${delegation.kind} != ${input.kind}` };
  }
  const lapsed = delegationValidAt(delegation, input.recordedAt);
  if (lapsed) {
    return { ok: false, code: codes.delegation, message: `${lapsed} (위임 ${delegation.delegationId})` };
  }
  return { ok: true, delegated: true, delegation };
}

module.exports = { authorityContext, requireAuthority, verifyActor, delegationValidAt, MEMBER_ID };
