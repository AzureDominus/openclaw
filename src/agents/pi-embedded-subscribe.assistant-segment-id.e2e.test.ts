import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession assistant segment IDs", () => {
  it("threads the same assistant segment ID through partial and final text", () => {
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-123",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } as AssistantMessage });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "I found the routing path." },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I found the routing path." }],
      } as AssistantMessage,
    });

    expect(onPartialReply).toHaveBeenCalled();
    const partialPayload = onPartialReply.mock.calls[0]?.[0] as
      | { channelData?: { openclaw?: { assistantSegmentId?: string } } }
      | undefined;
    expect(partialPayload?.channelData?.openclaw?.assistantSegmentId).toBe("run-123:assistant:1");
    expect(subscription.assistantTextSegments).toEqual([
      { text: "I found the routing path.", segmentId: "run-123:assistant:1" },
    ]);
  });
});
