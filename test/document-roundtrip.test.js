'use strict';

// 열었다 그대로 저장하면 파일이 바이트 동일해야 한다.
//
// 이 저장소에서 diff는 검토 수단이다. 저장 경로가 문서를 조금이라도 다시 쓰면 한
// 글자 고친 커밋과 손대지 않은 커밋이 같은 크기의 diff가 되고, 그러면 사람이 무엇이
// 바뀌었는지 diff로 알 수 없게 된다. board.js가 CRLF와 frontmatter 뒤 빈 줄까지
// 되살리는 이유가 그것인데, 그 보장은 지금까지 시험되지 않았다.
//
// 정본 문서 전체를 통과시키는 이유는 표본이 아니라 실물이어야 하기 때문이다.
// 지어낸 문서는 지어낸 사람이 아는 문법만 담는다. 이 저장소의 문서에는 Obsidian
// wikilink, 한글 표, mermaid 블록, block anchor가 실제로 섞여 있고 저장 경로가
// 지켜야 하는 것도 그것이다.
//
// 이 시험은 WYSIWYG 편집기 도입의 전제이기도 하다. 문서를 AST로 읽고 통째로 다시
// 쓰는 편집기는 여기서 먼저 걸린다.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { composeDocumentFile } = require('../src/board');
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

// 첫 어긋난 줄을 짚어 준다. "파일이 다릅니다"만으로는 어디를 고쳐야 하는지
// 알 수 없어 진단이 아니라 통보가 된다.
function firstDifference(left, right) {
  const a = left.split('\n');
  const b = right.split('\n');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      return `${index + 1}번째 줄\n    원본: ${JSON.stringify(a[index])}\n    저장: ${JSON.stringify(b[index])}`;
    }
  }
  return `길이만 다름 (원본 ${left.length}자, 저장 ${right.length}자)`;
}

const corpus = [
  ...markdownFiles(path.join(root, 'projects')),
  ...markdownFiles(path.join(root, 'test', 'fixtures'))
];

// 첫 실패에서 멈추지 않는다. 한 건만 알려주면 고치고 다시 돌리기를 반복하게 되고,
// 그 사이 몇 건이 남았는지는 끝까지 모른다. 규모를 모르면 문서를 고칠지 저장 경로를
// 고칠지 판단할 수 없다.
let checked = 0;
const failures = [];
for (const file of corpus) {
  const original = fs.readFileSync(file, 'utf8');
  const parsed = parseFrontmatter(original);
  // Board가 편집 대상으로 삼는 것은 id를 가진 정본 문서뿐이다. 나머지는 저장
  // 경로를 타지 않으므로 이 보장의 대상도 아니다.
  if (!parsed || !parsed.data.id) continue;
  checked += 1;
  const composed = composeDocumentFile(original, parsed.body);
  if (composed !== original) failures.push(`  ${path.relative(root, file)}\n    ${firstDifference(original, composed)}`);
}

assert.ok(checked > 0, '정본 문서를 하나도 찾지 못했습니다. 표본 경로가 잘못되었습니다.');
assert.strictEqual(
  failures.length,
  0,
  `편집 없이 저장했는데 파일이 바뀌는 문서 ${failures.length}개 (정본 ${checked}개 중):\n${failures.join('\n')}`
);

// 저장소 문서는 바뀐다. 위 순회만 두면 어느 날 wikilink를 쓰는 문서가 하나도
// 남지 않았을 때 시험은 통과하면서 보장은 사라진다. 지켜야 할 문법을 여기에 고정한다.
const fixtures = [
  ['Obsidian wikilink', '본문에서 [[REQ-003-OAuth-로그인|REQ-003]]을 가리킨다.\n'],
  ['block anchor', '### 강영준 ^MEMBER-001\n\n- 역할: 개발\n'],
  ['한글 표', '| 코드 | 역할 |\n|---|---|\n| PRD | 제품 목표와 범위 |\n'],
  ['mermaid 블록', '```mermaid\nerDiagram\n  A ||--o{ B : has\n```\n'],
  ['밑줄이 든 파일명', '설정은 my_file_name.md에 있고 곱셈은 2*3=6이다.\n'],
  ['중첩 목록', '- 위\n  - 아래\n    - 더 아래\n'],
  ['표 뒤 문단', '| A | B |\n|---|---|\n| 1 | 2 |\n\n표가 정본이다.\n']
];
// 본문이 빈 문서는 여기 없다. 그 경우 저장 경로가 줄바꿈 하나를 더하지만, 빈 문서는
// 유형별 필수 절이 없어 rdl check --strict가 막고 저장은 원본으로 되돌아간다.
// 저장될 수 없는 상태를 고정하면 시험이 실제로 일어나는 일과 멀어진다.

const frontmatter = '---\nid: REQ-999\ntype: document\n---\n\n';
for (const [name, body] of fixtures) {
  const original = `${frontmatter}${body}`;
  assert.strictEqual(
    composeDocumentFile(original, parseFrontmatter(original).body),
    original,
    `${name}이 저장을 지나며 바뀝니다`
  );
}

// CRLF 문서를 LF로 되돌려 쓰면 한 글자도 고치지 않아도 전 줄이 바뀐 diff가 된다.
const crlf = `${frontmatter.replace(/\n/g, '\r\n')}첫 줄\r\n\r\n둘째 줄\r\n`;
assert.strictEqual(
  composeDocumentFile(crlf, parseFrontmatter(crlf).body),
  crlf,
  'CRLF 문서가 저장을 지나며 LF로 바뀝니다'
);

// ── 수명 칸을 옮기는 쓰기도 같은 보장을 진다 ────────────────────────────────
//
// 이 쓰기는 저장 경로와 다른 자리에 있지만 지켜야 하는 것은 같다. 수명은 리비전 해시
// 안에 있어서(판 2가 빼는 것은 state 하나다) 이 쓰기가 다른 줄을 한 글자라도 건드리면
// 그 문서에 걸린 승인이 수명과 무관한 이유로 낡는다. 그리고 그 낡음은 아무 신호도
// 내지 않는다 — 화면은 "수명을 바꿨다"고만 말한다.
//
// 그래서 왕복으로 잰다. 넣었다 빼면 바이트가 그대로여야 하고, 있던 값을 같은 값으로
// 다시 적어도 그대로여야 한다.
const { withDocumentLifecycle } = require('../src/document');
const lifecycleFailures = [];
let lifecycleChecked = 0;
for (const file of corpus) {
  const original = fs.readFileSync(file, 'utf8');
  const parsed = parseFrontmatter(original);
  if (!parsed || !parsed.data.id) continue;
  const had = typeof parsed.data.lifecycle === 'string' && parsed.data.lifecycle.trim() ? parsed.data.lifecycle.trim() : null;
  lifecycleChecked += 1;
  const written = withDocumentLifecycle(original, 'archived');
  if (written === null) { lifecycleFailures.push(`  ${path.relative(root, file)}\n    frontmatter를 찾지 못했습니다`); continue; }
  // 넣은 뒤 되돌린다. 없던 문서는 지워서, 있던 문서는 옛 값을 다시 적어서.
  const restored = withDocumentLifecycle(written, had);
  if (restored !== original) lifecycleFailures.push(`  ${path.relative(root, file)}\n    ${firstDifference(original, restored)}`);
  // 줄 수는 딱 하나만 늘거나 그대로여야 한다. 두 줄이 늘면 어딘가에 빈 줄을 남긴 것이다.
  const delta = written.split('\n').length - original.split('\n').length;
  if (delta !== (had ? 0 : 1)) lifecycleFailures.push(`  ${path.relative(root, file)}\n    줄 수가 ${delta} 만큼 달라졌습니다 (기대 ${had ? 0 : 1})`);
}
assert.ok(lifecycleChecked > 0, '수명 왕복을 잴 정본 문서를 찾지 못했습니다.');
assert.strictEqual(lifecycleFailures.length, 0,
  `수명을 넣었다 되돌리면 바이트가 달라지는 문서 ${lifecycleFailures.length}개 (정본 ${lifecycleChecked}개 중):\n${lifecycleFailures.join('\n')}`);

// 어휘 밖 값이 아니라 **자리**를 고정한다. 이관(document-migration)이 state 바로 아래에
// 넣으므로 여기서도 같은 자리여야 하고, 갈리면 옮겨 온 문서와 여기서 적은 문서의
// frontmatter 모양이 달라진다.
{
  const withState = '---\nid: REQ-999\nstate: draft\ntype: document\n---\n\n본문\n';
  assert.strictEqual(withDocumentLifecycle(withState, 'accepted'),
    '---\nid: REQ-999\nstate: draft\nlifecycle: accepted\ntype: document\n---\n\n본문\n',
    '수명 줄은 state 바로 아래에 선다');
  const crlfState = withState.replace(/\n/g, '\r\n');
  assert.strictEqual(withDocumentLifecycle(crlfState, 'accepted'),
    '---\r\nid: REQ-999\r\nstate: draft\r\nlifecycle: accepted\r\ntype: document\r\n---\r\n\r\n본문\r\n',
    'CRLF 문서에 섞인 줄 끝을 만들면 안 됩니다');
  // 지우는 길이 고르는 길과 나란히 있어야 한다. 비어 있는 것과 active는 다른 값이라,
  // 지우는 길이 없으면 잘못 적은 수명을 되돌릴 방법이 손편집뿐이 된다.
  assert.strictEqual(withDocumentLifecycle(withDocumentLifecycle(withState, 'accepted'), null), withState);
  // 값이 없는 `lifecycle:` 한 줄을 남기지 않는다. 파서가 그것을 빈 배열로 읽어
  // RDL-DOC-017이 어휘 밖 값으로 잡는다.
  assert(!/lifecycle:/u.test(withDocumentLifecycle(withDocumentLifecycle(withState, 'accepted'), null)));
  assert.strictEqual(withDocumentLifecycle(withState, null), withState, '없는 칸을 지우면 원본 그대로여야 합니다');
  assert.strictEqual(withDocumentLifecycle('frontmatter 없는 글\n', 'active'), null);
}

process.stdout.write(`document roundtrip tests passed (정본 문서 ${checked}개 · 수명 왕복 ${lifecycleChecked}개)\n`);
