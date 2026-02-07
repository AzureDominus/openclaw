import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { isPidAlive } from "../shared/pid-alive.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 1000;

type LockPayload = {
  pid: number;
  createdAt: string;
  configPath: string;
  startTime?: number;
};

export type GatewayLockHandle = {
  lockPath: string;
  configPath: string;
  release: () => Promise<void>;
};

export type GatewayLockOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
  allowInTests?: boolean;
  platform?: NodeJS.Platform;
  port?: number;
};

export class GatewayLockError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayLockError";
  }
}

type LockOwnerStatus = "alive" | "dead" | "unknown";

function normalizeProcArg(arg: string): string {
  return arg.replaceAll("\\", "/").toLowerCase();
}

function parseProcCmdline(raw: string): string[] {
  return raw
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isGatewayArgv(args: string[]): boolean {
  const normalized = args.map(normalizeProcArg);
  if (!normalized.includes("gateway")) {
    return false;
  }

  const entryCandidates = [
    "dist/index.js",
    "dist/entry.js",
    "openclaw.mjs",
    "scripts/run-node.mjs",
    "src/index.ts",
  ];
  if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)))) {
    return true;
  }

  const exe = normalized[0] ?? "";
  return exe.endsWith("/openclaw") || exe === "openclaw";
}

function readLinuxCmdline(pid: number): string[] | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return parseProcCmdline(raw);
  } catch {
    return null;
  }
}

function readLinuxStartTime(pid: number): number | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) {
      return null;
    }
    const rest = raw.slice(closeParen + 1).trim();
    const fields = rest.split(/\s+/);
    const startTime = Number.parseInt(fields[19] ?? "", 10);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

async function checkPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      // Conservative for liveness checks: timeout usually means no responsive
      // local listener, so treat the lock owner as stale.
      finish(true);
    }, DEFAULT_PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      finish(false);
    });
    socket.once("error", () => {
      finish(true);
    });
  });
}

async function resolveGatewayOwnerStatus(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
  port: number | undefined,
): Promise<LockOwnerStatus> {
  if (port != null) {
    const portFree = await checkPortFree(port);
    if (portFree) {
      return "dead";
    }
  }

  if (!isPidAlive(pid)) {
    return "dead";
  }
  if (platform !== "linux") {
    return "alive";
  }

  const payloadStartTime = payload?.startTime;
  if (Number.isFinite(payloadStartTime)) {
    const currentStartTime = readLinuxStartTime(pid);
    if (currentStartTime == null) {
      return "unknown";
    }
    return currentStartTime === payloadStartTime ? "alive" : "dead";
  }

  const args = readLinuxCmdline(pid);
  if (!args) {
    return "unknown";
  }
  return isGatewayArgv(args) ? "alive" : "dead";
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number") {
      return null;
    }
    if (typeof parsed.createdAt !== "string") {
      return null;
    }
    if (typeof parsed.configPath !== "string") {
      return null;
    }
    const startTime = typeof parsed.startTime === "number" ? parsed.startTime : undefined;
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      configPath: parsed.configPath,
      startTime,
    };
  } catch {
    return null;
  }
}

function resolveGatewayLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  const lockDir = resolveGatewayLockDir();
  const lockPath = path.join(lockDir, `gateway.${hash}.lock`);
  return { lockPath, configPath };
}

export type ForceReleaseGatewayLockResult = {
  lockPath: string;
  ownerPid?: number;
  removedLock: boolean;
  waitedMs: number;
  escalatedToSigkill: boolean;
};

export async function forceReleaseGatewayLockAndWait(
  opts: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    intervalMs?: number;
    sigtermTimeoutMs?: number;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ForceReleaseGatewayLockResult> {
  const env = opts.env ?? process.env;
  const timeoutMs = Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 0);
  const intervalMs = Math.max(opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS, 1);
  const sigtermTimeoutMs = Math.min(Math.max(opts.sigtermTimeoutMs ?? 600, 0), timeoutMs);
  const platform = opts.platform ?? process.platform;

  const { lockPath } = resolveGatewayLockPath(env);
  const payload = await readLockPayload(lockPath);
  const ownerPid = payload?.pid;
  if (!ownerPid) {
    const existed = payload !== null;
    if (existed) {
      await fs.rm(lockPath, { force: true });
    }
    return {
      lockPath,
      removedLock: existed,
      waitedMs: 0,
      escalatedToSigkill: false,
    };
  }

  const ownerStatus = resolveGatewayOwnerStatus(ownerPid, payload, platform);
  if (ownerStatus === "dead") {
    await fs.rm(lockPath, { force: true });
    return { lockPath, ownerPid, removedLock: true, waitedMs: 0, escalatedToSigkill: false };
  }
  // When we can't inspect /proc (common under tightened policies), we still want `--force`
  // to be able to clear a lock created by OpenClaw for this config.
  if (ownerStatus === "unknown") {
    // fall through to kill attempts below
  } else if (ownerStatus !== "alive") {
    return { lockPath, ownerPid, removedLock: false, waitedMs: 0, escalatedToSigkill: false };
  }
  if (ownerPid === process.pid) {
    return { lockPath, ownerPid, removedLock: false, waitedMs: 0, escalatedToSigkill: false };
  }

  try {
    process.kill(ownerPid, "SIGTERM");
  } catch (err) {
    throw new Error(`failed to SIGTERM gateway lock owner pid ${ownerPid}: ${String(err)}`, {
      cause: err,
    });
  }

  let waitedMs = 0;
  const triesSigterm = intervalMs > 0 ? Math.ceil(sigtermTimeoutMs / intervalMs) : 0;
  for (let i = 0; i < triesSigterm; i++) {
    if (!isAlive(ownerPid)) {
      await fs.rm(lockPath, { force: true });
      return { lockPath, ownerPid, removedLock: true, waitedMs, escalatedToSigkill: false };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    waitedMs += intervalMs;
  }

  if (!isAlive(ownerPid)) {
    await fs.rm(lockPath, { force: true });
    return { lockPath, ownerPid, removedLock: true, waitedMs, escalatedToSigkill: false };
  }

  try {
    process.kill(ownerPid, "SIGKILL");
  } catch (err) {
    throw new Error(`failed to SIGKILL gateway lock owner pid ${ownerPid}: ${String(err)}`, {
      cause: err,
    });
  }

  const remainingBudget = Math.max(timeoutMs - waitedMs, 0);
  const triesSigkill = intervalMs > 0 ? Math.ceil(remainingBudget / intervalMs) : 0;
  for (let i = 0; i < triesSigkill; i++) {
    if (!isAlive(ownerPid)) {
      await fs.rm(lockPath, { force: true });
      return { lockPath, ownerPid, removedLock: true, waitedMs, escalatedToSigkill: true };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    waitedMs += intervalMs;
  }

  if (!isAlive(ownerPid)) {
    await fs.rm(lockPath, { force: true });
    return { lockPath, ownerPid, removedLock: true, waitedMs, escalatedToSigkill: true };
  }

  throw new Error(
    `gateway lock owner pid ${ownerPid} still alive after force release (lock at ${lockPath})`,
  );
}

export async function acquireGatewayLock(
  opts: GatewayLockOptions = {},
): Promise<GatewayLockHandle | null> {
  const env = opts.env ?? process.env;
  const allowInTests = opts.allowInTests === true;
  if (
    env.OPENCLAW_ALLOW_MULTI_GATEWAY === "1" ||
    (!allowInTests && (env.VITEST || env.NODE_ENV === "test"))
  ) {
    return null;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const platform = opts.platform ?? process.platform;
  const port = opts.port;
  const { lockPath, configPath } = resolveGatewayLockPath(env);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  let lastPayload: LockPayload | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const startTime = platform === "linux" ? readLinuxStartTime(process.pid) : null;
      const payload: LockPayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath,
      };
      if (typeof startTime === "number" && Number.isFinite(startTime)) {
        payload.startTime = startTime;
      }
      await handle.writeFile(JSON.stringify(payload), "utf8");
      return {
        lockPath,
        configPath,
        release: async () => {
          await handle.close().catch(() => undefined);
          await fs.rm(lockPath, { force: true });
        },
      };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "EEXIST") {
        throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, err);
      }

      lastPayload = await readLockPayload(lockPath);
      const ownerPid = lastPayload?.pid;
      const ownerStatus = ownerPid
        ? await resolveGatewayOwnerStatus(ownerPid, lastPayload, platform, port)
        : "unknown";
      if (ownerStatus === "dead" && ownerPid) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (ownerStatus !== "alive") {
        let stale = false;
        if (lastPayload?.createdAt) {
          const createdAt = Date.parse(lastPayload.createdAt);
          stale = Number.isFinite(createdAt) ? Date.now() - createdAt > staleMs : false;
        }
        if (!stale) {
          try {
            const st = await fs.stat(lockPath);
            stale = Date.now() - st.mtimeMs > staleMs;
          } catch {
            // On Windows or locked filesystems we may be unable to stat the
            // lock file even though the existing gateway is still healthy.
            // Treat the lock as non-stale so we keep waiting instead of
            // forcefully removing another gateway's lock.
            stale = false;
          }
        }
        if (stale) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  const owner = lastPayload?.pid ? ` (pid ${lastPayload.pid})` : "";
  throw new GatewayLockError(`gateway already running${owner}; lock timeout after ${timeoutMs}ms`);
}
