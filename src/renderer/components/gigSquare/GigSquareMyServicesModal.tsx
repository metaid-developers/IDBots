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
import type { Skill } from '../../types/skill';
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
  getSelectableGigSquareMrc20Assets,
} from './gigSquarePublishPresentation.js';
import {
  getMyServiceMetricLabel,
  getMyServiceOrderStatusClassName,
  getMyServiceOrderStatusKey,
  getMyServiceSessionActionState,
  shortenMyServiceHash,
} from './gigSquareMyServicesPresentation.js';
import {
  buildGigSquareModifySkillOptions,
  resolveGigSquareModifySkillSelection,
} from './gigSquareSkillOptions.js';

type GigSquareMyServicesView = 'list' | 'detail';
type ModifyCurrency = 'BTC' | 'SPACE' | 'DOGE' | 'MRC20';
type SelectableMrc20Asset = Pick<ElectronMrc20Asset, 'symbol' | 'mrc20Id' | 'balance'>;

type SelectedServiceLike = Pick<GigSquareMyServiceSummary, 'id'> & Partial<GigSquareMyServiceSummary>;

type ModifyDraft = {
  serviceName: string;
  displayName: string;
  description: string;
  providerSkill: string;
  price: string;
  currency: ModifyCurrency;
  mrc20Ticker: string;
  mrc20Id: string;
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
  if (normalized === 'MRC20') return 'MRC20';
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

const shortenMetaid = (value: string | null | undefined, head = 6, tail = 3): string => {
  const normalized = String(value || '').trim();
  if (!normalized) return '—';
  if (normalized.length <= head + tail + 3) return normalized;
  return `${normalized.slice(0, head)}...${normalized.slice(-tail)}`;
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
  // mrc20 services are represented by settlementKind + mrc20 identifiers.
  currency: String(service.settlementKind || '').trim().toLowerCase() === 'mrc20'
    ? 'MRC20'
    : normalizeModifyCurrency(service.currency),
  serviceName: (service.serviceName || '').trim(),
  displayName: (service.displayName || '').trim(),
  description: (service.description || '').trim(),
  providerSkill: (service.providerSkill || '').trim(),
  price: (service.price || '').trim(),
  mrc20Ticker: (service.mrc20Ticker || '').trim(),
  mrc20Id: (service.mrc20Id || '').trim(),
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
  if (!Number.isFinite(numericPrice) || numericPrice < 0) {
    return i18nService.t('gigSquarePublishPriceInvalid');
  }
  const priceLimit = getGigSquarePublishPriceLimit(draft.currency);
  if (priceLimit !== null && numericPrice > priceLimit) {
    return i18nService.t('gigSquarePublishPriceExceed');
  }
  if (draft.currency === 'MRC20' && (!draft.mrc20Ticker.trim() || !draft.mrc20Id.trim())) {
    return 'Please select an MRC20 token';
  }
  return null;
};

const CopyValueButton: React.FC<{
  value: string;
  compact?: boolean;
}> = ({ value, compact = false }) => {
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
      className={`inline-flex shrink-0 items-center justify-center rounded-md border border-claude-border text-claude-textSecondary transition hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover ${
        compact ? 'h-6 w-6' : 'h-7 w-7'
      } ${
        copied ? 'text-claude-accent' : ''
      }`}
      title={i18nService.t('copyToClipboard')}
      aria-label={i18nService.t('copyToClipboard')}
    >
      <DocumentDuplicateIcon className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </button>
  );
};

const CompactMetric: React.FC<{
  label: string;
  value: string;
  emphasis?: boolean;
}> = ({ label, value, emphasis = false }) => (
  <div className="min-w-[92px] rounded-lg border border-claude-border/70 bg-claude-surfaceMuted/80 px-2.5 py-2 dark:border-claude-darkBorder/70 dark:bg-claude-darkSurfaceMuted/80">
    <div className="text-[11px] leading-none text-claude-textSecondary dark:text-claude-darkTextSecondary">
      {label}
    </div>
    <div className={`mt-1 text-sm font-semibold leading-none ${
      emphasis ? 'text-claude-accent' : 'text-claude-text dark:text-claude-darkText'
    }`}>
      {value}
    </div>
  </div>
);

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
  const [skills, setSkills] = useState<Skill[]>([]);
  const [modifySelectedSkillId, setModifySelectedSkillId] = useState('');
  const [revokeTargetService, setRevokeTargetService] = useState<GigSquareMyServiceSummary | null>(null);
  const [modifyTargetService, setModifyTargetService] = useState<GigSquareMyServiceSummary | null>(null);
  const [modifyDraft, setModifyDraft] = useState<ModifyDraft | null>(null);
  const [modifyMrc20Assets, setModifyMrc20Assets] = useState<SelectableMrc20Asset[]>([]);
  const [modifyError, setModifyError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<MutationNotice | null>(null);
  const modifyIconInputRef = useRef<HTMLInputElement | null>(null);

  const activeView = view ?? internalView;
  const activeServicesPage = servicesPage ?? internalServicesPage;
  const activeSelectedService = selectedService ?? internalSelectedService;
  const activeOrdersPage = ordersPage ?? internalOrdersPage;
  const detailServiceId = activeSelectedService?.id?.trim() || '';
  const modifySkillOptions = useMemo(
    () => buildGigSquareModifySkillOptions(skills, modifyDraft?.providerSkill),
    [modifyDraft?.providerSkill, skills],
  );
  const modifyMrc20Options = useMemo(() => {
    if (!modifyDraft || modifyDraft.currency !== 'MRC20') return [];
    const options = [...modifyMrc20Assets];
    const currentMrc20Id = modifyDraft.mrc20Id.trim();
    const currentTicker = modifyDraft.mrc20Ticker.trim();
    if (currentMrc20Id && currentTicker && !options.some((item) => item.mrc20Id === currentMrc20Id)) {
      options.unshift({
        symbol: currentTicker,
        mrc20Id: currentMrc20Id,
        balance: {
          confirmed: '0',
          unconfirmed: '0',
          pendingIn: '0',
          pendingOut: '0',
          display: '0',
        },
      });
    }
    return options;
  }, [modifyDraft, modifyMrc20Assets]);

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

  const loadSkills = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electron?.skills?.list) return;
    try {
      const result = await window.electron.skills.list();
      if (result?.success && Array.isArray(result.skills)) {
        setSkills(result.skills);
      } else {
        setSkills([]);
      }
    } catch {
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void loadSkills();
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
    setSkills([]);
    setModifySelectedSkillId('');
    setRevokeTargetService(null);
    setModifyTargetService(null);
    setModifyDraft(null);
    setModifyMrc20Assets([]);
    setModifyError(null);
    setMutationNotice(null);
    if (modifyIconInputRef.current) {
      modifyIconInputRef.current.value = '';
    }
  }, [isOpen, loadSkills]);

  useEffect(() => {
    if (!modifyDraft) return;
    const resolved = resolveGigSquareModifySkillSelection(skills, modifyDraft.providerSkill);
    setModifySelectedSkillId((prev) => (
      prev === resolved.selectedSkillId ? prev : resolved.selectedSkillId
    ));
    if (resolved.providerSkill !== modifyDraft.providerSkill) {
      setModifyDraft((prev) => (
        prev ? { ...prev, providerSkill: resolved.providerSkill } : prev
      ));
    }
  }, [modifyDraft, skills]);

  useEffect(() => {
    if (!modifyDraft || modifyDraft.currency === 'MRC20') return;
    setModifyMrc20Assets([]);
    if (!modifyDraft.mrc20Ticker && !modifyDraft.mrc20Id) return;
    setModifyDraft((prev) => (prev ? {
      ...prev,
      mrc20Ticker: '',
      mrc20Id: '',
    } : prev));
  }, [modifyDraft]);

  useEffect(() => {
    if (!isOpen || !modifyTargetService || !modifyDraft || modifyDraft.currency !== 'MRC20') return;
    const creatorMetabotId = modifyTargetService.creatorMetabotId;
    if (typeof creatorMetabotId !== 'number' || creatorMetabotId <= 0) {
      setModifyMrc20Assets([]);
      return;
    }
    let isCancelled = false;
    const loadMrc20Assets = async () => {
      try {
        const result = await window.electron.idbots.getMetabotWalletAssets({ metabotId: creatorMetabotId });
        if (isCancelled) return;
        const options = getSelectableGigSquareMrc20Assets(result?.assets?.mrc20Assets || []);
        setModifyMrc20Assets(options);
      } catch {
        if (isCancelled) return;
        setModifyMrc20Assets([]);
      }
    };
    void loadMrc20Assets();
    return () => {
      isCancelled = true;
    };
  }, [isOpen, modifyTargetService?.creatorMetabotId, modifyDraft?.currency]);

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
    setModifyMrc20Assets([]);
    setModifySelectedSkillId('');
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
    const nextDraft = buildModifyDraftFromService(service);
    const resolvedSelection = resolveGigSquareModifySkillSelection(skills, nextDraft.providerSkill);
    setModifyTargetService(service);
    setModifyDraft({
      ...nextDraft,
      providerSkill: resolvedSelection.providerSkill,
    });
    setModifyMrc20Assets([]);
    setModifySelectedSkillId(resolvedSelection.selectedSkillId);
    setModifyError(null);
    if (modifyIconInputRef.current) {
      modifyIconInputRef.current.value = '';
    }
  }, [mutationBusyServiceId, skills]);

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
        mrc20Ticker: modifyDraft.currency === 'MRC20' ? modifyDraft.mrc20Ticker.trim() : undefined,
        mrc20Id: modifyDraft.currency === 'MRC20' ? modifyDraft.mrc20Id.trim() : undefined,
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
  const modifyPriceLimitText = modifyDraft ? getGigSquarePublishPriceLimitText(modifyDraft.currency) : '';
  const paginationStart = paginationPage.total > 0
    ? (paginationPage.page - 1) * paginationPage.pageSize + 1
    : 0;
  const paginationEnd = paginationPage.total > 0
    ? Math.min(paginationPage.page * paginationPage.pageSize, paginationPage.total)
    : 0;

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
        className="modal-content relative flex h-[min(84vh,880px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-modal dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between gap-4 border-b border-claude-border px-5 py-3.5 dark:border-claude-darkBorder">
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {mutationNotice && (
            <div className={`mb-4 rounded-xl border px-4 py-3 ${
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
            <div className="space-y-3">
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
                    className="rounded-xl border border-claude-border bg-[var(--bg-panel)] px-4 py-2.5 dark:border-claude-darkBorder dark:bg-claude-darkSurface"
                  >
                    <div className="flex items-start gap-2.5">
                      {service.serviceIcon ? (
                        <img
                          src={service.serviceIcon}
                          alt={getServiceDisplayName(service)}
                          className="h-10 w-10 rounded-xl border border-claude-border object-cover dark:border-claude-darkBorder"
                        />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-claude-accent/15 text-sm font-semibold text-claude-accent">
                          {getServiceDisplayName(service).slice(0, 1).toUpperCase()}
                        </div>
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-[15px] font-semibold text-claude-text dark:text-claude-darkText">
                                {getServiceDisplayName(service)}
                              </div>
                              {service.providerSkill && (
                                <span className="rounded-full bg-claude-surfaceMuted px-2 py-0.5 text-[11px] font-medium text-claude-textSecondary dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary">
                                  {service.providerSkill}
                                </span>
                              )}
                              <span className="rounded-full bg-claude-accent/10 px-2 py-0.5 text-[11px] font-semibold text-claude-accent">
                                {price.amount} {price.unit}
                              </span>
                            </div>

                            <div className="mt-0.5 font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {service.serviceName || service.id}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
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
                          </div>

                          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:ml-auto sm:max-w-[220px]">
                            <button
                              type="button"
                              onClick={() => handleOpenDetail(service)}
                              className="btn-idchat-primary whitespace-nowrap px-2.5 py-1 text-[11px] font-medium"
                            >
                              {i18nService.t('gigSquareMyServicesActionDetail')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenModify(service)}
                              disabled={editDisabled}
                              title={!service.canModify ? i18nService.t(blockedReasonKey) : undefined}
                              className="rounded-lg border border-claude-border whitespace-nowrap px-2.5 py-1 text-[11px] font-medium text-claude-textSecondary hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                            >
                              {i18nService.t('gigSquareMyServicesActionEdit')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenRevoke(service)}
                              disabled={revokeDisabled}
                              title={!service.canRevoke ? i18nService.t(blockedReasonKey) : undefined}
                              className="rounded-lg border border-red-400/40 whitespace-nowrap px-2.5 py-1 text-[11px] font-medium text-red-600 hover:bg-red-500/5 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-300"
                            >
                              {i18nService.t('gigSquareMyServicesActionRevoke')}
                            </button>
                          </div>
                        </div>

                        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-claude-border/70 pt-2.5 dark:border-claude-darkBorder/70">
                          <div className="flex flex-wrap gap-2">
                            <CompactMetric
                              label={i18nService.t(getMyServiceMetricLabel('grossRevenue'))}
                              value={`${grossRevenue.amount} ${grossRevenue.unit}`}
                              emphasis
                            />
                            <CompactMetric
                              label={i18nService.t(getMyServiceMetricLabel('netIncome'))}
                              value={`${netIncome.amount} ${netIncome.unit}`}
                            />
                            <CompactMetric
                              label={i18nService.t(getMyServiceMetricLabel('ratingAvg'))}
                              value={ratingText}
                            />
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                            <span>
                              {i18nService.t(getMyServiceMetricLabel('successCount'))} {service.successCount}
                            </span>
                            <span>
                              {i18nService.t(getMyServiceMetricLabel('refundCount'))} {service.refundCount}
                            </span>
                          </div>
                        </div>
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
                <div className="rounded-xl border border-claude-border bg-[var(--bg-panel)] px-5 py-4 dark:border-claude-darkBorder dark:bg-claude-darkSurface">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="text-lg font-semibold text-claude-text dark:text-claude-darkText">
                        {getServiceDisplayName(activeSelectedService)}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {activeSelectedService.serviceName || activeSelectedService.id}
                      </div>
                      {activeSelectedService.description && (
                        <p className="mt-2 max-w-3xl text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                          {activeSelectedService.description}
                        </p>
                      )}

                      <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-lg bg-claude-surfaceMuted/80 px-3 py-2 dark:bg-claude-darkSurfaceMuted/80">
                          <div className="text-[11px]">{i18nService.t('gigSquareMyServicesCreatorMetabot')}</div>
                          <div className="mt-1 font-medium text-claude-text dark:text-claude-darkText">
                            {activeSelectedService.creatorMetabotName || activeSelectedService.creatorMetabotId || '—'}
                          </div>
                        </div>
                        <div className="rounded-lg bg-claude-surfaceMuted/80 px-3 py-2 dark:bg-claude-darkSurfaceMuted/80">
                          <div className="text-[11px]">{i18nService.t('gigSquareMyServicesUpdatedAt')}</div>
                          <div className="mt-1 font-medium text-claude-text dark:text-claude-darkText">
                            {formatDateTime(activeSelectedService.updatedAt)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-claude-surfaceMuted/80 px-3 py-2 dark:bg-claude-darkSurfaceMuted/80">
                          <div className="text-[11px]">{i18nService.t(getMyServiceMetricLabel('successCount'))}</div>
                          <div className="mt-1 font-medium text-claude-text dark:text-claude-darkText">
                            {activeSelectedService.successCount ?? 0}
                            <span className="mx-1 text-claude-textSecondary dark:text-claude-darkTextSecondary">/</span>
                            {i18nService.t(getMyServiceMetricLabel('refundCount'))} {activeSelectedService.refundCount ?? 0}
                          </div>
                        </div>
                        <div className="rounded-lg bg-claude-surfaceMuted/80 px-3 py-2 dark:bg-claude-darkSurfaceMuted/80">
                          <div className="text-[11px]">{i18nService.t(getMyServiceMetricLabel('ratingAvg'))}</div>
                          <div className="mt-1 font-medium text-claude-text dark:text-claude-darkText">
                            {activeSelectedService.ratingCount
                              ? `${activeSelectedService.ratingAvg.toFixed(1)} / 5`
                              : i18nService.t('gigSquareMyServicesRatingEmpty')}
                          </div>
                        </div>
                      </div>
                    </div>
                    {activeSelectedService.price && activeSelectedService.currency && (
                      <div className="shrink-0 rounded-xl bg-claude-surfaceMuted px-4 py-3 dark:bg-claude-darkSurfaceMuted">
                        <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                          {formatGigSquarePrice(activeSelectedService.price, activeSelectedService.currency).unit}
                        </div>
                        <div className="mt-1 text-lg font-semibold text-claude-accent">
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
                const buyerMetaid = String(order.counterpartyGlobalMetaid || '').trim();
                const ratingTxid = extractPinTxid(order.rating?.pinId);
                const sessionAction = getMyServiceSessionActionState(order.coworkSessionId);
                return (
                  <div
                    key={order.id}
                    className="mx-auto w-full rounded-xl border border-claude-border bg-[var(--bg-panel)] px-4 py-3 dark:border-claude-darkBorder dark:bg-claude-darkSurface xl:max-w-[85%]"
                  >
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start gap-3">
                              {order.counterpartyAvatar ? (
                                <img
                                  src={order.counterpartyAvatar}
                                  alt={buyerName}
                                  className="h-10 w-10 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder"
                                />
                              ) : (
                                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-claude-accent/15 text-xs font-semibold text-claude-accent">
                                  {buyerName.slice(0, 1).toUpperCase()}
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getMyServiceOrderStatusClassName(order.status)}`}>
                                    {i18nService.t(getMyServiceOrderStatusKey(order.status))}
                                  </span>
                                  <div className="truncate text-sm font-semibold text-claude-text dark:text-claude-darkText">
                                    {buyerName}
                                  </div>
                                  <span className="font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                    #{shortenMyServiceHash(order.id, 8, 4)}
                                  </span>
                                </div>
                                {buyerMetaid && buyerName !== buyerMetaid && (
                                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                    <span className="font-mono">{shortenMetaid(buyerMetaid)}</span>
                                    <CopyValueButton value={buyerMetaid} compact />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-end gap-3 lg:justify-end">
                            <div className="rounded-lg bg-claude-surfaceMuted/80 px-3 py-2 text-right dark:bg-claude-darkSurfaceMuted/80">
                              <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                {i18nService.t('gigSquareMyServicesOrderAmount')}
                              </div>
                              <div className="mt-1 text-sm font-semibold text-claude-text dark:text-claude-darkText">
                                {price.amount} {price.unit}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary md:grid-cols-2 xl:grid-cols-4">
                          <div className="rounded-lg bg-claude-surfaceMuted/60 px-3 py-2 dark:bg-claude-darkSurfaceMuted/60">
                            <div className="text-[11px]">{i18nService.t('gigSquareMyServicesOrderCreatedAt')}</div>
                            <div className="mt-1 text-sm text-claude-text dark:text-claude-darkText">
                              {formatDateTime(order.createdAt)}
                            </div>
                          </div>
                          <div className="rounded-lg bg-claude-surfaceMuted/60 px-3 py-2 dark:bg-claude-darkSurfaceMuted/60">
                            <div className="text-[11px]">{i18nService.t('gigSquareMyServicesOrderDeliveredAt')}</div>
                            <div className="mt-1 text-sm text-claude-text dark:text-claude-darkText">
                              {formatDateTime(order.deliveredAt)}
                            </div>
                          </div>
                          <div className="rounded-lg bg-claude-surfaceMuted/60 px-3 py-2 dark:bg-claude-darkSurfaceMuted/60">
                            <div className="text-[11px]">{i18nService.t('gigSquareMyServicesOrderRefundedAt')}</div>
                            <div className="mt-1 text-sm text-claude-text dark:text-claude-darkText">
                              {formatDateTime(order.refundCompletedAt)}
                            </div>
                          </div>
                          <div className="rounded-lg bg-claude-surfaceMuted/60 px-3 py-2 dark:bg-claude-darkSurfaceMuted/60">
                            <div className="text-[11px]">{i18nService.t('gigSquareMyServicesOrderTxid')}</div>
                            <div className="mt-1 flex items-center gap-2">
                              <div className="min-w-0 break-all font-mono text-xs text-claude-text dark:text-claude-darkText">
                                {order.paymentTxid ? shortenMyServiceHash(order.paymentTxid, 14, 8) : '—'}
                              </div>
                              {order.paymentTxid && <CopyValueButton value={order.paymentTxid} />}
                            </div>
                          </div>
                        </div>

                        {(order.rating || order.rating?.comment) && (
                          <div className="mt-3 rounded-lg border border-claude-border/70 bg-claude-surfaceMuted/60 px-3 py-3 dark:border-claude-darkBorder/70 dark:bg-claude-darkSurfaceMuted/60">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                  {i18nService.t('gigSquareMyServicesOrderRating')}
                                </div>
                                <div className="mt-1 text-sm font-medium text-claude-text dark:text-claude-darkText">
                                  {order.rating
                                    ? `${order.rating.rate} / 5`
                                    : i18nService.t('gigSquareMyServicesOrderUnrated')}
                                </div>
                              </div>
                              {order.rating?.pinId && (
                                <div className="min-w-0">
                                  <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                    {i18nService.t('gigSquareMyServicesOrderRatingTxid')}
                                  </div>
                                  <div className="mt-1 flex items-center gap-2">
                                    <div className="min-w-0 break-all font-mono text-xs text-claude-text dark:text-claude-darkText">
                                      {shortenMyServiceHash(ratingTxid, 14, 8)}
                                    </div>
                                    <CopyValueButton value={ratingTxid} />
                                  </div>
                                </div>
                              )}
                            </div>
                            {order.rating?.comment && (
                              <div className="mt-3">
                                <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                  {i18nService.t('gigSquareMyServicesOrderComment')}
                                </div>
                                <div className="mt-1 whitespace-pre-wrap text-sm text-claude-text dark:text-claude-darkText">
                                  {order.rating.comment}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="shrink-0 xl:w-40">
                        <button
                          type="button"
                          onClick={() => handleViewSession(order.coworkSessionId)}
                          disabled={sessionAction.disabled}
                          title={sessionAction.key ? i18nService.t(sessionAction.key) : undefined}
                          className="btn-idchat-primary w-full whitespace-nowrap px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
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
          <div className="flex items-center justify-between border-t border-claude-border px-5 py-3 dark:border-claude-darkBorder">
            <div className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {paginationStart}-{paginationEnd} / {paginationPage.total}
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
              className="w-full max-w-3xl rounded-2xl border border-claude-border bg-[var(--bg-main)] p-6 shadow-xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
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

              <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_320px]">
                <div className="space-y-4 rounded-xl border border-claude-border bg-[var(--bg-panel)] p-4 dark:border-claude-darkBorder dark:bg-claude-darkSurface">
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
                      rows={5}
                      disabled={isModifySubmitting}
                      placeholder={i18nService.t('gigSquarePublishDescriptionPlaceholder')}
                      className="w-full rounded-xl border border-claude-border bg-[var(--bg-panel)] px-3 py-2 text-sm text-claude-text placeholder-claude-textSecondary focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkSurface dark:text-claude-darkText dark:placeholder-claude-darkTextSecondary"
                    />
                  </div>
                </div>

                <div className="space-y-4 rounded-xl border border-claude-border bg-[var(--bg-panel)] p-4 dark:border-claude-darkBorder dark:bg-claude-darkSurface">
                  <div className="grid grid-cols-1 gap-4">
                    <div>
                      <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('gigSquarePublishSkillLabel')}
                      </label>
                      <select
                        value={modifySelectedSkillId}
                        onChange={(event) => {
                          const nextSkillId = event.target.value;
                          setModifySelectedSkillId(nextSkillId);
                          const selectedSkill = modifySkillOptions.find((skill) => skill.id === nextSkillId);
                          setModifyDraft((prev) => (prev ? {
                            ...prev,
                            providerSkill: selectedSkill?.name || '',
                          } : prev));
                        }}
                        disabled={isModifySubmitting}
                        className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
                      >
                        <option value="">
                          {i18nService.t('gigSquarePublishSkillLabel')}
                        </option>
                        {modifySkillOptions.map((skill) => (
                          <option key={skill.id} value={skill.id}>
                            {skill.name}
                          </option>
                        ))}
                      </select>
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
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                            mrc20Ticker: normalizeModifyCurrency(event.target.value) === 'MRC20' ? prev.mrc20Ticker : '',
                            mrc20Id: normalizeModifyCurrency(event.target.value) === 'MRC20' ? prev.mrc20Id : '',
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
                    {modifyDraft.currency === 'MRC20' && (
                      <div>
                        <label className="mb-1 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                          MRC20 Token
                        </label>
                        <select
                          value={modifyDraft.mrc20Id}
                          onChange={(event) => {
                            const nextMrc20Id = event.target.value;
                            const selectedAsset = modifyMrc20Options.find((item) => item.mrc20Id === nextMrc20Id);
                            setModifyDraft((prev) => (prev ? {
                              ...prev,
                              mrc20Id: nextMrc20Id,
                              mrc20Ticker: selectedAsset?.symbol || '',
                            } : prev));
                          }}
                          disabled={isModifySubmitting}
                          className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
                        >
                          <option value="">
                            {modifyMrc20Options.length > 0 ? 'Select token' : 'No available MRC20 token'}
                          </option>
                          {modifyMrc20Options.map((asset) => (
                            <option key={asset.mrc20Id} value={asset.mrc20Id}>
                              {asset.symbol} ({asset.balance.display})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {modifyPriceLimitText && (
                      <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('gigSquarePublishPriceLimitPrefix')}{modifyPriceLimitText}
                      </p>
                    )}
                    <div className="rounded-xl border border-dashed border-claude-border/80 bg-claude-surfaceMuted/60 p-3 dark:border-claude-darkBorder/80 dark:bg-claude-darkSurfaceMuted/60">
                      <label className="mb-3 block text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('gigSquarePublishIconLabel')}
                      </label>
                      <div className="flex items-center gap-3">
                        {modifyDraft.serviceIconDataUrl || modifyTargetService.serviceIcon ? (
                          <img
                            src={modifyDraft.serviceIconDataUrl || modifyTargetService.serviceIcon || ''}
                            alt={getServiceDisplayName(modifyTargetService)}
                            className="h-14 w-14 rounded-xl border border-claude-border object-cover dark:border-claude-darkBorder"
                          />
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-claude-border text-claude-textSecondary dark:border-claude-darkBorder dark:text-claude-darkTextSecondary">
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
