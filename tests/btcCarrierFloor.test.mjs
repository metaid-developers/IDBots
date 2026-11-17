/**
 * Inscription-carrier floor for every plain-BTC flow that is reachable without
 * a multisig PSBT — the UTXO list (btcApi.normalizeBtcUtxos) and the BTC send
 * path (transferService.executeTransfer chain='btc').
 *
 * Aligned with Metalet's shipped rule:
 *   e266b9c — never spend a <1000 sat UTXO as plain BTC (546-sat MRC20/Pin
 *             carriers);
 *   1b3f93a — the transfer floor sits exactly at 1000 sats (999 refused,
 *             1000 allowed), superseding b31d645's earlier <=1000 form.
 *
 * Run with: pnpm run compile:electron && node --test tests/btcCarrierFloor.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import * as bitcoin from 'bitcoinjs-lib';
import { BtcWallet, CoinType, AddressType, SignType } from '@metalet/utxo-wallet-service';

// transferService imports Electron for `app.getAppPath()` (MVC worker path).
// The BTC branch under test never calls it, so stub the module like
// tests/walletTransferService.test.mjs does instead of requiring a binary.
const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => '/tmp', getAppPath: () => process.cwd() }, ipcMain: { handle() {} } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { fetchBtcUtxos } = await import('../dist-electron/main/libs/btcApi.js');
const { executeTransfer } = await import('../dist-electron/main/services/transferService.js');
Module._load = originalLoad;

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NETWORK = bitcoin.networks.bitcoin;
const BTC_ADDRESS = new BtcWallet({
  coinType: CoinType.MVC,
  addressType: AddressType.SameAsMvc,
  addressIndex: 0,
  network: 'livenet',
  mnemonic: MNEMONIC,
}).getAddress();

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

/** A funding transaction whose output 0 pays `value` sats back to the test wallet. */
function fakeFunding(value, seed) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, seed), 0);
  tx.addOutput(bitcoin.address.toOutputScript(BTC_ADDRESS, NETWORK), value);
  return { txid: tx.getId(), rawTx: tx.toHex() };
}

/**
 * Stub the whole provider surface for one fake chain state and record every
 * request, so "nothing was broadcast" is provable rather than assumed.
 */
function stubChain(utxos) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ href, method });
    if (href.includes('/wallet-api/v3/address/btc-utxo')) {
      return jsonResponse({
        code: 0,
        data: utxos.map((utxo) => ({
          txId: utxo.txid,
          outputIndex: utxo.vout,
          satoshis: utxo.satoshis,
          address: BTC_ADDRESS,
          confirmed: utxo.confirmed !== false,
        })),
      });
    }
    if (href.includes('/wallet-api/v3/tx/raw')) {
      const txId = new URL(href).searchParams.get('txId');
      const found = utxos.find((utxo) => utxo.txid === txId);
      if (!found) throw new Error(`unknown raw tx ${txId}`);
      return jsonResponse({ code: 0, data: { rawTx: found.rawTx } });
    }
    if (href.includes('/wallet-api/v3/tx/broadcast')) {
      return jsonResponse({ code: 0, data: 'broadcast-txid' });
    }
    if (href.includes(`/api/address/${BTC_ADDRESS}/utxo`)) {
      return jsonResponse(utxos.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.satoshis,
        status: { confirmed: utxo.confirmed !== false },
      })));
    }
    throw new Error(`unexpected provider request: ${method} ${href}`);
  };
  return {
    calls,
    broadcasts: () => calls.filter((call) => call.method === 'POST' && call.href.includes('/tx/broadcast')),
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

const store = {
  getMetabotWalletByMetabotId: () => ({ mnemonic: MNEMONIC, path: "m/44'/10001'/0'/0/0" }),
};

function transfer(amountBtc, feeRate = 1) {
  return executeTransfer(store, {
    metabotId: 15,
    chain: 'btc',
    toAddress: BTC_ADDRESS,
    amountSpaceOrDoge: amountBtc,
    feeRate,
  });
}

// ---------------------------------------------------------------------------
// UTXO list: 999 / 1000 / 1001 (+ the old 546 / 600 carriers)
// ---------------------------------------------------------------------------

test('fetchBtcUtxos drops every sub-1000-sat carrier UTXO (Metalet e266b9c)', async () => {
  const scripted = [
    { satoshis: 546, seed: 1 },
    { satoshis: 600, seed: 2 },
    { satoshis: 999, seed: 3 },
    { satoshis: 1000, seed: 4 },
    { satoshis: 1001, seed: 5 },
  ].map(({ satoshis, seed }) => {
    const funding = fakeFunding(satoshis, seed);
    return { txid: funding.txid, vout: 0, satoshis, confirmed: true, rawTx: funding.rawTx };
  });
  const chain = stubChain(scripted);
  try {
    const utxos = await fetchBtcUtxos(BTC_ADDRESS, false);
    assert.deepEqual(
      utxos.map((utxo) => utxo.satoshis),
      [1000, 1001],
      '546 / 600 / 999 must never appear as spendable plain-BTC inputs',
    );
  } finally {
    chain.restore();
  }
});

test('the mempool fallback applies the same 1000-sat floor', async () => {
  const scripted = [
    { satoshis: 999, seed: 6 },
    { satoshis: 1000, seed: 7 },
  ].map(({ satoshis, seed }) => {
    const funding = fakeFunding(satoshis, seed);
    return { txid: funding.txid, vout: 0, satoshis, confirmed: true, rawTx: funding.rawTx };
  });
  const chain = stubChain(scripted);
  try {
    const utxos = await fetchBtcUtxos(BTC_ADDRESS, false, { preferMempool: true });
    assert.deepEqual(utxos.map((utxo) => utxo.satoshis), [1000]);
  } finally {
    chain.restore();
  }
});

// ---------------------------------------------------------------------------
// BTC send path: amount boundary 999 / 1000 / 1001
// ---------------------------------------------------------------------------

test('a BTC transfer of 999 sats is refused before anything is signed', async () => {
  const funding = fakeFunding(200_000, 11);
  const chain = stubChain([{ txid: funding.txid, vout: 0, satoshis: 200_000, confirmed: true, rawTx: funding.rawTx }]);
  try {
    const result = await transfer('0.00000999');
    assert.equal(result.success, false);
    assert.match(result.error, /1000 satoshis/);
    assert.equal(chain.broadcasts().length, 0, 'a refused transfer must not broadcast');
  } finally {
    chain.restore();
  }
});

test('a BTC transfer of exactly 1000 sats goes through (1b3f93a boundary)', async () => {
  const funding = fakeFunding(200_000, 12);
  const chain = stubChain([{ txid: funding.txid, vout: 0, satoshis: 200_000, confirmed: true, rawTx: funding.rawTx }]);
  try {
    const result = await transfer('0.00001');
    assert.equal(result.success, true, result.error);
    assert.equal(result.txId, 'broadcast-txid');
    assert.equal(chain.broadcasts().length, 1);
  } finally {
    chain.restore();
  }
});

test('a BTC transfer of 1001 sats goes through (1b3f93a boundary)', async () => {
  const funding = fakeFunding(200_000, 13);
  const chain = stubChain([{ txid: funding.txid, vout: 0, satoshis: 200_000, confirmed: true, rawTx: funding.rawTx }]);
  try {
    const result = await transfer('0.00001001');
    assert.equal(result.success, true, result.error);
    assert.equal(chain.broadcasts().length, 1);
  } finally {
    chain.restore();
  }
});

test('a change output below 1000 sats is refused instead of stranding funds', async () => {
  // 1-in / 2-out P2PKH at 1 sat/vB costs 226 sats of fee (measured on the SDK
  // this host ships): 1825 - 1000 - 226 = 599 sats of change, which the SDK
  // happily materialises but our own UTXO filter would never spend again.
  const funding = fakeFunding(1_825, 14);
  const chain = stubChain([{ txid: funding.txid, vout: 0, satoshis: 1_825, confirmed: true, rawTx: funding.rawTx }]);
  try {
    const result = await transfer('0.00001');
    assert.equal(result.success, false);
    const stranded = result.error.match(/output of (\d+) sats/);
    assert.ok(stranded, `the refusal must name the stranded output: ${result.error}`);
    assert.ok(Number(stranded[1]) >= 546 && Number(stranded[1]) < 1000, `expected a 546..999 sat change output, got ${stranded[1]}`);
    assert.match(result.error, /1000/);
    assert.equal(chain.broadcasts().length, 0, 'a stranded change output must stop the broadcast');
  } finally {
    chain.restore();
  }
});
