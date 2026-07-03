import type { CoverageFinding, CoverageStatus, SkillLensProject, SkillUnit, TraceEvent } from "./types";
import { summarizeCoverage } from "./coverage";
import { truncate } from "./text";

export interface ImproveMetrics {
  counts: Record<CoverageStatus, number>;
  totalConstraints: number;
  applicableConstraints: number;
  applicableAdherenceRate: number;
  evidenceCoverageRate: number;
  unknownRate: number;
  violationRate: number;
  skillInvocationObserved: boolean;
  passRate: number | null;
  score: number | null;
  noSkillScore: number | null;
  skillLift: number | null;
}

export interface FailurePattern {
  id: string;
  label: string;
  count: number;
  findingIds: string[];
  patchType: string;
  rationale: string;
}

export interface PatchEvidence {
  constraint_id: string;
  source_span: string;
  judgment: CoverageFinding["status"];
  evidence_events: string[];
  failure_pattern: string;
  patch_type: string;
  proposed_edit: string;
  risk: string;
}

export interface PatchProposal {
  optimizedSkill: string;
  patchMarkdown: string;
  rationaleMarkdown: string;
  evidence: PatchEvidence[];
  diff: string;
}

export function computeImproveMetrics(project: SkillLensProject, noSkillResult?: Record<string, unknown>): ImproveMetrics {
  const summary = summarizeCoverage(project.findings);
  const judged = summary.counts.covered + summary.counts.violated + summary.counts.missed;
  const score = numericScore(project.result);
  const noSkillScore = noSkillResult ? numericScore(noSkillResult) : null;
  return {
    counts: summary.counts,
    totalConstraints: summary.total,
    applicableConstraints: summary.applicable,
    applicableAdherenceRate: judged ? summary.counts.covered / judged : 0,
    evidenceCoverageRate: summary.total ? judged / summary.total : 0,
    unknownRate: summary.total ? summary.counts.unknown / summary.total : 0,
    violationRate: judged ? summary.counts.violated / judged : 0,
    skillInvocationObserved: hasSkillInvocation(project.events, project.skillMarkdown),
    passRate: booleanSuccess(project.result),
    score,
    noSkillScore,
    skillLift: score !== null && noSkillScore !== null ? score - noSkillScore : null
  };
}

export function buildFailureTaxonomy(project: SkillLensProject): FailurePattern[] {
  const buckets = new Map<string, FailurePattern>();
  const add = (key: string, label: string, finding: CoverageFinding, patchType: string, rationale: string) => {
    const existing =
      buckets.get(key) ??
      ({
        id: key,
        label,
        count: 0,
        findingIds: [],
        patchType,
        rationale
      } satisfies FailurePattern);
    existing.count += 1;
    existing.findingIds.push(finding.id);
    buckets.set(key, existing);
  };

  for (const finding of project.findings) {
    if (!["missed", "violated", "unknown"].includes(finding.status)) {
      continue;
    }
    const unit = unitFor(project.units, finding);
    const text = `${unit?.headingPath.join(" ") ?? ""} ${constraintText(project, finding)}`.toLowerCase();
    if (finding.status === "violated") {
      add("violated-prohibition", "Prohibition or output contract was violated", finding, "adjacent-prohibition-alternative", "Make the prohibited behavior and the required alternative adjacent and observable.");
    } else if (/script|validate|verification|test|pytest|npm test|check/.test(text)) {
      add("skipped-validation", "Validation or script step was missed", finding, "pre-submit-checklist", "Move validation into a short before-final checklist with the exact command or script name.");
    } else if (/json|schema|format|final answer|output|response/.test(text)) {
      add("output-contract-late", "Output contract was missed or hard to observe", finding, "front-loaded-output-contract", "Place the final output contract before long workflow details and require parse or schema evidence.");
    } else if (finding.status === "unknown" || unit?.observable === false) {
      add("low-observability", "Instruction is hard to observe in trajectory evidence", finding, "observable-artifact-contract", "Rewrite vague instructions as concrete artifacts, tool calls, commands, or final-response fields.");
    } else {
      add("missed-required-action", "Required action was not visible in the trace", finding, "required-workflow-bullet", "Promote the action into a short required workflow bullet with evidence expected.");
    }
  }

  return [...buckets.values()].sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

export function proposeConservativePatch(project: SkillLensProject): PatchProposal {
  const risky = dedupeRiskyFindings(project.findings).slice(0, 8);
  const taxonomy = buildFailureTaxonomy(project);
  const evidence = risky.map((finding) => evidenceForFinding(project, finding, taxonomy));
  const checklist = evidence.map((item) => `- [ ] ${item.proposed_edit}`);
  const section = [
    "",
    "## SkillScope maintenance patch",
    "",
    "These conservative additions are generated from trajectory evidence. Keep only the checks that match the intended skill behavior.",
    "",
    "### Before final answer",
    "",
    ...(checklist.length ? checklist : ["- [ ] Confirm the required artifact or response contract is satisfied."]),
    "",
    "### Evidence expectations",
    "",
    ...evidence.map((item) => `- ${item.constraint_id}: ${item.failure_pattern}; expected evidence: ${expectedEvidence(item.patch_type)}.`)
  ].join("\n");
  const optimizedSkill = `${project.skillMarkdown.replace(/\s+$/g, "")}\n${section}\n`;
  return {
    optimizedSkill,
    patchMarkdown: section.trimStart(),
    rationaleMarkdown: renderPatchRationale(project, taxonomy, evidence),
    evidence,
    diff: appendOnlyDiff(project.skillMarkdown, section)
  };
}

export function renderImproveSummary(project: SkillLensProject, metrics: ImproveMetrics, patterns: FailurePattern[]): string {
  return [
    `# SkillScope Improve Loop: ${project.name}`,
    "",
    "## Metrics",
    "",
    `- Applicable adherence rate: ${percent(metrics.applicableAdherenceRate)}`,
    `- Evidence coverage rate: ${percent(metrics.evidenceCoverageRate)}`,
    `- Unknown / unobservable rate: ${percent(metrics.unknownRate)}`,
    `- Violation rate: ${percent(metrics.violationRate)}`,
    `- Skill invocation observed: ${metrics.skillInvocationObserved ? "yes" : "no"}`,
    `- Pass rate: ${metrics.passRate === null ? "unknown" : metrics.passRate}`,
    `- Score: ${metrics.score === null ? "unknown" : metrics.score}`,
    `- Skill lift: ${metrics.skillLift === null ? "unknown" : metrics.skillLift}`,
    "",
    "## Top Failure Patterns",
    "",
    ...(patterns.length
      ? patterns.map((pattern) => `- ${pattern.label}: ${pattern.count} finding(s), patch type \`${pattern.patchType}\`.`)
      : ["- No missed, violated, or unknown constraints found."])
  ].join("\n");
}

function numericScore(result: Record<string, unknown>): number | null {
  for (const key of ["score", "reward", "verifier_reward", "success"]) {
    const value = result[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
  }
  return null;
}

function booleanSuccess(result: Record<string, unknown>): number | null {
  if (typeof result.success === "boolean") {
    return result.success ? 1 : 0;
  }
  const score = numericScore(result);
  return score === null ? null : score > 0 ? 1 : 0;
}

function hasSkillInvocation(events: TraceEvent[], skillMarkdown: string): boolean {
  const heading = skillMarkdown.match(/^#\s+(.+)$/m)?.[1]?.toLowerCase();
  return events.some((event) => {
    const text = `${event.name ?? ""} ${event.content} ${event.output}`.toLowerCase();
    return text.includes("skill.md") || text.includes("skills/") || (heading ? text.includes(heading) : false);
  });
}

function evidenceForFinding(project: SkillLensProject, finding: CoverageFinding, patterns: FailurePattern[]): PatchEvidence {
  const constraint = constraintText(project, finding);
  const pattern = patterns.find((candidate) => candidate.findingIds.includes(finding.id));
  return {
    constraint_id: finding.constraintId ?? finding.unitId,
    source_span: sourceSpan(project, finding),
    judgment: finding.status,
    evidence_events: [...finding.evidenceEventIds, ...finding.counterEvidenceEventIds].slice(0, 6),
    failure_pattern: pattern?.label ?? "Unclassified failure",
    patch_type: pattern?.patchType ?? "required-workflow-bullet",
    proposed_edit: proposedEdit(pattern?.patchType, constraint),
    risk: riskForPatch(pattern?.patchType)
  };
}

function proposedEdit(patchType: string | undefined, constraint: string): string {
  const clipped = truncate(constraint.replace(/^[-*]\s*/, ""), 120);
  if (patchType === "pre-submit-checklist") {
    return `Run or explicitly skip the validation step for "${clipped}" before final response, with evidence.`;
  }
  if (patchType === "front-loaded-output-contract") {
    return `Validate the required output contract for "${clipped}" before sending the final response.`;
  }
  if (patchType === "observable-artifact-contract") {
    return `Leave observable evidence for "${clipped}" as a command, file artifact, tool call, or final-response field.`;
  }
  if (patchType === "adjacent-prohibition-alternative") {
    return `Check that the trace avoids the prohibited behavior in "${clipped}" and uses the stated alternative.`;
  }
  return `Complete "${clipped}" and leave trace evidence before final response.`;
}

function riskForPatch(patchType: string | undefined): string {
  if (patchType === "pre-submit-checklist") {
    return "May increase runtime by one validation command.";
  }
  if (patchType === "front-loaded-output-contract") {
    return "May make the skill stricter than the benchmark verifier.";
  }
  if (patchType === "observable-artifact-contract") {
    return "May add reporting overhead without directly improving pass rate.";
  }
  return "May add token overhead; review against the original skill intent.";
}

function expectedEvidence(patchType: string): string {
  if (patchType === "pre-submit-checklist") {
    return "validation command output or explicit skip rationale";
  }
  if (patchType === "front-loaded-output-contract") {
    return "parser success, schema check, or final-response field";
  }
  if (patchType === "observable-artifact-contract") {
    return "named file, command, tool call, or final response marker";
  }
  return "trace event before final answer";
}

function renderPatchRationale(project: SkillLensProject, patterns: FailurePattern[], evidence: PatchEvidence[]): string {
  return [
    `# Patch Rationale: ${project.name}`,
    "",
    "## Why This Patch",
    "",
    ...patterns.map((pattern) => `- ${pattern.label}: ${pattern.rationale}`),
    "",
    "## Evidence-Backed Edits",
    "",
    ...evidence.map(
      (item) =>
        `- ${item.constraint_id} (${item.judgment}, ${item.patch_type}): ${item.proposed_edit} Risk: ${item.risk}`
    )
  ].join("\n");
}

function appendOnlyDiff(original: string, appendedSection: string): string {
  const originalLines = original.replace(/\s+$/g, "").split("\n");
  const startLine = originalLines.length + 1;
  const additions = appendedSection.split("\n").map((line) => `+${line}`);
  return [`--- a/SKILL.md`, `+++ b/SKILL.md`, `@@ -${startLine},0 +${startLine},${additions.length} @@`, ...additions].join("\n");
}

function unitFor(units: SkillUnit[], finding: CoverageFinding): SkillUnit | undefined {
  return units.find((unit) => unit.id === finding.unitId);
}

function constraintText(project: SkillLensProject, finding: CoverageFinding): string {
  const unit = unitFor(project.units, finding);
  const constraint = unit?.constraints.find((candidate) => candidate.id === finding.constraintId);
  return constraint?.text ?? unit?.text ?? finding.unitId;
}

function sourceSpan(project: SkillLensProject, finding: CoverageFinding): string {
  const unit = unitFor(project.units, finding);
  const constraint = unit?.constraints.find((candidate) => candidate.id === finding.constraintId);
  const span = constraint?.span ?? unit;
  if (!span) {
    return "SKILL.md";
  }
  return `SKILL.md:L${span.lineStart}-L${span.lineEnd}`;
}

function severityRank(status: CoverageFinding["status"]): number {
  if (status === "violated") {
    return 3;
  }
  if (status === "missed") {
    return 2;
  }
  if (status === "unknown") {
    return 1;
  }
  return 0;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function dedupeRiskyFindings(findings: CoverageFinding[]): CoverageFinding[] {
  const byUnit = new Map<string, CoverageFinding>();
  for (const finding of findings) {
    if (finding.status !== "missed" && finding.status !== "violated" && finding.status !== "unknown") {
      continue;
    }
    const existing = byUnit.get(finding.unitId);
    if (
      !existing ||
      severityRank(finding.status) > severityRank(existing.status) ||
      (severityRank(finding.status) === severityRank(existing.status) && finding.confidence > existing.confidence)
    ) {
      byUnit.set(finding.unitId, finding);
    }
  }
  return [...byUnit.values()].sort(
    (left, right) => severityRank(right.status) - severityRank(left.status) || right.confidence - left.confidence
  );
}
