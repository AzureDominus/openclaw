import type { FollowupRun } from "./types.js";
import { defaultRuntime } from "../../../runtime.js";
import { buildQueueSummaryPrompt, waitForQueueDebounce } from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES } from "./state.js";

function previewQueueSummaryPrompt(queue: {
  dropPolicy: "summarize" | "old" | "new";
  droppedCount: number;
  summaryLines: string[];
}): string | undefined {
  return buildQueueSummaryPrompt({
    state: {
      dropPolicy: queue.dropPolicy,
      droppedCount: queue.droppedCount,
      summaryLines: [...queue.summaryLines],
    },
    noun: "message",
  });
}

function clearQueueSummaryState(queue: { droppedCount: number; summaryLines: string[] }): void {
  queue.droppedCount = 0;
  queue.summaryLines = [];
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = FOLLOWUP_QUEUES.get(key);
  if (!queue || queue.draining) {
    return;
  }
  queue.draining = true;
  void (async () => {
    try {
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        const summaryPrompt = previewQueueSummaryPrompt(queue);
        const firstItem = queue.items[0];
        if (!firstItem) {
          if (summaryPrompt && queue.lastRun) {
            await runFollowup({
              prompt: summaryPrompt,
              run: queue.lastRun,
              enqueuedAt: Date.now(),
            });
            clearQueueSummaryState(queue);
            continue;
          }
          break;
        }

        const keyedItems = queue.items.map((item, index) => {
          const channel = item.originatingChannel;
          const to = item.originatingTo;
          const accountId = item.originatingAccountId;
          const threadId = item.originatingThreadId;
          if (!channel && !to && !accountId && threadId == null) {
            return { item, key: "" };
          }
          if (!isRoutableChannel(channel) || !to) {
            return { item, key: `unsafe:${index}` };
          }
          const threadKey = threadId != null ? String(threadId) : "";
          return {
            item,
            key: [channel, to, accountId || "", threadKey].join("|"),
          };
        });

        const firstKey = keyedItems[0]?.key;
        if (firstKey === undefined) {
          break;
        }
        const items = keyedItems
          .filter((entry) => entry.key === firstKey)
          .map((entry) => entry.item);
        if (items.length === 0) {
          break;
        }

        const run = items.at(-1)?.run ?? queue.lastRun;
        if (!run) {
          break;
        }

        const joinedPrompts = items
          .map((item) => item.prompt.trim())
          .filter((text) => text.length > 0)
          .join("\n\n");
        const prompt = [summaryPrompt, joinedPrompts].filter(Boolean).join("\n\n").trim();

        const remainingItems = keyedItems
          .filter((entry) => entry.key !== firstKey)
          .map((entry) => entry.item);

        if (!prompt) {
          queue.items = remainingItems;
          if (summaryPrompt) {
            clearQueueSummaryState(queue);
          }
          continue;
        }

        const originatingChannel = items.find((i) => i.originatingChannel)?.originatingChannel;
        const originatingTo = items.find((i) => i.originatingTo)?.originatingTo;
        const originatingAccountId = items.find(
          (i) => i.originatingAccountId,
        )?.originatingAccountId;
        const originatingThreadId = items.find(
          (i) => i.originatingThreadId != null,
        )?.originatingThreadId;

        await runFollowup({
          prompt,
          run,
          enqueuedAt: Date.now(),
          originatingChannel,
          originatingTo,
          originatingAccountId,
          originatingThreadId,
        });
        queue.items = remainingItems;
        if (summaryPrompt) {
          clearQueueSummaryState(queue);
        }

        if (summaryPrompt && queue.items.length === 0 && queue.droppedCount > 0) {
          clearQueueSummaryState(queue);
        }
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
      defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(key);
      } else {
        scheduleFollowupDrain(key, runFollowup);
      }
    }
  })();
}
