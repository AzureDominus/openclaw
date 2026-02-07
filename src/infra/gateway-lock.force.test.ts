import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { forceReleaseGatewayLockAndWait } from "./gateway-lock.js";

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-lock-"));
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  await fs.mkdir(resolveGatewayLockDir(), { recursive: true });
  return {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_CONFIG_PATH: configPath,
    },
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha1").update(configPath).digest("hex").slice(0, 8);
  const lockDir = resolveGatewayLockDir();
  return { lockPath: path.join(lockDir, `gateway.${hash}.lock`), configPath };
}

describe("forceReleaseGatewayLockAndWait", () => {
  let originalKill: typeof process.kill;

  afterEach(() => {
    if (originalKill) {
      process.kill = originalKill;
    }
  });

  it("kills alive owner and removes lock", async () => {
    const { env, cleanup } = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const ownerPid = 4242;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: ownerPid, createdAt: new Date().toISOString(), configPath }),
      "utf8",
    );

    originalKill = process.kill.bind(process);
    let alive = true;
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      expect(pid).toBe(ownerPid);
      if (signal === 0) {
        if (alive) {
          return true as never;
        }
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        alive = false;
        return true as never;
      }
      return true as never;
    });
    // @ts-expect-error override for test
    process.kill = killMock;

    const res = await forceReleaseGatewayLockAndWait({
      env,
      platform: "darwin",
      timeoutMs: 500,
      intervalMs: 50,
      sigtermTimeoutMs: 200,
    });

    expect(res.removedLock).toBe(true);
    expect(res.ownerPid).toBe(ownerPid);
    expect(killMock).toHaveBeenCalledWith(ownerPid, "SIGTERM");
    await expect(fs.stat(lockPath)).rejects.toBeTruthy();

    await cleanup();
  });

  it("removes lock when owner already dead", async () => {
    const { env, cleanup } = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const ownerPid = 4243;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: ownerPid, createdAt: new Date().toISOString(), configPath }),
      "utf8",
    );

    originalKill = process.kill.bind(process);
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      expect(pid).toBe(ownerPid);
      if (signal === 0) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true as never;
    });
    // @ts-expect-error override for test
    process.kill = killMock;

    const res = await forceReleaseGatewayLockAndWait({
      env,
      platform: "darwin",
      timeoutMs: 200,
      intervalMs: 50,
      sigtermTimeoutMs: 100,
    });

    expect(res.removedLock).toBe(true);
    expect(res.ownerPid).toBe(ownerPid);
    expect(killMock).not.toHaveBeenCalledWith(ownerPid, "SIGTERM");
    await expect(fs.stat(lockPath)).rejects.toBeTruthy();

    await cleanup();
  });
});
