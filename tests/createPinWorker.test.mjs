import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');
const {
  computeMvcTxidFromRawTx,
  isTxnAlreadyKnownError,
  isRetryableMvcBroadcastError,
  pickUtxo,
  resolveBroadcastTxResult,
} = await import('../dist-electron/libs/createPinWorker.js');

test('resolveBroadcastTxResult treats txn-already-known as success using the raw txid', () => {
  const rawTx = new mvc.Transaction().toString();
  const expectedTxid = new mvc.Transaction(rawTx).id;

  const txid = resolveBroadcastTxResult(rawTx, {
    code: -26,
    message: '[-26]257: txn-already-known',
  });

  assert.equal(txid, expectedTxid);
  assert.equal(computeMvcTxidFromRawTx(rawTx), expectedTxid);
  assert.equal(isTxnAlreadyKnownError('[-26]257: txn-already-known'), true);
});

test('resolveBroadcastTxResult preserves explicit txids on normal success', () => {
  const txid = resolveBroadcastTxResult('00', {
    code: 0,
    data: 'abc123',
  });

  assert.equal(txid, 'abc123');
});

test('isRetryableMvcBroadcastError detects stale-input broadcast failures', () => {
  assert.equal(isRetryableMvcBroadcastError('[-25]Missing inputs'), true);
  assert.equal(isRetryableMvcBroadcastError('bad-txns-inputs-missingorspent'), true);
  assert.equal(isRetryableMvcBroadcastError('258: txn-mempool-conflict'), true);
  assert.equal(isRetryableMvcBroadcastError('txn-already-known'), false);
  assert.equal(isRetryableMvcBroadcastError('MetaBot 余额不足'), false);
});

test('pickUtxo preserves provider order instead of preferring confirmed utxos', () => {
  const picked = pickUtxo(
    [
      { txId: 'new-change', outputIndex: 2, satoshis: 1200, address: 'addr', height: -1 },
      { txId: 'old-confirmed', outputIndex: 0, satoshis: 100000, address: 'addr', height: 123 },
    ],
    1,
    1,
    62,
  );

  assert.deepEqual(
    picked.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    ['new-change:2'],
  );
});

test('pickUtxo skips excluded outpoints on retryable retry attempts', () => {
  const picked = pickUtxo(
    [
      { txId: 'stale-confirmed', outputIndex: 0, satoshis: 1200, address: 'addr', height: 123 },
      { txId: 'fresh-change', outputIndex: 2, satoshis: 1400, address: 'addr', height: -1 },
    ],
    1,
    1,
    62,
    new Set(['stale-confirmed:0']),
  );

  assert.deepEqual(
    picked.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    ['fresh-change:2'],
  );
});
