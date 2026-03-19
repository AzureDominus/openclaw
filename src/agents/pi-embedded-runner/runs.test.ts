import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  queueEmbeddedPiMessage,
  setActiveEmbeddedRun,
  waitForActiveEmbeddedRuns,
} from "./runs.js";

describe("pi-embedded runner run registry", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs in compacting mode", () => {
    const abortCompacting = vi.fn();
    const abortNormal = vi.fn();

    setActiveEmbeddedRun("session-compacting", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => true,
      abort: abortCompacting,
    });

    setActiveEmbeddedRun("session-normal", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortNormal,
    });

    const aborted = abortEmbeddedPiRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortCompacting).toHaveBeenCalledTimes(1);
    expect(abortNormal).not.toHaveBeenCalled();
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => true,
      abort: abortA,
    });

    setActiveEmbeddedRun("session-b", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortB,
    });

    const aborted = abortEmbeddedPiRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("waits for active runs to drain", async () => {
    vi.useFakeTimers();
    try {
      const handle = {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      };
      setActiveEmbeddedRun("session-a", handle);
      setTimeout(() => {
        clearActiveEmbeddedRun("session-a", handle);
      }, 500);

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await waitPromise;

      expect(result.drained).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("returns drained=false when timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("session-a", {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      });

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await waitPromise;
      expect(result.drained).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("shares active run state across distinct module instances", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-b",
    );
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

    runsA.__testing.resetActiveEmbeddedRuns();
    runsB.__testing.resetActiveEmbeddedRuns();

    try {
      runsA.setActiveEmbeddedRun("session-shared", handle);
      expect(runsB.isEmbeddedPiRunActive("session-shared")).toBe(true);

      runsB.clearActiveEmbeddedRun("session-shared", handle);
      expect(runsA.isEmbeddedPiRunActive("session-shared")).toBe(false);
    } finally {
      runsA.__testing.resetActiveEmbeddedRuns();
      runsB.__testing.resetActiveEmbeddedRuns();
    }
  });
});

describe("queueEmbeddedPiMessage", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
  });

  it("queues steer text for active runs even when not streaming", async () => {
    const sessionId = "session-steer-nonstreaming";
    const queueMessage = vi.fn(async () => {});
    const handle = {
      queueMessage,
      isStreaming: () => false,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(sessionId, handle);
    try {
      const result = await queueEmbeddedPiMessage(sessionId, "actually wait pause");
      expect(result).toEqual({ status: "queued" });
      expect(queueMessage).toHaveBeenCalledWith("actually wait pause");
    } finally {
      clearActiveEmbeddedRun(sessionId, handle);
    }
  });

  it("returns no-active when no run is registered", async () => {
    const result = await queueEmbeddedPiMessage("missing-session", "pause");
    expect(result).toEqual({ status: "no-active" });
  });

  it("returns error when the queue operation fails", async () => {
    const sessionId = "session-steer-error";
    const handle = {
      queueMessage: vi.fn(async () => {
        throw new Error("inject failed");
      }),
      isStreaming: () => false,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(sessionId, handle);
    try {
      const result = await queueEmbeddedPiMessage(sessionId, "pause");
      expect(result).toEqual({ status: "error", error: "inject failed" });
    } finally {
      clearActiveEmbeddedRun(sessionId, handle);
    }
  });
});
