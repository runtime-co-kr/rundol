# Harness continuation context

## Task statement

Continue and finish four development tranches in architectural sequence:

1. kernel hardening for the implemented P0/P1/P0.28 contracts;
2. P1.5 verify and runtime adapter (SPEC-3, SPEC-7);
3. P2 read-only watch (SPEC-5, SPEC-6, SPEC-8);
4. P3 drive (SPEC-5, SPEC-6).

## Desired outcome

Deliver the four tranches without breaking Rundol's serverless Git model, deterministic folds, branch-role boundaries, mixed-version tolerance, or existing CLI exit-code contracts. Each tranche must have targeted regression tests and the final repository must pass the full test and release checks.

## Known facts and evidence

- Current `main`, `origin/main`, `harness/kernel`, and `origin/harness/kernel` all point to `8d1c6df` (`0.28.1` version stamp).
- Source commits for 0.25.0 through 0.28.1 are merged, but remote Git tags and npm registry versions stop at 0.24.1. Publishing remains out of scope unless explicitly authorized.
- Existing approved plans:
  - `.elder-gods/plans/p0a-p0b-event-store.md`
  - `.elder-gods/plans/p0c-shared-ledger.md`
  - `.elder-gods/plans/p1-procedure-run.md`
  - `.elder-gods/plans/p028-granularity.md`
- Harness specification rev 2 is available in the attached `pasted-text.txt`; relevant sections are SPEC-2 through SPEC-8 and implementation stages P1.5/P2/P3.
- Full current `npm test` passed before this planning run. `git diff --check` and version check also passed.
- `rdl git boundary --json` reports valid=true and violations=[] for code/main, workspace, and project roles. `rdl init` attempted to revalidate the managed pre-push hook but was denied because rewriting `.git/hooks/pre-push` is security-sensitive; the boundary report says the existing hook is installed and managed.

## Required kernel hardening findings

1. `src/run.js` authorizes commands from the local ledger only; after takeover an old owner can still emit stale events.
2. `src/run-ledger.js` orders whole client partitions, has no ownership epoch/fencing token, cannot represent A->B->A correctly, and can fold stale old-owner events.
3. `reportStep` permits off-cursor `--step`; `foldRun` accepts successful `run.step` without checking cursor or step kind, allowing gate/human-step bypass.
4. Local append precedes shared mirror with no durable reconciliation/outbox.
5. `src/state.js` pushes workspace before appending `run.synced`; transition failures are swallowed.
6. `src/procedure.js` allows child definitions to delete a parent gate's `onFail` contract.
7. Task readiness validates linked REQ/TST but omits linked SCR/MOD/API granularity violations.
8. `rdl run gate` collapses environmental exit code 2 to 1.

## Constraints

- No new npm dependencies.
- No tag creation, npm publish, force push, or external production changes.
- Preserve existing uncommitted/user changes if any; worktree was clean at intake.
- Use `apply_patch` for file edits.
- Do not edit project/workspace branch files from the code worktree.
- Unknown event kinds remain tolerated for mixed-version clients.
- No wall-clock ownership decisions, no server/daemon, no SQLite canonical store.
- Verdict events contain metadata and minimal findings only; no prompts, transcripts, or document body copies.
- Watch is observational: no canonical/worktree/shared-ledger writes.
- Drive is allowed only for idempotent procedures and must stop at human sync gates.

## Likely codebase touchpoints

- Kernel: `src/event-store.js`, `src/run-ledger.js`, `src/run.js`, `src/procedure.js`, `src/state.js`, `src/check.js`, `src/implementation-contract.js`, `bin/rdl.js`
- P1.5: new `src/adapter.js`, new `src/verify.js`, `src/settings.js`, `src/doctor.js`, procedure/run/check/CLI integration
- P2: new `src/watch.js`, `src/board-data.js`, `src/runtime.js`, CLI integration
- P3: `src/run.js`, `src/run-ledger.js`, `src/runtime.js`, settings/workspace config, CLI integration
- Tests: existing run/event/implementation tests plus new adapter, verify, watch, drive, concurrency, failure-injection, and mixed-version tests
- Docs/releases: update only after behavior is implemented and verified; do not publish or tag.

## Unknowns to resolve in planning

- Exact ownership-epoch representation that stays mergeable under client-sharded Git files and resolves concurrent takeover fail-closed.
- Reconciliation semantics for local/shared partial append without introducing a database or hidden mutable truth.
- Adapter configuration schema migration and safe process-tree termination strategy on Windows.
- Shared revision calculator between Board and watch.
- Exact lease renewal ownership and scheduler convention for drive.

## Stop conditions

- Do not start P1.5 until kernel regression tests prove stale-owner rejection, off-cursor rejection, retry-contract preservation, and same-sync remote `run.synced` propagation semantics.
- Do not start P2/P3 until their preceding tranche is green.
- Final completion requires targeted suites, full `npm test`, `npm run version:check`, and `npm run release:check`; any environmental validation gap must be explicit.
