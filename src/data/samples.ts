import { createProject } from "../lib/project";
import type { SkillLensProject } from "../lib/types";

const skillMarkdown = `# PDF Editing Skill

Use this skill when the user asks you to inspect, edit, or verify a PDF artifact.

## Intake

- Read the user's requested PDF change before touching files.
- Inspect the source document structure before editing.
- Do not overwrite the original PDF unless the user explicitly asks for replacement.

## Editing

- Use a file edit or conversion tool that preserves the visible page content.
- Keep a copy of the modified artifact path in the final response.
- If the edit changes text layout, inspect the resulting page visually.

## Verification

- Run a verification command before the final response.
- Capture a screenshot or rendered preview when the task is visual.
- If verification fails, explain the failing evidence instead of claiming success.

## Final Response

- Summarize the exact file changed.
- Mention the verification evidence.
- Do not include unrelated implementation details in the final response.
`;

const withSkillTrace = [
  {
    type: "user",
    message: {
      role: "user",
      content: "Please replace the date in report.pdf and make sure the final PDF still renders correctly."
    }
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I will inspect the PDF structure and create a modified copy before verifying the rendered output."
        },
        {
          type: "tool_use",
          name: "Bash",
          input: {
            command: "pdfinfo report.pdf && mkdir -p output"
          }
        }
      ]
    }
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          content: "Pages: 2\nPDF version: 1.7\nTagged: no"
        }
      ]
    }
  },
  {
    role: "assistant",
    content: "The original file is readable. I will write a separate edited artifact under output/."
  },
  {
    role: "assistant",
    tool_calls: [
      {
        name: "functions.exec_command",
        arguments: {
          cmd: "python scripts/replace_pdf_text.py report.pdf output/report-edited.pdf --from 2025-05-01 --to 2026-07-01"
        }
      }
    ]
  },
  {
    role: "assistant",
    tool_calls: [
      {
        name: "functions.exec_command",
        arguments: {
          cmd: "python scripts/render_pdf.py output/report-edited.pdf --page 1 --out output/report-page-1.png"
        }
      }
    ]
  },
  {
    role: "assistant",
    tool_calls: [
      {
        name: "browser.screenshot",
        arguments: {
          path: "output/report-page-1.png",
          viewport: "desktop"
        }
      }
    ]
  },
  {
    role: "assistant",
    tool_calls: [
      {
        name: "functions.exec_command",
        arguments: {
          cmd: "python scripts/verify_pdf_text.py output/report-edited.pdf 2026-07-01"
        }
      }
    ]
  },
  {
    role: "assistant",
    content:
      "Final answer: Changed output/report-edited.pdf. Verification evidence: pdf text verifier passed and output/report-page-1.png rendered the edited page."
  }
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

const noSkillTrace = [
  {
    role: "user",
    content: "Please replace the date in report.pdf and make sure the final PDF still renders correctly."
  },
  {
    role: "assistant",
    content: "I can update the PDF now."
  },
  {
    role: "assistant",
    tool_calls: [
      {
        name: "functions.exec_command",
        arguments: {
          cmd: "python scripts/replace_pdf_text.py report.pdf report.pdf --from 2025-05-01 --to 2026-07-01"
        }
      }
    ]
  },
  {
    role: "assistant",
    content: "Final answer: I updated report.pdf with the new date."
  }
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

const codexTrace = [
  {
    role: "user",
    content: "Add a compact status summary and run tests."
  },
  {
    role: "assistant",
    content: "I will inspect the project and make a small patch."
  },
  {
    role: "assistant",
    tool_calls: [
      {
        name: "functions.exec_command",
        arguments: {
          cmd: "rg --files && sed -n '1,180p' src/App.tsx"
        }
      }
    ]
  },
  {
    role: "assistant",
    tool_calls: [
      {
        name: "functions.apply_patch",
        arguments: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n+// status summary\n*** End Patch"
      }
    ]
  },
  {
    role: "assistant",
    tool_calls: [
      {
        name: "functions.exec_command",
        arguments: {
          cmd: "npm test"
        }
      }
    ]
  },
  {
    role: "assistant",
    content: "Final answer: Added the summary and verified it with npm test."
  }
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

const taskMarkdown = `# Task

Replace the visible date in a PDF report while preserving the final rendered PDF.
Return the edited artifact path and verification evidence.`;

export const sampleInputs = {
  skillMarkdown,
  withSkillTrace,
  noSkillTrace,
  codexTrace,
  taskMarkdown
};

export const demoProjects: SkillLensProject[] = [
  createProject(
    "PDF edit with skill",
    skillMarkdown,
    withSkillTrace,
    {
      success: true,
      score: 1,
      model: "claude-code-demo",
      task: "edit-pdf",
      source: "Claude Code JSONL"
    },
    "demo"
  ),
  createProject(
    "PDF edit no skill",
    skillMarkdown,
    noSkillTrace,
    {
      success: false,
      score: 0.3,
      model: "codex-demo",
      task: "edit-pdf",
      source: "Codex JSONL"
    },
    "demo"
  ),
  createProject(
    "Codex coding sample",
    `# Coding Agent Skill

## Workflow

- Read relevant files before editing.
- Use apply_patch for manual code edits.
- Run the test suite before the final response.
- Mention the verification result in the final response.
- Do not overwrite unrelated user changes.
`,
    codexTrace,
    {
      success: true,
      score: 0.9,
      model: "codex-demo",
      task: "coding-change",
      source: "Codex JSONL"
    },
    "demo",
    "Add a compact status summary and run tests."
  )
];
