import { html, nothing } from "lit";
import type { ToolCard } from "../types/chat-types.ts";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import {
  formatToolCallForSidebar,
  formatToolOutputForSidebar,
  getTruncatedPreview,
} from "./tool-helpers.ts";

type PendingToolCall = {
  id: string | null;
  name: string;
  args: unknown;
  consumed: boolean;
};

export type ToolResultLookup = {
  byCallId: Map<string, ToolCard>;
  byName: Map<string, ToolCard[]>;
};

export function buildToolResultLookup(messages: unknown[]): ToolResultLookup {
  const byCallId = new Map<string, ToolCard>();
  const byName = new Map<string, ToolCard[]>();

  for (const message of messages) {
    const cards = extractToolCards(message);
    for (const card of cards) {
      if (card.kind !== "result") {
        continue;
      }
      if (card.callId) {
        byCallId.set(card.callId, card);
      }
      const bucket = byName.get(card.name);
      if (bucket) {
        bucket.push(card);
      } else {
        byName.set(card.name, [card]);
      }
    }
  }

  return { byCallId, byName };
}

export function extractToolCards(
  message: unknown,
  opts?: {
    toolResultLookup?: ToolResultLookup;
  },
): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];
  const pendingCalls: PendingToolCall[] = [];

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      const name = (item.name as string) ?? "tool";
      const callId = extractToolCallId(item);
      const args = coerceArgs(item.arguments ?? item.args);
      pendingCalls.push({
        id: callId,
        name,
        args,
        consumed: false,
      });
      const lookupResult = resolveToolResultFromLookup(opts?.toolResultLookup, name, callId);
      cards.push({
        kind: "call",
        name,
        callId,
        args,
        sidebarText: lookupResult?.text,
      });
    }
  }

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") {
      continue;
    }
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    const callId = extractToolCallId(item);
    const matchedCall = resolveMatchingCall(pendingCalls, name, callId);
    cards.push({ kind: "result", name, callId, args: matchedCall?.args, text });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const callId = extractToolCallId(m);
    const fallbackArgs = coerceArgs(
      m.toolArgs ?? m.tool_args ?? m.args ?? m.arguments ?? m.input ?? m.toolInput ?? m.tool_input,
    );
    const text = extractTextCached(message) ?? undefined;
    cards.push({ kind: "result", name, callId, args: fallbackArgs, text });
  }

  return cards;
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const sidebarText = card.sidebarText?.trim() ? card.sidebarText : card.text;
  const hasText = Boolean(card.text?.trim());
  const hasSidebarText = Boolean(sidebarText?.trim());

  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick
    ? () => {
        const sections = [
          `## ${display.label}`,
          "### Tool Call",
          formatToolCallForSidebar(card.name, card.args),
          "### Tool Output",
          hasSidebarText
            ? formatToolOutputForSidebar(sidebarText!)
            : "_No output returned by the tool._",
        ];
        onOpenSidebar!(sections.join("\n\n"));
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${
        canClick
          ? (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") {
                return;
              }
              e.preventDefault();
              handleClick?.();
            }
          : nothing
      }
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${
          canClick ? html`<span class="chat-tool-card__action">View ${icons.check}</span>` : nothing
        }
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">${icons.check}</span>` : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${
        isEmpty
          ? html`
              <div class="chat-tool-card__status-text muted">Completed</div>
            `
          : nothing
      }
      ${
        showCollapsed
          ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
          : nothing
      }
      ${showInline ? html`<div class="chat-tool-card__inline mono">${card.text}</div>` : nothing}
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolCallId(item: Record<string, unknown>): string | null {
  const value =
    item.toolCallId ?? item.tool_call_id ?? item.toolUseId ?? item.tool_use_id ?? item.id ?? null;
  return typeof value === "string" && value.trim() ? value : null;
}

function resolveMatchingCall(
  pendingCalls: PendingToolCall[],
  name: string,
  callId: string | null,
): PendingToolCall | undefined {
  if (callId) {
    const byId = pendingCalls.find((entry) => entry.id === callId);
    if (byId) {
      byId.consumed = true;
      return byId;
    }
  }
  const nextByName = pendingCalls.find((entry) => !entry.consumed && entry.name === name);
  if (nextByName) {
    nextByName.consumed = true;
    return nextByName;
  }
  return pendingCalls.find((entry) => entry.name === name);
}

function resolveToolResultFromLookup(
  lookup: ToolResultLookup | undefined,
  name: string,
  callId: string | null,
): ToolCard | undefined {
  if (!lookup) {
    return undefined;
  }
  if (callId) {
    const byId = lookup.byCallId.get(callId);
    if (byId) {
      return byId;
    }
  }
  const byName = lookup.byName.get(name);
  if (!byName || byName.length === 0) {
    return undefined;
  }
  return byName.find((entry) => Boolean(entry.text?.trim())) ?? byName[0];
}

function stringifyToolValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const textParts = value
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const record = item as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          return record.text;
        }
        return null;
      })
      .filter((part): part is string => Boolean(part));
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable tool output]";
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  return (
    stringifyToolValue(item.text) ??
    stringifyToolValue(item.content) ??
    stringifyToolValue(item.result) ??
    stringifyToolValue(item.output) ??
    undefined
  );
}
