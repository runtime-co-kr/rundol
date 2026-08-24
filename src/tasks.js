'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vocabulary = require('./vocabulary');

const MAX_TASKS_PER_SHARD = 500;

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function normalizeClientId(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized.length > 64) throw new Error(`잘못된 Rundol client ID입니다: ${value || '(없음)'}`);
  return normalized;
}

// waiting과 blocker의 짝은 저장 계층의 불변식이다. Board API에만 두면 CLI 경로는
// projection 검증이 RDL-TASK-014/015로 되돌릴 때까지 실패를 알 수 없다.
// 상태와 부가 정보의 짝이 맞지 않는 것은 호출자가 잘못 보낸 입력이지 서버 고장이 아니다.
// 표시하지 않으면 Board가 400으로 돌려줄 근거가 없어 전부 500이 된다.
function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// 저장 계층이 보는 것은 "항목이 자기 노드와 맞는가"이다 — 어휘가 origin으로
// item-type이라 부르는 것, 곧 움직이든 안 움직이든 언제나 참이어야 하는 것이다.
// 증거를 요구하는 게이트(수용조건 · TST 링크 · 병합 요청 참조)는 여기 없다.
// 그쪽은 전환에 걸리고 검사기가 소유한다.
//
// 규칙을 이 파일에 다시 적지 않는다. 같은 짝이 저장 계층과 검사 계층에 두 벌로
// 있었고 강도가 서로 달랐다 — 저장은 blocker가 있기만 하면 받았고 검사는 세
// 부분을 요구했다. 두 벌은 갈린 것이 아니라 갈릴 것이 이미 갈려 있었던 것이다.
const workflow = require('./workflow');

/**
 * 노드와 항목의 짝을 본다. 막는 규칙을 전부 모아 한 번에 던진다.
 *
 * 하나씩 던지면 부르는 쪽이 고치고 다시 부르고를 되풀이한다 — 태스크 열둘을
 * 옮길 때 게이트 하나를 면제하자 다음 게이트가 다시 막았던 그 왕복이다.
 */
function assertNodeConsistency(current, changes, flow) {
  const next = Object.assign({}, current || {}, changes || {});
  // 흐름을 넘기지 않으면 내장으로 떨어진다. 넘기지 않는 호출자를 던져서 막으면
  // 설정이 없는 저장소에서 저장이 통째로 멈춘다 — check-rules.js가 유형 정의에
  // 대해 같은 규율을 쓴다.
  const engine = flow || workflow;
  // 자리를 옮기는가 아닌가로 묻는 것이 다르다. 옮기지 않으면 전환은 물을 것이
  // 없고, 옮기면 "그 전환이 이 흐름에 있는가"가 먼저다. current가 없는 것은
  // 새로 만드는 것이므로 전환이 아니다.
  const moving = Boolean(current) && current.status !== undefined && changes && changes.status !== undefined
    && String(current.status) !== String(changes.status);
  const blocked = moving
    ? engine.judgeTransition(current.status, next.status, next, null)
    : engine.judgeItem(next, null).filter((blocker) => blocker.origin === 'item-type');
  if (blocked.length) throw inputError(workflow.blockerReport(blocked));
}

// 아래 셋은 좁은 probe다. 저장 경로는 위의 한 번을 부르고, 이 셋은 규칙 하나만
// 따로 물어야 하는 자리(시험과 Board의 입력 검증)를 위해 남는다. 판정 자체는
// 셋 다 같은 카탈로그에서 나오므로 답이 갈릴 자리가 없다.
function assertFieldConsistency(current, changes, path) {
  const next = Object.assign({}, current || {}, changes || {});
  const blocked = workflow.judgeItem(next, null)
    .filter((blocker) => blocker.origin === 'item-type' && String(blocker.target).endsWith(`.${path}`));
  if (blocked.length) throw inputError(workflow.blockerReport(blocked));
}

function assertBlockerConsistency(current, changes) {
  assertFieldConsistency(current, changes, 'blocker');
}

// 완료와 반려는 둘 다 종료 스텝이지만 게이트가 반대 방향이다. 완료는 수용조건과 TST 증거를
// 요구하고, 반려는 그 증거가 없다는 것을 전제로 사유를 요구한다. 사유를 강제하지 않으면
// 반려가 완료 게이트를 우회하는 조용한 통로가 된다.
const TERMINAL_TASK_STATES = vocabulary.TERMINAL_TASK_STATES;
function assertCancellationConsistency(current, changes) {
  assertFieldConsistency(current, changes, 'cancellation');
}

// 완료 게이트의 면제. 닫히지 않는 태스크를 사람이 사유를 대고 닫는 자리다.
//
// 반려와 같은 모양인 것은 우연이 아니다. 둘 다 증거가 없는 채로 상태를 옮기는 일이고,
// 그래서 둘 다 사유와 결정자를 요구한다. 사유를 강제하지 않으면 면제가 완료 게이트를
// 우회하는 조용한 통로가 된다 — 반려에 대해 이미 내린 판단과 같다.
//
// 면제할 수 있는 게이트는 코드가 정한 목록 안이다. 되돌릴 수 없는 관문은 그 목록에
// 없으며, 그것이 면제가 경계를 여는 수단이 되지 않게 하는 유일한 장치다.
const EXEMPTABLE = vocabulary.EXEMPTABLE_GATES;
// 면제 기록은 gates 배열이 정본이고, gate 하나만 든 옛 기록도 읽는다 — 마이그레이션
// 없이 공존한다. 읽는 규칙 자체는 판정부가 갖는다.
const exemptionGates = workflow.exemptionGates;

function assertExemptionConsistency(current, changes) {
  const next = Object.assign({}, current || {}, changes || {});
  const exemption = next.exemption;
  if (!exemption) return;
  // 면제는 완료를 위한 것이다. 다른 스텝에 남겨 두면 무엇을 면제한 것인지가 사라지고,
  // 되살아난 태스크가 옛 사유를 들고 다시 닫힌다.
  assertFieldConsistency(current, changes, 'exemption');
  // 한 태스크가 게이트 둘에 걸릴 수 있다. TST가 없다는 사실 하나가 완료 게이트와
  // 구현 준비도 게이트를 함께 막으므로, 면제를 하나만 받으면 나머지가 여전히 닫는다.
  // 사유는 하나다 — 같은 사실에 대한 같은 결정이기 때문이다.
  const gates = exemptionGates(exemption);
  if (!gates.length) throw inputError('면제할 게이트가 필요합니다.');
  for (const gate of gates) {
    if (!EXEMPTABLE.includes(gate)) throw inputError(`면제할 수 없는 게이트입니다: ${gate || '(없음)'}. 면제는 허용 목록 안에서만 선언됩니다(${EXEMPTABLE.join(', ')}).`);
  }
  for (const [field, label] of [['reason', '면제 사유'], ['decidedBy', '결정자'], ['at', '결정 시각']]) {
    if (!exemption[field] || !String(exemption[field]).trim()) throw inputError(`${label}가 필요합니다.`);
  }
}

// 진행 상태와 판정은 다른 축이다. 실패한 테스트도 수행은 끝난 것이라 done이고, 그
// 판정이 fail이다. 한 필드에 섞으면 "실패를 확인한 테스트"와 "아직 돌리지 않은 테스트"를
// 구분할 수 없어, 테스트만 모아 성공 여부를 묻는 일이 처음부터 불가능해진다.
const TASK_KINDS = vocabulary.TASK_KINDS;
const TEST_RESULTS = vocabulary.TEST_RESULTS;

function taskKind(task) {
  return (task && task.kind) || 'normal';
}

function assertKindConsistency(current, changes) {
  const next = Object.assign({}, current || {}, changes || {});
  const kind = taskKind(next);
  if (!TASK_KINDS.includes(kind)) throw inputError(`지원하지 않는 태스크 종류입니다: ${kind} (${TASK_KINDS.join(', ')})`);
  const result = next.result === undefined ? null : next.result;
  if (result !== null) {
    if (kind !== 'test') throw inputError('테스트 태스크가 아니면 판정을 둘 수 없습니다.');
    if (!TEST_RESULTS.includes(result)) throw inputError(`지원하지 않는 테스트 판정입니다: ${result} (${TEST_RESULTS.join(', ')})`);
  }
  // 반려는 수행하지 않았다는 뜻이므로 판정을 요구하지 않는다. 완료만 요구한다.
  if (kind === 'test' && workflow.stepOf(next.status) === 'completed' && result === null) throw inputError('완료한 테스트 태스크에는 판정이 필요합니다.');
  const round = next.round === undefined ? null : next.round;
  if (kind !== 'test') {
    if (round !== null) throw inputError('테스트 태스크가 아니면 차수를 둘 수 없습니다.');
    return;
  }
  // 차수는 실행 회차를 가리키는 프로젝트 전역 번호다. 정수 하나로 두면 표기가 갈리지
  // 않고, 1차 다음이 2차라는 것을 기계가 알아 회귀 비교가 그냥 된다. "지금 몇 차인가"도
  // 따로 저장하지 않고 태스크들의 최댓값으로 답한다.
  if (!Number.isInteger(round) || round < 1) throw inputError('테스트 태스크에는 1 이상의 정수 차수가 필요합니다.');
  // 차수 하나에 TST 하나가 태스크 하나다. 여럿을 묶으면 판정이 하나뿐이라 어느 것이
  // 실패했는지 알 수 없고, 모아서 성공 여부를 묻는 일이 다시 불가능해진다.
  if (testedDocuments(next).length !== 1) throw inputError('테스트 태스크는 검증한 TST 문서를 정확히 하나 연결해야 합니다.');
}

function testedDocuments(task) {
  return (task && Array.isArray(task.links) ? task.links : [])
    .map((link) => String(link).split('#')[0])
    .filter((link) => /^TST-\d{3,}$/u.test(link));
}

// 같은 TST를 같은 차수에 두 번 검증하는 태스크는 둘 수 없다. 재실행은 새 태스크가
// 아니라 같은 태스크의 판정이 바뀌는 일이고, 결함은 별도 수정 태스크가 나른다.
//
// 다만 반려한 태스크는 자리를 붙잡지 않는다. 붙잡게 하면 잘못 만든 태스크를 반려한 뒤
// 그 차수에서 다시 만들 방법이 없어져, 차수를 올리는 것이 유일한 해소가 된다.
function holdsRoundSlot(task) {
  return Boolean(task) && task.kind === 'test' && workflow.stepOf(task.status) !== 'dropped';
}

function assertRoundUniqueness(tasks, taskIdValue, task) {
  if (!holdsRoundSlot(task)) return;
  const [target] = testedDocuments(task);
  if (!target) return;
  for (const [id, other] of Object.entries(tasks || {})) {
    if (id === taskIdValue || !holdsRoundSlot(other) || other.round !== task.round) continue;
    if (testedDocuments(other).includes(target)) throw inputError(`${target}의 ${task.round}차 검증 태스크가 이미 있습니다: ${id}`);
  }
}

function clientId(root, preferred) {
  if (preferred) return normalizeClientId(preferred);
  const file = path.join(root, '.rundol', 'state', 'client-id');
  if (fs.existsSync(file)) return normalizeClientId(fs.readFileSync(file, 'utf8'));
  atomicWrite(file, `${generatedClientId()}\n`);
  return normalizeClientId(fs.readFileSync(file, 'utf8'));
}

// Client ID는 샤드 디렉터리와 이벤트 파일의 이름이 되어 저장소에 커밋된다.
// 호스트명을 그대로 쓰면 공개 저장소에 기기 이름이 남고, MOD-002가 금지한
// 호스트 정보가 manifest 본문이 아니라 파일명으로 새어 나간다.
// 호스트를 6자리로 해시하면 같은 기기는 항상 같은 값을 얻어 정체성은 유지되고
// 원래 이름은 드러나지 않는다.
function generatedClientId() {
  const host = process.env.COMPUTERNAME || process.env.HOSTNAME || 'client';
  const tag = crypto.createHash('sha256').update(String(host)).digest('hex').slice(0, 6);
  return normalizeClientId(`c${tag}-${crypto.randomBytes(5).toString('hex')}`);
}

function shardFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const client of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!client.isDirectory() || client.name.startsWith('.')) continue;
    const clientRoot = path.join(directory, client.name);
    for (const entry of fs.readdirSync(clientRoot, { withFileTypes: true })) {
      if (entry.isFile() && /^\d{6}\.json$/u.test(entry.name)) files.push(path.join(clientRoot, entry.name));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function parseDocument(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)) throw new Error(`${file}의 tasks는 객체여야 합니다.`);
  return parsed;
}

function readTaskStore(target) {
  if (!target || !fs.existsSync(target)) return { schemaVersion: 3, tasks: {}, sources: {} };
  if (fs.statSync(target).isFile()) {
    const parsed = parseDocument(target);
    return { schemaVersion: parsed.schemaVersion || 1, tasks: parsed.tasks, sources: Object.fromEntries(Object.keys(parsed.tasks).map((id) => [id, target])) };
  }
  const tasks = {};
  const sources = {};
  for (const file of shardFiles(target)) {
    const parsed = parseDocument(file);
    for (const [id, task] of Object.entries(parsed.tasks)) {
      if (Object.prototype.hasOwnProperty.call(tasks, id)) throw new Error(`중복 태스크 ID가 여러 샤드에 있습니다: ${id}`);
      tasks[id] = task;
      sources[id] = file;
    }
  }
  return { schemaVersion: 3, tasks, sources };
}

function nextShard(directory, id, maxItems) {
  const clientRoot = path.join(directory, normalizeClientId(id));
  fs.mkdirSync(clientRoot, { recursive: true });
  const files = fs.readdirSync(clientRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{6}\.json$/u.test(entry.name))
    .map((entry) => path.join(clientRoot, entry.name))
    .sort();
  const last = files[files.length - 1];
  if (last) {
    const parsed = parseDocument(last);
    if (Object.keys(parsed.tasks).length < maxItems) return { file: last, document: parsed };
  }
  const number = last ? Number.parseInt(path.basename(last, '.json'), 10) + 1 : 1;
  return {
    file: path.join(clientRoot, `${String(number).padStart(6, '0')}.json`),
    document: { schemaVersion: 1, clientId: normalizeClientId(id), segment: number, tasks: {} }
  };
}

function createTaskInStore(target, root, taskId, task, preferredClientId, maxItems) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    const original = fs.readFileSync(target, 'utf8');
    const document = JSON.parse(original);
    document.tasks = document.tasks || {};
    document.tasks[taskId] = task;
    atomicWrite(target, canonicalJson(document));
    return { file: target, original, clientId: null };
  }
  const id = clientId(root, preferredClientId);
  const selected = nextShard(target, id, maxItems || MAX_TASKS_PER_SHARD);
  const original = fs.existsSync(selected.file) ? fs.readFileSync(selected.file, 'utf8') : null;
  selected.document.tasks[taskId] = task;
  atomicWrite(selected.file, canonicalJson(selected.document));
  return { file: selected.file, original, clientId: id };
}

function updateTaskInStore(target, taskId, task) {
  const store = readTaskStore(target);
  const file = store.sources[taskId];
  if (!file) throw new Error(`태스크를 찾지 못했습니다: ${taskId}`);
  const original = fs.readFileSync(file, 'utf8');
  const document = JSON.parse(original);
  document.tasks[taskId] = task;
  atomicWrite(file, canonicalJson(document));
  return { file, original };
}

function restoreStoreWrite(change) {
  if (change.original === null) {
    if (fs.existsSync(change.file)) fs.unlinkSync(change.file);
  } else atomicWrite(change.file, change.original);
}

function materializeTaskStore(target, projection) {
  const store = readTaskStore(target);
  atomicWrite(projection, canonicalJson({ schemaVersion: 3, generated: true, tasks: store.tasks }));
  return { projection, tasks: Object.keys(store.tasks).length };
}

function migrateTaskStore(legacyFile, directory, root, preferredClientId, maxItems) {
  if (!fs.existsSync(legacyFile)) throw new Error(`마이그레이션할 tasks.json이 없습니다: ${legacyFile}`);
  if (fs.existsSync(directory) && shardFiles(directory).length > 0) throw new Error(`태스크 샤드 경로가 비어 있지 않습니다: ${directory}`);
  const document = parseDocument(legacyFile);
  const id = clientId(root, preferredClientId);
  const entries = Object.entries(document.tasks);
  const size = maxItems || MAX_TASKS_PER_SHARD;
  for (let offset = 0; offset < entries.length; offset += size) {
    const segment = Math.floor(offset / size) + 1;
    const tasks = Object.fromEntries(entries.slice(offset, offset + size));
    atomicWrite(path.join(directory, id, `${String(segment).padStart(6, '0')}.json`), canonicalJson({ schemaVersion: 1, clientId: id, segment, tasks }));
  }
  if (entries.length === 0) atomicWrite(path.join(directory, id, '000001.json'), canonicalJson({ schemaVersion: 1, clientId: id, segment: 1, tasks: {} }));
  return { clientId: id, tasks: entries.length, shards: Math.max(1, Math.ceil(entries.length / size)), directory };
}

module.exports = {
  MAX_TASKS_PER_SHARD,
  TERMINAL_TASK_STATES,
  TASK_KINDS,
  TEST_RESULTS,
  taskKind,
  assertNodeConsistency,
  assertBlockerConsistency,
  assertCancellationConsistency,
  assertExemptionConsistency,
  exemptionGates,
  assertKindConsistency,
  assertRoundUniqueness,
  holdsRoundSlot,
  testedDocuments,
  clientId,
  generatedClientId,
  readTaskStore,
  shardFiles,
  createTaskInStore,
  updateTaskInStore,
  restoreStoreWrite,
  materializeTaskStore,
  migrateTaskStore
};
