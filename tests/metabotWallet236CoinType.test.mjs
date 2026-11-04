import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Public throwaway BIP39 fixture (same one metabotWalletService.test.mjs uses);
// never a real wallet.
const FIXTURE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PATH_10001 = "m/44'/10001'/0'/0/0";
const PATH_236 = "m/44'/236'/0'/0/0";
// Ground truth derived via raw mvc-lib HD derivation (mvc-lib HDPrivateKey,
// livenet) — independently recomputed outside the service under test.
const EXPECTED_ADDR_10001 = '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB';
const EXPECTED_ADDR_236 = '1K6LZdwpKT5XkEZo2T2kW197aMXYbYMc4f';

test('getMvcWalletFromPath honors an explicit 236 coin segment', async () => {
  const { getMvcWalletFromPath } = require('../dist-electron/main/services/metabotWalletService.js');
  const wallet = await getMvcWalletFromPath(FIXTURE_MNEMONIC, PATH_236);
  assert.equal(wallet.getAddress(), EXPECTED_ADDR_236);
});

test('getMvcWalletFromPath keeps legacy 10001 derivation byte-for-byte', async () => {
  const { getMvcWalletFromPath, getMvcWallet } = require('../dist-electron/main/services/metabotWalletService.js');
  const viaPath = await getMvcWalletFromPath(FIXTURE_MNEMONIC, PATH_10001);
  const viaIndex = await getMvcWallet(FIXTURE_MNEMONIC, 0);
  assert.equal(viaPath.getAddress(), EXPECTED_ADDR_10001);
  assert.equal(viaIndex.getAddress(), EXPECTED_ADDR_10001);
});

test('createMetaBotWallet restores the 236 identity end-to-end (address + metaid + path)', async () => {
  const { createMetaBotWallet } = require('../dist-electron/main/services/metabotWalletService.js');
  const result = await createMetaBotWallet({ mnemonic: FIXTURE_MNEMONIC, path: PATH_236 });
  assert.equal(result.mvc_address, EXPECTED_ADDR_236);
  assert.equal(result.path, PATH_236);
  // metaid = sha256(mvc_address) — must match the 236 address, not the 10001 one
  const crypto = await import('node:crypto');
  assert.equal(
    result.metaid,
    crypto.createHash('sha256').update(EXPECTED_ADDR_236, 'utf8').digest('hex'),
  );
});

test('restore at 236 and pin signing derive the SAME key (createPinWorker coin resolution)', () => {
  const { resolveMvcDeriveCoinType } = require('../dist-electron/main/libs/createPinWorker.js');
  assert.equal(resolveMvcDeriveCoinType(PATH_236), 236);
  // every legacy shape must stay on 10001
  assert.equal(resolveMvcDeriveCoinType(PATH_10001), 10001);
  assert.equal(resolveMvcDeriveCoinType(undefined), 10001);
  assert.equal(resolveMvcDeriveCoinType(null), 10001);
  assert.equal(resolveMvcDeriveCoinType(''), 10001);
  assert.equal(resolveMvcDeriveCoinType("m/44'/10001'/0'/0/7"), 10001);
  assert.equal(resolveMvcDeriveCoinType("m/44'/236'/1'/0/0"), 10001); // non-account-0 shape → legacy
});

test('parseMvcCoinTypeFromPath only recognizes explicit 236 account-0 paths', () => {
  const { parseMvcCoinTypeFromPath } = require('../dist-electron/main/services/metabotWalletService.js');
  assert.equal(parseMvcCoinTypeFromPath(PATH_236), 236);
  assert.equal(parseMvcCoinTypeFromPath("m/44'/236'/0'/0/123"), 236);
  assert.equal(parseMvcCoinTypeFromPath(PATH_10001), null);
  assert.equal(parseMvcCoinTypeFromPath(undefined), null);
  assert.equal(parseMvcCoinTypeFromPath(null), null);
  assert.equal(parseMvcCoinTypeFromPath('garbage'), null);
});

test('private-key ECDH helper honors the 236 path (chat key = identity key)', async () => {
  const { getMvcWalletFromPath } = require('../dist-electron/main/services/metabotWalletService.js');
  const { mvc } = require('meta-contract');
  const wallet = await getMvcWalletFromPath(FIXTURE_MNEMONIC, PATH_236);
  const wallet10001 = await getMvcWalletFromPath(FIXTURE_MNEMONIC, PATH_10001);
  // the two identities must not share a private key or a public chat key
  assert.notEqual(wallet.getPrivateKey(), wallet10001.getPrivateKey());
  assert.notEqual(
    wallet.getPublicKey().toString('hex'),
    wallet10001.getPublicKey().toString('hex'),
  );
  // and the 236 public key must match raw mvc-lib derivation at 236
  const hdpk = mvc.Mnemonic.fromString(FIXTURE_MNEMONIC).toHDPrivateKey('', mvc.Networks.livenet);
  const rawPub = hdpk.deriveChild("m/44'/236'/0'/0/0").publicKey.toString('hex');
  assert.equal(wallet.getPublicKey().toString('hex'), rawPub);
});
