# SkillsBench Codex Experiment

This protocol evaluates whether SkillScope can reduce skill non-compliance on
the 87 default runnable SkillsBench tasks.

## Goal

Compare original task-bundled skills against SkillScope-optimized skills for
Codex + GPT-5.5.

Primary metric:

- non-compliance rate = `(violated + ignored) / judged reachable constraints`

Secondary metrics:

- explicit violation rate
- ignored/missed rate
- unknown rate
- reward/pass delta

## Setup

Install BenchFlow and clone SkillsBench separately:

```bash
uv tool install "benchflow>=0.6.2,<0.7"
git clone https://github.com/benchflow-ai/skillsbench.git
```

Confirm agent credentials and model routing before launching the full run.

## Stage 1: Original Skills

Generate a reproducible run plan:

```bash
npm run skillsbench -- plan \
  --skillsbench-root /path/to/skillsbench \
  --out .skilllens/experiments/skillsbench-codex-gpt55 \
  --agent codex \
  --model gpt-5.5 \
  --trials 3
```

Run:

```bash
bash .skilllens/experiments/skillsbench-codex-gpt55/run-original.sh
```

For long unattended local runs, optionally cap each trial so one slow Docker
build or verifier does not block the whole batch:

```bash
SKILLSCOPE_TRIAL_TIMEOUT_SECONDS=7200 \
  bash .skilllens/experiments/skillsbench-codex-gpt55/run-original.sh
```

The run script still writes `done` / `failed` status files and remains
resumable.

To finish the rest of a batch before revisiting slow or broken environments:

```bash
SKILLSCOPE_SKIP_FAILED=1 \
SKILLSCOPE_TRIAL_TIMEOUT_SECONDS=7200 \
  bash .skilllens/experiments/skillsbench-codex-gpt55/run-original.sh
```

### Remote machine Docker runner

For the 87-task run, prefer running the whole experiment on a remote machine if
Docker builds are the bottleneck. Do not rely on `DOCKER_HOST=ssh://...` unless
the remote daemon can see the exact same build-context paths, because BenchFlow
creates temporary compose directories during sandbox setup.

SkillsBench does not provide one shared prebuilt image for the 87-task Docker
suite. "Remote Docker" here means the remote machine's local Docker daemon, not
a remote image registry. The default tasks each ship an `environment/Dockerfile`;
the remote runner moves those per-task builds to the remote host and lets the
remote Docker layer cache absorb repeated work.

Generate a remote runner:

```bash
npm run skillsbench -- remote-script \
  --plan .skilllens/experiments/skillsbench-codex-gpt55/run-plan.json \
  --out .skilllens/experiments/skillsbench-codex-gpt55
```

Run it with an SSH target:

```bash
SKILLSCOPE_SKIP_FAILED=1 \
SKILLSCOPE_TRIAL_TIMEOUT_SECONDS=7200 \
SKILLSCOPE_SYNC_CODEX_AUTH=1 \
  .skilllens/experiments/skillsbench-codex-gpt55/run-remote-original.sh user@remote-host
```

The script syncs this workspace to `SkillScope` in the remote user's home,
regenerates the run plan with remote absolute paths, runs BenchFlow against the
remote host's local Docker daemon, and pulls artifacts back into:

```text
.skilllens/experiments/skillsbench-codex-gpt55-remote
```

Set `SKILLSCOPE_REMOTE_DIR=/path/on/remote` to choose another remote checkout
path. Leave `SKILLSCOPE_SYNC_CODEX_AUTH` unset if the remote host already has a
working `$CODEX_HOME`.

## Stage 2: Violation Analysis

Point `--runs-root` at the directory containing BenchFlow trial artifacts.
The collector scans for trial directories containing a config and trajectory;
`result.json` is used when present, but partial trials can still be indexed for
analysis or debugging.

```text
config.json
trajectory/acp_trajectory.jsonl
```

```bash
npm run skillsbench -- collect \
  --runs-root /path/to/benchflow/results \
  --out .skilllens/experiments/skillsbench-codex-gpt55/collected

npm run skillsbench -- analyze \
  --plan .skilllens/experiments/skillsbench-codex-gpt55/run-plan.json \
  --trials-file .skilllens/experiments/skillsbench-codex-gpt55/collected/trials.json \
  --out .skilllens/experiments/skillsbench-codex-gpt55/analysis
```

For evidence-backed claims, run the agent judge path. Use a timeout for
unattended batches; timed-out analyses are saved as low-confidence unknown
findings rather than crashing the full analysis:

```bash
npm run skillsbench -- judge \
  --plan .skilllens/experiments/skillsbench-codex-gpt55/run-plan.json \
  --trials-file .skilllens/experiments/skillsbench-codex-gpt55/collected/trials.json \
  --out .skilllens/experiments/skillsbench-codex-gpt55/agent-analysis \
  --agent-timeout-ms 1200000
```

Review:

```text
.skilllens/experiments/skillsbench-codex-gpt55/analysis/violation-rates.md
```

This batch command is the fast local aggregation pass. For final claims, rerun
the selected trials or high-risk constraints through the v5 agent judge so the
reported violation rate is graph-guided and evidence-checked rather than only a
local screening metric.

## Stage 3: Optimized Skills

Generate conservative optimized skill candidates from repeated failures:

```bash
npm run skillsbench -- propose \
  --plan .skilllens/experiments/skillsbench-codex-gpt55/run-plan.json \
  --analysis .skilllens/experiments/skillsbench-codex-gpt55/analysis/violation-rates.json \
  --out .skilllens/experiments/skillsbench-codex-gpt55/optimized-skills \
  --min-failures 2 \
  --max-edits-per-skill 3
```

The generated patches are intentionally small. They should only add
evidence-backed gates for constraints that repeatedly failed.

## Stage 4: Rerun

Generate the second-pass run commands:

```bash
npm run skillsbench -- rerun-plan \
  --plan .skilllens/experiments/skillsbench-codex-gpt55/run-plan.json \
  --optimized-skills-root .skilllens/experiments/skillsbench-codex-gpt55/optimized-skills \
  --out .skilllens/experiments/skillsbench-codex-gpt55
```

Run:

```bash
bash .skilllens/experiments/skillsbench-codex-gpt55/run-optimized.sh
```

Then repeat Stage 2 on the optimized-run artifacts and compare
`violation-rates.json` across original and optimized conditions.
