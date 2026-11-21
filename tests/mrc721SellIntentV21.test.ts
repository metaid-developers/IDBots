import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  declareMrc721SellIntent,
  parseMrc721SellIntent,
  findLocalActiveSellIntentForItem,
  markMrc721SellIntentSold,
  recordAcceptedGoodsQuote,
  findAcceptedGoodsQuoteForItem,
  markAcceptedGoodsQuoteUsed,
  broadcastMrc721TradeReceipt,
  MRC721_SELL_INTENT_PATH,
  MRC721_TRADE_RECEIPT_PATH,
} = require('../dist-electron/main/services/mrc721SellIntentService.js');
const {
  buildGoodsTradeAgentTools,
} = require('../dist-electron/main/libs/goodsTradeAgentTools.js');

const ITEM_PIN_ID = `${'11'.repeat(32)}i0`;
const ITEM_PIN_ID_2 = `${'22'.repeat(32)}i0`;
const COLLECTION_PIN_ID = `${'aa'.repeat(32)}i0`;
const SHOP_METAAPP_PIN_ID = `${'ff'.repeat(32)}i0`;
const SELLER_ADDR = '1L8me3xT5G1R3gJ8zQ5cS6oX2Y9wQ7hP8c';
const SELLER_METAID = 'idq1seller00000000000000000000000000000000';
const BUYER_ADDR = '1Lbcfr7sAHTD9CgdQo3HTMTkV8LK4ZnX71';
const BUYER_METAID = 'idq1buyer000000000000000000000000000000000';

function makeKv() {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    set: <T>(k: string, v: T) => {
      map.set(k, v);
    },
  };
}

function makeFakeSdkTool() {
  return (name: string, description: string, schema: unknown, handler: (args: any) => Promise<any>) => ({
    name,
    description,
    schema,
    handler,
  });
}

test('mrc721sell v2.1: parses dual ME + CNY pricing, autoFulfillMe, negotiable, and shopMetaAppPinId', () => {
  const parsed = parseMrc721SellIntent({
    itemPinId: ITEM_PIN_ID,
    sellerAddress: SELLER_ADDR,
    sellerMetaId: SELLER_METAID,
    collectionPinId: COLLECTION_PIN_ID,
    collectionName: 'digital-passes',
    prices: {
      me: { amountMilli: 5500 },
      fiat: { currency: 'CNY', amountCents: 1990 },
    },
    autoFulfillMe: true,
    negotiable: true,
    shopMetaAppPinId: SHOP_METAAPP_PIN_ID,
    note: 'instant delivery pass',
  });

  assert.equal(parsed.prices?.me?.amountMilli, 5500);
  assert.equal(parsed.prices?.fiat?.currency, 'CNY');
  assert.equal(parsed.prices?.fiat?.amountCents, 1990);
  assert.equal(parsed.autoFulfillMe, true);
  assert.equal(parsed.negotiable, true);
  assert.equal(parsed.shopMetaAppPinId, SHOP_METAAPP_PIN_ID);
  assert.ok(parsed.acceptedCurrencies.includes('me'));
  assert.ok(parsed.acceptedCurrencies.includes('fiat:CNY'));
  assert.ok(parsed.settlement.includes('me-escrow'));
  assert.ok(parsed.settlement.includes('fiat-escrow'));
});

test('mrc721sell v2.1: rejects ME < 1000 milli-ME and CNY < 100 cents', () => {
  assert.throws(
    () => parseMrc721SellIntent({
      itemPinId: ITEM_PIN_ID,
      sellerAddress: SELLER_ADDR,
      prices: { me: { amountMilli: 999 } },
    }),
    /1000/,
  );

  assert.throws(
    () => parseMrc721SellIntent({
      itemPinId: ITEM_PIN_ID,
      sellerAddress: SELLER_ADDR,
      prices: { fiat: { currency: 'CNY', amountCents: 50 } },
    }),
    /100/,
  );
});

test('mrc721sell v2.1: declare + markSold lifecycle updates status to sold and removes from active lookup', async () => {
  const kv = makeKv();
  const pins: any[] = [];
  const store = {
    getMetabotById: () => ({ mvc_address: SELLER_ADDR, globalmetaid: SELLER_METAID }),
  };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 1,
    data: {
      itemPinId: ITEM_PIN_ID,
      collectionPinId: COLLECTION_PIN_ID,
      collectionName: 'digital-passes',
      ownerAddress: SELLER_ADDR,
      output: `${'11'.repeat(32)}:0`,
      outputValue: 1,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const res = await declareMrc721SellIntent(
      {
        createPin: async (metabotId: number, data: unknown) => {
          pins.push({ metabotId, data });
          return { pinId: `${'cc'.repeat(32)}i0`, txids: ['tx_sell_1'], totalCost: 400 };
        },
      },
      {
        metabotId: 1,
        itemPinId: ITEM_PIN_ID,
        priceMeMilli: 3000,
        priceCnyCents: 800,
        autoFulfillMe: true,
        negotiable: true,
        shopMetaAppPinId: SHOP_METAAPP_PIN_ID,
        store,
        intents: kv,
      },
    );

    assert.equal(pins.length, 1);
    assert.equal(pins[0].data.path, MRC721_SELL_INTENT_PATH);
    assert.equal(res.intent.autoFulfillMe, true);
    assert.equal(res.intent.prices?.me?.amountMilli, 3000);

    const activeBefore = findLocalActiveSellIntentForItem(kv, 1, ITEM_PIN_ID);
    assert.ok(activeBefore);
    assert.equal(activeBefore.status, 'active');
    assert.equal(activeBefore.autoFulfillMe, true);
    assert.equal(activeBefore.intent.prices?.me?.amountMilli, 3000);

    const marked = markMrc721SellIntentSold(kv, 1, ITEM_PIN_ID, {
      orderId: 'order_123',
      txId: 'tx_deliv_123',
    });
    assert.equal(marked, true);

    const activeAfter = findLocalActiveSellIntentForItem(kv, 1, ITEM_PIN_ID);
    assert.equal(activeAfter, null);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('accepted goods quotes: record, lookup active, and mark used', () => {
  const kv = makeKv();
  const future = Math.floor(Date.now() / 1000) + 3600;
  recordAcceptedGoodsQuote(kv, 7, {
    inquiryId: 'inq_1',
    itemPinId: ITEM_PIN_ID,
    agreedCurrency: 'me',
    agreedAmountMilli: 2500,
    sellerBotAddress: SELLER_ADDR,
    validUntil: future,
  });

  const found = findAcceptedGoodsQuoteForItem(kv, 7, ITEM_PIN_ID);
  assert.ok(found);
  assert.equal(found.agreedAmountMilli, 2500);
  assert.equal(found.status, 'active');

  const used = markAcceptedGoodsQuoteUsed(kv, 7, ITEM_PIN_ID, 'ord_99');
  assert.equal(used, true);
  assert.equal(findAcceptedGoodsQuoteForItem(kv, 7, ITEM_PIN_ID), null);
});

test('broadcastMrc721TradeReceipt emits /protocols/mrc721trade CREATE pin', async () => {
  const captured: any[] = [];
  const res = await broadcastMrc721TradeReceipt(
    {
      createPin: async (metabotId: number, metaidData: any) => {
        captured.push({ metabotId, metaidData });
        return { pinId: `${'dd'.repeat(32)}i0`, txids: ['tx_trade_1'], totalCost: 300 };
      },
    },
    {
      metabotId: 3,
      txId: 'tx_deliv_9',
      orderId: 'ord_9',
      itemPinId: ITEM_PIN_ID,
      collectionPinId: COLLECTION_PIN_ID,
      sellerAddress: SELLER_ADDR,
      sellerMetaId: SELLER_METAID,
      buyerAddress: BUYER_ADDR,
      buyerMetaId: BUYER_METAID,
      currency: 'me',
      amountMilli: 5000,
    },
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].metaidData.path, MRC721_TRADE_RECEIPT_PATH);
  const payload = JSON.parse(captured[0].metaidData.payload);
  assert.equal(payload.verifiedSource, 'abs_escrow');
  assert.equal(payload.currency, 'me');
  assert.equal(payload.amountMilli, 5000);
  assert.equal(payload.txId, 'tx_deliv_9');
  assert.equal(res.txids[0], 'tx_trade_1');
});

test('goods_market_summary, goods_market_search, and goods_holder_lookup tools format market catalog and nft-cards', async () => {
  const tools = buildGoodsTradeAgentTools({
    tool: makeFakeSdkTool() as any,
    sessionId: 'sess-market-test',
    resolveMetabotId: () => 1,
    confirmGoodsPurchase: async () => false,
    control: {
      getMetabotIdentity: () => ({ name: 'BuyerBot', mvcAddress: BUYER_ADDR, globalMetaId: BUYER_METAID }),
      getTradeBalance: async () => ({
        botAddress: BUYER_ADDR,
        tradeSpendableMilli: 0,
        frozenMilli: 0,
        totalAvailableMilli: 0,
        weeklyRemainingMilli: 0,
        earnedMilli: 0,
        topupMilli: 0,
        bonusMilli: 0,
        raw: {},
      }),
      createEscrowOrder: async () => { throw new Error('unused'); },
      getEscrowOrder: async () => { throw new Error('unused'); },
      sendTradeMessage: async () => { throw new Error('unused'); },
      fetchCaRegistry: async () => ({
        verified: true,
        collections: [{ collectionPinId: COLLECTION_PIN_ID, collectionName: 'digital-passes' }],
      }),
      fetchMarketCollections: async () => ({
        items: [{
          collectionPinId: COLLECTION_PIN_ID,
          collectionName: 'digital-passes',
          displayTitle: 'Digital Passes',
          listedCount: 4,
          floorPriceMeMilli: 2000,
          floorPriceCnyCents: 600,
          caVerified: true,
        }],
      }),
      fetchMarketTrades: async () => ({
        items: [{
          itemPinId: ITEM_PIN_ID_2,
          amountMilli: 2200,
          currency: 'me',
          txId: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        }],
      }),
      fetchMarketListings: async () => ({
        items: [{
          intentPinId: `${'ee'.repeat(32)}i0`,
          itemPinId: ITEM_PIN_ID,
          itemName: 'Pro Prompt Pack',
          collectionPinId: COLLECTION_PIN_ID,
          collectionName: 'digital-passes',
          prices: {
            me: { amountMilli: 4500 },
            fiat: { currency: 'CNY', amountCents: 990 },
          },
          autoFulfillMe: true,
          negotiable: true,
          shopMetaAppPinId: SHOP_METAAPP_PIN_ID,
          caVerified: true,
          seller: {
            address: SELLER_ADDR,
            globalMetaId: SELLER_METAID,
            name: 'SellerBot',
            isOnline: true,
          },
        }],
      }),
      fetchCollectionHolders: async () => ({
        holderCount: 1,
        list: [{ address: SELLER_ADDR, name: 'SellerBot', itemCount: 2, listedItemCount: 1 }],
      }),
    },
  }) as Array<{ name: string; handler: (args: any) => Promise<any> }>;

  const summaryTool = tools.find((t) => t.name === 'goods_market_summary')!;
  const searchTool = tools.find((t) => t.name === 'goods_market_search')!;
  const holderTool = tools.find((t) => t.name === 'goods_holder_lookup')!;

  const summaryOut = await summaryTool.handler({});
  assert.match(summaryOut.content[0].text, /Digital Passes \[Verified\]/);
  assert.match(summaryOut.content[0].text, /2 ME/);

  const searchOut = await searchTool.handler({ ca_only: true });
  const searchText = searchOut.content[0].text;
  assert.match(searchText, /Pro Prompt Pack/);
  assert.match(searchText, /```nft-card/);
  assert.match(searchText, /"priceMeMilli":4500/);
  assert.match(searchText, /"caVerified":true/);
  assert.match(searchText, /"sellerOnline":true/);

  const holderOut = await holderTool.handler({ collection_pin_id: COLLECTION_PIN_ID });
  assert.match(holderOut.content[0].text, /SellerBot/);
  assert.match(holderOut.content[0].text, /count=2/);
});
