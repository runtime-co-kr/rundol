'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const document = fs.readFileSync(path.join(root, 'docs', 'CLI.md'), 'utf8').replace(/\r\n/g, '\n');
const result = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(result.status, 0, result.stderr || result.stdout);

const help = result.stdout.replace(/\r\n/g, '\n');
const usageMatch = /Usage:\n([\s\S]*?)\n\nOptions:/.exec(help);
assert(usageMatch, 'rdl --help Usage 블록을 찾지 못했습니다.');
const documentedMatch = /<!-- rdl-help:start -->\n```text\n([\s\S]*?)\n```\n<!-- rdl-help:end -->/.exec(document);
assert(documentedMatch, 'docs/CLI.md 동기화 블록을 찾지 못했습니다.');

function normalize(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

assert(help.includes('rdl watch --project <key> [--remote] [--once] [--json]'));
assert(help.includes('rdl sync watch --client-id <id> [--interval <seconds>]'), 'sync watch must remain a distinct command');
// 필수 인자는 usage에 보여야 한다. sync와 sync watch는 --client-id 없이는 종료 코드
// 2로 거부하는데, 그것이 usage에 없으면 사람은 문서대로 쳐 보고 실패한 뒤에야
// 알게 되고 rdl help --json을 읽는 에이전트는 아예 알지 못한다.
for (const line of ['rdl sync --client-id <id>', 'rdl sync watch --client-id <id>']) {
  assert(help.includes(line), `필수 인자가 usage에 없습니다: ${line}`);
}
// 거부는 갓 만든 작업공간에서 잰다. 이 기계에 붙은 것에 기대면 개발자 기계에서만
// 통과하고, CI의 새 체크아웃에서는 작업공간을 못 찾아 다른 이유로 실패한다.
{
  const os = require('os');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-cli-doc-'));
  try {
    const env = Object.assign({}, process.env, { RUNDOL_HOME: path.join(temporary, 'runtime') });
    const setup = (program, args) => {
      const done = spawnSync(program, args, { cwd: temporary, encoding: 'utf8', env });
      assert.strictEqual(done.status, 0, `${program} ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
    };
    setup('git', ['init', '-b', 'main']);
    setup('git', ['config', 'user.name', 'Rundol Test']);
    setup('git', ['config', 'user.email', 'rundol@example.test']);
    fs.writeFileSync(path.join(temporary, 'README.md'), '# cli doc\n', 'utf8');
    setup('git', ['add', 'README.md']);
    setup('git', ['commit', '-m', 'initial']);
    setup(process.execPath, [cli, 'init', 'crm', '--name', 'CRM', '--profile', 'lean', '--root', temporary, '--json']);

    for (const args of [['sync', '--project', 'crm'], ['sync', 'watch', '--project', 'crm', '--once']]) {
      const refused = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary]), { cwd: root, encoding: 'utf8', env });
      assert.strictEqual(refused.status, 2, `--client-id 없이 성공했습니다: rdl ${args.join(' ')}\n${refused.stdout}${refused.stderr}`);
      assert(refused.stderr.includes('--client-id'), `거부 사유가 어느 인자인지 밝혀야 합니다: ${refused.stderr}`);
    }

    // ── rdl doc review ────────────────────────────────────────────────────
    //
    // 검토 리포트는 판정을 새로 짓지 않고 doc status·doc diff가 낸 답을 모으는
    // 산출물이다. 그래서 시험은 출력 모양보다 먼저 그 계약을 본다.
    const rdlJson = (args) => {
      const done = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: root, encoding: 'utf8', env });
      assert.strictEqual(done.status, 0, `rdl ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
      return JSON.parse(done.stdout);
    };
    const rdlText = (args) => {
      const done = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary]), { cwd: root, encoding: 'utf8', env });
      assert.strictEqual(done.status, 0, `rdl ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
      return done.stdout;
    };
    const projectRoot = path.join(temporary, 'projects', 'crm');
    const git = (args) => {
      const done = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', env });
      assert.strictEqual(done.status, 0, `git ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
    };

    rdlJson(['client', 'register', 'agent-a', '--name', 'Agent A', '--type', 'agent', '--owner', 'MEMBER-001']);
    // 승인은 활성 human Client만 지난다. 이 시험이 에이전트 Client로 승인하고 통과하던
    // 것은 게이트가 옳았다는 뜻이 아니라 게이트가 없었다는 뜻이다 — 문서 승인만 유형을
    // 보지 않아, 에이전트가 자기가 쓴 초안을 스스로 정본으로 만들 수 있었다.
    rdlJson(['client', 'register', 'desk-h', '--name', '검토자 데스크', '--type', 'human', '--owner', 'MEMBER-001']);
    const staleDocument = rdlJson(['doc', 'create', 'ADR', '낡을 결정', '--owner', 'MEMBER-001', '--scope', '승인 뒤에 바뀔 결정', '--exclude', '구현 절차', '--project', 'crm']);
    const freshDocument = rdlJson(['doc', 'create', 'ADR', '미승인 결정', '--owner', 'MEMBER-001', '--scope', '승인 기록이 없는 결정', '--exclude', '구현 절차', '--project', 'crm']);
    // 승인된 리비전을 담은 커밋이 실제로 있어야 차분에 기준이 생긴다.
    git(['add', '-A']);
    git(['commit', '-m', 'add documents']);
    // 에이전트 Client는 명령줄에서도 지나지 못한다. 제출은 그대로 열려 있다 —
    // 에이전트가 쓰고 사람이 책임지는 것이 이 도구의 협업 모형이고, 제출까지 막으면
    // 관문이 아니라 병목이 된다.
    const refusedApproval = spawnSync(process.execPath,
      [cli, 'doc', 'approve', staleDocument.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'agent-a', '--project', 'crm', '--root', temporary],
      { cwd: root, encoding: 'utf8', env });
    assert.notStrictEqual(refusedApproval.status, 0, `에이전트 Client의 문서 승인은 거절되어야 합니다: ${refusedApproval.stdout}`);
    assert(/활성 human Client만 승인할 수 있습니다/u.test(refusedApproval.stderr),
      `거절 사유가 그대로 나와야 합니다: ${refusedApproval.stderr}`);
    assert.strictEqual(rdlJson(['doc', 'submit', staleDocument.id, '--client-id', 'agent-a', '--project', 'crm']).created, true,
      '제출은 에이전트 Client도 할 수 있어야 합니다.');
    rdlJson(['doc', 'approve', staleDocument.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--reason', '결정 범위를 확인함', '--project', 'crm']);
    fs.appendFileSync(path.join(temporary, staleDocument.relativeFile), '\n승인 이후 추가된 문장입니다.\n', 'utf8');

    const report = rdlJson(['doc', 'review', '--project', 'crm']);
    // 셈은 걸러진 목록이 아니라 전체를 센다. 걸러 세면 "미승인 19건 중 19건"이 되어
    // 전체 대비 얼마나 밀렸는지가 사라진다.
    assert.strictEqual(report.counts.stale, 1);
    assert(report.counts.unapproved >= 1);
    assert.strictEqual(report.total, (report.counts.approved || 0) + (report.counts.stale || 0) + (report.counts.unapproved || 0));
    assert.strictEqual(report.pending, report.stale.length + report.unapproved.length);

    const staleEntry = report.stale.find((entry) => entry.id === staleDocument.id);
    assert(staleEntry, '낡은 문서가 검토 목록에 있어야 합니다.');
    // 승인자와 사유는 원장이 가진 값을 그대로 싣는다 — 여기서 지어내면 doc history와 갈린다.
    assert.strictEqual(staleEntry.approvedBy, 'MEMBER-001');
    assert.strictEqual(staleEntry.lastApproval.reason, '결정 범위를 확인함');
    assert.deepStrictEqual(staleEntry.lastApproval.basis, [{ kind: 'read' }]);
    assert.strictEqual(staleEntry.diff.available, true);
    assert(staleEntry.diff.baseCommit, '낡은 문서에는 승인 리비전을 담은 기준 커밋이 있어야 합니다.');
    assert(staleEntry.diff.added >= 1, '승인 이후 늘어난 줄이 세어져야 합니다.');
    // 기본 출력에 패치 본문은 없다. 29건의 전체 패치를 기본으로 뱉으면 한눈에
    // 훑으라고 만든 산출물이 다시 안 읽히는 길이가 된다.
    assert.strictEqual(staleEntry.diff.text, null);

    // 미승인 문서에는 비교 기준이 없다. 빈 diff와 같은 값으로 접으면 읽는 사람은
    // 미승인 문서를 이미 검토를 마친 것으로 본다 — 이 명령이 없애려던 착각이다.
    const freshEntry = report.unapproved.find((entry) => entry.id === freshDocument.id);
    assert(freshEntry, '미승인 문서가 검토 목록에 있어야 합니다.');
    assert.strictEqual(freshEntry.diff.available, false, '미승인 문서에는 비교 기준이 없어야 합니다.');
    assert.strictEqual(freshEntry.diff.added, null, '기준이 없으면 바뀐 줄 수는 0이 아니라 없음입니다.');
    assert.strictEqual(freshEntry.diff.text, null);
    assert(/비교 기준/u.test(freshEntry.diff.reason), `비교 기준이 없다는 사실을 문장으로 남겨야 합니다: ${freshEntry.diff.reason}`);
    assert.strictEqual(freshEntry.lastApproval, null);

    // 기본 출력은 사람이 읽는 마크다운이다. printOperation은 중첩 객체를 건너뛰므로
    // 그대로 쓰면 문서마다의 승인자·사유·차분이 통째로 사라진다.
    const markdown = rdlText(['doc', 'review', '--project', 'crm']);
    assert(markdown.startsWith('# 검토 리포트 — crm'), `기본 출력이 마크다운이어야 합니다: ${markdown.slice(0, 80)}`);
    assert(markdown.includes(`### ${staleDocument.id}`));
    assert(markdown.includes('결정 범위를 확인함'));
    assert(markdown.includes('비교 기준 없음'), '미승인 문서는 마크다운에서도 기준 없음으로 드러나야 합니다.');
    assert(!markdown.includes('```diff'), '패치 본문은 --diff를 줬을 때만 실립니다.');

    const detailed = rdlText(['doc', 'review', '--project', 'crm', '--diff', '--status', 'stale']);
    assert(detailed.includes('```diff'), '--diff는 패치 본문을 실어야 합니다.');
    assert(detailed.includes('승인 이후 추가된 문장입니다.'));
    assert(!detailed.includes(`### ${freshDocument.id}`), '--status stale은 미승인 목록을 빼야 합니다.');

    // --write는 Vault의 파생 뷰 자리에 내보낸다. 그때 같은 내용을 화면에도 쏟으면
    // 어디에 놓였는지가 그 안에 묻힌다.
    const written = rdlText(['doc', 'review', '--project', 'crm', '--write']);
    assert(written.includes('projects/crm/views/review.md'), `쓴 자리를 말해야 합니다: ${written}`);
    assert(!written.includes('```diff'));
    assert(fs.readFileSync(path.join(projectRoot, 'views', 'review.md'), 'utf8').includes('generated: review-v1'));

    // 차분 상한. 상한에 걸린 문서도 목록에는 남는다 — 목록에서까지 빼면 남은
    // 목록이 완전한 것처럼 보이고, 그것이 이 리포트가 없애려던 착각이다. 그리고
    // "계산하지 않았다"는 "비교 기준이 없다"와 다른 말로 적어야 한다.
    const second = rdlJson(['doc', 'create', 'ADR', '또 낡을 결정', '--owner', 'MEMBER-001', '--scope', '두 번째로 낡게 만들 결정', '--exclude', '구현 절차', '--project', 'crm']);
    git(['add', '-A']);
    git(['commit', '-m', 'add second document']);
    rdlJson(['doc', 'approve', second.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'crm']);
    fs.appendFileSync(path.join(temporary, second.relativeFile), '\n또 바뀐 문장입니다.\n', 'utf8');

    const limited = rdlJson(['doc', 'review', '--project', 'crm', '--max-items', '1']);
    assert.strictEqual(limited.diffLimit, 1);
    assert.strictEqual(limited.truncated, true);
    assert.strictEqual(limited.stale.length, 2, '상한을 넘긴 문서도 목록에는 남아야 합니다.');
    assert.strictEqual(limited.stale.filter((entry) => entry.diff.computed).length, 1);
    const skipped = limited.stale.find((entry) => entry.diff.computed === false);
    assert.strictEqual(skipped.diff.available, null, '계산하지 않은 것은 기준이 없는 것과 다릅니다.');
    assert(/상한/u.test(skipped.diff.reason));
    const limitedMarkdown = rdlText(['doc', 'review', '--project', 'crm', '--max-items', '1']);
    assert(limitedMarkdown.includes('차분 미계산'), '계산하지 않은 문서는 기준 없음과 다른 문장으로 적어야 합니다.');

    // 이관은 문서 내용을 바꾸므로 그 문서에 걸린 승인이 낡는다. 승인 45건이 걸린
    // 저장소에서 사람이 그것을 다시 눌러야 하므로, --apply를 치기 전에 계획이
    // **어느 문서인지**를 말해야 한다 — 건수만으로는 "지금 다시 승인할 수 있나"를
    // 판단할 수 없다.
    {
      const live = rdlJson(['doc', 'create', 'ADR', '수명을 적은 결정', '--owner', 'MEMBER-001', '--scope', '수명 칸이 아직 state에 있는 결정', '--exclude', '구현 절차', '--project', 'crm']);
      git(['add', '-A']);
      git(['commit', '-m', 'add lifecycle document']);
      rdlJson(['doc', 'approve', live.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--project', 'crm']);
      // 승인 뒤에 state만 수명 값으로 바꾼다. state는 REVISION_OWNED_FIELDS라 판 2
      // 리비전이 움직이지 않으므로 이 문서의 승인은 그대로 살아 있다 — 이관 전의
      // 정본이 실제로 이 모양이었다(원장은 승인이라 하고 파일은 accepted라 적었다).
      const file = path.join(temporary, live.relativeFile);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^state:[ \t]*.*?(\r?)$/mu, (whole, eol) => `state: accepted${eol}`), 'utf8');
      assert.strictEqual(rdlJson(['doc', 'status', '--project', 'crm']).documents.find((item) => item.id === live.id).status, 'approved',
        'state만 바꾼 것으로 승인이 낡으면 안 됩니다. 그 칸은 rdl이 소유하므로 리비전에서 빠집니다.');

      const plan = rdlJson(['doc', 'migrate', '--project', 'crm']);
      assert.strictEqual(plan.applied, false, '계획은 파일에 닿지 않습니다.');
      assert(plan.fields.some((item) => item.id === live.id && item.lifecycle === 'accepted' && item.state === 'draft'));
      assert.deepStrictEqual(plan.approvalsAtRisk.map((item) => item.id), [live.id],
        '승인이 살아 있는 문서만 위험 목록에 오릅니다. 이미 낡은 것은 잃을 것이 없습니다.');
      assert.strictEqual(plan.approvalsAtRisk[0].approvedBy, 'MEMBER-001');
      assert(/승인 1건이 낡습니다/u.test(plan.approvalNote), plan.approvalNote);
      // 사람이 읽는 출력에도 그대로 나와야 한다. --json만 알면 명령을 치는 사람은
      // 무엇을 잃는지 모른 채 --apply를 친다.
      const spoken = rdlText(['doc', 'migrate', '--project', 'crm']);
      assert(spoken.includes('approvalNote:') && spoken.includes(live.id), spoken);
    }

    // ── rdl doc lifecycle ─────────────────────────────────────────────────
    //
    // 수명은 사람이 소유한 축인데 옮기는 길이 하나도 없었다. 명령도 화면도 없어서
    // 「이 결정은 대체됐다」를 말하는 유일한 길이 frontmatter를 손으로 고치는 것이었고,
    // 그래서 **왜** 대체했는지가 어디에도 남지 않았다(ADR-026의 실측).
    //
    // 시험이 보는 것은 값이 옮겨졌는가가 아니라 그 셋이다 — 사유가 남았는가, 낡을
    // 승인을 누르기 전에 이름으로 말했는가, 지우는 길이 고르는 길과 나란한가.
    {
      const target = rdlJson(['doc', 'create', 'ADR', '대체될 결정', '--owner', 'MEMBER-001', '--scope', '수명 축을 재는 결정', '--exclude', '구현 절차', '--project', 'crm']);
      git(['add', '-A']);
      git(['commit', '-m', 'add lifecycle target']);
      const file = path.join(temporary, target.relativeFile);
      const axis = (key) => (new RegExp(`^${key}:[ \\t]*(.*)$`, 'mu').exec(fs.readFileSync(file, 'utf8')) || [])[1] || null;
      const trust = () => rdlJson(['doc', 'status', '--project', 'crm']).documents.find((item) => item.id === target.id);
      const lastCommit = () => {
        const done = spawnSync('git', ['log', '-1', '--pretty=%B'], { cwd: projectRoot, encoding: 'utf8', env });
        assert.strictEqual(done.status, 0, done.stderr);
        return done.stdout;
      };

      assert.strictEqual(axis('lifecycle'), null, '만든 문서는 수명을 말하지 않습니다. 비어 있는 것과 active는 다릅니다.');
      const first = rdlJson(['doc', 'lifecycle', target.id, 'accepted', '--reason', '이 결정이 채택되어 섰다', '--project', 'crm']);
      assert.strictEqual(first.applied, true);
      assert.strictEqual(first.from, null);
      assert.strictEqual(first.to, 'accepted');
      assert.strictEqual(axis('lifecycle'), 'accepted');
      // state는 건드리지 않는다. 그 칸은 rdl이 원장에서 투영하는 자리이고 수명은 다른 축이다.
      assert.strictEqual(axis('state'), 'draft', '수명을 옮기는 명령이 state를 건드리면 안 됩니다.');
      // 사유는 커밋 메시지가 나른다. 수명 값이 내용 안에 있어 그 값이 바뀐 커밋이 곧
      // 그 전환의 주소이고, 주소와 사유가 같은 자리에 선다.
      assert(lastCommit().includes('이 결정이 채택되어 섰다'), `사유가 커밋에 남아야 합니다: ${lastCommit()}`);
      assert(lastCommit().includes(`Rundol-Lifecycle: ${target.id} none -> accepted`), lastCommit());

      // 승인이 서면 수명을 옮기는 값이 달라진다. 이 변경은 그 승인을 쓰는 일이다.
      rdlJson(['doc', 'submit', target.id, '--client-id', 'agent-a', '--project', 'crm']);
      rdlJson(['doc', 'approve', target.id, '--member', 'MEMBER-001', '--basis', 'read', '--client-id', 'desk-h', '--reason', '범위를 확인함', '--project', 'crm']);
      assert.strictEqual(trust().status, 'approved');

      // 계획은 파일에 닿지 않는다. 그리고 건수가 아니라 **누구의** 승인인지를 말한다 —
      // 이름 없이는 "그것을 지금 다시 승인할 수 있나"를 판단할 수 없다.
      const plan = rdlJson(['doc', 'lifecycle', target.id, 'superseded', '--reason', 'ADR-026이 대체함', '--plan', '--project', 'crm']);
      assert.strictEqual(plan.applied, false);
      assert.deepStrictEqual(plan.approvalsAtRisk.map((item) => [item.id, item.approvedBy]), [[target.id, 'MEMBER-001']]);
      assert(/승인 1건이 낡습니다/u.test(plan.approvalNote), plan.approvalNote);
      assert.strictEqual(axis('lifecycle'), 'accepted', '계획이 파일을 고치면 안 됩니다.');

      // 확인 없이는 거절한다. 관문이 아니라 "누르기 전에 말하는" 자리이므로 거절
      // 문장이 누구의 승인이 낡는지를 담고, 거절 뒤 파일과 신뢰 상태는 그대로다.
      const refused = spawnSync(process.execPath,
        [cli, 'doc', 'lifecycle', target.id, 'superseded', '--reason', 'ADR-026이 대체함', '--project', 'crm', '--root', temporary],
        { cwd: root, encoding: 'utf8', env });
      assert.notStrictEqual(refused.status, 0, `살아 있는 승인이 걸린 수명 변경은 확인 없이 지나면 안 됩니다: ${refused.stdout}`);
      assert(refused.stderr.includes('MEMBER-001'), `누구의 승인이 낡는지 말해야 합니다: ${refused.stderr}`);
      assert(refused.stderr.includes('--ack-stale'), `빠져나갈 길을 말해야 합니다: ${refused.stderr}`);
      assert.strictEqual(axis('lifecycle'), 'accepted');
      assert.strictEqual(trust().status, 'approved');

      // 알고 바꾸면 지나간다. 그리고 실제로 낡는다 — 이것은 결함이 아니라 축이다.
      const moved = rdlJson(['doc', 'lifecycle', target.id, 'superseded', '--reason', 'ADR-026이 이 결정을 대체함', '--ack-stale', '--project', 'crm']);
      assert.strictEqual(moved.applied, true);
      assert.strictEqual(axis('lifecycle'), 'superseded');
      assert.strictEqual(trust().status, 'stale', '수명이 리비전 해시 안에 있으므로 승인이 낡아야 합니다.');
      assert(lastCommit().includes('ADR-026이 이 결정을 대체함'), lastCommit());

      // 지우는 길이 고르는 길과 나란히 있다.
      const cleared = rdlJson(['doc', 'lifecycle', target.id, '--clear', '--reason', '수명을 말할 것이 없는 문서였다', '--ack-stale', '--project', 'crm']);
      assert.strictEqual(cleared.to, null);
      assert.strictEqual(cleared.applied, true);
      assert.strictEqual(axis('lifecycle'), null);
      // 같은 값을 다시 적으면 쓰지도 커밋하지도 않는다. 빈 커밋은 이력을 흐린다.
      const again = rdlJson(['doc', 'lifecycle', target.id, '--clear', '--reason', '한 번 더', '--project', 'crm']);
      assert.strictEqual(again.changed, false);
      assert.strictEqual(again.applied, false);
      assert.strictEqual(again.commit, null);

      // 어휘 밖 값·사유 없음·두 갈래 동시 지정·없는 문서는 전부 거절한다.
      for (const args of [
        ['doc', 'lifecycle', target.id, 'retired', '--reason', 'x', '--project', 'crm'],
        ['doc', 'lifecycle', target.id, 'accepted', '--project', 'crm'],
        ['doc', 'lifecycle', target.id, 'accepted', '--clear', '--reason', 'x', '--project', 'crm'],
        ['doc', 'lifecycle', 'ADR-999', 'accepted', '--reason', 'x', '--project', 'crm'],
        ['doc', 'lifecycle', '--reason', 'x', '--project', 'crm']
      ]) {
        const denied = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary]), { cwd: root, encoding: 'utf8', env });
        assert.strictEqual(denied.status, 2, `거부해야 합니다: rdl ${args.join(' ')}\n${denied.stdout}${denied.stderr}`);
      }
      // 사람 게이트를 걸지 않는다. 이 축을 입력으로 읽는 판정이 하나도 없고 칸 자체가
      // frontmatter 한 줄이라, 명령에만 관문을 세우면 옆에 열린 문을 둔 울타리가 된다.
      // 그래서 이 명령은 --client-id를 아예 받지 않는다 — 자격을 묻는 척도 하지 않는다.
      assert(!help.includes('rdl doc lifecycle') || !/rdl doc lifecycle[^\n]*--client-id/u.test(help),
        '수명 명령이 사람 자격을 묻는 것처럼 보이면 안 됩니다.');
    }

    for (const args of [['doc', 'review', '--project', 'crm', '--status', 'approved'], ['doc', 'review', '--project', 'crm', 'ADR-001'], ['doc', 'review', '--project', 'crm', '--max-items', '0']]) {
      const refused = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary]), { cwd: root, encoding: 'utf8', env });
      assert.strictEqual(refused.status, 2, `거부해야 합니다: rdl ${args.join(' ')}\n${refused.stdout}${refused.stderr}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// 사람 표면과 고급 표면은 다른 대상을 위한 목록이다. 실행 식별자·임대·어댑터가
// 드러나는 명령군은 사람 표면에서 내렸고, 내린 것이 실제로 내려갔는지와 여전히
// 발견 가능한지를 함께 확인한다. 은닉이 삭제로 번지면 기존 자동화가 조용히 깨진다.
const advancedResult = spawnSync(process.execPath, [cli, 'advanced'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(advancedResult.status, 0, advancedResult.stderr);
const advanced = advancedResult.stdout.replace(/\r\n/g, '\n');
const advancedUsage = /Usage:\n([\s\S]*?)\n\nOptions:/.exec(advanced);
assert(advancedUsage, 'rdl advanced Usage 블록을 찾지 못했습니다.');
const advancedDocumented = /<!-- rdl-advanced:start -->\n```text\n([\s\S]*?)\n```\n<!-- rdl-advanced:end -->/.exec(document);
assert(advancedDocumented, 'docs/CLI.md 고급 명령 동기화 블록을 찾지 못했습니다.');

for (const hidden of ['rdl run ', 'rdl adapter ', 'rdl verify ', 'rdl decision request', 'rdl decision kinds', 'rdl delegation ', 'rdl client ', 'rdl action ', 'rdl debug ', 'rdl workset ', 'rdl assignment ']) {
  assert(!help.includes(`  ${hidden}`), `사람 표면에 내부 개념 명령이 남았습니다: ${hidden.trim()}`);
  assert(advanced.includes(`  ${hidden}`), `고급 표면에서 사라졌습니다: ${hidden.trim()}`);
}
// 결정 명령군은 반이 갈린다. 정책 저장 게이트가 "계약 변경 결정이 필요하다"며 저장을
// 거절하는데 그 결정을 보고 답하는 명령이 사람 표면에 없으면, 막힌 사람은 rdl help를
// 봐도 빠져나갈 길이 없다 — 게이트가 탈출구 없는 문이 된다.
for (const shown of ['rdl decision list ', 'rdl decision answer ']) {
  assert(help.includes(`  ${shown}`), `사람이 답해야 하는 명령이 사람 표면에 없습니다: ${shown.trim()}`);
  assert(!advanced.includes(`  ${shown}`), `한 명령이 두 표면에 실리면 어느 쪽이 정본인지 물을 자리가 없습니다: ${shown.trim()}`);
}
// dispatch가 받는데 usage 어디에도 없던 자리. usage가 정본이므로 여기 없으면 그
// 명령은 도움말에도 docs/CLI.md에도 없고, 오직 오류 문구에만 존재한다.
assert(help.includes('rdl contract migrate --project <key> [--write] [--json]'), 'contract migrate가 usage에 없습니다.');
assert(advanced.includes('rdl run drive --run <RUN-ID> --project <key> --client-id <id> [--scheduled]'));
assert(advanced.includes('rdl run operation resolve --run <RUN-ID> --project <key> --operation <operation-id>'));

// 에이전트 발견 표면은 둘을 합쳐 받는다. 사람에게 숨기는 것과 에이전트에게 숨기는
// 것은 다른 판단이며, 여기서 숨기면 에이전트가 다시 소스를 뒤진다.
const catalogResult = spawnSync(process.execPath, [cli, 'help', '--json'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(catalogResult.status, 0, catalogResult.stderr);
const catalog = JSON.parse(catalogResult.stdout);
assert(catalog.commands.some((item) => /^rdl run /.test(item.synopsis)), 'help --json에 고급 명령이 빠졌습니다.');
assert(catalog.commands.some((item) => /^rdl adapter /.test(item.synopsis)), 'help --json에 고급 명령이 빠졌습니다.');

// 폐기한 명령은 두 표면 어디에도 없어야 한다. 다만 부르면 왜 없어졌는지 알려야
// 한다 — 조용히 "알 수 없는 명령"으로 끝나면 사람은 오타를 의심하지 손을 뗄 근거를
// 찾지 못한다.
assert(!help.includes('rdl lease '), '폐기한 명령이 사람 표면에 남았습니다.');
assert(!advanced.includes('rdl lease '), '폐기한 명령이 고급 표면에 남았습니다.');
const retired = spawnSync(process.execPath, [cli, 'lease', 'list'], { cwd: root, encoding: 'utf8' });
assert.notStrictEqual(retired.status, 0, '폐기한 명령이 성공하면 안 됩니다.');
assert(retired.stderr.includes('ADR-015'), '폐기 안내가 근거 문서를 가리켜야 합니다.');

assert.strictEqual(normalize(advancedDocumented[1]), normalize(advancedUsage[1]), 'docs/CLI.md 고급 명령 요약이 rdl advanced와 다릅니다.');
const namedWatchRemote = spawnSync(process.execPath, [cli, 'watch', '--project', 'sample', '--remote', 'origin', '--once'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(namedWatchRemote.status, 2, 'watch --remote must be an exact boolean surface, not a remote-name option');
assert(namedWatchRemote.stderr.includes('origin'));

assert.strictEqual(normalize(documentedMatch[1]), normalize(usageMatch[1]), 'docs/CLI.md 명령 요약이 rdl --help와 다릅니다.');
for (const stale of ['Workspace v2', 'projects/tasks.json', 'refs/heads/rundol/workspace', '.rundol/pending/merge-conflicts.json', '.rundol/index/<project>']) {
  assert(!document.includes(stale), `docs/CLI.md에 이전 구조 표현이 남았습니다: ${stale}`);
}
assert(document.includes('projects/<project-key>/.rundol/state/pending/merge-conflicts.json'));

// ── --json은 실패에도 적용된다 ──────────────────────────────────────────────
//
// 성공만 JSON이면 부르는 쪽은 파서를 두 벌 든다. 그중 하나는 사람이 읽으라고 쓴 문장을
// 기계가 뜯는 쪽이고, 그 파서는 문구를 다듬을 때마다 조용히 깨진다.
{
  const plain = spawnSync(process.execPath, [cli, 'task', 'bogus-subcommand'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(plain.status, 2);
  assert(plain.stderr.startsWith('rdl: '), '--json이 없으면 사람이 읽는 한 줄 그대로다.');

  const structured = spawnSync(process.execPath, [cli, 'task', 'bogus-subcommand', '--json'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(structured.status, 2);
  // 자리는 stderr 그대로다. 결과는 stdout, 진단은 stderr라는 갈라섬은 --json이 바꿀
  // 축이 아니고, 옮기면 성공 출력을 읽던 파이프가 실패 때 오류를 결과로 받는다.
  assert.strictEqual(structured.stdout, '', '오류는 결과 자리로 나오지 않는다.');
  const parsed = JSON.parse(structured.stderr);
  assert.strictEqual(typeof parsed.error.message, 'string');
  assert.strictEqual(parsed.error.message, plain.stderr.replace(/^rdl: /u, '').trim(), '두 표면이 같은 문장을 말한다.');
  // 코드는 지어내지 않는다. 문장 안에 선 RDL 코드가 있으면 그것이고, 없으면 null이다 —
  // 없는 코드를 만들어 실으면 부르는 쪽은 그 값으로 분기하다 코드가 생기는 날 갈린다.
  assert.strictEqual(parsed.error.code, null, '코드가 없는 오류는 null로 답한다.');
}
process.stdout.write('CLI document tests passed\n');
