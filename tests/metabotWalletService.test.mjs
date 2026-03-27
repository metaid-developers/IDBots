/**
 * MetaBot Wallet Service verification tests
 * 1. Deterministic: known mnemonic + path -> expected addresses/keys/metaid/globalmetaid
 * 2. Random: no args -> generates random mnemonic, non-mock values
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMetaBotWallet } = require('../dist-electron/services/metabotWalletService.js');

const LEGACY_BASE58_ADDRESS_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const DOGE_BASE58_ADDRESS_RE = /^D[1-9A-HJ-NP-Za-km-z]{25,34}$/;

const TEST_MNEMONIC = 'polar end mule shine canoe cake scout puzzle pigeon abstract sock gospel';
const TEST_PATH = "m/44'/10001'/0'/0/0";

const EXPECTED = {
  mvc_address: '1MFi1WM2NXnV3kjdLKaUw7Ad23LSvSD9fY',
  btc_address: '1MFi1WM2NXnV3kjdLKaUw7Ad23LSvSD9fY',
  doge_address: 'DRPoYmHffwgmakvE4ua3UsLDuB4kEBYukq',
  public_key: '03fb7c351e368d0e714790a536df849aa0367d2890882bcb817743783b109bae74',
  chat_public_key:
    '046911f36efaacc35dffccbff66f4aa3968fb473b8fb50348a339238a81c0c78a000851753ef0cd0f8a05ccb11b1f369e0625776bdc9477a25879ab938b5da7f98',
  metaid: 'c746eda65c50faf1bc5f6a4e147022e059906a60f04d55ff600e0c06b45d8444',
  globalmetaid: 'idq1mc4fynwqdluw8nfe7ylmnd6280uxuzzj5n6q9z',
};

test('createMetaBotWallet: deterministic output for known mnemonic and path', async () => {
  const result = await createMetaBotWallet({
    path: TEST_PATH,
    mnemonic: TEST_MNEMONIC,
  });

  assert.equal(result.mnemonic, TEST_MNEMONIC, 'mnemonic');
  assert.equal(result.path, TEST_PATH, 'path');
  assert.equal(result.mvc_address, EXPECTED.mvc_address, 'mvc_address');
  assert.equal(result.btc_address, EXPECTED.btc_address, 'btc_address');
  assert.equal(result.doge_address, EXPECTED.doge_address, 'doge_address');
  assert.equal(result.public_key, EXPECTED.public_key, 'public_key');
  assert.equal(result.chat_public_key, EXPECTED.chat_public_key, 'chat_public_key');
  assert.equal(result.metaid, EXPECTED.metaid, 'metaid');
  assert.equal(result.globalmetaid, EXPECTED.globalmetaid, 'globalmetaid');
  assert.equal(result.chat_public_key_pin_id, '', 'chat_public_key_pin_id is empty');
});

test('createMetaBotWallet: no args generates random mnemonic and non-mock values', async () => {
  const result = await createMetaBotWallet();

  const words = result.mnemonic.trim().split(/\s+/);
  assert.ok(words.length >= 12, `mnemonic should have 12+ words, got ${words.length}`);

  assert.ok(!result.mvc_address.startsWith('mock_'), 'mvc_address should not be mock');
  assert.ok(!result.btc_address.startsWith('mock_'), 'btc_address should not be mock');
  assert.ok(!result.doge_address.startsWith('mock_'), 'doge_address should not be mock');
  assert.ok(!result.public_key.startsWith('mock_'), 'public_key should not be mock');
  assert.ok(!result.metaid.startsWith('mock_'), 'metaid should not be mock');
  assert.ok(result.globalmetaid.startsWith('idq'), 'globalmetaid should start with idq');

  assert.match(result.mvc_address, LEGACY_BASE58_ADDRESS_RE, 'mvc_address should be a valid legacy base58 address');
  assert.match(result.btc_address, LEGACY_BASE58_ADDRESS_RE, 'btc_address should be a valid legacy base58 address');
  assert.match(result.doge_address, DOGE_BASE58_ADDRESS_RE, 'doge_address should be a valid Doge base58 address');
  assert.equal(result.public_key.length, 66, 'public_key hex length (compressed)');
  assert.equal(result.chat_public_key.length, 130, 'chat_public_key hex length (uncompressed)');
  assert.equal(result.metaid.length, 64, 'metaid hex length');
});
