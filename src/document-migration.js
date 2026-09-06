'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { CANONICAL_PATHS, canonicalDocumentPath } = require('./document-paths');
const { DOCUMENT_STATE_KEYS, DOCUMENT_LIFECYCLE_KEYS, REVISION_FORMULAS } = require('./vocabulary');
const ID_RE = /\b(PRD|REQ|ARC|SCR|MOD|IFC|STD|API|ADR|TST|RUN|GLS|NTE)-(\d{3,})\b/u;

// ── state 칸이 나눠 쓰던 두 축을 푼다 ──────────────────────────────────
//
// 한 칸이 두 가지를 말하고 있었다. 작성이 어디까지 갔는가(draft·proposed)와 내용이
// 아직 서 있는가(active·accepted)다. 앞엣것은 이제 원장이 답하고 rdl이 state에
// 투영하며, 뒤엣것은 원장이 모르는 축이라 lifecycle이라는 자기 칸으로 나간다.
//
// 이 이관이 지켜야 하는 것은 하나다. **원장이 정본이다.** 그래서 이 파일이 state에
// 쓸 수 있는 값은 아래 하나뿐이고, 그것은 아무것도 주장하지 않는 값이다. 제출도
// 승인도 말하지 않으므로 원장에 없는 사실을 파일이 말하게 되는 경로가 닫힌다.
//
// 실제로 이 저장소의 파일과 원장은 이미 갈려 있다. 원장은 151건 중 승인 1 · 낡음 2를
// 알고 나머지 148건은 미승인인데, 파일은 15건이 accepted를 57건이 active를 적고 있다.
// 이관이 그 15건에 state: approved를 써 넣으면 원장에 없는 승인이 파일에서 태어난다.
// 낮게 적은 것은 다음 투영이 올려 주지만, 높게 적은 것은 그때까지 거짓말을 한다.

/**
 * 원장에 사건이 하나도 없는 문서의 투영값. 이관이 state에 쓰는 유일한 값이다.
 *
 * 투영 자체는 다른 갈래가 소유한다. 여기서 이 값을 아는 것은 "이관은 상태를 정하지
 * 않는다"를 지키기 위해서지 투영을 흉내 내기 위해서가 아니다 — 그래서 이 상수를
 * 옮기는 일이 생기면 그것은 투영이 바뀌는 날이고, 그날 이 줄이 먼저 걸려야 한다.
 * scaffold(document.js)도 같은 값을 쓴다. 새로 만든 문서도 원장에 사건이 없기
 * 때문이며, 두 곳이 다른 값을 쓰면 만든 문서와 옮긴 문서가 다른 바닥에 선다.
 */
const INITIAL_DOCUMENT_STATE = 'draft';
// 어휘 밖으로 나가면 적재 시점에 넘어진다. 시험이 아니라 모듈 자신에게 두는 이유는
// migration-map.js가 같은 자리에 같은 단언을 둔 이유와 같다 — 돌지 않는 시험은
// 통과한 시험과 구분되지 않는다.
if (!DOCUMENT_STATE_KEYS.includes(INITIAL_DOCUMENT_STATE)) {
  throw new Error(`이관이 쓰는 초기 상태가 어휘 밖입니다: ${INITIAL_DOCUMENT_STATE}`);
}

/**
 * 지금 적힌 state 값 하나를 두 축으로 가른다. 파일도 원장도 읽지 않는다.
 *
 *   수명 어휘   active·accepted·superseded·deprecated·archived
 *               → lifecycle로 그대로 옮기고 state는 바닥으로 내린다.
 *               값을 고르지 않고 그대로 옮기는 것이 요점이다. 옮기면 되돌릴 수 있고,
 *               "이건 굳이 안 적어도 되겠지" 하고 버리면 되돌릴 수 없다. 무엇을 비워
 *               둘지는 적은 사람이 정할 일이지 이관이 정할 일이 아니다.
 *   상태 어휘   draft·proposed·approved·stale·rejected
 *               → 손대지 않는다. 이미 진행 축의 값이고 다음 투영이 답한다.
 *   그 밖       → 옮기지 않고 옮길 자리가 없다고 말한다. 조용히 바닥으로 접으면
 *               이관이 아무도 묻지 않은 질문을 대신 답해 버리고, 그 사실은 아무
 *               신호도 내지 않는다.
 */
function splitDocumentState(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) return { axis: null, reason: 'absent', state: null, lifecycle: null };
  if (DOCUMENT_LIFECYCLE_KEYS.includes(text)) return { axis: 'lifecycle', reason: null, state: INITIAL_DOCUMENT_STATE, lifecycle: text };
  if (DOCUMENT_STATE_KEYS.includes(text)) return { axis: 'state', reason: null, state: text, lifecycle: null };
  return { axis: null, reason: 'unmapped', state: null, lifecycle: null };
}

// frontmatter 블록의 경계. 여는 줄과 첫 닫는 줄 사이만 손댄다 — 본문에도 `state:`로
// 시작하는 줄이 있을 수 있고(이 저장소의 문서들이 실제로 그렇다), 본문을 고치면
// 이관이 사람이 쓴 글을 바꾼다.
//
// 줄 끝의 \r를 지우지 않고 남긴다. CRLF 파일을 LF로 정규화해 다시 쓰면 손대지 않은
// 149줄이 전부 바뀐 것으로 보이고, 그 diff에서는 무엇이 옮겨졌는지 읽을 수 없다.
function frontmatterBlock(source) {
  const bom = source.startsWith('\uFEFF');
  const lines = (bom ? source.slice(1) : source).split('\n');
  if (!lines.length || lines[0].replace(/\r$/u, '') !== '---') return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/u, '') === '---') return { bom, lines, end: index };
  }
  return null;
}

function keyLine(lines, from, to, key) {
  const pattern = new RegExp(`^${key}:(?:[ \\t](.*))?\\r?$`, 'u');
  for (let index = from; index < to; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match) return { index, value: (match[1] || '').trim() };
  }
  return null;
}

/**
 * 파일 하나의 칸 분리를 계획한다. 바꾸지 않고 바뀔 내용을 돌려준다.
 *
 * 이미 lifecycle이 적힌 문서는 덮지 않는다. 사람이 적는 칸이므로 이관이 그 위에 쓰면
 * 사람의 판단을 기계가 지운다. state까지 수명 값이면 두 칸이 서로 다른 말을 할 수
 * 있으니 고르지 않고 갈렸다고 말한다 — 결정이 필요한 자리는 결정으로 남긴다.
 */
function planStateSplit(source) {
  const block = frontmatterBlock(source);
  if (!block) return null;
  const { lines, end } = block;
  const state = keyLine(lines, 1, end, 'state');
  if (!state) return null;
  const split = splitDocumentState(state.value);
  const lifecycle = keyLine(lines, 1, end, 'lifecycle');
  // 계획에 실을 이름은 파일이 스스로 말하는 것을 쓴다. 이동 대상 목록에서 가져오면
  // 헌장처럼 그 목록 밖에 있는 문서가 이름 없이 보고되고, 그러면 사람이 계획을 읽고
  // 무엇이 바뀌는지 알 수 없다 — 계획을 먼저 내는 이유가 그것이다.
  const declared = keyLine(lines, 1, end, 'id');
  const id = declared ? declared.value.replace(/^['"]|['"]$/gu, '') || null : null;
  if (split.axis === 'lifecycle' && lifecycle) {
    return { changed: false, id, from: state.value, reason: 'lifecycle-conflict', existing: lifecycle.value };
  }
  if (split.axis !== 'lifecycle') {
    return { changed: false, id, from: state.value, reason: split.reason, existing: lifecycle ? lifecycle.value : null };
  }
  const eol = /\r$/u.test(lines[state.index]) ? '\r' : '';
  const next = lines.slice();
  next[state.index] = `state: ${split.state}${eol}`;
  // 수명은 상태 바로 아래 온다. 한 칸이 갈라져 나온 것이므로 형제로 붙어 있어야
  // 파일을 연 사람이 둘이 한 쌍임을 읽는다. 자리를 계산하지 않고 고정하면 이관을
  // 두 번 돌려도 같은 파일이 나온다.
  next.splice(state.index + 1, 0, `lifecycle: ${split.lifecycle}${eol}`);
  return {
    changed: true, id, from: state.value, reason: null,
    state: split.state, lifecycle: split.lifecycle,
    text: `${block.bom ? '\uFEFF' : ''}${next.join('\n')}`
  };
}

/**
 * 이 이관이 낡게 만들 승인. 계획 단계에서 답해야 하는 물음이다.
 *
 * `lifecycle`은 사람이 쓴 내용이라 REVISION_OWNED_FIELDS에 없고, 그래서 그 줄이 붙으면
 * 문서 리비전이 움직인다. 리비전이 움직이면 그 문서에 걸린 승인은 낡음이 된다.
 *
 * **이것은 결함이 아니라 축이다.** "이 결정이 이제 폐기됐다"는 내용 변경이 맞고, 내용이
 * 바뀌면 다시 봐야 한다. `lifecycle`을 소유 칸에 넣어 리비전에서 빼면 수명이 바뀌어도
 * 아무도 다시 안 본다 — 그것이 이 도구가 하는 일을 없애는 쪽이다.
 *
 * 고치지 않는 대신 **미리 말한다.** 이 저장소는 승인이 3건뿐이라 티가 안 나지만 45건이
 * 걸린 저장소에서는 사람이 그것을 다시 눌러야 하고, 지금 그럴 수 있는지는 몇 건인지가
 * 아니라 **어느 문서인지**를 봐야 판단할 수 있다. rdl doc identity가 같은 이유로
 * 계획 단계에서 "기존 승인이 낡습니다"를 먼저 말한다.
 *
 * 원장은 주입으로 받는다. migrateProject가 validate를 주입으로 받는 것과 같은 이유다 —
 * 이 모듈이 원장 경로와 작업공간 탐색을 알기 시작하면 프로젝트 루트 하나로 부르던
 * 자리가 전부 작업공간을 알아야 한다.
 *
 * **묻지 않은 것과 0건인 것은 다르다.** 주입이 없거나 원장을 읽지 못하면 "낡는 승인이
 * 없다"고 말하지 않고 재지 못했다고 말한다. 접으면 승인 45건이 걸린 저장소에서 사람이
 * 안심하고 --apply를 친다.
 */
function approvalImpact(root, writes, provider) {
  const written = writes.filter((item) => /\.md$/iu.test(item.file));
  if (!written.length) return { atRisk: [], note: null };
  if (typeof provider !== 'function') {
    return { atRisk: [], note: `승인 영향을 재지 못했습니다: 원장을 묻지 않았습니다. 고치는 문서 ${written.length}건 중 몇 건의 승인이 낡는지 알 수 없습니다.` };
  }
  let ledger;
  try { ledger = provider(); }
  catch (error) { return { atRisk: [], note: `승인 영향을 재지 못했습니다: ${error.message}` }; }
  const trust = new Map();
  for (const entry of (ledger && ledger.documents) || ledger || []) {
    if (entry && entry.id) trust.set(String(entry.id), entry);
  }
  const { documentRevisions } = require('./board-data');
  const revisionsOf = (text) => {
    const front = parseFrontmatter(String(text).replace(/^\uFEFF/u, ''));
    return front ? documentRevisions(front.data, front.body) : null;
  };
  const atRisk = [];
  let spared = 0;
  for (const item of written) {
    const entry = item.id ? trust.get(String(item.id)) : null;
    if (!entry || entry.status !== 'approved') { spared += 1; continue; }
    // 리비전이 실제로 움직이는지 재어 본다. 재지 않고 단정하면 이 목록은 겁만 주고,
    // 겁만 주는 목록은 곧 읽히지 않는다. 소유 칸(state)만 바뀐 쓰기는 판 2를 움직이지
    // 않으므로 그 문서의 판 2 승인은 그대로 산다.
    const before = revisionsOf(item.source);
    const after = revisionsOf(item.changed);
    const moved = before && after ? REVISION_FORMULAS.filter((formula) => before[formula] !== after[formula]) : REVISION_FORMULAS.slice();
    if (!moved.length) { spared += 1; continue; }
    atRisk.push({
      id: item.id,
      file: path.relative(root, item.file).replace(/\\/g, '/'),
      approvedBy: entry.approvedBy || null,
      movedFormulas: moved.join('·')
    });
  }
  atRisk.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const note = atRisk.length
    ? `이 이관으로 승인 ${atRisk.length}건이 낡습니다. 낡은 승인은 사람이 다시 눌러야 합니다. 함께 고치는 나머지 ${spared}건은 잃을 승인이 없습니다.`
    : `낡는 승인은 없습니다. 이관이 고치는 ${spared}건은 승인이 없거나 이미 낡았습니다.`;
  return { atRisk, note };
}

// 이름이 바뀐 유형 코드. 이름만 바꾸고 이관 경로를 내지 않으면, 올리는 것만으로 기존
// 프로젝트의 문서가 알 수 없는 유형이 된다. 그래서 이관은 파일을 옮기는 데서 그치지 않고
// ID, kind, 태그와 그 문서를 가리키는 모든 참조를 함께 옮긴다 — 문서만 옮기고 참조를
// 남기면 링크가 없는 문서를 가리킨다.
const RENAMED_TYPE_CODES = Object.freeze({ API: 'IFC' });
const RENAMED_KINDS = Object.freeze({ api: 'interface' });
const RENAMED_ID_RE = /\b(API)-(\d{3,})\b/gu;
const RENAMED_KIND_RE = /^kind:[ \t]*(api)[ \t]*$/gmu;
const RENAMED_TAG_RE = /^([ \t]*-[ \t]*)artifact\/(api)[ \t]*$/gmu;

function renameIds(text) {
  return String(text).replace(RENAMED_ID_RE, (whole, code, number) => `${RENAMED_TYPE_CODES[code]}-${number}`);
}

function renameContent(text) {
  return renameIds(text)
    .replace(RENAMED_KIND_RE, (whole, kind) => `kind: ${RENAMED_KINDS[kind]}`)
    .replace(RENAMED_TAG_RE, (whole, prefix, kind) => `${prefix}artifact/${RENAMED_KINDS[kind]}`);
}

function files(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.rundol' || entry.name === '.obsidian') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...files(file));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(file);
  }
  return out;
}

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function rewrite(source, targets) {
  // 옛 유형 코드를 먼저 새 코드로 바꾼다. 이 다음의 링크 대조는 새 이름 기준이고,
  // targets도 새 이름으로 만들어져 있다.
  let output = renameContent(source);
  output = output.replace(/\[\[([^|\]#]+)(#[^|\]]+)?(\|[^\]]+)?\]\]/gu, (whole, rawTarget, anchor, label) => {
    // 표 칸 안의 위키링크는 구분자를 `\|`로 escape한다. 그 역슬래시를 대상 이름의
    // 일부로 읽으면 다시 쓸 때 사라지고, escape가 풀린 `|`는 그 줄에서 표의 칸
    // 구분자가 되어 표가 깨진다. 정본 GLS-002의 용어 표가 실제로 그 모양이라,
    // 이관을 돌리는 것만으로 사람이 쓴 표 한 줄이 무너진다.
    //
    // 경로 구분자로 쓰인 역슬래시와 헷갈리지 않는다. 여기서 떼는 것은 라벨 구분자
    // 바로 앞의 하나뿐이고, 경로가 그 자리에서 끝나는 일은 없다.
    let target = rawTarget;
    let section = anchor || '';
    let escape = '';
    if (label) {
      if (section.endsWith('\\')) { section = section.slice(0, -1); escape = '\\'; }
      else if (!section && target.endsWith('\\')) { target = target.slice(0, -1); escape = '\\'; }
    }
    const normalized = target.replace(/\\/g, '/').replace(/\.md$/iu, '');
    const replacement = targets.get(normalized) || targets.get(path.posix.basename(normalized));
    return replacement ? `[[${replacement}${section}${escape}${label || ''}]]` : whole;
  });
  return output;
}

// 태스크 저장소. 단일 파일이거나 Client별 샤드 디렉터리다. 문서 이관이 여기까지
// 닿아야 태스크의 문서 링크가 함께 옮겨진다.
function taskStoreFiles(root) {
  const directory = path.join(root, 'tasks');
  if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
    const found = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name.endsWith('.json')) found.push(file);
      }
    };
    walk(directory);
    return found;
  }
  const single = path.join(root, 'tasks.json');
  return fs.existsSync(single) ? [single] : [];
}

function planMigration(projectRoot, options) {
  const settings = options || {};
  const root = path.resolve(projectRoot);
  const moves = [];
  const conflicts = [];
  const roots = [path.join(root, 'docs'), path.join(root, 'inbox')];
  const markdown = roots.flatMap((directory) => files(directory));
  const all = markdown.filter((file) => path.basename(file) !== 'project.md');
  const ids = new Map();
  const documents = [];
  for (const file of all) {
    const source = fs.readFileSync(file, 'utf8');
    const frontmatter = parseFrontmatter(source.replace(/^\uFEFF/u, ''));
    const filenameMatch = ID_RE.exec(path.basename(file));
    const id = frontmatter && typeof frontmatter.data.id === 'string' ? frontmatter.data.id : null;
    if (!filenameMatch && !id) continue;
    if (!filenameMatch || !id || id !== `${filenameMatch[1]}-${filenameMatch[2]}`) {
      conflicts.push({ id: id || (filenameMatch && `${filenameMatch[1]}-${filenameMatch[2]}`) || null, source: file, reason: 'filename-frontmatter-mismatch' });
      continue;
    }
    // 충돌 판정과 이후의 모든 이름은 새 코드 기준이다. 옛 이름으로 판정하면 옛
    // API-001과 새 IFC-001이 같은 문서가 되려는 것을 놓친다.
    const canonicalId = renameIds(id);
    if (ids.has(canonicalId)) conflicts.push({ id: canonicalId, source: file, target: ids.get(canonicalId) });
    else ids.set(canonicalId, file);
    documents.push({ file, source, id: canonicalId, type: RENAMED_TYPE_CODES[filenameMatch[1]] || filenameMatch[1] });
  }
  for (const document of documents) {
    const { file, id, type } = document;
    const target = path.join(canonicalDocumentPath(type, root), renameIds(path.basename(file)));
    if (path.resolve(file) === path.resolve(target)) continue;
    if (fs.existsSync(target) && path.resolve(target) !== path.resolve(file)) conflicts.push({ id, source: file, target });
    moves.push({ id, type, source: file, target, from: path.relative(root, file).replace(/\\/g, '/'), to: path.relative(root, target).replace(/\\/g, '/') });
  }
  const targets = new Map();
  for (const document of documents) {
    const stem = renameIds(path.basename(document.file, '.md'));
    const relativeStem = renameIds(path.relative(root, document.file).replace(/\\/g, '/').replace(/\.md$/iu, ''));
    targets.set(document.id, stem);
    targets.set(relativeStem, stem);
    targets.set(path.posix.basename(relativeStem), stem);
  }
  const rewrites = [];
  const fields = [];
  const unmappedStates = [];
  const internalRewrites = [];
  const idOf = new Map(documents.map((document) => [path.resolve(document.file), document.id]));
  // 헌장도 state를 가진 문서다. 그런데 위의 documents 목록은 project.md를 뺀다 —
  // 헌장은 3자리 코드도 번호도 없어 이동 대상이 아니기 때문이다. 칸 분리는 이동과
  // 다른 축이므로 여기서 다시 주워 담는다. 빼면 헌장 하나만 어휘 밖 state로 남고,
  // 그것을 고칠 명령이 없어 사람이 손으로 정본을 고치게 된다.
  //
  // 링크 재작성은 걸지 않는다. 대조표(targets)는 이동 대상 목록에서 나오고 헌장은
  // 그 목록 밖이므로, 여기서 링크까지 손대면 이 갈래가 정하지 않은 판정을 함께
  // 들이게 된다. 헌장의 링크는 헌장을 이동 대상으로 삼는 날 함께 정한다.
  const charter = path.join(root, 'project.md');
  const linkTargets = new Set(markdown.concat(taskStoreFiles(root)).map((file) => path.resolve(file)));
  const scanned = Array.from(linkTargets);
  if (fs.existsSync(charter) && !linkTargets.has(path.resolve(charter))) scanned.push(path.resolve(charter));
  // 문서만 고치면 절반이다. 태스크가 문서를 가리키는 링크에도 옛 유형 코드가 있고,
  // 그것을 남기면 이관이 끝난 뒤에 태스크가 없는 문서를 가리킨다 — 이름을 바꾸는
  // 변경은 그 이름을 쓰는 모든 자리를 함께 옮겨야 이관이다.
  for (const file of scanned) {
    const source = fs.readFileSync(file, 'utf8');
    let changed = linkTargets.has(file) ? rewrite(source, targets) : source;
    const linked = changed !== source;
    if (linked) rewrites.push({ file, replacements: (source.match(/\[\[/gu) || []).length });
    // 칸 분리는 링크 재작성 뒤에 돈다. 두 변경이 같은 파일에 걸리면 한 번의 쓰기로
    // 나가야 하고, 순서가 반대면 링크 재작성이 방금 넣은 lifecycle 줄을 다시 훑는다.
    // 마크다운이 아닌 태스크 샤드에는 걸지 않는다 — frontmatter가 없어 무시되겠지만,
    // "무시되니까 괜찮다"는 다음 사람이 JSON에 `state:` 문자열을 넣는 날 깨진다.
    const split = /\.md$/iu.test(file) ? planStateSplit(changed) : null;
    if (split && split.changed) {
      changed = split.text;
      fields.push({
        id: idOf.get(file) || split.id,
        file: path.relative(root, file).replace(/\\/g, '/'),
        from: split.from, state: split.state, lifecycle: split.lifecycle
      });
    } else if (split && (split.reason === 'unmapped' || split.reason === 'lifecycle-conflict')) {
      // 옮길 자리가 없는 값은 바닥으로 접지 않고 값으로 내보낸다. 접는 순간 이관이
      // 아무도 묻지 않은 질문을 대신 답해 버리고, 그 사실은 아무 신호도 내지 않는다.
      unmappedStates.push({
        id: idOf.get(file) || split.id,
        file: path.relative(root, file).replace(/\\/g, '/'),
        state: split.from, lifecycle: split.existing || null, reason: split.reason
      });
    }
    // id를 함께 싣는다. 승인 영향 판정이 파일과 원장을 잇는 열쇠이고, 헌장은 위의
    // 이동 대상 목록 밖이라 idOf로는 이름이 나오지 않는다.
    if (changed !== source) internalRewrites.push({ file, source, changed, id: idOf.get(file) || (split && split.id) || null });
  }
  unmappedStates.sort((left, right) => String(left.file).localeCompare(String(right.file)));
  fields.sort((left, right) => String(left.file).localeCompare(String(right.file)));
  // 옮길 자리가 없는 값은 clean을 흐리지 않는다. clean은 "이 명령이 더 할 일이
  // 있는가"이고, 미매핑은 사람이 값을 정해야 풀리므로 이 명령을 몇 번 더 돌려도
  // 그대로다. 거기에 얹으면 영영 지워지지 않는 잔소리가 되고, 그런 신호는 곧 무시된다.
  const approvals = approvalImpact(root, internalRewrites, settings.approvals);
  const plan = {
    root, moves, rewrites, fields, conflicts, unmappedStates,
    // 승인 영향은 계획의 일부다. --apply 뒤에 알리면 되돌릴 수 없는 것을 알린 것이
    // 되고, 낡은 승인은 사람이 다시 눌러야만 돌아온다.
    approvalsAtRisk: approvals.atRisk, approvalNote: approvals.note,
    clean: moves.length === 0 && rewrites.length === 0 && fields.length === 0 && conflicts.length === 0
  };
  Object.defineProperty(plan, 'internalRewrites', { value: internalRewrites, enumerable: false });
  return plan;
}

function migrateProject(projectRoot, options) {
  const plan = planMigration(projectRoot, options);
  if (!options || options.apply !== true) return Object.assign({}, plan, { dryRun: true, applied: false });
  if (plan.conflicts.length) throw new Error(`문서 ID 중복으로 migration을 적용할 수 없습니다: ${plan.conflicts.map((item) => item.id).join(', ')}`);
  const changed = [];
  const written = [];
  const createdDirectories = new Set();
  const baseline = typeof options.validate === 'function' ? options.validate() : null;
  const errorIdentity = (item) => `${item.code}|${item.artifactId || ''}|${item.target || ''}|${item.message || ''}`;
  const baselineErrors = new Set(((baseline && baseline.diagnostics) || []).filter((item) => item.severity === 'error').map(errorIdentity));
  try {
    for (const item of plan.moves) {
      const directory = path.dirname(item.target);
      if (!fs.existsSync(directory)) createdDirectories.add(directory);
      fs.mkdirSync(directory, { recursive: true });
      fs.renameSync(item.source, item.target);
      changed.push(item);
    }
    for (const item of plan.internalRewrites) {
      const file = plan.moves.find((move) => path.resolve(move.source) === path.resolve(item.file))?.target || item.file;
      atomicWrite(file, item.changed);
      written.push({ file, source: item.source });
    }
    if (typeof options.validate === 'function') {
      const validation = options.validate();
      const introduced = ((validation && validation.diagnostics) || []).filter((item) => item.severity === 'error' && !baselineErrors.has(errorIdentity(item)));
      if (introduced.length) throw new Error(`migration strict validation 실패: 신규 오류 ${introduced.length}개`);
    }
  } catch (error) {
    for (const item of written) if (fs.existsSync(item.file)) atomicWrite(item.file, item.source);
    for (const item of changed.reverse()) { if (fs.existsSync(item.target)) fs.renameSync(item.target, item.source); }
    for (const directory of Array.from(createdDirectories).sort((left, right) => right.length - left.length)) {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    }
    throw error;
  }
  return Object.assign({}, plan, { dryRun: false, applied: true });
}

module.exports = {
  CANONICAL_PATHS, canonicalDocumentPath, planMigration, migrateProject,
  INITIAL_DOCUMENT_STATE, splitDocumentState, planStateSplit
};
