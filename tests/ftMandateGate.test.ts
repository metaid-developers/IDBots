import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { mvc } from 'meta-contract';

import {
  FtMandateError,
  FtMandateGate,
  normalizeFtAssetKey,
} from '../src/main/services/ftMandateGateService';
import {
  getFtBatchOrderProgress,
  registerFtActiveOrder,
  validateFtSellPinPayload,
} from '../src/main/services/ftOrderStore';
import {
  formatGoodsTradeWireMessage,
  parseGoodsTradeWireMessage,
} from '../src/main/services/goodsTradeWireProtocol';
import {
  createFtEscrowOrder,
  deliverFtEscrowOrder,
  validatePositiveBaseUnits,
} from '../src/main/services/meFtEscrowService';
import {
  handleFtEscrowBuyRoute,
  handleFtMandateConfirmRoute,
  handleMvcFtSplitRoute,
  handleMvcTokenSellBuyRoute,
  handleMvcTokenSellCancelRoute,
  handleMvcTokenSellListRoute,
  type FtCommerceGatewayDeps,
} from '../src/main/services/ftCommerceGatewayRoutes';

const MSP_ASSET_KEY = 'mrc20:msp_pin_id_12345i0';
const MC_CODEHASH = 'a2421f1e90c6048c36745edd44fad682e8644693';
const MC_GENESIS = '777788889999aaaabbbbccccddddeeeeffff0000';
const MC_ASSET_KEY = `mvc-ft:${MC_CODEHASH}:${MC_GENESIS}`;

test('FtMandateGate: approves mandate, tracks BigInt budget across lots, and rejects overspend or cross-asset escalation', async () => {
  const gate = new FtMandateGate();
  gate.setDirectApprover(async () => ({ approved: true }));

  const nowMs = 1_700_000_000_000;
  const confirm = await gate.requestMandate(
    {
      metabotId: 7,
      action: 'buy-sweep',
      assetKey: MC_ASSET_KEY.toUpperCase(),
      symbol: 'MC',
      decimals: 8,
      rail: 'mvc-tokensell',
      totalTokenDisplay: '1,500 MC',
      lotCount: 3,
      maxSpendDisplay: '0.15 SPACE',
      maxSpendAmount: '15000000', // 0.15 SPACE in sats
      estimatedGasDisplay: '~1,200 sats',
      caVerified: true,
    },
    { nowMs, ttlMs: 300_000 },
  );

  assert.equal(confirm.confirmed, true);
  assert.ok(confirm.mandateToken?.startsWith('ftm_'));
  assert.equal(confirm.expiresAt, nowMs + 300_000);

  const token = confirm.mandateToken!;

  // Lot 1: spend 5,000,000 sats
  const step1 = gate.consumeMandate({
    mandateToken: token,
    metabotId: 7,
    action: 'buy-sweep',
    assetKey: MC_ASSET_KEY,
    rail: 'mvc-tokensell',
    spendAmount: '5000000',
    lots: 1,
    nowMs: nowMs + 1_000,
  });
  assert.equal(step1.remainingSpendAmount, '10000000');
  assert.equal(step1.remainingLots, 2);

  // Cross-asset privilege escalation attempt -> MUST reject with MANDATE_ASSET_MISMATCH
  assert.throws(
    () =>
      gate.consumeMandate({
        mandateToken: token,
        metabotId: 7,
        action: 'buy-sweep',
        assetKey: MSP_ASSET_KEY,
        rail: 'mvc-tokensell',
        spendAmount: '1000',
        lots: 1,
        nowMs: nowMs + 2_000,
      }),
    (err: unknown) => err instanceof FtMandateError && err.code === 'MANDATE_ASSET_MISMATCH',
  );

  // Cross-bot reuse attempt -> MUST reject with MANDATE_METABOT_MISMATCH
  assert.throws(
    () =>
      gate.consumeMandate({
        mandateToken: token,
        metabotId: 99,
        action: 'buy-sweep',
        assetKey: MC_ASSET_KEY,
        rail: 'mvc-tokensell',
        spendAmount: '1000',
        lots: 1,
        nowMs: nowMs + 2_000,
      }),
    (err: unknown) => err instanceof FtMandateError && err.code === 'MANDATE_METABOT_MISMATCH',
  );

  // Overspend attempt (10,000,001 > remaining 10,000,000) -> MUST reject with MANDATE_BUDGET_EXCEEDED
  assert.throws(
    () =>
      gate.consumeMandate({
        mandateToken: token,
        metabotId: 7,
        action: 'buy-sweep',
        assetKey: MC_ASSET_KEY,
        rail: 'mvc-tokensell',
        spendAmount: '10000001',
        lots: 1,
        nowMs: nowMs + 3_000,
      }),
    (err: unknown) => err instanceof FtMandateError && err.code === 'MANDATE_BUDGET_EXCEEDED',
  );

  // Exact ceiling spend succeeds
  const step2 = gate.consumeMandate({
    mandateToken: token,
    metabotId: 7,
    action: 'buy-sweep',
    assetKey: MC_ASSET_KEY,
    rail: 'mvc-tokensell',
    spendAmount: '10000000',
    lots: 1,
    nowMs: nowMs + 4_000,
  });
  assert.equal(step2.remainingSpendAmount, '0');
  assert.equal(step2.remainingLots, 1);

  // 5-minute TTL expiry -> MUST reject with MANDATE_EXPIRED
  assert.throws(
    () =>
      gate.consumeMandate({
        mandateToken: token,
        metabotId: 7,
        action: 'buy-sweep',
        assetKey: MC_ASSET_KEY,
        rail: 'mvc-tokensell',
        spendAmount: '0',
        lots: 1,
        nowMs: nowMs + 300_000,
      }),
    (err: unknown) => err instanceof FtMandateError && err.code === 'MANDATE_EXPIRED',
  );
});

test('FtMandateGate: defaults strictly to DENY on prompt timeout or missing renderer window', async () => {
  const gate = new FtMandateGate();

  // Case 1: No prompt emitter registered -> denied immediately
  const noUiResult = await gate.requestMandate({
    metabotId: 1,
    action: 'buy-sweep',
    assetKey: MSP_ASSET_KEY,
    symbol: 'MSP',
    rail: 'btc-psbt',
    totalTokenDisplay: '100 MSP',
    lotCount: 1,
    maxSpendDisplay: '10,000 sats',
    maxSpendAmount: '10000',
    estimatedGasDisplay: '500 sats',
  });
  assert.equal(noUiResult.confirmed, false);
  assert.equal(noUiResult.mandateToken, undefined);

  // Case 2: Prompt emitter accepts event, but user never clicks Confirm -> timeout denies
  gate.setPromptEmitter(() => true);
  const timeoutResult = await gate.requestMandate(
    {
      metabotId: 1,
      action: 'buy-sweep',
      assetKey: MSP_ASSET_KEY,
      symbol: 'MSP',
      rail: 'btc-psbt',
      totalTokenDisplay: '100 MSP',
      lotCount: 1,
      maxSpendDisplay: '10,000 sats',
      maxSpendAmount: '10000',
      estimatedGasDisplay: '500 sats',
    },
    { promptTimeoutMs: 25 },
  );
  assert.equal(timeoutResult.confirmed, false);
  assert.equal(timeoutResult.reason, 'timeout_denied');
});

test('ftOrderStore: enforces Contract C1.3 UTXO mutual exclusion between native lock and ME auto-fulfill', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    const outpoint = `${'a'.repeat(64)}:0`;
    registerFtActiveOrder(db, {
      listingKey: 'lot-mvc-1',
      batchGroupId: 'batch-1',
      metabotId: 3,
      assetKey: MC_ASSET_KEY,
      chain: 'mvc',
      symbol: 'MC',
      decimals: 8,
      rail: 'mvc-tokensell',
      amountBase: '10000000000',
      amountDisplay: '100',
      utxoOutpoint: outpoint,
      priceSats: 50000,
    });

    // Attempting to register the same UTXO on me-escrow while mvc-tokensell is active MUST throw UTXO_RAIL_CONFLICT
    assert.throws(
      () =>
        registerFtActiveOrder(db, {
          listingKey: 'lot-me-1',
          batchGroupId: 'batch-1',
          metabotId: 3,
          assetKey: MC_ASSET_KEY,
          chain: 'mvc',
          symbol: 'MC',
          decimals: 8,
          rail: 'me-escrow',
          amountBase: '10000000000',
          amountDisplay: '100',
          utxoOutpoint: outpoint,
          priceMeMilli: 25000,
          autoFulfillMe: true,
        }),
      /UTXO_RAIL_CONFLICT/,
    );

    // Payload validator also rejects dual native + ME autoFulfill on a single pin
    assert.throws(
      () =>
        validateFtSellPinPayload({
          version: '1.0',
          active: true,
          listingKey: 'bad-dual',
          batchGroupId: 'batch-1',
          asset: {
            chain: 'mvc',
            standard: 'mvc-ft',
            assetKey: MC_ASSET_KEY,
            symbol: 'MC',
            decimals: 8,
          },
          lot: {
            amountBase: '10000000000',
            amountDisplay: '100',
            utxoOutpoint: outpoint,
          },
          seller: {
            globalMetaId: 'idq1seller',
            botMvcAddress: '1SellerAddr',
          },
          rails: {
            mvcTokenSell: {
              priceSats: 50000,
              contractAddress: '1Contract',
              txid: 'a'.repeat(64),
              tokenSellJson: '{}',
            },
            me: {
              priceMeMilli: 10000,
              autoFulfill: true,
            },
          },
        }),
      /UTXO_RAIL_CONFLICT/,
    );
  } finally {
    db.close();
  }
});

test('goodsTradeWireProtocol: round-trips ME_FT_ESCROW_LOCKED_V1 & ME_FT_DELIVERY_DONE_V1 without breaking NFT wire messages', () => {
  const ftLocked = formatGoodsTradeWireMessage({
    type: 'ME_FT_ESCROW_LOCKED_V1',
    orderId: 'ftord_001',
    assetKey: MSP_ASSET_KEY,
    chain: 'btc',
    tokenSymbol: 'MSP',
    tokenDecimals: 8,
    tokenAmountBase: '50000000000',
    amountMilli: 12000,
    buyerReceiveAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    sellerBotAddress: '1SellerBotAddress',
    listingKey: 'msp-lot-1',
    buyerGlobalMetaId: 'idq1buyer',
  });

  const parsedFt = parseGoodsTradeWireMessage(ftLocked);
  assert.ok(parsedFt && parsedFt.type === 'ME_FT_ESCROW_LOCKED_V1');
  assert.equal(parsedFt.orderId, 'ftord_001');
  assert.equal(parsedFt.assetKey, MSP_ASSET_KEY);
  assert.equal(parsedFt.tokenAmountBase, '50000000000');
  assert.equal(parsedFt.chain, 'btc');

  const nftLocked = formatGoodsTradeWireMessage({
    type: 'ME_ESCROW_LOCKED_V1',
    orderId: 'ord_nft_1',
    itemPinId: `${'b'.repeat(64)}i0`,
    amountMilli: 5000,
    buyerNftAddress: '1BuyerNft',
    sellerBotAddress: '1SellerNft',
  });
  const parsedNft = parseGoodsTradeWireMessage(nftLocked);
  assert.ok(parsedNft && parsedNft.type === 'ME_ESCROW_LOCKED_V1');
  assert.equal(parsedNft.orderId, 'ord_nft_1');
});

test('meFtEscrowService: signs BSMA headers omitting X-Identity-Address and preserves 18-decimal BigInt tokenAmountBase', async () => {
  const buyerMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const sellerKey = new mvc.PrivateKey();
  const sellerAddr = sellerKey.toAddress('livenet').toString();

  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  const hugeAmount = '123456789012345678901234567'; // > Number.MAX_SAFE_INTEGER
  assert.equal(validatePositiveBaseUnits(hugeAmount), hugeAmount);

  const order = await createFtEscrowOrder(
    {
      mnemonic: buyerMnemonic,
    },
    {
      sellerBotAddress: sellerAddr,
      chain: 'mvc',
      assetKey: MC_ASSET_KEY,
      tokenSymbol: 'MC',
      tokenDecimals: 18,
      tokenAmountBase: hugeAmount,
      amountMilli: 8000,
      buyerReceiveAddress: sellerAddr,
      listingKey: 'mc-lot-18dec',
      idempotencyKey: 'idem_ft_001',
    },
    {
      baseUrl: 'https://assist.example.test',
      fetchImpl: async (_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        capturedBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              orderId: 'ftord_999',
              buyerBotAddress: capturedHeaders['X-Bot-Address'],
              sellerBotAddress: sellerAddr,
              sellerPayeeAddress: sellerAddr,
              chain: 'mvc',
              assetKey: MC_ASSET_KEY,
              tokenSymbol: 'MC',
              tokenDecimals: 18,
              tokenAmountBase: hugeAmount,
              amountMilli: 8000,
              buyerReceiveAddress: sellerAddr,
              status: 'FROZEN_AWAITING_DELIVERY',
              expiresAt: '2026-04-19T12:00:00Z',
            },
          }),
          { status: 200 },
        );
      },
    },
  );

  assert.ok(capturedHeaders['X-Bot-Address']?.startsWith('1'));
  assert.equal(capturedHeaders['X-Identity-Address'], undefined);
  assert.ok(capturedHeaders['X-Signature']);
  assert.equal(capturedBody.tokenAmountBase, hugeAmount);
  assert.equal(order.tokenAmountBase, hugeAmount);

  const delivered = await deliverFtEscrowOrder(
    {
      mnemonic: buyerMnemonic,
    },
    'ftord_999',
    { deliveryTxId: 'c'.repeat(64) },
    {
      baseUrl: 'https://assist.example.test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              orderId: 'ftord_999',
              buyerBotAddress: sellerAddr,
              sellerBotAddress: sellerAddr,
              sellerPayeeAddress: sellerAddr,
              chain: 'mvc',
              assetKey: MC_ASSET_KEY,
              tokenSymbol: 'MC',
              tokenDecimals: 18,
              tokenAmountBase: hugeAmount,
              amountMilli: 8000,
              buyerReceiveAddress: sellerAddr,
              status: 'RELEASED_TO_SELLER',
              deliveryTxId: 'c'.repeat(64),
              expiresAt: '2026-04-19T12:00:00Z',
            },
          }),
          { status: 200 },
        ),
    },
  );
  assert.equal(delivered.status, 'RELEASED_TO_SELLER');
});

test('ftCommerceGatewayRoutes: split protects earlier lot outpoints, buy enforces pre-sign verifyMvcTokenSellListing, and cancel updates ft_active_orders', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const gate = new FtMandateGate();
  gate.setDirectApprover(async () => ({ approved: true }));

  const sellerKey = new mvc.PrivateKey();
  const buyerKey = new mvc.PrivateKey();
  const sellerMvc = sellerKey.toAddress('livenet').toString();
  const buyerMvc = buyerKey.toAddress('livenet').toString();

  const seenExcludes: Array<string[] | undefined> = [];
  let splitCounter = 0;
  let takeCalled = false;

  const deps: FtCommerceGatewayDeps = {
    getDb: () => db,
    mandateGate: gate,
    resolveMvcFeeRate: () => 1,
    getMetabotStore: () =>
      ({
        getMetabotById: (id: number) =>
          id === 1
            ? { id: 1, mvc_address: sellerMvc, btc_address: 'bc1qseller000000000000000', globalmetaid: 'idq1seller' }
            : { id: 2, mvc_address: buyerMvc, btc_address: 'bc1qbuyer0000000000000000', globalmetaid: 'idq1buyer' },
        listMetabots: () => [],
      }) as never,
    buildFtSplitRawTx: async (_store, params) => {
      seenExcludes.push(params.excludeOutpoints);
      splitCounter += 1;
      const fakeTxid = String(splitCounter).padStart(64, '0');
      return {
        txid: fakeTxid,
        raw_tx: `raw_${splitCounter}`,
        output_index: 0,
        amount_check_txid: `chk_${splitCounter}`.padEnd(64, '0'),
        amount_check_raw_tx: `chk_raw_${splitCounter}`,
        spent_outpoints: [],
        change_outpoint: `${fakeTxid}:1`,
      };
    },
    broadcastMvcRawTx: async (rawTx) => {
      const m = /^raw_(\d+)$/.exec(rawTx);
      if (m) return String(m[1]).padStart(64, '0');
      return 'f'.repeat(64);
    },
    createChainPin: async () => ({ txids: ['e'.repeat(64)], pinId: `${'e'.repeat(64)}i0` }),
    executeTokenSellTrade: async (_store, input) => {
      if (input.action === 'take') takeCalled = true;
      const txId = input.action === 'sell' ? 'd'.repeat(64) : 'c'.repeat(64);
      return {
        action: input.action,
        txId,
        rawTx: '01000000',
        fundingTxIds: [],
        listing: {
          kind: 'mvc-ft-tokensell-listing',
          version: 1,
          codehash: MC_CODEHASH,
          genesis: MC_GENESIS,
          sell_txid: 'd'.repeat(64),
          sell_output_index: 0,
          sell_price_sats: 25000,
          seed_txid: 'd'.repeat(64),
          seed_vout: 1,
          contract_address: '1ContractAddr',
        } as never,
      };
    },
    verifyTokenSellListing: async (listing) => {
      if (listing.sell_price_sats === 999999) {
        return {
          listing,
          verified: false,
          problems: ['price mismatch: seed lock encodes 99999999 sats, listing claims 25000'],
          decoded: { sellerHash160Hex: '00', priceSats: '99999999', sellerAddressBase58: sellerMvc },
          tokenAmount: '1000',
          sellSats: 1000,
          txid: String(listing.sell_txid),
        };
      }
      return {
        listing,
        verified: true,
        problems: [],
        decoded: { sellerHash160Hex: '11', priceSats: '25000', sellerAddressBase58: sellerMvc },
        tokenAmount: '5000000000',
        sellSats: 1000,
        txid: String(listing.sell_txid),
      };
    },
    resolveEscrowSigner: () => ({
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    }),
    createEscrowOrder: async (_signer, params) => ({
      orderId: 'ftesc_order_1',
      buyerBotAddress: buyerMvc,
      sellerBotAddress: params.sellerBotAddress,
      sellerPayeeAddress: params.sellerPayeeAddress ?? params.sellerBotAddress,
      chain: params.chain,
      assetKey: params.assetKey,
      tokenSymbol: params.tokenSymbol,
      tokenDecimals: params.tokenDecimals,
      tokenAmountBase: params.tokenAmountBase,
      amountMilli: params.amountMilli,
      buyerReceiveAddress: params.buyerReceiveAddress,
      listingKey: params.listingKey,
      status: 'FROZEN_AWAITING_DELIVERY',
      expiresAt: '2026-04-19T12:00:00Z',
    }),
  };

  try {
    // 1. Confirm seller list-lots mandate (2 lots)
    const mandateRes = await handleFtMandateConfirmRoute(
      deps,
      JSON.stringify({
        metabotId: 1,
        action: 'list-lots',
        assetKey: MC_ASSET_KEY,
        symbol: 'MC',
        rail: 'mvc-tokensell',
        totalTokenDisplay: '100 MC',
        lotCount: 2,
        maxSpendDisplay: '100 MC',
        maxSpendAmount: '10000000000',
        estimatedGasDisplay: '~1,000 sats',
      }),
    );
    assert.equal(mandateRes.status, 200);
    const listMandateToken = String(mandateRes.body.mandateToken);

    // 2. Split 2 lots -> lot 2 MUST exclude lot 1's newly created outpoint
    const splitRes = await handleMvcFtSplitRoute(
      deps,
      JSON.stringify({
        metabotId: 1,
        mandateToken: listMandateToken,
        codehash: MC_CODEHASH,
        genesis: MC_GENESIS,
        lotAmountsBase: ['5000000000', '5000000000'],
      }),
    );
    assert.equal(splitRes.status, 200);
    assert.equal(seenExcludes[0], undefined);
    assert.deepEqual(seenExcludes[1], [`${'0'.repeat(63)}1:0`]);

    // 3. List lot 1 on TokenSell -> registers in ft_active_orders
    const listRes = await handleMvcTokenSellListRoute(
      deps,
      JSON.stringify({
        metabotId: 1,
        mandateToken: listMandateToken,
        codehash: MC_CODEHASH,
        genesis: MC_GENESIS,
        symbol: 'MC',
        decimals: 8,
        amountBase: '5000000000',
        priceSats: 25000,
        utxoOutpoint: `${'0'.repeat(63)}1:0`,
        batchGroupId: 'batch-mc-demo',
        listingKey: 'mc-demo-lot-1',
      }),
    );
    assert.equal(listRes.status, 200);
    assert.equal(getFtBatchOrderProgress(db, 'batch-mc-demo')?.activeLots, 1);

    // 4. Buyer tries to buy forged TokenSell contract -> blocked BEFORE executeTokenSellTrade
    const buyMandateRes = await handleFtMandateConfirmRoute(
      deps,
      JSON.stringify({
        metabotId: 2,
        action: 'buy-sweep',
        assetKey: MC_ASSET_KEY,
        symbol: 'MC',
        rail: 'mvc-tokensell',
        totalTokenDisplay: '50 MC',
        lotCount: 2,
        maxSpendDisplay: '50,000 sats',
        maxSpendAmount: '50000',
        estimatedGasDisplay: '~800 sats',
      }),
    );
    const buyMandateToken = String(buyMandateRes.body.mandateToken);

    const forgedBuyRes = await handleMvcTokenSellBuyRoute(
      deps,
      JSON.stringify({
        metabotId: 2,
        mandateToken: buyMandateToken,
        assetKey: MC_ASSET_KEY,
        listing: {
          sell_txid: 'd'.repeat(64),
          sell_output_index: 0,
          sell_price_sats: 999999,
        },
      }),
    );
    assert.equal(forgedBuyRes.status, 400);
    assert.equal(forgedBuyRes.body.errorCode, 'TOKEN_SELL_VERIFY_FAILED');
    assert.equal(takeCalled, false);

    // 5. Buyer buys verified TokenSell contract -> succeeds and deducts 25,000 sats
    const validBuyRes = await handleMvcTokenSellBuyRoute(
      deps,
      JSON.stringify({
        metabotId: 2,
        mandateToken: buyMandateToken,
        assetKey: MC_ASSET_KEY,
        tokenSellJson: String(listRes.body.tokenSellJson),
      }),
    );
    assert.equal(validBuyRes.status, 200);
    assert.equal(takeCalled, true);
    assert.equal(validBuyRes.body.remainingSpendAmount, '25000');

    // 6. Seller cancels lot -> marks ft_active_orders canceled
    const cancelRes = await handleMvcTokenSellCancelRoute(
      deps,
      JSON.stringify({
        metabotId: 1,
        assetKey: MC_ASSET_KEY,
        listingKey: 'mc-demo-lot-1',
        tokenSellJson: String(listRes.body.tokenSellJson),
      }),
    );
    assert.equal(cancelRes.status, 200);
    assert.equal(getFtBatchOrderProgress(db, 'batch-mc-demo')?.canceledLots, 1);

    // 7. Buyer ME-escrow buy route consumes me-escrow mandate & sends ME_FT_ESCROW_LOCKED_V1 DM
    let sentDmText = '';
    deps.sendEncryptedPrivateMessage = async (_from, _to, text) => {
      sentDmText = text;
    };
    const meMandate = await handleFtMandateConfirmRoute(
      deps,
      JSON.stringify({
        metabotId: 2,
        action: 'buy-sweep',
        assetKey: MSP_ASSET_KEY,
        symbol: 'MSP',
        rail: 'me-escrow',
        totalTokenDisplay: '100 MSP',
        lotCount: 1,
        maxSpendDisplay: '12 ME',
        maxSpendAmount: '12000',
        estimatedGasDisplay: '0 sats',
      }),
    );
    const escrowBuyRes = await handleFtEscrowBuyRoute(
      deps,
      JSON.stringify({
        metabotId: 2,
        mandateToken: meMandate.body.mandateToken,
        chain: 'btc',
        assetKey: MSP_ASSET_KEY,
        tokenSymbol: 'MSP',
        tokenDecimals: 8,
        tokenAmountBase: '10000000000',
        amountMilli: 12000,
        sellerBotAddress: sellerMvc,
        sellerGlobalMetaId: 'idq1seller',
        listingKey: 'msp-me-lot-1',
      }),
    );
    assert.equal(escrowBuyRes.status, 200);
    assert.equal(escrowBuyRes.body.dmSent, true);
    assert.equal(parseGoodsTradeWireMessage(sentDmText)?.type, 'ME_FT_ESCROW_LOCKED_V1');
  } finally {
    db.close();
  }
});
