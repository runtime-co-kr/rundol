'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { canonicalJson, validateProcedure } = require('./run-ledger');
const { getLens, pinInstruction, resolveInstructionPin } = require('./instruction-registry');
const { loadBoardPresentation } = require('./board-presentation');
const { floorPolicy } = require('./approval-mode');

function pinnedLensInstructions(lenses) {
  return Object.fromEntries(lenses.map((lensId) => {
    const lens = getLens(lensId);
    return [lensId, pinInstruction(lens.instructionId)];
  }));
}

// 내장 기본 절차. 코드가 정본이며 Workspace와 프로젝트의 procedures.json이
// 이를 오버라이드한다. 검증 스텝(verify)은 어댑터 계층이 생기기 전까지
// 내장 절차에 존재하지 않는다 — 미구현 기능을 자리표시로 선표기하지 않는다.
const BUILTIN = {
  'document.authored': {
    revision: 1,
    idempotent: false,
    steps: [
      { id: 'plan', executor: 'cli', command: 'contract', args: ['next', '--project', '{project}', '--json'] },
      { id: 'create', executor: 'cli', command: 'doc', args: ['create'] },
      { id: 'author', executor: 'client' },
      { id: 'mech-gate', gate: { command: 'check', args: ['{artifact}', '--strict'] }, onFail: { goto: 'author', maxAttempts: 3 } },
      { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}'] },
      { id: 'sync-gate', human: true }
    ]
  },
  // 이미 커밋된 문서를 검사하고 검증해 사람 앞까지 미는 절차. drive로 완주한다.
  //
  // 저작이 여기 없는 이유는 이름이 아니라 설계다. 검증의 리비전 pin은 run 시작
  // 시점의 커밋으로 고정되고(run-start-head), 검증자는 깨끗한 worktree를
  // 요구한다 — 판정이 불변 상태에 결박되어야 나중에 "그건 다른 버전이었다"가
  // 통하지 않기 때문이다. 저작이 그 뒤에 문서를 고치면 두 성질이 동시에 깨진다.
  //
  // 그래서 이 절차는 이름 그대로 검증한다. 저작은 사람이나 별도 절차가 하고,
  // 커밋된 결과를 이 절차가 받는다. 저작과 검증을 한 런에 묶으려면 저장 뒤에
  // 리비전을 pin하는 전략이 필요하고, 그것은 별도 결정이다.
  //
  // 문서를 만드는 일은 여기 없다. 무엇을 만들 것인가 — 유형·제목·단일 책임·
  // 제외 범위 — 는 사람이 정하는 의도이고, 절차가 지어낼 것이 아니다. 이전
  // revision은 create 스텝을 갖고 있었지만 그 스텝에는 인수가 없었고 채울
  // placeholder도 없었다. 실행되지 않는 형태였다는 뜻이고, 그것이 이 절차가
  // idempotent: false였던 이유다.
  //
  // 그래서 대상 문서는 run 시작 시 고정하고({artifact}), 절차는 그 문서를
  // 쓰고·검사하고·검증하고·저장한 뒤 사람 앞에서 멈춘다.
  'document.verified': {
    revision: 2,
    idempotent: true,
    // 이 절차는 문서를 만들지 않는다. 대상이 없으면 시작할 수 없고, 그 사실은
    // {artifact}에 닿는 스텝에서가 아니라 시작할 때 말해야 한다 — 나중에 말하면
    // 빠진 것은 인수인데 실패는 치환 오류라는 엉뚱한 이름으로 보고된다.
    // document.authored는 create 스텝이 대상을 만들므로 이것을 선언하지 않는다.
    requiresArtifact: true,
    steps: [
      { id: 'author', executor: 'adapter', instruction: pinInstruction('author-v1'), retrySafety: { mode: 'operation-id' } },
      { id: 'mech-gate', gate: { command: 'check', args: ['{artifact}', '--strict', '--project', '{project}'] }, onFail: { goto: 'author', maxAttempts: 3 } },
      // 저장이 검증보다 앞이다. 검증은 깨끗한 worktree를 요구하는데 — 판정이 불변
      // 상태에 결박되어야 나중에 "그건 다른 버전이었다"가 통하지 않는다 — 저작은
      // 문서를 고친다. 저장이 뒤에 있으면 검증 시점에 트리가 더럽고, 저작을 포함한
      // 절차는 절대 완주하지 못한다. 이 순서에서 세 성질이 함께 선다: 저작이 고치고,
      // 저장이 커밋으로 굳히고, 검증이 그 커밋을 판정한다.
      //
      // save는 본래 되풀이해도 같은 곳에 도착한다 — 바뀐 것이 없으면 커밋하지
      // 않는다. gate-recheck를 붙이면 문서 검사 통과를 저장 완료로 읽어, 저장되지
      // 않은 작업이 저장된 것으로 기록될 수 있다.
      // 저장은 이 런의 대상 하나에만 닿고, 하네스가 본 커밋 위에서만 쌓는다.
      // 범위는 인수가 아니라 원장이 정한다 — {runId}가 대상을 지목하고, save가
      // 그 문서 밖의 변경을 발견하면 담지 않고 멈춘다.
      { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}', '--run', '{runId}', '--expect-head', '{head}'], retrySafety: { mode: 'converging' } },
      {
        id: 'verify',
        executor: 'adapter',
        verify: {
          lenses: ['satisfaction-v1', 'omission-v1', 'boundary-v1'],
          instructions: pinnedLensInstructions(['satisfaction-v1', 'omission-v1', 'boundary-v1']),
          // 저장이 만든 커밋을 검증한다. run 시작 시점으로 굳히면 저작 결과를 볼 수
          // 없고, "지금 HEAD"로 두면 그 사이 다른 프로세스가 만든 커밋을 저작 결과로
          // 판정한다. 원장이 기록한 저장의 산출 커밋만이 둘 다 아니다.
          revisionPin: { strategy: 'step-output-commit', step: 'save' },
          policy: { validators: 1, quorum: 1, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: false }
        },
        // 반박되면 저작으로 돌아간다. 다시 쓰고 다시 저장하고 다시 검증한다 —
        // 그 순환이 하네스 안에 남아야 사람이 매번 새 런을 시작하지 않는다.
        onFail: { goto: 'author', maxAttempts: 3 },
        retrySafety: { mode: 'operation-id' }
      },
      { id: 'sync-gate', human: true }
    ]
  }
};

const NAME = /^[a-z][a-z0-9.-]*$/u;

function proceduresFile(root) {
  return path.join(root, 'procedures.json');
}

function readProceduresFile(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.schemaVersion !== 1) throw new Error(`${file}: 지원하지 않는 procedures schemaVersion입니다: ${parsed.schemaVersion}`);
  if (!parsed.procedures || typeof parsed.procedures !== 'object') throw new Error(`${file}: procedures 객체가 필요합니다.`);
  return parsed.procedures;
}

// 오버라이드 제약: 하위 계층은 스텝을 더하거나 파라미터를 조이는 것만 할 수 있다.
// 게이트 스텝 제거, 게이트 명령 변경, 시도 상한 증가, human 게이트 제거는
// 로드 시점에 거부된다 — 비교 대상은 부모 계층의 resolved 정의다.
function validateOverride(name, parent, child, source) {
  const parentSteps = new Map(parent.steps.map((step) => [step.id, step]));
  const childSteps = new Map(child.steps.map((step) => [step.id, step]));
  for (const step of parent.steps) {
    const overridden = childSteps.get(step.id);
    if (!overridden) throw new Error(`${source}: ${name}의 스텝을 제거할 수 없습니다: ${step.id}`);
    const parentClass = stepClass(step);
    const childClass = stepClass(overridden);
    if (parentClass !== childClass) throw new Error(`${source}: ${name}의 스텝 분류를 변경할 수 없습니다: ${step.id} (${parentClass} -> ${childClass})`);
    if (step.gate) {
      if (!overridden.gate) throw new Error(`${source}: ${name}의 게이트를 제거할 수 없습니다: ${step.id}`);
      if (canonicalJson(overridden.gate) !== canonicalJson(step.gate)) throw new Error(`${source}: ${name}의 게이트 명령은 바꿀 수 없습니다: ${step.id}`);
    }
    validateOnFailOverride(name, step, overridden, source);
    validateVerificationOverride(name, step, overridden, source);
    validateRetrySafetyOverride(name, step, overridden, source);
    validateAllowOverride(name, step, overridden, source);
    if (step.human && !overridden.human) throw new Error(`${source}: ${name}의 사람 게이트를 제거할 수 없습니다: ${step.id}`);
  }
  // 부모 스텝의 상대 순서는 유지되어야 한다. 사이에 새 스텝을 끼우는 것은 허용된다.
  const order = child.steps.map((step) => step.id).filter((id) => parentSteps.has(id));
  const expected = parent.steps.map((step) => step.id);
  if (canonicalJson(order) !== canonicalJson(expected)) throw new Error(`${source}: ${name}의 부모 스텝 순서를 바꿀 수 없습니다.`);
}

function stepClass(step) {
  if (step.human === true) return 'human';
  if (step.gate) return 'gate';
  if (step.executor === 'adapter' || step.adapter) return 'adapter';
  if (step.executor === 'cli') return 'cli';
  return 'client';
}

function validateOnFailOverride(name, parent, child, source) {
  if (!parent.onFail) return;
  if (!child.onFail) throw new Error(`${source}: ${name}의 onFail을 제거할 수 없습니다: ${parent.id}`);
  if (child.onFail.goto !== parent.onFail.goto) throw new Error(`${source}: ${name}의 onFail.goto를 변경할 수 없습니다: ${parent.id}`);
  if (child.onFail.maxAttempts > parent.onFail.maxAttempts) throw new Error(`${source}: ${name}의 시도 상한은 늘릴 수 없습니다: ${parent.id}`);
  for (const [key, value] of Object.entries(parent.onFail)) {
    if (key === 'maxAttempts' || key === 'goto') continue;
    if (canonicalJson(child.onFail[key]) !== canonicalJson(value)) {
      throw new Error(`${source}: ${name}의 onFail.${key} 계약을 변경할 수 없습니다: ${parent.id}`);
    }
  }
}

function lensIds(step) {
  const value = Array.isArray(step.lenses) ? step.lenses : (step.verify && Array.isArray(step.verify.lenses) ? step.verify.lenses : []);
  return value.map(String);
}

function thresholdValue(step, key) {
  if (Number.isInteger(step[key])) return step[key];
  if (step.verify && Number.isInteger(step.verify[key])) return step.verify[key];
  return null;
}

// 조임 방향은 필드마다 다르다. 검증자와 정족수는 커질수록 조이고, 허용 반박과
// 기권은 작아질수록 조이며, 다양성 요구는 켜는 것이 조인다. 하나의 비교로 전부
// 판정하려 하면 반드시 한쪽이 뒤집힌다.
//
// 목록에 없는 정책 필드는 통과시키지 않고 거부한다. 조용히 빠지면 새 손잡이가
// 생길 때마다 그것만 단조성 밖에 남고, 남았다는 사실은 아무도 모른다.
const POLICY_DIRECTION = Object.freeze({
  validators: 'higher',
  quorum: 'higher',
  maxRefuted: 'lower',
  maxAbstain: 'lower',
  refutedThreshold: 'lower',
  abstainThreshold: 'lower',
  requireAdapterDiversity: 'enable'
});

function verifyPolicy(step) {
  return (step.verify && step.verify.policy) || null;
}

// 검증 정책은 verify.policy 안에 산다. 예전 판정은 step.verify[key]를 봤고 그
// 자리에는 값이 없었으므로, 검증자도 정족수도 반박 상한도 전부 검사를 받지 않고
// 지나갔다. 완화가 통과한다는 것을 시험으로 고정한 뒤에 이 판정을 들였다.
function assertPolicyMonotonic(name, parent, child, source) {
  const parentPolicy = verifyPolicy(parent);
  if (!parentPolicy) return;
  const childPolicy = verifyPolicy(child);
  if (!childPolicy) throw new Error(`${source}: ${name}의 검증 정책을 제거할 수 없습니다: ${parent.id}`);
  for (const key of Object.keys(parentPolicy)) {
    const direction = POLICY_DIRECTION[key];
    if (!direction) throw new Error(`${source}: ${name}의 검증 정책 ${key}에 조임 방향이 선언되지 않았습니다: ${parent.id}`);
    const from = parentPolicy[key];
    const to = childPolicy[key];
    if (to === undefined) throw new Error(`${source}: ${name}의 ${key}를 제거할 수 없습니다: ${parent.id}`);
    if (direction === 'enable') {
      if (from === true && to !== true) throw new Error(`${source}: ${name}의 ${key}를 끌 수 없습니다: ${parent.id}`);
      continue;
    }
    if (!Number.isInteger(from)) continue;
    if (!Number.isInteger(to)) throw new Error(`${source}: ${name}의 ${key}는 정수여야 합니다: ${parent.id}`);
    const loosened = direction === 'higher' ? to < from : to > from;
    if (loosened) throw new Error(`${source}: ${name}의 ${key}를 완화할 수 없습니다: ${parent.id} (${from} -> ${to})`);
  }
}

// 파이프 허용정책. 프로젝트 모드 하나로는 부족하다 — 같은 프로젝트 안에서도 문서를
// 쓰는 구간과 그것을 밖으로 내보내는 구간은 되돌릴 수 있는 정도가 다르다.
//
// 동시에 구간마다 자유롭게 정할 수 있으면 프로젝트 모드는 선언에 그친다. "이 프로젝트는
// 사람만"이라 적어 두고 스텝마다 풀어 두는 것이 가능하면 모드는 아무것도 보장하지 않는다.
// 그래서 모드가 바닥이고 스텝은 그 위에서 조이기만 한다.
//
// 조임 방향이 손잡이마다 다르다. 검증자 수는 클수록 조이고 허용 실행 주체는 적을수록
// 조인다. 하나의 비교로 전부 판정하려 하면 반드시 한쪽이 뒤집힌다.
const ALLOW_DIRECTION = Object.freeze({
  executors: 'subset',
  humanGate: 'gate',
  minValidators: 'higher',
  requireDiversity: 'enable'
});
const HUMAN_GATE_RANK = Object.freeze({ optional: 0, required: 1 });

function validateAllowOverride(name, parent, child, source) {
  if (!parent.allow) return;
  if (!child.allow) throw new Error(`${source}: ${name}의 허용정책을 제거할 수 없습니다: ${parent.id}`);
  for (const key of Object.keys(parent.allow)) {
    const direction = ALLOW_DIRECTION[key];
    if (!direction) throw new Error(`${source}: ${name}의 허용정책 ${key}에 조임 방향이 선언되지 않았습니다: ${parent.id}`);
    const from = parent.allow[key];
    const to = child.allow[key];
    if (to === undefined) throw new Error(`${source}: ${name}의 ${key}를 제거할 수 없습니다: ${parent.id}`);
    if (direction === 'subset') {
      const allowed = new Set(Array.isArray(from) ? from : []);
      for (const value of Array.isArray(to) ? to : []) {
        // 허용 주체를 늘리는 것은 푸는 일이다. 부모가 허락하지 않은 주체를 자식이
        // 들이면, 바닥이 막아 둔 실행 경로가 스텝 하나로 열린다.
        if (!allowed.has(value)) throw new Error(`${source}: ${name}의 ${key}에 허용되지 않은 주체를 더할 수 없습니다: ${parent.id} (${value})`);
      }
      continue;
    }
    if (direction === 'gate') {
      const fromRank = HUMAN_GATE_RANK[from];
      const toRank = HUMAN_GATE_RANK[to];
      if (toRank === undefined) throw new Error(`${source}: ${name}의 ${key} 값이 유효하지 않습니다: ${parent.id} (${to})`);
      if (toRank < fromRank) throw new Error(`${source}: ${name}의 ${key}를 완화할 수 없습니다: ${parent.id} (${from} -> ${to})`);
      continue;
    }
    if (direction === 'enable') {
      if (from === true && to !== true) throw new Error(`${source}: ${name}의 ${key}를 끌 수 없습니다: ${parent.id}`);
      continue;
    }
    if (!Number.isInteger(from)) continue;
    if (!Number.isInteger(to)) throw new Error(`${source}: ${name}의 ${key}는 정수여야 합니다: ${parent.id}`);
    if (to < from) throw new Error(`${source}: ${name}의 ${key}를 완화할 수 없습니다: ${parent.id} (${from} -> ${to})`);
  }
}

// 모드가 정한 바닥을 스텝 허용정책이 어기지 않는지 본다. 바닥은 판정에만 쓰고 스텝에
// 저장하지 않는다 — 저장하면 모드를 바꿨을 때 굳어 버린 옛 바닥이 스텝에 남는다.
function assertAllowWithinFloor(name, step, floor, source) {
  if (!floor || !step.allow) return;
  if (Number.isInteger(floor.validators) && Number.isInteger(step.allow.minValidators) && step.allow.minValidators < floor.validators) {
    throw new Error(`${source}: ${name}의 ${step.id}가 바닥보다 검증자를 적게 요구합니다: 바닥 ${floor.validators}, 시도 ${step.allow.minValidators}`);
  }
  if (floor.requireAdapterDiversity === true && step.allow.requireDiversity !== true) {
    throw new Error(`${source}: ${name}의 ${step.id}가 바닥이 요구한 다양성을 끕니다.`);
  }
}

function validateVerificationOverride(name, parent, child, source) {
  const childLenses = new Set(lensIds(child));
  for (const lens of lensIds(parent)) {
    if (!childLenses.has(lens)) throw new Error(`${source}: ${name}의 검증 lens를 제거할 수 없습니다: ${parent.id} (${lens})`);
  }
  for (const key of ['refutedThreshold', 'abstainThreshold', 'maxRefuted', 'maxAbstain']) {
    const parentValue = thresholdValue(parent, key);
    if (parentValue === null) continue;
    const childValue = thresholdValue(child, key);
    if (childValue === null || childValue > parentValue) {
      throw new Error(`${source}: ${name}의 ${key} 상한을 완화할 수 없습니다: ${parent.id}`);
    }
  }
  assertPolicyMonotonic(name, parent, child, source);
}

function operationPlaceholderCount(step) {
  return (step.args || []).reduce((total, value) => total + (String(value).match(/\{operationId\}/gu) || []).length, 0);
}

function validateRetrySafetyOverride(name, parent, child, source) {
  if (!parent.retrySafety) return;
  if (!child.retrySafety) throw new Error(`${source}: ${name}의 retrySafety를 제거할 수 없습니다: ${parent.id}`);
  if (child.retrySafety.mode !== parent.retrySafety.mode) throw new Error(`${source}: ${name}의 retrySafety.mode을 변경할 수 없습니다: ${parent.id}`);
  if (parent.retrySafety.mode === 'gate-recheck' && canonicalJson(child.retrySafety) !== canonicalJson(parent.retrySafety)) {
    throw new Error(`${source}: ${name}의 gate-recheck 계약을 변경할 수 없습니다: ${parent.id}`);
  }
  const parentPlaceholders = operationPlaceholderCount(parent);
  const childPlaceholders = operationPlaceholderCount(child);
  if (parentPlaceholders !== childPlaceholders) {
    throw new Error(`${source}: ${name}의 operationId placeholder를 제거하거나 중복할 수 없습니다: ${parent.id}`);
  }
}

function validateClosedDriveGate(step, origin) {
  if (!step.gate || step.gate.command !== 'check' || !Array.isArray(step.gate.args)) throw new Error(`${origin}: ${step.id} drive gate must use check with an argv array`);
  const seen = new Set();
  let artifactCount = 0;
  for (let index = 0; index < step.gate.args.length; index += 1) {
    const value = String(step.gate.args[index]);
    if (value === '--project') {
      if (seen.has(value)) throw new Error(`${origin}: ${step.id} drive gate contains duplicate --project`);
      seen.add(value);
      const project = String(step.gate.args[++index] || '');
      if (project !== '{project}') throw new Error(`${origin}: ${step.id} drive gate has an invalid --project contract`);
    } else if (value === '--strict' || value === '--structure') {
      if (seen.has(value)) throw new Error(`${origin}: ${step.id} drive gate contains duplicate ${value}`);
      seen.add(value);
    } else if (value === '{artifact}') {
      artifactCount += 1;
      if (artifactCount > 1) throw new Error(`${origin}: ${step.id} drive gate accepts at most one artifact ID`);
    } else throw new Error(`${origin}: ${step.id} drive gate argument is outside the closed read-only allowlist: ${value}`);
  }
  if (artifactCount !== 1) throw new Error(`${origin}: ${step.id} drive gate must contain exactly one canonical artifact placeholder`);
  return step;
}

// 되풀이해도 같은 곳에 도착하는 명령의 닫힌 목록. 여기 없는 명령에 converging을
// 선언하면 거부한다 — 검사할 수 없는 안전 주장을 받지 않는다.
const CONVERGING_COMMANDS = new Set(['save']);

// 커밋을 만들고 그 커밋을 --json으로 답하는 명령의 닫힌 목록. step-output-commit은
// 이 목록의 스텝만 지목할 수 있다 — 커밋을 만들지 않는 스텝을 가리키면 검증은
// 결박될 곳이 없고, 그 자리는 조용히 "지금 HEAD"로 채워진다.
const COMMIT_PRODUCING_COMMANDS = new Set(['save']);

function validateDriveSafety(procedure, source) {
  const origin = source || procedure.name || 'procedure';
  const steps = new Map(procedure.steps.map((step) => [step.id, step]));
  const order = procedure.steps.map((step) => step.id);
  for (const step of procedure.steps) {
    const pin = step.verify && step.verify.revisionPin;
    if (pin !== undefined && !validRevisionPin(pin)) throw new Error(`${origin}: ${step.id}.verify.revisionPin은 run-start-head이거나, 산출 스텝을 지목한 step-output-commit이어야 합니다.`);
    if (pin && pin.strategy === 'step-output-commit') {
      const producer = steps.get(pin.step);
      // 지목된 스텝은 이 검증보다 먼저 돌아야 하고, 커밋을 만들 수 있는 스텝이어야
      // 한다. 뒤에 있거나 커밋을 만들지 않는 스텝을 가리키면 검증은 결박될 곳이 없다.
      if (!producer) throw new Error(`${origin}: ${step.id}.verify.revisionPin이 없는 스텝을 지목합니다: ${pin.step}`);
      if (order.indexOf(pin.step) >= order.indexOf(step.id)) throw new Error(`${origin}: ${step.id}.verify.revisionPin은 앞선 스텝만 지목할 수 있습니다: ${pin.step}`);
      if (producer.executor !== 'cli' || !COMMIT_PRODUCING_COMMANDS.has(producer.command)) throw new Error(`${origin}: ${step.id}.verify.revisionPin이 커밋을 만드는 스텝이 아닙니다: ${pin.step}`);
    }
    if (step.retrySafety !== undefined) {
      if (!step.retrySafety || typeof step.retrySafety !== 'object' || Array.isArray(step.retrySafety)) throw new Error(`${origin}: ${step.id}.retrySafety는 객체여야 합니다.`);
      const keys = Object.keys(step.retrySafety).sort();
      if (step.retrySafety.mode === 'operation-id') {
        if (canonicalJson(keys) !== canonicalJson(['mode'])) throw new Error(`${origin}: ${step.id}.retrySafety operation-id에는 mode만 허용됩니다.`);
        const placeholders = operationPlaceholderCount(step);
        if (step.executor === 'cli' && placeholders !== 1) throw new Error(`${origin}: ${step.id} CLI operation-id 스텝은 {operationId} placeholder를 정확히 한 번 사용해야 합니다.`);
        if (step.executor === 'adapter' && placeholders !== 0) throw new Error(`${origin}: ${step.id} adapter operation-id는 argv placeholder를 사용할 수 없습니다.`);
      } else if (step.retrySafety.mode === 'gate-recheck') {
        if (canonicalJson(keys) !== canonicalJson(['gateStep', 'mode']) || !/^[a-z][a-z0-9-]*$/u.test(step.retrySafety.gateStep || '')) {
          throw new Error(`${origin}: ${step.id}.retrySafety gate-recheck에는 유효한 gateStep이 필요합니다.`);
        }
        const gate = steps.get(step.retrySafety.gateStep);
        if (!gate || !gate.gate || gate.human === true || gate.executor === 'adapter' || gate.verify || gate.lenses) {
          throw new Error(`${origin}: ${step.id}.retrySafety gateStep은 결정적 비인간 게이트여야 합니다.`);
        }
      } else if (step.retrySafety.mode === 'converging') {
        if (canonicalJson(keys) !== canonicalJson(['mode'])) throw new Error(`${origin}: ${step.id}.retrySafety converging에는 mode만 허용됩니다.`);
        if (step.executor !== 'cli') throw new Error(`${origin}: ${step.id} converging은 cli 스텝에만 쓸 수 있습니다.`);
        if (!CONVERGING_COMMANDS.has(step.command)) throw new Error(`${origin}: ${step.id} converging 허용 목록에 없는 명령입니다: ${step.command || '(없음)'}`);
        if (operationPlaceholderCount(step) !== 0) throw new Error(`${origin}: ${step.id} converging 스텝은 {operationId}를 쓰지 않습니다.`);
      } else throw new Error(`${origin}: ${step.id}.retrySafety.mode은 operation-id, gate-recheck 또는 converging이어야 합니다.`);
    }
  }
  if (procedure.idempotent === true) {
    for (const step of procedure.steps) {
      const classes = [step.human === true, Boolean(step.gate), step.executor === 'cli', step.executor === 'adapter'].filter(Boolean).length;
      if (classes !== 1) throw new Error(`${origin}: idempotent procedure step ${step.id} must have exactly one drive class`);
      if (step.human === true) continue;
      if (step.gate) { validateClosedDriveGate(step, origin); continue; }
      if (!['cli', 'adapter'].includes(step.executor)) throw new Error(`${origin}: idempotent 절차의 ${step.id}은 drive 가능한 cli 또는 adapter 스텝이어야 합니다.`);
      if (!step.retrySafety) throw new Error(`${origin}: idempotent 절차의 ${step.id}에는 retrySafety가 필요합니다.`);
    }
  }
  return procedure;
}

function pinProcedureInstructions(procedure, source) {
  const copy = JSON.parse(JSON.stringify(procedure));
  for (const step of copy.steps) {
    assertFanOut(step, source);
    if (step.instruction !== undefined) {
      const entry = resolveInstructionPin(step.instruction, { mode: 'author' });
      step.instruction = pinInstruction(entry.id);
    }
    if (!step.verify || !Array.isArray(step.verify.lenses)) continue;
    const instructions = step.verify.instructions || {};
    const pinned = {};
    for (const lensId of step.verify.lenses) {
      const expected = getLens(lensId);
      const entry = resolveInstructionPin(instructions[lensId] || expected.instructionId, { mode: 'verify', lensId });
      pinned[lensId] = pinInstruction(entry.id);
    }
    const extras = Object.keys(instructions).filter((lensId) => !step.verify.lenses.includes(lensId));
    if (extras.length) throw new Error(`${source}: ${step.id}.verify.instructions에 선언되지 않은 lens가 있습니다: ${extras.join(', ')}`);
    step.verify.instructions = pinned;
    assertDiversitySatisfiable(step, source);
  }
  return copy;
}

// 검증이 무엇을 판정할지 정하는 방법은 둘뿐이다. run 시작 시점의 커밋을 굳히거나
// (저작 없는 절차), 절차 안의 어느 스텝이 만든 커밋을 지목하거나(저작 있는 절차).
// "지금 HEAD"는 방법이 아니다 — 그것은 하네스가 아니라 주변이 정하는 값이고,
// 런 도중 다른 프로세스가 커밋하면 저작 결과가 아닌 것이 판정 대상이 된다.
// fan-out 스텝은 같은 스텝을 여러 대상에 동시에 수행한다고 선언한다.
//
// 대상 목록을 절차가 직접 적지 않는 이유는, 적어 두면 그 목록이 계약과 따로 늙기
// 때문이다. 어느 문서가 지금 저작 가능한지는 계약 평가가 매번 다시 계산하고, 절차는
// 그 계산을 쓰겠다고만 말한다.
const FAN_OUT_SOURCES = Object.freeze(['contract-ready']);

function assertFanOut(step, source) {
  if (step.fanOut === undefined) return;
  const value = step.fanOut;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: ${step.id}.fanOut은 객체여야 합니다.`);
  const keys = Object.keys(value).sort();
  for (const key of keys) if (!['over', 'maxConcurrency'].includes(key)) throw new Error(`${source}: ${step.id}.fanOut에 지원하지 않는 필드가 있습니다: ${key}`);
  if (!FAN_OUT_SOURCES.includes(value.over)) throw new Error(`${source}: ${step.id}.fanOut.over는 ${FAN_OUT_SOURCES.join(' 또는 ')}여야 합니다.`);
  if (value.maxConcurrency !== undefined && (!Number.isSafeInteger(value.maxConcurrency) || value.maxConcurrency < 1 || value.maxConcurrency > 8)) {
    throw new Error(`${source}: ${step.id}.fanOut.maxConcurrency는 1-8의 정수여야 합니다.`);
  }
  // 저작만 fan-out한다. 게이트와 저장은 대상 전체를 한 번에 다루는 스텝이고,
  // 대상마다 나누면 그 스텝이 무엇을 판정했는지가 대상 수만큼 흩어진다.
  if (step.executor !== 'adapter' || step.verify) throw new Error(`${source}: ${step.id}.fanOut은 저작 adapter 스텝에만 선언할 수 있습니다.`);
}

// 만족될 수 없는 다양성 요구는 절차를 읽을 때 거부한다. 런타임에 실패로 나타나게
// 두면 오설정과 정상 판정이 같은 얼굴을 한다 — 결과가 계속 "사람 판단 필요"로
// 나오는데, 켠 사람은 그것이 판정인지 자기 설정 실수인지 알 수 없다.
//
// 여기서 보는 것은 구조뿐이다. 어댑터가 실제로 활성인지는 설정이 답하므로 검증
// 실행 시점에 다시 묻는다. 절차만으로 이미 틀린 것을 절차에서 잡는다.
function declaredAdapters(step, lensId) {
  const verify = step.verify || {};
  const perLens = verify.lensAdapters && verify.lensAdapters[lensId];
  const value = perLens !== undefined ? perLens : (verify.adapters !== undefined ? verify.adapters : (verify.adapter !== undefined ? verify.adapter : step.adapter));
  if (value === undefined || value === null) return null;
  const names = (Array.isArray(value) ? value : [value]).map((item) => String(item || "").trim()).filter(Boolean);
  return names.length ? Array.from(new Set(names)) : null;
}

function assertDiversitySatisfiable(step, source) {
  const policy = (step.verify && step.verify.policy) || null;
  if (!policy) return;
  for (const lensId of step.verify.lenses) {
    const perLens = (policy.perLens && policy.perLens[lensId]) || (policy.lensPolicies && policy.lensPolicies[lensId]) || policy;
    if (perLens.requireAdapterDiversity !== true) continue;
    const quorum = perLens.quorum === undefined ? 1 : perLens.quorum;
    const validators = perLens.validators === undefined ? 1 : perLens.validators;
    if (validators < quorum) throw new Error(`${source}: ${step.id}.verify의 ${lensId}는 validators(${validators})가 quorum(${quorum})보다 적어 다양성을 만족시킬 수 없습니다.`);
    const names = declaredAdapters(step, lensId);
    // 어댑터를 고정하지 않은 절차는 설정의 기본 어댑터 하나로 돈다. 그 하나로는
    // 다양성을 만족시킬 수 없으므로, 목록을 적지 않은 것도 여기서 거부한다.
    const count = names ? names.length : 1;
    if (count < quorum) throw new Error(`${source}: ${step.id}.verify의 ${lensId}는 requireAdapterDiversity에 quorum(${quorum}) 이상의 어댑터가 필요한데 ${count}개만 고정되어 있습니다.`);
  }
}

function validRevisionPin(pin) {
  if (!pin || typeof pin !== 'object') return false;
  const keys = Object.keys(pin).sort();
  if (pin.strategy === 'run-start-head') return canonicalJson(keys) === canonicalJson(['strategy']);
  if (pin.strategy === 'step-output-commit') return canonicalJson(keys) === canonicalJson(['step', 'strategy']) && NAME.test(String(pin.step || ''));
  return false;
}

function pinProcedureVerificationRevision(procedure, reviewedRevision) {
  if (!/^[a-f0-9]{40,64}$/u.test(reviewedRevision || '')) throw new Error('verification revision pin must be a lowercase Git revision');
  const copy = JSON.parse(JSON.stringify(procedure));
  for (const step of copy.steps) {
    if (!step.verify && !Array.isArray(step.lenses)) continue;
    const verify = step.verify || (step.verify = {});
    if (verify.revisionPin !== undefined && !validRevisionPin(verify.revisionPin)) {
      throw new Error(`${step.id}.verify.revisionPin must declare run-start-head, or step-output-commit with a producing step`);
    }
    // step-output-commit은 run 시작 시점에 풀 수 없다 — 그 커밋은 아직 없다.
    // 검증 스텝이 도는 시점에 원장이 "그 스텝이 만든 커밋"으로 답한다.
    if (verify.revisionPin && verify.revisionPin.strategy === 'step-output-commit') continue;
    verify.revisionPin = { strategy: 'git-commit', reviewedRevision };
  }
  return copy;
}

// 유효 절차의 단일 소스: 내장 → Workspace → 프로젝트를 병합한 resolved 목록을
// 한 곳에서 계산한다. show, check, run이 전부 이 함수만 소비해야 하며, 어떤
// 소비자도 이름 목록이나 병합 규칙을 따로 계산하지 않는다.
// 프로젝트가 고른 모드가 모든 스텝의 바닥이 된다. 바닥이 없으면 제약하지 않는다 —
// 여기서 가장 조인 쪽을 기본으로 두면 절차가 통째로 얼어붙고, 그러면 사람들이 바닥을
// 꺼 버린다. 꺼진 바닥은 없는 바닥보다 나쁘다.
//
// 바닥은 판정에만 쓰고 스텝에 저장하지 않는다. 저장하면 모드를 바꿨을 때 굳어 버린
// 옛 바닥이 스텝에 남아, 모드를 조여도 스텝이 옛 값으로 통과한다.
function resolveApprovalFloor(start, projectKey) {
  if (!projectKey) return null;
  let presentation;
  try { presentation = loadBoardPresentation(start, projectKey); }
  catch (error) { return null; }
  const approval = presentation && presentation.approval;
  if (!approval) return null;
  // 바닥은 작업공간이 깔고 모드는 프로젝트가 고른다. 병합된 결과에서 둘 다 읽되,
  // 실제 제약은 더 조인 쪽이 이긴다 — 바닥보다 조인 모드를 골랐으면 그 모드가 바닥이다.
  const names = [approval.floor, approval.mode].filter(Boolean);
  if (!names.length) return null;
  let tightest = null;
  for (const name of names) {
    let policy;
    try { policy = floorPolicy(name); } catch (error) { continue; }
    if (!tightest) { tightest = policy; continue; }
    tightest = {
      validators: Math.max(tightest.validators, policy.validators),
      quorum: Math.max(tightest.quorum, policy.quorum),
      requireAdapterDiversity: tightest.requireAdapterDiversity || policy.requireAdapterDiversity
    };
  }
  return tightest;
}

// 바닥은 올리는 것이지 벽이 아니다. 바닥보다 낮은 선언을 거부하면, 조직이 바닥을 까는
// 순간 내장 절차가 로드에 실패한다 — 내장은 검증자 하나를 선언하고 있으므로 바닥을
// 둘로 두면 아무 절차도 열리지 않는다. 그러면 사람들은 바닥을 꺼 버린다.
//
// 그래서 두 기제를 다르게 다룬다. 계층 오버라이드(작업공간 → 프로젝트)는 푸는 것을
// 거부하고, 모드 바닥은 값을 끌어올린다. 앞엣것은 사람이 적은 것을 지키는 일이고
// 뒤엣것은 조직 표준을 적용하는 일이라, 같은 규칙으로 다루면 한쪽이 반드시 어색해진다.
//
// 올린 값은 해석 결과에만 있고 파일에는 없다. 모드를 되돌리면 원래 값으로 돌아간다.
function liftToFloor(procedure, floor) {
  if (!floor) return procedure;
  let touched = false;
  const steps = procedure.steps.map((step) => {
    const policy = step.verify && step.verify.policy;
    if (!policy) return step;
    const lifted = Object.assign({}, policy);
    if (Number.isInteger(floor.validators) && Number.isInteger(lifted.validators) && lifted.validators < floor.validators) lifted.validators = floor.validators;
    if (Number.isInteger(floor.quorum) && Number.isInteger(lifted.quorum) && lifted.quorum < floor.quorum) lifted.quorum = floor.quorum;
    if (floor.requireAdapterDiversity === true && lifted.requireAdapterDiversity !== true) lifted.requireAdapterDiversity = true;
    // 정족수는 검증자를 넘을 수 없다. 바닥이 검증자만 올리고 정족수를 그대로 두면
    // 통과 불가능한 정책이 만들어지고, 그 절차는 영원히 완주하지 못한다.
    if (Number.isInteger(lifted.quorum) && Number.isInteger(lifted.validators) && lifted.quorum > lifted.validators) lifted.quorum = lifted.validators;
    if (JSON.stringify(lifted) === JSON.stringify(policy)) return step;
    touched = true;
    return Object.assign({}, step, { verify: Object.assign({}, step.verify, { policy: lifted }) });
  });
  return touched ? Object.assign({}, procedure, { steps }) : procedure;
}

function loadProcedures(start, projectKey) {
  const layout = workspaceLayout(start);
  const layers = [{ source: '내장', procedures: BUILTIN }];
  if (layout.schemaVersion >= 6) {
    layers.push({ source: 'projects/workspace/procedures.json', procedures: readProceduresFile(proceduresFile(path.join(layout.root, 'projects', 'workspace'))) });
  }
  if (projectKey) {
    const project = selectProject(layout, projectKey, true);
    layers.push({ source: `projects/${project.key}/procedures.json`, procedures: readProceduresFile(proceduresFile(project.root)) });
  }
  const floor = resolveApprovalFloor(start, projectKey);
  const resolved = new Map();
  for (const layer of layers) {
    for (const [name, definition] of Object.entries(layer.procedures)) {
      if (!NAME.test(name)) throw new Error(`${layer.source}: 잘못된 절차 이름입니다: ${name}`);
      const pinned = pinProcedureInstructions(Object.assign({ name }, definition), layer.source);
      const candidate = validateDriveSafety(validateProcedure(pinned), layer.source);
      for (const step of candidate.steps) assertAllowWithinFloor(name, step, floor, layer.source);
      const raised = liftToFloor(candidate, floor);
      const parent = resolved.get(name);
      if (parent) validateOverride(name, parent.definition, raised, layer.source);
      resolved.set(name, { definition: raised, source: layer.source });
    }
  }
  return {
    names: Array.from(resolved.keys()).sort(),
    resolve(name) {
      const entry = resolved.get(name);
      if (!entry) throw new Error(`등록되지 않은 절차입니다: ${name}. 사용 가능: ${Array.from(resolved.keys()).sort().join(', ')}`);
      const definition = entry.definition;
      return {
        name,
        source: entry.source,
        resolved: definition,
        contentHash: crypto.createHash('sha256').update(canonicalJson(definition)).digest('hex')
      };
    }
  };
}

// placeholder 치환은 args 원소 값 안에서만 일어나고 셸을 경유하지 않는다.
function substituteArgs(args, context) {
  return (args || []).map((value) => String(value).replace(/\{(project|runId|artifact)\}/gu, (whole, key) => {
    if (context[key] === undefined || context[key] === null) throw new Error(`치환할 값이 없습니다: {${key}}`);
    return String(context[key]);
  }));
}

module.exports = { BUILTIN, ALLOW_DIRECTION, liftToFloor, resolveApprovalFloor, validateAllowOverride, assertAllowWithinFloor, loadProcedures, substituteArgs, validateOverride, validateDriveSafety, validateClosedDriveGate, pinProcedureInstructions, pinProcedureVerificationRevision, COMMIT_PRODUCING_COMMANDS };
