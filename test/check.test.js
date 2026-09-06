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

// state 칸이 나눠 쓰던 두 축을 가른 뒤의 값 판정.
//
// 심각도가 축마다 다르고, 그 차이가 이 갈래의 결정이므로 값으로 못박는다. 두 칸의
// 판정문은 거의 같아 보이므로, 나중에 "일관되게" 맞추려는 손이 반드시 온다. 그때
// 이 시험이 먼저 걸려야 한다 — 심각도는 무엇이 잘못됐나가 아니라 누가 고칠 수
// 있나로 갈렸고, 두 칸은 그 답이 다르다.
function testStateAndLifecycleVocabulary() {
  const { checkStateVocabulary } = require('../src/check-rules');
  const { DOCUMENT_STATE_KEYS, DOCUMENT_LIFECYCLE_KEYS } = require('../src/vocabulary');
  const judge = (data) => {
    const list = [];
    checkStateVocabulary(list, { relativeFile: 'docs/REQ-001-x.md', frontmatter: { data, locations: { state: 8, lifecycle: 9 } } }, 'REQ-001');
    return list;
  };

  // 비어 있는 lifecycle이 정상이다. 대부분의 문서는 수명을 따로 말할 것이 없고,
  // 없는 것과 active는 다르다 — 없음을 진단하면 그 둘이 같아진다.
  assert.deepStrictEqual(judge({ state: 'draft' }), [], '수명을 적지 않은 문서는 정상입니다.');
  assert.deepStrictEqual(judge({ state: 'draft', lifecycle: null }), [], 'null도 적지 않은 것입니다.');
  for (const value of DOCUMENT_LIFECYCLE_KEYS) {
    assert.deepStrictEqual(judge({ state: 'draft', lifecycle: value }), [], `${value}는 어휘 안입니다.`);
  }
  for (const value of DOCUMENT_STATE_KEYS) {
    assert.deepStrictEqual(judge({ state: value }), [], `${value}는 어휘 안입니다.`);
  }

  // 어휘 밖 lifecycle은 오류다. 사람이 소유한 칸이라 아무것도 이 값을 굴리지 않고,
  // 낫지 않는 오타는 그 문서를 수명 조회에서 영영 빼놓는다.
  const strayLifecycle = judge({ state: 'draft', lifecycle: 'retired' });
  assert.deepStrictEqual(strayLifecycle.map((item) => [item.code, item.severity, item.line]), [['RDL-DOC-017', 'error', 9]],
    '어휘 밖 수명은 그 값이 적힌 줄에서 오류여야 합니다.');

  // 값 없는 `lifecycle:` 한 줄은 없는 것과 다르다. frontmatter 파서가 그것을 빈
  // 배열로 읽으므로, 없음으로 접으면 적다 만 줄이 정상으로 보인다.
  assert.deepStrictEqual(judge({ state: 'draft', lifecycle: [] }).map((item) => item.code), ['RDL-DOC-017'],
    '값을 적지 않은 lifecycle 줄은 비워 둔 것이 아닙니다.');

  // 어휘 밖 state는 경고다. rdl이 소유하는 칸이고 사람은 이 값을 적는 자리에 있지
  // 않으며, 다음 투영이 덮어써 스스로 낫는다. 오류로 막으면 아직 이관하지 않은
  // 저장소가 판올림만으로 전 문서에서 멈추고 — 이 저장소의 정본만 해도 73건이
  // 어휘 밖이었다 — 막힌 사람이 할 수 있는 일은 소유하지도 않은 칸을 손으로
  // 고치는 것뿐이다. 그리고 모든 문서에서 터지는 관문은 곧 꺼진다.
  const legacyState = judge({ state: 'accepted' });
  assert.deepStrictEqual(legacyState.map((item) => [item.code, item.severity, item.line]), [['RDL-DOC-018', 'warning', 8]],
    '어휘 밖 상태는 경고여야 합니다. 소유하지 않은 칸으로 사람을 막지 않습니다.');
  assert(legacyState[0].message.includes('rdl doc migrate'), '막지 않는 대신 갈 길을 말해야 합니다.');

  // 두 칸은 서로를 가리지 않는다. 한 번에 둘 다 어긋난 문서는 둘 다 듣는다.
  assert.deepStrictEqual(judge({ state: 'unread', lifecycle: 'retired' }).map((item) => item.code).sort(),
    ['RDL-DOC-017', 'RDL-DOC-018'], '두 축은 따로 판정합니다.');
}

testStateAndLifecycleVocabulary();
testUpstreamTrustJudgment();
testTmsFixture();
testMissingReference();
testLegacySpecIsRejectedInStrictMode();
testAliasIsNotAFileTarget();
testProjectGovernanceCannotBeSkipped();
testInvalidDriverShardIsDiagnosed();
process.stdout.write('check tests passed\n');
