import { ct, formatMeDisplay } from './commerceTradeI18n';

export const IDBOTS_COMMERCE_INTENT_EVENT = 'idbots:commerce-intent';
export const IDBOTS_SOCIAL_FRIEND_PROMPT_EVENT = 'idbots:social-friend-prompt';

export interface AskTwinToBuyIntentDetail {
  intent: 'askTwinToBuy';
  mode: 'buy_me' | 'negotiate' | 'inquire_unlisted';
  itemPinId: string;
  itemName?: string;
  series?: string;
  collectionPinId?: string;
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceSats?: number;
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  sellerName?: string;
  shopMetaAppPinId?: string;
  note?: string;
}

export interface SocialFriendPromptDetail {
  intent: 'addFriendPrompt';
  targetGlobalMetaId: string;
  targetName?: string;
  targetAddress?: string;
  source?: string;
  note?: string;
}

export type CommerceIntentDetail =
  | {
    type: 'buy_with_me';
    itemPinId: string;
    itemName?: string;
    series?: string;
    collectionPinId?: string;
    priceMeMilli?: number;
    priceCnyCents?: number;
    priceSats?: number;
    sellerAddress?: string;
    sellerGlobalMetaId?: string;
    sellerName?: string;
    shopMetaAppPinId?: string;
    icon?: string;
    imgUrl?: string;
  }
  | {
    type: 'negotiate';
    itemPinId: string;
    itemName?: string;
    series?: string;
    sellerAddress?: string;
    sellerGlobalMetaId?: string;
    sellerName?: string;
    priceMeMilli?: number;
  }
  | {
    type: 'visit_shop';
    shopMetaAppPinId: string;
    sellerGlobalMetaId?: string;
    sellerName?: string;
  }
  | AskTwinToBuyIntentDetail;

export interface GoodsPurchaseConfirmTargetPayload {
  itemPinId: string;
  itemName?: string;
  series?: string;
  collectionPinId?: string;
  priceMeMilli: number;
  priceCnyCents?: number;
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  sellerName?: string;
  shopMetaAppPinId?: string;
}

export type ResolvedCommerceIntentAction =
  | { kind: 'open_uri'; uri: string }
  | { kind: 'open_confirm_modal'; target: GoodsPurchaseConfirmTargetPayload }
  | { kind: 'draft_chat'; text: string };

export function resolveCommerceIntentAction(
  detail: CommerceIntentDetail | null | undefined,
): ResolvedCommerceIntentAction | null {
  if (!detail) return null;

  if ('type' in detail && detail.type === 'visit_shop') {
    if (!detail.shopMetaAppPinId) return null;
    return {
      kind: 'open_uri',
      uri: `metaapp://${detail.shopMetaAppPinId}`,
    };
  }

  const isBuyWithMe =
    ('type' in detail && detail.type === 'buy_with_me')
    || ('intent' in detail && detail.intent === 'askTwinToBuy' && detail.mode === 'buy_me');

  if (isBuyWithMe) {
    const itemPinId = detail.itemPinId?.trim();
    if (!itemPinId) return null;
    if (detail.priceMeMilli != null && detail.priceMeMilli > 0) {
      return {
        kind: 'open_confirm_modal',
        target: {
          itemPinId,
          itemName: detail.itemName,
          series: detail.series,
          collectionPinId: 'collectionPinId' in detail ? detail.collectionPinId : undefined,
          priceMeMilli: detail.priceMeMilli,
          priceCnyCents: detail.priceCnyCents,
          sellerAddress: detail.sellerAddress,
          sellerGlobalMetaId: detail.sellerGlobalMetaId,
          sellerName: detail.sellerName,
          shopMetaAppPinId: detail.shopMetaAppPinId,
        },
      };
    }
    const targetRef = detail.sellerGlobalMetaId || detail.sellerAddress || '';
    const draft = ct(
      `Send an inquiry via goods_send_inquiry for digital item ${itemPinId}${targetRef ? ` to seller ${targetRef}` : ''} to ask for an ME price quote.`,
      `请使用 goods_send_inquiry 向卖家 ${targetRef} 询价数字商品 ${itemPinId}，确认 ME 积分报价。`,
    );
    return { kind: 'draft_chat', text: draft };
  }

  const isInquiryOrNegotiate =
    ('type' in detail && detail.type === 'negotiate')
    || (
      'intent' in detail
      && detail.intent === 'askTwinToBuy'
      && (detail.mode === 'negotiate' || detail.mode === 'inquire_unlisted')
    );

  if (isInquiryOrNegotiate) {
    const itemPinId = detail.itemPinId?.trim();
    if (!itemPinId) return null;
    const priceHint = detail.priceMeMilli != null ? ` (${formatMeDisplay(detail.priceMeMilli)})` : '';
    const targetRef = detail.sellerGlobalMetaId || detail.sellerAddress || '';
    const isUnlisted = 'intent' in detail && detail.intent === 'askTwinToBuy' && detail.mode === 'inquire_unlisted';
    const draft = isUnlisted
      ? ct(
          `Send a求购/unlisted purchase inquiry via goods_send_inquiry for digital item ${itemPinId}${targetRef ? ` to holder ${targetRef}` : ''}${priceHint}.`,
          `请使用 goods_send_inquiry 向持有人 ${targetRef} 发起未上架数字商品 ${itemPinId} 的求购询价${priceHint}。`,
        )
      : ct(
          `Send an inquiry/negotiation via goods_send_inquiry for digital item ${itemPinId}${priceHint}${targetRef ? ` to seller ${targetRef}` : ''}.`,
          `请使用 goods_send_inquiry 向卖家 ${targetRef} 询价/议价数字商品 ${itemPinId}${priceHint}。`,
        );
    return { kind: 'draft_chat', text: draft };
  }

  return null;
}

export function buildSocialFriendPromptDraft(
  detail: SocialFriendPromptDetail | null | undefined,
): string | null {
  if (!detail || detail.intent !== 'addFriendPrompt') return null;
  const targetGlobalMetaId = detail.targetGlobalMetaId?.trim();
  if (!targetGlobalMetaId) return null;
  const label = detail.targetName ? `${detail.targetName} (${targetGlobalMetaId})` : targetGlobalMetaId;
  const noteSuffix = detail.note?.trim() ? ` Note: ${detail.note.trim()}` : '';
  return ct(
    `Say hello and send a friend request to ${label} (GlobalMetaID: ${targetGlobalMetaId}).${noteSuffix}`,
    `请向 ${label}（GlobalMetaID: ${targetGlobalMetaId}）打个招呼并发送好友请求。${noteSuffix}`,
  );
}

export function dispatchCommerceIntent(detail: CommerceIntentDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CommerceIntentDetail>(IDBOTS_COMMERCE_INTENT_EVENT, { detail }));
}
