'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-hook-'));
const home = path.join(temporary, 'runtime');
process.env.RUNDOL_HOME = home;

// 승인 낡음 시험은 실제 Workspace를 요구한다 — 원장이 없으면 낡음이라는 사실 자체가 없다.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-hook-ws-'));

const { normalizeEvent, normalizePayload, runHook } = require('../src/hook');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function commit(message, trailer) {
  fs.writeFileSync(path.join(temporary, 'file.txt'), `${message}\n`, 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', trailer ? `${message}\n\n${trailer}` : message]);
  return git(['rev-parse', 'HEAD']);
}

function hook(event, payload) {
  return runHook(temporary, { event, client: 'claude', payload });
}

try {
  // ── 입력 판정 ──────────────────────────────────────────────────────────

  assert.strictEqual(normalizeEvent('Stop'), 'stop', '이벤트 이름은 대소문자를 가리지 않는다');
  assert.strictEqual(normalizeEvent('Pre-Tool-Use'), 'pre-tool-use', '쓰기 전 판정도 이 명령이 받는다');
  // 페이로드의 hook_event_name과 명령의 이벤트 이름은 다른 값이다. 클라이언트가 부르는
  // 이름(PreToolUse)을 그대로 받아 주면 두 표기가 섞이고, 섞인 뒤에는 어느 쪽이 정본인지
  // 다투게 된다.
  assert.throws(() => normalizeEvent('PreToolUse'), /지원하지 않는 훅 이벤트/u, '클라이언트 표기는 명령의 이름이 아니다');
  assert.throws(() => normalizeEvent(''), /지원하지 않는 훅 이벤트/u);

  // 두 클라이언트의 페이로드는 필드 이름이 같다. 없는 값은 없는 채로 둔다 —
  // 빈 문자열로 채우면 "모른다"와 "빈 이름"이 같은 값이 된다.
  const parsed = normalizePayload({ hook_event_name: 'Stop', cwd: 'c:/x', session_id: 's1', stop_hook_active: true });
  assert.strictEqual(parsed.sessionId, 's1');
  assert.strictEqual(parsed.stopHookActive, true);
  assert.strictEqual(normalizePayload({}).sessionId, null, '없는 세션은 null이다');
  assert.strictEqual(normalizePayload(null).stopHookActive, false, '깨진 입력도 판정을 지어내지 않는다');

  const tool = normalizePayload({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  assert.strictEqual(tool.command, 'git commit -m x');
  assert.strictEqual(normalizePayload({ tool_input: 'not-an-object' }).command, null, '객체가 아닌 tool_input은 무시한다');

  // 바뀐 자리를 담는다. 쓰고 난 파일만 보면 지금 값이 무엇인지는 알아도 이 쓰기가
  // 그 값을 만든 것인지 원래 있던 것인지 가를 수 없다.
  const edited = normalizePayload({ tool_name: 'Edit', tool_input: { file_path: 'a.md', old_string: 'x', new_string: 'y' } });
  assert.deepStrictEqual(edited.edits, [{ before: 'x', after: 'y' }]);
  const multi = normalizePayload({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.md', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } });
  assert.deepStrictEqual(multi.edits, [{ before: 'a', after: 'b' }, { before: 'c', after: 'd' }]);
  assert.deepStrictEqual(normalizePayload({ tool_name: 'Write', tool_input: { file_path: 'a.md', content: 'z' } }).edits, [],
    'Write에는 견줄 이전 값이 없으므로 짝을 만들지 않는다');
  assert.deepStrictEqual(normalizePayload({ tool_input: { edits: 'broken' } }).edits, [], '깨진 입력도 판정을 지어내지 않는다');

  // ── 저장소 밖 ─────────────────────────────────────────────────────────

  const outside = runHook(os.tmpdir(), { event: 'stop', payload: { cwd: path.join(os.tmpdir(), 'no-such-rundol-repo') } });
  assert.strictEqual(outside.block, false, 'Git 저장소 밖에서는 막지 않는다');

  // ── 준비 ──────────────────────────────────────────────────────────────

  git(['init', '--initial-branch=main', temporary], os.tmpdir());
  git(['config', 'user.email', 'hook@test.local']);
  git(['config', 'user.name', 'Hook Test']);
  const base = commit('base', 'Rundol-Task: TASK-BASE');

  // ── session-start ─────────────────────────────────────────────────────

  const started = hook('session-start', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(started.block, false, '시작은 막지 않는다');
  assert.ok(started.context.some((line) => line.includes('main')), '현재 브랜치를 알린다');
  assert.ok(started.context.some((line) => line.includes('본 트리')), '본 작업 트리임을 알린다');

  // 규칙이 없으면 채운다. 세션 worktree가 저장소 안에 서게 되면서 이 규칙은 편의가
  // 아니라 전제가 됐다 — 없는 채로 자리를 옮기면 git add -A 한 번이 트리를 통째로 담는다.
  const ignoreFile = path.join(temporary, '.gitignore');
  const filled = fs.readFileSync(ignoreFile, 'utf8');
  assert.ok(filled.includes('/projects/*/'), '문서 worktree 규칙을 채운다');
  assert.ok(filled.includes('.rundol/'), '코드 worktree 규칙을 채운다');
  assert.ok(started.context.some((line) => line.includes('추적 제외 규칙을 채웠습니다')), '무엇을 채웠는지 말한다');

  // 이미 있으면 건드리지 않는다. 부를 때마다 덧붙이면 파일이 자란다.
  const again = hook('session-start', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(fs.readFileSync(ignoreFile, 'utf8'), filled, '규칙이 있으면 파일을 바꾸지 않는다');
  assert.ok(!again.context.some((line) => line.includes('채웠습니다')), '할 일이 없으면 말하지 않는다');

  // 하나만 빠져 있으면 그것만 채운다.
  fs.writeFileSync(ignoreFile, 'node_modules/\n/projects/*/\n', 'utf8');
  const partial = hook('session-start', { cwd: temporary, session_id: 'sess-1' });
  const repaired = fs.readFileSync(ignoreFile, 'utf8');
  assert.ok(repaired.includes('node_modules/'), '있던 내용은 남긴다');
  assert.strictEqual(repaired.split(/\r?\n/u).filter((line) => line.trim() === '/projects/*/').length, 1, '있는 규칙을 두 번 적지 않는다');
  assert.ok(repaired.includes('.rundol/'), '빠진 규칙만 채운다');
  assert.ok(partial.context.some((line) => line.includes('.rundol/')), '채운 규칙을 지목한다');

  // ── stop: 새 커밋이 없으면 통과 ────────────────────────────────────────

  const quiet = hook('stop', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(quiet.block, false, '커서 이후 커밋이 없으면 막을 것이 없다');

  // ── stop: 이 턴이 만든 미결박 커밋이 있으면 막는다 ────────────────────

  const loose = commit('unbound work');
  const blocked = hook('stop', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(blocked.block, true, '결박을 지나지 않은 새 커밋은 되돌린다');
  assert.ok(blocked.reason.includes(loose.slice(0, 12)), '어느 커밋인지 지목한다');
  assert.ok(blocked.reason.includes('Rundol-Task'), '고치는 방법을 함께 준다');

  // ── stop: 두 번째 회차는 통과하고 커서를 전진한다 ─────────────────────

  const second = hook('stop', { cwd: temporary, session_id: 'sess-1', stop_hook_active: true });
  assert.strictEqual(second.block, false, '한 턴에 한 번만 되돌린다');
  const third = hook('stop', { cwd: temporary, session_id: 'sess-1' });
  assert.strictEqual(third.block, false, '전진한 커서는 같은 커밋을 다시 막지 않는다');

  // ── stop: 결박된 커밋은 막지 않는다 ───────────────────────────────────

  commit('bound work', 'Rundol-Task: TASK-XYZ');
  assert.strictEqual(hook('stop', { cwd: temporary, session_id: 'sess-1' }).block, false, '결박된 커밋은 통과한다');

  // 우회도 결박을 지난 것이다. 사유를 남긴 커밋을 막으면 우회라는 갈래가 없어진다.
  commit('excused work', 'Rundol-Task: none\nRundol-Task-Reason: 긴급 배포');
  assert.strictEqual(hook('stop', { cwd: temporary, session_id: 'sess-1' }).block, false, '사유를 남긴 커밋도 통과한다');

  // ── stop: 커서가 없으면 아무것도 세지 않는다 ──────────────────────────

  commit('work with no cursor');
  const noCursor = hook('stop', { cwd: temporary, session_id: 'never-started' });
  assert.strictEqual(noCursor.block, false, '커서를 잃었다고 과거를 이 턴의 위반으로 읽지 않는다');

  // ── stop: 프로젝트 브랜치는 rdl save가 이미 강제한다 ──────────────────

  git(['checkout', '-b', 'rundol/demo']);
  hook('session-start', { cwd: temporary, session_id: 'sess-2' });
  commit('doc work');
  assert.strictEqual(hook('stop', { cwd: temporary, session_id: 'sess-2' }).block, false, '프로젝트 브랜치에서는 두 번 막지 않는다');
  git(['checkout', 'main']);

  // ── pre-tool-use ──────────────────────────────────────────────────────

  // 되돌릴 것이 없는 시점에 막는다. 커밋에서 막으면 작업은 이미 잘못된 자리에 쌓인 뒤다.
  // 다만 origin/HEAD가 없는 저장소에서는 기본 브랜치를 알 수 없어 판정하지 않는다 —
  // 이 시험 저장소가 그 경우이며, 추측해서 막지 않는다는 것 자체가 계약이다.
  const codeWrite = hook('pre-tool-use', { cwd: temporary, tool_name: 'Edit', tool_input: { file_path: path.join(temporary, 'src', 'x.js') } });
  assert.strictEqual(codeWrite.block, false, '기본 브랜치를 모르면 막지 않는다');

  assert.strictEqual(hook('pre-tool-use', { cwd: temporary, tool_name: 'Edit', tool_input: {} }).block, false, '대상이 없으면 볼 것이 없다');
  assert.strictEqual(hook('pre-tool-use', { cwd: temporary, tool_name: 'Edit', tool_input: { file_path: path.join(temporary, 'docs', 'a.md') } }).block, false, '코드가 아닌 경로는 막지 않는다');

  // ── post-tool-use ─────────────────────────────────────────────────────

  hook('session-start', { cwd: temporary, session_id: 'sess-3' });
  const ignored = hook('post-tool-use', { cwd: temporary, tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.strictEqual(ignored.record, null, '커밋이 아닌 호출에는 아무것도 적지 않는다');
  assert.strictEqual(ignored.block, false);

  const recorded = hook('post-tool-use', { cwd: temporary, session_id: 'sess-3', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  assert.ok(recorded.record, '커밋 뒤에는 결박 여부를 적는다');
  assert.strictEqual(recorded.record.binding, 'unbound', 'HEAD의 실제 결박 상태를 적는다 — 보고가 아니라 커밋이 답한다');
  assert.strictEqual(recorded.block, false, '계측은 막지 않는다');

  // ── post-tool-use: 저장 시점의 승인 낡음 신호 ──────────────────────────
  //
  // 저장 직후가 "승인 대비 바뀌었다"를 말할 수 있는 가장 이른 자리다. 감시는 다음 스캔까지
  // 기다리고 rdl doc status는 일부러 쳐야 보이므로, 그 사이에 승인 안 된 문서 위로 작업이
  // 계속 쌓인다.
  //
  // Workspace가 없는 저장소에서는 아무 말도 하지 않는다 — 판정하지 못하면 통과다.
  fs.writeFileSync(path.join(temporary, 'plain.md'), '---\nid: REQ-999\n---\n\n# 그냥 문서\n', 'utf8');
  const noWorkspace = hook('post-tool-use', { cwd: temporary, tool_name: 'Edit', tool_input: { file_path: path.join(temporary, 'plain.md') } });
  assert.deepStrictEqual(noWorkspace.context, [], 'Workspace를 찾지 못하면 판정하지 않는다');
  assert.strictEqual(noWorkspace.block, false);

  const cli = path.join(path.resolve(__dirname, '..'), 'bin', 'rdl.js');
  const rdl = (args) => {
    const result = spawnSync(process.execPath, [cli].concat(args, ['--root', workspace, '--json']), {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home })
    });
    assert.strictEqual(result.status, 0, `rdl ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout.trim());
  };

  git(['init', '-b', 'main', workspace], os.tmpdir());
  git(['config', 'user.email', 'hook@test.local'], workspace);
  git(['config', 'user.name', 'Hook Test'], workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# hook\n', 'utf8');
  git(['add', 'README.md'], workspace);
  git(['commit', '-m', 'initial'], workspace);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);
  // 승인은 활성 human Client만 지난다. 이 시험의 관심은 승인 그 자체가 아니라 승인된
  // 문서가 만드는 판정이므로, 자격을 갖춘 Client를 하나 두고 그것으로 승인한다.
  rdl(['client', 'register', 'desk-h', '--name', '검토자 데스크', '--type', 'human', '--owner', 'MEMBER-001']);

  const projectRoot = path.join(workspace, 'projects', 'crm');
  const created = rdl(['doc', 'create', 'ADR', '저장 시점 신호 검증', '--owner', 'MEMBER-001', '--scope', '저장 시점 낡음 신호 검증', '--exclude', '구현 절차', '--project', 'crm']);
  const documentFile = path.join(projectRoot, created.relativeFile.replace(/^projects\/crm\//u, ''));

  // 미승인은 신호가 아니다. 아직 아무도 근거로 삼지 않은 줄이고, 승인 축을 쓰지 않는
  // 프로젝트에서는 문서가 전건 미승인이라 저장할 때마다 같은 말이 나온다.
  const unapproved = hook('post-tool-use', { cwd: projectRoot, tool_name: 'Write', tool_input: { file_path: documentFile } });
  assert.deepStrictEqual(unapproved.context, [], '미승인은 사건이 아니라 줄이므로 저장 시점에 말하지 않는다');

  require('../src/approval').approveDocument(workspace, { project: 'crm', clientId: 'desk-h', targetId: created.id, approvedBy: 'MEMBER-001', basis: [{ kind: 'read' }] });
  assert.deepStrictEqual(hook('post-tool-use', { cwd: projectRoot, tool_name: 'Write', tool_input: { file_path: documentFile } }).context, [],
    '승인된 리비전을 그대로 저장하는 것은 사건이 아니다');

  // 한 글자만 고쳐도 승인이 낡는다. 그 사실이 저장하는 그 자리에서 나와야 한다.
  fs.appendFileSync(documentFile, '\n승인 이후 추가된 문장입니다.\n', 'utf8');
  const staleSave = hook('post-tool-use', { cwd: projectRoot, session_id: 'sess-4', tool_name: 'Edit', tool_input: { file_path: documentFile } });
  assert.strictEqual(staleSave.block, false, '알릴 뿐 막지 않는다');
  assert.ok(staleSave.context.some((line) => line.includes(created.id) && line.includes('검토 필요')), `승인 대비 바뀌었음을 말한다: ${JSON.stringify(staleSave.context)}`);
  assert.ok(staleSave.context.some((line) => line.includes('MEMBER-001')), '누가 승인했던 것인지를 싣는다');
  assert.ok(staleSave.context.some((line) => line.includes('--since-approval')), '무엇이 바뀌었는지 볼 방법을 함께 준다');

  // 판정은 approval.js가 한다 — 훅과 rdl doc status가 같은 문서에 같은 답을 내야 한다.
  const status = rdl(['doc', 'status', '--project', 'crm', '--status', 'stale']);
  assert.ok(status.documents.some((document) => document.id === created.id), '훅이 말한 낡음은 doc status의 낡음과 같은 것이다');

  // 문서가 아닌 저장과 문서를 쓰지 않는 도구는 이 판정을 지나지 않는다.
  assert.deepStrictEqual(hook('post-tool-use', { cwd: projectRoot, tool_name: 'Edit', tool_input: { file_path: path.join(projectRoot, 'tasks.json') } }).context, [], 'md가 아니면 볼 것이 없다');
  assert.deepStrictEqual(hook('post-tool-use', { cwd: projectRoot, tool_name: 'Read', tool_input: { file_path: documentFile } }).context, [], '읽기는 저장이 아니다');

  // ── post-tool-use: rdl이 소유한 state 칸을 손으로 고친 쓰기 ────────────
  //
  // 어휘 안의 값을 손으로 적으면 아무 진단도 나지 않는다(RDL-DOC-018은 어휘 밖만
  // 잡는다). 아무도 승인하지 않은 문서가 파일에서 승인됨을 주장하고 그것을 읽는
  // 화면이 전부 그 주장을 옮기는데, 그 사실을 말할 수 있는 자리는 이 저장뿐이다.
  const currentState = /^state:[^\S\r\n]*([^\r\n]*)$/mu.exec(fs.readFileSync(documentFile, 'utf8'))[1].trim();
  assert.strictEqual(currentState, 'approved', '승인 사건이 파일의 state 칸에 투영되어 있어야 이 시험이 성립한다');

  const handEdited = hook('post-tool-use', {
    cwd: projectRoot, tool_name: 'Edit',
    tool_input: { file_path: documentFile, old_string: 'state: draft', new_string: 'state: approved' }
  });
  assert.strictEqual(handEdited.block, false, '되돌아가는 칸이므로 막지 않는다');
  assert.ok(handEdited.context.some((line) => line.includes('state를 손으로 고쳤습니다') && line.includes('draft → approved')),
    `무엇을 무엇으로 갈았는지 말한다: ${JSON.stringify(handEdited.context)}`);
  assert.ok(handEdited.context.some((line) => line.includes('rdl doc submit')), '이 칸을 실제로 움직이는 명령을 함께 준다');
  assert.ok(handEdited.context.some((line) => line.includes('lifecycle')), '수명을 말하려던 것이면 어느 칸인지 알려 준다');

  // 값이 지금 frontmatter의 state와 다르면 본문에 우연히 걸린 줄이다. 말하지 않는다.
  const bodyLooksLikeState = hook('post-tool-use', {
    cwd: projectRoot, tool_name: 'Edit',
    tool_input: { file_path: documentFile, old_string: 'state: draft', new_string: 'state: proposed' }
  });
  assert.ok(!bodyLooksLikeState.context.some((line) => line.includes('손으로 고쳤습니다')),
    `지금 값과 묶이지 않는 매치는 오탐이므로 말하지 않는다: ${JSON.stringify(bodyLooksLikeState.context)}`);

  // 짝이 없는 쓰기는 판정하지 않는다. Write는 통째로 덮어 이전 내용이 페이로드에 없다.
  assert.ok(!hook('post-tool-use', { cwd: projectRoot, tool_name: 'Write', tool_input: { file_path: documentFile, content: 'state: approved' } })
    .context.some((line) => line.includes('손으로 고쳤습니다')), 'Write에는 견줄 이전 값이 없다');

  // state 줄을 지나지 않는 편집은 이 판정을 지나지 않는다.
  assert.ok(!hook('post-tool-use', { cwd: projectRoot, tool_name: 'Edit', tool_input: { file_path: documentFile, old_string: '# 저장', new_string: '# 저장 시점' } })
    .context.some((line) => line.includes('손으로 고쳤습니다')), 'state를 건드리지 않은 편집은 말할 것이 없다');

  // MultiEdit도 같은 판정을 지난다. 도구가 하나 늘 때 이 통제가 조용히 새면 안 된다.
  assert.ok(hook('post-tool-use', {
    cwd: projectRoot, tool_name: 'MultiEdit',
    tool_input: { file_path: documentFile, edits: [{ old_string: '# 저장', new_string: '# 저장 시점' }, { old_string: 'state: draft', new_string: 'state: approved' }] }
  }).context.some((line) => line.includes('손으로 고쳤습니다')), 'MultiEdit의 여러 쌍을 모두 본다');

  // rdl 자신의 투영은 이 갈래에 들어오지 않는다. 명령의 쓰기는 도구 이름이 Bash라
  // DOCUMENT_WRITE_TOOLS를 지나지 않으므로, 자기 명령마다 우는 일이 구조적으로 없다.
  assert.deepStrictEqual(hook('post-tool-use', { cwd: projectRoot, tool_name: 'Bash', tool_input: { command: 'rdl doc submit ADR-001' } }).context, [],
    'rdl의 쓰기는 문서 쓰기 도구를 지나지 않는다');

  // ── post-tool-use: 사람이 소유한 lifecycle 칸의 어휘 밖 값 ─────────────
  //
  // state와 심각도가 다르다. 아무것도 이 값을 굴리지 않아 오타가 스스로 낫지 않고,
  // rdl check가 RDL-DOC-017 오류로 막는다. 사람이 방금 친 자리에서 말해야 한다.
  const withLifecycle = fs.readFileSync(documentFile, 'utf8').replace(/^state:/mu, 'lifecycle: 채택됨\nstate:');
  fs.writeFileSync(documentFile, withLifecycle, 'utf8');
  const badLifecycle = hook('post-tool-use', { cwd: projectRoot, tool_name: 'Edit', tool_input: { file_path: documentFile } });
  assert.strictEqual(badLifecycle.block, false, '알릴 뿐 막지 않는다');
  assert.ok(badLifecycle.context.some((line) => line.includes('lifecycle') && line.includes('RDL-DOC-017')),
    `어휘 밖 수명 값을 그 자리에서 말한다: ${JSON.stringify(badLifecycle.context)}`);
  assert.ok(badLifecycle.context.some((line) => line.includes('superseded')), '가능한 값을 함께 싣는다');

  // 어휘 안의 값은 사건이 아니다. 정상 값에 매번 울면 그 신호는 꺼진 신호가 된다.
  fs.writeFileSync(documentFile, fs.readFileSync(documentFile, 'utf8').replace(/^lifecycle: .*$/mu, 'lifecycle: accepted'), 'utf8');
  assert.ok(!hook('post-tool-use', { cwd: projectRoot, tool_name: 'Edit', tool_input: { file_path: documentFile } })
    .context.some((line) => line.includes('RDL-DOC-017')), '어휘 안의 수명 값에는 말할 것이 없다');

  // ── session-end ───────────────────────────────────────────────────────

  const ended = hook('session-end', { cwd: temporary, session_id: 'sess-3' });
  assert.strictEqual(ended.block, false, '닫는 자리에서는 말만 한다');

  assert.strictEqual(base.length, 40);
  console.log('hook tests passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
