import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let assetService;
try {
  assetService = require('../dist-electron/services/metabotWalletAssetService.js');
} catch {
  assetService = null;
}

function createMetabotStoreStub(record) {
  return {
    getMetabotById(id) {
      if (id !== record.id) return null;
      return { ...record };
    },
  };
}

test('getMetabotWalletAssets returns native, mrc20, and mvc ft sections with display balances', async () => {
  assert.equal(
    typeof assetService?.getMetabotWalletAssets,
    'function',
    'getMetabotWalletAssets() should be exported',
  );

  const store = createMetabotStoreStub({
    id: 1,
    name: 'Trader',
    mvc_address: 'mvc-1',
    btc_address: 'btc-1',
    doge_address: 'doge-1',
    public_key: 'pub',
  });

  const result = await assetService.getMetabotWalletAssets(store, { metabotId: 1 }, {
    getNativeBalances: async () => ({
      btc: { address: 'btc-1', value: 0.12, unit: 'BTC' },
      doge: { address: 'doge-1', value: 2.5, unit: 'DOGE' },
      mvc: { address: 'mvc-1', value: 8.88, unit: 'SPACE' },
    }),
    listMrc20Assets: async () => [{
      symbol: 'MINE',
      tokenName: 'MINE',
      mrc20Id: 'mine-id',
      address: 'btc-1',
      decimal: 8,
      balance: {
        confirmed: '1.00000000',
        unconfirmed: '0.00000000',
        pendingIn: '0.50000000',
        pendingOut: '0.25000000',
      },
    }],
    listMvcFtAssets: async () => [{
      symbol: 'MC',
      tokenName: 'MC',
      genesis: 'mc-genesis',
      codeHash: 'mc-code',
      address: 'mvc-1',
      decimal: 8,
      balance: {
        confirmed: '9.50000000',
        unconfirmed: '0.25000000',
      },
    }],
  });

  assert.equal(result.metabotId, 1);
  assert.equal(result.nativeAssets.length, 3);

  // MRC20: UI-facing balances should be standard-unit strings (not raw atomic integers).
  assert.deepEqual(result.mrc20Assets[0].balance, {
    confirmed: '1.00000000',
    unconfirmed: '0.00000000',
    pendingIn: '0.50000000',
    pendingOut: '0.25000000',
    display: '1.25000000',
  });

  // MVC FT: display defaults to confirmed; both confirmed/unconfirmed are standard-unit strings.
  assert.deepEqual(result.mvcFtAssets[0].balance, {
    confirmed: '9.50000000',
    unconfirmed: '0.25000000',
    display: '9.75000000',
  });

  assert.equal(result.mrc20Assets[0].balance.display, '1.25000000');
  assert.equal(result.mvcFtAssets[0].balance.display, '9.75000000');
});

test('getMetabotWalletAssets treats token no-data responses as empty token sections instead of failing the modal', async () => {
  const store = createMetabotStoreStub({
    id: 1,
    name: 'Trader',
    mvc_address: 'mvc-1',
    btc_address: 'btc-1',
    doge_address: 'doge-1',
    public_key: 'pub',
  });

  const result = await assetService.getMetabotWalletAssets(store, { metabotId: 1 }, {
    getNativeBalances: async () => ({
      btc: { address: 'btc-1', value: 0.12, unit: 'BTC' },
      doge: { address: 'doge-1', value: 2.5, unit: 'DOGE' },
      mvc: { address: 'mvc-1', value: 8.88, unit: 'SPACE' },
    }),
    listMrc20Assets: async () => {
      throw new Error('rpc error: code = Unknown desc = msg:no data found.');
    },
    listMvcFtAssets: async () => {
      throw new Error('rpc error: code = Unknown desc = msg:no data found.');
    },
  });

  assert.equal(result.nativeAssets.length, 3);
  assert.deepEqual(result.mrc20Assets, []);
  assert.deepEqual(result.mvcFtAssets, []);
});

test('getMetabotWalletAssets treats upstream token RPC failures as empty token sections instead of failing native balances', async () => {
  const store = createMetabotStoreStub({
    id: 1,
    name: 'Trader',
    mvc_address: 'mvc-1',
    btc_address: 'btc-1',
    doge_address: 'doge-1',
    public_key: 'pub',
  });

  const result = await assetService.getMetabotWalletAssets(store, { metabotId: 1 }, {
    getNativeBalances: async () => ({
      btc: { address: 'btc-1', value: 0.12, unit: 'BTC' },
      doge: { address: 'doge-1', value: 2.5, unit: 'DOGE' },
      mvc: { address: 'mvc-1', value: 8.88, unit: 'SPACE' },
    }),
    listMrc20Assets: async () => {
      throw new Error('rpc error: code = Unknown desc = Higun request error');
    },
    listMvcFtAssets: async () => {
      throw new Error('fetch failed');
    },
  });

  assert.equal(result.nativeAssets.length, 3);
  assert.equal(result.nativeAssets[0].symbol, 'BTC');
  assert.deepEqual(result.mrc20Assets, []);
  assert.deepEqual(result.mvcFtAssets, []);
});
