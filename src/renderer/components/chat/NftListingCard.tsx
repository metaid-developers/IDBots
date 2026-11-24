import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ct, formatCnyDisplay, formatMeDisplay, getCommerceLocale } from '../commerce/commerceTradeI18n';
import { dispatchCommerceIntent } from '../commerce/commerceTradeEvents';
import PromoAmmoPackModal from '../commerce/PromoAmmoPackModal';
import {
   sanitizeOpenPromoPack,
   SanitizeFailure,
   type OpenPromoPackParams,
} from '../commerce/commerceBridgeContract';
import type { NftListingCardData } from './nftSuiteSyntax';
import {
  CopyShortHashButton,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_COMPACT_SHELL,
  TK_CARD_SHELL,
  TK_CHIP_BTN,
  TK_INSET_BOX,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';
import { NftProtocolBadge, NftSuiteThumb, NftVerifiedPill } from './nftSuiteUi';
import { formatNftPrice } from './NftCard';

export interface NftListingCardProps {
  data: NftListingCardData;
  className?: string;
}

export const NftListingCard: React.FC<NftListingCardProps> = ({ data, className = '' }) => {
  const [promoOpen, setPromoOpen] = useState(false);
  const serial = data.tokenIndex || (data.number != null ? String(data.number) : null);
  const title = data.name || `${ct('Digital Item', '数字商品')}${serial ? ` #${serial}` : ''}`;
  const isDelisted = data.status === 'delisted';

  const promoParams = useMemo<OpenPromoPackParams | null>(() => {
    if (!data.sellerGlobalMetaId) return null;
    const candidate = sanitizeOpenPromoPack({
      shopOwnerGlobalMetaId: data.sellerGlobalMetaId,
      shopOwnerName: data.sellerName || '',
      shopMetaAppPinId: data.shopMetaAppPinId,
      featuredItems: data.pinId
        ? [
            {
              itemPinId: data.pinId,
              itemName: title,
              coverUrl: data.imgUrl || data.icon,
              priceMeMilli: data.priceMeMilli,
              priceCnyCents: data.priceCnyCents,
            },
          ]
        : [],
    });
    return candidate instanceof SanitizeFailure ? null : candidate;
  }, [
    data.sellerGlobalMetaId,
    data.sellerName,
    data.shopMetaAppPinId,
    data.pinId,
    title,
    data.imgUrl,
    data.icon,
    data.priceMeMilli,
    data.priceCnyCents,
  ]);

  if (isDelisted) {
    return (
      <div
        data-nft-listing-card="true"
        data-nft-listing-status="delisted"
        className={`${TK_CARD_COMPACT_SHELL} ${className}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <NftSuiteThumb
              name={title}
              serial={serial}
              format={data.format}
              icon={data.icon}
              imgUrl={data.imgUrl}
              size="sm"
              showSerialBadge
              dimmed
            />
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                {ct('Listing Cancelled', '挂单已撤销下架')} · {title}
              </div>
              <div className="mt-0.5 text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Collectible returned to wallet', '藏品已解除挂牌，安全留存本地钱包')}
              </div>
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-slate-900/[0.09] bg-[#f2f4f7] px-2.5 py-0.5 text-[10.5px] font-bold text-[#5b6472] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#9aa3b2]">
            {ct('Delisted', '已下架')}
          </span>
        </div>

        {(data.txId || data.intentPinId || data.pinId) && (
          <div className={`mt-2.5 flex items-center justify-between text-[11.5px] ${TK_INSET_BOX}`}>
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">
              {data.txId ? 'TxID' : 'Pin'}
            </span>
            <CopyShortHashButton value={(data.txId || data.intentPinId || data.pinId)!} />
          </div>
        )}

        <div className="mt-2 flex items-center justify-end">
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Re-list ${title} (${data.pinId || ''}) with a new ME price.`,
                  `帮我重新为 ${title}（${data.pinId || ''}）定价并挂牌上架。`,
                ),
              )
            }
            className={TK_CHIP_BTN}
          >
            {ct('✦ Re-list Item', '✦ 重新定价挂牌')}
          </button>
        </div>
      </div>
    );
  }

  const primaryAskDisplay =
    data.priceMeMilli != null && data.priceMeMilli > 0
      ? formatMeDisplay(data.priceMeMilli)
      : data.priceTokens && data.priceTokens.length > 0
        ? `${data.priceTokens[0].amountDisplay} $${data.priceTokens[0].symbol}`
        : formatNftPrice(data.priceSats)?.split(' · ')[0] || ct('Listed', '已挂牌');

  const secondaryCny =
    data.priceCnyCents != null && data.priceCnyCents > 0
      ? formatCnyDisplay(data.priceCnyCents)
      : null;

  const tokenPrices = data.priceTokens ?? [];

  return (
    <>
      <div
        data-nft-listing-card="true"
        data-nft-listing-status="active"
        data-nft-listing-rail={data.rail}
        className={`${TK_CARD_SHELL} ${className}`}
      >
        {/* Header: 68px thumb + Name + Protocol + Active Rail Status */}
        <div className="flex items-center gap-3">
          <NftSuiteThumb
            name={title}
            serial={serial}
            format={data.format}
            icon={data.icon}
            imgUrl={data.imgUrl}
            size="lg"
            showSerialBadge
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-bold tracking-[-0.01em] text-[#1f2329] dark:text-[#f4f5f8]">
              {title}
            </div>
            {data.series && (
              <div className="mt-0.5 truncate text-[11.5px] text-[#5b6472] dark:text-[#9aa3b2]">
                {data.series}
              </div>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <NftVerifiedPill caVerified={data.caVerified} />
              <NftProtocolBadge format={data.format} compact />
              <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#0f9d68]/25 bg-[#0f9d68]/[0.11] px-[6px] py-[1.5px] text-[10px] font-bold leading-[1.3] text-[#0f9d68] dark:border-[#34d399]/28 dark:bg-[#34d399]/[0.13] dark:text-[#34d399]">
                {data.rail === 'onchain-sell' || data.rail === 'mvc-contract'
                  ? ct('● MVC Contract Order', '● 链上合约挂单')
                  : ct('✦ Multi-Rail Live', '✦ 多轨挂牌生效中')}
              </span>
            </div>
          </div>
        </div>

        {/* Hero Ask Box */}
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-[11px] border border-[#b48a00]/20 bg-[#ffdc51]/[0.1] px-[11px] py-[9px] dark:border-[#ffdc51]/20 dark:bg-[#ffdc51]/[0.07]">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold text-[#8a94a6]">
              {data.rail === 'onchain-sell' || data.rail === 'mvc-contract'
                ? ct('On-Chain Ask Price', '链上合约一口价')
                : ct('ME Escrow Ask Price', 'ME 担保一口价')}
            </div>
            <div className="mt-0.5 truncate text-[18px] font-extrabold leading-tight tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
              {primaryAskDisplay}
            </div>
            {secondaryCny && (
              <div className="mt-0.5 text-[11px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
                ≈ {secondaryCny}
              </div>
            )}
          </div>
          <div className="text-right">
            <span className="inline-flex items-center rounded-full bg-[#0f9d68]/15 px-2 py-0.5 text-[10.5px] font-bold text-[#0f9d68] dark:bg-[#34d399]/18 dark:text-[#34d399]">
              {data.autoFulfill === false
                ? ct('On-chain Atomic', '合约原子交割')
                : ct('⚡ Escrow Auto-Settle', '⚡ 担保自动交割')}
            </span>
            {data.floorPriceMeMilli != null && data.floorPriceMeMilli > 0 && (
              <div className="mt-1 text-[10.5px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Floor:', '地板参考:')} {formatMeDisplay(data.floorPriceMeMilli)}
              </div>
            )}
          </div>
        </div>

        {/* Vertical Ledger Rows */}
        <div className={`mt-2 flex flex-col gap-1.5 text-[11.5px] ${TK_INSET_BOX}`}>
          {tokenPrices.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Token Direct Rail', '同时支持代币直付')}
              </span>
              <span className="truncate font-bold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
                {tokenPrices.map((t) => `${t.amountDisplay} $${t.symbol}`).join(' / ')}
              </span>
            </div>
          )}
          {(data.intentPinId || data.txId || data.pinId) && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                {data.intentPinId
                  ? ct('Intent Pin', '挂牌声明 Pin')
                  : data.txId
                    ? 'TxID'
                    : ct('Item Pin', '藏品 Pin')}
              </span>
              <CopyShortHashButton value={(data.intentPinId || data.txId || data.pinId)!} />
            </div>
          )}
        </div>

        {/* Primary Promotion & Shop CTAs */}
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Publish a MetaWeb Buzz announcing my listed collectible ${title} (${primaryAskDisplay}).`,
                  `帮我发一条广场动态（Buzz），推广我刚上架的数字藏品 ${title}（售价 ${primaryAskDisplay}）。`,
                ),
              )
            }
            className={TK_BTN_PRIMARY}
          >
            {ct('✦ Post Buzz Promo', '✦ 发动态推销')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (data.shopMetaAppPinId) {
                dispatchCommerceIntent({
                  type: 'visit_shop',
                  shopMetaAppPinId: data.shopMetaAppPinId,
                  sellerGlobalMetaId: data.sellerGlobalMetaId,
                  sellerName: data.sellerName,
                });
              } else {
                dispatchSuiteComposerDraft(
                  ct(
                    `Publish or update my Personal Goods Shop MetaApp featuring ${title}.`,
                    `帮我开通或更新我的个人数字小店（Personal Goods Shop），把 ${title} 摆上橱窗。`,
                  ),
                );
              }
            }}
            className={TK_BTN_SECONDARY}
          >
            {ct('🏪 Personal Shop', '🏪 个人小店')}
          </button>
        </div>

        {/* Management Chips: Promo Ammo Pack, Reprice, Cancel */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-nft-listing-action="promo-pack"
            onClick={() => {
              if (promoParams) {
                setPromoOpen(true);
              } else {
                dispatchSuiteComposerDraft(
                  ct(
                    `Generate compliant promo copy for my listed collectible ${title}.`,
                    `帮我为在售数字藏品 ${title} 生成合规推广文案与小店分享介绍。`,
                  ),
                );
              }
            }}
            className={TK_CHIP_BTN}
          >
            {ct('🎁 Promo Pack', '🎁 领分销弹药包')}
          </button>
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Update listing price for ${title} (${data.pinId || ''}) to: `,
                  `帮我修改数字藏品 ${title}（${data.pinId || ''}）的挂牌价格为：`,
                ),
              )
            }
            className={TK_CHIP_BTN}
          >
            {ct('Reprice', '改价')}
          </button>
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Cancel my active listing for ${title} (${data.intentPinId || data.pinId || ''}).`,
                  `帮我撤销下架数字藏品 ${title}（${data.intentPinId || data.pinId || ''}）的挂单。`,
                ),
              )
            }
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-rose-500/25 bg-rose-500/[0.08] px-[9px] py-[4.5px] text-[11px] font-semibold text-rose-600 transition hover:bg-rose-500/[0.15] dark:text-rose-400"
          >
            {ct('Delist', '撤单下架')}
          </button>
        </div>
      </div>

      {promoOpen && promoParams && typeof document !== 'undefined' &&
        createPortal(
          <PromoAmmoPackModal
            params={promoParams}
            lang={getCommerceLocale()}
            onClose={() => setPromoOpen(false)}
          />,
          document.body,
        )}
    </>
  );
};

export default NftListingCard;
