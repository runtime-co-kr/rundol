'use strict';

// 검토 리포트 — 승인 상태·승인자·승인 이후 차분을 한 값으로 접는다.
//
// 조각은 이미 다 있었다. 없던 것은 한 번에 훑을 산출물이다. 지금까지 오너는 낡음
// 10건과 미승인 19건을 문서마다 doc status·doc history·doc diff 세 번씩 쳐서
// 봐야 했고, 그래서 아무도 다 보지 않았다.
//
// 여기서 판정을 새로 짓지 않는다. 화면이 자기 판정을 지으면 rdl doc status와 다른
// 답이 나올 수 있고, 그때 사람은 나중에 본 쪽을 믿는다 — 게이트가 보는 답과 사람이
// 믿는 답이 갈리는 순간 승인은 의미를 잃는다. 그래서 상태는 documentStatus가,
// 차분은 diffSinceApproval이, 승인 항목은 foldApprovals가 낸 값을 그대로 싣는다.
// 이 파일이 하는 일은 모으고, 세고, 사람이 읽게 쓰는 것뿐이다.

const approval = require('./approval');
const { DOCUMENT_TRUST_STATES } = require('./vocabulary');

// 검토 대기는 승인된 것을 뺀 나머지다. 목록을 적지 않고 여집합으로 계산하는 이유는
// 신뢰 상태가 하나 늘어나는 날 여기 넣는 것을 잊을 수 있기 때문이고, 잊으면 새 상태의
// 문서가 조용히 검토 줄에서 빠진다 — 빠졌다는 사실은 아무 신호도 내지 않는다.
const REVIEW_STATUSES = DOCUMENT_TRUST_STATES.filter((status) => status !== 'approved');

// 낡음 문서의 차분 하나는 git log --follow 한 번과, 승인된 리비전을 담은 커밋을
// 찾을 때까지 커밋마다 git show 한 번을 돈다. 상한이 없으면 문서가 늘수록 리포트
// 생성이 분 단위로 늘고, 느린 리포트는 결국 돌지 않는다 — 돌지 않는 리포트는 없는
// 것과 같다. 상한을 넘긴 문서도 목록에는 남긴다. 목록에서까지 빼면 남은 목록이
// 완전한 것처럼 보이고, 그것이 이 리포트가 없애려던 바로 그 착각이다.
//
// 상한은 낡음에만 건다. 미승인 문서에는 비교할 커밋이 없어 git을 걷지 않으므로
// 비싸지 않고, 무엇보다 "비교 기준이 없다"는 사실 자체가 이 리포트가 보여줘야 할
// 답이다. 그것을 상한으로 가리면 값이 아니라 침묵이 남는다.
const DEFAULT_DIFF_LIMIT = 40;

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_DIFF_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--max-items는 1 이상의 정수여야 합니다.');
  return limit;
}

// 승인 사유·근거·기록 시각을 가진 것은 접힌 원장뿐이다. 문서마다 documentHistory를
// 부르면 문서 수만큼 git log와 태스크 조회가 함께 돌아 못 쓴다.
//
// 원장 자리(projects/workspace/events)와 인가 컨텍스트 조립을 여기서 다시 만들지
// 않는다. 한때 그랬는데, 그 사본이 approval.js와 어긋나는 날 접기가 빈 결과를 내고
// 승인 사유가 아무 신호 없이 사라진다 — 리포트는 조용히 반쪽이 되고 그 반쪽은
// 정상처럼 보인다.
function approvalHistories(start, projectKey) {
  return approval.documentApprovals(start, { project: projectKey }).approvals;
}

// 바뀐 줄 수와 hunk 수만 센다. 본문은 플래그를 줬을 때만 싣는다 — 29건의 전체
// 패치를 기본으로 뱉으면 한눈에 훑으라고 만든 산출물이 다시 안 읽히는 길이가 된다.
function diffSummary(patch) {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of String(patch || '').split(/\r?\n/u)) {
    if (line.startsWith('@@')) hunks += 1;
    // +++/--- 는 파일 머리말이지 바뀐 줄이 아니다. 세면 파일마다 한 줄씩 부풀어
    // "한 글자만 고쳤는데 +1 -1"이 아니라 "+2 -2"로 보인다.
    else if (line.startsWith('+++') || line.startsWith('---')) continue;
    else if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed, hunks };
}

// 비교 결과는 세 갈래다: 계산하지 않음, 비교 기준 없음, 비교함. 셋을 한 모양으로
// 접으면 안 된다 — 특히 "승인 기록이 없어 기준이 없다"와 "비교했더니 0줄 바뀌었다"를
// 빈 diff 하나로 합치면, 읽는 사람은 미승인 문서를 이미 검토된 것으로 본다.
function comparison(start, projectKey, targetId, settings) {
  const empty = { computed: false, available: null, reason: null, baseCommit: null, added: null, removed: null, hunks: null, text: null };
  if (!settings.compute) return Object.assign({}, empty, { reason: `차분 상한 ${settings.limit}건을 넘어 계산하지 않았습니다. --max-items로 늘리거나 rdl doc diff ${targetId} --since-approval로 봅니다.` });
  const result = approval.diffSinceApproval(start, { project: projectKey, targetId });
  // diff가 문자열이 아니면 비교 자체가 성립하지 않은 것이다. 그 이유는 지어내지
  // 않고 approval.js가 준 문장을 그대로 싣는다.
  if (typeof result.diff !== 'string') {
    return Object.assign({}, empty, { computed: true, available: false, reason: result.reason || null, baseCommit: result.baseCommit || null });
  }
  return Object.assign({ computed: true, available: true, reason: result.reason || null, baseCommit: result.baseCommit || null, text: settings.text ? result.diff : null }, diffSummary(result.diff));
}

function reviewEntry(document, history, diff) {
  const entries = history || [];
  const last = entries.length ? entries[entries.length - 1] : null;
  return {
    id: document.id,
    type: document.type,
    title: document.title,
    file: document.file,
    revision: document.revision,
    status: document.status,
    approvals: document.approvals,
    approvedBy: document.approvedBy,
    approvedRevision: document.approvedRevision,
    // 제출 축을 함께 싣는다. 반려된 문서는 신뢰 상태로는 여전히 미승인이라 이 목록에
    // 남는데, 그 사실을 안 적으면 이미 아니라고 답한 문서가 아직 답을 기다리는 것처럼
    // 읽힌다 — 이 리포트가 없애려던 착각이 정확히 그 모양이다.
    submission: document.submission || null,
    // 마지막 승인이 무엇에 기대어 무슨 사유로 났는지. 낡음 문서를 다시 승인할지
    // 되돌릴지는 "지난번에 무엇을 보고 승인했나"를 알아야 정할 수 있다.
    lastApproval: last ? {
      approvedBy: last.approvedBy,
      reason: last.reason,
      basis: last.basis,
      recordedAt: last.recordedAt,
      delegationId: last.delegationId
    } : null,
    diff
  };
}

function reviewReport(start, options) {
  const settings = options || {};
  if (settings.status && !REVIEW_STATUSES.includes(settings.status)) {
    throw new Error(`검토 리포트의 --status는 ${REVIEW_STATUSES.join(' 또는 ')}입니다: ${settings.status}`);
  }
  const limit = normalizeLimit(settings.maxItems);
  // 상태 필터는 documentStatus에 넘기지 않는다. 넘기면 셈까지 함께 걸러져 "미승인
  // 19건"이 "미승인 19건 중 19건"으로 보이고, 전체 대비 얼마인지가 사라진다.
  const state = approval.documentStatus(start, { project: settings.project });
  const histories = approvalHistories(start, state.project);
  const pending = state.documents.filter((document) => REVIEW_STATUSES.includes(document.status));
  const stale = [];
  const unapproved = [];
  for (const document of pending) {
    const history = histories.get(document.id) || [];
    if (document.status === 'stale') {
      const compute = stale.length < limit;
      stale.push(reviewEntry(document, history, comparison(start, state.project, document.id, { compute, limit, text: settings.diff === true })));
      continue;
    }
    unapproved.push(reviewEntry(document, history, comparison(start, state.project, document.id, { compute: true, limit, text: settings.diff === true })));
  }
  const selected = settings.status || null;
  return {
    project: state.project,
    generatedAt: settings.now || new Date().toISOString(),
    counts: state.counts,
    total: state.total,
    pending: pending.length,
    filter: selected,
    diffLimit: limit,
    diffText: settings.diff === true,
    // 잘렸다는 사실은 값에 남긴다. 마크다운에만 적으면 --json으로 읽는 쪽은 목록이
    // 완전한 줄 알고 그대로 쓴다.
    truncated: stale.length > limit,
    stale: selected === 'unapproved' ? [] : stale,
    unapproved: selected === 'stale' ? [] : unapproved,
    diagnostics: state.diagnostics
  };
}

// ── 마크다운 ────────────────────────────────────────────────────────────────
//
// 기본 출력이 마크다운인 이유는 이 산출물이 갈 자리가 둘이기 때문이다. 터미널에서
// 한 번 읽고 버리는 자리와, Vault에 놓여 옵시디언이 읽는 자리. 둘에 다른 렌더러를
// 두면 같은 값이 두 얼굴을 갖고, 곧 한쪽만 고쳐진다.

function wikiLink(entry) {
  // 옵시디언은 Vault 상대 경로에서 확장자를 뗀 형태를 링크로 읽는다. 링크를 걸어야
  // 이 뷰가 백링크와 그래프에 잡히고, 그래야 "CLI에만 있고 UI에는 없다"는 원래
  // 불편이 실제로 줄어든다.
  const target = String(entry.file || '').replace(/\.md$/u, '');
  return target ? `[[${target}|${entry.id}]]` : entry.id;
}

function basisText(basis) {
  return (basis || []).map((item) => (item.detail ? `${item.kind}=${item.detail}` : item.kind)).join(', ');
}

function renderEntry(lines, entry) {
  lines.push(`### ${entry.id} — ${entry.title}`, '');
  lines.push(`- 문서 ${wikiLink(entry)} · \`${entry.file}\``);
  if (entry.lastApproval) {
    const at = entry.lastApproval.recordedAt || '(시각 없음)';
    lines.push(`- 마지막 승인 ${entry.lastApproval.approvedBy} · ${at} · 누적 ${entry.approvals}회`);
    lines.push(`- 승인 근거 ${basisText(entry.lastApproval.basis) || '(없음)'}`);
    // 사유는 선택이다. 없으면 없다고 적는다 — 빈 줄로 두면 "사유가 없다"와 "사유를
    // 못 읽었다"가 같아 보인다.
    lines.push(`- 승인 사유 ${entry.lastApproval.reason || '(남기지 않음)'}`);
    if (entry.lastApproval.delegationId) lines.push(`- 승인 위임 ${entry.lastApproval.delegationId}`);
  }
  if (entry.approvedRevision) lines.push(`- 승인 리비전 \`${entry.approvedRevision.slice(0, 12)}\`${entry.diff.baseCommit ? ` · 기준 커밋 \`${entry.diff.baseCommit.slice(0, 12)}\`` : ''}`);
  // 반려는 신뢰 상태를 바꾸지 않으므로 이 문서는 여전히 낡음이거나 미승인이다. 그래서
  // 목록에는 남되, 지금 누구 차례인지는 적어야 한다 — 안 적으면 이미 답한 것을 다시 답한다.
  const rejection = entry.submission && entry.submission.state === 'rejected' ? entry.submission.rejection : null;
  if (rejection) lines.push(`- 반려 ${rejection.rejectedBy} · ${rejection.recordedAt || '(시각 없음)'} — ${rejection.reason} (작성자 차례입니다)`);
  // 세 갈래를 한 문장으로 접지 않는다. "계산하지 않았다"와 "비교할 기준이 없다"를
  // 같은 말로 적으면, 상한에 걸려 건너뛴 문서가 승인 기록이 없는 문서처럼 읽힌다.
  if (entry.diff.available === true) lines.push(`- 변경 +${entry.diff.added} -${entry.diff.removed} · hunk ${entry.diff.hunks}`);
  else if (entry.diff.computed === false) lines.push(`- 차분 미계산 — ${entry.diff.reason || '이유를 확인하지 못했습니다.'}`);
  else lines.push(`- 비교 기준 없음 — ${entry.diff.reason || '이유를 확인하지 못했습니다.'}`);
  lines.push('');
  if (entry.diff.text) lines.push('```diff', entry.diff.text.replace(/\s*$/u, ''), '```', '');
}

function renderSection(lines, title, note, entries) {
  lines.push(`## ${title} ${entries.length}건`, '', note, '');
  if (!entries.length) {
    lines.push('해당 문서가 없습니다.', '');
    return;
  }
  for (const entry of entries) renderEntry(lines, entry);
}

function renderReviewMarkdown(report) {
  const counts = report.counts || {};
  const lines = [`# 검토 리포트 — ${report.project}`, ''];
  lines.push(`생성 ${report.generatedAt} · 문서 ${report.total}건 중 검토 대기 ${report.pending}건`, '');
  lines.push('| 상태 | 건수 |', '| --- | --- |');
  lines.push(`| 승인됨 | ${counts.approved || 0} |`);
  lines.push(`| 낡음 | ${counts.stale || 0} |`);
  lines.push(`| 미승인 | ${counts.unapproved || 0} |`);
  lines.push('');
  if (report.truncated) lines.push(`> 낡음 ${report.diffLimit}건까지만 차분을 계산했습니다. 나머지는 \`--max-items\`로 늘리거나 \`rdl doc diff <ID> --since-approval\`로 봅니다.`, '');
  if (report.filter !== 'unapproved') renderSection(lines, '낡음', '승인 이후 바뀌었습니다. 다시 승인하거나 되돌려야 합니다.', report.stale);
  if (report.filter !== 'stale') renderSection(lines, '미승인', '승인 기록이 없습니다. 아직 정본이 아닙니다.', report.unapproved);
  // 진단은 감춰서는 안 된다. 상충하거나 인가되지 않은 승인 기록이 있으면 그 문서의
  // 상태는 "승인이 없는 것"으로 접히는데, 그 이유가 안 보이면 사람은 승인 기록이
  // 사라졌다고 생각한다.
  if ((report.diagnostics || []).length) {
    lines.push(`## 원장 진단 ${report.diagnostics.length}건`, '', '승인 기록을 접는 동안 나온 문제입니다. 이 기록들은 상태를 만들지 못했습니다.', '');
    for (const item of report.diagnostics) lines.push(`- ${item.code} ${item.eventId || '(이벤트 없음)'} — ${item.message}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { REVIEW_STATUSES, DEFAULT_DIFF_LIMIT, diffSummary, reviewReport, renderReviewMarkdown };
