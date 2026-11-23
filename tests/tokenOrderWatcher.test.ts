import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  TokenOrderWatcher,
  buildPassiveSellFillCardMessage,
} = require('../dist-electron/main/services/tokenOrderWatcher.js');
const {
  handleFtWatchRegisterRoute,
} = require('../dist-electron/main/services/ftCommerceGatewayRoutes.js');
const {
  registerFtActiveOrder,
  getFtBatchOrderProgress,
  listFtActiveOrders,
} = require('../dist-electron/main/services/ftOrderStore.js');

const SELLER_MVC_ADDR = '1L8me3xT5G1R3gJ8zQ5cS6oX2Y9wQ7hP8c';
const SELLER_BTC_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BUYER_BTC_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

async function withWatcherDb(
  fn: (ctx: { sqliteStore: any; db: any; saveDb: () => void }) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-ft-watcher-'));
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

test('TokenOrderWatcher: detects external MVC TokenSell and BTC PSBT fills, tracks multi-lot progress, and skips self-cancels', async () => {
  await withWatcherDb(async ({ db, saveDb }) => {
    // Batch of 3 MVC TokenSell lots: lot 1 filled by buyer, lot 2 self-canceled by seller, lot 3 still unspent
    for (let i = 1; i <= 3; i += 1) {
      registerFtActiveOrder(
        db,
        {
          listingKey: `mvc-lot-${i}`,
          batchGroupId: 'batch-mvc-3lots',
          metabotId: 2,
          sessionId: i === 1 ? 'sess-watch-1' : undefined,
          chain: 'mvc',
          rail: 'mvc-tokensell',
          assetKey: `mvc-ft:${'11'.repeat(20)}:${'22'.repeat(20)}`,
          symbol: 'SHOW',
          decimals: 8,
          utxoOutpoint: `${String(i).repeat(64)}:0`,
          amountBase: '50000000000',
          amountDisplay: '500',
          priceSats: 250000,
          autoFulfillMe: false,
          sellerAddress: SELLER_MVC_ADDR,
        },
        saveDb,
      );
    }

    // 2 BTC PSBT MRC-20 orders: one filled on mempool (buyer + seller outputs), one self-consolidated (all outputs back to seller)
    const btcOutpointFilled = `${'a'.repeat(64)}:0`;
    const btcOutpointSelf = `${'b'.repeat(64)}:1`;
    registerFtActiveOrder(
      db,
      {
        listingKey: 'btc-psbt-filled',
        batchGroupId: 'batch-btc-1',
        metabotId: 2,
        chain: 'btc',
        rail: 'btc-psbt',
        assetKey: `mrc20:${'c'.repeat(64)}i0`,
        symbol: 'IDCOIN',
        decimals: 8,
        utxoOutpoint: btcOutpointFilled,
        amountBase: '10000000000',
        amountDisplay: '100',
        priceSats: 88000,
        autoFulfillMe: false,
        sellerAddress: SELLER_BTC_ADDR,
      },
      saveDb,
    );
    registerFtActiveOrder(
      db,
      {
        listingKey: 'btc-psbt-self-cancel',
        batchGroupId: 'batch-btc-2',
        metabotId: 2,
        chain: 'btc',
        rail: 'btc-psbt',
        assetKey: `mrc20:${'c'.repeat(64)}i0`,
        symbol: 'IDCOIN',
        decimals: 8,
        utxoOutpoint: btcOutpointSelf,
        amountBase: '10000000000',
        amountDisplay: '100',
        priceSats: 88000,
        autoFulfillMe: false,
        sellerAddress: SELLER_BTC_ADDR,
      },
      saveDb,
    );

    const filledEvents: any[] = [];
    const notifications: any[] = [];

    const mockFetch = async (urlInput: string | URL) => {
      const url = String(urlInput);
      // BTC outspend endpoints
      if (url.includes(`/api/tx/${'a'.repeat(64)}/outspend/0`)) {
        return new Response(JSON.stringify({ spent: true, txid: 'd'.repeat(64) }), { status: 200 });
      }
      if (url.includes(`/api/tx/${'d'.repeat(64)}`)) {
        return new Response(
          JSON.stringify({
            vout: [
              { value: 546, scriptpubkey_address: BUYER_BTC_ADDR },
              { value: 88000, scriptpubkey_address: SELLER_BTC_ADDR },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/api/tx/${'b'.repeat(64)}/outspend/1`)) {
        return new Response(JSON.stringify({ spent: true, txid: 'e'.repeat(64) }), { status: 200 });
      }
      if (url.includes(`/api/tx/${'e'.repeat(64)}`)) {
        return new Response(
          JSON.stringify({
            vout: [{ value: 1200, scriptpubkey_address: SELLER_BTC_ADDR }],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    };

    const watcher = new TokenOrderWatcher(db, saveDb, {
      fetchImpl: mockFetch as any,
      checkMvcTokenSellOrder: async (order: any) => {
        if (order.listingKey === 'mvc-lot-1') {
          return { state: 'filled', filledTxId: 'f'.repeat(64) };
        }
        if (order.listingKey === 'mvc-lot-2') {
          return { state: 'self_canceled', cancelTxId: '9'.repeat(64) };
        }
        return { state: 'unspent' };
      },
      emitToRenderer: (channel: string, payload: unknown) => {
        filledEvents.push({ channel, payload });
      },
      recordNotification: (notif: any) => {
        notifications.push(notif);
      },
      emitLog: () => {},
    });

    const summary = await watcher.pollOnce();
    assert.equal(summary.checked, 5);
    assert.equal(summary.filled, 2);
    assert.equal(summary.canceled, 2);

    // Verify self-cancels NEVER trigger fill notifications or renderer fill events
    assert.equal(filledEvents.length, 2);
    assert.equal(notifications.length, 2);

    const mvcEvent = filledEvents.find((e) => e.payload.listingKey === 'mvc-lot-1');
    assert.ok(mvcEvent);
    assert.equal(mvcEvent.payload.filledLots, 1);
    assert.equal(mvcEvent.payload.totalLots, 3);

    const btcEvent = filledEvents.find((e) => e.payload.listingKey === 'btc-psbt-filled');
    assert.ok(btcEvent);
    assert.equal(btcEvent.payload.filledTxId, 'd'.repeat(64));

    // Verify notification target covers both session-bound and headless fallback
    const mvcNotif = notifications.find((n) => n.eventId === 'ft-fill:mvc-lot-1');
    assert.deepEqual(mvcNotif.target, { kind: 'session', sessionId: 'sess-watch-1' });
    const btcNotif = notifications.find((n) => n.eventId === 'ft-fill:btc-psbt-filled');
    assert.deepEqual(btcNotif.target, { kind: 'bot_automation', metabotId: 2, section: 'surf' });

    // Verify batch progress reflects 1 filled, 1 canceled, 1 active
    const mvcProgress = getFtBatchOrderProgress(db, 'batch-mvc-3lots');
    assert.equal(mvcProgress.totalLots, 3);
    assert.equal(mvcProgress.filledLots, 1);
    assert.equal(mvcProgress.canceledLots, 1);
    assert.equal(mvcProgress.activeLots, 1);

    // Subsequent poll only checks the 1 remaining active order
    const summary2 = await watcher.pollOnce();
    assert.equal(summary2.checked, 1);
    assert.equal(summary2.filled, 0);
    assert.equal(listFtActiveOrders(db, { status: 'active' }).length, 1);
  });
});

test('TokenOrderWatcher passive sell card: polls /api/v1/market/mrc20/order/detail, builds S-1 ft-fill-card(side=sell), and pushes to Cowork session', async () => {
  await withWatcherDb(async ({ db, saveDb }) => {
    // Register via gateway route with snake_case session_id + per-lot marketOrderId
    const gwRes = await handleFtWatchRegisterRoute(
      {
        getDb: () => db,
        saveDb,
        getMetabotStore: () => ({
          getMetabotById: () => ({
            id: 7,
            name: 'SellerBot',
            mvc_address: SELLER_MVC_ADDR,
            btc_address: SELLER_BTC_ADDR,
          }),
        }),
      },
      JSON.stringify({
        metabotId: 7,
        session_id: '', // empty to test fallback session resolution!
        lots: [
          {
            listingKey: 'btc-mkt-ord-99',
            batchGroupId: 'batch-mkt-99',
            chain: 'btc',
            rail: 'btc-psbt',
            assetKey: `mrc20:${'e'.repeat(64)}i0`,
            symbol: 'METAID',
            decimals: 8,
            amountBase: '50000000000',
            amountDisplay: '500',
            utxoOutpoint: `${'7'.repeat(64)}:0`,
            priceSats: 720000,
            marketOrderId: 'mkt_order_live_99',
          },
        ],
      }),
    );
    assert.equal(gwRes.status, 200);
    assert.equal(gwRes.body.count, 1);

    const requestedUrls: string[] = [];
    const passivePushes: Array<{ content: string; buyerAddress?: string }> = [];
    const notifications: any[] = [];
    const dealTxId = '8'.repeat(64);

    const watcher = new TokenOrderWatcher(db, saveDb, {
      fetchImpl: (async (urlInput: string | URL) => {
        const u = String(urlInput);
        requestedUrls.push(u);
        if (u.includes('/api-market/api/v1/market/mrc20/order/detail?orderId=mkt_order_live_99')) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                orderId: 'mkt_order_live_99',
                orderState: 3,
                txId: dealTxId,
                buyerAddress: BUYER_BTC_ADDR,
              },
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 404 });
      }) as any,
      onOrderFilledPassive: (event: any, order: any, meta: { buyerAddress?: string }) => {
        const content = buildPassiveSellFillCardMessage({
          assetKey: order.assetKey,
          symbol: order.symbol,
          rail: order.rail,
          chain: order.chain,
          amountDisplay: order.amountDisplay,
          priceSats: order.priceSats,
          filledTxId: event.filledTxId,
          buyerAddress: meta.buyerAddress,
          filledLots: event.filledLots,
          totalLots: event.totalLots,
        });
        passivePushes.push({ content, buyerAddress: meta.buyerAddress });
        return { sessionId: 'sess-owner-fallback-7' };
      },
      recordNotification: (notif: any) => notifications.push(notif),
      emitLog: () => {},
    });

    const res = await watcher.pollOnce();
    assert.equal(res.checked, 1);
    assert.equal(res.filled, 1);
    assert.ok(
      requestedUrls.some((u) => u.includes('/api/v1/market/mrc20/order/detail?orderId=mkt_order_live_99')),
    );
    assert.equal(passivePushes.length, 1);
    assert.equal(passivePushes[0].buyerAddress, BUYER_BTC_ADDR);
    assert.match(passivePushes[0].content, /```ft-fill-card/);
    assert.match(passivePushes[0].content, /"side":\s*"sell"/);
    assert.match(passivePushes[0].content, /0\.0072 BTC \(720,000 sats\)/);
    assert.match(passivePushes[0].content, /买家 bc1qar\.\.\.5mdq/);
    // Fallback session ID returned by onOrderFilledPassive upgrades notification target to session!
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].target, {
      kind: 'session',
      sessionId: 'sess-owner-fallback-7',
    });
  });
});
