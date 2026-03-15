import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import repl from "node:repl";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";

type HostToWorkerMessage =
  | { type: "exec"; id: string; code: string }
  | { type: "tool_result"; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: "emit_result"; id: string; ok: boolean; error?: string }
  | { type: "reset" };

type WorkerToHostMessage =
  | { type: "exec_result"; id: string; ok: boolean; output?: string; error?: string }
  | { type: "tool_call"; id: string; execId: string; toolName: string; args?: unknown }
  | { type: "emit_image"; id: string; execId: string; data: string; mimeType: string };

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ExecState = {
  id: string;
  logs: string[];
  diagnostics: string[];
  rejectOnDiagnostic?: (error: Error) => void;
};

const input = new PassThrough();
const output = new PassThrough();
const replServer = repl.start({
  input,
  output,
  terminal: false,
  useGlobal: false,
  ignoreUndefined: true,
  prompt: "",
});
const pendingTool = new Map<string, PendingResolver>();
const pendingEmit = new Map<string, PendingResolver>();
const stdin = process.stdin;
let currentExec: ExecState | null = null;
let toolCounter = 0;
let emitCounter = 0;
const INTERNAL_TOOL_NAMES = new Set(["js_repl", "js_repl_reset"]);
const requireFromHere = createRequire(import.meta.url);

function pathExists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function listFallbackNodeModulesDirs(): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const add = (candidate?: string) => {
    if (!candidate) {
      return;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      return;
    }
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(trimmed);
    } catch {
      return;
    }
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
      return;
    }
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    results.push(resolved);
  };

  for (const raw of (process.env.OPENCLAW_JS_REPL_NODE_MODULE_DIRS ?? "").split(path.delimiter)) {
    add(raw);
  }

  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (path.basename(currentDir) === "node_modules") {
      add(currentDir);
    }
    add(path.join(currentDir, "node_modules"));
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  return results;
}

function ensureDirSymlink(target: string, linkPath: string) {
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(target, linkPath, symlinkType);
}

function materializePlaywrightCoreAlias(targetDir: string) {
  const packageJsonPath = requireFromHere.resolve("playwright-core/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const actualPackage = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
    exports?: {
      ".": {
        import?: string;
        require?: string;
        default?: string;
      };
    };
  };
  const importEntry =
    actualPackage.exports?.["."]?.import ?? actualPackage.exports?.["."]?.default ?? "./index.mjs";
  const requireEntry =
    actualPackage.exports?.["."]?.require ?? actualPackage.exports?.["."]?.default ?? "./index.js";
  const importHref = pathToFileURL(path.resolve(packageDir, importEntry)).href;
  const requirePath = path.resolve(packageDir, requireEntry);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "package.json"),
    JSON.stringify(
      {
        name: "playwright-core",
        version: actualPackage.version ?? "0.0.0",
        type: "module",
        main: "./index.js",
        exports: {
          ".": {
            import: "./index.mjs",
            require: "./index.js",
            default: "./index.js",
          },
          "./package.json": "./package.json",
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(targetDir, "index.mjs"),
    `import * as namespace from ${JSON.stringify(importHref)};\nexport * from ${JSON.stringify(importHref)};\nexport default namespace;\n`,
  );
  fs.writeFileSync(
    path.join(targetDir, "index.js"),
    `const namespace = require(${JSON.stringify(requirePath)});\nmodule.exports = namespace;\nmodule.exports.default = namespace;\n`,
  );
}

function mirrorFallbackPackages(params: {
  fallbackDir: string;
  workspaceNodeModules: string;
  replNodeModules: string;
}) {
  for (const entry of fs.readdirSync(params.fallbackDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.name.startsWith("@")) {
      const fallbackScopeDir = path.join(params.fallbackDir, entry.name);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const replScopeDir = path.join(params.replNodeModules, entry.name);
      const workspaceScopeDir = path.join(params.workspaceNodeModules, entry.name);
      fs.mkdirSync(replScopeDir, { recursive: true });
      for (const scopedEntry of fs.readdirSync(fallbackScopeDir, { withFileTypes: true })) {
        if (scopedEntry.name.startsWith(".")) {
          continue;
        }
        if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) {
          continue;
        }
        const linkPath = path.join(replScopeDir, scopedEntry.name);
        if (pathExists(linkPath) || pathExists(path.join(workspaceScopeDir, scopedEntry.name))) {
          continue;
        }
        ensureDirSymlink(path.join(fallbackScopeDir, scopedEntry.name), linkPath);
      }
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const linkPath = path.join(params.replNodeModules, entry.name);
    if (pathExists(linkPath) || pathExists(path.join(params.workspaceNodeModules, entry.name))) {
      continue;
    }
    if (entry.name === "playwright-core") {
      materializePlaywrightCoreAlias(linkPath);
      continue;
    }
    ensureDirSymlink(path.join(params.fallbackDir, entry.name), linkPath);
  }
}

function ensureBareImportFallbacks() {
  const workspaceNodeModules = path.join(process.cwd(), "node_modules");
  const fallbackDirs = listFallbackNodeModulesDirs().filter(
    (candidate) => path.resolve(candidate) !== path.resolve(workspaceNodeModules),
  );
  if (fallbackDirs.length === 0 || pathExists(workspaceNodeModules)) {
    return;
  }
  fs.mkdirSync(workspaceNodeModules, { recursive: true });
  for (const fallbackDir of fallbackDirs) {
    mirrorFallbackPackages({
      fallbackDir,
      workspaceNodeModules,
      replNodeModules: workspaceNodeModules,
    });
  }
}

ensureBareImportFallbacks();

function send(message: WorkerToHostMessage) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return inspect(value, {
    depth: 4,
    breakLength: 120,
    colors: false,
  });
}

function appendLog(args: unknown[]) {
  if (!currentExec) {
    return;
  }
  currentExec.logs.push(args.map((part) => describeValue(part)).join(" "));
}

output.setEncoding("utf8");
output.on("data", (chunk: string) => {
  const text = chunk.trim();
  if (!text || !currentExec) {
    return;
  }
  currentExec.diagnostics.push(text);
  currentExec.rejectOnDiagnostic?.(new Error(currentExec.diagnostics.join("\n")));
  currentExec.rejectOnDiagnostic = undefined;
});

const openclaw = {
  cwd: process.cwd(),
  homeDir: process.env.HOME ?? null,
  tmpDir: process.env.TMPDIR ?? process.env.TMP ?? process.cwd(),
  tool(toolName: string, args?: unknown) {
    if (!currentExec) {
      throw new Error("openclaw.tool is only available during js_repl execution");
    }
    if (typeof toolName !== "string" || !toolName.trim()) {
      throw new Error("openclaw.tool expects a non-empty tool name");
    }
    if (INTERNAL_TOOL_NAMES.has(toolName.trim())) {
      throw new Error("js_repl cannot invoke itself");
    }
    const id = `${currentExec.id}-tool-${toolCounter++}`;
    send({
      type: "tool_call",
      id,
      execId: currentExec.id,
      toolName: toolName.trim(),
      args,
    });
    return new Promise((resolve, reject) => {
      pendingTool.set(id, {
        resolve,
        reject,
      });
    });
  },
  async emitImage(imageLike: unknown) {
    if (!currentExec) {
      throw new Error("openclaw.emitImage is only available during js_repl execution");
    }
    const normalized = await normalizeImageLike(imageLike);
    const id = `${currentExec.id}-emit-${emitCounter++}`;
    send({
      type: "emit_image",
      id,
      execId: currentExec.id,
      data: normalized.data,
      mimeType: normalized.mimeType,
    });
    return await new Promise((resolve, reject) => {
      pendingEmit.set(id, {
        resolve,
        reject,
      });
    });
  },
  browser: {
    async sessionStatus() {
      const result = await openclaw.tool("browser", { action: "session_status" });
      return extractToolDetails(result);
    },
    async connect() {
      const status = await openclaw.browser.sessionStatus();
      const cdpUrl = typeof status?.cdpUrl === "string" ? status.cdpUrl.trim() : "";
      if (!cdpUrl) {
        throw new Error("browser session_status did not return cdpUrl");
      }
      const playwright = await import("playwright-core");
      const browser = await playwright.chromium.connectOverCDP(cdpUrl);
      const contexts = browser.contexts();
      const pages = contexts.flatMap((context) => context.pages());
      let page =
        pages.length === 1
          ? pages[0]
          : await findPageForTargetId(
              pages,
              typeof status?.targetId === "string" ? status.targetId : undefined,
            );
      if (!page && typeof status?.url === "string" && status.url) {
        page = pages.find((candidate) => candidate.url() === status.url);
      }
      if (!page) {
        throw new Error("Could not resolve the attached browser page after connectOverCDP");
      }
      return {
        playwright,
        browser,
        contexts,
        pages,
        page,
        targetId: status?.targetId,
        profile: status?.profile,
        cdpUrl,
      };
    },
  },
};

replServer.context.openclaw = openclaw;
replServer.context.globalThis = replServer.context;
replServer.context.global = replServer.context;
replServer.context.console = {
  log: (...args: unknown[]) => appendLog(args),
  info: (...args: unknown[]) => appendLog(args),
  warn: (...args: unknown[]) => appendLog(args),
  error: (...args: unknown[]) => appendLog(args),
};
replServer.context.Buffer = Buffer;
replServer.context.setTimeout = setTimeout;
replServer.context.clearTimeout = clearTimeout;
replServer.context.setInterval = setInterval;
replServer.context.clearInterval = clearInterval;

async function findPageForTargetId(
  pages: Array<Awaited<ReturnType<(typeof openclaw.browser)["connect"]>>["page"]>,
  targetId?: string,
) {
  const requested = targetId?.trim();
  if (!requested) {
    return undefined;
  }
  for (const page of pages) {
    try {
      const session = await page.context().newCDPSession(page);
      const result = (await session.send("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      await session.detach().catch(() => {});
      if (result?.targetInfo?.targetId === requested) {
        return page;
      }
    } catch {
      // Ignore stale pages while trying to resolve the attached target.
    }
  }
  return undefined;
}

function extractToolDetails(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const details = (result as { details?: unknown }).details;
  return details ?? result;
}

async function normalizeImageLike(imageLike: unknown): Promise<{ data: string; mimeType: string }> {
  const awaited = await imageLike;
  if (typeof awaited === "string") {
    return parseDataUrl(awaited);
  }
  if (!awaited || typeof awaited !== "object") {
    throw new Error("openclaw.emitImage expects a data URL, bytes object, or tool result");
  }
  if (ArrayBuffer.isView(awaited)) {
    return {
      data: Buffer.from(awaited.buffer, awaited.byteOffset, awaited.byteLength).toString("base64"),
      mimeType: "image/png",
    };
  }
  const maybeBytes = awaited as {
    bytes?: Uint8Array | ArrayBuffer | number[];
    mimeType?: unknown;
    data?: unknown;
    content?: unknown;
  };
  if (typeof maybeBytes.data === "string" && typeof maybeBytes.mimeType === "string") {
    return {
      data: maybeBytes.data,
      mimeType: maybeBytes.mimeType,
    };
  }
  if (maybeBytes.bytes) {
    const bytes =
      maybeBytes.bytes instanceof ArrayBuffer
        ? Buffer.from(maybeBytes.bytes)
        : Array.isArray(maybeBytes.bytes)
          ? Buffer.from(maybeBytes.bytes)
          : Buffer.from(maybeBytes.bytes);
    return {
      data: bytes.toString("base64"),
      mimeType: typeof maybeBytes.mimeType === "string" ? maybeBytes.mimeType : "image/png",
    };
  }
  if (Array.isArray((awaited as { content?: unknown }).content)) {
    return extractSingleImageFromToolResult(awaited as { content: unknown[] });
  }
  throw new Error("openclaw.emitImage received an unsupported value");
}

function parseDataUrl(value: string): { data: string; mimeType: string } {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) {
    throw new Error("openclaw.emitImage expected a base64 data URL");
  }
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function extractSingleImageFromToolResult(result: { content: unknown[] }): {
  data: string;
  mimeType: string;
} {
  const images = result.content.filter(
    (item): item is { type: "image"; data: string; mimeType: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "image" &&
      typeof (item as { data?: unknown }).data === "string" &&
      typeof (item as { mimeType?: unknown }).mimeType === "string",
  );
  const hasText = result.content.some(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string" &&
      (item as { text: string }).text.trim().length > 0,
  );
  if (hasText || images.length !== 1) {
    throw new Error("openclaw.emitImage only accepts a single-image tool result without text");
  }
  return {
    data: images[0].data,
    mimeType: images[0].mimeType,
  };
}

function composeOutput(result: unknown): string {
  const parts = currentExec?.logs.slice() ?? [];
  if (typeof result !== "undefined") {
    parts.push(describeValue(result));
  }
  return parts.join("\n").trim();
}

async function runExec(id: string, code: string) {
  if (currentExec) {
    send({
      type: "exec_result",
      id,
      ok: false,
      error: "js_repl is already executing another cell",
    });
    return;
  }
  currentExec = { id, logs: [], diagnostics: [] };
  try {
    const result = await Promise.race([
      new Promise<unknown>((resolve, reject) => {
        replServer.eval(code, replServer.context, "openclaw:js_repl", (error, value) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(value);
        });
      }),
      new Promise<unknown>((_, reject) => {
        if (!currentExec) {
          reject(new Error("js_repl exec context not found"));
          return;
        }
        currentExec.rejectOnDiagnostic = reject;
      }),
    ]);
    send({
      type: "exec_result",
      id,
      ok: true,
      output: composeOutput(result),
    });
  } catch (error) {
    send({
      type: "exec_result",
      id,
      ok: false,
      output: currentExec.logs.join("\n").trim(),
      error:
        currentExec.diagnostics.join("\n").trim() ||
        (error instanceof Error ? (error.stack ?? error.message) : String(error)),
    });
  } finally {
    if (currentExec) {
      currentExec.rejectOnDiagnostic = undefined;
    }
    currentExec = null;
  }
}

function handleMessage(message: HostToWorkerMessage) {
  if (message.type === "exec") {
    void runExec(message.id, message.code);
    return;
  }
  if (message.type === "reset") {
    process.exit(0);
    return;
  }
  if (message.type === "tool_result") {
    const pending = pendingTool.get(message.id);
    if (!pending) {
      return;
    }
    pendingTool.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.error || "tool call failed"));
    return;
  }
  const pending = pendingEmit.get(message.id);
  if (!pending) {
    return;
  }
  pendingEmit.delete(message.id);
  if (message.ok) {
    pending.resolve(undefined);
    return;
  }
  pending.reject(new Error(message.error || "emitImage failed"));
}

stdin.setEncoding("utf8");
let pending = "";
stdin.on("data", (chunk: string) => {
  pending += chunk;
  while (true) {
    const newline = pending.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) {
      continue;
    }
    handleMessage(JSON.parse(line) as HostToWorkerMessage);
  }
});
