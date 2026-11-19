import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveCompiled(rel) {
  return require.resolve(`../dist-electron/main/${rel}`);
}

function loadCompiled(rel) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => '/tmp', getAppPath: () => process.cwd() } };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const path = resolveCompiled(rel);
    delete require.cache[path];
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

/**
 * Carrier-aware BTC balance snapshot: sub-1000-sat UTXOs (MRC20 / Pin
 * inscription carriers per btcSpendPolicy) must be reported separately so
 * the agent's spendable math stays honest — the send side refuses them as
 * inputs, and the raw total alone overstates what a transfer can move.
 */
test('btc snapshot splits carrier-locked sats out of the plain-spendable total', async () => {
  const { getWalletBalanceSnapshot } = loadCompiled('services/walletQueryService.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => ({
    ok: true,
    json: async () => {
      if (String(url).includes('btc-utxo')) {
        return {
          code: 0,
          data: {
            list: [
              { txid: 'aa', vout: 0, satoshis: 5000, confirmed: true },
              { txid: 'bb', vout: 1, satoshis: 546, confirmed: true },
              { txid: 'cc', vout: 0, satoshis: 300, confirmed: false },
              { txid: 'dd', vout: 0, satoshis: 1000, confirmed: true }, // boundary: NOT carrier
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  }));
  try {
    const snapshot = await getWalletBalanceSnapshot('btc', '1BtcAddr');
    assert.equal(snapshot.total_sats, 6846); // 5000 + 546 + 300 + 1000 (raw sum, unchanged semantics)
    assert.equal(snapshot.confirmed_sats, 6546);
    assert.equal(snapshot.unconfirmed_sats, 300);
    assert.equal(snapshot.utxo_count, 4);
    assert.equal(snapshot.carrier_locked_sats, 846); // 546 + 300 (sub-1000)
    assert.equal(snapshot.total_sats - snapshot.carrier_locked_sats, 6000); // plain-spendable
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mvc snapshot has no carrier dimension (MVC has no carrier policy)', async () => {
  const { getWalletBalanceSnapshot } = loadCompiled('services/walletQueryService.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: { list: [{ txid: 'ee', outIndex: 0, value: 1000, height: 976500 }] },
    }),
  }));
  try {
    const snapshot = await getWalletBalanceSnapshot('mvc', '1MvcAddr');
    assert.equal(snapshot.total_sats, 1000);
    assert.equal(snapshot.carrier_locked_sats, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
