import { describe, expect, it, vi } from "vitest";
import type { BlockReplyContext, ReplyPayload } from "../types.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

describe("createBlockReplyPipeline", () => {
  it("retries transient block delivery errors", async () => {
    const onBlockReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network request for sendMessage failed"))
      .mockResolvedValueOnce(undefined);

    const pipeline = createBlockReplyPipeline({
      onBlockReply,
      timeoutMs: 1_000,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    pipeline.enqueue({ text: "chunk" });
    await pipeline.flush();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(false);
  });

  it("does not retry non-transient block delivery errors", async () => {
    const onBlockReply = vi.fn().mockRejectedValueOnce(new Error("400 bad request"));

    const pipeline = createBlockReplyPipeline({
      onBlockReply,
      timeoutMs: 1_000,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    pipeline.enqueue({ text: "chunk" });
    await pipeline.flush();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(pipeline.didStream()).toBe(false);
    expect(pipeline.isAborted()).toBe(false);
  });

  it("aborts on timeout and skips retries to preserve ordering", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const onBlockReply = vi.fn((_: ReplyPayload, context?: BlockReplyContext) => {
      return new Promise<void>((resolve) => {
        context?.abortSignal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        );
      });
    });

    const pipeline = createBlockReplyPipeline({
      onBlockReply,
      timeoutMs: 1,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    pipeline.enqueue({ text: "chunk" });
    const flushPromise = pipeline.flush();
    await vi.advanceTimersByTimeAsync(5);
    await flushPromise;

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(sawAbort).toBe(true);
    expect(pipeline.isAborted()).toBe(true);
    vi.useRealTimers();
  });
});
