import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptureBundle, CaptureRegistry, CoverageFinding } from "../src/lib/types";

interface AnalysisRunRow {
  key: string;
  captureId: string;
  segmentStartStep: number | null;
  segmentEndStep: number | null;
  analyzerVersion: string;
  updatedAt: string;
  resultJson: string;
}

interface FindingRow {
  analysisKey: string;
  status: CoverageFinding["status"];
  findingJson: string;
}

interface AggregatedFinding {
  key: string;
  text: string;
  status: CoverageFinding["status"];
  kind: string;
  line: string;
  instances: Array<{
    captureId: string;
    analysisKey: string;
    cwd: string;
    segment: string;
    evidenceEventIds: string[];
    confidence: number;
    rationale: string;
  }>;
}

async function main() {
  const root = process.cwd();
  const dbPath = path.join(root, ".skilllens", "skillscope.sqlite");
  const registryPath = path.join(root, ".skilllens", "registry.json");
  if (!existsSync(dbPath)) {
    throw new Error(`Missing analysis DB: ${dbPath}`);
  }
  if (!existsSync(registryPath)) {
    throw new Error(`Missing capture registry: ${registryPath}`);
  }

  const registry = JSON.parse(await readFile(registryPath, "utf8")) as CaptureRegistry;
  const runs = await sqliteJson<AnalysisRunRow>(
    dbPath,
    `SELECT key,
            capture_id AS captureId,
            segment_start_step AS segmentStartStep,
            segment_end_step AS segmentEndStep,
            analyzer_version AS analyzerVersion,
            updated_at AS updatedAt,
            result_json AS resultJson
       FROM analysis_runs
      ORDER BY updated_at DESC;`
  );
  const findings = await sqliteJson<FindingRow>(
    dbPath,
    `SELECT analysis_key AS analysisKey,
            status,
            finding_json AS findingJson
       FROM coverage_findings
      WHERE status IN ('violated', 'missed');`
  );

  const latestRuns = latestRunPerWindow(runs);
  const ciaRuns = await filterCiaRuns(root, registry, latestRuns);
  const ciaRunKeys = new Set(ciaRuns.map((run) => run.key));
  const findingsByRun = new Map<string, CoverageFinding[]>();
  findings
    .filter((row) => ciaRunKeys.has(row.analysisKey))
    .forEach((row) => {
      const current = findingsByRun.get(row.analysisKey) ?? [];
      current.push(JSON.parse(row.findingJson) as CoverageFinding);
      findingsByRun.set(row.analysisKey, current);
    });

  const aggregated = aggregateFindings(root, registry, ciaRuns, findingsByRun);
  const repeated = aggregated.filter((item) => distinctInstances(item).size >= 2);
  const report = {
    schemaVersion: "skillscope.cia-audit.v1",
    generatedAt: new Date().toISOString(),
    analyzedRuns: ciaRuns.length,
    riskyFindings: aggregated.reduce((sum, item) => sum + item.instances.length, 0),
    repeatedFindingGroups: repeated.length,
    groups: aggregated
  };

  const outDir = path.join(root, ".skilllens");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "cia-skill-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outDir, "cia-skill-audit.md"), formatMarkdown(report.groups, repeated, ciaRuns.length));

  console.log(`CIA cached analyses: ${ciaRuns.length}`);
  console.log(`Risk groups: ${aggregated.length}; repeated across instances: ${repeated.length}`);
  console.log("Wrote .skilllens/cia-skill-audit.json and .skilllens/cia-skill-audit.md");
  if (repeated.length) {
    console.log("Top repeated groups:");
    repeated.slice(0, 8).forEach((group, index) => {
      console.log(`${index + 1}. ${group.status} x${distinctInstances(group).size}: ${group.text.slice(0, 140)}`);
    });
  }
}

function latestRunPerWindow(runs: AnalysisRunRow[]): AnalysisRunRow[] {
  const selected = new Map<string, AnalysisRunRow>();
  runs.forEach((run) => {
    const key = `${run.captureId}:${run.segmentStartStep ?? ""}:${run.segmentEndStep ?? ""}`;
    if (!selected.has(key)) {
      selected.set(key, run);
    }
  });
  return Array.from(selected.values());
}

async function filterCiaRuns(root: string, registry: CaptureRegistry, runs: AnalysisRunRow[]): Promise<AnalysisRunRow[]> {
  const matches: AnalysisRunRow[] = [];
  for (const run of runs) {
    const entry = registry.captures.find((capture) => capture.id === run.captureId);
    if (!entry?.bundlePath || !existsSync(entry.bundlePath)) {
      continue;
    }
    const bundle = JSON.parse(await readFile(entry.bundlePath, "utf8")) as CaptureBundle;
    const cwd = bundle.task?.cwd ?? entry.cwd ?? "";
    const skillText = bundle.skills.map((skill) => `${skill.title} ${skill.path}`).join("\n");
    if (/cia[-_]|change impact|co-change|cia-graph-explore|\/cia_(js|py)_/i.test(`${cwd}\n${skillText}`)) {
      matches.push(run);
    }
  }
  return matches;
}

function aggregateFindings(
  root: string,
  registry: CaptureRegistry,
  runs: AnalysisRunRow[],
  findingsByRun: Map<string, CoverageFinding[]>
): AggregatedFinding[] {
  const groups = new Map<string, AggregatedFinding>();
  runs.forEach((run) => {
    const entry = registry.captures.find((capture) => capture.id === run.captureId);
    const bundlePath = entry?.bundlePath;
    const bundle = bundlePath && existsSync(bundlePath) ? safeBundle(bundlePath) : null;
    const cwd = bundle?.task?.cwd ?? entry?.cwd ?? "";
    const segment = `${run.segmentStartStep ?? "?"}-${run.segmentEndStep ?? "?"}`;
    for (const finding of findingsByRun.get(run.key) ?? []) {
      const text = finding.analyzedConstraint?.text ?? finding.rationale;
      const normalized = normalizeFindingText(text);
      if (!normalized) {
        continue;
      }
      const kind = finding.analyzedConstraint?.kind ?? "constraint";
      const span = finding.analyzedConstraint?.span;
      const line = span ? `${span.lineStart}-${span.lineEnd}` : "unknown";
      const key = `${finding.status}:${kind}:${normalized}`;
      const group = groups.get(key) ?? {
        key,
        text: text.trim(),
        status: finding.status,
        kind,
        line,
        instances: []
      };
      group.instances.push({
        captureId: run.captureId,
        analysisKey: run.key,
        cwd: path.relative(root, cwd).startsWith("..") ? cwd : path.relative(root, cwd) || cwd,
        segment,
        evidenceEventIds: finding.evidenceEventIds,
        confidence: finding.confidence,
        rationale: finding.rationale
      });
      groups.set(key, group);
    }
  });
  return Array.from(groups.values()).sort(
    (left, right) =>
      distinctInstances(right).size - distinctInstances(left).size ||
      right.instances.length - left.instances.length ||
      statusRank(right.status) - statusRank(left.status)
  );
}

function safeBundle(bundlePath: string): CaptureBundle | null {
  try {
    return JSON.parse(readFileSync(bundlePath, "utf8")) as CaptureBundle;
  } catch {
    return null;
  }
}

function distinctInstances(group: AggregatedFinding): Set<string> {
  return new Set(group.instances.map((item) => `${item.cwd}:${item.segment}`));
}

function statusRank(status: CoverageFinding["status"]): number {
  return status === "violated" ? 2 : status === "missed" ? 1 : 0;
}

function normalizeFindingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`[^`]+`/g, "`path`")
    .replace(/trace\.event\.\d+/g, "trace.event")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function formatMarkdown(groups: AggregatedFinding[], repeated: AggregatedFinding[], runCount: number): string {
  const lines = [
    "# CIA Skill Audit",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Cached CIA analysis windows: ${runCount}`,
    `Risk groups: ${groups.length}`,
    `Repeated risk groups: ${repeated.length}`,
    "",
    "This is an internal SkillScope audit artifact. It aggregates cached coverage findings to identify violated or ignored constraints that repeat across CIA instances.",
    "",
    "## Repeated Violated / Ignored Constraints",
    ""
  ];
  const selected = repeated.length ? repeated : groups.slice(0, 12);
  selected.slice(0, 24).forEach((group, index) => {
    lines.push(
      `### ${index + 1}. ${group.status} across ${distinctInstances(group).size} instance(s)`,
      "",
      `Constraint: ${group.text}`,
      "",
      `Kind: ${group.kind}; source lines: ${group.line}`,
      "",
      "Instances:"
    );
    group.instances.slice(0, 6).forEach((instance) => {
      lines.push(
        `- ${instance.cwd} (${instance.segment})`,
        `  - evidence: ${instance.evidenceEventIds.length ? instance.evidenceEventIds.join(", ") : "none"}`,
        `  - confidence: ${Math.round(instance.confidence * 100)}%`,
        `  - rationale: ${instance.rationale.replace(/\s+/g, " ").slice(0, 260)}`
      );
    });
    lines.push("");
  });
  return `${lines.join("\n")}\n`;
}

async function sqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const result = await runCommand("sqlite3", ["-batch", "-json", dbPath, sql]);
  const output = result.stdout.trim();
  return output ? (JSON.parse(output) as T[]) : [];
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with ${code}\n${stderr}`));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
