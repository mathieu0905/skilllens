import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

interface ScreenshotEvidence {
  feature: string;
  assertion: string;
  screenshot: string;
  capturedAt: string;
}

interface EvidenceManifest {
  runId?: string;
  baseUrl?: string;
  screenshotDir?: string;
  requiredFeatures?: string[];
  evidenceCount?: number;
  evidence?: ScreenshotEvidence[];
}

const root = process.cwd();
const screenshotRoot = path.join(root, ".skilllens", "monitor-smoke-screenshots");
const baseEvidenceFeatures = [
  "job-room-shell",
  "job-room-task-language",
  "top-metrics-state",
  "job-list-summary",
  "active-job-card",
  "primary-stop-action",
  "single-stop-action",
  "job-source-context",
  "job-source-command-clamp",
  "job-card-latest-clamp",
  "job-runtime-display",
  "artifact-copy-actions",
  "artifact-output-copy",
  "job-search",
  "job-search-clear",
  "empty-state-navigation",
  "job-sort",
  "live-refresh-toggle",
  "job-progress-and-artifact-tail",
  "safe-stop-preview",
  "safe-stop-result",
  "stop-result-copy",
  "stopped-job-focused",
  "artifact-readable-label",
  "recent-history",
  "issues-filter",
  "attention-sort",
  "stale-job-filter"
];
const dockerEvidenceFeatures = [
  "docker-job-filter",
  "docker-artifact-container-detail",
  "docker-stop-preview",
  "docker-stop-result",
  "docker-codex-exec-job-filter",
  "docker-codex-exec-detail",
  "docker-codex-exec-stop-preview",
  "docker-codex-exec-stop-result"
];

async function main() {
  const explicitPath = process.argv.find((arg) => arg.endsWith(".json"));
  const evidencePath = explicitPath ? path.resolve(explicitPath) : await latestEvidencePath();
  const manifest = JSON.parse(await readFile(evidencePath, "utf8")) as EvidenceManifest;
  const requireDocker = process.argv.includes("--docker");
  const requiredFeatures = requireDocker
    ? [...baseEvidenceFeatures, ...dockerEvidenceFeatures]
    : manifest.requiredFeatures?.length
      ? manifest.requiredFeatures
      : baseEvidenceFeatures;

  const evidence = manifest.evidence ?? [];
  const byFeature = new Map(evidence.map((item) => [item.feature, item]));
  const missing = requiredFeatures.filter((feature) => !byFeature.has(feature));
  if (missing.length) {
    throw new Error(`missing screenshot evidence: ${missing.join(", ")}`);
  }
  if (typeof manifest.evidenceCount === "number" && manifest.evidenceCount !== evidence.length) {
    throw new Error(`evidenceCount mismatch: manifest=${manifest.evidenceCount}, actual=${evidence.length}`);
  }

  for (const item of evidence) {
    if (!item.feature || !item.assertion || !item.screenshot || !item.capturedAt) {
      throw new Error(`incomplete evidence entry: ${JSON.stringify(item)}`);
    }
    const resolved = path.isAbsolute(item.screenshot)
      ? item.screenshot
      : path.resolve(path.dirname(evidencePath), item.screenshot);
    const info = await stat(resolved).catch(() => null);
    if (!info || info.size <= 0) {
      throw new Error(`missing or empty screenshot for ${item.feature}: ${resolved}`);
    }
  }

  console.log(`monitor evidence ok: ${evidencePath}`);
  console.log(`features verified: ${requiredFeatures.length}`);
  console.log(`screenshots checked: ${evidence.length}`);
  if (manifest.screenshotDir) {
    console.log(`screenshots: ${manifest.screenshotDir}`);
  }
}

async function latestEvidencePath(): Promise<string> {
  if (!existsSync(screenshotRoot)) {
    throw new Error(`screenshot root not found: ${screenshotRoot}`);
  }
  const entries = await readdir(screenshotRoot, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const evidencePath = path.join(screenshotRoot, entry.name, "evidence.json");
        const info = await stat(evidencePath).catch(() => null);
        return info ? { evidencePath, mtimeMs: info.mtimeMs } : null;
      })
  );
  const latest = candidates
    .filter((candidate): candidate is { evidencePath: string; mtimeMs: number } => Boolean(candidate))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) {
    throw new Error(`no evidence.json found under ${screenshotRoot}`);
  }
  return latest.evidencePath;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
