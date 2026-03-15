import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { createJsReplResetTool, createJsReplTool } from "./js-repl-tool.js";

const usedSessionIds = new Set<string>();

function makeTextResult(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function createTestTools(params?: {
  sessionId?: string;
  workspaceDir?: string;
  extraTools?: AnyAgentTool[];
}) {
  const sessionId = params?.sessionId ?? "js-repl-test-session";
  usedSessionIds.add(sessionId);
  const workspaceDir = params?.workspaceDir ?? process.cwd();
  let tools: AnyAgentTool[] = [];
  const jsRepl = createJsReplTool({
    sessionId,
    workspaceDir,
    getTools: () => tools,
  });
  const jsReplReset = createJsReplResetTool({ sessionId });
  tools = [jsRepl, jsReplReset, ...(params?.extraTools ?? [])];
  return { tools, jsRepl, jsReplReset };
}

async function extractText(result: Awaited<ReturnType<NonNullable<AnyAgentTool["execute"]>>>) {
  const block = result?.content?.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return block?.type === "text" ? block.text : "";
}

describe("js_repl tool", () => {
  afterEach(async () => {
    for (const sessionId of usedSessionIds) {
      const jsReplReset = createJsReplResetTool({ sessionId });
      await jsReplReset.execute?.(`reset-${sessionId}`, {});
    }
    usedSessionIds.clear();
  });

  it("persists bindings across calls and resets cleanly", async () => {
    const { jsRepl, jsReplReset } = createTestTools({ sessionId: "persist-session" });

    const first = await jsRepl.execute?.("call-1", {
      code: "var counter = (counter ?? 0) + 1; counter",
      timeoutMs: 10_000,
    });
    expect(await extractText(first)).toContain("1");

    const second = await jsRepl.execute?.("call-2", {
      code: "counter += 1; counter",
      timeoutMs: 10_000,
    });
    expect(await extractText(second)).toContain("2");

    await jsReplReset.execute?.("call-3", {});

    const third = await jsRepl.execute?.("call-4", {
      code: "typeof counter",
      timeoutMs: 10_000,
    });
    expect(await extractText(third)).toContain("undefined");
  });

  it("supports nested openclaw.tool calls and browser session helpers", async () => {
    const adderTool: AnyAgentTool = {
      name: "adder",
      label: "Adder",
      description: "Add two numbers",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
      },
      execute: vi.fn(async (_id, args) => {
        const params = args as { a?: number; b?: number };
        return makeTextResult({ sum: (params.a ?? 0) + (params.b ?? 0) });
      }),
    };
    const browserTool: AnyAgentTool = {
      name: "browser",
      label: "Browser",
      description: "Browser status",
      parameters: { type: "object", properties: { action: { type: "string" } } },
      execute: vi.fn(async () =>
        makeTextResult({
          ok: true,
          profile: "openclaw",
          targetId: "tab-1",
          cdpUrl: "http://127.0.0.1:18792",
        }),
      ),
    };
    const { jsRepl, jsReplReset } = createTestTools({
      sessionId: "nested-session",
      extraTools: [adderTool, browserTool],
    });

    const result = await jsRepl.execute?.("call-1", {
      code: `
        const addResult = await openclaw.tool("adder", { a: 2, b: 3 });
        const status = await openclaw.browser.sessionStatus();
        ({ sum: addResult.details.sum, targetId: status.targetId, profile: status.profile });
      `,
      timeoutMs: 10_000,
    });

    const text = await extractText(result);
    expect(text).toContain("sum: 5");
    expect(text).toContain("targetId: 'tab-1'");
    expect(text).toContain("profile: 'openclaw'");

    await jsReplReset.execute?.("call-2", {});
  });

  it("emits images into the outer tool result", async () => {
    const { jsRepl, jsReplReset } = createTestTools({ sessionId: "image-session" });

    const result = await jsRepl.execute?.("call-1", {
      code: `
        await openclaw.emitImage({
          bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==", "base64"),
          mimeType: "image/png",
        });
        "done";
      `,
      timeoutMs: 10_000,
    });

    expect(await extractText(result)).toContain("done");
    expect(result?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          mimeType: "image/png",
        }),
      ]),
    );

    await jsReplReset.execute?.("call-2", {});
  });

  it("resolves playwright-core from a workspace without local node_modules and blocks recursive js_repl calls", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-js-repl-"));
    const { jsRepl, jsReplReset } = createTestTools({
      sessionId: "import-session",
      workspaceDir,
    });

    const importResult = await jsRepl.execute?.("call-1", {
      code: `
        const playwright = await import("playwright-core");
        typeof playwright.chromium.connectOverCDP;
      `,
      timeoutMs: 10_000,
    });
    expect(await extractText(importResult)).toContain("function");
    await expect(
      fs.lstat(path.join(workspaceDir, "node_modules", "playwright-core", "package.json")),
    ).resolves.toBeTruthy();

    await expect(
      jsRepl.execute?.("call-2", {
        code: 'await openclaw.tool("js_repl", { code: "1+1" })',
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/cannot invoke itself/i);

    await jsReplReset.execute?.("call-3", {});
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});
