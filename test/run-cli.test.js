'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-run-cli-'));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), root));
}

function rdlRaw(args) {
  const result = spawnSync(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), { cwd: root, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

try {
  const bare = path.join(temporary, 'origin.git');
  command('git', ['init', '--bare', '--initial-branch=main', bare], temporary);
  command('git', ['init', '-b', 'main'], temporary);
  command('git', ['config', 'user.name', 'Rundol Test'], temporary);
  command('git', ['config', 'user.email', 'rundol@example.test'], temporary);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# Test\n');
  command('git', ['add', 'README.md'], temporary);
  command('git', ['commit', '-m', 'initial'], temporary);
  command('git', ['remote', 'add', 'origin', bare], temporary);
  command('git', ['push', 'origin', 'main'], temporary);
  rdl(['init', 'crm', '--name', '고객 관리', '--profile', 'lean']);
  rdl(['contract', 'set', '--project', 'crm', '--profile', 'lean', '--enforcement', 'advisory']);
  rdl(['client', 'register', 'laptop-a', '--name', '업무 노트북', '--type', 'device', '--owner', 'MEMBER-001']);

  // 문서 1개 = 기능 1개 기본: REQ에 기능 2개는 --grouped로도 열리지 않는다.
  const rejectedCreate = rdlRaw(['doc', 'create', 'REQ', '결제 요구', '--project', 'crm', '--owner', 'MEMBER-001', '--scope', '결제 승인 요구', '--exclude', '환불 흐름', '--function-id', 'PAY-01', '--function-id', 'PAY-02', '--grouped', '--reason', '사유']);
  assert.notStrictEqual(rejectedCreate.status, 0);
  assert(/기능 1개만/u.test(rejectedCreate.stderr), rejectedCreate.stderr);

  // 내장 절차가 단일 소스로 열거된다.
  const procedures = rdl(['run', 'procedures', '--project', 'crm']);
  const authored = procedures.procedures.find((item) => item.name === 'document.authored');
  assert(authored, '내장 절차 document.authored가 없습니다');
  assert.strictEqual(authored.source, '내장');

  // 게이트를 제거하는 프로젝트 오버라이드는 로드 시점에 거부된다.
  const proceduresFile = path.join(temporary, 'projects', 'crm', 'procedures.json');
  fs.writeFileSync(proceduresFile, `${JSON.stringify({
    schemaVersion: 1,
    procedures: {
      'document.authored': {
        revision: 2,
        steps: [
          { id: 'plan', executor: 'cli', command: 'contract', args: ['next', '--project', '{project}', '--json'] },
          { id: 'create', executor: 'cli', command: 'doc', args: ['create'] },
          { id: 'author', executor: 'client' },
          { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}'] },
          { id: 'sync-gate', human: true }
        ]
      }
    }
  }, null, 2)}\n`, 'utf8');
  const rejected = rdlRaw(['run', 'procedures', '--project', 'crm']);
  assert.notStrictEqual(rejected.status, 0);
  assert(/게이트를 제거할 수 없습니다|스텝을 제거할 수 없습니다/u.test(rejected.stderr), rejected.stderr);

  // 스텝을 더하고 시도 상한을 조이는 오버라이드는 허용되고 revision이 갈린다.
  fs.writeFileSync(proceduresFile, `${JSON.stringify({
    schemaVersion: 1,
    procedures: {
      'document.authored': {
        revision: 2,
        steps: [
          { id: 'plan', executor: 'cli', command: 'contract', args: ['next', '--project', '{project}', '--json'] },
          { id: 'create', executor: 'cli', command: 'doc', args: ['create'] },
          { id: 'author', executor: 'client' },
          { id: 'peer-note', executor: 'client' },
          { id: 'mech-gate', gate: { command: 'check', args: ['{artifact}', '--strict'] }, onFail: { goto: 'author', maxAttempts: 2 } },
          { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}'] },
          { id: 'sync-gate', human: true }
        ]
      }
    }
  }, null, 2)}\n`, 'utf8');
  const overridden = rdl(['run', 'procedures', '--project', 'crm']);
  const local = overridden.procedures.find((item) => item.name === 'document.authored');
  assert.strictEqual(local.revision, 2);
  assert.notStrictEqual(local.contentHash, authored.contentHash);

  // 런 시작: 오버라이드된 절차가 pin된다.
  const started = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'laptop-a', '--goal', '결제 REQ']);
  const runId = started.runId;
  assert(/^RUN-[A-F0-9]{20}$/u.test(runId));

  // 절차 정의가 삭제돼도 진행 중 런은 pin으로 완주한다.
  fs.rmSync(proceduresFile);

  // next → step 보고의 대화형 루프. plan/create/author를 진행한다.
  let next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'plan');
  assert.deepStrictEqual(next.step.args, ['next', '--project', 'crm', '--json']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'create', '--artifact-id', 'REQ-001']);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'author');
  rdl(['run', 'step', '--run', runId, '--project', 'crm']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'peer-note']);

  // 게이트 스텝은 step 보고로 전진할 수 없다.
  const wrongStep = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'mech-gate']);
  assert.notStrictEqual(wrongStep.status, 0);

  // 게이트 실제 실행: 필수 필드가 빠진 REQ-001 문서를 심어 진짜 check 실패를 만든다.
  const brokenDocument = path.join(temporary, 'projects', 'crm', 'REQ-001-결제요구.md');
  fs.writeFileSync(brokenDocument, '---\nid: REQ-001\ntype: REQ\n---\n\n# 결제 요구\n', 'utf8');
  const gate = rdlRaw(['run', 'gate', '--run', runId, '--project', 'crm']);
  assert.strictEqual(gate.status, 1, gate.stdout + gate.stderr);
  const gateResult = JSON.parse(gate.stdout);
  assert.strictEqual(gateResult.exitCode > 0, true);
  assert(gateResult.diagnostics.length > 0, '게이트가 진단 코드를 수집하지 못했습니다');
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'author');
  assert.strictEqual(next.attempts['mech-gate'], 1);

  // 재작업 후 사람이 사유와 함께 게이트를 우회하면 forced로 기록되고 전진한다.
  rdl(['run', 'step', '--run', runId, '--project', 'crm']);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'peer-note']);
  const noReason = rdlRaw(['run', 'gate', '--run', runId, '--project', 'crm', '--force']);
  assert.notStrictEqual(noReason.status, 0);
  const forced = rdl(['run', 'gate', '--run', runId, '--project', 'crm', '--force', '--reason', '테스트 픽스처에는 실제 문서가 없다']);
  assert.strictEqual(forced.forced, true);
  fs.rmSync(brokenDocument);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.id, 'save');

  // 수동 정지와 재개.
  rdl(['run', 'halt', '--run', runId, '--project', 'crm']);
  const haltedNext = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(haltedNext.status, 'halted');
  const blockedStep = rdlRaw(['run', 'step', '--run', runId, '--project', 'crm']);
  assert.notStrictEqual(blockedStep.status, 0);
  rdl(['run', 'resume', '--run', runId, '--project', 'crm']);

  // save와 sync-gate(사람 게이트)를 보고하고 완료한다.
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'save']);
  next = rdl(['run', 'next', '--run', runId, '--project', 'crm']);
  assert.strictEqual(next.step.human, true);
  rdl(['run', 'step', '--run', runId, '--project', 'crm', '--step', 'sync-gate']);
  const completed = rdl(['run', 'complete', '--run', runId, '--project', 'crm']);
  assert(completed.commit);

  // 미완료 스텝이 있으면 complete가 거부되는지는 두 번째 런으로 확인한다.
  const second = rdl(['run', 'start', 'document.authored', '--project', 'crm', '--client-id', 'laptop-a']);
  const incomplete = rdlRaw(['run', 'complete', '--run', second.runId, '--project', 'crm']);
  assert.notStrictEqual(incomplete.status, 0);
  assert(/완료되지 않은 스텝/u.test(incomplete.stderr));

  // sync가 성공하면 completed_local 런이 synced로 전이한다 — 두 번째 완료.
  rdl(['sync', '--project', 'crm']);
  const listed = rdl(['run', 'list', '--project', 'crm']);
  const syncedRun = listed.runs.find((item) => item.runId === runId);
  assert.strictEqual(syncedRun.status, 'synced');
  const stillRunning = listed.runs.find((item) => item.runId === second.runId);
  assert.strictEqual(stillRunning.status, 'running');

  // 원장 열람.
  const log = rdl(['run', 'log', '--run', runId, '--project', 'crm']);
  assert(log.events.some((event) => event.type === 'run.forced'));
  assert(log.events.some((event) => event.type === 'run.synced'));

  process.stdout.write('run CLI tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
