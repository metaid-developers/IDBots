import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type {
  GigSquareMyServiceOrderDetail,
  GigSquareMyServiceSummary,
  GigSquarePageResult,
} from '../../types/gigSquare';
import { formatGigSquarePrice } from '../../utils/gigSquare';
import {
  getMyServiceActionState,
  getMyServiceMetricLabel,
  getMyServiceOrderStatusClassName,
  getMyServiceOrderStatusKey,
  getMyServiceSessionActionState,
  shortenMyServiceHash,
} from './gigSquareMyServicesPresentation.js';

type GigSquareMyServicesView = 'list' | 'detail';

type SelectedServiceLike = Pick<GigSquareMyServiceSummary, 'id'> & Partial<GigSquareMyServiceSummary>;

interface GigSquareMyServicesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenPublish: () => void;
  view?: GigSquareMyServicesView;
  servicesPage?: GigSquarePageResult<GigSquareMyServiceSummary>;
  selectedService?: SelectedServiceLike | null;
  ordersPage?: GigSquarePageResult<GigSquareMyServiceOrderDetail>;
  onBackToList?: () => void;
}

const LIST_PAGE_SIZE = 8;
const DETAIL_PAGE_SIZE = 10;
const UNIX_SECONDS_MAX = 10_000_000_000;

const createEmptyPageResult = <T,>(pageSize: number): GigSquarePageResult<T> => ({
  items: [],
  page: 1,
  pageSize,
  total: 0,
  totalPages: 0,
});

const normalizeTimestampMs = (value: number | null | undefined): number | null => {
  if (!value || !Number.isFinite(value) || value <= 0) return null;
  return value < UNIX_SECONDS_MAX ? Math.trunc(value * 1000) : Math.trunc(value);
};

const formatDateTime = (value: number | null | undefined): string => {
  const normalizedValue = normalizeTimestampMs(value);
  if (!normalizedValue) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(normalizedValue);
  } catch {
    return new Date(normalizedValue).toLocaleString();
  }
};

const getServiceDisplayName = (service: SelectedServiceLike | null | undefined): string => {
  if (!service) return 'Service';
  return service.displayName?.trim() || service.serviceName?.trim() || service.id;
};

const getCounterpartyDisplayName = (order: GigSquareMyServiceOrderDetail): string => {
  return order.counterpartyName?.trim() || order.counterpartyGlobalMetaid?.trim() || '—';
};

const extractPinTxid = (pinId: string | null | undefined): string => {
  const normalizedPinId = String(pinId || '').trim();
  const match = /^([0-9a-fA-F]{64})i\d+$/i.exec(normalizedPinId);
  return match?.[1] || normalizedPinId;
};

const showTxidCopiedToast = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:showToast', {
    detail: i18nService.t('gigSquareMyServicesTxidCopied'),
  }));
};

const CopyValueButton: React.FC<{
  value: string;
}> = ({ value }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }
    await navigator.clipboard.writeText(value);
    setCopied(true);
    showTxidCopiedToast();
    window.setTimeout(() => setCopied(false), 1600);
  }, [value]);

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-claude-border text-claude-textSecondary transition hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover ${
        copied ? 'text-claude-accent' : ''
      }`}
      title={i18nService.t('copyToClipboard')}
      aria-label={i18nService.t('copyToClipboard')}
    >
      <DocumentDuplicateIcon className="h-3.5 w-3.5" />
    </button>
  );
};

const GigSquareMyServicesModal: React.FC<GigSquareMyServicesModalProps> = ({
  isOpen,
  onClose,
  onOpenPublish,
  view,
  servicesPage,
  selectedService,
  ordersPage,
  onBackToList,
}) => {
  const [internalView, setInternalView] = useState<GigSquareMyServicesView>('list');
  const [internalServicesPage, setInternalServicesPage] = useState<GigSquarePageResult<GigSquareMyServiceSummary>>(
    createEmptyPageResult<GigSquareMyServiceSummary>(LIST_PAGE_SIZE),
  );
  const [servicesPageNumber, setServicesPageNumber] = useState(1);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [internalSelectedService, setInternalSelectedService] = useState<SelectedServiceLike | null>(null);
  const [internalOrdersPage, setInternalOrdersPage] = useState<GigSquarePageResult<GigSquareMyServiceOrderDetail>>(
    createEmptyPageResult<GigSquareMyServiceOrderDetail>(DETAIL_PAGE_SIZE),
  );
  const [ordersPageNumber, setOrdersPageNumber] = useState(1);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const activeView = view ?? internalView;
  const activeServicesPage = servicesPage ?? internalServicesPage;
  const activeSelectedService = selectedService ?? internalSelectedService;
  const activeOrdersPage = ordersPage ?? internalOrdersPage;
  const detailServiceId = activeSelectedService?.id?.trim() || '';

  const loadServicesPage = useCallback(async (
    pageNumber: number,
    options?: { refresh?: boolean },
  ) => {
    if (typeof window === 'undefined' || !window.electron?.gigSquare) return;
    setServicesLoading(true);
    setServicesError(null);
    try {
      const result = await window.electron.gigSquare.fetchMyServices({
        page: pageNumber,
        pageSize: LIST_PAGE_SIZE,
        refresh: Boolean(options?.refresh),
      });
      if (result?.success && result.page) {
        setInternalServicesPage(result.page);
      } else {
        setServicesError(result?.error || i18nService.t('gigSquareMyServicesLoadFailed'));
      }
    } catch (error) {
      setServicesError(error instanceof Error ? error.message : i18nService.t('gigSquareMyServicesLoadFailed'));
    } finally {
      setServicesLoading(false);
    }
  }, []);

  const loadOrdersPage = useCallback(async (
    serviceId: string,
    pageNumber: number,
    options?: { refresh?: boolean },
  ) => {
    if (!serviceId || typeof window === 'undefined' || !window.electron?.gigSquare) return;
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const result = await window.electron.gigSquare.fetchMyServiceOrders({
        serviceId,
        page: pageNumber,
        pageSize: DETAIL_PAGE_SIZE,
        refresh: Boolean(options?.refresh),
      });
      if (result?.success && result.page) {
        setInternalOrdersPage(result.page);
      } else {
        setOrdersError(result?.error || i18nService.t('gigSquareMyServicesOrdersLoadFailed'));
      }
    } catch (error) {
      setOrdersError(error instanceof Error ? error.message : i18nService.t('gigSquareMyServicesOrdersLoadFailed'));
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      return;
    }
    setInternalView('list');
    setInternalServicesPage(createEmptyPageResult<GigSquareMyServiceSummary>(LIST_PAGE_SIZE));
    setServicesPageNumber(1);
    setServicesLoading(false);
    setServicesError(null);
    setInternalSelectedService(null);
    setInternalOrdersPage(createEmptyPageResult<GigSquareMyServiceOrderDetail>(DETAIL_PAGE_SIZE));
    setOrdersPageNumber(1);
    setOrdersLoading(false);
    setOrdersError(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || servicesPage) return;
    void loadServicesPage(servicesPageNumber, {
      refresh: servicesPageNumber === 1,
    });
  }, [isOpen, servicesPage, servicesPageNumber, loadServicesPage]);

  useEffect(() => {
    if (!isOpen || activeView !== 'detail' || !detailServiceId || ordersPage) return;
    void loadOrdersPage(detailServiceId, ordersPageNumber, {
      refresh: ordersPageNumber === 1,
    });
  }, [isOpen, activeView, detailServiceId, ordersPage, ordersPageNumber, loadOrdersPage]);

  const headerSubtitle = useMemo(() => {
    if (activeView === 'detail') {
      return getServiceDisplayName(activeSelectedService);
    }
    return i18nService.t('gigSquareMyServicesSubtitle');
  }, [activeView, activeSelectedService]);

  const handleOpenPublish = useCallback(() => {
    onClose();
    onOpenPublish();
  }, [onClose, onOpenPublish]);

  const handleOpenDetail = useCallback((service: GigSquareMyServiceSummary) => {
    setInternalSelectedService(service);
    setInternalOrdersPage(createEmptyPageResult<GigSquareMyServiceOrderDetail>(DETAIL_PAGE_SIZE));
    setOrdersPageNumber(1);
    setOrdersError(null);
    setInternalView('detail');
  }, []);

  const handleBackToList = useCallback(() => {
    if (!view) {
      setInternalView('list');
    }
    onBackToList?.();
  }, [onBackToList, view]);

  const handleViewSession = useCallback((sessionId: string | null) => {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId || typeof window === 'undefined') {
      return;
    }
    window.dispatchEvent(new CustomEvent('cowork:viewSession', {
      detail: { sessionId: normalizedSessionId },
    }));
    onClose();
  }, [onClose]);

  const handleRefresh = useCallback(() => {
    if (activeView === 'detail' && detailServiceId) {
      void loadOrdersPage(detailServiceId, activeOrdersPage.page || ordersPageNumber, {
        refresh: true,
      });
      return;
    }
    void loadServicesPage(activeServicesPage.page || servicesPageNumber, {
      refresh: true,
    });
  }, [
    activeOrdersPage.page,
    activeServicesPage.page,
    activeView,
    detailServiceId,
    loadOrdersPage,
    loadServicesPage,
    ordersPageNumber,
    servicesPageNumber,
  ]);

  const paginationPage = activeView === 'detail' ? activeOrdersPage : activeServicesPage;
  const canGoPrev = paginationPage.page > 1;
  const canGoNext = paginationPage.totalPages > 0 && paginationPage.page < paginationPage.totalPages;

  const handlePrevPage = useCallback(() => {
    if (!canGoPrev) return;
    if (activeView === 'detail') {
      setOrdersPageNumber((prev) => Math.max(prev - 1, 1));
      return;
    }
    setServicesPageNumber((prev) => Math.max(prev - 1, 1));
  }, [activeView, canGoPrev]);

  const handleNextPage = useCallback(() => {
    if (!canGoNext) return;
    if (activeView === 'detail') {
      setOrdersPageNumber((prev) => prev + 1);
      return;
    }
    setServicesPageNumber((prev) => prev + 1);
  }, [activeView, canGoNext]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop">
      <div
        className="modal-content flex h-[min(86vh,920px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-modal dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between gap-4 border-b border-claude-border px-6 py-4 dark:border-claude-darkBorder">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {activeView === 'detail' && (
                <button
                  type="button"
                  onClick={handleBackToList}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-claude-textSecondary hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                  {i18nService.t('gigSquareMyServicesBack')}
                </button>
              )}
              <h2 className="text-lg font-semibold text-claude-text dark:text-claude-darkText">
                {activeView === 'detail'
                  ? i18nService.t('gigSquareMyServicesOrdersTitle')
                  : i18nService.t('gigSquareMyServicesTitle')}
              </h2>
            </div>
            <p className="mt-1 truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {headerSubtitle}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
            >
              <ArrowPathIcon className="h-4 w-4" />
              {i18nService.t('refresh')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-claude-textSecondary hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
              aria-label={i18nService.t('close')}
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {activeView === 'list' && (
            <div className="space-y-4">
              {servicesLoading && activeServicesPage.items.length === 0 && (
                <div className="text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('loading')}
                </div>
              )}

              {!servicesLoading && servicesError && (
                <div className="rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-500">
                  {servicesError}
                </div>
              )}

              {!servicesLoading && !servicesError && activeServicesPage.items.length === 0 && (
                <div className="rounded-2xl border border-dashed border-claude-border bg-claude-surfaceMuted px-6 py-10 text-center dark:border-claude-darkBorder dark:bg-claude-darkSurfaceMuted">
                  <div className="text-base font-medium text-claude-text dark:text-claude-darkText">
                    {i18nService.t('gigSquareMyServicesEmpty')}
                  </div>
                  <p className="mx-auto mt-2 max-w-xl text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('gigSquareMyServicesEmptyHint')}
                  </p>
                  <button
                    type="button"
                    onClick={handleOpenPublish}
                    className="btn-idchat-primary mt-4 px-4 py-2 text-sm font-medium"
                  >
                    {i18nService.t('gigSquareMyServicesGoPublish')}
                  </button>
                </div>
              )}

              {activeServicesPage.items.map((service) => {
                const price = formatGigSquarePrice(service.price, service.currency);
                const grossRevenue = formatGigSquarePrice(service.grossRevenue, service.currency);
                const netIncome = formatGigSquarePrice(service.netIncome, service.currency);
                const detailAction = getMyServiceActionState('detail');
                const revokeAction = getMyServiceActionState('revoke');
                const editAction = getMyServiceActionState('edit');
                const ratingText = service.ratingCount > 0
                  ? service.ratingAvg.toFixed(1)
                  : i18nService.t('gigSquareMyServicesRatingEmpty');

                return (
                  <div
                    key={service.id}
                    className="rounded-xl border border-claude-border bg-[var(--bg-panel)] px-4 py-3 dark:border-claude-darkBorder dark:bg-claude-darkSurface"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-3">
                          {service.serviceIcon ? (
                            <img
                              src={service.serviceIcon}
                              alt={getServiceDisplayName(service)}
                              className="h-10 w-10 rounded-lg border border-claude-border object-cover dark:border-claude-darkBorder"
                            />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-claude-accent/15 text-sm font-semibold text-claude-accent">
                              {getServiceDisplayName(service).slice(0, 1).toUpperCase()}
                            </div>
                          )}

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <div className="truncate text-sm font-semibold text-claude-text dark:text-claude-darkText">
                                {getServiceDisplayName(service)}
                              </div>
                              {service.providerSkill && (
                                <span className="rounded-full bg-claude-surfaceMuted px-2 py-0.5 text-[10px] font-medium text-claude-textSecondary dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary">
                                  {service.providerSkill}
                                </span>
                              )}
                              <span className="rounded-full bg-claude-accent/10 px-2 py-0.5 text-[10px] font-semibold text-claude-accent">
                                {price.amount} {price.unit}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              <span className="font-mono">
                                {service.serviceName || service.id}
                              </span>
                              <span>
                                {i18nService.t('gigSquareMyServicesUpdatedAt')} {formatDateTime(service.updatedAt)}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {service.description || '—'}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <span className="rounded-full bg-claude-surfaceMuted px-2 py-1 text-[10px] font-medium text-claude-text dark:bg-claude-darkSurfaceMuted dark:text-claude-darkText">
                                {i18nService.t(getMyServiceMetricLabel('successCount'))} {service.successCount}
                              </span>
                              <span className="rounded-full bg-claude-surfaceMuted px-2 py-1 text-[10px] font-medium text-claude-text dark:bg-claude-darkSurfaceMuted dark:text-claude-darkText">
                                {i18nService.t(getMyServiceMetricLabel('refundCount'))} {service.refundCount}
                              </span>
                              <span className="rounded-full bg-claude-surfaceMuted px-2 py-1 text-[10px] font-medium text-claude-text dark:bg-claude-darkSurfaceMuted dark:text-claude-darkText">
                                {i18nService.t(getMyServiceMetricLabel('grossRevenue'))} {grossRevenue.amount} {grossRevenue.unit}
                              </span>
                              <span className="rounded-full bg-claude-surfaceMuted px-2 py-1 text-[10px] font-medium text-claude-text dark:bg-claude-darkSurfaceMuted dark:text-claude-darkText">
                                {i18nService.t(getMyServiceMetricLabel('netIncome'))} {netIncome.amount} {netIncome.unit}
                              </span>
                              <span className="rounded-full bg-claude-surfaceMuted px-2 py-1 text-[10px] font-medium text-claude-text dark:bg-claude-darkSurfaceMuted dark:text-claude-darkText">
                                {i18nService.t(getMyServiceMetricLabel('ratingAvg'))} {ratingText}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5 lg:justify-end">
                        <button
                          type="button"
                          onClick={() => handleOpenDetail(service)}
                          disabled={detailAction.disabled}
                          className="btn-idchat-primary-filled px-2.5 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {i18nService.t('gigSquareMyServicesActionDetail')}
                        </button>
                        <button
                          type="button"
                          disabled={revokeAction.disabled}
                          title={revokeAction.key ? i18nService.t(revokeAction.key) : undefined}
                          className="rounded-lg border border-claude-border px-2.5 py-1.5 text-[11px] font-medium text-claude-textSecondary opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary"
                        >
                          {i18nService.t('gigSquareMyServicesActionRevoke')}
                        </button>
                        <button
                          type="button"
                          disabled={editAction.disabled}
                          title={editAction.key ? i18nService.t(editAction.key) : undefined}
                          className="rounded-lg border border-claude-border px-2.5 py-1.5 text-[11px] font-medium text-claude-textSecondary opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary"
                        >
                          {i18nService.t('gigSquareMyServicesActionEdit')}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeView === 'detail' && (
            <div className="space-y-4">
              {activeSelectedService && (
                <div className="rounded-2xl border border-claude-border bg-[var(--bg-panel)] px-5 py-4 dark:border-claude-darkBorder dark:bg-claude-darkSurface">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="text-base font-semibold text-claude-text dark:text-claude-darkText">
                        {getServiceDisplayName(activeSelectedService)}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {activeSelectedService.serviceName || activeSelectedService.id}
                      </div>
                      {activeSelectedService.description && (
                        <p className="mt-2 text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                          {activeSelectedService.description}
                        </p>
                      )}
                    </div>
                    {activeSelectedService.price && activeSelectedService.currency && (
                      <div className="shrink-0 rounded-xl bg-claude-surfaceMuted px-3 py-2 dark:bg-claude-darkSurfaceMuted">
                        <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                          {formatGigSquarePrice(activeSelectedService.price, activeSelectedService.currency).unit}
                        </div>
                        <div className="text-base font-semibold text-claude-accent">
                          {formatGigSquarePrice(activeSelectedService.price, activeSelectedService.currency).amount}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {ordersLoading && activeOrdersPage.items.length === 0 && (
                <div className="text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('loading')}
                </div>
              )}

              {!ordersLoading && ordersError && (
                <div className="rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-500">
                  {ordersError}
                </div>
              )}

              {!ordersLoading && !ordersError && activeOrdersPage.items.length === 0 && (
                <div className="rounded-2xl border border-dashed border-claude-border bg-claude-surfaceMuted px-6 py-8 text-sm text-claude-textSecondary dark:border-claude-darkBorder dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary">
                  {i18nService.t('gigSquareMyServicesNoOrders')}
                </div>
              )}

              {activeOrdersPage.items.map((order) => {
                const price = formatGigSquarePrice(order.paymentAmount, order.paymentCurrency);
                const buyerName = getCounterpartyDisplayName(order);
                const ratingTxid = extractPinTxid(order.rating?.pinId);
                const sessionAction = getMyServiceSessionActionState(order.coworkSessionId);
                return (
                  <div
                    key={order.id}
                    className="rounded-2xl border border-claude-border bg-[var(--bg-panel)] px-5 py-4 dark:border-claude-darkBorder dark:bg-claude-darkSurface"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getMyServiceOrderStatusClassName(order.status)}`}>
                            {i18nService.t(getMyServiceOrderStatusKey(order.status))}
                          </span>
                          <span className="font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                            #{shortenMyServiceHash(order.id, 8, 4)}
                          </span>
                        </div>

                        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                          <div>
                            <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareMyServicesOrderBuyer')}
                            </div>
                            <div className="mt-1 flex items-center gap-3">
                              {order.counterpartyAvatar ? (
                                <img
                                  src={order.counterpartyAvatar}
                                  alt={buyerName}
                                  className="h-9 w-9 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder"
                                />
                              ) : (
                                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-claude-accent/15 text-xs font-semibold text-claude-accent">
                                  {buyerName.slice(0, 1).toUpperCase()}
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-claude-text dark:text-claude-darkText">
                                  {buyerName}
                                </div>
                                {order.counterpartyGlobalMetaid && buyerName !== order.counterpartyGlobalMetaid && (
                                  <div className="break-all text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                    {order.counterpartyGlobalMetaid}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareMyServicesOrderAmount')}
                            </div>
                            <div className="mt-1 text-sm font-semibold text-claude-text dark:text-claude-darkText">
                              {price.amount} {price.unit}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareMyServicesOrderTxid')}
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                              <div className="min-w-0 break-all font-mono text-sm text-claude-text dark:text-claude-darkText">
                                {order.paymentTxid ? shortenMyServiceHash(order.paymentTxid, 14, 8) : '—'}
                              </div>
                              {order.paymentTxid && <CopyValueButton value={order.paymentTxid} />}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareMyServicesOrderCreatedAt')}
                            </div>
                            <div className="mt-1 text-sm text-claude-text dark:text-claude-darkText">
                              {formatDateTime(order.createdAt)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareMyServicesOrderDeliveredAt')}
                            </div>
                            <div className="mt-1 text-sm text-claude-text dark:text-claude-darkText">
                              {formatDateTime(order.deliveredAt)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareMyServicesOrderRefundedAt')}
                            </div>
                            <div className="mt-1 text-sm text-claude-text dark:text-claude-darkText">
                              {formatDateTime(order.refundCompletedAt)}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 rounded-xl bg-claude-surfaceMuted px-3 py-3 dark:bg-claude-darkSurfaceMuted">
                          <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                            {i18nService.t('gigSquareMyServicesOrderRating')}
                          </div>
                          <div className="mt-1 text-sm font-medium text-claude-text dark:text-claude-darkText">
                            {order.rating
                              ? `${order.rating.rate} / 5`
                              : i18nService.t('gigSquareMyServicesOrderUnrated')}
                          </div>
                          {order.rating?.pinId && (
                            <>
                              <div className="mt-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                {i18nService.t('gigSquareMyServicesOrderRatingTxid')}
                              </div>
                              <div className="mt-1 flex items-center gap-2">
                                <div className="min-w-0 break-all font-mono text-xs text-claude-text dark:text-claude-darkText">
                                  {shortenMyServiceHash(ratingTxid, 14, 8)}
                                </div>
                                <CopyValueButton value={ratingTxid} />
                              </div>
                            </>
                          )}
                          {order.rating?.comment && (
                            <>
                              <div className="mt-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                {i18nService.t('gigSquareMyServicesOrderComment')}
                              </div>
                              <div className="mt-1 whitespace-pre-wrap text-sm text-claude-text dark:text-claude-darkText">
                                {order.rating.comment}
                              </div>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="shrink-0 lg:w-40">
                        <button
                          type="button"
                          onClick={() => handleViewSession(order.coworkSessionId)}
                          disabled={sessionAction.disabled}
                          title={sessionAction.key ? i18nService.t(sessionAction.key) : undefined}
                          className="btn-idchat-primary w-full px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {i18nService.t('gigSquareMyServicesViewSession')}
                        </button>
                        {sessionAction.disabled && (
                          <div className="mt-2 text-center text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                            {i18nService.t('gigSquareMyServicesNoSession')}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {paginationPage.total > 0 && (
          <div className="flex items-center justify-between border-t border-claude-border px-6 py-4 dark:border-claude-darkBorder">
            <div className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {paginationPage.total} {i18nService.t('gigSquareMyServicesTotalSuffix')}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrevPage}
                disabled={!canGoPrev}
                className="inline-flex items-center gap-1 rounded-lg border border-claude-border px-2.5 py-1.5 text-xs font-medium text-claude-textSecondary disabled:cursor-not-allowed disabled:opacity-50 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary"
              >
                <ChevronLeftIcon className="h-4 w-4" />
                {i18nService.t('gigSquareMyServicesPrevPage')}
              </button>
              <span className="min-w-[72px] text-center text-xs font-medium text-claude-text dark:text-claude-darkText">
                {paginationPage.page} / {Math.max(paginationPage.totalPages, 1)}
              </span>
              <button
                type="button"
                onClick={handleNextPage}
                disabled={!canGoNext}
                className="inline-flex items-center gap-1 rounded-lg border border-claude-border px-2.5 py-1.5 text-xs font-medium text-claude-textSecondary disabled:cursor-not-allowed disabled:opacity-50 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary"
              >
                {i18nService.t('gigSquareMyServicesNextPage')}
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default GigSquareMyServicesModal;
