---
name: rundol-project-governance
description: Preserve mandatory Rundol project metadata, mission, scope, roles, members, stakeholders, responsibility, decisions, risks, collaboration cadence, and quality gates. Use when a Git repository has remote rundol/workspace or rundol/* branches, when projects/<project-key> is a Rundol Vault, or when creating, simplifying, editing, reviewing, or validating Rundol documents and tasks.
---

# Rundol Project Governance

Treat lightweight delivery as an implementation choice, never as permission to remove governance.

## Workflow

1. Run `rdl init --json` first. Treat its `action` as the source of truth: continue for `already-connected`, `attached`, or `repaired`; present `projects` and rerun with `--project` for `needs-selection`; stop and explain `conflict`. Use `rdl attach [project-key] --json` only as the lower-level explicit connection command.
2. For a new project, interview the user about delivery scale and risk before selecting a document profile. Use `rdl init <project-key> --name <name> --guided` in an interactive terminal, or provide `--profile <lean|product|service|platform|assured>` in automation. Never prompt with `--json` or in a non-interactive terminal.
3. Preserve the exact `documentProfile` schema written in `project.md`. The ten regular types (`PRD`, `REQ`, `ARC`, `SCR`, `MOD`, `API`, `ADR`, `TST`, `RUN`, `GLS`) must each appear in exactly one of `required`, `recommended`, `onDemand`, or `disabled`. Selecting a profile never creates empty documents.
4. Before a standard operation, run `rdl action resolve <ACTION> --json`. Use the returned CLI command when the executor is `cli`; combine content work with CLI validation for `hybrid`; use the LLM directly only for `llm` or a recorded fallback.
5. After an LLM or hybrid operation, run `rdl action record <ACTION> --actual-executor <llm|hybrid>` with related artifact/task IDs. Include `--fallback-reason` when departing from the recommendation. CLI document and task commands record their own action events in debug mode.
6. Read `references/governance-contract.md` before creating or revising project documents. Read `references/client-compatibility.md` only when installing or adapting the skill for another AI client.
7. Select `projects/<project-key>` as the Obsidian Vault, inspect its `project.md`, and preserve every required section and entity block.
8. Derive roles, members, stakeholders, decision rights, risks, and review cadence from the actual project context.
9. When information is unknown, keep the field and write `미정`, the person or role responsible for resolving it, and a follow-up task. Never delete the field to make a project look simpler.
10. Link owners, reviewers, stakeholders, related artifacts, and task responsibility within the selected project using actual Obsidian file names and block IDs.
11. Prefer `rdl doc create <TYPE> <title> --owner <MEMBER-ID> --related <ARTIFACT-ID>` for new standard documents. New documents use canonical type directories under `docs/`; run `rdl doc migrate` first and use `rdl doc migrate --apply` only after reviewing a legacy-path plan. For each coding task, route only the 2–5 most relevant PRD/REQ/ARC/API/MOD/TST/RUN documents into context; do not load the complete document set by default.
12. Use `rdl task add`, `rdl task acceptance`, or the Board for tasks so assignments and completion resolve through the project contract. Treat the user runtime's `index/**` as derived local data, never as the Git source of truth.
13. Run `rdl check --strict` from the workspace. Resolve all governance, metadata, profile-policy, and link diagnostics before declaring the work complete.
14. Run `rdl check --structure`; use `rdl cleanup` for dry-run output and `rdl cleanup --apply` only after reviewing every removal candidate.

Do not collapse roles, members, and stakeholders into one unlabeled person even for a solo project. One person may hold multiple roles, but each responsibility and decision boundary remains explicit.
