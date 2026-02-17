import { resolveAgentDir } from "../../agents/agent-scope.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { isRestartEnabled } from "../../config/commands.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import {
  formatThreadBindingTtlLabel,
  getThreadBindingManager,
  setThreadBindingTtlBySessionKey,
} from "../../discord/monitor/thread-bindings.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  formatUsageWindowBars,
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import { scheduleGatewaySigusr1Restart, triggerOpenClawRestart } from "../../infra/restart.js";
import { loadCostUsageSummary, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { parseActivationCommand } from "../group-activation.js";
import { parseSendPolicyCommand } from "../send-policy.js";
import { normalizeUsageDisplay, resolveResponseUsageMode } from "../thinking.js";
import {
  formatAbortReplyText,
  isAbortTrigger,
  resolveSessionEntryForKey,
  setAbortMemory,
  stopSubagentsForRequester,
} from "./abort.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { clearSessionQueues } from "./queue.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type ProviderUsageDisplay = {
  provider: string;
  quotaSummary: string;
  quotaLines: string[];
};

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
    window.totalTokens > 0 ? `, ${formatTokenCount(window.totalTokens)} tokens` : "";
  return `${label}: ${cost ?? "n/a"}${partial}${tokenPart}`;
}

async function loadCurrentProviderUsage(
  params: Pick<HandleCommandsParams, "provider" | "cfg" | "agentId">,
  nowMs: number,
): Promise<ProviderUsageDisplay | undefined> {
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
      return {
        provider: snapshot.displayName,
        quotaSummary: `unavailable (${snapshot.error})`,
        quotaLines: [],
      };
    }
    const quotaSummary = formatUsageWindowSummary(snapshot, {
      now: nowMs,
      maxWindows: 2,
      includeResets: false,
    });
    if (!quotaSummary) {
      return {
        provider: snapshot.displayName,
        quotaSummary: "unavailable",
        quotaLines: [],
      };
    }
    return {
      provider: snapshot.displayName,
      quotaSummary,
      quotaLines: formatUsageWindowBars(snapshot, {
        now: nowMs,
        maxWindows: 2,
        includeResets: true,
      }),
    };
  } catch {
    return undefined;
  }
}
function resolveAbortTarget(params: {
  ctx: { CommandTargetSessionKey?: string | null };
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}) {
  const targetSessionKey = params.ctx.CommandTargetSessionKey?.trim() || params.sessionKey;
  const { entry, key } = resolveSessionEntryForKey(params.sessionStore, targetSessionKey);
  if (entry && key) {
    return { entry, key, sessionId: entry.sessionId };
  }
  if (params.sessionEntry && params.sessionKey) {
    return {
      entry: params.sessionEntry,
      key: params.sessionKey,
      sessionId: params.sessionEntry.sessionId,
    };
  }
  return { entry: undefined, key: targetSessionKey, sessionId: undefined };
}

const SESSION_COMMAND_PREFIX = "/session";
const SESSION_TTL_OFF_VALUES = new Set(["off", "disable", "disabled", "none", "0"]);

function isDiscordSurface(params: Parameters<CommandHandler>[0]): boolean {
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return (
    String(channel ?? "")
      .trim()
      .toLowerCase() === "discord"
  );
}

function resolveDiscordAccountId(params: Parameters<CommandHandler>[0]): string {
  const accountId = typeof params.ctx.AccountId === "string" ? params.ctx.AccountId.trim() : "";
  return accountId || "default";
}

function resolveSessionCommandUsage() {
  return "Usage: /session ttl <duration|off> (example: /session ttl 24h)";
}

function parseSessionTtlMs(raw: string): number {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new Error("missing ttl");
  }
  if (SESSION_TTL_OFF_VALUES.has(normalized)) {
    return 0;
  }
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const hours = Number(normalized);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new Error("invalid ttl");
    }
    return Math.round(hours * 60 * 60 * 1000);
  }
  return parseDurationMs(normalized, { defaultUnit: "h" });
}

function formatSessionExpiry(expiresAt: number) {
  return new Date(expiresAt).toISOString();
}

async function applyAbortTarget(params: {
  abortTarget: ReturnType<typeof resolveAbortTarget>;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortKey?: string;
}) {
  const { abortTarget } = params;
  if (abortTarget.sessionId) {
    abortEmbeddedPiRun(abortTarget.sessionId);
  }
  if (abortTarget.entry && params.sessionStore && abortTarget.key) {
    abortTarget.entry.abortedLastRun = true;
    abortTarget.entry.updatedAt = Date.now();
    params.sessionStore[abortTarget.key] = abortTarget.entry;
    if (params.storePath) {
      await updateSessionStore(params.storePath, (store) => {
        store[abortTarget.key] = abortTarget.entry;
      });
    }
  } else if (params.abortKey) {
    setAbortMemory(params.abortKey, true);
  }
}

async function persistSessionEntry(params: Parameters<CommandHandler>[0]): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  params.sessionEntry.updatedAt = Date.now();
  params.sessionStore[params.sessionKey] = params.sessionEntry;
  if (params.storePath) {
    await updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey] = params.sessionEntry as SessionEntry;
    });
  }
  return true;
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
        ? `session: ${sessionCost ?? "n/a"}${sessionSuffix}${sessionTokens ? `, ${sessionTokens} tokens` : ""}`
        : "session: n/a";

    const last24h = summarizeRecentCostWindow(summary, 1, nowMs);
    const last7d = summarizeRecentCostWindow(summary, 7, nowMs);
    const last30d = summarizeRecentCostWindow(summary, 30, nowMs);

    const providerUsage = await loadCurrentProviderUsage(params, nowMs);

    return {
      shouldContinue: false,
      reply: {
        text: [
          "Usage cost",
          sessionLine,
          formatCostWindowLine("24h", last24h),
          formatCostWindowLine("7d", last7d),
          formatCostWindowLine("30d", last30d),
          providerUsage ? `provider: ${providerUsage.provider}` : undefined,
          providerUsage ? `quota: ${providerUsage.quotaSummary}` : undefined,
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
    const providerUsage = await loadCurrentProviderUsage(params, Date.now());
    return {
      shouldContinue: false,
      reply: {
        text: [
          "Usage",
          `provider: ${providerUsage?.provider ?? params.provider}`,
          ...(providerUsage?.quotaLines.length
            ? providerUsage.quotaLines
            : [`quota: ${providerUsage?.quotaSummary ?? "unavailable"}`]),
          `footer: ${current}`,
        ].join("\n"),
      },
    };
  }

  if (rawArgs && !requested && !isNextRequest) {
    return {
      shouldContinue: false,
      reply: { text: "Usage: /usage | /usage rate|cost|next|off|tokens|full" },
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
      text: `Usage footer: ${next}.`,
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
  if (action !== "ttl") {
    return {
      shouldContinue: false,
      reply: { text: resolveSessionCommandUsage() },
    };
  }

  if (!isDiscordSurface(params)) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /session ttl is currently available for Discord thread-bound sessions." },
    };
  }

  const threadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  if (!threadId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /session ttl must be run inside a focused Discord thread." },
    };
  }

  const accountId = resolveDiscordAccountId(params);
  const threadBindings = getThreadBindingManager(accountId);
  if (!threadBindings) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Discord thread bindings are unavailable for this account." },
    };
  }

  const binding = threadBindings.getByThreadId(threadId);
  if (!binding) {
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ This thread is not currently focused." },
    };
  }

  const ttlArgRaw = tokens.slice(1).join("");
  if (!ttlArgRaw) {
    const expiresAt = binding.expiresAt;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      return {
        shouldContinue: false,
        reply: {
          text: `ℹ️ Session TTL active (${formatThreadBindingTtlLabel(expiresAt - Date.now())}, auto-unfocus at ${formatSessionExpiry(expiresAt)}).`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ Session TTL is currently disabled for this focused session." },
    };
  }

  const senderId = params.command.senderId?.trim() || "";
  if (binding.boundBy && binding.boundBy !== "system" && senderId && senderId !== binding.boundBy) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Only ${binding.boundBy} can update session TTL for this thread.` },
    };
  }

  let ttlMs: number;
  try {
    ttlMs = parseSessionTtlMs(ttlArgRaw);
  } catch {
    return {
      shouldContinue: false,
      reply: { text: resolveSessionCommandUsage() },
    };
  }

  const updatedBindings = setThreadBindingTtlBySessionKey({
    targetSessionKey: binding.targetSessionKey,
    accountId,
    ttlMs,
  });
  if (updatedBindings.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Failed to update session TTL for the current binding." },
    };
  }

  if (ttlMs <= 0) {
    return {
      shouldContinue: false,
      reply: {
        text: `✅ Session TTL disabled for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"}.`,
      },
    };
  }

  const expiresAt = updatedBindings[0]?.expiresAt;
  const expiryLabel =
    typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? formatSessionExpiry(expiresAt)
      : "n/a";
  return {
    shouldContinue: false,
    reply: {
      text: `✅ Session TTL set to ${formatThreadBindingTtlLabel(ttlMs)} for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"} (auto-unfocus at ${expiryLabel}).`,
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

export const handleStopCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/stop") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /stop from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const abortTarget = resolveAbortTarget({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
  });
  const cleared = clearSessionQueues([abortTarget.key, abortTarget.sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }
  await applyAbortTarget({
    abortTarget,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortKey: params.command.abortKey,
  });

  // Trigger internal hook for stop command
  const hookEvent = createInternalHookEvent(
    "command",
    "stop",
    abortTarget.key ?? params.sessionKey ?? "",
    {
      sessionEntry: abortTarget.entry ?? params.sessionEntry,
      sessionId: abortTarget.sessionId,
      commandSource: params.command.surface,
      senderId: params.command.senderId,
    },
  );
  await triggerInternalHook(hookEvent);

  const { stopped } = stopSubagentsForRequester({
    cfg: params.cfg,
    requesterSessionKey: abortTarget.key ?? params.sessionKey,
  });

  return { shouldContinue: false, reply: { text: formatAbortReplyText(stopped) } };
};

export const handleAbortTrigger: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (!isAbortTrigger(params.command.rawBodyNormalized)) {
    return null;
  }
  const abortTarget = resolveAbortTarget({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
  });
  await applyAbortTarget({
    abortTarget,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortKey: params.command.abortKey,
  });
  return { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } };
};
