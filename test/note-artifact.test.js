'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../src/frontmatter');

const repository = path.resolve(__dirname, '..');
const templateRoot = path.join(repository, 'docs', 'templates');

// every shipped template must close its frontmatter, or rdl doc create emits an unparseable document
for (const name of fs.readdirSync(templateRoot).filter((entry) => entry.endsWith('.template.md'))) {
  const source = fs.readFileSync(path.join(templateRoot, name), 'utf8');
  assert.ok(parseFrontmatter(source), `${name}의 frontmatter가 닫히지 않았습니다.`);
}

const note = fs.readFileSync(path.join(templateRoot, 'NTE.template.md'), 'utf8');
const parsed = parseFrontmatter(note);

// rdl doc create fills owner by replacing an existing quoted owner line, so the template must carry one
assert.match(note, /^owner:\s*"\[\[project#\^MEMBER-\d{3}\|[^\]]+\]\]"$/mu, 'NTE 템플릿에 치환 가능한 owner 줄이 필요합니다.');
for (const field of ['id', 'type', 'kind', 'title', 'description', 'owner', 'state', 'tags', 'aliases', 'related']) {
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.data, field), `NTE 템플릿에 필수 메타 필드가 없습니다: ${field}`);
}
assert.strictEqual(parsed.data.aliases[0], parsed.data.id);
assert.ok(parsed.body.trim().length > 0, 'NTE 템플릿에 본문이 필요합니다.');

// a note stays outside the artifact taxonomy: rundol/ only, never artifact/domain/feature
const tags = parsed.data.tags;
assert.ok(tags.some((tag) => tag.startsWith('rundol/')), 'NTE 템플릿에 rundol/ 태그가 필요합니다.');
for (const namespace of ['artifact/', 'domain/', 'feature/']) {
  assert.ok(!tags.some((tag) => tag.startsWith(namespace)), `NTE는 비정규 노트이므로 ${namespace} 태그를 갖지 않습니다.`);
}

// the reduced namespace requirement is what lets that template pass RDL-DOC-008.
// 판정과 그 상수는 check-rules로 옮겼다 — 값만 보고 답하는 규칙이므로 읽기 계층에
// 남을 이유가 없었다. 소스를 문자열로 확인하는 대신 판정을 직접 불러 확인한다.
const { NON_CANONICAL_CODES, NOTE_TAG_NAMESPACES, REQUIRED_TAG_NAMESPACES, checkDocumentMetadata } = require('../src/check-rules');
assert.ok(NON_CANONICAL_CODES.has('NTE'), 'NTE는 비정규 유형이어야 합니다.');
assert.deepStrictEqual(NOTE_TAG_NAMESPACES, ['rundol/']);
assert.ok(REQUIRED_TAG_NAMESPACES.length > NOTE_TAG_NAMESPACES.length, '비정규 유형의 태그 요구가 더 적어야 합니다.');

// 규칙이 실제로 그렇게 판정하는지 본다. 상수만 맞고 판정이 다르면 아무 의미가 없다.
function noteDoc(id, docTags) {
  return {
    relativeFile: `inbox/${id}-메모.md`,
    frontmatter: { locations: {}, data: { id, type: 'document', kind: 'note', title: '메모', description: '설명', owner: 'x', state: 'draft', tags: docTags, aliases: [id], related: [] } }
  };
}
const noDelegates = { boundary: () => [], implementation: () => [] };
const noteIssues = [];
checkDocumentMetadata(noteIssues, noteDoc('NTE-001', ['rundol/artifact']), 'NTE-001-메모.md', noDelegates);
assert.ok(!noteIssues.some((item) => item.code === 'RDL-DOC-008'), 'NTE는 rundol/ 태그 하나로 충분해야 합니다.');
const requirementIssues = [];
checkDocumentMetadata(requirementIssues, noteDoc('REQ-999', ['rundol/artifact']), 'REQ-999-메모.md', noDelegates);
assert.ok(requirementIssues.some((item) => item.code === 'RDL-DOC-008'), '정규 유형은 태그 namespace를 더 요구해야 합니다.');

// the published standard states that notes are non-canonical
const standard = fs.readFileSync(path.join(repository, 'docs', 'DOCUMENT-STANDARD.md'), 'utf8');
assert.ok(standard.includes('NTE'), 'DOCUMENT-STANDARD.md가 NTE를 설명해야 합니다.');

// 생성 디렉터리 제외는 프로젝트 루트에만 적용된다
const os = require('os');
const { COMPOSITE_DIRECTORY } = require('../src/document-composite');
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-views-'));
fs.mkdirSync(path.join(probe, COMPOSITE_DIRECTORY), { recursive: true });
fs.mkdirSync(path.join(probe, 'docs', COMPOSITE_DIRECTORY), { recursive: true });
fs.writeFileSync(path.join(probe, COMPOSITE_DIRECTORY, 'generated.md'), '# 생성물\n');
fs.writeFileSync(path.join(probe, 'docs', COMPOSITE_DIRECTORY, 'REQ-900-정상-문서.md'), '# 정상\n');
const { listMarkdownFiles } = require('../src/check');
const found = listMarkdownFiles(probe).map((file) => path.relative(probe, file).split(path.sep).join('/'));
assert.ok(!found.includes(`${COMPOSITE_DIRECTORY}/generated.md`), '루트의 생성 디렉터리는 제외한다');
assert.ok(found.includes(`docs/${COMPOSITE_DIRECTORY}/REQ-900-정상-문서.md`), 'docs 아래 같은 이름의 폴더는 제외하지 않는다');
fs.rmSync(probe, { recursive: true, force: true });

// 반려는 완료 게이트를 우회하는 통로가 되면 안 되므로 사유를 같은 강도로 강제한다.
const { assertCancellationConsistency, TERMINAL_TASK_STATES } = require('../src/tasks');
assert.throws(() => assertCancellationConsistency({ status: 'todo', cancellation: null }, { status: 'cancelled' }), /반려 사유/u);
assert.throws(() => assertCancellationConsistency({ status: 'todo', cancellation: null }, { cancellation: { reason: '중단', decidedBy: 'MEMBER-001', at: '2026-08-15T00:00:00.000Z' } }), /반려 상태가 아닌/u);
for (const missing of ['reason', 'decidedBy', 'at']) {
  const cancellation = { reason: '중단', decidedBy: 'MEMBER-001', at: '2026-08-15T00:00:00.000Z' };
  delete cancellation[missing];
  assert.throws(() => assertCancellationConsistency({ status: 'todo' }, { status: 'cancelled', cancellation }), new RegExp('필요합니다', 'u'), `${missing} 없이 반려되면 안 됩니다.`);
}
assert.doesNotThrow(() => assertCancellationConsistency({ status: 'todo' }, { status: 'cancelled', cancellation: { reason: '중단', decidedBy: 'MEMBER-001', at: '2026-08-15T00:00:00.000Z' } }));
assert.doesNotThrow(() => assertCancellationConsistency({ status: 'cancelled', cancellation: { reason: '중단', decidedBy: 'MEMBER-001', at: '2026-08-15T00:00:00.000Z' } }, { status: 'todo', cancellation: null }));
assert.deepStrictEqual(Array.from(TERMINAL_TASK_STATES), ['done', 'cancelled']);

// 반려는 허용 상태이면서 완료 게이트(수용조건·검증 문서 연결)의 대상은 아니다.
// 태스크 판정은 check-rules로 옮겼다 — 값만 보고 답하는 규칙이므로 읽기 계층에
// 남을 이유가 없었다. 소스를 문자열로 뒤지는 대신 판정을 직접 불러 확인한다.
const { ALLOWED_TASK_STATES, checkTaskEntries } = require('../src/check-rules');
assert.deepStrictEqual(Array.from(ALLOWED_TASK_STATES), ['todo', 'doing', 'waiting', 'review', 'done', 'cancelled']);

function judgeTask(task) {
  const issues = [];
  checkTaskEntries(issues, { 'TASK-ABCDEFGH': task }, {
    taskIds: ['TASK-ABCDEFGH'], taskFile: 'tasks.json', registry: new Map(),
    memberIds: new Set(['MEMBER-001']), stakeholderIds: new Set(),
    kinds: ['normal', 'test'], results: ['pass', 'fail', 'blocked', 'skipped'],
    testedDocuments: () => [], readiness: () => []
  });
  return issues.map((item) => item.code);
}

const cancelledBase = {
  title: 't', summary: 's', owner: 'MEMBER-001', reviewers: [], stakeholders: [], priority: 'mid',
  links: [], deps: [], acceptanceCriteria: { 'AC-001': { text: 'x', done: false } }, blocker: null,
  createdAt: '', updatedAt: '', statusChangedAt: '', externalRefs: []
};

// 사유 없는 반려는 진단한다.
assert.ok(judgeTask(Object.assign({}, cancelledBase, { status: 'cancelled' })).includes('RDL-TASK-023'));
// 반려가 아닌 태스크의 사유도 진단한다.
assert.ok(judgeTask(Object.assign({}, cancelledBase, { status: 'todo', cancellation: { reason: 'x', decidedBy: 'MEMBER-001', at: 'z' } })).includes('RDL-TASK-024'));
// 존재하지 않는 반려 결정자를 진단한다.
assert.ok(judgeTask(Object.assign({}, cancelledBase, { status: 'cancelled', cancellation: { reason: 'x', decidedBy: 'MEMBER-999', at: 'z' } })).includes('RDL-TASK-025'));

// 완료 게이트가 반려에 적용되면 안 된다. 미완료 수용조건과 검증 문서 부재를 가진
// 반려 태스크가 완료 게이트 진단을 받지 않는 것이 그 확인이다.
const cancelledCodes = judgeTask(Object.assign({}, cancelledBase, { status: 'cancelled', cancellation: { reason: 'x', decidedBy: 'MEMBER-001', at: 'z' } }));
for (const gate of ['RDL-TASK-018', 'RDL-TASK-019']) {
  assert.ok(!cancelledCodes.includes(gate), `${gate}가 반려에 적용되면 안 됩니다.`);
}
// 같은 내용이 완료 상태이면 두 게이트가 모두 걸린다.
const doneCodes = judgeTask(Object.assign({}, cancelledBase, { status: 'done' }));
for (const gate of ['RDL-TASK-018', 'RDL-TASK-019']) {
  assert.ok(doneCodes.includes(gate), `${gate}는 완료에 적용되어야 합니다.`);
}

// blocker 불변식은 공통 태스크 계층이 강제한다
const { assertBlockerConsistency } = require('../src/tasks');
assert.throws(() => assertBlockerConsistency({ status: 'todo', blocker: null }, { status: 'waiting' }), /대기 대상/u);
assert.throws(() => assertBlockerConsistency({ status: 'todo', blocker: null }, { blocker: { waitingFor: 'MEMBER-001' } }), /대기 상태가 아닌/u);
// 갖춰진 blocker만 받는다. 예전에는 저장이 blocker가 있기만 하면 받고 검사가 세
// 부분을 요구해서, 같은 규칙이 두 계층에서 다른 강도로 있었다 — 저장을 지난 값이
// 검사에서 막히는 자리였다. 판정이 하나가 되면서 그 틈이 닫혔다.
const wholeBlocker = { waitingFor: 'MEMBER-001', condition: '검토 회신', since: '2026-08-15T00:00:00.000Z' };
assert.throws(() => assertBlockerConsistency({ status: 'todo', blocker: null }, { status: 'waiting', blocker: { waitingFor: 'MEMBER-001' } }), /대기 대상/u);
assert.doesNotThrow(() => assertBlockerConsistency({ status: 'todo', blocker: null }, { status: 'waiting', blocker: wholeBlocker }));
assert.doesNotThrow(() => assertBlockerConsistency({ status: 'waiting', blocker: wholeBlocker }, { status: 'doing', blocker: null }));

// Client ID는 샤드 디렉터리와 이벤트 파일 이름이 되어 저장소에 커밋된다.
// 호스트명을 그대로 넣으면 공개 저장소에 기기 이름이 남는다.
const { generatedClientId } = require('../src/tasks');
const savedHost = process.env.COMPUTERNAME;
try {
  process.env.COMPUTERNAME = 'SECRET-WORKSTATION-01';
  const first = generatedClientId();
  const second = generatedClientId();
  assert.ok(!first.toLowerCase().includes('secret'), `생성된 Client ID에 호스트명이 남았습니다: ${first}`);
  assert.ok(!first.toLowerCase().includes('workstation'), `생성된 Client ID에 호스트명이 남았습니다: ${first}`);
  assert.match(first, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Client ID 형식을 지켜야 합니다.');
  assert.strictEqual(first.split('-')[0], second.split('-')[0], '같은 기기는 같은 접두사를 얻어야 합니다.');
  assert.notStrictEqual(first, second, '무작위 부분은 매번 달라야 합니다.');
  process.env.COMPUTERNAME = 'ANOTHER-MACHINE';
  assert.notStrictEqual(generatedClientId().split('-')[0], first.split('-')[0], '다른 기기는 다른 접두사를 얻어야 합니다.');
} finally {
  if (savedHost === undefined) delete process.env.COMPUTERNAME; else process.env.COMPUTERNAME = savedHost;
}

process.stdout.write('note artifact tests passed\n');
