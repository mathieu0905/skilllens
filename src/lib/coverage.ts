import type { CoverageFinding, CoverageStatus, SkillConstraint, SkillUnit, TraceEvent } from "./types";
import { defaultAnalysisRecipe, type AnalysisRecipe } from "./analysisRecipe";
import { clamp, normalizeWhitespace, overlapScore, tokenize, truncate } from "./text";

interface Candidate {
  event: TraceEvent;
  score: number;
  reasons: string[];
}

const structuredSignals = [
  {
    name: "tests",
    unit: /\b(test|tests|suite|pytest|npm test|cargo test|go test|verification)\b/i,
    event: /\b(npm test|npm run test|pytest|cargo test|go test|pnpm test|yarn test|vitest|jest|unittest)\b/i
  },
  {
    name: "screenshots",
    unit: /\b(screenshot|visual|viewport|playwright|browser)\b/i,
    event: /\b(screenshot|playwright|browser|viewport|page\.screenshot)\b/i
  },
  {
    name: "file edits",
    unit: /\b(edit|patch|write|update|modify|create file|change file)\b/i,
    event: /\b(apply_patch|diff --git|write|updated|created|modified|save|edit)\b/i
  },
  {
    name: "final response",
    unit: /\b(final answer|final response|before finishing|before final|respond|tell the user)\b/i,
    event: /\b(final answer|summary|implemented|changed|verified|unable to)\b/i
  },
  {
    name: "download or import",
    unit: /\b(download|import|fetch|hugging face|skillsbench|url)\b/i,
    event: /\b(download|import|fetch|huggingface|hf_|curl|wget|url)\b/i
  },
  {
    name: "report export",
    unit: /\b(export|report|markdown|html|json)\b/i,
    event: /\b(export|report|markdown|html|json|download)\b/i
  }
];

export function analyzeCoverage(
  units: SkillUnit[],
  events: TraceEvent[],
  taskText = "",
  recipe: AnalysisRecipe = defaultAnalysisRecipe
): CoverageFinding[] {
  const findings: CoverageFinding[] = [];
  units.forEach((unit, unitIndex) => {
    const constraints = unit.constraints.length ? unit.constraints : [];
    if (!constraints.length) {
      findings.push(analyzeUnit(unit, events, taskText, unitIndex, recipe));
      return;
    }
    constraints.forEach((constraint, constraintIndex) => {
      findings.push(analyzeConstraint(unit, constraint, events, taskText, findings.length, constraintIndex, recipe));
    });
  });
  return findings;
}

function analyzeConstraint(
  unit: SkillUnit,
  constraint: SkillConstraint,
  events: TraceEvent[],
  taskText: string,
  index: number,
  constraintIndex: number,
  recipe: AnalysisRecipe
): CoverageFinding {
  if (isActivationHint(unit.text)) {
    return notApplicableFinding(unit, index, recipe, constraint.id, constraintIndex, "Skill activation hint; not an execution constraint.");
  }
  const pseudoUnit: SkillUnit = {
    ...unit,
    id: constraint.unitId,
    text: constraint.text,
    observable: constraint.observable,
    modality: constraint.severity === "must_not" ? "prohibited" : unit.modality
  };
  const finding = analyzeUnit(pseudoUnit, events, taskText, index, recipe);
  return {
    ...finding,
    id: `coverage.finding.${String(index + 1).padStart(3, "0")}.constraint.${String(constraintIndex + 1).padStart(2, "0")}`,
    unitId: unit.id,
    constraintId: constraint.id,
    rationale: `${constraint.kind} constraint: ${finding.rationale}`
  };
}

function analyzeUnit(
  unit: SkillUnit,
  events: TraceEvent[],
  taskText: string,
  index: number,
  recipe: AnalysisRecipe
): CoverageFinding {
  if (!shouldAnalyzeUnit(unit, recipe)) {
    return notApplicableFinding(unit, index, recipe, undefined, undefined, `Skipped by analysis recipe "${recipe.name}".`);
  }

  if (isActivationHint(unit.text)) {
    return notApplicableFinding(unit, index, recipe, undefined, undefined, "Skill activation hint; not an execution constraint.");
  }

  const candidates = findCandidates(unit, events, recipe);
  const explicitViolation = findViolation(unit, events);
  const taskRelevant = inferTaskRelevance(unit, taskText);
  const finalEvent = events[events.length - 1];
  let status: CoverageStatus = "unknown";
  let confidence = 0.34;
  let rationale = "The trace does not contain enough observable evidence for this instruction.";
  let evidenceEventIds: string[] = [];
  let counterEvidenceEventIds: string[] = [];
  let suggestedRewrite: string | null = null;

  if (!unit.observable) {
    status = "unknown";
    confidence = 0.31;
    suggestedRewrite = `Make this instruction observable by naming the action, tool, artifact, or trace signal that should appear. Current text: "${truncate(unit.text, 110)}"`;
  } else if (explicitViolation && recipe.evidencePolicy.allowedAutoStatuses.includes("violated")) {
    status = "violated";
    confidence = explicitViolation.score;
    rationale = explicitViolation.rationale;
    evidenceEventIds = [explicitViolation.event.id];
    counterEvidenceEventIds = candidates.slice(0, 2).map((candidate) => candidate.event.id);
    suggestedRewrite = `State the prohibited behavior and the expected alternative in adjacent bullets so violations are easier to detect.`;
  } else if (
    recipe.evidencePolicy.allowedAutoStatuses.includes("covered") &&
    candidates.length &&
    candidates[0].score >= 0.46 &&
    (!recipe.evidencePolicy.coveredRequiresEvidence || candidates.length > 0)
  ) {
    const top = candidates[0];
    status = "covered";
    confidence = clamp(top.score, 0.52, 0.93);
    rationale = `Matched trace event ${top.event.id} through ${top.reasons.join(", ")}.`;
    evidenceEventIds = candidates.slice(0, recipe.judge.maxEvidenceEvents).map((candidate) => candidate.event.id);
  } else if (unit.modality === "mandatory" && taskRelevant !== "unlikely") {
    status =
      recipe.evidencePolicy.allowedAutoStatuses.includes("missed") && (taskRelevant === "likely" || hasStrongAction(unit.text))
        ? "missed"
        : "unknown";
    confidence = status === "missed" ? 0.6 : 0.42;
    rationale =
      status === "missed"
        ? "The instruction appears applicable, but no matching trace event was found before the run ended."
        : "The instruction is action-oriented, but applicability is unclear from the task and trace.";
    evidenceEventIds = status === "missed" && recipe.evidencePolicy.missedCanUseFinalEvent && finalEvent ? [finalEvent.id] : [];
    suggestedRewrite =
      "Add a concrete observable marker, such as the exact command, tool call, file artifact, or final-response phrase expected in successful trajectories.";
  } else if (taskRelevant === "unlikely") {
    status = recipe.evidencePolicy.allowedAutoStatuses.includes("not_applicable") ? "not_applicable" : "unknown";
    confidence = 0.58;
    rationale = "The instruction appears unrelated to the task text and no trace evidence suggests it was needed.";
    evidenceEventIds = status === "not_applicable" && finalEvent ? [finalEvent.id] : [];
  } else {
    status = "unknown";
    confidence = 0.36;
    evidenceEventIds = candidates.slice(0, 1).map((candidate) => candidate.event.id);
    suggestedRewrite =
      unit.modality === "informational"
        ? "If this should affect behavior, rewrite it as a specific instruction with an observable outcome."
        : null;
  }

  return {
    id: `coverage.finding.${String(index + 1).padStart(3, "0")}`,
    unitId: unit.id,
    status,
    confidence,
    rationale,
    evidenceEventIds,
    counterEvidenceEventIds,
    suggestedRewrite,
    candidateEventIds: candidates.slice(0, recipe.candidateRetrieval.maxCandidatesPerUnit).map((candidate) => candidate.event.id),
    analysisMethod: recipe.method,
    analysisRecipe: recipe.name
  };
}

function notApplicableFinding(
  unit: SkillUnit,
  index: number,
  recipe: AnalysisRecipe,
  constraintId?: string,
  constraintIndex?: number,
  rationale = "This instruction is not applicable to the current task."
): CoverageFinding {
  return {
    id:
      typeof constraintIndex === "number"
        ? `coverage.finding.${String(index + 1).padStart(3, "0")}.constraint.${String(constraintIndex + 1).padStart(2, "0")}`
        : `coverage.finding.${String(index + 1).padStart(3, "0")}`,
    unitId: unit.id,
    constraintId,
    status: "not_applicable",
    confidence: 0.74,
    rationale,
    evidenceEventIds: [],
    counterEvidenceEventIds: [],
    suggestedRewrite: null,
    candidateEventIds: [],
    analysisMethod: recipe.method,
    analysisRecipe: recipe.name
  };
}

function isActivationHint(text: string): boolean {
  return /^\s*(?:use|invoke|trigger)\s+this\s+skill\s+when\b/i.test(text);
}

export function findCandidates(
  unit: SkillUnit,
  events: TraceEvent[],
  recipe: AnalysisRecipe = defaultAnalysisRecipe
): Candidate[] {
  const unitText = `${unit.headingPath.join(" ")} ${unit.text}`;
  return events
    .map((event) => {
      const eventText = `${event.type} ${event.name ?? ""} ${event.content.slice(0, 2400)} ${event.output.slice(0, 2400)} ${event.files.join(" ")}`;
      const lexical = overlapScore(unitText, eventText);
      const reasons: string[] = [];
      let score = lexical;

      if (lexical >= 0.22) {
        reasons.push("keyword overlap");
      }

      structuredSignals.forEach((signal) => {
        if (signal.unit.test(unitText) && signal.event.test(eventText)) {
          score += recipe.candidateRetrieval.structuredSignalBoost;
          reasons.push(signal.name);
        }
      });

      if (event.type === "file_edit" && /\b(edit|patch|modify|write|file)\b/i.test(unitText)) {
        score += 0.22;
        reasons.push("file edit event");
      }
      if (event.type === "command" && /\b(run|command|shell|test|verify|install)\b/i.test(unitText)) {
        score += 0.18;
        reasons.push("command event");
      }
      if ((event.type === "final_answer" || event.step === events.length) && /\b(final|respond|tell the user|summary)\b/i.test(unitText)) {
        score += 0.2;
        reasons.push("final response position");
      }

      return {
        event,
        score: clamp(score, 0, 0.96),
        reasons
      };
    })
    .filter((candidate) => candidate.score >= recipe.candidateRetrieval.lexicalThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, recipe.candidateRetrieval.maxCandidatesPerUnit);
}

function shouldAnalyzeUnit(unit: SkillUnit, recipe: AnalysisRecipe): boolean {
  if (!recipe.instructionSelection.includeModalities.includes(unit.modality)) {
    return false;
  }
  if (!recipe.instructionSelection.includeLowObservability && !unit.observable) {
    return false;
  }
  const text = `${unit.headingPath.join(" ")} ${unit.text}`.toLowerCase();
  if (recipe.instructionSelection.excludeTerms.some((term) => text.includes(term.toLowerCase()))) {
    return false;
  }
  if (recipe.instructionSelection.focusTerms.length) {
    return recipe.instructionSelection.focusTerms.some((term) => text.includes(term.toLowerCase()));
  }
  return true;
}

function findViolation(unit: SkillUnit, events: TraceEvent[]): { event: TraceEvent; score: number; rationale: string } | null {
  const text = normalizeWhitespace(unit.text).toLowerCase();
  const prohibitedMatch = text.match(/\b(?:never|do not|don't|avoid|must not|should not)\s+([^.;]+)/i);
  if (!prohibitedMatch) {
    return null;
  }

  const prohibitedPhrase = prohibitedMatch[1].replace(/\b(unless|when|if)\b.*$/i, "").trim();
  const phraseTokens = tokenize(prohibitedPhrase).filter((token) => token.length > 3);
  if (!phraseTokens.length) {
    return null;
  }

  for (const event of events) {
    const eventText = `${event.name ?? ""} ${event.content} ${event.output}`.toLowerCase();
    const hits = phraseTokens.filter((token) => eventText.includes(token));
    if (hits.length >= Math.min(2, phraseTokens.length)) {
      return {
        event,
        score: clamp(0.58 + hits.length * 0.08, 0.58, 0.86),
        rationale: `The trace contains behavior matching the prohibited phrase "${truncate(prohibitedPhrase, 80)}".`
      };
    }
  }
  return null;
}

function inferTaskRelevance(unit: SkillUnit, taskText: string): "likely" | "unclear" | "unlikely" {
  if (!taskText.trim()) {
    return "unclear";
  }
  const score = overlapScore(unit.text, taskText);
  if (score >= 0.18) {
    return "likely";
  }
  if (score <= 0.04 && /\b(pdf|browser|screenshot|test|report|export|database|api|frontend|backend)\b/i.test(unit.text)) {
    return "unlikely";
  }
  return "unclear";
}

function hasStrongAction(text: string): boolean {
  return /\b(run|verify|test|open|inspect|edit|write|export|compare|download|upload|cite|include|avoid|never|do not)\b/i.test(text);
}

export function summarizeCoverage(findings: CoverageFinding[]) {
  const counts = {
    covered: 0,
    missed: 0,
    violated: 0,
    not_applicable: 0,
    unknown: 0
  };
  findings.forEach((finding) => {
    counts[finding.status] += 1;
  });
  const applicable = findings.length - counts.not_applicable;
  const coverageRate = applicable ? counts.covered / applicable : 0;
  const riskRate = applicable ? (counts.missed + counts.violated) / applicable : 0;
  return {
    counts,
    total: findings.length,
    applicable,
    coverageRate,
    riskRate,
    averageConfidence: findings.length
      ? findings.reduce((sum, finding) => sum + finding.confidence, 0) / findings.length
      : 0
  };
}
