'use strict';

// 검증 판정의 독립성(REQ-042).
//
// 다양성 요구는 켤 수는 있지만 만족될 수 없는 상태였다. 허용 어댑터가 언제나 하나로
// 좁혀졌기 때문에, 켠 프로젝트는 결과가 계속 "사람 판단 필요"로 나왔고 그것이 판정인지
// 자기 설정 실수인지 알 수 없었다. 여기서 보는 것은 그 둘이 이제 갈라지는가이다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyArtifact, foldVerdicts } = require('../src/verify');
const { pinProcedureInstructions } = require('../src/procedure');
const { getLens, pinInstruction } = require('../src/instruction-registry');

const PREVIOUS_WINDOWS_ADAPTER = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-verify-independence-'));
const home = path.join(temporary, 'runtime');

function environment() {
  return Object.assign({}, process.env, { RUNDOL_HOME: home });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8', env: environment() });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: repository, encoding: 'utf8', env: environment() });
  assert.strictEqual(result.status, 0, `rdl ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

// 판정자가 모델일 필요는 없다. 규칙 검사기도 판정자이고, 이 스텁이 바로 그것이다 —
// 문서를 열어 보지도 않고 자기 이름만 붙여 통과를 낸다. 다양성 계산이 세는 것은
// 판정의 내용이 아니라 그것을 낸 판정자의 가짓수이므로, 이 스텁 하나가 하나로 셈된다.
function ruleChecker(name) {
  return async (invocation) => ({
    exitCode: 0,
    status: 'success',
    result: { verdict: 'pass', findings: [] },
    adapter: { name, instructionId: invocation.instruction.id, instructionRevision: invocation.instruction.revision, instructionDigest: invocation.instruction.instructionDigest }
  });
}

// 검증은 깨끗한 worktree를 요구한다. 만든 문서를 커밋하지 않으면 이 시험은 무엇을
// 물어도 dirty-worktree로 먼저 멈추고, 그것을 자기가 기대한 거부로 읽는다.
function createDoc(projectRoot, title, scope) {
  const created = rdl(['doc', 'create', 'PRD', title, '--project', 'crm', '--owner', 'MEMBER-001', '--scope', scope, '--exclude', '그 밖']);
  git(['add', '.'], projectRoot);
  git(['commit', '-m', `add ${created.id}`], projectRoot);
  return created;
}

function writeHarness(projectRoot, verify, adapters) {
  const entry = (name) => [name, { enabled: true, command: process.execPath, argsTemplate: ['-e', ';', '{instruction}', '{context}', '{result}'], timeoutSeconds: 30 }];
  fs.writeFileSync(path.join(projectRoot, 'harness.json'), `${JSON.stringify({
    schemaVersion: 1, revision: 1, adapters: Object.fromEntries(adapters.map(entry)), verify
  }, null, 2)}\n`, 'utf8');
  git(['add', '.'], projectRoot);
  git(['commit', '-m', 'harness'], projectRoot);
}

async function main() {
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Rundol Test']);
    git(['config', 'user.email', 'rundol@example.test']);
    fs.writeFileSync(path.join(temporary, 'README.md'), '# independence\n', 'utf8');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
    rdl(['client', 'register', 'agent-a', '--name', '검증 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);
    const projectRoot = path.join(temporary, 'projects', 'crm');

    // ── 어댑터 둘, 정족수 2, 다양성 요구 ────────────────────────────────
    const target = rdl(['doc', 'create', 'PRD', '다양성 대상', '--project', 'crm', '--owner', 'MEMBER-001',
      '--scope', '다양성이 만족되는지 보는 문서', '--exclude', '그 밖']);
    writeHarness(projectRoot, { defaultAdapter: 'judge-a', defaultLenses: ['satisfaction-v1'], maxConcurrency: 2 }, ['judge-a', 'judge-b']);

    const seen = [];
    const diverse = await verifyArtifact(temporary, {
      project: 'crm', targetId: target.id, clientId: 'agent-a', lenses: ['satisfaction-v1'],
      adapters: ['judge-a', 'judge-b'],
      policy: { validators: 2, quorum: 2, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: true },
      runAdapterOnce: (invocation) => { seen.push(`${invocation.lensId}:${invocation.adapter.name}`); return ruleChecker(invocation.adapter.name)(invocation); }
    });
    assert.strictEqual(diverse.status, 'passed', `다양성이 만족되어야 통과합니다: ${JSON.stringify(diverse.fold)}`);
    assert.deepStrictEqual(seen.slice().sort(), ['satisfaction-v1:judge-a', 'satisfaction-v1:judge-b']);
    assert.strictEqual(diverse.fold.lenses[0].diversity, 2, JSON.stringify(diverse.fold.lenses[0]));
    // 접근 방식이 판정에 함께 남는다. 읽고 통과시킨 것과 돌려 보고 통과시킨 것은
    // 같은 무게가 아니므로, 나중에 이 판정을 읽는 사람이 구분할 수 있어야 한다.
    assert(diverse.verdicts.every((item) => item.approach === 'static'), JSON.stringify(diverse.verdicts.map((item) => item.approach)));

    // slot에서 어댑터로 가는 배분은 순수 함수다. 다시 계산해도 같은 자리에 같은
    // 판정자가 온다 — 무작위였다면 재개가 다른 판정자의 결과를 재사용하게 된다.
    const resumed = [];
    const again = await verifyArtifact(temporary, {
      project: 'crm', targetId: target.id, clientId: 'agent-a', lenses: ['satisfaction-v1'],
      adapters: ['judge-a', 'judge-b'], rootRequestId: diverse.rootRequestId,
      policy: { validators: 2, quorum: 2, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: true },
      runAdapterOnce: (invocation) => { resumed.push(invocation.adapter.name); return ruleChecker(invocation.adapter.name)(invocation); }
    });
    assert.deepStrictEqual(resumed, [], '재개는 이미 있는 판정을 다시 부르지 않습니다');
    assert.deepStrictEqual(again.verdicts.map((item) => item.adapter.name).sort(), ['judge-a', 'judge-b']);

    // ── 만족될 수 없는 선언은 실행 전에 거부된다 ─────────────────────────
    const single = createDoc(projectRoot, '단일 판정자 대상', '만족 불가능한 선언을 보는 문서');
    await assert.rejects(() => verifyArtifact(temporary, {
      project: 'crm', targetId: single.id, clientId: 'agent-a', lenses: ['satisfaction-v1'],
      adapters: ['judge-a'],
      policy: { validators: 2, quorum: 2, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: true },
      runAdapterOnce: () => { throw new Error('만족 불가능한 정책으로 어댑터를 부르면 안 됩니다.'); }
    }), /requireAdapterDiversity는 quorum\(2\) 이상의 어댑터를 요구하는데 1개만/u);

    // 절차에 적힌 것도 로드에서 거부한다. 실행 시점에만 막으면 그 절차는 저장되고
    // 공유되어, 쓰는 사람마다 같은 실패를 처음부터 겪는다.
    const badStep = {
      revision: 1, idempotent: true, steps: [{
        id: 'verify', executor: 'adapter',
        verify: { lenses: ['satisfaction-v1'], adapters: ['only-one'], policy: { validators: 2, quorum: 2, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: true } }
      }]
    };
    assert.throws(() => pinProcedureInstructions(badStep, 'test'), /requireAdapterDiversity에 quorum\(2\) 이상의 어댑터가 필요한데 1개만/u);
    // validators가 quorum보다 적은 것도 구조적으로 만족될 수 없다.
    assert.throws(() => pinProcedureInstructions({
      revision: 1, idempotent: true, steps: [{
        id: 'verify', executor: 'adapter',
        verify: { lenses: ['satisfaction-v1'], adapters: ['a', 'b'], policy: { validators: 1, quorum: 2, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: true } }
      }]
    }, 'test'), /validators\(1\)가 quorum\(2\)보다 적어/u);

    // ── 선택 렌즈는 실행되지 못해도 검증을 막지 않는다 ────────────────────
    //
    // 다만 결과에서 사라지지도 않는다. 보고 없이 지나가면 그 렌즈는 켜 둔 적도
    // 없는 것이 된다.
    const optional = createDoc(projectRoot, '선택 렌즈 대상', '선택 렌즈가 빠져도 완료되는지 보는 문서');
    assert.strictEqual(getLens('reproduction-v1').required, false);
    assert.strictEqual(getLens('reproduction-v1').approach, 'dynamic');
    const withOptional = await verifyArtifact(temporary, {
      project: 'crm', targetId: optional.id, clientId: 'agent-a',
      lenses: ['satisfaction-v1', 'reproduction-v1'],
      adapters: ['judge-a'],
      // 재현 렌즈는 스크립트 실행기가 답한다. 그것이 설정에 없으므로 이 렌즈는
      // 실행되지 못한다 — 필수 렌즈였다면 검증이 미완이어야 한다.
      lensAdapters: { 'reproduction-v1': ['script-runner'] },
      policy: { validators: 1, quorum: 1, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: false },
      runAdapterOnce: (invocation) => ruleChecker(invocation.adapter.name)(invocation)
    });
    assert.strictEqual(withOptional.status, 'passed', JSON.stringify(withOptional.fold));
    assert.deepStrictEqual(withOptional.undispatchedLenses, ['reproduction-v1']);
    const reproduction = withOptional.fold.lenses.find((item) => item.lens === 'reproduction-v1');
    assert.strictEqual(reproduction.status, 'undispatched', JSON.stringify(reproduction));

    // 필수 렌즈의 판정자가 없으면 같은 상황이 거부다. 실행되지 못한 것과 실행되어
    // 할 말이 없던 것이 같은 값이 되면, "확인 못 함"이 "이상 없음"이 된다.
    await assert.rejects(() => verifyArtifact(temporary, {
      project: 'crm', targetId: optional.id, clientId: 'agent-a', lenses: ['satisfaction-v1'],
      adapters: ['judge-a'], lensAdapters: { 'satisfaction-v1': ['script-runner'] },
      runAdapterOnce: () => { throw new Error('없는 어댑터로 부르면 안 됩니다.'); }
    }), /verification adapter is disabled or unknown: script-runner/u);

    // ── 미실행과 기권은 다른 값이다 ──────────────────────────────────────
    {
      const rootRequestId = 'REQ-DDDDDDDDDDDDDDDDDDDD';
      const reviewedRevision = 'a'.repeat(40);
      const policy = { rootRequestId, targetId: 'PRD-001', reviewedRevision, lenses: ['satisfaction-v1', 'reproduction-v1'], validators: 1, quorum: 1, maxRefuted: 0, maxAbstain: 0 };
      const empty = foldVerdicts([], policy);
      const required = empty.lenses.find((item) => item.lens === 'satisfaction-v1');
      const notRequired = empty.lenses.find((item) => item.lens === 'reproduction-v1');
      assert.strictEqual(required.status, 'human_required', '필수 렌즈의 부재는 미완입니다');
      assert.strictEqual(notRequired.status, 'undispatched', '선택 렌즈의 부재는 미실행입니다');
      assert.strictEqual(empty.status, 'human_required', '필수 렌즈가 없으므로 전체는 미완입니다');
    }

    // ── 발견 사항은 재현 방법을 담을 수 있다 ─────────────────────────────
    const reproducible = createDoc(projectRoot, '재현 정보 대상', '발견에 재현 방법이 실리는지 보는 문서');
    const refuted = await verifyArtifact(temporary, {
      project: 'crm', targetId: reproducible.id, clientId: 'agent-a', lenses: ['satisfaction-v1'],
      adapters: ['judge-a'],
      runAdapterOnce: async (invocation) => ({
        exitCode: 0, status: 'success',
        result: { verdict: 'refuted', findings: [{ summary: '수용 기준이 근거 없이 통과로 적혀 있습니다.', reproduce: 'node bin/rdl.js check PRD-001 --strict' }] },
        adapter: { name: 'judge-a', instructionId: invocation.instruction.id, instructionRevision: invocation.instruction.revision, instructionDigest: invocation.instruction.instructionDigest }
      })
    });
    assert.strictEqual(refuted.status, 'refuted');
    assert.strictEqual(refuted.fold.findings[0].reproduce, 'node bin/rdl.js check PRD-001 --strict');

    void pinInstruction;
    process.stdout.write('verify independence tests passed\n');
  } finally {
    if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
    else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = main();
