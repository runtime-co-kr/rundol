---
name: rundol-project-governance
description: Preserve mandatory Rundol project metadata, mission, scope, roles, members, stakeholders, responsibility, decisions, risks, collaboration cadence, and quality gates. Use when a Git repository has remote rundol/workspace or rundol/* branches, when projects/<project-key> is a Rundol Vault, or when creating, simplifying, editing, reviewing, or validating Rundol documents and tasks.
---

# Rundol Project Governance

Treat lightweight delivery as an implementation choice, never as permission to remove governance.

## Workflow

1. Run `rdl attach [project-key] --json` when the project Vault is not mounted. Let the CLI inspect Git remotes, load `rundol/workspace`, and mount `rundol/<project-key>` at `projects/<project-key>`. Product branches never own `.rundol`; a project Vault may contain Git-ignored `.rundol/state` and `.rundol/logs` created by the CLI.
2. Before a standard operation, run `rdl action resolve <ACTION> --json`. Use the returned CLI command when the executor is `cli`; combine content work with CLI validation for `hybrid`; use the LLM directly only for `llm` or a recorded fallback.
3. After an LLM or hybrid operation, run `rdl action record <ACTION> --actual-executor <llm|hybrid>` with related artifact/task IDs. Include `--fallback-reason` when departing from the recommendation. CLI document and task commands record their own action events in debug mode.
4. Read `references/governance-contract.md` before creating or revising project documents. Read `references/client-compatibility.md` only when installing or adapting the skill for another AI client.
5. Select `projects/<project-key>` as the Obsidian Vault, inspect its `project.md`, and preserve every required section and entity block.
6. Derive roles, members, stakeholders, decision rights, risks, and review cadence from the actual project context.
7. When information is unknown, keep the field and write `미정`, the person or role responsible for resolving it, and a follow-up task. Never delete the field to make a project look simpler.
8. Link owners, reviewers, stakeholders, related artifacts, and task responsibility within the selected project using actual Obsidian file names and block IDs.
9. Prefer `rdl doc create <TYPE> <title> --owner <MEMBER-ID> --related <ARTIFACT-ID>` for new standard documents. Never bypass its registered-member, physical-path, type, tag, or relationship checks by creating a reduced ad-hoc Markdown file.
10. Use `rdl task add`, `rdl task acceptance`, or the Board for tasks so assignments and completion resolve through the project contract. Treat the user runtime's `index/**` as derived local data, never as the Git source of truth.
11. Run `rdl check --strict` from the workspace. Resolve all governance, metadata, and link diagnostics before declaring the work complete.
12. Run `rdl check --structure`; use `rdl cleanup` for dry-run output and `rdl cleanup --apply` only after reviewing every removal candidate.

Do not collapse roles, members, and stakeholders into one unlabeled person even for a solo project. One person may hold multiple roles, but each responsibility and decision boundary remains explicit.
