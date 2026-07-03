import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyAgentJudgeResponse,
  constraintsToPendingFindings,
  createAgentJudgeRequest,
  parseAgentConstraintsResponse,
  parseAgentJudgeResponse,
  parseAgentSkillGraphResponse
} from "../src/lib/agentJudge";
import { createProject } from "../src/lib/project";
import { exportAnalysisJson } from "../src/lib/report";
import { buildSkillOptimizerPrompt } from "../src/lib/skillOptimizerPrompt";
import { summarizeCoverage } from "../src/lib/coverage";
import type { CoverageFinding, CoverageStatus, CoverageTarget, ProjectResult, SkillGraphArtifact, SkillLensProject } from "../src/lib/types";

type Command =
  | "plan"
  | "collect"
  | "analyze"
  | "judge"
  | "propose"
  | "rerun-plan"
  | "analysis-plan"
  | "remote-script"
  | "help";
type TrialMode = "with" | "without" | "unknown";

interface CliOptions {
  command: Command;
  skillsbenchRoot?: string;
  runsRoot?: string;
  plan?: string;
  trialsFile?: string;
  analysis?: string;
  optimizedSkillsRoot?: string;
  out?: string;
  agent: string;
  model: string;
  trials: number;
  taskIds: string[];
  includeNoSkill: boolean;
  maxTasks?: number;
  maxAgentAnalyses?: number;
  agentConcurrency: number;
  agentTimeoutMs: number;
  minFailures: number;
  optimizeNcThreshold: number;
  optimizeStablePass: boolean;
  maxEditsPerSkill: number;
  force: boolean;
  remoteHost?: string;
  remoteDir?: string;
  benchExtraArgs: string[];
}

interface TaskPlan {
  id: string;
  taskDir: string;
  taskPath: string;
  skillsDir: string;
  skillPaths: string[];
}

interface SkillsBenchRunPlan {
  schemaVersion: "skillscope.skillsbench-run-plan.v1";
  createdAt: string;
  skillsbenchRoot: string;
  agent: string;
  model: string;
  trialsPerTask: number;
  includeNoSkill: boolean;
  benchExtraArgs: string[];
  tasks: TaskPlan[];
}

interface TrialRecord {
  id: string;
  dir: string;
  taskId: string;
  agent: string;
  model: string;
  mode: TrialMode;
  skillMode?: string;
  reward: number | null;
  passed: boolean | null;
  nSkillInvocations: number | null;
  configPath: string;
  resultPath: string;
  tracePath: string;
}

interface NativeVerifierSummary {
  schemaVersion: "skilllens.native-verifier.v1";
  source: "skillsbench";
  reward: number | null;
  passed: boolean | null;
  tests: number | null;
  passedTests: number | null;
  failedTests: number | null;
  failedTestNames: string[];
  failedAssertions: Array<{ name: string; message?: string; trace?: string }>;
  ctrfPath?: string;
}

interface AnalysisRecord {
  id: string;
  taskId: string;
  trialId: string;
  trialDir: string;
  skillPath: string;
  skillRelPath: string;
  mode: TrialMode;
  reward: number | null;
  passed: boolean | null;
  counts: Record<CoverageStatus, number>;
  totalConstraints: number;
  judgedReachable: number;
  noncomplianceRate: number;
  violationRate: number;
  ignoredRate: number;
  unknownRate: number;
  targetCounts?: Record<CoverageTarget, Record<CoverageStatus, number>>;
  analysisPath: string;
  nativeVerifier?: NativeVerifierSummary;
}

interface ConstraintAggregate {
  key: string;
  taskId: string;
  skillRelPath: string;
  statusCounts: Partial<Record<CoverageStatus, number>>;
  target: CoverageTarget;
  totalFailures: number;
  text: string;
  sourceSpan: string;
  exampleTrialIds: string[];
  exampleEvidenceEventIds: string[];
}

interface AnalysisAggregate {
  schemaVersion: "skillscope.skillsbench-violation-rates.v1";
  createdAt: string;
  plan: {
    agent: string;
    model: string;
    taskCount: number;
    trialsPerTask: number;
  };
  totals: RateAggregate;
  byTask: RateAggregate[];
  bySkill: RateAggregate[];
  repeatedFailures: ConstraintAggregate[];
  analyses: AnalysisRecord[];
  nativeVerifier: NativeVerifierAggregate;
}

interface NativeVerifierAggregate {
  analyses: number;
  trials: number;
  rewardPassRate: number | null;
  testPassRate: number | null;
  failedTests: number;
  totalTests: number;
}

interface RateAggregate {
  key: string;
  taskId?: string;
  skillRelPath?: string;
  analysisCount: number;
  trialCount: number;
  counts: Record<CoverageStatus, number>;
  totalConstraints: number;
  judgedReachable: number;
  noncomplianceRate: number;
  violationRate: number;
  ignoredRate: number;
  unknownRate: number;
  targetRates: Record<CoverageTarget, TargetRateAggregate>;
  passRate: number | null;
}

interface TargetRateAggregate {
  counts: Record<CoverageStatus, number>;
  totalConstraints: number;
  judgedReachable: number;
  noncomplianceRate: number;
  violationRate: number;
  ignoredRate: number;
  unknownRate: number;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "plan":
      await createRunPlan(options);
      return;
    case "collect":
      await collectTrials(options);
      return;
    case "analyze":
      await analyzeTrials(options);
      return;
    case "judge":
      await judgeTrials(options);
      return;
    case "propose":
      await proposeOptimizedSkills(options);
      return;
    case "rerun-plan":
      await createOptimizedRerunPlan(options);
      return;
    case "analysis-plan":
      await createOptimizedAnalysisPlan(options);
      return;
    case "remote-script":
      await createRemoteRunScript(options);
      return;
    default:
      printUsage();
  }
}

async function createRunPlan(options: CliOptions) {
  const root = requirePath(options.skillsbenchRoot, "--skillsbench-root");
  const outDir = path.resolve(options.out ?? ".skilllens/experiments/skillsbench-codex-gpt55");
  const tasks = await discoverTasks(root, options);
  const plan: SkillsBenchRunPlan = {
    schemaVersion: "skillscope.skillsbench-run-plan.v1",
    createdAt: new Date().toISOString(),
    skillsbenchRoot: path.resolve(root),
    agent: options.agent,
    model: options.model,
    trialsPerTask: options.trials,
    includeNoSkill: options.includeNoSkill,
    benchExtraArgs: options.benchExtraArgs,
    tasks
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "run-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(path.join(outDir, "run-original.sh"), renderOriginalRunScript(plan));
  await writeFile(path.join(outDir, "tasks.txt"), `${tasks.map((task) => task.id).join("\n")}\n`);
  await writeFile(path.join(outDir, "README.md"), renderExperimentReadme(plan));
  console.log(`Planned ${tasks.length} SkillsBench task(s) for ${options.agent}+${options.model}.`);
  console.log(`Wrote ${path.join(outDir, "run-plan.json")} and ${path.join(outDir, "run-original.sh")}`);
}

async function collectTrials(options: CliOptions) {
  const runsRoot = requirePath(options.runsRoot, "--runs-root");
  const outDir = path.resolve(options.out ?? ".skilllens/experiments/skillsbench-codex-gpt55/collected");
  const trials = await discoverTrialRecords(runsRoot, options);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "trials.json"), `${JSON.stringify(trials, null, 2)}\n`);
  await writeFile(path.join(outDir, "trials.md"), renderTrialsMarkdown(trials));
  console.log(`Collected ${trials.length} trial artifact(s).`);
  console.log(`Wrote ${path.join(outDir, "trials.json")}`);
}

async function analyzeTrials(options: CliOptions) {
  const planPath = requirePath(options.plan, "--plan");
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8")) as SkillsBenchRunPlan;
  const trials = options.trialsFile
    ? (JSON.parse(await readFile(path.resolve(options.trialsFile), "utf8")) as TrialRecord[])
    : await discoverTrialRecords(requirePath(options.runsRoot, "--runs-root"), options);
  const outDir = path.resolve(options.out ?? path.join(path.dirname(path.resolve(planPath)), "analysis"));
  const projectDir = path.join(outDir, "projects");
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const records: AnalysisRecord[] = [];
  const repeated = new Map<string, ConstraintAggregate>();

  await mkdir(projectDir, { recursive: true });
  for (const trial of trials.filter((candidate) => candidate.mode === "with")) {
    const task = taskById.get(trial.taskId);
    if (!task) {
      continue;
    }
    const trace = await readFile(trial.tracePath, "utf8");
    const taskText = existsSync(task.taskPath) ? await readFile(task.taskPath, "utf8") : "";
    const result = await readResult(trial.resultPath);
    const nativeVerifier = await readNativeVerifierSummary(trial);
    for (const skillPath of task.skillPaths) {
      const skill = await readFile(skillPath, "utf8");
      const project = createProject(
        `${trial.taskId} / ${path.basename(path.dirname(skillPath))} / ${trial.id}`,
        skill,
        trace,
        {
          ...result,
          task: trial.taskId,
          reward: trial.reward,
          success: trial.passed ?? undefined,
          agent: trial.agent,
          model: trial.model,
          skillMode: trial.skillMode,
          trialId: trial.id,
          nativeVerifier
        },
        "url",
        taskText,
        trial.dir
      );
      const rel = path.relative(task.taskDir, skillPath);
      const analysisPath = path.join(projectDir, `${safeName(trial.taskId)}__${safeName(trial.id)}__${safeName(rel)}.json`);
      await writeFile(analysisPath, exportAnalysisJson(project));
      const record = analysisRecordFromProject(project, trial, skillPath, rel, analysisPath);
      records.push(record);
      addRepeatedFailures(repeated, project, trial, rel);
    }
  }

  const aggregate = aggregateAnalyses(plan, records, [...repeated.values()]);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "violation-rates.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  await writeFile(path.join(outDir, "violation-rates.md"), renderViolationMarkdown(aggregate));
  console.log(`Analyzed ${records.length} skill/trial pair(s).`);
  console.log(`Wrote ${path.join(outDir, "violation-rates.json")} and ${path.join(outDir, "violation-rates.md")}`);
}

async function judgeTrials(options: CliOptions) {
  const planPath = requirePath(options.plan, "--plan");
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8")) as SkillsBenchRunPlan;
  const trials = options.trialsFile
    ? (JSON.parse(await readFile(path.resolve(options.trialsFile), "utf8")) as TrialRecord[])
    : await discoverTrialRecords(requirePath(options.runsRoot, "--runs-root"), options);
  const outDir = path.resolve(options.out ?? path.join(path.dirname(path.resolve(planPath)), "agent-analysis"));
  const projectDir = path.join(outDir, "projects");
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const records: AnalysisRecord[] = [];
  const repeated = new Map<string, ConstraintAggregate>();
  const jobs: Array<{
    trial: TrialRecord;
    skillPath: string;
    rel: string;
    project: SkillLensProject;
  }> = [];

  await mkdir(projectDir, { recursive: true });
  for (const trial of trials.filter((candidate) => candidate.mode === "with")) {
    const task = taskById.get(trial.taskId);
    if (!task) {
      continue;
    }
    const trace = await readFile(trial.tracePath, "utf8");
    const taskText = existsSync(task.taskPath) ? await readFile(task.taskPath, "utf8") : "";
    const result = await readResult(trial.resultPath);
    const nativeVerifier = await readNativeVerifierSummary(trial);
    for (const skillPath of task.skillPaths) {
      const skill = await readFile(skillPath, "utf8");
      const project = createProject(
        `${trial.taskId} / ${path.basename(path.dirname(skillPath))} / ${trial.id}`,
        skill,
        trace,
        {
          ...result,
          task: trial.taskId,
          reward: trial.reward,
          success: trial.passed ?? undefined,
          agent: trial.agent,
          model: trial.model,
          skillMode: trial.skillMode,
          trialId: trial.id,
          nativeVerifier
        },
        "url",
        taskText,
        trial.dir
      );
      const rel = path.relative(task.taskDir, skillPath);
      jobs.push({ trial, skillPath, rel, project });
    }
  }

  const selectedJobs = options.maxAgentAnalyses ? jobs.slice(0, options.maxAgentAnalyses) : jobs;
  const results = await runWithConcurrency(selectedJobs, options.agentConcurrency, async ({ trial, skillPath, rel, project }) => {
      const judged = await runSkillScopeAgentJudge(project, {
        outDir,
        taskId: trial.taskId,
        trialId: trial.id,
        skillRelPath: rel,
        force: options.force,
        timeoutMs: options.agentTimeoutMs
      });
      const judgedProject: SkillLensProject = {
        ...project,
        findings: judged.findings,
        result: {
          ...project.result,
          agentJudge: judged.audit,
          skillGraph: judged.skillGraph ?? undefined
        }
      };
      const analysisPath = path.join(projectDir, `${safeName(trial.taskId)}__${safeName(trial.id)}__${safeName(rel)}.json`);
      await writeFile(analysisPath, exportAnalysisJson(judgedProject));
      const record = analysisRecordFromProject(judgedProject, trial, skillPath, rel, analysisPath);
      console.log(
        `[judge] ${judged.cached ? "cache" : "agent"} ${trial.taskId}/${rel}: ${record.counts.covered} covered, ${record.counts.missed} missed, ${record.counts.violated} violated`
      );
      return { record, judgedProject, trial, rel };
  });

  for (const result of results) {
    records.push(result.record);
    addRepeatedFailures(repeated, result.judgedProject, result.trial, result.rel);
  }

  const aggregate = aggregateAnalyses(plan, records, [...repeated.values()]);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "violation-rates.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  await writeFile(path.join(outDir, "violation-rates.md"), renderViolationMarkdown(aggregate));
  console.log(`Agent-judged ${records.length} skill/trial pair(s).`);
  console.log(`Agent concurrency: ${options.agentConcurrency}`);
  console.log(`Wrote ${path.join(outDir, "violation-rates.json")} and ${path.join(outDir, "violation-rates.md")}`);
}

interface AgentJudgeRunResult {
  cached: boolean;
  findings: CoverageFinding[];
  skillGraph: SkillGraphArtifact | null;
  audit: {
    requestId: string;
    workDir: string;
    requestPath: string;
    promptPath: string;
    constraintsPath: string;
    nativeVerifierPath: string;
    skillGraphPath: string;
    traceFactsPath: string;
    findingsPath: string;
    rawOutputPath: string;
  };
}

async function runSkillScopeAgentJudge(
  project: SkillLensProject,
  options: {
    outDir: string;
    taskId: string;
    trialId: string;
    skillRelPath: string;
    force: boolean;
    timeoutMs: number;
  }
): Promise<AgentJudgeRunResult> {
  const analyzerVersion = "skillscope-analyzer-native-target-reference-hints";
  const cacheKey = sha256(
    JSON.stringify({
      analyzerVersion,
      taskId: options.taskId,
      trialId: options.trialId,
      skillRelPath: options.skillRelPath,
      skill: sha256(project.skillMarkdown),
      trace: sha256(project.traceText),
      task: sha256(project.taskMarkdown ?? ""),
      nativeVerifier: sha256(JSON.stringify(project.result.nativeVerifier ?? buildFallbackNativeVerifier(project.result)))
    })
  ).slice(0, 16);
  const requestId = `skillsbench-${safeName(options.taskId)}-${safeName(options.trialId)}-${cacheKey}`;
  const workDir = path.join(
    path.resolve(options.outDir),
    "agent-judge",
    safeName(options.taskId),
    safeName(options.trialId),
    `${safeName(options.skillRelPath)}-${cacheKey}`
  );
  const analyzerSkillPath = path.join(process.cwd(), "skills", "skillscope-analyzer", "SKILL.md");
  const requestPath = path.join(workDir, "request.json");
  const promptPath = path.join(workDir, "prompt.txt");
  const selectedSkillPath = path.join(workDir, "selected-skill.md");
  const skillUnitsPath = path.join(workDir, "skill-units.json");
  const constraintSeedPath = path.join(workDir, "constraint-seed.json");
  const constraintsPath = path.join(workDir, "constraints.json");
  const traceEventsPath = path.join(workDir, "trace-events.json");
  const traceFactsPath = path.join(workDir, "trace-facts.json");
  const nativeVerifierPath = path.join(workDir, "native-verifier.json");
  const rawTracePath = path.join(workDir, "selected-trace.jsonl");
  const taskPath = path.join(workDir, "task.md");
  const progressPath = path.join(workDir, "progress.md");
  const skillGraphPath = path.join(workDir, "skill-graph.json");
  const optimizedSkillPath = path.join(workDir, "optimized-skill.md");
  const findingsPath = path.join(workDir, "findings.json");
  const responsePath = path.join(workDir, "response.json");
  const rawOutputPath = path.join(workDir, "agent-output.txt");
  const errorPath = path.join(workDir, "analysis-error.txt");
  const codexLastMessagePath = path.join(workDir, "codex-last-message.json");
  const audit = {
    requestId,
    workDir,
    requestPath,
    promptPath,
    constraintsPath,
    nativeVerifierPath,
    skillGraphPath,
    traceFactsPath,
    findingsPath,
    rawOutputPath
  };

  if (!options.force && existsSync(findingsPath)) {
    const findings = normalizeCachedAgentFindings(await readFile(findingsPath, "utf8"), project, requestId);
    const skillGraph = await readSkillGraphArtifact(skillGraphPath, project);
    return { cached: true, findings, skillGraph, audit };
  }

  await mkdir(workDir, { recursive: true });
  const request = createAgentJudgeRequest(project, {
    requestId,
    agentProduct: "codex"
  });
  const constraintSeed = buildConstraintSeed(project);
  const prompt = buildBatchAnalyzerPrompt({
    request,
    analyzerSkillPath,
    workDir,
    selectedSkillPath,
    skillUnitsPath,
    constraintSeedPath,
    traceEventsPath,
    traceFactsPath,
    nativeVerifierPath,
    rawTracePath,
    taskPath,
    progressPath,
    constraintsPath,
    skillGraphPath,
    optimizedSkillPath,
    findingsPath
  });
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  await writeFile(promptPath, prompt);
  await writeFile(selectedSkillPath, project.skillMarkdown);
  await writeFile(skillUnitsPath, `${JSON.stringify(project.units, null, 2)}\n`);
  await writeFile(constraintSeedPath, `${JSON.stringify({ constraints: constraintSeed }, null, 2)}\n`);
  await writeFile(constraintsPath, `${JSON.stringify({ constraints: constraintSeed }, null, 2)}\n`);
  await writeFile(traceEventsPath, `${JSON.stringify(project.events, null, 2)}\n`);
  await writeFile(traceFactsPath, `${JSON.stringify({ schemaVersion: "skilllens.trace-facts.v1", facts: [], indexes: {} }, null, 2)}\n`);
  await writeFile(nativeVerifierPath, `${JSON.stringify(project.result.nativeVerifier ?? buildFallbackNativeVerifier(project.result), null, 2)}\n`);
  await writeFile(rawTracePath, project.traceText);
  await writeFile(taskPath, project.taskMarkdown ?? "");
  await writeFile(progressPath, "");
  await writeFile(skillGraphPath, `${JSON.stringify({ schemaVersion: "skilllens.skill-graph.v1", requestId, nodes: [], edges: [], paths: [] }, null, 2)}\n`);
  await writeFile(optimizedSkillPath, "");

  let commandResult: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  let lastMessage = "";
  let analyzerError: Error | null = null;
  try {
    commandResult = await runCodexAnalyzer(prompt, {
      workDir,
      outputLastMessagePath: codexLastMessagePath,
      timeoutMs: options.timeoutMs
    });
    lastMessage = existsSync(codexLastMessagePath) ? await readFile(codexLastMessagePath, "utf8") : "";
  } catch (error) {
    analyzerError = error instanceof Error ? error : new Error(String(error));
    lastMessage = existsSync(codexLastMessagePath) ? await readFile(codexLastMessagePath, "utf8") : "";
    await writeFile(errorPath, `${analyzerError.message}\n`);
  }
  const rawOutput = [commandResult.stdout, commandResult.stderr, lastMessage, analyzerError?.message].filter(Boolean).join("\n");
  await writeFile(rawOutputPath, rawOutput);

  const rawAnalysis = lastMessage || commandResult.stdout || commandResult.stderr;
  const response = existsSync(findingsPath)
    ? parseAgentJudgeResponse(await readFile(findingsPath, "utf8"), requestId)
    : parseAgentJudgeResponse(rawAnalysis, requestId);
  const extractedConstraints = await readExtractedConstraintsArtifact(constraintsPath, project);
  const pendingFindings = extractedConstraints.length
    ? constraintsToPendingFindings(project, extractedConstraints, requestId)
    : project.findings;
  const judgedFindings = response.judgments.length ? applyAgentJudgeResponse(project, response) : [];
  const findings = judgedFindings.length ? mergePendingAndJudgedFindings(pendingFindings, judgedFindings) : pendingFindings;
  const skillGraph = await readSkillGraphArtifact(skillGraphPath, project);
  await writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`);
  await writeFile(findingsPath, `${JSON.stringify(findings, null, 2)}\n`);
  await writeFile(
    path.join(workDir, "analysis-result.json"),
    `${JSON.stringify({ requestId, findingsPath, responsePath, skillGraphPath, rawOutputPath, findingCount: findings.length }, null, 2)}\n`
  );
  return { cached: false, findings, skillGraph, audit };
}

function buildBatchAnalyzerPrompt(input: {
  request: ReturnType<typeof createAgentJudgeRequest>;
  analyzerSkillPath: string;
  workDir: string;
  selectedSkillPath: string;
  skillUnitsPath: string;
  constraintSeedPath: string;
  traceEventsPath: string;
  traceFactsPath: string;
  nativeVerifierPath: string;
  rawTracePath: string;
  taskPath: string;
  progressPath: string;
  constraintsPath: string;
  skillGraphPath: string;
  optimizedSkillPath: string;
  findingsPath: string;
}): string {
  return `You were launched by SkillScope's SkillsBench batch experiment.

Scope: analyze only the selected SkillsBench trial and skill file described by these local files.

Use this analyzer skill and follow its workflow:
${input.analyzerSkillPath}

First read the analyzer skill completely. Then read these artifacts:
- Selected skill markdown: ${input.selectedSkillPath}
- Normalized skill units: ${input.skillUnitsPath}
- Constraint seed extracted from the selected skill: ${input.constraintSeedPath}
- Normalized trace events: ${input.traceEventsPath}
- Trace facts artifact to write: ${input.traceFactsPath}
- Native verifier / CTRF evidence: ${input.nativeVerifierPath}
- Raw selected trace: ${input.rawTracePath}
- Task/context markdown: ${input.taskPath}
- Request metadata: ${path.join(input.workDir, "request.json")}

Write working artifacts here:
- Progress notes: ${input.progressPath}
- Extracted constraints for precise highlighting: ${input.constraintsPath}
- Trace fact table / event IR: ${input.traceFactsPath}
- Skill graph with conditions, branches, and trace path: ${input.skillGraphPath}
- Coverage findings: ${input.findingsPath}
- Reserved optimizer output path: ${input.optimizedSkillPath}

Important:
- Start from constraint-seed.json. Review, split, merge true duplicates, and add missing observable constraints.
- Write constraints.json early, then skill-graph.json, then trace-facts.json, then findings.json.
- Use a program-analysis workflow: skill source -> constraint/control-flow graph; trace events -> trace facts; graph x facts -> covered, violated, missed, not_applicable, unknown.
- Use native-verifier.json as hard deterministic evidence for final-output/artifact contracts. If the native verifier passes, treat final-output constraints as satisfied by verifier evidence and separate any remaining trace uncertainty as a process-adherence gap.
- Classify each extracted constraint with a target when possible: "final_output", "artifact", "process", "tool_use", "reporting", or "unknown".
- Validation-order rules such as "validate before writing" or "run checks before final answer" are process/tool-use constraints, not final-output constraints. Native verifier pass proves artifact validity, not validation ordering.
- Keep all observable mandatory/prohibited/order/validation/final-output constraints. A long skill should produce a complete check plan rather than only the most salient examples.
- findings.json should contain one finding for every extracted constraint. Use "unknown" if evidence was not inspected enough.
- Distinguish missed from violated: absence of required behavior is missed; explicit conflicting behavior is violated.
- This pass is analysis only. Leave optimized-skill.md untouched; SkillScope's propose command launches the optimizer skill after findings.json is saved.
- Cite real event IDs from trace-events.json. Evidence IDs should come from the selected trace.
- Use only local evidence; web search and network access are outside this analysis scope.
- Write only artifacts in the work directory above.
- Final response can be Markdown and does not need a strict schema.

Request summary:
${JSON.stringify(input.request.project, null, 2)}
`;
}

function buildConstraintSeed(project: SkillLensProject) {
  return project.units.flatMap((unit) => {
    const constraints = unit.constraints.length
      ? unit.constraints
      : unit.observable
        ? [
            {
              id: `${unit.id}.seed`,
              kind: "other",
              text: unit.text,
              span: {
                lineStart: unit.lineStart,
                lineEnd: unit.lineEnd,
                charStart: 0,
                charEnd: unit.text.length,
                text: unit.text
              },
              severity: unit.modality === "prohibited" ? "must_not" : unit.modality === "recommended" ? "should" : "info"
            }
          ]
        : [];
    return constraints.filter((constraint) => isUsefulConstraintSeed(constraint)).map((constraint) => ({
      id: constraint.id,
      unitId: unit.id,
      kind: constraint.kind,
      text: constraint.text,
      severity: constraint.severity,
      sourceSpan: constraint.span,
      rationale: "Seed constraint from SkillScope's markdown parser; analyzer agent should review and refine this before judging trace evidence."
    }));
  });
}

function isUsefulConstraintSeed(constraint: { kind: string; text: string; severity: string }): boolean {
  const text = constraint.text.trim();
  if (!text || /^```/.test(text)) {
    return false;
  }
  if (/^(run|use|after|before|created or updated)\s*:?.?$/i.test(text)) {
    return false;
  }
  if (text.length < 8 && constraint.kind !== "numeric") {
    return false;
  }
  if (constraint.severity === "info" && constraint.kind === "action" && text.length < 32) {
    return false;
  }
  return true;
}

async function readExtractedConstraintsArtifact(constraintsPath: string, project: SkillLensProject) {
  if (!existsSync(constraintsPath)) {
    return [];
  }
  try {
    return parseAgentConstraintsResponse(await readFile(constraintsPath, "utf8"), project);
  } catch {
    return [];
  }
}

function normalizeCachedAgentFindings(text: string, project: SkillLensProject, requestId: string): CoverageFinding[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed.every(isInternalCoverageFindingLike)) {
      return parsed as CoverageFinding[];
    }
  } catch {
    // Fall through to the tolerant agent response parser.
  }
  const response = parseAgentJudgeResponse(text, requestId);
  const findings = response.judgments.length ? applyAgentJudgeResponse(project, response) : [];
  return findings.length ? findings : project.findings;
}

function isInternalCoverageFindingLike(value: unknown): value is CoverageFinding {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { unitId?: unknown }).unitId === "string" &&
      typeof (value as { status?: unknown }).status === "string" &&
      Array.isArray((value as { evidenceEventIds?: unknown }).evidenceEventIds)
  );
}

async function readSkillGraphArtifact(skillGraphPath: string, project: SkillLensProject): Promise<SkillGraphArtifact | null> {
  if (!existsSync(skillGraphPath)) {
    return null;
  }
  try {
    return parseAgentSkillGraphResponse(await readFile(skillGraphPath, "utf8"), project);
  } catch {
    return null;
  }
}

function mergePendingAndJudgedFindings(
  pendingFindings: CoverageFinding[],
  judgedFindings: CoverageFinding[]
): CoverageFinding[] {
  const pendingByKey = new Map<string, CoverageFinding>();
  pendingFindings.forEach((finding) => {
    findingDisplayKeys(finding).forEach((key) => {
      if (!pendingByKey.has(key)) {
        pendingByKey.set(key, finding);
      }
    });
  });
  const refinedJudgedFindings = judgedFindings.map((finding) => {
    const matchingPending = findingDisplayKeys(finding).map((key) => pendingByKey.get(key)).find(Boolean);
    if (!matchingPending?.analyzedConstraint?.span || !finding.analyzedConstraint) {
      return finding;
    }
    return {
      ...finding,
      analyzedConstraint: {
        ...finding.analyzedConstraint,
        span: matchingPending.analyzedConstraint.span
      }
    };
  });
  const seen = new Set(refinedJudgedFindings.flatMap(findingDisplayKeys));
  const missingPending = pendingFindings.filter((finding) => {
    const keys = findingDisplayKeys(finding);
    if (keys.some((key) => seen.has(key))) {
      return false;
    }
    keys.forEach((key) => seen.add(key));
    return true;
  });
  return [...refinedJudgedFindings, ...missingPending];
}

function findingDisplayKeys(finding: CoverageFinding): string[] {
  const keys: string[] = [];
  const text = normalizeFindingText(finding.analyzedConstraint?.text ?? finding.analyzedConstraint?.span.text ?? finding.rationale);
  if (text) {
    keys.push(`text:${finding.unitId}:${text}`);
  }
  const span = finding.analyzedConstraint?.span;
  if (span) {
    keys.push(`span:${finding.unitId}:${span.lineStart}:${span.lineEnd}:${span.charStart}:${span.charEnd}`);
    keys.push(`line-text:${finding.unitId}:${span.lineStart}:${span.lineEnd}:${text}`);
  }
  if (finding.constraintId) {
    keys.push(`constraint:${finding.unitId}:${finding.constraintId}`);
  }
  return keys.length ? keys : [`finding:${finding.unitId}:${finding.id}`];
}

function normalizeFindingText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

async function runCodexAnalyzer(
  prompt: string,
  options: { workDir: string; outputLastMessagePath: string; timeoutMs: number }
): Promise<{ stdout: string; stderr: string }> {
  return runCommandWithInput(
    "codex",
    [
      "exec",
      "--cd",
      process.cwd(),
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "danger-full-access",
      "--json",
      "-o",
      options.outputLastMessagePath,
      "-"
    ],
    prompt,
    process.cwd(),
    path.join(options.workDir, "agent-stream.jsonl"),
    options.timeoutMs
  );
}

async function runCommandWithInput(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  streamPath?: string,
  timeoutMs = 0
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const streamChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      streamChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      streamChunks.push(chunk);
    });
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        killChildProcessGroup(child.pid, "SIGTERM");
        setTimeout(() => {
          if (!settled) {
            killChildProcessGroup(child.pid, "SIGKILL");
          }
        }, 5000).unref();
      }, timeoutMs);
      timer.unref();
    }
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", async (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (settled) {
        return;
      }
      settled = true;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (streamPath) {
        await writeFile(streamPath, Buffer.concat(streamChunks));
      }
      if ((code && code !== 0) || signal) {
        const timedOut = timeoutMs > 0 && signal === "SIGTERM";
        const reason = timedOut ? `timed out after ${timeoutMs}ms` : signal ? `failed with signal ${signal}` : `failed with exit ${code}`;
        reject(new Error(`${command} ${args.join(" ")} ${reason}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function killChildProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}

async function proposeOptimizedSkills(options: CliOptions) {
  const planPath = requirePath(options.plan, "--plan");
  const analysisPath = requirePath(options.analysis, "--analysis");
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8")) as SkillsBenchRunPlan;
  const aggregate = JSON.parse(await readFile(path.resolve(analysisPath), "utf8")) as AnalysisAggregate;
  const outRoot = path.resolve(options.out ?? path.join(path.dirname(path.resolve(planPath)), "optimized-skills"));
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  const recordsByTaskSkill = groupAnalysisRecordsForOptimization(aggregate.analyses, options);
  const patches: Record<string, unknown> = {};
  const jobs: Array<{
    key: string;
    records: AnalysisRecord[];
    task: TaskPlan;
    originalSkillPath: string;
    targetSkillPath: string;
  }> = [];

  await mkdir(outRoot, { recursive: true });
  for (const task of plan.tasks) {
    const targetSkillsDir = path.join(outRoot, task.id, "environment", "skills");
    await mkdir(path.dirname(targetSkillsDir), { recursive: true });
    await cp(task.skillsDir, targetSkillsDir, { recursive: true, force: true });
  }

  for (const [key, records] of recordsByTaskSkill) {
    const gate = optimizationCandidateGate(records, options);
    if (!gate.optimize) {
      patches[key] = {
        passThroughReason: gate.reason,
        skipped: gate.reason,
        recordCount: records.length,
        totalFailures: records.reduce((sum, record) => sum + record.counts.missed + record.counts.violated, 0),
        noncomplianceRate: gate.noncomplianceRate,
        nativeFailed: gate.nativeFailed,
        finalArtifactFailures: gate.finalArtifactFailures,
        processOnlyFailures: gate.processOnlyFailures
      };
      console.log(`[propose] pass-through ${key}: ${gate.reason}`);
      continue;
    }
    const [taskId, skillRelPath] = key.split("::");
    const task = tasksById.get(taskId);
    if (!task) {
      continue;
    }
    const skillPaths = resolveOptimizationSkillPaths(task, skillRelPath, outRoot);
    if (!skillPaths) {
      patches[key] = { skipped: "could not resolve original or target skill path", recordCount: records.length };
      continue;
    }
    const { originalSkillPath, targetSkillPath } = skillPaths;
    if (!existsSync(originalSkillPath) || !existsSync(targetSkillPath)) {
      patches[key] = {
        skipped: "missing original or target skill path",
        recordCount: records.length,
        originalSkillPath,
        targetSkillPath
      };
      continue;
    }
    jobs.push({ key, records, task, originalSkillPath, targetSkillPath });
  }

  const selectedJobs = options.maxAgentAnalyses ? jobs.slice(0, options.maxAgentAnalyses) : jobs;
  await runWithConcurrency(selectedJobs, options.agentConcurrency, async ({ key, records, task, originalSkillPath, targetSkillPath }) => {
    const prepared = await prepareFrameworkOptimizationInput({
      outRoot,
      key,
      records,
      task,
      originalSkillPath
    });
    if (!prepared) {
      patches[key] = { skipped: "missing agent-judge IR artifacts", recordCount: records.length };
      return;
    }
    const optimized = await runFrameworkSkillOptimizerForBatch({
      prepared,
      targetSkillPath,
      force: options.force,
      timeoutMs: options.agentTimeoutMs,
      maxEditsPerSkill: options.maxEditsPerSkill
    });
    patches[key] = {
      cached: optimized.cached,
      recordCount: records.length,
      totalFailures: records.reduce((sum, record) => sum + record.counts.missed + record.counts.violated, 0),
      optimizedSkillPath: optimized.optimizedSkillPath,
      optimizationReportPath: optimized.optimizationReportPath,
      optimizationDiffPath: optimized.optimizationDiffPath,
      optimizationPacketPath: optimized.optimizationPacketPath
    };
    console.log(`[propose] ${optimized.cached ? "cache" : "agent"} ${key}: ${optimized.optimizedSkillPath}`);
  });

  await writeFile(path.join(outRoot, "skill-patches.json"), `${JSON.stringify(patches, null, 2)}\n`);
  await writeFile(path.join(outRoot, "skill-patches.md"), renderFrameworkPatchSummary(patches));
  console.log(`Wrote framework-optimized skill candidates under ${outRoot}`);
  console.log(`Agent concurrency: ${options.agentConcurrency}`);
  console.log("Optimizer candidates and pass-through decisions were based on SkillScope constraints/graph/trace-facts/findings artifacts.");
}

async function createOptimizedRerunPlan(options: CliOptions) {
  const planPath = requirePath(options.plan, "--plan");
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8")) as SkillsBenchRunPlan;
  const optimizedRoot = requirePath(options.optimizedSkillsRoot, "--optimized-skills-root");
  const outDir = path.resolve(options.out ?? path.dirname(path.resolve(planPath)));
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "run-optimized.sh"), renderOptimizedRunScript(plan, path.resolve(optimizedRoot)));
  console.log(`Wrote ${path.join(outDir, "run-optimized.sh")}`);
}

async function createOptimizedAnalysisPlan(options: CliOptions) {
  const planPath = requirePath(options.plan, "--plan");
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8")) as SkillsBenchRunPlan;
  const optimizedRoot = path.resolve(requirePath(options.optimizedSkillsRoot, "--optimized-skills-root"));
  const outDir = path.resolve(options.out ?? path.join(path.dirname(path.resolve(planPath)), "optimized-analysis"));
  const tasks = plan.tasks.map((task) => {
    const optimizedSkillsDir = path.join(optimizedRoot, task.id, "environment", "skills");
    const skillPaths = task.skillPaths
      .map((skillPath) => relativeSkillPathWithinSkillsDir(task, skillPath))
      .filter((relativePath): relativePath is string => Boolean(relativePath))
      .map((relativePath) => path.join(optimizedSkillsDir, relativePath));
    return {
      ...task,
      skillsDir: optimizedSkillsDir,
      skillPaths
    };
  });
  const analysisPlan: SkillsBenchRunPlan = {
    ...plan,
    createdAt: new Date().toISOString(),
    tasks
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "run-plan.json"), `${JSON.stringify(analysisPlan, null, 2)}\n`);
  console.log(`Wrote optimized analysis plan to ${path.join(outDir, "run-plan.json")}`);
}

async function createRemoteRunScript(options: CliOptions) {
  const planPath = requirePath(options.plan, "--plan");
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8")) as SkillsBenchRunPlan;
  const outDir = path.resolve(options.out ?? path.dirname(path.resolve(planPath)));
  const scriptPath = path.join(outDir, "run-remote-original.sh");
  await mkdir(outDir, { recursive: true });
  await writeFile(scriptPath, renderRemoteRunScript(plan, path.basename(outDir), options));
  await chmod(scriptPath, 0o755);
  console.log(`Wrote ${scriptPath}`);
}

async function discoverTasks(rootValue: string, options: CliOptions): Promise<TaskPlan[]> {
  const root = path.resolve(rootValue);
  const tasksRoot = existsSync(path.join(root, "tasks")) ? path.join(root, "tasks") : root;
  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const tasks: TaskPlan[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const taskDir = path.join(tasksRoot, entry.name);
    const taskPath = path.join(taskDir, "task.md");
    const skillsDir = path.join(taskDir, "environment", "skills");
    if (!existsSync(taskPath) || !existsSync(skillsDir)) {
      continue;
    }
    if (options.taskIds.length && !options.taskIds.includes(entry.name)) {
      continue;
    }
    const skillPaths = await findFiles(skillsDir, (file) => path.basename(file) === "SKILL.md");
    if (!skillPaths.length) {
      continue;
    }
    tasks.push({ id: entry.name, taskDir, taskPath, skillsDir, skillPaths });
  }
  const sorted = tasks.sort((left, right) => left.id.localeCompare(right.id));
  return typeof options.maxTasks === "number" ? sorted.slice(0, options.maxTasks) : sorted;
}

async function discoverTrialRecords(rootValue: string, options: CliOptions): Promise<TrialRecord[]> {
  const root = path.resolve(rootValue);
  const configPaths = await findFiles(root, (file) => path.basename(file) === "config.json");
  const trials: TrialRecord[] = [];
  for (const configPath of configPaths) {
    const dir = path.dirname(configPath);
    const resultPath = path.join(dir, "result.json");
    const tracePath = path.join(dir, "trajectory", "acp_trajectory.jsonl");
    if (!hasNonEmptyFile(tracePath)) {
      continue;
    }
    const config = await readJson(configPath);
    const result = existsSync(resultPath) ? await readJson(resultPath) : {};
    const taskId = taskIdFrom(config, result, dir);
    if (!taskId || (options.taskIds.length && !options.taskIds.includes(taskId))) {
      continue;
    }
    const record: TrialRecord = {
      id: trialIdFrom(result, dir),
      dir,
      taskId,
      agent: stringFrom(config.agent ?? result.agent),
      model: normalizeModelName(stringFrom(config.model ?? result.model)),
      mode: modeFrom(result.skill_mode ?? config.skill_mode),
      skillMode: stringFrom(result.skill_mode ?? config.skill_mode),
      reward: scoreFrom(result),
      passed: passedFrom(result),
      nSkillInvocations: numberFrom(result.n_skill_invocations ?? result.agent_result?.n_skill_invocations),
      configPath,
      resultPath,
      tracePath
    };
    if (options.agent && record.agent && !agentMatches(record.agent, options.agent)) {
      continue;
    }
    if (options.model && record.model && record.model !== normalizeModelName(options.model)) {
      continue;
    }
    trials.push(record);
  }
  return dedupeTrialAttempts(root, trials).sort((left, right) => `${left.taskId}/${left.id}`.localeCompare(`${right.taskId}/${right.id}`));
}

async function readNativeVerifierSummary(trial: TrialRecord): Promise<NativeVerifierSummary> {
  const ctrfPath = path.join(trial.dir, "verifier", "ctrf.json");
  const summary: NativeVerifierSummary = {
    schemaVersion: "skilllens.native-verifier.v1",
    source: "skillsbench",
    reward: trial.reward,
    passed: trial.passed,
    tests: null,
    passedTests: null,
    failedTests: null,
    failedTestNames: [],
    failedAssertions: [],
    ctrfPath: existsSync(ctrfPath) ? ctrfPath : undefined
  };
  if (!existsSync(ctrfPath)) {
    return summary;
  }
  try {
    const ctrf = await readJson(ctrfPath);
    const results = objectFrom(ctrf.results);
    const ctrfSummary = objectFrom(results.summary);
    summary.tests = numberFrom(ctrfSummary.tests);
    summary.passedTests = numberFrom(ctrfSummary.passed);
    summary.failedTests = numberFrom(ctrfSummary.failed);
    const tests = Array.isArray(results.tests) ? results.tests : [];
    summary.failedAssertions = tests
      .map((entry) => objectFrom(entry))
      .filter((entry) => stringFrom(entry.status) && stringFrom(entry.status) !== "passed")
      .map((entry) => ({
        name: stringFrom(entry.name) || "unknown",
        message: stringFrom(entry.message) || undefined,
        trace: stringFrom(entry.trace) || undefined
      }));
    summary.failedTestNames = summary.failedAssertions.map((failure) => failure.name);
  } catch {
    // Keep result.json reward/pass even if CTRF is malformed.
  }
  return summary;
}

function buildFallbackNativeVerifier(result: ProjectResult): NativeVerifierSummary {
  const reward = numberFrom(result.reward ?? result.score);
  const passed = typeof result.success === "boolean" ? result.success : reward !== null ? reward >= 1 : null;
  return {
    schemaVersion: "skilllens.native-verifier.v1",
    source: "skillsbench",
    reward,
    passed,
    tests: null,
    passedTests: null,
    failedTests: null,
    failedTestNames: [],
    failedAssertions: []
  };
}

function dedupeTrialAttempts(root: string, trials: TrialRecord[]): TrialRecord[] {
  const byLogicalTrial = new Map<string, TrialRecord>();
  for (const trial of trials) {
    const key = logicalTrialKey(root, trial);
    const previous = byLogicalTrial.get(key);
    if (!previous || compareTrialAttemptQuality(trial, previous) > 0) {
      byLogicalTrial.set(key, trial);
    }
  }
  return [...byLogicalTrial.values()];
}

function logicalTrialKey(root: string, trial: TrialRecord): string {
  const relativeParts = path.relative(root, trial.dir).split(path.sep).filter(Boolean);
  const trialPartIndex = relativeParts.findIndex((part) => /^trial-\d+$/i.test(part));
  if (trialPartIndex > 0) {
    return relativeParts.slice(0, trialPartIndex + 1).join("/");
  }
  return `${trial.mode}/${trial.taskId}/${trial.id}`;
}

function compareTrialAttemptQuality(left: TrialRecord, right: TrialRecord): number {
  const leftScore = trialAttemptScore(left);
  const rightScore = trialAttemptScore(right);
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  return modifiedTimeMs(left.resultPath) - modifiedTimeMs(right.resultPath);
}

function trialAttemptScore(trial: TrialRecord): number {
  let score = 0;
  if (trial.passed !== null || trial.reward !== null) {
    score += 100;
  }
  if (existsSync(trial.resultPath)) {
    score += 10;
  }
  if (existsSync(trial.tracePath)) {
    score += 1;
  }
  return score;
}

function modifiedTimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function hasNonEmptyFile(filePath: string): boolean {
  try {
    return statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

async function findFiles(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  if (existsSync(root) && (await stat(root)).isDirectory()) {
    await walk(root);
  }
  return files.sort();
}

function renderOriginalRunScript(plan: SkillsBenchRunPlan): string {
  return renderShellScript([
    "# Run original SkillsBench skills with the selected agent/model.",
    "# Generated by SkillScope. Review credentials, sandbox flags, and BenchFlow version before running.",
    ...plan.tasks.flatMap((task) => {
      const commands: string[] = [];
      for (let trial = 1; trial <= plan.trialsPerTask; trial += 1) {
        commands.push(
          "",
          `# ${task.id} original with-skill trial ${trial}/${plan.trialsPerTask}`,
          runTrialCommand(
            "original",
            task.id,
            trial,
            benchCommand(plan, task.taskDir, "original", task.id, trial, ["--skill-mode", "with-skill", "--skills-dir", task.skillsDir])
          )
        );
        if (plan.includeNoSkill) {
          commands.push(
            "",
            `# ${task.id} no-skill trial ${trial}/${plan.trialsPerTask}`,
            runTrialCommand(
              "no-skill",
              task.id,
              trial,
              benchCommand(plan, task.taskDir, "no-skill", task.id, trial, ["--skill-mode", "no-skill"])
            )
          );
        }
      }
      return commands;
    })
  ]);
}

function renderOptimizedRunScript(plan: SkillsBenchRunPlan, optimizedRoot: string): string {
  return renderShellScript([
    "# Run optimized SkillScope skill candidates.",
    "# Review optimized skill diffs before running scored trials.",
    ...plan.tasks.flatMap((task) => {
      const optimizedSkillsDir = path.join(optimizedRoot, task.id, "environment", "skills");
      const commands: string[] = [];
      for (let trial = 1; trial <= plan.trialsPerTask; trial += 1) {
        commands.push(
          "",
          `# ${task.id} optimized with-skill trial ${trial}/${plan.trialsPerTask}`,
          runTrialCommand(
            "optimized",
            task.id,
            trial,
            benchCommand(plan, task.taskDir, "optimized", task.id, trial, ["--skill-mode", "with-skill", "--skills-dir", optimizedSkillsDir])
          )
        );
      }
      return commands;
    })
  ]);
}

function resolveOptimizationSkillPaths(
  task: TaskPlan,
  skillRelPath: string,
  outRoot: string
): { originalSkillPath: string; targetSkillPath: string } | null {
  const originalSkillPath = path.resolve(task.taskDir, skillRelPath);
  if (!existsSync(originalSkillPath)) {
    return null;
  }

  const skillsDir = path.resolve(task.skillsDir);
  const originalResolved = path.resolve(originalSkillPath);
  const relativeToSkillsDir = relativeSkillPathWithinSkillsDir(task, originalResolved);
  if (!relativeToSkillsDir) {
    return null;
  }

  return {
    originalSkillPath,
    targetSkillPath: path.join(outRoot, task.id, "environment", "skills", relativeToSkillsDir)
  };
}

function relativeSkillPathWithinSkillsDir(task: TaskPlan, skillPath: string): string | null {
  const skillsDir = path.resolve(task.skillsDir);
  const resolved = path.resolve(skillPath);
  let relativeToSkillsDir = path.relative(skillsDir, resolved);
  if (relativeToSkillsDir.startsWith("..") || path.isAbsolute(relativeToSkillsDir)) {
    const marker = `${path.sep}environment${path.sep}skills${path.sep}`;
    const markerIndex = resolved.lastIndexOf(marker);
    if (markerIndex < 0) {
      return null;
    }
    relativeToSkillsDir = resolved.slice(markerIndex + marker.length);
  }
  return relativeToSkillsDir;
}

function runTrialCommand(condition: string, taskId: string, trial: number, command: string): string {
  return `run_trial ${shellQuote(condition)} ${shellQuote(taskId)} ${shellQuote(String(trial))} ${command}`;
}

function benchCommand(
  plan: SkillsBenchRunPlan,
  taskDir: string,
  condition: string,
  taskId: string,
  trial: number,
  conditionArgs: string[]
): string {
  const jobsDirExpr = `"${"$"}SCRIPT_DIR/jobs/${safeName(condition)}/${safeName(taskId)}/trial-${trial}"`;
  return [
    "bench",
    "eval",
    "run",
    "--tasks-dir",
    shellQuote(taskDir),
    "--agent",
    shellQuote(plan.agent),
    "--model",
    shellQuote(plan.model),
    "--jobs-dir",
    jobsDirExpr,
    ...codexHostProviderArgs(plan),
    ...conditionArgs.map(shellQuoteIfNeeded),
    ...plan.benchExtraArgs.map(shellQuoteIfNeeded)
  ].join(" ");
}

function codexHostProviderArgs(plan: SkillsBenchRunPlan): string[] {
  if (!plan.agent.toLowerCase().includes("codex")) {
    return [];
  }
  return ['"${SKILLSCOPE_BENCH_AGENT_ENV_ARGS[@]}"'];
}

function renderShellScript(lines: string[]): string {
  return `#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${"${BASH_SOURCE[0]}"}")" && pwd)"
mkdir -p "$SCRIPT_DIR/logs" "$SCRIPT_DIR/status" "$SCRIPT_DIR/jobs"

SKILLSCOPE_BENCH_AGENT_ENV_ARGS=()

configure_codex_host_provider() {
  if [[ "${"${SKILLSCOPE_SKIP_CODEX_ENV:-0}"}" == "1" ]]; then
    return 0
  fi

  local codex_home="${"${CODEX_HOME:-$HOME/.codex}"}"
  local auth_path="$codex_home/auth.json"
  local config_path="$codex_home/config.toml"

  if [[ -z "${"${OPENAI_API_KEY:-}"}" && -f "$auth_path" ]]; then
    local auth_key
    auth_key="$(node -e 'const fs=require("fs"); const p=process.argv[1]; const data=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(data.OPENAI_API_KEY || "");' "$auth_path" 2>/dev/null || true)"
    if [[ -n "$auth_key" ]]; then
      export OPENAI_API_KEY="$auth_key"
    fi
  fi

  if [[ -f "$config_path" ]]; then
    local provider_info
    provider_info="$(python - "$config_path" <<'PY' 2>/dev/null || true
import sys
try:
    import tomllib
except Exception:
    raise SystemExit(0)

with open(sys.argv[1], "rb") as handle:
    config = tomllib.load(handle)

provider_id = str(config.get("model_provider") or "")
provider = (config.get("model_providers") or {}).get(provider_id) or {}
base_url = str(provider.get("base_url") or "")
name = str(provider.get("name") or provider_id or "codex-host")
wire_api = str(provider.get("wire_api") or "")
if not base_url:
    raise SystemExit(0)
protocol = "openai-responses" if wire_api == "responses" else "openai-completions"
print("\\t".join([name, base_url, protocol]))
PY
)"
    if [[ -n "$provider_info" ]]; then
      local provider_name provider_base_url provider_protocol
      IFS=$'\\t' read -r provider_name provider_base_url provider_protocol <<< "$provider_info"
      if [[ -n "$provider_base_url" ]]; then
        SKILLSCOPE_BENCH_AGENT_ENV_ARGS+=(
          --agent-env "BENCHFLOW_PROVIDER_BASE_URL=$provider_base_url"
          --agent-env "BENCHFLOW_PROVIDER_NAME=${"${provider_name:-codex-host}"}"
          --agent-env "BENCHFLOW_PROVIDER_PROTOCOL=${"${provider_protocol:-openai-responses}"}"
        )
      fi
    fi
  fi
}

configure_codex_host_provider

run_trial() {
  local condition="$1"
  local task="$2"
  local trial="$3"
  shift 3
  local status_dir="$SCRIPT_DIR/status/$condition/$task/trial-$trial"
  local log_dir="$SCRIPT_DIR/logs/$condition"
  local log_path="$log_dir/${"$"}{task}__trial-${"$"}{trial}.log"
  mkdir -p "$status_dir" "$log_dir"
  if [[ -f "$status_dir/done" ]]; then
    echo "[skip] $condition/$task trial $trial already done"
    return 0
  fi
  if [[ "${"${SKILLSCOPE_SKIP_FAILED:-0}"}" == "1" && -f "$status_dir/failed" ]]; then
    echo "[skip] $condition/$task trial $trial already failed"
    return 0
  fi
  if [[ -f "$status_dir/running" ]]; then
    echo "[skip] $condition/$task trial $trial already running"
    return 0
  fi
  rm -f "$status_dir/failed" "$status_dir/running"
  date -Is > "$status_dir/running"
  echo "[run] $condition/$task trial $trial"
  echo "$*" > "$status_dir/command.txt"
  local timeout_seconds="${"${SKILLSCOPE_TRIAL_TIMEOUT_SECONDS:-0}"}"
  if [[ "$timeout_seconds" =~ ^[0-9]+$ && "$timeout_seconds" != "0" ]] && command -v timeout >/dev/null 2>&1; then
    if timeout --kill-after=30s "$timeout_seconds" "$@" > "$log_path" 2>&1; then
      date -Is > "$status_dir/done"
      rm -f "$status_dir/running"
      echo "[done] $condition/$task trial $trial"
    else
      local code=$?
      echo "$code" > "$status_dir/failed"
      rm -f "$status_dir/running"
      echo "[fail] $condition/$task trial $trial exit $code; see $log_path" >&2
      return 0
    fi
  elif "$@" > "$log_path" 2>&1; then
    date -Is > "$status_dir/done"
    rm -f "$status_dir/running"
    echo "[done] $condition/$task trial $trial"
  else
    local code=$?
    echo "$code" > "$status_dir/failed"
    rm -f "$status_dir/running"
    echo "[fail] $condition/$task trial $trial exit $code; see $log_path" >&2
    return 0
  fi
}

${lines.join("\n")}

failed_count=$(find "$SCRIPT_DIR/status" -name failed -type f 2>/dev/null | wc -l | tr -d ' ')
done_count=$(find "$SCRIPT_DIR/status" -name done -type f 2>/dev/null | wc -l | tr -d ' ')
echo "[summary] done=$done_count failed=$failed_count"
if [[ "$failed_count" != "0" ]]; then
  exit 1
fi
`;
}

function renderExperimentReadme(plan: SkillsBenchRunPlan): string {
  return [
    "# SkillScope SkillsBench Experiment",
    "",
    `Agent/model: \`${plan.agent}\` / \`${plan.model}\``,
    `Tasks: ${plan.tasks.length}`,
    `Trials per task: ${plan.trialsPerTask}`,
    "",
    "Protocol:",
    "",
    "1. Run `run-original.sh` to generate Codex/GPT-5.5 with-skill trajectories.",
    "2. Use `npm run skillsbench -- collect ...` to index BenchFlow trial artifacts.",
    "3. Use `npm run skillsbench -- analyze ...` to compute violation, ignored, and non-compliance rates.",
    "4. Use `npm run skillsbench -- propose ...` to generate minimal evidence-backed optimized skill candidates.",
    "5. Use `npm run skillsbench -- rerun-plan ...` and run `run-optimized.sh` for the second pass.",
    "",
    "Remote machine Docker runner:",
    "",
    "```bash",
    "npm run skillsbench -- remote-script --plan run-plan.json --out .",
    "SKILLSCOPE_SYNC_CODEX_AUTH=1 ./run-remote-original.sh user@remote-host",
    "```",
    "",
    "This runs BenchFlow on the remote host with that host's local Docker daemon, not a remote image registry, then pulls artifacts back into a sibling `*-remote` experiment directory.",
    "",
    "Long-run controls:",
    "",
    "- Set `SKILLSCOPE_TRIAL_TIMEOUT_SECONDS=7200` to cap each BenchFlow trial while preserving resume semantics.",
    "- Set `SKILLSCOPE_SKIP_FAILED=1` to skip already-failed trials during a pass and retry them later.",
    "- Use `--agent-timeout-ms` on `judge` to cap each Codex analyzer process.",
    ""
  ].join("\n");
}

function renderRemoteRunScript(plan: SkillsBenchRunPlan, experimentName: string, options: CliOptions): string {
  const taskArgs = plan.tasks.map((task) => `    --task ${shellQuote(task.id)}`).join(" \\\n");
  const benchArgs = plan.benchExtraArgs.map((arg) => `    --bench-arg ${shellQuote(arg)}`).join(" \\\n");
  const includeNoSkill = plan.includeNoSkill ? " \\\n    --include-no-skill" : "";
  const remoteHostDefault = options.remoteHost ? shellQuote(options.remoteHost) : "\"${SKILLSCOPE_REMOTE_HOST:-${1:-}}\"";
  const remoteDirDefault = options.remoteDir ? shellQuote(options.remoteDir) : "\"${SKILLSCOPE_REMOTE_DIR:-SkillScope}\"";

  return `#!/usr/bin/env bash
set -euo pipefail

REMOTE=${remoteHostDefault}
REMOTE_DIR=${remoteDirDefault}
EXPERIMENT_NAME=${shellQuote(experimentName)}
LOCAL_ROOT="$(cd "$(dirname "${"${BASH_SOURCE[0]}"}")/../../.." && pwd)"
PULL_DIR="${"${SKILLSCOPE_REMOTE_PULL_DIR:-$LOCAL_ROOT/.skilllens/experiments/${EXPERIMENT_NAME}-remote}"}"
REMOTE_NPM_CI="${"${SKILLSCOPE_REMOTE_NPM_CI:-0}"}"
REMOTE_SKIP_FAILED="${"${SKILLSCOPE_SKIP_FAILED:-0}"}"
REMOTE_TRIAL_TIMEOUT_SECONDS="${"${SKILLSCOPE_TRIAL_TIMEOUT_SECONDS:-0}"}"

if [[ -z "$REMOTE" ]]; then
  echo "Usage: $0 user@remote-host"
  echo "Or set SKILLSCOPE_REMOTE_HOST=user@remote-host."
  exit 2
fi

echo "[remote] target=$REMOTE dir=$REMOTE_DIR"
ssh "$REMOTE" "mkdir -p '$REMOTE_DIR'"

echo "[remote] syncing SkillScope workspace"
rsync -az \\
  --exclude '.git/' \\
  --exclude 'node_modules/' \\
  --exclude 'dist/' \\
  --exclude '.skilllens/experiments/*/jobs/' \\
  --exclude '.skilllens/experiments/*/logs/' \\
  --exclude '.skilllens/experiments/*/status/' \\
  "$LOCAL_ROOT/" "$REMOTE:$REMOTE_DIR/"

if [[ "${"${SKILLSCOPE_SYNC_CODEX_AUTH:-0}"}" == "1" ]]; then
  echo "[remote] syncing Codex auth/config"
  if [[ ! -f "$HOME/.codex/auth.json" ]]; then
    echo "Missing $HOME/.codex/auth.json; unset SKILLSCOPE_SYNC_CODEX_AUTH or copy credentials manually." >&2
    exit 2
  fi
  ssh "$REMOTE" "mkdir -p '$REMOTE_DIR/.remote-codex-home'"
  rsync -az "$HOME/.codex/auth.json" "$REMOTE:$REMOTE_DIR/.remote-codex-home/auth.json"
  if [[ -f "$HOME/.codex/config.toml" ]]; then
    rsync -az "$HOME/.codex/config.toml" "$REMOTE:$REMOTE_DIR/.remote-codex-home/config.toml"
  fi
fi

echo "[remote] launching SkillsBench run"
echo "[remote] controls: skip_failed=$REMOTE_SKIP_FAILED trial_timeout_seconds=$REMOTE_TRIAL_TIMEOUT_SECONDS"
ssh "$REMOTE" "cd '$REMOTE_DIR' && SKILLSCOPE_REMOTE_NPM_CI='$REMOTE_NPM_CI' SKILLSCOPE_SKIP_FAILED='$REMOTE_SKIP_FAILED' SKILLSCOPE_TRIAL_TIMEOUT_SECONDS='$REMOTE_TRIAL_TIMEOUT_SECONDS' bash -s" <<'REMOTE_SKILLSCOPE'
set -euo pipefail

if [[ -f "$PWD/.remote-codex-home/auth.json" ]]; then
  export CODEX_HOME="$PWD/.remote-codex-home"
fi

if [[ ! -d node_modules || "${"${SKILLSCOPE_REMOTE_NPM_CI:-0}"}" == "1" ]]; then
  npm ci
fi

if ! command -v bench >/dev/null 2>&1; then
  if command -v uv >/dev/null 2>&1; then
    uv tool install "benchflow>=0.6.2,<0.7"
  else
    echo "bench is missing and uv is unavailable on the remote host." >&2
    exit 127
  fi
fi

docker info >/dev/null

npm run skillsbench -- plan \\
    --skillsbench-root "$PWD/.skilllens/vendor/skillsbench" \\
    --out "$PWD/.skilllens/experiments/${experimentName}" \\
    --agent ${shellQuote(plan.agent)} \\
    --model ${shellQuote(plan.model)} \\
    --trials ${plan.trialsPerTask}${includeNoSkill}${taskArgs ? ` \\\n${taskArgs}` : ""}${benchArgs ? ` \\\n${benchArgs}` : ""}

bash "$PWD/.skilllens/experiments/${experimentName}/run-original.sh"
REMOTE_SKILLSCOPE

echo "[remote] pulling results to $PULL_DIR"
mkdir -p "$PULL_DIR"
rsync -az "$REMOTE:$REMOTE_DIR/.skilllens/experiments/$EXPERIMENT_NAME/" "$PULL_DIR/"
echo "[remote] done"
echo "Remote artifacts: $PULL_DIR"
`;
}

function renderTrialsMarkdown(trials: TrialRecord[]): string {
  const lines = ["# Collected SkillsBench Trials", "", `Total: ${trials.length}`, "", "| task | mode | reward | agent | model | trial |", "|---|---|---:|---|---|---|"];
  for (const trial of trials) {
    lines.push(`| ${trial.taskId} | ${trial.mode} | ${trial.reward ?? ""} | ${trial.agent} | ${trial.model} | ${trial.id} |`);
  }
  return `${lines.join("\n")}\n`;
}

function analysisRecordFromProject(
  project: SkillLensProject,
  trial: TrialRecord,
  skillPath: string,
  skillRelPath: string,
  analysisPath: string
): AnalysisRecord {
  const summary = summarizeCoverage(project.findings);
  const judgedReachable = summary.counts.covered + summary.counts.violated + summary.counts.missed;
  const nativeVerifier = normalizeNativeVerifier(project.result.nativeVerifier);
  const targetCounts = countFindingsByTarget(project.findings);
  return {
    id: `${trial.id}:${skillRelPath}`,
    taskId: trial.taskId,
    trialId: trial.id,
    trialDir: trial.dir,
    skillPath,
    skillRelPath,
    mode: trial.mode,
    reward: trial.reward,
    passed: trial.passed,
    counts: summary.counts,
    totalConstraints: summary.total,
    judgedReachable,
    noncomplianceRate: judgedReachable ? (summary.counts.violated + summary.counts.missed) / judgedReachable : 0,
    violationRate: judgedReachable ? summary.counts.violated / judgedReachable : 0,
    ignoredRate: judgedReachable ? summary.counts.missed / judgedReachable : 0,
    unknownRate: summary.total ? summary.counts.unknown / summary.total : 0,
    targetCounts,
    analysisPath,
    nativeVerifier
  };
}

function addRepeatedFailures(
  repeated: Map<string, ConstraintAggregate>,
  project: SkillLensProject,
  trial: TrialRecord,
  skillRelPath: string
) {
  for (const finding of project.findings) {
    if (finding.status !== "missed" && finding.status !== "violated") {
      continue;
    }
    const unit = project.units.find((candidate) => candidate.id === finding.unitId);
    const constraint = unit?.constraints.find((candidate) => candidate.id === finding.constraintId);
    const sourceSpan = finding.analyzedConstraint?.span ?? constraint?.span ?? unit;
    const text = finding.analyzedConstraint?.text ?? constraint?.text ?? unit?.text ?? finding.unitId;
    const target = targetFromFinding(finding);
    const span = sourceSpan ? `L${sourceSpan.lineStart}-L${sourceSpan.lineEnd}` : "unknown";
    const key = `${trial.taskId}::${skillRelPath}::${target}::${span}::${normalizeTextKey(text)}`;
    const current =
      repeated.get(key) ??
      ({
        key,
        taskId: trial.taskId,
        skillRelPath,
        statusCounts: {},
        target,
        totalFailures: 0,
        text,
        sourceSpan: span,
        exampleTrialIds: [],
        exampleEvidenceEventIds: []
      } satisfies ConstraintAggregate);
    current.statusCounts[finding.status] = (current.statusCounts[finding.status] ?? 0) + 1;
    current.totalFailures += 1;
    if (!current.exampleTrialIds.includes(trial.id)) {
      current.exampleTrialIds.push(trial.id);
    }
    for (const eventId of [...finding.evidenceEventIds, ...finding.counterEvidenceEventIds]) {
      if (!current.exampleEvidenceEventIds.includes(eventId) && current.exampleEvidenceEventIds.length < 8) {
        current.exampleEvidenceEventIds.push(eventId);
      }
    }
    repeated.set(key, current);
  }
}

function aggregateAnalyses(
  plan: SkillsBenchRunPlan,
  records: AnalysisRecord[],
  repeatedFailures: ConstraintAggregate[]
): AnalysisAggregate {
  const totals = aggregateRates("all", records);
  const byTask = [...groupBy(records, (record) => record.taskId)].map(([taskId, group]) => aggregateRates(taskId, group, { taskId }));
  const bySkill = [...groupBy(records, (record) => `${record.taskId}::${record.skillRelPath}`)].map(([key, group]) => {
    const [taskId, skillRelPath] = key.split("::");
    return aggregateRates(key, group, { taskId, skillRelPath });
  });
  return {
    schemaVersion: "skillscope.skillsbench-violation-rates.v1",
    createdAt: new Date().toISOString(),
    plan: {
      agent: plan.agent,
      model: plan.model,
      taskCount: plan.tasks.length,
      trialsPerTask: plan.trialsPerTask
    },
    totals,
    byTask: byTask.sort((left, right) => right.noncomplianceRate - left.noncomplianceRate || left.key.localeCompare(right.key)),
    bySkill: bySkill.sort((left, right) => right.noncomplianceRate - left.noncomplianceRate || left.key.localeCompare(right.key)),
    repeatedFailures: repeatedFailures.sort((left, right) => right.totalFailures - left.totalFailures || left.key.localeCompare(right.key)),
    analyses: records,
    nativeVerifier: aggregateNativeVerifier(records)
  };
}

function normalizeNativeVerifier(value: unknown): NativeVerifierSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== "skilllens.native-verifier.v1") {
    return undefined;
  }
  return {
    schemaVersion: "skilllens.native-verifier.v1",
    source: "skillsbench",
    reward: numberFrom(object.reward),
    passed: typeof object.passed === "boolean" ? object.passed : null,
    tests: numberFrom(object.tests),
    passedTests: numberFrom(object.passedTests),
    failedTests: numberFrom(object.failedTests),
    failedTestNames: Array.isArray(object.failedTestNames) ? object.failedTestNames.filter((item): item is string => typeof item === "string") : [],
    failedAssertions: Array.isArray(object.failedAssertions)
      ? object.failedAssertions.map((item) => {
          const failure = objectFrom(item);
          return {
            name: stringFrom(failure.name) || "unknown",
            message: stringFrom(failure.message) || undefined,
            trace: stringFrom(failure.trace) || undefined
          };
        })
      : [],
    ctrfPath: stringFrom(object.ctrfPath) || undefined
  };
}

function aggregateNativeVerifier(records: AnalysisRecord[]): NativeVerifierAggregate {
  const trialIds = new Set<string>();
  let analyses = 0;
  let rewardKnown = 0;
  let rewardPassed = 0;
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  for (const record of records) {
    const native = record.nativeVerifier;
    if (!native) {
      continue;
    }
    analyses += 1;
    trialIds.add(record.trialId);
    if (native.passed !== null) {
      rewardKnown += 1;
      if (native.passed) {
        rewardPassed += 1;
      }
    }
    if (native.tests !== null) {
      totalTests += native.tests;
      passedTests += native.passedTests ?? 0;
      failedTests += native.failedTests ?? Math.max(0, native.tests - (native.passedTests ?? native.tests));
    }
  }
  return {
    analyses,
    trials: trialIds.size,
    rewardPassRate: rewardKnown ? rewardPassed / rewardKnown : null,
    testPassRate: totalTests ? passedTests / totalTests : null,
    failedTests,
    totalTests
  };
}

function aggregateRates(
  key: string,
  records: AnalysisRecord[],
  extra: Pick<RateAggregate, "taskId" | "skillRelPath"> = {}
): RateAggregate {
  const counts = emptyCounts();
  const targetCounts = emptyTargetCounts();
  const trialIds = new Set<string>();
  let totalConstraints = 0;
  let passed = 0;
  let passKnown = 0;
  for (const record of records) {
    trialIds.add(record.trialId);
    totalConstraints += record.totalConstraints;
    for (const status of Object.keys(counts) as CoverageStatus[]) {
      counts[status] += record.counts[status] ?? 0;
    }
    if (record.targetCounts) {
      mergeTargetCounts(targetCounts, record.targetCounts);
    }
    if (record.passed !== null) {
      passKnown += 1;
      if (record.passed) {
        passed += 1;
      }
    }
  }
  const judgedReachable = counts.covered + counts.violated + counts.missed;
  return {
    key,
    ...extra,
    analysisCount: records.length,
    trialCount: trialIds.size,
    counts,
    totalConstraints,
    judgedReachable,
    noncomplianceRate: judgedReachable ? (counts.violated + counts.missed) / judgedReachable : 0,
    violationRate: judgedReachable ? counts.violated / judgedReachable : 0,
    ignoredRate: judgedReachable ? counts.missed / judgedReachable : 0,
    unknownRate: totalConstraints ? counts.unknown / totalConstraints : 0,
    targetRates: targetRatesFromCounts(targetCounts),
    passRate: passKnown ? passed / passKnown : null
  };
}

function renderViolationMarkdown(aggregate: AnalysisAggregate): string {
  return [
    "# SkillsBench Violation Rates",
    "",
    `Agent/model: \`${aggregate.plan.agent}\` / \`${aggregate.plan.model}\``,
    `Analyzed skill/trial pairs: ${aggregate.analyses.length}`,
    "",
    "Definitions:",
    "",
    "- `violationRate`: explicit conflict / judged reachable constraints.",
    "- `ignoredRate`: applicable but absent / judged reachable constraints.",
    "- `noncomplianceRate`: `(violated + ignored) / judged reachable constraints`.",
    "- Native verifier metrics come from SkillsBench `result.json` and `verifier/ctrf.json`; they judge final artifacts, not process adherence.",
    "",
    "## Native SkillsBench Verifier",
    "",
    "| analyses | trials | reward pass | test pass | failed tests | total tests |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${aggregate.nativeVerifier.analyses} | ${aggregate.nativeVerifier.trials} | ${
      aggregate.nativeVerifier.rewardPassRate === null ? "" : percent(aggregate.nativeVerifier.rewardPassRate)
    } | ${aggregate.nativeVerifier.testPassRate === null ? "" : percent(aggregate.nativeVerifier.testPassRate)} | ${aggregate.nativeVerifier.failedTests} | ${aggregate.nativeVerifier.totalTests} |`,
    "",
    "## Overall",
    "",
    rateTable([aggregate.totals]),
    "",
    "## Overall By Target",
    "",
    targetRateTable(aggregate.totals.targetRates),
    "",
    "## Highest Non-Compliance Tasks",
    "",
    rateTable(aggregate.byTask.slice(0, 20)),
    "",
    "## Highest Non-Compliance Skills",
    "",
    rateTable(aggregate.bySkill.slice(0, 30)),
    "",
    "## Repeated Failed Constraints",
    "",
    "| failures | task | skill | target | status | source | constraint | example trials |",
    "|---:|---|---|---|---|---|---|---|",
    ...aggregate.repeatedFailures.slice(0, 60).map((item) => {
      const status = Object.entries(item.statusCounts)
        .map(([key, value]) => `${key}:${value}`)
        .join(", ");
      return `| ${item.totalFailures} | ${item.taskId} | ${item.skillRelPath} | ${item.target} | ${status} | ${item.sourceSpan} | ${escapeCell(item.text)} | ${item.exampleTrialIds.slice(0, 5).join(", ")} |`;
    }),
    ""
  ].join("\n");
}

function rateTable(rows: RateAggregate[]): string {
  return [
    "| key | analyses | trials | pass | non-compliance | violation | ignored | unknown | covered/missed/violated |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...rows.map((row) => {
      const key = row.skillRelPath ? `${row.taskId}/${row.skillRelPath}` : row.taskId ?? row.key;
      return `| ${escapeCell(key)} | ${row.analysisCount} | ${row.trialCount} | ${row.passRate === null ? "" : percent(row.passRate)} | ${percent(row.noncomplianceRate)} | ${percent(row.violationRate)} | ${percent(row.ignoredRate)} | ${percent(row.unknownRate)} | ${row.counts.covered}/${row.counts.missed}/${row.counts.violated} |`;
    })
  ].join("\n");
}

function targetRateTable(rows: Record<CoverageTarget, TargetRateAggregate>): string {
  return [
    "| target | constraints | judged reachable | non-compliance | violation | ignored | unknown | covered/missed/violated |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...coverageTargets.map((target) => {
      const row = rows[target];
      return `| ${target} | ${row.totalConstraints} | ${row.judgedReachable} | ${percent(row.noncomplianceRate)} | ${percent(row.violationRate)} | ${percent(row.ignoredRate)} | ${percent(row.unknownRate)} | ${row.counts.covered}/${row.counts.missed}/${row.counts.violated} |`;
    })
  ].join("\n");
}

interface FrameworkOptimizationInput {
  key: string;
  taskId: string;
  skillRelPath: string;
  inputDir: string;
  originalSkillPath: string;
  selectedSkillPath: string;
  constraintsPath: string;
  skillGraphPath: string;
  traceFactsPath: string;
  findingsPath: string;
  nativeVerifierPath?: string;
  traceEventsPath?: string;
  taskPath?: string;
  resultPath: string;
  promptPath: string;
  optimizedSkillPath: string;
  optimizationReportPath: string;
  optimizationDiffPath: string;
  optimizationPacketPath: string;
  rawOutputPath: string;
  lastMessagePath: string;
  failureSummary: string;
}

function groupAnalysisRecordsForOptimization(
  records: AnalysisRecord[],
  options: CliOptions
): Map<string, AnalysisRecord[]> {
  const groups = new Map<string, AnalysisRecord[]>();
  for (const record of records) {
    const failed = record.counts.missed + record.counts.violated;
    if (failed <= 0) {
      continue;
    }
    const key = `${record.taskId}::${record.skillRelPath}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    const totalFailures = list.reduce((sum, record) => sum + record.counts.missed + record.counts.violated, 0);
    if (totalFailures < options.minFailures) {
      groups.delete(key);
      continue;
    }
    groups.set(
      key,
      list.sort(
        (left, right) =>
          right.counts.violated + right.counts.missed - (left.counts.violated + left.counts.missed) ||
          left.trialId.localeCompare(right.trialId)
      )
    );
  }
  return groups;
}

function optimizationCandidateGate(
  records: AnalysisRecord[],
  options: CliOptions
): {
  optimize: boolean;
  reason: string;
  noncomplianceRate: number;
  nativeFailed: boolean;
  finalArtifactFailures: number;
  processOnlyFailures: boolean;
} {
  const counts = records.reduce((acc, record) => {
    for (const key of Object.keys(acc) as CoverageStatus[]) {
      acc[key] += record.counts[key] ?? 0;
    }
    return acc;
  }, emptyCounts());
  const judgedReachable = counts.covered + counts.missed + counts.violated;
  const noncomplianceRate = judgedReachable ? (counts.missed + counts.violated) / judgedReachable : 0;
  const finalArtifactFailures = records.reduce(
    (sum, record) =>
      sum +
      targetFailureCount(record.targetCounts?.final_output) +
      targetFailureCount(record.targetCounts?.artifact),
    0
  );
  const totalFailures = records.reduce((sum, record) => sum + record.counts.missed + record.counts.violated, 0);
  const nativeFailed = records.some(
    (record) =>
      record.passed === false ||
      (typeof record.reward === "number" && record.reward < 1) ||
      record.nativeVerifier?.passed === false ||
      (typeof record.nativeVerifier?.reward === "number" && record.nativeVerifier.reward < 1)
  );
  const nativePassed = records.length > 0 && records.every(
    (record) =>
      record.passed === true ||
      record.reward === 1 ||
      record.nativeVerifier?.passed === true ||
      record.nativeVerifier?.reward === 1
  );
  const processOnlyFailures = totalFailures > 0 && finalArtifactFailures === 0;

  if (nativeFailed) {
    return { optimize: true, reason: "native verifier failed", noncomplianceRate, nativeFailed, finalArtifactFailures, processOnlyFailures };
  }
  if (finalArtifactFailures > 0) {
    return { optimize: true, reason: "final-output/artifact failures present", noncomplianceRate, nativeFailed, finalArtifactFailures, processOnlyFailures };
  }
  if (noncomplianceRate >= options.optimizeNcThreshold) {
    return { optimize: true, reason: `non-compliance ${percent(noncomplianceRate)} >= ${percent(options.optimizeNcThreshold)}`, noncomplianceRate, nativeFailed, finalArtifactFailures, processOnlyFailures };
  }
  if (nativePassed && processOnlyFailures && !options.optimizeStablePass) {
    return {
      optimize: false,
      reason: `native pass with low non-compliance (${percent(noncomplianceRate)}) and process/reporting-only failures`,
      noncomplianceRate,
      nativeFailed,
      finalArtifactFailures,
      processOnlyFailures
    };
  }
  return {
    optimize: false,
    reason: `below optimization threshold (${percent(noncomplianceRate)} < ${percent(options.optimizeNcThreshold)}) with no final-output/artifact failure`,
    noncomplianceRate,
    nativeFailed,
    finalArtifactFailures,
    processOnlyFailures
  };
}

function targetFailureCount(counts: Record<CoverageStatus, number> | undefined): number {
  return (counts?.missed ?? 0) + (counts?.violated ?? 0);
}

async function prepareFrameworkOptimizationInput(input: {
  outRoot: string;
  key: string;
  records: AnalysisRecord[];
  task: TaskPlan;
  originalSkillPath: string;
}): Promise<FrameworkOptimizationInput | null> {
  const [taskId, skillRelPath] = input.key.split("::");
  const sources = [];
  for (const record of input.records) {
    const project = await readAnalysisProject(record.analysisPath);
    const audit = agentJudgeAuditFromProject(project);
    if (!audit || !hasRequiredOptimizerArtifacts(audit)) {
      continue;
    }
    sources.push({ record, project, audit });
  }
  if (!sources.length) {
    return null;
  }

  const primary = sources[0];
  const inputDir = path.join(input.outRoot, ".optimization-inputs", safeName(taskId), safeName(skillRelPath));
  await mkdir(inputDir, { recursive: true });
  const selectedSkillPath = path.join(inputDir, "selected-skill.md");
  const constraintsPath = path.join(inputDir, "constraints.json");
  const skillGraphPath = path.join(inputDir, "skill-graph.json");
  const traceFactsPath = path.join(inputDir, "trace-facts.json");
  const findingsPath = path.join(inputDir, "findings.json");
  const nativeVerifierPath = path.join(inputDir, "native-verifier.json");
  const traceEventsPath = path.join(inputDir, "trace-events.json");
  const resultPath = path.join(inputDir, "optimization-input-summary.json");
  const promptPath = path.join(inputDir, "optimization-prompt.txt");
  const optimizedSkillPath = path.join(inputDir, "optimized-skill.md");
  const optimizationReportPath = path.join(inputDir, "optimization-report.md");
  const optimizationDiffPath = path.join(inputDir, "optimization-diff.md");
  const optimizationPacketPath = path.join(inputDir, "optimization-packet.json");
  const rawOutputPath = path.join(inputDir, "optimizer-output.txt");
  const lastMessagePath = path.join(inputDir, "optimizer-last-message.json");

  await writeFile(selectedSkillPath, await readFile(input.originalSkillPath, "utf8"));
  await cp(primary.audit.constraintsPath, constraintsPath, { force: true });
  await cp(primary.audit.skillGraphPath, skillGraphPath, { force: true });
  if (primary.audit.traceEventsPath && existsSync(primary.audit.traceEventsPath)) {
    await cp(primary.audit.traceEventsPath, traceEventsPath, { force: true });
  }
  if (primary.audit.nativeVerifierPath && existsSync(primary.audit.nativeVerifierPath)) {
    await cp(primary.audit.nativeVerifierPath, nativeVerifierPath, { force: true });
  }

  const sourcePackets = await Promise.all(
    sources.map(async (source) => ({
      taskId: source.record.taskId,
      trialId: source.record.trialId,
      trialDir: source.record.trialDir,
      analysisPath: source.record.analysisPath,
      counts: source.record.counts,
      reward: source.record.reward,
      passed: source.record.passed,
      nativeVerifier: source.record.nativeVerifier,
      targetCounts: source.record.targetCounts,
      constraintsPath: source.audit.constraintsPath,
      skillGraphPath: source.audit.skillGraphPath,
      traceFactsPath: source.audit.traceFactsPath,
      findingsPath: source.audit.findingsPath,
      nativeVerifierPath: source.audit.nativeVerifierPath,
      traceFacts: await readJsonUnknown(source.audit.traceFactsPath),
      findings: await readJsonUnknown(source.audit.findingsPath)
    }))
  );
  await writeFile(
    traceFactsPath,
    `${JSON.stringify(
      {
        schemaVersion: "skilllens.multi-trace-facts.v1",
        primaryTrialId: primary.record.trialId,
        sources: sourcePackets.map((source) => ({
          taskId: source.taskId,
          trialId: source.trialId,
          trialDir: source.trialDir,
          traceFactsPath: source.traceFactsPath,
          nativeVerifierPath: source.nativeVerifierPath,
          traceFacts: source.traceFacts
        }))
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    findingsPath,
    `${JSON.stringify(
      {
        schemaVersion: "skilllens.multi-findings.v1",
        primaryTrialId: primary.record.trialId,
        findings: sourcePackets.flatMap((source) =>
          normalizeFindingsArray(source.findings).map((finding) => ({
            ...finding,
            sourceTaskId: source.taskId,
            sourceTrialId: source.trialId,
            sourceAnalysisPath: source.analysisPath
          }))
        )
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        schemaVersion: "skilllens.optimization-input-summary.v1",
        taskId,
        skillRelPath,
        originalSkillPath: input.originalSkillPath,
        taskPath: input.task.taskPath,
        sourceCount: sources.length,
        totalFailures: input.records.reduce((sum, record) => sum + record.counts.missed + record.counts.violated, 0),
        sources: sourcePackets.map((source) => ({
          taskId: source.taskId,
          trialId: source.trialId,
          trialDir: source.trialDir,
          analysisPath: source.analysisPath,
          counts: source.counts,
          targetCounts: source.targetCounts,
          reward: source.reward,
          passed: source.passed,
          nativeVerifier: source.nativeVerifier
        }))
      },
      null,
      2
    )}\n`
  );

  return {
    key: input.key,
    taskId,
    skillRelPath,
    inputDir,
    originalSkillPath: input.originalSkillPath,
    selectedSkillPath,
    constraintsPath,
    skillGraphPath,
    traceFactsPath,
    findingsPath,
    nativeVerifierPath: existsSync(nativeVerifierPath) ? nativeVerifierPath : undefined,
    traceEventsPath: existsSync(traceEventsPath) ? traceEventsPath : undefined,
    taskPath: input.task.taskPath,
    resultPath,
    promptPath,
    optimizedSkillPath,
    optimizationReportPath,
    optimizationDiffPath,
    optimizationPacketPath,
    rawOutputPath,
    lastMessagePath,
    failureSummary: renderOptimizationFailureSummary(input.key, sourcePackets, input.records)
  };
}

async function runFrameworkSkillOptimizerForBatch(input: {
  prepared: FrameworkOptimizationInput;
  targetSkillPath: string;
  force: boolean;
  timeoutMs: number;
  maxEditsPerSkill: number;
}): Promise<{
  cached: boolean;
  optimizedSkillPath: string;
  optimizationReportPath: string;
  optimizationDiffPath: string;
  optimizationPacketPath: string;
}> {
  const prepared = input.prepared;
  if (!input.force && hasNonEmptyFile(prepared.optimizedSkillPath)) {
    await writeFile(input.targetSkillPath, await readFile(prepared.optimizedSkillPath, "utf8"));
    return {
      cached: true,
      optimizedSkillPath: prepared.optimizedSkillPath,
      optimizationReportPath: prepared.optimizationReportPath,
      optimizationDiffPath: prepared.optimizationDiffPath,
      optimizationPacketPath: prepared.optimizationPacketPath
    };
  }

  const prompt = buildSkillOptimizerPrompt({
    launcher: "skillsbench",
    optimizerSkillPath: path.join(process.cwd(), "skills", "skillscope-optimizer", "SKILL.md"),
    workDir: prepared.inputDir,
    requestId: `skillsbench-optimize-${safeName(prepared.key)}`,
    originalSkillPath: prepared.originalSkillPath,
    selectedSkillPath: prepared.selectedSkillPath,
    constraintsPath: prepared.constraintsPath,
    skillGraphPath: prepared.skillGraphPath,
    traceFactsPath: prepared.traceFactsPath,
    findingsPath: prepared.findingsPath,
    nativeVerifierPath: prepared.nativeVerifierPath,
    traceEventsPath: prepared.traceEventsPath,
    taskPath: prepared.taskPath,
    resultPath: prepared.resultPath,
    optimizedSkillPath: prepared.optimizedSkillPath,
    optimizationReportPath: prepared.optimizationReportPath,
    optimizationDiffPath: prepared.optimizationDiffPath,
    optimizationPacketPath: prepared.optimizationPacketPath,
    failureSummary: `${prepared.failureSummary}\n\nEdit budget: prefer at most ${input.maxEditsPerSkill} conceptual edits unless the graph shows one dominating replacement section.`
  });
  await writeFile(prepared.promptPath, prompt);
  await writeFile(prepared.optimizedSkillPath, "");
  await writeFile(prepared.optimizationReportPath, "");
  await writeFile(prepared.optimizationDiffPath, "");
  await writeFile(prepared.optimizationPacketPath, `${JSON.stringify({ schemaVersion: "skilllens.optimization-packet.v1", edits: [] }, null, 2)}\n`);

  let commandResult: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  let lastMessage = "";
  try {
    commandResult = await runCodexAnalyzer(prompt, {
      workDir: prepared.inputDir,
      outputLastMessagePath: prepared.lastMessagePath,
      timeoutMs: input.timeoutMs
    });
    lastMessage = existsSync(prepared.lastMessagePath) ? await readFile(prepared.lastMessagePath, "utf8") : "";
  } finally {
    const rawOutput = [commandResult.stdout, commandResult.stderr, lastMessage].filter(Boolean).join("\n");
    await writeFile(prepared.rawOutputPath, rawOutput);
  }

  if (!hasNonEmptyFile(prepared.optimizedSkillPath)) {
    throw new Error(`Optimizer did not write ${prepared.optimizedSkillPath}`);
  }
  await writeFile(input.targetSkillPath, await readFile(prepared.optimizedSkillPath, "utf8"));
  return {
    cached: false,
    optimizedSkillPath: prepared.optimizedSkillPath,
    optimizationReportPath: prepared.optimizationReportPath,
    optimizationDiffPath: prepared.optimizationDiffPath,
    optimizationPacketPath: prepared.optimizationPacketPath
  };
}

function agentJudgeAuditFromProject(project: SkillLensProject | null):
  | {
      workDir?: string;
      constraintsPath: string;
      skillGraphPath: string;
      traceFactsPath: string;
      findingsPath: string;
      nativeVerifierPath?: string;
      traceEventsPath?: string;
    }
  | null {
  const audit = project?.result?.agentJudge;
  if (!audit || typeof audit !== "object") {
    return null;
  }
  const object = audit as Record<string, unknown>;
  const constraintsPath = stringFrom(object.constraintsPath);
  const skillGraphPath = stringFrom(object.skillGraphPath);
  const traceFactsPath = stringFrom(object.traceFactsPath);
  const findingsPath = stringFrom(object.findingsPath);
  const nativeVerifierPath = stringFrom(object.nativeVerifierPath);
  if (!constraintsPath || !skillGraphPath || !traceFactsPath || !findingsPath) {
    return null;
  }
  return {
    workDir: stringFrom(object.workDir) || undefined,
    constraintsPath,
    skillGraphPath,
    traceFactsPath,
    findingsPath,
    nativeVerifierPath: nativeVerifierPath || (object.workDir ? path.join(String(object.workDir), "native-verifier.json") : undefined),
    traceEventsPath: stringFrom(object.traceEventsPath) || (object.workDir ? path.join(String(object.workDir), "trace-events.json") : undefined)
  };
}

function hasRequiredOptimizerArtifacts(audit: {
  constraintsPath: string;
  skillGraphPath: string;
  traceFactsPath: string;
  findingsPath: string;
}): boolean {
  return [audit.constraintsPath, audit.skillGraphPath, audit.traceFactsPath, audit.findingsPath].every(hasNonEmptyFile);
}

async function readAnalysisProject(analysisPath: string): Promise<SkillLensProject | null> {
  try {
    const parsed = JSON.parse(await readFile(analysisPath, "utf8")) as { project?: SkillLensProject };
    return parsed.project ?? null;
  } catch {
    return null;
  }
}

async function readJsonUnknown(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function normalizeFindingsArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.findings)) {
      return normalizeFindingsArray(object.findings);
    }
    if (Array.isArray(object.judgments)) {
      return normalizeFindingsArray(object.judgments);
    }
  }
  return [];
}

function renderOptimizationFailureSummary(
  key: string,
  sources: Array<{
    trialId: string;
    counts: Record<CoverageStatus, number>;
    targetCounts?: Record<CoverageTarget, Record<CoverageStatus, number>>;
    findings: unknown;
    reward: number | null;
    passed: boolean | null;
    nativeVerifier?: NativeVerifierSummary;
  }>,
  records: AnalysisRecord[]
): string {
  const lines = [
    `Target: ${key}`,
    `Trace count: ${sources.length}`,
    `Total violated: ${records.reduce((sum, record) => sum + record.counts.violated, 0)}`,
    `Total missed: ${records.reduce((sum, record) => sum + record.counts.missed, 0)}`,
    ""
  ];
  sources.slice(0, 6).forEach((source) => {
    lines.push(
      `Trial ${source.trialId}: reward=${source.reward ?? "unknown"} passed=${source.passed ?? "unknown"} covered/missed/violated=${source.counts.covered}/${source.counts.missed}/${source.counts.violated}`
    );
    if (source.nativeVerifier) {
      lines.push(
        `  native verifier: passed=${source.nativeVerifier.passed ?? "unknown"} tests=${source.nativeVerifier.passedTests ?? "?"}/${source.nativeVerifier.tests ?? "?"} failed=${source.nativeVerifier.failedTests ?? "?"}`
      );
    }
    if (source.targetCounts) {
      const targetSummary = coverageTargets
        .map((target) => {
          const counts = source.targetCounts?.[target];
          return counts ? `${target} ${counts.covered}/${counts.missed}/${counts.violated}` : "";
        })
        .filter(Boolean)
        .join("; ");
      if (targetSummary) {
        lines.push(`  by target covered/missed/violated: ${targetSummary}`);
      }
    }
    normalizeFindingsArray(source.findings)
      .filter((finding) => finding.status === "missed" || finding.status === "violated")
      .slice(0, 8)
      .forEach((finding, index) => {
        const analyzed = finding.analyzedConstraint && typeof finding.analyzedConstraint === "object" ? (finding.analyzedConstraint as Record<string, unknown>) : {};
        const text = stringFrom(analyzed.text) || stringFrom(finding.rationale);
        const target = stringFrom(finding.target) || stringFrom(analyzed.target) || "unknown";
        const evidence = Array.isArray(finding.evidenceEventIds) ? finding.evidenceEventIds.slice(0, 6).join(", ") : "";
        const counter = Array.isArray(finding.counterEvidenceEventIds) ? finding.counterEvidenceEventIds.slice(0, 6).join(", ") : "";
        lines.push(`  ${index + 1}. ${finding.status} target=${target}: ${trimConstraint(text)}`);
        lines.push(`     evidence: ${evidence || counter || "absence / inspected range in findings rationale"}`);
      });
  });
  return lines.join("\n");
}

function renderFrameworkPatchSummary(patches: Record<string, unknown>): string {
  const lines = [
    "# SkillScope Framework-Optimized Skill Candidates",
    "",
    "These entries were produced from saved SkillScope analysis IR: constraints, skill graph, trace facts, and findings. Some entries are optimizer-generated candidates; pass-through entries keep the current skill for rerun.",
    "",
    "| skill | records | failures | cached | optimized skill | report |",
    "|---|---:|---:|---|---|---|"
  ];
  for (const [key, value] of Object.entries(patches)) {
    const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const report = stringFrom(item.optimizationReportPath) || stringFrom(item.passThroughReason) || stringFrom(item.skipped);
    lines.push(
      `| ${escapeCell(key)} | ${item.recordCount ?? ""} | ${item.totalFailures ?? ""} | ${item.cached ?? ""} | ${escapeCell(stringFrom(item.optimizedSkillPath))} | ${escapeCell(report)} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function groupFailureCandidates(
  failures: ConstraintAggregate[],
  options: CliOptions
): Map<string, ConstraintAggregate[]> {
  const groups = new Map<string, ConstraintAggregate[]>();
  for (const failure of failures) {
    if (failure.totalFailures < options.minFailures) {
      continue;
    }
    const key = `${failure.taskId}::${failure.skillRelPath}`;
    const list = groups.get(key) ?? [];
    list.push(failure);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    groups.set(
      key,
      list.sort((left, right) => right.totalFailures - left.totalFailures || left.sourceSpan.localeCompare(right.sourceSpan))
    );
  }
  return groups;
}

function renderAntiBloatPatch(failures: ConstraintAggregate[]): string {
  return [
    "## SkillScope Evidence Gates",
    "",
    "These checks are generated from repeated trajectory failures. Keep them only if the next rerun improves adherence; remove any check that does not change behavior.",
    "",
    "Before final response:",
    "",
    ...failures.map((failure) => {
      const missed = failure.statusCounts.missed ?? 0;
      const violated = failure.statusCounts.violated ?? 0;
      return `- Verify \`${inlineCode(trimConstraint(failure.text))}\`. Evidence expected: a concrete tool call, command output, artifact, or final-response field. Observed failures: missed ${missed}, violated ${violated}.`;
    })
  ].join("\n");
}

function renderPatchSummary(patches: Record<string, unknown[]>): string {
  const lines = ["# SkillScope Optimized Skill Candidates", "", "Review these patches before rerunning the benchmark.", ""];
  for (const [key, failures] of Object.entries(patches)) {
    lines.push(`## ${key}`, "", `Patched repeated constraints: ${failures.length}`, "");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(args: string[]): CliOptions {
  const command = isCommand(args[0]) ? args[0] : "help";
  const options: CliOptions = {
    command,
    agent: "codex",
    model: "gpt-5.5",
    trials: 1,
    taskIds: [],
    includeNoSkill: false,
    agentConcurrency: 4,
    agentTimeoutMs: 600000,
    minFailures: 1,
    optimizeNcThreshold: 0.1,
    optimizeStablePass: false,
    maxEditsPerSkill: 3,
    force: false,
    benchExtraArgs: []
  };
  for (let index = command === "help" ? 0 : 1; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (!arg.startsWith("--")) {
      continue;
    }
    switch (arg.slice(2)) {
      case "skillsbench-root":
      case "root":
        options.skillsbenchRoot = next;
        index += 1;
        break;
      case "runs-root":
        options.runsRoot = next;
        index += 1;
        break;
      case "plan":
        options.plan = next;
        index += 1;
        break;
      case "trials-file":
        options.trialsFile = next;
        index += 1;
        break;
      case "analysis":
        options.analysis = next;
        index += 1;
        break;
      case "optimized-skills-root":
        options.optimizedSkillsRoot = next;
        index += 1;
        break;
      case "out":
        options.out = next;
        index += 1;
        break;
      case "agent":
        options.agent = next;
        index += 1;
        break;
      case "model":
        options.model = next;
        index += 1;
        break;
      case "trials":
        options.trials = Number.parseInt(next, 10) || options.trials;
        index += 1;
        break;
      case "task":
        options.taskIds.push(next);
        index += 1;
        break;
      case "max-tasks":
        options.maxTasks = Number.parseInt(next, 10) || undefined;
        index += 1;
        break;
      case "max-agent-analyses":
        options.maxAgentAnalyses = Number.parseInt(next, 10) || undefined;
        index += 1;
        break;
      case "agent-concurrency":
        options.agentConcurrency = Number.parseInt(next, 10) || options.agentConcurrency;
        if (!Number.isFinite(options.agentConcurrency) || options.agentConcurrency < 1) {
          options.agentConcurrency = 1;
        }
        index += 1;
        break;
      case "agent-timeout-ms":
        options.agentTimeoutMs = Number.parseInt(next, 10) || options.agentTimeoutMs;
        index += 1;
        break;
      case "include-no-skill":
        options.includeNoSkill = true;
        break;
      case "force":
        options.force = true;
        break;
      case "remote-host":
        options.remoteHost = next;
        index += 1;
        break;
      case "remote-dir":
        options.remoteDir = next;
        index += 1;
        break;
      case "min-failures":
        options.minFailures = Number.parseInt(next, 10) || options.minFailures;
        index += 1;
        break;
      case "optimize-nc-threshold":
        options.optimizeNcThreshold = Number.parseFloat(next);
        if (!Number.isFinite(options.optimizeNcThreshold) || options.optimizeNcThreshold < 0) {
          options.optimizeNcThreshold = 0.1;
        }
        index += 1;
        break;
      case "optimize-stable-pass":
        options.optimizeStablePass = true;
        break;
      case "max-edits-per-skill":
        options.maxEditsPerSkill = Number.parseInt(next, 10) || options.maxEditsPerSkill;
        index += 1;
        break;
      case "bench-arg":
        options.benchExtraArgs.push(next);
        index += 1;
        break;
    }
  }
  return options;
}

function isCommand(value: string | undefined): value is Command {
  return (
    value === "plan" ||
    value === "collect" ||
    value === "analyze" ||
    value === "judge" ||
    value === "propose" ||
    value === "rerun-plan" ||
    value === "analysis-plan" ||
    value === "remote-script" ||
    value === "help"
  );
}

function requirePath(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`Missing ${flag}`);
  }
  return value;
}

async function readJson(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, any>;
}

async function readResult(filePath: string): Promise<ProjectResult> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as ProjectResult;
  } catch {
    return { source: "unparseable result.json" };
  }
}

function taskIdFrom(config: Record<string, any>, result: Record<string, any>, dir: string): string {
  const direct = stringFrom(config.task_name);
  if (direct) {
    return direct;
  }
  const taskPath = stringFrom(config.task_path);
  if (taskPath) {
    return path.basename(taskPath);
  }
  const resultTask = stringFrom(result.task_name ?? result.task);
  if (resultTask) {
    return resultTask;
  }
  return path.basename(dir).split("__")[0] ?? "";
}

function trialIdFrom(result: Record<string, any>, dir: string): string {
  const direct = stringFrom(result.rollout_name ?? result.trial_id);
  if (direct) {
    return direct;
  }
  return path.basename(dir);
}

function modeFrom(value: unknown): TrialMode {
  const text = stringFrom(value).toLowerCase();
  if (text.includes("with")) {
    return "with";
  }
  if (text.includes("no-skill") || text.includes("without")) {
    return "without";
  }
  return "unknown";
}

function scoreFrom(result: Record<string, any>): number | null {
  for (const value of [result.reward, result.score, result.success, result.rewards?.reward, result.final_reward]) {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
  }
  return null;
}

function passedFrom(result: Record<string, any>): boolean | null {
  if (typeof result.success === "boolean") {
    return result.success;
  }
  const score = scoreFrom(result);
  return score === null ? null : score >= 1;
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringFrom(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAgentName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex") {
    return "codex-acp";
  }
  if (normalized === "claude" || normalized === "claude_code") {
    return "claude-agent-acp";
  }
  return normalized;
}

function agentMatches(actual: string, expected: string): boolean {
  return normalizeAgentName(actual) === normalizeAgentName(expected);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}

function emptyCounts(): Record<CoverageStatus, number> {
  return {
    covered: 0,
    missed: 0,
    violated: 0,
    not_applicable: 0,
    unknown: 0
  };
}

const coverageTargets: CoverageTarget[] = ["final_output", "artifact", "process", "tool_use", "reporting", "unknown"];

function emptyTargetCounts(): Record<CoverageTarget, Record<CoverageStatus, number>> {
  return Object.fromEntries(coverageTargets.map((target) => [target, emptyCounts()])) as Record<CoverageTarget, Record<CoverageStatus, number>>;
}

function countFindingsByTarget(findings: CoverageFinding[]): Record<CoverageTarget, Record<CoverageStatus, number>> {
  const counts = emptyTargetCounts();
  for (const finding of findings) {
    counts[targetFromFinding(finding)][finding.status] += 1;
  }
  return counts;
}

function mergeTargetCounts(
  targetCounts: Record<CoverageTarget, Record<CoverageStatus, number>>,
  nextCounts: Record<CoverageTarget, Record<CoverageStatus, number>> | undefined
) {
  if (!nextCounts) {
    return;
  }
  for (const target of coverageTargets) {
    for (const status of Object.keys(targetCounts[target]) as CoverageStatus[]) {
      targetCounts[target][status] += nextCounts[target]?.[status] ?? 0;
    }
  }
}

function targetRatesFromCounts(targetCounts: Record<CoverageTarget, Record<CoverageStatus, number>>): Record<CoverageTarget, TargetRateAggregate> {
  return Object.fromEntries(
    coverageTargets.map((target) => {
      const counts = targetCounts[target];
      const totalConstraints = Object.values(counts).reduce((sum, value) => sum + value, 0);
      const judgedReachable = counts.covered + counts.violated + counts.missed;
      return [
        target,
        {
          counts,
          totalConstraints,
          judgedReachable,
          noncomplianceRate: judgedReachable ? (counts.violated + counts.missed) / judgedReachable : 0,
          violationRate: judgedReachable ? counts.violated / judgedReachable : 0,
          ignoredRate: judgedReachable ? counts.missed / judgedReachable : 0,
          unknownRate: totalConstraints ? counts.unknown / totalConstraints : 0
        }
      ];
    })
  ) as Record<CoverageTarget, TargetRateAggregate>;
}

function targetFromFinding(finding: CoverageFinding): CoverageTarget {
  const target = finding.target ?? finding.analyzedConstraint?.target;
  return coverageTargets.includes(target as CoverageTarget) ? (target as CoverageTarget) : "unknown";
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "item";
  return normalized.length > 96 ? `${normalized.slice(0, 80).replace(/[-.]+$/g, "")}-${sha256(normalized).slice(0, 12)}` : normalized;
}

function normalizeTextKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}

function trimConstraint(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[-*]\s*/, "").slice(0, 180);
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuoteIfNeeded(value: string): string {
  return /^--[a-z0-9-]+$/i.test(value) ? value : shellQuote(value);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function inlineCode(value: string): string {
  return value.replace(/`/g, "'");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function printUsage() {
  console.log(`Usage:
  npm run skillsbench -- plan --skillsbench-root /path/to/skillsbench --out .skilllens/experiments/sb-codex-gpt55 --trials 3
  npm run skillsbench -- collect --runs-root /path/to/benchflow/results --out .skilllens/experiments/sb-codex-gpt55/collected
  npm run skillsbench -- analyze --plan .skilllens/experiments/sb-codex-gpt55/run-plan.json --runs-root /path/to/benchflow/results --out .skilllens/experiments/sb-codex-gpt55/analysis
  npm run skillsbench -- judge --plan .skilllens/experiments/sb-codex-gpt55/run-plan.json --trials-file .skilllens/experiments/sb-codex-gpt55/collected/trials.json --out .skilllens/experiments/sb-codex-gpt55/agent-analysis
  npm run skillsbench -- propose --plan .skilllens/experiments/sb-codex-gpt55/run-plan.json --analysis .skilllens/experiments/sb-codex-gpt55/analysis/violation-rates.json --out .skilllens/experiments/sb-codex-gpt55/optimized-skills
  npm run skillsbench -- rerun-plan --plan .skilllens/experiments/sb-codex-gpt55/run-plan.json --optimized-skills-root .skilllens/experiments/sb-codex-gpt55/optimized-skills --out .skilllens/experiments/sb-codex-gpt55
  npm run skillsbench -- analysis-plan --plan .skilllens/experiments/sb-codex-gpt55/run-plan.json --optimized-skills-root .skilllens/experiments/sb-codex-gpt55/optimized-skills --out .skilllens/experiments/sb-codex-gpt55/optimized-analysis
  npm run skillsbench -- remote-script --plan .skilllens/experiments/sb-codex-gpt55/run-plan.json --out .skilllens/experiments/sb-codex-gpt55

Options:
  --skillsbench-root       Local SkillsBench checkout. Supports GitHub layout with tasks/ or HF mirror layout.
  --runs-root              Directory containing BenchFlow trial artifacts.
  --agent                  BenchFlow agent name. Default: codex.
  --model                  BenchFlow model name. Default: gpt-5.5.
  --trials                 Commands to generate per task. Default: 1.
  --task                   Repeat to restrict to specific task IDs.
  --max-tasks              Plan only the first N tasks for smoke tests.
  --max-agent-analyses     Limit skill-use analyzer/optimizer jobs considered for smoke/debug.
  --agent-concurrency      Parallel Codex analyzer/optimizer jobs for judge/propose. Default: 4.
  --agent-timeout-ms       Per-skill Codex analyzer timeout for judge. Default: 600000.
  --force                  Re-run cached agent analyses.
  --include-no-skill       Also generate no-skill baseline commands.
  --bench-arg              Repeat to append extra BenchFlow CLI args, such as --sandbox docker.
  --remote-host            Default SSH target for generated remote runner, e.g. user@host.
  --remote-dir             Remote SkillScope checkout path. Default: SkillScope in the remote home.
  --min-failures           Minimum violated+missed findings before optimizing a skill. Default: 1.
  --optimize-nc-threshold  Minimum non-compliance rate for optimizing native-passing process-only misses. Default: 0.1.
  --optimize-stable-pass   Also optimize native-passing low-NC skills with only process/reporting failures.
  --max-edits-per-skill    Cap generated patch bullets per skill. Default: 3.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
