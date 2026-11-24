import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { buildWalletAgentTools } = require('../dist-electron/main/libs/walletAgentTools.js');
const { buildMrc721AgentTools } = require('../dist-electron/main/libs/mrc721AgentTools.js');
const { buildEscrowAgentTools } = require('../dist-electron/main/libs/escrowAgentTools.js');
const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { EscrowOrderStore } = require('../dist-electron/main/services/escrowOrderStore.js');
const {
  declareMrc721SellIntent,
} = require('../dist-electron/main/services/mrc721SellIntentService.js');
const {
  registerFtActiveOrder,
} = require('../dist-electron/main/services/ftOrderStore.js');
const {
  BUILTIN_OFFICIAL_ESCROW_GUARANTORS,
  OFFICIAL_IDBOTS_METAID,
} = require('../dist-electron/main/services/nftCaService.js');
const {
  verifyOfficialEscrowGuarantor,
} = require('../dist-electron/main/services/officialBotVerifyService.js');
const {
  verifyEscrowOnChainCustodyTx,
} = require('../dist-electron/main/services/walletTxStatusService.js');
const {
  pubkeyHashFromAddress,
} = require('../dist-electron/main/services/txTransferVerification.js');
const {
  verifyMrc20GoodsPayment,
} = require('../dist-electron/main/services/tokenForGoodsService.js');
const {
  SellerAutoFulfillDaemon,
} = require('../dist-electron/main/services/sellerAutoFulfillDaemon.js');

const GUARANTOR_1_GMID = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
const GUARANTOR_1_MVC = '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za';
const GUARANTOR_2_GMID = 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5';
const GUARANTOR_2_MVC = '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx';

const ADDR_SELLER = '1BNesCuvJeW2DAF42xkyCU1ifZVuNZ61mv';
const ADDR_BUYER = '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET';
const ADDR_EXTERNAL = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const CODEHASH_40 = 'e205939ad9956673ce7da9fbd40514b30f66dc35';
const GENESIS_40 = '005d69cba8c80e6978157e146f998c21288a9d49';
const TXID_64 = 'aa'.repeat(32);
const ITEM_PIN_ID = `${'11'.repeat(32)}i0`;
const MRC20_ID = `${'22'.repeat(32)}i0`;

function disposeStore(store, tempDir) {
  try {
    store?.close?.();
  } catch {
    // best-effort close
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows-CI tolerant cleanup
  }
}

function buildMinimalP2pkhTxHex(recipientAddress, sats = 1000) {
  const hash160 = pubkeyHashFromAddress(recipientAddress);
  assert.ok(hash160, `expected valid P2PKH address: ${recipientAddress}`);
  const script = Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    Buffer.from(hash160, 'hex'),
    Buffer.from([0x88, 0xac]),
  ]);
  const version = Buffer.alloc(4);
  version.writeUInt32LE(1, 0);
  const inCount = Buffer.from([0x01]);
  const prevTxid = Buffer.alloc(32, 0x11);
  const prevVout = Buffer.alloc(4);
  const scriptSigLen = Buffer.from([0x00]);
  const seq = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const outCount = Buffer.from([0x01]);
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(sats), 0);
  const scriptLen = Buffer.from([script.length]);
  const locktime = Buffer.alloc(4);
  return Buffer.concat([
    version,
    inCount,
    prevTxid,
    prevVout,
    scriptSigLen,
    seq,
    outCount,
    value,
    scriptLen,
    script,
    locktime,
  ]).toString('hex');
}

// ============================================================================
// #1: Host-level fail-closed owner confirmation gates for FT/NFT/MRC-721 tools
// ============================================================================

test('Batch3 #1: wallet_nft_* and wallet_token_* require owner confirmation and block on denial', async () => {
  let nftTransferCalls = 0;
  let nftSellCalls = 0;
  let nftBuyCalls = 0;
  let tokenTransferCalls = 0;
  let tokenSplitCalls = 0;
  let tokenSellCalls = 0;
  let tokenTakeCalls = 0;
  const prompted = [];

  const control = {
    getMetabotMvcAddress: (id) => (id === 1 ? ADDR_SELLER : id === 2 ? ADDR_BUYER : null),
    resolveMetabotIdByName: () => null,
    transferNft: async () => {
      nftTransferCalls += 1;
      return { txId: TXID_64 };
    },
    sellNft: async () => {
      nftSellCalls += 1;
      return { txId: TXID_64, fundingTxId: TXID_64 };
    },
    buyNft: async () => {
      nftBuyCalls += 1;
      return { txId: TXID_64, fundingTxId: TXID_64 };
    },
    transferToken: async () => {
      tokenTransferCalls += 1;
      return { txId: TXID_64, fundingTxIds: [] };
    },
    splitMvcFtForSell: async () => {
      tokenSplitCalls += 1;
      return { txId: TXID_64, outputIndex: 0, rawTx: '00', amountBase: '100' };
    },
    sellToken: async () => {
      tokenSellCalls += 1;
      return { txId: TXID_64, fundingTxIds: [], listing: null };
    },
    takeToken: async () => {
      tokenTakeCalls += 1;
      return { txId: TXID_64, fundingTxIds: [] };
    },
    listTokens: async () => ({
      list: [{ codeHash: CODEHASH_40, genesis: GENESIS_40, symbol: 'TEST', decimal: 0, confirmed: '1000', unconfirmed: '0' }],
    }),
  };

  let decision = false;
  const handlers = {};
  buildWalletAgentTools({
    tool: (name, _desc, _schema, handler) => {
      handlers[name] = handler;
      return { name };
    },
    control,
    sessionId: 'sess-b3-wallet',
    resolveMetabotId: () => 1,
    confirmAssetAction: async (info) => {
      prompted.push(info.toolName);
      return decision;
    },
  });

  // External NFT transfer denied -> 0 calls
  const rNftXferDeny = await handlers.wallet_nft_transfer({
    to: ADDR_EXTERNAL,
    genesis: GENESIS_40,
    codehash: CODEHASH_40,
    token_index: '7',
  });
  assert.equal(rNftXferDeny.isError, true);
  assert.equal(nftTransferCalls, 0);

  // Local-roster NFT transfer skips prompt (Channel A UX preserved)
  const rNftXferLocal = await handlers.wallet_nft_transfer({
    to: '2',
    genesis: GENESIS_40,
    codehash: CODEHASH_40,
    token_index: '7',
  });
  assert.notEqual(rNftXferLocal.isError, true);
  assert.equal(nftTransferCalls, 1);

  // NFT sell & buy denied -> 0 calls
  assert.equal((await handlers.wallet_nft_sell({ genesis: GENESIS_40, codehash: CODEHASH_40, token_index: '7', price_sats: 50000 })).isError, true);
  assert.equal((await handlers.wallet_nft_buy({ genesis: GENESIS_40, codehash: CODEHASH_40, token_index: '7', sell_price_sats: 50000 })).isError, true);
  assert.equal(nftSellCalls, 0);
  assert.equal(nftBuyCalls, 0);

  // External FT transfer denied -> 0 calls; local FT transfer skips prompt
  assert.equal((await handlers.wallet_token_transfer({ genesis: GENESIS_40, codehash: CODEHASH_40, receiver_address: ADDR_EXTERNAL })).isError, true);
  assert.equal(tokenTransferCalls, 0);
  assert.notEqual((await handlers.wallet_token_transfer({ genesis: GENESIS_40, codehash: CODEHASH_40, receiver_address: '2' })).isError, true);
  assert.equal(tokenTransferCalls, 1);

  // FT sell (even with partial amount requiring split) denied -> 0 split calls, 0 sell calls
  assert.equal((await handlers.wallet_token_sell({ genesis: GENESIS_40, codehash: CODEHASH_40, amount: '100', price_sats: 50000 })).isError, true);
  assert.equal(tokenSplitCalls, 0);
  assert.equal(tokenSellCalls, 0);

  // FT buy and alias wallet_token_take denied -> 0 calls
  const listingArgs = { sell_txid: TXID_64, sell_output_index: 0, sell_price_sats: 50000, seller_address: ADDR_EXTERNAL };
  assert.equal((await handlers.wallet_token_buy(listingArgs)).isError, true);
  assert.equal((await handlers.wallet_token_take(listingArgs)).isError, true);
  assert.equal(tokenTakeCalls, 0);

  assert.deepEqual(prompted, [
    'wallet_nft_transfer',
    'wallet_nft_sell',
    'wallet_nft_buy',
    'wallet_token_transfer',
    'wallet_token_sell',
    'wallet_token_buy',
    'wallet_token_buy',
  ]);

  // Approve path succeeds
  decision = true;
  assert.notEqual((await handlers.wallet_nft_sell({ genesis: GENESIS_40, codehash: CODEHASH_40, token_index: '7', price_sats: 50000 })).isError, true);
  assert.equal(nftSellCalls, 1);
  assert.notEqual((await handlers.wallet_token_buy(listingArgs)).isError, true);
  assert.equal(tokenTakeCalls, 1);
});

test('Batch3 #1: mrc721_transfer/sell/buy/offer/take_offer and autoFulfill sell_intent require owner confirmation', async () => {
  let transferCalls = 0;
  let sellCalls = 0;
  let buyCalls = 0;
  let offerCalls = 0;
  let takeOfferCalls = 0;
  let sellIntentCalls = 0;
  const prompted = [];

  const control = {
    getMetabotMvcAddress: (id) => (id === 1 ? ADDR_SELLER : id === 2 ? ADDR_BUYER : null),
    resolveMetabotIdByName: () => null,
    getItemInfo: async () => null,
    transfer: async () => {
      transferCalls += 1;
      return { txId: TXID_64, pinId: ITEM_PIN_ID, toAddress: ADDR_BUYER, spentOutpoint: `${TXID_64}:0`, outputValue: 546 };
    },
    sell: async () => {
      sellCalls += 1;
      return { itemPinId: ITEM_PIN_ID, buyerAddress: ADDR_EXTERNAL, priceSats: 50000, outpoint: `${TXID_64}:0`, listingJson: '{}' };
    },
    buy: async () => {
      buyCalls += 1;
      return { txId: TXID_64, itemPinId: ITEM_PIN_ID, sellerAddress: ADDR_EXTERNAL, priceSats: 50000, feeSats: 200, feeRateEffective: 1 };
    },
    offerPublish: async () => {
      offerCalls += 1;
      return { offerPinId: ITEM_PIN_ID, offer: { itemPinId: ITEM_PIN_ID, priceSats: 50000, offerTx: '00' } };
    },
    takeOffer: async () => {
      takeOfferCalls += 1;
      return { txId: TXID_64, feeSats: 200, offer: { itemPinId: ITEM_PIN_ID, priceSats: 50000, offerTx: '00' } };
    },
    sellIntentDeclare: async (input) => {
      sellIntentCalls += 1;
      return {
        sellPinId: ITEM_PIN_ID,
        intent: {
          active: true,
          itemPinId: input.itemPinId,
          sellerAddress: ADDR_SELLER,
          autoFulfillMe: input.autoFulfillMe === true,
          autoFulfillTokens: input.autoFulfillTokens === true,
          acceptedCurrencies: ['me'],
          settlement: ['me-escrow'],
          createdAt: 1700000000,
        },
      };
    },
  };

  let decision = false;
  const handlers = {};
  buildMrc721AgentTools({
    tool: (name, _desc, _schema, handler) => {
      handlers[name] = handler;
      return { name };
    },
    control,
    sessionId: 'sess-b3-mrc721',
    resolveMetabotId: () => 1,
    confirmAssetAction: async (info) => {
      prompted.push(info.toolName);
      return decision;
    },
  });

  // External mrc721_transfer denied -> 0 calls; local bot id skips prompt
  assert.equal((await handlers.mrc721_transfer({ pin_id: ITEM_PIN_ID, to: ADDR_EXTERNAL })).isError, true);
  assert.equal(transferCalls, 0);
  assert.notEqual((await handlers.mrc721_transfer({ pin_id: ITEM_PIN_ID, to: '2' })).isError, true);
  assert.equal(transferCalls, 1);

  // sell, buy, offer, take_offer all denied -> 0 calls
  assert.equal((await handlers.mrc721_sell({ item_pin_id: ITEM_PIN_ID, buyer_address: ADDR_EXTERNAL, price_sats: 50000 })).isError, true);
  assert.equal((await handlers.mrc721_buy({ listing: { itemPinId: ITEM_PIN_ID, sellerAddress: ADDR_EXTERNAL, priceSats: 50000 } })).isError, true);
  assert.equal((await handlers.mrc721_offer({ item_pin_id: ITEM_PIN_ID, price_sats: 50000 })).isError, true);
  assert.equal((await handlers.mrc721_take_offer({ offer_payload: JSON.stringify({ itemPinId: ITEM_PIN_ID, priceSats: 50000, offerTx: '00' }) })).isError, true);
  assert.equal(sellCalls + buyCalls + offerCalls + takeOfferCalls, 0);

  // mrc721_sell_intent with auto_fulfill_me=true requires confirmation (denied -> 0 calls)
  assert.equal((await handlers.mrc721_sell_intent({ item_pin_id: ITEM_PIN_ID, price_me: 10, auto_fulfill_me: true })).isError, true);
  assert.equal(sellIntentCalls, 0);

  // mrc721_sell_intent WITHOUT auto_fulfill_* proceeds without prompt (manual-fulfill default)
  const plainIntent = await handlers.mrc721_sell_intent({ item_pin_id: ITEM_PIN_ID, price_me: 10 });
  assert.notEqual(plainIntent.isError, true);
  assert.equal(sellIntentCalls, 1);
  assert.match(plainIntent.content[0].text, /autoFulfillMe: disabled/);

  assert.deepEqual(prompted, [
    'mrc721_transfer',
    'mrc721_sell',
    'mrc721_buy',
    'mrc721_offer',
    'mrc721_take_offer',
    'mrc721_sell_intent',
  ]);
});

test('Batch3 #1: CoworkRunner.confirmAssetAction is fail-closed (deny, ownerOnly: true)', async () => {
  const calls = [];
  const fakeRunner = {
    activeSessions: new Map(),
    requestSafetyApproval: async (sid, _sig, _sess, question, toolName, input, timeoutDefault, options) => {
      calls.push({ sid, question, toolName, input, timeoutDefault, options });
      return 'denied';
    },
  };

  // No activeSession -> fail-closed false
  const noSession = await CoworkRunner.prototype.confirmAssetAction.call(fakeRunner, 'missing-sess', {
    toolName: 'wallet_nft_sell',
    summaryZh: 'zh',
    summaryEn: 'en',
    details: { price_sats: 50000 },
  });
  assert.equal(noSession, false);
  assert.equal(calls.length, 0);

  // Active session -> passes timeoutDefault='deny' and ownerOnly=true
  fakeRunner.activeSessions.set('live-sess', { abortController: new AbortController() });
  const denied = await CoworkRunner.prototype.confirmAssetAction.call(fakeRunner, 'live-sess', {
    toolName: 'mrc721_offer',
    summaryZh: 'zh-offer',
    summaryEn: 'en-offer',
    details: { price_sats: 50000 },
  });
  assert.equal(denied, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'mrc721_offer');
  assert.equal(calls[0].timeoutDefault, 'deny');
  assert.deepEqual(calls[0].options, { ownerOnly: true });
});

// ============================================================================
// #2: autoFulfillMe and autoFulfillTokens default to false (explicit opt-in)
// ============================================================================

test('Batch3 #2: declareMrc721SellIntent and registerFtActiveOrder default autoFulfill to false', async () => {
  // 2a. declareMrc721SellIntent defaults
  const kvStore = new Map();
  const intents = {
    get: (k) => kvStore.get(k),
    set: (k, v) => kvStore.set(k, v),
  };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('/item/info') || s.includes('/mrc721/item') || s.includes('mrc721')) {
      return new Response(JSON.stringify({
        code: 1,
        data: {
          itemPinId: ITEM_PIN_ID,
          collectionName: 'test-col',
          collectionPinId: `${'33'.repeat(32)}i0`,
          ownerAddress: ADDR_SELLER,
          burned: false,
          output: `${TXID_64}:0`,
          outputValue: 546,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${s}`);
  };
  try {
    const defaultRes = await declareMrc721SellIntent(
      { createPin: async () => ({ txids: [TXID_64], pinId: ITEM_PIN_ID }) },
      {
        metabotId: 1,
        itemPinId: ITEM_PIN_ID,
        priceMe: 10,
        store: { getMetabotById: () => ({ id: 1, mvc_address: ADDR_SELLER, globalmetaid: 'idq1seller' }) },
        intents,
      },
    );
    assert.equal(defaultRes.intent.autoFulfillMe, false);
    assert.equal(kvStore.get('mrc721_sell_intents:1')[0].autoFulfillMe, false);
    assert.equal(kvStore.get('mrc721_sell_intents:1')[0].autoFulfillTokens, false);

    // Explicit opt-in still works
    const optInRes = await declareMrc721SellIntent(
      { createPin: async () => ({ txids: [TXID_64], pinId: ITEM_PIN_ID }) },
      {
        metabotId: 1,
        itemPinId: ITEM_PIN_ID,
        priceMe: 10,
        autoFulfillMe: true,
        autoFulfillTokens: true,
        store: { getMetabotById: () => ({ id: 1, mvc_address: ADDR_SELLER, globalmetaid: 'idq1seller' }) },
        intents,
      },
    );
    assert.equal(optInRes.intent.autoFulfillMe, true);
    assert.equal(optInRes.intent.autoFulfillTokens, true);
  } finally {
    globalThis.fetch = prevFetch;
  }

  // 2b. registerFtActiveOrder on me-escrow defaults autoFulfillMe to false
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-b3-ft-'));
  const sqliteStore = await SqliteStore.create(tempDir);
  try {
    const db = sqliteStore.getDatabase();
    const defaultOrder = registerFtActiveOrder(db, {
      listingKey: 'me-escrow:default-off',
      metabotId: 1,
      assetKey: `mvc-ft:${CODEHASH_40}:${GENESIS_40}`,
      chain: 'mvc',
      symbol: 'TEST',
      decimals: 8,
      codehash: CODEHASH_40,
      genesis: GENESIS_40,
      rail: 'me-escrow',
      amountBase: '100000000',
      amountDisplay: '1',
      utxoOutpoint: `${TXID_64}:0`,
      priceMeMilli: 5000,
    });
    assert.equal(defaultOrder.autoFulfillMe, false);

    const optInOrder = registerFtActiveOrder(db, {
      listingKey: 'me-escrow:opt-in',
      metabotId: 1,
      assetKey: `mvc-ft:${CODEHASH_40}:${GENESIS_40}`,
      chain: 'mvc',
      symbol: 'TEST',
      decimals: 8,
      codehash: CODEHASH_40,
      genesis: GENESIS_40,
      rail: 'me-escrow',
      amountBase: '100000000',
      amountDisplay: '1',
      utxoOutpoint: `${TXID_64}:1`,
      priceMeMilli: 5000,
      autoFulfillMe: true,
    });
    assert.equal(optInOrder.autoFulfillMe, true);

    // Contract C1.3 still blocks autoFulfillMe=true on mvc-tokensell
    assert.throws(() => registerFtActiveOrder(db, {
      listingKey: 'tokensell:conflict',
      metabotId: 1,
      assetKey: `mvc-ft:${CODEHASH_40}:${GENESIS_40}`,
      chain: 'mvc',
      symbol: 'TEST',
      decimals: 8,
      codehash: CODEHASH_40,
      genesis: GENESIS_40,
      rail: 'mvc-tokensell',
      amountBase: '100000000',
      amountDisplay: '1',
      utxoOutpoint: `${TXID_64}:2`,
      priceSats: 50000,
      autoFulfillMe: true,
    }), /UTXO_RAIL_CONFLICT/);
  } finally {
    disposeStore(sqliteStore, tempDir);
  }
});

test('Batch3 #2: SellerAutoFulfillDaemon requires explicit opt-in (undefined autoFulfill is disabled)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-b3-daemon-'));
  const sqliteStore = await SqliteStore.create(tempDir);
  try {
    const kv = new Map();
    kv.set('mrc721_sell_intents:1', [
      {
        id: 'intent_no_optin',
        metabotId: 1,
        sellPinId: ITEM_PIN_ID,
        status: 'active',
        updatedAt: Date.now(),
        intent: {
          active: true,
          itemPinId: ITEM_PIN_ID,
          sellerAddress: ADDR_SELLER,
          prices: {
            tokens: [
              {
                assetKey: `mrc20:${MRC20_ID}`,
                chain: 'btc',
                standard: 'mrc20',
                mrc20Id: MRC20_ID,
                symbol: 'METAID',
                decimals: 8,
                amountBase: '100000000',
                amountDisplay: '1',
                sellerReceiveAddress: 'bc1qseller000000000000000000000000000000000',
              },
            ],
          },
          acceptedCurrencies: [`ft:mrc20:${MRC20_ID}`],
          settlement: ['token-direct'],
          createdAt: Math.floor(Date.now() / 1000),
        },
      },
    ]);
    const daemon = new SellerAutoFulfillDaemon(sqliteStore.getDatabase(), () => {}, {
      getMetabotStore: () => ({
        getMetabotById: () => ({ id: 1, enabled: true, mvc_address: ADDR_SELLER, globalmetaid: 'idq1seller' }),
        getMetabotWalletByMetabotId: () => ({ mnemonic: 'abandon '.repeat(11) + 'about', path: "m/44'/10001'/0'/0/0" }),
        listMetabots: () => [],
      }),
      getSellIntentKv: () => ({ get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) }),
      fetchItemInfo: async () => ({ itemPinId: ITEM_PIN_ID, ownerAddress: ADDR_SELLER, burned: false }),
    });
    const res = await daemon.handleTokenGoodsReserve(1, 'idq1buyer', {
      itemPinId: ITEM_PIN_ID,
      assetKey: `mrc20:${MRC20_ID}`,
      buyerNftAddress: ADDR_BUYER,
    });
    assert.equal(res.outcome, 'rejected');
    assert.equal(res.reason, 'auto_fulfill_tokens_disabled_by_seller');
  } finally {
    disposeStore(sqliteStore, tempDir);
  }
});

// ============================================================================
// #3: Built-in CA trust root guarantors + Escrow CA & on-chain txid verification
// ============================================================================

test('Batch3 #3: built-in CA trust root includes both official guarantor bots and honors on-chain revocation', async () => {
  assert.equal(BUILTIN_OFFICIAL_ESCROW_GUARANTORS.length >= 2, true);
  const gmids = BUILTIN_OFFICIAL_ESCROW_GUARANTORS.map((g) => g.globalMetaId);
  assert.ok(gmids.includes(GUARANTOR_1_GMID));
  assert.ok(gmids.includes(GUARANTOR_2_GMID));

  const emptyVerifiedRegistry = {
    protocol: 'idbots-nft-ca',
    version: 1,
    verified: true,
    status: 'verified',
    pinId: ITEM_PIN_ID,
    creatorMetaId: OFFICIAL_IDBOTS_METAID,
    officialMetaId: OFFICIAL_IDBOTS_METAID,
    collections: [],
    officialBots: [],
    fetchedAt: Date.now(),
  };

  // Both built-in guarantors pass by globalMetaId AND by custodyAddress even when on-chain pin is empty
  const v1 = await verifyOfficialEscrowGuarantor(
    { guarantorGlobalMetaId: GUARANTOR_1_GMID, custodyAddress: GUARANTOR_1_MVC },
    { getRegistry: async () => emptyVerifiedRegistry },
  );
  assert.equal(v1.verified, true);

  const v2ByAddrOnly = await verifyOfficialEscrowGuarantor(
    { custodyAddress: GUARANTOR_2_MVC },
    { getRegistry: async () => ({ ...emptyVerifiedRegistry, verified: false, status: 'unavailable' }) },
  );
  assert.equal(v2ByAddrOnly.verified, true);
  assert.equal(v2ByAddrOnly.guarantorEntry.globalMetaId, GUARANTOR_2_GMID);

  // Mismatched custodyAddress for official guarantor -> rejected
  const badAddr = await verifyOfficialEscrowGuarantor(
    { guarantorGlobalMetaId: GUARANTOR_1_GMID, custodyAddress: ADDR_EXTERNAL },
    { getRegistry: async () => emptyVerifiedRegistry },
  );
  assert.equal(badAddr.verified, false);

  // Random unknown guarantor -> rejected fail-closed
  const unknown = await verifyOfficialEscrowGuarantor(
    { custodyAddress: ADDR_EXTERNAL },
    { getRegistry: async () => emptyVerifiedRegistry },
  );
  assert.equal(unknown.verified, false);

  // On-chain revocation (`active: false`) overrides built-in trust root!
  const revokedRegistry = {
    ...emptyVerifiedRegistry,
    officialBots: [
      {
        globalMetaId: GUARANTOR_1_GMID,
        mvcAddress: GUARANTOR_1_MVC,
        role: 'escrow_guarantor',
        badgeType: 'official_escrow_guarantor',
        badgeLabel: 'Official Escrow Guarantor',
        escrowConfig: { custodyAddress: GUARANTOR_1_MVC },
        active: false,
      },
    ],
  };
  const revoked = await verifyOfficialEscrowGuarantor(
    { guarantorGlobalMetaId: GUARANTOR_1_GMID, custodyAddress: GUARANTOR_1_MVC },
    { getRegistry: async () => revokedRegistry },
  );
  assert.equal(revoked.verified, false);
  assert.match(revoked.reason, /revoked/i);
});

test('Batch3 #3: verifyEscrowOnChainCustodyTx verifies raw MVC tx existence and recipient output', async () => {
  const validHex = buildMinimalP2pkhTxHex(GUARANTOR_1_MVC, 1000);
  const wrongRecipientHex = buildMinimalP2pkhTxHex(ADDR_EXTERNAL, 1000);

  const ok = await verifyEscrowOnChainCustodyTx(
    { action: 'escrow_goods', goodsKind: 'mrc721', txid: TXID_64, expectedRecipientAddress: GUARANTOR_1_MVC, itemPinId: ITEM_PIN_ID },
    { fetchMvcRawTxHex: async () => validHex, fetchMvcUtxoList: async () => [] },
  );
  assert.equal(ok.verified, true);

  const wrongRecipient = await verifyEscrowOnChainCustodyTx(
    { action: 'escrow_goods', goodsKind: 'mrc721', txid: TXID_64, expectedRecipientAddress: GUARANTOR_1_MVC, itemPinId: ITEM_PIN_ID },
    { fetchMvcRawTxHex: async () => wrongRecipientHex, fetchMvcUtxoList: async () => [] },
  );
  assert.equal(wrongRecipient.verified, false);
  assert.match(wrongRecipient.reason, /no output transferring assets/i);

  const notFound = await verifyEscrowOnChainCustodyTx(
    { action: 'escrow_goods', goodsKind: 'mrc721', txid: TXID_64, expectedRecipientAddress: GUARANTOR_1_MVC },
    { fetchMvcRawTxHex: async () => { throw new Error('tx not found'); }, fetchMvcUtxoList: async () => [] },
  );
  assert.equal(notFound.verified, false);
  assert.match(notFound.reason, /not found/i);
});

test('Batch3 #3: escrow_order_create and escrow_order_act enforce CA guarantor and on-chain txid checks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-b3-escrow-'));
  const sqliteStore = await SqliteStore.create(tempDir);
  try {
    const orders = new EscrowOrderStore(sqliteStore.getDatabase(), () => {});
    const emptyVerifiedRegistry = {
      protocol: 'idbots-nft-ca',
      version: 1,
      verified: true,
      status: 'verified',
      pinId: ITEM_PIN_ID,
      creatorMetaId: OFFICIAL_IDBOTS_METAID,
      officialMetaId: OFFICIAL_IDBOTS_METAID,
      collections: [],
      officialBots: [],
      fetchedAt: Date.now(),
    };
    let mockRawTxHex = null;

    const control = {
      resolveMetabotIdByName: (name) => (name === 'seller' ? 1 : name === 'buyer' ? 2 : null),
      getMetabotMvcAddress: (id) => (id === 1 ? ADDR_SELLER : id === 2 ? ADDR_BUYER : null),
      getMetabotDisplayName: (id) => (id === 1 ? 'seller' : id === 2 ? 'buyer' : null),
      verifyEscrowGuarantor: (input) => verifyOfficialEscrowGuarantor(input, { getRegistry: async () => emptyVerifiedRegistry }),
      verifyOnChainCustodyTx: (input) => verifyEscrowOnChainCustodyTx(input, {
        fetchMvcRawTxHex: async () => {
          if (!mockRawTxHex) throw new Error('tx not found');
          return mockRawTxHex;
        },
        fetchMvcUtxoList: async () => [],
      }),
    };

    const handlers = {};
    buildEscrowAgentTools({
      tool: (name, _desc, _schema, handler) => {
        handlers[name] = handler;
        return { name };
      },
      control,
      orders,
      sessionId: 'sess-b3-escrow',
      resolveMetabotId: () => 1,
    });

    // Uncertified guarantor -> refused
    const badCreate = await handlers.escrow_order_create({
      kind: 'mrc721',
      amount_cents: 1000,
      seller: '1',
      buyer: '2',
      agent: ADDR_EXTERNAL,
      item_pin_id: ITEM_PIN_ID,
    });
    assert.equal(badCreate.isError, true);
    assert.match(badCreate.content[0].text, /not an official CA-certified escrow guarantor/i);

    // Official built-in guarantor passed as GlobalMetaID -> accepted!
    const okCreate = await handlers.escrow_order_create({
      kind: 'mrc721',
      amount_cents: 1000,
      seller: '1',
      buyer: '2',
      agent: GUARANTOR_1_GMID,
      item_pin_id: ITEM_PIN_ID,
    });
    assert.notEqual(okCreate.isError, true);
    const orderIdMatch = /Escrow order (esc-[a-z0-9-]+)/.exec(okCreate.content[0].text);
    assert.ok(orderIdMatch, 'expected created orderId');
    const orderId = orderIdMatch[1];

    // Fabricated 64-hex txid not on-chain -> refused, state stays CREATED
    mockRawTxHex = null;
    const fakeTxAct = await handlers.escrow_order_act({
      order_id: orderId,
      action: 'escrow_goods',
      proof: TXID_64,
    });
    assert.equal(fakeTxAct.isError, true);
    assert.match(fakeTxAct.content[0].text, /on-chain custody tx verification failed/i);
    assert.equal(orders.get(orderId).payload.state, 'CREATED');

    // On-chain tx paying wrong address -> refused, state stays CREATED
    mockRawTxHex = buildMinimalP2pkhTxHex(ADDR_EXTERNAL, 1000);
    const wrongRecipientAct = await handlers.escrow_order_act({
      order_id: orderId,
      action: 'escrow_goods',
      proof: TXID_64,
    });
    assert.equal(wrongRecipientAct.isError, true);
    assert.equal(orders.get(orderId).payload.state, 'CREATED');

    // Real on-chain tx paying GUARANTOR_1_MVC -> succeeds, state -> ITEM_ESCROWED
    mockRawTxHex = buildMinimalP2pkhTxHex(GUARANTOR_1_MVC, 1000);
    const validAct = await handlers.escrow_order_act({
      order_id: orderId,
      action: 'escrow_goods',
      proof: TXID_64,
    });
    assert.notEqual(validAct.isError, true);
    assert.equal(orders.get(orderId).payload.state, 'ITEM_ESCROWED');
  } finally {
    disposeStore(sqliteStore, tempDir);
  }
});

// ============================================================================
// #4: BTC MRC-20 >= 1 confirmation anti-RBF double-spend check
// ============================================================================

test('Batch3 #4: verifyMrc20GoodsPayment enforces >= 1 BTC confirmation and rejects 0-conf / TransferPendingIn', async () => {
  const sellerBtc = 'bc1qseller000000000000000000000000000000000';
  const baseInput = {
    paymentTxId: TXID_64,
    sellerReceiveAddress: sellerBtc,
    expectedMrc20Id: MRC20_ID,
    expectedDecimals: 8,
    expectedAmountBase: '20000000000',
  };

  // 4a. Unconfirmed TransferPendingIn UTXO -> rejected
  const pendingUtxoRes = await verifyMrc20GoodsPayment(baseInput, {
    fetchUtxos: async () => [
      { txId: TXID_64, address: sellerBtc, status: 'TransferPendingIn', mrc20Id: MRC20_ID, decimals: 8, amount: '200' },
    ],
    fetchBtcTxStatus: async () => ({ found: true, confirmed: true, confirmations: 1 }),
  });
  assert.equal(pendingUtxoRes.valid, false);
  assert.match(pendingUtxoRes.reason, /^btc_payment_unconfirmed:/);

  // 4b. Available UTXO but BTC mempool tx still 0-conf -> rejected
  const zeroConfBtcRes = await verifyMrc20GoodsPayment(baseInput, {
    fetchUtxos: async () => [
      { txId: TXID_64, address: sellerBtc, status: 'Available', mrc20Id: MRC20_ID, decimals: 8, amount: '200' },
    ],
    fetchBtcTxStatus: async () => ({ found: true, confirmed: false, confirmations: 0 }),
  });
  assert.equal(zeroConfBtcRes.valid, false);
  assert.equal(zeroConfBtcRes.reason, 'btc_payment_unconfirmed:0:1');

  // 4c. BTC tx status lookup error -> fail-closed
  const fetchErrRes = await verifyMrc20GoodsPayment(baseInput, {
    fetchUtxos: async () => [
      { txId: TXID_64, address: sellerBtc, status: 'Available', mrc20Id: MRC20_ID, decimals: 8, amount: '200' },
    ],
    fetchBtcTxStatus: async () => { throw new Error('mempool unreachable'); },
  });
  assert.equal(fetchErrRes.valid, false);
  assert.match(fetchErrRes.reason, /^btc_tx_status_fetch_failed:/);

  // 4d. Confirmed UTXO + >=1 BTC block confirmation -> accepted!
  const confirmedRes = await verifyMrc20GoodsPayment(baseInput, {
    fetchUtxos: async () => [
      { txId: TXID_64, address: sellerBtc, status: 'Available', mrc20Id: MRC20_ID, decimals: 8, amount: '200' },
    ],
    fetchBtcTxStatus: async () => ({ found: true, confirmed: true, confirmations: 2 }),
  });
  assert.equal(confirmedRes.valid, true);
  assert.equal(confirmedRes.confirmations, 2);
});
