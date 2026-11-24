import React from 'react';
import { ct } from '../commerce/commerceTradeI18n';
import type { NftSwapCardData } from './nftSuiteSyntax';
import {
  CopyShortHashButton,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_INSET_BOX,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';
import { NftSuiteThumb, NftVerifiedPill } from './nftSuiteUi';

export interface NftSwapCardProps {
  data: NftSwapCardData;
  className?: string;
}

export const NftSwapCard: React.FC<NftSwapCardProps> = ({ data, className = '' }) => {
  const items = data.items ?? [];
  const totalCount = data.totalCount ?? (items.length > 0 ? items.length : 1);
  const completedCount =
    data.completedCount ??
    (data.status === 'completed'
      ? totalCount
      : items.filter((item) => item.status === 'completed' || Boolean(item.newPinId)).length);

  const isCompleted = data.status === 'completed' || (totalCount > 0 && completedCount >= totalCount);
  const isFailed = data.status === 'failed';

  const statusLabel = isCompleted
    ? ct(`${completedCount}/${totalCount} Completed`, `${completedCount}/${totalCount} 全部完成`)
    : isFailed
      ? ct('Upgrade Issue', '兑换异常')
      : ct(`Waiting 1-Conf (${completedCount}/${totalCount})`, `等待链上确认 (${completedCount}/${totalCount})`);

  const statusClass = isCompleted
    ? 'bg-[#0f9d68]/12 text-[#0f9d68] dark:bg-[#34d399]/15 dark:text-[#34d399]'
    : isFailed
      ? 'bg-rose-500/12 text-rose-600 dark:text-rose-400'
      : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';

  return (
    <div
      data-nft-swap-card="true"
      data-nft-swap-status={data.status}
      className={`${TK_CARD_SHELL} ${className}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
            {ct('1:1 Collection Upgrade Receipt', '1:1 藏品升级对照回执')}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <NftVerifiedPill
              caVerified={data.caVerified !== false}
              labelOverride={ct('Official Swap Station', '官方认证兑换站')}
            />
            {data.collectionName && (
              <span className="truncate text-[11px] font-medium text-[#5b6472] dark:text-[#9aa3b2]">
                · {data.collectionName}
              </span>
            )}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10.5px] font-bold tabular-nums ${statusClass}`}>
          {statusLabel}
        </span>
      </div>

      {/* Per-Item Upgrade Matrix */}
      {items.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {items.slice(0, 8).map((item, idx) => {
            const serial = item.tokenIndex || String(idx + 1);
            const itemDone = item.status === 'completed' || (isCompleted && item.status !== 'failed');
            return (
              <div
                key={item.newPinId || item.legacyTxId || `${serial}-${idx}`}
                className={`flex items-center justify-between gap-2.5 ${TK_INSET_BOX}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <NftSuiteThumb
                    name={item.name || data.collectionName || 'NFT'}
                    serial={serial}
                    format="mrc721"
                    icon={item.icon}
                    imgUrl={item.imgUrl}
                    size="sm"
                    showSerialBadge
                  />
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                      {item.name || data.collectionName || 'Item'} #{serial}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]">
                      <span className="rounded bg-amber-500/15 px-1 py-px text-[#92400e] dark:text-[#fbbf24]">
                        MetaContract
                      </span>
                      <span>→</span>
                      <span className="rounded bg-[#0ea5e9]/15 px-1 py-px text-[#0369a1] dark:text-[#38bdf8]">
                        MRC-721
                      </span>
                    </div>
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  {item.newPinId ? (
                    <div className="flex flex-col items-end">
                      <span className="text-[9.5px] font-bold text-[#0f9d68] dark:text-[#34d399]">
                        ✓ {ct('Minted Pin', '新 Pin 已铸造')}
                      </span>
                      <CopyShortHashButton value={item.newPinId} />
                    </div>
                  ) : itemDone ? (
                    <span className="rounded-full bg-[#0f9d68]/12 px-2 py-0.5 text-[10px] font-bold text-[#0f9d68] dark:text-[#34d399]">
                      ✓ {ct('Upgraded', '已升级')}
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                      {ct('1-Conf Pending', '等待 1-Conf')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Order / Station Footer */}
      {(data.orderId || data.stationName) && (
        <div className={`mt-2 flex flex-col gap-1 text-[11px] ${TK_INSET_BOX}`}>
          {data.stationName && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Swap Station', '认证兑换站')}
              </span>
              <span className="truncate font-semibold text-[#1f2329] dark:text-[#f4f5f8]">
                {data.stationName}
              </span>
            </div>
          )}
          {data.orderId && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Order ID', '兑换单号')}
              </span>
              <CopyShortHashButton value={data.orderId} />
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="mt-2.5 flex items-center gap-1.5">
        {isCompleted ? (
          <>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    'Pick one of my newly upgraded MRC-721 collectibles and list it for ME points sale.',
                    '帮我从刚升级完成的新版 MRC-721 藏品中挑选挂牌出售。',
                  ),
                )
              }
              className={TK_BTN_PRIMARY}
            >
              {ct('✦ Pick & List for Sale', '✦ 一键挑选挂牌出售')}
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    'Open or publish my Personal Goods Shop with my upgraded collectibles.',
                    '用我刚升级的新版数字藏品开通个人数字小店。',
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('🏪 Open Shop', '🏪 一键开小店')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Check swap order status${data.orderId ? ` for order ${data.orderId}` : ''}.`,
                    `刷新查看藏品 1:1 升级兑换单${data.orderId ? `（${data.orderId}）` : ''}的最新确认进度。`,
                  ),
                )
              }
              className={TK_BTN_PRIMARY}
            >
              {ct('🔄 Refresh Swap Progress', '🔄 刷新兑换进度')}
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct('Show my current NFT portfolio.', '查看我当前的数字藏品持仓。'),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('Portfolio', '查看持仓')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default NftSwapCard;
