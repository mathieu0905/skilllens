import type { SkillUnit } from "./types";
import { extractConstraints } from "./constraintExtractor";
import { normalizeWhitespace, stableSlug } from "./text";

interface HeadingState {
  level: number;
  text: string;
  id: string;
}

const mandatoryPattern =
  /\b(must|required|always|ensure|verify|run|use|check|do|make sure|before final|should)\b/i;
const prohibitedPattern = /\b(never|do not|don't|avoid|must not|should not|without)\b/i;
const optionalPattern = /\b(optional|may|can|when useful|if needed)\b/i;
const vaguePattern =
  /\b(clear|helpful|useful|robust|appropriate|good|better|quality|carefully|thoughtfully|reasonable)\b/i;
const actionPattern =
  /\b(run|use|call|open|read|write|edit|create|update|delete|test|verify|check|compare|export|download|upload|search|inspect|click|filter|show|cite|quote)\b/i;

export function parseSkillMarkdown(markdown: string): SkillUnit[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const units: SkillUnit[] = [];
  const headings: HeadingState[] = [];
  let paragraph: { text: string[]; start: number } | null = null;
  const contentStartIndex = frontmatterEndIndex(lines);

  const flushParagraph = (endLine: number) => {
    if (!paragraph) {
      return;
    }
    const text = normalizeWhitespace(paragraph.text.join(" "));
    if (text) {
      splitParagraphIntoUnits(text, paragraph.start, endLine, headings, units);
    }
    paragraph = null;
  };

  lines.forEach((line, index) => {
    if (index < contentStartIndex) {
      return;
    }
    const lineNumber = index + 1;
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    const listMatch = line.match(/^\s*(?:[-*+]|[0-9]+[.)])\s+(.+)$/);

    if (/^\s*<!--.*-->\s*$/.test(line)) {
      flushParagraph(lineNumber - 1);
      return;
    }

    if (headingMatch) {
      flushParagraph(lineNumber - 1);
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      while (headings.length && headings[headings.length - 1].level >= level) {
        headings.pop();
      }
      const id = `skill.heading.${lineNumber}.${stableSlug(text)}`;
      headings.push({ level, text, id });
      return;
    }

    if (listMatch) {
      flushParagraph(lineNumber - 1);
      const text = normalizeWhitespace(listMatch[1]);
      if (text) {
        units.push(makeUnit(text, lineNumber, lineNumber, headings, "list", units.length, line));
      }
      return;
    }

    if (!line.trim()) {
      flushParagraph(lineNumber - 1);
      return;
    }

    if (!paragraph) {
      paragraph = { text: [], start: lineNumber };
    }
    paragraph.text.push(line.trim());
  });

  flushParagraph(lines.length);

  return units;
}

function frontmatterEndIndex(lines: string[]): number {
  if (lines[0]?.trim() !== "---") {
    return 0;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end > 0 ? end + 1 : 0;
}

function splitParagraphIntoUnits(
  text: string,
  lineStart: number,
  lineEnd: number,
  headings: HeadingState[],
  units: SkillUnit[]
) {
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z`"']|Do\b|Never\b|Always\b|If\b|When\b)/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);

  const shouldSplit = sentences.length > 1 && text.length > 220;
  const chunks = shouldSplit ? sentences : [text];

  chunks.forEach((chunk) => {
    units.push(makeUnit(chunk, lineStart, lineEnd, headings, shouldSplit ? "sentence" : "paragraph", units.length));
  });
}

function makeUnit(
  text: string,
  lineStart: number,
  lineEnd: number,
  headings: HeadingState[],
  source: SkillUnit["source"],
  index: number,
  sourceLineText?: string
): SkillUnit {
  const modality = classifyModality(text);
  const observable = actionPattern.test(text) && !(text.length > 260 && vaguePattern.test(text));
  const lowObservabilityReason = observable
    ? undefined
    : "Instruction is broad, subjective, or lacks an observable action in the trace.";
  const headingPath = headings.map((heading) => heading.text);
  const parent = headings.length ? headings[headings.length - 1] : null;

  const unitWithoutConstraints = {
    id: `skill.unit.${String(index + 1).padStart(3, "0")}.${stableSlug(text)}`,
    parentId: parent?.id ?? null,
    headingPath,
    text,
    lineStart,
    lineEnd,
    modality,
    observable,
    lowObservabilityReason,
    source
  };

  return {
    ...unitWithoutConstraints,
    constraints: extractConstraints(unitWithoutConstraints, sourceLineText)
  };
}

function classifyModality(text: string): SkillUnit["modality"] {
  if (prohibitedPattern.test(text)) {
    return "prohibited";
  }
  if (mandatoryPattern.test(text)) {
    return "mandatory";
  }
  if (optionalPattern.test(text)) {
    return "optional";
  }
  if (/\b(recommend|prefer|should)\b/i.test(text)) {
    return "recommended";
  }
  return "informational";
}
