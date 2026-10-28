# AI project template

A small, framework-neutral starter for projects built with Claude Code and Codex.

## Start a project

1. Click **[Use this template](https://github.com/lusparkl/ai-project-template/generate)** and create a new repository.
2. Clone the new repository and open it in your coding agent.
3. Describe what you want to build. For example:

   > Read AGENTS.md. Build [describe the project]. Replace its placeholders with verified architecture and development commands as you establish them. Follow the project conventions and run relevant checks.

No initialization script is required. Choose the framework and dependencies for each project rather than inheriting a fixed stack.

You can also create a project with the GitHub CLI:

```bash
gh repo create my-project --template lusparkl/ai-project-template --private --clone
```

## Keep context across sessions

The context skills installed globally on your machine work in every repository created from this template:

| Action | Claude Code | Codex |
| --- | --- | --- |
| Save a milestone | `/save-context` | `$save-context` |
| Resume work | `/resume-project` | `$resume-project` |

Saving creates or updates `docs/AI_HANDOFF.md` from the actual project state. Resume can include a concrete task, such as `$resume-project Implement the next action`.

The repository intentionally starts without a populated handoff. `docs/AI_HANDOFF.template.md` describes its format; it is not evidence of implemented work. Keep stable instructions in `AGENTS.md`, changing state in the handoff, and product setup information in this README. Replace this README as the project develops.

## Included files

- `AGENTS.md`: shared instructions and placeholders for verified architecture/commands.
- `CLAUDE.md`: imports `@AGENTS.md`, avoiding duplicated instructions.
- `docs/AI_HANDOFF.template.md`: the shared context format.
- `.gitignore`: common local secrets, dependencies, and agent-local settings.

Model preferences, Caveman hooks, authentication, integrations, and context skills remain global machine configuration. GitHub templates do not install those tools on another machine. On another machine, configure the agents and skills separately; never copy credentials into this repository.
