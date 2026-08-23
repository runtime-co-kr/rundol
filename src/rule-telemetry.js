'use strict';

// 규칙이 실제로 발화한 이력. 죽은 제약과 작동하는 제약을 가른다.
//
// 진단 코드는 이백 개가 넘는데 그중 무엇이 실제로 막고 있는지는 아무도 몰랐다.
// 발화 이력이 없으면 "한 번도 안 걸린 제약"과 "완벽해서 안 걸리는 제약"이 같아
// 보인다. 둘은 정반대다 — 앞은 지우거나 고쳐야 할 것이고 뒤는 지금 일하고 있는
// 것인데, 겉모습이 같아서 어느 쪽인지 물을 수조차 없었다.
//
// 어휘를 데이터로 여는 설계가 이것을 필수 부품으로 만들었다. 유형과 전환을 사람이
// 정의할 수 있게 되면 제약도 함께 열리고, 열린 제약은 조용히 죽는다. 정의를 잘못
// 적어 아무것에도 걸리지 않게 되어도 아무 신호가 나지 않기 때문이다. 닫힌 어휘는
// 코드를 고쳐야 죽으므로 리뷰가 한 번은 본다. 열린 어휘는 설정을 고치면 죽고 그것을
// 보는 눈은 없다. 그래서 어휘를 여는 일과 발화를 계측하는 일은 함께 가야 한다 —
// 계측 없이 열면 "규칙이 있다"는 느낌만 남고 실제로는 아무것도 하지 않는 상태가
// 가능해지며, 그 상태는 건강한 상태와 겉에서 구분되지 않는다.
//
// 이 모듈은 의미를 건드리지 않는다. 무엇이 위반인지, 어떤 전환이 허용되는지, 어떤
// 게이트가 면제될 수 있는지는 전부 다른 곳이 정하고 여기는 그 판정이 내려진 뒤에
// 그 사실만 받아 적는다. 계측이 판정에 끼어들면 계측을 끄는 것이 판정을 바꾸는 일이
// 되고, 그러면 이것은 계측이 아니라 규칙의 일부가 된다.
//
// 받아 적는 자리는 하나다. 발화 지점마다 기록을 심으면 지점이 늘 때마다 계측도 함께
// 심어야 하고, 빠뜨렸다는 사실은 아무 신호도 내지 않는다 — 이 모듈이 존재하는 이유와
// 똑같은 실패다. 그래서 진단이 전부 모이는 자리에서 한 번 받는다. 부르는 쪽에 남는
// 것은 호출 한 줄이며, 그 한 줄이 무엇을 기록할지는 여기가 정한다.
//
// ── 이 계측이 보지 못하는 것 ──────────────────────────────────────────
//
// 주석에만 적지 않고 조회 결과에 값으로 함께 내보낸다(measures·lowerBound). 읽는
// 쪽이 이 수치를 "발화의 전부"로 읽으면, 안 보이는 발화가 죽은 제약으로 집계된다.
//
//  * 셸 훅. pre-commit과 commit-msg는 셸이고 --no-verify로 우회된다. 훅이 막은
//    것도 우회된 것도 여기 오지 않는다.
//  * 기록을 남기지 않은 저장소. 검사를 한 번도 돌리지 않았으면 모든 제약이 죽어
//    보인다. 그래서 표면별 실행 횟수를 함께 낸다 — 0번 돌린 표면의 0번 발화는
//    죽음의 증거가 아니라 증거가 없다는 뜻이다.
//  * 게이트 이름을 찍지 않는 발화. 게이트 집계는 진단이 들고 온 gate 필드로만
//    이뤄지고, 그 필드가 없는 진단은 코드로만 잡힌다.
//  * 이 체크아웃 밖. 이 파일은 원장이 아니라 로컬 로그이므로 다른 기기의 발화는
//    들어 있지 않다. 그래서 여기의 "한 번도 안 걸림"은 언제나 하한이다.

const fs = require('fs');
const path = require('path');
const { logDirectory } = require('./debug');
const { ruleSource } = require('./diagnostic-rules');
const { DEFAULT_TASK_GATES } = require('./check-rules');
const { EXEMPTABLE_GATES } = require('./vocabulary');

// 원장이 아니라 로컬 로그다. 이름이 어휘에 등록되지 않는 이유가 그것이며, 토큰·행위
// 계측이 쌓이는 디렉터리에 나란히 둔다. 나중에 이것이 원장이 되어야 한다면 이름은
// 계약이 정하고 이 상수가 그것을 받는다.
const RULE_LOG = 'rules.jsonl';
const SCHEMA = 1;

// 상한에 닿으면 오래된 sweep을 접는다. debug.jsonl처럼 버리지 않는 이유는 이 계측이
// 답해야 하는 질문이 "최근에 어땠나"가 아니라 "한 번이라도 걸린 적 있나"이기
// 때문이다. 버리면 오래전에 한 번 걸린 제약이 죽은 제약으로 바뀌고, 그것은 이 계측이
// 존재하는 이유를 정확히 뒤집는다. 그래서 줄은 줄이되 수치는 남긴다.
const MAX_LOG_BYTES = 1024 * 1024;
const KEEP_SWEEPS = 200;

// 우회는 접지 않는다. 접으면 사유가 사라지고, 사유 없는 우회 기록은 우회를 세는
// 일에만 쓸모 있다 — 이 계측이 답해야 하는 것은 몇 번이 아니라 왜다. 게다가 우회는
// 사람이 사유를 대고 내리는 결정이라 드물고, 드문 것은 접을 이유가 없다.

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    // 깨진 줄 하나가 나머지를 못 읽게 만들면, 계측이 고장 난 날 이후의 이력이 통째로
    // 사라진다. 읽을 수 있는 것만 읽는다.
    try { records.push(JSON.parse(line)); } catch (_) { continue; }
  }
  return records;
}

function earlier(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left < right ? left : right;
}

function later(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left > right ? left : right;
}

function tallyEntry(table, key) {
  if (!table[key]) table[key] = { occurrences: 0, sweeps: 0, blocking: 0, firstAt: null, lastAt: null };
  return table[key];
}

function absorb(entry, add) {
  entry.occurrences += add.occurrences || 0;
  entry.sweeps += add.sweeps || 0;
  entry.blocking += add.blocking || 0;
  entry.firstAt = earlier(entry.firstAt, add.firstAt);
  entry.lastAt = later(entry.lastAt, add.lastAt);
}

/**
 * 기록을 접어 집계를 낸다. 파일을 모르는 순수 함수인 이유는 두 가지다. 하나는 파일
 * 없이 시험할 수 있어야 하기 때문이고, 다른 하나는 접기가 두 곳에서 쓰이기 때문이다 —
 * 조회가 접고, 압축도 같은 방식으로 접어 rollup을 만든다. 접는 방법이 둘로 갈리면
 * 압축한 저장소와 압축하지 않은 저장소가 다른 답을 낸다.
 *
 * 세는 축이 셋인 이유는 셋 다 다른 질문에 답하기 때문이다. occurrences는 진단이 몇
 * 건 나왔는지고, sweeps는 몇 번의 검사에서 걸렸는지고, blocking은 그중 실제로 막은
 * 것이 몇 건인지다. 검사를 자주 돌리는 저장소에서 occurrences는 부풀지만 sweeps는
 * 부풀지 않고, advisory로 내린 제약은 occurrences가 커도 blocking이 0이다. 한 축만
 * 내면 "많이 걸리는 제약"과 "실제로 막는 제약"이 같아 보인다.
 */
function foldRuleRecords(records) {
  const runs = {};
  const codes = {};
  const gates = {};
  const standing = new Map();
  const acted = [];
  let since = null;
  let through = null;

  for (const record of records || []) {
    if (!record || typeof record !== 'object') continue;
    since = earlier(since, record.at);
    through = later(through, record.through || record.at);

    if (record.kind === 'rollup') {
      for (const [surface, count] of Object.entries(record.runs || {})) runs[surface] = (runs[surface] || 0) + count;
      for (const [code, value] of Object.entries(record.codes || {})) absorb(tallyEntry(codes, code), value);
      for (const [gate, value] of Object.entries(record.gates || {})) absorb(tallyEntry(gates, gate), value);
      continue;
    }

    if (record.kind === 'sweep') {
      const surface = record.surface || 'unknown';
      runs[surface] = (runs[surface] || 0) + 1;
      for (const [code, value] of Object.entries(record.codes || {})) {
        absorb(tallyEntry(codes, code), { occurrences: value.n || 0, blocking: value.blocking || 0, sweeps: 1, firstAt: record.at, lastAt: record.at });
      }
      for (const [gate, value] of Object.entries(record.gates || {})) {
        absorb(tallyEntry(gates, gate), { occurrences: value.n || 0, blocking: value.blocking || 0, sweeps: 1, firstAt: record.at, lastAt: record.at });
      }
      continue;
    }

    if (record.kind !== 'bypass') continue;
    // 서 있는 우회와 일어난 우회는 다르게 센다. 면제는 태스크에 남아 있는 상태라
    // 검사를 돌릴 때마다 다시 보이고, 볼 때마다 세면 검사를 자주 돌린 저장소에서
    // 우회가 수백 건으로 불어난다. 같은 결정은 한 건이고 본 횟수만 늘어난다. 반면
    // 저장의 사유처럼 그때 한 번 일어난 우회는 접으면 사라진다.
    if (!record.standing) { acted.push(record); continue; }
    const key = [record.rule, record.subject || '', record.reason || ''].join('|');
    const seen = standing.get(key);
    if (seen) {
      seen.observations += 1;
      seen.firstAt = earlier(seen.firstAt, record.at);
      seen.lastAt = later(seen.lastAt, record.at);
      continue;
    }
    standing.set(key, {
      rule: record.rule, scope: record.scope || 'gate', standing: true,
      subject: record.subject || null, reason: record.reason || null,
      decidedBy: record.decidedBy || null, surface: record.surface || null,
      observations: 1, firstAt: record.at, lastAt: record.at
    });
  }

  const bypasses = Array.from(standing.values()).concat(acted.map((record) => ({
    rule: record.rule, scope: record.scope || 'code', standing: false,
    subject: record.subject || null, reason: record.reason || null,
    decidedBy: record.decidedBy || null, surface: record.surface || null,
    observations: 1, firstAt: record.at, lastAt: record.at
  })));
  bypasses.sort((left, right) => String(left.firstAt).localeCompare(String(right.firstAt))
    || String(left.rule).localeCompare(String(right.rule))
    || String(left.subject).localeCompare(String(right.subject)));

  return { since, through, runs, codes, gates, bypasses };
}

// ── 제약의 전체 목록 ────────────────────────────────────────────────────
//
// 한 번도 걸린 적 없는 제약을 세려면 전체 목록이 있어야 한다. 목록을 손으로 적으면
// 그것은 두 번째 사본이고, 두 번째 사본은 갈린다 — 새 진단을 넣고 목록에 올리는 것을
// 잊으면 그 제약은 애초에 존재하지 않는 것이 되어 "죽었다"는 판정조차 받지 못한다.
// 그래서 소스에서 파생한다. 파생은 낡을 수 없다.
//
// 규약은 이미 저장소가 지키고 있다 — 진단 코드는 따옴표로 감싼 문자열 상수로 적힌다.
// diagnostic-rules 시험이 같은 방식으로 코드를 세고 있으므로 이 파생이 새로 요구하는
// 규약은 없다.
const CODE_PATTERN = /'(RDL-[A-Z]+-\d+)'/gu;
let universeCache = null;

function ruleUniverse() {
  if (universeCache) return universeCache;
  const codes = new Set();
  for (const entry of fs.readdirSync(__dirname)) {
    if (!entry.endsWith('.js')) continue;
    let source;
    try { source = fs.readFileSync(path.join(__dirname, entry), 'utf8'); } catch (_) { continue; }
    for (const match of source.matchAll(CODE_PATTERN)) codes.add(match[1]);
  }
  // 게이트는 소스를 뒤지지 않는다. 이름으로 부르고 이름으로 면제하는 값이라 이미
  // 목록으로 존재하며, 그 목록을 가진 모듈에서 그대로 읽는다.
  const gates = Array.from(new Set([].concat(Object.keys(DEFAULT_TASK_GATES), EXEMPTABLE_GATES.slice())));
  universeCache = { codes: Array.from(codes).sort(), gates: gates.sort() };
  return universeCache;
}

// ── 기록 ────────────────────────────────────────────────────────────────

function appendRecord(start, projectKey, record) {
  const directory = logDirectory(start, projectKey);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, RULE_LOG);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  compact(file);
  return file;
}

function compact(file) {
  let size;
  try { size = fs.statSync(file).size; } catch (_) { return; }
  if (size <= MAX_LOG_BYTES) return;
  const records = readRecords(file);
  const sweeps = records.filter((record) => record && record.kind === 'sweep');
  // sweep이 적은데 파일이 큰 것은 우회가 많다는 뜻이고, 우회는 접지 않는다.
  if (sweeps.length <= KEEP_SWEEPS) return;
  const kept = new Set(sweeps.slice(-KEEP_SWEEPS));
  const stale = (record) => record.kind === 'sweep' && !kept.has(record);
  const folded = foldRuleRecords(records.filter((record) => record.kind === 'rollup' || stale(record)));
  const rollup = {
    v: SCHEMA, kind: 'rollup', at: new Date().toISOString(), through: folded.through,
    runs: folded.runs, codes: folded.codes, gates: folded.gates
  };
  const rest = records.filter((record) => record.kind !== 'rollup' && !stale(record));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, [rollup].concat(rest).map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
  fs.renameSync(temporary, file);
}

function bump(table, key, blocking) {
  if (!table[key]) table[key] = { n: 0, blocking: 0 };
  table[key].n += 1;
  if (blocking) table[key].blocking += 1;
}

/**
 * 검사 한 번의 발화를 받아 적는다. 진단이 모두 모인 자리에서 부르는 유일한 지점이다.
 *
 * 걸린 것이 하나도 없어도 적는다. 발화 0건은 기록할 것이 없다는 뜻이 아니라 "이번에
 * 돌렸고 아무것도 안 걸렸다"는 사실이며, 그 사실이 쌓여야 "한 번도 안 걸렸다"가
 * 죽음의 증거가 된다. 돌린 적이 없는 것과 돌렸는데 안 걸린 것은 다르다.
 *
 * 면제는 그 자리에서 함께 본다. 면제된 게이트는 판정 자체가 돌지 않아 진단을 내지
 * 않으므로, 발화만 세면 면제로 조용해진 게이트와 지킬 것이 없어 조용한 게이트가 같아
 * 보인다. 검사 결과가 이미 면제 목록을 사유와 결정자까지 들고 있으므로 여기서 한 번에
 * 받는다 — 면제를 적으려고 결정 지점마다 계측을 심을 이유가 없다.
 *
 * 어떤 실패도 검사를 무너뜨리지 않는다. 계측이 검사를 막으면 그 순간 계측은 규칙이
 * 된다. 로그를 못 쓰는 것은 검사의 답과 아무 상관이 없다.
 */
function recordCheck(start, result, settings) {
  const options = settings || {};
  if (options.record === false) return [];
  const surface = options.surface || 'check';
  const at = new Date().toISOString();
  const checked = Array.isArray(result && result.projects) ? result.projects : [];
  const groups = new Map();
  const group = (key) => {
    const id = key || null;
    if (!groups.has(id)) groups.set(id, { codes: {}, gates: {}, bypasses: [] });
    return groups.get(id);
  };
  for (const key of checked) group(key);

  for (const item of (result && result.diagnostics) || []) {
    if (!item || !item.code) continue;
    // 프로젝트를 밝히지 않은 진단은 작업공간 전체의 것이다. 검사한 프로젝트가 하나뿐
    // 이면 그 프로젝트의 일로 적는다 — 로그가 어차피 같은 자리에 쌓인다. 여럿이면
    // 어느 쪽의 일인지 알 수 없으므로 프로젝트 없는 자리에 적고, 그 자리를 찾지
    // 못하면 이 묶음만 조용히 빠진다.
    const key = item.project || (checked.length === 1 ? checked[0] : null);
    const blocking = item.severity === 'error';
    bump(group(key).codes, item.code, blocking);
    if (item.gate) bump(group(key).gates, item.gate, blocking);
  }

  for (const exemption of (result && result.summary && result.summary.exemptions) || []) {
    if (!exemption) continue;
    const key = exemption.project || (checked.length === 1 ? checked[0] : null);
    for (const gate of exemption.gates || []) {
      group(key).bypasses.push({
        v: SCHEMA, kind: 'bypass', at, surface, standing: true, scope: 'gate',
        rule: gate, subject: exemption.taskId || null,
        reason: exemption.reason || null, decidedBy: exemption.decidedBy || null
      });
    }
  }

  const written = [];
  for (const [key, entry] of groups) {
    try {
      written.push(appendRecord(start, key, { v: SCHEMA, kind: 'sweep', at, surface, codes: entry.codes, gates: entry.gates }));
      for (const bypass of entry.bypasses) appendRecord(start, key, bypass);
    } catch (_) { continue; }
  }
  return written;
}

/**
 * 서 있는 흔적을 남기지 않는 우회를 받아 적는다.
 *
 * 면제는 태스크에 남으므로 검사가 다시 볼 수 있지만, 그때 한 번 사유를 대고 지나간
 * 우회는 지나가면 끝이다. 그 자리에서 적지 않으면 그 우회는 어디에도 없다.
 */
function recordBypass(start, input) {
  const values = input || {};
  if (!values.rule) return null;
  try {
    return appendRecord(start, values.project || null, {
      v: SCHEMA, kind: 'bypass', at: new Date().toISOString(),
      surface: values.surface || 'unknown', standing: false,
      scope: values.scope || 'code', rule: values.rule,
      subject: values.subject || null, reason: values.reason || null,
      decidedBy: values.decidedBy || null
    });
  } catch (_) { return null; }
}

// ── 조회 ────────────────────────────────────────────────────────────────

function ledger(start, projectKey) {
  const file = path.join(logDirectory(start, projectKey), RULE_LOG);
  return { file, folded: foldRuleRecords(readRecords(file)) };
}

// 표면별 실행 횟수는 평평하게 낸다. 중첩 객체는 사람이 읽는 출력에서 통째로
// 생략되므로, 중첩으로 두면 "몇 번 돌렸나"가 --json에서만 보인다. 그리고 그 수치가
// 없으면 발화 0건이 무엇을 뜻하는지 읽는 쪽이 판단할 수 없다.
function runList(runs) {
  return Object.keys(runs).sort().map((surface) => ({ surface, runs: runs[surface] }));
}

function totalRuns(runs) {
  return Object.values(runs).reduce((sum, value) => sum + value, 0);
}

function decorate(rule, scope, entry) {
  const source = scope === 'code' ? ruleSource(rule) : null;
  return Object.assign({
    rule, scope,
    occurrences: entry.occurrences, sweeps: entry.sweeps, blocking: entry.blocking,
    firstAt: entry.firstAt, lastAt: entry.lastAt
  }, source ? { document: source.document, functionId: source.functionId } : {});
}

/** 어느 제약이 언제 몇 번 걸렸는지. */
function ruleHistory(start, settings) {
  const options = settings || {};
  const { file, folded } = ledger(start, options.project);
  const wanted = options.rule ? String(options.rule).trim() : null;
  const rules = []
    .concat(Object.keys(folded.codes).map((code) => decorate(code, 'code', folded.codes[code])))
    .concat(Object.keys(folded.gates).map((gate) => decorate(gate, 'gate', folded.gates[gate])))
    .filter((entry) => !wanted || entry.rule === wanted)
    .sort((left, right) => right.occurrences - left.occurrences || left.rule.localeCompare(right.rule));
  return {
    file, project: options.project || null,
    since: folded.since, through: folded.through,
    checks: totalRuns(folded.runs),
    surfaces: runList(folded.runs),
    fired: rules.length,
    rules
  };
}

/** 우회된 제약과 그 사유. */
function ruleBypasses(start, settings) {
  const options = settings || {};
  const { file, folded } = ledger(start, options.project);
  const bypasses = folded.bypasses.filter((entry) => !options.rule || entry.rule === String(options.rule).trim());
  return {
    file, project: options.project || null,
    since: folded.since, through: folded.through,
    count: bypasses.length,
    // 사유 없는 우회가 있으면 그것부터 봐야 한다. 사유를 요구하는 자리에서 왔다면
    // 요구가 새고 있다는 뜻이고, 아니라면 그 자리에 사유 요구가 없다는 뜻이다.
    unexplained: bypasses.filter((entry) => !entry.reason).length,
    bypasses
  };
}

/**
 * 한 번도 걸린 적 없는 제약.
 *
 * 이 목록이 곧 "지워도 되는 제약"은 아니다. 돌린 적 없는 표면의 제약과 돌렸는데 안
 * 걸린 제약이 여기 함께 들어 있고, 둘을 가르는 값이 checks다 — 그래서 목록만 내지
 * 않고 몇 번 돌렸는지를 함께 낸다. 검사를 한 번도 돌리지 않은 저장소에서는 모든
 * 제약이 여기 나오며, 그것은 제약이 죽었다는 뜻이 아니라 증거가 없다는 뜻이다.
 */
function deadRules(start, settings) {
  const options = settings || {};
  const { file, folded } = ledger(start, options.project);
  const universe = ruleUniverse();
  const firedCodes = new Set(Object.keys(folded.codes));
  const firedGates = new Set(Object.keys(folded.gates));
  // 면제된 게이트는 죽은 것이 아니라 꺼진 것이다. 발화만 보고 죽음으로 세면 "면제해서
  // 조용하다"와 "지킬 것이 없어 조용하다"가 같아지고, 앞의 것은 지워야 할 규칙이
  // 아니라 지금 우회되고 있는 규칙이다.
  const exempted = new Set(folded.bypasses.map((entry) => entry.rule));
  const rules = []
    .concat(universe.codes.filter((code) => !firedCodes.has(code)).map((code) => {
      const source = ruleSource(code);
      return Object.assign({ rule: code, scope: 'code', exempted: exempted.has(code) }, source ? { document: source.document, functionId: source.functionId } : {});
    }))
    .concat(universe.gates.filter((gate) => !firedGates.has(gate)).map((gate) => ({ rule: gate, scope: 'gate', exempted: exempted.has(gate) })));
  const total = universe.codes.length + universe.gates.length;
  return {
    file, project: options.project || null,
    checks: totalRuns(folded.runs),
    surfaces: runList(folded.runs),
    total,
    live: total - rules.length,
    dead: rules.length,
    // 계측이 보지 못하는 경로를 값으로 밝힌다. 주석에만 적으면 JSON을 읽는 쪽은 이
    // 목록을 "지워도 되는 제약"으로 읽는다.
    measures: 'locally-recorded-firings',
    lowerBound: true,
    rules
  };
}

module.exports = {
  RULE_LOG, SCHEMA, MAX_LOG_BYTES, KEEP_SWEEPS,
  foldRuleRecords, ruleUniverse,
  recordCheck, recordBypass,
  ruleHistory, ruleBypasses, deadRules
};
