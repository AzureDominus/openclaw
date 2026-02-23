import type { Bot } from "grammy";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import { createTelegramRetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

export const TELEGRAM_MAX_COMMANDS = 100;
const TELEGRAM_MENU_SYNC_RETRY_DEFAULTS: RetryConfig = {
  attempts: 8,
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitter: 0.15,
};

export type TelegramMenuCommand = {
  command: string;
  description: string;
};

type TelegramPluginCommandSpec = {
  name: string;
  description: string;
};

export function buildPluginTelegramMenuCommands(params: {
  specs: TelegramPluginCommandSpec[];
  existingCommands: Set<string>;
}): { commands: TelegramMenuCommand[]; issues: string[] } {
  const { specs, existingCommands } = params;
  const commands: TelegramMenuCommand[] = [];
  const issues: string[] = [];
  const pluginCommandNames = new Set<string>();

  for (const spec of specs) {
    const normalized = normalizeTelegramCommandName(spec.name);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      issues.push(
        `Plugin command "/${spec.name}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
      );
      continue;
    }
    const description = spec.description.trim();
    if (!description) {
      issues.push(`Plugin command "/${normalized}" is missing a description.`);
      continue;
    }
    if (existingCommands.has(normalized)) {
      if (pluginCommandNames.has(normalized)) {
        issues.push(`Plugin command "/${normalized}" is duplicated.`);
      } else {
        issues.push(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`);
      }
      continue;
    }
    pluginCommandNames.add(normalized);
    existingCommands.add(normalized);
    commands.push({ command: normalized, description });
  }

  return { commands, issues };
}

export function buildCappedTelegramMenuCommands(params: {
  allCommands: TelegramMenuCommand[];
  maxCommands?: number;
}): {
  commandsToRegister: TelegramMenuCommand[];
  totalCommands: number;
  maxCommands: number;
  overflowCount: number;
} {
  const { allCommands } = params;
  const maxCommands = params.maxCommands ?? TELEGRAM_MAX_COMMANDS;
  const totalCommands = allCommands.length;
  const overflowCount = Math.max(0, totalCommands - maxCommands);
  const commandsToRegister = allCommands.slice(0, maxCommands);
  return { commandsToRegister, totalCommands, maxCommands, overflowCount };
}

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): void {
  const { bot, runtime, commandsToRegister, retry, configRetry, verbose } = params;
  const sync = async () => {
    const retryOverrides: RetryConfig = {
      ...configRetry,
      ...retry,
    };
    const request = createTelegramRetryRunner({
      configRetry: TELEGRAM_MENU_SYNC_RETRY_DEFAULTS,
      retry: retryOverrides,
      verbose,
      shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "unknown" }),
    });

    const requestWithLogging = async <T>(operation: string, fn: () => Promise<T>) =>
      withTelegramApiErrorLogging({
        operation,
        runtime,
        fn: () => request(fn, operation),
      });

    // Keep delete -> set ordering to avoid stale deletions racing after fresh registrations.
    if (typeof bot.api.deleteMyCommands === "function") {
      await requestWithLogging("deleteMyCommands", () => bot.api.deleteMyCommands()).catch(
        () => {},
      );
    }

    if (commandsToRegister.length === 0) {
      return;
    }

    await requestWithLogging("setMyCommands", () => bot.api.setMyCommands(commandsToRegister));
  };

  void sync().catch((err) => {
    runtime.error?.(`Telegram command sync failed: ${String(err)}`);
  });
}
