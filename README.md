# SkillScope

Graph-guided coverage for agent skills.

SkillScope is a local, plugin-first viewer for Codex and Claude Code sessions. It maps `SKILL.md` instructions to trace evidence, highlights the exact spans that were followed, violated, ignored, or not taken, and stores completed analyses in a local SQLite cache.

SkillScope is not an agent runner, benchmark runner, or observability platform. It is a skill-aware scope on top of existing trajectories.

中文：SkillScope 是面向 Codex / Claude Code 的本地 skill 覆盖分析工具。它把 `SKILL.md` 里的约束和真实轨迹证据对齐，精确高亮遵循、违反、忽略、未走分支，并把分析结果缓存到本地 SQLite。

<p align="center">
  <img src="docs/assets/screenshots/skill-coverage.png" alt="SkillScope skill coverage heatmap with evidence panel" width="100%">
</p>

## Screenshots / 截图

| Skill graph / Skill 图 | Analysis process / 分析过程 |
| --- | --- |
| ![Skill graph with observed path and skipped branches](docs/assets/screenshots/skill-graph.png) | ![Agent analysis artifacts and cached run](docs/assets/screenshots/analysis-process.png) |

## What It Does / 功能

- Discovers local Codex and Claude Code sessions.
- Groups traces by project, then shows individual skill-use windows instead of forcing whole-session analysis.
- Highlights exact source spans in `SKILL.md`, not just whole lines.
- Compiles a skill into constraints, branches, ordering rules, numeric checks, output contracts, and a skill graph.
- Uses the skill graph to guide trace inspection instead of relying on keyword matching or blind summarization.
- Runs the matching local agent as judge: Codex captures use Codex; Claude Code captures use Claude Code.
- Streams analysis progress and generated artifacts.
- Caches completed findings in `.skilllens/skillscope.sqlite`.
- Produces anti-bloat skill rewrite proposals: minimal evidence-backed deltas, not automatic skill self-expansion.

中文：

- 自动发现本机 Codex / Claude Code sessions。
- 先按项目归类，再按单次 skill 使用窗口查看，不强制分析完整长对话。
- 对 `SKILL.md` 做精确 span 高亮，而不是整行粗标。
- 把 skill 编译成约束、条件分支、顺序规则、数值检查、输出契约和 skill graph。
- 用这个图来引导轨迹分析，而不是只做关键词匹配或盲总结。
- 调用同一种本地 agent 做 judge：Codex 轨迹用 Codex，Claude Code 轨迹用 Claude Code。
- 实时展示分析过程和产物。
- 已完成结果保存到 `.skilllens/skillscope.sqlite`，刷新后可复用。
- 对违反/忽略项生成 anti-bloat 的 skill 优化建议：只给有证据的最小补丁，不自动堆防御性废话。

## Quick Start / 快速开始

Requirements / 依赖：

- Node.js 20+
- npm
- Codex CLI if you want the `/skillscope` entry

```bash
npm install
npm run dev
```

Open / 打开：

```text
http://localhost:5173
```

Install the Codex slash prompt / 安装 Codex 入口：

```bash
npm run install:codex-prompt
```

Then run inside Codex / 然后在 Codex 中运行：

```text
/skillscope
```

The launcher captures the current session, identifies trace-proven skill files, writes a local capture bundle, and opens the browser UI.

启动器会捕获当前 session，识别轨迹中能证明被使用的 skill 文件，写入本地 capture bundle，并打开浏览器界面。

## Browser Flow / 浏览器流程

1. Select a project on the left.
2. Select one skill-use window on the right.
3. Open `Skill Highlight`, `Skill Graph`, `Trace`, `Analysis`, or `Rewrite Skill`.
4. Click `Start Analysis` to launch the local agent-guided judge.
5. Reopen the same window later; cached findings are restored from SQLite.

中文：

1. 左侧选择项目。
2. 右侧选择一次 skill 使用窗口。
3. 查看 `Skill 高亮`、`Skill 图`、`轨迹`、`分析过程` 或 `优化 Skill`。
4. 点击 `启动分析`，由本地 agent 按 analyzer skill 检查轨迹。
5. 之后重新打开同一窗口，会直接从 SQLite 恢复结果。

## Graph-Guided Analysis / 图引导分析

SkillScope treats a skill like a small specification program. The graph is not just a visualization; it is the analysis plan used to inspect the trace.

```text
SKILL.md
  -> constraint IR
  -> skill graph: conditions, obligations, prohibitions, order, outputs
  -> trace facts: commands, tools, files, edits, final output, event order
  -> observed path through the skill graph
  -> evidence-backed judgments
```

中文：SkillScope 把 skill 当成一个小型规格程序。图不是装饰性可视化，而是轨迹分析计划。

Status labels / 状态：

- `covered` / `遵循`: the trace shows the required behavior.
- `violated` / `违反`: the trace shows explicit conflicting behavior.
- `missed` / `忽略`: the instruction applied, but the required behavior is absent.
- `not_applicable` / `未走`: the branch was not taken for this selected task.
- `unknown` / `待判断`: evidence is insufficient.

Violation and ignored are intentionally separate: absence is ignored/missed; explicit conflict is violated.

中文：违反和忽略必须区分。缺失 required action 是忽略；出现相反行为才是违反。

## Skill Rewrite Proposals / Skill 优化建议

SkillScope can turn violated and ignored findings into an optimized skill proposal, but it deliberately avoids automatic self-expansion.

The rewrite output is a reviewed delta:

- cite the violated or ignored constraint;
- cite evidence event IDs;
- propose the smallest replacement/addition/deletion;
- define how a future trace should prove compliance;
- avoid defensive text such as `no old logic`, `never repeat the previous mistake`, or generic `be careful`.

中文：SkillScope 只生成可审查的最小补丁建议，不会把建议自动拼回原 skill，也不会鼓励 “no old logic / 不要再犯旧错 / be careful” 这类不可观测的防御性废话。

## CLI

Analyze artifacts without the browser:

```bash
npm run analyze -- \
  --skill sample_data/pdf-edit/SKILL.md \
  --trace sample_data/pdf-edit/with-skill.jsonl \
  --result sample_data/pdf-edit/result.with-skill.json \
  --task sample_data/pdf-edit/task.md \
  --out skillscope-report
```

Analyze a capture bundle:

```bash
npm run analyze -- --bundle skillscope.capture.json --out skillscope-report
```

Internal repeated-finding audit for cached analyses:

```bash
npm run cia:audit
```

SkillsBench Codex/GPT-5.5 experiment control:

```bash
npm run skillsbench -- plan --skillsbench-root /path/to/skillsbench --trials 3
```

See [docs/skillsbench-experiment.md](docs/skillsbench-experiment.md).

The audit writes ignored local artifacts under `.skilllens/`.

## Local Data / 本地数据

Generated data stays local:

- `.skilllens/captures/`: captured Codex / Claude Code bundles.
- `.skilllens/registry.json`: local project and skill-use index.
- `.skilllens/skillscope.sqlite`: cached agent analyses and coverage findings.
- `.skilllens/agent-judge/`: per-run prompts, artifacts, raw output, findings, and rewrite proposals.

## Project Shape / 项目结构

```text
src/
  App.tsx                 browser UI
  lib/skillParser.ts      SKILL.md to instruction units and constraints
  lib/traceParser.ts      Codex / Claude / ACP / generic JSONL parsers
  lib/coverage.ts         local constraint-level coverage pass
  lib/agentJudge.ts       parser for agent-generated findings and skill graphs
  lib/report.ts           Markdown / HTML / JSON export
scripts/
  codex.ts                Codex /skillscope launcher
  capture.ts              capture bundle writer
  analyze.ts              CLI analyzer
  cia-audit.ts            local cached-analysis aggregator
integrations/
  skillscope-codex/       Codex slash prompt integration
  claude-code/            Claude Code /skillscope command template
skills/
  skillscope-analyzer/    skill that guides local agent analysis
docs/
  capture-and-analysis.md capture contract
```

## Status

Alpha. The current focus is local-first, evidence-backed skill coverage for real Codex and Claude Code trajectories.
