import React, { useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import {
  formatFtRailLabel,
  inferFtChainAndStandard,
  type FtFillCardData,
  type FtFillNextAction,
} from './ftCardSyntax';
import {
  ChainStandardBadge,
  CopyShortHashButton,
  dispatchSuiteComposerDraft,
  RailVenueBadge,
  TK_CARD_SHELL,
  TK_CHIP_BTN,
  TK_INSET_BOX,
  VerifyOrIdBadge,
} from './tokenSuiteUi';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtFillCardProps {
  data: FtFillCardData;
}

/**
 * FtFillCard (Approved F2 — Dual-Flow Asset Receipt):
 * Left outflow box ──▶ Right inflow box clearly shows what asset left and what
 * asset arrived (plus chain/standard provenance), followed by collapsible TxIDs.
 */
const FtFillCard: React.FC<FtFillCardProps> = ({ data }) => {
  const [showTxids, setShowTxids] = useState(false);
  const isBuy = data.side === 'buy';
  const txids = data.txids ?? [];
  const nextActions = data.nextActions ?? [];
  const { chain, standard } = inferFtChainAndStandard(
    data.assetKey,
    data.chain,
    data.standard,
    data.rail,
  );

  const handleNextAction = (action: FtFillNextAction) => {
    const text =
      action === 'browse_token_goods'
        ? ct(
            `Show digital goods and MRC-721 items that accept $${data.symbol}${data.assetKey ? ` (${data.assetKey})` : ''}.`,
            `帮我看看有哪些支持用 $${data.symbol}${data.assetKey ? `（${data.assetKey}）` : ''} 直接购买的数字商品。`,
          )
        : ct(
            `Find PayBuzz encrypted articles that can be unlocked with $${data.symbol}${data.assetKey ? ` (${data.assetKey})` : ''}.`,
            `帮我检索可用 $${data.symbol}${data.assetKey ? `（${data.assetKey}）` : ''} 解锁阅读的付费专栏文章。`,
          );
    dispatchSuiteComposerDraft(text);
  };

  const outflowAmount = isBuy
    ? data.totalPaidLabel.startsWith('-')
      ? data.totalPaidLabel
      : `-${data.totalPaidLabel}`
    : `-${data.totalTokenDisplay} ${data.symbol}`;

  const inflowAmount = isBuy
    ? `+${data.totalTokenDisplay} ${data.symbol}`
    : data.totalPaidLabel.startsWith('+')
      ? data.totalPaidLabel
      : `+${data.totalPaidLabel}`;

  return (
    <div
      data-ft-card="fill"
      data-ft-side={data.side}
      className={TK_CARD_SHELL}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] bg-[#0f9d68]/[0.12] text-[15px] font-extrabold text-[#0f9d68] dark:bg-[#34d399]/[0.15] dark:text-[#34d399]">
            ✓
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[14.5px] font-bold tracking-[-0.02em]">
                {isBuy
                  ? ct(`Bought $${data.symbol}`, `已买入 $${data.symbol}`)
                  : ct(`Sold $${data.symbol}`, `已售出 $${data.symbol}`)}
              </span>
              {data.assetKey && (
                <VerifyOrIdBadge caVerified={data.caVerified} assetKey={data.assetKey} />
              )}
            </div>
            <div className="mt-[2px] flex flex-wrap items-center gap-1.5 text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
              {data.rail ? (
                <RailVenueBadge rail={data.rail} compact />
              ) : (
                <ChainStandardBadge chain={chain} standard={standard} compact />
              )}
              {data.counterpartyName ? <span>· {data.counterpartyName}</span> : null}
            </div>
          </div>
        </div>

        <span className="shrink-0 rounded-full bg-[#0f9d68]/[0.12] px-2.5 py-0.5 text-[10.5px] font-semibold text-[#0f9d68] dark:bg-[#34d399]/[0.14] dark:text-[#34d399]">
          {data.filledOrderCount} {ct('lot(s) settled', '笔已交割')}
        </span>
      </div>

      {/* F2 Left Outflow ──▶ Right Inflow Dual Boxes */}
      <div className="mt-[10px] grid grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)] items-center gap-[5px] [font-variant-numeric:tabular-nums]">
        <div className="min-w-0 rounded-[11px] border border-slate-900/[0.06] bg-[#f2f4f7] px-[10px] py-[9px] dark:border-white/[0.07] dark:bg-white/[0.045]">
          <div className="text-[10px] font-semibold text-[#8a94a6] dark:text-[#6f7887]">
            {isBuy ? ct('Paid Out', '付出资产') : ct('Delivered', '发出代币')}
          </div>
          <div className="mt-[3px] truncate font-mono text-[13.5px] font-extrabold tracking-[-0.02em] text-[#1f2329] dark:text-[#f4f5f8]">
            {outflowAmount}
          </div>
          <div className="mt-[3px] truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
            {isBuy
              ? data.feeLabel ||
                (data.rail
                  ? ct(formatFtRailLabel(data.rail, 'en'), formatFtRailLabel(data.rail, 'zh'))
                  : ct('Settled', '已结算'))
              : <ChainStandardBadge chain={chain} standard={standard} compact />}
          </div>
        </div>

        <div className="grid h-[22px] w-[22px] place-items-center rounded-full border border-slate-900/[0.09] bg-[#f2f4f7] text-[11px] font-bold text-[#5b6472] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#9aa3b2]">
          →
        </div>

        <div className="min-w-0 rounded-[11px] border border-[#0f9d68]/30 bg-[#0f9d68]/[0.06] px-[10px] py-[9px] dark:border-[#34d399]/30 dark:bg-[#34d399]/[0.07]">
          <div className="text-[10px] font-semibold text-[#0f9d68] dark:text-[#34d399]">
            {isBuy ? ct('Received', '收到代币') : ct('Net Proceeds', '净入账')}
          </div>
          <div className="mt-[3px] truncate font-mono text-[13.5px] font-extrabold tracking-[-0.02em] text-[#0f9d68] dark:text-[#34d399]">
            {inflowAmount}
          </div>
          <div className="mt-[3px] truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
            {isBuy ? (
              <ChainStandardBadge chain={chain} standard={standard} compact />
            ) : (
              data.avgUnitPriceLabel || ct('Wallet credited', '已入账钱包')
            )}
          </div>
        </div>
      </div>

      {/* Avg Price + On-chain TxID Inset */}
      {(data.avgUnitPriceLabel || txids.length > 0) && (
        <div
          className={`mt-[8px] divide-y divide-slate-900/[0.06] dark:divide-white/[0.06] ${TK_INSET_BOX} [font-variant-numeric:tabular-nums]`}
        >
          {data.avgUnitPriceLabel && (
            <div
              className={`flex items-center justify-between gap-2 text-[11.5px] ${
                txids.length > 0 ? 'pb-[5px]' : ''
              }`}
            >
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Avg Unit Price', '成交均价')}
              </span>
              <span className="font-mono font-semibold text-[#1f2329] dark:text-[#f4f5f8]">
                {data.avgUnitPriceLabel}
              </span>
            </div>
          )}

          {txids.length > 0 && (
            <div className={data.avgUnitPriceLabel ? 'pt-[5px]' : ''}>
              <div className="flex items-center justify-between gap-2 text-[11.5px]">
                <button
                  type="button"
                  onClick={() => setShowTxids((v) => !v)}
                  className="inline-flex items-center gap-1 text-[#5b6472] hover:text-[#1f2329] dark:text-[#9aa3b2] dark:hover:text-[#f4f5f8]"
                >
                  {showTxids ? (
                    <ChevronUpIcon className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {ct(
                      `On-chain TxID (${txids.length})`,
                      `链上交割哈希 (${txids.length})`,
                    )}
                  </span>
                </button>
                <CopyShortHashButton value={txids[0]} />
              </div>

              {showTxids && (
                <ul className="mt-1.5 space-y-1 border-t border-slate-900/[0.06] pt-1.5 font-mono text-[10px] text-[#5b6472] dark:border-white/[0.06] dark:text-[#9aa3b2]">
                  {txids.map((txid) => (
                    <li key={txid} className="truncate">
                      {txid}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Next Actions */}
      {nextActions.length > 0 && (
        <div className="mt-[9px] flex flex-wrap items-center gap-[6px]">
          {nextActions.includes('browse_token_goods') && (
            <button
              type="button"
              onClick={() => handleNextAction('browse_token_goods')}
              className={TK_CHIP_BTN}
            >
              {ct(`Shop with $${data.symbol}`, `用 $${data.symbol} 逛数字好物`)}
            </button>
          )}
          {nextActions.includes('browse_paybuzz') && (
            <button
              type="button"
              onClick={() => handleNextAction('browse_paybuzz')}
              className={TK_CHIP_BTN}
            >
              {ct('Unlock PayBuzz Articles', '解锁链上付费文章')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default FtFillCard;
