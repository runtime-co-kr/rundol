'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { checkWorkspace, findWorkspaceRoot, readWorkspaceManifest, yamlNestedValue } = require('./check');
const { taskCreate, taskUpdate, refreshState, syncState } = require('./state');
const { readCollaboration } = require('./collaboration');
const { workspaceLayout, selectProject } = require('./workspace');
const { readTaskStore, shardFiles, clientId, assertNodeConsistency } = require('./tasks');
const workflow = require('./workflow');
const { entityRevision, listDocuments, syncStatus, boardWorkflow, taskWorkflow } = require('./board-data');
const { listClients, registerClient, setClientStatus } = require('./collaboration-store');
const { addComment, listComments } = require('./comment');
const { addAsset } = require('./asset');
const { loadDocumentContract, planDocumentContract, updateDocumentContract } = require('./document-contract');
const { loadBoardPresentation, savePresentation } = require('./board-presentation');
const { MODES: APPROVAL_MODES, DEFAULT_PROJECT_MODE, DEFAULT_WORKSPACE_FLOOR } = require('./approval-mode');
const { CONSTRAINT_KINDS, EXEMPTABLE_GATES } = require('./item-type');
const { pendingRuns } = require('./run-pending');
const runLedger = require('./run-ledger');
const { approveRun } = require('./run');

// inheritance와 sources는 파일 경로와 원본을 담은 파생 정보라 revision 비교에서 뺀다.
// 넣어 두면 경로가 같아도 값이 같은지 판단하는 데 방해만 된다.
function stripSources(presentation) {
  const copy = Object.assign({}, presentation);
  delete copy.inheritance;
  delete copy.sources;
  return copy;
}

const { TASK_STATES: STATUSES } = require('./vocabulary');
const UI_ROOT = path.join(__dirname, 'board-ui');

// 문서에 넣은 그림을 보드가 서빙한다. 지금까지 정적 경로는 UI 자산과 라이브러리뿐
// 이었고, 그래서 화면설계 문서에 캡처를 넣어도 404였다. 런돌은 에이전트 저작을
// 전제로 만든 도구인데 에이전트가 캡처를 넣어도 볼 수 없다는 것은 전제와 어긋난다.
//
// 파일을 디스크에서 읽어 내보내는 경로이므로 범위를 좁게 잡는다: 프로젝트 루트
// 안이어야 하고, 심링크로 밖을 가리켜서는 안 되고, 그림 확장자여야 하고, 크기
// 상한이 있다. 확장자로 Content-Type을 정하되 nosniff를 함께 보낸다.
const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon'
});
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function projectAsset(response, projectRoot, relative) {
  let decoded;
  try { decoded = decodeURIComponent(relative); } catch (_) { return json(response, 400, { error: '경로를 해석할 수 없습니다.' }); }
  if (!decoded || decoded.includes('\0') || path.isAbsolute(decoded) || decoded.split(/[\\/]/u).includes('..')) {
    return json(response, 400, { error: '프로젝트 밖을 가리키는 경로입니다.' });
  }
  const extension = path.extname(decoded).toLowerCase();
  const type = IMAGE_TYPES[extension];
  if (!type) return json(response, 415, { error: `보드가 서빙하지 않는 형식입니다: ${extension || '(없음)'}` });
  const root = fs.realpathSync.native(projectRoot);
  const target = path.resolve(root, decoded);
  let real;
  try { real = fs.realpathSync.native(target); } catch (_) { return json(response, 404, { error: '파일을 찾지 못했습니다.' }); }
  // 심링크를 따라간 뒤에 다시 확인한다. 따라가기 전에만 보면 링크가 밖을 가리켜도 통과한다.
  const inside = path.relative(root, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return json(response, 403, { error: '프로젝트 밖의 파일입니다.' });
  const stat = fs.statSync(real);
  if (!stat.isFile()) return json(response, 404, { error: '파일이 아닙니다.' });
  if (stat.size > MAX_IMAGE_BYTES) return json(response, 413, { error: '이미지가 너무 큽니다.' });
  const body = fs.readFileSync(real);
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    // svg는 그 자체가 스크립트를 담을 수 있다. 문서로 열리는 경로가 아니라 <img>로만
    // 쓰이지만, 주소를 직접 열었을 때를 대비해 실행을 막는다.
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  response.end(body);
}

/**
 * 편집기에서 붙여 넣은 그림을 자산 디렉터리에 들인다.
 *
 * 검증과 축소는 `rdl asset add`가 이미 한다. 여기서 그 판정을 다시 쓰면 명령줄로
 * 넣은 그림과 화면으로 넣은 그림이 서로 다른 규격을 갖게 되고, 그 차이는 자산
 * 한계 검사에서야 드러난다. 그래서 바이트를 임시 파일로 내려놓고 같은 함수를 부른다.
 *
 * 임시 파일은 자산 디렉터리가 아니라 OS 임시 자리에 둔다. 자산 디렉터리에 두면
 * 실패한 업로드가 "어느 문서도 참조하지 않는 자산"으로 남아 검사가 그것을 센다.
 */
function addProjectAsset(root, projectKey, body) {
  const name = String(body.name || '').trim();
  if (!name) inputError('그림의 이름이 필요합니다.');
  const encoded = String(body.data || '');
  if (!encoded) inputError('그림 내용이 비어 있습니다.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) inputError('그림을 해석하지 못했습니다.');
  if (bytes.length > MAX_IMAGE_BYTES) inputError('그림이 너무 큽니다.');

  const extension = path.extname(name).toLowerCase() || '.png';
  const temporary = path.join(os.tmpdir(), `rundol-asset-${process.pid}-${crypto.randomBytes(6).toString('hex')}${extension}`);
  fs.writeFileSync(temporary, bytes);
  try {
    return addAsset(root, temporary, { project: projectKey, as: name, maxEdge: body.maxEdge });
  } catch (error) {
    // 형식이 아니거나 규격을 넘긴 것은 서버가 잘못한 일이 아니라 보낸 것이 잘못된
    // 경우다. 500으로 돌려주면 화면은 "서버가 죽었다"로 읽고, 사람은 다시 눌러 본다.
    if (!error.statusCode) error.statusCode = 400;
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

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

// options.all은 Board 스냅샷 전용이다. 스냅샷은 화면이 클라이언트에서 걸러 쓰는 작업
// 집합 전체이므로 여기에 페이지 나눔이 끼면 101번째부터가 목록·내 작업·조치 필요·선행
// 태스크 판정에서 한꺼번에, 그것도 아무 표시 없이 사라진다.
function queryTasks(config, search, options) {
  const all = readTasks(config);
  const query = (search.get('q') || '').trim().toLowerCase();
  const owner = search.get('owner') || '';
  const priority = search.get('priority') || '';
  const status = search.get('status') || '';
  const offset = options && options.all ? 0 : Math.max(0, Number.parseInt(search.get('offset') || '0', 10) || 0);
  const limit = options && options.all ? all.length || 1 : Math.min(500, Math.max(1, Number.parseInt(search.get('limit') || '100', 10) || 100));
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

// 문서 편집기 번들. 다른 화면 자산과 달리 만들어진 것이라 없을 수 있다 —
// 설치 없이 tarball만 푼 경우다. 그때 500으로 죽으면 보드 전체가 안 뜬 것처럼
// 보이므로, 404로 돌려주고 화면이 원문 편집기로 물러나게 둔다.
function generatedAsset(response, file, type) {
  const target = path.join(UI_ROOT, 'generated', file);
  if (!fs.existsSync(target)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('editor bundle not built');
    return;
  }
  const body = fs.readFileSync(target);
  response.writeHead(200, {
    'Content-Type': `${type}; charset=utf-8`,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
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

// 그림은 64KB 상한에 걸린다. 화면 갈무리 한 장이 그보다 크고, 그래서 이 한계는
// 그림을 넣는 경로에서는 "요청이 크다"가 아니라 "그림을 못 넣는다"가 된다.
// 서빙 쪽 한계와 같은 값을 쓴다 — 넣을 수 있는 것과 볼 수 있는 것이 달라지면
// 넣어 놓고 못 보는 그림이 생긴다.
function requestBody(request, limit) {
  const cap = limit || 64 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error(`요청 본문은 ${Math.round(cap / 1024)}KB를 넘을 수 없습니다.`));
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
    if (workflow.stepOf(task.status) === 'in-approval' && (!task.reviewers || task.reviewers.length === 0)) items.push({ severity: 'warning', kind: 'task', id: task.id, title: task.title, reason: '검토자 없음' });
    // 반려된 선행 태스크는 끝나지 않았지만 더 이상 진행되지도 않는다. 종료로 보지 않으면
    // 후행 태스크가 영영 막힌 것으로 표시되고 풀 방법이 없다.
    for (const dependency of task.deps || []) if (taskIds.has(dependency) && !workflow.isTerminal(tasks.find((item) => item.id === dependency).status)) items.push({ severity: 'info', kind: 'task', id: task.id, title: task.title, reason: `선행 태스크 미완료: ${dependency}` });
    for (const link of task.links || []) if (!documentIds.has(link)) items.push({ severity: 'error', kind: 'task', id: task.id, title: task.title, reason: `깨진 문서 연결: ${link}` });
  }
  // 동기화는 여기 들어오지 않는다. 이 목록은 "봐야 할 문제"이고 동기화는 "누르면
  // 커밋하고 원격으로 올리는 실행"이라 성격이 다르다. 게다가 이 항목은 늘 맨 뒤에
  // 붙어 화면의 앞 12건에 들지 못했고, 헤더가 같은 사실을 이미 글자로 말하고 있어
  // 숫자만 1 늘리는 역할을 했다. 동기화 상태는 헤더가 갖는다.
  return items;
}

// rdl check 결과는 지금까지 쓰기 게이트로만 쓰이고 버려졌다. 계약을 정하는 화면이
// 그 계약이 지켜지는지 못 보여주던 이유다. 전체 검사는 비싸므로 revision이 바뀔 때만 계산한다.
const diagnosticsCache = new Map();
function projectDiagnostics(root, projectKey, revision) {
  const cached = diagnosticsCache.get(projectKey);
  if (cached && cached.revision === revision) return cached.value;
  let value;
  try {
    const checked = checkWorkspace(root, { project: projectKey, strict: true });
    value = {
      summary: checked.summary,
      items: checked.diagnostics.map((item) => ({
        code: item.code, severity: item.severity, category: item.category,
        file: item.file, artifactId: item.artifactId, target: item.target, message: item.message
      }))
    };
  } catch (error) {
    value = { summary: { errors: 0, warnings: 0, failed: true }, items: [], error: error.message };
  }
  diagnosticsCache.set(projectKey, { revision, value });
  return value;
}

/**
 * 이 태스크를 어디로 옮길 수 있는가. 화면이 전환 단추를 그리기 전에 묻는 자리다.
 *
 * 판정은 한 줄도 여기 없다. 조건을 하나라도 다시 적으면 JUDGMENT_SURFACES 넷
 * (cli · board · check · adapter) 밖에 다섯 번째 표면이 생기고, 다섯 번째는 나머지
 * 넷과 조금씩 다른 답을 낸다 — 두 규칙이 같은 사실에서 나오는데 한 화면에 보이지
 * 않아 사람을 두 번 왕복시킨 사고가 이 파일이 생긴 이유였다. 이 함수가 하는 일은
 * workflow.js의 답을 옮기는 것뿐이다.
 *
 * 흐름은 그 태스크의 유형이 타는 것으로 고른다. 기본 흐름으로 판정하면 유형마다
 * 흐름이 갈리는 프로젝트에서 화면과 저장이 다른 답을 내고, 그때 막히는 쪽은 저장이라
 * 사람은 통과할 줄 알았던 단추에서 막힌다.
 *
 * 선언되지 않은 전환도 목록에 남긴다. 빼 버리면 화면은 "왜 이 단추가 없는가"에 답할
 * 수 없고, 그 물음은 결국 파일을 열어야만 풀린다.
 */
function taskTransitions(root, projectKey, task, to) {
  const flow = taskWorkflow(root, projectKey, task.kind);
  const nodes = Object.keys(flow.engine.nodes);
  // 없는 노드는 여기서 막는다. 판정은 모르는 노드에 대해 빈 목록을 돌려주는데 빈
  // 목록은 "막는 것이 없다"는 뜻이라, 그대로 내보내면 갈 수 없는 자리가 갈 수 있는
  // 자리로 읽힌다.
  const asked = to === undefined || to === null || to === '' ? null : String(to);
  if (asked !== null && !nodes.includes(asked)) inputError(`이 워크플로에 없는 노드입니다: ${asked}`, 'unknown-node');
  const targets = asked !== null ? [asked] : nodes.filter((node) => node !== task.status);
  return {
    project: projectKey,
    task: task.id,
    kind: task.kind || null,
    from: task.status,
    workflow: { id: flow.id, label: flow.label, origin: flow.origin, targetKind: flow.engine.targetKind },
    transitions: targets.map((node) => {
      const declared = flow.engine.transitions ? flow.engine.transitionFor(task.status, node) : null;
      const blockers = flow.engine.judgeTransition(task.status, node, task, null);
      return {
        from: task.status,
        to: node,
        title: declared ? declared.title : null,
        // 전환 목록이 없는 흐름은 막지 않는다. 그 경우 "선언되었다"는 물음 자체가
        // 성립하지 않으므로 전부 열린 것으로 적는다 — workflow.js가 같은 규칙으로 판정한다.
        declared: flow.engine.transitions ? Boolean(declared) : true,
        approval: Boolean(declared && declared.approval && declared.approval.human),
        allowed: blockers.length === 0,
        blockers
      };
    })
  };
}

function workspaceSnapshot(root, projectKey, search) {
  const layout = workspaceLayout(root);
  const project = selectProject(layout, projectKey, true);
  const config = boardConfig(root, project.key);
  const tasksResult = queryTasks(config, search || new URLSearchParams(), { all: true });
  const documents = listDocuments(project);
  const collaboration = readCollaboration(root, project.key);
  const sync = syncStatus(project);
  const clients = layout.schemaVersion >= 6 ? listClients(root).clients : [];
  const contract = loadDocumentContract(root, project.key);
  const presentation = loadBoardPresentation(root, project.key);
  // 댓글은 태스크와 다른 원장에 산다. 스냅숏에 함께 실어야 화면이 두 번 묻지 않고,
  // 영역 revision을 따로 두어야 댓글만 늘었을 때 태스크 목록을 다시 그리지 않는다.
  const comments = listComments(root, { project: project.key }).comments;
  const workspaceRevision = boardRevision(config);
  return {
    project: project.key,
    client: boardClient(root, project, clients),
    diagnostics: projectDiagnostics(root, project.key, `${workspaceRevision}:${entityRevision(documents)}`),
    revision: { workspace: workspaceRevision, tasks: entityRevision(tasksResult.tasks), documents: entityRevision(documents), people: entityRevision(collaboration), clients: entityRevision(clients), sync: entityRevision(sync), contract: entityRevision(contract), presentation: entityRevision(stripSources(presentation)), comments: entityRevision(comments) },
    comments,
    projects: overview(root).projects,
    documents,
    tasks: tasksResult,
    // 화면은 브라우저에서 그대로 돌아 require를 쓸 수 없다. 목록을 실어 주지
    // 않으면 화면이 자기 사본을 적게 되고, 저장값이 늘어도 화면은 그것을 모른 채
    // 돈다 — board-presentation.js가 키를 정본에서 가져오는 것과 같은 이유다.
    //
    // 이 자리는 오래 workflow.taskWorkflowView()였다. 그것은 모듈 최상위 export,
    // 즉 transitions: null로 만든 내장 인스턴스의 뷰라 전환도 라벨도 언제나 비어
    // 있었고, 그래서 workflows.json을 고쳐도 화면은 그대로였다 — 설정 층은 있는데
    // 그 층을 보여 주는 화면이 없었다는 뜻이다. 이제 프로젝트 설정을 태운다.
    workflow: boardWorkflow(root, project.key),
    attention: attentionItems(tasksResult.tasks, documents, sync),
    people: collaboration,
    clients,
    sync,
    contract,
    presentation,
    // 모드 표는 코드가 갖고 화면은 그것을 그린다. 화면이 표를 다시 적으면 코드가
    // 바뀌는 날 둘이 갈라지고, 사용자는 화면을 믿는다.
    approvalCatalog: { modes: APPROVAL_MODES, defaultMode: DEFAULT_PROJECT_MODE, defaultFloor: DEFAULT_WORKSPACE_FLOOR },
    // 제약 카탈로그도 화면이 다시 적지 않는다. 다섯 종류가 무엇인지는 코드가 알고,
    // 화면은 그것을 그린다 — 화면이 목록을 따로 들면 종류가 늘어날 때 한쪽만 는다.
    itemTypeCatalog: { kinds: CONSTRAINT_KINDS, exemptable: EXEMPTABLE_GATES },
    runs: [],
    proposals: []
  };
}

// Board가 정본을 바꾸려면 자기가 어느 Client인지 알아야 한다.
// 로컬 ID(.rundol/state/client-id)는 태스크 샤딩이 이미 쓰고 있으므로 같은 값을 재사용해
// "이 기기가 만든 태스크"와 "이 기기가 남긴 기록"이 하나의 정체성으로 이어지게 한다.
function boardClient(root, project, clients) {
  const id = clientId(project.root);
  const registered = (clients || []).find((item) => item.id === id) || null;
  return { id, registered: Boolean(registered), status: registered ? registered.status : null, owner: registered ? registered.owner : null };
}

// 거절에는 종류를 붙일 수 있다. 화면이 문장을 뒤져 원인을 되짚으면 말을 다듬는 순간
// 판정이 깨지므로, 화면이 다르게 처리해야 하는 거절은 code로 구분한다.
function inputError(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  if (code) error.code = code;
  throw error;
}

// 문서 편집 소프트 리스는 ADR-015로 폐기했다. 저장을 막는 것은 baseRevision과
// 브랜치 경계이며, 그 둘은 시계에 의존하지 않으므로 그대로 남는다. "지금 누가 이
// 문서를 열어 두었다"는 신호는 중앙 권위 없이는 관측 시점에 이미 낡은 값이었다.

/**
 * 원본 파일과 새 본문으로 저장할 파일 전체를 만든다. 파일을 읽지도 쓰지도 않는다.
 *
 * 이 계산이 따로 서 있는 이유는 정리가 아니라 시험 가능성이다. 편집하지 않은 문서를
 * 저장했을 때 바이트가 그대로인지는 저장 경로 전체를 돌리지 않고는 확인할 수 없었고,
 * 그래서 확인되지 않았다. 떼어 두면 저장소의 정본 문서 전체를 한 번에 통과시켜
 * 볼 수 있다 — document-roundtrip.test.js가 그 일을 한다.
 */
function composeDocumentFile(original, nextBody) {
  // 닫는 --- 뒤의 빈 줄까지 함께 잡는다. 본문만 다듬고 이 자리를 버리면 손대지 않은
  // 문서도 저장할 때마다 빈 줄 하나가 사라져, 실제 변경과 구분되지 않는 diff가 남는다.
  const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)((?:\r?\n)*)/u.exec(original);
  if (!match) inputError('표준 frontmatter가 없는 문서는 Board에서 수정할 수 없습니다.');
  // 스냅샷의 본문은 줄바꿈이 \n으로 정규화되어 있다. 그대로 쓰면 CRLF 문서는 한 글자도
  // 고치지 않아도 전 줄이 바뀐 diff가 된다. 그 문서가 쓰던 줄바꿈으로 되돌려 쓴다.
  const eol = match[1].includes('\r\n') ? '\r\n' : '\n';
  const trimmed = String(nextBody == null ? '' : nextBody).replace(/\r\n/g, '\n').replace(/^\s+|\s+$/g, '');
  const restored = eol === '\r\n' ? trimmed.replace(/\n/g, '\r\n') : trimmed;
  return `${match[1]}${match[2]}${restored}${eol}`;
}

/**
 * 저장하지 않고 검사만 한다.
 *
 * 지금까지 편집 결과가 계약을 지키는지 아는 방법은 저장해 보는 것뿐이었다. 저장이
 * 실패하면 원본으로 되돌아가므로 파일은 안전하지만, 사람은 "저장을 눌러 봐야
 * 아는" 상태에 놓인다. 고칠 것이 여럿이면 그 왕복을 여러 번 한다.
 *
 * 검사는 디스크를 읽으므로 내용을 어딘가에 두어야 한다. 저장 경로와 같은 자리에
 * 쓰고 곧바로 되돌린다 — 다른 자리에 쓰면 그 파일은 프로젝트 밖이라 검사가 보지
 * 않고, 보지 않은 검사는 저장했을 때와 다른 답을 낸다.
 *
 * 되돌리기는 finally에 둔다. 검사가 예외를 던지든 아니든 원본은 반드시 돌아와야 한다.
 */
function checkDocumentBody(root, projectKey, documentId, body) {
  const project = selectProject(workspaceLayout(root), projectKey, true);
  const current = listDocuments(project).find((item) => item.id === documentId);
  if (!current) { const error = new Error('문서를 찾지 못했습니다.'); error.statusCode = 404; throw error; }
  const nextBody = String(body.body == null ? '' : body.body);
  if (Buffer.byteLength(nextBody, 'utf8') > 512 * 1024) inputError('문서 본문은 512KB를 넘을 수 없습니다.');
  const file = path.resolve(project.root, current.file);
  if (!file.startsWith(`${path.resolve(project.root)}${path.sep}`)) inputError('프로젝트 경로 밖의 문서는 검사할 수 없습니다.');

  const original = fs.readFileSync(file, 'utf8');
  const composed = composeDocumentFile(original, nextBody);
  // 바뀐 것이 없으면 쓰지 않는다. 같은 내용을 썼다 되돌리는 것은 파일 시각만 흔든다.
  if (composed === original) return summarizeDiagnostics(root, projectKey, current);
  try {
    fs.writeFileSync(file, composed, 'utf8');
    return summarizeDiagnostics(root, projectKey, current);
  } finally {
    fs.writeFileSync(file, original, 'utf8');
  }
}

// 이 문서에 걸린 진단만 추린다. 저장을 막는 것은 오류뿐이므로 등급을 함께 준다.
function summarizeDiagnostics(root, projectKey, document) {
  const checked = checkWorkspace(root, { project: projectKey, strict: true, skipProfilePolicy: true });
  const mine = (checked.diagnostics || []).filter((item) =>
    item.artifactId === document.id || (item.file && item.file.replace(/\\/g, '/').endsWith(document.file)));
  return {
    id: document.id,
    blocking: mine.some((item) => item.severity === 'error'),
    errors: checked.summary.errors,
    diagnostics: mine.map((item) => ({
      code: item.code, severity: item.severity, line: item.line || null, message: item.message
    }))
  };
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
  const composed = composeDocumentFile(original, nextBody);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, composed, 'utf8');
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
  if (Object.prototype.hasOwnProperty.call(body, 'blocker')) result.blocker = blockerInput(body.blocker);
  if (Object.prototype.hasOwnProperty.call(body, 'cancellation')) result.cancellation = cancellationInput(body.cancellation);
  if (creating) {
    if (!result.title) inputError('태스크 제목이 필요합니다.');
    if (!result.acceptanceCriteria) inputError('완료조건이 하나 이상 필요합니다.');
  }
  return result;
}

function blockerInput(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) inputError('대기 사유 형식이 올바르지 않습니다.');
  const waitingFor = String(value.waitingFor || '').trim();
  const condition = String(value.condition || '').trim();
  const since = String(value.since || '').trim();
  if (!waitingFor || !condition || !since) inputError('대기 사유에는 대기 대상, 해제 조건과 대기 시작 시각이 모두 필요합니다.');
  if (condition.length > 1000) inputError('해제 조건이 너무 깁니다.');
  if (Number.isNaN(Date.parse(since))) inputError(`대기 시작 시각이 올바르지 않습니다: ${since}`);
  return { waitingFor, condition, since: new Date(since).toISOString() };
}

function cancellationInput(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) inputError('반려 사유 형식이 올바르지 않습니다.');
  const reason = String(value.reason || '').trim();
  const decidedBy = String(value.decidedBy || '').trim();
  const at = String(value.at || '').trim();
  if (!reason || !decidedBy || !at) inputError('반려에는 사유, 결정자와 결정 시각이 모두 필요합니다.');
  if (reason.length > 1000) inputError('반려 사유가 너무 깁니다.');
  if (Number.isNaN(Date.parse(at))) inputError(`반려 결정 시각이 올바르지 않습니다: ${at}`);
  return { reason, decidedBy, at: new Date(at).toISOString() };
}

// 노드와 항목의 짝은 저장 계층이 부르는 것과 같은 판정부가 답한다. 여기 같은
// 규칙을 다시 적어 두었던 동안 두 벌은 강도가 갈려 있었다 — 저장은 blocker가
// 있기만 하면 받았고 검사는 세 부분을 요구했다. Board가 400으로 돌려줄 근거를
// 갖는 것과 그 근거를 여기서 다시 짓는 것은 다른 일이다.
//
// 판정이 던지는 것은 statusCode 400을 단 오류이므로 그대로 올려 보낸다. 막는
// 규칙이 여럿이면 여럿이 한 줄에 실려 온다 — 화면이 하나씩 만나며 왕복하지
// 않게 하는 것이 이 설계의 목적이다.
//
// 흐름은 그 항목의 유형이 타는 것으로 고른다. 넘기지 않으면 판정이 내장으로
// 떨어지고, 그러면 화면 앞의 이 게이트는 프로젝트가 선언한 전환을 모른 채 답한다.
// 저장이 뒤에서 알고 막으므로 사람이 잘못된 자리로 가지는 않지만, 같은 파일 안에서
// 두 판정이 다른 표를 보는 것은 다섯 번째 표면을 만드는 첫걸음이다.
//
// 설정을 읽지 못하면 내장으로 떨어진다. 저장이 설정 파일 하나에 인질이 되면 안 되기
// 때문이고 state.js가 같은 규율을 쓴다 — 설정이 틀렸다는 사실은 rdl check가 말한다.
function requireNodeConsistency(root, projectKey, current, changes) {
  let flow = null;
  try {
    flow = taskWorkflow(root, projectKey, (changes && changes.kind) || (current && current.kind)).engine;
  } catch (_) {
    flow = null;
  }
  assertNodeConsistency(current, changes, flow);
}

function validateTaskAssignments(root, input, projectKey) {
  const directory = readCollaboration(root, projectKey);
  const memberIds = new Set(directory.members.map((member) => member.id));
  const stakeholderIds = new Set(directory.stakeholders.map((stakeholder) => stakeholder.id));
  if (input.owner && !memberIds.has(input.owner)) inputError(`project.md에 등록되지 않은 담당자입니다: ${input.owner}`);
  if (input.blocker && !memberIds.has(input.blocker.waitingFor) && !stakeholderIds.has(input.blocker.waitingFor)) inputError(`project.md에 등록되지 않은 대기 대상입니다: ${input.blocker.waitingFor}`);
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

// 승인자로 제시할 수 있는 자격만 내보낸다. 고를 수 없는 것을 화면에 두면 사람은
// 거절당한 뒤에야 그것을 알게 된다. 판정 자체는 승인이 다시 하므로 이 목록은
// 편의이고, 여기가 느슨해져도 자격이 넓어지지는 않는다.
//
// 이 기기의 작성자 신원(boardClient)은 여기에 들어올 수 없다. 그 값은 태스크 샤딩이
// 쓰는 기기 ID이고 유형이 human이 아니며, human으로 바꾸는 순간 같은 기기의 실행
// 명령이 전부 거부된다(src/run.js:57).
function runApprovers(root, project) {
  let members = [];
  try { members = readCollaboration(root, project.key).members; } catch (error) { members = []; }
  const active = new Set(members.filter((member) => member.fields && member.fields['상태'] === 'active').map((member) => member.id));
  return listClients(root).clients
    .filter((client) => client.type === 'human' && client.status === 'active' && active.has(client.owner))
    .map((client) => ({ id: client.id, name: client.name, owner: client.owner }));
}

// 런 갈래 판정은 run-pending이 정본이다. 보드는 인자를 옮기고 결과를 그린다 — 판정이
// 둘이면 화면과 명령줄이 같은 런에 다른 답을 낸다.
//
// pendingRuns를 쓰는 이유가 하나 더 있다. 그 함수는 runContext 대신 readRunFolds를
// 도는데, 그것이 "무엇이 주의를 요구하는지 묻는 행위가 원장을 바꾸지 않는다"를 지키는
// 유일한 경로다. 화면은 같은 물음을 되풀이해서 던지므로 여기서 특히 중요하다.
function boardRuns(root, projectKey) {
  const project = selectProject(workspaceLayout(root), projectKey, true);
  const pending = pendingRuns(root, { project: project.key });
  return {
    project: project.key,
    waiting: pending.waiting,
    drivable: pending.drivable,
    driving: pending.driving,
    unreadable: pending.unreadable,
    approvers: runApprovers(root, project)
  };
}


// 승인 대화상자가 읽는 한 런의 내막. 목록과 나누는 이유는 값이 커서가 아니라 물음이
// 다르기 때문이다 — 목록은 "누가 기다리는가"를 묻고 이것은 "무엇을 승인하는가"를 묻는다.
// 뭉쳐 두면 화면을 열어 두기만 해도 모든 런의 이벤트를 되풀이해서 읽는다.
//
// 여기서도 reconcile 하지 않는다. 승인하려고 열어 본 것이 원장을 고치면, 무엇을
// 승인할지 살펴보는 행위와 승인하는 행위의 경계가 사라진다.
function boardRunDetail(root, projectKey, runId) {
  const layout = workspaceLayout(root);
  const project = selectProject(layout, projectKey, true);
  const local = runLedger.readRunEvents(runLedger.runDirectory(project.root, runId));
  const shared = runLedger.readSharedRunEvents(layout, project.key, runId);
  const events = runLedger.unionRunEvents(local, shared);
  if (!events.length) {
    const error = new Error(`런을 찾지 못했습니다: ${runId}`);
    error.statusCode = 404;
    throw error;
  }
  const fold = shared.length ? runLedger.foldSharedRun(events) : runLedger.foldRun(events);
  const started = events.find((event) => event && event.type === 'run.started') || {};
  // 대상 문서는 시작 시 지목한 것과 스텝이 만들어 낸 것 둘 다다. 저작 절차는 런 도중에
  // 문서를 만들므로 시작 이벤트만 보면 정작 승인할 문서가 목록에서 빠진다.
  const artifactIds = [];
  for (const id of [started.targetArtifactId].concat(fold.artifactIds || [])) {
    if (id && !artifactIds.includes(id)) artifactIds.push(id);
  }
  return {
    project: project.key,
    runId: fold.runId,
    status: fold.status,
    goal: started.goal || null,
    taskId: fold.taskId || null,
    procedure: fold.procedure || null,
    cursor: fold.cursor || null,
    cursorStep: fold.cursorStep ? { id: fold.cursorStep.id, human: fold.cursorStep.human === true } : null,
    completedSteps: fold.completedSteps || [],
    humanGateSteps: fold.humanGateSteps || [],
    humanApprovals: fold.humanApprovals || [],
    owner: fold.owner || null,
    artifactIds,
    // 무엇을 하고 여기까지 왔는지. 승인은 결과만이 아니라 경로를 보고 하는 판단이다.
    trail: events.map((event) => ({
      type: event.type,
      stepId: event.stepId || null,
      clientId: event.clientId || null,
      exitCode: event.exitCode === undefined ? null : event.exitCode,
      reason: event.reason || null,
      occurredAt: event.occurredAt || null
    })),
    approvers: runApprovers(root, project)
  };
}
// 사람 게이트를 웹에서 지나는 자리. 자격 판정은 rdl run approve와 같은 함수가 한다 —
// 표면마다 판정을 따로 두면 그중 느슨한 쪽이 게이트의 실제 높이가 된다.
function approveBoardRun(root, projectKey, runId, body) {
  // human 자격을 하네스가 들 수 없다는 것이 사람 게이트의 전부다. 하네스가 띄운
  // Board는 그 자격을 HTTP로 빌려주는 창구가 되므로 승인만 거절한다. 조회는 그대로
  // 둔다 — 무엇이 막혀 있는지는 하네스도 알아야 사람에게 가져갈 수 있다.
  if (process.env.RUNDOL_HARNESS_CHILD === '1') {
    const error = new Error('하네스가 실행한 Board에서는 승인할 수 없습니다. 사람이 직접 연 Board나 명령줄에서 승인하세요.');
    error.statusCode = 403;
    error.code = 'harness-board';
    throw error;
  }
  const approver = String((body && body.clientId) || '').trim().toLowerCase();
  if (!approver) inputError('승인자 Client를 고르세요. 활성 human Client만 사람 게이트를 지날 수 있습니다.', 'missing-approver');
  const reason = String((body && body.reason) || '').trim();
  if (!reason) inputError('무엇을 보고 승인했는지 사유가 필요합니다.', 'missing-reason');
  try {
    return approveRun(root, { project: projectKey, run: runId, clientId: approver, reason, step: (body && body.step) || undefined });
  } catch (error) {
    // 승인 거절은 서버 결함이 아니라 "이 요청은 지금 받아들여질 수 없다"는 답이다.
    // 500으로 내보내면 사람은 무엇을 고쳐야 하는지 모른 채 같은 버튼을 다시 누른다.
    if (!error.statusCode) { error.statusCode = 400; error.code = error.code || 'approval-refused'; }
    throw error;
  }
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
      if (request.method === 'GET' && url.pathname === '/editor.js') return generatedAsset(response, 'entry.js', 'application/javascript');
      if (request.method === 'GET' && url.pathname === '/editor.css') return generatedAsset(response, 'entry.css', 'text/css');
      if (request.method === 'GET' && url.pathname === '/mermaid.js') return dependencyAsset(response, 'mermaid/dist/mermaid.min.js');
      if (request.method === 'GET' && url.pathname === '/marked.js') return packageAsset(response, 'marked', 'lib/marked.umd.js');
      if (request.method === 'GET' && url.pathname === '/dompurify.js') return dependencyAsset(response, 'dompurify/dist/purify.min.js');
      if (request.method === 'GET' && url.pathname === '/api/overview') return json(response, 200, overview(config.root));
      if (request.method === 'GET' && url.pathname === '/api/projects') return json(response, 200, overview(config.root).projects);
      if (request.method === 'GET' && url.pathname === '/api/clients') return json(response, 200, listClients(config.root));
      const projectAssetMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/assets\/(.+)$/u);
      if (request.method === 'GET' && projectAssetMatch) {
        const assetProject = selectProject(workspaceLayout(config.root), projectAssetMatch[1], true);
        return projectAsset(response, assetProject.root, projectAssetMatch[2]);
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/u);
      const projectTasksMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/tasks$/u);
      const projectTaskMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/tasks\/(TASK-[A-Za-z0-9-]+)$/u);
      // 옮기지 않고 판정만 묻는 자리. 태스크 저장 경로와 나란히 두어 같은 판정을 쓴다 —
      // 문서의 check가 저장 경로 옆에 선 것과 같은 규율이고, 이유도 같다.
      const projectTaskTransitionsMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/tasks\/(TASK-[A-Za-z0-9-]+)\/transitions$/u);
      const projectDocumentsMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents$/u);
      const projectDocumentMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents\/([^/]+)$/u);
      // 저장하지 않고 검사만 하는 자리. 문서 저장 경로와 나란히 두어 같은 판정을 쓴다.
      const projectDocumentCheckMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents\/([^/]+)\/check$/u);
      const projectSyncMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/sync$/u);
      const projectRefreshMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/refresh$/u);
      const projectSnapshotMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/board-snapshot$/u);
      const projectContractMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/contract$/u);
      const projectContractPlanMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/contract\/plan$/u);
      const projectPresentationMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/presentation$/u);
      const projectRunsMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/runs$/u);
      const projectRunApproveMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/runs\/(RUN-[A-Za-z0-9]+)\/approve$/u);
      const projectRunMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/runs\/(RUN-[A-Za-z0-9]+)$/u);
      const requestedProject = [projectMatch, projectTasksMatch, projectTaskMatch, projectTaskTransitionsMatch, projectDocumentsMatch, projectDocumentCheckMatch, projectDocumentMatch, projectSyncMatch, projectRefreshMatch, projectSnapshotMatch, projectContractMatch, projectContractPlanMatch, projectPresentationMatch].find(Boolean);
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
      if (request.method === 'GET' && projectTaskTransitionsMatch) {
        const task = readTasks(requestedConfig).find((item) => item.id === projectTaskTransitionsMatch[2]);
        if (!task) return json(response, 404, { error: '태스크를 찾지 못했습니다.' });
        return json(response, 200, taskTransitions(config.root, projectTaskTransitionsMatch[1], task, url.searchParams.get('to')));
      }
      if (request.method === 'GET' && projectDocumentsMatch) return json(response, 200, { project: projectDocumentsMatch[1], documents: listDocuments(selectProject(workspaceLayout(config.root), projectDocumentsMatch[1], true)) });
      if (request.method === 'GET' && projectDocumentMatch) {
        const document = listDocuments(selectProject(workspaceLayout(config.root), projectDocumentMatch[1], true)).find((item) => item.id === decodeURIComponent(projectDocumentMatch[2]));
        return document ? json(response, 200, document) : json(response, 404, { error: '문서를 찾지 못했습니다.' });
      }
      if (request.method === 'GET' && projectSyncMatch) return json(response, 200, syncStatus(selectProject(workspaceLayout(config.root), projectSyncMatch[1], true)));
      if (request.method === 'GET' && projectRunsMatch) return json(response, 200, boardRuns(config.root, projectRunsMatch[1]));
      if (request.method === 'GET' && projectRunMatch) return json(response, 200, boardRunDetail(config.root, projectRunMatch[1], projectRunMatch[2]));
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
      // 그림을 들이는 자리. 조회는 경로가 이름을 담고, 들이기는 이름이 본문에 있다.
      // 토큰 검사 뒤에 둔다 — 파일을 만드는 경로가 그 앞에 있으면 안 된다.
      const projectAssetsMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/assets$/u);
      if (request.method === 'POST' && projectAssetsMatch) {
        const body = await requestBody(request, MAX_IMAGE_BYTES * 2);
        return json(response, 200, addProjectAsset(config.root, projectAssetsMatch[1], body));
      }
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
        requireNodeConsistency(config.root, input.project, null, input);
        validateTaskAssignments(config.root, input, input.project);
        return json(response, 201, taskCreate(config.root, input));
      }
      if (request.method === 'POST' && projectTaskMatch) {
        const body = await requestBody(request);
        const current = requireRevision(requestedConfig, projectTaskMatch[2], body.baseRevision);
        const changes = taskInput(body, false);
        requireNodeConsistency(config.root, projectTaskMatch[1], current, changes);
        validateTaskAssignments(config.root, changes, projectTaskMatch[1]);
        return json(response, 200, taskUpdate(config.root, projectTaskMatch[2], changes, projectTaskMatch[1]));
      }
      // 검사 자리가 저장 자리보다 먼저다. `/documents/:id` 정규식이 `/check`까지
      // 삼키지는 않지만, 순서를 뒤집으면 나중에 경로가 하나 늘 때 조용히 가려진다.
      if (request.method === 'POST' && projectDocumentCheckMatch) {
        const body = await requestBody(request);
        return json(response, 200, checkDocumentBody(config.root, projectDocumentCheckMatch[1], decodeURIComponent(projectDocumentCheckMatch[2]), body));
      }
      if (request.method === 'POST' && projectDocumentMatch) {
        const body = await requestBody(request);
        return json(response, 200, updateDocumentBody(config.root, projectDocumentMatch[1], decodeURIComponent(projectDocumentMatch[2]), body));
      }
      if (request.method === 'POST' && projectRunApproveMatch) {
        const body = await requestBody(request);
        return json(response, 200, approveBoardRun(config.root, projectRunApproveMatch[1], projectRunApproveMatch[2], body));
      }
      if (request.method === 'POST' && projectContractPlanMatch) {
        const body = await requestBody(request);
        return json(response, 200, planDocumentContract(config.root, projectContractPlanMatch[1], body));
      }
      if (request.method === 'POST' && projectContractMatch) {
        const body = await requestBody(request);
        return json(response, 200, updateDocumentContract(config.root, projectContractMatch[1], body));
      }
      // 표시 규칙과 프리셋은 board.json이 소유하고 범위마다 파일이 다르다. 커밋은 rdl save가
      // 맡으므로 여기서는 파일만 쓴다. 읽을 때와 같은 검증을 통과하지 못하면 손대지 않는다.
      if (request.method === 'POST' && projectPresentationMatch) {
        const body = await requestBody(request);
        const scope = body && body.scope;
        if (!['workspace', 'project'].includes(scope)) return json(response, 400, { error: 'scope는 workspace 또는 project여야 합니다.' });
        const projectKey = projectPresentationMatch[1];
        const current = loadBoardPresentation(config.root, projectKey);
        if (!body.baseRevision || body.baseRevision !== entityRevision(stripSources(current))) {
          return json(response, 409, { error: '표시 설정이 외부에서 변경되었습니다. 최신 값을 확인하세요.', current });
        }
        savePresentation(config.root, projectKey, scope, body);
        return json(response, 200, loadBoardPresentation(config.root, projectKey));
      }
      if (request.method === 'POST' && projectRefreshMatch) return json(response, 200, refreshState(config.root, { project: projectRefreshMatch[1] }));
      if (request.method === 'POST' && projectSyncMatch) {
        // sync는 공유 이벤트를 쓰므로 실행 주체를 밝혀야 한다. Board는 정체성을 지어낼
        // 수 없으므로 이 기기의 등록된 Client를 쓴다 — 태스크 샤딩이 이미 쓰는
        // 그 값이다. 등록되지 않았거나 자격이 맞지 않으면 스키마 오류가 아니라 무엇을
        // 해야 하는지를 말한다.
        const project = selectProject(workspaceLayout(config.root), projectSyncMatch[1], true);
        const identity = boardClient(config.root, project, listClients(config.root).clients);
        if (!identity.id) inputError('이 기기의 Client ID가 없습니다. rdl git init으로 프로젝트를 준비하세요.');
        // 화면에서 온 요청이면 화면에서 풀 수 있는 길을 먼저 가리킨다. 명령줄만 남기면
        // 사람은 하던 일을 접고 터미널로 가야 하고, 명령줄을 지우면 화면 없이 쓰는 경로가
        // 막힌다. 두 길을 순서로 구분한다.
        if (!identity.registered) inputError(`등록되지 않은 Client입니다: ${identity.id}. 설정 → Clients에서 이 기기를 등록하거나, 화면 없이 쓴다면 rdl client register ${identity.id} --name "이름" --type <human|agent> --owner <MEMBER-ID>를 실행하세요.`, 'unknown-client');
        return json(response, 200, syncState(config.root, { project: projectSyncMatch[1], remote: 'origin', push: true, clientId: identity.id }));
      }
      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await requestBody(request);
        const input = taskInput(body, true);
        input.project = activeConfig.project;
        requireNodeConsistency(activeConfig.root, activeConfig.project, null, input);
        validateTaskAssignments(activeConfig.root, input, activeConfig.project);
        return json(response, 201, taskCreate(activeConfig.root, input));
      }
      // 댓글은 태스크 리비전을 요구하지 않는다. append-only라 남의 댓글을 덮을 수
      // 없고, 리비전을 요구하면 두 사람이 동시에 쓸 때 한 명이 거절당한다 —
      // 논의 때문에 논의가 막히는 구조가 된다.
      const commentMatch = url.pathname.match(/^\/api\/tasks\/([A-Z0-9-]+)\/comments$/u);
      if (request.method === 'POST' && commentMatch) {
        const body = await requestBody(request);
        // 작성자는 요청이 주장하는 값이 아니라 이 기기의 Client다. 요청이 정하게
        // 두면 화면에서 아무 신원이나 적을 수 있고, 그 순간 작성 주체 파생이 무너진다.
        //
        // 구형 작업공간에는 Client 개념이 없다. 그런 곳에서는 누가 썼는지 남길 수
        // 없으므로 받지 않는다 — 신원 없는 기록은 나중에 누구에게도 물을 수 없다.
        const writerLayout = workspaceLayout(activeConfig.root);
        if (writerLayout.schemaVersion < 6) {
          return json(response, 409, { error: '댓글은 Client 신원이 필요합니다. rdl workspace migrate를 먼저 실행하세요.', code: 'workspace-too-old' });
        }
        const writer = boardClient(activeConfig.root, selectProject(writerLayout, activeConfig.project, true), listClients(activeConfig.root).clients);
        try {
          // 답글이 붙을 자리는 요청이 정한다 — 내용에 속하는 값이라 신원과 달리
          // 지어낼 수 있는 것이 아니다. 실재 여부와 같은 태스크인지는 저장이 판정한다.
          const created = addComment(activeConfig.root, {
            project: activeConfig.project, taskId: commentMatch[1], body: body.body,
            clientId: writer.id, member: body.member, parentId: body.parentId
          });
          return json(response, 201, created);
        } catch (error) {
          // 계약 위반은 서버 결함이 아니라 입력의 문제다. 500으로 내보내면 사람은
          // 무엇을 고쳐야 하는지 모른 채 다시 누르고, 그 사이 원인은 로그에만 남는다.
          if (error.name !== 'CommentViolation') throw error;
          // 화면에서 왔으면 화면에서 풀 수 있는 길을 알린다. 명령줄만 가리키면 하던
          // 일을 멈추고 터미널로 가야 하는데, 등록은 신원을 적는 일이지 위험한 일이
          // 아니다. 명령줄도 함께 남기는 이유는 화면 없이 쓰는 경로가 있기 때문이다.
          const help = error.code === 'unknown-client'
            ? ` 설정 → Clients에서 이 기기를 등록하거나, 명령줄에서 rdl client register ${writer.id} --name "이름" --type <human|agent> --owner <MEMBER-ID>를 실행하세요.`
            : '';
          const status = ['unknown-client', 'inactive-client'].includes(error.code) ? 403 : 400;
          return json(response, status, { error: `${error.message}${help}`, code: error.code });
        }
      }
      if (request.method === 'GET' && commentMatch) {
        return json(response, 200, listComments(activeConfig.root, { project: activeConfig.project, taskId: commentMatch[1] }));
      }
      if (request.method === 'POST' && taskMatch) {
        const body = await requestBody(request);
        const current = requireRevision(activeConfig, taskMatch[1], body.baseRevision);
        const changes = taskInput(body, false);
        if (Object.keys(changes).length === 0) return json(response, 400, { error: '변경할 태스크 필드가 필요합니다.' });
        requireNodeConsistency(activeConfig.root, activeConfig.project, current, changes);
        validateTaskAssignments(activeConfig.root, changes, activeConfig.project);
        const result = taskUpdate(activeConfig.root, taskMatch[1], changes, activeConfig.project);
        return json(response, 200, result);
      }
      // project.md는 프로젝트 정본이므로 사람·역할 변경은 명령줄만 담당한다.
      // 같은 파일에 쓰는 경로가 둘이면 검증과 되돌리기가 두 배가 된다.
      if (request.method === 'POST' && collaborationMatch) {
        return json(response, 405, { error: `${collaborationMatch[1]} 변경은 rdl member 명령으로 수행합니다. project.md는 명령줄에서만 씁니다.` });
      }
      if (request.method === 'POST' && url.pathname === '/api/refresh') return json(response, 200, refreshState(activeConfig.root, { project: activeConfig.project }));
      if (request.method === 'POST' && url.pathname === '/api/sync') return json(response, 200, syncState(activeConfig.root, { project: activeConfig.project, remote: 'origin', push: true }));
      return json(response, 404, { error: '경로를 찾지 못했습니다.' });
    } catch (error) {
      return json(response, error.statusCode || 500, { error: error.message, code: error.code || undefined, current: error.current || undefined });
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

module.exports = { STATUSES, boardConfig, queryTasks, boardRevision, overview, workspaceSnapshot, taskTransitions, attentionItems, composeDocumentFile, createBoardServer, startBoard };
