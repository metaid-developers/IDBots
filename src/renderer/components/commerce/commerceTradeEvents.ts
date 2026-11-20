export const IDBOTS_COMMERCE_INTENT_EVENT = 'idbots:commerce-intent';

export type CommerceIntentDetail =
  | {
    type: 'buy_with_me';
    itemPinId: string;
    itemName?: string;
    series?: string;
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
  };

export function dispatchCommerceIntent(detail: CommerceIntentDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CommerceIntentDetail>(IDBOTS_COMMERCE_INTENT_EVENT, { detail }));
}
