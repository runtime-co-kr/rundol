'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  COMPOSITE_VERSION, COMPOSITE_VIEWS, COMPOSITE_DIRECTORY, composeModel, composeScreen, composeView, composeViews,
  renderCompositeMarkdown, documentTitle, compositeViewState, writeCompositeViews, prepareCompositeDocuments,
  compositeIgnored, ensureCompositeIgnored, compositeBody, compositeDrift, compositeIssues,
  mermaidText, renderScreenDiagram
} = require('../src/document-composite');

const fence = '```';

function modelDoc(id, title, relationSection) {
  return { id, type: 'MOD', title, source: `# ${title}\n\n## 엔티티\n\n표\n\n## 관계\n\n${fence}mermaid\n${relationSection}\n${fence}\n\n## 불변식\n\n- 규칙\n` };
}

function screenDoc(id, title, transitionSection) {
  return { id, type: 'SCR', title, source: `# ${title}\n\n## 사용자 흐름\n\n1. 행동\n\n## 전이\n\n${fence}mermaid\n${transitionSection}\n${fence}\n\n## 바인딩\n\n표\n` };
}

const workspaceModel = modelDoc('MOD-002', 'Workspace 모델', `erDiagram
    WORKSPACE ||--o{ CLIENT : "등록"

    WORKSPACE {
        string key PK
        string root
    }`);

const leaseModel = modelDoc('MOD-003', '리스 모델', `erDiagram
    CLIENT ||--o{ LEASE : "보유"
    WORKSPACE ||--o{ CLIENT : "등록"

    LEASE {
        string id PK
        string client FK
    }`);

// entities owned elsewhere stay bare, and a relationship declared twice merges into one edge
const model = composeModel([leaseModel, workspaceModel]);
assert.deepStrictEqual(model.entities.map((entity) => entity.name), ['CLIENT', 'LEASE', 'WORKSPACE']);
assert.deepStrictEqual(model.entities.find((entity) => entity.name === 'CLIENT').attributes, []);
assert.strictEqual(model.entities.find((entity) => entity.name === 'WORKSPACE').owner, 'MOD-002');
assert.strictEqual(model.relationships.length, 2);
assert.deepStrictEqual(model.issues, []);

// RDL-COMPOSE-001: two documents claiming attributes on the same entity
const rival = modelDoc('MOD-004', '경쟁 모델', 'erDiagram\n    WORKSPACE {\n        string key PK\n    }');
const conflict = composeModel([workspaceModel, rival]);
assert.deepStrictEqual(conflict.issues.map((issue) => issue.code), ['RDL-COMPOSE-001']);
assert.strictEqual(conflict.issues[0].target, 'WORKSPACE');
assert.strictEqual(conflict.entities.find((entity) => entity.name === 'WORKSPACE').owner, 'MOD-002');

const login = screenDoc('SCR-001', '로그인', 'flowchart LR\n    SCR-001 -->|자격 유효| SCR-002\n    SCR-001 -->|가입| SCR-003');
const dashboard = screenDoc('SCR-002', '대시보드', 'flowchart LR\n    SCR-002 -->|로그아웃| SCR-001');
const signup = screenDoc('SCR-003', '가입', 'flowchart LR\n    SCR-003 -->|완료| SCR-002');

// node labels come from each document's own title, not from the label a neighbour drew
const screen = composeScreen([dashboard, login, signup]);
assert.deepStrictEqual(screen.screens.map((node) => node.title), ['로그인', '대시보드', '가입']);
assert.strictEqual(screen.transitions.length, 4);
assert.deepStrictEqual(screen.issues, []);
assert.ok(screen.screens.every((node) => !node.isolated));

// a screen no transition reaches is reported as isolated rather than dropped
const orphan = composeScreen([login, dashboard, signup, screenDoc('SCR-009', '고아', 'flowchart LR\n    SCR-009 --> SCR-009')]);
assert.strictEqual(orphan.screens.find((node) => node.id === 'SCR-009').isolated, true);

// RDL-COMPOSE-002: a transition pointing at a screen that does not exist
const dangling = composeScreen([login, dashboard]);
assert.deepStrictEqual(dangling.issues.map((issue) => issue.code), ['RDL-COMPOSE-002']);
assert.strictEqual(dangling.issues[0].target, 'SCR-003');

// determinism: input order must not change a single byte of the output
const forward = composeViews([workspaceModel, leaseModel, login, dashboard, signup]);
const reversed = composeViews([signup, dashboard, login, leaseModel, workspaceModel]);
assert.deepStrictEqual(forward, reversed);
for (const view of forward) {
  const context = { revision: 'abc1234' };
  assert.strictEqual(renderCompositeMarkdown(view, context), renderCompositeMarkdown(view, context));
}

// the rendered diagram is valid Mermaid shape and carries no timestamp in its body
const screenView = composeView('screen', [login, dashboard, signup]);
assert.match(screenView.mermaid, /^flowchart LR\n/u);
assert.match(screenView.mermaid, /SCR-001 -->\|자격 유효\| SCR-002/u);
const modelView = composeView('model', [workspaceModel, leaseModel]);
assert.match(modelView.mermaid, /^erDiagram\n/u);
assert.match(modelView.mermaid, /WORKSPACE \|\|--o\{ CLIENT : "등록"/u);
assert.strictEqual(composeView('unknown', []), null);

// the generated file declares itself derived, names its inputs, and pins the revision it was built from
const markdown = renderCompositeMarkdown(screenView, { revision: 'abc1234' });
assert.match(markdown, new RegExp(`generated: ${COMPOSITE_VERSION}`, 'u'));
assert.match(markdown, /revision: abc1234/u);
assert.match(markdown, /정본이 아니다/u);
for (const id of ['SCR-001', 'SCR-002', 'SCR-003']) assert.ok(markdown.includes(`  - ${id}`), `sources must list ${id}`);
const empty = renderCompositeMarkdown(composeView('model', []), {});
assert.match(empty, /sources: \[\]/u);
assert.doesNotMatch(empty, /```mermaid/u, 'an empty view must not emit a Mermaid block that fails to render');
assert.match(empty, /합칠 MOD 문서가 아직 없다/u);
assert.match(renderCompositeMarkdown(composeView('screen', [login, dashboard]), {}), /RDL-COMPOSE-002/u);

// every declared view has a file name and no two views share one
const files = Object.values(COMPOSITE_VIEWS).map((view) => view.file);
assert.strictEqual(new Set(files).size, files.length);

// titles come from frontmatter and fall back to the identifier
assert.strictEqual(documentTitle('---\ntitle: "로그인 화면"\n---\n', 'SCR-001'), '로그인 화면');
assert.strictEqual(documentTitle('본문만 있음', 'SCR-001'), 'SCR-001');
assert.deepStrictEqual(prepareCompositeDocuments([{ id: 'SCR-001', type: 'SCR', source: '---\ntitle: 로그인\n---\n' }])[0].title, '로그인');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-composite-'));
try {
  fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.rundol/\n.obsidian/\n');
  const documents = [workspaceModel, leaseModel, login, dashboard, signup];

  // nothing exists before the first generation
  const before = compositeViewState(projectRoot, documents, 'rev-one');
  assert.ok(before.every((view) => !view.generated && !view.stale));

  const first = writeCompositeViews(projectRoot, documents, 'rev-one');
  assert.strictEqual(first.ignored, true, 'the first write must add the generated directory to .gitignore');
  assert.ok(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8').includes(`${COMPOSITE_DIRECTORY}/`));
  assert.ok(first.views.every((view) => view.changed && view.generated && !view.stale));

  // the golden guarantee: regenerating from the same inputs rewrites the same bytes
  const bytes = first.views.map((view) => fs.readFileSync(view.file));
  const second = writeCompositeViews(projectRoot, documents.slice().reverse(), 'rev-one');
  assert.strictEqual(second.ignored, false, 'the ignore entry must be added once, not appended on every run');
  assert.ok(second.views.every((view) => !view.changed), 'a regeneration with unchanged inputs must not rewrite the file');
  second.views.forEach((view, index) => assert.ok(fs.readFileSync(view.file).equals(bytes[index]), `${view.name} must be byte-identical across runs`));

  // a canonical document moving on means the generated file is stale until it is rebuilt
  const stale = compositeViewState(projectRoot, documents, 'rev-two');
  assert.ok(stale.every((view) => view.generated && view.stale));
  assert.ok(stale.every((view) => view.storedRevision === 'rev-one'));
  assert.ok(writeCompositeViews(projectRoot, documents, 'rev-two').views.every((view) => view.changed && !view.stale));

  // deleting the generated directory loses nothing: the same bytes come back
  fs.rmSync(path.join(projectRoot, COMPOSITE_DIRECTORY), { recursive: true, force: true });
  const rebuilt = writeCompositeViews(projectRoot, documents, 'rev-one');
  rebuilt.views.forEach((view, index) => assert.ok(fs.readFileSync(view.file).equals(bytes[index]), `${view.name} must be recoverable after deletion`));

  // drift is measured against the diagram, not the recorded commit, so a new commit alone is not drift
  assert.deepStrictEqual(compositeDrift(projectRoot, documents), []);
  assert.deepStrictEqual(writeCompositeViews(projectRoot, documents, 'rev-three').views.filter((view) => view.changed).map((view) => view.name), ['model', 'screen']);
  assert.deepStrictEqual(compositeDrift(projectRoot, documents), []);

  // editing a canonical document does drift the generated file until it is rebuilt
  const drifted = compositeDrift(projectRoot, documents.filter((document) => document !== signup));
  assert.deepStrictEqual(drifted.map((view) => view.name), ['screen']);
  assert.ok(drifted[0].file.endsWith('screen.md'));

  // hand-editing the generated file is drift too, which is what keeps it from becoming a second source of truth
  fs.appendFileSync(path.join(projectRoot, COMPOSITE_DIRECTORY, 'model.md'), '\n손으로 추가한 줄\n');
  assert.deepStrictEqual(compositeDrift(projectRoot, documents).map((view) => view.name), ['model']);
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

// attach must not dirty a tracked file, so generation is skipped until the project ignores the directory
const unconfigured = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-composite-'));
try {
  fs.writeFileSync(path.join(unconfigured, '.gitignore'), '.rundol/\n');
  assert.strictEqual(compositeIgnored(unconfigured), false);
  const written = writeCompositeViews(unconfigured, [login, dashboard, signup], 'rev-one', { ensureIgnore: false });
  assert.strictEqual(written.ignored, false);
  assert.strictEqual(fs.readFileSync(path.join(unconfigured, '.gitignore'), 'utf8'), '.rundol/\n', '.gitignore must be untouched when the caller opts out');
  assert.ok(fs.existsSync(path.join(unconfigured, COMPOSITE_DIRECTORY, 'screen.md')));
  assert.strictEqual(ensureCompositeIgnored(unconfigured), true);
  assert.strictEqual(compositeIgnored(unconfigured), true);
  assert.strictEqual(ensureCompositeIgnored(unconfigured), false, 'the entry is added once, not on every call');
} finally {
  fs.rmSync(unconfigured, { recursive: true, force: true });
}

// cross-document defects no single document can see reach the caller as issues
assert.deepStrictEqual(compositeIssues([workspaceModel, rival]).map((issue) => issue.code), ['RDL-COMPOSE-001']);
assert.deepStrictEqual(compositeIssues([login, dashboard]).map((issue) => issue.code), ['RDL-COMPOSE-002']);
assert.deepStrictEqual(compositeIssues([workspaceModel, leaseModel, login, dashboard, signup]), []);
assert.strictEqual(compositeIssues([workspaceModel, rival])[0].view, 'model');

// frontmatter is provenance, not content: it never takes part in the drift comparison
assert.strictEqual(compositeBody('---\nrevision: a\n---\n본문\n'), '본문\n');
assert.strictEqual(compositeBody('본문만\n'), '본문만\n');

process.stdout.write('document composite tests passed\n');

// 제목의 큰따옴표가 노드 라벨을 깨뜨리지 않는다
assert.strictEqual(mermaidText('로그인 "실패" 화면'), '로그인 #quot;실패#quot; 화면');
const quotedScreens = renderScreenDiagram(composeScreen([
  screenDoc('SCR-101', '로그인 "실패" 화면', 'flowchart LR\n    SCR-101 -->|성공| SCR-102'),
  screenDoc('SCR-102', '대시보드', 'flowchart LR')
]));
for (const line of quotedScreens.split('\n').filter((value) => value.includes('['))) {
  assert.strictEqual((line.match(/"/g) || []).length, 2, `노드 라벨의 따옴표가 2개여야 합니다: ${line}`);
}
assert.match(quotedScreens, /SCR-101\["로그인 #quot;실패#quot; 화면"\]/u);

// 존재하지 않는 출발 화면도 도착과 같이 보고한다 (유령 노드 방지)
const phantom = composeScreen([
  screenDoc('SCR-201', '가', 'flowchart LR\n    SCR-299 -->|이동| SCR-202'),
  screenDoc('SCR-202', '나', 'flowchart LR')
]);
assert.deepStrictEqual(phantom.issues.map((issue) => issue.code), ['RDL-COMPOSE-002']);
assert.strictEqual(phantom.issues[0].target, 'SCR-299');
assert.strictEqual(phantom.transitions.length, 0, '존재하지 않는 화면의 간선은 합성하지 않는다');

// 워킹트리가 더러우면 재현 가능한 source revision이 없다. 파일과 상태가 같은 표현을 쓰되,
// dirty인 동안에는 비교가 아무것도 증명하지 못하므로 신선하다고 말하지 않는다.
{
  const os = require('os');
  const { writeCompositeViews, compositeViewState } = require('../src/document-composite');
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-composite-rev-'));
  try {
    const documents = [{ id: 'MOD-001', type: 'MOD', source: '## 관계\n\n```mermaid\nerDiagram\n  A {\n    string id\n  }\n```\n' }];

    // dirty에서 생성: 파일에는 unknown이 적히고, 쓴 그 순간만 신선하다고 본다
    const written = writeCompositeViews(probe, documents, '', { ensureIgnore: false });
    assert.ok(written.views.every((view) => view.stale === false), '쓴 직후에는 stale이 아니다');
    assert.ok(written.views.every((view) => view.storedRevision === 'unknown'), '파일과 상태가 같은 표현을 쓴다');

    // 그 뒤로는 원본이 또 바뀌었는지 알 방법이 없다. 증명할 수 없으면 신선하다고 하지 않는다.
    const reread = compositeViewState(probe, documents, '');
    assert.ok(reread.every((view) => view.stale === true), 'dirty인 동안에는 신선함을 증명할 수 없다');

    // 깨끗한 revision으로 만들면 같은 revision에서는 신선하고, 바뀌면 stale이다
    writeCompositeViews(probe, documents, 'abc1234', { ensureIgnore: false });
    assert.ok(compositeViewState(probe, documents, 'abc1234').every((view) => view.stale === false), '같은 revision이면 신선하다');
    assert.ok(compositeViewState(probe, documents, 'def5678').every((view) => view.stale === true), 'revision이 바뀌면 stale이다');
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
