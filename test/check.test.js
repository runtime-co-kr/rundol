'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { initializeWorkspace } = require('../src/init');
const { initState } = require('../src/state');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

function run(args) {
  return spawnSync(process.execPath, [cli].concat(args), { cwd: root, encoding: 'utf8' });
}

function testTmsFixture() {
  const result = run(['check', '--root', 'test/fixtures/workspace', '--json']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.summary.documents, 16);
  assert.strictEqual(output.summary.tasks, 11);
  assert.strictEqual(output.summary.errors, 0);
  // Workspace 루트가 Git 최상위가 아니면 코드 브랜치 결박은 이 Workspace의 것이 아니다.
  // 픽스처는 이 저장소 안에 있으므로, 세면 바깥 저장소의 커밋이 픽스처의 결박으로
  // 보고되고 그 저장소의 태스크를 모르니 전부 끊긴 결박이 된다.
  assert.strictEqual(output.summary.taskBinding.code, undefined, '남의 저장소 이력을 자기 결박으로 세지 않는다');
}

function testMissingReference() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-check-'));
  fs.mkdirSync(path.join(temp, '.rundol'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(temp, '.rundol', 'workspace.yaml'), 'documents:\n  root: docs\ntasks:\n  path: tasks.json\n');
  fs.writeFileSync(path.join(temp, 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: {} }));
  fs.writeFileSync(path.join(temp, 'docs', 'REQ-001-로그인-요구사항.md'), `---
id: REQ-001
type: document
kind: requirement
title: 로그인 요구사항
description: 사용자가 계정으로 로그인할 수 있어야 한다.
owner: "[[PRJ-001#^MEMBER-001|담당자]]"
state: active
tags:
  - rundol/artifact
  - artifact/requirement
  - domain/auth
  - feature/login
aliases:
  - REQ-001
related:
  - "[[REQ-999]]"
---
# 로그인 요구사항
`);
  const result = run(['check', '--root', temp, '--json']);
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert(output.diagnostics.some((item) => item.code === 'RDL-LINK-002' && item.target === 'REQ-999'));
  fs.rmSync(temp, { recursive: true, force: true });
}

function testAliasIsNotAFileTarget() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-alias-'));
  fs.mkdirSync(path.join(temp, '.rundol'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(temp, '.rundol', 'workspace.yaml'), 'documents:\n  root: docs\ntasks:\n  path: tasks.json\n');
  fs.writeFileSync(path.join(temp, 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: {} }));
  fs.writeFileSync(path.join(temp, 'docs', 'PRJ-001-인증-프로젝트.md'), `---
id: PRJ-001
type: document
kind: project-charter
title: 인증 프로젝트
description: 인증 프로젝트를 정의한다.
owner: "[[PRJ-001-인증-프로젝트#^MEMBER-001|담당자]]"
state: active
tags:
  - rundol/artifact
  - artifact/project-charter
  - domain/auth
  - feature/login
aliases:
  - PRJ-001
related: []
---
# 인증 프로젝트
### 담당자 ^MEMBER-001
`);
  fs.writeFileSync(path.join(temp, 'docs', 'PRD-001-인증-제품요구사항.md'), `---
id: PRD-001
type: document
kind: prd
title: 인증 제품 요구사항
description: 인증 제품 요구사항을 정의한다.
owner: "[[PRJ-001-인증-프로젝트#^MEMBER-001|담당자]]"
state: active
tags:
  - rundol/artifact
  - artifact/prd
  - domain/auth
  - feature/login
aliases:
  - PRD-001
related:
  - "[[PRJ-001]]"
---
# 인증 제품 요구사항
`);
  const result = run(['check', '--root', temp, '--json']);
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert(output.diagnostics.some((item) => item.code === 'RDL-LINK-006' && item.target === 'PRJ-001'));
  fs.rmSync(temp, { recursive: true, force: true });
}

function testLegacySpecIsRejectedInStrictMode() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-legacy-spec-'));
  fs.mkdirSync(path.join(temp, '.rundol'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(temp, '.rundol', 'workspace.yaml'), 'documents:\n  root: docs\ntasks:\n  path: tasks.json\n');
  fs.writeFileSync(path.join(temp, 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: {} }));
  fs.writeFileSync(path.join(temp, 'docs', 'SPC-001-이전-기능명세.md'), `---
id: SPC-001
type: document
kind: spec
title: 이전 기능 명세
description: 이전 문서 유형의 엄격 검사를 확인한다.
owner: "[[PRJ-001#^MEMBER-001|담당자]]"
state: active
tags:
  - rundol/artifact
  - artifact/spec
  - domain/test
  - feature/legacy-spec
aliases:
  - SPC-001
related: []
---
# 이전 기능 명세
`);
  const result = run(['check', '--root', temp, '--strict', '--json']);
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert(output.diagnostics.some((item) => item.code === 'RDL-DOC-010' && item.artifactId === 'SPC-001'));
  fs.rmSync(temp, { recursive: true, force: true });
}

function testProjectGovernanceCannotBeSkipped() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-governance-'));
  fs.mkdirSync(path.join(temp, '.rundol'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(temp, '.rundol', 'workspace.yaml'), 'documents:\n  root: docs\ntasks:\n  path: tasks.json\n');
  fs.writeFileSync(path.join(temp, 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: {} }));
  fs.writeFileSync(path.join(temp, 'docs', 'PRJ-001-간소화-프로젝트.md'), `---
id: PRJ-001
type: document
kind: project-charter
title: 간소화 프로젝트
description: 필수 거버넌스가 누락된 프로젝트다.
owner: "[[PRJ-001-간소화-프로젝트#^MEMBER-001|담당자]]"
state: active
tags:
  - rundol/artifact
  - artifact/project-charter
  - domain/test
  - feature/governance
aliases:
  - PRJ-001
related: []
---
# 간소화 프로젝트
## 미션
작은 프로젝트다.
### 담당자 ^MEMBER-001
`);
  const result = run(['check', '--root', temp, '--json']);
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert(output.diagnostics.some((item) => item.code === 'RDL-GOV-001' && item.message.includes('이해관계자')));
  assert(output.diagnostics.some((item) => item.code === 'RDL-GOV-002' && item.message.includes('ROLE')));
  assert(output.diagnostics.some((item) => item.code === 'RDL-GOV-003' && item.target === 'MEMBER-001'));
  fs.rmSync(temp, { recursive: true, force: true });
}

function testInvalidDriverShardIsDiagnosed() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-check-driver-'));
  try {
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Rundol Test'], ['config', 'user.email', 'rundol@example.test']]) {
      const result = spawnSync('git', args, { cwd: temp, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
    }
    fs.writeFileSync(path.join(temp, 'README.md'), '# test\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: temp });
    assert.strictEqual(spawnSync('git', ['commit', '-m', 'initial'], { cwd: temp }).status, 0);
    initializeWorkspace(temp, 'demo', 'Demo');
    initState(temp, { project: 'demo' });
    const driverRoot = path.join(temp, 'projects', 'workspace', 'events', 'driver');
    fs.mkdirSync(driverRoot, { recursive: true });
    fs.writeFileSync(path.join(driverRoot, 'driver-invalid.jsonl'), '{}\n', 'utf8');
    const result = run(['check', '--root', temp, '--json']);
    const output = JSON.parse(result.stdout);
    assert(output.diagnostics.some((item) => item.code === 'RDL-DRIVER-010'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// 하류가 상류 확정보다 앞서 있는가. 판정은 값만 보므로 작업공간 없이 시험한다 —
// 이 규칙이 파일에 묶이면 check와 보드와 파이프라인 점검이 각자 다시 구현하게 된다.
function testUpstreamTrustJudgment() {
  const { upstreamTrustIssues, upstreamTypes, documentLayer } = require('../src/check-rules');

  // 방향은 유형이 정한다. 표를 여기서 다시 적지 않고 판정이 무엇을 상류로 보는지만 본다.
  assert.deepStrictEqual(upstreamTypes('SCR'), ['PRD', 'REQ'], 'SCR의 상류는 REQ와 그 위의 PRD입니다.');
  assert.deepStrictEqual(upstreamTypes('PRD'), [], '가장 위에는 상류가 없습니다.');
  assert.strictEqual(documentLayer('SCR'), 2);
  assert.strictEqual(documentLayer('PRJ'), null, '정규 유형이 아니면 층이 없습니다.');

  const documents = [
    { id: 'PRD-001', file: 'docs/PRD-001.md', related: [] },
    { id: 'REQ-001', file: 'docs/REQ-001.md', related: ['[[PRD-001-제품-요구|PRD-001]]'] },
    { id: 'SCR-001', file: 'docs/SCR-001.md', related: ['[[REQ-001-로그인-요구|REQ-001]]'] }
  ];

  // ① 승인 축을 한 번도 쓰지 않은 프로젝트에서는 울지 않는다. 전 문서가 미승인인 것은
  // 상태가 아니라 그 축을 안 쓴다는 뜻이고, 그것을 경고로 읽으면 첫날부터 전건이 쏟아진다.
  //
  // 거르는 자리가 규칙 안이다. 한때 표면이 used를 보고 걸렀는데, 그러면 낡은 상류까지
  // 함께 죽는다 — 그것은 축을 굴리든 놓았든 누군가 승인한 것이 흔들린 사건이다.
  const none = upstreamTrustIssues({
    documents, trust: { 'PRD-001': 'unapproved', 'REQ-001': 'unapproved', 'SCR-001': 'unapproved' }
  });
  assert.strictEqual(none.used, false, '살아 있는 승인이 없으면 승인 축을 굴리는 프로젝트가 아닙니다.');
  assert.strictEqual(none.issues.length, 0, '미승인 상류는 규칙이 스스로 거릅니다.');

  // ①-2 낡음만 있고 승인이 하나도 없는 프로젝트. 문턱은 미승인 상류에만 걸리므로
  // 낡은 상류는 그대로 운다. 런돌 자신의 프로젝트(승인 0·낡음 2·미승인 131)가 이 모양이고,
  // 여기서 미승인까지 울렸을 때 rdl check의 경고가 2건에서 121건이 됐다.
  const retired = upstreamTrustIssues({
    documents, trust: { 'PRD-001': 'stale', 'REQ-001': 'unapproved', 'SCR-001': 'unapproved' }
  });
  assert.strictEqual(retired.used, false, '낡음은 예전에 승인했다는 뜻이지 지금 굴린다는 뜻이 아닙니다.');
  assert.deepStrictEqual(retired.issues.map((issue) => [issue.artifactId, issue.target, issue.code]),
    [['REQ-001', 'PRD-001', 'RDL-APPROVE-030']], '낡은 상류는 문턱 밖이라 그대로 웁니다.');

  // ② 낡음과 미승인은 다른 코드로 운다. 앞엣것은 "근거로 삼은 것이 바뀌었다"이고
  // 뒤엣것은 "아직 확정되지 않은 것 위에 섰다"라 사람이 볼 순서가 다르다.
  const mixed = upstreamTrustIssues({
    documents, trust: { 'PRD-001': 'stale', 'REQ-001': 'approved', 'SCR-001': 'unapproved' }
  });
  assert.strictEqual(mixed.used, true);
  assert.deepStrictEqual(mixed.issues.map((issue) => [issue.artifactId, issue.target, issue.code]),
    [['REQ-001', 'PRD-001', 'RDL-APPROVE-030']], '낡은 상류를 가리키는 하류만 걸립니다.');

  const pending = upstreamTrustIssues({
    documents, trust: { 'PRD-001': 'approved', 'REQ-001': 'unapproved', 'SCR-001': 'unapproved' }
  });
  assert.deepStrictEqual(pending.issues.map((issue) => [issue.artifactId, issue.target, issue.code]),
    [['SCR-001', 'REQ-001', 'RDL-APPROVE-031']], '미승인 상류는 다른 코드로 웁니다.');
  assert(pending.issues.every((issue) => issue.severity === 'warning'), '이 규칙은 언제나 권고입니다.');

  // ③ 상류가 다시 승인되면 그친다.
  const settled = upstreamTrustIssues({
    documents, trust: { 'PRD-001': 'approved', 'REQ-001': 'approved', 'SCR-001': 'unapproved' }
  });
  assert.deepStrictEqual(settled.issues, [], '상류가 전부 승인되면 하류는 앞선 것이 아닙니다.');

  // 방향이 있다. 상류가 하류를 가리켜도 그것은 상류가 미승인인 것이 아니다.
  const reversed = upstreamTrustIssues({
    documents: [{ id: 'PRD-001', file: 'docs/PRD-001.md', related: ['[[SCR-001-로그인-화면|SCR-001]]'] }],
    trust: { 'PRD-001': 'approved', 'SCR-001': 'unapproved' }
  });
  assert.deepStrictEqual(reversed.issues, [], 'related는 방향이 없지만 유형 계층은 방향을 갖습니다.');

  // 해결되지 않는 참조는 여기서 말하지 않는다. 링크 계층의 RDL-LINK-002가 이미 답한다.
  const dangling = upstreamTrustIssues({
    documents: [{ id: 'SCR-001', file: 'docs/SCR-001.md', related: ['[[REQ-999]]'] }, { id: 'PRD-001', file: 'docs/PRD-001.md', related: [] }],
    trust: { 'PRD-001': 'approved', 'SCR-001': 'unapproved' }
  });
  assert.deepStrictEqual(dangling.issues, [], '없는 대상은 미승인 상류가 아닙니다.');
}

testUpstreamTrustJudgment();
testTmsFixture();
testMissingReference();
testLegacySpecIsRejectedInStrictMode();
testAliasIsNotAFileTarget();
testProjectGovernanceCannotBeSkipped();
testInvalidDriverShardIsDiagnosed();
process.stdout.write('check tests passed\n');
