/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

function wrapCodeBlock(content: string, language = "text"): string {
  const maxRun = Math.max(2, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(maxRun + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}

export function formatToolCallForSidebar(name: string, args: unknown): string {
  const payload = {
    type: "tool_call",
    name,
    arguments: args ?? {},
  };
  return wrapCodeBlock(JSON.stringify(payload, null, 2), "json");
}

/**
 * Format tool output content for display in the sidebar.
 * Detects JSON and always returns a fenced code block for raw inspection.
 */
export function formatToolOutputForSidebar(text: string): string {
  const trimmed = text.trim();
  // Try to detect and format JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return wrapCodeBlock(JSON.stringify(parsed, null, 2), "json");
    } catch {
      // Not valid JSON; fall through to text.
    }
  }
  return wrapCodeBlock(text, "text");
}

/**
 * Get a truncated preview of tool output text.
 * Truncates to first N lines or first N characters, whichever is shorter.
 */
export function getTruncatedPreview(text: string): string {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "…";
  }
  return lines.length < allLines.length ? preview + "…" : preview;
}
