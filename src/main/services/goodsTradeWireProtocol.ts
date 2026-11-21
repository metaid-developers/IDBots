/**
 * Digital Goods & Fungible Token Trade A2A Wire Protocol (`idbots-trade-v1`)
 *
 * Uses `/protocols/simplemsg` private messages carrying a fenced JSON block:
 *   ```idbots-trade-v1
 *   { "type": "ME_ESCROW_LOCKED_V1" | ... | "ME_FT_ESCROW_LOCKED_V1" | ... }
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

export interface MeFtEscrowLockedMessageV1 {
  type: 'ME_FT_ESCROW_LOCKED_V1';
  orderId: string;
  assetKey: string;
  chain: 'mvc' | 'btc';
  tokenSymbol: string;
  tokenDecimals: number;
  tokenAmountBase: string;
  amountMilli: number;
  buyerReceiveAddress: string;
  sellerBotAddress: string;
  listingKey?: string;
  lockedUtxoOutpoint?: string;
  buyerGlobalMetaId?: string;
}

export interface MeFtDeliveryDoneMessageV1 {
  type: 'ME_FT_DELIVERY_DONE_V1';
  orderId: string;
  assetKey: string;
  chain: 'mvc' | 'btc';
  tokenAmountBase: string;
  deliveryTxId: string;
  settledAmountMilli?: number;
  sellerMetaId?: string;
  buyerReceiveAddress?: string;
}

export interface MeFtEscrowRejectedMessageV1 {
  type: 'ME_FT_ESCROW_REJECTED_V1';
  orderId: string;
  assetKey: string;
  reason: string;
}

export type GoodsTradeWireMessageV1 =
  | MeEscrowLockedMessageV1
  | MeDeliveryDoneMessageV1
  | MeEscrowRejectedMessageV1
  | GoodsInquiryMessageV1
  | GoodsQuoteAcceptMessageV1
  | MeFtEscrowLockedMessageV1
  | MeFtDeliveryDoneMessageV1
  | MeFtEscrowRejectedMessageV1;

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
    if (!type) continue;

    // --- FT Escrow A2A Wire Messages (Contract C5.2) ---
    if (type === 'ME_FT_ESCROW_LOCKED_V1') {
      const orderId = pickNonEmptyString(obj.orderId ?? obj.order_id);
      const assetKey = pickNonEmptyString(obj.assetKey ?? obj.asset_key).toLowerCase();
      const chainRaw = pickNonEmptyString(obj.chain ?? 'mvc').toLowerCase();
      const chain: 'mvc' | 'btc' = chainRaw === 'btc' ? 'btc' : 'mvc';
      const tokenSymbol = pickNonEmptyString(obj.tokenSymbol ?? obj.token_symbol ?? obj.symbol) || 'TOKEN';
      const tokenDecimals = pickFiniteNumber(obj.tokenDecimals ?? obj.token_decimals ?? obj.decimals) ?? 0;
      const tokenAmountBase = pickNonEmptyString(
        obj.tokenAmountBase !== undefined ? String(obj.tokenAmountBase) : (obj.token_amount_base !== undefined ? String(obj.token_amount_base) : ''),
      );
      const amountMilli = pickFiniteNumber(obj.amountMilli ?? obj.amount_milli);
      const buyerReceiveAddress = pickNonEmptyString(
        obj.buyerReceiveAddress ?? obj.buyer_receive_address ?? obj.buyerAddress ?? obj.buyer_address,
      );
      const sellerBotAddress = pickNonEmptyString(
        obj.sellerBotAddress ?? obj.seller_bot_address ?? obj.sellerAddress ?? obj.seller_address,
      );
      if (
        !orderId ||
        !assetKey ||
        !/^[1-9]\d*$/.test(tokenAmountBase) ||
        amountMilli == null ||
        amountMilli <= 0 ||
        !buyerReceiveAddress ||
        !sellerBotAddress
      ) {
        continue;
      }
      const listingKey = pickNonEmptyString(obj.listingKey ?? obj.listing_key) || undefined;
      const lockedUtxoOutpoint = pickNonEmptyString(
        obj.lockedUtxoOutpoint ?? obj.locked_utxo_outpoint,
      ) || undefined;
      const buyerGlobalMetaId = pickNonEmptyString(
        obj.buyerGlobalMetaId ?? obj.buyer_global_metaid ?? obj.buyerMetaId ?? obj.buyer_metaid,
      ) || undefined;
      return {
        type: 'ME_FT_ESCROW_LOCKED_V1',
        orderId,
        assetKey,
        chain,
        tokenSymbol,
        tokenDecimals: Math.max(0, Math.trunc(tokenDecimals)),
        tokenAmountBase,
        amountMilli,
        buyerReceiveAddress,
        sellerBotAddress,
        ...(listingKey ? { listingKey } : {}),
        ...(lockedUtxoOutpoint ? { lockedUtxoOutpoint } : {}),
        ...(buyerGlobalMetaId ? { buyerGlobalMetaId } : {}),
      };
    }

    if (type === 'ME_FT_DELIVERY_DONE_V1') {
      const orderId = pickNonEmptyString(obj.orderId ?? obj.order_id);
      const assetKey = pickNonEmptyString(obj.assetKey ?? obj.asset_key).toLowerCase();
      const chainRaw = pickNonEmptyString(obj.chain ?? 'mvc').toLowerCase();
      const chain: 'mvc' | 'btc' = chainRaw === 'btc' ? 'btc' : 'mvc';
      const tokenAmountBase = pickNonEmptyString(
        obj.tokenAmountBase !== undefined ? String(obj.tokenAmountBase) : (obj.token_amount_base !== undefined ? String(obj.token_amount_base) : ''),
      );
      const deliveryTxId = pickNonEmptyString(obj.deliveryTxId ?? obj.delivery_tx_id);
      if (!orderId || !assetKey || !tokenAmountBase || !deliveryTxId) continue;
      const settledAmountMilli = pickFiniteNumber(
        obj.settledAmountMilli ?? obj.settled_amount_milli ?? obj.amountMilli ?? obj.amount_milli,
      );
      const sellerMetaId = pickNonEmptyString(
        obj.sellerMetaId ?? obj.seller_metaid ?? obj.sellerGlobalMetaId ?? obj.seller_global_metaid,
      ) || undefined;
      const buyerReceiveAddress = pickNonEmptyString(
        obj.buyerReceiveAddress ?? obj.buyer_receive_address,
      ) || undefined;
      return {
        type: 'ME_FT_DELIVERY_DONE_V1',
        orderId,
        assetKey,
        chain,
        tokenAmountBase,
        deliveryTxId,
        ...(settledAmountMilli != null ? { settledAmountMilli } : {}),
        ...(sellerMetaId ? { sellerMetaId } : {}),
        ...(buyerReceiveAddress ? { buyerReceiveAddress } : {}),
      };
    }

    if (type === 'ME_FT_ESCROW_REJECTED_V1') {
      const orderId = pickNonEmptyString(obj.orderId ?? obj.order_id);
      const assetKey = pickNonEmptyString(obj.assetKey ?? obj.asset_key).toLowerCase();
      const reason = pickNonEmptyString(obj.reason) || 'rejected_by_seller';
      if (!orderId || !assetKey) continue;
      return {
        type: 'ME_FT_ESCROW_REJECTED_V1',
        orderId,
        assetKey,
        reason,
      };
    }

    // --- Existing NFT / Digital Goods Wire Messages ---
    const itemPinId = pickNonEmptyString(obj.itemPinId ?? obj.item_pin_id).toLowerCase();
    if (!itemPinId) continue;

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

    if (type === 'GOODS_QUOTE_ACCEPT_V1') {
      const inquiryId = pickNonEmptyString(obj.inquiryId ?? obj.inquiry_id);
      const agreedAmountMilli = pickFiniteNumber(obj.agreedAmountMilli ?? obj.agreed_amount_milli);
      const sellerBotAddress = pickNonEmptyString(
        obj.sellerBotAddress ?? obj.seller_bot_address ?? obj.sellerAddress ?? obj.seller_address,
      );
      if (!inquiryId || agreedAmountMilli == null || agreedAmountMilli <= 0 || !sellerBotAddress) {
        continue;
      }
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
        agreedCurrency: 'me',
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
