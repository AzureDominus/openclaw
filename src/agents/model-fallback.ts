import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import {
  ensureAuthProfileStore,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";

type ModelCandidate = {
  provider: string;
  model: string;
};

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

type ModelRetryPolicy = {
  maxRetries: number;
  initialBackoffMs: number;
  backoffFactor: number;
  maxBackoffMs: number;
  reasons: Set<FailoverReason>;
};

export type ModelRetryScheduledEvent = {
  provider: string;
  model: string;
  reason: FailoverReason;
  source: "cooldown" | "error";
  retryAttempt: number;
  maxRetries: number;
  waitMs: number;
  candidateAttempt: number;
  totalCandidates: number;
};

const DEFAULT_MODEL_RETRY_INITIAL_BACKOFF_SECONDS = 60;
const DEFAULT_MODEL_RETRY_BACKOFF_FACTOR = 2;
const DEFAULT_MODEL_RETRY_MAX_BACKOFF_SECONDS = 10 * 60;
const DEFAULT_MODEL_RETRY_REASONS = new Set<FailoverReason>(["rate_limit"]);

/**
 * Fallback abort check. Only treats explicit AbortError names as user aborts.
 * Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
 */
function isFallbackAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (isFailoverError(err)) {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isFallbackAbortError(err) && !isTimeoutError(err);
}

function createModelCandidateCollector(allowlist: Set<string> | null | undefined): {
  candidates: ModelCandidate[];
  addCandidate: (candidate: ModelCandidate, enforceAllowlist: boolean) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    if (enforceAllowlist && allowlist && !allowlist.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  return { candidates, addCandidate };
}

type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

type ModelFallbackRunResult<T> = {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

function sameModelCandidate(a: ModelCandidate, b: ModelCandidate): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function throwFallbackFailureSummary(params: {
  attempts: FallbackAttempt[];
  candidates: ModelCandidate[];
  lastError: unknown;
  label: string;
  formatAttempt: (attempt: FallbackAttempt) => string;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
  throw new Error(
    `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`,
    {
      cause: params.lastError instanceof Error ? params.lastError : undefined,
    },
  );
}

function toPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function secondsToMs(seconds: number): number {
  return Math.max(1, Math.round(seconds * 1000));
}

function toNonnegativeInteger(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : 0;
}

function normalizeRetryReasons(value: unknown): Set<FailoverReason> {
  if (!Array.isArray(value) || value.length === 0) {
    return new Set(DEFAULT_MODEL_RETRY_REASONS);
  }
  const out = new Set<FailoverReason>();
  for (const item of value) {
    if (
      item === "auth" ||
      item === "format" ||
      item === "rate_limit" ||
      item === "billing" ||
      item === "timeout" ||
      item === "unknown"
    ) {
      out.add(item);
    }
  }
  return out.size > 0 ? out : new Set(DEFAULT_MODEL_RETRY_REASONS);
}

function resolveModelRetryPolicy(value: unknown): ModelRetryPolicy | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const maxRetries = toNonnegativeInteger((value as { maxRetries?: unknown }).maxRetries);
  if (maxRetries <= 0) {
    return null;
  }
  const initialBackoffSeconds = toPositiveNumber(
    (value as { initialBackoffSeconds?: unknown }).initialBackoffSeconds,
    DEFAULT_MODEL_RETRY_INITIAL_BACKOFF_SECONDS,
  );
  const backoffFactor = toPositiveNumber(
    (value as { backoffFactor?: unknown }).backoffFactor,
    DEFAULT_MODEL_RETRY_BACKOFF_FACTOR,
  );
  const maxBackoffSeconds = toPositiveNumber(
    (value as { maxBackoffSeconds?: unknown }).maxBackoffSeconds,
    DEFAULT_MODEL_RETRY_MAX_BACKOFF_SECONDS,
  );
  const initialBackoffMs = secondsToMs(initialBackoffSeconds);
  const maxBackoffMs = secondsToMs(maxBackoffSeconds);

  return {
    maxRetries,
    initialBackoffMs,
    backoffFactor,
    maxBackoffMs: Math.max(maxBackoffMs, initialBackoffMs),
    reasons: normalizeRetryReasons((value as { reasons?: unknown }).reasons),
  };
}

function resolveModelRetryPolicyMap(
  cfg: OpenClawConfig | undefined,
): Map<string, ModelRetryPolicy> {
  const out = new Map<string, ModelRetryPolicy>();
  if (!cfg) {
    return out;
  }
  const configuredPrimary = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const defaultProvider = configuredPrimary.provider;
  const modelEntries = cfg.agents?.defaults?.models ?? {};
  for (const [rawRef, entry] of Object.entries(modelEntries)) {
    const parsed = parseModelRef(String(rawRef ?? ""), defaultProvider);
    if (!parsed || !entry || typeof entry !== "object") {
      continue;
    }
    const retry = resolveModelRetryPolicy((entry as { retry?: unknown }).retry);
    if (!retry) {
      continue;
    }
    out.set(modelKey(parsed.provider, parsed.model), retry);
  }
  return out;
}

function shouldRetryModelAttempt(params: {
  policy: ModelRetryPolicy | undefined;
  reason?: FailoverReason;
  retriesUsed: number;
}): boolean {
  const policy = params.policy;
  if (!policy) {
    return false;
  }
  if (params.retriesUsed >= policy.maxRetries) {
    return false;
  }
  const reason = params.reason ?? "unknown";
  return policy.reasons.has(reason);
}

function computeRetryDelayMs(params: {
  policy: ModelRetryPolicy;
  retryNumber: number;
  nowMs: number;
  cooldownUntilMs?: number | null;
}): number {
  const exponent = Math.max(0, params.retryNumber - 1);
  const exponentialBackoffMs = Math.min(
    params.policy.maxBackoffMs,
    params.policy.initialBackoffMs * params.policy.backoffFactor ** exponent,
  );
  const cooldownRemainingMs =
    typeof params.cooldownUntilMs === "number" && Number.isFinite(params.cooldownUntilMs)
      ? Math.max(0, params.cooldownUntilMs - params.nowMs)
      : 0;
  return Math.max(1, Math.round(Math.max(exponentialBackoffMs, cooldownRemainingMs)));
}

function sleepMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function resolveImageFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const { candidates, addCandidate } = createModelCandidateCollector(allowlist);

  const addRaw = (raw: string, enforceAllowlist: boolean) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    addCandidate(resolved.ref, enforceAllowlist);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride, false);
  } else {
    const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
    if (primary?.trim()) {
      addRaw(primary, false);
    }
  }

  const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);

  for (const raw of imageFallbacks) {
    addRaw(raw, true);
  }

  return candidates;
}

function resolveFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = String(params.provider ?? "").trim() || defaultProvider;
  const modelRaw = String(params.model ?? "").trim() || defaultModel;
  const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
  const configuredPrimary = normalizeModelRef(defaultProvider, defaultModel);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  const { candidates, addCandidate } = createModelCandidateCollector(allowlist);

  addCandidate(normalizedPrimary, false);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) {
      return params.fallbacksOverride;
    }
    const configuredFallbacks = resolveAgentModelFallbackValues(
      params.cfg?.agents?.defaults?.model,
    );
    if (sameModelCandidate(normalizedPrimary, configuredPrimary)) {
      return configuredFallbacks;
    }
    // Preserve resilience after failover: when current model is one of the
    // configured fallback refs, keep traversing the configured fallback chain.
    const isConfiguredFallback = configuredFallbacks.some((raw) => {
      const resolved = resolveModelRefFromString({
        raw: String(raw ?? ""),
        defaultProvider,
        aliasIndex,
      });
      return resolved ? sameModelCandidate(resolved.ref, normalizedPrimary) : false;
    });
    // Keep legacy override behavior for ad-hoc models outside configured chain.
    return isConfiguredFallback ? configuredFallbacks : [];
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    addCandidate(resolved.ref, true);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addCandidate({ provider: primary.provider, model: primary.model }, false);
  }

  return candidates;
}

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000; // 30 seconds between probes per key
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";

function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = String(agentDir ?? "").trim();
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  throttleKey: string;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  profileIds: string[];
}): boolean {
  if (!params.isPrimary || !params.hasFallbackCandidates) {
    return false;
  }

  const lastProbe = lastProbeAttempt.get(params.throttleKey) ?? 0;
  if (params.now - lastProbe < MIN_PROBE_INTERVAL_MS) {
    return false;
  }

  const soonest = getSoonestCooldownExpiry(params.authStore, params.profileIds);
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }

  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const _probeThrottleInternals = {
  lastProbeAttempt,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  resolveProbeThrottleKey,
} as const;

export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
  onRetryScheduled?: (event: ModelRetryScheduledEvent) => void | Promise<void>;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;
  const retryPolicyByModel = resolveModelRetryPolicyMap(params.cfg);

  const hasFallbackCandidates = candidates.length > 1;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const retryPolicy = retryPolicyByModel.get(modelKey(candidate.provider, candidate.model));
    let retriesUsed = 0;

    while (true) {
      if (authStore) {
        const profileIds = resolveAuthProfileOrder({
          cfg: params.cfg,
          store: authStore,
          provider: candidate.provider,
        });
        const isAnyProfileAvailable = profileIds.some((id) => !isProfileInCooldown(authStore, id));

        if (profileIds.length > 0 && !isAnyProfileAvailable) {
          // All profiles for this provider are in cooldown.
          // For the primary model (i === 0), probe it if the soonest cooldown
          // expiry is close or already past. This avoids staying on a fallback
          // model long after the real rate-limit window clears.
          const now = Date.now();
          const soonestCooldown = getSoonestCooldownExpiry(authStore, profileIds);
          const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
          const shouldProbe = shouldProbePrimaryDuringCooldown({
            isPrimary: i === 0,
            hasFallbackCandidates,
            now,
            throttleKey: probeThrottleKey,
            authStore,
            profileIds,
          });
          if (!shouldProbe) {
            const inferredReason =
              resolveProfilesUnavailableReason({
                store: authStore,
                profileIds,
                now,
              }) ?? "rate_limit";
            attempts.push({
              provider: candidate.provider,
              model: candidate.model,
              error: `Provider ${candidate.provider} is in cooldown (all profiles unavailable)`,
              reason: inferredReason,
            });
            if (
              shouldRetryModelAttempt({
                policy: retryPolicy,
                reason: inferredReason,
                retriesUsed,
              })
            ) {
              const activeRetryPolicy = retryPolicy;
              if (!activeRetryPolicy) {
                break;
              }
              const retryDelayMs = computeRetryDelayMs({
                policy: activeRetryPolicy,
                retryNumber: retriesUsed + 1,
                nowMs: now,
                cooldownUntilMs: soonestCooldown,
              });
              await params.onRetryScheduled?.({
                provider: candidate.provider,
                model: candidate.model,
                reason: inferredReason,
                source: "cooldown",
                retryAttempt: retriesUsed + 1,
                maxRetries: activeRetryPolicy.maxRetries,
                waitMs: retryDelayMs,
                candidateAttempt: i + 1,
                totalCandidates: candidates.length,
              });
              retriesUsed += 1;
              await sleepMs(retryDelayMs);
              continue;
            }
            break;
          }
          // Primary model probe: attempt it despite cooldown to detect recovery.
          // If it fails, the error is caught below and we fall through to the
          // next candidate as usual.
          lastProbeAttempt.set(probeThrottleKey, now);
        }
      }
      try {
        const result = await params.run(candidate.provider, candidate.model);
        return {
          result,
          provider: candidate.provider,
          model: candidate.model,
          attempts,
        };
      } catch (err) {
        if (shouldRethrowAbort(err)) {
          throw err;
        }
        // Context overflow errors should be handled by the inner runner's
        // compaction/retry logic, not by model fallback.  If one escapes as a
        // throw, rethrow it immediately rather than trying a different model
        // that may have a smaller context window and fail worse.
        const errMessage = err instanceof Error ? err.message : String(err);
        if (isLikelyContextOverflowError(errMessage)) {
          throw err;
        }
        const normalized =
          coerceToFailoverError(err, {
            provider: candidate.provider,
            model: candidate.model,
          }) ?? err;
        if (!isFailoverError(normalized)) {
          throw err;
        }

        lastError = normalized;
        const described = describeFailoverError(normalized);
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: described.message,
          reason: described.reason,
          status: described.status,
          code: described.code,
        });
        await params.onError?.({
          provider: candidate.provider,
          model: candidate.model,
          error: normalized,
          attempt: i + 1,
          total: candidates.length,
        });

        if (
          shouldRetryModelAttempt({
            policy: retryPolicy,
            reason: described.reason,
            retriesUsed,
          })
        ) {
          const activeRetryPolicy = retryPolicy;
          if (!activeRetryPolicy) {
            break;
          }
          const now = Date.now();
          const retryDelayMs = computeRetryDelayMs({
            policy: activeRetryPolicy,
            retryNumber: retriesUsed + 1,
            nowMs: now,
          });
          await params.onRetryScheduled?.({
            provider: candidate.provider,
            model: candidate.model,
            reason: described.reason ?? "unknown",
            source: "error",
            retryAttempt: retriesUsed + 1,
            maxRetries: activeRetryPolicy.maxRetries,
            waitMs: retryDelayMs,
            candidateAttempt: i + 1,
            totalCandidates: candidates.length,
          });
          retriesUsed += 1;
          await sleepMs(retryDelayMs);
          continue;
        }
      }
      break;
    }
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "models",
    formatAttempt: (attempt) =>
      `${attempt.provider}/${attempt.model}: ${attempt.error}${
        attempt.reason ? ` (${attempt.reason})` : ""
      }`,
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) {
        throw err;
      }
      lastError = err;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: err instanceof Error ? err.message : String(err),
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "image models",
    formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
  });
}
