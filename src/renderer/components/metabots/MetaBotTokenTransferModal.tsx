import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import type { Mrc20WalletAsset, MvcFtWalletAsset } from './MetaBotWalletAssetsModal';
import {
  buildTokenTransferExecutePayload,
  buildTokenTransferPreviewPayload,
  validateTokenTransferDraft,
} from './metabotWalletPresentation.js';

export type TokenTransferAsset = Mrc20WalletAsset | MvcFtWalletAsset;

interface FeeOption {
  title: string;
  desc: string;
  feeRate: number;
}

interface TokenTransferPreview {
  fromAddress: string;
  toAddress: string;
  amount: string;
  amountUnit: string;
  feeEstimated: string;
  feeEstimatedUnit: string;
  chainSymbol: 'BTC' | 'SPACE';
  feeRate: number;
}

interface ExecuteTokenTransferResult {
  txId: string;
  commitTxId?: string;
  revealTxId?: string;
  rawTx?: string;
}

interface MetaBotTokenTransferModalProps {
  metabot: Metabot;
  asset: TokenTransferAsset;
  onClose: () => void;
  onSuccess?: () => void;
}

function formatShort(value: string): string {
  if (!value || value.length < 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

const MetaBotTokenTransferModal: React.FC<MetaBotTokenTransferModalProps> = ({
  metabot,
  asset,
  onClose,
  onSuccess,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [receiver, setReceiver] = useState('');
  const [amount, setAmount] = useState('');
  const [feeOptions, setFeeOptions] = useState<FeeOption[]>([]);
  const [selectedFeeRate, setSelectedFeeRate] = useState(0);
  const [feeSummaryLoading, setFeeSummaryLoading] = useState(true);
  const [showFeeSelect, setShowFeeSelect] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [preview, setPreview] = useState<TokenTransferPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ExecuteTokenTransferResult | null>(null);

  const tokenKind = asset.kind;
  const maxDisplayBalance = asset.balance.display;
  const successTxId = result?.revealTxId || result?.txId || '';

  useEffect(() => {
    let cancelled = false;
    setFeeSummaryLoading(true);
    window.electron.idbots.getTokenTransferFeeSummary({ kind: tokenKind })
      .then((response) => {
        if (cancelled) return;
        if (!response.success || !response.list?.length) {
          setValidationError(response.error || i18nService.t('transferFailed'));
          return;
        }
        setFeeOptions(response.list);
        setSelectedFeeRate(response.defaultFeeRate ?? response.list[0].feeRate);
      })
      .catch((error) => {
        if (!cancelled) {
          setValidationError(error instanceof Error ? error.message : i18nService.t('transferFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) setFeeSummaryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tokenKind]);

  const feeRateLabel = useMemo(() => `${selectedFeeRate} sat/vB`, [selectedFeeRate]);

  const handleBuildPreview = async () => {
    const validation = validateTokenTransferDraft({
      amount,
      receiver,
      maxDisplayBalance,
    });

    if (!validation.valid) {
      setValidationError(i18nService.t(validation.errorKey));
      return;
    }

    setValidationError('');
    setPreviewLoading(true);
    try {
      const response = await window.electron.idbots.buildTokenTransferPreview(
        buildTokenTransferPreviewPayload({
          metabotId: metabot.id,
          kind: tokenKind,
          asset,
          receiver,
          amount,
          feeRate: selectedFeeRate,
        }),
      );

      if (!response.success || !response.preview) {
        setValidationError(response.error || i18nService.t('transferFailed'));
        return;
      }

      setPreview(response.preview);
      setStep(2);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleConfirm = async () => {
    setValidationError('');
    setSending(true);
    try {
      const response = await window.electron.idbots.executeTokenTransfer(
        buildTokenTransferExecutePayload({
          metabotId: metabot.id,
          kind: tokenKind,
          asset,
          receiver,
          amount,
          feeRate: selectedFeeRate,
        }),
      );

      if (!response.success || !response.result) {
        setValidationError(response.error || i18nService.t('transferFailed'));
        return;
      }

      setResult(response.result);
      setStep(3);
      onSuccess?.();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={onClose} aria-hidden />
      <div
        className="relative w-full max-w-md rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        {step === 1 && (
          <>
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text mb-4">
              {i18nService.t('transferTitle')} ({asset.symbol})
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('transferReceiver')}
                </label>
                <input
                  type="text"
                  value={receiver}
                  onChange={(event) => setReceiver(event.target.value)}
                  placeholder={i18nService.t('transferReceiverPlaceholder')}
                  className="w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text"
                />
              </div>
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('transferAmount')}（{i18nService.t('transferAmountMax')}：{maxDisplayBalance} {asset.symbol}）
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00000000"
                  className="w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text"
                />
              </div>
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('transferFeeRate')}
                </label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowFeeSelect((value) => !value)}
                    className="w-full flex items-center justify-between rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text"
                  >
                    <span>{feeSummaryLoading ? '...' : feeRateLabel}</span>
                    <ChevronRightIcon className={`h-4 w-4 transition-transform ${showFeeSelect ? 'rotate-90' : ''}`} />
                  </button>
                  {showFeeSelect && feeOptions.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface py-1 shadow-lg z-10">
                      {feeOptions.map((option) => (
                        <button
                          key={`${option.title}-${option.feeRate}`}
                          type="button"
                          onClick={() => {
                            setSelectedFeeRate(option.feeRate);
                            setShowFeeSelect(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                        >
                          {option.title} - {option.feeRate} sat/vB ({option.desc})
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
                className="rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-6 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
              >
                {i18nService.t('close')}
              </button>
              <button
                type="button"
                onClick={handleBuildPreview}
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
                <span className="text-lg font-bold text-claude-accent">{asset.symbol}</span>
              </div>
              <p className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {preview.amount} {preview.amountUnit}
              </p>
            </div>
            <div className="space-y-2 text-sm mb-6">
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferFrom')}</span>
                <span className="font-mono dark:text-claude-darkText text-claude-text" title={preview.fromAddress}>{formatShort(preview.fromAddress)}</span>
              </div>
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferTo')}</span>
                <span className="font-mono dark:text-claude-darkText text-claude-text" title={preview.toAddress}>{formatShort(preview.toAddress)}</span>
              </div>
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferAmountLabel')}</span>
                <span className="dark:text-claude-darkText text-claude-text">{preview.amount} {preview.amountUnit}</span>
              </div>
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferFeeEstimated')}</span>
                <span className="dark:text-claude-darkText text-claude-text">{preview.feeEstimated} {preview.feeEstimatedUnit}</span>
              </div>
            </div>
            {validationError && (
              <p className="mb-2 text-sm text-red-500 dark:text-red-400">{validationError}</p>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
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
            <div className="text-center mb-4">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-500/15 text-green-500 mb-3">
                <span className="text-xl">OK</span>
              </div>
              <p className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('transferSuccess')}
              </p>
            </div>
            <div className="space-y-2 text-sm mb-6">
              <div className="flex justify-between gap-3">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">TxID</span>
                <span className="font-mono break-all text-right dark:text-claude-darkText text-claude-text">{successTxId}</span>
              </div>
              {result?.commitTxId && (
                <div className="flex justify-between gap-3">
                  <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('tokenTransferCommitTxId')}</span>
                  <span className="font-mono break-all text-right dark:text-claude-darkText text-claude-text">{result.commitTxId}</span>
                </div>
              )}
              {result?.revealTxId && (
                <div className="flex justify-between gap-3">
                  <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('tokenTransferRevealTxId')}</span>
                  <span className="font-mono break-all text-right dark:text-claude-darkText text-claude-text">{result.revealTxId}</span>
                </div>
              )}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  if (successTxId) {
                    navigator.clipboard.writeText(successTxId);
                    window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('tokenTransferTxIdCopied') }));
                  }
                }}
                className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
              >
                {i18nService.t('metabotCopyAddress')}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl bg-claude-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
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

export default MetaBotTokenTransferModal;
