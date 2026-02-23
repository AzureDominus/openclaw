import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { extractErrorCode, formatErrorMessage } from "../../infra/errors.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "../../infra/outbound/delivery-queue.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "../../infra/retry.js";
import { sleep } from "../../utils.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import { normalizeReplyPayload, type NormalizeReplySkipReason } from "./normalize-reply.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import type { TypingController } from "./typing.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

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
const BLOCK_DELIVERY_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 5_000,
  jitter: 0.1,
};

const BLOCK_DELIVERY_TRANSIENT_ERRNO_CODES = new Set([
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

const BLOCK_DELIVERY_TRANSIENT_ERROR_RE =
  /429|408|5\d\d|rate limit|retry after|timeout|timed out|network|socket|connect|connection|reset|closed|temporar|unavailable|fetch failed|try again/i;

function shouldRetryBlockDelivery(err: unknown): boolean {
  const code = extractErrorCode(err)?.toUpperCase();
  if (code && BLOCK_DELIVERY_TRANSIENT_ERRNO_CODES.has(code)) {
    return true;
  }
  return BLOCK_DELIVERY_TRANSIENT_ERROR_RE.test(formatErrorMessage(err));
}

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

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const normalized = normalizeReplyPayloadInternal(payload, {
      responsePrefix: options.responsePrefix,
      responsePrefixContext: options.responsePrefixContext,
      responsePrefixContextProvider: options.responsePrefixContextProvider,
      onHeartbeatStrip: options.onHeartbeatStrip,
      stripStopReasonMarker: options.stripStopReasonMarker,
      stripFailedToolCallDraft: options.stripFailedToolCallDraft,
      onSkip: (reason) => {
        logVerbose(`reply-delivery status=skipped kind=${kind} reason=${reason}`);
        options.onSkip?.(payload, { kind, reason });
      },
    });
    if (!normalized) {
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
        try {
          // Safe: deliver is called inside an async .then() callback, so even a synchronous
          // throw becomes a rejection that flows through .catch()/.finally(), ensuring cleanup.
          await retryAsync(() => options.deliver(normalized, { kind }), {
            ...blockRetryConfig,
            label: `${kind} reply delivery`,
            shouldRetry: (err) => shouldRetryBlockDelivery(err),
            onRetry: (info) => {
              const maxRetries = Math.max(1, info.maxAttempts - 1);
              logVerbose(
                `${kind} reply delivery retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
              );
            },
          });
          if (queueId) {
            await ackDelivery(queueId, options.durableRoute?.stateDir).catch((err) => {
              logVerbose(
                `reply-delivery queue ack failed kind=${kind} id=${queueId}: ${formatErrorMessage(err)}`,
              );
            });
          }
          logVerbose(`reply-delivery status=sent kind=${kind}`);
        } catch (err) {
          if (queueId) {
            await failDelivery(
              queueId,
              err instanceof Error ? err.message : String(err),
              options.durableRoute?.stateDir,
            ).catch((queueErr) => {
              logVerbose(
                `reply-delivery queue fail-update failed kind=${kind} id=${queueId}: ${formatErrorMessage(queueErr)}`,
              );
            });
          }
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
