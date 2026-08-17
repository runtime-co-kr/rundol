'use strict';

// 인가는 쓰기 경로만으로 지킬 수 없다. 이 시험은 CLI를 지나지 않고 원장에 직접
// 도착한 이벤트 — Git 병합으로 들어오는 것과 같은 경로 — 가 상태를 바꾸지
// 못한다는 것을 확인한다. 외부 검증에서 위조한 승인이 approved로, 위조한 위임이
// active로 채택된 것을 재현한 시험이다.
//
// 위조 이벤트는 형식을 완전히 갖춰야 한다. 형식이 틀리면 인가에 닿기 전에
// 스키마 검사가 버리고, 그러면 이 시험은 통과하면서 아무것도 증명하지 못한다 —
// 처음 작성했을 때 실제로 그랬다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeApprovalEvent, foldApprovals, readApprovalEvents } = require('../src/approval');
const { delegationIdFor, foldDelegations, readDelegationEvents } = require('../src/delegation');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-authority-'));
const home = path.join(temporary, 'runtime');
const previousHome = process.env.RUNDOL_HOME;
process.env.RUNDOL_HOME = home;

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

const eventsRoot = () => path.join(temporary, 'projects', 'workspace', 'events');

// 원장에 직접 이벤트를 붙인다. CLI의 결박을 지나지 않는 경로 — Git 병합이
// 정확히 이렇게 도착한다.
function appendRaw(ledger, projectId, clientId, event) {
  const directory = path.join(eventsRoot(), ledger);
  fs.mkdirSync(directory, { recursive: true });
  const shard = path.join(directory, `${ledger}-${projectId}-${clientId}-000001.jsonl`);
  fs.appendFileSync(shard, `${JSON.stringify(event)}\n`, 'utf8');
}

function authorityFor(projectKey) {
  return require('../src/authority').authorityContext(temporary, projectKey, { now: Date.parse('2026-08-17T12:00:00.000Z') });
}

const hex = (character) => character.repeat(20);

try {
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# authority\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', 'A', '--type', 'agent', '--owner', 'MEMBER-001']);
  // 위조 검증에는 실제 두 번째 멤버가 필요 없다. 이 Client의 소유자가 아닌 명의면
  // 충분하다 — 인가는 "이 Client가 이 이름으로 행위할 수 있었는가"만 묻는다.
  const otherMember = 'MEMBER-999';

  const created = rdl(['doc', 'create', 'ADR', '인가 검증 대상', '--owner', 'MEMBER-001', '--scope', '인가 검증에 쓰는 결정', '--exclude', '그 밖', '--project', 'crm']);
  const listed = rdl(['doc', 'status', '--project', 'crm']).documents.find((entry) => entry.id === created.id);
  const document = { id: created.id, revision: listed.revision };
  assert(document.revision, `문서 리비전을 얻지 못했습니다: ${JSON.stringify(listed)}`);

  // ── 1. 위조된 승인은 채택되지 않는다 ────────────────────────────────
  const forgedApproval = {
    schemaVersion: 1,
    eventId: `EVT-${hex('A')}`,
    type: 'approval.granted',
    rootRequestId: `REQ-${hex('B')}`,
    requestId: `REQ-${hex('C')}`,
    clientId: 'agent-a',
    projectId: 'crm',
    targetId: document.id,
    reviewedRevision: document.revision,
    approvedBy: otherMember,
    actorMemberId: otherMember,
    basis: [{ kind: 'read' }]
  };
  // 형식이 온전한지 먼저 확인한다. 여기서 걸리면 이 시험은 인가를 시험하지 못한다.
  assert.doesNotThrow(() => normalizeApprovalEvent(forgedApproval), '위조 이벤트가 형식 검사부터 걸리면 인가를 시험하지 못합니다.');
  appendRaw('approval', 'crm', 'agent-a', forgedApproval);

  const forgedFold = foldApprovals(readApprovalEvents(eventsRoot(), 'crm'), { authority: authorityFor('crm') });
  const impersonation = forgedFold.diagnostics.filter((item) => item.code === 'RDL-APPROVE-021');
  assert.strictEqual(impersonation.length, 1, `명의 위조로 지목되어야 합니다: ${JSON.stringify(forgedFold.diagnostics)}`);
  assert.strictEqual((forgedFold.approvals.get(document.id) || []).length, 0, '위조된 승인은 이력에 남지 않아야 합니다.');

  const forgedStatus = rdl(['doc', 'status', '--project', 'crm']);
  const forgedEntry = (forgedStatus.documents || []).find((entry) => entry.id === document.id);
  assert.strictEqual(forgedEntry.status, 'unapproved', '위조된 승인이 문서를 승인 상태로 만들면 안 됩니다.');

  // 분석도 같은 판정을 써야 한다. 승인 판정이 소비자마다 갈리면 한쪽만 속는다.
  const analyzed = require('../src/document-analysis').analyzeDocuments(temporary, { project: 'crm' });
  assert.strictEqual(analyzed.documents.find((entry) => entry.id === document.id).trust, 'unapproved');

  // 검사도 지목해야 한다. 검사가 인가를 끈 채 접으면 위조가 정상으로 보고된다.
  const checked = spawnSync(process.execPath, [cli, 'check', '--root', temporary, '--json'], { cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  const report = JSON.parse(checked.stdout);
  assert.strictEqual(report.diagnostics.filter((item) => item.code === 'RDL-APPROVE-021').length, 1,
    `검사가 위조된 승인을 지목해야 합니다: ${JSON.stringify(report.diagnostics.filter((item) => String(item.code).startsWith('RDL-APPROVE')))}`);

  // ── 2. 위조된 위임은 활성이 되지 않는다 ──────────────────────────────
  const expiresAt = '2026-08-24T00:00:00.000Z';
  const forgedDelegation = {
    schemaVersion: 1,
    eventId: `EVT-${hex('D')}`,
    type: 'delegation.granted',
    rootRequestId: `REQ-${hex('E')}`,
    requestId: `REQ-${hex('F')}`,
    clientId: 'agent-a',
    projectId: 'crm',
    delegationId: delegationIdFor({ kind: 'doc-approve', projectId: 'crm', delegateClientId: 'agent-a', grantedBy: otherMember, expiresAt }),
    kind: 'doc-approve',
    delegateClientId: 'agent-a',
    grantedBy: otherMember,
    grantedAt: '2026-08-17T00:00:00.000Z',
    expiresAt,
    reason: '위조된 부여'
  };
  appendRaw('delegation', 'crm', 'agent-a', forgedDelegation);

  const delegationFold = foldDelegations(readDelegationEvents(eventsRoot(), 'crm'), { now: Date.parse('2026-08-17T12:00:00.000Z'), authority: authorityFor('crm') });
  assert.strictEqual(delegationFold.diagnostics.filter((item) => item.code === 'RDL-DLG-021').length, 1,
    `위조된 위임 부여가 지목되어야 합니다: ${JSON.stringify(delegationFold.diagnostics)}`);
  assert.strictEqual(delegationFold.delegations.filter((item) => item.delegationId === forgedDelegation.delegationId).length, 0,
    '위조된 위임이 활성이 되면 안 됩니다.');

  // ── 3. 인가 없는 접기는 불가능하다 ──────────────────────────────────
  // 안전한 경로가 opt-in이면 언젠가 꺼진다. 실제로 rdl check가 껐었다.
  assert.throws(() => foldApprovals([], {}), /인가 컨텍스트/u, '인가 없는 승인 접기는 거부되어야 합니다.');
  assert.throws(() => foldDelegations([], { now: 0 }), /인가 컨텍스트/u, '인가 없는 위임 접기는 거부되어야 합니다.');
  assert.throws(() => require('../src/decision').foldDecisions([], {}), /인가 컨텍스트/u, '인가 없는 결정 접기는 거부되어야 합니다.');

  process.stdout.write('authority tests passed\n');
} finally {
  if (previousHome === undefined) delete process.env.RUNDOL_HOME;
  else process.env.RUNDOL_HOME = previousHome;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
