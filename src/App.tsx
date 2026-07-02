import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Code2,
  Download,
  FileJson,
  FileText,
  GitBranch,
  GitCompare,
  HelpCircle,
  Link2,
  ListFilter,
  RefreshCw,
  Search,
  Upload,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { demoProjects, sampleInputs } from "./data/samples";
import { analyzeCoverage, findCandidates, summarizeCoverage } from "./lib/coverage";
import { createProject, createProjectFromCaptureBundle } from "./lib/project";
import { exportAnalysisJson, exportHtmlReport, generateMarkdownReport, percent } from "./lib/report";
import { truncate } from "./lib/text";
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

type View = "coverage" | "graph" | "timeline" | "compare" | "analysis" | "report";
type TimelineFilter = "all" | "skill" | "violations" | "tools" | "final";

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
  progressPath?: string;
  constraintsPath?: string;
  rawOutputPath?: string;
  responsePath?: string;
  findingsPath?: string;
  skillGraphPath?: string;
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

const viewLabels: Array<{ id: View; label: string; icon: typeof FileText }> = [
  { id: "coverage", label: "Skill 高亮", icon: FileText },
  { id: "graph", label: "Skill 图", icon: GitBranch },
  { id: "timeline", label: "轨迹", icon: ListFilter },
  { id: "compare", label: "对比", icon: GitCompare },
  { id: "analysis", label: "分析过程", icon: Code2 },
  { id: "report", label: "报告", icon: FileJson }
];

const timelineFilterLabels: Record<TimelineFilter, string> = {
  all: "全部",
  skill: "相关",
  violations: "违反/忽略",
  tools: "工具",
  final: "最后"
};

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
    value === "report"
    ? value
    : "coverage";
}

function App() {
  const [projects, setProjects] = useState<SkillLensProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [view, setView] = useState<View>(() => initialViewFromUrl());
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
  const [isHome, setIsHome] = useState(true);
  const [capturingSkillUseId, setCapturingSkillUseId] = useState("");
  const [openingSkillUse, setOpeningSkillUse] = useState<LocalSkillUse | null>(null);
  const [isAgentAnalyzing, setIsAgentAnalyzing] = useState(false);
  const [agentAnalysisMessage, setAgentAnalysisMessage] = useState("");
  const [agentAnalysisError, setAgentAnalysisError] = useState("");
  const [analysisSteps, setAnalysisSteps] = useState<AnalysisStep[]>([]);
  const [analysisAudit, setAnalysisAudit] = useState<AgentAnalysisAudit | null>(null);
  const [agentEvents, setAgentEvents] = useState<AgentLiveEvent[]>([]);
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
    () => viewLabels.filter((item) => item.id !== "compare" || projects.length > 1),
    [projects.length]
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
      setAgentAnalysisMessage(`已从本地缓存恢复 ${cachedAnalysis.findings.length} 条分析结果。`);
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
    setView("analysis");
    setAnalysisSteps([
      { label: "发送分析请求", status: "running", detail: "把当前 skill-use window 交给本地后端。" },
      { label: "准备 agent 输入", status: "pending", detail: "写入 selected-skill、trace-events 和 analyzer skill 启动指令。" },
      { label: "运行 Codex / Claude", status: "pending", detail: "启动本地 agent，按 analyzer skill 抽取约束并检查 trace。" },
      { label: "保存结果", status: "pending", detail: "保存 agent 产物，并更新 skill 高亮和证据。" }
    ]);
    const captureId = project.id.startsWith("capture-") ? project.id.replace(/^capture-/, "") : "";
    if (!captureId) {
      setAgentAnalysisError("只能对从 Codex / Claude Code session 打开的 skill-use 启动 agent 分析。");
      setAnalysisSteps((current) => markLastStepError(current, "当前页面不是本地 Codex / Claude Code capture。"));
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
      setAnalysisSteps((current) => markStepDone(current, "发送分析请求", "SSE stream connected."));
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
      setAgentAnalysisMessage(`已同步 ${payload.extractedCount ?? payload.findings.length} 条约束到 Skill 高亮。`);
      setAgentEvents((current) => [
        ...current.slice(-199),
        {
          kind: "text",
          at: new Date().toISOString(),
          payload: { stream: "stdout", text: `已识别 ${payload.extractedCount ?? payload.findings.length} 条约束，Skill 高亮已更新。` }
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
            text: `Skill 图已更新：${skillGraph.nodes.length} 个节点，${skillGraph.edges.length} 条边，${skillGraph.paths.length} 条路径。`
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
      setAnalysisSteps(stepsFromAudit(payload, "done"));
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
        setAnalysisSteps(stepsFromAudit(payload.audit, "error", payload.error ?? "Agent analysis failed."));
      } else {
        setAnalysisSteps((current) => markLastStepError(current, payload?.error ?? "Agent analysis failed."));
      }
      setAgentAnalysisError(payload?.error ?? "Agent analysis failed.");
      setIsAgentAnalyzing(false);
      source.close();
    });
    source.onerror = () => {
      setAgentAnalysisError("Agent analysis stream disconnected.");
      setAnalysisSteps((current) => markLastStepError(current, "Agent analysis stream disconnected."));
      setIsAgentAnalyzing(false);
      source.close();
    };
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Code2 size={22} />
          <div>
            <h1>SkillLens</h1>
            <p>Like code coverage, but for agent skills.</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="adapter-pill">Codex</span>
          <span className="adapter-pill">Claude Code</span>
          <span className="adapter-pill">ACP JSONL</span>
          <button className="icon-button" onClick={() => downloadFile(`${project.name}.analysis.json`, exportAnalysisJson(project), "application/json")} title="Export JSON">
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
          />
        ) : openingSkillUse ? (
          <OpeningPanel skillUse={openingSkillUse} />
        ) : (
        <section className="analysis-panel">
          <div className="analysis-topbar">
            <button
              className="secondary-button"
              onClick={() => {
                setIsHome(true);
                window.history.replaceState(null, "", window.location.pathname);
              }}
            >
              <ArrowLeft size={16} />
              返回列表
            </button>
            <div className="analysis-title-block">
              <span>当前窗口</span>
              <h2>{analysisDisplayTitle(focusedProject)}</h2>
              <p>
                {currentSkillTitle(focusedProject)} · {String(project.result.source ?? project.sourceType)} · {formatResult(project.result.success)}
              </p>
            </div>
            <div className="analysis-actions">
              <button className="secondary-button" onClick={() => startAgentAnalysis(false)} disabled={isAgentAnalyzing}>
                <Code2 size={16} />
                {isAgentAnalyzing ? "分析中..." : "启动分析"}
              </button>
              <button className="secondary-button" onClick={() => startAgentAnalysis(true)} disabled={isAgentAnalyzing}>
                <RefreshCw size={16} />
                重新分析
              </button>
              <details className="import-drawer">
                <summary>
                  <Upload size={16} />
                  导入
                </summary>
                <div className="import-drawer-body">
                  <div className="import-card wide">
                    <div className="section-title">
                      <Upload size={16} />
                      Local artifacts
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
                      Analyze Upload
                    </button>
                  </div>
                  <div className="import-card">
                    <div className="section-title">
                      <Link2 size={16} />
                      SkillsBench URL
                    </div>
                    <input value={trialUrl} onChange={(event) => setTrialUrl(event.target.value)} placeholder="Raw trial JSONL URL" />
                    <button className="secondary-button" onClick={importTrialUrl}>
                      导入 URL
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
            <span>{activeSegment ? activeSegment.title : "当前窗口"}</span>
            {hasAgentJudged(focusedProject) ? (
              <>
                <span className="summary-good">遵循 {summary.counts.covered}</span>
                <span className="summary-risk">违反 {summary.counts.violated}</span>
                <span className="summary-ignore">忽略 {summary.counts.missed}</span>
                <span>适用 {summary.applicable}</span>
                {summary.counts.not_applicable ? <span>未走分支 {summary.counts.not_applicable} 已折叠</span> : null}
                <span>置信度 {percent(summary.averageConfidence)}</span>
              </>
            ) : (
              <>
                <span>{summary.total} constraints</span>
                <span className="needs-judge">待启动 agent judge</span>
              </>
            )}
          </div>
          {agentAnalysisError ? <p className="error-text analysis-message">{agentAnalysisError}</p> : null}
          {agentAnalysisMessage ? (
            <div className="analysis-message analysis-message-row">
              <span>{agentAnalysisMessage}</span>
              {agentAnalysisMessage.includes("Skill 高亮") ? (
                <button className="secondary-button compact" onClick={() => setView("coverage")}>
                  查看高亮
                </button>
              ) : null}
            </div>
          ) : null}
          {captures.length || sessionSegments.length ? (
            <details className="context-drawer">
              <summary>切换 capture / 片段</summary>
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
                  <span>Session 片段</span>
                  <button className={activeSegmentId === "all" ? "active" : ""} onClick={() => setActiveSegmentId("all")}>
                    完整 session · {project.events.length} events
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
            />
          ) : null}

          {view === "report" ? <ReportView project={focusedProject} /> : null}
        </section>
        )}
      </main>
    </div>
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
  onOpenDemo
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
}) {
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
          <h2>选择一次 Skill 使用</h2>
          <p>左侧选项目，右侧选 skill 使用窗口。每个窗口只截取该 skill 使用到结束或下一次人类介入的轨迹。</p>
          <small className="index-meta">
            {indexMeta.updatedAt ? `${projects.length} projects · ${totalSkillUses} skill uses · ${formatShortDate(indexMeta.updatedAt)} · ${indexMeta.source ?? "db"}` : "本地索引未加载"}
          </small>
        </div>
        <div className="session-home-actions">
          <button className="secondary-button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} />
            刷新索引
          </button>
          <button className="secondary-button" onClick={onOpenDemo}>
            打开 demo
          </button>
        </div>
      </div>

      <div className="session-search">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、路径、skill、用户请求或 session" />
      </div>

      <div className="project-session-layout">
        <aside className="local-projects">
          <button className={selectedProjectKey === "all" ? "active" : ""} onClick={() => onProjectChange("all")}>
            <strong>全部用了 skill 的项目</strong>
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
          <div className="column-title">Skill 使用窗口</div>
          {error ? <p className="error-text session-error">{error}</p> : null}
          {loading ? (
            <p className="muted empty-sessions">正在索引本机 skill 使用记录...</p>
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
                  <em>{isOpening ? "opening..." : "打开"}</em>
                </div>
              </button>
              );
            })
          ) : (
            <p className="muted empty-sessions">没有找到可证明使用了 skill 的 Codex / Claude Code 片段。</p>
          )}
        </div>
      </div>
    </section>
  );
}

function OpeningPanel({ skillUse }: { skillUse: LocalSkillUse }) {
  return (
    <section className="opening-panel">
      <div className="opening-card">
        <div className="opening-spinner" />
        <div>
          <span>正在打开 skill 使用窗口</span>
          <h2>{skillUse.title || "Skill use window"}</h2>
          <p>
            {skillUse.skillName} · {skillUse.project} · steps {skillUse.startStep}-{skillUse.endStep}
          </p>
          <small>只加载这个 skill-use 片段；coverage 判定会在点击“启动分析”后运行。</small>
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
  const totalCaptures = projectOptions.reduce((sum, option) => sum + option.count, 0);
  return (
    <div className="session-library">
      <div className="session-library-head">
        <div>
          <strong>Session Library</strong>
          <span>选择任意项目的 Codex / Claude Code session</span>
        </div>
        <select value={selectedProjectKey} onChange={(event) => onProjectChange(event.target.value)} aria-label="Captured project">
          <option value="all">全部项目 ({totalCaptures})</option>
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
          <div className="column-title">判断与证据</div>
          {selectedUnit && selectedFinding ? (
            <>
              <div className={`finding-banner ${selectedFinding.status}`}>
                <StatusIcon status={selectedFinding.status} />
                <div>
                  <strong>{statusMeta[selectedFinding.status].label}</strong>
                  <p>{selectedFinding.rationale}</p>
                </div>
              </div>
              <div className="detail-block">
                <h3>Skill 约束</h3>
                <p>{selectedFinding.analyzedConstraint?.text ?? selectedUnit.text}</p>
                <small>
                  {selectedUnit.headingPath.join(" / ") || "Root"} ·{" "}
                  {selectedFinding.analyzedConstraint
                    ? `${selectedFinding.analyzedConstraint.kind} · lines ${selectedFinding.analyzedConstraint.span.lineStart}-${selectedFinding.analyzedConstraint.span.lineEnd}`
                    : `lines ${selectedUnit.lineStart}-${selectedUnit.lineEnd}`}
                </small>
              </div>
              <div className="detail-block">
                <h3>证据片段</h3>
                {evidenceEvents.length ? (
                  evidenceEvents.map((event) => (
                    <EventChip key={event.id} event={event} active={relatedEventIds.has(event.id)} onClick={() => onSelectEvent(event.id)} />
                  ))
                ) : (
                  <p className="muted">没有直接证据。</p>
                )}
              </div>
              {showLocalCandidates ? (
                <div className="detail-block">
                  <h3>本地候选轨迹</h3>
                  {candidateEvents.map((candidate) => (
                    <EventChip key={candidate.event.id} event={candidate.event} score={candidate.score} onClick={() => onSelectEvent(candidate.event.id)} />
                  ))}
                </div>
              ) : null}
              {selectedFinding.suggestedRewrite ? (
                <div className="rewrite-box">
                  <h3>改写建议</h3>
                  <p>{selectedFinding.suggestedRewrite}</p>
                </div>
              ) : null}
              <details className="manual-review">
                <summary>人工修正</summary>
                <select value={selectedFinding.status} onChange={(event) => onStatusChange(event.target.value as CoverageStatus)}>
                  {Object.keys(statusMeta).map((status) => (
                    <option value={status} key={status}>
                      {statusMeta[status as CoverageStatus].label}
                    </option>
                  ))}
                </select>
              </details>
            </>
          ) : (
            <p className="muted">选择一条高亮约束。</p>
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
  if (!findings.length) {
    return null;
  }
  return (
    <div className="finding-queue">
      <span>优先看</span>
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
  const lines = skillSourceDisplayLines(project.skillMarkdown);
  const hasAgentSpans = project.findings.some((finding) => isAgentFinding(finding));
  return (
    <div className="skill-source-panel">
      <div className="column-title split-title">
        <span>SKILL.md 原文</span>
        <span className="legend-row">
          <LegendDot status="covered" label="遵循" />
          <LegendDot status="missed" label="忽略" />
          <LegendDot status="violated" label="违反" />
          <LegendDot status="unknown" label="待看" />
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
              <span className={`line-status-badge ${status}`}>{statusMeta[status].label}</span>
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
  const status = finding?.status ?? "unknown";
  const visibleEvents = events.length ? events : candidateEvents.slice(0, 2);
  return (
    <span className={`evidence-tooltip ${status}`} role="tooltip">
      <span className="tooltip-head">
        <strong>{statusMeta[status].label}</strong>
        <em>{Math.round((finding?.confidence ?? 0) * 100)}%</em>
      </span>
      <span className="tooltip-unit">{constraint ? `${constraint.kind}: ${constraint.text}` : unit.text}</span>
      <span className="tooltip-rationale">{finding?.rationale ?? "No coverage finding was generated."}</span>
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
          <span className="tooltip-empty">No evidence span. Click for details.</span>
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
          <GraphMetric label="遵循" value={graph.nodes.filter((node) => node.status === "covered").length} tone="good" />
          <GraphMetric label="违反" value={graph.nodes.filter((node) => node.status === "violated").length} tone="risk" />
          <GraphMetric label="忽略" value={graph.nodes.filter((node) => node.status === "missed").length} tone="ignore" />
          <GraphMetric label="未走分支" value={graph.skippedBranches.length} tone="muted" />
        </div>
        <div className="graph-source-row">
          <span>{graph.source === "agent" ? "Agent skill graph" : "从 coverage findings 自动推断"}</span>
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
                    <span className="graph-node-kind">{node.isCondition ? "条件" : graphKindLabel(node.kind)}</span>
                    <span className="graph-node-body">
                      <strong>{truncate(node.text, 150)}</strong>
                      <small>
                        {node.edgeLabel ? `${node.edgeLabel} · ` : null}
                        lines {node.lineStart}-{node.lineEnd} · {branchStateLabel(node)} · evidence {node.evidenceEventIds.length} · {percent(node.confidence)}
                      </small>
                    </span>
                    <span className={`graph-node-status ${node.status}`}>{node.status === "not_applicable" ? "未走" : statusMeta[node.status].label}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <aside className="skill-graph-side">
        <div className="column-title">Trace 路径</div>
        {selectedNode ? (
          <>
            <div className={`graph-detail-banner ${selectedNode.status}`}>
              <StatusIcon status={selectedNode.status} />
              <div>
                <strong>
                  {selectedNode.isCondition
                    ? `${statusMeta[selectedNode.status].label} · ${branchStateLabel(selectedNode)}`
                    : statusMeta[selectedNode.status].label}
                </strong>
                <p>{selectedNode.finding.rationale}</p>
              </div>
            </div>

            <div className="detail-block">
              <h3>当前节点</h3>
              <p>{selectedNode.text}</p>
              <small>
                {selectedNode.heading} · {selectedNode.kind} · lines {selectedNode.lineStart}-{selectedNode.lineEnd}
              </small>
            </div>

            <div className="detail-block">
              <h3>证据事件</h3>
              {evidenceEvents.length ? (
                evidenceEvents.slice(0, 5).map((event) => (
                  <EventChip key={event.id} event={event} active onClick={() => onSelectEvent(event.id)} />
                ))
              ) : (
                <p className="muted">这个节点没有直接证据事件。</p>
              )}
            </div>
          </>
        ) : (
          <p className="muted graph-empty">还没有可绘制的 skill graph。</p>
        )}

        <div className="graph-branch-list">
          <h3>走过的条件</h3>
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
            <p className="muted">没有识别到已走条件。</p>
          )}

          <h3>未走分支</h3>
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
            <p className="muted">没有未走分支。</p>
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

function branchStateLabel(node: SkillGraphNode): string {
  if (node.branchState === "not_taken") {
    return "未走分支";
  }
  if (node.branchState === "taken") {
    return "已走条件";
  }
  if (node.branchState === "unknown") {
    return "路径未知";
  }
  return "已检查";
}

function graphKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    action: "动作",
    prohibition: "禁止",
    order: "顺序",
    numeric: "数值",
    command: "命令",
    file_reference: "文件",
    evidence: "证据",
    condition: "条件"
  };
  return labels[kind] ?? "约束";
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
              {timelineFilterLabels[item]}
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
              展开更多事件
            </button>
          ) : null}
        </div>
      </div>
      <aside className="timeline-detail">
        <div className="column-title">事件详情</div>
        {effectiveSelectedEvent ? (
          <>
            <div className="detail-block">
              <h3>{effectiveSelectedEvent.id}</h3>
              <p>{effectiveSelectedEvent.type.replace("_", " ")} · {effectiveSelectedEvent.role}</p>
              {effectiveSelectedEvent.name ? <small>{effectiveSelectedEvent.name}</small> : null}
            </div>
            <pre>{truncate(JSON.stringify(effectiveSelectedEvent.raw, null, 2), 8000)}</pre>
            <div className="detail-block">
              <h3>关联 Skill 约束</h3>
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
                <p className="muted">没有关联约束。</p>
              )}
            </div>
          </>
        ) : (
          <p className="muted">选择一个轨迹事件。</p>
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
  agentEvents
}: {
  analyzing: boolean;
  error: string;
  message: string;
  steps: AnalysisStep[];
  audit: AgentAnalysisAudit | null;
  agentEvents: AgentLiveEvent[];
}) {
  const visibleSteps = steps.length
    ? steps
    : [
        {
          label: "等待启动分析",
          status: "pending" as const,
          detail: "点击右上角“启动分析”后，这里会显示 Codex / Claude judge 的执行过程。"
        }
      ];
  const contentEvents = agentEvents.filter(hasDisplayableAgentContent).slice(-80);
  const paths = audit
    ? [
        ["cache key", audit.cacheKey],
        ["analyzer skill", audit.analyzerSkillPath],
        ["工作目录", audit.workDir],
        ["request.json", audit.requestPath],
        ["prompt.txt", audit.promptPath],
        ["selected-skill.md", audit.selectedSkillPath],
        ["constraint-seed.json", audit.constraintSeedPath],
        ["trace-events.json", audit.traceEventsPath],
        ["trace-facts.json", audit.traceFactsPath],
        ["progress.md", audit.progressPath],
        ["constraints.json", audit.constraintsPath],
        ["agent-output.txt", audit.rawOutputPath],
        ["response.json", audit.responsePath],
        ["findings.json", audit.findingsPath]
      ].filter((item): item is [string, string] => Boolean(item[1]))
    : [];

  return (
    <div className="analysis-process-view">
      <div className="analysis-process-main">
        <div className="process-head">
          <div>
            <h3>{analyzing ? "正在分析" : error ? "分析失败" : message ? "分析完成" : "分析过程"}</h3>
            <p>
              {audit?.runner
                ? `${audit.runner} · ${audit.requestId}${audit.cached ? " · cached" : ""}`
                : "前端选择 skill-use 后，由本地 Codex / Claude Code 完成约束抽取和证据判断。"}
            </p>
          </div>
          <span className={analyzing ? "process-status running" : error ? "process-status error" : message ? "process-status done" : "process-status"}>
            {analyzing ? "running" : error ? "failed" : message ? "done" : "idle"}
          </span>
        </div>

        {error ? <p className="error-text process-message">{error}</p> : null}
        {message ? <p className="muted process-message">{message}</p> : null}

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
              <strong>Agent 最终分析</strong>
              <span>final answer</span>
            </div>
            <pre>{audit.rawAnalysis}</pre>
          </div>
        ) : null}

        <div className="agent-json-stream">
          <div className="stream-head">
            <strong>Agent 实时输出</strong>
            <span>{contentEvents.length} content events</span>
          </div>
          {contentEvents.length ? (
            <div className="stream-list">
              {contentEvents.map((event, index) => {
                const item = describeAgentEvent(event);
                const eventJson = formatAgentEventJson(event);
                return (
                  <div className={`stream-event ${item.tone}`} key={`${event.at}-${index}`}>
                    <div className="stream-event-header">
                      <strong>{item.title}</strong>
                      <span>{formatShortTime(event.at)}</span>
                    </div>
                    {item.body ? <p>{item.body}</p> : null}
                    <details className="stream-event-raw">
                      <summary>原始事件</summary>
                      <pre className="stream-event-json">{eventJson}</pre>
                    </details>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted stream-empty">
              {audit?.cached
                ? "这次命中缓存，没有启动 Codex / Claude，所以没有实时 agent 输出。点击“重新分析”可以强制启动 agent。"
                : "Codex / Claude 输出实际内容后，会在这里显示。"}
            </p>
          )}
        </div>
      </div>

      <aside className="analysis-process-side">
        <div className="column-title">本地调试文件</div>
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
          <p className="muted path-empty">分析启动后会显示 request、prompt、原始输出和解析结果的文件路径。</p>
        )}
      </aside>
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

function stepsFromAudit(audit: AgentAnalysisAudit, finalStatus: "done" | "error", finalDetail?: string): AnalysisStep[] {
  const steps = (audit.steps ?? []).map((step) => ({
    label: step.label,
    status: "done" as const,
    detail: `${step.detail ? `${step.detail} · ` : ""}${step.durationMs}ms`
  }));
  if (finalStatus === "error") {
    return [...steps, { label: "分析失败", status: "error", detail: finalDetail }];
  }
  return steps.length ? steps : [{ label: "分析完成", status: "done", detail: "后端返回了分析结果。" }];
}

function markLastStepError(steps: AnalysisStep[], detail: string): AnalysisStep[] {
  if (!steps.length) {
    return [{ label: "分析失败", status: "error", detail }];
  }
  const next = steps.map((step) => (step.status === "running" ? { ...step, status: "error" as const, detail } : step));
  return next.some((step) => step.status === "error") ? next : [...next, { label: "分析失败", status: "error", detail }];
}

function markStepDone(steps: AnalysisStep[], label: string, detail?: string): AnalysisStep[] {
  return steps.map((step, index) => {
    if (step.label === label) {
      return { ...step, status: "done" as const, detail: detail ?? step.detail };
    }
    if (index === 1 && label === "发送分析请求" && step.status === "pending") {
      return { ...step, status: "running" as const };
    }
    return step;
  });
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

function describeAgentEvent(event: AgentLiveEvent): { title: string; body: string; tone: "info" | "thinking" | "tool" | "error" | "result" } {
  if (event.kind === "text") {
    const value = event.payload as { stream?: string; text?: string } | null;
    const text = value?.text ?? stringifyUnknown(event.payload);
    if (/reconnecting|bad gateway|unexpected status 50[234]|cf-ray/i.test(text)) {
      return {
        title: "上游连接重试中",
        body: truncate(text, 900),
        tone: "thinking"
      };
    }
    return {
      title: value?.stream === "stderr" ? "运行日志" : "输出",
      body: truncate(text, 900),
      tone: value?.stream === "stderr" ? "error" : "info"
    };
  }

  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  const type = String(payload.type ?? payload.event ?? payload.name ?? "agent.event");
  const text = extractAgentText(payload);
  const toolName = extractToolName(payload);
  const completedItem = describeCompletedAgentItem(payload);

  if (/cache/i.test(type)) {
    return { title: "命中分析缓存", body: text || "这次没有重新启动 agent，直接读取已保存的分析结果。", tone: "result" };
  }
  if (/thread\.started|session/i.test(type)) {
    return { title: "创建分析线程", body: text, tone: "info" };
  }
  if (/turn\.started/i.test(type)) {
    return { title: "开始一轮判断", body: text || "Agent 开始读取 judge 请求。", tone: "thinking" };
  }
  if (completedItem) {
    return completedItem;
  }
  if (/turn\.completed|completed|done/i.test(type)) {
    return { title: "完成一步", body: text, tone: "result" };
  }
  if (/error|failed|failure/i.test(type)) {
    if (/reconnecting|bad gateway|unexpected status 50[234]|cf-ray/i.test(text)) {
      return { title: "上游连接重试中", body: text || truncate(stringifyUnknown(payload), 900), tone: "thinking" };
    }
    return { title: "出错", body: text || truncate(stringifyUnknown(payload), 900), tone: "error" };
  }
  if (toolName || /tool|function|command|exec/i.test(type)) {
    return { title: toolName ? `调用工具：${toolName}` : "调用工具", body: text, tone: "tool" };
  }
  if (/message|assistant|response|delta|output/i.test(type)) {
    return { title: "Agent 输出", body: text, tone: "info" };
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
  payload: Record<string, unknown>
): { title: string; body: string; tone: "info" | "thinking" | "tool" | "error" | "result" } | null {
  if (payload.type !== "item.completed" || !payload.item || typeof payload.item !== "object") {
    return null;
  }
  const item = payload.item as Record<string, unknown>;
  const itemType = String(item.type ?? "");
  if (itemType === "agent_message") {
    const messageText = typeof item.text === "string" ? item.text : extractAgentText(item);
    return {
      title: summarizeJudgeMessage(messageText) ? "Agent 返回结构化判断" : "Agent 输出分析内容",
      body: summarizeJudgeMessage(messageText) || truncate(messageText, 900),
      tone: "result"
    };
  }
  if (itemType === "web_search") {
    const query = typeof item.query === "string" ? item.query.trim() : "";
    return {
      title: "检索事件",
      body: query ? `query: ${query}` : "Agent 发起了检索事件，但没有查询内容。",
      tone: "tool"
    };
  }
  const tool = extractToolName(item);
  if (tool || /tool|function|command|exec|call/i.test(itemType)) {
    const status = typeof item.status === "string" ? item.status : "";
    return {
      title: tool ? `工具完成：${tool}` : "工具完成",
      body: truncate([status, extractAgentText(item)].filter(Boolean).join("\n\n"), 900),
      tone: "tool"
    };
  }
  return null;
}

function summarizeJudgeMessage(text: string): string {
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
    const status = normalizeStatusLabel(judgment.status);
    const constraint = extractConstraintText(judgment) || "未命名约束";
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
      return count ? `${statusMeta[status].label} ${count}` : "";
    })
    .filter(Boolean)
    .join("，");
  return [`${judgments.length} 条判断${countText ? `：${countText}` : ""}`, ...lines].join("\n");
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

function normalizeStatusLabel(value: unknown): string {
  return isCoverageStatus(value) ? statusMeta[value].label : "待判断";
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
