# 변경 이력

이 문서는 사용자에게 영향을 주는 Rundol 변경을 기록한다. 버전 분류와 tag 규칙은 [버전과 릴리스 정책](docs/RELEASES.md)을 따른다.

## [Unreleased]

## [0.28.0] - 2026-08-16

### Changed

- **문서 1개가 기능 1개를 나르는 것이 기본 계약이 됐다.** 같은 도구로 만든 두 프로젝트의 결과가 갈렸다 — free-loan은 다기능 문서 0개, rundol 정본은 REQ 셋이 기능 5~6개씩. 규칙이 강제하지 않으니 작성 주체에 따라 달라진 것이다. 이제 다기능은 frontmatter 평면 키 `groupingReason`·`groupingFunctions`로 선언한 opt-in이며, 유형 정책이 선언의 효력을 정한다: REQ·SCR은 선언이 있어도 거부(분리가 유일한 해소), TST는 선언으로 허용, MOD·API는 허용하되 사유를 경고(`RDL-IMPL-017`)로 항상 표면화한다. `rdl doc create`는 `--function-id` 2개 이상에 `--grouped --reason`을 요구한다.
- 새 진단 `RDL-IMPL-013`(선언 없는 다기능)·`014`(금지 유형)·`015`(선언 형식 위반)·`016`(같은 기능이 같은 유형 문서 여럿에 흩어짐)은 **단계 도입**된다: 일반 검사에서 경고, `--implementation` 구현 준비도 게이트에서 오류. 문서 저장·동기화는 막히지 않지만, **위반 문서가 연결된 태스크의 준비도 검사는 오류가 되어 구현 착수가 게이트된다.** 해소는 문서 분해 또는(허용 유형에 한해) grouping 선언 추가다. 기존 문서의 정리가 끝나면 상시 오류 승격을 검토한다. REQ 간 기능 중복을 지키던 `RDL-IMPL-009`는 그대로 상시 오류다.

## [0.27.0] - 2026-08-16

### Added

- **`rdl run` — 절차 실행 관리.** 런은 목표·단계·게이트·결과를 `RUN-ID`로 묶는 실행 단위다. `start`가 절차 정의 전문을 pin하고, `next`가 커서 스텝의 실행 방법을 원장 fold에서 재계산해 반환한다 — 어떤 클라이언트든 이 인터페이스 하나만 물으면 된다. 일반 스텝은 `step`으로 완료를 보고하고, 게이트 스텝은 `gate`가 rdl 하위 명령을 셸 없이 직접 실행해 종료 코드로만 전진한다. `--force --reason` 우회는 forced 이벤트로 남는다. 명령을 내리는 주체는 런의 현재 소유자이며, 다른 클라이언트는 `takeover`를 거쳐야 쓸 수 있다.
- **절차 상속.** 내장 기본값 → Workspace `projects/workspace/procedures.json` → 프로젝트 `projects/<key>/procedures.json`. 오버라이드는 스텝 추가와 파라미터 조이기만 — 게이트 제거, 게이트 명령 변경, 시도 상한 확대, 사람 게이트 제거, 부모 스텝 순서 변경은 로드 시점에 거부된다. 유효한 절차 이름과 병합 결과는 한 함수가 단일 소스로 계산한다. 런이 pin한 정의는 이후 변경·삭제와 무관하게 유효하다.
- **sync 전이.** sync가 성공하면 `completed_local` 런이 `synced`로 전이한다 — 런의 완료는 저장이 아니라 병합 생존이다. sync의 어떤 실패든 진행 중이거나 로컬 완료인 런을 재개 가능한 `halted`로 전이시킨다.

### Fixed

- Windows에서 이벤트 저장 락 획득이 드물게 실패했다. 다른 프로세스의 락 해제(rmdir)와 겹친 획득(mkdir)이 `EEXIST` 대신 일시적 `EPERM`을 반환할 수 있는데 재시도 대상이 아니었다. 일시 오류를 재시도하고 대기 한도를 늘렸다.

## [0.26.0] - 2026-08-16

### Added

- **run 원장이 workspace 브랜치로 승격됐다.** 커서를 결정하는 모든 런 이벤트가 `projects/workspace/events/run/`의 클라이언트+런 샤드로 복제되고, 커밋은 체크포인트에서만 만들어진다. 다른 머신이 로컬 상세 없이 공유 이벤트만 읽어도 다음 스텝·시도 횟수·정지 사유가 소유자와 동일하게 복원된다 — 시도 횟수가 공유되지 않으면 인수가 시도 상한을 우회하기 때문에, 공유의 기준은 빈도가 아니라 커서 결정성이다. 구버전 check는 `events/`의 디렉터리를 건너뛰므로 이 경로를 보지 못하고 오진하지 않는다. 0.24.0 코드를 그대로 실행하는 혼합 버전 테스트가 이를 증명한다.
- **런 인수(takeover).** 자동 인수는 이전 소유자의 정지(halted)가 보일 때만이다. 정지 없이 죽은 런은 사람이 `--force`와 사유로 인수하며 forced로 기록된다. 벽시계 TTL은 어떤 인수 판정에도 쓰이지 않는다 — 머신 간 클록 스큐는 보정할 수 없다. 크로스 클라이언트 이벤트 순서는 시계가 아니라 takeover 이벤트의 `previousClientId` 연결로 복원한다.
- `rdl check`가 run 샤드를 검사한다: 파일명 패턴(`RDL-RUN-001`), Client 등록(`RDL-RUN-002`), 파일명과 이벤트 필드의 일치(`RDL-RUN-003`), JSONL 파싱(`RDL-RUN-004`). 그 밖의 `events/` 서브디렉터리는 미래의 이벤트 종류로 보고 진단하지 않는다.

## [0.25.0] - 2026-08-16

### Added

- **로컬 run 원장.** 목표→단계→게이트→결과를 `runId`로 묶어 프로젝트 로컬 `.rundol/runs/<runId>/events.jsonl`에 기록하는 append-only 원장이 생겼다. 진행 상태는 저장되지 않고 읽기 시점의 결정적 fold로 계산되므로, 프로세스가 어디에서 죽어도 다음 읽기가 커서·시도 횟수·정지 사유를 그대로 복원한다. 시도 상한은 정지 이벤트 없이도 fold가 강제하며, 재개는 사람 개입으로 보고 시도 예산을 되살린다. 크래시로 절단된 마지막 줄은 읽기가 무시하고 다음 기록이 같은 규칙으로 잘라낸다. 공유 브랜치에는 아무것도 쓰지 않는다 — Git에 새 파일 종류가 생기는 것은 다음 마이너의 일이다.
- `rdl action record`가 `runId` 상관 필드를 받는다. 주지 않으면 기록은 이전과 바이트 단위로 같다.

### Changed

- lease 이벤트 저장의 샤드 선택·세그먼트 롤오버·읽기 검증이 범용 이벤트 스토어(`src/event-store.js`)로 추출됐다. 파일 경로·이벤트 형태·오류 메시지는 그대로다. 같은 client의 CLI 프로세스 여럿이 동시에 임대를 기록하면 세그먼트 롤오버의 「읽고 판단하고 append」가 경합할 수 있었는데, 머신 단위 락으로 직렬화했다. clientId는 실행 주체 단위 식별자라 프로세스 경합까지 막지는 못하기 때문이다.

## [0.24.0] - 2026-08-16

### Changed

- **호환성 파괴 — `documentProfile`이 저장하는 범위가 줄었습니다.** [마이그레이션 안내](docs/MIGRATION-0.24.md). `rules.<TYPE>.after` and the absorption half of `omissions` are no longer project state. Authoring order never differed between projects and never blocked anything, so it is now a shipped constant and `rdl contract next` returns what it always did. Absorption checked only whether a heading string existed: six empty headings satisfied it, while a document that covered the subject thoroughly under different headings failed it, and enabling the type later left the absorbed content in place with nothing pointing at it. Four diagnostics (`RDL-PROFILE-006`, `007`, `010`, `011`) went with it. A `project.md` written by this version is rejected by `0.23.0`, so upgrade a shared workspace together. Nothing needs to be run: old blocks still parse, and the next contract save drops them.
- **A recorded `notApplicable` decision and its reason survive.** They are not a machine-generated default — they are a person's judgement about why a type does not apply, and nowhere else holds them. Removing the absorption rule was not a reason to erase them.
- Document types now carry the sections their documents are expected to fill, on every type rather than only disabled ones. `rdl contract show --json` reports them per profile and `rdl doc create` scaffolds from the same list. The shipped defaults were extracted from 257 real project documents rather than guessed from templates.
- Profiles are no longer five hardcoded names. A team defines its own in `board.json` — label, policy, and per-type sections — inheriting built-in → workspace → project, the same chain the display settings already used. The contract stores only the profile name; what it means is recomputed on read.
- Stored values and the words on screen are separated. `required`, `checkpoint`, `lean`, `todo` and `high` reached the screen verbatim, and the profile picker used the display text as the stored value, so renaming a label would have broken saved contracts. Labels now come from the display settings and are editable per workspace and project. `onDemand` reads as 「선택」 rather than 「필요할 때」, which sounded like a schedule when it means permission.

### Fixed

- A team profile made `rdl check --strict` fail. `rdl contract show` resolved presets but the general check did not, so a custom name was misdiagnosed as unsupported and blocked save and sync — `contract check` reported valid while `check --strict` failed on the same project.
- Editing two tasks in quick succession could lose the first edit. Settling one task refreshed the snapshot, which reverted the other task's not-yet-sent optimistic change, and the next payload was then built from the reverted value.
- The contract editor's preset section fields and "save as preset" button were wired to nothing. Saving now goes through a display-settings API that writes only what this scope overrides, so inherited values are not frozen into the lower file.
- `rdl doctor` hardcoded a Node floor of 14 while the package required 20, so it reported a healthy environment that could not run Rundol. It reads `engines` now.
- Switching projects left scheduled task saves and the open detail panel behind: the save would fire against the new project's path, and the panel kept showing an item absent from the new list.
- The home screen's four metrics were inert `div`s. They now open the list each number came from.

## [0.23.0] - 2026-08-16

### Changed

- **호환성 파괴 — `engines.node`가 `>=14`에서 `>=20`으로 올라갔습니다.** [마이그레이션 안내](docs/MIGRATION-0.23.md). The `>=14` floor had never been true: the direct dependency `marked` requires `>=20`, CI verified only 20 and 22, and the install guide said 14. Node 14–19 installed and then failed on first run. `>=20` records the range that actually works rather than removing capability, but `npm install` now succeeds and fails in different places, so it is a compatibility break. Data, document contracts, task storage, CLI arguments and the Board API are unchanged; no migration command is needed.
- This change already shipped in `0.22.9` and `0.22.10`, which were released as PATCH with no changelog entry. That contradicts the repository's own [release policy](docs/RELEASES.md), which requires a MINOR bump and a documented migration for a compatibility break. `0.23.0` re-releases the same content under the correct classification. On Node 20 or newer the three versions behave identically.

### Fixed

- Consecutive task edits could be rejected. After a save the queue entry was cleared before the fresh snapshot arrived, so a click landing in that window started a new queue entry stamped with the pre-refresh revision and the next request was refused with HTTP 409. The entry now survives until the snapshot lands, and changes made in between are carried into it. The guard that keeps polling from replacing the snapshot mid-edit was doing two different jobs — protecting a document draft and protecting optimistic task rendering — and has been split, so the save path can take the new revision while the document draft protection stays absolute.
- A task panel stayed open after moving to another screen. Tasks and People were allowed to keep the panel as a pair, so opening a task and then going to People left the previous task's panel on screen with its selection already cleared, and the reader column stayed narrowed for a panel that no longer belonged there.
- Composite views recorded a source commit they could not prove. When `git status` itself failed the worktree was treated as clean and the current HEAD was written as the view's origin, even though checking that commit out might not reproduce the view. What cannot be proven clean is no longer claimed as clean.

## [0.22.10] - 2026-08-16

### Fixed

- Sequence diagram participant names spilled outside their boxes. Mermaid sizes each box by measuring the label in the font from its own config, but the style it injects into the SVG never applied, so the text was actually drawn in the browser's default monospace. Measured width and drawn width disagreed and long names like "Project readers" ran past the border. Both now use the same font.

## [0.22.9] - 2026-08-16

### Fixed

- Diagrams in document bodies were unreadable. Flowchart edges rendered as large black wedges: their paths carry the class `flowchart-link`, not `edgePath`, so the rule meant to stroke them never matched and mermaid's default black fill filled the inside of every curve. Sequence actor names were white text on white boxes, because the shape-fill rule matched `.actor` and `text.actor` is a label, not a shape. ER cardinality markers were black blobs, because crow's feet are drawn with strokes and every marker path was being filled. Edge colour came from the divider token, the weakest hairline tone in the palette, which left arrows too faint to trace from one node to the next.
- Wide flowcharts shrank to fit the reader column until their labels reached an effective 7px. A diagram that is fully visible but illegible shows nothing. Diagrams now stop shrinking at an 11px floor and scroll horizontally past it.
- The task Board was unusable. The page scrolled instead of the lanes, so lane headers slid out of view and there was no way to tell which column was on screen; cards were wider than their lane and spilled out both sides, because the implicit grid track sizes to max-content; card titles were clipped mid-word on one line and short titles sat centred, both inherited from the global button rule. The Board is now pinned to the viewport, each lane scrolls inside itself, the header and filters stay put, and cards share one height so columns can be compared by eye.
- Saving a document from the Board rewrote parts of the file nobody had edited: it dropped the blank line after the closing `---` and converted CRLF line endings to LF. A document saved without a single change came back as a whole-file diff, mixing real edits into noise. Saves now restore the separator and line endings the file already used.
- Saving the document contract replaced every omission disposition with catalog defaults. A type marked not-applicable — a decision the settings screen cannot express — lost its disposition and its recorded reason on the next save from that screen. Dispositions are now merged per type, and a payload that does not carry a decision leaves the current one alone.

### Changed

- A document lease is a coordination signal, not a permission to save, and `REQ-020` now says so. Enforcing it would mean that a browser dying mid-edit leaves a five-minute lease that locks everyone else out with nothing to do but wait — worse than anything the lease prevents. Loss is prevented by `baseRevision` and the branch boundary instead. Saving a document held by another client now succeeds and reports who holds it and until when, rather than being refused.

## [0.22.8] - 2026-08-15

### Fixed

- The `0.22.7` release never published. Its lockfile carried a release-version stamp on a transitive dependency, so `npm ci` refused to install and both the release and CI workflows stopped before doing anything. This release carries the same changes with a lockfile regenerated by npm.

## [0.22.7] - 2026-08-15

### Added

- Tasks can be closed as `cancelled`. Work that was decided against had nowhere to go: `done` demands satisfied acceptance criteria and a linked TST, so it could not pass, and forcing it through would record "완료" for a deliverable nobody will ever find. The two terminal states carry opposite gates — `done` requires the evidence, `cancelled` presupposes its absence and requires a reason and a decider instead, enforced as strictly as the `waiting`/blocker pair so cancelling cannot become a quiet bypass. `rdl task set --status cancelled --reason <사유> [--decided-by <MEMBER-ID>]`. A terminal task no longer blocks its dependents; treating a cancelled predecessor as unfinished left successors permanently blocked with no way to clear them.
- The Board shows what is blocked. A task waiting on a person was stored but a task whose predecessor is unfinished was not shown anywhere, so the list read as if the work could start. Both are now judged in one place and marked in the list, and a dependency view draws the order for whatever the current filters select.
- The home screen answers what to do next. It separates work that can start from work that is blocked, and lists what changed since the last visit — the last-visit time is kept per browser, since one shared timestamp would hide changes on every other device.
- Members can be registered from the CLI with `rdl member add|set|list`. `project.md` stays canonical and the Board does not edit it.

### Fixed

- Quick add on the task screen sent no acceptance criteria, which the API requires, so every quick add failed with HTTP 400. The one-line form is gone; tasks are created through the dialog that collects a completion condition properly.
- Polling replaced the snapshot while a document was being edited. Only the redraw was skipped, so the draft's base revision was silently refreshed and saving it passed the optimistic concurrency check — overwriting whatever someone else had changed in the meantime. The snapshot is now left alone while editing.
- The Board snapshot inherited the task list API's default limit of 100. The snapshot is the whole working set the screen filters locally, so beyond 100 tasks the remainder vanished at once from the list, personal queue, attention items and dependency checks, with nothing indicating the loss.
- A generated client id embedded the machine's hostname, and that id becomes shard directory and event file names committed to the repository. `MOD-002` forbids host information in the manifest body but it was leaking through file names instead. New ids hash the hostname to six characters, so a machine keeps a stable identity without publishing its name.
- Pair-consistency errors carried no status code, so the Board returned HTTP 500 for what is a caller input mistake. `blocker` had the same problem.

### Changed

- The Board's chrome is split by what it owns. The header keeps only what does not depend on the project — search, sync state, attention count, the viewing identity and settings — and the sidebar keeps navigation within the project. A single sidebar carrying all of it overflowed the screen.
- Both side panels collapse to an icon rail instead of disappearing. Hiding them moved the content by their full width on every toggle and left the reopen control to be hunted for; overlay panels are gone entirely, so behaviour no longer depends on window width.
- Task detail is one component rendered either in the side panel or as a full page, ordered title, properties, then content. The two used to be separate markup, so the same task showed different things depending on where it was opened.
- The operations screen is gone. Its sync and attention cards duplicated the header and home screen and its watch card was a placeholder; the edit leases it uniquely showed moved to Workspace settings.
- Presentation rules are read-only in the Board and name the `board.json` that owns them. Client registration and removal stay with `rdl client`; the Board only toggles the active flag.
- Polling backs off when the tab is hidden instead of recomputing the snapshot every three seconds all day.

## [0.22.6] - 2026-08-14

### Fixed

- `rdl attach` and `rdl init`'s repair path reported composite generation failures only inside an object, and the human-readable printer skips objects, so a failure was invisible unless `--json` was passed. Failures now also surface as a plain line. A project skipped because its `.gitignore` lacks the entry is a deliberate omission and is not reported as a failure.
- A composite view generated from a worktree with uncommitted changes recorded `HEAD` as its source, so checking out that commit and regenerating did not reproduce it — the reproducibility the document standard promises. The revision is now recorded only when the worktree is clean, and `rdl contract diagram` reports `dirty`.
- The generated-view directory was skipped by name at any depth, so a legitimate `docs/views/` would have silently dropped out of every document check. It is now skipped only at the project root, where the generator actually writes.
- `RDL-COMPOSE-002` checked only a transition's destination. An edge starting from a screen that does not exist passed and composed a phantom node; both ends are now checked.

### Added

- Added `RDL-SCREEN-004` for a transition that starts from another screen. The screen-owns-its-exits rule was stated in the standard but never enforced, so a document could declare a neighbour's edge and the composite graph would silently lose the completeness it claims.
- `npm run version:check` now compares `package-lock.json` against the release version. The lockfile had drifted to `0.22.3` while the manifests moved to `0.22.5`, and nothing caught it.

### Changed

- The `waiting`/`blocker` invariant moved from the Board API to the shared task layer, so `rdl task set` rejects the change with a clear message instead of writing it and having projection validation roll it back with a generic `RDL-TASK-014`.

## [0.22.5] - 2026-08-14

### Added

- Extended `diagram-v1` to `SCR`. A screen document now declares the moves that leave it in a `전이` section with a Mermaid `flowchart`, canonical in the transition table above it. `rdl check` reports `RDL-SCREEN-001` when the diagram is missing, `RDL-SCREEN-002` when a node is not a `SCR` identifier, and `RDL-SCREEN-003` when an edge returns to its own screen.
- Added `rdl contract diagram --project <key> [--write] [--json]`, which merges every `MOD` `erDiagram` into one data view and every `SCR` `flowchart` into one screen view. It reports `RDL-COMPOSE-001` when two documents claim attributes on the same entity and `RDL-COMPOSE-002` when a transition points at a screen that does not exist — defects no single document can see.
- `--write` places the composite in the Vault's Git-ignored `views/` so Obsidian readers see the same picture the Board does, and adds the ignore entry once for projects created before this release.
- `rdl check` now runs the same composition, so attempting the merge doubles as a consistency check: `RDL-COMPOSE-001` and `RDL-COMPOSE-002` surface without asking, and `RDL-COMPOSE-003` reports a generated view that no longer matches the canonical documents. The comparison reads the diagram body rather than the frontmatter, so a new commit alone is not drift and a hand-edited generated file is.
- `rdl attach` and `rdl init`'s repair path generate the views while connecting a project. Projects whose `.gitignore` lacks the entry are skipped so that connecting never modifies a tracked file; one explicit `rdl contract diagram --write` adds it and later attaches generate automatically.

### Changed

- Screen transitions and screen states now have one owner each: moving to another `SCR` is a transition, changing what the current screen displays is a state. The `SCR` template ships both sections and the boundary between them.
- Composite views are computed, never stored as canonical artifacts. The generator is deterministic — nodes and edges sort by identifier and nothing time-varying reaches the body — so the same inputs always produce the same bytes and an old view is reproduced by checking out that commit and regenerating. Generated files record their input documents and source commit, and report themselves stale once the canonical documents move past them.

### Fixed

- Moving a task to `대기` in the Board now asks who is being waited on, what releases the wait, and since when, and saves the status and the blocker as one change. Leaving `대기` clears the blocker in the same change. The API rejects a `waiting` status without a blocker, a blocker on any other status, and a waiting target that `project.md` does not register, so a transition can no longer be accepted and then reverted by `RDL-TASK-014` or `RDL-TASK-015`.
- Board primary buttons now carry their own foreground token. The light theme turns the accent into near-black, which left `+ 새 태스크` and the task dialog's save button printing black on black; the label is now white there and unchanged in the dark theme.
- The task dialog's `×` and `취소` buttons no longer submit the form. Both sat inside a `method="dialog"` form as implicit submit buttons, so dismissing an empty dialog tripped the title field's required-input validation instead of closing. Only the save button submits, and only it validates.
- Mermaid diagrams render in the Board's own palette instead of Mermaid's built-in `default` and `dark` themes, which painted lavender entities in the light theme and greys the surrounding surface could not carry. Entity fills, borders, relationship lines, edge labels and attribute rows all read from the active theme tokens and re-render on a theme switch.
- ER cardinality markers no longer keep Mermaid's hardcoded white circle fill, which showed as a solid white blob over every relationship line in the dark theme. The circle now takes the diagram's surface colour, and the diagram sits on the panel surface rather than the code-block background.
- `rdl doc create NTE` produced an unusable note. The template never closed its frontmatter, so every generated note failed `rdl check` with `RDL-DOC-001` and blocked `rdl save` for the whole project; it also carried no `owner` line, so `--owner` had nothing to fill in. The template now closes its frontmatter and ships a body.
- A screen title containing a double quote no longer breaks the composite view. The generated node label escaped nothing, so `로그인 "실패" 화면` emitted four quotes on one line and the diagram failed to parse.

### Changed (notes)

- `NTE` stays outside the artifact taxonomy, so it requires only the `rundol/` tag namespace rather than `artifact/`, `domain/`, and `feature/`. Every other metadata and identifier rule still applies, so a sub-numbered identifier such as `REQ-001-01` remains invalid; a note points at its subject through the file name and `related` instead.

### Migration

- Existing `SCR` documents report `RDL-SCREEN-001` until a `flowchart` is added to their `전이` section. This is advisory and blocks neither `rdl save` nor `rdl sync`.
- When adding the section, move any branch that stays on the same screen out of it. A login failure that renders an error is a state, not a transition, and belongs to the `상태` table.
- Never recover the transition graph from `TST` scenarios. Scenarios walk representative paths, so any edge no path crosses disappears without a trace.

## [0.22.4] - 2026-08-14

### Added

- Added the `diagram-v1` document diagram convention. `rdl contract show --json` now publishes `catalog.diagrams` so AI clients and the Board read the accepted Mermaid kinds, the canonical representation, and the selection criterion from the CLI instead of restating them.
- `MOD` documents now carry a Mermaid `erDiagram` in their `관계` section. `rdl check` reports `RDL-MODEL-001` when it is missing and `RDL-MODEL-002` when attribute comments duplicate the entity table.
- Added `conventions.<TYPE>.selection`, which decides each diagram element with one question: whether this document owns the entity's lifecycle, whether a stored field creates the relationship, and whether a cardinality is enforced at write time or at read time.
- The `MOD` template ships a conforming `erDiagram` scaffold, and the governance skill and document standard state the same selection criterion.

### Changed

- The diagram stays a derived view: entity and relationship tables remain canonical for cardinality, field constraints, and lifecycle, and only entities a document owns show attributes. Both findings are warnings, so existing model documents keep passing `rdl check --strict` until they are updated.
- State transitions stay out of relational notation. The per-function `상태와 전이` contract remains their only source of truth, so no second diagram kind was introduced.

### Migration

- Existing `MOD` documents report `RDL-MODEL-001` until an `erDiagram` is added to their `관계` section. This is advisory and blocks neither `rdl save` nor `rdl sync`.
- When adding the diagram, check whether a relationship row states a read-time constraint such as "at most one currently valid" as its stored cardinality. Fix the table first, because the diagram derives from it.

## [0.22.3] - 2026-08-14

### Added

- Expanded Rundol's canonical project specification from the recent document-contract slice to the full Workspace, synchronization, task, collaboration, Board, installation, and release lifecycle.
- Added one-function-per-file REQ and TST pairs for 11 core capabilities, plus bounded Git, Board, data-model, API, decision, runbook, and glossary documents.
- Replaced the placeholder Rundol project charter with explicit mission, goals, scope, responsibilities, risks, review cadence, and Definition of Done.

### Changed

- Rundol's own reference project now demonstrates the governance skill's preferred small-document shape without introducing a generic `DESIGN.md`, index, catalog, or persisted traceability matrix.

### Migration

- No runtime or storage migration is required from 0.22.2. Reinstall the governance skill and use `rdl contract trace` plus `rdl check --strict --implementation` when expanding an existing project's specifications.

## [0.22.2] - 2026-08-14

### Added

- Added `atomic-v1` function contracts for REQ, SCR, MOD, API, and TST documents, including type-specific standalone fields for every declared function ID.
- Added `rdl check --implementation` readiness validation and `rdl contract trace` computed traceability with no persisted index artifact.
- Added implementation-readiness task completion gates, Board contract visibility, and remote default-branch discovery through `origin/HEAD`.

### Changed

- The governance skill now forbids grouped function ranges, combined specification rows, generic `DESIGN.md`, and canonical index or traceability-matrix documents.
- Rundol's own PRD, REQ, architecture, ADR, and TST documents now describe and verify 16 independent function contracts.

### Migration

- Existing 0.21.1–0.22.1 projects should follow [Rundol 0.22 migration](docs/MIGRATION-0.22.md). Existing implementation documents remain warnings under normal strict checks and must be upgraded before enabling the implementation readiness gate.

## [0.22.1] - 2026-08-14

### Added

- Added template-derived component catalogs, non-blocking AI context guidance, and freely editable omission requirements in Board document contract settings.
- Added inherited Board presentation settings from built-in defaults through Workspace and project `board.json` files, including consistent document type and state labels.
- Added Rundol skill routing and CLI/structure diagnostics that treat generic `DESIGN.md` files as preserved migration inputs rather than canonical documents.

### Fixed

- Expanded Markdown reading width, removed the task Board's inner horizontal scroll, and improved inline-code contrast in light and dark themes.
- Unified document type and state vocabulary across navigation, recent documents, cards, lists, and document details.

### Migration

- Existing 0.22.0 projects need no contract or storage migration. Reinstall the governance skill to receive canonical design routing; optional `board.json` files can override presentation labels without changing document identity or paths.

## [0.22.0] - 2026-08-14

### Added

- Added schemaVersion 2 document planning contracts with enforcement, authoring prerequisites, omission absorption rules, and deterministic evaluation.
- Added `rdl contract show|next|check|plan|set` and shared contract visibility across bootstrap, document creation, validation, save/sync, the governance skill, and the Board.

### Migration

- Existing `0.21.1`–`0.21.3` workspaces should follow [Rundol 0.22 migration](docs/MIGRATION-0.22.md), configure the contract as advisory first, then enable checkpoint after violations are resolved.

## [0.21.3] - 2026-08-14

### Fixed

- Unix 계열 환경의 개별 CLI 전역 설치 검증이 npm의 `<prefix>/bin` 실행 파일 경로를 사용하도록 수정했습니다.

## [0.21.2] - 2026-08-14

### Added

- Bootstrap discovery와 idempotent `rdl init`/`attach` repair 경로를 통합했습니다.
- 프로젝트 `documentProfile`, guided interview, non-interactive 정책 설정을 지원합니다.
- canonical 문서 경로와 legacy 문서 migration, 통합 QA 및 사용자 문서를 정비했습니다.

## [0.21.1] - 2026-08-12

### Added

- 태스크 완료조건을 Board에서 직접 체크하고 revision 충돌을 검증해 저장한다.
- 설정 화면에 기본 색상과 고대비 흑백 모드를 추가한다.
- Markdown의 Mermaid 코드 블록을 로컬 번들로 SVG 렌더링한다.

### Fixed

- 루트를 private monorepo로 전환하고 `packages/rundol`만 배포 이름을 소유하게 해 Git URL 설치에서 발생하던 dangling package Junction을 제거했다.
- 오른쪽 Context 패널을 접은 뒤 펼치기 버튼이 잘려 복구할 수 없던 레이아웃을 수정한다.
- 데스크톱 접힘과 모바일 오버레이 상태가 동시에 남지 않도록 패널 상태를 정규화한다.
- 설정 버튼의 화면 이동과 테마 상태 표시를 회귀 테스트한다.

## [0.21.0] - 2026-08-12

### Added

- Navigation·Main·Context 3패널 Board Shell과 Documents 1급 탐색·읽기 화면
- 영역별 revision을 포함한 Workspace Snapshot과 Needs Attention 파생 상태
- base revision 및 strict validation 롤백을 적용한 Markdown 문서 편집 API와 UI
- People, Operations, Settings 분리 화면과 모바일 Navigation·Context drawer

### Changed

- Home을 단순 태스크 개수에서 최근 문서와 조치 필요 항목 중심으로 재구성했다.
- Tasks를 목록 우선으로 제공하고 Board를 선택 가능한 보기로 변경했다.

## [0.20.1] - 2026-08-12

### Added

- Workspace JSONL 이벤트와 Git CAS 재시도로 동시 문서 번호를 중복 없이 예약한다.

### Changed

- Workspace와 프로젝트 동시 fetch가 공용 `FETCH_HEAD`를 덮어쓰지 않도록 브랜치별 원격 ref를 사용한다.
- README와 상세 문서의 저장 경로, 설치, Obsidian, 명령 예제와 릴리스 정책을 일관되게 정리했다.

## [0.20.0] - 2026-08-11

### Added

- schemaVersion 6 Workspace, Client Registry와 분할 JSONL 문서 임대 이벤트
- 프로젝트 로컬 `.rundol/state`, `.rundol/logs` 실행 상태와 Workspace·Client·Lease CLI
- 멀티 프로젝트 Board Home, 프로젝트 전환, 문서·동기화·임대·Client API와 통합 snapshot
- 태스크 엔티티 revision 및 오래된 수정의 `409 Conflict` 처리

### Changed

- Workspace 공통 상태를 `projects/workspace/`, 프로젝트 상태를 `projects/<key>/`에 연결한다.
- Git safe-directory 판별을 실제 저장소 루트 기준으로 수행한다.

## [0.19.0] - 2026-08-11

### Added

- 저장소 내부 `.rundol` 없이 OS 사용자 runtime state를 사용하는 schemaVersion 5 Workspace
- 원격 `rundol/settings`와 `rundol/<project-key>`를 복원하는 `rdl attach` 및 `rdl detach`
- 프로젝트별 Obsidian Vault와 `rdl check --structure`, `rdl cleanup --apply`
- npm workspaces 기반 `core`, `protocol`, `cli`, `node`, `board`, 통합 `rundol` 패키지 경계

### Changed

- 신규 프로젝트의 Obsidian Vault 루트를 `projects/<project-key>`로 변경
- main `.gitignore` 대신 로컬 `.git/info/exclude`로 프로젝트 worktree를 숨김
- 빈 `.gitkeep` 기본 생성을 제거하고 선택 디렉터리를 필요할 때 로컬 생성

## [0.18.0] - 2026-08-11

### Added

- CLI·LLM·혼합 액션 라우팅과 실제 executor·fallback·채택률 debug 집계
- `rdl task acceptance`를 통한 완료조건 상태 변경
- 미보고 LLM 토큰 이벤트의 명시적 구분

### Fixed

- 종료 코드가 0이 아닌 검증 결과를 debug 성공으로 기록하던 문제
- PRD 입력 제목에 `제품 요구사항` 접미사를 중복 추가하던 문제

## [0.17.0] - 2026-08-11

### Added

- `rdl doctor` 구조화 설치 진단과 독립 `scripts/install-doctor.js`
- GitHub·GitLab HTTPS/SSH 설치, HTTP/1.1 fallback, PATH와 손상 설치 복구 문서
- tarball·Git URL 전역 설치와 손상 package 감지 회귀 테스트

## [0.16.0] - 2026-08-11

### Added

- `rundol/settings` 브랜치와 schemaVersion 4 Workspace
- client ID 기반 최대 500건 태스크 샤드와 단일 `tasks.json` 마이그레이션
- `rdl sync watch`, 충돌 조회·해결 CLI, 표준 문서 생성, debug token 집계
- Board 자동 갱신, 빠른 태스크 생성, drag/drop과 확장된 협업 정보 UI

### Changed

- AI 클라이언트 거버넌스 스킬이 settings와 태스크 샤드 구조를 따르도록 갱신됐다.

## [0.15.0] - 2026-08-11

### Changed

- 중복된 SPC 문서 체계를 REQ로 통합하고 CLI·문서 표준을 정리했다.
