'use strict';

// 워커 계약의 판정부. 사람 워커와 에이전트 워커가 같은 답을 받으려면 같은 함수가
// 판정해야 하고, 같은 함수를 네 표면이 부르려면 그 함수가 파일을 몰라야 한다.
// 그래서 이 모듈은 require를 하나도 갖지 않는다 — 그 사실 자체가 계약이며
// worker-contract-purity.test.js가 전이 의존까지 따라가며 지킨다.
//
// 여기 들어올 수 있는 것은 값만 보고 답이 나오는 판정뿐이다. 저장소를 읽어야
// 알 수 있는 것(기능 ID가 정규 문서에 선언되었는지, 다른 할당이 열려 있는지)은
// 호출자가 값으로 만들어 넘긴다. 판정이 조회를 시작하는 순간 표면마다 답이 갈린다.

// ── 경로 패턴 ────────────────────────────────────────────────────────────

const WILDCARD = /[*?]/u;

function escapeLiteral(value) {
  return value.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
}

// `**`는 구분자를 넘어 매치하고 `*`는 한 구간 안에서만 매치한다. 두 의미가 같으면
// `src/*`가 `src/a/b`까지 잡아 범위 판정이 실제보다 넓어진다.
function patternToRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') { source += '[^/]'; continue; }
    source += escapeLiteral(char);
  }
  return new RegExp(`^${source}$`, 'u');
}

/** 경로가 패턴에 속하는가. 범위 위반 판정에 쓴다. */
function matchesPath(pattern, filePath) {
  return patternToRegex(String(pattern)).test(String(filePath));
}

/** 패턴에서 와일드카드 앞의 확정 접두를 뽑는다. 겹침 판정의 기준이다. */
function literalPrefix(pattern) {
  const text = String(pattern);
  const hit = text.search(WILDCARD);
  const head = hit < 0 ? text : text.slice(0, hit);
  const cut = head.lastIndexOf('/');
  return hit < 0 ? head : head.slice(0, cut + 1);
}

// 겹침 판정은 보수적이다. 두 패턴이 같은 파일을 잡을 수 있는지를 일반적으로 푸는
// 것은 비싸므로, 확정 접두가 서로를 포함하면 겹친다고 답한다. 실제로는 안 겹치는
// 쌍을 겹친다고 답할 수 있지만 그 방향의 오답은 발급 거부로 끝난다. 반대 방향의
// 오답은 두 워커가 같은 파일을 동시에 고치게 두므로 훨씬 비싸다.
function patternsOverlap(left, right) {
  if (String(left) === String(right)) return true;
  const a = literalPrefix(left);
  const b = literalPrefix(right);
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * 발급하려는 할당의 수정 가능 경로가 이미 열린 할당들과 겹치는지 계산한다.
 * 열린 할당만 대상이며, 닫힌 할당은 호출자가 걸러서 넘긴다.
 */
function assignmentOverlaps(candidatePaths, openAssignments) {
  const paths = Array.isArray(candidatePaths) ? candidatePaths : [];
  const others = Array.isArray(openAssignments) ? openAssignments : [];
  const found = [];
  for (const other of others) {
    if (!other || other.state === 'closed') continue;
    // 겹친 패턴을 모두 돌려준다. 하나만 알려주면 통제자가 어디까지 좁혀야
    // 발급이 통과하는지 알 수 없어 왕복이 늘어난다.
    const hits = [];
    for (const mine of paths) {
      for (const theirs of other.allowedPaths || []) {
        if (patternsOverlap(mine, theirs) && !hits.includes(theirs)) hits.push(theirs);
      }
    }
    if (hits.length) found.push({ assignmentId: other.id, paths: hits });
  }
  return found;
}

// ── 할당 필수 항목 ───────────────────────────────────────────────────────

const ASSIGNMENT_FIELDS = ['goal', 'acceptance', 'functionIds', 'allowedPaths', 'forbidden', 'procedure', 'reportSchema', 'assignee'];

function emptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 비어 있는 필수 항목을 모두 돌려준다. 첫 항목에서 멈추지 않는 이유는,
 * 하나씩 알려주면 워커가 왕복을 여러 번 하게 되기 때문이다.
 * `forbidden`은 비어 있어도 되므로 존재만 본다.
 */
function missingAssignmentFields(request) {
  const input = request || {};
  const missing = [];
  for (const field of ASSIGNMENT_FIELDS) {
    if (field === 'forbidden') {
      if (!Array.isArray(input.forbidden)) missing.push(field);
      continue;
    }
    if (emptyValue(input[field])) missing.push(field);
  }
  return missing;
}

// ── 보고 접수 ────────────────────────────────────────────────────────────

/**
 * 할당이 선언한 수용 조건 중 보고가 언급하지 않은 것을 돌려준다.
 * 침묵으로 충족을 주장할 수 없다는 규칙이 여기서 값이 된다.
 */
function unclaimedAcceptance(assignment, report) {
  const declared = ((assignment || {}).acceptance || []).map((item) => item && item.id).filter(Boolean);
  const claimed = new Set(((report || {}).claims || []).map((item) => item && item.id).filter(Boolean));
  return declared.filter((id) => !claimed.has(id));
}

// ── 검수 판정 ────────────────────────────────────────────────────────────

class ContractViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractViolation';
  }
}

/**
 * 접수된 보고가 할당을 충족했는지 판정한다.
 *
 * 입력은 값 두 개뿐이다. 시각도 난수도 환경 변수도 읽지 않으므로 같은 두 값이면
 * 언제 어디서 호출해도 같은 결과가 나온다. 이 성질이 명령줄·보드·워커 어댑터·
 * 지속적 통합 네 표면이 같은 답을 내는 근거다.
 *
 * 판정할 수 없는 입력은 판정 구분으로 섞지 않고 예외로 알린다. 판정할 수 없는
 * 것과 반려는 다르며, 섞으면 계약 결함이 반려로 위장된다.
 */
function verifyReport(assignment, report) {
  if (!assignment || typeof assignment !== 'object') throw new ContractViolation('assignment 값이 필요합니다.');
  if (!report || typeof report !== 'object') throw new ContractViolation('report 값이 필요합니다.');
  if (!Array.isArray(assignment.acceptance) || assignment.acceptance.length === 0) {
    throw new ContractViolation('할당은 수용 조건을 하나 이상 선언해야 판정할 수 있습니다.');
  }
  const unclaimed = unclaimedAcceptance(assignment, report);
  if (unclaimed.length) {
    throw new ContractViolation(`보고가 언급하지 않은 수용 조건이 있어 판정할 수 없습니다: ${unclaimed.join(', ')}`);
  }

  const blocks = [];
  const claims = report.claims || [];
  // 선언 순서로 훑는다. 보고가 넣은 순서를 따르면 같은 내용의 보고가 필드 순서만
  // 달라도 다른 순서의 결과를 내어 결정성이 깨진다.
  for (const criterion of assignment.acceptance) {
    const claim = claims.find((item) => item && item.id === criterion.id);
    if (!claim.met) { blocks.push({ code: 'unmet-acceptance', target: criterion.id }); continue; }
    if (emptyValue(claim.evidence)) blocks.push({ code: 'missing-evidence', target: criterion.id });
  }

  const allowed = assignment.allowedPaths || [];
  for (const changed of report.changed || []) {
    if (!allowed.some((pattern) => matchesPath(pattern, changed))) {
      blocks.push({ code: 'path-out-of-scope', target: String(changed) });
    }
  }

  for (const touched of report.forbiddenTouched || []) {
    blocks.push({ code: 'forbidden-touched', target: String(touched) });
  }

  const humanReasons = [];
  if (report.outcome === 'blocked') humanReasons.push({ code: 'worker-blocked', detail: String(report.reason || '') });
  if (report.outcome === 'rejected') humanReasons.push({ code: 'worker-rejected', detail: String(report.reason || '') });

  const expected = ((assignment.procedure || {}).digest) || '';
  const actual = report.procedureDigest || '';
  if (expected !== actual) {
    humanReasons.push({
      code: 'procedure-mismatch',
      detail: '보고가 밝힌 절차가 할당에 고정된 절차와 다릅니다.',
      expectedDigest: expected,
      actualDigest: actual
    });
  }

  // 반려가 사람 판단보다 앞선다. 기계가 이미 실패로 판정할 수 있는 것을 사람에게
  // 넘기면, 사람은 기계가 답할 수 있는 질문에 시간을 쓴다.
  const decision = blocks.length ? 'reject' : (humanReasons.length ? 'needs-human' : 'pass');
  return { decision, blocks, humanReasons };
}

// literalPrefix와 ASSIGNMENT_FIELDS는 내보내지 않는다. patternsOverlap과
// missingAssignmentFields가 안에서 쓰는 값이고, 밖에서 부를 일이 없는데 내보내면
// 그것도 계약이 되어 바꿀 때마다 밖을 확인해야 한다.
module.exports = {
  matchesPath,
  patternsOverlap,
  assignmentOverlaps,
  missingAssignmentFields,
  unclaimedAcceptance,
  verifyReport,
  ContractViolation
};
