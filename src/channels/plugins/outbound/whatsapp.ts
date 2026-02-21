import type { ChannelOutboundAdapter } from "../types.js";
import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { createWhatsAppOutboundBase } from "../whatsapp-shared.js";
import { sendTextMediaPayload } from "./direct-text-media.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";

function resolveWhatsAppMaxBytes(params: {
  cfg: Parameters<typeof resolveChannelMediaMaxBytes>[0]["cfg"];
  accountId?: string | null;
}) {
  return resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.whatsapp?.accounts?.[accountId]?.mediaMaxMb ??
      cfg.channels?.whatsapp?.mediaMaxMb,
    accountId: params.accountId,
  });
}

function trimLeadingWhitespace(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export const whatsappOutbound: ChannelOutboundAdapter = {
  ...createWhatsAppOutboundBase({
    chunker: chunkText,
    sendMessageWhatsApp: async (...args) =>
      (await import("../../../web/outbound.js")).sendMessageWhatsApp(...args),
    sendPollWhatsApp,
    shouldLogVerbose,
    normalizeText: trimLeadingWhitespace,
    skipEmptyText: true,
  }),
  sendPayload: async (ctx) => {
    const text = trimLeadingWhitespace(ctx.payload.text);
    const hasMedia = Boolean(ctx.payload.mediaUrl) || (ctx.payload.mediaUrls?.length ?? 0) > 0;
    if (!text && !hasMedia) {
      return { channel: "whatsapp", messageId: "" };
    }
    return await sendTextMediaPayload({
      channel: "whatsapp",
      ctx: {
        ...ctx,
        payload: {
          ...ctx.payload,
          text,
        },
      },
      adapter: whatsappOutbound,
    });
  },
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const normalizedText = trimLeadingWhitespace(text);
    if (!normalizedText) {
      return { channel: "whatsapp", messageId: "" };
    }
    const maxBytes = resolveWhatsAppMaxBytes({ cfg, accountId });
    const result = await send(to, normalizedText, {
      verbose: false,
      cfg,
      accountId: accountId ?? undefined,
      gifPlayback,
      maxBytes,
    });
    return { channel: "whatsapp", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const maxBytes = resolveWhatsAppMaxBytes({ cfg, accountId });
    const result = await send(to, text, {
      verbose: false,
      cfg,
      mediaUrl,
      mediaLocalRoots,
      accountId: accountId ?? undefined,
      gifPlayback,
      maxBytes,
    });
    return { channel: "whatsapp", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId }) =>
    await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
      cfg,
    }),
};
