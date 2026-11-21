import React, { useEffect, useState } from 'react';
import type {
  ElectronNftSwapOrderCompletedEvent,
  GoodsTradePurchaseSettledEvent,
} from '../../types/electron';
import {
  buildSocialFriendPromptDraft,
  IDBOTS_COMMERCE_INTENT_EVENT,
  IDBOTS_SOCIAL_FRIEND_PROMPT_EVENT,
  resolveCommerceIntentAction,
  type CommerceIntentDetail,
  type SocialFriendPromptDetail,
} from './commerceTradeEvents';
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
      const action = resolveCommerceIntentAction(detail);
      if (!action) return;
      if (action.kind === 'open_uri') {
        window.dispatchEvent(
          new CustomEvent('botBrowser:openUri', {
            detail: { uri: action.uri, newTab: true },
          }),
        );
        return;
      }
      if (action.kind === 'draft_chat') {
        window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: action.text } }));
        return;
      }
      if (action.kind === 'open_confirm_modal') {
        setConfirmTarget(action.target);
      }
    };

    const onSocialFriendPrompt = (event: Event) => {
      const detail = (event as CustomEvent<SocialFriendPromptDetail>).detail;
      const draft = buildSocialFriendPromptDraft(detail);
      if (!draft) return;
      window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
    };

    window.addEventListener(IDBOTS_COMMERCE_INTENT_EVENT, onIntent);
    window.addEventListener(IDBOTS_SOCIAL_FRIEND_PROMPT_EVENT, onSocialFriendPrompt);
    return () => {
      window.removeEventListener(IDBOTS_COMMERCE_INTENT_EVENT, onIntent);
      window.removeEventListener(IDBOTS_SOCIAL_FRIEND_PROMPT_EVENT, onSocialFriendPrompt);
    };
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
          if (order.status === 'SETTLED') {
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
