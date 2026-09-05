'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initObsidian, renderReviewView, writeReviewView } = require('../src/obsidian');

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

// ── 검토 리포트 뷰 ──────────────────────────────────────────────────────────
//
// 승인 감사를 정본 frontmatter에 쓰지 않는다는 것이 이 뷰의 존재 이유다. 그래서
// 시험도 "뷰가 만들어졌다"보다 "정본을 건드리지 않았다"를 먼저 본다.

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-review-view-'));
try {
  const workspaceDirectory = path.join(vault, 'projects', 'workspace');
  fs.mkdirSync(path.join(workspaceDirectory, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDirectory, 'workspace.yaml'), 'schemaVersion: 6\nmount: projects\n', 'utf8');
  fs.writeFileSync(path.join(workspaceDirectory, 'projects', 'project-crm.yaml'), 'key: crm\nname: CRM\nmount: projects/crm\nref: refs/heads/rundol/crm\n', 'utf8');
  const projectRoot = path.join(vault, 'projects', 'crm');
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  const canonical = path.join(projectRoot, 'docs', 'ADR-001-결정.md');
  const canonicalSource = '---\nid: ADR-001\ntype: ADR\ntitle: 결정\nstate: draft\n---\n\n# 결정\n';
  fs.writeFileSync(canonical, canonicalSource, 'utf8');

  const report = {
    project: 'crm',
    generatedAt: '2026-09-05T00:00:00.000Z',
    counts: { approved: 1, stale: 2, unapproved: 3 },
    total: 6,
    pending: 5,
    stale: [],
    unapproved: [],
    diagnostics: []
  };

  const rendered = renderReviewView(report, '# 검토 리포트 — crm\n\n본문\n');
  assert(rendered.startsWith('---\ngenerated: review-v1\n'), '파생 뷰임을 frontmatter가 먼저 말해야 합니다.');
  assert(rendered.includes('stale: 2'));
  assert(rendered.includes('unapproved: 3'));
  // 태그가 없으면 옵시디언에서 이 한 장을 찾아가는 길이 경로 하나뿐이고, 그건 CLI를
  // 치는 것과 다르지 않다.
  assert(rendered.includes('  - rundol/review'));
  assert(rendered.includes('정본이 아니다'), '정본이 아님을 파일 안에서 밝혀야 합니다.');
  assert(rendered.includes('본문'));

  const first = writeReviewView(vault, report, '# 검토 리포트 — crm\n\n본문\n');
  assert.strictEqual(first.relativeFile, 'projects/crm/views/review.md', 'contract diagram --write와 같은 자리를 써야 합니다.');
  assert.strictEqual(first.changed, true);
  assert.strictEqual(first.ignored, true, '파생 뷰 자리는 Git-ignore되어야 합니다.');
  assert(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8').includes('views/'));
  assert(fs.existsSync(first.file));

  // 정본은 그대로다. 승인 메타를 문서에 쓰면 그 쓰기가 콘텐츠 해시를 바꿔 방금 한
  // 승인을 스스로 낡게 만든다 — 그래서 이 명령은 정본을 건드리지 않는다.
  assert.strictEqual(fs.readFileSync(canonical, 'utf8'), canonicalSource, '검토 뷰가 정본 문서를 건드리면 안 됩니다.');

  // generatedAt은 매번 달라진다. 그것만으로 "바뀜"이 되면 그 값으로는 검토할 것이
  // 실제로 늘었는지 알 수 없다. 판정은 frontmatter를 뺀 본문으로 한다.
  const again = writeReviewView(vault, Object.assign({}, report, { generatedAt: '2026-09-06T00:00:00.000Z' }), '# 검토 리포트 — crm\n\n본문\n');
  assert.strictEqual(again.changed, false, '본문이 같으면 생성 시각만 달라도 바뀐 것이 아닙니다.');
  assert(fs.readFileSync(again.file, 'utf8').includes('generatedAt: 2026-09-06T00:00:00.000Z'), '언제 기준인지는 매번 새로 적어야 합니다.');

  const moved = writeReviewView(vault, report, '# 검토 리포트 — crm\n\n다른 본문\n');
  assert.strictEqual(moved.changed, true);

  process.stdout.write('obsidian review view tests passed\n');
} finally {
  fs.rmSync(vault, { recursive: true, force: true });
}
