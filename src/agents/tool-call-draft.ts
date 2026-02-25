export type TextualToolCallDraftMatch = {
  marker: string;
  markerStart: number;
  markerEnd: number;
  jsonStart: number;
};

const TEXTUAL_TOOL_CALL_MARKER_RE =
  /(?:[+#]{4,}\s*)?assistant\s+to=(?:functions\.[a-zA-Z0-9_]+|multi_tool_use\.parallel)\b/i;

const TEXTUAL_TOOL_CALL_JSON_AFTER_RE = /(?:^|[\r\n])\s*(?:```(?:json)?\s*[\r\n])?\s*[{[]/im;

/**
 * Detect leaked plain-text tool-call drafts like:
 *   assistant to=functions.exec
 *   {"command":"pwd"}
 */
export function findTextualToolCallDraft(text: string): TextualToolCallDraftMatch | undefined {
  if (!text) {
    return undefined;
  }
  const marker = TEXTUAL_TOOL_CALL_MARKER_RE.exec(text);
  if (!marker || marker.index == null) {
    return undefined;
  }
  const markerStart = marker.index;
  const markerEnd = markerStart + marker[0].length;
  const afterMarker = text.slice(markerEnd);
  const jsonMatch = TEXTUAL_TOOL_CALL_JSON_AFTER_RE.exec(afterMarker);
  if (!jsonMatch || jsonMatch.index == null) {
    return undefined;
  }
  return {
    marker: marker[0],
    markerStart,
    markerEnd,
    jsonStart: markerEnd + jsonMatch.index,
  };
}

export function hasTextualToolCallDraft(text: string): boolean {
  return Boolean(findTextualToolCallDraft(text));
}

export function stripTextualToolCallDraftFromText(text: string): string {
  const match = findTextualToolCallDraft(text);
  if (!match) {
    return text;
  }
  return text
    .slice(0, match.markerStart)
    .replace(/[ \t]+\r?\n/g, "\n")
    .trimEnd();
}
