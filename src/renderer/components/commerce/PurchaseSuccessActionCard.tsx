import React from 'react';
import {
  BuildingStorefrontIcon,
  CheckBadgeIcon,
  SparklesIcon,
  WalletIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { ct, formatMeDisplay } from './commerceTradeI18n';

export interface PurchaseSuccessActionCardProps {
  orderId: string;
  itemPinId: string;
  itemName?: string;
  collectionName?: string;
  deliveryTxId?: string;
  amountMilli?: number;
  shopMetaAppPinId?: string;
  onViewAssets?: () => void;
  onVisitSellerShop?: () => void;
  onSetAvatarOrRelist?: () => void;
  onDismiss: () => void;
}

const PurchaseSuccessActionCard: React.FC<PurchaseSuccessActionCardProps> = ({
  orderId,
  itemPinId,
  itemName,
  collectionName,
  deliveryTxId,
  amountMilli,
  shopMetaAppPinId,
  onViewAssets,
  onVisitSellerShop,
  onSetAvatarOrRelist,
  onDismiss,
}) => {
  const handleViewAssets = () => {
    if (onViewAssets) {
      onViewAssets();
    } else if (typeof window !== 'undefined') {
      const draft = ct(
        `Check my digital item holdings including ${itemPinId} using goods_holder_lookup.`,
        `请用 goods_holder_lookup 查看我持有的数字商品，包括 ${itemPinId}。`,
      );
      window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
    }
    onDismiss();
  };

  const handleVisitShop = () => {
    if (onVisitSellerShop) {
      onVisitSellerShop();
    } else if (shopMetaAppPinId && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('botBrowser:openUri', {
          detail: { uri: `metaapp://${shopMetaAppPinId}`, newTab: true },
        }),
      );
    }
    onDismiss();
  };

  const handleSetAvatarOrRelist = () => {
    if (onSetAvatarOrRelist) {
      onSetAvatarOrRelist();
    } else if (typeof window !== 'undefined') {
      const draft = ct(
        `I just acquired digital item ${itemPinId}. Help me set it as my MetaBot avatar or re-list it with mrc721_sell_intent.`,
        `我刚买到数字商品 ${itemPinId}，请帮我设为 MetaBot 头像或用 mrc721_sell_intent 重新挂单。`,
      );
      window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
    }
    onDismiss();
  };

  return (
    <div
      data-commerce-card="purchase-success-action"
      className="pointer-events-auto w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-emerald-500/40 bg-claude-surface p-3.5 shadow-xl dark:bg-claude-darkSurface"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckBadgeIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="truncate text-sm font-semibold text-claude-text dark:text-claude-darkText">
              {ct('Digital Item Delivered!', '数字商品已到账！')}
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
          <p className="mt-0.5 truncate text-xs text-claude-text dark:text-claude-darkText">
            {itemName || itemPinId}
            {collectionName ? ` · ${collectionName}` : ''}
          </p>
          <div className="mt-1 space-y-0.5 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            <div>
              {ct('Order:', '订单:')} <span className="font-mono">{orderId}</span>
              {amountMilli != null && amountMilli > 0 ? ` · ${formatMeDisplay(amountMilli)}` : ''}
            </div>
            {deliveryTxId && (
              <div className="truncate">
                {ct('Tx:', '交易:')} <span className="font-mono">{deliveryTxId.slice(0, 12)}…</span>
              </div>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-action="view-assets"
              onClick={handleViewAssets}
              className="inline-flex items-center gap-1 rounded-lg bg-claude-accent px-2.5 py-1 text-[11px] font-medium text-claude-accentInk hover:opacity-90"
            >
              <WalletIcon className="h-3.5 w-3.5" />
              {ct('View My Assets', '查看我的资产')}
            </button>
            {shopMetaAppPinId && (
              <button
                type="button"
                data-action="visit-seller-shop"
                onClick={handleVisitShop}
                className="inline-flex items-center gap-1 rounded-lg border border-claude-border px-2.5 py-1 text-[11px] font-medium text-claude-text hover:bg-black/5 dark:border-claude-darkBorder dark:text-claude-darkText dark:hover:bg-white/10"
              >
                <BuildingStorefrontIcon className="h-3.5 w-3.5" />
                {ct('Visit Shop', '逛卖家店铺')}
              </button>
            )}
            <button
              type="button"
              data-action="avatar-or-relist"
              onClick={handleSetAvatarOrRelist}
              className="inline-flex items-center gap-1 rounded-lg border border-claude-border px-2.5 py-1 text-[11px] font-medium text-claude-text hover:bg-black/5 dark:border-claude-darkBorder dark:text-claude-darkText dark:hover:bg-white/10"
            >
              <SparklesIcon className="h-3.5 w-3.5" />
              {ct('Avatar / Re-list', '头像 / 转售')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PurchaseSuccessActionCard;
