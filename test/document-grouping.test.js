'use strict';

// 문서 1개 = 기능 1개가 기본 계약이고, 합침은 --grouped --reason의 명시적
// opt-in이다. 그 허용 경로가 CLI로 열려 있는지 확인한다.
//
// 거부 경로만 시험하면 명령이 플래그를 파싱만 하고 호출에 넘기지 않아도 통과한다.
// 실제로 그랬다 — REQ는 선언이 있어도 다기능을 거부하므로 거부 시험은 버그와
// 무관하게 통과했고, TST·MOD·API의 다기능 선언은 CLI로 만들 방법이 없었다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-grouping-'));
const home = path.join(temporary, 'runtime');

function run(program, args) {
  const result = spawnSync(program, args, { cwd: temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(run(process.execPath, [cli].concat(args, ['--root', temporary, '--json'])));
}

function rdlRaw(args) {
  return spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
}

try {
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.name', 'Rundol Test']);
  run('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# grouping\n', 'utf8');
  run('git', ['add', 'README.md']);
  run('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);

  const anchor = rdl(['doc', 'create', 'ADR', '묶음 근거 결정', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '묶음 시험에 쓰는 결정', '--exclude', '그 밖']);
  // 하위 산출물이 참조하는 기능은 REQ에 원천이 있어야 한다(RDL-IMPL-011).
  const requirements = [['GRP-01', '하나'], ['GRP-02', '둘']].map(([functionId, label]) => rdl([
    'doc', 'create', 'REQ', `묶음 요구 ${label}`, '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', `기능 ${label}의 요구 하나`, '--exclude', '그 밖', '--related', anchor.id, '--function-id', functionId
  ]).id);

  // 허용 경로: TST는 선언으로 다기능이 허용된다.
  const grouped = rdl(['doc', 'create', 'TST', '묶음 검증', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '두 기능을 한 스위트가 같은 픽스처로 검증한다', '--exclude', '그 밖',
    '--related', requirements[0], '--related', requirements[1],
    '--function-id', 'GRP-01', '--function-id', 'GRP-02', '--grouped', '--reason', '같은 픽스처 흐름을 공유한다']);
  const source = fs.readFileSync(grouped.file, 'utf8');
  assert(/groupingReason: /u.test(source), `합침 사유가 frontmatter에 기록되어야 합니다: ${source.slice(0, 300)}`);
  assert(/GRP-01/u.test(source) && /GRP-02/u.test(source), '두 기능 ID가 모두 선언되어야 합니다.');
  assert(/groupingFunctions:/u.test(source), '합침 대상 기능이 기록되어야 합니다.');

  // 선언 없는 다기능은 거부된다 — 합침은 언제나 명시적 opt-in이다.
  const withoutDeclaration = rdlRaw(['doc', 'create', 'TST', '선언 없는 묶음', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '선언 없이 두 기능을 담는다', '--exclude', '그 밖',
    '--related', requirements[0], '--function-id', 'GRP-01', '--function-id', 'GRP-02']);
  assert.notStrictEqual(withoutDeclaration.status, 0, '선언 없는 다기능은 거부되어야 합니다.');
  assert(/--grouped/u.test(withoutDeclaration.stderr), withoutDeclaration.stderr);

  // 사유 없는 선언도 거부된다. 사유가 없으면 왜 묶였는지 나중에 알 수 없다.
  const withoutReason = rdlRaw(['doc', 'create', 'TST', '사유 없는 묶음', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '사유 없이 두 기능을 담는다', '--exclude', '그 밖',
    '--related', requirements[0], '--function-id', 'GRP-01', '--function-id', 'GRP-02', '--grouped']);
  assert.notStrictEqual(withoutReason.status, 0, '사유 없는 합침은 거부되어야 합니다.');

  // REQ는 선언이 있어도 다기능을 거부한다. 요구는 분리가 유일한 해소다.
  const groupedRequirement = rdlRaw(['doc', 'create', 'REQ', '묶인 요구', '--project', 'crm', '--owner', 'MEMBER-001',
    '--scope', '두 기능을 한 요구에 담는다', '--exclude', '그 밖', '--related', anchor.id,
    '--function-id', 'GRP-01', '--function-id', 'GRP-02', '--grouped', '--reason', '사유']);
  assert.notStrictEqual(groupedRequirement.status, 0, 'REQ의 다기능은 선언으로도 허용되지 않습니다.');

  process.stdout.write('document grouping tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
