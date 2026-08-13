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

## Project charter sections

Every discovered `projects/<project-key>/project.md` always contains: `미션`, `목표`, `범위`, `역할`, `프로젝트 팀원`, `이해관계자`, `책임 매트릭스`, `의사결정과 에스컬레이션`, `위험과 제약`, `협업 리듬`, and `완료 정의`.

Each `ROLE-*` block has `미션`, `결정권`, `주요 산출물`, and `에스컬레이션`.

Each `MEMBER-*` block has `역할`, `소속`, `업무 계정`, `책임 영역`, and `상태`.

Each `STAKEHOLDER-*` block has `유형`, `관심`, `영향력`, `참여 방식`, and `담당 역할`. Include internal organizations, governance or approval bodies, users or customers, and external suppliers when they affect the project.

The responsibility matrix identifies Responsible, Accountable, Consulted, and Informed parties for every major deliverable or decision. A solo project can assign one member to several cells, but must still state the cells.

## Non-skippable derived concerns

- measurable success criteria and evidence
- included and excluded scope plus change authority
- decision owner, time limit, escalation path, and ADR threshold
- product, technical, quality, security, data, operational, and dependency risks that apply
- progress review, artifact review, and stakeholder communication cadence
- Definition of Done including traceability, acceptance evidence, operations, security, and `rdl check --strict`

Use `미정` only as an explicit temporary state. Pair it with a resolving owner or role and a task; never use it to conceal missing discovery.
