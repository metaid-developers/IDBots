import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mvc } from 'meta-contract';

import NftCard from '../src/renderer/components/chat/NftCard';
import {
  parseNftCardFence,
  serializeNftCardFence,
} from '../src/renderer/components/chat/nftCardSyntax';
import GoodsPurchaseConfirmModal from '../src/renderer/components/commerce/GoodsPurchaseConfirmModal';
import {
  SanitizeFailure,
  sanitizeAskTwinToBuy,
} from '../src/renderer/components/commerce/commerceBridgeContract';
import { resolveCommerceIntentAction } from '../src/renderer/components/commerce/commerceTradeEvents';

const require = Module.createRequire(import.meta.url);
const { TxComposer } = require('meta-contract/dist/tx-composer');
const { TokenFactory } = require('meta-contract/dist/mcp02/contract-factory/token');
const { TokenGenesisFactory } = require('meta-contract/dist/mcp02/contract-factory/tokenGenesis');
const { ContractUtil } = require('meta-contract/dist/mcp02/contractUtil');

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  SellerAutoFulfillDaemon,
  ensureMeNftSellerFulfillmentsSchema,
} = require('../dist-electron/main/services/sellerAutoFulfillDaemon.js');
const {
  formatGoodsTradeWireMessage,
  parseGoodsTradeWireMessage,
} = require('../dist-electron/main/services/goodsTradeWireProtocol.js');
const {
  baseUnitsToDecimalDisplay,
  decimalDisplayToBaseUnits,
  hydrateMarketListingTokens,
  parseCanonicalFtAssetKey,
  parseMrc721SellIntent,
} = require('../dist-electron/main/services/mrc721SellIntentService.js');
const {
  buildMvcFtGoodsAtomicProposal,
  createTokenGoodsReservation,
  ensureTokenForGoodsSchema,
  TokenGoodsWaiterRegistry,
  verifyAndSignMvcFtGoodsAtomicProposal,
  verifyMrc20GoodsPayment,
} = require('../dist-electron/main/services/tokenForGoodsService.js');
const { buildGoodsTradeAgentTools } = require('../dist-electron/main/libs/goodsTradeAgentTools.js');
const {
  BN_SHIM,
  getTokenCodeHashHex,
  getTokenIdHex,
  p2pkhScript,
} = require('../dist-electron/main/libs/mvcTokenSellAssembly.js');
const { getMvcWalletFromPath } = require('../dist-electron/main/services/metabotWalletService.js');

const SELLER_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BUYER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

const SELLER_BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const SELLER_METAID = 'idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47';
const BUYER_METAID = 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5';

const ITEM_PIN_1 = `${'aa'.repeat(32)}i0`;
const ITEM_PIN_2 = `${'bb'.repeat(32)}i0`;
const COLLECTION_PIN = `${'cc'.repeat(32)}i0`;
const SELL_PIN_1 = `${'dd'.repeat(32)}i0`;

const REAL_MRC20_ID = `${'4f'.repeat(32)}i0`;
const REAL_MRC20_KEY = `mrc20:${REAL_MRC20_ID}`;
const FAKE_MRC20_ID = `${'9e'.repeat(32)}i0`;
const FAKE_MRC20_KEY = `mrc20:${FAKE_MRC20_ID}`;

async function withDaemonDb(
  fn: (ctx: { sqliteStore: any; db: any; saveDb: () => void }) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-token-goods-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    ensureMeNftSellerFulfillmentsSchema(db);
    ensureTokenForGoodsSchema(db);
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
    get<T>(k: string) {
      return map.get(k) as T | undefined;
    },
    set<T>(k: string, v: T) {
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

// ---------------------------------------------------------------------------
// 1. REQ-4-01: v2.2 sell intent, exact BigInt decimal math & legacy hydration
// ---------------------------------------------------------------------------

test('REQ-4-01: mrc721sell v2.2 parses prices.tokens with exact BigInt conversion and hydrates legacy indexer rows', async () => {
  const sellerMvcWallet = await getMvcWalletFromPath(SELLER_MNEMONIC, DEFAULT_PATH);
  const sellerMvcAddr = sellerMvcWallet.getAddress();

  assert.equal(decimalDisplayToBaseUnits('200', 8), '20000000000');
  assert.equal(decimalDisplayToBaseUnits('123.45678901', 8), '12345678901');
  assert.equal(baseUnitsToDecimalDisplay('12345678901', 8), '123.45678901');
  assert.equal(baseUnitsToDecimalDisplay('20000000000', 8), '200');

  const mvcCodehash = 'a2421f1e90c6048c36745edd44fad682e8644693';
  const mvcGenesis = '005d112233445566778899aabbccddeeff001149';
  const mvcFtKey = `mvc-ft:${mvcCodehash}:${mvcGenesis}`;

  const parsed = parseMrc721SellIntent({
    itemPinId: ITEM_PIN_1,
    sellerAddress: sellerMvcAddr,
    sellerMetaId: SELLER_METAID,
    collectionPinId: COLLECTION_PIN,
    collectionName: 'course-cards',
    prices: {
      me: { amountMilli: 15000 },
      tokens: [
        {
          assetKey: REAL_MRC20_KEY,
          symbol: 'METAID',
          decimals: 8,
          amountDisplay: '200',
          sellerReceiveAddress: SELLER_BTC,
        },
        {
          assetKey: mvcFtKey,
          symbol: 'SHOW',
          decimals: 8,
          amountDisplay: '500.25',
          sellerReceiveAddress: sellerMvcAddr,
        },
      ],
    },
    autoFulfillTokens: true,
  });

  assert.equal(parsed.prices?.tokens?.length, 2);
  assert.equal(parsed.prices?.tokens?.[0].amountBase, '20000000000');
  assert.equal(parsed.prices?.tokens?.[1].amountBase, '50025000000');
  assert.equal(parsed.autoFulfillTokens, true);
  assert.ok(parsed.acceptedCurrencies.includes(`ft:${REAL_MRC20_KEY}`));
  assert.ok(parsed.acceptedCurrencies.includes(`ft:${mvcFtKey}`));
  assert.ok(parsed.settlement.includes('atomic-swap'));
  assert.ok(parsed.settlement.includes('token-direct'));

  // Backward compatibility: v2.1 payload without tokens still parses identically
  const v21 = parseMrc721SellIntent({
    itemPinId: ITEM_PIN_1,
    sellerAddress: sellerMvcAddr,
    prices: { me: { amountMilli: 5000 } },
  });
  assert.equal(v21.prices?.tokens, undefined);

  // Legacy indexer fallback: listing omits prices.tokens, acceptedCurrencies hints ft: -> hydrates from raw pin
  const legacyListing = {
    intentPinId: SELL_PIN_1,
    itemPinId: ITEM_PIN_1,
    acceptedCurrencies: [`ft:${REAL_MRC20_KEY}`],
    settlement: ['token-direct'],
    seller: { address: sellerMvcAddr, globalMetaId: SELLER_METAID },
  };
  const hydrated = await hydrateMarketListingTokens(legacyListing as any, async () => ({
    pinId: SELL_PIN_1,
    content: JSON.stringify(parsed),
  }) as any);
  assert.equal(hydrated.prices?.tokens?.length, 2);
  assert.equal(hydrated.prices?.tokens?.[0].assetKey, REAL_MRC20_KEY);
  assert.equal(hydrated.prices?.tokens?.[0].amountBase, '20000000000');
});

// ---------------------------------------------------------------------------
// 2. S-01 (Anti-Ticker-Spoofing) & S-02 (Fallback Fraud) on MRC-20 Verify
// ---------------------------------------------------------------------------

test('S-01 & S-02: rejects fake same-ticker mrc20Id and sendAllAmountToFirstOutput fallback fraud without transferring NFT', async () => {
  const sellerMvcWallet = await getMvcWalletFromPath(SELLER_MNEMONIC, DEFAULT_PATH);
  const sellerMvcAddr = sellerMvcWallet.getAddress();
  const buyerMvcWallet = await getMvcWalletFromPath(BUYER_MNEMONIC, DEFAULT_PATH);
  const buyerMvcAddr = buyerMvcWallet.getAddress();

  const paymentTxId = '77'.repeat(32);

  // S-01: Attacker sends token with identical ticker "METAID" but FAKE mrc20Id
  const s01Result = await verifyMrc20GoodsPayment(
    {
      paymentTxId,
      sellerReceiveAddress: SELLER_BTC,
      expectedMrc20Id: REAL_MRC20_ID,
      expectedDecimals: 8,
      expectedAmountBase: '20000000000',
    },
    {
      fetchUtxos: async () => [
        {
          txId: paymentTxId,
          address: SELLER_BTC,
          status: 'Available',
          mrc20Id: FAKE_MRC20_ID,
          tick: 'METAID',
          decimals: 8,
          amount: '200',
          mrc20s: [
            {
              mrc20Id: FAKE_MRC20_ID,
              tick: 'METAID',
              decimals: 8,
              amount: '200',
              status: 'Available',
              address: SELLER_BTC,
            },
          ],
        },
      ],
    },
  );
  assert.equal(s01Result.valid, false);
  assert.equal(s01Result.reason, 'no_valid_mrc20_credit_for_seller');

  // S-02: Attacker triggers sendAllAmountToFirstOutput fallback -> seller has Invalid/TransferPendingOut or 0 UTXOs
  const s02Result = await verifyMrc20GoodsPayment(
    {
      paymentTxId,
      sellerReceiveAddress: SELLER_BTC,
      expectedMrc20Id: REAL_MRC20_ID,
      expectedDecimals: 8,
      expectedAmountBase: '20000000000',
    },
    {
      fetchUtxos: async () => [
        {
          txId: paymentTxId,
          address: SELLER_BTC,
          status: 'Invalid',
          mrc20Id: REAL_MRC20_ID,
          tick: 'METAID',
          decimals: 8,
          amount: '200',
        },
      ],
    },
  );
  assert.equal(s02Result.valid, false);
  assert.equal(s02Result.reason, 'no_valid_mrc20_credit_for_seller');

  // Daemon-level S-02 test: SellerAutoFulfillDaemon MUST reject & MUST NOT call transferMrc721Item
  await withDaemonDb(async ({ db, saveDb }) => {
    const kv = makeKv();
    let transferCalls = 0;
    const sentDms: string[] = [];

    kv.set(`mrc721_sell_intents:1`, [
      {
        id: 'intent_1',
        metabotId: 1,
        sellPinId: SELL_PIN_1,
        status: 'active',
        autoFulfillTokens: true,
        updatedAt: 1_700_000_000_000,
        intent: {
          active: true,
          itemPinId: ITEM_PIN_1,
          sellerAddress: sellerMvcAddr,
          sellerMetaId: SELLER_METAID,
          autoFulfillTokens: true,
          prices: {
            tokens: [
              {
                assetKey: REAL_MRC20_KEY,
                chain: 'btc',
                standard: 'mrc20',
                mrc20Id: REAL_MRC20_ID,
                symbol: 'METAID',
                decimals: 8,
                amountBase: '20000000000',
                amountDisplay: '200',
                sellerReceiveAddress: SELLER_BTC,
              },
            ],
          },
          acceptedCurrencies: [`ft:${REAL_MRC20_KEY}`],
          settlement: ['token-direct'],
          createdAt: 1_700_000_000,
        },
      },
    ]);

    const daemon = new SellerAutoFulfillDaemon(db, saveDb, {
      getMetabotStore: () => ({
        getMetabotById: (id: number) => (id === 1 ? { id: 1, enabled: true, mvc_address: sellerMvcAddr, btc_address: SELLER_BTC, globalmetaid: SELLER_METAID } : null),
        getMetabotWalletByMetabotId: () => ({ mnemonic: SELLER_MNEMONIC, path: DEFAULT_PATH }),
        listMetabots: () => [],
      }) as any,
      getSellIntentKv: () => kv,
      fetchItemInfo: async () => ({
        itemPinId: ITEM_PIN_1,
        ownerAddress: sellerMvcAddr,
        burned: false,
        output: `${'12'.repeat(32)}:0`,
        outputValue: 546,
      }) as any,
      transferMrc721Item: async () => {
        transferCalls += 1;
        return { txId: 'should_never_happen', pinId: ITEM_PIN_1, toAddress: buyerMvcAddr };
      },
      sendTradeMessage: async ({ content }) => {
        sentDms.push(content);
        return { txids: ['dm1'], pinId: `${'dm'.repeat(32)}i0` };
      },
      fetchMrc20Utxos: async () => [],
      now: () => 1_700_000_010_000,
    });

    const reserveRes = await daemon.handleTokenGoodsReserve(1, BUYER_METAID, {
      reserveRequestId: 'req_s02',
      itemPinId: ITEM_PIN_1,
      assetKey: REAL_MRC20_KEY,
      buyerNftAddress: buyerMvcAddr,
    });
    assert.equal(reserveRes.outcome, 'reserved');

    const paidRes = await daemon.handleTokenGoodsPaid(1, BUYER_METAID, {
      reservationId: reserveRes.reservationId!,
      itemPinId: ITEM_PIN_1,
      assetKey: REAL_MRC20_KEY,
      paymentTxId,
      buyerNftAddress: buyerMvcAddr,
    });
    assert.equal(paidRes.outcome, 'rejected');
    assert.equal(paidRes.reason, 'no_valid_mrc20_credit_for_seller');
    assert.equal(transferCalls, 0);
    const parsedReject = parseGoodsTradeWireMessage(sentDms[sentDms.length - 1]);
    assert.equal(parsedReject?.type, 'TOKEN_GOODS_DELIVERY_REJECTED_V1');
  });
});

// ---------------------------------------------------------------------------
// 3. 5-Minute Exclusive Lock & ME Escrow Mutual Exclusion (Anti-Double-Sell)
// ---------------------------------------------------------------------------

test('5-minute exclusive reservation prevents two buyers buying the same item and blocks ME escrow collision', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    const t0 = 1_700_000_000_000;
    const sellerMvcWallet = await getMvcWalletFromPath(SELLER_MNEMONIC, DEFAULT_PATH);
    const sellerMvcAddr = sellerMvcWallet.getAddress();
    const buyer1Addr = (await getMvcWalletFromPath(BUYER_MNEMONIC, DEFAULT_PATH)).getAddress();
    const buyer2Addr = new mvc.PrivateKey().toAddress('livenet').toString();

    const r1 = createTokenGoodsReservation(db, saveDb, {
      sellerMetabotId: 1,
      itemPinId: ITEM_PIN_1,
      assetKey: REAL_MRC20_KEY,
      buyerNftAddress: buyer1Addr,
      sellerReceiveAddress: SELLER_BTC,
      amountBase: '20000000000',
      nowMs: t0,
    });
    assert.equal(r1.ok, true);

    // Buyer 2 within 5 minutes -> MUST be rejected!
    const r2 = createTokenGoodsReservation(db, saveDb, {
      sellerMetabotId: 1,
      itemPinId: ITEM_PIN_1,
      assetKey: REAL_MRC20_KEY,
      buyerNftAddress: buyer2Addr,
      sellerReceiveAddress: SELLER_BTC,
      amountBase: '20000000000',
      nowMs: t0 + 60_000,
    });
    assert.equal(r2.ok, false);

    // Concurrent ME escrow order on the SAME item while token reservation active -> MUST reject!
    const kv = makeKv();
    kv.set(`mrc721_sell_intents:1`, [
      {
        id: 'intent_me_tok',
        metabotId: 1,
        sellPinId: SELL_PIN_1,
        status: 'active',
        autoFulfillMe: true,
        autoFulfillTokens: true,
        updatedAt: t0,
        intent: {
          active: true,
          itemPinId: ITEM_PIN_1,
          sellerAddress: sellerMvcAddr,
          sellerMetaId: SELLER_METAID,
          autoFulfillMe: true,
          autoFulfillTokens: true,
          prices: { me: { amountMilli: 15000 } },
          acceptedCurrencies: ['me', `ft:${REAL_MRC20_KEY}`],
          settlement: ['me-escrow', 'token-direct'],
          createdAt: Math.floor(t0 / 1000),
        },
      },
    ]);
    let meRejectedReason = '';
    const daemon = new SellerAutoFulfillDaemon(db, saveDb, {
      getMetabotStore: () => ({
        getMetabotById: (id: number) => (id === 1 ? { id: 1, enabled: true, mvc_address: sellerMvcAddr, globalmetaid: SELLER_METAID } : null),
        getMetabotWalletByMetabotId: () => ({ mnemonic: SELLER_MNEMONIC, path: DEFAULT_PATH }),
        listMetabots: () => [],
      }) as any,
      getSellIntentKv: () => kv,
      transferMrc721Item: async () => ({ txId: 'never', pinId: ITEM_PIN_1, toAddress: buyer2Addr }),
      getEscrowOrder: async () => ({
        orderId: 'ord_collision',
        itemPinId: ITEM_PIN_1,
        amountMilli: 15000,
        buyerAddress: buyer2Addr,
        buyerNftAddress: buyer2Addr,
        sellerAddress: sellerMvcAddr,
        sellerBotAddress: sellerMvcAddr,
        status: 'FROZEN_AWAITING_DELIVERY',
        statusCode: 1,
      }) as any,
      rejectEscrowOrder: async (_signer, _oid, { reason }) => {
        meRejectedReason = reason;
        return { orderId: 'ord_collision', status: 'CANCELED_REFUNDED' } as any;
      },
      fetchItemInfo: async () => ({
        itemPinId: ITEM_PIN_1,
        ownerAddress: sellerMvcAddr,
        burned: false,
      }) as any,
      now: () => t0 + 120_000,
    });
    const meResult = await daemon.processEscrowOrder(1, 'ord_collision');
    assert.equal(meResult.outcome, 'rejected');
    assert.match(meRejectedReason, /item_reserved_by_active_token_order/);

    // After 5-minute TTL expires -> new reservation succeeds
    const r3 = createTokenGoodsReservation(db, saveDb, {
      sellerMetabotId: 1,
      itemPinId: ITEM_PIN_1,
      assetKey: REAL_MRC20_KEY,
      buyerNftAddress: buyer2Addr,
      sellerReceiveAddress: SELLER_BTC,
      amountBase: '20000000000',
      nowMs: t0 + 5 * 60 * 1000 + 1,
    });
    assert.equal(r3.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 4. S-06: paymentTxId Global Anti-Replay Protection
// ---------------------------------------------------------------------------

test('S-06: paymentTxId can settle one item once; replaying same paymentTxId against item #2 is rejected', async () => {
  await withDaemonDb(async ({ db, saveDb }) => {
    const sellerMvcWallet = await getMvcWalletFromPath(SELLER_MNEMONIC, DEFAULT_PATH);
    const sellerMvcAddr = sellerMvcWallet.getAddress();
    const buyerMvcAddr = (await getMvcWalletFromPath(BUYER_MNEMONIC, DEFAULT_PATH)).getAddress();
    const paymentTxId = '88'.repeat(32);

    const kv = makeKv();
    kv.set('mrc721_sell_intents:1', [ITEM_PIN_1, ITEM_PIN_2].map((pin, idx) => ({
      id: `intent_${idx}`,
      metabotId: 1,
      sellPinId: `${String(idx + 1).repeat(64)}i0`,
      status: 'active',
      autoFulfillTokens: true,
      updatedAt: 1_700_000_000_000,
      intent: {
        active: true,
        itemPinId: pin,
        sellerAddress: sellerMvcAddr,
        sellerMetaId: SELLER_METAID,
        autoFulfillTokens: true,
        prices: {
          tokens: [
            {
              assetKey: REAL_MRC20_KEY,
              chain: 'btc',
              standard: 'mrc20',
              mrc20Id: REAL_MRC20_ID,
              symbol: 'METAID',
              decimals: 8,
              amountBase: '20000000000',
              amountDisplay: '200',
              sellerReceiveAddress: SELLER_BTC,
            },
          ],
        },
        acceptedCurrencies: [`ft:${REAL_MRC20_KEY}`],
        settlement: ['token-direct'],
        createdAt: 1_700_000_000,
      },
    })));

    const transferredPins: string[] = [];
    const daemon = new SellerAutoFulfillDaemon(db, saveDb, {
      getMetabotStore: () => ({
        getMetabotById: (id: number) => (id === 1 ? { id: 1, enabled: true, mvc_address: sellerMvcAddr, btc_address: SELLER_BTC, globalmetaid: SELLER_METAID } : null),
        getMetabotWalletByMetabotId: () => ({ mnemonic: SELLER_MNEMONIC, path: DEFAULT_PATH }),
        listMetabots: () => [],
      }) as any,
      getSellIntentKv: () => kv,
      fetchItemInfo: async (pinId) => ({
        itemPinId: pinId,
        ownerAddress: sellerMvcAddr,
        burned: false,
      }) as any,
      transferMrc721Item: async ({ pinId, toAddress }) => {
        transferredPins.push(pinId);
        return { txId: `delivery_${transferredPins.length}`, pinId, toAddress };
      },
      fetchMrc20Utxos: async () => [
        {
          txId: paymentTxId,
          address: SELLER_BTC,
          status: 'Available',
          mrc20Id: REAL_MRC20_ID,
          tick: 'METAID',
          decimals: 8,
          amount: '200',
        },
      ],
      fetchBtcTxStatus: async () => ({
        found: true,
        confirmed: true,
        confirmations: 1,
      }),
      now: () => 1_700_000_020_000,
    });

    const res1 = await daemon.handleTokenGoodsReserve(1, BUYER_METAID, {
      itemPinId: ITEM_PIN_1,
      assetKey: REAL_MRC20_KEY,
      buyerNftAddress: buyerMvcAddr,
    });
    assert.equal(res1.ok !== false && res1.outcome, 'reserved');

    const paid1 = await daemon.handleTokenGoodsPaid(1, BUYER_METAID, {
      reservationId: res1.reservationId!,
      paymentTxId,
    });
    assert.equal(paid1.outcome, 'delivered');
    assert.deepEqual(transferredPins, [ITEM_PIN_1]);

    // Idempotent resend for the SAME reservationId -> returns same deliveryTxId without re-transferring
    const paid1Retry = await daemon.handleTokenGoodsPaid(1, BUYER_METAID, {
      reservationId: res1.reservationId!,
      paymentTxId,
    });
    assert.equal(paid1Retry.outcome, 'delivered');
    assert.equal(paid1Retry.nftDeliveryTxId, paid1.nftDeliveryTxId);
    assert.deepEqual(transferredPins, [ITEM_PIN_1]);

    // Replay attack: reserve ITEM_PIN_2 and submit the SAME paymentTxId -> MUST reject!
    const res2 = await daemon.handleTokenGoodsReserve(1, BUYER_METAID, {
      itemPinId: ITEM_PIN_2,
      assetKey: REAL_MRC20_KEY,
      buyerNftAddress: buyerMvcAddr,
    });
    assert.equal(res2.outcome, 'reserved');

    const replay = await daemon.handleTokenGoodsPaid(1, BUYER_METAID, {
      reservationId: res2.reservationId!,
      paymentTxId,
    });
    assert.equal(replay.outcome, 'rejected');
    assert.match(replay.reason || '', /payment_tx_already_used_for/);
    assert.deepEqual(transferredPins, [ITEM_PIN_1]);
  });
});

// ---------------------------------------------------------------------------
// 5. Path A: Real MetaContract MVC FT <-> MRC-721 Atomic Swap Crypto & Attacks
// ---------------------------------------------------------------------------

test('Path A: builds real MVC FT atomic proposal, verifies offline, blocks anti-drain & fake codehash, and settles', async () => {
  ContractUtil.init();
  const sellerMvcWallet = await getMvcWalletFromPath(SELLER_MNEMONIC, DEFAULT_PATH);
  const buyerMvcWallet = await getMvcWalletFromPath(BUYER_MNEMONIC, DEFAULT_PATH);
  const sellerAddr = sellerMvcWallet.getAddress();
  const buyerAddr = buyerMvcWallet.getAddress();
  const sellerWif = sellerMvcWallet.getPrivateKey();
  const buyerH160Hex = mvc.crypto.Hash.sha256ripemd160(
    Buffer.from(mvc.PrivateKey.fromWIF(buyerMvcWallet.getPrivateKey()).toPublicKey().toString(), 'hex'),
  ).toString('hex');

  // Create valid TokenGenesis -> tx0 -> tx1 holding 50000000000 (500 tokens) owned by buyer
  const genContract = TokenGenesisFactory.createContract();
  genContract.setFormatedDataPart({ tokenName: 'SHOW', tokenSymbol: 'SHOW', decimalNum: 8, tokenAddress: buyerH160Hex });
  const tcGen = new TxComposer();
  tcGen.appendP2PKHInput({ txId: '11'.repeat(32), outputIndex: 0, satoshis: 10000, address: new mvc.Address(buyerAddr, 'livenet') });
  tcGen.appendOutput({ lockingScript: genContract.lockingScript, satoshis: 1000 });
  const txGen = tcGen.getTx();
  const sensibleID = { txid: txGen.id, index: 0 };

  const gen2 = genContract.clone();
  gen2.setFormatedDataPart({ sensibleID });
  const genesisHash = gen2.getScriptHash();

  const tokenBase = TokenFactory.createContract(
    ContractUtil.transferCheckCodeHashArray,
    ContractUtil.unlockContractCodeHashArray,
    2,
  );
  tokenBase.setFormatedDataPart({
    tokenName: 'SHOW',
    tokenSymbol: 'SHOW',
    decimalNum: 8,
    tokenAddress: buyerH160Hex,
    tokenAmount: BN_SHIM(50_000_000_000n),
    genesisHash,
    sensibleID,
  });
  const tokScriptBuf = tokenBase.lockingScript.toBuffer();
  const codehash = getTokenCodeHashHex(tokScriptBuf);
  const genesis = getTokenIdHex(tokScriptBuf);

  const tc0 = new TxComposer();
  tc0.appendInput({ txId: txGen.id, outputIndex: 0, satoshis: 1000, lockingScript: gen2.lockingScript });
  tc0.appendOutput({ lockingScript: mvc.Script.fromBuffer(tokScriptBuf), satoshis: 1000 });
  const tx0 = tc0.getTx();

  const tc1 = new TxComposer();
  tc1.appendInput({ txId: tx0.id, outputIndex: 0, satoshis: 1000, lockingScript: mvc.Script.fromBuffer(tokScriptBuf) });
  tc1.appendOutput({ lockingScript: mvc.Script.fromBuffer(tokScriptBuf), satoshis: 1000 });
  const tx1 = tc1.getTx();

  const rawByTxid = new Map<string, string>([
    [tx0.id.toLowerCase(), tc0.getRawHex()],
    [tx1.id.toLowerCase(), tc1.getRawHex()],
  ]);

  const itemOutpoint = { txid: '55'.repeat(32), vout: 0, satoshis: 546 };
  const mockStore = {
    getMetabotWalletByMetabotId: (id: number) => (id === 2
      ? { mnemonic: BUYER_MNEMONIC, path: DEFAULT_PATH }
      : { mnemonic: SELLER_MNEMONIC, path: DEFAULT_PATH }),
  } as any;

  const proposal = await buildMvcFtGoodsAtomicProposal(
    mockStore,
    {
      metabotId: 2,
      itemPinId: ITEM_PIN_1,
      itemOutpoint,
      sellerMvcAddress: sellerAddr,
      codehash,
      genesis,
      amountBase: '20000000000',
      buyerNftAddress: buyerAddr,
      feeRate: 1,
    },
    {
      fetchFtUtxos: async () => [{ txid: tx1.id, txIndex: 0, valueString: '50000000000', codeHash: codehash, genesis }],
      fetchRawTx: async (txid) => {
        const hex = rawByTxid.get(txid.toLowerCase());
        if (!hex) throw new Error(`missing raw ${txid}`);
        return hex;
      },
      fetchFundingUtxos: async () => [{ txId: '66'.repeat(32), outputIndex: 0, satoshis: 50_000, address: buyerAddr }],
    },
  );

  // Valid Seller verification & co-sign succeeds and passes mvc.Script.Interpreter on ALL inputs
  const okRes = verifyAndSignMvcFtGoodsAtomicProposal({
    partialTx: proposal.partialTx,
    amountCheckRawTx: proposal.amountCheckRawTx,
    expectedItemOutpoint: itemOutpoint,
    sellerMvcAddress: sellerAddr,
    expectedCodehash: codehash,
    expectedGenesis: genesis,
    expectedMinAmountBase: '20000000000',
    sellerWif,
  });
  assert.equal(okRes.valid, true);
  if (okRes.valid) {
    assert.ok(okRes.finalRawTx);
    assert.ok(okRes.txId);
    assert.equal(okRes.buyerNftAddress, buyerAddr);
  }

  // S-01 Fake Genesis/Codehash rejection
  const fakeGenesisRes = verifyAndSignMvcFtGoodsAtomicProposal({
    partialTx: proposal.partialTx,
    amountCheckRawTx: proposal.amountCheckRawTx,
    expectedItemOutpoint: itemOutpoint,
    sellerMvcAddress: sellerAddr,
    expectedCodehash: codehash,
    expectedGenesis: 'ff'.repeat(20),
    expectedMinAmountBase: '20000000000',
    sellerWif,
  });
  assert.equal(fakeGenesisRes.valid, false);
  if (!fakeGenesisRes.valid) assert.match(fakeGenesisRes.reason, /ft_asset_mismatch/);

  // Underpriced FT rejection
  const underpricedRes = verifyAndSignMvcFtGoodsAtomicProposal({
    partialTx: proposal.partialTx,
    amountCheckRawTx: proposal.amountCheckRawTx,
    expectedItemOutpoint: itemOutpoint,
    sellerMvcAddress: sellerAddr,
    expectedCodehash: codehash,
    expectedGenesis: genesis,
    expectedMinAmountBase: '25000000000',
    sellerWif,
  });
  assert.equal(underpricedRes.valid, false);
  if (!underpricedRes.valid) assert.match(underpricedRes.reason, /ft_amount_below_listing/);

  // Anti-drain attack: attacker tries to include an extra Seller P2PKH UTXO in proposal
  const tamperedObj = JSON.parse(proposal.partialTx);
  const tamperedTc = TxComposer.deserialize(proposal.partialTx);
  const extraSellerTxid = '99'.repeat(32);
  const sellerH160Buf = Buffer.from(new mvc.Address(sellerAddr, 'livenet').hashBuffer);
  tamperedTc.appendInput({
    txId: extraSellerTxid,
    outputIndex: 0,
    satoshis: 100_000,
    lockingScript: new mvc.Script(p2pkhScript(sellerH160Buf)),
  });
  const tamperedSerialized = tamperedTc.serialize();
  const tamperedEnvelope = JSON.parse(tamperedSerialized);
  tamperedEnvelope.txPrevOutputs = [
    ...(tamperedObj.txPrevOutputs ?? []),
    { satoshis: 100_000, script: p2pkhScript(sellerH160Buf).toString('hex') },
  ];
  const drainRes = verifyAndSignMvcFtGoodsAtomicProposal({
    partialTx: JSON.stringify(tamperedEnvelope),
    amountCheckRawTx: proposal.amountCheckRawTx,
    expectedItemOutpoint: itemOutpoint,
    sellerMvcAddress: sellerAddr,
    expectedCodehash: codehash,
    expectedGenesis: genesis,
    expectedMinAmountBase: '20000000000',
    sellerWif,
  });
  assert.equal(drainRes.valid, false);
  if (!drainRes.valid) assert.match(drainRes.reason, /unauthorized_seller_utxo_spend/);
});

// ---------------------------------------------------------------------------
// 6. Wire Protocol & Buyer Tool `goods_buy_with_token` End-to-End Flow
// ---------------------------------------------------------------------------

test('goodsTradeWireProtocol & goods_buy_with_token: Path B confirmation gate, presence check, reserve->pay->deliver', async () => {
  // Wire round-trip check
  const atomicWire = formatGoodsTradeWireMessage({
    type: 'FT_GOODS_ATOMIC_PROPOSAL_V1',
    proposalId: 'prop_1',
    itemPinId: ITEM_PIN_1,
    assetKey: 'mvc-ft:' + 'aa'.repeat(20) + ':' + 'bb'.repeat(20),
    amountBase: '20000000000',
    buyerNftAddress: '1Lbcfr7sAHTD9CgdQo3HTMTkV8LK4ZnX71',
    sellerReceiveAddress: '1L8me3xT5G1R3gJ8zQ5cS6oX2Y9wQ7hP8c',
    amountCheckRawTx: '01000000',
    partialTx: '{}',
  });
  const parsedAtomic = parseGoodsTradeWireMessage(atomicWire);
  assert.equal(parsedAtomic?.type, 'FT_GOODS_ATOMIC_PROPOSAL_V1');

  const sellerMvcAddr = (await getMvcWalletFromPath(SELLER_MNEMONIC, DEFAULT_PATH)).getAddress();
  const buyerMvcAddr = (await getMvcWalletFromPath(BUYER_MNEMONIC, DEFAULT_PATH)).getAddress();
  const waiters = new TokenGoodsWaiterRegistry();
  let transferCalled = 0;

  const tools = buildGoodsTradeAgentTools({
    tool: makeFakeSdkTool() as any,
    sessionId: 'sess_tok_test',
    resolveMetabotId: () => 2,
    confirmGoodsPurchase: async () => false,
    confirmGoodsTokenPurchase: async () => true,
    control: {
      getMetabotIdentity: () => ({
        name: 'BuyerBot',
        mvcAddress: buyerMvcAddr,
        btcAddress: 'bc1qbuyer00000000000000000000000000000000',
        globalMetaId: BUYER_METAID,
      }),
      getTradeBalance: async () => ({
        botAddress: buyerMvcAddr,
        tradeSpendableMilli: 0,
        weeklyRemainingMilli: 0,
        earnedMilli: 0,
        topupMilli: 0,
        bonusMilli: 0,
        frozenMilli: 0,
      }) as any,
      createEscrowOrder: async () => { throw new Error('unused'); },
      getEscrowOrder: async () => { throw new Error('unused'); },
      checkSellerOnline: async () => true,
      getTokenBalanceBase: async () => ({ balanceBase: '50000000000', symbol: 'METAID', decimals: 8 }),
      fetchItemInfo: async () => ({
        itemPinId: ITEM_PIN_1,
        name: 'AI Practical Course Card #08',
        collectionName: 'ai-courses',
        ownerAddress: sellerMvcAddr,
        ownerMetaId: SELLER_METAID,
        burned: false,
      }) as any,
      fetchMarketListings: async () => ({
        items: [
          {
            intentPinId: SELL_PIN_1,
            itemPinId: ITEM_PIN_1,
            itemName: 'AI Practical Course Card #08',
            collectionName: 'ai-courses',
            autoFulfillTokens: true,
            acceptedCurrencies: [`ft:${REAL_MRC20_KEY}`],
            settlement: ['token-direct'],
            seller: { address: sellerMvcAddr, globalMetaId: SELLER_METAID, isOnline: true },
            prices: {
              tokens: [
                {
                  assetKey: REAL_MRC20_KEY,
                  chain: 'btc',
                  standard: 'mrc20',
                  mrc20Id: REAL_MRC20_ID,
                  symbol: 'METAID',
                  decimals: 8,
                  amountBase: '20000000000',
                  amountDisplay: '200',
                  sellerReceiveAddress: SELLER_BTC,
                },
              ],
            },
          },
        ],
      }) as any,
      transferBtcMrc20: async () => {
        transferCalled += 1;
        return { revealTxId: 'cc'.repeat(32), commitTxId: 'dd'.repeat(32) };
      },
      waitForTokenGoodsEvent: (key, timeoutMs) => waiters.waitFor(key, timeoutMs),
      sendTradeMessage: async ({ content }) => {
        const msg = parseGoodsTradeWireMessage(content);
        if (msg?.type === 'TOKEN_GOODS_RESERVE_V1') {
          setTimeout(() => {
            waiters.notify(`reserve:${msg.reserveRequestId}`, {
              kind: 'reserved',
              reservationId: 'tgres_e2e_1',
              sellerReceiveAddress: SELLER_BTC,
              amountBase: '20000000000',
              expiresAt: Date.now() + 300_000,
            });
          }, 10);
        } else if (msg?.type === 'TOKEN_GOODS_PAID_V1') {
          setTimeout(() => {
            waiters.notify(`deliver:${msg.reservationId}`, {
              kind: 'delivered',
              reservationId: msg.reservationId,
              nftDeliveryTxId: 'ee'.repeat(32),
            });
          }, 10);
        }
        return { txids: ['dm_tx'], pinId: `${'fa'.repeat(32)}i0` };
      },
    },
  }) as any[];

  const buyWithToken = tools.find((t) => t.name === 'goods_buy_with_token');
  assert.ok(buyWithToken, 'goods_buy_with_token tool must be exposed');

  // Exceeding max_token_amount must reject before touching transfer
  const overMax = await buyWithToken.handler({
    item_pin_id: ITEM_PIN_1,
    asset_key: REAL_MRC20_KEY,
    max_token_amount: '100',
  });
  assert.equal(overMax.isError, true);
  assert.match(overMax.content[0].text, /exceeds max_token_amount/);
  assert.equal(transferCalled, 0);

  // Full happy path E2E-3
  const ok = await buyWithToken.handler({
    item_pin_id: ITEM_PIN_1,
    asset_key: REAL_MRC20_KEY,
    max_token_amount: '200',
  });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /DELIVERED/);
  assert.match(ok.content[0].text, new RegExp('ee'.repeat(32)));
  assert.equal(transferCalled, 1);
  waiters.clear();
});

// ---------------------------------------------------------------------------
// 7. REQ-4-03: NftCard, commerceBridgeContract, commerceTradeEvents & Modal
// ---------------------------------------------------------------------------

test('REQ-4-03: NftCard, bridge contract, and GoodsPurchaseConfirmModal carry paymentAssetKey and render token capsules', () => {
  const cardPayload = {
    format: 'mrc721' as const,
    pinId: ITEM_PIN_1,
    name: 'AI Practical Course Rights Card',
    series: 'ai-courses',
    owner: '1L8me3xT5G1R3gJ8zQ5cS6oX2Y9wQ7hP8c',
    sellerGlobalMetaId: SELLER_METAID,
    action: 'selling',
    priceTokens: [
      {
        assetKey: REAL_MRC20_KEY,
        chain: 'btc' as const,
        symbol: 'METAID',
        decimals: 8,
        amountBase: '20000000000',
        amountDisplay: '200',
        sellerReceiveAddress: SELLER_BTC,
      },
    ],
  };

  const fence = serializeNftCardFence(cardPayload);
  const parsed = parseNftCardFence(fence.replace(/^```nft-card\n|\n```$/g, ''));
  assert.ok(parsed?.priceTokens?.length === 1);
  assert.equal(parsed?.priceTokens?.[0].assetKey, REAL_MRC20_KEY);

  const cardHtml = renderToStaticMarkup(React.createElement(NftCard, { data: parsed! }));
  assert.match(cardHtml, /200 \$METAID/);
  assert.match(cardHtml, /data-nft-action="buy-token"/);
  assert.match(cardHtml, new RegExp(`data-asset-key="${REAL_MRC20_KEY}"`));

  // Bridge contract carries paymentAssetKey cleanly
  const sanitized = sanitizeAskTwinToBuy({
    itemPinId: ITEM_PIN_1,
    collectionName: 'ai-courses',
    itemName: 'AI Practical Course Rights Card',
    sellerGlobalMetaId: SELLER_METAID,
    mode: 'buy_token',
    paymentAssetKey: REAL_MRC20_KEY,
    paymentSymbol: 'METAID',
    paymentAmountDisplay: '200',
    paymentAmountBase: '20000000000',
  });
  assert.ok(!(sanitized instanceof SanitizeFailure));
  if (!(sanitized instanceof SanitizeFailure)) {
    assert.equal(sanitized.mode, 'buy_token');
    assert.equal(sanitized.paymentAssetKey, REAL_MRC20_KEY);
    const resolved = resolveCommerceIntentAction({
      intent: 'askTwinToBuy',
      params: sanitized,
    });
    assert.ok(resolved && resolved.kind === 'open_confirm_modal');
    if (resolved && resolved.kind === 'open_confirm_modal') {
      assert.equal(resolved.target.paymentAssetKey, REAL_MRC20_KEY);
      const modalHtml = renderToStaticMarkup(
        React.createElement(GoodsPurchaseConfirmModal, {
          open: true,
          target: resolved.target,
          onClose: () => {},
        }),
      );
      assert.match(modalHtml, new RegExp(`data-payment-asset-key="${REAL_MRC20_KEY}"`));
      assert.match(modalHtml, /200 \$METAID/);
      assert.match(modalHtml, /data-action="confirm-token-buy"/);
    }
  }
});
