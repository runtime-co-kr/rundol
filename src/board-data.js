'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { runGit } = require('./git');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalRevision(value) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalJson(value), 'utf8')).digest('hex');
}

function entityRevision(value) {
  return canonicalRevision(value);
}

function documentRevision(metadata, body) {
  const input = arguments.length === 1 && metadata && typeof metadata === 'object' && Object.prototype.hasOwnProperty.call(metadata, 'metadata') && Object.prototype.hasOwnProperty.call(metadata, 'body')
    ? metadata
    : { metadata, body };
  return canonicalRevision({ metadata: input.metadata, body: input.body });
}

function projectRevision(documents) {
  if (!Array.isArray(documents)) throw new Error('documents must be an array');
  const entries = documents.map((document) => {
    if (!document || typeof document.id !== 'string' || !/^[a-f0-9]{64}$/u.test(document.revision || '')) throw new Error('project revision requires document id/revision pairs');
    return [document.id, document.revision];
  }).sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error('project revision document IDs must be unique');
  return canonicalRevision(entries);
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
      revision: documentRevision(parsed.data, parsed.body)
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

module.exports = { canonicalJson, canonicalRevision, entityRevision, documentRevision, projectRevision, listDocuments, syncStatus };
