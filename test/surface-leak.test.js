'use strict';

// 개념 누출 금지. 사람에게 내보내는 표면에 내부 구현 개념이 새면, 사람은 제품이
// 아니라 구현을 배워야 한다. 그리고 한번 샌 개념은 화면·문서·습관에 자리를 잡아
// 나중에 걷어내기가 훨씬 비싸진다.
//
// 이 시험은 둘로 나뉜다.
//
// 하나는 새로 만드는 워커 계약 표면에 대한 엄격한 금지다. 새 표면에는 처음부터
// 한 글자도 새면 안 되므로 예외를 두지 않는다.
//
// 다른 하나는 이미 새고 있는 기존 표면에 대한 래칫이다. 오늘의 누출을 기준선으로
// 적어 두고, 줄어드는 것은 허용하되 늘어나는 것은 실패로 만든다. 기존 표면을 한
// 번에 고칠 수 없다고 해서 더 나빠지는 것까지 허용할 이유는 없다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyReport } = require('../src/worker-contract');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');

// 사람 표면에 나오면 안 되는 내부 개념. 값이 아니라 어휘를 막는다.
const FORBIDDEN = ['runId', 'run-id', 'leaseId', 'lease', 'clientId', 'client-id', 'worktree', 'schemaVersion', 'ownerToken', 'operationId', 'lens'];

function leakedTokens(text) {
  const haystack = String(text);
  return FORBIDDEN.filter((token) => haystack.includes(token));
}

// ── 새 표면: 예외 없음 ───────────────────────────────────────────────────

const assignment = {
  id: 'ASG-001',
  goal: '검색이 제목과 본문을 모두 찾는다',
  acceptance: [{ id: 'AC-001', text: '제목으로 찾는다' }],
  functionIds: ['WRK-01'],
  allowedPaths: ['src/search/**'],
  forbidden: [],
  procedure: { name: 'impl', revision: 3, digest: 'a'.repeat(64) },
  reportSchema: 'report-v1',
  assignee: { kind: 'human', id: 'MEMBER-001' },
  state: 'open'
};
const report = {
  id: 'RPT-001',
  assignmentId: 'ASG-001',
  worker: { kind: 'human', id: 'MEMBER-001' },
  schema: 'report-v1',
  outcome: 'done',
  claims: [{ id: 'AC-001', met: false, evidence: '' }],
  changed: ['src/board/ui.js'],
  procedureDigest: 'b'.repeat(64)
};

for (const value of [assignment, report, verifyReport(assignment, report)]) {
  const leaked = leakedTokens(JSON.stringify(value));
  assert.deepStrictEqual(leaked, [], `워커 계약 표면에 내부 개념이 샜습니다: ${leaked.join(', ')}`);
}

// 계약 선언 자체에도 새면 안 된다. 타입에 남으면 구현이 따라 들어온다.
for (const declaration of ['assignment.d.ts', 'report.d.ts']) {
  const source = fs.readFileSync(path.join(repository, 'types', declaration), 'utf8');
  // 주석에서 개념을 설명하는 것은 허용한다. 막으려는 것은 필드 이름이다.
  const fields = source.split('\n').filter((line) => /^\s{2}[A-Za-z]/u.test(line)).join('\n');
  const leaked = leakedTokens(fields);
  assert.deepStrictEqual(leaked, [], `types/${declaration}의 필드 이름에 내부 개념이 샜습니다: ${leaked.join(', ')}`);
}

// ── 기존 표면: 래칫 ──────────────────────────────────────────────────────

// 2026-08-20 실측. 이 목록은 줄어들기만 해야 한다. 늘리려면 왜 새 개념을 사람에게
// 보여야 하는지를 먼저 설명해야 하고, 대개 그 설명은 존재하지 않는다.
const KNOWN_LEAKS = {
  // 조회 결과가 아직 작업공간 판 번호를 그대로 내보낸다.
  context: ['schemaVersion'],
  // task migrate, doc approve, sync --approved-by 셋이 아직 클라이언트 식별자를 요구한다.
  // 세 명령 모두 사람이 매일 칠 것이 아니므로 우선순위는 낮지만, 세 개에서 늘어나면 실패다.
  help: ['client-id']
};

function ratchet(name, output) {
  const found = leakedTokens(output);
  const allowed = KNOWN_LEAKS[name];
  const unexpected = found.filter((token) => !allowed.includes(token));
  assert.deepStrictEqual(unexpected, [], `${name}에 새 개념 누출이 생겼습니다: ${unexpected.join(', ')}`);
  // 래칫이 헐거워지지 않게 한다. 기준선에 적어 둔 누출이 이미 사라졌다면 기준선을
  // 줄여야 하며, 줄이지 않으면 다음 누출이 그 자리에 숨는다.
  const stale = allowed.filter((token) => !found.includes(token));
  assert.deepStrictEqual(stale, [], `${name}의 기준선 항목이 이미 해소되었습니다. KNOWN_LEAKS에서 지우세요: ${stale.join(', ')}`);
}

// 조회 결과의 래칫은 갓 만든 작업공간에서 잰다. 저장소 루트에 기대면 개발자
// 기계에서만 통과하고 CI에서는 붙은 작업공간이 없어 실패한다 — 그러면 래칫은
// 사람이 잊을 때만 도는 장치가 된다.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-surface-leak-'));
try {
  const env = Object.assign({}, process.env, { RUNDOL_HOME: path.join(temporary, 'runtime') });
  const setup = (program, args) => {
    const done = spawnSync(program, args, { cwd: temporary, encoding: 'utf8', env });
    assert.strictEqual(done.status, 0, `${program} ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
  };
  setup('git', ['init', '-b', 'main']);
  setup('git', ['config', 'user.name', 'Rundol Test']);
  setup('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# surface leak\n', 'utf8');
  setup('git', ['add', 'README.md']);
  setup('git', ['commit', '-m', 'initial']);
  setup(process.execPath, [cli, 'init', 'crm', '--name', 'CRM', '--profile', 'lean', '--root', temporary, '--json']);

  const context = spawnSync(process.execPath, [cli, 'context', '--project', 'crm', '--root', temporary, '--json'], { cwd: repository, encoding: 'utf8', env });
  assert.strictEqual(context.status, 0, context.stderr || context.stdout);
  ratchet('context', context.stdout);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

// 사람이 보는 명령 목록. 내부 실행 개념이 여기 나오면 사람은 제품이 아니라 구현을
// 배워야 한다. 실행 원장·임대·어댑터 명령군은 rdl advanced로 내렸으므로 이 목록에
// 남은 누출은 옵션 이름뿐이어야 한다.
const humanHelp = spawnSync(process.execPath, [cli, '--help'], { cwd: repository, encoding: 'utf8' });
assert.strictEqual(humanHelp.status, 0, humanHelp.stderr || humanHelp.stdout);
ratchet('help', humanHelp.stdout);

process.stdout.write('surface leak tests passed\n');
