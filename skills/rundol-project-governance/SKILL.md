---
name: rundol-project-governance
description: Preserve Rundol project governance, document planning contracts, canonical documents, tasks, traceability, and quality gates. Use when a repository has Rundol workspace/project branches or when creating, editing, reviewing, or validating Rundol documents and tasks.
---

# Rundol Project Governance

Treat lightweight delivery as an implementation choice, never as permission to remove governance or silently bypass the document contract.

## Workflow

1. Run `rdl init --json` first. Treat `created`, `already-connected`, `attached`, and `repaired` as connected states; select explicitly for `needs-selection`; stop on `conflict`.
2. For a new project, select a profile with guided setup or `--profile`. New projects always receive schemaVersion 2 `documentProfile`; never create an unconfigured project.
3. Before planning documents, run `rdl contract show --project <key> --json` and `rdl contract next --project <key> --json`. The CLI evaluator is authoritative; do not duplicate or reinterpret its rules in the skill.
4. Preserve every regular type (`PRD`, `REQ`, `ARC`, `SCR`, `MOD`, `API`, `ADR`, `TST`, `RUN`, `GLS`) in exactly one policy state. Preserve `enforcement`, every `rules.<TYPE>.after`, and every disabled type's omission disposition.
5. Never create a disabled type. Never create a blocked type before its prerequisites. Create only a ready type with `rdl doc create`.
6. When a type is disabled, write its required omission sections into the configured `absorbedBy` document, or preserve an explicit not-applicable reason. Never treat omission as silent deletion.
7. Contract changes are explicit revisioned operations. Inspect `rdl contract plan` impact before `rdl contract set` or Board settings changes; do not delete or move existing documents as a side effect.
8. Read `references/governance-contract.md` before creating or revising project documents. Read `references/client-compatibility.md` only when installing or adapting the skill for another AI client.
9. Preserve the project charter's mission, goals, scope, roles, members, stakeholders, RACI, decisions, risks, cadence, and Definition of Done. Unknown information remains `미정` with an owner and follow-up task.
10. Use real Obsidian file names and block IDs for owners, reviewers, stakeholders, related artifacts, and task responsibility.
11. Prefer `rdl doc create <TYPE> <title> --owner <MEMBER-ID> --related <ARTIFACT-ID>`. Use canonical paths and review `rdl doc migrate` before applying a legacy move.
12. Use `rdl task add`, `rdl task acceptance`, and the Board for tasks. Route only the 2–4 most relevant documents into an AI coding context.
13. Run `rdl contract check --project <key>` and `rdl check --strict`. Advisory findings guide the work; checkpoint violations block save, sync, and completion.
14. Run `rdl check --structure`; apply cleanup only after reviewing every candidate.

One person may hold multiple roles, but roles, members, stakeholders, responsibilities, and decision boundaries remain explicit.
