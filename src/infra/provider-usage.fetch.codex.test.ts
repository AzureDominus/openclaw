import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchCodexUsage } from "./provider-usage.fetch.codex.js";

describe("fetchCodexUsage", () => {
  it("returns token expired for auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(401, { error: "unauthorized" }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("Token expired");
    expect(result.windows).toHaveLength(0);
  });

  it("returns HTTP status errors for non-auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(429, { error: "throttled" }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("HTTP 429");
    expect(result.windows).toHaveLength(0);
  });

  it("parses windows, reset times, and plan balance", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
      return makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 35.5,
            reset_at: 1_700_000_000,
          },
          secondary_window: {
            limit_window_seconds: 86_400,
            used_percent: 75,
            reset_at: 1_700_050_000,
          },
        },
        plan_type: "Plus",
        credits: { balance: "12.5" },
      });
    });

    const result = await fetchCodexUsage("token", "acct-1", 5000, mockFetch);

    expect(result.provider).toBe("openai-codex");
    expect(result.plan).toBe("Plus ($12.50)");
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 35.5, resetAt: 1_700_000_000_000 },
      { label: "1d", usedPercent: 75, resetAt: 1_700_050_000_000 },
    ]);
  });

  it("labels rate-limit windows from their true durations", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 25,
            reset_at: 1_763_000_000,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            used_percent: 80,
            reset_at: 1_763_500_000,
          },
        },
      }),
    );

    const snapshot = await fetchCodexUsage("token", undefined, 500, mockFetch);

    expect(snapshot.windows).toEqual([
      { label: "3h", usedPercent: 25, resetAt: 1_763_000_000_000 },
      { label: "7d", usedPercent: 80, resetAt: 1_763_500_000_000 },
    ]);
  });

  it("uses fallback window durations when the API omits limit_window_seconds", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: { used_percent: 10 },
          secondary_window: { used_percent: 20 },
        },
      }),
    );

    const snapshot = await fetchCodexUsage("token", undefined, 500, mockFetch);

    expect(snapshot.windows).toEqual([
      { label: "3h", usedPercent: 10, resetAt: undefined },
      { label: "1d", usedPercent: 20, resetAt: undefined },
    ]);
  });
});
