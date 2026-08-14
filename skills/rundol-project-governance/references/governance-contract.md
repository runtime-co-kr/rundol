# Rundol governance contract

## Canonical document metadata

Every canonical Markdown artifact keeps these fields: `id`, `type`, `kind`, `title`, `description`, `owner`, `state`, `tags`, `aliases`, and `related`.

- `project.md` uses `project:<project-key>`; ordinary artifacts use a three-letter document code and numeric sequence.
- `title` and the file title are Korean-centered and the file name includes the functional name.
- `owner` resolves to a `MEMBER-*` block.
- `tags` include `rundol/`, `artifact/`, `domain/`, and `feature/` namespaces.
- `aliases` starts with the document ID.
- `related` uses actual file names, not aliases as link targets.

Each project is registered by `projects/project-<project-key>.yaml` in the `rundol/workspace` branch and owns a separate `rundol/<project-key>` branch mounted at `projects/<project-key>/`. This mount is also the project's Obsidian Vault. Project-local `.rundol/state` and `.rundol/logs` are Git-ignored execution data; shared Client manifests and lease events belong to `rundol/workspace`. Do not combine independent projects into one state branch.

The repository root's current code branch owns application code and release assets. Its default branch name is discovered from the remote's `origin/HEAD`, so `main`, `master`, and custom repository standards are all valid. The `rundol/workspace` branch owns only cross-project registry and collaboration state. Each `rundol/<project-key>` branch owns only that project's charter, canonical documents, Board presentation, and tasks. `rdl git init` installs a managed pre-push boundary across all linked worktrees; `rdl git boundary` must be valid before persistence or synchronization. A local ref must push only to the identically named remote ref.

New canonical documents also carry the CLI-authored boundary contract: `granularity: bounded-v1`, one concrete `scope`, and one or more `excludes`. The scope states one independently reviewable responsibility. Split same-type material when owner or approver, acceptance criteria, lifecycle or review cadence, or primary consumers differ. Contract type presence is inventory state, not evidence that the subject area is complete.

## Project charter sections

Every discovered `projects/<project-key>/project.md` always contains: `미션`, `목표`, `범위`, `역할`, `프로젝트 팀원`, `이해관계자`, `책임 매트릭스`, `의사결정과 에스컬레이션`, `위험과 제약`, `협업 리듬`, and `완료 정의`.

Each `ROLE-*` block has `미션`, `결정권`, `주요 산출물`, and `에스컬레이션`.

Each `MEMBER-*` block has `역할`, `소속`, `업무 계정`, `책임 영역`, and `상태`.

Each `STAKEHOLDER-*` block has `유형`, `관심`, `영향력`, `참여 방식`, and `담당 역할`. Include internal organizations, governance or approval bodies, users or customers, and external suppliers when they affect the project.

The responsibility matrix identifies Responsible, Accountable, Consulted, and Informed parties for every major deliverable or decision. A solo project can assign one member to several cells, but must still state the cells.

## Document planning contract

`project.md` owns a schemaVersion 2 `documentProfile`. It is the single source of truth for AI clients, the CLI, and the Board.

- `policy` classifies every regular type exactly once as `required`, `recommended`, `onDemand`, or `disabled`.
- `rules.<TYPE>.after` lists document types that are useful AI authoring context. Missing recommendations never block document creation, save, or sync.
- `omissions.<TYPE>` records either `absorbedBy` plus required `sections`, or `notApplicable: true` plus a reason.
- `enforcement: advisory` reports findings without blocking persistence. `checkpoint` blocks `rdl save` and `rdl sync` while non-recommended violations remain.
- Contract changes are explicit and revisioned. Inspect impact before saving and never delete existing documents as a side effect.

The mandatory AI sequence is `rdl contract show`, `rdl contract next`, author or absorb content, `rdl contract check`, and finally `rdl check --strict`.

## Atomic implementation contract

`REQ`, `SCR`, `MOD`, `API`, and `TST` declare every implemented function with `functionIds` and `implementationContract: atomic-v1`. Several functions may share a file, but their specifications never share a range, combined row, placeholder, acceptance criterion, or test. Each function keeps the complete type-specific fields it would have in a standalone document. Implementation starts only after `rdl check --strict --implementation` succeeds for the linked REQ and TST.

Rundol never persists a document index, catalog, list, or traceability matrix as a canonical artifact. Direct IDs and links remain authoritative; `rdl contract trace` computes the current view on demand.

## Diagram convention

`catalog.diagrams` in `rdl contract show --json` declares which document types carry a diagram, which Mermaid kinds are accepted, and which representation is canonical. `diagram-v1` covers `MOD`.

A `MOD` document places a Mermaid `erDiagram` inside its `관계` section. `rdl check` reports `RDL-MODEL-001` when that diagram is missing.

The diagram is always a derived view. Cardinality, field constraints, and lifecycle meaning stay canonical in the entity and relationship tables, and the document states that precedence in prose so a later reader cannot mistake which side wins. Attributes therefore carry a type and an optional `PK` or `FK` key and nothing else; restating constraints, defaults, or lifecycle in attribute comments duplicates the entity table and drifts from it, which `rdl check` reports as `RDL-MODEL-002`.

Diagram scope follows document scope. Only entities the document owns show attributes. Entities owned elsewhere appear as bare nodes on relationship lines, with their owning document linked in the surrounding prose. This makes the artifact's responsibility boundary visible in the rendered view, and keeps a model document from silently becoming a second source of truth for a neighbor's fields.

`conventions.<TYPE>.selection` decides what enters the diagram, one question per element:

| 요소 | 질문 | 포함 | 제외 |
|---|---|---|---|
| 엔티티 | 이 문서가 수명주기를 소유하는가? | 소유 엔티티는 속성 포함 | 인접 엔티티는 속성 없이 노드만 |
| 관계 | 저장된 필드가 이 참조를 만드는가? | FK·식별자로 저장된 참조 | 재생·계산으로만 성립하는 관계 |
| 카디널리티 | 저장 시점 제약인가 조회 시점 제약인가? | 저장 시점 제약 | 조회 시점 제약 |

The entity question is about lifecycle, not count. A dependent aggregate whose parts have no independent life is one owned entity group; separate lifecycles under one document are a split signal instead.

The cardinality question is the one that silently fails. Relational notation can only state what is true at write time, so a read-time limit such as "at most one currently valid" belongs to the invariant or calculation section that computes it. Never draw a stored cardinality while labeling the line with the derived concept: the line then asserts two different clocks at once, and a reader cannot tell which one the document means. When a relationship table row mixes them the same way, the table is the defect and is fixed first, because the diagram derives from it.

State transitions are excluded outright. Relational notation has no place for them, and the per-function 상태와 전이 contract already states them completely; a second rendering would add a drift surface without adding information.

## Canonical design routing

In a Rundol-governed project, a generic `DESIGN.md` is not a canonical artifact. Route design intent by responsibility:

- product behavior and quality constraints → `REQ`
- user flows, screen states, input validation, and accessibility → `SCR`
- system boundaries, components, and deployment structure → `ARC`
- important decisions, alternatives, rationale, and consequences → `ADR`
- implementation and verification work → Rundol tasks linked to `REQ` and `TST`

When a target type is disabled, use its `omissions.<TYPE>.absorbedBy` document and required sections. Existing `DESIGN.md` files are migration inputs: preserve them, create a follow-up task, and move their content only after review.

## Non-skippable derived concerns

- measurable success criteria and evidence
- included and excluded scope plus change authority
- decision owner, time limit, escalation path, and ADR threshold
- product, technical, quality, security, data, operational, and dependency risks that apply
- progress review, artifact review, and stakeholder communication cadence
- Definition of Done including traceability, acceptance evidence, operations, security, and `rdl check --strict`

Use `미정` only as an explicit temporary state. Pair it with a resolving owner or role and a task; never use it to conceal missing discovery.
