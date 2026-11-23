import React from 'react';
import type { FtActionCardData } from './ftCardSyntax';
import {
  ChainStandardBadge,
  CopyShortHashButton,
  dispatchSuiteComposerDraft,
  SuiteTokenAvatar,
  TK_BENTO_CELL,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_COMPACT_SHELL,
  TK_CARD_SHELL,
  TK_INSET_BOX,
} from './tokenSuiteUi';
import { ct } from '../commerce/commerceTradeI18n';

export interface FtActionCardProps {
  data: FtActionCardData;
}

/**
 * FtActionCard (Approved Hybrid M1 + M2):
 * - `action === 'issue'` renders M1 Genesis Certificate (hero supply + supply-lock badge + 2x2 Bento + List CTA)
 * - `action === 'mint' | 'transfer'` renders M2 Compact Receipt (3-row ledger aligned with S1)
 */
const FtActionCard: React.FC<FtActionCardProps> = ({ data }) => {
  if (data.action === 'issue') {
    const genesisRef = data.genesisId || (data.assetKey || '').replace(/^(mvc-ft|mrc20):/i, '');
    return (
      <div
        data-ft-card="action"
        data-ft-action="issue"
        data-ft-action-variant="m1-certificate"
        className={TK_CARD_SHELL}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <SuiteTokenAvatar symbol={data.symbol} chain={data.chain} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[14.5px] font-bold tracking-[-0.02em]">
                  ${data.symbol}
                </span>
                <ChainStandardBadge chain={data.chain} standard={data.standard} compact />
              </div>
              <div className="mt-[2px] truncate text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
                {data.name
                  ? `${data.name} · ${ct('Genesis Issuance', '创世发币凭证')}`
                  : ct('Genesis Token Issuance', '创世发币凭证')}
              </div>
            </div>
          </div>

          <span className="shrink-0 rounded-full bg-[#0f9d68]/[0.12] px-2.5 py-0.5 text-[10.5px] font-semibold text-[#0f9d68] dark:bg-[#34d399]/[0.14] dark:text-[#34d399]">
            ✓ {ct('Issued', '已上链')}
          </span>
        </div>

        {/* Hero Supply */}
        <div className="mt-[10px] rounded-[11px] border border-slate-900/[0.06] bg-[#f2f4f7] px-[12px] py-[10px] [font-variant-numeric:tabular-nums] dark:border-white/[0.07] dark:bg-white/[0.045]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Genesis Supply', '创世发行总量')}
            </span>
            <span className="rounded-[5px] bg-white px-1.5 py-[1px] text-[10px] font-semibold text-[#1f2329] dark:bg-white/[0.1] dark:text-[#f4f5f8]">
              {data.mintable
                ? ct('Mintable Supply', '允许后续增发')
                : ct('🔒 Fixed Supply · Locked', '🔒 固定总量 · 已锁死')}
            </span>
          </div>
          <div className="mt-[4px] truncate font-mono text-[20px] font-extrabold tracking-[-0.03em]">
            {data.amountDisplay}{' '}
            <span className="text-[13px] font-bold text-[#5b6472] dark:text-[#9aa3b2]">
              ${data.symbol}
            </span>
          </div>
        </div>

        {/* 2x2 Bento Metadata */}
        <div className="mt-[8px] grid grid-cols-2 gap-[7px] [font-variant-numeric:tabular-nums]">
          <div className={TK_BENTO_CELL}>
            <div className="text-[10px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
              {ct('Decimals', '代币精度')}
            </div>
            <div className="mt-[2px] text-[12.5px] font-bold">
              {data.decimals ?? 8} {ct('decimals', '位小数')}
            </div>
          </div>

          <div className={TK_BENTO_CELL}>
            <div className="text-[10px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
              {ct('Initial Holder', '初始持有人')}
            </div>
            <div className="mt-[2px] truncate text-[12.5px] font-bold">
              {data.receiverLabel || ct('Bot Wallet (100%)', 'Bot 钱包 (100%)')}
            </div>
          </div>

          <div className={TK_BENTO_CELL}>
            <div className="text-[10px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
              {ct('Genesis ID', '创世合约 ID')}
            </div>
            <div className="mt-[2px]">
              <CopyShortHashButton value={genesisRef} />
            </div>
          </div>

          <div className={TK_BENTO_CELL}>
            <div className="text-[10px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
              {ct('Genesis TxID', '创世交易哈希')}
            </div>
            <div className="mt-[2px]">
              <CopyShortHashButton value={data.txid} />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-[10px] flex items-center gap-[7px]">
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Show the token card and my wallet balance for $${data.symbol} (${data.assetKey}).`,
                  `查看我刚发行的 $${data.symbol}（${data.assetKey}）代币详情与持仓。`,
                ),
              )
            }
            className={TK_BTN_SECONDARY}
          >
            {ct('View Token', '查看代币')}
          </button>
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `List a portion of my newly issued $${data.symbol} (${data.assetKey}) for sale.`,
                  `帮我将刚发行的 $${data.symbol}（${data.assetKey}）分批挂牌上架出售。`,
                ),
              )
            }
            className={TK_BTN_PRIMARY}
          >
            {ct('List for Sale', '去挂牌上架')}
          </button>
        </div>
      </div>
    );
  }

  // =========================================================================
  // M2: Compact Receipt for Daily Transfer & Mint
  // =========================================================================
  const isMint = data.action === 'mint';
  const shortReceiver =
    data.receiverAddress && data.receiverAddress.length > 16
      ? `${data.receiverAddress.slice(0, 7)}…${data.receiverAddress.slice(-5)}`
      : data.receiverAddress;

  return (
    <div
      data-ft-card="action"
      data-ft-action={data.action}
      data-ft-action-variant="m2-receipt"
      className={TK_CARD_COMPACT_SHELL}
    >
      <div className="flex items-center justify-between gap-2 [font-variant-numeric:tabular-nums]">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] bg-[#0f9d68]/[0.12] text-[13px] font-extrabold text-[#0f9d68] dark:bg-[#34d399]/[0.15] dark:text-[#34d399]">
            ✓
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13.5px] font-bold">
                {isMint
                  ? ct(`Minted $${data.symbol}`, `Mint 铸造 $${data.symbol}`)
                  : ct(`Sent $${data.symbol}`, `已转账 $${data.symbol}`)}
              </span>
              <ChainStandardBadge chain={data.chain} standard={data.standard} compact />
            </div>
          </div>
        </div>

        <span
          className={`shrink-0 font-mono text-[14px] font-extrabold [font-variant-numeric:tabular-nums] ${
            isMint
              ? 'text-[#0f9d68] dark:text-[#34d399]'
              : 'text-[#1f2329] dark:text-[#f4f5f8]'
          }`}
        >
          {isMint ? '+' : '-'}
          {data.amountDisplay} {data.symbol}
        </span>
      </div>

      <div
        className={`mt-[8px] divide-y divide-slate-900/[0.06] dark:divide-white/[0.06] ${TK_INSET_BOX} [font-variant-numeric:tabular-nums]`}
      >
        {isMint ? (
          data.supplyProgressText ? (
            <div className="flex items-center justify-between pb-[5px] text-[11.5px]">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Mint Progress', '铸造进度')}
              </span>
              <span className="font-semibold">{data.supplyProgressText}</span>
            </div>
          ) : null
        ) : (data.receiverLabel || shortReceiver) ? (
          <div className="flex items-center justify-between gap-2 pb-[5px] text-[11.5px]">
            <span className="shrink-0 text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Recipient', '接收地址')}
            </span>
            <span className="truncate font-mono font-semibold">
              {data.receiverLabel ? `${data.receiverLabel} ` : ''}
              {shortReceiver ? `(${shortReceiver})` : ''}
            </span>
          </div>
        ) : null}

        {(data.feeLabel || data.costPerUnitLabel) && (
          <div className="flex items-center justify-between gap-2 py-[5px] text-[11.5px]">
            <span className="shrink-0 text-[#5b6472] dark:text-[#9aa3b2]">
              {isMint ? ct('Mint Cost', '铸造成本') : ct('Network Fee', '网络矿工费')}
            </span>
            <span className="truncate font-mono font-semibold">
              {data.costPerUnitLabel || data.feeLabel}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-[5px] text-[11.5px]">
          <span className="shrink-0 text-[#5b6472] dark:text-[#9aa3b2]">
            {ct('On-chain TxID', '链上 TxID')}
          </span>
          <CopyShortHashButton value={data.txid} />
        </div>
      </div>
    </div>
  );
};

export default FtActionCard;
