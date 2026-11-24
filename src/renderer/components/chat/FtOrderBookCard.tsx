import React, { useEffect, useState } from 'react';
import {
  inferFtChainAndStandard,
  type FtCardRail,
  type FtOrderBookCardData,
  type FtOrderBookRow,
} from './ftCardSyntax';
import {
  ChainStandardBadge,
  dispatchSuiteComposerDraft,
  SuiteTokenAvatar,
  TK_BTN_PRIMARY,
  TK_CARD_SHELL,
  VerifyOrIdBadge,
} from './tokenSuiteUi';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtOrderBookCardProps {
  data: FtOrderBookCardData;
}

function resolveDefaultTotalUnit(rail?: FtCardRail, chain?: string, explicitUnit?: string): string {
  if (explicitUnit) return explicitUnit;
  if (rail === 'me-escrow') return 'ME';
  if (rail === 'mvc-tokensell' || chain === 'mvc') return 'SPACE';
  return 'BTC';
}

function formatCompactTotalCell(totalPriceLabel: string, headerUnit: string): string {
  const trimmed = totalPriceLabel.trim();
  if (!trimmed || !headerUnit) return trimmed;
  const suffixRe = new RegExp(`\\s+${headerUnit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  return trimmed.replace(suffixRe, '');
}

function buildBuyRowPrompt(data: FtOrderBookCardData, row: FtOrderBookRow, rank: number): string {
  const rail = row.rail || data.rail;
  const orderRefPart = row.orderId ? ` (orderId: ${row.orderId})` : '';
  const railPart = rail ? ` via ${rail}` : '';
  return ct(
    `Buy order #${rank} of $${data.symbol} (${data.assetKey}): ${row.amountDisplay} ${data.symbol} at ${row.unitPricePrimary}, total ${row.totalPriceLabel}${railPart}${orderRefPart}.`,
    `请买入 $${data.symbol}（${data.assetKey}）挂单列表第 #${rank} 单：数量 ${row.amountDisplay} ${data.symbol}，单价 ${row.unitPricePrimary}，整包总价 ${row.totalPriceLabel}${orderRefPart}。`,
  );
}

/**
 * FtOrderBookCard (Approved OB-1 — Compact Order Book Table + Highlighted Floor + Pager):
 * - Shows 6 sorted active orders per page with instant client-side pagination (zero LLM roundtrip)
 * - Gold-highlights #1 lowest-price floor lot
 * - Per-row mini Buy CTA + bottom primary "Buy Lowest Lot" (`一键买最低 1 单`) CTA
 */
const FtOrderBookCard: React.FC<FtOrderBookCardProps> = ({ data }) => {
  const orders = data.orders ?? [];
  const pageSize = Math.max(1, Math.min(10, data.pageSize ?? 6));
  const totalPages = Math.max(1, Math.ceil(orders.length / pageSize));
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (page > totalPages - 1) {
      setPage(Math.max(0, totalPages - 1));
    }
  }, [page, totalPages]);

  const safePage = Math.min(page, totalPages - 1);
  const pageRows = orders.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const startRank = orders.length > 0 ? safePage * pageSize + 1 : 0;
  const endRank = Math.min(orders.length, (safePage + 1) * pageSize);

  const { chain, standard } = inferFtChainAndStandard(
    data.assetKey,
    data.chain,
    data.standard,
    data.rail,
  );
  const totalUnit = resolveDefaultTotalUnit(data.rail, chain, data.totalCurrencyUnit);
  const totalCount = Math.max(orders.length, data.totalOrdersCount ?? orders.length);

  return (
    <div
      data-ft-card="orderbook"
      data-asset-key={data.assetKey}
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
              <VerifyOrIdBadge caVerified={data.caVerified} assetKey={data.assetKey} />
            </div>

            {(data.floorPriceLabel || data.holdersCount !== undefined) && (
              <div className="mt-[3px] flex flex-wrap items-center gap-x-1 text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2] [font-variant-numeric:tabular-nums]">
                {data.floorPriceLabel && (
                  <span>
                    {ct('Floor', '地板')}{' '}
                    <strong className="font-mono font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                      {data.floorPriceLabel}
                    </strong>
                    {data.floorUsdText ? ` (${data.floorUsdText})` : ''}
                  </span>
                )}
                {data.floorPriceLabel && data.holdersCount !== undefined && <span>·</span>}
                {data.holdersCount !== undefined && (
                  <span>
                    {data.holdersCount.toLocaleString('en-US')} {ct('holders', '持有人')}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <span className="shrink-0 rounded-full bg-[#f2f4f7] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[#5b6472] dark:bg-white/[0.06] dark:text-[#9aa3b2] [font-variant-numeric:tabular-nums]">
          {ct(`${totalCount} orders`, `共 ${totalCount} 单`)}
        </span>
      </div>

      {/* OB-1 5-Column Inset Order Book Table */}
      <div className="mt-[10px] rounded-[11px] bg-[#f2f4f7] px-[8px] py-[6px] dark:bg-white/[0.045] [font-variant-numeric:tabular-nums]">
        <div className="grid grid-cols-[22px_58px_minmax(0,1fr)_74px_44px] items-center gap-[4px] border-b border-slate-900/[0.06] px-[4px] pb-[5px] pt-[2px] text-[10px] font-semibold text-[#8a94a6] dark:border-white/[0.06] dark:text-[#6f7887]">
          <span>#</span>
          <span>{ct('Qty', '数量')}</span>
          <span>{ct('Unit', '单价')}</span>
          <span className="text-right">
            {ct(`Total(${totalUnit})`, `总价(${totalUnit})`)}
          </span>
          <span className="text-right">{ct('Act', '操作')}</span>
        </div>

        {pageRows.length === 0 ? (
          <div className="py-5 text-center text-[11.5px] text-[#8a94a6] dark:text-[#6f7887]">
            {ct('No active sell orders right now', '当前暂无在售挂单')}
          </div>
        ) : (
          <div>
            {pageRows.map((row, idx) => {
              const rank = row.rank ?? safePage * pageSize + idx + 1;
              const isBest = rank === 1;
              const isLast = idx === pageRows.length - 1;
              const compactTotal = formatCompactTotalCell(row.totalPriceLabel, totalUnit);

              return (
                <div
                  key={`${row.orderId || 'row'}-${rank}`}
                  data-ft-orderbook-row={rank}
                  data-ft-floor-row={isBest ? 'true' : undefined}
                  className={`grid grid-cols-[22px_58px_minmax(0,1fr)_74px_44px] items-center gap-[4px] rounded-[7px] px-[4px] py-[5.5px] text-[11.5px] ${
                    isBest
                      ? 'my-[2.5px] bg-[#ffdc51]/[0.14] shadow-[inset_0_0_0_1px_rgba(180,138,0,0.38)] dark:bg-[#ffdc51]/[0.08] dark:shadow-[inset_0_0_0_1px_rgba(255,220,81,0.42)]'
                      : isLast
                        ? ''
                        : 'border-b border-slate-900/[0.06] dark:border-white/[0.06]'
                  }`}
                >
                  <span
                    className={`font-mono text-[10.5px] font-bold ${
                      isBest
                        ? 'text-[#b48a00] dark:text-[#ffdc51]'
                        : 'text-[#8a94a6] dark:text-[#6f7887]'
                    }`}
                  >
                    {rank}
                  </span>

                  <span
                    title={row.amountDisplay}
                    className="truncate font-mono font-extrabold text-[#1f2329] dark:text-[#f4f5f8]"
                  >
                    {row.amountDisplay}
                  </span>

                  <div className="min-w-0 font-mono leading-[1.2]">
                    <div
                      title={row.unitPricePrimary}
                      className="truncate text-[11px] font-bold text-[#1f2329] dark:text-[#f4f5f8]"
                    >
                      {row.unitPricePrimary}
                    </div>
                    {row.unitPriceSecondary && (
                      <div
                        title={row.unitPriceSecondary}
                        className="truncate text-[9.5px] text-[#8a94a6] dark:text-[#6f7887]"
                      >
                        {row.unitPriceSecondary}
                      </div>
                    )}
                  </div>

                  <span
                    title={row.totalPriceLabel}
                    className="truncate text-right font-mono text-[11px] font-bold text-[#1f2329] dark:text-[#f4f5f8]"
                  >
                    {compactTotal}
                  </span>

                  <div className="text-right">
                    <button
                      type="button"
                      onClick={() => dispatchSuiteComposerDraft(buildBuyRowPrompt(data, row, rank))}
                      className={`inline-flex items-center justify-center whitespace-nowrap rounded-[6px] border px-[8px] py-[3.5px] text-[10.5px] font-bold transition active:scale-[0.96] ${
                        isBest
                          ? 'border-black/[0.08] bg-[#ffdc51] text-[#24210c] hover:bg-[#ffe474]'
                          : 'border-slate-900/[0.09] bg-white text-[#1f2329] hover:bg-[#e8ecf2] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#f4f5f8] dark:hover:bg-white/[0.1]'
                      }`}
                    >
                      {ct('Buy', '买')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Pager + Buy Lowest CTA */}
      <div className="mt-[9px] flex items-center justify-between gap-[8px] [font-variant-numeric:tabular-nums]">
        <div className="inline-flex shrink-0 items-center gap-[5px] rounded-[9px] bg-[#f2f4f7] px-[5px] py-[3px] dark:bg-white/[0.045]">
          <button
            type="button"
            data-ft-pager="prev"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label={ct('Previous page', '上一页')}
            className="grid h-[24px] w-[24px] place-items-center rounded-[6px] border border-slate-900/[0.09] bg-white text-[12px] font-bold text-[#1f2329] transition hover:bg-[#e8ecf2] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#f4f5f8] dark:hover:bg-white/[0.1]"
          >
            ‹
          </button>
          <span
            data-ft-pager="label"
            className="whitespace-nowrap px-[4px] font-mono text-[11px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]"
          >
            {orders.length > 0
              ? `${safePage + 1}/${totalPages} (${startRank}–${endRank})`
              : '0/0'}
          </span>
          <button
            type="button"
            data-ft-pager="next"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            aria-label={ct('Next page', '下一页')}
            className="grid h-[24px] w-[24px] place-items-center rounded-[6px] border border-slate-900/[0.09] bg-white text-[12px] font-bold text-[#1f2329] transition hover:bg-[#e8ecf2] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#f4f5f8] dark:hover:bg-white/[0.1]"
          >
            ›
          </button>
        </div>

        <button
          type="button"
          disabled={orders.length === 0}
          onClick={() => {
            if (orders[0]) {
              dispatchSuiteComposerDraft(buildBuyRowPrompt(data, orders[0], 1));
            }
          }}
          className={TK_BTN_PRIMARY}
        >
          {ct('Buy Lowest Lot', '一键买最低 1 单')}
        </button>
      </div>
    </div>
  );
};

export default FtOrderBookCard;
