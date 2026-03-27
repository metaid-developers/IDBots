import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bech32 } = require('bech32');
const bs58 = require('bs58');
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

function decodeBase58Payload(address) {
  const decoded = Buffer.from(bs58.decode(address));
  return decoded.subarray(0, decoded.length - 4);
}

function buildP2pkhScriptForBase58Address(address) {
  const payload = decodeBase58Payload(address);
  const hash160 = payload.subarray(1).toString('hex');
  return `76a914${hash160}88ac`;
}

function buildP2wpkhScriptForBech32Address(address) {
  const decoded = bech32.decode(address);
  const bytes = Buffer.from(bech32.fromWords(decoded.words.slice(1)));
  return `0014${bytes.toString('hex')}`;
}

function buildBech32Address(hashHex) {
  return bech32.encode('bc', [0, ...bech32.toWords(Buffer.from(hashHex, 'hex'))]);
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

test('verifyTransferToRecipient accepts BTC refunds sent to a legacy base58 address', async () => {
  const recipientAddress = '1MFi1WM2NXnV3kjdLKaUw7Ad23LSvSD9fY';
  const rawRefundHex = buildRawTxHex({
    valueSats: 210000,
    scriptPubKeyHex: buildP2pkhScriptForBase58Address(recipientAddress),
  });

  const result = await verifyTransferToRecipient({
    chain: 'btc',
    txid: 'c'.repeat(64),
    recipientAddress,
    expectedAmountSats: 210000,
    fetchRawTxHex: async () => rawRefundHex,
  });

  assert.equal(result.valid, true);
  assert.equal(result.matchedAmountSats, 210000);
});

test('verifyTransferToRecipient accepts BTC refunds sent to a bech32 address', async () => {
  const recipientAddress = buildBech32Address('11'.repeat(20));
  const rawRefundHex = buildRawTxHex({
    valueSats: 320000,
    scriptPubKeyHex: buildP2wpkhScriptForBech32Address(recipientAddress),
  });

  const result = await verifyTransferToRecipient({
    chain: 'btc',
    txid: 'd'.repeat(64),
    recipientAddress,
    expectedAmountSats: 320000,
    fetchRawTxHex: async () => rawRefundHex,
  });

  assert.equal(result.valid, true);
  assert.equal(result.matchedAmountSats, 320000);
});

test('verifyTransferToRecipient accepts DOGE refunds sent to a legacy base58 address', async () => {
  const recipientAddress = 'DRPoYmHffwgmakvE4ua3UsLDuB4kEBYukq';
  const rawRefundHex = buildRawTxHex({
    valueSats: 5_000_000,
    scriptPubKeyHex: buildP2pkhScriptForBase58Address(recipientAddress),
  });

  const result = await verifyTransferToRecipient({
    chain: 'doge',
    txid: 'e'.repeat(64),
    recipientAddress,
    expectedAmountSats: 5_000_000,
    fetchRawTxHex: async () => rawRefundHex,
  });

  assert.equal(result.valid, true);
  assert.equal(result.matchedAmountSats, 5_000_000);
});
