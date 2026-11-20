/**
 * Digital Goods Trade A2A Wire Protocol (`idbots-trade-v1`)
 *
 * Uses `/protocols/simplemsg` private messages carrying a fenced JSON block:
 *   ```idbots-trade-v1
 *   { "type": "ME_ESCROW_LOCKED_V1" | "ME_DELIVERY_DONE_V1" | "ME_ESCROW_REJECTED_V1" | "GOODS_INQUIRY_V1" | "GOODS_QUOTE_V1", ... }
 *   ```
 */

export const GOODS_TRADE_WIRE_FENCE_TAG = 'idbots-trade-v1';

export interface MeEscrowLockedMessageV1 {
  type: 'ME_ESCROW_LOCKED_V1';
  orderId: string;
  itemPinId: string;
  amountMilli: number;
  buyerAddress: string;
  buyerMetaId?: string;
  sellerAddress: string;
  sellPinId?: string;
}

export interface MeDeliveryDoneMessageV1 {
  type: 'ME_DELIVERY_DONE_V1';
  orderId: string;
  itemPinId: string;
  deliveryTxId: string;
  amountMilli?: number;
  sellerMetaId?: string;
  buyerAddress?: string;
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
  offerAmountMilli?: number;
  offerCurrency?: string;
  buyerAddress?: string;
  buyerMetaId?: string;
  note?: string;
}

export interface GoodsQuoteMessageV1 {
  type: 'GOODS_QUOTE_V1';
  inquiryId: string;
  itemPinId: string;
  acceptedAmountMilli: number;
  validUntil?: number;
  sellerAddress: string;
  sellerMetaId?: string;
  note?: string;
}

export type GoodsTradeWireMessageV1 =
  | MeEscrowLockedMessageV1
  | MeDeliveryDoneMessageV1
  | MeEscrowRejectedMessageV1
  | GoodsInquiryMessageV1
  | GoodsQuoteMessageV1;

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
      const buyerAddress = pickNonEmptyString(obj.buyerAddress ?? obj.buyer_address);
      const sellerAddress = pickNonEmptyString(obj.sellerAddress ?? obj.seller_address);
      if (!orderId || amountMilli == null || amountMilli <= 0 || !buyerAddress || !sellerAddress) {
        continue;
      }
      const buyerMetaId = pickNonEmptyString(obj.buyerMetaId ?? obj.buyer_metaid) || undefined;
      const sellPinId = pickNonEmptyString(obj.sellPinId ?? obj.sell_pin_id) || undefined;
      return {
        type: 'ME_ESCROW_LOCKED_V1',
        orderId,
        itemPinId,
        amountMilli,
        buyerAddress,
        ...(buyerMetaId ? { buyerMetaId } : {}),
        sellerAddress,
        ...(sellPinId ? { sellPinId } : {}),
      };
    }

    if (type === 'ME_DELIVERY_DONE_V1') {
      const orderId = pickNonEmptyString(obj.orderId ?? obj.order_id);
      const deliveryTxId = pickNonEmptyString(obj.deliveryTxId ?? obj.delivery_tx_id);
      if (!orderId || !deliveryTxId) continue;
      const amountMilli = pickFiniteNumber(obj.amountMilli ?? obj.amount_milli);
      const sellerMetaId = pickNonEmptyString(obj.sellerMetaId ?? obj.seller_metaid) || undefined;
      const buyerAddress = pickNonEmptyString(obj.buyerAddress ?? obj.buyer_address) || undefined;
      return {
        type: 'ME_DELIVERY_DONE_V1',
        orderId,
        itemPinId,
        deliveryTxId,
        ...(amountMilli != null ? { amountMilli } : {}),
        ...(sellerMetaId ? { sellerMetaId } : {}),
        ...(buyerAddress ? { buyerAddress } : {}),
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
      const buyerAddress = pickNonEmptyString(obj.buyerAddress ?? obj.buyer_address) || undefined;
      const buyerMetaId = pickNonEmptyString(obj.buyerMetaId ?? obj.buyer_metaid) || undefined;
      const note = pickNonEmptyString(obj.note) || undefined;
      return {
        type: 'GOODS_INQUIRY_V1',
        inquiryId,
        itemPinId,
        ...(offerAmountMilli != null ? { offerAmountMilli } : {}),
        ...(offerCurrency ? { offerCurrency } : {}),
        ...(buyerAddress ? { buyerAddress } : {}),
        ...(buyerMetaId ? { buyerMetaId } : {}),
        ...(note ? { note } : {}),
      };
    }

    if (type === 'GOODS_QUOTE_V1') {
      const inquiryId = pickNonEmptyString(obj.inquiryId ?? obj.inquiry_id);
      const acceptedAmountMilli = pickFiniteNumber(obj.acceptedAmountMilli ?? obj.accepted_amount_milli);
      const sellerAddress = pickNonEmptyString(obj.sellerAddress ?? obj.seller_address);
      if (!inquiryId || acceptedAmountMilli == null || acceptedAmountMilli <= 0 || !sellerAddress) {
        continue;
      }
      const validUntil = pickFiniteNumber(obj.validUntil ?? obj.valid_until);
      const sellerMetaId = pickNonEmptyString(obj.sellerMetaId ?? obj.seller_metaid) || undefined;
      const note = pickNonEmptyString(obj.note) || undefined;
      return {
        type: 'GOODS_QUOTE_V1',
        inquiryId,
        itemPinId,
        acceptedAmountMilli,
        ...(validUntil != null ? { validUntil } : {}),
        sellerAddress,
        ...(sellerMetaId ? { sellerMetaId } : {}),
        ...(note ? { note } : {}),
      };
    }
  }
  return null;
}
