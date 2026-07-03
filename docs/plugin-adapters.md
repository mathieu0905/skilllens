# Codex And Claude Code Adapter Plan

SkillScope should support Codex and Claude Code without forking the analyzer.
The stable boundary is a plugin-emitted capture bundle plus the normalized
analysis schema:

- `CaptureBundle` from the product integration
- `SkillUnit[]` from `SKILL.md`, rules, memories, or playbooks
- `TraceEvent[]` from any agent trajectory source
- `CoverageFinding[]` from the analyzer

## Codex

Expected captured inputs:

- loaded `SKILL.md` or Codex skill/rules text
- JSONL session export with assistant messages, `functions.exec_command`, `functions.apply_patch`, and final answer events
- Optional task prompt and result metadata

Adapter behavior:

- Let users start capture from Codex with `/skillscope`.
- Install `/skillscope` as a Codex custom prompt, not as an unsupported plugin manifest field.
- Resolve the active trace from `~/.codex/sessions/**/rollout-*.jsonl`, preferring `session_meta.payload.cwd === project cwd`.
- Treat skill files found in assistant tool calls as trace-proven loaded skills.
- Map `tool_calls[].name` and `tool_calls[].arguments` into `TraceEvent.name` and `TraceEvent.content`
- Classify `exec_command` as `command`
- Classify `apply_patch` as `file_edit`
- Preserve raw JSON on every event

## Claude Code

Expected captured inputs:

- loaded `SKILL.md` or project instructions
- Claude Code JSONL entries with `message.content[]`
- Optional result metadata

Adapter behavior:

- Map `content[].type === "text"` into assistant/user messages
- Map `content[].type === "tool_use"` into tool calls
- Map `content[].type === "tool_result"` into tool outputs
- Classify common tools such as `Bash`, `Edit`, `MultiEdit`, and `Write`
- Preserve raw JSON on every event

## Shared Wrapper Contract

The current CLI exposes:

```bash
npm run analyze -- \
  --bundle skillscope.capture.json \
  --out report/
```

Both Codex and Claude Code wrappers should write the same capture-bundle shape
and call this command instead of duplicating parsing or coverage logic.
