---
name: skillscope-optimizer
description: Optimize an agent skill from SkillScope analysis artifacts. Use when Codex or Claude Code is launched by SkillScope after coverage analysis, or when a workflow needs an evidence-backed SKILL.md revision based on constraints.json, skill-graph.json, trace-facts.json, findings.json, and the original SKILL.md.
---

# SkillScope Optimizer

## Purpose

Optimize one selected `SKILL.md` from SkillScope's program-analysis artifacts. Do not optimize from vibes, verifier logs alone, or a manual reading of the trace. The required chain is:

```text
skill source -> constraints + skill graph
trace events -> trace facts
graph x facts -> findings
findings -> minimal skill patch
```

## Required Inputs

Read every path named in the launch prompt. The optimizer must have:

- Original selected skill markdown.
- `constraints.json`.
- `skill-graph.json`.
- `trace-facts.json`.
- `findings.json`.
- Task/context and result/verifier artifacts when provided.
- Native verifier artifacts when provided.

If any IR artifact is missing, stop and report which artifact is missing. Do not replace missing IR with a blind full-trace analysis.

## Workflow

1. Read the original skill and all SkillScope IR artifacts.
2. Build an optimization packet:
   - Failed constraints: `violated` and `missed`, grouped by source span and graph branch.
   - Preserved constraints: nearby `covered` constraints that must not regress.
   - Branch context: whether each failure was on a taken path, a not-taken branch, or unknown reachability.
   - Evidence slices: event IDs and trace facts that prove each failure or absence.
3. Diagnose the failure type:
   - `underspecified-invariant`: the skill states a goal but not the invariant/check that prevents the observed violation.
   - `branch-ambiguity`: the skill has conditional paths but does not say which path dominates this task.
   - `ordering-gap`: the skill lacks a before/after relation needed to avoid the failure.
   - `missing-validation`: the skill lacks a concrete final check or parseable output contract.
   - `overconstrained-process`: native verifier or final artifacts pass, but findings are mostly `target: "process"` because the skill required an overly specific internal algorithm, ordering, or scoring procedure that the agent bypassed while still satisfying the intended output contract.
   - `overlong-or-duplicated`: the skill repeats intent without an executable check.
   - `unobservable`: the instruction cannot be verified from trace evidence.
4. Propose the smallest durable edit:
   - Prefer replacing, moving, merging, or deleting existing text before appending new text.
   - Add a new line only when it maps to a future trace fact, command, file artifact, event order, numeric bound, or output field.
   - Keep covered behavior intact.
5. Write the optimized skill and rationale artifacts.
6. Finish with a concise report that names the failure patterns, edited source spans, and expected future evidence.

## Output Artifacts

Write outputs only to paths specified by the launch prompt. Use these files when paths are provided:

- `optimized-skill.md`: a complete revised `SKILL.md` ready for rerun.
- `optimization-report.md`: rationale, grouped failures, and anti-bloat checks.
- `optimization-diff.md`: compact human-readable diff or patch summary.
- `optimization-packet.json`: machine-readable packet with failures, preserved constraints, and edits.

For each edit in `optimization-packet.json`, include an `editType` when possible:
- `strengthen_output_contract`
- `add_validation`
- `clarify_branch`
- `relax_process`
- `merge_duplicate`
- `delete_unobservable`
- `preserve`

Every edit entry must also include non-empty `change` text and either `constraintIdsAddressed` or `constraintIdsPreserved`. Do not leave these fields null; the UI and batch reports use them directly.

If the prompt provides only `optimized-skill.md`, include the rationale and diff as Markdown comments at the bottom only if a separate report path is not available.

## Revision Rules

Keep the optimized skill short and operational:

- Do not add historical or defensive phrases such as "do not use the old logic", "no legacy behavior", "never repeat the previous mistake", or "avoid the previous failure".
- Do not add generic quality language such as "be careful", "be thorough", "ensure correctness", or "double-check" unless it names a concrete check.
- Do not turn every finding into a new checklist item. Merge repeated failures into one precise invariant or branch rule.
- Do not remove a covered constraint unless it is duplicated by a clearer equivalent.
- Do not optimize for one trace by hardcoding task-specific filenames, numeric values, or verifier messages unless those values are part of the skill's intended contract.
- Distinguish `violated` from `missed`: violations need a guard/invariant against explicit counter-behavior; missed items need reachability, ordering, or observability improvements.
- Distinguish final-output/artifact failures from process-adherence gaps. If the native verifier passes and the remaining failures are process-only, do not add stricter process bullets just to force the same internal route.
- Do not turn reference helper internals into mandatory process requirements unless the failed evidence proves that exact internal detail is required. Examples of usually non-contract helper details include variable names, exact exception text, arbitrary safety bounds, loop wrapper shape, and non-semantic tie-breakers.
- When a skill must optimize a final score among valid outputs, separate hard validity contracts from search heuristics. Candidate ordering, scoring tuples, and local preferences should be framed as tie-breakers or fallback guidance unless native verifier evidence shows they are required for correctness.

## Native Verifier And Process-Gap Rules

When native verifier evidence is provided, use it as a guardrail for optimization direction:

- If final-output or artifact constraints failed, preserve or strengthen the concrete output invariant that maps to the failed verifier assertion.
- If final-output and artifact constraints passed, treat process failures as candidates for `overconstrained-process` before adding new process requirements.
- For `overconstrained-process`, prefer replacing rigid steps with flexible contracts:
  - required output invariants;
  - required validation facts that can be observed in trace or artifact;
  - branch predicates that explain when the detailed procedure is necessary;
  - concise fallback rules for ambiguous cases.
- If final-output/artifact constraints pass but a generated skill still has process findings about exact scoring order, exhaustive-vs-greedy search, helper function safety bounds, or exception paths, relax those items into implementation hints instead of preserving them as `must` constraints.
- Preserve domain invariants that the verifier actually checks. Do not remove constraints such as schema, feasibility, budget, no-conflict, or final validation requirements merely because the agent found a different implementation path.
- Avoid optimizing a successful final output by making the internal procedure more brittle.

## Program-Analysis Guidance

Treat the skill graph as the control-flow source of truth:

- A failure on a taken branch may justify strengthening that branch.
- A failure on an unknown branch usually requires clearer branch predicates, not stricter obligations.
- A repeated failure across sibling branches may justify moving the rule to a dominating section.
- A covered check near a failed check can show where to place the new invariant.
- A `not_applicable` finding should not drive a patch unless the branch predicate itself is wrong.

Use trace facts instead of keyword matches:

- For commands, preserve command names and flags only when the skill intends them.
- For files, prefer file categories and required artifacts over one trace-specific path.
- For numeric constraints, state the comparison or bound, not just the number from one run.
- For ordering, state the before/after relation explicitly.
- For code snippets, state the semantic contract outside the snippet. Mark snippets as illustrative/reference when exact implementation details are not required; avoid code blocks that accidentally make incidental helper details look mandatory.

## Final Report

End with:

- Whether an optimized skill was written.
- The number of violated and missed constraints used.
- The main graph branch or invariant changed.
- The anti-bloat decisions: what was merged, moved, or not added.
- The next rerun command or artifact path if supplied by the prompt.
