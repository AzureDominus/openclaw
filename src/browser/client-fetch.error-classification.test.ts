import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dispatch = vi.fn(async () => ({ status: 200, body: { ok: true } }));
  return {
    dispatch,
    loadConfig: vi.fn(() => ({})),
    createBrowserControlContext: vi.fn(() => ({})),
    createBrowserRouteDispatcher: vi.fn(() => ({ dispatch })),
    startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: mocks.createBrowserControlContext,
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: mocks.createBrowserRouteDispatcher,
}));

import { fetchBrowserJson } from "./client-fetch.js";

describe("browser fetch error classification", () => {
  beforeEach(() => {
    mocks.dispatch.mockReset();
    mocks.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
    mocks.startBrowserControlServiceFromConfig.mockReset();
    mocks.startBrowserControlServiceFromConfig.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps validation errors without unreachable/restart guidance", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 400,
      body: { error: "fields are required" },
    });

    try {
      await fetchBrowserJson("/act", { method: "POST", body: "{}" });
      throw new Error("expected fetchBrowserJson to throw");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("fields are required");
      expect(msg).not.toContain("Browser tool is currently unavailable");
      expect(msg).not.toContain("Restart");
    }
  });

  it("keeps route-level errors like tab not found without connectivity wrapping", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 404,
      body: { error: "Error: tab not found" },
    });

    try {
      await fetchBrowserJson("/snapshot");
      throw new Error("expected fetchBrowserJson to throw");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("tab not found");
      expect(msg).not.toContain("Browser tool is currently unavailable");
      expect(msg).not.toContain("Restart");
    }
  });

  it("uses user-confirmation guidance for timeouts", async () => {
    mocks.dispatch.mockImplementationOnce(async () => await new Promise(() => {}));

    try {
      await fetchBrowserJson("/snapshot", { timeoutMs: 10 });
      throw new Error("expected fetchBrowserJson to throw");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("Browser tool is currently unavailable (timed out after 10ms)");
      expect(msg).toContain("Ask the user whether they want to try the browser step again");
      expect(msg).not.toContain("Restart");
    }
  });

  it("uses user-confirmation guidance for connectivity errors", async () => {
    const connectivityErr = new TypeError("fetch failed") as TypeError & {
      cause?: { code?: string };
    };
    connectivityErr.cause = { code: "ECONNREFUSED" };
    const fetchMock = vi.fn(async () => {
      throw connectivityErr;
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await fetchBrowserJson("http://127.0.0.1:18888/");
      throw new Error("expected fetchBrowserJson to throw");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("Browser tool is currently unavailable.");
      expect(msg).toContain("Ask the user whether they want to try the browser step again");
      expect(msg).not.toContain("Restart");
    }
  });

  it("auto-retries once for transient Playwright-unavailable responses", async () => {
    mocks.dispatch
      .mockResolvedValueOnce({
        status: 501,
        body: {
          error: "Playwright is not available in this gateway build; 'ai snapshot' is unsupported.",
        },
      })
      .mockResolvedValueOnce({ status: 200, body: { ok: true } });

    const res = await fetchBrowserJson<{ ok: boolean }>("/snapshot");
    expect(res.ok).toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  });

  it("surfaces user-confirmation guidance when Playwright remains unavailable after retry", async () => {
    mocks.dispatch.mockResolvedValue({
      status: 501,
      body: {
        error: "Playwright is not available in this gateway build; 'ai snapshot' is unsupported.",
      },
    });

    try {
      await fetchBrowserJson("/snapshot");
      throw new Error("expected fetchBrowserJson to throw");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("Browser tool appears unavailable after retry");
      expect(msg).toContain("Ask the user whether they want to try the browser step again later");
      expect(msg).not.toContain("Restart");
    }

    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  });
});
