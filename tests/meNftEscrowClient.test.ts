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
const DELIVERY_TXID = '9a'.repeat(32);
const BUYER_METAID = 'idq1buyer000000000000000000000000000000000';
const SELLER_METAID = 'idq1seller00000000000000000000000000000000';
const ITEM_PIN_ID = `${'aa'.repeat(32)}i0`;

const mockSignAction = async (action: string, identity: { mvcAddress: string }) => ({
  address: identity.mvcAddress,
  timestampMs: '1700000000123',
  signature: `sig_${action}_${identity.mvcAddress}`,
});

test('meNftEscrowService sends X-Bot-Address auth headers and strictly omits X-Identity-Address', async () => {
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
      return new Response(JSON.stringify({
        code: 0,
        data: {
          identityAddress: BOT_ADDRESS,
          tradeSpendableMilli: 12000,
          spendableMilli: 50000,
          frozenMilli: 1000,
          totalAvailable: 51000,
          weeklyGrant: { remainingMilli: 38000 },
          persistent: { earnedMilli: 7000, topupMilli: 5000, bonusMilli: 0 },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      code: 0,
      data: {
        orderId: 'ord_1',
        itemPinId: ITEM_PIN_ID,
        buyerAddress: BOT_ADDRESS,
        sellerAddress: SELLER_ADDRESS,
        amountMilli: 5000,
        status: 'locked',
      },
    }), { status: 200 });
  }) as typeof fetch;

  const signer = { mnemonic: BOT_MNEMONIC };
  const bal = await getBotTradeSpendableBalance(signer, {
    baseUrl: 'https://abs.example.test',
    fetchImpl,
    signAction: mockSignAction,
  });
  assert.equal(bal.tradeSpendableMilli, 12000);
  assert.equal(bal.weeklyRemainingMilli, 38000);

  const created = await createNftEscrowOrder(
    signer,
    {
      orderId: 'ord_1',
      itemPinId: ITEM_PIN_ID,
      sellerAddress: SELLER_ADDRESS,
      amountMilli: 5000,
      note: 'test order',
    },
    { baseUrl: 'https://abs.example.test', fetchImpl, signAction: mockSignAction },
  );
  assert.equal(created.status, 'locked');

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
  assert.equal(body.amountMilli, 5000);
});

test('meNftEscrowService supports get, list, deliver, reject and surfaces MeNftEscrowApiError', async () => {
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
    if (url.includes('/v1/me/nft-escrow/orders?role=seller&status=locked')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          orders: [{
            orderId: 'ord_locked_1',
            itemPinId: ITEM_PIN_ID,
            buyerAddress: BOT_ADDRESS,
            sellerAddress: SELLER_ADDRESS,
            amountMilli: 3000,
            status: 'locked',
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
            buyerAddress: BOT_ADDRESS,
            sellerAddress: SELLER_ADDRESS,
            amountMilli: 3000,
            status: 'settled',
            deliveryTxId: DELIVERY_TXID,
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
            buyerAddress: BOT_ADDRESS,
            sellerAddress: SELLER_ADDRESS,
            amountMilli: 3000,
            status: 'rejected',
            rejectReason: 'seller_no_longer_holds',
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

  const list = await listNftEscrowOrders(signer, { role: 'seller', status: 'locked' }, opts);
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].orderId, 'ord_locked_1');

  const delivered = await deliverNftEscrowOrder(signer, 'ord_locked_1', { deliveryTxId: DELIVERY_TXID }, opts);
  assert.equal(delivered.status, 'settled');
  assert.equal(delivered.deliveryTxId, DELIVERY_TXID);

  const rejected = await rejectNftEscrowOrder(signer, 'ord_locked_1', { reason: 'seller_no_longer_holds' }, opts);
  assert.equal(rejected.status, 'rejected');
});

test('goods_buy_with_me enforces tradeSpendableMilli, owner confirmation gate, escrow lock, DM dispatch, and settlement callback', async () => {
  const makeSdkTool = (name: string, description: string, schema: unknown, handler: (args: any) => Promise<any>) => ({
    name,
    description,
    schema,
    handler,
  });

  const sentMessages: Array<{ toGlobalMetaId: string; content: string }> = [];
  const settledEvents: any[] = [];
  const markedQuotes: any[] = [];
  let tradeSpendableMilli = 1000;
  let confirmResponse = true;
  let pollCount = 0;

  const tools = buildGoodsTradeAgentTools({
    tool: makeSdkTool as any,
    sessionId: 'sess-buyer-1',
    resolveMetabotId: () => 2,
    confirmGoodsPurchase: async () => confirmResponse,
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
        buyerAddress: BOT_ADDRESS,
        sellerAddress: input.sellerAddress,
        amountMilli: input.amountMilli,
        status: 'locked',
        raw: {},
      }),
      getEscrowOrder: async (input: any) => {
        pollCount += 1;
        return {
          orderId: input.orderId,
          itemPinId: ITEM_PIN_ID,
          buyerAddress: BOT_ADDRESS,
          sellerAddress: SELLER_ADDRESS,
          amountMilli: 5000,
          status: pollCount >= 1 ? 'settled' : 'locked',
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
      onPurchaseSettled: (ev: any) => settledEvents.push(ev),
      fetchItemInfo: async () => ({
        itemPinId: ITEM_PIN_ID,
        name: 'VIP Pass',
        collectionName: 'passes',
        ownerAddress: SELLER_ADDRESS,
        ownerMetaId: SELLER_METAID,
        burned: false,
      }),
      fetchMarketListings: async () => ({
        items: [{
          intentPinId: `${'cc'.repeat(32)}i0`,
          itemPinId: ITEM_PIN_ID,
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
  assert.equal(markedQuotes.length, 1);
  assert.equal(settledEvents.length, 1);
  assert.equal(settledEvents[0].deliveryTxId, 'tx_settled_123');

  // 4. Inquiry tool sends GOODS_INQUIRY_V1
  const inq = await inquiryTool.handler({ item_pin_id: ITEM_PIN_ID, offer_me: 4.5, note: 'Can you do 4.5 ME?' });
  assert.equal(inq.isError, undefined);
  assert.match(sentMessages[1].content, /GOODS_INQUIRY_V1/);
  assert.match(sentMessages[1].content, /"offerAmountMilli":\s*4500/);
});
