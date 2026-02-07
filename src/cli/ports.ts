import { execFileSync } from "node:child_process";
import { resolveLsofCommandSync } from "../infra/ports-lsof.js";
import { sleep } from "../utils.js";

export type PortProcess = { pid: number; command?: string };

export type ForceFreePortResult = {
  killed: PortProcess[];
  waitedMs: number;
  escalatedToSigkill: boolean;
};

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseLsofOutput(output: string): PortProcess[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const results: PortProcess[] = [];
  let current: Partial<PortProcess> = {};
  for (const line of lines) {
    if (line.startsWith("p")) {
      if (current.pid) {
        results.push(current as PortProcess);
      }
      current = { pid: Number.parseInt(line.slice(1), 10) };
    } else if (line.startsWith("c")) {
      current.command = line.slice(1);
    }
  }
  if (current.pid) {
    results.push(current as PortProcess);
  }
  return results;
}

function parseSsOutput(output: string): PortProcess[] {
  const results: PortProcess[] = [];
  const seen = new Set<number>();

  // Example:
  // LISTEN ... users:(("openclaw-gatewa",pid=2774698,fd=22))
  // LISTEN ... users:(("node",pid=42,fd=5),("chrome",pid=99,fd=10))
  const re = /\("([^"]+)",pid=(\d+),fd=\d+\)/g;
  for (const match of output.matchAll(re)) {
    const command = match[1];
    const pid = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      continue;
    }
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    results.push({ pid, command });
  }

  // If we couldn't capture process names, at least capture PIDs.
  if (results.length === 0) {
    const pidRe = /pid=(\d+)/g;
    for (const match of output.matchAll(pidRe)) {
      const pid = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        continue;
      }
      if (seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      results.push({ pid });
    }
  }

  return results;
}

function listPortListenersViaSs(port: number): PortProcess[] {
  try {
    const out = execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf-8" });
    return parseSsOutput(out);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    const status = (err as { status?: number }).status;
    if (code === "ENOENT") {
      throw err;
    }
    if (status === 1) {
      return [];
    } // some ss versions use exit 1 for no matches
    // If ss exists but doesn't support filtering syntax, fall back to lsof.
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function listPortListeners(port: number): PortProcess[] {
  // On Linux, prefer `ss` over `lsof`:
  // - `ss` is installed by default on most distros
  // - `lsof` can be present but unable to inspect /proc under tightened policies, making --force unreliable
  if (process.platform === "linux") {
    try {
      return listPortListenersViaSs(port);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") {
        // If ss exists but failed unexpectedly, keep going with lsof before giving up.
      } else {
        // ss missing, fall back to lsof.
      }
    }
  }

  try {
    const lsof = resolveLsofCommandSync();
    const out = execFileSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpFc"], {
      encoding: "utf-8",
    });
    return parseLsofOutput(out);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      throw new Error("No supported port-inspection tool found (need ss or lsof) for --force", {
        cause: err,
      });
    }
    if (status === 1) {
      return [];
    } // no listeners
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function forceFreePort(port: number): PortProcess[] {
  const listeners = listPortListeners(port);
  for (const proc of listeners) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
  return listeners;
}

function killPids(listeners: PortProcess[], signal: NodeJS.Signals) {
  for (const proc of listeners) {
    try {
      process.kill(proc.pid, signal);
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
}

export async function forceFreePortAndWait(
  port: number,
  opts: {
    /** Total wait budget across signals. */
    timeoutMs?: number;
    /** Poll interval for checking whether lsof reports listeners. */
    intervalMs?: number;
    /** How long to wait after SIGTERM before escalating to SIGKILL. */
    sigtermTimeoutMs?: number;
  } = {},
): Promise<ForceFreePortResult> {
  const timeoutMs = Math.max(opts.timeoutMs ?? 1500, 0);
  const intervalMs = Math.max(opts.intervalMs ?? 100, 1);
  const sigtermTimeoutMs = Math.min(Math.max(opts.sigtermTimeoutMs ?? 600, 0), timeoutMs);

  const killed = forceFreePort(port);
  if (killed.length === 0) {
    return { killed, waitedMs: 0, escalatedToSigkill: false };
  }

  let waitedMs = 0;
  const triesSigterm = intervalMs > 0 ? Math.ceil(sigtermTimeoutMs / intervalMs) : 0;
  for (let i = 0; i < triesSigterm; i++) {
    if (listPortListeners(port).length === 0) {
      return { killed, waitedMs, escalatedToSigkill: false };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  if (listPortListeners(port).length === 0) {
    return { killed, waitedMs, escalatedToSigkill: false };
  }

  const remaining = listPortListeners(port);
  killPids(remaining, "SIGKILL");

  const remainingBudget = Math.max(timeoutMs - waitedMs, 0);
  const triesSigkill = intervalMs > 0 ? Math.ceil(remainingBudget / intervalMs) : 0;
  for (let i = 0; i < triesSigkill; i++) {
    if (listPortListeners(port).length === 0) {
      return { killed, waitedMs, escalatedToSigkill: true };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  const still = listPortListeners(port);
  if (still.length === 0) {
    return { killed, waitedMs, escalatedToSigkill: true };
  }

  throw new Error(
    `port ${port} still has listeners after --force: ${still.map((p) => p.pid).join(", ")}`,
  );
}

function parsePsOutput(output: string): { pid: number; uid: number; commandLine: string }[] {
  const results: { pid: number; uid: number; commandLine: string }[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1] ?? "", 10);
    const uid = Number.parseInt(match[2] ?? "", 10);
    const commandLine = (match[3] ?? "").trim();
    if (!Number.isFinite(pid) || pid <= 0) {
      continue;
    }
    if (!Number.isFinite(uid) || uid < 0) {
      continue;
    }
    results.push({ pid, uid, commandLine });
  }
  return results;
}

function listUserProcessesByCommandPrefix(prefix: string): PortProcess[] {
  if (process.platform === "win32") {
    return [];
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid == null) {
    return [];
  }
  const out = execFileSync("ps", ["-ax", "-o", "pid=,uid=,command="], { encoding: "utf-8" });
  const entries = parsePsOutput(out);
  return entries
    .filter((entry) => entry.uid === uid && entry.pid !== process.pid)
    .filter((entry) => entry.commandLine.startsWith(prefix))
    .map((entry) => ({ pid: entry.pid, command: prefix }));
}

/**
 * Best-effort killer for stale gateway processes when port introspection (lsof/ss) is unavailable.
 * This is intentionally conservative: only matches command lines that start with `openclaw-gateway`.
 */
export async function forceKillOpenclawGatewayProcessesAndWait(
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    sigtermTimeoutMs?: number;
  } = {},
): Promise<ForceFreePortResult> {
  const timeoutMs = Math.max(opts.timeoutMs ?? 1500, 0);
  const intervalMs = Math.max(opts.intervalMs ?? 100, 1);
  const sigtermTimeoutMs = Math.min(Math.max(opts.sigtermTimeoutMs ?? 600, 0), timeoutMs);

  const killed = listUserProcessesByCommandPrefix("openclaw-gateway");
  if (killed.length === 0) {
    return { killed, waitedMs: 0, escalatedToSigkill: false };
  }

  killPids(killed, "SIGTERM");

  let waitedMs = 0;
  const triesSigterm = intervalMs > 0 ? Math.ceil(sigtermTimeoutMs / intervalMs) : 0;
  for (let i = 0; i < triesSigterm; i++) {
    const remaining = killed.filter((p) => isAlive(p.pid));
    if (remaining.length === 0) {
      return { killed, waitedMs, escalatedToSigkill: false };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  let remaining = killed.filter((p) => isAlive(p.pid));
  if (remaining.length === 0) {
    return { killed, waitedMs, escalatedToSigkill: false };
  }

  killPids(remaining, "SIGKILL");

  const remainingBudget = Math.max(timeoutMs - waitedMs, 0);
  const triesSigkill = intervalMs > 0 ? Math.ceil(remainingBudget / intervalMs) : 0;
  for (let i = 0; i < triesSigkill; i++) {
    remaining = killed.filter((p) => isAlive(p.pid));
    if (remaining.length === 0) {
      return { killed, waitedMs, escalatedToSigkill: true };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  remaining = killed.filter((p) => isAlive(p.pid));
  if (remaining.length === 0) {
    return { killed, waitedMs, escalatedToSigkill: true };
  }

  throw new Error(
    `stale openclaw-gateway processes still alive after --force: ${remaining.map((p) => p.pid).join(", ")}`,
  );
}
