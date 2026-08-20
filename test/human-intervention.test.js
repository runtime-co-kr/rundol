'use strict';

// 사람 개입 계측 시험. PRD-001의 1차 편익 지표가 이 함수의 출력으로 채워지므로,
// 이 집계가 틀리면 편익 판단 전체가 틀린다.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanInterventionSummary } = require('../src/debug');

function action(taskId, actualExecutor) {
  return { type: 'action', taskId, actualExecutor };
}

// 아무 기록이 없으면 중앙값은 0이 아니라 없음이다. 0으로 내보내면 계측하지 않은
// 상태가 "사람이 한 번도 개입하지 않았다"로 읽힌다.
assert.deepStrictEqual(humanInterventionSummary([]), {
  tasks: [], taskCount: 0, medianHumanActions: null, unattributedActions: 0,
  // 무엇을 세는지와 그것이 하한이라는 사실은 값에 실려 나가야 한다. JSON만 읽는
  // 쪽은 주석을 보지 못하므로, 밝히지 않으면 이 수치를 실제 개입 횟수로 읽는다.
  measures: 'task-bound-cli-actions', lowerBound: true
});
assert.strictEqual(humanInterventionSummary(null).medianHumanActions, null);

// hybrid는 사람으로 센다. 사람이 실제로 손을 댔기 때문이며, 적게 세면 편익이
// 실제보다 좋아 보인다.
const mixed = humanInterventionSummary([
  action('TASK-A', 'llm'), action('TASK-A', 'cli'), action('TASK-A', 'hybrid'),
  action('TASK-B', 'llm'), action('TASK-B', 'llm')
]);
assert.deepStrictEqual(mixed.tasks, [
  { taskId: 'TASK-A', actions: 3, humanActions: 2 },
  { taskId: 'TASK-B', actions: 2, humanActions: 0 }
]);
assert.strictEqual(mixed.taskCount, 2);
assert.strictEqual(mixed.medianHumanActions, 1);

// 홀수 개는 가운데 값이다.
const odd = humanInterventionSummary([
  action('TASK-A', 'cli'),
  action('TASK-B', 'llm'),
  action('TASK-C', 'cli'), action('TASK-C', 'cli'), action('TASK-C', 'hybrid')
]);
assert.strictEqual(odd.medianHumanActions, 1);

// 태스크에 결박되지 않은 행위는 집계에서 빠지되 그 수가 보여야 한다. 감추면
// 중앙값이 전체를 대표하는 것처럼 읽힌다.
const loose = humanInterventionSummary([action(null, 'cli'), action(undefined, 'llm'), action('TASK-A', 'cli')]);
assert.strictEqual(loose.unattributedActions, 2);
assert.strictEqual(loose.taskCount, 1);

// action이 아닌 이벤트는 세지 않는다.
assert.strictEqual(humanInterventionSummary([{ type: 'token-usage', taskId: 'TASK-A' }]).taskCount, 0);

// 순수 함수다. 같은 입력을 반복해도 결과가 같고 입력을 바꾸지 않는다.
const input = [action('TASK-A', 'cli'), action('TASK-B', 'llm')];
const frozen = JSON.stringify(input);
const once = JSON.stringify(humanInterventionSummary(input));
assert.strictEqual(JSON.stringify(humanInterventionSummary(input)), once);
assert.strictEqual(JSON.stringify(input), frozen, '집계가 입력 배열을 바꿨습니다.');

// 실제 명령 출력에 지표가 실려 나오는지 확인한다. 함수만 맞고 표면에 안 나오면
// 아무도 그 수치를 보지 못한다.
const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
// 갓 만든 작업공간에서 잰다. 이 기계에 있는 프로젝트에 기대면 CI에서 실패하고,
// 그러면 지표가 표면에 실려 나오는지를 아무도 확인하지 않게 된다.
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-intervention-'));
try {
  const env = Object.assign({}, process.env, { RUNDOL_HOME: path.join(probe, 'runtime') });
  const setup = (program, args) => {
    const done = spawnSync(program, args, { cwd: probe, encoding: 'utf8', env });
    assert.strictEqual(done.status, 0, `${program} ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
  };
  setup('git', ['init', '-b', 'main']);
  setup('git', ['config', 'user.name', 'Rundol Test']);
  setup('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(probe, 'README.md'), '# intervention\n', 'utf8');
  setup('git', ['add', 'README.md']);
  setup('git', ['commit', '-m', 'initial']);
  setup(process.execPath, [cli, 'init', 'crm', '--name', 'CRM', '--profile', 'lean', '--root', probe, '--json']);

  const result = spawnSync(process.execPath, [cli, 'debug', 'summary', '--project', 'crm', '--root', probe, '--json'], { cwd: repository, encoding: 'utf8', env });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert(summary.humanInterventions, 'debug summary에 humanInterventions가 없습니다.');
  assert(Object.prototype.hasOwnProperty.call(summary.humanInterventions, 'medianHumanActions'));
  assert(Array.isArray(summary.humanInterventions.tasks));
} finally {
  fs.rmSync(probe, { recursive: true, force: true });
}

// 로그는 진단이지 정본이 아니다. 상한이 없으면 계측을 기본으로 켜는 순간 로컬
// 디스크를 조용히 먹는다. 상한에 닿으면 오래된 줄부터 버려야 하고, 그 판정은
// 줄 수가 아니라 바이트여야 한다 — 줄 길이가 고르지 않기 때문이다.
//
// 그리고 그 바이트는 UTF-8 바이트여야 한다. ASCII만으로 재면 문자열 length가
// 우연히 바이트 수와 같아서, 코드 단위를 세는 구현도 통과한다. Rundol의 로그는
// 한글이 섞이는 것이 정상이므로 한글로도 재야 상한이 실제로 지켜진다.
{
  const { appendDebug, MAX_LOG_BYTES } = require('../src/debug');
  assert.strictEqual(typeof MAX_LOG_BYTES, 'number');
  assert(MAX_LOG_BYTES > 0 && MAX_LOG_BYTES <= 8 * 1024 * 1024, `상한이 비정상입니다: ${MAX_LOG_BYTES}`);

  // 'y'는 1바이트, '가'는 UTF-8에서 3바이트다. 뒤엣것은 length와 byteLength가
  // 갈리므로 코드 단위를 세는 구현이 여기서 드러난다.
  for (const [label, unit] of [['ASCII', 'y'], ['한글', '가']]) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-log-cap-'));
    try {
      const logs = path.join(workspace, '.rundol', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      const file = path.join(logs, 'debug.jsonl');
      // 상한을 넘기는 분량을 미리 채운다. appendDebug 한 번이 잘라내야 한다.
      const filler = `${JSON.stringify({ at: 'x', type: 'action', pad: unit.repeat(400) })}\n`;
      const fillerBytes = Buffer.byteLength(filler, 'utf8');
      fs.writeFileSync(file, filler.repeat(Math.ceil(MAX_LOG_BYTES / fillerBytes) + 200), 'utf8');
      assert(fs.statSync(file).size > MAX_LOG_BYTES, `${label} 시험 준비가 상한을 넘기지 못했습니다.`);

      fs.writeFileSync(path.join(workspace, '.rundol', 'workspace.yaml'), 'schemaVersion: 1\n', 'utf8');
      appendDebug(workspace, { type: 'action', action: 'test.run', actualExecutor: 'cli' });

      const after = fs.statSync(file).size;
      assert(after <= MAX_LOG_BYTES, `${label} 로그가 상한을 넘겼습니다: ${after}`);
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      // 방금 쓴 줄은 남아야 한다. 새 줄을 버리면 계측이 최신을 잃는다.
      assert(lines[lines.length - 1].includes('test.run'), `${label}에서 가장 최근 기록이 잘려 나갔습니다.`);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

process.stdout.write('human intervention tests passed\n');
