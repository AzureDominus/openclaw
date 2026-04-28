import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import type { AnyAgentTool } from "./common.js";

type ExecResultMessage = {
  type: "exec_result";
  id: string;
  ok: boolean;
  output?: string;
  error?: string;
};

type ToolCallMessage = {
  type: "tool_call";
  id: string;
  execId: string;
  toolName: string;
  args?: unknown;
};

type EmitImageMessage = {
  type: "emit_image";
  id: string;
  execId: string;
  data: string;
  mimeType: string;
};

type WorkerMessage = ExecResultMessage | ToolCallMessage | EmitImageMessage;

type PendingExec = {
  resolve: (result: AgentToolResult<unknown>) => void;
  reject: (error: Error) => void;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
};

type JsReplSession = {
  proc: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  stderrTail: string[];
  pendingExecs: Map<string, PendingExec>;
};

const INTERNAL_TOOL_NAMES = new Set(["js_repl", "js_repl_reset"]);
const sessions = new Map<string, JsReplSession>();
const NESTED_TOOL_CONTEXT = {} as ExtensionContext;
const requireFromHere = createRequire(import.meta.url);

const JsReplSchema = Type.Object({
  code: Type.String(),
  timeoutMs: Type.Optional(Type.Number()),
});

const EmptySchema = Type.Object({});

function resolveScopeKey(params: { sessionId?: string; agentSessionKey?: string }): string {
  return params.sessionId?.trim() || params.agentSessionKey?.trim() || "default";
}

function resolveWorkerLaunch() {
  const jsPath = fileURLToPath(new URL("./js-repl-worker.js", import.meta.url));
  if (fs.existsSync(jsPath)) {
    return {
      command: process.execPath,
      args: [jsPath],
    };
  }
  const tsPath = fileURLToPath(new URL("./js-repl-worker.ts", import.meta.url));
  if (fs.existsSync(tsPath)) {
    const tsxLoaderPath = requireFromHere.resolve("tsx");
    return {
      command: process.execPath,
      args: ["--import", tsxLoaderPath, tsPath],
    };
  }
  throw new Error("js_repl worker entrypoint not found");
}

function sendToWorker(session: JsReplSession, message: unknown) {
  session.proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function composeResult(params: {
  output?: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}): AgentToolResult<unknown> {
  const text = params.output?.trim() || "js_repl completed";
  return {
    content: [{ type: "text", text }, ...params.images],
    details: {
      ok: true,
      output: params.output?.trim() || "",
      imageCount: params.images.length,
    },
  };
}

async function invokeNestedTool(params: {
  getTools: () => AnyAgentTool[];
  message: ToolCallMessage;
}): Promise<AgentToolResult<unknown>> {
  if (INTERNAL_TOOL_NAMES.has(params.message.toolName)) {
    throw new Error("js_repl cannot invoke itself");
  }
  const toolDefinitions = toToolDefinitions(
    params.getTools().filter((tool) => !INTERNAL_TOOL_NAMES.has(tool.name)),
  );
  const tool = toolDefinitions.find((candidate) => candidate.name === params.message.toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${params.message.toolName}`);
  }
  return await tool.execute(
    randomUUID(),
    params.message.args ?? {},
    undefined,
    undefined,
    NESTED_TOOL_CONTEXT,
  );
}

async function handleWorkerMessage(params: {
  session: JsReplSession;
  message: WorkerMessage;
  getTools: () => AnyAgentTool[];
}) {
  const { session, message, getTools } = params;
  if (message.type === "exec_result") {
    const pending = session.pendingExecs.get(message.id);
    if (!pending) {
      return;
    }
    session.pendingExecs.delete(message.id);
    if (!message.ok) {
      const output = message.output?.trim();
      const error = message.error?.trim() || "js_repl execution failed";
      pending.reject(new Error(output ? `${output}\n${error}` : error));
      return;
    }
    pending.resolve(
      await sanitizeToolResultImages(
        composeResult({
          output: message.output,
          images: pending.images,
        }),
        "js_repl",
      ),
    );
    return;
  }
  if (message.type === "emit_image") {
    const pending = session.pendingExecs.get(message.execId);
    if (!pending) {
      sendToWorker(session, {
        type: "emit_result",
        id: message.id,
        ok: false,
        error: "js_repl exec context not found",
      });
      return;
    }
    pending.images.push({
      type: "image",
      data: message.data,
      mimeType: message.mimeType,
    });
    sendToWorker(session, {
      type: "emit_result",
      id: message.id,
      ok: true,
    });
    return;
  }
  try {
    const result = await invokeNestedTool({
      getTools,
      message,
    });
    sendToWorker(session, {
      type: "tool_result",
      id: message.id,
      ok: true,
      result,
    });
  } catch (error) {
    sendToWorker(session, {
      type: "tool_result",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function createSession(params: {
  scopeKey: string;
  cwd?: string;
  getTools: () => AnyAgentTool[];
}): JsReplSession {
  const worker = resolveWorkerLaunch();
  const proc = spawn(worker.command, worker.args, {
    cwd: params.cwd,
    env: process.env,
    stdio: "pipe",
  });
  const rl = readline.createInterface({
    input: proc.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const session: JsReplSession = {
    proc,
    rl,
    stderrTail: [],
    pendingExecs: new Map(),
  };

  rl.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    void handleWorkerMessage({
      session,
      message: JSON.parse(line) as WorkerMessage,
      getTools: params.getTools,
    });
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    session.stderrTail.push(chunk.trim());
    while (session.stderrTail.length > 20) {
      session.stderrTail.shift();
    }
  });
  proc.once("exit", () => {
    sessions.delete(params.scopeKey);
    for (const pending of session.pendingExecs.values()) {
      pending.reject(new Error(session.stderrTail.join("\n") || "js_repl worker exited"));
    }
    session.pendingExecs.clear();
    rl.close();
  });
  sessions.set(params.scopeKey, session);
  return session;
}

function getOrCreateSession(params: {
  sessionId?: string;
  agentSessionKey?: string;
  cwd?: string;
  getTools: () => AnyAgentTool[];
}) {
  const scopeKey = resolveScopeKey(params);
  const existing = sessions.get(scopeKey);
  if (existing) {
    return { scopeKey, session: existing };
  }
  return {
    scopeKey,
    session: createSession({
      scopeKey,
      cwd: params.cwd,
      getTools: params.getTools,
    }),
  };
}

function resetSession(params: { sessionId?: string; agentSessionKey?: string }) {
  const scopeKey = resolveScopeKey(params);
  const session = sessions.get(scopeKey);
  if (!session) {
    return false;
  }
  sendToWorker(session, { type: "reset" });
  session.proc.kill();
  sessions.delete(scopeKey);
  return true;
}

export function createJsReplTool(opts: {
  sessionId?: string;
  agentSessionKey?: string;
  workspaceDir?: string;
  getTools: () => AnyAgentTool[];
}): AnyAgentTool {
  return {
    label: "JavaScript REPL",
    name: "js_repl",
    description:
      "Run persistent JavaScript in a session-scoped Node REPL with top-level await. Use openclaw.tool(...), openclaw.emitImage(...), and openclaw.browser.connect() for interactive browser work.",
    parameters: JsReplSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as { code?: unknown; timeoutMs?: unknown };
      const code = typeof params.code === "string" ? params.code : "";
      if (!code.trim()) {
        throw new Error("code required");
      }
      const timeoutMs =
        typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
          ? Math.max(1, Math.floor(params.timeoutMs))
          : 30_000;
      const { session } = getOrCreateSession({
        sessionId: opts.sessionId,
        agentSessionKey: opts.agentSessionKey,
        cwd: opts.workspaceDir,
        getTools: opts.getTools,
      });
      const execId = randomUUID();
      const resultPromise = new Promise<AgentToolResult<unknown>>((resolve, reject) => {
        session.pendingExecs.set(execId, {
          resolve,
          reject,
          images: [],
        });
      });
      sendToWorker(session, {
        type: "exec",
        id: execId,
        code,
      });
      const timeout = new Promise<AgentToolResult<unknown>>((_, reject) => {
        const timer = setTimeout(() => {
          session.pendingExecs.delete(execId);
          reject(new Error(`js_repl timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        resultPromise.finally(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
      });
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            session.pendingExecs.delete(execId);
            resetSession({
              sessionId: opts.sessionId,
              agentSessionKey: opts.agentSessionKey,
            });
          },
          { once: true },
        );
      }
      return await Promise.race([resultPromise, timeout]);
    },
  };
}

export function createJsReplResetTool(opts: {
  sessionId?: string;
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Reset JavaScript REPL",
    name: "js_repl_reset",
    description: "Destroy the current session-scoped js_repl worker and clear its state.",
    parameters: EmptySchema,
    execute: async () => {
      const payload = {
        ok: true,
        reset: resetSession({
          sessionId: opts.sessionId,
          agentSessionKey: opts.agentSessionKey,
        }),
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
        details: payload,
      };
    },
  };
}
