'use strict';

// 인가는 쓰기 경로만으로 지킬 수 없다. 직접 append나 Git 병합으로 들어온 이벤트는
// CLI를 지나지 않으므로, 읽는 쪽 — 모든 소비자가 거치는 접기 — 에서도 "이 Client가
// 이 멤버 이름으로 행위할 수 있었는가"를 확인해야 한다.
//
// 그 확인을 원장마다 따로 두면 하나가 빠졌을 때 아무도 모른다. 실제로 그랬다.
// decision에만 있었고 approval과 delegation에는 없었으며, 있는 하나마저 rdl check가
// 빈 컨텍스트로 불러 꺼 버렸다. 위조한 승인이 approved로, 위조한 위임이 active로
// 채택됐고 그 결과가 문서 분석까지 그대로 흘러갔다.
//
// 그래서 확인을 여기 한 곳에 모으고, 컨텍스트를 선택이 아니라 필수로 만든다.
// 안전한 경로가 opt-in이면 언젠가 꺼진다 — 이번이 그 증거다.

const MEMBER_ID = /^MEMBER-[A-Z0-9]{3,}$/u;

// 만료는 읽는 시점이 정한다. 그 시각을 fold 안에서 벽시계로 읽으면 같은 이벤트가
// 언제 읽느냐에 따라 다른 결과를 내므로, 호출자가 준 now를 그대로 물려준다.
function authorityContext(start, projectKey, options) {
  const settings = options || {};
  if (settings.now === undefined) throw new Error('인가 컨텍스트에는 현재 시각(now)이 필요합니다.');
  const { listClients } = require('./collaboration-store');
  const { readCollaboration } = require('./collaboration');
  const { workspaceLayout } = require('./workspace');
  const root = workspaceLayout(start).root;
  const clients = (listClients(start).clients || []).filter((client) => client.status === 'active');
  const delegations = require('./delegation')
    .foldDelegations(require('./delegation').readDelegationEvents(eventsRootOf(root), projectKey), { now: settings.now, authority: { clientOwners: clients.map((client) => [client.id, client.owner]) } })
    .delegations;
  return {
    project: projectKey,
    now: settings.now,
    members: readCollaboration(root, projectKey).members.map((member) => member.id),
    clientOwners: clients.map((client) => [client.id, client.owner]),
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
    members: authority.members || null,
    delegations: authority.delegations || [],
    now: authority.now
  };
}

// 행위자 확인. 명의가 Client 소유자와 같으면 그대로 통과하고, 다르면 그 차이를
// 정당화하는 위임이 이벤트에 적혀 있어야 한다. 위임 식별자만 적어서는 안 되고
// 부여자·수임 Client·종류가 모두 맞아야 한다 — 셋 중 하나라도 안 보면 임의의
// 식별자를 적어 남의 이름으로 행위할 수 있다.
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
  if (owner === memberId) return { ok: true, delegated: false };
  if (!input.delegationId) {
    return { ok: false, code: codes.impersonation, message: `Client 소유자가 아닌 멤버 명의의 기록입니다: ${clientId}(${owner}) → ${memberId}` };
  }
  const delegation = (authority.delegations || []).find((item) => item.delegationId === input.delegationId);
  if (!delegation) {
    return { ok: false, code: codes.delegation, message: `유효한 위임이 아닙니다: ${input.delegationId} (없거나 만료·취소되었습니다)` };
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
  return { ok: true, delegated: true, delegation };
}

module.exports = { authorityContext, requireAuthority, verifyActor, MEMBER_ID };
