import React from 'react';
import { ct, formatCnyDisplay, formatMeDisplay } from '../commerce/commerceTradeI18n';
import { dispatchCommerceIntent } from '../commerce/commerceTradeEvents';
import { shortAddress } from './nftCardIdentity';
import type { NftFillCardData } from './nftSuiteSyntax';
import {
  CopyShortHashButton,
  TK_BENTO_CELL,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_CHIP_BTN,
  TK_INSET_BOX,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';
import { NftProtocolBadge, NftSuiteThumb, NftVerifiedPill } from './nftSuiteUi';
import { formatNftPrice } from './NftCard';

export interface NftFillCardProps {
  data: NftFillCardData;
  className?: string;
}

export const NftFillCard: React.FC<NftFillCardProps> = ({ data, className = '' }) => {
  const serial = data.tokenIndex || (data.number != null ? String(data.number) : null);
  const itemTitle = data.name || `${ct('Digital Item', '数字商品')}${serial ? ` #${serial}` : ''}`;
  const isSeller = data.side === 'sold';
  const isTokenSwap = data.side === 'token_bought' || data.rail === 'token-for-goods';

  const paymentHeadline =
    data.tokenSymbol && data.tokenAmountDisplay
      ? `${data.tokenAmountDisplay} $${data.tokenSymbol}`
      : data.priceMeMilli != null && data.priceMeMilli > 0
        ? formatMeDisplay(data.priceMeMilli)
        : formatNftPrice(data.priceSats)?.split(' · ')[0] || ct('Settled', '已结算');

  const paymentSub =
    data.priceCnyCents != null && data.priceCnyCents > 0
      ? `≈ ${formatCnyDisplay(data.priceCnyCents)}`
      : isTokenSwap
        ? ct('Direct Token Settlement', '链上代币验资直付')
        : ct('ME Escrow Released', 'ME 担保自动放款');

  const headline = isSeller
    ? ct('NFT Auto-Sold!', 'NFT 已自动售出！')
    : isTokenSwap
      ? ct('Token-for-Goods Settled!', '代币换物交割成功！')
      : ct('Purchase Settled!', '买入交割完成！');

  const subStatus = isSeller
    ? ct('⚡ Escrow Auto-Fulfilled · Proceeds Credited', '⚡ 链上担保自动交割 · 收益已入账')
    : ct('✦ Delivered to Your Wallet', '✦ 链上交割完成 · 已转入钱包');

  const counterpartyDisplay =
    data.counterpartyName ||
    (data.counterpartyAddress ? shortAddress(data.counterpartyAddress) : null) ||
    (data.counterpartyGlobalMetaId ? `${data.counterpartyGlobalMetaId.slice(0, 10)}…` : null);

  return (
    <div
      data-nft-fill-card="true"
      data-nft-fill-side={data.side}
      className={`${TK_CARD_SHELL} ${className}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <NftSuiteThumb
          name={itemTitle}
          serial={serial}
          format={data.format}
          icon={data.icon}
          imgUrl={data.imgUrl}
          size="md"
          showSerialBadge
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-extrabold tracking-[-0.01em] text-[#1f2329] dark:text-[#f4f5f8]">
            🎉 {headline}
          </div>
          <div className="mt-0.5 truncate text-[11px] font-semibold text-[#0f9d68] dark:text-[#34d399]">
            {subStatus}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <NftVerifiedPill caVerified={data.caVerified} />
            <NftProtocolBadge format={data.format} compact />
          </div>
        </div>
      </div>

      {/* Dual-Flow Left -> Right Settlement Boxes */}
      <div className="mt-2.5 grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
        <div className={TK_BENTO_CELL}>
          <div className="text-[10px] font-medium text-[#8a94a6]">
            {isSeller ? ct('Delivered Item', '发出藏品') : ct('You Paid', '支出对价')}
          </div>
          <div className="mt-0.5 truncate text-[13.5px] font-bold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
            {isSeller ? itemTitle : `-${paymentHeadline}`}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-[#5b6472] dark:text-[#9aa3b2]">
            {isSeller ? data.series || 'MRC-721' : paymentSub}
          </div>
        </div>

        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0f9d68]/12 text-[11px] font-bold text-[#0f9d68] dark:bg-[#34d399]/15 dark:text-[#34d399]">
          →
        </div>

        <div className="min-w-0 rounded-[10px] border border-[#0f9d68]/25 bg-[#0f9d68]/[0.08] px-[10px] py-[8px] dark:border-[#34d399]/25 dark:bg-[#34d399]/[0.1]">
          <div className="text-[10px] font-semibold text-[#0f9d68] dark:text-[#34d399]">
            {isSeller ? ct('Proceeds Credited', '到账收益') : ct('Received Item', '收到藏品')}
          </div>
          <div className="mt-0.5 truncate text-[14px] font-extrabold tabular-nums text-[#0f9d68] dark:text-[#34d399]">
            {isSeller ? `+${paymentHeadline}` : itemTitle}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-[#0f9d68]/80 dark:text-[#34d399]/80">
            {isSeller ? paymentSub : data.series || ct('In Wallet', '已入库')}
          </div>
        </div>
      </div>

      {/* Ledger */}
      <div className={`mt-2 flex flex-col gap-1.5 text-[11.5px] ${TK_INSET_BOX}`}>
        {counterpartyDisplay && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">
              {isSeller ? ct('Buyer', '成交买家') : ct('Seller', '成交卖家')}
            </span>
            <span className="truncate font-semibold text-[#1f2329] dark:text-[#f4f5f8]">
              {counterpartyDisplay}
            </span>
          </div>
        )}
        {data.pinId && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Item Pin', '藏品 Pin')}
            </span>
            <CopyShortHashButton value={data.pinId} />
          </div>
        )}
        {(data.txId || data.paymentTxId) && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Settlement Tx', '交割凭证 Tx')}
            </span>
            <CopyShortHashButton value={(data.txId || data.paymentTxId)!} />
          </div>
        )}
      </div>

      {/* Role-Specific Actions */}
      {isSeller ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    'Show my remaining MRC-721 collectibles so I can pick another item to list.',
                    '看看我钱包里还有哪些闲置数字藏品可以继续补货挂牌。',
                  ),
                )
              }
              className={TK_BTN_PRIMARY}
            >
              {ct('✦ Restock & List More', '✦ 继续挑藏品补货上架')}
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    'Check my current ME points and wallet token balances.',
                    '查看我当前的 ME 积分与钱包收益余额明细。',
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('Check Balance', '查看收益')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            {data.pinId && data.format === 'mrc721' ? (
              <button
                type="button"
                onClick={() =>
                  dispatchSuiteComposerDraft(
                    ct(
                      `Set my newly purchased collectible ${itemTitle} (nft://mrc721/${data.pinId}) as my verified on-chain avatar.`,
                      `把我刚买到的数字藏品 ${itemTitle}（nft://mrc721/${data.pinId}）设为我的链上认证头像。`,
                    ),
                  )
                }
                className={TK_BTN_PRIMARY}
              >
                {ct('✦ Set Verified Avatar', '✦ 设为链上认证头像')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  dispatchSuiteComposerDraft(
                    ct('Show my updated NFT portfolio.', '查看我最新的数字藏品持仓。'),
                  )
                }
                className={TK_BTN_PRIMARY}
              >
                {ct('✦ View Portfolio', '✦ 查看藏品库')}
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Re-list ${itemTitle} (${data.pinId || ''}) for sale at a new ME price: `,
                    `帮我把刚入手的 ${itemTitle}（${data.pinId || ''}）重新定价挂牌出售：`,
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('Relist', '一键转售')}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {data.shopMetaAppPinId && (
              <button
                type="button"
                onClick={() =>
                  dispatchCommerceIntent({
                    type: 'visit_shop',
                    shopMetaAppPinId: data.shopMetaAppPinId!,
                    sellerGlobalMetaId: data.counterpartyGlobalMetaId,
                    sellerName: data.counterpartyName,
                  })
                }
                className={TK_CHIP_BTN}
              >
                {ct('🏪 Seller Shop', '🏪 逛卖家小店')}
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Post a Buzz sharing my new digital collectible ${itemTitle}!`,
                    `发条动态晒一晒我刚收藏的数字藏品 ${itemTitle}！`,
                  ),
                )
              }
              className={TK_CHIP_BTN}
            >
              {ct('Share on Buzz', '晒单发动态')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default NftFillCard;
