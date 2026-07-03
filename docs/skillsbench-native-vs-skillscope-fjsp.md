# SkillsBench Native vs SkillScope Analysis: FJSP

This note separates three metrics that are easy to conflate:

1. SkillsBench benchmark score: final verifier reward/pass from `result.json`.
2. SkillsBench-style failure taxonomy: failed verifier assertions/log failures, grouped by failure type.
3. SkillScope trace analysis: instruction-level covered / missed / violated judgments over the agent trajectory.

SkillsBench itself does not ship an instruction-level SKILL.md adherence analyzer in this repo. Its native executable logic is the verifier. For `manufacturing-fjsp-optimization`, the closest native constraint-violation signal is the pytest/CTRF verifier result.

## Reported "Violation" Metrics in Context

There are two related but different public metrics:

- The SkillsBench paper reports failure-mode snapshots and qualitative examples such as `Specification Violation`, but these are verifier/log failure categories over failed task outcomes, not per-instruction SKILL.md adherence rates.
- Tessl reports skill adherence across projects ranging from 19% to 94%, with an average of 62%. That is closer to SkillScope's goal, but it is not implemented by the SkillsBench repo's native verifier/dashboard code.

Sources:

- SkillsBench paper: https://arxiv.org/html/2602.12670v4
- Tessl article: https://tessl.io/blog/common-pitfalls-of-skills-development-and-how-to-fix-them/

## Native SkillsBench Verifier Results

| version | reward | verifier tests | failed native constraints | SkillsBench-style failure type |
|---|---:|---:|---|---|
| original | 0.0 | 13 / 15 passed | `test_L3_right_shift_only_baseline_repair`; `test_L3_local_minimal_right_shift_in_precedence_aware_order` | specification / constraint violation |
| v1 | 0.0 | 14 / 15 passed | `test_L3_local_minimal_right_shift_in_precedence_aware_order` | specification / constraint violation |
| v2 | 1.0 | 15 / 15 passed | none | none |

Concrete failed assertions:

- original violated right-shift: `(1, 1)` starts at `7` while baseline start is `9`.
- original violated precedence-aware anchor: `(2, 0)` starts at `1` while anchor is `5`.
- v1 violated local minimality: `(1, 1)` starts at `25`, anchor is `9`, and `start - 1` is still feasible.
- v2 passes all verifier constraints.

## SkillScope Trace-Level Results

| version | reward | covered | missed / ignored | violated | non-compliance |
|---|---:|---:|---:|---:|---:|
| original | 0.0 | 26 | 2 | 3 | 16.1% |
| v1 | 0.0 | 30 | 0 | 3 | 9.1% |
| v2 | 1.0 | 26 | 6 | 10 | 38.1% |

The v2 mismatch is important: the final artifact satisfies the native verifier, but the trace-level judge still flags process-level constraints. That means we should not collapse SkillScope's trace compliance into SkillsBench reward. They answer different questions:

- Native verifier: did the final output satisfy task constraints?
- SkillScope judge: did the agent appear to follow the skill process while producing the output?

## Implication

For SkillsBench experiments, report both:

- native verifier pass/reward and CTRF failed-test constraints;
- SkillScope instruction-level missed/violated rates.

When a verifier-backed constraint passes, SkillScope should treat that as hard counter-evidence against output-level violation. Process-only instructions can still be judged from the trace, but they should be labeled separately from final-output constraint violations.
