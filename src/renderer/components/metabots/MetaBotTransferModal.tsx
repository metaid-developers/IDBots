/**
 * MetaBot Transfer Modal
 * Step 1: Receiver, amount (with max balance), fee rate. Step 2: Confirm and broadcast.
 * Supports SPACE (MVC) and DOGE only; BTC not implemented.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';

export type TransferChain = 'mvc' | 'doge' | 'btc';

export interface MetaBotTransferModalProps {
  metabot: Metabot;
  chain: TransferChain;
  fromAddress: string;
  maxBalance: string;
  unit: string;
  onClose: () => void;
  onSuccess?: () => void;
}

interface FeeOption {
  title: string;
  desc: string;
  feeRate: number;
}

interface TransferPreview {
  fromAddress: string;
  toAddress: string;
  amount: string;
  amountUnit: string;
  feeEstimated: string;
  feeEstimatedUnit: string;
  total: string;
  totalUnit: string;
  feeRateSatPerVb: number;
}

const MetaBotTransferModal: React.FC<MetaBotTransferModalProps> = ({
  metabot,
  chain,
  fromAddress: _fromAddress,
  maxBalance,
  unit,
  onClose,
  onSuccess,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [receiver, setReceiver] = useState('');
  const [amount, setAmount] = useState('');
  const [feeOptions, setFeeOptions] = useState<FeeOption[]>([]);
  const [selectedFeeRate, setSelectedFeeRate] = useState(0);
  const [feeSummaryLoading, setFeeSummaryLoading] = useState(true);
  const [validationError, setValidationError] = useState('');
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [successTxId, setSuccessTxId] = useState<string>('');
  const [showFeeSelect, setShowFeeSelect] = useState(false);
  const [txIdCopied, setTxIdCopied] = useState(false);

  const maxBalanceNum = parseFloat(maxBalance) || 0;

  const loadFeeSummary = useCallback(async () => {
    setFeeSummaryLoading(true);
    try {
      const res = await window.electron.idbots.getTransferFeeSummary(chain);
      if (res.success && res.list?.length) {
        setFeeOptions(res.list);
        if (res.defaultFeeRate != null) setSelectedFeeRate(res.defaultFeeRate);
        else {
          const avg = res.list.find((x) => x.title === 'Avg');
          if (avg) setSelectedFeeRate(avg.feeRate);
        }
      }
    } finally {
      setFeeSummaryLoading(false);
    }
  }, [chain]);

  useEffect(() => {
    loadFeeSummary();
  }, [loadFeeSummary]);

  const validateAndGoNext = async () => {
    setValidationError('');
    const to = receiver.trim();
    if (!to) {
      setValidationError(i18nService.t('transferReceiverRequired'));
      return;
    }
    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setValidationError(i18nService.t('transferAmountInvalid'));
      return;
    }
    if (amountNum > maxBalanceNum) {
      setValidationError(i18nService.t('transferAmountExceedsBalance'));
      return;
    }
    if (chain === 'doge' && amountNum < 0.01) {
      setValidationError('Minimum 0.01 DOGE');
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await window.electron.idbots.buildTransferPreview({
        metabotId: metabot.id,
        chain,
        toAddress: to,
        amountSpaceOrDoge: amount,
        feeRate: selectedFeeRate,
      });
      if (res.success && res.preview) {
        setPreview(res.preview);
        setStep(2);
      } else {
        setValidationError(res.error || 'Failed to build preview');
      }
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : 'Failed to build preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setSending(true);
    try {
      const res = await window.electron.idbots.executeTransfer({
        metabotId: metabot.id,
        chain,
        toAddress: preview.toAddress,
        amountSpaceOrDoge: amount,
        feeRate: selectedFeeRate,
      });
      if (res.success) {
        setSuccessTxId(res.txId || '');
        setStep(3);
      } else {
        setValidationError(res.error || i18nService.t('transferFailed'));
      }
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : i18nService.t('transferFailed'));
    } finally {
      setSending(false);
    }
  };

  const formatShort = (addr: string) => {
    if (!addr || addr.length < 20) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={onClose} aria-hidden />
      <div
        className="relative w-full max-w-md rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {step === 1 && (
          <>
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text mb-4">
              {i18nService.t('transferTitle')} ({unit})
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('transferReceiver')}
                </label>
                <input
                  type="text"
                  value={receiver}
                  onChange={(e) => setReceiver(e.target.value)}
                  placeholder={i18nService.t('transferReceiverPlaceholder')}
                  className="w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text placeholder-claude-textSecondary dark:placeholder-claude-darkTextSecondary focus:outline-none focus:ring-2 focus:ring-claude-accent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('transferAmount')}（{i18nService.t('transferAmountMax')}：{maxBalance} {unit}）
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00000000"
                  className="w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text placeholder-claude-textSecondary focus:outline-none focus:ring-2 focus:ring-claude-accent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('transferFeeRate')}
                </label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowFeeSelect((v) => !v)}
                    className="w-full flex items-center justify-between rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text"
                  >
                    <span>
                      {feeSummaryLoading
                        ? '...'
                        : chain === 'mvc' || chain === 'btc'
                          ? `${selectedFeeRate} sat/vB`
                          : `${(selectedFeeRate / 1e6).toFixed(2)} sat/kB`}
                    </span>
                    <ChevronRightIcon className={`h-4 w-4 transition-transform ${showFeeSelect ? 'rotate-90' : ''}`} />
                  </button>
                  {showFeeSelect && feeOptions.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface py-1 shadow-lg z-10">
                      {feeOptions.map((opt) => (
                        <button
                          key={opt.title}
                          type="button"
                          onClick={() => {
                            setSelectedFeeRate(opt.feeRate);
                            setShowFeeSelect(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                        >
                          {opt.title} – {chain === 'mvc' || chain === 'btc' ? `${opt.feeRate} sat/vB` : `${(opt.feeRate / 1e6).toFixed(2)} sat/kB`} ({opt.desc})
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            {validationError && (
              <p className="mt-2 text-sm text-red-500 dark:text-red-400">{validationError}</p>
            )}
            <div className="mt-6 flex justify-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-6 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('close')}
              </button>
              <button
                type="button"
                onClick={validateAndGoNext}
                disabled={previewLoading || feeSummaryLoading}
                className="rounded-xl bg-claude-accent px-6 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {previewLoading ? '...' : i18nService.t('transferNext')}
              </button>
            </div>
          </>
        )}

        {step === 2 && preview && (
          <>
            <div className="text-center mb-4">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-claude-accent/20 dark:bg-claude-accent/30 mb-2">
                <span className="text-lg font-bold text-claude-accent">{unit}</span>
              </div>
              <p className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {preview.amount} {preview.amountUnit}
              </p>
            </div>
            <div className="space-y-2 text-sm mb-6">
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferFrom')}</span>
                <span className="dark:text-claude-darkText text-claude-text font-mono truncate max-w-[220px]" title={preview.fromAddress}>
                  {formatShort(preview.fromAddress)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferTo')}</span>
                <span className="dark:text-claude-darkText text-claude-text font-mono truncate max-w-[220px]" title={preview.toAddress}>
                  {formatShort(preview.toAddress)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferAmountLabel')}</span>
                <span className="dark:text-claude-darkText text-claude-text">
                  {preview.amount} {preview.amountUnit}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferFeeEstimated')}</span>
                <span className="dark:text-claude-darkText text-claude-text">
                  {preview.feeEstimated} {preview.feeEstimatedUnit}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t dark:border-claude-darkBorder border-claude-border">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary font-medium">{i18nService.t('transferTotal')}</span>
                <span className="dark:text-claude-darkText text-claude-text font-medium">
                  {preview.total} {preview.totalUnit}
                </span>
              </div>
            </div>
            {validationError && (
              <p className="mb-2 text-sm text-red-500 dark:text-red-400">{validationError}</p>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('transferCancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={sending}
                className="flex-1 rounded-xl bg-claude-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {sending ? '...' : i18nService.t('transferConfirm')}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="text-center mb-5">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-500/20 dark:bg-green-400/20 mb-3">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-green-500 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              </div>
              <p className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('transferSuccess')}
              </p>
            </div>
            <div className="mb-5">
                <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">TxID</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 text-xs font-mono dark:text-claude-darkText text-claude-text bg-[var(--bg-panel)] dark:bg-claude-darkSurface border dark:border-claude-darkBorder border-claude-border rounded-lg px-3 py-2 break-all select-all">
                    {successTxId}
                  </code>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard.writeText(successTxId); setTxIdCopied(true); window.setTimeout(() => setTxIdCopied(false), 2000); window.dispatchEvent(new CustomEvent('app:showToast', { detail: 'TxID copied!' })); }}
                    className="shrink-0 rounded-lg border dark:border-claude-darkBorder border-claude-border p-2 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                    title="Copy TxID"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                  {txIdCopied && (
                    <span className="text-xs text-green-500 dark:text-green-400 font-medium shrink-0">Copied!</span>
                  )}
                </div>
            </div>
            <div className="flex justify-center">
              <button
                type="button"
onClick={() => { onSuccess?.(); onClose(); }}
                className="rounded-xl bg-claude-accent px-8 py-2.5 text-sm font-medium text-white hover:opacity-90"
              >
                {i18nService.t('close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default MetaBotTransferModal;
