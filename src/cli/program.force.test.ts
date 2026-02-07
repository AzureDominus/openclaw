import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import {
  forceFreePort,
  forceFreePortAndWait,
  listPortListeners,
  type PortProcess,
  parseLsofOutput,
} from "./ports.js";

const renderListeners = (
  command: string,
  entries: Array<{ pid: number; command: string }> = [{ pid: 42, command: "node" }],
): string => {
  if (command === "ss") {
    return `${entries
      .map(
        (entry) =>
          `LISTEN 0 511 127.0.0.1:18789 0.0.0.0:* users:(("${entry.command}",pid=${entry.pid},fd=22))`,
      )
      .join("\n")}\n`;
  }

  return `${entries.flatMap((entry) => [`p${entry.pid}`, `c${entry.command}`]).join("\n")}\n`;
};

describe("gateway --force helpers", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    originalKill = process.kill.bind(process);
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  it("parses lsof output into pid/command pairs", () => {
    const sample = ["p123", "cnode", "p456", "cpython", ""].join("\n");
    const parsed = parseLsofOutput(sample);
    expect(parsed).toEqual<PortProcess[]>([
      { pid: 123, command: "node" },
      { pid: 456, command: "python" },
    ]);
  });

  it("returns empty list when no listeners are present", () => {
    (execFileSync as unknown as Mock).mockReturnValue("");
    expect(listPortListeners(18789)).toEqual([]);
  });

  it("throws when port inspection tools missing", () => {
    (execFileSync as unknown as Mock).mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(() => listPortListeners(18789)).toThrow(/need ss or lsof/i);
  });

  it("kills each listener and returns metadata", () => {
    (execFileSync as unknown as Mock).mockImplementation((command: string) =>
      renderListeners(command, [
        { pid: 42, command: "node" },
        { pid: 99, command: "ssh" },
      ]),
    );
    const killMock = vi.fn();
    process.kill = killMock;

    const killed = forceFreePort(18789);

    expect(execFileSync).toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(99, "SIGTERM");
    expect(killed).toEqual<PortProcess[]>([
      { pid: 42, command: "node" },
      { pid: 99, command: "ssh" },
    ]);
  });

  it("retries until the port is free", async () => {
    vi.useFakeTimers();
    let call = 0;
    (execFileSync as unknown as Mock).mockImplementation((command: string) => {
      call += 1;
      if (call <= 2) {
        return renderListeners(command, [{ pid: 42, command: "node" }]);
      }
      return "";
    });

    const killMock = vi.fn();
    process.kill = killMock;

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 500,
      intervalMs: 100,
      sigtermTimeoutMs: 400,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(res.killed).toEqual<PortProcess[]>([{ pid: 42, command: "node" }]);
    expect(res.escalatedToSigkill).toBe(false);
    expect(res.waitedMs).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it("escalates to SIGKILL if SIGTERM doesn't free the port", async () => {
    vi.useFakeTimers();
    let call = 0;
    (execFileSync as unknown as Mock).mockImplementation((command: string) => {
      call += 1;
      if (call <= 6) {
        return renderListeners(command, [{ pid: 42, command: "node" }]);
      }
      return "";
    });

    const killMock = vi.fn();
    process.kill = killMock;

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 800,
      intervalMs: 100,
      sigtermTimeoutMs: 300,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(42, "SIGKILL");
    expect(res.escalatedToSigkill).toBe(true);

    vi.useRealTimers();
  });
});
