import { loadConfig } from "../config/config.js";
import { isLoopbackHost } from "../gateway/net.js";
import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
import { getBridgeAuthForPort } from "./bridge-auth-registry.js";
import { resolveBrowserControlAuth } from "./control-auth.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "./control-service.js";
import { createBrowserRouteDispatcher } from "./routes/dispatcher.js";

type LoopbackBrowserAuthDeps = {
  loadConfig: typeof loadConfig;
  resolveBrowserControlAuth: typeof resolveBrowserControlAuth;
  getBridgeAuthForPort: typeof getBridgeAuthForPort;
};

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isLoopbackHttpUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function withLoopbackBrowserAuthImpl(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
  deps: LoopbackBrowserAuthDeps,
): RequestInit & { timeoutMs?: number } {
  const headers = new Headers(init?.headers ?? {});
  if (headers.has("authorization") || headers.has("x-openclaw-password")) {
    return { ...init, headers };
  }
  if (!isLoopbackHttpUrl(url)) {
    return { ...init, headers };
  }

  try {
    const cfg = deps.loadConfig();
    const auth = deps.resolveBrowserControlAuth(cfg);
    if (auth.token) {
      headers.set("Authorization", `Bearer ${auth.token}`);
      return { ...init, headers };
    }
    if (auth.password) {
      headers.set("x-openclaw-password", auth.password);
      return { ...init, headers };
    }
  } catch {
    // ignore config/auth lookup failures and continue without auth headers
  }

  // Sandbox bridge servers can run with per-process ephemeral auth on dynamic ports.
  // Fall back to the in-memory registry if config auth is not available.
  try {
    const parsed = new URL(url);
    const port =
      parsed.port && Number.parseInt(parsed.port, 10) > 0
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === "https:"
          ? 443
          : 80;
    const bridgeAuth = deps.getBridgeAuthForPort(port);
    if (bridgeAuth?.token) {
      headers.set("Authorization", `Bearer ${bridgeAuth.token}`);
    } else if (bridgeAuth?.password) {
      headers.set("x-openclaw-password", bridgeAuth.password);
    }
  } catch {
    // ignore
  }

  return { ...init, headers };
}

function withLoopbackBrowserAuth(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
): RequestInit & { timeoutMs?: number } {
  return withLoopbackBrowserAuthImpl(url, init, {
    loadConfig,
    resolveBrowserControlAuth,
    getBridgeAuthForPort,
  });
}

const CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "UND_ERR_SOCKET",
  "ERR_NETWORK",
  "ERR_SOCKET_CLOSED",
]);
const PLAYWRIGHT_UNAVAILABLE_MARKER = "playwright is not available in this gateway build";
const BROWSER_REQUEST_TIMEOUT_MARKER = "__openclaw_browser_request_timeout__";
const TRANSIENT_BROWSER_RETRY_ATTEMPTS = 3;
const TRANSIENT_BROWSER_RETRY_DELAY_MS = 200;
const REQUEST_TIMEOUT_SKEW_MS = 250;

type BrowserStatusError = Error & {
  browserStatusCode?: number;
};

function createBrowserStatusError(statusCode: number, message: string): BrowserStatusError {
  const err = new Error(message) as BrowserStatusError;
  err.browserStatusCode = statusCode;
  return err;
}

function getBrowserStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const value = (err as { browserStatusCode?: unknown }).browserStatusCode;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getNestedErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  return extractErrorCode((err as { cause?: unknown }).cause);
}

function isLikelyConnectivityMessage(msgLower: string): boolean {
  return (
    msgLower.includes("fetch failed") ||
    msgLower.includes("networkerror") ||
    msgLower.includes("socket hang up") ||
    msgLower.includes("connection refused") ||
    msgLower.includes("connect econnrefused") ||
    msgLower.includes("connect etimedout") ||
    msgLower.includes("econnrefused") ||
    msgLower.includes("econnreset") ||
    msgLower.includes("enotfound") ||
    msgLower.includes("eai_again")
  );
}

function isLikelyConnectivityError(err: unknown, msgLower: string): boolean {
  const code = extractErrorCode(err);
  if (code && CONNECTIVITY_ERROR_CODES.has(code.toUpperCase())) {
    return true;
  }
  const nestedCode = getNestedErrorCode(err);
  if (nestedCode && CONNECTIVITY_ERROR_CODES.has(nestedCode.toUpperCase())) {
    return true;
  }
  return isLikelyConnectivityMessage(msgLower);
}

function isLikelyRequestTimeout(params: {
  msgLower: string;
  timeoutMs: number;
  elapsedMs: number;
}) {
  if (params.msgLower.includes(BROWSER_REQUEST_TIMEOUT_MARKER)) {
    return true;
  }
  const hasTimeoutLanguage =
    params.msgLower.includes("timed out") ||
    params.msgLower.includes("timeout") ||
    params.msgLower.includes("aborterror") ||
    params.msgLower.includes("aborted");
  if (!hasTimeoutLanguage) {
    return false;
  }
  // Avoid mislabeling inner route/action timeouts as gateway transport outages.
  return params.elapsedMs + REQUEST_TIMEOUT_SKEW_MS >= params.timeoutMs;
}

function isRetryableBrowserStatusError(statusCode: number, msgLower: string): boolean {
  if (statusCode === 501 && msgLower.includes(PLAYWRIGHT_UNAVAILABLE_MARKER)) {
    return true;
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return true;
  }
  return statusCode >= 500 && isLikelyConnectivityMessage(msgLower);
}

function shouldRetryTransientBrowserFailure(params: {
  err: unknown;
  msgLower: string;
  timeoutMs: number;
  elapsedMs: number;
  statusCode?: number;
  callerAborted: boolean;
}): boolean {
  if (params.callerAborted) {
    return false;
  }
  if (params.msgLower.includes("browser control disabled")) {
    return false;
  }
  if (typeof params.statusCode === "number") {
    return isRetryableBrowserStatusError(params.statusCode, params.msgLower);
  }
  if (params.msgLower.includes(PLAYWRIGHT_UNAVAILABLE_MARKER)) {
    return true;
  }
  if (isLikelyConnectivityError(params.err, params.msgLower)) {
    return true;
  }
  if (
    isLikelyRequestTimeout({
      msgLower: params.msgLower,
      timeoutMs: params.timeoutMs,
      elapsedMs: params.elapsedMs,
    })
  ) {
    return true;
  }
  return false;
}

function enhanceBrowserFetchError(
  _url: string,
  err: unknown,
  params: { timeoutMs: number; elapsedMs: number; statusCode?: number },
): Error {
  const msg = formatErrorMessage(err).trim() || String(err).trim();
  const msgLower = msg.toLowerCase();
  const looksLikeTimeout = isLikelyRequestTimeout({
    msgLower,
    timeoutMs: params.timeoutMs,
    elapsedMs: params.elapsedMs,
  });
  const looksLikeConnectivity = isLikelyConnectivityError(err, msgLower);
  const retryableStatus =
    typeof params.statusCode === "number" &&
    isRetryableBrowserStatusError(params.statusCode, msgLower);
  const retryGuidance =
    "Do NOT retry the browser tool automatically. " +
    "Ask the user whether they want to try the browser step again or continue with an alternative approach.";

  if (looksLikeTimeout) {
    const elapsedMs = Math.max(1, Math.round(Math.min(params.elapsedMs, params.timeoutMs)));
    return new Error(
      `Browser tool is currently unavailable (timed out after ${elapsedMs}ms). ${retryGuidance}`,
    );
  }
  if (msgLower.includes("browser control disabled")) {
    return new Error(
      "Browser tool is disabled in this gateway configuration. " +
        "Ask the user whether they want to try again later or continue with an alternative approach.",
    );
  }
  if (msgLower.includes(PLAYWRIGHT_UNAVAILABLE_MARKER)) {
    return new Error(
      "Browser tool appears unavailable after gateway retries. " +
        "Ask the user whether they want to try the browser step again later or continue with an alternative approach.",
    );
  }
  if (looksLikeConnectivity || retryableStatus) {
    return new Error(`Browser tool is currently unavailable. ${retryGuidance} (${msg})`);
  }

  if (err instanceof Error) {
    return err;
  }
  return new Error(msg || "Browser tool request failed.");
}

async function fetchHttpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const upstreamSignal = init.signal;
  let upstreamAbortListener: (() => void) | undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      ctrl.abort(upstreamSignal.reason);
    } else {
      upstreamAbortListener = () => ctrl.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
    }
  }

  const t = setTimeout(() => ctrl.abort(new Error(BROWSER_REQUEST_TIMEOUT_MARKER)), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw createBrowserStatusError(res.status, text || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
    if (upstreamSignal && upstreamAbortListener) {
      upstreamSignal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}

export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  return await fetchBrowserJsonInternal(url, init, TRANSIENT_BROWSER_RETRY_ATTEMPTS);
}

async function fetchBrowserJsonInternal<T>(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
  transientRetriesRemaining: number,
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 5000;
  const startedAt = Date.now();
  try {
    if (isAbsoluteHttp(url)) {
      const httpInit = withLoopbackBrowserAuth(url, init);
      return await fetchHttpJson<T>(url, { ...httpInit, timeoutMs });
    }
    const started = await startBrowserControlServiceFromConfig();
    if (!started) {
      throw new Error("browser control disabled");
    }
    const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
    const parsed = new URL(url, "http://localhost");
    const query: Record<string, unknown> = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      query[key] = value;
    }
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep as string
      }
    }

    const abortCtrl = new AbortController();
    const upstreamSignal = init?.signal;
    let upstreamAbortListener: (() => void) | undefined;
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        abortCtrl.abort(upstreamSignal.reason);
      } else {
        upstreamAbortListener = () => abortCtrl.abort(upstreamSignal.reason);
        upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
      }
    }

    let abortListener: (() => void) | undefined;
    const abortPromise: Promise<never> = abortCtrl.signal.aborted
      ? Promise.reject(abortCtrl.signal.reason ?? new Error("aborted"))
      : new Promise((_, reject) => {
          abortListener = () => reject(abortCtrl.signal.reason ?? new Error("aborted"));
          abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
        });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(
        () => abortCtrl.abort(new Error(BROWSER_REQUEST_TIMEOUT_MARKER)),
        timeoutMs,
      );
    }

    const dispatchPromise = dispatcher.dispatch({
      method:
        init?.method?.toUpperCase() === "DELETE"
          ? "DELETE"
          : init?.method?.toUpperCase() === "POST"
            ? "POST"
            : "GET",
      path: parsed.pathname,
      query,
      body,
      signal: abortCtrl.signal,
    });

    const result = await Promise.race([dispatchPromise, abortPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
      if (abortListener) {
        abortCtrl.signal.removeEventListener("abort", abortListener);
      }
      if (upstreamSignal && upstreamAbortListener) {
        upstreamSignal.removeEventListener("abort", upstreamAbortListener);
      }
    });

    if (result.status >= 400) {
      const message =
        result.body && typeof result.body === "object" && "error" in result.body
          ? String((result.body as { error?: unknown }).error)
          : `HTTP ${result.status}`;
      throw createBrowserStatusError(result.status, message);
    }
    return result.body as T;
  } catch (err) {
    const msg = (formatErrorMessage(err).trim() || String(err).trim()).toLowerCase();
    const elapsedMs = Date.now() - startedAt;
    const statusCode = getBrowserStatusCode(err);
    const shouldRetry =
      transientRetriesRemaining > 0 &&
      shouldRetryTransientBrowserFailure({
        err,
        msgLower: msg,
        timeoutMs,
        elapsedMs,
        statusCode,
        callerAborted: init?.signal?.aborted === true,
      });
    if (shouldRetry) {
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_BROWSER_RETRY_DELAY_MS));
      return await fetchBrowserJsonInternal(url, init, transientRetriesRemaining - 1);
    }
    throw enhanceBrowserFetchError(url, err, { timeoutMs, elapsedMs, statusCode });
  }
}

export const __test = {
  withLoopbackBrowserAuth: withLoopbackBrowserAuthImpl,
};
