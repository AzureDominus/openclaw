import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import type { TelegramInlineButtons } from "../../../telegram/button-types.js";
import { markdownToTelegramHtmlChunks } from "../../../telegram/format.js";
import {
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
} from "../../../telegram/outbound-params.js";
import { sendMessageTelegram, sendTypingTelegram } from "../../../telegram/send.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";
import type { ChannelOutboundAdapter } from "../types.js";

function resolveTelegramMaxBytes(params: {
  cfg: Parameters<typeof resolveChannelMediaMaxBytes>[0]["cfg"];
  accountId?: string | null;
}) {
  return resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.telegram?.accounts?.[accountId]?.mediaMaxMb ??
      cfg.channels?.telegram?.mediaMaxMb,
    accountId: params.accountId,
  });
}

function resolveTelegramSendContext(params: {
  cfg: NonNullable<Parameters<typeof sendMessageTelegram>[2]>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
}): {
  send: typeof sendMessageTelegram;
  baseOpts: {
    cfg: NonNullable<Parameters<typeof sendMessageTelegram>[2]>["cfg"];
    verbose: false;
    textMode: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    accountId?: string;
  };
} {
  const send = params.deps?.sendTelegram ?? sendMessageTelegram;
  return {
    send,
    baseOpts: {
      verbose: false,
      textMode: "html",
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      accountId: params.accountId ?? undefined,
    },
  };
}

function resolveTelegramTypingContext(params: {
  cfg: NonNullable<Parameters<typeof sendTypingTelegram>[1]>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  threadId?: string | number | null;
}): {
  sendTyping: typeof sendTypingTelegram;
  baseOpts: {
    cfg: NonNullable<Parameters<typeof sendTypingTelegram>[1]>["cfg"];
    verbose: false;
    messageThreadId?: number;
    accountId?: string;
  };
} {
  const sendTyping = params.deps?.sendTelegramTyping ?? sendTypingTelegram;
  return {
    sendTyping,
    baseOpts: {
      verbose: false,
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      accountId: params.accountId ?? undefined,
    },
  };
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId }) => {
    const { send, baseOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
    });
    const result = await send(to, text, {
      ...baseOpts,
    });
    return { channel: "telegram", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
  }) => {
    const { send, baseOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
    });
    const maxBytes = resolveTelegramMaxBytes({ cfg, accountId });
    const result = await send(to, text, {
      ...baseOpts,
      mediaUrl,
      maxBytes,
      mediaLocalRoots,
    });
    return { channel: "telegram", ...result };
  },
  sendTyping: async ({ cfg, to, accountId, deps, threadId }) => {
    const { sendTyping, baseOpts } = resolveTelegramTypingContext({
      cfg,
      deps,
      accountId,
      threadId,
    });
    await sendTyping(to, baseOpts);
  },
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
  }) => {
    const { send, baseOpts: contextOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
    });
    const maxBytes = resolveTelegramMaxBytes({ cfg, accountId });
    const telegramData = payload.channelData?.telegram as
      | { buttons?: TelegramInlineButtons; quoteText?: string }
      | undefined;
    const quoteText =
      typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
    const text = payload.text ?? "";
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    const payloadOpts = {
      ...contextOpts,
      quoteText,
      maxBytes,
      mediaLocalRoots,
    };

    if (mediaUrls.length === 0) {
      const result = await send(to, text, {
        ...payloadOpts,
        buttons: telegramData?.buttons,
      });
      return { channel: "telegram", ...result };
    }

    // Telegram allows reply_markup on media; attach buttons only to first send.
    let finalResult: Awaited<ReturnType<typeof send>> | undefined;
    for (let i = 0; i < mediaUrls.length; i += 1) {
      const mediaUrl = mediaUrls[i];
      const isFirst = i === 0;
      finalResult = await send(to, isFirst ? text : "", {
        ...payloadOpts,
        mediaUrl,
        ...(isFirst ? { buttons: telegramData?.buttons } : {}),
      });
    }
    return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
  },
};
