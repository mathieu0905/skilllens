import type { CoverageFinding, SkillLensProject, SkillUnit, TraceEvent } from "./types";
import { summarizeCoverage } from "./coverage";
import { truncate } from "./text";

export function generateMarkdownReport(project: SkillLensProject): string {
  const summary = summarizeCoverage(project.findings);
  const byStatus = (status: CoverageFinding["status"]) =>
    project.findings
      .filter((finding) => finding.status === status)
      .sort((a, b) => b.confidence - a.confidence);

  const useful = byStatus("covered").slice(0, 3);
  const ignored = byStatus("missed").slice(0, 3);
  const violated = byStatus("violated").slice(0, 3);
  const lowObservable = project.units.filter((unit) => !unit.observable).slice(0, 3);

  const lines = [
    `# SkillScope Report: ${project.name}`,
    "",
    `Source: ${project.sourceType}`,
    `Result: ${formatResult(project.result.success)}${typeof project.result.score === "number" ? `, score ${project.result.score}` : ""}`,
    `Followed: ${percent(summary.coverageRate)} (${summary.counts.covered}/${summary.applicable} applicable units)`,
    `Violated: ${summary.counts.violated}`,
    `Ignored: ${summary.counts.missed}`,
    `Average confidence: ${percent(summary.averageConfidence)}`,
    "",
    "## Status Summary",
    "",
    `- Followed: ${summary.counts.covered}`,
    `- Ignored: ${summary.counts.missed}`,
    `- Violated: ${summary.counts.violated}`,
    `- Not taken / not applicable: ${summary.counts.not_applicable}`,
    `- Unknown: ${summary.counts.unknown}`,
    "",
    "## Followed Instructions",
    "",
    ...formatFindingList(useful, project),
    "",
    "## Ignored Instructions",
    "",
    ...formatFindingList(ignored, project),
    "",
    "## Violated Instructions",
    "",
    ...formatFindingList(violated, project),
    "",
    "## Low-Observability Instructions",
    "",
    ...formatUnitList(lowObservable),
    "",
    "## Rewrite Suggestions",
    "",
    ...project.findings
      .filter((finding) => finding.suggestedRewrite)
      .slice(0, 5)
      .flatMap((finding) => {
        const unit = project.units.find((candidate) => candidate.id === finding.unitId);
        return [
          `- ${unit ? truncate(unit.text, 120) : finding.unitId}`,
          `  Suggestion: ${finding.suggestedRewrite}`
        ];
      })
  ];

  return lines.join("\n");
}

export function exportAnalysisJson(project: SkillLensProject): string {
  return JSON.stringify(
    {
      project: {
        id: project.id,
        name: project.name,
        sourceType: project.sourceType,
        sourceUrl: project.sourceUrl,
        result: project.result,
        createdAt: project.createdAt
      },
      skill_units: project.units,
      trace_events: project.events,
      coverage_findings: project.findings,
      summary: summarizeCoverage(project.findings)
    },
    null,
    2
  );
}

export function exportHtmlReport(project: SkillLensProject): string {
  const summary = summarizeCoverage(project.findings);
  const rows = project.findings
    .map((finding) => {
      const unit = project.units.find((candidate) => candidate.id === finding.unitId);
      const evidence = finding.evidenceEventIds
        .map((id) => project.events.find((event) => event.id === id))
        .filter(Boolean) as TraceEvent[];
      return `<tr>
        <td><span class="status ${finding.status}">${statusLabel(finding.status)}</span></td>
        <td>${escapeHtml(unit?.text ?? finding.unitId)}</td>
        <td>${Math.round(finding.confidence * 100)}%</td>
        <td>${escapeHtml(evidence.map((event) => `${event.id}: ${truncate(event.content || event.output, 140)}`).join(" | "))}</td>
        <td>${escapeHtml(finding.rationale)}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>SkillScope Report - ${escapeHtml(project.name)}</title>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #17202a; }
    h1 { margin-bottom: 4px; }
    .summary { display: flex; gap: 12px; flex-wrap: wrap; margin: 20px 0; }
    .metric { border: 1px solid #d8dee9; border-radius: 8px; padding: 12px 14px; min-width: 150px; }
    .metric strong { display: block; font-size: 24px; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border-bottom: 1px solid #e5e9f0; text-align: left; padding: 10px; vertical-align: top; }
    th { background: #f6f8fb; }
    .status { border-radius: 999px; color: white; padding: 2px 8px; font-size: 12px; }
    .covered { background: #2f855a; }
    .missed { background: #c05621; }
    .violated { background: #c53030; }
    .not_applicable { background: #718096; }
    .unknown { background: #2b6cb0; }
  </style>
</head>
<body>
  <h1>SkillScope Report</h1>
  <p>${escapeHtml(project.name)} · Like code coverage, but for agent skills.</p>
  <section class="summary">
    <div class="metric"><span>Followed</span><strong>${summary.counts.covered}</strong></div>
    <div class="metric"><span>Violated</span><strong>${summary.counts.violated}</strong></div>
    <div class="metric"><span>Ignored</span><strong>${summary.counts.missed}</strong></div>
    <div class="metric"><span>Applicable units</span><strong>${summary.applicable}</strong></div>
    <div class="metric"><span>Events</span><strong>${project.events.length}</strong></div>
  </section>
  <table>
    <thead><tr><th>Status</th><th>Instruction</th><th>Confidence</th><th>Evidence</th><th>Rationale</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function formatFindingList(findings: CoverageFinding[], project: SkillLensProject): string[] {
  if (!findings.length) {
    return ["- None."];
  }
  return findings.flatMap((finding) => {
    const unit = project.units.find((candidate) => candidate.id === finding.unitId);
    const evidence = finding.evidenceEventIds
      .map((id) => project.events.find((event) => event.id === id))
      .filter(Boolean) as TraceEvent[];
    return [
      `- ${statusLabel(finding.status)} (${percent(finding.confidence)}): ${unit ? truncate(unit.text, 140) : finding.unitId}`,
      `  Evidence: ${evidence.length ? evidence.map((event) => `${event.id} ${truncate(event.content || event.output, 100)}`).join("; ") : "No direct span."}`
    ];
  });
}

function statusLabel(status: CoverageFinding["status"]): string {
  const labels: Record<CoverageFinding["status"], string> = {
    covered: "Followed",
    missed: "Ignored",
    violated: "Violated",
    not_applicable: "Not taken",
    unknown: "Unknown"
  };
  return labels[status];
}

function formatUnitList(units: SkillUnit[]): string[] {
  if (!units.length) {
    return ["- None."];
  }
  return units.map((unit) => `- Lines ${unit.lineStart}-${unit.lineEnd}: ${truncate(unit.text, 150)}`);
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatResult(success: unknown): string {
  if (success === true) {
    return "success";
  }
  if (success === false) {
    return "failure";
  }
  return "unknown";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
