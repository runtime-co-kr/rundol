'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const ledger = require(path.join(root, 'src', 'run-ledger.js'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-run-ledger-'));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

const procedure = {
  name: 'document.author-verified',
  revision: 1,
  schemaVersion: 1,
  steps: [
    { id: 'author' },
    { id: 'mech-gate', gate: { command: 'check', args: ['--strict'] }, onFail: { goto: 'author', maxAttempts: 2 } },
    { id: 'save' }
  ]
};

try {
  // 절차 검증: goto는 앞선 스텝만, revision·스텝 형식 강제.
  assert.throws(() => ledger.validateProcedure({ name: 'x', revision: 1, steps: [{ id: 'a', onFail: { goto: 'b', maxAttempts: 1 } }, { id: 'b' }] }), /앞선 스텝만/u);
  assert.throws(() => ledger.validateProcedure(Object.assign({}, procedure, { revision: 0 })), /revision/u);

  // 단독 원장 시나리오 fold (workspace 불필요 — 순수 로컬).
  const unit = path.join(temporary, 'unit-run');
  const started = ledger.appendRunEvent(unit, {
    type: 'run.started', runId: 'RUN-0123456789ABCDEF0123', projectId: 'crm', clientId: 'laptop-a', goal: '테스트',
    procedure: { name: procedure.name, revision: 1, schemaVersion: 1, contentHash: 'x', resolved: procedure }
  });
  assert(started.event.eventId.startsWith('EVT-'));

  ledger.appendRunEvent(unit, { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'laptop-a' });
  let fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.cursor, 'mech-gate');
  assert.deepStrictEqual(fold.completedSteps, ['author']);

  // 게이트 실패 → goto로 author 재작업, attempts는 fold가 계산.
  ledger.appendRunEvent(unit, { type: 'run.gate', stepId: 'mech-gate', exitCode: 1, diagnostics: ['RDL-DOC-004'], clientId: 'laptop-a' });
  fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.cursor, 'author');
  assert.strictEqual(fold.attempts['mech-gate'], 1);
  assert.deepStrictEqual(fold.lastGate.diagnostics, ['RDL-DOC-004']);

  // 상한 도달: halted 이벤트 없이도 fold가 attempt-limit을 강제.
  ledger.appendRunEvent(unit, { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'laptop-a' });
  ledger.appendRunEvent(unit, { type: 'run.gate', stepId: 'mech-gate', exitCode: 1, diagnostics: [], clientId: 'laptop-a' });
  fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.status, 'halted');
  assert.strictEqual(fold.haltReason, 'attempt-limit');

  // 크래시 절단: 불완전한 꼬리는 읽기에서 무시되고, 다음 append가 결정적으로 복구한다.
  const file = path.join(unit, 'events.jsonl');
  const beforeCrash = ledger.foldRun(ledger.readRunEvents(unit));
  fs.appendFileSync(file, '{"type":"run.gate","exitCo', 'utf8');
  assert.deepStrictEqual(ledger.foldRun(ledger.readRunEvents(unit)), beforeCrash);
  ledger.appendRunEvent(unit, { type: 'run.resumed', fromStep: 'author', clientId: 'laptop-a' });
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean)) JSON.parse(line);

  // 재개는 시도 예산을 되살린다. 이후 통과한 스텝의 과거 실패는 소급되지 않는다.
  fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.status, 'running');
  assert.strictEqual(fold.cursor, 'author');
  ledger.appendRunEvent(unit, { type: 'run.step', stepId: 'author', executor: 'adapter', exitCode: 0, clientId: 'laptop-a' });
  ledger.appendRunEvent(unit, { type: 'run.gate', stepId: 'mech-gate', exitCode: 0, diagnostics: [], clientId: 'laptop-a' });
  ledger.appendRunEvent(unit, { type: 'run.step', stepId: 'save', executor: 'cli', exitCode: 0, clientId: 'laptop-a' });
  ledger.appendRunEvent(unit, { type: 'run.completed_local', commit: 'abc', clientId: 'laptop-a' });
  fold = ledger.foldRun(ledger.readRunEvents(unit));
  assert.strictEqual(fold.status, 'completed_local');
  assert.strictEqual(fold.cursor, null);
  assert.deepStrictEqual(fold.completedSteps, ['author', 'mech-gate', 'save']);

  // fold 결정성: 같은 이벤트 열 → 같은 결과.
  const events = ledger.readRunEvents(unit);
  assert.deepStrictEqual(ledger.foldRun(events), ledger.foldRun(events));

  // 중간 줄 손상은 관용 대상이 아니라 원장 파손이다.
  const corrupt = path.join(temporary, 'corrupt-run');
  ledger.appendRunEvent(corrupt, { type: 'run.started', runId: 'RUN-0123456789ABCDEF0124', projectId: 'crm', clientId: 'laptop-a', procedure: { name: 'x.y', revision: 1, contentHash: 'x', resolved: { name: 'x.y', revision: 1, steps: [{ id: 'a' }] } } });
  const corruptFile = path.join(corrupt, 'events.jsonl');
  fs.appendFileSync(corruptFile, '{"broken\n', 'utf8');
  ledger.appendRunEvent(corrupt, { type: 'run.step', stepId: 'a', exitCode: 0, clientId: 'laptop-a' });
  assert.throws(() => ledger.readRunEvents(corrupt), /파싱할 수 없습니다/u);

  // 실제 workspace에서 createRun: 경로 배치, Git 제외, 공유 events/ 무접촉 (AC-P0b ⑤).
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  JSON.parse(command(process.execPath, [cli, 'init', 'crm', '--name', '고객 관리', '--root', temporary, '--json'], root));

  const created = ledger.createRun(temporary, { project: 'crm', goal: '결제 REQ', clientId: 'laptop-a', procedure });
  assert(ledger.RUN_ID.test(created.runId));
  assert(created.directory.startsWith(path.join(temporary, 'projects', 'crm', '.rundol', 'runs')));
  const runFold = ledger.foldRun(ledger.readRunEvents(created.directory));
  assert.strictEqual(runFold.status, 'running');
  assert.strictEqual(runFold.cursor, 'author');
  assert.strictEqual(runFold.procedure.name, 'document.author-verified');
  assert.strictEqual(ledger.listRuns(path.join(temporary, 'projects', 'crm')).length, 1);

  const workspaceEvents = path.join(temporary, 'projects', 'workspace', 'events');
  assert(!fs.existsSync(workspaceEvents) || fs.readdirSync(workspaceEvents).length === 0);
  const projectStatus = command('git', ['status', '--short'], path.join(temporary, 'projects', 'crm'));
  assert(!projectStatus.includes('.rundol'));

  process.stdout.write('run ledger tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
