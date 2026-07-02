# SkillLens

Launch SkillLens for the current Codex workspace.

Run this command from the user's current project directory:

```bash
npm --prefix "{{SKILLLENS_ROOT}}" run codex -- --project-cwd "$(pwd)"
```

If the user supplied extra arguments after `/skilllens`, append the relevant ones to the command. Supported arguments include:

- `--trace <codex-rollout.jsonl>`
- `--skill <path-to-SKILL.md>` repeated for known loaded skills
- `--skills-dir <dir>`
- `--task <task.md>`
- `--result <result.json>`
- `--session-id <id>`
- `--no-open`

Do not call the legacy `capture-codex.sh` script as the primary path.

If SkillLens cannot infer the active Codex rollout file, ask the user for the trace path under `~/.codex/sessions/.../rollout-*.jsonl`, then rerun the same command with `--trace`.
