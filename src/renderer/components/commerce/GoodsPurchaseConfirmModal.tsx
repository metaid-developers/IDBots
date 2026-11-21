import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { MeTopupPackageInfo } from '../../types/electron';
import { ct, formatCnyDisplay, formatMeDisplay } from './commerceTradeI18n';
import { buildMeOrderIdempotencyKey, normalizeMePaymentCheckout } from '../me/mePayment';

export interface GoodsPurchaseConfirmTarget {
  itemPinId: string;
  itemName?: string;
  series?: string;
  collectionPinId?: string;
  priceMeMilli: number;
  priceCnyCents?: number;
  paymentAssetKey?: string;
  selectedToken?: {
    assetKey: string;
    chain?: 'btc' | 'mvc';
    symbol: string;
    amountDisplay: string;
    amountBase?: string;
    sellerReceiveAddress?: string;
  };
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  sellerName?: string;
  shopMetaAppPinId?: string;
}

export interface GoodsPurchaseConfirmModalProps {
  open: boolean;
  target: GoodsPurchaseConfirmTarget | null;
  onClose: () => void;
  onOrderSubmitted?: (result: {
    orderId: string;
    itemPinId: string;
    status: string;
    amountMilli: number;
    sellerAddress?: string;
    deliveryTxId?: string;
  }) => void;
  // Optional overrides for deterministic testing
  initialTradeSpendableMilli?: number;
}

type TopupPhase = 'idle' | 'picking' | 'creating' | 'paying' | 'credited';

const POLL_INTERVAL_MS = 4_000;

const GoodsPurchaseConfirmModal: React.FC<GoodsPurchaseConfirmModalProps> = ({
  open,
  target,
  onClose,
  onOrderSubmitted,
  initialTradeSpendableMilli,
}) => {
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [tradeSpendableMilli, setTradeSpendableMilli] = useState<number>(initialTradeSpendableMilli ?? 0);
  const [weeklyRemainingMilli, setWeeklyRemainingMilli] = useState<number>(0);
  const [buyerMetabotId, setBuyerMetabotId] = useState<number | undefined>(undefined);
  const [balanceError, setBalanceError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Inline top-up state when tradeSpendableMilli < requiredMilli
  const [topupPhase, setTopupPhase] = useState<TopupPhase>('idle');
  const [packages, setPackages] = useState<MeTopupPackageInfo[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState('');
  const [gateway, setGateway] = useState<'alipay' | 'paypal'>('alipay');
  const [topupQrUrl, setTopupQrUrl] = useState('');
  const [topupOrderId, setTopupOrderId] = useState('');
  const [topupError, setTopupError] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electron?.goodsTrade?.getBuyerBalance) return;
    setLoadingBalance(true);
    setBalanceError('');
    try {
      const res = await window.electron.goodsTrade.getBuyerBalance({});
      if (res.success && res.balance) {
        setTradeSpendableMilli(res.balance.tradeSpendableMilli);
        setWeeklyRemainingMilli(res.balance.weeklyRemainingMilli);
        setBuyerMetabotId(res.metabotId);
      } else {
        // Fallback to identity mePoints balance
        const fallback = await window.electron.mePoints?.getBalance?.({ forceRefresh: true });
        if (fallback?.success && fallback.balance) {
          const b = fallback.balance;
          const persistent = Math.max(
            0,
            (b.persistent?.earnedMilli ?? 0) + (b.persistent?.topupMilli ?? 0) - (b.frozenMilli ?? 0),
          );
          setTradeSpendableMilli(b.tradeSpendableMilli ?? persistent);
          setWeeklyRemainingMilli(b.weeklyGrant?.remainingMilli ?? 0);
        } else {
          setBalanceError(res.error || fallback?.error || ct('Failed to load ME balance', '加载 ME 余额失败'));
        }
      }
    } catch (error) {
      setBalanceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingBalance(false);
    }
  }, []);

  const activePaymentAssetKey = target?.paymentAssetKey || target?.selectedToken?.assetKey || '';
  const isTokenMode = Boolean(activePaymentAssetKey);
  const selectedToken = target?.selectedToken ?? (activePaymentAssetKey
    ? {
        assetKey: activePaymentAssetKey,
        chain: activePaymentAssetKey.startsWith('mrc20:') ? 'btc' : 'mvc',
        symbol: 'TOKEN',
        amountDisplay: '',
      }
    : null);

  useEffect(() => {
    if (!open || !target) return;
    setSubmitError('');
    setTopupError('');
    setTopupPhase('idle');
    setTopupQrUrl('');
    setTopupOrderId('');
    if (isTokenMode) {
      // Token mode delegates balance verification & settlement to goods_buy_with_token
      return;
    }
    if (initialTradeSpendableMilli === undefined) {
      void refreshBalance();
    } else {
      setTradeSpendableMilli(initialTradeSpendableMilli);
    }
    return () => {
      stopPolling();
    };
  }, [open, target, isTokenMode, initialTradeSpendableMilli, refreshBalance, stopPolling]);

  const requiredMilli = target?.priceMeMilli ?? 0;
  const shortfallMilli = Math.max(0, requiredMilli - tradeSpendableMilli);
  const hasSufficientBalance = requiredMilli > 0 && tradeSpendableMilli >= requiredMilli;

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
        setTopupError(res?.error || ct('No top-up packages available right now', '暂无可用充值包'));
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
        setTopupError(ct('Payment QR unavailable for this gateway', '当前支付通道未返回二维码'));
        setTopupPhase('picking');
        return;
      }
      setTopupOrderId(checkout.orderId);
      const qrPayload = checkout.qrCode || checkout.approvalUrl || '';
      const dataUrl = await QRCode.toDataURL(qrPayload, { width: 180, margin: 1 });
      setTopupQrUrl(dataUrl);
      setTopupPhase('paying');

      stopPolling();
      pollTimerRef.current = setInterval(async () => {
        try {
          const ordersRes = await window.electron?.mePoints?.getTopupOrders?.();
          const matched = ordersRes?.orders?.find((o) => o.orderId === checkout.orderId);
          const status = String(matched?.status ?? '').toLowerCase();
          if (status === 'confirmed' || status === 'credited' || status === 'paid' || status === 'success') {
            stopPolling();
            setTopupPhase('credited');
            await refreshBalance();
          }
        } catch {
          // Retry on next 4s tick
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setTopupError(err instanceof Error ? err.message : String(err));
      setTopupPhase('picking');
    }
  }, [selectedPackageId, gateway, stopPolling, refreshBalance]);

  const handleConfirmBuy = useCallback(async () => {
    if (!target || submitting) return;
    if (isTokenMode && activePaymentAssetKey) {
      const amountText = selectedToken?.amountDisplay?.trim();
      const maxTokenArg = amountText || '0';
      const symbolLabel = selectedToken?.symbol ? `$${selectedToken.symbol}` : activePaymentAssetKey;
      const sellerRef = target.sellerAddress || target.sellerGlobalMetaId || '';
      const draft = ct(
        `Buy digital item ${target.itemPinId} with token using goods_buy_with_token (asset_key=${activePaymentAssetKey}${amountText ? `, max_token_amount=${maxTokenArg}` : ''}${sellerRef ? `, seller=${sellerRef}` : ''}). Payment token: ${amountText ? `${amountText} ` : ''}${symbolLabel}.`,
        `请调用 goods_buy_with_token 使用代币购买数字商品 ${target.itemPinId}（asset_key=${activePaymentAssetKey}${amountText ? `，max_token_amount=${maxTokenArg}` : ''}${sellerRef ? `，卖家=${sellerRef}` : ''}），支付 ${amountText ? `${amountText} ` : ''}${symbolLabel}。`,
      );
      window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
      onClose();
      return;
    }
    if (!hasSufficientBalance) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      if (window.electron?.goodsTrade?.buyWithMe) {
        const res = await window.electron.goodsTrade.buyWithMe({
          metabotId: buyerMetabotId,
          itemPinId: target.itemPinId,
          amountMilli: target.priceMeMilli,
          ...(target.sellerAddress ? { sellerAddress: target.sellerAddress } : {}),
          sellerGlobalMetaId: target.sellerGlobalMetaId,
          ...(target.collectionPinId ? { collectionPinId: target.collectionPinId } : {}),
        });
        if (!res.success || !res.order) {
          setSubmitError(res.error || ct('Purchase failed', '下单失败'));
          return;
        }
        onOrderSubmitted?.(res.order);
        onClose();
      } else {
        // Fallback: draft into cowork chat
        const sellerRef = target.sellerAddress || target.sellerGlobalMetaId || '';
        const draft = ct(
          `Buy item ${target.itemPinId} using goods_buy_with_me for ${formatMeDisplay(target.priceMeMilli)}${sellerRef ? ` from seller ${sellerRef}` : ''}.`,
          `请调用 goods_buy_with_me 购买商品 ${target.itemPinId}，金额 ${formatMeDisplay(target.priceMeMilli)}${sellerRef ? `，卖家 ${sellerRef}` : ''}。`,
        );
        window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
        onClose();
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [target, isTokenMode, activePaymentAssetKey, selectedToken, hasSufficientBalance, submitting, buyerMetabotId, onOrderSubmitted, onClose]);

  const selectedPkg = useMemo(
    () => packages.find((p) => p.packageId === selectedPackageId) ?? null,
    [packages, selectedPackageId],
  );

  if (!open || !target) return null;

  return (
    <div
      data-commerce-modal="goods-purchase-confirm"
      data-payment-asset-key={activePaymentAssetKey || undefined}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={isTokenMode ? ct('Confirm Token Purchase', '确认代币购买') : ct('Confirm ME Escrow Purchase', '确认 ME 担保购买')}
      onClick={onClose}
    >
      <div
        className="w-[min(94vw,440px)] overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-2xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-claude-border px-4 py-3 dark:border-claude-darkBorder">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="h-5 w-5 text-claude-accent" />
            <h3 className="text-sm font-semibold text-claude-text dark:text-claude-darkText">
              {isTokenMode ? ct('Confirm Token Purchase', '确认代币购买') : ct('Confirm ME Escrow Purchase', '确认 ME 担保购买')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={ct('Close', '关闭')}
            className="rounded-lg p-1 text-claude-textSecondary hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4 text-xs">
          <div className="rounded-xl border border-claude-border/80 bg-black/[0.02] p-3 dark:border-claude-darkBorder/80 dark:bg-white/[0.02]">
            <div className="text-sm font-semibold text-claude-text dark:text-claude-darkText">
              {target.itemName || ct('Digital Item', '数字商品')}
            </div>
            {target.series && (
              <div className="mt-0.5 text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {target.series}
              </div>
            )}
            <div className="mt-2 flex items-center justify-between border-t border-claude-border/60 pt-2 dark:border-claude-darkBorder/60">
              <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {isTokenMode ? ct('Token Price', '代币价格') : ct('Escrow Price', '担保交易价格')}
              </span>
              {isTokenMode && selectedToken ? (
                <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                  {selectedToken.amountDisplay
                    ? `${selectedToken.amountDisplay} $${selectedToken.symbol}`
                    : `$${selectedToken.symbol}`}
                </span>
              ) : (
                <span className="text-sm font-semibold text-claude-accent">
                  {formatMeDisplay(requiredMilli)}
                  {target.priceCnyCents != null && target.priceCnyCents > 0 && (
                    <span className="ml-1.5 text-xs font-normal text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      ({formatCnyDisplay(target.priceCnyCents)})
                    </span>
                  )}
                </span>
              )}
            </div>
            {isTokenMode && (
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                <span>{ct('Asset ID', '资产标识')}</span>
                <span className="truncate font-mono" data-token-asset-key={activePaymentAssetKey}>
                  {activePaymentAssetKey}
                </span>
              </div>
            )}
            <div className="mt-1 flex items-center justify-between text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              <span>{ct('Seller', '卖方')}</span>
              <span className="truncate font-mono">
                {target.sellerName ? `${target.sellerName} · ` : ''}
                {target.sellerAddress
                  ? `${target.sellerAddress.slice(0, 8)}…${target.sellerAddress.slice(-6)}`
                  : (target.sellerGlobalMetaId || ct('Verified on-chain owner', '链上实时持有人'))}
              </span>
            </div>
          </div>

          {isTokenMode ? (
            <div
              data-token-settlement-info="true"
              className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-800 dark:text-emerald-300"
            >
              <div className="font-semibold">
                {selectedToken?.chain === 'mvc'
                  ? ct('Same-Chain Atomic Swap (MVC FT <-> MRC-721)', '同链单笔原子互换（一手交币一手交货）')
                  : ct('5-Min Exclusive Lock + Verified Auto-Delivery', '5 分钟排他锁 + 链上验资自动发货')}
              </div>
              <div className="mt-1 text-[11px] opacity-90">
                {ct(
                  'Your TwinBot will verify exact asset identity and seller online lock before asking for your final signing confirmation.',
                  '你的 TwinBot 将核对完整资产标识与卖家在线锁单后再执行转账，付款前仍有最终确认。',
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-claude-border/80 p-3 dark:border-claude-darkBorder/80">
            <div className="flex items-center justify-between">
              <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {ct('Trade-Eligible ME Balance', '可用于商品交易的持久化 ME')}
              </span>
              <span className="font-semibold text-claude-text dark:text-claude-darkText">
                {loadingBalance ? ct('Checking…', '查询中…') : formatMeDisplay(tradeSpendableMilli)}
              </span>
            </div>
            {weeklyRemainingMilli > 0 && (
              <div className="mt-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {ct(
                  `Note: weekly allowance (${formatMeDisplay(weeklyRemainingMilli)}) cannot be spent on digital goods escrow.`,
                  `提示：每周赠送额度（${formatMeDisplay(weeklyRemainingMilli)}）不可用于数字商品担保购买。`,
                )}
              </div>
            )}
            {balanceError && (
              <div className="mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">{balanceError}</div>
            )}
            </div>
          )}

          {!isTokenMode && !loadingBalance && !hasSufficientBalance && (
            <div
              data-insufficient-me="true"
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300"
            >
              <div className="flex items-start gap-2">
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="flex-1">
                  <div className="font-semibold">
                    {ct(
                      `Insufficient persistent ME (short by ${formatMeDisplay(shortfallMilli)})`,
                      `持久化 ME 余额不足（还差 ${formatMeDisplay(shortfallMilli)}）`,
                    )}
                  </div>
                  {topupPhase === 'idle' && (
                    <button
                      type="button"
                      data-action="open-inline-topup"
                      onClick={openInlineTopup}
                      className="mt-2 rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700"
                    >
                      {ct('Top Up ME & Continue', '立即充值 ME 并继续')}
                    </button>
                  )}
                </div>
              </div>

              {topupPhase === 'picking' && (
                <div className="mt-3 space-y-2 border-t border-amber-500/30 pt-2.5">
                  <div className="grid grid-cols-2 gap-1.5">
                    {packages.map((pkg) => (
                      <button
                        key={pkg.packageId}
                        type="button"
                        onClick={() => setSelectedPackageId(pkg.packageId)}
                        className={`rounded-lg border px-2 py-1.5 text-left text-[11px] ${
                          selectedPackageId === pkg.packageId
                            ? 'border-claude-accent bg-claude-accent/15 text-claude-text dark:text-claude-darkText'
                            : 'border-claude-border bg-white/70 dark:border-claude-darkBorder dark:bg-black/20'
                        }`}
                      >
                        <div className="font-semibold">{formatMeDisplay(pkg.meMilli)}</div>
                        <div className="opacity-80">¥{pkg.priceCny ?? '—'}</div>
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={gateway}
                      onChange={(e) => setGateway(e.target.value as 'alipay' | 'paypal')}
                      className="rounded-lg border border-claude-border bg-claude-surface px-2 py-1 text-xs dark:border-claude-darkBorder dark:bg-claude-darkSurface"
                    >
                      <option value="alipay">{ct('Alipay', '支付宝')}</option>
                      <option value="paypal">PayPal</option>
                    </select>
                    <button
                      type="button"
                      disabled={!selectedPkg}
                      onClick={startTopupOrder}
                      className="flex-1 rounded-lg bg-claude-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {ct('Generate Payment QR', '生成充值二维码')}
                    </button>
                  </div>
                </div>
              )}

              {topupPhase === 'creating' && (
                <div className="mt-2 flex items-center gap-1.5 text-xs">
                  <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                  {ct('Creating top-up order…', '正在创建充值订单…')}
                </div>
              )}

              {topupPhase === 'paying' && topupQrUrl && (
                <div className="mt-3 flex flex-col items-center gap-2 rounded-lg bg-white p-3 text-slate-800">
                  <img src={topupQrUrl} alt="ME Topup QR" className="h-36 w-36" />
                  <div className="text-[11px] font-medium">
                    {ct(
                      `Scan to pay · checking status every 4s (${topupOrderId})`,
                      `请扫码支付 · 每 4 秒自动刷新到账状态（${topupOrderId}）`,
                    )}
                  </div>
                </div>
              )}

              {topupPhase === 'credited' && (
                <div className="mt-2 flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <CheckCircleIcon className="h-4 w-4" />
                  {ct('Top-up credited! Balance refreshed.', '充值已到账！余额已刷新。')}
                </div>
              )}

              {topupError && (
                <div className="mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">{topupError}</div>
              )}
            </div>
          )}

          {submitError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-600 dark:text-rose-400">
              {submitError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary hover:bg-black/5 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
            >
              {ct('Cancel', '取消')}
            </button>
            <button
              type="button"
              data-action={isTokenMode ? 'confirm-token-buy' : 'confirm-me-buy'}
              disabled={!isTokenMode && (!hasSufficientBalance || submitting || loadingBalance)}
              onClick={handleConfirmBuy}
              className="rounded-lg bg-claude-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isTokenMode
                ? ct('Start Token Purchase', '开始代币购买')
                : (submitting
                    ? ct('Locking Escrow…', '正在锁定担保…')
                    : ct('Confirm ME Escrow Buy', '确认 ME 担保购买'))}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GoodsPurchaseConfirmModal;
