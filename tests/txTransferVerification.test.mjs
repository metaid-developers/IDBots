import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  verifyTransferToRecipient,
} = require('../dist-electron/services/txTransferVerification.js');

function buildRawTxHex({ valueSats, scriptPubKeyHex }) {
  const valueBuffer = Buffer.alloc(8);
  valueBuffer.writeBigUInt64LE(BigInt(valueSats));
  const scriptLength = (scriptPubKeyHex.length / 2).toString(16).padStart(2, '0');

  return [
    '01000000',
    '01',
    '00'.repeat(32),
    '00000000',
    '00',
    'ffffffff',
    '01',
    valueBuffer.toString('hex'),
    scriptLength,
    scriptPubKeyHex,
    '00000000',
  ].join('');
}

test('verifyTransferToRecipient confirms full refund back to the buyer address', async () => {
  const recipientAddress = '1111111111111111111111111111111111';
  const rawRefundHex = buildRawTxHex({
    valueSats: 100000,
    scriptPubKeyHex: `76a914${'00'.repeat(20)}88ac`,
  });

  const result = await verifyTransferToRecipient({
    chain: 'mvc',
    txid: 'a'.repeat(64),
    recipientAddress,
    expectedAmountSats: 100000,
    fetchRawTxHex: async () => rawRefundHex,
  });

  assert.equal(result.valid, true);
});

test('verifyTransferToRecipient rejects under-refunds', async () => {
  const recipientAddress = '1111111111111111111111111111111111';
  const rawRefundHex = buildRawTxHex({
    valueSats: 99999,
    scriptPubKeyHex: `76a914${'00'.repeat(20)}88ac`,
  });

  const result = await verifyTransferToRecipient({
    chain: 'mvc',
    txid: 'b'.repeat(64),
    recipientAddress,
    expectedAmountSats: 100000,
    fetchRawTxHex: async () => rawRefundHex,
  });

  assert.equal(result.valid, false);
  assert.match(result.reason, /recipient_amount_mismatch/i);
});
