import { fileURLToPath } from "node:url";

function normalizeMediaPathCandidate(raw: string): string {
  let value = raw.trim().replace(/^\s*MEDIA\s*:\s*/i, "");
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value);
    } catch {
      return value;
    }
  }
  return value.replace(/\\/g, "/").toLowerCase();
}

/**
 * Browser tool screenshots are stored under ~/.openclaw/media/browser/.
 * Treat those as high-fidelity artifacts and avoid channel photo pipelines.
 */
export function isLikelyBrowserScreenshotMediaUrl(mediaUrl?: string): boolean {
  if (!mediaUrl?.trim()) {
    return false;
  }
  const normalized = normalizeMediaPathCandidate(mediaUrl);
  if (/^https?:\/\//.test(normalized)) {
    return false;
  }
  return normalized.includes("/media/browser/");
}
