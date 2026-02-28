import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const queueMocks = vi.hoisted(() => ({
  recoverPendingDeliveries: vi.fn(async () => ({ recovered: 0, failed: 0, skipped: 0 })),
}));

vi.mock("./delivery-queue.js", () => ({
  recoverPendingDeliveries: queueMocks.recoverPendingDeliveries,
}));

import { createDeliveryRecoveryLoop } from "./delivery-recovery-loop.js";

describe("createDeliveryRecoveryLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queueMocks.recoverPendingDeliveries.mockClear();
    queueMocks.recoverPendingDeliveries.mockResolvedValue({
      recovered: 0,
      failed: 0,
      skipped: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs startup recovery immediately and repeats on interval", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const loop = createDeliveryRecoveryLoop({
      deliver: vi.fn(async () => []),
      log,
      cfg: {} as OpenClawConfig,
      intervalMs: 1_000,
      maxRecoveryMs: 2_000,
    });

    loop.start();
    await Promise.resolve();
    expect(queueMocks.recoverPendingDeliveries).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queueMocks.recoverPendingDeliveries).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("does not run overlapping recoveries while one is in-flight", async () => {
    let release: (() => void) | null = null;
    const slowRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    queueMocks.recoverPendingDeliveries.mockImplementation(async () => {
      await slowRun;
      return { recovered: 0, failed: 0, skipped: 0 };
    });

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const loop = createDeliveryRecoveryLoop({
      deliver: vi.fn(async () => []),
      log,
      cfg: {} as OpenClawConfig,
      intervalMs: 1_000,
      maxRecoveryMs: 2_000,
    });

    loop.start();
    await Promise.resolve();
    expect(queueMocks.recoverPendingDeliveries).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(queueMocks.recoverPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Delivery recovery already running"),
    );

    release?.();
    await Promise.resolve();
    await loop.stop();
  });
});
