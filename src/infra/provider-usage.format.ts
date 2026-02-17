import type { ProviderUsageSnapshot, UsageSummary, UsageWindow } from "./provider-usage.types.js";
import { clampPercent } from "./provider-usage.shared.js";

function formatResetRemaining(targetMs?: number, now?: number): string | null {
  if (!targetMs) {
    return null;
  }
  const base = now ?? Date.now();
  const diffMs = targetMs - base;
  if (diffMs <= 0) {
    return "now";
  }

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) {
    return `${diffMins}m`;
  }

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ${hours % 24}h`;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(targetMs));
}

function pickPrimaryWindow(windows: UsageWindow[]): UsageWindow | undefined {
  if (windows.length === 0) {
    return undefined;
  }
  return windows.reduce((best, next) => (next.usedPercent > best.usedPercent ? next : best));
}

function formatWindowShort(window: UsageWindow, now?: number): string {
  const remaining = clampPercent(100 - window.usedPercent);
  const reset = formatResetRemaining(window.resetAt, now);
  const resetSuffix = reset ? `, resets ${reset}` : "";
  return `${remaining.toFixed(0)}% left (${window.label}${resetSuffix})`;
}

function formatUsageWindowLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    return "limit";
  }
  if (normalized === "week" || normalized === "weekly" || normalized === "7d") {
    return "weekly limit";
  }
  if (
    normalized === "day" ||
    normalized === "daily" ||
    normalized === "1d" ||
    normalized === "24h"
  ) {
    return "daily limit";
  }
  return `${label} limit`;
}

function formatUsageResetTime(resetAt: number, nowMs: number): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(resetAt));
  const sameDay = new Date(resetAt).toLocaleDateString() === new Date(nowMs).toLocaleDateString();
  if (sameDay) {
    return time;
  }
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(new Date(resetAt));
  return `${time} on ${day}`;
}

function renderUsageBar(remainingPercent: number, width = 20): string {
  const clamped = clampPercent(remainingPercent);
  const filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export function formatUsageWindowBars(
  snapshot: ProviderUsageSnapshot,
  opts?: { now?: number; maxWindows?: number; includeResets?: boolean; barWidth?: number },
): string[] {
  if (snapshot.error || snapshot.windows.length === 0) {
    return [];
  }

  const now = opts?.now ?? Date.now();
  const maxWindows =
    typeof opts?.maxWindows === "number" && opts.maxWindows > 0
      ? Math.min(opts.maxWindows, snapshot.windows.length)
      : snapshot.windows.length;
  const includeResets = opts?.includeResets ?? true;
  const barWidth =
    typeof opts?.barWidth === "number" && opts.barWidth > 0 ? Math.round(opts.barWidth) : 20;
  const windows = snapshot.windows.slice(0, maxWindows);
  const labeled = windows.map((window) => ({
    title: `${formatUsageWindowLabel(window.label)}:`,
    remaining: clampPercent(100 - window.usedPercent),
    resetAt: window.resetAt,
  }));
  const labelWidth = Math.max(...labeled.map((entry) => entry.title.length));
  return labeled.map((entry) => {
    const resetSuffix =
      includeResets && entry.resetAt ? ` (resets ${formatUsageResetTime(entry.resetAt, now)})` : "";
    return `${entry.title.padEnd(labelWidth)} ${renderUsageBar(entry.remaining, barWidth)} ${entry.remaining.toFixed(0)}% left${resetSuffix}`;
  });
}

export function formatUsageWindowSummary(
  snapshot: ProviderUsageSnapshot,
  opts?: { now?: number; maxWindows?: number; includeResets?: boolean },
): string | null {
  if (snapshot.error) {
    return null;
  }
  if (snapshot.windows.length === 0) {
    return null;
  }
  const now = opts?.now ?? Date.now();
  const maxWindows =
    typeof opts?.maxWindows === "number" && opts.maxWindows > 0
      ? Math.min(opts.maxWindows, snapshot.windows.length)
      : snapshot.windows.length;
  const includeResets = opts?.includeResets ?? false;
  const windows = snapshot.windows.slice(0, maxWindows);
  const parts = windows.map((window) => {
    const remaining = clampPercent(100 - window.usedPercent);
    const reset = includeResets ? formatResetRemaining(window.resetAt, now) : null;
    const resetSuffix = reset ? ` (resets ${reset})` : "";
    return `${window.label} ${remaining.toFixed(0)}% left${resetSuffix}`;
  });
  return parts.join(" · ");
}

export function formatUsageSummaryLine(
  summary: UsageSummary,
  opts?: { now?: number; maxProviders?: number },
): string | null {
  const providers = summary.providers
    .filter((entry) => entry.windows.length > 0 && !entry.error)
    .slice(0, opts?.maxProviders ?? summary.providers.length);
  if (providers.length === 0) {
    return null;
  }

  const parts = providers
    .map((entry) => {
      const window = pickPrimaryWindow(entry.windows);
      if (!window) {
        return null;
      }
      return `${entry.displayName} ${formatWindowShort(window, opts?.now)}`;
    })
    .filter(Boolean) as string[];

  if (parts.length === 0) {
    return null;
  }
  return `Usage: ${parts.join(" · ")}`;
}

export function formatUsageReportLines(summary: UsageSummary, opts?: { now?: number }): string[] {
  if (summary.providers.length === 0) {
    return ["Usage: no provider usage available."];
  }

  const lines: string[] = ["Usage:"];
  for (const entry of summary.providers) {
    const planSuffix = entry.plan ? ` (${entry.plan})` : "";
    if (entry.error) {
      lines.push(`  ${entry.displayName}${planSuffix}: ${entry.error}`);
      continue;
    }
    if (entry.windows.length === 0) {
      lines.push(`  ${entry.displayName}${planSuffix}: no data`);
      continue;
    }
    lines.push(`  ${entry.displayName}${planSuffix}`);
    for (const window of entry.windows) {
      const remaining = clampPercent(100 - window.usedPercent);
      const reset = formatResetRemaining(window.resetAt, opts?.now);
      const resetSuffix = reset ? ` · resets ${reset}` : "";
      lines.push(`    ${window.label}: ${remaining.toFixed(0)}% left${resetSuffix}`);
    }
  }
  return lines;
}
