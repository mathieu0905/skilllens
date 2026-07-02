import { analyzeCoverage } from "./coverage";
import { defaultAnalysisRecipe, normalizeRecipe, type AnalysisRecipe } from "./analysisRecipe";
import { parseSkillMarkdown } from "./skillParser";
import { detectTraceFormat, parseTraceText } from "./traceParser";
import type { CapturedSessionSegment, CaptureBundle, CoverageFinding, ProjectResult, SkillLensProject, SkillUnit, TraceEvent } from "./types";

export function createProject(
  name: string,
  skill: string,
  trace: string,
  result: ProjectResult,
  sourceType: SkillLensProject["sourceType"] = "upload",
  task = "",
  sourceUrl?: string,
  recipe: AnalysisRecipe = defaultAnalysisRecipe
): SkillLensProject {
  const units = parseSkillMarkdown(skill);
  const events = parseTraceText(trace);
  const findings = analyzeCoverage(units, events, task, recipe);
  return {
    id: `${sourceType}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
    name,
    sourceType,
    sourceUrl,
    traceFormat: detectTraceFormat(trace),
    skillMarkdown: skill,
    traceText: trace,
    taskMarkdown: task,
    result,
    units,
    events,
    findings,
    createdAt: new Date().toISOString()
  };
}

export function createProjectFromCaptureBundle(
  bundle: CaptureBundle,
  options: { segmentStartStep?: number; segmentEndStep?: number; lazyFindings?: boolean } = {}
): SkillLensProject {
  const loadedSkills = bundle.skills.filter((skill) => skill.loaded);
  const skillText = loadedSkills.length
    ? loadedSkills.map((skill) => skill.content).join("\n\n")
    : bundle.skills.map((skill) => skill.content).join("\n\n");
  const allEvents = parseTraceText(bundle.trace.content);
  const segment = pickPrimarySkillSegment(bundle.trace.segments, options);
  const events = segment ? eventsForSegment(allEvents, segment) : allEvents;
  const result: ProjectResult = {
    ...(bundle.result ?? {}),
    source: bundle.source,
    task: bundle.task?.id,
    model: bundle.agent.model,
    sessionSegments: segment ? [segment] : bundle.trace.segments ?? [],
    analyzedSegment: segment,
    skillArtifacts: bundle.skills.map((skill) => ({
      id: skill.id,
      kind: skill.kind,
      path: skill.path,
      title: skill.title,
      loaded: skill.loaded,
      loadReason: skill.loadReason
    }))
  };

  const recipe = normalizeRecipe(bundle.analysis?.recipe);
  const units = parseSkillMarkdown(skillText);
  const prompt = segment?.prompt ?? bundle.task?.prompt ?? "";
  const findings = options.lazyFindings ? createPendingFindings(units) : analyzeCoverage(units, events, prompt, recipe);
  const nameParts = [bundle.task?.id ?? `${bundle.agent.product} capture`];
  if (segment?.title) {
    nameParts.push(segment.title);
  }
  return {
    id: `${bundle.source}-${bundle.trace.sessionId ?? bundle.trace.id}-${Date.now()}`,
    name: nameParts.join(" / "),
    sourceType: bundle.source === "skillsbench" ? "url" : "upload",
    sourceUrl: bundle.trace.path,
    traceFormat: bundle.trace.format || detectTraceFormat(bundle.trace.content),
    skillMarkdown: skillText,
    traceText: bundle.trace.content,
    taskMarkdown: prompt,
    result,
    units,
    events,
    findings,
    createdAt: new Date().toISOString()
  };
}

function createPendingFindings(units: SkillUnit[]): CoverageFinding[] {
  const findings: CoverageFinding[] = [];
  units.forEach((unit) => {
    const constraints = unit.constraints.length ? unit.constraints : [undefined];
    constraints.forEach((constraint, constraintIndex) => {
      findings.push({
        id: `coverage.finding.${String(findings.length + 1).padStart(3, "0")}${
          constraint ? `.constraint.${String(constraintIndex + 1).padStart(2, "0")}` : ""
        }`,
        unitId: unit.id,
        constraintId: constraint?.id,
        status: "unknown",
        confidence: 0,
        rationale: "还没有启动 agent judge。打开时只做轻量解析，点击“启动分析”后才会判定该约束是否被遵循、违反或忽略。",
        evidenceEventIds: [],
        counterEvidenceEventIds: [],
        suggestedRewrite: null,
        candidateEventIds: [],
        analysisMethod: "heuristic",
        analysisRecipe: "pending-agent-judge"
      });
    });
  });
  return findings;
}

function pickPrimarySkillSegment(
  segments: CapturedSessionSegment[] | undefined,
  options: { segmentStartStep?: number; segmentEndStep?: number } = {}
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
    if (typeof options.segmentEndStep === "number") {
      const overlapping = segments
        .map((segment) => ({
          segment,
          overlap: Math.min(segment.endStep, options.segmentEndStep!) - Math.max(segment.startStep, options.segmentStartStep!)
        }))
        .filter((candidate) => candidate.overlap >= 0)
        .sort((a, b) => b.overlap - a.overlap)[0]?.segment;
      if (overlapping) {
        return overlapping;
      }
    }
    const nearest = [...segments]
      .sort((left, right) => Math.abs(left.startStep - options.segmentStartStep!) - Math.abs(right.startStep - options.segmentStartStep!))[0];
    if (nearest && Math.abs(nearest.startStep - options.segmentStartStep) <= 24) {
      return nearest;
    }
  }
  return [...segments].reverse().find((segment) => segment.skillArtifactIds?.length) ?? segments[0];
}

function eventsForSegment(events: TraceEvent[], segment: CapturedSessionSegment): TraceEvent[] {
  const windowEvents = events.filter((event) => event.step >= segment.startStep && event.step <= segment.endStep);
  return windowEvents.length ? windowEvents : events;
}
