'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCollaboration, updateCollaboration, addMember } = require('../src/collaboration');

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

  // COL-03 — 멤버 등록. Client owner와 lease가 이 블록을 참조하므로 charter 계약을 지켜야 한다.
  const charter = path.join(temporary, 'projects', 'tms', 'project.md');
  const roleId = readCollaboration(temporary, 'tms').roles[0].id;
  const baseline = readCollaboration(temporary, 'tms').members;
  const original = fs.readFileSync(charter, 'utf8');

  // COL-03-S01 ID 없이 추가하면 다음 번호로 채번한다
  const highest = Math.max(...baseline.map((item) => Number.parseInt(item.id.slice('MEMBER-'.length), 10)));
  const added = addMember(temporary, {
    name: '신규 팀원', organization: '런타임', account: 'new@runtime.co.kr',
    responsibility: '검증 지원', roles: [roleId]
  }, 'tms');
  assert.strictEqual(added.member, `MEMBER-${String(highest + 1).padStart(3, '0')}`);

  // charter 필수 필드 다섯 개를 모두 갖춰야 rdl check를 통과한다
  const created = readCollaboration(temporary, 'tms').members.find((item) => item.id === added.member);
  assert.strictEqual(created.name, '신규 팀원');
  for (const field of ['역할', '소속', '업무 계정', '책임 영역', '상태']) {
    assert.ok(created.fields[field], `필수 필드가 비었습니다: ${field}`);
  }
  assert.strictEqual(created.fields['상태'], 'active');
  assert.match(created.fields['역할'], new RegExp(`\\^${roleId}\\|`));

  // 새 블록은 프로젝트 팀원 절 안에 들어가야 한다
  const sectionStart = fs.readFileSync(charter, 'utf8').indexOf('## 프로젝트 팀원');
  const blockAt = fs.readFileSync(charter, 'utf8').indexOf(`^${added.member}`);
  assert.ok(sectionStart >= 0 && blockAt > sectionStart, '새 멤버는 프로젝트 팀원 절 안에 있어야 합니다.');

  // COL-03-S03·S04·S05 거절 경로는 파일을 바꾸지 않는다
  const afterAdd = fs.readFileSync(charter, 'utf8');
  const rejections = [
    [{ member: added.member, name: '중복', organization: 'x', account: 'x@x', responsibility: 'x', roles: [roleId] }, /이미 존재하는 ID/u],
    [{ name: '역할없음', organization: 'x', account: 'x@x', responsibility: 'x', roles: ['ROLE-099'] }, /등록되지 않은 역할/u],
    [{ name: '  ', organization: 'x', account: 'x@x', responsibility: 'x', roles: [roleId] }, /이름/u],
    [{ name: '역할미지정', organization: 'x', account: 'x@x', responsibility: 'x', roles: [] }, /역할을 하나 이상/u]
  ];
  for (const [input, pattern] of rejections) {
    assert.throws(() => addMember(temporary, input, 'tms'), pattern);
    assert.strictEqual(fs.readFileSync(charter, 'utf8'), afterAdd, '거절 경로는 charter를 바꾸지 않아야 합니다.');
  }

  // COL-03-S07 ID를 직접 지정할 수 있다
  const explicit = addMember(temporary, {
    member: 'MEMBER-090', name: '지정 팀원', organization: '런타임',
    account: 'fixed@runtime.co.kr', responsibility: '지정 확인', roles: [roleId]
  }, 'tms');
  assert.strictEqual(explicit.member, 'MEMBER-090');
  assert.notStrictEqual(fs.readFileSync(charter, 'utf8'), original);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('collaboration tests passed\n');
