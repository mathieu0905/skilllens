# Plugin-First Capture And Analysis

SkillLens should not depend on users manually finding the right `SKILL.md` and
trace file after a run. The reliable path is plugin-first:

1. A Codex or Claude Code integration runs inside the agent environment.
2. It records which skill/rule/memory files were loaded for the session.
3. It records the exact trace/session artifact produced by that run.
4. It writes a `skilllens.capture.json` bundle.
5. SkillLens analyzes the bundle and renders the source-level coverage view.

## Capture Bundle

The plugin should emit:

```json
{
  "schemaVersion": "skilllens.capture.v1",
  "source": "codex_plugin",
  "createdAt": "2026-07-02T00:00:00.000Z",
  "agent": {
    "product": "codex",
    "version": "unknown",
    "model": "unknown"
  },
  "task": {
    "id": "local-session",
    "prompt": "User task text",
    "cwd": "/repo"
  },
  "skills": [
    {
      "id": "skill-1",
      "kind": "skill",
      "path": "/repo/.codex/skills/pdf/SKILL.md",
      "title": "PDF Editing Skill",
      "content": "# PDF Editing Skill\n...",
      "loaded": true,
      "loadReason": "Matched active Codex skill"
    }
  ],
  "trace": {
    "id": "trace-1",
    "path": "/path/to/session.jsonl",
    "format": "codex",
    "content": "{\"role\":\"assistant\"...}",
    "sessionId": "session-id"
  },
  "result": {
    "success": true
  },
  "analysis": {
    "method": "hybrid"
  }
}
```

The analyzer already accepts this:

```bash
npm run analyze -- --bundle skilllens.capture.json --out report/
```

## Why Plugin Capture Matters

Manual import can show the UI, but it cannot reliably answer provenance:

- Which skills were actually loaded, rather than merely present on disk?
- Which trace belongs to the same session?
- Which task prompt caused the skill to activate?
- Did the agent use project rules, global memories, or a skill package?
- Did the run have with-skill/no-skill controls?

A plugin can capture these facts at the moment they are true. This is stronger
than scanning random local folders after the run.

## Analysis Levels

### Level 0: Provenance

This is not AI. It comes from the plugin bundle:

- loaded skill IDs and file paths
- trace session ID/path
- task prompt/cwd
- agent product/version/model

This level answers: "Which skill and trace should be compared?"

### Level 1: Heuristic Coverage

This is the current implementation:

- Markdown instruction splitting
- constraint extraction from each instruction
- trace event normalization
- keyword overlap
- structured signals such as test commands, file edits, screenshots, final answer
- simple violation patterns for `do not`, `never`, `avoid`, `must not`

This level is useful for fast local feedback, but it is not enough for final
claims.

Constraint extraction is intentionally more precise than sentence-level
coverage. A single instruction can produce several constraints:

- action constraints
- prohibitions
- order requirements
- numeric thresholds
- command snippets
- file/path references
- evidence or verification requirements
- conditions

Findings attach to constraint IDs and source spans, so the UI can highlight
`30 seconds`, `npm test`, `before final response`, or `do not overwrite` instead
of marking the whole sentence as a single block.

### Level 2: Agent-Native Judge

SkillLens does not need a separate model API for judgment. The browser button
starts the agent runner that matches the captured session:

- Codex captures are judged with `codex exec`.
- Claude Code captures are judged with `claude -p`.

The runner is guided by `skills/skilllens-agent-judge/SKILL.md`. That skill is
the judgment contract: it tells the agent to focus on one selected skill-use
window, one constraint at a time, and exact trace evidence event IDs.

The judge is still candidate-only:

1. Use retrieval and structured signals to find candidate event spans.
2. Ask the captured agent product only about one constraint plus a small evidence window.
3. Require JSON output with status, confidence, evidence event IDs, and rationale.
4. Forbid `covered` unless at least one concrete evidence event is cited.
5. Mark low-evidence cases as `unknown`, not covered.

This keeps cost low and avoids asking an LLM to read an entire trace blindly.

### Level 3: Human Override

The UI should keep manual status correction. Skill coverage is an audit tool;
the user must be able to mark a finding wrong and export the corrected report.

## Codex Integration Shape

The Codex plugin should be thin:

- expose a Codex slash prompt named `/skilllens`
- discover the active rollout JSONL under `~/.codex/sessions`
- discover active skill/rules files from trace-proven `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, or `*.skill.md` reads
- write `skilllens.capture.json`
- invoke `npm run analyze -- --bundle ...`
- open the local report or pass it to the SkillLens web app

It should not duplicate coverage logic.

Codex plugin manifests should not add unsupported `slashCommands` fields. The
slash-style entry is implemented through a custom prompt installed at
`~/.codex/prompts/skilllens.md`, which tells Codex to run the local launcher:

```bash
npm --prefix <SkillLens repo> run codex -- --project-cwd "$(pwd)"
```

## Claude Code Integration Shape

The Claude Code integration should follow the same contract:

- discover the loaded `SKILL.md`/project instructions for the run
- capture Claude Code JSONL message entries, including `tool_use` and `tool_result`
- write the same `skilllens.capture.json`
- call the shared analyzer

The only product-specific code should be capture and normalization adapters.

## Current State

Implemented:

- shared `CaptureBundle` type
- `npm run analyze -- --bundle ...`
- Codex `/skilllens` custom prompt template and local launcher
- Codex/Claude/ACP/generic trace normalization
- local heuristic coverage
- source-level `SKILL.md` highlighting with evidence hover
- browser-triggered agent-native judge path using `skills/skilllens-agent-judge/SKILL.md`

Not implemented yet:

- real Claude Code plugin/command capture hook
- durable background jobs/progress streaming for long agent judge runs
