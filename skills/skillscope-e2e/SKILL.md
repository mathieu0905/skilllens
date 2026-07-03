---
name: skillscope-e2e
description: "Run a single-instance SkillScope optimization loop for one selected SkillsBench task and one selected SKILL.md: original run, native verifier check, graph-guided SkillScope analysis, gate, one optimized skill rewrite, optimized rerun, and adherence comparison. Use when the user wants to validate or optimize a specific task-skill pair."
---

# SkillScope E2E

Use this skill for one selected `(taskId, skillRelPath)` instance.

The loop is:

```text
select one task + one skill
  -> run original skill on that task
  -> collect trajectory and native verifier result
  -> run SkillScope graph-guided agent judge on the selected skill
  -> gate: pass-through, optimize, or mark not skill-caused
  -> generate exactly one optimized SKILL.md when gated for optimization
  -> rerun the same task with only that selected skill replaced
  -> judge the optimized trajectory and optimized skill
  -> compare native correctness and SkillScope non-compliance
```

## Experiment Unit

Define the instance before running anything:

- `taskId`: one SkillsBench task.
- `skillRelPath`: one `environment/skills/<skill-name>/SKILL.md`.
- `trial`: default `1` original trial and `1` optimized trial unless the user asks otherwise.
- `slug`: one semantic experiment name for this instance.

Prefer one-skill SkillsBench tasks for the first clean loop. A one-skill task is one whose `environment/skills` directory contains exactly one `SKILL.md`.

If a task contains multiple skills:

- Analyze and optimize only the selected `skillRelPath`.
- Treat sibling skills as unchanged task context.
- Do not merge sibling skills into the optimization target.
- Do not optimize sibling skills in the same run.
- If the current CLI cannot restrict rerun or propose steps to the selected skill, stop and either choose a one-skill task or add target-skill filtering before continuing.

## Versioning Rule

Use git commits for code, workflow, and skill versions. Do not create `v1`, `v2`, `v8`, or similar artifact directories as a substitute for version control.

Use semantic experiment names for artifacts, for example:

- `.skilllens/experiments/skillsbench-codex-gpt55/azure-bgp-single-original`
- `.skilllens/experiments/skillsbench-codex-gpt55/azure-bgp-single-optimized`
- `.skilllens/experiments/skillsbench-codex-gpt55/right-shift-contract-smoke`

Each final comparison must name the git commit, run plan path, original run root, selected skill path, optimized skill root, optimized run root, and both analysis reports.

## Preflight

Before running the selected instance:

1. Check the current git commit and worktree status.
2. Run `npm run build`.
3. Confirm BenchFlow and the local SkillsBench checkout.
4. Confirm Codex provider routing if using `codex` / `gpt-5.5`.
5. Confirm the exact `taskId`, `skillRelPath`, and semantic `slug`.
6. Confirm whether the task is one-skill. Prefer one-skill tasks for the clean first pass.

Useful checks:

```bash
git rev-parse --short HEAD
git status --short
npm run build
npm run skillsbench -- --help
```

List one-skill tasks when choosing a clean instance:

```bash
python - <<'PY'
from pathlib import Path
root = Path('.skilllens/vendor/skillsbench/tasks')
for task in sorted(root.iterdir() if root.exists() else []):
    skills_dir = task / 'environment' / 'skills'
    skills = sorted(skills_dir.glob('*/SKILL.md')) if skills_dir.exists() else []
    if len(skills) == 1:
        print(f'{task.name}\t{skills[0].relative_to(skills_dir)}')
PY
```

If the worktree has unrelated user changes, do not revert them. Record the dirty state or commit only the workflow change separately.

## Phase 1: Plan The Original Run

Create a run plan for the selected task only:

```bash
npm run skillsbench -- plan \
  --skillsbench-root <skillsbench-root> \
  --out .skilllens/experiments/<slug>/original \
  --agent codex \
  --model gpt-5.5 \
  --trials 1 \
  --task <task-id> \
  --prebuilt-skillsbench-ghcr \
  --bench-arg --usage-tracking \
  --bench-arg off
```

Use `--prebuilt-skillsbench-ghcr` when the task has a matching
`ghcr.io/benchflow-ai/skillsbench-task-env:standard-v1-<task-id>` image. It
generates one `--environment-manifest` for the selected task and keeps the local
checkout as the source of skill text for SkillScope analysis.

Use `trials=1` for the first optimization loop. Increase trials only after the single-instance loop is stable.

## Phase 2: Run The Original Trial

Run the original with-skill trial:

```bash
bash .skilllens/experiments/<slug>/original/pull-prebuilt-images.sh

SKILLSCOPE_TRIAL_TIMEOUT_SECONDS=7200 \
SKILLSCOPE_SKIP_FAILED=1 \
  bash .skilllens/experiments/<slug>/original/run-original.sh
```

The generated runner is resumable through status files. If the task fails due to environment or provider issues, keep the artifact and classify it later.

Use remote Docker only after a local smoke check succeeds:

```bash
npm run skillsbench -- remote-script \
  --plan .skilllens/experiments/<slug>/original/run-plan.json \
  --out .skilllens/experiments/<slug>/original
```

## Phase 3: Collect And Judge Original

Collect trial artifacts:

```bash
npm run skillsbench -- collect \
  --runs-root .skilllens/experiments/<slug>/original/jobs \
  --out .skilllens/experiments/<slug>/original/collected
```

Run the graph-guided agent judge:

```bash
npm run skillsbench -- judge \
  --plan .skilllens/experiments/<slug>/original/run-plan.json \
  --trials-file .skilllens/experiments/<slug>/original/collected/trials.json \
  --out .skilllens/experiments/<slug>/original/agent-analysis \
  --agent-concurrency 1 \
  --agent-timeout-ms 1200000
```

For the clean one-skill case, the analysis output should contain one `taskId::skillRelPath` key. If more than one skill appears, continue only with the selected key and avoid optimizing the others.

Inspect:

- `violation-rates.json`
- `violation-rates.md`
- per-run `constraints.json`
- per-run `skill-graph.json`
- per-run `trace-facts.json`
- per-run `findings.json`
- native verifier summary inside `violation-rates.json`

## Phase 4: Gate The Instance

Decide before launching the optimizer.

Use pass-through when all of these are true:

- native verifier already passes or reward is high enough for the benchmark;
- SkillScope non-compliance is low, default `< 10%`;
- there are no `violated` or `missed` findings on `final_output` or `artifact` targets;
- remaining issues are only process, tool-use, reporting, or unknown findings with weak skill-causality evidence.

Optimize exactly one skill when at least one condition holds:

- native verifier failed or reward is below pass;
- SkillScope found selected-skill `violated` or `missed` findings on `final_output` or `artifact` targets;
- selected-skill non-compliance is high, default `>= 10%`;
- a reachable selected-skill constraint failed in a way that plausibly explains native failure;
- the user explicitly asks to improve process observability for this instance.

Mark the instance as not skill-caused when native verifier failed but SkillScope did not find selected-skill violations or misses with plausible causal relation. Do not rewrite the skill for that case without new evidence.

Record the gate decision in the final report and, if using `propose`, in `skill-patches.json` / `skill-patches.md`.

## Phase 5: Generate One Optimized Skill

Use `$skillscope-optimizer` only after the gate says optimize.

Generate one optimized `SKILL.md` for the selected skill:

```bash
npm run skillsbench -- propose \
  --plan .skilllens/experiments/<slug>/original/run-plan.json \
  --analysis .skilllens/experiments/<slug>/original/agent-analysis/violation-rates.json \
  --out .skilllens/experiments/<slug>/optimized-skills \
  --min-failures 1 \
  --optimize-nc-threshold 0.1 \
  --max-edits-per-skill 4 \
  --agent-concurrency 1 \
  --agent-timeout-ms 1200000
```

This command must produce one target rewrite for the selected task-skill instance. If it would produce multiple rewrites because the task has multiple skills, stop and filter to the selected skill before continuing.

Accept an optimized skill only when it:

- expresses a direct next-run workflow with entry conditions, ordered steps, validation checkpoints, and output contracts;
- uses positive procedural language rather than "do not old logic", blame notes, or defensive patch history;
- generalizes from evidence to the task contract rather than copying incidental filenames, operation IDs, numbers, or verifier text;
- preserves native-verifier-backed output invariants and covered constraints unless an edit is an equivalent clarification or directly tied to a failed neighboring constraint;
- changes only the selected skill.

Reject or revise it when it bloats the skill, rewrites already-covered sections without cause, deletes meaningful constraints to improve the rate, or adds several alternative candidates.

## Phase 6: Rerun With The Optimized Skill

Generate the optimized rerun script:

```bash
npm run skillsbench -- rerun-plan \
  --plan .skilllens/experiments/<slug>/original/run-plan.json \
  --optimized-skills-root .skilllens/experiments/<slug>/optimized-skills \
  --out .skilllens/experiments/<slug>/optimized-run
```

Run:

```bash
SKILLSCOPE_TRIAL_TIMEOUT_SECONDS=7200 \
SKILLSCOPE_SKIP_FAILED=1 \
  bash .skilllens/experiments/<slug>/optimized-run/run-optimized.sh
```

Native verifier pass/reward is the correctness gate. If the optimized run regresses native correctness, stop and inspect before accepting the rewrite.

## Phase 7: Collect And Judge Optimized

Collect optimized artifacts:

```bash
npm run skillsbench -- collect \
  --runs-root .skilllens/experiments/<slug>/optimized-run/jobs \
  --out .skilllens/experiments/<slug>/optimized-analysis/collected
```

Create an optimized analysis plan that points to the optimized skill root:

```bash
npm run skillsbench -- analysis-plan \
  --plan .skilllens/experiments/<slug>/original/run-plan.json \
  --optimized-skills-root .skilllens/experiments/<slug>/optimized-skills \
  --out .skilllens/experiments/<slug>/optimized-analysis
```

Judge:

```bash
npm run skillsbench -- judge \
  --plan .skilllens/experiments/<slug>/optimized-analysis/run-plan.json \
  --trials-file .skilllens/experiments/<slug>/optimized-analysis/collected/trials.json \
  --out .skilllens/experiments/<slug>/optimized-analysis/agent-analysis \
  --agent-concurrency 1 \
  --agent-timeout-ms 1200000
```

Compare only the selected skill's original and optimized analysis.

## Phase 8: Compare

Compare original vs optimized:

- native reward pass rate;
- native verifier test pass rate;
- total failed native tests;
- selected-skill covered / missed / violated / unknown;
- selected-skill non-compliance rate;
- final_output/artifact non-compliance;
- repeated failure groups for the selected skill.

Use `jq` for a quick comparison:

```bash
for f in \
  .skilllens/experiments/<slug>/original/agent-analysis/violation-rates.json \
  .skilllens/experiments/<slug>/optimized-analysis/agent-analysis/violation-rates.json
do
  printf '%s\t' "$f"
  jq -r '[.totals.counts.covered,
          .totals.counts.missed,
          .totals.counts.violated,
          .totals.counts.unknown,
          .totals.noncomplianceRate,
          .nativeVerifier.rewardPassRate,
          .nativeVerifier.testPassRate] | @tsv' "$f"
done
```

Treat improvement as credible when native correctness is preserved or improved and selected-skill missed plus violated findings decrease on judged reachable constraints.

## Stop Conditions

Stop and diagnose when:

- optimized native reward drops;
- a native-passing low-NC instance was optimized despite the gate;
- optimizer writes history-shaped clauses, blame notes, or trace-specific hardcoding instead of a positive workflow;
- SkillScope non-compliance improves only by deleting meaningful constraints;
- agent judge produces many `unknown` findings because the trace or output artifact is insufficient;
- the task has multiple skills and the tooling cannot isolate the selected skill.

## Reporting

End every instance with a short report:

- `taskId`, `skillRelPath`, trial count, completed trials, failed trials;
- git commit and dirty/clean status;
- path to the original run plan;
- path to the selected original skill;
- path to the optimized skill or pass-through decision;
- paths to original and optimized `violation-rates.json`;
- native reward/test-pass delta;
- selected-skill non-compliance delta;
- top missed/violated selected-skill constraints;
- decision: accept optimized skill, pass through, rerun due to environment failure, fix analyzer/optimizer, or stop.
