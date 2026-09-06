'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalRevision, entityRevision, documentRevision, documentRevisions, projectRevision, listDocuments, syncStatus } = require('../src/board-data');
const { REVISION_FORMULAS, REVISION_OWNED_FIELDS, DEFAULT_REVISION_FORMULA, CURRENT_REVISION_FORMULA } = require('../src/vocabulary');
const { queryTasks } = require('../src/board');
const { workspaceLayout, selectProject } = require('../src/workspace');

const root = path.join(__dirname, 'fixtures', 'workspace');
const project = selectProject(workspaceLayout(root), 'tms', true);

assert.strictEqual(entityRevision({ a: 1 }), entityRevision({ a: 1 }));
assert.notStrictEqual(entityRevision({ a: 1 }), entityRevision({ a: 2 }));
assert.strictEqual(canonicalRevision({ b: 2, a: 1 }), canonicalRevision({ a: 1, b: 2 }));
assert.strictEqual(documentRevision({ metadata: { b: 2, a: 1 }, body: 'body' }), documentRevision({ a: 1, b: 2 }, 'body'));

// ── 리비전 계산 판 ────────────────────────────────────────────────────────
//
// 계산을 바꾸는 순간 같은 파일이 다른 리비전을 내고, 그러면 그 전에 기록된 승인이
// 전부 어긋난다 — 승인은 다시 만들 수 없는 사람의 판단이라 되돌릴 방법이 없다.
// 그래서 판을 붙였고, 여기서 재는 것은 두 판이 실제로 다른 것을 재느냐다.
const withState = { id: 'REQ-001', type: 'REQ', title: '판올림', state: 'draft' };
const table = documentRevisions(withState, '본문\n');
assert.deepStrictEqual(Object.keys(table).map(Number), REVISION_FORMULAS.slice(), '판마다 하나씩 재야 합니다.');
assert.notStrictEqual(table[1], table[2], '소유 칸을 적은 문서는 두 판이 다른 값을 냅니다.');
assert.strictEqual(documentRevision(withState, '본문\n'), table[CURRENT_REVISION_FORMULA], '판을 안 적으면 지금 판입니다.');
assert.strictEqual(documentRevision(withState, '본문\n', DEFAULT_REVISION_FORMULA), table[1]);
// 판 1은 옛 계산 그대로여야 한다. 판올림 이전의 코드가 metadata 전부와 본문을 그대로
// 해시했으므로, 그 값이 지금도 같은 자리에서 나와야 옛 승인을 다시 잴 수 있다.
assert.strictEqual(table[1], canonicalRevision({ metadata: withState, body: '본문\n' }), '판 1을 손대면 이미 기록된 승인이 전부 어긋납니다.');

// 소유 칸만 손으로 고친 문서는 판 2에서 같은 리비전이다. 이것이 승인의 자기무효화를
// 끊는 자리이고, 문서의 state가 원장의 투영이 될 수 있는 유일한 조건이다.
for (const field of REVISION_OWNED_FIELDS) {
  const edited = Object.assign({}, withState, { [field]: 'approved' });
  assert.strictEqual(documentRevisions(edited, '본문\n')[2], table[2], `판 2는 ${field} 칸을 재면 안 됩니다.`);
  assert.notStrictEqual(documentRevisions(edited, '본문\n')[1], table[1], `판 1은 ${field} 칸을 재던 계산 그대로여야 합니다.`);
}
// 칸을 새로 넣어도 판 2는 그대로다. 투영은 칸이 없는 문서에 칸을 만들기도 하는데,
// 그때 리비전이 달라지면 방금 적은 승인이 그 자리에서 낡음이 된다.
const withoutState = { id: 'REQ-001', type: 'REQ', title: '판올림' };
const bare = documentRevisions(withoutState, '본문\n');
assert.strictEqual(bare[1], bare[2], '소유 칸이 없는 문서는 두 판이 같은 값을 냅니다 — 판올림이 그 문서의 리비전을 건드리지 않습니다.');
assert.strictEqual(documentRevisions(Object.assign({}, withoutState, { state: 'approved' }), '본문\n')[2], bare[2]);
// 본문과 다른 칸은 여전히 판 2가 잰다. 안 재면 문서를 고쳐도 승인이 낡지 않는다.
assert.notStrictEqual(documentRevisions(withState, '고친 본문\n')[2], table[2]);
assert.notStrictEqual(documentRevisions(Object.assign({}, withState, { title: '다른 제목' }), '본문\n')[2], table[2]);
assert.throws(() => documentRevision(withState, '본문\n', 99), /리비전 계산 판/u, '모르는 판으로 재면 조용히 지금 판으로 떨어지면 안 됩니다.');

const listed = listDocuments(project);
assert(listed.some((document) => document.id === 'project:tms'));
for (const document of listed) {
  const file = path.join(project.root, document.file);
  const parsed = require('../src/frontmatter').parseFrontmatter(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(document.revision, documentRevision({ metadata: parsed.data, body: parsed.body }), `Board/watch revision mismatch: ${document.id}`);
  // 판마다의 값을 문서가 함께 들고 있어야 판정이 파일을 다시 읽지 않는다. 다시 읽으면
  // 그 값이 목록을 만든 시점 밖에서 오고, 그러면 같은 스냅숏이 두 파일을 보게 된다.
  assert.deepStrictEqual(document.revisions, documentRevisions(parsed.data, parsed.body), `판별 리비전 불일치: ${document.id}`);
  assert.strictEqual(document.revision, document.revisions[CURRENT_REVISION_FORMULA]);
}
assert.strictEqual(projectRevision(listed), projectRevision(listed.slice().reverse()));
const sync = syncStatus(project);
assert.strictEqual(sync.project, 'tms');
assert(/^[a-f0-9]{40}$/u.test(sync.head));
assert(['clean', 'modified', 'ahead', 'behind', 'diverged', 'conflict'].includes(sync.state));

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-board-performance-'));
try {
  const tasks = {};
  for (let index = 0; index < 1000; index += 1) tasks[`TASK-${String(index + 1).padStart(6, '0')}`] = { project: 'crm', title: `Task ${index}`, status: index % 5 === 0 ? 'review' : 'todo', priority: 'mid' };
  const client = path.join(temporary, 'client-a');
  fs.mkdirSync(client, { recursive: true });
  fs.writeFileSync(path.join(client, '000001.json'), JSON.stringify({ schemaVersion: 1, clientId: 'client-a', segment: 1, tasks }));
  const started = Date.now();
  const result = queryTasks({ taskFile: temporary, project: 'crm' }, new URLSearchParams('limit=500'));
  assert.strictEqual(result.total, 1000);
  assert(Date.now() - started < 2000, '1,000 task query exceeded 2 seconds');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('board data tests passed\n');
