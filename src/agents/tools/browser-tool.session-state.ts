export type BrowserSessionLocation = "sandbox" | "host" | "node";

export type BrowserSessionState = {
  scopeKey: string;
  location: BrowserSessionLocation;
  nodeId?: string;
  profile?: string;
  targetId?: string;
  attachedAt: number;
};

const browserSessionStateByScope = new Map<string, BrowserSessionState>();

function normalizeScopePart(raw?: string): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveBrowserSessionScopeKey(params: {
  sessionId?: string;
  agentSessionKey?: string;
}): string | undefined {
  return normalizeScopePart(params.sessionId) ?? normalizeScopePart(params.agentSessionKey);
}

export function getBrowserSessionState(params: {
  sessionId?: string;
  agentSessionKey?: string;
}): BrowserSessionState | undefined {
  const scopeKey = resolveBrowserSessionScopeKey(params);
  if (!scopeKey) {
    return undefined;
  }
  return browserSessionStateByScope.get(scopeKey);
}

export function setBrowserSessionState(
  params: Omit<BrowserSessionState, "attachedAt" | "scopeKey"> & {
    sessionId?: string;
    agentSessionKey?: string;
  },
): BrowserSessionState | undefined {
  const scopeKey = resolveBrowserSessionScopeKey(params);
  if (!scopeKey) {
    return undefined;
  }
  const next: BrowserSessionState = {
    scopeKey,
    location: params.location,
    nodeId: params.nodeId,
    profile: params.profile,
    targetId: params.targetId,
    attachedAt: Date.now(),
  };
  browserSessionStateByScope.set(scopeKey, next);
  return next;
}

export function clearBrowserSessionState(params: {
  sessionId?: string;
  agentSessionKey?: string;
}): boolean {
  const scopeKey = resolveBrowserSessionScopeKey(params);
  if (!scopeKey) {
    return false;
  }
  return browserSessionStateByScope.delete(scopeKey);
}

export function updateBrowserSessionTarget(params: {
  sessionId?: string;
  agentSessionKey?: string;
  targetId?: string;
}): BrowserSessionState | undefined {
  const existing = getBrowserSessionState(params);
  if (!existing) {
    return undefined;
  }
  const next: BrowserSessionState = {
    ...existing,
    targetId: params.targetId?.trim() || undefined,
    attachedAt: Date.now(),
  };
  browserSessionStateByScope.set(existing.scopeKey, next);
  return next;
}

export function __resetBrowserSessionStateForTests() {
  browserSessionStateByScope.clear();
}
