import type {
  AnalysisMethod,
  CoverageFinding,
  CoverageStatus,
  SkillGraphArtifact,
  SkillGraphArtifactEdge,
  SkillGraphArtifactNode,
  SkillGraphArtifactPath,
  SkillLensProject,
  SkillUnit,
  SourceSpan,
  TraceEvent
} from "./types";
import { clamp, truncate } from "./text";

export interface AgentJudgeRequest {
  schemaVersion: "skilllens.agent-judge-request.v2";
  requestId: string;
  createdAt: string;
  agentProduct: "codex" | "claude_code" | "unknown";
  project: {
    id: string;
    name: string;
    traceFormat: string;
    task: string;
    eventCount: number;
  };
  traceEvents: AgentJudgeEvent[];
  items: AgentJudgeItem[];
}

export interface AgentJudgeItem {
  itemId: string;
  unitId: string;
  headingPath: string[];
  unitText: string;
  unitModality: string;
  lineStart: number;
  lineEnd: number;
}

export interface AgentJudgeEvent {
  id: string;
  step: number;
  role: string;
  type: string;
  name: string | null;
  content: string;
  output: string;
  files: string[];
}

export interface AgentAnalyzedConstraint {
  kind: string;
  text: string;
  severity: string;
  sourceSpan: SourceSpan;
}

export interface AgentJudgeResponse {
  schemaVersion: "skilllens.agent-judge-response.v2";
  requestId: string;
  judgments: AgentJudgment[];
}

export interface AgentJudgment {
  findingId: string;
  unitId: string;
  analyzedConstraint: AgentAnalyzedConstraint;
  status: CoverageStatus;
  confidence: number;
  rationale: string;
  evidenceEventIds: string[];
  counterEvidenceEventIds?: string[];
  suggestedRewrite?: string | null;
}

export interface AgentExtractedConstraint {
  id?: string;
  unitId: string;
  kind?: string;
  text: string;
  severity?: string;
  sourceSpan?: SourceSpan;
  rationale?: string;
}

const validStatuses: CoverageStatus[] = ["covered", "missed", "violated", "not_applicable", "unknown"];

export function createAgentJudgeRequest(
  project: SkillLensProject,
  options: {
    requestId: string;
    agentProduct: AgentJudgeRequest["agentProduct"];
    maxFindings?: number;
    maxEvidenceEvents?: number;
  }
): AgentJudgeRequest {
  const maxUnits = options.maxFindings && options.maxFindings > 0 ? options.maxFindings : project.units.length;
  const maxTraceEvents = options.maxEvidenceEvents && options.maxEvidenceEvents > 0 ? Math.max(options.maxEvidenceEvents, 12) : project.events.length;
  const items = project.units
    .filter((unit) => !isActivationHint(unit.text))
    .slice(0, maxUnits)
    .map((unit, index) => makeJudgeItem(unit, index));

  return {
    schemaVersion: "skilllens.agent-judge-request.v2",
    requestId: options.requestId,
    createdAt: new Date().toISOString(),
    agentProduct: options.agentProduct,
    project: {
      id: project.id,
      name: project.name,
      traceFormat: project.traceFormat,
      task: truncate(project.taskMarkdown ?? "", 2400),
      eventCount: project.events.length
    },
    traceEvents: selectTraceEvents(project.events, maxTraceEvents),
    items
  };
}

export function parseAgentConstraintsResponse(text: string, project: SkillLensProject): AgentExtractedConstraint[] {
  const parsed = parseJsonLike(text);
  const rawConstraints =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).constraints)
        ? ((parsed as Record<string, unknown>).constraints as unknown[])
        : [];
  const units = new Map(project.units.map((unit) => [unit.id, unit]));
  return rawConstraints
    .map((value, index) => normalizeExtractedConstraint(value, index, units))
    .filter((constraint): constraint is AgentExtractedConstraint => Boolean(constraint));
}

export function constraintsToPendingFindings(
  project: SkillLensProject,
  constraints: AgentExtractedConstraint[],
  requestId: string
): CoverageFinding[] {
  const units = new Map(project.units.map((unit) => [unit.id, unit]));
  const findings = constraints.flatMap((constraint, index) => {
    const unit = units.get(constraint.unitId);
    if (!unit) {
      return [];
    }
    const analyzedConstraint = normalizeAnalyzedConstraint(
      {
        kind: constraint.kind ?? "other",
        text: constraint.text,
        severity: constraint.severity ?? unit.modality,
        sourceSpan: constraint.sourceSpan ?? {
          lineStart: unit.lineStart,
          lineEnd: unit.lineEnd,
          charStart: 0,
          charEnd: unit.text.length,
          text: constraint.text
        }
      },
      unit
    );
    return [
      {
        id: constraint.id || `coverage.agent.constraint.${String(index + 1).padStart(3, "0")}`,
        unitId: unit.id,
        analyzedConstraint,
        status: "unknown" as CoverageStatus,
        confidence: 0,
        rationale: constraint.rationale
          ? `Agent extracted constraint: ${constraint.rationale}`
          : "Agent extracted this constraint; trace evidence has not been checked yet.",
        evidenceEventIds: [],
        counterEvidenceEventIds: [],
        suggestedRewrite: null,
        candidateEventIds: [],
        analysisMethod: "hybrid" as AnalysisMethod,
        analysisRecipe: `skilllens.agent-constraints:${requestId}`
      }
    ];
  });
  return findings.length ? findings : project.findings;
}

export function parseAgentJudgeResponse(text: string, fallbackRequestId = "agent-native-analysis"): AgentJudgeResponse {
  const trimmed = text.trim();
  const parsed = parseJsonLike(trimmed);
  if (parsed && typeof parsed === "object") {
    const maybeResponse = normalizeResponse(parsed, fallbackRequestId);
    if (maybeResponse) {
      return maybeResponse;
    }
  }
  return {
    schemaVersion: "skilllens.agent-judge-response.v2",
    requestId: fallbackRequestId,
    judgments: []
  };
}

export function parseAgentSkillGraphResponse(text: string, project: SkillLensProject): SkillGraphArtifact | null {
  const parsed = parseJsonLike(text);
  const object =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) && "graph" in parsed && typeof (parsed as Record<string, unknown>).graph === "object"
      ? ((parsed as Record<string, unknown>).graph as Record<string, unknown>)
      : parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  if (!object) {
    return null;
  }
  const rawNodes = Array.isArray(object.nodes) ? object.nodes : [];
  const rawEdges = Array.isArray(object.edges) ? object.edges : [];
  const rawPaths = Array.isArray(object.paths) ? object.paths : Array.isArray(object.tracePaths) ? object.tracePaths : [];
  const units = new Map(project.units.map((unit) => [unit.id, unit]));
  const nodes = rawNodes
    .map((value, index) => normalizeGraphNode(value, index, units))
    .filter((node): node is SkillGraphArtifactNode => Boolean(node));
  if (!nodes.length) {
    return null;
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = rawEdges
    .map((value, index) => normalizeGraphEdge(value, index, nodeIds))
    .filter((edge): edge is SkillGraphArtifactEdge => Boolean(edge));
  const paths = rawPaths
    .map((value, index) => normalizeGraphPath(value, index, nodeIds))
    .filter((path): path is SkillGraphArtifactPath => Boolean(path));
  return {
    schemaVersion: "skilllens.skill-graph.v1",
    requestId: typeof object.requestId === "string" ? object.requestId : typeof object.request_id === "string" ? object.request_id : undefined,
    nodes,
    edges,
    paths
  };
}

export function applyAgentJudgeResponse(
  project: SkillLensProject,
  response: AgentJudgeResponse,
  method: AnalysisMethod = "hybrid"
): CoverageFinding[] {
  const eventIds = new Set(project.events.map((event) => event.id));
  const units = new Map(project.units.map((unit) => [unit.id, unit]));
  const findings: CoverageFinding[] = [];
  const seen = new Set<string>();

  response.judgments.forEach((judgment, index) => {
    const unit = units.get(judgment.unitId);
    if (!unit || seen.has(judgment.findingId)) {
      return;
    }
    seen.add(judgment.findingId);
    const status = validStatuses.includes(judgment.status) ? judgment.status : "unknown";
    const evidenceEventIds = unique(judgment.evidenceEventIds).filter((id) => eventIds.has(id));
    const counterEvidenceEventIds = unique(judgment.counterEvidenceEventIds ?? []).filter((id) => eventIds.has(id));
    const evidenceRequired = status === "covered" || status === "violated";
    const safeStatus: CoverageStatus = evidenceRequired && !evidenceEventIds.length ? "unknown" : status;
    const analyzedConstraint = normalizeAnalyzedConstraint(judgment.analyzedConstraint, unit);

    findings.push({
      id: judgment.findingId || `coverage.agent.${String(index + 1).padStart(3, "0")}`,
      unitId: unit.id,
      analyzedConstraint,
      status: safeStatus,
      confidence: clamp(judgment.confidence, 0, 1),
      rationale:
        safeStatus !== status
          ? `Agent judge returned ${status} without valid evidence IDs; SkillLens downgraded it to unknown.`
          : `Agent judge: ${judgment.rationale}`,
      evidenceEventIds,
      counterEvidenceEventIds,
      suggestedRewrite: judgment.suggestedRewrite ?? null,
      candidateEventIds: [],
      analysisMethod: method,
      analysisRecipe: `${response.schemaVersion}:${response.requestId}`
    });
  });

  return findings.length ? findings : project.findings;
}

function makeJudgeItem(unit: SkillUnit, index: number): AgentJudgeItem {
  return {
    itemId: `judge.item.${String(index + 1).padStart(3, "0")}`,
    unitId: unit.id,
    headingPath: unit.headingPath,
    unitText: unit.text,
    unitModality: unit.modality,
    lineStart: unit.lineStart,
    lineEnd: unit.lineEnd
  };
}

function selectTraceEvents(events: TraceEvent[], maxEvents: number): AgentJudgeEvent[] {
  if (events.length <= maxEvents) {
    return events.map(toJudgeEvent);
  }
  const headCount = Math.min(12, Math.floor(maxEvents * 0.18));
  const tailCount = Math.min(16, Math.floor(maxEvents * 0.24));
  const middleBudget = Math.max(0, maxEvents - headCount - tailCount);
  const important = events.filter((event) =>
    ["tool_call", "tool_output", "command", "file_edit", "final_answer", "assistant_message"].includes(event.type)
  );
  const middle = important
    .filter((event) => event.step > headCount && event.step <= events.length - tailCount)
    .slice(0, middleBudget);
  return uniqueEvents([...events.slice(0, headCount), ...middle, ...events.slice(-tailCount)]).map(toJudgeEvent);
}

function toJudgeEvent(event: TraceEvent): AgentJudgeEvent {
  return {
    id: event.id,
    step: event.step,
    role: event.role,
    type: event.type,
    name: event.name,
    content: truncate(event.content, 1600),
    output: truncate(event.output, 1000),
    files: event.files.slice(0, 8)
  };
}

function parseJsonLike(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeResponse(value: unknown, fallbackRequestId: string): AgentJudgeResponse | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    return {
      schemaVersion: "skilllens.agent-judge-response.v2",
      requestId: fallbackRequestId,
      judgments: value.map((entry, index) => normalizeJudgment(entry, index))
    };
  }
  const object = value as Record<string, unknown>;
  const judgments = Array.isArray(object.judgments) ? object.judgments : Array.isArray(object.findings) ? object.findings : null;
  if (!judgments) {
    return null;
  }
  return {
    schemaVersion: "skilllens.agent-judge-response.v2",
    requestId: typeof object.requestId === "string" ? object.requestId : fallbackRequestId,
    judgments: judgments.map((entry, index) => normalizeJudgment(entry, index))
  };
}

function normalizeJudgment(value: unknown, index: number): AgentJudgment {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const constraintObject =
    object.analyzedConstraint && typeof object.analyzedConstraint === "object"
      ? (object.analyzedConstraint as Record<string, unknown>)
      : object.constraint && typeof object.constraint === "object"
        ? (object.constraint as Record<string, unknown>)
        : {};
  const span = constraintObject.sourceSpan ?? constraintObject.source_span ?? constraintObject.span ?? object.sourceSpan ?? object.source_span;
  const text =
    typeof constraintObject.text === "string"
      ? constraintObject.text
      : typeof object.text === "string"
        ? object.text
        : typeof object.constraint === "string"
          ? object.constraint
          : "";
  return {
    findingId:
      typeof object.findingId === "string"
        ? object.findingId
        : typeof object.id === "string"
          ? object.id
          : `coverage.agent.${String(index + 1).padStart(3, "0")}`,
    unitId: typeof object.unitId === "string" ? object.unitId : typeof object.unit_id === "string" ? object.unit_id : "",
    analyzedConstraint: {
      kind: typeof constraintObject.kind === "string" ? constraintObject.kind : typeof object.kind === "string" ? object.kind : "other",
      text,
      severity:
        typeof constraintObject.severity === "string"
          ? constraintObject.severity
          : typeof object.severity === "string"
            ? object.severity
            : "info",
      sourceSpan: span as SourceSpan
    },
    status: isCoverageStatus(object.status) ? object.status : "unknown",
    confidence: typeof object.confidence === "number" ? object.confidence : 0,
    rationale: typeof object.rationale === "string" ? object.rationale : "",
    evidenceEventIds: stringArray(object.evidenceEventIds ?? object.evidence_event_ids),
    counterEvidenceEventIds: stringArray(object.counterEvidenceEventIds ?? object.counter_evidence_event_ids),
    suggestedRewrite:
      typeof object.suggestedRewrite === "string"
        ? object.suggestedRewrite
        : typeof object.suggested_rewrite === "string"
          ? object.suggested_rewrite
          : null
  };
}

function isCoverageStatus(value: unknown): value is CoverageStatus {
  return typeof value === "string" && validStatuses.includes(value as CoverageStatus);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeExtractedConstraint(
  value: unknown,
  index: number,
  units: Map<string, SkillUnit>
): AgentExtractedConstraint | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const object = value as Record<string, unknown>;
  const unitId = typeof object.unitId === "string" ? object.unitId : typeof object.unit_id === "string" ? object.unit_id : "";
  const unit = units.get(unitId);
  if (!unit) {
    return null;
  }
  const text =
    typeof object.text === "string"
      ? object.text
      : typeof object.constraint === "string"
        ? object.constraint
        : typeof object.constraintText === "string"
          ? object.constraintText
          : "";
  if (!text.trim()) {
    return null;
  }
  const sourceSpan = normalizeSourceSpan(object.sourceSpan ?? object.source_span, unit, text);
  return {
    id: typeof object.id === "string" ? object.id : `agent.constraint.${String(index + 1).padStart(3, "0")}`,
    unitId,
    kind: typeof object.kind === "string" ? object.kind : "other",
    text,
    severity: typeof object.severity === "string" ? object.severity : unit.modality,
    sourceSpan,
    rationale: typeof object.rationale === "string" ? object.rationale : undefined
  };
}

function normalizeGraphNode(
  value: unknown,
  index: number,
  units: Map<string, SkillUnit>
): SkillGraphArtifactNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const object = value as Record<string, unknown>;
  const id =
    typeof object.id === "string"
      ? object.id
      : typeof object.nodeId === "string"
        ? object.nodeId
        : typeof object.node_id === "string"
          ? object.node_id
          : `skill.graph.node.${String(index + 1).padStart(3, "0")}`;
  const unitId = typeof object.unitId === "string" ? object.unitId : typeof object.unit_id === "string" ? object.unit_id : undefined;
  const unit = unitId ? units.get(unitId) : undefined;
  const text =
    typeof object.text === "string"
      ? object.text
      : typeof object.label === "string"
        ? object.label
        : typeof object.title === "string"
          ? object.title
          : unit?.text ?? "";
  const label =
    typeof object.label === "string"
      ? object.label
      : typeof object.title === "string"
        ? object.title
        : text.slice(0, 120) || id;
  const sourceSpan = unit ? normalizeSourceSpan(object.sourceSpan ?? object.source_span ?? object.span, unit, text || unit.text) : undefined;
  const status = isCoverageStatus(object.status) ? object.status : undefined;
  const branchState = normalizeBranchState(object.branchState ?? object.branch_state);
  return {
    id,
    unitId,
    constraintId:
      typeof object.constraintId === "string"
        ? object.constraintId
        : typeof object.constraint_id === "string"
          ? object.constraint_id
          : undefined,
    parentId:
      typeof object.parentId === "string"
        ? object.parentId
        : typeof object.parent_id === "string"
          ? object.parent_id
          : undefined,
    kind: typeof object.kind === "string" ? object.kind : "constraint",
    label,
    text: text || label,
    predicate: typeof object.predicate === "string" ? object.predicate : undefined,
    sourceSpan,
    status,
    confidence: typeof object.confidence === "number" ? clamp(object.confidence, 0, 1) : undefined,
    branchState,
    evidenceEventIds: stringArray(object.evidenceEventIds ?? object.evidence_event_ids),
    rationale: typeof object.rationale === "string" ? object.rationale : undefined
  };
}

function normalizeGraphEdge(value: unknown, index: number, nodeIds: Set<string>): SkillGraphArtifactEdge | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const object = value as Record<string, unknown>;
  const from = typeof object.from === "string" ? object.from : typeof object.source === "string" ? object.source : "";
  const to = typeof object.to === "string" ? object.to : typeof object.target === "string" ? object.target : "";
  if (!nodeIds.has(from) || !nodeIds.has(to)) {
    return null;
  }
  return {
    id: typeof object.id === "string" ? object.id : `skill.graph.edge.${String(index + 1).padStart(3, "0")}`,
    from,
    to,
    kind: typeof object.kind === "string" ? object.kind : typeof object.type === "string" ? object.type : "related",
    label: typeof object.label === "string" ? object.label : undefined,
    taken: typeof object.taken === "boolean" ? object.taken : undefined,
    evidenceEventIds: stringArray(object.evidenceEventIds ?? object.evidence_event_ids),
    rationale: typeof object.rationale === "string" ? object.rationale : undefined
  };
}

function normalizeGraphPath(value: unknown, index: number, nodeIds: Set<string>): SkillGraphArtifactPath | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const object = value as Record<string, unknown>;
  const rawNodeIds = stringArray(object.nodeIds ?? object.node_ids ?? object.nodes);
  const pathNodeIds = rawNodeIds.filter((id) => nodeIds.has(id));
  if (!pathNodeIds.length) {
    return null;
  }
  return {
    id: typeof object.id === "string" ? object.id : `skill.graph.path.${String(index + 1).padStart(3, "0")}`,
    title: typeof object.title === "string" ? object.title : typeof object.label === "string" ? object.label : "Trace path",
    nodeIds: pathNodeIds,
    eventIds: stringArray(object.eventIds ?? object.event_ids),
    rationale: typeof object.rationale === "string" ? object.rationale : undefined
  };
}

function normalizeBranchState(value: unknown): SkillGraphArtifactNode["branchState"] | undefined {
  return value === "taken" || value === "not_taken" || value === "checked" || value === "unknown" ? value : undefined;
}

function normalizeSourceSpan(value: unknown, unit: SkillUnit, fallbackText: string): SourceSpan {
  if (!value || typeof value !== "object") {
    return {
      lineStart: unit.lineStart,
      lineEnd: unit.lineEnd,
      charStart: 0,
      charEnd: fallbackText.length,
      text: fallbackText
    };
  }
  const object = value as Record<string, unknown>;
  const lineStart = clampNumber(spanNumberValue(object, ["lineStart", "line_start", "startLine", "start_line"], unit.lineStart), unit.lineStart, unit.lineEnd);
  const lineEnd = clampNumber(spanNumberValue(object, ["lineEnd", "line_end", "endLine", "end_line"], lineStart), unit.lineStart, unit.lineEnd);
  return {
    lineStart: Math.min(lineStart, lineEnd),
    lineEnd: Math.max(lineStart, lineEnd),
    charStart: Math.max(0, Math.floor(spanNumberValue(object, ["charStart", "char_start", "startChar", "start_char"], 0))),
    charEnd: Math.max(0, Math.floor(spanNumberValue(object, ["charEnd", "char_end", "endChar", "end_char"], fallbackText.length))),
    text: typeof object.text === "string" ? object.text : fallbackText
  };
}

function normalizeAnalyzedConstraint(input: AgentAnalyzedConstraint, unit: SkillUnit): CoverageFinding["analyzedConstraint"] {
  const span = normalizeSourceSpan(input.sourceSpan, unit, input.text || unit.text);
  const lineStart = clampNumber(span.lineStart, unit.lineStart, unit.lineEnd);
  const lineEnd = clampNumber(span.lineEnd, unit.lineStart, unit.lineEnd);
  const charStart = Math.max(0, Math.floor(span.charStart ?? 0));
  const charEnd = Math.max(charStart, Math.floor(span.charEnd ?? (input.text || unit.text).length));
  return {
    kind: input.kind || "instruction",
    text: input.text || span.text || unit.text,
    severity: input.severity || unit.modality,
    span: {
      lineStart: Math.min(lineStart, lineEnd),
      lineEnd: Math.max(lineStart, lineEnd),
      charStart,
      charEnd,
      text: span.text || input.text || unit.text
    }
  };
}

function spanNumberValue(object: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return fallback;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueEvents(events: TraceEvent[]): TraceEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) {
      return false;
    }
    seen.add(event.id);
    return true;
  });
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isActivationHint(text: string): boolean {
  return /^\s*(?:use|invoke|trigger)\s+this\s+skill\s+when\b/i.test(text);
}
