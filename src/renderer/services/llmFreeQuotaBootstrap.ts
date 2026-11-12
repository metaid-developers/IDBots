/**
 * First-run free-quota provisioning orchestration (renderer side).
 *
 * On a fresh install this silently bootstraps the free-quota relay account via
 * the main process (identity-signed; creates the local user identity when
 * missing) and writes the returned relay key/baseUrl/models into the built-in
 * `metaid-free` provider, which then becomes the default model.
 *
 * The whole flow never throws: any failure (offline, relay down, disabled
 * backend) leaves the app without a free provider — the welcome flow then
 * falls back to the user's configured default model or fails into its retry
 * UI. Idempotency comes from the written provider config: once provisioned,
 * later launches do nothing.
 */

import { configService } from './config';
import type { AppConfig } from '../config';
import {
  LLM_FREE_PROVIDER_KEY,
  LLM_FREE_PROVIDER_LEGACY_KEY,
  FREE_PROVIDER_DISPLAY_NAME,
  buildFreeProviderRelayModelRow,
  isFreeProviderConfigured,
  pickFreeProviderDefaultModelId,
  planFreeProviderCatalogSync,
  planFreeQuotaProvisioning,
} from './llmFreeQuotaGate.js';

/** Relay catalog entry as the quota/bootstrap responses report it. */
interface RelayCatalogModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Sync an already-provisioned free provider's model catalog with the relay
 * directory a quota response carried (2026-10-16: the server catalog grew
 * from the single `deepseek-chat` to a public multi-model directory, and
 * GET /v2/assist/llm/quota returns the full current list on every call).
 * planFreeQuotaProvisioning stays 'none' for provisioned installs, so this
 * quota-driven sync is the only path that moves their frozen catalog forward
 * — without a new bootstrap, which would reissue the relay key. The stored
 * defaultModel is reconciled by updateConfig's normalization: when it points
 * at an id the directory dropped (e.g. the hidden `deepseek-chat` alias), it
 * falls back to the new catalog's first model.
 *
 * Never throws; returns true only when the stored catalog was rewritten.
 */
export async function syncFreeProviderCatalogFromQuota(
  quota: { models?: RelayCatalogModel[] } | null | undefined,
): Promise<boolean> {
  try {
    const provider = configService.getConfig().providers?.[LLM_FREE_PROVIDER_KEY]
      ?? configService.getConfig().providers?.[LLM_FREE_PROVIDER_LEGACY_KEY];
    if (!isFreeProviderConfigured(provider)) {
      return false;
    }
    const models = planFreeProviderCatalogSync(provider, quota?.models);
    if (!models) {
      return false;
    }
    await configService.updateConfig({
      providers: {
        [LLM_FREE_PROVIDER_KEY]: {
          ...provider,
          models,
        },
      } as AppConfig['providers'],
    });
    return true;
  } catch (error) {
    console.warn('[llm-free-quota] catalog sync failed:', error);
    return false;
  }
}

/**
 * Manual opt-in path (Settings card): bootstrap and provision the free
 * provider without touching anything else. Used by existing installs that
 * never went through the first-run flow.
 */
export async function enableFreeQuotaManually(): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await window.electron.llmRelay.bootstrap();
    if (!response?.success || !response.result?.apiKey || !response.result?.baseUrl) {
      return { success: false, error: response?.error ?? 'empty bootstrap result' };
    }
    await provisionProviderConfig(response.result);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type LlmRelayBootstrapResult = NonNullable<Awaited<ReturnType<typeof window.electron.llmRelay.bootstrap>>['result']>;

async function provisionProviderConfig(result: LlmRelayBootstrapResult): Promise<void> {
  const config = configService.getConfig();
  // Shared relay-row merge: relay-reported limits win (per-model official
  // ceilings since the 2026-10-16 server fix), the canonical table fills
  // what the directory omits (100K output default) and adds the verified
  // vision flag + thinking options for known ids.
  const models = (result.models ?? []).map((model) => buildFreeProviderRelayModelRow(model));
  await configService.updateConfig({
    providers: {
      [LLM_FREE_PROVIDER_KEY]: {
        enabled: true,
        apiKey: result.apiKey,
        baseUrl: result.baseUrl,
        apiFormat: 'openai',
        models,
        name: FREE_PROVIDER_DISPLAY_NAME,
      },
    } as AppConfig['providers'],
    model: {
      ...config.model,
      defaultModel: pickFreeProviderDefaultModelId(models) || config.model.defaultModel,
      defaultProvider: LLM_FREE_PROVIDER_KEY,
    },
  });
}

/**
 * Silently provision the built-in free provider on a fresh install, so the
 * Twin Bot the user creates in the welcome flow starts on a working brain.
 *
 * Skips (and leaves the config untouched) when the provider is already
 * configured or the machine already holds MetaBots — an existing install is
 * never rewritten. A roster read that fails outright also skips: the plan
 * cannot distinguish a fresh install from a veteran one, and silently
 * switching a veteran's default provider is worse than not provisioning.
 */
export async function ensureFreeQuotaProvisioning(): Promise<void> {
  try {
    const provider = configService.getConfig().providers?.[LLM_FREE_PROVIDER_KEY]
      ?? configService.getConfig().providers?.[LLM_FREE_PROVIDER_LEGACY_KEY];
    let metabotCount: number | null = null;
    try {
      const metabotResult = await window.electron.metabot.list();
      if (metabotResult?.success && Array.isArray(metabotResult.list)) {
        metabotCount = metabotResult.list.length;
      }
    } catch {
      metabotCount = null;
    }
    if (metabotCount == null) {
      console.warn('[llm-free-quota] metabot roster unavailable; skipping provisioning');
      return;
    }
    const plan = planFreeQuotaProvisioning({
      metabotCount,
      providerConfigured: isFreeProviderConfigured(provider),
    });
    if (plan === 'none') {
      return;
    }
    const response = await window.electron.llmRelay.bootstrap();
    if (!response?.success || !response.result?.apiKey || !response.result?.baseUrl) {
      console.warn('[llm-free-quota] bootstrap failed:', response?.error ?? 'empty result');
      return;
    }
    await provisionProviderConfig(response.result);
  } catch (error) {
    console.warn('[llm-free-quota] provisioning failed:', error);
  }
}
