import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  buildMvcTransferRawTxLocally,
  normalizeMvcWalletUtxos,
  normalizeMvcIncludeOutpoints,
} = await import('../dist-electron/main/libs/buildMvcTransferRawTxWorker.js');

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

test('normalizeMvcIncludeOutpoints validates, dedupes, and rejects exclude conflicts', () => {
  const entries = normalizeMvcIncludeOutpoints(
    [
      { txid: 'A'.repeat(64), vout: 0, satoshis: 1 },
      { txid: 'a'.repeat(64), vout: '0', satoshis: 1 }, // duplicate after normalize
      { txid: 'b'.repeat(64), vout: 2, satoshis: 546 },
    ],
    new Set(),
  );
  assert.deepEqual(entries, [
    { txid: 'a'.repeat(64), vout: 0, satoshis: 1 },
    { txid: 'b'.repeat(64), vout: 2, satoshis: 546 },
  ]);

  assert.throws(
    () => normalizeMvcIncludeOutpoints([{ txid: 'zz', vout: 0, satoshis: 1 }]),
    /64-hex txid/,
  );
  assert.throws(
    () => normalizeMvcIncludeOutpoints([{ txid: 'a'.repeat(64), vout: -1, satoshis: 1 }]),
    /integer vout/,
  );
  assert.throws(
    () => normalizeMvcIncludeOutpoints([{ txid: 'a'.repeat(64), vout: 0, satoshis: 0 }]),
    /satoshis > 0/,
  );
  assert.throws(
    () => normalizeMvcIncludeOutpoints([{ txid: 'a'.repeat(64), vout: 0, satoshis: 1 }], new Set([`${'a'.repeat(64)}:0`])),
    /conflicts with exclude_outpoints/,
  );
  assert.deepEqual(normalizeMvcIncludeOutpoints(null), []);
});

test('buildMvcTransferRawTxLocally force-spends includeOutpoints as input 0 (MRC-721 pin transfer shape)', () => {
  const senderKey = new mvc.PrivateKey();
  const senderWif = senderKey.toWIF();
  const senderAddress = senderKey.toAddress('livenet').toString();
  const recipientAddress = new mvc.PrivateKey().toAddress('livenet').toString();
  const nftTxid = 'd'.repeat(64);

  // The 1-sat pin UTXO never appears in the funding list (>=600 filter) — it
  // arrives via includeOutpoints with its indexer-reported value.
  const result = buildMvcTransferRawTxLocally({
    senderWif,
    senderAddress,
    toAddress: recipientAddress,
    amountSats: 1,
    feeRate: 1,
    utxos: normalizeMvcWalletUtxos(
      [{ txid: 'c'.repeat(64), outIndex: 2, value: 100000, height: 99 }],
      senderAddress,
    ),
    includeOutpoints: [{ txid: nftTxid, vout: 0, satoshis: 1 }],
  });

  const tx = new mvc.Transaction(result.txHex);
  assert.equal(result.txId, tx.id);
  // Forced outpoint is the FIRST input; the indexer keys new ownership on it.
  assert.equal(tx.inputs[0].prevTxId.toString('hex'), nftTxid);
  assert.equal(tx.inputs[0].outputIndex, 0);
  // Funding input follows.
  assert.equal(tx.inputs[1].prevTxId.toString('hex'), 'c'.repeat(64));
  // Recipient receives the pin value at output 0.
  assert.equal(tx.outputs[0].satoshis, 1);
  assert.equal(tx.outputs[0].script.toAddress('livenet').toString(), recipientAddress);
  assert.ok(result.spentOutpoints.includes(`${nftTxid}:0`));
  assert.ok(result.spentOutpoints.includes(`${'c'.repeat(64)}:2`));
  assert.match(result.changeOutpoint || '', new RegExp(`^${result.txId}:\\d+$`));
});

test('buildMvcTransferRawTxLocally rejects include entries conflicting with excludeOutpoints', () => {
  const senderKey = new mvc.PrivateKey();
  const nftTxid = 'e'.repeat(64);
  assert.throws(
    () =>
      buildMvcTransferRawTxLocally({
        senderWif: senderKey.toWIF(),
        senderAddress: senderKey.toAddress('livenet').toString(),
        toAddress: new mvc.PrivateKey().toAddress('livenet').toString(),
        amountSats: 1,
        feeRate: 1,
        utxos: [],
        excludeOutpoints: new Set([`${nftTxid}:0`]),
        includeOutpoints: [{ txid: nftTxid, vout: 0, satoshis: 1 }],
      }),
    /conflicts with exclude_outpoints/,
  );
});
