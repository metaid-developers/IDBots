import type { AppConfig } from '../../config';
import type { Metabot } from '../../types/metabot';
import { canonicalFreeProviderKey, LLM_FREE_PROVIDER_KEY } from '../../services/llmFreeQuotaGate.js';
import { buildModelGroupsFromConfig, type CatalogProviderGroup } from '../../services/modelCatalog';

export interface FreeRelayUsageSummary {
  freeBrainBotIds: number[];
  freeBrainBotCount: number;
  defaultRidesFree: boolean;
  paidProviders: CatalogProviderGroup[];
}

/**
 * Mirror src/main/services/brainFallbackBackfill.ts `isFreePrimaryBrain` so the
 * My Bots bulk-switch banner matches the exact set of bots that
 * `window.electron.brainSwitch.switchFreeBrainsTo` will migrate.
 */
export function isBotPrimaryBrainOnFreeRelay(
  bot: Pick<Metabot, 'llm_id' | 'llm_provider'>,
  config: Pick<AppConfig, 'providers'>,
): boolean {
  const providerHint = canonicalFreeProviderKey(bot.llm_provider);
  if (providerHint) {
    return providerHint === LLM_FREE_PROVIDER_KEY;
  }
  const llmId = (bot.llm_id ?? '').trim();
  if (!llmId) return false;
  const providers = (config.providers ?? {}) as Record<string, { models?: Array<{ id?: string }> } | undefined>;
  const freeProvider = providers[LLM_FREE_PROVIDER_KEY] ?? providers['metaid-free'];
  return (freeProvider?.models ?? []).some((model) => model?.id === llmId);
}

export function summarizeFreeRelayUsage(
  bots: ReadonlyArray<Pick<Metabot, 'id' | 'llm_id' | 'llm_provider'>>,
  config: Pick<AppConfig, 'model' | 'providers'>,
): FreeRelayUsageSummary {
  const freeBrainBotIds = bots
    .filter((bot) => isBotPrimaryBrainOnFreeRelay(bot, config))
    .map((bot) => bot.id);

  const providers = (config.providers ?? {}) as Record<string, { models?: Array<{ id?: string }> } | undefined>;
  const freeProvider = providers[LLM_FREE_PROVIDER_KEY] ?? providers['metaid-free'];
  const defaultProvider = canonicalFreeProviderKey(config.model?.defaultProvider);
  const defaultModel = (config.model?.defaultModel ?? '').trim();
  const freeServesDefault = Boolean(
    defaultModel && (freeProvider?.models ?? []).some((model) => model?.id === defaultModel),
  );
  const defaultRidesFree =
    defaultProvider === LLM_FREE_PROVIDER_KEY || (!defaultProvider && freeServesDefault);

  const paidProviders = buildModelGroupsFromConfig(config).filter(
    (group) => canonicalFreeProviderKey(group.id) !== LLM_FREE_PROVIDER_KEY,
  );

  return {
    freeBrainBotIds,
    freeBrainBotCount: freeBrainBotIds.length,
    defaultRidesFree,
    paidProviders,
  };
}
