import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectTraceFormat, parseTraceText } from "../src/lib/traceParser";
import type {
  CaptureBundle,
  CapturedSessionSegment,
  CapturedSkillArtifact,
  CaptureRegistry,
  CaptureRegistryEntry,
  CaptureSource,
  ProjectResult
} from "../src/lib/types";

interface CaptureOptions {
  agent?: "codex" | "claude_code" | "unknown";
  source?: CaptureSource;
  trace?: string;
  skill: string[];
  skillsDir: string[];
  task?: string;
  prompt?: string;
  result?: string;
  out?: string;
  cwd?: string;
  projectCwd?: string;
  registryRoot?: string;
  sessionId?: string;
  model?: string;
  agentVersion?: string;
  analysisMethod?: "heuristic" | "llm_judge" | "hybrid";
  recipe?: string;
  open: boolean;
  maxDiscoveredSkills: number;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.trace) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectCwd = path.resolve(options.projectCwd ?? cwd);
  const registryRoot = path.resolve(options.registryRoot ?? cwd);
  const tracePath = path.resolve(cwd, options.trace);
  const traceContent = await readFile(tracePath, "utf8");
  const traceEvents = parseTraceText(traceContent);
  const skills = await collectSkills(options, cwd);
  const prompt = options.prompt ?? (options.task ? await readFile(path.resolve(cwd, options.task), "utf8") : undefined);
  const result = options.result ? parseResult(await readFile(path.resolve(cwd, options.result), "utf8")) : undefined;
  const agent = options.agent ?? inferAgentFromTrace(traceContent) ?? "unknown";
  const captureId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${shortHash(`${tracePath}\n${traceContent}`)}`;
  const recipe = options.recipe ? JSON.parse(await readFile(path.resolve(cwd, options.recipe), "utf8")) : undefined;
  const bundle: CaptureBundle = {
    schemaVersion: "skilllens.capture.v1",
    source: options.source ?? (agent === "codex" ? "codex_plugin" : agent === "claude_code" ? "claude_code_plugin" : "manual_upload"),
    createdAt: new Date().toISOString(),
    agent: {
      product: agent,
      version: options.agentVersion,
      model: options.model
    },
    task: {
      id: options.sessionId ?? path.basename(tracePath),
      prompt,
      cwd: projectCwd
    },
    skills,
    trace: {
      id: options.sessionId ?? `trace-${shortHash(traceContent)}`,
      path: tracePath,
      format: detectTraceFormat(traceContent),
      content: traceContent,
      sessionId: options.sessionId,
      sha256: sha256(traceContent),
      segments: segmentTrace(traceEvents, prompt, skills)
    },
    result,
    analysis: {
      method: options.analysisMethod ?? "heuristic",
      recipe,
      notes:
        "Capture provenance is plugin-first. Coverage analysis is local heuristic unless a later LLM judge pass is configured."
    }
  };

  const outPath = options.out
    ? path.resolve(cwd, options.out)
    : path.join(registryRoot, ".skilllens", "captures", captureId, "skilllens.capture.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
  await updateRegistry(registryRoot, outPath, captureId, bundle);

  const loadedCount = skills.filter((skill) => skill.loaded).length;
  const discoveredCount = skills.length - loadedCount;
  console.log(`SkillLens captured ${loadedCount} loaded skill artifact(s), ${discoveredCount} discovered artifact(s), and 1 trace.`);
  console.log(`Trace format: ${bundle.trace.format}`);
  console.log(`Session segments: ${bundle.trace.segments?.length ?? 0}`);
  console.log(`Wrote ${outPath}`);
  console.log(`Registered ${path.join(registryRoot, ".skilllens", "registry.json")}`);
}

async function collectSkills(options: CaptureOptions, cwd: string): Promise<CapturedSkillArtifact[]> {
  const explicit = await Promise.all(
    options.skill.map((skillPath, index) => readSkillArtifact(path.resolve(cwd, skillPath), true, "explicit --skill argument", index))
  );
  const seen = new Set(explicit.map((skill) => path.resolve(skill.path)));
  const discovered: CapturedSkillArtifact[] = [];

  for (const dir of options.skillsDir) {
    const resolved = path.resolve(cwd, dir);
    const files = await findSkillFiles(resolved, options.maxDiscoveredSkills);
    for (const file of files) {
      const real = path.resolve(file);
      if (!seen.has(real)) {
        discovered.push(
          await readSkillArtifact(real, true, `explicit --skills-dir ${resolved}`, explicit.length + discovered.length)
        );
        seen.add(real);
      }
    }
  }

  if (!explicit.length && !options.skillsDir.length) {
    const defaults = [
      path.join(cwd, "SKILL.md"),
      path.join(cwd, "CLAUDE.md"),
      path.join(cwd, "AGENTS.md"),
      path.join(cwd, ".codex", "skills"),
      path.join(cwd, ".claude", "skills")
    ];
    for (const candidate of defaults) {
      if (!existsSync(candidate)) {
        continue;
      }
      const candidateStat = await stat(candidate);
      if (candidateStat.isDirectory()) {
        const files = await findSkillFiles(candidate, options.maxDiscoveredSkills - discovered.length);
        for (const file of files) {
          const real = path.resolve(file);
          if (!seen.has(real)) {
            discovered.push(
              await readSkillArtifact(real, false, "discovered in project; plugin did not confirm it was loaded", discovered.length)
            );
            seen.add(real);
          }
        }
      } else if (!seen.has(path.resolve(candidate))) {
        discovered.push(
          await readSkillArtifact(
            candidate,
            false,
            "discovered in project root; plugin did not confirm it was loaded",
            discovered.length
          )
        );
        seen.add(path.resolve(candidate));
      }
    }
  }

  return [...explicit, ...discovered];
}

async function readSkillArtifact(filePath: string, loaded: boolean, loadReason: string, index: number): Promise<CapturedSkillArtifact> {
  const content = await readFile(filePath, "utf8");
  return {
    id: `skill-artifact-${String(index + 1).padStart(3, "0")}`,
    kind: inferSkillKind(filePath),
    path: filePath,
    title: inferTitle(content, filePath),
    content,
    sha256: sha256(content),
    loaded,
    loadReason
  };
}

async function findSkillFiles(root: string, limit: number): Promise<string[]> {
  if (limit <= 0 || !existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  async function walk(dir: string) {
    if (files.length >= limit) {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit || entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (isSkillLikeFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

function isSkillLikeFile(filename: string): boolean {
  return filename === "SKILL.md" || filename === "CLAUDE.md" || filename === "AGENTS.md" || filename.endsWith(".skill.md");
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

function parseArgs(args: string[]): CaptureOptions {
  const options: CaptureOptions = {
    skill: [],
    skillsDir: [],
    open: false,
    maxDiscoveredSkills: 80
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (!arg.startsWith("--")) {
      continue;
    }
    switch (arg.slice(2)) {
      case "agent":
        options.agent = normalizeAgent(next);
        index += 1;
        break;
      case "source":
        options.source = normalizeSource(next);
        index += 1;
        break;
      case "trace":
        options.trace = next;
        index += 1;
        break;
      case "skill":
        options.skill.push(next);
        index += 1;
        break;
      case "skills-dir":
        options.skillsDir.push(next);
        index += 1;
        break;
      case "task":
        options.task = next;
        index += 1;
        break;
      case "prompt":
        options.prompt = next;
        index += 1;
        break;
      case "result":
        options.result = next;
        index += 1;
        break;
      case "recipe":
        options.recipe = next;
        index += 1;
        break;
      case "out":
        options.out = next;
        index += 1;
        break;
      case "cwd":
        options.cwd = next;
        index += 1;
        break;
      case "project-cwd":
        options.projectCwd = next;
        index += 1;
        break;
      case "registry-root":
        options.registryRoot = next;
        index += 1;
        break;
      case "session-id":
        options.sessionId = next;
        index += 1;
        break;
      case "model":
        options.model = next;
        index += 1;
        break;
      case "agent-version":
        options.agentVersion = next;
        index += 1;
        break;
      case "analysis-method":
        options.analysisMethod = normalizeAnalysisMethod(next);
        index += 1;
        break;
      case "max-discovered-skills":
        options.maxDiscoveredSkills = Number.parseInt(next, 10) || options.maxDiscoveredSkills;
        index += 1;
        break;
      case "open":
        options.open = true;
        break;
    }
  }
  return options;
}

function normalizeAgent(value: string | undefined): CaptureOptions["agent"] {
  if (value === "codex" || value === "claude_code" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function normalizeSource(value: string | undefined): CaptureSource {
  if (value === "codex_plugin" || value === "claude_code_plugin" || value === "manual_upload" || value === "skillsbench") {
    return value;
  }
  return "manual_upload";
}

function normalizeAnalysisMethod(value: string | undefined): CaptureOptions["analysisMethod"] {
  if (value === "heuristic" || value === "llm_judge" || value === "hybrid") {
    return value;
  }
  return "heuristic";
}

function inferAgentFromTrace(traceContent: string): CaptureOptions["agent"] {
  const format = detectTraceFormat(traceContent);
  if (format === "codex") {
    return "codex";
  }
  if (format === "claude_code") {
    return "claude_code";
  }
  return "unknown";
}

function parseResult(text: string): ProjectResult {
  try {
    return JSON.parse(text) as ProjectResult;
  } catch {
    return { source: "unparseable result.json", raw: text };
  }
}

function segmentTrace(
  events: ReturnType<typeof parseTraceText>,
  prompt: string | undefined,
  skills: CapturedSkillArtifact[]
): CapturedSessionSegment[] {
  if (!events.length) {
    return [];
  }
  const skillWindows = segmentSkillUsageWindows(events, prompt, skills);
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
      notes: "Segment inferred from user message boundary. Review if this session contained planning chatter or task switching."
    };
  });
}

function segmentSkillUsageWindows(
  events: ReturnType<typeof parseTraceText>,
  prompt: string | undefined,
  skills: CapturedSkillArtifact[]
): CapturedSessionSegment[] {
  if (!skills.length) {
    return [];
  }

  const segments: CapturedSessionSegment[] = [];
  let cursorStep = events[0]?.step ?? 1;
  while (cursorStep <= events[events.length - 1].step) {
    const startEvent = events.find((event) => event.step >= cursorStep && skillIdsForEvent(event, skills).length);
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
      .forEach((event) => skillIdsForEvent(event, skills).forEach((id) => ids.add(id)));
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

function skillIdsForEvent(event: ReturnType<typeof parseTraceText>[number], skills: CapturedSkillArtifact[]): string[] {
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

async function updateRegistry(cwd: string, bundlePath: string, id: string, bundle: CaptureBundle) {
  const registryPath = path.join(cwd, ".skilllens", "registry.json");
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

function firstLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 96);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 12);
}

function printUsage() {
  console.log(`Usage:
  npm run capture -- --agent codex --trace session.jsonl --skill SKILL.md --out skilllens.capture.json
  npm run capture -- --agent claude_code --trace transcript.jsonl --skills-dir .claude/skills --out skilllens.capture.json

Options:
  --agent                  codex | claude_code | unknown
  --trace                  Path to the session trace JSONL/JSON
  --skill                  Loaded skill/rule file. Repeatable. Marked loaded=true.
  --skills-dir             Directory of loaded skill files. Repeatable. Marked loaded=true.
  --task                   Optional task prompt file
  --prompt                 Optional task prompt text
  --result                 Optional result.json
  --recipe                 Optional analysis recipe JSON
  --out                    Output bundle path
  --cwd                    Working directory for relative paths
  --project-cwd            Original project cwd to preserve in bundle metadata
  --registry-root          Directory whose .skilllens/registry.json should be updated
  --session-id             Session/task identifier
  --model                  Model name metadata
  --agent-version          Agent version metadata
  --analysis-method        heuristic | llm_judge | hybrid
  --max-discovered-skills  Discovery cap when no explicit skill is supplied
  --open                   Reserved for plugin wrappers; capture itself only writes the bundle`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
