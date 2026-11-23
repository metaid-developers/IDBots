import React from 'react';
import type { FtBridgeCardData } from './ftCardSyntax';
import {
  ChainStandardBadge,
  CopyShortHashButton,
  dispatchSuiteComposerDraft,
  SuiteTokenAvatar,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_INSET_BOX,
} from './tokenSuiteUi';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtBridgeCardProps {
  data: FtBridgeCardData;
}

/**
 * FtBridgeCard (Approved B1 — Dual-Chain Flow + 3-Step Confirmation Tracker):
 * Renders MVC -> BTC Octopus Bridge progress, as well as clean advisory & direct
 * listing alternatives when BTC -> MVC reverse bridging is temporarily paused.
 */
const FtBridgeCard: React.FC<FtBridgeCardProps> = ({ data }) => {
  const isMvcToBtc = data.direction === 'mvc-to-btc';
  const isPaused = data.status === 'paused';
  const isCompleted = data.status === 'completed';
  const stepCurrent = isCompleted ? 3 : data.stepCurrent ?? 2;

  const statusPill = isPaused
    ? {
        label: ct('Direction Paused', '单向维护中'),
        cls: 'bg-amber-500/[0.14] text-[#b45309] dark:text-[#fbbf24]',
      }
    : isCompleted
      ? {
          label: ct('Completed', '跨链已到账'),
          cls: 'bg-[#0f9d68]/[0.12] text-[#0f9d68] dark:text-[#34d399]',
        }
      : data.status === 'quote'
        ? {
            label: ct('Bridge Route', '跨链预览'),
            cls: 'bg-[#0ea5e9]/[0.12] text-[#0369a1] dark:text-[#38bdf8]',
          }
        : {
            label: ct('Confirming', '区块确认中'),
            cls: 'bg-[#0ea5e9]/[0.12] text-[#0369a1] dark:text-[#38bdf8]',
          };

  const steps = [
    { idx: 1, label: ct('Lock / Burn', '源链锁定') },
    { idx: 2, label: ct('Relayer Verify', '桥节点确认') },
    { idx: 3, label: ct('Target Credit', '目标链入账') },
  ];

  return (
    <div
      data-ft-card="bridge"
      data-bridge-direction={data.direction}
      data-bridge-status={data.status}
      className={TK_CARD_SHELL}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <SuiteTokenAvatar symbol={data.symbol} chain="dual" glyphOverride="⇄" />
          <div className="min-w-0">
            <div className="truncate text-[14.5px] font-bold tracking-[-0.02em]">
              ${data.symbol} · {ct('Octopus Bridge', '跨链资产桥')}
            </div>
            <div className="mt-[2px] truncate text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
              {isMvcToBtc
                ? 'MVC · MetaContract → BTC · MRC-20'
                : 'BTC · MRC-20 → MVC · MetaContract'}
            </div>
          </div>
        </div>

        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold ${statusPill.cls}`}>
          {statusPill.label}
        </span>
      </div>

      {/* Dual-Chain Flow Boxes */}
      <div className="mt-[10px] grid grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)] items-center gap-[5px] [font-variant-numeric:tabular-nums]">
        <div className="min-w-0 rounded-[11px] border border-slate-900/[0.06] bg-[#f2f4f7] px-[10px] py-[9px] dark:border-white/[0.07] dark:bg-white/[0.045]">
          <div className="mb-1">
            <ChainStandardBadge
              chain={isMvcToBtc ? 'mvc' : 'btc'}
              standard={isMvcToBtc ? 'mvc-ft' : 'mrc20'}
              compact
            />
          </div>
          <div className="truncate font-mono text-[13px] font-extrabold text-[#1f2329] dark:text-[#f4f5f8]">
            -{data.sendAmountDisplay} {data.symbol}
          </div>
          <div className="mt-[2px] truncate text-[10px] text-[#5b6472] dark:text-[#9aa3b2]">
            {data.availableBalanceText
              ? `${ct('Balance', '当前余额')}: ${data.availableBalanceText}`
              : ct('Source chain', '转出源链')}
          </div>
        </div>

        <div className="grid h-[22px] w-[22px] place-items-center rounded-full border border-slate-900/[0.09] bg-[#f2f4f7] text-[11px] font-bold text-[#5b6472] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#9aa3b2]">
          →
        </div>

        <div
          className={`min-w-0 rounded-[11px] px-[10px] py-[9px] ${
            isPaused
              ? 'border border-dashed border-amber-500/40 bg-amber-500/[0.06]'
              : 'border border-[#0f9d68]/30 bg-[#0f9d68]/[0.06] dark:border-[#34d399]/30 dark:bg-[#34d399]/[0.07]'
          }`}
        >
          <div className="mb-1">
            <ChainStandardBadge
              chain={isMvcToBtc ? 'btc' : 'mvc'}
              standard={isMvcToBtc ? 'mrc20' : 'mvc-ft'}
              compact
            />
          </div>
          <div
            className={`truncate font-mono text-[13px] font-extrabold ${
              isPaused
                ? 'text-[#b45309] dark:text-[#fbbf24]'
                : 'text-[#0f9d68] dark:text-[#34d399]'
            }`}
          >
            {isPaused
              ? ct('Paused', '暂停转入')
              : `+${data.receiveAmountDisplay || data.sendAmountDisplay} ${data.symbol}`}
          </div>
          <div className="mt-[2px] truncate text-[10px] text-[#5b6472] dark:text-[#9aa3b2]">
            {data.feeLabel || ct('1:1 Canonical Peg', '1:1 官方锚定')}
          </div>
        </div>
      </div>

      {/* Paused Advisory OR 3-Step Confirmation Tracker */}
      {isPaused ? (
        <>
          <div className="mt-[9px] rounded-[11px] border border-amber-500/30 bg-amber-500/[0.09] px-[10px] py-[8px] text-[11px] leading-[1.45] text-[#92400e] dark:text-[#fde68a]">
            {data.statusNotice ||
              ct(
                `BTC → MVC bridging for $${data.symbol} is temporarily under maintenance. No bridge needed to sell: list directly on metaid.market (PSBT) or via ME Points Trade.`,
                `当前 BTC → MVC 方向暂停转入维护中。无需跨链即可直接卖币：推荐挂牌到 metaid.market (PSBT) 或使用 ME 积分交易。`,
              )}
          </div>
          <div className="mt-[9px] flex items-center gap-[7px]">
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `List my BTC $${data.symbol} directly on metaid.market (btc-psbt).`,
                    `请帮我将 BTC 链上的 $${data.symbol} 直接上架到 metaid.market (PSBT)。`,
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('List on PSBT', '挂牌 PSBT')}
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `List my $${data.symbol} for sale via ME Points Trade (me-escrow).`,
                    `请帮我将 $${data.symbol} 通过 ME 积分交易挂牌上架。`,
                  ),
                )
              }
              className={TK_BTN_PRIMARY}
            >
              {ct('List via ME Points', '用 ME 积分交易上架')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-[10px] flex items-center justify-between gap-1 rounded-[10px] bg-[#f2f4f7] px-[10px] py-[7px] text-[10.5px] dark:bg-white/[0.045]">
            {steps.map((s, idx) => {
              const done = s.idx < stepCurrent || isCompleted;
              const active = s.idx === stepCurrent && !isCompleted;
              return (
                <React.Fragment key={s.idx}>
                  <div className="flex items-center gap-1">
                    <span
                      className={`grid h-[16px] w-[16px] shrink-0 place-items-center rounded-full text-[9.5px] font-extrabold ${
                        done
                          ? 'bg-[#0f9d68] text-white dark:bg-[#34d399] dark:text-[#0f172a]'
                          : active
                            ? 'bg-[#ffdc51] text-[#24210c]'
                            : 'bg-slate-900/[0.1] text-[#8a94a6] dark:bg-white/[0.1] dark:text-[#6f7887]'
                      }`}
                    >
                      {done ? '✓' : s.idx}
                    </span>
                    <span
                      className={
                        done || active
                          ? 'font-semibold text-[#1f2329] dark:text-[#f4f5f8]'
                          : 'text-[#8a94a6] dark:text-[#6f7887]'
                      }
                    >
                      {s.label}
                    </span>
                  </div>
                  {idx < steps.length - 1 && (
                    <span className="h-[1px] flex-1 bg-slate-900/[0.12] dark:bg-white/[0.12]" />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {(data.confirmationsText || data.etaText || data.txid) && (
            <div
              className={`mt-[7px] divide-y divide-slate-900/[0.06] dark:divide-white/[0.06] ${TK_INSET_BOX} [font-variant-numeric:tabular-nums]`}
            >
              {data.confirmationsText && (
                <div className="flex items-center justify-between pb-[5px] text-[11.5px]">
                  <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                    {ct('Confirmations', '区块确认进度')}
                  </span>
                  <span className="font-mono font-semibold">{data.confirmationsText}</span>
                </div>
              )}
              {data.etaText && (
                <div className="flex items-center justify-between py-[5px] text-[11.5px]">
                  <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                    {ct('Estimated Time', '预计完成时间')}
                  </span>
                  <span className="font-semibold">{data.etaText}</span>
                </div>
              )}
              {data.txid && (
                <div className="flex items-center justify-between pt-[5px] text-[11.5px]">
                  <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                    {ct('Bridge TxID', '跨链交易哈希')}
                  </span>
                  <CopyShortHashButton value={data.txid} />
                </div>
              )}
            </div>
          )}

          <div className="mt-[9px] flex items-center gap-[7px]">
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Check the latest Octopus Bridge status for $${data.symbol}${data.txid ? ` (txid: ${data.txid})` : ''}.`,
                    `请刷新查询 $${data.symbol} 的跨链桥到账进度${data.txid ? `（TxID: ${data.txid}）` : ''}。`,
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('Refresh Status', '刷新跨链进度')}
            </button>
            {data.status === 'quote' && (
              <button
                type="button"
                onClick={() =>
                  dispatchSuiteComposerDraft(
                    ct(
                      `Bridge ${data.sendAmountDisplay} $${data.symbol} via Octopus Bridge (${data.direction}).`,
                      `请执行将 ${data.sendAmountDisplay} $${data.symbol} 通过 Octopus 跨链桥转换（${data.direction}）。`,
                    ),
                  )
                }
                className={TK_BTN_PRIMARY}
              >
                {ct('Execute Bridge', '确认发起跨链')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default FtBridgeCard;
