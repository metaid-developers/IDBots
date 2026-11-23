import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  CheckBadgeIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { FtMandatePromptEventPayload, MeTopupPackageInfo } from '../../types/electron';
import { ct, formatMeDisplay } from './commerceTradeI18n';
import { formatFtAssetBadge, formatFtRailLabel } from '../chat/ftCardSyntax';
import { buildMeOrderIdempotencyKey, normalizeMePaymentCheckout } from '../me/mePayment';

export interface FtMandateConfirmModalProps {
  open: boolean;
  prompt: FtMandatePromptEventPayload | null;
  onResolved: () => void;
  initialTradeSpendableMilli?: number;
}

type TopupPhase = 'idle' | 'picking' | 'creating' | 'paying' | 'credited';

const POLL_INTERVAL_MS = 4_000;

const FtMandateConfirmModal: React.FC<FtMandateConfirmModalProps> = ({
  open,
  prompt,
  onResolved,
  initialTradeSpendableMilli,
}) => {
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [tradeSpendableMilli, setTradeSpendableMilli] = useState<number>(
    initialTradeSpendableMilli ?? 0,
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState('');

  const [topupPhase, setTopupPhase] = useState<TopupPhase>('idle');
  const [packages, setPackages] = useState<MeTopupPackageInfo[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState('');
  const [gateway, setGateway] = useState<'alipay' | 'paypal'>('alipay');
  const [topupQrUrl, setTopupQrUrl] = useState('');
  const [topupError, setTopupError] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const draft = prompt?.draft ?? null;
  const requiresMeBalanceCheck =
    draft?.rail === 'me-escrow' && draft?.action === 'buy-sweep';
  const requiredMeMilli = requiresMeBalanceCheck
    ? Math.max(0, Number(draft?.maxSpendAmount ?? 0))
    : 0;

  const refreshMeBalance = useCallback(async () => {
    if (!requiresMeBalanceCheck) return;
    if (typeof window === 'undefined' || !window.electron?.goodsTrade?.getBuyerBalance) return;
    setLoadingBalance(true);
    try {
      const res = await window.electron.goodsTrade.getBuyerBalance({
        metabotId: draft?.metabotId,
      });
      if (res.success && res.balance) {
        setTradeSpendableMilli(res.balance.tradeSpendableMilli);
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingBalance(false);
    }
  }, [requiresMeBalanceCheck, draft?.metabotId]);

  useEffect(() => {
    if (!open || !prompt) return;
    setErrorText('');
    setTopupError('');
    setTopupPhase('idle');
    setTopupQrUrl('');
    if (initialTradeSpendableMilli !== undefined) {
      setTradeSpendableMilli(initialTradeSpendableMilli);
    } else if (requiresMeBalanceCheck) {
      void refreshMeBalance();
    }
    return () => {
      stopPolling();
    };
  }, [open, prompt, initialTradeSpendableMilli, requiresMeBalanceCheck, refreshMeBalance, stopPolling]);

  const shortfallMilli = requiresMeBalanceCheck
    ? Math.max(0, requiredMeMilli - tradeSpendableMilli)
    : 0;
  const canConfirm = !requiresMeBalanceCheck || tradeSpendableMilli >= requiredMeMilli;

  const respond = useCallback(
    async (approved: boolean) => {
      if (!prompt || submitting) return;
      setSubmitting(true);
      setErrorText('');
      try {
        await window.electron?.ftTrade?.respondMandate?.({
          requestId: prompt.requestId,
          approved,
        });
        stopPolling();
        onResolved();
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [prompt, submitting, stopPolling, onResolved],
  );

  const openInlineTopup = useCallback(async () => {
    setTopupError('');
    setTopupPhase('picking');
    try {
      const res = await window.electron?.mePoints?.getTopupPackages?.();
      if (res?.success && res.topupPackages?.length) {
        const sorted = [...res.topupPackages].sort((a, b) => (a.meMilli ?? 0) - (b.meMilli ?? 0));
        setPackages(sorted);
        const bestFit = sorted.find((p) => (p.meMilli ?? 0) >= shortfallMilli) ?? sorted[0];
        setSelectedPackageId(bestFit?.packageId ?? '');
      } else {
        setTopupError(res?.error || ct('No top-up packages available', '暂无可用充值包'));
      }
    } catch (err) {
      setTopupError(err instanceof Error ? err.message : String(err));
    }
  }, [shortfallMilli]);

  const startTopupOrder = useCallback(async () => {
    if (!selectedPackageId || !window.electron?.mePoints?.submitTopupOrder) return;
    setTopupPhase('creating');
    setTopupError('');
    try {
      const idempotencyKey = buildMeOrderIdempotencyKey({
        scope: 'desktop',
        section: 'topup',
        subjectId: selectedPackageId,
        gateway,
        generation: Math.floor(Date.now() / 1000) % 10000,
      });
      const res = await window.electron.mePoints.submitTopupOrder({
        packageId: selectedPackageId,
        gateway,
        idempotencyKey,
      });
      if (!res.success || !res.submission) {
        setTopupError(res.error || ct('Failed to create top-up order', '创建充值订单失败'));
        setTopupPhase('picking');
        return;
      }
      const selectedPkg = packages.find((p) => p.packageId === selectedPackageId);
      const checkout = normalizeMePaymentCheckout(
        res.submission.order,
        selectedPkg?.priceCny ?? 0,
        gateway === 'alipay' ? 'CNY' : 'USD',
      );
      if (!checkout?.orderId || (!checkout.qrCode && !checkout.approvalUrl)) {
        setTopupError(ct('Payment QR unavailable', '支付二维码不可用'));
        setTopupPhase('picking');
        return;
      }
      const qrPayload = checkout.qrCode || checkout.approvalUrl || '';
      const dataUrl = await QRCode.toDataURL(qrPayload, { width: 170, margin: 1 });
      setTopupQrUrl(dataUrl);
      setTopupPhase('paying');

      stopPolling();
      pollTimerRef.current = setInterval(async () => {
        try {
          const ordersRes = await window.electron?.mePoints?.getTopupOrders?.();
          const matched = ordersRes?.orders?.find((o) => o.orderId === checkout.orderId);
          const st = String(matched?.status ?? '').toLowerCase();
          if (st === 'confirmed' || st === 'credited' || st === 'paid' || st === 'success') {
            stopPolling();
            setTopupPhase('credited');
            await refreshMeBalance();
          }
        } catch {
          // Retry next tick
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setTopupError(err instanceof Error ? err.message : String(err));
      setTopupPhase('picking');
    }
  }, [selectedPackageId, gateway, packages, stopPolling, refreshMeBalance]);

  const selectedPkg = useMemo(
    () => packages.find((p) => p.packageId === selectedPackageId) ?? null,
    [packages, selectedPackageId],
  );

  if (!open || !prompt || !draft) return null;

  const actionTitle =
    draft.action === 'buy-sweep'
      ? ct('Approve Token Sweep Mandate', '确认代币扫货授权')
      : draft.action === 'list-lots'
        ? ct('Approve Batch Listing Mandate', '确认分批拆包挂单授权')
        : ct('Approve Order Cancel Mandate', '确认撤单授权');

  const assetBadge = formatFtAssetBadge(draft.assetKey);

  return (
    <div
      data-commerce-modal="ft-mandate-confirm"
      className="fixed inset-0 z-[92] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={actionTitle}
      onClick={() => void respond(false)}
    >
      <div
        className="w-[min(94vw,450px)] overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-2xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-claude-border px-4 py-3 dark:border-claude-darkBorder">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="h-5 w-5 text-claude-accent" />
            <h3 className="text-sm font-semibold text-claude-text dark:text-claude-darkText">
              {actionTitle}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => void respond(false)}
            aria-label={ct('Close', '关闭')}
            className="rounded-lg p-1 text-claude-textSecondary hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4 text-xs">
          <div className="rounded-xl border border-claude-border/80 bg-black/[0.02] p-3 dark:border-claude-darkBorder/80 dark:bg-white/[0.02]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-claude-text dark:text-claude-darkText">
                ${draft.symbol}
              </span>
              {draft.caVerified ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckBadgeIcon className="h-3.5 w-3.5" />
                  {ct('Verified', '已认证')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-amber-700 dark:text-amber-300">
                  <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                  {ct('Verify Token ID', '请核对代币 ID')} · {assetBadge}
                </span>
              )}
            </div>

            <div className="mt-2.5 space-y-1.5 border-t border-claude-border/60 pt-2 text-[11px] dark:border-claude-darkBorder/60">
              <div className="flex justify-between">
                <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {ct('Settlement Rail', '结算通道')}
                </span>
                <span className="font-medium text-claude-text dark:text-claude-darkText">
                  {ct(formatFtRailLabel(draft.rail, 'en'), formatFtRailLabel(draft.rail, 'zh'))}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {ct('Total Quantity & Lots', '总数量与批次')}
                </span>
                <span className="font-mono font-semibold text-claude-text dark:text-claude-darkText">
                  {draft.totalTokenDisplay} {draft.symbol} ({draft.lotCount} {ct('lot(s)', '份')})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {draft.action === 'buy-sweep'
                    ? ct('Max Spend Ceiling', '最高支出上限')
                    : ct('Authorized Ceiling', '单次授权上限')}
                </span>
                <span className="font-mono text-sm font-semibold text-claude-accent">
                  {draft.maxSpendDisplay}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {ct('Estimated Network Fee', '预估网络矿工费')}
                </span>
                <span className="font-mono text-claude-text dark:text-claude-darkText">
                  {draft.estimatedGasDisplay}
                </span>
              </div>
            </div>
          </div>

          {requiresMeBalanceCheck && (
            <div className="rounded-xl border border-claude-border/80 p-3 dark:border-claude-darkBorder/80">
              <div className="flex items-center justify-between">
                <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {ct('Trade-Spendable ME', '可用于交易的 ME')}
                </span>
                <span className="font-mono font-semibold text-claude-text dark:text-claude-darkText">
                  {loadingBalance ? '…' : formatMeDisplay(tradeSpendableMilli)}
                </span>
              </div>
              {shortfallMilli > 0 && (
                <div className="mt-2 space-y-2 border-t border-claude-border/60 pt-2 dark:border-claude-darkBorder/60">
                  <div className="text-[11px] text-amber-600 dark:text-amber-400">
                    {ct(
                      `Shortfall: ${formatMeDisplay(shortfallMilli)}. Top up inline to continue without leaving this mandate.`,
                      `当前差额 ${formatMeDisplay(shortfallMilli)}，可原地扫码补足后自动解锁确认。`,
                    )}
                  </div>
                  {topupPhase === 'idle' && (
                    <button
                      type="button"
                      onClick={() => void openInlineTopup()}
                      className="w-full rounded-lg bg-claude-accent/15 py-1.5 text-xs font-semibold text-claude-accent hover:bg-claude-accent/25"
                    >
                      {ct('Scan QR to Top Up ME', '原地扫码补足 ME')}
                    </button>
                  )}
                  {topupPhase === 'picking' && (
                    <div className="space-y-2">
                      <select
                        value={selectedPackageId}
                        onChange={(e) => setSelectedPackageId(e.target.value)}
                        className="w-full rounded-lg border border-claude-border bg-transparent px-2 py-1 text-xs dark:border-claude-darkBorder"
                      >
                        {packages.map((p) => (
                          <option key={p.packageId} value={p.packageId}>
                            {formatMeDisplay(p.meMilli ?? 0)} — ¥{p.priceCny}
                          </option>
                        ))}
                      </select>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setGateway('alipay')}
                          className={`flex-1 rounded-lg border py-1 text-[11px] ${gateway === 'alipay' ? 'border-claude-accent text-claude-accent' : 'border-claude-border'}`}
                        >
                          Alipay
                        </button>
                        <button
                          type="button"
                          onClick={() => setGateway('paypal')}
                          className={`flex-1 rounded-lg border py-1 text-[11px] ${gateway === 'paypal' ? 'border-claude-accent text-claude-accent' : 'border-claude-border'}`}
                        >
                          PayPal
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={!selectedPkg}
                        onClick={() => void startTopupOrder()}
                        className="w-full rounded-lg bg-claude-accent py-1.5 text-xs font-semibold text-claude-accentInk"
                      >
                        {ct('Generate Payment QR', '生成支付二维码')}
                      </button>
                    </div>
                  )}
                  {topupPhase === 'paying' && topupQrUrl && (
                    <div className="flex flex-col items-center gap-1.5 py-1">
                      <img src={topupQrUrl} alt="ME Topup QR" className="h-36 w-36 rounded-lg border" />
                      <span className="text-[11px] text-claude-textSecondary">
                        {ct('Waiting for payment confirmation…', '等待扫码到账确认…')}
                      </span>
                    </div>
                  )}
                  {topupError && <div className="text-[11px] text-red-500">{topupError}</div>}
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {ct(
              'Single-tap mandate valid for 5 minutes and strictly capped to the asset, lot count, and ceiling above.',
              '本次单点授权令牌 5 分钟内有效，严格绑定上述代币 ID、批次数量与金额上限，超时或关闭自动拒绝。',
            )}
          </p>

          {errorText && <div className="text-[11px] text-red-500">{errorText}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void respond(false)}
              className="rounded-xl border border-claude-border px-3.5 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-black/5 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary"
            >
              {ct('Deny', '拒绝')}
            </button>
            <button
              type="button"
              disabled={submitting || !canConfirm}
              onClick={() => void respond(true)}
              className="rounded-xl bg-claude-accent px-4 py-1.5 text-xs font-semibold text-claude-accentInk shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {submitting
                ? ct('Approving…', '授权中…')
                : ct('Approve Mandate', '确认单次授权')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FtMandateConfirmModal;
