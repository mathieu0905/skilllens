SkillLens 需求文档
1. 项目定位
SkillLens 是一个面向 agent skill 作者和评测者的可视化工具，用来分析：
一个 SKILL.md 里的指令，在真实 agent 轨迹中是否被体现；
哪些 skill 片段被使用、被忽略、被违反，或无法从轨迹判断；
成功轨迹与失败轨迹之间，哪些 skill 指令更可能产生了差异；
skill 版本修改后，覆盖率和失败模式是否改善。
一句话定位：
Like code coverage, but for agent skills.

第一版不做新的 agent 平台，不做通用 observability，不做 benchmark 本身。第一版只做一个“skill-aware trace viewer + coverage analyzer”。
2. 背景与机会
现在 Claude Code、Codex、Cursor、各类 coding agent 都开始支持 skills / rules / memories / playbooks 这类显式指导文件。问题是：
skill 写完之后，很难知道 agent 是否真的遵守；
失败时不知道是模型能力问题、轨迹问题，还是 skill 写得不好；
现有 trace viewer 主要按时间线展示 tool call，不理解 skill 文本；
现有 eval 平台主要看最终分数，不解释 skill 的哪部分有效。
SkillLens 的切口是：把 SKILL.md 和 agent trajectory 对齐，形成“指令级覆盖分析”。
3. 目标用户
3.1 核心用户
写 Claude/Codex/agent skills 的开发者；
做 agent benchmark / eval 的研究者；
做内部 coding agent 工具链的工程团队；
想维护一组 reusable skills 的开源社区。
3.2 第一批使用场景
我写了一个 SKILL.md，想知道它有没有被 agent 用上；
我有一批成功/失败轨迹，想看失败是不是因为 agent 没按 skill 做；
我想改 skill，但需要 evidence-backed rewrite suggestions；
我想比较 with-skill 和 no-skill 的轨迹差异。
4. 数据源策略
4.1 第一阶段主数据源：SkillsBench / BenchFlow
使用公开数据源：
SkillsBench GitHub: https://github.com/benchflow-ai/skillsbench
SkillsBench dataset: https://huggingface.co/datasets/benchflow/skillsbench
SkillsBench leaderboard/evidence archive: https://huggingface.co/datasets/benchflow/skillsbench-leaderboard
理由：
它是专门围绕 agent skills 的 benchmark；
任务目录里有 task、environment、skills、oracle/verifier；
leaderboard archive 包含 public submissions 和 raw trial artifacts；
trajectory evidence 里有 trajectory/acp_trajectory.jsonl，可作为第一版分析对象；
有 with-skill / no-skill 结果，适合做对照可视化。
注意：
leaderboard archive 很大，不能第一版全量下载；
第一版只支持按 task / submission / trial 精确下载小样本；
本地缓存原始文件，避免反复请求 Hugging Face。
4.2 第二阶段数据源
Skillgrade: https://github.com/mgechev/skillgrade可作为 skill eval report/session log 的兼容格式；
适合用户自己跑 agent 后导入报告。

用户本地 Codex / Claude Code JSONL 轨迹；
Langfuse / AgentOps / Weave 导出的 trace JSON；
手动上传的 SKILL.md + trace.jsonl + result.json。
5. MVP 范围
5.1 MVP 必须做
数据导入
支持从本地选择或上传：SKILL.md
acp_trajectory.jsonl
result.json
可选 task.md

支持从 SkillsBench leaderboard URL 导入单个 trial。

Skill 解析
将 SKILL.md 切成 instruction units；
保留 Markdown 层级结构；
每个 instruction unit 有稳定 ID、标题路径、正文、行号范围。

Trajectory 解析
解析 agent messages、tool calls、tool outputs、file edits、commands；
按时间线展示；
支持从轨迹中提取 evidence spans。

Coverage 分析
对每条 instruction unit 输出：covered: 有明显行为证据；
missed: 应该执行但没有执行；
violated: 轨迹行为与指令冲突；
not_applicable: 当前任务不适用；
unknown: 轨迹不足以判断；

每个判断必须带 evidence span；
每个判断必须带 confidence。

可视化页面
Skill heatmap view；
Trace timeline view；
Evidence detail panel；
Coverage summary metrics；
with-skill vs no-skill 对比视图。

导出
导出 HTML report；
导出 JSON analysis；
导出 Markdown review report。

5.2 MVP 不做
不做在线跑 agent；
不做完整 benchmark runner；
不做通用 Langfuse 替代品；
不做团队权限、多租户、计费；
不做大规模自动 skill 生成；
不承诺自动修复 skill，只给 evidence-backed suggestions。
6. 核心页面设计
6.1 首页 / 数据导入页
目标：让用户快速打开一个 trial。
功能：
上传 SKILL.md；
上传或粘贴 trajectory JSONL；
上传 result.json；
输入 SkillsBench trial URL；
最近打开的本地样本列表。
第一版推荐提供内置 demo：
edit-pdf with-skill trajectory；
一个 no-skill 对照；
一个成功样本；
一个失败样本。
6.2 Skill Coverage 页面
布局：
左侧：SKILL.md 结构树；
中间：skill 正文，按 instruction unit 高亮；
右侧：当前选中 instruction 的证据、判断、建议。
颜色语义：
绿色：covered；
红色：violated；
橙色：missed；
灰色：not applicable；
蓝色：unknown / needs review。
每个 instruction unit 展示：
status；
confidence；
evidence count；
related trace steps；
suggested rewrite。
6.3 Trace Timeline 页面
目标：不是普通日志，而是“带 skill 关联的轨迹”。
每个 timeline event 显示：
event type：assistant message / tool call / command / file edit / observation；
timestamp 或 step index；
compact content；
related skill units；
pass/fail relevance。
支持筛选：
只看和 skill 有关的事件；
只看 violation；
只看 missed instruction 周围的事件；
只看 tool calls；
只看 final answer 前后。
6.4 对比页面
比较对象：
with-skill vs no-skill；
success vs failure；
skill v1 vs skill v2；
同一 task 的不同模型轨迹。
展示：
coverage delta；
violated instruction delta；
tool usage delta；
trajectory length delta；
result/reward delta；
哪些 skill unit 只在成功轨迹中被体现。
6.5 Report 页面
自动生成一份简短分析报告：
这个 skill 的整体覆盖率；
最有用的 3 条 instruction；
最常被忽略的 3 条 instruction；
可能过长、过泛、不可观测的 instruction；
建议如何重写；
相关证据链接。
7. 分析算法
7.1 Instruction Unit 切分
输入：SKILL.md
输出：
{
  "id": "skill.unit.12",
  "heading_path": ["Build", "Verification"],
  "text": "Run the test suite before final response.",
  "line_start": 42,
  "line_end": 44,
  "modality": "mandatory",
  "observable": true
}
切分规则：
Markdown heading 形成层级；
bullet / numbered list 通常是一条 instruction；
含 MUST / NEVER / Always / Do not 的句子单独切；
长段落按句子再切，但保留父段落；
太泛的段落标记为 low-observability。
7.2 Trajectory Event 归一化
将不同来源统一成内部格式：
{
  "id": "trace.event.83",
  "step": 83,
  "role": "assistant",
  "type": "tool_call",
  "name": "exec_command",
  "content": "npm test",
  "output": "...",
  "files": ["package.json"],
  "time": null
}
第一版只需要支持：
ACP trajectory JSONL；
简单 role/content JSONL；
手动 mock demo JSON。
7.3 Skill-to-Trace 对齐
第一版采用三层策略：
Lexical retrieval
BM25 / keyword match；
instruction text 与 trace event content 对齐。

Structured signal
如果 instruction 提到 test，查找 npm test、pytest、cargo test 等命令；
如果 instruction 提到 screenshot，查找 browser/screenshot 事件；
如果 instruction 提到 edit/apply patch，查找 file edit；
如果 instruction 提到 final answer，查找最后 assistant response。

LLM judge
只对候选 instruction-event pair 判断；
输出 structured JSON；
必须引用 evidence event IDs；
不允许无证据判断 covered。

7.4 Coverage 判定 schema
{
  "unit_id": "skill.unit.12",
  "status": "covered",
  "confidence": 0.82,
  "rationale": "The agent ran npm test before the final response.",
  "evidence_event_ids": ["trace.event.83", "trace.event.84"],
  "counter_evidence_event_ids": [],
  "suggested_rewrite": null
}
状态定义：
covered: 轨迹中有明确行为证据；
missed: instruction 明显适用于任务，但轨迹没有执行；
violated: 轨迹出现相反行为；
not_applicable: 当前任务不需要；
unknown: 证据不足。
8. 技术架构
8.1 推荐技术栈
前端：
Next.js / React；
Tailwind；
shadcn/ui 或 Radix primitives；
Monaco Editor 或 CodeMirror 用于 SKILL.md 高亮；
TanStack Table 用于事件列表；
Zustand 或 URL state 保存筛选状态。
后端：
Python FastAPI；
SQLite / DuckDB 存本地分析结果；
huggingface_hub 按需下载；
tantivy / rank-bm25 / SQLite FTS 做检索；
可选 OpenAI-compatible LLM API 做 judge。
任务队列：
第一版可以不用队列；
如果分析超过 30 秒，再加 Celery/RQ/Arq。
部署：
Docker Compose；
一个 web 服务；
一个 API 服务；
一个 volume 存缓存和分析结果。
8.2 目录结构建议
skilllens/
  apps/
    web/
    api/
  packages/
    schema/
    parsers/
  data/
    samples/
  docs/
    prd.md
    sources.md
  docker-compose.yml
  README.md
如果想快速开工，也可以先单 repo：
skilllens/
  frontend/
  backend/
  sample_data/
  docs/
8.3 API 草案
POST /api/projects
POST /api/projects/{id}/upload
POST /api/projects/{id}/import/skillsbench
POST /api/projects/{id}/analyze
GET  /api/projects/{id}
GET  /api/projects/{id}/skill-units
GET  /api/projects/{id}/trace-events
GET  /api/projects/{id}/coverage
GET  /api/projects/{id}/report.md
8.4 数据库表
projects
  id
  name
  source_type
  source_url
  created_at

artifacts
  id
  project_id
  kind
  path
  sha256

skill_units
  id
  project_id
  parent_id
  heading_path
  text
  line_start
  line_end
  modality
  observable

trace_events
  id
  project_id
  step
  role
  event_type
  name
  content
  output
  raw_json

coverage_findings
  id
  project_id
  skill_unit_id
  status
  confidence
  rationale
  evidence_event_ids
  suggested_rewrite
9. 第一阶段开发计划
Phase 0: 数据打通
目标：能加载一个真实 SkillsBench trial。
任务：
找到 2-3 个可下载的小样本；
写 downloader；
解析 SKILL.md；
解析 acp_trajectory.jsonl；
输出 normalized JSON。
验收：
本地有 sample_project.json；
至少包含 skill units、trace events、result metadata。
Phase 1: 静态可视化
目标：不用 LLM，先做 viewer。
任务：
Skill markdown 高亮；
Trace timeline；
点击 skill unit 能看到候选 trace events；
点击 trace event 能看到相关 skill units。
验收：
能打开 demo；
能看清 skill 与轨迹的基本关系。
Phase 2: Coverage 分析
目标：输出 instruction-level coverage。
任务：
实现 rule-based coverage；
实现 BM25 candidate retrieval；
可选接入 LLM judge；
生成 coverage findings。
验收：
每条 skill unit 都有 status；
每个 covered/violated/missed 都有 evidence；
能导出 JSON 和 Markdown report。
Phase 3: 对比视图
目标：形成产品亮点。
任务：
支持两个 project/trial 对比；
展示 coverage delta；
展示 success-only / failure-only skill usage；
生成对比报告。
验收：
可以比较 with-skill vs no-skill；
可以比较 success vs failure。
10. 成功指标
10.1 产品指标
5 分钟内打开一个 SkillsBench trajectory；
30 秒内完成一次 coverage 分析；
每条 covered/missed/violated 判断都有 evidence；
用户能从报告里找到至少 1 条可操作的 skill 修改建议。
10.2 开源传播指标
README 第一屏必须清楚展示：
一个 SKILL.md 热力图截图；
一个 trace timeline 截图；
一个 with-skill vs no-skill 对比截图；
一条一句话定位：Like code coverage, but for agent skills。
Demo 必须零配置：
docker compose up
或者：
npm install
npm run dev
11. 风险与规避
风险 1: 公开 trajectory 格式复杂
规避：
第一版只支持 ACP JSONL；
所有 parser 都输出 normalized event schema；
原始 JSON 保留，不丢信息。
风险 2: Coverage 判断不可靠
规避：
不做黑盒总分；
每个判断都必须显示证据；
低置信度显示为 unknown；
默认允许用户手动修正 status。
风险 3: 数据太大
规避：
不全量下载；
支持 URL-level import；
缓存按 artifact sha256 去重；
内置小样本 demo。
风险 4: 容易被看成 Langfuse/AgentOps 竞品
规避：
README 明确：不是 observability platform；
专注 skill text coverage；
支持从 Langfuse/AgentOps 导出导入，而不是替代它们。
12. README 首屏草案
# SkillLens

Visual coverage for agent skills.

SkillLens maps `SKILL.md` instructions back to real agent trajectories, showing
which instructions were followed, missed, violated, or impossible to judge.

It is not another agent runner or tracing platform. It is a skill-aware lens on
top of existing trajectories.

## Features

- Skill heatmap for `SKILL.md`
- Agent trajectory timeline
- Evidence-backed instruction coverage
- With-skill vs no-skill comparison
- Markdown/HTML report export
- SkillsBench trajectory import
13. 第一版最小 demo 路径
推荐服务器开工顺序：
建 repo；
先放一个 mock sample，做 UI；
再接 SkillsBench downloader；
再接真实 ACP parser；
最后接 coverage analyzer。
不要一开始就追求自动修 skill。第一版只要做到：
上传 skill + trace，然后把 skill 每一条指令和真实轨迹证据对应起来。

这个已经足够形成开源项目的清晰差异化