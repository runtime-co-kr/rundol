'use strict';

// 정책 층 변경의 저장 게이트. REQ-058이 규범이다.
//
// 이 시험이 재는 것은 다섯이다. (1) 표시 필드만 바뀌면 결정 없이 통과하고,
// (2) 정책 필드가 바뀌면 결정 없이는 거부되며, (3) 미결 결정으로는 통과하지 못하고,
// (4) 응답된 결정으로 통과하며, (5) 이전 값과 새 값이 결정에 실제로 담긴다.
//
// 셋째가 특히 중요하다. 미결 결정으로 저장이 통과하면 아무나 요청 하나를 넣고 곧바로
// 저장할 수 있고, 그것은 게이트가 없는 것과 같다. 넷째와 짝이 되는 것이 결박이다 —
// 아무 계약 변경 결정이나 통과하면 한 번 결정을 받아 두고 그 뒤로 아무거나 저장할 수 있다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const policyGate = require('../src/policy-gate');
const { POLICY_SURFACES } = require('../src/vocabulary');
const {
  PRESENTATION_GROUPS, readConfig, presentationFile, presentationSavePlan, savePresentation
} = require('../src/board-presentation');
const { workflowsFile, workflowsSavePlan, saveWorkflows, readJson, loadWorkflows } = require('../src/workflow-config');
const { answerDecision, listDecisions } = require('../src/decision');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');

// ── 순수 판정 ───────────────────────────────────────────────────────────

// 표면 이름은 어휘가 갖고 선언은 게이트가 갖는다. 둘이 갈리면 선언 없는 표면이
// 이름만으로 통과하거나, 이름 없는 표면이 게이트에 닿지 못한다.
assert.deepStrictEqual(
  Object.keys(policyGate.SURFACES).sort(),
  POLICY_SURFACES.slice().sort(),
  '게이트의 표면 선언과 POLICY_SURFACES가 갈렸습니다.'
);

assert.throws(() => policyGate.policyDifferences('board-config', {}, {}), /알 수 없는 정책 표면/u,
  '모르는 표면은 판정 없이 지나가면 안 됩니다.');

const boardWhere = (previous, next) => policyGate.policyDifferences('board', previous, next).map(policyGate.changePath).join(', ');
const flowWhere = (previous, next) => policyGate.policyDifferences('workflows', previous, next).map(policyGate.changePath).join(', ');

// (1) 표시 필드만 바뀌면 차이가 아니다.
assert.strictEqual(boardWhere({ priorities: { high: { label: '높음' } } }, { priorities: { high: { label: '아주 높음' } } }), '',
  '표시 문구 변경이 결정을 요구하면 안 됩니다.');

// 표시 목록에 없는 필드는 전부 정책이다. 선언을 이 방향으로 적어 두어야 새 필드가
// 조용히 표시로 분류되지 않는다 — 잊으면 결정을 더 요구하지 덜 요구하지 않는다.
assert.deepStrictEqual(policyGate.entryPolicyFields('board', { label: 'x', description: 'y', order: 1 }), [],
  '라벨·설명·순서는 표시여야 합니다.');
assert.deepStrictEqual(policyGate.entryPolicyFields('board', { label: 'x', disabled: true, policy: {}, sections: {} }),
  ['disabled', 'policy', 'sections'], '표시 목록 밖의 필드는 전부 정책이어야 합니다.');
assert.deepStrictEqual(policyGate.entryPolicyFields('board', { label: 'x', 어떤새필드: 1 }), ['어떤새필드'],
  '새 필드는 표시가 아니라 정책으로 떨어져야 합니다.');

// (5)의 앞자리. 판정 결과가 이전 값과 새 값을 둘 다 들고 있어야 기록에 실을 수 있다.
const changed = policyGate.policyDifferences('board',
  { profiles: { team: { policy: { required: ['REQ'] } } } },
  { profiles: { team: { policy: { required: ['REQ', 'ARC'] } } } });
assert.strictEqual(changed.length, 1);
assert.deepStrictEqual(changed[0].from, { required: ['REQ'] }, '판정이 이전 값을 들고 있어야 합니다.');
assert.deepStrictEqual(changed[0].to, { required: ['REQ', 'ARC'] }, '판정이 새 값을 들고 있어야 합니다.');

// 조이는 변경과 푸는 변경을 둘 다 기록한다. 방향으로 면제하지 않는다.
assert.strictEqual(boardWhere({ approval: { mode: 'human-only' } }, { approval: { mode: 'ai-only' } }), 'approval.(범위 전체).approval');
assert.strictEqual(boardWhere({ approval: { mode: 'ai-only' } }, { approval: { mode: 'human-only' } }), 'approval.(범위 전체).approval');

// 같은 값을 다시 적는 것은 차이가 아니다. 키 순서와 공백도 마찬가지다.
assert.strictEqual(boardWhere(
  { profiles: { t: { policy: { required: ['REQ'], recommended: [] } } } },
  { profiles: { t: { policy: { recommended: [], required: ['REQ'] } } } }
), '', '키 순서 차이가 변경으로 보이면 안 됩니다.');

// 판수는 층 판정의 대상이 아니다. 정책 필드가 생겨 판수가 오르는 것은 결과이지 원인이 아니다.
assert.strictEqual(boardWhere({ schemaVersion: 1 }, { schemaVersion: 2 }), '', '판수 자체가 정책 변경이면 안 됩니다.');

// workflows.json은 표시 층이 없다. 그래프 한 칸을 고쳐도 정책이다.
assert.strictEqual(flowWhere({ workflows: { a: { targetKind: 'task' } } }, { workflows: { a: { targetKind: 'document' } } }),
  'workflows.a.(정의 전체)');
assert.strictEqual(flowWhere({ bindings: { document: { '*': 'a' } } }, { bindings: { document: { '*': 'b' } } }),
  'bindings.document.*.(정의 전체)');
assert.strictEqual(flowWhere({ schemaVersion: 1, workflows: { a: { x: 1, y: 2 } } }, { schemaVersion: 1, workflows: { a: { y: 2, x: 1 } } }), '',
  '같은 그래프를 다시 적는 저장이 결정을 요구하면 안 됩니다.');
// 모르는 최상위 키는 통째로 정책으로 본다. 표시로 새면 그것이 게이트의 구멍이 된다.
assert.strictEqual(flowWhere({}, { 새로운칸: { a: 1 } }), '새로운칸.(범위 전체).새로운칸');

// 결정성. 같은 두 내용이면 언제나 같은 판정이 나와야 한다 — 아니면 같은 저장이
// 매번 다른 결정을 요구하고, 그 결정은 아무것도 결박하지 못한다.
const left = { itemTypes: { b: { label: 'B' }, a: { label: 'A' } }, priorities: { low: { disabled: true } } };
const right = { itemTypes: { a: { label: 'A2' }, b: { label: 'B2' } }, priorities: {} };
assert.strictEqual(
  policyGate.changesDigest(policyGate.policyDifferences('board', left, right)),
  policyGate.changesDigest(policyGate.policyDifferences('board', left, right)),
  '같은 입력이 다른 차이 다이제스트를 내면 안 됩니다.'
);

// 결정 요청은 바뀐 필드마다 이전 값과 새 값을 담는다.
const request = policyGate.decisionRequestFor({ surface: 'board', scope: 'project', changes: changed });
assert.strictEqual(request.kind, 'contract-change');
assert.ok(request.subject.startsWith('policy:board:project:'), `대상이 표면과 범위를 특정해야 합니다: ${request.subject}`);
assert.ok(request.evidence.some((line) => line.includes('"REQ"') && line.includes('"ARC"')),
  `근거에 이전 값과 새 값이 함께 있어야 합니다: ${JSON.stringify(request.evidence)}`);
assert.strictEqual(request.impact.reversible, true, '정책 층은 되돌릴 수 있는 층입니다.');

// 대상이 차이에 결박된다. 다른 변경은 다른 결정이다.
const other = policyGate.policyDifferences('board', { approval: { mode: 'human-only' } }, { approval: { mode: 'ai-only' } });
assert.notStrictEqual(
  policyGate.decisionRequestFor({ surface: 'board', scope: 'project', changes: other }).subject,
  request.subject,
  '다른 변경이 같은 결정 대상을 가지면 한 번 받은 결정으로 아무거나 저장할 수 있습니다.'
);
// 범위가 다르면 다른 결정이다. 계층까지 특정하지 않으면 같은 이름의 항목이 여러
// 계층에 있을 때 복원이 어긋난다.
assert.notStrictEqual(
  policyGate.decisionRequestFor({ surface: 'board', scope: 'workspace', changes: changed }).subject,
  request.subject,
  '계층이 다른 변경이 같은 결정 대상을 가지면 안 됩니다.'
);

// ── 실제 Workspace ──────────────────────────────────────────────────────

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-policy-gate-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

// 화면이 만드는 payload. 이 범위의 원본에 바뀐 항목만 얹는다 — board-ui의
// presentationInput과 같은 규칙이고, board-presentation.test.js가 쓰는 그것이다.
function payloadFor(own, patch) {
  const next = {};
  for (const group of Object.keys(PRESENTATION_GROUPS)) {
    const merged = Object.assign({}, own && own[group], (patch && patch[group]) || {});
    for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
    next[group] = merged;
  }
  return next;
}

try {
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# policy gate\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  // 행위 Client는 에이전트고, 답하는 Client는 사람이다. 정책 변경 결정을 내는 것은
  // 사람이며, 그 자격 판정은 문서 승인과 같은 함수가 한다.
  rdl(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);
  rdl(['client', 'register', 'desk-h', '--name', '사람 데스크', '--type', 'human', '--owner', 'MEMBER-001']);

  const boardFile = presentationFile(temporary, 'crm', 'project');
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(boardFile, `${JSON.stringify({
    schemaVersion: 1,
    taskStatuses: { doing: { label: '진행' } },
    approval: { mode: 'ai-assisted' }
  }, null, 2)}\n`, 'utf8');

  // ── (1) 표시 필드만 바뀌면 결정 없이 통과 ─────────────────────────────
  const displayOnly = savePresentation(temporary, 'crm', 'project',
    payloadFor(readConfig(boardFile), { taskStatuses: { doing: { label: '작업 중' } } }));
  assert.deepStrictEqual(displayOnly.policyChanges, [], '표시 문구 변경이 결정을 요구하면 안 됩니다.');
  assert.strictEqual(readConfig(boardFile).taskStatuses.doing.label, '작업 중', '고친 표시 문구가 파일에 남아야 합니다.');
  assert.strictEqual(listDecisions(temporary, { project: 'crm' }).total, 0, '표시 저장이 결정을 남기면 안 됩니다.');

  // ── (2) 정책 필드가 바뀌면 결정 없이는 거부 ───────────────────────────
  const policyInput = payloadFor(readConfig(boardFile), { priorities: { low: { disabled: true } } });
  assert.throws(
    () => savePresentation(temporary, 'crm', 'project', policyInput),
    /정책 층 변경은 계약 변경 결정이 필요합니다: priorities\.low\.disabled/u,
    '정책 필드 변경이 결정 없이 저장되면 안 됩니다.'
  );
  assert.strictEqual(readConfig(boardFile).priorities.low, undefined, '거절된 저장은 파일을 건드리지 않아야 합니다.');

  // 아무 문자열이나 들이대는 것도 막힌다. "결정 ID가 있는가"만 보면 게이트가 아니다.
  assert.throws(
    () => savePresentation(temporary, 'crm', 'project', policyInput, { decisionId: 'DEC-0000000000000000000A' }),
    /제시한 결정은 이 저장을 가리키지 않습니다/u,
    '다른 결정을 가리키는 저장이 통과하면 안 됩니다.'
  );

  // ── (3) 미결 결정으로는 통과 못 함 ───────────────────────────────────
  const plan = presentationSavePlan(temporary, 'crm', 'project', policyInput);
  assert.strictEqual(plan.required, true, '정책 변경 계획은 결정을 요구해야 합니다.');
  const opened = policyGate.requestPolicyDecision(temporary, {
    project: 'crm', surface: 'board', scope: 'project', previous: plan.previous, next: plan.next, clientId: 'agent-a'
  });
  assert.strictEqual(opened.decisionId, plan.decisionId, '계획과 요청이 같은 결정을 가리켜야 합니다.');
  assert.strictEqual(opened.decision.status, 'open', '위임이 없으면 요청은 열린 채로 남아야 합니다.');
  assert.throws(
    () => savePresentation(temporary, 'crm', 'project', policyInput, { decisionId: opened.decisionId }),
    /아직 답변되지 않았습니다/u,
    '미결 결정으로 저장이 통과하면 게이트가 없는 것과 같습니다.'
  );
  assert.strictEqual(readConfig(boardFile).priorities.low, undefined, '미결 상태에서 파일이 바뀌면 안 됩니다.');

  // 에이전트가 답한 결정은 사람 게이트에서 걸린다. 계약 변경을 내는 것은 사람이다.
  const rehearsal = policyGate.requestPolicyDecision(temporary, {
    project: 'crm', surface: 'board', scope: 'workspace',
    previous: { approval: { mode: 'human-only' } }, next: { approval: { mode: 'ai-only' } }, clientId: 'agent-a'
  });
  answerDecision(temporary, {
    project: 'crm', clientId: 'agent-a', decisionId: rehearsal.decisionId,
    selectedOption: 'approve', answeredBy: 'MEMBER-001', reason: '에이전트가 낸 답'
  });
  assert.throws(
    () => policyGate.assertPolicyDecision(temporary, {
      project: 'crm', surface: 'board', scope: 'workspace',
      previous: { approval: { mode: 'human-only' } }, next: { approval: { mode: 'ai-only' } }
    }),
    /활성 human Client만 정책 층 변경을 결정할 수 있습니다.*유형이 agent/u,
    '에이전트가 낸 정책 변경 결정으로 저장이 통과하면 안 됩니다.'
  );

  // ── (4) 응답된 결정으로 통과 ─────────────────────────────────────────
  const answered = answerDecision(temporary, {
    project: 'crm', clientId: 'desk-h', decisionId: opened.decisionId,
    selectedOption: 'approve', answeredBy: 'MEMBER-001', reason: '낮음 우선순위를 이 프로젝트에서 쓰지 않기로 했습니다'
  });
  assert.strictEqual(answered.decision.status, 'answered');
  const saved = savePresentation(temporary, 'crm', 'project', policyInput, { decisionId: opened.decisionId });
  assert.strictEqual(readConfig(boardFile).priorities.low.disabled, true, '응답된 결정이 있으면 정책 값이 저장되어야 합니다.');
  assert.strictEqual(saved.decisionId, opened.decisionId, '저장이 어느 결정으로 통과했는지 밝혀야 합니다.');
  assert.deepStrictEqual(saved.policyChanges.map(policyGate.changePath), ['priorities.low.disabled']);

  // ── (5) 이전 값과 새 값이 결정에 실제로 담겼는가 ──────────────────────
  const ledger = listDecisions(temporary, { project: 'crm' }).decisions.find((item) => item.decisionId === opened.decisionId);
  assert.ok(ledger, '결정이 원장에 남아야 합니다.');
  assert.strictEqual(ledger.kind, 'contract-change');
  assert.ok(
    ledger.evidence.some((line) => line.startsWith('priorities.low.disabled:') && line.includes('→')),
    `근거가 바뀐 필드를 지목해야 합니다: ${JSON.stringify(ledger.evidence)}`
  );
  const record = ledger.evidence.find((line) => line.startsWith('priorities.low.disabled:'));
  const [, values] = record.split(': ');
  assert.deepStrictEqual(values.split(' → '), ['(없음)', 'true'],
    `이전 값과 새 값이 함께 담겨야 합니다: ${record}`);

  // ── 결박: 한 번 받은 결정이 다음 저장을 열지 않는다 ──────────────────
  const nextChange = payloadFor(readConfig(boardFile), { priorities: { low: { disabled: true }, mid: { disabled: true } } });
  assert.throws(
    () => savePresentation(temporary, 'crm', 'project', nextChange, { decisionId: opened.decisionId }),
    /제시한 결정은 이 저장을 가리키지 않습니다/u,
    '한 번 받은 결정으로 그 뒤의 정책 변경까지 저장되면 안 됩니다.'
  );
  assert.throws(
    () => savePresentation(temporary, 'crm', 'project', nextChange),
    /정책 층 변경은 계약 변경 결정이 필요합니다/u,
    '결정을 가리키지 않아도 새 변경은 새 결정을 요구해야 합니다.'
  );
  assert.strictEqual(readConfig(boardFile).priorities.mid, undefined, '거절된 저장은 파일을 건드리지 않아야 합니다.');

  // 같은 값을 다시 적는 저장은 결정을 요구하지 않는다(REQ-058 규칙 7).
  const idempotent = savePresentation(temporary, 'crm', 'project', payloadFor(readConfig(boardFile), {}));
  assert.deepStrictEqual(idempotent.policyChanges, [], '같은 값을 다시 적는 저장이 결정을 요구하면 안 됩니다.');

  // ── 같은 게이트가 워크플로 저장도 잡는가 ─────────────────────────────
  const flowFile = workflowsFile(temporary, 'crm', 'project');
  const flowBefore = fs.existsSync(flowFile) ? fs.readFileSync(flowFile, 'utf8') : null;
  const flowInput = {
    workflows: { review: { targetKind: 'task', nodes: { todo: { step: 'unclaimed' }, done: { step: 'completed', validity: 'valid' } } } },
    bindings: { task: { '*': 'review' } }
  };
  assert.throws(
    () => saveWorkflows(temporary, 'crm', 'project', flowInput),
    /정책 층 변경은 계약 변경 결정이 필요합니다/u,
    '워크플로 저장은 전부 정책이므로 결정 없이 통과하면 안 됩니다.'
  );
  assert.strictEqual(
    fs.existsSync(flowFile) ? fs.readFileSync(flowFile, 'utf8') : null, flowBefore,
    '거절된 워크플로 저장이 파일에 닿으면 안 됩니다.'
  );

  const flowPlan = workflowsSavePlan(temporary, 'crm', 'project', flowInput);
  const flowDecision = policyGate.requestPolicyDecision(temporary, {
    project: 'crm', surface: 'workflows', scope: 'project',
    previous: flowPlan.previous, next: flowPlan.next, clientId: 'agent-a'
  });
  assert.throws(
    () => saveWorkflows(temporary, 'crm', 'project', flowInput, { decisionId: flowDecision.decisionId }),
    /아직 답변되지 않았습니다/u,
    '미결 결정으로 워크플로가 저장되면 안 됩니다.'
  );
  answerDecision(temporary, {
    project: 'crm', clientId: 'desk-h', decisionId: flowDecision.decisionId,
    selectedOption: 'approve', answeredBy: 'MEMBER-001', reason: '검토 흐름을 태스크에 붙입니다'
  });
  const flowSaved = saveWorkflows(temporary, 'crm', 'project', flowInput, { decisionId: flowDecision.decisionId });
  assert.strictEqual(flowSaved.decisionId, flowDecision.decisionId);
  // 쓴 파일이 읽는 쪽의 판정을 그대로 지나야 한다. 반쯤 쓰인 workflows.json은
  // loadWorkflows를 던지게 만들고, 그러면 프로젝트가 통째로 열리지 않는다.
  assert.strictEqual(readJson(flowFile).schemaVersion, 1);
  assert.strictEqual(loadWorkflows(temporary, 'crm').bindings.task['*'], 'review', '저장한 배정이 읽기에 닿아야 합니다.');

  // 결정을 거절하면 저장도 막힌다. 답변이 있다는 것과 승인되었다는 것은 다르다.
  const rejectInput = { workflows: Object.assign({}, flowInput.workflows, { review: Object.assign({}, flowInput.workflows.review, { targetKind: 'document' }) }), bindings: {} };
  const rejectPlan = workflowsSavePlan(temporary, 'crm', 'project', rejectInput);
  const rejectDecision = policyGate.requestPolicyDecision(temporary, {
    project: 'crm', surface: 'workflows', scope: 'project',
    previous: rejectPlan.previous, next: rejectPlan.next, clientId: 'agent-a'
  });
  answerDecision(temporary, {
    project: 'crm', clientId: 'desk-h', decisionId: rejectDecision.decisionId,
    selectedOption: 'reject', answeredBy: 'MEMBER-001', reason: '문서 흐름으로 바꾸지 않습니다'
  });
  assert.throws(
    () => saveWorkflows(temporary, 'crm', 'project', rejectInput, { decisionId: rejectDecision.decisionId }),
    /승인하지 않았습니다: reject/u,
    '거절된 결정으로 저장이 통과하면 결정이 형식이 됩니다.'
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}

process.stdout.write('policy gate tests passed\n');
