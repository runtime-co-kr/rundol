'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGit, refExists, gitRoot } = require('./git');
const { mergeTaskDocuments } = require('./merge');
const { checkWorkspace, findWorkspaceRoot, readWorkspaceManifest, yamlNestedValue } = require('./check');
const { workspaceLayout, selectProject } = require('./workspace');
const { loadWorkflows, workflowFor } = require('./workflow-config');
const { readTaskStore, createTaskInStore, updateTaskInStore, restoreStoreWrite, materializeTaskStore, migrateTaskStore, assertNodeConsistency, assertExemptionConsistency, assertKindConsistency, assertRoundUniqueness } = require('./tasks');
const workflow = require('./workflow');
const { initSettings, saveSettings, prepareSettings, finalizeSettings } = require('./settings');
const { loadHarnessSettings, retryPolicy } = require('./harness-settings');
const { getClient } = require('./collaboration-store');
const { readCollaboration } = require('./collaboration');
const { newDocumentUid } = require('./document-identity');
const { taskEnforcementFrom } = require('./document-profile');
const { runtimeWorkspace, withProcessLock } = require('./runtime');
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
    // 막는 것을 전부 내보낸다. 예전에는 첫 줄만 꺼내 던졌고, 그것이 01절이 적은
    // 왕복의 실제 기계였다 — 검사는 진단을 다 만들어 놓았는데 이 자리가 하나만
    // 보여 주었다. 하나를 고치면 다음 것이 다시 막고, 두 규칙이 같은 사실에서
    // 나와도 한 화면에 보이지 않는다.
    const errors = result.diagnostics.filter((item) => item.severity === 'error');
    if (!errors.length) throw new Error('workspace 변경 검증 실패: 알 수 없는 오류');
    const lines = errors.map((item) => `${item.code} ${item.message}${item.artifactId ? ` (${item.artifactId})` : ''}`);
    throw new Error(errors.length === 1
      ? `workspace 변경 검증 실패: ${lines[0]}`
      : `workspace 변경 검증 실패 ${errors.length}건:\n  ${lines.join('\n  ')}`);
  }
  return result;
}

// 태스크 식별자는 문서 식별자와 같은 규칙을 쓴다. 두 체계가 다른 길이를 갖고 있을
// 이유가 없고, 26자짜리는 사람이 옮겨 적을 수 없다. 저장하는 작업이 어느 태스크의
// 일인지 밝히도록 요구하려면(REQ-046) 손으로 칠 수 있어야 하고, 칠 수 없는 식별자를
// 요구하는 통제는 우회된다.
//
// 충돌은 생성 시점에 확인한다. 8자 32진이면 공간은 충분하지만, 확인을 생략하는
// 것과 확인해서 없는 것은 다른 일이다.
function taskId(tasks) {
  let id;
  do {
    id = `TASK-${newDocumentUid()}`;
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
  // 태스크를 만들고 고치는 커밋도 어느 태스크의 일인지 답한다. 답이 자기 자신이라
  // 당연해 보이지만, 적지 않으면 검사에서 결박을 지나지 않은 커밋으로 보인다.
  runGit(['commit', '-m', commitMessageWith(values.message, { taskId: values.taskId })], { cwd: config.worktree });
  return runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout;
}

// 반려를 되돌릴 때 사유를 남겨두면 "반려가 아닌데 반려 사유가 있는" 상태가 되어 검증이 막는다.
// 호출자마다 같은 짝을 다시 쓰게 하는 대신 여기서 정리한다. 결정자를 생략하면 태스크 owner가
// 결정한 것으로 본다. CLI는 태스크를 읽지 않으므로 그 값을 알 수 없다.
// 면제도 상태와 짝이다. 완료가 아닌 상태로 옮기면서 면제를 남겨 두면 "완료가 아닌데
// 면제가 있는" 상태가 되어 저장이 막힌다. 결정자를 생략하면 반려와 같은 규칙으로
// 태스크 owner가 결정한 것으로 본다 — CLI는 태스크를 읽지 않으므로 그 값을 모른다.
function normalizeExemptionChange(task, changes) {
  if (!changes || !Object.prototype.hasOwnProperty.call(changes, 'status')) return;
  if (workflow.stepOf(changes.status) !== 'completed') {
    if (task.exemption && !Object.prototype.hasOwnProperty.call(changes, 'exemption')) changes.exemption = null;
    return;
  }
  const exemption = changes.exemption || task.exemption;
  if (!exemption) return;
  changes.exemption = Object.assign({}, exemption, { decidedBy: exemption.decidedBy || changes.owner || task.owner || null });
}

function normalizeCancellationChange(task, changes) {
  if (!changes || !Object.prototype.hasOwnProperty.call(changes, 'status')) return;
  if (workflow.stepOf(changes.status) !== 'dropped') {
    if (task.cancellation && !Object.prototype.hasOwnProperty.call(changes, 'cancellation')) changes.cancellation = null;
    return;
  }
  const cancellation = changes.cancellation || task.cancellation;
  if (!cancellation) return;
  changes.cancellation = Object.assign({}, cancellation, { decidedBy: cancellation.decidedBy || changes.owner || task.owner || null });
}

// 이 태스크가 탈 흐름. 설정이 없으면 내장이 답하고, 그때 판정은 판올림 전과 같다.
// 읽지 못한 것을 오류로 올리지 않는 이유는 저장이 설정 파일 하나에 인질이 되면
// 안 되기 때문이다 — 설정이 틀렸다는 사실은 rdl check가 말한다.
function taskFlow(root, projectKey, kind) {
  try {
    const config = loadWorkflows(root, projectKey);
    return workflowFor(config, 'task', kind);
  } catch (error) {
    return null;
  }
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
  normalizeExemptionChange(task, changes);
  // 노드와 항목의 짝은 한 번에 본다. 셋을 줄지어 부르면 첫 번째가 던지는 순간
  // 나머지 둘은 판정되지 않고, 부르는 쪽은 고치고 다시 부르기를 되풀이한다.
  assertNodeConsistency(task, changes, taskFlow(config.root, config.project, (changes && changes.kind) || task.kind));
  assertExemptionConsistency(task, changes);
  assertKindConsistency(task, changes);
  assertRoundUniqueness(parsed.tasks, taskIdValue, Object.assign({}, task, changes));
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
    kind: 'normal',
    result: null,
    round: null,
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
  // 구현 준비도는 저장하지 않는다. 링크에서 결정되는 값이라 저장하면 링크가 바뀌어도
  // 갱신 경로가 없어 조용히 어긋난다 — 계산되는 값을 저장하지 않는다는 REQ-047의
  // 요구가 이것이다. 판정이 필요할 때 링크를 보고 계산한다.
  assertNodeConsistency(null, task);
  assertExemptionConsistency(null, task);
  assertKindConsistency(null, task);
  assertRoundUniqueness(parsed.tasks, id, task);
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

// 런이 시키는 저장은 자기 대상에만 닿는다. 무엇을 담을지 정하는 것이 add -A라면,
// 저작과 저장 사이에 생긴 어떤 변경도 이 런의 결과 커밋에 흡수된다 — 그리고 그
// 커밋이 곧 검증 대상이므로, 판정된 적 없는 내용이 판정을 지나온 것이 된다.
//
// scope는 스테이징 범위이자 거부 조건이다. 대상 밖이 더러우면 담지 않는 것으로
// 끝내지 않고 멈춘다. 조용히 남겨 두면 그 변경은 다음 저장에 섞이고, 그때는
// 어느 런의 것인지 아무도 모른다.
// 범위 판정과 담기는 나눈다. 담은 뒤에 거부하면 그 저장은 실패했는데 index는 이미
// 바뀌어 있고, 다음 저장이 그 결과를 자기 것으로 물려받는다 — 실패한 시도가 흔적을
// 남기지 않는다는 계약이 여기서 깨진다.
function assertScopeClean(config, scope) {
  const dirty = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', scope], { cwd: config.worktree }).stdout;
  const all = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: config.worktree }).stdout;
  if (String(all || '').split('\0').filter(Boolean).length !== String(dirty || '').split('\0').filter(Boolean).length) {
    throw new Error(`RDL-SAVE-010: 런의 저장 범위(${scope}) 밖에 변경이 있습니다. 런이 만들지 않은 변경은 런의 커밋에 담기지 않습니다.`);
  }
  return Boolean(dirty);
}

function stageScoped(config, scope) {
  runGit(['add', '-A', '--', scope], { cwd: config.worktree });
}

// 어느 태스크의 일이었는지는 커밋 자체가 답한다. 원장이나 설정에 적으면 커밋과
// 그 사실이 따로 움직이고, 나중에 둘이 어긋났을 때 어느 쪽이 사실인지 알 수 없다.
const TASK_TRAILER = 'Rundol-Task';
// 완료와 반려는 게이트가 다르지만 둘 다 더 진행되지 않는다. 그 뒤에 생긴 커밋은
// 그 태스크의 일일 수 없다. 예전에는 그 둘을 상태 이름 목록으로 물었고, 목록을
// 이 파일에 다시 적었던 탓에 같은 것이 세 이름으로 있었다. 이제 스텝이 답한다 —
// workflow.isTerminal 하나이고, 프로젝트가 이름을 정의해도 이 판정은 그대로다.
const TASK_REASON_TRAILER = 'Rundol-Task-Reason';

function taskTrailer(binding) {
  if (!binding) return '';
  const lines = binding.taskId
    ? [`${TASK_TRAILER}: ${binding.taskId}`]
    : [`${TASK_TRAILER}: none`, `${TASK_REASON_TRAILER}: ${binding.reason}`];
  return `\n\n${lines.join('\n')}`;
}

function commitMessageWith(message, binding) {
  return `${message}${taskTrailer(binding)}`;
}

function projectTaskEnforcement(config) {
  if (!config.project) return 'advisory';
  const charter = path.join(config.worktree, 'project.md');
  if (!fs.existsSync(charter)) return 'advisory';
  return taskEnforcementFrom(fs.readFileSync(charter, 'utf8'));
}

// 강제 지점은 저장 하나다. 여러 곳에 나누어 걸면 어디서 막혔는지가 흐려지고, 공유에
// 걸면 늦다 — 작업이 로컬에 쌓인 뒤에는 어느 커밋이 무슨 일이었는지가 추측이 된다.
// 저장은 일이 사실로 굳는 순간이고, 그때는 자기가 무엇을 했는지 안다.
// 결박을 파생할 근거들. 순서가 곧 우선순위이고, 각 근거는 태스크를 답하거나 답하지
// 않는다 — 답하지 못하는 것은 실패가 아니라 다음 근거로 넘어가는 일이다.
//
// 근거를 읽다 실패해도 저장을 막지 않는다. 파생은 편의이고, 편의가 없다고 통제가
// 강해지지는 않는다 — 못 정하면 아래에서 사람에게 묻는다.
function derivationLadder(config, settings, tasks) {
  const sources = [];
  if (settings.run) {
    // 명시한 런을 읽지 못하면 다음 근거로 넘어가지 않는다. 넘어가면 사용자가 지목한
    // 런과 무관한 태스크에 이 커밋이 묶이고, 그것은 결박이 없는 것보다 나쁘다 —
    // 없는 것은 비어 있고 틀린 것은 거짓이다.
    //
    // 답하지 못하는 근거와 읽지 못한 근거는 다르다. 앞은 넘어갈 일이고 뒤는 멈출 일이다.
    let runTask = null;
    try {
      const ledger = require('./run-ledger');
      const reconciled = ledger.reconcileRun(config.root, { project: config.project, runId: settings.run });
      runTask = reconciled && reconciled.events.length ? ledger.foldSharedRun(reconciled.events).taskId : null;
    } catch (error) {
      throw new Error(`RDL-TASK-040: 지목한 런을 읽지 못해 결박을 정할 수 없습니다: ${settings.run} (${error.message})`);
    }
    sources.push({ name: 'run', label: `런 ${settings.run}`, taskId: runTask });
  }
  // 작업 묶음은 브랜치가 만든다. 같은 브랜치를 가리키는 태스크가 하나면 그것이
  // 지금 하는 일이고, 여럿이면 고르는 것은 추론이 아니라 추측이다.
  let branch = null;
  try { branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: config.worktree, allowFailure: true }).stdout.trim(); }
  catch (_) { branch = null; }
  if (branch && branch !== 'HEAD') {
    const { normalizeExternalRef } = require('./workset');
    const onBranch = Object.keys(tasks).filter((id) => {
      const refs = Array.isArray(tasks[id] && tasks[id].externalRefs) ? tasks[id].externalRefs : [];
      return refs.map(normalizeExternalRef).some((ref) => ref.kind === 'branch' && ref.value === branch);
    });
    sources.push({ name: 'workset', label: `브랜치 ${branch}의 작업 묶음`, taskId: onBranch.length === 1 ? onBranch[0] : null });
  }
  const doing = Object.keys(tasks).filter((id) => underway(tasks[id])).sort();
  sources.push({ name: 'single-doing', label: '진행 중인 태스크', taskId: doing.length === 1 ? doing[0] : null });
  return sources;
}

// 지금 손이 가 있는 태스크. 붙어 있는 스텝 중 막혀 있지 않은 것이다.
//
// 스텝만으로 묻지 않는 이유는 대기가 진행중과 같은 스텝에 서기 때문이다. 대기는
// 사람이 붙어 있되 남을 기다리는 자리이고, 그 태스크에 커밋을 결박하면 결박이
// 가리키는 일은 지금 일어나고 있지 않다. 틀린 결박은 결박이 없는 것보다 나쁘다 —
// 없는 것은 비어 있고 틀린 것은 거짓이다.
//
// 막혀 있다는 것은 blocker가 있다는 것이고, 그 짝은 저장 계층의 불변식이라
// 여기서 상태 이름을 다시 물을 필요가 없다.
function underway(task) {
  return Boolean(task) && workflow.stepOf(task.status) === 'in-progress' && !task.blocker;
}

function resolveTaskBinding(config, settings) {
  const level = projectTaskEnforcement(config);
  const requested = settings.task ? String(settings.task).trim() : null;
  const excuse = settings.noTask ? String(settings.noTask).trim() : null;
  const notices = [];
  if (requested && excuse) throw new Error('RDL-TASK-030: --task와 --no-task를 함께 쓸 수 없습니다. 태스크를 밝히거나 사유를 대거나 둘 중 하나입니다.');
  // 우회는 거부 수준에서만 존재한다. 경고 수준에서는 경고가 나가므로 우회할 것이 없고,
  // 그래도 받아 주면 아무것도 막지 않는 자리에 사유를 적는 습관만 남는다.
  if (excuse && level !== 'checkpoint') throw new Error('RDL-TASK-031: 이 프로젝트의 태스크 강제는 경고 수준입니다. 우회할 것이 없습니다.');

  const store = config.project ? readTaskStore(path.join(config.worktree, config.taskRelative)) : { tasks: {} };
  const tasks = store.tasks || {};
  if (requested) {
    // 없는 태스크나 다른 프로젝트의 태스크로는 묶을 수 없다. 묶이지 않은 식별자를
    // 커밋에 적으면, 결박이 있었다는 기록만 남고 가리키는 곳이 없다.
    if (!Object.prototype.hasOwnProperty.call(tasks, requested)) throw new Error(`RDL-TASK-032: 이 프로젝트에 없는 태스크입니다: ${requested}`);
    // 끝난 태스크에도 묶을 수 있으면, 결박이 증명하는 것은 "활성 작업에 속한다"가
    // 아니라 "존재하는 문자열이다"가 된다. 완료·반려된 태스크를 가리키는 커밋은 그
    // 태스크가 끝난 뒤에 생긴 일이므로 그 태스크의 일일 수 없다.
    if (workflow.isTerminal(tasks[requested].status)) throw new Error(`RDL-TASK-037: 이미 끝난 태스크에는 묶을 수 없습니다: ${requested} (${tasks[requested].status}). 진행 중인 태스크를 지정하거나 새로 만드세요.`);
    return { level, taskId: requested, inferred: false, source: 'explicit', reason: null, notices };
  }
  if (excuse) return { level, taskId: null, inferred: false, reason: excuse, notices };

  // 파생 사다리. 대부분의 경우 기계가 이미 안다 — 런이 돌고 있으면 그 런이 무엇을
  // 하는 중인지 원장에 있고, 작업 묶음은 브랜치로 이미 묶여 있다. 아는 것을 묻는
  // 통제는 확인이 아니라 요금이고, 요금을 무는 통제는 우회된다.
  //
  // 앞이 답하면 뒤를 묻지 않는다. 런이 작업 묶음을 이기는 이유는 런이 더 좁기
  // 때문이다 — 한 브랜치에 여러 런이 있을 수 있어도 한 런은 하나의 일이다.
  for (const source of derivationLadder(config, settings, tasks)) {
    if (!source.taskId) continue;
    if (!Object.prototype.hasOwnProperty.call(tasks, source.taskId)) continue;
    // 파생된 태스크도 결박의 조건을 그대로 지난다. 끝난 태스크는 파생으로도 묶이지
    // 않는다 — 파생이 사람이 지정할 수 없는 것을 묶어 주면 파생이 우회가 된다.
    if (workflow.isTerminal(tasks[source.taskId].status)) continue;
    notices.push(`태스크를 지정하지 않아 ${source.label}에서 ${source.taskId}(으)로 기록합니다.`);
    return { level, taskId: source.taskId, inferred: true, source: source.name, reason: null, notices };
  }

  const doing = Object.keys(tasks).filter((id) => underway(tasks[id])).sort();
  // 둘 이상이면 추론하지 않는다. 골라 주는 것이 편해 보이지만, 틀린 결박은 결박이
  // 없는 것보다 나쁘다 — 없는 것은 비어 있고 틀린 것은 거짓이다.
  const why = doing.length ? `진행 중인 태스크가 ${doing.length}건입니다: ${doing.join(', ')}` : '진행 중인 태스크가 없습니다';
  if (level === 'checkpoint') throw new Error(`RDL-TASK-033: 이 저장이 어느 태스크의 일인지 밝혀야 합니다. ${why}. --task <ID>로 지정하거나 --no-task <사유>로 사유를 남기세요.`);
  notices.push(`RDL-TASK-034: 이 저장은 태스크에 묶이지 않았습니다. ${why}.`);
  return { level, taskId: null, inferred: false, reason: `태스크 강제가 경고 수준입니다 (${why})`, notices };
}

// 결과는 평평하게 싣는다. 중첩 객체는 사람이 읽는 출력에서 통째로 생략되므로,
// 무엇을 골랐는지 알린다는 요구가 --json에서만 지켜지게 된다.
function bindingReport(binding) {
  return {
    task: binding.taskId || null,
    taskInferred: binding.taskId ? binding.inferred : null,
    taskSource: binding.taskId ? (binding.source || null) : null,
    taskEnforcement: binding.level,
    notices: binding.notices.length ? binding.notices : undefined
  };
}

// 저장은 프로젝트 worktree 하나를 읽고, 고치고, 커밋한다. 그 worktree는 프로젝트마다
// 하나뿐이므로 두 저장이 겹치면 뒤엣것의 `git add -A`가 앞엣것이 아직 커밋하지 못한
// 변경까지 담는다. 세션을 worktree로 나눠도 이 자리는 갈리지 않는다 — 코드와 달리
// 문서·태스크는 공유하기로 한 것이고(ADR-007), 공유하기로 한 자리는 직렬화해야 한다.
//
// 같은 기계 안이라 실제 배타가 가능하다. 원자적 생성과 프로세스 생존 확인이면 공통
// 시계 없이 보장되며, 그것이 ADR-015가 문서 리스를 폐기하면서도 로컬 락은 남긴 이유다.
// 기제는 runtime.js에 이미 있으므로 새로 검증할 것이 없다.
//
// 기다리지 않고 거절한다. 저장은 사람이나 세션이 지금 하려는 일이므로, 붙잡아 두면
// 그 세션이 통째로 멈춘다. 누가 쥐고 있는지 말해 주면 다시 부를지는 부르는 쪽이 정한다.
function saveProjectState(config, settings) {
  const scope = config.project || 'workspace';
  try {
    return withProcessLock(runtimeWorkspace(config.root), `save-${scope}`, () => commitProjectState(config, settings));
  } catch (error) {
    if (!error || error.code !== 'RDL_PROCESS_LOCKED') throw error;
    const holder = error.lock && error.lock.pid;
    const locked = new Error(`RDL-SAVE-012: 같은 프로젝트를 다른 저장이 쓰고 있습니다: ${scope}${holder ? ` (pid ${holder})` : ''}. 그 저장이 끝난 뒤 다시 실행하세요.`);
    locked.code = 'RDL-SAVE-012';
    throw locked;
  }
}

function commitProjectState(config, settings) {
  if (!refExists(config.root, config.ref)) initProjectState(config);
  ensureWorkspaceWorktree(config);
  const head = () => runGit(['rev-parse', 'HEAD'], { cwd: config.worktree }).stdout.trim().toLowerCase();
  // 범위와 기대 커밋은 문서 검증보다 먼저 묻는다. 런의 저장이 자기 범위 밖의 내용
  // 때문에 실패하면, 막힌 이유가 이 런과 무관한데도 이 런의 실패로 기록된다.
  if (settings.expectHead) {
    const expected = String(settings.expectHead).trim().toLowerCase();
    const actual = head();
    if (expected !== actual) throw new Error(`RDL-SAVE-011: 기대한 HEAD와 다릅니다. 기대 ${expected}, 실제 ${actual}.`);
  }
  const scope = settings.scope || null;
  const message = settings.message || 'rdl: update workspace';
  if (scope) {
    const changed = assertScopeClean(config, scope);
    validateProjection(config);
    if (!changed) return { root: config.root, project: config.project || null, branch: config.branch, changed: false, commit: head() };
    // 결박은 담을 것이 있다는 것을 확인한 뒤에, 그러나 담기 전에 묻는다. 바꾼 것이
    // 없는데 태스크를 요구하면 아무 일도 하지 않은 호출이 막힌 이유가 태스크가 되고,
    // 담은 뒤에 거부하면 실패한 저장이 index에 흔적을 남긴다.
    //
    // 두 축이 모두 걸리면 문서 경고가 먼저 나가고 태스크 거부가 뒤에 온다. 막은
    // 이유가 마지막에 오는 편이 읽기 좋다 — 그래서 validateProjection 다음이다.
    const binding = resolveTaskBinding(config, settings);
    stageScoped(config, scope);
    runGit(['commit', '-m', commitMessageWith(message, binding)], { cwd: config.worktree });
    return Object.assign({ root: config.root, project: config.project || null, branch: config.branch, changed: true, commit: head() }, bindingReport(binding));
  }
  validateProjection(config);
  const status = runGit(['status', '--porcelain'], { cwd: config.worktree }).stdout;
  if (!status) return { root: config.root, project: config.project || null, branch: config.branch, changed: false, commit: head() };
  const binding = resolveTaskBinding(config, settings);
  runGit(['add', '-A', '--', '.'], { cwd: config.worktree });
  runGit(['commit', '-m', commitMessageWith(message, binding)], { cwd: config.worktree });
  return Object.assign({ root: config.root, project: config.project || null, branch: config.branch, changed: true, commit: head() }, bindingReport(binding));
}

// 런이 시킨 저장의 범위는 그 런이 고정한 대상 문서 하나다. 범위를 부르는 쪽이
// 인수로 정하게 두면 그것도 결국 어댑터가 정하는 값이 된다 — 원장이 정해야 한다.
function runSaveScope(start, config, runId) {
  const ledger = require('./run-ledger');
  const reconciled = ledger.reconcileRun(start, { project: config.project, runId });
  const events = reconciled ? reconciled.events : [];
  if (!events.length) throw new Error(`런을 찾지 못했습니다: ${runId}`);
  const fold = ledger.foldSharedRun(events);
  const targetId = (fold.artifactIds || [])[fold.artifactIds.length - 1];
  if (!targetId) throw new Error(`런에 고정된 대상 문서가 없습니다: ${runId}`);
  const { workspaceLayout, selectProject } = require('./workspace');
  const project = selectProject(workspaceLayout(start), config.project, true);
  const artifact = require('./document-contract').projectArtifacts(project).find((item) => item.id === targetId);
  if (!artifact) throw new Error(`런의 대상 문서를 찾지 못했습니다: ${targetId}`);
  return path.relative(config.worktree, artifact.file).split(path.sep).join('/');
}

function saveState(start, options) {
  const settings = options || {};
  const settingsResult = saveSettings(start);
  const results = workspaceStateConfigs(start, settings.project).map((config) => saveProjectState(config,
    settings.run ? Object.assign({}, settings, { scope: runSaveScope(start, config, settings.run) }) : settings));
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
    // 예선 검사와 push 사이에 prepareProjectState가 새 커밋을 만든다. 저장하지 않은
    // 변경이 있으면 그것을 담고, 원격 병합도 커밋한다. 그래서 통과 판정을 받은 HEAD와
    // 지금 나가려는 HEAD가 다를 수 있고, 그 차이가 곧 아무도 승인하지 않은 내용이다.
    //
    // 판정을 한 번만 하면 그 창을 못 본다. 나가기 직전에 다시 묻는다 — 검사와 행위
    // 사이에 상태가 변하는 것이 이 경로의 성질이므로, 검사는 행위에 붙어 있어야 한다.
    if (!settings.shareUnverified) {
      const remaining = unclearedRunCommits(config);
      if (remaining.length) {
        const shown = remaining.slice(0, 10).map((item) => `${item.runId}@${item.commit.slice(0, 12)}(${item.status})`).join(', ');
        throw new Error(`RDL-SYNC-030: 저장 과정에서 승인되지 않은 커밋이 push 대상에 들어왔습니다: ${shown}. 런을 끝내거나, 사람의 판단이라면 --share-unverified <사유> --approved-by <human-client-id>로 공유하세요.`);
      }
    }
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
    const fold = typeof ledger.foldSharedRun === 'function' && events.some((item) => item && item.schemaVersion >= 2) ? ledger.foldSharedRun(events) : ledger.foldRun(events);
    const event = apply(fold);
    if (!event) continue;
    let ownerToken = null;
    if (events.some((item) => item && item.schemaVersion >= 2)) {
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

// 런이 만든 커밋 중 아직 사람 게이트를 통과하지 못한 것. save는 로컬 커밋이고
// sync는 공유다 — 이 둘 사이가 Rundol이 "아직 나가지 않았다"고 말할 수 있는
// 유일한 구간이다. 검증 전에 저장하는 절차를 열었으면서 이 구간을 지키지 않으면
// "검증되지 않은 내용은 이 기계를 벗어나지 않는다"는 말은 성립하지 않는다.
//
// forced는 통과가 아니다. 사람 게이트를 --force로 지나간 런은 사람이 승인했다는
// 근거가 없고, 그 판단은 공유 시점에 사람에게 다시 물어야 한다.
function unclearedRunCommits(config) {
  if (!config.project) return [];
  const ledger = require('./run-ledger');
  const runIds = new Set(ledger.listRuns(config.worktree).map((run) => run.runId));
  if (typeof ledger.listSharedRunIds === 'function') {
    const { workspaceLayout } = require('./workspace');
    for (const runId of ledger.listSharedRunIds(workspaceLayout(config.root), config.project)) runIds.add(runId);
  }
  const blocked = [];
  // 지금 push되는 것은 ref의 tip이다. 런이 통과했는지를 물을 때 대조할 대상도 그것이다.
  const headCommit = runGit(['rev-parse', 'HEAD'], { cwd: config.worktree, allowFailure: true }).stdout.trim().toLowerCase();
  for (const runId of Array.from(runIds).sort()) {
    const reconciled = typeof ledger.reconcileRun === 'function' ? ledger.reconcileRun(config.root, { project: config.project, runId }) : null;
    const events = reconciled ? reconciled.events : ledger.readRunEvents(ledger.runDirectory(config.worktree, runId));
    if (!events.length) continue;
    const fold = typeof ledger.foldSharedRun === 'function' && events.some((item) => item && item.schemaVersion >= 2) ? ledger.foldSharedRun(events) : ledger.foldRun(events);
    const commits = (fold.producedCommits || []).filter((commit) => /^[a-f0-9]{40,64}$/u.test(String(commit)));
    // 커밋을 만드는 스텝이 성공했다면서 커밋을 말하지 않은 런은, 만든 커밋이 없는 것이
    // 아니라 무엇을 만들었는지 말하지 않은 것이다. 그 둘을 같이 다루면 이 장벽을
    // 지나가는 가장 싼 길이 커밋을 적지 않는 것이 된다 — 병합으로 들어온 이벤트는
    // CLI를 지나지 않으므로 그 형태가 실제로 만들어진다.
    if ((fold.stepsMissingCommit || []).length) {
      blocked.push({ runId, commit: null, status: fold.status, missingCommitSteps: fold.stepsMissingCommit.slice(), unapprovedHumanSteps: [] });
      continue;
    }
    if (!commits.length) continue;
    // 이미 공유된 런은 다시 판정하지 않는다. 그 커밋은 원격에 있고 되돌릴 수 없으므로
    // 막을 대상이 아니며, 무엇보다 판정 기준이 지금의 Client 상태라는 것이 문제다 —
    // 승인자가 나중에 퇴사해 비활성이 되면 과거의 정상 런이 오늘 다시 차단 대상이
    // 된다. 그때 그 승인이 유효했는지는 그때의 사실이고, 오늘의 상태가 바꾸지 못한다.
    //
    // 사후에 그 승인이 잘못이었음을 알게 되는 경로는 차단이 아니라 감사다 —
    // check의 RDL-RUN-031이 그 판정을 남긴다.
    if (fold.status === 'synced') continue;
    // 통과의 조건은 셋이다. 런이 로컬 완료에 닿았을 것, 사람 게이트를 사람의 승인
    // 으로 지났을 것, 그리고 그 승인이 검증이 본 커밋에 붙어 있을 것. 셋 중 하나라도
    // 없으면 이 런의 커밋은 아직 나갈 수 없다.
    // 승인이 사람의 것인지는 원장만 보고 알 수 없다. 원장에 있는 것은 "이 clientId가
    // human-approval이라고 적었다"뿐이고, 그 clientId가 실제로 human 유형 활성
    // Client인지는 registry가 답한다. 이 대조가 없으면 에이전트가 이벤트를 직접
    // 써 넣는 것만으로 사람 승인이 된다 — git 병합으로 들어온 이벤트도 마찬가지다.
    const approvals = (fold.humanApprovals || []).filter((item) => approverIsProjectHuman(config, item.clientId));
    const gates = fold.humanGateSteps || [];
    const cleared = ['completed_local', 'synced'].includes(fold.status)
      && !(fold.unapprovedHumanSteps || []).length
      && gates.every((stepId) => approvals.some((item) => item.stepId === stepId))
      && approvals.every((item) => !fold.verifiedCommit || item.commit === fold.verifiedCommit)
      // 완료가 기록한 커밋도 승인된 그것이어야 한다. 승인 시점만 대조하고 완료
      // 시점을 묻지 않으면, 승인 뒤 HEAD를 옮겨 다른 커밋으로 완료할 수 있다.
      && (!approvals.length || approvals.every((item) => item.commit === fold.completedCommit))
      // 그리고 아직 나가지 않은 런이라면, 지금 나가려는 것이 그 커밋이어야 한다.
      // 완료 뒤에 쌓은 커밋은 아무도 승인한 적이 없는데, 승인된 런의 커밋이 조상
      // 이라는 이유로 함께 나간다. 런의 통과는 그 런의 커밋에 대한 것이지 그 위에
      // 쌓인 것에 대한 것이 아니다.
      //
      // 이미 synced인 런에는 걸지 않는다. 그 커밋은 이미 원격에 있고, 뒤에 새 런이
      // HEAD를 옮겼다는 이유로 지난 런이 다시 차단 대상이 되면 — 아무것도 되돌릴 수
      // 없는데 영원히 막힌다. 통과의 조건은 그 런이 나갈 때의 것이지 그 뒤의 것이 아니다.
      && (fold.status === 'synced' || fold.completedCommit === headCommit);
    if (cleared) continue;
    for (const commit of commits) {
      // 조상이 아닌 커밋은 이번 push에 실리지 않는다. 실리지 않는 것을 막으면
      // 무관한 런 하나가 프로젝트 전체의 공유를 영원히 잠근다.
      if (runGit(['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: config.worktree, allowFailure: true }).status !== 0) continue;
      blocked.push({ runId, commit, status: fold.status, unapprovedHumanSteps: (fold.unapprovedHumanSteps || []).slice() });
    }
  }
  return blocked;
}

// 승인 자격의 정의는 한 곳에만 둔다. 원장의 승인을 세는 곳과 --approved-by를 받는
// 곳이 각자 판정하면 둘이 어긋나고, 실제로 어긋났다 — 앞 판에서 전자만 멤버십을
// 보고 후자는 유형과 상태만 봐서, CHANGELOG가 약속한 계약과 코드가 달랐다.
//
// 자격의 조건은 셋이다: 등록된 human 유형일 것, 활성일 것, 그리고 그 자격을 가진
// 멤버가 이 프로젝트의 활성 멤버일 것. human 자격은 어느 프로젝트에나 등록될 수
// 있으므로 마지막 조건이 없으면 옆 프로젝트의 검토자가 이 프로젝트를 승인한다.
function approverIsProjectHuman(config, clientId) {
  if (!clientId) return false;
  try {
    const client = getClient(config.root, clientId);
    if (!client || client.type !== 'human' || client.status !== 'active') return false;
    return readCollaboration(config.root, config.project).members
      .some((member) => member.id === client.owner && member.fields['상태'] === 'active');
  } catch (_) {
    return false;
  }
}

function syncProjectStateWithRuns(config, settings) {
  const uncleared = settings.push === false ? [] : unclearedRunCommits(config);
  if (uncleared.length) {
    const reason = String(settings.shareUnverified || '').trim();
    // 우회도 사람의 판단이어야 한다. 사유 문자열은 누구나 적을 수 있으므로, 사유만
    // 요구하면 에이전트가 자기 판단으로 사람 게이트를 지나간다 — 막으려던 바로 그
    // 일이다. 승인과 같은 자격을 요구한다.
    if (reason) {
      const approver = String(settings.approvedBy || '').trim().toLowerCase();
      if (!approver) throw new Error('RDL-SYNC-031: --share-unverified에는 --approved-by <human-client-id>가 필요합니다. 검증되지 않은 내용의 공유는 사람의 판단이어야 합니다.');
      if (!approverIsProjectHuman(config, approver)) {
        const client = (() => { try { return getClient(config.root, approver); } catch (_) { return null; } })();
        throw new Error(`RDL-SYNC-031: --approved-by는 이 프로젝트의 활성 human Client여야 합니다: ${approver}(${client ? `${client.type}, owner ${client.owner}` : '미등록'}).`);
      }
      settings.shareApprovedBy = approver;
    }
    if (!reason) {
      const shown = uncleared.slice(0, 10).map((item) => `${item.runId}@${item.commit.slice(0, 12)}(${item.status}${item.unapprovedHumanSteps.length ? `, 승인 없이 지난 게이트: ${item.unapprovedHumanSteps.join(',')}` : ''})`).join(', ');
      throw new Error(`RDL-SYNC-030: 사람 게이트를 통과하지 못한 런의 커밋이 push 대상에 있습니다: ${shown}${uncleared.length > 10 ? ` 외 ${uncleared.length - 10}건` : ''}. 런을 끝내거나, 사람의 판단이라면 --share-unverified <사유>로 공유하세요.`);
    }
    settings.sharedUnverified = uncleared.map((item) => Object.assign({}, item, { reason, approvedBy: settings.shareApprovedBy }));
  }
  try {
    const result = syncProjectState(config, settings);
    const transitions = result.pushed ? transitionRuns(config, (run) => (run.status === 'completed_local'
      ? { type: 'run.synced', commit: result.commit, remoteRef: `refs/remotes/${result.remote}/${result.branch}` }
      : null), settings) : [];
    // 검증되지 않은 채 공유된 커밋은 결과에 남긴다. 원장은 그 런이 게이트를 통과한
    // 적 없다고 이미 말하고 있으므로, 둘을 맞추면 무엇이 그렇게 나갔는지는 나중에도
    // 정확히 답할 수 있다. 대신 이 우회는 저장되지 않는다 — 매번 다시 말해야 한다.
    return Object.assign({}, result, { transitions }, settings.sharedUnverified ? { sharedUnverified: settings.sharedUnverified } : {});
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

// 계측을 위한 가벼운 결박 추론. 저장의 결박은 강제 수준을 보고 막거나 물어야 하지만,
// 기록은 아무것도 막지 않으므로 못 정하면 그냥 비운다.
//
// 이것이 필요한 이유는 계측이 새고 있었기 때문이다. 행위 서른다섯 건 중 스물아홉이
// 어느 작업의 일인지 몰랐고, 그래서 "할당부터 검수까지 사람이 몇 번 개입했나"를
// 셀 수 없었다. 문서를 쓰고 검사하고 저장하는 행위가 전부 집계 밖이었다.
function inferTaskId(start, projectKey) {
  try {
    const config = workspaceStateConfig(start, projectKey);
    if (!config.project) return null;
    const store = readTaskStore(path.join(config.worktree, config.taskRelative));
    const ladder = derivationLadder(config, {}, store.tasks || {});
    const resolved = ladder.find((source) => source.taskId);
    return resolved ? resolved.taskId : null;
  } catch (_) {
    // 추론에 실패해도 명령을 막지 않는다. 계측이 없는 것이 명령이 안 되는 것보다 낫다.
    return null;
  }
}

module.exports = { initState, refreshState, saveState, taskSet, taskAcceptance, taskUpdate, taskCreate, syncState, migrateTaskStorage, stateConfig: workspaceStateConfig, canonicalJson, prepareProjectState, syncProjectState, transitionRuns, preflightSyncClient, inferTaskId };
