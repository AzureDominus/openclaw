import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { getChildLogger } from "../logging/logger.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { markdownToWhatsApp } from "../markdown/whatsapp.js";
import { isLikelyBrowserScreenshotMediaUrl } from "../media/browser-screenshot.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import { toWhatsappJid } from "../utils.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { type ActiveWebSendOptions, requireActiveWebListener } from "./active-listener.js";
import { loadWebMedia } from "./media.js";

const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");
const WHATSAPP_OVERSIZE_DOC_MAX_BYTES = 5 * 1024 * 1024;
const MB = 1024 * 1024;

function resolveWhatsAppMaxBytes(params: {
  cfg: ReturnType<typeof loadConfig>;
  accountId?: string | null;
}) {
  const accountId = (params.accountId ?? "").trim();
  const limitMb =
    params.cfg.channels?.whatsapp?.accounts?.[accountId]?.mediaMaxMb ??
    params.cfg.channels?.whatsapp?.mediaMaxMb ??
    params.cfg.agents?.defaults?.mediaMaxMb;
  return typeof limitMb === "number" && limitMb > 0 ? limitMb * MB : undefined;
}

async function shouldSendWhatsAppImageAsDocument(params: {
  mode: "image" | "auto" | "document";
  mediaUrl?: string;
  buffer: Buffer;
}): Promise<boolean> {
  if (params.mode === "document") {
    return true;
  }
  if (params.mode === "image") {
    return false;
  }
  if (!isLikelyBrowserScreenshotMediaUrl(params.mediaUrl)) {
    return false;
  }
  return params.buffer.byteLength > WHATSAPP_OVERSIZE_DOC_MAX_BYTES;
}

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    verbose: boolean;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    gifPlayback?: boolean;
    accountId?: string;
    maxBytes?: number;
  },
): Promise<{ messageId: string; toJid: string }> {
  let text = body;
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const { listener: active, accountId: resolvedAccountId } = requireActiveWebListener(
    options.accountId,
  );
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: resolvedAccountId });
  const maxBytes =
    options.maxBytes ??
    resolveWhatsAppMaxBytes({
      cfg,
      accountId: resolvedAccountId,
    });
  const imageUploadMode = account.imageUploadMode ?? "auto";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "whatsapp",
    accountId: resolvedAccountId ?? options.accountId,
  });
  text = convertMarkdownTables(text ?? "", tableMode);
  text = markdownToWhatsApp(text);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const jid = toWhatsappJid(to);
    const redactedJid = redactIdentifier(jid);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    let documentFileName: string | undefined;
    let sendImageAsDocument = false;
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl, {
        maxBytes,
        localRoots: options.mediaLocalRoots,
      });
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.contentType;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        mediaType =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
      } else if (media.kind === "video") {
        text = caption ?? "";
      } else if (media.kind === "image") {
        text = caption ?? "";
        sendImageAsDocument = await shouldSendWhatsAppImageAsDocument({
          mode: imageUploadMode,
          mediaUrl: options.mediaUrl,
          buffer: media.buffer,
        });
        if (sendImageAsDocument) {
          documentFileName = media.fileName;
        }
      } else {
        text = caption ?? "";
        documentFileName = media.fileName;
      }
    }
    outboundLog.info(`Sending message -> ${redactedJid}${options.mediaUrl ? " (media)" : ""}`);
    logger.info({ jid: redactedJid, hasMedia: Boolean(options.mediaUrl) }, "sending message");
    await active.sendComposingTo(to);
    const hasExplicitAccountId = Boolean(options.accountId?.trim());
    const accountId = hasExplicitAccountId ? resolvedAccountId : undefined;
    const sendOptions: ActiveWebSendOptions | undefined =
      options.gifPlayback || accountId || documentFileName || sendImageAsDocument
        ? {
            ...(options.gifPlayback ? { gifPlayback: true } : {}),
            ...(documentFileName ? { fileName: documentFileName } : {}),
            ...(sendImageAsDocument ? { sendImageAsDocument: true } : {}),
            accountId,
          }
        : undefined;
    const result = sendOptions
      ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions)
      : await active.sendMessage(to, text, mediaBuffer, mediaType);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${redactedJid}${options.mediaUrl ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid: redactedJid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to: redactedTo, hasMedia: Boolean(options.mediaUrl) },
      "failed to send via web session",
    );
    throw err;
  }
}

export async function sendReactionWhatsApp(
  chatJid: string,
  messageId: string,
  emoji: string,
  options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
  },
): Promise<void> {
  const correlationId = generateSecureUuid();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const redactedChatJid = redactIdentifier(chatJid);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    chatJid: redactedChatJid,
    messageId,
  });
  try {
    const jid = toWhatsappJid(chatJid);
    const redactedJid = redactIdentifier(jid);
    outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sending reaction");
    await active.sendReaction(
      chatJid,
      messageId,
      emoji,
      options.fromMe ?? false,
      options.participant,
    );
    outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sent reaction");
  } catch (err) {
    logger.error(
      { err: String(err), chatJid: redactedChatJid, messageId, emoji },
      "failed to send reaction via web session",
    );
    throw err;
  }
}

export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  options: { verbose: boolean; accountId?: string },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const jid = toWhatsappJid(to);
    const redactedJid = redactIdentifier(jid);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${redactedJid}`);
    logger.info(
      {
        jid: redactedJid,
        optionCount: normalized.options.length,
        maxSelections: normalized.maxSelections,
      },
      "sending poll",
    );
    const result = await active.sendPoll(to, normalized);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${redactedJid} (${durationMs}ms)`);
    logger.info({ jid: redactedJid, messageId }, "sent poll");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error({ err: String(err), to: redactedTo }, "failed to send poll via web session");
    throw err;
  }
}
