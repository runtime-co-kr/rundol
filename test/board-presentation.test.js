'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_PRESENTATION, readConfig, mergePresentation,
  renderWorkspaceBoardConfig, renderProjectBoardConfig
} = require('../src/board-presentation');

const merged = mergePresentation(JSON.parse(JSON.stringify(DEFAULT_PRESENTATION)), {
  schemaVersion: 1,
  documentTypes: { prd: { label: '프로젝트 제품 요구사항' } },
  documentStates: { draft: { order: 99 } }
});
assert.strictEqual(merged.documentTypes.prd.label, '프로젝트 제품 요구사항');
assert.strictEqual(merged.documentTypes.prd.description, DEFAULT_PRESENTATION.documentTypes.prd.description);
assert.strictEqual(merged.documentStates.draft.order, 99);
assert.strictEqual(JSON.parse(renderWorkspaceBoardConfig()).documentTypes.requirement.label, '요구사항');
assert.deepStrictEqual(JSON.parse(renderProjectBoardConfig()), { schemaVersion: 1, documentTypes: {}, documentStates: {} });

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-board-presentation-'));
try {
  const valid = path.join(temporary, 'valid.json');
  fs.writeFileSync(valid, JSON.stringify({ schemaVersion: 1, documentTypes: { prd: { label: '제품 명세' } }, documentStates: {} }), 'utf8');
  assert.strictEqual(readConfig(valid).documentTypes.prd.label, '제품 명세');
  const unknown = path.join(temporary, 'unknown.json');
  fs.writeFileSync(unknown, JSON.stringify({ schemaVersion: 1, documentTypes: { custom: { label: '사용자 정의' } } }), 'utf8');
  assert.throws(() => readConfig(unknown), /지원하지 않는 documentTypes 키/u);
  const invalid = path.join(temporary, 'invalid.json');
  fs.writeFileSync(invalid, '{', 'utf8');
  assert.throws(() => readConfig(invalid), /올바른 JSON/u);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('board presentation tests passed\n');
