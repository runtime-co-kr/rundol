'use strict';

const { workspaceLayout, selectProject } = require('./workspace');
const { readTaskStore, testedDocuments } = require('./tasks');
const { projectArtifacts } = require('./document-contract');

// 차수 대상 목록은 어디에도 저장하지 않는다. 태스크를 만든 것이 곧 그 차수의 범위이고,
// 빠진 것은 TST 문서 전체와 대조해 계산한다. 목록을 파일로 두면 정본이 둘이 되어,
// 목록에는 다섯인데 태스크는 셋인 상태를 아무도 알아채지 못한다.
function documentTitle(source) {
  const match = /^title:\s*([^\r\n]+)/mu.exec(String(source || ''));
  return match ? match[1].trim().replace(/^['"]|['"]$/gu, '') : null;
}

function testDocuments(project) {
  return projectArtifacts(project)
    .filter((artifact) => artifact.type === 'TST')
    .map((artifact) => ({ id: artifact.id, title: documentTitle(artifact.source) }));
}

function testTasks(project) {
  const store = readTaskStore(project.tasks);
  const entries = [];
  for (const [id, task] of Object.entries(store.tasks || {})) {
    if ((task.kind || 'normal') !== 'test') continue;
    const [document] = testedDocuments(task);
    entries.push({
      id,
      title: task.title || '',
      round: task.round === undefined ? null : task.round,
      status: task.status || null,
      result: task.result === undefined ? null : task.result,
      owner: task.owner || null,
      document: document || null
    });
  }
  return entries.sort((left, right) => (left.round || 0) - (right.round || 0)
    || String(left.document).localeCompare(String(right.document))
    || String(left.id).localeCompare(String(right.id)));
}

// 판정이 없는 테스트는 아직 돌리지 않은 것이고, 반려한 테스트는 돌리지 않기로 한
// 것이다. 한 통에 담으면 남은 일감이 실제보다 부풀어 보인다.
function resultBucket(task) {
  return task.result || (task.status === 'cancelled' ? 'cancelled' : 'pending');
}

function summarize(tasks) {
  const results = {};
  for (const task of tasks) {
    const bucket = resultBucket(task);
    results[bucket] = (results[bucket] || 0) + 1;
  }
  return results;
}

function roundReport(project, round, documents) {
  const tasks = testTasks(project).filter((task) => task.round === round);
  const covered = new Set(tasks.map((task) => task.document).filter(Boolean));
  return {
    round,
    tasks,
    results: summarize(tasks),
    coverage: {
      total: documents.length,
      covered: documents.filter((document) => covered.has(document.id)).length,
      missing: documents.filter((document) => !covered.has(document.id))
    }
  };
}

function testRounds(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const documents = testDocuments(project);
  const tasks = testTasks(project);
  const rounds = Array.from(new Set(tasks.map((task) => task.round).filter((round) => Number.isInteger(round)))).sort((left, right) => left - right);
  const base = { root: layout.root, project: project.key, documents: documents.length, rounds, latest: rounds.length ? rounds[rounds.length - 1] : null };
  if (settings.round === undefined || settings.round === null) {
    return Object.assign(base, { summary: rounds.map((round) => {
      const report = roundReport(project, round, documents);
      return { round, tasks: report.tasks.length, results: report.results, covered: report.coverage.covered, total: report.coverage.total };
    }) });
  }
  return Object.assign(base, roundReport(project, settings.round, documents));
}

module.exports = { testRounds, testTasks, testDocuments };
