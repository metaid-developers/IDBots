import React from 'react';
import { ct, formatCnyDisplay, formatMeDisplay } from '../commerce/commerceTradeI18n';
import { shortAddress } from './nftCardIdentity';
import type { NftPortfolioCardData } from './nftSuiteSyntax';
import {
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_INSET_BOX,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';
import { NftFanStack, NftProtocolBadge } from './nftSuiteUi';

export interface NftPortfolioCardProps {
  data: NftPortfolioCardData;
  className?: string;
}

export const NftPortfolioCard: React.FC<NftPortfolioCardProps> = ({ data, className = '' }) => {
  const mrc721Collections = data.mrc721Collections ?? [];
  const legacyCollections = data.legacyCollections ?? data.legacySeries ?? [];
  const previewItems = data.previewItems ?? data.mrc721Previews ?? [];

  const mrc721Count =
    data.mrc721Count ??
    mrc721Collections.reduce((acc, item) => acc + item.count, 0);
  const legacyCount =
    data.legacyCount ??
    legacyCollections.reduce((acc, item) => acc + item.count, 0);
  const totalCount = data.totalCount ?? mrc721Count + legacyCount;

  const ownerDisplay =
    data.ownerName ||
    (data.ownerAddress ? shortAddress(data.ownerAddress) : null) ||
    (data.ownerGlobalMetaId ? `${data.ownerGlobalMetaId.slice(0, 10)}…` : null);

  const mrc721Previews = previewItems.filter((p) => p.format !== 'metacontract');

  return (
    <div
      data-nft-portfolio-card="true"
      data-nft-portfolio-third-party={data.isThirdParty ? 'true' : 'false'}
      className={`${TK_CARD_SHELL} ${className}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
              {data.isThirdParty
                ? ct('Holder NFT Portfolio', '数字藏品持仓透视')
                : ct('My NFT Portfolio', '我的数字藏品资产')}
            </span>
            {ownerDisplay && (
              <span className="truncate rounded-full bg-[#f2f4f7] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#5b6472] dark:bg-white/[0.07] dark:text-[#9aa3b2]">
                {ownerDisplay}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
            {ct(`${totalCount} items total`, `共持有 ${totalCount} 件藏品`)}
            {data.estimatedFloorMeMilli != null && data.estimatedFloorMeMilli > 0 && (
              <>
                {' · '}
                {ct('Floor Est.', '地板总估值')}{' '}
                <span className="font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                  {formatMeDisplay(data.estimatedFloorMeMilli)}
                </span>
              </>
            )}
            {data.estimatedFloorCnyCents != null && data.estimatedFloorCnyCents > 0 && (
              <span> ({formatCnyDisplay(data.estimatedFloorCnyCents)})</span>
            )}
          </div>
        </div>
      </div>

      {/* Upper Compartment: MVC · MRC-721 Modern Digital Goods */}
      <div className={`mt-2.5 ${TK_INSET_BOX}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <NftProtocolBadge format="mrc721" />
            <span className="text-[11.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
              {ct('Digital Goods', '新版数字商品')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mrc721Previews.length > 0 && (
              <NftFanStack items={mrc721Previews} totalCount={mrc721Count} />
            )}
            <span className="font-mono text-[12.5px] font-extrabold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
              {mrc721Count}
            </span>
          </div>
        </div>

        {mrc721Collections.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1 border-t border-slate-900/[0.06] pt-2 dark:border-white/[0.07]">
            {mrc721Collections.slice(0, 5).map((col, idx) => (
              <div
                key={col.collectionId || `${col.name}-${idx}`}
                className="flex items-center justify-between gap-2 text-[11.5px]"
              >
                <div className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-semibold text-[#1f2329] dark:text-[#f4f5f8]">
                    {col.name}
                  </span>
                  {col.caVerified && (
                    <span className="shrink-0 text-[10px] font-bold text-[#0f9d68] dark:text-[#34d399]">
                      ✓
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 tabular-nums">
                  {col.floorPriceMeMilli != null && col.floorPriceMeMilli > 0 && (
                    <span className="text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
                      {ct('Floor', '地板')} {formatMeDisplay(col.floorPriceMeMilli)}
                    </span>
                  )}
                  <span className="font-mono font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                    ×{col.count}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] text-[#8a94a6]">
            {ct('No MRC-721 items in this wallet yet', '当前暂无 MRC-721 新版数字商品')}
          </div>
        )}
      </div>

      {/* Lower Compartment: Legacy MetaContract NFTs (when present) */}
      {legacyCount > 0 && (
        <div
          data-nft-portfolio-legacy="true"
          className="mt-2 rounded-[11px] border border-amber-500/30 bg-amber-500/[0.08] px-[10px] py-[8px] dark:border-amber-400/30 dark:bg-amber-400/[0.08]"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <NftProtocolBadge format="metacontract" compact />
              <span className="text-[11.5px] font-bold text-[#92400e] dark:text-[#fbbf24]">
                {ct('Legacy Collectibles', '旧版协议藏品')}
              </span>
              {!data.isThirdParty && (
                <span className="rounded-[5px] bg-amber-500/20 px-1.5 py-px text-[9.5px] font-bold text-[#92400e] dark:text-[#fde68a]">
                  {ct('Free 1:1 Upgrade', '可免费 1:1 升级')}
                </span>
              )}
            </div>
            <span className="font-mono text-[12.5px] font-extrabold tabular-nums text-[#92400e] dark:text-[#fbbf24]">
              {legacyCount}
            </span>
          </div>

          {legacyCollections.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1 border-t border-amber-500/15 pt-1.5 text-[11px]">
              {legacyCollections.slice(0, 4).map((col, idx) => (
                <div
                  key={col.genesis || `${col.name}-${idx}`}
                  className="flex items-center justify-between gap-2 text-[#78350f] dark:text-[#fde68a]"
                >
                  <span className="truncate font-medium">{col.name}</span>
                  <span className="font-mono font-bold tabular-nums">×{col.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="mt-2.5 flex items-center gap-1.5">
        {data.isThirdParty ? (
          <>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Send an inquiry to holder ${ownerDisplay || data.ownerGlobalMetaId || data.ownerAddress || ''} about purchasing one of their MRC-721 collectibles.`,
                    `帮我向持有人 ${ownerDisplay || data.ownerGlobalMetaId || data.ownerAddress || ''} 发起藏品求购询价。`,
                  ),
                )
              }
              className={TK_BTN_PRIMARY}
            >
              {ct('💬 Inquire to Buy', '💬 向持有人求购询价')}
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Check if ${ownerDisplay || data.ownerAddress || 'this holder'} has any active listings.`,
                    `查看 ${ownerDisplay || data.ownerAddress || '该持有人'} 当前是否有在售挂单。`,
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('Active Asks', '在售挂单')}
            </button>
          </>
        ) : legacyCount > 0 ? (
          <>
            <button
              type="button"
              data-nft-portfolio-action="upgrade"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    'Discover official swap stations and upgrade my legacy MetaContract NFTs 1:1 to MRC-721 for free.',
                    '帮我检索官方认证兑换站，把我的旧版 MetaContract 藏品一键免费 1:1 升级为新版 MRC-721 数字商品。',
                  ),
                )
              }
              className={TK_BTN_PRIMARY}
            >
              {ct(`✦ Free 1:1 Upgrade (${legacyCount})`, `✦ 一键免费升级旧藏品 (${legacyCount})`)}
            </button>
            {mrc721Count > 0 && (
              <button
                type="button"
                onClick={() =>
                  dispatchSuiteComposerDraft(
                    ct(
                      'Pick one of my MRC-721 items and list it for ME points sale.',
                      '从我的新版 MRC-721 藏品中挑一件挂牌出售。',
                    ),
                  )
                }
                className={TK_BTN_SECONDARY}
              >
                {ct('List Item', '挑藏品挂牌')}
              </button>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    'Help me pick an idle MRC-721 collectible and list it for ME points sale.',
                    '帮我从持仓中挑选闲置数字藏品，参考地板价挂牌出售。',
                  ),
                )
              }
              className={TK_BTN_PRIMARY}
            >
              {ct('✦ Pick & List for Sale', '✦ 挑闲置藏品挂牌出售')}
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    'Open or publish my Personal Goods Shop MetaApp.',
                    '打开或开通我的个人数字小店。',
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('🏪 My Shop', '🏪 个人小店')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default NftPortfolioCard;
