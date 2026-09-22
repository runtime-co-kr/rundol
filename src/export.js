'use strict';

// 배포판. 프로젝트의 지금을 자기완결 HTML 한 파일로 굳혀, git도 Node도 네트워크도
// 없는 사람에게 업무 현황을 넘긴다.
//
// 읽기 전용이 이 파일의 성질이고 기능이 아니다. 배포판에는 쓰기 경로가 한 줄도
// 들어가지 않는다 — 들어가면 받은 사람은 고칠 수 있다고 믿고 고치고, 그 고침은
// 어느 원장에도 닿지 않은 채 사라진다. 그것은 기능이 모자란 것보다 나쁘다.
//
// 마크다운은 여기서(Node에서) 렌더링한다. 뷰어가 marked와 DOMPurify를 실으면
// 76KB가 늘고 정화의 책임이 받는 쪽 브라우저로 넘어가는데, 굳히는 시점에 한 번
// 하면 되는 일을 열 때마다 시킬 이유가 없다. mermaid는 다르다 — 다이어그램은
// 브라우저에서 그려야 하므로 3.4MB를 실어야 하고, 그래서 다이어그램이 실제로
// 있는 프로젝트에만 싣는다.
//
// 배포판은 시각을 갖는다. 받는 사람이 "이게 언제 것인가"를 물을 수 없으면 그
// 파일은 현황이 아니라 출처 불명의 문서 더미가 된다.

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { listDocuments } = require('./board-data');
const { readCollaboration } = require('./collaboration');
const { loadDocumentContract } = require('./document-contract');
const { assetsDirectory } = require('./asset');
const { readTaskStore } = require('./tasks');
const { stateConfig } = require('./state');
const { DEFAULT_DOCUMENT_ORDER } = require('./vocabulary');

const VIEWER_ROOT = path.join(__dirname, 'export-viewer');
const MERMAID_ASSET = 'mermaid/dist/mermaid.min.js';

// 자산으로 실을 수 있는 그림. 문서가 가리키는 것만 싣고, 목록에 없는 확장자는
// 링크로 남긴다 — 무엇이든 base64로 삼키면 배포판 하나가 저장소만큼 커진다.
const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'
});

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

/**
 * 스크립트 안에 JSON을 넣는 자리. `</script`와 HTML 주석 여는 자리를 깨 두지 않으면
 * 문서 본문에 그 글자가 있는 순간 배포판의 스크립트가 거기서 끊긴다 — 내용이 코드를
 * 끊는 이 사고는 열어 봐야만 드러나고, 열어 본 사람은 빈 화면을 본다.
 */
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e')
    .replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}

/** 자산 파일 하나를 data URI로. 못 읽으면 null이고, 그 사실은 부르는 쪽이 센다. */
function dataUri(file) {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const bytes = fs.readFileSync(file);
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch (error) {
    return null;
  }
}

/**
 * 마크다운을 HTML로. marked를 쓰되 렌더러는 보드 화면과 같은 규율을 따른다 —
 * mermaid 코드블록은 그리는 자리로 남기고 나머지 코드는 글자 그대로 둔다.
 *
 * 문서 사이 링크(`[[REQ-001]]`)는 배포판 안의 자리로 옮긴다. 옮기지 않으면 받는
 * 사람은 눌리지 않는 글자를 보고, 그 문서가 같은 파일 안에 있다는 것을 모른다.
 * 자산 embed(`![[그림.png]]`)는 data URI로 바뀐다.
 */
function renderMarkdown(source, context) {
  const { marked } = require('marked');
  const assets = context.assets || {};
  const known = context.documentIds || new Set();
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => (String(lang || '').toLowerCase() === 'mermaid'
    ? `<pre class="mermaid">${escapeHtml(text)}</pre>`
    : `<pre><code class="language-${escapeHtml(lang || '')}">${escapeHtml(text)}</code></pre>`);
  // 자산이 문서 참조보다 먼저다. 느낌표를 보지 않고 문서 규칙으로 옮기면 그림이
  // 링크가 되고, 받는 사람에게 그것은 "그림이 빠진 배포판"이다.
  const prepared = String(source || '')
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gu, (whole, name) => {
      const uri = assets[String(name).trim()];
      return uri ? `![${String(name).trim()}](${uri})` : whole;
    })
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gu, (whole, target, label) => {
      const id = String(target).trim().split('#')[0];
      const text = String(label || target).trim();
      return known.has(id) ? `[${text}](#doc=${encodeURIComponent(id)})` : text;
    });
  return marked.parse(prepared, { gfm: true, breaks: false, renderer });
}

/** 유형별 층. 화면이 사슬을 그리는 근거이고 계산은 어휘의 표 하나에서만 나온다. */
function documentLayers(order, present) {
  const layerOf = {};
  const depth = (type, seen) => {
    if (layerOf[type] !== undefined) return layerOf[type];
    if (seen.has(type)) return 0;
    seen.add(type);
    const parents = order[type] || [];
    const value = parents.length ? Math.max(...parents.map((parent) => depth(parent, seen) + 1)) : 0;
    seen.delete(type);
    layerOf[type] = value;
    return value;
  };
  for (const type of Object.keys(order)) depth(type, new Set());
  const layers = [];
  for (const type of present) (layers[layerOf[type] || 0] = layers[layerOf[type] || 0] || []).push(type);
  return layers.filter(Boolean);
}

/** 이 프로젝트의 지금. 파일을 읽는 일은 전부 여기서 끝나고 아래는 값만 다룬다. */
function collect(start, options) {
  const layout = workspaceLayout(start);
  const project = selectProject(layout, options.project, true);
  const documents = listDocuments(project);
  const documentIds = new Set(documents.map((item) => item.id));

  // 승인 원장. 읽지 못하는 작업공간(판이 낮거나 원장이 깨진 경우)에서도 배포판은
  // 나와야 한다 — 상태를 모른다는 사실을 싣고 지나간다. 모르는 것을 미승인으로
  // 적으면 배포판이 원장에 없는 사실을 말하게 된다.
  let approvals = { states: null, reason: null };
  try {
    const approval = require('./approval');
    const ledger = approval.documentApprovals(start, { project: project.key });
    const states = {};
    for (const document of documents) {
      states[document.id] = approval.trustState(document, ledger.approvals.get(document.id), ledger.submissions.get(document.id), ledger.rejections.get(document.id));
    }
    approvals = { states, reason: null };
  } catch (error) {
    approvals = { states: null, reason: error.message };
  }

  let tasks = [];
  try {
    const config = stateConfig(layout.root, project.key);
    const store = readTaskStore(path.join(config.worktree, config.taskRelative));
    tasks = Object.entries(store.tasks || {}).map(([id, task]) => Object.assign({ id }, task)).sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    tasks = [];
  }

  let collaboration = { members: [], roles: [] };
  try { collaboration = readCollaboration(layout.root, project.key); } catch (error) { collaboration = { members: [], roles: [] }; }

  let contract = null;
  try { contract = loadDocumentContract(layout.root, project.key); } catch (error) { contract = null; }

  // 자산은 문서가 가리키는 것만 싣는다. 폴더를 통째로 삼키면 쓰이지 않는 그림까지
  // base64가 되고, 그 무게는 받는 사람이 치른다.
  const assets = {};
  let assetBytes = 0;
  const wanted = new Set();
  for (const document of documents) {
    for (const match of String(document.body || '').matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gu)) wanted.add(match[1].trim());
  }
  if (wanted.size) {
    let directory = null;
    try { directory = assetsDirectory(layout, project); } catch (error) { directory = null; }
    if (directory && fs.existsSync(directory)) {
      for (const name of wanted) {
        const file = path.join(directory, name);
        if (!fs.existsSync(file)) continue;
        const uri = dataUri(file);
        if (!uri) continue;
        assets[name] = uri;
        assetBytes += uri.length;
      }
    }
  }

  return { layout, project, documents, documentIds, approvals, tasks, collaboration, contract, assets, assetBytes };
}

/** 굳힌 값. 화면이 읽을 모양이며 파일을 더 읽지 않는다. */
function buildPayload(source, stamp) {
  const { project, documents, documentIds, approvals, tasks, collaboration, contract, assets } = source;
  const assetNames = Object.keys(assets);
  const rendered = documents.map((document) => {
    const state = approvals.states ? approvals.states[document.id] : null;
    return {
      id: document.id,
      // 유형은 식별자에서 읽는다. frontmatter의 `type`은 "이것이 문서인가"라는 다른
      // 축이고(값이 document다), 그것을 유형으로 쓰면 모든 문서가 한 칸에 쌓여 흐름
      // 사슬이 통째로 비어 버린다 — 보드 화면이 같은 규칙을 쓰는 이유다.
      type: (/^([A-Z]{3})-\d+$/u.exec(document.id) || [])[1] || null,
      title: document.title,
      description: document.description || '',
      owner: document.ownerMember || null,
      state: document.state || null,
      lifecycle: document.lifecycle || null,
      file: document.file,
      modifiedAt: document.modifiedAt,
      // 승인 원장이 아는 사실. frontmatter의 state와 다른 축이므로 둘 다 싣는다.
      approval: state ? { status: state.status, approvedBy: state.approvedBy || null, approvals: state.approvals || 0, submission: state.submission ? state.submission.state : null } : null,
      html: renderMarkdown(document.body, { assets, documentIds })
    };
  });

  const typeCounts = {};
  for (const document of rendered) {
    if (!document.type) continue;
    const counts = typeCounts[document.type] = typeCounts[document.type] || { total: 0, approved: 0, stale: 0 };
    counts.total += 1;
    // 낡음을 따로 센다. 승인도 미승인도 아닌 자리이고 — 승인했는데 그 뒤에 바뀐
    // 것이다 — 미승인과 한 칸에 두면 받는 사람이 "다시 승인받아야 할 것"을 고를 수
    // 없다. 완결률의 분자에는 들지 않는다: 낡은 승인은 지금 판을 책임지지 않는다.
    if (document.approval && document.approval.status === 'approved') counts.approved += 1;
    else if (document.approval && document.approval.status === 'stale') counts.stale += 1;
  }
  const disabled = (contract && contract.profile && contract.profile.policy && contract.profile.policy.disabled) || [];
  const present = Object.keys(DEFAULT_DOCUMENT_ORDER).filter((type) => !disabled.includes(type) && typeCounts[type]);
  const totals = Object.values(typeCounts).reduce((sum, counts) => ({
    total: sum.total + counts.total, approved: sum.approved + counts.approved, stale: sum.stale + (counts.stale || 0)
  }), { total: 0, approved: 0, stale: 0 });

  return {
    schemaVersion: 1,
    project: { key: project.key, name: (collaboration.project && collaboration.project.name) || project.key },
    generatedAt: stamp,
    // 이 배포판을 만든 판. 받은 사람이 "무엇으로 만든 것인가"를 물을 수 있어야 한다.
    tool: { name: 'rundol', version: require('../package.json').version },
    readOnly: true,
    documents: rendered,
    // 태스크는 세어지기만 해서는 읽을 것이 없다. 완료조건의 문장과 대기 사유와
    // 의존이 함께 가야 받는 사람이 "이 일이 무엇이고 왜 멈춰 있나"에 답할 수 있다 —
    // 수만 싣고 문장을 빼면 배포판은 진척률 표이지 업무 현황이 아니다.
    tasks: tasks.map((task) => ({
      id: task.id, title: task.title || '', status: task.status || null, priority: task.priority || null,
      owner: task.owner || null, kind: task.kind || 'normal', result: task.result || null, round: task.round || null,
      links: task.links || [], deps: task.deps || [], summary: task.summary || '',
      acceptance: task.acceptanceCriteria
        ? {
          done: Object.values(task.acceptanceCriteria).filter((item) => item && item.done).length,
          total: Object.keys(task.acceptanceCriteria).length,
          items: Object.entries(task.acceptanceCriteria).map(([id, item]) => ({ id, text: (item && item.text) || '', done: Boolean(item && item.done) }))
        }
        : null,
      blocker: task.blocker ? { waitingFor: task.blocker.waitingFor || null, condition: task.blocker.condition || '', since: task.blocker.since || null } : null,
      reviewers: task.reviewers || [],
      updatedAt: task.updatedAt || null
    })),
    members: (collaboration.members || []).map((member) => ({ id: member.id, name: member.name || member.id, role: member.role || null })),
    flow: { layers: documentLayers(DEFAULT_DOCUMENT_ORDER, present), counts: typeCounts, totals },
    approvalReason: approvals.reason,
    assetCount: assetNames.length
  };
}

/**
 * 배포판을 굳힌다. 한 파일이고 바깥을 참조하지 않는다 — 그 성질이 이 기능의 전부라
 * 뷰어 자산도 mermaid도 파일 안에 들어간다.
 *
 * mermaid는 다이어그램이 실제로 있을 때만 싣는다. 3.4MB는 다이어그램을 보는 값이지
 * 모든 배포판이 치를 값이 아니다.
 */
function exportProject(start, options) {
  const settings = options || {};
  const source = collect(start, settings);
  const stamp = settings.now || new Date().toISOString();
  const payload = buildPayload(source, stamp);

  const hasDiagrams = payload.documents.some((document) => document.html.includes('<pre class="mermaid">'));
  let mermaid = '';
  if (hasDiagrams && settings.diagrams !== false) {
    try {
      // 보드가 같은 자산을 내주는 방식 그대로다(src/board.js의 dependencyAsset).
      // 경로를 직접 조립하면 설치본과 저장소에서 서로 다른 자리를 보게 되고, 그
      // 차이는 설치한 사람만 만난다.
      mermaid = fs.readFileSync(require.resolve(MERMAID_ASSET), 'utf8');
    } catch (error) {
      mermaid = '';
    }
  }

  const template = fs.readFileSync(path.join(VIEWER_ROOT, 'viewer.html'), 'utf8');
  const html = template
    .replace('/*__RUNDOL_VIEWER_CSS__*/', () => fs.readFileSync(path.join(VIEWER_ROOT, 'viewer.css'), 'utf8'))
    .replace('/*__RUNDOL_VIEWER_JS__*/', () => fs.readFileSync(path.join(VIEWER_ROOT, 'viewer.js'), 'utf8'))
    .replace('/*__RUNDOL_MERMAID__*/', () => mermaid)
    .replace('"__RUNDOL_PAYLOAD__"', () => embedJson(payload))
    .replaceAll('__RUNDOL_TITLE__', escapeHtml(`${payload.project.name} 업무 현황`));

  const out = path.resolve(settings.out || `${source.project.key}-현황.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');

  return {
    root: source.layout.root,
    project: source.project.key,
    file: out,
    bytes: Buffer.byteLength(html, 'utf8'),
    documents: payload.documents.length,
    tasks: payload.tasks.length,
    assets: payload.assetCount,
    diagrams: hasDiagrams,
    mermaidIncluded: Boolean(mermaid),
    generatedAt: stamp,
    readOnly: true,
    // 승인 원장을 못 읽었으면 그 사실이 결과에 남는다. 배포판은 나오되 상태 칸이
    // 비어 있다는 것을 만든 사람이 알아야 한다.
    ...(payload.approvalReason ? { approvalNotice: payload.approvalReason } : {})
  };
}

module.exports = { exportProject, renderMarkdown, documentLayers, embedJson };
