# SkillScope

Capture the current Claude Code run for SkillScope skill coverage analysis, then open the SkillScope browser UI.

## Use When

- The user asks whether a `SKILL.md`, rule, or instruction file was actually followed.
- The user wants a SkillScope report for a Claude Code session.
- The user wants to compare with-skill vs no-skill or success vs failure trajectories.

## Required Inputs

Ask for missing paths instead of guessing:

- Claude Code session trace JSONL/JSON.
- Loaded `SKILL.md`, `CLAUDE.md`, project rule, memory, or playbook file paths.
- Optional task prompt file or result JSON.

## Command

From the SkillScope repository root:

```bash
npm run capture -- \
  --agent claude_code \
  --trace <claude-session.jsonl> \
  --skill <path-to-SKILL.md> \
  --task <optional-task.md> \
  --result <optional-result.json> \
  --out skillscope.capture.json
```

Then analyze:

```bash
npm run analyze -- --bundle skillscope.capture.json --out skillscope-report
```

If this command file is used from the SkillScope checkout, use the shared capture CLI directly:

```bash
npm run capture -- \
  --agent claude_code \
  --trace <claude-session.jsonl> \
  --skill <path-to-SKILL.md> \
  --out skillscope.capture.json
```

Then run `npm run open` to launch the browser UI if it is not already open.

## Boundaries

- Do not claim AI-based analysis unless an LLM judge pass was explicitly configured.
- The default analyzer is heuristic and local.
- Confirm loaded skill paths whenever possible; discovered files are weaker provenance.
