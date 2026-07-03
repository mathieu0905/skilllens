export interface SkillsBenchCoverageCounts {
  covered: number;
  missed: number;
  violated: number;
  unknown: number;
  notApplicable: number;
}

export interface SkillsBenchRunMetrics {
  label: string;
  reward: number | null;
  passedTests: number | null;
  totalTests: number | null;
  failedTests: number;
  nonComplianceRate: number | null;
  finalOutputNonComplianceRate?: number | null;
  counts: SkillsBenchCoverageCounts;
}

export interface SkillsBenchShowcaseCase {
  slug: string;
  taskId: string;
  title: string;
  skillRelPath: string;
  status: "accepted" | "not_accepted" | "blocked";
  outcome: string;
  original: SkillsBenchRunMetrics;
  optimized?: SkillsBenchRunMetrics;
  blockedReason?: string;
  topOriginalFindings: string[];
  topOptimizedFindings: string[];
  artifactPaths: string[];
}

export const skillsBenchShowcaseCases: SkillsBenchShowcaseCase[] = [
  {
    slug: "e2e-court-form-filling",
    taskId: "court-form-filling",
    title: "Court form PDF filling",
    skillRelPath: "environment/skills/pdf/SKILL.md",
    status: "accepted",
    outcome: "Native verifier passed after rewrite; SkillScope non-compliance dropped to zero.",
    original: {
      label: "Original skill",
      reward: 0,
      passedTests: 4,
      totalTests: 5,
      failedTests: 1,
      nonComplianceRate: 0.25,
      finalOutputNonComplianceRate: 0,
      counts: { covered: 6, missed: 0, violated: 2, unknown: 0, notApplicable: 16 }
    },
    optimized: {
      label: "Optimized skill",
      reward: 1,
      passedTests: 5,
      totalTests: 5,
      failedTests: 0,
      nonComplianceRate: 0,
      finalOutputNonComplianceRate: 0,
      counts: { covered: 16, missed: 0, violated: 0, unknown: 0, notApplicable: 3 }
    },
    topOriginalFindings: [
      "Process violation: follow the linked form-filling instructions.",
      "Process violation: use forms.md when filling PDF forms."
    ],
    topOptimizedFindings: [],
    artifactPaths: [
      ".skilllens/experiments/skillsbench-codex-gpt55/e2e-court-form-filling/comparison.md",
      ".skilllens/experiments/skillsbench-codex-gpt55/e2e-court-form-filling/optimized-skills/court-form-filling/environment/skills/pdf/SKILL.md"
    ]
  },
  {
    slug: "e2e-manufacturing-fjsp-optimization",
    taskId: "manufacturing-fjsp-optimization",
    title: "Manufacturing FJSP repair",
    skillRelPath: "environment/skills/fjsp-baseline-repair-with-downtime-and-policy/SKILL.md",
    status: "accepted",
    outcome: "Native verifier passed after rewrite; final-output and artifact NC reached zero.",
    original: {
      label: "Original skill",
      reward: 0,
      passedTests: 13,
      totalTests: 15,
      failedTests: 2,
      nonComplianceRate: 0.5,
      finalOutputNonComplianceRate: 0.35714285714285715,
      counts: { covered: 14, missed: 0, violated: 14, unknown: 7, notApplicable: 0 }
    },
    optimized: {
      label: "Optimized skill",
      reward: 1,
      passedTests: 15,
      totalTests: 15,
      failedTests: 0,
      nonComplianceRate: 0.02631578947368421,
      finalOutputNonComplianceRate: 0,
      counts: { covered: 37, missed: 0, violated: 1, unknown: 1, notApplicable: 0 }
    },
    topOriginalFindings: [
      "Final-output violation: preserve right-shift-only baseline repair.",
      "Final-output violation: respect anchor(j,o) and precedence-aware local minimality.",
      "Process violation: choose earliest feasible start under downtime and machine occupancy."
    ],
    topOptimizedFindings: ["Remaining process issue: tie-break order was not fully followed."],
    artifactPaths: [
      ".skilllens/experiments/skillsbench-codex-gpt55/e2e-manufacturing-fjsp-optimization/run-summary.md",
      ".skilllens/experiments/skillsbench-codex-gpt55/e2e-manufacturing-fjsp-optimization/optimized-skills/manufacturing-fjsp-optimization/environment/skills/fjsp-baseline-repair-with-downtime-and-policy/SKILL.md"
    ]
  },
  {
    slug: "e2e-azure-bgp-oscillation-route-leak",
    taskId: "azure-bgp-oscillation-route-leak",
    title: "Azure BGP route leak diagnosis",
    skillRelPath: "environment/skills/azure-bgp/SKILL.md",
    status: "not_accepted",
    outcome: "SkillScope NC improved, especially final-output NC, but native verifier still failed.",
    original: {
      label: "Original skill",
      reward: 0,
      passedTests: 3,
      totalTests: 4,
      failedTests: 1,
      nonComplianceRate: 0.2777777777777778,
      finalOutputNonComplianceRate: 0.358974358974359,
      counts: { covered: 65, missed: 12, violated: 13, unknown: 37, notApplicable: 2 }
    },
    optimized: {
      label: "Optimized skill",
      reward: 0,
      passedTests: 3,
      totalTests: 4,
      failedTests: 1,
      nonComplianceRate: 0.23333333333333334,
      finalOutputNonComplianceRate: 0.08695652173913043,
      counts: { covered: 46, missed: 9, violated: 5, unknown: 57, notApplicable: 4 }
    },
    topOriginalFindings: [
      "Final-output violation: route-leak and oscillation fixes were misclassified.",
      "Missed recommendation: prefer routing intent when available.",
      "Reporting misses: several required verdict fields were absent."
    ],
    topOptimizedFindings: [
      "Native still failed on RPKI origin validation.",
      "Unknown count increased, so the rewrite is not accepted."
    ],
    artifactPaths: [
      ".skilllens/experiments/skillsbench-codex-gpt55/e2e-azure-bgp-oscillation-route-leak/final-report.md",
      ".skilllens/experiments/skillsbench-codex-gpt55/e2e-azure-bgp-oscillation-route-leak/optimized-skills/azure-bgp-oscillation-route-leak/environment/skills/azure-bgp/SKILL.md"
    ]
  },
  {
    slug: "e2e-data-to-d3",
    taskId: "data-to-d3",
    title: "Data-to-D3 visualization",
    skillRelPath: "environment/skills/d3-visualization/SKILL.md",
    status: "blocked",
    outcome: "Stopped before agent execution because the Docker sandbox was not prebuilt.",
    blockedReason: "Spent 35+ minutes in Docker/Node/Playwright setup and never reached the agent, verifier, or SkillScope judge.",
    original: {
      label: "Original skill",
      reward: null,
      passedTests: null,
      totalTests: null,
      failedTests: 0,
      nonComplianceRate: null,
      counts: { covered: 0, missed: 0, violated: 0, unknown: 0, notApplicable: 0 }
    },
    topOriginalFindings: ["Environment setup blocked before a trace existed."],
    topOptimizedFindings: [],
    artifactPaths: [
      ".skilllens/experiments/skillsbench-codex-gpt55/e2e-data-to-d3/original/logs/original/data-to-d3__trial-1.log"
    ]
  }
];
