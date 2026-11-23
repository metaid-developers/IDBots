import React, { useState } from 'react';
import {
  inferFtChainAndStandard,
  type FtMyOrderItem,
  type FtMyOrdersCardData,
} from './ftCardSyntax';
import {
  ChainStandardBadge,
  dispatchSuiteComposerDraft,
  RailVenueBadge,
  SuiteTokenAvatar,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_INSET_BOX,
  VerifyOrIdBadge,
} from './tokenSuiteUi';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtMyOrdersCardProps {
  data: FtMyOrdersCardData;
}

/**
 * FtMyOrdersCard (Approved O1 — Compact Ticket Stack):
 * Aggregates active seller listings across BTC PSBT, MVC TokenSell Contract,
 * and ME Points Trade into one scannable card with per-order cancel actions.
 */
const FtMyOrdersCard: React.FC<FtMyOrdersCardProps> = ({ data }) => {
  const [canceledIds, setCanceledIds] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const handleCancelOrder = async (order: FtMyOrderItem) => {
    if (busyId || canceledIds[order.id]) return;
    setBusyId(order.id);
    setNotice('');
    try {
      if (
        order.batchGroupId &&
        order.rail !== 'btc-psbt' &&
        typeof window !== 'undefined' &&
        window.electron?.ftTrade?.cancelBatchOrders
      ) {
        const res = await window.electron.ftTrade.cancelBatchOrders({
          batchGroupId: order.batchGroupId,
        });
        if (res?.canceledCount && res.canceledCount > 0) {
          setCanceledIds((prev) => ({ ...prev, [order.id]: true }));
          setNotice(
            ct(
              `Canceled ${res.canceledCount} lot(s) for $${order.symbol}.`,
              `已撤回 $${order.symbol} 的 ${res.canceledCount} 份挂单。`,
            ),
          );
          return;
        }
      }

      const detailHint = order.sellTxid
        ? ` (sell_txid: ${order.sellTxid}${typeof order.sellOutputIndex === 'number' ? `, output_index: ${order.sellOutputIndex}` : ''})`
        : order.batchGroupId
          ? ` (batch: ${order.batchGroupId})`
          : '';
      dispatchSuiteComposerDraft(
        ct(
          `Cancel my active $${order.symbol} (${order.assetKey}) sell order on ${order.rail}${detailHint}.`,
          `请撤回我在 ${order.rail} 挂出的 $${order.symbol}（${order.assetKey}）挂单${detailHint}。`,
        ),
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleCancelAll = () => {
    dispatchSuiteComposerDraft(
      ct(
        `Cancel all my remaining active token sell orders.`,
        `请帮我撤回当前全部未成交的代币挂单。`,
      ),
    );
  };

  const handleNewListing = () => {
    dispatchSuiteComposerDraft(
      ct(
        `I want to list a token for sale. Check my token balances and suggest listing options.`,
        `我想上架挂牌卖币，请先查看我的代币余额并给出上架方案建议。`,
      ),
    );
  };

  return (
    <div
      data-ft-card="my-orders"
      className={TK_CARD_SHELL}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <SuiteTokenAvatar symbol="O" chain="dual" glyphOverride="☰" />
          <div className="min-w-0">
            <div className="truncate text-[14.5px] font-bold tracking-[-0.02em]">
              {data.botName
                ? `${data.botName} · ${ct('Active Orders', '在售挂单')}`
                : ct('My Active Sell Orders', '我的在售挂单')}
            </div>
            <div className="mt-[2px] truncate text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
              {ct(
                `Cross-rail desk · ${data.totalOrdersCount} active listing(s)`,
                `跨渠道聚合 · ${data.totalOrdersCount} 笔挂单值守中`,
              )}
            </div>
          </div>
        </div>

        {data.totalValuationText ? (
          <span className="shrink-0 rounded-[7px] bg-[#f2f4f7] px-2 py-1 font-mono text-[11px] font-bold text-[#1f2329] [font-variant-numeric:tabular-nums] dark:bg-white/[0.06] dark:text-[#f4f5f8]">
            {data.totalValuationText}
          </span>
        ) : null}
      </div>

      {/* Orders List */}
      {data.orders.length === 0 ? (
        <div className={`mt-[10px] text-center text-[12px] text-[#5b6472] dark:text-[#9aa3b2] ${TK_INSET_BOX}`}>
          {ct('No active token sell orders right now.', '当前暂无在售中的代币挂单。')}
        </div>
      ) : (
        <div className="mt-[10px] flex flex-col gap-[6px] [font-variant-numeric:tabular-nums]">
          {data.orders.map((order) => {
            const { chain, standard } = inferFtChainAndStandard(
              order.assetKey,
              undefined,
              undefined,
              order.rail,
            );
            const isCanceled = Boolean(canceledIds[order.id]);
            const pct =
              order.totalLots > 0
                ? Math.min(100, Math.round((order.filledLots / order.totalLots) * 100))
                : 0;

            return (
              <div
                key={order.id}
                className={`rounded-[11px] bg-[#f2f4f7] px-[10px] py-[8.5px] dark:bg-white/[0.045] ${
                  isCanceled ? 'opacity-55' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    <span className="text-[13px] font-bold">${order.symbol}</span>
                    <ChainStandardBadge chain={chain} standard={standard} compact />
                    <RailVenueBadge rail={order.rail} compact />
                    {order.caVerified === false && (
                      <VerifyOrIdBadge caVerified={false} assetKey={order.assetKey} />
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-[12px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                    {order.unitPriceLabel}
                  </span>
                </div>

                <div className="mt-[6px] flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2 text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
                    <span className="truncate">{order.lotSummaryText}</span>
                    {order.totalLots > 1 && (
                      <span className="inline-block h-[4px] w-[46px] shrink-0 overflow-hidden rounded-full bg-slate-900/[0.09] dark:bg-white/[0.1]">
                        <span
                          className="block h-full rounded-full bg-[#0f9d68] dark:bg-[#34d399]"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={isCanceled || busyId === order.id}
                    onClick={() => void handleCancelOrder(order)}
                    className="shrink-0 rounded-[7px] border border-[#dc3545]/30 bg-transparent px-2 py-[2.5px] text-[10.5px] font-semibold text-[#dc3545] transition hover:bg-[#dc3545]/[0.08] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#fb7185]/35 dark:text-[#fb7185]"
                  >
                    {isCanceled
                      ? ct('Canceled', '已撤回')
                      : busyId === order.id
                        ? ct('…', '撤单中')
                        : ct('Cancel', '撤单')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {notice && (
        <div className="mt-2 rounded-[9px] bg-[#f2f4f7] px-2.5 py-1.5 text-[11px] text-[#5b6472] dark:bg-white/[0.06] dark:text-[#9aa3b2]">
          {notice}
        </div>
      )}

      {/* Footer Actions */}
      <div className="mt-[10px] flex items-center gap-[7px]">
        {data.orders.length > 0 && (
          <button
            type="button"
            onClick={handleCancelAll}
            className={TK_BTN_SECONDARY}
          >
            {ct('Cancel All', '全部撤单')}
          </button>
        )}
        <button
          type="button"
          onClick={handleNewListing}
          className={TK_BTN_PRIMARY}
        >
          {ct('+ New Listing', '+ 新增挂牌')}
        </button>
      </div>
    </div>
  );
};

export default FtMyOrdersCard;
