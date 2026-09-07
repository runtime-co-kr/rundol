'use strict';

// 문서·태스크·원장을 한 질의로 찾는 엔진.
//
// 지금까지 검색은 화면마다 자기 목록을 거르는 입력이었다. 문서 화면에서는 문서를,
// 태스크 화면에서는 태스크를 걸렀고, 화면을 옮기면 같은 낱말이 다른 일을 했으며
// 원장은 어느 화면에서도 대상이 아니었다. 그런데 "왜 이렇게 됐나"의 답이 모이는
// 자리가 바로 원장이다 — 승인 사유, 제출 사유, 반려 사유, 태스크 댓글. 그 물음에
// 답할 길이 화면에 하나도 없었다.
//
// ── 무엇을 대상에 넣고 무엇을 뺐는가 ───────────────────────────────────
//
// 넣은 것: 사람이 쓴 글과 사람이 부르는 이름뿐이다.
//
//   문서   제목 · 설명 · 본문 · 식별자
//   태스크 제목 · 요약 · 완료조건 · 대기 사유 · 반려 사유 · 면제 사유 · 식별자
//   원장   승인 사유 · 승인 근거 상세 · 제출 사유 · 반려 사유 · 댓글 · 댓글 정정 사유
//
// 뺀 것과 그 이유:
//
//   리비전 해시(64자리) · eventId · requestId · canonicalDigest — 기계 값이다.
//   16진 해시는 [0-9a-f]로만 이루어져 있어서 "add", "face", "dead" 같은 낱말이
//   문서 157건의 해시 조각에 전부 걸린다. 한 번 걸리기 시작하면 결과 목록이
//   해시로 뒤덮여 사람이 쓴 글이 밀려난다 — 검색이 쓰레기가 되는 가장 빠른 길이다.
//
//   시각(recordedAt · occurredAt · modifiedAt) — "2026"을 치면 전건이 나온다.
//   기간으로 좁히는 것은 검색이 아니라 거르개의 일이고, 축이 다르다.
//
//   Client 식별자 · 파일 경로 — 경로에는 유형 디렉터리 이름이 박혀 있어서
//   "requirements"를 치면 요구사항 문서 전건이 경로로 걸린다. 그것은 검색 결과가
//   아니라 목록이다.
//
//   태그(rundol/artifact · domain/rundol) · 상태값 · 우선순위 · 유형 —
//   같은 값이 전건에 붙어 있어 질의를 좁히지 못한다. 이것들은 거르개의 축이다.
//
//   담당자·검토자 같은 MEMBER 식별자와 links·deps의 문서 참조 — 관계이지 글이
//   아니다. "이 문서를 참조하는 태스크"는 별도의 물음이며 검색이 대신 답하면
//   두 물음의 답이 한 목록에 섞인다.
//
//   원장의 기계 원장 셋 — lease · 문서 번호 예약(sequences) · 규칙 발화(firing)는
//   파일을 열지도 않는다. 사람이 쓴 칸이 한 칸도 없기 때문이고, 이 저장소에서
//   원장 파일 177개 중 172개가 여기에 속한다.
//
// ── 출처를 어떻게 밝히는가 ─────────────────────────────────────────────
//
// 결과 하나는 "어디서 왔는지"(origin)와 "무엇에 붙은 것인지"(attachedTo)를 함께
// 든다. 원장 줄은 그 자체로는 읽을 수 없다 — "전체"라는 승인 사유 한 줄만 보면
// 아무 뜻이 없고, `REQ-064의 승인 사유`라야 뜻이 선다. 붙은 대상은 이미 읽어 둔
// 문서·태스크 목록에서 제목까지 해소하며, 해소되지 않으면 없는 것으로 적지 않고
// found: false로 적는다 — 지워진 태스크의 댓글과 아직 안 읽은 태스크의 댓글은
// 다르고, 앞엣것을 조용히 버리면 그 논의는 어디에서도 다시 보이지 않는다.
//
// 문서·태스크 결과도 attachedTo를 갖고 그것은 자기 자신이다. 모양을 갈라 두면
// 화면이 출처 줄을 두 벌 그려야 하고, 두 벌은 언젠가 갈라진다.
//
// ── 맞은 자리를 어떻게 보이는가 ────────────────────────────────────────
//
// 발췌는 맞은 자리를 가운데 두고 140자다. 이 길이는 한 줄에 들어가면서 앞뒤
// 맥락이 남는 폭이다 — 더 짧으면 낱말만 보이고 어느 문장인지 모르며, 더 길면
// 목록이 아니라 본문이 된다. 잘린 쪽에는 …을 붙여 잘렸다는 사실을 값이 말한다.
//
// 강조는 HTML이 아니라 구간([시작, 길이])으로 낸다. 서버가 <mark>를 박아 보내면
// 화면은 그것을 innerHTML로 넣어야 하고, 그 순간 문서 본문에 든 <script>가 그대로
// 실행된다. 구간으로 주면 화면이 텍스트 노드를 쪼개 <mark>를 만들 수 있어
// 강조와 안전이 함께 선다. 오프셋은 발췌 문자열 기준이다.
//
// ── 순서 ───────────────────────────────────────────────────────────────
//
// 칸마다 무게가 다르다. 제목이 맞은 것과 본문이 맞은 것은 같은 사건이 아니다 —
// 제목은 그 글이 무엇에 대한 것인지이고 본문은 그 글이 그 낱말을 지나갔다는 것뿐이다.
// 여기에 "칸 전체가 질의와 같다 · 칸의 첫머리다 · 낱말 경계에서 시작한다" 세 가산과
// 여러 번 맞은 것의 작은 가산을 더한다. 동점은 출처·식별자로 가른다 — 질의를 다시
// 쳤을 때 순서가 흔들리면 사람이 훑던 자리를 잃는다.
//
// ── 인덱스를 쓰지 않는 이유 ────────────────────────────────────────────
//
// REQ-041이 조회 인덱스를 "삭제 가능한 캐시이고 정확성의 기준은 언제나 무인덱스
// 경로"로 못박았고, 그 규칙 5는 "인덱스는 조인 키만 갖고 원본 내용을 복제하지
// 않는다. 상세가 필요하면 정본을 읽는다"이다. 검색이 필요로 하는 것은 본문·요약·
// 완료조건·사유 곧 상세 그 자체라 인덱스에 있을 수 없고, 있어서도 안 된다.
//
// 게다가 같은 문서가 적어 둔 실측이 인덱스 유효성 확인만 259ms인데(git 하위
// 프로세스 두 번) 이 저장소에서 정본을 통째로 읽는 검색 한 번이 100ms다. 확인이
// 읽기보다 비싸면 캐시는 가속이 아니라 감속이다.
//
// 그래서 이 엔진은 언제나 정본을 읽고, 인덱스가 있든 없든 낡았든 손상됐든 같은
// 답을 낸다. REQ-041의 감사 기록 조항대로 그 사실을 index 칸에 적어 낸다.
//
// ── 비싸지 않게 ────────────────────────────────────────────────────────
//
// 비용을 재 보면(실제 저장소, 문서 157건·태스크 144건·원장 177파일):
//
//   문서 전건 읽기      95ms   (본문 1.2MB 포함)
//   태스크 저장소 읽기   3ms
//   승인 원장            1ms   (2파일)
//   댓글 원장            2ms   (3파일)
//
// 원장이 싼 이유는 파일 177개를 다 열지 않기 때문이다. eventStore가 kind별
// 디렉터리를 나눠 두었으므로 사람이 쓴 칸을 가진 kind 둘만 열면 5파일이다. 이것이
// "매 글자마다 전부 읽으면 못 쓴다"에 대한 답이고, 디렉터리를 훑어 파일마다
// 열어 보는 구현이었다면 여기서 177파일이 매 글자마다 열렸을 것이다.
//
// 남은 비용은 문서 읽기이고 그것은 보드 스냅숏이 폴링마다 이미 치르는 값과 같다.
// 캐시를 얹지 않은 것은 캐시가 낡은 채로 유효하다고 답하는 것이 느린 것보다
// 나쁘기 때문이다 — 문서 읽기가 300ms를 넘으면 그때 다시 재고 정한다.

const path = require('path');
const eventStore = require('./event-store');
const { workspaceLayout, selectProject } = require('./workspace');
const { listDocuments } = require('./board-data');
const { readTaskStore } = require('./tasks');

// 한 글자에 전건이 나오면 그것은 검색이 아니라 목록이다. 그렇다고 오류도 아니다 —
// 사람이 두 글자를 치는 도중에 반드시 지나는 상태이므로, 거절이 아니라 "아직
// 이르다"는 상태로 답한다. 화면은 그 상태를 보고 안내를 그린다.
const MIN_QUERY_LENGTH = 2;
// 문단을 통째로 붙여 넣은 것은 질의가 아니라 실수다. 조용히 잘라 내면 사람은 자기가
// 무엇을 검색했는지 모른 채 빈 결과를 본다.
const MAX_QUERY_LENGTH = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// 발췌 폭. 맞은 자리를 가운데 두고 앞뒤 맥락이 남는 최소 폭이다.
const EXCERPT_WINDOW = 140;
const MAX_EXCERPTS_PER_FIELD = 3;
// 셈은 여기서 포화한다. 가산은 이미 5회에서 멈추고 발췌는 3개에서 멈추므로 그
// 위를 세는 일에는 값이 없고, 상한이 없으면 한 글자짜리 문자열로 본문을 훑는
// 병적인 질의가 그대로 비용이 된다.
const MAX_POSITIONS_PER_FIELD = 500;
// 출처 갈래와 그 이름. 화면이 이 셋으로 결과를 나누므로 목록의 정본을 여기 둔다.
//
// 값 어휘(vocabulary.js)가 아니라 여기 있는 이유는 이것이 저장되는 값이 아니라 이
// 엔진이 결과를 접는 축이기 때문이다. 원장 종류 목록(LEDGERS)과도 축이 다르다 —
// 승인 원장과 댓글 원장은 저장에서는 둘이지만 화면에서는 한 갈래로 접힌다. 이름을
// 함께 두는 이유는 화면이 라벨을 자기 사본으로 적지 않게 하기 위해서다.
const SOURCE_LABELS = Object.freeze({ document: '정본 문서', task: '태스크', ledger: '원장' });
const SEARCH_SOURCES = Object.freeze(Object.keys(SOURCE_LABELS));
// 잘라 낼 때 갈래마다 남겨 두는 최소 자리. 검토 인박스가 앞 50건에서 자르다가
// 절단면이 정렬 축과 겹쳐 특정 유형이 통째로 사라졌던 자국이 이 저장소에 있다.
// 검색의 절단면은 관련도라 그 자체는 옳지만, 화면이 "원장만" 같은 거르개를 실린
// 목록 위에서 돌리면 셈이 3이라고 말한 것을 목록에서 한 건도 찾지 못한다.
const SOURCE_FLOOR = 5;

// 칸의 무게. 제목이 맞은 것과 본문이 맞은 것은 무게가 다르다.
const FIELDS = Object.freeze({
  title: { weight: 100, label: '제목' },
  id: { weight: 90, label: '식별자' },
  description: { weight: 60, label: '설명' },
  summary: { weight: 60, label: '요약' },
  reason: { weight: 55, label: '사유' },
  comment: { weight: 55, label: '댓글' },
  basis: { weight: 45, label: '승인 근거' },
  acceptance: { weight: 40, label: '완료조건' },
  blocker: { weight: 40, label: '대기 사유' },
  cancellation: { weight: 40, label: '반려 사유' },
  exemption: { weight: 40, label: '면제 사유' },
  body: { weight: 30, label: '본문' },
  // 붙은 대상의 이름. 무게가 가장 낮은 이유는 이것이 그 결과 자신의 글이 아니기
  // 때문이다. 그래도 대상에 넣는 이유는 "ADR-020"을 쳤을 때 그 문서와 함께 그
  // 문서에 붙은 승인 사유·반려 사유가 같이 나와야 하기 때문이다 — 그것이
  // "데이터소스랑 문서가 같이 표현"의 실제 모양이다.
  attachment: { weight: 12, label: '붙은 대상' }
});

// 승인 원장의 세 종류와 댓글 원장의 두 종류. 표로 두는 이유는 다음 종류가 늘 때
// 코드가 아니라 줄 하나가 늘게 하기 위해서다 — 종류마다 분기를 적으면 그중 하나가
// 새 종류를 모르는 채로 남고, 모르는 채로 남은 자리는 아무 신호도 내지 않는다.
//
// 결정(decision)·위임(delegation) 원장도 사람이 쓴 reason을 갖지만 지금 이
// 저장소에는 한 건도 없다. 여기 미리 적어 두지 않는 이유는 시험되지 않은 표면을
// 여는 것보다 표를 한 줄 늘리는 편이 나중에 싸기 때문이다.
const LEDGER_SOURCES = Object.freeze([
  Object.freeze({
    ledger: 'approval',
    types: Object.freeze({
      'approval.granted': Object.freeze({ label: '승인 사유', attach: 'document', target: 'targetId', actor: 'approvedBy' }),
      'approval.submitted': Object.freeze({ label: '제출 사유', attach: 'document', target: 'targetId', actor: 'submittedBy' }),
      'approval.rejected': Object.freeze({ label: '반려 사유', attach: 'document', target: 'targetId', actor: 'rejectedBy' })
    })
  }),
  Object.freeze({
    ledger: 'comment',
    types: Object.freeze({
      'task.comment': Object.freeze({ label: '댓글', attach: 'task', target: 'taskId', actor: 'member' }),
      // 정정은 태스크가 아니라 다른 댓글에 붙는다. 그 댓글의 taskId를 거쳐야 태스크에
      // 닿으므로 대상 해소가 한 단계 더 있다(ledgerAttachment).
      'task.comment.corrected': Object.freeze({ label: '댓글 정정', attach: 'comment', target: 'targetEventId', actor: null })
    })
  })
]);

function searchInputError(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  if (code) error.code = code;
  throw error;
}

/**
 * 길이를 보존하는 소문자화.
 *
 * 발췌의 강조 구간은 접힌 문자열 위에서 재고 발췌는 원문에서 잘라내므로, 한 글자가
 * 두 글자로 늘어나는 문자(예: 튀르키예어 대문자 İ)가 하나라도 있으면 그 뒤의 강조가
 * 통째로 어긋난 자리를 가리킨다. 그래서 길이가 달라지면 글자 단위로 다시 접고,
 * 늘어나는 글자만 원래대로 둔다. 흔한 경우는 네이티브 한 번으로 끝난다.
 */
function foldCase(text) {
  const lowered = text.toLowerCase();
  if (lowered.length === text.length) return lowered;
  let result = '';
  for (const character of text) {
    const single = character.toLowerCase();
    result += single.length === character.length ? single : character;
  }
  return result;
}

/**
 * 견줄 수 있는 모양으로 접는다.
 *
 * NFC로 맞추는 이유는 같은 한글이 두 가지 바이트로 저장될 수 있기 때문이다. macOS에서
 * 만든 파일은 자모가 분리된 NFD로 들어오는 일이 있고, 그러면 브라우저에서 친 "가역성"이
 * 파일 안의 "가역성"과 한 글자도 맞지 않는다 — 맞아야 할 것이 안 맞는데 아무 신호도
 * 나지 않는 종류의 실패다.
 */
function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).normalize('NFC');
}

// 줄바꿈과 제어문자를 공백으로 바꾼다. 길이를 보존하는 1:1 치환이어야 한다 —
// \s+를 하나로 접으면 길이가 달라지고 강조 구간이 어긋난다.
function flatten(text) {
  return text.replace(/[\s\p{Cc}]/gu, ' ');
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function atWordBoundary(folded, position) {
  if (position === 0) return true;
  return !WORD_CHARACTER.test(folded[position - 1]);
}

/**
 * 한 칸에서 질의가 맞은 자리를 모두 찾는다.
 *
 * needle은 언제나 문자열이고 indexOf로만 쓴다. 정규식으로 만들지 않는 이유는 두
 * 가지다 — 사람이 친 `.*`나 `(?:`가 문법 오류로 검색을 죽이거나 반대로 전건에
 * 맞아 버리고, 중첩 수량자를 담은 질의는 그 자체로 서버를 세우는 입력이 된다.
 * 파일 경로로도 쓰지 않는다. 질의는 이 함수 밖으로 나가지 않는다.
 */
function fieldMatches(rawText, needle) {
  const source = normalizeText(rawText);
  if (!source) return null;
  const flat = flatten(source);
  const folded = foldCase(flat);
  const positions = [];
  let at = folded.indexOf(needle);
  while (at !== -1) {
    positions.push(at);
    if (positions.length >= MAX_POSITIONS_PER_FIELD) break;
    at = folded.indexOf(needle, at + needle.length);
  }
  if (!positions.length) return null;
  return { flat, folded, positions };
}

function buildExcerpts(flat, positions, length) {
  const windows = [];
  for (const position of positions) {
    const last = windows[windows.length - 1];
    // 가까운 두 자리는 한 발췌에 담는다. 나누면 거의 같은 문장이 세 번 실려
    // 목록이 같은 말을 반복한다.
    if (last && position >= last.start && position + length <= last.end) {
      last.ranges.push([position - last.start, length]);
      continue;
    }
    if (windows.length >= MAX_EXCERPTS_PER_FIELD) break;
    const pad = Math.max(0, Math.floor((EXCERPT_WINDOW - length) / 2));
    let start = Math.max(0, position - pad);
    const end = Math.min(flat.length, start + Math.max(EXCERPT_WINDOW, length));
    // 문자열 끝에 붙었으면 창을 앞으로 당겨 폭을 채운다. 당기지 않으면 마지막
    // 문장에서 맞은 결과만 발췌가 짧아져 목록의 줄 길이가 들쭉날쭉해진다.
    if (end - start < EXCERPT_WINDOW) start = Math.max(0, end - EXCERPT_WINDOW);
    windows.push({ start, end, ranges: [[position - start, length]] });
  }
  return windows.map((window) => {
    const head = window.start > 0 ? '…' : '';
    const tail = window.end < flat.length ? '…' : '';
    return {
      text: `${head}${flat.slice(window.start, window.end)}${tail}`,
      ranges: window.ranges.map(([offset, size]) => [offset + head.length, size])
    };
  });
}

function scoreField(field, folded, needle, positions) {
  const definition = FIELDS[field];
  if (!definition) throw new Error(`등록되지 않은 검색 칸입니다: ${field}`);
  let score = definition.weight;
  if (folded.length === needle.length) score += 40;
  else if (positions[0] === 0) score += 20;
  else if (atWordBoundary(folded, positions[0])) score += 10;
  score += Math.min(positions.length - 1, 5) * 2;
  return score;
}

/**
 * 한 항목의 칸들을 재어 결과 하나를 만든다. 아무 칸도 안 맞으면 null이다.
 *
 * 붙은 대상의 이름은 언제나 마지막 칸으로 함께 잰다. 그래야 "ADR-020"이 그 문서와
 * 그 문서에 붙은 원장 줄을 함께 데려온다.
 */
function buildHit(item, fields, needle) {
  const matches = [];
  let best = 0;
  let matchCount = 0;
  for (const entry of fields) {
    const found = fieldMatches(entry.text, needle);
    if (!found) continue;
    const score = scoreField(entry.field, found.folded, needle, found.positions);
    if (score > best) best = score;
    matchCount += found.positions.length;
    matches.push({
      field: entry.field,
      label: entry.label || FIELDS[entry.field].label,
      score,
      count: found.positions.length,
      excerpts: buildExcerpts(found.flat, found.positions, needle.length)
    });
  }
  if (!matches.length) return null;
  matches.sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
  return Object.assign({}, item, {
    // 여러 칸이 맞은 것은 한 칸만 맞은 것보다 이 질의에 가깝다. 다만 가산은 작다 —
    // 본문 세 군데가 맞았다고 제목이 맞은 것을 앞지르면 무게를 둔 뜻이 사라진다.
    score: best + Math.min(matches.length - 1, 3),
    matchCount,
    matches
  });
}

function documentTargets(documents) {
  const table = new Map();
  for (const document of documents) table.set(document.id, { id: document.id, title: document.title || null });
  return table;
}

function attachmentOf(table, kind, id) {
  const key = id === undefined || id === null ? null : String(id);
  if (!key) return null;
  const found = table.get(key);
  // 없는 것과 모르는 것을 가른다. 지워진 태스크의 댓글을 조용히 버리면 그 논의는
  // 어느 화면에도 다시 서지 않고, 제목을 지어내면 없는 사실을 화면이 말한다.
  return { kind, id: key, title: found ? found.title : null, found: Boolean(found) };
}

// ── 문서 ─────────────────────────────────────────────────────────────────

function documentHits(project, documents, needle) {
  const hits = [];
  for (const document of documents) {
    const self = { kind: 'document', id: document.id, title: document.title || null, found: true };
    const hit = buildHit({
      source: 'document',
      kind: 'document',
      project: project.key,
      id: document.id,
      title: document.title || document.id,
      origin: { kind: 'document', label: SOURCE_LABELS.document },
      attachedTo: self,
      // 화면이 결과를 눌러 문서를 열려면 파일이 필요하다. 대상에는 넣지 않고
      // 값으로만 낸다 — 경로가 대상에 들어가면 디렉터리 이름이 질의에 걸린다.
      file: document.file,
      documentKind: document.kind || null,
      state: document.state || null
    }, [
      // 붙은 대상 칸이 없다. 문서에 붙은 대상은 자기 자신이고, 제목·식별자를 이미
      // 재고 있으므로 한 번 더 재면 같은 글이 두 번 셈에 든다.
      { field: 'title', text: document.title },
      { field: 'id', text: document.id },
      { field: 'description', text: document.description },
      { field: 'body', text: document.body }
    ], needle);
    if (hit) hits.push(hit);
  }
  return hits;
}

// ── 태스크 ───────────────────────────────────────────────────────────────

function taskFields(task, id) {
  const fields = [
    { field: 'title', text: task.title },
    { field: 'id', text: id },
    { field: 'summary', text: task.summary }
  ];
  for (const [acceptanceId, criterion] of Object.entries(task.acceptanceCriteria || {})) {
    fields.push({ field: 'acceptance', label: `완료조건 ${acceptanceId}`, text: criterion && criterion.text });
  }
  // 대기 사유는 "지금 왜 안 나아가는가"의 답이라 사람이 가장 자주 찾는 글이다.
  // 대기 대상(waitingFor)은 MEMBER 식별자라 뺀다.
  if (task.blocker && task.blocker.condition) fields.push({ field: 'blocker', text: task.blocker.condition });
  // 반려 사유와 면제 사유는 태스크에 남은 사람의 판단이다. 오너의 물음("왜 이렇게
  // 됐나")이 정확히 이 글을 찾는 물음이라 대상에 넣는다. 면제 게이트 이름은 열거값이라 뺀다.
  if (task.cancellation && task.cancellation.reason) fields.push({ field: 'cancellation', text: task.cancellation.reason });
  if (task.exemption && task.exemption.reason) fields.push({ field: 'exemption', text: task.exemption.reason });
  return fields;
}

function taskHits(project, tasks, needle) {
  const hits = [];
  for (const [id, task] of tasks) {
    const self = { kind: 'task', id, title: task.title || null, found: true };
    const hit = buildHit({
      source: 'task',
      kind: 'task',
      project: project.key,
      id,
      title: task.title || id,
      origin: { kind: 'task', label: SOURCE_LABELS.task },
      attachedTo: self,
      status: task.status || null,
      priority: task.priority || null
    }, taskFields(task, id), needle);
    if (hit) hits.push(hit);
  }
  return hits;
}

// ── 원장 ─────────────────────────────────────────────────────────────────

// 사람이 쓴 칸만 뽑는다. 나머지 칸(eventId·requestId·리비전·다이제스트·시각·
// Client)은 이 함수를 지나지 못하므로 대상에 들어갈 길이 없다.
function ledgerFields(event) {
  const fields = [];
  if (event.type === 'task.comment') {
    fields.push({ field: 'comment', text: event.body });
    return fields;
  }
  if (event.reason) fields.push({ field: 'reason', text: event.reason });
  for (const item of Array.isArray(event.basis) ? event.basis : []) {
    // 근거 종류(read·check·verdict·delegated)는 열거값이라 대상이 아니고, 상세만
    // 사람이 쓴 글이다. 라벨에는 종류를 남긴다 — 어느 근거의 상세인지 없으면
    // 사람이 결과를 열어 봐야 안다.
    if (item && item.detail) fields.push({ field: 'basis', label: `승인 근거(${item.kind})`, text: item.detail });
  }
  return fields;
}

/**
 * 원장 줄이 붙은 대상. 정정은 한 단계를 더 거친다.
 *
 * 정정 이벤트는 태스크가 아니라 다른 댓글을 가리키므로, 그 댓글의 taskId를 통해야
 * 태스크에 닿는다. 그 댓글이 없으면 태스크를 지어내지 않고 원 댓글을 가리킨 채
 * found: false로 둔다 — 붙을 자리를 모르는 것과 아무 데도 안 붙은 것은 다르다.
 */
function ledgerAttachment(event, definition, targets, commentTaskById) {
  const value = event[definition.target];
  if (definition.attach !== 'comment') return attachmentOf(targets[definition.attach], definition.attach, value);
  const taskId = commentTaskById.get(String(value || ''));
  if (taskId) return attachmentOf(targets.task, 'task', taskId);
  return { kind: 'comment', id: value === undefined || value === null ? null : String(value), title: null, found: false };
}

/**
 * 원장에서 사람이 쓴 글을 찾는다.
 *
 * 접힌 상태가 아니라 원시 사건을 읽는다. 접기(foldApprovals)는 "이 문서가 지금
 * 승인되었는가"를 판정하는 일이고 검색은 "이 글이 원장 어디에 있는가"를 찾는 일이라
 * 물음이 다르다. 접힌 것만 보면 뒤에 뒤집힌 판단의 사유가 통째로 사라지는데, 그것이
 * 바로 "왜 이렇게 됐나"의 답이다.
 *
 * 대신 이 결과는 승인 상태를 주장하지 않는다. 화면이 이 값을 "이 문서는 승인됨"으로
 * 읽으면 검색이 다섯 번째 판정 표면이 되고, 다섯 번째는 나머지 넷과 조금씩 다른 답을
 * 낸다. 여기서 내는 것은 언제나 "원장의 이 사건에 이 글이 있다"까지다.
 */
function ledgerHits(layout, project, targets, needle) {
  const scanned = { read: false, reason: null, ledgers: [], records: 0 };
  if (layout.schemaVersion < 6) {
    // 원장을 못 읽어도 문서·태스크 검색은 돌아야 한다. 못 읽은 이유를 삼키면 원장이
    // 깨진 저장소와 원장을 안 쓰는 저장소가 화면에서 같아 보이고, 앞엣것은 고쳐야 할
    // 사고인데 아무도 그것을 모른다.
    scanned.reason = '이 작업공간은 원장을 갖기 전 판입니다.';
    return { hits: [], scanned };
  }
  const eventsRoot = path.join(layout.root, 'projects', 'workspace', 'events');
  const hits = [];
  const commentTaskById = new Map();
  const collected = [];
  for (const source of LEDGER_SOURCES) {
    let events;
    try {
      // dedupe는 켠 채로 둔다. 같은 사건이 여러 조각에 실려 있을 때 결과가 두 줄로
      // 나오면 사람은 같은 글이 두 번 적힌 줄 안다.
      events = eventStore.readEvents(eventsRoot, source.ledger, project.key, {});
    } catch (error) {
      // 한 원장이 깨져도 나머지는 답한다. 다만 깨졌다는 사실은 값으로 낸다.
      scanned.ledgers.push({ ledger: source.ledger, read: false, reason: error.message, records: 0 });
      continue;
    }
    scanned.read = true;
    scanned.ledgers.push({ ledger: source.ledger, read: true, reason: null, records: events.length });
    scanned.records += events.length;
    for (const event of events) {
      if (event && event.type === 'task.comment' && event.eventId) commentTaskById.set(String(event.eventId), event.taskId);
      collected.push({ source, event });
    }
  }
  // 한 원장도 못 읽었으면 그 사실을 갈래 전체의 이유로 올린다. 갈래별 이유만 남기면
  // 화면은 결과가 0건인 것과 아무것도 못 읽은 것을 가르려고 목록을 뒤져야 한다.
  if (!scanned.read) scanned.reason = '원장을 읽지 못했습니다.';
  for (const { source, event } of collected) {
    const definition = event && source.types[event.type];
    if (!definition) continue;
    const attachedTo = ledgerAttachment(event, definition, targets, commentTaskById);
    const fields = ledgerFields(event);
    // 붙은 대상의 이름은 문서·태스크일 때만 대상에 넣는다. 정정이 가리키는 원 댓글은
    // eventId로만 지목되는데 그것을 넣으면 기계 값이 뒷문으로 검색에 들어온다 —
    // 대상에서 eventId를 뺀 이유가 그대로 무너진다. 사람이 부르는 이름을 갖지 않는
    // 대상은 결과의 표시에만 쓰고 찾는 대상으로는 쓰지 않는다.
    if (attachedTo && attachedTo.id && ['document', 'task'].includes(attachedTo.kind)) {
      fields.push({ field: 'attachment', text: attachedTo.id });
      if (attachedTo.title) fields.push({ field: 'attachment', text: attachedTo.title });
    }
    const hit = buildHit({
      source: 'ledger',
      kind: event.type,
      project: project.key,
      id: event.eventId || null,
      // 원장 줄은 그 자체로는 읽을 수 없다. `ADR-020의 승인 사유`처럼 붙은 대상이
      // 있어야 뜻이 서므로 제목을 그렇게 짓는다.
      title: attachedTo && attachedTo.id ? `${attachedTo.id}의 ${definition.label}` : definition.label,
      origin: { kind: event.type, label: definition.label },
      attachedTo,
      by: definition.actor ? (event[definition.actor] || null) : null,
      recordedAt: event.recordedAt || event.occurredAt || null
    }, fields, needle);
    if (hit) hits.push(hit);
  }
  return { hits, scanned };
}

// ── 자르기 ───────────────────────────────────────────────────────────────

/**
 * 상한을 넘으면 자른다. 자르되 갈래마다 최소 자리를 남긴다.
 *
 * 셈은 언제나 전건이고 자르는 것은 목록뿐이며, 잘렸다는 사실은 값이 말한다. 갈래마다
 * 자리를 남기는 이유는 화면이 실린 목록 위에서 "원장만"을 거르기 때문이다 — 셈이
 * 3이라고 말했는데 목록에 한 건도 없으면 사람은 수를 보고 그 수를 만든 목록으로
 * 갈 수 없다. 검토 인박스에서 정확히 그 일이 났다.
 */
function selectResults(ranked, limit) {
  if (ranked.length <= limit) return ranked;
  const chosen = new Set();
  const floor = Math.max(1, Math.min(SOURCE_FLOOR, Math.floor(limit / SEARCH_SOURCES.length)));
  for (const source of SEARCH_SOURCES) {
    let taken = 0;
    for (const hit of ranked) {
      if (taken >= floor || chosen.size >= limit) break;
      if (hit.source !== source || chosen.has(hit)) continue;
      chosen.add(hit);
      taken += 1;
    }
  }
  for (const hit of ranked) {
    if (chosen.size >= limit) break;
    chosen.add(hit);
  }
  return ranked.filter((hit) => chosen.has(hit));
}

// ── 엔진 ─────────────────────────────────────────────────────────────────

function coerceLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  // 상한 밖의 값은 거절이 아니라 조인다. 주소창에서 오는 값이라 사람이 친 실수가
  // 검색을 죽이면 안 된다 — 기존 태스크 조회가 같은 규칙을 쓴다.
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

function selectedProjects(layout, projectKey) {
  if (projectKey) return [selectProject(layout, projectKey, true)];
  return (layout.projects || []).slice();
}

/**
 * 문서·태스크·원장을 한 질의로 찾는다.
 *
 * project를 주지 않으면 작업공간의 모든 프로젝트를 훑는다. 보드는 프로젝트별
 * 엔드포인트로 부르지만 엔진에 그 제약을 굽지 않는 이유는, 작업공간 전체 검색이
 * 나중에 화면 하나 붙이는 일이 되게 하기 위해서다.
 */
function searchWorkspace(start, options) {
  const settings = options || {};
  const raw = normalizeText(settings.query).trim();
  const limit = coerceLimit(settings.limit);
  const source = settings.source === undefined || settings.source === null || settings.source === '' ? null : String(settings.source);
  // 모르는 갈래를 빈 결과로 답하면 "그 갈래에 아무것도 없다"로 읽힌다. 전환 판정이
  // 없는 노드를 빈 목록으로 답하지 않는 것과 같은 자리다.
  if (source !== null && !SEARCH_SOURCES.includes(source)) {
    searchInputError(`알 수 없는 출처입니다: ${source} (가능: ${SEARCH_SOURCES.join(', ')})`, 'unknown-source');
  }
  if (raw.length > MAX_QUERY_LENGTH) {
    searchInputError(`검색어는 ${MAX_QUERY_LENGTH}자 이하여야 합니다.`, 'query-too-long');
  }

  const layout = workspaceLayout(start);
  const projects = selectedProjects(layout, settings.project);
  const base = {
    root: layout.root,
    projects: projects.map((project) => project.key),
    query: raw,
    source,
    minLength: MIN_QUERY_LENGTH,
    limit,
    total: 0,
    truncated: false,
    counts: Object.fromEntries(SEARCH_SOURCES.map((value) => [value, 0])),
    // 갈래의 이름과 차례를 함께 낸다. 화면이 이것을 사본으로 들면 어휘가 두 곳에 살고,
    // 갈래를 하나 더하는 날 서버는 내는데 화면은 묶음을 안 그리는 상태가 된다. 결과의
    // origin.label은 「승인 사유」처럼 더 좁은 이름이라 묶음 머리글로 쓸 수 없다.
    sources: SEARCH_SOURCES.map((value) => ({ value, label: SOURCE_LABELS[value] })),
    results: [],
    // REQ-041의 감사 조항: 어느 경로로 답했는지를 값이 말한다. 검색은 언제나 정본을
    // 읽으므로 인덱스 유무가 답을 바꾸지 않는다.
    index: { used: false, reason: '조회 인덱스는 조인 키만 갖고 본문을 복제하지 않으므로 검색은 언제나 정본을 읽습니다.' },
    scanned: { documents: 0, tasks: 0, ledger: { read: false, reason: null, ledgers: [], records: 0 } }
  };

  // 빈 질의는 아무것도 읽지 않는다. 화면이 입력을 비울 때마다 문서 157건을 읽으면
  // 지우는 동작이 가장 비싼 동작이 된다.
  if (!raw) return Object.assign(base, { status: 'empty' });
  if (raw.length < MIN_QUERY_LENGTH) return Object.assign(base, { status: 'too-short' });

  const needle = foldCase(raw);
  const scannedLedger = { read: false, reason: null, ledgers: [], records: 0 };
  let hits = [];
  let documentCount = 0;
  let taskCount = 0;

  for (const project of projects) {
    const documents = listDocuments(project);
    documentCount += documents.length;
    // 태스크 저장소의 자리는 프로젝트가 안다. 옛 판(프로젝트별 경로가 없던 시절)만
    // 작업공간 값으로 떨어진다.
    const store = readTaskStore(project.tasks || layout.tasks);
    const tasks = Object.entries(store.tasks || {});
    taskCount += tasks.length;
    const targets = { document: documentTargets(documents), task: new Map(tasks.map(([id, task]) => [id, { id, title: task.title || null }])) };

    if (!source || source === 'document') hits = hits.concat(documentHits(project, documents, needle));
    if (!source || source === 'task') hits = hits.concat(taskHits(project, tasks, needle));
    // 원장은 갈래를 걸러도 읽는다. 읽었는지 못 읽었는지가 값에 실려야 화면이
    // "원장 결과 0건"과 "원장을 못 읽었다"를 가를 수 있기 때문이다.
    const ledger = ledgerHits(layout, project, targets, needle);
    scannedLedger.read = scannedLedger.read || ledger.scanned.read;
    if (!scannedLedger.reason && ledger.scanned.reason) scannedLedger.reason = ledger.scanned.reason;
    scannedLedger.ledgers = scannedLedger.ledgers.concat(ledger.scanned.ledgers);
    scannedLedger.records += ledger.scanned.records;
    if (!source || source === 'ledger') hits = hits.concat(ledger.hits);
  }

  // 동점은 출처·식별자·칸으로 가른다. 질의를 다시 쳤을 때 순서가 흔들리면 사람이
  // 훑던 자리를 잃는다 — 폴링이 되돌린 값과 겹치는 화면에서는 특히 그렇다.
  hits.sort((left, right) => right.score - left.score
    || SEARCH_SOURCES.indexOf(left.source) - SEARCH_SOURCES.indexOf(right.source)
    || String(left.project).localeCompare(String(right.project))
    || String(left.id).localeCompare(String(right.id))
    || String(left.kind).localeCompare(String(right.kind)));

  const counts = Object.fromEntries(SEARCH_SOURCES.map((value) => [value, hits.filter((hit) => hit.source === value).length]));
  const results = selectResults(hits, limit);
  return Object.assign(base, {
    status: 'ok',
    total: hits.length,
    truncated: results.length < hits.length,
    counts,
    results,
    scanned: { documents: documentCount, tasks: taskCount, ledger: scannedLedger }
  });
}

module.exports = {
  MIN_QUERY_LENGTH, MAX_QUERY_LENGTH, DEFAULT_LIMIT, MAX_LIMIT, EXCERPT_WINDOW,
  SEARCH_SOURCES, FIELDS, LEDGER_SOURCES,
  searchWorkspace
};
