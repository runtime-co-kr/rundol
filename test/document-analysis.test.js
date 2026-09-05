'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { referencedIds, changesSinceApproval, analyzeDocuments, documentPipeline } = require('../src/document-analysis');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-doc-analysis-'));
const home = path.join(temporary, 'runtime');
const previousHome = process.env.RUNDOL_HOME;
process.env.RUNDOL_HOME = home;

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

try {
  // 참조는 표시 링크에서 읽는다. 자기 자신과 모르는 대상은 참조가 아니다.
  const known = new Set(['REQ-001', 'ADR-002', 'TST-003']);
  const document = {
    id: 'REQ-001',
    body: '본문에서 [[ADR-002-어떤-결정|ADR-002]]을 참조하고 [[REQ-001-자기자신]]도 적었다. [[SCR-999-모르는문서]]도 있다.',
    related: ['[[TST-003-검증|TST-003]]']
  };
  assert.deepStrictEqual(referencedIds(document, known), ['ADR-002', 'TST-003'], '자기 참조와 미등록 대상은 제외됩니다.');
  assert.deepStrictEqual(referencedIds({ id: 'REQ-001', body: '', related: [] }, known), []);

  // 안정성 지표: 승인된 커밋 이후 몇 번 바뀌었나.
  const commits = [{ commit: 'c3' }, { commit: 'c2' }, { commit: 'c1' }];
  assert.strictEqual(changesSinceApproval(commits, 'c1'), 2);
  assert.strictEqual(changesSinceApproval(commits, 'c3'), 0);
  assert.strictEqual(changesSinceApproval(commits, null), null);
  assert.strictEqual(changesSinceApproval(commits, '없는커밋'), null);

  // 실제 Workspace.
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# analysis\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', 'A', '--type', 'agent', '--owner', 'MEMBER-001']);
  // 승인은 활성 human Client만 지난다. 이 시험의 관심은 승인 그 자체가 아니라 승인된
  // 문서가 만드는 판정이므로, 자격을 갖춘 Client를 하나 두고 그것으로 승인한다.
  rdl(['client', 'register', 'desk-h', '--name', '검토자 데스크', '--type', 'human', '--owner', 'MEMBER-001']);

  const referenced = rdl(['doc', 'create', 'ADR', '참조되는 결정', '--owner', 'MEMBER-001', '--scope', '다른 문서가 참조하는 결정', '--exclude', '그 밖', '--project', 'crm']);
  const referring = rdl(['doc', 'create', 'ADR', '참조하는 결정', '--owner', 'MEMBER-001', '--scope', '앞 결정을 참조하는 결정', '--exclude', '그 밖', '--related', referenced.id, '--project', 'crm']);

  const analyzed = analyzeDocuments(temporary, { project: 'crm' });
  const referencedEntry = analyzed.documents.find((entry) => entry.id === referenced.id);
  const referringEntry = analyzed.documents.find((entry) => entry.id === referring.id);
  assert(referencedEntry.referencedBy.includes(referring.id), '역참조가 계산되어야 합니다.');
  assert(referringEntry.references.includes(referenced.id));
  // 참조되는 문서는 고아가 아니고, 참조만 하는 문서는 아무도 안 가리키므로 고아다.
  assert.strictEqual(referencedEntry.orphan, false);
  assert.strictEqual(referringEntry.orphan, true);

  // 승인도 태스크도 없이 존재하는 정본은 왜 그런지 답할 기록이 없다.
  assert.strictEqual(referencedEntry.unexplained, true);
  assert.strictEqual(referencedEntry.trust, 'unapproved');
  assert(analyzed.summary.unexplained >= 2);

  // 승인하면 설명된 상태가 된다.
  rdl(['doc', 'approve', referenced.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'crm']);
  const afterApproval = analyzeDocuments(temporary, { project: 'crm' });
  const approvedEntry = afterApproval.documents.find((entry) => entry.id === referenced.id);
  assert.strictEqual(approvedEntry.trust, 'approved');
  assert.strictEqual(approvedEntry.unexplained, false, '승인된 문서는 왜 그런지 답할 기록이 있습니다.');
  assert.strictEqual(afterApproval.summary.approved, 1);

  // 태스크가 연결되어도 설명된 상태가 된다 — 승인만이 유일한 근거는 아니다.
  const task = rdl(['task', 'add', '참조 문서 작업', '--project', 'crm', '--acceptance', '완료조건', '--link', referring.id]);
  assert(task.taskId);
  const withTask = analyzeDocuments(temporary, { project: 'crm' }).documents.find((entry) => entry.id === referring.id);
  assert.deepStrictEqual(withTask.tasks, [task.taskId]);
  assert.strictEqual(withTask.unexplained, false, '연결된 태스크가 있으면 왜 바뀌었는지 답할 기록이 있습니다.');
  assert.strictEqual(withTask.orphan, false, '태스크가 연결되면 고아가 아닙니다.');

  // 추적성도 연결이다. 검증 문서는 요구를 참조하지만 화살표가 되돌아오지 않으므로,
  // 표시 링크만 보면 모든 TST가 잎 노드라 영구히 고아가 된다 — 문서 종류 하나를
  // 통째로 오탐하면 이 신호는 죽는다.
  //
  // 요구는 자기 기능을 문서 안 표기로 적고 검증은 부모를 달아 적는다. 조인이 글자
  // 그대로였다면 둘은 여기서 만나지 못하고, 만나지 못하면 검증이 다시 고아가 된다.
  const requirement = rdl(['doc', 'create', 'REQ', '기능 ID를 선언하는 요구', '--owner', 'MEMBER-001', '--scope', '기능 ID를 선언하는 요구', '--exclude', '그 밖', '--function-id', 'FN-001', '--related', referenced.id, '--project', 'crm']);
  const verification = rdl(['doc', 'create', 'TST', '같은 기능 ID를 덮는 검증', '--owner', 'MEMBER-001', '--scope', '같은 기능 ID를 덮는 검증', '--exclude', '그 밖', '--function-id', `${requirement.id}#FN-001`, '--related', requirement.id, '--project', 'crm']);
  const traced = analyzeDocuments(temporary, { project: 'crm' });
  const verificationEntry = traced.documents.find((entry) => entry.id === verification.id);
  const requirementEntry = traced.documents.find((entry) => entry.id === requirement.id);
  assert.deepStrictEqual(verificationEntry.traceability, [requirement.id], '기능 ID를 공유하는 문서가 추적성으로 이어져야 합니다.');
  assert.deepStrictEqual(requirementEntry.traceability, [verification.id]);
  assert.strictEqual(verificationEntry.referencedBy.length, 0, '검증 문서를 가리키는 표시 링크는 없습니다.');
  assert.strictEqual(verificationEntry.orphan, false, '기능 ID로 이어진 문서는 고아가 아닙니다.');

  // 필터.
  assert(analyzeDocuments(temporary, { project: 'crm', orphans: true }).documents.every((entry) => entry.orphan));
  assert(analyzeDocuments(temporary, { project: 'crm', unexplained: true }).documents.every((entry) => entry.unexplained));

  // ── 하류가 상류 확정보다 앞서 있다 ────────────────────────────────────────
  //
  // 형식 게이트인 rdl check의 녹색이 "통과"로 읽히면서 내용이 확정되기 전의 문서가
  // 계속 앞으로 전진했고, 상류가 바뀔 때마다 하류 전체를 다시 탔다. 이 진단이
  // 그 상태를 도구가 보이게 만든다 — 명령이 아니라 진단인 것은, 따로 불러야 하는
  // 통제가 실측에서 전부 버스트 후 침묵했기 때문이다.
  function upstreamDiagnostics() {
    const result = spawnSync(process.execPath, [cli, 'check', '--root', temporary, '--project', 'crm', '--json'],
      { cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
    return JSON.parse(result.stdout).diagnostics.filter((item) => String(item.code).startsWith('RDL-APPROVE-03'));
  }

  const productRequirement = rdl(['doc', 'create', 'PRD', '제품 요구', '--owner', 'MEMBER-001', '--scope', '하나의 제품 목표와 성공 기준을 정한다', '--exclude', '그 밖의 모든 범위는 다루지 않는다', '--project', 'crm']);
  const upstreamRequirement = rdl(['doc', 'create', 'REQ', '결제 요구', '--owner', 'MEMBER-001', '--scope', '결제 기능 하나의 동작 요구를 정한다', '--exclude', '그 밖의 모든 범위는 다루지 않는다', '--function-id', 'FN-002', '--related', productRequirement.id, '--project', 'crm']);
  const downstreamScreen = rdl(['doc', 'create', 'SCR', '결제 화면', '--owner', 'MEMBER-001', '--scope', '결제 화면 하나의 흐름과 상태를 정한다', '--exclude', '그 밖의 모든 범위는 다루지 않는다', '--function-id', `${upstreamRequirement.id}#FN-002`, '--related', upstreamRequirement.id, '--project', 'crm']);

  // ① 승인 축을 쓰지 않는 프로젝트에서는 울지 않는다 — 이 시점에도 승인은 위에서 한
  // 한 건뿐이라 축은 이미 쓰이고 있다. 축이 서기 전 상태는 check.test.js의 값 판정이 본다.
  // 여기서 보는 것은 상류가 미승인일 때 하류가 걸리는가다.
  let upstreamIssues = upstreamDiagnostics();
  assert(upstreamIssues.some((item) => item.code === 'RDL-APPROVE-031' && item.artifactId === upstreamRequirement.id && item.target === productRequirement.id),
    '미승인 상류를 근거로 삼은 하류가 걸려야 합니다.');
  assert(upstreamIssues.every((item) => item.severity === 'warning'), '이 진단은 언제나 권고입니다.');

  // ② 낡음과 미승인은 다른 코드로 운다. 상류를 승인하면 미승인 경고가 그치고,
  // 그 상류를 승인 후 고치면 같은 자리가 낡음으로 바뀐다.
  rdl(['doc', 'approve', productRequirement.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'crm']);
  rdl(['doc', 'approve', upstreamRequirement.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'crm']);
  assert.deepStrictEqual(upstreamDiagnostics().filter((item) => item.artifactId === downstreamScreen.id), [],
    '상류가 승인되면 하류는 앞선 것이 아닙니다.');

  const requirementFile = rdl(['doc', 'status', '--project', 'crm']).documents.find((entry) => entry.id === upstreamRequirement.id).file;
  fs.appendFileSync(path.join(temporary, 'projects', 'crm', requirementFile), '\n승인 뒤에 덧붙인 한 줄.\n', 'utf8');
  upstreamIssues = upstreamDiagnostics();
  assert(upstreamIssues.some((item) => item.code === 'RDL-APPROVE-030' && item.artifactId === downstreamScreen.id && item.target === upstreamRequirement.id),
    '낡은 상류는 미승인과 다른 코드로 걸려야 합니다.');

  // 낡음일 때 파이프라인 점검이 무엇을 먼저 하라고 말하는가. 목록을 주고 고르라고 하면
  // 고르는 일이 다시 사람의 부담이 되고, 밀린 것은 작성이 아니라 검토였다.
  const stalePipeline = documentPipeline(temporary, { project: 'crm' });
  assert.strictEqual(stalePipeline.used, true, '승인을 쓰는 프로젝트입니다.');
  assert(stalePipeline.ahead.some((entry) => entry.upstream === upstreamRequirement.id && entry.status === 'stale'));
  assert(stalePipeline.next.startsWith(`재승인 ${upstreamRequirement.id}`), `낡은 상류가 먼저입니다: ${stalePipeline.next}`);
  // 층은 유형 계층이 정한다. 계약의 작성 순서와 같은 표를 보므로 여기서 순서를 다시 적지 않는다.
  assert.deepStrictEqual(stalePipeline.layers.map((entry) => entry.layer), [0, 1, 2, 3]);
  assert.strictEqual(stalePipeline.layers[1].types, 'REQ');
  assert.strictEqual(stalePipeline.total, stalePipeline.layers.reduce((sum, entry) => sum + entry.documents, 0) + stalePipeline.outside,
    '층의 합과 층 밖의 수를 더하면 전체가 되어야 합니다.');
  assert(stalePipeline.traceability && typeof stalePipeline.traceability.functions === 'number',
    '추적성은 contract trace가 이미 내는 값을 그대로 씁니다.');

  // ③ 상류가 다시 승인되면 그친다.
  rdl(['doc', 'approve', upstreamRequirement.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'crm']);
  assert.deepStrictEqual(upstreamDiagnostics().filter((item) => item.artifactId === downstreamScreen.id), [],
    '상류를 재승인하면 하류 경고가 그쳐야 합니다.');
  const settledPipeline = documentPipeline(temporary, { project: 'crm' });
  assert.deepStrictEqual(settledPipeline.ahead.filter((entry) => entry.downstream === downstreamScreen.id), []);
  assert(!settledPipeline.next.startsWith('재승인'), `다시 탈 상류가 없습니다: ${settledPipeline.next}`);

  process.stdout.write('document analysis tests passed\n');
} finally {
  if (previousHome === undefined) delete process.env.RUNDOL_HOME;
  else process.env.RUNDOL_HOME = previousHome;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
