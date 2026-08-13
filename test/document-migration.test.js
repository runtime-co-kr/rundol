'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalDocumentPath, planMigration, migrateProject } = require('../src/document-migration');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-'));
fs.mkdirSync(path.join(temp, 'docs'), { recursive: true });
fs.mkdirSync(path.join(temp, 'templates'), { recursive: true });
fs.writeFileSync(path.join(temp, 'README.md'), '# 일반 안내\n', 'utf8');
fs.writeFileSync(path.join(temp, 'templates', 'document.md'), '# 템플릿\n', 'utf8');
fs.writeFileSync(path.join(temp, 'docs', 'PRD-001-demo.md'), '---\nid: PRD-001\nrelated:\n  - "[[REQ-001|REQ-001]]"\n---\nSee [[docs/REQ-001-old|REQ-001]].\n', 'utf8');
fs.writeFileSync(path.join(temp, 'docs', 'REQ-001-old.md'), '---\nid: REQ-001\n---\n', 'utf8');
const dry = migrateProject(temp, { apply: false });
assert.strictEqual(dry.dryRun, true);
assert.strictEqual(dry.moves.length, 2);
assert(fs.existsSync(path.join(temp, 'docs', 'PRD-001-demo.md')));
migrateProject(temp, { apply: true });
assert(fs.existsSync(path.join(temp, 'docs', 'prd', 'PRD-001-demo.md')));
assert(fs.existsSync(path.join(temp, 'docs', 'requirements', 'REQ-001-old.md')));
const moved = fs.readFileSync(path.join(temp, 'docs', 'prd', 'PRD-001-demo.md'), 'utf8');
assert(moved.includes('[[REQ-001-old|REQ-001]]'));
assert(!moved.includes('docs/REQ-001-old'));
assert.strictEqual(planMigration(temp).clean, true);
assert.strictEqual(path.basename(canonicalDocumentPath('GLS', temp)), 'glossary');
assert.strictEqual(canonicalDocumentPath('NTE', temp), path.join(temp, 'inbox'));
fs.rmSync(temp, { recursive: true, force: true });

const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-duplicate-'));
fs.mkdirSync(path.join(duplicateRoot, 'docs', 'legacy'), { recursive: true });
fs.writeFileSync(path.join(duplicateRoot, 'docs', 'PRD-001-one.md'), '---\nid: PRD-001\n---\n', 'utf8');
fs.writeFileSync(path.join(duplicateRoot, 'docs', 'legacy', 'PRD-001-two.md'), '---\nid: PRD-001\n---\n', 'utf8');
assert(planMigration(duplicateRoot).conflicts.some((item) => item.id === 'PRD-001'));
assert.throws(() => migrateProject(duplicateRoot, { apply: true }), /PRD-001/u);
fs.rmSync(duplicateRoot, { recursive: true, force: true });

const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-rollback-'));
fs.mkdirSync(path.join(rollbackRoot, 'docs'), { recursive: true });
const rollbackSources = [path.join(rollbackRoot, 'docs', 'PRD-001-one.md'), path.join(rollbackRoot, 'docs', 'REQ-001-two.md')];
for (const file of rollbackSources) fs.writeFileSync(file, `---\nid: ${path.basename(file).slice(0, 7)}\n---\n`, 'utf8');
const originalRename = fs.renameSync;
let moveCount = 0;
fs.renameSync = function failSecondMove(source, target) {
  if (!source.endsWith('.tmp') && ++moveCount === 2) throw new Error('simulated move failure');
  return originalRename(source, target);
};
try {
  assert.throws(() => migrateProject(rollbackRoot, { apply: true }), /simulated move failure/u);
} finally {
  fs.renameSync = originalRename;
}
assert(rollbackSources.every((file) => fs.existsSync(file)));
assert(!fs.existsSync(path.join(rollbackRoot, 'docs', 'prd', 'PRD-001-one.md')));
fs.rmSync(rollbackRoot, { recursive: true, force: true });

const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-validation-'));
fs.mkdirSync(path.join(validationRoot, 'docs'), { recursive: true });
const validationFile = path.join(validationRoot, 'docs', 'PRD-001-one.md');
const validationSource = '---\nid: PRD-001\n---\n원본 바이트 보존\n';
fs.writeFileSync(validationFile, validationSource, 'utf8');
let validationCalls = 0;
assert.throws(() => migrateProject(validationRoot, { apply: true, validate: () => ({ diagnostics: validationCalls++ ? [{ severity: 'error', code: 'NEW', file: 'docs/prd/PRD-001-one.md' }] : [] }) }), /strict validation/u);
assert(fs.existsSync(validationFile));
assert.strictEqual(fs.readFileSync(validationFile, 'utf8'), validationSource);
assert(!fs.existsSync(path.join(validationRoot, 'docs', 'prd')));
assert.strictEqual(fs.readdirSync(path.join(validationRoot, 'docs')).filter((name) => name.endsWith('.tmp')).length, 0);
fs.rmSync(validationRoot, { recursive: true, force: true });
process.stdout.write('document migration tests passed\n');
