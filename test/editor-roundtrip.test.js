'use strict';

// 새 문서 편집기가 파일을 상하게 하지 않는지 본다.
//
// document-roundtrip.test.js가 보는 것은 Board 저장 경로(frontmatter 보존과 줄바꿈)
// 이고, 여기서 보는 것은 그 위에 올라갈 편집기의 본문 왕복이다. 둘은 다른 계층이라
// 한쪽이 통과해도 다른 쪽은 깨질 수 있다.
//
// 이 시험이 있는 이유는 실측이다. 문서 전체를 다시 쓰는 편집기(Crepe)로 정본 문서를
// 열었다 그대로 저장하면 ADR-005가 41줄, MOD-002가 61줄 바뀌었고 본문 wikilink는
// 전부 죽었다. 그런데 rdl check --strict는 오류 0으로 통과했다 — 링크가 깨진 것이
// 아니라 없는 것이 되기 때문이다. 검사가 못 보는 손상은 시험이 봐야 한다.
//
// 편집기 모듈은 remark(ESM 전용)에 기대므로 .mjs다. CI가 Node 20이라 require로는
// 못 읽고 동적 import를 쓴다. 그래서 이 파일은 promise를 내보내고 run.js가 기다린다.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { parseFrontmatter } = require('../src/frontmatter');

const root = path.resolve(__dirname, '..');

function markdownFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.obsidian' || entry.name === '.rundol' || entry.name === 'node_modules') continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(target, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(target);
  }
  return out;
}

function bodyOf(original) {
  const parsed = parseFrontmatter(original);
  if (!parsed || !parsed.data.id) return null;
  // Board 저장 경로가 본문에 하는 정규화와 같은 것을 먼저 적용한다. 그 경로를 지나
  // 편집기로 들어오므로, 그 앞의 상태를 시험하면 실제로 일어나지 않는 일을 시험하게 된다.
  return parsed.body.replace(/\r\n/g, '\n').replace(/^\s+|\s+$/g, '');
}

function firstDifference(left, right) {
  const a = left.split('\n');
  const b = right.split('\n');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      return `${index + 1}번째 줄\n    열기 전: ${JSON.stringify(a[index])}\n    저장 후: ${JSON.stringify(b[index])}`;
    }
  }
  return `길이만 다름 (${left.length}자 → ${right.length}자)`;
}

function count(text, pattern) {
  return (text.match(pattern) || []).length;
}

// 되쓰기 경로에서 반드시 살아남아야 하는 문법. 저장소 문서는 바뀌므로, 지켜야 할
// 것을 여기 고정한다. 아래 고정값은 편집한 블록이 타는 경로(강제 직렬화)를 통과해야
// 하며, 그것이 실제 편집에서 일어나는 일이다.
const FIXTURES = [
  ['별칭 있는 문서 링크', '본문에서 [[ADR-015-문서-소프트-리스-폐기와-동시성-판정의-일원화|ADR-015]]를 가리킨다.'],
  ['별칭 없는 문서 링크', '본문에서 [[project]]를 가리킨다.'],
  ['앵커와 별칭', '담당은 [[project#^MEMBER-001|강영준]]이다.'],
  ['mermaid 블록', '```mermaid\nerDiagram\n    A ||--o{ B : "가짐"\n```'],
  ['한글 표', '| 코드 | 역할 |\n|---|---|\n| PRD | 제품 목표와 범위 |'],
  ['정렬한 표', '| 왼쪽 | 가운데 | 오른쪽 |\n|:---|:---:|---:|\n| a | b | c |'],
  ['중첩 목록', '- 위\n  - 아래\n    - 더 아래'],
  ['체크 목록', '- [ ] 아직\n- [x] 마침'],
  ['서식이 겹친 문단', '**앞 `코드` 뒤**와 *기울임*과 ~~취소선~~이 한 줄에 있다.'],
  ['인용문', '> 첫 문단.\n>\n> 둘째 문단.'],
  ['코드 스팬 안의 대괄호', '설정은 `items[0]`로 읽는다.'],
  ['번호 목록', '1. 하나\n2. 둘\n3. 셋'],
  ['구분선', '---']
];

async function main() {
  const editorDir = path.join(root, 'src', 'board-ui', 'editor');
  const { fromMarkdown } = await import(pathToFileURL(path.join(editorDir, 'from-markdown.mjs')).href);
  const { toMarkdown } = await import(pathToFileURL(path.join(editorDir, 'to-markdown.mjs')).href);

  // 1. 열었다 그대로 저장 — 정본 전체가 바이트 동일이어야 한다.
  //    편집하지 않은 블록은 원문 조각을 그대로 쓰므로 예외가 없어야 한다.
  const corpus = [
    ...markdownFiles(path.join(root, 'projects')),
    ...markdownFiles(path.join(root, 'test', 'fixtures'))
  ];
  let checked = 0;
  const untouched = [];
  const unknownTypes = new Map();

  for (const file of corpus) {
    const body = bodyOf(fs.readFileSync(file, 'utf8'));
    if (body == null) continue;
    checked += 1;
    const { doc, sources, unknown } = fromMarkdown(body);
    for (const type of unknown) unknownTypes.set(type, (unknownTypes.get(type) || 0) + 1);
    const { markdown } = toMarkdown(doc, sources);
    if (markdown !== body) untouched.push(`  ${path.relative(root, file)}\n    ${firstDifference(body, markdown)}`);
  }

  assert.ok(checked > 0, '정본 문서를 하나도 찾지 못했습니다. 표본 경로가 잘못되었습니다.');
  assert.strictEqual(
    untouched.length,
    0,
    `편집하지 않고 저장했는데 본문이 바뀌는 문서 ${untouched.length}개 (정본 ${checked}개 중):\n${untouched.join('\n')}`
  );

  // 스키마가 모르는 유형은 불러오는 순간 사라진다. 조용히 사라지면 아무도 모르므로
  // 여기서 막는다. 새 문법을 쓰기 시작하면 이 줄이 먼저 걸린다.
  assert.strictEqual(
    unknownTypes.size,
    0,
    `편집기 스키마가 모르는 mdast 유형이 있습니다: ${[...unknownTypes].map(([k, v]) => `${k}×${v}`).join(', ')}`
  );

  // 2. 편집한 블록이 타는 경로 — 정본 전체를 강제로 다시 쓰게 하고, 잃으면 안 되는
  //    것이 그대로인지 센다. 줄 모양은 달라질 수 있어도 이것들은 개수가 같아야 한다.
  let mermaidBefore = 0, mermaidAfter = 0, embedBefore = 0, embedAfter = 0;
  for (const file of corpus) {
    const body = bodyOf(fs.readFileSync(file, 'utf8'));
    if (body == null) continue;
    const { doc } = fromMarkdown(body);
    const forced = toMarkdown(doc, new Map()).markdown;
    mermaidBefore += count(body, /^```mermaid/gmu);
    mermaidAfter += count(forced, /^```mermaid/gmu);
    embedBefore += count(body, /!\[\[/gu);
    embedAfter += count(forced, /!\[\[/gu);
  }
  assert.strictEqual(mermaidAfter, mermaidBefore, `다시 쓰기에서 mermaid 블록이 줄었습니다: ${mermaidBefore} → ${mermaidAfter}`);
  assert.strictEqual(embedAfter, embedBefore, `다시 쓰기에서 자산 참조가 줄었습니다: ${embedBefore} → ${embedAfter}`);

  // 3. 문법 고정값 — 편집한 블록이 원문과 같은 모양으로 돌아와야 한다.
  for (const [name, source] of FIXTURES) {
    const { doc } = fromMarkdown(source);
    const forced = toMarkdown(doc, new Map()).markdown;
    assert.strictEqual(forced, source, `${name}이 다시 쓰기에서 바뀝니다\n  전: ${JSON.stringify(source)}\n  후: ${JSON.stringify(forced)}`);
  }

  // 4. 고친 블록만 다시 쓰인다 — 이 설계의 핵심 주장이다. 주장만 있고 시험이 없으면
  //    어느 날 조용히 전체 재작성으로 돌아가 있어도 알 수 없다.
  const sample = '# 제목\n\n첫 문단.\n\n둘째 문단.\n\n| A | B |\n|---|---|\n| 1 | 2 |';
  const { doc, sources } = fromMarkdown(sample);
  const kept = toMarkdown(doc, sources);
  assert.strictEqual(kept.reserialized, 0, '편집하지 않았는데 다시 쓴 블록이 있습니다');
  assert.strictEqual(kept.preserved, doc.childCount, '보존된 블록 수가 최상위 블록 수와 다릅니다');

  const edited = doc.type.schema.nodes.doc.create(null, [
    doc.child(0),
    doc.type.schema.nodes.paragraph.create(null, [doc.type.schema.text('고친 문단.')]),
    doc.child(2),
    doc.child(3)
  ]);
  const after = toMarkdown(edited, sources);
  assert.strictEqual(after.reserialized, 1, `한 블록만 고쳤는데 다시 쓴 블록이 ${after.reserialized}개입니다`);
  assert.strictEqual(after.preserved, 3, `손대지 않은 블록 3개가 보존되어야 하는데 ${after.preserved}개입니다`);
  assert.ok(after.markdown.includes('| A | B |\n|---|---|\n| 1 | 2 |'), '손대지 않은 표가 원문 그대로 남지 않았습니다');

  // 5. 되돌리기 — 내용이 같은 새 노드는 원문 조각을 되찾아야 한다.
  //    history는 역단계를 적용해 문서를 되돌리므로 내용이 같아도 노드는 새로 만들어진다.
  //    객체만 보면 고쳤다 되돌린 블록이 영영 고친 블록으로 남아, 되돌렸는데도 diff가 생긴다.
  const children = [];
  doc.forEach((node) => children.push(node.type.create(node.attrs, node.content, node.marks)));
  const rebuilt = doc.type.schema.nodes.doc.create(null, children);
  const restored = toMarkdown(rebuilt, sources);
  assert.strictEqual(restored.reserialized, 0, `되돌린 뒤에도 다시 쓴 블록이 ${restored.reserialized}개 남습니다`);
  assert.strictEqual(restored.markdown, sample, '되돌린 문서가 원문과 다릅니다');

  process.stdout.write(`editor roundtrip tests passed (정본 문서 ${checked}개, 고정값 ${FIXTURES.length}종)\n`);
}

module.exports = main();
