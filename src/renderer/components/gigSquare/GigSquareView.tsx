import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShoppingBagIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { GigSquareService } from '../../types/gigSquare';
import { formatGigSquarePrice, getServiceIconUrl } from '../../utils/gigSquare';
import GigSquareOrderModal from './GigSquareOrderModal';
import GigSquarePublishModal from './GigSquarePublishModal';

const formatMetaId = (value: string): string => {
  if (!value) return '';
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
};

const GigSquareView: React.FC = () => {
  const [services, setServices] = useState<GigSquareService[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<GigSquareService | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [buyerMetabotId, setBuyerMetabotId] = useState<number | null>(null);

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

  const handleOpenModal = (service: GigSquareService) => {
    setSelectedService(service);
    setIsModalOpen(true);
  };

  const heroStats = useMemo(() => {
    if (!services.length) return null;
    return `${services.length} ${services.length === 1 ? 'service' : 'services'}`;
  }, [services.length]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-claude-border dark:border-claude-darkBorder">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-claude-accent/15 flex items-center justify-center">
              <ShoppingBagIcon className="h-5 w-5 text-claude-accent" />
            </div>
            <div>
              <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('gigSquareTitle')}
              </h1>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
        {!isLoading && !error && services.length === 0 && (
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('gigSquareNoServices')}
          </div>
        )}
        {!isLoading && !error && services.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {services.map((service) => {
              const price = formatGigSquarePrice(service.price, service.currency);
              const serviceIconUrl = getServiceIconUrl(service.serviceIcon);
              const iconSrc = serviceIconUrl || service.avatar || null;
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
                  className="text-left rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-4 hover:shadow-lg hover:-translate-y-0.5 transition cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                        {service.displayName}
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
                    <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {formatMetaId(service.providerGlobalMetaId || service.providerMetaId)}
                    </span>
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
