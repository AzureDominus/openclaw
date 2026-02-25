import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_RESET_TRIGGERS } from "../../config/sessions.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { resolveDefaultModel } from "./directive-handling.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

export function buildResetSessionNoticeText(params: {
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
}): string {
  const modelLabel = `${params.provider}/${params.model}`;
  const defaultLabel = `${params.defaultProvider}/${params.defaultModel}`;
  return modelLabel === defaultLabel
    ? `✅ New session started · model: ${modelLabel}`
    : `✅ New session started · model: ${modelLabel} (default: ${defaultLabel})`;
}

export function resolveImmediateResetSessionNoticeText(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): string | undefined {
  const { ctx, cfg } = params;
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId = resolveSessionAgentId({
    sessionKey: agentSessionKey,
    config: cfg,
  });
  const resetAuthorized = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized: ctx.CommandAuthorized === true,
  }).isAuthorizedSender;
  if (!resetAuthorized) {
    return undefined;
  }

  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();
  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup = normalizedChatType != null && normalizedChatType !== "direct";
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;

  const resetTriggers = cfg.session?.resetTriggers?.length
    ? cfg.session.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const trimmedBodyLower = commandSource.trim().toLowerCase();
  const strippedForResetLower = strippedForReset.toLowerCase();
  let resetTriggered = false;
  for (const trigger of resetTriggers) {
    const triggerLower = String(trigger ?? "")
      .trim()
      .toLowerCase();
    if (!triggerLower) {
      continue;
    }
    if (
      trimmedBodyLower === triggerLower ||
      strippedForResetLower === triggerLower ||
      trimmedBodyLower.startsWith(`${triggerLower} `) ||
      strippedForResetLower.startsWith(`${triggerLower} `)
    ) {
      resetTriggered = true;
      break;
    }
  }
  if (!resetTriggered) {
    return undefined;
  }

  const { defaultProvider, defaultModel } = resolveDefaultModel({ cfg, agentId });
  return buildResetSessionNoticeText({
    provider: defaultProvider,
    model: defaultModel,
    defaultProvider,
    defaultModel,
  });
}
