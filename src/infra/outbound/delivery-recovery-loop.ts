import type { OpenClawConfig } from "../../config/config.js";
import { recoverPendingDeliveries, type DeliverFn, type RecoveryLogger } from "./delivery-queue.js";

const DEFAULT_RECOVERY_INTERVAL_MS = 10_000;
const DEFAULT_RECOVERY_BUDGET_MS = 8_000;

export type DeliveryRecoveryLoop = {
  start: () => void;
  runNow: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
};

export function createDeliveryRecoveryLoop(params: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  intervalMs?: number;
  maxRecoveryMs?: number;
}): DeliveryRecoveryLoop {
  const intervalMs = Math.max(1_000, params.intervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS);
  const maxRecoveryMs = Math.max(1_000, params.maxRecoveryMs ?? DEFAULT_RECOVERY_BUDGET_MS);
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const run = async (trigger: "startup" | "interval" | "manual"): Promise<void> => {
    if (stopped) {
      return;
    }
    if (inFlight) {
      params.log.info(`Delivery recovery already running; skip trigger=${trigger}`);
      await inFlight;
      return;
    }
    inFlight = (async () => {
      try {
        const result = await recoverPendingDeliveries({
          deliver: params.deliver,
          log: params.log,
          cfg: params.cfg,
          stateDir: params.stateDir,
          maxRecoveryMs,
        });
        if (result.recovered > 0 || result.failed > 0 || result.skipped > 0) {
          params.log.info(
            `Delivery recovery trigger=${trigger} recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
          );
        }
      } catch (err) {
        params.log.error(`Delivery recovery trigger=${trigger} failed: ${String(err)}`);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };

  return {
    start: () => {
      if (timer || stopped) {
        return;
      }
      void run("startup");
      timer = setInterval(() => {
        void run("interval");
      }, intervalMs);
    },
    runNow: async () => {
      await run("manual");
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await inFlight;
    },
    isRunning: () => inFlight !== null,
  };
}
