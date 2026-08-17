'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { referencedIds, changesSinceApproval, analyzeDocuments } = require('../src/document-analysis');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-doc-analysis-'));
const home = path.join(temporary, 'runtime');
const previousHome = process.env.RUNDOL_HOME;
process.env.RUNDOL_HOME = home;

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

try {
  // 참조는 표시 링크에서 읽는다. 자기 자신과 모르는 대상은 참조가 아니다.
  const known = new Set(['REQ-001', 'ADR-002', 'TST-003']);
  const document = {
    id: 'REQ-001',
    body: '본문에서 [[ADR-002-어떤-결정|ADR-002]]을 참조하고 [[REQ-001-자기자신]]도 적었다. [[SCR-999-모르는문서]]도 있다.',
    related: ['[[TST-003-검증|TST-003]]']
  };
  assert.deepStrictEqual(referencedIds(document, known), ['ADR-002', 'TST-003'], '자기 참조와 미등록 대상은 제외됩니다.');
  assert.deepStrictEqual(referencedIds({ id: 'REQ-001', body: '', related: [] }, known), []);

  // 안정성 지표: 승인된 커밋 이후 몇 번 바뀌었나.
  const commits = [{ commit: 'c3' }, { commit: 'c2' }, { commit: 'c1' }];
  assert.strictEqual(changesSinceApproval(commits, 'c1'), 2);
  assert.strictEqual(changesSinceApproval(commits, 'c3'), 0);
  assert.strictEqual(changesSinceApproval(commits, null), null);
  assert.strictEqual(changesSinceApproval(commits, '없는커밋'), null);

  // 실제 Workspace.
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# analysis\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', 'A', '--type', 'agent', '--owner', 'MEMBER-001']);

  const referenced = rdl(['doc', 'create', 'ADR', '참조되는 결정', '--owner', 'MEMBER-001', '--scope', '다른 문서가 참조하는 결정', '--exclude', '그 밖', '--project', 'crm']);
  const referring = rdl(['doc', 'create', 'ADR', '참조하는 결정', '--owner', 'MEMBER-001', '--scope', '앞 결정을 참조하는 결정', '--exclude', '그 밖', '--related', referenced.id, '--project', 'crm']);

  const analyzed = analyzeDocuments(temporary, { project: 'crm' });
  const referencedEntry = analyzed.documents.find((entry) => entry.id === referenced.id);
  const referringEntry = analyzed.documents.find((entry) => entry.id === referring.id);
  assert(referencedEntry.referencedBy.includes(referring.id), '역참조가 계산되어야 합니다.');
  assert(referringEntry.references.includes(referenced.id));
  // 참조되는 문서는 고아가 아니고, 참조만 하는 문서는 아무도 안 가리키므로 고아다.
  assert.strictEqual(referencedEntry.orphan, false);
  assert.strictEqual(referringEntry.orphan, true);

  // 승인도 태스크도 없이 존재하는 정본은 왜 그런지 답할 기록이 없다.
  assert.strictEqual(referencedEntry.unexplained, true);
  assert.strictEqual(referencedEntry.trust, 'unapproved');
  assert(analyzed.summary.unexplained >= 2);

  // 승인하면 설명된 상태가 된다.
  rdl(['doc', 'approve', referenced.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'agent-a', '--project', 'crm']);
  const afterApproval = analyzeDocuments(temporary, { project: 'crm' });
  const approvedEntry = afterApproval.documents.find((entry) => entry.id === referenced.id);
  assert.strictEqual(approvedEntry.trust, 'approved');
  assert.strictEqual(approvedEntry.unexplained, false, '승인된 문서는 왜 그런지 답할 기록이 있습니다.');
  assert.strictEqual(afterApproval.summary.approved, 1);

  // 태스크가 연결되어도 설명된 상태가 된다 — 승인만이 유일한 근거는 아니다.
  const task = rdl(['task', 'add', '참조 문서 작업', '--project', 'crm', '--acceptance', '완료조건', '--link', referring.id]);
  assert(task.taskId);
  rdl(['index', 'rebuild']);
  const withTask = analyzeDocuments(temporary, { project: 'crm' }).documents.find((entry) => entry.id === referring.id);
  assert.deepStrictEqual(withTask.tasks, [task.taskId]);
  assert.strictEqual(withTask.unexplained, false, '연결된 태스크가 있으면 왜 바뀌었는지 답할 기록이 있습니다.');
  assert.strictEqual(withTask.orphan, false, '태스크가 연결되면 고아가 아닙니다.');

  // 필터.
  assert(analyzeDocuments(temporary, { project: 'crm', orphans: true }).documents.every((entry) => entry.orphan));
  assert(analyzeDocuments(temporary, { project: 'crm', unexplained: true }).documents.every((entry) => entry.unexplained));

  process.stdout.write('document analysis tests passed\n');
} finally {
  if (previousHome === undefined) delete process.env.RUNDOL_HOME;
  else process.env.RUNDOL_HOME = previousHome;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
