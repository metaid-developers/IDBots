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
import type { NftMyListingsCardData } from './nftSuiteSyntax';
import {
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_INSET_BOX,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';
import { NftSuiteThumb } from './nftSuiteUi';
import { formatNftPrice } from './NftCard';

export interface NftMyListingsCardProps {
  data: NftMyListingsCardData;
  className?: string;
}

export const NftMyListingsCard: React.FC<NftMyListingsCardProps> = ({ data, className = '' }) => {
  const [promoOpen, setPromoOpen] = useState(false);
  const items = data.listings ?? data.items ?? [];

  const computedTotalMeMilli = useMemo(() => {
    if (data.totalMeMilli != null) return data.totalMeMilli;
    let sum = 0;
    for (const item of items) {
      if (item.priceMeMilli != null && item.priceMeMilli > 0) sum += item.priceMeMilli;
    }
    return sum;
  }, [data.totalMeMilli, items]);

  const promoParams = useMemo<OpenPromoPackParams | null>(() => {
    if (!data.sellerGlobalMetaId) return null;
    const featured = items
      .filter((it) => Boolean(it.pinId))
      .slice(0, 3)
      .map((it) => ({
        itemPinId: it.pinId!,
        itemName: it.name || ct('Digital Item', '数字商品'),
        coverUrl: it.imgUrl || it.icon,
        priceMeMilli: it.priceMeMilli,
        priceCnyCents: it.priceCnyCents,
      }));
    const candidate = sanitizeOpenPromoPack({
      shopOwnerGlobalMetaId: data.sellerGlobalMetaId,
      shopOwnerName: data.sellerName || '',
      shopMetaAppPinId: data.shopMetaAppPinId,
      featuredItems: featured,
    });
    return candidate instanceof SanitizeFailure ? null : candidate;
  }, [data.sellerGlobalMetaId, data.sellerName, data.shopMetaAppPinId, items]);

  if (items.length === 0) {
    return (
      <div
        data-nft-my-listings-card="true"
        data-nft-listings-count="0"
        className={`${TK_CARD_SHELL} ${className}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[14.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
              {ct('My Active NFT Listings', '我的在售数字商品')}
            </div>
            <div className="mt-0.5 text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('No active sell orders or intents', '当前暂无生效中的数字藏品挂单')}
            </div>
          </div>
          <span className="rounded-full bg-[#f2f4f7] px-2.5 py-0.5 text-[10.5px] font-semibold text-[#5b6472] dark:bg-white/[0.06] dark:text-[#9aa3b2]">
            0
          </span>
        </div>

        <div className={`mt-2.5 text-center text-[11.5px] text-[#5b6472] dark:text-[#9aa3b2] ${TK_INSET_BOX}`}>
          {ct(
            'List idle MRC-721 collectibles and your AI twin will auto-fulfill 24/7.',
            '挑选闲置数字藏品上架后，AI 分身将 24 小时自动接单交割。',
          )}
        </div>

        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  'Check my NFT portfolio and help me pick collectibles to list for sale.',
                  '查看我的数字藏品持仓，帮我挑几件闲置藏品挂牌出售。',
                ),
              )
            }
            className={TK_BTN_PRIMARY}
          >
            {ct('✦ Pick Collectibles to List', '✦ 去藏品库挑一件挂牌')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        data-nft-my-listings-card="true"
        data-nft-listings-count={String(items.length)}
        className={`${TK_CARD_SHELL} ${className}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[14.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                {ct('My Active Listings', '我的在售数字商品')}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#0f9d68]/12 px-2 py-0.5 text-[10px] font-bold text-[#0f9d68] dark:bg-[#34d399]/15 dark:text-[#34d399]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" />
                {ct(`AI Live (${items.length})`, `AI 值守 (${items.length})`)}
              </span>
            </div>
            {computedTotalMeMilli > 0 && (
              <div className="mt-0.5 text-[11px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Total Ask:', '在售总标价:')}{' '}
                <span className="font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                  {formatMeDisplay(computedTotalMeMilli)}
                </span>
                {data.totalCnyCents != null && data.totalCnyCents > 0 && (
                  <span> · ≈ {formatCnyDisplay(data.totalCnyCents)}</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Ticket Stack */}
        <div className="mt-2.5 flex flex-col gap-1.5">
          {items.slice(0, 8).map((item, idx) => {
            const serial = item.tokenIndex || (item.number != null ? String(item.number) : null);
            const title = item.name || `${ct('Item', '藏品')}${serial ? ` #${serial}` : ''}`;
            const askLabel =
              item.priceMeMilli != null && item.priceMeMilli > 0
                ? formatMeDisplay(item.priceMeMilli)
                : item.priceTokens && item.priceTokens.length > 0
                  ? `${item.priceTokens[0].amountDisplay} $${item.priceTokens[0].symbol}`
                  : formatNftPrice(item.priceSats)?.split(' · ')[0] || ct('Listed', '在售');

            const extraTokens =
              item.priceMeMilli != null &&
              item.priceMeMilli > 0 &&
              item.priceTokens &&
              item.priceTokens.length > 0
                ? ` / ${item.priceTokens[0].amountDisplay} $${item.priceTokens[0].symbol}`
                : '';

            return (
              <div
                key={item.intentPinId || item.pinId || item.txId || `listing-${idx}`}
                className={`flex items-center gap-2.5 ${TK_INSET_BOX}`}
              >
                <NftSuiteThumb
                  name={title}
                  serial={serial}
                  format={item.format}
                  icon={item.icon}
                  imgUrl={item.imgUrl}
                  size="sm"
                  showSerialBadge
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-[12.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                      {title}
                    </span>
                    <span className="shrink-0 rounded-[5px] bg-slate-900/[0.06] px-1.5 py-px text-[9.5px] font-semibold text-[#5b6472] dark:bg-white/[0.08] dark:text-[#9aa3b2]">
                      {item.rail === 'onchain-sell' || item.rail === 'mvc-contract' ? ct('Chain', '链上') : ct('Intent', '秒发')}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] font-bold tabular-nums text-[#9a7300] dark:text-[#ffdc51]">
                    {askLabel}
                    {extraTokens && (
                      <span className="font-medium text-[#5b6472] dark:text-[#9aa3b2]">
                        {extraTokens}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      dispatchSuiteComposerDraft(
                        ct(
                          `Reprice my listing ${title} (${item.pinId || ''}) to: `,
                          `把我的在售藏品 ${title}（${item.pinId || ''}）改价为：`,
                        ),
                      )
                    }
                    className="rounded-[8px] border border-slate-900/[0.09] bg-white px-2 py-1 text-[10.5px] font-semibold text-[#1f2329] transition hover:bg-[#e8ecf2] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#f4f5f8]"
                  >
                    {ct('Edit', '改价')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      dispatchSuiteComposerDraft(
                        ct(
                          `Cancel my listing for ${title} (${item.intentPinId || item.pinId || ''}).`,
                          `撤销下架我的在售藏品 ${title}（${item.intentPinId || item.pinId || ''}）。`,
                        ),
                      )
                    }
                    className="rounded-[8px] border border-rose-500/25 bg-rose-500/[0.08] px-2 py-1 text-[10.5px] font-semibold text-rose-600 transition hover:bg-rose-500/[0.15] dark:text-rose-400"
                  >
                    {ct('Delist', '下架')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Shop & Promo Ammo Pack CTAs */}
        <div className="mt-2.5 flex items-center gap-1.5">
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
                    'Publish or open my Personal Goods Shop MetaApp with all my active listings.',
                    '帮我打开或发布我的个人数字小店（Personal Goods Shop），同步全部在售商品。',
                  ),
                );
              }
            }}
            className={TK_BTN_PRIMARY}
          >
            {data.shopMetaAppPinId
              ? ct('🏪 Open My Personal Shop', '🏪 打开个人小店')
              : ct('🏪 Publish Personal Shop', '🏪 一键开个人小店')}
          </button>
          <button
            type="button"
            data-nft-mylistings-action="promo-pack"
            onClick={() => {
              if (promoParams) {
                setPromoOpen(true);
              } else {
                dispatchSuiteComposerDraft(
                  ct(
                    'Prepare promo pack posters and compliant share templates for my shop.',
                    '帮我生成个人小店的分销推广文案与分享卡片。',
                  ),
                );
              }
            }}
            className={TK_BTN_SECONDARY}
          >
            {ct('🎁 Promo Pack', '🎁 分销弹药包')}
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

export default NftMyListingsCard;
