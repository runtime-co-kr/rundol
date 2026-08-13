'use strict';

const fs = require('fs');
const path = require('path');
const { readTaskStore } = require('./tasks');
const { parseFrontmatter } = require('./frontmatter');
const workspaceApi = require('./workspace');
const { workspaceLayout, listProjects } = workspaceApi;

const REQUIRED_FIELDS = ['id', 'type', 'kind', 'title', 'description', 'owner', 'state', 'tags', 'aliases', 'related'];
const ID_PATTERN = /^[A-Z]{3}-\d{3,}$/;
const FILE_PATTERN = /^[A-Z]{3}-\d{3,}-(?=.*[\uAC00-\uD7A3])[\uAC00-\uD7A3A-Za-z0-9]+(?:-[\uAC00-\uD7A3A-Za-z0-9]+)*\.md$/u;
const TASK_ID_PATTERN = /^TASK-[A-Z0-9]{20,32}$/;
const ALLOWED_TASK_STATES = new Set(['todo', 'doing', 'waiting', 'review', 'done']);
const LEGACY_DOCUMENT_CODES = new Map([['SPC', 'REQ']]);
const GOVERNANCE_HEADINGS = ['미션', '목표', '범위', '역할', '프로젝트 팀원', '이해관계자', '책임 매트릭스', '의사결정과 에스컬레이션', '위험과 제약', '협업 리듬', '완료 정의'];
const GOVERNANCE_BLOCK_FIELDS = {
  ROLE: ['미션', '결정권', '주요 산출물', '에스컬레이션'],
  MEMBER: ['역할', '소속', '업무 계정', '책임 영역', '상태'],
  STAKEHOLDER: ['유형', '관심', '영향력', '참여 방식', '담당 역할']
};

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

const WORKSPACE_MANIFEST = 'workspace.yaml';

function workspaceManifestPath(root) {
  return workspaceApi.manifestPath(root);
}

function findWorkspaceRoot(start) {
  return workspaceApi.findWorkspaceRoot(start);
}

function readWorkspaceManifest(root) {
  return workspaceApi.readWorkspaceManifest(root);
}

function yamlNestedValue(source, section, key) {
  const sectionMatch = new RegExp(`(?:^|\\n)${section}:\\s*\\n([\\s\\S]*?)(?=\\n[^ \\n][^\\n]*:|$)`).exec(source);
  if (!sectionMatch) return null;
  const keyMatch = new RegExp(`^\\s{2}${key}:\\s*(.+)$`, 'm').exec(sectionMatch[1]);
  return keyMatch ? keyMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function listMarkdownFiles(root) {
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'templates' || entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'INDEX.md') result.push(full);
    }
  }
  if (fs.existsSync(root)) visit(root);
  return result.sort();
}

function listVaultMarkdownFiles(root) {
  const result = [];
  const excluded = new Set(['.git', '.obsidian', '.rundol', 'node_modules', '.npm-cache', 'templates']);
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(full);
    }
  }
  visit(root);
  return result.sort();
}

function headingKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function inspectMarkdown(file, root) {
  const source = fs.readFileSync(file, 'utf8');
  const frontmatter = parseFrontmatter(source);
  const headings = new Set();
  const blocks = new Set();
  const body = frontmatter ? frontmatter.body : source;
  const bodyStartLine = frontmatter ? frontmatter.bodyStartLine : 1;
  body.split(/\r?\n/).forEach((line) => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) headings.add(headingKey(heading[1].replace(/\s+\^[A-Za-z]+-[A-Z0-9]+\s*$/, '')));
    for (const block of line.matchAll(/\^([A-Z]+-[A-Z0-9]+)/g)) blocks.add(block[1]);
  });
  return { file, fileStem: path.basename(file, '.md'), relativeFile: relative(root, file), source, frontmatter, body, bodyStartLine, headings, blocks };
}

function governanceBlocks(doc) {
  const result = [];
  const pattern = /^###\s+(.+?)\s+\^(ROLE|MEMBER|STAKEHOLDER)-([A-Z0-9]+)\s*$/gm;
  const matches = Array.from(doc.body.matchAll(pattern));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextHeading = doc.body.slice(match.index + match[0].length).search(/^#{2,3}\s+/m);
    const end = nextHeading < 0 ? doc.body.length : match.index + match[0].length + nextHeading;
    const source = doc.body.slice(match.index, end);
    const fields = new Map();
    for (const field of source.matchAll(/^-\s+([^:]+):\s*(.*)$/gm)) fields.set(field[1].trim(), field[2].trim());
    result.push({ type: match[2], id: `${match[2]}-${match[3]}`, name: match[1].trim(), source, fields, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1 });
  }
  return result;
}

function checkProjectGovernance(list, projectDoc) {
  if (!projectDoc) return;
  for (const heading of GOVERNANCE_HEADINGS) {
    if (!projectDoc.headings.has(headingKey(heading))) diagnostic(list, { code: 'RDL-GOV-001', category: 'governance', file: projectDoc.relativeFile, artifactId: projectDoc.id, message: `프로젝트 거버넌스 필수 섹션이 없습니다: ${heading}` });
  }
  const blocks = governanceBlocks(projectDoc);
  for (const type of Object.keys(GOVERNANCE_BLOCK_FIELDS)) {
    if (!blocks.some((block) => block.type === type)) diagnostic(list, { code: 'RDL-GOV-002', category: 'governance', file: projectDoc.relativeFile, artifactId: projectDoc.id, message: `${type} 정의가 하나 이상 필요합니다.` });
  }
  for (const block of blocks) {
    for (const field of GOVERNANCE_BLOCK_FIELDS[block.type]) {
      if (!block.fields.has(field) || !block.fields.get(field)) diagnostic(list, { code: 'RDL-GOV-003', category: 'governance', file: projectDoc.relativeFile, line: block.line, artifactId: projectDoc.id, target: block.id, message: `${block.id}에 필수 필드가 없습니다: ${field}` });
    }
  }
}

function wikiTarget(value) {
  if (typeof value !== 'string') return null;
  const match = /^\[\[([^|\]#]+)(?:#([^|\]]+))?(?:\|[^\]]+)?\]\]$/.exec(value.trim());
  return match ? { id: match[1], anchor: match[2] || null } : null;
}

function lineOf(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) return 1;
  return source.slice(0, index).split(/\r?\n/).length;
}

function diagnostic(list, values) {
  list.push(Object.assign({ severity: 'error', category: 'metadata', file: null, line: 1, artifactId: null, target: null }, values));
}

function resolveArtifact(registry, id) {
  return registry.get(id) || null;
}

function checkReference(list, fileRegistry, artifactRegistry, sourceDoc, rawValue, values) {
  const target = wikiTarget(rawValue);
  if (!target) {
    diagnostic(list, Object.assign({
      code: 'RDL-LINK-001', category: 'link', file: sourceDoc.relativeFile,
      line: lineOf(sourceDoc.source, String(rawValue)), artifactId: values.artifactId,
      message: `Wiki link 형식이 아닙니다: ${rawValue}`
    }, values));
    return;
  }
  const targetDoc = fileRegistry.get(target.id) || null;
  if (!targetDoc) {
    const aliasDoc = resolveArtifact(artifactRegistry, target.id);
    diagnostic(list, Object.assign({
      code: aliasDoc ? 'RDL-LINK-006' : 'RDL-LINK-002', category: 'link', file: sourceDoc.relativeFile,
      line: lineOf(sourceDoc.source, rawValue), artifactId: values.artifactId, target: target.id,
      message: aliasDoc
        ? `Obsidian link 대상은 alias가 아니라 실제 파일명이어야 합니다: [[${aliasDoc.fileStem}|${target.id}]]`
        : `존재하지 않는 Obsidian 파일을 참조합니다: ${target.id}`
    }, values));
    return;
  }
  if (target.anchor) {
    const exists = target.anchor.startsWith('^')
      ? targetDoc.blocks.has(target.anchor.slice(1))
      : targetDoc.headings.has(headingKey(target.anchor));
    if (!exists) {
      diagnostic(list, Object.assign({
        code: 'RDL-LINK-003', category: 'link', file: sourceDoc.relativeFile,
        line: lineOf(sourceDoc.source, rawValue), artifactId: values.artifactId, target: `${target.id}#${target.anchor}`,
        message: `존재하지 않는 섹션 또는 block을 참조합니다: ${target.id}#${target.anchor}`
      }, values));
    }
  }
}

function referenceFromTask(list, registry, taskFile, taskId, value) {
  const parts = String(value).split('#');
  const targetDoc = resolveArtifact(registry, parts[0]);
  if (!targetDoc) {
    diagnostic(list, { code: 'RDL-TASK-008', category: 'task', file: taskFile, line: 1, artifactId: taskId, target: parts[0], message: `태스크가 존재하지 않는 Artifact를 참조합니다: ${value}` });
  } else if (parts[1] && !targetDoc.headings.has(headingKey(parts.slice(1).join('#')))) {
    diagnostic(list, { code: 'RDL-TASK-009', category: 'task', file: taskFile, line: 1, artifactId: taskId, target: value, message: `태스크가 존재하지 않는 문서 섹션을 참조합니다: ${value}` });
  }
}

function checkTasks(list, root, taskPath, registry, memberIds, stakeholderIds, projectKey) {
  if (!taskPath || !fs.existsSync(taskPath)) {
    diagnostic(list, { code: 'RDL-TASK-001', category: 'task', file: taskPath ? relative(root, taskPath) : null, message: '태스크 원본 또는 로컬 projection을 찾지 못했습니다.' });
    return 0;
  }
  const taskFile = relative(root, taskPath);
  let parsed;
  try {
    parsed = readTaskStore(taskPath);
  } catch (error) {
    diagnostic(list, { code: 'RDL-TASK-002', category: 'task', file: taskFile, message: `tasks.json을 파싱할 수 없습니다: ${error.message}` });
    return 0;
  }
  if (!parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)) {
    diagnostic(list, { code: 'RDL-TASK-003', category: 'task', file: taskFile, message: 'tasks는 ID를 key로 가진 객체여야 합니다.' });
    return 0;
  }
  const taskIds = Object.keys(parsed.tasks).filter((taskId) => !projectKey || parsed.tasks[taskId].project === projectKey);
  const dependencies = new Map();
  const required = ['title', 'summary', 'owner', 'reviewers', 'stakeholders', 'status', 'priority', 'links', 'deps', 'acceptanceCriteria', 'blocker', 'createdAt', 'updatedAt', 'statusChangedAt', 'externalRefs'];

  for (const taskId of taskIds) {
    const task = parsed.tasks[taskId];
    if (!TASK_ID_PATTERN.test(taskId)) diagnostic(list, { code: 'RDL-TASK-004', category: 'task', file: taskFile, artifactId: taskId, message: `잘못된 태스크 ID입니다: ${taskId}` });
    for (const field of required) {
      if (!Object.prototype.hasOwnProperty.call(task, field)) diagnostic(list, { code: 'RDL-TASK-005', category: 'task', file: taskFile, artifactId: taskId, message: `필수 태스크 필드가 없습니다: ${field}` });
    }
    if (!ALLOWED_TASK_STATES.has(task.status)) diagnostic(list, { code: 'RDL-TASK-006', category: 'task', file: taskFile, artifactId: taskId, message: `허용되지 않은 상태입니다: ${task.status}` });
    if (['doing', 'review', 'done'].includes(task.status) && !task.owner) diagnostic(list, { code: 'RDL-TASK-007', category: 'task', file: taskFile, artifactId: taskId, message: `${task.status} 상태에는 owner가 필요합니다.` });
    if (task.owner && !memberIds.has(task.owner)) diagnostic(list, { code: 'RDL-TASK-010', category: 'task', file: taskFile, artifactId: taskId, target: task.owner, message: `존재하지 않는 owner입니다: ${task.owner}` });
    for (const reviewer of Array.isArray(task.reviewers) ? task.reviewers : []) if (!memberIds.has(reviewer)) diagnostic(list, { code: 'RDL-TASK-011', category: 'task', file: taskFile, artifactId: taskId, target: reviewer, message: `존재하지 않는 reviewer입니다: ${reviewer}` });
    for (const stakeholder of Array.isArray(task.stakeholders) ? task.stakeholders : []) if (!stakeholderIds.has(stakeholder)) diagnostic(list, { code: 'RDL-TASK-012', category: 'task', file: taskFile, artifactId: taskId, target: stakeholder, message: `존재하지 않는 stakeholder입니다: ${stakeholder}` });
    for (const link of Array.isArray(task.links) ? task.links : []) referenceFromTask(list, registry, taskFile, taskId, link);
    const deps = Array.isArray(task.deps) ? task.deps : [];
    dependencies.set(taskId, deps);
    for (const dependency of deps) if (!Object.prototype.hasOwnProperty.call(parsed.tasks, dependency)) diagnostic(list, { code: 'RDL-TASK-013', category: 'task', file: taskFile, artifactId: taskId, target: dependency, message: `존재하지 않는 선행 태스크입니다: ${dependency}` });
    if (task.status === 'waiting' && (!task.blocker || !task.blocker.waitingFor || !task.blocker.condition || !task.blocker.since)) diagnostic(list, { code: 'RDL-TASK-014', category: 'task', file: taskFile, artifactId: taskId, message: 'waiting 상태에는 waitingFor, condition, since가 있는 blocker가 필요합니다.' });
    if (task.status !== 'waiting' && task.blocker) diagnostic(list, { code: 'RDL-TASK-015', category: 'task', file: taskFile, artifactId: taskId, message: 'waiting이 아닌 태스크에는 blocker를 둘 수 없습니다.' });
    if (task.blocker && !memberIds.has(task.blocker.waitingFor) && !stakeholderIds.has(task.blocker.waitingFor)) diagnostic(list, { code: 'RDL-TASK-016', category: 'task', file: taskFile, artifactId: taskId, target: task.blocker.waitingFor, message: `blocker 대기 대상이 존재하지 않습니다: ${task.blocker.waitingFor}` });
    const criteria = task.acceptanceCriteria && typeof task.acceptanceCriteria === 'object' ? Object.values(task.acceptanceCriteria) : [];
    if (criteria.length === 0) diagnostic(list, { code: 'RDL-TASK-017', category: 'task', file: taskFile, artifactId: taskId, message: '완료조건이 하나 이상 필요합니다.' });
    if (task.status === 'done' && criteria.some((criterion) => !criterion.done)) diagnostic(list, { code: 'RDL-TASK-018', category: 'task', file: taskFile, artifactId: taskId, message: 'done 태스크에 미완료 수용조건이 있습니다.' });
    if (task.status === 'done' && !(task.links || []).some((link) => String(link).startsWith('TST-'))) diagnostic(list, { code: 'RDL-TASK-019', category: 'task', file: taskFile, artifactId: taskId, message: 'done 태스크는 TST 문서를 연결해야 합니다.' });
    if (task.status === 'review' && (!Array.isArray(task.externalRefs) || task.externalRefs.length === 0)) diagnostic(list, { code: 'RDL-TASK-020', category: 'task', file: taskFile, artifactId: taskId, message: 'review 태스크는 PR 또는 검토 대상 externalRef가 필요합니다.' });
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) {
      diagnostic(list, { code: 'RDL-TASK-021', category: 'task', file: taskFile, artifactId: id, target: id, message: `태스크 의존성 순환이 있습니다: ${trail.concat(id).join(' -> ')}` });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) || []) if (dependencies.has(dependency)) visit(dependency, trail.concat(id));
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of taskIds) visit(id, []);
  return taskIds.length;
}

function checkObsidian(list, root, hasTaggedDocuments) {
  const branchSettings = path.join(root, '.rundol', 'settings', 'obsidian');
  const managedSettings = fs.existsSync(branchSettings) ? branchSettings : path.join(root, '.rundol', 'obsidian');
  const localSettings = path.join(root, '.obsidian');
  const settingsDir = fs.existsSync(managedSettings) ? managedSettings : localSettings;
  const settingsLabel = relative(root, settingsDir);
  if (!fs.existsSync(settingsDir)) {
    diagnostic(list, { code: 'RDL-OBS-001', category: 'obsidian', severity: 'warning', message: 'Rundol settings의 팀 공통 Obsidian 설정 디렉터리가 없습니다.' });
    return;
  }
  const settings = {};
  for (const entry of fs.readdirSync(settingsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(settingsDir, entry.name);
    try {
      settings[entry.name] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      diagnostic(list, { code: 'RDL-OBS-002', category: 'obsidian', file: relative(root, file), message: `Obsidian 설정 JSON을 파싱할 수 없습니다: ${error.message}` });
    }
  }
  const app = settings['app.json'] || {};
  for (const item of [
    ['newFileFolderPath', 'RDL-OBS-003', '신규 문서 폴더'],
    ['attachmentFolderPath', 'RDL-OBS-004', '첨부파일 폴더']
  ]) {
    if (app[item[0]] && !fs.existsSync(path.resolve(root, app[item[0]]))) diagnostic(list, { code: item[1], category: 'obsidian', severity: 'warning', file: `${settingsLabel}/app.json`, message: `${item[2]}가 존재하지 않습니다: ${app[item[0]]}` });
  }
  const plugins = settings['core-plugins.json'] || {};
  if (hasTaggedDocuments && plugins['tag-pane'] !== true) diagnostic(list, { code: 'RDL-OBS-005', category: 'obsidian', severity: 'warning', file: `${settingsLabel}/core-plugins.json`, message: '태그를 사용하는 Vault에서 tag-pane core plugin이 활성화되어야 합니다.' });
  if (plugins.templates === true) {
    const templateSettings = settings['templates.json'];
    if (!templateSettings || !templateSettings.folder) diagnostic(list, { code: 'RDL-OBS-006', category: 'obsidian', severity: 'warning', file: `${settingsLabel}/templates.json`, message: 'Templates core plugin의 폴더 설정이 없습니다.' });
    else if (!fs.existsSync(path.resolve(root, templateSettings.folder))) diagnostic(list, { code: 'RDL-OBS-007', category: 'obsidian', severity: 'warning', file: `${settingsLabel}/templates.json`, message: `Templates 폴더가 존재하지 않습니다: ${templateSettings.folder}` });
  }
  const graph = settings['graph.json'] || {};
  if (hasTaggedDocuments && graph.showTags !== true) diagnostic(list, { code: 'RDL-OBS-008', category: 'obsidian', severity: 'warning', file: `${settingsLabel}/graph.json`, message: 'Graph view의 태그 표시가 비활성화되어 있습니다.' });
}

function checkLegacyWorkspace(start, options, scope) {
  const startedAt = Date.now();
  const root = findWorkspaceRoot(start);
  const manifest = readWorkspaceManifest(root);
  const documentsRoot = scope ? scope.root : path.resolve(root, yamlNestedValue(manifest.source, 'documents', 'root') || 'docs');
  const canonicalTaskPath = scope ? (scope.tasks || workspaceLayout(root).tasks) : path.resolve(root, yamlNestedValue(manifest.source, 'tasks', 'path') || 'tasks.json');
  const projectionValue = yamlNestedValue(manifest.source, 'tasks', 'projection');
  const projectionPath = projectionValue ? path.resolve(root, projectionValue) : null;
  const taskPath = scope ? canonicalTaskPath : projectionPath && fs.existsSync(projectionPath) ? projectionPath : canonicalTaskPath;
  const diagnostics = [];
  const vaultDocuments = (scope ? listMarkdownFiles(scope.root) : listVaultMarkdownFiles(root)).map((file) => inspectMarkdown(file, root));
  const vaultByPath = new Map(vaultDocuments.map((doc) => [path.resolve(doc.file), doc]));
  const documents = listMarkdownFiles(documentsRoot)
    .filter((file) => !scope || path.resolve(file) !== path.resolve(scope.charter))
    .map((file) => vaultByPath.get(path.resolve(file)) || inspectMarkdown(file, root));
  const registry = new Map();
  const fileRegistry = new Map();
  const canonicalDocuments = [];

  for (const vaultDoc of vaultDocuments) {
    if (fileRegistry.has(vaultDoc.fileStem)) diagnostic(diagnostics, { code: 'RDL-DOC-010', category: 'link', file: vaultDoc.relativeFile, target: vaultDoc.fileStem, message: `Obsidian에서 모호한 중복 파일명입니다: ${vaultDoc.fileStem}` });
    else fileRegistry.set(vaultDoc.fileStem, vaultDoc);
  }

  for (const doc of documents) {
    if (!doc.frontmatter) {
      diagnostic(diagnostics, { code: 'RDL-DOC-001', file: doc.relativeFile, message: 'YAML frontmatter가 없습니다.' });
      continue;
    }
    const meta = doc.frontmatter.data;
    const artifactId = typeof meta.id === 'string' ? meta.id : null;
    doc.id = artifactId;
    canonicalDocuments.push(doc);
    for (const field of REQUIRED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(meta, field) || meta[field] === '' || meta[field] === null) diagnostic(diagnostics, { code: 'RDL-DOC-002', file: doc.relativeFile, line: doc.frontmatter.locations[field] || 2, artifactId, message: `필수 메타 필드가 없습니다: ${field}` });
    }
    if (!artifactId || !ID_PATTERN.test(artifactId)) diagnostic(diagnostics, { code: 'RDL-DOC-003', file: doc.relativeFile, line: doc.frontmatter.locations.id || 2, artifactId, message: `문서 ID는 3자리 코드와 3자리 이상 숫자여야 합니다: ${artifactId || '(없음)'}` });
    if (!FILE_PATTERN.test(path.basename(doc.file))) diagnostic(diagnostics, { code: 'RDL-DOC-004', file: doc.relativeFile, artifactId, message: '파일명은 <3자리 코드>-<번호>-<한글 제목>.md 형식이어야 합니다.' });
    if (artifactId && !path.basename(doc.file).startsWith(`${artifactId}-`)) diagnostic(diagnostics, { code: 'RDL-DOC-005', file: doc.relativeFile, artifactId, message: `파일명의 ID가 frontmatter ID와 다릅니다: ${path.basename(doc.file)}` });
    if (typeof meta.title === 'string' && /[A-Za-z]/.test(meta.title)) diagnostic(diagnostics, { code: 'RDL-DOC-006', file: doc.relativeFile, line: doc.frontmatter.locations.title, artifactId, message: '문서 title은 한글 중심으로 작성하고 영문 약어는 description 또는 본문에서 설명하세요.' });
    const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
    if (aliases[0] !== artifactId) diagnostic(diagnostics, { code: 'RDL-DOC-007', file: doc.relativeFile, line: doc.frontmatter.locations.aliases, artifactId, message: 'aliases의 첫 값은 문서 ID와 같아야 합니다.' });
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    for (const namespace of ['rundol/', 'artifact/', 'domain/', 'feature/']) if (!tags.some((tag) => typeof tag === 'string' && tag.startsWith(namespace))) diagnostic(diagnostics, { code: 'RDL-DOC-008', file: doc.relativeFile, line: doc.frontmatter.locations.tags, artifactId, message: `필수 태그 namespace가 없습니다: ${namespace}` });
    if (artifactId) {
      for (const alias of [artifactId].concat(aliases)) {
        if (registry.has(alias) && registry.get(alias) !== doc) diagnostic(diagnostics, { code: 'RDL-DOC-009', file: doc.relativeFile, artifactId, target: alias, message: `중복 ID 또는 alias입니다: ${alias}` });
        else registry.set(alias, doc);
      }
    }
  }

  const projectDoc = scope ? vaultByPath.get(path.resolve(scope.charter)) : canonicalDocuments.find((doc) => doc.id && doc.id.startsWith('PRJ-'));
  if (scope && projectDoc && projectDoc.frontmatter) projectDoc.id = projectDoc.frontmatter.data.id;
  const memberIds = new Set(projectDoc ? Array.from(projectDoc.blocks).filter((id) => id.startsWith('MEMBER-')) : []);
  const stakeholderIds = new Set(projectDoc ? Array.from(projectDoc.blocks).filter((id) => id.startsWith('STAKEHOLDER-')) : []);
  if (!projectDoc) diagnostic(diagnostics, { code: 'RDL-META-001', message: 'PRJ 문서를 찾지 못했습니다.' });
  checkProjectGovernance(diagnostics, projectDoc);

  for (const doc of canonicalDocuments) {
    const meta = doc.frontmatter.data;
    for (const value of Array.isArray(meta.related) ? meta.related : []) checkReference(diagnostics, fileRegistry, registry, doc, value, { category: 'link', artifactId: doc.id });
    for (const field of ['owner', 'reviewers', 'stakeholders']) {
      const values = Array.isArray(meta[field]) ? meta[field] : meta[field] ? [meta[field]] : [];
      for (const value of values) {
        checkReference(diagnostics, fileRegistry, registry, doc, value, { category: 'metadata', artifactId: doc.id });
        const target = wikiTarget(value);
        if (target && target.anchor && target.anchor.startsWith('^')) {
          const block = target.anchor.slice(1);
          const expected = field === 'stakeholders' ? 'STAKEHOLDER-' : 'MEMBER-';
          if (!block.startsWith(expected)) diagnostic(diagnostics, { code: 'RDL-META-002', category: 'metadata', file: doc.relativeFile, line: lineOf(doc.source, value), artifactId: doc.id, target: block, message: `${field}는 ${expected} block을 참조해야 합니다.` });
        }
      }
    }
    for (const match of doc.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const raw = `[[${match[1]}]]`;
      const target = wikiTarget(raw);
      if (!target || target.id === 'tasks.json') continue;
      const targetDoc = fileRegistry.get(target.id) || null;
      if (!targetDoc) {
        const aliasDoc = resolveArtifact(registry, target.id);
        diagnostic(diagnostics, { code: aliasDoc ? 'RDL-LINK-006' : 'RDL-LINK-004', category: 'link', severity: options.strict ? 'error' : 'warning', file: doc.relativeFile, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1, artifactId: doc.id, target: target.id, message: aliasDoc ? `본문 Wiki link는 실제 파일명을 대상으로 해야 합니다: [[${aliasDoc.fileStem}|${target.id}]]` : `본문에 해결되지 않은 Wiki link가 있습니다: ${target.id}` });
      }
      else if (target.anchor) {
        const exists = target.anchor.startsWith('^') ? targetDoc.blocks.has(target.anchor.slice(1)) : targetDoc.headings.has(headingKey(target.anchor));
        if (!exists) diagnostic(diagnostics, { code: 'RDL-LINK-005', category: 'link', severity: options.strict ? 'error' : 'warning', file: doc.relativeFile, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1, artifactId: doc.id, target: `${target.id}#${target.anchor}`, message: `본문에 해결되지 않은 section link가 있습니다: ${target.id}#${target.anchor}` });
      }
    }
    const relatedIds = (Array.isArray(meta.related) ? meta.related : []).map(wikiTarget).filter(Boolean).map((target) => fileRegistry.get(target.id)).filter(Boolean).map((targetDoc) => targetDoc.id.slice(0, 3));
    const requirements = { SCR: ['REQ'], MOD: ['REQ', 'ARC'], API: ['REQ', 'ARC'], TST: ['REQ'], RUN: ['ARC', 'REQ'] };
    const code = doc.id ? doc.id.slice(0, 3) : '';
    if (LEGACY_DOCUMENT_CODES.has(code)) diagnostic(diagnostics, {
      code: 'RDL-DOC-010',
      category: 'metadata',
      severity: options.strict ? 'error' : 'warning',
      file: doc.relativeFile,
      artifactId: doc.id,
      message: `${code} 문서 유형은 더 이상 사용하지 않습니다. ${LEGACY_DOCUMENT_CODES.get(code)} 또는 관점별 설계문서로 이전하세요.`
    });
    if (requirements[code] && !requirements[code].some((required) => relatedIds.includes(required))) diagnostic(diagnostics, { code: 'RDL-META-003', category: 'metadata', file: doc.relativeFile, artifactId: doc.id, message: `${code} 문서는 ${requirements[code].join(' 또는 ')} 관계가 필요합니다.` });
  }

  const canonicalPaths = new Set(canonicalDocuments.map((doc) => path.resolve(doc.file)));
  for (const doc of vaultDocuments) {
    if (canonicalPaths.has(path.resolve(doc.file))) continue;
    const artifactId = doc.frontmatter && typeof doc.frontmatter.data.id === 'string' ? doc.frontmatter.data.id : null;
    for (const match of doc.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const raw = `[[${match[1]}]]`;
      const target = wikiTarget(raw);
      if (!target || target.id === 'tasks.json') continue;
      const targetDoc = fileRegistry.get(target.id) || null;
      if (!targetDoc) {
        const aliasDoc = resolveArtifact(registry, target.id);
        diagnostic(diagnostics, { code: aliasDoc ? 'RDL-LINK-006' : 'RDL-LINK-004', category: 'link', severity: options.strict ? 'error' : 'warning', file: doc.relativeFile, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1, artifactId, target: target.id, message: aliasDoc ? `Vault Wiki link는 실제 파일명을 대상으로 해야 합니다: [[${aliasDoc.fileStem}|${target.id}]]` : `Vault에 해결되지 않은 Wiki link가 있습니다: ${target.id}` });
      } else if (target.anchor) {
        const exists = target.anchor.startsWith('^') ? targetDoc.blocks.has(target.anchor.slice(1)) : targetDoc.headings.has(headingKey(target.anchor));
        if (!exists) diagnostic(diagnostics, { code: 'RDL-LINK-005', category: 'link', severity: options.strict ? 'error' : 'warning', file: doc.relativeFile, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1, artifactId, target: `${target.id}#${target.anchor}`, message: `Vault에 해결되지 않은 section link가 있습니다: ${target.id}#${target.anchor}` });
      }
    }
  }

  const taskCount = checkTasks(diagnostics, root, taskPath, registry, memberIds, stakeholderIds, scope && scope.key);
  if (!scope) checkObsidian(diagnostics, root, canonicalDocuments.some((doc) => Array.isArray(doc.frontmatter.data.tags) && doc.frontmatter.data.tags.length > 0));
  diagnostics.sort((a, b) => (a.file || '').localeCompare(b.file || '') || a.line - b.line || a.code.localeCompare(b.code));
  return {
    schemaVersion: 1,
    root,
    diagnostics,
    summary: {
      documents: canonicalDocuments.length,
      tasks: taskCount,
      errors: diagnostics.filter((item) => item.severity === 'error').length,
      warnings: diagnostics.filter((item) => item.severity === 'warning').length,
      durationMs: Date.now() - startedAt
    }
  };
}

function checkProjectCharter(diagnostics, root, project) {
  const doc = inspectMarkdown(project.charter, root);
  if (!doc.frontmatter) {
    diagnostic(diagnostics, { code: 'RDL-PROJECT-001', category: 'governance', file: doc.relativeFile, message: 'project.md에 YAML frontmatter가 필요합니다.' });
    return;
  }
  const meta = doc.frontmatter.data;
  const expectedId = `project:${project.key}`;
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(meta, field) || meta[field] === '' || meta[field] === null) diagnostic(diagnostics, { code: 'RDL-PROJECT-002', category: 'governance', file: doc.relativeFile, line: doc.frontmatter.locations[field] || 2, artifactId: expectedId, message: `project.md 필수 메타 필드가 없습니다: ${field}` });
  }
  if (meta.id !== expectedId) diagnostic(diagnostics, { code: 'RDL-PROJECT-003', category: 'governance', file: doc.relativeFile, line: doc.frontmatter.locations.id || 2, artifactId: meta.id, message: `project.md id는 ${expectedId}여야 합니다.` });
  if (meta.type !== 'project') diagnostic(diagnostics, { code: 'RDL-PROJECT-004', category: 'governance', file: doc.relativeFile, artifactId: expectedId, message: 'project.md type은 project여야 합니다.' });
  const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
  if (aliases[0] !== expectedId) diagnostic(diagnostics, { code: 'RDL-PROJECT-005', category: 'governance', file: doc.relativeFile, artifactId: expectedId, message: 'project.md aliases의 첫 값은 프로젝트 ID여야 합니다.' });
}

function checkWorkspaceStore(diagnostics, layout) {
  if (layout.schemaVersion < 6) return;
  const workspaceRoot = path.join(layout.root, 'projects', 'workspace');
  const clientsRoot = path.join(workspaceRoot, 'clients');
  const eventsRoot = path.join(workspaceRoot, 'events');
  const clients = new Map();
  if (fs.existsSync(clientsRoot)) for (const entry of fs.readdirSync(clientsRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^client-([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/u.exec(entry.name);
    const file = path.join(clientsRoot, entry.name);
    if (!match) {
      diagnostic(diagnostics, { code: 'RDL-CLIENT-001', category: 'workspace', file: relative(layout.root, file), message: 'Client 파일명은 client-<client-id>.yaml 형식이어야 합니다.' });
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    const id = workspaceApi.yamlValue(source, 'id');
    const type = workspaceApi.yamlValue(source, 'type');
    const owner = workspaceApi.yamlValue(source, 'owner');
    const status = workspaceApi.yamlValue(source, 'status');
    if (id !== match[1]) diagnostic(diagnostics, { code: 'RDL-CLIENT-002', category: 'workspace', file: relative(layout.root, file), message: 'Client 파일명과 id가 일치하지 않습니다.' });
    if (!['device', 'agent', 'service'].includes(type)) diagnostic(diagnostics, { code: 'RDL-CLIENT-003', category: 'workspace', file: relative(layout.root, file), message: `지원하지 않는 Client type입니다: ${type || '(없음)'}` });
    if (!/^MEMBER-\d{3}$/u.test(owner || '')) diagnostic(diagnostics, { code: 'RDL-CLIENT-004', category: 'workspace', file: relative(layout.root, file), message: 'Client owner는 MEMBER-ID여야 합니다.' });
    if (!['active', 'disabled', 'retired'].includes(status)) diagnostic(diagnostics, { code: 'RDL-CLIENT-005', category: 'workspace', file: relative(layout.root, file), message: `지원하지 않는 Client status입니다: ${status || '(없음)'}` });
    clients.set(id, { owner, status });
  }
  if (fs.existsSync(eventsRoot)) for (const entry of fs.readdirSync(eventsRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(eventsRoot, entry.name);
    if (!/^lease-[a-z0-9-]+-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-LEASE-001', category: 'workspace', file: relative(layout.root, file), message: '임대 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-LEASE-002', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
        if (!entry.name.startsWith(`lease-${event.projectId || 'workspace'}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-LEASE-003', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '임대 이벤트 범위 또는 Client가 파일명과 일치하지 않습니다.' });
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-LEASE-004', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 이벤트를 파싱할 수 없습니다: ${error.message}` });
      }
    }
  }
}

function checkWorkspace(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  if (layout.schemaVersion < 2) return checkLegacyWorkspace(start, settings, null);
  const startedAt = Date.now();
  const allProjects = listProjects(layout);
  const projects = settings.project ? allProjects.filter((project) => project.key === settings.project) : allProjects;
  const diagnostics = [];
  checkWorkspaceStore(diagnostics, layout);
  if (settings.project && projects.length === 0) diagnostic(diagnostics, { code: 'RDL-PROJECT-006', category: 'governance', target: settings.project, message: `프로젝트를 찾지 못했습니다: ${settings.project}` });
  if (!settings.project && allProjects.length === 0) diagnostic(diagnostics, { code: 'RDL-PROJECT-007', category: 'governance', file: layout.mountRelative, message: 'project.md가 있는 프로젝트를 찾지 못했습니다.' });
  let documents = 0;
  let tasks = 0;
  for (const project of projects) {
    checkProjectCharter(diagnostics, layout.root, project);
    const result = checkLegacyWorkspace(layout.root, settings, project);
    for (const item of result.diagnostics) diagnostics.push(Object.assign({ project: project.key }, item));
    documents += result.summary.documents + 1;
    tasks += result.summary.tasks;
  }
  const taskSources = layout.schemaVersion >= 3 ? projects.map((project) => ({ project: project.key, file: project.tasks })) : [{ project: null, file: layout.tasks }];
  const projectKeys = new Set(allProjects.map((project) => project.key));
  for (const source of taskSources) {
    if (!source.file || !fs.existsSync(source.file)) {
      diagnostic(diagnostics, { code: 'RDL-TASK-001', category: 'task', file: source.file ? relative(layout.root, source.file) : null, project: source.project, message: 'Workspace tasks.json을 찾지 못했습니다.' });
      continue;
    }
    try {
      const parsed = readTaskStore(source.file);
      for (const [taskId, task] of Object.entries(parsed.tasks || {})) {
        if (!task.project || !projectKeys.has(task.project) || (source.project && task.project !== source.project)) diagnostic(diagnostics, { code: 'RDL-TASK-022', category: 'task', file: relative(layout.root, source.file), project: source.project, artifactId: taskId, target: task.project || null, message: `태스크의 project가 저장 브랜치의 프로젝트와 일치하지 않습니다: ${task.project || '(없음)'}` });
      }
    } catch (error) {
      diagnostic(diagnostics, { code: 'RDL-TASK-002', category: 'task', file: relative(layout.root, source.file), project: source.project, message: `태스크 저장소를 파싱할 수 없습니다: ${error.message}` });
    }
  }
  for (const project of projects) checkObsidian(diagnostics, project.root, documents > 0);
  diagnostics.sort((a, b) => (a.file || '').localeCompare(b.file || '') || (a.line || 0) - (b.line || 0) || a.code.localeCompare(b.code));
  return {
    schemaVersion: layout.schemaVersion,
    root: layout.root,
    projects: projects.map((project) => project.key),
    diagnostics,
    summary: {
      projects: projects.length,
      documents,
      tasks,
      errors: diagnostics.filter((item) => item.severity === 'error').length,
      warnings: diagnostics.filter((item) => item.severity === 'warning').length,
      durationMs: Date.now() - startedAt
    }
  };
}

module.exports = {
  checkWorkspace,
  findWorkspaceRoot,
  readWorkspaceManifest,
  yamlNestedValue
};
