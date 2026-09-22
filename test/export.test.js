'use strict';

// 배포판. 이 스위트가 지키는 것은 하나다 — 나간 파일이 바깥을 하나도 요구하지
// 않는다. 그 성질이 깨지면 git 없는 사람에게 넘긴다는 기능의 전제가 사라지고,
// 깨졌다는 사실은 받은 사람이 열어 봐야만 드러난다.
//
// 읽기 전용도 시험한다. 뷰어에 쓰기 경로가 생기면 받은 사람은 고칠 수 있다고
// 믿고 고치며, 그 고침은 어느 원장에도 닿지 않는다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-export-'));
const home = path.join(temporary, 'runtime');

function environment() {
  return Object.assign({}, process.env, { RUNDOL_HOME: home });
}
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8', env: environment() });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
}
function rdl(args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: repository, encoding: 'utf8', env: environment() });
  assert.strictEqual(result.status, 0, `rdl ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

try {
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Rundol Test']);
  git(['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# export\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  rdl(['init', 'ship', '--name', 'Ship', '--profile', 'lean']);
  rdl(['client', 'register', 'ship-human', '--name', '검토자', '--type', 'human', '--owner', 'MEMBER-001']);

  const prd = rdl(['doc', 'create', 'PRD', '배포 대상 제품', '--owner', 'MEMBER-001',
    '--scope', '배포판을 확인하는 제품', '--exclude', '그 밖', '--project', 'ship']);
  const req = rdl(['doc', 'create', 'REQ', '배포 요구', '--owner', 'MEMBER-001',
    '--scope', '사용자가 배포판을 여는 동작', '--exclude', '그 밖',
    '--function-id', 'FN-001', '--related', prd.id, '--project', 'ship']);
  rdl(['task', 'add', '배포판 확인', '--project', 'ship', '--owner', 'MEMBER-001', '--acceptance', '한 파일로 열린다']);
  rdl(['doc', 'approve', prd.id, '--client-id', 'ship-human', '--member', 'MEMBER-001', '--basis', 'read', '--reason', '읽고 승인', '--project', 'ship']);

  // 내용이 코드를 끊지 못한다. 본문에 </script>가 있는 문서를 하나 심어 두고 그
  // 배포판이 여전히 값을 읽는지 본다 — 이 사고는 열어 봐야만 드러나므로 시험이 연다.
  const reqFile = path.join(temporary, 'projects', 'ship', req.file.replace(/^.*projects\/ship\//u, ''));
  const target = fs.existsSync(reqFile) ? reqFile : path.join(temporary, req.relativeFile);
  fs.appendFileSync(target, '\n\n닫는 조각을 본문에 둔다: </script> 그리고 <!-- 주석 -->\n', 'utf8');

  const out = path.join(temporary, 'ship-status.html');
  const result = rdl(['export', '--project', 'ship', '--out', out]);
  assert.strictEqual(result.readOnly, true, '배포판은 읽기 전용이라고 스스로 말해야 합니다.');
  assert.strictEqual(result.file, out);
  // 셋인 것은 헌장이 함께 실리기 때문이다. 받는 사람이 "이 프로젝트가 무엇인가"를
  // 물을 자리가 헌장이고, 그것이 빠진 현황은 문서 더미와 구분되지 않는다.
  assert.strictEqual(result.documents, 3);
  assert.strictEqual(result.tasks, 1);
  assert(result.generatedAt, '언제 것인지가 결과에 실려야 합니다.');

  const html = fs.readFileSync(out, 'utf8');

  // ── 자기완결 ──────────────────────────────────────────────────────────────
  // 바깥을 가리키는 것이 하나도 없어야 한다. data:는 파일 안이므로 센다.
  const external = html.match(/(?:src|href)="(?!#|data:)[^"]*"/gu) || [];
  assert.deepStrictEqual(external, [], `배포판이 바깥을 참조합니다: ${external.slice(0, 5).join(', ')}`);
  assert(!/<link\b/u.test(html), '외부 스타일시트를 걸면 안 됩니다.');
  assert(!/@import/u.test(html), '@import는 바깥을 부릅니다.');
  // fetch·XHR이 없다는 것이 "네트워크가 없어도 열린다"의 실제 보장이다.
  assert(!/\bfetch\s*\(/u.test(html) && !/XMLHttpRequest/u.test(html), '배포판은 네트워크를 부르지 않습니다.');

  // ── 읽기 전용 ─────────────────────────────────────────────────────────────
  assert(!/<form\b/u.test(html), '배포판에 폼이 있으면 받은 사람은 고칠 수 있다고 믿습니다.');
  assert(!/<textarea\b/u.test(html), '입력 칸은 검색 하나뿐이어야 합니다.');
  const inputs = html.match(/<input\b[^>]*>/gu) || [];
  assert.strictEqual(inputs.length, 1, `입력은 검색 하나여야 합니다: ${inputs.join(' ')}`);
  assert(/type="search"/u.test(inputs[0]), '그 하나는 검색이어야 합니다.');

  // ── 내용 ──────────────────────────────────────────────────────────────────
  const payloadMatch = /<script id="payload" type="application\/json">([\s\S]*?)<\/script>/u.exec(html);
  assert(payloadMatch, '값이 실려 있어야 합니다.');
  const payload = JSON.parse(payloadMatch[1]);
  assert.strictEqual(payload.readOnly, true);
  assert.strictEqual(payload.documents.length, 3);
  assert(payload.documents.some((item) => item.id === 'project:ship'), '헌장이 배포판에 실려야 합니다.');
  // 본문이 미리 렌더링되어 온다 — 받는 쪽이 마크다운 파서를 싣지 않는 이유다.
  const requirement = payload.documents.find((item) => item.id === req.id);
  assert(/<h1|<h2|<p>/u.test(requirement.html), `본문이 HTML로 굳어야 합니다: ${requirement.html.slice(0, 80)}`);
  assert(!/<script/iu.test(requirement.html), '본문이 스크립트를 들고 오면 안 됩니다.');
  // 유형은 식별자에서 읽는다. frontmatter의 type(=document)을 쓰면 흐름이 비어 버린다.
  assert.strictEqual(requirement.type, 'REQ');
  assert(payload.flow.layers.length >= 2, `흐름 사슬이 층으로 서야 합니다: ${JSON.stringify(payload.flow.layers)}`);
  assert.strictEqual(payload.flow.counts.PRD.approved, 1, '승인 원장의 사실이 실려야 합니다.');
  assert.strictEqual(payload.flow.counts.REQ.approved, 0);
  assert.strictEqual(payload.tasks.length, 1);
  assert(payload.tasks[0].acceptance && payload.tasks[0].acceptance.total === 1, '완료조건이 세어져야 합니다.');

  // 다이어그램이 없으면 mermaid도 없다. 3.4MB는 다이어그램을 보는 값이지 모든
  // 배포판이 치를 값이 아니다.
  assert.strictEqual(result.diagrams, false);
  assert.strictEqual(result.mermaidIncluded, false);
  assert(result.bytes < 400 * 1024, `다이어그램 없는 배포판이 너무 큽니다: ${result.bytes}`);

  // ── 다이어그램이 있으면 싣는다 ────────────────────────────────────────────
  fs.appendFileSync(target, '\n\n```mermaid\nflowchart LR\n  A --> B\n```\n', 'utf8');
  const withDiagram = rdl(['export', '--project', 'ship', '--out', path.join(temporary, 'ship-diagram.html')]);
  assert.strictEqual(withDiagram.diagrams, true, '다이어그램을 알아봐야 합니다.');
  assert.strictEqual(withDiagram.mermaidIncluded, true, '그릴 것이 있으면 그리는 도구가 함께 가야 합니다.');
  assert(withDiagram.bytes > result.bytes, '다이어그램이 있는 배포판은 더 큽니다.');

  // 그리고 빼는 길이 있다. 그 프로젝트의 사람이 다이어그램을 안 볼 수도 있다.
  const without = rdl(['export', '--project', 'ship', '--out', path.join(temporary, 'ship-plain.html'), '--no-diagrams']);
  assert.strictEqual(without.diagrams, true, '있다는 사실은 그대로 말한다.');
  assert.strictEqual(without.mermaidIncluded, false, '--no-diagrams는 싣지 않는다.');
  assert(without.bytes < withDiagram.bytes);

  // ── 뷰어가 실제로 돈다 ────────────────────────────────────────────────────
  // 파일이 열린다는 말은 스크립트가 돌아 화면이 선다는 뜻이다. 모양을 재지 않고
  // "값을 읽어 무언가를 그렸는가"만 본다 — 모양은 바뀌지만 이 성질은 바뀌지 않는다.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(fs.readFileSync(path.join(temporary, 'ship-plain.html'), 'utf8'), { runScripts: 'dangerously' });
  const view = dom.window.document;
  assert(view.getElementById('main').innerHTML.length > 100, '배포판을 열면 화면이 서야 합니다.');
  assert(/업무 현황/u.test(view.getElementById('main').textContent), '첫 화면은 현황입니다.');
  assert(/읽기 전용/u.test(view.body.textContent), '받는 사람이 읽기 전용임을 화면에서 알아야 합니다.');
  // 문서 면으로 옮기면 목록이 선다.
  view.querySelector('[data-tab="documents"]').click();
  assert.strictEqual(view.querySelectorAll('.list .row').length, 3, '문서 목록이 서야 합니다.');
  view.querySelectorAll('.list .row')[0].click();
  assert(/PRD-001|REQ-001|project:ship/u.test(view.getElementById('main').textContent), '고른 문서가 열려야 합니다.');
  dom.window.close();

  process.stdout.write('export tests passed' + String.fromCharCode(10));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
