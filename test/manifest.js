'use strict';

// 시험 목록의 정본. 실행기와 워커가 같은 목록을 봐야 나눈 것과 돌린 것이 갈리지 않는다.
//
// 나누는 축은 "순서가 필요한가"다. 대부분의 시험은 자기 임시 디렉터리와 자기
// RUNDOL_HOME에서 도므로 서로를 보지 않고, 그래서 어느 순서로 돌든 같은 답을 낸다.
// 그렇지 않은 것만 CHAIN에 있다.

// 순서를 요구하지 않는 시험. 워커 수만큼 나누어 돌린다.
const PARALLEL = Object.freeze([
  'check', 'ledger-integrity', 'adversarial', 'cli-doc', 'init', 'attach',
  'bootstrap', 'bootstrap-cli', 'branch-boundary', 'guided', 'document-profile',
  'document-boundary', 'document-diagram', 'test-contract', 'task-kind', 'test-round',
  'document-composite', 'implementation-contract', 'document-contract', 'document-grouping',
  'document-migration', 'note-artifact', 'git', 'task-identity', 'task-binding',
  'task-exemption', 'hook', 'collaboration', 'collaboration-store', 'skill-install',
  'obsidian', 'features', 'doctor', 'release', 'docs', 'action', 'agent-context',
  'authority', 'setup', 'decision', 'delegation', 'workset', 'approval',
  'document-identity', 'query-index', 'document-analysis', 'run-ledger', 'run-cli',
  'run-pending', 'session', 'save-lock', 'harness-settings', 'sync-finalization',
  'verify', 'watch-cli', 'watch-runtime', 'drive-cli', 'drive-end-to-end',
  'driver-lease', 'p15-compat', 'packages', 'board-data', 'board-presentation',
  'board-ui', 'document-roundtrip', 'worker-contract', 'worker-contract-purity',
  'vocabulary', 'surface-leak', 'human-intervention', 'task-link', 'asset',
  'comment', 'assignment', 'approval-mode', 'item-type', 'item-type-migration',
  'diagnostic-rules', 'run-driver', 'manifest-coverage', 'commit-boundary', 'rule-telemetry',
  'workflow',
  'workflow-config'
]);

// remark(ESM 전용)를 동적 import로 읽어 promise를 내보내는 시험. 서로 얹지 않는
// 이유는 순서가 아니라 격리다 — 사슬에 얹으면 앞이 넘어질 때 뒤가 아예 돌지 않고,
// 돌지 않은 시험은 통과한 시험과 구분되지 않는다.
const ASYNC = Object.freeze(['editor-roundtrip', 'editor-block-move', 'editor-live']);

// 순서가 필요한 사슬. 프로세스를 띄우고 포트를 잡고 잠금을 다투는 시험들이라
// 동시에 돌리면 서로의 실패 원인이 된다. 한 워커 안에서 이 순서 그대로 돈다.
const CHAIN = Object.freeze([
  'verify-concurrency', 'verify-independence', 'author-fanout',
  'windows-termination', 'watch', 'adapter', 'drive'
]);

// 사슬이 끝난 뒤 함께 도는 시험. 원래도 Promise.all로 함께 돌던 묶음이다.
const CHAIN_TAIL = Object.freeze(['board', 'board-workspace', 'board-run', 'event-store']);

// npm test가 돌리지 않는 시험. tarball을 만들어 설치하므로 npm run test:install이
// 따로 돈다. 목록에 적어 두는 이유는 빠진 것과 일부러 뺀 것을 가르기 위해서다 —
// 그 구분이 없으면 목록에 없는 파일이 실수인지 결정인지 아무도 답할 수 없다.
const INSTALL_ONLY = Object.freeze(['install', 'tarball-compat']);

module.exports = { PARALLEL, ASYNC, CHAIN, CHAIN_TAIL, INSTALL_ONLY };
