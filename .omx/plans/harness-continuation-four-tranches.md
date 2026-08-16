# Rundol Harness Continuation — Four-Tranche Deliberate Consensus Draft

## Outcome

Complete the remaining harness work in four strictly ordered tranches without replacing Rundol's serverless Git/event-fold architecture:

1. harden the existing kernel;
2. add P1.5 verification and runtime adapters;
3. add P2 observational watch;
4. add P3 idempotent drive.

The stop condition is a clean code worktree whose targeted suites, full `npm test`, `npm run version:check`, `npm run release:check`, `git diff --check`, and branch-boundary checks all pass. Tag creation, npm publication, force push, and production-side changes remain out of scope.

## Evidence Baseline

- The current run implementation derives command authorization from the local ledger (`src/run.js:12-29`), while shared ordering concatenates whole client partitions (`src/run-ledger.js:273-294`). This cannot fence stale writes or represent A->B->A ownership safely.
- `reportStep` accepts a non-cursor step and treats it as an ordinary client step (`src/run.js:90-107`); `foldRun` completes any successful `run.step` without cursor or step-kind validation (`src/run-ledger.js:155-173`).
- `recordRunEvent` appends locally before mirroring, with no shared event-idempotency or repair (`src/run-ledger.js:252-261`).
- `run.synced` is appended after the project push and after the workspace sync has already occurred (`src/state.js:614-645`, `src/state.js:648-652`); transition failures are swallowed (`src/state.js:617-629`).
- Procedure override validation permits removal of a parent's `onFail` object (`src/procedure.js:44-63`).
- Task implementation readiness validates only REQ and TST document bodies (`src/implementation-contract.js:189-207`).
- `rdl run gate` maps every nonzero child exit to CLI exit 1 (`bin/rdl.js:643-647`), losing environmental exit 2.
- Existing reusable seams are the generic append store (`src/event-store.js`), runtime home and locks (`src/runtime.js:9-52`), the single procedure resolver (`src/procedure.js:65-101`), the programmatic checker (`src/check.js:708-769`), and Board document revisions (`src/board-data.js:9-47`).

## Requirements and Invariants

### Must preserve

- One writer per shared shard; merge is file-set union.
- Current state is always a deterministic fold, never a shared materialized record.
- No wall-clock ownership decisions and no promise of strong cross-machine exclusion.
- Unknown event kinds/fields remain readable by mixed-version clients.
- All execution decisions remain in deterministic CLI code; adapters are untrusted workers.
- The same CLI commands serve interactive clients and drive.
- Shared verdict/run/driver events, debug logs, and CLI JSON/human output contain only IDs, revisions, codes, bounded findings, and adapter metadata—never instruction payloads, prompts, transcripts, document bodies, credentials, or raw adapter/model output. The sole allowed persisted instruction payload is the bounded immutable registry instruction copied into the local Git-ignored `instruction.json` for one adapter invocation.
- Watch may write only a rebuildable ignored cache and process lock; it must not modify project/workspace worktrees or shared ledgers.
- Drive is available only for procedures pinned with `idempotent: true`, stops at human/sync gates, and has no execution polling loop.
- No new npm dependencies.

### Version policy

The fixed ladder is `0.29.0` kernel hardening, `0.30.0` P1.5, `0.31.0` P2, and `0.32.0` P3. Kernel hardening changes shared ownership semantics and therefore is not a `0.28.x` patch. The compatibility baseline is a locally packed CLI tarball built from commit `8d1c6df` (the 0.28.1 version stamp), not an npm tag or registry release. Each later tranche also tests against the immediately preceding accepted tranche tarball. Do not tag or publish in this task.

## Normative Protocol Schemas

### Canonical normalization

- IDs are validated before normalization: client/project/adapter/lens/step IDs use their declared lowercase ASCII patterns; run/request/event IDs use uppercase hexadecimal patterns; Git revisions are lowercase 40-64 hexadecimal strings; unknown forms are rejected, not coerced.
- User prose is Unicode NFC, CRLF->LF, trimmed, and bounded: goal 500 chars, reason 1000, finding summary 1000, heading 200. Embedded NUL/control characters except LF/TAB are rejected. Single-line fields collapse internal LF to one space.
- Optional fields are omitted, never serialized as `undefined`; `null` appears only where the schema explicitly permits it. Integers must be safe integers. Booleans are literal booleans.
- Semantically unordered arrays are unique and lexically sorted before digest: artifact IDs, diagnostic codes, candidate tuples (by decisionEventId then selected token), findings (by file/heading/blockId/summary), and context paths. Procedure step order and argv order remain ordered and are never sorted.
- Objects use recursive key sorting through `canonicalJson`. `occurredAt`, localDetail, writer/process annotations, and canonicalDigest itself are outside the digest. Canonical lease fields such as `expiresAt` remain inside the digest. `canonicalDigest` is lowercase SHA-256 hex of the exact normalized canonical object.
- Every field whose contract is a SHA-256 value or hash ID—canonicalDigest, legacyDigest, contentHash, instructionDigest, commandDigest, argsTemplateDigest, conflictId, operationId, outcomeDigest, scanRevision, dedupKey, relationKey, and every named `*Digest`/`*Hash`—is exactly 64 lowercase hexadecimal characters representing all 32 digest bytes; truncation, uppercase encoding, base64, and platform-dependent text encoding are forbidden. Prefixed entity identifiers (`RUN-`, `REQ-`, `EVT-`, `VAL-`, `INV-`) retain their separately specified prefix/20-uppercase-hex entity grammar and are not hash-valued fields; RUN/EVT keep existing wire compatibility even when their deterministic generator consumes a digest prefix.

### JSONL envelope and run schema v2

For mixed-version readability, canonical event fields are serialized flat at the JSONL top level, not under a new `canonical` object. A shared line contains exactly the type's canonical fields plus `canonicalDigest` and optional noncanonical `occurredAt`; a local line may additionally contain `localDetail`. `canonicalDigest`, `occurredAt`, and `localDetail` are excluded before normalization/digest. This preserves the field shape seen by the `8d1c6df`/0.28.1 reader while allowing new readers to validate the digest and projection. Unknown canonical fields are rejected by the new writer/validator, while the preceding reader continues its registered-kind unknown-field tolerance.

Every canonical run event contains exactly `schemaVersion:2`, `eventId`, `type`, `rootRequestId`, `requestId` (the deterministic childRequestId), `clientId`, `projectId`, and `runId`, plus the type fields below. Unknown canonical fields are rejected; annotations/localDetail are top-level noncanonical envelope additions.

| Type | Exact additional canonical fields |
|---|---|
| `run.started` | `ownerToken` (=eventId), `goal?`, `procedure:{name,revision,schemaVersion,contentHash,resolved}`, `settings:{schemaVersion,contentHash,workspaceRevision?,projectRevision?,safeResolved}` |
| `run.step` | `ownerToken`, `stepId`, `executor:'cli'|'adapter'|'client'`, `exitCode`, `artifactIds[]`, `operation?` |
| `run.gate` | `ownerToken`, `stepId`, `command`, `args[]`, `exitCode`, `diagnostics[]`, `attempt`, `operation?` |
| `run.forced` | `ownerToken`, `stepId`, `reason`, `operation?` |
| `run.halted` | `ownerToken?`, `reason`, `atStep?`, `resumable`, `operation?` |
| `run.resumed` | `ownerToken`, `fromStep` |
| `run.takeover` | `ownerToken` (=eventId), `previousClientId`, `previousOwnerToken`, `previousOwnerHeadEventId`, `basis:'halted'|'forced'`, `reason?` |
| `run.ownership_resolved` | `conflictId`, `candidates:[{decisionEventId,selectedOwnerToken}]`, `selectedDecisionEventId`, `selectedOwnerToken`, `resolverMemberId`, `reason`, `forced` |
| `run.operation_resolved` | `ownerToken`, `operationId`, `conflictId`, `candidates:[{decisionEventId,selectedOutcomeDigest}]`, `selectedDecisionEventId`, `selectedOutcomeDigest`, `resolverMemberId`, `reason`, `forced` |
| `run.completed_local` | `ownerToken`, `commit`, `artifactIds[]` |
| `run.synced` | `ownerToken`, `commit`, `remoteRef` |

The resolved procedure object is canonical execution data and therefore shared, but adapter manifests/results and all localDetail are not. Schema-v1 events are read through the explicitly bounded legacy mapping; new writers emit only v2.

`operation`, when present, is an indivisible exact object `{operationId,logicalAttempt,outcomeKind,outcomeDigest,boundedResultDecision}`; partial groups or an operation on any other run type are rejected. Its normalized decision object must match the outcome-kind table in tranche 4, and recomputing `outcomeDigest` must match. A non-drive writer omits it.

### Exact schema-v1 internal compatibility mapping

- A legacy run record is a flat record with absent/`1` schemaVersion and no canonicalDigest/rootRequestId/requestId/ownerToken. Readers never rewrite it. For internal normalization, first reject any present schemaVersion other than numeric 1; clone all original top-level fields except occurredAt/canonicalDigest/localDetail; inject `schemaVersion:1` only when absent (an explicit numeric 1 is retained) **before** canonicalJson and digest. Therefore absent schemaVersion and explicit numeric 1 normalize identically, while string `"1"` is malformed. Validate eventId/runId/projectId/clientId/type and the known type's required v1 fields, then compute `legacyDigest = sha256(concatBytes(utf8('rundol.run-legacy.v1\0'),utf8(canonicalJson(normalizedLegacyObject))))`. Missing request fields map only to internal provenance `{legacyRootRequestId:'legacy:'+eventId,legacyRequestId:'legacy:'+eventId}`; they are never emitted and cannot be resumed. A schema-v1 record containing only a partial subset of canonicalDigest/rootRequestId/requestId/ownerToken is malformed rather than partly upgraded; a complete new canonical envelope requires schemaVersion 2.
- Deduplicate v1 records by eventId+legacyDigest. Byte/annotation variants with the same normalized digest fold once. The same eventId with different legacyDigest values emits `RDL-RUN-018 legacy-event-id-conflict`, excludes every variant, and places the run in fail-closed legacy-conflict. Missing/invalid eventId/run/project/client/type emits `RDL-RUN-021 legacy-malformed` and cannot affect state. Unknown future event types remain ignored without becoming progress.
- Reconstruct the legacy owner chain from exactly one run.started followed by zero or more run.takeover records whose previousClientId matches the unique current client. Internally ownerToken is the started/takeover eventId. All eligible tokenless events in that epoch's client shard map to that token. Two children of one parent, multiple starts, a broken previousClientId link, or repeated ownership of the same client (A->B->A cannot be separated inside one legacy shard) emits `RDL-RUN-019 legacy-ownership-ambiguous`; no event at or after the ambiguity advances.
- A first v2 takeover from a legacy epoch records previousOwnerHeadEventId. Only the exact visible legacy shard prefix through that eventId is eligible; later-arriving tokenless records from that client emit `RDL-RUN-020 legacy-after-cutoff` and are stale. If the cited head is absent or not in the predecessor shard, the takeover is invalid and the run halts. Thus v1 missing owner fields have one bounded structural mapping and never inherit the current owner merely from clientId.
- These codes are deterministic fold diagnostics returned by `rdl run next|list|log --json` and `rdl check`, with eventId/shard identifiers but no legacy payload body. Conflict/malformed diagnostics are errors; after-cutoff is a stale warning unless it is the only claimed progress needed to reach the observed state, in which case the run remains halted/incomplete.

### Verdict schema v1

`verdict.recorded` canonical contains exactly `schemaVersion:1,eventId,type,rootRequestId,requestId,clientId,projectId,targetId,reviewedRevision,lens,verdict,findings,adapter,validatorInstanceId` plus optional `runId,ownerToken,operation`. `requestId` is the deterministic childRequestId. `adapter` is exactly `{name,instructionId,instructionRevision,instructionDigest}`. `operation`, when present, is the same indivisible exact object defined for run events and is allowed only on a run-bound drive invocation with a verification outcome kind. `verdict` is one of pass/refuted/abstain. Each finding contains exactly bounded `summary` and optional `location:{file,heading?,blockId?}`; file is a normalized project-relative path. Run-bound verdict ownerToken must authorize against the run before it is eligible.

### Driver schema v1

Driver files are exactly `events/driver/driver-<projectId>-<clientId>-<runId>-<segment>.jsonl`, where segment is a zero-padded six-digit positive integer selected under the append lock and a shard rolls before the existing event-store byte/line limit. Every canonical event contains exactly `schemaVersion:1,eventId,type,rootRequestId,requestId,clientId,projectId,runId,leaseId,ownerToken` plus the type fields below; `requestId` is the deterministic childRequestId and filename project/client/run must match every line.

| Type | Exact additional canonical fields |
|---|---|
| `driver.acquired` | `expiresAt`, `operationId?` |
| `driver.renewed` | `previousDriverEventId`, `expiresAt`, `operationId?` |
| `driver.released` | `previousDriverEventId`, `reason:'completed'|'halted'|'lost'|'error'`, `operationId?` |

`expiresAt` is normalized ISO-8601 UTC with millisecond precision and is canonical/digested, but it controls only soft visibility and never ownership or progress. `occurredAt` is an optional noncanonical annotation. Fold is per `(projectId,runId,leaseId)`: exactly one acquire opens a chain; renew/release must match clientId, ownerToken, and the unique current `previousDriverEventId`; a valid renew replaces expiry and a valid release closes. Concurrent children, duplicate IDs with different digests, skipped predecessors, renewal after release, and owner-token mismatch invalidate the lease chain and emit diagnostics. If several valid unexpired lease chains exist after a partition, all are exposed; no event order or timestamp chooses a winner.

### Complete `harness.json` schema v1

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "sync": { "retryBackoffSeconds": [1, 2, 4], "maxAttempts": 3 },
  "watch": { "scanIntervalSeconds": 5, "remoteIntervalSeconds": null },
  "lease": { "ttlSeconds": 300, "renewFactor": 0.5 },
  "adapter": { "timeoutSeconds": 600 },
  "adapters": {
    "example": { "command": "absolute-or-PATH-name", "argsTemplate": ["..."], "timeoutSeconds": 600, "enabled": true }
  },
  "verify": { "defaultAdapter": null, "defaultLenses": ["satisfaction-v1", "omission-v1", "boundary-v1"] },
  "drive": { "schedulerClientId": null }
}
```

- Built-in defaults are the object above (with an empty adapters map). Workspace then project files deep-merge only the known singleton objects `sync`, `watch`, `lease`, `adapter`, `verify`, and `drive`; an omitted leaf inherits, while a present leaf replaces. `adapters` merges by map key, but each named entry replaces the parent entry in full. An enabled entry is exactly `{command,argsTemplate,timeoutSeconds,enabled:true}` and a disabled tombstone is exactly `{enabled:false}`; adapter name is the validated map key and is forbidden inside the value. No other partial adapter shape is valid. Arrays replace in full. No arbitrary `null`; only `watch.remoteIntervalSeconds`, `verify.defaultAdapter`, and `drive.schedulerClientId` accept null.
- Each persisted file requires exactly schemaVersion 1 and a positive integer revision. Unknown top-level/nested keys, duplicate JSON keys, wrong types, or unsupported schema versions fail closed; no silent migration or auto-rewrite. A human edit increments that file's revision. The resolved configuration reports the source layer for every value and has a canonical contentHash pinned into `run.started`.
- Bounds: backoff length 1-5, strictly increasing integers 1-60 seconds, total <=120; `maxAttempts` equals backoff length; scan 1-3600 seconds; non-null remote interval 300-86400; lease TTL 60-3600; renewFactor 0.1-0.9 and derived renewal period >=10 seconds; adapter timeout 1-3600; adapter name matches the adapter-ID grammar; command is 1-128 chars; argsTemplate has 0-64 strings of 0-2048 chars and only the documented placeholders; adapters <=32; default lenses are 1-16 unique immutable registry IDs. `verify.defaultAdapter` must name an enabled resolved adapter when used. `drive.schedulerClientId` is syntax-validated at load and must resolve to an active `agent|service` when scheduled mode is invoked.
- Workspace/project configuration files live in their respective governed branches and are changed only through normal Rundol save/sync boundaries. Configuration loading itself does not write.

### Pinned safe settings versus runtime-only settings

- `run.started.settings.safeResolved` contains exactly `{sync:{retryBackoffSeconds,maxAttempts},adapter:{timeoutSeconds},lease:{ttlSeconds,renewFactor},verify:{defaultAdapter,defaultLenses},adapterRefs:{<name>:{enabled,timeoutSeconds,commandDigest,argsTemplateDigest}}}` after inheritance. It contains no executable/path/argv text, scheduler identity, watch interval, remote name/ref, credential, environment value, or instruction prose. `settings.contentHash` digests this exact safe snapshot; layer revisions identify its source files.
- Actual adapter command and argsTemplate, resolved executable path, environment allowlist, `drive.schedulerClientId`, watch intervals, remote refs, and machine/runtime paths remain runtime-only. The command/args values are never shared; their digests in adapterRefs allow equality checking without disclosure. Instructions are pinned separately by immutable registry ID/revision/digest in the resolved procedure.
- Before every run-bound adapter/verify/drive action, reload settings, recompute the selected adapter digests and safe execution fields, and compare them with the pin. A mismatch appends no outcome, performs no spawn, and returns exit 2 with `settings-drift`; if the run has already begun an action, only the existing fail-closed halt rule may append `run.halted(settings-drift)`. Resume does not repin. The operator must restore the pinned settings or start a new run. Standalone verify pins one invocation snapshot under its root request and applies the same comparison on resume. Watch always uses current runtime settings because it cannot advance a run. Sync of a pinned run uses that run's pinned retry policy; a single sync covering several runs groups retries by identical policy without changing event identity.

### Root requests, child requests, and deterministic identities

- The public `--request-id` is always `rootRequestId`. Its journal is `<runtimeWorkspace>/pending/requests/<rootRequestId>.json` and contains the normalized root command digest plus a map of semantic child keys and phases. Each canonical event has both that rootRequestId and `requestId=childRequestId`.
- For every child, `childRequestId = REQ-<first20 uppercase hex(sha256('child\0'+rootRequestId+'\0'+childKey))>` and `eventId = EVT-<first20 uppercase hex(sha256('event\0'+childRequestId))>`. `childKey` is a normalized semantic identity, never an execution counter: single run mutation `event:<type>:<runId>`; verify `verdict:<targetId>:<reviewedRevision>:<lensId>:<validatorSlot>`; sync `transition:<projectId>:<runId>:<commit>:<type>`; drive `<driver|outcome|halt|release>:<operationId>:<mutationKind>:<predecessorEventIdOrEmpty>`. Reusing a root with a different command digest or deriving the same child key with different canonical content is exit 2/corruption.
- Verification validator slots are the explicit policy slots `1..validators` in lens-ID order. `validatorInstanceId = VAL-<first20 uppercase hex(sha256('validator\0'+rootRequestId+'\0'+targetId+'\0'+reviewedRevision+'\0'+lensId+'\0'+slot))>` and `invocationId = INV-<first20 uppercase hex(sha256('invocation\0'+validatorInstanceId))>`. Thus restart cannot double-count a validator or create a second verdict event.
- `rdl run request resume <rootRequestId> --client-id <id>` requires the same executing client recorded by the root and verifies the root arguments/config pins. It enumerates children by the command's deterministic semantic order, repairs canonical-committed projections, skips completed children, and resumes the first incomplete child. For verify, a live recorded child PID causes deterministic refusal; a dead child with unchanged manifests and no result may be spawned again in the same invocation root, a valid bounded result is consumed, and an invalid/partial result is terminal exit 2 rather than overwritten. For sync, a recorded remote commit suppresses a second push and only missing per-run transition children are repaired. For drive, the fresh fold skips applied child outcomes and continues from the first unapplied phase. Resume never generates a replacement identity or repeats a completed canonical effect.

### Client identity and CLI modes

- There is no environment-variable, machine-name, last-used, or settings fallback for a shared-event writer. Standalone `rdl verify`, public `rdl adapter run`, and `rdl run drive` require explicit `--client-id <id>`. The kernel loads that exact registry record before journal/materialization/spawn.
- `rdl verify <ARTIFACT-ID> --project <key> --client-id <id> [--adapter <name>] [--lens <registry-id>]... [--run <RUN-ID>] [--request-id <REQ-ID>]` has two modes:
  - standalone: no run; client must be active `agent|service`; adapter is explicit or the resolved non-null verify.defaultAdapter; absent adapter is exit 2;
  - run-bound: `--run` is present; folded state must be ACTIVE and clientId must equal the active run owner. Lenses/adapters come from the pinned cursor procedure step; CLI overrides that differ are exit 2.
- `rdl adapter run <name> --project <key> --run <RUN-ID> --step <STEP-ID> --mode <author|verify> --client-id <id>` is run-bound one-shot only. Run/step must equal the ACTIVE cursor, client must equal owner, and client type must be active `agent|service`. Standalone verification uses `rdl verify`, not a synthetic adapter run.
- `rdl run drive --run <RUN-ID> --project <key> --client-id <id> [--scheduled]` requires the explicit client to be active `agent|service` and equal the ACTIVE owner. Manual mode (flag absent) does not consult schedulerClientId. Scheduled mode additionally requires a non-null resolved schedulerClientId equal to the explicit client; this flag changes authorization only and does not create a scheduler daemon. A device owner must explicitly transfer the run to an agent/service before adapter/drive execution.
- Unknown client, inactive client, wrong type, wrong owner, scheduled-mode scheduler mismatch, missing flag, or disabled adapter is an argument/environment authorization error: exit 2, `{canonicalCommitted:false}`, no request journal, no process spawn, lease, shared/local event, or worktree change. Verification result refuted/abstain remains exit 1; adapter child-declared step failure is exit 1; canonical success is exit 0. `--request-id` is accepted by every public command that can append a canonical event; pure one-shot `rdl adapter run` does not accept it because that command itself never appends.

### Complete run/sync client authorization matrix

All mutating commands require explicit `--client-id`; there is no owner fallback. The client must be registered, active, and owned by an active project member. Read-only `run next|list|log|procedures|requests` require no client and cannot append.

| Command | Allowed executing client | Canonical effect |
|---|---|---|
| `run start` | active `device|agent|service` member client | becomes owner; started shard is executing client's shard |
| `run step|gate|halt|resume|complete` | current owner only; any active client type, except adapter-backed execution additionally requires `agent|service` | owner progress/transition |
| `run takeover` | proposed new active `device|agent|service` member client; forced takeover also satisfies existing member/force policy | new ownership token |
| `run ownership resolve` | without `--force`, the exact active parent-epoch client (including `device`) whose owner is an active member; with `--force`, a different active member's `agent|service` client, never a device | conflict decision only |
| `run operation resolve` | current owner `agent|service`, or another active member `agent|service` only with `--force` | selected already-recorded outcome |
| `verify` standalone | active `agent|service` member client | verdict children in executor shard |
| `verify --run`, `adapter run`, `run drive` | current owner and active `agent|service`; scheduled drive adds scheduler match | run-bound verdict/progress |
| `sync [--project] --client-id <id>` | active `agent|service` client whose owner is an active member of every target project, preflighted before fetch/merge/push | authorized sync transitions for all eligible completed-local runs, even when their owners differ |
| `run request resume` | exact original executing client, still active and otherwise authorized for the root command | repair/resume existing children only |

The actual executing client always supplies canonical `clientId` and owns the filename shard. A command may never write into the run owner's shard on that owner's behalf. `ownerToken` independently fences the target run; only the authorized sync exception may append `run.synced`/sync-failure `run.halted` with another owner's current token, and the event records the sync executor as clientId. Resolution records derive resolverMemberId from the executing client's registry owner; no CLI flag may impersonate a client/member. Sync preflights every target project and run before side effects, derives one deterministic transition child per run, and either rejects the root before network/worktree mutation or processes all authorized runs; it cannot silently omit an unauthorized run.

## RALPLAN-DR

### Principles

1. **Fold before action:** every command/tick reconstructs canonical state from local plus visible shared events.
2. **Structure, not time:** ownership and ordering use explicit causal references, never timestamps or TTL.
3. **Fail closed, recover explicitly:** ambiguous ownership, invalid adapter output, or partial persistence cannot advance a run.
4. **One evaluator per decision:** procedure, revision, diagnostics, verdict, and next-step calculations each have one reusable implementation.
5. **Compatibility is tested behavior:** each new shared surface must be read/synced by the preceding release without false diagnostics.

### Decision drivers

1. Deterministic takeover and crash recovery under client-sharded Git merges.
2. Enforcement of LAW-5/6: untrusted adapter output cannot bypass gates or advance off-cursor.
3. Zero-dependency, Windows-first, tarball-self-contained delivery.

### Options considered

#### Option A — ownership epochs + canonical union fold (chosen)

Each `run.started` or `run.takeover` event creates an ownership token (its eventId). Every later cursor event carries that token. Takeover references the previous token, not merely the previous client. Local and shared records carry the same canonical identity, while the local record may additionally contain noncanonical detail. Folds deduplicate by eventId plus canonical digest and segment events by token.

- Pros: represents A->B->A; stale writes can be excluded deterministically; concurrent takeover forks are detectable; no clock dependency; compatible with existing sharding.
- Cons: additive shared schema and fold migration; legacy events without tokens need a bounded compatibility rule; conflict recovery needs an explicit human resolution event/command.

#### Option B — retain client partitions and add sequence counters

Add per-client monotonic sequence numbers, continuing to concatenate client partitions.

- Pros: smaller diff.
- Cons: still cannot distinguish two ownership periods for the same client; A->B->A and stale post-takeover writes remain ambiguous. Rejected.

#### Option C — serialize all run events into one shared shard/database

- Pros: simple total ordering.
- Cons: violates single-writer Git merge safety, serverless operation, and SQLite non-goal. Rejected.

### Pre-mortem

1. **Mixed-version clients silently reintroduce stale writes.** A 0.28 client emits tokenless events after takeover and a new fold accepts them. Mitigation: tokenless schema-v1 events are accepted only in an unambiguous first ownership epoch; after a takeover or repeated client ownership they are classified stale/ambiguous and cannot advance. Add real previous-release tarball tests.
2. **Adapter timeout leaves a child process or dirty verifier worktree.** Mitigation: direct spawn with a process-group handle, Windows `taskkill /T /F`, POSIX group termination, clean-worktree precondition for verification, post-run porcelain/diff check, and timeout/dirty-worktree E2E tests.
3. **Watch/drive accidentally creates a second evaluator or state truth.** Mitigation: watch calls exported `checkWorkspace` and shared revision functions; its cache is ignored and disposable. Drive calls the same `nextStep`, gate, verify, and adapter functions as interactive CLI. Tests delete caches/restart processes and prove identical output/fold.

## ADR

### Decision

Evolve the current event-sourced kernel rather than replacing it. Use eventId-based ownership epochs, a canonical local+shared union fold, and idempotent dual append. Build verify, watch, and drive as consumers of that hardened kernel.

### Drivers

- Serverless Git mergeability and mixed-version tolerance.
- Deterministic reconstruction after takeover/crash.
- Reuse of existing CLI/check/procedure boundaries.

### Alternatives considered

- Client partitions plus counters: rejected because repeated ownership remains ambiguous.
- Central shard/database/daemon: rejected because it violates LAW-1/2 and SPEC-10.
- Implement P1.5/P2/P3 first and repair later: rejected because verification and drive would inherit corrupt owner/cursor semantics.

### Why chosen

An event token is the smallest causal primitive that identifies an ownership period without a clock. Reusing one event envelope across local and shared stores makes duplicate repair deterministic. The design adds no server, database, package, or parallel evaluator.

### Consequences

- Shared run events gain additive ownership fields and a projection-aware canonical digest, and move to an explicit new event schema version.
- New folds may flag legacy post-takeover writes that old folds previously accepted.
- Sync orchestration must expose prepare/finalize phases so `run.synced` is included in the same workspace push.
- Release boundaries are fixed at 0.29/0.30/0.31/0.32 so each protocol surface has its own compatibility and stop gate.

### Follow-ups

- Keep formal tag/npm publication as a separate explicitly authorized action.
- Revisit an adapter package split only if external CLI compatibility must release independently.
- Do not introduce a daemon or SQLite canonical store as a follow-up.

## Tranche 1 — Kernel Hardening (`0.29.0`)

### Ownership and canonical fold

**Primary ownership:** `src/run-ledger.js`, `src/run.js`, `src/check.js`; tests in `test/run-ledger.test.js`, `test/run-cli.test.js`, and check tests.

1. Add a single event-envelope constructor with two explicit projections while keeping JSONL flat:
   - the shared projection is the type's allowlisted top-level canonical fields plus canonicalDigest and optional occurredAt;
   - the local projection is the same flat record plus optional `localDetail`, which is never mirrored.
   The constructor derives the canonical object in memory by removing canonicalDigest/occurredAt/localDetail, normalizes it, and stores `canonicalDigest = sha256(canonicalJson(canonicalFields))` in both projections. Event identity is `(eventId, canonicalDigest)`, not whole-record byte equality. Two records with the same eventId and digest merge; the local copy may have localDetail, and occurredAt may differ without affecting state. The same eventId with a different canonical digest is corruption. No digest includes timestamps or localDetail, and no writer serializes a nested canonical envelope.
2. Define `ownerToken` as the eventId of `run.started` or the current `run.takeover`; change takeover references to `previousOwnerToken`, `previousClientId`, and `previousOwnerHeadEventId`. The head reference captures the last visible event in the previous owner's shard and is the clock-free legacy cutover boundary. Determine ownership by causal token chain, never client partition order or `occurredAt`.
3. Replace `orderSharedEvents` with an explicit deterministic ownership state machine:
   - `ACTIVE(token, clientId)` begins at `run.started`;
   - exactly one valid takeover child of the active token advances to `ACTIVE(childToken, childClientId)`;
   - every ownership decision is represented as a candidate tuple `{decisionEventId, selectedOwnerToken}`. For a takeover, both values are that takeover event's ID/token. For a resolution, `decisionEventId` is the resolution event ID and `selectedOwnerToken` is the owner token selected by that event;
   - two or more takeover children produce `CONFLICT(conflictId, parentToken, sortedCandidateTuples)` where `conflictId` is a canonical hash of the complete sorted tuples; no progress event is applied while conflicted;
   - `run.ownership_resolved` is valid only in `CONFLICT`, must cite the exact conflictId, complete sorted candidate tuples, one `selectedDecisionEventId`, the corresponding `selectedOwnerToken`, resolver client/member, and nonempty reason. The selected token must equal the token in the cited candidate tuple; callers cannot supply an unrelated token;
   - the resolver follows one rule everywhere: the exact active parent-epoch client may resolve normally, including when it is a device; any other active member must execute through agent/service plus explicit `--force --reason`; a non-parent device cannot force. Resolution never deletes rejected branches;
   - resolution effects deduplicate by `selectedOwnerToken`: any number of valid resolution events that select the same owner token converge to one effective selection, even though all decision events remain auditable;
   - one distinct selected owner token returns to `ACTIVE(selectedOwnerToken, selectedClientId)`. Concurrent valid resolutions selecting different owner tokens form a recursive `CONFLICT` whose candidates are the resolution tuples `{decisionEventId, selectedOwnerToken}`. The next resolution selects one current candidate **by decisionEventId** and therefore one underlying owner token; no time/lexical winner is introduced;
   - stale/superseded-token events remain auditable but are excluded from cursor, attempts, artifacts, status, and verdict eligibility.
4. Expose recovery as `rdl run ownership resolve --run <id> --conflict <digest> --select <candidate-event-id> --client-id <id> --reason <text> [--force]`. `--select` always names the `decisionEventId` of one tuple in the currently folded conflict, whether that decision is a takeover or a prior resolution. The command derives `selectedOwnerToken` from that tuple, recomputes and records the complete candidate tuples, rejects unknown/stale/incomplete selections, and appends `run.ownership_resolved`; it cannot be used while state is ACTIVE. Authorization is exactly the matrix rule: the active client that owned the conflicted parent epoch may resolve unforced even when it is a device; any different member must use an active agent/service client plus `--force`, and a non-parent device can never force. Replaying the command for the same conflict and selected owner token is effect-idempotent; a different selected owner token creates the recursive conflict described above.
5. Apply the normative schema-v1 compatibility mapping above: reconstruct only a unique non-repeating legacy client chain; synthesize internal digest/request/owner metadata without rewriting; use the first v2 previousOwnerHeadEventId as the immutable legacy cutoff; diagnose conflicting IDs, malformed records, ambiguous/forked/repeated-client chains, missing cutoff heads, and after-cutoff tokenless writes with the specified codes. Never guess a legacy owner from the current client or timestamps.
6. Make `runContext` fold the union of local and currently visible shared canonical projections plus localDetail joined by eventId. Authorize every mutation against the canonical `ACTIVE` owner token and attach that token to the emitted event. Offline stale events may be appended, but a new canonical fold must never apply them.

**Acceptance criteria**

- A starts, B takes over, then A takes over again; each epoch's events apply only inside its epoch and the final cursor is identical for every event-file enumeration order.
- An old A writes after B takeover; the event is reported stale and cannot change cursor, attempts, status, artifacts, or verdict eligibility.
- Concurrent B and C takeovers from A yield a deterministic `ownership-conflict`; no step can advance until an explicit reasoned resolution is appended.
- The exact parent client—including a device—can select a current candidate unforced; a different member succeeds only via agent/service plus force, while a non-parent device, inactive client, or impersonated member fails without an event. The token is derived from its tuple, duplicate same-token selections converge, stale/incomplete requests fail, and different-token resolutions remain fail-closed until recursively resolved.
- Timestamps can be inverted arbitrarily without changing owner/cursor.
- Tokenless 0.28.1 events before the captured shard head retain their historical fold; tokenless old-owner events merged after that head are stale.
- A tarball packed from commit `8d1c6df` can check and sync the new additive fields without false diagnostics.

### Cursor, gate, and procedure invariants

**Primary ownership:** `src/run-ledger.js`, `src/run.js`, `src/procedure.js`, `src/implementation-contract.js`, `bin/rdl.js`.

6. Centralize transition validation in the ledger/procedure evaluator. A `run.step`, `run.gate`, or `run.forced` applies only to the current cursor, only in `running` state, and only to its matching step kind. Invalid historical events are diagnosed and cannot advance.
7. Make `reportStep` require `stepId === fold.cursor`; reject gate, verify, and human-only steps unless their dedicated command/explicit human acknowledgement path applies. `--force --reason` remains the sole bypass.
8. Preserve gate exit code 2 through `rdl run gate`; exit 1 is a gate verdict, exit 2 is invocation/environment failure. Do not translate schema/adapter/process failures to abstain.
9. Strengthen procedure overrides: a parent `onFail` cannot disappear; `goto` and carried data cannot weaken/change; `maxAttempts` may only decrease; parent lenses cannot be removed; refuted/abstain thresholds cannot be relaxed; `human: true` cannot be removed. A parent's step classification (`human`, gate, adapter, CLI) cannot change, `retrySafety` cannot be removed or switch mode, an operation-id placeholder cannot be removed/duplicated, and a gate-recheck target/contract cannot change. These monotonic rules are applied by the single inheritance evaluator, not separately by drive.
10. Validate every linked implementation artifact type (REQ/SCR/MOD/API/TST) in task readiness, while retaining REQ+TST coverage as the minimum functional readiness condition.

**Acceptance criteria**

- Future, past, gate, verify, and human steps all fail through `run step` and add no effective completion.
- Directly injected invalid events do not fool `foldRun`, proving enforcement is not CLI-only.
- Gate child exit 0/1/2 maps to CLI 0/1/2 and corresponding event semantics.
- Removing/changing `onFail.goto`, widening attempts/thresholds, removing a lens, or removing a human gate is rejected at load.
- A linked SCR/MOD/API granularity error blocks task implementation readiness.

### Idempotent dual append and sync finalization

**Primary ownership:** `src/event-store.js`, `src/run-ledger.js`, `src/state.js`, `src/settings.js`, new `src/harness-settings.js`.

11. Implement projection-aware idempotent append/read. Duplicate `(eventId, canonicalDigest)` records fold once even when only the local record has `localDetail`; a digest mismatch or a digest that does not recompute from the canonical projection is corruption.
12. Choose **shared-first canonical append as the linearization point** for every shareable run/verdict/driver mutation. Before either append, atomically create the Git-ignored root request journal, then persist a prepared child containing childRequestId, semantic child key, preallocated eventId/runId, and `canonicalUtf8Base64`: the complete UTF-8 bytes returned by canonicalJson for the normalized flat canonical projection, including all generated values such as leaseId and expiresAt. Persist `canonicalDigest=sha256(decoded canonical bytes)` and optional noncanonical occurredAt separately, fsync, then append by decoding and parsing those exact bytes; never reconstruct from command arguments. Replay decodes, verifies digest, reparses/re-normalizes to byte-identical canonicalJson, verifies root/child/event identity and type schema, and only then reuses the exact projection. Any mismatch is request-journal corruption/exit 2 and cannot append. Once shared is present with matching digest, set the child phase canonical-committed; then append/repair local and set complete. Root/child journal phases are recovery metadata, never fold input.
13. Fresh-process retry identity follows the normative root/child formulas above. Every mutating CLI accepts root `--request-id <REQ-[A-F0-9]{20}>`; if omitted interactively, the kernel generates and persists it before work and returns rootRequestId plus child identities in JSON/human output. A caller that lost output uses `rdl run requests [--pending]` and `rdl run request resume <rootRequestId> --client-id <id>`; the kernel never guesses by timestamps/arguments. Reusing a root with a different normalized-arguments digest is exit 2 with no new child/canonical event.
14. `run start` is covered by the same rule: preallocate `runId = RUN-<first20 uppercase hex(sha256('run-start\0'+rootRequestId))>` and derive its started eventId from the `event:run.started:<runId>` child before shared append. Retrying that root in a fresh process returns/repairs the same runId/eventId; it cannot create a second run.
15. After the shared append linearizes a progress/verdict outcome, a local projection/receipt failure does **not** turn the command into exit 2 or invite a second logical action: the command repairs synchronously when possible, otherwise returns the canonical 0/1 outcome with `{canonicalCommitted:true,projectionDegraded:true,rootRequestId,requestId:childRequestId,eventId}` and leaves the root journal pending for repair. A hard process crash has no exit code; retry/resume repairs it. Exit 2 before linearization writes no progress/verdict event. Exit 2 after an action has begun may append only an explicit fail-closed `run.halted` event (for example adapter-timeout) and must report `{canonicalCommitted:true,transition:'run.halted',rootRequestId,requestId:childRequestId}`; it never completes a step, advances a cursor, or records a verdict.
16. Canonical reads union/deduplicate first and join localDetail afterward. Reconciliation on run read/mutation and before sync repairs a missing local canonical projection from shared or retries a missing shared projection only from a prepared journal with the same eventId/digest. Never invent a new identity and never reconstruct missing localDetail.
17. Refactor sync into explicit phases: workspace fetch/merge preparation -> project save/fetch/merge/push -> append `run.synced`/`run.halted` -> workspace save/push finalization. A reported successful sync must include the transition in the pushed workspace ref. Remove the blanket catch; transition persistence failure makes sync fail visibly.
18. Introduce the schema-versioned `harness.json` base loader in this tranche (built-in -> Workspace -> project), independent from `board.json` and `procedures.json`. Use its validated sync retry configuration for non-fast-forward retry; preserve local events and halt affected runs on exhaustion. Later tranches consume the same complete schema defined below.

**Acceptance criteria**

- Fault injection at every boundary (shared append, shared commit, local append, project push, transition append, workspace push) either reconstructs one effective event on retry or returns exit 2 with no false success.
- Fresh-process retry of `run start`, multi-lens verify, multi-run sync, and multi-phase drive with the same root request returns the same deterministic children/run/event/validator/invocation identities. A mismatched root or child digest is rejected; no timestamp/argument heuristic is used.
- Tests distinguish pre-linearization exit 2 (no progress event), post-linearization degraded 0/1 (one committed outcome), and post-action exit 2 with only an explicit halt transition.
- A fresh clone/fetch after one successful `rdl sync` observes `run.synced` without requiring a second sync.
- One sync root covering completed-local runs owned by different clients writes each transition to the actual sync executor's shard with the target run's ownerToken; fresh-process resume after push repairs only missing deterministic transition children. Missing/inactive/wrong-type/nonmember executor fails preflight before any network or worktree side effect.
- Duplicate retries do not double gate attempts.
- Local and shared records with the same canonical projection but different presence of localDetail fold once; localDetail never appears in a shared shard.
- Shared JSONL remains flat canonical fields plus canonicalDigest/optional occurredAt; the packed 0.28.1 reader sees the legacy top-level fields, ignores additive fields, and never needs to understand a nested envelope.
- A driver acquire crash/replay reuses the exact journaled leaseId and expiresAt bytes even if wall time has passed; it never silently extends a lease. A later renewal is a distinct deterministic child with its own once-journaled expiresAt.
- `transitionRuns` failures are visible in JSON/human output and tests.

### Stop gate K

Do not start P1.5 until all ownership, off-cursor, override, readiness, dual-append fault-injection, same-sync propagation, mixed-version, and full release checks pass.

## Tranche 2 — P1.5 Verify and Adapter (`0.30.0`)

### Configuration and adapter process contract

**Primary ownership:** `src/harness-settings.js` (created in tranche 1), new `src/adapter.js`, `src/doctor.js`, `src/procedure.js`, `bin/rdl.js`; tests in new `test/adapter.test.js`.

1. Extend the tranche-1 `harness.json` inheritance chain with adapters and `adapter.timeoutSeconds`. Reject unknown/invalid adapter shapes; do not silently coerce commands. Adapter identity is exclusively the `adapters` map key; an enabled value is exactly `{command,argsTemplate,timeoutSeconds,enabled:true}` and must not persist a duplicate `name`. Configuration selects immutable instruction/lens IDs; it cannot embed or override prompt/instruction prose.
2. Add an immutable in-code/distribution instruction registry with revisioned IDs `author-v1`, `verify-satisfaction-v1`, `verify-omission-v1`, and `verify-boundary-v1`. The lens registry maps exactly `satisfaction-v1 -> verify-satisfaction-v1`, `omission-v1 -> verify-omission-v1`, and `boundary-v1 -> verify-boundary-v1`; no adapter/config override can change this mapping. Author procedure steps explicitly reference `author-v1`. Each instruction entry owns its evidence stance, allowed mode, required contract headings, registry revision, and `instructionDigest`. Procedures reference IDs, and run pinning records registry revision+digest. Changing instruction text or lens mapping requires a new ID/revision; a running invocation never reads mutable project/Workspace instruction prose.
3. Implement one shared one-shot kernel `runAdapterOnce(invocation)` used by standalone verify, run-bound interactive commands, and drive. It performs exactly one prepared adapter process invocation and never loops, selects a next step, mutates a run cursor, or aggregates verdicts.
4. Expose the exact public surface `rdl adapter run <name> --project <key> --run <id> --step <id> --mode <author|verify> --client-id <id>`; no public instance/path/cwd/context/result override exists. Project, step, procedure, cwd, instruction/context paths, generated instanceId, and result path are derived from the pinned run invocation. CLI exit semantics are: 0 = child exited 0 and strict result schema is valid; 1 = child completed with a declared step failure/nonzero exit; 2 = arguments, authorization, configuration, path safety, spawn, timeout, or output-schema error. The command performs one invocation only and never appends; the higher-level run/verify/drive caller decides ledger transitions. Standalone `rdl verify` creates the same internal invocation object without pretending it belongs to a run.
5. Use two explicit ignored invocation roots:
   - run-bound: `<project>/.rundol/runs/<runId>/steps/<stepId>/invocations/<instanceId>/`;
   - standalone verify: `<project>/.rundol/verify/<invocationId>/`.
   IDs are kernel-generated, validated, and created with exclusive directory/file operations. Each root contains immutable `instruction.json`, `context.json`, the adapter-created `result.json`, and a kernel-created terminal `receipt.json`.
6. Materialization lifecycle:
   - resolve the pinned instruction registry entry and write its ID/revision/digest plus that bounded immutable registry instruction—and no other prompt/payload—to local `instruction.json` with exclusive create;
   - write `context.json` containing only target relative path, pin, one lens/instruction ID, contract heading names, and allowed context relative paths—no copied document body, prior verdict, author history, transcript, credential, raw adapter/model output, or mutable project instruction;
   - hash both files, make them read-only where supported, and record hashes in the invocation object before spawn;
   - after a valid result, write-once `receipt.json` records manifest/result hashes, adapter identity, exit category, and no raw output; successful manifests and allowlisted result remain as Git-ignored local audit evidence;
   - on timeout/schema/path failure, discard any untrusted result content after bounded hashing and retain only a privacy-safe failure receipt. Capped/redacted stdout/stderr are process-memory diagnostics and are not persisted or mirrored.
7. Spawn directly with `shell:false`, `windowsHide:true`, and project-worktree cwd. Resolve the configured executable once to an absolute regular file. Reject shell wrappers unless the configured command itself is the explicit executable. Preserve argv elements exactly.
8. Apply filesystem checks in this mandatory order to reduce symlink/reparse races:
   - **pre-materialization:** lexical `path.resolve` containment under the selected project/invocation root; `lstat` each existing path component from the trusted real root downward and reject symlink/junction/reparse/non-directory components; then `realpath` existing inputs, recheck containment, and require target/context files to be regular files;
   - create the invocation directory and manifests exclusively, then `lstat`+`realpath` them again and verify recorded hashes immediately before spawn;
   - **post-process, before result read:** `lstat(result.json)` first (reject link/reparse/non-regular), then `realpath` and containment, open by descriptor, `fstat` regular/size bounds, read bounded bytes, and `fstat` again to reject replacement/size/identity change during read;
   - repeat instruction/context lstat-realpath-hash verification and project Git status/diff checks before accepting the result. Context entries are canonical artifact paths only.
9. Enforce exact output-key allowlists and size/count bounds. Author mode accepts only `{claims: string[], artifactIds: string[]}`. Verify mode accepts only `{verdict: 'pass'|'refuted'|'abstain', findings: Finding[]}` where a Finding contains only bounded `summary` and optional `{file,heading,blockId}` location. Reject unknown top-level/nested keys, duplicate artifact IDs, absolute/escaping locations, oversized output, and any transcript/raw-response field.
10. On timeout, terminate the entire process tree (Windows `taskkill /PID <pid> /T /F`; POSIX process group TERM then KILL), append `run.halted(adapter-timeout)` when the higher-level caller is run-bound, and return exit 2.
11. Extend `rdl doctor` with per-adapter executable and bounded `--version` probes, sanitizing paths/output and never executing an adapter prompt.

**Acceptance criteria**

- Paths containing spaces and non-ASCII characters reach a fixture adapter as exact argv on Windows.
- Shell metacharacters remain literal and never execute a second command.
- One-shot CLI, standalone verify, interactive run, and drive fixtures all traverse the same `runAdapterOnce` kernel and identical result validation.
- Run-bound and standalone roots are distinct, exclusive, Git-ignored, and restart-auditable; registry instruction digest and materialized manifest hashes remain unchanged across invocation.
- Symlink/junction/path traversal, pre-existing result files, extra JSON keys, absolute finding locations, and transcript fields are rejected before any verdict/step event is recorded.
- Timeout kills parent and spawned child; no orphan remains and run halt is folded.
- Invalid configuration and missing executable return exit 2; doctor reports actionable diagnostics.

### Verdict event store and deterministic fold

**Primary ownership:** new `src/verify.js`, `src/event-store.js`, `src/run-ledger.js`, `src/check.js`, `bin/rdl.js`; tests in new `test/verify.test.js` and run integration tests.

10. Add `verdict.recorded` schema and client-sharded `events/verdict/` storage with filename/event identity checks. Store only `targetId`, `reviewedRevision`, `lens`, `verdict`, bounded findings locations/summaries, optional runId, adapter, validator instance ID, and canonical event envelope/digest. Adapter manifests, localDetail, stdout/stderr, and target content are forbidden from the shared projection.
11. Pin verification to a clean target file at the project HEAD commit. Standalone verify rejects a dirty target; run-bound verify consumes the pinned revision created by the procedure's pin step.
12. Consume verifier output only through the exact allowlist in the one-shot adapter kernel. Invalid enum/shape/key/bounds, missing result, nonzero adapter exit, or parse failure is a step/system failure—not abstain and not a verdict.
13. Implement `foldVerdicts(events, policy)` as a pure deterministic evaluator. Only matching target/current revision, required lens, allowed adapter, and unique validator instance count. Default policy is exactly one validator per lens with `refuted=0`, `abstain=0`.
14. Majority is opt-in procedure data with an explicit per-lens shape such as `{validators: 3, quorum: 2, maxRefuted: 0, maxAbstain: 0, requireAdapterDiversity: false}`. Validate `1 <= quorum <= validators`, reject duplicate instance IDs, and never infer majority from the number of returned events. A lens passes only when at least quorum distinct valid instances say pass **and** refuted/abstain do not exceed their explicit maxima. Missing instances, ties, insufficient quorum, or excess abstain halt for human; refuted above the maximum follows the author-rework path. Adapter diversity is enforced only when explicitly true.
15. Run each lens/validator in a fresh process context with no earlier verdicts, author history, prompt transcript, or unrelated context. Input materialization is only the privacy-safe manifest: target relative path, pin, one lens definition, and type-contract heading list; the adapter reads the target from its allowed path.
16. Enforce verifier immutability: require a clean worktree before invocation and compare Git status/diff afterward; any tracked or untracked change rejects the result, records no verdict, restores nothing automatically, and returns exit 2 with the changed relative paths.
17. Integrate with runs: refuted becomes a gate failure carrying findings-only and follows `onFail.goto`; abstain/insufficient quorum appends a human-resumable verification halt; invalid output consumes an attempt through gate failure; timeout uses adapter-timeout. Add the fully implemented verified procedure only now.

**Acceptance criteria**

- A passing verdict becomes invalid automatically when project HEAD changes.
- Three lenses are three isolated fixture processes and their inputs contain no cross-lens result/transcript.
- Majority fixtures prove quorum, duplicate-instance rejection, tie/insufficient handling, maximum refuted/abstain enforcement, and optional adapter diversity without LLM aggregation.
- Refuted returns findings only to the author loop; abstain halts for human; invalid JSON is neither.
- A verifier-created/modified/deleted file is detected and no verdict event is written.
- Shared verdict shards are tolerated by the preceding release's check/sync tests.
- `rdl verify` returns 0 pass, 1 refuted/abstain, 2 argument/environment/adapter/schema error.

### Stop gate V

Do not start watch until adapter timeout/tree-kill, dirty-worktree rejection, pin invalidation, lens isolation, verdict fold, run regression, mixed-version, and full release checks pass.

## Tranche 3 — P2 Observational Watch (`0.31.0`)

**Primary ownership:** new `src/watch.js`, `src/board-data.js`, `src/check.js`, `src/runtime.js`, `bin/rdl.js`; tests in new `test/watch.test.js` plus Board revision regression tests.

1. Extract one canonical document/project revision calculator from `src/board-data.js`; Board and watch consume exactly that function. Keep commit pin revisions for verdicts distinct from content revisions used for observation/dedup.
2. Add a long-lived process-lock primitive in `src/runtime.js` keyed by workspace/project/watch. Store PID+token, verify same-machine liveness rather than expiring ownership by time, and release in `finally`/signal handlers.
3. Define one stable scan boundary before emitting anything. Build `inputSnapshot = {head,gitStatusDigest,documents:[id,revision],taskShardDigests,projectConfigDigests,workspaceConfigDigests,registeredEventShardHeads}` with every list sorted; `scanRevision=sha256(canonicalJson(inputSnapshot))`. Capture it before and after `checkWorkspace`; if different, discard the buffered scan and retry up to three immediate times. No NDJSON/cache mutation occurs for an unstable attempt. A completed revision means before==after and all diagnostics were computed from that inventory. Board and watch use the same per-document revision helper; verdict commit pins remain separate.
4. Emit only NDJSON schemaVersion 1 records with exactly the common required keys `{schemaVersion,type,watchId,sequence,project}` plus the selected type payload; unknown keys are forbidden:
   - `watch.scan.started`: `{scanId,scanRevision,head,gitStatusDigest}`;
   - `watch.diagnostic`: `{scanId,scanRevision,targetId,targetRevision,code,severity,category,file?,line?,message,dedupKey}` where `dedupKey=sha256(targetId+'\0'+code+'\0'+targetRevision)` and targetRevision is the canonical document/task/config revision responsible for the diagnostic;
   - `watch.scan.completed`: `{scanId,scanRevision,head,gitStatusDigest,activeDiagnosticKeys[],summary:{errors,warnings,total}}` with the full sorted active key set, including diagnostics suppressed by dedup;
   - `watch.remote.relation`: `{scope:'project'|'workspace',ref,localTip,remoteTip,ahead,behind,relation,relationKey}`;
   - `watch.error`: `{phase,code,message,retryable}` with sanitized bounded message.
   `watchId` is random per process, `sequence` is a process-local increasing integer, and `scanId=scanRevision` (the same full 64-character lowercase digest, never a truncation). Scan started/diagnostic/completed are buffered and written in that order only after stability is proven. Diagnostics never change the long-running process exit status; setup/lock/config errors return 2, and `--once` returns 2 if no stable scan completes.
5. Cache exactly one schema-v1 object at `<project>/.rundol/state/watch/cache.json`: `{schemaVersion,project,lastCompletedScanRevision,activeDiagnostics:{dedupKey:{targetId,targetRevision,code}},remoteRelationKeys:{project:string|null,workspace:string|null},sequenceBase}`. After `watch.scan.completed` is successfully flushed, atomically replace the cache with the full active set; after each successfully flushed remote record, atomically replace only the corresponding scoped relation key while preserving the last completed scan set. A crash before cache replacement may cause at-least-once duplicate diagnostic/relation output after restart, never omission. Cache is ignored, disposable, and never a truth source.
6. Create/change/delete semantics are explicit: create emits each new diagnostic once and completion lists it; content change creates a new targetRevision/key and may re-emit the same code, while the old key disappears from the completed active set; delete emits no synthetic resolved event, and completion omits every deleted-target key so consumers derive resolution by diffing completed sets. An unchanged scan still emits started+completed boundaries but emits no duplicate diagnostic records. Deleting/corrupting cache rebuilds and may re-emit the current active set once.
7. Combine `fs.watch` as a wakeup hint with configured corrective scans. Debounce/coalesce bursts; inject timers/watchers in tests. `--once` is the deterministic operator/test surface.
8. Define `--remote` narrowly as remote-tip relation observation. With no `--remote`, make zero network calls. With `--remote`, fetch only the configured project and Workspace branch tips into remote-tracking refs at the configured interval and emit one scoped relation per available tip. Compute counts with merge-base/rev-list. `relation` is exact: equal=(0,0), ahead=(>0,0), behind=(0,>0), diverged=(>0,>0); a missing ref emits scoped retryable `watch.error` and no relation for that scope. `relationKey=sha256(scope+'\0'+ref+'\0'+localTip+'\0'+remoteTip+'\0'+ahead+'\0'+behind+'\0'+relation)` suppresses unchanged records through the per-scope cache. Never inspect remote document bodies, merge/reset/checkout/commit/push, write worktrees, or append events.
9. Preserve existing `rdl sync watch`; document/route `rdl watch` as diagnostics observation so the two commands cannot be confused.

**Acceptance criteria**

- Project/workspace Git tree, status, HEAD, and shared event counts are byte-identical before and after local watch scans; only ignored cache/runtime lock changes.
- Two watch processes for the same project result in one active process and one deterministic refusal; different projects can watch concurrently.
- Board and watch produce the same revision for every fixture document.
- Repeated unchanged scans emit boundary records but no duplicate diagnostics; create/change/delete follow the active-set contract, and deleting cache causes a safe at-least-once re-emission/rebuild.
- Network-spy fixture proves zero Git fetch/push without `--remote`; remote mode reports exact equal/ahead/behind/diverged tips and counts, but never merges, resets, checks out, commits, pushes, diagnoses remote contents, or writes a ledger.
- Diagnostics never change the watch process exit code; Ctrl-C exits cleanly.

### Stop gate W

Do not start drive until read-only invariants, lock behavior, Board revision parity, cache rebuild, network isolation, and full release checks pass.

## Tranche 4 — P3 Drive (`0.32.0`)

**Primary ownership:** `src/run.js`, `src/run-ledger.js`, `src/event-store.js`, `src/adapter.js`, `src/runtime.js`, `src/harness-settings.js`, new `src/driver-lease.js`, `src/settings.js`, `src/check.js`, `bin/rdl.js`; tests in new `test/drive.test.js` plus event-store/check/concurrency/failure suites. `src/collaboration-store.js` remains behavior/byte compatible and is not generalized for driver leases.

1. Extract a reusable stateless `tickRun`: canonical fold -> existing `nextStep` -> exactly one existing CLI/gate/adapter operation -> append result -> return a typed stop/continue result. It must retain no cursor/attempt state between calls.
2. `rdl run drive` requires an active client, canonical ownership token, and pinned `idempotent:true` procedure. Before creating a request journal or acquiring a process lock, preflight the entire pinned procedure. `idempotent:false` or any invalid step is exit 2 with zero journal/lock/process/event/worktree side effects. Step classification is exhaustive: `human:true` is a stop boundary; a step with `gate` is a nonmutating gate; every other drive-executable CLI or adapter step must declare exactly one `retrySafety` field, even if its author claims it is read-only. A step cannot be in more than one class.
   - `{mode:'operation-id'}`: the operation receives the deterministic operationId as its idempotency key;
   - `{mode:'gate-recheck', gateStep:'<id>'}`: `gateStep` names an existing deterministic, nonmutating gate whose exit 0 proves the action's intended postcondition already holds, exit 1 proves action is still needed, and exit 2 is an environment error. The referenced gate cannot be human, adapter, or forceable during pre-action recheck.
   `retrySafety` is canonical pinned procedure metadata, not a drive default. For `operation-id`, adapter mode injects operationId as a dedicated field in immutable `context.json`; CLI mode requires exactly one `{operationId}` argv placeholder and substitutes it as one shell-free argv element. Environment-variable/header injection is forbidden. For `gate-recheck`, the mutating action receives no implied idempotency promise; safety depends on the declared pre-action gate.
   **Every gate in a drive-eligible procedure**, both ordinary cursor gates and referenced pre-action recheck gates, uses one closed internal read-only contract: `gate.command` must equal `check`; after placeholder substitution argv may contain only one canonical artifact ID plus `--strict`, `--structure`, and `--project <key>` (kernel alone adds root/json). Duplicate/conflicting flags, output paths, arbitrary positional paths, `--fix`, `save`, `sync`, and every other rdl subcommand/flag are rejected during the preflight above. Rejection performs zero lock/journal/spawn/event/worktree changes. A recheck additionally must reference one of these validated gates, invokes its evaluator directly without appending a gate event or consuming attempts, and pins the normalized target/postcondition contract in the procedure content hash.
3. The drive loop calls `tickRun` until one of these explicit boundaries: completed, human/sync gate, halted, ownership lost, lease lost, or error. It never sleeps/polls for work. A gate failure appends a resumable `run.halted(gate-failed)` and returns exit 1; it does not spin through retries unattended.
4. Choose a **separate client-sharded `events/driver/` lease kind**; do not generalize or alter the existing document-lease byte/schema contract. Revise the SPEC-1 registered-kind contract from `lease|run|verdict` to `lease|run|verdict|driver` in the same tranche, implement the registered kind in `src/event-store.js`, and add `src/check.js` filename/envelope validation while retaining silent tolerance for all unregistered future kinds. Use the exact filename, envelope, predecessor-chain fold, and lock scope defined in the normative driver schema. The `8d1c6df` and immediately preceding tarballs must ignore the new directory. Lease is soft coordination only; it may reduce duplicate work but cannot authorize progress.
5. Define `logicalAttempt(stepId)` exactly as `1 + count(valid applied retry-consuming failure events whose deterministic retry interval contains stepId)` over the pinned run history. A retry-consuming failure is a canonical failure event that passed event identity, ownership-token, cursor, step-kind, and duplicate validation and whose procedure `onFail.goto` transition was actually applied. Its retry interval is the inclusive procedure range from `onFail.goto` through the failed step, so an author->gate repair loop increments the logical attempt for both the repeated author step and the repeated gate. Physical process spawns, duplicate/equivalent events, stale/unauthorized failures, lease acquire/renew failure, timeout before an applied retry event, ownership transfer, resume, and takeover do not increment logicalAttempt. Only appending and applying a valid retry-consuming failure changes it; crashes and takeovers therefore reuse the same value. Resume/takeover never reset its historical count.
6. Derive `operationId = sha256(concatBytes(utf8('rundol.operation-id.v1\0'),utf8(canonicalJson([runId,procedureContentHash,stepId,logicalAttempt]))))` after that fold. The domain prefix and canonical JSON tuple make boundaries collision-free; raw string concatenation is forbidden. It is deliberately independent of ownerToken, clientId, eventId, leaseId, and time so two partitioned executors addressing the same logical attempt converge. `ownerToken` remains a separate authorization/fencing field on the attempt/result event; stale or unauthorized owner-token events are excluded before operation outcomes are compared.
7. Define `outcomeDigest = sha256(canonicalJson({operationId, stepId, logicalAttempt, outcomeKind, exitCode, sortedArtifactIds, sortedDiagnosticCodes, boundedResultDecision}))`. Exclude eventId, ownerToken, clientId, occurredAt, lease metadata, localDetail, stdout/stderr, and adapter process identity. For an authorized operationId:
   - any number of outcomes with the same outcomeDigest are equivalent and fold once;
   - two different outcomeDigests produce deterministic `operation-conflict`, apply neither outcome, and halt for explicit human resolution/re-execution;
   - stale/unauthorized owner-token outcomes never create an operation conflict with authorized outcomes;
   - an ownership change does not change operationId for the same logical attempt, so a new owner can safely re-evaluate/retry and converge with a prior identical result.
   Exact `outcomeKind` values are `step-completed`, `gate-passed`, `gate-failed`, `verification-passed`, `verification-refuted`, `verification-abstained`, `forced`, and `step-failed`. `boundedResultDecision` is respectively: `{artifactIds}`, `{diagnostics:[]}`, `{diagnostics:[]}`, `{verdictSetDigest}`, `{verdictSetDigest,findingsDigest}`, `{verdictSetDigest}`, `{reasonDigest}`, or `{failureCode}`. Execution path is not a decision field: a successful gate-recheck and a successful physical action for the same postcondition both use `step-completed` with the same artifact IDs, so they can converge. Include operationId+outcomeDigest in result events. External/idempotent procedure steps must consume operationId through the declared channel or be gate-recheckable; declaring `idempotent:true` without valid metadata/channel is rejected before run start/drive.
8. Resolve operation conflicts with the same explicit decision protocol as ownership, never by event order. Fold derives `OPERATION_CONFLICT(conflictId, operationId, sorted [{decisionEventId,selectedOutcomeDigest}])`. `rdl run operation resolve --run <id> --operation <operationId> --conflict <digest> --select <candidate-event-id> --client-id <id> --reason <text> [--force]` requires the ACTIVE owner; another active project-member agent/service requires `--force`. The command derives the selected digest from the exact current candidate tuple and appends `run.operation_resolved`. Same-digest selections deduplicate; different resolution selections recursively conflict. Until one distinct selected digest remains, neither outcome applies. Resolution applies the selected already-recorded outcome; it does not rerun the action.
9. Fix drive/tick order as: validate the complete pinned procedure and closed gate allowlist -> validate client/settings with no writes -> acquire same-machine run lock -> canonical union fold -> require `ACTIVE` ownership and authorize ownerToken -> derive cursor/retry interval/logicalAttempt/operationId -> if `retrySafety.mode==='gate-recheck'`, execute the declared read-only recheck gate -> on exit 0 append the canonical equivalent completion for this operationId and skip the mutating action, on exit 1 continue, on exit 2 halt/error without action -> acquire/confirm the soft driver lease -> invoke exactly one CLI/adapter action -> validate and append its outcome. Recheck results do not themselves consume a logical attempt.
10. Lock scopes are distinct: process exclusion is `<runtimeWorkspace>/locks/drive-<projectId>-<runId>.lock` held for the entire drive invocation with PID+random token+liveness validation; event append serialization is `<runtimeWorkspace>/locks/append-driver-<projectId>-<clientId>-<runId>.lock` held only across shard selection+append. Neither lock is shared across machines or used as fold evidence. Driver lease fold may expose zero, one, or many unexpired leases under partition; drive proceeds only after local owner authorization and its own lease attempt, but safety still rests on retrySafety/operationId.
11. Renew at configured `lease.renewFactor=0.5` only while an active drive/adapter step is running and synchronize the workspace with bounded configured retries. Renewal/sync failure terminates the child tree, appends `run.halted(lease-lost)`, and returns exit 1/2 according to whether it is a controlled halt or environment error.
12. Apply the existing optional scheduler-client assignment only when `rdl run drive --scheduled` is present. Scheduled mode runs only on the assigned active `agent|service`; manual mode still requires explicit client and ownership checks but ignores the assignment. Do not implement a scheduler daemon.
13. Stop before a `human:true`/sync gate with exit 0 and structured `{status:'waiting_human', step}`; do not call sync or push project content automatically.

**Acceptance criteria**

- Killing drive after external action but before result append and restarting re-evaluates safely; no non-idempotent procedure can enter this path.
- Two same-machine processes yield one executor. Two partitioned machines may both physically execute despite soft leases; they must derive the same operationId. After merge, identical canonical outcomes fold once, while different outcomes halt as `operation-conflict`. The test must not claim that a lease prevents duplicate physical execution.
- A fixture external action keyed by operationId proves duplicate attempts are idempotent; a deliberately conflicting fixture proves fail-closed operation conflict.
- The same logical attempt before/after a valid ownership transfer has the same operationId; stale old-owner output is fenced, and an identical authorized new-owner outcome converges without conflict.
- Crash before result append, lease renewal, timeout without an applied retry event, resume, and takeover all reuse the same logicalAttempt/operationId. One valid applied author->gate failure increments both repeated author and gate logical attempts exactly once; duplicate/stale failure events do not.
- A `gate-recheck` fixture with an already-satisfied postcondition skips the mutating action and records an equivalent completion; exit 1 executes once, and recheck exit 2 performs no action and returns the environmental error.
- SPEC-1's registered-kind tests accept `driver`, validate its shard/envelope, retain byte-identical lease behavior, and prove baseline/preceding tarballs silently ignore `events/driver/`.
- Drive stops at sync gate with zero project/workspace push calls.
- Lease renewal failure kills the adapter tree and folds `lease-lost`; no further step runs.
- Adapter error, gate exit 1, gate exit 2, ownership change, and attempt limit each terminate at the documented exit/status without infinite retry.
- Interactive execution and drive over the same fixture produce the same effective event sequence/final fold, apart from lease/driver metadata.
- Preceding-release tarball tolerates the new driver event kind and can check/sync without false errors.

### Stop gate D / final completion

Completion requires drive adversarial tests, mixed-version tests, all targeted suites, full `npm test`, `npm run version:check`, `npm run release:check`, `git diff --check`, and `rdl git boundary --json` with zero violations. Documentation/CHANGELOG/help is updated only after each command exists and its tests pass. No tags or npm publication are performed.

## Expanded Test Plan

### Unit

- Ownership state machine, A->B->A, recursive concurrent takeover/resolution conflicts, exact parent-device/unforced versus non-parent agent-service/forced resolver authorization, legacy shard-head mapping, stale classification, timestamp permutation, and canonicalDigest/localDetail identity.
- Schema-v1 internal normalization: absent versus explicit `schemaVersion:1` mixed representations produce the same normalized bytes/digest and deduplicate; missing digest/request/owner synthesis, event-ID digest conflict, partial-upgrade/malformed fields, broken/forked/repeated-client ownership chains, cutoff-head absence, after-cutoff stale diagnostics, and unknown-type tolerance.
- Transition matrix over every run state x cursor step kind x event type.
- Procedure override monotonicity for gates, onFail, lenses, thresholds, attempts, human flags, immutable step class, retrySafety mode/placeholder, and gate-recheck target/contract.
- Verdict exact-key schema, privacy bounds, revision filtering, lens thresholds, explicit majority/quorum, adapter diversity, and validator-instance dedup.
- Canonical exact-key normalization and cross-platform golden vectors for every hash-valued SHA-256 domain/formula, asserting exactly 64 lowercase hex; separately lock prefixed entity-ID derivations to their explicit legacy-compatible prefix/20-uppercase-hex grammar. Reject truncated/uppercase hash values, partial operation groups, unknown fields, invalid sorting, malformed IDs, and same-eventId/different-digest records.
- Root/child request formulas, deterministic event/run/validator/invocation IDs, semantic child ordering, root digest mismatch, and resume behavior for completed/prepared/live/dead/invalid children.
- Harness settings full-schema parsing, duplicate-key rejection, singleton deep merge, adapter whole-entry replacement/tombstones, array replacement, revision/schema rejection, nullable-field rules, every numeric/count bound, and argv placeholder substitution.
- Exact lens-to-instruction mapping, forbidden persisted adapter `name`, safeResolved snapshot allowlist, runtime-only exclusion, adapter digest drift, settings-drift halt/no-spawn behavior, and no resume repin.
- Canonical Board/watch revisions and diagnostic dedup keys.
- Drive stop-state table, exhaustive step classification, missing retrySafety rejection for every executable non-gate/non-human step, closed `check` argv allowlist applied to ordinary and recheck gates, explicit `save`/`sync`/`check --fix` rejection with byte-identical journal/lock/event/worktree snapshots, exact gate-recheck contract/order, collision probes for domain-separated canonical operationId tuples, retry-interval logicalAttempt counting/exclusions, owner-token preauthorization, outcomeDigest equivalence/conflict rules, registered driver-kind validation, driver-lease fold, and retry-backoff schedule with fake clock.

### Integration

- Shared-first dual-append fault injection at prepared-fsync/shared-append/shared-commit/local-append/receipt boundaries; byte-for-byte canonical journal replay, tampered bytes/digest/schema/identity rejection, lease acquire replay preserving exact leaseId/expiresAt, renewal as a distinct child, fresh-process root resume, deterministic run/event identity, and exact pre/post-linearization exit behavior.
- Project sync followed by same-operation workspace transition push, verified from a fresh clone; multi-run/different-owner sync uses one authorized executor shard and fresh-process root resume repairs only missing transition children without a second push.
- Fixture adapters for pass/refuted/abstain/invalid or extra-key JSON/dirty worktree/path traversal/symlink or junction/timeout/child process.
- Complete client matrix for all mutating run/resolution/sync/verify/adapter/drive commands: missing/unknown/inactive/nonmember/device/wrong-owner/wrong-original-client/scheduler mismatch versus valid owner, resolver, manual, scheduled, and sync-executor modes; prove exit 2 and zero unauthorized journal/spawn/lease/event/worktree side effects, actual-executor shard ownership, and no client/member impersonation.
- Watch scan against real `checkWorkspace`, unstable-boundary discard/retry, exact NDJSON keys/types/order/sequences, create/change/delete active sets, per-scope cache crash/rebuild, concurrent locks, network spies, and exact project/Workspace equal/ahead/behind/diverged remote-tip relations.
- Driver runtime lock + driver lease + ownership takeover during adapter execution.
- Task readiness with linked SCR/MOD/API violations.

### End-to-end

- Start -> author adapter -> mechanical gate fail -> repair -> pin -> three isolated verdict lenses -> refuted author loop -> pass -> local complete -> sync -> remote-visible synced.
- Crash at each tick boundary, restart in a fresh Node process, and compare final fold/event identities.
- Two-clone takeover/merge scenarios including stale old owner, legacy 0.28.1 tokenless boundaries, concurrent takeovers, conflicting resolutions, and explicit recovery.
- Watch across document create/change/delete without canonical writes.
- Drive to human sync gate, manual sync, resume/complete.
- The baseline tarball packed from commit `8d1c6df`, then each immediately preceding tranche tarball, reads/checks/syncs every new shared kind/field without false diagnostics.

### Observability and privacy

- Structured JSON/NDJSON includes runId, stepId, eventId, owner token, targetId, lens, adapter, and diagnostic codes where applicable.
- Human output explains stale ownership, conflict, invalid adapter output, timeout, dirty verifier, and lease loss with recovery action.
- Privacy tests distinguish the one allowed local payload from every forbidden sink: local `instruction.json` may contain only the bounded immutable registry instruction whose digest was pinned; local context/result/receipt may not contain document bodies, prior verdicts, transcripts, credentials, or raw adapter/model output; shared JSONL, debug logs, and CLI JSON/human output may not contain any instruction/prompt payload, document body, transcript, credential, or raw output.
- Every controlled halt has a deterministic reason and every environment/schema failure returns exit 2.

## Execution Sequencing and File Ownership

Use sequential tranche ownership; do not implement later-tranche files while an earlier stop gate is red. Within a tranche, parallel work is safe only across non-overlapping owners:

- **Kernel ledger lane:** `src/event-store.js`, `src/run-ledger.js`, ownership/fault tests.
- **Kernel command/governance lane:** `src/run.js`, `src/procedure.js`, `src/implementation-contract.js`, `bin/rdl.js`, command/readiness tests.
- **Kernel sync/settings lane:** `src/state.js`, `src/settings.js`, new `src/harness-settings.js`, sync/failure/config tests.
- **Adapter/verify lane:** owns new adapter/verify/settings modules after gate K.
- **Watch lane:** owns watch/revision/runtime-lock modules after gate V.
- **Drive lane:** owns tick/operationId/separate driver-lease integration after gate W.
- A separate verifier/reviewer owns final adversarial tests and release checks; it must not approve its own implementation diff.

Shared hotspot rule: `src/run-ledger.js`, `src/run.js`, `src/runtime.js`, `bin/rdl.js`, and `test/run*.test.js` have one active editor at a time. Other lanes rebase/adapt to that owner rather than overwriting concurrent edits.

## Risks and Mitigations

- **Release drift:** the ladder is fixed at 0.29/0.30/0.31/0.32; implementation keeps versions unchanged until each tranche acceptance, then performs only the corresponding version/CHANGELOG commit.
- **Unrecoverable ownership fork:** ship the explicit reasoned resolution path in the same hardening tranche, not as follow-up.
- **Settings/document coupling:** keep harness execution settings outside `board.json` and procedures outside harness settings.
- **Verifier modifies pre-dirty worktree:** reject verification before spawn; never auto-reset user changes.
- **Watch writes through check helpers:** snapshot Git status/HEAD/event counts in tests and audit every called helper.
- **Drive safety overclaimed:** document lease as optimization; prove safety with epoch fencing, lock, gates, and idempotence tests.
- **Tarball breakage:** root `src/` remains canonical and release install tests must execute every new command from packed CLI.

## Available Agent Types and Handoff

Available relevant roles: `architect`, `critic`, `executor`, `debugger`, `test-engineer`, `verifier`, `code-reviewer`, `dependency-expert`, `git-master`, and `writer`.

- Recommended durable path: **Team + Ultragoal**. Ultragoal owns the four stop-gate ledger; Team returns test/commit evidence at K, V, W, and D.
- Kernel: one `architect` (xhigh) for epoch/sync invariants, two `executor` lanes (medium) for ledger and command/sync after ownership is partitioned, one `test-engineer` (medium), then `verifier` (high).
- P1.5: one `executor` for adapter, one for verdict/CLI, one `test-engineer`, followed by `code-reviewer`/`verifier`.
- P2: one executor plus test-engineer is sufficient; keep a verifier independent.
- P3: one architect, one drive executor, one concurrency/failure test engineer, one verifier.
- `$autoresearch-goal` is not appropriate because the deliverable is implementation, not a research artifact. `$performance-goal` is not appropriate unless measurable performance regression becomes a separate goal. `$ralph` is only a fallback if a single-owner sequential fix/verify loop is explicitly desired.

Launch hints for an OMX tmux environment:

```text
$ultragoal .omx/plans/harness-continuation-four-tranches.md
$team 4:team-executor "Execute the current Ultragoal tranche only; stop at its named gate and return test evidence"
```

Before Team shutdown, it must provide changed-file ownership, targeted test output, full-suite output, mixed-version evidence, unresolved risks, and clean boundary/diff status. Ultragoal checkpoints that evidence and opens the next tranche only when its stop gate is green.

## Closed Planning Decisions

- Version ladder: 0.29 hardening / 0.30 verify / 0.31 watch / 0.32 drive.
- Compatibility baseline: locally packed commit `8d1c6df` tarball.
- Event identity: eventId + canonicalDigest over the shared canonical projection; localDetail is noncanonical and local-only.
- Ownership recovery: explicit recursive `run.ownership_resolved` state machine, never time/lexical winner selection.
- Adapter execution: one shared one-shot kernel and CLI semantics with exact output allowlists and filesystem boundary checks.
- P3 coordination: SPEC-1-registered `events/driver/` leases plus owner-independent operationId/outcomeDigest enforcement; ownerToken is authorization only and leases do not guarantee single execution.
- Remote watch: remote-tip/ahead-behind/diverged observation only, never remote-content diagnostics or worktree mutation.
