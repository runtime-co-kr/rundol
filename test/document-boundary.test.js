'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateBoundaryInput, validateBoundaryMetadata, boundaryGuidance } = require('../src/document-boundary');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');

function command(args) {
  return spawnSync(process.execPath, [cli].concat(args), { cwd: repository, encoding: 'utf8' });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

assert.strictEqual(validateBoundaryInput({ scope: '전체', excludes: ['인접 기능'] }).valid, false);
assert.strictEqual(validateBoundaryInput({ scope: '통합 사용자 흐름', excludes: ['인접 기능'] }).valid, false);
assert.strictEqual(validateBoundaryInput({ scope: '사용자가 항목을 승인하는 동작', excludes: ['없음'] }).valid, false);
assert.strictEqual(validateBoundaryInput({ scope: '사용자가 항목을 승인하는 동작', excludes: [] }).valid, false);
assert.strictEqual(validateBoundaryInput({ scope: '사용자가 항목을 승인하는 동작', excludes: ['항목 생성과 삭제'] }).valid, true);
assert(boundaryGuidance('ADR').primaryResponsibility.includes('단일 결정'));
const partialIssues = validateBoundaryMetadata({ granularity: 'bounded-v1', scope: '통합', excludes: [] });
assert(partialIssues.some((item) => item.code === 'RDL-DOC-013'));
assert(partialIssues.some((item) => item.code === 'RDL-DOC-014'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-boundary-'));
try {
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Rundol Test'], root);
  git(['config', 'user.email', 'rundol@example.test'], root);
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n', 'utf8');
  git(['add', 'README.md'], root);
  git(['commit', '-m', 'initial'], root);

  const initialized = command(['init', 'demo', '--name', '예제 프로젝트', '--profile', 'lean', '--root', root, '--json']);
  assert.strictEqual(initialized.status, 0, initialized.stderr || initialized.stdout);

  const missing = command(['doc', 'create', 'PRD', '예제 제품 요구사항', '--owner', 'MEMBER-001', '--root', root, '--json']);
  assert.strictEqual(missing.status, 2, missing.stderr || missing.stdout);
  assert(missing.stderr.includes('--scope'));

  const created = command([
    'doc', 'create', 'PRD', '예제 제품 요구사항', '--owner', 'MEMBER-001',
    '--scope', '예제 제품의 사용자 문제와 성공 기준', '--exclude', '개별 기능의 상세 동작',
    '--root', root, '--json'
  ]);
  assert.strictEqual(created.status, 0, created.stderr || created.stdout);
  const output = JSON.parse(created.stdout);
  assert.strictEqual(output.boundary.version, 'bounded-v1');
  assert(output.granularityGuidance.splitWhen.length >= 4);
  const source = fs.readFileSync(output.file, 'utf8');
  assert(source.includes('granularity: bounded-v1'));
  assert(source.includes('scope: "예제 제품의 사용자 문제와 성공 기준"'));
  assert(source.includes('  - "개별 기능의 상세 동작"'));

  fs.writeFileSync(output.file, source.replace('scope: "예제 제품의 사용자 문제와 성공 기준"', 'scope: "통합"'), 'utf8');
  const checked = command(['check', 'PRD-001', '--strict', '--project', 'demo', '--root', root, '--json']);
  assert.strictEqual(checked.status, 1, checked.stderr || checked.stdout);
  const diagnostics = JSON.parse(checked.stdout).diagnostics;
  assert(diagnostics.some((item) => item.code === 'RDL-DOC-013' && item.artifactId === 'PRD-001'));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write('document boundary tests passed\n');
