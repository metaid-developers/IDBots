import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  buildChunkedUploadMergeTxLocally,
} = await import('../dist-electron/libs/uploadLargeFileWorker.js');
const {
  normalizeChunkedUploadUtxos,
} = await import('../dist-electron/libs/uploadLargeFileFunding.js');

test('buildChunkedUploadMergeTxLocally preserves provider order and excludeOutpoints', () => {
  assert.equal(
    typeof buildChunkedUploadMergeTxLocally,
    'function',
    'buildChunkedUploadMergeTxLocally() should be exported',
  );

  const senderKey = new mvc.PrivateKey();
  const senderWif = senderKey.toWIF();
  const senderAddress = senderKey.toAddress('livenet').toString();

  const result = buildChunkedUploadMergeTxLocally({
    senderWif,
    address: senderAddress,
    feeRate: 1,
    chunkPreTxOutputAmount: 1000,
    indexPreTxOutputAmount: 1000,
    utxos: normalizeChunkedUploadUtxos(
      [
        { txid: 'a'.repeat(64), outIndex: 0, value: 2300, height: 12 },
        { txid: 'b'.repeat(64), outIndex: 1, value: 2400, height: -1 },
        { txid: 'c'.repeat(64), outIndex: 2, value: 100000, height: 99 },
      ],
      senderAddress,
    ),
    excludedOutpoints: new Set([`${'a'.repeat(64)}:0`]),
  });

  const tx = new mvc.Transaction(result.txHex);
  assert.equal(result.txId, tx.id);
  assert.deepEqual(result.spentOutpoints, [`${'b'.repeat(64)}:1`]);
  assert.equal(tx.inputs[0].prevTxId.toString('hex'), 'b'.repeat(64));
  assert.equal(tx.outputs[0].script.toAddress('livenet').toString(), senderAddress);
  assert.equal(tx.outputs[1].script.toAddress('livenet').toString(), senderAddress);
  assert.match(result.changeOutpoint || '', new RegExp(`^${result.txId}:\\d+$`));
});
