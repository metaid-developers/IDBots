import React from 'react';
import { BuildingStorefrontIcon, CheckCircleIcon, TagIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { ct } from './commerceTradeI18n';

export interface SwapCompleteShopPromptProps {
  requestId: string;
  collectionSlug: string;
  targetCollectionPinId?: string | null;
  completedItems: Array<{
    tokenIndex: string;
    itemPinId?: string;
    itemName?: string;
  }>;
  shopMetaAppPinId?: string;
  onListForSale?: (draftPrompt: string) => void;
  onExploreShop?: () => void;
  onDismiss: () => void;
}

export const buildSwapListForSaleDraft = (props: {
  collectionSlug: string;
  completedItems: Array<{ tokenIndex: string; itemPinId?: string; itemName?: string }>;
}): string => {
  const pins = props.completedItems
    .map((item) => item.itemPinId)
    .filter((pin): pin is string => Boolean(pin));
  if (pins.length === 1) {
    return ct(
      `Please list my newly swapped digital item (pinId: ${pins[0]}) for sale using mrc721_sell_intent with ME pricing and auto-fulfill enabled.`,
      `请帮我用 mrc721_sell_intent 将刚置换到的数字商品（pinId: ${pins[0]}）挂单出售，支持 ME 定价并开启自动发货。`,
    );
  }
  const pinSummary = pins.length > 0 ? pins.slice(0, 3).join(', ') : props.collectionSlug;
  return ct(
    `Please list my newly swapped digital items (${pinSummary}) for sale using mrc721_sell_intent with ME pricing and auto-fulfill enabled.`,
    `请帮我用 mrc721_sell_intent 将刚置换到的数字商品（${pinSummary}）挂单出售，支持 ME 定价并开启自动发货。`,
  );
};

const SwapCompleteShopPromptCard: React.FC<SwapCompleteShopPromptProps> = ({
  collectionSlug,
  targetCollectionPinId,
  completedItems,
  shopMetaAppPinId,
  onListForSale,
  onExploreShop,
  onDismiss,
}) => {
  const items = Array.isArray(completedItems) ? completedItems : [];
  const count = items.length;
  const draft = buildSwapListForSaleDraft({ collectionSlug, completedItems: items });

  const handleList = () => {
    if (onListForSale) {
      onListForSale(draft);
    } else if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
    }
    onDismiss();
  };

  const handleExplore = () => {
    if (onExploreShop) {
      onExploreShop();
    } else if (typeof window !== 'undefined') {
      if (shopMetaAppPinId) {
        window.dispatchEvent(
          new CustomEvent('botBrowser:openUri', {
            detail: { uri: `metaapp://${shopMetaAppPinId}`, newTab: true },
          }),
        );
      } else {
        const searchDraft = ct(
          `Search active digital goods listings in ${targetCollectionPinId || collectionSlug} using goods_market_search.`,
          `请用 goods_market_search 查看 ${targetCollectionPinId || collectionSlug} 系列的在售数字商品。`,
        );
        window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: searchDraft } }));
      }
    }
    onDismiss();
  };

  return (
    <div
      data-commerce-card="swap-complete-shop-prompt"
      className="pointer-events-auto w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-claude-border bg-claude-surface p-3.5 shadow-xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckCircleIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="truncate text-sm font-semibold text-claude-text dark:text-claude-darkText">
              {ct('Swap Completed!', '置换已完成！')}
            </h4>
            <button
              type="button"
              onClick={onDismiss}
              aria-label={ct('Dismiss', '关闭')}
              className="rounded-lg p-0.5 text-claude-textSecondary hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-0.5 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {ct(
              `${count} MRC-721 digital item(s) from ${collectionSlug} delivered to your wallet.`,
              `来自 ${collectionSlug} 的 ${count} 件 MRC-721 数字商品已到账。`,
            )}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-action="list-for-sale"
              onClick={handleList}
              className="inline-flex items-center gap-1 rounded-lg bg-claude-accent px-2.5 py-1.5 text-xs font-medium text-claude-accentInk transition-opacity hover:opacity-90"
            >
              <TagIcon className="h-3.5 w-3.5" />
              {ct('List for Sale (ME / CNY)', '一键挂单出售')}
            </button>
            <button
              type="button"
              data-action="explore-shop"
              onClick={handleExplore}
              className="inline-flex items-center gap-1 rounded-lg border border-claude-border px-2.5 py-1.5 text-xs font-medium text-claude-text transition-colors hover:bg-black/5 dark:border-claude-darkBorder dark:text-claude-darkText dark:hover:bg-white/10"
            >
              <BuildingStorefrontIcon className="h-3.5 w-3.5" />
              {ct('Explore Market', '逛官方市场')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SwapCompleteShopPromptCard;
