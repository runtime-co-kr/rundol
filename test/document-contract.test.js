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
  assert.strictEqual(scr.satisfied, true, '한 문서가 모두 가지면 유형 판정은 충족이다');
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
}

// 진단은 경고이며 강제 수준과 무관하게 저장·동기화를 막지 않는다
{
  const check = fs.readFileSync(path.join(repository, 'src', 'check.js'), 'utf8');
  const rule = check.slice(check.indexOf("code: 'RDL-PROFILE-010'"), check.indexOf("code: 'RDL-PROFILE-010'") + 200);
  assert.ok(rule.includes("severity: 'warning'"), 'RDL-PROFILE-010은 경고여야 합니다.');
  assert.ok(!rule.includes('settings.strict'), '강제 수준에 따라 오류로 올리지 않습니다.');
}

process.stdout.write('document contract tests passed\n');
