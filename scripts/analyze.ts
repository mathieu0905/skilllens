import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProject, createProjectFromCaptureBundle } from "../src/lib/project";
import { exportAnalysisJson, exportHtmlReport, generateMarkdownReport } from "../src/lib/report";
import { normalizeRecipe } from "../src/lib/analysisRecipe";
import type { CaptureBundle, ProjectResult, SkillLensProject } from "../src/lib/types";

interface CliOptions {
  skill?: string;
  trace?: string;
  bundle?: string;
  result?: string;
  task?: string;
  recipe?: string;
  out?: string;
  name?: string;
  source?: SkillLensProject["sourceType"];
  url?: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.bundle && (!options.skill || !options.trace)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const outDir = options.out ?? "skillscope-report";
  const project = options.bundle
    ? createProjectFromCaptureBundle(JSON.parse(await readFile(options.bundle, "utf8")) as CaptureBundle)
    : await createProjectFromFiles(options);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "analysis.json"), exportAnalysisJson(project));
  await writeFile(path.join(outDir, "report.md"), generateMarkdownReport(project));
  await writeFile(path.join(outDir, "report.html"), exportHtmlReport(project));

  const covered = project.findings.filter((finding) => finding.status === "covered").length;
  const risky = project.findings.filter((finding) => finding.status === "missed" || finding.status === "violated").length;
  console.log(`SkillScope analyzed ${project.units.length} skill units and ${project.events.length} trace events.`);
  console.log(`Trace format: ${project.traceFormat}`);
  console.log(`Covered: ${covered}; missed or violated: ${risky}`);
  console.log(`Wrote ${outDir}/analysis.json, ${outDir}/report.md, and ${outDir}/report.html`);
}

async function createProjectFromFiles(options: CliOptions) {
  const skillPath = options.skill as string;
  const tracePath = options.trace as string;
  const skill = await readFile(skillPath, "utf8");
  const trace = await readFile(tracePath, "utf8");
  const task = options.task ? await readFile(options.task, "utf8") : "";
  const result = options.result ? parseResult(await readFile(options.result, "utf8")) : {};
  const recipe = options.recipe ? normalizeRecipe(JSON.parse(await readFile(options.recipe, "utf8"))) : undefined;
  return createProject(
    options.name ?? path.basename(tracePath),
    skill,
    trace,
    result,
    options.source ?? "upload",
    task,
    options.url,
    recipe
  );
}

function parseResult(text: string): ProjectResult {
  try {
    return JSON.parse(text) as ProjectResult;
  } catch {
    return { source: "unparseable result.json", raw: text };
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2) as keyof CliOptions;
    if (key === "source") {
      options.source = normalizeSource(next);
      index += 1;
      continue;
    }
    if (["skill", "trace", "bundle", "result", "task", "recipe", "out", "name", "url"].includes(key)) {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function normalizeSource(value: string | undefined): SkillLensProject["sourceType"] {
  if (value === "demo" || value === "url" || value === "upload") {
    return value;
  }
  return "upload";
}

function printUsage() {
  console.log(`Usage:
  npm run analyze -- --skill SKILL.md --trace session.jsonl --out report/
  npm run analyze -- --bundle skillscope.capture.json --out report/

Options:
  --bundle  Path to a SkillScope capture bundle emitted by a plugin
  --skill   Path to SKILL.md or rules markdown
  --trace   Path to Codex, Claude Code, ACP, or generic JSONL trace
  --result  Optional result.json
  --task    Optional task markdown/text
  --recipe  Optional analysis recipe JSON
  --out     Output directory
  --name    Project name
  --source  upload | url | demo
  --url     Source URL metadata`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
