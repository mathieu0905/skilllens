# SkillLens Capture

Capture the current Claude Code run for SkillLens skill coverage analysis.

## Use When

- The user asks whether a `SKILL.md`, rule, or instruction file was actually followed.
- The user wants a SkillLens report for a Claude Code session.
- The user wants to compare with-skill vs no-skill or success vs failure trajectories.

## Required Inputs

Ask for missing paths instead of guessing:

- Claude Code session trace JSONL/JSON.
- Loaded `SKILL.md`, `CLAUDE.md`, project rule, memory, or playbook file paths.
- Optional task prompt file or result JSON.

## Command

From the SkillLens repository root:

```bash
npm run capture -- \
  --agent claude_code \
  --trace <claude-session.jsonl> \
  --skill <path-to-SKILL.md> \
  --task <optional-task.md> \
  --result <optional-result.json> \
  --out skilllens.capture.json
```

Then analyze:

```bash
npm run analyze -- --bundle skilllens.capture.json --out skilllens-report
```

If this command file is used from the SkillLens checkout, the wrapper captures the bundle and opens the SkillLens browser UI:

```bash
integrations/claude-code/scripts/capture-claude-code.sh \
  --trace <claude-session.jsonl> \
  --skill <path-to-SKILL.md> \
  --out skilllens.capture.json
```

Set `SKILLLENS_NO_OPEN=1` to capture without opening the browser.

## Boundaries

- Do not claim AI-based analysis unless an LLM judge pass was explicitly configured.
- The default analyzer is heuristic and local.
- Confirm loaded skill paths whenever possible; discovered files are weaker provenance.
