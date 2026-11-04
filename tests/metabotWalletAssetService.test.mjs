import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let assetService;
try {
  assetService = require('../dist-electron/main/services/metabotWalletAssetService.js');
} catch {
  assetService = null;
}

let mrc20Service;
try {
  mrc20Service = require('../dist-electron/main/services/mrc20Service.js');
} catch {
  mrc20Service = null;
}

let mvcFtService;
try {
  mvcFtService = require('../dist-electron/main/services/mvcFtService.js');
} catch {
  mvcFtService = null;
}

function createMetabotStoreStub(record) {
  return {
    getMetabotById(id) {
      if (id !== record.id) return null;
      return { ...record };
    },
  };
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return data;
    },
  };
}

function getHeaderValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
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
    listMvcNftAssets: async () => [],
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

test('getMetabotWalletAssets keeps item icon and imgUrl through the mvc nft bundle mapping', async () => {
  const store = createMetabotStoreStub({
    id: 1,
    name: 'Collector',
    mvc_address: 'mvc-1',
    btc_address: 'btc-1',
    doge_address: 'doge-1',
    public_key: 'pub',
  });

  const result = await assetService.getMetabotWalletAssets(store, { metabotId: 1 }, {
    getNativeBalances: async () => ({
      btc: { address: 'btc-1', value: 0, unit: 'BTC' },
      doge: { address: 'doge-1', value: 0, unit: 'DOGE' },
      mvc: { address: 'mvc-1', value: 1, unit: 'SPACE' },
    }),
    listMrc20Assets: async () => [],
    listMvcFtAssets: async () => [],
    listMvcNftAssets: async () => [{
      genesis: 'g-1',
      codeHash: 'ch-1',
      seriesName: 'MetaBot Avatar',
      tokenSupply: 10000,
      address: 'mvc-1',
      count: 1,
      items: [{
        tokenIndex: '2671',
        name: 'MetaBot #2671',
        satoshi: 1000,
        icon: 'metafile://icon-pin',
        imgUrl: 'https://metalet.space/art.png',
      }],
    }],
  });

  assert.equal(result.mvcNftAssets.length, 1);
  const item = result.mvcNftAssets[0].items[0];
  assert.equal(item.tokenIndex, '2671');
  assert.equal(item.icon, 'metafile://icon-pin');
  assert.equal(item.imgUrl, 'https://metalet.space/art.png', 'imgUrl must survive the bundle mapping so wallet tiles render https artwork first');
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
    listMvcNftAssets: async () => {
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
    listMvcNftAssets: async () => {
      throw new Error('fetch failed');
    },
  });

  assert.equal(result.nativeAssets.length, 3);
  assert.equal(result.nativeAssets[0].symbol, 'BTC');
  assert.deepEqual(result.mrc20Assets, []);
  assert.deepEqual(result.mvcFtAssets, []);
});

test('listMrc20Assets uses fresh requests for repeated token balance refreshes', async () => {
  assert.equal(
    typeof mrc20Service?.listMrc20Assets,
    'function',
    'listMrc20Assets() should be exported',
  );

  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });

    if (href.includes('/wallet-api/v3/mrc20/address/balance-list')) {
      return jsonResponse({
        code: 0,
        message: 'success',
        data: { list: [] },
      });
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  };

  try {
    await mrc20Service.listMrc20Assets('test-btc-address');
    await mrc20Service.listMrc20Assets('test-btc-address');

    assert.equal(calls.length, 2);

    const first = new URL(calls[0].href);
    const second = new URL(calls[1].href);
    assert.notEqual(
      first.searchParams.get('_fresh'),
      second.searchParams.get('_fresh'),
      'each manual token refresh should use a unique cache-buster',
    );
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(getHeaderValue(calls[0].init.headers, 'Cache-Control'), 'no-cache');
    assert.equal(getHeaderValue(calls[0].init.headers, 'Pragma'), 'no-cache');
  } finally {
    global.fetch = originalFetch;
  }
});

test('listMvcFtAssets uses fresh requests for repeated token balance refreshes', async () => {
  assert.equal(
    typeof mvcFtService?.listMvcFtAssets,
    'function',
    'listMvcFtAssets() should be exported',
  );

  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });

    if (href.includes('/wallet-api/v4/mvc/address/contract/ft/balance-list')) {
      return jsonResponse({
        code: 0,
        message: 'success',
        data: { list: [] },
      });
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  };

  try {
    await mvcFtService.listMvcFtAssets('test-mvc-address');
    await mvcFtService.listMvcFtAssets('test-mvc-address');

    assert.equal(calls.length, 2);

    const first = new URL(calls[0].href);
    const second = new URL(calls[1].href);
    assert.notEqual(
      first.searchParams.get('_fresh'),
      second.searchParams.get('_fresh'),
      'each manual token refresh should use a unique cache-buster',
    );
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(getHeaderValue(calls[0].init.headers, 'Cache-Control'), 'no-cache');
    assert.equal(getHeaderValue(calls[0].init.headers, 'Pragma'), 'no-cache');
  } finally {
    global.fetch = originalFetch;
  }
});
