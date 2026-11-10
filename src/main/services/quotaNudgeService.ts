/**
 * Global free-quota nudge state (Phase 2 of the 2026-10-23 new-user
 * free-quota post-mortem).
 *
 * The runtime rescue rung (llmFallback.runWithSystemRescue) keeps passive
 * scenarios alive when the ID.Bots allowance dies; this service is the
 * PROACTIVE surface: it computes a single derivable state for the global
 * QuotaNudgeBanner so the owner learns "the free allowance is running out /
 * is exhausted, and N bots still ride it" BEFORE or AS it happens — with a
 * one-click switch target when they already configured their own provider.
 *
 * Design rules (learned from sticky-banner incidents):
 * - The state is DERIVED, never latched: the moment no bot's primary brain
 *   rides the free relay anymore (one-click switch, or a manual brain edit),
 *   the level recomputes to 'none' and the banner disappears on its own.
 * - Dismissal is per quota cycle (keyed on the relay's quotaCycleResetAt) and
 *   per level rank: dismissing the LOW nudge does not suppress the EXHAUSTED
 *   alarm later in the same cycle; a new week re-arms everything.
 * - Quota fetch failures never produce a banner (no nagging on a flaky net).
 *
 * Deps are injected so the whole policy is unit-testable from compiled output.
 */

import {
  FREE_PROVIDER_KEY,
  collectUsablePaidProviderKeys,
  isFreePrimaryBrain,
  resolveProviderSeedModel,
  type BrainFallbackBackfillAppConfig,
} from './brainFallbackBackfill';
import type { Metabot } from '../types/metabot';

export type QuotaNudgeLevel = 'none' | 'low' | 'exhausted';

export type QuotaNudgeReason =
  | 'threshold' // quota crossed the low/exhausted threshold and is not dismissed
  | 'ok' // quota healthy
  | 'no-free-brain-bots' // nothing rides the free relay: banner would be pure noise
  | 'quota-unavailable' // fetch failed / relay unconfigured: never nag
  | 'dismissed'; // dismissed for the current quota cycle at this level rank

export interface QuotaNudgeSuggestedProvider {
  key: string;
  /** Display name (provider's configured name, else the key). */
  name: string;
  modelId: string;
}

export interface QuotaNudgeState {
  level: QuotaNudgeLevel;
  reason: QuotaNudgeReason;
  quotaRemaining: number | null;
  quotaTotal: number | null;
  /** Quota-cycle reset instant, normalized to an ISO string (the relay's ms-epoch number is converted); null when unknown. */
  cycleResetAt: string | null;
  freeBrainBotCount: number;
  suggestedProvider: QuotaNudgeSuggestedProvider | null;
}

/** Remaining/total ratio at or below which the LOW nudge shows. */
export const QUOTA_NUDGE_LOW_THRESHOLD = 0.2;

/** kv key for the per-cycle dismiss record. */
export const QUOTA_NUDGE_DISMISS_KV_KEY = 'llm_quota_nudge_dismiss_v1';

interface QuotaNudgeDismissRecord {
  cycleResetAt: string | null;
  level: 'low' | 'exhausted';
  dismissedAt: number;
}

export interface QuotaNudgeDeps {
  getAppConfig: () => BrainFallbackBackfillAppConfig | null | undefined;
  listMetabots: () => Array<Pick<Metabot, 'id' | 'name' | 'llm_id' | 'llm_provider'>>;
  /** Live relay quota read (llmRelayService.getLlmRelayQuota in production). */
  fetchQuota: (input: { apiKey: string; forceRefresh?: boolean }) => Promise<{
    quotaRemaining?: unknown;
    quotaTotal?: unknown;
    quotaCycleResetAt?: unknown;
  }>;
  getKv: (key: string) => unknown;
  setKv: (key: string, value: unknown) => void;
  now?: () => number;
}

const LEVEL_RANK: Record<QuotaNudgeLevel, number> = { none: 0, low: 1, exhausted: 2 };

const numberOrNull = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** The relay reports the cycle reset as an ms-epoch number; accept an ISO string too. */
const normalizeCycleResetAt = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value;
  const n = numberOrNull(value);
  return n && n > 0 ? new Date(n).toISOString() : null;
};

function normalizeDismissRecord(raw: unknown): QuotaNudgeDismissRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<QuotaNudgeDismissRecord>;
  if (record.level !== 'low' && record.level !== 'exhausted') return null;
  return {
    cycleResetAt: typeof record.cycleResetAt === 'string' ? record.cycleResetAt : null,
    level: record.level,
    dismissedAt: typeof record.dismissedAt === 'number' ? record.dismissedAt : 0,
  };
}

function pickSuggestedProvider(
  appConfig: BrainFallbackBackfillAppConfig | null | undefined,
): QuotaNudgeSuggestedProvider | null {
  const key = collectUsablePaidProviderKeys(appConfig)[0];
  if (!key) return null;
  const modelId = resolveProviderSeedModel(appConfig, key);
  if (!modelId) return null;
  const name = appConfig?.providers?.[key]?.name?.trim() || key;
  return { key, name, modelId };
}

/**
 * Compute the current nudge state from live config + bot brains + relay quota.
 * Never throws: any failure resolves to a 'none' state with the reason set.
 */
export async function computeQuotaNudgeState(deps: QuotaNudgeDeps): Promise<QuotaNudgeState> {
  const appConfig = deps.getAppConfig();
  const providers = appConfig?.providers ?? {};
  const bots = deps.listMetabots();
  const freeBrainBotCount = bots.filter((bot) => isFreePrimaryBrain(bot, appConfig ?? {})).length;
  const base = {
    quotaRemaining: null as number | null,
    quotaTotal: null as number | null,
    cycleResetAt: null as string | null,
    freeBrainBotCount,
    suggestedProvider: pickSuggestedProvider(appConfig),
  };

  // The banner exists to protect bots that still ride the free relay; once
  // every brain is off it (post-switch, or manual edits) there is nothing to
  // warn about — this is what makes the banner disappear after the user fixes
  // their setup.
  if (freeBrainBotCount === 0) {
    return { level: 'none', reason: 'no-free-brain-bots', ...base };
  }
  const freeProvider = providers[FREE_PROVIDER_KEY];
  const freeApiKey = (freeProvider?.apiKey ?? '').trim();
  if (!freeProvider?.enabled || !freeApiKey) {
    return { level: 'none', reason: 'quota-unavailable', ...base };
  }

  let quota: Awaited<ReturnType<QuotaNudgeDeps['fetchQuota']>>;
  try {
    quota = await deps.fetchQuota({ apiKey: freeApiKey });
  } catch {
    return { level: 'none', reason: 'quota-unavailable', ...base };
  }
  const quotaRemaining = numberOrNull(quota?.quotaRemaining);
  const quotaTotal = numberOrNull(quota?.quotaTotal);
  const cycleResetAt = normalizeCycleResetAt(quota?.quotaCycleResetAt);
  if (quotaRemaining == null) {
    return { level: 'none', reason: 'quota-unavailable', ...base, quotaTotal, cycleResetAt };
  }
  const withQuota = { ...base, quotaRemaining, quotaTotal, cycleResetAt };

  let level: QuotaNudgeLevel = 'none';
  if (quotaRemaining <= 0) level = 'exhausted';
  else if (quotaTotal != null && quotaTotal > 0 && quotaRemaining / quotaTotal <= QUOTA_NUDGE_LOW_THRESHOLD) level = 'low';
  if (level === 'none') return { level, reason: 'ok', ...withQuota };

  const dismissed = normalizeDismissRecord(deps.getKv(QUOTA_NUDGE_DISMISS_KV_KEY));
  if (
    dismissed
    && dismissed.cycleResetAt === cycleResetAt
    && LEVEL_RANK[level] <= LEVEL_RANK[dismissed.level]
  ) {
    return { level: 'none', reason: 'dismissed', ...withQuota };
  }
  return { level, reason: 'threshold', ...withQuota };
}

export interface QuotaNudgeControllerDeps extends QuotaNudgeDeps {
  /** Called whenever the computed state CHANGES (renderer push channel). */
  emit: (state: QuotaNudgeState) => void;
  /** Poll interval; 0 disables polling (tests). Default 30 min. */
  pollIntervalMs?: number;
}

export interface QuotaNudgeController {
  /** Recompute and emit on change. Serializes concurrent refreshes. */
  refresh: (options?: { forceQuotaRefresh?: boolean }) => Promise<QuotaNudgeState>;
  /** Record a per-cycle dismissal at the given level and recompute. */
  dismiss: (level: 'low' | 'exhausted') => Promise<QuotaNudgeState>;
  /**
   * A 429 free_quota_exhausted/quota_exhausted was just observed on the wire:
   * force a quota re-read (bypassing the relay's 30s cache) so the banner
   * lights up immediately instead of at the next poll. Throttled.
   */
  notifyExhaustedSeen: () => void;
  getLastState: () => QuotaNudgeState | null;
  stop: () => void;
}

const EXHAUSTED_FORCE_REFRESH_MIN_GAP_MS = 60_000;

export function createQuotaNudgeController(deps: QuotaNudgeControllerDeps): QuotaNudgeController {
  const now = deps.now ?? (() => Date.now());
  let lastState: QuotaNudgeState | null = null;
  let inFlight: Promise<QuotaNudgeState> | null = null;
  let lastExhaustedForceRefreshAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const compute = (forceQuotaRefresh: boolean): Promise<QuotaNudgeState> => {
    if (inFlight) return inFlight;
    const run = (async () => {
      const effectiveDeps: QuotaNudgeDeps = forceQuotaRefresh
        ? { ...deps, fetchQuota: (input) => deps.fetchQuota({ ...input, forceRefresh: true }) }
        : deps;
      const state = await computeQuotaNudgeState(effectiveDeps);
      const changed = JSON.stringify(state) !== JSON.stringify(lastState);
      lastState = state;
      if (changed) deps.emit(state);
      return state;
    })();
    inFlight = run;
    try {
      return run;
    } finally {
      void run.finally(() => {
        if (inFlight === run) inFlight = null;
      });
    }
  };

  const pollIntervalMs = deps.pollIntervalMs ?? 30 * 60 * 1000;
  if (pollIntervalMs > 0) {
    timer = setInterval(() => {
      void compute(false).catch(() => undefined);
    }, pollIntervalMs);
    timer.unref?.();
  }

  return {
    refresh: (options) => compute(options?.forceQuotaRefresh === true),
    dismiss: async (level) => {
      const cycleResetAt = lastState?.cycleResetAt ?? null;
      const record: QuotaNudgeDismissRecord = { cycleResetAt, level, dismissedAt: now() };
      try {
        deps.setKv(QUOTA_NUDGE_DISMISS_KV_KEY, record);
      } catch { /* dismissal persistence is best-effort */ }
      return compute(false);
    },
    notifyExhaustedSeen: () => {
      const at = now();
      if (at - lastExhaustedForceRefreshAt < EXHAUSTED_FORCE_REFRESH_MIN_GAP_MS) return;
      lastExhaustedForceRefreshAt = at;
      void compute(true).catch(() => undefined);
    },
    getLastState: () => lastState,
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
