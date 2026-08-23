'use strict';

// 규칙의 발화 이력. 죽은 규칙과 작동하는 규칙을 가르는 계측이다.
//
// 두 층을 시험한다. 접기는 값만 보고 답하므로 파일 없이 보고, 실제로 원장에 적히는지는
// 작업공간을 만들어 명령줄로 확인한다. 접기만 보면 "잘 접는데 아무도 안 넘겨 준다"는
// 상태가 통과하고, 명령줄만 보면 접기가 왜 그 답을 냈는지 물을 수 없다.
//
// 계측의 시험이 특히 조심할 것은 자기 자신이다. 계측이 고장 나도 검사는 계속 통과하므로
// "검사가 성공했다"만 보면 아무것도 안 적혀도 초록으로 남는다. 그래서 모든 단언이 적힌
// 값을 직접 본다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const telemetry = require('../src/rule-telemetry');
const { KINDS } = require('../src/event-store');
const { LEDGERS, EXEMPTABLE_GATES } = require('../src/vocabulary');
const { DEFAULT_TASK_GATES } = require('../src/check-rules');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

// ── 등록부의 두 쪽이 갈리지 않는다 ────────────────────────────────────────

// LEDGERS와 KINDS는 같은 등록부의 두 쪽이다. 한쪽에만 있으면 그 원장의 샤드를
// isLedgerShard가 알아보지 못해 추가 전용 판정의 대상에서 조용히 빠진다.
assert(LEDGERS.includes(telemetry.KIND), `어휘가 ${telemetry.KIND} 원장을 모릅니다.`);
assert(KINDS[telemetry.KIND], `event-store가 ${telemetry.KIND} 원장을 모릅니다.`);
assert.strictEqual(KINDS[telemetry.KIND].flat, false, '발화 이력은 클라이언트별 샤드로 나뉜다');

// ── 봉투: 같은 판정은 같은 이벤트다 ───────────────────────────────────────

{
  const judgment = {
    projectId: 'tms', surface: 'check', target: 'TASK-0001', origin: 'item-type',
    evaluated: ['normal.requiresLink', 'done-requires-test-link'], blocked: [], exempted: []
  };
  const first = telemetry.firingEnvelope(Object.assign({ at: '2026-08-01T00:00:00.000Z', clientId: 'a' }, judgment));
  const later = telemetry.firingEnvelope(Object.assign({ at: '2026-08-09T00:00:00.000Z', clientId: 'b' }, judgment));
  // 시각과 클라이언트는 판정의 답이 아니다. 다이제스트에 넣으면 같은 판정이 기계와
  // 시각마다 새 이벤트가 되고, 원장은 저장소의 활동량만큼 자란다.
  assert.strictEqual(first.eventId, later.eventId, '같은 판정은 언제 누가 내려도 같은 이벤트다');
  // 반대로 답이 달라지면 다른 이벤트여야 한다. 접히면 규칙이 일하기 시작한 사실이 사라진다.
  const blocked = telemetry.firingEnvelope(Object.assign({ at: '2026-08-01T00:00:00.000Z', clientId: 'a' }, judgment, {
    blocked: [{ ruleId: 'done-requires-test-link', code: 'RDL-TASK-019', origin: 'item-type', source: null, method: null, target: 'TASK-0001', message: 'x' }]
  }));
  assert.notStrictEqual(first.eventId, blocked.eventId, '막은 판정은 다른 판정이다');
  // 목록의 순서는 판정의 답이 아니다. 정렬하지 않으면 같은 답이 순서 때문에 갈린다.
  const shuffled = telemetry.firingEnvelope(Object.assign({ at: '2026-08-01T00:00:00.000Z', clientId: 'a' }, judgment, {
    evaluated: ['done-requires-test-link', 'normal.requiresLink']
  }));
  assert.strictEqual(first.eventId, shuffled.eventId, '본 규칙의 순서는 판정을 바꾸지 않는다');
}

// ── 접기: 두 축을 섞지 않는다 ─────────────────────────────────────────────

function firing(at, target, overrides) {
  return Object.assign({
    at, target, surface: 'check', origin: 'item-type', from: null, to: null,
    evaluated: [], blocked: [], exempted: []
  }, overrides || {});
}

{
  const folded = telemetry.foldFirings([
    firing('2026-08-01T00:00:00.000Z', 'TASK-0001', { evaluated: ['normal.fields', 'done-requires-test-link'] }),
    firing('2026-08-02T00:00:00.000Z', 'TASK-0002', {
      evaluated: ['normal.fields', 'done-requires-test-link'],
      blocked: [{ ruleId: 'done-requires-test-link', code: 'RDL-TASK-019', origin: 'item-type', source: null, method: null, target: 'TASK-0002', message: 'TST가 없다' }]
    })
  ]);

  // 막은 것만 세면 "한 번도 안 막은 규칙"과 "한 번도 안 불린 규칙"이 같은 침묵이 된다.
  // 그 둘은 정반대의 뜻이고, 이 계측이 존재하는 이유가 그 구분이다.
  assert.strictEqual(folded.rules['normal.fields'].evaluated, 2, '본 횟수를 센다');
  assert.strictEqual(folded.rules['normal.fields'].blocked, 0, '보기만 하고 막지 않은 것은 막은 것이 아니다');
  assert.strictEqual(folded.rules['done-requires-test-link'].blocked, 1, '막은 것도 따로 센다');
  assert.strictEqual(folded.rules['normal.fields'].firstAt, '2026-08-01T00:00:00.000Z');
  assert.strictEqual(folded.rules['normal.fields'].lastAt, '2026-08-02T00:00:00.000Z');
  assert.strictEqual(folded.judgedTargets, 2, '몇 개 항목을 판정했는지가 남는다');
  assert.deepStrictEqual(folded.origins, { 'item-type': 2 }, '어느 판정이었는지가 남는다');
}

{
  // 면제는 판정을 건너뛴 것이라 본 것으로 세면 안 된다. 세면 면제로 조용해진 게이트가
  // "다들 지키는 규칙"이 되고, 그것은 지워도 되는 규칙이 아니라 지금 우회되는 규칙이다.
  const exempted = { ruleId: 'done-requires-test-link', gate: 'done-requires-test-link', reason: '검증 문서가 아직 없다.', decidedBy: 'MEMBER-001' };
  const folded = telemetry.foldFirings([
    firing('2026-08-01T00:00:00.000Z', 'TASK-0001', { exempted: [exempted] }),
    firing('2026-08-02T00:00:00.000Z', 'TASK-0001', { exempted: [exempted] }),
    firing('2026-08-03T00:00:00.000Z', 'TASK-0002', { exempted: [exempted] })
  ]);
  assert(!folded.rules['done-requires-test-link'], '면제된 게이트는 본 것으로 세지 않는다');
  // 같은 결정을 몇 번 보든 한 건이다. 볼 때마다 세면 검사를 자주 돌린 저장소에서
  // 우회가 수백 건으로 불어나고, 그 숫자로는 아무 판단도 할 수 없다.
  assert.strictEqual(folded.bypasses.length, 2, '항목이 다르면 다른 우회, 같으면 한 건이다');
  const first = folded.bypasses.find((entry) => entry.target === 'TASK-0001');
  assert.strictEqual(first.observations, 2, '본 횟수는 따로 남는다');
  assert.strictEqual(first.reason, '검증 문서가 아직 없다.', '사유가 함께 조회된다');
  assert.strictEqual(first.decidedBy, 'MEMBER-001', '누가 결정했는지가 남는다');
}

{
  // 깨진 레코드 하나가 나머지를 못 읽게 만들면, 계측이 고장 난 날 이후의 이력이 통째로
  // 사라진다. 접기는 모르는 모양을 만나도 넘어간다.
  const folded = telemetry.foldFirings([null, 'not-an-object', firing('2026-08-01T00:00:00.000Z', 'TASK-0001', { evaluated: ['normal.fields'] })]);
  assert.strictEqual(folded.rules['normal.fields'].evaluated, 1, '읽을 수 있는 것만 읽는다');
}

// ── 선언된 규칙의 목록은 데이터에서 파생한다 ──────────────────────────────

{
  const rules = telemetry.declaredRules({
    normal: { constraints: { requiresLink: { TST: {} }, exempt: ['done-requires-test-link'] } },
    test: { constraints: {} }
  });
  const names = rules.map((entry) => entry.rule);
  // 규칙이 데이터로 정의되므로 그 데이터가 곧 목록이다. 따로 적으면 유형을 하나 더할 때
  // 한쪽만 고쳐지고, 목록에 없는 규칙은 "죽었다"는 판정조차 받지 못한다.
  assert(names.includes('normal.requiresLink'), '선언된 제약이 규칙이 된다');
  assert(!names.includes('test.requiresLink'), '선언하지 않은 제약은 규칙이 아니다');
  // exempt는 판정하는 제약이 아니라 판정을 건너뛰게 하는 축이다.
  assert(!names.includes('normal.exempt'), '면제는 규칙이 아니라 축이다');
  for (const gate of Object.keys(DEFAULT_TASK_GATES)) assert(names.includes(gate), `게이트가 빠졌습니다: ${gate}`);
  for (const gate of EXEMPTABLE_GATES) assert(names.includes(gate), `면제 가능한 게이트가 빠졌습니다: ${gate}`);
  assert.deepStrictEqual(names, names.slice().sort(), '목록은 정렬되어 재현 가능하다');
}

// ── 명령줄: 실제로 원장에 적히는가 ────────────────────────────────────────

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(workspace, args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', workspace, '--json']), root));
}

function check(workspace) {
  return spawnSync(process.execPath, [cli, 'check', '--root', workspace, '--project', 'tms', '--json'], { cwd: root, encoding: 'utf8' });
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

  // 여기까지 오는 동안 이미 검사가 돌아 판정이 적혔다. "증거가 없는 상태"를 물으려면
  // 그 증거를 치우고 물어야 한다 — 치우지 않고 물으면 무엇을 시험하는지가 흐려진다.
  fs.rmSync(path.join(workspace, 'projects', 'workspace', 'events', telemetry.KIND), { recursive: true, force: true });

  // 판정을 한 번도 내리지 않았으면 증거가 없다. 그 상태를 "모든 규칙이 죽었다"로 읽으면
  // 안 되며, judgments가 0이라는 사실이 그것을 말한다.
  const before = rdl(workspace, ['rule', 'dead', '--project', 'tms']);
  assert.strictEqual(before.judgments, 0, '판정한 적이 없으면 0이다');
  assert.strictEqual(before.neverEvaluated, before.total, '증거가 없으면 전부 목록에 남는다');
  assert.strictEqual(before.lowerBound, true, '이 수치가 하한이라는 것을 값으로 밝힌다');
  assert.strictEqual(before.measures, 'recorded-judgments', '무엇을 센 값인지 값으로 밝힌다');

  // ── AC-001: 어느 규칙이 언제 몇 번 불렸는지 ────────────────────────────
  check(workspace);
  const first = rdl(workspace, ['rule', 'history', '--project', 'tms']);
  assert(first.judgments > 0, `판정이 원장에 적혀야 합니다: ${JSON.stringify(first)}`);
  assert.deepStrictEqual(first.surfaces, [{ name: 'check', count: first.judgments }], '어느 표면이 물었는지가 남는다');
  assert(first.rules.length > 0, '선언된 규칙이 하나는 불려야 이 시험이 성립한다');
  const sample = first.rules[0];
  assert(sample.firstAt && sample.lastAt, '언제 불렸는지가 남는다');
  assert(sample.evaluated > 0, '본 횟수가 남는다');

  // 샤드는 원장의 규약을 따라야 한다. 따르지 않으면 isLedgerShard가 알아보지 못해
  // 추가 전용 판정의 대상에서 빠지고, 그 사실은 아무 신호도 내지 않는다.
  const shardDirectory = path.join(workspace, 'projects', 'workspace', 'events', telemetry.KIND);
  const shards = fs.readdirSync(shardDirectory);
  assert(shards.length > 0, '샤드가 있어야 한다');
  for (const shard of shards) assert(KINDS[telemetry.KIND].pattern.test(shard), `샤드 파일명이 규약과 다릅니다: ${shard}`);

  // 같은 판정을 다시 적지 않는다. 검사는 저장할 때마다 돌고 보드가 새로 그릴 때마다
  // 도는데, 바뀐 것이 없는 판정을 매번 새로 적으면 원장이 활동량만큼 자란다.
  check(workspace);
  const again = rdl(workspace, ['rule', 'history', '--project', 'tms']);
  assert.strictEqual(again.judgments, first.judgments, '답이 같은 판정은 한 건이다');

  // 규칙 하나만 물을 수도 있어야 한다. 전부 받아서 사람이 찾는 것은 조회가 아니다.
  const one = rdl(workspace, ['rule', 'history', '--project', 'tms', '--rule', sample.rule]);
  assert.strictEqual(one.rules.length, 1, '지목한 규칙만 돌려준다');
  assert.strictEqual(one.rules[0].rule, sample.rule);

  // ── AC-003: 한 번도 불린 적 없는 규칙 ──────────────────────────────────
  //
  // 불린 적 없는 것과 불렸으나 막은 적 없는 것을 섞지 않는다. 앞은 그 규칙이 아무
  // 항목에도 닿지 않는다는 뜻이고, 뒤는 다들 지키고 있다는 뜻일 수도 판정이 늘 참이라는
  // 뜻일 수도 있어 이력이 아니라 사람이 가른다.
  const dead = rdl(workspace, ['rule', 'dead', '--project', 'tms']);
  assert.strictEqual(dead.judgments, first.judgments, '몇 건의 판정 끝에 나온 목록인지 함께 낸다');
  assert.strictEqual(dead.neverEvaluated + dead.neverBlocked + first.rules.filter((entry) => entry.blocked > 0).length, dead.total,
    `세 갈래의 합이 전체여야 합니다: ${JSON.stringify({ never: dead.neverEvaluated, silent: dead.neverBlocked, working: first.rules.filter((entry) => entry.blocked > 0).length, total: dead.total })}`);
  assert(!dead.never.some((entry) => entry.rule === sample.rule), '불린 규칙은 죽은 목록에 없다');
  // 유형 해석기 밖에 있는 게이트도 이력에 남아야 한다. 남지 않으면 실제로 도는 게이트가
  // 죽은 규칙으로 집계된다 — 이력을 처음 켰을 때 그 일이 있었다.
  assert(!dead.never.some((entry) => entry.rule === 'implementation-readiness'),
    `해석기 밖 게이트가 죽은 규칙으로 잡혔습니다: ${JSON.stringify(dead.never)}`);

  // ── AC-002: 우회된 규칙과 그 사유 ──────────────────────────────────────
  const created = rdl(workspace, ['task', 'add', '계측 우회 시험', '--project', 'tms', '--summary', '면제가 기록되는지 본다.', '--owner', 'MEMBER-001', '--acceptance', '기록된다.']);
  // 완료조건을 채우고 닫는다. 채우지 않으면 다른 규칙이 먼저 막아, 이 시험이 보려는
  // 면제가 아니라 그 규칙이 답을 정한다.
  rdl(workspace, ['task', 'acceptance', created.taskId, 'AC-001', '--done', '--project', 'tms']);
  rdl(workspace, ['task', 'set', created.taskId, '--project', 'tms', '--status', 'done',
    '--exempt', 'done-requires-test-link', '--reason', '검증 문서가 아직 없다.', '--decided-by', 'MEMBER-001']);
  check(workspace);

  const bypasses = rdl(workspace, ['rule', 'bypasses', '--project', 'tms']);
  const exemption = bypasses.bypasses.find((entry) => entry.target === created.taskId);
  assert(exemption, `면제가 기록되지 않았습니다: ${JSON.stringify(bypasses)}`);
  assert.strictEqual(exemption.rule, 'done-requires-test-link', '어느 게이트가 우회됐는지가 남는다');
  assert.strictEqual(exemption.reason, '검증 문서가 아직 없다.', '사유가 함께 조회된다');
  assert.strictEqual(exemption.decidedBy, 'MEMBER-001', '누가 결정했는지가 남는다');

  // 면제된 판정은 그 판정에서 본 것으로 세지 않는다. 세면 우회가 "지켜지는 규칙"으로
  // 집계된다. 원장은 추가 전용이라 면제 전에 내린 판정은 그대로 남으며, 그것이 맞다 —
  // 그때는 실제로 게이트가 돌았다. 그래서 여기서 묻는 것은 총합이 아니라 이 태스크의
  // 마지막 판정이 무엇을 했는가다.
  const shard = fs.readdirSync(shardDirectory).map((name) => path.join(shardDirectory, name));
  const records = shard.flatMap((file) => fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line)));
  const mine = records.filter((record) => record.target === created.taskId);
  assert(mine.some((record) => (record.exempted || []).some((entry) => entry.ruleId === 'done-requires-test-link')),
    `면제된 판정이 원장에 없습니다: ${JSON.stringify(mine)}`);
  assert(mine.some((record) => !(record.evaluated || []).includes('done-requires-test-link')),
    '면제한 판정은 그 게이트를 본 것으로 적지 않는다');

  // ── 계측은 판정을 바꾸지 않는다 ────────────────────────────────────────
  //
  // 원장을 쓸 수 없는 상태에서도 검사는 같은 답을 내야 한다. 계측이 검사를 막으면 그
  // 순간 계측은 규칙이 되고, 계측을 끄는 것이 규칙을 바꾸는 일이 된다.
  const clean = check(workspace);
  fs.rmSync(shardDirectory, { recursive: true, force: true });
  fs.writeFileSync(shardDirectory, '샤드 자리를 파일이 막고 있다', 'utf8');
  const blocked = check(workspace);
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
