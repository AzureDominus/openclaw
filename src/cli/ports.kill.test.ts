import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { forceKillOpenclawGatewayProcessesAndWait } from "./ports.js";

describe("forceKillOpenclawGatewayProcessesAndWait", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    originalKill = process.kill.bind(process);
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  it("kills matching openclaw-gateway processes", async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    (execFileSync as unknown as vi.Mock).mockReturnValue(
      [`2940013 ${uid} openclaw-gateway`, `999999 ${uid} bash -lc echo hi`, ""].join("\n"),
    );

    const alive = new Set<number>([2940013]);
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (alive.has(pid)) {
          return true as never;
        }
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        alive.delete(pid);
        return true as never;
      }
      return true as never;
    });
    // @ts-expect-error override for test
    process.kill = killMock;

    vi.useFakeTimers();
    const promise = forceKillOpenclawGatewayProcessesAndWait({
      timeoutMs: 500,
      intervalMs: 50,
      sigtermTimeoutMs: 200,
    });
    await vi.runAllTimersAsync();
    const res = await promise;
    vi.useRealTimers();

    expect(res.killed.map((p) => p.pid)).toEqual([2940013]);
    expect(res.escalatedToSigkill).toBe(false);
    expect(killMock).toHaveBeenCalledWith(2940013, "SIGTERM");
  });

  it("escalates to SIGKILL when SIGTERM doesn't stop the process", async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    (execFileSync as unknown as vi.Mock).mockReturnValue(
      [`2940013 ${uid} openclaw-gateway`, ""].join("\n"),
    );

    const alive = new Set<number>([2940013]);
    let sigtermCount = 0;
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (alive.has(pid)) {
          return true as never;
        }
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM") {
        sigtermCount += 1;
        // ignore SIGTERM
        return true as never;
      }
      if (signal === "SIGKILL") {
        alive.delete(pid);
        return true as never;
      }
      return true as never;
    });
    // @ts-expect-error override for test
    process.kill = killMock;

    vi.useFakeTimers();
    const promise = forceKillOpenclawGatewayProcessesAndWait({
      timeoutMs: 800,
      intervalMs: 100,
      sigtermTimeoutMs: 300,
    });
    await vi.runAllTimersAsync();
    const res = await promise;
    vi.useRealTimers();

    expect(sigtermCount).toBeGreaterThan(0);
    expect(killMock).toHaveBeenCalledWith(2940013, "SIGKILL");
    expect(res.escalatedToSigkill).toBe(true);
  });
});
