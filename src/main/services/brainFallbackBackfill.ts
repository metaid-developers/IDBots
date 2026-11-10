/**
 * Backup-brain backfill for bots riding the free-quota relay
 * (2026-10-23 new-user free-quota post-mortem).
 *
 * New users onboard with every bot brain (Twin Bot included) pointing at the
 * built-in ID.Bots relay provider and NO fallback brain. When the free allowance
 * runs out, the runtime degrade ladder has nothing to switch to and passive
 * scenarios (private chat, group tasks, dreams) start dying — even when the
 * user already configured their own provider key in Settings and simply never
 * learned they also had to wire it into each bot's brain settings.
 *
 * This module fills that gap in two moments, both funneled through the same
 * idempotent backfill:
 * - a ONE-SHOT startup migration (main.ts, kv-flag guarded) covering bots that
 *   already exist when a usable paid provider is present;
 * - a live app_config watch (main.ts) that fires when a provider becomes newly
 *   usable (enabled + keyed + has models) and seeds it as the fallback brain
 *   of every free-primary bot that has none.
 *
 * Only bots whose PRIMARY brain resolves to the free-quota relay are touched:
 * the backfill never overrides a deliberate paid primary, and it never
 * overwrites an existing fallback brain. The flag-guarded migration runs once
 * per install, so a user who later clears a fallback brain on purpose is not
 * re-filled behind their back. No on-chain pins are published — the next
 * intentional brain edit re-publishes /info/llm.
 *
 * Deps are injected so the policy is unit-testable from compiled output.
 */

import type { Metabot, MetabotUpdate } from '../types/metabot';

/** Mirror of claudeSettings.LLM_FREE_PROVIDER_KEY, kept literal so this module stays store-free. */
export const FREE_PROVIDER_KEY = 'metaid-free';
/** Providers exempt from the apiKey requirement (local daemons). */
const API_KEY_EXEMPT_PROVIDERS = new Set(['ollama']);

export interface BrainFallbackBackfillProvider {
  enabled?: boolean;
  apiKey?: string | null;
  /** Optional display name (e.g. 'ID.Bots'); UI falls back to the provider key. */
  name?: string;
  models?: Array<{ id?: string }>;
}

export interface BrainFallbackBackfillAppConfig {
  model?: { defaultModel?: string; defaultProvider?: string };
  providers?: Record<string, BrainFallbackBackfillProvider | undefined>;
}

export interface BrainFallbackBackfillStore {
  listMetabots(): Metabot[];
  updateMetabot(id: number, input: MetabotUpdate): Metabot | null;
}

export interface BrainFallbackBackfillDeps {
  metabotStore: BrainFallbackBackfillStore;
  /** Read app_config (providers + model.defaultModel); null when unavailable. */
  getAppConfig: () => BrainFallbackBackfillAppConfig | null | undefined;
  /**
   * Restrict the fallback source to these provider keys (the live app_config
   * watch passes the newly-usable providers). Default: any usable non-free
   * provider in config order.
   */
  onlyProviderKeys?: ReadonlyArray<string>;
  log?: (message: string) => void;
}

export interface BrainFallbackBackfillResult {
  backfilled: number;
  skippedHasFallback: number;
  skippedNotFree: number;
  /** The provider key used as the fallback source; null when none was usable. */
  sourceProvider: string | null;
}

/** True when a provider row can serve traffic right now (enabled, keyed, has models). */
function isUsableProvider(key: string, provider: BrainFallbackBackfillProvider | undefined): boolean {
  if (!provider?.enabled) return false;
  if (!API_KEY_EXEMPT_PROVIDERS.has(key.trim().toLowerCase()) && !provider.apiKey?.trim()) return false;
  return (provider.models ?? []).some((model) => typeof model?.id === 'string' && model.id);
}

/** Public wrapper: is the named provider usable right now (enabled, keyed, has models)? */
export function isUsableProviderKey(appConfig: BrainFallbackBackfillAppConfig | null | undefined, key: string): boolean {
  return isUsableProvider(key, appConfig?.providers?.[key]);
}

/**
 * The provider keys a fallback brain may be seeded from: every usable non-free
 * provider in config order. The free-quota relay is excluded — it is the
 * provider this backfill protects against, and it must never become the
 * fallback of its own bots.
 */
export function collectUsablePaidProviderKeys(
  appConfig: BrainFallbackBackfillAppConfig | null | undefined,
): string[] {
  const providers = appConfig?.providers ?? {};
  return Object.entries(providers)
    .filter(([key, provider]) => key.trim().toLowerCase() !== FREE_PROVIDER_KEY && isUsableProvider(key, provider))
    .map(([key]) => key);
}

/** The model a provider seeds as fallback brain: the app default when that provider serves it, else its first model. */
function defaultModelForProvider(
  provider: BrainFallbackBackfillProvider,
  appConfig: BrainFallbackBackfillAppConfig,
): string | null {
  const models = (provider.models ?? []).filter((model) => typeof model?.id === 'string' && model.id);
  if (models.length === 0) return null;
  const defaultModel = appConfig.model?.defaultModel;
  if (defaultModel && models.some((model) => model.id === defaultModel)) return defaultModel;
  return models[0].id as string;
}

/**
 * The seed model of the named provider (app default when served, else first
 * model); null when the provider is missing or serves no models.
 */
export function resolveProviderSeedModel(
  appConfig: BrainFallbackBackfillAppConfig | null | undefined,
  providerKey: string,
): string | null {
  const provider = appConfig?.providers?.[providerKey];
  if (!provider) return null;
  return defaultModelForProvider(provider, appConfig ?? {});
}

/**
 * True when the bot's PRIMARY brain rides the free-quota relay: an explicit
 * metaid-free provider hint, or (legacy rows without a hint) an llm_id the
 * free provider serves. Bots with a paid primary are never touched.
 */
export function isFreePrimaryBrain(
  bot: Pick<Metabot, 'llm_id' | 'llm_provider'>,
  appConfig: BrainFallbackBackfillAppConfig,
): boolean {
  const providerHint = (bot.llm_provider ?? '').trim().toLowerCase();
  if (providerHint) return providerHint === FREE_PROVIDER_KEY;
  const llmId = (bot.llm_id ?? '').trim();
  if (!llmId) return false;
  const freeProvider = appConfig.providers?.[FREE_PROVIDER_KEY];
  return (freeProvider?.models ?? []).some((model) => model?.id === llmId);
}

/**
 * Seed the fallback brain of every free-primary bot that has none. Idempotent:
 * bots with a fallback brain are skipped, so a second run backfills 0.
 */
export function backfillFreeBrainFallbacks(deps: BrainFallbackBackfillDeps): BrainFallbackBackfillResult {
  const log = deps.log ?? ((message: string) => console.log(message));
  const result: BrainFallbackBackfillResult = {
    backfilled: 0,
    skippedHasFallback: 0,
    skippedNotFree: 0,
    sourceProvider: null,
  };

  const appConfig = deps.getAppConfig();
  if (!appConfig) {
    log('[brain-fallback-backfill] skipped: no app config available');
    return result;
  }
  const candidateKeys = deps.onlyProviderKeys?.length
    ? deps.onlyProviderKeys
    : collectUsablePaidProviderKeys(appConfig);
  const providers = appConfig.providers ?? {};
  const sourceKey = candidateKeys.find((key) => isUsableProvider(key, providers[key])) ?? null;
  const sourceModel = sourceKey ? defaultModelForProvider(providers[sourceKey]!, appConfig) : null;
  if (!sourceKey || !sourceModel) {
    log('[brain-fallback-backfill] skipped: no usable non-free provider to seed from');
    return result;
  }
  result.sourceProvider = sourceKey;

  for (const bot of deps.metabotStore.listMetabots()) {
    if ((bot.fallback_llm_id ?? '').trim()) {
      result.skippedHasFallback += 1;
      continue;
    }
    if (!isFreePrimaryBrain(bot, appConfig)) {
      result.skippedNotFree += 1;
      continue;
    }
    deps.metabotStore.updateMetabot(bot.id, {
      fallback_llm_id: sourceModel,
      fallback_llm_provider: sourceKey,
      fallback_llm_effort: null,
    });
    log(
      `[brain-fallback-backfill] bot ${bot.id} (${bot.name}): fallback brain seeded as '${sourceModel}' (provider ${sourceKey})`,
    );
    result.backfilled += 1;
  }

  log(
    `[brain-fallback-backfill] done: ${result.backfilled} backfilled (source ${sourceKey}), ` +
    `${result.skippedHasFallback} already had a fallback, ${result.skippedNotFree} not free-primary`,
  );
  return result;
}
