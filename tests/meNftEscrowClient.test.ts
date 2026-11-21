import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  getBotTradeSpendableBalance,
  createNftEscrowOrder,
  getNftEscrowOrder,
  listNftEscrowOrders,
  deliverNftEscrowOrder,
  rejectNftEscrowOrder,
  MeNftEscrowApiError,
} = require('../dist-electron/main/services/meNftEscrowService.js');
const {
  buildGoodsTradeAgentTools,
} = require('../dist-electron/main/libs/goodsTradeAgentTools.js');

const BOT_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOT_ADDRESS = '1L8me3xT5G1R3gJ8zQ5cS6oX2Y9wQ7hP8c';
const SELLER_ADDRESS = '1Lbcfr7sAHTD9CgdQo3HTMTkV8LK4ZnX71';
const BUYER_IDENTITY_ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const SELLER_IDENTITY_ADDR = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const DELIVERY_TXID = '9a'.repeat(32);
const BUYER_METAID = 'idq1buyer000000000000000000000000000000000';
const SELLER_METAID = 'idq1seller00000000000000000000000000000000';
const ITEM_PIN_ID = `${'aa'.repeat(32)}i0`;
const COLLECTION_PIN_ID = `${'bb'.repeat(32)}i0`;
const LISTING_PIN_ID = `${'cc'.repeat(32)}i0`;

const mockSignAction = async (action: string, identity: { mvcAddress: string }) => ({
  address: identity.mvcAddress,
  timestampMs: '1700000000123',
  signature: `sig_${action}_${identity.mvcAddress}`,
});

test('meNftEscrowService aligns with ABS b83c76f headers, request body, NftEscrowOrderView, and bonusMilli exclusion', async () => {
  const seenRequests: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    seenRequests.push({
      url: String(input),
      method: init?.method || 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (String(input).includes('/v1/me/balance')) {
      // Simulate server omitting tradeSpendableMilli to verify client fallback EXCLUDES bonusMilli
      return new Response(JSON.stringify({
        code: 0,
        data: {
          identityAddress: BOT_ADDRESS,
          spendableMilli: 90000,
          frozenMilli: 1000,
          totalAvailable: 91000,
          weeklyGrant: { remainingMilli: 38000 },
          persistent: { earnedMilli: 7000, topupMilli: 6000, bonusMilli: 50000 },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      code: 0,
      data: {
        orderId: 'ord_1',
        itemPinId: ITEM_PIN_ID,
        collectionPinId: COLLECTION_PIN_ID,
        listingPinId: LISTING_PIN_ID,
        buyerNftAddress: BOT_ADDRESS,
        buyerBotAddress: BOT_ADDRESS,
        buyerIdentityAddress: BUYER_IDENTITY_ADDR,
        sellerBotAddress: SELLER_ADDRESS,
        sellerPayeeAddress: SELLER_ADDRESS,
        sellerIdentityAddress: SELLER_IDENTITY_ADDR,
        amountMilli: 5000,
        status: 1,
        statusName: 'FROZEN_AWAITING_DELIVERY',
        deliveryDeadline: 1795200900,
        createdAt: 1795200000,
        applied: true,
      },
    }), { status: 200 });
  }) as typeof fetch;

  const signer = { mnemonic: BOT_MNEMONIC };
  const bal = await getBotTradeSpendableBalance(signer, {
    baseUrl: 'https://abs.example.test',
    fetchImpl,
    signAction: mockSignAction,
  });
  // earned(7000) + topup(6000) - frozen(1000) = 12000; bonusMilli(50000) MUST NOT be included
  assert.equal(bal.tradeSpendableMilli, 12000);
  assert.equal(bal.weeklyRemainingMilli, 38000);

  const created = await createNftEscrowOrder(
    signer,
    {
      orderId: 'ord_1',
      itemPinId: ITEM_PIN_ID,
      collectionPinId: COLLECTION_PIN_ID,
      buyerNftAddress: BOT_ADDRESS,
      sellerBotAddress: SELLER_ADDRESS,
      sellerPayeeAddress: SELLER_ADDRESS,
      amountMilli: 5000,
      listingPinId: LISTING_PIN_ID,
      deliveryTimeoutSec: 900,
      idempotencyKey: 'idem_1',
    },
    { baseUrl: 'https://abs.example.test', fetchImpl, signAction: mockSignAction },
  );
  assert.equal(created.status, 'FROZEN_AWAITING_DELIVERY');
  assert.equal(created.statusCode, 1);
  assert.equal(created.statusName, 'FROZEN_AWAITING_DELIVERY');
  assert.equal(created.buyerNftAddress, BOT_ADDRESS);
  assert.equal(created.sellerBotAddress, SELLER_ADDRESS);
  assert.equal(created.buyerIdentityAddress, BUYER_IDENTITY_ADDR);
  assert.equal(created.sellerIdentityAddress, SELLER_IDENTITY_ADDR);
  assert.equal(created.deliveryDeadline, 1795200900);

  assert.equal(seenRequests.length, 2);
  for (const req of seenRequests) {
    assert.ok(req.headers['x-bot-address'], 'X-Bot-Address must be set');
    assert.ok(req.headers['x-timestamp'], 'X-Timestamp must be set');
    assert.ok(req.headers['x-signature'], 'X-Signature must be set');
    assert.equal(req.headers['x-identity-address'], undefined, 'X-Identity-Address MUST be omitted');
  }
  assert.equal(seenRequests[1].method, 'POST');
  assert.ok(seenRequests[1].url.endsWith('/v1/me/nft-escrow/orders'));
  const body = JSON.parse(seenRequests[1].body!);
  assert.equal(body.orderId, 'ord_1');
  assert.equal(body.itemPinId, ITEM_PIN_ID);
  assert.equal(body.collectionPinId, COLLECTION_PIN_ID);
  assert.equal(body.buyerNftAddress, BOT_ADDRESS);
  assert.equal(body.sellerBotAddress, SELLER_ADDRESS);
  assert.equal(body.sellerPayeeAddress, SELLER_ADDRESS);
  assert.equal(body.listingPinId, LISTING_PIN_ID);
  assert.equal(body.deliveryTimeoutSec, 900);
  assert.equal(body.idempotencyKey, 'idem_1');
  assert.equal(body.amountMilli, 5000);
  // Must NOT send deprecated Go-incompatible body fields
  assert.equal(body.sellerAddress, undefined);
  assert.equal(body.sellPinId, undefined);
  assert.equal(body.ttlSeconds, undefined);
});

test('meNftEscrowService supports ABS status codes 1..6, beforeId pagination, deliver, reject, and MeNftEscrowApiError', async () => {
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (url.endsWith('/v1/me/nft-escrow/orders/ord_fail') && method === 'GET') {
      return new Response(JSON.stringify({
        errorCode: 'INSUFFICIENT_ME',
        message: 'not enough persistent ME',
        neededMilli: 5000,
        haveMilli: 2000,
      }), { status: 400 });
    }
    if (url.includes('/v1/me/nft-escrow/orders?role=seller&status=FROZEN_AWAITING_DELIVERY&beforeId=ord_0')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          orders: [{
            orderId: 'ord_locked_1',
            itemPinId: ITEM_PIN_ID,
            collectionPinId: COLLECTION_PIN_ID,
            buyerNftAddress: BOT_ADDRESS,
            sellerBotAddress: SELLER_ADDRESS,
            amountMilli: 3000,
            status: 1,
            statusName: 'FROZEN_AWAITING_DELIVERY',
          }],
        },
      }), { status: 200 });
    }
    if (url.endsWith('/deliver')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          order: {
            orderId: 'ord_locked_1',
            itemPinId: ITEM_PIN_ID,
            buyerNftAddress: BOT_ADDRESS,
            sellerBotAddress: SELLER_ADDRESS,
            amountMilli: 3000,
            status: 3,
            statusName: 'SETTLED',
            deliveryTxId: DELIVERY_TXID,
            settlementEntryId: 'entry_9001',
            settledAt: 1795200500,
          },
        },
      }), { status: 200 });
    }
    if (url.endsWith('/reject')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          order: {
            orderId: 'ord_locked_1',
            itemPinId: ITEM_PIN_ID,
            buyerNftAddress: BOT_ADDRESS,
            sellerBotAddress: SELLER_ADDRESS,
            amountMilli: 3000,
            status: 5,
            statusName: 'CANCELED_REFUNDED',
            verifyDetail: 'seller_no_longer_holds',
          },
        },
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const opts = { baseUrl: 'https://abs.example.test', fetchImpl, signAction: mockSignAction };
  const signer = { mnemonic: BOT_MNEMONIC };

  await assert.rejects(
    () => getNftEscrowOrder(signer, 'ord_fail', opts),
    (err: any) => err instanceof MeNftEscrowApiError && err.errorCode === 'INSUFFICIENT_ME' && err.neededMilli === 5000,
  );

  const list = await listNftEscrowOrders(
    signer,
    { role: 'seller', status: 'FROZEN_AWAITING_DELIVERY', beforeId: 'ord_0' },
    opts,
  );
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].orderId, 'ord_locked_1');
  assert.equal(list.orders[0].status, 'FROZEN_AWAITING_DELIVERY');
  assert.equal(list.orders[0].statusCode, 1);

  const delivered = await deliverNftEscrowOrder(signer, 'ord_locked_1', { deliveryTxId: DELIVERY_TXID }, opts);
  assert.equal(delivered.status, 'SETTLED');
  assert.equal(delivered.statusCode, 3);
  assert.equal(delivered.settlementEntryId, 'entry_9001');
  assert.equal(delivered.deliveryTxId, DELIVERY_TXID);

  const rejected = await rejectNftEscrowOrder(signer, 'ord_locked_1', { reason: 'seller_no_longer_holds' }, opts);
  assert.equal(rejected.status, 'CANCELED_REFUNDED');
  assert.equal(rejected.statusCode, 5);
  assert.equal(rejected.verifyDetail, 'seller_no_longer_holds');
});

test('goods_buy_with_me, goods_send_inquiry, and goods_accept_inquiry align with C5.2 wire protocol and confirmation gates', async () => {
  const makeSdkTool = (name: string, description: string, schema: unknown, handler: (args: any) => Promise<any>) => ({
    name,
    description,
    schema,
    handler,
  });

  const sentMessages: Array<{ toGlobalMetaId: string; content: string }> = [];
  const settledEvents: any[] = [];
  const markedQuotes: any[] = [];
  const sellerAuthorizedQuotes: any[] = [];
  let tradeSpendableMilli = 1000;
  let confirmResponse = true;
  let confirmQuoteResponse = true;
  let pollCount = 0;

  const tools = buildGoodsTradeAgentTools({
    tool: makeSdkTool as any,
    sessionId: 'sess-buyer-1',
    resolveMetabotId: () => 2,
    confirmGoodsPurchase: async () => confirmResponse,
    confirmGoodsQuoteAcceptance: async () => confirmQuoteResponse,
    control: {
      getMetabotIdentity: () => ({ name: 'BuyerBot', mvcAddress: BOT_ADDRESS, globalMetaId: BUYER_METAID }),
      getTradeBalance: async () => ({
        botAddress: BOT_ADDRESS,
        tradeSpendableMilli,
        frozenMilli: 0,
        totalAvailableMilli: tradeSpendableMilli + 50000,
        weeklyRemainingMilli: 50000,
        earnedMilli: tradeSpendableMilli,
        topupMilli: 0,
        bonusMilli: 0,
        raw: {},
      }),
      createEscrowOrder: async (input: any) => ({
        orderId: input.orderId,
        itemPinId: input.itemPinId,
        collectionPinId: input.collectionPinId,
        listingPinId: input.listingPinId,
        buyerNftAddress: input.buyerNftAddress,
        buyerAddress: input.buyerNftAddress,
        sellerBotAddress: input.sellerBotAddress,
        sellerAddress: input.sellerBotAddress,
        amountMilli: input.amountMilli,
        status: 'FROZEN_AWAITING_DELIVERY',
        statusCode: 1,
        statusName: 'FROZEN_AWAITING_DELIVERY',
        raw: {},
      }),
      getEscrowOrder: async (input: any) => {
        pollCount += 1;
        return {
          orderId: input.orderId,
          itemPinId: ITEM_PIN_ID,
          buyerNftAddress: BOT_ADDRESS,
          buyerAddress: BOT_ADDRESS,
          sellerBotAddress: SELLER_ADDRESS,
          sellerAddress: SELLER_ADDRESS,
          amountMilli: 5000,
          status: pollCount >= 1 ? 'SETTLED' : 'FROZEN_AWAITING_DELIVERY',
          statusCode: pollCount >= 1 ? 3 : 1,
          statusName: pollCount >= 1 ? 'SETTLED' : 'FROZEN_AWAITING_DELIVERY',
          deliveryTxId: 'tx_settled_123',
          raw: {},
        };
      },
      sendTradeMessage: async (input: any) => {
        sentMessages.push({ toGlobalMetaId: input.toGlobalMetaId, content: input.content });
        return { txids: ['tx_dm_1'], pinId: `${'bb'.repeat(32)}i0` };
      },
      findAcceptedQuote: () => ({
        inquiryId: 'inq_9',
        itemPinId: ITEM_PIN_ID,
        agreedCurrency: 'me',
        agreedAmountMilli: 5000,
        sellerBotAddress: SELLER_ADDRESS,
        validUntil: Math.floor(Date.now() / 1000) + 600,
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      }),
      markAcceptedQuoteUsed: (_metabotId: number, itemPinId: string, orderId?: string) => {
        markedQuotes.push({ itemPinId, orderId });
        return true;
      },
      recordSellerAuthorizedQuote: (metabotId: number, quote: any) => {
        const saved = { ...quote, metabotId, status: 'active' as const, createdAt: 1, updatedAt: 1 };
        sellerAuthorizedQuotes.push(saved);
        return saved;
      },
      onPurchaseSettled: (ev: any) => settledEvents.push(ev),
      fetchItemInfo: async () => ({
        itemPinId: ITEM_PIN_ID,
        collectionPinId: COLLECTION_PIN_ID,
        name: 'VIP Pass',
        collectionName: 'passes',
        ownerAddress: SELLER_ADDRESS,
        ownerMetaId: SELLER_METAID,
        burned: false,
      }),
      fetchMarketListings: async () => ({
        items: [{
          intentPinId: LISTING_PIN_ID,
          itemPinId: ITEM_PIN_ID,
          collectionPinId: COLLECTION_PIN_ID,
          itemName: 'VIP Pass',
          collectionName: 'passes',
          prices: { me: { amountMilli: 8000 } },
          seller: { address: SELLER_ADDRESS, globalMetaId: SELLER_METAID, name: 'SellerBot' },
        }],
      }),
      pollDelaysMs: [0],
    },
  }) as Array<{ name: string; handler: (args: any) => Promise<any> }>;

  const buyTool = tools.find((t) => t.name === 'goods_buy_with_me')!;
  const inquiryTool = tools.find((t) => t.name === 'goods_send_inquiry')!;
  const acceptTool = tools.find((t) => t.name === 'goods_accept_inquiry')!;
  assert.ok(acceptTool, 'goods_accept_inquiry tool must be registered');

  // 1. Weekly grant is 50 ME, but tradeSpendableMilli is 1 ME (< 5 ME quote) -> rejected before confirm
  const lowBal = await buyTool.handler({ item_pin_id: ITEM_PIN_ID });
  assert.equal(lowBal.isError, true);
  assert.match(lowBal.content[0].text, /INSUFFICIENT_TRADE_ME/);

  // 2. Sufficient tradeSpendableMilli, but owner denies confirmation -> cancelled cleanly
  tradeSpendableMilli = 10000;
  confirmResponse = false;
  const denied = await buyTool.handler({ item_pin_id: ITEM_PIN_ID });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /did not confirm/);

  // 3. Approved -> locks escrow using accepted quote (5000 milli-ME), dispatches ME_ESCROW_LOCKED_V1, polls & settles
  confirmResponse = true;
  const ok = await buyTool.handler({ item_pin_id: ITEM_PIN_ID, order_id: 'ord_buy_1' });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /SETTLED: ord_buy_1/);
  assert.match(ok.content[0].text, /tx_settled_123/);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].toGlobalMetaId, SELLER_METAID);
  assert.match(sentMessages[0].content, /ME_ESCROW_LOCKED_V1/);
  assert.match(sentMessages[0].content, /"buyerNftAddress"/);
  assert.match(sentMessages[0].content, /"sellerBotAddress"/);
  assert.equal(markedQuotes.length, 1);
  assert.equal(settledEvents.length, 1);
  assert.equal(settledEvents[0].deliveryTxId, 'tx_settled_123');

  // 4. Inquiry tool sends GOODS_INQUIRY_V1 with C5.2 fields
  const inq = await inquiryTool.handler({ item_pin_id: ITEM_PIN_ID, offer_me: 4.5, note: 'Can you do 4.5 ME?' });
  assert.equal(inq.isError, undefined);
  assert.match(sentMessages[1].content, /GOODS_INQUIRY_V1/);
  assert.match(sentMessages[1].content, /"offerAmountMilli":\s*4500/);
  assert.match(sentMessages[1].content, /"buyerNftAddress"/);
  assert.match(sentMessages[1].content, /"buyerGlobalMetaId"/);

  // 5. Seller accept-inquiry tool checks live ownership (rejects if bot does not hold item)
  const notOwnerRes = await acceptTool.handler({
    inquiry_id: 'inq_9',
    item_pin_id: ITEM_PIN_ID,
    buyer_global_metaid: BUYER_METAID,
    agreed_me: 4.5,
  });
  assert.equal(notOwnerRes.isError, true);
  assert.match(notOwnerRes.content[0].text, /does not currently hold/);

  // 6. Seller accept-inquiry succeeds when session bot IS the holder
  const sellerTools = buildGoodsTradeAgentTools({
    tool: makeSdkTool as any,
    sessionId: 'sess-seller-1',
    resolveMetabotId: () => 1,
    confirmGoodsPurchase: async () => true,
    confirmGoodsQuoteAcceptance: async () => confirmQuoteResponse,
    control: {
      getMetabotIdentity: () => ({ name: 'SellerBot', mvcAddress: SELLER_ADDRESS, globalMetaId: SELLER_METAID }),
      getTradeBalance: async () => { throw new Error('unused'); },
      createEscrowOrder: async () => { throw new Error('unused'); },
      getEscrowOrder: async () => { throw new Error('unused'); },
      sendTradeMessage: async (input: any) => {
        sentMessages.push({ toGlobalMetaId: input.toGlobalMetaId, content: input.content });
        return { txids: ['tx_dm_quote'], pinId: `${'dd'.repeat(32)}i0` };
      },
      recordSellerAuthorizedQuote: (metabotId: number, quote: any) => {
        const saved = { ...quote, metabotId, status: 'active' as const, createdAt: 1, updatedAt: 1 };
        sellerAuthorizedQuotes.push(saved);
        return saved;
      },
      fetchItemInfo: async () => ({
        itemPinId: ITEM_PIN_ID,
        collectionPinId: COLLECTION_PIN_ID,
        name: 'VIP Pass',
        ownerAddress: SELLER_ADDRESS,
        ownerMetaId: SELLER_METAID,
        burned: false,
      }),
    },
  }) as Array<{ name: string; handler: (args: any) => Promise<any> }>;
  const sellerAcceptTool = sellerTools.find((t) => t.name === 'goods_accept_inquiry')!;
  const acceptedRes = await sellerAcceptTool.handler({
    inquiry_id: 'inq_9',
    item_pin_id: ITEM_PIN_ID,
    buyer_global_metaid: BUYER_METAID,
    buyer_nft_address: BOT_ADDRESS,
    agreed_me: 4.5,
  });
  assert.equal(acceptedRes.isError, undefined);
  assert.equal(sellerAuthorizedQuotes.length, 1);
  assert.equal(sellerAuthorizedQuotes[0].agreedAmountMilli, 4500);
  assert.equal(sellerAuthorizedQuotes[0].buyerNftAddress, BOT_ADDRESS);
  assert.match(sentMessages[2].content, /GOODS_QUOTE_ACCEPT_V1/);
  assert.match(sentMessages[2].content, /"agreedCurrency":\s*"me"/);
  assert.match(sentMessages[2].content, /"agreedAmountMilli":\s*4500/);
  assert.match(sentMessages[2].content, /"sellerBotAddress"/);

  // 7. goods_buy_with_me falls back to fetchItemVerify for collectionPinId and refuses when unresolvable
  let capturedOrderCollectionPinId = '';
  let verifyCollectionPinId: string | undefined = COLLECTION_PIN_ID;
  const fallbackTools = buildGoodsTradeAgentTools({
    tool: makeSdkTool as any,
    sessionId: 'sess-buyer-fallback',
    resolveMetabotId: () => 2,
    confirmGoodsPurchase: async () => true,
    control: {
      getMetabotIdentity: () => ({ name: 'BuyerBot', mvcAddress: BOT_ADDRESS, globalMetaId: BUYER_METAID }),
      getTradeBalance: async () => ({
        botAddress: BOT_ADDRESS,
        tradeSpendableMilli: 10000,
        frozenMilli: 0,
        totalAvailableMilli: 10000,
        weeklyRemainingMilli: 0,
        earnedMilli: 10000,
        topupMilli: 0,
        bonusMilli: 0,
        raw: {},
      }),
      createEscrowOrder: async (input: any) => {
        capturedOrderCollectionPinId = input.collectionPinId;
        return {
          orderId: input.orderId,
          itemPinId: input.itemPinId,
          collectionPinId: input.collectionPinId,
          buyerNftAddress: input.buyerNftAddress,
          buyerAddress: input.buyerNftAddress,
          sellerBotAddress: input.sellerBotAddress,
          sellerAddress: input.sellerBotAddress,
          amountMilli: input.amountMilli,
          status: 'SETTLED',
          statusCode: 3,
          statusName: 'SETTLED',
          raw: {},
        };
      },
      getEscrowOrder: async () => { throw new Error('unused'); },
      sendTradeMessage: async () => ({ txids: ['tx_1'], pinId: `${'ee'.repeat(32)}i0` }),
      fetchItemInfo: async () => ({
        itemPinId: ITEM_PIN_ID,
        // Intentionally omit collectionPinId to exercise fetchItemVerify fallback
        name: 'Unindexed Collection Field Item',
        ownerAddress: SELLER_ADDRESS,
        ownerMetaId: SELLER_METAID,
        burned: false,
      }),
      fetchItemVerify: async () => ({
        itemPinId: ITEM_PIN_ID,
        collectionid: verifyCollectionPinId,
      }),
      fetchMarketListings: async () => ({ items: [] }),
      fetchSellIntents: async () => ({ items: [], total: 0 }),
      pollDelaysMs: [0],
    },
  }) as Array<{ name: string; handler: (args: any) => Promise<any> }>;
  const fallbackBuy = fallbackTools.find((t) => t.name === 'goods_buy_with_me')!;
  const fallbackOk = await fallbackBuy.handler({ item_pin_id: ITEM_PIN_ID, amount_me: 2, order_id: 'ord_fb_1' });
  assert.equal(fallbackOk.isError, undefined);
  assert.equal(capturedOrderCollectionPinId, COLLECTION_PIN_ID);

  verifyCollectionPinId = undefined;
  const fallbackMissing = await fallbackBuy.handler({ item_pin_id: ITEM_PIN_ID, amount_me: 2, order_id: 'ord_fb_2' });
  assert.equal(fallbackMissing.isError, true);
  assert.match(fallbackMissing.content[0].text, /collectionPinId/);
});
