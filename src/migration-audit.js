'use strict';

// 이관 검사기. 지금 있는 태스크와 문서를 워크플로 스텝에 옮겨 보고, 자리를 못 찾는
// 것을 뱉는다.
//
// 이 도구가 존재하는 이유는 이관이 모델의 첫 시험이기 때문이다. 새 모델을 세우는
// 일과 있는 것을 그 모델로 옮기는 일은 다른 일이고, 뒤엣것이 앞엣것을 반증할 수
// 있다 — 옮길 자리가 없는 항목이 나오면 모델이 틀린 것이다. 그 반증을 사람의 눈이
// 아니라 실행으로 받으려고 만든다.
//
// ── 왜 숫자를 박아 두지 않는가 ─────────────────────────────────────────
//
// 보고서 11절은 태스크 125건과 문서 125건을 세어 표를 만들었다. 그 표를 상수로
// 옮겨 적고 싶은 유혹이 있지만, 그러면 이 검사기는 저장소가 아니라 보고서를 검사하게
// 된다. 실제로 그 사이에 값이 움직였다 — 이 파일을 짓는 동안에도 다른 갈래가 태스크를
// 만들었다. 그래서 전부 실행 시점에 잰다. 보고서와 다르면 그 차이가 결과다.
//
// ── 무엇을 세는지 먼저 정한다 ──────────────────────────────────────────
//
// "문서 127건"이라는 수는 두 가지를 뜻할 수 있고 실제로 갈려 있었다. check가 내는
// 127은 정본 문서에 프로젝트 헌장(project.md) 하나를 더한 수이고, 11절 표가 세는
// 125는 헌장도 inbox의 클리핑도 뺀 수다. 어느 쪽이 맞다기보다 둘이 다른 집합이며,
// 그 사실이 적혀 있지 않으면 이관 스크립트가 둘 중 하나를 조용히 고른다.
// 그래서 여기서는 집합의 구성을 값으로 함께 내보낸다(universe).
//
// ── 이 검사기가 보지 못하는 것 ─────────────────────────────────────────
//
//  * 다른 기기의 샤드. 원장은 합쳐지지만 합쳐지기 전까지는 이 체크아웃이 가진 것만
//    보인다. 런이 0건이라는 말은 언제나 "여기서 보이는 런이 0건"이다.
//  * 지나간 전환. 어느 전환을 밟았는지는 애초에 기록되지 않았고, 이 도구가 그것을
//    복원할 수는 없다 — 없다는 사실을 세는 것까지가 여기서 할 수 있는 전부다.

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { readTaskStore, exemptionGates } = require('./tasks');
const { parseFrontmatter } = require('./frontmatter');
const { listMarkdownFiles } = require('./check');
const { COMPOSITE_DIRECTORY } = require('./document-composite');
const { worksets } = require('./workset');
const ledger = require('./run-ledger');
const map = require('./migration-map');

// ── 읽기 ────────────────────────────────────────────────────────────────

// 문서 집합. check.js가 세는 것과 같은 규칙으로 모으되, 헌장을 빼지 않고 종류를
// 달아 둔다. check는 헌장을 목록에서 뺀 뒤 수에만 1을 더하므로 그 한 건이 어떤
// 상태인지는 아무 표에도 안 나온다 — 이관에서는 그 한 건도 자리가 있어야 한다.
function readDocuments(project) {
  const charter = path.resolve(project.charter);
  const scanned = listMarkdownFiles(project.root)
    .filter((file) => path.resolve(file) !== charter)
    .map((file) => ({ file, origin: 'scanned' }));
  const all = fs.existsSync(charter) ? [{ file: charter, origin: 'charter' }].concat(scanned) : scanned;
  const documents = [];
  for (const entry of all) {
    const source = fs.readFileSync(entry.file, 'utf8');
    const frontmatter = parseFrontmatter(source);
    // frontmatter가 없는 파일은 check도 정본으로 세지 않는다. 세지 않는 것을 여기서
    // 세면 두 도구의 답이 갈린다.
    if (!frontmatter) continue;
    const relative = path.relative(project.root, entry.file).split(path.sep).join('/');
    documents.push({
      file: relative,
      origin: entry.origin,
      id: frontmatter.data.id === undefined ? null : String(frontmatter.data.id),
      kind: frontmatter.data.kind === undefined ? null : String(frontmatter.data.kind),
      state: frontmatter.data.state === undefined ? null : String(frontmatter.data.state),
      // 정본 문서인가. 11절 표가 세는 125는 이 축이 참인 것들이고, inbox의 클리핑과
      // 헌장이 그 밖에 있다.
      canonical: entry.origin === 'scanned' && !relative.startsWith('inbox/')
    });
  }
  return documents;
}

function readTasks(project) {
  const store = readTaskStore(project.tasks);
  return Object.entries(store.tasks).map(([id, task]) => Object.assign({ id }, task));
}

// ── 집계 ────────────────────────────────────────────────────────────────

function tally(rows, key) {
  const result = {};
  for (const row of rows) {
    const value = key(row);
    result[value] = (result[value] || 0) + 1;
  }
  return result;
}

function stepLabel(classified) {
  if (!classified.mapped) return '(자리 없음)';
  return classified.validity ? `${classified.step}·${classified.validity}` : classified.step;
}

// 쉬운 절반. 값 하나가 스텝 하나로 떨어지는 것들이며, 표의 모양은 11절 그대로다.
function mapItems(items, classify, valueOf) {
  const rows = new Map();
  const unplaced = [];
  for (const item of items) {
    const classified = classify(valueOf(item));
    const key = classified.value === null ? '(값 없음)' : classified.value;
    if (!rows.has(key)) {
      rows.set(key, { value: key, count: 0, step: classified.step, validity: classified.validity, mapped: classified.mapped, declared: classified.declared, source: classified.source });
    }
    rows.get(key).count += 1;
    if (!classified.mapped) unplaced.push({ item, classified });
  }
  return { rows: Array.from(rows.values()).sort((left, right) => right.count - left.count), unplaced };
}

// ── 어려운 절반 ─────────────────────────────────────────────────────────

// 1. 유형이 없으면 어느 워크플로도 못 탄다. 항목 유형 → 워크플로가 N:1이기 때문이다.
function kindlessTasks(tasks) {
  const missing = tasks.filter((task) => task.kind === undefined || task.kind === null || String(task.kind).trim() === '');
  return { count: missing.length, total: tasks.length, byStatus: tally(missing, (task) => task.status), ids: missing.map((task) => task.id) };
}

// 2. TST 링크 없이 done인 것. 11절이 "구분되지 않는다"고 적었던 자리이고, 발화 이력이
//    켜지면서 구분되기 시작했다. 면제인지, 게이트보다 오래된 것인지, 진짜 위반인지를
//    가른다 — 면제는 태스크가 직접 들고 있으므로 원장이 없어도 답할 수 있다.
function doneWithoutTestLink(tasks) {
  const done = tasks.filter((task) => task.status === 'done');
  const missing = done.filter((task) => !(Array.isArray(task.links) ? task.links : []).some((link) => String(link).startsWith('TST-')));
  const exempted = [];
  const violations = [];
  let unexplained = 0;
  for (const task of missing) {
    const gates = exemptionGates(task.exemption);
    if (!gates.includes('done-requires-test-link')) { violations.push(task.id); continue; }
    const reason = task.exemption && task.exemption.reason ? String(task.exemption.reason).trim() : '';
    if (!reason) unexplained += 1;
    exempted.push({ id: task.id, gates, reason: reason || null, decidedBy: (task.exemption && task.exemption.decidedBy) || null });
  }
  return {
    done: done.length,
    count: missing.length,
    exempted: exempted.length,
    withReason: exempted.filter((entry) => entry.reason).length,
    unexplained,
    // 면제도 아니고 사유도 없는 것. 이것만이 진짜 위반이다.
    violations,
    entries: exempted
  };
}

// 3. 런 없는 과거. 어느 전환을 밟았는지 기록이 없다.
function runlessHistory(project, tasks, documents) {
  let runs = [];
  try { runs = ledger.listRuns(project.root); } catch (_) { runs = []; }
  const subjects = new Set();
  for (const run of runs) {
    for (const field of ['taskId', 'subject', 'artifactId', 'target']) {
      if (run && run[field]) subjects.add(String(run[field]));
    }
  }
  const covered = tasks.filter((task) => subjects.has(task.id)).length
    + documents.filter((doc) => doc.id && subjects.has(doc.id)).length;
  const total = tasks.length + documents.length;
  return { runs: runs.length, covered, total, uncovered: total - covered };
}

// 4. workset.js의 어휘 밖 'open'. 옮길 대상이 없으니 롤업을 다시 계산해야 한다.
//
//    지금 묶음이 0건이라는 사실만 적으면 "쓰이지 않으니 괜찮다"로 읽힌다. 그 값이
//    지금 안 나오는 것과 나올 수 없는 것은 다르므로, 실제 태스크로 묶음을 만들어
//    도달 가능한지 확인한다. 도달하면 그것은 죽은 값이 아니라 잠복한 값이다.
function worksetRollup(tasks) {
  const live = worksets(tasks);
  const outOfVocabulary = live.worksets.filter((entry) => entry.status === 'open');
  // 도달성 확인. 브랜치 참조를 붙인 사본으로만 계산하며 저장소는 건드리지 않는다.
  const probeSource = tasks.filter((task) => task.status === 'todo').slice(0, 1)
    .map((task) => Object.assign({}, task, { externalRefs: [{ kind: 'branch', value: 'probe/reachability' }] }));
  const probe = probeSource.length ? worksets(probeSource).worksets[0] : null;
  return {
    worksets: live.worksets.length,
    unassigned: live.unassigned.length,
    outOfVocabulary: outOfVocabulary.length,
    reachable: Boolean(probe && probe.status === 'open'),
    probeStatus: probe ? probe.status : null,
    // 스텝 공간에서 다시 계산한 값. 'open'이 답하던 자리를 unclaimed가 받는다.
    recomputed: probe ? map.rollupStep(probe.tasks.map((task) => map.classifyTaskStatus(task.status).step)) : null
  };
}

// 5. 묶음 유형. 지금 묶음은 저장 개체가 아니라 파생이라 유형을 붙일 곳이 없다.
function worksetTyping(tasks) {
  const live = worksets(tasks);
  return {
    stored: false,
    derivedFrom: 'externalRefs[branch]',
    worksets: live.worksets.length,
    // 유형을 주면 파생이 아니게 된다. 파생인 동안에는 유형을 적을 자리 자체가 없다.
    typeCarriers: 0
  };
}

// ── 소급 적용 ───────────────────────────────────────────────────────────
//
// 새 →완료 전환에 걸릴 검증 둘을 기존 done에 그대로 적용하면 무엇이 걸리는가.
// 11절이 실제로 재 본 것이고, 두 규칙이 소급 안전성에서 정반대라는 것이 그 결과였다.
function retroactive(tasks) {
  const done = tasks.filter((task) => task.status === 'done');
  const acceptance = [];
  const testLink = [];
  for (const task of done) {
    const findings = map.completionGateFindings(task);
    if (findings.includes('acceptance-not-all-done')) acceptance.push(task.id);
    if (findings.includes('no-test-link')) testLink.push(task.id);
  }
  return { done: done.length, acceptanceViolations: acceptance.length, testLinkViolations: testLink.length, acceptance, testLink };
}

// ── 판정 ────────────────────────────────────────────────────────────────

function audit(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project || null, true);
  const tasks = readTasks(project);
  const documents = readDocuments(project);

  const taskMapping = mapItems(tasks, map.classifyTaskStatus, (task) => task.status);
  const documentMapping = mapItems(documents, map.classifyDocumentState, (doc) => doc.state);

  const unplaced = []
    .concat(taskMapping.unplaced.map((entry) => ({ kind: 'task', id: entry.item.id, value: entry.classified.value, declared: entry.classified.declared, title: entry.item.title || null })))
    .concat(documentMapping.unplaced.map((entry) => ({ kind: 'document', id: entry.item.id, value: entry.classified.value, declared: entry.classified.declared, file: entry.item.file })));

  const hard = {
    kindless: kindlessTasks(tasks),
    doneWithoutTestLink: doneWithoutTestLink(tasks),
    runless: runlessHistory(project, tasks, documents),
    worksetRollup: worksetRollup(tasks),
    worksetTyping: worksetTyping(tasks)
  };

  return {
    schemaVersion: 1,
    root: layout.root,
    project: project.key,
    universe: {
      tasks: tasks.length,
      documents: documents.length,
      canonicalDocuments: documents.filter((doc) => doc.canonical).length,
      charter: documents.filter((doc) => doc.origin === 'charter').length,
      nonCanonical: documents.filter((doc) => !doc.canonical && doc.origin !== 'charter').map((doc) => doc.file)
    },
    tasks: taskMapping.rows,
    documents: documentMapping.rows,
    unplaced,
    vocabularyHoles: map.unmappedVocabulary(),
    undeclaredMappings: map.undeclaredMappings(),
    hard,
    retroactive: retroactive(tasks)
  };
}

// ── 출력 ────────────────────────────────────────────────────────────────

function pad(value, width) {
  const text = String(value);
  let size = 0;
  for (const char of text) size += /[ᄀ-ᇿ　-〿가-힯＀-￯]/u.test(char) ? 2 : 1;
  return text + ' '.repeat(Math.max(0, width - size));
}

function render(result) {
  const lines = [];
  lines.push(`이관 검사 — 프로젝트 ${result.project}`);
  lines.push(`  태스크 ${result.universe.tasks}건 · 문서 ${result.universe.documents}건`
    + ` (정본 ${result.universe.canonicalDocuments} · 헌장 ${result.universe.charter} · 그 밖 ${result.universe.nonCanonical.length})`);
  lines.push('');

  lines.push('쉬운 절반 — 태스크');
  for (const row of result.tasks) {
    lines.push(`  ${pad(row.value, 14)}${pad(row.count, 5)}→ ${pad(row.mapped ? stepLabelOf(row) : '(자리 없음)', 22)}${row.source || ''}`);
  }
  lines.push('');
  lines.push('쉬운 절반 — 문서');
  for (const row of result.documents) {
    const note = row.mapped && !row.declared ? '  어휘 밖 값이 여기서 정식이 된다' : '';
    lines.push(`  ${pad(row.value, 14)}${pad(row.count, 5)}→ ${pad(row.mapped ? stepLabelOf(row) : '(자리 없음)', 22)}${row.source || ''}${note}`);
  }
  lines.push('');

  lines.push(`자리를 못 찾은 항목 — ${result.unplaced.length}건`);
  if (!result.unplaced.length) lines.push('  없음');
  for (const entry of result.unplaced) {
    const where = entry.kind === 'task' ? `${entry.id} ${entry.title || ''}` : `${entry.file}${entry.id ? ` (${entry.id})` : ''}`;
    lines.push(`  ${pad(entry.kind, 9)}state=${pad(entry.value === null ? '(없음)' : entry.value, 10)}${entry.declared ? '어휘 안' : '어휘 밖'}  ${where}`);
  }
  lines.push('');

  lines.push('어휘가 선언했으나 지도에 없는 값 — 모델의 구멍');
  lines.push(`  태스크 상태: ${result.vocabularyHoles.taskStatuses.join(' · ') || '없음'}`);
  lines.push(`  문서 상태:   ${result.vocabularyHoles.documentStates.join(' · ') || '없음'}`);
  lines.push('');

  const hard = result.hard;
  lines.push('어려운 절반');
  lines.push(`  1. kind 없는 태스크        ${hard.kindless.count}/${hard.kindless.total}건`
    + `  (${Object.entries(hard.kindless.byStatus).map(([key, value]) => `${key} ${value}`).join(' · ')})`);
  lines.push(`  2. TST 링크 없이 done      ${hard.doneWithoutTestLink.count}건 중 면제 ${hard.doneWithoutTestLink.exempted}`
    + ` · 사유 있음 ${hard.doneWithoutTestLink.withReason} · 사유 없음 ${hard.doneWithoutTestLink.unexplained}`
    + ` · 진짜 위반 ${hard.doneWithoutTestLink.violations.length}`);
  lines.push(`  3. 런 없는 과거            런 ${hard.runless.runs}건 · 전환 기록 없는 항목 ${hard.runless.uncovered}/${hard.runless.total}`);
  lines.push(`  4. workset.js의 'open'     묶음 ${hard.worksetRollup.worksets}건 · 어휘 밖 값 ${hard.worksetRollup.outOfVocabulary}건`
    + ` · 도달 가능 ${hard.worksetRollup.reachable ? '그렇다' : '아니다'}`
    + (hard.worksetRollup.recomputed && hard.worksetRollup.recomputed.step ? ` → 스텝 공간 재계산: ${hard.worksetRollup.recomputed.step}` : ''));
  lines.push(`  5. 묶음 유형               저장 개체 아님 · ${hard.worksetTyping.derivedFrom}에서 파생 · 유형을 적을 자리 ${hard.worksetTyping.typeCarriers}`);
  lines.push('');

  lines.push('소급 적용 — 새 →완료 검증을 기존 done에 그대로 걸면');
  lines.push(`  수용조건이 전부 done인가    ${result.retroactive.done}건 중 위반 ${result.retroactive.acceptanceViolations}`);
  lines.push(`  TST 문서가 링크되어 있는가  ${result.retroactive.done}건 중 위반 ${result.retroactive.testLinkViolations}`);
  return lines.join('\n');
}

function stepLabelOf(row) {
  return row.validity ? `${row.step}·${row.validity}` : row.step;
}

function main(argv) {
  const args = argv.slice(2);
  const options = { root: process.cwd(), project: null, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--json') options.json = true;
    else if (value === '--project') { index += 1; options.project = args[index]; }
    else if (value === '--root') { index += 1; options.root = args[index]; }
    else throw new Error(`알 수 없는 인수입니다: ${value}`);
  }
  const result = audit(options.root, options);
  process.stdout.write((options.json ? JSON.stringify(result, null, 2) : render(result)) + '\n');
  // 자리를 못 찾은 항목이 있으면 실패로 끝난다. 이관이 모델의 시험이라면 그 시험은
  // 통과하거나 떨어지거나여야 하고, 언제나 0으로 끝나는 검사는 검사가 아니다.
  return result.unplaced.length ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    process.stderr.write(`이관 검사 실패: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = Object.freeze({ audit, render, readDocuments, readTasks });
