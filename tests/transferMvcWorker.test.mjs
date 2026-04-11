import test from 'node:test';
import assert from 'node:assert/strict';

const {
  ensureFreshMvcFundingCandidates,
  isRetryableMvcBroadcastError,
  pickUtxo,
} = await import('../dist-electron/libs/mvcSpend.js');

test('transfer MVC retries treat stale-input broadcast failures as retryable', () => {
  assert.equal(isRetryableMvcBroadcastError('[-25]Missing inputs'), true);
  assert.equal(isRetryableMvcBroadcastError('258: txn-mempool-conflict'), true);
  assert.equal(isRetryableMvcBroadcastError('txn-already-known'), false);
});

test('transfer MVC pickUtxo preserves provider order', () => {
  const picked = pickUtxo(
    [
      { txId: 'fresh-change', outputIndex: 2, satoshis: 1300, address: 'addr', height: -1 },
      { txId: 'stale-confirmed', outputIndex: 0, satoshis: 100000, address: 'addr', height: 99 },
    ],
    1000,
    1,
    78,
  );

  assert.deepEqual(
    picked.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    ['fresh-change:2'],
  );
});

test('transfer MVC pickUtxo skips excluded stale outpoints on retry', () => {
  const picked = pickUtxo(
    [
      { txId: 'stale-confirmed', outputIndex: 0, satoshis: 1300, address: 'addr', height: 99 },
      { txId: 'fresh-change', outputIndex: 2, satoshis: 1400, address: 'addr', height: -1 },
    ],
    1000,
    1,
    78,
    new Set(['stale-confirmed:0']),
  );

  assert.deepEqual(
    picked.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    ['fresh-change:2'],
  );
});

test('transfer MVC surfaces stale-provider exhaustion instead of misreporting balance when only excluded outpoints remain', () => {
  assert.throws(
    () => ensureFreshMvcFundingCandidates(
      [
        { txId: 'stale-a', outputIndex: 0, satoshis: 1300, address: 'addr', height: 100 },
        { txId: 'stale-b', outputIndex: 1, satoshis: 1400, address: 'addr', height: 101 },
      ],
      new Set(['stale-a:0', 'stale-b:1']),
    ),
    /MVC funding inputs are stale on the provider/,
  );
});
