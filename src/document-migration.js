'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { CANONICAL_PATHS, canonicalDocumentPath } = require('./document-paths');
const ID_RE = /\b(PRD|REQ|ARC|SCR|MOD|API|ADR|TST|RUN|GLS|NTE)-(\d{3,})\b/u;

function files(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.rundol' || entry.name === '.obsidian') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...files(file));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(file);
  }
  return out;
}

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function rewrite(source, targets) {
  let output = source;
  output = output.replace(/\[\[([^|\]#]+)(#[^|\]]+)?(\|[^\]]+)?\]\]/gu, (whole, rawTarget, anchor, label) => {
    const normalized = rawTarget.replace(/\\/g, '/').replace(/\.md$/iu, '');
    const replacement = targets.get(normalized) || targets.get(path.posix.basename(normalized));
    return replacement ? `[[${replacement}${anchor || ''}${label || ''}]]` : whole;
  });
  return output;
}

function planMigration(projectRoot) {
  const root = path.resolve(projectRoot);
  const moves = [];
  const conflicts = [];
  const roots = [path.join(root, 'docs'), path.join(root, 'inbox')];
  const markdown = roots.flatMap((directory) => files(directory));
  const all = markdown.filter((file) => path.basename(file) !== 'project.md');
  const ids = new Map();
  const documents = [];
  for (const file of all) {
    const source = fs.readFileSync(file, 'utf8');
    const frontmatter = parseFrontmatter(source.replace(/^\uFEFF/u, ''));
    const filenameMatch = ID_RE.exec(path.basename(file));
    const id = frontmatter && typeof frontmatter.data.id === 'string' ? frontmatter.data.id : null;
    if (!filenameMatch && !id) continue;
    if (!filenameMatch || !id || id !== `${filenameMatch[1]}-${filenameMatch[2]}`) {
      conflicts.push({ id: id || (filenameMatch && `${filenameMatch[1]}-${filenameMatch[2]}`) || null, source: file, reason: 'filename-frontmatter-mismatch' });
      continue;
    }
    if (ids.has(id)) conflicts.push({ id, source: file, target: ids.get(id) });
    else ids.set(id, file);
    documents.push({ file, source, id, type: filenameMatch[1] });
  }
  for (const document of documents) {
    const { file, id, type } = document;
    const target = path.join(canonicalDocumentPath(type, root), path.basename(file));
    if (path.resolve(file) === path.resolve(target)) continue;
    if (fs.existsSync(target) && path.resolve(target) !== path.resolve(file)) conflicts.push({ id, source: file, target });
    moves.push({ id, type, source: file, target, from: path.relative(root, file).replace(/\\/g, '/'), to: path.relative(root, target).replace(/\\/g, '/') });
  }
  const targets = new Map();
  for (const document of documents) {
    const stem = path.basename(document.file, '.md');
    const relativeStem = path.relative(root, document.file).replace(/\\/g, '/').replace(/\.md$/iu, '');
    targets.set(document.id, stem);
    targets.set(relativeStem, stem);
    targets.set(path.posix.basename(relativeStem), stem);
  }
  const rewrites = [];
  const internalRewrites = [];
  for (const file of markdown) {
    const source = fs.readFileSync(file, 'utf8');
    const changed = rewrite(source, targets);
    if (changed !== source) {
      rewrites.push({ file, replacements: (source.match(/\[\[/gu) || []).length });
      internalRewrites.push({ file, source, changed });
    }
  }
  const plan = { root, moves, rewrites, conflicts, clean: moves.length === 0 && rewrites.length === 0 && conflicts.length === 0 };
  Object.defineProperty(plan, 'internalRewrites', { value: internalRewrites, enumerable: false });
  return plan;
}

function migrateProject(projectRoot, options) {
  const plan = planMigration(projectRoot);
  if (!options || options.apply !== true) return Object.assign({}, plan, { dryRun: true, applied: false });
  if (plan.conflicts.length) throw new Error(`문서 ID 중복으로 migration을 적용할 수 없습니다: ${plan.conflicts.map((item) => item.id).join(', ')}`);
  const changed = [];
  const written = [];
  const createdDirectories = new Set();
  const baseline = typeof options.validate === 'function' ? options.validate() : null;
  const errorIdentity = (item) => `${item.code}|${item.artifactId || ''}|${item.target || ''}|${item.message || ''}`;
  const baselineErrors = new Set(((baseline && baseline.diagnostics) || []).filter((item) => item.severity === 'error').map(errorIdentity));
  try {
    for (const item of plan.moves) {
      const directory = path.dirname(item.target);
      if (!fs.existsSync(directory)) createdDirectories.add(directory);
      fs.mkdirSync(directory, { recursive: true });
      fs.renameSync(item.source, item.target);
      changed.push(item);
    }
    for (const item of plan.internalRewrites) {
      const file = plan.moves.find((move) => path.resolve(move.source) === path.resolve(item.file))?.target || item.file;
      atomicWrite(file, item.changed);
      written.push({ file, source: item.source });
    }
    if (typeof options.validate === 'function') {
      const validation = options.validate();
      const introduced = ((validation && validation.diagnostics) || []).filter((item) => item.severity === 'error' && !baselineErrors.has(errorIdentity(item)));
      if (introduced.length) throw new Error(`migration strict validation 실패: 신규 오류 ${introduced.length}개`);
    }
  } catch (error) {
    for (const item of written) if (fs.existsSync(item.file)) atomicWrite(item.file, item.source);
    for (const item of changed.reverse()) { if (fs.existsSync(item.target)) fs.renameSync(item.target, item.source); }
    for (const directory of Array.from(createdDirectories).sort((left, right) => right.length - left.length)) {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    }
    throw error;
  }
  return Object.assign({}, plan, { dryRun: false, applied: true });
}

module.exports = { CANONICAL_PATHS, canonicalDocumentPath, planMigration, migrateProject };
