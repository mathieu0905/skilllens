---
name: skillscope-optimizer
description: Optimize an agent skill from SkillScope analysis artifacts. Use when Codex or Claude Code is launched by SkillScope after coverage analysis, or when a workflow needs an evidence-backed SKILL.md revision based on constraints.json, skill-graph.json, trace-facts.json, findings.json, and the original SKILL.md.
---

# SkillScope Optimizer

## Purpose

Optimize one selected `SKILL.md` from SkillScope's program-analysis artifacts. Use the artifact chain below as the source of truth:

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

If any IR artifact is missing, stop and report which artifact is missing. Missing IR routes the workflow back to `skillscope-analyzer`.

## Optimization Direction

Optimize only when there is a real optimization target. When the native verifier already passed, non-compliance is low, and remaining failures are only process/reporting observability gaps, use the current skill as the rerun candidate, copy it to `optimized-skill.md`, record the pass-through reason in the report, and set `optimization-packet.json` edits to an empty array.

Use this priority order:

1. Native verifier failed assertions that map to final-output or artifact contracts.
2. SkillScope `violated` findings on `final_output` or `artifact` targets.
3. Repeated `missed` findings on reachable final-output or artifact constraints.
4. High non-compliance or repeated failures across traces.
5. Process/tool/reporting failures only when they explain a native or artifact failure, repeat across traces, or the user explicitly wants observability hardening.

A single successful trace with a low-severity process-only `missed` finding routes to analyzer confidence, branch reachability, or UI review unless the user explicitly requests observability hardening.

Treat satisfied constraints as preservation anchors. A covered constraint, a native-verifier-backed output invariant, or a nearby branch that worked should stay textually stable except when the replacement is a clearer equivalent required by a failed neighboring constraint. Every edit that touches a covered span should state the preserved invariant in `optimization-packet.json`.

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
4. Map native verifier failures before editing:
   - Read failed test names, assertion messages, expected/actual values, and result fields when present.
   - Identify which skill constraints directly control those final-output/artifact failures.
   - If a proposed edit does not plausibly change the failed native assertion or a repeated final/artifact non-compliance, downgrade it or skip it.
5. Propose the smallest durable edit:
   - Prefer replacing, moving, merging, or deleting existing text before appending new text.
   - Add a new line only when it maps to a future trace fact, command, file artifact, event order, numeric bound, or output field.
   - List the covered behavior each edit preserves. If an edit touches a covered span, state the equivalent invariant that remains true.
6. Write the optimized skill and rationale artifacts.
7. Finish with a concise report that names the failure patterns, edited source spans, expected future evidence, and native verifier risk.

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

Every edit entry must also include non-empty `change` text and either `constraintIdsAddressed` or `constraintIdsPreserved`. Use empty arrays for fields that have no members; the UI and batch reports use these fields directly.

If the prompt provides only `optimized-skill.md`, include the rationale and diff as Markdown comments at the bottom only if a separate report path is not available.

## Workflow-First Revision Rules

Write the optimized skill as the current best executable workflow:

- State the desired next-run flow directly: entry condition, branch predicate, ordered steps, validation checkpoint, and output contract.
- Use positive procedure language such as "First parse...", "Then validate...", "For this branch, emit...", and "Before final output, compare...".
- Omit historical phrases, blame language, and references to a previous failed attempt. The revised skill should read like the best current process.
- Replace generic quality language with concrete checks that produce trace facts, artifact fields, parsed values, or verifier-visible outputs.
- Merge repeated failures into one precise invariant or branch rule instead of adding one bullet per finding.
- Preserve covered constraints as anchors. Touch a covered source span only for an equivalent clarification, a move that improves branch placement, or a direct conflict with native verifier evidence.
- Generalize from trace evidence to task contracts. Use task-specific filenames, numeric values, and verifier messages only when they are part of the intended contract.
- Distinguish `violated` from `missed`: violations need a guard/invariant against explicit counter-behavior; missed items need reachability, ordering, or observability improvements.
- Distinguish final-output/artifact failures from process-adherence gaps. If the native verifier passes and the remaining failures are process-only, prefer a pass-through decision, relaxing an over-specific process rule, or analyzer follow-up.
- If the native verifier fails, spend the edit budget on the final-output/artifact invariant that maps to the failed assertion before process observability.
- Keep reference helper internals illustrative unless the failed evidence proves that exact internal detail is required. Usually incidental helper details include variable names, exact exception text, arbitrary safety bounds, loop wrapper shape, and non-semantic tie-breakers.
- When a skill must optimize a final score among valid outputs, separate hard validity contracts from search heuristics. Candidate ordering, scoring tuples, and local preferences should be framed as tie-breakers or fallback guidance unless native verifier evidence shows they are required for correctness.

## Native Verifier And Process-Gap Rules

When native verifier evidence is provided, use it as a guardrail for optimization direction:

- Treat native failed assertions as primary optimization evidence. Quote or summarize the failed assertion in the report and explain which edited constraint is expected to change that outcome.
- If final-output or artifact constraints failed, preserve or strengthen the concrete output invariant that maps to the failed verifier assertion.
- If final-output and artifact constraints passed, treat process failures as candidates for `overconstrained-process` before adding new process requirements.
- For `overconstrained-process`, prefer replacing rigid steps with flexible contracts:
  - required output invariants;
  - required validation facts that can be observed in trace or artifact;
  - branch predicates that explain when the detailed procedure is necessary;
  - concise fallback rules for ambiguous cases.
- If final-output/artifact constraints pass but a generated skill still has process findings about exact scoring order, exhaustive-vs-greedy search, helper function safety bounds, or exception paths, relax those items into implementation hints instead of preserving them as `must` constraints.
- Preserve domain invariants that the verifier actually checks, including schema, feasibility, budget, no-conflict, and final validation requirements.
- For a successful final output, make the internal procedure more flexible unless the evidence shows that stricter process ordering is required.

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
- For code snippets, state the semantic contract outside the snippet. Mark snippets as illustrative/reference when exact implementation details are optional, and keep incidental helper details outside the hard contract.

## Final Report

End with:

- Whether an optimized skill was written.
- The number of violated and missed constraints used.
- The main graph branch or invariant changed.
- The anti-bloat decisions: what was merged, moved, or not added.
- The next rerun command or artifact path if supplied by the prompt.
