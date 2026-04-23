import React, { useCallback, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type {
  GigSquareRefundCollections,
  GigSquareRefundItem,
} from '../../types/gigSquare';

type RefundTab = 'pendingForMe' | 'initiatedByMe';
type ClipboardWriter = {
  writeText?: (value: string) => Promise<void> | void;
} | null | undefined;

interface GigSquareRefundsModalBaseProps {
  isOpen: boolean;
  refunds: GigSquareRefundCollections | null;
  isLoading?: boolean;
  loadError?: string | null;
  processingOrderId?: string | null;
  onRetry: () => void;
  onClose: () => void;
  onProcessRefund: (orderId: string) => Promise<void> | void;
}

type GigSquareRefundsModalProps = GigSquareRefundsModalBaseProps & (
  | {
    activeTab: RefundTab;
    onTabChange: (tab: RefundTab) => void;
  }
  | {
    activeTab?: undefined;
    onTabChange?: (tab: RefundTab) => void;
  }
);

const formatRefundDate = (value: number | null | undefined): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
};

const showToastMessage = (message: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const getFailureReasonLabel = (failureReason?: string | null): string | null => {
  if (failureReason === 'first_response_timeout') {
    return i18nService.t('coworkRefundReasonFirstResponseTimeout');
  }
  if (failureReason === 'delivery_timeout') {
    return i18nService.t('coworkRefundReasonDeliveryTimeout');
  }
  return failureReason ? failureReason.trim() : null;
};

export async function copyGigSquareRefundPaymentTxid(
  value: string | null | undefined,
  clipboard: ClipboardWriter
): Promise<boolean> {
  const normalized = String(value || '').trim();
  if (!normalized || !clipboard?.writeText) return false;
  try {
    await clipboard.writeText(normalized);
    return true;
  } catch {
    return false;
  }
}

export const dispatchGigSquareRefundSessionView = (
  sessionId: string | null | undefined,
  onClose: () => void
): void => {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId || typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent('cowork:viewSession', {
    detail: { sessionId: normalizedSessionId },
  }));
  onClose();
};

const RefundIdentity: React.FC<{
  item: GigSquareRefundItem;
}> = ({ item }) => {
  const avatar = String(item.counterpartyAvatar || '').trim();
  const fallbackInitial = (item.counterpartyName || item.counterpartyGlobalMetaid || '?')
    .slice(0, 1)
    .toUpperCase();

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {avatar ? (
        <img
          src={avatar}
          alt={item.counterpartyName}
          className="h-9 w-9 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder"
        />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-claude-accent/15 text-xs font-semibold text-claude-accent">
          {fallbackInitial}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold leading-5 text-claude-text dark:text-claude-darkText">
          {item.counterpartyName || item.counterpartyGlobalMetaid}
        </div>
        <div className="truncate font-mono text-[10px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {item.counterpartyGlobalMetaid}
        </div>
      </div>
    </div>
  );
};

const RefundStatusBadge: React.FC<{
  status: GigSquareRefundItem['status'];
}> = ({ status }) => {
  const isPending = status === 'refund_pending';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold leading-none ${
      isPending
        ? 'bg-amber-500/12 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300'
        : 'bg-emerald-500/12 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300'
    }`}>
      {isPending
        ? i18nService.t('gigSquareRefundsStatusPending')
        : i18nService.t('gigSquareRefundsStatusRefunded')}
    </span>
  );
};

const RefundInfoSlot: React.FC<{
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}> = ({ label, children, wide = false }) => (
  <div className={`min-w-0 rounded-xl border border-claude-border/70 bg-claude-surfaceMuted/65 px-3 py-2 dark:border-claude-darkBorder/70 dark:bg-claude-darkSurfaceMuted/65 ${
    wide ? 'sm:col-span-2 xl:col-span-1' : ''
  }`}>
    <div className="text-[10px] uppercase tracking-[0.12em] text-claude-textSecondary dark:text-claude-darkTextSecondary">
      {label}
    </div>
    <div className="mt-1 min-w-0 text-[13px] font-medium leading-5 text-claude-text dark:text-claude-darkText">
      {children}
    </div>
  </div>
);

const RefundPaymentTxid: React.FC<{
  value: string;
}> = ({ value }) => {
  const normalizedValue = String(value || '').trim();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
    const didCopy = await copyGigSquareRefundPaymentTxid(normalizedValue, clipboard);
    if (!didCopy) return;
    setCopied(true);
    showToastMessage(i18nService.t('gigSquareRefundsPaymentTxidCopied'));
    window.setTimeout(() => setCopied(false), 1600);
  }, [normalizedValue]);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px] leading-5 text-claude-textSecondary dark:text-claude-darkTextSecondary"
        title={normalizedValue}
      >
        {normalizedValue}
      </span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-claude-border text-claude-textSecondary transition hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover ${
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

const GigSquareRefundsModal: React.FC<GigSquareRefundsModalProps> = ({
  isOpen,
  refunds,
  activeTab,
  onTabChange,
  isLoading = false,
  loadError = null,
  processingOrderId = null,
  onRetry,
  onClose,
  onProcessRefund,
}) => {
  const [internalTab, setInternalTab] = useState<RefundTab>('pendingForMe');

  const resolvedTab = activeTab ?? internalTab;
  const items = useMemo(
    () => (resolvedTab === 'pendingForMe'
      ? refunds?.pendingForMe ?? []
      : refunds?.initiatedByMe ?? []),
    [refunds, resolvedTab]
  );
  const isAnyRefundProcessing = Boolean(processingOrderId);

  const setTab = useCallback((tab: RefundTab) => {
    if (activeTab == null) {
      setInternalTab(tab);
    }
    onTabChange?.(tab);
  }, [activeTab, onTabChange]);

  const handleViewSession = useCallback((sessionId: string | null) => {
    dispatchGigSquareRefundSessionView(sessionId, onClose);
  }, [onClose]);

  const emptyCopy = resolvedTab === 'pendingForMe'
    ? i18nService.t('gigSquareRefundsEmptyPending')
    : i18nService.t('gigSquareRefundsEmptyInitiated');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop">
      <div
        className="modal-content relative flex h-[min(82vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-modal dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between gap-4 border-b border-claude-border px-5 py-4 dark:border-claude-darkBorder">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-claude-text dark:text-claude-darkText">
              {i18nService.t('gigSquareRefundsTitle')}
            </h2>
            <p className="mt-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('gigSquareRefundsSubtitle')}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {loadError && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
              >
                <ArrowPathIcon className="h-4 w-4" />
                {i18nService.t('refresh')}
              </button>
            )}
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

        <div className="border-b border-claude-border px-5 py-3 dark:border-claude-darkBorder">
          <div className="inline-flex rounded-xl bg-claude-surfaceMuted p-1 dark:bg-claude-darkSurfaceMuted">
            <button
              type="button"
              onClick={() => setTab('pendingForMe')}
              className={`rounded-lg px-3.5 py-2 text-xs font-medium transition ${
                resolvedTab === 'pendingForMe'
                  ? 'bg-[var(--bg-panel)] text-claude-text shadow-sm dark:bg-claude-darkSurface dark:text-claude-darkText'
                  : 'text-claude-textSecondary hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:text-claude-darkText'
              }`}
            >
              {i18nService.t('gigSquareRefundsTabPending')}
            </button>
            <button
              type="button"
              onClick={() => setTab('initiatedByMe')}
              className={`rounded-lg px-3.5 py-2 text-xs font-medium transition ${
                resolvedTab === 'initiatedByMe'
                  ? 'bg-[var(--bg-panel)] text-claude-text shadow-sm dark:bg-claude-darkSurface dark:text-claude-darkText'
                  : 'text-claude-textSecondary hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:text-claude-darkText'
              }`}
            >
              {i18nService.t('gigSquareRefundsTabInitiated')}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && (
            <div className="rounded-2xl border border-dashed border-claude-border bg-claude-surfaceMuted px-6 py-10 text-center text-sm text-claude-textSecondary dark:border-claude-darkBorder dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary">
              {i18nService.t('gigSquareRefundsLoading')}
            </div>
          )}

          {!isLoading && loadError && (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-4">
              <div className="text-sm font-medium text-red-500">
                {loadError}
              </div>
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10"
              >
                <ArrowPathIcon className="h-4 w-4" />
                {i18nService.t('refresh')}
              </button>
            </div>
          )}

          {!isLoading && !loadError && items.length === 0 && (
            <div className="rounded-2xl border border-dashed border-claude-border bg-claude-surfaceMuted px-6 py-10 text-center dark:border-claude-darkBorder dark:bg-claude-darkSurfaceMuted">
              <div className="text-base font-medium text-claude-text dark:text-claude-darkText">
                {emptyCopy}
              </div>
            </div>
          )}

          {!isLoading && !loadError && items.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-claude-border bg-[var(--bg-panel)] dark:border-claude-darkBorder dark:bg-claude-darkSurface">
              {items.map((item, index) => {
                const failureReasonLabel = getFailureReasonLabel(item.failureReason);
                const isProcessing = processingOrderId === item.orderId;
                const showProcessRefund = resolvedTab === 'pendingForMe'
                  && item.role === 'seller'
                  && item.canProcessRefund;
                const dateLabel = item.status === 'refunded'
                  ? i18nService.t('gigSquareRefundsDateRefunded')
                  : i18nService.t('gigSquareRefundsDateRequested');
                const dateValue = item.status === 'refunded'
                  ? item.refundCompletedAt
                  : item.refundRequestedAt;

                return (
                  <div
                    key={item.orderId}
                    className={`px-4 py-3 ${index > 0 ? 'border-t border-claude-border dark:border-claude-darkBorder' : ''}`}
                  >
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                      <div className="min-w-0 flex-1 space-y-2.5">
                        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
                          <RefundIdentity item={item} />
                          <RefundStatusBadge status={item.status} />
                        </div>

                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                          <RefundInfoSlot label={i18nService.t('gigSquareRefundsFieldService')}>
                            <div className="truncate" title={item.serviceName}>
                              {item.serviceName}
                            </div>
                          </RefundInfoSlot>
                          <RefundInfoSlot label={i18nService.t('gigSquareRefundsFieldAmount')}>
                            <div>
                              {item.paymentAmount} {item.paymentCurrency}
                            </div>
                          </RefundInfoSlot>
                          <RefundInfoSlot label={dateLabel}>
                            <div>
                              {formatRefundDate(dateValue)}
                            </div>
                          </RefundInfoSlot>
                          <RefundInfoSlot
                            label={i18nService.t('gigSquareRefundsFieldPaymentTxid')}
                            wide
                          >
                            <RefundPaymentTxid value={item.paymentTxid} />
                          </RefundInfoSlot>
                        </div>

                        {failureReasonLabel && (
                          <div className="flex flex-wrap items-center gap-1.5 text-[12px] leading-5 text-claude-textSecondary dark:text-claude-darkTextSecondary">
                            <span className="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
                              {i18nService.t('gigSquareRefundsFailureReason')}
                            </span>
                            <span>{failureReasonLabel}</span>
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">
                        {item.coworkSessionId && (
                          <button
                            type="button"
                            onClick={() => handleViewSession(item.coworkSessionId)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-claude-border px-2.5 py-1.5 text-[11px] font-medium text-claude-textSecondary transition hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                          >
                            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                            {i18nService.t('gigSquareRefundsViewSession')}
                          </button>
                        )}
                        {showProcessRefund && (
                          <button
                            type="button"
                            onClick={() => void onProcessRefund(item.orderId)}
                            disabled={isAnyRefundProcessing}
                            className="btn-idchat-primary px-2.5 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isProcessing
                              ? i18nService.t('gigSquareRefundsProcessing')
                              : i18nService.t('gigSquareRefundsProcess')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GigSquareRefundsModal;
