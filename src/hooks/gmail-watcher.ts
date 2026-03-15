import type { OpenClawConfig } from "../config/config.js";

const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;
const GMAIL_WATCHER_REMOVED_REASON =
  "Gmail Pub/Sub watcher removed; use an external ingestor to POST to /hooks/gmail";

export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}

export type GmailWatcherStartResult = {
  started: boolean;
  reason?: string;
};

export async function startGmailWatcher(cfg: OpenClawConfig): Promise<GmailWatcherStartResult> {
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }
  return { started: false, reason: GMAIL_WATCHER_REMOVED_REASON };
}

export async function stopGmailWatcher(): Promise<void> {
  return Promise.resolve();
}

export function isGmailWatcherRunning(): boolean {
  return false;
}
