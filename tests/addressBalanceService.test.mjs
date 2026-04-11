import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let addressBalanceService;
try {
  addressBalanceService = require('../dist-electron/services/addressBalanceService.js');
} catch {
  addressBalanceService = null;
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

test('getAddressBalance falls back to mempool when Metalet btc-balance fails', async () => {
  assert.equal(
    typeof addressBalanceService?.getAddressBalance,
    'function',
    'getAddressBalance() should be exported',
  );

  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.includes('/wallet-api/v3/address/btc-balance')) {
      return jsonResponse({
        code: 1,
        message: 'rpc error: code = Unknown desc = Higun request error',
        data: null,
      });
    }

    if (href.includes('/api/address/test-btc-address/utxo')) {
      return jsonResponse([
        {
          txid: 'a'.repeat(64),
          vout: 0,
          value: 7278,
          status: {
            confirmed: true,
          },
        },
        {
          txid: 'b'.repeat(64),
          vout: 1,
          value: 600,
          status: {
            confirmed: false,
          },
        },
      ]);
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  };

  try {
    const balance = await addressBalanceService.getAddressBalance('btc', 'test-btc-address', { timeoutMs: 50 });

    assert.deepEqual(balance, {
      chain: 'btc',
      address: 'test-btc-address',
      satoshis: 7878,
      unit: 'BTC',
      value: 0.00007878,
    });

    assert.equal(
      calls.some((href) => href.includes('/wallet-api/v3/address/btc-balance')),
      true,
      'Metalet should be attempted before the fallback',
    );
    assert.equal(
      calls.some((href) => href.includes('/api/address/test-btc-address/utxo')),
      true,
      'mempool utxo summary should be used as the BTC balance fallback',
    );
  } finally {
    global.fetch = originalFetch;
  }
});
