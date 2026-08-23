'use strict';

// 제약과 게이트의 발화 이력. 죽은 제약과 작동하는 제약을 가르는 계측이다.
//
// 여기서 물을 것은 두 층이다. 접기는 값만 보고 답하므로 파일 없이 시험하고, 실제로
// 받아 적는지는 작업공간을 만들어 명령줄로 확인한다. 접기만 시험하면 "잘 접는데 아무도
// 안 넘겨 준다"는 상태를 통과시키고, 명령줄만 시험하면 접기가 왜 그 답을 냈는지 물을
// 수 없다.
//
// 계측의 시험이 특히 조심해야 하는 것은 자기 자신이다. 계측이 고장 나도 검사는 계속
// 통과하므로, 시험이 "검사가 성공했다"만 보면 계측이 아무것도 적지 않아도 초록으로
// 남는다. 그래서 모든 단언이 기록된 값을 직접 본다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const telemetry = require('../src/rule-telemetry');
const { DEFAULT_TASK_GATES } = require('../src/check-rules');
const { EXEMPTABLE_GATES } = require('../src/vocabulary');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

// ── 접기: 값만 보고 답한다 ────────────────────────────────────────────────

function sweep(at, codes, gates, surface) {
  return { v: 1, kind: 'sweep', at, surface: surface || 'check', codes: codes || {}, gates: gates || {} };
}

{
  // 발화 0건도 기록이다. 돌린 적이 없는 것과 돌렸는데 안 걸린 것이 같아지면 이 계측은
  // 아무것도 답하지 못한다 — 그 둘을 가르는 것이 존재 이유다.
  const empty = telemetry.foldRuleRecords([sweep('2026-08-01T00:00:00.000Z')]);
  assert.deepStrictEqual(empty.runs, { check: 1 }, '걸린 것이 없어도 한 번 돌린 것은 남는다');
  assert.deepStrictEqual(empty.codes, {}, '걸리지 않은 코드는 집계에 나타나지 않는다');

  const folded = telemetry.foldRuleRecords([
    sweep('2026-08-01T00:00:00.000Z', { 'RDL-TASK-019': { n: 2, blocking: 2 } }, { 'done-requires-test-link': { n: 2, blocking: 2 } }),
    sweep('2026-08-02T00:00:00.000Z', { 'RDL-TASK-019': { n: 1, blocking: 0 }, 'RDL-PROFILE-002': { n: 1, blocking: 0 } }),
    sweep('2026-08-03T00:00:00.000Z', {}, {}, 'save')
  ]);

  // 세는 축이 셋인 이유는 셋 다 다른 질문에 답하기 때문이다. 한 축만 내면 "많이 걸리는
  // 제약"과 "실제로 막는 제약"이 같아 보인다.
  assert.deepStrictEqual(folded.codes['RDL-TASK-019'], {
    occurrences: 3, sweeps: 2, blocking: 2,
    firstAt: '2026-08-01T00:00:00.000Z', lastAt: '2026-08-02T00:00:00.000Z'
  }, '건수와 검사 횟수와 막은 건수는 각각 센다');
  assert.strictEqual(folded.gates['done-requires-test-link'].occurrences, 2, '게이트도 이름으로 집계된다');
  assert.deepStrictEqual(folded.runs, { check: 2, save: 1 }, '표면별로 몇 번 돌았는지가 남는다');

  // advisory로 내린 제약은 걸려도 막지 않는다. blocking이 0이라는 사실이 그것을 말하며,
  // occurrences만 보면 잘 작동하는 제약처럼 보인다.
  assert.strictEqual(folded.codes['RDL-PROFILE-002'].blocking, 0, '막지 않은 발화는 막은 것으로 세지 않는다');
}

{
  // 서 있는 우회는 검사를 돌릴 때마다 다시 보인다. 볼 때마다 세면 검사를 자주 돌린
  // 저장소에서 우회가 수백 건으로 불어나고, 그 숫자로는 아무 판단도 할 수 없다.
  const standing = (at) => ({
    v: 1, kind: 'bypass', at, surface: 'check', standing: true, scope: 'gate',
    rule: 'done-requires-test-link', subject: 'TASK-0001',
    reason: '검증 문서가 아직 없다.', decidedBy: 'MEMBER-001'
  });
  const folded = telemetry.foldRuleRecords([
    standing('2026-08-01T00:00:00.000Z'),
    standing('2026-08-02T00:00:00.000Z'),
    standing('2026-08-03T00:00:00.000Z')
  ]);
  assert.strictEqual(folded.bypasses.length, 1, '같은 결정은 몇 번을 보든 한 건이다');
  assert.strictEqual(folded.bypasses[0].observations, 3, '본 횟수는 따로 남는다');
  assert.strictEqual(folded.bypasses[0].firstAt, '2026-08-01T00:00:00.000Z');
  assert.strictEqual(folded.bypasses[0].lastAt, '2026-08-03T00:00:00.000Z');
  assert.strictEqual(folded.bypasses[0].reason, '검증 문서가 아직 없다.', '사유가 함께 조회된다');

  // 사유가 다르면 다른 결정이다. 같은 게이트를 같은 태스크에서 다시 면제했다는 사실이
  // 첫 결정에 흡수되면, 두 번째 사유는 어디에도 남지 않는다.
  const twice = telemetry.foldRuleRecords([standing('2026-08-01T00:00:00.000Z'), Object.assign(standing('2026-08-04T00:00:00.000Z'), { reason: '다른 사유' })]);
  assert.strictEqual(twice.bypasses.length, 2, '사유가 다르면 다른 우회다');

  // 그때 한 번 지나간 우회는 접으면 사라진다. 같은 사유로 열 번 저장했으면 열 번이다.
  const acted = (at) => ({ v: 1, kind: 'bypass', at, surface: 'save', standing: false, scope: 'code', rule: 'RDL-TASK-033', reason: '설정 반영' });
  const events = telemetry.foldRuleRecords([acted('2026-08-01T00:00:00.000Z'), acted('2026-08-02T00:00:00.000Z')]);
  assert.strictEqual(events.bypasses.length, 2, '일어난 우회는 일어난 만큼 센다');
}

{
  // rollup은 압축의 결과이고, 압축한 저장소와 압축하지 않은 저장소는 같은 답을 내야
  // 한다. 갈리면 로그가 커진 날부터 이력이 조용히 달라진다.
  const records = [
    sweep('2026-08-01T00:00:00.000Z', { 'RDL-TASK-019': { n: 2, blocking: 2 } }),
    sweep('2026-08-02T00:00:00.000Z', { 'RDL-TASK-019': { n: 1, blocking: 1 } })
  ];
  const direct = telemetry.foldRuleRecords(records);
  const rolled = telemetry.foldRuleRecords([{
    v: 1, kind: 'rollup', at: '2026-08-02T00:00:00.000Z', through: direct.through,
    runs: direct.runs, codes: direct.codes, gates: direct.gates
  }]);
  assert.deepStrictEqual(rolled.codes, direct.codes, '접은 것을 다시 접어도 같은 수치다');
  assert.deepStrictEqual(rolled.runs, direct.runs, '실행 횟수도 접기를 견딘다');
}

{
  // 깨진 줄 하나가 나머지를 못 읽게 만들면, 계측이 고장 난 날 이후의 이력이 통째로
  // 사라진다. 접기는 모르는 모양을 만나도 넘어간다.
  const folded = telemetry.foldRuleRecords([null, 'not-an-object', { kind: '모르는종류', at: '2026-08-01T00:00:00.000Z' }, sweep('2026-08-01T00:00:00.000Z')]);
  assert.deepStrictEqual(folded.runs, { check: 1 }, '읽을 수 있는 것만 읽는다');
}

// ── 전체 목록: 손으로 적지 않는다 ─────────────────────────────────────────

{
  const universe = telemetry.ruleUniverse();
  // 목록을 손으로 적으면 새 진단을 올리는 것을 잊었을 때 그 제약은 "죽었다"는 판정조차
  // 받지 못한다. 그래서 소스에서 파생하며, 파생은 낡을 수 없다.
  assert(universe.codes.length > 200, `진단 코드 수가 예상보다 적습니다: ${universe.codes.length}`);
  assert(universe.codes.includes('RDL-TASK-019'), '실제로 쓰이는 코드가 목록에 있어야 한다');
  assert.deepStrictEqual(universe.codes, universe.codes.slice().sort(), '목록은 정렬되어 재현 가능하다');
  for (const gate of Object.keys(DEFAULT_TASK_GATES)) assert(universe.gates.includes(gate), `게이트가 빠졌습니다: ${gate}`);
  for (const gate of EXEMPTABLE_GATES) assert(universe.gates.includes(gate), `면제 가능한 게이트가 빠졌습니다: ${gate}`);
}

// ── 명령줄: 실제로 받아 적는가 ────────────────────────────────────────────

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(workspace, args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', workspace, '--json']), root));
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (path.basename(source) === '.rundol' && ['local', 'worktrees', 'pending', 'logs'].includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-rule-telemetry-'));
try {
  const workspace = path.join(temporary, 'workspace');
  copyDirectory(path.join(root, 'test', 'fixtures', 'workspace'), workspace);
  command('git', ['init', '-b', 'main'], workspace);
  command('git', ['config', 'user.name', 'Rundol Test'], workspace);
  command('git', ['config', 'user.email', 'rundol@example.test'], workspace);
  command('git', ['add', '.'], workspace);
  command('git', ['commit', '-m', 'initial workspace'], workspace);
  rdl(workspace, ['git', 'init']);

  // 검사를 돌리기 전에는 증거가 없다. 그 상태를 "모든 제약이 죽었다"로 읽으면 안 되며,
  // checks가 0이라는 사실이 그것을 말한다.
  const before = rdl(workspace, ['rule', 'dead', '--project', 'tms']);
  assert.strictEqual(before.checks, 0, '돌린 적이 없으면 0이다');
  assert.strictEqual(before.dead, before.total, '증거가 없으면 전부 목록에 남는다');
  assert.strictEqual(before.lowerBound, true, '이 수치가 하한이라는 것을 값으로 밝힌다');
  assert.strictEqual(before.measures, 'locally-recorded-firings', '무엇을 센 값인지 값으로 밝힌다');

  // ── AC-001: 어느 진단이 언제 몇 번 걸렸는지 ─────────────────────────────
  spawnSync(process.execPath, [cli, 'check', '--root', workspace, '--project', 'tms'], { cwd: root, encoding: 'utf8' });
  const first = rdl(workspace, ['rule', 'history', '--project', 'tms']);
  assert.strictEqual(first.checks, 1, '검사 한 번이 한 번으로 기록된다');
  assert.deepStrictEqual(first.surfaces, [{ surface: 'check', runs: 1 }], '어느 표면이 돌았는지가 남는다');
  assert(first.rules.length > 0, `픽스처는 진단을 내야 이 시험이 성립한다: ${JSON.stringify(first)}`);
  const sample = first.rules[0];
  assert(sample.firstAt && sample.lastAt, '언제 걸렸는지가 남는다');
  assert.strictEqual(sample.sweeps, 1, '한 번의 검사에서 걸린 것은 한 번이다');

  // 두 번 돌리면 두 번으로 쌓인다. 덮어쓰면 "몇 번"을 물을 수 없다.
  spawnSync(process.execPath, [cli, 'check', '--root', workspace, '--project', 'tms'], { cwd: root, encoding: 'utf8' });
  const second = rdl(workspace, ['rule', 'history', '--project', 'tms']);
  assert.strictEqual(second.checks, 2, '이력은 쌓인다');
  const again = second.rules.find((entry) => entry.rule === sample.rule);
  assert.strictEqual(again.sweeps, 2, `${sample.rule}이 두 검사 모두에서 걸려야 한다`);
  assert(again.lastAt >= sample.lastAt, '마지막 발화 시각이 앞으로 간다');

  // 코드 하나만 물을 수도 있어야 한다. 이백 개를 다 받아서 사람이 찾는 것은 조회가 아니다.
  const one = rdl(workspace, ['rule', 'history', '--project', 'tms', '--rule', sample.rule]);
  assert.strictEqual(one.rules.length, 1, '지목한 제약만 돌려준다');
  assert.strictEqual(one.rules[0].rule, sample.rule);

  // ── AC-003: 한 번도 걸린 적 없는 제약 ──────────────────────────────────
  const dead = rdl(workspace, ['rule', 'dead', '--project', 'tms']);
  assert.strictEqual(dead.checks, 2, '몇 번 돌린 끝에 나온 목록인지 함께 낸다');
  assert.strictEqual(dead.live, second.rules.length, '걸린 것과 안 걸린 것의 합이 전체다');
  assert.strictEqual(dead.dead + dead.live, dead.total);
  const deadNames = new Set(dead.rules.map((entry) => entry.rule));
  assert(!deadNames.has(sample.rule), '걸린 제약은 죽은 목록에 없다');
  assert(dead.dead > 0, '이 픽스처에서 모든 제약이 걸릴 리는 없다');

  // ── AC-002: 우회된 제약과 그 사유 ──────────────────────────────────────
  //
  // 면제는 판정 자체가 돌지 않으므로 진단을 내지 않는다. 발화만 세면 면제로 조용해진
  // 게이트와 지킬 것이 없어 조용한 게이트가 같아 보인다.
  const created = rdl(workspace, ['task', 'add', '계측 우회 시험', '--project', 'tms', '--summary', '면제가 기록되는지 본다.', '--owner', 'MEMBER-001', '--acceptance', '기록된다.']);
  // 완료조건을 채우고 닫는다. 채우지 않으면 다른 게이트가 먼저 막아, 이 시험이 보려는
  // 면제가 아니라 그 게이트가 답을 정한다.
  rdl(workspace, ['task', 'acceptance', created.taskId, 'AC-001', '--done', '--project', 'tms']);
  rdl(workspace, ['task', 'set', created.taskId, '--project', 'tms', '--status', 'done', '--exempt', 'done-requires-test-link', '--reason', '검증 문서가 아직 없다.', '--decided-by', 'MEMBER-001']);
  spawnSync(process.execPath, [cli, 'check', '--root', workspace, '--project', 'tms'], { cwd: root, encoding: 'utf8' });

  const bypasses = rdl(workspace, ['rule', 'bypasses', '--project', 'tms']);
  const exemption = bypasses.bypasses.find((entry) => entry.subject === created.taskId);
  assert(exemption, `면제가 기록되지 않았습니다: ${JSON.stringify(bypasses)}`);
  assert.strictEqual(exemption.rule, 'done-requires-test-link', '어느 게이트가 우회됐는지가 남는다');
  assert.strictEqual(exemption.reason, '검증 문서가 아직 없다.', '사유가 함께 조회된다');
  assert.strictEqual(exemption.decidedBy, 'MEMBER-001', '누가 결정했는지가 남는다');
  assert.strictEqual(exemption.standing, true, '태스크에 남아 있는 우회다');

  // 우회된 게이트는 죽은 것이 아니라 꺼진 것이다. 둘을 같이 세면, 지금 우회되고 있는
  // 규칙이 지워도 되는 규칙으로 읽힌다.
  const afterExemption = rdl(workspace, ['rule', 'dead', '--project', 'tms']);
  const gateRow = afterExemption.rules.find((entry) => entry.rule === 'done-requires-test-link');
  if (gateRow) assert.strictEqual(gateRow.exempted, true, '면제된 게이트는 그 사실을 달고 나온다');

  // 검사를 더 돌려도 같은 면제는 한 건이다. 볼 때마다 세면 이 목록은 곧 읽히지 않는다.
  spawnSync(process.execPath, [cli, 'check', '--root', workspace, '--project', 'tms'], { cwd: root, encoding: 'utf8' });
  const repeated = rdl(workspace, ['rule', 'bypasses', '--project', 'tms']);
  assert.strictEqual(
    repeated.bypasses.filter((entry) => entry.subject === created.taskId).length, 1,
    '같은 면제를 다시 봐도 한 건이다'
  );
  assert(
    repeated.bypasses.find((entry) => entry.subject === created.taskId).observations > exemption.observations,
    '본 횟수는 늘어난다'
  );
  assert.strictEqual(repeated.unexplained, 0, '사유 없는 우회가 있으면 그것부터 봐야 한다');

  // ── 계측은 판정을 바꾸지 않는다 ────────────────────────────────────────
  //
  // 로그를 쓸 수 없는 상태에서도 검사는 같은 답을 내야 한다. 계측이 검사를 막으면 그
  // 순간 계측은 규칙이 되고, 계측을 끄는 것이 규칙을 바꾸는 일이 된다.
  const logs = path.join(workspace, 'projects', 'tms', '.rundol', 'logs');
  const clean = spawnSync(process.execPath, [cli, 'check', '--root', workspace, '--project', 'tms', '--json'], { cwd: root, encoding: 'utf8' });
  fs.rmSync(logs, { recursive: true, force: true });
  fs.writeFileSync(logs, '로그 자리를 파일이 막고 있다', 'utf8');
  const blocked = spawnSync(process.execPath, [cli, 'check', '--root', workspace, '--project', 'tms', '--json'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(blocked.status, clean.status, '기록에 실패해도 검사의 종료 코드는 같다');
  assert.deepStrictEqual(
    JSON.parse(blocked.stdout).diagnostics.map((item) => item.code),
    JSON.parse(clean.stdout).diagnostics.map((item) => item.code),
    '기록에 실패해도 검사의 판정은 같다'
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log('rule telemetry tests passed');
