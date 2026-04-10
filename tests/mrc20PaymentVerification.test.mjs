import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyMrc20Payment } = require('../dist-electron/services/mrc20PaymentVerification.js');

const TXID = 'a'.repeat(64);
const RECIPIENT_ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

test('verifyMrc20Payment succeeds when txid exists under recipient mrc20 UTXOs and atomic amount is enough', async () => {
  const result = await verifyMrc20Payment({
    txid: TXID,
    recipientAddress: RECIPIENT_ADDRESS,
    mrc20Id: 'tick-metaid',
    mrc20Ticker: 'metaid',
    expectedAmountDisplay: '12.5',
  }, {
    fetchTokenInfo: async () => ({
      mrc20Id: 'tick-metaid',
      ticker: 'METAID',
      decimal: 8,
    }),
    fetchRecipientTokenUtxos: async () => ([
      {
        txId: TXID,
        mrc20s: [{ amount: '12.5' }],
      },
    ]),
  });

  assert.equal(result.valid, true);
  assert.equal(result.reason, 'verified');
  assert.equal(result.mrc20Ticker, 'METAID');
  assert.equal(result.mrc20Id, 'tick-metaid');
  assert.equal(result.matchedAmountAtomic, '1250000000');
  assert.equal(result.expectedAmountAtomic, '1250000000');
});

test('verifyMrc20Payment fails when ticker mismatches after uppercase normalization', async () => {
  const result = await verifyMrc20Payment({
    txid: TXID,
    recipientAddress: RECIPIENT_ADDRESS,
    mrc20Id: 'tick-metaid',
    mrc20Ticker: 'metaid',
    expectedAmountDisplay: '1',
  }, {
    fetchTokenInfo: async () => ({
      mrc20Id: 'tick-metaid',
      ticker: 'OTHER',
      decimal: 8,
    }),
    fetchRecipientTokenUtxos: async () => [],
  });

  assert.equal(result.valid, false);
  assert.match(result.reason, /ticker_mismatch/i);
});

test('verifyMrc20Payment fails when mrc20Id is not found', async () => {
  const result = await verifyMrc20Payment({
    txid: TXID,
    recipientAddress: RECIPIENT_ADDRESS,
    mrc20Id: 'wrong-id',
    mrc20Ticker: 'METAID',
    expectedAmountDisplay: '1',
  }, {
    fetchTokenInfo: async () => null,
    fetchRecipientTokenUtxos: async () => [],
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'mrc20_id_not_found');
});

test('verifyMrc20Payment fails when recipient BTC address is malformed', async () => {
  const result = await verifyMrc20Payment({
    txid: TXID,
    recipientAddress: 'not-a-btc-address',
    mrc20Id: 'tick-metaid',
    mrc20Ticker: 'METAID',
    expectedAmountDisplay: '1',
  }, {
    fetchTokenInfo: async () => {
      throw new Error('should not fetch token info for malformed address');
    },
    fetchRecipientTokenUtxos: async () => {
      throw new Error('should not fetch utxos for malformed address');
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_recipient_address');
});

test('verifyMrc20Payment reports non-observable recipient state when current mrc20 UTXOs no longer contain the reveal txid', async () => {
  const result = await verifyMrc20Payment({
    txid: TXID,
    recipientAddress: RECIPIENT_ADDRESS,
    mrc20Id: 'tick-metaid',
    mrc20Ticker: 'METAID',
    expectedAmountDisplay: '1',
  }, {
    fetchTokenInfo: async () => ({
      mrc20Id: 'tick-metaid',
      ticker: 'METAID',
      decimal: 8,
    }),
    fetchRecipientTokenUtxos: async () => ([
      { txId: 'b'.repeat(64), mrc20s: [{ amount: '100000000' }] },
    ]),
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'recipient_txid_not_observable');
});

test('verifyMrc20Payment fails when token atomic amount is insufficient', async () => {
  const result = await verifyMrc20Payment({
    txid: TXID,
    recipientAddress: RECIPIENT_ADDRESS,
    mrc20Id: 'tick-metaid',
    mrc20Ticker: 'METAID',
    expectedAmountDisplay: '12.5',
  }, {
    fetchTokenInfo: async () => ({
      mrc20Id: 'tick-metaid',
      ticker: 'METAID',
      decimal: 8,
    }),
    fetchRecipientTokenUtxos: async () => ([
      {
        txId: TXID,
        mrc20s: [{ amount: '12.49999999' }],
      },
    ]),
  });

  assert.equal(result.valid, false);
  assert.match(result.reason, /insufficient_token_amount/i);
  assert.equal(result.matchedAmountAtomic, '1249999999');
  assert.equal(result.expectedAmountAtomic, '1250000000');
});
