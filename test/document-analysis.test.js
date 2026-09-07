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

  // ① 미승인 상류는 그 위에 굳은 하류가 설 때 운다. 문턱이 프로젝트가 아니라 줄에 있어서다 —
  // 셋 다 미승인인 지금은 아직 아무도 굳지 않은 자리이므로 한 줄도 서지 않는다.
  assert.deepStrictEqual(upstreamDiagnostics().filter((item) => item.target === productRequirement.id), [],
    '미승인 위에 미승인만 서 있으면 그것은 사건이 아니라 목록입니다.');

  // REQ를 승인하면 그 위가 굳는다. 이제 PRD-001은 "굳은 것이 안 굳은 것 위에 섰다"의 아래다.
  rdl(['doc', 'approve', upstreamRequirement.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'crm']);
  let upstreamIssues = upstreamDiagnostics();
  // 줄은 상류마다 하나이고 그 줄이 하류를 말한다. 짝마다 한 줄이던 때에는 같은 사실이
  // 하류 수만큼 곱해져, 런돌 자신의 프로젝트에서 상류 59건이 경고 136줄이 됐다.
  assert(upstreamIssues.some((item) => item.code === 'RDL-APPROVE-031' && item.target === productRequirement.id
    && item.artifactId === productRequirement.id && item.message.includes(upstreamRequirement.id)),
  '미승인 상류가 자기 이름으로 걸리고, 그 줄이 위에 선 하류를 말해야 합니다.');
  assert(upstreamIssues.every((item) => item.severity === 'warning'), '이 진단은 언제나 권고입니다.');

  // ② 낡음과 미승인은 다른 코드로 운다. 상류를 승인하면 미승인 경고가 그치고,
  // 그 상류를 승인 후 고치면 같은 자리가 낡음으로 바뀐다.
  rdl(['doc', 'approve', productRequirement.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'crm']);
  assert.deepStrictEqual(upstreamDiagnostics().filter((item) => [productRequirement.id, upstreamRequirement.id].includes(item.target)), [],
    '상류가 승인되면 하류는 앞선 것이 아닙니다.');

  const requirementFile = rdl(['doc', 'status', '--project', 'crm']).documents.find((entry) => entry.id === upstreamRequirement.id).file;
  fs.appendFileSync(path.join(temporary, 'projects', 'crm', requirementFile), '\n승인 뒤에 덧붙인 한 줄.\n', 'utf8');
  upstreamIssues = upstreamDiagnostics();
  assert(upstreamIssues.some((item) => item.code === 'RDL-APPROVE-030' && item.target === upstreamRequirement.id
    && item.message.includes(downstreamScreen.id)),
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
  assert.deepStrictEqual(upstreamDiagnostics().filter((item) => item.target === upstreamRequirement.id), [],
    '상류를 재승인하면 하류 경고가 그쳐야 합니다.');
  const settledPipeline = documentPipeline(temporary, { project: 'crm' });
  assert.deepStrictEqual(settledPipeline.ahead.filter((entry) => entry.upstream === upstreamRequirement.id), []);
  assert(!settledPipeline.next.startsWith('재승인'), `다시 탈 상류가 없습니다: ${settledPipeline.next}`);

  // 코드 구역 안의 [[...]]는 참조가 아니라 예시다. 판정부가 이미 그것을 덮고 있으므로
  // 여기도 같은 것을 부른다 — 두 자리가 같은 본문을 다르게 읽으면 링크 문법을 설명하는
  // 문서가 자기 예시로 남을 참조해 주고, 그 대상은 고아가 아닌 것으로 보인다.
  assert.deepStrictEqual(referencedIds({
    id: 'REQ-001',
    body: '예시는 `[[ADR-002]]`처럼 적는다.\n\n```md\n[[TST-003]]\n```\n',
    related: []
  }, known), [], '코드 구역 안의 링크는 참조가 아닙니다.');
  assert.deepStrictEqual(referencedIds({
    id: 'REQ-001',
    body: '본문에서 [[ADR-002]]를 참조한다. 그리고 `[[TST-003]]`은 예시다.',
    related: []
  }, known), ['ADR-002'], '코드 밖의 링크만 참조입니다.');

  process.stdout.write('document analysis tests passed\n');
} finally {
  if (previousHome === undefined) delete process.env.RUNDOL_HOME;
  else process.env.RUNDOL_HOME = previousHome;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// ── 미완의 이유를 가른다 ────────────────────────────────────────────────────
//
// incomplete 하나에는 원천 계약이 없는 기능과 검증이 없는 기능이 함께 접힌다. 접힌
// 숫자로 다음 한 걸음을 말하면 둘 중 하나를 골라 말할 수밖에 없고, 실제로 원천이 없는
// 기능에도 "TST가 없습니다"라고 답했다 — 그 말을 따르면 없는 요구를 검증하러 간다.
//
// 원천이 없는 기능은 이제 만들 수 없다 — 만드는 자리가 --related와 마찬가지로
// --function-id의 부모도 확인한다. 그래도 이 상태는 사라지지 않는다. 만든 뒤에 원천이
// 지워지거나 값이 손으로 바뀌면 같은 자리에 이르고, 그때 이 화면이 무엇을 먼저 하라고
// 말하는지가 이 시험의 물음이다. 그래서 그 길로 상태를 만든다.
{
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-doc-trace-'));
  const probeHome = path.join(probe, 'runtime');
  try {
    const spawn = (program, args) => {
      const result = spawnSync(program, args, { cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: probeHome }) });
      assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result.stdout.trim();
    };
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: probe, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
    };
    const cmd = (args) => JSON.parse(spawn(process.execPath, [cli].concat(args, ['--root', probe, '--json'])));
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Rundol Test']);
    git(['config', 'user.email', 'rundol@example.test']);
    fs.writeFileSync(path.join(probe, 'README.md'), '# trace\n', 'utf8');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    cmd(['init', 'shop', '--name', 'Shop', '--profile', 'lean']);
    cmd(['client', 'register', 'desk-h', '--name', '검토자 데스크', '--type', 'human', '--owner', 'MEMBER-001']);

    const product = cmd(['doc', 'create', 'PRD', '상점 제품 요구', '--owner', 'MEMBER-001', '--scope', '하나의 제품 목표와 성공 기준을 정한다', '--exclude', '그 밖의 범위는 다루지 않는다', '--project', 'shop']);
    const requirement = cmd(['doc', 'create', 'REQ', '장바구니 담기', '--owner', 'MEMBER-001', '--scope', '사용자가 상품을 장바구니에 담는 동작', '--exclude', '결제와 배송', '--function-id', 'FN-001', '--related', product.id, '--project', 'shop']);
    // 원천이 있는 기능. 검증이 없으므로 미완의 이유는 TST다.
    const dangling = cmd(['doc', 'create', 'TST', '원천이 사라질 검증', '--owner', 'MEMBER-001', '--scope', '원천이 사라진 뒤 남는 검증 범위', '--exclude', '다른 검증', '--function-id', `${requirement.id}#FN-001`, '--related', requirement.id, '--project', 'shop']);
    assert.strictEqual(dangling.type, 'TST');
    // 원천을 잃은 뒤의 값. 만드는 자리가 막는 것은 어긋난 값을 새로 들이는 일이지,
    // 이미 어긋난 값을 못 본 척하는 일이 아니다.
    fs.writeFileSync(dangling.file, fs.readFileSync(dangling.file, 'utf8').replaceAll(`${requirement.id}#FN-001`, 'REQ-099#FN-001'), 'utf8');

    const trace = cmd(['contract', 'trace', '--project', 'shop']);
    assert.strictEqual(trace.summary.functions, 2);
    assert.strictEqual(trace.summary.incomplete, 2, '한쪽은 검증이 없고 한쪽은 원천이 없습니다.');

    for (const id of [product.id, requirement.id, dangling.id]) {
      cmd(['doc', 'approve', id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'shop']);
    }
    const pipeline = documentPipeline(probe, { project: 'shop' });
    assert.strictEqual(pipeline.traceability.missingSource, 1, '가리키는 REQ 원천 계약이 없는 기능은 따로 셉니다.');
    assert.strictEqual(pipeline.traceability.missingTest, 1, '원천은 있고 검증만 없는 기능은 따로 셉니다.');
    assert.strictEqual(pipeline.traceability.missingSource + pipeline.traceability.missingTest, pipeline.traceability.incomplete,
      '두 이유를 더하면 미완의 수가 되어야 합니다.');
    assert(pipeline.next.startsWith('원천 확인'), `가리키는 원천이 없는 기능이 먼저입니다: ${pipeline.next}`);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
