'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalDocumentPath, planMigration, migrateProject } = require('../src/document-migration');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-'));
fs.mkdirSync(path.join(temp, 'docs'), { recursive: true });
fs.mkdirSync(path.join(temp, 'templates'), { recursive: true });
fs.writeFileSync(path.join(temp, 'README.md'), '# 일반 안내\n', 'utf8');
fs.writeFileSync(path.join(temp, 'templates', 'document.md'), '# 템플릿\n', 'utf8');
fs.writeFileSync(path.join(temp, 'docs', 'PRD-001-demo.md'), '---\nid: PRD-001\nrelated:\n  - "[[REQ-001|REQ-001]]"\n---\nSee [[docs/REQ-001-old|REQ-001]].\n', 'utf8');
fs.writeFileSync(path.join(temp, 'docs', 'REQ-001-old.md'), '---\nid: REQ-001\n---\n', 'utf8');
const dry = migrateProject(temp, { apply: false });
assert.strictEqual(dry.dryRun, true);
assert.strictEqual(dry.moves.length, 2);
assert(fs.existsSync(path.join(temp, 'docs', 'PRD-001-demo.md')));
migrateProject(temp, { apply: true });
assert(fs.existsSync(path.join(temp, 'docs', 'prd', 'PRD-001-demo.md')));
assert(fs.existsSync(path.join(temp, 'docs', 'requirements', 'REQ-001-old.md')));
const moved = fs.readFileSync(path.join(temp, 'docs', 'prd', 'PRD-001-demo.md'), 'utf8');
assert(moved.includes('[[REQ-001-old|REQ-001]]'));
assert(!moved.includes('docs/REQ-001-old'));
assert.strictEqual(planMigration(temp).clean, true);
assert.strictEqual(path.basename(canonicalDocumentPath('GLS', temp)), 'glossary');
assert.strictEqual(canonicalDocumentPath('NTE', temp), path.join(temp, 'inbox'));
fs.rmSync(temp, { recursive: true, force: true });

const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-duplicate-'));
fs.mkdirSync(path.join(duplicateRoot, 'docs', 'legacy'), { recursive: true });
fs.writeFileSync(path.join(duplicateRoot, 'docs', 'PRD-001-one.md'), '---\nid: PRD-001\n---\n', 'utf8');
fs.writeFileSync(path.join(duplicateRoot, 'docs', 'legacy', 'PRD-001-two.md'), '---\nid: PRD-001\n---\n', 'utf8');
assert(planMigration(duplicateRoot).conflicts.some((item) => item.id === 'PRD-001'));
assert.throws(() => migrateProject(duplicateRoot, { apply: true }), /PRD-001/u);
fs.rmSync(duplicateRoot, { recursive: true, force: true });

const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-rollback-'));
fs.mkdirSync(path.join(rollbackRoot, 'docs'), { recursive: true });
const rollbackSources = [path.join(rollbackRoot, 'docs', 'PRD-001-one.md'), path.join(rollbackRoot, 'docs', 'REQ-001-two.md')];
for (const file of rollbackSources) fs.writeFileSync(file, `---\nid: ${path.basename(file).slice(0, 7)}\n---\n`, 'utf8');
const originalRename = fs.renameSync;
let moveCount = 0;
fs.renameSync = function failSecondMove(source, target) {
  if (!source.endsWith('.tmp') && ++moveCount === 2) throw new Error('simulated move failure');
  return originalRename(source, target);
};
try {
  assert.throws(() => migrateProject(rollbackRoot, { apply: true }), /simulated move failure/u);
} finally {
  fs.renameSync = originalRename;
}
assert(rollbackSources.every((file) => fs.existsSync(file)));
assert(!fs.existsSync(path.join(rollbackRoot, 'docs', 'prd', 'PRD-001-one.md')));
fs.rmSync(rollbackRoot, { recursive: true, force: true });

const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-validation-'));
fs.mkdirSync(path.join(validationRoot, 'docs'), { recursive: true });
const validationFile = path.join(validationRoot, 'docs', 'PRD-001-one.md');
const validationSource = '---\nid: PRD-001\n---\n원본 바이트 보존\n';
fs.writeFileSync(validationFile, validationSource, 'utf8');
let validationCalls = 0;
assert.throws(() => migrateProject(validationRoot, { apply: true, validate: () => ({ diagnostics: validationCalls++ ? [{ severity: 'error', code: 'NEW', file: 'docs/prd/PRD-001-one.md' }] : [] }) }), /strict validation/u);
assert(fs.existsSync(validationFile));
assert.strictEqual(fs.readFileSync(validationFile, 'utf8'), validationSource);
assert(!fs.existsSync(path.join(validationRoot, 'docs', 'prd')));
assert.strictEqual(fs.readdirSync(path.join(validationRoot, 'docs')).filter((name) => name.endsWith('.tmp')).length, 0);
fs.rmSync(validationRoot, { recursive: true, force: true });
// 이름을 바꾸는 이관은 그 이름을 쓰는 모든 자리를 함께 옮겨야 한다. 문서만 고치고
// 태스크의 문서 링크를 남기면, 이관이 끝난 뒤에 태스크가 없는 문서를 가리킨다 —
// 절반만 옮기는 것은 이관이 아니라 연결을 끊는 일이다.
{
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-links-'));
  fs.mkdirSync(path.join(linkRoot, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(linkRoot, 'tasks', 'desk-a'), { recursive: true });
  fs.writeFileSync(path.join(linkRoot, 'docs', 'API-002-old.md'), '---\nid: API-002\nkind: api\ntags:\n  - artifact/api\n---\n', 'utf8');
  const shard = path.join(linkRoot, 'tasks', 'desk-a', '000001.json');
  fs.writeFileSync(shard, `${JSON.stringify({ schemaVersion: 3, tasks: { 'TASK-AAAAAAAA': { title: '링크 보유', links: ['API-002'] } } }, null, 2)}\n`, 'utf8');

  migrateProject(linkRoot, { apply: true });

  assert(fs.existsSync(path.join(linkRoot, 'docs', 'interface', 'IFC-002-old.md')), '문서가 옮겨지지 않았습니다');
  const moved = fs.readFileSync(path.join(linkRoot, 'docs', 'interface', 'IFC-002-old.md'), 'utf8');
  assert(moved.includes('id: IFC-002') && moved.includes('kind: interface') && moved.includes('artifact/interface'), moved);
  const links = JSON.parse(fs.readFileSync(shard, 'utf8')).tasks['TASK-AAAAAAAA'].links;
  assert.deepStrictEqual(links, ['IFC-002'], '태스크의 문서 링크가 옛 이름으로 남았습니다');
  fs.rmSync(linkRoot, { recursive: true, force: true });
}

// ── state 칸이 나눠 쓰던 두 축을 가른다 ────────────────────────────────
//
// 이관이 지켜야 하는 것 하나가 여기 걸린다. **원장이 정본이다.** 파일이 accepted라
// 적었다는 사실은 승인의 증거가 아니고, 이관이 그것을 state의 승인 값으로 옮기면
// 원장에 없는 승인이 파일에서 태어난다. 이 저장소의 정본이 실제로 그 모양이었다 —
// 원장은 151건 중 1건만 승인으로 알았고 파일은 15건이 accepted를 적고 있었다.
{
  const { INITIAL_DOCUMENT_STATE, splitDocumentState } = require('../src/document-migration');
  const { DOCUMENT_STATE_KEYS, DOCUMENT_LIFECYCLE_KEYS } = require('../src/vocabulary');

  // 이관이 state에 쓰는 값은 아무것도 주장하지 않는 하나뿐이다. 승인·제출·반려를
  // 뜻하는 값이 이 자리에 오면 그 자리에서 걸려야 한다.
  assert.strictEqual(INITIAL_DOCUMENT_STATE, 'draft');
  for (const value of DOCUMENT_LIFECYCLE_KEYS) {
    const split = splitDocumentState(value);
    assert.strictEqual(split.lifecycle, value, `${value}는 수명 칸으로 그대로 옮겨야 합니다.`);
    assert.strictEqual(split.state, INITIAL_DOCUMENT_STATE, `${value}를 옮기면서 상태를 주장하면 안 됩니다.`);
  }
  // 진행 축의 값은 손대지 않는다. 다음 투영이 답할 자리이고, 여기서 정하면 이관이
  // 원장의 대답을 미리 적는 셈이 된다.
  for (const value of DOCUMENT_STATE_KEYS) {
    assert.deepStrictEqual(splitDocumentState(value), { axis: 'state', reason: null, state: value, lifecycle: null }, `${value}는 그대로 둡니다.`);
  }
  // 옮길 자리가 없는 값은 바닥으로 접지 않는다. 접으면 이관이 아무도 묻지 않은
  // 질문을 대신 답하고, 그 사실은 아무 신호도 내지 않는다.
  assert.deepStrictEqual(splitDocumentState('unread'), { axis: null, reason: 'unmapped', state: null, lifecycle: null });
}

{
  const splitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-state-'));
  const docs = path.join(splitRoot, 'docs');
  fs.mkdirSync(path.join(docs, 'adr'), { recursive: true });
  fs.mkdirSync(path.join(docs, 'requirements'), { recursive: true });
  fs.mkdirSync(path.join(splitRoot, 'inbox'), { recursive: true });
  const write = (file, front, body) => fs.writeFileSync(file, `---\n${front}\n---\n${body || ''}`, 'utf8');
  const adr = path.join(docs, 'adr', 'ADR-001-결정.md');
  const req = path.join(docs, 'requirements', 'REQ-001-요구.md');
  const glossary = path.join(docs, 'requirements', 'REQ-002-요구.md');
  const note = path.join(splitRoot, 'inbox', 'NTE-001-노트.md');
  const charter = path.join(splitRoot, 'project.md');
  write(adr, 'id: ADR-001\nowner: "x"\nstate: accepted\ntags:\n  - a', '# 결정\n\nstate: 본문에도 이 낱말이 있다\n');
  write(req, 'id: REQ-001\nowner: "x"\nstate: draft', '# 요구\n');
  write(glossary, 'id: REQ-002\nowner: "x"\nstate: active', '# 요구\n');
  write(note, 'id: NTE-001\nowner: "x"\nstate: unread', '# 노트\n');
  write(charter, 'id: project:demo\nowner: "x"\nstate: active', '# 헌장\n');
  const originals = new Map([adr, req, glossary, note, charter].map((file) => [file, fs.readFileSync(file, 'utf8')]));

  // ① 계획과 적용을 가른다. --apply 없이 부른 것은 무엇을 할지만 말하고 파일에
  //    닿지 않는다. 151개 파일을 바꾸는 일은 먼저 보여주고 나서 해야 한다.
  const planned = migrateProject(splitRoot, { apply: false });
  assert.strictEqual(planned.dryRun, true);
  assert.strictEqual(planned.applied, false);
  assert.strictEqual(planned.fields.length, 3, '수명 값을 가진 셋이 계획에 오릅니다.');
  assert.deepStrictEqual(planned.fields.map((item) => [item.id, item.from, item.state, item.lifecycle]).sort(), [
    ['ADR-001', 'accepted', 'draft', 'accepted'],
    ['REQ-002', 'active', 'draft', 'active'],
    ['project:demo', 'active', 'draft', 'active']
  ], '헌장도 state를 가진 문서이므로 계획에 들어야 합니다.');
  // 옮길 자리가 없는 값은 값으로 내보내되 clean을 흐리지 않는다. 사람이 정해야
  // 풀리는 것을 이 명령의 할 일로 세면 영영 지워지지 않는 잔소리가 된다.
  assert.deepStrictEqual(planned.unmappedStates.map((item) => [item.id, item.state, item.reason]), [['NTE-001', 'unread', 'unmapped']]);
  for (const [file, source] of originals) {
    assert.strictEqual(fs.readFileSync(file, 'utf8'), source, `계획만 낸 실행이 파일을 바꿨습니다: ${file}`);
  }

  // ② 적용하면 계획한 것만 바뀐다.
  migrateProject(splitRoot, { apply: true });
  const movedAdr = fs.readFileSync(adr, 'utf8');
  assert(movedAdr.includes('state: draft\nlifecycle: accepted\n'), movedAdr);
  // 본문은 손대지 않는다. 프론트매터만 고치지 않으면 이관이 사람이 쓴 글을 바꾼다.
  assert(movedAdr.includes('state: 본문에도 이 낱말이 있다'), '본문의 같은 낱말까지 고치면 안 됩니다.');
  assert.strictEqual(fs.readFileSync(req, 'utf8'), originals.get(req), '진행 축의 값은 한 바이트도 바뀌지 않습니다.');
  assert.strictEqual(fs.readFileSync(note, 'utf8'), originals.get(note), '옮길 자리가 없는 값은 건드리지 않습니다.');
  assert(fs.readFileSync(charter, 'utf8').includes('state: draft\nlifecycle: active\n'), '헌장도 함께 옮겨야 합니다.');

  // ③ 원장에 없는 승인을 파일에 쓰지 않는다. 옮긴 뒤 어느 파일에도 승인·제출·반려를
  //    주장하는 state가 없어야 한다 — 그 값은 원장만이 만들 수 있다.
  for (const file of originals.keys()) {
    const state = /^state:[ \t]*(.*)$/mu.exec(fs.readFileSync(file, 'utf8'));
    assert(!['approved', 'stale', 'rejected', 'proposed'].includes(state[1].trim()),
      `이관이 원장에 없는 사실을 파일에 적었습니다: ${file} state=${state[1]}`);
  }

  // ④ 두 번 돌려도 같다. lifecycle이 이미 있는 문서를 다시 훑어도 덮지 않는다.
  const again = migrateProject(splitRoot, { apply: false });
  assert.strictEqual(again.fields.length, 0);
  assert.strictEqual(again.clean, true, '옮길 것이 없으면 깨끗합니다. 미매핑 하나가 남아도 마찬가지입니다.');
  assert.strictEqual(again.unmappedStates.length, 1, '미매핑은 사람이 정할 때까지 계속 보고합니다.');

  // ⑤ 사람이 적은 lifecycle은 기계가 덮지 않는다. state가 아직 수명 값이면 두 칸이
  //    서로 다른 말을 할 수 있으므로 고르지 않고 갈렸다고 말한다.
  const conflicted = path.join(docs, 'adr', 'ADR-002-결정.md');
  write(conflicted, 'id: ADR-002\nowner: "x"\nstate: accepted\nlifecycle: deprecated', '# 결정\n');
  const conflictSource = fs.readFileSync(conflicted, 'utf8');
  const conflictPlan = migrateProject(splitRoot, { apply: true });
  assert.deepStrictEqual(conflictPlan.unmappedStates.filter((item) => item.id === 'ADR-002')
    .map((item) => [item.state, item.lifecycle, item.reason]), [['accepted', 'deprecated', 'lifecycle-conflict']]);
  assert.strictEqual(fs.readFileSync(conflicted, 'utf8'), conflictSource, '사람이 적은 수명을 기계가 덮으면 안 됩니다.');

  fs.rmSync(splitRoot, { recursive: true, force: true });
}

// ── 이관이 낡게 만들 승인을 계획이 먼저 말한다 ────────────────────────
//
// lifecycle은 사람이 쓴 내용이라 리비전에서 빠지지 않는다. 그래서 그 줄이 붙으면
// 문서 리비전이 움직이고, 그 문서에 걸린 승인은 낡는다. 이것은 결함이 아니라 축이다 —
// 수명이 바뀌면 다시 봐야 하고, 리비전에서 빼면 아무도 다시 안 본다.
//
// 축이라서 고치지 않는 대신 미리 말해야 한다. 이 저장소는 승인이 3건뿐이라 티가 안
// 나지만 45건이 걸린 저장소에서는 사람이 그것을 다시 눌러야 하고, 지금 그럴 수
// 있는지는 몇 건인지가 아니라 어느 문서인지를 봐야 판단할 수 있다.
{
  const approvalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-approval-'));
  fs.mkdirSync(path.join(approvalRoot, 'docs', 'adr'), { recursive: true });
  const live = path.join(approvalRoot, 'docs', 'adr', 'ADR-001-살아있는-승인.md');
  const already = path.join(approvalRoot, 'docs', 'adr', 'ADR-002-이미-낡은-승인.md');
  const none = path.join(approvalRoot, 'docs', 'adr', 'ADR-003-승인-없음.md');
  const untouched = path.join(approvalRoot, 'docs', 'adr', 'ADR-004-손대지-않음.md');
  fs.writeFileSync(live, '---\nid: ADR-001\nowner: "x"\nstate: accepted\n---\n# 하나\n', 'utf8');
  fs.writeFileSync(already, '---\nid: ADR-002\nowner: "x"\nstate: accepted\n---\n# 둘\n', 'utf8');
  fs.writeFileSync(none, '---\nid: ADR-003\nowner: "x"\nstate: accepted\n---\n# 셋\n', 'utf8');
  // 진행 축의 값이라 이관이 손대지 않는다. 승인이 살아 있어도 위험 목록에 오르면 안 된다 —
  // 겁만 주는 목록은 곧 읽히지 않는다.
  fs.writeFileSync(untouched, '---\nid: ADR-004\nowner: "x"\nstate: draft\n---\n# 넷\n', 'utf8');

  const ledger = () => ({
    documents: [
      { id: 'ADR-001', status: 'approved', approvedBy: 'MEMBER-001' },
      { id: 'ADR-002', status: 'stale', approvedBy: 'MEMBER-001' },
      { id: 'ADR-003', status: 'unapproved', approvedBy: null },
      { id: 'ADR-004', status: 'approved', approvedBy: 'MEMBER-001' }
    ]
  });
  const planned = planMigration(approvalRoot, { approvals: ledger });
  assert.deepStrictEqual(planned.approvalsAtRisk.map((item) => [item.id, item.approvedBy]), [['ADR-001', 'MEMBER-001']],
    '승인이 살아 있고 이관이 고치는 문서만 위험 목록에 오릅니다.');
  assert(/승인 1건이 낡습니다/u.test(planned.approvalNote), planned.approvalNote);
  assert(/나머지 2건은 잃을 승인이 없습니다/u.test(planned.approvalNote), planned.approvalNote);
  // 몇 건인지가 아니라 어느 문서인지가 판단의 근거다.
  assert.strictEqual(planned.approvalsAtRisk[0].file, 'docs/adr/ADR-001-살아있는-승인.md');

  // 묻지 않은 것과 0건인 것은 다르다. 주입 없이 부르면 "낡는 승인이 없다"고 말하지
  // 않는다 — 접으면 승인 45건이 걸린 저장소에서 사람이 안심하고 --apply를 친다.
  const unmeasured = planMigration(approvalRoot);
  assert.deepStrictEqual(unmeasured.approvalsAtRisk, []);
  assert(/재지 못했습니다/u.test(unmeasured.approvalNote), unmeasured.approvalNote);
  // 원장을 읽다 넘어져도 계획 자체는 나온다. 다만 잰 척하지 않는다.
  const broken = planMigration(approvalRoot, { approvals: () => { throw new Error('원장 손상'); } });
  assert(/재지 못했습니다: 원장 손상/u.test(broken.approvalNote), broken.approvalNote);
  assert.strictEqual(broken.fields.length, 3, '원장을 못 읽어도 칸 이관 계획은 그대로입니다.');

  fs.rmSync(approvalRoot, { recursive: true, force: true });
}

// 표 칸 안의 위키링크는 구분자를 `\|`로 escape한다. 그 역슬래시를 대상 이름의
// 일부로 읽고 다시 쓰면서 잃으면, escape가 풀린 `|`가 칸 구분자가 되어 표가 깨진다.
// 정본 GLS-002의 용어 표가 실제로 그 모양이라 이관을 돌리는 것만으로 무너졌다.
{
  const tableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-migration-table-'));
  fs.mkdirSync(path.join(tableRoot, 'docs'), { recursive: true });
  const table = path.join(tableRoot, 'docs', 'GLS-001-용어.md');
  fs.writeFileSync(path.join(tableRoot, 'docs', 'ADR-001-결정.md'), '---\nid: ADR-001\n---\n', 'utf8');
  fs.writeFileSync(table, '---\nid: GLS-001\n---\n\n| 낱말 | 뜻 |\n|---|---|\n| soft lease | [[docs/ADR-001-결정\\|ADR-001]]로 폐기 |\n', 'utf8');
  migrateProject(tableRoot, { apply: true });
  const rewritten = fs.readFileSync(path.join(tableRoot, 'docs', 'glossary', 'GLS-001-용어.md'), 'utf8');
  assert(rewritten.includes('[[ADR-001-결정\\|ADR-001]]'), `표의 escape가 사라졌습니다: ${rewritten}`);
  fs.rmSync(tableRoot, { recursive: true, force: true });
}

process.stdout.write('document migration tests passed\n');
