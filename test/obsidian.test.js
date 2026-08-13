'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initObsidian } = require('../src/obsidian');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-obsidian-'));
try {
  const managed = path.join(temporary, '.rundol', 'obsidian');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(temporary, '.rundol', 'workspace.yaml'), 'documents:\n  root: docs\n');
  fs.writeFileSync(path.join(managed, 'graph.json'), '{"showTags":true}\n');
  const first = initObsidian(temporary);
  assert.deepStrictEqual(first.copied, ['graph.json']);
  const local = path.join(temporary, '.obsidian', 'graph.json');
  fs.writeFileSync(local, '{"showTags":false}\n');
  const preserved = initObsidian(temporary);
  assert.deepStrictEqual(preserved.preserved, ['graph.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(local, 'utf8')).showTags, false);
  const forced = initObsidian(temporary, { force: true });
  assert.deepStrictEqual(forced.copied, ['graph.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(local, 'utf8')).showTags, true);
  process.stdout.write('obsidian init tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
