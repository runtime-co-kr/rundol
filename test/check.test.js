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

testTmsFixture();
testMissingReference();
testLegacySpecIsRejectedInStrictMode();
testAliasIsNotAFileTarget();
testProjectGovernanceCannotBeSkipped();
testInvalidDriverShardIsDiagnosed();
process.stdout.write('check tests passed\n');
