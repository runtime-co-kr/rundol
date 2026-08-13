'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCollaboration, updateCollaboration } = require('../src/collaboration');

const root = path.resolve(__dirname, '..');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-collaboration-'));
try {
  copyDirectory(path.join(root, 'test', 'fixtures', 'workspace'), temporary);
  const before = readCollaboration(temporary);
  assert(before.members.length >= 1);
  assert(before.roles.length >= 1);
  assert(before.stakeholders.length >= 1);

  const member = before.members[0];
  const updated = updateCollaboration(temporary, member.id, {
    name: '수정된 팀원',
    fields: { '소속': 'Rundol 테스트팀', '상태': 'active' }
  });
  const after = updated.members.find((item) => item.id === member.id);
  assert.strictEqual(after.name, '수정된 팀원');
  assert.strictEqual(after.fields['소속'], 'Rundol 테스트팀');
  const secondProject = path.join(temporary, 'projects', 'ops');
  copyDirectory(path.join(temporary, 'projects', 'tms'), secondProject);
  const secondCharter = path.join(secondProject, 'project.md');
  fs.writeFileSync(secondCharter, fs.readFileSync(secondCharter, 'utf8').replace('id: project:tms', 'id: project:ops').replace('  - project:tms', '  - project:ops'));
  fs.writeFileSync(path.join(temporary, '.rundol', 'projects', 'ops.yaml'), 'key: ops\nname: 운영\nmount: projects/ops\nref: refs/heads/rundol/ops\n', 'utf8');
  assert.throws(() => readCollaboration(temporary), /--project/);
  assert.strictEqual(readCollaboration(temporary, 'ops').project, 'ops');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('collaboration tests passed\n');
