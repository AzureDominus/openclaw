export type DeclaredStopReason = "completed" | "needs_user_input";

const STOP_REASON_TRAILING_PARSE_RE =
  /(?:^|\r?\n)[ \t]*OPENCLAW_STOP_REASON[ \t]*:[ \t]*([^\r\n]+)[ \t]*(?:\r?\n[ \t]*)*$/i;
const STOP_REASON_TRAILING_STRIP_RE =
  /(?:\r?\n)?[ \t]*OPENCLAW_STOP_REASON[ \t]*:[ \t]*[^\r\n]*[ \t]*(?:\r?\n[ \t]*)*$/i;

function normalizeDeclaredStopReason(raw: string): DeclaredStopReason | undefined {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) {
    return undefined;
  }
  if (normalized === "completed" || normalized === "complete" || normalized === "done") {
    return "completed";
  }
  if (
    normalized === "needs_user_input" ||
    normalized === "need_user_input" ||
    normalized === "needs_input" ||
    normalized === "blocked"
  ) {
    return "needs_user_input";
  }
  return undefined;
}

export function extractDeclaredStopReasonFromText(
  text: string | undefined,
): DeclaredStopReason | undefined {
  if (!text || !text.trim()) {
    return undefined;
  }
  const match = STOP_REASON_TRAILING_PARSE_RE.exec(text);
  if (!match) {
    return undefined;
  }
  return normalizeDeclaredStopReason(match[1] ?? "");
}

export function extractDeclaredStopReason(params: {
  assistantTexts: string[];
  lastAssistant?: unknown;
}): DeclaredStopReason | undefined {
  for (const text of params.assistantTexts) {
    const parsed = extractDeclaredStopReasonFromText(text);
    if (parsed) {
      return parsed;
    }
  }
  const fallbackText = extractLastAssistantText(params.lastAssistant);
  return extractDeclaredStopReasonFromText(fallbackText);
}

export function stripDeclaredStopReasonLine(text: string): string {
  if (!text.trim()) {
    return text;
  }
  const stripped = text.replace(STOP_REASON_TRAILING_STRIP_RE, "");
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function extractLastAssistantText(lastAssistant: unknown): string {
  if (!lastAssistant || typeof lastAssistant !== "object") {
    return "";
  }
  const obj = lastAssistant as {
    content?: unknown;
    text?: unknown;
  };
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const block of obj.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const entry = block as { type?: unknown; text?: unknown };
      const type = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";
      if ((type === "text" || type === "") && typeof entry.text === "string" && entry.text) {
        parts.push(entry.text);
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (typeof obj.text === "string") {
    return obj.text;
  }
  return "";
}
