import type { AnalysisMethod, CoverageStatus } from "./types";

export interface AnalysisRecipe {
  schemaVersion: "skilllens.recipe.v1";
  name: string;
  method: AnalysisMethod;
  instructionSelection: {
    includeModalities: Array<"mandatory" | "prohibited" | "recommended" | "optional" | "informational">;
    includeLowObservability: boolean;
    focusTerms: string[];
    excludeTerms: string[];
  };
  candidateRetrieval: {
    maxCandidatesPerUnit: number;
    lexicalThreshold: number;
    structuredSignalBoost: number;
    includeFinalEventForMisses: boolean;
  };
  evidencePolicy: {
    coveredRequiresEvidence: boolean;
    violatedRequiresCounterEvidence: boolean;
    missedCanUseFinalEvent: boolean;
    allowedAutoStatuses: CoverageStatus[];
  };
  judge: {
    enabled: boolean;
    provider: "none" | "openai_compatible";
    model?: string;
    maxEvidenceEvents: number;
    promptHint?: string;
  };
}

export const defaultAnalysisRecipe: AnalysisRecipe = {
  schemaVersion: "skilllens.recipe.v1",
  name: "local-precheck-candidates",
  method: "heuristic",
  instructionSelection: {
    includeModalities: ["mandatory", "prohibited", "recommended", "optional", "informational"],
    includeLowObservability: true,
    focusTerms: [],
    excludeTerms: []
  },
  candidateRetrieval: {
    maxCandidatesPerUnit: 5,
    lexicalThreshold: 0.18,
    structuredSignalBoost: 0.34,
    includeFinalEventForMisses: true
  },
  evidencePolicy: {
    coveredRequiresEvidence: true,
    violatedRequiresCounterEvidence: true,
    missedCanUseFinalEvent: true,
    allowedAutoStatuses: ["unknown"]
  },
  judge: {
    enabled: false,
    provider: "none",
    maxEvidenceEvents: 3
  }
};

export function normalizeRecipe(input: unknown): AnalysisRecipe {
  if (!input || typeof input !== "object") {
    return defaultAnalysisRecipe;
  }
  const value = input as Partial<AnalysisRecipe>;
  return {
    schemaVersion: "skilllens.recipe.v1",
    name: typeof value.name === "string" ? value.name : defaultAnalysisRecipe.name,
    method: value.method ?? defaultAnalysisRecipe.method,
    instructionSelection: {
      ...defaultAnalysisRecipe.instructionSelection,
      ...(value.instructionSelection ?? {})
    },
    candidateRetrieval: {
      ...defaultAnalysisRecipe.candidateRetrieval,
      ...(value.candidateRetrieval ?? {})
    },
    evidencePolicy: {
      ...defaultAnalysisRecipe.evidencePolicy,
      ...(value.evidencePolicy ?? {})
    },
    judge: {
      ...defaultAnalysisRecipe.judge,
      ...(value.judge ?? {})
    }
  };
}
