import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { extractErrorCode, formatErrorMessage } from "../../infra/errors.js";
import {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  isPermanentDeliveryError,
  markDeliveryDelivered,
  markDeliveryUncertain,
} from "../../infra/outbound/delivery-queue.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "../../infra/retry.js";
import { sleep } from "../../utils.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import { normalizeReplyPayload, type NormalizeReplySkipReason } from "./normalize-reply.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import type { TypingController } from "./typing.js";

export type ReplyDispatchKind = "tool" | "block" | "final";
export type ReplyDispatchResult =
  | { status: "sent"; kind: ReplyDispatchKind }
  | { status: "skipped"; kind: ReplyDispatchKind; reason: NormalizeReplySkipReason }
  | { status: "failed"; kind: ReplyDispatchKind; error: unknown };

type ReplyDispatchErrorHandler = (err: unknown, info: { kind: ReplyDispatchKind }) => void;

type ReplyDispatchSkipHandler = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind; reason: NormalizeReplySkipReason },
) => void;

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<void>;

type DurableReplyRoute = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  stateDir?: string;
};

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;
const DEFAULT_REPLY_DELIVERY_TIMEOUT_MS = 0;
const BLOCK_DELIVERY_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 5_000,
  jitter: 0.1,
};

const BLOCK_DELIVERY_TRANSIENT_ERRNO_CODES = new Set([
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_NETWORK",
]);

const BLOCK_DELIVERY_AMBIGUOUS_ERRNO_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_ABORTED",
]);

const BLOCK_DELIVERY_TRANSIENT_ERROR_RE =
  /429|408|5\d\d|rate limit|retry after|temporar|unavailable|fetch failed|try again/i;
const BLOCK_DELIVERY_AMBIGUOUS_ERROR_RE =
  /timeout|timed out|network|socket|connect|connection|reset|closed|hang up|premature|eof/i;

type ReplyDeliveryErrorClass = "permanent" | "transient-definitive" | "transient-ambiguous";

function classifyReplyDeliveryError(err: unknown, timeoutError?: Error): ReplyDeliveryErrorClass {
  if (timeoutError && err === timeoutError) {
    return "transient-ambiguous";
  }
  const message = formatErrorMessage(err);
  if (isPermanentDeliveryError(message)) {
    return "permanent";
  }
  const code = extractErrorCode(err)?.toUpperCase();
  if (code) {
    if (BLOCK_DELIVERY_AMBIGUOUS_ERRNO_CODES.has(code)) {
      return "transient-ambiguous";
    }
    if (BLOCK_DELIVERY_TRANSIENT_ERRNO_CODES.has(code)) {
      return "transient-definitive";
    }
  }
  if (BLOCK_DELIVERY_AMBIGUOUS_ERROR_RE.test(message)) {
    return "transient-ambiguous";
  }
  if (BLOCK_DELIVERY_TRANSIENT_ERROR_RE.test(message)) {
    return "transient-definitive";
  }
  return "permanent";
}

const withReplyDeliveryTimeout = async <T>(
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

/** Generate a random delay within the configured range. */
function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") {
    return 0;
  }
  const min =
    mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
  if (max <= min) {
    return min;
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  responsePrefix?: string;
  /** Static context for response prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
  /** Dynamic context provider for response prefix template interpolation.
   * Called at normalization time, after model selection is complete. */
  responsePrefixContextProvider?: () => ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  onIdle?: () => void;
  onError?: ReplyDispatchErrorHandler;
  // AIDEV-NOTE: onSkip lets channels detect silent/empty drops (e.g. Telegram empty-response fallback).
  onSkip?: ReplyDispatchSkipHandler;
  /** Human-like delay between block replies for natural rhythm. */
  humanDelay?: HumanDelayConfig;
  /** Retry policy for transient block-delivery failures in shared dispatch. */
  blockRetry?: RetryConfig;
  /** Optional hard timeout override for a single channel delivery attempt. */
  deliveryTimeoutMs?: number;
  /** Optional write-ahead queue route used for crash-safe reply delivery replay. */
  durableRoute?: DurableReplyRoute;
  /** Strip OPENCLAW_STOP_REASON marker lines before delivery. */
  stripStopReasonMarker?: boolean;
  /** Strip leaked plain-text tool-call drafts before delivery. */
  stripFailedToolCallDraft?: boolean;
};

export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  typingCallbacks?: TypingCallbacks;
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
  onCleanup?: () => void;
};

type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
  markDispatchIdle: () => void;
};

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  sendToolResultAsync: (payload: ReplyPayload) => Promise<ReplyDispatchResult>;
  sendBlockReplyAsync: (payload: ReplyPayload) => Promise<ReplyDispatchResult>;
  sendFinalReplyAsync: (payload: ReplyPayload) => Promise<ReplyDispatchResult>;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
};

type NormalizeReplyPayloadInternalOptions = Pick<
  ReplyDispatcherOptions,
  | "responsePrefix"
  | "responsePrefixContext"
  | "responsePrefixContextProvider"
  | "onHeartbeatStrip"
  | "stripStopReasonMarker"
  | "stripFailedToolCallDraft"
> & {
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

function normalizeReplyPayloadInternal(
  payload: ReplyPayload,
  opts: NormalizeReplyPayloadInternalOptions,
): ReplyPayload | null {
  // Prefer dynamic context provider over static context
  const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;

  return normalizeReplyPayload(payload, {
    responsePrefix: opts.responsePrefix,
    responsePrefixContext: prefixContext,
    onHeartbeatStrip: opts.onHeartbeatStrip,
    stripStopReasonMarker: opts.stripStopReasonMarker,
    stripFailedToolCallDraft: opts.stripFailedToolCallDraft,
    onSkip: opts.onSkip,
  });
}

export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  const blockRetryConfig = resolveRetryConfig(BLOCK_DELIVERY_RETRY_DEFAULTS, options.blockRetry);
  const deliveryTimeoutMs = Math.max(
    0,
    options.deliveryTimeoutMs ?? DEFAULT_REPLY_DELIVERY_TIMEOUT_MS,
  );
  let sendChain: Promise<void> = Promise.resolve();
  // Track in-flight deliveries so we can emit a reliable "idle" signal.
  // Start with pending=1 as a "reservation" to prevent premature gateway restart.
  // This is decremented when markComplete() is called to signal no more replies will come.
  let pending = 1;
  let completeCalled = false;
  // Track whether we've sent a block reply (for human delay - skip delay on first block).
  let sentFirstBlock = false;
  // Serialize outbound replies to preserve tool/block/final order.
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };

  // Register this dispatcher globally for gateway restart coordination.
  const { unregister } = registerDispatcher({
    pending: () => pending,
    waitForIdle: () => sendChain,
  });

  const enqueue = (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    onResult?: (result: ReplyDispatchResult) => void,
  ) => {
    let resultSettled = false;
    const settleResult = (result: ReplyDispatchResult) => {
      if (resultSettled) {
        return;
      }
      resultSettled = true;
      onResult?.(result);
    };
    const normalized = normalizeReplyPayloadInternal(payload, {
      responsePrefix: options.responsePrefix,
      responsePrefixContext: options.responsePrefixContext,
      responsePrefixContextProvider: options.responsePrefixContextProvider,
      onHeartbeatStrip: options.onHeartbeatStrip,
      stripStopReasonMarker: options.stripStopReasonMarker,
      stripFailedToolCallDraft: options.stripFailedToolCallDraft,
      onSkip: (reason) => {
        logVerbose(`reply-delivery status=skipped kind=${kind} reason=${reason}`);
        settleResult({ status: "skipped", kind, reason });
        options.onSkip?.(payload, { kind, reason });
      },
    });
    if (!normalized) {
      settleResult({ status: "skipped", kind, reason: "empty" });
      return false;
    }
    queuedCounts[kind] += 1;
    pending += 1;

    // Determine if we should add human-like delay (only for block replies after the first).
    const shouldDelay = kind === "block" && sentFirstBlock;
    if (kind === "block") {
      sentFirstBlock = true;
    }

    sendChain = sendChain
      .then(async () => {
        // Add human-like delay between block replies for natural rhythm.
        if (shouldDelay) {
          const delayMs = getHumanDelay(options.humanDelay);
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }
        const queueId = options.durableRoute
          ? await enqueueDelivery(
              {
                channel: options.durableRoute.channel,
                to: options.durableRoute.to,
                accountId: options.durableRoute.accountId,
                payloads: [normalized],
                threadId: options.durableRoute.threadId,
                replyToId: normalized.replyToId ?? options.durableRoute.replyToId ?? null,
                bestEffort: options.durableRoute.bestEffort,
                gifPlayback: options.durableRoute.gifPlayback,
                silent: options.durableRoute.silent,
              },
              options.durableRoute.stateDir,
            ).catch((err) => {
              logVerbose(
                `reply-delivery queue enqueue failed kind=${kind}: ${formatErrorMessage(err)}`,
              );
              return null;
            })
          : null;
        const timeoutError =
          deliveryTimeoutMs > 0
            ? new Error(`${kind} reply delivery timed out after ${deliveryTimeoutMs}ms`)
            : undefined;
        try {
          const maxDefinitiveRetries = Math.max(0, blockRetryConfig.attempts - 1);
          let definitiveRetriesUsed = 0;
          // Safe: deliver is called inside an async .then() callback, so even a synchronous
          // throw becomes a rejection that flows through .catch()/.finally(), ensuring cleanup.
          await retryAsync(
            () =>
              timeoutError
                ? withReplyDeliveryTimeout(
                    options.deliver(normalized, { kind }),
                    deliveryTimeoutMs,
                    timeoutError,
                  )
                : options.deliver(normalized, { kind }),
            {
              ...blockRetryConfig,
              attempts: blockRetryConfig.attempts,
              label: `${kind} reply delivery`,
              shouldRetry: (err) => {
                const classification = classifyReplyDeliveryError(err, timeoutError);
                if (classification === "permanent") {
                  return false;
                }
                if (classification === "transient-ambiguous") {
                  return false;
                }
                if (definitiveRetriesUsed >= maxDefinitiveRetries) {
                  return false;
                }
                definitiveRetriesUsed += 1;
                return true;
              },
              onRetry: (info) => {
                const maxRetries = Math.max(1, info.maxAttempts - 1);
                const classification = classifyReplyDeliveryError(info.err, timeoutError);
                logVerbose(
                  `${kind} reply delivery retry ${info.attempt}/${maxRetries} class=${classification} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
                );
              },
            },
          );
          if (queueId) {
            await markDeliveryDelivered(queueId, options.durableRoute?.stateDir).catch((err) => {
              logVerbose(
                `reply-delivery queue mark-delivered failed kind=${kind} id=${queueId}: ${formatErrorMessage(err)}`,
              );
            });
            await ackDelivery(queueId, options.durableRoute?.stateDir).catch((err) => {
              logVerbose(
                `reply-delivery queue ack failed kind=${kind} id=${queueId}: ${formatErrorMessage(err)}`,
              );
            });
          }
          logVerbose(`reply-delivery status=sent kind=${kind}`);
          settleResult({ status: "sent", kind });
        } catch (err) {
          const classification = classifyReplyDeliveryError(err, timeoutError);
          if (queueId) {
            const errorText = err instanceof Error ? err.message : String(err);
            if (classification === "transient-ambiguous") {
              await markDeliveryUncertain(queueId, errorText, options.durableRoute?.stateDir).catch(
                (queueErr) => {
                  logVerbose(
                    `reply-delivery queue uncertain-update failed kind=${kind} id=${queueId}: ${formatErrorMessage(queueErr)}`,
                  );
                },
              );
            } else {
              await failDelivery(queueId, errorText, options.durableRoute?.stateDir).catch(
                (queueErr) => {
                  logVerbose(
                    `reply-delivery queue fail-update failed kind=${kind} id=${queueId}: ${formatErrorMessage(queueErr)}`,
                  );
                },
              );
            }
          }
          settleResult({ status: "failed", kind, error: err });
          throw err;
        }
      })
      .catch((err) => {
        logVerbose(`reply-delivery status=failed kind=${kind} error=${formatErrorMessage(err)}`);
        options.onError?.(err, { kind });
      })
      .finally(() => {
        pending -= 1;
        // Clear reservation if:
        // 1. pending is now 1 (just the reservation left)
        // 2. markComplete has been called
        // 3. No more replies will be enqueued
        if (pending === 1 && completeCalled) {
          pending -= 1; // Clear the reservation
        }
        if (pending === 0) {
          // Unregister from global tracking when idle.
          unregister();
          options.onIdle?.();
        }
      });
    return true;
  };

  const enqueueAsync = (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
  ): Promise<ReplyDispatchResult> =>
    new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (result: ReplyDispatchResult) => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve(result);
      };
      const accepted = enqueue(kind, payload, resolveOnce);
      if (!accepted) {
        queueMicrotask(() => {
          if (!resolved) {
            resolveOnce({ status: "skipped", kind, reason: "empty" });
          }
        });
      }
    });

  const markComplete = () => {
    if (completeCalled) {
      return;
    }
    completeCalled = true;
    // If no replies were enqueued (pending is still 1 = just the reservation),
    // schedule clearing the reservation after current microtasks complete.
    // This gives any in-flight enqueue() calls a chance to increment pending.
    void Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        // Still just the reservation, no replies were enqueued
        pending -= 1;
        if (pending === 0) {
          unregister();
          options.onIdle?.();
        }
      }
    });
  };

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    sendToolResultAsync: (payload) => enqueueAsync("tool", payload),
    sendBlockReplyAsync: (payload) => enqueueAsync("block", payload),
    sendFinalReplyAsync: (payload) => enqueueAsync("final", payload),
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    markComplete,
  };
}

export function createReplyDispatcherWithTyping(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherWithTypingResult {
  const { typingCallbacks, onReplyStart, onIdle, onCleanup, ...dispatcherOptions } = options;
  const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
  const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
  const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
  let typingController: TypingController | undefined;
  const dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
  });

  return {
    dispatcher,
    replyOptions: {
      onReplyStart: resolvedOnReplyStart,
      onTypingCleanup: resolvedOnCleanup,
      onTypingController: (typing) => {
        typingController = typing;
      },
    },
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
  };
}
