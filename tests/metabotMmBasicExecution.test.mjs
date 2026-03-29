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
