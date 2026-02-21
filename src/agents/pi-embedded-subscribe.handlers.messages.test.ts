import { describe, expect, it, vi } from "vitest";
import {
  handleMessageEnd,
  handleMessageStart,
  handleMessageUpdate,
  isDeliveryMirrorAssistantMessage,
  resolveSilentReplyFallbackText,
} from "./pi-embedded-subscribe.handlers.messages.js";

describe("resolveSilentReplyFallbackText", () => {
  it("replaces NO_REPLY with latest messaging tool text when available", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: ["first", "final delivered text"],
      }),
    ).toBe("final delivered text");
  });

  it("keeps original text when response is not NO_REPLY", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "normal assistant reply",
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("normal assistant reply");
  });

  it("keeps NO_REPLY when there is no messaging tool text to mirror", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [],
      }),
    ).toBe("NO_REPLY");
  });
});

describe("isDeliveryMirrorAssistantMessage", () => {
  it("returns true for delivery-mirror transcript entries", () => {
    expect(
      isDeliveryMirrorAssistantMessage({
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
      } as never),
    ).toBe(true);
  });

  it("returns false for normal assistant model output", () => {
    expect(
      isDeliveryMirrorAssistantMessage({
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.2",
      } as never),
    ).toBe(false);
  });
});

describe("delivery-mirror event filtering", () => {
  const deliveryMirrorMessage = {
    role: "assistant",
    provider: "openclaw",
    model: "delivery-mirror",
    content: [{ type: "text", text: "example.png" }],
  } as never;

  it("ignores message_start from delivery-mirror", () => {
    const resetAssistantMessageState = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const ctx = {
      resetAssistantMessageState,
      state: { assistantTexts: [] },
      params: { onAssistantMessageStart },
    } as never;

    handleMessageStart(ctx, { message: deliveryMirrorMessage } as never);

    expect(resetAssistantMessageState).not.toHaveBeenCalled();
    expect(onAssistantMessageStart).not.toHaveBeenCalled();
  });

  it("ignores message_update from delivery-mirror", () => {
    const noteLastAssistant = vi.fn();
    const ctx = { noteLastAssistant } as never;

    handleMessageUpdate(ctx, {
      message: deliveryMirrorMessage,
      assistantMessageEvent: { type: "text_delta", delta: "example.png" },
    } as never);

    expect(noteLastAssistant).not.toHaveBeenCalled();
  });

  it("ignores message_end from delivery-mirror", () => {
    const noteLastAssistant = vi.fn();
    const ctx = { noteLastAssistant } as never;

    handleMessageEnd(ctx, { message: deliveryMirrorMessage } as never);

    expect(noteLastAssistant).not.toHaveBeenCalled();
  });
});
