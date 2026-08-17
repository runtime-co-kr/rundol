'use strict';

const os = require('os');
const path = require('path');
process.env.RUNDOL_HOME = path.join(os.tmpdir(), `rundol-test-runtime-${process.pid}`);

require('./check.test');
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
require('./document-composite.test');
require('./implementation-contract.test');
require('./document-contract.test');
require('./document-grouping.test');
require('./document-migration.test');
require('./note-artifact.test');
require('./git.test');
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
require('./harness-settings.test');
require('./sync-finalization.test');
require('./verify.test');
require('./watch-cli.test');
require('./watch-runtime.test');
require('./drive-cli.test');
require('./driver-lease.test');
require('./p15-compat.test');
require('./packages.test');
require('./board-data.test');
require('./board-presentation.test');
require('./board-ui.test');

require('./watch.test').then(() => require('./adapter.test')).then(() => require('./drive.test')).then(() => Promise.all([
  require('./board.test'),
  require('./board-workspace.test'),
  require('./event-store.test')
])).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
