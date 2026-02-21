import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";

export type PwAiModule = typeof import("./pw-ai.js");

type PwAiLoadMode = "soft" | "strict";

let cachedPwAiModule: PwAiModule | null = null;
let pwAiModuleSoftInflight: Promise<PwAiModule | null> | null = null;
let pwAiModuleStrictInflight: Promise<PwAiModule | null> | null = null;
let pwAiModuleLoader: () => Promise<PwAiModule> = async () => await import("./pw-ai.js");

function isModuleNotFoundError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code === "ERR_MODULE_NOT_FOUND") {
    return true;
  }
  const msg = formatErrorMessage(err);
  return (
    msg.includes("Cannot find module") ||
    msg.includes("Cannot find package") ||
    msg.includes("Failed to resolve import") ||
    msg.includes("Failed to resolve entry for package") ||
    msg.includes("Failed to load url")
  );
}

async function loadPwAiModule(mode: PwAiLoadMode): Promise<PwAiModule | null> {
  try {
    return await pwAiModuleLoader();
  } catch (err) {
    if (mode === "soft") {
      return null;
    }
    if (isModuleNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

export async function getPwAiModule(opts?: { mode?: PwAiLoadMode }): Promise<PwAiModule | null> {
  if (cachedPwAiModule) {
    return cachedPwAiModule;
  }

  const mode: PwAiLoadMode = opts?.mode ?? "soft";
  if (mode === "soft") {
    if (!pwAiModuleSoftInflight) {
      pwAiModuleSoftInflight = loadPwAiModule("soft")
        .then((mod) => {
          if (mod) {
            cachedPwAiModule = mod;
          }
          return mod;
        })
        .finally(() => {
          pwAiModuleSoftInflight = null;
        });
    }
    return await pwAiModuleSoftInflight;
  }
  if (!pwAiModuleStrictInflight) {
    pwAiModuleStrictInflight = loadPwAiModule("strict")
      .then((mod) => {
        if (mod) {
          cachedPwAiModule = mod;
        }
        return mod;
      })
      .finally(() => {
        pwAiModuleStrictInflight = null;
      });
  }
  return await pwAiModuleStrictInflight;
}

function resetPwAiModuleState() {
  cachedPwAiModule = null;
  pwAiModuleSoftInflight = null;
  pwAiModuleStrictInflight = null;
}

export const __test = {
  setLoader(loader: () => Promise<PwAiModule>) {
    pwAiModuleLoader = loader;
  },
  reset() {
    resetPwAiModuleState();
    pwAiModuleLoader = async () => await import("./pw-ai.js");
  },
};
