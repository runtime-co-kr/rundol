'use strict';

// 규칙이 실제로 발화한 이력. 죽은 규칙과 작동하는 규칙을 가른다.
//
// 어휘를 데이터로 여는 설계가 이것을 필수 부품으로 만들었다. 닫힌 어휘의 제약은
// 코드를 고쳐야 죽으므로 리뷰가 한 번은 본다. 열린 어휘의 제약은 설정을 잘못 고치는
// 것만으로 죽고, 그것을 보는 눈은 없다. 유형 정의에서 제약 하나를 지우거나 조건을
// 아무것에도 맞지 않게 적으면 그 규칙은 그날부터 아무 일도 하지 않는데, 겉으로는
// 규칙이 있는 저장소와 똑같아 보인다.
//
// 그래서 세는 축이 둘이다. evaluated는 판정이 실제로 본 규칙이고 blocked는 그중 막은
// 규칙이다. 막은 것만 적으면 "한 번도 안 막은 규칙"과 "한 번도 안 불린 규칙"이 같은
// 침묵이 되는데, 그 둘은 정반대의 뜻이다 — 앞은 다들 지키고 있다는 뜻이고 뒤는 그
// 규칙이 아무 항목에도 닿지 않는다는 뜻이다.
//
// 로컬 로그가 아니라 원장인 이유는 물음이 프로젝트 전체의 것이기 때문이다. "이 규칙이
// 한 번도 안 불렸나"를 내 기계에서만 세면 각자 자기 침묵만 보게 되고, 침묵은 원래
// 아무 신호도 내지 않는다. 어휘가 firing이라는 이름을 먼저 정했고 event-store의 KINDS가
// 그것을 받는다.
//
// 이 모듈은 의미를 건드리지 않는다. 무엇이 위반인지, 어떤 전환이 허용되는지, 어떤
// 게이트가 면제될 수 있는지는 전부 다른 곳이 정하고 여기는 그 판정이 내려진 뒤에 그
// 답만 받아 적는다. 계측이 판정에 끼어들면 계측을 끄는 것이 판정을 바꾸는 일이 되고,
// 그러면 이것은 계측이 아니라 규칙의 일부가 된다.
//
// 받아 적는 자리는 하나다. 판정 지점마다 기록을 심으면 지점이 늘 때마다 계측도 함께
// 심어야 하고, 빠뜨렸다는 사실은 아무 신호도 내지 않는다 — 이 계측이 존재하는 이유와
// 똑같은 실패다. 판정부는 자기가 본 것을 값으로 돌려주고, 그 값을 검사가 한자리에
// 모아 여기로 넘긴다.
//
// ── 같은 판정을 다시 적지 않는다 ──────────────────────────────────────
//
// eventId를 판정의 내용에서 파생한다. 검사는 저장할 때마다 돌고 보드가 새로 그릴
// 때마다 도는데, 바뀐 것이 없는 태스크의 판정은 매번 같은 답을 낸다. 그것을 매번
// 새 이벤트로 적으면 원장은 저장소의 활동량에 비례해 자라고, 그 부피는 원장이
// 커밋되는 저장소에서 그대로 무게가 된다.
//
// 그래서 "몇 번"의 뜻이 실행 횟수가 아니라 서로 다른 판정의 수다. 검사를 백 번 돌려도
// 답이 같으면 한 건이고, 태스크가 고쳐져 답이 달라지면 새 건이다. 이 값이 답하는
// 물음이 "이 규칙이 일하고 있나"이므로 실행 횟수보다 이쪽이 곧다 — 보드 새로고침을
// 세면 부지런한 저장소의 규칙이 더 살아 있어 보인다.
//
// ── 이 계측이 보지 못하는 것 ──────────────────────────────────────────
//
// 주석에만 적지 않고 조회 결과에 값으로 함께 내보낸다(measures·lowerBound).
//
//  * 데이터로 정의되지 않은 검사. 진단 코드 이백여 개 중 대부분은 검사기가 코드로
//    들고 있는 닫힌 규칙이고, 그것은 코드를 고쳐야 죽으므로 이 원장의 대상이 아니다.
//    여기 있는 것은 유형 정의가 여는 제약과 게이트다.
//  * 전환 판정. origin이 transition인 레코드는 판정 함수가 서면 들어온다. 지금은
//    item-type만 기록되며, 그 사실은 조회 결과의 origins가 말한다.
//  * 셸 훅. pre-commit과 commit-msg는 셸이고 --no-verify로 우회된다.
//  * 아직 동기화되지 않은 다른 기기의 샤드. 원장이라 합쳐지지만 합쳐지기 전까지는
//    이 체크아웃이 가진 것만 보인다. 그래서 "한 번도 안 불림"은 언제나 하한이다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const eventStore = require('./event-store');
const { workspaceLayout, listProjects } = require('./workspace');
const { clientId: localClientId } = require('./tasks');
const { EXEMPTABLE_GATES } = require('./vocabulary');
const { DEFAULT_TASK_GATES } = require('./check-rules');

const KIND = 'firing';
const SCHEMA = 1;

function eventsRootOf(layout) {
  return path.join(layout.root, 'projects', 'workspace', 'events');
}

function lockDirectoryOf(layout) {
  return path.join(layout.root, 'projects', 'workspace', '.rundol', 'local', 'locks');
}

/**
 * 발화 레코드 하나. 판정 하나가 레코드 하나이며 모양은 계약이 정한 FiringRecord다.
 *
 * eventId를 내용에서 파생하는 이유는 위에 적었다. 시각과 클라이언트를 다이제스트에서
 * 빼는 것은 그 둘이 판정의 답이 아니기 때문이다 — 같은 판정을 두 기계가 다른 시각에
 * 내려도 같은 판정이고, 시각을 넣으면 파생이 아무것도 접지 못한다.
 */
function firingEnvelope(input) {
  const judgment = {
    v: SCHEMA,
    projectId: input.projectId,
    surface: input.surface,
    target: input.target,
    origin: input.origin,
    from: input.from === undefined ? null : input.from,
    to: input.to === undefined ? null : input.to,
    evaluated: (input.evaluated || []).slice().sort(),
    blocked: (input.blocked || []).slice(),
    exempted: (input.exempted || []).slice()
  };
  const digest = crypto.createHash('sha256')
    .update(Buffer.from(eventStore.canonicalJson(judgment), 'utf8'))
    .digest('hex');
  return Object.assign({
    eventId: `EVT-${digest.slice(0, 20).toUpperCase()}`,
    at: input.at,
    clientId: input.clientId
  }, judgment);
}

// ── 기록 ────────────────────────────────────────────────────────────────

/**
 * 검사 한 번이 내린 판정을 받아 적는다. 판정이 모두 모이는 유일한 자리에서 부른다.
 *
 * 판정부는 레코드를 만들지 않는다. 만들면 판정이 시각과 클라이언트를 알아야 하고, 그
 * 순간 파일도 시계도 안 읽는다는 계약이 깨진다. 부른 표면이 판정의 답을 받아 적는다.
 *
 * 어떤 실패도 검사를 무너뜨리지 않는다. 계측이 검사를 막으면 그 순간 계측은 규칙이
 * 된다. 원장을 못 쓰는 것은 검사의 답과 아무 상관이 없다.
 */
function recordCheck(start, result, firings, settings) {
  const options = settings || {};
  if (options.record === false || !Array.isArray(firings) || firings.length === 0) return [];
  const written = [];
  try {
    const layout = workspaceLayout(start);
    if (layout.schemaVersion < 2) return [];
    const checked = Array.isArray(result && result.projects) ? result.projects : [];
    if (checked.length !== 1) return [];
    // 한 프로젝트를 검사할 때만 적는다. 여러 프로젝트를 한 번에 검사하면 판정이 어느
    // 프로젝트의 것인지 태스크 식별자만 보고는 갈리지 않고, 틀린 프로젝트의 원장에
    // 적힌 발화는 없는 것보다 나쁘다 — 없는 것은 비어 있고 틀린 것은 거짓이다.
    const projectKey = checked[0];
    const project = listProjects(layout).find((entry) => entry.key === projectKey);
    if (!project) return [];
    const surface = options.surface || 'check';
    const at = new Date().toISOString();
    const client = localClientId(project.root, options.clientId);
    const eventsRoot = eventsRootOf(layout);
    const lockDirectory = lockDirectoryOf(layout);
    // 이미 적힌 판정은 건너뛴다. 원장의 중복 판정에 기대지 않는 이유는 그쪽이 기록
    // 시각까지 포함해 같은지를 보기 때문이다 — 같은 판정을 다른 시각에 다시 내밀면
    // 같은 eventId에 다른 내용으로 읽혀 손상으로 거절된다. 여기서 걸러야 그 거절이
    // 아예 생기지 않는다.
    const seen = new Set(eventStore.readEvents(eventsRoot, KIND, projectKey).map((event) => event.eventId));
    for (const firing of firings) {
      if (!firing || !firing.target) continue;
      const envelope = firingEnvelope(Object.assign({ projectId: projectKey, surface, at, clientId: client }, firing));
      if (seen.has(envelope.eventId)) continue;
      seen.add(envelope.eventId);
      // 한 판정이 못 적히는 것과 나머지가 통째로 빠지는 것은 다르다. 뒤쪽이면 목록의
      // 꼬리가 조용히 사라지고, 사라진 판정은 죽은 규칙으로 집계된다.
      try {
        written.push(eventStore.appendEvent(eventsRoot, KIND, projectKey, client, envelope, { lockDirectory }));
      } catch (_) { continue; }
    }
  } catch (_) {
    return written;
  }
  return written;
}

// ── 읽기와 접기 ─────────────────────────────────────────────────────────

function readFirings(start, projectKey) {
  const layout = workspaceLayout(start);
  const project = projectKey
    || (listProjects(layout).length === 1 ? listProjects(layout)[0].key : null);
  if (!project) throw new Error('발화 이력을 읽으려면 --project <프로젝트키>가 필요합니다.');
  return { project, events: eventStore.readEvents(eventsRootOf(layout), KIND, project) };
}

function earlier(left, right) {
  if (!left) return right || null;
  return !right || left < right ? left : right;
}

function later(left, right) {
  if (!left) return right || null;
  return !right || left > right ? left : right;
}

function bucket(table, ruleId) {
  if (!table[ruleId]) table[ruleId] = { evaluated: 0, blocked: 0, targets: 0, firstAt: null, lastAt: null };
  return table[ruleId];
}

/**
 * 레코드를 접어 규칙별 집계를 낸다. 파일을 모르는 순수 함수인 이유는 파일 없이 시험할
 * 수 있어야 하기 때문이고, 보드가 나중에 같은 수치를 다시 계산하지 않게 하기 위해서다.
 * 같은 수치가 표면마다 다르면 그 수치로 아무것도 판단할 수 없다.
 */
function foldFirings(events) {
  const rules = {};
  const standing = new Map();
  const origins = {};
  const surfaces = {};
  const targets = new Set();
  let since = null;
  let through = null;

  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    since = earlier(since, event.at);
    through = later(through, event.at);
    origins[event.origin || 'unknown'] = (origins[event.origin || 'unknown'] || 0) + 1;
    surfaces[event.surface || 'unknown'] = (surfaces[event.surface || 'unknown'] || 0) + 1;
    if (event.target) targets.add(event.target);

    // 한 규칙이 몇 개의 서로 다른 항목에 닿았는지도 센다. 판정 수만 보면 항목 하나가
    // 여러 번 고쳐진 것과 여러 항목이 걸린 것이 같아 보인다.
    const touched = new Set();
    for (const ruleId of event.evaluated || []) {
      touched.add(ruleId);
      const entry = bucket(rules, ruleId);
      entry.evaluated += 1;
      entry.firstAt = earlier(entry.firstAt, event.at);
      entry.lastAt = later(entry.lastAt, event.at);
    }
    for (const blocker of event.blocked || []) {
      if (!blocker || !blocker.ruleId) continue;
      touched.add(blocker.ruleId);
      const entry = bucket(rules, blocker.ruleId);
      entry.blocked += 1;
      // 막은 규칙은 evaluated에도 있어야 하지만, 게이트가 아닌 경로로 들어온 진단이
      // 섞이면 없을 수 있다. 그때도 시각은 남긴다 — 막았다는 사실이 더 강한 증거다.
      entry.firstAt = earlier(entry.firstAt, event.at);
      entry.lastAt = later(entry.lastAt, event.at);
    }
    for (const ruleId of touched) bucket(rules, ruleId).targets += 1;
    for (const exempted of event.exempted || []) {
      if (!exempted || !exempted.ruleId) continue;
      const key = [exempted.ruleId, event.target, exempted.reason || ''].join('|');
      const seen = standing.get(key);
      if (seen) {
        seen.observations += 1;
        seen.firstAt = earlier(seen.firstAt, event.at);
        seen.lastAt = later(seen.lastAt, event.at);
        continue;
      }
      standing.set(key, {
        rule: exempted.ruleId, gate: exempted.gate || null, target: event.target,
        reason: exempted.reason || null, decidedBy: exempted.decidedBy || null,
        surface: event.surface || null, observations: 1,
        firstAt: event.at, lastAt: event.at
      });
    }
  }


  const bypasses = Array.from(standing.values()).sort((left, right) =>
    String(left.firstAt).localeCompare(String(right.firstAt))
    || String(left.rule).localeCompare(String(right.rule))
    || String(left.target).localeCompare(String(right.target)));

  return { since, through, rules, bypasses, origins, surfaces, judgedTargets: targets.size };
}

// ── 규칙의 전체 목록 ────────────────────────────────────────────────────
//
// 한 번도 불린 적 없는 규칙을 세려면 무엇이 선언되어 있는지를 알아야 한다. 목록은
// 손으로 적지 않고 유형 정의에서 파생한다 — 규칙이 데이터로 정의되므로 그 데이터가
// 곧 목록이고, 따로 적으면 유형을 하나 더할 때 한쪽만 고쳐진다.

function declaredRules(itemTypes) {
  const rules = [];
  for (const [typeId, entry] of Object.entries(itemTypes || {})) {
    const constraints = (entry && entry.constraints) || {};
    for (const [kind, declared] of Object.entries(constraints)) {
      if (kind === 'exempt' || !declared) continue;
      const size = Array.isArray(declared) ? declared.length : Object.keys(declared).length;
      if (size) rules.push({ rule: `${typeId}.${kind}`, scope: 'constraint', type: typeId, kind });
    }
  }
  // 게이트는 유형마다 늘지 않는다. 이름으로 부르고 이름으로 면제하는 값이라 목록이
  // 이미 존재하며, 그 목록을 가진 곳에서 그대로 읽는다.
  for (const gate of Array.from(new Set([].concat(Object.keys(DEFAULT_TASK_GATES), EXEMPTABLE_GATES.slice())))) {
    rules.push({ rule: gate, scope: 'gate', type: null, kind: null });
  }
  return rules.sort((left, right) => left.rule.localeCompare(right.rule));
}

function ruleUniverse(start, projectKey) {
  const { resolveItemTypes } = require('./check');
  const layout = workspaceLayout(start);
  return declaredRules(resolveItemTypes(layout.root, projectKey));
}

// ── 조회 ────────────────────────────────────────────────────────────────

function flatten(table) {
  return Object.keys(table).sort().map((key) => ({ name: key, count: table[key] }));
}

function ledgerOf(start, settings) {
  const options = settings || {};
  const { project, events } = readFirings(start, options.project);
  return { project, folded: foldFirings(events), judgments: events.length };
}

/** 어느 규칙이 언제 몇 번 불렸고 몇 번 막았는지. */
function ruleHistory(start, settings) {
  const options = settings || {};
  const { project, folded, judgments } = ledgerOf(start, options);
  const wanted = options.rule ? String(options.rule).trim() : null;
  const rules = Object.keys(folded.rules)
    .filter((rule) => !wanted || rule === wanted)
    .map((rule) => Object.assign({ rule }, folded.rules[rule]))
    .sort((left, right) => right.blocked - left.blocked || right.evaluated - left.evaluated || left.rule.localeCompare(right.rule));
  return {
    project, judgments, judgedTargets: folded.judgedTargets,
    since: folded.since, through: folded.through,
    origins: flatten(folded.origins),
    surfaces: flatten(folded.surfaces),
    seen: rules.length,
    rules
  };
}

/** 우회된 규칙과 그 사유. */
function ruleBypasses(start, settings) {
  const options = settings || {};
  const { project, folded } = ledgerOf(start, options);
  const bypasses = folded.bypasses.filter((entry) => !options.rule || entry.rule === String(options.rule).trim());
  return {
    project, since: folded.since, through: folded.through,
    count: bypasses.length,
    // 사유 없는 우회가 있으면 그것부터 봐야 한다. 유형 정의가 미리 면제한 것은 결정자가
    // 없으므로 여기 걸리며, 그것이 곧 "아무도 결정하지 않은 우회"의 수다.
    unexplained: bypasses.filter((entry) => !entry.reason).length,
    bypasses
  };
}

/**
 * 한 번도 불린 적 없는 규칙과 불렸으나 한 번도 막지 않은 규칙.
 *
 * 둘을 함께 내되 섞지 않는다. 앞은 그 규칙이 아무 항목에도 닿지 않는다는 뜻이라 가장
 * 강한 뜻의 죽은 규칙이고, 뒤는 다들 지키고 있다는 뜻일 수도 판정이 늘 참이라는 뜻일
 * 수도 있어 이력이 아니라 사람이 가른다. 섞으면 그 판단을 할 수 없다.
 */
function deadRules(start, settings) {
  const options = settings || {};
  const { project, folded, judgments } = ledgerOf(start, options);
  const universe = ruleUniverse(start, project);
  const exempted = new Set(folded.bypasses.map((entry) => entry.rule));
  const decorate = (entry) => Object.assign({}, entry, { exempted: exempted.has(entry.rule) });
  const never = universe.filter((entry) => !folded.rules[entry.rule]).map(decorate);
  const silent = universe
    .filter((entry) => folded.rules[entry.rule] && folded.rules[entry.rule].blocked === 0)
    .map((entry) => Object.assign(decorate(entry), { evaluated: folded.rules[entry.rule].evaluated }));
  return {
    project, judgments,
    total: universe.length,
    // 판정이 0건이면 모든 규칙이 여기 나온다. 그것은 규칙이 죽었다는 뜻이 아니라 증거가
    // 없다는 뜻이며, judgments가 그 사실을 말한다.
    neverEvaluated: never.length,
    neverBlocked: silent.length,
    measures: 'recorded-judgments',
    lowerBound: true,
    never,
    silent
  };
}

module.exports = {
  KIND, SCHEMA,
  firingEnvelope, foldFirings, declaredRules, ruleUniverse,
  recordCheck,
  ruleHistory, ruleBypasses, deadRules
};
