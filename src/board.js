'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { checkWorkspace, findWorkspaceRoot, readWorkspaceManifest, yamlNestedValue } = require('./check');
const { taskCreate, taskUpdate, refreshState, syncState } = require('./state');
const { readCollaboration, updateCollaboration } = require('./collaboration');
const { workspaceLayout, selectProject } = require('./workspace');
const { readTaskStore, shardFiles } = require('./tasks');
const { entityRevision, listDocuments, syncStatus } = require('./board-data');
const { listClients, registerClient, setClientStatus, appendLease, listLeases } = require('./collaboration-store');
const { loadDocumentContract, planDocumentContract, updateDocumentContract } = require('./document-contract');
const { loadBoardPresentation } = require('./board-presentation');

const STATUSES = ['todo', 'doing', 'waiting', 'review', 'done'];
const UI_ROOT = path.join(__dirname, 'board-ui');

function boardConfig(start, projectKey) {
  const root = findWorkspaceRoot(start);
  const layout = workspaceLayout(root);
  if (layout.schemaVersion >= 2) {
    const project = selectProject(layout, projectKey, true);
    const taskFile = project.tasks || layout.tasks;
    if (!fs.existsSync(taskFile)) throw new Error(`태스크 파일을 찾지 못했습니다: ${taskFile}`);
    return { root, project: project.key, taskFile, projection: taskFile, fallback: taskFile };
  }
  const manifest = readWorkspaceManifest(root).source;
  const taskRelative = yamlNestedValue(manifest, 'tasks', 'path') || 'tasks.json';
  const projectionRelative = yamlNestedValue(manifest, 'tasks', 'projection') || '.rundol/local/tasks.json';
  const projection = path.resolve(root, projectionRelative);
  const fallback = path.resolve(root, taskRelative);
  const taskFile = fs.existsSync(projection) ? projection : fallback;
  if (!fs.existsSync(taskFile)) throw new Error(`태스크 파일을 찾지 못했습니다: ${taskFile}`);
  return { root, taskFile, projection, fallback };
}

function readTasks(config) {
  const document = readTaskStore(config.taskFile);
  const tasks = document.tasks || {};
  return Object.keys(tasks).map((id) => {
    const task = Object.assign({ id }, tasks[id]);
    task.revision = entityRevision(task);
    return task;
  }).filter((task) => !config.project || task.project === config.project);
}

function overview(start) {
  const layout = workspaceLayout(start);
  const projects = layout.projects.map((project) => {
    const config = boardConfig(layout.root, project.key);
    const tasks = readTasks(config);
    const counts = Object.fromEntries(STATUSES.map((status) => [status, tasks.filter((task) => task.status === status).length]));
    return { key: project.key, name: project.name, counts, tasks: tasks.length, attention: counts.waiting + counts.review };
  });
  return { schemaVersion: layout.schemaVersion, projects, totals: projects.reduce((sum, project) => sum + project.tasks, 0) };
}

function queryTasks(config, search) {
  const all = readTasks(config);
  const query = (search.get('q') || '').trim().toLowerCase();
  const owner = search.get('owner') || '';
  const priority = search.get('priority') || '';
  const status = search.get('status') || '';
  const offset = Math.max(0, Number.parseInt(search.get('offset') || '0', 10) || 0);
  const limit = Math.min(500, Math.max(1, Number.parseInt(search.get('limit') || '100', 10) || 100));
  const filtered = all.filter((task) => {
    const text = `${task.id} ${task.title || ''} ${task.summary || ''}`.toLowerCase();
    return (!query || text.includes(query)) && (!owner || String(task.owner || '') === owner) && (!priority || task.priority === priority);
  });
  const counts = Object.fromEntries(STATUSES.map((value) => [value, filtered.filter((task) => task.status === value).length]));
  const statusFiltered = status ? filtered.filter((task) => task.status === status) : filtered;
  const sorted = statusFiltered.sort((left, right) => {
    const priorityOrder = { high: 0, mid: 1, low: 2 };
    return (priorityOrder[left.priority] ?? 9) - (priorityOrder[right.priority] ?? 9) || left.id.localeCompare(right.id);
  });
  const owners = Array.from(new Set(all.map((task) => task.owner).filter(Boolean))).sort();
  return { tasks: sorted.slice(offset, offset + limit), total: sorted.length, offset, limit, counts, owners, statuses: STATUSES };
}

function json(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function asset(response, file, type, token) {
  let content = fs.readFileSync(path.join(UI_ROOT, file), 'utf8');
  if (file === 'index.html') content = content.replace('__RUNDOL_TOKEN__', token);
  const body = Buffer.from(content);
  response.writeHead(200, {
    'Content-Type': `${type}; charset=utf-8`,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  response.end(body);
}

function dependencyAsset(response, modulePath) {
  const body = fs.readFileSync(require.resolve(modulePath));
  response.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function packageAsset(response, packageName, relativePath) {
  const packageFile = require.resolve(`${packageName}/package.json`);
  const body = fs.readFileSync(path.join(path.dirname(packageFile), relativePath));
  response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  response.end(body);
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('요청 본문은 64KB를 넘을 수 없습니다.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(new Error('올바른 JSON 요청이 아닙니다.'));
      }
    });
    request.on('error', reject);
  });
}

function boardRevision(config) {
  const files = fs.statSync(config.taskFile).isDirectory() ? shardFiles(config.taskFile) : [config.taskFile];
  const charter = selectProject(workspaceLayout(config.root), config.project, true).charter;
  if (fs.existsSync(charter)) files.push(charter);
  const digest = crypto.createHash('sha1');
  for (const file of files.sort()) {
    const stat = fs.statSync(file);
    digest.update(`${path.relative(config.root, file)}:${stat.size}:${stat.mtimeMs}\n`);
  }
  return digest.digest('hex');
}

function attentionItems(tasks, documents, sync) {
  const items = [];
  const taskIds = new Set(tasks.map((task) => task.id));
  const documentIds = new Set(documents.map((document) => document.id));
  for (const task of tasks) {
    if (!task.owner) items.push({ severity: 'warning', kind: 'task', id: task.id, title: task.title, reason: '담당자 없음' });
    if (!task.acceptanceCriteria || Object.keys(task.acceptanceCriteria).length === 0) items.push({ severity: 'warning', kind: 'task', id: task.id, title: task.title, reason: '완료조건 없음' });
    if (task.status === 'review' && (!task.reviewers || task.reviewers.length === 0)) items.push({ severity: 'warning', kind: 'task', id: task.id, title: task.title, reason: '검토자 없음' });
    for (const dependency of task.deps || []) if (taskIds.has(dependency) && tasks.find((item) => item.id === dependency).status !== 'done') items.push({ severity: 'info', kind: 'task', id: task.id, title: task.title, reason: `선행 태스크 미완료: ${dependency}` });
    for (const link of task.links || []) if (!documentIds.has(link)) items.push({ severity: 'error', kind: 'task', id: task.id, title: task.title, reason: `깨진 문서 연결: ${link}` });
  }
  if (sync.state !== 'clean') items.push({ severity: sync.state === 'conflict' ? 'error' : 'warning', kind: 'operation', id: 'sync', title: 'Git 동기화', reason: sync.state });
  return items;
}

function workspaceSnapshot(root, projectKey, search) {
  const layout = workspaceLayout(root);
  const project = selectProject(layout, projectKey, true);
  const config = boardConfig(root, project.key);
  const tasksResult = queryTasks(config, search || new URLSearchParams());
  const documents = listDocuments(project);
  const collaboration = readCollaboration(root, project.key);
  const leases = layout.schemaVersion >= 6 ? listLeases(root, project.key).leases : [];
  const sync = syncStatus(project);
  const clients = layout.schemaVersion >= 6 ? listClients(root).clients : [];
  const contract = loadDocumentContract(root, project.key);
  const presentation = loadBoardPresentation(root, project.key);
  return {
    project: project.key,
    revision: { workspace: boardRevision(config), tasks: entityRevision(tasksResult.tasks), documents: entityRevision(documents), people: entityRevision(collaboration), clients: entityRevision(clients), leases: entityRevision(leases), sync: entityRevision(sync), contract: entityRevision(contract), presentation: entityRevision(presentation) },
    projects: overview(root).projects,
    documents,
    tasks: tasksResult,
    attention: attentionItems(tasksResult.tasks, documents, sync),
    people: collaboration,
    clients,
    leases,
    sync,
    contract,
    presentation,
    runs: [],
    proposals: []
  };
}

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function updateDocumentBody(root, projectKey, documentId, body) {
  const project = selectProject(workspaceLayout(root), projectKey, true);
  const current = listDocuments(project).find((item) => item.id === documentId);
  if (!current) { const error = new Error('문서를 찾지 못했습니다.'); error.statusCode = 404; throw error; }
  if (!body.baseRevision || body.baseRevision !== current.revision) { const error = new Error('문서가 외부에서 변경되었습니다. 최신 revision을 확인하세요.'); error.statusCode = 409; error.current = current; throw error; }
  const nextBody = String(body.body == null ? '' : body.body);
  if (Buffer.byteLength(nextBody, 'utf8') > 512 * 1024) inputError('문서 본문은 512KB를 넘을 수 없습니다.');
  const file = path.resolve(project.root, current.file);
  if (!file.startsWith(`${path.resolve(project.root)}${path.sep}`)) inputError('프로젝트 경로 밖의 문서는 수정할 수 없습니다.');
  const original = fs.readFileSync(file, 'utf8');
  const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/u.exec(original);
  if (!match) inputError('표준 frontmatter가 없는 문서는 Board에서 수정할 수 없습니다.');
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${match[1]}${nextBody.replace(/^\s+|\s+$/g, '')}\n`, 'utf8');
    fs.renameSync(temporary, file);
    const checked = checkWorkspace(root, { project: projectKey, strict: true, skipProfilePolicy: true });
    if (checked.summary.errors) throw new Error(checked.diagnostics.find((item) => item.severity === 'error').message);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    fs.writeFileSync(file, original, 'utf8');
    throw error;
  }
  return listDocuments(project).find((item) => item.id === documentId);
}

function stringList(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) inputError(`${field}는 배열이어야 합니다.`);
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function taskInput(body, creating) {
  const result = {};
  for (const field of ['title', 'summary']) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      result[field] = String(body[field] || '').trim();
      if (field === 'title' && !result[field]) inputError('태스크 제목이 필요합니다.');
      if (result[field].length > 1000) inputError(`${field} 값이 너무 깁니다.`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    if (!STATUSES.includes(body.status)) inputError(`지원하지 않는 상태입니다: ${body.status}`);
    result.status = body.status;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
    if (!['high', 'mid', 'low'].includes(body.priority)) inputError(`지원하지 않는 우선순위입니다: ${body.priority}`);
    result.priority = body.priority;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'owner')) result.owner = body.owner ? String(body.owner).trim() : null;
  for (const field of ['reviewers', 'stakeholders', 'links', 'deps', 'externalRefs']) {
    const values = stringList(body[field], field);
    if (values !== undefined) result[field] = values;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'acceptanceCriteria')) {
    const criteria = body.acceptanceCriteria;
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) inputError('완료조건 형식이 올바르지 않습니다.');
    result.acceptanceCriteria = {};
    for (const [id, criterion] of Object.entries(criteria)) {
      const text = String(criterion && criterion.text || '').trim();
      if (!/^AC-[A-Z0-9]+$/.test(id) || !text) inputError('각 완료조건에는 AC ID와 내용이 필요합니다.');
      result.acceptanceCriteria[id] = { text, done: criterion.done === true };
    }
    if (Object.keys(result.acceptanceCriteria).length === 0) inputError('완료조건이 하나 이상 필요합니다.');
  }
  if (creating) {
    if (!result.title) inputError('태스크 제목이 필요합니다.');
    if (!result.acceptanceCriteria) inputError('완료조건이 하나 이상 필요합니다.');
  }
  return result;
}

function validateTaskAssignments(root, input, projectKey) {
  const directory = readCollaboration(root, projectKey);
  const memberIds = new Set(directory.members.map((member) => member.id));
  const stakeholderIds = new Set(directory.stakeholders.map((stakeholder) => stakeholder.id));
  if (input.owner && !memberIds.has(input.owner)) inputError(`project.md에 등록되지 않은 담당자입니다: ${input.owner}`);
  for (const reviewer of input.reviewers || []) if (!memberIds.has(reviewer)) inputError(`project.md에 등록되지 않은 검토자입니다: ${reviewer}`);
  for (const stakeholder of input.stakeholders || []) if (!stakeholderIds.has(stakeholder)) inputError(`project.md에 등록되지 않은 이해관계자입니다: ${stakeholder}`);
}

function requireRevision(config, taskId, supplied) {
  const current = readTasks(config).find((item) => item.id === taskId);
  if (!current) return null;
  if (!supplied || supplied !== current.revision) {
    const error = new Error('태스크가 다른 실행 주체에 의해 변경되었습니다. 최신 revision을 확인한 뒤 다시 적용하세요.');
    error.statusCode = 409;
    error.current = current;
    throw error;
  }
  return current;
}

function createBoardServer(start, options) {
  const settings = options || {};
  const initialLayout = workspaceLayout(start);
  const config = boardConfig(start, settings.project || (initialLayout.projects[0] && initialLayout.projects[0].key));
  const token = settings.token || crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const activeConfig = url.searchParams.get('project') ? boardConfig(config.root, url.searchParams.get('project')) : config;
      if (request.method === 'GET' && url.pathname === '/') return asset(response, 'index.html', 'text/html', token);
      if (request.method === 'GET' && url.pathname === '/app.js') return asset(response, 'app.js', 'application/javascript', token);
      if (request.method === 'GET' && url.pathname === '/style.css') return asset(response, 'style.css', 'text/css', token);
      if (request.method === 'GET' && url.pathname === '/theme.css') return asset(response, 'theme.css', 'text/css', token);
      if (request.method === 'GET' && url.pathname === '/mermaid.js') return dependencyAsset(response, 'mermaid/dist/mermaid.min.js');
      if (request.method === 'GET' && url.pathname === '/marked.js') return packageAsset(response, 'marked', 'lib/marked.umd.js');
      if (request.method === 'GET' && url.pathname === '/dompurify.js') return dependencyAsset(response, 'dompurify/dist/purify.min.js');
      if (request.method === 'GET' && url.pathname === '/api/overview') return json(response, 200, overview(config.root));
      if (request.method === 'GET' && url.pathname === '/api/projects') return json(response, 200, overview(config.root).projects);
      if (request.method === 'GET' && url.pathname === '/api/clients') return json(response, 200, listClients(config.root));
      const projectMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/u);
      const projectTasksMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/tasks$/u);
      const projectTaskMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/tasks\/(TASK-[A-Za-z0-9-]+)$/u);
      const projectDocumentsMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents$/u);
      const projectDocumentMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents\/([^/]+)$/u);
      const projectLeasesMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/leases$/u);
      const projectLeaseActionMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/leases\/([^/]+)\/(acquire|renew|release)$/u);
      const projectSyncMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/sync$/u);
      const projectRefreshMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/refresh$/u);
      const projectSnapshotMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/board-snapshot$/u);
      const projectContractMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/contract$/u);
      const projectContractPlanMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/contract\/plan$/u);
      const requestedProject = [projectMatch, projectTasksMatch, projectTaskMatch, projectDocumentsMatch, projectDocumentMatch, projectLeasesMatch, projectLeaseActionMatch, projectSyncMatch, projectRefreshMatch, projectSnapshotMatch, projectContractMatch, projectContractPlanMatch].find(Boolean);
      const requestedConfig = requestedProject ? boardConfig(config.root, requestedProject[1]) : config;
      if (request.method === 'GET' && projectMatch) {
        const summary = overview(config.root).projects.find((item) => item.key === projectMatch[1]);
        return summary ? json(response, 200, summary) : json(response, 404, { error: '프로젝트를 찾지 못했습니다.' });
      }
      if (request.method === 'GET' && projectTasksMatch) return json(response, 200, queryTasks(requestedConfig, url.searchParams));
      if (request.method === 'GET' && projectTaskMatch) {
        const task = readTasks(requestedConfig).find((item) => item.id === projectTaskMatch[2]);
        return task ? json(response, 200, task) : json(response, 404, { error: '태스크를 찾지 못했습니다.' });
      }
      if (request.method === 'GET' && projectDocumentsMatch) return json(response, 200, { project: projectDocumentsMatch[1], documents: listDocuments(selectProject(workspaceLayout(config.root), projectDocumentsMatch[1], true)) });
      if (request.method === 'GET' && projectDocumentMatch) {
        const document = listDocuments(selectProject(workspaceLayout(config.root), projectDocumentMatch[1], true)).find((item) => item.id === decodeURIComponent(projectDocumentMatch[2]));
        return document ? json(response, 200, document) : json(response, 404, { error: '문서를 찾지 못했습니다.' });
      }
      if (request.method === 'GET' && projectLeasesMatch) return json(response, 200, listLeases(config.root, projectLeasesMatch[1]));
      if (request.method === 'GET' && projectSyncMatch) return json(response, 200, syncStatus(selectProject(workspaceLayout(config.root), projectSyncMatch[1], true)));
      if (request.method === 'GET' && projectSnapshotMatch) {
        return json(response, 200, workspaceSnapshot(config.root, projectSnapshotMatch[1], url.searchParams));
      }
      if (request.method === 'GET' && projectContractMatch) return json(response, 200, loadDocumentContract(config.root, projectContractMatch[1]));
      if (request.method === 'GET' && url.pathname === '/api/tasks') return json(response, 200, queryTasks(activeConfig, url.searchParams));
      if (request.method === 'GET' && url.pathname === '/api/revision') return json(response, 200, { revision: boardRevision(activeConfig) });
      if (request.method === 'GET' && url.pathname === '/api/collaboration') return json(response, 200, readCollaboration(activeConfig.root, activeConfig.project));
      const taskMatch = url.pathname.match(/^\/api\/tasks\/(TASK-[A-Za-z0-9-]+)$/);
      const collaborationMatch = url.pathname.match(/^\/api\/collaboration\/((?:MEMBER|STAKEHOLDER)-[A-Z0-9]+)$/);
      if (request.method === 'GET' && taskMatch) {
        const task = readTasks(activeConfig).find((item) => item.id === taskMatch[1]);
        return task ? json(response, 200, task) : json(response, 404, { error: '태스크를 찾지 못했습니다.' });
      }
      if (request.method !== 'GET' && request.headers['x-rundol-token'] !== token) return json(response, 403, { error: '유효하지 않은 로컬 세션입니다.' });
      if (request.method === 'POST' && url.pathname === '/api/clients') {
        const body = await requestBody(request);
        return json(response, 201, registerClient(config.root, body));
      }
      const clientStatusMatch = url.pathname.match(/^\/api\/clients\/([a-z0-9-]+)\/(enable|disable)$/u);
      if (request.method === 'POST' && clientStatusMatch) return json(response, 200, setClientStatus(config.root, clientStatusMatch[1], clientStatusMatch[2] === 'enable' ? 'active' : 'disabled'));
      if (request.method === 'POST' && projectTasksMatch) {
        const body = await requestBody(request);
        const input = taskInput(body, true);
        input.project = projectTasksMatch[1];
        validateTaskAssignments(config.root, input, input.project);
        return json(response, 201, taskCreate(config.root, input));
      }
      if (request.method === 'POST' && projectTaskMatch) {
        const body = await requestBody(request);
        requireRevision(requestedConfig, projectTaskMatch[2], body.baseRevision);
        const changes = taskInput(body, false);
        validateTaskAssignments(config.root, changes, projectTaskMatch[1]);
        return json(response, 200, taskUpdate(config.root, projectTaskMatch[2], changes, projectTaskMatch[1]));
      }
      if (request.method === 'POST' && projectDocumentMatch) {
        const body = await requestBody(request);
        return json(response, 200, updateDocumentBody(config.root, projectDocumentMatch[1], decodeURIComponent(projectDocumentMatch[2]), body));
      }
      if (request.method === 'POST' && projectContractPlanMatch) {
        const body = await requestBody(request);
        return json(response, 200, planDocumentContract(config.root, projectContractPlanMatch[1], body));
      }
      if (request.method === 'POST' && projectContractMatch) {
        const body = await requestBody(request);
        return json(response, 200, updateDocumentContract(config.root, projectContractMatch[1], body));
      }
      if (request.method === 'POST' && projectLeaseActionMatch) {
        const body = await requestBody(request);
        return json(response, 200, appendLease(config.root, projectLeaseActionMatch[3], { project: projectLeaseActionMatch[1], documentId: decodeURIComponent(projectLeaseActionMatch[2]), clientId: body.clientId }));
      }
      if (request.method === 'POST' && projectRefreshMatch) return json(response, 200, refreshState(config.root, { project: projectRefreshMatch[1] }));
      if (request.method === 'POST' && projectSyncMatch) return json(response, 200, syncState(config.root, { project: projectSyncMatch[1], remote: 'origin', push: true }));
      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await requestBody(request);
        const input = taskInput(body, true);
        input.project = activeConfig.project;
        validateTaskAssignments(activeConfig.root, input, activeConfig.project);
        return json(response, 201, taskCreate(activeConfig.root, input));
      }
      if (request.method === 'POST' && taskMatch) {
        const body = await requestBody(request);
        requireRevision(activeConfig, taskMatch[1], body.baseRevision);
        const changes = taskInput(body, false);
        if (Object.keys(changes).length === 0) return json(response, 400, { error: '변경할 태스크 필드가 필요합니다.' });
        validateTaskAssignments(activeConfig.root, changes, activeConfig.project);
        const result = taskUpdate(activeConfig.root, taskMatch[1], changes, activeConfig.project);
        return json(response, 200, result);
      }
      if (request.method === 'POST' && collaborationMatch) {
        const body = await requestBody(request);
        return json(response, 200, updateCollaboration(activeConfig.root, collaborationMatch[1], body, activeConfig.project));
      }
      if (request.method === 'POST' && url.pathname === '/api/refresh') return json(response, 200, refreshState(activeConfig.root, { project: activeConfig.project }));
      if (request.method === 'POST' && url.pathname === '/api/sync') return json(response, 200, syncState(activeConfig.root, { project: activeConfig.project, remote: 'origin', push: true }));
      return json(response, 404, { error: '경로를 찾지 못했습니다.' });
    } catch (error) {
      return json(response, error.statusCode || 500, { error: error.message, current: error.current || undefined });
    }
  });
  return { server, token, root: config.root };
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function startBoard(start, options) {
  const settings = Object.assign({ port: 0, open: true }, options || {});
  const board = createBoardServer(start, settings);
  return new Promise((resolve, reject) => {
    board.server.once('error', reject);
    board.server.listen(settings.port, '127.0.0.1', () => {
      const address = board.server.address();
      const url = `http://127.0.0.1:${address.port}/`;
      if (settings.open) openBrowser(url);
      resolve(Object.assign(board, { url, port: address.port }));
    });
  });
}

module.exports = { STATUSES, boardConfig, queryTasks, boardRevision, overview, workspaceSnapshot, attentionItems, createBoardServer, startBoard };
