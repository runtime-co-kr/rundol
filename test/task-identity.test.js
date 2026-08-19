'use strict';

// 태스크 식별자 이관(REQ-045).
//
// 이관은 이름을 바꾸는 일이 아니라 연결을 옮기는 일이다. 태스크만 바꾸고 그것을
// 가리키던 것을 남기면, 이관은 연결을 끊는 작업이 된다. 여기서 보는 것은 옮긴 뒤에도
// 모든 참조가 이어지는가, 그리고 옮길 수 없는 곳에 남은 옛 이름을 다시 이을 수
// 있는가이다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isLegacyTaskId, planTaskIdMigration, migrateTaskIds } = require('../src/task-identity');

const LEGACY_A = 'TASK-01J000000000000000000001';
const LEGACY_B = 'TASK-01J000000000000000000002';
const SHORT = /^TASK-[0-9A-HJKMNP-TV-Z]{8}$/u;

assert.strictEqual(isLegacyTaskId(LEGACY_A), true);
assert.strictEqual(isLegacyTaskId('TASK-AWM8ZS3N'), false, '이미 짧은 식별자는 이관 대상이 아닙니다');
assert.strictEqual(isLegacyTaskId('MEMBER-001'), false);

// 새 식별자는 서로도, 남아 있는 옛 식별자와도 겹치지 않아야 한다.
{
  const plan = planTaskIdMigration([LEGACY_A, LEGACY_B, 'TASK-AWM8ZS3N']);
  assert.strictEqual(plan.size, 2, '짧은 식별자는 계획에 들어가지 않습니다');
  const mapped = Array.from(plan.values());
  assert(mapped.every((id) => SHORT.test(id)), mapped.join(', '));
  assert.strictEqual(new Set(mapped).size, mapped.length, '새 식별자가 서로 겹칩니다');
  assert(!mapped.includes('TASK-AWM8ZS3N'), '새 식별자가 남아 있는 식별자와 겹칩니다');
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-task-identity-'));
try {
  const projectRoot = path.join(temporary, 'crm');
  fs.mkdirSync(path.join(projectRoot, 'docs', 'requirements'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'tasks.json'), `${JSON.stringify({
    schemaVersion: 1,
    tasks: {
      [LEGACY_A]: { title: '옛 태스크 A', status: 'doing', project: 'crm' },
      [LEGACY_B]: { title: '옛 태스크 B', status: 'done', project: 'crm', deps: [LEGACY_A] },
      'TASK-AWM8ZS3N': { title: '새 태스크', status: 'todo', project: 'crm' }
    }
  }, null, 2)}\n`, 'utf8');
  // 산문 속 참조도 함께 옮겨야 한다. 태스크만 바꾸면 이 줄이 없는 태스크를 가리킨다.
  fs.writeFileSync(path.join(projectRoot, 'docs', 'requirements', 'REQ-001-대상.md'),
    `# 대상\n\n이 요구는 ${LEGACY_A}에서 다룬다. 후속은 ${LEGACY_B}이다.\n`, 'utf8');

  // 미리보기는 아무것도 바꾸지 않는다.
  const planned = migrateTaskIds(projectRoot, { dryRun: true });
  assert.strictEqual(planned.migrated, 2);
  assert(fs.readFileSync(path.join(projectRoot, 'tasks.json'), 'utf8').includes(LEGACY_A), '미리보기가 파일을 바꿨습니다');

  const applied = migrateTaskIds(projectRoot, { dryRun: false });
  assert.strictEqual(applied.migrated, 2);
  const store = JSON.parse(fs.readFileSync(path.join(projectRoot, 'tasks.json'), 'utf8'));
  const ids = Object.keys(store.tasks);
  assert.strictEqual(ids.length, 3);
  assert(ids.every((id) => SHORT.test(id)), ids.join(', '));

  const newA = applied.plan[LEGACY_A];
  const newB = applied.plan[LEGACY_B];
  assert.strictEqual(store.tasks[newA].title, '옛 태스크 A');
  // 태스크 사이의 참조도 함께 옮겨진다. 하나만 바꾸면 의존이 없는 태스크를 가리킨다.
  assert.deepStrictEqual(store.tasks[newB].deps, [newA]);
  // 산문 참조도 옮겨진다.
  const prose = fs.readFileSync(path.join(projectRoot, 'docs', 'requirements', 'REQ-001-대상.md'), 'utf8');
  assert(prose.includes(newA) && prose.includes(newB), prose);
  assert(!prose.includes(LEGACY_A) && !prose.includes(LEGACY_B), prose);

  // 옮길 수 없는 곳 — 이미 만들어진 커밋의 trailer, 원장에 적힌 이벤트 — 에는 옛
  // 식별자가 그대로 남는다. 이력은 고쳐 쓰지 않기 때문이다. 그것을 다시 이으려면
  // 매핑이 정본에 남아야 하고, 그 자리는 태스크 자신이다.
  assert.deepStrictEqual(store.tasks[newA].previousIds, [LEGACY_A],
    '옛 식별자가 보존되지 않으면 과거 감사 기록과 다시 이을 수 없습니다');
  assert.deepStrictEqual(store.tasks[newB].previousIds, [LEGACY_B]);
  assert.strictEqual(store.tasks['TASK-AWM8ZS3N'].previousIds, undefined,
    '옮기지 않은 태스크에 이관 흔적을 남기지 않습니다');

  // 두 번 돌려도 아무 일도 일어나지 않는다. 이관은 끝난 상태에서 멱등이다.
  const repeated = migrateTaskIds(projectRoot, { dryRun: false });
  assert.strictEqual(repeated.migrated, 0);
  assert.deepStrictEqual(repeated.files, []);

  // 저장소가 없으면 이관할 것도 없다.
  assert.strictEqual(migrateTaskIds(path.join(temporary, 'empty'), { dryRun: true }).migrated, 0);

  process.stdout.write('task identity tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
