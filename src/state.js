'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGit, refExists, gitRoot } = require('./git');
const { mergeTaskDocuments } = require('./merge');
const { checkWorkspace, findWorkspaceRoot, readWorkspaceManifest, yamlNestedValue } = require('./check');
const { workspaceLayout, selectProject } = require('./workspace');
const { readTaskStore, createTaskInStore, updateTaskInStore, restoreStoreWrite, materializeTaskStore, migrateTaskStore, assertBlockerConsistency, assertCancellationConsistency } = require('./tasks');
const { initSettings, saveSettings, prepareSettings, finalizeSettings } = require('./settings');
const { loadHarnessSettings, retryPolicy } = require('./harness-settings');
const { getClient } = require('./collaboration-store');
const { readCollaboration } = require('./collaboration');
const { runtimeWorkspace } = require('./runtime');
const { installBranchBoundary, assertWorktreeBoundary } = require('./branch-boundary');

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function syncCommandDigest(settings) {
  const command = {
    command: 'sync',
    project: settings.project || null,
    remote: settings.remote || 'origin',
    push: settings.push !== false,
    clientId: settings.clientId || null
  };
  return crypto.createHash('sha256').update(JSON.stringify(command), 'utf8').digest('hex');
}

function sameDirectory(left, right) {
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  if (leftStat.dev === rightStat.dev && leftStat.ino !== 0 && leftStat.ino === rightStat.ino) return true;
  return path.resolve(left).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(right).replace(/[\\/]+$/, '').toLowerCase();
}

function stateConfig(start) {
  const root = findWorkspaceRoot(start);
  const repositoryRoot = path.resolve(gitRoot(root));
  if (!sameDirectory(root, repositoryRoot)) throw new Error('현재 버전은 Rundol Workspace 루트와 Git 저장소 루트가 같아야 합니다.');
  const manifest = readWorkspaceManifest(root).source;
  const ref = yamlNestedValue(manifest, 'tasks', 'ref') || 'refs/heads/rundol/workspace';
  if (!ref.startsWith('refs/heads/')) throw new Error(`tasks.ref는 로컬 branch ref여야 합니다: ${ref}`);
  const branch = ref.slice('refs/heads/'.length);
  const taskRelative = yamlNestedValue(manifest, 'tasks', 'path') || 'tasks.json';
  if (taskRelative.includes('/') || taskRelative.includes('\\')) throw new Error('현재 버전의 tasks.path는 workspace 브랜치 루트 파일만 지원합니다.');
  const projectionRelative = yamlNestedValue(manifest, 'tasks', 'projection') || '.rundol/local/tasks.json';
  return {
    root,
    ref,
    branch,
    taskRelative,
    worktree: path.join(root, '.rundol', 'worktrees', 'workspace'),
    projection: path.resolve(root, projectionRelative),
    pending: path.join(root, '.rundol', 'pending')
  };
}

function workspaceStateConfig(start, projectKey) {
  const layout = workspaceLayout(start);
  if (layout.schemaVersion < 2) return stateConfig(start);
  const repositoryRoot = path.resolve(gitRoot(layout.root));
  if (!sameDirectory(layout.root, repositoryRoot)) throw new Error('Rundol Workspace 루트는 Git 저장소 루트와 같아야 합니다.');
  if (layout.schemaVersion >= 3) {
    const project = selectProject(layout, projectKey, true);
    return {
      schemaVersion: layout.schemaVersion,
      root: layout.root,
      runtime: layout.runtime || null,
      project: project.key,
      ref: project.ref,
      branch: project.branch,
      taskStorage: project.taskStorage || 'single',
      taskRelative: project.taskRelative || 'tasks.json',
      worktree: project.root,
      projection: project.taskStorage === 'sharded' ? project.taskProjection : project.tasks,
      pending: path.join(project.root, '.rundol', 'state', 'pending')
    };
  }
  return {
    schemaVersion: layout.schemaVersion,
    root: layout.root,
    ref: layout.ref,
    branch: layout.branch,
    taskRelative: 'tasks.json',
    worktree: layout.mount,
    projection: layout.tasks,
    pending: layout.runtime ? layout.runtime.pending : path.join(layout.root, '.rundol', 'pending')
  };
}

function workspaceStateConfigs(start, projectKey) {
  const layout = workspaceLayout(start);
  if (layout.schemaVersion < 3 || projectKey) return [workspaceStateConfig(start, projectKey)];
  if (layout.projects.length === 0) throw new Error('등록된 프로젝트가 없습니다.');
  return layout.projects.map((project) => workspaceStateConfig(layout.root, project.key));
}

function remotes(root) {
  const output = runGit(['remote'], { cwd: root }).stdout;
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function remoteRefMissing(result) {
  return /couldn't find remote ref|remote ref does not exist|not found/i.test(`${result.stderr}\n${result.stdout}`);
}

function fetchInitialWorkspaceRef(config, remote) {
  const remoteRef = `refs/remotes/${remote}/${config.branch}`;
  runGit(['update-ref', '-d', remoteRef], { cwd: config.root, allowFailure: true });
  const fetch = runGit(['fetch', '--no-tags', remote, `+${config.ref}:${remoteRef}`], { cwd: config.root, allowFailure: true });
  if (fetch.status === 0 && refExists(config.root, remoteRef)) {
    const commit = runGit(['rev-parse', remoteRef], { cwd: config.root }).stdout;
    runGit(['update-ref', config.ref, commit], { cwd: config.root });
    return { created: true, source: remoteRef };
  }
  if (fetch.status !== 0 && !remoteRefMissing(fetch)) {
    const detail = (fetch.stderr || fetch.stdout || '').trim();
    throw new Error(`원격 workspace 브랜치를 확인하지 못했습니다${detail ? `: ${detail}` : ''}`);
  }
  return null;
}

function seedTasks(config) {
  for (const file of [config.projection, path.join(config.root, config.taskRelative)]) {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return canonicalJson(parsed);
    }
  }
  return canonicalJson({ schemaVersion: 1, tasks: {} });
}

function createStateRef(config) {
  const remote = remotes(config.root).includes('origin') ? 'origin' : null;
  if (remote) {
    const fetched = fetchInitialWorkspaceRef(config, remote);
    if (fetched) return fetched;
  }
  const content = seedTasks(config);
  const blob = runGit(['hash-object', '-w', '--stdin'], { cwd: config.root, input: content }).stdout;
  const tree = runGit(['mktree'], { cwd: config.root, input: `100644 blob ${blob}\t${config.taskRelative}\n` }).stdout;
  const commit = runGit(['commit-tree', tree, '-m', 'rdl: initialize workspace'], { cwd: config.root }).stdout;
  runGit(['update-ref', config.ref, commit], { cwd: config.root });
  return { created: true, source: 'seed' };
}

function seedWorkspaceTree(config) {
  if (!fs.existsSync(config.worktree)) {
    if (config.schemaVersion >= 3) throw new Error(`원격 브랜치와 로컬 프로젝트 seed가 모두 없습니다: ${config.project}`);
    const blob = runGit(['hash-object', '-w', '--stdin'], { cwd: config.root, input: canonicalJson({ schemaVersion: 2, tasks: {} }) }).stdout;
    return runGit(['mktree'], { cwd: config.root, input: `100644 blob ${blob}\t${config.taskRelative}\n` }).stdout;
  }
  if (config.schemaVersion >= 3) {
    for (const required of ['project.md', config.taskRelative]) {
      if (!fs.existsSync(path.join(config.worktree, required))) throw new Error(`프로젝트 seed 필수 파일이 없습니다: ${config.project}/${required}`);
    }
  }
  const index = path.join(config.runtime ? config.runtime.state : os.tmpdir(), `rundol-seed-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    runGit([`--work-tree=${config.worktree}`, 'read-tree', '--empty'], { cwd: config.root, env });
    const add = [`--work-tree=${config.worktree}`, 'add', '-A'];
    if (config.schemaVersion < 6) add.push('-f');
    add.push('--', '.');
    runGit(add, { cwd: config.root, env });
    return runGit(['write-tree'], { cwd: config.root, env }).stdout;
  } finally {
    if (fs.existsSync(index)) fs.unlinkSync(index);
  }
}

function createWorkspaceRef(config) {
  if (config.schemaVersion < 2) return createStateRef(config);
  const remote = remotes(config.root).includes('origin') ? 'origin' : null;
  if (remote) {
    const fetched = fetchInitialWorkspaceRef(config, remote);
    if (fetched) return fetched;
  }
  const tree = seedWorkspaceTree(config);
  const commit = runGit(['commit-tree', tree, '-m', 'rdl: initialize workspace'], { cwd: config.root }).stdout;
  runGit(['update-ref', config.ref, commit], { cwd: config.root });
  return { created: true, source: 'seed' };
}

function validWorktree(config) {
  if (!fs.existsSync(path.join(config.worktree, '.git'))) return false;
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: config.worktree, allowFailure: true });
  return result.status === 0 && result.stdout === config.branch;
}

function ensureWorktree(config) {
  if (validWorktree(config)) return false;
  if (fs.existsSync(config.worktree) && fs.readdirSync(config.worktree).length > 0) throw new Error(`관리되지 않은 workspace worktree 경로가 이미 존재합니다: ${config.worktree}`);
  fs.mkdirSync(path.dirname(config.worktree), { recursive: true });
  runGit(['worktree', 'prune'], { cwd: config.root });
  runGit(['worktree', 'add', '--force', config.worktree, config.branch], { cwd: config.root });
  return true;
}

function ensureWorkspaceWorktree(config) {
  if (config.schemaVersion < 2) return ensureWorktree(config);
  if (validWorktree(config)) {
    assertWorktreeBoundary({
      root: config.root,
      worktree: config.worktree,
      branch: config.branch,
      role: config.project ? 'project' : 'workspace',
      project: config.project || null,
      canonical: config.schemaVersion >= 6
    });
    return false;
  }
  let backup = null;
  if (fs.existsSync(config.worktree) && fs.readdirSync(config.worktree).length > 0) {
    backup = path.join(config.runtime ? config.runtime.state : os.tmpdir(), `rundol-mount-backup-${process.pid}-${Date.now()}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    try {
      fs.renameSync(config.worktree, backup);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      fs.cpSync(config.worktree, backup, { recursive: true });
      fs.rmSync(config.worktree, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(config.worktree), { recursive: true });
  try {
    runGit(['worktree', 'prune'], { cwd: config.root });
    runGit(['worktree', 'add', '--force', config.worktree, config.branch], { cwd: config.root });
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(config.worktree)) fs.rmSync(config.worktree, { recursive: true, force: true });
    if (backup && fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, config.worktree);
      } catch (restoreError) {
        if (restoreError.code !== 'EXDEV') throw restoreError;
        fs.cpSync(backup, config.worktree, { recursive: true });
        fs.rmSync(backup, { recursive: true, force: true });
      }
    }
    throw error;
  }
  assertWorktreeBoundary({
    root: config.root,
    worktree: config.worktree,
    branch: config.branch,
    role: config.project ? 'project' : 'workspace',
    project: config.project || null,
    canonical: config.schemaVersion >= 6
  });
  return true;
}

function materialize(config) {
  const source = path.join(config.worktree, config.taskRelative);
  if (!fs.existsSync(source) && config.taskStorage === 'sharded') {
    fs.mkdirSync(source, { recursive: true });
    atomicWrite(config.projection, canonicalJson({ schemaVersion: 3, generated: true, tasks: {} }));
    return { projection: config.projection, tasks: 0 };
  }
  if (!fs.existsSync(source)) throw new Error(`workspace 브랜치에 ${config.taskRelative}이 없습니다.`);
  if (config.taskStorage === 'sharded') return materializeTaskStore(source, config.projection);
  const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
  atomicWrite(config.projection, canonicalJson(parsed));
  return { projection: config.projection, tasks: Object.keys(parsed.tasks || {}).length };
}

function initProjectState(config) {
  const state = refExists(config.root, config.ref) ? { created: false, source: config.ref } : createWorkspaceRef(config);
  const worktreeCreated = ensureWorkspaceWorktree(config);
  const projection = materialize(config);
  const commit = runGit(['rev-parse', config.ref], { cwd: config.root }).stdout;
  return { root: config.root, project: config.project || null, branch: config.branch, branchCreated: state.created, branchSource: state.source, worktree: config.worktree, worktreeCreated, projection: projection.projection, tasks: projection.tasks, commit };
}

function initState(start, options) {
  const project = typeof options === 'string' ? options : options && options.project;
  let settings = initSettings(start, options || {});
  const settingsSaved = saveSettings(start);
  if (settings && settingsSaved) settings = Object.assign(settings, { saved: settingsSaved.changed, commit: settingsSaved.commit });
  const results = workspaceStateConfigs(start, project).map(initProjectState);
  const boundary = installBranchBoundary(results[0].root, options || {});
  return results.length === 1 ? Object.assign(results[0], { settings, boundary }) : { root: results[0].root, settings, boundary, projects: results };
}

function refreshProjectState(config) {
  if (!refExists(config.root, config.ref)) throw new Error('workspace 브랜치가 없습니다. 먼저 rdl git init을 실행하세요.');
  ensureWorkspaceWorktree(config);
  const status = runGit(['status', '--porcelain'], { cwd: config.worktree }).stdout;
  const projection = materialize(config);
  const checked = validateProjection(config);
  return { root: config.root, project: config.project || null, branch: config.branch, projection: projection.projection, tasks: projection.tasks, dirty: Boolean(status), errors: checked.summary.errors, commit: runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout };
}

function refreshState(start, options) {
  const project = typeof options === 'string' ? options : options && options.project;
  const results = workspaceStateConfigs(start, project).map(refreshProjectState);
  return results.length === 1 ? results[0] : { root: results[0].root, projects: results };
}

function readCommitTasks(config, ref) {
  const content = runGit(['show', `${ref}:${config.taskRelative}`], { cwd: config.root }).stdout;
  return JSON.parse(content);
}

function validateProjection(config, options) {
  const settings = options || {};
  const result = checkWorkspace(config.root, { strict: true, project: config.project || null, skipProfilePolicy: settings.skipProfilePolicy === true });
  if (result.summary.errors > 0) {
    const first = result.diagnostics.find((item) => item.severity === 'error');
    throw new Error(`workspace 변경 검증 실패: ${first ? `${first.code} ${first.message}` : '알 수 없는 오류'}`);
  }
  return result;
}

function taskId(tasks) {
  let id;
  do {
    const time = Date.now().toString(36).toUpperCase().padStart(10, '0');
    const random = crypto.randomBytes(8).toString('hex').toUpperCase();
    id = `TASK-${time}${random}`;
  } while (Object.prototype.hasOwnProperty.call(tasks, id));
  return id;
}

function persistTaskChange(config, values) {
  const projectionBefore = fs.existsSync(config.projection) ? fs.readFileSync(config.projection, 'utf8') : null;
  const taskFile = path.join(config.worktree, config.taskRelative);
  let storeChange = null;
  try {
    if (config.taskStorage === 'sharded') {
      storeChange = values.op === 'create'
        ? createTaskInStore(taskFile, config.worktree, values.taskId, values.after, values.clientId)
        : updateTaskInStore(taskFile, values.taskId, values.document.tasks[values.taskId]);
    } else atomicWrite(taskFile, canonicalJson(values.document));
    materialize(config);
    validateProjection(config, { skipProfilePolicy: true });
  } catch (error) {
    if (storeChange) restoreStoreWrite(storeChange);
    else atomicWrite(taskFile, values.original);
    if (projectionBefore === null) {
      if (fs.existsSync(config.projection)) fs.unlinkSync(config.projection);
    } else atomicWrite(config.projection, projectionBefore);
    throw error;
  }
  const baseRevision = runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout;
  fs.mkdirSync(config.pending, { recursive: true });
  const operationId = `OP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  atomicWrite(path.join(config.pending, `${operationId}.json`), canonicalJson({
    operationId,
    taskId: values.taskId,
    baseRevision,
    op: values.op,
    before: values.before,
    after: values.after,
    createdAt: values.now
  }));
  const changedRelative = storeChange ? path.relative(config.worktree, storeChange.file).replace(/\\/g, '/') : config.taskRelative;
  runGit(['add', '--', changedRelative], { cwd: config.worktree });
  runGit(['commit', '-m', values.message], { cwd: config.worktree });
  return runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout;
}

// 반려를 되돌릴 때 사유를 남겨두면 "반려가 아닌데 반려 사유가 있는" 상태가 되어 검증이 막는다.
// 호출자마다 같은 짝을 다시 쓰게 하는 대신 여기서 정리한다. 결정자를 생략하면 태스크 owner가
// 결정한 것으로 본다. CLI는 태스크를 읽지 않으므로 그 값을 알 수 없다.
function normalizeCancellationChange(task, changes) {
  if (!changes || !Object.prototype.hasOwnProperty.call(changes, 'status')) return;
  if (changes.status !== 'cancelled') {
    if (task.cancellation && !Object.prototype.hasOwnProperty.call(changes, 'cancellation')) changes.cancellation = null;
    return;
  }
  const cancellation = changes.cancellation || task.cancellation;
  if (!cancellation) return;
  changes.cancellation = Object.assign({}, cancellation, { decidedBy: cancellation.decidedBy || changes.owner || task.owner || null });
}

function taskUpdate(start, taskIdValue, changes, projectKey) {
  const config = workspaceStateConfig(start, projectKey);
  if (!refExists(config.root, config.ref)) initState(config.root, { project: config.project });
  ensureWorkspaceWorktree(config);
  const taskFile = path.join(config.worktree, config.taskRelative);
  const original = config.taskStorage === 'sharded' ? null : fs.readFileSync(taskFile, 'utf8');
  const parsed = readTaskStore(taskFile);
  const task = parsed.tasks && parsed.tasks[taskIdValue];
  if (!task) throw new Error(`태스크를 찾지 못했습니다: ${taskIdValue}`);
  normalizeCancellationChange(task, changes);
  assertBlockerConsistency(task, changes);
  assertCancellationConsistency(task, changes);
  const before = {};
  const changedFields = Object.keys(changes).filter((field) => JSON.stringify(task[field]) !== JSON.stringify(changes[field]));
  if (changedFields.length === 0) {
    return { changed: false, taskId: taskIdValue, commit: runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout };
  }
  const now = new Date().toISOString();
  for (const field of changedFields) {
    before[field] = task[field];
    task[field] = changes[field];
  }
  if (changedFields.includes('status')) task.statusChangedAt = now;
  task.updatedAt = now;
  const fields = changedFields.join(',');
  const commit = persistTaskChange(config, {
    document: parsed,
    original,
    taskId: taskIdValue,
    op: 'update',
    before,
    after: changes,
    now,
    message: `rdl: update ${taskIdValue} ${fields}`
  });
  return { changed: true, taskId: taskIdValue, before, after: changes, commit, projection: config.projection };
}

function taskCreate(start, input) {
  const config = workspaceStateConfig(start, input && input.project);
  if (!refExists(config.root, config.ref)) initState(config.root, { project: config.project });
  ensureWorkspaceWorktree(config);
  const taskFile = path.join(config.worktree, config.taskRelative);
  const original = config.taskStorage === 'sharded' ? null : fs.readFileSync(taskFile, 'utf8');
  const parsed = readTaskStore(taskFile);
  if (!parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)) parsed.tasks = {};
  const now = new Date().toISOString();
  const id = taskId(parsed.tasks);
  const task = Object.assign({
    title: '',
    summary: '',
    owner: null,
    reviewers: [],
    stakeholders: [],
    status: 'todo',
    priority: 'mid',
    links: [],
    deps: [],
    acceptanceCriteria: {},
    blocker: null,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
    externalRefs: []
  }, input || {});
  if (config.schemaVersion >= 2) {
    const project = selectProject(workspaceLayout(config.root), config.project || task.project, true);
    task.project = project.key;
  }
  if ((task.links || []).some((link) => /^(?:REQ|TST)-/u.test(String(link)))) task.implementationReadiness = 'atomic-v1';
  assertBlockerConsistency(null, task);
  assertCancellationConsistency(null, task);
  parsed.tasks[id] = task;
  const commit = persistTaskChange(config, {
    document: parsed,
    original,
    taskId: id,
    op: 'create',
    before: null,
    after: task,
    now,
    message: `rdl: create ${id}`
  });
  return { changed: true, taskId: id, task, commit, projection: config.projection };
}

function taskSet(start, taskIdValue, changes, projectKey) {
  return taskUpdate(start, taskIdValue, changes, projectKey);
}

function taskAcceptance(start, taskIdValue, acceptanceId, done, projectKey) {
  const config = workspaceStateConfig(start, projectKey);
  if (!refExists(config.root, config.ref)) initState(config.root, { project: config.project });
  ensureWorkspaceWorktree(config);
  const store = readTaskStore(path.join(config.worktree, config.taskRelative));
  const task = store.tasks && store.tasks[taskIdValue];
  if (!task) throw new Error(`태스크를 찾지 못했습니다: ${taskIdValue}`);
  if (!task.acceptanceCriteria || !Object.prototype.hasOwnProperty.call(task.acceptanceCriteria, acceptanceId)) {
    throw new Error(`수용조건을 찾지 못했습니다: ${taskIdValue}/${acceptanceId}`);
  }
  const acceptanceCriteria = JSON.parse(JSON.stringify(task.acceptanceCriteria));
  acceptanceCriteria[acceptanceId].done = done === true;
  return taskUpdate(config.root, taskIdValue, { acceptanceCriteria }, config.project);
}

function commitSemanticMerge(config, localCommit, remoteCommit, merged) {
  const taskFile = path.join(config.worktree, config.taskRelative);
  atomicWrite(taskFile, canonicalJson(merged));
  runGit(['add', '--', config.taskRelative], { cwd: config.worktree });
  const tree = runGit(['write-tree'], { cwd: config.worktree }).stdout;
  const commit = runGit(['commit-tree', tree, '-p', localCommit, '-p', remoteCommit, '-m', 'rdl: merge workspace'], { cwd: config.root }).stdout;
  runGit(['update-ref', config.ref, commit, localCommit], { cwd: config.root });
  runGit(['reset', '--hard', commit], { cwd: config.worktree });
  return commit;
}

function commitWorkspaceMerge(config, remoteCommit, mergedTasks) {
  const merge = runGit(['merge', '--no-commit', '--no-ff', remoteCommit], { cwd: config.worktree, allowFailure: true });
  const unmerged = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: config.worktree }).stdout.split(/\r?\n/).filter(Boolean);
  const documentConflicts = unmerged.filter((file) => file !== config.taskRelative);
  if (documentConflicts.length > 0 || (merge.status !== 0 && unmerged.length === 0)) {
    runGit(['merge', '--abort'], { cwd: config.worktree, allowFailure: true });
    throw new Error(documentConflicts.length > 0 ? `프로젝트 문서 충돌을 해결해야 합니다: ${documentConflicts.join(', ')}` : `workspace 병합 실패: ${merge.stderr}`);
  }
  try {
    atomicWrite(path.join(config.worktree, config.taskRelative), canonicalJson(mergedTasks));
    runGit(['add', '--', config.taskRelative], { cwd: config.worktree });
    validateProjection(config);
    runGit(['commit', '-m', 'rdl: merge workspace'], { cwd: config.worktree });
    return runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout;
  } catch (error) {
    runGit(['merge', '--abort'], { cwd: config.worktree, allowFailure: true });
    throw error;
  }
}

function commitShardedMerge(config, remoteCommit) {
  const merge = runGit(['merge', '--no-commit', '--no-ff', remoteCommit], { cwd: config.worktree, allowFailure: true });
  const unmerged = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: config.worktree }).stdout.split(/\r?\n/).filter(Boolean);
  if (merge.status !== 0 || unmerged.length > 0) {
    runGit(['merge', '--abort'], { cwd: config.worktree, allowFailure: true });
    fs.mkdirSync(config.pending, { recursive: true });
    const conflictFile = path.join(config.pending, 'merge-conflicts.json');
    atomicWrite(conflictFile, canonicalJson({
      version: 2,
      project: config.project,
      ours: runGit(['rev-parse', config.ref], { cwd: config.root }).stdout,
      theirs: remoteCommit,
      files: unmerged,
      conflicts: unmerged.map((file) => ({ path: file, kind: 'file' }))
    }));
    throw new Error(`파일 충돌 ${unmerged.length || 1}건이 있습니다: ${conflictFile}`);
  }
  materialize(config);
  validateProjection(config);
  runGit(['commit', '-m', 'rdl: merge workspace'], { cwd: config.worktree });
  return runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout;
}

function saveProjectState(config, settings) {
  if (!refExists(config.root, config.ref)) initProjectState(config);
  ensureWorkspaceWorktree(config);
  validateProjection(config);
  const status = runGit(['status', '--porcelain'], { cwd: config.worktree }).stdout;
  if (!status) return { root: config.root, project: config.project || null, branch: config.branch, changed: false, commit: runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout };
  runGit(['add', '-A', '--', '.'], { cwd: config.worktree });
  runGit(['commit', '-m', settings.message || 'rdl: update workspace'], { cwd: config.worktree });
  return { root: config.root, project: config.project || null, branch: config.branch, changed: true, commit: runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout };
}

function saveState(start, options) {
  const settings = options || {};
  const settingsResult = saveSettings(start);
  const results = workspaceStateConfigs(start, settings.project).map((config) => saveProjectState(config, settings));
  return results.length === 1 ? Object.assign(results[0], { settings: settingsResult }) : { root: results[0].root, settings: settingsResult, changed: results.some((item) => item.changed) || Boolean(settingsResult && settingsResult.changed), projects: results };
}

function waitForSyncRetry(seconds, settings) {
  if (typeof settings.sleep === 'function') return settings.sleep(seconds);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function nonFastForward(result) {
  return /non-fast-forward|fetch first|rejected/u.test(`${result.stderr}\n${result.stdout}`);
}

function prepareProjectState(config, settings) {
  const remote = settings.remote || 'origin';
  const saved = saveProjectState(config, settings);
  if (!refExists(config.root, config.ref)) initProjectState(config);
  ensureWorkspaceWorktree(config);
  if (!remotes(config.root).includes(remote)) throw new Error(`Git remote가 없습니다: ${remote}`);
  const localBefore = runGit(['rev-parse', config.ref], { cwd: config.root }).stdout;
  // Do not read FETCH_HEAD here. Workspace and project watch processes share
  // that file, so a concurrent fetch can replace it with another branch.
  const remoteRef = `refs/remotes/${remote}/${config.branch}`;
  const fetch = runGit(['fetch', '--no-tags', remote, `+${config.ref}:${remoteRef}`], { cwd: config.root, allowFailure: true });
  let action = 'unchanged';
  let commit = localBefore;
  if (fetch.status === 0) {
    const remoteCommit = runGit(['rev-parse', remoteRef], { cwd: config.root }).stdout;
    if (remoteCommit !== localBefore) {
      const baseResult = runGit(['merge-base', localBefore, remoteCommit], { cwd: config.root, allowFailure: true });
      if (baseResult.status !== 0) throw new Error('로컬과 원격 workspace 브랜치에 공통 이력이 없습니다. 자동 병합하지 않습니다.');
      const base = baseResult.stdout;
      if (base === localBefore) {
        runGit(['update-ref', config.ref, remoteCommit, localBefore], { cwd: config.root });
        runGit(['reset', '--hard', remoteCommit], { cwd: config.worktree });
        commit = remoteCommit;
        action = 'fast-forward';
      } else if (base !== remoteCommit) {
        if (config.taskStorage === 'sharded') {
          commit = commitShardedMerge(config, remoteCommit);
          action = 'git-merge';
        } else {
        const merged = mergeTaskDocuments(readCommitTasks(config, base), readCommitTasks(config, localBefore), readCommitTasks(config, remoteCommit));
        if (merged.conflicts.length > 0) {
          fs.mkdirSync(config.pending, { recursive: true });
          const conflictFile = path.join(config.pending, 'merge-conflicts.json');
          atomicWrite(conflictFile, canonicalJson({ base, ours: localBefore, theirs: remoteCommit, conflicts: merged.conflicts }));
          throw new Error(`의미 충돌 ${merged.conflicts.length}건이 있습니다: ${conflictFile}`);
        }
        if (config.schemaVersion >= 2) commit = commitWorkspaceMerge(config, remoteCommit, merged.value);
        else {
          const projectionBefore = fs.existsSync(config.projection) ? fs.readFileSync(config.projection, 'utf8') : null;
          atomicWrite(config.projection, canonicalJson(merged.value));
          try {
            validateProjection(config);
          } catch (error) {
            if (projectionBefore !== null) atomicWrite(config.projection, projectionBefore);
            throw error;
          }
          commit = commitSemanticMerge(config, localBefore, remoteCommit, merged.value);
        }
        action = 'semantic-merge';
        }
      } else action = 'local-ahead';
    }
  } else if (!/couldn't find remote ref|remote ref does not exist|not found/i.test(fetch.stderr)) {
    throw new Error(`workspace fetch 실패: ${fetch.stderr}`);
  } else action = 'publish-new';
  materialize(config);
  validateProjection(config);
  return { root: config.root, project: config.project || null, branch: config.branch, remote, action, commit, saved: saved.changed, pushed: false, projection: config.projection };
}

function syncProjectState(config, settings) {
  const policy = settings.retryPolicy || { retryBackoffSeconds: [1, 2, 4], maxAttempts: 3 };
  if (settings.push === false) return prepareProjectState(config, settings);
  let prepared = null;
  let pushed = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    prepared = prepareProjectState(config, settings);
    pushed = runGit(['push', prepared.remote, `${config.ref}:${config.ref}`], { cwd: config.root, allowFailure: true });
    if (pushed.status === 0) return Object.assign({}, prepared, { pushed: true, attempts: attempt, commit: runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout });
    if (!nonFastForward(pushed) || attempt === policy.maxAttempts) break;
    waitForSyncRetry(policy.retryBackoffSeconds[attempt - 1], settings);
  }
  throw new Error(`project push 실패${nonFastForward(pushed) ? ' (retry exhausted)' : ''}: ${(pushed.stderr || pushed.stdout).trim()}`);
}

// 런의 두 번째 완료: 병합에서 살아남아 push까지 마친 뒤에만 synced다.
// sync의 어떤 실패든(의미 충돌, sharded 병합, push) 진행 중이거나 로컬 완료인
// 런을 재개 가능한 halted로 전이시킨다 — 실패를 조용히 지나가는 런은 없다.
function transitionRuns(config, apply, settings) {
  if (!config.project) return [];
  const ledger = require('./run-ledger');
  const transitions = [];
  // 전이 대상은 로컬 .rundol/runs만이 아니다 — 로컬 원장은 git으로 전파되지
  // 않으므로, 새 clone의 sync 실행자는 공유 샤드에만 있는 런을 로컬 열거로는
  // 영영 보지 못해 synced/halted 전이가 누락된다. 공유 run 샤드와 union으로 연다.
  const runIds = new Set(ledger.listRuns(config.worktree).map((run) => run.runId));
  if (typeof ledger.listSharedRunIds === 'function') {
    const { workspaceLayout } = require('./workspace');
    for (const runId of ledger.listSharedRunIds(workspaceLayout(config.root), config.project)) runIds.add(runId);
  }
  for (const runId of Array.from(runIds).sort()) {
    // 소유권은 로컬 파일이 아니라 공유를 먼저 reconcile한 union에서 도출한다.
    // 다른 클라이언트의 takeover는 공유에만 있을 수 있고, 죽은 토큰으로 기록된
    // 전이는 잘린 epoch에 떨어져 보이지 않게 된다.
    const reconciled = typeof ledger.reconcileRun === 'function' ? ledger.reconcileRun(config.root, { project: config.project, runId }) : null;
    const events = reconciled ? reconciled.events : ledger.readRunEvents(ledger.runDirectory(config.worktree, runId));
    const fold = typeof ledger.foldSharedRun === 'function' && events.some((item) => item && item.schemaVersion === 2) ? ledger.foldSharedRun(events) : ledger.foldRun(events);
    const event = apply(fold);
    if (!event) continue;
    let ownerToken = null;
    if (events.some((item) => item && item.schemaVersion === 2)) {
      const ownership = ledger.ownershipState(events);
      if (ownership.status !== 'ACTIVE') {
        transitions.push({ runId, type: event.type, skipped: 'ownership-not-active' });
        continue;
      }
      ownerToken = ownership.ownerToken;
    }
    const recorded = ledger.recordRunEvent(config.root, {
      project: config.project,
      runId,
      rootRequestId: settings.rootRequestId || settings.requestId,
      childKey: `transition:${config.project}:${runId}:${event.commit || 'none'}:${event.type}`,
      commandDigest: settings.commandDigest,
      event: Object.assign({}, event, { clientId: settings.clientId, ...(ownerToken ? { ownerToken } : {}) })
    });
    transitions.push({ runId, type: event.type, recorded });
  }
  return transitions;
}

function syncProjectStateWithRuns(config, settings) {
  try {
    const result = syncProjectState(config, settings);
    const transitions = result.pushed ? transitionRuns(config, (run) => (run.status === 'completed_local'
      ? { type: 'run.synced', commit: result.commit, remoteRef: `refs/remotes/${result.remote}/${result.branch}` }
      : null), settings) : [];
    return Object.assign({}, result, { transitions });
  } catch (error) {
    const reason = /충돌/u.test(error.message || '') ? 'merge-conflict' : 'sync-failed';
    try {
      transitionRuns(config, (run) => (run.status === 'running' || run.status === 'completed_local'
        ? { type: 'run.halted', reason, ...(run.cursor ? { atStep: run.cursor } : {}), resumable: true }
        : null), settings);
    } catch (transitionError) {
      throw new AggregateError([error, transitionError], `sync 실패(${error.message}) 후 run.halted 전이도 실패했습니다: ${transitionError.message}`);
    }
    throw error;
  }
}

function preflightSyncClient(start, configs, clientId) {
  if (configs.every((config) => !config.schemaVersion || config.schemaVersion < 6)) return null;
  if (!clientId) throw new Error('--client-id <id>가 필요합니다.');
  const client = getClient(start, clientId);
  if (client.status !== 'active') throw new Error(`sync 실행 Client가 비활성 상태입니다: ${clientId}`);
  if (!['agent', 'service'].includes(client.type)) throw new Error(`sync 실행 Client는 agent 또는 service여야 합니다: ${clientId}`);
  for (const config of configs) {
    if (!config.project) continue;
    const collaboration = readCollaboration(config.root, config.project);
    const member = collaboration.members.find((item) => item.id === client.owner);
    if (!member || member.fields['상태'] !== 'active') throw new Error(`${config.project}의 active member가 소유한 Client가 아닙니다: ${clientId}`);
  }
  return client;
}

function syncState(start, options) {
  const settings = Object.assign({}, options || {});
  const configs = workspaceStateConfigs(start, settings.project);
  preflightSyncClient(start, configs, settings.clientId);
  if (!settings.rootRequestId && !settings.requestId) settings.rootRequestId = require('./run-ledger').newRequestId();
  if (!settings.commandDigest) settings.commandDigest = syncCommandDigest(settings);
  const harnessByProject = new Map(configs.map((config) => [config.project, loadHarnessSettings(start, { project: config.project })]));
  const workspacePolicy = retryPolicy(harnessByProject.get(configs[0].project));
  const settingsPrepared = prepareSettings(start, Object.assign({}, settings, { push: false, retryPolicy: workspacePolicy }));
  const results = [];
  try {
    for (const config of configs) {
      const harness = harnessByProject.get(config.project);
      results.push(syncProjectStateWithRuns(config, Object.assign({}, settings, { retryPolicy: retryPolicy(harness) })));
    }
    const settingsResult = finalizeSettings(start, Object.assign({}, settings, { retryPolicy: workspacePolicy }));
    const workspaceResult = settingsPrepared ? Object.assign({}, settingsPrepared, settingsResult, { prepared: true }) : settingsResult;
    return results.length === 1 ? Object.assign(results[0], { settings: workspaceResult, rootRequestId: settings.rootRequestId || settings.requestId }) : { root: results[0].root, settings: workspaceResult, pushed: results.every((item) => item.pushed), rootRequestId: settings.rootRequestId || settings.requestId, projects: results };
  } catch (error) {
    try {
      finalizeSettings(start, Object.assign({}, settings, { retryPolicy: workspacePolicy }));
    } catch (finalizeError) {
      throw new AggregateError([error, finalizeError], `sync 실패 상태의 workspace finalization도 실패했습니다: ${finalizeError.message}`);
    }
    throw error;
  }
}

function migrateTaskStorage(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const legacy = path.join(project.root, 'tasks.json');
  const directory = path.join(project.root, 'tasks');
  const originalManifest = fs.readFileSync(project.manifest, 'utf8');
  const originalTasks = fs.readFileSync(legacy, 'utf8');
  const result = migrateTaskStore(legacy, directory, project.root, settings.clientId, settings.maxItems);
  try {
    let manifest = originalManifest;
    if (/^tasks:\s*$/mu.test(manifest)) {
      manifest = manifest.replace(/^tasks:\s*\r?\n(?:^  .*(?:\r?\n|$))*/gmu, `tasks:\n  storage: sharded\n  path: tasks\n  maxItemsPerShard: ${settings.maxItems || 500}\n`);
    } else manifest = `${manifest.replace(/\s*$/, '')}\n\ntasks:\n  storage: sharded\n  path: tasks\n  maxItemsPerShard: ${settings.maxItems || 500}\n`;
    atomicWrite(project.manifest, manifest);
    fs.unlinkSync(legacy);
    saveSettings(layout.root);
    const nextConfig = workspaceStateConfig(layout.root, project.key);
    materialize(nextConfig);
    validateProjection(nextConfig);
    runGit(['add', '-A', '--', '.'], { cwd: project.root });
    runGit(['commit', '-m', 'rdl: migrate tasks to client shards'], { cwd: project.root });
    return Object.assign({ root: layout.root, project: project.key, legacy, commit: runGit(['rev-parse', 'HEAD'], { cwd: project.root }).stdout }, result);
  } catch (error) {
    atomicWrite(project.manifest, originalManifest);
    atomicWrite(legacy, originalTasks);
    throw error;
  }
}

module.exports = { initState, refreshState, saveState, taskSet, taskAcceptance, taskUpdate, taskCreate, syncState, migrateTaskStorage, stateConfig: workspaceStateConfig, canonicalJson, prepareProjectState, syncProjectState, transitionRuns, preflightSyncClient };
