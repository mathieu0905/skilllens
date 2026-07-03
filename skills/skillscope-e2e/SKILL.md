---
name: skillscope-e2e
description: "Run end-to-end SkillScope optimization experiments on SkillsBench tasks: original skill trials, SkillScope graph-guided analysis, optimizer proposal, optimized rerun, native verifier check, and post-optimization adherence comparison. Use when the user wants to scale the validated single-instance loop to many SkillsBench instances or run a batch skill-improvement campaign."
---

# SkillScope E2E

Use this skill to run a complete evidence-backed SkillScope optimization loop over one or more SkillsBench tasks.

The loop is:

```text
original skill run
  -> collect trajectories
  -> SkillScope agent judge
  -> optimizer proposal from constraints/graph/facts/findings
  -> optimized skill rerun
  -> native verifier
  -> SkillScope agent judge again
  -> compare native accuracy and skill adherence
```

Do not manually rewrite skills outside this loop. The optimizer must use SkillScope artifacts: `constraints.json`, `skill-graph.json`, `trace-facts.json`, `findings.json`, and native verifier evidence when available.

## Agent Decomposition

Use this skill as the outer orchestrator. For non-trivial batches, decompose the work into phase agents with explicit skill routing instead of one agent trying to reason through the entire experiment.

Each phase agent prompt must begin by naming the skill it should use:

- `Use $skillscope-e2e.` for preflight, planning, running, collecting, rerun planning, verifier gating, and final comparison.
- `Use $skillscope-analyzer.` for each original or optimized skill-use analysis. The analyzer reads one skill-use window and writes `constraints.json`, `skill-graph.json`, `trace-facts.json`, `findings.json`, `progress.md`, and a report.
- `Use $skillscope-optimizer.` for each optimization proposal. The optimizer reads analyzer IR and writes the optimized `SKILL.md` plus `optimization-report.md`, `optimization-diff.md`, and `optimization-packet.json`.

Recommended phase agents:

| Agent | Skill | Unit of work | Required output |
| --- | --- | --- | --- |
| `preflight-agent` | `skillscope-e2e` | repo/build/BenchFlow/provider checks | recorded commit, dirty-state note, chosen slug |
| `original-runner-agent` | `skillscope-e2e` | one task shard | `run-plan.json`, `run-original.sh`, job artifacts |
| `original-collector-agent` | `skillscope-e2e` | one run root | `collected/trials.json` |
| `original-judge-agent` | `skillscope-analyzer` | one trial plus one skill | analyzer IR and findings |
| `optimizer-agent` | `skillscope-optimizer` | one task/skill failure group | optimized skill artifacts |
| `optimized-runner-agent` | `skillscope-e2e` | one optimized shard | `run-optimized.sh`, optimized job artifacts |
| `optimized-judge-agent` | `skillscope-analyzer` | one optimized trial plus one optimized skill | analyzer IR and findings |
| `comparison-agent` | `skillscope-e2e` | original vs optimized aggregate | metrics table and scale/stop decision |

Do not pass full trace text through agent prompts when a file path exists. Prompts should pass paths, task IDs, trial IDs, and the expected output directory. Large batches should shard runner agents by task set and let the `judge` / `propose` commands launch per-skill Codex analyzer or optimizer runs with cache reuse.

The outer e2e agent must not perform blind trace analysis itself. It should inspect aggregate reports and handoff artifacts, then launch the correct phase agent or command for the next step.

## Versioning Rule

Use git commits for code and workflow versions. Use semantic experiment names for artifacts. Do not create endless `v1`, `v2`, `v8` experiment directories as the version system.

Good artifact names:

- `.skilllens/experiments/skillsbench-codex-gpt55/right-shift-contract-smoke`
- `.skilllens/experiments/skillsbench-codex-gpt55/default-30-original`
- `.skilllens/experiments/skillsbench-codex-gpt55/default-30-optimized`

Each final comparison must name the git commit, run plan path, original run root, optimized skill root, optimized run root, and both analysis reports.

## Batch Sizing

Default to a staged rollout:

1. Smoke: 1-3 tasks.
2. Small batch: 10 tasks.
3. Medium batch: 20-40 tasks.
4. Full default set only when the previous stage improves or preserves native pass rate and reduces SkillScope non-compliance.

For a first broad validation, choose 20-30 default runnable tasks unless the user asks for all 87. If the user names tasks, use exactly those tasks.

Do not run multiple writers into the same experiment directory. For parallel work, create separate semantic shard directories and merge comparisons afterward.

## Preflight

Before launching a batch:

1. Check the current git commit and worktree status.
2. Run `npm run build`.
3. Confirm BenchFlow and the local SkillsBench checkout.
4. Confirm Codex provider routing if using `codex` / `gpt-5.5`.
5. Decide the task set and trial count.
6. Pick one semantic experiment slug.

Useful checks:

```bash
git rev-parse --short HEAD
git status --short
npm run build
npm run skillsbench -- --help
```

If the worktree has unrelated user changes, do not revert them. Either commit the workflow change separately or continue with a clearly recorded dirty state.

## Phase 1: Plan Original Runs

Agent: `preflight-agent` or `original-runner-agent` using `$skillscope-e2e`.

Create a run plan:

```bash
npm run skillsbench -- plan \
  --skillsbench-root <skillsbench-root> \
  --out .skilllens/experiments/<slug>/original \
  --agent codex \
  --model gpt-5.5 \
  --trials 1 \
  --max-tasks <N> \
  --bench-arg --sandbox \
  --bench-arg docker \
  --bench-arg --usage-tracking \
  --bench-arg off
```

If the user provided exact tasks, replace `--max-tasks` with repeated `--task <task-id>`.

Use `trials=1` for broad screening. Increase trials only after the pipeline is stable.

## Phase 2: Run Original Trials

Agent: `original-runner-agent` using `$skillscope-e2e`.

Run original with-skill trials:

```bash
SKILLSCOPE_TRIAL_TIMEOUT_SECONDS=7200 \
SKILLSCOPE_SKIP_FAILED=1 \
  bash .skilllens/experiments/<slug>/original/run-original.sh
```

The generated runner is resumable via status files. If a task fails due to environment or provider issues, keep the artifact and classify it later; do not silently drop it.

For remote Docker capacity, generate and use a remote runner only after local smoke succeeds:

```bash
npm run skillsbench -- remote-script \
  --plan .skilllens/experiments/<slug>/original/run-plan.json \
  --out .skilllens/experiments/<slug>/original
```

## Phase 3: Collect And Judge Original

Agents: `original-collector-agent` using `$skillscope-e2e`, then `original-judge-agent` using `$skillscope-analyzer`.

Collect trial artifacts:

```bash
npm run skillsbench -- collect \
  --runs-root .skilllens/experiments/<slug>/original/jobs \
  --out .skilllens/experiments/<slug>/original/collected
```

Run graph-guided agent judge:

```bash
npm run skillsbench -- judge \
  --plan .skilllens/experiments/<slug>/original/run-plan.json \
  --trials-file .skilllens/experiments/<slug>/original/collected/trials.json \
  --out .skilllens/experiments/<slug>/original/agent-analysis \
  --agent-timeout-ms 1200000
```

Judge outputs to inspect:

- `violation-rates.json`
- `violation-rates.md`
- per-run `constraints.json`
- per-run `skill-graph.json`
- per-run `trace-facts.json`
- per-run `findings.json`
- native verifier summary inside `violation-rates.json`

## Phase 4: Propose Optimized Skills

Agent: `optimizer-agent` using `$skillscope-optimizer`.

Generate optimized skill candidates from the original analysis:

```bash
npm run skillsbench -- propose \
  --plan .skilllens/experiments/<slug>/original/run-plan.json \
  --analysis .skilllens/experiments/<slug>/original/agent-analysis/violation-rates.json \
  --out .skilllens/experiments/<slug>/optimized-skills \
  --min-failures 1 \
  --max-edits-per-skill 4 \
  --agent-timeout-ms 1200000
```

Before rerun, spot-check generated optimizer artifacts:

- `.optimization-inputs/**/optimization-report.md`
- `.optimization-inputs/**/optimization-diff.md`
- `.optimization-inputs/**/optimization-packet.json`
- optimized `SKILL.md`

Reject or revise proposals that:

- add defensive history such as "do not use old logic";
- hardcode one trace's filenames, operation IDs, numbers, or verifier messages unless they are part of the task contract;
- turn reference-code helper details into mandatory process constraints;
- remove native-verifier-backed output invariants.

## Phase 5: Rerun Optimized Skills

Agent: `optimized-runner-agent` using `$skillscope-e2e`.

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

Native verifier pass/reward is the gate for output correctness. If optimized native pass rate drops materially, stop and inspect failed tasks before scaling.

## Phase 6: Collect And Judge Optimized

Agents: `optimized-runner-agent` or collector using `$skillscope-e2e`, then `optimized-judge-agent` using `$skillscope-analyzer`.

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

Then judge:

```bash
npm run skillsbench -- judge \
  --plan .skilllens/experiments/<slug>/optimized-analysis/run-plan.json \
  --trials-file .skilllens/experiments/<slug>/optimized-analysis/collected/trials.json \
  --out .skilllens/experiments/<slug>/optimized-analysis/agent-analysis \
  --agent-timeout-ms 1200000
```

## Phase 7: Compare

Agent: `comparison-agent` using `$skillscope-e2e`.

Compare these metrics for original vs optimized:

- native reward pass rate;
- native verifier test pass rate;
- total failed native tests;
- SkillScope covered / missed / violated / unknown;
- SkillScope non-compliance rate;
- final_output/artifact non-compliance;
- process-only non-compliance;
- repeated failure groups.

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

## Stop / Continue Gates

Continue to a larger batch only if:

- optimized native reward pass rate is not worse, or any drop is explained by environment/provider failures rather than skill changes;
- final_output/artifact non-compliance decreases or stays at zero;
- total missed + violated decreases on judged reachable constraints;
- remaining failures are understandable and not repeated across many tasks.

Stop and diagnose if:

- optimized native reward drops on multiple tasks;
- optimizer adds long defensive clauses or trace-specific hardcoding;
- SkillScope non-compliance improves only by deleting meaningful constraints;
- agent judge produces many `unknown` findings because the trace or output artifact is insufficient.

## Reporting

End every run with a short report:

- task count, completed trials, failed trials;
- git commit and dirty/clean status;
- paths to original and optimized run plans;
- paths to original and optimized `violation-rates.json`;
- native reward/test-pass delta;
- SkillScope non-compliance delta;
- top repeated missed/violated constraints;
- decision: expand batch, fix optimizer/analyzer, rerun failed tasks, or stop.
