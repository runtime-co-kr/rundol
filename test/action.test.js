'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');

function command(program, args, cwd, options) {
  return spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    env: Object.assign({}, process.env, options && options.debug ? { RUNDOL_DEBUG: '1' } : {})
  });
}

function successful(cwd, args, options) {
  const result = command(process.execPath, [cli].concat(args, ['--root', cwd, '--json']), root, options);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-action-'));
try {
  assert.strictEqual(command('git', ['init', '-b', 'main'], temporary).status, 0);
  assert.strictEqual(command('git', ['config', 'user.name', 'Rundol Test'], temporary).status, 0);
  assert.strictEqual(command('git', ['config', 'user.email', 'rundol@example.test'], temporary).status, 0);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n', 'utf8');
  assert.strictEqual(command('git', ['add', 'README.md'], temporary).status, 0);
  assert.strictEqual(command('git', ['commit', '-m', 'initial'], temporary).status, 0);

  const initialized = successful(temporary, ['init', 'memo', '--name', '메모 앱'], { debug: true });
  const prd = successful(temporary, ['doc', 'create', 'PRD', '메모 제품 요구사항', '--owner', 'MEMBER-001', '--scope', '메모 제품의 사용자 문제와 성공 기준', '--exclude', '개별 메모 작성 동작'], { debug: true });
  const prdSource = fs.readFileSync(prd.file, 'utf8');
  assert(prdSource.includes('title: 메모 제품 요구사항'));
  assert(!prdSource.includes('제품 요구사항 제품 요구사항'));
  const req = successful(temporary, ['doc', 'create', 'REQ', '메모 작성', '--owner', 'MEMBER-001', '--scope', '사용자가 새 메모를 저장하는 동작', '--exclude', '메모 검색과 삭제', '--related', 'PRD-001'], { debug: true });
  assert.strictEqual(req.id, 'REQ-001');
  const tst = successful(temporary, ['doc', 'create', 'TST', '메모 인수 테스트', '--owner', 'MEMBER-001', '--scope', '새 메모 저장 요구사항의 인수 검증', '--exclude', '검색과 삭제 검증', '--related', 'REQ-001'], { debug: true });
  assert.strictEqual(tst.id, 'TST-001');

  const task = successful(temporary, ['task', 'add', '메모 구현', '--owner', 'MEMBER-001', '--link', 'TST-001', '--acceptance', '동작을 확인한다.'], { debug: true });
  const accepted = successful(temporary, ['task', 'acceptance', task.taskId, 'AC-001', '--done'], { debug: true });
  assert.strictEqual(accepted.after.acceptanceCriteria['AC-001'].done, true);
  const done = successful(temporary, ['task', 'set', task.taskId, '--status', 'done'], { debug: true });
  assert.strictEqual(done.after.status, 'done');

  const route = successful(temporary, ['action', 'resolve', 'document.edit']);
  assert.strictEqual(route.recommendedExecutor, 'hybrid');
  successful(temporary, ['action', 'record', 'code.edit', '--actual-executor', 'llm']);
  const rejectedFallback = command(process.execPath, [cli, 'action', 'record', 'document.create', '--actual-executor', 'llm', '--root', temporary, '--json'], root);
  assert.strictEqual(rejectedFallback.status, 2);
  successful(temporary, ['action', 'record', 'document.create', '--actual-executor', 'llm', '--fallback-reason', 'CLI가 지원하지 않는 기존 문서 변환']);
  successful(temporary, ['debug', 'record', '--provider', 'test', '--model', 'not-reported', '--client', 'codex', '--input-tokens', '0', '--output-tokens', '0', '--unreported']);

  fs.appendFileSync(path.join(temporary, 'projects', 'memo', 'project.md'), '\n[[MISSING-ACTION-TEST]]\n', 'utf8');
  const failedCheck = command(process.execPath, [cli, 'check', '--strict', '--root', temporary, '--json'], root, { debug: true });
  assert.strictEqual(failedCheck.status, 1, failedCheck.stderr || failedCheck.stdout);

  const summary = successful(temporary, ['debug', 'summary']);
  assert(summary.actionEvents >= 6, JSON.stringify(summary, null, 2));
  assert(summary.actualExecutors.cli >= 4);
  assert(summary.actualExecutors.llm >= 2);
  assert.strictEqual(summary.fallbackActions, 1);
  assert.strictEqual(summary.unreportedTokenEvents, 1);

  const events = fs.readFileSync(path.join(temporary, 'projects', 'memo', '.rundol', 'logs', 'debug.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const failedCommand = events.find((event) => event.type === 'command' && event.exitCode === 1);
  assert(failedCommand);
  assert.strictEqual(failedCommand.status, 'failed');
  process.stdout.write('action routing tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
