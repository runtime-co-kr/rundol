# AI client compatibility

`SKILL.md` and its `references/` directory are the canonical, vendor-neutral Agent Skill. Do not maintain separate governance wording per client.

## Native Agent Skills clients

| Client | Personal location | Project location | Invocation |
|---|---|---|---|
| OpenAI Codex | `$CODEX_HOME/skills/rundol-project-governance/` or `~/.codex/skills/...` | Use the Codex-supported skill/plugin mechanism for the repository | `$rundol-project-governance` or automatic trigger |
| Claude Code | `$CLAUDE_CONFIG_DIR/skills/rundol-project-governance/` or `~/.claude/skills/...` | `.claude/skills/rundol-project-governance/` | `/rundol-project-governance` or automatic trigger |
| GitHub Copilot | `~/.copilot/skills/rundol-project-governance/` | `.github/skills/rundol-project-governance/` | Automatic relevance selection |

Rundol's global npm installer copies the same directory to the three personal locations. It never overwrites an existing skill unless that directory contains `.rundol-managed.json`.

Official references:

- Claude Code skills: <https://code.claude.com/docs/en/slash-commands>
- GitHub Copilot agent skills: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills>

## Instruction-file clients

Clients without native Agent Skills discovery can apply the contract through their repository instruction mechanism:

| Client or convention | Repository instruction file |
|---|---|
| Generic coding agents | `AGENTS.md` |
| Claude Code fallback | `CLAUDE.md` |
| Gemini CLI | `GEMINI.md` |
| GitHub Copilot instructions | `.github/copilot-instructions.md` or `.github/instructions/rundol.instructions.md` |
| Cursor | `.cursor/rules/rundol.mdc` |

Keep the adapter short. Point it to the canonical skill rather than copying and editing the governance contract. Use this minimum adapter text:

```markdown
When a Git repository uses `rundol/workspace` and `rundol/<project-key>` branches, apply the `rundol-project-governance` Agent Skill even when the product branch has no `.rundol` directory. Before editing Rundol project documents or tasks, read its `SKILL.md` and `references/governance-contract.md`. Run `rdl attach [project-key]`, resolve the selected project through `projects/project-<key>.yaml`, preserve every mandatory governance field and section in `projects/<key>/project.md`, and run `rdl check --project <key> --strict` before completion. Never simplify away metadata, roles, members, stakeholders, responsibility, decisions, risks, collaboration cadence, or quality gates.
```

For Gemini CLI, the repository `GEMINI.md` may import a vendored skill with `@./path/to/SKILL.md`. Cursor project rules use `.mdc` frontmatter with `alwaysApply: true` when the rule must apply to every request in a Rundol repository. GitHub Copilot can alternatively use an `AGENTS.md` at the repository root.

Official references:

- GitHub Copilot repository instructions: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions>
- Gemini CLI context files: <https://codelabs.developers.google.com/getting-started-gemini-cli-extensions>
- Cursor project rules: <https://docs.cursor.com/context/rules>

## Compatibility rules

- Preserve one canonical `SKILL.md`; client adapters only handle discovery.
- Keep relative links such as `references/governance-contract.md` unchanged when copying the skill directory.
- Copy the whole skill directory, not only `SKILL.md`.
- Treat `agents/openai.yaml` as Codex UI metadata; other clients may ignore it.
- Do not inject Rundol text into an existing global instruction file automatically. Merge adapters only with explicit user action.
