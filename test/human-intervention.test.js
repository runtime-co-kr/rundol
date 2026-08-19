'use strict';

// 사람 개입 계측 시험. PRD-001의 1차 편익 지표가 이 함수의 출력으로 채워지므로,
// 이 집계가 틀리면 편익 판단 전체가 틀린다.

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { humanInterventionSummary } = require('../src/debug');

function action(taskId, actualExecutor) {
  return { type: 'action', taskId, actualExecutor };
}

// 아무 기록이 없으면 중앙값은 0이 아니라 없음이다. 0으로 내보내면 계측하지 않은
// 상태가 "사람이 한 번도 개입하지 않았다"로 읽힌다.
assert.deepStrictEqual(humanInterventionSummary([]), {
  tasks: [], taskCount: 0, medianHumanTurns: null, unattributedActions: 0
});
assert.strictEqual(humanInterventionSummary(null).medianHumanTurns, null);

// hybrid는 사람으로 센다. 사람이 실제로 손을 댔기 때문이며, 적게 세면 편익이
// 실제보다 좋아 보인다.
const mixed = humanInterventionSummary([
  action('TASK-A', 'llm'), action('TASK-A', 'cli'), action('TASK-A', 'hybrid'),
  action('TASK-B', 'llm'), action('TASK-B', 'llm')
]);
assert.deepStrictEqual(mixed.tasks, [
  { taskId: 'TASK-A', actions: 3, humanTurns: 2 },
  { taskId: 'TASK-B', actions: 2, humanTurns: 0 }
]);
assert.strictEqual(mixed.taskCount, 2);
assert.strictEqual(mixed.medianHumanTurns, 1);

// 홀수 개는 가운데 값이다.
const odd = humanInterventionSummary([
  action('TASK-A', 'cli'),
  action('TASK-B', 'llm'),
  action('TASK-C', 'cli'), action('TASK-C', 'cli'), action('TASK-C', 'hybrid')
]);
assert.strictEqual(odd.medianHumanTurns, 1);

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
const result = spawnSync(process.execPath, [path.join(repository, 'bin', 'rdl.js'), 'debug', 'summary', '--project', 'rundol', '--json'], { cwd: repository, encoding: 'utf8' });
assert.strictEqual(result.status, 0, result.stderr || result.stdout);
const summary = JSON.parse(result.stdout);
assert(summary.humanInterventions, 'debug summary에 humanInterventions가 없습니다.');
assert(Object.prototype.hasOwnProperty.call(summary.humanInterventions, 'medianHumanTurns'));
assert(Array.isArray(summary.humanInterventions.tasks));

process.stdout.write('human intervention tests passed\n');
