import test from 'node:test';
import assert from 'node:assert/strict';

const {
  isRetryableChunkedUploadError,
  normalizeChunkedUploadUtxos,
  pickChunkedUploadFundingUtxos,
} = await import('../dist-electron/libs/uploadLargeFileFunding.js');

test('chunked upload funding preserves provider order and excluded outpoints', () => {
  const utxos = normalizeChunkedUploadUtxos(
    [
      { txid: 'a'.repeat(64), outIndex: 0, value: 1400, height: -1 },
      { txid: 'b'.repeat(64), outIndex: 1, value: 100000, height: 12 },
    ],
    'addr',
  );

  const picked = pickChunkedUploadFundingUtxos(
    utxos,
    1000,
    1,
    new Set(['a'.repeat(64) + ':0']),
  );

  assert.deepEqual(
    picked.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    [`${'b'.repeat(64)}:1`],
  );
});

test('chunked upload treats merge broadcast stale-input failures as retryable', () => {
  assert.equal(
    isRetryableChunkedUploadError('broadcast failed: failed to broadcast merge transaction: [-25]Missing inputs'),
    true,
  );
  assert.equal(
    isRetryableChunkedUploadError('broadcast failed: failed to broadcast merge transaction: 258: txn-mempool-conflict'),
    true,
  );
  assert.equal(
    isRetryableChunkedUploadError('chunked upload failed with insufficient fee'),
    false,
  );
});
