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

// 역할 참조는 존재 확인과 Obsidian 링크 형식을 함께 갖춰야 한다. add 경로만 이 검증을
// 갖고 있어서 set 경로로는 없는 역할 ID가 평문으로 그대로 기록됐다. 한곳에 모은다.
const ROLE_FIELDS = { member: '역할', stakeholder: '담당 역할' };
function resolveRoleField(parsed, value) {
  const requested = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!requested.length) throw new Error('역할을 하나 이상 지정해야 합니다.');
  return requested.map((token) => {
    // 이미 링크 형태로 들어온 값은 그대로 두고 ID만 뽑아 확인한다.
    const id = (/\^([A-Z]+-\d+)/u.exec(token) || [])[1] || token;
    const role = parsed.entities.find((item) => item.type === 'role' && item.id === id);
    if (!role) throw new Error(`project.md에 등록되지 않은 역할입니다: ${id}`);
    return `[[project#^${role.id}|${role.name}]]`;
  }).join(', ');
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
  const roleField = ROLE_FIELDS[entity.type];
  for (const field of EDITABLE_FIELDS[entity.type]) {
    if (!input.fields || !Object.prototype.hasOwnProperty.call(input.fields, field)) continue;
    updates[field] = field === roleField
      ? resolveRoleField(parsed, safeValue(input.fields[field], field))
      : safeValue(input.fields[field], field);
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

const MEMBER_ID = /^MEMBER-\d{3}$/u;
const MEMBER_SECTION = /^##\s+프로젝트 팀원\s*$/u;

// Client의 owner는 프로젝트 멤버여야 하고 lease는 그 owner를 확인한다.
// 그래서 새 사람이 합류하면 Client 등록보다 이 블록이 먼저 있어야 한다.
function nextMemberId(members) {
  const numbers = members.map((item) => Number.parseInt(item.id.slice('MEMBER-'.length), 10)).filter(Number.isInteger);
  return `MEMBER-${String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, '0')}`;
}

function memberBlock(id, values, roles) {
  return [
    `### ${values.name} ^${id}`,
    '',
    `- 역할: ${roles.map((role) => `[[project#^${role.id}|${role.name}]]`).join(', ')}`,
    `- 소속: ${values.organization}`,
    `- 업무 계정: ${values.account}`,
    `- 책임 영역: ${values.responsibility}`,
    '- 상태: active',
    ''
  ];
}

// 새 블록은 프로젝트 팀원 절 안, 마지막 멤버 뒤에 넣는다. 절이 없으면 넣을 자리가 없다.
function memberInsertPoint(parsed) {
  const start = parsed.lines.findIndex((line) => MEMBER_SECTION.test(line));
  if (start < 0) throw new Error('project.md에서 프로젝트 팀원 절을 찾지 못했습니다.');
  const members = parsed.entities.filter((item) => item.type === 'member' && item.start > start);
  if (members.length) return members[members.length - 1].end;
  let cursor = start + 1;
  while (cursor < parsed.lines.length && !/^##\s+/u.test(parsed.lines[cursor])) cursor += 1;
  return cursor;
}

function addMember(start, input, projectKey) {
  const root = findWorkspaceRoot(start);
  const file = projectFile(root, projectKey);
  const original = fs.readFileSync(file, 'utf8');
  const parsed = parseCollaboration(original);

  const values = {
    name: safeValue(input.name, '이름'),
    organization: safeValue(input.organization, '소속'),
    account: safeValue(input.account, '업무 계정'),
    responsibility: safeValue(input.responsibility, '책임 영역')
  };
  for (const [key, label] of [['name', '이름'], ['organization', '소속'], ['account', '업무 계정'], ['responsibility', '책임 영역']]) {
    if (!values[key]) throw new Error(`${label}이(가) 필요합니다.`);
  }

  const requested = Array.from(new Set((input.roles || []).map((role) => String(role).trim()).filter(Boolean)));
  if (!requested.length) throw new Error('역할을 하나 이상 지정해야 합니다.');
  const roles = requested.map((id) => {
    const role = parsed.entities.find((item) => item.type === 'role' && item.id === id);
    if (!role) throw new Error(`project.md에 등록되지 않은 역할입니다: ${id}`);
    return role;
  });

  const members = parsed.entities.filter((item) => item.type === 'member');
  const id = input.member ? String(input.member).trim() : nextMemberId(members);
  if (!MEMBER_ID.test(id)) throw new Error(`멤버 ID는 MEMBER-NNN 형식이어야 합니다: ${id}`);
  if (parsed.entities.some((item) => item.id === id)) throw new Error(`이미 존재하는 ID입니다: ${id}`);

  parsed.lines.splice(memberInsertPoint(parsed), 0, ...memberBlock(id, values, roles));
  const next = `${parsed.lines.join('\n').replace(/\n*$/u, '')}\n`;
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
  return {
    root,
    project: projectKey || null,
    member: id,
    name: values.name,
    roles: roles.map((role) => role.id),
    file: path.relative(root, file).split(path.sep).join('/')
  };
}

module.exports = { readCollaboration, updateCollaboration, addMember, parseCollaboration };
