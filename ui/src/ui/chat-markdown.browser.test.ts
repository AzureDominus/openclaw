import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("chat markdown rendering", () => {
  it("shows raw tool call payload and raw output in tool sidebar", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const timestamp = Date.now();
    app.chatMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolcall", name: "exec", arguments: { command: "echo hi" } },
          { type: "toolresult", name: "exec", text: "Hello **world**" },
        ],
        timestamp,
      },
    ];

    await app.updateComplete;

    const toolCards = Array.from(app.querySelectorAll<HTMLElement>(".chat-tool-card"));
    const toolCard = toolCards.find((card) =>
      card.querySelector(".chat-tool-card__preview, .chat-tool-card__inline"),
    );
    expect(toolCard).not.toBeUndefined();
    toolCard?.click();

    await app.updateComplete;

    const sidebar = app.querySelector(".sidebar-markdown");
    const text = sidebar?.textContent ?? "";
    expect(text).toContain('"type": "tool_call"');
    expect(text).toContain('"name": "exec"');
    expect(text).toContain('"command": "echo hi"');
    expect(text).toContain("Hello **world**");
    expect(app.querySelector(".sidebar-markdown strong")).toBeNull();
  });
});
