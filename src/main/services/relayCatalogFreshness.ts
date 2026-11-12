import type { SqliteStore } from '../sqliteStore';
import type { LlmRelayModelInfo, LlmRelayQuotaInfo } from './llmRelayService';
import {
  canonicalFreeProviderKey,
  isFreeProviderConfigured,
  LLM_FREE_PROVIDER_KEY,
  LLM_FREE_PROVIDER_LEGACY_KEY,
  planFreeProviderCatalogSync,
} from '../../renderer/services/llmFreeQuotaGate.js';

export const RELAY_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

type AppConfig = Record<string, any>;

/** The free-relay provider entry under its stored key (canonical or pre-rename legacy). */
function freeProviderEntry(providers: Record<string, any> | undefined): { key: string; provider: any } | null {
  for (const key of [LLM_FREE_PROVIDER_KEY, LLM_FREE_PROVIDER_LEGACY_KEY]) {
    const provider = providers?.[key];
    if (provider) return { key, provider };
  }
  return null;
}

export type RelayCatalogRefreshResult =
  | { status: 'updated'; modelCount: number }
  | { status: 'unchanged'; modelCount: number }
  | { status: 'skipped'; reason: 'store-unavailable' | 'provider-unconfigured' | 'credential-changed' };

export interface RelayCatalogFreshnessDeps {
  getStore: () => SqliteStore | null;
  getQuota: (input: { apiKey: string; forceRefresh: boolean }) => Promise<LlmRelayQuotaInfo>;
  onChanged: () => void;
}

export function createRelayCatalogRefresh(deps: RelayCatalogFreshnessDeps): () => Promise<RelayCatalogRefreshResult> {
  let queue: Promise<void> = Promise.resolve();

  return () => {
    const run = queue.then(async (): Promise<RelayCatalogRefreshResult> => {
      const store = deps.getStore();
      if (!store) return { status: 'skipped', reason: 'store-unavailable' };
      const initial = (store.get<AppConfig>('app_config') ?? {}) as AppConfig;
      const initialEntry = freeProviderEntry(initial.providers);
      if (!initialEntry || !isFreeProviderConfigured(initialEntry.provider)) {
        return { status: 'skipped', reason: 'provider-unconfigured' };
      }
      const initialProvider = initialEntry.provider;
      const credential = initialProvider.apiKey as string;
      const quota = await deps.getQuota({ apiKey: credential, forceRefresh: true });

      const current = (store.get<AppConfig>('app_config') ?? {}) as AppConfig;
      const entry = freeProviderEntry(current.providers);
      const provider = entry?.provider;
      if (!entry || !isFreeProviderConfigured(provider) || provider.apiKey !== credential) {
        return { status: 'skipped', reason: 'credential-changed' };
      }
      const models = planFreeProviderCatalogSync(provider, quota.models as LlmRelayModelInfo[]);
      const nextModels = models ?? provider.models;
      const defaultNeedsRepair = canonicalFreeProviderKey(current.model?.defaultProvider) === LLM_FREE_PROVIDER_KEY
        && !nextModels.some((model: { id?: string }) => model.id === current.model?.defaultModel)
        && typeof nextModels[0]?.id === 'string';
      if (!models && !defaultNeedsRepair) {
        return { status: 'unchanged', modelCount: nextModels.length };
      }

      store.set('app_config', {
        ...current,
        providers: {
          ...(current.providers ?? {}),
          [entry.key]: {
            ...provider,
            models: nextModels,
          },
        },
        model: {
          ...(current.model ?? {}),
          ...(defaultNeedsRepair ? { defaultModel: nextModels[0].id } : {}),
        },
      });
      deps.onChanged();
      return { status: 'updated', modelCount: nextModels.length };
    });
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}
