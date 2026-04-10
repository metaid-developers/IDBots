import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

const {
  deriveIdentity,
  normalizeGlobalMetaId
} = require('../../dist/core/identity/deriveIdentity.js');

const FIXTURE_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FIXTURE_PATH = "m/44'/10001'/0'/0/0";

const FIXTURE_IDENTITY = {
  mnemonic: FIXTURE_MNEMONIC,
  path: FIXTURE_PATH,
  publicKey: '0321e4ffeaea35361f12a676a7f48f24bc2b292fdb20d5980fafcc86bc3780370a',
  chatPublicKey: '04f6b1d713f8e4a00515996cd2e0fd1f00460c08aa17793bd39d53c15ef6b10531c2485f34c37189e85e7723c90598111a845f31871f3b1bf6d080e60f3e929773',
  mvcAddress: '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB',
  btcAddress: '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB',
  dogeAddress: 'D9UuD6sjdEUNv8hPC8WtUXZapBCsFn67jo',
  metaId: '1dde986762a582142fa908419eed375c76d683c0414ed67bb08cbea8c0fe2b4f',
  globalMetaId: 'idq1970463ym8fqmgawe4lylktne97ahhw4kqehkch'
};

test('deriveIdentity preserves the existing deterministic wallet identity semantics', async () => {
  const first = await deriveIdentity({
    mnemonic: FIXTURE_MNEMONIC,
    path: FIXTURE_PATH
  });

  const second = await deriveIdentity({
    mnemonic: FIXTURE_MNEMONIC,
    path: FIXTURE_PATH
  });

  assert.deepEqual(first, FIXTURE_IDENTITY);
  assert.deepEqual(second, FIXTURE_IDENTITY);
});

test('normalizeGlobalMetaId preserves the existing IDBots normalization contract', () => {
  assert.equal(
    normalizeGlobalMetaId(`  ${FIXTURE_IDENTITY.globalMetaId.toUpperCase()}  `),
    FIXTURE_IDENTITY.globalMetaId
  );
  assert.equal(normalizeGlobalMetaId(`metaid:${FIXTURE_IDENTITY.globalMetaId}`), null);
  assert.equal(normalizeGlobalMetaId('idb1970463ym8fqmgawe4lylktne97ahhw4kqehkch'), null);
});
