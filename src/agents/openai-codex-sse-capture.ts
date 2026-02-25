import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

type CodexSseCaptureConfig = {
  enabled: boolean;
  filePath: string;
  maxResponseBytes: number;
  chunkPreviewBytes: number;
  framePreviewChars: number;
};

type CodexCaptureBase = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
};

type CodexCaptureEvent = CodexCaptureBase & {
  ts: string;
  stage:
    | "capture_start"
    | "request"
    | "response"
    | "response_chunk"
    | "sse_frame"
    | "capture_end"
    | "capture_error"
    | "capture_truncated";
  requestId?: string;
  url?: string;
  method?: string;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  durationMs?: number;
  bytes?: number;
  totalBytes?: number;
  chunkIndex?: number;
  frameIndex?: number;
  frameCharLength?: number;
  framePreview?: string;
  framePreviewTruncated?: boolean;
  frameUtf8HexPrefix?: string;
  containsPseudoToolCallMarker?: boolean;
  markerSnippet?: string;
  markerSnippetUtf8HexPrefix?: string;
  markerOffset?: number;
  dataFieldCount?: number;
  eventType?: string;
  nonAsciiChars?: number;
  hasReplacementChar?: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBodyBytes?: number;
  requestBodySha256?: string;
  requestBodyType?: string;
  error?: string;
};

type CaptureScope = {
  cfg: CodexSseCaptureConfig;
  writer: QueuedFileWriter;
  base: CodexCaptureBase;
};

const log = createSubsystemLogger("agent/codex-sse");
const writers = new Map<string, QueuedFileWriter>();
const captureScopeStorage = new AsyncLocalStorage<CaptureScope>();
const REDACTED = "<redacted>";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
]);
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_CHUNK_PREVIEW_BYTES = 2_048;
const DEFAULT_FRAME_PREVIEW_CHARS = 12_000;
const PSEUDO_TOOL_CALL_RE =
  /assistant\s+to=(?:functions\.[a-zA-Z0-9_]+|multi_tool_use\.parallel)\b/i;

let fetchPatched = false;

function parsePositiveInt(value: string | undefined, fallbackValue: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return parsed;
}

function resolveCaptureConfig(env: NodeJS.ProcessEnv): CodexSseCaptureConfig {
  const enabled = isTruthyEnvValue(env.OPENCLAW_CODEX_SSE_CAPTURE);
  const fileOverride = env.OPENCLAW_CODEX_SSE_CAPTURE_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "codex-sse.jsonl");
  return {
    enabled,
    filePath,
    maxResponseBytes: parsePositiveInt(
      env.OPENCLAW_CODEX_SSE_CAPTURE_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
    ),
    chunkPreviewBytes: parsePositiveInt(
      env.OPENCLAW_CODEX_SSE_CAPTURE_CHUNK_PREVIEW_BYTES,
      DEFAULT_CHUNK_PREVIEW_BYTES,
    ),
    framePreviewChars: parsePositiveInt(
      env.OPENCLAW_CODEX_SSE_CAPTURE_FRAME_PREVIEW_CHARS,
      DEFAULT_FRAME_PREVIEW_CHARS,
    ),
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  return safeJsonStringify(error) ?? "unknown error";
}

function countNonAsciiChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x7f) {
      count += 1;
    }
  }
  return count;
}

function utf8HexPrefix(text: string, maxBytes: number): string {
  if (!text) {
    return "";
  }
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("hex");
}

function truncateText(
  text: string,
  maxChars: number,
): { value: string; truncated: boolean; originalLength: number } {
  if (text.length <= maxChars) {
    return { value: text, truncated: false, originalLength: text.length };
  }
  return {
    value: text.slice(0, maxChars),
    truncated: true,
    originalLength: text.length,
  };
}

function findMarkerContext(
  text: string,
): { offset: number; snippet: string; snippetHex: string } | undefined {
  const match = PSEUDO_TOOL_CALL_RE.exec(text);
  if (!match || match.index == null) {
    return undefined;
  }
  const start = Math.max(0, match.index - 160);
  const end = Math.min(text.length, match.index + 260);
  const snippet = text.slice(start, end);
  return {
    offset: match.index,
    snippet,
    snippetHex: utf8HexPrefix(snippet, 256),
  };
}

function shouldRedactHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    record[name] = shouldRedactHeader(name) ? REDACTED : value;
  }
  return record;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method && init.method.trim().length > 0) {
    return init.method.trim().toUpperCase();
  }
  if (input instanceof Request && input.method.trim().length > 0) {
    return input.method.trim().toUpperCase();
  }
  return "GET";
}

function resolveRequestHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): Record<string, string> {
  const merged = new Headers();
  if (input instanceof Request) {
    for (const [name, value] of input.headers.entries()) {
      merged.set(name, value);
    }
  }
  if (init?.headers) {
    for (const [name, value] of new Headers(init.headers).entries()) {
      merged.set(name, value);
    }
  }
  return headersToRecord(merged);
}

function hashBuffer(buffer: Uint8Array): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function resolveRequestBodyDigest(init?: RequestInit): {
  bytes?: number;
  sha256?: string;
  type?: string;
} {
  const body = init?.body;
  if (!body) {
    return {};
  }
  if (typeof body === "string") {
    const bytes = Buffer.from(body, "utf8");
    return { bytes: bytes.length, sha256: hashBuffer(bytes), type: "string" };
  }
  if (body instanceof URLSearchParams) {
    const bytes = Buffer.from(body.toString(), "utf8");
    return { bytes: bytes.length, sha256: hashBuffer(bytes), type: "urlsearchparams" };
  }
  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body);
    return { bytes: bytes.byteLength, sha256: hashBuffer(bytes), type: "arraybuffer" };
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { bytes: bytes.byteLength, sha256: hashBuffer(bytes), type: "typedarray" };
  }
  return { type: typeof body };
}

function isCodexResponsesUrl(url: string): boolean {
  return /\/codex\/responses(?:[/?#]|$)/i.test(url);
}

function resolveSseFrame(buffer: string): { frame: string; rest: string } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || match.index == null) {
    return undefined;
  }
  const split = match.index;
  return {
    frame: buffer.slice(0, split),
    rest: buffer.slice(split + match[0].length),
  };
}

function parseSseData(frame: string): { dataFieldCount: number; eventType?: string } {
  const lines = frame.split(/\r?\n/);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) {
    return { dataFieldCount: 0 };
  }
  const data = dataLines
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return { dataFieldCount: dataLines.length };
  }
  try {
    const parsed = JSON.parse(data) as { type?: unknown };
    if (typeof parsed.type === "string" && parsed.type.trim().length > 0) {
      return { dataFieldCount: dataLines.length, eventType: parsed.type };
    }
  } catch {
    // Intentionally ignore parse failures; raw frame is still logged.
  }
  return { dataFieldCount: dataLines.length };
}

function record(scope: CaptureScope, event: Omit<CodexCaptureEvent, "ts">): void {
  const line = safeJsonStringify({
    ...scope.base,
    ts: new Date().toISOString(),
    ...event,
  } satisfies CodexCaptureEvent);
  if (!line) {
    return;
  }
  scope.writer.write(`${line}\n`);
}

async function captureResponseStream(params: {
  scope: CaptureScope;
  response: Response;
  requestId: string;
  url: string;
}): Promise<void> {
  const { scope, response, requestId, url } = params;
  if (!response.body) {
    record(scope, {
      stage: "capture_end",
      requestId,
      url,
      bytes: 0,
      totalBytes: 0,
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let chunkIndex = 0;
  let frameIndex = 0;
  let buffer = "";
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      chunkIndex += 1;
      totalBytes += value.byteLength;

      if (totalBytes > scope.cfg.maxResponseBytes) {
        truncated = true;
        record(scope, {
          stage: "capture_truncated",
          requestId,
          url,
          totalBytes,
          error: `response exceeded max capture bytes (${scope.cfg.maxResponseBytes})`,
        });
        try {
          await reader.cancel();
        } catch {
          // ignore cancel errors
        }
        break;
      }

      const previewBytes = value.subarray(
        0,
        Math.min(value.byteLength, scope.cfg.chunkPreviewBytes),
      );
      record(scope, {
        stage: "response_chunk",
        requestId,
        url,
        chunkIndex,
        bytes: value.byteLength,
        totalBytes,
        frameUtf8HexPrefix: Buffer.from(previewBytes).toString("hex"),
      });

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nextFrame = resolveSseFrame(buffer);
        if (!nextFrame) {
          break;
        }
        buffer = nextFrame.rest;
        frameIndex += 1;

        const frameText = nextFrame.frame;
        const truncatedFrame = truncateText(frameText, scope.cfg.framePreviewChars);
        const markerContext = findMarkerContext(frameText);
        const parsedData = parseSseData(frameText);

        record(scope, {
          stage: "sse_frame",
          requestId,
          url,
          frameIndex,
          frameCharLength: truncatedFrame.originalLength,
          framePreview: truncatedFrame.value,
          framePreviewTruncated: truncatedFrame.truncated,
          frameUtf8HexPrefix: utf8HexPrefix(frameText, scope.cfg.chunkPreviewBytes),
          containsPseudoToolCallMarker: Boolean(markerContext),
          markerSnippet: markerContext?.snippet,
          markerSnippetUtf8HexPrefix: markerContext?.snippetHex,
          markerOffset: markerContext?.offset,
          dataFieldCount: parsedData.dataFieldCount,
          eventType: parsedData.eventType,
          nonAsciiChars: countNonAsciiChars(frameText),
          hasReplacementChar: frameText.includes("\uFFFD"),
        });
      }
    }

    if (!truncated) {
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        frameIndex += 1;
        const truncatedFrame = truncateText(buffer, scope.cfg.framePreviewChars);
        const markerContext = findMarkerContext(buffer);
        const parsedData = parseSseData(buffer);
        record(scope, {
          stage: "sse_frame",
          requestId,
          url,
          frameIndex,
          frameCharLength: truncatedFrame.originalLength,
          framePreview: truncatedFrame.value,
          framePreviewTruncated: truncatedFrame.truncated,
          frameUtf8HexPrefix: utf8HexPrefix(buffer, scope.cfg.chunkPreviewBytes),
          containsPseudoToolCallMarker: Boolean(markerContext),
          markerSnippet: markerContext?.snippet,
          markerSnippetUtf8HexPrefix: markerContext?.snippetHex,
          markerOffset: markerContext?.offset,
          dataFieldCount: parsedData.dataFieldCount,
          eventType: parsedData.eventType,
          nonAsciiChars: countNonAsciiChars(buffer),
          hasReplacementChar: buffer.includes("\uFFFD"),
        });
      }

      record(scope, {
        stage: "capture_end",
        requestId,
        url,
        bytes: totalBytes,
        totalBytes,
      });
    }
  } catch (error) {
    record(scope, {
      stage: "capture_error",
      requestId,
      url,
      totalBytes,
      error: formatError(error),
    });
  }
}

function ensureFetchPatched(): void {
  if (fetchPatched) {
    return;
  }
  if (typeof globalThis.fetch !== "function") {
    return;
  }
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const scope = captureScopeStorage.getStore();
    if (!scope) {
      return originalFetch(input, init);
    }

    const requestId = crypto.randomUUID();
    const requestStartedAt = Date.now();
    const url = resolveRequestUrl(input);
    const method = resolveRequestMethod(input, init);
    const isCodexRequest = isCodexResponsesUrl(url);
    const requestHeaders = resolveRequestHeaders(input, init);
    const bodyInfo = resolveRequestBodyDigest(init);

    if (isCodexRequest) {
      record(scope, {
        stage: "request",
        requestId,
        url,
        method,
        requestHeaders,
        requestBodyBytes: bodyInfo.bytes,
        requestBodySha256: bodyInfo.sha256,
        requestBodyType: bodyInfo.type,
      });
    }

    try {
      const response = await originalFetch(input, init);

      if (isCodexRequest) {
        const responseHeaders = headersToRecord(response.headers);
        const contentType = response.headers.get("content-type");
        record(scope, {
          stage: "response",
          requestId,
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          contentType,
          responseHeaders,
          durationMs: Date.now() - requestStartedAt,
        });
        const clone = response.clone();
        void captureResponseStream({
          scope,
          requestId,
          url,
          response: clone,
        });
      }

      return response;
    } catch (error) {
      if (isCodexRequest) {
        record(scope, {
          stage: "capture_error",
          requestId,
          url,
          method,
          durationMs: Date.now() - requestStartedAt,
          error: formatError(error),
        });
      }
      throw error;
    }
  }) as typeof fetch;

  fetchPatched = true;
}

function isCodexResponsesModel(model: Model<Api> | undefined | null): boolean {
  return (model as { api?: unknown })?.api === "openai-codex-responses";
}

export type OpenAICodexSseCaptureLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

export function createOpenAICodexSseCapture(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
}): OpenAICodexSseCaptureLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolveCaptureConfig(env);
  if (!cfg.enabled) {
    return null;
  }
  ensureFetchPatched();

  const writer = getQueuedFileWriter(writers, cfg.filePath);
  const base: CodexCaptureBase = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };

  const wrapStreamFn: OpenAICodexSseCaptureLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      if (!isCodexResponsesModel(model)) {
        return streamFn(model, context, options);
      }
      const scope: CaptureScope = { cfg, writer, base };
      record(scope, {
        stage: "capture_start",
      });
      return captureScopeStorage.run(scope, () => streamFn(model, context, options));
    };
    return wrapped;
  };

  log.info("openai codex SSE capture enabled", {
    filePath: writer.filePath,
    runId: params.runId,
    maxResponseBytes: cfg.maxResponseBytes,
    chunkPreviewBytes: cfg.chunkPreviewBytes,
    framePreviewChars: cfg.framePreviewChars,
  });
  return { enabled: true, wrapStreamFn };
}
