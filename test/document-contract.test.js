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
  const guidedReq = run(['doc', 'create', 'REQ', '요구사항', '--owner', 'MEMBER-001', '--scope', '사용자가 항목을 등록하는 동작', '--exclude', '항목 조회와 삭제', '--function-id', 'ITEM-01', '--related', 'project:demo', '--project', 'demo', '--root', root, '--json'], root);
  assert.strictEqual(guidedReq.type, 'REQ');
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
    policy: { required: ['REQ'], recommended: [], onDemand: catalog.documentTypes.filter((t) => t !== 'REQ' && t !== 'SCR'), disabled: ['SCR'] },
    rules: Object.fromEntries(catalog.documentTypes.map((type) => [type, { after: [] }])),
    omissions: { SCR: { absorbedBy: 'REQ', sections: ['사용자 흐름', '화면 상태'] } }
  };
  const artifact = (id, sections) => ({ id, type: 'REQ', source: sections.map((s) => `## ${s}\n내용\n`).join('') });
  const evaluation = evaluateDocumentContract(profile, [
    artifact('REQ-001', ['사용자 흐름', '화면 상태']),
    artifact('REQ-002', ['사용자 흐름']),
    artifact('REQ-003', [])
  ]);
  const scr = evaluation.absorbed.find((item) => item.type === 'SCR');
  assert.strictEqual(scr.satisfied, true, '한 문서가 모두 가지면 충족이다');
  assert.deepStrictEqual(scr.complete, ['REQ-001']);
  assert.deepStrictEqual(scr.partial, ['REQ-002'], '일부만 가진 문서를 가려낸다');
  assert.deepStrictEqual(scr.absent, ['REQ-003'], '전혀 없는 문서는 따로 센다');
  assert.deepStrictEqual(scr.coverage.find((c) => c.id === 'REQ-002').missing, ['화면 상태']);
  assert.strictEqual(evaluation.violations.length, 0, '일부 보유는 계약 위반이 아니다. 차단하지 않는다');

  // 대상 문서가 하나도 섹션을 갖지 않으면 그때는 유형 판정 자체가 실패한다
  const empty = evaluateDocumentContract(profile, [artifact('REQ-001', [])]);
  const emptyScr = empty.absorbed.find((item) => item.type === 'SCR');
  assert.strictEqual(emptyScr.satisfied, false);
  assert.deepStrictEqual(emptyScr.absent, ['REQ-001']);
  assert.deepStrictEqual(emptyScr.partial, []);

  // 구성요소가 여러 문서에 흩어져 있으면, 섹션별로는 다 있어도 충족이 아니다.
  // 어느 문서도 그 주제를 온전히 설명하지 않는다.
  const split = evaluateDocumentContract(profile, [artifact('REQ-001', ['사용자 흐름']), artifact('REQ-002', ['화면 상태'])]);
  const splitScr = split.absorbed.find((item) => item.type === 'SCR');
  assert.strictEqual(splitScr.satisfied, false, '절반씩 나눠 가지면 충족이 아니다');
  assert.deepStrictEqual(splitScr.complete, []);
  assert.deepStrictEqual(splitScr.missingSections, [], '섹션 자체는 어딘가에 다 있다');
  assert.deepStrictEqual(split.violations.map((v) => v.code), ['omission-sections-split']);
}

// 일부 보유 진단은 고쳐야 할 문서를 가리켜야 한다. 헌장을 가리키면 열어봐도 할 일이 없다.
{
  const check = fs.readFileSync(path.join(repository, 'src', 'check.js'), 'utf8');
  const rule = check.slice(check.indexOf("code: 'RDL-PROFILE-010'"), check.indexOf("code: 'RDL-PROFILE-010'") + 320);
  assert.ok(rule.includes('artifact && artifact.file'), 'RDL-PROFILE-010은 해당 문서 경로를 보고해야 합니다.');
  assert.ok(check.includes("'omission-sections-split': 'RDL-PROFILE-011'"), '분산 위반에 코드가 필요합니다.');
}

// 진단은 경고이며 강제 수준과 무관하게 저장·동기화를 막지 않는다
{
  const check = fs.readFileSync(path.join(repository, 'src', 'check.js'), 'utf8');
  const rule = check.slice(check.indexOf("code: 'RDL-PROFILE-010'"), check.indexOf("code: 'RDL-PROFILE-010'") + 200);
  assert.ok(rule.includes("severity: 'warning'"), 'RDL-PROFILE-010은 경고여야 합니다.');
  assert.ok(!rule.includes('settings.strict'), '강제 수준에 따라 오류로 올리지 않습니다.');
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
    const { planDocumentContract, updateDocumentContract, loadDocumentContract } = require('../src/document-contract');
    const target = 'SCR';
    const started = loadDocumentContract(contractRoot, 'demo');
    const policy = { required: started.profile.policy.required.filter((type) => type !== target), recommended: started.profile.policy.recommended.filter((type) => type !== target), onDemand: started.profile.policy.onDemand.filter((type) => type !== target), disabled: started.profile.policy.disabled.concat(started.profile.policy.disabled.includes(target) ? [] : [target]) };
    updateDocumentContract(contractRoot, 'demo', { baseRevision: started.revision, policy });
    const base = loadDocumentContract(contractRoot, 'demo');
    assert.ok(base.profile.omissions[target] && base.profile.omissions[target].sections.length, '비활성 유형에 기본 구성요소가 있어야 이 검사가 성립합니다.');

    // 1) 구성요소를 비워 보내면 지금 값을 지운 것이 아니라 그대로 둔다
    const emptied = planDocumentContract(contractRoot, 'demo', {
      omissions: Object.assign({}, base.profile.omissions, { [target]: { absorbedBy: base.profile.omissions[target].absorbedBy, sections: [] } })
    });
    assert.deepStrictEqual(emptied.profile.omissions[target].sections, base.profile.omissions[target].sections, '빈 구성요소가 기존 설정을 지웠습니다.');

    // 2) 직접 정한 구성요소는 그대로 살아남는다
    const custom = planDocumentContract(contractRoot, 'demo', {
      omissions: Object.assign({}, base.profile.omissions, { [target]: { absorbedBy: base.profile.omissions[target].absorbedBy, sections: ['우리가 정한 항목'] } })
    });
    assert.deepStrictEqual(custom.profile.omissions[target].sections, ['우리가 정한 항목']);

    // 3) 해당 없음 처분은 화면이 만들어 보내는 흡수 대상·구성요소에 덮이지 않는다
    updateDocumentContract(contractRoot, 'demo', { baseRevision: base.revision, omissions: Object.assign({}, base.profile.omissions, { [target]: { notApplicable: true, reason: '이 제품에는 없는 영역' } }) });
    const after = loadDocumentContract(contractRoot, 'demo');
    assert.strictEqual(after.profile.omissions[target].notApplicable, true, '해당 없음 처분이 기록되어야 합니다.');
    const overwritten = planDocumentContract(contractRoot, 'demo', {
      omissions: Object.assign({}, after.profile.omissions, { [target]: { absorbedBy: 'REQ', sections: [] } })
    });
    assert.strictEqual(overwritten.profile.omissions[target].notApplicable, true, '해당 없음 처분이 저장 한 번에 사라졌습니다.');
    assert.strictEqual(overwritten.profile.omissions[target].reason, '이 제품에는 없는 영역', '처분 사유까지 보존해야 합니다.');
  } finally {
    fs.rmSync(contractRoot, { recursive: true, force: true });
  }
}

process.stdout.write('document contract tests passed\n');
