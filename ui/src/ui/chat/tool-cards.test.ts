import { describe, expect, it } from "vitest";
import { extractToolCards } from "./tool-cards.ts";

describe("tool-cards", () => {
  it("attaches matching call args to tool result cards by toolCallId", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        {
          type: "toolcall",
          id: "call-1",
          name: "exec",
          arguments: { command: "echo hi" },
        },
        {
          type: "toolresult",
          toolCallId: "call-1",
          name: "exec",
          text: "ok",
        },
      ],
    });

    const result = cards.find((card) => card.kind === "result");
    expect(result?.args).toEqual({ command: "echo hi" });
    expect(result?.text).toBe("ok");
  });

  it("serializes structured tool outputs when text is not provided", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        {
          type: "toolresult",
          name: "browser",
          result: { status: "ok", step: "snapshot" },
        },
      ],
    });

    const result = cards.find((card) => card.kind === "result");
    expect(result?.text).toContain('"status": "ok"');
    expect(result?.text).toContain('"step": "snapshot"');
  });
});
