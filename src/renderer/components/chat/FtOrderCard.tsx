import React, { useCallback, useEffect, useState } from 'react';
import {
  inferFtChainAndStandard,
  type FtOrderCardData,
} from './ftCardSyntax';
import {
  ChainStandardBadge,
  RailVenueBadge,
  SuiteTokenAvatar,
  TK_CARD_SHELL,
  TK_INSET_BOX,
  VerifyOrIdBadge,
} from './tokenSuiteUi';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtOrderCardProps {
  data: FtOrderCardData;
}

/**
 * FtOrderCard (Approved L2 — Compact Vertical Ledger, clean buttonless footer):
 * Single-column left-right ledger rows prevent long decimal amounts and prices
 * from colliding, while surfacing chain/standard badges and live fill progress.
 */
const FtOrderCard: React.FC<FtOrderCardProps> = ({ data }) => {
  const [filledLots, setFilledLots] = useState<number>(data.filledLots);
  const [totalLots, setTotalLots] = useState<number>(data.totalLots);
  const [canceledLots, setCanceledLots] = useState<number>(0);

  const { chain, standard } = inferFtChainAndStandard(
    data.assetKey,
    data.chain,
    data.standard,
    data.rail,
  );

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

  return (
    <div
      data-ft-card="order"
      data-batch-group-id={data.batchGroupId}
      className={TK_CARD_SHELL}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <SuiteTokenAvatar symbol={data.symbol} chain={chain} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[14.5px] font-bold tracking-[-0.02em]">
                ${data.symbol}
              </span>
              <ChainStandardBadge chain={chain} standard={standard} compact />
            </div>
            <div className="mt-[3px] flex flex-wrap items-center gap-1.5">
              <VerifyOrIdBadge caVerified={data.caVerified} assetKey={data.assetKey} />
              <span className="text-[10.5px] text-[#8a94a6] dark:text-[#6f7887]">
                {ct('Listing Seat', '挂牌席位')}
              </span>
            </div>
          </div>
        </div>

        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
            remainingActiveLots > 0
              ? 'bg-[#0f9d68]/[0.11] text-[#0f9d68] dark:bg-[#34d399]/[0.13] dark:text-[#34d399]'
              : 'bg-[#e8ecf2] text-[#5b6472] dark:bg-white/[0.08] dark:text-[#9aa3b2]'
          }`}
        >
          {remainingActiveLots > 0 && (
            <span className="h-[6px] w-[6px] rounded-full bg-[#0f9d68] dark:bg-[#34d399]" />
          )}
          {remainingActiveLots > 0 ? ct('Active', '在售中') : ct('Closed', '已结单')}
        </span>
      </div>

      {/* L2 Vertical Single-Column Ledger */}
      <div
        className={`mt-[10px] divide-y divide-slate-900/[0.06] dark:divide-white/[0.06] ${TK_INSET_BOX} [font-variant-numeric:tabular-nums]`}
      >
        <div className="flex items-center justify-between gap-2 pb-[6px] text-[12px]">
          <span className="shrink-0 text-[#5b6472] dark:text-[#9aa3b2]">
            {ct('Trade Venue', '交易方式')}
          </span>
          <RailVenueBadge rail={data.rail} autoFulfill={data.autoFulfill} />
        </div>

        <div className="flex items-center justify-between gap-2 py-[6px] text-[12px]">
          <span className="shrink-0 text-[#5b6472] dark:text-[#9aa3b2]">
            {ct('Unit Quote', '挂牌单价')}
          </span>
          <span className="min-w-0 truncate text-right font-mono text-[12.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
            {data.unitPriceLabel}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 pt-[6px] text-[12px]">
          <span className="shrink-0 text-[#5b6472] dark:text-[#9aa3b2]">
            {ct('Lot Granularity', '分包规格')}
          </span>
          <span className="min-w-0 truncate text-right font-mono text-[12px] font-semibold text-[#1f2329] dark:text-[#f4f5f8]">
            {data.lotAmountDisplay} {data.symbol} × {totalLots}
          </span>
        </div>

        {data.totalValueLabel && (
          <div className="mt-[6px] flex items-center justify-between gap-2 pt-[6px] text-[12px]">
            <span className="shrink-0 text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Total Value', '挂牌总额')}
            </span>
            <span className="min-w-0 truncate text-right font-mono text-[12.5px] font-bold text-[#b48a00] dark:text-[#ffdc51]">
              {data.totalValueLabel}
            </span>
          </div>
        )}
      </div>

      {/* Slim Progress Bar */}
      <div className="mt-[10px] [font-variant-numeric:tabular-nums]">
        <div className="mb-[5px] flex items-center justify-between gap-2 text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
          <span>
            {ct('Fill Progress', '已售进度')}{' '}
            <strong className="font-mono font-bold text-[#1f2329] dark:text-[#f4f5f8]">
              {filledLots}/{totalLots}
            </strong>
            {canceledLots > 0 ? ` (${canceledLots} ${ct('canceled', '已撤')})` : ''}
          </span>
          {data.autoFulfill && (
            <span className="truncate text-[10.5px] font-semibold text-[#0f9d68] dark:text-[#34d399]">
              {ct('24/7 AI Auto-Fulfill', '24h AI 自动交割值守')}
            </span>
          )}
        </div>
        <div className="h-[5px] w-full overflow-hidden rounded-full bg-slate-900/[0.08] dark:bg-white/[0.09]">
          <div
            className="h-full rounded-full bg-[#0f9d68] transition-all duration-300 dark:bg-[#34d399]"
            style={{ width: `${fillPercent}%` }}
          />
        </div>
      </div>
    </div>
  );
};

export default FtOrderCard;
