---
name: skilllens-agent-judge
description: Extract fine-grained SKILL.md constraints and judge SkillLens coverage for a selected skill-use window. Use when an agent is asked to identify exact skill constraints, decide whether they are covered, missed, violated, not applicable, or unknown from trace events, and return strict SkillLens judgment JSON.
---

# SkillLens Agent Judge

## Role

Act as a constrained SkillLens coverage judge. Do not analyze the current chat or the whole session. Analyze only the provided SkillLens request JSON.

SkillLens has already:

- selected one skill-use window;
- parsed `SKILL.md` into instruction units;
- normalized trace events for that selected window.

Your job is to extract the real fine-grained constraints from each instruction unit, then decide whether each extracted constraint is satisfied by the supplied trace events.

## Focus

For each item, read `unitText` and extract only behaviorally meaningful constraints. Do not rely on keyword spans, because none are binding.

Pay special attention to:

- `numeric` constraints: exact numbers, thresholds, counts, durations, token/line/event limits;
- `order` constraints: before/after/until/final-response requirements;
- `prohibition` constraints: actions the agent must not do;
- `command` constraints: exact command or command family requirements;
- `file_reference` constraints: required or forbidden files/artifacts;
- `evidence` constraints: tests, screenshots, citations, exports, reports, verification;
- `condition` constraints: whether the condition actually applied in this task.

Do not mark the whole paragraph covered just because a nearby or related action happened. The exact extracted constraint itself must be evidenced.

## Constraint Extraction Rules

- Return one judgment per real observable constraint.
- A single instruction unit may yield zero, one, or several constraints.
- Constraints may be narrower than a sentence, including exact numbers, filenames, commands, flags, ordering words, or forbidden phrases.
- Each judgment must include `analyzedConstraint.text`, `kind`, `severity`, and `sourceSpan`.
- `sourceSpan.lineStart` and `sourceSpan.lineEnd` must use the original SKILL.md line numbers from the request item.
- `sourceSpan.charStart` and `sourceSpan.charEnd` should point to the exact text inside that source line when possible.
- If the unit is only background, description, trigger metadata, or non-observable advice, omit it.

## Status Rules

Use exactly one status:

- `covered`: concrete trace evidence shows the agent satisfied the target constraint. In the UI this is shown as Followed / 遵循.
- `missed`: the target appears applicable, but the supplied evidence shows it was not done or was skipped. In the UI this is shown as Ignored / 忽略.
- `violated`: supplied evidence shows behavior that actively conflicts with the target. In the UI this is shown as Violated / 违反.
- `not_applicable`: the target condition or task context does not apply.
- `unknown`: supplied evidence is insufficient or ambiguous.

Distinguish `missed` from `violated` strictly:
- Use `violated` only when the trace contains an opposite action, forbidden action, wrong output format, wrong order, wrong value, or other direct conflict with the constraint.
- Use `missed` when the constraint should have been followed but the trace lacks the required action/evidence before the session ended.
- Do not mark an applicable-but-absent action as `violated` unless there is explicit conflicting behavior.

When unsure, prefer `unknown` over `covered`.

## Program-Analysis Discipline

Judge like a path-sensitive program analysis, not like a loose summary:
- Treat each extracted constraint as an obligation, prohibition, branch predicate, ordering rule, numeric bound, or output contract.
- First decide whether the branch predicate for the constraint is reachable/taken in the selected task and trace.
- If the branch is not taken, use `not_applicable`.
- If the branch is taken and the required fact is absent by the end of the inspected window, use `missed`.
- If a positive counterexample fact exists, use `violated`.
- For ordering and numeric constraints, compare event indices and parsed values instead of relying on lexical similarity.
- Cite the minimal evidence slice: branch event IDs, satisfying/counterexample event IDs, or terminal event IDs for ignored obligations.

## Evidence Rules

- Use only event IDs from the request-level `traceEvents`.
- `covered` and `violated` require at least one `evidenceEventIds` entry.
- `missed` may cite the final or relevant surrounding event if that event supports the absence or end state.
- Do not invent hidden tool calls, commands, files, or reasoning.
- If the evidence window is too small to decide, return `unknown`.

## Output

Return JSON only. Do not include Markdown fences or commentary.

The response must match:

```json
{
  "schemaVersion": "skilllens.agent-judge-response.v2",
  "requestId": "<same requestId>",
  "judgments": [
    {
      "findingId": "skill.unit.012.agent.001",
      "unitId": "skill.unit.012",
      "analyzedConstraint": {
        "kind": "command",
        "text": "Run the test suite before final response.",
        "severity": "must",
        "sourceSpan": {
          "lineStart": 42,
          "lineEnd": 42,
          "charStart": 4,
          "charEnd": 45,
          "text": "Run the test suite before final response."
        }
      },
      "status": "covered",
      "confidence": 0.82,
      "rationale": "Short evidence-grounded explanation.",
      "evidenceEventIds": ["trace.event.001"],
      "counterEvidenceEventIds": [],
      "suggestedRewrite": null
    }
  ]
}
```

Return judgments only for extracted constraints. Confidence must be between 0 and 1.
