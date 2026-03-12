import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
});

describe("heartbeat transcript pruning", () => {
  async function createTranscriptWithContent(transcriptPath: string, sessionId: string) {
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const existingContent = `${JSON.stringify(header)}\n{"role":"user","content":"Hello"}\n{"role":"assistant","content":"Hi there"}\n`;
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, existingContent);
    return existingContent;
  }

  async function runTranscriptScenario(params: {
    sessionId: string;
    reply: {
      text: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      };
    };
    expectPruned: boolean;
  }) {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionKey = resolveMainSessionKey(undefined);
        const transcriptPath = path.join(tmpDir, `${params.sessionId}.jsonl`);
        const originalContent = await createTranscriptWithContent(transcriptPath, params.sessionId);
        const originalSize = (await fs.stat(transcriptPath)).size;

        await seedSessionStore(storePath, sessionKey, {
          sessionId: params.sessionId,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "user123",
        });

        replySpy.mockResolvedValueOnce(params.reply);

        const cfg = {
          version: 1,
          model: "test-model",
          agent: { workspace: tmpDir },
          sessionStore: storePath,
          channels: { telegram: {} },
        } as unknown as OpenClawConfig;

        await runHeartbeatOnce({
          agentId: undefined,
          reason: "test",
          cfg,
          deps: { sendTelegram: vi.fn() },
        });

        const finalSize = (await fs.stat(transcriptPath)).size;
        if (params.expectPruned) {
          const finalContent = await fs.readFile(transcriptPath, "utf-8");
          expect(finalContent).toBe(originalContent);
          expect(finalSize).toBe(originalSize);
          return;
        }
        expect(finalSize).toBeGreaterThanOrEqual(originalSize);
      },
      { prefix: "openclaw-hb-prune-" },
    );
  }

  it("prunes transcript when heartbeat returns HEARTBEAT_OK", async () => {
    await runTranscriptScenario({
      sessionId: "test-session-prune",
      reply: {
        text: "HEARTBEAT_OK",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      expectPruned: true,
    });
  });

  it("does not prune transcript when heartbeat returns meaningful content", async () => {
    await runTranscriptScenario({
      sessionId: "test-session-no-prune",
      reply: {
        text: "Alert: Something needs your attention!",
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      expectPruned: false,
    });
  });

  it("restores the previous session entry and transcript when heartbeat rotates sessions mid-run", async () => {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionKey = resolveMainSessionKey(undefined);
        const previousSessionId = "sid-before-heartbeat";
        const rotatedSessionId = "sid-heartbeat-only";
        const previousUpdatedAt = 1_700_000_000_000;
        const previousTranscriptPath = path.join(tmpDir, `${previousSessionId}.jsonl`);
        const previousContent = await createTranscriptWithContent(
          previousTranscriptPath,
          previousSessionId,
        );

        await seedSessionStore(storePath, sessionKey, {
          sessionId: previousSessionId,
          updatedAt: previousUpdatedAt,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "user123",
        });

        replySpy.mockImplementationOnce(async () => {
          const archivedTranscriptPath = `${previousTranscriptPath}.reset.2026-03-12T04-08-01.343Z`;
          await fs.rename(previousTranscriptPath, archivedTranscriptPath);
          await fs.writeFile(
            path.join(tmpDir, `${rotatedSessionId}.jsonl`),
            `${JSON.stringify({
              type: "session",
              version: 3,
              id: rotatedSessionId,
              timestamp: new Date().toISOString(),
              cwd: process.cwd(),
            })}\n{"role":"user","content":"hb"}\n{"role":"assistant","content":"HEARTBEAT_OK"}\n`,
          );
          await fs.writeFile(
            storePath,
            JSON.stringify({
              [sessionKey]: {
                sessionId: rotatedSessionId,
                updatedAt: previousUpdatedAt + 50_000,
                lastChannel: "telegram",
                lastProvider: "telegram",
                lastTo: "user123",
              },
            }),
          );
          return {
            text: "HEARTBEAT_OK",
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        });

        const cfg = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "telegram",
              },
            },
          },
          channels: {
            telegram: {
              heartbeat: { showOk: false },
            },
          },
          session: { store: storePath },
        } as unknown as OpenClawConfig;

        await runHeartbeatOnce({
          agentId: undefined,
          reason: "test",
          cfg,
          deps: { sendTelegram: vi.fn() },
        });

        const store = loadSessionStore(storePath);
        expect(store[sessionKey]?.sessionId).toBe(previousSessionId);
        expect(store[sessionKey]?.updatedAt).toBe(previousUpdatedAt);
        expect(await fs.readFile(previousTranscriptPath, "utf-8")).toBe(previousContent);
        await expect(fs.stat(path.join(tmpDir, `${rotatedSessionId}.jsonl`))).rejects.toThrow();
      },
      { prefix: "openclaw-hb-prune-rotate-" },
    );
  });
});
