import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readlinkSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyAgentJudgeResponse,
  constraintsToPendingFindings,
  createAgentJudgeRequest,
  parseAgentConstraintsResponse,
  parseAgentSkillGraphResponse,
  parseAgentJudgeResponse
} from "./src/lib/agentJudge";
import { createProjectFromCaptureBundle } from "./src/lib/project";
import { buildSkillOptimizerPrompt } from "./src/lib/skillOptimizerPrompt";
import { detectTraceFormat, parseTraceText } from "./src/lib/traceParser";
import type {
  CaptureBundle,
  CapturedSessionSegment,
  CapturedSkillArtifact,
  CaptureRegistry,
  CaptureRegistryEntry,
  CoverageFinding,
  SkillGraphArtifact,
  TraceEvent
} from "./src/lib/types";

export default defineConfig({
  plugins: [react(), skillLensCaptureApi()],
  server: {
    port: 5173
  }
});

interface LocalSessionIndexEntry {
  id: string;
  path: string;
  cwd: string;
  projectKey: string;
  project: string;
  repositoryUrl?: string;
  worktreeLabel: string;
  agentProduct: "codex" | "claude_code";
  cliVersion?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  usedSkills: string[];
  skillPaths: string[];
  skillEvidenceCount: number;
}

interface LocalSessionProjectEntry {
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

interface LocalSessionIndexDb {
  schemaVersion: "skilllens.local-session-index.v2";
  updatedAt: string;
  source?: "cache" | "scan";
  sessions: LocalSessionIndexEntry[];
  skillUses: LocalSkillUseEntry[];
  projects: LocalSessionProjectEntry[];
}

interface LocalSkillUseEntry {
  id: string;
  sessionId: string;
  path: string;
  cwd: string;
  projectKey: string;
  project: string;
  repositoryUrl?: string;
  worktreeLabel: string;
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

interface JsonlFileInfo {
  path: string;
  mtimeMs: number;
  size: number;
  agentProduct: "codex" | "claude_code";
}

interface LocalTraceCacheRecord {
  path: string;
  mtimeMs: number;
  size: number;
  agentProduct: "codex" | "claude_code";
  processedAt: string;
  session?: LocalSessionIndexEntry;
  skillUses: LocalSkillUseEntry[];
}

interface LocalTraceCacheDb {
  schemaVersion: "skilllens.local-trace-cache.v2";
  updatedAt: string;
  records: Record<string, LocalTraceCacheRecord>;
}

interface AgentAnalysisAudit {
  runner?: string;
  requestId?: string;
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
  nativeVerifierPath?: string;
  rawTracePath?: string;
  skillGraphPath?: string;
  optimizerSkillPath?: string;
  optimizationPromptPath?: string;
  optimizedSkillPath?: string;
  optimizationReportPath?: string;
  optimizationDiffPath?: string;
  optimizationPacketPath?: string;
  optimizerRawOutputPath?: string;
  rawOutputPath?: string;
  responsePath?: string;
  findingsPath?: string;
  steps: Array<{ label: string; detail?: string; durationMs: number }>;
}

interface AgentAnalysisCacheEntry {
  key: string;
  createdAt: string;
  updatedAt: string;
  captureId: string;
  segmentStartStep?: number;
  segmentEndStep?: number;
  maxFindings: number;
  skillSha256: string;
  analyzerVersion: string;
  result: Record<string, unknown>;
}

interface AgentAnalysisCacheDb {
  schemaVersion: "skilllens.analysis-cache.v1";
  updatedAt: string;
  entries: Record<string, AgentAnalysisCacheEntry>;
}

interface AgentAnalysisHooks {
  onStep?: (step: { label: string; detail?: string; durationMs: number }) => void;
  onConstraints?: (event: { findings: CoverageFinding[]; extractedCount: number; constraintsPath?: string }) => void;
  onSkillGraph?: (event: { skillGraph: SkillGraphArtifact; skillGraphPath?: string }) => void;
  onAgentJson?: (event: unknown) => void;
  onAgentText?: (event: { stream: "stdout" | "stderr"; text: string }) => void;
  onProcess?: (event: AgentProcessEvent) => void;
}

interface LightweightTraceEvent {
  step: number;
  role: "user" | "skill" | "other";
  text: string;
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
  signal?: NodeJS.Signals | null;
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

interface ActiveAgentProcess {
  event: AgentProcessEvent;
  child: ReturnType<typeof spawn>;
}

interface ProcessSnapshot {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  elapsed: string;
  argsText: string;
  argv: string[];
  command: string;
  cwd?: string;
}

const LOCAL_TRACE_SCAN_LIMIT = Number.parseInt(process.env.SKILLLENS_LOCAL_TRACE_LIMIT ?? "1600", 10);
const ANALYZER_VERSION = "skillscope-analyzer-native-target-reference-hints";
const activeAgentProcesses = new Map<string, ActiveAgentProcess>();

function skillLensCaptureApi() {
  return {
    name: "skilllens-capture-api",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (url === "/api/captures") {
          await sendJson(res, await readRegistry());
          return;
        }
        if (url.startsWith("/api/agent-processes/trace") && req.method === "GET") {
          const requestUrl = new URL(url, "http://localhost");
          try {
            const tracePath = requestUrl.searchParams.get("path") ?? "";
            const offset = Number.parseInt(requestUrl.searchParams.get("offset") ?? "0", 10) || 0;
            const maxBytes = Number.parseInt(requestUrl.searchParams.get("maxBytes") ?? "24000", 10) || 24000;
            await sendJson(res, await readTraceTail(tracePath, offset, maxBytes));
          } catch (error) {
            sendStatus(res, 500, { error: error instanceof Error ? error.message : "failed to read trace" });
          }
          return;
        }
        if (url === "/api/agent-processes" && req.method === "GET") {
          try {
            await sendJson(res, await listAgentProcesses());
          } catch (error) {
            sendStatus(res, 500, { error: error instanceof Error ? error.message : "failed to list processes" });
          }
          return;
        }
        if (url.startsWith("/api/local-sessions") && req.method === "GET") {
          const requestUrl = new URL(url, "http://localhost");
          await sendJson(res, await readLocalSessions({ refresh: requestUrl.searchParams.get("refresh") === "1" }));
          return;
        }
        if (url === "/api/local-sessions/capture" && req.method === "POST") {
          try {
            const body = JSON.parse(await readBody(req)) as {
              path?: string;
              cwd?: string;
              skillPaths?: string[];
              agentProduct?: "codex" | "claude_code";
              startStep?: number;
              endStep?: number;
            };
            if (!body.path || !body.cwd) {
              sendStatus(res, 400, { error: "path and cwd are required" });
              return;
            }
            const capture = await captureLocalSession(
              body.path,
              body.cwd,
              body.skillPaths ?? [],
              body.agentProduct ?? "codex",
              body.startStep,
              body.endStep
            );
            await sendJson(res, capture);
          } catch (error) {
            sendStatus(res, 500, { error: error instanceof Error ? error.message : "failed to capture session" });
          }
          return;
        }
        if (url === "/api/agent-analysis" && req.method === "POST") {
          try {
            const body = JSON.parse(await readBody(req)) as {
              captureId?: string;
              segmentStartStep?: number;
              segmentEndStep?: number;
              maxFindings?: number;
              force?: boolean;
            };
            if (!body.captureId) {
              sendStatus(res, 400, { error: "captureId is required" });
              return;
            }
            await sendJson(
              res,
              await runAgentAnalysis({
                captureId: body.captureId,
                segmentStartStep: body.segmentStartStep,
                segmentEndStep: body.segmentEndStep,
                maxFindings: body.maxFindings,
                force: body.force
              })
            );
          } catch (error) {
            sendStatus(res, 500, {
              error: error instanceof Error ? error.message : "failed to run agent analysis",
              audit: error && typeof error === "object" && "audit" in error ? (error as { audit?: unknown }).audit : undefined
            });
          }
          return;
        }
        if (url.startsWith("/api/agent-analysis/cache") && req.method === "GET") {
          const requestUrl = new URL(url, "http://localhost");
          const captureId = requestUrl.searchParams.get("captureId") ?? "";
          if (!captureId) {
            sendStatus(res, 400, { error: "captureId is required" });
            return;
          }
          try {
            const cached = await readCachedAnalysisForCapture({
              captureId,
              segmentStartStep: numberFromQuery(requestUrl.searchParams.get("segmentStartStep")),
              segmentEndStep: numberFromQuery(requestUrl.searchParams.get("segmentEndStep"))
            });
            if (!cached) {
              sendStatus(res, 404, { cached: false });
              return;
            }
            await sendJson(res, cached);
          } catch (error) {
            sendStatus(res, 500, { error: error instanceof Error ? error.message : "failed to read analysis cache" });
          }
          return;
        }
        if (url.startsWith("/api/agent-analysis/stream") && req.method === "GET") {
          const requestUrl = new URL(url, "http://localhost");
          const captureId = requestUrl.searchParams.get("captureId") ?? "";
          if (!captureId) {
            sendStatus(res, 400, { error: "captureId is required" });
            return;
          }
          setupSse(res);
          const send = (event: string, data: unknown) => sendSse(res, event, data);
          send("open", { ok: true, startedAt: new Date().toISOString() });
          try {
            const result = await runAgentAnalysis(
              {
                captureId,
                segmentStartStep: numberFromQuery(requestUrl.searchParams.get("segmentStartStep")),
                segmentEndStep: numberFromQuery(requestUrl.searchParams.get("segmentEndStep")),
                maxFindings: numberFromQuery(requestUrl.searchParams.get("maxFindings")),
                force: requestUrl.searchParams.get("force") === "1"
              },
              {
                onStep: (step) => send("step", step),
                onConstraints: (event) => send("constraints", event),
                onSkillGraph: (event) => send("skill-graph", event),
                onAgentJson: (event) => send("agent-json", event),
                onAgentText: (event) => send("agent-text", event),
                onProcess: (event) => send("agent-process", event)
              }
            );
            send("result", result);
          } catch (error) {
            send("analysis-error", {
              error: error instanceof Error ? error.message : "failed to run agent analysis",
              audit: error && typeof error === "object" && "audit" in error ? (error as { audit?: unknown }).audit : undefined
            });
          } finally {
            send("close", { ok: true, endedAt: new Date().toISOString() });
            res.end();
          }
          return;
        }
        if (url === "/api/agent-processes/kill" && req.method === "POST") {
          try {
            const body = JSON.parse(await readBody(req)) as { id?: string; pid?: number; pgid?: number; signal?: NodeJS.Signals };
            const result = await killAgentProcess(body.id, body.pid, body.pgid, body.signal ?? "SIGTERM");
            await sendJson(res, result);
          } catch (error) {
            sendStatus(res, 500, { error: error instanceof Error ? error.message : "failed to kill process" });
          }
          return;
        }
        const match = url.match(/^\/api\/captures\/([^/?#]+)/);
        if (match) {
          const registry = await readRegistry();
          const entry = registry.captures.find((capture: { id: string }) => capture.id === decodeURIComponent(match[1]));
          if (!entry) {
            sendStatus(res, 404, { error: "capture not found" });
            return;
          }
          try {
            const bundle = JSON.parse(await readFile(entry.bundlePath, "utf8"));
            await sendJson(res, bundle);
          } catch (error) {
            sendStatus(res, 500, { error: error instanceof Error ? error.message : "failed to read bundle" });
          }
          return;
        }
        next();
      });
    }
  };
}

async function readLocalSessions(options: { refresh: boolean }): Promise<LocalSessionIndexDb> {
  if (!options.refresh) {
    const cached = await readLocalSessionIndexDb();
    if (cached) {
      return { ...cached, source: "cache" };
    }
  }
  const built = await buildLocalSessionIndex();
  await writeLocalSessionIndexDb(built);
  return { ...built, source: "scan" };
}

async function buildLocalSessionIndex(): Promise<LocalSessionIndexDb> {
  const codexHome = process.env.CODEX_HOME || path.join(homeDir(), ".codex");
  const sessionsRoot = path.join(codexHome, "sessions");
  const claudeHome = process.env.CLAUDE_HOME || path.join(homeDir(), ".claude");
  const claudeProjectsRoot = path.join(claudeHome, "projects");
  const codexFiles = existsSync(sessionsRoot)
    ? (await listJsonlFiles(sessionsRoot)).map((file) => ({ ...file, agentProduct: "codex" as const }))
    : [];
  const claudeFiles = existsSync(claudeProjectsRoot)
    ? (await listJsonlFiles(claudeProjectsRoot))
        .filter((file) => !file.path.split(path.sep).includes("subagents"))
        .map((file) => ({ ...file, agentProduct: "claude_code" as const }))
    : [];

  const files = [...codexFiles, ...claudeFiles]
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Number.isFinite(LOCAL_TRACE_SCAN_LIMIT) ? LOCAL_TRACE_SCAN_LIMIT : 1600);
  const traceCache = await readLocalTraceCacheDb();
  const nextTraceCache: LocalTraceCacheDb = {
    schemaVersion: "skilllens.local-trace-cache.v2",
    updatedAt: new Date().toISOString(),
    records: {}
  };
  const sessions: LocalSessionIndexEntry[] = [];
  const skillUses: LocalSkillUseEntry[] = [];
  for (const file of files) {
    const cached = traceCache.records[file.path];
    const record =
      cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size && cached.agentProduct === file.agentProduct
        ? cached
        : await processLocalTraceFile(file);
    nextTraceCache.records[file.path] = record;
    if (record.session) {
      sessions.push(record.session);
      skillUses.push(...record.skillUses);
    }
  }
  await writeLocalTraceCacheDb(nextTraceCache);

  const projectMap = new Map<
    string,
    {
      key: string;
      cwd: string;
      project: string;
      sessionCount: number;
      skillUseCount: number;
      latestAt: string;
      repositoryUrl?: string;
      worktrees: Set<string>;
      usedSkills: string[];
    }
  >();
  sessions.forEach((session) => {
    const existing = projectMap.get(session.projectKey);
    if (existing) {
      existing.sessionCount += 1;
      if (session.updatedAt > existing.latestAt) {
        existing.latestAt = session.updatedAt;
        existing.cwd = session.cwd;
      }
      existing.worktrees.add(session.cwd);
      session.usedSkills.forEach((skill: string) => {
        if (!existing.usedSkills.includes(skill)) {
          existing.usedSkills.push(skill);
        }
      });
      return;
    }
    projectMap.set(session.projectKey, {
      key: session.projectKey,
      cwd: session.cwd,
      project: session.project,
      sessionCount: 1,
      skillUseCount: 0,
      latestAt: session.updatedAt,
      repositoryUrl: session.repositoryUrl,
      worktrees: new Set([session.cwd]),
      usedSkills: [...session.usedSkills]
    });
  });
  skillUses.forEach((use) => {
    const existing = projectMap.get(use.projectKey);
    if (existing) {
      existing.skillUseCount += 1;
    }
  });

  return {
    schemaVersion: "skilllens.local-session-index.v2",
    updatedAt: new Date().toISOString(),
    sessions,
    skillUses,
    projects: Array.from(projectMap.values())
      .map((project) => ({
        key: project.key,
        cwd: project.cwd,
        project: project.project,
        sessionCount: project.sessionCount,
        skillUseCount: project.skillUseCount,
        latestAt: project.latestAt,
        repositoryUrl: project.repositoryUrl,
        worktreeCount: project.worktrees.size,
        usedSkills: project.usedSkills
      }))
      .sort((left, right) => right.latestAt.localeCompare(left.latestAt))
  };
}

async function processLocalTraceFile(file: JsonlFileInfo): Promise<LocalTraceCacheRecord> {
  const emptyRecord: LocalTraceCacheRecord = {
    path: file.path,
    mtimeMs: file.mtimeMs,
    size: file.size,
    agentProduct: file.agentProduct,
    processedAt: new Date().toISOString(),
    skillUses: []
  };
  const meta = file.agentProduct === "codex" ? await readCodexSessionMeta(file.path) : await readClaudeSessionMeta(file.path);
  if (!meta.sessionId || !meta.cwd) {
    return emptyRecord;
  }

  const sessionId = meta.sessionId;
  const cwd = meta.cwd;
  const skillUsage = await detectCodexSkillUsage(file.path, cwd);
  if (!skillUsage.usedSkills.length) {
    return emptyRecord;
  }

  const projectIdentity = projectIdentityFromMeta(cwd, meta.repositoryUrl);
  const session: LocalSessionIndexEntry = {
    id: sessionId,
    path: file.path,
    cwd,
    projectKey: projectIdentity.key,
    project: projectIdentity.label,
    repositoryUrl: meta.repositoryUrl,
    worktreeLabel: worktreeLabel(cwd, projectIdentity.label),
    agentProduct: file.agentProduct,
    cliVersion: meta.cliVersion,
    model: meta.model ?? meta.modelProvider,
    createdAt: meta.timestamp ?? new Date(file.mtimeMs).toISOString(),
    updatedAt: new Date(file.mtimeMs).toISOString(),
    usedSkills: skillUsage.usedSkills,
    skillPaths: skillUsage.skillPaths,
    skillEvidenceCount: skillUsage.evidenceCount
  };
  return {
    ...emptyRecord,
    session,
    skillUses: skillUsage.uses.map((use, index) => ({
      id: `${sessionId}:${use.skillName}:${use.startStep}:${index}`,
      sessionId,
      path: file.path,
      cwd,
      projectKey: projectIdentity.key,
      project: projectIdentity.label,
      repositoryUrl: meta.repositoryUrl,
      worktreeLabel: session.worktreeLabel,
      agentProduct: file.agentProduct,
      skillName: use.skillName,
      skillPath: use.skillPath,
      title: use.title,
      startStep: use.startStep,
      endStep: use.endStep,
      evidenceStep: use.evidenceStep,
      createdAt: meta.timestamp ?? new Date(file.mtimeMs).toISOString(),
      updatedAt: new Date(file.mtimeMs).toISOString()
    }))
  };
}

async function runAgentAnalysis(options: {
  captureId: string;
  segmentStartStep?: number;
  segmentEndStep?: number;
  maxFindings?: number;
  force?: boolean;
}, hooks: AgentAnalysisHooks = {}) {
  const audit: AgentAnalysisAudit = { steps: [] };
  const record = (label: string, startedAt: number, detail?: string) => {
    const step = { label, detail, durationMs: Date.now() - startedAt };
    audit.steps.push(step);
    hooks.onStep?.(step);
  };

  try {
    let startedAt = Date.now();
    const registry = await readRegistry();
    const entry = registry.captures.find((capture: { id: string }) => capture.id === options.captureId);
    if (!entry?.bundlePath) {
      throw new Error(`Capture not found: ${options.captureId}`);
    }
    const bundle = JSON.parse(await readFile(entry.bundlePath, "utf8")) as CaptureBundle;
    record("读取 capture", startedAt, entry.bundlePath);

    const maxFindings = options.maxFindings ?? 0;
    startedAt = Date.now();
    const project = createProjectFromCaptureBundle(bundle, {
      segmentStartStep: options.segmentStartStep,
      segmentEndStep: options.segmentEndStep,
      lazyFindings: true
    });
    record("解析 skill-use 窗口", startedAt, `${project.units.length} units, ${project.events.length} events`);

    const skillMarkdown = project.skillMarkdown;
    const skillPath = selectedSkillPaths(bundle).join("\n");
    const analyzerVersion = ANALYZER_VERSION;
    const cacheKey = analysisCacheKey({
      captureId: options.captureId,
      segmentStartStep: options.segmentStartStep,
      segmentEndStep: options.segmentEndStep,
      maxFindings,
      skillSha256: sha256(skillMarkdown),
      analyzerVersion
    });
    audit.cacheKey = cacheKey;

    if (!options.force) {
      startedAt = Date.now();
      const cached = await readCachedAnalysis(cacheKey);
      if (cached) {
        record("读取分析缓存", startedAt, cached.createdAt);
        hooks.onAgentJson?.({
          type: "analysis_cache_hit",
          cacheKey,
          createdAt: cached.createdAt,
          requestId: cached.result.requestId
        });
        return {
          ...cached.result,
          cached: true,
          cacheKey,
          steps: [...audit.steps, ...((cached.result.steps as AgentAnalysisAudit["steps"] | undefined) ?? [])]
        };
      }
      record("检查分析缓存", startedAt, "miss");
    } else {
      record("跳过分析缓存", Date.now(), "force=1");
    }

    const requestId = `skillscope-analysis-${new Date().toISOString().replace(/[:.]/g, "-")}-${shortHash(
      `${options.captureId}:${options.segmentStartStep ?? ""}:${options.segmentEndStep ?? ""}`
    )}`;
    audit.requestId = requestId;
    audit.runner = bundle.agent.product === "claude_code" ? "claude" : "codex";

    startedAt = Date.now();
    const request = createAgentJudgeRequest(project, {
      requestId,
      agentProduct: bundle.agent.product,
      maxFindings: maxFindings || undefined
    });
    if (!request.items.length) {
      throw new Error("No analyzable skill constraints were found for this skill-use window.");
    }
    record("构造分析输入索引", startedAt, `${request.items.length} skill units, ${project.events.length} trace events`);

    const workDir = path.join(process.cwd(), ".skilllens", "agent-judge", requestId);
    await mkdir(workDir, { recursive: true });
    const requestPath = path.join(workDir, "request.json");
    const promptPath = path.join(workDir, "prompt.txt");
    const analyzerSkillPath = skillScopeAnalyzerSkillPath();
    const optimizerSkillPath = skillScopeOptimizerSkillPath();
    const skillSnapshotPath = path.join(workDir, "selected-skill.md");
    const skillUnitsPath = path.join(workDir, "skill-units.json");
    const constraintSeedPath = path.join(workDir, "constraint-seed.json");
    const traceEventsPath = path.join(workDir, "trace-events.json");
    const traceFactsPath = path.join(workDir, "trace-facts.json");
    const nativeVerifierPath = path.join(workDir, "native-verifier.json");
    const rawTracePath = path.join(workDir, "selected-trace.jsonl");
    const taskPath = path.join(workDir, "task.md");
    const progressPath = path.join(workDir, "progress.md");
    const constraintsPath = path.join(workDir, "constraints.json");
    const skillGraphPath = path.join(workDir, "skill-graph.json");
    const optimizedSkillPath = path.join(workDir, "optimized-skill.md");
    const optimizationPromptPath = path.join(workDir, "optimization-prompt.txt");
    const optimizationReportPath = path.join(workDir, "optimization-report.md");
    const optimizationDiffPath = path.join(workDir, "optimization-diff.md");
    const optimizationPacketPath = path.join(workDir, "optimization-packet.json");
    const optimizerRawOutputPath = path.join(workDir, "optimizer-output.txt");
    const rawOutputPath = path.join(workDir, "agent-output.txt");
    const responsePath = path.join(workDir, "response.json");
    const findingsPath = path.join(workDir, "findings.json");
    Object.assign(audit, {
      workDir,
      analyzerSkillPath,
      optimizerSkillPath,
      requestPath,
      promptPath,
      selectedSkillPath: skillSnapshotPath,
      constraintSeedPath,
      traceEventsPath,
      traceFactsPath,
      nativeVerifierPath,
      progressPath,
      constraintsPath,
      skillGraphPath,
      optimizedSkillPath,
      optimizationPromptPath,
      optimizationReportPath,
      optimizationDiffPath,
      optimizationPacketPath,
      optimizerRawOutputPath,
      rawOutputPath,
      responsePath,
      findingsPath
    });

    startedAt = Date.now();
    const prompt = buildSkillDrivenAnalyzerPrompt({
      request,
      analyzerSkillPath,
      workDir,
      selectedSkillPath: skillSnapshotPath,
      skillUnitsPath,
      constraintSeedPath,
      traceEventsPath,
      traceFactsPath,
      nativeVerifierPath,
      rawTracePath,
      taskPath,
      progressPath,
      constraintsPath,
      skillGraphPath,
      optimizedSkillPath,
      findingsPath
    });
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    await writeFile(skillSnapshotPath, skillMarkdown);
    await writeFile(skillUnitsPath, `${JSON.stringify(project.units, null, 2)}\n`);
    const constraintSeed = buildConstraintSeed(project);
    await writeFile(constraintSeedPath, `${JSON.stringify({ constraints: constraintSeed }, null, 2)}\n`);
    await writeFile(constraintsPath, `${JSON.stringify({ constraints: constraintSeed }, null, 2)}\n`);
    await writeFile(skillGraphPath, `${JSON.stringify({ schemaVersion: "skilllens.skill-graph.v1", nodes: [], edges: [], paths: [] }, null, 2)}\n`);
    await writeFile(optimizedSkillPath, "");
    await writeFile(optimizationReportPath, "");
    await writeFile(optimizationDiffPath, "");
    await writeFile(optimizationPacketPath, `${JSON.stringify({ schemaVersion: "skilllens.optimization-packet.v1", edits: [] }, null, 2)}\n`);
    await writeFile(traceEventsPath, `${JSON.stringify(project.events, null, 2)}\n`);
    await writeFile(traceFactsPath, `${JSON.stringify({ schemaVersion: "skilllens.trace-facts.v1", facts: [], indexes: {} }, null, 2)}\n`);
    await writeFile(nativeVerifierPath, `${JSON.stringify(buildNativeVerifierArtifact(project.result), null, 2)}\n`);
    await writeFile(rawTracePath, project.traceText);
    await writeFile(taskPath, project.taskMarkdown ?? "");
    await writeFile(progressPath, "");
    await writeFile(promptPath, prompt);
    record("写入 agent 输入文件", startedAt, workDir);

    startedAt = Date.now();
    let agentDone = false;
    const artifactPoller = pollAgentArtifacts(
      {
        project,
        requestId,
        progressPath,
        constraintsPath,
        skillGraphPath
      },
      hooks,
      () => agentDone
    );
    let rawOutput = "";
    try {
      rawOutput = await runAgentJudgeCliWithRetry(
        bundle.agent.product,
        prompt,
        {
          workDir,
          promptPath,
          rawOutputPath
        },
        hooks
      );
    } finally {
      agentDone = true;
      await artifactPoller;
    }
    await writeFile(rawOutputPath, rawOutput);
    record("运行 Codex / Claude 分析 Skill", startedAt, audit.runner);

    startedAt = Date.now();
    const rawAnalysis = extractAgentOutputText(rawOutput) || rawOutput;
    const artifactResponse = await readAgentResponseFromArtifact(findingsPath, request.requestId);
    const response = artifactResponse ?? parseAgentJudgeResponse(rawAnalysis, request.requestId);
    const extractedConstraints = await readExtractedConstraintsArtifact(constraintsPath, project);
    const skillGraph = await readSkillGraphArtifact(skillGraphPath, project);
    const pendingFindings = extractedConstraints.length
      ? constraintsToPendingFindings(project, extractedConstraints, request.requestId)
      : project.findings;
    const judgedFindings = response.judgments.length ? applyAgentJudgeResponse(project, response) : [];
    const findings = judgedFindings.length ? mergePendingAndJudgedFindings(pendingFindings, judgedFindings) : pendingFindings;
    await writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`);
    await writeFile(findingsPath, `${JSON.stringify(findings, null, 2)}\n`);
    record(
      "保存 agent 分析",
      startedAt,
      response.judgments.length
        ? `${response.judgments.length} findings from agent artifacts`
        : `${extractedConstraints.length} constraints highlighted; final answer saved`
    );

    let optimizerRawOutput = "";
    let optimizedSkill = "";
    if (hasOptimizableFindings(findings)) {
      startedAt = Date.now();
      const optimizerPrompt = buildSkillOptimizerPrompt({
        launcher: "browser",
        optimizerSkillPath,
        workDir,
        requestId,
        originalSkillPath: skillSnapshotPath,
        selectedSkillPath: skillSnapshotPath,
        constraintsPath,
        skillGraphPath,
        traceFactsPath,
        findingsPath,
        nativeVerifierPath,
        traceEventsPath,
        taskPath,
        optimizedSkillPath,
        optimizationReportPath,
        optimizationDiffPath,
        optimizationPacketPath,
        failureSummary: summarizeOptimizableFindings(findings)
      });
      await writeFile(optimizationPromptPath, optimizerPrompt);
      hooks.onAgentText?.({
        stream: "stdout",
        text: "启动 SkillScope optimizer：读取 constraints/graph/trace-facts/findings 后生成最小 skill 修订。"
      });
      try {
        optimizerRawOutput = await runAgentJudgeCliWithRetry(
          bundle.agent.product,
          optimizerPrompt,
          {
            workDir,
            promptPath: optimizationPromptPath,
            rawOutputPath: optimizerRawOutputPath
          },
          hooks
        );
        await writeFile(optimizerRawOutputPath, optimizerRawOutput);
        optimizedSkill = existsSync(optimizedSkillPath) ? await readFile(optimizedSkillPath, "utf8") : "";
        record(
          "优化 Skill",
          startedAt,
          optimizedSkill.trim()
            ? `optimizer wrote ${path.basename(optimizedSkillPath)}`
            : "optimizer completed but did not write an optimized skill"
        );
      } catch (error) {
        const summary = summarizeAgentError(error);
        await writeFile(optimizerRawOutputPath, summary);
        hooks.onAgentText?.({ stream: "stderr", text: `Skill optimizer failed after analysis was saved: ${summary}` });
        record("优化 Skill", startedAt, `failed: ${summary}`);
      }
    } else {
      record("优化 Skill", Date.now(), "skipped: no violated or missed findings");
    }

    const result = {
      requestId,
      runner: audit.runner,
      skillPath,
      requestPath,
      promptPath,
      selectedSkillPath: skillSnapshotPath,
      constraintSeedPath,
      traceEventsPath,
      traceFactsPath,
      nativeVerifierPath,
      rawTracePath,
      progressPath,
      constraintsPath,
      skillGraphPath,
      optimizerSkillPath,
      optimizationPromptPath,
      optimizedSkillPath,
      optimizationReportPath,
      optimizationDiffPath,
      optimizationPacketPath,
      optimizerRawOutputPath,
      rawOutputPath,
      responsePath,
      findingsPath,
      workDir,
      analyzerSkillPath,
      steps: audit.steps,
      judgedCount: response.judgments.length,
      structuredJudgments: response.judgments.length,
      rawAnalysis,
      optimizerRawOutput,
      findings,
      skillGraph,
      optimizedSkill,
      cached: false,
      cacheKey
    };
    if (!isAgentBlockedAnalysis(rawAnalysis)) {
      await writeCachedAnalysis({
        key: cacheKey,
        captureId: options.captureId,
        segmentStartStep: options.segmentStartStep,
        segmentEndStep: options.segmentEndStep,
        maxFindings,
        skillSha256: sha256(skillMarkdown),
        analyzerVersion,
        result
      });
    }
    return result;
  } catch (error) {
    const wrapped = new Error(summarizeAgentError(error));
    if (error && typeof error === "object") {
      (wrapped as { audit?: AgentAnalysisAudit }).audit = audit;
    }
    throw wrapped;
  }
}

function buildSkillDrivenAnalyzerPrompt(input: {
  request: ReturnType<typeof createAgentJudgeRequest>;
  analyzerSkillPath: string;
  workDir: string;
  selectedSkillPath: string;
  skillUnitsPath: string;
  constraintSeedPath: string;
  traceEventsPath: string;
  traceFactsPath: string;
  nativeVerifierPath: string;
  rawTracePath: string;
  taskPath: string;
  progressPath: string;
  constraintsPath: string;
  skillGraphPath: string;
  optimizedSkillPath: string;
  findingsPath: string;
}): string {
  return `You were launched by SkillScope after the user clicked "启动分析" in the browser.

Do not analyze the current conversation. Analyze only the selected skill-use window described by these local files.

Use this analyzer skill and follow its workflow:
${input.analyzerSkillPath}

First read the analyzer skill completely. Then read the selected skill and trace artifacts:
- Selected skill markdown: ${input.selectedSkillPath}
- Normalized skill units: ${input.skillUnitsPath}
- Constraint seed extracted from the selected skill: ${input.constraintSeedPath}
- Normalized trace events: ${input.traceEventsPath}
- Trace facts artifact to write: ${input.traceFactsPath}
- Native verifier / result evidence: ${input.nativeVerifierPath}
- Raw selected trace window: ${input.rawTracePath}
- Task/context markdown: ${input.taskPath}
- Request metadata: ${path.join(input.workDir, "request.json")}

Write working artifacts here:
- Progress notes: ${input.progressPath}
- Extracted constraints for immediate UI highlighting: ${input.constraintsPath}
- Trace fact table / event IR: ${input.traceFactsPath}
- Skill graph with conditions, branches, and trace path: ${input.skillGraphPath}
- Coverage findings when available: ${input.findingsPath}
- Reserved optimizer output path: ${input.optimizedSkillPath}

Important:
- The first visible artifact should be constraints.json, after you have extracted precise constraints from the selected skill.
- The second visible artifact should be skill-graph.json. Build it from the skill structure and extracted constraints before judging all coverage. Update branch/path fields after inspecting trace.
- Start from constraint-seed.json. Review and refine it instead of re-deriving every line from scratch.
- Use a program-analysis workflow: compile the skill into a constraint/control-flow graph, compile the trace into trace-facts.json, then judge coverage with reachability, path sensitivity, dataflow evidence, ordering, and counterexample slices.
- Use native-verifier.json as hard evidence for final-output/artifact contracts when it contains deterministic verifier results. A passing native verifier can cover final-output constraints, but it does not prove process-adherence constraints such as tool order, candidate scoring order, or whether an explicit validation step happened before writing.
- Classify each extracted constraint with a target when possible: "final_output", "artifact", "process", "tool_use", "reporting", or "unknown". Keep process gaps separate from final-output failures.
- Validation-order rules such as "validate before writing" or "run checks before final answer" are process/tool-use constraints, not final-output constraints. Native verifier pass proves artifact validity, not validation ordering.
- Constraint extraction is coverage-oriented, not summary-oriented. For long rule-heavy skills, keep all observable mandatory/prohibited/order/validation/final-output constraints. Do not shrink hundreds of seed entries to a few dozen salient examples unless you record a concrete exclusion rationale in progress.md.
- findings.json should contain one finding for every extracted constraint. Use status "unknown" for constraints whose evidence was not inspected enough; do not omit them.
- Distinguish "missed" from "violated": missed means an applicable required action was ignored or absent; violated means the trace contains explicit conflicting behavior. Do not label absence alone as violated.
- Do not optimize or rewrite the skill in this analyzer pass. Leave optimized-skill.md untouched; SkillScope will launch the optimizer skill after findings.json is saved.
- Append short progress notes to progress.md as you inspect the trace.
- Use event IDs from trace-events.json as evidence IDs.
- Do not use web search or network access; all required evidence is in the local files above.
- Do not modify source files in the repository. Only write the working artifacts listed above.
- Final response can be Markdown and does not need to follow a response schema.

Request summary:
${JSON.stringify(input.request.project, null, 2)}
`;
}

function buildConstraintSeed(project: ReturnType<typeof createProjectFromCaptureBundle>) {
  return project.units.flatMap((unit) => {
    const constraints = unit.constraints.length
      ? unit.constraints
      : unit.observable
        ? [
            {
              id: `${unit.id}.seed`,
              kind: "other",
              text: unit.text,
              span: {
                lineStart: unit.lineStart,
                lineEnd: unit.lineEnd,
                charStart: 0,
                charEnd: unit.text.length,
                text: unit.text
              },
              severity: unit.modality === "prohibited" ? "must_not" : unit.modality === "recommended" ? "should" : "info"
            }
          ]
        : [];
    return constraints.filter((constraint) => isUsefulConstraintSeed(constraint)).map((constraint) => ({
      id: constraint.id,
      unitId: unit.id,
      kind: constraint.kind,
      text: constraint.text,
      severity: constraint.severity,
      sourceSpan: constraint.span,
      rationale: "Seed constraint from SkillScope's markdown parser; analyzer agent should review and refine this before judging trace evidence."
    }));
  });
}

function buildNativeVerifierArtifact(result: Record<string, unknown> | undefined) {
  const reward = numberFromUnknown(result?.reward) ?? numberFromUnknown(result?.score);
  const success = typeof result?.success === "boolean" ? result.success : typeof reward === "number" ? reward >= 1 : undefined;
  const nativeVerifier =
    result?.nativeVerifier && typeof result.nativeVerifier === "object"
      ? (result.nativeVerifier as Record<string, unknown>)
      : result?.verifier_result && typeof result.verifier_result === "object"
        ? (result.verifier_result as Record<string, unknown>)
        : undefined;
  return {
    schemaVersion: "skilllens.native-verifier.v1",
    source: "capture_result",
    reward: numberFromUnknown(nativeVerifier?.reward) ?? reward ?? null,
    passed: typeof nativeVerifier?.passed === "boolean" ? nativeVerifier.passed : success ?? null,
    tests: numberFromUnknown(nativeVerifier?.tests) ?? null,
    passedTests: numberFromUnknown(nativeVerifier?.passedTests) ?? null,
    failedTests: numberFromUnknown(nativeVerifier?.failedTests) ?? null,
    failedTestNames: Array.isArray(nativeVerifier?.failedTestNames)
      ? nativeVerifier.failedTestNames.filter((item): item is string => typeof item === "string")
      : [],
    note:
      "Native verifier evidence is deterministic final-output evidence when present. It does not prove process-adherence constraints."
  };
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isUsefulConstraintSeed(constraint: { kind: string; text: string; severity: string }): boolean {
  const text = constraint.text.trim();
  if (!text || /^```/.test(text)) {
    return false;
  }
  if (/^(run|use|after|before|created or updated)\s*:?.?$/i.test(text)) {
    return false;
  }
  if (text.length < 8 && constraint.kind !== "numeric") {
    return false;
  }
  if (constraint.severity === "info" && constraint.kind === "action" && text.length < 32) {
    return false;
  }
  return true;
}

async function pollAgentArtifacts(
  input: {
    project: ReturnType<typeof createProjectFromCaptureBundle>;
    requestId: string;
    progressPath: string;
    constraintsPath: string;
    skillGraphPath: string;
  },
  hooks: AgentAnalysisHooks,
  isDone: () => boolean
) {
  let lastProgressLength = 0;
  let lastConstraintsSignature = "";
  let lastSkillGraphSignature = "";
  for (;;) {
    await emitProgressArtifact(input.progressPath, hooks, lastProgressLength).then((nextLength) => {
      lastProgressLength = nextLength;
    });
    const constraints = await readExtractedConstraintsArtifact(input.constraintsPath, input.project);
    if (constraints.length) {
      const findings = constraintsToPendingFindings(input.project, constraints, input.requestId);
      const signature = JSON.stringify(findings.map((finding) => [finding.id, finding.unitId, finding.analyzedConstraint?.text]));
      if (signature !== lastConstraintsSignature) {
        lastConstraintsSignature = signature;
        hooks.onConstraints?.({
          findings,
          extractedCount: constraints.length,
          constraintsPath: input.constraintsPath
        });
        hooks.onAgentText?.({
          stream: "stdout",
          text: `已识别 ${constraints.length} 条 skill 约束，正在继续检查 trace 证据。`
        });
      }
    }
    const skillGraph = await readSkillGraphArtifact(input.skillGraphPath, input.project);
    if (skillGraph?.nodes.length) {
      const signature = JSON.stringify({
        nodes: skillGraph.nodes.map((node) => [node.id, node.kind, node.unitId, node.branchState, node.status]),
        edges: skillGraph.edges.map((edge) => [edge.from, edge.to, edge.kind, edge.taken]),
        paths: skillGraph.paths.map((pathItem) => [pathItem.id, pathItem.nodeIds])
      });
      if (signature !== lastSkillGraphSignature) {
        lastSkillGraphSignature = signature;
        hooks.onSkillGraph?.({
          skillGraph,
          skillGraphPath: input.skillGraphPath
        });
        hooks.onAgentText?.({
          stream: "stdout",
          text: `已生成 skill graph：${skillGraph.nodes.length} 个节点，${skillGraph.edges.length} 条边，${skillGraph.paths.length} 条路径。`
        });
      }
    }
    if (isDone()) {
      await emitProgressArtifact(input.progressPath, hooks, lastProgressLength);
      return;
    }
    await sleep(900);
  }
}

async function emitProgressArtifact(progressPath: string, hooks: AgentAnalysisHooks, previousLength: number): Promise<number> {
  if (!existsSync(progressPath)) {
    return previousLength;
  }
  try {
    const content = await readFile(progressPath, "utf8");
    if (content.length <= previousLength) {
      return content.length;
    }
    const appended = content.slice(previousLength).trim();
    if (appended) {
      hooks.onAgentText?.({ stream: "stdout", text: appended });
    }
    return content.length;
  } catch {
    return previousLength;
  }
}

async function readExtractedConstraintsArtifact(
  constraintsPath: string,
  project: ReturnType<typeof createProjectFromCaptureBundle>
) {
  if (!existsSync(constraintsPath)) {
    return [];
  }
  try {
    return parseAgentConstraintsResponse(await readFile(constraintsPath, "utf8"), project);
  } catch {
    return [];
  }
}

async function readSkillGraphArtifact(
  skillGraphPath: string,
  project: ReturnType<typeof createProjectFromCaptureBundle>
): Promise<SkillGraphArtifact | null> {
  if (!existsSync(skillGraphPath)) {
    return null;
  }
  try {
    return parseAgentSkillGraphResponse(await readFile(skillGraphPath, "utf8"), project);
  } catch {
    return null;
  }
}

async function readAgentResponseFromArtifact(findingsPath: string, requestId: string) {
  if (!existsSync(findingsPath)) {
    return null;
  }
  try {
    const response = parseAgentJudgeResponse(await readFile(findingsPath, "utf8"), requestId);
    return response.judgments.length ? response : null;
  } catch {
    return null;
  }
}

function extractAgentOutputText(rawOutput: string): string {
  const parsed = parseJsonText(rawOutput);
  if (!parsed) {
    return rawOutput.trim();
  }
  const text = extractTextFromUnknown(parsed);
  return text || rawOutput.trim();
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractTextFromUnknown(value: unknown): string {
  const seen = new Set<unknown>();
  const chunks: string[] = [];
  const visit = (node: unknown, key = "") => {
    if (node == null || seen.has(node) || chunks.join("\n").length > 12000) {
      return;
    }
    if (typeof node === "string") {
      if (/message|text|content|output|summary|final|response/i.test(key) && node.trim()) {
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
    for (const candidate of ["message", "text", "content", "output", "summary", "final_answer", "response"]) {
      if (candidate in object) {
        visit(object[candidate], candidate);
      }
    }
    if (!chunks.length) {
      Object.entries(object).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(value);
  return Array.from(new Set(chunks)).join("\n\n");
}

async function runAgentJudgeCli(
  agentProduct: CaptureBundle["agent"]["product"],
  prompt: string,
  paths: { workDir: string; promptPath: string; rawOutputPath: string; tracePath?: string },
  hooks: AgentAnalysisHooks = {}
): Promise<string> {
  if (agentProduct === "claude_code") {
    const result = await runCommandWithInputStream(
      "claude",
      ["-p", "--output-format", "text", "--permission-mode", "dontAsk"],
      prompt,
      process.cwd(),
      hooks,
      paths
    );
    return result.stdout.trim() || result.stderr.trim();
  }

  const codexOutputPath = path.join(paths.workDir, "codex-last-message.json");
  await runCommandWithInputStream(
    "codex",
    [
      "exec",
      "--cd",
      process.cwd(),
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "danger-full-access",
      "--json",
      "-o",
      codexOutputPath,
      "-"
    ],
    prompt,
    process.cwd(),
    hooks,
    paths
  );
  if (existsSync(codexOutputPath)) {
    return readFile(codexOutputPath, "utf8");
  }
  throw new Error("Codex judge did not write an output message.");
}

async function runAgentJudgeCliWithRetry(
  agentProduct: CaptureBundle["agent"]["product"],
  prompt: string,
  paths: { workDir: string; promptPath: string; rawOutputPath: string; tracePath?: string },
  hooks: AgentAnalysisHooks = {}
): Promise<string> {
  const maxAttempts = 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        hooks.onAgentText?.({
          stream: "stderr",
          text: `Retrying agent judge after transient upstream failure (${attempt}/${maxAttempts}).`
        });
      }
      return await runAgentJudgeCli(agentProduct, prompt, paths, hooks);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientAgentError(error)) {
        throw error;
      }
      hooks.onAgentText?.({
        stream: "stderr",
        text: `Transient upstream error from ${agentProduct === "claude_code" ? "Claude Code" : "Codex"}; retrying. ${summarizeAgentError(error)}`
      });
      await sleep(2500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Agent judge failed."));
}

function isTransientAgentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b(502|503|504|Bad Gateway|Service Unavailable|Gateway Timeout|ECONNRESET|ETIMEDOUT|reconnecting|unexpected status)\b/i.test(
    message
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedSkillPaths(bundle: CaptureBundle): string[] {
  const loaded = bundle.skills.filter((skill) => skill.loaded);
  const candidates = loaded.length ? loaded : bundle.skills;
  return candidates.map((skill) => skill.path).filter(Boolean);
}

function summarizeAgentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Agent analysis failed.");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const important = lines.filter((line) =>
    /\b(ERROR|error|failed|unexpected status|Bad Gateway|timeout|timed out|did not write|requestId|schema)\b/i.test(line)
  );
  const selected = important.length ? important : lines.slice(-8);
  const summary = selected.join("\n");
  return summary.length > 1600 ? `${summary.slice(0, 1600)}...` : summary || "Agent analysis failed.";
}

function isAgentBlockedAnalysis(text: string): boolean {
  return /\b(Blocked by|Failed to write file|bwrap:|Operation not permitted|could not read the required local files)\b/i.test(text);
}

function hasOptimizableFindings(findings: CoverageFinding[]): boolean {
  return findings.some((finding) => finding.status === "violated" || finding.status === "missed");
}

function summarizeOptimizableFindings(findings: CoverageFinding[]): string {
  const risky = findings
    .filter((finding) => finding.status === "violated" || finding.status === "missed")
    .slice(0, 24)
    .map((finding, index) => {
      const constraint = finding.analyzedConstraint?.text ?? finding.rationale;
      const span = finding.analyzedConstraint?.span
        ? `L${finding.analyzedConstraint.span.lineStart}-L${finding.analyzedConstraint.span.lineEnd}`
        : "unknown span";
      const evidence = [...finding.evidenceEventIds, ...finding.counterEvidenceEventIds].slice(0, 8).join(", ") || "no direct evidence IDs";
      const target = finding.target ?? finding.analyzedConstraint?.target ?? "unknown";
      const native = finding.nativeEvidence?.length
        ? `\n   native evidence: ${finding.nativeEvidence
            .slice(0, 4)
            .map((item) => `${item.source}:${item.status}${item.testName ? `:${item.testName}` : ""}`)
            .join(", ")}`
        : "";
      return `${index + 1}. ${finding.status} target=${target} ${finding.unitId} ${span}: ${constraint}\n   evidence: ${evidence}${native}\n   rationale: ${finding.rationale}`;
    });
  return risky.length ? risky.join("\n") : "No violated or missed findings.";
}

function analysisCacheKey(input: {
  captureId: string;
  segmentStartStep?: number;
  segmentEndStep?: number;
  maxFindings: number;
  skillSha256: string;
  analyzerVersion: string;
}): string {
  return sha256(JSON.stringify(input)).slice(0, 16);
}

async function readCachedAnalysis(key: string): Promise<AgentAnalysisCacheEntry | null> {
  await ensureAnalysisDb();
  const rows = await sqliteJson<{
    key: string;
    createdAt: string;
    updatedAt: string;
    captureId: string;
    segmentStartStep: number | null;
    segmentEndStep: number | null;
    maxFindings: number;
    skillSha256: string;
    analyzerVersion: string;
    resultJson: string;
  }>(
    `SELECT key,
            created_at AS createdAt,
            updated_at AS updatedAt,
            capture_id AS captureId,
            segment_start_step AS segmentStartStep,
            segment_end_step AS segmentEndStep,
            max_findings AS maxFindings,
            skill_sha256 AS skillSha256,
            analyzer_version AS analyzerVersion,
            result_json AS resultJson
       FROM analysis_runs
      WHERE key = ${sqlText(key)}
      LIMIT 1;`
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    key: row.key,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    captureId: row.captureId,
    segmentStartStep: row.segmentStartStep ?? undefined,
    segmentEndStep: row.segmentEndStep ?? undefined,
    maxFindings: row.maxFindings,
    skillSha256: row.skillSha256,
    analyzerVersion: row.analyzerVersion,
    result: JSON.parse(row.resultJson)
  };
}

async function readCachedAnalysisForCapture(options: {
  captureId: string;
  segmentStartStep?: number;
  segmentEndStep?: number;
}) {
  const registry = await readRegistry();
  const entry = registry.captures.find((capture: { id: string }) => capture.id === options.captureId);
  if (!entry?.bundlePath) {
    throw new Error(`Capture not found: ${options.captureId}`);
  }
  const bundle = JSON.parse(await readFile(entry.bundlePath, "utf8")) as CaptureBundle;
  const effectiveSegment = resolveCaptureSegment(bundle.trace.segments, options);
  const effectiveSegmentStartStep = effectiveSegment?.startStep ?? options.segmentStartStep;
  const effectiveSegmentEndStep = effectiveSegment?.endStep ?? options.segmentEndStep;
  const project = createProjectFromCaptureBundle(bundle, {
    segmentStartStep: effectiveSegmentStartStep,
    segmentEndStep: effectiveSegmentEndStep,
    lazyFindings: true
  });
  const cacheKey = analysisCacheKey({
    captureId: options.captureId,
    segmentStartStep: effectiveSegmentStartStep,
    segmentEndStep: effectiveSegmentEndStep,
    maxFindings: 0,
    skillSha256: sha256(project.skillMarkdown),
    analyzerVersion: ANALYZER_VERSION
  });
  const cached = await readCachedAnalysis(cacheKey);
  const compatibleCached =
    cached ??
    (await readLatestCompatibleCachedAnalysis({
      captureId: options.captureId,
      segmentStartStep: effectiveSegmentStartStep,
      segmentEndStep: effectiveSegmentEndStep,
      maxFindings: 0,
      skillSha256: sha256(project.skillMarkdown),
      analyzerVersion: ANALYZER_VERSION
    }));
  if (!compatibleCached) {
    return null;
  }
  const hydratedResult = await hydrateCachedResultWithExtractedConstraints(project, compatibleCached.result);
  return {
    ...hydratedResult,
    cached: true,
    cacheKey: compatibleCached.key,
    createdAt: compatibleCached.createdAt,
    updatedAt: compatibleCached.updatedAt
  };
}

async function readLatestCompatibleCachedAnalysis(input: {
  captureId: string;
  segmentStartStep?: number;
  segmentEndStep?: number;
  maxFindings: number;
  skillSha256: string;
  analyzerVersion: string;
}): Promise<AgentAnalysisCacheEntry | null> {
  await ensureAnalysisDb();
  const rows = await sqliteJson<{
    key: string;
    createdAt: string;
    updatedAt: string;
    captureId: string;
    segmentStartStep: number | null;
    segmentEndStep: number | null;
    maxFindings: number;
    skillSha256: string;
    analyzerVersion: string;
    resultJson: string;
  }>(
    `SELECT key,
            created_at AS createdAt,
            updated_at AS updatedAt,
            capture_id AS captureId,
            segment_start_step AS segmentStartStep,
            segment_end_step AS segmentEndStep,
            max_findings AS maxFindings,
            skill_sha256 AS skillSha256,
            analyzer_version AS analyzerVersion,
            result_json AS resultJson
       FROM analysis_runs
      WHERE capture_id = ${sqlText(input.captureId)}
        AND segment_start_step IS ${sqlNullableNumber(input.segmentStartStep)}
        AND segment_end_step IS ${sqlNullableNumber(input.segmentEndStep)}
        AND max_findings = ${input.maxFindings}
        AND skill_sha256 = ${sqlText(input.skillSha256)}
        AND analyzer_version = ${sqlText(input.analyzerVersion)}
      ORDER BY updated_at DESC
      LIMIT 5;`
  );
  for (const row of rows) {
    const result = JSON.parse(row.resultJson) as Record<string, unknown>;
    if (Array.isArray(result.findings) && result.findings.length > 0) {
      return {
        key: row.key,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        captureId: row.captureId,
        segmentStartStep: row.segmentStartStep ?? undefined,
        segmentEndStep: row.segmentEndStep ?? undefined,
        maxFindings: row.maxFindings,
        skillSha256: row.skillSha256,
        analyzerVersion: row.analyzerVersion,
        result
      };
    }
  }
  return null;
}

function resolveCaptureSegment(
  segments: CapturedSessionSegment[] | undefined,
  options: { segmentStartStep?: number; segmentEndStep?: number }
): CapturedSessionSegment | undefined {
  if (!segments?.length) {
    return undefined;
  }
  if (typeof options.segmentStartStep === "number") {
    const exact = segments.find((segment) => segment.startStep === options.segmentStartStep);
    if (exact) {
      return exact;
    }
    const containing = segments.find(
      (segment) => options.segmentStartStep! >= segment.startStep && options.segmentStartStep! <= segment.endStep
    );
    if (containing) {
      return containing;
    }
  }
  return [...segments].reverse().find((segment) => segment.skillArtifactIds?.length) ?? segments[0];
}

async function hydrateCachedResultWithExtractedConstraints(
  project: ReturnType<typeof createProjectFromCaptureBundle>,
  result: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const findings = Array.isArray(result.findings) ? (result.findings as CoverageFinding[]) : [];
  const constraintsPath = typeof result.constraintsPath === "string" ? result.constraintsPath : "";
  const skillGraphPath = typeof result.skillGraphPath === "string" ? result.skillGraphPath : "";
  const optimizedSkillPath = typeof result.optimizedSkillPath === "string" ? result.optimizedSkillPath : "";
  const skillGraph =
    result.skillGraph && typeof result.skillGraph === "object"
      ? (result.skillGraph as SkillGraphArtifact)
      : skillGraphPath
        ? await readSkillGraphArtifact(skillGraphPath, project)
        : null;
  const optimizedSkill =
    typeof result.optimizedSkill === "string" && result.optimizedSkill.trim()
      ? result.optimizedSkill
      : optimizedSkillPath && existsSync(optimizedSkillPath)
        ? await readFile(optimizedSkillPath, "utf8")
        : "";
  if (!findings.length || !constraintsPath || !existsSync(constraintsPath)) {
    return {
      ...result,
      ...(skillGraph ? { skillGraph } : {}),
      ...(optimizedSkill ? { optimizedSkill } : {})
    };
  }
  const requestId = typeof result.requestId === "string" ? result.requestId : "cached-agent-analysis";
  const constraints = await readExtractedConstraintsArtifact(constraintsPath, project);
  if (!constraints.length) {
    return skillGraph ? { ...result, skillGraph } : result;
  }
  const pendingFindings = constraintsToPendingFindings(project, constraints, requestId);
  const mergedFindings = mergePendingAndJudgedFindings(pendingFindings, findings);
  return {
    ...result,
    ...(skillGraph ? { skillGraph } : {}),
    ...(optimizedSkill ? { optimizedSkill } : {}),
    findings: mergedFindings,
    judgedCount: mergedFindings.length,
    structuredJudgments: typeof result.structuredJudgments === "number" ? result.structuredJudgments : findings.length
  };
}

function mergePendingAndJudgedFindings(
  pendingFindings: CoverageFinding[],
  judgedFindings: CoverageFinding[]
): CoverageFinding[] {
  const pendingByKey = new Map<string, CoverageFinding>();
  pendingFindings.forEach((finding) => {
    findingDisplayKeys(finding).forEach((key) => {
      if (!pendingByKey.has(key)) {
        pendingByKey.set(key, finding);
      }
    });
  });
  const refinedJudgedFindings = judgedFindings.map((finding) => {
    const matchingPending = findingDisplayKeys(finding).map((key) => pendingByKey.get(key)).find(Boolean);
    if (!matchingPending?.analyzedConstraint?.span || !finding.analyzedConstraint) {
      return finding;
    }
    return {
      ...finding,
      analyzedConstraint: {
        ...finding.analyzedConstraint,
        span: matchingPending.analyzedConstraint.span
      }
    };
  });
  const seen = new Set(refinedJudgedFindings.flatMap(findingDisplayKeys));
  const missingPending = pendingFindings.filter((finding) => {
    const keys = findingDisplayKeys(finding);
    if (keys.some((key) => seen.has(key))) {
      return false;
    }
    keys.forEach((key) => seen.add(key));
    return true;
  });
  return [...refinedJudgedFindings, ...missingPending];
}

function findingDisplayKeys(finding: CoverageFinding): string[] {
  const keys: string[] = [];
  const text = normalizeFindingText(finding.analyzedConstraint?.text ?? finding.analyzedConstraint?.span.text ?? finding.rationale);
  if (text) {
    keys.push(`text:${finding.unitId}:${text}`);
  }
  const span = finding.analyzedConstraint?.span;
  if (span) {
    keys.push(`span:${finding.unitId}:${span.lineStart}:${span.lineEnd}:${span.charStart}:${span.charEnd}`);
    keys.push(`line-text:${finding.unitId}:${span.lineStart}:${span.lineEnd}:${text}`);
  }
  if (finding.constraintId) {
    keys.push(`constraint:${finding.unitId}:${finding.constraintId}`);
  }
  return keys.length ? keys : [`finding:${finding.unitId}:${finding.id}`];
}

function normalizeFindingText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

async function writeCachedAnalysis(input: {
  key: string;
  captureId: string;
  segmentStartStep?: number;
  segmentEndStep?: number;
  maxFindings: number;
  skillSha256: string;
  analyzerVersion: string;
  result: Record<string, unknown>;
}) {
  await ensureAnalysisDb();
  const now = new Date().toISOString();
  const existing = await readCachedAnalysis(input.key);
  const createdAt = existing?.createdAt ?? now;
  const findings = Array.isArray(input.result.findings) ? (input.result.findings as CoverageFinding[]) : [];
  const findingInserts = findings.map(
    (finding) => `INSERT INTO coverage_findings (
        analysis_key, finding_id, unit_id, status, confidence, finding_json
      ) VALUES (
        ${sqlText(input.key)},
        ${sqlText(finding.id)},
        ${sqlText(finding.unitId)},
        ${sqlText(finding.status)},
        ${Number.isFinite(finding.confidence) ? finding.confidence : 0},
        ${sqlText(JSON.stringify(finding))}
      );`
  );
  await sqliteExec(`
    BEGIN IMMEDIATE;
    INSERT INTO analysis_runs (
      key, capture_id, segment_start_step, segment_end_step, max_findings,
      skill_sha256, analyzer_version, created_at, updated_at, result_json
    ) VALUES (
      ${sqlText(input.key)},
      ${sqlText(input.captureId)},
      ${sqlNullableNumber(input.segmentStartStep)},
      ${sqlNullableNumber(input.segmentEndStep)},
      ${input.maxFindings},
      ${sqlText(input.skillSha256)},
      ${sqlText(input.analyzerVersion)},
      ${sqlText(createdAt)},
      ${sqlText(now)},
      ${sqlText(JSON.stringify(input.result))}
    )
    ON CONFLICT(key) DO UPDATE SET
      capture_id = excluded.capture_id,
      segment_start_step = excluded.segment_start_step,
      segment_end_step = excluded.segment_end_step,
      max_findings = excluded.max_findings,
      skill_sha256 = excluded.skill_sha256,
      analyzer_version = excluded.analyzer_version,
      updated_at = excluded.updated_at,
      result_json = excluded.result_json;
    DELETE FROM coverage_findings WHERE analysis_key = ${sqlText(input.key)};
    ${findingInserts.join("\n")}
    COMMIT;
  `);
}

let analysisDbReady: Promise<void> | null = null;

function ensureAnalysisDb(): Promise<void> {
  analysisDbReady ??= initializeAnalysisDb();
  return analysisDbReady;
}

async function initializeAnalysisDb() {
  await mkdir(path.dirname(analysisDbPath()), { recursive: true });
  await sqliteExec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS analysis_runs (
      key TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL,
      segment_start_step INTEGER,
      segment_end_step INTEGER,
      max_findings INTEGER NOT NULL DEFAULT 0,
      skill_sha256 TEXT NOT NULL,
      analyzer_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_runs_capture
      ON analysis_runs(capture_id, segment_start_step, segment_end_step, analyzer_version);
    CREATE TABLE IF NOT EXISTS coverage_findings (
      analysis_key TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      finding_json TEXT NOT NULL,
      PRIMARY KEY (analysis_key, finding_id),
      FOREIGN KEY (analysis_key) REFERENCES analysis_runs(key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_coverage_findings_unit
      ON coverage_findings(analysis_key, unit_id, status);
  `);
}

function analysisDbPath(): string {
  return path.join(process.cwd(), ".skilllens", "skillscope.sqlite");
}

async function sqliteExec(sql: string): Promise<void> {
  await runCommandWithInput("sqlite3", ["-batch", analysisDbPath()], sql, process.cwd());
}

async function sqliteJson<T>(sql: string): Promise<T[]> {
  const result = await runCommandWithInput("sqlite3", ["-batch", "-json", analysisDbPath()], sql, process.cwd());
  const output = result.stdout.trim();
  return output ? (JSON.parse(output) as T[]) : [];
}

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function sqlNullableNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.floor(value)) : "NULL";
}

async function readLocalSessionIndexDb(): Promise<LocalSessionIndexDb | null> {
  const dbPath = localSessionIndexDbPath();
  if (!existsSync(dbPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(dbPath, "utf8")) as LocalSessionIndexDb;
    if (parsed.schemaVersion !== "skilllens.local-session-index.v2") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function readLocalTraceCacheDb(): Promise<LocalTraceCacheDb> {
  const dbPath = localTraceCacheDbPath();
  if (!existsSync(dbPath)) {
    return {
      schemaVersion: "skilllens.local-trace-cache.v2",
      updatedAt: new Date(0).toISOString(),
      records: {}
    };
  }
  try {
    const parsed = JSON.parse(await readFile(dbPath, "utf8")) as LocalTraceCacheDb;
    if (parsed.schemaVersion !== "skilllens.local-trace-cache.v2" || !parsed.records) {
      throw new Error("Unsupported trace cache schema.");
    }
    return parsed;
  } catch {
    return {
      schemaVersion: "skilllens.local-trace-cache.v2",
      updatedAt: new Date(0).toISOString(),
      records: {}
    };
  }
}

async function writeLocalTraceCacheDb(index: LocalTraceCacheDb) {
  const dbPath = localTraceCacheDbPath();
  await mkdir(path.dirname(dbPath), { recursive: true });
  await writeFile(dbPath, `${JSON.stringify(index, null, 2)}\n`);
}

function localTraceCacheDbPath(): string {
  return path.join(process.cwd(), ".skilllens", "local-trace-cache.json");
}

function skillScopeAnalyzerSkillPath(): string {
  return path.join(process.cwd(), "skills", "skillscope-analyzer", "SKILL.md");
}

function skillScopeOptimizerSkillPath(): string {
  return path.join(process.cwd(), "skills", "skillscope-optimizer", "SKILL.md");
}

async function writeLocalSessionIndexDb(index: LocalSessionIndexDb) {
  const dbPath = localSessionIndexDbPath();
  await mkdir(path.dirname(dbPath), { recursive: true });
  await writeFile(dbPath, `${JSON.stringify(index, null, 2)}\n`);
}

function localSessionIndexDbPath(): string {
  return path.join(process.cwd(), ".skilllens", "local-session-index.json");
}

async function captureLocalSession(
  tracePath: string,
  cwd: string,
  skillPaths: string[] = [],
  agentProduct: "codex" | "claude_code" = "codex",
  targetStartStep?: number,
  targetEndStep?: number
) {
  const safeTracePath = path.resolve(tracePath);
  const safeCwd = path.resolve(cwd);
  const resolvedSkillPaths = skillPaths.map((skillPath) => resolveMaybeRelative(safeCwd, skillPath));
  const captureId = `ui-${shortHash(
    [
      safeTracePath,
      safeCwd,
      agentProduct,
      String(targetStartStep ?? ""),
      String(targetEndStep ?? ""),
      ...resolvedSkillPaths
    ].join("\n")
  )}`;
  const outPath = path.join(process.cwd(), ".skilllens", "captures", captureId, "skillscope.capture.json");
  if (existsSync(outPath)) {
    const bundle = JSON.parse(await readFile(outPath, "utf8")) as CaptureBundle;
    await updateCaptureRegistry(process.cwd(), outPath, captureId, bundle);
    return { captureId, outPath, targetStartStep, targetEndStep, registry: await readRegistry(), cached: true };
  }

  const traceContent = await readTraceWindow(safeTracePath, targetStartStep, targetEndStep);
  const traceEvents = parseTraceText(traceContent);
  const skills = await Promise.all(
    resolvedSkillPaths.map((skillPath, index) => readSkillArtifactForCapture(skillPath, index))
  );
  const meta = agentProduct === "codex" ? await readCodexSessionMeta(safeTracePath) : await readClaudeSessionMeta(safeTracePath);
  const sessionId = meta.sessionId ?? path.basename(safeTracePath, ".jsonl");
  const bundle: CaptureBundle = {
    schemaVersion: "skilllens.capture.v1",
    source: agentProduct === "codex" ? "codex_plugin" : "claude_code_plugin",
    createdAt: new Date().toISOString(),
    agent: {
      product: agentProduct,
      version: meta.cliVersion,
      model: meta.model ?? meta.modelProvider
    },
    task: {
      id: sessionId,
      prompt: titleForCapturePrompt(traceEvents, targetStartStep),
      cwd: safeCwd
    },
    skills,
    trace: {
      id: sessionId,
      path: safeTracePath,
      format: detectTraceFormat(traceContent),
      content: traceContent,
      sessionId,
      sha256: sha256(traceContent),
      segments: [
        {
          id: "skill-window-001",
          title: firstLine(titleForCapturePrompt(traceEvents, targetStartStep) ?? "Selected skill use"),
          startStep: traceEvents[0]?.step ?? 1,
          endStep: traceEvents[traceEvents.length - 1]?.step ?? 1,
          prompt: titleForCapturePrompt(traceEvents, targetStartStep),
          skillArtifactIds: skills.map((skill) => skill.id),
          notes: "Selected skill-use window captured from local SkillLens index. The full session is intentionally not loaded."
        }
      ]
    },
    analysis: {
      method: "heuristic",
      notes: "Captured directly from the SkillLens local UI for a selected skill-use window."
    }
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
  await updateCaptureRegistry(process.cwd(), outPath, captureId, bundle);
  return { captureId, outPath, targetStartStep, targetEndStep, registry: await readRegistry(), cached: false };
}

async function readTraceWindow(filePath: string, targetStartStep?: number, targetEndStep?: number): Promise<string> {
  if (typeof targetStartStep !== "number" || typeof targetEndStep !== "number") {
    return readFile(filePath, "utf8");
  }
  const startLine = Math.max(1, targetStartStep - 24);
  const endLine = Math.max(startLine, targetEndStep + 24);
  const selected: string[] = [];
  let lineNumber = 0;
  let buffer = "";

  for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      lineNumber += 1;
      if (lineNumber >= startLine && lineNumber <= endLine && line.trim()) {
        selected.push(line);
      }
      if (lineNumber > endLine) {
        return selected.join("\n") || readFile(filePath, "utf8");
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  if (buffer) {
    lineNumber += 1;
    if (lineNumber >= startLine && lineNumber <= endLine && buffer.trim()) {
      selected.push(buffer);
    }
  }
  return selected.join("\n") || readFile(filePath, "utf8");
}

async function readSkillArtifactForCapture(filePath: string, index: number): Promise<CapturedSkillArtifact> {
  const content = await readFile(filePath, "utf8");
  return {
    id: `skill-artifact-${String(index + 1).padStart(3, "0")}`,
    kind: inferSkillKind(filePath),
    path: filePath,
    title: inferTitle(content, filePath),
    content,
    sha256: sha256(content),
    loaded: true,
    loadReason: "Selected skill-use from local SkillLens index."
  };
}

function inferSkillKind(filePath: string): CapturedSkillArtifact["kind"] {
  const base = path.basename(filePath).toLowerCase();
  if (base === "claude.md" || base === "agents.md") {
    return "rule";
  }
  if (filePath.toLowerCase().includes("memory")) {
    return "memory";
  }
  if (filePath.toLowerCase().includes("playbook")) {
    return "playbook";
  }
  return "skill";
}

function inferTitle(content: string, filePath: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || path.basename(path.dirname(filePath)) || path.basename(filePath);
}

function titleForCapturePrompt(events: TraceEvent[], targetStartStep?: number): string | undefined {
  if (!events.length) {
    return undefined;
  }
  const target = targetStartStep ?? events[0].step;
  const previousUser = [...events]
    .reverse()
    .find((event) => event.step <= target && event.role.toLowerCase().includes("user") && event.content.trim());
  return previousUser?.content ?? events.find((event) => event.role.toLowerCase().includes("user") && event.content.trim())?.content;
}

function segmentTraceForCapture(
  events: TraceEvent[],
  prompt: string | undefined,
  skills: CapturedSkillArtifact[]
): CapturedSessionSegment[] {
  if (!events.length) {
    return [];
  }
  const skillWindows = segmentSkillUsageWindowsForCapture(events, prompt, skills);
  if (skillWindows.length) {
    return skillWindows;
  }

  const skillArtifactIds = skills.map((skill) => skill.id);
  const userStarts = events.filter((event) => event.role.toLowerCase().includes("user") && event.content.trim());
  if (userStarts.length <= 1) {
    return [
      {
        id: "segment-001",
        title: prompt ? firstLine(prompt) : "Session",
        startStep: events[0].step,
        endStep: events[events.length - 1].step,
        prompt,
        skillArtifactIds,
        notes: "Single segment inferred for the whole session."
      }
    ];
  }

  return userStarts.map((event, index) => {
    const next = userStarts[index + 1];
    return {
      id: `segment-${String(index + 1).padStart(3, "0")}`,
      title: firstLine(event.content) || `Segment ${index + 1}`,
      startStep: event.step,
      endStep: next ? next.step - 1 : events[events.length - 1].step,
      prompt: event.content,
      skillArtifactIds,
      notes: "Segment inferred from user message boundary. Review if this session contained task switching."
    };
  });
}

function segmentSkillUsageWindowsForCapture(
  events: TraceEvent[],
  prompt: string | undefined,
  skills: CapturedSkillArtifact[]
): CapturedSessionSegment[] {
  if (!skills.length) {
    return [];
  }

  const segments: CapturedSessionSegment[] = [];
  let cursorStep = events[0]?.step ?? 1;
  while (cursorStep <= events[events.length - 1].step) {
    const startEvent = events.find((event) => event.step >= cursorStep && skillIdsForCaptureEvent(event, skills).length);
    if (!startEvent) {
      break;
    }
    const nextUser = events.find(
      (event) => event.step > startEvent.step && event.role.toLowerCase().includes("user") && event.content.trim()
    );
    const endStep = nextUser ? nextUser.step - 1 : events[events.length - 1].step;
    const ids = new Set<string>();
    events
      .filter((event) => event.step >= startEvent.step && event.step <= endStep)
      .forEach((event) => skillIdsForCaptureEvent(event, skills).forEach((id) => ids.add(id)));
    const previousUser = [...events]
      .reverse()
      .find((event) => event.step < startEvent.step && event.role.toLowerCase().includes("user") && event.content.trim());
    segments.push({
      id: `skill-window-${String(segments.length + 1).padStart(3, "0")}`,
      title: firstLine(previousUser?.content ?? prompt ?? `Skill window ${segments.length + 1}`),
      startStep: startEvent.step,
      endStep,
      prompt: previousUser?.content ?? prompt,
      skillArtifactIds: Array.from(ids),
      notes: nextUser
        ? "Skill usage window inferred from first skill read/use event until the next user intervention."
        : "Skill usage window inferred from first skill read/use event until session end."
    });
    cursorStep = endStep + 1;
  }
  return segments;
}

function skillIdsForCaptureEvent(event: TraceEvent, skills: CapturedSkillArtifact[]): string[] {
  if (!["command", "tool_call", "assistant_message"].includes(event.type)) {
    return [];
  }
  const text = `${event.name ?? ""} ${event.content} ${event.output}`.toLowerCase();
  if (!/(skill\.md|claude\.md|agents\.md|\.skill\.md|\bskill\b)/i.test(text)) {
    return [];
  }
  return skills
    .filter((skill) => {
      const normalizedPath = skill.path.toLowerCase();
      const title = skill.title.toLowerCase();
      const parent = path.basename(path.dirname(skill.path)).toLowerCase();
      return text.includes(normalizedPath) || text.includes(title) || text.includes(parent);
    })
    .map((skill) => skill.id);
}

async function updateCaptureRegistry(root: string, bundlePath: string, id: string, bundle: CaptureBundle) {
  const registryPath = path.join(root, ".skilllens", "registry.json");
  let registry: CaptureRegistry = {
    schemaVersion: "skilllens.registry.v1",
    updatedAt: new Date().toISOString(),
    captures: []
  };
  if (existsSync(registryPath)) {
    try {
      registry = JSON.parse(await readFile(registryPath, "utf8")) as CaptureRegistry;
    } catch {
      // Keep a fresh registry if the old file is corrupt.
    }
  }

  const entry: CaptureRegistryEntry = {
    id,
    source: bundle.source,
    agentProduct: bundle.agent.product,
    traceFormat: bundle.trace.format,
    title: bundle.task?.id ?? bundle.trace.sessionId ?? path.basename(bundle.trace.path),
    bundlePath,
    cwd: bundle.task?.cwd,
    createdAt: bundle.createdAt,
    skillCount: bundle.skills.length,
    loadedSkillCount: bundle.skills.filter((skill) => skill.loaded).length,
    segmentCount: bundle.trace.segments?.length ?? 0,
    sessionId: bundle.trace.sessionId
  };

  registry.captures = [entry, ...registry.captures.filter((capture) => capture.id !== id)].slice(0, 200);
  registry.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

async function listJsonlFiles(root: string): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const results: Array<{ path: string; mtimeMs: number; size: number }> = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const fileStat = await stat(fullPath);
          results.push({ path: fullPath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
        } catch {
          // Ignore unreadable or disappearing session files.
        }
      }
    }
  }
  await walk(root);
  return results;
}

async function readCodexSessionMeta(filePath: string) {
  try {
    const firstLine = await readFirstLine(filePath);
    const parsed = JSON.parse(firstLine) as {
      payload?: {
        session_id?: string;
        id?: string;
        cwd?: string;
        timestamp?: string;
        cli_version?: string;
        model?: string;
        model_provider?: string;
        git?: {
          repository_url?: string;
        };
      };
    };
    const payload = parsed.payload ?? {};
    return {
      sessionId: payload.session_id ?? payload.id,
      cwd: payload.cwd,
      timestamp: payload.timestamp,
      cliVersion: payload.cli_version,
      model: payload.model,
      modelProvider: payload.model_provider,
      repositoryUrl: payload.git?.repository_url
    };
  } catch {
    return {};
  }
}

async function readClaudeSessionMeta(filePath: string) {
  try {
    const text = await readFileSlice(filePath, 512 * 1024);
    let sessionId = path.basename(filePath, ".jsonl");
    let timestamp: string | undefined;
    let cliVersion: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          sessionId?: string;
          cwd?: string;
          timestamp?: string;
          version?: string;
          gitBranch?: string;
          message?: {
            usage?: {
              service_tier?: string;
            };
          };
        };
        sessionId = parsed.sessionId ?? sessionId;
        timestamp = parsed.timestamp ?? timestamp;
        cliVersion = parsed.version ?? cliVersion;
        if (parsed.cwd) {
          return {
            sessionId,
            cwd: parsed.cwd,
            timestamp,
            cliVersion,
            model: parsed.message?.usage?.service_tier,
            modelProvider: "claude_code",
            repositoryUrl: undefined
          };
        }
      } catch {
        // Keep scanning; Claude JSONL can include different record shapes.
      }
    }
    return {
      sessionId,
      cwd: undefined,
      timestamp,
      cliVersion,
      modelProvider: "claude_code"
    };
  } catch {
    return {};
  }
}

async function detectCodexSkillUsage(filePath: string, cwd: string) {
  const text = await readFileSlice(filePath, 3 * 1024 * 1024);
  const usedSkills: string[] = [];
  const skillPaths: string[] = [];
  let evidenceCount = 0;

  for (const line of text.split("\n")) {
    if (!isSkillUseEvidenceLine(line)) {
      continue;
    }
    const paths = extractSkillLikePaths(line);
    if (!paths.length) {
      continue;
    }
    evidenceCount += 1;
    paths.forEach((rawPath) => {
      const cleanPath = resolveMaybeRelative(cwd, rawPath.replace(/\\n.*$/g, "").replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
      if (!skillPaths.includes(cleanPath)) {
        skillPaths.push(cleanPath);
      }
      const name = skillNameFromPath(cleanPath);
      if (name && !usedSkills.includes(name)) {
        usedSkills.push(name);
      }
    });
  }

  const validSkillPaths = skillPaths.filter((candidate) => existsSync(candidate));
  const validUsedSkills = validSkillPaths
    .map((candidate) => skillNameFromPath(candidate))
    .filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);
  if (!validUsedSkills.length) {
    const virtualSkill = await virtualBatchSkillForCwd(cwd);
    if (virtualSkill) {
      const events = lightweightTraceEvents(text, [virtualSkill.path]);
      const bounds = traceBounds(events);
      const title = firstUserTitle(events) ?? virtualSkill.name;
      return {
        usedSkills: [virtualSkill.name],
        skillPaths: [virtualSkill.path],
        evidenceCount: 0,
        uses: [
          {
            skillName: virtualSkill.name,
            skillPath: virtualSkill.path,
            title,
            startStep: bounds.firstStep,
            endStep: bounds.lastStep,
            evidenceStep: bounds.firstStep
          }
        ]
      };
    }
  }
  const uses = buildSkillUseEntries(text, validSkillPaths);
  return {
    usedSkills: validUsedSkills,
    skillPaths: validSkillPaths,
    evidenceCount,
    uses: uses.length ? uses : fallbackSkillUseEntries(text, validSkillPaths)
  };
}

function buildSkillUseEntries(
  traceText: string,
  skillPaths: string[]
): Array<{ skillName: string; skillPath: string; title: string; startStep: number; endStep: number; evidenceStep: number }> {
  const events = lightweightTraceEvents(traceText, skillPaths);
  if (!events.length) {
    return [];
  }
  const skillEvents = events.filter((event) => event.role === "skill");
  const userEvents = events.filter((event) => event.role === "user" && event.text.trim());
  const bounds = traceBounds(events);
  const uses: Array<{ skillName: string; skillPath: string; title: string; startStep: number; endStep: number; evidenceStep: number }> = [];
  const seenWindows = new Set<string>();
  for (const event of skillEvents) {
    const matchedSkillPaths = skillPaths.filter((skillPath) => lineMentionsSkill(event.text, skillPath));
    if (!matchedSkillPaths.length) {
      continue;
    }
    const nextUser = userEvents.find((candidate) => candidate.step > event.step);
    const endStep = nextUser ? nextUser.step - 1 : bounds.lastStep;
    const previousUser = [...userEvents].reverse().find((candidate) => candidate.step < event.step);
    matchedSkillPaths.forEach((skillPath) => {
      const skillName = skillNameFromPath(skillPath);
      const windowKey = `${skillPath}:${previousUser?.step ?? 0}:${nextUser?.step ?? "end"}`;
      if (seenWindows.has(windowKey)) {
        return;
      }
      seenWindows.add(windowKey);
      uses.push({
        skillName,
        skillPath,
        title: firstLine(previousUser?.text ?? skillName),
        startStep: event.step,
        endStep,
        evidenceStep: event.step
      });
    });
  }
  return uses;
}

function lineMentionsSkill(value: string, skillPath: string): boolean {
  const text = value.toLowerCase();
  const normalizedPath = skillPath.toLowerCase();
  const title = skillNameFromPath(skillPath).toLowerCase();
  const parent = path.basename(path.dirname(skillPath)).toLowerCase();
  return text.includes(normalizedPath) || text.includes(title) || text.includes(parent);
}

function titleForSkillUse(events: LightweightTraceEvent[], startStep: number, skillName: string): string {
  const previousUser = [...events]
    .reverse()
    .find((event) => event.step < startStep && event.role === "user" && event.text.trim());
  return firstLine(previousUser?.text ?? skillName);
}

function fallbackSkillUseEntries(
  traceText: string,
  skillPaths: string[]
): Array<{ skillName: string; skillPath: string; title: string; startStep: number; endStep: number; evidenceStep: number }> {
  const events = lightweightTraceEvents(traceText, skillPaths);
  const bounds = traceBounds(events);
  return skillPaths.map((skillPath) => {
    const skillName = skillNameFromPath(skillPath);
    return {
      skillName,
      skillPath,
      title: titleForSkillUse(events, bounds.firstStep, skillName),
      startStep: bounds.firstStep,
      endStep: bounds.lastStep,
      evidenceStep: bounds.firstStep
    };
  });
}

function lightweightTraceEvents(traceText: string, skillPaths: string[]): LightweightTraceEvent[] {
  const events: LightweightTraceEvent[] = [];
  const lines = traceText.split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    const step = index + 1;
    const userText = extractUserMessageText(line);
    if (userText) {
      events.push({ step, role: "user", text: userText });
    }
    if (isSkillUseEvidenceLine(line) && skillPaths.some((skillPath) => lineMentionsSkill(line, skillPath))) {
      events.push({ step, role: "skill", text: line });
    } else if (!userText) {
      events.push({ step, role: "other", text: "" });
    }
  });
  return events;
}

function traceBounds(events: LightweightTraceEvent[]): { firstStep: number; lastStep: number } {
  if (!events.length) {
    return { firstStep: 1, lastStep: 1 };
  }
  return {
    firstStep: events[0].step,
    lastStep: events[events.length - 1].step
  };
}

function firstUserTitle(events: LightweightTraceEvent[]): string | undefined {
  const user = events.find((event) => event.role === "user" && event.text.trim());
  return user ? firstLine(user.text) : undefined;
}

function extractUserMessageText(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const payload = objectValue(parsed.payload);
    if (payload && stringValue(payload.type) === "user_message") {
      return contentToText(payload.message ?? payload.content ?? payload.text_elements);
    }
    const message = objectValue(parsed.message);
    if (message && stringValue(message.role).toLowerCase() === "user") {
      return contentToText(message.content ?? message.text);
    }
    const role = stringValue(parsed.role ?? parsed.type).toLowerCase();
    if (role === "user" || role === "human" || role === "user_message") {
      return contentToText(parsed.content ?? parsed.message ?? parsed.text);
    }
  } catch {
    return "";
  }
  return "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function contentToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const object = objectValue(item);
        return object ? contentToText(object.text ?? object.content) : String(item ?? "");
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const object = objectValue(value);
  if (object) {
    return contentToText(object.text ?? object.content ?? object.message);
  }
  return "";
}

async function virtualBatchSkillForCwd(cwd: string): Promise<{ name: string; path: string } | null> {
  const normalized = cwd.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)(cia_(js|py|python|ts)_[^/]+)/i);
  if (!match) {
    return null;
  }
  const language = match[2].toLowerCase() === "py" || match[2].toLowerCase() === "python" ? "python" : "js";
  const name = language === "python" ? "cia-python-batch" : "cia-js-batch";
  const title = language === "python" ? "CIA Python Batch Skill" : "CIA JS Batch Skill";
  const skillDir = path.join(process.cwd(), ".skilllens", "virtual-skills", name);
  const skillPath = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) {
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      skillPath,
      `# ${title}\n\nUse this virtual skill for historical batch CIA experiments whose workspaces are named \`cia_${language === "python" ? "py" : "js"}_*\`.\n\n- Identify the changed anchor file and inspect direct structural dependents before proposing impacted files.\n- Search for importers, symbol users, tests, configuration references, fixtures, and sibling implementations related to the anchor change.\n- Keep the repository workspace unchanged unless the task explicitly asks for edits.\n- Report impacted files with concrete trace evidence from commands, file reads, or search results.\n- Treat final answers that omit evidence for impacted files as incomplete.\n`
    );
  }
  return { name, path: skillPath };
}

function isSkillUseEvidenceLine(line: string): boolean {
  if (!/(SKILL\.md|CLAUDE\.md|AGENTS\.md|\.skill\.md)/.test(line)) {
    return false;
  }
  const codexToolEvidence =
    /"type"\s*:\s*"function_call"/.test(line) || /"recipient_name"\s*:\s*"functions\.(?:exec_command|apply_patch|view_image)"/.test(line);
  const claudeToolEvidence = /"type"\s*:\s*"tool_use"/.test(line) && /"name"\s*:\s*"(?:Read|Bash|Grep|Glob)"/.test(line);
  if (!codexToolEvidence && !claudeToolEvidence) {
    return false;
  }
  return /\b(sed|cat|bat|less|more|head|tail|nl|open|read|rg|grep)\b/i.test(line);
}

function extractSkillLikePaths(text: string): string[] {
  const paths: string[] = [];
  const regex =
    /(?:file:\s*)?(~?\/[^\s"'`<>]+(?:SKILL\.md|CLAUDE\.md|AGENTS\.md|[A-Za-z0-9_.-]+\.skill\.md)|\.{1,2}\/[^\s"'`<>]+(?:SKILL\.md|CLAUDE\.md|AGENTS\.md|[A-Za-z0-9_.-]+\.skill\.md))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    paths.push(match[0].replace(/^file:\s*/, "").replace(/[),.;]+$/g, ""));
  }
  return paths.map((candidate) => (candidate.startsWith("~/") ? path.join(homeDir(), candidate.slice(2)) : candidate));
}

function resolveMaybeRelative(cwd: string, candidate: string): string {
  if (candidate.startsWith("~/")) {
    return path.join(homeDir(), candidate.slice(2));
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.resolve(cwd, candidate);
}

function skillNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parent = normalized.split("/").slice(-2, -1)[0] ?? "";
  return parent || path.basename(filePath);
}

function projectIdentityFromMeta(cwd: string, repositoryUrl?: string): { key: string; label: string } {
  const batch = batchSkillIdentityFromCwd(cwd);
  if (batch) {
    return batch;
  }
  if (repositoryUrl) {
    const normalizedUrl = repositoryUrl.replace(/\.git$/i, "").replace(/\/+$/g, "");
    return {
      key: `repo:${normalizedUrl}`,
      label: projectLabel(normalizedUrl)
    };
  }
  const bugsInPy = cwd.match(/\/bugsinpy_([^/]+?)_\d+\/buggy_checkout\/([^/]+)(?:\/|$)/);
  if (bugsInPy) {
    return {
      key: `bugsinpy:${bugsInPy[1]}`,
      label: bugsInPy[2]
    };
  }
  return {
    key: `cwd:${path.resolve(cwd)}`,
    label: projectLabel(cwd)
  };
}

function batchSkillIdentityFromCwd(cwd: string): { key: string; label: string } | null {
  const normalized = cwd.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)cia_(js|py|python|ts)_[^/]+/i);
  if (!match) {
    return null;
  }
  const language = match[1].toLowerCase() === "py" || match[1].toLowerCase() === "python" ? "python" : "js";
  return language === "python"
    ? { key: "skill:cia-python-batch", label: "CIA Python skill" }
    : { key: "skill:cia-js-batch", label: "CIA JS skill" };
}

function worktreeLabel(cwd: string, projectName: string): string {
  const normalized = cwd.replace(/\/+$/g, "");
  const bugsInPy = normalized.match(/\/(bugsinpy_[^/]+?_\d+)\/buggy_checkout\//);
  if (bugsInPy) {
    return bugsInPy[1];
  }
  const parent = path.basename(path.dirname(normalized));
  const base = path.basename(normalized);
  return base === projectName && parent ? parent : base;
}

function readFirstLine(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => {
      const newline = chunk.indexOf(10);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        stream.destroy();
        resolve(Buffer.concat(chunks).toString("utf8"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function readFileSlice(filePath: string, maxBytes: number): Promise<string> {
  const handle = await import("node:fs/promises").then((fs) => fs.open(filePath, "r"));
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "pipe",
      shell: process.platform === "win32"
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

function runCommandWithInput(
  command: string,
  args: string[],
  input: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      shell: process.platform === "win32"
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

function runCommandWithInputStream(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  hooks: AgentAnalysisHooks,
  paths?: { workDir?: string; promptPath?: string; rawOutputPath?: string; tracePath?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      shell: process.platform === "win32",
      detached: process.platform !== "win32"
    });
    const processId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const startedAt = new Date().toISOString();
    const processEvent: AgentProcessEvent = {
      id: processId,
      requestId: paths?.workDir ? path.basename(paths.workDir) : undefined,
      command,
      args,
      cwd,
      pid: child.pid,
      ppid: process.pid,
      pgid: process.platform !== "win32" ? child.pid : undefined,
      agentRootPid: child.pid,
      agentRootCommand: command === "claude" ? "claude" : command === "codex" ? "codex" : "unknown",
      agentRootLabel: command === "claude" || command === "codex" ? `${command} pid ${child.pid ?? "?"}` : undefined,
      association: command === "claude" || command === "codex" ? "self" : "unlinked",
      status: "started",
      startedAt,
      outputPath: paths?.rawOutputPath,
      promptPath: paths?.promptPath,
      tracePath: paths?.tracePath,
      ...traceStatFields(paths?.tracePath)
    };
    activeAgentProcesses.set(processId, { event: processEvent, child });
    hooks.onProcess?.(processEvent);
    hooks.onAgentText?.({
      stream: "stdout",
      text: `Started process pid=${child.pid ?? "unknown"}${processEvent.pgid ? ` pgid=${processEvent.pgid}` : ""}: ${command} ${args.join(" ")}`
    });
    const tracePoller =
      command === "codex" || command === "claude"
        ? setInterval(() => {
            void refreshAgentProcessTrace(processId, command, cwd, Date.parse(startedAt), hooks);
          }, 2200)
        : null;
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const flushStdoutLine = (line: string) => {
      if (!line.trim()) {
        return;
      }
      try {
        hooks.onAgentJson?.(sanitizeAgentStreamEvent(JSON.parse(line)));
      } catch {
        hooks.onAgentText?.({ stream: "stdout", text: line });
      }
    };
    const flushStderrLine = (line: string) => {
      if (line.trim()) {
        hooks.onAgentText?.({ stream: "stderr", text: line });
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      lines.forEach(flushStdoutLine);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      stderrBuffer += text;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      lines.forEach(flushStderrLine);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (tracePoller) {
        clearInterval(tracePoller);
      }
      flushStdoutLine(stdoutBuffer);
      flushStderrLine(stderrBuffer);
      const current = activeAgentProcesses.get(processId)?.event ?? processEvent;
      const finalEvent: AgentProcessEvent = {
        ...current,
        status: current.status === "killed" ? "killed" : code === 0 ? "exited" : "failed",
        endedAt: new Date().toISOString(),
        exitCode: code,
        signal: null,
        ...traceStatFields(current.tracePath)
      };
      activeAgentProcesses.delete(processId);
      hooks.onProcess?.(finalEvent);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

async function refreshAgentProcessTrace(
  processId: string,
  command: string,
  cwd: string,
  startedAfterMs: number,
  hooks: AgentAnalysisHooks
) {
  const active = activeAgentProcesses.get(processId);
  if (!active) {
    return;
  }
  const tracePath = active.event.tracePath ?? (await findRecentAgentTrace(command, cwd, startedAfterMs));
  if (!tracePath) {
    return;
  }
  const nextEvent: AgentProcessEvent = {
    ...active.event,
    status: active.event.status === "started" ? "running" : active.event.status,
    tracePath,
    ...traceStatFields(tracePath)
  };
  const changed =
    nextEvent.tracePath !== active.event.tracePath ||
    nextEvent.traceSize !== active.event.traceSize ||
    nextEvent.traceMtime !== active.event.traceMtime ||
    nextEvent.status !== active.event.status;
  if (!changed) {
    return;
  }
  active.event = nextEvent;
  activeAgentProcesses.set(processId, active);
  hooks.onProcess?.(nextEvent);
}

async function findRecentAgentTrace(command: string, cwd: string, startedAfterMs: number): Promise<string | undefined> {
  const root =
    command === "claude"
      ? path.join(process.env.CLAUDE_HOME || path.join(homeDir(), ".claude"), "projects")
      : path.join(process.env.CODEX_HOME || path.join(homeDir(), ".codex"), "sessions");
  if (!existsSync(root)) {
    return undefined;
  }
  const files = (await listJsonlFiles(root))
    .filter((file) => file.mtimeMs >= startedAfterMs - 5000)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 16);
  for (const file of files) {
    try {
      const head = await readTraceTail(file.path, 0, 12000);
      if (!cwd || head.content.includes(cwd) || command === "claude") {
        return file.path;
      }
    } catch {
      // Ignore disappearing traces while the agent process is starting.
    }
  }
  return files[0]?.path;
}

async function killAgentProcess(id: string | undefined, pid: number | undefined, pgid: number | undefined, signal: NodeJS.Signals) {
  const active = id ? activeAgentProcesses.get(id) : Array.from(activeAgentProcesses.values()).find((item) => item.event.pid === pid);
  if (!active && !pid) {
    throw new Error("process is not active");
  }
  const externalSnapshot = active ? undefined : await findProcessSnapshot(pid);
  const externalRoot = externalSnapshot ? findAgentRoot(externalSnapshot.snapshot, externalSnapshot.byPid) : null;
  if (!active && externalSnapshot && externalRoot) {
    const rootPid = externalRoot.snapshot.pid;
    const requestedGroup = externalSnapshot.snapshot.pgid;
    if (
      externalSnapshot.snapshot.pid === rootPid ||
      requestedGroup === rootPid ||
      isAgentRoot(externalSnapshot.snapshot)
    ) {
      throw new Error("refusing to stop an external Codex/Claude root process group");
    }
  }
  const targetPid = active?.event.pgid ?? externalSnapshot?.snapshot.pgid ?? pgid ?? active?.event.pid ?? pid;
  if (!targetPid) {
    throw new Error("process has no pid");
  }
  const dockerContainers = await findDockerContainersForProcess(active?.event.pid ?? pid, active?.event.pgid ?? externalSnapshot?.snapshot.pgid ?? pgid);
  const shouldKillGroup = process.platform !== "win32" && Boolean(active?.event.pgid ?? externalSnapshot?.snapshot.pgid ?? pgid);
  const killTarget = shouldKillGroup ? -targetPid : targetPid;
  try {
    process.kill(killTarget, signal);
  } catch (error) {
    if (!dockerContainers.length) {
      throw error;
    }
  }
  const stoppedDockerContainers = await stopDockerContainers(dockerContainers);
  if (!active) {
    return {
      id: String(pid),
      command: "external",
      args: [],
      cwd: "",
      pid,
      status: "killed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      signal,
      dockerContainers: stoppedDockerContainers,
      managedBySkillScope: false,
      canStop: false,
      canStopGroup: false
    } satisfies AgentProcessEvent;
  }
  active.event = {
    ...active.event,
    status: "killed",
    endedAt: new Date().toISOString(),
    signal,
    dockerContainers: uniqueStrings([...(active.event.dockerContainers ?? []), ...stoppedDockerContainers]),
    ...traceStatFields(active.event.tracePath)
  };
  activeAgentProcesses.set(active.event.id, active);
  return active.event;
}

async function listAgentProcesses(): Promise<{ processes: AgentProcessEvent[]; updatedAt: string }> {
  const active = Array.from(activeAgentProcesses.values()).map((item) =>
    withStopCapabilities({
      ...item.event,
      managedBySkillScope: true,
      ...traceStatFields(item.event.tracePath)
    })
  );
  if (process.platform === "win32") {
    return { processes: active, updatedAt: new Date().toISOString() };
  }
  const rows = await execFileText("ps", ["-eo", "pid=,ppid=,pgid=,stat=,etime=,args="]);
  const snapshots = rows
    .split(/\r?\n/)
    .map(parseProcessSnapshot)
    .filter((snapshot): snapshot is ProcessSnapshot => Boolean(snapshot));
  const byPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
  const external = (
    await Promise.all(
      snapshots
        .filter(isMonitorableProcess)
        .map((snapshot) => snapshotToAgentProcess(snapshot, byPid))
        .map((item) => enrichAgentProcessArtifacts(item.processEvent, item.snapshot))
    )
  )
    .filter((processEvent) => processEvent.agentRootPid && !active.some((item) => item.pid === processEvent.pid))
    .map((processEvent) => withStopCapabilities(processEvent));
  return {
    processes: [...active, ...external].sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1)),
    updatedAt: new Date().toISOString()
  };
}

function parseProcessSnapshot(row: string): ProcessSnapshot | null {
  const match = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const [, pidText, ppidText, pgidText, statText, elapsed, argsText] = match;
  const argv = splitCommandLine(argsText);
  const command = path.basename(argv[0] ?? argsText.split(/\s+/)[0] ?? "process");
  return {
    pid: Number(pidText),
    ppid: Number(ppidText),
    pgid: Number(pgidText),
    stat: statText,
    elapsed,
    argsText,
    argv,
    command,
    cwd: readProcessCwd(Number(pidText))
  };
}

async function findProcessSnapshot(pid: number | undefined): Promise<{ snapshot: ProcessSnapshot; byPid: Map<number, ProcessSnapshot> } | null> {
  if (!pid || process.platform === "win32") {
    return null;
  }
  const rows = await execFileText("ps", ["-eo", "pid=,ppid=,pgid=,stat=,etime=,args="]);
  const snapshots = rows
    .split(/\r?\n/)
    .map(parseProcessSnapshot)
    .filter((snapshot): snapshot is ProcessSnapshot => Boolean(snapshot));
  const byPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
  const snapshot = byPid.get(pid);
  return snapshot ? { snapshot, byPid } : null;
}

function isMonitorableProcess(snapshot: ProcessSnapshot): boolean {
  if (!/\b(codex|claude|bench|docker|pytest|vitest|npm|pnpm|yarn|python|node|uv|bash|sh)\b/i.test(snapshot.argsText)) {
    return false;
  }
  if (/SkillScope\/node_modules\/\.bin\/vite|rg agent-processes|ps -eo|cpuUsage\.sh/i.test(snapshot.argsText)) {
    return false;
  }
  return true;
}

function snapshotToAgentProcess(
  snapshot: ProcessSnapshot,
  byPid: Map<number, ProcessSnapshot>
): { processEvent: AgentProcessEvent; snapshot: ProcessSnapshot } {
  const root = findAgentRoot(snapshot, byPid);
  const processEvent: AgentProcessEvent = {
    id: `external-${snapshot.pid}`,
    command: snapshot.command,
    args: snapshot.argv.slice(1),
    cwd: snapshot.cwd ?? "",
    pid: snapshot.pid,
    ppid: snapshot.ppid,
    pgid: snapshot.pgid,
    agentRootPid: root?.snapshot.pid,
    agentRootCommand: root?.kind ?? "unknown",
    agentRootLabel: root ? `${root.kind} pid ${root.snapshot.pid}` : undefined,
    association: root ? root.association : "unlinked",
    status: snapshot.stat.includes("Z") ? "failed" : "running",
    startedAt: elapsedToStartedAt(snapshot.elapsed),
    outputPath: undefined,
    promptPath: undefined,
    artifactPaths: detectArtifactPaths(snapshot),
    dockerContainers: detectDockerContainers(snapshot.argsText),
    managedBySkillScope: false
  };
  return { processEvent, snapshot };
}

function withStopCapabilities(processEvent: AgentProcessEvent): AgentProcessEvent {
  const running = processEvent.status === "running" || processEvent.status === "started";
  if (!running) {
    return { ...processEvent, canStop: false, canStopGroup: false };
  }
  if (processEvent.managedBySkillScope) {
    return { ...processEvent, canStop: true, canStopGroup: true };
  }
  const externalAgentGroup =
    Boolean(processEvent.agentRootPid) &&
    (processEvent.pid === processEvent.agentRootPid ||
      processEvent.pgid === processEvent.agentRootPid ||
      processEvent.association === "self" ||
      processEvent.association === "process_group");
  return {
    ...processEvent,
    canStop: !externalAgentGroup,
    canStopGroup: false
  };
}

function findAgentRoot(
  snapshot: ProcessSnapshot,
  byPid: Map<number, ProcessSnapshot>
): { snapshot: ProcessSnapshot; kind: "codex" | "claude"; association: "ancestor" | "process_group" | "self" } | null {
  const groupRoot = bestProcessGroupAgentRoot(
    Array.from(byPid.values()).filter((candidate) => candidate.pgid === snapshot.pgid && candidate.pid !== snapshot.pid && isAgentRoot(candidate))
  );
  if (groupRoot) {
    return { snapshot: promoteAgentRoot(groupRoot, byPid), kind: agentKind(groupRoot), association: "process_group" };
  }

  const seen = new Set<number>();
  if (isAgentRoot(snapshot)) {
    const promoted = promoteAgentRoot(snapshot, byPid);
    return { snapshot: promoted, kind: agentKind(promoted), association: promoted.pid === snapshot.pid ? "self" : "ancestor" };
  }
  let current: ProcessSnapshot | undefined = snapshot;
  while (current?.ppid && !seen.has(current.ppid)) {
    seen.add(current.pid);
    const parent = byPid.get(current.ppid);
    if (!parent) {
      break;
    }
    if (isAgentRoot(parent)) {
      const promoted = promoteAgentRoot(parent, byPid);
      return { snapshot: promoted, kind: agentKind(promoted), association: "ancestor" };
    }
    current = parent;
  }
  return null;
}

function bestAgentRoot(candidates: ProcessSnapshot[]): ProcessSnapshot | null {
  return candidates.find((candidate) => /(^|\/)(node|nodejs)$/i.test(candidate.argv[0] ?? "")) ?? candidates[0] ?? null;
}

function bestProcessGroupAgentRoot(candidates: ProcessSnapshot[]): ProcessSnapshot | null {
  if (!candidates.length) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 2 && (candidates[0].ppid === candidates[1].pid || candidates[1].ppid === candidates[0].pid)) {
    return bestAgentRoot(candidates);
  }
  return null;
}

function promoteAgentRoot(snapshot: ProcessSnapshot, byPid: Map<number, ProcessSnapshot>): ProcessSnapshot {
  const parent = byPid.get(snapshot.ppid);
  return parent && isAgentRoot(parent) ? parent : snapshot;
}

function isAgentRoot(snapshot: ProcessSnapshot): boolean {
  if (/skillscope.*analyzer/i.test(snapshot.argsText)) {
    return false;
  }
  if (/^(codex|claude)$/i.test(snapshot.command)) {
    return true;
  }
  const first = snapshot.argv[0] ?? "";
  const second = snapshot.argv[1] ?? "";
  return /(^|\/)(node|nodejs|bash|sh)$/i.test(first) && /(^|\/)(codex|claude)$/.test(second);
}

function agentKind(snapshot: ProcessSnapshot): "codex" | "claude" {
  return /\bclaude\b/i.test(snapshot.argsText) ? "claude" : "codex";
}

async function enrichAgentProcessArtifacts(processEvent: AgentProcessEvent, snapshot: ProcessSnapshot): Promise<AgentProcessEvent> {
  const tracePath =
    processEvent.tracePath ??
    (processEvent.agentRootCommand === "codex" || /\bcodex\b/i.test(snapshot.argsText)
      ? await findCodexTraceForProcess(snapshot, processEvent.startedAt)
      : undefined);
  const artifactPaths = uniqueArtifacts([
    ...(processEvent.artifactPaths ?? []),
    ...(tracePath ? [{ label: "codex trace", path: tracePath }] : [])
  ]).map((artifact) => ({ ...artifact, ...artifactStatFields(artifact.path) }));
  return {
    ...processEvent,
    tracePath,
    ...(tracePath ? traceStatFields(tracePath) : {}),
    artifactPaths
  };
}

async function findCodexTraceForProcess(snapshot: ProcessSnapshot, startedAt: string): Promise<string | undefined> {
  const codexHome = process.env.CODEX_HOME || path.join(homeDir(), ".codex");
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) {
    return undefined;
  }
  const sessionIds = Array.from(snapshot.argsText.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)).map(
    (match) => match[0]
  );
  if (!sessionIds.length) {
    return undefined;
  }
  const startedMs = Date.parse(startedAt);
  const files = (await listJsonlFiles(sessionsRoot))
    .filter((file) => !Number.isFinite(startedMs) || file.mtimeMs >= startedMs - 20 * 60 * 1000)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 120);
  const exact = sessionIds.length ? files.find((file) => sessionIds.some((id) => file.path.includes(id))) : undefined;
  if (exact) {
    return exact.path;
  }
  const snippets = processMatchSnippets(snapshot);
  for (const file of files.slice(0, 50)) {
    try {
      const head = await readTraceTail(file.path, 0, 20000);
      const tailOffset = Math.max(0, head.size - 30000);
      const tail = tailOffset > 0 ? await readTraceTail(file.path, tailOffset, 30000) : head;
      const content = `${head.content}\n${tail.content}`;
      if ((snapshot.cwd && content.includes(snapshot.cwd)) || snippets.some((snippet) => content.includes(snippet))) {
        return file.path;
      }
    } catch {
      // Ignore traces that rotate or disappear while scanning.
    }
  }
  return undefined;
}

function processMatchSnippets(snapshot: ProcessSnapshot): string[] {
  return uniqueStrings(
    [
      ...snapshot.argv.filter((arg) => /[A-Za-z0-9_-]{8,}/.test(arg) && !arg.startsWith("/") && !arg.startsWith("--")),
      ...Array.from(snapshot.argsText.matchAll(/[A-Za-z0-9_.-]*skillscope[A-Za-z0-9_.-]*/gi)).map((match) => match[0])
    ].map((value) => value.slice(0, 96))
  ).slice(0, 8);
}

function detectArtifactPaths(snapshot: ProcessSnapshot): Array<{ label: string; path: string; size?: number; mtime?: string }> {
  const artifacts: Array<{ label: string; path: string; size?: number; mtime?: string }> = [];
  const cwd = snapshot.cwd || process.cwd();
  const add = (label: string, value: string | undefined) => {
    if (!value || value.startsWith("-")) {
      return;
    }
    const cleaned = value.replace(/^["']|["']$/g, "").replace(/[;,)]$/g, "");
    if (!/[./]/.test(cleaned)) {
      return;
    }
    const resolved = path.resolve(cwd, cleaned);
    if (existsSync(resolved)) {
      artifacts.push({ label, path: resolved });
    }
  };
  snapshot.argv.forEach((arg, index) => {
    if (/^(--out|--output|--output-last-message|--log|--log-file|--report|--report-out|-o)$/i.test(arg)) {
      add(arg.replace(/^-+/, ""), snapshot.argv[index + 1]);
    }
    const inline = arg.match(/^(--out|--output|--output-last-message|--log|--log-file|--report|--report-out)=([^ ]+)$/i);
    if (inline) {
      add(inline[1].replace(/^-+/, ""), inline[2]);
    }
    if (arg === ">" || arg === ">>") {
      add("redirect", snapshot.argv[index + 1]);
    }
    if (/\.(?:log|jsonl|json|txt|out|err|md)$/i.test(arg)) {
      add("file", arg);
    }
  });
  return uniqueArtifacts(artifacts).map((artifact) => ({ ...artifact, ...artifactStatFields(artifact.path) }));
}

function detectDockerContainers(argsText: string): string[] {
  const names = [
    ...Array.from(argsText.matchAll(/\b--name(?:=|\s+)([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\b/g)).map((match) => match[1]),
    ...Array.from(argsText.matchAll(/\bdocker\s+(?:container\s+)?(?:start|stop|rm)\s+(?:-[^\s]+\s+)*([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\b/g)).map(
      (match) => match[1]
    )
  ];
  return uniqueStrings(names.filter((name) => !name.startsWith("-")));
}

async function findDockerContainersForProcess(pid: number | undefined, pgid: number | undefined): Promise<string[]> {
  if (process.platform === "win32" || (!pid && !pgid)) {
    return [];
  }
  try {
    const rows = await execFileText("ps", ["-eo", "pid=,ppid=,pgid=,args="]);
    const names = rows
      .split(/\r?\n/)
      .map((row) => row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .filter((match) => Number(match[1]) === pid || Number(match[3]) === pgid)
      .flatMap((match) => detectDockerContainers(match[4]));
    return uniqueStrings(names);
  } catch {
    return [];
  }
}

async function stopDockerContainers(names: string[]): Promise<string[]> {
  const stopped: string[] = [];
  for (const name of uniqueStrings(names)) {
    try {
      await execFileText("docker", ["rm", "-f", name]);
      stopped.push(name);
    } catch {
      // Docker may be unavailable or the container may already be gone.
    }
  }
  return stopped;
}

function uniqueArtifacts(artifacts: Array<{ label: string; path: string; size?: number; mtime?: string }>) {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.path)) {
      return false;
    }
    seen.add(artifact.path);
    return true;
  });
}

function artifactStatFields(filePath: string): { size?: number; mtime?: string } {
  try {
    const info = statSync(filePath);
    return { size: info.size, mtime: info.mtime.toISOString() };
  } catch {
    return {};
  }
}

function readProcessCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

function splitCommandLine(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((item) => item.replace(/^["']|["']$/g, "")) ?? [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function elapsedToStartedAt(elapsed: string): string {
  const parts = elapsed.split("-");
  const days = parts.length > 1 ? Math.min(Number(parts[0]) || 0, 3650) : 0;
  const time = parts[parts.length - 1] ?? "0";
  const nums = time.split(":").map((item: string) => Number(item) || 0);
  const [hours, minutes, seconds] = nums.length === 3 ? nums : [0, nums[0] ?? 0, nums[1] ?? 0];
  const startedAt = new Date(Date.now() - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
  return Number.isFinite(startedAt.getTime()) ? startedAt.toISOString() : new Date().toISOString();
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function readTraceTail(tracePath: string, offset: number, maxBytes: number) {
  if (!tracePath) {
    throw new Error("path is required");
  }
  const resolved = path.resolve(tracePath);
  const info = await stat(resolved);
  const start = Math.max(0, Math.min(offset, info.size));
  const end = Math.min(info.size, start + Math.max(1024, Math.min(maxBytes, 250000)));
  const content =
    end > start
      ? await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const stream = createReadStream(resolved, { start, end: end - 1 });
          stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
          stream.on("error", reject);
          stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        })
      : "";
  return {
    path: resolved,
    offset: start,
    nextOffset: end,
    size: info.size,
    mtime: info.mtime.toISOString(),
    content
  };
}

function traceStatFields(tracePath: string | undefined): Pick<AgentProcessEvent, "traceSize" | "traceMtime"> {
  if (!tracePath || !existsSync(tracePath)) {
    return {};
  }
  try {
    const info = statSync(tracePath);
    return { traceSize: info.size, traceMtime: info.mtime.toISOString() };
  } catch {
    return {};
  }
}

function sanitizeAgentStreamEvent(value: unknown): unknown {
  return sanitizeUnknown(value, 0);
}

function sanitizeUnknown(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return truncateForStream(value, depth === 0 ? 2400 : 1800);
  }
  if (!value || typeof value !== "object" || depth > 8) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeUnknown(item, depth + 1));
  }
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => {
      if (typeof child === "string" && /aggregated_output|output|content|input|text|arguments/i.test(key)) {
        return [key, truncateForStream(child, key === "aggregated_output" || key === "output" ? 2200 : 1600)];
      }
      return [key, sanitizeUnknown(child, depth + 1)];
    })
  );
}

function truncateForStream(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n... [truncated for live view; full output is saved in agent-output.txt]` : value;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readRegistry() {
  const registryPath = path.join(process.cwd(), ".skilllens", "registry.json");
  if (!existsSync(registryPath)) {
    return {
      schemaVersion: "skilllens.registry.v1",
      updatedAt: new Date().toISOString(),
      captures: []
    };
  }
  try {
    return JSON.parse(await readFile(registryPath, "utf8"));
  } catch {
    return {
      schemaVersion: "skilllens.registry.v1",
      updatedAt: new Date().toISOString(),
      captures: []
    };
  }
}

async function sendJson(res: import("node:http").ServerResponse, value: unknown) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

function setupSse(res: import("node:http").ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function sendSse(res: import("node:http").ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendStatus(res: import("node:http").ServerResponse, statusCode: number, value: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

function numberFromQuery(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 96);
}

function projectLabel(cwd: string): string {
  const normalized = cwd.replace(/\/+$/g, "");
  return normalized.split("/").pop() || normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 12);
}
