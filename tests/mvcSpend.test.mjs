import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  classifyMvcSpendError,
  computeMvcTxidFromRawTx,
  getUtxoOutpointKey,
  isRetryableMvcBroadcastError,
  pickUtxo,
  resolveBroadcastTxResult,
} = await import('../dist-electron/libs/mvcSpend.js');

test('pickUtxo preserves provider order and respects excluded outpoints', () => {
  const picked = pickUtxo(
    [
      { txId: 'retry-me', outputIndex: 1, satoshis: 1300, address: 'addr', height: 10 },
      { txId: 'fresh', outputIndex: 2, satoshis: 1400, address: 'addr', height: -1 },
    ],
    1000,
    1,
    78,
    new Set(['retry-me:1']),
  );

  assert.deepEqual(
    picked.map((utxo) => getUtxoOutpointKey(utxo)),
    ['fresh:2'],
  );
});

test('resolveBroadcastTxResult recovers txid for already-known mvc broadcasts', () => {
  const rawTx = new mvc.Transaction().toString();
  const txid = resolveBroadcastTxResult(rawTx, {
    code: -26,
    message: 'txn-already-known',
  });

  assert.equal(txid, computeMvcTxidFromRawTx(rawTx));
});

test('classifyMvcSpendError groups stale-input, balance, and network failures', () => {
  assert.deepEqual(classifyMvcSpendError(new Error('[-25]Missing inputs')), {
    category: 'stale_inputs',
    message: '[-25]Missing inputs',
    retryable: true,
  });
  assert.deepEqual(classifyMvcSpendError(new Error('Not enough balance')), {
    category: 'insufficient_balance',
    message: 'Not enough balance',
    retryable: false,
  });
  assert.deepEqual(classifyMvcSpendError(new Error('fetch failed')), {
    category: 'network',
    message: 'fetch failed',
    retryable: false,
  });
  assert.deepEqual(classifyMvcSpendError(new Error('weird failure')), {
    category: 'unknown',
    message: 'weird failure',
    retryable: false,
  });
});

test('isRetryableMvcBroadcastError continues to identify stale-input retries', () => {
  assert.equal(isRetryableMvcBroadcastError('[-25]Missing inputs'), true);
  assert.equal(isRetryableMvcBroadcastError('258: txn-mempool-conflict'), true);
  assert.equal(isRetryableMvcBroadcastError('txn-already-known'), false);
});
