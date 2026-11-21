/**
 * Digital Goods Trade A2A Wire Protocol (`idbots-trade-v1`)
 *
 * Uses `/protocols/simplemsg` private messages carrying a fenced JSON block:
 *   ```idbots-trade-v1
 *   { "type": "ME_ESCROW_LOCKED_V1" | "ME_DELIVERY_DONE_V1" | "ME_ESCROW_REJECTED_V1" | "GOODS_INQUIRY_V1" | "GOODS_QUOTE_ACCEPT_V1", ... }
 *   ```
 */

export const GOODS_TRADE_WIRE_FENCE_TAG = 'idbots-trade-v1';

export interface MeEscrowLockedMessageV1 {
  type: 'ME_ESCROW_LOCKED_V1';
  orderId: string;
  itemPinId: string;
  amountMilli: number;
  buyerNftAddress: string;
  sellerBotAddress: string;
  buyerGlobalMetaId?: string;
  listingPinId?: string;
}

export interface MeDeliveryDoneMessageV1 {
  type: 'ME_DELIVERY_DONE_V1';
  orderId: string;
  itemPinId: string;
  deliveryTxId: string;
  settledAmountMilli?: number;
  sellerMetaId?: string;
  buyerNftAddress?: string;
}

export interface MeEscrowRejectedMessageV1 {
  type: 'ME_ESCROW_REJECTED_V1';
  orderId: string;
  itemPinId: string;
  reason: string;
}

export interface GoodsInquiryMessageV1 {
  type: 'GOODS_INQUIRY_V1';
  inquiryId: string;
  itemPinId: string;
  offerCurrency?: string;
  offerAmountMilli?: number;
  buyerNftAddress?: string;
  buyerGlobalMetaId?: string;
  expiresAt?: number;
  note?: string;
}

export interface GoodsQuoteAcceptMessageV1 {
  type: 'GOODS_QUOTE_ACCEPT_V1';
  inquiryId: string;
  itemPinId: string;
  agreedCurrency: 'me';
  agreedAmountMilli: number;
  sellerBotAddress: string;
  sellerPayeeAddress?: string;
  validUntil?: number;
  sellerMetaId?: string;
  note?: string;
}

export type GoodsTradeWireMessageV1 =
  | MeEscrowLockedMessageV1
  | MeDeliveryDoneMessageV1
  | MeEscrowRejectedMessageV1
  | GoodsInquiryMessageV1
  | GoodsQuoteAcceptMessageV1;

export function formatGoodsTradeWireMessage(payload: GoodsTradeWireMessageV1): string {
  return `\`\`\`${GOODS_TRADE_WIRE_FENCE_TAG}\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

const FENCE_RE = /```idbots-trade-v1\s*\r?\n([\s\S]*?)```/g;

function pickNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pickFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function parseGoodsTradeWireMessage(
  plaintext: string | null | undefined,
): GoodsTradeWireMessageV1 | null {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const candidates: string[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(plaintext)) !== null) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  if (candidates.length === 0) return null;

  for (const rawJson of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const type = pickNonEmptyString(obj.type);
    const itemPinId = pickNonEmptyString(obj.itemPinId ?? obj.item_pin_id).toLowerCase();
    if (!type || !itemPinId) continue;

    if (type === 'ME_ESCROW_LOCKED_V1') {
      const orderId = pickNonEmptyString(obj.orderId ?? obj.order_id);
      const amountMilli = pickFiniteNumber(obj.amountMilli ?? obj.amount_milli);
      const buyerNftAddress = pickNonEmptyString(
        obj.buyerNftAddress ?? obj.buyer_nft_address ?? obj.buyerAddress ?? obj.buyer_address,
      );
      const sellerBotAddress = pickNonEmptyString(
        obj.sellerBotAddress ?? obj.seller_bot_address ?? obj.sellerAddress ?? obj.seller_address,
      );
      if (!orderId || amountMilli == null || amountMilli <= 0 || !buyerNftAddress || !sellerBotAddress) {
        continue;
      }
      const buyerGlobalMetaId = pickNonEmptyString(
        obj.buyerGlobalMetaId ?? obj.buyer_global_metaid ?? obj.buyerMetaId ?? obj.buyer_metaid,
      ) || undefined;
      const listingPinId = pickNonEmptyString(
        obj.listingPinId ?? obj.listing_pin_id ?? obj.sellPinId ?? obj.sell_pin_id,
      ) || undefined;
      return {
        type: 'ME_ESCROW_LOCKED_V1',
        orderId,
        itemPinId,
        amountMilli,
        buyerNftAddress,
        sellerBotAddress,
        ...(buyerGlobalMetaId ? { buyerGlobalMetaId } : {}),
        ...(listingPinId ? { listingPinId } : {}),
      };
    }

    if (type === 'ME_DELIVERY_DONE_V1') {
      const orderId = pickNonEmptyString(obj.orderId ?? obj.order_id);
      const deliveryTxId = pickNonEmptyString(obj.deliveryTxId ?? obj.delivery_tx_id);
      if (!orderId || !deliveryTxId) continue;
      const settledAmountMilli = pickFiniteNumber(
        obj.settledAmountMilli ?? obj.settled_amount_milli ?? obj.amountMilli ?? obj.amount_milli,
      );
      const sellerMetaId = pickNonEmptyString(
        obj.sellerMetaId ?? obj.seller_metaid ?? obj.sellerGlobalMetaId ?? obj.seller_global_metaid,
      ) || undefined;
      const buyerNftAddress = pickNonEmptyString(
        obj.buyerNftAddress ?? obj.buyer_nft_address ?? obj.buyerAddress ?? obj.buyer_address,
      ) || undefined;
      return {
        type: 'ME_DELIVERY_DONE_V1',
        orderId,
        itemPinId,
        deliveryTxId,
        ...(settledAmountMilli != null ? { settledAmountMilli } : {}),
        ...(sellerMetaId ? { sellerMetaId } : {}),
        ...(buyerNftAddress ? { buyerNftAddress } : {}),
      };
    }

    if (type === 'ME_ESCROW_REJECTED_V1') {
      const orderId = pickNonEmptyString(obj.orderId ?? obj.order_id);
      const reason = pickNonEmptyString(obj.reason) || 'rejected_by_seller';
      if (!orderId) continue;
      return {
        type: 'ME_ESCROW_REJECTED_V1',
        orderId,
        itemPinId,
        reason,
      };
    }

    if (type === 'GOODS_INQUIRY_V1') {
      const inquiryId = pickNonEmptyString(obj.inquiryId ?? obj.inquiry_id);
      if (!inquiryId) continue;
      const offerAmountMilli = pickFiniteNumber(obj.offerAmountMilli ?? obj.offer_amount_milli);
      const offerCurrency = pickNonEmptyString(obj.offerCurrency ?? obj.offer_currency) || undefined;
      const buyerNftAddress = pickNonEmptyString(
        obj.buyerNftAddress ?? obj.buyer_nft_address ?? obj.buyerAddress ?? obj.buyer_address,
      ) || undefined;
      const buyerGlobalMetaId = pickNonEmptyString(
        obj.buyerGlobalMetaId ?? obj.buyer_global_metaid ?? obj.buyerMetaId ?? obj.buyer_metaid,
      ) || undefined;
      const expiresAt = pickFiniteNumber(obj.expiresAt ?? obj.expires_at);
      const note = pickNonEmptyString(obj.note) || undefined;
      return {
        type: 'GOODS_INQUIRY_V1',
        inquiryId,
        itemPinId,
        ...(offerCurrency ? { offerCurrency } : {}),
        ...(offerAmountMilli != null ? { offerAmountMilli } : {}),
        ...(buyerNftAddress ? { buyerNftAddress } : {}),
        ...(buyerGlobalMetaId ? { buyerGlobalMetaId } : {}),
        ...(expiresAt != null ? { expiresAt } : {}),
        ...(note ? { note } : {}),
      };
    }

    if (type === 'GOODS_QUOTE_ACCEPT_V1' || type === 'GOODS_QUOTE_V1') {
      const inquiryId = pickNonEmptyString(obj.inquiryId ?? obj.inquiry_id);
      const agreedAmountMilli = pickFiniteNumber(
        obj.agreedAmountMilli ?? obj.agreed_amount_milli ?? obj.acceptedAmountMilli ?? obj.accepted_amount_milli,
      );
      const sellerBotAddress = pickNonEmptyString(
        obj.sellerBotAddress ?? obj.seller_bot_address ?? obj.sellerAddress ?? obj.seller_address,
      );
      if (!inquiryId || agreedAmountMilli == null || agreedAmountMilli <= 0 || !sellerBotAddress) {
        continue;
      }
      const agreedCurrencyRaw = pickNonEmptyString(obj.agreedCurrency ?? obj.agreed_currency).toLowerCase();
      const agreedCurrency: 'me' = agreedCurrencyRaw && agreedCurrencyRaw !== 'me' ? 'me' : 'me';
      const sellerPayeeAddress = pickNonEmptyString(
        obj.sellerPayeeAddress ?? obj.seller_payee_address,
      ) || undefined;
      const validUntil = pickFiniteNumber(obj.validUntil ?? obj.valid_until);
      const sellerMetaId = pickNonEmptyString(
        obj.sellerMetaId ?? obj.seller_metaid ?? obj.sellerGlobalMetaId ?? obj.seller_global_metaid,
      ) || undefined;
      const note = pickNonEmptyString(obj.note) || undefined;
      return {
        type: 'GOODS_QUOTE_ACCEPT_V1',
        inquiryId,
        itemPinId,
        agreedCurrency,
        agreedAmountMilli,
        sellerBotAddress,
        ...(sellerPayeeAddress ? { sellerPayeeAddress } : {}),
        ...(validUntil != null ? { validUntil } : {}),
        ...(sellerMetaId ? { sellerMetaId } : {}),
        ...(note ? { note } : {}),
      };
    }
  }
  return null;
}
