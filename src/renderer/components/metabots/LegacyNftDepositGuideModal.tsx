/**
 * Legacy Collectibles Deposit Guide Modal (REQ-A-06)
 *
 * Guides returning collectors through transferring legacy MetaContract items
 * from an old wallet (e.g. Metalet) to this MetaBot's MVC address, lists the
 * CA-certified swap series from the official registry, and offers a one-click
 * button that prefills the Cowork chat composer with the free upgrade prompt.
 */

import React, { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  CheckBadgeIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  EMPTY_NFT_CA_REGISTRY,
  getNftCaRegistryCached,
  type NftCaOfficialBotEntry,
  type NftCaRegistry,
} from '../../services/nftCaRegistryService';
import type { Metabot } from '../../types/metabot';

export interface CertifiedLegacySeriesItem {
  key: string;
  collectionSlug: string;
  title: string;
  targetCollectionPinId: string;
  codehash: string;
  genesis: string;
  stationGlobalMetaId: string;
  badgeLabel: string;
  minConfirmations: number;
}

export function extractCertifiedLegacySeries(registry: NftCaRegistry): CertifiedLegacySeriesItem[] {
  if (!registry || !registry.verified) return [];

  const collectionsByPinId = new Map(
    (registry.collections || []).map((col) => [col.collectionPinId, col]),
  );
  const activeStations = (registry.officialBots || []).filter(
    (bot): bot is NftCaOfficialBotEntry =>
      bot.role === 'swap_station' && bot.active === true && Boolean(bot.swapConfig?.vaultAddress),
  );
  const stationByGlobalMetaId = new Map(activeStations.map((bot) => [bot.globalMetaId, bot]));

  const items: CertifiedLegacySeriesItem[] = [];
  const seen = new Set<string>();

  for (const station of activeStations) {
    const seriesList = station.swapConfig?.supportedSeries || [];
    for (const series of seriesList) {
      const codehash = series.codehash?.trim();
      const genesis = series.genesis?.trim();
      if (!codehash || !genesis) continue;
      const dedupeKey = `${codehash}:${genesis}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const matchedCol = collectionsByPinId.get(series.targetCollectionPinId);
      const title =
        matchedCol?.displayTitle?.trim() ||
        matchedCol?.collectionName?.trim() ||
        series.collectionSlug ||
        series.targetCollectionPinId;

      items.push({
        key: dedupeKey,
        collectionSlug: series.collectionSlug,
        title,
        targetCollectionPinId: series.targetCollectionPinId,
        codehash,
        genesis,
        stationGlobalMetaId: station.globalMetaId,
        badgeLabel: station.badgeLabel || i18nService.t('legacyDepositGuideOfficialBadge'),
        minConfirmations: series.minConfirmations ?? 1,
      });
    }
  }

  // Fallback for registries that declare legacySeries on collections pointing to an active station.
  for (const col of registry.collections || []) {
    if (!col.legacySeries?.codehash || !col.legacySeries?.genesis) continue;
    const dedupeKey = `${col.legacySeries.codehash}:${col.legacySeries.genesis}`;
    if (seen.has(dedupeKey)) continue;
    const stationId = col.legacySeries.swapStationGlobalMetaId?.trim() || '';
    const station = stationId ? stationByGlobalMetaId.get(stationId) : activeStations[0];
    if (!station) continue;
    seen.add(dedupeKey);
    items.push({
      key: dedupeKey,
      collectionSlug: col.collectionName || col.collectionPinId,
      title: col.displayTitle?.trim() || col.collectionName?.trim() || col.collectionPinId,
      targetCollectionPinId: col.collectionPinId,
      codehash: col.legacySeries.codehash,
      genesis: col.legacySeries.genesis,
      stationGlobalMetaId: station.globalMetaId,
      badgeLabel: station.badgeLabel || i18nService.t('legacyDepositGuideOfficialBadge'),
      minConfirmations: 1,
    });
  }

  return items;
}

interface LegacyNftDepositGuideModalProps {
  isOpen: boolean;
  metabot: Metabot;
  onClose: () => void;
  onStartUpgradeChat?: () => void;
}

const LegacyNftDepositGuideModal: React.FC<LegacyNftDepositGuideModalProps> = ({
  isOpen,
  metabot,
  onClose,
  onStartUpgradeChat,
}) => {
  const [registry, setRegistry] = useState<NftCaRegistry>(EMPTY_NFT_CA_REGISTRY);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  const mvcAddress = (metabot.mvc_address || '').trim();

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setRegistryLoading(true);
    void getNftCaRegistryCached()
      .then((res) => {
        if (!cancelled) setRegistry(res);
      })
      .finally(() => {
        if (!cancelled) setRegistryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !mvcAddress) {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(mvcAddress, { margin: 1, width: 176 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, mvcAddress]);

  const certifiedSeries = useMemo(() => extractCertifiedLegacySeries(registry), [registry]);

  if (!isOpen) return null;

  const handleCopyAddress = () => {
    if (!mvcAddress) return;
    void navigator.clipboard.writeText(mvcAddress).catch(() => {});
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAddressCopied') }));
  };

  const handleStartUpgrade = () => {
    const promptText = i18nService.t('legacyDepositGuidePromptText');
    window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: promptText } }));
    onStartUpgradeChat?.();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        data-slot="legacy-deposit-guide-modal"
        className="relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b dark:border-claude-darkBorder border-claude-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('legacyDepositGuideTitle')}
              </h2>
              {registry.verified && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
                  <CheckBadgeIcon className="h-3.5 w-3.5" />
                  {i18nService.t('legacyDepositGuideOfficialBadge')}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('legacyDepositGuideSubtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[8px] p-1.5 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Step 1: Twin MVC Address & QR */}
          <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4">
            <div className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('legacyDepositGuideStep1Title')}
            </div>
            <p className="mt-1 text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('legacyDepositGuideStep1Desc')}
            </p>

            {mvcAddress ? (
              <div className="mt-3 flex flex-col items-center gap-3 sm:flex-row sm:items-center">
                {qrDataUrl && (
                  <div className="shrink-0 rounded-xl border bg-white p-2 dark:border-claude-darkBorder border-claude-border">
                    <img
                      src={qrDataUrl}
                      alt={mvcAddress}
                      className="h-32 w-32"
                    />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {metabot.name} · MVC
                  </div>
                  <div className="break-all rounded-lg border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkBg px-3 py-2 font-mono text-xs dark:text-claude-darkText text-claude-text">
                    {mvcAddress}
                  </div>
                  <button
                    type="button"
                    data-slot="legacy-deposit-copy-address"
                    onClick={handleCopyAddress}
                    className="inline-flex items-center gap-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs font-medium dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  >
                    <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                    {i18nService.t('metabotCopyAddress')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                {i18nService.t('legacyDepositGuideNoAddress')}
              </p>
            )}
          </div>

          {/* Step 2: CA-Certified Supported Series */}
          <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('legacyDepositGuideSeriesTitle')}
              </div>
              {registryLoading && (
                <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  ...
                </span>
              )}
            </div>

            {!registryLoading && !registry.verified && (
              <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{i18nService.t('legacyDepositGuideCaUnverified')}</span>
              </div>
            )}

            {!registryLoading && registry.verified && certifiedSeries.length === 0 && (
              <p className="mt-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('legacyDepositGuideNoSeries')}
              </p>
            )}

            {certifiedSeries.length > 0 && (
              <div className="mt-2.5 space-y-2">
                {certifiedSeries.map((series) => (
                  <div
                    key={series.key}
                    data-slot="legacy-deposit-series-item"
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkBg px-3 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold dark:text-claude-darkText text-claude-text">
                        {series.title}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                        <CheckBadgeIcon className="h-3 w-3" />
                        {series.badgeLabel}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      <span>{series.collectionSlug}</span>
                      <span>CodeHash: {series.codehash.slice(0, 10)}…</span>
                      <span>Genesis: {series.genesis.slice(0, 10)}…</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer CTA */}
        <div className="flex items-center justify-end gap-2 border-t dark:border-claude-darkBorder border-claude-border px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3.5 py-2 text-xs font-medium dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            {i18nService.t('close')}
          </button>
          <button
            type="button"
            data-slot="legacy-deposit-start-upgrade"
            onClick={handleStartUpgrade}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--btn-primary-edge)] bg-claude-accent px-4 py-2 text-xs font-semibold text-claude-accentInk hover:opacity-90"
          >
            <SparklesIcon className="h-4 w-4" />
            {i18nService.t('legacyDepositGuideUpgradeButton')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LegacyNftDepositGuideModal;
