import { logVerbose } from "../../globals.js";
import { extractErrorCode, formatErrorMessage } from "../../infra/errors.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "../../infra/retry.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

export type BlockReplyPipeline = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  stop: () => void;
  hasBuffered: () => boolean;
  didStream: () => boolean;
  isAborted: () => boolean;
  hasSentPayload: (payload: ReplyPayload) => boolean;
};

export type BlockReplyBuffer = {
  shouldBuffer: (payload: ReplyPayload) => boolean;
  onEnqueue?: (payload: ReplyPayload) => void;
  finalize?: (payload: ReplyPayload) => ReplyPayload;
};

export function createAudioAsVoiceBuffer(params: {
  isAudioPayload: (payload: ReplyPayload) => boolean;
}): BlockReplyBuffer {
  let seenAudioAsVoice = false;
  return {
    onEnqueue: (payload) => {
      if (payload.audioAsVoice) {
        seenAudioAsVoice = true;
      }
    },
    shouldBuffer: (payload) => params.isAudioPayload(payload),
    finalize: (payload) => (seenAudioAsVoice ? { ...payload, audioAsVoice: true } : payload),
  };
}

export function createBlockReplyPayloadKey(payload: ReplyPayload): string {
  const text = payload.text?.trim() ?? "";
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  return JSON.stringify({
    text,
    mediaList,
    replyToId: payload.replyToId ?? null,
  });
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const BLOCK_REPLY_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 5_000,
  jitter: 0.1,
};

const BLOCK_REPLY_TRANSIENT_ERRNO_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

const BLOCK_REPLY_TRANSIENT_ERROR_RE =
  /429|408|5\d\d|rate limit|retry after|timeout|timed out|network|socket|connect|connection|reset|closed|temporar|unavailable|fetch failed|try again/i;

function shouldRetryBlockReplyError(err: unknown): boolean {
  const code = extractErrorCode(err)?.toUpperCase();
  if (code && BLOCK_REPLY_TRANSIENT_ERRNO_CODES.has(code)) {
    return true;
  }
  return BLOCK_REPLY_TRANSIENT_ERROR_RE.test(formatErrorMessage(err));
}

export function createBlockReplyPipeline(params: {
  onBlockReply: (
    payload: ReplyPayload,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ) => Promise<void> | void;
  timeoutMs: number;
  retry?: RetryConfig;
  coalescing?: BlockStreamingCoalescing;
  buffer?: BlockReplyBuffer;
}): BlockReplyPipeline {
  const { onBlockReply, timeoutMs, coalescing, buffer, retry } = params;
  const retryConfig = resolveRetryConfig(BLOCK_REPLY_RETRY_DEFAULTS, retry);
  const sentKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const seenKeys = new Set<string>();
  const bufferedKeys = new Set<string>();
  const bufferedPayloadKeys = new Set<string>();
  const bufferedPayloads: ReplyPayload[] = [];
  let sendChain: Promise<void> = Promise.resolve();
  let aborted = false;
  let deliveryFailed = false;
  let didStream = false;
  let didLogTimeout = false;

  const logDelivery = (status: "sent" | "failed" | "skipped", detail: string) => {
    logVerbose(`block-reply-delivery status=${status} ${detail}`);
  };

  const sendPayload = (payload: ReplyPayload, skipSeen?: boolean) => {
    if (aborted) {
      logDelivery("skipped", "reason=aborted");
      return;
    }
    const payloadKey = createBlockReplyPayloadKey(payload);
    if (!skipSeen) {
      if (seenKeys.has(payloadKey)) {
        logDelivery("skipped", "reason=duplicate-seen");
        return;
      }
      seenKeys.add(payloadKey);
    }
    if (sentKeys.has(payloadKey) || pendingKeys.has(payloadKey)) {
      logDelivery("skipped", "reason=duplicate-pending");
      return;
    }
    pendingKeys.add(payloadKey);

    const timeoutError = new Error(`block reply delivery timed out after ${timeoutMs}ms`);
    const abortController = new AbortController();
    sendChain = sendChain
      .then(async () => {
        if (aborted) {
          return false;
        }
        await retryAsync(
          () =>
            withTimeout(
              onBlockReply(payload, {
                abortSignal: abortController.signal,
                timeoutMs,
              }) ?? Promise.resolve(),
              timeoutMs,
              timeoutError,
            ),
          {
            ...retryConfig,
            label: "block reply",
            shouldRetry: (err) => err !== timeoutError && shouldRetryBlockReplyError(err),
            onRetry: (info) => {
              const maxRetries = Math.max(1, info.maxAttempts - 1);
              logVerbose(
                `block reply delivery retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
              );
            },
          },
        );
        return true;
      })
      .then((didSend) => {
        if (!didSend) {
          return;
        }
        sentKeys.add(payloadKey);
        didStream = true;
        logDelivery("sent", "kind=block");
      })
      .catch((err) => {
        if (err === timeoutError) {
          abortController.abort();
          deliveryFailed = true;
          if (!didLogTimeout) {
            didLogTimeout = true;
            logVerbose(
              `block reply delivery timed out after ${timeoutMs}ms; allowing subsequent block replies`,
            );
          }
          logDelivery("failed", `reason=timeout timeoutMs=${timeoutMs}`);
          return;
        }
        deliveryFailed = true;
        logDelivery("failed", `reason=error error=${formatErrorMessage(err)}`);
        logVerbose(`block reply delivery failed: ${formatErrorMessage(err)}`);
      })
      .finally(() => {
        pendingKeys.delete(payloadKey);
      });
  };

  const coalescer = coalescing
    ? createBlockReplyCoalescer({
        config: coalescing,
        shouldAbort: () => aborted,
        onFlush: (payload) => {
          bufferedKeys.clear();
          sendPayload(payload);
        },
      })
    : null;

  const bufferPayload = (payload: ReplyPayload) => {
    buffer?.onEnqueue?.(payload);
    if (!buffer?.shouldBuffer(payload)) {
      return false;
    }
    const payloadKey = createBlockReplyPayloadKey(payload);
    if (
      seenKeys.has(payloadKey) ||
      sentKeys.has(payloadKey) ||
      pendingKeys.has(payloadKey) ||
      bufferedPayloadKeys.has(payloadKey)
    ) {
      logDelivery("skipped", "reason=duplicate-buffer");
      return true;
    }
    seenKeys.add(payloadKey);
    bufferedPayloadKeys.add(payloadKey);
    bufferedPayloads.push(payload);
    return true;
  };

  const flushBuffered = () => {
    if (!bufferedPayloads.length) {
      return;
    }
    for (const payload of bufferedPayloads) {
      const finalPayload = buffer?.finalize?.(payload) ?? payload;
      sendPayload(finalPayload, true);
    }
    bufferedPayloads.length = 0;
    bufferedPayloadKeys.clear();
  };

  const enqueue = (payload: ReplyPayload) => {
    if (aborted) {
      return;
    }
    if (bufferPayload(payload)) {
      return;
    }
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    if (hasMedia) {
      void coalescer?.flush({ force: true });
      sendPayload(payload);
      return;
    }
    if (coalescer) {
      const payloadKey = createBlockReplyPayloadKey(payload);
      if (seenKeys.has(payloadKey) || pendingKeys.has(payloadKey) || bufferedKeys.has(payloadKey)) {
        logDelivery("skipped", "reason=duplicate-coalesced");
        return;
      }
      bufferedKeys.add(payloadKey);
      coalescer.enqueue(payload);
      return;
    }
    sendPayload(payload);
  };

  const flush = async (options?: { force?: boolean }) => {
    await coalescer?.flush(options);
    flushBuffered();
    await sendChain;
  };

  const stop = () => {
    coalescer?.stop();
  };

  return {
    enqueue,
    flush,
    stop,
    hasBuffered: () => Boolean(coalescer?.hasBuffered() || bufferedPayloads.length > 0),
    didStream: () => didStream,
    isAborted: () => aborted || deliveryFailed,
    hasSentPayload: (payload) => {
      const payloadKey = createBlockReplyPayloadKey(payload);
      return sentKeys.has(payloadKey);
    },
  };
}
