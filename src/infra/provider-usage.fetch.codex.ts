import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";

type CodexUsageResponse = {
  rate_limit?: {
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
};

function formatWindowLabel(limitWindowSeconds: number): string {
  if (!Number.isFinite(limitWindowSeconds) || limitWindowSeconds <= 0) {
    return "Window";
  }

  const seconds = Math.round(limitWindowSeconds);
  const day = 86_400;
  const hour = 3_600;
  const minute = 60;

  if (seconds % day === 0) {
    return `${seconds / day}d`;
  }
  if (seconds % hour === 0) {
    return `${seconds / hour}h`;
  }
  if (seconds % minute === 0) {
    return `${seconds / minute}m`;
  }
  return `${seconds}s`;
}

export async function fetchCodexUsage(
  token: string,
  accountId: string | undefined,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "CodexBar",
    Accept: "application/json",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const res = await fetchJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { method: "GET", headers },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return buildUsageHttpErrorSnapshot({
      provider: "openai-codex",
      status: res.status,
      tokenExpiredStatuses: [401, 403],
    });
  }

  const data = (await res.json()) as CodexUsageResponse;
  const windows: UsageWindow[] = [];

  if (data.rate_limit?.primary_window) {
    const pw = data.rate_limit.primary_window;
    const limitWindowSeconds = pw.limit_window_seconds || 10_800;
    windows.push({
      label: formatWindowLabel(limitWindowSeconds),
      usedPercent: clampPercent(pw.used_percent || 0),
      resetAt: pw.reset_at ? pw.reset_at * 1000 : undefined,
    });
  }

  if (data.rate_limit?.secondary_window) {
    const sw = data.rate_limit.secondary_window;
    const limitWindowSeconds = sw.limit_window_seconds || 86_400;
    windows.push({
      label: formatWindowLabel(limitWindowSeconds),
      usedPercent: clampPercent(sw.used_percent || 0),
      resetAt: sw.reset_at ? sw.reset_at * 1000 : undefined,
    });
  }

  let plan = data.plan_type;
  if (data.credits?.balance !== undefined && data.credits.balance !== null) {
    const balance =
      typeof data.credits.balance === "number"
        ? data.credits.balance
        : parseFloat(data.credits.balance) || 0;
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return {
    provider: "openai-codex",
    displayName: PROVIDER_LABELS["openai-codex"],
    windows,
    plan,
  };
}
