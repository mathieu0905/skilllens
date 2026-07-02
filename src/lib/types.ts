export type CoverageStatus =
  | "covered"
  | "missed"
  | "violated"
  | "not_applicable"
  | "unknown";

export type TraceEventType =
  | "assistant_message"
  | "user_message"
  | "tool_call"
  | "tool_output"
  | "command"
  | "file_edit"
  | "observation"
  | "final_answer"
  | "unknown";

export type TraceFormat = "acp" | "codex" | "claude_code" | "generic_jsonl" | "plain_text";

export type AnalysisMethod = "heuristic" | "llm_judge" | "hybrid";

export type CaptureSource = "codex_plugin" | "claude_code_plugin" | "manual_upload" | "skillsbench";

export type SkillConstraintKind =
  | "action"
  | "prohibition"
  | "order"
  | "numeric"
  | "command"
  | "file_reference"
  | "evidence"
  | "condition";

export interface SourceSpan {
  lineStart: number;
  lineEnd: number;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface SkillConstraint {
  id: string;
  unitId: string;
  kind: SkillConstraintKind;
  text: string;
  normalized: string;
  parameters: Record<string, string | number | boolean>;
  span: SourceSpan;
  observable: boolean;
  severity: "must" | "should" | "must_not" | "may" | "info";
}

export interface SkillUnit {
  id: string;
  parentId: string | null;
  headingPath: string[];
  text: string;
  lineStart: number;
  lineEnd: number;
  modality: "mandatory" | "prohibited" | "recommended" | "optional" | "informational";
  observable: boolean;
  lowObservabilityReason?: string;
  source: "heading" | "list" | "sentence" | "paragraph";
  constraints: SkillConstraint[];
}

export interface TraceEvent {
  id: string;
  step: number;
  role: string;
  type: TraceEventType;
  name: string | null;
  content: string;
  output: string;
  files: string[];
  time: string | null;
  raw: unknown;
}

export interface CoverageFinding {
  id: string;
  unitId: string;
  constraintId?: string;
  analyzedConstraint?: {
    kind: string;
    text: string;
    severity: string;
    span: SourceSpan;
  };
  status: CoverageStatus;
  confidence: number;
  rationale: string;
  evidenceEventIds: string[];
  counterEvidenceEventIds: string[];
  suggestedRewrite: string | null;
  candidateEventIds: string[];
  analysisMethod?: AnalysisMethod;
  analysisRecipe?: string;
}

export type SkillGraphNodeKind =
  | "root"
  | "section"
  | "condition"
  | "constraint"
  | "action"
  | "prohibition"
  | "order"
  | "numeric"
  | "command"
  | "file_reference"
  | "evidence"
  | "other";

export type SkillGraphBranchState = "taken" | "not_taken" | "checked" | "unknown";

export interface SkillGraphArtifactNode {
  id: string;
  unitId?: string;
  constraintId?: string;
  parentId?: string;
  kind: SkillGraphNodeKind | string;
  label: string;
  text: string;
  predicate?: string;
  sourceSpan?: SourceSpan;
  status?: CoverageStatus;
  confidence?: number;
  branchState?: SkillGraphBranchState;
  evidenceEventIds?: string[];
  rationale?: string;
}

export interface SkillGraphArtifactEdge {
  id: string;
  from: string;
  to: string;
  kind: "contains" | "requires" | "then" | "else" | "condition_true" | "condition_false" | "related" | string;
  label?: string;
  taken?: boolean;
  evidenceEventIds?: string[];
  rationale?: string;
}

export interface SkillGraphArtifactPath {
  id: string;
  title: string;
  nodeIds: string[];
  eventIds?: string[];
  rationale?: string;
}

export interface SkillGraphArtifact {
  schemaVersion: "skilllens.skill-graph.v1";
  requestId?: string;
  nodes: SkillGraphArtifactNode[];
  edges: SkillGraphArtifactEdge[];
  paths: SkillGraphArtifactPath[];
}

export interface ProjectResult {
  success?: boolean;
  score?: number;
  model?: string;
  task?: string;
  source?: string;
  analyzedSegment?: CapturedSessionSegment;
  skillGraph?: SkillGraphArtifact;
  [key: string]: unknown;
}

export interface SkillLensProject {
  id: string;
  name: string;
  sourceType: "demo" | "upload" | "url";
  sourceUrl?: string;
  traceFormat: TraceFormat;
  skillMarkdown: string;
  traceText: string;
  taskMarkdown?: string;
  result: ProjectResult;
  units: SkillUnit[];
  events: TraceEvent[];
  findings: CoverageFinding[];
  createdAt: string;
}

export interface CapturedSkillArtifact {
  id: string;
  kind: "skill" | "rule" | "memory" | "playbook";
  path: string;
  title: string;
  content: string;
  sha256?: string;
  loaded: boolean;
  loadReason?: string;
}

export interface CapturedTraceArtifact {
  id: string;
  path: string;
  format: TraceFormat;
  content: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  sha256?: string;
  segments?: CapturedSessionSegment[];
}

export interface CapturedSessionSegment {
  id: string;
  title: string;
  startStep: number;
  endStep: number;
  prompt?: string;
  skillArtifactIds?: string[];
  notes?: string;
}

export interface CaptureBundle {
  schemaVersion: "skilllens.capture.v1";
  source: CaptureSource;
  createdAt: string;
  agent: {
    product: "codex" | "claude_code" | "unknown";
    version?: string;
    model?: string;
  };
  task?: {
    id?: string;
    prompt?: string;
    cwd?: string;
  };
  skills: CapturedSkillArtifact[];
  trace: CapturedTraceArtifact;
  result?: ProjectResult;
  analysis?: {
    method: AnalysisMethod;
    notes?: string;
    recipe?: unknown;
  };
}

export interface CaptureRegistryEntry {
  id: string;
  source: CaptureSource;
  agentProduct: CaptureBundle["agent"]["product"];
  traceFormat: TraceFormat;
  title: string;
  bundlePath: string;
  cwd?: string;
  createdAt: string;
  skillCount: number;
  loadedSkillCount: number;
  segmentCount: number;
  sessionId?: string;
}

export interface CaptureRegistry {
  schemaVersion: "skilllens.registry.v1";
  updatedAt: string;
  captures: CaptureRegistryEntry[];
}

export interface StatusCount {
  status: CoverageStatus;
  count: number;
}
