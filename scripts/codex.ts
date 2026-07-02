import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceText } from "../src/lib/traceParser";

interface CodexLaunchOptions {
  trace?: string;
  skill: string[];
  skillsDir: string[];
  task?: string;
  prompt?: string;
  result?: string;
  recipe?: string;
  out?: string;
  reportOut?: string;
  projectCwd?: string;
  sessionId?: string;
  model?: string;
  agentVersion?: string;
  analysisMethod?: "heuristic" | "llm_judge" | "hybrid";
  codexHome?: string;
  port: number;
  noOpen: boolean;
  analyze: boolean;
  maxSessionFiles: number;
  maxAutoSkills: number;
}

interface CodexSessionCandidate {
  path: string;
  mtimeMs: number;
  sessionId?: string;
  cwd?: string;
  cliVersion?: string;
  model?: string;
  modelProvider?: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectCwd = path.resolve(options.projectCwd ?? process.env.INIT_CWD ?? process.cwd());
  const codexHome = path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(homeDir(), ".codex"));
  const session = options.trace
    ? await sessionFromExplicitTrace(resolveFrom(projectCwd, options.trace))
    : await discoverCodexSession(codexHome, projectCwd, options.sessionId, options.maxSessionFiles);

  if (!session) {
    printNoSession(projectCwd, codexHome);
    process.exitCode = 1;
    return;
  }

  const traceContent = await readFile(session.path, "utf8");
  const autoSkillPaths = options.skill.length
    ? []
    : discoverSkillPathsFromTrace(traceContent, projectCwd, repoRoot, options.maxAutoSkills);
  const captureId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${shortHash(session.path)}`;
  const bundlePath = path.resolve(options.out ?? path.join(repoRoot, ".skilllens", "captures", captureId, "skilllens.capture.json"));
  const reportOut = path.resolve(options.reportOut ?? path.join(repoRoot, ".skilllens", "reports", captureId));

  await mkdir(path.dirname(bundlePath), { recursive: true });

  const captureArgs = [
    "run",
    "capture",
    "--",
    "--agent",
    "codex",
    "--source",
    "codex_plugin",
    "--cwd",
    projectCwd,
    "--project-cwd",
    projectCwd,
    "--registry-root",
    repoRoot,
    "--trace",
    session.path,
    "--out",
    bundlePath,
    "--session-id",
    options.sessionId ?? session.sessionId ?? path.basename(session.path)
  ];

  for (const skillPath of [...options.skill.map((value) => resolveFrom(projectCwd, value)), ...autoSkillPaths]) {
    captureArgs.push("--skill", skillPath);
  }
  for (const skillsDir of options.skillsDir) {
    captureArgs.push("--skills-dir", resolveFrom(projectCwd, skillsDir));
  }
  appendOptionalPath(captureArgs, "--task", options.task, projectCwd);
  appendOptionalPath(captureArgs, "--result", options.result, projectCwd);
  appendOptionalPath(captureArgs, "--recipe", options.recipe, projectCwd);
  appendOptional(captureArgs, "--prompt", options.prompt);
  appendOptional(captureArgs, "--model", options.model ?? session.model ?? session.modelProvider);
  appendOptional(captureArgs, "--agent-version", options.agentVersion ?? session.cliVersion);
  appendOptional(captureArgs, "--analysis-method", options.analysisMethod);

  console.log(`SkillLens Codex session: ${session.path}`);
  console.log(`Project cwd: ${projectCwd}`);
  if (autoSkillPaths.length) {
    console.log(`Auto-detected skill files: ${autoSkillPaths.join(", ")}`);
  } else if (!options.skill.length && !options.skillsDir.length) {
    console.log("No skill file was proven from tool traces; falling back to project skill discovery.");
  }

  await run("npm", captureArgs, repoRoot);

  if (options.analyze) {
    await run("npm", ["run", "analyze", "--", "--bundle", bundlePath, "--out", reportOut], repoRoot);
  }

  if (!options.noOpen && process.env.SKILLLENS_NO_OPEN !== "1") {
    await run("npm", ["run", "open", "--", "--port", String(options.port), "--capture", captureId], repoRoot);
  }

  console.log(`SkillLens bundle: ${bundlePath}`);
  if (options.analyze) {
    console.log(`SkillLens report: ${reportOut}`);
  }
}

function parseArgs(args: string[]): CodexLaunchOptions {
  const options: CodexLaunchOptions = {
    skill: [],
    skillsDir: [],
    port: 5173,
    noOpen: false,
    analyze: true,
    maxSessionFiles: 500,
    maxAutoSkills: 12
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (!arg.startsWith("--")) {
      continue;
    }
    switch (arg.slice(2)) {
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
      case "report-out":
        options.reportOut = next;
        index += 1;
        break;
      case "project-cwd":
        options.projectCwd = next;
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
      case "codex-home":
        options.codexHome = next;
        index += 1;
        break;
      case "port":
        options.port = Number.parseInt(next, 10) || options.port;
        index += 1;
        break;
      case "max-session-files":
        options.maxSessionFiles = Number.parseInt(next, 10) || options.maxSessionFiles;
        index += 1;
        break;
      case "max-auto-skills":
        options.maxAutoSkills = Number.parseInt(next, 10) || options.maxAutoSkills;
        index += 1;
        break;
      case "no-open":
        options.noOpen = true;
        break;
      case "no-analyze":
        options.analyze = false;
        break;
    }
  }

  return options;
}

async function discoverCodexSession(
  codexHome: string,
  projectCwd: string,
  sessionId: string | undefined,
  maxSessionFiles: number
): Promise<CodexSessionCandidate | null> {
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) {
    return null;
  }

  const files = (await listJsonlFiles(sessionsRoot))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxSessionFiles);

  if (sessionId) {
    for (const file of files) {
      if (file.path.includes(sessionId)) {
        return enrichSession(file);
      }
    }
  }

  const enriched: CodexSessionCandidate[] = [];
  for (const file of files) {
    const candidate = await enrichSession(file);
    if (candidate) {
      enriched.push(candidate);
    }
  }

  const normalizedProject = path.resolve(projectCwd);
  const cwdMatch = enriched.find((candidate) => candidate.cwd && path.resolve(candidate.cwd) === normalizedProject);
  if (cwdMatch) {
    return cwdMatch;
  }

  return enriched[0] ?? null;
}

async function sessionFromExplicitTrace(tracePath: string): Promise<CodexSessionCandidate> {
  const traceStat = await stat(tracePath);
  return (await enrichSession({ path: tracePath, mtimeMs: traceStat.mtimeMs })) ?? {
    path: tracePath,
    mtimeMs: traceStat.mtimeMs
  };
}

async function listJsonlFiles(root: string): Promise<CodexSessionCandidate[]> {
  const results: CodexSessionCandidate[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const fileStat = await stat(fullPath);
        results.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
      }
    }
  }
  await walk(root);
  return results;
}

async function enrichSession(candidate: CodexSessionCandidate): Promise<CodexSessionCandidate | null> {
  try {
    const firstLine = await readFirstLine(candidate.path);
    if (!firstLine) {
      return candidate;
    }
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: {
        session_id?: string;
        id?: string;
        cwd?: string;
        cli_version?: string;
        model?: string;
        model_provider?: string;
      };
    };
    const payload = parsed.payload ?? {};
    return {
      ...candidate,
      sessionId: payload.session_id ?? payload.id,
      cwd: payload.cwd,
      cliVersion: payload.cli_version,
      model: payload.model,
      modelProvider: payload.model_provider
    };
  } catch {
    return candidate;
  }
}

function discoverSkillPathsFromTrace(traceContent: string, projectCwd: string, root: string, limit: number): string[] {
  const events = parseTraceText(traceContent);
  const candidates = new Set<string>();
  for (const event of events) {
    if (!["command", "tool_call"].includes(event.type)) {
      continue;
    }
    if (!isLikelySkillReadEvent(event.name, event.content)) {
      continue;
    }
    for (const rawPath of extractSkillLikePaths(`${event.name ?? ""} ${event.content}`)) {
      const resolved = resolveFrom(projectCwd, rawPath.replace(/^file:/, ""));
      if (!existsSync(resolved)) {
        continue;
      }
      if (isInside(resolved, path.join(root, "integrations", "skilllens-codex"))) {
        continue;
      }
      candidates.add(resolved);
      if (candidates.size >= limit) {
        return Array.from(candidates);
      }
    }
  }
  return Array.from(candidates);
}

function isLikelySkillReadEvent(name: string | null, content: string): boolean {
  if (isSkillLensCommand(content)) {
    return false;
  }
  const lowerName = (name ?? "").toLowerCase();
  const lowerContent = content.toLowerCase();
  if (/\b(read|open)\b/.test(lowerName) && /(?:skill\.md|claude\.md|agents\.md|\.skill\.md)/i.test(content)) {
    return true;
  }
  return /\b(sed|cat|bat|less|more|head|tail|nl)\b/.test(lowerContent) ||
    /\b(rg|grep)\b[^;&|]*\b(?:skill\.md|claude\.md|agents\.md|\.skill\.md)\b/.test(lowerContent);
}

function isSkillLensCommand(content: string): boolean {
  return /\b(skilllens|capture-codex\.sh|npm\s+(?:--prefix\s+\S+\s+)?run\s+(?:codex|capture|analyze))\b/i.test(content);
}

function extractSkillLikePaths(text: string): string[] {
  const paths: string[] = [];
  const regex = /(?:file:\s*)?(~?\/[^\s"'`<>]+|\.{1,2}\/[^\s"'`<>]+|[A-Za-z0-9_.-]+\/[^\s"'`<>]+)?(?:SKILL\.md|CLAUDE\.md|AGENTS\.md|[A-Za-z0-9_.-]+\.skill\.md)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const value = match[0].replace(/^file:\s*/, "").replace(/[),.;]+$/g, "");
    paths.push(value);
  }
  return paths;
}

function readFirstLine(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start: 0, end: 128 * 1024 });
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

function appendOptional(args: string[], flag: string, value: string | undefined) {
  if (value) {
    args.push(flag, value);
  }
}

function appendOptionalPath(args: string[], flag: string, value: string | undefined, base: string) {
  if (value) {
    args.push(flag, resolveFrom(base, value));
  }
}

function resolveFrom(base: string, value: string): string {
  if (value.startsWith("~/")) {
    return path.join(homeDir(), value.slice(2));
  }
  return path.resolve(base, value);
}

function isInside(filePath: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeAnalysisMethod(value: string | undefined): CodexLaunchOptions["analysisMethod"] {
  if (value === "heuristic" || value === "llm_judge" || value === "hybrid") {
    return value;
  }
  return "heuristic";
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

function printNoSession(projectCwd: string, codexHome: string) {
  console.error("SkillLens could not identify a Codex session trace.");
  console.error(`Project cwd: ${projectCwd}`);
  console.error(`Codex home: ${codexHome}`);
  console.error("Run again with --trace /path/to/rollout-session.jsonl if this session is not under ~/.codex/sessions.");
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
