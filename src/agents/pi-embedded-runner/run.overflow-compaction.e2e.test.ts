import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));

vi.mock("../pi-embedded-helpers.js", async () => {
  return {
    isCompactionFailureError: (msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    },
    isContextOverflowError: (msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") || lower.includes("request size exceeds");
    },
    isLikelyContextOverflowError: (msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return (
        lower.includes("request_too_large") ||
        lower.includes("request size exceeds") ||
        lower.includes("context window exceeded") ||
        lower.includes("prompt too large")
      );
    },
    isFailoverAssistantError: vi.fn(() => false),
    isFailoverErrorMessage: vi.fn(() => false),
    isAuthAssistantError: vi.fn(() => false),
    isRateLimitAssistantError: vi.fn(() => false),
    isBillingAssistantError: vi.fn(() => false),
    classifyFailoverReason: vi.fn(() => null),
    formatAssistantErrorText: vi.fn(() => ""),
    parseImageSizeError: vi.fn(() => null),
    pickFallbackThinkingLevel: vi.fn(() => null),
    isTimeoutErrorMessage: vi.fn(() => false),
    parseImageDimensionError: vi.fn(() => null),
  };
});

import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { log } from "./logger.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult, mockOverflowRetrySuccess } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import {
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSession,
} from "./tool-result-truncation.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedBuildEmbeddedRunPayloads = vi.mocked(buildEmbeddedRunPayloads);
const mockedCompactDirect = vi.mocked(compactEmbeddedPiSessionDirect);
const mockedSessionLikelyHasOversizedToolResults = vi.mocked(sessionLikelyHasOversizedToolResults);
const mockedTruncateOversizedToolResultsInSession = vi.mocked(
  truncateOversizedToolResultsInSession,
);

const baseParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
};

describe("overflow compaction in run loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRunEmbeddedAttempt.mockReset();
    mockedBuildEmbeddedRunPayloads.mockReset();
    mockedCompactDirect.mockReset();
    mockedSessionLikelyHasOversizedToolResults.mockReset();
    mockedTruncateOversizedToolResultsInSession.mockReset();
    mockedBuildEmbeddedRunPayloads.mockImplementation(() => []);
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized tool results",
    });
  });

  it("retries after successful compaction on context overflow promptError", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "test-profile" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "context overflow detected (attempt 1/3); attempting auto-compaction",
      ),
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("auto-compaction succeeded"));
    // Should not be an error result
    expect(result.meta.error).toBeUndefined();
  });

  it("retries after successful compaction on likely-overflow promptError variants", async () => {
    const overflowHintError = new Error("Context window exceeded: requested 12000 tokens");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowHintError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted session",
        firstKeptEntryId: "entry-6",
        tokensBefore: 140000,
      },
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("source=promptError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("returns error if compaction fails", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("auto-compaction failed"));
  });

  it("falls back to tool-result truncation and retries when oversized results are detected", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: overflowError,
          messagesSnapshot: [
            {
              role: "assistant",
              content: "big tool output",
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          ],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedSessionLikelyHasOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindowTokens: 200000 }),
    );
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Truncated 1 tool result(s)"));
    expect(result.meta.error).toBeUndefined();
  });

  it("retries compaction up to 3 times before giving up", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    // 4 overflow errors: 3 compaction retries + final failure
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { summary: "Compacted 1", firstKeptEntryId: "entry-3", tokensBefore: 180000 },
      })
      .mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { summary: "Compacted 2", firstKeptEntryId: "entry-5", tokensBefore: 160000 },
      })
      .mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { summary: "Compacted 3", firstKeptEntryId: "entry-7", tokensBefore: 140000 },
      });

    const result = await runEmbeddedPiAgent(baseParams);

    // Compaction attempted 3 times (max)
    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    // 4 attempts: 3 overflow+compact+retry cycles + final overflow → error
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("succeeds after second compaction attempt", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect
      .mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { summary: "Compacted 1", firstKeptEntryId: "entry-3", tokensBefore: 180000 },
      })
      .mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { summary: "Compacted 2", firstKeptEntryId: "entry-5", tokensBefore: 160000 },
      });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.error).toBeUndefined();
  });

  it("does not attempt compaction for compaction_failure errors", async () => {
    const compactionFailureError = new Error(
      "request_too_large: summarization failed - Request size exceeds model context window",
    );

    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ promptError: compactionFailureError }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("compaction_failure");
  });

  it("retries after successful compaction on assistant context overflow errors", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: {
            stopReason: "error",
            errorMessage: "request_too_large: Request size exceeds model context window",
          } as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      },
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("does not treat stale assistant overflow as current-attempt overflow when promptError is non-overflow", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("transport disconnected"),
        lastAssistant: {
          stopReason: "error",
          errorMessage: "request_too_large: Request size exceeds model context window",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow("transport disconnected");

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
  });

  it("returns an explicit timeout payload when the run times out before producing any reply", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: [],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("sets promptTokens from the latest model call usage, not accumulated attempt usage", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        attemptUsage: {
          input: 4_000,
          cacheRead: 120_000,
          cacheWrite: 0,
          total: 124_000,
        },
        lastAssistant: {
          stopReason: "end_turn",
          usage: {
            input: 900,
            cacheRead: 1_100,
            cacheWrite: 0,
            total: 2_000,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.meta.agentMeta?.usage?.input).toBe(4_000);
    expect(result.meta.agentMeta?.promptTokens).toBe(2_000);
  });

  it("retries with continue guard when end_turn has no tools and no valid stop reason", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking now."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Still checking."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Done.\nOPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt ?? "").toContain(
      "SYSTEM CONTINUE GUARD (1/3)",
    );
    expect(mockedRunEmbeddedAttempt.mock.calls[2]?.[0]?.prompt ?? "").toContain(
      "SYSTEM CONTINUE GUARD (2/3)",
    );
    expect(result.meta.stopReason).toBe("end_turn");
    expect(result.meta.stopReasonDetail).toBe("completed");
  });

  it("caps continue guard retries at three", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking step 1."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking step 2."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking step 3."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking step 4."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      );

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(mockedRunEmbeddedAttempt.mock.calls[3]?.[0]?.prompt ?? "").toContain(
      "SYSTEM CONTINUE GUARD (3/3)",
    );
  });

  it("uses configured continue guard retry cap from agents.defaults", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking step 1."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking step 2."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Done.\nOPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      config: {
        agents: {
          defaults: {
            continueGuardRetries: 1,
          },
        },
      },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt ?? "").toContain(
      "SYSTEM CONTINUE GUARD (1/1)",
    );
    expect(result.meta.stopReasonDetail).toBeUndefined();
  });

  it("allows per-agent continue guard retry override", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking step 1."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking step 2."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Done.\nOPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      config: {
        agents: {
          defaults: {
            continueGuardRetries: 1,
          },
          list: [{ id: "main", default: true, continueGuardRetries: 2 }],
        },
      },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt ?? "").toContain(
      "SYSTEM CONTINUE GUARD (1/2)",
    );
    expect(mockedRunEmbeddedAttempt.mock.calls[2]?.[0]?.prompt ?? "").toContain(
      "SYSTEM CONTINUE GUARD (2/2)",
    );
    expect(result.meta.stopReasonDetail).toBe("completed");
  });

  it("disables continue guard retries when configured to zero", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["Checking step 1."],
        lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
        toolMetas: [],
      }),
    );

    await runEmbeddedPiAgent({
      ...baseParams,
      config: {
        agents: {
          defaults: {
            continueGuardRetries: 0,
          },
        },
      },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("continue guard retry"));
  });

  it("retries with continue guard when assistant emits a plain-text pseudo tool call", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [
            'Working.\nassistant to=functions.exec\n{"command":"pwd","workdir":"/tmp"}',
          ],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Done.\nOPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt ?? "").toContain(
      "Do not write tool calls as plain text",
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("invalid plain-text tool call"));
    expect(result.meta.stopReasonDetail).toBe("completed");
  });

  it("retries with continue guard when tools were called earlier but final end_turn has no stop reason", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Working on it."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [{ toolName: "read" }],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["OPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt ?? "").toContain(
      "SYSTEM CONTINUE GUARD (1/3)",
    );
    expect(result.meta.stopReasonDetail).toBe("completed");
  });

  it("surfaces continue guard retries as chat payload notices for internal UI channel", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Checking now."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Done.\nOPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      messageChannel: INTERNAL_MESSAGE_CHANNEL,
    });

    expect(result.payloads?.[0]?.text).toContain("Continue guard 1/3");
    expect(
      result.payloads?.some((payload) => (payload.text ?? "").includes("OPENCLAW_STOP_REASON")),
    ).toBe(true);
  });

  it("filters marker-only partial callbacks during continue-guard retries and preserves prior reply when completion is marker-only", async () => {
    mockedBuildEmbeddedRunPayloads.mockImplementation((params) =>
      (params.assistantTexts ?? []).map((text) => ({ text })),
    );
    const onPartialReply = vi.fn();

    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (params) => {
        await params.onPartialReply?.({ text: "First answer." });
        return makeAttemptResult({
          assistantTexts: ["First answer."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        });
      })
      .mockImplementationOnce(async (params) => {
        await params.onPartialReply?.({ text: "OPENCLAW_STOP_REASON: completed" });
        return makeAttemptResult({
          assistantTexts: ["OPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        });
      });

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      onPartialReply,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.onPartialReply).toEqual(
      expect.any(Function),
    );
    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.text).toBe("First answer.");
    expect(result.meta.stopReasonDetail).toBe("completed");
  });

  it("keeps progress partial callbacks enabled during continue-guard retries", async () => {
    mockedBuildEmbeddedRunPayloads.mockImplementation((params) =>
      (params.assistantTexts ?? []).map((text) => ({ text })),
    );
    const onPartialReply = vi.fn();

    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (params) => {
        await params.onPartialReply?.({ text: "First answer." });
        return makeAttemptResult({
          assistantTexts: ["First answer."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        });
      })
      .mockImplementationOnce(async (params) => {
        await params.onPartialReply?.({ text: "Still working." });
        await params.onPartialReply?.({ text: "OPENCLAW_STOP_REASON: completed" });
        return makeAttemptResult({
          assistantTexts: ["OPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        });
      });

    await runEmbeddedPiAgent({
      ...baseParams,
      onPartialReply,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(onPartialReply).toHaveBeenCalledTimes(2);
    expect(onPartialReply).toHaveBeenNthCalledWith(1, { text: "First answer." });
    expect(onPartialReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "Still working." }),
    );
  });

  it("keeps block progress callbacks enabled during continue-guard retries when partial callbacks are unavailable", async () => {
    mockedBuildEmbeddedRunPayloads.mockImplementation((params) =>
      (params.assistantTexts ?? []).map((text) => ({ text })),
    );
    const onBlockReply = vi.fn();

    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (params) => {
        await params.onBlockReply?.({ text: "Initial progress." });
        return makeAttemptResult({
          assistantTexts: ["Initial progress."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        });
      })
      .mockImplementationOnce(async (params) => {
        await params.onBlockReply?.({ text: "Guard retry progress." });
        return makeAttemptResult({
          assistantTexts: ["OPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        });
      });

    await runEmbeddedPiAgent({
      ...baseParams,
      onBlockReply,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.onBlockReply).toEqual(expect.any(Function));
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenNthCalledWith(1, { text: "Initial progress." });
    expect(onBlockReply).toHaveBeenNthCalledWith(2, { text: "Guard retry progress." });
  });

  it("keeps block progress callbacks enabled during continue-guard retries when partial callback is internal-only", async () => {
    mockedBuildEmbeddedRunPayloads.mockImplementation((params) =>
      (params.assistantTexts ?? []).map((text) => ({ text })),
    );
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();

    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (params) => {
        await params.onBlockReply?.({ text: "Initial progress." });
        return makeAttemptResult({
          assistantTexts: ["Initial progress."],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        });
      })
      .mockImplementationOnce(async (params) => {
        await params.onBlockReply?.({ text: "Guard retry progress." });
        return makeAttemptResult({
          assistantTexts: ["OPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        });
      });

    await runEmbeddedPiAgent({
      ...baseParams,
      onBlockReply,
      onPartialReply,
      hasUserFacingPartialReply: false,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.onBlockReply).toEqual(expect.any(Function));
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenNthCalledWith(1, { text: "Initial progress." });
    expect(onBlockReply).toHaveBeenNthCalledWith(2, { text: "Guard retry progress." });
  });

  it("does not preserve malformed pseudo tool-call text as continue-guard fallback payload", async () => {
    mockedBuildEmbeddedRunPayloads.mockImplementation((params) =>
      (params.assistantTexts ?? []).map((text) => ({ text })),
    );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [
            'Progress update.\nassistant to=functions.exec\n{"command":"pwd","workdir":"/tmp"}',
          ],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["OPENCLAW_STOP_REASON: completed"],
          lastAssistant: { stopReason: "end_turn" } as EmbeddedRunAttemptResult["lastAssistant"],
          toolMetas: [],
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(
      result.payloads?.some((payload) => (payload.text ?? "").includes("assistant to=functions.")),
    ).toBe(false);
  });
});
