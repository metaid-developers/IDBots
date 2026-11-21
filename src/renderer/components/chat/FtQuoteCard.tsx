import React from 'react';
import {
  CheckBadgeIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import {
  formatFtAssetBadge,
  formatFtRailLabel,
  type FtCardRail,
  type FtQuoteCardData,
} from './ftCardSyntax';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtQuoteCardProps {
  data: FtQuoteCardData;
}

const FtQuoteCard: React.FC<FtQuoteCardProps> = ({ data }) => {
  const assetBadge = formatFtAssetBadge(data.assetKey);
  const recommendedQuote =
    data.quotes.find((q) => q.recommended) ?? data.quotes[0];

  const dispatchDraft = (rail: FtCardRail, label: string) => {
    if (typeof window === 'undefined') return;
    const text = ct(
      `Execute the ${data.symbol} (${data.assetKey}) buy plan on ${label} (${rail}).`,
      `请按 ${label}（${rail}）方案执行买入 $${data.symbol}（${data.assetKey}）。`,
    );
    window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text } }));
  };

  return (
    <div
      data-ft-card="quote"
      data-asset-key={data.assetKey}
      className="my-2.5 w-full max-w-xl overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-sm dark:border-claude-darkBorder dark:bg-claude-darkSurface"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-claude-border/80 bg-black/[0.02] px-4 py-2.5 dark:border-claude-darkBorder/80 dark:bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold tracking-tight text-claude-text dark:text-claude-darkText">
            ${data.symbol}
          </span>
          {data.caVerified ? (
            <span
              data-ft-verified="true"
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
            >
              <CheckBadgeIcon className="h-3.5 w-3.5" />
              {ct('Verified Token', '官方认证代币')}
            </span>
          ) : (
            <span
              data-ft-verified="false"
              title={data.assetKey}
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-amber-700 dark:text-amber-300"
            >
              <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0" />
              {ct('Unverified', '未认证')} · {assetBadge}
            </span>
          )}
        </div>
        <span className="font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {assetBadge}
        </span>
      </div>

      <div className="divide-y divide-claude-border/60 px-4 py-1 dark:divide-claude-darkBorder/60">
        {data.quotes.map((quote) => (
          <div
            key={`${quote.rail}-${quote.label}`}
            className="flex items-center justify-between gap-3 py-2.5 text-xs"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-claude-text dark:text-claude-darkText">
                  {quote.label || formatFtRailLabel(quote.rail)}
                </span>
                {quote.recommended && (
                  <span className="inline-flex items-center gap-0.5 rounded-md bg-claude-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-claude-accent">
                    <SparklesIcon className="h-3 w-3" />
                    {ct('Best Route', '最优推荐')}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {ct('Depth', '可买深度')}: <span className="font-mono">{quote.depthDisplay}</span> {data.symbol}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <div className="text-right">
                <div className="font-mono text-xs font-semibold text-claude-text dark:text-claude-darkText">
                  {quote.floorUnit}
                </div>
                <div className="text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {ct('Floor / unit', '起步单价')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => dispatchDraft(quote.rail, quote.label)}
                className="rounded-lg border border-claude-border px-2.5 py-1 text-[11px] font-medium text-claude-text transition hover:border-claude-accent hover:text-claude-accent dark:border-claude-darkBorder dark:text-claude-darkText"
              >
                {ct('Select', '选用')}
              </button>
            </div>
          </div>
        ))}
      </div>

      {(data.suggestion || recommendedQuote) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-claude-border/80 bg-black/[0.015] px-4 py-2.5 dark:border-claude-darkBorder/80 dark:bg-white/[0.015]">
          {data.suggestion ? (
            <p className="min-w-0 flex-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {data.suggestion}
            </p>
          ) : (
            <span />
          )}
          {recommendedQuote && (
            <button
              type="button"
              onClick={() => dispatchDraft(recommendedQuote.rail, recommendedQuote.label)}
              className="shrink-0 rounded-xl bg-claude-accent px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              {ct('Sweep Best Quote', '按最优方案扫货')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default FtQuoteCard;
