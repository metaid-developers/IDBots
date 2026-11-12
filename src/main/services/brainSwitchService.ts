/**
 * One-click brain switch (Phase 2 of the 2026-10-23 new-user free-quota
 * post-mortem).
 *
 * The global quota nudge banner's primary action: move EVERY bot whose primary
 * brain still rides the free-quota relay onto the owner's own provider in one
 * click — without making the owner learn the brain settings first.
 *
 * Semantics per switched bot:
 * - the primary brain becomes the target provider's seed model (app default
 *   when that provider serves it, else its first model);
 * - the free relay is kept as the FALLBACK brain when the bot had none —
 *   the allowance resets weekly, so a free fallback heals itself and covers
 *   the owner's provider dying. An existing fallback brain is never touched.
 *
 * The per-bot write goes through the exact path the bot-edit UI uses
 * (updateMetaBotCore, injected as updateBot): local DB write + best-effort
 * on-chain /info/llm re-publish, identical to a manual edit. The global
 * default model/provider is also moved off the free relay when it still
 * points there, so NEW sessions stop defaulting to the exhausted route.
 *
 * Deps are injected so the policy is unit-testable from compiled output.
 */

import {
  FREE_PROVIDER_KEY,
  FREE_PROVIDER_LEGACY_KEY,
  canonicalFreeProviderKey,
  isFreePrimaryBrain,
  isUsableProviderKey,
  resolveProviderSeedModel,
  type BrainFallbackBackfillAppConfig,
} from './brainFallbackBackfill';
import type { Metabot } from '../types/metabot';

export interface BrainSwitchUpdateResult {
  success: boolean;
  error?: string;
}

export interface BrainSwitchDeps {
  listMetabots: () => Array<Pick<Metabot, 'id' | 'name' | 'llm_id' | 'llm_provider' | 'fallback_llm_id'>>;
  getAppConfig: () => BrainFallbackBackfillAppConfig | null | undefined;
  /** The exact per-bot update path the bot-edit UI uses (updateMetaBotCore). */
  updateBot: (id: number, input: {
    llm_id: string;
    llm_provider: string;
    fallback_llm_id?: string | null;
    fallback_llm_provider?: string | null;
  }) => Promise<BrainSwitchUpdateResult>;
  /** Serialized read-modify-write of the app_config kv row. */
  mutateAppConfig: (mutate: (current: BrainFallbackBackfillAppConfig) => BrainFallbackBackfillAppConfig) => void;
  log?: (message: string) => void;
}

export interface BrainSwitchResult {
  success: boolean;
  error?: string;
  providerKey: string;
  modelId?: string;
  switchedBotIds: number[];
  failedBots: Array<{ id: number; name: string; error: string }>;
  defaultRouteUpdated: boolean;
}

export async function switchFreePrimaryBrainsToProvider(
  deps: BrainSwitchDeps,
  providerKey: string,
): Promise<BrainSwitchResult> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const result: BrainSwitchResult = {
    success: false,
    providerKey,
    switchedBotIds: [],
    failedBots: [],
    defaultRouteUpdated: false,
  };

  const appConfig = deps.getAppConfig();
  if (!appConfig) {
    result.error = 'Application config not found.';
    return result;
  }
  const targetKey = providerKey.trim();
  if (!targetKey || canonicalFreeProviderKey(targetKey) === FREE_PROVIDER_KEY || !isUsableProviderKey(appConfig, targetKey)) {
    result.error = `Provider '${providerKey}' is not usable (disabled, missing API key, or no models).`;
    return result;
  }
  const modelId = resolveProviderSeedModel(appConfig, targetKey);
  if (!modelId) {
    result.error = `Provider '${targetKey}' serves no models.`;
    return result;
  }
  result.modelId = modelId;

  const providers = appConfig.providers ?? {};
  const freeFallbackModelId = ((providers[FREE_PROVIDER_KEY] ?? providers[FREE_PROVIDER_LEGACY_KEY])?.models ?? [])
    .find((model) => typeof model?.id === 'string' && model.id)?.id ?? null;

  const bots = deps.listMetabots();
  for (const bot of bots) {
    if (!isFreePrimaryBrain(bot, appConfig)) continue;
    // Keep the free relay as the fallback brain when the bot has none: the
    // allowance resets weekly, so this fallback self-heals and covers the
    // owner's provider dying. An existing fallback brain is never touched.
    const keepFallback = (bot.fallback_llm_id ?? '').trim();
    const input: Parameters<BrainSwitchDeps['updateBot']>[1] = {
      llm_id: modelId,
      llm_provider: targetKey,
      ...(!keepFallback && freeFallbackModelId
        ? { fallback_llm_id: freeFallbackModelId, fallback_llm_provider: FREE_PROVIDER_KEY }
        : {}),
    };
    try {
      const update = await deps.updateBot(bot.id, input);
      if (update?.success) {
        result.switchedBotIds.push(bot.id);
        log(`[brain-switch] bot ${bot.id} (${bot.name}): primary brain -> '${modelId}' (provider ${targetKey})`);
      } else {
        const error = update?.error || 'unknown error';
        result.failedBots.push({ id: bot.id, name: bot.name, error });
        console.error(`[brain-switch] bot ${bot.id} (${bot.name}) update failed: ${error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failedBots.push({ id: bot.id, name: bot.name, error: message });
      console.error(`[brain-switch] bot ${bot.id} (${bot.name}) update threw: ${message}`);
    }
  }

  // Move the global default route off the free relay when it still rides it
  // (explicit metaid-free defaultProvider, or an unset provider whose default
  // model only the free relay serves) — otherwise every NEW session would
  // still default to the exhausted route the owner just switched away from.
  const modelConfig = appConfig.model ?? {};
  const defaultProvider = canonicalFreeProviderKey(modelConfig.defaultProvider);
  const defaultModel = (modelConfig.defaultModel ?? '').trim();
  const freeServesDefault = !!defaultModel
    && ((providers[FREE_PROVIDER_KEY] ?? providers[FREE_PROVIDER_LEGACY_KEY])?.models ?? []).some((model) => model?.id === defaultModel);
  const defaultRidesFree = defaultProvider === FREE_PROVIDER_KEY || (!defaultProvider && freeServesDefault);
  if (defaultRidesFree) {
    try {
      deps.mutateAppConfig((current) => ({
        ...current,
        model: {
          ...(current.model ?? {}),
          defaultModel: modelId,
          defaultProvider: targetKey,
        },
      }));
      result.defaultRouteUpdated = true;
      log(`[brain-switch] app default route -> '${modelId}' (provider ${targetKey})`);
    } catch (error) {
      console.error('[brain-switch] default route update failed (non-fatal):', error);
    }
  }

  const targetBotCount = bots.filter((bot) => isFreePrimaryBrain(bot, appConfig)).length;
  result.success = result.failedBots.length === 0 && (targetBotCount === 0 || result.switchedBotIds.length > 0);
  if (!result.success) {
    result.error = `Failed to switch ${result.failedBots.length} bot(s): ${result.failedBots.map((bot) => `${bot.name}: ${bot.error}`).join('; ')}`;
  }
  log(
    `[brain-switch] done: ${result.switchedBotIds.length} switched to ${targetKey}, ` +
    `${result.failedBots.length} failed, defaultRouteUpdated=${result.defaultRouteUpdated}`,
  );
  return result;
}
