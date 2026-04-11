import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');
const {
  computeMvcTxidFromRawTx,
  isTxnAlreadyKnownError,
  isRetryableMvcBroadcastError,
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
  assert.equal(isRetryableMvcBroadcastError('txn-already-known'), false);
  assert.equal(isRetryableMvcBroadcastError('MetaBot 余额不足'), false);
});
