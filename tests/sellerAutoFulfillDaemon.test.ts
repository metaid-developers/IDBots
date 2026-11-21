import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  SellerAutoFulfillDaemon,
  ensureMeNftSellerFulfillmentsSchema,
} = require('../dist-electron/main/services/sellerAutoFulfillDaemon.js');
const {
  formatGoodsTradeWireMessage,
} = require('../dist-electron/main/services/goodsTradeWireProtocol.js');
const {
  findAcceptedGoodsQuoteForItem,
  findSellerAuthorizedQuoteForOrder,
  recordSellerAuthorizedQuote,
} = require('../dist-electron/main/services/mrc721SellIntentService.js');

const SELLER_ADDRESS = '1L8me3xT5G1R3gJ8zQ5cS6oX2Y9wQ7hP8c';
const BUYER_ADDRESS = '1Lbcfr7sAHTD9CgdQo3HTMTkV8LK4ZnX71';
const SELLER_METAID = 'idq1seller00000000000000000000000000000000';
const BUYER_METAID = 'idq1buyer000000000000000000000000000000000';
const ITEM_PIN_ID = `${'aa'.repeat(32)}i0`;
const COLLECTION_PIN_ID = `${'bb'.repeat(32)}i0`;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function withDaemonDb(
  fn: (ctx: { sqliteStore: any; db: any; saveDb: () => void }) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-seller-fulfill-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    ensureMeNftSellerFulfillmentsSchema(db);
    await fn({ sqliteStore, db, saveDb });
  } finally {
    try {
      sqliteStore.close();
    } catch {
      // ignore close errors
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows EPERM cleanup
    }
  }
}

function makeKv() {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    set: <T>(k: string, v: T) => {
      map.set(k, v);
    },
  };
}

function makeBaseDeps(overrides: Record<string, unknown> = {}) {
  const kv = makeKv();
  const transfers: any[] = [];
  const delivers: any[] = [];
  const rejects: any[] = [];
  const receipts: any[] = [];
  const dms: any[] = [];
  const emitted: any[] = [];
  const soldMarks: any[] = [];

  const deps: any = {
    getMetabotStore: () => ({
      getMetabotById: (id: number) => (id === 1
        ? { id: 1, enabled: true, mvc_address: SELLER_ADDRESS, globalmetaid: SELLER_METAID }
        : null),
      getMetabotWalletByMetabotId: (id: number) => (id === 1
        ? { mnemonic: MNEMONIC, path: "m/44'/10001'/0'/0/0" }
        : null),
      listMetabots: () => [{ id: 1, enabled: true, mvc_address: SELLER_ADDRESS, globalmetaid: SELLER_METAID }],
    }),
    getSellIntentKv: () => kv,
    transferMrc721Item: async (input: any) => {
      transfers.push(input);
      return { txId: 'tx_transfer_001', pinId: input.pinId, toAddress: input.toAddress };
    },
    broadcastTradeReceipt: async (input: any) => {
      receipts.push(input);
      return { pinId: `${'dd'.repeat(32)}i0`, txids: ['tx_receipt_001'] };
    },
    sendTradeMessage: async (input: any) => {
      dms.push(input);
      return { txids: ['tx_dm_001'], pinId: `${'ee'.repeat(32)}i0` };
    },
    emitToRenderer: (channel: string, payload: unknown) => {
      emitted.push({ channel, payload });
    },
    getEscrowOrder: async (_signer: any, orderId: string) => ({
      orderId,
      itemPinId: ITEM_PIN_ID,
      collectionPinId: COLLECTION_PIN_ID,
      buyerNftAddress: BUYER_ADDRESS,
      buyerAddress: BUYER_ADDRESS,
      buyerMetaId: BUYER_METAID,
      sellerBotAddress: SELLER_ADDRESS,
      sellerAddress: SELLER_ADDRESS,
      sellerMetaId: SELLER_METAID,
      amountMilli: 5000,
      status: 'FROZEN_AWAITING_DELIVERY',
      statusCode: 1,
      statusName: 'FROZEN_AWAITING_DELIVERY',
      raw: {},
    }),
    listEscrowOrders: async () => ({ orders: [] }),
    deliverEscrowOrder: async (_signer: any, orderId: string, input: { deliveryTxId: string }) => {
      delivers.push({ orderId, ...input });
      return {
        orderId,
        itemPinId: ITEM_PIN_ID,
        buyerNftAddress: BUYER_ADDRESS,
        buyerAddress: BUYER_ADDRESS,
        sellerBotAddress: SELLER_ADDRESS,
        sellerAddress: SELLER_ADDRESS,
        amountMilli: 5000,
        status: 'SETTLED',
        statusCode: 3,
        statusName: 'SETTLED',
        deliveryTxId: input.deliveryTxId,
        raw: {},
      };
    },
    rejectEscrowOrder: async (_signer: any, orderId: string, input: { reason: string }) => {
      rejects.push({ orderId, ...input });
      return {
        orderId,
        itemPinId: ITEM_PIN_ID,
        buyerNftAddress: BUYER_ADDRESS,
        buyerAddress: BUYER_ADDRESS,
        sellerBotAddress: SELLER_ADDRESS,
        sellerAddress: SELLER_ADDRESS,
        amountMilli: 5000,
        status: 'CANCELED_REFUNDED',
        statusCode: 5,
        statusName: 'CANCELED_REFUNDED',
        rejectReason: input.reason,
        raw: {},
      };
    },
    fetchItemInfo: async () => ({
      itemPinId: ITEM_PIN_ID,
      ownerAddress: SELLER_ADDRESS,
      burned: false,
    }),
    findLocalActiveSellIntent: () => ({
      id: 'intent_1',
      metabotId: 1,
      status: 'active',
      autoFulfillMe: true,
      updatedAt: 1,
      intent: {
        active: true,
        itemPinId: ITEM_PIN_ID,
        sellerAddress: SELLER_ADDRESS,
        prices: { me: { amountMilli: 4000 } },
        autoFulfillMe: true,
        acceptedCurrencies: ['me'],
        settlement: ['me-escrow'],
        createdAt: 1700000000,
      },
    }),
    markSellIntentSold: (metabotId: number, itemPinId: string, meta: any) => {
      soldMarks.push({ metabotId, itemPinId, meta });
      return true;
    },
    emitLog: () => {},
    ...overrides,
  };

  return { deps, kv, transfers, delivers, rejects, receipts, dms, emitted, soldMarks };
}

test('SellerAutoFulfillDaemon fast-path settles valid ME_ESCROW_LOCKED_V1 order end-to-end', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    const ctx = makeBaseDeps();
    const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);

    const wire = formatGoodsTradeWireMessage({
      type: 'ME_ESCROW_LOCKED_V1',
      orderId: 'ord_happy_1',
      itemPinId: ITEM_PIN_ID,
      amountMilli: 5000,
      buyerNftAddress: BUYER_ADDRESS,
      sellerBotAddress: SELLER_ADDRESS,
      buyerGlobalMetaId: BUYER_METAID,
    });

    const handled = await daemon.handleIncomingTradeMessage({
      metabotId: 1,
      fromGlobalMetaId: BUYER_METAID,
      plaintext: wire,
    });
    assert.equal(handled.handled, true);
    assert.equal(handled.orderId, 'ord_happy_1');

    assert.equal(ctx.transfers.length, 1);
    assert.equal(ctx.delivers.length, 1);
    assert.equal(ctx.delivers[0].deliveryTxId, 'tx_transfer_001');
    assert.equal(ctx.receipts.length, 1);
    assert.equal(ctx.dms.length, 1);
    assert.match(ctx.dms[0].content, /ME_DELIVERY_DONE_V1/);
    assert.match(ctx.dms[0].content, /"settledAmountMilli":\s*5000/);
    assert.match(ctx.dms[0].content, /"buyerNftAddress"/);
    assert.equal(ctx.soldMarks.length, 1);
    assert.equal(ctx.emitted.length, 1);
    assert.equal(ctx.emitted[0].channel, 'goodsTrade:autoSold');

    const row = daemon.getFulfillment('ord_happy_1');
    assert.ok(row);
    assert.equal(row.status, 'settled');
    assert.equal(row.deliveryTxId, 'tx_transfer_001');
    assert.equal(row.tradePinId, `${'dd'.repeat(32)}i0`);

    // Second invocation is idempotently skipped (never double-transfers)
    const second = await daemon.processEscrowOrder(1, 'ord_happy_1');
    assert.equal(second.outcome, 'skipped');
    assert.equal(ctx.transfers.length, 1);
  });
});

test('SellerAutoFulfillDaemon crash recovery resumes /deliver without re-transferring NFT', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    let failDeliverOnce = true;
    const ctx = makeBaseDeps({
      deliverEscrowOrder: async (_signer: any, orderId: string, input: { deliveryTxId: string }) => {
        if (failDeliverOnce) {
          failDeliverOnce = false;
          throw new Error('temporary ABS 502');
        }
        ctx.delivers.push({ orderId, ...input });
        return {
          orderId,
          itemPinId: ITEM_PIN_ID,
          buyerNftAddress: BUYER_ADDRESS,
          buyerAddress: BUYER_ADDRESS,
          sellerBotAddress: SELLER_ADDRESS,
          sellerAddress: SELLER_ADDRESS,
          amountMilli: 5000,
          status: 'SETTLED',
          statusCode: 3,
          statusName: 'SETTLED',
          deliveryTxId: input.deliveryTxId,
          raw: {},
        };
      },
    });
    const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);

    // First attempt: transfer succeeds, /deliver throws -> persisted as status='transferred'
    const first = await daemon.processEscrowOrder(1, 'ord_crash_1', { source: 'escrow_poll' });
    assert.equal(first.outcome, 'failed');
    assert.equal(ctx.transfers.length, 1);
    const mid = daemon.getFulfillment('ord_crash_1');
    assert.equal(mid?.status, 'transferred');
    assert.equal(mid?.deliveryTxId, 'tx_transfer_001');

    // Second attempt (simulated restart): resumes directly to /deliver with tx_transfer_001, ZERO new transfers!
    const daemonAfterRestart = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);
    const second = await daemonAfterRestart.processEscrowOrder(1, 'ord_crash_1', { source: 'escrow_poll' });
    assert.equal(second.outcome, 'settled');
    assert.equal(ctx.transfers.length, 1, 'MUST NOT re-transfer NFT on crash recovery');
    assert.equal(ctx.delivers.length, 1);
    assert.equal(ctx.delivers[0].deliveryTxId, 'tx_transfer_001');
  });
});

test('SellerAutoFulfillDaemon safety checks: rejects missing intent, underpriced order, lost ownership, self-trade; skips autoFulfillMe=false', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    // 1. Missing active sell-intent -> reject
    {
      const ctx = makeBaseDeps({ findLocalActiveSellIntent: () => null });
      const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);
      const res = await daemon.processEscrowOrder(1, 'ord_no_intent');
      assert.equal(res.outcome, 'rejected');
      assert.equal(ctx.transfers.length, 0);
      assert.equal(ctx.rejects[0].reason, 'no_active_sell_intent_for_item');
    }

    // 2. autoFulfillMe === false -> skip (neither transfer nor reject)
    {
      const ctx = makeBaseDeps({
        findLocalActiveSellIntent: () => ({
          id: 'intent_manual',
          metabotId: 1,
          status: 'active',
          autoFulfillMe: false,
          updatedAt: 1,
          intent: {
            active: true,
            itemPinId: ITEM_PIN_ID,
            sellerAddress: SELLER_ADDRESS,
            prices: { me: { amountMilli: 4000 } },
            autoFulfillMe: false,
            acceptedCurrencies: ['me'],
            settlement: ['me-escrow'],
            createdAt: 1700000000,
          },
        }),
      });
      const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);
      const res = await daemon.processEscrowOrder(1, 'ord_manual');
      assert.equal(res.outcome, 'skipped');
      assert.equal(res.reason, 'auto_fulfill_disabled_by_seller');
      assert.equal(ctx.transfers.length, 0);
      assert.equal(ctx.rejects.length, 0);
    }

    // 3. Underpriced order (< declared price) -> reject
    {
      const ctx = makeBaseDeps({
        getEscrowOrder: async (_s: any, orderId: string) => ({
          orderId,
          itemPinId: ITEM_PIN_ID,
          buyerNftAddress: BUYER_ADDRESS,
          buyerAddress: BUYER_ADDRESS,
          sellerBotAddress: SELLER_ADDRESS,
          sellerAddress: SELLER_ADDRESS,
          amountMilli: 2000,
          status: 'FROZEN_AWAITING_DELIVERY',
          statusCode: 1,
          statusName: 'FROZEN_AWAITING_DELIVERY',
          raw: {},
        }),
      });
      const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);
      const res = await daemon.processEscrowOrder(1, 'ord_underpriced');
      assert.equal(res.outcome, 'rejected');
      assert.match(ctx.rejects[0].reason, /price_below_listing/);
      assert.equal(ctx.transfers.length, 0);
    }

    // 4. Seller no longer owns item -> reject
    {
      const ctx = makeBaseDeps({
        fetchItemInfo: async () => ({
          itemPinId: ITEM_PIN_ID,
          ownerAddress: BUYER_ADDRESS,
          burned: false,
        }),
      });
      const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);
      const res = await daemon.processEscrowOrder(1, 'ord_lost_owner');
      assert.equal(res.outcome, 'rejected');
      assert.equal(ctx.rejects[0].reason, 'seller_no_longer_holds_item');
      assert.equal(ctx.transfers.length, 0);
    }

    // 5. Self-trade (buyerNftAddress === sellerBotAddress) -> reject
    {
      const ctx = makeBaseDeps({
        getEscrowOrder: async (_s: any, orderId: string) => ({
          orderId,
          itemPinId: ITEM_PIN_ID,
          buyerNftAddress: SELLER_ADDRESS,
          buyerAddress: SELLER_ADDRESS,
          sellerBotAddress: SELLER_ADDRESS,
          sellerAddress: SELLER_ADDRESS,
          amountMilli: 5000,
          status: 'FROZEN_AWAITING_DELIVERY',
          statusCode: 1,
          statusName: 'FROZEN_AWAITING_DELIVERY',
          raw: {},
        }),
      });
      const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);
      const res = await daemon.processEscrowOrder(1, 'ord_self_trade');
      assert.equal(res.outcome, 'rejected');
      assert.equal(ctx.rejects[0].reason, 'self_trade_prohibited');
      assert.equal(ctx.transfers.length, 0);
    }
  });
});

test('SellerAutoFulfillDaemon pollOnce uses FROZEN_AWAITING_DELIVERY and GOODS_QUOTE_ACCEPT_V1 persists', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    const pollQueries: any[] = [];
    const ctx = makeBaseDeps({
      listEscrowOrders: async (_signer: any, query: any) => {
        pollQueries.push(query);
        return {
          orders: [{
            orderId: 'ord_polled_1',
            itemPinId: ITEM_PIN_ID,
            buyerNftAddress: BUYER_ADDRESS,
            buyerAddress: BUYER_ADDRESS,
            sellerBotAddress: SELLER_ADDRESS,
            sellerAddress: SELLER_ADDRESS,
            amountMilli: 5000,
            status: 'FROZEN_AWAITING_DELIVERY',
            statusCode: 1,
            statusName: 'FROZEN_AWAITING_DELIVERY',
            raw: {},
          }],
        };
      },
    });
    const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);

    const quoteWire = formatGoodsTradeWireMessage({
      type: 'GOODS_QUOTE_ACCEPT_V1',
      inquiryId: 'inq_quote_1',
      itemPinId: ITEM_PIN_ID,
      agreedCurrency: 'me',
      agreedAmountMilli: 3500,
      sellerBotAddress: SELLER_ADDRESS,
      validUntil: Math.floor(Date.now() / 1000) + 1800,
    });
    const quoteRes = await daemon.handleIncomingTradeMessage({
      metabotId: 1,
      fromGlobalMetaId: SELLER_METAID,
      plaintext: quoteWire,
    });
    assert.equal(quoteRes.handled, false, 'quote passes through to conversation');
    const savedQuote = findAcceptedGoodsQuoteForItem(ctx.kv, 1, ITEM_PIN_ID);
    assert.ok(savedQuote);
    assert.equal(savedQuote.agreedAmountMilli, 3500);

    await daemon.pollOnce();
    assert.equal(pollQueries.length, 1);
    assert.equal(pollQueries[0].status, 'FROZEN_AWAITING_DELIVERY');
    assert.equal(ctx.transfers.length, 1);
    assert.equal(ctx.delivers.length, 1);
    assert.equal(daemon.getFulfillment('ord_polled_1')?.status, 'settled');
  });
});

test('SellerAutoFulfillDaemon fulfills quote-authorized negotiated and unlisted orders and marks quote used', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    // 1. Unlisted item (no sell-intent) with valid seller-authorized quote bound to BUYER_ADDRESS
    const ctx = makeBaseDeps({
      findLocalActiveSellIntent: () => null,
      getEscrowOrder: async (_s: any, orderId: string) => ({
        orderId,
        itemPinId: ITEM_PIN_ID,
        collectionPinId: COLLECTION_PIN_ID,
        buyerNftAddress: BUYER_ADDRESS,
        buyerAddress: BUYER_ADDRESS,
        buyerMetaId: BUYER_METAID,
        sellerBotAddress: SELLER_ADDRESS,
        sellerAddress: SELLER_ADDRESS,
        amountMilli: 3500,
        status: 'FROZEN_AWAITING_DELIVERY',
        statusCode: 1,
        statusName: 'FROZEN_AWAITING_DELIVERY',
        raw: {},
      }),
    });
    recordSellerAuthorizedQuote(ctx.kv, 1, {
      inquiryId: 'inq_unlisted_1',
      itemPinId: ITEM_PIN_ID,
      agreedCurrency: 'me',
      agreedAmountMilli: 3500,
      sellerBotAddress: SELLER_ADDRESS,
      buyerNftAddress: BUYER_ADDRESS,
      buyerGlobalMetaId: BUYER_METAID,
      validUntil: Math.floor(Date.now() / 1000) + 1800,
    });

    const daemon = new SellerAutoFulfillDaemon(db, saveDb, ctx.deps);
    const res = await daemon.processEscrowOrder(1, 'ord_quote_unlisted_1');
    assert.equal(res.outcome, 'settled');
    assert.equal(ctx.transfers.length, 1);
    assert.equal(ctx.delivers.length, 1);

    // Quote must be marked used after settlement so it cannot be replayed
    const remainingQuote = findSellerAuthorizedQuoteForOrder(ctx.kv, 1, ITEM_PIN_ID, BUYER_ADDRESS);
    assert.equal(remainingQuote, null);

    // Second order for the same unlisted item without a fresh quote is rejected
    const replay = await daemon.processEscrowOrder(1, 'ord_quote_unlisted_replay');
    assert.equal(replay.outcome, 'rejected');
    assert.equal(ctx.rejects[0].reason, 'no_active_sell_intent_for_item');
  });
});
