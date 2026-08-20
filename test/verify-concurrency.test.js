'use strict';

// 검증 실행의 동시성(REQ-043).
//
// 판정자를 늘려야 판정이 독립해지는데, 순차로 부르면 늘린 만큼 느려진다. 느려진
// 통제는 결국 꺼지므로 두 요구는 정면으로 충돌한다. 여기서 보는 것은 그 충돌이
// 실제로 풀렸는가 — 그리고 풀면서 재개 계약이 깨지지 않았는가이다.
//
// 모델은 부르지 않는다. 어댑터 호출을 주입해서 시간과 호출 횟수를 이 시험이 정한다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyArtifact } = require('../src/verify');

// 어댑터 실행은 주입으로 대체하지만 verifyArtifact는 실행 전에 종료 보장을 묻는다.
// 그 물음을 지나가려면 이 스위트에서만 켜고 끝날 때 되돌린다.
const PREVIOUS_WINDOWS_ADAPTER = process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = '1';

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-verify-concurrency-'));
const home = path.join(temporary, 'runtime');
const LENSES = ['boundary-v1', 'omission-v1', 'satisfaction-v1'];
const DELAY = 600;

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

// 호출을 세고, 겹친 정도를 재고, 지정한 렌즈만 실패시킨다.
//
// 겹침은 각 호출의 구간으로 잰다. 벽시계로 재면 느린 기계에서 호출 사이의 준비
// 작업이 길어지는 것만으로 시험이 넘어지고, 그러면 이 시험은 동시성이 아니라
// 기계 속도를 재는 것이 된다 — 실제로 그렇게 넘어졌다.
function recorder(options) {
  const settings = options || {};
  const state = { calls: [], spans: [], inFlight: 0, peak: 0, firstStart: null, lastEnd: null };
  state.run = async (invocation) => {
    state.calls.push(invocation.lensId);
    const startedAt = Date.now();
    if (state.firstStart === null) state.firstStart = startedAt;
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    const span = { start: startedAt, end: null };
    state.spans.push(span);
    try {
      await new Promise((resolve) => setTimeout(resolve, DELAY));
      if (settings.failLens === invocation.lensId) throw new Error(`주입한 실패: ${invocation.lensId}`);
      return {
        exitCode: 0,
        status: 'success',
        result: { verdict: 'pass', findings: [] },
        adapter: { name: 'injected', instructionId: invocation.instruction.id, instructionRevision: invocation.instruction.revision, instructionDigest: invocation.instruction.instructionDigest }
      };
    } finally {
      state.inFlight -= 1;
      span.end = Date.now();
      state.lastEnd = span.end;
    }
  };
  // 호출 구간의 합을 그 합집합으로 나눈다. 완전히 겹치면 호출 수에, 완전히 직렬이면
  // 1에 가깝다. 기계가 느려지면 분자와 분모가 함께 커지므로 이 값은 속도에 흔들리지
  // 않는다.
  state.overlapFactor = () => {
    const spans = state.spans.filter((item) => item.end !== null);
    if (spans.length === 0) return 0;
    const total = spans.reduce((sum, item) => sum + (item.end - item.start), 0);
    const sorted = spans.slice().sort((left, right) => left.start - right.start);
    let union = 0;
    let from = sorted[0].start;
    let to = sorted[0].end;
    for (const item of sorted.slice(1)) {
      if (item.start > to) { union += to - from; from = item.start; to = item.end; continue; }
      to = Math.max(to, item.end);
    }
    union += to - from;
    return union === 0 ? spans.length : total / union;
  };
  return state;
}

async function main() {
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Rundol Test']);
    git(['config', 'user.email', 'rundol@example.test']);
    fs.writeFileSync(path.join(temporary, 'README.md'), '# concurrency\n', 'utf8');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
    rdl(['client', 'register', 'agent-a', '--name', '검증 에이전트', '--type', 'agent', '--owner', 'MEMBER-001']);
    const document = rdl(['doc', 'create', 'PRD', '동시 검증 대상', '--project', 'crm', '--owner', 'MEMBER-001',
      '--scope', '동시 실행이 도는지 보는 문서', '--exclude', '그 밖']);

    const projectRoot = path.join(temporary, 'projects', 'crm');
    // 어댑터는 주입으로 대체되지만 설정은 여전히 활성 어댑터를 요구한다. 검증이
    // 무엇으로 판정하는지는 설정이 정하고, 주입은 그 실행만 대신한다.
    fs.writeFileSync(path.join(projectRoot, 'harness.json'), `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      adapters: { injected: { enabled: true, command: process.execPath, argsTemplate: ['-e', ';', '{instruction}', '{context}', '{result}'], timeoutSeconds: 30 } },
      verify: { defaultAdapter: 'injected', defaultLenses: LENSES, maxConcurrency: 3 }
    }, null, 2)}\n`, 'utf8');
    git(['add', '.'], projectRoot);
    git(['commit', '-m', 'add injected adapter'], projectRoot);

    // ── 동시 실행 ────────────────────────────────────────────────────────
    const concurrent = recorder();
    const result = await verifyArtifact(temporary, {
      project: 'crm', targetId: document.id, clientId: 'agent-a', lenses: LENSES, runAdapterOnce: concurrent.run
    });
    assert.strictEqual(result.status, 'passed', JSON.stringify(result.fold));
    assert.strictEqual(concurrent.calls.length, LENSES.length);
    assert.strictEqual(concurrent.peak, LENSES.length, `상한 안에서 겹쳐 돌아야 합니다. 최대 동시 실행: ${concurrent.peak}`);
    // 재는 것은 판정 호출이 서로 겹쳤는가이지 전체가 얼마나 걸렸는가가 아니다.
    // 벽시계로 재면 호출 사이의 준비 작업이 느린 기계에서 길어지는 것만으로
    // 넘어지고, 그러면 이 시험은 동시성이 아니라 기계 속도를 재게 된다.
    //
    // 구간의 합을 합집합으로 나누면 완전히 겹칠 때 렌즈 수에, 완전히 직렬일 때
    // 1에 가깝다. 기계가 느려지면 분자와 분모가 함께 커지므로 이 값은 흔들리지
    // 않는다. 하한을 렌즈 수의 절반보다 위에 두어, 둘만 겹치고 하나가 뒤따라
    // 도는 경우를 통과로 세지 않는다.
    const factor = concurrent.overlapFactor();
    assert(
      factor > LENSES.length / 2,
      `판정 호출이 충분히 겹치지 않았습니다: 겹침 배수 ${factor.toFixed(2)} (렌즈 ${LENSES.length}개, 하한 ${LENSES.length / 2})`
    );
    // 돌려주는 목록의 순서도 결과다. 완료 순서에 따라 달라지면 같은 입력에 같은
    // 출력이라는 성질이 깨진다.
    assert.deepStrictEqual(result.verdicts.map((item) => item.lens), LENSES.slice().sort());

    // ── 상한이 실제로 걸리는가 ────────────────────────────────────────────
    const second = rdl(['doc', 'create', 'PRD', '상한 확인 대상', '--project', 'crm', '--owner', 'MEMBER-001',
      '--scope', '상한이 걸리는지 보는 문서', '--exclude', '그 밖']);
    fs.writeFileSync(path.join(projectRoot, 'harness.json'), `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      adapters: { injected: { enabled: true, command: process.execPath, argsTemplate: ['-e', ';', '{instruction}', '{context}', '{result}'], timeoutSeconds: 30 } },
      verify: { defaultAdapter: 'injected', defaultLenses: LENSES, maxConcurrency: 1 }
    }, null, 2)}\n`, 'utf8');
    git(['add', '.'], projectRoot);
    git(['commit', '-m', 'limit concurrency'], projectRoot);
    const limited = recorder();
    await verifyArtifact(temporary, {
      project: 'crm', targetId: second.id, clientId: 'agent-a', lenses: LENSES, runAdapterOnce: limited.run
    });
    assert.strictEqual(limited.peak, 1, `상한 1인데 ${limited.peak}개가 동시에 돌았습니다`);

    // ── 실패 격리와 재개 ─────────────────────────────────────────────────
    //
    // 하나가 실패했다고 나머지를 버리면 다음 시도가 처음부터 다시 부른다. 성공한
    // 판정은 원장에 남아 재사용되어야 한다.
    const third = rdl(['doc', 'create', 'PRD', '재개 확인 대상', '--project', 'crm', '--owner', 'MEMBER-001',
      '--scope', '재개가 도는지 보는 문서', '--exclude', '그 밖']);
    fs.writeFileSync(path.join(projectRoot, 'harness.json'), `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      adapters: { injected: { enabled: true, command: process.execPath, argsTemplate: ['-e', ';', '{instruction}', '{context}', '{result}'], timeoutSeconds: 30 } },
      verify: { defaultAdapter: 'injected', defaultLenses: LENSES, maxConcurrency: 3 }
    }, null, 2)}\n`, 'utf8');
    git(['add', '.'], projectRoot);
    git(['commit', '-m', 'restore concurrency'], projectRoot);

    const failing = recorder({ failLens: 'omission-v1' });
    const rootRequestId = 'REQ-CCCCCCCCCCCCCCCCCCCC';
    await assert.rejects(() => verifyArtifact(temporary, {
      project: 'crm', targetId: third.id, clientId: 'agent-a', lenses: LENSES, rootRequestId, runAdapterOnce: failing.run
    }), /주입한 실패/u);
    // 실패 하나가 나머지를 중단하지 않았다.
    assert.deepStrictEqual(failing.calls.slice().sort(), LENSES.slice().sort(), `실패가 나머지를 중단했습니다: ${failing.calls.join(', ')}`);

    const retried = recorder();
    await assert.rejects(() => verifyArtifact(temporary, {
      project: 'crm', targetId: third.id, clientId: 'agent-a', lenses: LENSES, rootRequestId, runAdapterOnce: retried.run
    }), /verification invocation is terminal/u);
    // 성공했던 판정은 다시 부르지 않는다. 재시도 단위는 자식 요청 키다.
    assert(!retried.calls.includes('boundary-v1'), `성공한 판정을 다시 불렀습니다: ${retried.calls.join(', ')}`);
    assert(!retried.calls.includes('satisfaction-v1'), `성공한 판정을 다시 불렀습니다: ${retried.calls.join(', ')}`);

    process.stdout.write('verify concurrency tests passed\n');
  } finally {
    if (PREVIOUS_WINDOWS_ADAPTER === undefined) delete process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER;
    else process.env.RUNDOL_ALLOW_WINDOWS_ADAPTER = PREVIOUS_WINDOWS_ADAPTER;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = main();
