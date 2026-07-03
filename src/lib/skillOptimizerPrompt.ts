export interface SkillOptimizerPromptInput {
  launcher: "browser" | "skillsbench";
  optimizerSkillPath: string;
  workDir: string;
  originalSkillPath: string;
  selectedSkillPath?: string;
  constraintsPath: string;
  skillGraphPath: string;
  traceFactsPath: string;
  findingsPath: string;
  nativeVerifierPath?: string;
  traceEventsPath?: string;
  taskPath?: string;
  resultPath?: string;
  optimizedSkillPath: string;
  optimizationReportPath: string;
  optimizationDiffPath: string;
  optimizationPacketPath: string;
  requestId?: string;
  failureSummary?: string;
}

export function buildSkillOptimizerPrompt(input: SkillOptimizerPromptInput): string {
  const optionalInputs = [
    input.selectedSkillPath ? `- Selected skill snapshot: ${input.selectedSkillPath}` : "",
    input.traceEventsPath ? `- Normalized trace events: ${input.traceEventsPath}` : "",
    input.taskPath ? `- Task/context markdown: ${input.taskPath}` : "",
    input.nativeVerifierPath ? `- Native verifier evidence: ${input.nativeVerifierPath}` : "",
    input.resultPath ? `- Result/verifier metadata: ${input.resultPath}` : ""
  ].filter(Boolean);

  return `You were launched by SkillScope's ${input.launcher === "browser" ? "browser UI after Start Analysis" : "SkillsBench optimization command"}.

Do not analyze the current conversation. Optimize only the selected skill described by these local SkillScope artifacts.

Use this optimizer skill and follow it completely:
${input.optimizerSkillPath}

First read the optimizer skill completely. Then read these inputs:
- Original selected skill markdown: ${input.originalSkillPath}
${optionalInputs.join("\n")}
- Extracted constraints: ${input.constraintsPath}
- Skill graph: ${input.skillGraphPath}
- Trace facts: ${input.traceFactsPath}
- Coverage findings: ${input.findingsPath}

Write outputs here:
- Complete optimized SKILL.md: ${input.optimizedSkillPath}
- Optimization report: ${input.optimizationReportPath}
- Optimization diff/patch summary: ${input.optimizationDiffPath}
- Machine-readable optimization packet: ${input.optimizationPacketPath}

Rules:
- The optimization must be based on constraints.json, skill-graph.json, trace-facts.json, and findings.json. Do not bypass those artifacts by manually summarizing the raw trace.
- Use violated and missed findings as optimization evidence. Preserve nearby covered constraints unless they are redundant.
- Distinguish violated from missed: violated needs an invariant/guard against explicit counter-behavior; missed needs reachability, ordering, observability, or validation improvements.
- Distinguish final-output/artifact failures from process-adherence gaps. If native verifier evidence passes and the risky findings are mostly target:"process", do not make the process more brittle; relax or reframe over-specific procedure into output invariants, validation contracts, or flexible branch rules.
- Keep hard contracts separate from implementation hints. Do not make exact helper internals, arbitrary safety bounds, exception text, candidate sort order, scoring tuples, or local tie-breakers mandatory unless the native verifier or findings prove that exact detail is required for correctness.
- If the skill includes reference code, label it as illustrative unless exact fidelity is required, and state the semantic contract in prose outside the snippet.
- Prefer replacing, moving, merging, or deleting existing skill text before adding new bullets.
- Do not add defensive boilerplate such as "no old logic", "do not repeat the previous mistake", "avoid previous failure", "be careful", or "be thorough".
- Every added or changed instruction must map to a future trace fact, command, file artifact, event ordering relation, numeric bound, or output field.
- In optimization-packet.json, label each edit with an editType such as "strengthen_output_contract", "add_validation", "clarify_branch", "relax_process", "merge_duplicate", "delete_unobservable", or "preserve".
- In optimization-packet.json, every edit must include non-empty change text and either constraintIdsAddressed or constraintIdsPreserved. Do not emit null for these fields.
- Do not modify repository source files. Only write the output artifacts listed above.
- The final response can be Markdown and does not need a strict response schema.

${input.failureSummary ? `Failure summary from SkillScope:\n${input.failureSummary}\n` : ""}
Request id: ${input.requestId ?? "not provided"}
Working directory: ${input.workDir}
`;
}
