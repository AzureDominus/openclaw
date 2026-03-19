import crypto from "node:crypto";
import {
  browserPageErrors,
  browserRequests,
  browserTraceStart,
  browserTraceStop,
} from "../../browser/client-actions-observe.js";
import {
  browserCookies,
  browserCookiesClear,
  browserCookiesSet,
  browserSetDevice,
  browserSetGeolocation,
  browserSetHeaders,
  browserSetHttpCredentials,
  browserSetLocale,
  browserSetMedia,
  browserSetOffline,
  browserSetTimezone,
  browserStorageClear,
  browserStorageGet,
  browserStorageSet,
} from "../../browser/client-actions-state.js";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "../../browser/client-actions.js";
import {
  type BrowserTab,
  type BrowserStatus,
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserProfiles,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from "../../browser/client.js";
import { resolveBrowserConfig, resolveProfile } from "../../browser/config.js";
import { DEFAULT_UPLOAD_DIR, resolveExistingPathsWithinRoot } from "../../browser/paths.js";
import { getBrowserProfileCapabilities } from "../../browser/profile-capabilities.js";
import { applyBrowserProxyPaths, persistBrowserProxyFiles } from "../../browser/proxy-files.js";
import {
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "../../browser/session-tab-registry.js";
import { resolveTargetIdFromTabs } from "../../browser/target-id.js";
import { loadConfig } from "../../config/config.js";
import {
  executeActAction,
  executeConsoleAction,
  executeInspectAction,
  executeSnapshotAction,
  executeTabsAction,
} from "./browser-tool.actions.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import {
  clearBrowserSessionState,
  getBrowserSessionState,
  setBrowserSessionState,
  updateBrowserSessionTarget,
} from "./browser-tool.session-state.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import {
  listNodes,
  resolveNodeIdFromList,
  selectDefaultNodeFromList,
  type NodeListNode,
} from "./nodes-utils.js";

function readOptionalTargetAndTimeout(params: Record<string, unknown>) {
  const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? params.timeoutMs
      : undefined;
  return { targetId, timeoutMs };
}

function readTargetUrlParam(params: Record<string, unknown>) {
  return (
    readStringParam(params, "targetUrl") ??
    readStringParam(params, "url", { required: true, label: "targetUrl" })
  );
}

const LEGACY_BROWSER_ACT_REQUEST_KEYS = [
  "targetId",
  "ref",
  "doubleClick",
  "button",
  "modifiers",
  "text",
  "submit",
  "slowly",
  "key",
  "delayMs",
  "startRef",
  "endRef",
  "values",
  "fields",
  "width",
  "height",
  "timeMs",
  "textGone",
  "selector",
  "url",
  "loadState",
  "fn",
  "timeoutMs",
] as const;

function readActRequestParam(params: Record<string, unknown>) {
  const requestParam = params.request;
  if (requestParam && typeof requestParam === "object") {
    return requestParam as Parameters<typeof browserAct>[1];
  }

  const kind = readStringParam(params, "kind");
  if (!kind) {
    return undefined;
  }

  const request: Record<string, unknown> = { kind };
  for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
    if (!Object.hasOwn(params, key)) {
      continue;
    }
    request[key] = params[key];
  }
  return request as Parameters<typeof browserAct>[1];
}

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

type BrowserProxyRequest = (opts: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}) => Promise<unknown>;

const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;
const BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS = 5_000;

type BrowserNodeTarget = {
  nodeId: string;
  label?: string;
};

function isBrowserNode(node: NodeListNode) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

async function resolveBrowserNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
}): Promise<BrowserNodeTarget | null> {
  const cfg = loadConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && params.target !== "node" && !params.requestedNode) {
    return null;
  }
  if (params.target && params.target !== "node") {
    return null;
  }
  if (mode === "manual" && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  const nodes = await listNodes({});
  const browserNodes = nodes.filter((node) => node.connected && isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  const requested = params.requestedNode?.trim() || policy?.node?.trim();
  if (requested) {
    const nodeId = resolveNodeIdFromList(browserNodes, requested, false);
    const node = browserNodes.find((entry) => entry.nodeId === nodeId);
    return { nodeId, label: node?.displayName ?? node?.remoteIp ?? nodeId };
  }

  const selected = selectDefaultNodeFromList(browserNodes, {
    preferLocalMac: false,
    fallback: "none",
  });

  if (params.target === "node") {
    if (selected) {
      return {
        nodeId: selected.nodeId,
        label: selected.displayName ?? selected.remoteIp ?? selected.nodeId,
      };
    }
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }

  if (mode === "manual") {
    return null;
  }

  if (selected) {
    return {
      nodeId: selected.nodeId,
      label: selected.displayName ?? selected.remoteIp ?? selected.nodeId,
    };
  }
  return null;
}

async function callBrowserProxy(params: {
  nodeId: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserProxyResult> {
  const proxyTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
  const gatewayTimeoutMs = proxyTimeoutMs + BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS;
  const payload = await callGatewayTool<{ payloadJSON?: string; payload?: string }>(
    "node.invoke",
    { timeoutMs: gatewayTimeoutMs },
    {
      nodeId: params.nodeId,
      command: "browser.proxy",
      params: {
        method: params.method,
        path: params.path,
        query: params.query,
        body: params.body,
        timeoutMs: proxyTimeoutMs,
        profile: params.profile,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const parsed =
    payload?.payload ??
    (typeof payload?.payloadJSON === "string" && payload.payloadJSON
      ? (JSON.parse(payload.payloadJSON) as BrowserProxyResult)
      : null);
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new Error("browser proxy failed");
  }
  return parsed;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  return await persistBrowserProxyFiles(files);
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  applyBrowserProxyPaths(result, mapping);
}

function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
  const target = params.target ?? (normalizedSandbox ? "sandbox" : "host");

  if (target === "sandbox") {
    if (!normalizedSandbox) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedSandbox.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.openclaw/openclaw.json.",
    );
  }
  return undefined;
}

function shouldPreferHostForProfile(profileName: string | undefined) {
  if (!profileName) {
    return false;
  }
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profile = resolveProfile(resolved, profileName);
  if (!profile) {
    return false;
  }
  const capabilities = getBrowserProfileCapabilities(profile);
  return capabilities.requiresRelay || capabilities.usesChromeMcp;
}

function isHostOnlyProfileName(profileName: string | undefined) {
  return profileName === "user" || profileName === "chrome-relay";
}

function readOptionalBooleanParam(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  return typeof params[key] === "boolean" ? params[key] : undefined;
}

function readOptionalNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringRecordParam(
  params: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const raw = params[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const entries = Object.entries(raw)
    .filter(([, value]) => typeof value === "string")
    .map(([entryKey, value]) => [entryKey, value as string] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readTargetIdParam(
  params: Record<string, unknown>,
  fallbackTargetId?: string,
): string | undefined {
  const targetId = readStringParam(params, "targetId");
  return targetId ?? fallbackTargetId;
}

async function listTabsForContext(params: {
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<BrowserTab[]> {
  if (params.proxyRequest) {
    const result = await params.proxyRequest({
      method: "GET",
      path: "/tabs",
      profile: params.profile,
    });
    const tabs = (result as { tabs?: Array<Record<string, unknown>> }).tabs;
    return Array.isArray(tabs) ? (tabs as BrowserTab[]) : [];
  }
  return await browserTabs(params.baseUrl, { profile: params.profile });
}

function resolveTabFromList(params: {
  tabs: Array<{ targetId: string; title?: string; url?: string; type?: string }>;
  targetId?: string;
}) {
  const { tabs } = params;
  const requested = params.targetId?.trim();
  if (!requested) {
    const page = tabs.find((tab) => (tab.type ?? "page") === "page");
    return page ?? tabs.at(0);
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

function resolveEffectiveBrowserLocation(params: {
  target?: "sandbox" | "host" | "node";
  nodeTarget: BrowserNodeTarget | null;
  sandboxBridgeUrl?: string;
}) {
  if (params.nodeTarget) {
    return "node" as const;
  }
  if (params.target === "sandbox" || params.target === "host") {
    return params.target;
  }
  return params.sandboxBridgeUrl ? ("sandbox" as const) : ("host" as const);
}

export function createBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
  sessionId?: string;
}): AnyAgentTool {
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the browser via OpenClaw's browser control server (status/start/stop/profiles/session_attach/session_status/session_clear/tabs/inspect/open/snapshot/screenshot/actions).",
      "Browser choice: omit profile by default for the isolated OpenClaw-managed browser (`openclaw`).",
      'For the logged-in user browser on the local host, prefer profile="user". Use it only when existing logins/cookies matter and the user is present to click/approve any browser attach prompt.',
      'Use profile="chrome-relay" only for the Chrome extension / Browser Relay / toolbar-button attach-tab flow, or when the user explicitly asks for the extension relay.',
      'If the user mentions the Chrome extension / Browser Relay / toolbar button / “attach tab”, ALWAYS prefer profile="chrome-relay". Otherwise prefer profile="user" over the extension relay for user-browser work.',
      'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
      'User-browser flows need user interaction: profile="user" may require approving a browser attach prompt; profile="chrome-relay" needs the user to click the OpenClaw Browser Relay toolbar icon on the tab (badge ON). If user presence is unclear, ask first.',
      "For interactive work, attach once with action=session_attach, then prefer action=inspect for combined snapshot+screenshot context before acting.",
      "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc).",
      'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
      "Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
      `target selects browser location (sandbox|host|node). Default: ${targetDefault}.`,
      hostHint,
    ].join(" "),
    parameters: BrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const attachedSession =
        action === "session_clear"
          ? undefined
          : getBrowserSessionState({
              sessionId: opts?.sessionId,
              agentSessionKey: opts?.agentSessionKey,
            });
      const useAttachedDefaults = action !== "profiles" && action !== "session_clear";
      const requestedProfile = readStringParam(params, "profile");
      const requestedNodeParam = readStringParam(params, "node");
      const profile =
        requestedProfile ??
        (useAttachedDefaults && !requestedNodeParam ? attachedSession?.profile : undefined);
      const requestedNode =
        requestedNodeParam ??
        (useAttachedDefaults && !requestedProfile && attachedSession?.location === "node"
          ? attachedSession.nodeId
          : undefined);
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;
      if (
        !target &&
        !requestedNodeParam &&
        !requestedProfile &&
        useAttachedDefaults &&
        attachedSession?.location
      ) {
        target = attachedSession.location;
      }

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
      }
      if (isHostOnlyProfileName(profile)) {
        if (requestedNode || target === "node") {
          throw new Error(`profile="${profile}" only supports the local host browser.`);
        }
        if (target === "sandbox") {
          throw new Error(
            `profile="${profile}" cannot use the sandbox browser; use target="host" or omit target.`,
          );
        }
      }
      if (!target && !requestedNode && shouldPreferHostForProfile(profile)) {
        // Local host user-browser profiles should not silently bind to sandbox/node browsers.
        target = "host";
      }

      const nodeTarget = await resolveBrowserNodeTarget({
        requestedNode: requestedNode ?? undefined,
        target,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
      });

      const resolvedTarget = target === "node" ? undefined : target;
      const baseUrl = nodeTarget
        ? undefined
        : resolveBrowserBaseUrl({
            target: resolvedTarget,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            allowHostControl: opts?.allowHostControl,
          });

      const proxyRequest = nodeTarget
        ? async (opts: {
            method: string;
            path: string;
            query?: Record<string, string | number | boolean | undefined>;
            body?: unknown;
            timeoutMs?: number;
            profile?: string;
          }) => {
            const proxy = await callBrowserProxy({
              nodeId: nodeTarget.nodeId,
              method: opts.method,
              path: opts.path,
              query: opts.query,
              body: opts.body,
              timeoutMs: opts.timeoutMs,
              profile: opts.profile,
            });
            const mapping = await persistProxyFiles(proxy.files);
            applyProxyPaths(proxy.result, mapping);
            return proxy.result;
          }
        : null;
      const effectiveLocation = resolveEffectiveBrowserLocation({
        target,
        nodeTarget,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
      });
      const defaultTargetId =
        useAttachedDefaults && effectiveLocation === attachedSession?.location
          ? attachedSession?.targetId
          : undefined;

      switch (action) {
        case "status":
          if (proxyRequest) {
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "start":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/start",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStart(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "stop":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/stop",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStop(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "profiles":
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/profiles",
            });
            return jsonResult(result);
          }
          return jsonResult({ profiles: await browserProfiles(baseUrl) });
        case "session_clear":
          return jsonResult({
            ok: true,
            cleared: clearBrowserSessionState({
              sessionId: opts?.sessionId,
              agentSessionKey: opts?.agentSessionKey,
            }),
          });
        case "session_attach":
        case "session_status": {
          const isChromeRelayProfile = profile === "chrome-relay" || profile === "chrome";
          const requestedTargetId =
            action === "session_attach"
              ? readStringParam(params, "targetId")
              : readTargetIdParam(params, defaultTargetId);
          let tabs = await listTabsForContext({
            baseUrl,
            profile,
            proxyRequest,
          });
          const status = proxyRequest
            ? ((await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              })) as BrowserStatus)
            : await browserStatus(baseUrl, { profile });
          if (action === "session_attach" && tabs.length === 0 && !isChromeRelayProfile) {
            const opened = proxyRequest
              ? ((await proxyRequest({
                  method: "POST",
                  path: "/tabs/open",
                  profile,
                  body: { url: "about:blank" },
                })) as Awaited<ReturnType<typeof browserOpenTab>>)
              : await browserOpenTab(baseUrl, "about:blank", { profile });
            tabs = [opened];
          }
          if (action === "session_attach" && isChromeRelayProfile && tabs.length === 0) {
            throw new Error(
              "No Chrome tabs are attached via the OpenClaw Browser Relay extension. Click the toolbar icon on the tab you want to control (badge ON), then retry.",
            );
          }
          const selectedTab = resolveTabFromList({
            tabs,
            targetId: requestedTargetId,
          });
          const resolvedProfile =
            typeof status.profile === "string" && status.profile.trim()
              ? status.profile.trim()
              : profile;
          const details = {
            ok: true,
            attached: action === "session_attach" ? true : Boolean(attachedSession),
            location: effectiveLocation,
            nodeId: nodeTarget?.nodeId,
            profile: resolvedProfile,
            targetId: selectedTab?.targetId,
            title: selectedTab?.title,
            url: selectedTab?.url,
            cdpUrl: status.cdpUrl,
            running: status.running,
            cdpReady: status.cdpReady,
          };
          if (action === "session_attach") {
            setBrowserSessionState({
              sessionId: opts?.sessionId,
              agentSessionKey: opts?.agentSessionKey,
              location: effectiveLocation,
              nodeId: nodeTarget?.nodeId,
              profile: resolvedProfile,
              targetId: selectedTab?.targetId,
            });
          }
          return jsonResult(details);
        }
        case "tabs":
          return await executeTabsAction({ baseUrl, profile, proxyRequest });
        case "inspect":
          return await executeInspectAction({
            input: {
              ...params,
              ...(params.targetId === undefined && defaultTargetId
                ? { targetId: defaultTargetId }
                : {}),
            },
            baseUrl,
            profile,
            proxyRequest,
          });
        case "open": {
          const targetUrl = readTargetUrlParam(params);
          if (proxyRequest) {
            const result = (await proxyRequest({
              method: "POST",
              path: "/tabs/open",
              profile,
              body: { url: targetUrl },
            })) as Awaited<ReturnType<typeof browserOpenTab>>;
            trackSessionBrowserTab({
              sessionKey: opts?.agentSessionKey,
              targetId: result.targetId,
              baseUrl,
              profile,
            });
            if (
              attachedSession &&
              attachedSession.location === effectiveLocation &&
              attachedSession.profile === profile
            ) {
              updateBrowserSessionTarget({
                sessionId: opts?.sessionId,
                agentSessionKey: opts?.agentSessionKey,
                targetId: result.targetId,
              });
            }
            return jsonResult(result);
          }
          const opened = await browserOpenTab(baseUrl, targetUrl, { profile });
          trackSessionBrowserTab({
            sessionKey: opts?.agentSessionKey,
            targetId: opened.targetId,
            baseUrl,
            profile,
          });
          if (
            attachedSession &&
            attachedSession.location === effectiveLocation &&
            attachedSession.profile === profile
          ) {
            updateBrowserSessionTarget({
              sessionId: opts?.sessionId,
              agentSessionKey: opts?.agentSessionKey,
              targetId: opened.targetId,
            });
          }
          return jsonResult(opened);
        }
        case "focus": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          if (!targetId) {
            throw new Error("targetId required");
          }
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/focus",
              profile,
              body: { targetId },
            });
            if (
              attachedSession &&
              attachedSession.location === effectiveLocation &&
              attachedSession.profile === profile
            ) {
              updateBrowserSessionTarget({
                sessionId: opts?.sessionId,
                agentSessionKey: opts?.agentSessionKey,
                targetId,
              });
            }
            return jsonResult(result);
          }
          await browserFocusTab(baseUrl, targetId, { profile });
          if (
            attachedSession &&
            attachedSession.location === effectiveLocation &&
            attachedSession.profile === profile
          ) {
            updateBrowserSessionTarget({
              sessionId: opts?.sessionId,
              agentSessionKey: opts?.agentSessionKey,
              targetId,
            });
          }
          return jsonResult({ ok: true });
        }
        case "close": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          if (proxyRequest) {
            const result = targetId
              ? await proxyRequest({
                  method: "DELETE",
                  path: `/tabs/${encodeURIComponent(targetId)}`,
                  profile,
                })
              : await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  body: { kind: "close" },
                });
            if (targetId) {
              untrackSessionBrowserTab({
                sessionKey: opts?.agentSessionKey,
                targetId,
                baseUrl,
                profile,
              });
              if (attachedSession?.targetId === targetId) {
                clearBrowserSessionState({
                  sessionId: opts?.sessionId,
                  agentSessionKey: opts?.agentSessionKey,
                });
              }
            }
            return jsonResult(result);
          }
          if (targetId) {
            await browserCloseTab(baseUrl, targetId, { profile });
            untrackSessionBrowserTab({
              sessionKey: opts?.agentSessionKey,
              targetId,
              baseUrl,
              profile,
            });
            if (attachedSession?.targetId === targetId) {
              clearBrowserSessionState({
                sessionId: opts?.sessionId,
                agentSessionKey: opts?.agentSessionKey,
              });
            }
          } else {
            await browserAct(baseUrl, { kind: "close" }, { profile });
          }
          return jsonResult({ ok: true });
        }
        case "snapshot":
          return await executeSnapshotAction({
            input: {
              ...params,
              ...(params.targetId === undefined && defaultTargetId
                ? { targetId: defaultTargetId }
                : {}),
            },
            baseUrl,
            profile,
            proxyRequest,
          });
        case "screenshot": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/screenshot",
                profile,
                body: {
                  targetId,
                  fullPage,
                  ref,
                  element,
                  type,
                },
              })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
            : await browserScreenshotAction(baseUrl, {
                targetId,
                fullPage,
                ref,
                element,
                type,
                profile,
              });
          const { path: filePath, ...rest } = result;
          return await imageResultFromFile({
            label: "browser:screenshot",
            path: filePath,
            extraText: `Screenshot saved to ${filePath}`,
            details: { ...rest, filePath },
            includeMediaDirective: false,
            includeDetailsPath: false,
          });
        }
        case "navigate": {
          const targetUrl = readTargetUrlParam(params);
          const targetId = readTargetIdParam(params, defaultTargetId);
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/navigate",
              profile,
              body: {
                url: targetUrl,
                targetId,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserNavigate(baseUrl, {
              url: targetUrl,
              targetId,
              profile,
            }),
          );
        }
        case "console":
          return await executeConsoleAction({
            input: {
              ...params,
              ...(params.targetId === undefined && defaultTargetId
                ? { targetId: defaultTargetId }
                : {}),
            },
            baseUrl,
            profile,
            proxyRequest,
          });
        case "errors": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const clear = readOptionalBooleanParam(params, "clear");
          const result = proxyRequest
            ? await proxyRequest({
                method: "GET",
                path: "/errors",
                profile,
                query: { targetId, clear },
              })
            : await browserPageErrors(baseUrl, { targetId, clear, profile });
          return jsonResult(result);
        }
        case "requests": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const filter = readStringParam(params, "filter");
          const clear = readOptionalBooleanParam(params, "clear");
          const result = proxyRequest
            ? await proxyRequest({
                method: "GET",
                path: "/requests",
                profile,
                query: { targetId, filter, clear },
              })
            : await browserRequests(baseUrl, { targetId, filter, clear, profile });
          return jsonResult(result);
        }
        case "trace_start": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const screenshots = readOptionalBooleanParam(params, "screenshots");
          const snapshots = readOptionalBooleanParam(params, "snapshots");
          const sources = readOptionalBooleanParam(params, "sources");
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/trace/start",
                profile,
                body: { targetId, screenshots, snapshots, sources },
              })
            : await browserTraceStart(baseUrl, {
                targetId,
                screenshots,
                snapshots,
                sources,
                profile,
              });
          return jsonResult(result);
        }
        case "trace_stop": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const path = readStringParam(params, "path");
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/trace/stop",
                profile,
                body: { targetId, path },
              })
            : await browserTraceStop(baseUrl, { targetId, path, profile });
          return jsonResult(result);
        }
        case "pdf": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/pdf",
                profile,
                body: { targetId },
              })) as Awaited<ReturnType<typeof browserPdfSave>>)
            : await browserPdfSave(baseUrl, { targetId, profile });
          return {
            content: [{ type: "text" as const, text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "cookies_get": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "GET",
                path: "/cookies",
                profile,
                query: { targetId },
              })
            : await browserCookies(baseUrl, { targetId, profile });
          return jsonResult(result);
        }
        case "cookies_set": {
          const cookie =
            params.cookie && typeof params.cookie === "object" && !Array.isArray(params.cookie)
              ? (params.cookie as Record<string, unknown>)
              : undefined;
          if (!cookie) {
            throw new Error("cookie required");
          }
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/cookies/set",
                profile,
                body: { targetId, cookie },
              })
            : await browserCookiesSet(baseUrl, { targetId, cookie, profile });
          return jsonResult(result);
        }
        case "cookies_clear": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/cookies/clear",
                profile,
                body: { targetId },
              })
            : await browserCookiesClear(baseUrl, { targetId, profile });
          return jsonResult(result);
        }
        case "storage_get": {
          const storageKind = readStringParam(params, "storageKind", {
            required: true,
            label: "storageKind",
          }) as "local" | "session";
          const targetId = readTargetIdParam(params, defaultTargetId);
          const key = readStringParam(params, "key");
          const result = proxyRequest
            ? await proxyRequest({
                method: "GET",
                path: `/storage/${storageKind}`,
                profile,
                query: { targetId, key },
              })
            : await browserStorageGet(baseUrl, {
                kind: storageKind,
                key,
                targetId,
                profile,
              });
          return jsonResult(result);
        }
        case "storage_set": {
          const storageKind = readStringParam(params, "storageKind", {
            required: true,
            label: "storageKind",
          }) as "local" | "session";
          const key = readStringParam(params, "key", {
            required: true,
            label: "key",
          });
          const value = readStringParam(params, "value", {
            required: true,
            allowEmpty: true,
          });
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: `/storage/${storageKind}/set`,
                profile,
                body: { targetId, key, value },
              })
            : await browserStorageSet(baseUrl, {
                kind: storageKind,
                key,
                value,
                targetId,
                profile,
              });
          return jsonResult(result);
        }
        case "storage_clear": {
          const storageKind = readStringParam(params, "storageKind", {
            required: true,
            label: "storageKind",
          }) as "local" | "session";
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: `/storage/${storageKind}/clear`,
                profile,
                body: { targetId },
              })
            : await browserStorageClear(baseUrl, { kind: storageKind, targetId, profile });
          return jsonResult(result);
        }
        case "set_offline": {
          const offline = readOptionalBooleanParam(params, "offline");
          if (offline === undefined) {
            throw new Error("offline required");
          }
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/set/offline",
                profile,
                body: { targetId, offline },
              })
            : await browserSetOffline(baseUrl, { targetId, offline, profile });
          return jsonResult(result);
        }
        case "set_headers": {
          const headers = readStringRecordParam(params, "headers");
          if (!headers) {
            throw new Error("headers required");
          }
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/set/headers",
                profile,
                body: { targetId, headers },
              })
            : await browserSetHeaders(baseUrl, { targetId, headers, profile });
          return jsonResult(result);
        }
        case "set_credentials": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const username = readStringParam(params, "username", { allowEmpty: true });
          const password = readStringParam(params, "password", { allowEmpty: true });
          const clear = readOptionalBooleanParam(params, "clear");
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/set/credentials",
                profile,
                body: { targetId, username, password, clear },
              })
            : await browserSetHttpCredentials(baseUrl, {
                targetId,
                username,
                password,
                clear,
                profile,
              });
          return jsonResult(result);
        }
        case "set_geolocation": {
          const targetId = readTargetIdParam(params, defaultTargetId);
          const latitude = readOptionalNumberParam(params, "latitude");
          const longitude = readOptionalNumberParam(params, "longitude");
          const accuracy = readOptionalNumberParam(params, "accuracy");
          const origin = readStringParam(params, "origin");
          const clear = readOptionalBooleanParam(params, "clear");
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/set/geolocation",
                profile,
                body: { targetId, latitude, longitude, accuracy, origin, clear },
              })
            : await browserSetGeolocation(baseUrl, {
                targetId,
                latitude,
                longitude,
                accuracy,
                origin,
                clear,
                profile,
              });
          return jsonResult(result);
        }
        case "set_media": {
          const colorScheme = readStringParam(params, "colorScheme", {
            required: true,
            label: "colorScheme",
          }) as "dark" | "light" | "no-preference" | "none";
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/set/media",
                profile,
                body: { targetId, colorScheme },
              })
            : await browserSetMedia(baseUrl, { targetId, colorScheme, profile });
          return jsonResult(result);
        }
        case "set_timezone": {
          const timezoneId = readStringParam(params, "timezoneId", {
            required: true,
            label: "timezoneId",
          });
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/set/timezone",
                profile,
                body: { targetId, timezoneId },
              })
            : await browserSetTimezone(baseUrl, { targetId, timezoneId, profile });
          return jsonResult(result);
        }
        case "set_locale": {
          const locale = readStringParam(params, "locale", {
            required: true,
          });
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/set/locale",
                profile,
                body: { targetId, locale },
              })
            : await browserSetLocale(baseUrl, { targetId, locale, profile });
          return jsonResult(result);
        }
        case "set_device": {
          const deviceName = readStringParam(params, "deviceName", {
            required: true,
            label: "deviceName",
          });
          const targetId = readTargetIdParam(params, defaultTargetId);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/set/device",
                profile,
                body: { targetId, name: deviceName },
              })
            : await browserSetDevice(baseUrl, { targetId, name: deviceName, profile });
          return jsonResult(result);
        }
        case "upload": {
          const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
          if (paths.length === 0) {
            throw new Error("paths required");
          }
          const uploadPathsResult = await resolveExistingPathsWithinRoot({
            rootDir: DEFAULT_UPLOAD_DIR,
            requestedPaths: paths,
            scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
          });
          if (!uploadPathsResult.ok) {
            throw new Error(uploadPathsResult.error);
          }
          const normalizedPaths = uploadPathsResult.paths;
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const { targetId: requestedTargetId, timeoutMs } = readOptionalTargetAndTimeout(params);
          const targetId = requestedTargetId ?? defaultTargetId;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/file-chooser",
              profile,
              body: {
                paths: normalizedPaths,
                ref,
                inputRef,
                element,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmFileChooser(baseUrl, {
              paths: normalizedPaths,
              ref,
              inputRef,
              element,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "dialog": {
          const accept = Boolean(params.accept);
          const promptText = typeof params.promptText === "string" ? params.promptText : undefined;
          const { targetId: requestedTargetId, timeoutMs } = readOptionalTargetAndTimeout(params);
          const targetId = requestedTargetId ?? defaultTargetId;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/dialog",
              profile,
              body: {
                accept,
                promptText,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmDialog(baseUrl, {
              accept,
              promptText,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "act": {
          const request = readActRequestParam(params);
          if (!request) {
            throw new Error("request required");
          }
          return await executeActAction({
            request:
              request.targetId || !defaultTargetId
                ? request
                : { ...request, targetId: defaultTargetId },
            baseUrl,
            profile,
            proxyRequest,
          });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
