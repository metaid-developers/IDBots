import { ct, formatMeDisplay } from './commerceTradeI18n';

export const IDBOTS_COMMERCE_INTENT_EVENT = 'idbots:commerce-intent';
export const IDBOTS_SOCIAL_FRIEND_PROMPT_EVENT = 'idbots:social-friend-prompt';

export interface AskTwinToBuyParams {
  mode: 'buy_me' | 'buy_token' | 'negotiate' | 'inquire_unlisted';
  itemPinId: string;
  itemName?: string;
  series?: string;
  collectionName?: string;
  collectionPinId?: string;
  collectionId?: string;
  tokenIndex?: string;
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceSats?: number;
  paymentAssetKey?: string;
  paymentSymbol?: string;
  paymentAmountDisplay?: string;
  paymentAmountBase?: string;
  paymentChain?: 'btc' | 'mvc';
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  sellerName?: string;
  shopMetaAppPinId?: string;
  note?: string;
}

export type AskTwinToBuyIntentDetail =
  | ({
      intent: 'askTwinToBuy';
      source?: string;
      actorId?: string;
      params: AskTwinToBuyParams;
    })
  | ({
      intent: 'askTwinToBuy';
      source?: string;
      actorId?: string;
    } & AskTwinToBuyParams);

export interface SocialFriendPromptParams {
  targetGlobalMetaId: string;
  targetName?: string;
  targetAddress?: string;
  note?: string;
  greeting?: string;
}

export type SocialFriendPromptDetail =
  | ({
      intent: 'addFriendPrompt';
      source?: string;
      actorId?: string;
      params: SocialFriendPromptParams;
    })
  | ({
      intent: 'addFriendPrompt';
      source?: string;
      actorId?: string;
    } & SocialFriendPromptParams);

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
    type: 'buy_with_token';
    itemPinId: string;
    paymentAssetKey: string;
    tokenSymbol?: string;
    tokenAmountDisplay?: string;
    tokenAmountBase?: string;
    tokenChain?: 'btc' | 'mvc';
    sellerReceiveAddress?: string;
    itemName?: string;
    series?: string;
    collectionPinId?: string;
    priceMeMilli?: number;
    priceCnyCents?: number;
    sellerAddress?: string;
    sellerGlobalMetaId?: string;
    sellerName?: string;
    shopMetaAppPinId?: string;
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

export interface SelectedTokenPaymentTarget {
  assetKey: string;
  chain?: 'btc' | 'mvc';
  symbol: string;
  amountDisplay: string;
  amountBase?: string;
  sellerReceiveAddress?: string;
}

export interface GoodsPurchaseConfirmTargetPayload {
  itemPinId: string;
  itemName?: string;
  series?: string;
  collectionPinId?: string;
  priceMeMilli: number;
  priceCnyCents?: number;
  paymentAssetKey?: string;
  selectedToken?: SelectedTokenPaymentTarget;
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  sellerName?: string;
  shopMetaAppPinId?: string;
}

export type ResolvedCommerceIntentAction =
  | { kind: 'open_uri'; uri: string }
  | { kind: 'open_confirm_modal'; target: GoodsPurchaseConfirmTargetPayload }
  | { kind: 'draft_chat'; text: string };

function unwrapAskTwinToBuyParams(detail: AskTwinToBuyIntentDetail): AskTwinToBuyParams {
  if ('params' in detail && detail.params && typeof detail.params === 'object') {
    return detail.params;
  }
  return detail as AskTwinToBuyParams;
}

function unwrapSocialFriendPromptParams(detail: SocialFriendPromptDetail): SocialFriendPromptParams {
  if ('params' in detail && detail.params && typeof detail.params === 'object') {
    return detail.params;
  }
  return detail as SocialFriendPromptParams;
}

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

  const askParams = 'intent' in detail && detail.intent === 'askTwinToBuy'
    ? unwrapAskTwinToBuyParams(detail)
    : null;

  const isBuyWithToken =
    ('type' in detail && detail.type === 'buy_with_token')
    || Boolean(askParams && (askParams.mode === 'buy_token' || askParams.paymentAssetKey));

  if (isBuyWithToken) {
    if (askParams) {
      const itemPinId = askParams.itemPinId?.trim();
      const paymentAssetKey = askParams.paymentAssetKey?.trim().toLowerCase();
      if (!itemPinId || !paymentAssetKey) return null;
      const collectionPinId = askParams.collectionPinId || askParams.collectionId || undefined;
      const series = askParams.series || askParams.collectionName || undefined;
      const chain: 'btc' | 'mvc' = askParams.paymentChain || (paymentAssetKey.startsWith('mrc20:') ? 'btc' : 'mvc');
      return {
        kind: 'open_confirm_modal',
        target: {
          itemPinId,
          itemName: askParams.itemName,
          series,
          collectionPinId,
          priceMeMilli: askParams.priceMeMilli ?? 0,
          priceCnyCents: askParams.priceCnyCents,
          paymentAssetKey,
          selectedToken: {
            assetKey: paymentAssetKey,
            chain,
            symbol: askParams.paymentSymbol || 'TOKEN',
            amountDisplay: askParams.paymentAmountDisplay || '',
            amountBase: askParams.paymentAmountBase,
          },
          sellerAddress: askParams.sellerAddress,
          sellerGlobalMetaId: askParams.sellerGlobalMetaId,
          sellerName: askParams.sellerName,
          shopMetaAppPinId: askParams.shopMetaAppPinId,
        },
      };
    }
    const payload = detail as Extract<CommerceIntentDetail, { type: 'buy_with_token' }>;
    const itemPinId = payload.itemPinId?.trim();
    const paymentAssetKey = payload.paymentAssetKey?.trim().toLowerCase();
    if (!itemPinId || !paymentAssetKey) return null;
    const chain: 'btc' | 'mvc' = payload.tokenChain || (paymentAssetKey.startsWith('mrc20:') ? 'btc' : 'mvc');
    return {
      kind: 'open_confirm_modal',
      target: {
        itemPinId,
        itemName: payload.itemName,
        series: payload.series,
        collectionPinId: payload.collectionPinId,
        priceMeMilli: payload.priceMeMilli ?? 0,
        priceCnyCents: payload.priceCnyCents,
        paymentAssetKey,
        selectedToken: {
          assetKey: paymentAssetKey,
          chain,
          symbol: payload.tokenSymbol || 'TOKEN',
          amountDisplay: payload.tokenAmountDisplay || '',
          amountBase: payload.tokenAmountBase,
          sellerReceiveAddress: payload.sellerReceiveAddress,
        },
        sellerAddress: payload.sellerAddress,
        sellerGlobalMetaId: payload.sellerGlobalMetaId,
        sellerName: payload.sellerName,
        shopMetaAppPinId: payload.shopMetaAppPinId,
      },
    };
  }

  const isBuyWithMe =
    ('type' in detail && detail.type === 'buy_with_me')
    || (askParams?.mode === 'buy_me');

  if (isBuyWithMe) {
    const payload = askParams ?? (detail as Extract<CommerceIntentDetail, { type: 'buy_with_me' }>);
    const itemPinId = payload.itemPinId?.trim();
    if (!itemPinId) return null;
    const collectionPinId = payload.collectionPinId
      || (askParams?.collectionId ? askParams.collectionId : undefined)
      || undefined;
    const series = payload.series
      || (askParams?.collectionName ? askParams.collectionName : undefined)
      || undefined;
    if (payload.priceMeMilli != null && payload.priceMeMilli > 0) {
      return {
        kind: 'open_confirm_modal',
        target: {
          itemPinId,
          itemName: payload.itemName,
          series,
          collectionPinId,
          priceMeMilli: payload.priceMeMilli,
          priceCnyCents: payload.priceCnyCents,
          sellerAddress: payload.sellerAddress,
          sellerGlobalMetaId: payload.sellerGlobalMetaId,
          sellerName: payload.sellerName,
          shopMetaAppPinId: payload.shopMetaAppPinId,
        },
      };
    }
    const targetRef = payload.sellerGlobalMetaId || payload.sellerAddress || '';
    const draft = ct(
      `Send an inquiry via goods_send_inquiry for digital item ${itemPinId}${targetRef ? ` to seller ${targetRef}` : ''} to ask for an ME price quote.`,
      `请使用 goods_send_inquiry 向卖家 ${targetRef} 询价数字商品 ${itemPinId}，确认 ME 积分报价。`,
    );
    return { kind: 'draft_chat', text: draft };
  }

  const isInquiryOrNegotiate =
    ('type' in detail && detail.type === 'negotiate')
    || (askParams?.mode === 'negotiate' || askParams?.mode === 'inquire_unlisted');

  if (isInquiryOrNegotiate) {
    const payload = askParams ?? (detail as Extract<CommerceIntentDetail, { type: 'negotiate' }>);
    const itemPinId = payload.itemPinId?.trim();
    if (!itemPinId) return null;
    const priceHint = payload.priceMeMilli != null ? ` (${formatMeDisplay(payload.priceMeMilli)})` : '';
    const targetRef = payload.sellerGlobalMetaId || payload.sellerAddress || '';
    const isUnlisted = askParams?.mode === 'inquire_unlisted';
    const draft = isUnlisted
      ? ct(
          `Send an unlisted purchase inquiry via goods_send_inquiry for digital item ${itemPinId}${targetRef ? ` to holder ${targetRef}` : ''}${priceHint}.`,
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
  const params = unwrapSocialFriendPromptParams(detail);
  const targetGlobalMetaId = params.targetGlobalMetaId?.trim();
  if (!targetGlobalMetaId) return null;
  const label = params.targetName ? `${params.targetName} (${targetGlobalMetaId})` : targetGlobalMetaId;
  const noteText = (params.note || params.greeting || '').trim();
  const noteSuffix = noteText ? ` Note: ${noteText}` : '';
  return ct(
    `Say hello and send a friend request to ${label} (GlobalMetaID: ${targetGlobalMetaId}).${noteSuffix}`,
    `请向 ${label}（GlobalMetaID: ${targetGlobalMetaId}）打个招呼并发送好友请求。${noteSuffix}`,
  );
}

export function dispatchCommerceIntent(detail: CommerceIntentDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CommerceIntentDetail>(IDBOTS_COMMERCE_INTENT_EVENT, { detail }));
}
