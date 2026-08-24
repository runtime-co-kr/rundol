'use strict';

// workflows.json을 읽어 판정이 쓸 워크플로를 만든다. 파일을 아는 유일한 자리다.
//
// workflow.js가 파일을 읽지 않기로 한 규율을 지키려면 읽는 층이 따로 있어야 한다.
// check-rules.js가 유형 정의를 넘겨받고 check.js가 읽는 일을 맡는 것과 같은 갈라섬이며,
// 갈라 두면 판정이 어느 저장소에서 돌든 같은 답을 낸다.
//
// board.json과 파일을 나눈 이유는 두 파일이 다른 물음에 답하기 때문이다.
// board.json은 무엇을 보여줄지를 정하고 이 파일은 무엇이 허용되는지를 정한다.
// 섞으면 라벨 한 줄을 고치다 전환 규칙을 건드리게 되고, 그 사고는 화면에서 난다.
//
// 바인딩도 이 파일이 든다. 유형이 어느 흐름을 타는가는 표시가 아니라 허용이고,
// 흐름 배정을 워크플로 정의 옆에 두어야 JSON 한 덩어리로 전체가 읽힌다.

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { normalizeWorkflows, mergeWorkflows, createWorkflow, TASK_NODES } = require('./workflow');
const { TARGET_KINDS } = require('./vocabulary');

const FILE_NAME = 'workflows.json';
const ROOT_KEYS = Object.freeze(['schemaVersion', 'workflows', 'bindings']);
// 유형을 하나씩 적지 않고 기본을 하나 두는 자리. 문서 유형 열하나 중 열이 같은
// 흐름을 쓰는 것이 지금 실측이고, 그 열을 열 줄로 적으면 하나를 고칠 때 열 곳을
// 고쳐야 한다.
const BINDING_FALLBACK = '*';

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: JSON을 읽지 못했습니다: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}: 최상위는 객체여야 합니다.`);
  for (const key of Object.keys(parsed)) {
    if (!ROOT_KEYS.includes(key)) throw new Error(`${file}: ${key}: 알 수 없는 키입니다. 쓸 수 있는 것: ${ROOT_KEYS.join(' · ')}`);
  }
  // 버전을 추측하지 않는다. 없는 것과 모르는 것은 다르고, 모르는 판을 지금 판으로
  // 읽으면 다음 판이 늘린 칸을 이 코드가 조용히 버린다.
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
    throw new Error(`${file}: 지원하지 않는 workflows.json schemaVersion입니다: ${parsed.schemaVersion}`);
  }
  return parsed;
}

/**
 * 유형이 어느 워크플로를 타는가. 대상 종류마다 표가 하나씩이고 `*`가 기본이다.
 *
 * 없는 워크플로를 가리키면 여기서 막는다. 판정 시점까지 끌고 가면 그 유형의 항목은
 * 흐름 없이 살고, 흐름 없이 사는 항목은 아무 전환도 막히지 않으므로 설정을 쓴 사람은
 * 자기가 건 규칙이 도는 줄 안다.
 */
function normalizeBindings(raw, workflows, file) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: bindings: 객체여야 합니다.`);
  const out = {};
  for (const [kind, table] of Object.entries(raw)) {
    if (!TARGET_KINDS.includes(kind)) {
      throw new Error(`${file}: bindings.${kind}: 대상 종류는 다음 중 하나여야 합니다: ${TARGET_KINDS.join(' · ')}`);
    }
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error(`${file}: bindings.${kind}: 객체여야 합니다.`);
    const entries = {};
    for (const [typeId, workflowId] of Object.entries(table)) {
      const id = String(workflowId);
      if (!workflows[id]) throw new Error(`${file}: bindings.${kind}.${typeId}: 없는 워크플로입니다: ${id}`);
      // 대상 종류가 어긋나면 문서 유형이 태스크 흐름을 타게 된다. 값이 있는데도
      // 뜻이 맞지 않는 것이라 조용히 통과시키면 화면에 남의 노드가 보인다.
      if (workflows[id].targetKind !== kind) {
        throw new Error(`${file}: bindings.${kind}.${typeId}: ${id}은 ${workflows[id].targetKind} 워크플로입니다.`);
      }
      entries[typeId] = id;
    }
    out[kind] = entries;
  }
  return out;
}

function layerFiles(start, projectKey) {
  const layout = workspaceLayout(start);
  const files = [{ scope: 'workspace', file: path.join(layout.root, 'projects', 'workspace', FILE_NAME) }];
  if (projectKey) {
    const project = selectProject(layout, projectKey, true);
    files.push({ scope: 'project', file: path.join(project.root, FILE_NAME) });
  }
  return files;
}

/**
 * 3단 상속을 태워 이 프로젝트의 워크플로를 만든다.
 *
 * 내장은 코드가 갖는다. 파일이 없는 저장소가 이 함수를 불러도 답이 나오고,
 * 그 답이 판올림 전과 같은 것이 이 층의 계약이다 — 설정을 안 쓴 사람의 저장소에서
 * 판정이 달라지면 그것은 기능이 아니라 사고다.
 */
function loadWorkflows(start, projectKey) {
  const layers = [];
  const sources = [];
  for (const { scope, file } of layerFiles(start, projectKey)) {
    const parsed = readJson(file);
    if (!parsed) continue;
    sources.push({ scope, file });
    layers.push(normalizeWorkflows(parsed.workflows, { file }));
  }
  const workflows = mergeWorkflows(layers);
  let bindings = {};
  for (const { scope, file } of layerFiles(start, projectKey)) {
    const parsed = readJson(file);
    if (!parsed || parsed.bindings === undefined) continue;
    const layer = normalizeBindings(parsed.bindings, workflows, file);
    for (const [kind, table] of Object.entries(layer)) bindings[kind] = Object.assign({}, bindings[kind], table);
    void scope;
  }
  return { workflows, bindings, sources };
}

/**
 * 그 유형이 탈 워크플로 인스턴스. 배정이 없으면 내장으로 떨어진다.
 *
 * 떨어지는 것을 오류로 두지 않는 이유는 배정이 부분적일 수 있어서다. 문서 열하나 중
 * 하나만 흐름을 갖고 싶은 프로젝트가 나머지 열을 적지 않아도 돌아야 한다.
 */
function workflowFor(config, targetKind, typeId) {
  const table = (config && config.bindings && config.bindings[targetKind]) || {};
  const id = table[typeId === undefined || typeId === null ? '' : String(typeId)] || table[BINDING_FALLBACK] || null;
  const definition = id && config.workflows ? config.workflows[id] : null;
  if (!definition) return createWorkflow({ nodes: TASK_NODES, transitions: null, targetKind: 'task' });
  return createWorkflow(definition);
}

module.exports = { FILE_NAME, BINDING_FALLBACK, readJson, normalizeBindings, loadWorkflows, workflowFor };
