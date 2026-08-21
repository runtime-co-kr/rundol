'use strict';

const os = require('os');
const path = require('path');
process.env.RUNDOL_HOME = path.join(os.tmpdir(), `rundol-test-runtime-${process.pid}`);
// Windows에서 어댑터 자동 실행은 기본으로 막혀 있다. 여기서 전역으로 켜면
// 전체 스위트가 위험 모드에서만 돌고, "기본은 막힌다"가 한 번도 시험되지
// 않는다 — 게이트가 자기가 지켜야 할 상태를 가린다. 켜야 하는 스위트는
// 각자 자기 파일에서 켠다.

require('./check.test');
require('./ledger-integrity.test');
require('./adversarial.test');
require('./cli-doc.test');
require('./init.test');
require('./attach.test');
require('./bootstrap.test');
require('./bootstrap-cli.test');
require('./branch-boundary.test');
require('./guided.test');
require('./document-profile.test');
require('./document-boundary.test');
require('./document-diagram.test');
require('./test-contract.test');
require('./task-kind.test');
require('./test-round.test');
require('./document-composite.test');
require('./implementation-contract.test');
require('./document-contract.test');
require('./document-grouping.test');
require('./document-migration.test');
require('./note-artifact.test');
require('./git.test');
require('./task-identity.test');
require('./task-binding.test');
require('./collaboration.test');
require('./collaboration-store.test');
require('./skill-install.test');
require('./obsidian.test');
require('./features.test');
require('./doctor.test');
require('./release.test');
require('./docs.test');
require('./action.test');
require('./agent-context.test');
require('./authority.test');
require('./setup.test');
require('./decision.test');
require('./delegation.test');
require('./workset.test');
require('./approval.test');
require('./document-identity.test');
require('./query-index.test');
require('./document-analysis.test');
require('./run-ledger.test');
require('./run-cli.test');
require('./run-pending.test');
require('./session.test');
require('./save-lock.test');
require('./harness-settings.test');
require('./sync-finalization.test');
require('./verify.test');
require('./watch-cli.test');
require('./watch-runtime.test');
require('./drive-cli.test');
require('./drive-end-to-end.test');
require('./driver-lease.test');
require('./p15-compat.test');
require('./packages.test');
require('./board-data.test');
require('./board-presentation.test');
require('./board-ui.test');
require('./document-roundtrip.test');
require('./worker-contract.test');
require('./worker-contract-purity.test');
require('./surface-leak.test');
require('./human-intervention.test');
require('./task-link.test');
require('./asset.test');
require('./comment.test');
require('./assignment.test');
require('./approval-mode.test');
require('./item-type.test');
require('./item-type-migration.test');
require('./diagnostic-rules.test');
// 편집기 시험은 remark(ESM 전용)를 동적 import로 읽으므로 promise를 내보낸다.
// 아래 사슬에 얹지 않고 따로 두는 이유는 순서가 아니라 격리다 — 앞 시험이 넘어지면
// 사슬에 얹힌 것들은 아예 돌지 않고, 돌지 않은 시험은 통과한 시험과 구분되지 않는다.
require('./editor-roundtrip.test').catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
require('./editor-block-move.test').catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

require('./verify-concurrency.test').then(() => require('./verify-independence.test')).then(() => require('./author-fanout.test')).then(() => require('./windows-termination.test')).then(() => require('./watch.test')).then(() => require('./adapter.test')).then(() => require('./drive.test')).then(() => Promise.all([
  require('./board.test'),
  require('./board-workspace.test'),
  require('./event-store.test')
])).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
