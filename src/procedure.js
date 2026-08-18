'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { canonicalJson, validateProcedure } = require('./run-ledger');
const { getLens, pinInstruction, resolveInstructionPin } = require('./instruction-registry');

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
      { id: 'save', executor: 'cli', command: 'save', args: ['--project', '{project}'], retrySafety: { mode: 'converging' } },
      {
        id: 'verify',
        executor: 'adapter',
        verify: {
          lenses: ['satisfaction-v1', 'omission-v1', 'boundary-v1'],
          instructions: pinnedLensInstructions(['satisfaction-v1', 'omission-v1', 'boundary-v1']),
          // 저작이 만든 커밋을 검증한다. run 시작 시점으로 굳히면 저작 결과를
          // 볼 수 없고, 그러면 이 절차는 저작을 포함한 채 완주할 수 없다.
          revisionPin: { strategy: 'step-head' },
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

function validateDriveSafety(procedure, source) {
  const origin = source || procedure.name || 'procedure';
  const steps = new Map(procedure.steps.map((step) => [step.id, step]));
  for (const step of procedure.steps) {
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
  }
  return copy;
}

function pinProcedureVerificationRevision(procedure, reviewedRevision) {
  if (!/^[a-f0-9]{40,64}$/u.test(reviewedRevision || '')) throw new Error('verification revision pin must be a lowercase Git revision');
  const copy = JSON.parse(JSON.stringify(procedure));
  for (const step of copy.steps) {
    if (!step.verify && !Array.isArray(step.lenses)) continue;
    const verify = step.verify || (step.verify = {});
    if (verify.revisionPin !== undefined && (
      !verify.revisionPin || !['run-start-head', 'step-head'].includes(verify.revisionPin.strategy) ||
      Object.keys(verify.revisionPin).some((key) => key !== 'strategy')
    )) throw new Error(`${step.id}.verify.revisionPin must declare run-start-head or step-head`);
    // step-head는 검증 스텝이 도는 시점에 풀린다. 여기서 굳히면 저작이 만든
    // 커밋을 볼 수 없다.
    if (verify.revisionPin && verify.revisionPin.strategy === 'step-head') continue;
    verify.revisionPin = { strategy: 'git-commit', reviewedRevision };
  }
  return copy;
}

// 유효 절차의 단일 소스: 내장 → Workspace → 프로젝트를 병합한 resolved 목록을
// 한 곳에서 계산한다. show, check, run이 전부 이 함수만 소비해야 하며, 어떤
// 소비자도 이름 목록이나 병합 규칙을 따로 계산하지 않는다.
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
  const resolved = new Map();
  for (const layer of layers) {
    for (const [name, definition] of Object.entries(layer.procedures)) {
      if (!NAME.test(name)) throw new Error(`${layer.source}: 잘못된 절차 이름입니다: ${name}`);
      const pinned = pinProcedureInstructions(Object.assign({ name }, definition), layer.source);
      const candidate = validateDriveSafety(validateProcedure(pinned), layer.source);
      const parent = resolved.get(name);
      if (parent) validateOverride(name, parent.definition, candidate, layer.source);
      resolved.set(name, { definition: candidate, source: layer.source });
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

module.exports = { BUILTIN, loadProcedures, substituteArgs, validateOverride, validateDriveSafety, validateClosedDriveGate, pinProcedureInstructions, pinProcedureVerificationRevision };
