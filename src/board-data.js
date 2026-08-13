'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { runGit } = require('./git');

function entityRevision(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function markdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.statSync(root).isFile()) return root.endsWith('.md') ? [root] : [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.obsidian' || entry.name === '.rundol') continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target);
  }
  return files;
}

function listDocuments(project) {
  const documents = [];
  for (const file of markdownFiles(project.root)) {
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!parsed || !parsed.data.id) continue;
    documents.push({
      id: parsed.data.id,
      type: parsed.data.type || null,
      kind: parsed.data.kind || null,
      title: parsed.data.title || path.basename(file, '.md'),
      description: parsed.data.description || '',
      owner: parsed.data.owner || null,
      state: parsed.data.state || null,
      tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
      related: Array.isArray(parsed.data.related) ? parsed.data.related : [],
      file: path.relative(project.root, file).replace(/\\/g, '/'),
      body: parsed.body,
      modifiedAt: fs.statSync(file).mtime.toISOString(),
      revision: entityRevision({ metadata: parsed.data, body: parsed.body })
    });
  }
  return documents.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function syncStatus(project) {
  const head = runGit(['rev-parse', 'HEAD'], { cwd: project.root }).stdout;
  const status = runGit(['status', '--porcelain'], { cwd: project.root }).stdout;
  const upstream = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: project.root, allowFailure: true });
  let ahead = null;
  let behind = null;
  let remoteRef = null;
  if (upstream.status === 0) {
    remoteRef = upstream.stdout;
    const counts = runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd: project.root, allowFailure: true });
    if (counts.status === 0) [ahead, behind] = counts.stdout.split(/\s+/u).map(Number);
  }
  const conflicts = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: project.root, allowFailure: true }).stdout;
  return {
    project: project.key,
    head,
    remoteRef,
    ahead,
    behind,
    dirty: Boolean(status),
    changedFiles: status ? status.split(/\r?\n/u).length : 0,
    conflicts: conflicts ? conflicts.split(/\r?\n/u) : [],
    state: conflicts ? 'conflict' : (ahead !== null && behind !== null && ahead > 0 && behind > 0 ? 'diverged' : behind > 0 ? 'behind' : ahead > 0 ? 'ahead' : status ? 'modified' : 'clean')
  };
}

module.exports = { entityRevision, listDocuments, syncStatus };
