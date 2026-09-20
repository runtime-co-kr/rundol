'use strict';

// workspace 탐색의 답과 비용을 함께 고정한다.
//
// 답만 고정하면 비용은 조용히 되돌아온다. findWorkspaceRoot는 못 찾은 층마다
// runtimeWorkspace를 불렀고 그 한 번이 git 프로세스 둘이었다 — 깊은 경로에서 부른
// rdl 한 번이 실측 4초였다. 답은 그대로였으므로 어떤 시험도 울지 않았다.
// 그래서 여기서는 "git이 몇 번 떴는가"를 직접 센다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const workspaceModule = path.join(root, 'src', 'workspace.js');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return (result.stdout || '').trim();
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function makeRepository(directory, remote) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ['init', '-b', 'main', '.']);
  git(directory, ['config', 'user.name', 'Rundol Test']);
  git(directory, ['config', 'user.email', 'rundol@example.test']);
  if (remote) git(directory, ['remote', 'add', 'origin', remote]);
  write(path.join(directory, 'README.md'), '# Workspace\n');
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-m', 'initial']);
  return directory;
}

// RUNDOL_HOME은 워커가 pid로 갈라 둔 것이다. 시험마다 바꿔야 런타임 manifest가 있는
// 판과 없는 판을 갈라 볼 수 있고, 되돌리지 않으면 뒤에 도는 시험이 남의 판을 본다.
function withHome(home, action) {
  const previous = process.env.RUNDOL_HOME;
  process.env.RUNDOL_HOME = home;
  try { return action(); } finally {
    if (previous === undefined) delete process.env.RUNDOL_HOME;
    else process.env.RUNDOL_HOME = previous;
  }
}

function testManifestPriority() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-workspace-priority-'));
  try {
    const home = path.join(temporary, 'home');
    fs.mkdirSync(home, { recursive: true });
    const repository = makeRepository(path.join(temporary, 'repository'), path.join(temporary, 'remote.git'));
    const { manifestPath } = require('../src/workspace');
    withHome(home, () => {
      assert.strictEqual(manifestPath(repository), null, '아무것도 없으면 null이다');

      const legacy = path.join(repository, '.rundol', 'workspace.yaml');
      write(legacy, 'schemaVersion: 1\nid: legacy\n');
      assert.strictEqual(manifestPath(repository), legacy, '옛 저장소는 .rundol/workspace.yaml로 찾는다');

      const modern = path.join(repository, 'projects', 'workspace', 'workspace.yaml');
      write(modern, 'schemaVersion: 6\nid: workspace\nmount: projects\n');
      assert.strictEqual(manifestPath(repository), modern, '둘 다 있으면 projects/workspace/workspace.yaml이 이긴다');
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testRuntimeManifestStillFound() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-workspace-runtime-'));
  try {
    const home = path.join(temporary, 'home');
    fs.mkdirSync(home, { recursive: true });
    const repository = makeRepository(path.join(temporary, 'repository'), path.join(temporary, 'remote.git'));
    const deep = path.join(repository, 'docs', 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    const { manifestPath, findWorkspaceRoot } = require('../src/workspace');
    const { workspaceId } = require('../src/runtime');
    withHome(home, () => {
      assert.strictEqual(manifestPath(repository), null);
      const manifest = path.join(home, 'workspaces', workspaceId(repository), 'workspace.yaml');
      write(manifest, 'schemaVersion: 1\nid: runtime\n');
      assert.strictEqual(manifestPath(repository), manifest, '런타임 manifest로만 찾아지는 저장소가 여전히 찾아진다');
      // 런타임 manifest는 저장소마다 하나라 탐색의 모든 층에서 같은 답을 낸다. 그래서
      // 시작 디렉터리가 그대로 루트가 된다 — 이상해 보이지만 고치기 전과 같은 답이고,
      // 이번 변경은 비용만 건드린다. 이 줄이 그 약속을 붙잡는다.
      assert.strictEqual(findWorkspaceRoot(deep), deep, '런타임으로 찾으면 시작 디렉터리가 루트다');
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testNotFound() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-workspace-missing-'));
  try {
    const home = path.join(temporary, 'home');
    fs.mkdirSync(home, { recursive: true });
    const plain = path.join(temporary, 'plain', 'deep');
    fs.mkdirSync(plain, { recursive: true });
    const repository = makeRepository(path.join(temporary, 'repository'), path.join(temporary, 'remote.git'));
    const { findWorkspaceRoot } = require('../src/workspace');
    withHome(home, () => {
      assert.throws(() => findWorkspaceRoot(plain), /연결된 Rundol Workspace를 찾지 못했습니다/u, 'git 저장소가 아니면 못 찾았다고 답한다');
      assert.throws(() => findWorkspaceRoot(repository), /연결된 Rundol Workspace를 찾지 못했습니다/u, '워크스페이스 아닌 저장소도 못 찾았다고 답한다');
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// 하위 디렉터리에서 시작해도 git이 뜨지 않는다.
//
// 자식 프로세스에서 세는 이유는 두 가지다. src/git.js가 spawnSync를 모듈을 읽을 때
// 한 번 꺼내 두므로 이미 읽힌 뒤에는 갈아 끼울 수 없고, 워커 안에서 앞의 시험이
// 남긴 git 캐시가 수를 가려 버린다. 새 프로세스는 둘 다 없다.
function probeLayout(start, home) {
  const probe = [
    'const child = require("child_process");',
    'const original = child.spawnSync;',
    'let count = 0;',
    'child.spawnSync = function (command) { if (command === "git") count += 1; return original.apply(this, arguments); };',
    `const { workspaceLayout } = require(${JSON.stringify(workspaceModule)});`,
    `const layout = workspaceLayout(${JSON.stringify(start)});`,
    'process.stdout.write(JSON.stringify({ count, root: layout.root }));'
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: root,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { RUNDOL_HOME: home })
  });
  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function testSubdirectoryDoesNotSpawnGit() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-workspace-cost-'));
  try {
    const home = path.join(temporary, 'home');
    fs.mkdirSync(path.join(home, 'workspaces'), { recursive: true });
    const repository = makeRepository(path.join(temporary, 'repository'), path.join(temporary, 'remote.git'));
    write(path.join(repository, 'projects', 'workspace', 'workspace.yaml'), 'schemaVersion: 6\nid: workspace\nmount: projects\n');
    const deep = path.join(repository, 'projects', 'crm', 'docs', 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });

    const observed = probeLayout(deep, home);
    assert.strictEqual(path.resolve(observed.root), path.resolve(repository), '깊은 경로에서 시작해도 루트는 워크스페이스 루트다');
    assert.strictEqual(observed.count, 0, `하위 디렉터리 탐색은 git을 띄우지 않는다 (실제 ${observed.count}회)`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// 런타임 manifest를 가진 기기에서도 탐색 비용이 깊이를 타지 않는다.
//
// 위의 시험은 $RUNDOL_HOME/workspaces가 빈 갈래만 본다. 거기서는 anyRuntimeManifest()가
// 곧바로 거짓이라 층마다 물어도 공짜이고, 그래서 "깊이를 탄다"는 사실이 한 번도 드러나지
// 않았다. rdl attach를 한 번이라도 쓴 기기는 그 파일을 갖고 있고, 그때는 못 찾은 층마다
// runtimeWorkspace가 돌아 층 수만큼 rev-parse가 떴다 — 실측으로 여섯 층 깊이에서 15회,
// 205ms였다(루트에서는 0회, 3.3ms). 하위 디렉터리에서 친 명령이 루트에서 친 것과 같은
// 시간에 답해야 한다는 것이 이 자리의 계약이다.
//
// 절대 수가 아니라 "깊이를 타지 않는다"를 못박는다. 런타임 manifest가 있는 기기에서
// 신원을 한 번 묻는 것은 답을 내는 데 필요한 값이라 0으로 만들 수 없고(순서를 바꾸면
// 돌려주는 루트가 달라진다 — workspace.js가 그 이유를 적어 두었다), 여기서 지켜야 할
// 것은 그 한 번이 층마다 되풀이되지 않는다는 것이다. 상한도 함께 둔다. 두 깊이가 나란히
// 늘어나면 같기만 한 수는 아무 말도 하지 못한다.
function testRuntimeManifestCostDoesNotGrowWithDepth() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-workspace-depth-'));
  try {
    const home = path.join(temporary, 'home');
    // 이 저장소의 것이 아닌 남의 런타임 manifest 하나. anyRuntimeManifest()를 참으로
    // 만드는 것이 목적이고, 그래서 탐색은 층마다 "내 것이 있나"를 묻게 된다.
    write(path.join(home, 'workspaces', '0123456789abcdef', 'workspace.yaml'), 'schemaVersion: 1\nid: 남의-것\n');
    const repository = makeRepository(path.join(temporary, 'repository'), path.join(temporary, 'remote.git'));
    write(path.join(repository, 'projects', 'workspace', 'workspace.yaml'), 'schemaVersion: 6\nid: workspace\nmount: projects\n');

    const shallow = path.join(repository, 'projects', 'crm');
    const deep = path.join(repository, 'projects', 'crm', 'docs', 'a', 'b', 'c', 'd');
    fs.mkdirSync(deep, { recursive: true });

    const atRoot = probeLayout(repository, home);
    const atShallow = probeLayout(shallow, home);
    const atDeep = probeLayout(deep, home);

    for (const [where, observed] of [['루트', atRoot], ['한 층', atShallow], ['여섯 층', atDeep]]) {
      assert.strictEqual(path.resolve(observed.root), path.resolve(repository), `${where}에서 시작해도 답은 같은 루트다`);
    }
    assert.strictEqual(atRoot.count, 0, `루트에서는 신원을 물을 일이 없다 (실제 ${atRoot.count}회)`);
    assert.strictEqual(atDeep.count, atShallow.count,
      `깊이가 늘어도 탐색이 git을 더 띄우지 않는다 (한 층 ${atShallow.count}회 · 여섯 층 ${atDeep.count}회)`);
    assert(atDeep.count <= 2, `신원 질문은 저장소마다 한 번이다 (실제 ${atDeep.count}회)`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// runtimeWorkspace가 방금 구한 저장소 루트를 git에게 다시 묻지 않는다.
//
// rev-parse 캐시는 cwd 문자열로 걸린다. 하위 디렉터리에서 부르면 start와 루트가 다른
// 문자열이라 루트를 한 번 더 묻게 되고, 그 한 번이 프로세스 하나다. 잠금·사건 기록·훅이
// 전부 이 함수를 지나므로 한 명령이 도는 동안 여러 번 물린다.
function testRuntimeWorkspaceAsksRepositoryOnce() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-runtime-cost-'));
  try {
    const repository = makeRepository(path.join(temporary, 'repository'), path.join(temporary, 'remote.git'));
    const deep = path.join(repository, 'docs', 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    const runtimeModule = path.join(root, 'src', 'runtime.js');
    const probe = [
      'const child = require("child_process");',
      'const original = child.spawnSync;',
      'const seen = [];',
      'child.spawnSync = function (command, args) { if (command === "git") seen.push((args || []).filter((value) => value !== "-c" && !value.includes("=")).join(" ")); return original.apply(this, arguments); };',
      `const { runtimeWorkspace } = require(${JSON.stringify(runtimeModule)});`,
      `const workspace = runtimeWorkspace(${JSON.stringify(deep)});`,
      'process.stdout.write(JSON.stringify({ seen, id: workspace.id, root: workspace.root }));'
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', probe], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const observed = JSON.parse(result.stdout);
    assert.strictEqual(path.resolve(observed.root), fs.realpathSync.native(repository), '답은 그 저장소의 루트다');
    const toplevels = observed.seen.filter((entry) => entry.startsWith('rev-parse'));
    assert.strictEqual(toplevels.length, 1, `저장소 루트는 한 번만 묻는다 (실제 ${toplevels.length}회: ${observed.seen.join(' · ')})`);

    // 답이 달라지지 않는다. 루트에서 부른 것과 하위에서 부른 것이 같은 신원이어야
    // 잠금과 런타임 상태가 같은 자리를 가리킨다.
    const { runtimeWorkspace } = require('../src/runtime');
    assert.strictEqual(runtimeWorkspace(deep).id, runtimeWorkspace(repository).id, '어느 층에서 물어도 신원은 하나다');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// 신원 캐시는 저장소 루트별로 답하고, 저장소가 다르면 답도 다르다.
// 한 프로세스가 임시 저장소를 여럿 보는 것이 이 저장소 시험의 기본이라, 섞이면
// 잠금과 런타임 상태가 통째로 남의 것을 가리킨다.
function testIdentityCacheIsPerRepository() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-workspace-identity-'));
  try {
    const first = makeRepository(path.join(temporary, 'first'), path.join(temporary, 'first-remote.git'));
    const second = makeRepository(path.join(temporary, 'second'), path.join(temporary, 'second-remote.git'));
    const { workspaceId, runtimeWorkspace, clearRuntimeCache } = require('../src/runtime');

    const firstId = workspaceId(first);
    assert.strictEqual(workspaceId(first), firstId, '같은 저장소는 같은 신원이다');
    assert.notStrictEqual(workspaceId(second), firstId, '저장소가 다르면 신원도 다르다');
    assert.strictEqual(runtimeWorkspace(first).id, firstId, 'runtimeWorkspace도 같은 신원을 쓴다');
    assert.notStrictEqual(runtimeWorkspace(second).state, runtimeWorkspace(first).state, '저장소가 다르면 런타임 상태 경로도 다르다');

    // 캐시를 버려도 같은 답이 나온다. 다르면 기억한 값이 계산한 값과 어긋난 것이다.
    clearRuntimeCache();
    assert.strictEqual(workspaceId(first), firstId, '캐시를 버리고 다시 계산해도 같은 신원이다');

    // 원격이 없는 저장소는 신원이 realpath로 떨어진다. 그 갈래도 캐시를 탄다.
    const bare = makeRepository(path.join(temporary, 'no-remote'), null);
    const bareId = workspaceId(bare);
    clearRuntimeCache();
    assert.strictEqual(workspaceId(bare), bareId, '원격 없는 저장소도 캐시 전후가 같다');
    assert.notStrictEqual(bareId, firstId);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

testManifestPriority();
testRuntimeManifestStillFound();
testNotFound();
testSubdirectoryDoesNotSpawnGit();
testRuntimeManifestCostDoesNotGrowWithDepth();
testRuntimeWorkspaceAsksRepositoryOnce();
testIdentityCacheIsPerRepository();
process.stdout.write('workspace tests passed\n');
