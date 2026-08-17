'use strict';

const fs = require('fs');
const path = require('path');
const { readTaskStore } = require('./tasks');
const { parseFrontmatter } = require('./frontmatter');
const { validateDocumentProfile } = require('./document-profile');
const { evaluateDocumentContract, projectArtifacts } = require('./document-contract');
const { loadBoardPresentation, resolveProfilePresets } = require('./board-presentation');
const { validateBoundaryMetadata } = require('./document-boundary');
const { validateDocumentDiagram } = require('./document-diagram');
const { COMPOSITE_DIRECTORY, prepareCompositeDocuments, compositeIssues, compositeDrift } = require('./document-composite');
const { isIndexArtifact, validateImplementationDocument, validateImplementationTrace, validateTaskImplementationReadiness } = require('./implementation-contract');
const { normalizeVerdictEvent, verdictEnvelope } = require('./verify');
const { normalizeDriverEvent, driverEnvelope } = require('./driver-lease');
const { normalizeDecisionEvent, decisionEnvelope } = require('./decision');
const { normalizeDelegationEvent, delegationEnvelope } = require('./delegation');
const { normalizeApprovalEvent, approvalEnvelope } = require('./approval');
const { isDocumentUid, duplicateUids } = require('./document-identity');
const workspaceApi = require('./workspace');
const { workspaceLayout, listProjects } = workspaceApi;

const REQUIRED_FIELDS = ['id', 'type', 'kind', 'title', 'description', 'owner', 'state', 'tags', 'aliases', 'related'];
const ID_PATTERN = /^[A-Z]{3}-\d{3,}$/;
const FILE_PATTERN = /^[A-Z]{3}-\d{3,}-(?=.*[\uAC00-\uD7A3])[\uAC00-\uD7A3A-Za-z0-9]+(?:-[\uAC00-\uD7A3A-Za-z0-9]+)*\.md$/u;
const TASK_ID_PATTERN = /^TASK-[A-Z0-9]{20,32}$/;
// 완료와 반려는 둘 다 종료지만 게이트가 다르다. done은 수용조건과 TST 증거를,
// cancelled는 사유와 결정자를 요구한다. 반려가 완료 게이트를 우회하는 통로가 되면 안 되므로
// 아래 규칙들은 두 상태를 하나로 묶지 않는다.
const ALLOWED_TASK_STATES = new Set(['todo', 'doing', 'waiting', 'review', 'done', 'cancelled']);
const LEGACY_DOCUMENT_CODES = new Map([['SPC', 'REQ']]);
const NON_CANONICAL_CODES = new Set(['NTE']);
const REQUIRED_TAG_NAMESPACES = ['rundol/', 'artifact/', 'domain/', 'feature/'];
const NOTE_TAG_NAMESPACES = ['rundol/'];
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
      // 생성 디렉터리는 프로젝트 루트에만 있다. 이름만으로 어느 깊이에서나 건너뛰면
      // docs/views/ 같은 정상 문서 폴더가 조용히 검사에서 빠진다.
      if (entry.name === COMPOSITE_DIRECTORY && path.resolve(directory) === path.resolve(root)) continue;
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
      if (entry.name === COMPOSITE_DIRECTORY && path.resolve(directory) === path.resolve(root)) continue;
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

function uniqueDocuments(documents) {
  const seen = new Set();
  return documents.filter((document) => {
    const key = document.file || document.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    if (['doing', 'review', 'done', 'cancelled'].includes(task.status) && !task.owner) diagnostic(list, { code: 'RDL-TASK-007', category: 'task', file: taskFile, artifactId: taskId, message: `${task.status} 상태에는 owner가 필요합니다.` });
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
    // 사유 없는 반려는 "취소됨"만 남기고 왜인지는 남기지 않는다. 뒤에 읽는 사람이
    // 그 판단을 재현할 수 없으므로 waiting↔blocker와 같은 강도로 짝을 강제한다.
    if (task.status === 'cancelled' && (!task.cancellation || !task.cancellation.reason || !task.cancellation.decidedBy || !task.cancellation.at)) diagnostic(list, { code: 'RDL-TASK-023', category: 'task', file: taskFile, artifactId: taskId, message: 'cancelled 상태에는 reason, decidedBy, at이 있는 cancellation이 필요합니다.' });
    if (task.status !== 'cancelled' && task.cancellation) diagnostic(list, { code: 'RDL-TASK-024', category: 'task', file: taskFile, artifactId: taskId, message: 'cancelled가 아닌 태스크에는 cancellation을 둘 수 없습니다.' });
    if (task.cancellation && task.cancellation.decidedBy && !memberIds.has(task.cancellation.decidedBy)) diagnostic(list, { code: 'RDL-TASK-025', category: 'task', file: taskFile, artifactId: taskId, target: task.cancellation.decidedBy, message: `반려 결정자가 존재하지 않습니다: ${task.cancellation.decidedBy}` });
    const criteria = task.acceptanceCriteria && typeof task.acceptanceCriteria === 'object' ? Object.values(task.acceptanceCriteria) : [];
    if (criteria.length === 0) diagnostic(list, { code: 'RDL-TASK-017', category: 'task', file: taskFile, artifactId: taskId, message: '완료조건이 하나 이상 필요합니다.' });
    if (task.status === 'done' && criteria.some((criterion) => !criterion.done)) diagnostic(list, { code: 'RDL-TASK-018', category: 'task', file: taskFile, artifactId: taskId, message: 'done 태스크에 미완료 수용조건이 있습니다.' });
    if (task.status === 'done' && !(task.links || []).some((link) => String(link).startsWith('TST-'))) diagnostic(list, { code: 'RDL-TASK-019', category: 'task', file: taskFile, artifactId: taskId, message: 'done 태스크는 TST 문서를 연결해야 합니다.' });
    const implementationLinked = (task.links || []).some((link) => /^(?:REQ|TST)-/u.test(String(link)));
    if (task.implementationReadiness && task.implementationReadiness !== 'atomic-v1') diagnostic(list, { code: 'RDL-IMPL-023', category: 'implementation', file: taskFile, artifactId: taskId, message: `지원하지 않는 구현 준비도 계약입니다: ${task.implementationReadiness}` });
    if (task.status === 'done' && implementationLinked && task.implementationReadiness === 'atomic-v1') {
      const linked = uniqueDocuments((task.links || []).map((link) => registry.get(String(link).split('#')[0])).filter(Boolean));
      for (const issue of validateTaskImplementationReadiness(linked)) diagnostic(list, {
        code: issue.code,
        category: 'implementation',
        severity: issue.severity,
        file: taskFile,
        artifactId: taskId,
        target: issue.target || issue.artifactId || null,
        message: issue.message
      });
    }
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
    // 조인 키는 번호가 아니라 uid다. 형식이 어긋난 값은 조용히 무시하면 그 문서가
    // 조인에서 사라지므로 진단한다. 부여 자체가 없는 것은 아직 마이그레이션하지
    // 않은 문서일 수 있어 경고로 둔다.
    if (meta.uid === undefined) diagnostic(diagnostics, { code: 'RDL-DOC-014', severity: 'warning', file: doc.relativeFile, artifactId, message: '문서 고유 식별자(uid)가 없습니다. rdl doc identity --apply로 부여하세요.' });
    else if (!isDocumentUid(meta.uid)) diagnostic(diagnostics, { code: 'RDL-DOC-015', file: doc.relativeFile, line: doc.frontmatter.locations.uid, artifactId, message: `문서 고유 식별자 형식이 잘못되었습니다: ${meta.uid}` });
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    const requiredNamespaces = NON_CANONICAL_CODES.has(typeof artifactId === 'string' ? artifactId.slice(0, 3) : '') ? NOTE_TAG_NAMESPACES : REQUIRED_TAG_NAMESPACES;
    for (const namespace of requiredNamespaces) if (!tags.some((tag) => typeof tag === 'string' && tag.startsWith(namespace))) diagnostic(diagnostics, { code: 'RDL-DOC-008', file: doc.relativeFile, line: doc.frontmatter.locations.tags, artifactId, message: `필수 태그 namespace가 없습니다: ${namespace}` });
    for (const issue of validateBoundaryMetadata(meta)) diagnostic(diagnostics, {
      code: issue.code,
      category: 'granularity',
      file: doc.relativeFile,
      line: doc.frontmatter.locations[issue.field] || 2,
      artifactId,
      message: issue.message
    });
    for (const issue of validateImplementationDocument(doc, options)) diagnostic(diagnostics, {
      code: issue.code,
      category: 'implementation',
      severity: issue.severity,
      file: doc.relativeFile,
      line: issue.line || doc.frontmatter.locations.implementationContract || 2,
      artifactId,
      target: issue.target || null,
      message: issue.message
    });
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
  // 같은 식별자를 가진 문서가 둘이면 조인이 갈린다. 확률은 낮지만 조용한 손상
  // 대신 두 문서를 모두 지목한다 — 짧은 식별자를 쓰는 대가는 이 진단으로 치른다.
  for (const duplicate of duplicateUids(canonicalDocuments.filter((doc) => doc.id).map((doc) => ({ id: doc.id, uid: doc.frontmatter.data.uid })))) {
    for (const document of canonicalDocuments.filter((doc) => duplicate.ids.includes(doc.id))) {
      diagnostic(diagnostics, { code: 'RDL-DOC-016', file: document.relativeFile, artifactId: document.id, target: duplicate.uid, message: `문서 고유 식별자가 중복됩니다: ${duplicate.uid} (${duplicate.ids.join(', ')})` });
    }
  }

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
    for (const issue of validateDocumentDiagram(code, doc.source, doc.id)) diagnostic(diagnostics, {
      code: issue.code,
      category: 'diagram',
      severity: 'warning',
      file: doc.relativeFile,
      artifactId: doc.id,
      target: issue.target || null,
      message: issue.message
    });
  }

  const implementation = validateImplementationTrace(canonicalDocuments.filter((doc) => doc.id && ID_PATTERN.test(doc.id)).map((doc) => ({
    id: doc.id,
    type: doc.id.slice(0, 3),
    file: doc.file,
    source: doc.source
  })), options);
  for (const issue of implementation.issues) diagnostic(diagnostics, {
    code: issue.code,
    category: 'implementation',
    severity: issue.severity,
    file: null,
    artifactId: issue.artifactId || null,
    target: issue.target || null,
    message: issue.message
  });

  const canonicalPaths = new Set(canonicalDocuments.map((doc) => path.resolve(doc.file)));
  for (const doc of vaultDocuments) {
    if (canonicalPaths.has(path.resolve(doc.file))) continue;
    const artifactId = doc.frontmatter && typeof doc.frontmatter.data.id === 'string' ? doc.frontmatter.data.id : null;
    if (isIndexArtifact(doc.frontmatter && doc.frontmatter.data.title, doc.file)) diagnostic(diagnostics, {
      code: 'RDL-IMPL-010',
      category: 'implementation',
      file: doc.relativeFile,
      artifactId,
      message: '별도 인덱스·목록·추적표 문서는 만들지 않습니다. 직접 링크와 rdl contract trace를 사용하세요.'
    });
    if (path.basename(doc.file).toLowerCase() === 'design.md') diagnostic(diagnostics, {
      code: 'RDL-DOC-011',
      category: 'metadata',
      severity: 'warning',
      file: doc.relativeFile,
      artifactId,
      message: 'DESIGN.md는 Rundol 정본이 아닙니다. 내용을 REQ, SCR, ARC, ADR 또는 연결된 태스크로 이전하세요. 필요한 유형이 사용 안 함이면 계약에서 상태를 먼저 바꾸세요.'
    });
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

// 파일 단위 검사가 이미 보고하는 코드. fold가 같은 것을 다시 세지 않게 한다.
const SHARD_LEVEL_LEDGER_CODES = new Set(['RDL-DEC-014', 'RDL-DLG-014', 'RDL-APPROVE-014']);

// 새 원장의 교차 이벤트 진단(상충하는 답변, 취소 대상 불일치, 모호한 위임 등)은
// 파일 단위 검사로는 보이지 않는다 — fold를 거쳐야 나온다. 검사 결과에 합치지
// 않으면 그 진단은 그것을 부르는 명령을 아는 사람에게만 보인다.
// 다이제스트는 체크섬이지 서명이 아니다. 기존 행을 고치고 다시 계산하면 파일
// 안에는 변형 하나만 남아 상충 검출이 성립하지 않는다. 파일이 덧붙여지기만
// 했는지는 이 저장소 밖의 기준점 — Git 이력 — 으로만 판정할 수 있다.
function checkLedgerIntegrity(diagnostics, layout) {
  if (layout.schemaVersion < 6) return;
  let report;
  try { report = require('./ledger-integrity').appendOnlyReport(layout.root); }
  catch (error) {
    diagnostic(diagnostics, { code: 'RDL-LEDGER-002', category: 'workspace', message: `원장 무결성을 확인할 수 없습니다: ${error.message}` });
    return;
  }
  // 확인하지 못한 것과 확인해서 문제가 없는 것은 다르다. 증명할 수 없는 상태를
  // 깨끗함으로 보고하면, 검사를 통과했다는 말이 아무것도 뜻하지 않게 된다.
  if (!report.checked && report.reason) {
    diagnostic(diagnostics, { code: 'RDL-LEDGER-002', category: 'workspace', message: `원장 무결성을 확인할 수 없습니다: ${report.reason}` });
  }
  for (const violation of report.violations) {
    diagnostic(diagnostics, { code: 'RDL-LEDGER-003', category: 'workspace', file: violation.file, line: 1, message: `append-only 위반: ${violation.message}` });
  }
}

function checkLedgerFolds(diagnostics, layout, projectKey) {
  if (layout.schemaVersion < 6) return;
  const eventsRoot = path.join(layout.root, 'projects', 'workspace', 'events');
  if (!fs.existsSync(eventsRoot)) return;
  const projects = (layout.projects || []).filter((project) => !projectKey || project.key === projectKey);
  const now = Date.now();
  // 검사가 인가를 끈 채 접으면 위조된 승인·위임을 정상으로 보고한다. 검사는
  // 가장 마지막으로 남는 안전망이므로 여기서 끄면 아무 데서도 걸리지 않는다.
  const cache = new Map();
  const authorityFor = (key) => {
    if (!cache.has(key)) cache.set(key, require('./authority').authorityContext(layout.root, key, { now }));
    return cache.get(key);
  };
  for (const project of projects) {
    const folds = [
      () => require('./decision').foldDecisions(require('./decision').readDecisionEvents(eventsRoot, project.key), authorityFor(project.key)),
      () => require('./delegation').foldDelegations(require('./delegation').readDelegationEvents(eventsRoot, project.key), { now, authority: authorityFor(project.key) }),
      () => require('./approval').foldApprovals(require('./approval').readApprovalEvents(eventsRoot, project.key), { authority: authorityFor(project.key) })
    ];
    for (const fold of folds) {
      let result;
      try { result = fold(); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-LEDGER-001', category: 'workspace', project: project.key, message: `원장을 접을 수 없습니다: ${error.message}` });
        continue;
      }
      for (const item of result.diagnostics || []) {
        // 파일 단위 검사가 이미 스키마·봉투 손상을 같은 코드로 보고한다. fold에서
        // 다시 세면 이벤트 하나가 두 건으로 집계되어 "몇 건이 잘못됐는가"를
        // 오독하게 만든다. fold는 교차 이벤트 진단만 더한다.
        if (SHARD_LEVEL_LEDGER_CODES.has(item.code)) continue;
        diagnostic(diagnostics, { code: item.code, category: 'workspace', severity: item.severity, project: project.key, target: item.eventId || null, message: item.message });
      }
    }
  }
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
    clients.set(id, { owner, status, type });
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
  // events/run/ 서브디렉터리는 run 원장 샤드다. 알려진 kind만 검사하고, 그 밖의
  // 서브디렉터리는 미래의 이벤트 종류이므로 진단하지 않는다 — 구버전이 신버전의
  // 데이터를 오진하지 않게 하는 것과 같은 규칙을 이 버전도 미래에 대해 지킨다.
  const runRoot = path.join(eventsRoot, 'run');
  if (fs.existsSync(runRoot)) for (const entry of fs.readdirSync(runRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(runRoot, entry.name);
    if (!/^run-[a-z0-9-]+-RUN-[A-F0-9]{20}-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-RUN-001', category: 'workspace', file: relative(layout.root, file), message: '런 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-RUN-002', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
        if (!entry.name.startsWith(`run-${event.projectId}-${event.clientId}-${event.runId}-`)) diagnostic(diagnostics, { code: 'RDL-RUN-003', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '런 이벤트의 프로젝트, Client 또는 runId가 파일명과 일치하지 않습니다.' });
        // sync 전이의 신원 인가: 순수 fold는 레지스트리를 못 보므로, 레지스트리를
        // 가진 검사 계층이 인가 매트릭스(sync 실행자 = 활성 agent/service)를 확인한다.
        if (event.type === 'run.synced' || (event.type === 'run.halted' && ['sync-failed', 'merge-conflict'].includes(event.reason))) {
          const client = clients.get(event.clientId);
          if (!client || client.status !== 'active' || !['agent', 'service'].includes(client.type)) {
            diagnostic(diagnostics, { code: 'RDL-RUN-005', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `sync 전이의 clientId가 활성 agent/service Client가 아닙니다: ${event.clientId || '(없음)'}` });
          }
        }
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-RUN-004', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 이벤트를 파싱할 수 없습니다: ${error.message}` });
      }
    }
  }
  const verdictRoot = path.join(eventsRoot, 'verdict');
  if (fs.existsSync(verdictRoot)) for (const entry of fs.readdirSync(verdictRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(verdictRoot, entry.name);
    if (!/^verdict-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-VERDICT-010', category: 'workspace', file: relative(layout.root, file), message: '검증 verdict 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-VERDICT-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL verdict 이벤트를 파싱할 수 없습니다: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-VERDICT-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
      if (!entry.name.startsWith(`verdict-${event.projectId}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-VERDICT-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: 'verdict 이벤트의 프로젝트 또는 Client가 파일명과 일치하지 않습니다.' });
      try {
        normalizeVerdictEvent(event);
        const expected = verdictEnvelope(event).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest가 canonical verdict projection과 일치하지 않습니다.');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-VERDICT-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `verdict schema/envelope가 유효하지 않습니다: ${error.message}` });
      }
    }
  }
  const decisionRoot = path.join(eventsRoot, 'decision');
  if (fs.existsSync(decisionRoot)) for (const entry of fs.readdirSync(decisionRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(decisionRoot, entry.name);
    if (!/^decision-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-DEC-010', category: 'workspace', file: relative(layout.root, file), message: '결정 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DEC-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 결정 이벤트를 파싱할 수 없습니다: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-DEC-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
      if (!entry.name.startsWith(`decision-${event.projectId}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-DEC-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '결정 이벤트의 프로젝트 또는 Client가 파일명과 일치하지 않습니다.' });
      try {
        const normalized = normalizeDecisionEvent(event);
        const expected = decisionEnvelope(normalized).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest가 canonical projection과 일치하지 않습니다.');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DEC-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `결정 schema/envelope가 유효하지 않습니다: ${error.message}` });
      }
    }
  }
  const approvalRoot = path.join(eventsRoot, 'approval');
  if (fs.existsSync(approvalRoot)) for (const entry of fs.readdirSync(approvalRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(approvalRoot, entry.name);
    if (!/^approval-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-APPROVE-010', category: 'workspace', file: relative(layout.root, file), message: '승인 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-APPROVE-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 승인 이벤트를 파싱할 수 없습니다: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-APPROVE-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
      if (!entry.name.startsWith(`approval-${event.projectId}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-APPROVE-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '승인 이벤트의 프로젝트 또는 Client가 파일명과 일치하지 않습니다.' });
      try {
        const normalized = normalizeApprovalEvent(event);
        const expected = approvalEnvelope(normalized).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest가 canonical projection과 일치하지 않습니다.');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-APPROVE-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `승인 schema/envelope가 유효하지 않습니다: ${error.message}` });
      }
    }
  }
  const delegationRoot = path.join(eventsRoot, 'delegation');
  if (fs.existsSync(delegationRoot)) for (const entry of fs.readdirSync(delegationRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(delegationRoot, entry.name);
    if (!/^delegation-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-DLG-010', category: 'workspace', file: relative(layout.root, file), message: '위임 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DLG-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 위임 이벤트를 파싱할 수 없습니다: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-DLG-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
      if (!entry.name.startsWith(`delegation-${event.projectId}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-DLG-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '위임 이벤트의 프로젝트 또는 Client가 파일명과 일치하지 않습니다.' });
      // 수임 Client도 등록된 주체여야 한다. 권한을 받는 쪽이 레지스트리에 없으면
      // 그 위임은 누구에게 준 것인지 알 수 없다.
      if (event.type === 'delegation.granted' && !clients.has(event.delegateClientId)) {
        diagnostic(diagnostics, { code: 'RDL-DLG-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 수임 Client입니다: ${event.delegateClientId || '(없음)'}` });
      }
      try {
        const normalized = normalizeDelegationEvent(event);
        const expected = delegationEnvelope(normalized).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest가 canonical projection과 일치하지 않습니다.');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DLG-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `위임 schema/envelope가 유효하지 않습니다: ${error.message}` });
      }
    }
  }
  const driverRoot = path.join(eventsRoot, 'driver');
  if (fs.existsSync(driverRoot)) for (const entry of fs.readdirSync(driverRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(driverRoot, entry.name);
    if (!/^driver-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-RUN-[A-F0-9]{20}-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-DRIVER-010', category: 'workspace', file: relative(layout.root, file), message: 'driver event shard filename is invalid.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DRIVER-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `driver JSONL is invalid: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-DRIVER-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `driver event references an unknown client: ${event.clientId || '(missing)'}` });
      if (!entry.name.startsWith(`driver-${event.projectId}-${event.clientId}-${event.runId}-`)) diagnostic(diagnostics, { code: 'RDL-DRIVER-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: 'driver event project/client/run identity differs from its filename.' });
      try {
        const normalized = normalizeDriverEvent(event);
        const expected = driverEnvelope(normalized).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest differs from the canonical driver projection');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DRIVER-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `driver schema/envelope is invalid: ${error.message}` });
      }
    }
  }
}

function checkCompositeViews(diagnostics, layout, project) {
  const documents = prepareCompositeDocuments(projectArtifacts(project));
  for (const issue of compositeIssues(documents)) diagnostic(diagnostics, {
    code: issue.code, category: 'diagram', severity: 'warning', file: null, project: project.key, target: issue.target,
    message: issue.message
  });
  for (const view of compositeDrift(project.root, documents)) diagnostic(diagnostics, {
    code: 'RDL-COMPOSE-003', category: 'diagram', severity: 'warning', file: relative(layout.root, view.file), project: project.key, target: view.name,
    message: `${view.title}가 현재 정본과 다릅니다. rdl contract diagram --project ${project.key} --write로 다시 생성하세요.`
  });
}

function checkDocumentProfile(diagnostics, layout, project, settings) {
  if (!project.charter || !fs.existsSync(project.charter)) return;
  const source = fs.readFileSync(project.charter, 'utf8');
  // 어떤 프로필 이름이 유효한지는 board.json 상속이 정한다. 그 목록을 넘기지 않으면
  // 팀이 만든 프리셋을 쓰는 프로젝트가 RDL-PROFILE-001로 오진되어 save와 sync가 막힌다.
  // contract check는 통과하는데 check --strict만 실패하는 상태였다.
  const presets = resolveProfilePresets(loadBoardPresentation(layout.root, project.key));
  const validation = validateDocumentProfile(source, presets);
  if (!validation.present) return;
  for (const message of validation.errors) diagnostic(diagnostics, {
    code: 'RDL-PROFILE-001', category: 'profile', file: relative(layout.root, project.charter), project: project.key, message
  });
  if (validation.errors.length) return;
  if (validation.profile.schemaVersion === 2) {
    if (settings.skipProfilePolicy) return;
    const artifacts = projectArtifacts(project);
    const evaluation = evaluateDocumentContract(validation.profile, artifacts);
    const severity = evaluation.enforcement === 'checkpoint' && settings.strict ? 'error' : 'warning';
    // 흡수 진단(006·007·010·011)은 없앴다. 제목 문자열만 보고 내용을 보지 않아 빈 제목
    // 여섯 줄로도 통과했고, 나중에 그 유형을 켜면 옮기라고 알려주는 경로도 없었다.
    const codes = {
      'required-missing': 'RDL-PROFILE-002',
      'recommended-missing': 'RDL-PROFILE-003',
      'disabled-present': 'RDL-PROFILE-004'
    };
    for (const violation of evaluation.violations) diagnostic(diagnostics, {
      code: codes[violation.code] || 'RDL-PROFILE-009', category: 'profile', severity: violation.code === 'recommended-missing' ? 'warning' : severity,
      file: relative(layout.root, project.charter), project: project.key, target: violation.type,
      message: violation.message
    });
    // 예전 계약이 갖고 있던 값은 지금 아무 데서도 읽지 않는다. 지우지 않고 남겨 두되,
    // 남아 있다는 사실과 옮길 자리는 알려야 한다. 모르면 영영 그대로 남는다.
    const leftoverSections = Object.entries(validation.profile.omissions || {}).filter(([, item]) => !item.notApplicable);
    if (leftoverSections.length) diagnostic(diagnostics, {
      code: 'RDL-PROFILE-012', category: 'profile', severity: 'warning',
      file: relative(layout.root, project.charter), project: project.key,
      message: `예전 흡수 설정이 남아 있습니다: ${leftoverSections.map(([type]) => type).join(', ')}. rdl contract migrate로 프리셋 하부 요소로 옮기세요.`
    });
    if (Object.keys(validation.profile.rules || {}).length) diagnostic(diagnostics, {
      code: 'RDL-PROFILE-013', category: 'profile', severity: 'warning',
      file: relative(layout.root, project.charter), project: project.key,
      message: `예전 작성 순서 설정이 남아 있습니다: ${Object.keys(validation.profile.rules).join(', ')}. 지금은 읽지 않으므로 rdl contract migrate로 정리하세요.`
    });
    return;
  }
  diagnostic(diagnostics, {
    code: 'RDL-PROFILE-008', category: 'profile', severity: 'warning', file: relative(layout.root, project.charter), project: project.key,
    message: 'documentProfile schemaVersion 1은 호환 읽기만 지원합니다. project profile 명령으로 schemaVersion 2로 마이그레이션하세요.'
  });
  if (settings.skipProfilePolicy) return;
  const present = new Set();
  const roots = [project.documents, path.join(project.root, 'inbox')];
  for (const root of roots) for (const file of listMarkdownFiles(root)) {
    const inspected = inspectMarkdown(file, layout.root);
    const id = inspected.frontmatter && inspected.frontmatter.data.id;
    const match = /^([A-Z]{3})-\d{3,}$/u.exec(typeof id === 'string' ? id : '');
    if (match) present.add(match[1]);
  }
  const policy = validation.profile.policy;
  for (const type of policy.required) if (!present.has(type)) diagnostic(diagnostics, {
    code: 'RDL-PROFILE-002', category: 'profile', severity: settings.strict ? 'error' : 'warning',
    file: relative(layout.root, project.charter), project: project.key, target: type,
    message: `필수 문서 유형이 없습니다: ${type}`
  });
  for (const type of policy.recommended) if (!present.has(type)) diagnostic(diagnostics, {
    code: 'RDL-PROFILE-003', category: 'profile', severity: 'warning', file: relative(layout.root, project.charter),
    project: project.key, target: type, message: `권장 문서 유형이 없습니다: ${type}`
  });
  for (const type of policy.disabled) if (present.has(type)) diagnostic(diagnostics, {
    code: 'RDL-PROFILE-004', category: 'profile', severity: 'warning', file: relative(layout.root, project.charter),
    project: project.key, target: type, message: `비활성화된 문서 유형이 존재합니다: ${type}`
  });
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
  checkLedgerFolds(diagnostics, layout, settings.project);
  checkLedgerIntegrity(diagnostics, layout);
  if (settings.project && projects.length === 0) diagnostic(diagnostics, { code: 'RDL-PROJECT-006', category: 'governance', target: settings.project, message: `프로젝트를 찾지 못했습니다: ${settings.project}` });
  if (!settings.project && allProjects.length === 0) diagnostic(diagnostics, { code: 'RDL-PROJECT-007', category: 'governance', file: layout.mountRelative, message: 'project.md가 있는 프로젝트를 찾지 못했습니다.' });
  let documents = 0;
  let tasks = 0;
  for (const project of projects) {
    checkProjectCharter(diagnostics, layout.root, project);
    checkDocumentProfile(diagnostics, layout, project, settings);
    checkCompositeViews(diagnostics, layout, project);
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
  listMarkdownFiles,
  findWorkspaceRoot,
  readWorkspaceManifest,
  yamlNestedValue
};
