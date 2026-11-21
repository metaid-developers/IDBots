import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { SellerAutoFulfillDaemon } = require('../dist-electron/main/services/sellerAutoFulfillDaemon.js');
const { formatGoodsTradeWireMessage, parseGoodsTradeWireMessage } = require('../dist-electron/main/services/goodsTradeWireProtocol.js');
const {
  registerFtActiveOrder,
  getFtBatchOrderProgress,
  listFtActiveOrders,
} = require('../dist-electron/main/services/ftOrderStore.js');

const SELLER_MVC_ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const BUYER_MVC_ADDR = '1Lbcfr7sAHTD9CgdQo3HTMTkV8LK4ZnX71';
const SELLER_BTC_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BUYER_BTC_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const SELLER_METAID = 'idq1seller00000000000000000000000000000000';
const BUYER_METAID = 'idq1buyer000000000000000000000000000000000';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MVC_ASSET_KEY = `mvc-ft:${'11'.repeat(20)}:${'22'.repeat(20)}`;
const BTC_ASSET_KEY = `mrc20:${'33'.repeat(32)}i0`;

async function withDaemonDb(
  fn: (ctx: { sqliteStore: any; db: any; saveDb: () => void }) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-ft-fulfill-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
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

function makeBotStore() {
  return {
    getMetabotById: (id: number) =>
      id === 1
        ? {
            id: 1,
            enabled: true,
            mvc_address: SELLER_MVC_ADDR,
            btc_address: SELLER_BTC_ADDR,
            globalmetaid: SELLER_METAID,
          }
        : null,
    getMetabotWalletByMetabotId: (id: number) =>
      id === 1 ? { mnemonic: MNEMONIC, path: "m/44'/10001'/0'/0/0" } : null,
    listMetabots: () => [
      {
        id: 1,
        enabled: true,
        mvc_address: SELLER_MVC_ADDR,
        btc_address: SELLER_BTC_ADDR,
        globalmetaid: SELLER_METAID,
      },
    ],
  };
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

test('SellerAutoFulfillDaemon FT: auto-fulfills MVC FT ME escrow via wire DM and updates batch progress + notification', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    registerFtActiveOrder(
      db,
      {
        listingKey: 'pin-ft-lot-1',
        batchGroupId: 'batch-mc-me-2lots',
        metabotId: 1,
        sessionId: 'sess-seller-1',
        chain: 'mvc',
        rail: 'me-escrow',
        assetKey: MVC_ASSET_KEY,
        symbol: 'MC',
        decimals: 8,
        codehash: '11'.repeat(20),
        genesis: '22'.repeat(20),
        utxoOutpoint: `${'aa'.repeat(32)}:0`,
        amountBase: '100000000000', // 1000 MC
        amountDisplay: '1000',
        priceMeMilli: 25000, // 25 ME
        autoFulfillMe: true,
        sellerAddress: SELLER_MVC_ADDR,
      },
      saveDb,
    );
    registerFtActiveOrder(
      db,
      {
        listingKey: 'pin-ft-lot-2',
        batchGroupId: 'batch-mc-me-2lots',
        metabotId: 1,
        sessionId: 'sess-seller-1',
        chain: 'mvc',
        rail: 'me-escrow',
        assetKey: MVC_ASSET_KEY,
        symbol: 'MC',
        decimals: 8,
        codehash: '11'.repeat(20),
        genesis: '22'.repeat(20),
        utxoOutpoint: `${'bb'.repeat(32)}:0`,
        amountBase: '100000000000',
        amountDisplay: '1000',
        priceMeMilli: 25000,
        autoFulfillMe: true,
        sellerAddress: SELLER_MVC_ADDR,
      },
      saveDb,
    );

    const transfers: any[] = [];
    const deliveries: any[] = [];
    const dms: any[] = [];
    const rendererEvents: any[] = [];
    const notifications: any[] = [];

    const escrowOrder = {
      orderId: 'ft_esc_001',
      buyerBotAddress: BUYER_MVC_ADDR,
      sellerBotAddress: SELLER_MVC_ADDR,
      buyerReceiveAddress: BUYER_MVC_ADDR,
      chain: 'mvc',
      assetKey: MVC_ASSET_KEY,
      tokenSymbol: 'MC',
      tokenDecimals: 8,
      tokenAmountBase: '100000000000',
      amountMilli: 25000,
      listingKey: 'pin-ft-lot-1',
      status: 'FROZEN_AWAITING_DELIVERY',
    };

    const daemon = new SellerAutoFulfillDaemon(db, saveDb, {
      getMetabotStore: () => makeBotStore(),
      getSellIntentKv: () => makeKv(),
      transferMrc721Item: async () => ({ txId: 'unused' }),
      transferMvcFt: async (input: any) => {
        transfers.push(input);
        return { txId: 'cc'.repeat(32) };
      },
      getFtEscrowOrder: async () => escrowOrder,
      deliverFtEscrowOrder: async (_signer: any, orderId: string, params: any) => {
        deliveries.push({ orderId, params });
        return { ...escrowOrder, status: 'SETTLED', deliveryTxId: params.deliveryTxId };
      },
      sendTradeMessage: async (msg: any) => {
        dms.push(msg);
        return { txId: 'dd'.repeat(32) };
      },
      emitToRenderer: (channel: string, payload: unknown) => {
        rendererEvents.push({ channel, payload });
      },
      recordNotification: (notif: any) => {
        notifications.push(notif);
      },
      emitLog: () => {},
    });

    const wireText = formatGoodsTradeWireMessage({
      type: 'ME_FT_ESCROW_LOCKED_V1',
      orderId: 'ft_esc_001',
      assetKey: MVC_ASSET_KEY,
      chain: 'mvc',
      tokenSymbol: 'MC',
      tokenDecimals: 8,
      tokenAmountBase: '100000000000',
      amountMilli: 25000,
      buyerReceiveAddress: BUYER_MVC_ADDR,
      sellerBotAddress: SELLER_MVC_ADDR,
      buyerGlobalMetaId: BUYER_METAID,
      listingPinId: 'pin-ft-lot-1',
    });

    const res = await daemon.handleIncomingTradeMessage({
      metabotId: 1,
      fromGlobalMetaId: BUYER_METAID,
      plaintext: wireText,
    });

    assert.equal(res.handled, true);
    assert.equal(res.type, 'ME_FT_ESCROW_LOCKED_V1');
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].amountBase, '100000000000');
    assert.equal(transfers[0].toAddress, BUYER_MVC_ADDR);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].params.deliveryTxId, 'cc'.repeat(32));

    const progress = getFtBatchOrderProgress(db, 'batch-mc-me-2lots');
    assert.equal(progress.totalLots, 2);
    assert.equal(progress.filledLots, 1);
    assert.equal(progress.activeLots, 1);

    assert.equal(dms.length, 1);
    const parsedReply = parseGoodsTradeWireMessage(dms[0].content);
    assert.equal(parsedReply.type, 'ME_FT_DELIVERY_DONE_V1');
    assert.equal(parsedReply.deliveryTxId, 'cc'.repeat(32));

    assert.equal(rendererEvents.length, 1);
    assert.equal(rendererEvents[0].channel, 'ftTrade:orderFilled');
    assert.equal((rendererEvents[0].payload as any).filledLots, 1);
    assert.equal((rendererEvents[0].payload as any).totalLots, 2);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'ft.escrow.sold');
    assert.deepEqual(notifications[0].target, { kind: 'session', sessionId: 'sess-seller-1' });
  });
});

test('SellerAutoFulfillDaemon FT: crash-recovery never double-sends tokens when /deliver fails once', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    registerFtActiveOrder(
      db,
      {
        listingKey: 'lot_fixture_mrc20_01',
        batchGroupId: 'batch-idcoin-1',
        metabotId: 1,
        chain: 'btc',
        rail: 'me-escrow',
        assetKey: BTC_ASSET_KEY,
        symbol: 'IDCOIN',
        decimals: 18,
        mrc20Id: `${'33'.repeat(32)}i0`,
        utxoOutpoint: `${'ee'.repeat(32)}:1`,
        amountBase: '1234567890123456789',
        amountDisplay: '1.234567890123456789',
        priceMeMilli: 50000,
        autoFulfillMe: true,
        sellerAddress: SELLER_BTC_ADDR,
      },
      saveDb,
    );

    let transferCount = 0;
    let deliverAttempt = 0;
    const escrowOrder = {
      orderId: 'ft_esc_crash_01',
      buyerBotAddress: BUYER_MVC_ADDR,
      sellerBotAddress: SELLER_MVC_ADDR,
      buyerReceiveAddress: BUYER_BTC_ADDR,
      chain: 'btc',
      assetKey: BTC_ASSET_KEY,
      tokenSymbol: 'IDCOIN',
      tokenDecimals: 18,
      tokenAmountBase: '1234567890123456789',
      amountMilli: 50000,
      listingKey: 'lot_fixture_mrc20_01',
      status: 'FROZEN_AWAITING_DELIVERY',
    };

    const daemon = new SellerAutoFulfillDaemon(db, saveDb, {
      getMetabotStore: () => makeBotStore(),
      getSellIntentKv: () => makeKv(),
      transferMrc721Item: async () => ({ txId: 'unused' }),
      listEscrowOrders: async () => ({ orders: [] }),
      listFtEscrowOrders: async () => [escrowOrder],
      getFtEscrowOrder: async () => escrowOrder,
      transferBtcMrc20: async (input: any) => {
        transferCount += 1;
        assert.equal(input.amountBase, '1234567890123456789');
        return { revealTxId: 'ff'.repeat(32), commitTxId: '99'.repeat(32) };
      },
      deliverFtEscrowOrder: async (_signer: any, _orderId: string, params: any) => {
        deliverAttempt += 1;
        if (deliverAttempt === 1) {
          throw new Error('simulated ABS network timeout right after MRC20 reveal');
        }
        return { ...escrowOrder, status: 'SETTLED', deliveryTxId: params.deliveryTxId };
      },
      emitLog: () => {},
    });

    // Run 1: broadcasts MRC-20 transfer, persists status='transferred', fails on /deliver
    const r1 = await daemon.processFtEscrowOrder(1, 'ft_esc_crash_01');
    assert.equal(r1.outcome, 'failed');
    assert.equal(transferCount, 1);
    const savedMid = daemon.getFtFulfillment('ft_esc_crash_01');
    assert.equal(savedMid?.status, 'transferred');
    assert.equal(savedMid?.deliveryTxId, 'ff'.repeat(32));

    // Run 2 (via pollOnce): resumes /deliver WITHOUT calling transferBtcMrc20 a second time!
    await daemon.pollOnce();
    assert.equal(transferCount, 1);
    assert.equal(deliverAttempt, 2);
    const savedDone = daemon.getFtFulfillment('ft_esc_crash_01');
    assert.equal(savedDone?.status, 'delivered');
    const [orderAfter] = listFtActiveOrders(db, { batchGroupId: 'batch-idcoin-1' });
    assert.equal(orderAfter.status, 'filled');
    assert.equal(orderAfter.filledTxId, 'ff'.repeat(32));
  });
});

test('SellerAutoFulfillDaemon FT: rejects underpriced or self-trade escrow orders without transferring tokens', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    registerFtActiveOrder(
      db,
      {
        listingKey: 'pin-guard-lot',
        batchGroupId: 'batch-guard',
        metabotId: 1,
        chain: 'mvc',
        rail: 'me-escrow',
        assetKey: MVC_ASSET_KEY,
        symbol: 'MC',
        decimals: 8,
        codehash: '11'.repeat(20),
        genesis: '22'.repeat(20),
        utxoOutpoint: `${'77'.repeat(32)}:0`,
        amountBase: '50000000000',
        amountDisplay: '500',
        priceMeMilli: 15000,
        autoFulfillMe: true,
        sellerAddress: SELLER_MVC_ADDR,
      },
      saveDb,
    );

    let transferCalls = 0;
    const rejections: Array<{ orderId: string; reason: string }> = [];

    const ordersById: Record<string, any> = {
      underpriced: {
        orderId: 'underpriced',
        buyerBotAddress: BUYER_MVC_ADDR,
        sellerBotAddress: SELLER_MVC_ADDR,
        buyerReceiveAddress: BUYER_MVC_ADDR,
        chain: 'mvc',
        assetKey: MVC_ASSET_KEY,
        tokenSymbol: 'MC',
        tokenDecimals: 8,
        tokenAmountBase: '50000000000',
        amountMilli: 12000, // < 15000
        listingKey: 'pin-guard-lot',
        status: 'FROZEN_AWAITING_DELIVERY',
      },
      self_trade: {
        orderId: 'self_trade',
        buyerBotAddress: BUYER_MVC_ADDR,
        sellerBotAddress: SELLER_MVC_ADDR,
        buyerReceiveAddress: SELLER_MVC_ADDR, // self receive address!
        chain: 'mvc',
        assetKey: MVC_ASSET_KEY,
        tokenSymbol: 'MC',
        tokenDecimals: 8,
        tokenAmountBase: '50000000000',
        amountMilli: 15000,
        listingKey: 'pin-guard-lot',
        status: 'FROZEN_AWAITING_DELIVERY',
      },
    };

    const daemon = new SellerAutoFulfillDaemon(db, saveDb, {
      getMetabotStore: () => makeBotStore(),
      getSellIntentKv: () => makeKv(),
      transferMrc721Item: async () => ({ txId: 'unused' }),
      transferMvcFt: async () => {
        transferCalls += 1;
        return { txId: 'never' };
      },
      getFtEscrowOrder: async (_s: any, id: string) => ordersById[id],
      rejectFtEscrowOrder: async (_s: any, orderId: string, reason: string) => {
        rejections.push({ orderId, reason });
        return { ...ordersById[orderId], status: 'CANCELED_REFUNDED' };
      },
      emitLog: () => {},
    });

    const rUnder = await daemon.processFtEscrowOrder(1, 'underpriced');
    assert.equal(rUnder.outcome, 'rejected');
    assert.match(String(rUnder.reason), /price_below_listing/);

    const rSelf = await daemon.processFtEscrowOrder(1, 'self_trade');
    assert.equal(rSelf.outcome, 'rejected');
    assert.equal(rSelf.reason, 'self_trade_prohibited');

    ordersById.bad_addr = {
      ...ordersById.self_trade,
      orderId: 'bad_addr',
      buyerReceiveAddress: '1InvalidChecksumAddressXYZ',
    };
    const rBadAddr = await daemon.processFtEscrowOrder(1, 'bad_addr');
    assert.equal(rBadAddr.outcome, 'rejected');
    assert.equal(rBadAddr.reason, 'invalid_buyer_receive_address');

    assert.equal(transferCalls, 0);
    assert.equal(rejections.length, 3);
  });
});
