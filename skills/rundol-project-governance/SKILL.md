---
name: rundol-project-governance
description: Preserve Rundol project governance, document planning contracts, canonical documents, tasks, traceability, and quality gates. Use when a repository has Rundol workspace/project branches or when creating, editing, reviewing, or validating Rundol documents and tasks.
---

# Rundol Project Governance

Treat lightweight delivery as an implementation choice, never as permission to remove governance or silently bypass the document contract.

## Workflow

1. Run `rdl init --json` first. Treat `created`, `already-connected`, `attached`, and `repaired` as connected states; select explicitly for `needs-selection`; stop on `conflict`. Read the returned `boundary` and run `rdl git boundary --project <key> --json`; do not continue while it reports violations.
2. For a new project, select a profile with guided setup or `--profile`. New projects always receive schemaVersion 2 `documentProfile`; never create an unconfigured project.
3. Before planning documents, run `rdl contract show --project <key> --json` and `rdl contract next --project <key> --json`. Read `catalog.granularity.typeResponsibilities` and `splitWhen` before choosing artifact boundaries. The CLI evaluator is authoritative; do not duplicate or reinterpret its rules in the skill.
4. Preserve every regular type (`PRD`, `REQ`, `ARC`, `SCR`, `MOD`, `API`, `ADR`, `TST`, `RUN`, `GLS`) in exactly one policy state. Preserve `enforcement`, every `rules.<TYPE>.after` AI context recommendation, and every disabled type's omission disposition.
5. Never create a disabled type. Treat `recommendedContext` and `missingRecommendedContext` from `rdl contract next` as authoring guidance, not as a creation or persistence gate. A present type is not proof that its subject area is complete; never satisfy the contract by creating one catch-all document per type.
6. In a Rundol-governed project, never create or use a generic `DESIGN.md` as a canonical source of truth. Route product and quality intent to `REQ`, UI flows and states to `SCR`, system structure to `ARC`, important decisions to `ADR`, and implementation work to `rdl task add`. If one of those types is disabled, follow its configured omission target and sections instead of creating `DESIGN.md`.
7. When a type is disabled, write its required omission sections into the configured `absorbedBy` document, or preserve an explicit not-applicable reason. Never treat omission as silent deletion.
8. Contract changes are explicit revisioned operations. Inspect `rdl contract plan` impact before `rdl contract set` or Board settings changes; do not delete or move existing documents as a side effect.
9. Read `references/governance-contract.md` before creating or revising project documents. Read `references/client-compatibility.md` only when installing or adapting the skill for another AI client.
10. Preserve the project charter's mission, goals, scope, roles, members, stakeholders, RACI, decisions, risks, cadence, and Definition of Done. Unknown information remains `미정` with an owner and follow-up task.
11. Use real Obsidian file names and block IDs for owners, reviewers, stakeholders, related artifacts, and task responsibility.
12. Before creating a document, enumerate candidate responsibilities and split them when owner or approver, acceptance criteria, lifecycle or review cadence, or primary consumers differ. Keep one primary responsibility per artifact; summaries link to narrower artifacts instead of duplicating their normative content.
13. Create documents only through `rdl doc create <TYPE> <title> --owner <MEMBER-ID> --scope <single-review-unit> --exclude <adjacent-out-of-scope>`, repeating `--exclude` when useful and adding required `--related` artifacts. The CLI-authored `bounded-v1` metadata is mandatory for new canonical documents. Use canonical paths and review `rdl doc migrate` before applying a legacy move.
14. Use `rdl task add`, `rdl task acceptance`, and the Board for tasks. Route only the 2–4 most relevant documents into an AI coding context.
15. Run `rdl check <ARTIFACT-ID> --strict` immediately after authoring, then `rdl contract check --project <key>` and `rdl check --strict`. Advisory findings guide the work; checkpoint violations block save, sync, and completion.
16. Run `rdl check --structure`; treat an existing `DESIGN.md` as a manual migration candidate and never delete it automatically. Apply cleanup only after reviewing every candidate.
17. Keep branch roles strict: application code belongs to the repository root's primary code branch, project documents and tasks belong only to `rundol/<project-key>` through its linked worktree, and registries, clients, leases, and Workspace presentation belong only to `rundol/workspace`. Never edit another role's files from the current worktree.
18. Use `rdl save` and `rdl sync` for Rundol branches. Never redirect a local ref to a differently named remote ref, bypass the managed `pre-push` hook, or use force push. Run `rdl git boundary --json` again before the final sync.

One person may hold multiple roles, but roles, members, stakeholders, responsibilities, and decision boundaries remain explicit.
