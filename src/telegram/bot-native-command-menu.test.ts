import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

describe("bot-native-command-menu", () => {
  it("caps menu entries to Telegram limit", () => {
    const allCommands = Array.from({ length: 105 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(100);
    expect(result.totalCommands).toBe(105);
    expect(result.maxCommands).toBe(100);
    expect(result.overflowCount).toBe(5);
    expect(result.commandsToRegister[0]).toEqual({ command: "cmd_0", description: "Command 0" });
    expect(result.commandsToRegister[99]).toEqual({
      command: "cmd_99",
      description: "Command 99",
    });
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " },
      ],
      existingCommands,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "agent-run", description: "Run agent" }],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toEqual([]);
  });

  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async () => {
      callOrder.push("delete");
    });
    const setMyCommands = vi.fn(async () => {
      callOrder.push("set");
    });

    syncTelegramMenuCommands({
      bot: {
        api: {
          deleteMyCommands,
          setMyCommands,
        },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {} as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    expect(callOrder).toEqual(["delete", "set"]);
  });

  it("retries recoverable network failures during command sync", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Network request for 'setMyCommands' failed!"))
      .mockResolvedValue(undefined);
    const error = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: {
          deleteMyCommands,
          setMyCommands,
        },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("does not retry non-recoverable command sync failures", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("400: Bad Request: command description is invalid"));
    const error = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: {
          deleteMyCommands,
          setMyCommands,
        },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalled();
    });
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    expect(
      error.mock.calls.some((call) => String(call[0]).includes("Telegram command sync failed")),
    ).toBe(true);
  });
});
