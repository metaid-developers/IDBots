import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let mvcFtService;
try {
  mvcFtService = require('../dist-electron/services/mvcFtService.js');
} catch {
  mvcFtService = null;
}

function createStore() {
  return {
    getMetabotWalletByMetabotId(id) {
      if (id !== 1) return null;
      return {
        mnemonic: 'test mnemonic',
        path: "m/44'/10001'/0'/0/0",
      };
    },
  };
}

test('listMvcFtAssets maps Metalet MVC token balances into UI-ready FT assets', async () => {
  assert.equal(
    typeof mvcFtService?.listMvcFtAssets,
    'function',
    'listMvcFtAssets() should be exported',
  );

  const assets = await mvcFtService.listMvcFtAssets('mvc-address', {
    fetchBalanceList: async () => [{
      codeHash: 'code',
      genesis: 'genesis',
      symbol: 'MC',
      name: 'Meta Coin',
      decimal: 8,
      sensibleId: 'sid',
      icon: '/token.png',
      confirmedString: '900000000',
      unconfirmedString: '100000000',
    }],
  });

  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0], {
    kind: 'mvc-ft',
    chain: 'mvc',
    symbol: 'MC',
    tokenName: 'Meta Coin',
    genesis: 'genesis',
    codeHash: 'code',
    sensibleId: 'sid',
    address: 'mvc-address',
    decimal: 8,
    icon: 'https://www.metalet.space/wallet-api/token.png',
    balance: {
      confirmed: '9.00000000',
      unconfirmed: '1.00000000',
      display: '10.00000000',
    },
  });
});

test('listMvcFtAssets preserves decimal-string MVC token balances returned by the API', async () => {
  assert.equal(
    typeof mvcFtService?.listMvcFtAssets,
    'function',
    'listMvcFtAssets() should be exported',
  );

  const assets = await mvcFtService.listMvcFtAssets('mvc-address', {
    fetchBalanceList: async () => [{
      codeHash: 'code',
      genesis: 'genesis',
      symbol: 'MC',
      name: 'Meta Coin',
      decimal: 8,
      confirmedString: '9.5',
      unconfirmedString: '0.25',
    }],
  });

  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0].balance, {
    confirmed: '9.50000000',
    unconfirmed: '0.25000000',
    display: '9.75000000',
  });
});

test('executeMvcFtTransfer reuses walletRawTxService and broadcasts the returned raw tx', async () => {
  assert.equal(
    typeof mvcFtService?.executeMvcFtTransfer,
    'function',
    'executeMvcFtTransfer() should be exported',
  );

  const calls = [];
  const broadcasts = [];

  const result = await mvcFtService.executeMvcFtTransfer(createStore(), {
    metabotId: 1,
    asset: {
      symbol: 'MC',
      genesis: 'genesis',
      codeHash: 'code',
      decimal: 8,
      address: 'mvc-address',
    },
    toAddress: 'mvc-dest',
    amount: '1.25',
    feeRate: 1,
  }, {
    buildRawTx: async (_store, params) => {
      calls.push(params);
      return {
        raw_tx: 'ft-raw',
        txid: 'ft-txid',
        output_index: 0,
        amount_check_raw_tx: 'amount-check',
        spent_outpoints: [],
        change_outpoint: null,
      };
    },
    broadcastTx: async (rawTx) => {
      broadcasts.push(rawTx);
      return rawTx === 'amount-check' ? 'amount-check-txid' : 'broadcast-txid';
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    metabotId: 1,
    token: {
      symbol: 'MC',
      tokenID: 'genesis',
      genesisHash: 'genesis',
      codeHash: 'code',
      decimal: 8,
    },
    toAddress: 'mvc-dest',
    amount: '125000000',
    feeRate: 1,
  });
  assert.deepEqual(broadcasts, ['amount-check', 'ft-raw']);
  assert.equal(result.txId, 'broadcast-txid');
  assert.equal(result.rawTx, 'ft-raw');
  assert.equal(result.amountCheckTxId, 'amount-check-txid');
});
