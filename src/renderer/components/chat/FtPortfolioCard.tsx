import React from 'react';
import type { FtPortfolioCardData, FtPortfolioHolding } from './ftCardSyntax';
import {
  dispatchSuiteComposerDraft,
  SuiteTokenAvatar,
  TK_CARD_SHELL,
  TK_CHIP_BTN,
  VerifyOrIdBadge,
} from './tokenSuiteUi';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtPortfolioCardProps {
  data: FtPortfolioCardData;
}

/**
 * FtPortfolioCard (Approved P2 — Per-Chain Partitioned Bento):
 * Physically separates Bitcoin MRC-20 / ID-Coin holdings from MVC MetaContract
 * holdings so cross-chain bridged tickers with identical symbols never confuse users.
 */
const FtPortfolioCard: React.FC<FtPortfolioCardProps> = ({ data }) => {
  const renderHoldingRow = (h: FtPortfolioHolding) => {
    const stdTag =
      h.chain === 'mvc'
        ? 'MetaContract'
        : h.standard === 'idcoin'
          ? 'ID-Coin'
          : 'MRC-20';

    const subText =
      h.availableDisplay && h.lockedDisplay
        ? `${ct('Avail', '可用')} ${h.availableDisplay} · ${ct('In orders', '挂单冻结')} ${h.lockedDisplay}`
        : h.availableDisplay
          ? `${ct('Available', '可用')} ${h.availableDisplay}`
          : stdTag;

    return (
      <div
        key={`${h.chain}-${h.assetKey}`}
        className="flex items-center justify-between gap-2 py-[6px] first:pt-0 last:pb-0"
      >
        <div className="flex min-w-0 items-center gap-2">
          <SuiteTokenAvatar symbol={h.symbol} chain={h.chain} size="sm" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[12.5px] font-bold">${h.symbol}</span>
              <span className="rounded-[5px] bg-white/80 px-1.5 py-[1px] text-[9.5px] font-semibold text-[#5b6472] dark:bg-white/[0.08] dark:text-[#9aa3b2]">
                {stdTag}
              </span>
              {h.bridgedPeer && (
                <span
                  title={ct('Bridged dual-chain asset', '同名跨链互通资产')}
                  className="rounded-[5px] bg-[#0ea5e9]/[0.12] px-1 py-[1px] text-[9.5px] font-bold text-[#0369a1] dark:text-[#38bdf8]"
                >
                  ⇄
                </span>
              )}
              {!h.caVerified && (
                <VerifyOrIdBadge caVerified={false} assetKey={h.assetKey} />
              )}
            </div>
            <div className="mt-[1.5px] truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
              {subText}
            </div>
          </div>
        </div>

        <div className="shrink-0 text-right [font-variant-numeric:tabular-nums]">
          <div className="font-mono text-[12.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
            {h.totalDisplay}
          </div>
          {h.usdText ? (
            <div className="text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
              {h.usdText}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div
      data-ft-card="portfolio"
      className={TK_CARD_SHELL}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14.5px] font-bold tracking-[-0.02em]">
            {data.botName
              ? `${data.botName} · ${ct('Token Portfolio', '多链代币持仓')}`
              : ct('Multi-Chain Token Portfolio', '多链代币持仓总览')}
          </div>
          <div className="mt-[2px] flex flex-wrap items-center gap-1.5 text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
            <span>{ct('Separated by L1 chain & standard', '按底层链与代币协议物理分仓')}</span>
          </div>
        </div>

        <div className="shrink-0 text-right [font-variant-numeric:tabular-nums]">
          {data.totalUsdText ? (
            <div className="text-[15px] font-extrabold tracking-[-0.02em]">
              {data.totalUsdText}
            </div>
          ) : null}
          {data.meBalanceText ? (
            <span className="mt-[2px] inline-flex items-center rounded-[6px] border border-[#8b5cf6]/30 bg-[#8b5cf6]/[0.12] px-1.5 py-[1px] text-[10px] font-semibold text-[#6d28d9] dark:border-[#a78bfa]/30 dark:bg-[#a78bfa]/[0.15] dark:text-[#c4b5fd]">
              ✦ {data.meBalanceText}
            </span>
          ) : null}
        </div>
      </div>

      {/* BTC Partition */}
      <div className="mt-[10px] rounded-[11px] border border-[#f7931a]/25 bg-[#f2f4f7] px-[10px] py-[8.5px] dark:border-[#f7931a]/25 dark:bg-white/[0.045]">
        <div className="mb-[6px] flex items-center justify-between gap-2 border-b border-slate-900/[0.06] pb-[5px] dark:border-white/[0.06]">
          <span className="text-[11px] font-bold text-[#c26200] dark:text-[#fb923c]">
            ₿ {ct('Bitcoin · MRC-20 / ID-Coin', 'Bitcoin 链 · MRC-20 / ID-Coin')}
          </span>
          {data.btcGasText && (
            <span className="font-mono text-[10px] text-[#5b6472] [font-variant-numeric:tabular-nums] dark:text-[#9aa3b2]">
              Gas: {data.btcGasText}
            </span>
          )}
        </div>

        {data.btcHoldings.length === 0 ? (
          <div className="py-1 text-[11px] text-[#8a94a6] dark:text-[#6f7887]">
            {ct('No MRC-20 / ID-Coin holdings on BTC', '暂无 BTC 链 MRC-20 / ID-Coin 持仓')}
          </div>
        ) : (
          <div className="divide-y divide-slate-900/[0.06] dark:divide-white/[0.06]">
            {data.btcHoldings.map(renderHoldingRow)}
          </div>
        )}
      </div>

      {/* MVC Partition */}
      <div className="mt-[8px] rounded-[11px] border border-[#0ea5e9]/25 bg-[#f2f4f7] px-[10px] py-[8.5px] dark:border-[#38bdf8]/25 dark:bg-white/[0.045]">
        <div className="mb-[6px] flex items-center justify-between gap-2 border-b border-slate-900/[0.06] pb-[5px] dark:border-white/[0.06]">
          <span className="text-[11px] font-bold text-[#0369a1] dark:text-[#38bdf8]">
            ◈ {ct('MVC · MetaContract (MCP02)', 'MVC 链 · MetaContract (MCP02)')}
          </span>
          {data.mvcGasText && (
            <span className="font-mono text-[10px] text-[#5b6472] [font-variant-numeric:tabular-nums] dark:text-[#9aa3b2]">
              Gas: {data.mvcGasText}
            </span>
          )}
        </div>

        {data.mvcHoldings.length === 0 ? (
          <div className="py-1 text-[11px] text-[#8a94a6] dark:text-[#6f7887]">
            {ct('No MetaContract FT holdings on MVC', '暂无 MVC 链合约代币持仓')}
          </div>
        ) : (
          <div className="divide-y divide-slate-900/[0.06] dark:divide-white/[0.06]">
            {data.mvcHoldings.map(renderHoldingRow)}
          </div>
        )}
      </div>

      {data.dogeGasText && (
        <div className="mt-[6px] flex items-center justify-between rounded-[8px] bg-[#f2f4f7] px-2.5 py-1 text-[10.5px] text-[#5b6472] [font-variant-numeric:tabular-nums] dark:bg-white/[0.04] dark:text-[#9aa3b2]">
          <span>Ð Dogecoin Native Gas</span>
          <span className="font-mono font-semibold text-[#1f2329] dark:text-[#f4f5f8]">
            {data.dogeGasText}
          </span>
        </div>
      )}

      {/* Quick Actions */}
      <div className="mt-[9px] flex flex-wrap items-center justify-end gap-[6px]">
        <button
          type="button"
          onClick={() =>
            dispatchSuiteComposerDraft(
              ct(
                'Check cross-chain bridge routes between MVC and BTC for my tokens.',
                '帮我查看当前持仓代币在 MVC 与 BTC 之间的跨链转换方案。',
              ),
            )
          }
          className={TK_CHIP_BTN}
        >
          ⇄ {ct('Bridge', '跨链桥')}
        </button>
        <button
          type="button"
          onClick={() =>
            dispatchSuiteComposerDraft(
              ct(
                'I want to list one of my tokens for sale.',
                '我想把持有的代币上架挂牌出售。',
              ),
            )
          }
          className={TK_CHIP_BTN}
        >
          {ct('List for Sale', '挂牌卖币')}
        </button>
        <button
          type="button"
          onClick={() =>
            dispatchSuiteComposerDraft(
              ct(
                'I want to transfer tokens to another address.',
                '我想向其他地址发送代币转账。',
              ),
            )
          }
          className={TK_CHIP_BTN}
        >
          {ct('Transfer', '转账')}
        </button>
      </div>
    </div>
  );
};

export default FtPortfolioCard;
