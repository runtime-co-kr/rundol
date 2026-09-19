'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repository = path.resolve(__dirname, '..');
const node = process.execPath;
const cli = path.join(repository, 'bin', 'rdl.js');
function run(args, cwd, expected) {
  const result = spawnSync(node, [cli].concat(args), { cwd: repository, encoding: 'utf8' });
  assert.strictEqual(result.status, expected === undefined ? 0 : expected, result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-contract-'));
try {
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Rundol Test'], root);
  git(['config', 'user.email', 'rundol@example.test'], root);
  fs.writeFileSync(path.join(root, 'README.md'), '# test\n');
  git(['add', 'README.md'], root); git(['commit', '-m', 'initial'], root);
  const initialized = run(['init', 'demo', '--name', 'Demo', '--profile', 'lean', '--root', root, '--json'], root);
  assert.strictEqual(initialized.contract.status, 'valid');
  assert.strictEqual(initialized.contract.profile.schemaVersion, 2);
  assert(initialized.contract.evaluation.ready.some((item) => item.type === 'PRD'));
  const shown = run(['contract', 'show', '--project', 'demo', '--root', root, '--json'], root);
  assert.strictEqual(shown.revision, 1);
  assert.strictEqual(shown.catalog.granularity.version, 'bounded-v1');
  assert(shown.catalog.granularity.typeResponsibilities.REQ.includes('독립 검증'));
  assert(shown.catalog.granularity.splitWhen.length >= 4);
  const next = run(['contract', 'next', '--project', 'demo', '--root', root, '--json'], root);
  assert(next.ready.some((item) => item.type === 'PRD'));
  const guidedReq = run(['doc', 'create', 'REQ', '요구사항', '--owner', 'MEMBER-001', '--scope', '사용자가 항목을 등록하는 동작', '--exclude', '항목 조회와 삭제', '--function-id', 'FN-001', '--related', 'project:demo', '--project', 'demo', '--root', root, '--json'], root);
  assert.strictEqual(guidedReq.type, 'REQ');
  // 만들어진 문서도 원장에 사건이 없다. 그러므로 state는 바닥값이고 수명은 비어 있다.
  // 뼈대를 고쳤는지가 아니라 만드는 자리가 그것을 보장하는지를 본다 — 뼈대는 열세
  // 벌이고 그중 하나가 다시 갈리는 날 아무 신호도 나지 않는다.
  {
    const created = fs.readFileSync(guidedReq.file, 'utf8');
    assert.match(created, /^state: draft$/mu, '새 문서가 원장 없이 주장할 수 있는 값은 바닥뿐입니다.');
    assert.ok(!/^lifecycle:/mu.test(created), '비어 있는 것과 active는 다르므로 scaffold는 수명을 적지 않습니다.');
  }
  const afterReq = run(['contract', 'next', '--project', 'demo', '--root', root, '--json'], root);
  assert.strictEqual(afterReq.blocked.length, 0);
  const planned = run(['contract', 'plan', '--profile', 'lean', '--enforcement', 'advisory', '--project', 'demo', '--root', root, '--json'], root);
  assert.strictEqual(planned.profile.enforcement, 'advisory');
  assert.strictEqual(shown.revision, 1);
  const updated = run(['contract', 'set', '--profile', 'lean', '--enforcement', 'advisory', '--project', 'demo', '--root', root, '--json'], root);
  assert.strictEqual(updated.revision, 2);
  assert.strictEqual(updated.enforcement, 'advisory');
  assert.deepStrictEqual(updated.profile.policy.required, ['PRD', 'REQ']);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
// 흡수 충족은 유형 단위라 대상 문서 하나가 다 갖고 있으면 나머지는 보이지 않는다.
// 그 뒤에 가려진 현황을 문서별로 계산해야 "일부만 가진 문서"를 찾아낼 수 있다.
{
  const { evaluateDocumentContract, documentContractCatalog } = require('../src/document-contract');
  const catalog = documentContractCatalog();
  const profile = {
    schemaVersion: 2,
    name: 'lean',
    revision: 1,
    enforcement: 'checkpoint',
    policy: { required: ['REQ'], recommended: [], onDemand: catalog.documentTypes.filter((t) => t !== 'REQ' && t !== 'SCR'), disabled: ['SCR'] }
  };
  const artifact = (id, type, sections) => ({ id, type, source: (sections || []).map((s) => `## ${s}\n내용\n`).join('') });

  const clean = evaluateDocumentContract(profile, [artifact('REQ-001', 'REQ', [])]);
  assert.deepStrictEqual(clean.violations, [], '사용 안 함인 유형이 없으면 위반이 없다');
  assert.deepStrictEqual(clean.absorbed, [], '흡수 현황은 더 이상 계산하지 않는다');

  const present = evaluateDocumentContract(profile, [artifact('REQ-001', 'REQ', []), artifact('SCR-001', 'SCR', [])]);
  assert.deepStrictEqual(present.violations.map((v) => v.code), ['disabled-present'], '만들면 그것만 위반이다');

  // 예전에는 이 절들을 REQ가 갖고 있는지 따졌다. 이제 판정에 아무 영향이 없다.
  const withSections = evaluateDocumentContract(profile, [artifact('REQ-001', 'REQ', ['사용자 흐름', '화면 상태'])]);
  assert.deepStrictEqual(withSections.violations, [], '절을 갖고 있든 아니든 판정은 같다');
}

// 흡수 진단은 코드에서 사라져야 한다. 남겨 두면 평가기가 만들지 않는 위반을 기다린다.
// 위반을 진단으로 옮기는 표는 check-rules로 갔다 — 평가 결과만 보고 코드와 심각도를
// 입히는 일이라 읽기 계층에 남을 이유가 없었다.
{
  const { CONTRACT_VIOLATION_CODES } = require('../src/check-rules');
  const codes = Object.values(CONTRACT_VIOLATION_CODES);
  for (const code of ['RDL-PROFILE-006', 'RDL-PROFILE-007', 'RDL-PROFILE-010', 'RDL-PROFILE-011']) {
    assert.ok(!codes.includes(code), `${code}은 흡수와 함께 제거되어야 합니다.`);
  }
  assert.strictEqual(CONTRACT_VIOLATION_CODES['disabled-present'], 'RDL-PROFILE-004', '사용 안 함 위반은 남아야 합니다.');
  assert.strictEqual(CONTRACT_VIOLATION_CODES['required-missing'], 'RDL-PROFILE-002');
  assert.strictEqual(CONTRACT_VIOLATION_CODES['recommended-missing'], 'RDL-PROFILE-003');
}

// 권장 누락은 강제 수준과 무관하게 언제나 경고다. 차단하면 권장이 아니라 필수가 된다.
// 소스에 그 삼항이 있는지가 아니라 실제로 그렇게 판정하는지를 본다.
{
  const { checkContractViolations } = require('../src/check-rules');
  const evaluation = {
    enforcement: 'checkpoint',
    violations: [
      { code: 'required-missing', type: 'REQ', message: '필수' },
      { code: 'recommended-missing', type: 'ADR', message: '권장' },
      { code: 'disabled-present', type: 'SCR', message: '사용 안 함' }
    ]
  };
  const strict = [];
  checkContractViolations(strict, evaluation, { file: 'project.md', project: 'x', strict: true });
  const bySeverity = Object.fromEntries(strict.map((item) => [item.code, item.severity]));
  assert.strictEqual(bySeverity['RDL-PROFILE-003'], 'warning', '권장 누락은 언제나 경고여야 합니다.');
  assert.strictEqual(bySeverity['RDL-PROFILE-002'], 'error', '차단 수준에서 필수 누락은 오류여야 합니다.');
  assert.strictEqual(bySeverity['RDL-PROFILE-004'], 'error', '차단 수준에서 사용 안 함 위반은 오류여야 합니다.');

  // 권고 수준에서는 셋 모두 경고다. 강제 수준이 낮은데 막으면 그 수준의 뜻이 없어진다.
  const advisory = [];
  checkContractViolations(advisory, Object.assign({}, evaluation, { enforcement: 'advisory' }), { file: 'project.md', project: 'x', strict: true });
  assert.ok(advisory.every((item) => item.severity === 'warning'), '권고 수준에서는 막지 않아야 합니다.');
}

// 흡수 처분은 유형마다 따로 세운 결정이다. 계약을 저장할 때마다 보내온 값으로 통째
// 갈아끼우면, 화면이 표현하지 못하는 처분은 저장 한 번에 카탈로그 기본값이 된다.
{
  const contractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-omission-'));
  try {
    git(['init', '-b', 'main'], contractRoot);
    git(['config', 'user.name', 'Rundol Test'], contractRoot);
    git(['config', 'user.email', 'rundol@example.test'], contractRoot);
    fs.writeFileSync(path.join(contractRoot, 'README.md'), '# test\n');
    git(['add', 'README.md'], contractRoot); git(['commit', '-m', 'initial'], contractRoot);
    run(['init', 'demo', '--name', 'Demo', '--profile', 'lean', '--root', contractRoot, '--json'], contractRoot);
    const { loadDocumentContract } = require('../src/document-contract');
    const started = loadDocumentContract(contractRoot, 'demo');
    assert.strictEqual(started.profile.omissions, undefined, '계약은 더 이상 흡수 설정을 갖지 않습니다');
    assert.strictEqual(started.profile.rules, undefined, '계약은 더 이상 작성 순서를 갖지 않습니다');

    // 팀 프리셋이 정한 하부 요소가 계약 카탈로그에 실려 화면과 CLI가 같은 값을 본다.
    fs.writeFileSync(path.join(contractRoot, 'projects', 'workspace', 'board.json'), JSON.stringify({
      schemaVersion: 1,
      profiles: { 'our-team': { label: '우리 팀', policy: { required: ['REQ', 'TST'] }, sections: { REQ: ['배경', '요구사항', '우리 팀 검토 항목'] } } }
    }, null, 2), 'utf8');
    const withPreset = loadDocumentContract(contractRoot, 'demo');
    const ours = withPreset.catalog.profileChoices.find((item) => item.name === 'our-team');
    assert.deepStrictEqual(ours.sections.REQ, ['배경', '요구사항', '우리 팀 검토 항목'], '프리셋이 정한 하부 요소가 실려야 합니다');
    // 프리셋이 정하지 않은 유형은 실제 문서에서 뽑은 기본값을 쓴다.
    const { DEFAULT_SECTIONS } = require('../src/document-profile');
    assert.deepStrictEqual(ours.sections.ADR, DEFAULT_SECTIONS.ADR, '정하지 않은 유형은 기본 하부 요소를 씁니다');
    assert.deepStrictEqual(withPreset.catalog.profileChoices.find((item) => item.name === 'lean').sections.REQ, DEFAULT_SECTIONS.REQ);
  } finally {
    fs.rmSync(contractRoot, { recursive: true, force: true });
  }
}

// 프리셋의 하부 요소는 기본값을 더하는 것이 아니라 대체하는 계약이다. 더하기만 하면 팀이
// 뺀 절이 뼈대에 남아, 만들어진 문서와 contract show가 말하는 목록이 달라진다.
{
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-sections-'));
  try {
    git(['init', '-b', 'main'], probe);
    git(['config', 'user.name', 'Rundol Test'], probe);
    git(['config', 'user.email', 'rundol@example.test'], probe);
    fs.writeFileSync(path.join(probe, 'README.md'), '# test\n');
    git(['add', 'README.md'], probe); git(['commit', '-m', 'initial'], probe);
    run(['init', 'demo', '--name', 'Demo', '--profile', 'lean', '--root', probe, '--json'], probe);
    fs.writeFileSync(path.join(probe, 'projects', 'workspace', 'board.json'), JSON.stringify({
      schemaVersion: 1,
      profiles: { lean: { sections: { REQ: ['배경', '요구사항', '우리 팀 보안 검토'] } } }
    }, null, 2), 'utf8');

    const created = run(['doc', 'create', 'REQ', '결제', '--owner', 'MEMBER-001', '--scope', '사용자가 결제를 승인하는 동작',
      '--exclude', '결제 취소와 환불', '--function-id', 'FN-001', '--related', 'project:demo', '--project', 'demo', '--root', probe, '--json'], probe);
    const source = fs.readFileSync(created.file, 'utf8');
    const heads = source.split(/\r?\n/u).map((line) => /^##\s+(.+?)\s*#*\s*$/u.exec(line)).filter(Boolean).map((match) => match[1].trim());
    assert.deepStrictEqual(heads.slice(0, 3), ['배경', '요구사항', '우리 팀 보안 검토'], '프리셋이 정한 목록과 순서를 따라야 합니다');
    assert.ok(!heads.includes('사전조건'), '프리셋이 뺀 절은 뼈대에 남으면 안 됩니다');
    // 기능별 계약은 하부 요소가 아니라 기능의 계약이므로 그대로 남는다.
    assert.ok(source.includes('### FN-001'), '기능별 계약 블록은 보존되어야 합니다');
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

// ── 기능 ID 축은 계약 상태를 보지 않는다 ────────────────────────────────────
//
// 값이 문서가 선언한 기능 ID에서만 나오므로 계약을 아직 세우지 않은 프로젝트에서도
// 그대로 계산된다. 예전에는 valid 경로에서만 실었고, 그래서 rdl contract trace가
// 그런 프로젝트에 {root, project} 둘만 답했다 — 읽는 쪽은 "기능 0건"과 "축을 계산하지
// 않았다"를 가를 수 없었고, summary를 읽는 코드는 조용히 undefined를 받았다.
{
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-legacy-trace-'));
  try {
    git(['init', '-b', 'main'], legacy);
    git(['config', 'user.name', 'Rundol Test'], legacy);
    git(['config', 'user.email', 'rundol@example.test'], legacy);
    fs.writeFileSync(path.join(legacy, 'README.md'), '# test\n');
    git(['add', 'README.md'], legacy); git(['commit', '-m', 'initial'], legacy);
    run(['init', 'demo', '--name', 'Demo', '--profile', 'lean', '--root', legacy, '--json'], legacy);
    const requirement = run(['doc', 'create', 'REQ', '요구사항', '--owner', 'MEMBER-001', '--scope', '사용자가 항목을 등록하는 동작',
      '--exclude', '항목 조회와 삭제', '--function-id', 'FN-001', '--related', 'project:demo', '--project', 'demo', '--root', legacy, '--json'], legacy);
    run(['doc', 'create', 'TST', '요구 검증', '--owner', 'MEMBER-001', '--scope', '등록 동작 하나를 덮는 검증 범위',
      '--exclude', '조회와 삭제 검증', '--function-id', `${requirement.id}#FN-001`, '--related', requirement.id, '--project', 'demo', '--root', legacy, '--json'], legacy);
    const configured = run(['contract', 'trace', '--project', 'demo', '--root', legacy, '--json'], legacy);
    assert.deepStrictEqual(configured.summary, { functions: 1, ready: 1, incomplete: 0 });

    // 계약 선언만 걷어 낸다. 문서는 그대로이므로 기능 ID 축도 그대로여야 한다.
    const charter = path.join(legacy, 'projects', 'demo', 'project.md');
    const lines = fs.readFileSync(charter, 'utf8').split(/\r?\n/u);
    const start = lines.findIndex((line) => /^documentProfile:\s*$/u.test(line));
    assert(start >= 0, '계약 선언을 찾지 못했습니다.');
    let end = start + 1;
    while (end < lines.length && /^ {2}\S/u.test(lines[end])) end += 1;
    fs.writeFileSync(charter, lines.slice(0, start).concat(lines.slice(end)).join('\n'), 'utf8');
    assert.strictEqual(run(['contract', 'show', '--project', 'demo', '--root', legacy, '--json'], legacy).status, 'legacy-unconfigured');

    const unconfigured = run(['contract', 'trace', '--project', 'demo', '--root', legacy, '--json'], legacy);
    assert.deepStrictEqual(unconfigured.summary, { functions: 1, ready: 1, incomplete: 0 },
      '계약을 세우지 않은 프로젝트에서도 기능 ID 축은 그대로 답해야 합니다.');
    assert.strictEqual(unconfigured.entries.length, 1);
  } finally {
    fs.rmSync(legacy, { recursive: true, force: true });
  }
}

// ── 기능 ID의 부모도 실재를 확인받는다 ──────────────────────────────────────
//
// related는 오래전부터 없는 대상을 가리키면 거절당했다. 기능 ID에는 그 대칭이 없어서
// 없는 REQ를 가리켜도(REQ-999#FN-001) 있는 REQ이지만 그 REQ가 선언한 적 없는 기능을
// 가리켜도(REQ-001#FN-099) 문서가 만들어졌고, rdl check --strict --implementation이
// 진단 0건을 냈다. 만드는 자리와 검사하는 자리 둘 다에서 본다.
{
  const parents = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-function-parent-'));
  try {
    git(['init', '-b', 'main'], parents);
    git(['config', 'user.name', 'Rundol Test'], parents);
    git(['config', 'user.email', 'rundol@example.test'], parents);
    fs.writeFileSync(path.join(parents, 'README.md'), '# test\n');
    git(['add', 'README.md'], parents); git(['commit', '-m', 'initial'], parents);
    run(['init', 'demo', '--name', 'Demo', '--profile', 'lean', '--root', parents, '--json'], parents);
    const requirement = run(['doc', 'create', 'REQ', '요구사항', '--owner', 'MEMBER-001', '--scope', '사용자가 항목을 등록하는 동작',
      '--exclude', '항목 조회와 삭제', '--function-id', 'FN-001', '--related', 'project:demo', '--project', 'demo', '--root', parents, '--json'], parents);
    const verificationArgs = (title, functionId) => ['doc', 'create', 'TST', title, '--owner', 'MEMBER-001',
      '--scope', '등록 동작 하나를 덮는 검증 범위', '--exclude', '조회와 삭제 검증', '--function-id', functionId,
      '--related', requirement.id, '--project', 'demo', '--root', parents, '--json'];
    const rejected = (title, functionId) => {
      const result = spawnSync(node, [cli].concat(verificationArgs(title, functionId)), { cwd: repository, encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0, `만들어지면 안 되는 문서가 만들어졌습니다: ${functionId}`);
      return `${result.stdout}${result.stderr}`;
    };

    const noParent = rejected('없는 원천 검증', 'REQ-999#FN-001');
    assert(noParent.includes('REQ-999'), `없는 원천을 이름으로 말해야 합니다: ${noParent}`);
    const noFunction = rejected('없는 기능 검증', `${requirement.id}#FN-099`);
    assert(noFunction.includes(`${requirement.id}#FN-001`), `무엇으로 고칠지 함께 말해야 합니다: ${noFunction}`);

    // 거절이 채번을 태우지 않는다. 실패 뒤에 만들어지는 문서가 TST-001이어야 한다 —
    // 판정이 채번 뒤에 서면 시도마다 번호가 하나씩 사라지고, 그 구멍은 되돌릴 수 없다.
    const created = run(verificationArgs('등록 검증', `${requirement.id}#FN-001`), parents);
    assert.strictEqual(created.id, 'TST-001', '거절된 시도가 문서 번호를 예약해서는 안 됩니다.');

    // 검사하는 자리. 만들어진 뒤에 값이 어긋나는 길은 파일 편집이므로, 그 길로 넣는다.
    // 나가는 값이 진단 목록이므로 종료 코드는 묻지 않는다 — 이 뼈대에는 이 규칙과
    // 무관한 경고가 이미 여럿 있고, 그 수가 바뀌면 종료 코드도 바뀐다.
    const linkDiagnostics = () => {
      const result = spawnSync(node, [cli, 'check', '--project', 'demo', '--root', parents, '--json'], { cwd: repository, encoding: 'utf8' });
      return JSON.parse(result.stdout).diagnostics.filter((item) => ['RDL-LINK-002', 'RDL-LINK-003'].includes(item.code));
    };
    const file = path.join(parents, 'projects', 'demo', created.relativeFile.replace(/^projects\/demo\//u, ''));
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replaceAll(`${requirement.id}#FN-001`, `${requirement.id}#FN-099`), 'utf8');
    assert.deepStrictEqual(linkDiagnostics().map((item) => [item.code, item.target]),
      [['RDL-LINK-003', `${requirement.id}#FN-099`]], '부모가 선언하지 않은 기능은 해결되지 않는 참조입니다.');

    fs.writeFileSync(file, original.replaceAll(`${requirement.id}#FN-001`, 'REQ-999#FN-001'), 'utf8');
    assert(linkDiagnostics().some((item) => item.code === 'RDL-LINK-002' && item.target === 'REQ-999'),
      '부모 문서가 없으면 related와 같은 코드로 웁니다.');

    fs.writeFileSync(file, original, 'utf8');
    assert.deepStrictEqual(linkDiagnostics(), [], '되돌리면 그친다 — 정상 문서에 소음을 내지 않습니다.');
  } finally {
    fs.rmSync(parents, { recursive: true, force: true });
  }
}

// ── 작성-의존 순서 게이트 ────────────────────────────────────────────────────
//
// 상류가 승인되기 전의 하류 생성을 orderEnforcement가 다룬다. advisory(기본)는
// 알림만 싣고 막지 않으며 — 이 축이 생겼다는 사실만으로 기존 프로젝트가 멎으면
// 안 된다 — checkpoint는 사용자 지시의 기록 없이는 거부한다.
{
  const ordered = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-order-gate-'));
  try {
    git(['init', '-b', 'main'], ordered);
    git(['config', 'user.name', 'Rundol Test'], ordered);
    git(['config', 'user.email', 'rundol@example.test'], ordered);
    fs.writeFileSync(path.join(ordered, 'README.md'), '# order\n', 'utf8');
    git(['add', 'README.md'], ordered); git(['commit', '-m', 'initial'], ordered);
    run(['init', 'flow', '--name', 'Flow', '--profile', 'lean', '--root', ordered, '--json'], ordered);
    run(['doc', 'create', 'PRD', '흐름 제품', '--owner', 'MEMBER-001', '--scope', '순서 게이트를 확인하는 제품', '--exclude', '그 밖', '--project', 'flow', '--root', ordered, '--json'], ordered);
    const requirement = run(['doc', 'create', 'REQ', '흐름 요구', '--owner', 'MEMBER-001', '--scope', '사용자가 흐름을 확인하는 동작', '--exclude', '그 밖', '--function-id', 'FN-001', '--related', 'PRD-001', '--project', 'flow', '--root', ordered, '--json'], ordered);
    // advisory: PRD가 미승인이어도 REQ는 만들어지고, 결과가 그 사실을 알린다.
    assert(requirement.orderNotice && requirement.orderNotice.includes('PRD'), `advisory는 알림을 실어야 합니다: ${JSON.stringify(requirement.orderNotice)}`);

    // 상류가 없는 유형에 지시 기록을 실으면 거부된다 — 뜻 없는 값은 기록이 아니라 소음이다.
    const rawRun = (args) => spawnSync(node, [cli].concat(args), { cwd: repository, encoding: 'utf8' });
    const pointless = rawRun(['doc', 'create', 'PRD', '지시 없는 자리', '--owner', 'MEMBER-001', '--scope', '상류 없는 유형', '--exclude', '그 밖', '--ahead-of-approval', '지시', '--project', 'flow', '--root', ordered, '--json']);
    assert.notStrictEqual(pointless.status, 0);
    assert.match(`${pointless.stdout}${pointless.stderr}`, /상류 유형이 없습니다/u);

    // checkpoint로 조이면 같은 생성이 거부되고, 거부가 다음 행동(승인 또는 지시 기록)을 말한다.
    run(['project', 'profile', '--project', 'flow', '--profile', 'lean', '--order-enforcement', 'checkpoint', '--root', ordered, '--json'], ordered);
    const refused = rawRun(['doc', 'create', 'ARC', '순서 차단 구조', '--owner', 'MEMBER-001', '--scope', '차단을 확인하는 구조', '--exclude', '그 밖', '--project', 'flow', '--root', ordered, '--json']);
    assert.notStrictEqual(refused.status, 0);
    assert.match(`${refused.stdout}${refused.stderr}`, /RDL-ORDER-001/u, '차단은 코드로 말해야 한다.');
    assert.match(`${refused.stdout}${refused.stderr}`, /ahead-of-approval/u, '거부가 사용자 지시의 길을 말해야 한다.');

    // 사용자 지시의 기록이 있으면 지나가고, 그 지시가 결과에 남는다.
    const instructed = run(['doc', 'create', 'ARC', '지시로 앞선 구조', '--owner', 'MEMBER-001', '--scope', '지시로 앞선 구조', '--exclude', '그 밖', '--ahead-of-approval', '사용자가 REQ 승인 전 설계 착수를 지시함', '--project', 'flow', '--root', ordered, '--json'], ordered);
    assert.strictEqual(instructed.aheadOfApproval, '사용자가 REQ 승인 전 설계 착수를 지시함');
    assert(instructed.orderNotice.includes('사용자 지시'), '알림이 지시를 함께 나른다.');

    // 상류가 승인되면 게이트는 사라진다 — 그리고 필요 없는 지시 기록은 거부된다.
    run(['client', 'register', 'flow-human', '--name', '검토자', '--type', 'human', '--owner', 'MEMBER-001', '--root', ordered, '--json'], ordered);
    run(['doc', 'approve', requirement.id, '--client-id', 'flow-human', '--member', 'MEMBER-001', '--basis', 'read', '--reason', '읽고 승인', '--project', 'flow', '--root', ordered, '--json'], ordered);
    const clear = run(['doc', 'create', 'ARC', '승인 뒤의 구조', '--owner', 'MEMBER-001', '--scope', '승인 뒤에 서는 구조', '--exclude', '그 밖', '--project', 'flow', '--root', ordered, '--json'], ordered);
    assert.strictEqual(clear.orderNotice, undefined, '승인된 상류 위에는 알림이 없다.');
    const needless = rawRun(['doc', 'create', 'ARC', '필요 없는 지시', '--owner', 'MEMBER-001', '--scope', '필요 없는 지시의 구조', '--exclude', '그 밖', '--ahead-of-approval', '지시', '--project', 'flow', '--root', ordered, '--json']);
    assert.notStrictEqual(needless.status, 0);
    assert.match(`${needless.stdout}${needless.stderr}`, /필요 없는 자리/u);
  } finally {
    fs.rmSync(ordered, { recursive: true, force: true });
  }
}

process.stdout.write('document contract tests passed' + String.fromCharCode(10));
