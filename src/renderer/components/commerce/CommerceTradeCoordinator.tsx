import React, { useEffect, useState } from 'react';
import type {
  ElectronNftSwapOrderCompletedEvent,
  GoodsTradePurchaseSettledEvent,
} from '../../types/electron';
import {
  IDBOTS_COMMERCE_INTENT_EVENT,
  type CommerceIntentDetail,
} from './commerceTradeEvents';
import { ct, formatMeDisplay } from './commerceTradeI18n';
import GoodsPurchaseConfirmModal, { type GoodsPurchaseConfirmTarget } from './GoodsPurchaseConfirmModal';
import PurchaseSuccessActionCard from './PurchaseSuccessActionCard';
import SwapCompleteShopPromptCard from './SwapCompleteShopPromptCard';

const CommerceTradeCoordinator: React.FC = () => {
  const [confirmTarget, setConfirmTarget] = useState<GoodsPurchaseConfirmTarget | null>(null);
  const [swapCompleted, setSwapCompleted] = useState<ElectronNftSwapOrderCompletedEvent | null>(null);
  const [purchaseSettled, setPurchaseSettled] = useState<GoodsTradePurchaseSettledEvent | null>(null);

  useEffect(() => {
    const onIntent = (event: Event) => {
      const detail = (event as CustomEvent<CommerceIntentDetail>).detail;
      if (!detail) return;
      if (detail.type === 'visit_shop') {
        window.dispatchEvent(
          new CustomEvent('botBrowser:openUri', {
            detail: { uri: `metaapp://${detail.shopMetaAppPinId}`, newTab: true },
          }),
        );
        return;
      }
      if (detail.type === 'negotiate') {
        const priceHint = detail.priceMeMilli != null ? ` (${formatMeDisplay(detail.priceMeMilli)})` : '';
        const draft = ct(
          `Send an inquiry/negotiation via goods_send_inquiry for digital item ${detail.itemPinId}${priceHint} to seller ${detail.sellerGlobalMetaId || detail.sellerAddress || 'owner'}.`,
          `请使用 goods_send_inquiry 向卖家 ${detail.sellerGlobalMetaId || detail.sellerAddress || ''} 询价/议价数字商品 ${detail.itemPinId}${priceHint}。`,
        );
        window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
        return;
      }
      if (detail.type === 'buy_with_me') {
        if (!detail.sellerAddress || detail.priceMeMilli == null || detail.priceMeMilli <= 0) {
          const draft = ct(
            `Please buy digital item ${detail.itemPinId} using goods_buy_with_me.`,
            `请使用 goods_buy_with_me 购买数字商品 ${detail.itemPinId}。`,
          );
          window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
          return;
        }
        setConfirmTarget({
          itemPinId: detail.itemPinId,
          itemName: detail.itemName,
          series: detail.series,
          priceMeMilli: detail.priceMeMilli,
          priceCnyCents: detail.priceCnyCents,
          sellerAddress: detail.sellerAddress,
          sellerGlobalMetaId: detail.sellerGlobalMetaId,
          sellerName: detail.sellerName,
          shopMetaAppPinId: detail.shopMetaAppPinId,
        });
      }
    };
    window.addEventListener(IDBOTS_COMMERCE_INTENT_EVENT, onIntent);
    return () => window.removeEventListener(IDBOTS_COMMERCE_INTENT_EVENT, onIntent);
  }, []);

  useEffect(() => {
    const unsubSwap = window.electron?.nftSwap?.onOrderCompleted?.((payload) => {
      if (payload && (payload.status === 'completed' || payload.status === 'partially_completed')) {
        setSwapCompleted(payload);
      }
    });
    const unsubSettled = window.electron?.goodsTrade?.onPurchaseSettled?.((payload) => {
      if (payload?.orderId && payload?.itemPinId) {
        setPurchaseSettled(payload);
      }
    });
    return () => {
      unsubSwap?.();
      unsubSettled?.();
    };
  }, []);

  const hasCards = Boolean(swapCompleted || purchaseSettled);

  return (
    <>
      <GoodsPurchaseConfirmModal
        open={Boolean(confirmTarget)}
        target={confirmTarget}
        onClose={() => setConfirmTarget(null)}
        onOrderSubmitted={(order) => {
          if (order.status === 'settled' || order.status === 'delivered') {
            setPurchaseSettled({
              metabotId: 0,
              orderId: order.orderId,
              itemPinId: order.itemPinId,
              deliveryTxId: order.deliveryTxId,
              amountMilli: order.amountMilli,
              sellerAddress: order.sellerAddress,
              itemName: confirmTarget?.itemName,
              collectionName: confirmTarget?.series,
              shopMetaAppPinId: confirmTarget?.shopMetaAppPinId,
            });
          }
        }}
      />
      {hasCards && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[85] flex flex-col gap-2.5">
          {swapCompleted && (
            <SwapCompleteShopPromptCard
              requestId={swapCompleted.requestId}
              collectionSlug={swapCompleted.collectionSlug}
              targetCollectionPinId={swapCompleted.targetCollectionPinId}
              completedItems={swapCompleted.results.filter((r) => r.status === 'completed')}
              onDismiss={() => setSwapCompleted(null)}
            />
          )}
          {purchaseSettled && (
            <PurchaseSuccessActionCard
              orderId={purchaseSettled.orderId}
              itemPinId={purchaseSettled.itemPinId}
              itemName={purchaseSettled.itemName}
              collectionName={purchaseSettled.collectionName}
              deliveryTxId={purchaseSettled.deliveryTxId}
              amountMilli={purchaseSettled.amountMilli}
              shopMetaAppPinId={purchaseSettled.shopMetaAppPinId}
              onDismiss={() => setPurchaseSettled(null)}
            />
          )}
        </div>
      )}
    </>
  );
};

export default CommerceTradeCoordinator;
