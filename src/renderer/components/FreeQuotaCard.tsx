import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../services/i18n';
import { enableFreeQuotaManually, syncFreeProviderCatalogFromQuota } from '../services/llmFreeQuotaBootstrap';
import { isFreeProviderConfigured, LLM_FREE_PROVIDER_KEY } from '../services/llmFreeQuotaGate.js';
import type { AppConfig } from '../config';

interface FreeQuotaCardProps {
  providers: NonNullable<AppConfig['providers']>;
  onProvisioned: () => void;
}

/**
 * Keeps the IDBots catalog synchronized and offers manual provisioning only
 * when the built-in provider is not configured. Plan and quota presentation
 * lives in IdbotsPlanCard so the two surfaces never repeat the same numbers.
 */
const FreeQuotaCard: React.FC<FreeQuotaCardProps> = ({ providers, onProvisioned }) => {
  const provider = providers[LLM_FREE_PROVIDER_KEY];
  const configured = isFreeProviderConfigured(provider);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  const syncCatalog = useCallback(async (apiKey: string) => {
    if (!apiKey) return;
    try {
      const response = await window.electron.llmRelay.getQuota({ apiKey, forceRefresh: false });
      if (response?.success && response.quota && await syncFreeProviderCatalogFromQuota(response.quota)) {
        onProvisioned();
      }
    } catch {
      // Catalog sync is best-effort; the existing catalog remains usable.
    }
  }, [onProvisioned]);

  useEffect(() => {
    if (configured && provider.apiKey) void syncCatalog(provider.apiKey);
  }, [configured, provider.apiKey, syncCatalog]);

  const handleEnable = useCallback(async () => {
    setEnabling(true);
    setEnableError(null);
    const result = await enableFreeQuotaManually();
    setEnabling(false);
    if (result.success) {
      onProvisioned();
    } else {
      setEnableError(result.error ?? 'unknown error');
    }
  }, [onProvisioned]);

  if (configured) return null;

  return (
    <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface p-2.5">
      <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
        {i18nService.t('freeQuotaTitle')}
      </span>
      <div className="mt-2 space-y-1.5">
        <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('freeQuotaEnableHint')}
        </p>
        <button
          type="button"
          onClick={() => void handleEnable()}
          disabled={enabling}
          className="btn-idchat-primary-filled inline-flex items-center justify-center px-2 py-1 text-[11px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {enabling ? i18nService.t('freeQuotaEnabling') : i18nService.t('freeQuotaEnable')}
        </button>
        {enableError && (
          <p className="text-[11px] text-red-500">
            {i18nService.t('freeQuotaEnableFailed').replace('{error}', enableError)}
          </p>
        )}
      </div>
    </div>
  );
};

export default FreeQuotaCard;
