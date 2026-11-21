import React, { useCallback, useEffect, useState } from 'react';
import {
  BoltIcon,
  CheckBadgeIcon,
  ExclamationTriangleIcon,
  MegaphoneIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import {
  formatFtAssetBadge,
  formatFtRailLabel,
  type FtOrderCardData,
} from './ftCardSyntax';
import PromoAmmoPackModal from '../commerce/PromoAmmoPackModal';
import { ct, getCommerceLocale } from '../commerce/commerceTradeI18n';
import type { OpenPromoPackParams } from '../commerce/commerceBridgeContract';

export interface FtOrderCardProps {
  data: FtOrderCardData;
}

const FALLBACK_PROMO_PIN_ID = `${'0'.repeat(64)}i0`;

const FtOrderCard: React.FC<FtOrderCardProps> = ({ data }) => {
  const [filledLots, setFilledLots] = useState<number>(data.filledLots);
  const [totalLots, setTotalLots] = useState<number>(data.totalLots);
  const [canceledLots, setCanceledLots] = useState<number>(0);
  const [canceling, setCanceling] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [promoOpen, setPromoOpen] = useState(false);

  const assetBadge = formatFtAssetBadge(data.assetKey);

  const refreshProgress = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electron?.ftTrade?.getBatchProgress) return;
    try {
      const res = await window.electron.ftTrade.getBatchProgress({
        batchGroupId: data.batchGroupId,
      });
      if (res?.success && res.progress) {
        setFilledLots(res.progress.filledLots);
        setTotalLots(res.progress.totalLots || data.totalLots);
        setCanceledLots(res.progress.canceledLots);
      }
    } catch {
      // Keep snapshot values in static/offline contexts
    }
  }, [data.batchGroupId, data.totalLots]);

  useEffect(() => {
    void refreshProgress();
    if (typeof window === 'undefined' || !window.electron?.ftTrade?.onOrderFilled) return;
    const unsub = window.electron.ftTrade.onOrderFilled((payload) => {
      if (payload?.batchGroupId === data.batchGroupId) {
        if (typeof payload.filledLots === 'number') setFilledLots(payload.filledLots);
        if (typeof payload.totalLots === 'number') setTotalLots(payload.totalLots);
      }
    });
    return () => {
      unsub?.();
    };
  }, [data.batchGroupId, refreshProgress]);

  const remainingActiveLots = Math.max(0, totalLots - filledLots - canceledLots);
  const fillPercent = totalLots > 0 ? Math.min(100, Math.round((filledLots / totalLots) * 100)) : 0;

  const handleCancelAll = async () => {
    if (canceling || remainingActiveLots <= 0) return;
    setCanceling(true);
    setStatusMessage('');
    try {
      if (typeof window !== 'undefined' && window.electron?.ftTrade?.cancelBatchOrders && data.rail !== 'btc-psbt') {
        const res = await window.electron.ftTrade.cancelBatchOrders({
          batchGroupId: data.batchGroupId,
        });
        if (res.progress) {
          setFilledLots(res.progress.filledLots);
          setCanceledLots(res.progress.canceledLots);
        }
        if (res.canceledCount && res.canceledCount > 0) {
          setStatusMessage(
            ct(
              `Canceled ${res.canceledCount} remaining lot(s).`,
              `已撤回剩余 ${res.canceledCount} 份挂单。`,
            ),
          );
          return;
        }
        if (res.errors?.length) {
          setStatusMessage(res.errors[0]);
          return;
        }
      }

      if (typeof window !== 'undefined') {
        const draft = ct(
          `Cancel all remaining active lots in batch ${data.batchGroupId} for $${data.symbol} (${data.assetKey}).`,
          `请撤回批次 ${data.batchGroupId} 中剩余未成交的 $${data.symbol}（${data.assetKey}）挂单。`,
        );
        window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setCanceling(false);
    }
  };

  const promoParams: OpenPromoPackParams = {
    shopOwnerGlobalMetaId: data.sellerGlobalMetaId || 'idq1metaidftbroker000000000000000000',
    shopOwnerName: data.sellerName || `$${data.symbol} AI Desk`,
    shopSlogan: ct(
      `My AI fulfills $${data.symbol} lots 24/7 on-chain (${assetBadge})`,
      `我的 AI 24 小时自动接单交割 $${data.symbol}（${assetBadge}）`,
    ),
    ...(data.shopMetaAppPinId ? { shopMetaAppPinId: data.shopMetaAppPinId } : {}),
    featuredItems: [
      {
        itemPinId:
          data.orderRefs[0] && /^[0-9a-f]{64}i\d+$/i.test(data.orderRefs[0])
            ? data.orderRefs[0]
            : FALLBACK_PROMO_PIN_ID,
        itemName: `${data.lotAmountDisplay} $${data.symbol} · ${data.unitPriceLabel}`,
      },
    ],
  };

  return (
    <>
      <div
        data-ft-card="order"
        data-batch-group-id={data.batchGroupId}
        className="my-2.5 w-full max-w-xl overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-sm dark:border-claude-darkBorder dark:bg-claude-darkSurface"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-claude-border/80 bg-black/[0.02] px-4 py-2.5 dark:border-claude-darkBorder/80 dark:bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-claude-text dark:text-claude-darkText">
              ${data.symbol} {ct('Order Seat', '挂牌席位凭证')}
            </span>
            {data.caVerified ? (
              <span
                data-ft-verified="true"
                className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
              >
                <CheckBadgeIcon className="h-3.5 w-3.5" />
                {ct('Verified', '已认证')}
              </span>
            ) : (
              <span
                data-ft-verified="false"
                title={data.assetKey}
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-amber-700 dark:text-amber-300"
              >
                <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0" />
                {assetBadge}
              </span>
            )}
          </div>
          <span className="rounded-md bg-black/5 px-2 py-0.5 text-[11px] font-medium text-claude-textSecondary dark:bg-white/10 dark:text-claude-darkTextSecondary">
            {formatFtRailLabel(data.rail)}
          </span>
        </div>

        <div className="space-y-3 p-4 text-xs">
          <div className="grid grid-cols-2 gap-2.5 rounded-xl border border-claude-border/70 bg-black/[0.015] p-3 dark:border-claude-darkBorder/70 dark:bg-white/[0.015]">
            <div>
              <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {ct('Lot Granularity', '单份颗粒度')}
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-claude-text dark:text-claude-darkText">
                {data.lotAmountDisplay} {data.symbol} × {totalLots}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {ct('Unit Quote', '挂牌单价')}
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-claude-accent">
                {data.unitPriceLabel}
              </div>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {ct('Fill Progress', '成交进度')}:{' '}
                <strong className="font-mono text-claude-text dark:text-claude-darkText">
                  {filledLots}/{totalLots}
                </strong>
                {canceledLots > 0 ? ` (${canceledLots} ${ct('canceled', '已撤')})` : ''}
              </span>
              {data.autoFulfill && (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <BoltIcon className="h-3.5 w-3.5" />
                  {ct('24/7 AI Auto-Fulfill Active', '24 小时自动验资发货值守中')}
                </span>
              )}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${fillPercent}%` }}
              />
            </div>
          </div>

          {statusMessage && (
            <div className="rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-claude-textSecondary dark:bg-white/10 dark:text-claude-darkTextSecondary">
              {statusMessage}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => setPromoOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-claude-accent px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <MegaphoneIcon className="h-3.5 w-3.5" />
              {ct('Generate Promo Poster', '生成社群推销海报')}
            </button>

            <button
              type="button"
              disabled={canceling || remainingActiveLots <= 0}
              onClick={() => void handleCancelAll()}
              className="inline-flex items-center gap-1 rounded-xl border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary transition hover:border-red-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-45 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary"
            >
              <XCircleIcon className="h-3.5 w-3.5" />
              {canceling
                ? ct('Canceling…', '撤单中…')
                : ct('Cancel All Remaining', '一键全部撤单')}
            </button>
          </div>
        </div>
      </div>

      {promoOpen && (
        <PromoAmmoPackModal
          params={promoParams}
          lang={getCommerceLocale()}
          onClose={() => setPromoOpen(false)}
        />
      )}
    </>
  );
};

export default FtOrderCard;
