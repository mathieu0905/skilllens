import type { TraceEvent, TraceEventType, TraceFormat } from "./types";
import { normalizeWhitespace } from "./text";

export function detectTraceFormat(traceText: string): TraceFormat {
  const sample = traceText.slice(0, 8000);
  if (!sample.trim()) {
    return "plain_text";
  }
  if (/"type"\s*:\s*"session_meta"|"originator"\s*:\s*"codex-tui"|"turn_context"|"response_item"/i.test(sample)) {
    return "codex";
  }
  if (/"acp_trajectory"|"session_id"|"turn_id"|"trajectory"/i.test(sample)) {
    return "acp";
  }
  if (/"tool_use"|"tool_result"|"claude"|"Bash"|"Edit"|"MultiEdit"/i.test(sample)) {
    return "claude_code";
  }
  if (/"exec_command"|"apply_patch"|"functions\."|"recipient_name"|"tool_calls"/i.test(sample)) {
    return "codex";
  }
  if (/^\s*[{[]/.test(sample)) {
    return "generic_jsonl";
  }
  return "plain_text";
}

export function parseTraceText(traceText: string): TraceEvent[] {
  const trimmed = traceText.trim();
  if (!trimmed) {
    return [];
  }

  const jsonLines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (jsonLines.length === 1 && (jsonLines[0].startsWith("[") || jsonLines[0].startsWith("{"))) {
    try {
      const parsed = JSON.parse(jsonLines[0]);
      const entries = Array.isArray(parsed) ? parsed : extractArrayFromObject(parsed);
      return normalizeEntries(entries.length ? entries : [parsed]);
    } catch {
      return parsePlainText(trimmed);
    }
  }

  const parsedLines: unknown[] = [];
  for (const line of jsonLines) {
    try {
      parsedLines.push(JSON.parse(line));
    } catch {
      parsedLines.push({ role: "unknown", content: line });
    }
  }

  return normalizeEntries(parsedLines);
}

function extractArrayFromObject(value: Record<string, unknown>): unknown[] {
  for (const key of ["events", "trajectory", "messages", "steps", "records"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function parsePlainText(text: string): TraceEvent[] {
  return text
    .split(/\n{2,}/)
    .map((chunk, index) =>
      makeEvent(index, {
        role: "unknown",
        type: "observation",
        content: chunk,
        raw: chunk
      })
    );
}

function normalizeEntries(entries: unknown[]): TraceEvent[] {
  const events = entries.flatMap((entry, index) => normalizeEntry(entry, index));
  return events.map((event, index) => ({
    ...event,
    id: `trace.event.${String(index + 1).padStart(3, "0")}`,
    step: index + 1
  }));
}

function normalizeEntry(entry: unknown, index: number): TraceEvent[] {
  if (!entry || typeof entry !== "object") {
    return [
      makeEvent(index, {
        role: "unknown",
        type: "observation",
        content: String(entry ?? ""),
        raw: entry
      })
    ];
  }

  const value = entry as Record<string, unknown>;

  if (value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)) {
    const codexEvents = normalizeCodexRolloutEnvelope(value, entry, index);
    if (codexEvents) {
      return codexEvents;
    }
  }

  const nested = value.message ?? value.event ?? value.data ?? null;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const merged = { ...(nested as Record<string, unknown>), ...value };
    delete merged.message;
    delete merged.event;
    delete merged.data;
    return normalizeObject(merged, entry, index);
  }

  return normalizeObject(value, entry, index);
}

function normalizeCodexRolloutEnvelope(value: Record<string, unknown>, raw: unknown, index: number): TraceEvent[] | null {
  const envelopeType = stringValue(value.type).toLowerCase();
  const payload = value.payload as Record<string, unknown>;
  const payloadType = stringValue(payload.type).toLowerCase();

  if (envelopeType === "session_meta") {
    return [
      makeEvent(index, {
        role: "system",
        type: "observation",
        content: stringify({
          session_id: payload.session_id ?? payload.id,
          cwd: payload.cwd,
          originator: payload.originator,
          cli_version: payload.cli_version,
          model_provider: payload.model_provider
        }),
        output: "",
        files: filesFrom(payload),
        time: timeFrom(value),
        raw
      })
    ];
  }

  if (envelopeType === "turn_context") {
    return [
      makeEvent(index, {
        role: "system",
        type: "observation",
        content: stringify({
          cwd: payload.cwd,
          current_date: payload.current_date,
          model: payload.model,
          summary: payload.summary
        }),
        output: "",
        files: filesFrom(payload),
        time: timeFrom(value),
        raw
      })
    ];
  }

  if (envelopeType === "response_item") {
    return normalizeObject(payload, raw, index);
  }

  if (envelopeType === "event_msg" && (payloadType === "user_message" || payloadType === "agent_message")) {
    return [
      makeEvent(index, {
        role: payloadType === "user_message" ? "user" : "assistant",
        type: payloadType === "user_message" ? "user_message" : "assistant_message",
        content: stringValue(payload.message) || stringify(payload.text_elements),
        output: "",
        files: filesFrom(payload),
        time: timeFrom(value),
        raw
      })
    ];
  }

  return null;
}

function normalizeObject(value: Record<string, unknown>, raw: unknown, index: number): TraceEvent[] {
  const role = stringValue(value.role ?? value.sender ?? value.author ?? value.type) || "unknown";
  const contentBlocks = Array.isArray(value.content) ? value.content : null;
  if (contentBlocks) {
    return normalizeContentBlocks(value, contentBlocks, raw, index, role);
  }

  const toolCalls = value.tool_calls ?? value.toolCalls ?? value.function_calls;
  const events: TraceEvent[] = [];

  if (Array.isArray(toolCalls)) {
    const messageContent = contentFrom(value);
    if (messageContent) {
      events.push(
        makeEvent(index, {
          role,
          type: inferType(value, messageContent, role),
          name: stringValue(value.name),
          content: messageContent,
          output: stringValue(value.output ?? value.result ?? value.observation),
          files: filesFrom(value),
          time: timeFrom(value),
          raw
        })
      );
    }

    toolCalls.forEach((call) => {
      const callObject: Record<string, unknown> =
        typeof call === "object" && call ? (call as Record<string, unknown>) : { content: call };
      const name = stringValue(
        callObject.name ??
          callObject.tool_name ??
          callObject.function_name ??
          (typeof callObject.function === "object"
            ? (callObject.function as Record<string, unknown>).name
            : undefined)
      );
      const args =
        callObject.arguments ??
        callObject.args ??
        callObject.input ??
        (typeof callObject.function === "object"
          ? (callObject.function as Record<string, unknown>).arguments
          : undefined);
      events.push(
        makeEvent(index, {
          role: "assistant",
          type: inferToolType(name, args),
          name,
          content: stringify(args || callObject.content || callObject),
          output: "",
          files: filesFrom(callObject),
          time: timeFrom(value),
          raw: call
        })
      );
    });

    return events;
  }

  const name = stringValue(value.name ?? value.tool_name ?? value.function_name ?? value.command);
  const content = contentFrom(value) || stringify(value.input ?? value.arguments ?? value.command ?? value);
  events.push(
    makeEvent(index, {
      role,
      type: inferType(value, content, role, name),
      name,
      content,
      output: stringValue(value.output ?? value.result ?? value.observation ?? value.stderr ?? value.stdout),
      files: filesFrom(value),
      time: timeFrom(value),
      raw
    })
  );
  return events;
}

function normalizeContentBlocks(
  value: Record<string, unknown>,
  contentBlocks: unknown[],
  raw: unknown,
  index: number,
  role: string
): TraceEvent[] {
  const events: TraceEvent[] = [];
  contentBlocks.forEach((block) => {
    if (!block || typeof block !== "object") {
      events.push(
        makeEvent(index, {
          role,
          type: role.toLowerCase().includes("user") ? "user_message" : "assistant_message",
          content: String(block ?? ""),
          output: "",
          files: [],
          time: timeFrom(value),
          raw: block
        })
      );
      return;
    }

    const blockObject = block as Record<string, unknown>;
    const blockType = stringValue(blockObject.type).toLowerCase();
    if (blockType === "text" || blockObject.text) {
      events.push(
        makeEvent(index, {
          role,
          type: role.toLowerCase().includes("user") ? "user_message" : "assistant_message",
          content: stringValue(blockObject.text) || stringify(blockObject.content),
          output: "",
          files: filesFrom(blockObject),
          time: timeFrom(value),
          raw: block
        })
      );
      return;
    }

    if (blockType === "tool_use" || blockObject.name || blockObject.input) {
      const name = stringValue(blockObject.name);
      const input = blockObject.input ?? blockObject.arguments ?? blockObject.content;
      events.push(
        makeEvent(index, {
          role: "assistant",
          type: inferToolType(name, input),
          name,
          content: stringify(input),
          output: "",
          files: filesFrom(blockObject),
          time: timeFrom(value),
          raw: block
        })
      );
      return;
    }

    if (blockType === "tool_result" || blockObject.tool_use_id) {
      events.push(
        makeEvent(index, {
          role: "tool",
          type: "tool_output",
          name: stringValue(blockObject.name ?? blockObject.tool_use_id),
          content: stringify(blockObject.content),
          output: stringify(blockObject.content),
          files: filesFrom(blockObject),
          time: timeFrom(value),
          raw: block
        })
      );
      return;
    }

    events.push(
      makeEvent(index, {
        role,
        type: "observation",
        content: stringify(blockObject),
        output: "",
        files: filesFrom(blockObject),
        time: timeFrom(value),
        raw: block
      })
    );
  });

  return events.length
    ? events
    : [
        makeEvent(index, {
          role,
          type: inferType(value, stringify(value), role),
          content: stringify(value),
          output: "",
          files: filesFrom(value),
          time: timeFrom(value),
          raw
        })
      ];
}

function makeEvent(
  index: number,
  props: Partial<TraceEvent> & Pick<TraceEvent, "role" | "type" | "content" | "raw">
): TraceEvent {
  return {
    id: `trace.event.${String(index + 1).padStart(3, "0")}`,
    step: index + 1,
    role: props.role,
    type: props.type,
    name: props.name ?? null,
    content: normalizeWhitespace(props.content),
    output: normalizeWhitespace(props.output ?? ""),
    files: props.files ?? [],
    time: props.time ?? null,
    raw: props.raw
  };
}

function inferType(
  value: Record<string, unknown>,
  content: string,
  role: string,
  name?: string | null
): TraceEventType {
  const lowerRole = role.toLowerCase();
  const lowerName = (name ?? "").toLowerCase();
  const lowerType = stringValue(value.type ?? value.event_type ?? value.kind).toLowerCase();
  const lowerContent = content.toLowerCase();

  if (lowerType.includes("tool") || lowerName) {
    return inferToolType(lowerName, content);
  }
  if (lowerType.includes("edit") || lowerName.includes("patch") || /\b(apply_patch|diff --git)\b/.test(lowerContent)) {
    return "file_edit";
  }
  if (lowerType.includes("observation") || lowerType.includes("output")) {
    return "tool_output";
  }
  if (lowerRole.includes("assistant") && /\b(final answer|final response)\b/.test(lowerContent)) {
    return "final_answer";
  }
  if (lowerRole.includes("assistant")) {
    return "assistant_message";
  }
  if (lowerRole.includes("user")) {
    return "user_message";
  }
  return "observation";
}

function inferToolType(name: string | null, args: unknown): TraceEventType {
  const lowerName = (name ?? "").toLowerCase();
  const lowerArgs = stringify(args).toLowerCase();
  if (lowerName.includes("exec") || lowerName.includes("shell") || lowerName.includes("command")) {
    return "command";
  }
  if (lowerName.includes("patch") || lowerName.includes("edit") || /\b(diff --git|apply_patch)\b/.test(lowerArgs)) {
    return "file_edit";
  }
  if (lowerName || lowerArgs) {
    return "tool_call";
  }
  return "unknown";
}

function contentFrom(value: Record<string, unknown>): string {
  const candidates = [
    value.content,
    value.text,
    value.message_text,
    value.command,
    value.input,
    value.arguments,
    value.args
  ];
  for (const candidate of candidates) {
    const normalized = stringify(candidate);
    if (normalized && normalized !== "{}" && normalized !== "[]") {
      return normalized;
    }
  }
  return "";
}

function filesFrom(value: Record<string, unknown>): string[] {
  const rawFiles = value.files ?? value.file_paths ?? value.paths ?? value.path;
  if (Array.isArray(rawFiles)) {
    return rawFiles.map((item) => String(item));
  }
  if (typeof rawFiles === "string") {
    return [rawFiles];
  }
  const text = stringify(value);
  const matches = text.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|md|json|toml|yml|yaml|css|html|pdf)/g);
  return Array.from(new Set(matches ?? []));
}

function timeFrom(value: Record<string, unknown>): string | null {
  return stringValue(value.time ?? value.timestamp ?? value.created_at) || null;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          const object = item as Record<string, unknown>;
          return stringValue(object.text ?? object.content) || JSON.stringify(object);
        }
        return String(item ?? "");
      })
      .join("\n");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
