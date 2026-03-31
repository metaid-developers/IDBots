import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShoppingBagIcon, ArrowPathIcon, MagnifyingGlassIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { GigSquareService } from '../../types/gigSquare';
import { fetchMetaidInfoByGlobalId, type MetaidInfoResult } from '../../services/metabotInfoService';
import { formatGigSquarePrice } from '../../utils/gigSquare';
import GigSquareOrderModal from './GigSquareOrderModal';
import GigSquareMyServicesModal from './GigSquareMyServicesModal';
import GigSquarePublishModal from './GigSquarePublishModal';
import {
  copyGigSquareProviderIdToClipboard,
  DEFAULT_GIG_SQUARE_PROVIDER_AVATAR,
  getGigSquareProviderAvatarSrc,
  getGigSquareProviderDisplayName,
  shortenGigSquareProviderGlobalMetaId,
} from './gigSquareProviderPresentation.js';
import {
  getGigSquareRefundRiskBadge,
  shouldHideRiskyGigSquareService,
} from './gigSquareRefundRiskPresentation.js';

const showToastMessage = (message: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const GigSquareProviderIdRow: React.FC<{
  providerId: string | null | undefined;
}> = ({ providerId }) => {
  const normalizedProviderId = String(providerId || '').trim();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
    const didCopy = await copyGigSquareProviderIdToClipboard(normalizedProviderId, clipboard);
    if (!didCopy) return;
    setCopied(true);
    showToastMessage(i18nService.t('gigSquareProviderIdCopied'));
    window.setTimeout(() => setCopied(false), 1600);
  }, [normalizedProviderId]);

  if (!normalizedProviderId) return null;

  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
      <span className="truncate text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
        {shortenGigSquareProviderGlobalMetaId(normalizedProviderId)}
      </span>
      <button
        type="button"
        onClick={(event) => void handleCopy(event)}
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-claude-border text-claude-textSecondary transition hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover ${
          copied ? 'text-claude-accent' : ''
        }`}
        title={i18nService.t('copyToClipboard')}
        aria-label={i18nService.t('copyToClipboard')}
      >
        <DocumentDuplicateIcon className="h-3 w-3" />
      </button>
    </div>
  );
};

const GigSquareView: React.FC = () => {
  const [services, setServices] = useState<GigSquareService[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<GigSquareService | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [isMyServicesModalOpen, setIsMyServicesModalOpen] = useState(false);
  const [buyerMetabotId, setBuyerMetabotId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currencyFilter, setCurrencyFilter] = useState<'all' | 'BTC' | 'SPACE' | 'DOGE'>('all');
  const [sortOrder, setSortOrder] = useState<'rating' | 'updated'>('rating');
  const [providerInfoMap, setProviderInfoMap] = useState<Record<string, MetaidInfoResult>>({});
  const [onlineBots, setOnlineBots] = useState<Record<string, number>>({});

  const loadServices = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await window.electron.gigSquare.fetchServices();
      if (res?.success) {
        const list = Array.isArray(res.list) ? res.list : [];
        setServices(list);
      } else {
        setError(res?.error || i18nService.t('gigSquareLoadFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('gigSquareLoadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadMetabot = useCallback(async () => {
    try {
      const res = await window.electron.idbots.getMetaBots();
      if (res?.success && res.list) {
        const twin = res.list.find((item) => item.metabot_type === 'twin');
        setBuyerMetabotId(twin?.id || null);
      }
    } catch {
      setBuyerMetabotId(null);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await window.electron.gigSquare.syncFromRemote();
    } catch {
      // Sync failure: still load from DB
    }
    await loadServices();
  }, [loadServices]);

  useEffect(() => {
    loadServices();
    loadMetabot();
  }, [loadServices, loadMetabot]);

  useEffect(() => {
    let cancelled = false;

    window.electron.heartbeat.getDiscoverySnapshot().then((res) => {
      if (cancelled || !res.success || !res.snapshot) return;
      setOnlineBots(res.snapshot.onlineBots);
    }).catch(() => {
      if (!cancelled) {
        setOnlineBots({});
      }
    });

    const unsubscribe = window.electron.heartbeat.onDiscoveryChanged((snapshot) => {
      if (!cancelled) {
        setOnlineBots(snapshot.onlineBots ?? {});
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const providerIds = Array.from(new Set(
      services
        .map((service) => (service.providerGlobalMetaId || '').trim())
        .filter(Boolean)
    ));
    const missingIds = providerIds.filter((id) => !(id in providerInfoMap));
    if (!missingIds.length) return;

    let cancelled = false;
    Promise.all(
      missingIds.map(async (id) => {
        try {
          const info = await fetchMetaidInfoByGlobalId(id);
          return [id, info] as const;
        } catch {
          return [id, {}] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setProviderInfoMap((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, info] of entries) {
          if (id in next) continue;
          next[id] = info;
          changed = true;
        }
        return changed ? next : prev;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [services, providerInfoMap]);

  const handleOpenModal = (service: GigSquareService) => {
    setSelectedService(service);
    setIsModalOpen(true);
  };

  const visibleServices = useMemo(
    () => services.filter((service) => !shouldHideRiskyGigSquareService(service.refundRisk)),
    [services]
  );

  const heroStats = useMemo(() => {
    if (!visibleServices.length) return null;
    return `${visibleServices.length} ${visibleServices.length === 1 ? 'service' : 'services'}`;
  }, [visibleServices.length]);

  const filteredServices = useMemo(() => {
    let list = visibleServices;
    if (currencyFilter !== 'all') {
      const match = currencyFilter === 'SPACE'
        ? (s: GigSquareService) => { const c = s.currency?.toUpperCase(); return c === 'SPACE' || c === 'MVC'; }
        : (s: GigSquareService) => s.currency?.toUpperCase() === currencyFilter;
      list = list.filter(match);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((s) => s.displayName.toLowerCase().includes(q));
    }
    if (sortOrder === 'rating') {
      list = [...list].sort((a, b) => {
        const isOnlineA = onlineBots[a.providerGlobalMetaId] ? 1 : 0;
        const isOnlineB = onlineBots[b.providerGlobalMetaId] ? 1 : 0;
        if (isOnlineB !== isOnlineA) return isOnlineB - isOnlineA;
        return (b.ratingCount ?? 0) - (a.ratingCount ?? 0);
      });
    } else {
      list = [...list].sort((a, b) => {
        const isOnlineA = onlineBots[a.providerGlobalMetaId] ? 1 : 0;
        const isOnlineB = onlineBots[b.providerGlobalMetaId] ? 1 : 0;
        if (isOnlineB !== isOnlineA) return isOnlineB - isOnlineA;
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      });
    }
    return list;
  }, [visibleServices, searchQuery, currencyFilter, sortOrder, onlineBots]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-claude-border dark:border-claude-darkBorder">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-claude-accent/15 flex items-center justify-center">
              <ShoppingBagIcon className="h-5 w-5 text-claude-accent" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                  {i18nService.t('gigSquareTitle')}
                </h1>
                <span
                  className="rounded px-0.5 py-px text-[9px] font-medium leading-none text-claude-textSecondary dark:text-claude-darkTextSecondary border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted"
                  title={i18nService.t('gigSquareAlphaNotice')}
                >
                  {i18nService.t('gigSquareAlphaBadge')}
                </span>
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
                {i18nService.t('gigSquareSubtitle')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {heroStats && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {heroStats}
              </span>
            )}
            <button
              type="button"
              onClick={() => setIsMyServicesModalOpen(true)}
              className="btn-idchat-primary whitespace-nowrap px-3 py-1.5 text-xs font-medium"
            >
              {i18nService.t('gigSquareMyServicesButton')}
            </button>
            <button
              type="button"
              onClick={() => setIsPublishModalOpen(true)}
              className="btn-idchat-primary whitespace-nowrap px-3 py-1.5 text-xs font-medium"
            >
              {i18nService.t('gigSquarePublishButton')}
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              <ArrowPathIcon className="h-4 w-4" />
              {i18nService.t('refresh')}
            </button>
          </div>
        </div>
        {!buyerMetabotId && (
          <div className="mt-3 text-xs text-amber-500">
            {i18nService.t('gigSquareNoTwin')}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-claude-border bg-claude-surfaceMuted/70 p-2 dark:border-claude-darkBorder dark:bg-claude-darkSurfaceMuted/70">
          <select
            value={currencyFilter}
            onChange={(e) => setCurrencyFilter(e.target.value as typeof currencyFilter)}
            className="h-9 shrink-0 rounded-lg border border-claude-border bg-[var(--bg-panel)] pl-3 pr-8 text-sm text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-accent dark:border-claude-darkBorder dark:bg-claude-darkSurface dark:text-claude-darkText cursor-pointer"
          >
            <option value="all">{i18nService.t('gigSquareCurrencyAll')}</option>
            <option value="BTC">BTC</option>
            <option value="SPACE">SPACE</option>
            <option value="DOGE">DOGE</option>
          </select>
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}
            className="h-9 shrink-0 rounded-lg border border-claude-border bg-[var(--bg-panel)] pl-3 pr-8 text-sm text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-accent dark:border-claude-darkBorder dark:bg-claude-darkSurface dark:text-claude-darkText cursor-pointer"
          >
            <option value="rating">{i18nService.t('gigSquareSortRating')}</option>
            <option value="updated">{i18nService.t('gigSquareSortUpdated')}</option>
          </select>
          <div className="relative min-w-[240px] flex-1">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={i18nService.t('gigSquareSearchPlaceholder')}
              className="h-9 w-full rounded-lg border border-claude-border bg-[var(--bg-panel)] pl-9 pr-3 text-sm text-claude-text placeholder-claude-textSecondary focus:outline-none focus:ring-1 focus:ring-claude-accent dark:border-claude-darkBorder dark:bg-claude-darkSurface dark:text-claude-darkText dark:placeholder-claude-darkTextSecondary"
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('gigSquareLoading')}
          </div>
        )}
        {!isLoading && error && (
          <div className="text-sm text-red-500">
            {error}
          </div>
        )}
        {!isLoading && !error && visibleServices.length === 0 && (
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('gigSquareNoServices')}
          </div>
        )}
        {!isLoading && !error && visibleServices.length > 0 && filteredServices.length === 0 && (
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('gigSquareNoSearchResults')}
          </div>
        )}
        {!isLoading && !error && filteredServices.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredServices.map((service) => {
              const price = formatGigSquarePrice(service.price, service.currency);
              const iconSrc = service.serviceIcon || service.avatar || null;
              const providerLookupId = service.providerGlobalMetaId || service.providerMetaId;
              const providerInfo = providerInfoMap[service.providerGlobalMetaId] || {};
              const providerName = getGigSquareProviderDisplayName(providerInfo, providerLookupId);
              const providerAvatarSrc = getGigSquareProviderAvatarSrc(providerInfo);
              const refundRiskBadge = getGigSquareRefundRiskBadge(service.refundRisk);
              const hasRefundRisk = Boolean(refundRiskBadge);
              const isOnline = Boolean(onlineBots[service.providerGlobalMetaId]);
              return (
                <div
                  key={service.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpenModal(service)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleOpenModal(service);
                    }
                  }}
                  className={`cursor-pointer rounded-2xl border px-4 py-4 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${
                    hasRefundRisk
                      ? 'border-amber-400/60 bg-[var(--bg-panel)] dark:bg-claude-darkSurface'
                      : 'dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface'
                  } ${''}`}
                >
                  <div className="flex items-start gap-3">
                    {iconSrc ? (
                      <img
                        src={iconSrc}
                        alt={service.displayName}
                        className="h-14 w-14 flex-shrink-0 rounded-xl border border-claude-border object-cover dark:border-claude-darkBorder"
                      />
                    ) : (
                      <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-claude-accent/20 text-sm font-semibold text-claude-accent">
                        {service.displayName.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[15px] font-semibold text-claude-text dark:text-claude-darkText">
                            {service.displayName}
                          </div>
                          <div className="mt-1 truncate font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                            {service.serviceName}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                            {price.unit}
                          </div>
                          <div className="text-base font-semibold text-claude-accent">
                            {price.amount}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {service.providerSkill && (
                          <span className="rounded-full bg-claude-surfaceMuted px-2 py-0.5 text-[11px] font-medium text-claude-textSecondary dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary">
                            {service.providerSkill}
                          </span>
                        )}
                        {refundRiskBadge && (
                          <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                            {i18nService.t('gigSquareRefundRiskBadge')}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 line-clamp-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {service.description}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-claude-border/70 pt-3 dark:border-claude-darkBorder/70">
                    <div className="min-w-0 flex items-center gap-2">
                      {isOnline && (
                        <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" title={i18nService.t('botOnline')} />
                      )}
                      <img
                        src={providerAvatarSrc}
                        alt={providerName}
                        className="h-7 w-7 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder flex-shrink-0"
                        onError={(e) => { e.currentTarget.src = DEFAULT_GIG_SQUARE_PROVIDER_AVATAR; }}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-claude-text dark:text-claude-darkText">
                          {providerName}
                        </div>
                        {providerLookupId && (
                          <GigSquareProviderIdRow providerId={providerLookupId} />
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenModal(service);
                      }}
                      className="btn-idchat-primary-filled shrink-0 whitespace-nowrap px-3 py-1.5 text-[11px] font-medium"
                    >
                      {i18nService.t('gigSquarePayAndRequest')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <GigSquarePublishModal
        isOpen={isPublishModalOpen}
        onClose={() => setIsPublishModalOpen(false)}
        onPublished={loadServices}
      />

      <GigSquareMyServicesModal
        isOpen={isMyServicesModalOpen}
        onClose={() => setIsMyServicesModalOpen(false)}
        onOpenPublish={() => {
          setIsMyServicesModalOpen(false);
          setIsPublishModalOpen(true);
        }}
      />

      <GigSquareOrderModal
        service={selectedService}
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedService(null);
        }}
        buyerMetabotId={buyerMetabotId}
      />
    </div>
  );
};

export default GigSquareView;
