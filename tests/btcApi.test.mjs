import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let btcApi;
try {
  btcApi = require('../dist-electron/libs/btcApi.js');
} catch {
  btcApi = null;
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

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

test('fetchBtcUtxos falls back to mempool when Metalet btc-utxo is unavailable', async () => {
  assert.equal(
    typeof btcApi?.fetchBtcUtxos,
    'function',
    'fetchBtcUtxos() should be exported',
  );

  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.includes('/wallet-api/v3/address/btc-utxo')) {
      return jsonResponse({
        code: 1,
        message: 'rpc error: code = Unknown desc = Higun request error',
        data: null,
      });
    }

    if (href.includes('/wallet-api/v3/tx/raw')) {
      return jsonResponse({
        code: 1,
        message: 'provider still unavailable',
        data: null,
      });
    }

    if (href.includes('/api/address/test-btc-address/utxo')) {
      return jsonResponse([
        {
          txid: 'a'.repeat(64),
          vout: 1,
          value: 1400,
          status: {
            confirmed: true,
          },
        },
        {
          txid: 'b'.repeat(64),
          vout: 0,
          value: 1600,
          status: {
            confirmed: false,
          },
        },
      ]);
    }

    if (href.includes(`/api/tx/${'a'.repeat(64)}/hex`)) {
      return textResponse('mempool-raw-a');
    }

    if (href.includes(`/api/tx/${'b'.repeat(64)}/hex`)) {
      return textResponse('mempool-raw-b');
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  };

  try {
    const utxos = await btcApi.fetchBtcUtxos('test-btc-address', true);

    assert.deepEqual(utxos, [
      {
        txId: 'a'.repeat(64),
        outputIndex: 1,
        satoshis: 1400,
        address: 'test-btc-address',
        confirmed: true,
        rawTx: 'mempool-raw-a',
      },
    ]);

    assert.equal(
      calls.some((href) => href.includes('/wallet-api/v3/address/btc-utxo')),
      true,
      'Metalet should still be attempted first',
    );
    assert.equal(
      calls.some((href) => href.includes('/api/address/test-btc-address/utxo')),
      true,
      'mempool fallback should be used after the provider fails',
    );
    assert.equal(
      calls.some((href) => href.includes(`/api/tx/${'a'.repeat(64)}/hex`)),
      true,
      'raw tx fallback should come from mempool when Metalet raw tx lookup fails',
    );
  } finally {
    global.fetch = originalFetch;
  }
});
