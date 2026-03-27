import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  PhotoIcon,
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
  GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS,
  getGigSquarePublishPriceLimit,
  getGigSquarePublishPriceLimitText,
} from './gigSquarePublishPresentation.js';
import {
  getMyServiceMetricLabel,
  getMyServiceOrderStatusClassName,
  getMyServiceOrderStatusKey,
  getMyServiceSessionActionState,
  shortenMyServiceHash,
} from './gigSquareMyServicesPresentation.js';

type GigSquareMyServicesView = 'list' | 'detail';

type SelectedServiceLike = Pick<GigSquareMyServiceSummary, 'id'> & Partial<GigSquareMyServiceSummary>;

type ModifyDraft = {
  serviceName: string;
  displayName: string;
  description: string;
  providerSkill: string;
  price: string;
  currency: 'BTC' | 'SPACE' | 'DOGE';
  outputType: 'text' | 'image' | 'video' | 'other';
  serviceIconDataUrl: string;
};

type MutationNotice = {
  kind: 'success' | 'warning';
  message: string;
  warning?: string | null;
  txids: string[];
};

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
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const ICON_ACCEPT = 'image/png,image/jpeg,image/jpg,image/webp,image/gif,image/svg+xml';
const NUMBER_PATTERN = /^\d+(\.\d+)?$/;
const OUTPUT_OPTIONS: Array<{ label: string; value: ModifyDraft['outputType'] }> = [
  { label: 'text', value: 'text' },
  { label: 'image', value: 'image' },
  { label: 'video', value: 'video' },
  { label: 'other', value: 'other' },
];

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

const normalizeModifyCurrency = (value: string | null | undefined): ModifyDraft['currency'] => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BTC') return 'BTC';
  if (normalized === 'DOGE') return 'DOGE';
  return 'SPACE';
};

const normalizeModifyOutputType = (value: string | null | undefined): ModifyDraft['outputType'] => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'image') return 'image';
  if (normalized === 'video') return 'video';
  if (normalized === 'other') return 'other';
  return 'text';
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

const showToastMessage = (message: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const normalizeMutationTxids = (value: string[] | undefined): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
};

const buildModifyDraftFromService = (service: GigSquareMyServiceSummary): ModifyDraft => ({
  serviceName: (service.serviceName || '').trim(),
  displayName: (service.displayName || '').trim(),
  description: (service.description || '').trim(),
  providerSkill: (service.providerSkill || '').trim(),
  price: (service.price || '').trim(),
  currency: normalizeModifyCurrency(service.currency),
  outputType: normalizeModifyOutputType(service.outputType || null),
  serviceIconDataUrl: '',
});

const validateModifyDraft = (draft: ModifyDraft): string | null => {
  if (!draft.displayName.trim()) return i18nService.t('gigSquarePublishDisplayNameRequired');
  if (!draft.serviceName.trim()) return i18nService.t('gigSquarePublishServiceNameRequired');
  if (!draft.description.trim()) return i18nService.t('gigSquarePublishDescriptionRequired');
  if (!draft.providerSkill.trim()) return i18nService.t('gigSquarePublishSkillRequired');
  if (!draft.price.trim()) return i18nService.t('gigSquarePublishPriceRequired');
  if (!NUMBER_PATTERN.test(draft.price.trim())) return i18nService.t('gigSquarePublishPriceInvalid');
  const numericPrice = Number(draft.price.trim());
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    return i18nService.t('gigSquarePublishPriceInvalid');
  }
  if (numericPrice > getGigSquarePublishPriceLimit(draft.currency)) {
    return i18nService.t('gigSquarePublishPriceExceed');
  }
  return null;
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
  const [mutationBusyServiceId, setMutationBusyServiceId] = useState<string | null>(null);
  const [revokeTargetService, setRevokeTargetService] = useState<GigSquareMyServiceSummary | null>(null);
  const [modifyTargetService, setModifyTargetService] = useState<GigSquareMyServiceSummary | null>(null);
  const [modifyDraft, setModifyDraft] = useState<ModifyDraft | null>(null);
  const [modifyError, setModifyError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<MutationNotice | null>(null);
  const modifyIconInputRef = useRef<HTMLInputElement | null>(null);

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
    setMutationBusyServiceId(null);
    setRevokeTargetService(null);
    setModifyTargetService(null);
    setModifyDraft(null);
    setModifyError(null);
    setMutationNotice(null);
    if (modifyIconInputRef.current) {
      modifyIconInputRef.current.value = '';
    }
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

  const closeModifyModal = useCallback(() => {
    if (mutationBusyServiceId) return;
    setModifyTargetService(null);
    setModifyDraft(null);
    setModifyError(null);
    if (modifyIconInputRef.current) {
      modifyIconInputRef.current.value = '';
    }
  }, [mutationBusyServiceId]);

  const closeRevokeModal = useCallback(() => {
    if (mutationBusyServiceId) return;
    setRevokeTargetService(null);
  }, [mutationBusyServiceId]);

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

  const handleOpenModify = useCallback((service: GigSquareMyServiceSummary) => {
    if (mutationBusyServiceId || !service.canModify) return;
    setModifyTargetService(service);
    setModifyDraft(buildModifyDraftFromService(service));
    setModifyError(null);
    if (modifyIconInputRef.current) {
      modifyIconInputRef.current.value = '';
    }
  }, [mutationBusyServiceId]);

  const handleOpenRevoke = useCallback((service: GigSquareMyServiceSummary) => {
    if (mutationBusyServiceId || !service.canRevoke) return;
    setServicesError(null);
    setRevokeTargetService(service);
  }, [mutationBusyServiceId]);

  const handleModifyIconChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_ICON_BYTES) {
      setModifyError(i18nService.t('gigSquarePublishIconTooLarge'));
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setModifyDraft((prev) => (prev ? { ...prev, serviceIconDataUrl: dataUrl } : prev));
      setModifyError(null);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }, []);

  const handleConfirmRevoke = useCallback(async () => {
    if (mutationBusyServiceId || !revokeTargetService) return;
    if (typeof window === 'undefined') {
      return;
    }
    const revokeService = window.electron?.gigSquare?.revokeService;
    if (typeof revokeService !== 'function') {
      setServicesError('revokeService IPC unavailable. Please restart the app.');
      setRevokeTargetService(null);
      return;
    }

    setServicesError(null);
    setMutationNotice(null);
    setMutationBusyServiceId(revokeTargetService.id);
    try {
      const result = await revokeService({
        serviceId: revokeTargetService.currentPinId || revokeTargetService.id,
      });
      if (!result?.success) {
        setServicesError(result?.error || i18nService.t('gigSquareMyServicesMutationFailed'));
        return;
      }
      if (result.warning) {
        showToastMessage(result.warning);
      }
      setMutationNotice({
        kind: result.warning ? 'warning' : 'success',
        message: i18nService.t('gigSquareMyServicesRevokeSuccess'),
        warning: result.warning || null,
        txids: normalizeMutationTxids(result.txids),
      });
      showToastMessage(i18nService.t('gigSquareMyServicesRevokeSuccess'));
      setRevokeTargetService(null);
      if (activeView === 'detail') {
        handleBackToList();
      }
      await loadServicesPage(activeServicesPage.page || servicesPageNumber, { refresh: true });
    } finally {
      setMutationBusyServiceId(null);
    }
  }, [
    mutationBusyServiceId,
    revokeTargetService,
    activeView,
    activeServicesPage.page,
    handleBackToList,
    loadServicesPage,
    servicesPageNumber,
  ]);

  const handleSubmitModify = useCallback(async () => {
    if (mutationBusyServiceId || !modifyTargetService || !modifyDraft) return;
    if (typeof window === 'undefined' || !window.electron?.gigSquare) return;

    const validationError = validateModifyDraft(modifyDraft);
    if (validationError) {
      setModifyError(validationError);
      return;
    }

    setServicesError(null);
    setModifyError(null);
    setMutationNotice(null);
    setMutationBusyServiceId(modifyTargetService.id);
    try {
      const result = await window.electron.gigSquare.modifyService({
        serviceId: modifyTargetService.currentPinId || modifyTargetService.id,
        serviceName: modifyDraft.serviceName.trim(),
        displayName: modifyDraft.displayName.trim(),
        description: modifyDraft.description.trim(),
        providerSkill: modifyDraft.providerSkill.trim(),
        price: modifyDraft.price.trim(),
        currency: modifyDraft.currency,
        outputType: modifyDraft.outputType,
        serviceIconDataUrl: modifyDraft.serviceIconDataUrl || null,
      });
      if (!result?.success) {
        setModifyError(result?.error || i18nService.t('gigSquareMyServicesMutationFailed'));
        return;
      }
      if (result.warning) {
        showToastMessage(result.warning);
      }
      setMutationNotice({
        kind: result.warning ? 'warning' : 'success',
        message: i18nService.t('gigSquareMyServicesModifySuccess'),
        warning: result.warning || null,
        txids: normalizeMutationTxids(result.txids),
      });
      showToastMessage(i18nService.t('gigSquareMyServicesModifySuccess'));
      closeModifyModal();
      await loadServicesPage(activeServicesPage.page || servicesPageNumber, { refresh: true });
    } finally {
      setMutationBusyServiceId(null);
    }
  }, [
    mutationBusyServiceId,
    modifyTargetService,
    modifyDraft,
    closeModifyModal,
    activeServicesPage.page,
    loadServicesPage,
    servicesPageNumber,
  ]);

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
  const isModifySubmitting = Boolean(
    mutationBusyServiceId
    && modifyTargetService
    && mutationBusyServiceId === modifyTargetService.id,
  );

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
        className="modal-content relative flex h-[min(86vh,920px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-modal dark:border-claude-darkBorder dark:bg-claude-darkSurface"
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
          {mutationNotice && (
            <div className={`mb-4 rounded-2xl border px-4 py-3 ${
              mutationNotice.kind === 'warning'
                ? 'border-amber-500/30 bg-amber-500/10'
                : 'border-emerald-500/30 bg-emerald-500/10'
            }`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-claude-text dark:text-claude-darkText">
                    {mutationNotice.message}
                  </div>
                  {mutationNotice.warning && (
                    <p className="mt-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {mutationNotice.warning}
                    </p>
                  )}
                  {mutationNotice.txids.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('gigSquareMyServicesBroadcastTxids')}
                      </div>
                      {mutationNotice.txids.map((txid) => (
                        <div key={txid} className="flex items-center gap-2">
                          <div className="min-w-0 break-all font-mono text-xs text-claude-text dark:text-claude-darkText">
                            {txid}
                          </div>
                          <CopyValueButton value={txid} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setMutationNotice(null)}
                  className="rounded-lg p-1 text-claude-textSecondary hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                  aria-label={i18nService.t('close')}
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

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
                const revokeDisabled = mutationBusyServiceId !== null || !service.canRevoke;
                const editDisabled = mutationBusyServiceId !== null || !service.canModify;
                const blockedReasonKey = service.blockedReason || 'gigSquareMyServicesMutationFailed';
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
                              <span>
                                {i18nService.t('gigSquareMyServicesCreatorMetabot')} {service.creatorMetabotName || service.creatorMetabotId || '—'}
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
                          className="btn-idchat-primary-filled px-2.5 py-1.5 text-[11px] font-medium"
                        >
                          {i18nService.t('gigSquareMyServicesActionDetail')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenRevoke(service)}
                          disabled={revokeDisabled}
                          title={!service.canRevoke ? i18nService.t(blockedReasonKey) : undefined}
                          className="btn-idchat-primary-filled px-2.5 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {i18nService.t('gigSquareMyServicesActionRevoke')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenModify(service)}
                          disabled={editDisabled}
                          title={!service.canModify ? i18nService.t(blockedReasonKey) : undefined}
                          className="btn-idchat-primary-filled px-2.5 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-60"
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

        {revokeTargetService && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 p-4">
            <div
              className="w-full max-w-lg rounded-2xl border border-claude-border bg-[var(--bg-main)] p-6 shadow-xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-claude-text dark:text-claude-darkText">
                    {i18nService.t('gigSquareMyServicesActionRevoke')}
                  </h3>
                  <p className="mt-1 text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('gigSquareMyServicesRevokeConfirm')}
                  </p>
                  <p className="mt-3 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {getServiceDisplayName(revokeTargetService)}
                  </p>
                  <p className="mt-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('gigSquareMyServicesCreatorMetabot')} {revokeTargetService.creatorMetabotName || revokeTargetService.creatorMetabotId || '—'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeRevokeModal}
                  disabled={mutationBusyServiceId === revokeTargetService.id}
                  className="rounded-lg p-1.5 text-claude-textSecondary hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-60 dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                  aria-label={i18nService.t('close')}
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="mt-6 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeRevokeModal}
                  disabled={mutationBusyServiceId === revokeTargetService.id}
                  className="rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRevoke()}
                  disabled={mutationBusyServiceId === revokeTargetService.id}
                  className="btn-idchat-primary-filled px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {mutationBusyServiceId === revokeTargetService.id
                    ? i18nService.t('gigSquarePublishSubmitting')
                    : i18nService.t('gigSquareMyServicesActionRevoke')}
                </button>
              </div>
            </div>
          </div>
        )}

        {modifyTargetService && modifyDraft && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 p-4">
            <div
              className="w-full max-w-2xl rounded-2xl border border-claude-border bg-[var(--bg-main)] p-6 shadow-xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-claude-text dark:text-claude-darkText">
                    {i18nService.t('gigSquareMyServicesModifyTitle')}
                  </h3>
                  <p className="mt-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {getServiceDisplayName(modifyTargetService)}
                  </p>
                  <p className="mt-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('gigSquareMyServicesCreatorMetabot')} {modifyTargetService.creatorMetabotName || modifyTargetService.creatorMetabotId || '—'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeModifyModal}
                  disabled={isModifySubmitting}
                  className="rounded-lg p-1.5 text-claude-textSecondary hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-60 dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                  aria-label={i18nService.t('close')}
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>

              {modifyError && (
                <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-500">
                  {modifyError}
                </div>
              )}

              <div className="mt-5 space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('gigSquarePublishDisplayNameLabel')}
                    </label>
                    <input
                      type="text"
                      value={modifyDraft.displayName}
                      onChange={(event) => setModifyDraft((prev) => (prev ? { ...prev, displayName: event.target.value } : prev))}
                      placeholder={i18nService.t('gigSquarePublishDisplayNamePlaceholder')}
                      disabled={isModifySubmitting}
                      className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('gigSquarePublishServiceNameLabel')}
                    </label>
                    <input
                      type="text"
                      value={modifyDraft.serviceName}
                      onChange={(event) => setModifyDraft((prev) => (prev ? { ...prev, serviceName: event.target.value } : prev))}
                      placeholder={i18nService.t('gigSquarePublishServiceNameLabel')}
                      disabled={isModifySubmitting}
                      className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('gigSquarePublishDescriptionLabel')}
                  </label>
                  <textarea
                    value={modifyDraft.description}
                    onChange={(event) => setModifyDraft((prev) => (prev ? { ...prev, description: event.target.value } : prev))}
                    rows={3}
                    disabled={isModifySubmitting}
                    placeholder={i18nService.t('gigSquarePublishDescriptionPlaceholder')}
                    className="w-full rounded-xl border border-claude-border bg-[var(--bg-panel)] px-3 py-2 text-sm text-claude-text placeholder-claude-textSecondary focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkSurface dark:text-claude-darkText dark:placeholder-claude-darkTextSecondary"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('gigSquarePublishSkillLabel')}
                    </label>
                    <input
                      type="text"
                      value={modifyDraft.providerSkill}
                      onChange={(event) => setModifyDraft((prev) => (prev ? { ...prev, providerSkill: event.target.value } : prev))}
                      disabled={isModifySubmitting}
                      placeholder={i18nService.t('gigSquarePublishSkillLabel')}
                      className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('gigSquarePublishOutputTypeLabel')}
                    </label>
                    <select
                      value={modifyDraft.outputType}
                      onChange={(event) => setModifyDraft((prev) => (prev ? {
                        ...prev,
                        outputType: normalizeModifyOutputType(event.target.value),
                      } : prev))}
                      disabled={isModifySubmitting}
                      className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
                    >
                      {OUTPUT_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('gigSquarePublishPriceLabel')}
                    </label>
                    <input
                      type="text"
                      value={modifyDraft.price}
                      onChange={(event) => setModifyDraft((prev) => (prev ? { ...prev, price: event.target.value } : prev))}
                      disabled={isModifySubmitting}
                      placeholder={i18nService.t('gigSquarePublishPricePlaceholder')}
                      className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
                    />
                    <p className="mt-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('gigSquarePublishPriceLimitPrefix')}{getGigSquarePublishPriceLimitText(modifyDraft.currency)}
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('gigSquarePublishCurrencyLabel')}
                    </label>
                    <select
                      value={modifyDraft.currency}
                      onChange={(event) => setModifyDraft((prev) => (prev ? {
                        ...prev,
                        currency: normalizeModifyCurrency(event.target.value),
                      } : prev))}
                      disabled={isModifySubmitting}
                      className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
                    >
                      {GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('gigSquarePublishIconLabel')}
                  </label>
                  <div className="flex items-center gap-3">
                    {modifyDraft.serviceIconDataUrl || modifyTargetService.serviceIcon ? (
                      <img
                        src={modifyDraft.serviceIconDataUrl || modifyTargetService.serviceIcon || ''}
                        alt={getServiceDisplayName(modifyTargetService)}
                        className="h-12 w-12 rounded-lg border border-claude-border object-cover dark:border-claude-darkBorder"
                      />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-claude-border text-claude-textSecondary dark:border-claude-darkBorder dark:text-claude-darkTextSecondary">
                        <PhotoIcon className="h-5 w-5" />
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => modifyIconInputRef.current?.click()}
                        disabled={isModifySubmitting}
                        className="rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                      >
                        {i18nService.t('gigSquarePublishUploadIcon')}
                      </button>
                      {modifyDraft.serviceIconDataUrl && (
                        <button
                          type="button"
                          onClick={() => setModifyDraft((prev) => (prev ? { ...prev, serviceIconDataUrl: '' } : prev))}
                          disabled={isModifySubmitting}
                          className="rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                        >
                          {i18nService.t('gigSquarePublishRemoveIcon')}
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    ref={modifyIconInputRef}
                    type="file"
                    accept={ICON_ACCEPT}
                    className="hidden"
                    onChange={handleModifyIconChange}
                  />
                </div>
              </div>

              <div className="mt-6 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeModifyModal}
                  disabled={isModifySubmitting}
                  className="rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmitModify()}
                  disabled={isModifySubmitting}
                  className="btn-idchat-primary-filled px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isModifySubmitting
                    ? i18nService.t('gigSquarePublishSubmitting')
                    : i18nService.t('gigSquareMyServicesModifySubmit')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default GigSquareMyServicesModal;
