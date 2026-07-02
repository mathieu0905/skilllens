---
name: skillscope-analyzer
description: Analyze one selected SkillScope skill-use window by extracting precise constraints from SKILL.md, inspecting Codex or Claude Code trace evidence in stages, writing early UI highlight artifacts, and producing an evidence-backed coverage report. Use when SkillScope launches Codex or Claude Code from the browser after a user clicks Start Analysis for a selected skill use.
---

# SkillScope Analyzer

## Purpose

Analyze the selected skill-use window only. Do not analyze the current chat or the whole machine history unless an input file explicitly points to it.

SkillScope provides file paths for the selected skill, normalized skill units, normalized trace events, raw trace text, and output artifacts. Follow those files, not assumptions.

## Required Workflow

1. Read all paths named in the launch prompt.
2. Read the selected `SKILL.md` and the normalized skill units.
3. Compile the skill into analysis IR: constraints, condition predicates, obligations, prohibitions, ordering rules, and output contracts.
4. Start from `constraint-seed.json` when present; review and refine it instead of re-deriving every line from scratch.
5. Write or update `constraints.json` as soon as the constraint review is complete.
6. Write or update `skill-graph.json` after extracting constraints and before judging the full trace.
7. Compile the trace into `trace-facts.json`: event facts, artifact facts, ordering facts, and final-output facts.
8. Run path-sensitive coverage over the skill graph using the trace facts.
9. Update graph branch/path state after trace inspection.
10. Append concise progress notes to `progress.md` after each meaningful stage.
11. Write `findings.json` when you have coverage judgments worth surfacing.
12. Finish with a human-readable report citing evidence event IDs.

## Program Analysis Model

Treat the selected `SKILL.md` as a small specification program and the selected trajectory as one execution trace of that program.

Use this compiler-style analysis pipeline:

1. **Skill front-end**
   - Parse Markdown headings as modules / basic blocks.
   - Parse bullets, numbered items, tables, examples, and output schemas into fine-grained constraints.
   - Classify constraints into `condition`, `obligation`, `prohibition`, `ordering`, `numeric_bound`, `command_contract`, `file_contract`, `evidence_requirement`, and `final_output_contract`.
   - Keep precise source spans. If one sentence contains two obligations or an obligation plus a condition, split it.

2. **Skill CFG / control dependence**
   - Build a graph where headings contain constraints and conditions guard downstream obligations.
   - Model "if/when/for X/unless/only when/before/after" as branch predicates.
   - A condition may dominate multiple obligations. If the condition is not taken, dominated obligations should usually become `not_applicable`, not `missed`.
   - A condition that is taken but whose dominated obligations are absent should create `missed` findings for those obligations.

3. **Trace fact extraction**
   - Compile `trace-events.json` into facts before making judgments.
   - Facts should be structural, not just keywords: commands executed, tools called, files read, files edited, paths mentioned, final JSON fields, output shape, user interruption boundaries, event ranges inspected, and discovered candidate artifacts.
   - Write these facts to `trace-facts.json` so the UI and developer can inspect the intermediate representation.

4. **Path-sensitive coverage**
   - Evaluate branch predicates against task context and trace facts.
   - Mark graph branch state as `taken`, `not_taken`, `checked`, or `unknown`.
   - For each reachable obligation, look for satisfying facts after the branch was taken and before the skill-use window ended.
   - For prohibitions, look for counterexample facts.
   - For ordering rules, compare event indices, not text similarity.
   - For numeric/output contracts, parse values where possible and compare exact counts/fields.

5. **Evidence slicing**
   - Each finding should cite a minimal slice: branch evidence, satisfying evidence or counterexample evidence, and terminal/final evidence for ignored obligations.
   - `covered` and `violated` need direct evidence event IDs.
   - `missed` should cite the inspected range or terminal event when the absence is established.
   - If reachability or facts are incomplete, use `unknown`.

This means the analysis is not "read everything and summarize." It is closer to:

```text
skill source -> constraint IR -> skill CFG
trace events -> trace facts -> observed path
CFG x facts -> followed / violated / ignored / not-taken / unknown
```

Prefer deterministic structural checks whenever facts make them possible. Use reasoning to design and apply the checks, not to replace the checks with vague impressions.

## Constraint Extraction

Extract constraints from the skill, not from keywords alone. If SkillScope provides `constraint-seed.json`, treat it as a draft span index generated from the selected skill. Keep good seed entries, split or merge imprecise entries, and add missing constraints that matter for trace checking.

The extraction must be coverage-oriented, not summary-oriented. For a long skill, do not select only the most interesting constraints. Build a complete check plan for the selected skill-use window:
- Include every mandatory, prohibited, recommended, ordering, validation, evidence, tool/command, file/path, numeric, and final-response constraint that is observable in the trace.
- Include conditional rules when their trigger can be checked against the task or trace, even if the final status may become `not_applicable` or `unknown`.
- Keep examples only when they define an exact required pattern, forbidden pattern, numeric bound, command template, output shape, or file category.
- Drop only purely explanatory prose, duplicate restatements, trigger text for using the skill, and text that cannot affect behavior in the selected window.
- If you merge seed entries, merge only true duplicates and preserve the narrowest useful source span.
- If you exclude many seed entries, record the exclusion reason and count in `progress.md`.

As a practical floor: after reading `constraint-seed.json`, `constraints.json` should usually retain most non-info seed entries. A result with only a few dozen constraints for a long, rule-heavy skill is suspicious unless the skill is mostly examples or prose. When unsure, keep the constraint and let the coverage status become `unknown` rather than dropping it.

Prefer precise constraints over sentence-level labels:
- Mandatory actions.
- Prohibited actions.
- Ordering rules.
- Required commands, tools, files, paths, arguments, or flags.
- Numeric thresholds and exact counts.
- Conditions such as "when X happens, do Y".
- Evidence requirements, validation requirements, and final-response requirements.

Mark vague, subjective, or unobservable text as low-confidence or unknown rather than forcing a judgment.

For UI highlighting, each constraint in `constraints.json` should include:
- `unitId`: the normalized unit ID from the input.
- `text`: the exact constraint phrase or the smallest meaningful span.
- `kind`: a short category such as `action`, `prohibition`, `order`, `numeric`, `command`, `file_reference`, `evidence`, `condition`, or `other`.
- `severity`: `must`, `should`, `must_not`, `may`, or `info`.
- `sourceSpan`: line and character span in the selected skill when available.
- `rationale`: why this should be checked.

This file is a working artifact for UI highlighting, not the final answer. Write it early even if later judgments are still unknown.

## Skill Graph

Build a graph representation of the selected skill before doing full coverage judgment. The graph should expose structure that is hard to see in flat highlighting:
- Section/root nodes for major Markdown headings.
- Constraint/action/prohibition/order/numeric/command/evidence nodes for extracted constraints.
- Condition nodes for trigger-dependent rules, language-specific branches, task-shape branches, and "when X, do Y" logic.
- Edges for containment and control flow. Use `contains`, `then`, `else`, `condition_true`, `condition_false`, `requires`, or `related`.
- A trace path showing which graph nodes the selected trace actually followed.
- Skipped branches for conditions that did not trigger, instead of mixing them into the main highlighter as noisy failures.

Write `skill-graph.json` with this shape:

```json
{
  "schemaVersion": "skilllens.skill-graph.v1",
  "requestId": "same request id when known",
  "nodes": [
    {
      "id": "graph.node.001",
      "unitId": "skill.unit.12",
      "constraintId": "optional constraint id",
      "parentId": "graph.node.parent",
      "kind": "condition",
      "label": "Language branch",
      "text": "If the changed code is JavaScript or TypeScript, inspect JS/TS sibling modules.",
      "predicate": "changed code is JavaScript or TypeScript",
      "sourceSpan": { "lineStart": 42, "lineEnd": 42, "charStart": 2, "charEnd": 91, "text": "..." },
      "branchState": "taken",
      "status": "covered",
      "confidence": 0.74,
      "evidenceEventIds": ["trace.event.25"],
      "rationale": "The trace selected a TypeScript file, so this branch was active."
    }
  ],
  "edges": [
    { "id": "graph.edge.001", "from": "graph.node.parent", "to": "graph.node.001", "kind": "condition_true", "taken": true }
  ],
  "paths": [
    { "id": "trace.path.main", "title": "Observed trace path", "nodeIds": ["graph.node.001"], "eventIds": ["trace.event.25"] }
  ]
}
```

Use `branchState` values:
- `taken`: the trace entered this condition/branch.
- `not_taken`: the condition did not trigger for this selected window.
- `checked`: the node was inspected but is not a conditional branch.
- `unknown`: the trace was insufficient to know whether the branch applied.

The graph is a working artifact. Update it as trace evidence changes. Do not wait until the final answer if you already know the skill structure.

## Trace Facts

Write `trace-facts.json` after reading the normalized trace and before final judgment. It is the trajectory IR used by the analysis.

Use this shape when possible:

```json
{
  "schemaVersion": "skilllens.trace-facts.v1",
  "facts": [
    {
      "id": "fact.001",
      "kind": "command_executed",
      "eventIds": ["trace.event.12"],
      "subject": "rg --files packages/jest-config",
      "attributes": { "tool": "exec_command", "cwd": "/repo" },
      "confidence": 0.99
    }
  ],
  "indexes": {
    "commands": ["rg --files packages/jest-config"],
    "filesRead": ["packages/jest-config/src/ValidConfig.ts"],
    "filesEdited": [],
    "toolsCalled": ["exec_command"],
    "finalOutputShape": "json_object_with_functions_array",
    "inspectedEventRanges": ["trace.event.1-trace.event.263"]
  }
}
```

Useful fact kinds include:
- `command_executed`
- `tool_called`
- `file_read`
- `file_edited`
- `file_mentioned`
- `search_result_seen`
- `candidate_discovered`
- `final_answer_emitted`
- `final_output_field`
- `output_shape`
- `ordering_relation`
- `human_intervention`
- `session_boundary`
- `absence_checked`

For ignored obligations, an `absence_checked` fact is valuable: it records which event range was inspected and which required signal was absent. Do not use absence facts for `violated`; violations require a positive conflicting fact.

## Trace Inspection

Inspect the selected trace window as an agent behavior record.

Use normalized event IDs when citing evidence. Check both content and structure:
- Assistant messages and final answer.
- Tool calls and tool outputs.
- Shell commands.
- File edits and mentioned files.
- User interruptions or new requests that end a skill-use window.
- Missing evidence where the skill required observable behavior.

For long traces, chunk the trace by event ranges or task phases. Do not stop after the first matching event. Revisit constraints that require ordering, exact numbers, or negative evidence.

When a constraint is satisfied only by inference, lower confidence and explain the inference. For `covered` and `violated`, cite evidence event IDs whenever possible. If there is no direct evidence, prefer `unknown`.

Use three primary judgment categories for applicable constraints:
- `covered` = followed / 遵循: the trace contains concrete evidence that the agent did what the constraint required.
- `violated` = violated / 违反: the trace contains an active conflict with the constraint, such as a forbidden command, wrong output format, wrong order, wrong value, or opposite behavior.
- `missed` = ignored / 忽略: the constraint applied, but the trace never shows the required action before the selected skill-use window ended.

Do not collapse ignored into violated. Absence of a required action is `missed`; explicit contradictory behavior is `violated`.

## Findings

When writing `findings.json`, keep it easy for SkillScope to parse. Use either:
- An array of finding-like objects, or
- An object with `findings` or `judgments`.

Each useful finding should include:
- `unitId`
- `status`: `covered`, `missed`, `violated`, `not_applicable`, or `unknown`
- `confidence`
- `rationale`
- `evidenceEventIds`
- `counterEvidenceEventIds` when relevant
- `suggestedRewrite` when the skill text caused ambiguity
- `analyzedConstraint` with `text`, `kind`, `severity`, and `sourceSpan` or `span`

Write a finding for every extracted constraint in `constraints.json`. If you did not inspect enough evidence for a constraint, write it as `unknown` with a rationale naming the uninspected or unobservable part. Do not silently omit lower-priority constraints after extraction.

Do not invent evidence IDs. If a status depends on absence of behavior, explain which trace range was inspected.

## Progress Output

Use `progress.md` for live UI updates. Append short notes after stages such as:
- skill IR compiled
- constraints extracted
- skill graph generated
- trace facts extracted
- path-sensitive coverage checked
- trace chunk inspected
- ordering checked
- evidence consolidated
- final report prepared

Keep progress notes factual and compact. Include counts and event ranges when useful.

## Final Report

The final response may be Markdown. It should explain:
- What constraints were extracted.
- Which constraints were covered, missed, violated, not applicable, or unknown.
- Keep missed/ignored constraints separate from violated constraints.
- The strongest evidence event IDs.
- Important uncertainty.
- Skill rewrite suggestions backed by trace evidence.
