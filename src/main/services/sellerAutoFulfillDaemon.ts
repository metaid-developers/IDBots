/**
 * SellerAutoFulfillDaemon (REQ-D-03)
 *
 * 24/7 automatic seller-side fulfillment for ABS ME Points NFT Escrow orders:
 *   - Fast path: triggered immediately when `privateChatDaemon` receives an
 *     `idbots-trade-v1` `ME_ESCROW_LOCKED_V1` wire message.
 *   - Fallback path: polls `GET /v1/me/nft-escrow/orders?role=seller&status=FROZEN_AWAITING_DELIVERY`
 *     every 60 seconds across all enabled local MetaBots.
 *
 * Enforces 6 strict safety checks + SQLite crash-recovery idempotency
 * (`me_nft_seller_fulfillments`) so a crash after on-chain NFT transfer never
 * double-transfers on retry.
 */

import type { SqliteDatabase } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import { fetchMrc721ItemInfo, type Mrc721ItemSummary } from './mrc721Service';
import {
  broadcastMrc721TradeReceipt,
  findLocalActiveSellIntentForItem,
  findSellerAuthorizedQuoteForOrder,
  markMrc721SellIntentSold,
  markSellerAuthorizedQuoteUsed,
  recordAcceptedGoodsQuote,
  type GoodsAcceptedQuoteRecord,
  type Mrc721SellIntentRecord,
  type SellIntentKv,
} from './mrc721SellIntentService';
import {
  assertEscrowMvcAddress,
  deliverNftEscrowOrder,
  getNftEscrowOrder,
  listNftEscrowOrders,
  rejectNftEscrowOrder,
  type MeNftEscrowOrder,
  type MeNftEscrowSigner,
} from './meNftEscrowService';
import {
  formatGoodsTradeWireMessage,
  parseGoodsTradeWireMessage,
} from './goodsTradeWireProtocol';
import type { AgentNotificationInput } from '../../renderer/types/notification';
import {
  deliverFtEscrowOrder,
  getFtEscrowOrder,
  listFtEscrowOrders,
  rejectFtEscrowOrder,
  validateFtReceiveAddress,
  type FtEscrowOrderStatus,
  type MeFtEscrowOrder,
} from './meFtEscrowService';
import {
  ensureFtOrderTables,
  findActiveMeFtOrderForEscrow,
  getFtBatchOrderProgress,
  getMeFtFulfillmentRecord,
  listFtActiveOrders,
  updateFtOrderStatus,
  upsertMeFtFulfillmentRecord,
  type FtActiveOrderRecord,
  type MeFtSellerFulfillmentRecord,
} from './ftOrderStore';
import { broadcastMvcTx, isMvcAddress } from './mrc721Service';
import { getMvcWalletFromPath } from './metabotWalletService';
import {
  claimOrReplayUsedPayment,
  createTokenGoodsReservation,
  defaultTokenGoodsWaiters,
  ensureTokenForGoodsSchema,
  expireStaleTokenGoodsReservations,
  getTokenGoodsReservation,
  hasActiveItemLock,
  parseCanonicalFtAssetKey,
  updateTokenGoodsReservation,
  updateUsedPaymentDeliveryTx,
  verifyAndSignMvcFtGoodsAtomicProposal,
  verifyMrc20GoodsPayment,
  type AuthoritativeMrc20Utxo,
  type TokenGoodsWaiterRegistry,
} from './tokenForGoodsService';

export const SELLER_AUTO_FULFILL_POLL_INTERVAL_MS = 60_000;

export type SellerFulfillmentStatus =
  | 'processing'
  | 'transferred'
  | 'settled'
  | 'rejected'
  | 'failed';

export interface SellerFulfillmentRecord {
  orderId: string;
  sellerMetabotId: number;
  itemPinId: string;
  buyerAddress: string;
  amountMilli: number;
  status: SellerFulfillmentStatus;
  deliveryTxId: string | null;
  tradePinId: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SellerAutoSoldEvent {
  orderId: string;
  sellerMetabotId: number;
  itemPinId: string;
  buyerAddress: string;
  amountMilli: number;
  deliveryTxId: string;
  tradePinId?: string;
  settledAt: number;
}

export interface SellerAutoFulfillDeps {
  getMetabotStore: () => MetabotStore;
  getSellIntentKv: () => SellIntentKv;
  transferMrc721Item: (input: {
    metabotId: number;
    pinId: string;
    toAddress: string;
  }) => Promise<{ txId: string; pinId: string; toAddress: string }>;
  broadcastTradeReceipt?: (input: {
    metabotId: number;
    txId: string;
    orderId: string;
    itemPinId: string;
    collectionPinId?: string;
    sellerAddress: string;
    sellerMetaId?: string;
    buyerAddress: string;
    buyerMetaId?: string;
    currency?: 'me' | 'fiat:CNY' | 'space' | `ft:${string}`;
    amountMilli?: number;
    assetKey?: string;
    amountBase?: string;
    amountDisplay?: string;
    verifiedSource?: 'abs_escrow' | 'chain_offer' | 'escrow_bot' | 'atomic_ft_swap' | 'token_verify';
  }) => Promise<{ pinId: string; txids: string[] }>;
  sendTradeMessage?: (input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
  }) => Promise<{ txids: string[]; pinId: string }>;
  emitToRenderer?: (channel: string, payload: unknown) => void;
  // Injectable overrides for deterministic unit tests
  getEscrowOrder?: (signer: MeNftEscrowSigner, orderId: string) => Promise<MeNftEscrowOrder>;
  listEscrowOrders?: (
    signer: MeNftEscrowSigner,
    query?: { role?: 'buyer' | 'seller' | 'all'; status?: string; limit?: number },
  ) => Promise<{ orders: MeNftEscrowOrder[] }>;
  deliverEscrowOrder?: (
    signer: MeNftEscrowSigner,
    orderId: string,
    input: { deliveryTxId: string },
  ) => Promise<MeNftEscrowOrder>;
  rejectEscrowOrder?: (
    signer: MeNftEscrowSigner,
    orderId: string,
    input: { reason: string },
  ) => Promise<MeNftEscrowOrder>;
  fetchItemInfo?: (pinId: string) => Promise<Mrc721ItemSummary | null>;
  findLocalActiveSellIntent?: (
    metabotId: number,
    itemPinId: string,
  ) => Mrc721SellIntentRecord | null;
  markSellIntentSold?: (
    metabotId: number,
    itemPinId: string,
    meta?: { orderId?: string; txId?: string },
  ) => boolean;
  findSellerAuthorizedQuote?: (
    metabotId: number,
    itemPinId: string,
    buyerNftAddress?: string,
  ) => GoodsAcceptedQuoteRecord | null;
  markSellerAuthorizedQuoteUsed?: (
    metabotId: number,
    itemPinId: string,
    meta?: { inquiryId?: string; orderId?: string },
  ) => boolean;
  // WS-1 FT ME Escrow Auto-Fulfill dependencies (optional with defaults)
  transferMvcFt?: (input: {
    metabotId: number;
    codehash: string;
    genesis: string;
    toAddress: string;
    amountBase: string;
  }) => Promise<{ txId: string }>;
  transferBtcMrc20?: (input: {
    metabotId: number;
    mrc20Id: string;
    decimal: number;
    symbol: string;
    fromAddress: string;
    toAddress: string;
    amountBase: string;
  }) => Promise<{ revealTxId: string; commitTxId?: string }>;
  getFtEscrowOrder?: (signer: MeNftEscrowSigner, orderId: string) => Promise<MeFtEscrowOrder>;
  listFtEscrowOrders?: (
    signer: MeNftEscrowSigner,
    query: { role: 'buyer' | 'seller'; status?: FtEscrowOrderStatus; limit?: number },
  ) => Promise<MeFtEscrowOrder[]>;
  deliverFtEscrowOrder?: (
    signer: MeNftEscrowSigner,
    orderId: string,
    params: { deliveryTxId: string; tradePinId?: string },
  ) => Promise<MeFtEscrowOrder>;
  rejectFtEscrowOrder?: (
    signer: MeNftEscrowSigner,
    orderId: string,
    reason: string,
  ) => Promise<MeFtEscrowOrder>;
  // WS-4 Token-for-Goods dependencies (optional with defaults)
  broadcastMvcRawTx?: (rawTx: string) => Promise<string>;
  fetchMrc20Utxos?: (params: { address: string; mrc20Id: string }) => Promise<AuthoritativeMrc20Utxo[]>;
  tokenGoodsWaiters?: TokenGoodsWaiterRegistry;
  recordNotification?: (input: AgentNotificationInput) => void;
  emitLog?: (msg: string) => void;
  now?: () => number;
}

export function ensureMeNftSellerFulfillmentsSchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS me_nft_seller_fulfillments (
      order_id TEXT PRIMARY KEY,
      seller_metabot_id INTEGER NOT NULL,
      item_pin_id TEXT NOT NULL,
      buyer_address TEXT NOT NULL,
      amount_milli INTEGER NOT NULL,
      status TEXT NOT NULL,
      delivery_tx_id TEXT,
      trade_pin_id TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_me_nft_seller_fulfillments_status
    ON me_nft_seller_fulfillments(status, updated_at);
  `);
}

function rowToRecord(row: unknown[]): SellerFulfillmentRecord {
  return {
    orderId: String(row[0] ?? ''),
    sellerMetabotId: Number(row[1] ?? 0),
    itemPinId: String(row[2] ?? ''),
    buyerAddress: String(row[3] ?? ''),
    amountMilli: Number(row[4] ?? 0),
    status: (String(row[5] ?? 'failed') as SellerFulfillmentStatus),
    deliveryTxId: row[6] != null ? String(row[6]) : null,
    tradePinId: row[7] != null ? String(row[7]) : null,
    errorMessage: row[8] != null ? String(row[8]) : null,
    createdAt: Number(row[9] ?? 0),
    updatedAt: Number(row[10] ?? 0),
  };
}

export class SellerAutoFulfillDaemon {
  private readonly db: SqliteDatabase;
  private readonly saveDb: () => void;
  private readonly deps: SellerAutoFulfillDeps;
  private readonly processingOrders = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInFlight = false;

  constructor(db: SqliteDatabase, saveDb: () => void, deps: SellerAutoFulfillDeps) {
    this.db = db;
    this.saveDb = saveDb;
    this.deps = deps;
    ensureMeNftSellerFulfillmentsSchema(db);
    ensureFtOrderTables(db);
    ensureTokenForGoodsSchema(db);
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(msg: string): void {
    if (this.deps.emitLog) this.deps.emitLog(msg);
    else console.log(msg);
  }

  getFulfillment(orderId: string): SellerFulfillmentRecord | null {
    const res = this.db.exec(
      `SELECT order_id, seller_metabot_id, item_pin_id, buyer_address, amount_milli,
              status, delivery_tx_id, trade_pin_id, error_message, created_at, updated_at
       FROM me_nft_seller_fulfillments
       WHERE order_id = ?`,
      [orderId],
    );
    const row = res[0]?.values?.[0];
    return row ? rowToRecord(row) : null;
  }

  listFulfillments(sellerMetabotId?: number): SellerFulfillmentRecord[] {
    const res = sellerMetabotId != null
      ? this.db.exec(
        `SELECT order_id, seller_metabot_id, item_pin_id, buyer_address, amount_milli,
                status, delivery_tx_id, trade_pin_id, error_message, created_at, updated_at
         FROM me_nft_seller_fulfillments
         WHERE seller_metabot_id = ?
         ORDER BY updated_at DESC`,
        [sellerMetabotId],
      )
      : this.db.exec(
        `SELECT order_id, seller_metabot_id, item_pin_id, buyer_address, amount_milli,
                status, delivery_tx_id, trade_pin_id, error_message, created_at, updated_at
         FROM me_nft_seller_fulfillments
         ORDER BY updated_at DESC`,
      );
    return (res[0]?.values ?? []).map(rowToRecord);
  }

  private upsertFulfillment(input: {
    orderId: string;
    sellerMetabotId: number;
    itemPinId: string;
    buyerAddress: string;
    amountMilli: number;
    status: SellerFulfillmentStatus;
    deliveryTxId?: string | null;
    tradePinId?: string | null;
    errorMessage?: string | null;
  }): void {
    const now = this.nowMs();
    const existing = this.getFulfillment(input.orderId);
    if (!existing) {
      this.db.run(
        `INSERT INTO me_nft_seller_fulfillments (
          order_id, seller_metabot_id, item_pin_id, buyer_address, amount_milli,
          status, delivery_tx_id, trade_pin_id, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.orderId,
          input.sellerMetabotId,
          input.itemPinId,
          input.buyerAddress,
          input.amountMilli,
          input.status,
          input.deliveryTxId ?? null,
          input.tradePinId ?? null,
          input.errorMessage ?? null,
          now,
          now,
        ],
      );
    } else {
      this.db.run(
        `UPDATE me_nft_seller_fulfillments
         SET status = ?,
             delivery_tx_id = COALESCE(?, delivery_tx_id),
             trade_pin_id = COALESCE(?, trade_pin_id),
             error_message = ?,
             updated_at = ?
         WHERE order_id = ?`,
        [
          input.status,
          input.deliveryTxId === undefined ? null : input.deliveryTxId,
          input.tradePinId === undefined ? null : input.tradePinId,
          input.errorMessage ?? null,
          now,
          input.orderId,
        ],
      );
    }
    this.saveDb();
  }

  private getSigner(metabotId: number): {
    signer: MeNftEscrowSigner;
    mvcAddress: string;
    btcAddress?: string;
    globalMetaId?: string;
  } | null {
    const store = this.deps.getMetabotStore();
    const bot = store.getMetabotById(metabotId);
    const wallet = store.getMetabotWalletByMetabotId(metabotId);
    if (!bot || bot.enabled === false || !bot.mvc_address || !wallet?.mnemonic?.trim()) {
      return null;
    }
    return {
      signer: { mnemonic: wallet.mnemonic, path: wallet.path },
      mvcAddress: bot.mvc_address,
      btcAddress: bot.btc_address || undefined,
      globalMetaId: bot.globalmetaid || undefined,
    };
  }

  /**
   * Fast-path hook called by `privateChatDaemon` when an inbound `/protocols/simplemsg`
   * message arrives. Handles `idbots-trade-v1` payloads cleanly before LLM.
   */
  async handleIncomingTradeMessage(params: {
    metabotId: number;
    fromGlobalMetaId: string;
    plaintext: string;
  }): Promise<{ handled: boolean; type?: string; orderId?: string }> {
    const msg = parseGoodsTradeWireMessage(params.plaintext);
    if (!msg) return { handled: false };

    if (msg.type === 'ME_ESCROW_LOCKED_V1') {
      await this.processEscrowOrder(params.metabotId, msg.orderId, {
        source: 'a2a_message',
        buyerMetaIdHint: params.fromGlobalMetaId || msg.buyerGlobalMetaId,
      });
      return { handled: true, type: msg.type, orderId: msg.orderId };
    }

    if (msg.type === 'ME_DELIVERY_DONE_V1') {
      this.deps.emitToRenderer?.('goodsTrade:purchaseSettled', {
        metabotId: params.metabotId,
        orderId: msg.orderId,
        itemPinId: msg.itemPinId,
        deliveryTxId: msg.deliveryTxId,
        amountMilli: msg.settledAmountMilli,
        sellerGlobalMetaId: msg.sellerMetaId || params.fromGlobalMetaId,
        buyerAddress: msg.buyerNftAddress,
        source: 'a2a_message',
      });
      return { handled: true, type: msg.type, orderId: msg.orderId };
    }

    if (msg.type === 'ME_ESCROW_REJECTED_V1') {
      this.deps.emitToRenderer?.('goodsTrade:orderRejected', {
        metabotId: params.metabotId,
        orderId: msg.orderId,
        itemPinId: msg.itemPinId,
        reason: msg.reason,
        sellerGlobalMetaId: params.fromGlobalMetaId,
      });
      return { handled: true, type: msg.type, orderId: msg.orderId };
    }

    if (msg.type === 'GOODS_QUOTE_ACCEPT_V1') {
      try {
        recordAcceptedGoodsQuote(this.deps.getSellIntentKv(), params.metabotId, {
          inquiryId: msg.inquiryId,
          itemPinId: msg.itemPinId,
          agreedCurrency: msg.agreedCurrency ?? 'me',
          agreedAmountMilli: msg.agreedAmountMilli,
          validUntil: msg.validUntil ?? Math.floor(this.nowMs() / 1000) + 3_600,
          sellerBotAddress: msg.sellerBotAddress,
          ...(msg.sellerPayeeAddress ? { sellerPayeeAddress: msg.sellerPayeeAddress } : {}),
          buyerGlobalMetaId: params.fromGlobalMetaId,
        });
      } catch (error) {
        this.log(`[SellerAutoFulfill] Failed to record GOODS_QUOTE_ACCEPT_V1: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Keep conversational delivery so buyer bot/owner sees the quote
      return { handled: false, type: msg.type, orderId: msg.inquiryId };
    }

    if (msg.type === 'ME_FT_ESCROW_LOCKED_V1') {
      await this.processFtEscrowOrder(params.metabotId, msg.orderId, {
        source: 'a2a_message',
        buyerMetaIdHint: params.fromGlobalMetaId || msg.buyerGlobalMetaId,
      });
      return { handled: true, type: msg.type, orderId: msg.orderId };
    }

    if (msg.type === 'ME_FT_DELIVERY_DONE_V1') {
      this.deps.emitToRenderer?.('ftTrade:orderFilled', {
        role: 'buyer',
        orderId: msg.orderId,
        metabotId: params.metabotId,
        assetKey: msg.assetKey,
        chain: msg.chain,
        rail: 'me-escrow',
        tokenAmountBase: msg.tokenAmountBase,
        filledTxId: msg.deliveryTxId,
        priceMeMilli: msg.settledAmountMilli,
        sellerGlobalMetaId: msg.sellerMetaId || params.fromGlobalMetaId,
        settledAt: this.nowMs(),
      });
      return { handled: true, type: msg.type, orderId: msg.orderId };
    }

    if (msg.type === 'ME_FT_ESCROW_REJECTED_V1') {
      this.deps.emitToRenderer?.('goodsTrade:orderRejected', {
        metabotId: params.metabotId,
        orderId: msg.orderId,
        assetKey: msg.assetKey,
        reason: msg.reason,
        sellerGlobalMetaId: params.fromGlobalMetaId,
      });
      return { handled: true, type: msg.type, orderId: msg.orderId };
    }

    // --- WS-4 Token-for-Goods A2A Fast Paths ---
    const waiters = this.deps.tokenGoodsWaiters ?? defaultTokenGoodsWaiters;

    if (msg.type === 'FT_GOODS_ATOMIC_PROPOSAL_V1') {
      await this.handleFtGoodsAtomicProposal(params.metabotId, params.fromGlobalMetaId, msg);
      return { handled: true, type: msg.type, orderId: msg.proposalId };
    }

    if (msg.type === 'FT_GOODS_ATOMIC_SETTLED_V1') {
      if (msg.proposalId) {
        waiters.notify(`atomic:${msg.proposalId}`, {
          kind: 'atomic_settled',
          proposalId: msg.proposalId,
          itemPinId: msg.itemPinId,
          txId: msg.txId,
        });
      }
      waiters.notify(`atomic_item:${msg.itemPinId}`, {
        kind: 'atomic_settled',
        proposalId: msg.proposalId,
        itemPinId: msg.itemPinId,
        txId: msg.txId,
      });
      this.deps.emitToRenderer?.('goodsTrade:purchaseSettled', {
        metabotId: params.metabotId,
        orderId: msg.proposalId || msg.txId,
        itemPinId: msg.itemPinId,
        deliveryTxId: msg.txId,
        amountMilli: 0,
        assetKey: msg.assetKey,
        amountBase: msg.amountBase,
        sellerGlobalMetaId: msg.sellerMetaId || params.fromGlobalMetaId,
        buyerAddress: msg.buyerNftAddress,
        source: 'a2a_token_atomic',
      });
      return { handled: true, type: msg.type, orderId: msg.proposalId || msg.itemPinId };
    }

    if (msg.type === 'FT_GOODS_ATOMIC_REJECTED_V1') {
      if (msg.proposalId) {
        waiters.notify(`atomic:${msg.proposalId}`, {
          kind: 'atomic_rejected',
          proposalId: msg.proposalId,
          itemPinId: msg.itemPinId,
          reason: msg.reason,
        });
      }
      waiters.notify(`atomic_item:${msg.itemPinId}`, {
        kind: 'atomic_rejected',
        proposalId: msg.proposalId,
        itemPinId: msg.itemPinId,
        reason: msg.reason,
      });
      this.deps.emitToRenderer?.('goodsTrade:orderRejected', {
        metabotId: params.metabotId,
        orderId: msg.proposalId || msg.itemPinId,
        itemPinId: msg.itemPinId,
        reason: msg.reason,
        sellerGlobalMetaId: params.fromGlobalMetaId,
      });
      return { handled: true, type: msg.type, orderId: msg.proposalId || msg.itemPinId };
    }

    if (msg.type === 'TOKEN_GOODS_RESERVE_V1') {
      await this.handleTokenGoodsReserve(params.metabotId, params.fromGlobalMetaId, msg);
      return { handled: true, type: msg.type, orderId: msg.reserveRequestId || msg.itemPinId };
    }

    if (msg.type === 'TOKEN_GOODS_RESERVED_V1') {
      const ev = {
        kind: 'reserved' as const,
        reservationId: msg.reservationId,
        sellerReceiveAddress: msg.sellerReceiveAddress,
        amountBase: msg.amountBase,
        expiresAt: msg.expiresAt,
      };
      if (msg.reserveRequestId) waiters.notify(`reserve:${msg.reserveRequestId}`, ev);
      waiters.notify(`reserve_item:${msg.itemPinId}:${msg.assetKey}`, ev);
      return { handled: true, type: msg.type, orderId: msg.reservationId };
    }

    if (msg.type === 'TOKEN_GOODS_RESERVE_REJECTED_V1') {
      const ev = { kind: 'reserve_rejected' as const, reason: msg.reason };
      if (msg.reserveRequestId) waiters.notify(`reserve:${msg.reserveRequestId}`, ev);
      if (msg.assetKey) waiters.notify(`reserve_item:${msg.itemPinId}:${msg.assetKey}`, ev);
      return { handled: true, type: msg.type, orderId: msg.reserveRequestId || msg.itemPinId };
    }

    if (msg.type === 'TOKEN_GOODS_PAID_V1') {
      await this.handleTokenGoodsPaid(params.metabotId, params.fromGlobalMetaId, msg);
      return { handled: true, type: msg.type, orderId: msg.reservationId };
    }

    if (msg.type === 'TOKEN_GOODS_DELIVERED_V1') {
      waiters.notify(`deliver:${msg.reservationId}`, {
        kind: 'delivered',
        reservationId: msg.reservationId,
        nftDeliveryTxId: msg.nftDeliveryTxId,
      });
      this.deps.emitToRenderer?.('goodsTrade:purchaseSettled', {
        metabotId: params.metabotId,
        orderId: msg.reservationId,
        itemPinId: msg.itemPinId || '',
        deliveryTxId: msg.nftDeliveryTxId,
        amountMilli: 0,
        assetKey: msg.assetKey,
        amountBase: msg.amountBase,
        sellerGlobalMetaId: msg.sellerMetaId || params.fromGlobalMetaId,
        source: 'a2a_token_delivered',
      });
      return { handled: true, type: msg.type, orderId: msg.reservationId };
    }

    if (msg.type === 'TOKEN_GOODS_DELIVERY_REJECTED_V1') {
      waiters.notify(`deliver:${msg.reservationId}`, {
        kind: 'delivery_rejected',
        reservationId: msg.reservationId,
        reason: msg.reason,
      });
      this.deps.emitToRenderer?.('goodsTrade:orderRejected', {
        metabotId: params.metabotId,
        orderId: msg.reservationId,
        itemPinId: msg.itemPinId,
        reason: msg.reason,
        sellerGlobalMetaId: params.fromGlobalMetaId,
      });
      return { handled: true, type: msg.type, orderId: msg.reservationId };
    }

    if (msg.type === 'GOODS_INQUIRY_V1') {
      return { handled: false, type: msg.type, orderId: msg.inquiryId };
    }
    return { handled: false };
  }

  /**
   * Process one seller escrow order through the 6 strict safety checks and
   * crash-safe SQLite delivery state machine.
   */
  async processEscrowOrder(
    sellerMetabotId: number,
    orderId: string,
    opts?: { source?: 'a2a_message' | 'escrow_poll'; buyerMetaIdHint?: string },
  ): Promise<{ outcome: 'settled' | 'rejected' | 'skipped' | 'failed'; reason?: string; deliveryTxId?: string }> {
    const normalizedOrderId = String(orderId ?? '').trim();
    if (!normalizedOrderId) return { outcome: 'skipped', reason: 'empty_order_id' };

    if (this.processingOrders.has(normalizedOrderId)) {
      return { outcome: 'skipped', reason: 'already_in_flight' };
    }

    const existing = this.getFulfillment(normalizedOrderId);
    if (existing?.status === 'settled' || existing?.status === 'rejected') {
      return { outcome: 'skipped', reason: `already_${existing.status}`, deliveryTxId: existing.deliveryTxId ?? undefined };
    }

    const identity = this.getSigner(sellerMetabotId);
    if (!identity) {
      return { outcome: 'skipped', reason: 'seller_bot_unavailable' };
    }

    this.processingOrders.add(normalizedOrderId);
    try {
      const fetchOrder = this.deps.getEscrowOrder ?? getNftEscrowOrder;
      const order = await fetchOrder(identity.signer, normalizedOrderId);

      // Crash-recovery fast path: NFT transfer already broadcast in an earlier run;
      // NEVER re-transfer! Only finish /deliver + local state + receipt + DM.
      if (existing?.status === 'transferred' && existing.deliveryTxId) {
        this.log(`[SellerAutoFulfill] Crash-recovery resuming /deliver for order ${normalizedOrderId} (tx=${existing.deliveryTxId})`);
        return await this.completeDeliveryAfterTransfer({
          sellerMetabotId,
          identity,
          order,
          deliveryTxId: existing.deliveryTxId,
          buyerMetaIdHint: opts?.buyerMetaIdHint,
        });
      }

      const rawBuyerAddress = order.buyerNftAddress || order.buyerAddress;

      // Check 1: Authoritative ABS order must be 'FROZEN_AWAITING_DELIVERY' (status=1) and addressed to this seller bot
      const isAwaitingDelivery = order.status === 'FROZEN_AWAITING_DELIVERY' || order.statusCode === 1;
      if (!isAwaitingDelivery) {
        if (
          order.status === 'SETTLED'
          || order.status === 'DELIVERY_SUBMITTED'
          || order.statusCode === 3
          || order.statusCode === 2
        ) {
          this.upsertFulfillment({
            orderId: normalizedOrderId,
            sellerMetabotId,
            itemPinId: order.itemPinId,
            buyerAddress: rawBuyerAddress,
            amountMilli: order.amountMilli,
            status: 'settled',
            deliveryTxId: order.deliveryTxId ?? existing?.deliveryTxId ?? null,
          });
        } else if (
          order.status === 'CANCELED_REFUNDED'
          || order.status === 'EXPIRED_REFUNDED'
          || order.statusCode === 5
          || order.statusCode === 4
        ) {
          this.upsertFulfillment({
            orderId: normalizedOrderId,
            sellerMetabotId,
            itemPinId: order.itemPinId,
            buyerAddress: rawBuyerAddress,
            amountMilli: order.amountMilli,
            status: 'rejected',
            errorMessage: order.rejectReason ?? order.status ?? 'rejected_on_server',
          });
        }
        return { outcome: 'skipped', reason: `order_status_${order.status}` };
      }

      const orderSellerAddress = order.sellerBotAddress || order.sellerAddress;
      if (orderSellerAddress.toLowerCase() !== identity.mvcAddress.toLowerCase()) {
        return { outcome: 'skipped', reason: 'seller_address_mismatch' };
      }

      // Check 2: Local active sell-intent OR unexpired seller-authorized quote exists
      const findIntent = this.deps.findLocalActiveSellIntent
        ?? ((botId: number, pinId: string) => findLocalActiveSellIntentForItem(this.deps.getSellIntentKv(), botId, pinId));
      const sellIntent = findIntent(sellerMetabotId, order.itemPinId);
      const nowSec = Math.floor(this.nowMs() / 1000);
      const findAuthorizedQuote = this.deps.findSellerAuthorizedQuote
        ?? ((botId: number, pinId: string, buyerAddr?: string) =>
          findSellerAuthorizedQuoteForOrder(this.deps.getSellIntentKv(), botId, pinId, buyerAddr, nowSec));
      const authorizedQuote = findAuthorizedQuote(sellerMetabotId, order.itemPinId, rawBuyerAddress);

      if (!sellIntent && !authorizedQuote) {
        return await this.rejectLockedOrder(
          sellerMetabotId,
          identity,
          order,
          'no_active_sell_intent_for_item',
          opts?.buyerMetaIdHint,
        );
      }
      if (!authorizedQuote && sellIntent && (sellIntent.autoFulfillMe === false || sellIntent.intent.autoFulfillMe === false)) {
        // Explicit manual-fulfill preference: do not auto-transfer and do not auto-reject.
        return { outcome: 'skipped', reason: 'auto_fulfill_disabled_by_seller' };
      }

      // Check 3: Price verification (quote-authorized price overrides listing price; otherwise >= declared ME price)
      if (authorizedQuote) {
        if (order.amountMilli < authorizedQuote.agreedAmountMilli) {
          return await this.rejectLockedOrder(
            sellerMetabotId,
            identity,
            order,
            `price_below_agreed_quote (got ${order.amountMilli}, required ${authorizedQuote.agreedAmountMilli})`,
            opts?.buyerMetaIdHint,
          );
        }
      } else if (sellIntent) {
        const declaredMeMilli = sellIntent.intent.prices?.me?.amountMilli;
        if (declaredMeMilli == null || declaredMeMilli <= 0 || order.amountMilli < declaredMeMilli) {
          return await this.rejectLockedOrder(
            sellerMetabotId,
            identity,
            order,
            `price_below_listing (got ${order.amountMilli}, required ${declaredMeMilli ?? 'none'})`,
            opts?.buyerMetaIdHint,
          );
        }
      }

      // Check 4: Live on-chain holder verification (not burned, still owned by seller bot)
      const fetchItem = this.deps.fetchItemInfo ?? ((pinId: string) => fetchMrc721ItemInfo({ pinId }));
      const liveItem = await fetchItem(order.itemPinId);
      if (!liveItem || liveItem.burned || (liveItem.ownerAddress ?? '').toLowerCase() !== identity.mvcAddress.toLowerCase()) {
        return await this.rejectLockedOrder(
          sellerMetabotId,
          identity,
          order,
          'seller_no_longer_holds_item',
          opts?.buyerMetaIdHint,
        );
      }

      // Check 5: Buyer address validity & self-trade prevention
      let validBuyerAddress: string;
      try {
        validBuyerAddress = assertEscrowMvcAddress(rawBuyerAddress, 'buyerNftAddress');
      } catch {
        return await this.rejectLockedOrder(
          sellerMetabotId,
          identity,
          order,
          'invalid_buyer_address',
          opts?.buyerMetaIdHint,
        );
      }
      if (validBuyerAddress.toLowerCase() === identity.mvcAddress.toLowerCase()) {
        return await this.rejectLockedOrder(
          sellerMetabotId,
          identity,
          order,
          'self_trade_prohibited',
          opts?.buyerMetaIdHint,
        );
      }

      // Check 5.5: Mutual exclusion against active 5-minute token-for-goods reservations
      expireStaleTokenGoodsReservations(this.db, this.nowMs(), this.saveDb);
      const tokenLock = hasActiveItemLock(this.db, order.itemPinId, this.nowMs());
      if (tokenLock.locked) {
        return await this.rejectLockedOrder(
          sellerMetabotId,
          identity,
          order,
          tokenLock.reason || 'item_reserved_by_token_order',
          opts?.buyerMetaIdHint,
        );
      }

      // Check 6: Persist 'processing' BEFORE transfer, then persist 'transferred' + deliveryTxId BEFORE /deliver
      this.upsertFulfillment({
        orderId: normalizedOrderId,
        sellerMetabotId,
        itemPinId: order.itemPinId,
        buyerAddress: validBuyerAddress,
        amountMilli: order.amountMilli,
        status: 'processing',
      });

      const transferResult = await this.deps.transferMrc721Item({
        metabotId: sellerMetabotId,
        pinId: order.itemPinId,
        toAddress: validBuyerAddress,
      });

      this.upsertFulfillment({
        orderId: normalizedOrderId,
        sellerMetabotId,
        itemPinId: order.itemPinId,
        buyerAddress: validBuyerAddress,
        amountMilli: order.amountMilli,
        status: 'transferred',
        deliveryTxId: transferResult.txId,
      });

      return await this.completeDeliveryAfterTransfer({
        sellerMetabotId,
        identity,
        order,
        deliveryTxId: transferResult.txId,
        collectionPinId: sellIntent?.intent.collectionPinId ?? liveItem.collectionPinId,
        buyerMetaIdHint: opts?.buyerMetaIdHint,
        authorizedQuoteInquiryId: authorizedQuote?.inquiryId,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log(`[SellerAutoFulfill] Order ${normalizedOrderId} failed: ${errMsg}`);
      const current = this.getFulfillment(normalizedOrderId);
      if (current && current.status !== 'transferred' && current.status !== 'settled' && current.status !== 'rejected') {
        this.upsertFulfillment({
          orderId: normalizedOrderId,
          sellerMetabotId,
          itemPinId: current.itemPinId,
          buyerAddress: current.buyerAddress,
          amountMilli: current.amountMilli,
          status: 'failed',
          errorMessage: errMsg,
        });
      }
      return { outcome: 'failed', reason: errMsg };
    } finally {
      this.processingOrders.delete(normalizedOrderId);
    }
  }

  private async rejectLockedOrder(
    sellerMetabotId: number,
    identity: { signer: MeNftEscrowSigner; mvcAddress: string; globalMetaId?: string },
    order: MeNftEscrowOrder,
    reason: string,
    buyerMetaIdHint?: string,
  ): Promise<{ outcome: 'rejected'; reason: string }> {
    const doReject = this.deps.rejectEscrowOrder ?? rejectNftEscrowOrder;
    await doReject(identity.signer, order.orderId, { reason });
    this.upsertFulfillment({
      orderId: order.orderId,
      sellerMetabotId,
      itemPinId: order.itemPinId,
      buyerAddress: order.buyerAddress,
      amountMilli: order.amountMilli,
      status: 'rejected',
      errorMessage: reason,
    });
    const buyerMetaId = order.buyerMetaId || buyerMetaIdHint;
    if (buyerMetaId && this.deps.sendTradeMessage) {
      try {
        const wire = formatGoodsTradeWireMessage({
          type: 'ME_ESCROW_REJECTED_V1',
          orderId: order.orderId,
          itemPinId: order.itemPinId,
          reason,
        });
        await this.deps.sendTradeMessage({
          metabotId: sellerMetabotId,
          toGlobalMetaId: buyerMetaId,
          content: `${wire}\n\n[ME Escrow Rejected] Order ${order.orderId} rejected: ${reason} (ME refunded).`,
        });
      } catch (err) {
        this.log(`[SellerAutoFulfill] Failed to send ME_ESCROW_REJECTED_V1 DM: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { outcome: 'rejected', reason };
  }

  private async completeDeliveryAfterTransfer(input: {
    sellerMetabotId: number;
    identity: { signer: MeNftEscrowSigner; mvcAddress: string; globalMetaId?: string };
    order: MeNftEscrowOrder;
    deliveryTxId: string;
    collectionPinId?: string;
    buyerMetaIdHint?: string;
    authorizedQuoteInquiryId?: string;
  }): Promise<{ outcome: 'settled'; deliveryTxId: string }> {
    const { sellerMetabotId, identity, order, deliveryTxId } = input;
    const rawBuyerAddress = order.buyerNftAddress || order.buyerAddress;
    const doDeliver = this.deps.deliverEscrowOrder ?? deliverNftEscrowOrder;
    await doDeliver(identity.signer, order.orderId, { deliveryTxId });

    // Mark local sell intent as sold
    const markSold = this.deps.markSellIntentSold
      ?? ((botId: number, pinId: string, meta?: { orderId?: string; txId?: string }) =>
        markMrc721SellIntentSold(this.deps.getSellIntentKv(), botId, pinId, meta));
    try {
      markSold(sellerMetabotId, order.itemPinId, { orderId: order.orderId, txId: deliveryTxId });
    } catch (err) {
      this.log(`[SellerAutoFulfill] Failed to mark local sell intent sold: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Mark any seller-authorized quote as used
    const markQuoteUsed = this.deps.markSellerAuthorizedQuoteUsed
      ?? ((botId: number, pinId: string, meta?: { inquiryId?: string; orderId?: string }) =>
        markSellerAuthorizedQuoteUsed(this.deps.getSellIntentKv(), botId, pinId, meta));
    try {
      markQuoteUsed(sellerMetabotId, order.itemPinId, {
        inquiryId: input.authorizedQuoteInquiryId,
        orderId: order.orderId,
      });
    } catch (err) {
      this.log(`[SellerAutoFulfill] Failed to mark seller authorized quote used: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Best-effort /protocols/mrc721trade receipt pin
    let tradePinId: string | undefined;
    const buyerMetaId = order.buyerMetaId || input.buyerMetaIdHint;
    if (this.deps.broadcastTradeReceipt) {
      try {
        const receipt = await this.deps.broadcastTradeReceipt({
          metabotId: sellerMetabotId,
          txId: deliveryTxId,
          orderId: order.orderId,
          itemPinId: order.itemPinId,
          collectionPinId: input.collectionPinId || order.collectionPinId,
          sellerAddress: identity.mvcAddress,
          sellerMetaId: identity.globalMetaId,
          buyerAddress: rawBuyerAddress,
          buyerMetaId,
          amountMilli: order.amountMilli,
        });
        tradePinId = receipt.pinId;
      } catch (err) {
        this.log(`[SellerAutoFulfill] Best-effort /protocols/mrc721trade receipt failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.upsertFulfillment({
      orderId: order.orderId,
      sellerMetabotId,
      itemPinId: order.itemPinId,
      buyerAddress: rawBuyerAddress,
      amountMilli: order.amountMilli,
      status: 'settled',
      deliveryTxId,
      tradePinId: tradePinId ?? null,
    });

    // Best-effort ME_DELIVERY_DONE_V1 A2A DM to buyer
    if (buyerMetaId && this.deps.sendTradeMessage) {
      try {
        const wire = formatGoodsTradeWireMessage({
          type: 'ME_DELIVERY_DONE_V1',
          orderId: order.orderId,
          itemPinId: order.itemPinId,
          deliveryTxId,
          settledAmountMilli: order.amountMilli,
          sellerMetaId: identity.globalMetaId,
          buyerNftAddress: rawBuyerAddress,
        });
        await this.deps.sendTradeMessage({
          metabotId: sellerMetabotId,
          toGlobalMetaId: buyerMetaId,
          content: `${wire}\n\n[ME Escrow Delivered] Item ${order.itemPinId} transferred in tx ${deliveryTxId}.`,
        });
      } catch (err) {
        this.log(`[SellerAutoFulfill] Best-effort ME_DELIVERY_DONE_V1 DM failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.deps.emitToRenderer?.('goodsTrade:autoSold', {
      orderId: order.orderId,
      sellerMetabotId,
      itemPinId: order.itemPinId,
      buyerAddress: rawBuyerAddress,
      amountMilli: order.amountMilli,
      deliveryTxId,
      ...(tradePinId ? { tradePinId } : {}),
      settledAt: this.nowMs(),
    } satisfies SellerAutoSoldEvent);

    return { outcome: 'settled', deliveryTxId };
  }

  getFtFulfillment(orderId: string): MeFtSellerFulfillmentRecord | null {
    return getMeFtFulfillmentRecord(this.db, orderId);
  }

  private hasPendingOrActiveFtSellerWork(metabotId: number): boolean {
    if (this.deps.listFtEscrowOrders) return true;
    const activeMeLots = listFtActiveOrders(this.db, {
      metabotId,
      status: 'active',
      rails: ['me-escrow'],
    });
    if (activeMeLots.length > 0) return true;
    const pendingRes = this.db.exec(
      `SELECT COUNT(*) FROM me_ft_seller_fulfillments
       WHERE seller_metabot_id = ? AND status IN ('transferring', 'transferred')`,
      [metabotId],
    );
    return Number(pendingRes[0]?.values?.[0]?.[0] ?? 0) > 0;
  }

  /**
   * Process one seller FT ME escrow order (`REQ-1-02`) with 6 strict safety
   * checks + SQLite crash-recovery idempotency (`me_ft_seller_fulfillments`).
   */
  async processFtEscrowOrder(
    sellerMetabotId: number,
    orderId: string,
    opts?: { source?: 'a2a_message' | 'escrow_poll'; buyerMetaIdHint?: string },
  ): Promise<{
    outcome: 'settled' | 'rejected' | 'skipped' | 'failed';
    reason?: string;
    deliveryTxId?: string;
  }> {
    const normalizedOrderId = String(orderId ?? '').trim();
    if (!normalizedOrderId) return { outcome: 'skipped', reason: 'empty_order_id' };

    const flightKey = `ft:${normalizedOrderId}`;
    if (this.processingOrders.has(flightKey)) {
      return { outcome: 'skipped', reason: 'already_in_flight' };
    }

    const existing = getMeFtFulfillmentRecord(this.db, normalizedOrderId);
    if (existing?.status === 'delivered' || existing?.status === 'rejected') {
      return {
        outcome: 'skipped',
        reason: `already_${existing.status}`,
        deliveryTxId: existing.deliveryTxId,
      };
    }

    const identity = this.getSigner(sellerMetabotId);
    if (!identity) {
      return { outcome: 'skipped', reason: 'seller_bot_unavailable' };
    }

    this.processingOrders.add(flightKey);
    try {
      const fetchOrder = this.deps.getFtEscrowOrder ?? getFtEscrowOrder;
      const order = await fetchOrder(identity.signer, normalizedOrderId);

      // Crash-recovery fast path: FT/MRC-20 transfer already broadcast in an earlier run;
      // NEVER re-send tokens! Resume /deliver + local order update + DM + notification.
      if (existing?.status === 'transferred' && existing.deliveryTxId) {
        this.log(
          `[SellerAutoFulfill/FT] Crash-recovery resuming /deliver for order ${normalizedOrderId} (tx=${existing.deliveryTxId})`,
        );
        const localForRecovery = existing.listingKey
          ? listFtActiveOrders(this.db, { metabotId: sellerMetabotId }).find(
              (r) => r.listingKey === existing.listingKey,
            ) ?? null
          : null;
        return await this.completeFtDeliveryAfterTransfer({
          sellerMetabotId,
          identity,
          order,
          localOrder: localForRecovery,
          deliveryTxId: existing.deliveryTxId,
          createdAt: existing.createdAt,
          buyerMetaIdHint: opts?.buyerMetaIdHint,
        });
      }

      // Check 1: Authoritative ABS order must be FROZEN_AWAITING_DELIVERY and addressed to this seller bot
      if (order.status !== 'FROZEN_AWAITING_DELIVERY') {
        if (
          order.status === 'SETTLED' ||
          order.status === 'RELEASED_TO_SELLER' ||
          order.status === 'DELIVERY_SUBMITTED'
        ) {
          const now = this.nowMs();
          upsertMeFtFulfillmentRecord(
            this.db,
            {
              orderId: normalizedOrderId,
              sellerMetabotId,
              listingKey: order.listingKey,
              assetKey: order.assetKey,
              chain: order.chain,
              tokenAmountBase: order.tokenAmountBase,
              buyerReceiveAddress: order.buyerReceiveAddress,
              amountMilli: order.amountMilli,
              status: 'delivered',
              deliveryTxId: order.deliveryTxId ?? existing?.deliveryTxId,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            },
            this.saveDb,
          );
        }
        return { outcome: 'skipped', reason: `order_status_${order.status}` };
      }

      if (order.sellerBotAddress.toLowerCase() !== identity.mvcAddress.toLowerCase()) {
        return { outcome: 'skipped', reason: 'seller_address_mismatch' };
      }

      // Check 2: Local active FT ME sell listing with autoFulfillMe === true
      const localOrder = findActiveMeFtOrderForEscrow(this.db, {
        metabotId: sellerMetabotId,
        assetKey: order.assetKey,
        listingKey: order.listingKey,
        lockedUtxoOutpoint: order.lockedUtxoOutpoint,
      });
      if (!localOrder) {
        return await this.rejectLockedFtOrder(
          sellerMetabotId,
          identity,
          order,
          'no_active_ft_sell_order',
          opts?.buyerMetaIdHint,
        );
      }

      // Check 3: Exact assetKey, chain, ME price floor, and BigInt quantity ceiling
      if (order.chain !== localOrder.chain || order.assetKey !== localOrder.assetKey) {
        return await this.rejectLockedFtOrder(
          sellerMetabotId,
          identity,
          order,
          'asset_or_chain_mismatch',
          opts?.buyerMetaIdHint,
        );
      }
      if (
        localOrder.priceMeMilli == null ||
        localOrder.priceMeMilli <= 0 ||
        order.amountMilli < localOrder.priceMeMilli
      ) {
        return await this.rejectLockedFtOrder(
          sellerMetabotId,
          identity,
          order,
          `price_below_listing (got ${order.amountMilli}, required ${localOrder.priceMeMilli ?? 'none'})`,
          opts?.buyerMetaIdHint,
        );
      }

      let requestedBase: bigint;
      let lotBase: bigint;
      try {
        requestedBase = BigInt(order.tokenAmountBase);
        lotBase = BigInt(localOrder.amountBase);
      } catch {
        return await this.rejectLockedFtOrder(
          sellerMetabotId,
          identity,
          order,
          'invalid_token_amount_base',
          opts?.buyerMetaIdHint,
        );
      }
      if (requestedBase <= 0n || requestedBase > lotBase) {
        return await this.rejectLockedFtOrder(
          sellerMetabotId,
          identity,
          order,
          `token_amount_exceeds_lot (requested ${requestedBase.toString()}, lot ${lotBase.toString()})`,
          opts?.buyerMetaIdHint,
        );
      }

      // Check 4: Buyer receive address validity & self-trade prevention
      let validReceiveAddress: string;
      try {
        validReceiveAddress = validateFtReceiveAddress(order.buyerReceiveAddress, order.chain);
      } catch {
        return await this.rejectLockedFtOrder(
          sellerMetabotId,
          identity,
          order,
          'invalid_buyer_receive_address',
          opts?.buyerMetaIdHint,
        );
      }

      const sellerOwnChainAddr =
        order.chain === 'btc' ? identity.btcAddress || '' : identity.mvcAddress;
      if (
        order.buyerBotAddress.toLowerCase() === identity.mvcAddress.toLowerCase() ||
        (sellerOwnChainAddr &&
          validReceiveAddress.toLowerCase() === sellerOwnChainAddr.toLowerCase())
      ) {
        return await this.rejectLockedFtOrder(
          sellerMetabotId,
          identity,
          order,
          'self_trade_prohibited',
          opts?.buyerMetaIdHint,
        );
      }

      // Check 5: Persist 'transferring' lock BEFORE broadcasting on-chain FT/MRC-20 transfer
      const createdAt = existing?.createdAt ?? this.nowMs();
      upsertMeFtFulfillmentRecord(
        this.db,
        {
          orderId: normalizedOrderId,
          sellerMetabotId,
          listingKey: localOrder.listingKey,
          assetKey: order.assetKey,
          chain: order.chain,
          tokenAmountBase: requestedBase.toString(),
          buyerReceiveAddress: validReceiveAddress,
          amountMilli: order.amountMilli,
          status: 'transferring',
          createdAt,
          updatedAt: this.nowMs(),
        },
        this.saveDb,
      );

      // Check 6: Execute on-chain FT or MRC-20 transfer, persist 'transferred' + txId BEFORE /deliver
      let deliveryTxId: string;
      if (order.chain === 'mvc') {
        if (!this.deps.transferMvcFt) {
          throw new Error('transferMvcFt dependency is not configured');
        }
        const parts = localOrder.assetKey.slice('mvc-ft:'.length).split(':');
        const codehash = localOrder.codehash || parts[0] || '';
        const genesis = localOrder.genesis || parts[1] || '';
        if (!codehash || !genesis) {
          throw new Error(`Missing codehash/genesis for MVC FT order ${localOrder.listingKey}`);
        }
        const txRes = await this.deps.transferMvcFt({
          metabotId: sellerMetabotId,
          codehash,
          genesis,
          toAddress: validReceiveAddress,
          amountBase: requestedBase.toString(),
        });
        deliveryTxId = txRes.txId;
      } else {
        if (!this.deps.transferBtcMrc20) {
          throw new Error('transferBtcMrc20 dependency is not configured');
        }
        const mrc20Id = localOrder.mrc20Id || localOrder.assetKey.slice('mrc20:'.length);
        const fromAddress = identity.btcAddress || localOrder.sellerAddress || '';
        if (!mrc20Id || !fromAddress) {
          throw new Error(`Missing mrc20Id or seller BTC address for order ${localOrder.listingKey}`);
        }
        const txRes = await this.deps.transferBtcMrc20({
          metabotId: sellerMetabotId,
          mrc20Id,
          decimal: localOrder.decimals,
          symbol: localOrder.symbol,
          fromAddress,
          toAddress: validReceiveAddress,
          amountBase: requestedBase.toString(),
        });
        deliveryTxId = txRes.revealTxId;
      }

      upsertMeFtFulfillmentRecord(
        this.db,
        {
          orderId: normalizedOrderId,
          sellerMetabotId,
          listingKey: localOrder.listingKey,
          assetKey: order.assetKey,
          chain: order.chain,
          tokenAmountBase: requestedBase.toString(),
          buyerReceiveAddress: validReceiveAddress,
          amountMilli: order.amountMilli,
          status: 'transferred',
          deliveryTxId,
          createdAt,
          updatedAt: this.nowMs(),
        },
        this.saveDb,
      );

      return await this.completeFtDeliveryAfterTransfer({
        sellerMetabotId,
        identity,
        order,
        localOrder,
        deliveryTxId,
        createdAt,
        buyerMetaIdHint: opts?.buyerMetaIdHint,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log(`[SellerAutoFulfill/FT] Order ${normalizedOrderId} failed: ${errMsg}`);
      const current = getMeFtFulfillmentRecord(this.db, normalizedOrderId);
      if (
        current &&
        current.status !== 'transferred' &&
        current.status !== 'delivered' &&
        current.status !== 'rejected'
      ) {
        upsertMeFtFulfillmentRecord(
          this.db,
          {
            ...current,
            status: 'failed',
            errorMessage: errMsg,
            updatedAt: this.nowMs(),
          },
          this.saveDb,
        );
      }
      return { outcome: 'failed', reason: errMsg };
    } finally {
      this.processingOrders.delete(flightKey);
    }
  }

  private async rejectLockedFtOrder(
    sellerMetabotId: number,
    identity: {
      signer: MeNftEscrowSigner;
      mvcAddress: string;
      btcAddress?: string;
      globalMetaId?: string;
    },
    order: MeFtEscrowOrder,
    reason: string,
    buyerMetaIdHint?: string,
  ): Promise<{ outcome: 'rejected'; reason: string }> {
    const doReject = this.deps.rejectFtEscrowOrder ?? rejectFtEscrowOrder;
    await doReject(identity.signer, order.orderId, reason);
    const now = this.nowMs();
    upsertMeFtFulfillmentRecord(
      this.db,
      {
        orderId: order.orderId,
        sellerMetabotId,
        listingKey: order.listingKey,
        assetKey: order.assetKey,
        chain: order.chain,
        tokenAmountBase: order.tokenAmountBase,
        buyerReceiveAddress: order.buyerReceiveAddress,
        amountMilli: order.amountMilli,
        status: 'rejected',
        errorMessage: reason,
        createdAt: now,
        updatedAt: now,
      },
      this.saveDb,
    );
    if (buyerMetaIdHint && this.deps.sendTradeMessage) {
      try {
        const wire = formatGoodsTradeWireMessage({
          type: 'ME_FT_ESCROW_REJECTED_V1',
          orderId: order.orderId,
          assetKey: order.assetKey,
          reason,
        });
        await this.deps.sendTradeMessage({
          metabotId: sellerMetabotId,
          toGlobalMetaId: buyerMetaIdHint,
          content: `${wire}\n\n[ME FT Escrow Rejected] Order ${order.orderId} rejected: ${reason} (ME refunded).`,
        });
      } catch (err) {
        this.log(
          `[SellerAutoFulfill/FT] Failed to send ME_FT_ESCROW_REJECTED_V1 DM: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { outcome: 'rejected', reason };
  }

  private async completeFtDeliveryAfterTransfer(input: {
    sellerMetabotId: number;
    identity: {
      signer: MeNftEscrowSigner;
      mvcAddress: string;
      btcAddress?: string;
      globalMetaId?: string;
    };
    order: MeFtEscrowOrder;
    localOrder: FtActiveOrderRecord | null;
    deliveryTxId: string;
    createdAt: number;
    buyerMetaIdHint?: string;
  }): Promise<{ outcome: 'settled'; deliveryTxId: string }> {
    const { sellerMetabotId, identity, order, localOrder, deliveryTxId } = input;
    const doDeliver = this.deps.deliverFtEscrowOrder ?? deliverFtEscrowOrder;
    await doDeliver(identity.signer, order.orderId, { deliveryTxId });

    const now = this.nowMs();
    if (localOrder) {
      updateFtOrderStatus(
        this.db,
        localOrder.listingKey,
        'filled',
        { filledTxId: deliveryTxId, nowMs: now },
        this.saveDb,
      );
    }

    upsertMeFtFulfillmentRecord(
      this.db,
      {
        orderId: order.orderId,
        sellerMetabotId,
        listingKey: localOrder?.listingKey ?? order.listingKey,
        assetKey: order.assetKey,
        chain: order.chain,
        tokenAmountBase: order.tokenAmountBase,
        buyerReceiveAddress: order.buyerReceiveAddress,
        amountMilli: order.amountMilli,
        status: 'delivered',
        deliveryTxId,
        createdAt: input.createdAt,
        updatedAt: now,
      },
      this.saveDb,
    );

    if (input.buyerMetaIdHint && this.deps.sendTradeMessage) {
      try {
        const wire = formatGoodsTradeWireMessage({
          type: 'ME_FT_DELIVERY_DONE_V1',
          orderId: order.orderId,
          assetKey: order.assetKey,
          chain: order.chain,
          tokenAmountBase: order.tokenAmountBase,
          deliveryTxId,
          settledAmountMilli: order.amountMilli,
          sellerMetaId: identity.globalMetaId,
          buyerReceiveAddress: order.buyerReceiveAddress,
        });
        await this.deps.sendTradeMessage({
          metabotId: sellerMetabotId,
          toGlobalMetaId: input.buyerMetaIdHint,
          content: `${wire}\n\n[ME FT Escrow Delivered] ${order.tokenSymbol} transferred in tx ${deliveryTxId}.`,
        });
      } catch (err) {
        this.log(
          `[SellerAutoFulfill/FT] Best-effort ME_FT_DELIVERY_DONE_V1 DM failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const progress = localOrder
      ? getFtBatchOrderProgress(this.db, localOrder.batchGroupId)
      : null;
    const filledLots = progress?.filledLots ?? 1;
    const totalLots = progress?.totalLots ?? 1;
    const meDisplay = (order.amountMilli / 1000).toFixed(order.amountMilli % 1000 === 0 ? 0 : 3);

    this.deps.emitToRenderer?.('ftTrade:orderFilled', {
      role: 'seller',
      orderId: order.orderId,
      listingKey: localOrder?.listingKey ?? order.listingKey ?? order.orderId,
      batchGroupId: localOrder?.batchGroupId ?? order.listingKey ?? order.orderId,
      metabotId: sellerMetabotId,
      assetKey: order.assetKey,
      symbol: localOrder?.symbol ?? order.tokenSymbol,
      rail: 'me-escrow',
      amountDisplay: localOrder?.amountDisplay ?? order.tokenAmountBase,
      priceMeMilli: order.amountMilli,
      filledTxId: deliveryTxId,
      filledLots,
      totalLots,
      settledAt: now,
    });

    this.deps.recordNotification?.({
      eventId: `ft-me-sold:${order.orderId}`,
      type: 'ft.escrow.sold',
      category: 'work',
      metabotId: sellerMetabotId,
      sessionId: localOrder?.sessionId ?? null,
      taskId: null,
      runId: null,
      title: `${localOrder?.symbol ?? order.tokenSymbol} auto-fulfilled (+${meDisplay} ME)`,
      body: `Delivered ${localOrder?.amountDisplay ?? order.tokenAmountBase} ${localOrder?.symbol ?? order.tokenSymbol} and settled ${meDisplay} ME (${filledLots}/${totalLots} lots).`,
      priority: 'normal',
      target: localOrder?.sessionId
        ? { kind: 'session', sessionId: localOrder.sessionId }
        : { kind: 'bot_automation', metabotId: sellerMetabotId, section: 'surf' },
    });

    return { outcome: 'settled', deliveryTxId };
  }

  // -------------------------------------------------------------------------
  // WS-4: Token-for-Goods (MRC-20 & MVC FT -> MRC-721) Seller Handlers
  // -------------------------------------------------------------------------

  private async sendTokenGoodsReply(
    metabotId: number,
    toGlobalMetaId: string,
    payload: Parameters<typeof formatGoodsTradeWireMessage>[0],
    summaryText: string,
  ): Promise<void> {
    if (!toGlobalMetaId || !this.deps.sendTradeMessage) return;
    try {
      const wire = formatGoodsTradeWireMessage(payload);
      await this.deps.sendTradeMessage({
        metabotId,
        toGlobalMetaId,
        content: `${wire}\n\n${summaryText}`,
      });
    } catch (err) {
      this.log(`[SellerAutoFulfill/TokenGoods] Failed to send ${payload.type} DM: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private findTokenSellIntentPrice(
    sellerMetabotId: number,
    itemPinId: string,
    rawAssetKey: string,
  ): {
    ok: true;
    sellIntent: Mrc721SellIntentRecord;
    tokenPrice: NonNullable<NonNullable<Mrc721SellIntentRecord['intent']['prices']>['tokens']>[number];
    parsedKey: ReturnType<typeof parseCanonicalFtAssetKey>;
  } | { ok: false; reason: string } {
    let parsedKey: ReturnType<typeof parseCanonicalFtAssetKey>;
    try {
      parsedKey = parseCanonicalFtAssetKey(rawAssetKey);
    } catch {
      return { ok: false, reason: 'invalid_asset_key' };
    }
    const findIntent = this.deps.findLocalActiveSellIntent
      ?? ((botId: number, pinId: string) => findLocalActiveSellIntentForItem(this.deps.getSellIntentKv(), botId, pinId));
    const sellIntent = findIntent(sellerMetabotId, itemPinId);
    if (!sellIntent) {
      return { ok: false, reason: 'no_active_sell_intent_for_item' };
    }
    if (sellIntent.autoFulfillTokens === false || sellIntent.intent.autoFulfillTokens === false) {
      return { ok: false, reason: 'auto_fulfill_tokens_disabled_by_seller' };
    }
    const tokens = sellIntent.intent.prices?.tokens ?? [];
    const tokenPrice = tokens.find((t) => t.assetKey.toLowerCase() === parsedKey.assetKey);
    if (!tokenPrice) {
      return { ok: false, reason: `token_not_accepted:${parsedKey.assetKey}` };
    }
    return { ok: true, sellIntent, tokenPrice, parsedKey };
  }

  async handleFtGoodsAtomicProposal(
    sellerMetabotId: number,
    fromGlobalMetaId: string,
    msg: {
      proposalId: string;
      itemPinId: string;
      assetKey: string;
      amountBase: string;
      buyerNftAddress: string;
      sellerReceiveAddress: string;
      amountCheckRawTx: string;
      partialTx: string;
    },
  ): Promise<{ outcome: 'settled' | 'rejected'; reason?: string; txId?: string }> {
    const reject = async (reason: string) => {
      await this.sendTokenGoodsReply(
        sellerMetabotId,
        fromGlobalMetaId,
        {
          type: 'FT_GOODS_ATOMIC_REJECTED_V1',
          proposalId: msg.proposalId,
          itemPinId: msg.itemPinId,
          reason,
        },
        `[Token Atomic Swap Rejected] Proposal ${msg.proposalId} for ${msg.itemPinId} rejected: ${reason}.`,
      );
      return { outcome: 'rejected' as const, reason };
    };

    const identity = this.getSigner(sellerMetabotId);
    if (!identity) return await reject('seller_bot_unavailable');

    const flightKey = `atomic:${msg.itemPinId}`;
    if (this.processingOrders.has(flightKey)) {
      return await reject('item_order_in_flight');
    }
    this.processingOrders.add(flightKey);
    try {
      const nowMs = this.nowMs();
      expireStaleTokenGoodsReservations(this.db, nowMs, this.saveDb);
      const lockCheck = hasActiveItemLock(this.db, msg.itemPinId, nowMs);
      if (lockCheck.locked) {
        return await reject(lockCheck.reason || 'item_locked_by_active_order');
      }

      const priceMatch = this.findTokenSellIntentPrice(sellerMetabotId, msg.itemPinId, msg.assetKey);
      if (priceMatch.ok === false) {
        return await reject(priceMatch.reason);
      }
      if (priceMatch.parsedKey.chain !== 'mvc' || !priceMatch.parsedKey.codehash || !priceMatch.parsedKey.genesis) {
        return await reject('atomic_swap_requires_mvc_ft');
      }

      // Live item ownership + outpoint check
      const fetchItem = this.deps.fetchItemInfo ?? ((pinId: string) => fetchMrc721ItemInfo({ pinId }));
      const liveItem = await fetchItem(msg.itemPinId);
      if (!liveItem || liveItem.burned || (liveItem.ownerAddress ?? '').toLowerCase() !== identity.mvcAddress.toLowerCase()) {
        return await reject('seller_no_longer_holds_item');
      }
      const outMatch = /^([0-9a-fA-F]{64}):(\d+)$/.exec(String(liveItem.output ?? '').trim());
      const outVal = Number(liveItem.outputValue);
      if (!outMatch || !Number.isInteger(outVal) || outVal <= 0) {
        return await reject('item_outpoint_unavailable');
      }

      const mvcWallet = await getMvcWalletFromPath(identity.signer.mnemonic, identity.signer.path || "m/44'/10001'/0'/0/0");
      const sellerWif = mvcWallet.getPrivateKey();
      const expectedSellerReceive = priceMatch.tokenPrice.sellerReceiveAddress || identity.mvcAddress;

      const verified = verifyAndSignMvcFtGoodsAtomicProposal({
        partialTx: msg.partialTx,
        amountCheckRawTx: msg.amountCheckRawTx,
        expectedItemOutpoint: {
          txid: outMatch[1].toLowerCase(),
          vout: Number(outMatch[2]),
          satoshis: outVal,
        },
        sellerMvcAddress: expectedSellerReceive,
        expectedCodehash: priceMatch.parsedKey.codehash,
        expectedGenesis: priceMatch.parsedKey.genesis,
        expectedMinAmountBase: priceMatch.tokenPrice.amountBase,
        sellerWif,
      });
      if (verified.valid === false || !verified.finalRawTx || !verified.txId) {
        return await reject(verified.valid === false ? verified.reason : 'atomic_sign_failed');
      }

      const broadcastFn = this.deps.broadcastMvcRawTx ?? broadcastMvcTx;
      await broadcastFn(msg.amountCheckRawTx);
      const txId = await broadcastFn(verified.finalRawTx);

      // Mark local sell intent sold
      const markSold = this.deps.markSellIntentSold
        ?? ((botId: number, pinId: string, meta?: { orderId?: string; txId?: string }) =>
          markMrc721SellIntentSold(this.deps.getSellIntentKv(), botId, pinId, meta));
      try {
        markSold(sellerMetabotId, msg.itemPinId, { orderId: msg.proposalId, txId });
      } catch (err) {
        this.log(`[SellerAutoFulfill/TokenGoods] markSold failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (this.deps.broadcastTradeReceipt) {
        try {
          await this.deps.broadcastTradeReceipt({
            metabotId: sellerMetabotId,
            txId,
            orderId: msg.proposalId,
            itemPinId: msg.itemPinId,
            collectionPinId: priceMatch.sellIntent.intent.collectionPinId ?? liveItem.collectionPinId,
            sellerAddress: identity.mvcAddress,
            sellerMetaId: identity.globalMetaId,
            buyerAddress: verified.buyerNftAddress,
            buyerMetaId: fromGlobalMetaId || undefined,
            currency: `ft:${priceMatch.parsedKey.assetKey}`,
            assetKey: priceMatch.parsedKey.assetKey,
            amountBase: verified.sellerTokenAmountBase,
            amountDisplay: priceMatch.tokenPrice.amountDisplay,
            verifiedSource: 'atomic_ft_swap',
          });
        } catch (err) {
          this.log(`[SellerAutoFulfill/TokenGoods] receipt pin failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await this.sendTokenGoodsReply(
        sellerMetabotId,
        fromGlobalMetaId,
        {
          type: 'FT_GOODS_ATOMIC_SETTLED_V1',
          proposalId: msg.proposalId,
          itemPinId: msg.itemPinId,
          txId,
          assetKey: priceMatch.parsedKey.assetKey,
          amountBase: verified.sellerTokenAmountBase,
          buyerNftAddress: verified.buyerNftAddress,
          sellerMetaId: identity.globalMetaId,
        },
        `[Token Atomic Swap Settled] Item ${msg.itemPinId} swapped atomically in tx ${txId}.`,
      );

      this.deps.emitToRenderer?.('goodsTrade:autoSold', {
        orderId: msg.proposalId,
        sellerMetabotId,
        itemPinId: msg.itemPinId,
        buyerAddress: verified.buyerNftAddress,
        amountMilli: 0,
        assetKey: priceMatch.parsedKey.assetKey,
        amountBase: verified.sellerTokenAmountBase,
        deliveryTxId: txId,
        settledAt: this.nowMs(),
      });

      return { outcome: 'settled', txId };
    } finally {
      this.processingOrders.delete(flightKey);
    }
  }

  async handleTokenGoodsReserve(
    sellerMetabotId: number,
    fromGlobalMetaId: string,
    msg: {
      reserveRequestId?: string;
      itemPinId: string;
      assetKey: string;
      buyerNftAddress: string;
      buyerGlobalMetaId?: string;
    },
  ): Promise<{ outcome: 'reserved' | 'rejected'; reservationId?: string; reason?: string }> {
    const reject = async (reason: string) => {
      await this.sendTokenGoodsReply(
        sellerMetabotId,
        fromGlobalMetaId,
        {
          type: 'TOKEN_GOODS_RESERVE_REJECTED_V1',
          ...(msg.reserveRequestId ? { reserveRequestId: msg.reserveRequestId } : {}),
          itemPinId: msg.itemPinId,
          assetKey: msg.assetKey,
          reason,
        },
        `[Token Reservation Rejected] Item ${msg.itemPinId} unavailable: ${reason}.`,
      );
      return { outcome: 'rejected' as const, reason };
    };

    const identity = this.getSigner(sellerMetabotId);
    if (!identity) return await reject('seller_bot_unavailable');

    const buyerNftAddress = String(msg.buyerNftAddress ?? '').trim();
    if (!isMvcAddress(buyerNftAddress)) {
      return await reject('invalid_buyer_nft_address');
    }
    if (buyerNftAddress.toLowerCase() === identity.mvcAddress.toLowerCase()) {
      return await reject('self_trade_prohibited');
    }

    const priceMatch = this.findTokenSellIntentPrice(sellerMetabotId, msg.itemPinId, msg.assetKey);
    if (priceMatch.ok === false) {
      return await reject(priceMatch.reason);
    }

    const fetchItem = this.deps.fetchItemInfo ?? ((pinId: string) => fetchMrc721ItemInfo({ pinId }));
    const liveItem = await fetchItem(msg.itemPinId);
    if (!liveItem || liveItem.burned || (liveItem.ownerAddress ?? '').toLowerCase() !== identity.mvcAddress.toLowerCase()) {
      return await reject('seller_no_longer_holds_item');
    }

    const res = createTokenGoodsReservation(this.db, this.saveDb, {
      sellerMetabotId,
      itemPinId: msg.itemPinId,
      assetKey: priceMatch.parsedKey.assetKey,
      buyerNftAddress,
      buyerGlobalMetaId: msg.buyerGlobalMetaId || fromGlobalMetaId || undefined,
      sellerReceiveAddress: priceMatch.tokenPrice.sellerReceiveAddress,
      amountBase: priceMatch.tokenPrice.amountBase,
      nowMs: this.nowMs(),
    });
    if (res.ok === false) {
      return await reject(res.reason);
    }

    await this.sendTokenGoodsReply(
      sellerMetabotId,
      fromGlobalMetaId,
      {
        type: 'TOKEN_GOODS_RESERVED_V1',
        ...(msg.reserveRequestId ? { reserveRequestId: msg.reserveRequestId } : {}),
        reservationId: res.reservation.reservationId,
        itemPinId: res.reservation.itemPinId,
        assetKey: res.reservation.assetKey,
        sellerReceiveAddress: res.reservation.sellerReceiveAddress,
        amountBase: res.reservation.amountBase,
        expiresAt: res.reservation.expiresAt,
        sellerMetaId: identity.globalMetaId,
      },
      `[Token Goods Reserved] Reservation ${res.reservation.reservationId} locked for 5 minutes.`,
    );
    return { outcome: 'reserved', reservationId: res.reservation.reservationId };
  }

  async handleTokenGoodsPaid(
    sellerMetabotId: number,
    fromGlobalMetaId: string,
    msg: {
      reservationId: string;
      itemPinId?: string;
      assetKey?: string;
      paymentTxId: string;
      buyerNftAddress?: string;
    },
  ): Promise<{ outcome: 'delivered' | 'rejected'; nftDeliveryTxId?: string; reason?: string }> {
    const reject = async (reason: string, itemPinId?: string) => {
      await this.sendTokenGoodsReply(
        sellerMetabotId,
        fromGlobalMetaId,
        {
          type: 'TOKEN_GOODS_DELIVERY_REJECTED_V1',
          reservationId: msg.reservationId,
          ...(itemPinId ? { itemPinId } : {}),
          reason,
        },
        `[Token Goods Delivery Rejected] Reservation ${msg.reservationId} rejected: ${reason}.`,
      );
      return { outcome: 'rejected' as const, reason };
    };

    const identity = this.getSigner(sellerMetabotId);
    if (!identity) return await reject('seller_bot_unavailable', msg.itemPinId);

    const flightKey = `tgres:${msg.reservationId}`;
    if (this.processingOrders.has(flightKey)) {
      return { outcome: 'rejected', reason: 'already_in_flight' };
    }
    this.processingOrders.add(flightKey);
    try {
      const nowMs = this.nowMs();
      expireStaleTokenGoodsReservations(this.db, nowMs, this.saveDb);
      const reservation = getTokenGoodsReservation(this.db, msg.reservationId);
      if (!reservation) {
        return await reject('reservation_not_found', msg.itemPinId);
      }
      if (reservation.sellerMetabotId !== sellerMetabotId) {
        return await reject('seller_metabot_mismatch', reservation.itemPinId);
      }
      if (reservation.status === 'fulfilled' && reservation.nftDeliveryTxId) {
        if (reservation.paymentTxId?.toLowerCase() === msg.paymentTxId.trim().toLowerCase()) {
          await this.sendTokenGoodsReply(
            sellerMetabotId,
            fromGlobalMetaId,
            {
              type: 'TOKEN_GOODS_DELIVERED_V1',
              reservationId: reservation.reservationId,
              itemPinId: reservation.itemPinId,
              nftDeliveryTxId: reservation.nftDeliveryTxId,
              paymentTxId: reservation.paymentTxId,
              assetKey: reservation.assetKey,
              amountBase: reservation.amountBase,
              sellerMetaId: identity.globalMetaId,
            },
            `[Token Goods Delivered] Item ${reservation.itemPinId} already delivered in tx ${reservation.nftDeliveryTxId}.`,
          );
          return { outcome: 'delivered', nftDeliveryTxId: reservation.nftDeliveryTxId };
        }
        return await reject('reservation_already_fulfilled', reservation.itemPinId);
      }
      if (reservation.status !== 'reserved' || reservation.expiresAt <= nowMs) {
        return await reject(`reservation_not_active:${reservation.status}`, reservation.itemPinId);
      }

      // Look up token decimals from sell intent (fallback 8)
      const priceMatch = this.findTokenSellIntentPrice(sellerMetabotId, reservation.itemPinId, reservation.assetKey);
      if (priceMatch.ok === false) {
        return await reject(priceMatch.reason, reservation.itemPinId);
      }

      // S-06 Check BEFORE calling chain transfer: ensure paymentTxId wasn't spent on another reservation
      const claim = claimOrReplayUsedPayment(this.db, this.saveDb, {
        paymentTxId: msg.paymentTxId,
        reservationId: reservation.reservationId,
        itemPinId: reservation.itemPinId,
        assetKey: reservation.assetKey,
        amountBase: reservation.amountBase,
        sellerMetabotId,
        nowMs,
      });
      if (claim.outcome === 'replay_rejected') {
        return await reject(
          `payment_tx_already_used_for:${claim.existing.reservationId}`,
          reservation.itemPinId,
        );
      }
      if (claim.outcome === 'idempotent' && claim.existing.nftDeliveryTxId) {
        return { outcome: 'delivered', nftDeliveryTxId: claim.existing.nftDeliveryTxId };
      }

      // Authoritative chain verification (S-01 + S-02)
      if (priceMatch.parsedKey.chain === 'btc' && priceMatch.parsedKey.mrc20Id) {
        const verified = await verifyMrc20GoodsPayment(
          {
            paymentTxId: msg.paymentTxId,
            sellerReceiveAddress: reservation.sellerReceiveAddress,
            expectedMrc20Id: priceMatch.parsedKey.mrc20Id,
            expectedDecimals: priceMatch.tokenPrice.decimals,
            expectedAmountBase: reservation.amountBase,
          },
          { fetchUtxos: this.deps.fetchMrc20Utxos },
        );
        if (!verified.valid) {
          // Remove unused pending claim so legitimate retries with a valid paymentTxId remain possible
          this.db.run(
            `DELETE FROM token_goods_used_payments WHERE payment_tx_id = ? AND nft_delivery_tx_id IS NULL`,
            [msg.paymentTxId.trim().toLowerCase()],
          );
          this.saveDb();
          return await reject(verified.reason, reservation.itemPinId);
        }
      } else {
        // Non-BTC reservations are not expected here unless explicitly configured
        this.db.run(
          `DELETE FROM token_goods_used_payments WHERE payment_tx_id = ? AND nft_delivery_tx_id IS NULL`,
          [msg.paymentTxId.trim().toLowerCase()],
        );
        this.saveDb();
        return await reject('unsupported_chain_for_reservation_verify', reservation.itemPinId);
      }

      // Re-verify live item ownership before transfer
      const fetchItem = this.deps.fetchItemInfo ?? ((pinId: string) => fetchMrc721ItemInfo({ pinId }));
      const liveItem = await fetchItem(reservation.itemPinId);
      if (!liveItem || liveItem.burned || (liveItem.ownerAddress ?? '').toLowerCase() !== identity.mvcAddress.toLowerCase()) {
        return await reject('seller_no_longer_holds_item', reservation.itemPinId);
      }

      updateTokenGoodsReservation(this.db, this.saveDb, reservation.reservationId, {
        status: 'transferring',
        paymentTxId: msg.paymentTxId.trim().toLowerCase(),
        nowMs: this.nowMs(),
      });

      const transferResult = await this.deps.transferMrc721Item({
        metabotId: sellerMetabotId,
        pinId: reservation.itemPinId,
        toAddress: reservation.buyerNftAddress,
      });

      updateUsedPaymentDeliveryTx(this.db, this.saveDb, msg.paymentTxId, transferResult.txId);

      let tradePinId: string | undefined;
      if (this.deps.broadcastTradeReceipt) {
        try {
          const receipt = await this.deps.broadcastTradeReceipt({
            metabotId: sellerMetabotId,
            txId: transferResult.txId,
            orderId: reservation.reservationId,
            itemPinId: reservation.itemPinId,
            collectionPinId: priceMatch.sellIntent.intent.collectionPinId ?? liveItem.collectionPinId,
            sellerAddress: identity.mvcAddress,
            sellerMetaId: identity.globalMetaId,
            buyerAddress: reservation.buyerNftAddress,
            buyerMetaId: reservation.buyerGlobalMetaId || fromGlobalMetaId || undefined,
            currency: `ft:${reservation.assetKey}`,
            assetKey: reservation.assetKey,
            amountBase: reservation.amountBase,
            amountDisplay: priceMatch.tokenPrice.amountDisplay,
            verifiedSource: 'token_verify',
          });
          tradePinId = receipt.pinId;
        } catch (err) {
          this.log(`[SellerAutoFulfill/TokenGoods] receipt pin failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      updateTokenGoodsReservation(this.db, this.saveDb, reservation.reservationId, {
        status: 'fulfilled',
        paymentTxId: msg.paymentTxId.trim().toLowerCase(),
        nftDeliveryTxId: transferResult.txId,
        tradePinId: tradePinId ?? null,
        errorMessage: null,
        nowMs: this.nowMs(),
      });

      const markSold = this.deps.markSellIntentSold
        ?? ((botId: number, pinId: string, meta?: { orderId?: string; txId?: string }) =>
          markMrc721SellIntentSold(this.deps.getSellIntentKv(), botId, pinId, meta));
      try {
        markSold(sellerMetabotId, reservation.itemPinId, {
          orderId: reservation.reservationId,
          txId: transferResult.txId,
        });
      } catch (err) {
        this.log(`[SellerAutoFulfill/TokenGoods] markSold failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      await this.sendTokenGoodsReply(
        sellerMetabotId,
        fromGlobalMetaId || reservation.buyerGlobalMetaId || '',
        {
          type: 'TOKEN_GOODS_DELIVERED_V1',
          reservationId: reservation.reservationId,
          itemPinId: reservation.itemPinId,
          nftDeliveryTxId: transferResult.txId,
          paymentTxId: msg.paymentTxId.trim().toLowerCase(),
          assetKey: reservation.assetKey,
          amountBase: reservation.amountBase,
          sellerMetaId: identity.globalMetaId,
        },
        `[Token Goods Delivered] Item ${reservation.itemPinId} transferred in tx ${transferResult.txId}.`,
      );

      this.deps.emitToRenderer?.('goodsTrade:autoSold', {
        orderId: reservation.reservationId,
        sellerMetabotId,
        itemPinId: reservation.itemPinId,
        buyerAddress: reservation.buyerNftAddress,
        amountMilli: 0,
        assetKey: reservation.assetKey,
        amountBase: reservation.amountBase,
        deliveryTxId: transferResult.txId,
        ...(tradePinId ? { tradePinId } : {}),
        settledAt: this.nowMs(),
      });

      return { outcome: 'delivered', nftDeliveryTxId: transferResult.txId };
    } finally {
      this.processingOrders.delete(flightKey);
    }
  }

  /**
   * Poll locked seller escrow orders across all enabled MetaBots that have
   * at least one active local sell intent or pending 'transferred' recovery row.
   */
  async pollOnce(): Promise<void> {
    if (this.pollingInFlight) return;
    this.pollingInFlight = true;
    try {
      const metabots = this.deps.getMetabotStore().listMetabots?.() ?? [];
      const listOrders = this.deps.listEscrowOrders ?? listNftEscrowOrders;
      const listFtOrders = this.deps.listFtEscrowOrders ?? listFtEscrowOrders;
      for (const bot of metabots) {
        if (bot.enabled === false || !bot.mvc_address) continue;
        const identity = this.getSigner(bot.id);
        if (!identity) continue;
        try {
          const { orders } = await listOrders(identity.signer, {
            role: 'seller',
            status: 'FROZEN_AWAITING_DELIVERY',
            limit: 50,
          });
          for (const order of orders) {
            await this.processEscrowOrder(bot.id, order.orderId, { source: 'escrow_poll' });
          }
        } catch (error) {
          this.log(`[SellerAutoFulfill] Poll failed for bot #${bot.id}: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (this.hasPendingOrActiveFtSellerWork(bot.id)) {
          try {
            const ftOrders = await listFtOrders(identity.signer, {
              role: 'seller',
              status: 'FROZEN_AWAITING_DELIVERY',
              limit: 50,
            });
            for (const ftOrder of ftOrders) {
              await this.processFtEscrowOrder(bot.id, ftOrder.orderId, { source: 'escrow_poll' });
            }
          } catch (error) {
            this.log(
              `[SellerAutoFulfill/FT] Poll failed for bot #${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } finally {
      this.pollingInFlight = false;
    }
  }

  startPolling(intervalMs: number = SELLER_AUTO_FULFILL_POLL_INTERVAL_MS): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        this.log(`[SellerAutoFulfill] Poll tick error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

export { broadcastMrc721TradeReceipt };
