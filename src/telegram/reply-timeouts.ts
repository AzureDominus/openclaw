import type { TelegramAccountConfig } from "../config/types.js";

export function resolveTelegramBlockReplyTimeoutMs(config: TelegramAccountConfig): number {
  const timeoutSeconds =
    typeof config.timeoutSeconds === "number" && Number.isFinite(config.timeoutSeconds)
      ? Math.max(1, Math.floor(config.timeoutSeconds))
      : 0;
  return timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
}
