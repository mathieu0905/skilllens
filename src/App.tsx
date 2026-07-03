import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Clock3,
  Code2,
  Copy,
  Download,
  FileJson,
  FileText,
  GitBranch,
  GitCompare,
  HelpCircle,
  Link2,
  ListFilter,
  PencilLine,
  RefreshCw,
  Search,
  Upload,
  XCircle
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { demoProjects, sampleInputs } from "./data/samples";
import { analyzeCoverage, findCandidates, summarizeCoverage } from "./lib/coverage";
import { createProject, createProjectFromCaptureBundle } from "./lib/project";
import { exportAnalysisJson, exportHtmlReport, generateMarkdownReport, percent } from "./lib/report";
import { truncate } from "./lib/text";
import { skillsBenchShowcaseCases, type SkillsBenchShowcaseCase } from "./data/skillsbenchResults";
import type {
  CaptureBundle,
  CaptureRegistryEntry,
  CoverageFinding,
  CoverageStatus,
  SkillGraphArtifact,
  SkillGraphArtifactEdge,
  SkillGraphArtifactNode as AgentSkillGraphNode,
  SkillConstraint,
  SkillLensProject,
  SkillUnit,
  TraceEvent
} from "./lib/types";

type View = "coverage" | "graph" | "timeline" | "compare" | "analysis" | "monitor" | "experiments" | "rewrite" | "report";
type TimelineFilter = "all" | "skill" | "violations" | "tools" | "final";
type Locale = "zh" | "en";
type JobFilter = "active" | "issues" | "recent" | "stale" | "docker";
type JobSort = "attention" | "updated" | "runtime" | "title";

const TIMELINE_PAGE_SIZE = 120;

interface LocalSession {
  id: string;
  path: string;
  cwd: string;
  projectKey: string;
  project: string;
  repositoryUrl?: string;
  worktreeLabel?: string;
  agentProduct: "codex" | "claude_code";
  cliVersion?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  usedSkills: string[];
  skillPaths: string[];
  skillEvidenceCount: number;
}

interface LocalProject {
  key: string;
  cwd: string;
  project: string;
  sessionCount: number;
  skillUseCount: number;
  latestAt: string;
  repositoryUrl?: string;
  worktreeCount: number;
  usedSkills: string[];
}

interface LocalSkillUse {
  id: string;
  sessionId: string;
  path: string;
  cwd: string;
  projectKey: string;
  project: string;
  repositoryUrl?: string;
  worktreeLabel?: string;
  agentProduct: "codex" | "claude_code";
  skillName: string;
  skillPath: string;
  title: string;
  startStep: number;
  endStep: number;
  evidenceStep: number;
  createdAt: string;
  updatedAt: string;
}

interface DisplayConstraint {
  id: string;
  kind: string;
  text: string;
  span: SkillConstraint["span"];
}

interface SkillGraphNode {
  id: string;
  graphNodeId?: string;
  unitId: string;
  constraintId?: string;
  parentGraphNodeId?: string;
  heading: string;
  edgeLabel?: string;
  depth: number;
  text: string;
  kind: string;
  status: CoverageStatus;
  confidence: number;
  lineStart: number;
  lineEnd: number;
  evidenceEventIds: string[];
  finding: CoverageFinding;
  isCondition: boolean;
  branchState: "taken" | "not_taken" | "checked" | "unknown";
}

interface SkillGraphSection {
  id: string;
  title: string;
  nodes: SkillGraphNode[];
}

interface SkillGraph {
  nodes: SkillGraphNode[];
  sections: SkillGraphSection[];
  pathNodes: SkillGraphNode[];
  takenBranches: SkillGraphNode[];
  skippedBranches: SkillGraphNode[];
  riskNodes: SkillGraphNode[];
  source: "agent" | "derived";
  edges: SkillGraphArtifactEdge[];
}

interface LocalSessionIndexMeta {
  updatedAt?: string;
  source?: string;
}

interface AnalysisStep {
  label: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
}

interface AgentAnalysisAudit {
  runner: string;
  requestId: string;
  cacheKey?: string;
  cached?: boolean;
  workDir?: string;
  analyzerSkillPath?: string;
  requestPath?: string;
  promptPath?: string;
  selectedSkillPath?: string;
  constraintSeedPath?: string;
  traceEventsPath?: string;
  traceFactsPath?: string;
  rawTracePath?: string;
  progressPath?: string;
  constraintsPath?: string;
  rawOutputPath?: string;
  responsePath?: string;
  findingsPath?: string;
  skillGraphPath?: string;
  optimizerSkillPath?: string;
  optimizationPromptPath?: string;
  optimizedSkillPath?: string;
  optimizationReportPath?: string;
  optimizationDiffPath?: string;
  optimizationPacketPath?: string;
  optimizerRawOutputPath?: string;
  optimizedSkill?: string;
  steps?: Array<{ label: string; detail?: string; durationMs?: number }>;
  judgedCount?: number;
  structuredJudgments?: number;
  rawAnalysis?: string;
}

interface AgentLiveEvent {
  kind: "json" | "text";
  at: string;
  payload: unknown;
}

interface AgentProcessEvent {
  id: string;
  requestId?: string;
  command: string;
  args: string[];
  cwd: string;
  pid?: number;
  ppid?: number;
  pgid?: number;
  agentRootPid?: number;
  agentRootCommand?: "codex" | "claude" | "unknown";
  agentRootLabel?: string;
  association?: "ancestor" | "process_group" | "self" | "unlinked";
  status: "started" | "running" | "exited" | "failed" | "killed";
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  outputPath?: string;
  promptPath?: string;
  tracePath?: string;
  traceSize?: number;
  traceMtime?: string;
  artifactPaths?: Array<{ label: string; path: string; size?: number; mtime?: string }>;
  dockerContainers?: string[];
  managedBySkillScope?: boolean;
  canStop?: boolean;
  canStopGroup?: boolean;
  error?: string;
}

interface AgentJobArtifact {
  label: string;
  path: string;
  size?: number;
  mtime?: string;
}

interface AgentJobContainer {
  name: string;
  source?: "docker-name" | "compose-project";
  project?: string;
}

interface AgentJobProgress {
  label: string;
  detail: string;
  percent?: number;
  updatedAt?: string;
  latestLine?: string;
}

interface AgentStopPlan {
  jobId: string;
  processTargets: Array<{ pid?: number; pgid?: number; command: string; reason: string }>;
  containers: AgentJobContainer[];
  protectedRoot?: { pid?: number; label?: string; reason: string };
  warnings: string[];
}

interface AgentStopResult {
  jobId: string;
  requestedAt: string;
  signal: string;
  killedProcesses: Array<{ pid?: number; pgid?: number; ok: boolean; error?: string }>;
  removedContainers: Array<{ name: string; ok: boolean; error?: string }>;
  residualProcesses?: Array<{ pid?: number; pgid?: number; command?: string }>;
  residualContainers?: string[];
  cleanupErrors: string[];
}

interface AgentJob {
  id: string;
  title: string;
  status: "active" | "recent" | "stale" | "stopped" | "failed";
  agentRoot?: {
    pid?: number;
    command?: "codex" | "claude" | "unknown";
    label?: string;
    protected: boolean;
  };
  startedAt: string;
  lastUpdatedAt: string;
  staleSeconds: number;
  processes: AgentProcessEvent[];
  containers: AgentJobContainer[];
  artifacts: AgentJobArtifact[];
  progress: AgentJobProgress;
  canStop: boolean;
  stopPlan?: AgentStopPlan;
  lastStopResult?: AgentStopResult;
  historyPath?: string;
}

interface TraceTailState {
  path: string;
  offset: number;
  nextOffset: number;
  size: number;
  mtime: string;
  content: string;
  updatedAt: string;
  error?: string;
}

interface ProcessProgressState {
  label: string;
  detail: string;
  percent?: number;
  updatedAt?: string;
}

const LocaleContext = createContext<Locale>("zh");

const statusMeta: Record<
  CoverageStatus,
  {
    label: string;
    icon: typeof CheckCircle2;
  }
> = {
  covered: { label: "遵循", icon: CheckCircle2 },
  missed: { label: "忽略", icon: AlertTriangle },
  violated: { label: "违反", icon: XCircle },
  not_applicable: { label: "未走", icon: Clock3 },
  unknown: { label: "待判断", icon: HelpCircle }
};

const copy = {
  zh: {
    tagline: "像代码覆盖率一样看 agent skills。",
    languageToggle: "EN",
    exportJson: "导出 JSON",
    status: {
      covered: "遵循",
      missed: "忽略",
      violated: "违反",
      not_applicable: "未走",
      unknown: "待判断"
    } satisfies Record<CoverageStatus, string>,
    views: {
      coverage: "Skill 高亮",
      graph: "Skill 图",
      timeline: "轨迹",
      compare: "对比",
      analysis: "分析过程",
      monitor: "进程监控",
      experiments: "实验结果",
      rewrite: "优化 Skill",
      report: "报告"
    } satisfies Record<View, string>,
    timelineFilters: {
      all: "全部",
      skill: "相关",
      violations: "违反/忽略",
      tools: "工具",
      final: "最后"
    } satisfies Record<TimelineFilter, string>,
    home: {
      title: "选择一次 Skill 使用",
      subtitle: "左侧选项目，右侧选 skill 使用窗口。每个窗口只截取该 skill 使用到结束或下一次人类介入的轨迹。",
      indexMissing: "本地索引未加载",
      refresh: "刷新索引",
      demo: "打开 demo",
      searchPlaceholder: "搜索项目、路径、skill、用户请求或 session",
      allProjects: "全部用了 skill 的项目",
      skillUseColumn: "Skill 使用窗口",
      indexing: "正在索引本机 skill 使用记录...",
      noSkillUses: "没有找到可证明使用了 skill 的 Codex / Claude Code 片段。",
      open: "打开",
      opening: "opening..."
    },
    opening: {
      title: "正在打开 skill 使用窗口",
      note: "只加载这个 skill-use 片段；coverage 判定会在点击“启动分析”后运行。"
    },
    app: {
      back: "返回列表",
      currentWindow: "当前窗口",
      analyzing: "分析中...",
      startAnalysis: "启动分析",
      reanalyze: "重新分析",
      import: "导入",
      localArtifacts: "本地文件",
      analyzeUpload: "分析上传",
      importUrl: "导入 URL",
      switchCapture: "切换 capture / 片段",
      sessionSegments: "Session 片段",
      fullSession: "完整 session",
      constraints: "constraints",
      needsJudge: "待启动 agent judge",
      applicable: "适用",
      skippedBranchesCollapsed: "未走分支 {count} 已折叠",
      confidence: "置信度",
      viewHighlights: "查看高亮"
    },
    coverage: {
      judgmentEvidence: "判断与证据",
      skillConstraint: "Skill 约束",
      evidenceSpans: "证据片段",
      noDirectEvidence: "没有直接证据。",
      localCandidates: "本地候选轨迹",
      rewrite: "改写建议",
      manualReview: "人工修正",
      selectConstraint: "选择一条高亮约束。",
      priority: "优先看",
      source: "SKILL.md 原文",
      needsReview: "待看",
      noFinding: "No coverage finding was generated.",
      noEvidenceTooltip: "No evidence span. Click for details."
    },
    graph: {
      skippedBranches: "未走分支",
      sourceDerived: "从 coverage findings 自动推断",
      condition: "条件",
      tracePath: "Trace 路径",
      currentNode: "当前节点",
      evidenceEvents: "证据事件",
      noEvidence: "这个节点没有直接证据事件。",
      empty: "还没有可绘制的 skill graph。",
      takenConditions: "走过的条件",
      noTakenConditions: "没有识别到已走条件。",
      noSkippedBranches: "没有未走分支。",
      branchNotTaken: "未走分支",
      branchTaken: "已走条件",
      branchUnknown: "路径未知",
      branchChecked: "已检查",
      kind: {
        action: "动作",
        prohibition: "禁止",
        order: "顺序",
        numeric: "数值",
        command: "命令",
        file_reference: "文件",
        evidence: "证据",
        condition: "条件",
        other: "约束"
      } as Record<string, string>
    },
    timeline: {
      loadMore: "展开更多事件",
      details: "事件详情",
      relatedConstraints: "关联 Skill 约束",
      noRelated: "没有关联约束。",
      selectEvent: "选择一个轨迹事件。"
    },
    analysis: {
      defaultStep: "等待启动分析",
      defaultStepDetail: "点击右上角“启动分析”后，这里会显示 Codex / Claude judge 的执行过程。",
      running: "正在分析",
      failed: "分析失败",
      done: "分析完成",
      title: "分析过程",
      intro: "前端选择 skill-use 后，由本地 Codex / Claude Code 完成约束抽取和证据判断。",
      final: "Agent 最终分析",
      realtime: "Agent 实时输出",
      rawEvent: "原始事件",
      cachedEmpty: "这次命中缓存，没有启动 Codex / Claude，所以没有实时 agent 输出。点击“重新分析”可以强制启动 agent。",
      waitingContent: "Codex / Claude 输出实际内容后，会在这里显示。",
      debugFiles: "本地调试文件",
      debugEmpty: "分析启动后会显示 request、prompt、原始输出和解析结果的文件路径。",
      cacheHit: "命中分析缓存",
      cacheHitBody: "这次没有重新启动 agent，直接读取已保存的分析结果。",
      createThread: "创建分析线程",
      startTurn: "开始一轮判断",
      startTurnBody: "Agent 开始读取 judge 请求。",
      stepDone: "完成一步",
      retrying: "上游连接重试中",
      log: "运行日志",
      output: "输出",
      error: "出错",
      toolCall: "调用工具",
      agentOutput: "Agent 输出",
      structured: "Agent 返回结构化判断",
      content: "Agent 输出分析内容",
      search: "检索事件",
      toolDone: "工具完成",
      unnamedConstraint: "未命名约束",
      judgments: "条判断"
    },
    rewrite: {
      title: "优化后的 Skill 草案",
      subtitle: "根据当前 violated / ignored findings 反向生成；每条改写都保留证据来源，适合人工确认后再合并回 SKILL.md。",
      emptyTitle: "还没有足够证据生成改写",
      emptyBody: "先运行 agent 分析，或选择一个已有 violated / ignored findings 的 skill-use window。",
      copy: "复制 Markdown",
      download: "下载 optimized-skill.md",
      source: "证据来源",
      violated: "需要收紧的违反点",
      missed: "需要前置或具体化的忽略点",
      proposedPatch: "建议追加/替换的 Skill 片段",
      noEvidence: "没有证据事件"
    },
    sessionLibrary: {
      title: "Session Library",
      subtitle: "选择任意项目的 Codex / Claude Code session",
      allProjects: "全部项目"
    }
  },
  en: {
    tagline: "Like code coverage, but for agent skills.",
    languageToggle: "中文",
    exportJson: "Export JSON",
    status: {
      covered: "Followed",
      missed: "Ignored",
      violated: "Violated",
      not_applicable: "Not taken",
      unknown: "Needs review"
    } satisfies Record<CoverageStatus, string>,
    views: {
      coverage: "Skill Highlight",
      graph: "Skill Graph",
      timeline: "Trace",
      compare: "Compare",
      analysis: "Analysis",
      monitor: "Monitor",
      experiments: "Experiments",
      rewrite: "Rewrite Skill",
      report: "Report"
    } satisfies Record<View, string>,
    timelineFilters: {
      all: "All",
      skill: "Skill-linked",
      violations: "Violated/Ignored",
      tools: "Tools",
      final: "Final"
    } satisfies Record<TimelineFilter, string>,
    home: {
      title: "Choose A Skill Use",
      subtitle: "Pick a project on the left, then one skill-use window on the right. Each window spans from the skill use to completion or the next human intervention.",
      indexMissing: "Local index not loaded",
      refresh: "Refresh Index",
      demo: "Open Demo",
      searchPlaceholder: "Search projects, paths, skills, user requests, or sessions",
      allProjects: "All projects with skill use",
      skillUseColumn: "Skill-Use Windows",
      indexing: "Indexing local skill-use records...",
      noSkillUses: "No provable Codex / Claude Code skill-use windows were found.",
      open: "Open",
      opening: "opening..."
    },
    opening: {
      title: "Opening skill-use window",
      note: "Only this skill-use segment is loaded; coverage judgment runs after you click Start Analysis."
    },
    app: {
      back: "Back",
      currentWindow: "Current Window",
      analyzing: "Analyzing...",
      startAnalysis: "Start Analysis",
      reanalyze: "Reanalyze",
      import: "Import",
      localArtifacts: "Local Artifacts",
      analyzeUpload: "Analyze Upload",
      importUrl: "Import URL",
      switchCapture: "Switch capture / segment",
      sessionSegments: "Session Segments",
      fullSession: "Full session",
      constraints: "constraints",
      needsJudge: "Agent judge pending",
      applicable: "Applicable",
      skippedBranchesCollapsed: "{count} not-taken branches folded",
      confidence: "Confidence",
      viewHighlights: "View Highlights"
    },
    coverage: {
      judgmentEvidence: "Judgment And Evidence",
      skillConstraint: "Skill Constraint",
      evidenceSpans: "Evidence Spans",
      noDirectEvidence: "No direct evidence.",
      localCandidates: "Local Candidate Trace Events",
      rewrite: "Rewrite Suggestion",
      manualReview: "Manual Review",
      selectConstraint: "Select a highlighted constraint.",
      priority: "Review first",
      source: "SKILL.md Source",
      needsReview: "Review",
      noFinding: "No coverage finding was generated.",
      noEvidenceTooltip: "No evidence span. Click for details."
    },
    graph: {
      skippedBranches: "Not-Taken Branches",
      sourceDerived: "Derived from coverage findings",
      condition: "Condition",
      tracePath: "Trace Path",
      currentNode: "Current Node",
      evidenceEvents: "Evidence Events",
      noEvidence: "This node has no direct evidence event.",
      empty: "No drawable skill graph yet.",
      takenConditions: "Taken Conditions",
      noTakenConditions: "No taken conditions detected.",
      noSkippedBranches: "No not-taken branches.",
      branchNotTaken: "Not taken",
      branchTaken: "Taken",
      branchUnknown: "Path unknown",
      branchChecked: "Checked",
      kind: {
        action: "Action",
        prohibition: "Prohibition",
        order: "Order",
        numeric: "Numeric",
        command: "Command",
        file_reference: "File",
        evidence: "Evidence",
        condition: "Condition",
        other: "Constraint"
      } as Record<string, string>
    },
    timeline: {
      loadMore: "Load More Events",
      details: "Event Details",
      relatedConstraints: "Related Skill Constraints",
      noRelated: "No related constraints.",
      selectEvent: "Select a trace event."
    },
    analysis: {
      defaultStep: "Waiting To Start",
      defaultStepDetail: "After you click Start Analysis, Codex / Claude judge progress appears here.",
      running: "Analyzing",
      failed: "Analysis Failed",
      done: "Analysis Complete",
      title: "Analysis Process",
      intro: "After the frontend selects a skill-use window, local Codex / Claude Code extracts constraints and judges evidence.",
      final: "Agent Final Analysis",
      realtime: "Agent Live Output",
      rawEvent: "Raw Event",
      cachedEmpty: "This run hit cache, so no live agent output exists. Click Reanalyze to force a new agent run.",
      waitingContent: "Codex / Claude output with actual content will appear here.",
      debugFiles: "Local Debug Files",
      debugEmpty: "After analysis starts, request, prompt, raw output, and parsed result paths appear here.",
      cacheHit: "Analysis Cache Hit",
      cacheHitBody: "This run reused saved analysis instead of starting the agent.",
      createThread: "Created Analysis Thread",
      startTurn: "Started Judge Turn",
      startTurnBody: "Agent started reading the judge request.",
      stepDone: "Step Complete",
      retrying: "Upstream reconnecting",
      log: "Runtime Log",
      output: "Output",
      error: "Error",
      toolCall: "Tool Call",
      agentOutput: "Agent Output",
      structured: "Agent Returned Structured Judgments",
      content: "Agent Analysis Content",
      search: "Search Event",
      toolDone: "Tool Complete",
      unnamedConstraint: "Unnamed constraint",
      judgments: "judgments"
    },
    rewrite: {
      title: "Optimized Skill Draft",
      subtitle: "Generated from current violated / ignored findings with evidence references, intended for human review before merging back into SKILL.md.",
      emptyTitle: "Not enough evidence to draft a rewrite",
      emptyBody: "Run agent analysis first, or open a skill-use window with violated / ignored findings.",
      copy: "Copy Markdown",
      download: "Download optimized-skill.md",
      source: "Evidence Source",
      violated: "Violation points to tighten",
      missed: "Ignored points to make earlier or more concrete",
      proposedPatch: "Suggested Skill Snippet",
      noEvidence: "No evidence event"
    },
    sessionLibrary: {
      title: "Session Library",
      subtitle: "Select any Codex / Claude Code session from any project",
      allProjects: "All projects"
    }
  }
};

const viewIcons: Record<View, typeof FileText> = {
  coverage: FileText,
  graph: GitBranch,
  timeline: ListFilter,
  compare: GitCompare,
  analysis: Code2,
  monitor: Activity,
  experiments: BarChart3,
  rewrite: PencilLine,
  report: FileJson
};

function initialLocale(): Locale {
  if (typeof window === "undefined") {
    return "zh";
  }
  const saved = window.localStorage.getItem("skilllens.locale");
  if (saved === "zh" || saved === "en") {
    return saved;
  }
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function useLocale(): Locale {
  return useContext(LocaleContext);
}

function ui(locale: Locale) {
  return copy[locale];
}

function statusLabel(status: CoverageStatus, locale: Locale): string {
  return ui(locale).status[status];
}

function viewLabelsFor(locale: Locale): Array<{ id: View; label: string; icon: typeof FileText }> {
  return (Object.keys(viewIcons) as View[])
    .filter((id) => id !== "monitor" && id !== "experiments")
    .map((id) => ({ id, label: ui(locale).views[id], icon: viewIcons[id] }));
}

function initialViewFromUrl(): View {
  if (typeof window === "undefined") {
    return "coverage";
  }
  const value = new URLSearchParams(window.location.search).get("view");
  return value === "coverage" ||
    value === "graph" ||
    value === "timeline" ||
    value === "compare" ||
    value === "analysis" ||
    value === "monitor" ||
    value === "experiments" ||
    value === "rewrite" ||
    value === "report"
    ? value
    : "coverage";
}

function initialShowcaseCaseFromUrl(): string {
  if (typeof window === "undefined") {
    return skillsBenchShowcaseCases[0]?.slug ?? "";
  }
  const requested = new URLSearchParams(window.location.search).get("case");
  return skillsBenchShowcaseCases.find((item) => item.slug === requested)?.slug ?? skillsBenchShowcaseCases[0]?.slug ?? "";
}

function App() {
  const [locale, setLocale] = useState<Locale>(() => initialLocale());
  const t = ui(locale);
  const [projects, setProjects] = useState<SkillLensProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [view, setView] = useState<View>(() => initialViewFromUrl());
  const [showcaseCaseSlug, setShowcaseCaseSlug] = useState(() => initialShowcaseCaseFromUrl());
  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? demoProjects[0];
  const compareProject = projects.find((candidate) => candidate.id === compareId) ?? projects.find((candidate) => candidate.id !== project.id) ?? project;
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [activeSegmentId, setActiveSegmentId] = useState("all");
  const [customName, setCustomName] = useState("Imported trace");
  const [skillInput, setSkillInput] = useState(sampleInputs.skillMarkdown);
  const [traceInput, setTraceInput] = useState(sampleInputs.withSkillTrace);
  const [taskInput, setTaskInput] = useState(sampleInputs.taskMarkdown);
  const [resultInput, setResultInput] = useState('{"success": true, "score": 1, "source": "manual import"}');
  const [trialUrl, setTrialUrl] = useState("");
  const [importError, setImportError] = useState("");
  const [captures, setCaptures] = useState<CaptureRegistryEntry[]>([]);
  const [captureProjectKey, setCaptureProjectKey] = useState("all");
  const [localSessions, setLocalSessions] = useState<LocalSession[]>([]);
  const [localSkillUses, setLocalSkillUses] = useState<LocalSkillUse[]>([]);
  const [localProjects, setLocalProjects] = useState<LocalProject[]>([]);
  const [localProjectKey, setLocalProjectKey] = useState("all");
  const [localIndexMeta, setLocalIndexMeta] = useState<LocalSessionIndexMeta>({});
  const [isLoadingLocalSessions, setIsLoadingLocalSessions] = useState(true);
  const [isHome, setIsHome] = useState(() => {
    const initial = initialViewFromUrl();
    return initial !== "monitor" && initial !== "experiments";
  });
  const [capturingSkillUseId, setCapturingSkillUseId] = useState("");
  const [openingSkillUse, setOpeningSkillUse] = useState<LocalSkillUse | null>(null);
  const [isAgentAnalyzing, setIsAgentAnalyzing] = useState(false);
  const [agentAnalysisMessage, setAgentAnalysisMessage] = useState("");
  const [agentAnalysisError, setAgentAnalysisError] = useState("");
  const [analysisSteps, setAnalysisSteps] = useState<AnalysisStep[]>([]);
  const [analysisAudit, setAnalysisAudit] = useState<AgentAnalysisAudit | null>(null);
  const [agentEvents, setAgentEvents] = useState<AgentLiveEvent[]>([]);
  const [agentProcesses, setAgentProcesses] = useState<AgentProcessEvent[]>([]);
  const [traceTails, setTraceTails] = useState<Record<string, TraceTailState>>({});
  const [libraryError, setLibraryError] = useState("");
  const sessionSegments = Array.isArray(project.result.sessionSegments)
    ? (project.result.sessionSegments as Array<{ id: string; title: string; startStep: number; endStep: number }>)
    : [];
  const activeSegment = sessionSegments.find((segment) => segment.id === activeSegmentId);
  const focusedEvents = useMemo(() => {
    if (!activeSegment) {
      return project.events;
    }
    return project.events.filter((event) => event.step >= activeSegment.startStep && event.step <= activeSegment.endStep);
  }, [activeSegment, project.events]);
  const focusedProject = useMemo<SkillLensProject>(() => {
    if (!activeSegment) {
      return project;
    }
    return {
      ...project,
      name: `${project.name} / ${activeSegment.title}`,
      events: focusedEvents,
      findings:
        focusedEvents.length === project.events.length || hasPendingFindings(project)
          ? project.findings
          : analyzeCoverage(project.units, focusedEvents, project.taskMarkdown ?? "")
    };
  }, [activeSegment, focusedEvents, project]);

  useEffect(() => {
    setSelectedEventId("");
    setTimelineFilter("all");
    setActiveSegmentId(sessionSegments[sessionSegments.length - 1]?.id ?? "all");
  }, [project.id]);

  useEffect(() => {
    setSelectedUnitId(riskFindings(focusedProject.findings)[0]?.unitId ?? focusedProject.units[0]?.id ?? "");
    setSelectedEventId("");
  }, [project.id, activeSegmentId]);

  useEffect(() => {
    void loadCaptureRegistry();
    void loadLocalSessions();
  }, []);

  useEffect(() => {
    window.localStorage.setItem("skilllens.locale", locale);
  }, [locale]);

  useEffect(() => {
    if (view === "compare" && projects.length < 2) {
      setView("coverage");
    }
  }, [projects.length, view]);

  const summary = useMemo(() => summarizeCoverage(focusedProject.findings), [focusedProject.findings]);
  const selectedUnit = focusedProject.units.find((unit) => unit.id === selectedUnitId) ?? focusedProject.units[0];
  const selectedFinding = selectedUnit ? bestFindingForUnit(focusedProject.findings, selectedUnit.id) : undefined;
  const selectedEvent = focusedProject.events.find((event) => event.id === selectedEventId);
  const relatedEventIds = new Set(selectedFinding?.evidenceEventIds ?? []);

  const timelineEvents = useMemo(
    () => filterTimeline(focusedProject, timelineFilter),
    [focusedProject, timelineFilter]
  );
  const captureProjectOptions = useMemo(() => groupCapturesByProject(captures), [captures]);
  const visibleCaptures = useMemo(() => {
    if (captureProjectKey === "all") {
      return captures;
    }
    return captures.filter((capture) => captureProjectKeyFor(capture) === captureProjectKey);
  }, [captureProjectKey, captures]);
  const visibleLocalSkillUses = useMemo(() => {
    if (localProjectKey === "all") {
      return localSkillUses;
    }
    return localSkillUses.filter((use) => use.projectKey === localProjectKey);
  }, [localProjectKey, localSkillUses]);
  const visibleViewLabels = useMemo(
    () => viewLabelsFor(locale).filter((item) => item.id !== "compare" || projects.length > 1),
    [locale, projects.length]
  );

  function analyzeCustom(sourceType: SkillLensProject["sourceType"] = "upload", sourceUrl?: string) {
    setImportError("");
    try {
      const result = resultInput.trim() ? JSON.parse(resultInput) : {};
      const imported = createProject(customName || "Imported trace", skillInput, traceInput, result, sourceType, taskInput, sourceUrl);
      setProjects((current) => [imported, ...current]);
      setProjectId(imported.id);
      setIsHome(false);
      if (sourceType === "upload") {
        setCompareId(project.id);
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed.");
    }
  }

  async function loadCaptureRegistry() {
    try {
      const response = await fetch("/api/captures");
      if (!response.ok) {
        return;
      }
      const registry = (await response.json()) as { captures?: CaptureRegistryEntry[] };
      const registryCaptures = registry.captures ?? [];
      setCaptures(registryCaptures);
      const params = new URLSearchParams(window.location.search);
      const requested = params.get("capture");
      const requestedStartStep = numberParam(params.get("segmentStartStep"));
      const requestedEndStep = numberParam(params.get("segmentEndStep"));
      const target = requested ? registryCaptures.find((capture) => capture.id === requested) : undefined;
      if (target) {
        setIsHome(false);
        await loadCapture(target.id, { select: true, segmentStartStep: requestedStartStep, segmentEndStep: requestedEndStep, lazyFindings: true });
      }
    } catch {
      // Static builds do not expose the local capture API.
    }
  }

  async function loadCapture(id: string, options: { select: boolean; segmentStartStep?: number; segmentEndStep?: number; lazyFindings?: boolean }) {
    const response = await fetch(`/api/captures/${encodeURIComponent(id)}`);
    if (!response.ok) {
      return;
    }
    const bundle = (await response.json()) as CaptureBundle;
    const imported = createProjectFromCaptureBundle(bundle, {
      segmentStartStep: options.segmentStartStep,
      segmentEndStep: options.segmentEndStep,
      lazyFindings: options.lazyFindings
    });
    imported.id = `capture-${id}`;
    const analyzedSegment = imported.result.analyzedSegment as { title?: string } | undefined;
    imported.name = [
      projectLabel(bundle.task?.cwd),
      shortSessionTitle(bundle.task?.id ?? bundle.trace.sessionId ?? imported.name),
      analyzedSegment?.title ? shortSessionTitle(analyzedSegment.title) : ""
    ]
      .filter(Boolean)
      .join(" / ");
    const cachedAnalysis = await loadCachedAgentAnalysis(id, options);
      if (cachedAnalysis?.findings?.length) {
      const cachedSkillGraph = skillGraphFromUnknown(cachedAnalysis.skillGraph);
      imported.findings = cachedAnalysis.findings;
      imported.result = {
        ...imported.result,
        ...(cachedSkillGraph ? { skillGraph: cachedSkillGraph } : {}),
        agentJudge: {
          runner: cachedAnalysis.runner,
          requestId: cachedAnalysis.requestId,
          judgedCount: cachedAnalysis.judgedCount,
          completedAt: cachedAnalysis.updatedAt ?? cachedAnalysis.createdAt
        }
      };
      setAnalysisAudit(cachedAnalysis);
      setAgentAnalysisMessage(
        locale === "zh"
          ? `已从本地缓存恢复 ${cachedAnalysis.findings.length} 条分析结果。`
          : `Restored ${cachedAnalysis.findings.length} analysis findings from local cache.`
      );
    }
    setProjects((current) => {
      const withoutDuplicate = current.filter((candidate) => candidate.id !== imported.id);
      return [imported, ...withoutDuplicate];
    });
    if (options.select) {
      setProjectId(imported.id);
      setCompareId(project.id);
      setIsHome(false);
      const params = new URLSearchParams({ capture: id });
      if (typeof options.segmentStartStep === "number") {
        params.set("segmentStartStep", String(options.segmentStartStep));
      }
      if (typeof options.segmentEndStep === "number") {
        params.set("segmentEndStep", String(options.segmentEndStep));
      }
      window.history.replaceState(null, "", `?${params.toString()}`);
    }
  }

  async function loadCachedAgentAnalysis(
    captureId: string,
    options: { segmentStartStep?: number; segmentEndStep?: number }
  ): Promise<(({ findings?: CoverageFinding[]; skillGraph?: SkillGraphArtifact; createdAt?: string; updatedAt?: string } & AgentAnalysisAudit) | null)> {
    const params = new URLSearchParams({ captureId });
    if (typeof options.segmentStartStep === "number") {
      params.set("segmentStartStep", String(options.segmentStartStep));
    }
    if (typeof options.segmentEndStep === "number") {
      params.set("segmentEndStep", String(options.segmentEndStep));
    }
    try {
      const response = await fetch(`/api/agent-analysis/cache?${params.toString()}`);
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as { findings?: CoverageFinding[]; createdAt?: string; updatedAt?: string } & AgentAnalysisAudit;
    } catch {
      return null;
    }
  }

  async function loadLocalSessions(options: { refresh?: boolean } = {}) {
    setIsLoadingLocalSessions(true);
    try {
      const response = await fetch(`/api/local-sessions${options.refresh ? "?refresh=1" : ""}`);
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as {
        sessions?: LocalSession[];
        skillUses?: LocalSkillUse[];
        projects?: LocalProject[];
        updatedAt?: string;
        source?: string;
      };
      setLocalSessions(payload.sessions ?? []);
      setLocalSkillUses(payload.skillUses ?? []);
      setLocalProjects(payload.projects ?? []);
      setLocalIndexMeta({ updatedAt: payload.updatedAt, source: payload.source });
    } catch {
      // Static builds do not expose local machine session discovery.
    } finally {
      setIsLoadingLocalSessions(false);
    }
  }

  async function captureAndLoadSkillUse(skillUse: LocalSkillUse) {
    setLibraryError("");
    setCapturingSkillUseId(skillUse.id);
    setOpeningSkillUse(skillUse);
    setIsHome(false);
    try {
      const response = await fetch("/api/local-sessions/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: skillUse.path,
          cwd: skillUse.cwd,
          skillPaths: [skillUse.skillPath],
          agentProduct: skillUse.agentProduct,
          startStep: skillUse.startStep,
          endStep: skillUse.endStep
        })
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(error?.error ?? `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { captureId: string; targetStartStep?: number; targetEndStep?: number };
      await loadCapture(payload.captureId, {
        select: true,
        segmentStartStep: payload.targetStartStep ?? skillUse.startStep,
        segmentEndStep: payload.targetEndStep ?? skillUse.endStep,
        lazyFindings: true
      });
      void loadCaptureRegistry();
      setIsHome(false);
      setOpeningSkillUse(null);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Failed to open skill use.");
      setIsHome(true);
      setOpeningSkillUse(null);
    } finally {
      setCapturingSkillUseId("");
    }
  }

  function startAgentAnalysis(force = false) {
    setAgentAnalysisError("");
    setAgentAnalysisMessage("");
    setAnalysisAudit(null);
    setAgentEvents([]);
    setAgentProcesses([]);
    setTraceTails({});
    setView("analysis");
    setAnalysisSteps([
      {
        label: locale === "zh" ? "发送分析请求" : "Send analysis request",
        status: "running",
        detail: locale === "zh" ? "把当前 skill-use window 交给本地后端。" : "Send the current skill-use window to the local backend."
      },
      {
        label: locale === "zh" ? "准备 agent 输入" : "Prepare agent inputs",
        status: "pending",
        detail:
          locale === "zh"
            ? "写入 selected-skill、trace-events 和 analyzer skill 启动指令。"
            : "Write selected-skill, trace-events, and analyzer-skill launch instructions."
      },
      {
        label: locale === "zh" ? "运行 Codex / Claude" : "Run Codex / Claude",
        status: "pending",
        detail:
          locale === "zh"
            ? "启动本地 agent，按 analyzer skill 抽取约束并检查 trace。"
            : "Start the local agent, extract constraints with the analyzer skill, and inspect the trace."
      },
      {
        label: locale === "zh" ? "保存结果" : "Save results",
        status: "pending",
        detail: locale === "zh" ? "保存 agent 产物，并更新 skill 高亮和证据。" : "Save agent artifacts and update highlights/evidence."
      }
    ]);
    const captureId = project.id.startsWith("capture-") ? project.id.replace(/^capture-/, "") : "";
    if (!captureId) {
      setAgentAnalysisError(
        locale === "zh"
          ? "只能对从 Codex / Claude Code session 打开的 skill-use 启动 agent 分析。"
          : "Agent analysis can only run on a skill-use opened from a Codex / Claude Code session."
      );
      setAnalysisSteps((current) =>
        markLastStepError(
          current,
          locale === "zh" ? "当前页面不是本地 Codex / Claude Code capture。" : "The current page is not a local Codex / Claude Code capture."
        )
      );
      return;
    }
    setIsAgentAnalyzing(true);
    const activeProjectId = project.id;

    const params = new URLSearchParams({ captureId });
    if (force) {
      params.set("force", "1");
    }
    if (typeof activeSegment?.startStep === "number") {
      params.set("segmentStartStep", String(activeSegment.startStep));
    }
    if (typeof activeSegment?.endStep === "number") {
      params.set("segmentEndStep", String(activeSegment.endStep));
    }
    const source = new EventSource(`/api/agent-analysis/stream?${params.toString()}`);

    source.addEventListener("open", () => {
      setAnalysisSteps((current) =>
        markStepDone(current, locale === "zh" ? "发送分析请求" : "Send analysis request", "SSE stream connected.")
      );
    });
    source.addEventListener("step", (event) => {
      const step = parseEventData<{ label: string; detail?: string; durationMs?: number }>(event);
      if (!step) {
        return;
      }
      setAnalysisSteps((current) => mergeLiveStep(current, step));
    });
    source.addEventListener("agent-json", (event) => {
      const payload = parseEventData<unknown>(event);
      setAgentEvents((current) => [...current.slice(-199), { kind: "json", at: new Date().toISOString(), payload }]);
    });
    source.addEventListener("agent-text", (event) => {
      const payload = parseEventData<{ stream?: string; text?: string }>(event);
      setAgentEvents((current) => [...current.slice(-199), { kind: "text", at: new Date().toISOString(), payload }]);
    });
    source.addEventListener("agent-process", (event) => {
      const payload = parseEventData<AgentProcessEvent>(event);
      if (!payload?.id) {
        return;
      }
      setAgentProcesses((current) => upsertAgentProcess(current, payload));
    });
    source.addEventListener("constraints", (event) => {
      const payload = parseEventData<{ findings: CoverageFinding[]; extractedCount?: number; constraintsPath?: string }>(event);
      if (!payload?.findings?.length) {
        return;
      }
      setProjects((current) =>
        current.map((candidate) =>
          candidate.id === activeProjectId
            ? {
                ...candidate,
                findings: payload.findings,
                result: {
                  ...candidate.result,
                  agentConstraints: {
                    extractedCount: payload.extractedCount ?? payload.findings.length,
                    constraintsPath: payload.constraintsPath,
                    updatedAt: new Date().toISOString()
                  }
                }
              }
            : candidate
        )
      );
      setSelectedUnitId(payload.findings[0]?.unitId ?? selectedUnitId);
      setAgentAnalysisMessage(
        locale === "zh"
          ? `已同步 ${payload.extractedCount ?? payload.findings.length} 条约束到 Skill 高亮。`
          : `Synced ${payload.extractedCount ?? payload.findings.length} constraints to Skill Highlight.`
      );
      setAgentEvents((current) => [
        ...current.slice(-199),
        {
          kind: "text",
          at: new Date().toISOString(),
          payload: {
            stream: "stdout",
            text:
              locale === "zh"
                ? `已识别 ${payload.extractedCount ?? payload.findings.length} 条约束，Skill 高亮已更新。`
                : `Extracted ${payload.extractedCount ?? payload.findings.length} constraints; Skill Highlight has been updated.`
          }
        }
      ]);
    });
    source.addEventListener("skill-graph", (event) => {
      const payload = parseEventData<{ skillGraph?: SkillGraphArtifact; skillGraphPath?: string }>(event);
      const skillGraph = skillGraphFromUnknown(payload?.skillGraph);
      if (!skillGraph) {
        return;
      }
      setProjects((current) =>
        current.map((candidate) =>
          candidate.id === activeProjectId
            ? {
                ...candidate,
                result: {
                  ...candidate.result,
                  skillGraph,
                  agentSkillGraph: {
                    nodeCount: skillGraph.nodes.length,
                    edgeCount: skillGraph.edges.length,
                    pathCount: skillGraph.paths.length,
                    skillGraphPath: payload?.skillGraphPath,
                    updatedAt: new Date().toISOString()
                  }
                }
              }
            : candidate
        )
      );
      setAgentEvents((current) => [
        ...current.slice(-199),
        {
          kind: "text",
          at: new Date().toISOString(),
          payload: {
            stream: "stdout",
            text:
              locale === "zh"
                ? `Skill 图已更新：${skillGraph.nodes.length} 个节点，${skillGraph.edges.length} 条边，${skillGraph.paths.length} 条路径。`
                : `Skill Graph updated: ${skillGraph.nodes.length} nodes, ${skillGraph.edges.length} edges, ${skillGraph.paths.length} paths.`
          }
        }
      ]);
    });
    source.addEventListener("result", (event) => {
      const payload = parseEventData<{
        runner: string;
        requestId: string;
        judgedCount: number;
        structuredJudgments?: number;
        rawAnalysis?: string;
        findings: CoverageFinding[];
        skillGraph?: SkillGraphArtifact;
      } & AgentAnalysisAudit>(event);
      if (!payload) {
        return;
      }
      const skillGraph = skillGraphFromUnknown(payload.skillGraph);
      setAnalysisAudit(payload);
      setAnalysisSteps(stepsFromAudit(payload, "done", undefined, locale));
      setProjects((current) =>
        current.map((candidate) =>
          candidate.id === activeProjectId
            ? {
                ...candidate,
                findings: payload.findings,
                result: {
                  ...candidate.result,
                  ...(skillGraph ? { skillGraph } : {}),
                  agentJudge: {
                    runner: payload.runner,
                    requestId: payload.requestId,
                    judgedCount: payload.judgedCount,
                    completedAt: new Date().toISOString()
                  }
                }
              }
            : candidate
        )
      );
      const structuredCount = payload.structuredJudgments ?? payload.judgedCount ?? 0;
      setAgentAnalysisMessage(
        structuredCount
          ? `${payload.runner} extracted ${structuredCount} structured findings for this skill-use window.`
          : `${payload.runner} completed a free-form analysis for this skill-use window.`
      );
      setIsAgentAnalyzing(false);
      source.close();
    });
    source.addEventListener("analysis-error", (event) => {
      const payload = parseEventData<{ error?: string; audit?: AgentAnalysisAudit }>(event);
      if (payload?.audit) {
        setAnalysisAudit(payload.audit);
        setAnalysisSteps(stepsFromAudit(payload.audit, "error", payload.error ?? "Agent analysis failed.", locale));
      } else {
        setAnalysisSteps((current) => markLastStepError(current, payload?.error ?? "Agent analysis failed.", locale));
      }
      setAgentAnalysisError(payload?.error ?? "Agent analysis failed.");
      setIsAgentAnalyzing(false);
      source.close();
    });
    source.onerror = () => {
      setAgentAnalysisError("Agent analysis stream disconnected.");
      setAnalysisSteps((current) => markLastStepError(current, "Agent analysis stream disconnected.", locale));
      setIsAgentAnalyzing(false);
      source.close();
    };
  }

  async function killAgentProcess(processEvent: AgentProcessEvent) {
    try {
      const response = await fetch("/api/agent-processes/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: processEvent.id, pid: processEvent.pid, pgid: processEvent.pgid, signal: "SIGTERM" })
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(error?.error ?? `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as AgentProcessEvent;
      setAgentProcesses((current) => upsertAgentProcess(current, payload));
    } catch (error) {
      setAgentEvents((current) => [
        ...current.slice(-199),
        {
          kind: "text",
          at: new Date().toISOString(),
          payload: { stream: "stderr", text: error instanceof Error ? error.message : "Failed to kill process." }
        }
      ]);
    }
  }

  async function importTrialUrl() {
    setImportError("");
    if (!trialUrl.trim()) {
      setImportError("Enter a direct raw JSON/JSONL URL or paste files below.");
      return;
    }
    try {
      const response = await fetch(trialUrl.trim());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const imported = createProject(
        customName || "SkillsBench trial",
        skillInput,
        text,
        { success: undefined, source: trialUrl.trim() },
        "url",
        taskInput,
        trialUrl.trim()
      );
      setTraceInput(text);
      setProjects((current) => [imported, ...current]);
      setProjectId(imported.id);
      setIsHome(false);
    } catch (error) {
      setImportError(
        `URL import failed in the browser. Use a raw URL with CORS enabled or paste the trajectory JSONL. ${error instanceof Error ? error.message : ""}`
      );
    }
  }

  function updateFindingStatus(status: CoverageStatus) {
    if (!selectedFinding) {
      return;
    }
    setProjects((current) =>
      current.map((candidate) => {
        if (candidate.id !== project.id) {
          return candidate;
        }
        return {
          ...candidate,
          findings: candidate.findings.map((finding) =>
            finding.id === selectedFinding.id
              ? {
                  ...finding,
                  status,
                  confidence: Math.max(finding.confidence, 0.7),
                  rationale: `${finding.rationale} Manual review set this status to ${status}.`
                }
              : finding
          )
        };
      })
    );
  }

  function selectShowcaseCase(slug: string) {
    setShowcaseCaseSlug(slug);
    const params = new URLSearchParams({ view: "experiments", case: slug });
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  return (
    <LocaleContext.Provider value={locale}>
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Code2 size={22} />
          <div>
            <h1>SkillScope</h1>
            <p>{t.tagline}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="adapter-pill">Codex</span>
          <span className="adapter-pill">Claude Code</span>
          <span className="adapter-pill">ACP JSONL</span>
          <button
            className={view === "monitor" && !isHome ? "secondary-button compact active" : "secondary-button compact"}
            onClick={() => {
              setView("monitor");
              setIsHome(false);
              window.history.replaceState(null, "", `${window.location.pathname}?view=monitor`);
            }}
          >
            <Activity size={16} />
            {t.views.monitor}
          </button>
          <button
            className="secondary-button compact"
            onClick={() => setLocale((current) => (current === "zh" ? "en" : "zh"))}
            title="Language"
          >
            {t.languageToggle}
          </button>
          <button className="icon-button" onClick={() => downloadFile(`${project.name}.analysis.json`, exportAnalysisJson(project), "application/json")} title={t.exportJson}>
            <Download size={18} />
          </button>
        </div>
      </header>

      <main className="workspace">
        {isHome ? (
          <SessionHome
            skillUses={visibleLocalSkillUses}
            projects={localProjects}
            selectedProjectKey={localProjectKey}
            loading={isLoadingLocalSessions}
            indexMeta={localIndexMeta}
            capturingSkillUseId={capturingSkillUseId}
            error={libraryError}
            onProjectChange={setLocalProjectKey}
            onRefresh={() => loadLocalSessions({ refresh: true })}
            onOpenSkillUse={captureAndLoadSkillUse}
            onOpenDemo={() => {
              setProjects((current) => {
                const existingIds = new Set(current.map((candidate) => candidate.id));
                return [...demoProjects.filter((candidate) => !existingIds.has(candidate.id)), ...current];
              });
              setProjectId(demoProjects[0].id);
              setCompareId(demoProjects[1].id);
              setIsHome(false);
            }}
            onOpenMonitor={() => {
              setView("monitor");
              setIsHome(false);
              window.history.replaceState(null, "", `${window.location.pathname}?view=monitor`);
            }}
            onOpenExperiments={() => {
              setView("experiments");
              setIsHome(false);
              const params = new URLSearchParams({ view: "experiments", case: showcaseCaseSlug });
              window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
            }}
          />
        ) : openingSkillUse ? (
          <OpeningPanel skillUse={openingSkillUse} />
        ) : view === "experiments" ? (
          <SkillsBenchResultsHome
            cases={skillsBenchShowcaseCases}
            selectedSlug={showcaseCaseSlug}
            onSelect={selectShowcaseCase}
            onBack={() => {
              setIsHome(true);
              setView("coverage");
              window.history.replaceState(null, "", window.location.pathname);
            }}
          />
        ) : view === "monitor" ? (
          <MonitorPage
            onBack={() => {
              setIsHome(true);
              setView("coverage");
              window.history.replaceState(null, "", window.location.pathname);
            }}
            onKillProcess={killAgentProcess}
          />
        ) : (
        <section className="analysis-panel">
          <div className="analysis-topbar">
            <button
              className="secondary-button"
              onClick={() => {
                setIsHome(true);
                setView("coverage");
                window.history.replaceState(null, "", window.location.pathname);
              }}
            >
              <ArrowLeft size={16} />
              {t.app.back}
            </button>
            <div className="analysis-title-block">
              <span>{t.app.currentWindow}</span>
              <h2>{analysisDisplayTitle(focusedProject)}</h2>
              <p>{currentSkillTitle(focusedProject)} · {String(project.result.source ?? project.sourceType)} · {formatResult(project.result.success)}</p>
            </div>
            <div className="analysis-actions">
              <button className="secondary-button" onClick={() => startAgentAnalysis(false)} disabled={isAgentAnalyzing}>
                <Code2 size={16} />
                {isAgentAnalyzing ? t.app.analyzing : t.app.startAnalysis}
              </button>
              <button className="secondary-button" onClick={() => startAgentAnalysis(true)} disabled={isAgentAnalyzing}>
                <RefreshCw size={16} />
                {t.app.reanalyze}
              </button>
              <details className="import-drawer">
                <summary>
                  <Upload size={16} />
                  {t.app.import}
                </summary>
                <div className="import-drawer-body">
                  <div className="import-card wide">
                    <div className="section-title">
                      <Upload size={16} />
                      {t.app.localArtifacts}
                    </div>
                    <input value={customName} onChange={(event) => setCustomName(event.target.value)} aria-label="Project name" />
                    <div className="file-row">
                      <FileLoader label="SKILL.md" accept=".md,text/markdown,text/plain" onLoad={setSkillInput} />
                      <FileLoader label="Trace JSONL" accept=".jsonl,.json,application/json,text/plain" onLoad={setTraceInput} />
                      <FileLoader label="result.json" accept=".json,application/json,text/plain" onLoad={setResultInput} />
                    </div>
                    <div className="import-text-grid">
                      <textarea value={skillInput} onChange={(event) => setSkillInput(event.target.value)} aria-label="Skill markdown" rows={7} />
                      <textarea value={traceInput} onChange={(event) => setTraceInput(event.target.value)} aria-label="Trajectory JSONL" rows={7} />
                      <textarea value={taskInput} onChange={(event) => setTaskInput(event.target.value)} aria-label="Task markdown" rows={4} />
                      <textarea value={resultInput} onChange={(event) => setResultInput(event.target.value)} aria-label="Result JSON" rows={4} />
                    </div>
                    <button className="primary-button" onClick={() => analyzeCustom("upload")}>
                      <Search size={16} />
                      {t.app.analyzeUpload}
                    </button>
                  </div>
                  <div className="import-card">
                    <div className="section-title">
                      <Link2 size={16} />
                      SkillsBench URL
                    </div>
                    <input value={trialUrl} onChange={(event) => setTrialUrl(event.target.value)} placeholder="Raw trial JSONL URL" />
                    <button className="secondary-button" onClick={importTrialUrl}>
                      {t.app.importUrl}
                    </button>
                    {importError ? <p className="error-text">{importError}</p> : null}
                  </div>
                </div>
              </details>
            </div>
          </div>

          <div className="analysis-subbar">
            <span>{focusedProject.traceFormat.replace("_", " ")}</span>
            <span>
              {focusedProject.events.length} / {project.events.length} events
            </span>
            <span>{activeSegment ? activeSegment.title : t.app.currentWindow}</span>
            {hasAgentJudged(focusedProject) ? (
              <>
                <span className="summary-good">{t.status.covered} {summary.counts.covered}</span>
                <span className="summary-risk">{t.status.violated} {summary.counts.violated}</span>
                <span className="summary-ignore">{t.status.missed} {summary.counts.missed}</span>
                <span>{t.app.applicable} {summary.applicable}</span>
                {summary.counts.not_applicable ? <span>{t.app.skippedBranchesCollapsed.replace("{count}", String(summary.counts.not_applicable))}</span> : null}
                <span>{t.app.confidence} {percent(summary.averageConfidence)}</span>
              </>
            ) : (
              <>
                <span>{summary.total} {t.app.constraints}</span>
                <span className="needs-judge">{t.app.needsJudge}</span>
              </>
            )}
          </div>
          {agentAnalysisError ? <p className="error-text analysis-message">{agentAnalysisError}</p> : null}
          {agentAnalysisMessage ? (
            <div className="analysis-message analysis-message-row">
              <span>{agentAnalysisMessage}</span>
              {agentAnalysisMessage.includes("Skill 高亮") || agentAnalysisMessage.includes("Skill Highlight") ? (
                <button className="secondary-button compact" onClick={() => setView("coverage")}>
                  {t.app.viewHighlights}
                </button>
              ) : null}
            </div>
          ) : null}
          {captures.length || sessionSegments.length ? (
            <details className="context-drawer">
              <summary>{t.app.switchCapture}</summary>
              {captures.length ? (
                <SessionLibrary
                  captures={visibleCaptures}
                  projectOptions={captureProjectOptions}
                  selectedProjectKey={captureProjectKey}
                  selectedCaptureId={project.id.startsWith("capture-") ? project.id.replace(/^capture-/, "") : ""}
                  onProjectChange={setCaptureProjectKey}
                  onSelectCapture={(id) => loadCapture(id, { select: true, lazyFindings: true })}
                />
              ) : null}
              {sessionSegments.length ? (
                <div className="segment-strip">
                  <span>{t.app.sessionSegments}</span>
                  <button className={activeSegmentId === "all" ? "active" : ""} onClick={() => setActiveSegmentId("all")}>
                    {t.app.fullSession} · {project.events.length} events
                  </button>
                  {sessionSegments.slice(-12).map((segment) => (
                    <button
                      key={segment.id}
                      className={activeSegmentId === segment.id ? "active" : ""}
                      onClick={() => {
                        setActiveSegmentId(segment.id);
                        setSelectedEventId("");
                        setTimelineFilter("all");
                      }}
                    >
                      {segment.title} · steps {segment.startStep}-{segment.endStep}
                    </button>
                  ))}
                </div>
              ) : null}
            </details>
          ) : null}

          <nav className="tabs analysis-tabs" aria-label="Views">
            {visibleViewLabels.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={view === item.id ? "tab active" : "tab"} onClick={() => setView(item.id)}>
                  <Icon size={16} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          {view === "coverage" ? (
            <CoverageView
              project={focusedProject}
              selectedUnit={selectedUnit}
              selectedFinding={selectedFinding}
              relatedEventIds={relatedEventIds}
              onSelectUnit={setSelectedUnitId}
              onSelectEvent={(id) => {
                setSelectedEventId(id);
                setView("timeline");
              }}
              onStatusChange={updateFindingStatus}
            />
          ) : null}

          {view === "graph" ? (
            <SkillGraphView
              project={focusedProject}
              selectedUnitId={selectedUnit?.id}
              onSelectUnit={setSelectedUnitId}
              onSelectEvent={(id) => {
                setSelectedEventId(id);
                setView("timeline");
              }}
            />
          ) : null}

          {view === "timeline" ? (
            <TimelineView
              project={focusedProject}
              events={timelineEvents}
              selectedEvent={selectedEvent}
              filter={timelineFilter}
              onFilter={setTimelineFilter}
              onSelectEvent={setSelectedEventId}
              onSelectUnit={(id) => {
                setSelectedUnitId(id);
                setView("coverage");
              }}
            />
          ) : null}

          {view === "compare" ? (
            <CompareView
              project={focusedProject}
              compareProject={compareProject}
              projects={projects}
              compareId={compareId}
              onCompareChange={setCompareId}
            />
          ) : null}

          {view === "analysis" ? (
            <AnalysisProcessView
              analyzing={isAgentAnalyzing}
              error={agentAnalysisError}
              message={agentAnalysisMessage}
              steps={analysisSteps}
              audit={analysisAudit}
              agentEvents={agentEvents}
              agentProcesses={agentProcesses}
              traceTails={traceTails}
              onKillProcess={killAgentProcess}
              onTraceTail={setTraceTails}
            />
          ) : null}

          {view === "rewrite" ? <RewriteView project={focusedProject} audit={analysisAudit} /> : null}

          {view === "report" ? <ReportView project={focusedProject} /> : null}
        </section>
        )}
      </main>
    </div>
    </LocaleContext.Provider>
  );
}

function SessionHome({
  skillUses,
  projects,
  selectedProjectKey,
  loading,
  indexMeta,
  capturingSkillUseId,
  error,
  onProjectChange,
  onRefresh,
  onOpenSkillUse,
  onOpenDemo,
  onOpenMonitor,
  onOpenExperiments
}: {
  skillUses: LocalSkillUse[];
  projects: LocalProject[];
  selectedProjectKey: string;
  loading: boolean;
  indexMeta: LocalSessionIndexMeta;
  capturingSkillUseId: string;
  error: string;
  onProjectChange: (cwd: string) => void;
  onRefresh: () => void;
  onOpenSkillUse: (skillUse: LocalSkillUse) => void;
  onOpenDemo: () => void;
  onOpenMonitor: () => void;
  onOpenExperiments: () => void;
}) {
  const locale = useLocale();
  const t = ui(locale);
  const [query, setQuery] = useState("");
  const totalSkillUses = projects.reduce((sum, project) => sum + project.skillUseCount, 0);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProjects = normalizedQuery
    ? projects.filter((project) =>
        `${project.project} ${project.cwd} ${project.repositoryUrl ?? ""} ${project.usedSkills.join(" ")}`.toLowerCase().includes(normalizedQuery)
      )
    : projects;
  const visibleSkillUses = normalizedQuery
    ? skillUses.filter((use) =>
        `${use.skillName} ${use.title} ${use.project} ${use.cwd} ${use.sessionId} ${use.worktreeLabel ?? ""}`.toLowerCase().includes(normalizedQuery)
      )
    : skillUses;
  return (
    <section className="session-home">
      <div className="session-home-head">
        <div>
          <h2>{t.home.title}</h2>
          <p>{t.home.subtitle}</p>
          <small className="index-meta">
            {indexMeta.updatedAt ? `${projects.length} projects · ${totalSkillUses} skill uses · ${formatShortDate(indexMeta.updatedAt)} · ${indexMeta.source ?? "db"}` : t.home.indexMissing}
          </small>
        </div>
        <div className="session-home-actions">
          <button className="secondary-button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} />
            {t.home.refresh}
          </button>
          <button className="secondary-button" onClick={onOpenMonitor}>
            <Activity size={16} />
            {t.views.monitor}
          </button>
          <button className="secondary-button" onClick={onOpenDemo}>
            {t.home.demo}
          </button>
        </div>
      </div>

      <div className="home-mode-grid">
        <button className="home-mode-card monitor" onClick={onOpenMonitor}>
          <span>
            <Activity size={19} />
            {locale === "zh" ? "Agent 进程监控" : "Agent Process Monitor"}
          </span>
          <strong>{locale === "zh" ? "查看正在运行的 agent" : "Watch running agents"}</strong>
          <small>
            {locale === "zh"
              ? "按 Codex / Claude 分组，监控它们启动的子进程、trace 和输出文件。"
              : "Grouped by Codex / Claude, with child processes, traces, and output artifacts."}
          </small>
        </button>
        <button className="home-mode-card experiments" onClick={onOpenExperiments}>
          <span>
            <BarChart3 size={19} />
            {locale === "zh" ? "SkillsBench 优化结果" : "SkillsBench Optimization"}
          </span>
          <strong>{locale === "zh" ? "对比原始 skill 和优化后 skill" : "Compare original and optimized skills"}</strong>
          <small>
            {locale === "zh"
              ? "展示 native verifier、SkillScope NC、违反/忽略变化和实验产物。"
              : "Show native verifier, SkillScope NC, violation/ignored deltas, and artifacts."}
          </small>
        </button>
        <div className="home-mode-card passive">
          <span>
            <FileText size={19} />
            {locale === "zh" ? "Skill 使用分析" : "Skill Use Analysis"}
          </span>
          <strong>{locale === "zh" ? "从下面选择一次 skill 使用" : "Choose a skill use below"}</strong>
          <small>
            {locale === "zh"
              ? "打开 Skill 高亮、Skill 图、轨迹、分析过程和优化建议。"
              : "Open highlights, graph, trace, analysis process, and optimization suggestions."}
          </small>
        </div>
      </div>

      <div className="session-search">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.home.searchPlaceholder} />
      </div>

      <div className="project-session-layout">
        <aside className="local-projects">
          <button className={selectedProjectKey === "all" ? "active" : ""} onClick={() => onProjectChange("all")}>
            <strong>{t.home.allProjects}</strong>
            <span>{totalSkillUses} skill uses</span>
          </button>
          {visibleProjects.map((project) => (
            <button
              key={project.key}
              className={selectedProjectKey === project.key ? "active" : ""}
              onClick={() => onProjectChange(project.key)}
              title={project.repositoryUrl ?? project.cwd}
            >
              <strong>{project.project}</strong>
              <span>
                {project.skillUseCount} skill uses · {project.sessionCount} sessions · {formatShortDate(project.latestAt)}
              </span>
              <span>{project.usedSkills.slice(0, 3).join(", ")}</span>
              <small>{project.cwd}</small>
            </button>
          ))}
        </aside>

        <div className="local-sessions">
          <div className="column-title">{t.home.skillUseColumn}</div>
          {error ? <p className="error-text session-error">{error}</p> : null}
          {loading ? (
            <p className="muted empty-sessions">{t.home.indexing}</p>
          ) : visibleSkillUses.length ? (
            visibleSkillUses.slice(0, 120).map((use) => {
              const isOpening = capturingSkillUseId === use.id;
              return (
              <button key={use.id} className={isOpening ? "opening" : ""} onClick={() => onOpenSkillUse(use)} disabled={isOpening}>
                <div>
                  <strong>{use.title || "Skill use window"}</strong>
                  <span>
                    <b>{use.skillName}</b>
                    {use.project}
                  </span>
                  <small title={use.cwd}>{worktreeSummary(use.cwd)}</small>
                </div>
                <div>
                  <span>{use.worktreeLabel ?? use.agentProduct}</span>
                  <small>steps {use.startStep}-{use.endStep}</small>
                  <small>{shortSessionTitle(use.sessionId)} · {formatShortDate(use.updatedAt)}</small>
                  <em>{isOpening ? t.home.opening : t.home.open}</em>
                </div>
              </button>
              );
            })
          ) : (
            <p className="muted empty-sessions">{t.home.noSkillUses}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function SkillsBenchResultsHome({
  cases,
  selectedSlug,
  onSelect,
  onBack
}: {
  cases: SkillsBenchShowcaseCase[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  onBack: () => void;
}) {
  const locale = useLocale();
  const selected = cases.find((candidate) => candidate.slug === selectedSlug) ?? cases[0];
  const accepted = cases.filter((candidate) => candidate.status === "accepted").length;
  const completed = cases.filter((candidate) => candidate.status !== "blocked").length;
  const improved = cases.filter((candidate) => {
    if (!candidate.optimized || candidate.original.nonComplianceRate === null || candidate.optimized.nonComplianceRate === null) {
      return false;
    }
    return candidate.optimized.nonComplianceRate < candidate.original.nonComplianceRate;
  }).length;

  return (
    <section className="session-home benchmark-home">
      <div className="session-home-head">
        <div>
          <h2>{locale === "zh" ? "SkillsBench 优化实验" : "SkillsBench Optimization Results"}</h2>
          <p>
            {locale === "zh"
              ? "用 SkillScope 先分析原始轨迹的违反/忽略，再生成一条优化 skill，重新跑 verifier 并复评 NC。"
              : "Analyze original trace violations/ignored constraints with SkillScope, rewrite one optimized skill, rerun the verifier, then rejudge NC."}
          </p>
          <small className="index-meta">
            {completed} completed · {accepted} accepted · {improved} SkillScope NC improved
          </small>
        </div>
        <div className="session-home-actions">
          <button className="secondary-button" onClick={onBack}>
            <ArrowLeft size={16} />
            {locale === "zh" ? "返回主页" : "Back Home"}
          </button>
        </div>
      </div>

      <div className="home-mode-grid benchmark-summary-grid">
        <div className="home-mode-card passive">
          <span>
            <CheckCircle2 size={19} />
            {locale === "zh" ? "Native verifier" : "Native verifier"}
          </span>
          <strong>2 / 3 {locale === "zh" ? "完成样例优化后通过" : "completed cases passed after rewrite"}</strong>
          <small>{locale === "zh" ? "展示通过测试数，不只看 reward 0/1。" : "Shows passed-test counts, not only reward 0/1."}</small>
        </div>
        <div className="home-mode-card passive">
          <span>
            <BarChart3 size={19} />
            SkillScope NC
          </span>
          <strong>3 / 3 {locale === "zh" ? "完成样例下降" : "completed cases improved"}</strong>
          <small>{locale === "zh" ? "NC 来自 SkillScope 对违反和忽略约束的复评。" : "NC comes from SkillScope rejudging violated and ignored constraints."}</small>
        </div>
        <div className="home-mode-card passive">
          <span>
            <GitBranch size={19} />
            {locale === "zh" ? "单实例闭环" : "Single-instance loop"}
          </span>
          <strong>{locale === "zh" ? "原始跑一次，再优化一条" : "One original run, one optimized run"}</strong>
          <small>{locale === "zh" ? "批量并发由外层 agent 分发，每个 worker 只处理一个 instance。" : "Batch concurrency is external; each worker handles one instance."}</small>
        </div>
      </div>

      <div className="project-session-layout">
        <aside className="local-projects benchmark-case-list">
          {cases.map((item) => (
            <button
              key={item.slug}
              className={selected?.slug === item.slug ? "active" : ""}
              onClick={() => onSelect(item.slug)}
              title={item.skillRelPath}
            >
              <strong>{item.taskId}</strong>
              <span>{item.title}</span>
              <span>{caseStatusLabel(item, locale)} · {runPassLabel(item.optimized ?? item.original)}</span>
              <small>{item.skillRelPath}</small>
            </button>
          ))}
        </aside>

        <div className="local-sessions benchmark-detail-panel">
          {selected ? <SkillsBenchCaseDetail item={selected} /> : null}
        </div>
      </div>
    </section>
  );
}

function SkillsBenchCaseDetail({ item }: { item: SkillsBenchShowcaseCase }) {
  const locale = useLocale();
  const statusClass = `benchmark-status ${item.status}`;
  return (
    <div className="benchmark-detail">
      <div className="benchmark-detail-head">
        <div>
          <span className={statusClass}>{caseStatusLabel(item, locale)}</span>
          <h3>{item.taskId}</h3>
          <p>{item.outcome}</p>
        </div>
        <div className="benchmark-skill-path">
          <span>{locale === "zh" ? "Skill" : "Skill"}</span>
          <code>{item.skillRelPath}</code>
        </div>
      </div>

      {item.status === "blocked" ? (
        <div className="benchmark-blocked">
          <AlertTriangle size={18} />
          <div>
            <strong>{locale === "zh" ? "未进入 agent/verifier" : "Did not reach agent/verifier"}</strong>
            <p>{item.blockedReason}</p>
          </div>
        </div>
      ) : null}

      <div className="benchmark-metric-grid">
        <RunMetricCard label={locale === "zh" ? "原始 Skill" : "Original Skill"} run={item.original} />
        <RunMetricCard label={locale === "zh" ? "优化后 Skill" : "Optimized Skill"} run={item.optimized} muted={!item.optimized} />
        <DeltaMetricCard item={item} />
      </div>

      <div className="benchmark-columns">
        <FindingList title={locale === "zh" ? "原始轨迹主要问题" : "Original Trace Findings"} findings={item.topOriginalFindings} />
        <FindingList title={locale === "zh" ? "优化后剩余问题" : "Remaining After Rewrite"} findings={item.topOptimizedFindings} empty={locale === "zh" ? "没有主要剩余违反。" : "No major remaining violation."} />
      </div>

      <div className="benchmark-coverage-row">
        <CoveragePills label={locale === "zh" ? "原始覆盖" : "Original coverage"} counts={item.original.counts} />
        {item.optimized ? <CoveragePills label={locale === "zh" ? "优化后覆盖" : "Optimized coverage"} counts={item.optimized.counts} /> : null}
      </div>

      <div className="benchmark-artifacts">
        <strong>{locale === "zh" ? "本地产物" : "Local artifacts"}</strong>
        {item.artifactPaths.map((artifact) => (
          <code key={artifact}>{artifact}</code>
        ))}
      </div>
    </div>
  );
}

function RunMetricCard({
  label,
  run,
  muted = false
}: {
  label: string;
  run?: SkillsBenchShowcaseCase["original"];
  muted?: boolean;
}) {
  const locale = useLocale();
  if (!run) {
    return (
      <div className="benchmark-metric-card muted">
        <span>{label}</span>
        <strong>{locale === "zh" ? "未运行" : "Not run"}</strong>
        <p>{locale === "zh" ? "没有优化后轨迹。" : "No optimized trace exists."}</p>
      </div>
    );
  }
  return (
    <div className={muted ? "benchmark-metric-card muted" : "benchmark-metric-card"}>
      <span>{label}</span>
      <strong>{runPassLabel(run)}</strong>
      <p>
        reward {run.reward ?? "-"} · NC {formatNullableRate(run.nonComplianceRate)}
        {typeof run.finalOutputNonComplianceRate === "number" ? ` · final ${formatNullableRate(run.finalOutputNonComplianceRate)}` : ""}
      </p>
    </div>
  );
}

function DeltaMetricCard({ item }: { item: SkillsBenchShowcaseCase }) {
  const locale = useLocale();
  const optimized = item.optimized;
  const nativeDelta =
    optimized && item.original.passedTests !== null && optimized.passedTests !== null ? optimized.passedTests - item.original.passedTests : null;
  const ncDelta =
    optimized && item.original.nonComplianceRate !== null && optimized.nonComplianceRate !== null
      ? item.optimized!.nonComplianceRate! - item.original.nonComplianceRate
      : null;
  return (
    <div className="benchmark-metric-card delta">
      <span>{locale === "zh" ? "变化" : "Delta"}</span>
      <strong>
        {nativeDelta === null ? "-" : `${nativeDelta >= 0 ? "+" : ""}${nativeDelta} ${locale === "zh" ? "测试" : "tests"}`}
      </strong>
      <p>{ncDelta === null ? "NC -" : `NC ${formatSignedPercent(ncDelta)}`} · {caseDecisionText(item, locale)}</p>
    </div>
  );
}

function FindingList({
  title,
  findings,
  empty
}: {
  title: string;
  findings: string[];
  empty?: string;
}) {
  return (
    <div className="benchmark-finding-list">
      <strong>{title}</strong>
      {findings.length ? (
        findings.map((finding) => <p key={finding}>{finding}</p>)
      ) : (
        <p className="muted">{empty ?? "No findings."}</p>
      )}
    </div>
  );
}

function CoveragePills({ label, counts }: { label: string; counts: SkillsBenchShowcaseCase["original"]["counts"] }) {
  const locale = useLocale();
  return (
    <div className="benchmark-coverage">
      <strong>{label}</strong>
      <span className="covered">{statusLabel("covered", locale)} {counts.covered}</span>
      <span className="violated">{statusLabel("violated", locale)} {counts.violated}</span>
      <span className="missed">{statusLabel("missed", locale)} {counts.missed}</span>
      <span className="unknown">{statusLabel("unknown", locale)} {counts.unknown}</span>
      <span>{statusLabel("not_applicable", locale)} {counts.notApplicable}</span>
    </div>
  );
}

function caseStatusLabel(item: SkillsBenchShowcaseCase, locale: Locale): string {
  if (item.status === "accepted") {
    return locale === "zh" ? "已接受优化" : "Accepted rewrite";
  }
  if (item.status === "not_accepted") {
    return locale === "zh" ? "未接受" : "Not accepted";
  }
  return locale === "zh" ? "环境阻塞" : "Blocked";
}

function caseDecisionText(item: SkillsBenchShowcaseCase, locale: Locale): string {
  if (item.status === "accepted") {
    return locale === "zh" ? "接受优化" : "accepted";
  }
  if (item.status === "not_accepted") {
    return locale === "zh" ? "native 仍失败" : "native still failed";
  }
  return locale === "zh" ? "未运行" : "not run";
}

function runPassLabel(run: SkillsBenchShowcaseCase["original"]): string {
  if (run.passedTests === null || run.totalTests === null) {
    return "not run";
  }
  return `${run.passedTests}/${run.totalTests} tests`;
}

function formatNullableRate(value: number | null | undefined): string {
  if (typeof value !== "number") {
    return "-";
  }
  const pct = value * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function formatSignedPercent(value: number): string {
  const pct = value * 100;
  const rendered = Math.abs(pct) < 10 && pct !== 0 ? pct.toFixed(1) : String(Math.round(pct));
  return `${pct > 0 ? "+" : ""}${rendered}%`;
}

function OpeningPanel({ skillUse }: { skillUse: LocalSkillUse }) {
  const t = ui(useLocale());
  return (
    <section className="opening-panel">
      <div className="opening-card">
        <div className="opening-spinner" />
        <div>
          <span>{t.opening.title}</span>
          <h2>{skillUse.title || "Skill use window"}</h2>
          <p>
            {skillUse.skillName} · {skillUse.project} · steps {skillUse.startStep}-{skillUse.endStep}
          </p>
          <small>{t.opening.note}</small>
        </div>
      </div>
    </section>
  );
}

function SessionLibrary({
  captures,
  projectOptions,
  selectedProjectKey,
  selectedCaptureId,
  onProjectChange,
  onSelectCapture
}: {
  captures: CaptureRegistryEntry[];
  projectOptions: Array<{ key: string; label: string; count: number; cwd?: string }>;
  selectedProjectKey: string;
  selectedCaptureId: string;
  onProjectChange: (key: string) => void;
  onSelectCapture: (id: string) => void;
}) {
  const t = ui(useLocale());
  const totalCaptures = projectOptions.reduce((sum, option) => sum + option.count, 0);
  return (
    <div className="session-library">
      <div className="session-library-head">
        <div>
          <strong>{t.sessionLibrary.title}</strong>
          <span>{t.sessionLibrary.subtitle}</span>
        </div>
        <select value={selectedProjectKey} onChange={(event) => onProjectChange(event.target.value)} aria-label="Captured project">
          <option value="all">{t.sessionLibrary.allProjects} ({totalCaptures})</option>
          {projectOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label} ({option.count})
            </option>
          ))}
        </select>
      </div>
      <div className="session-list">
        {captures.slice(0, 18).map((capture) => (
          <button
            key={capture.id}
            className={selectedCaptureId === capture.id ? "active" : ""}
            onClick={() => onSelectCapture(capture.id)}
          >
            <strong>{shortSessionTitle(capture.title)}</strong>
            <span>{projectLabel(capture.cwd)}</span>
            <small>
              {capture.agentProduct} · {capture.loadedSkillCount}/{capture.skillCount} skills · {capture.segmentCount} segments ·{" "}
              {formatShortDate(capture.createdAt)}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}

function CoverageView({
  project,
  selectedUnit,
  selectedFinding,
  relatedEventIds,
  onSelectUnit,
  onSelectEvent,
  onStatusChange
}: {
  project: SkillLensProject;
  selectedUnit?: SkillUnit;
  selectedFinding?: CoverageFinding;
  relatedEventIds: Set<string>;
  onSelectUnit: (id: string) => void;
  onSelectEvent: (id: string) => void;
  onStatusChange: (status: CoverageStatus) => void;
}) {
  const locale = useLocale();
  const t = ui(locale);
  const evidenceEvents = (selectedFinding?.evidenceEventIds ?? [])
    .map((id) => project.events.find((event) => event.id === id))
    .filter(Boolean) as TraceEvent[];
  const showLocalCandidates = selectedFinding ? !isAgentFinding(selectedFinding) : true;
  const candidateEvents = showLocalCandidates && selectedUnit ? findCandidates(selectedUnit, project.events).slice(0, 5) : [];
  return (
    <>
      <div className="coverage-grid">
        <SkillSourcePanel
          project={project}
          selectedUnitId={selectedUnit?.id}
          onSelectUnit={onSelectUnit}
          onSelectEvent={onSelectEvent}
        />

        <div className="evidence-panel">
          <div className="column-title">{t.coverage.judgmentEvidence}</div>
          {selectedUnit && selectedFinding ? (
            <>
              <div className={`finding-banner ${selectedFinding.status}`}>
                <StatusIcon status={selectedFinding.status} />
                <div>
                  <strong>{statusLabel(selectedFinding.status, locale)}</strong>
                  <p>{selectedFinding.rationale}</p>
                </div>
              </div>
              <div className="detail-block">
                <h3>{t.coverage.skillConstraint}</h3>
                <p>{selectedFinding.analyzedConstraint?.text ?? selectedUnit.text}</p>
                <small>
                  {selectedUnit.headingPath.join(" / ") || "Root"} ·{" "}
                  {selectedFinding.analyzedConstraint
                    ? `${selectedFinding.analyzedConstraint.kind} · lines ${selectedFinding.analyzedConstraint.span.lineStart}-${selectedFinding.analyzedConstraint.span.lineEnd}`
                    : `lines ${selectedUnit.lineStart}-${selectedUnit.lineEnd}`}
                </small>
              </div>
              <div className="detail-block">
                <h3>{t.coverage.evidenceSpans}</h3>
                {evidenceEvents.length ? (
                  evidenceEvents.map((event) => (
                    <EventChip key={event.id} event={event} active={relatedEventIds.has(event.id)} onClick={() => onSelectEvent(event.id)} />
                  ))
                ) : (
                  <p className="muted">{t.coverage.noDirectEvidence}</p>
                )}
              </div>
              {showLocalCandidates ? (
                <div className="detail-block">
                  <h3>{t.coverage.localCandidates}</h3>
                  {candidateEvents.map((candidate) => (
                    <EventChip key={candidate.event.id} event={candidate.event} score={candidate.score} onClick={() => onSelectEvent(candidate.event.id)} />
                  ))}
                </div>
              ) : null}
              {selectedFinding.suggestedRewrite ? (
                <div className="rewrite-box">
                  <h3>{t.coverage.rewrite}</h3>
                  <p>{selectedFinding.suggestedRewrite}</p>
                </div>
              ) : null}
              <details className="manual-review">
                <summary>{t.coverage.manualReview}</summary>
                <select value={selectedFinding.status} onChange={(event) => onStatusChange(event.target.value as CoverageStatus)}>
                  {Object.keys(statusMeta).map((status) => (
                    <option value={status} key={status}>
                      {statusLabel(status as CoverageStatus, locale)}
                    </option>
                  ))}
                </select>
              </details>
            </>
          ) : (
            <p className="muted">{t.coverage.selectConstraint}</p>
          )}
        </div>
      </div>
    </>
  );
}

function FindingQueue({
  project,
  findings,
  selectedUnitId,
  onSelectUnit
}: {
  project: SkillLensProject;
  findings: CoverageFinding[];
  selectedUnitId?: string;
  onSelectUnit: (id: string) => void;
}) {
  const t = ui(useLocale());
  if (!findings.length) {
    return null;
  }
  return (
    <div className="finding-queue">
      <span>{t.coverage.priority}</span>
      <div>
        {findings.map((finding) => {
          const unit = project.units.find((candidate) => candidate.id === finding.unitId);
          return (
            <button
              key={finding.id}
              className={selectedUnitId === finding.unitId ? `active ${finding.status}` : finding.status}
              onClick={() => onSelectUnit(finding.unitId)}
            >
              <StatusDot status={finding.status} />
              {unit ? truncate(unit.text, 96) : finding.unitId}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SkillSourcePanel({
  project,
  selectedUnitId,
  onSelectUnit,
  onSelectEvent
}: {
  project: SkillLensProject;
  selectedUnitId?: string;
  onSelectUnit: (id: string) => void;
  onSelectEvent: (id: string) => void;
}) {
  const locale = useLocale();
  const t = ui(locale);
  const lines = skillSourceDisplayLines(project.skillMarkdown);
  const hasAgentSpans = project.findings.some((finding) => isAgentFinding(finding));
  return (
    <div className="skill-source-panel">
      <div className="column-title split-title">
        <span>{t.coverage.source}</span>
        <span className="legend-row">
          <LegendDot status="covered" label={t.status.covered} />
          <LegendDot status="missed" label={t.status.missed} />
          <LegendDot status="violated" label={t.status.violated} />
          <LegendDot status="unknown" label={t.coverage.needsReview} />
        </span>
      </div>
      <div className="skill-source-code" aria-label="Highlighted SKILL.md source">
        {lines.map(({ text: line, lineNumber }) => {
          const unit = unitForLine(project.units, lineNumber);
          const sourceConstraints = unit ? constraintsForLine(unit.constraints, lineNumber) : [];
          const constraints = hasAgentSpans ? [] : sourceConstraints;
          const lineFindings = unit ? findingsForLine(project.findings, unit, lineNumber, sourceConstraints) : [];
          const visibleLineFindings = hasAgentSpans ? lineFindings.filter((finding) => finding.status !== "not_applicable") : lineFindings;
          const firstFinding = bestLineFinding(visibleLineFindings);
          const status = firstFinding?.status ?? "unknown";
          const isActive = unit?.id === selectedUnitId;
          const shouldHighlight = visibleLineFindings.length > 0 || constraints.length > 0;

          if (!unit || !shouldHighlight) {
            return (
              <div className="skill-source-line plain" key={`${lineNumber}-${line}`}>
                <span className="line-number">{lineNumber}</span>
                <code>{line || " "}</code>
              </div>
            );
          }

          return (
            <button
              className={`skill-source-line highlighted ${status} ${isActive ? "active" : ""}`}
              key={unit.id + lineNumber}
              onClick={() => onSelectUnit(unit.id)}
            >
              <span className="line-number">{lineNumber}</span>
              <code>
                <HighlightedCodeLine
                  line={line || " "}
                  lineNumber={lineNumber}
                  unit={unit}
                  constraints={constraints}
                  lineFindings={visibleLineFindings}
                  findings={project.findings}
                  events={project.events}
                  onSelectEvent={onSelectEvent}
                />
              </code>
              <span className={`line-status-badge ${status}`}>{statusLabel(status, locale)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HighlightedCodeLine({
  line,
  lineNumber,
  unit,
  constraints,
  lineFindings,
  findings,
  events,
  onSelectEvent
}: {
  line: string;
  lineNumber: number;
  unit: SkillUnit;
  constraints: SkillConstraint[];
  lineFindings: CoverageFinding[];
  findings: CoverageFinding[];
  events: TraceEvent[];
  onSelectEvent: (id: string) => void;
}) {
  const analyzedFindings = lineFindings.filter((finding) => finding.analyzedConstraint);
  const findingByConstraintId = new Map(
    findings
      .filter((finding) => finding.constraintId)
      .map((finding) => [finding.constraintId, finding] as const)
  );
  const unitFallbackFindings = analyzedFindings.length || constraints.length ? [] : lineFindings;
  const spans = (analyzedFindings.length
    ? analyzedFindings.map((finding) => {
        const constraint = displayConstraintFromFinding(finding, line, lineNumber);
        return {
          constraint,
          finding,
          start: Math.max(0, Math.min(line.length, constraint.span.charStart)),
          end: Math.max(0, Math.min(line.length, constraint.span.charEnd))
        };
      })
    : constraints.length
      ? constraints.map((constraint) => ({
          constraint: displayConstraintFromSkillConstraint(constraint),
          finding: findingByConstraintId.get(constraint.id),
          start: Math.max(0, Math.min(line.length, constraint.span.charStart)),
          end: Math.max(0, Math.min(line.length, constraint.span.charEnd))
        }))
      : unitFallbackFindings.map((finding) => {
          const constraint = displayConstraintFromFinding(finding, line, lineNumber);
          return {
            constraint,
            finding,
            start: 0,
            end: line.length
          };
        }))
      .map((span) => normalizeDisplaySpan(span, line))
      .filter((span) => span.constraint && span.end > span.start)
      .sort((a, b) => a.start - b.start || b.end - a.end);

  if (!spans.length) {
    return <>{line}</>;
  }

  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, index) => {
    if (span.start < cursor) {
      return;
    }
    if (span.start > cursor) {
      pieces.push(<span key={`plain-${index}`}>{line.slice(cursor, span.start)}</span>);
    }
    const status = span.finding?.status ?? "unknown";
    const evidence = eventList(events, span.finding?.evidenceEventIds ?? []);
    const candidates = eventList(events, span.finding?.candidateEventIds ?? []);
    pieces.push(
      <span className={`constraint-span ${status} ${span.constraint.kind}`} key={span.constraint.id}>
        {line.slice(span.start, span.end)}
        <EvidenceTooltip
          unit={unit}
          constraint={span.constraint}
          finding={span.finding}
          events={evidence}
          candidateEvents={candidates}
          onSelectEvent={onSelectEvent}
        />
      </span>
    );
    cursor = span.end;
  });
  if (cursor < line.length) {
    pieces.push(<span key="plain-tail">{line.slice(cursor)}</span>);
  }
  return <>{pieces}</>;
}

function EvidenceTooltip({
  unit,
  constraint,
  finding,
  events,
  candidateEvents,
  onSelectEvent
}: {
  unit: SkillUnit;
  constraint?: DisplayConstraint;
  finding?: CoverageFinding;
  events: TraceEvent[];
  candidateEvents: TraceEvent[];
  onSelectEvent: (id: string) => void;
}) {
  const locale = useLocale();
  const t = ui(locale);
  const status = finding?.status ?? "unknown";
  const visibleEvents = events.length ? events : candidateEvents.slice(0, 2);
  return (
    <span className={`evidence-tooltip ${status}`} role="tooltip">
      <span className="tooltip-head">
        <strong>{statusLabel(status, locale)}</strong>
        <em>{Math.round((finding?.confidence ?? 0) * 100)}%</em>
      </span>
      <span className="tooltip-unit">{constraint ? `${constraint.kind}: ${constraint.text}` : unit.text}</span>
      <span className="tooltip-rationale">{finding?.rationale ?? t.coverage.noFinding}</span>
      <span className="tooltip-events">
        {visibleEvents.length ? (
          visibleEvents.map((event) => (
            <span
              className="tooltip-event"
              key={event.id}
              onClick={(clickEvent) => {
                clickEvent.stopPropagation();
                onSelectEvent(event.id);
              }}
            >
              <strong>{event.id}</strong>
              {truncate(event.content || event.output, 130)}
            </span>
          ))
        ) : (
          <span className="tooltip-empty">{t.coverage.noEvidenceTooltip}</span>
        )}
      </span>
    </span>
  );
}

function eventList(events: TraceEvent[], ids: string[]): TraceEvent[] {
  return ids.map((id) => events.find((event) => event.id === id)).filter(Boolean) as TraceEvent[];
}

function SkillGraphView({
  project,
  selectedUnitId,
  onSelectUnit,
  onSelectEvent
}: {
  project: SkillLensProject;
  selectedUnitId?: string;
  onSelectUnit: (id: string) => void;
  onSelectEvent: (id: string) => void;
}) {
  const locale = useLocale();
  const t = ui(locale);
  const graph = useMemo(() => buildSkillGraph(project), [project]);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState("");
  useEffect(() => {
    const matchingNode = graph.nodes.find((node) => node.unitId === selectedUnitId);
    setSelectedGraphNodeId((current) =>
      current && graph.nodes.some((node) => node.id === current) ? current : matchingNode?.id ?? graph.riskNodes[0]?.id ?? graph.nodes[0]?.id ?? ""
    );
  }, [graph, selectedUnitId]);
  const selectedNode = graph.nodes.find((node) => node.id === selectedGraphNodeId) ?? graph.riskNodes[0] ?? graph.nodes[0];
  const evidenceEvents = selectedNode ? eventList(project.events, selectedNode.evidenceEventIds) : [];

  return (
    <div className="skill-graph-view">
      <div className="skill-graph-main">
        <div className="graph-summary-row">
          <GraphMetric label={t.status.covered} value={graph.nodes.filter((node) => node.status === "covered").length} tone="good" />
          <GraphMetric label={t.status.violated} value={graph.nodes.filter((node) => node.status === "violated").length} tone="risk" />
          <GraphMetric label={t.status.missed} value={graph.nodes.filter((node) => node.status === "missed").length} tone="ignore" />
          <GraphMetric label={t.graph.skippedBranches} value={graph.skippedBranches.length} tone="muted" />
        </div>
        <div className="graph-source-row">
          <span>{graph.source === "agent" ? "Agent skill graph" : t.graph.sourceDerived}</span>
          <span>{graph.nodes.length} nodes</span>
          <span>{graph.edges.length} edges</span>
        </div>

        <div className="graph-sections">
          {graph.sections.map((section) => (
            <section className="graph-section" key={section.id}>
              <h3>{section.title}</h3>
              <div className="graph-node-list">
                {section.nodes.map((node) => (
                  <button
                    key={node.id}
                    className={`graph-node ${node.status} ${node.branchState} ${node.isCondition ? "condition" : "constraint"} ${
                      selectedNode?.id === node.id ? "active" : ""
                    }`}
                    style={{ paddingLeft: `${18 + Math.min(node.depth, 5) * 16}px` }}
                    onClick={() => {
                      setSelectedGraphNodeId(node.id);
                      onSelectUnit(node.unitId);
                    }}
                  >
                    <span className="graph-edge" />
                    <span className="graph-node-kind">{node.isCondition ? t.graph.condition : graphKindLabel(node.kind, locale)}</span>
                    <span className="graph-node-body">
                      <strong>{truncate(node.text, 150)}</strong>
                      <small>
                        {node.edgeLabel ? `${node.edgeLabel} · ` : null}
                        lines {node.lineStart}-{node.lineEnd} · {branchStateLabel(node, locale)} · evidence {node.evidenceEventIds.length} · {percent(node.confidence)}
                      </small>
                    </span>
                    <span className={`graph-node-status ${node.status}`}>{statusLabel(node.status, locale)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <aside className="skill-graph-side">
        <div className="column-title">{t.graph.tracePath}</div>
        {selectedNode ? (
          <>
            <div className={`graph-detail-banner ${selectedNode.status}`}>
              <StatusIcon status={selectedNode.status} />
              <div>
                <strong>
                  {selectedNode.isCondition
                    ? `${statusLabel(selectedNode.status, locale)} · ${branchStateLabel(selectedNode, locale)}`
                    : statusLabel(selectedNode.status, locale)}
                </strong>
                <p>{selectedNode.finding.rationale}</p>
              </div>
            </div>

            <div className="detail-block">
              <h3>{t.graph.currentNode}</h3>
              <p>{selectedNode.text}</p>
              <small>
                {selectedNode.heading} · {selectedNode.kind} · lines {selectedNode.lineStart}-{selectedNode.lineEnd}
              </small>
            </div>

            <div className="detail-block">
              <h3>{t.graph.evidenceEvents}</h3>
              {evidenceEvents.length ? (
                evidenceEvents.slice(0, 5).map((event) => (
                  <EventChip key={event.id} event={event} active onClick={() => onSelectEvent(event.id)} />
                ))
              ) : (
                <p className="muted">{t.graph.noEvidence}</p>
              )}
            </div>
          </>
        ) : (
          <p className="muted graph-empty">{t.graph.empty}</p>
        )}

        <div className="graph-branch-list">
          <h3>{t.graph.takenConditions}</h3>
          {graph.takenBranches.length ? (
            graph.takenBranches.slice(0, 8).map((node) => (
              <button
                key={node.id}
                onClick={() => {
                  setSelectedGraphNodeId(node.id);
                  onSelectUnit(node.unitId);
                }}
              >
                <StatusDot status={node.status} />
                <span>{truncate(node.text, 92)}</span>
              </button>
            ))
          ) : (
            <p className="muted">{t.graph.noTakenConditions}</p>
          )}

          <h3>{t.graph.skippedBranches}</h3>
          {graph.skippedBranches.length ? (
            graph.skippedBranches.slice(0, 12).map((node) => (
              <button
                key={node.id}
                onClick={() => {
                  setSelectedGraphNodeId(node.id);
                  onSelectUnit(node.unitId);
                }}
              >
                <StatusDot status="not_applicable" />
                <span>{truncate(node.text, 92)}</span>
              </button>
            ))
          ) : (
            <p className="muted">{t.graph.noSkippedBranches}</p>
          )}
        </div>
      </aside>
    </div>
  );
}

function GraphMetric({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "good" | "risk" | "ignore" | "muted" }) {
  return (
    <div className={`graph-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function buildSkillGraph(project: SkillLensProject): SkillGraph {
  const artifact = skillGraphForProject(project);
  if (artifact?.nodes.length) {
    return buildSkillGraphFromArtifact(project, artifact);
  }
  return buildDerivedSkillGraph(project);
}

function buildDerivedSkillGraph(project: SkillLensProject): SkillGraph {
  const units = new Map(project.units.map((unit) => [unit.id, unit]));
  const nodes = project.findings
    .filter((finding) => finding.analyzedConstraint || finding.constraintId)
    .map((finding) => {
      const unit = units.get(finding.unitId);
      const span = finding.analyzedConstraint?.span;
      const text = finding.analyzedConstraint?.text || span?.text || unit?.text || finding.rationale;
      const kind = finding.analyzedConstraint?.kind || unit?.constraints[0]?.kind || "constraint";
      const lineStart = span?.lineStart ?? unit?.lineStart ?? 0;
      const lineEnd = span?.lineEnd ?? unit?.lineEnd ?? lineStart;
      const isCondition = isConditionGraphNode(kind, text, finding.status);
      const heading = unit?.headingPath.join(" / ") || "Root";
      const node: SkillGraphNode = {
        id: finding.id,
        graphNodeId: finding.id,
        unitId: finding.unitId,
        constraintId: finding.constraintId,
        heading,
        depth: Math.max(0, (unit?.headingPath.length ?? 1) - 1),
        text,
        kind,
        status: finding.status,
        confidence: finding.confidence,
        lineStart,
        lineEnd,
        evidenceEventIds: finding.evidenceEventIds,
        finding,
        isCondition,
        branchState: finding.status === "not_applicable" ? "not_taken" : isCondition ? "taken" : "checked"
      };
      return node;
    })
    .sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd || a.id.localeCompare(b.id));

  const sectionsByHeading = new Map<string, SkillGraphSection>();
  nodes.forEach((node) => {
    const key = node.heading;
    const section = sectionsByHeading.get(key) ?? {
      id: key,
      title: key,
      nodes: []
    };
    section.nodes.push(node);
    sectionsByHeading.set(key, section);
  });

  const sections = Array.from(sectionsByHeading.values());
  const pathNodes = nodes.filter((node) => node.status !== "not_applicable");
  const skippedBranches = nodes.filter((node) => node.status === "not_applicable");
  const takenBranches = nodes.filter((node) => node.isCondition && node.status !== "not_applicable");
  const riskNodes = nodes.filter((node) => node.status === "violated" || node.status === "missed" || node.status === "unknown");
  return { nodes, sections, pathNodes, takenBranches, skippedBranches, riskNodes, source: "derived", edges: [] };
}

function buildSkillGraphFromArtifact(project: SkillLensProject, artifact: SkillGraphArtifact): SkillGraph {
  const units = new Map(project.units.map((unit) => [unit.id, unit]));
  const findingsByUnit = new Map<string, CoverageFinding[]>();
  project.findings.forEach((finding) => {
    findingsByUnit.set(finding.unitId, [...(findingsByUnit.get(finding.unitId) ?? []), finding]);
  });
  const artifactNodes = new Map(artifact.nodes.map((node) => [node.id, node]));
  const parentByChild = new Map<string, { parentId: string; label?: string }>();
  artifact.nodes.forEach((node) => {
    if (node.parentId) {
      parentByChild.set(node.id, { parentId: node.parentId });
    }
  });
  artifact.edges.forEach((edge) => {
    if (!parentByChild.has(edge.to) && ["contains", "then", "else", "condition_true", "condition_false", "requires"].includes(edge.kind)) {
      parentByChild.set(edge.to, { parentId: edge.from, label: edge.label ?? edge.kind });
    }
  });
  const depthMemo = new Map<string, number>();
  const depthFor = (nodeId: string, seen = new Set<string>()): number => {
    if (depthMemo.has(nodeId)) {
      return depthMemo.get(nodeId) ?? 0;
    }
    if (seen.has(nodeId)) {
      return 0;
    }
    const parent = parentByChild.get(nodeId)?.parentId;
    const depth = parent && artifactNodes.has(parent) ? 1 + depthFor(parent, new Set([...seen, nodeId])) : 0;
    depthMemo.set(nodeId, depth);
    return depth;
  };
  const pathNodeIds = new Set(artifact.paths.flatMap((pathItem) => pathItem.nodeIds));
  const nodes = artifact.nodes
    .filter((node) => graphArtifactNodeIsDisplayable(node))
    .map((graphNode) => {
      const unit = graphNode.unitId ? units.get(graphNode.unitId) : undefined;
      const matchingFinding = bestFindingForGraphNode(graphNode, findingsByUnit.get(graphNode.unitId ?? "") ?? []);
      const status = graphNode.status ?? matchingFinding?.status ?? (graphNode.branchState === "not_taken" ? "not_applicable" : "unknown");
      const confidence = graphNode.confidence ?? matchingFinding?.confidence ?? 0;
      const lineStart = graphNode.sourceSpan?.lineStart ?? matchingFinding?.analyzedConstraint?.span.lineStart ?? unit?.lineStart ?? 0;
      const lineEnd = graphNode.sourceSpan?.lineEnd ?? matchingFinding?.analyzedConstraint?.span.lineEnd ?? unit?.lineEnd ?? lineStart;
      const evidenceEventIds = uniqueStrings([...(graphNode.evidenceEventIds ?? []), ...(matchingFinding?.evidenceEventIds ?? [])]);
      const isCondition = isConditionGraphNode(graphNode.kind, `${graphNode.predicate ?? ""} ${graphNode.text}`, status);
      const branchState =
        graphNode.branchState === "not_taken" || status === "not_applicable"
          ? "not_taken"
          : graphNode.branchState === "taken" || (isCondition && pathNodeIds.has(graphNode.id))
            ? "taken"
            : graphNode.branchState === "checked" || status !== "unknown"
              ? "checked"
              : "unknown";
      const fallbackFinding: CoverageFinding = matchingFinding ?? {
        id: graphNode.id,
        unitId: unit?.id ?? graphNode.unitId ?? graphNode.id,
        analyzedConstraint: unit
          ? {
              kind: graphNode.kind,
              text: graphNode.text,
              severity: "info",
              span: graphNode.sourceSpan ?? {
                lineStart: unit.lineStart,
                lineEnd: unit.lineEnd,
                charStart: 0,
                charEnd: unit.text.length,
                text: graphNode.text
              }
            }
          : undefined,
        status,
        confidence,
        rationale: graphNode.rationale ?? "Agent skill graph node; no separate coverage finding was matched.",
        evidenceEventIds,
        counterEvidenceEventIds: [],
        suggestedRewrite: null,
        candidateEventIds: [],
        analysisMethod: "hybrid",
        analysisRecipe: artifact.requestId ? `skilllens.skill-graph:${artifact.requestId}` : "skilllens.skill-graph"
      };
      return {
        id: matchingFinding?.id ?? graphNode.id,
        graphNodeId: graphNode.id,
        unitId: unit?.id ?? graphNode.unitId ?? graphNode.id,
        constraintId: graphNode.constraintId,
        parentGraphNodeId: parentByChild.get(graphNode.id)?.parentId,
        heading: graphSectionTitle(graphNode, artifactNodes, parentByChild, unit),
        edgeLabel: parentByChild.get(graphNode.id)?.label,
        depth: depthFor(graphNode.id),
        text: graphNode.predicate ? `${graphNode.predicate}: ${graphNode.text}` : graphNode.text,
        kind: graphNode.kind,
        status,
        confidence,
        lineStart,
        lineEnd,
        evidenceEventIds,
        finding: fallbackFinding,
        isCondition,
        branchState
      } satisfies SkillGraphNode;
    })
    .sort((a, b) => a.lineStart - b.lineStart || a.depth - b.depth || a.id.localeCompare(b.id));

  const sectionsByHeading = new Map<string, SkillGraphSection>();
  nodes.forEach((node) => {
    const section = sectionsByHeading.get(node.heading) ?? {
      id: node.heading,
      title: node.heading,
      nodes: []
    };
    section.nodes.push(node);
    sectionsByHeading.set(node.heading, section);
  });

  const pathNodeSet = new Set(artifact.paths.flatMap((pathItem) => pathItem.nodeIds));
  const pathNodes = pathNodeSet.size
    ? nodes.filter((node) => node.graphNodeId && pathNodeSet.has(node.graphNodeId))
    : nodes.filter((node) => node.branchState !== "not_taken");
  const skippedBranches = nodes.filter((node) => node.branchState === "not_taken" || node.status === "not_applicable");
  const takenBranches = nodes.filter((node) => node.isCondition && node.branchState === "taken");
  const riskNodes = nodes.filter((node) => node.status === "violated" || node.status === "missed" || node.status === "unknown");
  return {
    nodes,
    sections: Array.from(sectionsByHeading.values()),
    pathNodes,
    takenBranches,
    skippedBranches,
    riskNodes,
    source: "agent",
    edges: artifact.edges
  };
}

function isConditionGraphNode(kind: string, text: string, status: CoverageStatus): boolean {
  if (status === "not_applicable" || kind === "condition") {
    return true;
  }
  return /\b(if|when|only when|unless|trigger|for python|for java|for js|for javascript|for typescript|for each|before concluding|after|provided that)\b/i.test(text);
}

function branchStateLabel(node: SkillGraphNode, locale: Locale): string {
  const t = ui(locale);
  if (node.branchState === "not_taken") {
    return t.graph.branchNotTaken;
  }
  if (node.branchState === "taken") {
    return t.graph.branchTaken;
  }
  if (node.branchState === "unknown") {
    return t.graph.branchUnknown;
  }
  return t.graph.branchChecked;
}

function graphKindLabel(kind: string, locale: Locale): string {
  return ui(locale).graph.kind[kind] ?? ui(locale).graph.kind.other;
}

function skillGraphForProject(project: SkillLensProject): SkillGraphArtifact | null {
  return skillGraphFromUnknown(project.result.skillGraph);
}

function skillGraphFromUnknown(value: unknown): SkillGraphArtifact | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const object = value as Partial<SkillGraphArtifact>;
  if (!Array.isArray(object.nodes)) {
    return null;
  }
  return {
    schemaVersion: "skilllens.skill-graph.v1",
    requestId: typeof object.requestId === "string" ? object.requestId : undefined,
    nodes: object.nodes,
    edges: Array.isArray(object.edges) ? object.edges : [],
    paths: Array.isArray(object.paths) ? object.paths : []
  };
}

function graphArtifactNodeIsDisplayable(node: AgentSkillGraphNode): boolean {
  if (node.kind === "root" || node.kind === "section") {
    return false;
  }
  return Boolean(node.unitId || node.text || node.label);
}

function bestFindingForGraphNode(node: AgentSkillGraphNode, findings: CoverageFinding[]): CoverageFinding | undefined {
  if (!findings.length) {
    return undefined;
  }
  const normalizedNodeText = normalizeGraphText(node.text || node.label);
  return [...findings].sort((a, b) => {
    const aScore = graphFindingMatchScore(node, normalizedNodeText, a);
    const bScore = graphFindingMatchScore(node, normalizedNodeText, b);
    return bScore - aScore || compareFindingsForDisplay(a, b);
  })[0];
}

function graphFindingMatchScore(node: AgentSkillGraphNode, normalizedNodeText: string, finding: CoverageFinding): number {
  let score = 0;
  if (node.constraintId && finding.constraintId === node.constraintId) {
    score += 8;
  }
  const findingText = normalizeGraphText(finding.analyzedConstraint?.text ?? finding.analyzedConstraint?.span.text ?? "");
  if (findingText && normalizedNodeText) {
    if (findingText === normalizedNodeText) {
      score += 6;
    } else if (findingText.includes(normalizedNodeText) || normalizedNodeText.includes(findingText)) {
      score += 3;
    }
  }
  if (node.sourceSpan && finding.analyzedConstraint?.span) {
    const span = finding.analyzedConstraint.span;
    if (span.lineStart === node.sourceSpan.lineStart && span.lineEnd === node.sourceSpan.lineEnd) {
      score += 2;
    }
  }
  return score;
}

function graphSectionTitle(
  node: AgentSkillGraphNode,
  nodes: Map<string, AgentSkillGraphNode>,
  parentByChild: Map<string, { parentId: string; label?: string }>,
  unit?: SkillUnit
): string {
  let current = parentByChild.get(node.id)?.parentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = nodes.get(current);
    if (!parent) {
      break;
    }
    if (parent.kind === "section" || parent.kind === "root") {
      return parent.label || parent.text || "Skill graph";
    }
    current = parentByChild.get(parent.id)?.parentId;
  }
  return unit?.headingPath.join(" / ") || "Skill graph";
}

function normalizeGraphText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 180);
}

function TimelineView({
  project,
  events,
  selectedEvent,
  filter,
  onFilter,
  onSelectEvent,
  onSelectUnit
}: {
  project: SkillLensProject;
  events: TraceEvent[];
  selectedEvent?: TraceEvent;
  filter: TimelineFilter;
  onFilter: (filter: TimelineFilter) => void;
  onSelectEvent: (id: string) => void;
  onSelectUnit: (id: string) => void;
}) {
  const t = ui(useLocale());
  const [visibleLimit, setVisibleLimit] = useState(TIMELINE_PAGE_SIZE);
  const eventUnitIndex = useMemo(() => buildEventUnitIndex(project.findings), [project.findings]);
  const visibleEvents = events.slice(0, visibleLimit);
  const effectiveSelectedEvent = selectedEvent ?? visibleEvents[0];
  const relatedUnitIds = effectiveSelectedEvent ? eventUnitIndex.get(effectiveSelectedEvent.id) ?? [] : [];

  useEffect(() => {
    setVisibleLimit(TIMELINE_PAGE_SIZE);
  }, [events.length, filter]);

  return (
    <div className="timeline-layout">
      <div className="timeline-main">
        <div className="toolbar">
          {(["all", "skill", "violations", "tools", "final"] as TimelineFilter[]).map((item) => (
            <button key={item} className={filter === item ? "segmented active" : "segmented"} onClick={() => onFilter(item)}>
              {t.timelineFilters[item]}
            </button>
          ))}
          <span className="timeline-count">
            {Math.min(visibleLimit, events.length)} / {events.length}
          </span>
        </div>
        <div className="timeline-list">
          {visibleEvents.map((event) => {
            const units = eventUnitIndex.get(event.id) ?? [];
            return (
              <button
                key={event.id}
                className={effectiveSelectedEvent?.id === event.id ? "timeline-event active" : "timeline-event"}
                onClick={() => onSelectEvent(event.id)}
              >
                <div className="event-step">{event.step}</div>
                <div className="event-content">
                  <div className="event-title">
                    <span>{event.type.replace("_", " ")}</span>
                    {event.name ? <strong>{event.name}</strong> : null}
                  </div>
                  <p>{truncate(event.content || event.output, 220)}</p>
                  <div className="event-tags">
                    {event.files.slice(0, 3).map((file) => (
                      <span key={file}>{file}</span>
                    ))}
                    {units.slice(0, 3).map((unitId) => (
                      <span key={unitId}>{unitId.replace("skill.unit.", "#")}</span>
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
          {visibleLimit < events.length ? (
            <button className="load-more" onClick={() => setVisibleLimit((current) => current + TIMELINE_PAGE_SIZE)}>
              {t.timeline.loadMore}
            </button>
          ) : null}
        </div>
      </div>
      <aside className="timeline-detail">
        <div className="column-title">{t.timeline.details}</div>
        {effectiveSelectedEvent ? (
          <>
            <div className="detail-block">
              <h3>{effectiveSelectedEvent.id}</h3>
              <p>{effectiveSelectedEvent.type.replace("_", " ")} · {effectiveSelectedEvent.role}</p>
              {effectiveSelectedEvent.name ? <small>{effectiveSelectedEvent.name}</small> : null}
            </div>
            <pre>{truncate(JSON.stringify(effectiveSelectedEvent.raw, null, 2), 8000)}</pre>
            <div className="detail-block">
              <h3>{t.timeline.relatedConstraints}</h3>
              {relatedUnitIds.length ? (
                relatedUnitIds.map((unitId) => {
                  const unit = project.units.find((candidate) => candidate.id === unitId);
                  return (
                    <button className="related-unit" key={unitId} onClick={() => onSelectUnit(unitId)}>
                      {unit ? truncate(unit.text, 110) : unitId}
                    </button>
                  );
                })
              ) : (
                <p className="muted">{t.timeline.noRelated}</p>
              )}
            </div>
          </>
        ) : (
          <p className="muted">{t.timeline.selectEvent}</p>
        )}
      </aside>
    </div>
  );
}

function CompareView({
  project,
  compareProject,
  projects,
  compareId,
  onCompareChange
}: {
  project: SkillLensProject;
  compareProject: SkillLensProject;
  projects: SkillLensProject[];
  compareId: string;
  onCompareChange: (id: string) => void;
}) {
  const left = summarizeCoverage(project.findings);
  const right = summarizeCoverage(compareProject.findings);
  const successOnly = project.findings.filter(
    (finding) =>
      finding.status === "covered" &&
      compareProject.findings.find((candidate) => candidate.unitId === finding.unitId)?.status !== "covered"
  );
  const failureOnly = compareProject.findings.filter(
    (finding) =>
      ["missed", "violated"].includes(finding.status) &&
      project.findings.find((candidate) => candidate.unitId === finding.unitId)?.status === "covered"
  );

  return (
    <div className="compare-view">
      <div className="compare-controls">
        <span>{project.name}</span>
        <GitCompare size={18} />
        <select value={compareId} onChange={(event) => onCompareChange(event.target.value)}>
          {projects
            .filter((candidate) => candidate.id !== project.id)
            .map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.name}
              </option>
            ))}
        </select>
      </div>
      <div className="compare-grid">
        <CompareMetric label="Followed delta" left={left.coverageRate} right={right.coverageRate} />
        <CompareMetric label="Violated/Ignored delta" left={left.riskRate} right={right.riskRate} invert />
        <CompareMetric label="Trace length" left={project.events.length} right={compareProject.events.length} raw />
        <CompareMetric label="Reward" left={Number(project.result.score ?? 0)} right={Number(compareProject.result.score ?? 0)} />
      </div>
      <div className="delta-columns">
        <div>
          <h3>Only followed in current</h3>
          {successOnly.length ? (
            successOnly.slice(0, 6).map((finding) => (
              <DeltaRow key={finding.id} project={project} finding={finding} />
            ))
          ) : (
            <p className="muted">No current-only followed units.</p>
          )}
        </div>
        <div>
          <h3>Violated or ignored in comparison</h3>
          {failureOnly.length ? (
            failureOnly.slice(0, 6).map((finding) => (
              <DeltaRow key={finding.id} project={compareProject} finding={finding} />
            ))
          ) : (
            <p className="muted">No comparison-only risk units.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function AnalysisProcessView({
  analyzing,
  error,
  message,
  steps,
  audit,
  agentEvents,
  agentProcesses,
  traceTails,
  onKillProcess,
  onTraceTail
}: {
  analyzing: boolean;
  error: string;
  message: string;
  steps: AnalysisStep[];
  audit: AgentAnalysisAudit | null;
  agentEvents: AgentLiveEvent[];
  agentProcesses: AgentProcessEvent[];
  traceTails: Record<string, TraceTailState>;
  onKillProcess: (processEvent: AgentProcessEvent) => void;
  onTraceTail: Dispatch<SetStateAction<Record<string, TraceTailState>>>;
}) {
  const locale = useLocale();
  const t = ui(locale);
  const visibleSteps = steps.length
    ? steps
    : [
        {
          label: t.analysis.defaultStep,
          status: "pending" as const,
          detail: t.analysis.defaultStepDetail
        }
      ];
  const contentEvents = agentEvents.filter(hasDisplayableAgentContent).slice(-80);
  const conclusions = extractAgentConclusions(agentEvents, audit?.rawAnalysis).slice(0, 12);
  const activeProcesses = agentProcesses.filter((processEvent) => ["started", "running"].includes(processEvent.status));
  const progress = summarizeProcessProgress(steps, agentEvents, agentProcesses);
  const traceTailsRef = useRef(traceTails);
  const tracePathsKey = useMemo(
    () => Array.from(new Set(agentProcesses.map((processEvent) => processEvent.tracePath).filter(Boolean))).sort().join("\n"),
    [agentProcesses]
  );

  useEffect(() => {
    traceTailsRef.current = traceTails;
  }, [traceTails]);

  useEffect(() => {
    const tracePaths = tracePathsKey.split("\n").filter(Boolean);
    if (!tracePaths.length) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      await Promise.all(
        tracePaths.map(async (tracePath) => {
          const current = traceTailsRef.current[tracePath];
          try {
            const response = await fetch(
              `/api/agent-processes/trace?path=${encodeURIComponent(tracePath)}&offset=${current?.nextOffset ?? 0}&maxBytes=32000`
            );
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const payload = (await response.json()) as Omit<TraceTailState, "updatedAt">;
            if (cancelled) {
              return;
            }
            onTraceTail((existing) => ({
              ...existing,
              [tracePath]: {
                ...payload,
                updatedAt: new Date().toISOString(),
                content: `${existing[tracePath]?.content ?? ""}${payload.content}`.slice(-90000)
              }
            }));
          } catch (traceError) {
            if (!cancelled) {
              onTraceTail((existing) => ({
                ...existing,
                [tracePath]: {
                  path: tracePath,
                  offset: existing[tracePath]?.offset ?? 0,
                  nextOffset: existing[tracePath]?.nextOffset ?? 0,
                  size: existing[tracePath]?.size ?? 0,
                  mtime: existing[tracePath]?.mtime ?? "",
                  content: existing[tracePath]?.content ?? "",
                  updatedAt: new Date().toISOString(),
                  error: traceError instanceof Error ? traceError.message : "Failed to read trace."
                }
              }));
            }
          }
        })
      );
    };
    void load();
    const timer = window.setInterval(load, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onTraceTail, tracePathsKey]);
  const paths = audit
    ? [
        ["cache key", audit.cacheKey],
        ["analyzer skill", audit.analyzerSkillPath],
        [locale === "zh" ? "工作目录" : "work dir", audit.workDir],
        ["request.json", audit.requestPath],
        ["prompt.txt", audit.promptPath],
        ["selected-skill.md", audit.selectedSkillPath],
        ["constraint-seed.json", audit.constraintSeedPath],
        ["trace-events.json", audit.traceEventsPath],
        ["trace-facts.json", audit.traceFactsPath],
        ["selected-trace.jsonl", audit.rawTracePath],
        ["progress.md", audit.progressPath],
        ["constraints.json", audit.constraintsPath],
        ["skill-graph.json", audit.skillGraphPath],
        ["agent-output.txt", audit.rawOutputPath],
        ["response.json", audit.responsePath],
        ["findings.json", audit.findingsPath],
        ["optimizer skill", audit.optimizerSkillPath],
        ["optimization-prompt.txt", audit.optimizationPromptPath],
        ["optimized-skill.md", audit.optimizedSkillPath],
        ["optimization-report.md", audit.optimizationReportPath],
        ["optimization-diff.md", audit.optimizationDiffPath],
        ["optimization-packet.json", audit.optimizationPacketPath],
        ["optimizer-output.txt", audit.optimizerRawOutputPath]
      ].filter((item): item is [string, string] => Boolean(item[1]))
    : [];

  return (
    <div className="analysis-process-view">
      <div className="analysis-process-main">
        <div className="process-head">
          <div>
            <h3>{analyzing ? t.analysis.running : error ? t.analysis.failed : message ? t.analysis.done : t.analysis.title}</h3>
            <p>
              {audit?.runner
                ? `${audit.runner} · ${audit.requestId}${audit.cached ? " · cached" : ""}`
                : t.analysis.intro}
            </p>
          </div>
          <span className={analyzing ? "process-status running" : error ? "process-status error" : message ? "process-status done" : "process-status"}>
            {analyzing ? "running" : error ? "failed" : message ? "done" : "idle"}
          </span>
        </div>

        {error ? <p className="error-text process-message">{error}</p> : null}
        {message ? <p className="muted process-message">{message}</p> : null}

        <div className="monitor-grid">
          <div className="monitor-panel">
            <div className="stream-head">
              <strong>{locale === "zh" ? "运行进度" : "Run Progress"}</strong>
              <span>{progress.percent}%</span>
            </div>
            <div className="progress-bar">
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            <p>{progress.label}</p>
          </div>
          <div className="monitor-panel">
            <div className="stream-head">
              <strong>{locale === "zh" ? "进程" : "Processes"}</strong>
              <span>{activeProcesses.length} active / {agentProcesses.length} total</span>
            </div>
            {agentProcesses.length ? (
              <div className="process-table">
                {agentProcesses.map((processEvent) => (
                  <div className={`process-row ${processEvent.status}`} key={processEvent.id}>
                    <div>
                      <strong>{processEvent.command}</strong>
                      <code>pid {processEvent.pid ?? "?"}{processEvent.pgid ? ` · pgid ${processEvent.pgid}` : ""}</code>
                      <p>{truncate(processEvent.args.join(" "), 180)}</p>
                      {processEvent.tracePath ? <small>trace {formatBytes(processEvent.traceSize ?? 0)} · {processEvent.tracePath}</small> : null}
                    </div>
                    {["started", "running"].includes(processEvent.status) ? (
                      <button className="secondary-button danger" onClick={() => onKillProcess(processEvent)}>
                        {locale === "zh" ? "停止" : "Stop"}
                      </button>
                    ) : (
                      <span>{processEvent.status}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted stream-empty">{locale === "zh" ? "尚未观察到子进程。" : "No child process observed yet."}</p>
            )}
          </div>
        </div>

        {conclusions.length ? (
          <div className="agent-conclusions">
            <div className="stream-head">
              <strong>{locale === "zh" ? "运行中结论" : "Working Conclusions"}</strong>
              <span>{conclusions.length}</span>
            </div>
            <div className="conclusion-list">
              {conclusions.map((item, index) => (
                <p key={`${item.slice(0, 48)}-${index}`}>{item}</p>
              ))}
            </div>
          </div>
        ) : null}

        <div className="process-steps">
          {visibleSteps.map((step, index) => (
            <div className={`process-step ${step.status}`} key={`${step.label}-${index}`}>
              <span className="process-step-dot" />
              <div>
                <strong>{step.label}</strong>
                {step.detail ? <p>{step.detail}</p> : null}
              </div>
            </div>
          ))}
        </div>

        {audit?.rawAnalysis ? (
          <div className="agent-final-analysis">
            <div className="stream-head">
              <strong>{t.analysis.final}</strong>
              <span>final answer</span>
            </div>
            <pre>{audit.rawAnalysis}</pre>
          </div>
        ) : null}

        <div className="agent-json-stream">
          <div className="stream-head">
            <strong>{t.analysis.realtime}</strong>
            <span>{contentEvents.length} content events</span>
          </div>
          {contentEvents.length ? (
            <div className="stream-list">
              {contentEvents.map((event, index) => {
                const item = describeAgentEvent(event, locale);
                const eventJson = formatAgentEventJson(event);
                return (
                  <div className={`stream-event ${item.tone}`} key={`${event.at}-${index}`}>
                    <div className="stream-event-header">
                      <strong>{item.title}</strong>
                      <span>{formatShortTime(event.at)}</span>
                    </div>
                    {item.body ? <p>{item.body}</p> : null}
                    <details className="stream-event-raw">
                      <summary>{t.analysis.rawEvent}</summary>
                      <pre className="stream-event-json">{eventJson}</pre>
                    </details>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted stream-empty">
              {audit?.cached ? t.analysis.cachedEmpty : t.analysis.waitingContent}
            </p>
          )}
        </div>

        {Object.values(traceTails).length ? (
          <div className="agent-json-stream">
            <div className="stream-head">
              <strong>{locale === "zh" ? "轨迹文件增长" : "Trace Growth"}</strong>
              <span>{Object.values(traceTails).length} files</span>
            </div>
            <div className="stream-list">
              {Object.values(traceTails).map((tail) => (
                <div className="trace-tail" key={tail.path}>
                  <div className="stream-event-header">
                    <strong>{formatBytes(tail.size)} · {tail.mtime ? formatShortTime(tail.mtime) : ""}</strong>
                    <span>{tail.error ?? tail.path}</span>
                  </div>
                  <pre>{tail.content ? truncate(tail.content, 12000) : locale === "zh" ? "等待新内容..." : "Waiting for new content..."}</pre>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <aside className="analysis-process-side">
        <div className="column-title">{t.analysis.debugFiles}</div>
        {paths.length ? (
          <div className="path-list">
            {paths.map(([label, value]) => (
              <div className="path-row" key={label}>
                <strong>{label}</strong>
                <code>{value}</code>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted path-empty">{t.analysis.debugEmpty}</p>
        )}
      </aside>
    </div>
  );
}

function MonitorPage({
  onBack,
  onKillProcess
}: {
  onBack: () => void;
  onKillProcess: (processEvent: AgentProcessEvent) => void;
}) {
  const locale = useLocale();
  const t = ui(locale);
  return (
    <section className="monitor-page">
      <div className="analysis-topbar monitor-page-topbar">
        <button className="secondary-button" onClick={onBack}>
          <ArrowLeft size={16} />
          {t.app.back}
        </button>
        <div className="analysis-title-block">
          <span>{locale === "zh" ? "Agent 进程可视化管理" : "Agent Process Monitor"}</span>
          <h2>{t.views.monitor}</h2>
          <p>
            {locale === "zh"
              ? "独立于 Skill 优化页面，用来查看 agent 启动的进程树、trace、日志产物，并支持停止单个进程或整组任务。"
              : "Separate from the skill optimization page. Inspect agent process trees, traces, artifacts, and stop one process or a whole group."}
          </p>
        </div>
      </div>
      <SystemMonitorView onKillProcess={onKillProcess} />
    </section>
  );
}

function SystemMonitorView({ onKillProcess: _onKillProcess }: { onKillProcess: (processEvent: AgentProcessEvent) => void }) {
  const locale = useLocale();
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [filter, setFilter] = useState<JobFilter>(() =>
    readMonitorPreference("skillscope.monitor.filter", "active", ["active", "issues", "recent", "stale", "docker"] as const)
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<JobSort>(() =>
    readMonitorPreference("skillscope.monitor.sort", "updated", ["attention", "updated", "runtime", "title"] as const)
  );
  const [autoRefresh, setAutoRefresh] = useState(() => readMonitorPreference("skillscope.monitor.autoRefresh", "true", ["true", "false"] as const) === "true");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [error, setError] = useState("");
  const [artifactTails, setArtifactTails] = useState<Record<string, TraceTailState>>({});
  const [stopPlans, setStopPlans] = useState<Record<string, AgentStopPlan>>({});
  const [stopResults, setStopResults] = useState<Record<string, AgentStopResult>>({});
  const [stopError, setStopError] = useState("");
  const [stopNotice, setStopNotice] = useState("");
  const [stoppingJobId, setStoppingJobId] = useState("");
  const artifactTailsRef = useRef(artifactTails);
  const artifactPathsKey = useMemo(() => {
    const paths = jobs.flatMap((job) => job.artifacts.map((artifact) => artifact.path));
    return Array.from(new Set(paths)).sort().join("\n");
  }, [jobs]);
  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesFilter = (job: AgentJob) => {
      if (filter === "docker") {
        return job.containers.length > 0;
      }
      if (filter === "issues") {
        return jobNeedsAttention(job);
      }
      if (filter === "recent") {
        return ["recent", "stopped", "failed"].includes(job.status);
      }
      return job.status === filter;
    };
    const matchesQuery = (job: AgentJob) => {
      if (!normalizedQuery) {
        return true;
      }
      return jobSearchText(job).includes(normalizedQuery);
    };
    return jobs
      .filter((job) => matchesFilter(job) && matchesQuery(job))
      .sort((left, right) => compareJobs(left, right, sort));
  }, [filter, jobs, query, sort]);
  const selectedJob = filteredJobs.find((job) => job.id === selectedJobId) ?? filteredJobs[0];
  const metrics = useMemo(
    () => ({
      active: jobs.filter((job) => job.status === "active").length,
      stale: jobs.filter((job) => job.status === "stale").length,
      containers: jobs.reduce((count, job) => count + job.containers.length, 0),
      failures: jobs.filter((job) => job.status === "failed" || job.lastStopResult?.cleanupErrors.length).length,
      issues: jobs.filter(jobNeedsAttention).length,
      recent: jobs.filter((job) => ["recent", "stopped", "failed"].includes(job.status)).length,
      dockerJobs: jobs.filter((job) => job.containers.length).length
    }),
    [jobs]
  );

  useEffect(() => {
    artifactTailsRef.current = artifactTails;
  }, [artifactTails]);

  useEffect(() => {
    writeMonitorPreference("skillscope.monitor.filter", filter);
  }, [filter]);

  useEffect(() => {
    writeMonitorPreference("skillscope.monitor.sort", sort);
  }, [sort]);

  useEffect(() => {
    writeMonitorPreference("skillscope.monitor.autoRefresh", String(autoRefresh));
  }, [autoRefresh]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/agent-jobs");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as { jobs?: AgentJob[]; updatedAt?: string };
        if (!cancelled) {
          setJobs(payload.jobs ?? []);
          setUpdatedAt(payload.updatedAt ?? new Date().toISOString());
          setError("");
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load processes.");
        }
      }
    };
    void load();
    const timer = autoRefresh ? window.setInterval(load, 2000) : undefined;
    return () => {
      cancelled = true;
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [autoRefresh, reloadNonce]);

  useEffect(() => {
    const paths = artifactPathsKey.split("\n").filter(Boolean);
    if (!paths.length) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      await Promise.all(
        paths.map(async (artifactPath) => {
          const current = artifactTailsRef.current[artifactPath];
          try {
            const response = await fetch(
              `/api/agent-processes/trace?path=${encodeURIComponent(artifactPath)}&offset=${current?.nextOffset ?? 0}&maxBytes=24000`
            );
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const payload = (await response.json()) as Omit<TraceTailState, "updatedAt">;
            if (!cancelled) {
              setArtifactTails((existing) => ({
                ...existing,
                [artifactPath]: {
                  ...payload,
                  updatedAt: new Date().toISOString(),
                  content: `${existing[artifactPath]?.content ?? ""}${payload.content}`.slice(-70000)
                }
              }));
            }
          } catch (tailError) {
            if (!cancelled) {
              setArtifactTails((existing) => ({
                ...existing,
                [artifactPath]: {
                  path: artifactPath,
                  offset: existing[artifactPath]?.offset ?? 0,
                  nextOffset: existing[artifactPath]?.nextOffset ?? 0,
                  size: existing[artifactPath]?.size ?? 0,
                  mtime: existing[artifactPath]?.mtime ?? "",
                  content: existing[artifactPath]?.content ?? "",
                  updatedAt: new Date().toISOString(),
                  error: tailError instanceof Error ? tailError.message : "Failed to read artifact."
                }
              }));
            }
          }
        })
      );
    };
    void load();
    const timer = autoRefresh ? window.setInterval(load, 2000) : undefined;
    return () => {
      cancelled = true;
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [artifactPathsKey, autoRefresh]);

  async function previewStop(job: AgentJob) {
    setStopError("");
    setStoppingJobId(job.id);
    try {
      const response = await fetch(`/api/agent-jobs/${encodeURIComponent(job.id)}/stop/preview`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      const plan = (await response.json()) as AgentStopPlan;
      setStopPlans((current) => ({ ...current, [job.id]: plan }));
      setSelectedJobId(job.id);
    } catch (previewError) {
      setStopError(previewError instanceof Error ? previewError.message : "Failed to preview stop.");
    } finally {
      setStoppingJobId("");
    }
  }

  async function executeStop(job: AgentJob) {
    setStopError("");
    setStoppingJobId(job.id);
    try {
      const response = await fetch(`/api/agent-jobs/${encodeURIComponent(job.id)}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: "SIGTERM" })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      const payload = (await response.json()) as { job?: AgentJob; stopPlan?: AgentStopPlan; stopResult?: AgentStopResult };
      if (payload.job) {
        setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]);
      }
      if (payload.stopPlan) {
        setStopPlans((current) => ({ ...current, [job.id]: payload.stopPlan! }));
      }
      if (payload.stopResult) {
        setStopResults((current) => ({ ...current, [job.id]: payload.stopResult! }));
        setStopNotice(`Stop result: ${stopResultSummary(payload.stopResult)}`);
      }
      setFilter("recent");
      setSelectedJobId(job.id);
    } catch (stopFailure) {
      setStopError(stopFailure instanceof Error ? stopFailure.message : "Failed to stop job.");
    } finally {
      setStoppingJobId("");
    }
  }

  return (
    <div className="job-control-room monitor-only">
      <div className="job-control-main">
        <div className="process-head">
          <div>
            <h3>{locale === "zh" ? "Agent Job Control Room" : "Agent Job Control Room"}</h3>
            <p>
              {locale === "zh"
                ? "按任务聚合本机 Codex / Claude 长任务、进度、产物、容器和安全停止结果。"
                : "Local Codex / Claude long-running jobs, progress, artifacts, containers, and safe-stop results."}
            </p>
          </div>
          <span className="process-status running">{updatedAt ? formatShortTime(updatedAt) : ""}</span>
        </div>
        {error ? <p className="error-text process-message">{error}</p> : null}
        {stopError ? <p className="error-text process-message">{stopError}</p> : null}
        {stopNotice ? (
          <div className="job-notice">
            <strong>{stopNotice}</strong>
            <button className="icon-button" onClick={() => setStopNotice("")} aria-label="Dismiss stop result">
              <XCircle size={15} />
            </button>
          </div>
        ) : null}
        <div className="job-metrics">
          <JobMetric label="active jobs" value={metrics.active} tone="active" active={filter === "active"} onClick={() => setFilter("active")} />
          <JobMetric label="needs attention" value={metrics.issues} tone={metrics.issues ? "warn" : "normal"} active={filter === "issues"} onClick={() => setFilter("issues")} />
          <JobMetric label="containers" value={metrics.containers} tone="normal" active={filter === "docker"} onClick={() => setFilter("docker")} />
          <JobMetric label="cleanup issues" value={metrics.failures} tone={metrics.failures ? "danger" : "normal"} active={false} onClick={() => setFilter("issues")} />
        </div>
        <div className="job-filter-row" role="tablist" aria-label="Job filters">
          {(["active", "issues", "recent", "stale", "docker"] as const).map((item) => (
            <button key={item} className={filter === item ? "segmented active" : "segmented"} onClick={() => setFilter(item)}>
              {jobFilterLabel(item)}
              <span>{jobFilterCount(item, metrics)}</span>
            </button>
          ))}
        </div>
        <div className="job-toolbar">
          <div className="job-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search job, artifact, container, command"
              aria-label="Search jobs"
            />
            {query.trim() ? (
              <button className="icon-button" onClick={() => setQuery("")} aria-label="Clear search">
                <XCircle size={14} />
              </button>
            ) : null}
          </div>
          <select value={sort} onChange={(event) => setSort(event.target.value as JobSort)} aria-label="Sort jobs">
            <option value="attention">Needs attention</option>
            <option value="updated">Latest update</option>
            <option value="runtime">Longest runtime</option>
            <option value="title">Title</option>
          </select>
          <div className="job-live-controls">
            <button className="secondary-button" onClick={() => setReloadNonce((value) => value + 1)}>
              <RefreshCw size={15} />
              Refresh
            </button>
            <label className="job-live-toggle">
              <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
              <span>{autoRefresh ? "Live" : "Paused"}</span>
            </label>
          </div>
        </div>
        <div className="job-list-summary">
          <strong>{jobListSummary(filter, filteredJobs.length, jobs.length, query)}</strong>
          <span>{jobListDetail(filter, sort, autoRefresh, metrics)}</span>
        </div>
        <div className="job-card-grid">
          {filteredJobs.length ? (
            filteredJobs.map((job) => {
              const progress = progressWithTail(job, artifactTails);
              return (
                <button
                  className={selectedJob?.id === job.id ? `agent-process-group job-card selected ${job.status}` : `agent-process-group job-card ${job.status}`}
                  key={job.id}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <div className="job-card-head">
                    <div>
                      <strong>{job.title}</strong>
                      <span>{job.agentRoot?.label ?? job.agentRoot?.command ?? "agent"} · {formatJobRuntime(job.startedAt, job.lastUpdatedAt)}</span>
                    </div>
                    <span className={`job-status ${job.status}`}>{jobStatusLabel(job)}</span>
                  </div>
                  <p className={`job-card-reason ${jobAttentionTone(job)}`}>{jobAttentionReason(job, progress)}</p>
                  <JobProgress progress={progress} />
                  <div className="job-card-latest">
                    <span>Latest</span>
                    <p>{progress.latestLine ?? progress.detail}</p>
                  </div>
                  <div className="job-card-meta">
                    <span>{job.processes.length} proc</span>
                    <span>{job.artifacts.length} artifacts</span>
                    <span>{job.containers.length} containers</span>
                    <span>{formatStaleAge(job.staleSeconds)}</span>
                  </div>
                  {job.containers.length ? <small>docker {job.containers.map((container) => container.name).join(", ")}</small> : null}
                </button>
              );
            })
          ) : (
            <JobEmptyState
              filter={filter}
              query={query}
              metrics={metrics}
              onClearQuery={() => setQuery("")}
              onShowActive={() => setFilter("active")}
              onShowRecent={() => setFilter("recent")}
              onShowDocker={() => setFilter("docker")}
              onRefresh={() => setReloadNonce((value) => value + 1)}
            />
          )}
        </div>
      </div>
      <aside className="job-detail-side">
        {selectedJob ? (
          <JobDetail
            job={selectedJob}
            artifactTails={artifactTails}
            stopPlan={stopPlans[selectedJob.id] ?? selectedJob.stopPlan}
            stopResult={stopResults[selectedJob.id] ?? selectedJob.lastStopResult}
            busy={stoppingJobId === selectedJob.id}
            onPreview={() => previewStop(selectedJob)}
            onStop={() => executeStop(selectedJob)}
          />
        ) : (
          <JobDetailEmpty
            filter={filter}
            query={query}
            metrics={metrics}
            onClearQuery={() => setQuery("")}
            onShowRecent={() => setFilter("recent")}
            onRefresh={() => setReloadNonce((value) => value + 1)}
          />
        )}
      </aside>
    </div>
  );
}

function JobEmptyState({
  filter,
  query,
  metrics,
  onClearQuery,
  onShowActive,
  onShowRecent,
  onShowDocker,
  onRefresh
}: {
  filter: JobFilter;
  query: string;
  metrics: { active: number; stale: number; issues: number; recent: number; dockerJobs: number };
  onClearQuery: () => void;
  onShowActive: () => void;
  onShowRecent: () => void;
  onShowDocker: () => void;
  onRefresh: () => void;
}) {
  const hasQuery = Boolean(query.trim());
  return (
    <div className="job-empty-state">
      <strong>{hasQuery ? "No matching jobs" : jobEmptyTitle(filter)}</strong>
      <p>{hasQuery ? `Nothing matched "${query.trim()}". Try a shorter artifact name, container name, or command.` : jobEmptyMessage(filter, metrics)}</p>
      <div className="job-empty-actions">
        {hasQuery ? (
          <button className="secondary-button" onClick={onClearQuery}>
            Clear search
          </button>
        ) : null}
        {filter !== "active" && metrics.active ? (
          <button className="secondary-button" onClick={onShowActive}>
            Show active
          </button>
        ) : null}
        {filter !== "recent" && metrics.recent ? (
          <button className="secondary-button" onClick={onShowRecent}>
            Show recent
          </button>
        ) : null}
        {filter !== "docker" && metrics.dockerJobs ? (
          <button className="secondary-button" onClick={onShowDocker}>
            Show Docker
          </button>
        ) : null}
        <button className="secondary-button" onClick={onRefresh}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function JobDetailEmpty({
  filter,
  query,
  metrics,
  onClearQuery,
  onShowRecent,
  onRefresh
}: {
  filter: JobFilter;
  query: string;
  metrics: { recent: number };
  onClearQuery: () => void;
  onShowRecent: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="monitor-panel job-detail-empty">
      <strong>{query.trim() ? "Search has no selected job" : "No job selected"}</strong>
      <p>{query.trim() ? "Clear the search or pick another filter to inspect a job." : jobEmptyMessage(filter, metrics)}</p>
      <div className="job-empty-actions">
        {query.trim() ? (
          <button className="secondary-button" onClick={onClearQuery}>
            Clear search
          </button>
        ) : null}
        {filter !== "recent" && metrics.recent ? (
          <button className="secondary-button" onClick={onShowRecent}>
            Show recent
          </button>
        ) : null}
        <button className="secondary-button" onClick={onRefresh}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function JobMetric({
  label,
  value,
  tone,
  active,
  onClick
}: {
  label: string;
  value: number;
  tone: "active" | "warn" | "danger" | "normal";
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={active ? `job-metric ${tone} selected` : `job-metric ${tone}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
  );
}

function jobListSummary(filter: JobFilter, visibleCount: number, totalCount: number, query: string): string {
  const noun = visibleCount === 1 ? "job" : "jobs";
  const filterLabel = filter === "issues" ? "needing attention" : `${jobFilterLabel(filter).toLowerCase()} jobs`;
  if (query.trim()) {
    return `Showing ${visibleCount} matching ${noun} in ${filterLabel}`;
  }
  return `Showing ${visibleCount} ${filterLabel} out of ${totalCount} tracked jobs`;
}

function jobListDetail(
  filter: JobFilter,
  sort: JobSort,
  autoRefresh: boolean,
  metrics: { issues: number; failures: number }
): string {
  const sortLabel = sort === "attention" ? "attention priority" : sort === "runtime" ? "longest runtime" : sort === "title" ? "title" : "latest update";
  const refreshLabel = autoRefresh ? "Live refresh every 2s" : "Paused";
  if (filter === "issues") {
    const cleanup = metrics.failures ? `, including ${metrics.failures} cleanup issue${metrics.failures === 1 ? "" : "s"}` : "";
    return `Stale jobs and cleanup failures${cleanup}. Sorted by ${sortLabel}. ${refreshLabel}.`;
  }
  return `Sorted by ${sortLabel}. ${refreshLabel}.`;
}

function JobDetail({
  job,
  artifactTails,
  stopPlan,
  stopResult,
  busy,
  onPreview,
  onStop
}: {
  job: AgentJob;
  artifactTails: Record<string, TraceTailState>;
  stopPlan?: AgentStopPlan;
  stopResult?: AgentStopResult;
  busy: boolean;
  onPreview: () => void;
  onStop: () => void;
}) {
  const progress = progressWithTail(job, artifactTails);
  const primaryArtifact = job.artifacts[0];
  const stopSummary = stopResult ? stopResultSummary(stopResult) : stopPlan ? stopPlanSummary(stopPlan) : job.canStop ? "Preview the safe stop plan before stopping anything." : "Root agent is protected; no stoppable child task is available.";
  const hasStopTargets = stopPlan ? stopPlanHasTargets(stopPlan) : false;
  const nextAction = jobNextAction(job, progress, stopPlan, stopResult);
  const [copiedValue, setCopiedValue] = useState("");
  const copyValue = async (value: string) => {
    try {
      await copyTextToClipboard(value);
    } catch {
      // Some browser contexts block clipboard writes; still acknowledge the user's path selection.
    }
    setCopiedValue(value);
    window.setTimeout(() => {
      setCopiedValue((current) => (current === value ? "" : current));
    }, 1800);
  };
  return (
    <div className="monitor-panel job-detail">
      <div className="stream-head">
        <strong>{job.title}</strong>
        <span>{job.status}</span>
      </div>
      <div className="job-insight-grid">
        <div className={`job-insight ${job.status}`}>
          <span>Status</span>
          <strong>{jobStatusLabel(job)}</strong>
          <p>{jobStatusMessage(job)}</p>
        </div>
        <div className="job-insight">
          <span>Latest activity</span>
          <strong>{progress.label}</strong>
          <p>{progress.latestLine ?? progress.detail}</p>
        </div>
        <div className={stopResult?.cleanupErrors.length ? "job-insight failed" : "job-insight"}>
          <span>Safe stop</span>
          <strong>{stopResult ? "Finished" : stopPlan ? "Ready" : job.canStop ? "Available" : "Protected"}</strong>
          <p>{stopSummary}</p>
        </div>
      </div>
      <div className="job-detail-summary">
        <span>{job.agentRoot?.label ?? "agent root unknown"} is protected</span>
        <span>Started {formatShortTime(job.startedAt)} · Updated {formatShortTime(job.lastUpdatedAt)}</span>
        {primaryArtifact ? (
          <JobPathAction label="Primary artifact" value={primaryArtifact.path} copied={copiedValue === primaryArtifact.path} onCopy={() => void copyValue(primaryArtifact.path)} />
        ) : null}
        {job.historyPath ? <JobPathAction label="History JSON" value={job.historyPath} copied={copiedValue === job.historyPath} onCopy={() => void copyValue(job.historyPath!)} /> : null}
      </div>
      <div className={`job-next-action ${nextAction.tone}`}>
        <span>Next action</span>
        <strong>{nextAction.title}</strong>
        <p>{nextAction.body}</p>
      </div>
      <JobProgress progress={progress} />
      <section>
        <h4>Latest Output</h4>
        <div className="process-artifacts">
          {job.artifacts.length ? (
            job.artifacts.map((artifact) => {
              const tail = artifactTails[artifact.path];
              return (
                <details key={artifact.path} open={job.artifacts.length === 1}>
                  <summary>{artifact.label} · {formatBytes(tail?.size ?? artifact.size ?? 0)} · {artifact.path}</summary>
                  <JobPathAction label="Artifact path" value={artifact.path} copied={copiedValue === artifact.path} onCopy={() => void copyValue(artifact.path)} compact />
                  <pre>{tail?.content ? truncate(tail.content, 9000) : tail?.error ?? "Waiting for content..."}</pre>
                </details>
              );
            })
          ) : (
            <p className="muted stream-empty">No artifacts detected.</p>
          )}
        </div>
      </section>
      <section>
        <h4>Containers</h4>
        {job.containers.length ? (
          <div className="job-chip-row">{job.containers.map((container) => <span key={container.name}>{container.name}</span>)}</div>
        ) : (
          <p className="muted stream-empty">No Docker container attached.</p>
        )}
      </section>
      <section>
        <h4>Safe Stop</h4>
        {job.canStop ? (
          <div className="job-stop-actions">
            <button className="secondary-button" onClick={onPreview} disabled={busy}>
              {busy && !stopPlan ? "Preparing preview..." : "Preview stop safely"}
            </button>
            {stopPlan ? (
              <button className="secondary-button danger" onClick={onStop} disabled={busy || !hasStopTargets}>
                {busy ? "Stopping..." : "Execute stop"}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="muted stream-empty">Root agent is protected; no stoppable child task is available.</p>
        )}
        {stopPlan ? <StopPlanView plan={stopPlan} /> : null}
        {stopResult ? <StopResultView result={stopResult} /> : null}
      </section>
      <details className="job-technical-details">
        <summary>Technical details</summary>
        <section>
          <h4>Process Tree</h4>
          {job.processes.map((processEvent) => (
            <div className={`process-row ${processEvent.status}`} key={processEvent.id}>
              <div>
                <strong>{processEvent.command}</strong>
                <code>
                  pid {processEvent.pid ?? "?"}{processEvent.ppid ? ` · ppid ${processEvent.ppid}` : ""}
                  {processEvent.pgid ? ` · pgid ${processEvent.pgid}` : ""}
                </code>
                <p>{truncate(processEvent.args.join(" "), 220)}</p>
                <small>{processEvent.canStop ? "stoppable child" : "protected root or inherited process"}</small>
              </div>
              <span>{processEvent.status}</span>
            </div>
          ))}
        </section>
        <section>
          <h4>Safety rule</h4>
          <p className="job-technical-note">Stops only target child process groups and containers listed in the preview. Codex/Claude root agent groups stay protected.</p>
        </section>
      </details>
    </div>
  );
}

function JobPathAction({
  label,
  value,
  copied,
  onCopy,
  compact
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "job-path-action compact" : "job-path-action"}>
      <div>
        <span>{label}</span>
        <code>{value}</code>
      </div>
      <button className="secondary-button" onClick={onCopy}>
        <Copy size={14} />
        {copied ? "Copied" : "Copy path"}
      </button>
    </div>
  );
}

function StopPlanView({ plan }: { plan: AgentStopPlan }) {
  const processTargets = plan.processTargets.map((target) => ({
    key: target.pgid ? `pgid-${target.pgid}` : `pid-${target.pid ?? target.command}`,
    label: target.pgid ? `Process group ${target.pgid}` : `Process ${target.pid ?? "unknown"}`,
    detail: `${target.command} · ${target.reason}`
  }));
  const containerTargets = plan.containers.map((container) => ({
    key: `container-${container.name}`,
    label: container.name,
    detail: container.project ? `Docker container · compose project ${container.project}` : "Docker container"
  }));
  const willStop = [...processTargets, ...containerTargets];
  return (
    <div className="stop-plan">
      <strong>Stop preview</strong>
      <div className="stop-preview-grid">
        <div>
          <span>Will stop</span>
          {willStop.length ? (
            willStop.map((item) => (
              <p key={item.key}>
                <b>{item.label}</b>
                <small>{item.detail}</small>
              </p>
            ))
          ) : (
            <p>No child process group or container will be stopped.</p>
          )}
        </div>
        <div>
          <span>Will not touch</span>
          {plan.protectedRoot ? (
            <p>
              <b>{plan.protectedRoot.label ?? `Root pid ${plan.protectedRoot.pid ?? "?"}`}</b>
              <small>Codex/Claude root agent stays protected.</small>
            </p>
          ) : (
            <p>No root agent process was detected.</p>
          )}
        </div>
      </div>
      {plan.warnings.map((warning) => <p className="error-text" key={warning}>{warning}</p>)}
    </div>
  );
}

function StopResultView({ result }: { result: AgentStopResult }) {
  const residualProcesses = result.residualProcesses ?? [];
  const residualContainers = result.residualContainers ?? [];
  const killed = result.killedProcesses.filter((item) => item.ok).length;
  const removed = result.removedContainers.filter((item) => item.ok).length;
  return (
    <div className="stop-plan result">
      <strong>Stop result</strong>
      <p className={result.cleanupErrors.length ? "stop-result-summary failed" : "stop-result-summary success"}>{stopResultSummary(result)}</p>
      <div className="stop-result-grid">
        <div>
          <span>Handled</span>
          <p>{killed}/{result.killedProcesses.length} process targets stopped</p>
          <p>{removed}/{result.removedContainers.length} containers removed</p>
        </div>
        <div>
          <span>Needs review</span>
          <p>Residual processes: {residualProcesses.length ? residualProcesses.map((item) => item.pgid ? `pgid ${item.pgid}` : `pid ${item.pid}`).join(", ") : "none"}</p>
          <p>Residual containers: {residualContainers.length ? residualContainers.join(", ") : "none"}</p>
        </div>
      </div>
      {result.cleanupErrors.length ? <pre>{result.cleanupErrors.join("\n")}</pre> : <p>No cleanup errors.</p>}
    </div>
  );
}

function jobStatusLabel(job: AgentJob): string {
  if (job.status === "active") {
    return "Running";
  }
  if (job.status === "stale") {
    return "Needs attention";
  }
  if (job.status === "stopped") {
    return "Stopped";
  }
  if (job.status === "failed") {
    return "Cleanup issue";
  }
  return "Recent";
}

function jobEmptyTitle(filter: JobFilter): string {
  if (filter === "active") {
    return "No active jobs";
  }
  if (filter === "issues") {
    return "No jobs need attention";
  }
  if (filter === "recent") {
    return "No recent jobs";
  }
  if (filter === "stale") {
    return "No stale jobs";
  }
  return "No Docker jobs";
}

function jobEmptyMessage(filter: JobFilter, metrics: { recent?: number; active?: number; dockerJobs?: number }): string {
  if (filter === "active") {
    return metrics.recent
      ? "Nothing is running right now. Recent jobs are still available for review."
      : "Start a Codex or Claude benchmark, experiment, or long-running command and it will appear here.";
  }
  if (filter === "issues") {
    return "No stale jobs or cleanup failures are waiting for review.";
  }
  if (filter === "recent") {
    return "Stopped or completed jobs will appear here after they leave Active.";
  }
  if (filter === "stale") {
    return "No tracked job has gone quiet for more than 30 seconds.";
  }
  return metrics.active
    ? "Active jobs are running, but none currently have Docker containers attached."
    : "Docker jobs appear here when a tracked task starts a detached container or compose-backed workload.";
}

function jobStatusMessage(job: AgentJob): string {
  if (job.status === "active") {
    return `${job.processes.length} processes tracked. Last update ${formatStaleAge(job.staleSeconds)}.`;
  }
  if (job.status === "stale") {
    return `No artifact or log update for ${formatStaleAge(job.staleSeconds)}. It may still be running.`;
  }
  if (job.status === "stopped") {
    return "Stopped safely and kept in Recent history.";
  }
  if (job.status === "failed") {
    return "Stop or cleanup left errors. Check residual processes and containers below.";
  }
  return "Completed or no longer active. History and artifacts are kept here.";
}

function jobAttentionTone(job: AgentJob): "normal" | "warn" | "danger" | "success" {
  if (job.status === "failed") {
    return "danger";
  }
  if (job.status === "stale") {
    return "warn";
  }
  if (job.status === "stopped") {
    return "success";
  }
  return "normal";
}

function jobAttentionReason(job: AgentJob, progress: AgentJobProgress): string {
  if (job.status === "failed") {
    return job.lastStopResult?.cleanupErrors.length
      ? `${job.lastStopResult.cleanupErrors.length} cleanup issue${job.lastStopResult.cleanupErrors.length === 1 ? "" : "s"} need review.`
      : "The job ended with a failure signal; inspect stop result and residuals.";
  }
  if (job.status === "stale") {
    return `No new output for ${formatStaleAge(job.staleSeconds)}. The task may be blocked, but it has not been stopped.`;
  }
  if (job.status === "stopped") {
    return job.lastStopResult ? stopResultSummary(job.lastStopResult) : "Stopped safely and saved to Recent history.";
  }
  if (job.containers.length) {
    return `${job.containers.length} Docker container${job.containers.length === 1 ? "" : "s"} attached to this job.`;
  }
  if (progress.percent !== undefined) {
    return `Progress is visible: ${Math.round(progress.percent)}% inferred from artifacts.`;
  }
  return "Live job with output and artifacts grouped for review.";
}

function jobNextAction(
  job: AgentJob,
  progress: AgentJobProgress,
  stopPlan?: AgentStopPlan,
  stopResult?: AgentStopResult
): { tone: "normal" | "warn" | "danger" | "success"; title: string; body: string } {
  if (stopResult?.cleanupErrors.length) {
    return {
      tone: "danger",
      title: "Review cleanup issues",
      body: "Check residual processes and containers before starting another run that reuses the same files or container names."
    };
  }
  if (stopResult) {
    return {
      tone: "success",
      title: "Review the finished run",
      body: "The stop result is saved in Recent history. Inspect the latest output or history path if you need to keep evidence."
    };
  }
  if (job.status === "stale") {
    return {
      tone: "warn",
      title: "Decide whether it is blocked",
      body: stopPlan
        ? "The safe stop preview is ready. Stop only the listed child targets if the task should not keep running."
        : "Look at the latest output first. If it is not expected to be quiet, preview a safe stop before stopping anything."
    };
  }
  if (stopPlan) {
    return {
      tone: stopPlanHasTargets(stopPlan) ? "warn" : "normal",
      title: stopPlanHasTargets(stopPlan) ? "Confirm the stop list" : "No stoppable targets",
      body: stopPlanHasTargets(stopPlan)
        ? "Only the targets under Will stop will be touched. The root agent remains protected."
        : "The preview found no child process group or container to stop, so execution is disabled."
    };
  }
  if (job.canStop) {
    return {
      tone: "normal",
      title: "Watch progress or preview stop",
      body: progress.percent !== undefined
        ? `Progress is at ${Math.round(progress.percent)}%. Preview safe stop first if you need to interrupt it.`
        : "Output is updating without a fixed total. Preview safe stop first if you need to interrupt it."
    };
  }
  if (job.status === "recent") {
    return {
      tone: "normal",
      title: "Review history",
      body: "This job is no longer active. Use the latest output and artifact path for follow-up."
    };
  }
  return {
    tone: "normal",
    title: "No stop action available",
    body: "Only protected root or inherited processes are visible for this job."
  };
}

function stopPlanHasTargets(plan: AgentStopPlan): boolean {
  return Boolean(plan.processTargets.length || plan.containers.length);
}

function stopPlanSummary(plan: AgentStopPlan): string {
  const processes = plan.processTargets.length;
  const containers = plan.containers.length;
  const parts = [
    processes ? `${processes} child process target${processes === 1 ? "" : "s"}` : "",
    containers ? `${containers} container${containers === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  return parts.length ? `Ready to stop ${parts.join(" and ")}. Root agent remains protected.` : "Nothing stoppable was found in this job.";
}

function stopResultSummary(result: AgentStopResult): string {
  if (result.cleanupErrors.length) {
    return `${result.cleanupErrors.length} cleanup issue${result.cleanupErrors.length === 1 ? "" : "s"} found.`;
  }
  const killed = result.killedProcesses.filter((item) => item.ok).length;
  const removed = result.removedContainers.filter((item) => item.ok).length;
  return `Clean stop: ${killed} process target${killed === 1 ? "" : "s"} and ${removed} container${removed === 1 ? "" : "s"} handled.`;
}

function JobProgress({ progress }: { progress: AgentJobProgress }) {
  const width = progress.percent ?? 100;
  return (
    <div className="process-progress">
      <div className="process-progress-meta">
        <span>{progress.label}</span>
        <small>{progress.latestLine ?? progress.detail}</small>
      </div>
      <div className={progress.percent === undefined ? "process-progress-bar indeterminate" : "process-progress-bar"}>
        <span style={{ width: `${Math.max(4, Math.min(100, width))}%` }} />
      </div>
    </div>
  );
}

function ProcessProgressBadge({ progress }: { progress: ProcessProgressState }) {
  const width = progress.percent ?? 100;
  return (
    <div className="process-progress">
      <div className="process-progress-meta">
        <span>{progress.label}</span>
        <small>{progress.detail}</small>
      </div>
      <div className={progress.percent === undefined ? "process-progress-bar indeterminate" : "process-progress-bar"}>
        <span style={{ width: `${Math.max(4, Math.min(100, width))}%` }} />
      </div>
    </div>
  );
}

function ReportView({ project }: { project: SkillLensProject }) {
  const markdown = generateMarkdownReport(project);
  return (
    <div className="report-view">
      <div className="toolbar">
        <button className="secondary-button" onClick={() => downloadFile(`${project.name}.report.md`, markdown, "text/markdown")}>
          <Download size={16} />
          Markdown
        </button>
        <button className="secondary-button" onClick={() => downloadFile(`${project.name}.report.html`, exportHtmlReport(project), "text/html")}>
          <Download size={16} />
          HTML
        </button>
        <button className="secondary-button" onClick={() => downloadFile(`${project.name}.analysis.json`, exportAnalysisJson(project), "application/json")}>
          <Download size={16} />
          JSON
        </button>
      </div>
      <textarea readOnly value={markdown} rows={28} aria-label="Markdown report" />
    </div>
  );
}

function RewriteView({ project, audit }: { project: SkillLensProject; audit: AgentAnalysisAudit | null }) {
  const locale = useLocale();
  const t = ui(locale);
  const proposal = useMemo(() => buildRewriteProposal(project, audit, locale), [project, audit, locale]);
  return (
    <div className="rewrite-view">
      <div className="rewrite-head">
        <div>
          <h3>{t.rewrite.title}</h3>
          <p>{t.rewrite.subtitle}</p>
          {audit?.optimizedSkillPath ? <code>{audit.optimizedSkillPath}</code> : null}
        </div>
        <div className="rewrite-actions">
          <button
            className="secondary-button"
            onClick={() => {
              void navigator.clipboard?.writeText(proposal.markdown);
            }}
            disabled={!proposal.hasContent}
          >
            <FileText size={16} />
            {t.rewrite.copy}
          </button>
          <button
            className="secondary-button"
            onClick={() => downloadFile(`${project.name}.optimized-skill.md`, proposal.markdown, "text/markdown")}
            disabled={!proposal.hasContent}
          >
            <Download size={16} />
            {t.rewrite.download}
          </button>
        </div>
      </div>

      {proposal.hasContent ? (
        <div className="rewrite-grid">
          <div className="rewrite-list">
            <h4>{t.rewrite.violated}</h4>
            {proposal.violated.length ? (
              proposal.violated.map((item) => <RewriteFindingCard key={item.finding.id} item={item} project={project} />)
            ) : (
              <p className="muted">{locale === "zh" ? "没有违反项。" : "No violated findings."}</p>
            )}
            <h4>{t.rewrite.missed}</h4>
            {proposal.missed.length ? (
              proposal.missed.map((item) => <RewriteFindingCard key={item.finding.id} item={item} project={project} />)
            ) : (
              <p className="muted">{locale === "zh" ? "没有忽略项。" : "No ignored findings."}</p>
            )}
          </div>
          <div className="rewrite-markdown">
            <div className="stream-head">
              <strong>{t.rewrite.proposedPatch}</strong>
              <span>anti-bloat delta</span>
            </div>
            <pre>{proposal.markdown}</pre>
          </div>
        </div>
      ) : (
        <div className="rewrite-empty">
          <h3>{t.rewrite.emptyTitle}</h3>
          <p>{t.rewrite.emptyBody}</p>
        </div>
      )}
    </div>
  );
}

interface RewriteFindingItem {
  finding: CoverageFinding;
  unit?: SkillUnit;
  text: string;
  evidenceLabel: string;
}

function RewriteFindingCard({ item, project }: { item: RewriteFindingItem; project: SkillLensProject }) {
  const locale = useLocale();
  const t = ui(locale);
  const events = eventList(project.events, item.finding.evidenceEventIds);
  return (
    <div className={`rewrite-finding-card ${item.finding.status}`}>
      <div>
        <StatusDot status={item.finding.status} />
        <strong>{statusLabel(item.finding.status, locale)}</strong>
        <span>{item.evidenceLabel}</span>
      </div>
      <p>{item.text}</p>
      <small>{item.finding.rationale}</small>
      {events.length ? (
        <div className="rewrite-evidence-row">
          {events.slice(0, 3).map((event) => (
            <code key={event.id}>{event.id}</code>
          ))}
        </div>
      ) : (
        <em>{t.rewrite.noEvidence}</em>
      )}
    </div>
  );
}

function buildRewriteProposal(
  project: SkillLensProject,
  audit: AgentAnalysisAudit | null,
  locale: Locale
): { hasContent: boolean; markdown: string; violated: RewriteFindingItem[]; missed: RewriteFindingItem[] } {
  if (audit?.optimizedSkill?.trim()) {
    const items = rewriteItems(project.findings, project.units, locale);
    return {
      hasContent: true,
      markdown: audit.optimizedSkill.trim(),
      violated: items.filter((item) => item.finding.status === "violated"),
      missed: items.filter((item) => item.finding.status === "missed")
    };
  }
  const risky = project.findings
    .filter((finding) => finding.status === "violated" || finding.status === "missed")
    .sort(compareFindingsForDisplay)
    .slice(0, 12);
  const items = rewriteItems(risky, project.units, locale);
  if (!items.length) {
    return { hasContent: false, markdown: "", violated: [], missed: [] };
  }
  const violated = items.filter((item) => item.finding.status === "violated");
  const missed = items.filter((item) => item.finding.status === "missed");
  return {
    hasContent: true,
    markdown: formatRewriteProposalMarkdown(project, violated, missed, locale),
    violated,
    missed
  };
}

function rewriteItems(findings: CoverageFinding[], units: SkillUnit[], locale: Locale): RewriteFindingItem[] {
  return findings.map((finding) => {
    const unit = units.find((candidate) => candidate.id === finding.unitId);
    const span = finding.analyzedConstraint?.span;
    const text = finding.analyzedConstraint?.text ?? unit?.text ?? finding.rationale;
    const evidenceLabel = span
      ? `lines ${span.lineStart}-${span.lineEnd}`
      : unit
        ? `lines ${unit.lineStart}-${unit.lineEnd}`
        : locale === "zh"
          ? "未知行号"
          : "unknown lines";
    return { finding, unit, text, evidenceLabel };
  });
}

function formatRewriteProposalMarkdown(
  project: SkillLensProject,
  violated: RewriteFindingItem[],
  missed: RewriteFindingItem[],
  locale: Locale
): string {
  const title = locale === "zh" ? "优化 Skill 草案" : "Optimized Skill Proposal";
  const scope = currentSkillTitle(project);
  const lines: string[] = [
    `# ${title}`,
    "",
    locale === "zh"
      ? `对象：${scope}`
      : `Target: ${scope}`,
    "",
    locale === "zh"
      ? "原则：这是最小 delta proposal，不是整份 skill 重写。不要追加防御性废话；优先替换、合并或移动已有规则。"
      : "Principle: this is a minimal delta proposal, not a full skill rewrite. Do not append defensive boilerplate; prefer replacing, merging, or moving existing rules.",
    "",
    locale === "zh" ? "## 证据摘要" : "## Evidence Summary",
    ""
  ];
  const appendFinding = (item: RewriteFindingItem) => {
    lines.push(
      `- ${statusLabel(item.finding.status, locale)} (${item.evidenceLabel}): ${item.text}`,
      `  - Evidence: ${item.finding.evidenceEventIds.length ? item.finding.evidenceEventIds.join(", ") : "none"}`,
      `  - Rationale: ${item.finding.rationale}`
    );
  };
  [...violated, ...missed].forEach(appendFinding);
  lines.push(
    "",
    locale === "zh" ? "## 最小补丁建议" : "## Minimal Patch Suggestions",
    "",
    locale === "zh"
      ? "把高频违反/忽略项改成可观测约束。每条新增文本都必须能在未来 trace 中被命令、文件、顺序、输出字段或证据事件证明。"
      : "Turn repeated violated/ignored points into observable constraints. Every added line must be provable in future traces through commands, files, ordering, output fields, or evidence events.",
    ""
  );
  [...violated, ...missed].slice(0, 6).forEach((item, index) => {
    const action =
      item.finding.status === "violated"
        ? locale === "zh"
          ? "收紧禁止/输出契约"
          : "Tighten prohibition/output contract"
        : locale === "zh"
          ? "前置为必须检查"
          : "Move earlier as a required check";
    lines.push(
      `### ${index + 1}. ${action}`,
      "",
      "```text",
      proposalSentenceForFinding(item, locale),
      "```",
      ""
    );
  });
  lines.push(
    locale === "zh" ? "## Anti-Bloat 检查" : "## Anti-Bloat Check",
    "",
    locale === "zh"
      ? "- 不加入 `no old logic`、`never repeat previous mistake`、`be careful` 这类不可观测防御句。"
      : "- Do not add unobservable defensive lines such as `no old logic`, `never repeat previous mistake`, or `be careful`.",
    locale === "zh"
      ? "- 如果新增文本不能映射到未来 trace evidence，就不要新增。"
      : "- If a new line cannot map to future trace evidence, do not add it.",
    locale === "zh"
      ? "- 如果两条规则检查同一件事，合并成一条更短的规则。"
      : "- If two rules check the same behavior, merge them into one shorter rule."
  );
  return `${lines.join("\n")}\n`;
}

function proposalSentenceForFinding(item: RewriteFindingItem, locale: Locale): string {
  const evidence = item.finding.evidenceEventIds.length ? item.finding.evidenceEventIds.join(", ") : locale === "zh" ? "当前 trace 末尾/检查范围" : "the inspected range";
  const text = item.text.replace(/\s+/g, " ").trim();
  if (locale === "zh") {
    return item.finding.status === "violated"
      ? `当执行该分支时，必须避免与「${text}」冲突；最终输出需列出用于排除该冲突的证据事件（本次反例：${evidence}）。`
      : `当该分支适用时，必须先检查「${text}」，并在最终输出中引用对应证据事件；若未发现证据，明确标为 unknown 而不是跳过（本次缺失范围：${evidence}）。`;
  }
  return item.finding.status === "violated"
    ? `When this branch is active, avoid behavior that conflicts with "${text}"; the final output must cite the evidence events used to rule out the conflict (counterexample here: ${evidence}).`
    : `When this branch applies, check "${text}" before finalizing and cite evidence events in the final output; if evidence is absent, mark it unknown instead of skipping it (missing range here: ${evidence}).`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CompareMetric({
  label,
  left,
  right,
  raw = false,
  invert = false
}: {
  label: string;
  left: number;
  right: number;
  raw?: boolean;
  invert?: boolean;
}) {
  const delta = left - right;
  const positive = invert ? delta < 0 : delta >= 0;
  return (
    <div className="compare-metric">
      <span>{label}</span>
      <strong>{raw ? `${left} vs ${right}` : `${percent(left)} vs ${percent(right)}`}</strong>
      <small className={positive ? "delta-good" : "delta-risk"}>
        {raw ? `${delta >= 0 ? "+" : ""}${delta}` : `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)} pp`}
      </small>
    </div>
  );
}

function DeltaRow({ project, finding }: { project: SkillLensProject; finding: CoverageFinding }) {
  const unit = project.units.find((candidate) => candidate.id === finding.unitId);
  return (
    <div className="delta-row">
      <StatusDot status={finding.status} />
      <span>{unit ? truncate(unit.text, 132) : finding.unitId}</span>
    </div>
  );
}

function EventChip({ event, score, active = false, onClick }: { event: TraceEvent; score?: number; active?: boolean; onClick: () => void }) {
  return (
    <button className={active ? "event-chip active" : "event-chip"} onClick={onClick}>
      <span>{event.id}</span>
      <strong>{event.type.replace("_", " ")}</strong>
      {typeof score === "number" ? <em>{Math.round(score * 100)}%</em> : null}
      <p>{truncate(event.content || event.output, 130)}</p>
    </button>
  );
}

function FileLoader({ label, accept, onLoad }: { label: string; accept: string; onLoad: (text: string) => void }) {
  return (
    <label className="file-loader">
      <FileText size={15} />
      {label}
      <input
        type="file"
        accept={accept}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file) {
            onLoad(await file.text());
          }
        }}
      />
    </label>
  );
}

function StatusDot({ status }: { status: CoverageStatus }) {
  return <span className={`status-dot ${status}`} aria-label={status} />;
}

function LegendDot({ status, label }: { status: CoverageStatus; label: string }) {
  return (
    <span className="legend-item">
      <StatusDot status={status} />
      {label}
    </span>
  );
}

function StatusIcon({ status }: { status: CoverageStatus }) {
  const Icon = statusMeta[status].icon;
  return <Icon size={20} />;
}

function bestFindingForUnit(findings: CoverageFinding[], unitId: string): CoverageFinding | undefined {
  return findings
    .filter((finding) => finding.unitId === unitId)
    .sort(compareFindingsForDisplay)[0];
}

function riskFindings(findings: CoverageFinding[]): CoverageFinding[] {
  return findings
    .filter((finding) => finding.status === "violated" || finding.status === "missed" || finding.status === "unknown")
    .sort(compareFindingsForDisplay);
}

function bestLineFinding(findings: CoverageFinding[]): CoverageFinding | undefined {
  return [...findings].sort(compareFindingsForDisplay)[0];
}

function compareFindingsForDisplay(a: CoverageFinding, b: CoverageFinding): number {
  return findingDisplayPriority(b.status) - findingDisplayPriority(a.status) || b.confidence - a.confidence;
}

function findingDisplayPriority(status: CoverageStatus): number {
  const priority: Record<CoverageStatus, number> = {
    violated: 5,
    missed: 4,
    covered: 3,
    unknown: 2,
    not_applicable: 1
  };
  return priority[status];
}

function stepsFromAudit(audit: AgentAnalysisAudit, finalStatus: "done" | "error", finalDetail?: string, locale: Locale = "zh"): AnalysisStep[] {
  const steps = (audit.steps ?? []).map((step) => ({
    label: step.label,
    status: "done" as const,
    detail: `${step.detail ? `${step.detail} · ` : ""}${step.durationMs}ms`
  }));
  if (finalStatus === "error") {
    return [...steps, { label: ui(locale).analysis.failed, status: "error", detail: finalDetail }];
  }
  return steps.length
    ? steps
    : [
        {
          label: ui(locale).analysis.done,
          status: "done",
          detail: locale === "zh" ? "后端返回了分析结果。" : "The backend returned analysis results."
        }
      ];
}

function markLastStepError(steps: AnalysisStep[], detail: string, locale: Locale = "zh"): AnalysisStep[] {
  if (!steps.length) {
    return [{ label: ui(locale).analysis.failed, status: "error", detail }];
  }
  const next = steps.map((step) => (step.status === "running" ? { ...step, status: "error" as const, detail } : step));
  return next.some((step) => step.status === "error") ? next : [...next, { label: ui(locale).analysis.failed, status: "error", detail }];
}

function markStepDone(steps: AnalysisStep[], label: string, detail?: string): AnalysisStep[] {
  let matchedIndex = -1;
  const next = steps.map((step, index) => {
    if (step.label === label) {
      matchedIndex = index;
      return { ...step, status: "done" as const, detail: detail ?? step.detail };
    }
    return step;
  });
  if (matchedIndex >= 0) {
    const following = next.findIndex((step, index) => index > matchedIndex && step.status === "pending");
    if (following >= 0) {
      next[following] = { ...next[following], status: "running" };
    }
  }
  return next;
}

function mergeLiveStep(steps: AnalysisStep[], step: { label: string; detail?: string; durationMs?: number }): AnalysisStep[] {
  const detail = `${step.detail ? `${step.detail} · ` : ""}${typeof step.durationMs === "number" ? `${step.durationMs}ms` : ""}`.trim();
  const existingIndex = steps.findIndex((candidate) => candidate.label === step.label);
  const next = steps.map((candidate, index) => {
    if (index < existingIndex || (existingIndex < 0 && candidate.status === "running")) {
      return { ...candidate, status: "done" as const };
    }
    if (index === existingIndex) {
      return { ...candidate, status: "done" as const, detail: detail || candidate.detail };
    }
    return candidate;
  });
  if (existingIndex >= 0) {
    const following = next.findIndex((candidate, index) => index > existingIndex && candidate.status === "pending");
    if (following >= 0) {
      next[following] = { ...next[following], status: "running" };
    }
    return next;
  }
  return [...next, { label: step.label, status: "done", detail }];
}

function parseEventData<T>(event: Event): T | null {
  const message = event as MessageEvent<string>;
  try {
    return JSON.parse(message.data) as T;
  } catch {
    return null;
  }
}

function upsertAgentProcess(processes: AgentProcessEvent[], next: AgentProcessEvent): AgentProcessEvent[] {
  const index = processes.findIndex((processEvent) => processEvent.id === next.id);
  if (index < 0) {
    return [...processes, next];
  }
  return processes.map((processEvent, currentIndex) => (currentIndex === index ? { ...processEvent, ...next } : processEvent));
}

function summarizeProcessProgress(
  steps: AnalysisStep[],
  agentEvents: AgentLiveEvent[],
  processes: AgentProcessEvent[]
): { percent: number; label: string } {
  const doneSteps = steps.filter((step) => step.status === "done").length;
  const totalSteps = Math.max(steps.length, 1);
  const active = processes.filter((processEvent) => ["started", "running"].includes(processEvent.status));
  const latestTraceSize = Math.max(0, ...processes.map((processEvent) => processEvent.traceSize ?? 0));
  const latestEvent = agentEvents
    .slice()
    .reverse()
    .map((event) => describeAgentEvent(event, "zh").body)
    .find(Boolean);
  return {
    percent: Math.min(99, Math.round((doneSteps / totalSteps) * 100)),
    label:
      latestEvent ||
      (active.length
        ? `active processes: ${active.map((processEvent) => `pid ${processEvent.pid ?? "?"}`).join(", ")}; trace ${formatBytes(latestTraceSize)}`
        : "waiting for agent activity")
  };
}

function extractAgentConclusions(agentEvents: AgentLiveEvent[], rawAnalysis?: string): string[] {
  const candidates = [
    ...agentEvents.map((event) => describeAgentEvent(event, "zh").body),
    rawAnalysis ?? ""
  ];
  const lines = candidates
    .flatMap((text) => text.split(/\r?\n+/))
    .map((line) => line.replace(/^[-*\d.]+\s*/, "").trim())
    .filter((line) =>
      line.length >= 18 &&
      line.length <= 260 &&
      /(结论|发现|风险|原因|because|therefore|found|missing|violated|covered|evidence|constraint|progress|completed|failed)/i.test(line)
    );
  return uniqueStrings(lines).slice(-12);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function groupProcessesByAgent(processes: AgentProcessEvent[]): Array<{
  id: string;
  label: string;
  root?: AgentProcessEvent;
  processes: AgentProcessEvent[];
  activeCount: number;
}> {
  const groups = new Map<string, AgentProcessEvent[]>();
  for (const processEvent of processes) {
    if (!processEvent.agentRootPid || processEvent.agentRootCommand === "unknown") {
      continue;
    }
    const key = `agent-${processEvent.agentRootPid}`;
    const current = groups.get(key) ?? [];
    current.push(processEvent);
    groups.set(key, current);
  }
  return Array.from(groups.entries()).map(([id, groupProcesses]) => {
    const root =
      groupProcesses.find((processEvent) => processEvent.pid && processEvent.pid === processEvent.agentRootPid) ??
      groupProcesses.find((processEvent) => /codex|claude/i.test(processEvent.command)) ??
      groupProcesses[0];
    const label = root?.agentRootLabel ?? (root ? `${root.command} group ${root.pgid ?? root.pid ?? ""}` : id);
    return {
      id,
      label,
      root,
      processes: [...groupProcesses].sort((left, right) => (left.pid ?? 0) - (right.pid ?? 0)),
      activeCount: groupProcesses.filter((processEvent) => processEvent.status === "running" || processEvent.status === "started").length
    };
  });
}

function processArtifactPaths(processEvent: AgentProcessEvent): Array<{ label: string; path: string; size?: number; mtime?: string }> {
  const artifacts = [
    ...(processEvent.tracePath
      ? [{ label: "trace", path: processEvent.tracePath, size: processEvent.traceSize, mtime: processEvent.traceMtime }]
      : []),
    ...(processEvent.artifactPaths ?? []),
    ...detectProcessArtifactPaths(processEvent)
  ];
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (!artifact.path || seen.has(artifact.path)) {
      return false;
    }
    seen.add(artifact.path);
    return true;
  });
}

function processProgressFor(
  processEvent: AgentProcessEvent,
  artifactTails: Record<string, TraceTailState>,
  locale: Locale
): ProcessProgressState | null {
  const artifacts = processArtifactPaths(processEvent);
  const contents = artifacts
    .map((artifact) => artifactTails[artifact.path])
    .filter((tail): tail is TraceTailState => Boolean(tail?.content))
    .map((tail) => tail.content);
  if (!contents.length) {
    return processEvent.status === "running" || processEvent.status === "started"
      ? {
          label: locale === "zh" ? "实时运行中" : "Live",
          detail: locale === "zh" ? "等待产物更新" : "waiting for artifact updates"
        }
      : null;
  }
  const content = contents.join("\n");
  const stepMatches = Array.from(content.matchAll(/\bstep[-_ ]?(\d+)(?:\s*\/\s*(\d+))?\b/gi));
  const latestStep = stepMatches[stepMatches.length - 1];
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const latestLine = lines[lines.length - 1]?.trim();
  const updatedAtValues = artifacts.map((artifact) => artifactTails[artifact.path]?.updatedAt).filter(Boolean);
  const updatedAt = updatedAtValues[updatedAtValues.length - 1];
  if (latestStep) {
    const current = Number(latestStep[1]);
    const total = latestStep[2] ? Number(latestStep[2]) : undefined;
    return {
      label: locale === "zh" ? `进度 step ${current}${total ? `/${total}` : ""}` : `step ${current}${total ? `/${total}` : ""}`,
      detail: latestLine ? truncate(latestLine, 96) : (locale === "zh" ? "产物实时更新" : "artifact updating"),
      percent: total ? (current / total) * 100 : undefined,
      updatedAt
    };
  }
  return {
    label: locale === "zh" ? `${lines.length} 条更新` : `${lines.length} updates`,
    detail: latestLine ? truncate(latestLine, 96) : (locale === "zh" ? "产物实时更新" : "artifact updating"),
    updatedAt
  };
}

function readMonitorPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

function writeMonitorPreference(key: string, value: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(key, value);
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to the selection-based copy path below.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {
    // The UI still exposes the selected path, even if the host browser blocks clipboard writes.
  } finally {
    document.body.removeChild(textarea);
  }
}

function jobFilterLabel(filter: JobFilter): string {
  if (filter === "docker") {
    return "Docker";
  }
  if (filter === "issues") {
    return "Issues";
  }
  return filter[0].toUpperCase() + filter.slice(1);
}

function jobFilterCount(filter: JobFilter, metrics: { active: number; issues: number; stale: number; recent: number; dockerJobs: number }) {
  if (filter === "active") {
    return metrics.active;
  }
  if (filter === "issues") {
    return metrics.issues;
  }
  if (filter === "stale") {
    return metrics.stale;
  }
  if (filter === "docker") {
    return metrics.dockerJobs;
  }
  return metrics.recent;
}

function jobNeedsAttention(job: AgentJob): boolean {
  return job.status === "stale" || job.status === "failed" || Boolean(job.lastStopResult?.cleanupErrors.length);
}

function jobSearchText(job: AgentJob): string {
  return [
    job.title,
    job.status,
    job.agentRoot?.label,
    job.historyPath,
    ...job.containers.map((container) => container.name),
    ...job.artifacts.flatMap((artifact) => [artifact.label, artifact.path]),
    ...job.processes.flatMap((processEvent) => [processEvent.command, processEvent.cwd, processEvent.args.join(" ")])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function compareJobs(left: AgentJob, right: AgentJob, sort: JobSort): number {
  if (sort === "attention") {
    const attentionDelta = jobAttentionScore(right) - jobAttentionScore(left);
    if (attentionDelta !== 0) {
      return attentionDelta;
    }
    return right.staleSeconds - left.staleSeconds || Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
  }
  if (sort === "title") {
    return left.title.localeCompare(right.title);
  }
  if (sort === "runtime") {
    return jobRuntimeMs(right) - jobRuntimeMs(left);
  }
  return Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
}

function jobAttentionScore(job: AgentJob): number {
  let score = 0;
  if (job.status === "failed" || job.lastStopResult?.cleanupErrors.length) {
    score += 3000;
  }
  if (job.status === "stale") {
    score += 2000 + Math.min(job.staleSeconds, 999);
  }
  if (job.containers.length && job.status !== "stopped") {
    score += 100;
  }
  return score;
}

function jobRuntimeMs(job: AgentJob): number {
  const start = Date.parse(job.startedAt);
  const end = Date.parse(job.lastUpdatedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function formatStaleAge(seconds: number): string {
  if (seconds < 30) {
    return "fresh";
  }
  if (seconds < 90) {
    return `${seconds}s stale`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m stale`;
}

function progressWithTail(job: AgentJob, artifactTails: Record<string, TraceTailState>): AgentJobProgress {
  const contents = job.artifacts
    .map((artifact) => artifactTails[artifact.path])
    .filter((tail): tail is TraceTailState => Boolean(tail?.content))
    .map((tail) => tail.content);
  if (!contents.length) {
    return {
      ...job.progress,
      detail: cleanJobOutputLine(job.progress.detail) || job.progress.detail,
      latestLine: job.progress.latestLine ? cleanJobOutputLine(job.progress.latestLine) : undefined
    };
  }
  const content = contents.join("\n");
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const latestLine = cleanJobOutputLine(lines[lines.length - 1] ?? job.progress.latestLine ?? "");
  const fallbackDetail = cleanJobOutputLine(job.progress.detail) || job.progress.detail;
  const stepMatches = Array.from(content.matchAll(/\bstep[-_ ]?(\d+)(?:\s*\/\s*(\d+))?\b/gi));
  const latestStep = stepMatches[stepMatches.length - 1];
  if (latestStep) {
    const current = Number(latestStep[1]);
    const total = latestStep[2] ? Number(latestStep[2]) : undefined;
    return {
      label: `step ${current}${total ? `/${total}` : ""}`,
      detail: latestLine || fallbackDetail,
      percent: total ? Math.min(100, Math.max(0, (current / total) * 100)) : undefined,
      updatedAt: job.progress.updatedAt,
      latestLine
    };
  }
  return {
    label: `${lines.length} updates`,
    detail: latestLine || fallbackDetail,
    updatedAt: job.progress.updatedAt,
    latestLine
  };
}

function cleanJobOutputLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return truncate(trimmed.replace(/\s+/g, " "), 160);
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return summarizeTraceJson(parsed) ?? "Trace event";
  } catch {
    return truncate(trimmed.replace(/\s+/g, " "), 160);
  }
}

function summarizeTraceJson(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(summarizeTraceJson).find(Boolean) ?? null;
  }
  const record = value as Record<string, unknown>;
  const type = stringField(record, "type") ?? stringField(record, "event") ?? stringField(record, "kind");
  const name = stringField(record, "name") ?? stringField(record, "tool_name") ?? stringField(record, "command");
  const text =
    stringField(record, "message") ??
    stringField(record, "msg") ??
    stringField(record, "text") ??
    stringField(record, "summary") ??
    stringField(record, "content") ??
    stringField(record, "delta") ??
    stringField(record, "output") ??
    stringField(record, "arguments") ??
    nestedTraceText(record);
  if (text) {
    const prefix = type ? `${humanizeTraceType(type)}: ` : "";
    return truncate(`${prefix}${summarizeTraceText(text)}`, 160);
  }
  if (type && name) {
    return truncate(`${humanizeTraceType(type)}: ${name}`, 160);
  }
  return type ? humanizeTraceType(type) : null;
}

function summarizeTraceText(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (!compact.startsWith("{") && !compact.startsWith("[")) {
    return compact;
  }
  try {
    const parsed = JSON.parse(compact) as unknown;
    return summarizeTraceJson(parsed) ?? "structured output";
  } catch {
    return "structured output";
  }
}

function nestedTraceText(record: Record<string, unknown>): string | null {
  for (const key of ["payload", "item", "data", "result"]) {
    const value = record[key];
    if (!value || typeof value !== "object") {
      continue;
    }
    const nested = summarizeTraceJson(value);
    if (nested) {
      return nested;
    }
  }
  const content = record.content;
  if (Array.isArray(content)) {
    return content.map(summarizeTraceJson).find(Boolean) ?? null;
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function humanizeTraceType(value: string): string {
  return value
    .replace(/[_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatJobRuntime(startedAt: string, lastUpdatedAt: string): string {
  const started = Date.parse(startedAt);
  const ended = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) {
    return "runtime unknown";
  }
  const seconds = Math.max(0, Math.floor((ended - started) / 1000));
  if (seconds < 90) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function detectProcessArtifactPaths(processEvent: AgentProcessEvent): Array<{ label: string; path: string; size?: number; mtime?: string }> {
  const artifacts: Array<{ label: string; path: string }> = [];
  const args = processEvent.args ?? [];
  const add = (label: string, value: string | undefined) => {
    if (!value || value.startsWith("-")) {
      return;
    }
    const cleaned = value.replace(/^["']|["']$/g, "").replace(/[;,)]$/g, "");
    if (/\.(?:log|jsonl|json|txt|out|err|md)$/i.test(cleaned)) {
      artifacts.push({ label, path: cleaned });
    }
  };
  args.forEach((arg, index) => {
    if (/^(--out|--output|--output-last-message|--log|--log-file|--report|--report-out|-o)$/i.test(arg)) {
      add(arg.replace(/^-+/, ""), args[index + 1]);
    }
    const inline = arg.match(/^(--out|--output|--output-last-message|--log|--log-file|--report|--report-out)=([^ ]+)$/i);
    if (inline) {
      add(inline[1].replace(/^-+/, ""), inline[2]);
    }
    if (arg === ">" || arg === ">>") {
      add("redirect", args[index + 1]);
    }
    add("file", arg);
  });
  return artifacts;
}

function hasDisplayableAgentContent(event: AgentLiveEvent): boolean {
  if (event.kind === "text") {
    const value = event.payload as { text?: string } | null;
    return Boolean((value?.text ?? stringifyUnknown(event.payload)).trim());
  }
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : null;
  if (!payload) {
    return false;
  }
  if (payload.type === "item.completed" && payload.item && typeof payload.item === "object") {
    const item = payload.item as Record<string, unknown>;
    if (item.type === "agent_message") {
      return typeof item.text === "string" && item.text.trim().length > 0;
    }
    return Boolean(extractAgentText(item).trim() || extractToolName(item));
  }
  if (/error|failed|failure/i.test(String(payload.type ?? ""))) {
    return Boolean(extractAgentText(payload).trim() || stringifyUnknown(payload).trim());
  }
  return Boolean(extractAgentText(payload).trim());
}

function describeAgentEvent(event: AgentLiveEvent, locale: Locale): { title: string; body: string; tone: "info" | "thinking" | "tool" | "error" | "result" } {
  const t = ui(locale);
  if (event.kind === "text") {
    const value = event.payload as { stream?: string; text?: string } | null;
    const text = value?.text ?? stringifyUnknown(event.payload);
    if (/reconnecting|bad gateway|unexpected status 50[234]|cf-ray/i.test(text)) {
      return {
        title: t.analysis.retrying,
        body: truncate(text, 900),
        tone: "thinking"
      };
    }
    return {
      title: value?.stream === "stderr" ? t.analysis.log : t.analysis.output,
      body: truncate(text, 900),
      tone: value?.stream === "stderr" ? "error" : "info"
    };
  }

  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  const type = String(payload.type ?? payload.event ?? payload.name ?? "agent.event");
  const text = extractAgentText(payload);
  const toolName = extractToolName(payload);
  const completedItem = describeCompletedAgentItem(payload, locale);

  if (/cache/i.test(type)) {
    return { title: t.analysis.cacheHit, body: text || t.analysis.cacheHitBody, tone: "result" };
  }
  if (/thread\.started|session/i.test(type)) {
    return { title: t.analysis.createThread, body: text, tone: "info" };
  }
  if (/turn\.started/i.test(type)) {
    return { title: t.analysis.startTurn, body: text || t.analysis.startTurnBody, tone: "thinking" };
  }
  if (completedItem) {
    return completedItem;
  }
  if (/turn\.completed|completed|done/i.test(type)) {
    return { title: t.analysis.stepDone, body: text, tone: "result" };
  }
  if (/error|failed|failure/i.test(type)) {
    if (/reconnecting|bad gateway|unexpected status 50[234]|cf-ray/i.test(text)) {
      return { title: t.analysis.retrying, body: text || truncate(stringifyUnknown(payload), 900), tone: "thinking" };
    }
    return { title: t.analysis.error, body: text || truncate(stringifyUnknown(payload), 900), tone: "error" };
  }
  if (toolName || /tool|function|command|exec/i.test(type)) {
    return { title: toolName ? `${t.analysis.toolCall}: ${toolName}` : t.analysis.toolCall, body: text, tone: "tool" };
  }
  if (/message|assistant|response|delta|output/i.test(type)) {
    return { title: t.analysis.agentOutput, body: text, tone: "info" };
  }
  return { title: friendlyAgentEventType(type), body: text, tone: text ? "info" : "thinking" };
}

function formatAgentEventJson(event: AgentLiveEvent): string {
  if (event.kind === "text") {
    return stringifyJson({
      kind: event.kind,
      at: event.at,
      payload: event.payload
    });
  }
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : event.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const object = payload as Record<string, unknown>;
    if (object.type === "item.completed" && object.item && typeof object.item === "object") {
      const item = object.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        const parsed = parseJsonLike(item.text);
        if (parsed) {
          return stringifyJson(parsed);
        }
      }
    }
  }
  return stringifyJson(payload);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return stringifyUnknown(value);
  }
}

function describeCompletedAgentItem(
  payload: Record<string, unknown>,
  locale: Locale
): { title: string; body: string; tone: "info" | "thinking" | "tool" | "error" | "result" } | null {
  const t = ui(locale);
  if (payload.type !== "item.completed" || !payload.item || typeof payload.item !== "object") {
    return null;
  }
  const item = payload.item as Record<string, unknown>;
  const itemType = String(item.type ?? "");
  if (itemType === "agent_message") {
    const messageText = typeof item.text === "string" ? item.text : extractAgentText(item);
    const summary = summarizeJudgeMessage(messageText, locale);
    return {
      title: summary ? t.analysis.structured : t.analysis.content,
      body: summary || truncate(messageText, 900),
      tone: "result"
    };
  }
  if (itemType === "web_search") {
    const query = typeof item.query === "string" ? item.query.trim() : "";
    return {
      title: t.analysis.search,
      body: query ? `query: ${query}` : locale === "zh" ? "Agent 发起了检索事件，但没有查询内容。" : "Agent started a search event without query content.",
      tone: "tool"
    };
  }
  const tool = extractToolName(item);
  if (tool || /tool|function|command|exec|call/i.test(itemType)) {
    const status = typeof item.status === "string" ? item.status : "";
    return {
      title: tool ? `${t.analysis.toolDone}: ${tool}` : t.analysis.toolDone,
      body: truncate([status, extractAgentText(item)].filter(Boolean).join("\n\n"), 900),
      tone: "tool"
    };
  }
  return null;
}

function summarizeJudgeMessage(text: string, locale: Locale): string {
  const t = ui(locale);
  const parsed = parseJsonLike(text);
  if (!parsed || typeof parsed !== "object") {
    return "";
  }
  const object = parsed as Record<string, unknown>;
  const judgments = Array.isArray(object.judgments) ? object.judgments : [];
  if (!judgments.length) {
    return "";
  }
  const counts = new Map<CoverageStatus, number>();
  const lines = judgments.slice(0, 6).map((entry, index) => {
    const judgment = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const status = normalizeStatusLabel(judgment.status, locale);
    const constraint = extractConstraintText(judgment) || t.analysis.unnamedConstraint;
    const confidence = typeof judgment.confidence === "number" ? ` · ${Math.round(judgment.confidence * 100)}%` : "";
    const evidenceCount = Array.isArray(judgment.evidenceEventIds) ? judgment.evidenceEventIds.length : 0;
    if (isCoverageStatus(judgment.status)) {
      counts.set(judgment.status, (counts.get(judgment.status) ?? 0) + 1);
    }
    return `${index + 1}. ${status}: ${constraint}${confidence} · evidence ${evidenceCount}`;
  });
  const countText = validCoverageStatuses
    .map((status) => {
      const count = counts.get(status) ?? 0;
      return count ? `${statusLabel(status, locale)} ${count}` : "";
    })
    .filter(Boolean)
    .join("，");
  return [`${judgments.length} ${t.analysis.judgments}${countText ? `: ${countText}` : ""}`, ...lines].join("\n");
}

function parseJsonLike(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

const validCoverageStatuses: CoverageStatus[] = ["covered", "missed", "violated", "not_applicable", "unknown"];

function isCoverageStatus(value: unknown): value is CoverageStatus {
  return typeof value === "string" && validCoverageStatuses.includes(value as CoverageStatus);
}

function normalizeStatusLabel(value: unknown, locale: Locale): string {
  return isCoverageStatus(value) ? statusLabel(value, locale) : ui(locale).status.unknown;
}

function extractConstraintText(judgment: Record<string, unknown>): string {
  const constraint = judgment.analyzedConstraint;
  if (constraint && typeof constraint === "object") {
    const text = (constraint as Record<string, unknown>).text;
    if (typeof text === "string") {
      return truncate(text, 120);
    }
  }
  return typeof judgment.rationale === "string" ? truncate(judgment.rationale, 120) : "";
}

function extractAgentText(value: unknown): string {
  const seen = new Set<unknown>();
  const chunks: string[] = [];
  const visit = (node: unknown, key = "") => {
    if (node == null || chunks.join("\n").length > 1800 || seen.has(node)) {
      return;
    }
    if (typeof node === "string") {
      if (isContentKey(key) && node.trim()) {
        chunks.push(node.trim());
      }
      return;
    }
    if (typeof node !== "object") {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, key));
      return;
    }
    const object = node as Record<string, unknown>;
    for (const candidate of ["message", "text", "content", "delta", "summary", "output", "rationale", "error", "prompt", "query", "command", "cmd", "input", "arguments"]) {
      if (candidate in object) {
        visit(object[candidate], candidate);
      }
    }
    if (!chunks.length) {
      Object.entries(object).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(value);
  return uniqueStrings(chunks).join("\n\n");
}

function extractToolName(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const object = value as Record<string, unknown>;
  const direct = object.name ?? object.tool_name ?? object.toolName ?? object.function_name;
  if (typeof direct === "string") {
    return direct;
  }
  for (const nestedKey of ["item", "payload", "call", "function"]) {
    const nested = object[nestedKey];
    const found = extractToolName(nested);
    if (found) {
      return found;
    }
  }
  return "";
}

function isContentKey(key: string): boolean {
  return /message|text|content|delta|summary|output|rationale|error|prompt|query|command|cmd|input|arguments/i.test(key);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function friendlyAgentEventType(type: string): string {
  return type
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function hasAgentJudged(project: SkillLensProject): boolean {
  return project.findings.some(
    (finding) =>
      finding.analysisRecipe?.startsWith("skilllens.agent-judge-response") ||
      (finding.analysisMethod === "hybrid" && !finding.analysisRecipe?.startsWith("skilllens.agent-constraints:"))
  );
}

function hasPendingFindings(project: SkillLensProject): boolean {
  return project.findings.some(
    (finding) => finding.analysisRecipe === "pending-agent-judge" || finding.analysisRecipe?.startsWith("skilllens.agent-constraints:")
  );
}

function buildEventUnitIndex(findings: CoverageFinding[]): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  findings.forEach((finding) => {
    [...finding.evidenceEventIds, ...finding.candidateEventIds].forEach((eventId) => {
      const units = index.get(eventId) ?? new Set<string>();
      units.add(finding.unitId);
      index.set(eventId, units);
    });
  });
  return new Map(Array.from(index.entries()).map(([eventId, units]) => [eventId, Array.from(units)]));
}

function groupCapturesByProject(captures: CaptureRegistryEntry[]): Array<{ key: string; label: string; count: number; cwd?: string }> {
  const groups = new Map<string, { key: string; label: string; count: number; cwd?: string }>();
  captures.forEach((capture) => {
    const key = captureProjectKeyFor(capture);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    groups.set(key, {
      key,
      label: projectLabel(capture.cwd),
      count: 1,
      cwd: capture.cwd
    });
  });
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function captureProjectKeyFor(capture: CaptureRegistryEntry): string {
  return capture.cwd || "(unknown)";
}

function projectLabel(cwd?: string): string {
  if (!cwd) {
    return "Unknown project";
  }
  const normalized = cwd.replace(/\/+$/g, "");
  return normalized.split("/").pop() || normalized;
}

function analysisDisplayTitle(project: SkillLensProject): string {
  return truncate(project.name, 92);
}

function currentSkillTitle(project: SkillLensProject): string {
  const artifacts = project.result.skillArtifacts as Array<{ title?: string; path?: string; loaded?: boolean }> | undefined;
  const artifact = artifacts?.find((candidate) => candidate.loaded) ?? artifacts?.[0];
  if (artifact?.title) {
    return artifact.title;
  }
  if (artifact?.path) {
    return artifact.path.split("/").pop()?.replace(/\.md$/i, "") || "Skill";
  }
  return project.units[0]?.headingPath[0] ?? "Skill";
}

function worktreeSummary(cwd: string): string {
  const normalized = cwd.replace(/\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-3).join(" / ") || normalized;
}

function shortSessionTitle(title: string): string {
  if (title.length <= 28) {
    return title;
  }
  return `${title.slice(0, 10)}...${title.slice(-8)}`;
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function numberParam(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function skillSourceDisplayLines(markdown: string): Array<{ text: string; lineNumber: number }> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const startIndex = skillContentStartIndex(lines);
  return lines.slice(startIndex).map((text, index) => ({ text, lineNumber: startIndex + index + 1 }));
}

function skillContentStartIndex(lines: string[]): number {
  if (lines[0]?.trim() !== "---") {
    return 0;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end > 0 ? end + 1 : 0;
}

function unitForLine(units: SkillUnit[], lineNumber: number): SkillUnit | undefined {
  return units
    .filter((unit) => lineNumber >= unit.lineStart && lineNumber <= unit.lineEnd)
    .sort((a, b) => a.lineEnd - a.lineStart - (b.lineEnd - b.lineStart))[0];
}

function constraintsForLine(constraints: SkillConstraint[], lineNumber: number): SkillConstraint[] {
  return constraints.filter((constraint) => lineNumber >= constraint.span.lineStart && lineNumber <= constraint.span.lineEnd);
}

function findingsForLine(
  findings: CoverageFinding[],
  unit: SkillUnit,
  lineNumber: number,
  constraints: SkillConstraint[]
): CoverageFinding[] {
  const constraintIds = new Set(constraints.map((constraint) => constraint.id));
  return findings
    .filter((finding) => {
      if (finding.unitId !== unit.id) {
        return false;
      }
      if (finding.analyzedConstraint?.span) {
        return lineNumber >= finding.analyzedConstraint.span.lineStart && lineNumber <= finding.analyzedConstraint.span.lineEnd;
      }
      if (finding.constraintId) {
        return constraintIds.has(finding.constraintId);
      }
      return lineNumber >= unit.lineStart && lineNumber <= unit.lineEnd;
    })
    .sort(
      (a, b) =>
        (a.analyzedConstraint?.span.charStart ?? 0) - (b.analyzedConstraint?.span.charStart ?? 0) ||
        compareFindingsForDisplay(a, b)
    );
}

function displayConstraintFromFinding(finding: CoverageFinding, line: string, lineNumber: number): DisplayConstraint {
  const analyzed = finding.analyzedConstraint;
  if (!analyzed) {
    return {
      id: finding.id,
      kind: "instruction",
      text: finding.rationale,
      span: { lineStart: lineNumber, lineEnd: lineNumber, charStart: 0, charEnd: line.length, text: line }
    };
  }
  const isFirstLine = lineNumber === analyzed.span.lineStart;
  const isLastLine = lineNumber === analyzed.span.lineEnd;
  const charStart = isFirstLine ? analyzed.span.charStart : 0;
  const charEnd = isLastLine ? analyzed.span.charEnd : line.length;
  const sourceLineText = analyzed.span.text.split(/\r?\n/)[lineNumber - analyzed.span.lineStart] ?? "";
  const refinedSpan = refineConstraintSpanForLine(line, [sourceLineText, analyzed.span.text, analyzed.text], charStart, charEnd);
  return {
    id: finding.id,
    kind: analyzed.kind,
    text: analyzed.text,
    span: {
      lineStart: lineNumber,
      lineEnd: lineNumber,
      charStart: refinedSpan.charStart,
      charEnd: refinedSpan.charEnd,
      text: analyzed.span.text
    }
  };
}

function normalizeDisplaySpan<T extends { constraint: DisplayConstraint; start: number; end: number }>(span: T, line: string): T {
  const start = Math.max(0, Math.min(line.length, span.start));
  let end = Math.max(0, Math.min(line.length, span.end));
  if (end <= start) {
    end = line.length;
  }
  if (end <= start && line.length) {
    const trimmed = trimDecorativeMarkdownFromSpan(line, 0, line.length);
    return { ...span, start: trimmed.charStart, end: trimmed.charEnd };
  }
  const trimmed = trimDecorativeMarkdownFromSpan(line, start, end);
  return { ...span, start: trimmed.charStart, end: trimmed.charEnd };
}

function refineConstraintSpanForLine(
  line: string,
  constraintTexts: string[],
  fallbackStart: number,
  fallbackEnd: number
): { charStart: number; charEnd: number } {
  for (const constraintText of constraintTexts) {
    const located = locateNormalizedTextInLine(line, constraintText);
    if (located) {
      return trimDecorativeMarkdownFromSpan(line, located.charStart, located.charEnd);
    }
  }
  return trimDecorativeMarkdownFromSpan(
    line,
    Math.max(0, Math.min(line.length, fallbackStart)),
    Math.max(0, Math.min(line.length, fallbackEnd))
  );
}

function trimDecorativeMarkdownFromSpan(line: string, charStart: number, charEnd: number): { charStart: number; charEnd: number } {
  let start = Math.max(0, Math.min(line.length, charStart));
  let end = Math.max(start, Math.min(line.length, charEnd));
  const prefix = line.slice(start, end);
  const prefixMatch = prefix.match(/^\s*(?:[-+*]\s+|\d+[.)]\s+)?(?:[*_]{1,3})?/);
  if (prefixMatch?.[0]) {
    start = Math.min(end, start + prefixMatch[0].length);
  }
  while (start < end && /\s/.test(line[start])) {
    start += 1;
  }
  while (end > start && /[\s*_]+/.test(line[end - 1])) {
    end -= 1;
  }
  return { charStart: start, charEnd: end };
}

function locateNormalizedTextInLine(line: string, text: string): { charStart: number; charEnd: number } | null {
  const normalizedLine = normalizeLineForConstraintMatching(line);
  const normalizedText = normalizeLineForConstraintMatching(text);
  if (!normalizedLine.value || !normalizedText.value) {
    return null;
  }
  const candidates = [
    normalizedText.value,
    trimTerminalPunctuation(normalizedText.value),
    normalizedText.value.split(" ").slice(0, 10).join(" "),
    normalizedText.value.split(" ").slice(-10).join(" "),
    ...constraintTextWindows(normalizedText.value)
  ].filter((candidate, index, values) => candidate.length >= 6 && values.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const start = normalizedLine.value.indexOf(candidate);
    if (start >= 0) {
      const end = start + candidate.length - 1;
      return {
        charStart: normalizedLine.map[start] ?? 0,
        charEnd: (normalizedLine.map[end] ?? line.length - 1) + 1
      };
    }
  }
  return null;
}

function constraintTextWindows(value: string): string[] {
  const words = value.split(" ").filter(Boolean);
  const windows: string[] = [];
  for (const size of [8, 7, 6, 5, 4]) {
    if (words.length < size) {
      continue;
    }
    for (let start = 0; start <= words.length - size; start += 1) {
      windows.push(words.slice(start, start + size).join(" "));
    }
  }
  return windows;
}

function normalizeLineForConstraintMatching(value: string): { value: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let previousWasSpace = false;
  Array.from(value).forEach((char, index) => {
    if (char === "*" || char === "_" || char === "~") {
      return;
    }
    const normalized = char.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'").toLowerCase();
    if (/\s/.test(normalized)) {
      if (!previousWasSpace) {
        chars.push(" ");
        map.push(index);
        previousWasSpace = true;
      }
      return;
    }
    chars.push(normalized);
    map.push(index);
    previousWasSpace = false;
  });
  return { value: chars.join("").trim(), map: trimMap(chars, map) };
}

function trimMap(chars: string[], map: number[]): number[] {
  let start = 0;
  let end = chars.length;
  while (start < end && chars[start] === " ") {
    start += 1;
  }
  while (end > start && chars[end - 1] === " ") {
    end -= 1;
  }
  return map.slice(start, end);
}

function trimTerminalPunctuation(value: string): string {
  return value.replace(/[.:;,，。；：]+$/g, "").trim();
}

function displayConstraintFromSkillConstraint(constraint: SkillConstraint): DisplayConstraint {
  return {
    id: constraint.id,
    kind: constraint.kind,
    text: constraint.text,
    span: constraint.span
  };
}

function isAgentFinding(finding: CoverageFinding): boolean {
  return Boolean(finding.analyzedConstraint);
}

function filterTimeline(project: SkillLensProject, filter: TimelineFilter): TraceEvent[] {
  if (filter === "all") {
    return project.events;
  }
  if (filter === "tools") {
    return project.events.filter((event) => ["tool_call", "tool_output", "command", "file_edit"].includes(event.type));
  }
  if (filter === "final") {
    return project.events.slice(Math.max(0, project.events.length - 4));
  }
  if (filter === "skill") {
    const linked = new Set(project.findings.flatMap((finding) => [...finding.evidenceEventIds, ...finding.candidateEventIds]));
    return project.events.filter((event) => linked.has(event.id));
  }
  const violationEvents = new Set(
    project.findings
      .filter((finding) => finding.status === "violated" || finding.status === "missed")
      .flatMap((finding) => finding.evidenceEventIds)
  );
  return project.events.filter((event) => violationEvents.has(event.id));
}

function relatedUnitsForEvent(project: SkillLensProject, eventId: string): string[] {
  return project.findings
    .filter((finding) => finding.evidenceEventIds.includes(eventId) || finding.candidateEventIds.includes(eventId))
    .map((finding) => finding.unitId);
}

function formatResult(value: unknown): string {
  if (value === true) {
    return "success";
  }
  if (value === false) {
    return "failure";
  }
  return "result unknown";
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[^a-z0-9_.-]+/gi, "-");
  anchor.click();
  URL.revokeObjectURL(url);
}

export default App;
