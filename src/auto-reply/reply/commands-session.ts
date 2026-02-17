import { resolveAgentDir } from "../../agents/agent-scope.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { isRestartEnabled } from "../../config/commands.js";
import {
  formatThreadBindingDurationLabel,
  getThreadBindingManager,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
} from "../../discord/monitor/thread-bindings.js";
import { logVerbose } from "../../globals.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import { scheduleGatewaySigusr1Restart, triggerOpenClawRestart } from "../../infra/restart.js";
import { loadCostUsageSummary, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import {
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "../../telegram/thread-bindings.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { parseActivationCommand } from "../group-activation.js";
import { parseSendPolicyCommand } from "../send-policy.js";
import { normalizeUsageDisplay, resolveResponseUsageMode } from "../thinking.js";
import { isDiscordSurface, isTelegramSurface, resolveChannelAccountId } from "./channel-context.js";
import { handleAbortTrigger, handleStopCommand } from "./commands-session-abort.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { resolveTelegramConversationId } from "./telegram-context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function summarizeRecentCostWindow(
  summary: Awaited<ReturnType<typeof loadCostUsageSummary>>,
  days: number,
  nowMs: number,
) {
  const keys = new Set<string>();
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(nowMs - offset * DAY_MS);
    keys.add(day.toLocaleDateString("en-CA"));
  }

  let totalCost = 0;
  let totalTokens = 0;
  let missingCostEntries = 0;
  for (const entry of summary.daily) {
    if (!keys.has(entry.date)) {
      continue;
    }
    totalCost += entry.totalCost;
    totalTokens += entry.totalTokens;
    missingCostEntries += entry.missingCostEntries;
  }

  return { totalCost, totalTokens, missingCostEntries };
}

function formatCostWindowLine(
  label: string,
  window: { totalCost: number; totalTokens: number; missingCostEntries: number },
) {
  const cost = formatUsd(window.totalCost);
  const partial = window.missingCostEntries > 0 ? " (partial)" : "";
  const tokenPart =
    window.totalTokens > 0 ? ` · ${formatTokenCount(window.totalTokens)} tokens` : "";
  return `${label} ${cost ?? "n/a"}${partial}${tokenPart}`;
}

async function loadCurrentProviderUsageLine(
  params: Pick<HandleCommandsParams, "provider" | "cfg" | "agentId">,
  nowMs: number,
): Promise<string | undefined> {
  const usageProvider = resolveUsageProviderId(params.provider);
  if (!usageProvider) {
    return undefined;
  }
  try {
    const usageSummary = await loadProviderUsageSummary({
      timeoutMs: 3500,
      providers: [usageProvider],
      ...(params.agentId ? { agentDir: resolveAgentDir(params.cfg, params.agentId) } : {}),
    });
    const snapshot = usageSummary.providers.find((entry) => entry.provider === usageProvider);
    if (!snapshot) {
      return undefined;
    }
    if (snapshot.error) {
      return `Provider quota (${snapshot.displayName}) ${snapshot.error}`;
    }
    const formatted = formatUsageWindowSummary(snapshot, {
      now: nowMs,
      maxWindows: 2,
      includeResets: true,
    });
    if (!formatted) {
      return undefined;
    }
    return `Provider quota (${snapshot.displayName}) ${formatted}`;
  } catch {
    return undefined;
  }
}

const SESSION_COMMAND_PREFIX = "/session";
const SESSION_DURATION_OFF_VALUES = new Set(["off", "disable", "disabled", "none", "0"]);
const SESSION_ACTION_IDLE = "idle";
const SESSION_ACTION_MAX_AGE = "max-age";

function resolveSessionCommandUsage() {
  return "Usage: /session idle <duration|off> | /session max-age <duration|off> (example: /session idle 24h)";
}

function parseSessionDurationMs(raw: string): number {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new Error("missing duration");
  }
  if (SESSION_DURATION_OFF_VALUES.has(normalized)) {
    return 0;
  }
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const hours = Number(normalized);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new Error("invalid duration");
    }
    return Math.round(hours * 60 * 60 * 1000);
  }
  return parseDurationMs(normalized, { defaultUnit: "h" });
}

function formatSessionExpiry(expiresAt: number) {
  return new Date(expiresAt).toISOString();
}

function resolveTelegramBindingDurationMs(
  binding: SessionBindingRecord,
  key: "idleTimeoutMs" | "maxAgeMs",
  fallbackMs: number,
): number {
  const raw = binding.metadata?.[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallbackMs;
  }
  return Math.max(0, Math.floor(raw));
}

function resolveTelegramBindingLastActivityAt(binding: SessionBindingRecord): number {
  const raw = binding.metadata?.lastActivityAt;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return binding.boundAt;
  }
  return Math.max(Math.floor(raw), binding.boundAt);
}

function resolveTelegramBindingBoundBy(binding: SessionBindingRecord): string {
  const raw = binding.metadata?.boundBy;
  return typeof raw === "string" ? raw.trim() : "";
}

type UpdatedLifecycleBinding = {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

function resolveUpdatedBindingExpiry(params: {
  action: typeof SESSION_ACTION_IDLE | typeof SESSION_ACTION_MAX_AGE;
  bindings: UpdatedLifecycleBinding[];
}): number | undefined {
  const expiries = params.bindings
    .map((binding) => {
      if (params.action === SESSION_ACTION_IDLE) {
        const idleTimeoutMs =
          typeof binding.idleTimeoutMs === "number" && Number.isFinite(binding.idleTimeoutMs)
            ? Math.max(0, Math.floor(binding.idleTimeoutMs))
            : 0;
        if (idleTimeoutMs <= 0) {
          return undefined;
        }
        return Math.max(binding.lastActivityAt, binding.boundAt) + idleTimeoutMs;
      }

      const maxAgeMs =
        typeof binding.maxAgeMs === "number" && Number.isFinite(binding.maxAgeMs)
          ? Math.max(0, Math.floor(binding.maxAgeMs))
          : 0;
      if (maxAgeMs <= 0) {
        return undefined;
      }
      return binding.boundAt + maxAgeMs;
    })
    .filter((expiresAt): expiresAt is number => typeof expiresAt === "number");

  if (expiries.length === 0) {
    return undefined;
  }
  return Math.min(...expiries);
}

export const handleActivationCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const activationCommand = parseActivationCommand(params.command.commandBodyNormalized);
  if (!activationCommand.hasCommand) {
    return null;
  }
  if (!params.isGroup) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Group activation only applies to group chats." },
    };
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /activation from unauthorized sender in group: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!activationCommand.mode) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Usage: /activation mention|always" },
    };
  }
  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    params.sessionEntry.groupActivation = activationCommand.mode;
    params.sessionEntry.groupActivationNeedsSystemIntro = true;
    await persistSessionEntry(params);
  }
  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ Group activation set to ${activationCommand.mode}.`,
    },
  };
};

export const handleSendPolicyCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const sendPolicyCommand = parseSendPolicyCommand(params.command.commandBodyNormalized);
  if (!sendPolicyCommand.hasCommand) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /send from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!sendPolicyCommand.mode) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Usage: /send on|off|inherit" },
    };
  }
  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    if (sendPolicyCommand.mode === "inherit") {
      delete params.sessionEntry.sendPolicy;
    } else {
      params.sessionEntry.sendPolicy = sendPolicyCommand.mode;
    }
    await persistSessionEntry(params);
  }
  const label =
    sendPolicyCommand.mode === "inherit"
      ? "inherit"
      : sendPolicyCommand.mode === "allow"
        ? "on"
        : "off";
  return {
    shouldContinue: false,
    reply: { text: `⚙️ Send policy set to ${label}.` },
  };
};

export const handleUsageCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/usage" && !normalized.startsWith("/usage ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /usage from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rawArgs = normalized === "/usage" ? "" : normalized.slice("/usage".length).trim();
  const lowerArgs = rawArgs.toLowerCase();
  const requested = rawArgs ? normalizeUsageDisplay(rawArgs) : undefined;
  const isCostRequest = lowerArgs.startsWith("cost");
  const isQuotaRequest = !rawArgs || lowerArgs === "quota" || lowerArgs === "rate";
  const isNextRequest = lowerArgs === "next";

  if (isCostRequest) {
    const nowMs = Date.now();
    const sessionSummary = await loadSessionCostSummary({
      sessionId: params.sessionEntry?.sessionId,
      sessionEntry: params.sessionEntry,
      sessionFile: params.sessionEntry?.sessionFile,
      config: params.cfg,
      agentId: params.agentId,
    });
    const summary = await loadCostUsageSummary({
      days: 30,
      config: params.cfg,
      agentId: params.agentId,
    });

    const sessionCost = formatUsd(sessionSummary?.totalCost);
    const sessionTokens = sessionSummary?.totalTokens
      ? formatTokenCount(sessionSummary.totalTokens)
      : undefined;
    const sessionMissing = sessionSummary?.missingCostEntries ?? 0;
    const sessionSuffix = sessionMissing > 0 ? " (partial)" : "";
    const sessionLine =
      sessionCost || sessionTokens
        ? `Session ${sessionCost ?? "n/a"}${sessionSuffix}${sessionTokens ? ` · ${sessionTokens} tokens` : ""}`
        : "Session n/a";

    const last24h = summarizeRecentCostWindow(summary, 1, nowMs);
    const last7d = summarizeRecentCostWindow(summary, 7, nowMs);
    const last30d = summarizeRecentCostWindow(summary, 30, nowMs);

    const providerLine = await loadCurrentProviderUsageLine(params, nowMs);

    return {
      shouldContinue: false,
      reply: {
        text: [
          "💸 Usage cost",
          sessionLine,
          formatCostWindowLine("Last 24h", last24h),
          formatCostWindowLine("Last 7d", last7d),
          formatCostWindowLine("Last 30d", last30d),
          providerLine,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
  }

  const currentRaw =
    params.sessionEntry?.responseUsage ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey]?.responseUsage : undefined);
  const current = resolveResponseUsageMode(currentRaw);

  if (isQuotaRequest) {
    const providerLine = await loadCurrentProviderUsageLine(params, Date.now());
    if (!providerLine) {
      return {
        shouldContinue: false,
        reply: {
          text: `📊 Usage unavailable for provider "${params.provider}". Footer mode: ${current}.`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `📊 Usage\n${providerLine}\nFooter mode: ${current}.` },
    };
  }

  if (rawArgs && !requested && !isNextRequest) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Usage: /usage | /usage rate|cost|next|off|tokens|full" },
    };
  }

  const next =
    requested ??
    (isNextRequest
      ? current === "off"
        ? "tokens"
        : current === "tokens"
          ? "full"
          : "off"
      : current);

  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    if (next === "off") {
      delete params.sessionEntry.responseUsage;
    } else {
      params.sessionEntry.responseUsage = next;
    }
    await persistSessionEntry(params);
  }

  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ Usage footer: ${next}.`,
    },
  };
};

export const handleSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!/^\/session(?:\s|$)/.test(normalized)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /session from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice(SESSION_COMMAND_PREFIX.length).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = tokens[0]?.toLowerCase();
  if (action !== SESSION_ACTION_IDLE && action !== SESSION_ACTION_MAX_AGE) {
    return {
      shouldContinue: false,
      reply: { text: resolveSessionCommandUsage() },
    };
  }

  const onDiscord = isDiscordSurface(params);
  const onTelegram = isTelegramSurface(params);
  if (!onDiscord && !onTelegram) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /session idle and /session max-age are currently available for Discord and Telegram bound sessions.",
      },
    };
  }

  const accountId = resolveChannelAccountId(params);
  const sessionBindingService = getSessionBindingService();
  const threadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  const telegramConversationId = onTelegram ? resolveTelegramConversationId(params) : undefined;

  const discordManager = onDiscord ? getThreadBindingManager(accountId) : null;
  if (onDiscord && !discordManager) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Discord thread bindings are unavailable for this account." },
    };
  }

  const discordBinding =
    onDiscord && threadId ? discordManager?.getByThreadId(threadId) : undefined;
  const telegramBinding =
    onTelegram && telegramConversationId
      ? sessionBindingService.resolveByConversation({
          channel: "telegram",
          accountId,
          conversationId: telegramConversationId,
        })
      : null;
  if (onDiscord && !discordBinding) {
    if (onDiscord && !threadId) {
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ /session idle and /session max-age must be run inside a focused Discord thread.",
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ This thread is not currently focused." },
    };
  }
  if (onTelegram && !telegramBinding) {
    if (!telegramConversationId) {
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ /session idle and /session max-age on Telegram require a topic context in groups, or a direct-message conversation.",
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ This conversation is not currently focused." },
    };
  }

  const idleTimeoutMs = onDiscord
    ? resolveThreadBindingIdleTimeoutMs({
        record: discordBinding!,
        defaultIdleTimeoutMs: discordManager!.getIdleTimeoutMs(),
      })
    : resolveTelegramBindingDurationMs(telegramBinding!, "idleTimeoutMs", 24 * 60 * 60 * 1000);
  const idleExpiresAt = onDiscord
    ? resolveThreadBindingInactivityExpiresAt({
        record: discordBinding!,
        defaultIdleTimeoutMs: discordManager!.getIdleTimeoutMs(),
      })
    : idleTimeoutMs > 0
      ? resolveTelegramBindingLastActivityAt(telegramBinding!) + idleTimeoutMs
      : undefined;
  const maxAgeMs = onDiscord
    ? resolveThreadBindingMaxAgeMs({
        record: discordBinding!,
        defaultMaxAgeMs: discordManager!.getMaxAgeMs(),
      })
    : resolveTelegramBindingDurationMs(telegramBinding!, "maxAgeMs", 0);
  const maxAgeExpiresAt = onDiscord
    ? resolveThreadBindingMaxAgeExpiresAt({
        record: discordBinding!,
        defaultMaxAgeMs: discordManager!.getMaxAgeMs(),
      })
    : maxAgeMs > 0
      ? telegramBinding!.boundAt + maxAgeMs
      : undefined;

  const durationArgRaw = tokens.slice(1).join("");
  if (!durationArgRaw) {
    if (action === SESSION_ACTION_IDLE) {
      if (
        typeof idleExpiresAt === "number" &&
        Number.isFinite(idleExpiresAt) &&
        idleExpiresAt > Date.now()
      ) {
        return {
          shouldContinue: false,
          reply: {
            text: `ℹ️ Idle timeout active (${formatThreadBindingDurationLabel(idleTimeoutMs)}, next auto-unfocus at ${formatSessionExpiry(idleExpiresAt)}).`,
          },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: "ℹ️ Idle timeout is currently disabled for this focused session." },
      };
    }

    if (
      typeof maxAgeExpiresAt === "number" &&
      Number.isFinite(maxAgeExpiresAt) &&
      maxAgeExpiresAt > Date.now()
    ) {
      return {
        shouldContinue: false,
        reply: {
          text: `ℹ️ Max age active (${formatThreadBindingDurationLabel(maxAgeMs)}, hard auto-unfocus at ${formatSessionExpiry(maxAgeExpiresAt)}).`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ Max age is currently disabled for this focused session." },
    };
  }

  const senderId = params.command.senderId?.trim() || "";
  const boundBy = onDiscord
    ? discordBinding!.boundBy
    : resolveTelegramBindingBoundBy(telegramBinding!);
  if (boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return {
      shouldContinue: false,
      reply: {
        text: onDiscord
          ? `⚠️ Only ${boundBy} can update session lifecycle settings for this thread.`
          : `⚠️ Only ${boundBy} can update session lifecycle settings for this conversation.`,
      },
    };
  }

  let durationMs: number;
  try {
    durationMs = parseSessionDurationMs(durationArgRaw);
  } catch {
    return {
      shouldContinue: false,
      reply: { text: resolveSessionCommandUsage() },
    };
  }

  const updatedBindings = (() => {
    if (onDiscord) {
      return action === SESSION_ACTION_IDLE
        ? setThreadBindingIdleTimeoutBySessionKey({
            targetSessionKey: discordBinding!.targetSessionKey,
            accountId,
            idleTimeoutMs: durationMs,
          })
        : setThreadBindingMaxAgeBySessionKey({
            targetSessionKey: discordBinding!.targetSessionKey,
            accountId,
            maxAgeMs: durationMs,
          });
    }
    return action === SESSION_ACTION_IDLE
      ? setTelegramThreadBindingIdleTimeoutBySessionKey({
          targetSessionKey: telegramBinding!.targetSessionKey,
          accountId,
          idleTimeoutMs: durationMs,
        })
      : setTelegramThreadBindingMaxAgeBySessionKey({
          targetSessionKey: telegramBinding!.targetSessionKey,
          accountId,
          maxAgeMs: durationMs,
        });
  })();
  if (updatedBindings.length === 0) {
    return {
      shouldContinue: false,
      reply: {
        text:
          action === SESSION_ACTION_IDLE
            ? "⚠️ Failed to update idle timeout for the current binding."
            : "⚠️ Failed to update max age for the current binding.",
      },
    };
  }

  if (durationMs <= 0) {
    return {
      shouldContinue: false,
      reply: {
        text:
          action === SESSION_ACTION_IDLE
            ? `✅ Idle timeout disabled for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"}.`
            : `✅ Max age disabled for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"}.`,
      },
    };
  }

  const nextExpiry = resolveUpdatedBindingExpiry({
    action,
    bindings: updatedBindings,
  });
  const expiryLabel =
    typeof nextExpiry === "number" && Number.isFinite(nextExpiry)
      ? formatSessionExpiry(nextExpiry)
      : "n/a";

  return {
    shouldContinue: false,
    reply: {
      text:
        action === SESSION_ACTION_IDLE
          ? `✅ Idle timeout set to ${formatThreadBindingDurationLabel(durationMs)} for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"} (next auto-unfocus at ${expiryLabel}).`
          : `✅ Max age set to ${formatThreadBindingDurationLabel(durationMs)} for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"} (hard auto-unfocus at ${expiryLabel}).`,
    },
  };
};
export const handleRestartCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/restart") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /restart from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!isRestartEnabled(params.cfg)) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /restart is disabled (commands.restart=false).",
      },
    };
  }
  const hasSigusr1Listener = process.listenerCount("SIGUSR1") > 0;
  if (hasSigusr1Listener) {
    scheduleGatewaySigusr1Restart({ reason: "/restart" });
    return {
      shouldContinue: false,
      reply: {
        text: "⚙️ Restarting OpenClaw in-process (SIGUSR1); back in a few seconds.",
      },
    };
  }
  const restartMethod = triggerOpenClawRestart();
  if (!restartMethod.ok) {
    const detail = restartMethod.detail ? ` Details: ${restartMethod.detail}` : "";
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Restart failed (${restartMethod.method}).${detail}`,
      },
    };
  }
  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ Restarting OpenClaw via ${restartMethod.method}; give me a few seconds to come back online.`,
    },
  };
};

export { handleAbortTrigger, handleStopCommand };
