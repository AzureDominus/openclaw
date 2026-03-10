import fs from "node:fs";
import path from "node:path";
import express from "express";
import { resolveStateDir } from "../src/config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../src/config/sessions/paths.js";

type SessionStoreEntry = {
  sessionId?: string;
  sessionFile?: string;
  updatedAt?: number;
  label?: string;
  displayName?: string;
  origin?: {
    label?: string;
  };
};

type ChatSummary = {
  chatId: string;
  sessionKey: string | null;
  title: string;
  updatedAt: number | null;
  mtimeMs: number | null;
  filePath: string;
  isActive: boolean;
};

type AgentSummary = {
  id: string;
  chatCount: number;
  latestUpdatedAt: number | null;
  activeChatId: string | null;
};

type MessageLine = {
  lineNumber: number;
  kind: string;
  role: string | null;
  timestamp: number | null;
  preview: string;
  editable: boolean;
  deletable: boolean;
  thinkingSignatureCount: number;
  editableText: string | null;
  editableParts: Array<{ key: string; label: string; text: string }>;
};

type Args = {
  host: string;
  port: number;
};

const MAX_MESSAGES_DEFAULT = 250;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CHAT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function parseArgs(argv: string[]): Args {
  let host = "127.0.0.1";
  let port = 4789;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--host" && argv[index + 1]) {
      host = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--port" && argv[index + 1]) {
      const parsed = Number.parseInt(String(argv[index + 1]), 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
        port = parsed;
      }
      index += 1;
      continue;
    }
  }
  return { host, port };
}

function printHelp() {
  // Keep this script dead simple for local operator use.
  console.log(`
OpenClaw Agent Chat Editor

Usage:
  node --import tsx scripts/agent-chat-editor.ts [--host 127.0.0.1] [--port 4789]

Options:
  --host <host>   Bind host (default: 127.0.0.1)
  --port <port>   Bind port (default: 4789)
  -h, --help      Show this help
`);
}

function readJsonFile(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return {};
    }
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeParseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readSingleQueryValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function listAgentIds(stateDir: string): string[] {
  const agentsDir = path.join(stateDir, "agents");
  try {
    return fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && AGENT_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function parseSessionStore(storePath: string): Record<string, SessionStoreEntry> {
  const parsed = readJsonFile(storePath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, SessionStoreEntry> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    result[key] = value as SessionStoreEntry;
  }
  return result;
}

function isWithin(parentDir: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveTranscriptPath(
  sessionsDir: string,
  sessionId: string,
  sessionFile?: string,
): string {
  const fallback = path.join(sessionsDir, `${sessionId}.jsonl`);
  const raw = sessionFile?.trim();
  if (!raw) {
    return fallback;
  }
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(sessionsDir, raw);
  if (isWithin(sessionsDir, candidate)) {
    return candidate;
  }
  return fallback;
}

function deriveChatTitle(sessionKey: string, entry: SessionStoreEntry, chatId: string): string {
  const candidate =
    entry.label?.trim() ||
    entry.displayName?.trim() ||
    entry.origin?.label?.trim() ||
    sessionKey.trim();
  return candidate || chatId;
}

function statMtime(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function loadAgentChats(agentId: string): ChatSummary[] {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const store = parseSessionStore(storePath);

  const byChatId = new Map<string, Omit<ChatSummary, "isActive">>();

  for (const [sessionKey, entry] of Object.entries(store)) {
    const sessionId = entry.sessionId?.trim();
    if (!sessionId || !CHAT_ID_RE.test(sessionId)) {
      continue;
    }
    const filePath = resolveTranscriptPath(sessionsDir, sessionId, entry.sessionFile);
    const mtimeMs = statMtime(filePath);
    const updatedAt = Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : null;
    const existing = byChatId.get(sessionId);
    const mergedUpdatedAt =
      updatedAt == null && mtimeMs == null
        ? null
        : Math.max(updatedAt ?? 0, mtimeMs ?? 0, existing?.updatedAt ?? 0);
    byChatId.set(sessionId, {
      chatId: sessionId,
      sessionKey,
      title: deriveChatTitle(sessionKey, entry, sessionId),
      updatedAt: mergedUpdatedAt,
      mtimeMs: mtimeMs ?? existing?.mtimeMs ?? null,
      filePath,
    });
  }

  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const chatId = entry.name.slice(0, -".jsonl".length);
      if (!CHAT_ID_RE.test(chatId)) {
        continue;
      }
      const filePath = path.join(sessionsDir, entry.name);
      const mtimeMs = statMtime(filePath);
      const existing = byChatId.get(chatId);
      if (existing) {
        existing.mtimeMs = mtimeMs;
        existing.updatedAt = Math.max(existing.updatedAt ?? 0, mtimeMs ?? 0);
        existing.filePath = filePath;
      } else {
        byChatId.set(chatId, {
          chatId,
          sessionKey: null,
          title: chatId,
          updatedAt: mtimeMs,
          mtimeMs,
          filePath,
        });
      }
    }
  } catch {
    // Missing sessions dir is fine; the UI will just show no chats.
  }

  const rows = [...byChatId.values()].toSorted(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  );
  return rows.map((chat, index) => ({ ...chat, isActive: index === 0 }));
}

function extractSummaryTextFromThinkingSignature(thinkingSignature: unknown): string | null {
  if (typeof thinkingSignature !== "string" || !thinkingSignature.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(thinkingSignature) as Record<string, unknown>;
    const summary = parsed.summary;
    if (!Array.isArray(summary)) {
      return null;
    }
    for (const item of summary) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      if (row.type === "summary_text" && typeof row.text === "string" && row.text.trim()) {
        return row.text;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function patchSummaryTextInThinkingSignature(
  thinkingSignature: unknown,
  value: string,
): string | undefined {
  if (typeof thinkingSignature !== "string" || !thinkingSignature.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(thinkingSignature) as Record<string, unknown>;
    const summary = Array.isArray(parsed.summary) ? [...parsed.summary] : [];
    let replaced = false;
    for (let index = 0; index < summary.length; index += 1) {
      const item = summary[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = { ...(item as Record<string, unknown>) };
      if (row.type === "summary_text" && typeof row.text === "string") {
        row.text = value;
        summary[index] = row;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      summary.push({ type: "summary_text", text: value });
    }
    parsed.summary = summary;
    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

function listEditableMessageParts(
  message: Record<string, unknown>,
): Array<{ key: string; label: string; text: string }> {
  const parts: Array<{ key: string; label: string; text: string }> = [];
  const content = message.content;
  if (typeof content === "string") {
    parts.push({ key: "content:string", label: "Text", text: content });
    return parts;
  }
  if (!Array.isArray(content)) {
    return parts;
  }
  let textCount = 0;
  let thinkingCount = 0;
  let summaryCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    const item = content[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const typed = item as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim()) {
      textCount += 1;
      parts.push({
        key: `content:${index}:text`,
        label: `Text ${textCount}`,
        text: typed.text,
      });
      continue;
    }
    if (typed.type === "thinking") {
      if (typeof typed.thinking === "string" && typed.thinking.trim()) {
        thinkingCount += 1;
        parts.push({
          key: `content:${index}:thinking`,
          label: `Thinking ${thinkingCount}`,
          text: typed.thinking,
        });
      }
      const summaryText = extractSummaryTextFromThinkingSignature(typed.thinkingSignature);
      if (summaryText) {
        summaryCount += 1;
        parts.push({
          key: `content:${index}:thinkingSummary`,
          label: `Summary ${summaryCount}`,
          text: summaryText,
        });
      }
    }
  }
  return parts;
}

function countThinkingSignatures(message: Record<string, unknown>): number {
  const content = message.content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let count = 0;
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const typed = item as Record<string, unknown>;
    if (
      typed.type === "thinking" &&
      typeof typed.thinkingSignature === "string" &&
      typed.thinkingSignature.trim()
    ) {
      count += 1;
    }
  }
  return count;
}

function stripThinkingSignatures(message: Record<string, unknown>): {
  message: Record<string, unknown>;
  removed: number;
} {
  const content = message.content;
  if (!Array.isArray(content)) {
    return { message, removed: 0 };
  }
  const cloned = [...content];
  let removed = 0;
  for (let index = 0; index < cloned.length; index += 1) {
    const current = cloned[index];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      continue;
    }
    const block = { ...(current as Record<string, unknown>) };
    if (
      block.type === "thinking" &&
      typeof block.thinkingSignature === "string" &&
      block.thinkingSignature.trim()
    ) {
      delete block.thinkingSignature;
      cloned[index] = block;
      removed += 1;
    }
  }
  if (removed === 0) {
    return { message, removed: 0 };
  }
  return { message: { ...message, content: cloned }, removed };
}

function patchMessageText(
  message: Record<string, unknown>,
  value: string,
): Record<string, unknown> {
  const content = message.content;
  if (typeof content === "string") {
    return { ...message, content: value };
  }
  if (Array.isArray(content)) {
    const cloned = [...content];

    // Pass 1: update the first user-visible text block.
    for (let index = 0; index < cloned.length; index += 1) {
      const current = cloned[index];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        continue;
      }
      const block = { ...(current as Record<string, unknown>) };
      if (block.type === "text" && typeof block.text === "string") {
        block.text = value;
        cloned[index] = block;
        return { ...message, content: cloned };
      }
    }

    // Pass 2: if no text block, update thinking/summary text.
    for (let index = 0; index < cloned.length; index += 1) {
      const current = cloned[index];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        continue;
      }
      const block = { ...(current as Record<string, unknown>) };
      if (block.type === "thinking") {
        if (typeof block.thinking === "string") {
          block.thinking = value;
        }
        const patchedSummary = patchSummaryTextInThinkingSignature(block.thinkingSignature, value);
        if (patchedSummary) {
          block.thinkingSignature = patchedSummary;
        }
        if (typeof block.thinking !== "string" && !patchedSummary) {
          continue;
        }
        cloned[index] = block;
        return { ...message, content: cloned };
      }
    }
    cloned.push({ type: "text", text: value });
    return { ...message, content: cloned };
  }
  return { ...message, content: [{ type: "text", text: value }] };
}

function patchMessageTextPart(
  message: Record<string, unknown>,
  partKey: string | undefined,
  value: string,
): Record<string, unknown> {
  const key = partKey?.trim();
  if (!key) {
    return patchMessageText(message, value);
  }
  if (key === "content:string") {
    if (typeof message.content !== "string") {
      throw new Error("Selected part no longer exists.");
    }
    return { ...message, content: value };
  }

  const match = /^content:(\d+):(text|thinking|thinkingSummary)$/.exec(key);
  if (!match) {
    throw new Error("Invalid part key.");
  }
  const index = Number.parseInt(match[1] ?? "", 10);
  const kind = match[2];
  if (!Array.isArray(message.content)) {
    throw new Error("Selected part no longer exists.");
  }
  if (!Number.isFinite(index) || index < 0 || index >= message.content.length) {
    throw new Error("Selected part no longer exists.");
  }

  const cloned = [...message.content];
  const current = cloned[index];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("Selected part no longer exists.");
  }
  const block = { ...(current as Record<string, unknown>) };

  if (kind === "text") {
    if (block.type !== "text" || typeof block.text !== "string") {
      throw new Error("Selected text part no longer exists.");
    }
    block.text = value;
    cloned[index] = block;
    return { ...message, content: cloned };
  }
  if (kind === "thinking") {
    if (block.type !== "thinking" || typeof block.thinking !== "string") {
      throw new Error("Selected thinking part no longer exists.");
    }
    block.thinking = value;
    cloned[index] = block;
    return { ...message, content: cloned };
  }

  if (block.type !== "thinking") {
    throw new Error("Selected summary part no longer exists.");
  }
  const patchedSummary = patchSummaryTextInThinkingSignature(block.thinkingSignature, value);
  if (!patchedSummary) {
    throw new Error("Summary payload is not editable.");
  }
  block.thinkingSignature = patchedSummary;
  cloned[index] = block;
  return { ...message, content: cloned };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, max - 1)}...`;
}

function toMessageLine(line: string, lineNumber: number): MessageLine {
  const trimmed = line.trim();
  if (!trimmed) {
    return {
      lineNumber,
      kind: "blank",
      role: null,
      timestamp: null,
      preview: "(blank line)",
      editable: false,
      deletable: false,
      thinkingSignatureCount: 0,
      editableText: null,
      editableParts: [],
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const kind = typeof parsed.type === "string" ? parsed.type : "unknown";
    const message =
      parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
        ? (parsed.message as Record<string, unknown>)
        : null;
    const role = message && typeof message.role === "string" ? message.role : null;
    const tsFromMessage = message ? safeParseTimestamp(message.timestamp) : null;
    const timestamp = safeParseTimestamp(parsed.timestamp) ?? tsFromMessage;
    const editableParts = message ? listEditableMessageParts(message) : [];
    const thinkingSignatureCount = message ? countThinkingSignatures(message) : 0;
    const editableText = editableParts[0]?.text ?? null;
    const isMessageLine = kind === "message" && Boolean(message);
    if (message) {
      return {
        lineNumber,
        kind,
        role,
        timestamp,
        preview: truncate(editableText ?? trimmed, 160),
        editable: isMessageLine && editableParts.length > 0,
        deletable: true,
        thinkingSignatureCount,
        editableText,
        editableParts,
      };
    }
    return {
      lineNumber,
      kind,
      role,
      timestamp,
      preview: truncate(trimmed, 160),
      editable: false,
      deletable: true,
      thinkingSignatureCount: 0,
      editableText: null,
      editableParts: [],
    };
  } catch {
    return {
      lineNumber,
      kind: "invalid-json",
      role: null,
      timestamp: null,
      preview: truncate(trimmed, 160),
      editable: false,
      deletable: true,
      thinkingSignatureCount: 0,
      editableText: null,
      editableParts: [],
    };
  }
}

function readFileLines(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function writeFileLines(filePath: string, lines: string[]): void {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const backupPath = `${filePath}.webedit.${Date.now()}.bak`;
  fs.copyFileSync(filePath, backupPath);
  fs.writeFileSync(tempPath, `${lines.join("\n")}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function ensureAgentId(value: string): string {
  if (!AGENT_ID_RE.test(value)) {
    throw new Error("Invalid agent id.");
  }
  return value;
}

function ensureChatId(value: string): string {
  if (!CHAT_ID_RE.test(value)) {
    throw new Error("Invalid chat id.");
  }
  return value;
}

function findChatOrThrow(agentId: string, chatId: string): ChatSummary {
  const chats = loadAgentChats(agentId);
  const chat = chats.find((entry) => entry.chatId === chatId);
  if (!chat) {
    throw new Error("Chat not found.");
  }
  if (!fs.existsSync(chat.filePath)) {
    throw new Error("Transcript file not found.");
  }
  return chat;
}

function createUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>OpenClaw Agent Chat Editor</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --panel: #ffffff;
      --text: #162035;
      --muted: #5f6f8a;
      --accent: #0f7a5c;
      --accent-soft: #d8f4eb;
      --line: #d8dfeb;
      --danger: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 10% 10%, #d6e6ff 0%, rgba(214, 230, 255, 0) 42%),
        radial-gradient(circle at 90% 0%, #d6ffe8 0%, rgba(214, 255, 232, 0) 35%),
        var(--bg);
    }
    .wrap {
      max-width: 1400px;
      margin: 20px auto;
      padding: 0 14px;
      display: grid;
      gap: 12px;
      grid-template-columns: 260px 360px 1fr;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      min-height: 78vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .panel h2 {
      font-size: 14px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
    }
    .list {
      overflow: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      cursor: pointer;
      background: #fff;
    }
    .item:hover { border-color: #adc4f4; }
    .item.active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .item .title {
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 3px;
      word-break: break-word;
    }
    .item .meta {
      font-size: 12px;
      color: var(--muted);
    }
    .messages {
      overflow: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      background: #fff;
    }
    .msg-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .preview {
      font-size: 13px;
      margin-bottom: 8px;
      white-space: pre-wrap;
    }
    .part-label {
      font-size: 12px;
      color: var(--muted);
      margin: 8px 0 4px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    textarea {
      width: 100%;
      min-height: 90px;
      border: 1px solid #b7c4dc;
      border-radius: 8px;
      padding: 8px;
      font: 13px/1.45 "Menlo", "SFMono-Regular", monospace;
      resize: vertical;
    }
    .actions {
      margin-top: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    button {
      border: none;
      border-radius: 8px;
      padding: 8px 12px;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-danger {
      background: var(--danger);
    }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .status {
      font-size: 12px;
      color: var(--muted);
    }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--accent); }
    .toolbar {
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn-muted {
      background: #6b7280;
    }
    .msg.pending-delete {
      opacity: 0.72;
      border-color: #efb2a6;
      background: #fff5f3;
    }
    .msg.pending-strip {
      border-color: #9ab7df;
      background: #f3f8ff;
    }
    @media (max-width: 1100px) {
      .wrap {
        grid-template-columns: 1fr;
        margin: 12px auto;
      }
      .panel { min-height: 30vh; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="panel">
      <h2>Agents</h2>
      <div id="agents" class="list"></div>
    </section>
    <section class="panel">
      <h2>Chats</h2>
      <div id="chats" class="list"></div>
    </section>
    <section class="panel">
      <h2>Messages</h2>
      <div class="toolbar">
        <div id="chatLabel">Select an agent/chat.</div>
        <div class="toolbar-actions">
          <span id="globalStatus" class="status"></span>
          <button id="discardChanges" class="btn-muted" disabled>Discard</button>
          <button id="saveChanges" disabled>Save Changes</button>
        </div>
      </div>
      <div id="messages" class="messages"></div>
    </section>
  </div>
  <script>
    const state = {
      agents: [],
      chats: [],
      messages: [],
      selectedAgent: null,
      selectedChat: null,
      pendingByLine: {},
    };

    const agentsEl = document.getElementById("agents");
    const chatsEl = document.getElementById("chats");
    const messagesEl = document.getElementById("messages");
    const chatLabelEl = document.getElementById("chatLabel");
    const globalStatusEl = document.getElementById("globalStatus");
    const saveChangesBtn = document.getElementById("saveChanges");
    const discardChangesBtn = document.getElementById("discardChanges");

    function fmtTime(ms) {
      if (!ms) return "unknown";
      try { return new Date(ms).toLocaleString(); } catch { return "unknown"; }
    }

    function setGlobalStatus(text, kind) {
      globalStatusEl.textContent = text || "";
      globalStatusEl.className = kind ? ("status " + kind) : "status";
    }

    async function api(url, options) {
      const res = await fetch(url, options);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || ("Request failed (" + res.status + ")"));
      }
      return res.json();
    }

    function pendingCount() {
      let total = 0;
      for (const lineState of Object.values(state.pendingByLine)) {
        if (!lineState || typeof lineState !== "object") {
          continue;
        }
        if (lineState.delete === true) {
          total += 1;
          continue;
        }
        if (lineState.stripThinkingSignature === true) {
          total += 1;
        }
        const updates = lineState.updates ?? {};
        total += Object.keys(updates).length;
      }
      return total;
    }

    function lineStateFor(lineNumber) {
      const key = String(lineNumber);
      const current = state.pendingByLine[key];
      if (!current || typeof current !== "object") {
        return { delete: false, stripThinkingSignature: false, updates: {} };
      }
      const updates = current.updates && typeof current.updates === "object" ? current.updates : {};
      return {
        delete: current.delete === true,
        stripThinkingSignature: current.stripThinkingSignature === true,
        updates: { ...updates },
      };
    }

    function commitLineState(lineNumber, lineState) {
      const key = String(lineNumber);
      const hasUpdates = Object.keys(lineState.updates ?? {}).length > 0;
      const hasStrip = lineState.stripThinkingSignature === true;
      if (!lineState.delete && !hasUpdates && !hasStrip) {
        delete state.pendingByLine[key];
        return;
      }
      state.pendingByLine[key] = lineState;
    }

    function refreshPendingUi() {
      const count = pendingCount();
      saveChangesBtn.disabled = count === 0 || !state.selectedAgent || !state.selectedChat;
      discardChangesBtn.disabled = count === 0;
      saveChangesBtn.textContent = count > 0 ? ("Save Changes (" + count + ")") : "Save Changes";
    }

    function clearPending() {
      state.pendingByLine = {};
      refreshPendingUi();
    }

    function resolveOriginalPartText(message, partKey) {
      const part = (message.editableParts || []).find((entry) => entry.key === partKey);
      return part?.text ?? "";
    }

    function queueUpdate(message, partKey, value) {
      const lineState = lineStateFor(message.lineNumber);
      lineState.delete = false;
      const original = resolveOriginalPartText(message, partKey);
      if (value === original) {
        delete lineState.updates[partKey];
      } else {
        lineState.updates[partKey] = value;
      }
      commitLineState(message.lineNumber, lineState);
      refreshPendingUi();
    }

    function toggleDelete(message) {
      const lineState = lineStateFor(message.lineNumber);
      if (lineState.delete) {
        lineState.delete = false;
      } else {
        lineState.delete = true;
        lineState.stripThinkingSignature = false;
        lineState.updates = {};
      }
      commitLineState(message.lineNumber, lineState);
      refreshPendingUi();
      renderMessages();
    }

    function isPendingDelete(message) {
      return lineStateFor(message.lineNumber).delete === true;
    }

    function toggleStripThinkingSignature(message) {
      const lineState = lineStateFor(message.lineNumber);
      lineState.delete = false;
      lineState.stripThinkingSignature = !lineState.stripThinkingSignature;
      commitLineState(message.lineNumber, lineState);
      refreshPendingUi();
      renderMessages();
    }

    function isPendingStripThinkingSignature(message) {
      return lineStateFor(message.lineNumber).stripThinkingSignature === true;
    }

    function effectivePartText(message, part) {
      const lineState = lineStateFor(message.lineNumber);
      const pending = lineState.updates?.[part.key];
      return typeof pending === "string" ? pending : part.text;
    }

    function linePendingUpdateCount(message) {
      const lineState = lineStateFor(message.lineNumber);
      return Object.keys(lineState.updates ?? {}).length;
    }

    function buildPendingOperations() {
      const operations = [];
      for (const [lineKey, lineStateRaw] of Object.entries(state.pendingByLine)) {
        const lineNumber = Number.parseInt(lineKey, 10);
        if (!Number.isFinite(lineNumber) || lineNumber < 1) {
          continue;
        }
        const lineState = lineStateRaw && typeof lineStateRaw === "object" ? lineStateRaw : {};
        if (lineState.delete === true) {
          operations.push({ action: "delete", lineNumber });
          continue;
        }
        if (lineState.stripThinkingSignature === true) {
          operations.push({ action: "stripThinkingSignature", lineNumber });
        }
        const updates = lineState.updates && typeof lineState.updates === "object" ? lineState.updates : {};
        for (const [partKey, messageText] of Object.entries(updates)) {
          operations.push({ action: "update", lineNumber, partKey, messageText: String(messageText) });
        }
      }
      return operations;
    }

    function renderAgents() {
      agentsEl.innerHTML = "";
      for (const agent of state.agents) {
        const div = document.createElement("div");
        div.className = "item" + (state.selectedAgent === agent.id ? " active" : "");
        div.innerHTML =
          '<div class="title">' + agent.id + '</div>' +
          '<div class="meta">' + agent.chatCount + ' chats</div>' +
          '<div class="meta">latest: ' + fmtTime(agent.latestUpdatedAt) + '</div>';
        div.onclick = () => selectAgent(agent.id);
        agentsEl.appendChild(div);
      }
    }

    function renderChats() {
      chatsEl.innerHTML = "";
      for (const chat of state.chats) {
        const badge = chat.isActive ? " (active)" : "";
        const div = document.createElement("div");
        div.className = "item" + (state.selectedChat === chat.chatId ? " active" : "");
        div.innerHTML =
          '<div class="title">' + (chat.title || chat.chatId) + badge + '</div>' +
          '<div class="meta">' + chat.chatId + '</div>' +
          '<div class="meta">' + fmtTime(chat.updatedAt) + '</div>';
        div.onclick = () => selectChat(chat.chatId);
        chatsEl.appendChild(div);
      }
    }

    function renderMessages() {
      messagesEl.innerHTML = "";
      for (const message of state.messages) {
        const card = document.createElement("article");
        const pendingDelete = isPendingDelete(message);
        const pendingStrip = isPendingStripThinkingSignature(message);
        card.className =
          "msg" +
          (pendingDelete ? " pending-delete" : "") +
          (pendingStrip && !pendingDelete ? " pending-strip" : "");
        const role = message.role || "-";
        const ts = fmtTime(message.timestamp);
        const metaRight = "line " + message.lineNumber + " / " + message.kind;
        const header = document.createElement("div");
        header.className = "msg-head";
        header.innerHTML = '<div>' + role + ' • ' + ts + '</div><div>' + metaRight + '</div>';
        card.appendChild(header);

        const preview = document.createElement("div");
        preview.className = "preview";
        preview.textContent = message.preview || "(no preview)";
        card.appendChild(preview);

        if (message.editable || message.deletable) {
          const editableParts = Array.isArray(message.editableParts) ? message.editableParts : [];
          for (const part of editableParts) {
            const label = document.createElement("div");
            label.className = "part-label";
            label.textContent = part.label;
            card.appendChild(label);

            const textarea = document.createElement("textarea");
            textarea.value = effectivePartText(message, part);
            textarea.disabled = pendingDelete;
            textarea.oninput = () => {
              queueUpdate(message, part.key, textarea.value);
            };
            card.appendChild(textarea);
          }

          const actions = document.createElement("div");
          actions.className = "actions";
          const status = document.createElement("span");
          status.className = "status";
          if (message.deletable) {
            const deleteButton = document.createElement("button");
            deleteButton.textContent = pendingDelete ? "Undo Delete" : "Mark Delete";
            deleteButton.className = "btn-danger";
            deleteButton.onclick = () => {
              toggleDelete(message);
            };
            actions.appendChild(deleteButton);
          }

          if (message.thinkingSignatureCount > 0) {
            const stripButton = document.createElement("button");
            stripButton.textContent = pendingStrip
              ? "Undo Strip Signature"
              : "Strip Signature (" + String(message.thinkingSignatureCount) + ")";
            stripButton.className = "btn-muted";
            stripButton.onclick = () => {
              toggleStripThinkingSignature(message);
            };
            actions.appendChild(stripButton);
          }

          const updatesCount = linePendingUpdateCount(message);
          if (pendingDelete) {
            status.textContent = "Pending delete";
            status.className = "status error";
          } else if (pendingStrip && updatesCount > 0) {
            status.textContent = "Pending signature strip + edits (" + String(updatesCount) + ")";
            status.className = "status";
          } else if (pendingStrip) {
            status.textContent = "Pending signature strip";
            status.className = "status";
          } else if (updatesCount > 0) {
            status.textContent = "Pending edits (" + String(updatesCount) + ")";
            status.className = "status";
          }

          actions.appendChild(status);
          card.appendChild(actions);
        }
        messagesEl.appendChild(card);
      }
    }

    discardChangesBtn.onclick = () => {
      clearPending();
      renderMessages();
      setGlobalStatus("Discarded unsaved changes.", "");
    };

    saveChangesBtn.onclick = async () => {
      const operations = buildPendingOperations();
      if (operations.length === 0 || !state.selectedAgent || !state.selectedChat) {
        return;
      }
      saveChangesBtn.disabled = true;
      discardChangesBtn.disabled = true;
      setGlobalStatus("Saving changes...", "");
      try {
        const payload = await api(
          "/api/agents/" + encodeURIComponent(state.selectedAgent) +
            "/chats/" + encodeURIComponent(state.selectedChat) +
            "/messages/batch",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operations }),
          },
        );
        await loadMessages();
        setGlobalStatus(
          "Saved " + String(payload.applied ?? operations.length) + " change(s).",
          "ok",
        );
      } catch (error) {
        setGlobalStatus(error.message || "Save failed", "error");
      } finally {
        refreshPendingUi();
      }
    };

    async function loadAgents() {
      const payload = await api("/api/agents");
      state.agents = payload.agents || [];
      renderAgents();
      if (!state.selectedAgent && state.agents.length > 0) {
        await selectAgent(state.agents[0].id);
      }
    }

    async function selectAgent(agentId) {
      state.selectedAgent = agentId;
      state.selectedChat = null;
      state.messages = [];
      clearPending();
      renderAgents();
      setGlobalStatus("Loading chats...", "");
      const payload = await api("/api/agents/" + encodeURIComponent(agentId) + "/chats");
      state.chats = payload.chats || [];
      renderChats();
      renderMessages();
      setGlobalStatus("", "");
      if (state.chats.length > 0) {
        const active = state.chats.find((entry) => entry.isActive) || state.chats[0];
        await selectChat(active.chatId);
      } else {
        chatLabelEl.textContent = "No chats for " + agentId;
      }
    }

    async function selectChat(chatId) {
      state.selectedChat = chatId;
      renderChats();
      await loadMessages();
    }

    async function loadMessages() {
      if (!state.selectedAgent || !state.selectedChat) return;
      setGlobalStatus("Loading messages...", "");
      const payload = await api(
        "/api/agents/" + encodeURIComponent(state.selectedAgent) +
          "/chats/" + encodeURIComponent(state.selectedChat) +
          "/messages",
      );
      state.messages = payload.messages || [];
      clearPending();
      chatLabelEl.textContent =
        state.selectedAgent + " / " + state.selectedChat + " (" + state.messages.length + " lines)";
      renderMessages();
      setGlobalStatus("", "");
    }

    refreshPendingUi();

    loadAgents().catch((error) => {
      setGlobalStatus(error.message || "Failed to load", "error");
    });
  </script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = resolveStateDir(process.env);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(createUi());
  });

  app.get("/api/agents", (_req, res) => {
    const agents = listAgentIds(stateDir).map((id) => {
      const chats = loadAgentChats(id);
      const first = chats[0] ?? null;
      return {
        id,
        chatCount: chats.length,
        latestUpdatedAt: first?.updatedAt ?? null,
        activeChatId: first?.chatId ?? null,
      } satisfies AgentSummary;
    });
    res.json({ stateDir, agents });
  });

  app.get("/api/agents/:agentId/chats", (req, res) => {
    try {
      const agentId = ensureAgentId(String(req.params.agentId));
      const limitRaw = Number.parseInt(readSingleQueryValue(req.query.limit) ?? "100", 10);
      const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : 100, 1, 500);
      const chats = loadAgentChats(agentId).slice(0, limit);
      res.json({ agentId, chats });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/agents/:agentId/chats/:chatId/messages", (req, res) => {
    try {
      const agentId = ensureAgentId(String(req.params.agentId));
      const chatId = ensureChatId(String(req.params.chatId));
      const limitRaw = Number.parseInt(
        readSingleQueryValue(req.query.limit) ?? String(MAX_MESSAGES_DEFAULT),
        10,
      );
      const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : MAX_MESSAGES_DEFAULT, 1, 2000);
      const chat = findChatOrThrow(agentId, chatId);
      const lines = readFileLines(chat.filePath);
      const startIndex = Math.max(0, lines.length - limit);
      const messages = lines
        .slice(startIndex)
        .map((line, idx) => toMessageLine(line, startIndex + idx + 1));
      res.json({
        agentId,
        chatId,
        filePath: chat.filePath,
        totalLines: lines.length,
        messages,
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/agents/:agentId/chats/:chatId/messages/batch", (req, res) => {
    try {
      const agentId = ensureAgentId(String(req.params.agentId));
      const chatId = ensureChatId(String(req.params.chatId));
      const incoming = Array.isArray(req.body?.operations) ? req.body.operations : null;
      if (!incoming || incoming.length === 0) {
        throw new Error("Request must include at least one operation.");
      }
      if (incoming.length > 2000) {
        throw new Error("Too many operations in one request.");
      }

      const operations: Array<{
        lineNumber: number;
        action: "update" | "delete" | "stripThinkingSignature";
        messageText?: string;
        partKey?: string;
      }> = [];
      for (const item of incoming) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("Invalid operation entry.");
        }
        const lineNumber = Number.parseInt(
          String((item as Record<string, unknown>).lineNumber),
          10,
        );
        if (!Number.isFinite(lineNumber) || lineNumber < 1) {
          throw new Error("Invalid operation line number.");
        }
        const action = (item as Record<string, unknown>).action;
        if (action !== "update" && action !== "delete" && action !== "stripThinkingSignature") {
          throw new Error("Operation action must be update, delete, or stripThinkingSignature.");
        }
        if (action === "update") {
          const messageText = (item as Record<string, unknown>).messageText;
          if (typeof messageText !== "string") {
            throw new Error("Update operations must include messageText.");
          }
          const partKeyRaw = (item as Record<string, unknown>).partKey;
          const partKey =
            typeof partKeyRaw === "string" && partKeyRaw.trim() ? partKeyRaw : undefined;
          operations.push({ lineNumber, action, messageText, partKey });
        } else {
          operations.push({ lineNumber, action });
        }
      }

      const chat = findChatOrThrow(agentId, chatId);
      const lines = readFileLines(chat.filePath);
      const updates = operations.filter((operation) => operation.action === "update");
      for (const operation of updates) {
        const index = operation.lineNumber - 1;
        if (index < 0 || index >= lines.length) {
          throw new Error("Operation line number out of range.");
        }
        const currentRaw = lines[index] ?? "";
        const parsed = JSON.parse(currentRaw) as Record<string, unknown>;
        if (parsed.type !== "message") {
          throw new Error("Only transcript lines with type=message are mutable.");
        }
        if (
          !parsed.message ||
          typeof parsed.message !== "object" ||
          Array.isArray(parsed.message)
        ) {
          throw new Error("Message line has invalid payload.");
        }
        const nextMessage = patchMessageTextPart(
          parsed.message as Record<string, unknown>,
          operation.partKey,
          operation.messageText?.trimEnd() ?? "",
        );
        lines[index] = JSON.stringify({ ...parsed, message: nextMessage });
      }
      const strips = operations.filter(
        (operation) => operation.action === "stripThinkingSignature",
      );
      for (const operation of strips) {
        const index = operation.lineNumber - 1;
        if (index < 0 || index >= lines.length) {
          throw new Error("Operation line number out of range.");
        }
        const currentRaw = lines[index] ?? "";
        const parsed = JSON.parse(currentRaw) as Record<string, unknown>;
        if (parsed.type !== "message") {
          throw new Error("Only transcript lines with type=message are mutable.");
        }
        if (
          !parsed.message ||
          typeof parsed.message !== "object" ||
          Array.isArray(parsed.message)
        ) {
          throw new Error("Message line has invalid payload.");
        }
        const stripped = stripThinkingSignatures(parsed.message as Record<string, unknown>);
        lines[index] = JSON.stringify({ ...parsed, message: stripped.message });
      }
      const deletes = operations
        .filter((operation) => operation.action === "delete")
        .toSorted((left, right) => right.lineNumber - left.lineNumber);
      for (const operation of deletes) {
        const index = operation.lineNumber - 1;
        if (index < 0 || index >= lines.length) {
          throw new Error("Operation line number out of range.");
        }
        lines.splice(index, 1);
      }
      writeFileLines(chat.filePath, lines);
      res.json({ ok: true, applied: operations.length });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/agents/:agentId/chats/:chatId/messages/:lineNumber", (req, res) => {
    try {
      const agentId = ensureAgentId(String(req.params.agentId));
      const chatId = ensureChatId(String(req.params.chatId));
      const lineNumber = Number.parseInt(String(req.params.lineNumber), 10);
      if (!Number.isFinite(lineNumber) || lineNumber < 1) {
        throw new Error("Invalid line number.");
      }
      const messageText = typeof req.body?.messageText === "string" ? req.body.messageText : null;
      if (messageText == null) {
        throw new Error("Request must include messageText.");
      }
      const partKey =
        typeof req.body?.partKey === "string" && req.body.partKey.trim()
          ? req.body.partKey
          : undefined;
      const chat = findChatOrThrow(agentId, chatId);
      const lines = readFileLines(chat.filePath);
      const index = lineNumber - 1;
      if (index < 0 || index >= lines.length) {
        throw new Error("Line number out of range.");
      }
      const currentRaw = lines[index] ?? "";
      const parsed = JSON.parse(currentRaw) as Record<string, unknown>;
      if (parsed.type !== "message") {
        throw new Error("Only transcript lines with type=message are editable.");
      }
      if (!parsed.message || typeof parsed.message !== "object" || Array.isArray(parsed.message)) {
        throw new Error("Message line has invalid payload.");
      }
      const nextMessage = patchMessageTextPart(
        parsed.message as Record<string, unknown>,
        partKey,
        messageText.trimEnd(),
      );
      const nextLine = JSON.stringify({
        ...parsed,
        message: nextMessage,
      });
      lines[index] = nextLine;
      writeFileLines(chat.filePath, lines);
      res.json({ ok: true, lineNumber, preview: truncate(messageText, 160) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/agents/:agentId/chats/:chatId/messages/:lineNumber", (req, res) => {
    try {
      const agentId = ensureAgentId(String(req.params.agentId));
      const chatId = ensureChatId(String(req.params.chatId));
      const lineNumber = Number.parseInt(String(req.params.lineNumber), 10);
      if (!Number.isFinite(lineNumber) || lineNumber < 1) {
        throw new Error("Invalid line number.");
      }
      const chat = findChatOrThrow(agentId, chatId);
      const lines = readFileLines(chat.filePath);
      const index = lineNumber - 1;
      if (index < 0 || index >= lines.length) {
        throw new Error("Line number out of range.");
      }
      lines.splice(index, 1);
      writeFileLines(chat.filePath, lines);
      res.json({ ok: true, deletedLineNumber: lineNumber });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.listen(args.port, args.host, () => {
    console.log(`Agent chat editor running at http://${args.host}:${args.port}`);
    console.log(`Reading state from: ${stateDir}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
