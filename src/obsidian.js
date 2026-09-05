'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'docs', 'templates');

function atomicCopy(source, target) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, target);
}

function atomicWrite(target, content) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, target);
}

function initObsidian(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  const project = layout.schemaVersion >= 3 ? selectProject(layout, settings.project, true) : null;
  const legacySettings = path.join(layout.root, '.rundol', 'settings', 'obsidian');
  const legacySource = path.join(layout.root, '.rundol', 'obsidian');
  const sourceDirectory = project ? (fs.existsSync(legacySettings) ? legacySettings : TEMPLATE_ROOT) : legacySource;
  const targetDirectory = path.join(project ? project.root : layout.root, '.obsidian');
  if (!fs.existsSync(sourceDirectory)) throw new Error(`Obsidian 설정 원본을 찾지 못했습니다: ${sourceDirectory}`);
  fs.mkdirSync(targetDirectory, { recursive: true });
  if (project) for (const directory of ['assets', 'inbox', 'templates']) fs.mkdirSync(path.join(project.root, directory), { recursive: true });
  const copied = [];
  const preserved = [];
  const templateNames = new Map([['OBSIDIAN-APP.template.json', 'app.json'], ['OBSIDIAN-CORE-PLUGINS.template.json', 'core-plugins.json'], ['OBSIDIAN-GRAPH.template.json', 'graph.json'], ['OBSIDIAN-TEMPLATES.template.json', 'templates.json']]);
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const source = path.join(sourceDirectory, entry.name);
    const targetName = templateNames.get(entry.name) || entry.name;
    if (sourceDirectory === TEMPLATE_ROOT && !templateNames.has(entry.name)) continue;
    const target = path.join(targetDirectory, targetName);
    if (fs.existsSync(target) && !settings.force) {
      preserved.push(targetName);
      continue;
    }
    const content = fs.readFileSync(source, 'utf8').replaceAll('<프로젝트키>', project ? project.key : 'project');
    JSON.parse(content);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, target);
    copied.push(targetName);
  }
  return { root: layout.root, project: project ? project.key : null, vault: project ? project.root : layout.root, source: sourceDirectory, target: path.relative(layout.root, targetDirectory).split(path.sep).join('/'), copied, preserved, forced: settings.force === true };
}

// ── 검토 리포트 뷰 ──────────────────────────────────────────────────────────
//
// 승인 감사를 문서 frontmatter에 쓰지 않는다. 문서 revision은 frontmatter까지 포함한
// 콘텐츠 해시라, 승인 메타를 문서에 쓰면 승인 행위 자체가 리비전을 바꿔 방금 한
// 승인을 낡게 만든다 — "내용은 그대로인데 낡음"이라는 자기모순이다. 게다가 본문에
// 있는 감사 기록은 손으로 고쳐 위조되고, 그러면 원장이 단일 진실 원천이 아니게 된다.
//
// 대신 파생 뷰 한 장으로 낸다. 자리와 규칙은 rdl contract diagram --write가 이미
// 쓰는 것을 그대로 쓴다 — Vault 루트의 views/, Git-ignore, 정본이 아님을 파일 첫
// 문단에 밝힘. 자리를 새로 만들면 규칙도 새로 만들어야 하고, 그러면 "커밋해도 되는
// 파생 파일"이라는 예외가 하나 생긴다. 예외가 생기면 파생이 정본처럼 병합된다.
const REVIEW_VIEW_VERSION = 'review-v1';
const REVIEW_VIEW_FILE = 'review.md';

function renderReviewView(report, markdown) {
  const counts = report.counts || {};
  return [
    '---',
    `generated: ${REVIEW_VIEW_VERSION}`,
    'view: review',
    'title: 검토 리포트',
    `project: ${report.project}`,
    `generatedAt: ${report.generatedAt}`,
    `stale: ${counts.stale || 0}`,
    `unapproved: ${counts.unapproved || 0}`,
    // 태그가 있어야 옵시디언 검색·데이터뷰가 이 한 장을 집어낸다. 태그가 없으면
    // 파일은 놓였지만 찾아가는 길이 경로 하나뿐이고, 그건 CLI를 치는 것과 다르지 않다.
    'tags:',
    '  - rundol/review',
    '---',
    '',
    '> 이 파일은 승인 원장과 Git에서 계산한 파생 뷰이며 정본이 아니다. 고쳐도 다음 생성 때 덮어써진다.',
    '',
    String(markdown).replace(/\s*$/u, ''),
    ''
  ].join('\n');
}

function viewBody(text) {
  return require('./document-composite').compositeBody(text);
}

function writeReviewView(start, report, markdown) {
  const { COMPOSITE_DIRECTORY, ensureCompositeIgnored } = require('./document-composite');
  const layout = workspaceLayout(start);
  const project = selectProject(layout, report.project, true);
  const ignored = ensureCompositeIgnored(project.root);
  const directory = path.join(project.root, COMPOSITE_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, REVIEW_VIEW_FILE);
  const content = renderReviewView(report, markdown);
  // 바뀌었는지는 frontmatter를 뺀 본문으로 판정한다. generatedAt은 매번 달라지므로
  // 전체를 비교하면 내용이 그대로여도 항상 "바뀜"이 되고, 그 값으로는 검토할 것이
  // 실제로 늘었는지 알 수 없다. 그래도 파일은 매번 쓴다 — "언제 기준인가"가 낡은
  // 리포트에서 가장 위험한 정보이기 때문이다.
  const changed = !fs.existsSync(file) || viewBody(fs.readFileSync(file, 'utf8')) !== viewBody(content);
  atomicWrite(file, content);
  return {
    vault: project.root,
    directory,
    file,
    relativeFile: path.relative(layout.root, file).split(path.sep).join('/'),
    ignored,
    changed
  };
}

module.exports = { initObsidian, REVIEW_VIEW_VERSION, REVIEW_VIEW_FILE, renderReviewView, writeReviewView };
