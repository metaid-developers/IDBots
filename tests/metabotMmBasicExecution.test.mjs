import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePayload } = require('../SKILLs/metabot-mm-basic/scripts/lib/payload.js');
const {
  verifyPaymentProof,
  verifyWithRetry,
  classifyLatePayment,
} = require('../SKILLs/metabot-mm-basic/scripts/lib/paymentProof.js');
const {
  createInMemoryTerminalState,
  recordTerminalOutcome,
  getTerminalOutcome,
  createLifecycleTrace,
  buildIdempotencyKey,
} = require('../SKILLs/metabot-mm-basic/scripts/lib/state.js');
const { handleMmRequest } = require('../SKILLs/metabot-mm-basic/scripts/lib/execution.js');

function createBaseConfig() {
  return {
    market_data: {
      provider: 'cex',
      quote_fallback_enabled: true,
      execute_fallback_enabled: true,
    },
    pairs: {
      'BTC/SPACE': {
        spread_bps: 200,
        inventory_sensitivity_bps: 0,
        max_skew_bps: 300,
        target_inventory: { BTC: '1', SPACE: '100000' },
        max_usable_inventory: { BTC: '1', SPACE: '60000' },
        trade_limits: {
          min_in_BTC: '0.0001',
          max_in_BTC: '1',
          min_in_SPACE: '100',
          max_in_SPACE: '5000',
        },
      },
      'DOGE/SPACE': {
        spread_bps: 200,
        inventory_sensitivity_bps: 0,
        max_skew_bps: 300,
        target_inventory: { DOGE: '10000', SPACE: '100000' },
        max_usable_inventory: { DOGE: '8000', SPACE: '40000' },
        trade_limits: {
          min_in_DOGE: '10',
          max_in_DOGE: '1000',
          min_in_SPACE: '100',
          max_in_SPACE: '5000',
        },
      },
    },
  };
}

function buildExecutePayload({
  payTxid = 'a'.repeat(64),
  pair = 'BTC/SPACE',
  direction = 'btc_to_space',
  amountIn = '0.1',
  payoutAddress = 'space-destination',
  refundAddress = 'btc-refund-address',
  payerGlobalmetaid = 'payer-gmid',
  quoteContext,
} = {}) {
  return {
    mode: 'execute',
    service: { pair, direction },
    order: {
      amount_in: amountIn,
      pay_txid: payTxid,
      payer_globalmetaid: payerGlobalmetaid,
      payout_address: payoutAddress,
      refund_address: refundAddress,
    },
    ...(quoteContext ? { quote_context: quoteContext } : {}),
  };
}

function createExecutionDeps(options = {}) {
  const transferCalls = [];
  const payoutCalls = [];
  const refundCalls = [];
  const state = createInMemoryTerminalState();
  const config = options.config || createBaseConfig();
  const balanceByAsset = {
    BTC: '2',
    SPACE: '100000',
    DOGE: '50000',
    ...(options.balanceByAsset || {}),
  };

  const deps = {
    env: { IDBOTS_METABOT_ID: '7' },
    terminalState: state,
    now: () => 1_775_000_000_000,
    loadConfig: () => config,
    resolveFairValue: async ({ pair }) => {
      if (pair === 'DOGE/SPACE') {
        return { fairValue: '2', source: 'market', quotes: { btc: 50000, doge: 0.1, space: 0.05 } };
      }
      return { fairValue: '1000', source: 'market', quotes: { btc: 50000, doge: 0.1, space: 0.05 } };
    },
    getAccountSummaryViaRpc: async () => ({
      success: true,
      mvc_address: 'space-maker-address',
      btc_address: 'btc-maker-address',
      doge_address: 'doge-maker-address',
    }),
    getFeeRateSummaryViaRpc: async ({ chain }) => ({
      success: true,
      defaultFeeRate: chain === 'btc' ? 2 : chain === 'doge' ? 200000 : 1,
    }),
    getAddressBalanceViaRpc: async ({ body }) => {
      const addressAssets = body?.addresses || {};
      const requestedAssets = Object.keys(addressAssets);
      const balances = {};
      for (const requestedAsset of requestedAssets) {
        const asset = String(requestedAsset).toUpperCase();
        balances[asset] = String(balanceByAsset[asset] ?? '0');
      }
      return { success: true, balances };
    },
    verifyWithRetry: async () => {
      if (options.forceVoidLookup) {
        return { mode: 'void', lookupAttempts: 2, needsOperatorReconciliation: true };
      }
      return { mode: 'found', lookupAttempts: 1, txSourceResult: { chain: options.expectedChain || 'btc' } };
    },
    verifyPaymentProof: async () => {
      if (options.paymentMismatch) {
        throw new Error('paid amount does not exactly match requested amount.');
      }
      return { ok: true };
    },
    executeTransferViaRpc: async ({ body }) => {
      transferCalls.push(body);
      if (body?.transferType === 'refund') {
        refundCalls.push(body);
        if (options.refundFailure) {
          throw new Error('refund broadcaster unavailable');
        }
        return { success: true, txid: 'refund-txid' };
      }
      payoutCalls.push(body);
      if (options.payoutFailure) {
        throw new Error('payout broadcaster unavailable');
      }
      return { success: true, txid: 'payout-txid' };
    },
  };

  return {
    deps,
    transferCalls,
    payoutCalls,
    refundCalls,
  };
}

test('pair + direction are authoritative and reject conflicting asset_in', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '0.1', asset_in: 'DOGE' },
  }), /asset_in/i);
});

test('execute payload requires pay_txid, payer_globalmetaid, payout_address, and refund_address', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '0.1' },
  }), /pay_txid|payer_globalmetaid|payout_address|refund_address/i);
});

test('quote-confirm payload validates quote_context when has_prior_quote is true', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: {
      amount_in: '0.1',
      pay_txid: 'a'.repeat(64),
      payer_globalmetaid: 'gmid',
      payout_address: 'dest',
      refund_address: 'refund',
    },
    quote_context: { has_prior_quote: true, slippage_bps: 100 },
  }), /quoted_output|quoted_at/i);
});

test('quote payload rejects missing pair and direction for non-supported-pair queries', () => {
  assert.throws(() => normalizePayload({
    mode: 'quote',
    query: { kind: 'price' },
  }), /pair|direction/i);
});

test('quote payload may omit pair and direction only for supported-pair discovery', () => {
  const result = normalizePayload({
    mode: 'quote',
    query: { kind: 'supported_pairs' },
  });
  assert.equal(result.query.kind, 'supported_pairs');
});

test('rejects amount_in that exceeds supported asset precision', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: {
      amount_in: '0.0000000001',
      pay_txid: 'a'.repeat(64),
      payer_globalmetaid: 'gmid',
      payout_address: 'dest',
      refund_address: 'refund',
    },
  }), /precision/i);
});

test('rejects unsupported pairs and assets', () => {
  assert.throws(() => normalizePayload({
    mode: 'quote',
    service: { pair: 'ABC/SPACE', direction: 'abc_to_space' },
    order: { amount_in: '1' },
  }), /pair|asset/i);
});

test('rejects missing or invalid mode', () => {
  assert.throws(() => normalizePayload({
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '1' },
  }), /mode/i);
  assert.throws(() => normalizePayload({
    mode: 'estimate',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '1' },
  }), /mode/i);
});

test('payment verification rejects when normalized base units do not match exactly', async () => {
  await assert.rejects(
    () => verifyPaymentProof({
      expectedBaseUnits: '10000',
      paidBaseUnits: '9999',
      expectedReceivingAddress: 'bot-btc-address',
      txOutputs: [{ address: 'bot-btc-address', baseUnits: '10000' }],
      expectedChain: 'btc',
      txSourceResult: { chain: 'btc' },
    }),
    /amount/i
  );
});

test('payment proof rejects txs that are missing, on the wrong chain, or absent from the tx source', async () => {
  await assert.rejects(() => verifyPaymentProof({
    expectedBaseUnits: '10000',
    paidBaseUnits: '10000',
    expectedReceivingAddress: 'bot-btc-address',
    txOutputs: [{ address: 'bot-btc-address', baseUnits: '10000' }],
    expectedChain: 'btc',
    txSourceResult: null,
  }), /discoverable|chain/i);
  await assert.rejects(() => verifyPaymentProof({
    expectedBaseUnits: '10000',
    paidBaseUnits: '10000',
    expectedReceivingAddress: 'bot-btc-address',
    txOutputs: [{ address: 'bot-btc-address', baseUnits: '10000' }],
    expectedChain: 'btc',
    txSourceResult: { chain: 'doge' },
  }), /discoverable|chain/i);
});

test('payment proof sums outputs to the bot receiving address and rejects mismatched totals', async () => {
  await assert.rejects(() => verifyPaymentProof({
    expectedReceivingAddress: 'bot-btc-address',
    expectedBaseUnits: '15000',
    paidBaseUnits: '15000',
    expectedChain: 'btc',
    txSourceResult: { chain: 'btc' },
    txOutputs: [
      { address: 'bot-btc-address', baseUnits: '5000' },
      { address: 'other', baseUnits: '5000' },
    ],
  }), /receiving address|amount/i);
});

test('payment proof rejects matching-address outputs with missing or invalid baseUnits', async () => {
  await assert.rejects(() => verifyPaymentProof({
    expectedReceivingAddress: 'bot-btc-address',
    expectedBaseUnits: '10000',
    paidBaseUnits: '10000',
    expectedChain: 'btc',
    txSourceResult: { chain: 'btc' },
    txOutputs: [
      { address: 'bot-btc-address' },
    ],
  }), /base units|amount|output/i);
  await assert.rejects(() => verifyPaymentProof({
    expectedReceivingAddress: 'bot-btc-address',
    expectedBaseUnits: '10000',
    paidBaseUnits: '10000',
    expectedChain: 'btc',
    txSourceResult: { chain: 'btc' },
    txOutputs: [
      { address: 'bot-btc-address', baseUnits: 'not-a-number' },
    ],
  }), /base units|amount|output/i);
});

test('duplicate execute for the same pay_txid returns the recorded terminal outcome', async () => {
  const state = createInMemoryTerminalState();
  await recordTerminalOutcome(state, 'txid-1', { mode: 'executed' });
  await recordTerminalOutcome(state, 'txid-1', { mode: 'refund_required' });
  const result = await getTerminalOutcome(state, 'txid-1');
  assert.equal(result.mode, 'executed');
});

test('execution lifecycle records pending_payment_proof, validated, and executed canonical states in order', async () => {
  const trace = createLifecycleTrace();
  await trace.mark('pending_payment_proof');
  await trace.mark('validated');
  await trace.mark('executed');
  assert.deepEqual(trace.states, ['pending_payment_proof', 'validated', 'executed']);
});

test('execution lifecycle rejects invalid states', async () => {
  const trace = createLifecycleTrace();
  await assert.rejects(() => trace.mark('not_a_real_state'), /invalid lifecycle/i);
});

test('late payment after tx lookup void resolves to refund_required rather than delayed execute', async () => {
  const result = classifyLatePayment({ previousOutcome: 'void', txFoundLater: true });
  assert.equal(result, 'refund_required');
});

test('missing tx lookup retries once after ~5 seconds and then returns void when still unresolved', async () => {
  const failingSourceTwice = async () => null;
  const sleepCalls = [];
  const fakeSleep = async (ms) => {
    sleepCalls.push(ms);
  };
  const result = await verifyWithRetry(
    { txid: 'a'.repeat(64), retryDelayMs: 5000, sleep: fakeSleep },
    failingSourceTwice
  );
  assert.equal(result.mode, 'void');
  assert.equal(result.lookupAttempts, 2);
  assert.deepEqual(sleepCalls, [5000]);
});

test('buildIdempotencyKey uses serviceOrderPinId when present', () => {
  const key = buildIdempotencyKey({
    serviceOrderPinId: 'pin-123',
    payTxid: 'txid-1',
    pair: 'BTC/SPACE',
    direction: 'btc_to_space',
    payerGlobalmetaid: 'gmid',
  });
  assert.equal(key, 'pin-123:txid-1');
});

test('buildIdempotencyKey falls back to payTxid + pair + direction + payerGlobalmetaid', () => {
  const key = buildIdempotencyKey({
    payTxid: 'txid-2',
    pair: 'BTC/SPACE',
    direction: 'btc_to_space',
    payerGlobalmetaid: 'gmid',
  });
  assert.equal(key, 'txid-2:BTC/SPACE:btc_to_space:gmid');
});

test('buildIdempotencyKey rejects missing required fields', () => {
  assert.throws(() => buildIdempotencyKey({ payTxid: 'txid-3' }), /required/i);
});

test('quote flow can list supported pairs with latest bid/ask snapshots', async () => {
  const { deps } = createExecutionDeps();
  const result = await handleMmRequest({
    mode: 'quote',
    query: { kind: 'supported_pairs' },
  }, deps);
  assert.equal(result.mode, 'quoted');
  assert.ok(result.supportedPairs.find((entry) => entry.pair === 'BTC/SPACE'));
  assert.ok(result.supportedPairs.find((entry) => entry.pair === 'DOGE/SPACE'));
  for (const entry of result.supportedPairs) {
    assert.ok(entry.bid);
    assert.ok(entry.ask);
  }
});

test('quote flow uses bid for BTC -> SPACE and ask for SPACE -> BTC, with latest-price settlement warning', async () => {
  const { deps } = createExecutionDeps();
  const btcToSpace = await handleMmRequest({
    mode: 'quote',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '0.1' },
  }, deps);
  const spaceToBtc = await handleMmRequest({
    mode: 'quote',
    service: { pair: 'BTC/SPACE', direction: 'space_to_btc' },
    order: { amount_in: '100' },
  }, deps);
  assert.equal(btcToSpace.quote.side, 'bid');
  assert.equal(spaceToBtc.quote.side, 'ask');
  assert.match(btcToSpace.message, /latest price/i);
});

test('execute flow uses bid for BTC -> SPACE settlement and ask for SPACE -> BTC settlement', async () => {
  const { deps, payoutCalls } = createExecutionDeps();
  const sellBase = await handleMmRequest(buildExecutePayload({
    payTxid: 'b'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
    payoutAddress: 'space-payout-1',
    refundAddress: 'btc-refund-1',
  }), deps);
  const buyBase = await handleMmRequest(buildExecutePayload({
    payTxid: 'c'.repeat(64),
    direction: 'space_to_btc',
    amountIn: '100',
    payoutAddress: 'btc-payout-1',
    refundAddress: 'space-refund-1',
  }), deps);
  assert.equal(sellBase.mode, 'executed');
  assert.equal(buyBase.mode, 'executed');
  assert.deepEqual(sellBase.lifecycle, ['pending_payment_proof', 'validated', 'executed']);
  assert.equal(payoutCalls[0].pricingSide, 'bid');
  assert.equal(payoutCalls[1].pricingSide, 'ask');
});

test('insufficient inventory triggers refund transfer instead of partial fill', async () => {
  const { deps, refundCalls, payoutCalls } = createExecutionDeps({
    balanceByAsset: { SPACE: '10' },
  });
  const result = await handleMmRequest(buildExecutePayload({
    payTxid: 'd'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
  }), deps);
  assert.equal(result.mode, 'refunded');
  assert.deepEqual(result.lifecycle, ['pending_payment_proof', 'validated', 'refund_required', 'refunded']);
  assert.equal(refundCalls.length, 1);
  assert.equal(payoutCalls.length, 0);
});

test('execute flow refunds when amount_in is outside configured min/max trade limits', async () => {
  const { deps, refundCalls } = createExecutionDeps();
  const result = await handleMmRequest(buildExecutePayload({
    payTxid: 'e'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.00001',
  }), deps);
  assert.equal(result.mode, 'refunded');
  assert.equal(refundCalls.length, 1);
  assert.match(result.message, /minimum|maximum/i);
});

test('direct market ignores quote snapshot while quote-confirm enforces slippage_bps', async () => {
  const { deps } = createExecutionDeps();
  const market = await handleMmRequest(buildExecutePayload({
    payTxid: 'f'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
    quoteContext: { has_prior_quote: false },
  }), deps);
  const quoted = await handleMmRequest(buildExecutePayload({
    payTxid: '1'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
    quoteContext: {
      has_prior_quote: true,
      slippage_bps: 100,
      quoted_output: '120',
      quoted_at: '2026-03-28T12:00:00Z',
    },
  }), deps);
  assert.equal(market.mode, 'executed');
  assert.equal(quoted.mode, 'refunded');
});

test('amount mismatch refund message says payer bore the refund fee', async () => {
  const { deps } = createExecutionDeps({ paymentMismatch: true });
  const result = await handleMmRequest(buildExecutePayload({
    payTxid: '2'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
  }), deps);
  assert.equal(result.mode, 'refunded');
  assert.match(result.message, /payer|Bot A|refund fee/i);
});

test('inventory shortage refund message says maker absorbed the refund fee', async () => {
  const { deps } = createExecutionDeps({
    balanceByAsset: { SPACE: '10' },
  });
  const result = await handleMmRequest(buildExecutePayload({
    payTxid: '3'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
  }), deps);
  assert.equal(result.mode, 'refunded');
  assert.match(result.message, /Bot B|maker|refund fee/i);
});

test('amount mismatch refund returns principal net of payer-borne refund fee', async () => {
  const { deps, refundCalls } = createExecutionDeps({ paymentMismatch: true });
  const result = await handleMmRequest(buildExecutePayload({
    payTxid: '4'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
  }), deps);
  assert.equal(result.mode, 'refunded');
  assert.equal(refundCalls[0].feeBearer, 'payer');
  assert.equal(refundCalls[0].refundAmountMode, 'net_of_fee');
});

test('inventory shortage refund targets full principal with maker-borne refund fee policy', async () => {
  const { deps, refundCalls } = createExecutionDeps({
    balanceByAsset: { SPACE: '10' },
  });
  const result = await handleMmRequest(buildExecutePayload({
    payTxid: '5'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
  }), deps);
  assert.equal(result.mode, 'refunded');
  assert.equal(refundCalls[0].feeBearer, 'maker');
  assert.equal(refundCalls[0].refundAmountMode, 'full_principal');
});

test('payout transfer failure returns payout_failed outcome instead of silent success', async () => {
  const { deps } = createExecutionDeps({ payoutFailure: true });
  const result = await handleMmRequest(buildExecutePayload({
    payTxid: '6'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
  }), deps);
  assert.equal(result.mode, 'payout_failed');
  assert.match(result.message, /payout/i);
});

test('refund transfer failure returns refund_failed outcome with operator-visible detail', async () => {
  const { deps } = createExecutionDeps({
    paymentMismatch: true,
    refundFailure: true,
  });
  const result = await handleMmRequest(buildExecutePayload({
    payTxid: '7'.repeat(64),
    direction: 'btc_to_space',
    amountIn: '0.1',
  }), deps);
  assert.equal(result.mode, 'refund_failed');
  assert.match(result.message, /operator|manual/i);
});
