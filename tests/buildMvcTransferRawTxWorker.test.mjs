import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  buildMvcTransferRawTxLocally,
  normalizeMvcWalletUtxos,
} = await import('../dist-electron/libs/buildMvcTransferRawTxWorker.js');

test('normalizeMvcWalletUtxos preserves provider order and filters malformed entries', () => {
  assert.equal(
    typeof normalizeMvcWalletUtxos,
    'function',
    'normalizeMvcWalletUtxos() should be exported',
  );

  const normalized = normalizeMvcWalletUtxos(
    [
      { txId: 'a'.repeat(64), outputIndex: 0, satoshis: 1400, height: 21 },
      { txid: 'broken', outIndex: 1, value: 900, height: 1 },
      { txid: 'b'.repeat(64), outIndex: 2, value: 1600, height: -1 },
    ],
    '1sender',
  );

  assert.deepEqual(
    normalized.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    [`${'a'.repeat(64)}:0`, `${'b'.repeat(64)}:2`],
  );
});

test('buildMvcTransferRawTxLocally honors provider order and excludeOutpoints', () => {
  assert.equal(
    typeof buildMvcTransferRawTxLocally,
    'function',
    'buildMvcTransferRawTxLocally() should be exported',
  );

  const senderKey = new mvc.PrivateKey();
  const senderWif = senderKey.toWIF();
  const senderAddress = senderKey.toAddress('livenet').toString();
  const recipientAddress = new mvc.PrivateKey().toAddress('livenet').toString();

  const result = buildMvcTransferRawTxLocally({
    senderWif,
    senderAddress,
    toAddress: recipientAddress,
    amountSats: 1000,
    feeRate: 1,
    utxos: normalizeMvcWalletUtxos(
      [
        { txid: 'a'.repeat(64), outIndex: 0, value: 1300, height: 50 },
        { txid: 'b'.repeat(64), outIndex: 1, value: 2000, height: -1 },
        { txid: 'c'.repeat(64), outIndex: 2, value: 100000, height: 99 },
      ],
      senderAddress,
    ),
    excludeOutpoints: new Set([`${'a'.repeat(64)}:0`]),
  });

  const tx = new mvc.Transaction(result.txHex);
  assert.equal(result.txId, tx.id);
  assert.deepEqual(result.spentOutpoints, [`${'b'.repeat(64)}:1`]);
  assert.equal(tx.inputs[0].prevTxId.toString('hex'), 'b'.repeat(64));
  assert.equal(tx.inputs[0].outputIndex, 1);
  assert.equal(tx.outputs[0].script.toAddress('livenet').toString(), recipientAddress);
  assert.match(result.changeOutpoint || '', new RegExp(`^${result.txId}:\\d+$`));
});
