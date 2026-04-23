import React, { useCallback, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type {
  GigSquareRefundCollections,
  GigSquareRefundItem,
} from '../../types/gigSquare';

type RefundTab = 'pendingForMe' | 'initiatedByMe';

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

const getFailureReasonLabel = (failureReason?: string | null): string | null => {
  if (failureReason === 'first_response_timeout') {
    return i18nService.t('coworkRefundReasonFirstResponseTimeout');
  }
  if (failureReason === 'delivery_timeout') {
    return i18nService.t('coworkRefundReasonDeliveryTimeout');
  }
  return failureReason ? failureReason.trim() : null;
};

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
    <div className="flex min-w-0 items-center gap-3">
      {avatar ? (
        <img
          src={avatar}
          alt={item.counterpartyName}
          className="h-10 w-10 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder"
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-claude-accent/15 text-sm font-semibold text-claude-accent">
          {fallbackInitial}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-claude-text dark:text-claude-darkText">
          {item.counterpartyName || item.counterpartyGlobalMetaid}
        </div>
        <div className="truncate font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
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
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
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
                    className={`px-4 py-4 ${index > 0 ? 'border-t border-claude-border dark:border-claude-darkBorder' : ''}`}
                  >
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0 flex-1 space-y-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <RefundIdentity item={item} />
                          <RefundStatusBadge status={item.status} />
                        </div>

                        <div className="grid gap-3 text-sm text-claude-text dark:text-claude-darkText md:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.12em] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareRefundsFieldService')}
                            </div>
                            <div className="mt-1 font-medium">
                              {item.serviceName}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.12em] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareRefundsFieldAmount')}
                            </div>
                            <div className="mt-1 font-medium">
                              {item.paymentAmount} {item.paymentCurrency}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.12em] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {dateLabel}
                            </div>
                            <div className="mt-1 font-medium">
                              {formatRefundDate(dateValue)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.12em] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {i18nService.t('gigSquareRefundsFieldPaymentTxid')}
                            </div>
                            <div className="mt-1 break-all font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                              {item.paymentTxid}
                            </div>
                          </div>
                        </div>

                        {failureReasonLabel && (
                          <div className="rounded-xl bg-claude-surfaceMuted/80 px-3.5 py-2 text-sm text-claude-textSecondary dark:bg-claude-darkSurfaceMuted/80 dark:text-claude-darkTextSecondary">
                            {i18nService.t('gigSquareRefundsFailureReason')}: {failureReasonLabel}
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">
                        {item.coworkSessionId && (
                          <button
                            type="button"
                            onClick={() => handleViewSession(item.coworkSessionId)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary transition hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                          >
                            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                            {i18nService.t('gigSquareRefundsViewSession')}
                          </button>
                        )}
                        {showProcessRefund && (
                          <button
                            type="button"
                            onClick={() => void onProcessRefund(item.orderId)}
                            disabled={isAnyRefundProcessing}
                            className="btn-idchat-primary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
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
