'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { runGit } = require('./git');
const { loadWorkflows, workflowFor, readJson, BINDING_FALLBACK } = require('./workflow-config');
const { REVISION_FORMULAS, REVISION_OWNED_FIELDS, DEFAULT_REVISION_FORMULA, CURRENT_REVISION_FORMULA } = require('./vocabulary');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalRevision(value) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalJson(value), 'utf8')).digest('hex');
}

function entityRevision(value) {
  return canonicalRevision(value);
}

// ── 문서 리비전과 그 계산 판 ────────────────────────────────────────────
//
// 리비전은 승인이 결박하는 값이다. 계산을 바꾸면 같은 파일이 다른 리비전을 내고,
// 그러면 그 전에 기록된 승인이 전부 어긋난다 — 승인은 다시 만들 수 없는 사람의
// 판단이라 되돌릴 방법이 없다. 그래서 계산에는 판이 붙고, 원장의 사건은 자기가 어느
// 판으로 잰 리비전인지 함께 적으며, 접을 때 그 판으로 문서를 다시 재어 견준다.
// 판의 정본과 뜻은 vocabulary의 REVISION_FORMULAS가 갖는다.

function revisionFormula(value) {
  if (value === undefined || value === null) return CURRENT_REVISION_FORMULA;
  if (!REVISION_FORMULAS.includes(value)) throw new Error(`지원하지 않는 리비전 계산 판입니다: ${value} (가능: ${REVISION_FORMULAS.join(', ')})`);
  return value;
}

/**
 * 그 판이 실제로 재는 metadata.
 *
 * 판 2는 rdl이 소유하는 칸(REVISION_OWNED_FIELDS)을 뺀다. 빼지 않으면 승인이 자기를
 * 무효화한다 — 승인하면서 state를 쓰면 그 쓰기가 리비전을 바꾸고, 방금 승인한 리비전이
 * 더 이상 이 문서가 아니게 되어 그 자리에서 낡음이 된다.
 *
 * 판 1은 옛 계산 그대로 손대지 않는다. 여기 한 줄이 달라지면 이 저장소 밖에 이미
 * 기록된 승인이 전부 어긋나고, 그 사실은 아무 신호도 내지 않은 채 문서를 낡음으로 만든다.
 *
 * 사본을 만들고 원본을 지우지 않는다. 부르는 쪽이 넘긴 문서 객체에서 칸을 지우면
 * 리비전을 한 번 계산한 것만으로 그 문서의 state가 사라진다.
 *
 * 소유 칸이 아예 없는 문서는 두 판이 같은 값을 낸다 — 지울 키가 없으므로 canonical이
 * 같기 때문이다. 그래서 판올림으로 리비전이 달라지는 것은 state를 실제로 적고 있는
 * 문서뿐이고, 그 밖의 문서에 걸린 옛 승인은 판을 따지지 않아도 그대로 유효하다.
 */
function measuredMetadata(metadata, formula) {
  if (formula === DEFAULT_REVISION_FORMULA) return metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  if (!REVISION_OWNED_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(metadata, field))) return metadata;
  const measured = {};
  for (const key of Object.keys(metadata)) if (!REVISION_OWNED_FIELDS.includes(key)) measured[key] = metadata[key];
  return measured;
}

function packedDocument(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'metadata') && Object.prototype.hasOwnProperty.call(value, 'body');
}

/**
 * 그 판으로 잰 문서 리비전. 판을 안 적으면 지금 판(CURRENT_REVISION_FORMULA)이다.
 *
 * 묶음 형태({metadata, body})를 계속 받는다. 그때 판은 둘째 칸이고, 판은 숫자라 본문
 * 문자열과 헷갈리지 않는다 — 옛 두 칸 호출(metadata, body)은 그대로 두 칸으로 읽힌다.
 */
function documentRevision(metadata, body, formula) {
  const packed = packedDocument(metadata) && (body === undefined || REVISION_FORMULAS.includes(body));
  const input = packed ? metadata : { metadata, body };
  const selected = revisionFormula(packed ? body : formula);
  return canonicalRevision({ metadata: measuredMetadata(input.metadata, selected), body: input.body });
}

/**
 * 판마다 잰 리비전의 표. 접기가 "이 사건은 어느 판으로 쟀나"에 답하려면 문서 쪽도
 * 판마다의 값을 들고 있어야 한다.
 *
 * 표를 문서에 실어 두는 이유는 판정이 문서를 다시 읽지 않게 하기 위해서다. 판정
 * 자리에서 파일을 다시 읽으면 그 값이 목록을 만든 시점 밖에서 오고, 그러면 같은
 * 스냅숏 안에서 문서 목록과 승인 판정이 서로 다른 파일을 본다.
 */
function documentRevisions(metadata, body) {
  const packed = packedDocument(metadata) && body === undefined;
  const input = packed ? metadata : { metadata, body };
  const table = {};
  for (const formula of REVISION_FORMULAS) table[formula] = documentRevision(input.metadata, input.body, formula);
  return Object.freeze(table);
}

function projectRevision(documents) {
  if (!Array.isArray(documents)) throw new Error('documents must be an array');
  const entries = documents.map((document) => {
    if (!document || typeof document.id !== 'string' || !/^[a-f0-9]{64}$/u.test(document.revision || '')) throw new Error('project revision requires document id/revision pairs');
    return [document.id, document.revision];
  }).sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error('project revision document IDs must be unique');
  return canonicalRevision(entries);
}

function markdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.statSync(root).isFile()) return root.endsWith('.md') ? [root] : [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.obsidian' || entry.name === '.rundol') continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target);
  }
  return files;
}

// 소유자 칸의 MEMBER-ID. 파일에 적히는 값은 사람이 읽는 위키링크(`[[project#^MEMBER-001|강영준]]`)라
// 표시와 식별자가 한 문자열에 섞여 있고, 판정이 필요한 것은 뒤엣것뿐이다. 여기서 한 번 갈라
// 두 값을 다 실으면 화면이 문자열을 뒤져 ID를 되짚지 않는다 — 실제로 사람 화면이
// String(owner).includes(id)로 그 일을 하고 있는데, 그 판정은 MEMBER-1이 MEMBER-10에도
// 걸리고 이름에 ID를 적어 둔 문서에도 걸린다. 「내 차례」처럼 사람을 가르는 축이 그 위에
// 서면 남의 줄이 내 줄로 들어오고, 틀렸다는 신호는 어디에도 나지 않는다.
//
// 못 찾으면 null이다. 지어내지 않는다 — 소유자를 모르는 문서와 내가 소유자가 아닌 문서는
// 다르고, 아무 값으로나 메우면 앞엣것이 누군가의 줄에 조용히 선다.
function ownerMemberId(value) {
  const found = /(MEMBER-[A-Z0-9]+)/u.exec(String(value || ''));
  return found ? found[1] : null;
}

function listDocuments(project) {
  const documents = [];
  for (const file of markdownFiles(project.root)) {
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!parsed || !parsed.data.id) continue;
    // 판마다의 값을 함께 싣는다. revision은 지금 판이고, 판을 안 적은 옛 사건은
    // 판 1로 잰 값과 견주어야 하므로 그 값도 여기서 한 번에 계산해 둔다 — 판정
    // 자리에서 다시 계산하면 같은 파일을 두 번 읽게 되고, 두 읽기는 갈릴 수 있다.
    const revisions = documentRevisions(parsed.data, parsed.body);
    documents.push({
      id: parsed.data.id,
      type: parsed.data.type || null,
      kind: parsed.data.kind || null,
      title: parsed.data.title || path.basename(file, '.md'),
      description: parsed.data.description || '',
      owner: parsed.data.owner || null,
      ownerMember: ownerMemberId(parsed.data.owner),
      state: parsed.data.state || null,
      // 수명은 상태와 다른 축이다. state는 rdl이 승인 원장에서 투영하는 칸이고 lifecycle은
      // 사람이 적는 "이 내용이 지금 효력이 있나"다. 싣지 않으면 화면은 그 축을 아예 모르고,
      // 실제로 lifecycle: accepted를 든 ADR 15건이 화면에서는 「초안」으로만 보였다.
      //
      // 값이 없는 것과 active는 다르므로 없는 것은 null로 남긴다 — 여기서 active로 메우면
      // 대부분의 문서가 적지도 않은 수명을 주장하게 되고, 화면은 그것을 사실로 그린다.
      // 값 없는 `lifecycle:` 한 줄을 파서가 빈 배열로 읽으므로 문자열만 값으로 받는다.
      // 어휘 밖 값을 여기서 거르지는 않는다 — 그 판정은 rdl check(RDL-DOC-017)의 몫이고,
      // 여기서 조용히 지우면 오타 난 문서가 화면에서는 정상으로 보인다.
      lifecycle: typeof parsed.data.lifecycle === 'string' && parsed.data.lifecycle.trim() ? parsed.data.lifecycle.trim() : null,
      tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
      related: Array.isArray(parsed.data.related) ? parsed.data.related : [],
      file: path.relative(project.root, file).replace(/\\/g, '/'),
      body: parsed.body,
      modifiedAt: fs.statSync(file).mtime.toISOString(),
      revision: revisions[CURRENT_REVISION_FORMULA],
      revisions
    });
  }
  return documents.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function syncStatus(project) {
  const head = runGit(['rev-parse', 'HEAD'], { cwd: project.root }).stdout;
  const status = runGit(['status', '--porcelain'], { cwd: project.root }).stdout;
  const upstream = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: project.root, allowFailure: true });
  let ahead = null;
  let behind = null;
  let remoteRef = null;
  if (upstream.status === 0) {
    remoteRef = upstream.stdout;
    const counts = runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd: project.root, allowFailure: true });
    if (counts.status === 0) [ahead, behind] = counts.stdout.split(/\s+/u).map(Number);
  }
  const conflicts = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: project.root, allowFailure: true }).stdout;
  return {
    project: project.key,
    head,
    remoteRef,
    ahead,
    behind,
    dirty: Boolean(status),
    changedFiles: status ? status.split(/\r?\n/u).length : 0,
    conflicts: conflicts ? conflicts.split(/\r?\n/u) : [],
    state: conflicts ? 'conflict' : (ahead !== null && behind !== null && ahead > 0 && behind > 0 ? 'diverged' : behind > 0 ? 'behind' : ahead > 0 ? 'ahead' : status ? 'modified' : 'clean')
  };
}

// ── 보드가 싣는 워크플로 ────────────────────────────────────────────────
//
// 화면은 브라우저에서 그대로 돌아 require를 쓸 수 없다. 그래서 워크플로를 서버가
// 스냅숏에 실어 준다. 여기까지는 예전과 같고, 달라진 것은 무엇을 싣느냐다.
//
// 예전에는 workflow.js의 모듈 최상위 뷰를 실었다. 그것은 transitions: null로 만든
// 내장 인스턴스의 뷰라 전환이 언제나 비었고 노드 label도 언제나 null이었다 —
// workflows.json을 고쳐도 화면은 그대로였다는 뜻이다. 설정 층을 태우는 자리는
// state.js와 doctor.js 둘뿐이었고 보드는 그 자리에 없었다.
//
// 판정은 여기 없다. 이 층이 하는 일은 설정을 읽어 인스턴스를 고르고 그것을 보이는
// 모양으로 옮기는 것뿐이며, 무엇이 막히는가는 언제나 그 인스턴스가 답한다.

/**
 * 어느 층이 정의했는가. board-presentation.js의 origins와 같은 모양이다 —
 * { 그룹: { 키: { entry, fields } } }이고 entry는 그 항목을 마지막으로 적은 층이다.
 *
 * 모양을 맞추는 이유는 화면이 출처 표시를 한 벌만 갖게 하기 위해서다. 업무 유형
 * 패널이 이미 이 모양을 그리고 있으므로 워크플로가 다른 모양을 내면 같은 질문에
 * 두 벌의 그림이 생기고, 두 벌은 언젠가 갈라진다.
 *
 * bindings 그룹의 키는 대상 종류고 fields가 유형이다. 파일이 그렇게 두 층으로 적혀
 * 있어서이며, 키를 합쳐 두면 화면이 그것을 다시 쪼개야 한다.
 *
 * 내장 층은 여기 없다. 파일이 없는 층이라 적은 항목도 없기 때문이고, 그래서 "설정이
 * 아무것도 잡지 않은 흐름"은 항목의 출처가 아니라 흐름 자체의 origin이 답한다.
 *
 * 그룹 이름은 workflows.json의 최상위 두 칸 그대로다. 빈 그룹을 미리 세워 두는 이유는
 * 파일이 없을 때도 모양이 같아야 화면이 "없다"와 "아직 안 왔다"를 가르지 않기 때문이다.
 */
function workflowOrigins(layers) {
  const origins = { workflows: {}, bindings: {} };
  for (const group of Object.keys(origins)) {
    for (const { scope, parsed } of layers) {
      for (const [key, entry] of Object.entries((parsed && parsed[group]) || {})) {
        const current = origins[group][key] || { entry: scope, fields: {} };
        current.entry = scope;
        for (const field of Object.keys(entry || {})) current.fields[field] = scope;
        origins[group][key] = current;
      }
    }
  }
  return origins;
}

/**
 * 그 유형이 탈 흐름의 이름. workflow-config.js의 workflowFor가 같은 표를 같은 순서로 본다.
 *
 * 이름이 따로 필요한 이유는 인스턴스가 자기 이름을 들고 있지 않아서다. 이 값은 라벨과
 * 출처 표시에만 쓰고 막는 일은 언제나 workflowFor가 만든 인스턴스가 한다 — 둘이
 * 어긋나도 판정은 달라지지 않고 배지가 틀린다.
 *
 * 이 조회가 두 벌인 것은 이 갈래가 workflow-config.js를 담당하지 않기 때문이다.
 * workflowFor가 이름을 함께 돌려주면 이 함수는 사라진다.
 */
function boundWorkflowId(config, targetKind, typeId) {
  const table = (config && config.bindings && config.bindings[targetKind]) || {};
  return table[typeId === undefined || typeId === null ? '' : String(typeId)] || table[BINDING_FALLBACK] || null;
}

function resolveTaskWorkflow(start, projectKey, kind) {
  const config = loadWorkflows(start, projectKey);
  // 층별 원본을 따로 든다. 병합 결과만으로는 어느 층이 적은 것인지 답할 수 없고,
  // 값을 견주면 상위와 같은 값을 명시한 경우를 상속으로 잘못 읽는다 —
  // board-presentation.js가 sources를 따로 들고 있는 것과 같은 이유다.
  const origins = workflowOrigins((config.sources || []).map(({ scope, file }) => ({ scope, parsed: readJson(file) })));
  const id = boundWorkflowId(config, 'task', kind);
  const definition = id && config.workflows ? config.workflows[id] : null;
  return {
    config,
    origins,
    id,
    label: (definition && definition.label) || null,
    // 배정이 없으면 내장으로 떨어진다. 떨어졌다는 사실을 값으로 남기지 않으면 화면은
    // 자기가 무엇을 보고 있는지 모른 채 그린다.
    origin: (id && origins.workflows[id] && origins.workflows[id].entry) || 'builtin',
    engine: workflowFor(config, 'task', kind)
  };
}

/**
 * 그 태스크가 탈 흐름과 그 흐름이 어디서 왔는지. 판정 엔드포인트가 쓴다.
 *
 * 설정이 깨졌으면 그대로 던진다. 직접 물은 물음에 내장의 답을 돌려주면 그것은 틀린
 * 답이고, 물은 사람은 자기 설정이 도는 줄 알게 된다.
 */
function taskWorkflow(start, projectKey, kind) {
  const resolved = resolveTaskWorkflow(start, projectKey, kind);
  return { id: resolved.id, label: resolved.label, origin: resolved.origin, engine: resolved.engine };
}

/**
 * 스냅숏에 실릴 워크플로. 화면이 상태·전환 다이어그램을 그리는 데 필요한 것이 전부
 * 여기 있어야 한다 — 모자라면 화면이 모자란 만큼을 자기 사본으로 채운다.
 *
 * 배정 표를 함께 싣는다. 출처가 배정까지 답하는데 배정 자체가 없으면 화면은 "이 칸이
 * 어디서 왔는가"만 알고 그 칸이 무엇인지는 모른다.
 *
 * 항목 유형을 가리지 않고 기본 배정을 묻는다. 보드가 그리는 판은 한 프로젝트의 태스크
 * 전체이고, 유형마다 흐름이 갈리는 프로젝트에서 "이 태스크는 어느 흐름인가"는 판정
 * 엔드포인트가 태스크마다 답한다.
 */
function boardWorkflow(start, projectKey) {
  let resolved;
  try {
    resolved = resolveTaskWorkflow(start, projectKey, null);
  } catch (error) {
    // 설정 한 줄이 틀렸다고 보드 전체를 닫지 않는다. 다만 조용히 내장으로 떨어지면
    // 화면은 자기가 내장을 보고 있다는 것을 모른 채 그리고, 그것은 이 갈래가 고치는
    // 버그와 같은 모양이다 — 그래서 떨어졌다는 사실과 이유를 함께 싣는다.
    return Object.assign(workflowFor({ workflows: {}, bindings: {} }, 'task', null).taskWorkflowView(), {
      id: null,
      label: null,
      origin: 'builtin',
      bindings: {},
      sources: workflowOrigins([]),
      error: error.message
    });
  }
  return Object.assign(resolved.engine.taskWorkflowView(), {
    id: resolved.id,
    label: resolved.label,
    origin: resolved.origin,
    bindings: (resolved.config.bindings && resolved.config.bindings.task) || {},
    sources: resolved.origins,
    error: null
  });
}

module.exports = { canonicalJson, canonicalRevision, entityRevision, documentRevision, documentRevisions, projectRevision, listDocuments, syncStatus, boardWorkflow, taskWorkflow };
