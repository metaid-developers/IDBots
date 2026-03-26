import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShoppingBagIcon, ArrowPathIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { GigSquareService } from '../../types/gigSquare';
import { fetchMetaidInfoByGlobalId, type MetaidInfoResult } from '../../services/metabotInfoService';
import { formatGigSquarePrice } from '../../utils/gigSquare';
import GigSquareOrderModal from './GigSquareOrderModal';
import GigSquareMyServicesModal from './GigSquareMyServicesModal';
import GigSquarePublishModal from './GigSquarePublishModal';
import {
  DEFAULT_GIG_SQUARE_PROVIDER_AVATAR,
  getGigSquareProviderAvatarSrc,
  getGigSquareProviderDisplayName,
} from './gigSquareProviderPresentation.js';
import {
  getGigSquareRefundRiskBadge,
  shouldHideRiskyGigSquareService,
} from './gigSquareRefundRiskPresentation.js';

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
      list = [...list].sort((a, b) => (b.ratingCount ?? 0) - (a.ratingCount ?? 0));
    } else {
      list = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    return list;
  }, [visibleServices, searchQuery, currencyFilter, sortOrder]);

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
          <div className="flex items-center gap-3">
            {heroStats && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {heroStats}
              </span>
            )}
            <button
              type="button"
              onClick={() => setIsMyServicesModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
            >
              {i18nService.t('gigSquareMyServicesButton')}
            </button>
            <button
              type="button"
              onClick={() => setIsPublishModalOpen(true)}
              className="btn-idchat-primary px-3 py-1.5 text-xs font-medium"
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
        <div className="mt-3 flex items-center gap-2">
          <select
            value={currencyFilter}
            onChange={(e) => setCurrencyFilter(e.target.value as typeof currencyFilter)}
            className="shrink-0 pl-2 pr-6 py-1.5 text-xs rounded-lg border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted text-claude-text dark:text-claude-darkText focus:outline-none focus:ring-1 focus:ring-claude-accent appearance-none cursor-pointer"
          >
            <option value="all">{i18nService.t('gigSquareCurrencyAll')}</option>
            <option value="BTC">BTC</option>
            <option value="SPACE">SPACE</option>
            <option value="DOGE">DOGE</option>
          </select>
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}
            className="shrink-0 pl-2 pr-6 py-1.5 text-xs rounded-lg border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted text-claude-text dark:text-claude-darkText focus:outline-none focus:ring-1 focus:ring-claude-accent appearance-none cursor-pointer"
          >
            <option value="rating">{i18nService.t('gigSquareSortRating')}</option>
            <option value="updated">{i18nService.t('gigSquareSortUpdated')}</option>
          </select>
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-claude-textSecondary dark:text-claude-darkTextSecondary pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={i18nService.t('gigSquareSearchPlaceholder')}
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted text-claude-text dark:text-claude-darkText placeholder-claude-textSecondary dark:placeholder-claude-darkTextSecondary focus:outline-none focus:ring-1 focus:ring-claude-accent"
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
                  className={`text-left rounded-2xl border px-4 py-4 hover:shadow-lg hover:-translate-y-0.5 transition cursor-pointer ${
                    hasRefundRisk
                      ? 'border-red-500/40 bg-red-500/[0.06] dark:bg-red-500/[0.08]'
                      : 'dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                          {service.displayName}
                        </div>
                        {refundRiskBadge && (
                          <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                            {i18nService.t('gigSquareRefundRiskBadge')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary ">
                        {service.description}
                      </div>
                    </div>
                    {iconSrc ? (
                      <img
                        src={iconSrc}
                        alt={service.displayName}
                        className="h-16 w-16 rounded-lg object-cover border border-claude-border dark:border-claude-darkBorder flex-shrink-0"
                      />
                    ) : (
                      <div className="h-16 w-16 rounded-lg bg-claude-accent/20 flex items-center justify-center text-sm font-semibold text-claude-accent flex-shrink-0">
                        {service.displayName.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div>
                      <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('gigSquareOrderService')}
                      </div>
                      <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                        {service.serviceName}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {price.unit}
                      </div>
                      <div className="text-sm font-semibold text-claude-accent">
                        {price.amount}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <div className="min-w-0 flex items-center gap-2">
                      <img
                        src={providerAvatarSrc}
                        alt={providerName}
                        className="h-6 w-6 rounded-full object-cover border border-claude-border dark:border-claude-darkBorder flex-shrink-0"
                        onError={(e) => { e.currentTarget.src = DEFAULT_GIG_SQUARE_PROVIDER_AVATAR; }}
                      />
                      <span className="min-w-0 truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {providerName}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenModal(service);
                      }}
                      className="btn-idchat-primary-filled px-3 py-1.5 text-xs font-medium"
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
