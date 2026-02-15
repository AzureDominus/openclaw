import type { BrowserContext } from "playwright-core";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { appendCdpPath } from "./cdp.helpers.js";
import { getHeadersWithAuth, normalizeCdpWsUrl } from "./cdp.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";

const log = createSubsystemLogger("browser").child("chrome");

export type { BrowserExecutable } from "./chrome.executables.js";
export {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
export {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolveXdgRuntimeDir(): string | undefined {
  const current = process.env.XDG_RUNTIME_DIR?.trim();
  if (current) {
    return current;
  }
  if (typeof process.getuid !== "function") {
    return undefined;
  }
  const uid = process.getuid();
  if (!Number.isFinite(uid)) {
    return undefined;
  }
  const candidate = `/run/user/${uid}`;
  return exists(candidate) ? candidate : undefined;
}

function resolveDisplay(): string | undefined {
  const override = process.env.OPENCLAW_BROWSER_DISPLAY?.trim();
  if (override) {
    return override;
  }
  const current = process.env.DISPLAY?.trim();
  if (current) {
    return current;
  }

  // Best-effort for headful daemon environments: detect a local X11 socket.
  // Commonly this is created by Xvfb/Xorg. Example: /tmp/.X11-unix/X1 => DISPLAY=:1
  if (process.platform === "linux") {
    const dir = "/tmp/.X11-unix";
    if (!exists(dir)) {
      return undefined;
    }
    try {
      const entries = fs.readdirSync(dir);
      const nums: number[] = [];
      for (const entry of entries) {
        const m = /^X(\d+)$/.exec(entry);
        if (!m) {
          continue;
        }
        const n = Number.parseInt(m[1] ?? "", 10);
        if (Number.isFinite(n)) {
          nums.push(n);
        }
      }
      if (nums.includes(1)) {
        return ":1";
      }
      if (nums.length) {
        nums.sort((a, b) => a - b);
        return `:${nums[0]}`;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function buildBrowserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Reduce accidental sharing with the user's env.
    HOME: os.homedir(),
  };
  const display = resolveDisplay();
  if (display) {
    env.DISPLAY = display;
  }
  const xdg = resolveXdgRuntimeDir();
  if (xdg) {
    env.XDG_RUNTIME_DIR = xdg;
  }
  return env;
}

/**
 * Represents a running Chrome instance launched by OpenClaw.
 * Can be either spawn-based (proc defined) or playwright-based (pwContext defined).
 */
export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  /** Launcher type: "spawn" for child_process, "playwright" for persistent context */
  launcher: "spawn" | "playwright";
  /** Child process handle when launcher="spawn" */
  proc?: ChildProcessWithoutNullStreams;
  /** Playwright persistent context when launcher="playwright" */
  pwContext?: BrowserContext;
  /** Async stop function for graceful shutdown */
  stop?: () => Promise<void>;
};

function resolveBrowserExecutable(resolved: ResolvedBrowserConfig): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(resolved, process.platform);
}

export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

export async function isChromeReachable(cdpUrl: string, timeoutMs = 500): Promise<boolean> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

async function fetchChromeVersion(cdpUrl: string, timeoutMs = 500): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: getHeadersWithAuth(versionUrl),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as ChromeVersion;
    if (!data || typeof data !== "object") {
      return null;
    }
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = 500,
): Promise<string | null> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) {
    return null;
  }
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

async function canOpenWebSocket(wsUrl: string, timeoutMs = 800): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const headers = getHeadersWithAuth(wsUrl);
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: timeoutMs,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        resolve(false);
      },
      Math.max(50, timeoutMs + 25),
    );
    ws.once("open", () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = 500,
  handshakeTimeoutMs = 800,
): Promise<boolean> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  if (!wsUrl) {
    return false;
  }
  return await canOpenWebSocket(wsUrl, handshakeTimeoutMs);
}

export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
  );

  // Build args shared between spawn and playwright launches
  const buildArgs = (): string[] => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--password-store=basic",
    ];

    if (resolved.headless) {
      args.push("--headless=new");
      args.push("--disable-gpu");
    }
    if (resolved.noSandbox) {
      args.push("--no-sandbox");
      args.push("--disable-setuid-sandbox");
    }
    if (process.platform === "linux") {
      args.push("--disable-dev-shm-usage");
    }

    // Stealth: hide navigator.webdriver from automation detection (#80)
    args.push("--disable-blink-features=AutomationControlled");

    // Append user-configured extra arguments (e.g., stealth flags, window size)
    if (resolved.extraArgs.length > 0) {
      args.push(...resolved.extraArgs);
    }
    return args;
  };

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args = buildArgs();
    args.push(`--user-data-dir=${userDataDir}`);
    // Always open a blank tab to ensure a target exists.
    args.push("about:blank");

    return spawn(exe.path, args, {
      stdio: "pipe",
      env: buildBrowserEnv(),
    });
  };

  if (!resolved.headless) {
    const display = resolveDisplay();
    if (!display) {
      throw new Error(
        "Browser is configured headful (browser.headless=false) but no DISPLAY is available. " +
          "Set DISPLAY (or OPENCLAW_BROWSER_DISPLAY) to the X server used by your VNC session.",
      );
    }
  }

  const startedAt = Date.now();

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  // Then decorate (if needed) before the "real" run.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
      });
      log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
    }
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
  }

  // Try playwright-based launch first for better automation capabilities
  try {
    const result = await launchViaPlaywright(exe, userDataDir, profile, resolved, buildArgs());
    log.info(
      `🦞 openclaw browser started [playwright] (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${result.pid})`,
    );
    return { ...result, startedAt };
  } catch (err) {
    log.debug(`Playwright launch failed, falling back to spawn: ${String(err)}`);
  }

  // Fallback to spawn-based launch
  const proc = spawnOnce();
  // Wait for CDP to come up.
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl, 500)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!(await isChromeReachable(profile.cdpUrl, 500))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".`,
    );
  }

  const pid = proc.pid ?? -1;
  log.info(
    `🦞 openclaw browser started [spawn] (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
  );

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    launcher: "spawn",
    proc,
  };
}

/**
 * Launch browser using Playwright's persistent context for better automation.
 * This provides improved stealth and stability compared to raw spawn.
 */
async function launchViaPlaywright(
  exe: BrowserExecutable,
  userDataDir: string,
  profile: ResolvedBrowserProfile,
  resolved: ResolvedBrowserConfig,
  baseArgs: string[],
): Promise<Omit<RunningChrome, "startedAt">> {
  const { chromium } = await import("playwright-core");

  const pwContext = await chromium.launchPersistentContext(userDataDir, {
    executablePath: exe.path,
    args: baseArgs,
    headless: resolved.headless ?? false,
    env: buildBrowserEnv(),
    // Drop obvious automation leaks.
    // Note: we keep Playwright's --remote-debugging-pipe so Playwright can control the browser,
    // while ALSO passing --remote-debugging-port=... so OpenClaw can attach over CDP.
    ignoreDefaultArgs: ["--enable-automation"],
  });

  // Wait for CDP to become reachable
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl, 500)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!(await isChromeReachable(profile.cdpUrl, 500))) {
    await pwContext.close().catch(() => {});
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}" via Playwright.`,
    );
  }

  // Get PID from the browser process
  const browser = pwContext.browser();
  // Playwright doesn't expose PID directly; we'll extract it from the process if available
  // Use -1 as fallback since we can't reliably get it
  const pid = (browser as unknown as { _process?: { pid?: number } })?._process?.pid ?? -1;

  // Build an async stop function for graceful shutdown
  const stop = async () => {
    await pwContext.close().catch(() => {});
  };

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    launcher: "playwright",
    pwContext,
    stop,
  };
}

export async function stopOpenClawChrome(running: RunningChrome, timeoutMs = 2500) {
  // Handle playwright-based launch
  if (running.launcher === "playwright") {
    // Try graceful stop first
    if (running.stop) {
      try {
        await running.stop();
      } catch {
        // ignore
      }
    } else if (running.pwContext) {
      try {
        await running.pwContext.close();
      } catch {
        // ignore
      }
    }

    // Fallback: if CDP port is still reachable after timeout, we can't force-kill
    // since we don't have a process handle. Log a warning.
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), 200))) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // If still reachable, log warning - we don't have SIGKILL capability for playwright
    if (await isChromeReachable(cdpUrlForPort(running.cdpPort), 200)) {
      log.warn(
        `Playwright-launched browser for profile on port ${running.cdpPort} did not stop gracefully.`,
      );
    }
    return;
  }

  // Handle spawn-based launch
  const proc = running.proc;
  if (!proc || proc.killed) {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc.exitCode && proc.killed) {
      break;
    }
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), 200))) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
