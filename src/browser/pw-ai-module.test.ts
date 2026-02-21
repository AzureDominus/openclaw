import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test, getPwAiModule } from "./pw-ai-module.js";

const fakePwModule = { __tag: "pw-ai" } as unknown as typeof import("./pw-ai.js");

describe("pw-ai module loading", () => {
  beforeEach(() => {
    __test.reset();
  });

  afterEach(() => {
    __test.reset();
  });

  it("retries soft-mode loading after transient module-not-found failures", async () => {
    let attempts = 0;
    __test.setLoader(async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("Cannot find module './pw-ai.js'") as Error & { code?: string };
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      }
      return fakePwModule;
    });

    expect(await getPwAiModule()).toBeNull();
    expect(await getPwAiModule()).toBe(fakePwModule);
    expect(attempts).toBe(2);
  });

  it("does not cache strict-mode runtime failures", async () => {
    let attempts = 0;
    __test.setLoader(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("boom");
      }
      return fakePwModule;
    });

    await expect(getPwAiModule({ mode: "strict" })).rejects.toThrow("boom");
    expect(await getPwAiModule({ mode: "strict" })).toBe(fakePwModule);
    expect(attempts).toBe(2);
  });

  it("reuses the cached module after a successful load", async () => {
    let attempts = 0;
    __test.setLoader(async () => {
      attempts += 1;
      return fakePwModule;
    });

    expect(await getPwAiModule()).toBe(fakePwModule);
    expect(await getPwAiModule({ mode: "strict" })).toBe(fakePwModule);
    expect(attempts).toBe(1);
  });
});
