'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { canonicalJson, validateProcedure } = require('./run-ledger');

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
    if (step.gate) {
      if (!overridden.gate) throw new Error(`${source}: ${name}의 게이트를 제거할 수 없습니다: ${step.id}`);
      if (canonicalJson(overridden.gate) !== canonicalJson(step.gate)) throw new Error(`${source}: ${name}의 게이트 명령은 바꿀 수 없습니다: ${step.id}`);
      if (step.onFail && overridden.onFail && overridden.onFail.maxAttempts > step.onFail.maxAttempts) {
        throw new Error(`${source}: ${name}의 시도 상한은 늘릴 수 없습니다: ${step.id}`);
      }
    }
    if (step.human && !overridden.human) throw new Error(`${source}: ${name}의 사람 게이트를 제거할 수 없습니다: ${step.id}`);
  }
  // 부모 스텝의 상대 순서는 유지되어야 한다. 사이에 새 스텝을 끼우는 것은 허용된다.
  const order = child.steps.map((step) => step.id).filter((id) => parentSteps.has(id));
  const expected = parent.steps.map((step) => step.id);
  if (canonicalJson(order) !== canonicalJson(expected)) throw new Error(`${source}: ${name}의 부모 스텝 순서를 바꿀 수 없습니다.`);
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
      const candidate = validateProcedure(Object.assign({ name }, definition));
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

module.exports = { BUILTIN, loadProcedures, substituteArgs, validateOverride };
