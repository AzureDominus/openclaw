import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  browserAct,
  browserConsoleMessages,
  browserScreenshotAction,
} from "../../browser/client-actions.js";
import { browserSnapshot, browserTabs, type BrowserTab } from "../../browser/client.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../../browser/constants.js";
import { resolveTargetIdFromTabs } from "../../browser/target-id.js";
import { loadConfig } from "../../config/config.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { imageResultFromFile, jsonResult } from "./common.js";

type BrowserProxyRequest = (opts: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}) => Promise<unknown>;

type SnapshotQuery = {
  format?: "ai" | "aria";
  targetId?: string;
  limit?: number;
  maxChars?: number;
  refs?: "aria" | "role";
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  frame?: string;
  labels?: boolean;
  mode?: "efficient";
};

function wrapBrowserExternalJson(params: {
  kind: "snapshot" | "console" | "tabs";
  payload: unknown;
  includeWarning?: boolean;
}): { wrappedText: string; safeDetails: Record<string, unknown> } {
  const extractedText = JSON.stringify(params.payload, null, 2);
  const wrappedText = wrapExternalContent(extractedText, {
    source: "browser",
    includeWarning: params.includeWarning ?? true,
  });
  return {
    wrappedText,
    safeDetails: {
      ok: true,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: params.kind,
        wrapped: true,
      },
    },
  };
}

function formatTabsToolResult(tabs: unknown[]): AgentToolResult<unknown> {
  const wrapped = wrapBrowserExternalJson({
    kind: "tabs",
    payload: { tabs },
    includeWarning: false,
  });
  const content: AgentToolResult<unknown>["content"] = [
    { type: "text", text: wrapped.wrappedText },
  ];
  return {
    content,
    details: { ...wrapped.safeDetails, tabCount: tabs.length },
  };
}

function formatConsoleToolResult(result: {
  targetId?: string;
  messages?: unknown[];
}): AgentToolResult<unknown> {
  const wrapped = wrapBrowserExternalJson({
    kind: "console",
    payload: result,
    includeWarning: false,
  });
  return {
    content: [{ type: "text" as const, text: wrapped.wrappedText }],
    details: {
      ...wrapped.safeDetails,
      targetId: typeof result.targetId === "string" ? result.targetId : undefined,
      messageCount: Array.isArray(result.messages) ? result.messages.length : undefined,
    },
  };
}

async function readTabs(params: {
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<BrowserTab[]> {
  const { baseUrl, profile, proxyRequest } = params;
  if (proxyRequest) {
    const result = await proxyRequest({
      method: "GET",
      path: "/tabs",
      profile,
    });
    const tabs = (result as { tabs?: BrowserTab[] }).tabs;
    return Array.isArray(tabs) ? tabs : [];
  }
  return await browserTabs(baseUrl, { profile });
}

function pickDefaultTab(tabs: BrowserTab[]): BrowserTab | undefined {
  const page = tabs.find((tab) => (tab.type ?? "page") === "page");
  return page ?? tabs.at(0);
}

export function resolveTabForTarget(params: {
  tabs: BrowserTab[];
  targetId?: string;
}): BrowserTab | undefined {
  const { tabs, targetId } = params;
  const requested = targetId?.trim();
  if (!requested) {
    return pickDefaultTab(tabs);
  }
  const resolved = resolveTargetIdFromTabs(requested, tabs);
  if (!resolved.ok) {
    throw new Error(
      resolved.reason === "ambiguous"
        ? `targetId is ambiguous: ${requested}`
        : `targetId not found: ${requested}`,
    );
  }
  return tabs.find((tab) => tab.targetId === resolved.targetId);
}

function buildSnapshotQuery(params: {
  input: Record<string, unknown>;
  useConfigEfficientDefault: boolean;
  defaultFormat?: "ai" | "aria";
  defaultRefs?: "aria" | "role";
}): SnapshotQuery {
  const snapshotDefaults = params.useConfigEfficientDefault
    ? loadConfig().browser?.snapshotDefaults
    : undefined;
  const format: "ai" | "aria" | undefined =
    params.input.snapshotFormat === "ai" || params.input.snapshotFormat === "aria"
      ? params.input.snapshotFormat
      : params.defaultFormat;
  const mode: "efficient" | undefined =
    params.input.mode === "efficient"
      ? "efficient"
      : format !== "aria" && snapshotDefaults?.mode === "efficient"
        ? "efficient"
        : undefined;
  const labels = typeof params.input.labels === "boolean" ? params.input.labels : undefined;
  const refs: "aria" | "role" | undefined =
    params.input.refs === "aria" || params.input.refs === "role"
      ? params.input.refs
      : params.defaultRefs;
  const hasMaxChars = Object.hasOwn(params.input, "maxChars");
  const targetId =
    typeof params.input.targetId === "string" ? params.input.targetId.trim() : undefined;
  const limit =
    typeof params.input.limit === "number" && Number.isFinite(params.input.limit)
      ? params.input.limit
      : undefined;
  const maxChars =
    typeof params.input.maxChars === "number" &&
    Number.isFinite(params.input.maxChars) &&
    params.input.maxChars > 0
      ? Math.floor(params.input.maxChars)
      : undefined;
  const interactive =
    typeof params.input.interactive === "boolean" ? params.input.interactive : undefined;
  const compact = typeof params.input.compact === "boolean" ? params.input.compact : undefined;
  const depth =
    typeof params.input.depth === "number" && Number.isFinite(params.input.depth)
      ? params.input.depth
      : undefined;
  const selector =
    typeof params.input.selector === "string" ? params.input.selector.trim() : undefined;
  const frame = typeof params.input.frame === "string" ? params.input.frame.trim() : undefined;
  const resolvedMaxChars =
    format === "ai"
      ? hasMaxChars
        ? maxChars
        : mode === "efficient"
          ? undefined
          : DEFAULT_AI_SNAPSHOT_MAX_CHARS
      : hasMaxChars
        ? maxChars
        : undefined;
  return {
    ...(format ? { format } : {}),
    targetId,
    limit,
    ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
    refs,
    interactive,
    compact,
    depth,
    selector,
    frame,
    labels,
    mode,
  };
}

async function fetchSnapshot(params: {
  snapshotQuery: SnapshotQuery;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}) {
  const { snapshotQuery, baseUrl, profile, proxyRequest } = params;
  return proxyRequest
    ? ((await proxyRequest({
        method: "GET",
        path: "/snapshot",
        profile,
        query: snapshotQuery,
      })) as Awaited<ReturnType<typeof browserSnapshot>>)
    : await browserSnapshot(baseUrl, {
        ...snapshotQuery,
        profile,
      });
}
function isChromeStaleTargetError(profile: string | undefined, err: unknown): boolean {
  if (profile !== "chrome-relay" && profile !== "chrome") {
    return false;
  }
  const msg = String(err);
  return msg.includes("404:") && msg.includes("tab not found");
}

function stripTargetIdFromActRequest(
  request: Parameters<typeof browserAct>[1],
): Parameters<typeof browserAct>[1] | null {
  const targetId = typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (!targetId) {
    return null;
  }
  const retryRequest = { ...request };
  delete retryRequest.targetId;
  return retryRequest as Parameters<typeof browserAct>[1];
}

function canRetryChromeActWithoutTargetId(request: Parameters<typeof browserAct>[1]): boolean {
  const typedRequest = request as Partial<Record<"kind" | "action", unknown>>;
  const kind =
    typeof typedRequest.kind === "string"
      ? typedRequest.kind
      : typeof typedRequest.action === "string"
        ? typedRequest.action
        : "";
  return kind === "hover" || kind === "scrollIntoView" || kind === "wait";
}

export async function executeTabsAction(params: {
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const tabs = await readTabs(params);
  return formatTabsToolResult(tabs);
}

export async function executeSnapshotAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const wantsLabels = input.labels === true;
  const snapshot = await fetchSnapshot({
    snapshotQuery: buildSnapshotQuery({
      input,
      useConfigEfficientDefault: true,
    }),
    baseUrl,
    profile,
    proxyRequest,
  });
  if (snapshot.format === "ai") {
    const extractedText = snapshot.snapshot ?? "";
    const wrappedSnapshot = wrapExternalContent(extractedText, {
      source: "browser",
      includeWarning: true,
    });
    const safeDetails = {
      ok: true,
      format: snapshot.format,
      targetId: snapshot.targetId,
      url: snapshot.url,
      truncated: snapshot.truncated,
      stats: snapshot.stats,
      refs: snapshot.refs ? Object.keys(snapshot.refs).length : undefined,
      labels: snapshot.labels,
      labelsCount: snapshot.labelsCount,
      labelsSkipped: snapshot.labelsSkipped,
      imagePath: snapshot.imagePath,
      imageType: snapshot.imageType,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: "snapshot",
        format: "ai",
        wrapped: true,
      },
    };
    if (wantsLabels && snapshot.imagePath) {
      const imagePath = snapshot.imagePath;
      return await imageResultFromFile({
        label: "browser:snapshot",
        path: imagePath,
        extraText: wrappedSnapshot,
        details: { ...safeDetails, filePath: imagePath },
        includeMediaDirective: false,
        includeDetailsPath: false,
      });
    }
    return {
      content: [{ type: "text" as const, text: wrappedSnapshot }],
      details: safeDetails,
    };
  }
  {
    const wrapped = wrapBrowserExternalJson({
      kind: "snapshot",
      payload: snapshot,
    });
    return {
      content: [{ type: "text" as const, text: wrapped.wrappedText }],
      details: {
        ...wrapped.safeDetails,
        format: "aria",
        targetId: snapshot.targetId,
        url: snapshot.url,
        nodeCount: snapshot.nodes.length,
        externalContent: {
          untrusted: true,
          source: "browser",
          kind: "snapshot",
          format: "aria",
          wrapped: true,
        },
      },
    };
  }
}

export async function executeInspectAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const snapshot = await fetchSnapshot({
    snapshotQuery: buildSnapshotQuery({
      input,
      useConfigEfficientDefault: false,
      defaultFormat: "ai",
      defaultRefs: "aria",
    }),
    baseUrl,
    profile,
    proxyRequest,
  });
  const screenshot = proxyRequest
    ? ((await proxyRequest({
        method: "POST",
        path: "/screenshot",
        profile,
        body: {
          targetId: snapshot.targetId,
          fullPage: Boolean(input.fullPage),
          type: "jpeg",
        },
      })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
    : await browserScreenshotAction(baseUrl, {
        targetId: snapshot.targetId,
        fullPage: Boolean(input.fullPage),
        type: "jpeg",
        profile,
      });

  const text =
    snapshot.format === "ai"
      ? wrapExternalContent(snapshot.snapshot ?? "", {
          source: "browser",
          includeWarning: true,
        })
      : wrapBrowserExternalJson({
          kind: "snapshot",
          payload: snapshot,
        }).wrappedText;
  const { path: screenshotPath, ...screenshotDetails } = screenshot;
  return await imageResultFromFile({
    label: "browser:inspect",
    path: screenshotPath,
    extraText: text,
    details: {
      ok: true,
      action: "inspect",
      targetId: snapshot.targetId,
      url: snapshot.url,
      snapshot,
      screenshot: { ...screenshotDetails, path: screenshotPath },
      filePath: screenshotPath,
    },
    includeMediaDirective: false,
    includeDetailsPath: false,
  });
}

export async function executeConsoleAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const level = typeof input.level === "string" ? input.level.trim() : undefined;
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  if (proxyRequest) {
    const result = (await proxyRequest({
      method: "GET",
      path: "/console",
      profile,
      query: {
        level,
        targetId,
      },
    })) as { ok?: boolean; targetId?: string; messages?: unknown[] };
    return formatConsoleToolResult(result);
  }
  const result = await browserConsoleMessages(baseUrl, { level, targetId, profile });
  return formatConsoleToolResult(result);
}

export async function executeActAction(params: {
  request: Parameters<typeof browserAct>[1];
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { request, baseUrl, profile, proxyRequest } = params;
  try {
    const result = proxyRequest
      ? await proxyRequest({
          method: "POST",
          path: "/act",
          profile,
          body: request,
        })
      : await browserAct(baseUrl, request, {
          profile,
        });
    return jsonResult(result);
  } catch (err) {
    if (isChromeStaleTargetError(profile, err)) {
      const retryRequest = stripTargetIdFromActRequest(request);
      const tabs = proxyRequest
        ? ((
            (await proxyRequest({
              method: "GET",
              path: "/tabs",
              profile,
            })) as { tabs?: unknown[] }
          ).tabs ?? [])
        : await browserTabs(baseUrl, { profile }).catch(() => []);
      // Some Chrome relay targetIds can go stale between snapshots and actions.
      // Only retry safe read-only actions, and only when exactly one tab remains attached.
      if (retryRequest && canRetryChromeActWithoutTargetId(request) && tabs.length === 1) {
        try {
          const retryResult = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/act",
                profile,
                body: retryRequest,
              })
            : await browserAct(baseUrl, retryRequest, {
                profile,
              });
          return jsonResult(retryResult);
        } catch {
          // Fall through to explicit stale-target guidance.
        }
      }
      if (!tabs.length) {
        throw new Error(
          "No Chrome tabs are attached via the OpenClaw Browser Relay extension. Click the toolbar icon on the tab you want to control (badge ON), then retry.",
          { cause: err },
        );
      }
      throw new Error(
        `Chrome tab not found (stale targetId?). Run action=tabs profile="chrome-relay" and use one of the returned targetIds.`,
        { cause: err },
      );
    }
    throw err;
  }
}
