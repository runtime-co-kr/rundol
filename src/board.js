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
const { listClients, registerClient, setClientStatus, humanApproversFrom, projectHumanApprovers } = require('./collaboration-store');
const { addComment, listComments } = require('./comment');
const { addAsset, assetsDirectory } = require('./asset');
const { loadDocumentContract, planDocumentContract, updateDocumentContract } = require('./document-contract');
const { loadBoardPresentation, savePresentation, presentationSavePlan } = require('./board-presentation');
const { loadWorkflows, workflowsSavePlan, saveWorkflows, readJson: readWorkflowLayer } = require('./workflow-config');
const { requestPolicyDecision } = require('./policy-gate');
const { listDecisions, answerDecision } = require('./decision');
const { MODES: APPROVAL_MODES, DEFAULT_PROJECT_MODE, DEFAULT_WORKSPACE_FLOOR } = require('./approval-mode');
const { CONSTRAINT_KINDS, EXEMPTABLE_GATES } = require('./item-type');
const { runGit } = require('./git');
const { pendingRuns } = require('./run-pending');
const runLedger = require('./run-ledger');
const { approveRun } = require('./run');
const { searchWorkspace } = require('./search');

// inheritance와 sources는 파일 경로와 원본을 담은 파생 정보라 revision 비교에서 뺀다.
// 넣어 두면 경로가 같아도 값이 같은지 판단하는 데 방해만 된다.
function stripSources(presentation) {
  const copy = Object.assign({}, presentation);
  delete copy.inheritance;
  delete copy.sources;
  return copy;
}

const { TASK_STATES: STATUSES, BASIS_KINDS } = require('./vocabulary');
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
    let over = false;
    request.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > cap) {
        over = true;
        const error = new Error(`요청 본문은 ${Math.round(cap / 1024)}KB를 넘을 수 없습니다.`);
        error.statusCode = 413;
        reject(error);
        // 소켓을 끊지 않는다. 끊으면 브라우저는 응답 대신 네트워크 오류를 받고,
        // 화면은 "Failed to fetch"만 남긴다 — 무엇이 한계를 넘었는지도, 어떻게
        // 하면 되는지도 말하지 못한다. 남은 본문은 버리되 응답은 끝까지 내보낸다.
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (over) return;
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

// 문서의 승인 상태를 스냅숏에 싣는다.
//
// 지금까지 화면이 받은 것은 frontmatter의 state(draft·proposed)뿐이었다. 그것은 쓴 사람의
// 주장이고 승인은 원장의 사실이라 서로 다른 축인데, 화면에는 앞엣것만 갔다 — 그래서
// 문서를 열어도 승인 여부를 알 수 없었고, "지금 뭐가 승인된 상태냐"는 매번 명령으로
// 물어야 했다. 사람의 병목은 작성이 아니라 검토인데 검토 대상이 보이는 자리가 없었다.
//
// 계산은 여기서 새로 하지 않는다. foldApprovals와 trustState가 이미 답을 갖고 있고,
// 화면이 자기 판정을 지으면 CLI의 doc status와 보드가 같은 문서에 다른 답을 낸다.
//
// 못 읽어도 화면은 선다. 승인 원장은 schemaVersion 6부터라 옛 저장소에는 없고, 없는 것을
// 오류로 만들면 판올림 전 저장소에서 보드가 통째로 서지 않는다 — 그때는 상태를 비워
// 보내고 화면이 "모른다"를 그린다. 모르는 것과 미승인은 다르다.
//
// 다만 못 읽은 이유는 들고 나온다. 삼키면 원장이 깨진 저장소와 원장을 안 쓰는 저장소가
// 화면에서 같아 보이고, 앞엣것은 고쳐야 할 사고인데 아무도 그것을 모른다 —
// projectDiagnostics가 검사 실패를 error로 실어 보내는 것과 같은 자리다.
function documentApprovals(root, projectKey, documents) {
  try {
    const approval = require('./approval');
    if (workspaceLayout(root).schemaVersion < 6) return { states: null, reason: '이 작업공간은 승인 원장을 갖기 전 판입니다.' };
    // 원장 경로와 인가 조립은 approval.js가 소유한다. 여기 있던 사본은 승인만 접고
    // 제출은 접지 않아서, 원장에 제출이 서 있어도 화면은 "제출 기록 없음"이라 답했다 —
    // 사본이 정본과 갈리면 화면만 낡은 규칙으로 돌고, 사람이 믿는 쪽은 화면이다.
    const ledger = approval.documentApprovals(root, { project: projectKey });
    const states = {};
    for (const document of documents) {
      states[document.id] = approval.trustState(document, ledger.approvals.get(document.id), ledger.submissions.get(document.id), ledger.rejections.get(document.id));
    }
    return { states, reason: null, diagnostics: ledger.diagnostics };
  } catch (error) {
    return { states: null, reason: error.message };
  }
}

// 언제부터 검토자의 차례였나. 지금까지 줄에는 시각이 하나도 없어서 화면이 "며칠 기다렸나"를
// 쓸 수 없었고, 그래서 정렬도 식별자 알파벳순이었다 — SCR-002는 대기 시간을 필수 표시로
// 못박고 대기 시간이 긴 순을 정해 두었으므로, 이것은 새 축이 아니라 빠져 있던 자리다.
//
// 기준은 "지금 판이 검토자 앞에 놓인 시각"이다. 검토자가 볼 것은 언제나 지금 파일이고
// 승인도 지금 리비전에 대해 내려지므로, 그 판이 생긴 시각부터가 기다린 시간이다.
//
//   제출이 지금 판으로 서 있으면(pending) 제출 시각을 쓴다. 원장이 기록한 사실이고
//   "차례가 작성자에게서 검토자에게 넘어왔다"를 정확히 가리키는 유일한 값이다.
//
//   그 밖에는 파일이 마지막으로 바뀐 시각이다. 제출 축을 안 쓰는 저장소가 그렇고 —
//   이 저장소에는 제출이 한 건도 없다 — drifted도 여기다. drifted의 제출 시각은 지금
//   파일이 아닌 다른 판의 것이라, 그것을 쓰면 이미 지나간 판을 기다린 시간이 지금 판의
//   것으로 적힌다. 반려는 줄에서 이미 빠졌으므로 이 함수가 볼 일이 없다.
//
//   마지막 승인 시각은 쓰지 않는다. 낡음은 승인 뒤 어느 시점에 바뀐 것인데 그 "어느
//   시점"은 원장에 없고(형상 이력을 문서마다 거슬러야 나오는 값이라 폴링에 실을 수 없다),
//   승인 시각부터 세면 승인 직후 한참 묵혀 두었다가 어제 고친 문서가 "1년 기다림"으로 뜬다.
//
// 못 구하면 null이다. 지어내지 않는다 — 없는 것과 오래된 것은 다르고, 0으로 채우면 값이
// 없는 문서가 줄의 맨 앞에서 가장 급한 것 행세를 한다.
//
// mtime은 참고 값이라는 점을 알고 쓴다. 새로 클론한 저장소에서는 전 문서가 클론 시각을
// 갖는다. 그래도 이 층에서 구할 수 있는 "지금 판이 언제 생겼나"는 이것뿐이고, 값이 거친
// 것과 값이 없는 것은 다르다 — 거친 값은 순서를 주지만 없는 값은 아무것도 주지 않는다.
function waitingSince(document, state) {
  const submission = state.submission;
  if (submission && submission.state === 'pending' && submission.recordedAt) return submission.recordedAt;
  return document.modifiedAt || null;
}

// 검토를 기다리는 문서의 줄. attention과 가르는 이유는 성격이 달라서다 — attention은
// "봐야 할 문제"이고 이것은 "사람이 처리해야 할 줄"이다. 섞으면 승인을 안 쓰는 프로젝트의
// 문서 전건이 문제 목록으로 들어가 진짜 문제를 덮고, 반대로 승인을 쓰는 프로젝트에서는
// 줄의 길이가 문제의 수처럼 읽힌다.
//
// 승인이 밀리는 실질 원인은 "무엇이 내 검토를 기다리는지" 볼 자리가 없는 것이다. 그 사이에
// 승인 안 된 문서 위로 작업이 계속 쌓이고, 상류가 흔들릴 때마다 하류 전체를 다시 탄다.
//
// 줄은 통째로 싣는다. 오래 앞 50건에서 잘랐는데, 절단면이 정렬 축(낡음 먼저 · 그 안에서
// 식별자 순)과 겹쳐 특정 유형이 통째로 사라졌다 — 이 저장소는 미승인이 149건이라 마지막에
// 실리는 것이 REQ 대의 문서였고, SCR·STD·TST로 시작하는 문서는 한 건도 실리지 않았다.
// 검증 문서만 47건이 그렇게 보이지 않았다. 게다가 화면의 거르개는 이미 잘린 50건을 거르므로
// "미승인만"을 눌러도 잘린 뒤는 영영 나타나지 않았다 — 셈은 전건인데 고를 수 있는 것은
// 앞 50건이라, 수를 보고 그 수를 만든 목록으로 갈 수 없었다.
//
// 상한을 올리는 것으로는 이 결함이 없어지지 않는다. 절단면이 어디에 있든 정렬 축과 겹쳐
// 있는 한 같은 일이 더 큰 저장소에서 다시 일어나고, 그때 사라지는 유형이 무엇인지는
// 아무 신호도 내지 않는다. 서버가 거르개를 받는 길도 접었다 — 거르는 것은 화면 안의 값이라
// 스냅숏을 다시 묻지 않는다는 것이 이 화면의 계약인데(SCR-005), 그 계약을 깨면 거를 때마다
// 목록이 잠깐 비고 폴링이 되돌린 값과 겹친다.
//
// 그리고 아낄 것이 없다. 줄 하나는 이미 실린 documents의 부분 사본이고(id·kind·type·
// title·file은 그 문서에 그대로 있다) 그 documents는 본문까지 통째로 실린다 — 이 저장소에서
// 스냅숏 1,072KB 중 documents가 707KB이고 줄 151건은 28KB다. 앞 50건에서 자르며 아낀 것은
// 스냅숏의 1.8%였고, 대신 문서 유형 넷이 화면에서 통째로 사라졌다. 한 번에 몇 줄을 그릴지는
// 화면이 정한다 — 화면이 접으면 거르개는 여전히 전건을 보지만, 서버가 자르면 못 본다.
// 검토 줄 한 칸. 인박스의 줄과 「내 차례」의 줄이 같은 함수에서 나와야 두 화면이 같은
// 문서에 같은 사실을 적는다 — 두 자리에 따로 적으면 칸이 하나 늘 때 한쪽만 늘고, 그때
// 화면 둘은 같은 원장을 보고 다른 말을 한다.
//
// kind를 함께 싣는다. type은 'document'라는 저장 종류라 문서 전건이 같은 값이고, 화면의
// 유형 칩은 kind를 먼저 본다(documentTypeLabel). 빼면 유형 칩이 전부 'document'로 떨어져
// 무엇이 밀렸는지가 유형별로 읽히지 않는다.
//
// owner는 MEMBER-ID다. 파일에 적힌 위키링크가 아니라 board-data가 갈라 둔 식별자를 싣는
// 이유는 이 칸이 표시가 아니라 판정 축이기 때문이다 — 「내가 고칠 것」이 이 값으로 갈린다.
//
// submission은 통째로 싣지 않고 이 줄이 쓰는 칸만 옮긴다. 원장의 제출 객체에는 리비전과
// 클라이언트 식별자까지 들어 있는데, 그것은 이 줄이 답하는 물음("누가 언제 넘겼나")이
// 아니라 승인 판이 답하는 물음이다.
function reviewSubmission(submission) {
  const rejection = (submission && submission.rejection) || null;
  return {
    state: (submission && submission.state) || 'none',
    submittedBy: (submission && submission.submittedBy) || null,
    submittedAt: (submission && submission.recordedAt) || null,
    rejectedBy: rejection ? rejection.rejectedBy || null : null,
    rejectedAt: rejection ? rejection.recordedAt || null : null,
    rejectedReason: rejection ? rejection.reason || null : null
  };
}

function reviewRow(document, state) {
  return {
    status: state.status, id: document.id, kind: document.kind || null, type: document.type, title: document.title,
    file: document.file, owner: document.ownerMember || null,
    approvedBy: state.approvedBy || null, approvals: state.approvals,
    submission: reviewSubmission(state.submission),
    waitingSince: waitingSince(document, state)
  };
}

// 낡음이 먼저다. 승인된 것이 흔들린 상태라 하류가 이미 그것을 근거로 삼았고, 미승인은 아직
// 아무도 근거로 삼지 않았다. 대기 시간은 이 축을 뒤집지 않고 그 안에서만 적용한다 —
// 뒤집으면 어제 흔들린 승인본이 반년 묵은 초안 뒤로 밀리는데, 앞엣것은 이미 하류가 근거로
// 쓰고 있어 미룰수록 다시 타야 할 것이 늘어난다.
//
// 같은 갈래 안에서는 오래 기다린 것이 먼저다. 예전에는 식별자 오름차순이었는데 그것은
// 순서가 아니라 이름이라, 줄의 앞에 선 것이 "먼저 볼 것"이 아니라 "A로 시작하는 것"이었다.
// SCR-002가 대기 시간이 긴 순을 정해 둔 자리이기도 하다.
//
// 대기 시각을 못 구한 줄은 맨 뒤다. 없는 값을 0(=가장 오래)으로 읽으면 모르는 문서가 줄의
// 맨 앞에 서서 가장 급한 것 행세를 한다 — 없는 것과 오래된 것은 다르다. 시각까지 같으면
// 식별자로 가른다. 폴링마다 순서가 흔들리면 사람이 훑던 자리를 잃는다.
function byReviewUrgency(left, right) {
  if (left.status !== right.status) return left.status === 'stale' ? -1 : 1;
  if (Boolean(left.waitingSince) !== Boolean(right.waitingSince)) return left.waitingSince ? -1 : 1;
  return (left.waitingSince ? left.waitingSince.localeCompare(right.waitingSince) : 0) || left.id.localeCompare(right.id);
}

function reviewQueue(documents, approvals) {
  if (!approvals.states) return { used: false, unknown: approvals.reason, counts: null, total: 0, rejected: 0, items: [], rejectedItems: [] };
  const counts = { approved: 0, stale: 0, unapproved: 0 };
  const items = [];
  // 반려한 문서는 이 줄에서 뺀다. 반려는 「내 차례」를 「작성자 차례」로 옮기는
  // 행위인데, 뺀 뒤에도 줄에 남아 있으면 검토자는 자기가 이미 답한 것을 매번 다시
  // 지나쳐야 하고 그러면 인박스의 길이가 남은 일의 양을 말하지 못한다.
  //
  // 다만 몇 건을 뺐는지는 값으로 낸다. 조용히 사라지면 반려한 문서는 어느 화면에도
  // 서지 않게 되고, 그것은 승인 옆에 반려가 없던 때와 같은 자리다 — 판단이 어디에도
  // 안 보이는 자리. 셈은 신뢰 상태 셋과 별개 축이라 counts에 섞지 않는다.
  const rejected = [];
  for (const document of documents) {
    const state = approvals.states[document.id];
    if (!state) continue;
    counts[state.status] = (counts[state.status] || 0) + 1;
    if (state.status === 'approved') continue;
    const row = reviewRow(document, state);
    // 반려한 줄도 값으로는 만든다. 예전에는 수만 세고 버렸는데, 그러면 "차례가 작성자에게
    // 넘어갔다"는 사실이 셈 하나로만 남아 그 작성자에게 무엇이 넘어왔는지 아무 화면도
    // 말할 수 없다 — 「내가 고칠 것」이 서는 자리가 여기다. 셈은 이 줄에서 파생시킨다.
    // 따로 세면 언젠가 둘이 갈리고, 갈렸다는 사실은 아무 신호도 내지 않는다.
    if (state.submission && state.submission.state === 'rejected') { rejected.push(row); continue; }
    items.push(row);
  }
  items.sort(byReviewUrgency);
  // 반려 줄도 같은 자로 정렬한다. 다른 자로 재면 같은 문서가 화면 둘에서 다른 순서로 서고,
  // 그때 "먼저 볼 것"이라는 말은 어느 쪽에서도 근거를 잃는다.
  rejected.sort(byReviewUrgency);
  // 이 프로젝트가 승인 축을 쓰는가. 한 번도 승인하지 않은 프로젝트에서 전 문서가 미승인인
  // 것은 상태가 아니라 그 축을 안 쓴다는 뜻이고, 그것을 검토 대기로 읽으면 인박스가 첫날부터
  // 문서 전건으로 찬다. 판단은 화면이 하되 근거는 여기서 준다.
  //
  // 반려도 그 축을 쓴다는 증거다. 승인 한 번 없이 반려만 한 프로젝트는 관문을 안 쓰는
  // 것이 아니라 아직 아무것도 통과시키지 않은 것이고, 그때 화면이 "쓰지 않습니다"라고
  // 말하면 방금 내린 판단이 화면에서 사라진다.
  return { used: counts.approved + counts.stale > 0 || rejected.length > 0, unknown: null, counts, total: items.length, rejected: rejected.length, items, rejectedItems: rejected };
}

// ── 문서의 「내 차례」 ───────────────────────────────────────────────────────
//
// 태스크는 오래전부터 사람 축으로 좁혀졌다(owner·reviewers). 문서에는 그 칸이 없어서
// 검토 인박스는 프로젝트 전체를 셌고, 그래서 이 저장소에서 인박스를 열면 159건이 한
// 벽으로 선다 — 그중 지금 이 사람이 손댈 것이 무엇인지는 아무 데도 적혀 있지 않다.
// 사람의 병목이 작성이 아니라 검토인데, 검토할 사람 앞에 놓인 것이 남의 줄과 섞여 있다.
//
// 문서에 reviewers 칸을 새로 파지 않는다. 그 칸은 사람이 또 적어야 하는 값이고, 적지
// 않은 문서는 아무의 줄에도 서지 않게 되어 지금과 같은 자리로 돌아온다. 대신 이미
// 원장에 있는 사실 셋으로 가른다 — 누가 승인 자격자인가, 누가 소유자인가, 누가
// 승인했는가. 셋 다 저장된 사실이라 새로 적을 것이 없다.
//
// 갈래가 셋인 이유는 시키는 행동이 셋이기 때문이다. 한 줄로 합치면 "읽고 승인하라"와
// "고쳐서 다시 올리라"가 같은 목록에 서고, 그 목록은 무엇을 하라는 것인지 말하지 못한다.
//
// 순서는 되돌리는 비용이 큰 것부터다 — document-analysis의 nextPipelineStep과
// reviewQueue의 정렬이 이미 그은 선이고, 여기서도 같은 선을 긋는다.
//
//   나를 기다리는 것   남이 나에게 넘기고 멈춰 서 있다. 원장에 제출로 기록된 사실이라
//                      "차례가 넘어왔다"가 추측이 아니고, 지금 멈춰 있는 것은 사람이다.
//   내 승인이 쓰인 것   내 판단이 이미 하류에 소비됐는데 그 판단이 가리키던 판이 아니다.
//                      아무도 멈춰 있지 않지만 하류는 더 이상 참이 아닌 것 위에서 돈다 —
//                      낡음이 미승인보다 먼저인 것과 같은 이유이고, 미룰수록 다시 타야
//                      할 것이 는다.
//   내가 고칠 것        차례가 나에게 돌아온 내 문서다. 반려는 아직 아무도 근거로 삼지
//                      않았고, 낡음이라도 재승인은 남의 몫이라 여기서는 마지막이다.
//
// 한 문서는 한 사람에게 한 갈래에만 선다. 두 갈래에 세우면 셈이 실제 일의 양보다 크게
// 나오고, 그 사람은 같은 문서를 두 번 지나친다 — 이 저장소가 그 경우다. ADR-020·021은
// MEMBER-001이 소유자이면서 승인자라 「내 승인이 쓰인 것」과 「내가 고칠 것」 양쪽에
// 걸리는데, 낡음에서 다음에 눌러야 할 단추는 재승인이므로 앞엣것이 가져간다. 뒤엣
// 사실은 사라지지 않고 줄 안의 컨텍스트로 남는다(소유자도 나라는 것).
//
// 갈래 목록을 여기서 값으로 내는 이유는 화면이 그 목록을 적으면 안 되기 때문이다.
// 화면은 브라우저에서 돌아 require를 쓸 수 없고, 적어 둔 목록은 갈래가 늘 때 한쪽만
// 는다 — approvalCatalog·itemTypeCatalog가 같은 자리에서 같은 이유로 실린다.
const DOCUMENT_TURN_LANES = Object.freeze([
  Object.freeze({
    key: 'awaiting',
    label: '나를 기다리는 것',
    hint: '내가 이 프로젝트의 문서 승인자이고, 올라온 판이 아직 답을 못 받았습니다. 읽고 승인하거나 반려하면 올린 사람이 다시 움직입니다.',
    empty: '나에게 올라와 답을 기다리는 문서가 없습니다.',
    // 자격이 없는 사람에게 0건은 거짓이다. "볼 것이 없다"와 "이 프로젝트에서 승인할 수
    // 없다"는 다른 사실이고, 앞엣것으로 그리면 자격이 없다는 것을 영영 모른 채 기다린다.
    requiresApprover: true
  }),
  Object.freeze({
    key: 'restake',
    label: '내 승인이 쓰인 것',
    hint: '내가 승인한 뒤 본문이 바뀌었습니다. 하류는 아직 내 승인을 근거로 삼고 있으므로, 무엇이 바뀌었는지 보고 다시 승인할지 정해야 합니다.',
    empty: '내가 승인한 문서 중 그 뒤에 바뀐 것이 없습니다.',
    requiresApprover: false
  }),
  Object.freeze({
    key: 'fix',
    label: '내가 고칠 것',
    hint: '내가 소유자인데 반려됐거나 승인 뒤 바뀐 문서입니다. 차례가 나에게 돌아와 있습니다.',
    empty: '내 차례로 돌아온 내 문서가 없습니다.',
    requiresApprover: false
  })
]);

// 이 줄이 이 사람의 어느 갈래인가. 위에서부터 처음 걸리는 하나가 답이고, 그 순서가 곧
// 우선순위다 — 갈래를 고르는 규칙이 한 자리에 있어야 화면이 자기 규칙을 짓지 않는다.
function turnLaneOf(row, member, approving) {
  const submission = row.submission.state;
  if (approving.has(member) && (submission === 'pending' || submission === 'drifted')) return 'awaiting';
  if (row.status === 'stale' && row.approvedBy === member) return 'restake';
  if (row.owner === member && (submission === 'rejected' || row.status === 'stale')) return 'fix';
  return null;
}

/**
 * 사람마다의 「내 차례」. 줄은 한 번만 싣고 사람별 갈래를 그 줄에 붙인다.
 *
 * 사람마다 줄을 복제하지 않는 이유는 승인자가 여럿인 저장소에서 같은 문서가 사람 수만큼
 * 스냅숏에 실리기 때문이다. 폴링마다 오가는 값이라 그 곱은 그대로 대역폭이 된다.
 *
 * 화면이 아니라 여기서 가르는 이유는 이것이 표시가 아니라 판정이어서다. 자격(승인자인가)과
 * 명의(내가 승인했는가)가 들어가는 판정이고, 화면이 그것을 지으면 자격 판정의 표면이 하나
 * 더 생기는데 그 표면은 아무도 시험하지 않는다 — approvers를 화면이 직접 만들지 않는 것과
 * 같은 선이다. 화면은 state.currentMember로 자기 줄을 고르기만 한다.
 *
 * 사람 후보는 이 줄에 실제로 이름이 걸린 사람뿐이다(승인 자격자 · 소유자 · 승인자).
 * 그 밖의 멤버는 어느 갈래에도 걸릴 수 없으므로 도는 것이 낭비이고, 넣으면 빈 칸만 는다.
 *
 * used와 unknown은 reviewQueue의 것을 그대로 물려받는다. 여기서 다시 판정하면 인박스가
 * "승인 축을 안 씁니다"라고 말하는 프로젝트에서 이 화면만 줄을 세우게 된다.
 */
function documentTurns(queue, approvers) {
  const lanes = DOCUMENT_TURN_LANES;
  // 승인 자격은 이미 조립된 목록에서 온다. 여기서 clients와 members를 다시 뒤지면 그것이
  // 자격 판정의 또 다른 표면이 되고, 두 표면은 언젠가 갈린다.
  const approverMembers = Array.from(new Set((approvers || []).map((item) => item.owner).filter(Boolean))).sort();
  const approving = new Set(approverMembers);
  if (!queue.counts) return { used: false, unknown: queue.unknown, lanes, approverMembers, rows: [] };
  const rows = [];
  for (const row of queue.items.concat(queue.rejectedItems)) {
    const candidates = new Set(approverMembers);
    if (row.owner) candidates.add(row.owner);
    if (row.approvedBy) candidates.add(row.approvedBy);
    const laneOf = {};
    for (const member of candidates) {
      const lane = turnLaneOf(row, member, approving);
      if (lane) laneOf[member] = lane;
    }
    // 아무의 갈래에도 안 서는 줄은 싣지 않는다. 이 저장소에서는 미승인 157건이 그렇고,
    // 그것을 다 실으면 「내 차례」가 다시 프로젝트 전체가 된다 — 좁히려고 만든 값이
    // 좁히지 못하면 화면 둘이 같은 벽을 두 번 세운다.
    if (Object.keys(laneOf).length) rows.push(Object.assign({}, row, { lanes: laneOf }));
  }
  // 인박스와 같은 자로 다시 한 번 정렬한다. 위에서 반려 줄을 뒤에 이어 붙였으므로 그대로
  // 두면 순서가 "어느 배열에서 왔나"가 되는데, 그것은 급한 순이 아니다.
  rows.sort(byReviewUrgency);
  return { used: queue.used, unknown: null, lanes, approverMembers, rows };
}

function attentionItems(tasks, documents, sync, approvals) {
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
  // 검토를 기다리는 문서도 봐야 할 것이다. 승인이 밀리는 실질 원인은 사람이 게을러서가
  // 아니라 "무엇이 내 검토를 기다리는지" 볼 자리가 없어서이고, 그 사이에 승인 안 된
  // 문서 위로 작업이 계속 쌓인다.
  //
  // 심각도는 둘을 가른다. 낡음은 승인된 것이 흔들린 상태라 이미 그 문서를 근거로 삼은
  // 하류가 있고, 미승인은 아직 아무도 그것을 근거로 삼지 않았다 — 앞엣것이 먼저다.
  // 낡음만 여기 든다. 승인된 것이 흔들렸다는 뜻이라 그 자체가 사건이고, 이미 그 문서를
  // 근거로 삼은 하류가 있다. 아직 승인되지 않은 문서는 문제가 아니라 줄이므로 이 목록에
  // 넣지 않는다 — 넣으면 승인 축을 안 쓰는 프로젝트에서 문서 전건이 여기로 쏟아져
  // 진짜 문제를 덮는다. 그 줄은 reviewQueue가 따로 든다.
  for (const document of approvals.states ? documents : []) {
    const state = approvals.states[document.id];
    if (!state || state.status !== 'stale') continue;
    items.push({ severity: 'warning', kind: 'document', id: document.id, title: document.title, reason: '승인 후 개정 — 재승인 필요' });
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
  // 승인 상태는 문서 옆에 붙어야 한다. 따로 부르는 값으로 두면 화면이 목록을 그린 뒤
  // 상태를 다시 물어야 하고, 그 사이에 목록과 상태가 서로 다른 시점을 가리킨다.
  const approvals = documentApprovals(root, project.key, documents);
  for (const document of documents) document.approval = approvals.states ? approvals.states[document.id] : null;
  const queue = reviewQueue(documents, approvals);
  const collaboration = readCollaboration(root, project.key);
  const sync = syncStatus(project);
  const clients = layout.schemaVersion >= 6 ? listClients(root).clients : [];
  // 승인 자격자는 한 번만 조립한다. approvers와 documentTurns가 같은 목록을 봐야
  // "이 사람이 승인자인가"에 두 값이 다른 답을 내지 않는다.
  const approverList = humanApproversFrom(clients, collaboration.members);
  const contract = loadDocumentContract(root, project.key);
  const presentation = loadBoardPresentation(root, project.key);
  // 댓글은 태스크와 다른 원장에 산다. 스냅숏에 함께 실어야 화면이 두 번 묻지 않고,
  // 영역 revision을 따로 두어야 댓글만 늘었을 때 태스크 목록을 다시 그리지 않는다.
  const comments = listComments(root, { project: project.key }).comments;
  const workspaceRevision = boardRevision(config);
  return {
    project: project.key,
    // 자산이 사는 자리. `![[이름]]`이 가리키는 곳을 화면이 알아야 그림을 주소로
    // 옮길 수 있고, 그 자리는 프로젝트 매니페스트가 정한다 — 화면이 `docs/assets`를
    // 사본으로 적으면 문서 뿌리를 옮긴 날 그림만 조용히 깨진다.
    assets: { directory: path.relative(project.root, assetsDirectory(layout, project)).split(path.sep).join('/') },
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
    attention: attentionItems(tasksResult.tasks, documents, sync, approvals),
    // 사람-에이전트 협업에서 사람의 병목은 작성이 아니라 검토다. 그 줄이 값으로 실려야
    // 화면이 그것을 첫 자리에 그릴 수 있다.
    reviewQueue: queue,
    // 같은 줄을 사람 축으로 좁힌 값. reviewQueue가 만든 줄을 그대로 받으므로 두 화면의
    // 수가 갈릴 수 없다 — 다시 세면 홈과 인박스와 이 화면이 같은 문서를 두고 서로 다른
    // 수를 말하는 날이 온다.
    documentTurns: documentTurns(queue, approverList),
    people: collaboration,
    clients,
    sync,
    contract,
    presentation,
    // 모드 표는 코드가 갖고 화면은 그것을 그린다. 화면이 표를 다시 적으면 코드가
    // 바뀌는 날 둘이 갈라지고, 사용자는 화면을 믿는다.
    approvalCatalog: { modes: APPROVAL_MODES, defaultMode: DEFAULT_PROJECT_MODE, defaultFloor: DEFAULT_WORKSPACE_FLOOR, basisKinds: BASIS_KINDS },
    // 승인 자격자. 화면이 clients와 people로 이 목록을 직접 만들면 그것이 자격 판정의
    // 네 번째 표면이 되고, 화면의 판정은 아무도 시험하지 않는다. 값은 이미 읽어 둔
    // 둘에서 고르므로 스냅숏이 파일을 더 읽지 않는다.
    approvers: approverList,
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
//
// 이름이 runApprovers가 아닌 이유는 부르는 쪽이 둘이 되었기 때문이다. 문서 승인도
// 같은 자격을 쓰므로 이름이 런을 가리키면 그 이름은 절반만 맞고, 절반만 맞는 이름은
// 다음 사람에게 "문서용 목록을 따로 만들라"고 시킨다. 목록을 고르는 조건 자체는
// collaboration-store가 소유한다.
function projectApprovers(root, project) {
  return projectHumanApprovers(root, project.key);
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
    approvers: projectApprovers(root, project)
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
    approvers: projectApprovers(root, project)
  };
}
// 사람 게이트를 웹에서 지나는 자리. 자격 판정은 rdl run approve와 같은 함수가 한다 —
// 표면마다 판정을 따로 두면 그중 느슨한 쪽이 게이트의 실제 높이가 된다.
function approveBoardRun(root, projectKey, runId, body) {
  // human 자격을 하네스가 들 수 없다는 것이 사람 게이트의 전부다. 하네스가 띄운
  // Board는 그 자격을 HTTP로 빌려주는 창구가 되므로 승인만 거절한다. 조회는 그대로
  // 둔다 — 무엇이 막혀 있는지는 하네스도 알아야 사람에게 가져갈 수 있다.
  refuseHarnessApproval();
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

// 하네스가 띄운 Board는 human 자격을 HTTP로 빌려주는 창구가 된다. 런 승인이 그것을
// 거절하는 이유가 문서 승인에도 그대로 있다 — 오히려 여기가 더 곧다: 정본 문서를
// AI가 스스로 정본으로 만드는 경로가 열리는 자리이기 때문이다. 조회는 막지 않는다.
function refuseHarnessApproval() {
  if (process.env.RUNDOL_HARNESS_CHILD !== '1') return;
  // 승인도 반려도 같은 문장으로 거절한다. 둘 다 사람 게이트를 지나는 판단이고,
  // 하네스가 들 수 없는 자격은 어느 쪽이든 같다.
  const error = new Error('하네스가 실행한 Board에서는 사람 게이트를 지날 수 없습니다(승인·반려). 사람이 직접 연 Board나 명령줄에서 판단하세요.');
  error.statusCode = 403;
  error.code = 'harness-board';
  throw error;
}

/**
 * 화면에서 정본 문서를 승인하는 자리.
 *
 * 근거(basis)는 화면에서도 필수다. 나중에 "AI 검토가 놓쳤나 사람이 건너뛰었나"를
 * 가르려면 그 값이 있어야 하고, 그 구분이 없으면 승인 이력은 "누가 눌렀다"의 목록에
 * 그친다. 사유(reason)는 명령줄에서는 선택이지만 화면에서는 받는다 — 목록을 훑다가
 * 누르는 자리라 사유를 안 받으면 훑기와 판단이 같은 동작이 되고, 승인은 "읽었다"가
 * 아니라 "내가 책임진다"의 선언이라야 한다(approval.js 머리말).
 *
 * 자격 판정은 approveDocument가 한다. 여기서 다시 하면 표면이 하나 더 생기고, 그중
 * 느슨한 쪽이 게이트의 실제 높이가 된다.
 */
function approveBoardDocument(root, projectKey, documentId, body) {
  refuseHarnessApproval();
  const approver = String((body && body.clientId) || '').trim().toLowerCase();
  if (!approver) inputError('승인자 Client를 고르세요. 활성 human Client만 사람 게이트를 지날 수 있습니다.', 'missing-approver');
  const approvedBy = String((body && body.approvedBy) || '').trim().toUpperCase();
  const reason = String((body && body.reason) || '').trim();
  if (!reason) inputError('무엇을 보고 승인했는지 사유가 필요합니다.', 'missing-reason');
  // 근거는 문자열 하나로도, {kind, detail} 객체로도 온다. 화면이 상세를 안 받는 판이
  // 있어서인데, 두 모양을 받는 곳을 여기 하나로 두면 approval.js의 검증은 한 모양만 안다.
  const basis = (Array.isArray(body && body.basis) ? body.basis : [])
    .map((item) => (typeof item === 'string' ? { kind: item } : item))
    .filter((item) => item && typeof item === 'object' && item.kind)
    .map((item) => (String(item.detail || '').trim() ? { kind: item.kind, detail: String(item.detail).trim() } : { kind: item.kind }));
  if (!basis.length) inputError('무엇에 기대어 승인하는지 근거가 하나 이상 필요합니다.', 'missing-basis');
  try {
    return require('./approval').approveDocument(root, {
      project: projectKey, targetId: documentId, clientId: approver,
      // 명의를 안 보내면 그 Client의 소유자다. 화면이 남의 이름을 고를 수 있게 하면
      // 위임 없는 대리 승인이 열리므로, 고르는 칸을 두지 않고 서버도 기본값을 지어내지 않는다.
      approvedBy: approvedBy || approverOwner(root, approver),
      basis, reason,
      delegationId: (body && body.delegationId) || undefined
    });
  } catch (error) {
    // 승인 거절은 서버 결함이 아니라 "이 요청은 지금 받아들여질 수 없다"는 답이다.
    // 500으로 내보내면 화면은 "서버가 죽었다"로 읽고, 사람 게이트에 걸린 것인지
    // 근거가 모자란 것인지 구분하지 못한 채 같은 단추를 다시 누른다.
    if (!error.statusCode) { error.statusCode = 400; error.code = error.code || 'approval-refused'; }
    throw error;
  }
}

/**
 * 화면에서 정본 문서를 반려하는 자리.
 *
 * 승인 옆에 이것이 없어서 검토자가 "아니오"를 말할 자리가 화면에 없었고, 그래서 그
 * 판단은 댓글이나 태스크로 샜다 — 새는 순간 원장 밖의 말이 되어 상태를 만들지 못한다.
 *
 * 근거(basis)는 받지 않는다. 근거는 "무엇에 기대어 책임을 졌나"를 나중에 가르려는
 * 값인데 반려는 책임을 지는 행위가 아니고, 칸을 열어 두면 approval.js의 반려 이벤트가
 * 모르는 필드를 화면만 보내게 된다. 대신 사유가 필수다 — 반려는 사유가 내용 전부다.
 *
 * 자격 판정은 rejectDocument가 한다. 여기서 다시 하면 표면이 하나 더 생기고, 그중
 * 느슨한 쪽이 게이트의 실제 높이가 된다.
 */
/**
 * 수명 축은 승인 옆에 서지만 같은 관문을 지나지 않는다.
 *
 * `refuseHarnessApproval`을 부르지 않는 이유가 그것이다. 그 거절은 **사람 게이트**를
 * 지키는 자리이고(승인·반려), 수명은 그 게이트에 걸린 축이 아니다 — 판정 하나 읽지 않는
 * 칸에 하네스 거절을 걸면 거절 문장이 "사람 게이트"라고 말하는데 실제로는 아무 게이트도
 * 없는 상태가 된다. 판정과 그 근거는 document.js의 setDocumentLifecycle 한 곳에 있다.
 *
 * 빈 값은 지우기다. 화면의 고르개가 「수명 없음」을 첫 항목으로 두므로 그것이 그대로
 * 지우는 갈래가 된다 — 지우는 손잡이를 따로 두면 고르개와 손잡이가 서로 다른 축이 되고,
 * 사람은 「수명 없음」을 골라 놓고 왜 안 지워지는지 묻게 된다.
 */
function setBoardDocumentLifecycle(root, projectKey, documentId, body) {
  const raw = body && body.lifecycle;
  const clearing = raw === null || raw === undefined || String(raw).trim() === '';
  try {
    return require('./document').setDocumentLifecycle(root, {
      project: projectKey, targetId: documentId,
      lifecycle: clearing ? undefined : String(raw).trim(),
      clear: clearing,
      reason: (body && body.reason) || '',
      // 화면이 판에 그린 경고를 사람이 보고 눌렀다는 표시다. 서버가 기본값으로 참을
      // 지어내면 그 경고는 그리기만 하고 아무것도 막지 않는 장식이 된다.
      ackStale: Boolean(body && body.ackStale)
    });
  } catch (error) {
    // 거절은 서버 결함이 아니라 "이 요청은 지금 받아들여질 수 없다"는 답이다. 승인이
    // 같은 판단을 하는 자리와 같은 모양으로 내보낸다.
    if (!error.statusCode) { error.statusCode = 400; error.code = error.code || 'lifecycle-refused'; }
    throw error;
  }
}

function rejectBoardDocument(root, projectKey, documentId, body) {
  refuseHarnessApproval();
  const reviewer = String((body && body.clientId) || '').trim().toLowerCase();
  if (!reviewer) inputError('반려자 Client를 고르세요. 활성 human Client만 사람 게이트를 지날 수 있습니다.', 'missing-approver');
  const reason = String((body && body.reason) || '').trim();
  if (!reason) inputError('왜 아닌지 사유가 필요합니다. 사유 없는 반려는 작성자에게 침묵과 같습니다.', 'missing-reason');
  try {
    return require('./approval').rejectDocument(root, {
      project: projectKey, targetId: documentId, clientId: reviewer,
      // 명의는 그 Client의 소유자다. 반려에는 위임이 설 자리가 없으므로 화면이 남의
      // 이름을 고를 길도 두지 않는다.
      rejectedBy: String((body && body.rejectedBy) || '').trim().toUpperCase() || approverOwner(root, reviewer),
      reason
    });
  } catch (error) {
    // 반려 거절도 서버 결함이 아니다. 500으로 내면 화면은 "서버가 죽었다"로 읽고,
    // 사람 게이트에 걸린 것인지 이미 승인된 판이라 반려할 수 없는 것인지 구분하지 못한다.
    if (!error.statusCode) { error.statusCode = 400; error.code = error.code || 'rejection-refused'; }
    throw error;
  }
}

// 승인 명의는 고를 여지가 없다 — 위임이 아니면 언제나 그 Client의 소유자다. 화면이
// 이 값을 보내지 않아도 되도록 서버가 registry에서 읽는다. 없는 Client는 여기서
// 지어내지 않고 그대로 넘겨 approveDocument가 자기 말로 거절하게 둔다.
function approverOwner(root, clientId) {
  try { return listClients(root).clients.find((client) => client.id === clientId).owner; } catch (_) { return undefined; }
}

/**
 * 문서 이력. 원장의 사건(승인·제출·반려)과 git의 커밋을 한 답에 담는다.
 *
 * 스냅숏에 싣지 않는다. 문서마다 git log --follow를 돌고 연결 태스크까지 훑는 값이라
 * 폴링마다 계산하면 문서 수에 비례해 보드가 선다 — 차분이 요청할 때만 계산하는
 * 자리인 것과 같은 이유이고, 같은 관례를 따른다.
 *
 * 접는 일 자체는 approval.js의 documentHistory가 한다. 여기서 다시 접으면 원장을 두 번
 * 읽는 자리가 생기고, 두 읽기는 서로 다른 시점을 볼 수 있다 — 그때 화면이 말하는
 * "언제부터 이렇게 됐나"는 명령줄의 답과 갈린다.
 */
/**
 * 원장 사건과 커밋을 한 시간축에 세운다.
 *
 * 따로 세우면 사람이 머리로 합쳐야 하고, 그 합치기는 두 목록의 시각을 눈으로 번갈아 훑는
 * 일이라 줄이 늘면 곧 실패한다 — 실패하면 "승인 뒤에 저 커밋이 왔나 앞에 왔나"를 알 수
 * 없고, 이력을 여는 이유가 바로 그 물음이라 거기서 값이 통째로 사라진다.
 *
 * 접는 자리는 여기 하나다. 두 목록을 받은 쪽이 각자 순서를 지으면 그 순서는 화면 수만큼
 * 생기고, 그중 하나만 시간대를 틀려도 같은 이력이 자리마다 다르게 읽힌다 — 실제로 그
 * 갈래가 ADR-020·ADR-021을 아홉 시간 어긋난 자리에 세웠다.
 *
 * 순서의 규칙 셋을 여기서 못박는다.
 *
 *   1. 순간으로 견준다. 문자열이 아니다. 원장은 UTC(Z)를 쓰고 git은 오프셋을 달고 오므로
 *      문자열 비교는 표기가 다른 같은 순간을 다른 자리에 놓는다.
 *   2. 시각을 못 읽는 줄은 맨 뒤로 보낸다. 맨 앞은 "가장 최근에 일어난 일"이라는 자리인데
 *      읽을 수 없는 시각으로는 그 주장을 뒷받침할 수 없고, 던지면 줄 하나 때문에 이력
 *      전체가 사라진다. 뒤는 "여기 있으나 시간축에 세울 수 없다"를 그대로 말하는 자리다.
 *   3. 같은 순간이면 원장이 위다. 원장 사건은 자기가 판정한 리비전을 말하고 그 리비전은
 *      커밋된 뒤에야 지목할 수 있으므로, 커밋이 원인이고 원장이 결과다 — 최근이 위인
 *      목록에서 결과는 원인 위에 온다. git의 커밋 시각은 초 단위이고 원장은 밀리초까지
 *      적으므로 이 동률은 실제로 생긴다.
 *
 * 그래도 갈리지 않으면 들어온 차례를 지킨다. 안정 정렬이라야 같은 이력이 요청마다 같은
 * 목록으로 온다 — 흔들리면 사람은 자기가 방금 본 줄을 다시 찾지 못한다.
 *
 * 원장 줄은 누가·왜를 알고(승인자·사유·근거) 커밋 줄은 무엇이·언제를 안다. 둘을 나란히
 * 두는 것이 이 목록의 값이므로 종류를 지우지 않고 kind로 갈라 둔다. 지목할 주소도 종류마다
 * 달라서(원장은 리비전, git은 커밋 해시) pointKind를 함께 싣는다. who도 종류마다 다르다 —
 * 원장은 MEMBER-ID이고 커밋은 git이 아는 이름이라, 이름을 찾아 주는 자리는 kind를 보고
 * 갈라야 한다.
 */
function documentTimeline(history) {
  const rows = [];
  for (const item of (history && history.approvals) || []) {
    rows.push({ kind: 'approval', at: item.recordedAt, who: item.approvedBy, point: item.reviewedRevision, pointKind: 'revision', detail: item.reason || '', basis: item.basis || [] });
  }
  for (const item of (history && history.submissions) || []) {
    rows.push({ kind: 'submission', at: item.recordedAt, who: item.submittedBy, point: item.submittedRevision, pointKind: 'revision', detail: item.reason || '', basis: [] });
  }
  for (const item of (history && history.rejections) || []) {
    rows.push({ kind: 'rejection', at: item.recordedAt, who: item.rejectedBy, point: item.rejectedRevision, pointKind: 'revision', detail: item.reason || '', basis: [] });
  }
  for (const item of (history && history.commits) || []) {
    rows.push({ kind: 'commit', at: item.at, who: item.author || '', point: item.commit, pointKind: 'commit', detail: item.subject || '', basis: [] });
  }
  return rows
    .map((row, index) => ({ row, index, instant: Date.parse(row.at || ''), ledger: row.kind !== 'commit' }))
    .sort((left, right) => {
      const leftUnplaceable = Number.isNaN(left.instant);
      const rightUnplaceable = Number.isNaN(right.instant);
      if (leftUnplaceable !== rightUnplaceable) return leftUnplaceable ? 1 : -1;
      if (!leftUnplaceable && left.instant !== right.instant) return right.instant - left.instant;
      if (left.ledger !== right.ledger) return left.ledger ? -1 : 1;
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

// 정책 층 저장이 결정을 만나는 자리. 두 표면(board.json · workflows.json)이 같은
// 게이트를 지나므로 이 흐름도 한 자리에 둔다 — 표면마다 다시 적으면 한쪽만 고쳐지는
// 날이 오고, 그때 결정 없이 정책이 바뀌는 구멍이 하나 생긴다.
//
// null을 돌려주면 그대로 저장해도 된다는 뜻이다. 값이 있으면 저장하지 않고 그 값을
// 화면에 올린다 — SCR-003의 6단계가 "사유를 적을 자리가 없으므로 결정 화면으로
// 넘어간다"고 적은 그 자리다.
// 화면이 고치는 것은 병합 결과가 아니라 그 층의 원본이다. 병합 결과는 정규화를
// 거쳐 나오므로(executionUnits가 units가 된다) 그것을 그대로 돌려보내면 저장이
// "알 수 없는 키"로 거절한다 — 화면이 자기가 방금 받은 값을 못 되돌려주는 상태다.
//
// 그래서 층별 원본을 함께 싣는다. 표시 설정이 sources와 inheritance를 함께 내는 것과
// 같은 이유이고, baseRevision도 병합 결과가 아니라 그 원본들에 건다 — 겨루는 대상이
// 파일이므로 값도 파일의 것이라야 남이 먼저 고친 것을 정확히 잡는다.
function boardWorkflows(root, projectKey) {
  const loaded = loadWorkflows(root, projectKey);
  const layers = (loaded.sources || []).map((source) => ({
    scope: source.scope, file: source.file, content: readWorkflowLayer(source.file)
  }));
  return Object.assign({}, loaded, { layers, baseRevision: entityRevision(layers) });
}

// 저장 계획은 보내온 내용을 검증하는 일이라, 여기서 나는 오류는 전부 그 내용의
// 문제다. 분류하지 않으면 "알 수 없는 키입니다" 같은 사람이 고칠 수 있는 말이
// 500으로 나가고, 화면은 그것을 서버 장애로 그린다.
function planOrReject(compute) {
  try {
    return compute();
  } catch (error) {
    if (!error.statusCode) error.statusCode = 400;
    throw error;
  }
}

function policyDecisionGate(root, projectKey, scope, plan, body) {
  if (!plan.required) return null;
  // 사람이 답한 결정을 들고 왔으면 여기서 판정하지 않는다. 그 결박은 게이트가 갖고,
  // 여기서 한 번 더 보면 "결정 ID가 있는가"만 보는 두 번째 문이 생긴다.
  if (body && body.decisionId) return null;
  const project = selectProject(workspaceLayout(root), projectKey, true);
  const identity = boardClient(root, project, listClients(root).clients);
  if (!identity.id) inputError('이 기기의 Client ID가 없습니다. rdl git init으로 프로젝트를 준비하세요.');
  if (!identity.registered) inputError(`등록되지 않은 Client입니다: ${identity.id}. 설정 → Clients에서 이 기기를 등록하세요.`, 'unknown-client');
  const opened = requestPolicyDecision(root, {
    project: projectKey, surface: plan.surface, scope,
    previous: plan.previous, next: plan.next, clientId: identity.id
  });
  // 위임으로 이미 답이 나 있으면 결정 화면을 거칠 이유가 없다. 그 판단은 원장이
  // 이미 내렸고, 여기서 다시 물으면 답한 사람에게 같은 것을 두 번 묻는 화면이 된다.
  if (opened.decision && opened.decision.status === 'answered') return null;
  return { reason: 'decision-required', decisionId: opened.decisionId, decision: opened.decision, changes: plan.changes };
}

function boardDocumentHistory(root, projectKey, documentId) {
  try {
    const history = require('./approval').documentHistory(root, { project: projectKey, targetId: documentId });
    // 두 목록은 그대로 둔다. 명령줄과 검토 리포트가 그것을 읽고, 종류별로 묻는 물음이
    // 따로 있다. timeline은 그 위에 얹는 순서이지 대신하는 값이 아니다.
    return Object.assign({}, history, { timeline: documentTimeline(history) });
  } catch (error) {
    // 차분 자리와 같은 선을 긋는다. 없는 문서와 원장을 못 읽는 저장소는 서버 결함이
    // 아니고, 500으로 내면 화면은 그 둘을 "보드가 죽었다"로 뭉뚱그린다.
    if (!error.statusCode) error.statusCode = /찾지 못했습니다/u.test(error.message || '') ? 404 : 400;
    throw error;
  }
}

/**
 * 문서·태스크·원장을 한 질의로 찾는 자리.
 *
 * 스냅숏에 싣지 않는다. 검색 결과는 질의마다 다른 값이라 폴링에 실을 수 없고, 실으면
 * 폴링 한 번이 검색 한 번이 되어 아무도 검색하지 않는 동안에도 문서 전건을 훑는다.
 * 이 저장소는 이미 그 선을 그어 두었다 — 문서 차분과 이력이 요청 시 계산이고, 이유도
 * 같다(문서마다 git을 도는 값이라 폴링에 실으면 보드가 선다). 검색도 같은 규칙을 쓴다.
 *
 * 판정은 여기 없다. 무엇을 대상에 넣고 어떻게 순서를 매기는지는 search.js가 소유하며,
 * 이 함수가 하는 일은 주소창의 값을 엔진의 입력으로 옮기는 것뿐이다. 여기서 거르기를
 * 한 줄이라도 다시 적으면 같은 질의가 보드와 엔진에서 다른 답을 낸다.
 *
 * 질의 문자열은 파일 경로가 되지도, 정규식이 되지도 않는다. 엔진 안에서 indexOf의
 * 인자로만 쓰이고 그 밖으로 나가지 않는다 — 프로젝트 키를 경로 정규식으로 좁히고
 * 비교 지점을 16진수로 끊는 것과 같은 선이며, 값이 아니라 쓰임에서 막는다는 점이 같다.
 */
function boardSearch(root, projectKey, search) {
  return searchWorkspace(root, {
    project: projectKey,
    query: search.get('q'),
    limit: search.get('limit'),
    source: search.get('source')
  });
}

/**
 * 비교 지점의 두 주소.
 *
 * 리비전 해시는 원장이 쓰는 주소다. 승인·제출·반려 사건은 자기가 무엇을 판정했는지를
 * reviewedRevision으로만 말하므로, 이력의 원장 줄을 지목하려면 이 주소여야 한다.
 * 커밋 해시는 git이 바로 답하는 주소다. 이력의 커밋 줄은 커밋 해시만 알고, 그 줄을
 * 리비전으로 지목하려면 화면이 커밋마다 문서를 다시 재야 한다 — 그것은 화면이 판정을
 * 다시 짓는 일이라 이 보드가 하지 않기로 한 것이다.
 *
 * 그래서 둘 다 받는다. 한쪽만 받으면 이력의 절반이 지목할 수 없는 줄이 되고, 지목할 수
 * 없는 줄이 섞인 시간축은 "이 둘을 견주자"는 이 화면의 물음에 답하지 못한다.
 *
 * 값의 종류는 길이로 가른다. 리비전은 sha256이라 언제나 64자리이고 커밋은 40자리가
 * 최대라 두 집합은 겹치지 않는다 — 종류를 따로 받는 칸을 두면 화면이 그 칸을 틀리게
 * 채우는 갈래가 생기는데, 길이는 값 자신이 이미 말하고 있어 틀릴 수 없다.
 *
 * 16진수 밖의 글자는 여기서 끊는다. 이 값들은 그대로 git 인자가 되므로, 통과시키면
 * 임의의 문자열이 git 명령으로 들어간다 — 프로젝트 키를 경로 정규식으로 좁히는 것과
 * 같은 선이고, 값이 아니라 모양에서 막는다는 점도 같다.
 */
const REVISION_POINT = /^[a-f0-9]{64}$/u;
const COMMIT_POINT = /^[a-f0-9]{7,40}$/u;

function resolveDiffPoint(projectRoot, file, raw, label, candidates, paths) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!value) inputError(`${label} 지점이 없습니다. 이력에서 견줄 두 지점을 골라야 비교가 성립합니다.`, 'missing-point');
  if (REVISION_POINT.test(value)) {
    // 리비전은 커밋을 되짚어야 한다. 그 되짚기는 approval.js가 소유한다 — 여기서 다시
    // 짜면 같은 물음에 두 답이 생기고, 그중 느슨한 쪽이 화면이 믿는 답이 된다.
    return { kind: 'revision', value, commit: require('./approval').commitForRevision(projectRoot, file, value, candidates, paths) };
  }
  if (COMMIT_POINT.test(value)) {
    // 없는 커밋을 지어내지 않는다. 확인 없이 git diff로 넘기면 git이 자기 말로 죽고,
    // 그 문장은 "이 지점이 이 저장소에 없다"를 사람에게 말해 주지 못한다.
    const found = runGit(['rev-parse', '--verify', `${value}^{commit}`], { cwd: projectRoot, allowFailure: true });
    return { kind: 'commit', value, commit: found.status === 0 ? found.stdout : null };
  }
  return inputError(`${label} 지점의 모양이 아닙니다: ${value.slice(0, 16)}. 64자리 리비전 해시나 7~40자리 커밋 해시여야 합니다.`, 'invalid-point');
}

/**
 * 임의의 두 지점 비교. 정해진 축 둘이 답하지 못하는 물음을 받는 자리다.
 *
 * 「승인 이후 변경」과 「제출본 비교」는 기준이 원장에 못박혀 있다. 그런데 검토하다
 * 보면 "세 판 전과 견주면 어떤가", "언제부터 이렇게 됐나"를 묻게 되고, 그 물음의 기준은
 * 사람이 이력에서 고른다 — 축을 늘려서는 답할 수 없고 지점을 받아야 답할 수 있다.
 *
 * 못 찾은 지점을 빈 차분으로 그리지 않는다. approval.js가 이미 지키는 선이고 이유도
 * 같다: "비교 기준 없음"과 "바뀐 것 없음"은 다른 값이라, 앞엣것을 뒤엣것으로 그리면
 * 사람은 아무것도 안 바뀐 줄 알고 승인한다.
 */
function boardDocumentRangeDiff(root, projectKey, documentId, search) {
  const project = selectProject(workspaceLayout(root), projectKey, true);
  const document = listDocuments(project).find((item) => item.id === documentId);
  if (!document) inputError(`문서를 찾지 못했습니다: ${documentId}`, 'unknown-document');
  // 후보 커밋 목록을 한 번만 만들어 두 지점이 나눠 쓴다. 넘기지 않으면 둘 다 리비전일 때
  // 커밋별 git show 루프가 통째로 두 번 돌고, 지점은 사람이 고르는 값이라 그 갈래가 흔하다.
  //
  // 목록을 여기서 다시 만들지 않는다. 같은 git log를 두 곳에 적으면 한쪽만 고쳐지는 날이
  // 오고, 그때 두 자리가 서로 다른 커밋 집합을 후보로 삼는다 — 같은 지점이 화면에 따라
  // 찾아지기도 하고 안 찾아지기도 한다.
  const approval = require('./approval');
  const candidates = approval.revisionCandidates(project.root, document.file);
  // 경로 이력도 같은 이유로 한 번만 만든다. 이력이 --follow로 이름 변경을 넘어 커밋을
  // 모으므로 사람은 이름이 바뀌기 전 커밋도 고를 수 있고, 그 지점에는 지금 경로가 없다.
  const paths = approval.documentPathHistory(project.root, document.file);
  const from = resolveDiffPoint(project.root, document.file, search && search.get('from'), '기준', candidates, paths);
  const to = resolveDiffPoint(project.root, document.file, search && search.get('to'), '비교', candidates, paths);
  const base = { project: project.key, targetId: document.id, from, to };
  if (!from.commit || !to.commit) {
    const missing = !from.commit && !to.commit ? '두 지점' : !from.commit ? '기준 지점' : '비교 지점';
    return Object.assign(base, {
      diff: null,
      reason: `${missing}을 담은 커밋을 찾지 못했습니다. 비교는 커밋된 지점 사이에서만 성립합니다 — 아직 커밋하지 않은 작업본은 다음 순간 달라질 수 있어 사람이 본 것과 결박되지 않습니다.`
    });
  }
  if (from.commit === to.commit) {
    return Object.assign(base, { diff: '', reason: '두 지점이 같은 커밋을 가리킵니다. 서로 다른 두 지점이라야 사이가 생깁니다.' });
  }
  // git 인자는 approval.js가 짓는다. 한글 파일명 이스케이프도 이름 변경 추적도 세 축이
  // 똑같이 필요한 것이라, 축마다 따로 적으면 한 곳만 고쳐지는 날이 오고 그때 같은 문서의
  // 차분이 축마다 다르게 보인다 — 이 저장소가 이스케이프를 고칠 때 셋을 함께 고친 이유다.
  const diff = runGit(approval.documentDiffArgs(project.root, document.file, from.commit, to.commit, paths), { cwd: project.root, allowFailure: true });
  return Object.assign(base, { diff: diff.status === 0 ? diff.stdout : null });
}

/**
 * 문서 차분. 축은 셋이고 묻는 것이 다르다.
 *
 *   since-approval  승인본 ↔ 작업본. "승인 이후 무엇이 바뀌었나"
 *   submission      승인본 ↔ 제출본. "승인 후보가 승인본과 무엇이 다른가"
 *   range           고른 두 지점. "세 판 전과 견주면 어떤가"
 *
 * 앞의 둘은 기준이 원장에 못박혀 있고 셋째만 사람이 기준을 고른다. 그래서 셋째만
 * 지점을 받고, 나머지 둘에 지점 칸을 열지 않는다 — 열면 "승인본 이후"라는 이름의 축이
 * 승인본이 아닌 것을 기준으로 삼을 수 있게 되어 축의 이름이 거짓말이 된다.
 *
 * 스냅숏에 싣지 않는다. 문서마다 git log --follow와 커밋별 git show를 돌므로 폴링마다
 * 계산하면 문서 수에 비례해 보드가 선다 — 요청할 때만 계산하는 자리다.
 *
 * 비교 기준이 없을 때 빈 diff를 지어내지 않는 것은 approval.js가 이미 지키는 선이다.
 * "비교 기준 없음"과 "바뀐 것 없음"은 다른 값이고, 앞엣것을 뒤엣것으로 그리면 사람은
 * 아무것도 안 바뀐 줄 알고 승인한다. 여기서는 그 답을 그대로 옮기기만 한다.
 */
function boardDocumentDiff(root, projectKey, documentId, search) {
  const approval = require('./approval');
  const axis = String((search && search.get('axis')) || 'since-approval');
  const input = { project: projectKey, targetId: documentId };
  try {
    if (axis === 'submission') return Object.assign({ axis }, approval.diffSubmission(root, input));
    if (axis === 'since-approval') return Object.assign({ axis }, approval.diffSinceApproval(root, input));
    if (axis === 'range') return Object.assign({ axis }, boardDocumentRangeDiff(root, projectKey, documentId, search));
    return inputError(`알 수 없는 비교 축입니다: ${axis} (가능: since-approval, submission, range)`, 'unknown-axis');
  } catch (error) {
    // 없는 문서와 원장을 못 읽는 저장소는 서버 결함이 아니다. 500으로 내보내면 화면은
    // 그 둘을 "보드가 죽었다"로 뭉뚱그리고, 사람은 무엇을 고쳐야 하는지 알 수 없다.
    if (!error.statusCode) error.statusCode = /찾지 못했습니다/u.test(error.message || '') ? 404 : 400;
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
      if (request.method === 'GET' && url.pathname === '/workflow-graph.js') return generatedAsset(response, 'workflow-entry.js', 'application/javascript');
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
      // 문서의 사람 게이트와 그 판단에 필요한 차분. 런의 두 자리(/runs/:id/approve와
      // /runs/:id)와 나란한 짝이고, 승인 앞에 무엇을 보고 판단하는지가 없으면 화면은
      // 문서 ID만 보고 누르는 자리가 된다.
      const projectDocumentApproveMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents\/([^/]+)\/approve$/u);
      const projectDocumentRejectMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents\/([^/]+)\/reject$/u);
      // 수명은 승인·반려와 나란한 자리다. 축은 다르지만 사람이 이 문서를 놓고 내리는
      // 판단이 그 셋이고, 화면에서도 한 판에 함께 선다.
      const projectDocumentLifecycleMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents\/([^/]+)\/lifecycle$/u);
      const projectDocumentDiffMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents\/([^/]+)\/diff$/u);
      // 이력은 차분과 나란한 짝이다. 차분이 "무엇이 달라졌나"에 답하면 이력은 "언제
      // 그리고 왜 그렇게 됐나"에 답하고, 뒤엣것 없이는 앞엣것의 기준을 사람이 고를 수 없다.
      const projectDocumentHistoryMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/documents\/([^/]+)\/history$/u);
      // 검색은 스냅숏 밖의 자리다. 질의마다 다른 값이라 폴링에 실을 수 없다 —
      // 차분·이력과 같은 규칙이고, 그래서 같은 줄에 나란히 둔다.
      const projectSearchMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/search$/u);
      const projectSyncMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/sync$/u);
      const projectRefreshMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/refresh$/u);
      const projectSnapshotMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/board-snapshot$/u);
      const projectContractMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/contract$/u);
      const projectContractPlanMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/contract\/plan$/u);
      const projectPresentationMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/presentation$/u);
      const projectWorkflowsMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/workflows$/u);
      const projectDecisionsMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/decisions$/u);
      const projectDecisionAnswerMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/decisions\/(DEC-[A-Za-z0-9-]+)\/answer$/u);
      const projectRunsMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/runs$/u);
      const projectRunApproveMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/runs\/(RUN-[A-Za-z0-9]+)\/approve$/u);
      const projectRunMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/runs\/(RUN-[A-Za-z0-9]+)$/u);
      const requestedProject = [projectMatch, projectTasksMatch, projectTaskMatch, projectTaskTransitionsMatch, projectDocumentsMatch, projectDocumentCheckMatch, projectDocumentMatch, projectSyncMatch, projectRefreshMatch, projectSnapshotMatch, projectContractMatch, projectContractPlanMatch, projectPresentationMatch, projectWorkflowsMatch, projectDecisionsMatch, projectDecisionAnswerMatch].find(Boolean);
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
      // 차분은 스냅숏에 실리지 않는다. 문서마다 git log --follow와 커밋별 git show를
      // 돌므로 폴링마다 계산하면 보드가 선다 — 물을 때만 계산한다.
      if (request.method === 'GET' && projectDocumentDiffMatch) {
        return json(response, 200, boardDocumentDiff(config.root, projectDocumentDiffMatch[1], decodeURIComponent(projectDocumentDiffMatch[2]), url.searchParams));
      }
      // 이력도 같은 이유로 스냅숏 밖이다. 문서마다 git log --follow를 도는 값이라 폴링에
      // 실으면 문서 수에 비례해 보드가 선다.
      if (request.method === 'GET' && projectDocumentHistoryMatch) {
        return json(response, 200, boardDocumentHistory(config.root, projectDocumentHistoryMatch[1], decodeURIComponent(projectDocumentHistoryMatch[2])));
      }
      if (request.method === 'GET' && projectSearchMatch) {
        return json(response, 200, boardSearch(config.root, projectSearchMatch[1], url.searchParams));
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
      if (request.method === 'POST' && projectDocumentApproveMatch) {
        const body = await requestBody(request);
        return json(response, 200, approveBoardDocument(config.root, projectDocumentApproveMatch[1], decodeURIComponent(projectDocumentApproveMatch[2]), body));
      }
      if (request.method === 'POST' && projectDocumentRejectMatch) {
        const body = await requestBody(request);
        return json(response, 200, rejectBoardDocument(config.root, projectDocumentRejectMatch[1], decodeURIComponent(projectDocumentRejectMatch[2]), body));
      }
      if (request.method === 'POST' && projectDocumentLifecycleMatch) {
        const body = await requestBody(request);
        return json(response, 200, setBoardDocumentLifecycle(config.root, projectDocumentLifecycleMatch[1], decodeURIComponent(projectDocumentLifecycleMatch[2]), body));
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
          // 두 409를 이름으로 가른다. 하나는 "남이 먼저 고쳤다"이고 다른 하나는 "결정이
          // 먼저다"인데, 화면이 코드만 보고 갈라야 하면 두 안내가 언젠가 섞인다.
          return json(response, 409, { reason: 'stale-revision', error: '표시 설정이 외부에서 변경되었습니다. 최신 값을 확인하세요.', current });
        }
        const presentationPlan = planOrReject(() => presentationSavePlan(config.root, projectKey, scope, body));
        const presentationGate = policyDecisionGate(config.root, projectKey, scope, presentationPlan, body);
        if (presentationGate) return json(response, 409, Object.assign({ error: '정책 층 변경은 계약 변경 결정을 함께 남겨야 저장됩니다.' }, presentationGate));
        savePresentation(config.root, projectKey, scope, body, { decisionId: body.decisionId });
        return json(response, 200, loadBoardPresentation(config.root, projectKey));
      }
      // 워크플로도 같은 문을 지난다. 대상 종류로 게이트를 가르지 않는 이유는 ADR-027이
      // 적은 그대로다 — 표면마다 문을 따로 두면 한쪽만 고쳐지는 날이 온다.
      if (request.method === 'GET' && projectWorkflowsMatch) return json(response, 200, boardWorkflows(config.root, projectWorkflowsMatch[1]));
      if (request.method === 'POST' && projectWorkflowsMatch) {
        const body = await requestBody(request);
        const scope = body && body.scope;
        if (!['workspace', 'project'].includes(scope)) return json(response, 400, { error: 'scope는 workspace 또는 project여야 합니다.' });
        const projectKey = projectWorkflowsMatch[1];
        const current = boardWorkflows(config.root, projectKey);
        if (!body.baseRevision || body.baseRevision !== current.baseRevision) {
          return json(response, 409, { reason: 'stale-revision', error: '워크플로 정의가 외부에서 변경되었습니다. 최신 값을 확인하세요.', current });
        }
        const workflowPlan = planOrReject(() => workflowsSavePlan(config.root, projectKey, scope, body));
        const workflowGate = policyDecisionGate(config.root, projectKey, scope, workflowPlan, body);
        if (workflowGate) return json(response, 409, Object.assign({ error: '워크플로는 전부 정책 층이라 계약 변경 결정을 함께 남겨야 저장됩니다.' }, workflowGate));
        saveWorkflows(config.root, projectKey, scope, body, { decisionId: body.decisionId });
        return json(response, 200, boardWorkflows(config.root, projectKey));
      }
      // 결정을 읽는 자리. 화면이 이것을 못 읽으면 저장이 막힌 이유를 보여 줄 수는 있어도
      // 그것을 푸는 길은 언제나 명령줄이 되고, 그 왕복이 정책 변경을 미루는 자리가 된다.
      if (request.method === 'GET' && projectDecisionsMatch) {
        return json(response, 200, listDecisions(config.root, { project: projectDecisionsMatch[1], open: url.searchParams.get('open') !== null }));
      }
      if (request.method === 'POST' && projectDecisionAnswerMatch) {
        const body = await requestBody(request);
        const projectKey = projectDecisionAnswerMatch[1];
        const project = selectProject(workspaceLayout(config.root), projectKey, true);
        const clients = listClients(config.root).clients;
        const identity = boardClient(config.root, project, clients);
        if (!identity.id) inputError('이 기기의 Client ID가 없습니다. rdl git init으로 프로젝트를 준비하세요.');
        if (!identity.registered) inputError(`등록되지 않은 Client입니다: ${identity.id}. 설정 → Clients에서 이 기기를 등록하세요.`, 'unknown-client');
        // 사람만 답한다. 답을 쓰고 나서 저장에서 막히면 원장에는 아무것도 열지 못하는
        // 답변만 남고 그 답변은 지울 수 없다 — 막을 자리는 쓰기 전이다. 위임은 이
        // 화면이 다루지 않으므로 여기서는 사람 자격만 본다. 판정은 문서 승인과 같은
        // 함수가 하고, 그 사유 문장을 그대로 화면에 올린다.
        require('./collaboration-store').assertProjectHumanApprover(
          config.root, project.key, clients.find((item) => item.id === identity.id) || null, '결정에 답');
        return json(response, 200, answerDecision(config.root, {
          project: projectKey, clientId: identity.id, decisionId: projectDecisionAnswerMatch[2],
          selectedOption: body && body.selectedOption, answeredBy: body && body.answeredBy, reason: body && body.reason
        }));
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
      // 낡을 승인은 목록으로도 내보낸다. 문장에 이름이 들어 있지만 그 문장은 사람이
      // 읽는 것이고, 여러 건이 걸리는 날 화면이 그것을 줄로 세울 자리가 필요하다.
      return json(response, error.statusCode || 500, { error: error.message, code: error.code || undefined, current: error.current || undefined, approvalsAtRisk: error.approvalsAtRisk || undefined });
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

module.exports = { STATUSES, boardConfig, queryTasks, boardRevision, overview, workspaceSnapshot, taskTransitions, attentionItems, reviewQueue, documentTurns, composeDocumentFile, approveBoardDocument, setBoardDocumentLifecycle, boardDocumentDiff, documentTimeline, boardSearch, createBoardServer, startBoard };
