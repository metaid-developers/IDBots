import React, { useState } from 'react';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DocumentTextIcon,
  ShoppingBagIcon,
} from '@heroicons/react/24/outline';
import {
  formatFtAssetBadge,
  type FtFillCardData,
  type FtFillNextAction,
} from './ftCardSyntax';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtFillCardProps {
  data: FtFillCardData;
}

const FtFillCard: React.FC<FtFillCardProps> = ({ data }) => {
  const [showTxids, setShowTxids] = useState(false);
  const isBuy = data.side === 'buy';

  const handleNextAction = (action: FtFillNextAction) => {
    if (typeof window === 'undefined') return;
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
    window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text } }));
  };

  return (
    <div
      data-ft-card="fill"
      data-ft-side={data.side}
      className="my-2.5 w-full max-w-xl overflow-hidden rounded-2xl border border-emerald-500/35 bg-claude-surface shadow-sm dark:border-emerald-400/30 dark:bg-claude-darkSurface"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <CheckCircleIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-bold text-claude-text dark:text-claude-darkText">
            {isBuy
              ? ct(`Bought $${data.symbol}`, `已买入 $${data.symbol}`)
              : ct(`Sold $${data.symbol}`, `已售出 $${data.symbol}`)}
          </span>
          {data.assetKey && data.caVerified !== true && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
              {formatFtAssetBadge(data.assetKey)}
            </span>
          )}
        </div>
        <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
          {data.filledOrderCount} {ct('lot(s) settled', '笔已交割')}
        </span>
      </div>

      <div className="space-y-3 p-4 text-xs">
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-claude-border/70 bg-black/[0.015] p-3 dark:border-claude-darkBorder/70 dark:bg-white/[0.015]">
          <div>
            <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {isBuy ? ct('Total Received', '合计到手数量') : ct('Total Delivered', '合计发出数量')}
            </div>
            <div className="mt-0.5 font-mono text-base font-bold text-emerald-600 dark:text-emerald-400">
              {isBuy ? '+' : '-'}
              {data.totalTokenDisplay} {data.symbol}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {isBuy ? ct('Total Spent', '合计支出') : ct('Net Proceeds', '净入账')}
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-claude-text dark:text-claude-darkText">
              {data.totalPaidLabel}
            </div>
            {data.avgUnitPriceLabel && (
              <div className="mt-0.5 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {ct('Avg', '均价')}: {data.avgUnitPriceLabel}
              </div>
            )}
          </div>
        </div>

        {data.txids.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowTxids((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-claude-textSecondary hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:text-claude-darkText"
            >
              {showTxids ? (
                <ChevronUpIcon className="h-3.5 w-3.5" />
              ) : (
                <ChevronDownIcon className="h-3.5 w-3.5" />
              )}
              {ct(`On-chain Receipts (${data.txids.length})`, `链上交割哈希 (${data.txids.length})`)}
            </button>
            {showTxids && (
              <ul className="mt-1.5 space-y-1 rounded-lg bg-black/[0.03] p-2 font-mono text-[10px] text-claude-textSecondary dark:bg-white/[0.03] dark:text-claude-darkTextSecondary">
                {data.txids.map((txid) => (
                  <li key={txid} className="truncate">
                    {txid}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {data.nextActions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-claude-border/60 pt-2.5 dark:border-claude-darkBorder/60">
            {data.nextActions.includes('browse_token_goods') && (
              <button
                type="button"
                onClick={() => handleNextAction('browse_token_goods')}
                className="inline-flex items-center gap-1.5 rounded-xl border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-text transition hover:border-claude-accent hover:text-claude-accent dark:border-claude-darkBorder dark:text-claude-darkText"
              >
                <ShoppingBagIcon className="h-3.5 w-3.5" />
                {ct(`Shop with $${data.symbol}`, `用 $${data.symbol} 逛数字好物`)}
              </button>
            )}
            {data.nextActions.includes('browse_paybuzz') && (
              <button
                type="button"
                onClick={() => handleNextAction('browse_paybuzz')}
                className="inline-flex items-center gap-1.5 rounded-xl border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-text transition hover:border-claude-accent hover:text-claude-accent dark:border-claude-darkBorder dark:text-claude-darkText"
              >
                <DocumentTextIcon className="h-3.5 w-3.5" />
                {ct(`Unlock PayBuzz Articles`, `解锁链上付费文章`)}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default FtFillCard;
