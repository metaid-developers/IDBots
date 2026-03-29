import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let mrc20Service;
try {
  mrc20Service = require('../dist-electron/services/mrc20Service.js');
} catch {
  mrc20Service = null;
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

test('listMrc20Assets maps Metalet balances into UI-ready MRC20 assets', async () => {
  assert.equal(
    typeof mrc20Service?.listMrc20Assets,
    'function',
    'listMrc20Assets() should be exported',
  );

  const assets = await mrc20Service.listMrc20Assets('btc-address', {
    fetchBalanceList: async () => [{
      tick: 'MINE',
      mrc20Id: 'mine-id',
      decimals: '8',
      balance: '1',
      unsafeBalance: '0.2',
      pendingInBalance: '0.5',
      pendingOutBalance: '0.25',
      tokenName: 'Mine',
      metaData: '{"icon":"https://example.com/mine.png"}',
    }],
  });

  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0], {
    kind: 'mrc20',
    chain: 'btc',
    symbol: 'MINE',
    tokenName: 'Mine',
    mrc20Id: 'mine-id',
    address: 'btc-address',
    decimal: 8,
    icon: 'https://example.com/mine.png',
    balance: {
      confirmed: '1.00000000',
      unconfirmed: '0.20000000',
      pendingIn: '0.50000000',
      pendingOut: '0.25000000',
      display: '1.25000000',
    },
  });
});

test('executeMrc20Transfer broadcasts commit before reveal and returns both txids', async () => {
  assert.equal(
    typeof mrc20Service?.executeMrc20Transfer,
    'function',
    'executeMrc20Transfer() should be exported',
  );

  const calls = [];

  const result = await mrc20Service.executeMrc20Transfer(createStore(), {
    metabotId: 1,
    asset: { mrc20Id: 'mine-id', decimal: 8, address: 'btc-address', symbol: 'MINE' },
    toAddress: 'btc-dest',
    amount: '1.5',
    feeRate: 12,
  }, {
    deriveWalletContext: async () => ({ wallet: { fake: true }, address: 'btc-address' }),
    fetchFundingUtxos: async () => [{ txId: 'funding', outputIndex: 0, satoshis: 100000, rawTx: 'funding-raw' }],
    fetchMrc20Utxos: async () => [{ txId: 'mrc', outputIndex: 1, rawTx: 'mrc-raw' }],
    signTransfer: async (params) => {
      assert.equal(params.input.amount, '1.5');
      assert.equal(params.amountAtomic, '150000000');
      assert.equal(params.tokenUtxos[0].txId, 'mrc');
      return {
        commitTxHex: 'commit-hex',
        revealTxHex: 'reveal-hex',
        totalFeeSats: 1234,
      };
    },
    broadcastCommit: async (hex) => {
      calls.push(['commit', hex]);
      return 'commit-txid';
    },
    broadcastReveal: async (hex) => {
      calls.push(['reveal', hex]);
      return 'reveal-txid';
    },
  });

  assert.deepEqual(calls, [['commit', 'commit-hex'], ['reveal', 'reveal-hex']]);
  assert.equal(result.commitTxId, 'commit-txid');
  assert.equal(result.revealTxId, 'reveal-txid');
  assert.equal(result.totalFeeSats, 1234);
});
