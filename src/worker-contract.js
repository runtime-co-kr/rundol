'use strict';

// 워커 계약의 판정부. 사람 워커와 에이전트 워커가 같은 답을 받으려면 같은 함수가
// 판정해야 하고, 같은 함수를 네 표면이 부르려면 그 함수가 파일을 몰라야 한다.
// 그래서 이 모듈은 값 목록의 정본(vocabulary) 말고는 require를 갖지 않는다 — 그
// 사실 자체가 계약이며 worker-contract-purity.test.js가 전이 의존까지 따라가며
// 지킨다. 정본은 스스로 require가 없으므로 그 폐포에 아무것도 더하지 않는다.
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

const REPORT_FIELDS = ['id', 'assignmentId', 'worker', 'outcome', 'claims', 'procedureDigest', 'schema'];

function sameWorker(left, right) {
  const a = left || {};
  const b = right || {};
  return a.kind === b.kind && String(a.id || '') === String(b.id || '');
}

/**
 * 보고가 제출 계약을 갖췄는지 판정한다. 갖추지 못했으면 거부 사유를, 갖췄으면
 * null을 돌려준다.
 *
 * 접수와 검수는 다른 질문이다. 접수는 "이 보고를 이 할당에 대해 판정할 수 있는가"를
 * 묻고, 검수는 "판정해 보니 통과인가"를 묻는다. 둘을 섞으면 계약을 갖추지 못한
 * 보고가 반려로 기록되어, 워커가 잘못 만든 것인지 일을 잘못한 것인지 구분되지
 * 않는다. 그 구분이 사라지면 워커 종류별 형식 위반율을 잴 수 없다.
 *
 * 순서는 고정이다. 여러 사유가 동시에 성립할 때 어느 것을 돌려줄지가 호출 순서에
 * 따라 달라지면 같은 값이 표면마다 다른 사유를 받는다.
 */
function acceptReport(assignment, report) {
  const none = { missing: [], unclaimed: [] };
  const input = report || {};
  const target = assignment || {};

  const missing = REPORT_FIELDS.filter((field) => emptyValue(input[field]));
  // changed는 비어 있을 수 있다. 막혀서 아무것도 바꾸지 못한 보고가 정상이기
  // 때문이며, 존재만 본다.
  if (!Array.isArray(input.changed)) missing.push('changed');
  if (missing.length) return Object.assign({}, none, { code: 'missing-field', missing });

  // 다른 할당을 향한 보고는 이 할당에 대해 판정할 수 없다. 판정하면 남의 수용
  // 조건으로 이 할당을 닫게 된다.
  if (String(input.assignmentId) !== String(target.id || '')) {
    return Object.assign({}, none, { code: 'wrong-assignment' });
  }
  if (target.state === 'closed') return Object.assign({}, none, { code: 'assignment-closed' });
  if (!sameWorker(input.worker, target.assignee)) return Object.assign({}, none, { code: 'not-assignee' });

  // 할당이 보고 스키마를 고정했는데 보고가 다른 것을 따랐다면, 필드가 같은
  // 이름으로 다른 뜻을 가질 수 있다. 이름만 같은 값을 판정하면 조용히 틀린다.
  if (String(input.schema) !== String(target.reportSchema || '')) {
    return Object.assign({}, none, { code: 'schema-mismatch' });
  }

  // 차단과 반려는 실패가 아니라 사람에게 넘기는 결과다. 사유 없이 넘기면 사람은
  // 무엇을 판단해야 하는지 모른 채 넘겨받는다.
  if ((input.outcome === 'blocked' || input.outcome === 'rejected') && emptyValue(input.reason)) {
    return Object.assign({}, none, { code: 'missing-reason' });
  }

  const unclaimed = unclaimedAcceptance(target, input);
  if (unclaimed.length) return Object.assign({}, none, { code: 'unclaimed-acceptance', unclaimed });

  return null;
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
  // 접수 계약을 갖추지 못한 보고는 판정 대상이 아니다. 여기서 걸러야 접수 거부와
  // 검수 반려가 같은 값으로 뭉개지지 않는다.
  const rejection = acceptReport(assignment, report);
  if (rejection) {
    throw new ContractViolation(`접수 계약을 갖추지 못해 판정할 수 없습니다: ${rejection.code}`
      + (rejection.missing.length ? ` (빠진 항목: ${rejection.missing.join(', ')})` : '')
      + (rejection.unclaimed.length ? ` (언급하지 않은 수용 조건: ${rejection.unclaimed.join(', ')})` : ''));
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

// ── 발급 판정 ────────────────────────────────────────────────────────────

/**
 * 발급 요청을 저장할 본문으로 만들거나 거부 사유를 돌려준다.
 *
 * 저장소를 읽어야 아는 것은 호출자가 값으로 만들어 넘긴다 — 절차 고정 결과는
 * `pinned`로, 정규 문서가 선언한 기능 ID와 열린 할당은 `context`로. 판정이
 * 조회를 시작하면 표면마다 답이 갈린다.
 *
 * 순서는 고정이다. 여러 사유가 동시에 성립할 때 어느 것을 돌려줄지가 호출 순서에
 * 따라 달라지면 같은 요청이 표면마다 다른 사유를 받는다. acceptReport가 세운
 * 규율과 같다.
 *
 * 식별자와 발급 시각은 본문이 아니다. 그것들은 저장의 사실이지 판정의 입력이
 * 아니며, 본문에서 빼야 같은 요청이 언제나 같은 바이트를 낸다.
 */
function composeAssignment(request, pinned, context) {
  const input = request || {};
  const scope = context || {};
  const none = { missing: [], unknownFunctionIds: [], overlaps: [] };

  const missing = missingAssignmentFields(input);
  // 기능 ID만 빠진 것을 따로 가르는 이유는 REQ-048이 그 규칙을 다른 규칙과 별도로
  // 두었기 때문이다 — 근거 없는 작업을 만들지 않는다는 목적이 다르다. 두 코드가
  // 같은 한 번의 호출 결과를 나눠 읽으므로 판정자는 여전히 하나이고, missing은
  // 어느 쪽이든 그 호출의 전체 결과다.
  if (missing.length === 1 && missing[0] === 'functionIds') {
    return Object.assign({}, none, { code: 'missing-function-id', missing });
  }
  if (missing.length) return Object.assign({}, none, { code: 'missing-field', missing });

  const declared = new Set((scope.declaredFunctionIds || []).map((id) => String(id)));
  const unknownFunctionIds = input.functionIds.map((id) => String(id)).filter((id) => !declared.has(id));
  if (unknownFunctionIds.length) return Object.assign({}, none, { code: 'unknown-function-id', unknownFunctionIds });

  // 절차는 이름이 아니라 다이제스트로 고정된다. 고정하지 못한 채 발급하면 나중에
  // 절차 본문이 바뀌었을 때 워커가 무엇을 따랐는지 말할 수 없다.
  if (!pinned || emptyValue(pinned.digest) || emptyValue(pinned.name)) {
    return Object.assign({}, none, { code: 'procedure-unpinnable' });
  }

  const overlaps = assignmentOverlaps(input.allowedPaths, scope.openAssignments);
  if (overlaps.length) return Object.assign({}, none, { code: 'path-overlap', overlaps });

  return {
    goal: String(input.goal),
    acceptance: input.acceptance.map((item) => ({ id: String(item.id), text: String(item.text) })),
    functionIds: input.functionIds.map((id) => String(id)),
    allowedPaths: input.allowedPaths.map((path) => String(path)),
    forbidden: input.forbidden.map((item) => String(item)),
    procedure: { name: String(pinned.name), revision: pinned.revision, digest: String(pinned.digest) },
    reportSchema: String(input.reportSchema),
    assignee: { kind: input.assignee.kind, id: String(input.assignee.id) }
  };
}

// ── 원장 접기 ────────────────────────────────────────────────────────────

const WORK_EVENT_TYPES = new Set(require('./vocabulary').WORK_EVENT_TYPES);

// 같은 밀리초에 든 사건은 유형의 인과가 가른다. 표를 여기서 다시 쓰지 않고
// 어휘의 자리에서 파생하는 이유는, 두 벌이 되면 새 유형이 한쪽에만 들어가고
// 그때 그 유형만 조용히 무작위 순서로 돌아가기 때문이다.
const CAUSAL_RANK = new Map(require('./vocabulary').WORK_EVENT_CAUSAL_ORDER.map((type, index) => [type, index]));

/**
 * 두 클라이언트의 조각이 임의 순서로 병합되므로 순서의 정본이 필요하다.
 *
 * 기록 시각이 같을 때 `eventId`로만 가르면 순서가 동전 던지기가 된다. 실제로
 * 그랬다 — 빠른 기계에서 발급과 보고가 같은 밀리초에 들어갔고, 절반의 확률로
 * 보고가 앞서 접혔으며, 앞선 보고는 가리킬 할당이 없어 RDL-ASG-903으로 버려졌다.
 * 느린 기계에서는 재현되지 않으므로 이 결함은 배포 검사에서만 모습을 드러냈다.
 *
 * 그래서 시각 다음의 열쇠는 인과다. `eventId`는 그다음에 온다 — 같은 시각에
 * 같은 유형이 둘이면 그때는 무엇으로 갈라도 인과가 깨지지 않으므로, 재현
 * 가능하기만 하면 된다.
 *
 * 이것이 막지 못하는 것은 기계 사이의 시계 어긋남이다. 조각은 클라이언트마다
 * 따로 쓰이므로 다른 기계의 시계가 밀리초 너머로 어긋나면 인과가 시각에 져서
 * 다시 뒤집힌다. 그 경우는 순서가 아니라 기준 시각의 문제이며 여기서 풀지 않는다.
 */
function orderWorkEvents(events) {
  return (Array.isArray(events) ? events.slice() : []).sort((left, right) => {
    const a = String((left || {}).recordedAt || '');
    const b = String((right || {}).recordedAt || '');
    if (a !== b) return a < b ? -1 : 1;
    // 목록에 없는 유형은 뒤로 보낸다. 앞에 두면 알지 못하는 유형이 아는 유형의
    // 순서를 밀어내고, 그 결과는 유형을 몰랐다는 사실과 닮지 않은 모습으로 나온다.
    const rankA = CAUSAL_RANK.has((left || {}).type) ? CAUSAL_RANK.get((left || {}).type) : CAUSAL_RANK.size;
    const rankB = CAUSAL_RANK.has((right || {}).type) ? CAUSAL_RANK.get((right || {}).type) : CAUSAL_RANK.size;
    if (rankA !== rankB) return rankA < rankB ? -1 : 1;
    return String((left || {}).eventId || '') < String((right || {}).eventId || '') ? -1 : 1;
  });
}

/**
 * 할당 원장을 접는다. 상태는 저장하지 않고 매번 다시 계산한다 — 추가 전용
 * 원장에서 지난 사건을 고칠 수 없으므로, 대체와 닫힘은 계산으로만 표현된다.
 *
 * 거부는 기록되지만 상태를 만들지 않는다. `assignment.rejected`에 `assignmentId`가
 * 없는 것이 그 사실의 표현이며, 그래서 부분 발급이 남지 않는다.
 *
 * 조각 하나가 깨져도 던지지 않는다. 던지면 깨진 조각 하나가 프로젝트 전체 목록을
 * 감추고, 그 사실을 아무도 모른다.
 */
function foldAssignments(events) {
  const assignments = new Map();
  const rejections = [];
  const diagnostics = [];

  for (const event of orderWorkEvents(events)) {
    const record = event || {};
    if (!WORK_EVENT_TYPES.has(record.type)) {
      diagnostics.push({ code: 'RDL-ASG-901', severity: 'warning', eventId: record.eventId || null, message: `알 수 없는 할당 사건 유형입니다: ${record.type || '(없음)'}` });
      continue;
    }
    if (record.type === 'assignment.rejected' || record.type === 'report.rejected') {
      rejections.push(record);
      continue;
    }

    if (record.type === 'assignment.issued') {
      if (assignments.has(record.assignmentId)) {
        diagnostics.push({ code: 'RDL-ASG-902', severity: 'error', eventId: record.eventId || null, message: `같은 식별자로 두 번 발급됐습니다: ${record.assignmentId}` });
        continue;
      }
      assignments.set(record.assignmentId, {
        id: record.assignmentId,
        goal: record.goal,
        acceptance: record.acceptance || [],
        functionIds: record.functionIds || [],
        allowedPaths: record.allowedPaths || [],
        forbidden: record.forbidden || [],
        procedure: record.procedure || null,
        reportSchema: record.reportSchema,
        assignee: record.assignee || null,
        state: 'open',
        taskId: record.taskId === undefined ? null : record.taskId,
        issuedBy: record.issuedBy || null,
        issuedAt: record.recordedAt || null,
        closedReason: null,
        closedAt: null,
        reports: []
      });
      continue;
    }

    const target = assignments.get(record.assignmentId);
    if (!target) {
      diagnostics.push({ code: 'RDL-ASG-903', severity: 'error', eventId: record.eventId || null, message: `발급되지 않은 할당을 가리킵니다: ${record.assignmentId || '(없음)'}` });
      continue;
    }

    if (record.type === 'assignment.closed') {
      target.state = 'closed';
      target.closedReason = record.reason || null;
      target.closedAt = record.recordedAt || null;
      target.closedBy = record.closedBy || null;
      continue;
    }
    if (record.type === 'report.submitted') {
      target.reports.push(Object.assign({}, record.report || {}, {
        recordedAt: record.recordedAt || null,
        supersededBy: null,
        procedureMatched: null,
        verdict: null
      }));
      continue;
    }
    if (record.type === 'report.verified') {
      const report = target.reports.find((item) => item.id === record.reportId);
      if (!report) {
        diagnostics.push({ code: 'RDL-ASG-904', severity: 'error', eventId: record.eventId || null, message: `접수되지 않은 보고의 판정입니다: ${record.reportId || '(없음)'}` });
        continue;
      }
      report.verdict = { decision: record.decision, blocks: record.blocks || [], humanReasons: record.humanReasons || [], verifiedBy: record.verifiedBy || null };
    }
  }

  for (const assignment of assignments.values()) {
    // 대체는 저장할 수 없다. 추가 전용 원장에서 지난 사건을 표시하는 방법이 없으므로
    // 마지막을 뺀 전부에 다음 보고의 식별자를 붙인다. 두 요구 — 대체 표시와 기록
    // 보존 — 이 모두 지켜지고 아무것도 다시 쓰지 않는다.
    for (const [index, report] of assignment.reports.entries()) {
      const next = assignment.reports[index + 1];
      report.supersededBy = next ? next.id : null;
      // 저장하지 않고 계산한다. 할당의 고정 다이제스트도 보고의 다이제스트도
      // 불변이므로 비교 결과가 어긋날 수 없고, 저장하면 입력은 틀릴 수 없는데
      // 저장된 값만 틀릴 수 있는 상태가 생긴다.
      report.procedureMatched = String((assignment.procedure || {}).digest || '') === String(report.procedureDigest || '');
    }
  }

  return { assignments: Array.from(assignments.values()), rejections, diagnostics };
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
  acceptReport,
  verifyReport,
  composeAssignment,
  orderWorkEvents,
  foldAssignments,
  ContractViolation
};
