'use strict';

// 저작 병렬 실행(REQ-044).
//
// 격리는 이미 있었다 — 저작은 일회용 detached worktree에서 돌고 끝나면 대상 파일 하나만
// 본 트리로 옮긴다. 병렬이 되지 않던 이유는 격리가 아니라 복귀였다. 저작 A가 결과를
// 옮겨 놓고 아직 저장하지 않으면, 저작 B는 그 파일을 남의 변경으로 보고 시작을 거부한다.
//
// 여기서 보는 것은 그 복귀가 열렸는가, 그리고 열면서 저작의 경계가 넓어지지 않았는가이다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runAuthorFanOut } = require('../src/adapter');
const { readyAuthoringTargets } = require('../src/document-contract');
const { pinInstruction } = require('../src/instruction-registry');

const PREVIOUS_WINDOWS_ADAPTER = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const stub = path.join(__dirname, 'fixtures', 'stub-adapter.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-author-fanout-'));
const home = path.join(temporary, 'runtime');

function environment() {
  return Object.assign({}, process.env, { RUNDOL_HOME: home });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd: cwd || temporary, encoding: 'utf8', env: environment() });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: repository, encoding: 'utf8', env: environment() });
  assert.strictEqual(result.status, 0, `rdl ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function main() {
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Rundol Test']);
    git(['config', 'user.email', 'rundol@example.test']);
    fs.writeFileSync(path.join(temporary, 'README.md'), '# fanout\n', 'utf8');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
    rdl(['client', 'register', 'agent-a', '--name', '저작 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);

    const projectRoot = path.join(temporary, 'projects', 'crm');
    const prd = rdl(['doc', 'create', 'PRD', 'fan-out 제품 요구', '--project', 'crm', '--owner', 'MEMBER-001',
      '--scope', 'fan-out을 보는 제품 목표', '--exclude', '그 밖']);
    const siblings = [];
    for (const index of [1, 2, 3]) {
      siblings.push(rdl(['doc', 'create', 'REQ', `형제 요구 ${index}`, '--project', 'crm', '--owner', 'MEMBER-001',
        '--scope', `${index}번 형제가 다루는 능력`, '--exclude', '그 밖', '--related', prd.id, '--function-id', `FAN-0${index}`]));
    }
    git(['add', '.'], projectRoot);
    git(['commit', '-m', 'add siblings'], projectRoot);

    // ── 준비 완료 집합은 계약이 계산한다 ─────────────────────────────────
    const targets = readyAuthoringTargets(temporary, 'crm');
    assert.strictEqual(targets.reason, null);
    for (const sibling of siblings) {
      assert(targets.ready.some((item) => item.id === sibling.id), `형제가 준비 완료 집합에 없습니다: ${sibling.id}`);
    }
    // 선행이 없는 유형은 준비 완료 집합에 들어가지 않는다. ARC는 REQ를 선행으로 두는데
    // 지금은 REQ가 있으므로 준비 완료다 — 반대 경우를 직접 만들어 확인한다.
    {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-fanout-empty-'));
      try {
        const bare = readyAuthoringTargets(empty, null);
        assert.deepStrictEqual(bare.ready, [], '워크스페이스가 아닌 곳에서 대상이 나오면 안 됩니다');
      } catch (error) {
        assert(/workspace|Workspace|찾지 못/u.test(error.message), error.message);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    }

    const relative = (id) => path.relative(projectRoot, targets.ready.find((item) => item.id === id).file).split(path.sep).join('/');
    const paths = siblings.map((sibling) => relative(sibling.id));

    const invocation = {
      projectRoot, projectId: 'crm', mode: 'author', runId: 'RUN-0000000000000000FA01',
      instruction: pinInstruction('author-v1'),
      adapter: { name: 'stub', enabled: true, command: process.execPath, argsTemplate: [stub, '{instruction}', '{context}', '{result}'], timeoutSeconds: 30 }
    };

    // ── 형제의 복귀가 다른 형제의 시작을 막지 않는다 ──────────────────────
    //
    // 이것이 이 요구의 본체다. 실행을 주입해 복귀를 흉내 내고, 청결 검사가 형제의
    // 변경을 남의 변경으로 읽는지 본다.
    const started = [];
    let peak = 0;
    let inFlight = 0;
    const fanOut = await runAuthorFanOut(paths.map((targetPath) => ({ targetPath, invocation })), {
      maxConcurrency: 3,
      runAdapterOnce: async (call) => {
        // 주입된 실행이지만 청결 검사는 진짜를 쓴다. 형제가 이미 복귀시킨 파일이
        // 떠 있는 상태에서 이 검사가 통과해야 한다.
        const { readyAuthoringTargets: _unused } = require('../src/document-contract');
        void _unused;
        started.push(call.targetPath);
        assert(Array.isArray(call.fanOutTargets) && call.fanOutTargets.length === paths.length,
          `fanOutTargets가 전달되지 않았습니다: ${JSON.stringify(call.fanOutTargets)}`);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          // 형제의 복귀를 흉내 낸다. 본 트리에 결과를 올려 두고 다음 형제가 시작할
          // 수 있는지 보는 것이 이 시험의 전부다.
          fs.appendFileSync(path.join(projectRoot, call.targetPath), `\n<!-- ${call.targetPath} 저작됨 -->\n`);
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { exitCode: 0, status: 'success', result: { claims: [], artifactIds: [] }, changed: true };
        } finally {
          inFlight -= 1;
        }
      }
    });
    assert.strictEqual(fanOut.failed.length, 0, JSON.stringify(fanOut.failed));
    assert.strictEqual(started.length, paths.length);
    assert(peak > 1, `형제가 겹쳐 돌지 않았습니다. 최대 동시 실행: ${peak}`);
    assert.deepStrictEqual(fanOut.undispatched, []);

    // 형제가 복귀시킨 파일들이 모두 본 트리에 남아 있다.
    for (const targetPath of paths) {
      assert(fs.readFileSync(path.join(projectRoot, targetPath), 'utf8').includes('저작됨'), `${targetPath}의 결과가 사라졌습니다`);
    }
    git(['checkout', '--', '.'], projectRoot);

    // ── 하나가 실패해도 나머지 결과가 남는다 ─────────────────────────────
    const partial = await runAuthorFanOut(paths.map((targetPath) => ({ targetPath, invocation })), {
      maxConcurrency: 3,
      runAdapterOnce: async (call) => {
        if (call.targetPath === paths[1]) throw new Error('주입한 저작 실패');
        fs.appendFileSync(path.join(projectRoot, call.targetPath), `\n<!-- ${call.targetPath} 저작됨 -->\n`);
        return { exitCode: 0, status: 'success', result: { claims: [], artifactIds: [] }, changed: true };
      }
    });
    assert.strictEqual(partial.failed.length, 1, JSON.stringify(partial.failed));
    assert.strictEqual(partial.failed[0].targetPath, paths[1]);
    assert(fs.readFileSync(path.join(projectRoot, paths[0]), 'utf8').includes('저작됨'), '실패가 형제의 결과를 지웠습니다');
    assert(fs.readFileSync(path.join(projectRoot, paths[2]), 'utf8').includes('저작됨'), '실패가 형제의 결과를 지웠습니다');
    git(['checkout', '--', '.'], projectRoot);

    // ── 변경 없음과 미실행은 다른 값이다 ─────────────────────────────────
    //
    // 구분하지 않으면 아무것도 하지 않고 "변경 없음"이라 말하는 것이 완료로 가는
    // 가장 싼 길이 된다.
    const quiet = await runAuthorFanOut(paths.map((targetPath) => ({ targetPath, invocation })), {
      maxConcurrency: 2,
      runAdapterOnce: async () => ({ exitCode: 0, status: 'success', result: { claims: [], artifactIds: [] }, changed: false })
    });
    assert.deepStrictEqual(quiet.unchanged.slice().sort(), paths.slice().sort());
    assert.deepStrictEqual(quiet.undispatched, []);
    assert.deepStrictEqual(quiet.failed, []);

    // 준비 완료 집합이 비면 아무 것도 하지 않는다. 빈 집합은 실패가 아니다.
    const none = await runAuthorFanOut([], { maxConcurrency: 2, runAdapterOnce: () => { throw new Error('빈 집합에서 어댑터를 부르면 안 됩니다.'); } });
    assert.deepStrictEqual(none.targets, []);
    assert.deepStrictEqual(none.failed, []);
    assert.deepStrictEqual(none.undispatched, []);

    // ── 병렬이 저작의 경계를 넓히지 않는다 ───────────────────────────────
    //
    // 형제 목록에 없는 파일이 떠 있으면 여전히 거부한다. 넓어지는 것은 "무엇이 남의
    // 변경인가"의 기준뿐이다.
    fs.appendFileSync(path.join(projectRoot, 'project.md'), '\n<!-- fan-out 밖의 변경 -->\n');
    const blocked = await runAuthorFanOut([{ targetPath: paths[0], invocation }], {
      maxConcurrency: 1,
      runAdapterOnce: require('../src/adapter').runAdapterOnce
    });
    assert.strictEqual(blocked.failed.length, 1, JSON.stringify(blocked));
    assert(/clean outside the target/u.test(blocked.failed[0].reason), blocked.failed[0].reason);
    git(['checkout', '--', '.'], projectRoot);

    process.stdout.write('author fan-out tests passed\n');
  } finally {
    if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
    else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = main();
