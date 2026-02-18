import type { QueueDropPolicy, QueueMode } from "./types.js";

export function normalizeQueueMode(raw?: string): QueueMode | undefined {
  if (!raw) {
    return undefined;
  }
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "steer" || cleaned === "steering") {
    return "steer";
  }
  if (
    cleaned === "queue" ||
    cleaned === "queued" ||
    cleaned === "followup" ||
    cleaned === "follow-ups" ||
    cleaned === "followups" ||
    cleaned === "collect" ||
    cleaned === "coalesce" ||
    cleaned === "interrupt" ||
    cleaned === "interrupts" ||
    cleaned === "abort" ||
    cleaned === "steer+backlog" ||
    cleaned === "steer-backlog" ||
    cleaned === "steer_backlog"
  ) {
    return "queue";
  }
  return undefined;
}

export function normalizeQueueDropPolicy(raw?: string): QueueDropPolicy | undefined {
  if (!raw) {
    return undefined;
  }
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "old" || cleaned === "oldest") {
    return "old";
  }
  if (cleaned === "new" || cleaned === "newest") {
    return "new";
  }
  if (cleaned === "summarize" || cleaned === "summary") {
    return "summarize";
  }
  return undefined;
}
