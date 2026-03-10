import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const UNCERTAIN_DIRNAME = "uncertain";
const DEFAULT_SCAN_MAX_IDLE_MS = 5_000;

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];

type DeliveryMirrorPayload = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
};

type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirrorPayload;
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  routeKey: string;
  enqueuedAt: number;
  /** Absolute timestamp when this entry is eligible for retry. */
  nextAttemptAt?: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  claimedAt?: number;
  claimedByPid?: number;
}

export type RecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
  uncertain: number;
};

export type DeliverFn = (
  params: {
    cfg: OpenClawConfig;
  } & QueuedDeliveryPayload & {
      skipQueue?: boolean;
    },
) => Promise<unknown>;

export type SendTypingFn = (
  params: {
    cfg: OpenClawConfig;
  } & Pick<QueuedDeliveryPayload, "channel" | "to" | "accountId" | "threadId" | "silent">,
) => Promise<void>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type DeliveryRetryService = {
  stop: () => Promise<void>;
};

function resolveQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function resolveFailedDir(stateDir?: string): string {
  return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}

function resolveUncertainDir(stateDir?: string): string {
  return path.join(resolveQueueDir(stateDir), UNCERTAIN_DIRNAME);
}

function resolveQueueEntryPaths(
  id: string,
  stateDir?: string,
): {
  jsonPath: string;
  sendingPath: string;
  deliveredPath: string;
  failedPath: string;
  uncertainPath: string;
} {
  const queueDir = resolveQueueDir(stateDir);
  return {
    jsonPath: path.join(queueDir, `${id}.json`),
    sendingPath: path.join(queueDir, `${id}.sending`),
    deliveredPath: path.join(queueDir, `${id}.delivered`),
    failedPath: path.join(resolveFailedDir(stateDir), `${id}.json`),
    uncertainPath: path.join(resolveUncertainDir(stateDir), `${id}.sending`),
  };
}

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

function buildRouteKey(
  params: Pick<QueuedDeliveryPayload, "channel" | "to" | "accountId" | "threadId">,
) {
  const threadId =
    params.threadId == null || params.threadId === "" ? "" : String(params.threadId).trim();
  const accountId = params.accountId?.trim() ?? "";
  return `${params.channel}:${accountId}:${params.to}:${threadId}`;
}

async function unlinkBestEffort(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

async function loadEntryFromPath(filePath: string): Promise<QueuedDelivery> {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as QueuedDelivery;
  return normalizeQueuedDeliveryEntry(parsed).entry;
}

async function writeEntryToPath(filePath: string, entry: QueuedDelivery): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeQueuedDeliveryEntry(entry: QueuedDelivery): {
  entry: QueuedDelivery;
  migrated: boolean;
} {
  let migrated = false;
  let next = entry;
  if (!entry.routeKey) {
    next = {
      ...next,
      routeKey: buildRouteKey(next),
    };
    migrated = true;
  }
  const hasAttemptTimestamp = isFinitePositive(next.lastAttemptAt);
  if (!hasAttemptTimestamp && next.retryCount > 0 && isFinitePositive(next.enqueuedAt)) {
    next = {
      ...next,
      lastAttemptAt: next.enqueuedAt,
    };
    migrated = true;
  }
  return { entry: next, migrated };
}

async function cleanupDeliveredMarkers(queueDir: string): Promise<void> {
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return;
    }
    throw err;
  }
  await Promise.all(
    files
      .filter((file) => file.endsWith(".delivered"))
      .map(async (file) => await unlinkBestEffort(path.join(queueDir, file))),
  );
}

async function moveStaleSendingEntriesToUncertain(opts: {
  log?: RecoveryLogger;
  stateDir?: string;
}): Promise<number> {
  const queueDir = resolveQueueDir(opts.stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return 0;
    }
    throw err;
  }
  const sendingFiles = files.filter((file) => file.endsWith(".sending"));
  if (sendingFiles.length === 0) {
    return 0;
  }
  await fs.promises.mkdir(resolveUncertainDir(opts.stateDir), { recursive: true, mode: 0o700 });
  let moved = 0;
  for (const file of sendingFiles) {
    const src = path.join(queueDir, file);
    const dest = path.join(resolveUncertainDir(opts.stateDir), file);
    try {
      await fs.promises.rename(src, dest);
      moved += 1;
      opts.log?.warn(
        `Delivery ${file.replace(/\\.sending$/, "")} was in-flight during restart — moved to uncertain/`,
      );
    } catch (err) {
      if (getErrnoCode(err) === "ENOENT") {
        continue;
      }
      opts.log?.error(
        `Failed moving stale in-flight delivery ${file} to uncertain/: ${String(err)}`,
      );
    }
  }
  return moved;
}

function groupRouteHeads(entries: QueuedDelivery[]): QueuedDelivery[] {
  const heads = new Map<string, QueuedDelivery>();
  for (const entry of entries) {
    const current = heads.get(entry.routeKey);
    if (!current || entry.enqueuedAt < current.enqueuedAt) {
      heads.set(entry.routeKey, entry);
    }
  }
  return [...heads.values()].toSorted((a, b) => {
    const aNext = a.nextAttemptAt ?? a.enqueuedAt;
    const bNext = b.nextAttemptAt ?? b.enqueuedAt;
    return aNext - bNext || a.enqueuedAt - b.enqueuedAt;
  });
}

function selectReadyRouteHead(
  entries: QueuedDelivery[],
  now: number,
): {
  ready: QueuedDelivery | null;
  minSleepMs: number;
} {
  const routeHeads = groupRouteHeads(entries);
  let minSleepMs = DEFAULT_SCAN_MAX_IDLE_MS;
  for (const entry of routeHeads) {
    const eligibility = isEntryEligibleForRecoveryRetry(entry, now);
    if (eligibility.eligible) {
      return { ready: entry, minSleepMs: 0 };
    }
    minSleepMs = Math.min(minSleepMs, Math.max(1, Math.trunc(eligibility.remainingBackoffMs)));
  }
  return { ready: null, minSleepMs };
}

/** Ensure the queue directory (and failed/uncertain subdirectories) exist. */
export async function ensureQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveUncertainDir(stateDir), { recursive: true, mode: 0o700 });
  return queueDir;
}

/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
type QueuedDeliveryParams = QueuedDeliveryPayload;

export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureQueueDir(stateDir);
  const id = generateSecureUuid();
  const entry: QueuedDelivery = {
    id,
    routeKey: buildRouteKey(params),
    enqueuedAt: Date.now(),
    nextAttemptAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: params.payloads,
    threadId: params.threadId,
    replyToId: params.replyToId,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    silent: params.silent,
    mirror: params.mirror,
    retryCount: 0,
  };
  await writeEntryToPath(path.join(queueDir, `${id}.json`), entry);
  return id;
}

export async function claimDelivery(id: string, stateDir?: string): Promise<QueuedDelivery | null> {
  const { jsonPath, sendingPath } = resolveQueueEntryPaths(id, stateDir);
  try {
    await fs.promises.rename(jsonPath, sendingPath);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  }
  const entry = await loadEntryFromPath(sendingPath);
  const claimed: QueuedDelivery = {
    ...entry,
    claimedAt: Date.now(),
    claimedByPid: process.pid,
  };
  await writeEntryToPath(sendingPath, claimed);
  return claimed;
}

/** Remove a successfully delivered entry from the queue. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  const { jsonPath, sendingPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
  for (const source of [sendingPath, jsonPath]) {
    try {
      await fs.promises.rename(source, deliveredPath);
      await unlinkBestEffort(deliveredPath);
      return;
    } catch (err) {
      if (getErrnoCode(err) === "ENOENT") {
        continue;
      }
      throw err;
    }
  }
  await unlinkBestEffort(deliveredPath);
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const { jsonPath, sendingPath } = resolveQueueEntryPaths(id, stateDir);
  const sourcePath = fs.existsSync(sendingPath) ? sendingPath : jsonPath;
  const raw = await fs.promises.readFile(sourcePath, "utf-8");
  const entry = normalizeQueuedDeliveryEntry(JSON.parse(raw) as QueuedDelivery).entry;
  const nextEntry: QueuedDelivery = {
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
    nextAttemptAt: Date.now() + computeBackoffMs(entry.retryCount + 1),
  };
  delete nextEntry.claimedAt;
  delete nextEntry.claimedByPid;
  await writeEntryToPath(sourcePath, nextEntry);
  if (sourcePath === sendingPath) {
    await fs.promises.rename(sendingPath, jsonPath);
  }
}

/** Load all pending delivery entries from the queue directory. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const queueDir = resolveQueueDir(stateDir);
  await cleanupDeliveredMarkers(queueDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const entries: QueuedDelivery[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as QueuedDelivery;
      const { entry, migrated } = normalizeQueuedDeliveryEntry(parsed);
      if (migrated) {
        await writeEntryToPath(filePath, entry);
      }
      entries.push(entry);
    } catch {
      // Skip malformed or inaccessible entries.
    }
  }
  return entries;
}

/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const { jsonPath, sendingPath, failedPath } = resolveQueueEntryPaths(id, stateDir);
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  for (const source of [sendingPath, jsonPath]) {
    try {
      await fs.promises.rename(source, failedPath);
      return;
    } catch (err) {
      if (getErrnoCode(err) === "ENOENT") {
        continue;
      }
      throw err;
    }
  }
}

/** Compute the backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

export function isEntryEligibleForRecoveryRetry(
  entry: QueuedDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  if (typeof entry.nextAttemptAt === "number" && Number.isFinite(entry.nextAttemptAt)) {
    const remainingBackoffMs = Math.max(0, Math.trunc(entry.nextAttemptAt - now));
    return remainingBackoffMs > 0 ? { eligible: false, remainingBackoffMs } : { eligible: true };
  }
  const backoff = computeBackoffMs(entry.retryCount + 1);
  if (backoff <= 0) {
    return { eligible: true };
  }
  const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
  if (firstReplayAfterCrash) {
    return { eligible: true };
  }
  const hasAttemptTimestamp = isFinitePositive(entry.lastAttemptAt);
  const baseAttemptAt = hasAttemptTimestamp ? entry.lastAttemptAt! : entry.enqueuedAt;
  const nextEligibleAt = baseAttemptAt + backoff;
  if (now >= nextEligibleAt) {
    return { eligible: true };
  }
  return { eligible: false, remainingBackoffMs: nextEligibleAt - now };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function processDeliveryEntry(opts: {
  entry: QueuedDelivery;
  deliver: DeliverFn;
  sendTyping?: SendTypingFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
}): Promise<"recovered" | "failed" | "deferred"> {
  const claimed = await claimDelivery(opts.entry.id, opts.stateDir);
  if (!claimed) {
    return "deferred";
  }

  try {
    try {
      await opts.sendTyping?.({
        cfg: opts.cfg,
        channel: claimed.channel,
        to: claimed.to,
        accountId: claimed.accountId,
        threadId: claimed.threadId,
        silent: claimed.silent,
      });
    } catch (err) {
      opts.log.warn(`Replay typing failed for delivery ${claimed.id}: ${String(err)}`);
    }

    await opts.deliver({
      cfg: opts.cfg,
      channel: claimed.channel,
      to: claimed.to,
      accountId: claimed.accountId,
      payloads: claimed.payloads,
      threadId: claimed.threadId,
      replyToId: claimed.replyToId,
      bestEffort: claimed.bestEffort,
      gifPlayback: claimed.gifPlayback,
      silent: claimed.silent,
      mirror: claimed.mirror,
      skipQueue: true,
    });
    await ackDelivery(claimed.id, opts.stateDir);
    opts.log.info(`Recovered delivery ${claimed.id} to ${claimed.channel}:${claimed.to}`);
    return "recovered";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isPermanentDeliveryError(errMsg)) {
      opts.log.warn(`Delivery ${claimed.id} hit permanent error — moving to failed/: ${errMsg}`);
      try {
        await moveToFailed(claimed.id, opts.stateDir);
      } catch (moveErr) {
        opts.log.error(`Failed to move entry ${claimed.id} to failed/: ${String(moveErr)}`);
      }
      return "failed";
    }
    try {
      await failDelivery(claimed.id, errMsg, opts.stateDir);
    } catch (queueErr) {
      opts.log.error(`Failed updating retry state for ${claimed.id}: ${String(queueErr)}`);
    }
    opts.log.warn(`Retry failed for delivery ${claimed.id}: ${errMsg}`);
    return "failed";
  }
}

/**
 * One-shot sweep used by tests and startup compatibility paths.
 * Live gateway retry uses startDeliveryRetryService().
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  sendTyping?: SendTypingFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to the live worker. Default: 60 000. */
  maxRecoveryMs?: number;
}): Promise<RecoverySummary> {
  await ensureQueueDir(opts.stateDir);
  const uncertain = await moveStaleSendingEntriesToUncertain(opts);
  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);
  let recovered = 0;
  let failed = 0;
  let deferredBackoff = 0;

  while (Date.now() < deadline) {
    const pending = await loadPendingDeliveries(opts.stateDir);
    if (pending.length === 0) {
      break;
    }
    const { ready } = selectReadyRouteHead(pending, Date.now());
    if (!ready) {
      deferredBackoff = groupRouteHeads(pending).length;
      break;
    }
    const outcome = await processDeliveryEntry({
      entry: ready,
      deliver: opts.deliver,
      sendTyping: opts.sendTyping,
      log: opts.log,
      cfg: opts.cfg,
      stateDir: opts.stateDir,
    });
    if (outcome === "recovered") {
      recovered += 1;
    } else if (outcome === "failed") {
      failed += 1;
    }
  }

  return { recovered, failed, skippedMaxRetries: 0, deferredBackoff, uncertain };
}

export function startDeliveryRetryService(opts: {
  deliver: DeliverFn;
  sendTyping?: SendTypingFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  maxIdleMs?: number;
}): DeliveryRetryService {
  let stopped = false;
  const loop = (async () => {
    await ensureQueueDir(opts.stateDir);
    await moveStaleSendingEntriesToUncertain(opts);
    while (!stopped) {
      try {
        const pending = await loadPendingDeliveries(opts.stateDir);
        if (pending.length === 0) {
          await sleep(opts.maxIdleMs ?? DEFAULT_SCAN_MAX_IDLE_MS);
          continue;
        }
        const { ready, minSleepMs } = selectReadyRouteHead(pending, Date.now());
        if (!ready) {
          await sleep(Math.min(opts.maxIdleMs ?? DEFAULT_SCAN_MAX_IDLE_MS, minSleepMs));
          continue;
        }
        await processDeliveryEntry({
          entry: ready,
          deliver: opts.deliver,
          sendTyping: opts.sendTyping,
          log: opts.log,
          cfg: opts.cfg,
          stateDir: opts.stateDir,
        });
      } catch (err) {
        opts.log.error(`Delivery retry worker loop failed: ${String(err)}`);
        await sleep(opts.maxIdleMs ?? DEFAULT_SCAN_MAX_IDLE_MS);
      }
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      await loop.catch(() => {});
    },
  };
}

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous discord recipient/i,
];

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
