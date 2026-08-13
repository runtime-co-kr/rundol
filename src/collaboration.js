'use strict';

const fs = require('fs');
const path = require('path');
const { checkWorkspace, findWorkspaceRoot, readWorkspaceManifest, yamlNestedValue } = require('./check');
const { workspaceLayout, selectProject } = require('./workspace');

const EDITABLE_FIELDS = {
  member: ['역할', '소속', '업무 계정', '책임 영역', '상태'],
  stakeholder: ['유형', '관심', '영향력', '참여 방식', '담당 역할']
};

function projectFile(root, projectKey) {
  const layout = workspaceLayout(root);
  if (layout.schemaVersion >= 2) return selectProject(layout, projectKey, true).charter;
  const manifest = readWorkspaceManifest(root).source;
  const documents = path.resolve(root, yamlNestedValue(manifest, 'documents', 'root') || 'docs');
  const file = fs.readdirSync(documents, { withFileTypes: true })
    .find((entry) => entry.isFile() && /^PRJ-\d{3,}-.+\.md$/u.test(entry.name));
  if (!file) throw new Error('팀과 이해관계자를 정의한 PRJ 문서를 찾지 못했습니다.');
  return path.join(documents, file.name);
}

function entityType(id) {
  if (id.startsWith('MEMBER-')) return 'member';
  if (id.startsWith('STAKEHOLDER-')) return 'stakeholder';
  if (id.startsWith('ROLE-')) return 'role';
  return null;
}

function parseCollaboration(source) {
  const lines = source.split(/\r?\n/);
  const entities = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^###\s+(.+?)\s+\^((?:ROLE|MEMBER|STAKEHOLDER)-[A-Z0-9]+)\s*$/.exec(lines[index]);
    if (!match) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) end += 1;
    const fields = {};
    const description = [];
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const field = /^-\s+([^:]+):\s*(.*)$/.exec(lines[cursor]);
      if (field) fields[field[1].trim()] = field[2].trim();
      else {
        const bullet = /^-\s+(.+)$/.exec(lines[cursor]);
        if (bullet) description.push(bullet[1].trim());
      }
    }
    entities.push({
      id: match[2],
      type: entityType(match[2]),
      name: match[1].trim(),
      fields,
      description: description.join(' '),
      start: index,
      end
    });
    index = end - 1;
  }
  return { lines, entities };
}

function publicEntity(entity) {
  return { id: entity.id, type: entity.type, name: entity.name, fields: entity.fields, description: entity.description };
}

function readCollaboration(start, projectKey) {
  const root = findWorkspaceRoot(start);
  const layout = workspaceLayout(root);
  const project = layout.schemaVersion >= 2 ? selectProject(layout, projectKey, true) : null;
  const file = projectFile(root, projectKey);
  const parsed = parseCollaboration(fs.readFileSync(file, 'utf8'));
  return {
    root,
    project: project ? project.key : null,
    file: path.relative(root, file).split(path.sep).join('/'),
    roles: parsed.entities.filter((item) => item.type === 'role').map(publicEntity),
    members: parsed.entities.filter((item) => item.type === 'member').map(publicEntity),
    stakeholders: parsed.entities.filter((item) => item.type === 'stakeholder').map(publicEntity)
  };
}

function safeValue(value, label) {
  const text = String(value || '').trim();
  if (/\r|\n/.test(text) || text.length > 500) throw new Error(`${label} 값은 한 줄 500자 이하여야 합니다.`);
  return text;
}

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function updateCollaboration(start, id, input, projectKey) {
  const root = findWorkspaceRoot(start);
  const file = projectFile(root, projectKey);
  const original = fs.readFileSync(file, 'utf8');
  const parsed = parseCollaboration(original);
  const entity = parsed.entities.find((item) => item.id === id);
  if (!entity || !EDITABLE_FIELDS[entity.type]) throw new Error(`수정 가능한 협업 대상을 찾지 못했습니다: ${id}`);
  const name = safeValue(input.name || entity.name, '이름');
  if (!name) throw new Error('이름이 필요합니다.');
  const updates = {};
  for (const field of EDITABLE_FIELDS[entity.type]) {
    if (input.fields && Object.prototype.hasOwnProperty.call(input.fields, field)) updates[field] = safeValue(input.fields[field], field);
  }
  parsed.lines[entity.start] = `### ${name} ^${entity.id}`;
  const existing = new Set();
  for (let cursor = entity.start + 1; cursor < entity.end; cursor += 1) {
    const match = /^-\s+([^:]+):\s*(.*)$/.exec(parsed.lines[cursor]);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[1].trim())) continue;
    const field = match[1].trim();
    parsed.lines[cursor] = `- ${field}: ${updates[field]}`;
    existing.add(field);
  }
  const additions = Object.keys(updates).filter((field) => !existing.has(field)).map((field) => `- ${field}: ${updates[field]}`);
  parsed.lines.splice(entity.end, 0, ...additions);
  const next = `${parsed.lines.join('\n').replace(/\n*$/, '')}\n`;
  try {
    atomicWrite(file, next);
    const checked = checkWorkspace(root, { strict: true, project: projectKey || null });
    if (checked.summary.errors > 0) {
      const first = checked.diagnostics.find((item) => item.severity === 'error');
      throw new Error(first ? `${first.code} ${first.message}` : '협업 문서 검증에 실패했습니다.');
    }
  } catch (error) {
    atomicWrite(file, original);
    throw error;
  }
  return readCollaboration(root, projectKey);
}

module.exports = { readCollaboration, updateCollaboration, parseCollaboration };
