import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkOrderPaymentStatus,
  extractOrderTxid,
} = require('../dist-electron/services/orderPayment.js');

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 7) return null;
      return {
        mvc_address: 'mvc-seller-address',
        btc_address: 'btc-seller-address',
        doge_address: 'doge-seller-address',
      };
    },
  };
}

test('checkOrderPaymentStatus keeps native free-order behavior', async () => {
  const result = await checkOrderPaymentStatus({
    txid: null,
    plaintext: [
      '[ORDER] 帮我整理这段文本',
      '支付金额 0 SPACE',
    ].join('\n'),
    source: 'metaweb_private',
    metabotId: 7,
    metabotStore: createMetabotStore(),
  });

  assert.equal(result.paid, true);
  assert.equal(result.reason, 'free_order_no_payment_required');
  assert.equal(result.chain, 'mvc');
});

test('checkOrderPaymentStatus keeps native sub-sat orders free when rounded sats are zero', async () => {
  const result = await checkOrderPaymentStatus({
    txid: null,
    plaintext: [
      '[ORDER] 帮我整理这段文本',
      '支付金额 0.000000001 SPACE',
    ].join('\n'),
    source: 'metaweb_private',
    metabotId: 7,
    metabotStore: createMetabotStore(),
  });

  assert.equal(result.paid, true);
  assert.equal(result.reason, 'free_order_no_payment_required');
  assert.equal(result.chain, 'mvc');
  assert.equal(result.amountSats, 0);
});

test('extractOrderTxid accepts trailing annotations and ignores commit txid lines', () => {
  const revealTxid = 'a'.repeat(64);
  const commitTxid = 'b'.repeat(64);
  const plaintext = [
    '[ORDER] 帮我查询东京天气',
    `commit txid: ${commitTxid}`,
    `txid: ${revealTxid} (confirmed)`,
  ].join('\n');

  assert.equal(extractOrderTxid(plaintext), revealTxid);
});

test('checkOrderPaymentStatus routes MRC20 orders through dedicated verifier and returns settlement metadata', async () => {
  const txid = 'a'.repeat(64);
  const commitTxid = 'b'.repeat(64);
  const calls = [];

  const result = await checkOrderPaymentStatus({
    txid,
    plaintext: [
      '[ORDER] 帮我查询东京天气',
      '支付金额 12.5 METAID-MRC20',
      'payment chain: btc',
      'settlement kind: mrc20',
      'mrc20 ticker: METAID',
      'mrc20 id: tick-metaid',
      `commit txid: ${commitTxid}`,
      `txid: ${txid}`,
    ].join('\n'),
    source: 'metaweb_private',
    metabotId: 7,
    metabotStore: createMetabotStore(),
    verifyNativeTransferToRecipient: async () => {
      calls.push('native');
      return { valid: true, reason: 'verified', matchedAmountSats: 1 };
    },
    verifyMrc20Payment: async (input) => {
      calls.push({ type: 'mrc20', input });
      return {
        valid: true,
        reason: 'verified',
        matchedAmountAtomic: '1250000000',
        expectedAmountAtomic: '1250000000',
        currency: 'METAID-MRC20',
        amountDisplay: '12.5',
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'mrc20');
  assert.equal(calls[0].input.txid, txid);
  assert.equal(calls[0].input.mrc20Id, 'tick-metaid');
  assert.equal(calls[0].input.mrc20Ticker, 'METAID');
  assert.equal(calls[0].input.recipientAddress, 'btc-seller-address');
  assert.equal(calls[0].input.expectedAmountDisplay, '12.5');

  assert.equal(result.paid, true);
  assert.equal(result.reason, 'verified');
  assert.equal(result.settlementKind, 'mrc20');
  assert.equal(result.mrc20Ticker, 'METAID');
  assert.equal(result.mrc20Id, 'tick-metaid');
  assert.equal(result.paymentCommitTxid, commitTxid);
  assert.equal(result.currency, 'METAID-MRC20');
  assert.equal(result.amountDisplay, '12.5');
  assert.equal(result.amountAtomic, '1250000000');
});

test('checkOrderPaymentStatus treats non-observable MRC20 recipient state as paid but unverifiable', async () => {
  const txid = 'c'.repeat(64);

  const result = await checkOrderPaymentStatus({
    txid,
    plaintext: [
      '[ORDER] 帮我查询东京天气',
      '支付金额 12.5 METAID-MRC20',
      'payment chain: btc',
      'settlement kind: mrc20',
      'mrc20 ticker: METAID',
      'mrc20 id: tick-metaid',
      `txid: ${txid}`,
    ].join('\n'),
    source: 'metaweb_private',
    metabotId: 7,
    metabotStore: createMetabotStore(),
    verifyMrc20Payment: async () => ({
      valid: false,
      reason: 'recipient_txid_not_observable',
      currency: 'METAID-MRC20',
      amountDisplay: '12.5',
      matchedAmountAtomic: '0',
      expectedAmountAtomic: '1250000000',
    }),
  });

  assert.equal(result.paid, true);
  assert.equal(result.reason, 'unverified_state_gap: recipient_txid_not_observable');
  assert.equal(result.settlementKind, 'mrc20');
  assert.equal(result.currency, 'METAID-MRC20');
  assert.equal(result.amountDisplay, '12.5');
  assert.equal(result.amountAtomic, '0');
});
