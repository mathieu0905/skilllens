---
name: skillscope
description: Launch SkillScope from Codex, capture the active Codex session trace plus loaded skill/rule files, and open the browser coverage viewer.
---

# SkillScope For Codex

Use this skill when the user asks to run `/skillscope`, capture Codex skill coverage, inspect which skill instructions were followed, or open the SkillScope browser view for the current Codex session.

## User Entry

The user entry is the Codex slash prompt:

```bash
/skillscope
```

That slash prompt should call the repository launcher:

```bash
npm --prefix <skillscope-repo> run codex -- --project-cwd "$(pwd)"
```

## Capture Contract

- Identify the Codex rollout JSONL for the active or requested session.
- Prefer the session whose `session_meta.payload.cwd` matches the current project.
- Identify `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, or `*.skill.md` files that the trace proves were read or used.
- If no loaded skill can be proven from tool traces, fall back to project skill discovery and mark those files as discovered rather than confirmed loaded.
- Preserve task prompt, result metadata, model, cwd, agent version, session ID, and inferred session segments when available.
- Generate a `skillscope.capture.json` bundle before running analysis.
- Run SkillScope analysis with the generated bundle, not with separately guessed skill and trace files.
- Open the browser viewer after capture unless `SKILLSCOPE_NO_OPEN=1` or `--no-open` is set.

## Commands For Codex To Run

From any user project, the slash prompt should run:

```bash
npm --prefix <skillscope-repo> run codex -- --project-cwd "$(pwd)"
```

If the active session cannot be inferred, ask for an explicit trace path and run:

```bash
npm --prefix <skillscope-repo> run codex -- \
  --project-cwd "$(pwd)" \
  --trace <codex-rollout.jsonl>
```

Optional precise inputs:

```bash
npm --prefix <skillscope-repo> run codex -- \
  --project-cwd "$(pwd)" \
  --trace <codex-rollout.jsonl> \
  --skill <path-to-SKILL.md> \
  --task <optional-task.md> \
  --result <optional-result.json>
```

## Analysis Boundary

- The current default analyzer is heuristic: constraint extraction, trace normalization, keyword overlap, and structured tool signals.
- Do not describe heuristic findings as AI judgment.
- The launcher is responsible for provenance: which session and which skill artifacts are being compared.
- The browser "启动分析" action can run an agent-native judge after the user selects a skill-use window.
- Agent judge runs must follow `skills/skillscope-analyzer/SKILL.md`: judge only the provided local artifacts and cite concrete trace event IDs.
- Do not call a separate model API for SkillScope judge. Codex captures should use Codex; Claude Code captures should use Claude Code.
