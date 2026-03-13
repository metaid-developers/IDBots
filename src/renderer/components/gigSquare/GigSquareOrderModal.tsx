import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { GigSquareService } from '../../types/gigSquare';
import { formatGigSquarePrice, getGigSquarePaymentAmount } from '../../utils/gigSquare';

interface GigSquareOrderModalProps {
  service: GigSquareService | null;
  isOpen: boolean;
  onClose: () => void;
  buyerMetabotId: number | null;
}

type OrderStatus = 'idle' | 'paying' | 'sending' | 'success';

const GigSquareOrderModal: React.FC<GigSquareOrderModalProps> = ({
  service,
  isOpen,
  onClose,
  buyerMetabotId,
}) => {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<OrderStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPrompt('');
    setStatus('idle');
    setError(null);
  }, [isOpen]);

  const priceDisplay = useMemo(() => {
    if (!service) return null;
    return formatGigSquarePrice(service.price, service.currency);
  }, [service]);

  const paymentAmount = useMemo(() => {
    if (!service) return '0';
    return getGigSquarePaymentAmount(service.price);
  }, [service]);

  const statusText = status === 'paying'
    ? i18nService.t('gigSquarePaying')
    : status === 'sending'
      ? i18nService.t('gigSquareSending')
      : status === 'success'
        ? i18nService.t('gigSquareOrderSent')
        : '';

  if (!isOpen || !service) return null;

  const handleSubmit = async () => {
    if (!buyerMetabotId) {
      setError(i18nService.t('gigSquareNoTwin'));
      return;
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError(i18nService.t('gigSquarePromptRequired'));
      return;
    }
    if (!service.providerAddress) {
      setError(i18nService.t('gigSquareOrderFailed'));
      return;
    }

    setError(null);
    setStatus('paying');

    try {
      const payment = await window.electron.idbots.executeTransfer({
        metabotId: buyerMetabotId,
        chain: 'mvc',
        toAddress: service.providerAddress,
        amountSpaceOrDoge: paymentAmount,
        feeRate: 1,
      });

      if (!payment?.success) {
        throw new Error(payment?.error || i18nService.t('gigSquarePaymentFailed'));
      }

      const txId = typeof payment.txId === 'string' ? payment.txId : '';
      if (!txId) {
        throw new Error(i18nService.t('gigSquarePaymentFailed'));
      }

      setStatus('sending');

      const providerInfo = await window.electron.gigSquare.fetchProviderInfo({
        providerMetaId: service.providerMetaId,
      });

      if (!providerInfo?.success || !providerInfo.chatPubkey) {
        throw new Error(providerInfo?.error || i18nService.t('gigSquareOrderFailed'));
      }

      const toGlobalMetaId = service.providerGlobalMetaId || service.providerMetaId;
      if (!toGlobalMetaId) {
        throw new Error(i18nService.t('gigSquareOrderFailed'));
      }

      const orderPayload = `[ORDER] ${JSON.stringify({
        txid: txId,
        serviceName: service.serviceName,
        prompt: trimmedPrompt,
      })}`;

      const sendResult = await window.electron.gigSquare.sendOrder({
        metabotId: buyerMetabotId,
        toGlobalMetaId,
        toChatPubkey: providerInfo.chatPubkey,
        orderPayload,
      });

      if (!sendResult?.success) {
        throw new Error(sendResult?.error || i18nService.t('gigSquareOrderFailed'));
      }

      setStatus('success');
      window.setTimeout(() => {
        onClose();
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('gigSquareOrderFailed'));
      setStatus('idle');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60"
        onClick={status === 'idle' ? onClose : undefined}
        aria-hidden
      />
      <div
        className="relative w-full max-w-lg rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('gigSquareOrderTitle')}
            </h3>
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
              {service.displayName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2 py-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            disabled={status !== 'idle'}
          >
            {i18nService.t('close')}
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border p-3 bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted">
            <div className="flex items-center justify-between text-sm dark:text-claude-darkText text-claude-text">
              <span>{i18nService.t('gigSquareOrderService')}</span>
              <span className="font-medium">{service.serviceName}</span>
            </div>
            {priceDisplay && (
              <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {priceDisplay.amount} {priceDisplay.unit}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              {i18nService.t('gigSquarePromptLabel')}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={i18nService.t('gigSquarePromptPlaceholder')}
              rows={4}
              className="w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text placeholder-claude-textSecondary dark:placeholder-claude-darkTextSecondary focus:outline-none focus:ring-2 focus:ring-claude-accent"
              disabled={status !== 'idle'}
            />
          </div>

          {statusText && (
            <div className="text-xs font-medium text-claude-accent">
              {statusText}
            </div>
          )}

          {error && (
            <div className="text-xs text-red-500">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              disabled={status !== 'idle'}
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="btn-idchat-primary px-4 py-2 text-sm font-medium"
              disabled={status !== 'idle'}
            >
              {i18nService.t('gigSquarePayAndRequest')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GigSquareOrderModal;
