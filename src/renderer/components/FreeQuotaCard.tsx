/**
 * Free LLM provider card for the Model settings tab — ME 口径 (S9 §4 区块2).
 *
 * The built-in IDBots-free provider is the free-tier carrier; its numbers
 * are the ME weekly grant from /v1/me/balance (「免费档 · {amount} ME/周」
 * with remaining progress + reset countdown). NO token counts appear here
 * anymore (the old relay token quota display is retired with S9; the relay
 * quota call remains ONLY to silently keep the provider's model catalog in
 * sync with the server directory).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../services/i18n';
import { enableFreeQuotaManually, syncFreeProviderCatalogFromQuota } from '../services/llmFreeQuotaBootstrap';
import { isFreeProviderConfigured, LLM_FREE_PROVIDER_KEY } from '../services/llmFreeQuotaGate.js';
import type { AppConfig } from '../config';
import {
  ensureMeSnapshot,
  formatMe,
  getMeSnapshot,
  meFromMilli,
  meResetCountdownHours,
  subscribeMeSnapshot,
} from './me/mePointsStore';

interface FreeQuotaCardProps {
  providers: NonNullable<AppConfig['providers']>;
  /**
   * Called after the stored config changed underneath the card — a successful
   * manual enable, or a background catalog sync that refreshed provider.models
   * from the quota response's relay directory — so the parent can reload
   * config/redux.
   */
  onProvisioned: () => void;
}

const FreeQuotaCard: React.FC<FreeQuotaCardProps> = ({ providers, onProvisioned }) => {
  const provider = providers[LLM_FREE_PROVIDER_KEY];
  const configured = isFreeProviderConfigured(provider);
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    ensureMeSnapshot();
  }, []);

  // Catalog-only refresh: keeps provider.models aligned with the relay's
  // server directory. Silent on failure and never re-bootstraps (that would
  // reissue the key). Never renders any token number (S9 口径).
  const syncCatalog = useCallback(async (apiKey: string) => {
    if (!apiKey) return;
    try {
      const response = await window.electron.llmRelay.getQuota({ apiKey, forceRefresh: false });
      if (response?.success && response.quota) {
        if (await syncFreeProviderCatalogFromQuota(response.quota)) {
          onProvisioned();
        }
      }
    } catch {
      // silent by design
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

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await window.electron.mePoints.getBalance({ forceRefresh: true });
    } finally {
      setRefreshing(false);
    }
    if (provider.apiKey) void syncCatalog(provider.apiKey);
  }, [provider.apiKey, syncCatalog]);

  const weekly = snapshot.balance?.weeklyGrant;
  const grantMe = meFromMilli(weekly?.amountMilli);
  const remainingMe = meFromMilli(weekly?.remainingMilli);
  const resetHours = weekly ? meResetCountdownHours(weekly.nextResetAt) : null;
  const resetLine = resetHours === null
    ? ''
    : resetHours === 0
      ? i18nService.t('mePanelResetSoon')
      : resetHours <= 24
        ? i18nService.t('freeQuotaResetCountdownHours').replace('{n}', String(resetHours))
        : i18nService.t('freeQuotaResetCountdown').replace('{n}', String(Math.ceil(resetHours / 24)));
  const grantRatio = grantMe > 0 ? Math.max(0, Math.min(100, (remainingMe / grantMe) * 100)) : 0;
  const runningLow = grantMe > 0 && remainingMe / grantMe < 0.1;

  return (
    <div className="mb-2 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('freeQuotaTitle')}
        </span>
        {configured && (
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="text-[11px] text-claude-accent hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {i18nService.t('freeQuotaRefresh')}
          </button>
        )}
      </div>

      {configured ? (
        <div className="mt-2 space-y-1.5">
          {snapshot.balance ? (
            <>
              <div className="h-1.5 w-full rounded-full dark:bg-claude-darkBorder bg-claude-border overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${runningLow ? 'bg-amber-500' : 'bg-claude-accent'}`}
                  style={{ width: `${grantRatio}%` }}
                />
              </div>
              <p className="text-[12px] tabular-nums dark:text-claude-darkText text-claude-text">
                {i18nService.t('freeQuotaMeWeekly').replace('{remaining}', formatMe(remainingMe)).replace('{total}', formatMe(grantMe))}
                {resetLine ? (
                  <span className="ml-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{resetLine}</span>
                ) : null}
              </p>
              {runningLow && (
                <p className="text-[11px] text-amber-500">{i18nService.t('freeQuotaMeLowWarning')}</p>
              )}
            </>
          ) : (
            <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('freeQuotaMeUnavailable')}
            </p>
          )}
        </div>
      ) : (
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
      )}
    </div>
  );
};

export default FreeQuotaCard;
