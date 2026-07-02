import type { SkillConstraint, SkillUnit } from "./types";
import { normalizeWhitespace, stableSlug } from "./text";

interface ConstraintSeed {
  kind: SkillConstraint["kind"];
  text: string;
  indexStart: number;
  indexEnd: number;
  parameters?: Record<string, string | number | boolean>;
  observable?: boolean;
}

const commandPattern = /`([^`]*(?:npm|pnpm|yarn|pytest|cargo|go test|vitest|jest|python|bash|docker|curl|make)[^`]*)`/gi;
const filePattern = /\b[\w./-]+\.(?:md|jsonl?|tsx?|jsx?|py|toml|ya?ml|css|html|pdf|png|jpg|jpeg|txt|sh)\b/g;
const numericPattern = /\b(?:at least|at most|no more than|less than|more than|within|under|over|exactly)?\s*\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|%|percent|times?|files?|events?|steps?|tokens?|words?|lines?|px|MB|GB)?\b/gi;
const prohibitionPattern = /\b(?:never|do not|don't|avoid|must not|should not|without)\s+([^.;]+)/gi;
const orderPattern = /\b(?:before|after|then|finally|prior to|until)\b[^.;]*/gi;
const evidencePattern = /\b(?:evidence|verify|verification|test|screenshot|preview|rendered|cite|quote|report|export|final response)\b[^.;]*/gi;
const conditionPattern = /\b(?:if|when|unless|only if)\b[^.;]*/gi;
const actionPattern = /\b(?:run|use|call|open|read|write|edit|create|update|delete|check|compare|download|upload|search|inspect|click|filter|show|mention|summarize|explain)\b[^.;]*/gi;

export function extractConstraints(unit: Omit<SkillUnit, "constraints">, sourceLineText?: string): SkillConstraint[] {
  const seeds = dedupeSeeds([
    ...matchAll(unit.text, commandPattern, "command", (match) => ({ command: match[1] ?? match[0] })),
    ...matchAll(unit.text, filePattern, "file_reference", (match) => ({ path: match[0] })),
    ...matchAll(unit.text, numericPattern, "numeric", (match) => ({ value: match[0].trim() })),
    ...matchAll(unit.text, prohibitionPattern, "prohibition", (match) => ({ prohibited: match[1]?.trim() ?? match[0] })),
    ...matchAll(unit.text, orderPattern, "order", (match) => ({ relation: match[0].split(/\s+/)[0].toLowerCase() })),
    ...matchAll(unit.text, evidencePattern, "evidence", (match) => ({ signal: match[0].trim() })),
    ...matchAll(unit.text, conditionPattern, "condition", (match) => ({ condition: match[0].trim() })),
    ...matchAll(unit.text, actionPattern, "action", (match) => ({ action: match[0].trim() }))
  ]);

  const effectiveSeeds = seeds.length
    ? seeds
    : [
        {
          kind: "action" as const,
          text: unit.text,
          indexStart: 0,
          indexEnd: unit.text.length,
          observable: unit.observable
        }
      ];

  return effectiveSeeds.map((seed, index) => makeConstraint(unit, seed, index, sourceLineText));
}

function matchAll(
  text: string,
  pattern: RegExp,
  kind: SkillConstraint["kind"],
  params: (match: RegExpExecArray) => Record<string, string | number | boolean>
): ConstraintSeed[] {
  const seeds: ConstraintSeed[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const matched = normalizeWhitespace(match[0]);
    if (!matched) {
      continue;
    }
    seeds.push({
      kind,
      text: matched,
      indexStart: match.index,
      indexEnd: match.index + match[0].length,
      parameters: params(match),
      observable: kind !== "condition"
    });
  }
  return seeds;
}

function dedupeSeeds(seeds: ConstraintSeed[]): ConstraintSeed[] {
  const sorted = [...seeds].sort((a, b) => {
    if (a.indexStart !== b.indexStart) {
      return a.indexStart - b.indexStart;
    }
    return b.indexEnd - b.indexStart - (a.indexEnd - a.indexStart);
  });
  const result: ConstraintSeed[] = [];
  for (const seed of sorted) {
    const duplicate = result.some(
      (existing) =>
        existing.kind === seed.kind &&
        existing.text.toLowerCase() === seed.text.toLowerCase() &&
        Math.abs(existing.indexStart - seed.indexStart) <= 2
    );
    if (!duplicate) {
      result.push(seed);
    }
  }
  return result;
}

function makeConstraint(
  unit: Omit<SkillUnit, "constraints">,
  seed: ConstraintSeed,
  index: number,
  sourceLineText?: string
): SkillConstraint {
  const lineOffset = findLineOffset(sourceLineText ?? unit.text, seed.text, seed.indexStart);
  return {
    id: `${unit.id}.constraint.${String(index + 1).padStart(2, "0")}.${stableSlug(seed.text)}`,
    unitId: unit.id,
    kind: seed.kind,
    text: seed.text,
    normalized: normalizeWhitespace(seed.text).toLowerCase(),
    parameters: seed.parameters ?? {},
    span: {
      lineStart: unit.lineStart,
      lineEnd: unit.lineEnd,
      charStart: lineOffset,
      charEnd: lineOffset + seed.text.length,
      text: seed.text
    },
    observable: seed.observable ?? unit.observable,
    severity: severityFor(unit.modality, seed.kind)
  };
}

function findLineOffset(lineText: string, needle: string, fallback: number): number {
  const direct = lineText.indexOf(needle);
  if (direct >= 0) {
    return direct;
  }
  const normalizedNeedle = normalizeWhitespace(needle);
  const loose = lineText.indexOf(normalizedNeedle);
  if (loose >= 0) {
    return loose;
  }
  return Math.max(0, fallback);
}

function severityFor(unitModality: SkillUnit["modality"], kind: SkillConstraint["kind"]): SkillConstraint["severity"] {
  if (kind === "prohibition" || unitModality === "prohibited") {
    return "must_not";
  }
  if (unitModality === "mandatory") {
    return "must";
  }
  if (unitModality === "recommended") {
    return "should";
  }
  if (unitModality === "optional") {
    return "may";
  }
  return "info";
}
