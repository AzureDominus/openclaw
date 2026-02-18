import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";
import { applyQueueDropPolicy } from "../../../utils/queue-helpers.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";

function findQueuedRunIndex(
  run: FollowupRun,
  items: FollowupRun[],
  allowPromptFallback = false,
): number {
  const hasSameRouting = (item: FollowupRun) =>
    item.originatingChannel === run.originatingChannel &&
    item.originatingTo === run.originatingTo &&
    item.originatingAccountId === run.originatingAccountId &&
    item.originatingThreadId === run.originatingThreadId;

  const messageId = run.messageId?.trim();
  if (messageId) {
    return items.findIndex((item) => item.messageId?.trim() === messageId && hasSameRouting(item));
  }
  if (!allowPromptFallback) {
    return -1;
  }
  return items.findIndex((item) => item.prompt === run.prompt && hasSameRouting(item));
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): boolean {
  const queue = getFollowupQueue(key, settings);
  const existingIndex =
    dedupeMode === "none" ? -1 : findQueuedRunIndex(run, queue.items, dedupeMode === "prompt");

  // Upsert edits by provider message id so queued content stays fresh.
  if (existingIndex >= 0) {
    const existing = queue.items[existingIndex];
    queue.items[existingIndex] = {
      ...existing,
      ...run,
      enqueuedAt: existing?.enqueuedAt ?? run.enqueuedAt,
    };
    queue.lastEnqueuedAt = Date.now();
    queue.lastRun = run.run;
    return true;
  }

  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;

  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) {
    return false;
  }

  queue.items.push(run);
  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const cleaned = key.trim();
  if (!cleaned) {
    return 0;
  }
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) {
    return 0;
  }
  return queue.items.length;
}
