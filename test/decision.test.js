'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  KINDS,
  decisionKey,
  decisionIdFor,
  normalizeDecisionEvent,
  decisionEnvelope,
  foldDecisions,
  listDecisions,
  requestDecision,
  answerDecision
} = require('../src/decision');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-decision-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

function requestEvent(overrides) {
  const key = decisionKey({ kind: 'release-version', project: 'crm', subject: 'v0.30.0' });
  return Object.assign({
    schemaVersion: 1,
    eventId: 'EVT-11111111111111111111',
    type: 'decision.requested',
    rootRequestId: 'REQ-11111111111111111111',
    requestId: 'REQ-22222222222222222222',
    clientId: 'agent-a',
    projectId: 'crm',
    decisionId: decisionIdFor(key),
    decisionKey: key,
    kind: 'release-version',
    question: '이 델타의 릴리스 버전을 무엇으로 할까요?',
    options: [{ id: 'minor', label: '0.30.0 — 명령 추가' }, { id: 'patch', label: '0.29.1 — 수정만' }],
    recommendation: { option: 'minor', because: '새 명령이 추가되어 patch 범위를 넘습니다' },
    impact: { reversible: false, blast: '패키지 공개' },
    evidence: ['CHANGELOG [Unreleased]']
  }, overrides || {});
}

function answerEvent(overrides) {
  const key = decisionKey({ kind: 'release-version', project: 'crm', subject: 'v0.30.0' });
  return Object.assign({
    schemaVersion: 1,
    eventId: 'EVT-33333333333333333333',
    type: 'decision.answered',
    rootRequestId: 'REQ-33333333333333333333',
    requestId: 'REQ-44444444444444444444',
    clientId: 'desk-b',
    projectId: 'crm',
    decisionId: decisionIdFor(key),
    decisionKey: key,
    kind: 'release-version',
    selectedOption: 'minor',
    answeredBy: 'MEMBER-001',
    reason: '새 명령이 포함되어 마이너가 맞습니다'
  }, overrides || {});
}

try {
  // 카탈로그: 위임이 성립하지 않는 결정은 정책으로 고정된다.
  assert.strictEqual(KINDS.publish.delegable, false, '배포는 위임 불가여야 합니다.');
  assert.strictEqual(KINDS['pr-merge'].delegable, false, '병합은 생성과 다른 등급이어야 합니다.');
  assert.strictEqual(KINDS['pr-open'].delegable, true);
  for (const kind of ['force-takeover', 'force-resolve', 'gate-bypass', 'delegation-grant']) assert.strictEqual(KINDS[kind].delegable, false, `${kind}는 위임 불가여야 합니다.`);

  // 결정 키는 종류·범위·대상의 함수다 — 같은 결정이면 어느 클라이언트에서 만들어도 같다.
  const key = decisionKey({ kind: 'release-version', project: 'crm', subject: 'v0.30.0' });
  assert.strictEqual(key, decisionKey({ kind: 'release-version', project: 'crm', subject: 'v0.30.0' }));
  assert.notStrictEqual(key, decisionKey({ kind: 'release-version', project: 'crm', subject: 'v0.31.0' }));
  assert.match(decisionIdFor(key), /^DEC-[A-F0-9]{20}$/u);
  assert.throws(() => decisionKey({ kind: 'unknown-kind', project: 'crm', subject: 'x' }), /등록되지 않은 결정 종류/u);

  // 권고 없는 질문은 요청이 아니다. 선택지는 닫힌 목록이어야 한다.
  assert.throws(() => normalizeDecisionEvent(requestEvent({ recommendation: undefined })), /recommendation.*필요|권고안이 필요/u);
  assert.throws(() => normalizeDecisionEvent(requestEvent({ recommendation: { option: 'none', because: 'x' } })), /권고안이 선택지에 없습니다/u);
  assert.throws(() => normalizeDecisionEvent(requestEvent({ options: [{ id: 'only', label: '하나' }] })), /선택지는 2개 이상/u);
  assert.throws(() => normalizeDecisionEvent(requestEvent({ transcript: '금지' })), /알 수 없는 필드/u);
  assert.match(decisionEnvelope(requestEvent()).canonicalDigest, /^[a-f0-9]{64}$/u);

  // 무응답의 기본은 정지다 — 요청만 있으면 열린 상태로 남는다.
  const openFold = foldDecisions([requestEvent()], { members: ['MEMBER-001'] });
  assert.strictEqual(openFold.open.length, 1);
  assert.strictEqual(openFold.decisions[0].status, 'open');
  assert.strictEqual(openFold.decisions[0].selectedOption, null);

  // 다른 클라이언트의 권한 있는 답변이 결정을 해소한다.
  const answered = foldDecisions([requestEvent(), answerEvent()], { members: ['MEMBER-001'] });
  assert.strictEqual(answered.open.length, 0);
  assert.strictEqual(answered.decisions[0].status, 'answered');
  assert.strictEqual(answered.decisions[0].selectedOption, 'minor');
  assert.strictEqual(answered.decisions[0].answeredBy, 'MEMBER-001');

  // 등록되지 않은 답변자와 선택지 밖의 값은 해소하지 못하고 진단으로 남는다.
  const intruder = foldDecisions([requestEvent(), answerEvent({ answeredBy: 'MEMBER-404' })], { members: ['MEMBER-001'] });
  assert.strictEqual(intruder.open.length, 1, '권한 없는 답변이 결정을 해소하면 안 됩니다.');
  assert(intruder.diagnostics.some((item) => item.code === 'RDL-DEC-002'));
  const invalidOption = foldDecisions([requestEvent(), answerEvent({ selectedOption: 'major' })], { members: ['MEMBER-001'] });
  assert.strictEqual(invalidOption.open.length, 1);
  assert(invalidOption.diagnostics.some((item) => item.code === 'RDL-DEC-017'));

  // fold는 열거 순서의 함수가 아니다.
  const forward = foldDecisions([requestEvent(), answerEvent()], { members: ['MEMBER-001'] });
  const reversed = foldDecisions([answerEvent(), requestEvent()], { members: ['MEMBER-001'] });
  assert.deepStrictEqual(reversed.decisions, forward.decisions, '결정 fold가 열거 순서에 의존하면 안 됩니다.');

  // 실제 Workspace 경로: 요청·조회·응답과 재질문 방지.
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# decision\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'desk-b', '--name', 'Desk B', '--type', 'device', '--owner', 'MEMBER-001']);

  const requestInput = {
    project: 'crm', clientId: 'agent-a', kind: 'release-version', subject: 'v0.30.0',
    question: '이 델타의 릴리스 버전을 무엇으로 할까요?',
    options: [{ id: 'minor', label: '0.30.0' }, { id: 'patch', label: '0.29.1' }],
    recommendation: { option: 'minor', because: '새 명령이 추가되었습니다' },
    impact: { reversible: false, blast: '패키지 공개' }
  };
  const created = requestDecision(temporary, requestInput);
  assert.strictEqual(created.created, true);
  assert.strictEqual(created.decision.status, 'open');
  // 같은 결정을 다시 요청해도 새 요청이 생기지 않는다.
  const repeated = requestDecision(temporary, requestInput);
  assert.strictEqual(repeated.created, false, '같은 결정이 재질문되면 안 됩니다.');
  assert.strictEqual(repeated.decision.decisionId, created.decision.decisionId);
  assert.strictEqual(listDecisions(temporary, { project: 'crm', open: true }).decisions.length, 1);

  // 요청하지 않은 클라이언트가 답하고, 그 답이 공유 원장에서 읽힌다.
  assert.throws(() => answerDecision(temporary, { project: 'crm', clientId: 'desk-b', decisionId: created.decision.decisionId, selectedOption: 'major', answeredBy: 'MEMBER-001', reason: 'x' }), /선택지에 없는 값/u);
  assert.throws(() => answerDecision(temporary, { project: 'crm', clientId: 'desk-b', decisionId: created.decision.decisionId, selectedOption: 'minor', answeredBy: 'MEMBER-404', reason: 'x' }), /등록된 멤버만/u);
  const resolved = answerDecision(temporary, { project: 'crm', clientId: 'desk-b', decisionId: created.decision.decisionId, selectedOption: 'minor', answeredBy: 'MEMBER-001', reason: '새 명령이 포함되어 마이너가 맞습니다' });
  assert.strictEqual(resolved.decision.status, 'answered');
  assert.strictEqual(resolved.decision.answeredBy, 'MEMBER-001');
  assert.strictEqual(listDecisions(temporary, { project: 'crm', open: true }).decisions.length, 0);
  // 이미 답한 결정을 다시 요청하면 기존 답이 그대로 적용된다.
  const afterAnswer = requestDecision(temporary, requestInput);
  assert.strictEqual(afterAnswer.created, false);
  assert.strictEqual(afterAnswer.decision.selectedOption, 'minor');

  // CLI 표면과 검사 진단.
  const listed = rdl(['decision', 'list', '--project', 'crm']);
  assert.strictEqual(listed.total, 1);
  assert.strictEqual(listed.decisions[0].status, 'answered');
  const kinds = rdl(['decision', 'kinds']);
  assert.strictEqual(kinds.kinds.find((item) => item.kind === 'publish').delegable, false);
  const checked = rdl(['check']);
  assert.strictEqual(checked.summary.errors, 0, JSON.stringify(checked.diagnostics));

  const shardRoot = path.join(temporary, 'projects', 'workspace', 'events', 'decision');
  fs.writeFileSync(path.join(shardRoot, 'not-a-decision.jsonl'), '{}\n', 'utf8');
  const malformed = spawnSync(process.execPath, [cli, 'check', '--root', temporary, '--json'], { cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  const codes = new Set(JSON.parse(malformed.stdout).diagnostics.map((item) => item.code));
  assert(codes.has('RDL-DEC-010'), '결정 샤드 파일명 진단이 필요합니다.');

  process.stdout.write('decision tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
