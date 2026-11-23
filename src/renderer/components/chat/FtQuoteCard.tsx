import React from 'react';
import {
  formatFtAssetBadge,
  formatFtRailLabel,
  inferFtChainAndStandard,
  type FtCardRail,
  type FtQuoteCardData,
  type FtQuoteRow,
} from './ftCardSyntax';
import {
  ChainStandardBadge,
  dispatchSuiteComposerDraft,
  RailVenueBadge,
  SuiteTokenAvatar,
  TK_BTN_PRIMARY,
  TK_CARD_SHELL,
  TK_INSET_BOX,
  VerifyOrIdBadge,
} from './tokenSuiteUi';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtQuoteCardProps {
  data: FtQuoteCardData;
}

/**
 * FtQuoteCard (Approved Q1 — Four-Rail Route Comparison):
 * Compares ME Points Trade, BTC metaid.market (PSBT), MVC TokenSell Contract,
 * and upcoming MVCSwap Pool side by side with clear chain/standard provenance.
 */
const FtQuoteCard: React.FC<FtQuoteCardProps> = ({ data }) => {
  const assetBadge = formatFtAssetBadge(data.assetKey);
  const { chain, standard } = inferFtChainAndStandard(data.assetKey);

  const activeQuotes = data.quotes.filter((q) => q.status !== 'coming_soon');
  const recommendedQuote =
    activeQuotes.find((q) => q.recommended) ?? activeQuotes[0];

  const hasExplicitSwap = data.quotes.some((q) => q.rail === 'mvc-swap');
  const displayRows: FtQuoteRow[] =
    hasExplicitSwap || data.hideUpcomingSwap
      ? data.quotes
      : [
          ...data.quotes,
          {
            rail: 'mvc-swap',
            label: ct('MVC · MVCSwap Pool', 'MVC · MVCSwap 闪兑'),
            floorUnit: '—',
            depthDisplay: '0',
            status: 'coming_soon',
            subMeta: ct(
              'Instant AMM pool swap for MVC tokens',
              '池子实时联动报价 · 支持 MVC 链代币秒级闪兑',
            ),
          },
        ];

  const handleSelectRail = (rail: FtCardRail, label: string) => {
    const text = ct(
      `Execute the ${data.symbol} (${data.assetKey}) buy plan on ${label} (${rail}).`,
      `请按 ${label}（${rail}）方案执行买入 $${data.symbol}（${data.assetKey}）。`,
    );
    dispatchSuiteComposerDraft(text);
  };

  return (
    <div
      data-ft-card="quote"
      data-asset-key={data.assetKey}
      className={TK_CARD_SHELL}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <SuiteTokenAvatar
            symbol={data.symbol}
            chain={data.bridgedDualChain ? 'dual' : chain}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[14.5px] font-bold tracking-[-0.02em]">
                ${data.symbol}
              </span>
              <VerifyOrIdBadge caVerified={data.caVerified} assetKey={data.assetKey} />
            </div>
            <div className="mt-[2px] flex flex-wrap items-center gap-1 text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
              {data.bridgedDualChain ? (
                <span>{ct('Dual-chain bridged · Compare venues', '双链互通 · 横向比价选最优渠道')}</span>
              ) : (
                <>
                  <ChainStandardBadge chain={chain} standard={standard} compact />
                  <span className="font-mono text-[10.5px] opacity-85">{assetBadge}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {data.budgetLabel ? (
          <span className="shrink-0 rounded-[6px] bg-[#f2f4f7] px-2 py-0.5 text-[10.5px] font-semibold text-[#5b6472] dark:bg-white/[0.06] dark:text-[#9aa3b2]">
            {data.budgetLabel}
          </span>
        ) : null}
      </div>

      {/* Four-Rail Quote Rows */}
      <div className="mt-[10px] flex flex-col gap-[6px] [font-variant-numeric:tabular-nums]">
        {displayRows.map((quote) => {
          const isSoon = quote.status === 'coming_soon';
          const isRec = !isSoon && quote.recommended === true;
          const displayLabel =
            quote.label || ct(formatFtRailLabel(quote.rail, 'en'), formatFtRailLabel(quote.rail, 'zh'));

          if (isSoon) {
            return (
              <div
                key={`${quote.rail}-soon`}
                className="flex items-center justify-between gap-2 rounded-[11px] border border-dashed border-slate-900/[0.12] bg-[#f2f4f7]/70 px-[10px] py-[8px] opacity-80 dark:border-white/[0.12] dark:bg-white/[0.03]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <RailVenueBadge rail={quote.rail} />
                    <span className="rounded-[5px] bg-slate-900/[0.07] px-1.5 py-[1px] text-[9.5px] font-bold text-[#5b6472] dark:bg-white/[0.1] dark:text-[#9aa3b2]">
                      {ct('Coming Soon', '即将开放')}
                    </span>
                  </div>
                  <div className="mt-[2px] truncate text-[10.5px] text-[#8a94a6] dark:text-[#6f7887]">
                    {quote.subMeta ||
                      ct('AMM liquidity pool instant swap', 'AMM 流动性池秒级闪兑')}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[11px] font-semibold text-[#8a94a6] dark:text-[#6f7887]">
                  —
                </span>
              </div>
            );
          }

          return (
            <div
              key={`${quote.rail}-${displayLabel}`}
              className={
                isRec
                  ? 'flex items-center justify-between gap-2 rounded-[11px] border-[1.5px] border-[#b48a00]/40 bg-[#ffdc51]/[0.1] px-[10px] py-[8.5px] dark:border-[#ffdc51]/45 dark:bg-[#ffdc51]/[0.07]'
                  : 'flex items-center justify-between gap-2 rounded-[11px] border border-transparent bg-[#f2f4f7] px-[10px] py-[8.5px] dark:bg-white/[0.045]'
              }
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <RailVenueBadge rail={quote.rail} />
                  {isRec && (
                    <span className="rounded-[5px] bg-[#ffdc51] px-[5px] py-[1px] text-[9.5px] font-extrabold text-[#24210c]">
                      ★ {ct('Best Route', '最划算')}
                    </span>
                  )}
                </div>
                <div className="mt-[3px] truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
                  {quote.subMeta ? (
                    quote.subMeta
                  ) : (
                    <>
                      {ct('Depth', '可买深度')}:{' '}
                      <span className="font-mono font-semibold">{quote.depthDisplay}</span>{' '}
                      {data.symbol}
                    </>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <div className="text-right">
                  <div className="font-mono text-[12.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                    {quote.floorUnit}
                  </div>
                  <div className="text-[10px] text-[#5b6472] dark:text-[#9aa3b2]">
                    {quote.usdHint || ct('Floor / unit', '起步单价')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleSelectRail(quote.rail, displayLabel)}
                  className={
                    isRec
                      ? 'rounded-[8px] bg-[#ffdc51] px-2.5 py-1 text-[11px] font-bold text-[#24210c] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] transition hover:bg-[#ffe474] active:scale-[0.97]'
                      : 'rounded-[8px] border border-slate-900/[0.1] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#1f2329] transition hover:border-[#b48a00]/45 dark:border-white/[0.12] dark:bg-[#232529] dark:text-[#f4f5f8]'
                  }
                >
                  {ct('Select', '选用')}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Suggestion Ledger Inset */}
      {data.suggestion && (
        <div className={`mt-[8px] text-[11px] leading-[1.45] text-[#5b6472] dark:text-[#9aa3b2] ${TK_INSET_BOX}`}>
          {data.suggestion}
        </div>
      )}

      {/* Primary Sweep CTA */}
      {recommendedQuote && (
        <div className="mt-[9px] flex">
          <button
            type="button"
            onClick={() =>
              handleSelectRail(
                recommendedQuote.rail,
                recommendedQuote.label ||
                  ct(
                    formatFtRailLabel(recommendedQuote.rail, 'en'),
                    formatFtRailLabel(recommendedQuote.rail, 'zh'),
                  ),
              )
            }
            className={TK_BTN_PRIMARY}
          >
            {ct('Sweep Best Quote', '按最优方案扫货')}
          </button>
        </div>
      )}
    </div>
  );
};

export default FtQuoteCard;
