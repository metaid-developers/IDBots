import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let accountService;
try {
  accountService = require('../dist-electron/services/metabotAccountService.js');
} catch {
  accountService = null;
}

function createMetabotStoreStub(record) {
  return {
    getMetabotById(id) {
      if (id !== record.id) return null;
      return { ...record };
    },
  };
}

test('getMetabotAccountSummary returns store-backed address fields without mnemonic or wif', () => {
  assert.equal(
    typeof accountService?.getMetabotAccountSummary,
    'function',
    'getMetabotAccountSummary() should be exported',
  );

  const store = createMetabotStoreStub({
    id: 1,
    name: 'Trader',
    mvc_address: 'mvc-addr',
    btc_address: 'btc-addr',
    doge_address: 'doge-addr',
    public_key: 'pub',
    mnemonic: 'should-not-leak',
    wif: 'should-not-leak',
  });

  const summary = accountService.getMetabotAccountSummary(store, 1);
  assert.deepEqual(summary, {
    metabot_id: 1,
    name: 'Trader',
    mvc_address: 'mvc-addr',
    btc_address: 'btc-addr',
    doge_address: 'doge-addr',
    public_key: 'pub',
  });
  assert.equal('mnemonic' in summary, false);
  assert.equal('wif' in summary, false);
});

test('getMetabotAccountSummary throws when metabot is missing', () => {
  assert.equal(
    typeof accountService?.getMetabotAccountSummary,
    'function',
    'getMetabotAccountSummary() should be exported',
  );

  const store = createMetabotStoreStub({
    id: 2,
    name: 'Other',
    mvc_address: 'mvc-addr',
    btc_address: 'btc-addr',
    doge_address: 'doge-addr',
    public_key: 'pub',
  });

  assert.throws(() => accountService.getMetabotAccountSummary(store, 1), /metabot.*not found/i);
});
