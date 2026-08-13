'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { entityRevision, listDocuments, syncStatus } = require('../src/board-data');
const { queryTasks } = require('../src/board');
const { workspaceLayout, selectProject } = require('../src/workspace');

const root = path.join(__dirname, 'fixtures', 'workspace');
const project = selectProject(workspaceLayout(root), 'tms', true);

assert.strictEqual(entityRevision({ a: 1 }), entityRevision({ a: 1 }));
assert.notStrictEqual(entityRevision({ a: 1 }), entityRevision({ a: 2 }));
assert(listDocuments(project).some((document) => document.id === 'project:tms'));
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
