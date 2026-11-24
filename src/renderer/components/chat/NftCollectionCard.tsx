/**
 * NftCollectionCard (Variant C2 — Collection Header + 3-Item Floor Showcase)
 *
 * Supports both:
 * 1. Market Summary mode (floor ME/CNY, median ME, listed/holder counts, and up
 *    to 3 representative floor items clickable to buy/inspect).
 * 2. Album Issuance / Update Receipt mode (`issued` / `updated` / `info`, mint
 *    progress bar `3 / 100` or `7 minted · unlimited`, royalty, copyable ID).
 */

import React, { useState } from 'react';
import { CheckIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { shortAddress } from './nftCardIdentity';
import { shortId } from './NftCard';
import type { NftCollectionCardData } from './nftCardSyntax';
import { ct, formatCnyDisplay, formatMeDisplay } from '../commerce/commerceTradeI18n';
import { dispatchCommerceIntent } from '../commerce/commerceTradeEvents';
import {
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_INSET_BOX,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';
import { NftProtocolBadge, NftSuiteThumb, NftVerifiedPill } from './nftSuiteUi';

const ACTION_LABELS: Record<string, string> = {
  issued: 'ISSUED',
  updated: 'UPDATED',
  info: 'COLLECTION',
};

const ACTION_BADGE_CLASS: Record<string, string> = {
  issued: 'bg-[#0f9d68]/15 text-[#0f9d68] dark:text-[#34d399]',
  updated: 'bg-[#0ea5e9]/15 text-[#0369a1] dark:text-[#38bdf8]',
  info: 'bg-amber-500/15 text-[#9a7300] dark:text-[#ffdc51]',
};

/** Mint progress label: "3 / 100", "3 minted · unlimited", "3 minted". */
export const collectionProgressLabel = (data: NftCollectionCardData): string | null => {
  if (data.totalSupply === -1) {
    return data.minted != null ? `${data.minted} minted · unlimited` : 'unlimited';
  }
  if (data.totalSupply != null) {
    return `${data.minted ?? 0} / ${data.totalSupply}`;
  }
  return data.minted != null ? `${data.minted} minted` : null;
};

const CollectionIdCopy: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy collection id"
      title="Copy collection id"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
      className="shrink-0 rounded-[8px] p-0.5 text-[#5b6472] transition-colors hover:bg-black/5 dark:text-[#9aa3b2] dark:hover:bg-white/10"
    >
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5 text-[#0f9d68] dark:text-[#34d399]" />
      ) : (
        <DocumentDuplicateIcon className="h-3.5 w-3.5" />
      )}
    </button>
  );
};

const NftCollectionCard: React.FC<{ data: NftCollectionCardData; className?: string }> = ({
  data,
  className = '',
}) => {
  const progress = collectionProgressLabel(data);
  const action = data.action && ACTION_LABELS[data.action] ? data.action : 'info';
  const badgeClass = ACTION_BADGE_CLASS[action] ?? ACTION_BADGE_CLASS.info;
  const royalty = data.royaltyRate != null ? `${data.royaltyRate}% royalty` : null;
  const title = data.name || data.collectionName || 'Collection';

  const previewItems = data.previewItems ?? [];
  const hasMarketSummary =
    data.floorPriceMeMilli != null ||
    data.listedCount != null ||
    previewItems.length > 0;

  const progressPct =
    data.totalSupply && data.totalSupply > 0 && data.minted != null
      ? Math.min(100, Math.round((data.minted / data.totalSupply) * 100))
      : null;

  return (
    <div
      data-nft-collection-card="true"
      data-nft-collection-id={data.collectionId}
      data-nft-collection-name={data.collectionName}
      title="MRC-721 collection"
      className={`${TK_CARD_SHELL} ${className}`}
    >
      {/* Header: 52px cover thumb + Title + Protocol & Verified badges */}
      <div className="flex items-center gap-[10px]">
        <NftSuiteThumb
          name={title}
          icon={data.icon}
          imgUrl={data.imgUrl}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5" data-nft-collection-row="name">
            <span className="truncate text-[14.5px] font-bold tracking-[-0.01em] text-[#1f2329] dark:text-[#f4f5f8]">
              {title}
            </span>
            {data.collectionName && (
              <span className="shrink-0 font-mono text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
                /{data.collectionName}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1" data-nft-collection-row="meta">
            {action !== 'info' && (
              <span className={`shrink-0 rounded-[6px] px-1.5 py-[1px] text-[9.5px] font-bold tracking-wide ${badgeClass}`}>
                {ACTION_LABELS[action]}
              </span>
            )}
            <NftVerifiedPill caVerified={data.caVerified} />
            <NftProtocolBadge format="mrc721" compact />
            {data.listedCount != null && (
              <span className="text-[10.5px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
                · {ct(`${data.listedCount} listed`, `在售 ${data.listedCount}`)}
              </span>
            )}
            {data.holderCount != null && (
              <span className="text-[10.5px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
                · {ct(`${data.holderCount} holders`, `持有者 ${data.holderCount}`)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Market Mode: Hero Floor Price + Median + 3-Item Representative Strip */}
      {hasMarketSummary ? (
        <>
          <div className="mt-2.5 flex items-center justify-between gap-2 rounded-[11px] border border-[#b48a00]/20 bg-[#ffdc51]/[0.1] px-[11px] py-[9px] dark:border-[#ffdc51]/20 dark:bg-[#ffdc51]/[0.07]">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold text-[#8a94a6]">
                {ct('Collection Floor Price', '当前地板价 (最低在售)')}
              </div>
              <div className="mt-0.5 text-[18px] font-extrabold leading-tight tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
                {data.floorPriceMeMilli != null && data.floorPriceMeMilli > 0
                  ? formatMeDisplay(data.floorPriceMeMilli)
                  : ct('No Active Ask', '暂无挂单')}
              </div>
              {data.floorPriceCnyCents != null && data.floorPriceCnyCents > 0 && (
                <div className="mt-0.5 text-[11px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
                  ≈ {formatCnyDisplay(data.floorPriceCnyCents)}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="text-[10px] font-medium text-[#8a94a6]">
                {data.medianPriceMeMilli != null
                  ? ct('Median Ask', '挂牌中位价')
                  : ct('Supply', '铸造规模')}
              </div>
              <div className="mt-0.5 text-[14px] font-bold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
                {data.medianPriceMeMilli != null
                  ? formatMeDisplay(data.medianPriceMeMilli)
                  : progress || '—'}
              </div>
              {data.tradeCount24h != null && (
                <div className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-[#0f9d68] dark:text-[#34d399]">
                  {ct(`24h Vol: ${data.tradeCount24h}`, `24h 成交 ${data.tradeCount24h} 笔`)}
                </div>
              )}
            </div>
          </div>

          {previewItems.length > 0 && (
            <div className="mt-2">
              <div className="mb-1.5 text-[10.5px] font-semibold text-[#8a94a6]">
                {ct('Floor Showcase · Click to Buy', '地板价代表藏品 · 点击即买')}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {previewItems.slice(0, 3).map((item) => {
                  const serialStr =
                    item.tokenIndex || (item.number != null ? String(item.number) : '');
                  return (
                    <button
                      key={item.pinId}
                      type="button"
                      data-collection-preview-pin={item.pinId}
                      onClick={() => {
                        if (item.priceMeMilli != null && item.priceMeMilli > 0) {
                          dispatchCommerceIntent({
                            type: 'buy_with_me',
                            itemPinId: item.pinId,
                            itemName: item.name || `${title}${serialStr ? ` #${serialStr}` : ''}`,
                            series: title,
                            collectionPinId: data.collectionId,
                            priceMeMilli: item.priceMeMilli,
                            priceCnyCents: item.priceCnyCents,
                            sellerAddress: item.sellerAddress,
                            sellerGlobalMetaId: item.sellerGlobalMetaId,
                            sellerName: item.sellerName,
                            shopMetaAppPinId: data.shopMetaAppPinId,
                            icon: item.icon,
                            imgUrl: item.imgUrl,
                          });
                        } else {
                          dispatchSuiteComposerDraft(
                            ct(
                              `Show details for item ${item.pinId} in collection ${title}.`,
                              `查看合集 ${title} 中藏品 ${item.pinId} 的详情。`,
                            ),
                          );
                        }
                      }}
                      className="group flex flex-col overflow-hidden rounded-[10px] border border-slate-900/[0.08] bg-[#f2f4f7] p-1 text-left transition hover:border-[#b48a00]/45 dark:border-white/[0.08] dark:bg-white/[0.045] dark:hover:border-[#ffdc51]/45"
                    >
                      <div className="w-full">
                        <NftSuiteThumb
                          name={item.name || title}
                          serial={serialStr}
                          icon={item.icon}
                          imgUrl={item.imgUrl}
                          size="hero-square"
                          showSerialBadge
                        />
                      </div>
                      <div className="mt-1 flex w-full items-center justify-between gap-1 px-0.5">
                        <span className="truncate font-mono text-[10px] text-[#5b6472] dark:text-[#9aa3b2]">
                          {serialStr ? `#${serialStr}` : item.name || 'Item'}
                        </span>
                        {item.priceMeMilli != null && item.priceMeMilli > 0 && (
                          <span className="shrink-0 text-[10.5px] font-bold tabular-nums text-[#9a7300] dark:text-[#ffdc51]">
                            {formatMeDisplay(item.priceMeMilli)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      ) : (
        /* Album Issuance / Info Mode: Mint Progress & Supply Box */
        (progress || royalty) && (
          <div className={`mt-2.5 ${TK_INSET_BOX}`}>
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Mint Progress', '铸造进度')}
              </span>
              <span className="font-bold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
                {progress || '—'}
              </span>
            </div>
            {progressPct !== null && (
              <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-slate-900/[0.08] dark:bg-white/[0.1]">
                <div
                  style={{ width: `${Math.max(4, progressPct)}%` }}
                  className="h-full rounded-full bg-gradient-to-r from-[#ffdc51] to-[#10b981]"
                />
              </div>
            )}
            {royalty && (
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
                <span>{ct('Creator Royalty', '创作者版税')}</span>
                <span className="font-semibold text-[#1f2329] dark:text-[#f4f5f8]">{royalty}</span>
              </div>
            )}
          </div>
        )
      )}

      {/* Description */}
      {data.desc && (
        <p
          className="mt-2 line-clamp-2 text-[11.5px] leading-snug text-[#5b6472] dark:text-[#9aa3b2]"
          data-nft-collection-row="desc"
        >
          {data.desc}
        </p>
      )}

      {/* Metadata Footer Rows (preserves progress if also present in market mode, collectionId copy, issuer) */}
      <div className="mt-2 flex flex-col gap-1 border-t border-slate-900/[0.06] pt-2 text-[11px] text-[#5b6472] dark:border-white/[0.07] dark:text-[#9aa3b2]">
        {hasMarketSummary && (progress || royalty) && (
          <div className="flex items-center justify-between">
            <span>{ct('Supply', '发行量')}</span>
            <span className="font-semibold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
              {[progress, royalty].filter(Boolean).join(' · ')}
            </span>
          </div>
        )}
        <div className="flex min-w-0 items-center justify-between gap-2" data-nft-collection-row="id">
          <span>Collection Pin</span>
          <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[#1f2329] dark:text-[#f4f5f8]">
            <span className="truncate">{shortId(data.collectionId)}</span>
            <CollectionIdCopy value={data.collectionId} />
          </span>
        </div>
        {(data.issuer || data.issuerLabel) && (
          <div className="flex min-w-0 items-center justify-between gap-2" data-nft-collection-row="issuer">
            <span>Issuer</span>
            <span className="truncate font-medium text-[#1f2329] dark:text-[#f4f5f8]">
              {data.issuerLabel || (data.issuer ? shortAddress(data.issuer) : '')}
            </span>
          </div>
        )}
      </div>

      {/* CTAs */}
      <div className="mt-2.5 flex items-center gap-1.5">
        {hasMarketSummary ? (
          <>
            <button
              type="button"
              onClick={() => {
                const floorItem = previewItems[0];
                if (floorItem && floorItem.priceMeMilli != null && floorItem.priceMeMilli > 0) {
                  dispatchCommerceIntent({
                    type: 'buy_with_me',
                    itemPinId: floorItem.pinId,
                    itemName: floorItem.name || title,
                    series: title,
                    collectionPinId: data.collectionId,
                    priceMeMilli: floorItem.priceMeMilli,
                    priceCnyCents: floorItem.priceCnyCents,
                    sellerAddress: floorItem.sellerAddress,
                    sellerGlobalMetaId: floorItem.sellerGlobalMetaId,
                    sellerName: floorItem.sellerName,
                    shopMetaAppPinId: data.shopMetaAppPinId,
                    icon: floorItem.icon,
                    imgUrl: floorItem.imgUrl,
                  });
                } else {
                  dispatchSuiteComposerDraft(
                    ct(
                      `Search active floor listings in collection ${title} (${data.collectionId}).`,
                      `帮我搜索合集 ${title}（${data.collectionId}）当前的最低价在售藏品。`,
                    ),
                  );
                }
              }}
              className={TK_BTN_PRIMARY}
            >
              {ct('✦ Buy Floor Item', '✦ 按地板价挑一件')}
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Show all active listings in collection ${title} (${data.collectionId}).`,
                    `展示合集 ${title}（${data.collectionId}）的全部在售列表。`,
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('All Listings', '全部在售')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Mint a new MRC-721 item in collection ${title} (${data.collectionId}): `,
                    `在合集 ${title}（${data.collectionId}）下铸造一件新数字藏品：`,
                  ),
                )
              }
              className={TK_BTN_PRIMARY}
            >
              {ct('✦ Mint Item', '✦ 铸造新藏品')}
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Check market summary and items in collection ${title} (${data.collectionId}).`,
                    `查询合集 ${title}（${data.collectionId}）的藏品列表与行情。`,
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('View Items', '查看藏品')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default NftCollectionCard;
