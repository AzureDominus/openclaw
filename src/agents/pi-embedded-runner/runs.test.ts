import { describe, expect, it, vi } from "vitest";
import { clearActiveEmbeddedRun, queueEmbeddedPiMessage, setActiveEmbeddedRun } from "./runs.js";

describe("queueEmbeddedPiMessage", () => {
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
