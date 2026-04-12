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

test('executeMrc20Transfer retries transient missing MRC20 token UTXOs before signing', async () => {
  assert.equal(
    typeof mrc20Service?.executeMrc20Transfer,
    'function',
    'executeMrc20Transfer() should be exported',
  );

  let tokenFetchAttempts = 0;
  const waits = [];

  const result = await mrc20Service.executeMrc20Transfer(createStore(), {
    metabotId: 1,
    asset: { mrc20Id: 'mine-id', decimal: 8, address: 'btc-address', symbol: 'MINE' },
    toAddress: 'btc-dest',
    amount: '1.5',
    feeRate: 12,
  }, {
    deriveWalletContext: async () => ({ wallet: { fake: true }, address: 'btc-address' }),
    fetchFundingUtxos: async () => [{ txId: 'funding', outputIndex: 0, satoshis: 100000, rawTx: 'funding-raw' }],
    fetchMrc20Utxos: async () => {
      tokenFetchAttempts += 1;
      if (tokenFetchAttempts === 1) {
        throw new Error('rpc error: code = Unknown desc = msg:no data found.');
      }
      return [{ txId: 'mrc', outputIndex: 1, rawTx: 'mrc-raw' }];
    },
    fetchMrc20Activities: async () => [],
    signTransfer: async () => ({
      commitTxHex: 'commit-hex',
      revealTxHex: 'reveal-hex',
      totalFeeSats: 1234,
    }),
    broadcastCommit: async () => 'commit-txid',
    broadcastReveal: async () => 'reveal-txid',
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(tokenFetchAttempts, 2);
  assert.deepEqual(waits, [750]);
  assert.equal(result.commitTxId, 'commit-txid');
  assert.equal(result.revealTxId, 'reveal-txid');
});

test('executeMrc20Transfer derives pending MRC20 token UTXOs from recent activities when provider misses them', async () => {
  assert.equal(
    typeof mrc20Service?.executeMrc20Transfer,
    'function',
    'executeMrc20Transfer() should be exported',
  );

  const waits = [];

  const result = await mrc20Service.executeMrc20Transfer(createStore(), {
    metabotId: 1,
    asset: { mrc20Id: 'mine-id', decimal: 8, address: 'btc-address', symbol: 'MINE' },
    toAddress: 'btc-dest',
    amount: '1.5',
    feeRate: 12,
  }, {
    deriveWalletContext: async () => ({ wallet: { fake: true }, address: 'btc-address' }),
    fetchFundingUtxos: async () => [{ txId: 'funding', outputIndex: 0, satoshis: 100000, rawTx: 'funding-raw' }],
    fetchMrc20Utxos: async () => {
      throw new Error('rpc error: code = Unknown desc = msg:no data found.');
    },
    fetchMrc20Activities: async () => [
      { txId: 'new-tx', from: 'btc-address', to: 'btc-address', amount: '0.01000000' },
      { txId: 'new-tx', from: 'btc-address', to: 'btc-address', amount: '49.99000000' },
      { txId: 'old-tx', from: 'btc-address', to: 'btc-address', amount: '50.00000000' },
    ],
    fetchTxHex: async (txId) => `${txId}-raw`,
    decodeTx: (rawTx) => {
      if (rawTx === 'new-tx-raw') {
        return {
          inputs: [{ txId: 'old-tx', outputIndex: 0 }],
          outputs: [
            { outputIndex: 0, satoshis: 546, address: 'btc-address' },
            { outputIndex: 1, satoshis: 546, address: 'btc-address' },
            { outputIndex: 2, satoshis: 1092, address: 'btc-address' },
          ],
        };
      }
      return {
        inputs: [],
        outputs: [
          { outputIndex: 0, satoshis: 546, address: 'btc-address' },
          { outputIndex: 1, satoshis: 546, address: 'btc-address' },
        ],
      };
    },
    signTransfer: async (params) => {
      assert.deepEqual(
        params.tokenUtxos.map((utxo) => [utxo.txId, utxo.outputIndex, utxo.mrc20s?.[0]?.amount]),
        [
          ['new-tx', 0, '0.01000000'],
          ['new-tx', 1, '49.99000000'],
        ],
      );
      return {
        commitTxHex: 'commit-hex',
        revealTxHex: 'reveal-hex',
        totalFeeSats: 1234,
      };
    },
    broadcastCommit: async () => 'commit-txid',
    broadcastReveal: async () => 'reveal-txid',
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  assert.deepEqual(waits, []);
  assert.equal(result.commitTxId, 'commit-txid');
  assert.equal(result.revealTxId, 'reveal-txid');
});

test('executeMrc20Transfer ignores negative provider token UTXOs and falls back to recent activities', async () => {
  assert.equal(
    typeof mrc20Service?.executeMrc20Transfer,
    'function',
    'executeMrc20Transfer() should be exported',
  );

  const result = await mrc20Service.executeMrc20Transfer(createStore(), {
    metabotId: 1,
    asset: { mrc20Id: 'negative-id', decimal: 8, address: 'negative-address', symbol: 'MINE' },
    toAddress: 'negative-address',
    amount: '0.01000000',
    feeRate: 12,
  }, {
    deriveWalletContext: async () => ({ wallet: { fake: true }, address: 'negative-address' }),
    fetchFundingUtxos: async () => [{ txId: 'funding', outputIndex: 0, satoshis: 100000, rawTx: 'funding-raw' }],
    fetchMrc20Utxos: async () => [{
      txId: 'provider-bad-tx',
      outputIndex: 0,
      satoshis: 546,
      address: 'negative-address',
      rawTx: 'provider-bad-raw',
      mrc20s: [{ amount: '-49.99000000' }],
    }],
    fetchMrc20Activities: async () => [
      { txId: 'activity-good-tx', from: 'negative-address', to: 'negative-address', amount: '50.00000000' },
    ],
    fetchTxHex: async () => 'activity-good-raw',
    decodeTx: (rawTx) => {
      if (rawTx === 'activity-good-raw') {
        return {
          inputs: [],
          outputs: [{ outputIndex: 0, satoshis: 546, address: 'negative-address' }],
        };
      }
      throw new Error(`unexpected raw tx: ${rawTx}`);
    },
    signTransfer: async (params) => {
      assert.deepEqual(
        params.tokenUtxos.map((utxo) => [utxo.txId, utxo.outputIndex, utxo.mrc20s?.[0]?.amount]),
        [['activity-good-tx', 0, '50.00000000']],
      );
      return {
        commitTxHex: 'commit-hex',
        revealTxHex: 'reveal-hex',
        totalFeeSats: 1234,
      };
    },
    broadcastCommit: async () => 'commit-txid',
    broadcastReveal: async () => 'reveal-txid',
    wait: async () => {},
  });

  assert.equal(result.commitTxId, 'commit-txid');
  assert.equal(result.revealTxId, 'reveal-txid');
});

test('executeMrc20Transfer reuses locally cached pending token UTXOs for the next transfer before the provider catches up', async () => {
  assert.equal(
    typeof mrc20Service?.executeMrc20Transfer,
    'function',
    'executeMrc20Transfer() should be exported',
  );

  let transferAttempt = 0;
  let providerFetches = 0;
  const cacheAddress = 'cache-address';
  const cacheAssetId = 'cache-id';

  const deps = {
    deriveWalletContext: async () => ({ wallet: { fake: true }, address: cacheAddress }),
    fetchFundingUtxos: async () => [{ txId: 'funding', outputIndex: 0, satoshis: 100000, rawTx: 'funding-raw' }],
    fetchMrc20Utxos: async () => {
      providerFetches += 1;
      if (providerFetches === 1) {
        return [{
          txId: 'old-token-tx',
          outputIndex: 0,
          satoshis: 546,
          address: cacheAddress,
          rawTx: 'old-token-raw',
          mrc20s: [{ amount: '50.00000000' }],
        }];
      }
      throw new Error('rpc error: code = Unknown desc = msg:no data found.');
    },
    fetchMrc20Activities: async () => [],
    fetchTxHex: async () => {
      throw new Error('should not fetch tx hex when local cache is available');
    },
    decodeTx: (rawTx) => {
      if (rawTx === 'commit-1-hex') {
        return {
          inputs: [{ txId: 'old-funding-tx', outputIndex: 0 }],
          outputs: [
            { outputIndex: 0, satoshis: 546, address: null },
            { outputIndex: 1, satoshis: 17000, address: cacheAddress },
          ],
        };
      }
      if (rawTx === 'reveal-1-hex') {
        return {
          inputs: [{ txId: 'old-token-tx', outputIndex: 0 }],
          outputs: [
            { outputIndex: 0, satoshis: 546, address: cacheAddress },
            { outputIndex: 1, satoshis: 546, address: cacheAddress },
            { outputIndex: 2, satoshis: 1092, address: cacheAddress },
          ],
        };
      }
      throw new Error(`unexpected raw tx: ${rawTx}`);
    },
    signTransfer: async (params) => {
      transferAttempt += 1;
      if (transferAttempt === 1) {
        assert.deepEqual(
          params.fundingUtxos.map((utxo) => [utxo.txId, utxo.outputIndex, utxo.satoshis]),
          [['funding', 0, 100000]],
        );
        assert.deepEqual(
          params.tokenUtxos.map((utxo) => [utxo.txId, utxo.outputIndex, utxo.mrc20s?.[0]?.amount]),
          [['old-token-tx', 0, '50.00000000']],
        );
        return {
          commitTxHex: 'commit-1-hex',
          revealTxHex: 'reveal-1-hex',
          totalFeeSats: 1234,
        };
      }

      assert.deepEqual(
        params.fundingUtxos.map((utxo) => [utxo.txId, utxo.outputIndex, utxo.satoshis]),
        [['commit-txid', 1, 17000]],
      );
      assert.deepEqual(
        params.tokenUtxos.map((utxo) => [utxo.txId, utxo.outputIndex, utxo.mrc20s?.[0]?.amount]),
        [
          ['reveal-1-txid', 0, '0.01000000'],
          ['reveal-1-txid', 1, '49.99000000'],
        ],
      );
      return {
        commitTxHex: 'commit-2-hex',
        revealTxHex: 'reveal-2-hex',
        totalFeeSats: 1234,
      };
    },
    broadcastCommit: async () => 'commit-txid',
    broadcastReveal: async (hex) => (hex === 'reveal-1-hex' ? 'reveal-1-txid' : 'reveal-2-txid'),
    wait: async () => {},
  };

  const first = await mrc20Service.executeMrc20Transfer(createStore(), {
    metabotId: 1,
    asset: { mrc20Id: cacheAssetId, decimal: 8, address: cacheAddress, symbol: 'MINE' },
    toAddress: cacheAddress,
    amount: '0.01000000',
    feeRate: 12,
  }, deps);

  const second = await mrc20Service.executeMrc20Transfer(createStore(), {
    metabotId: 1,
    asset: { mrc20Id: cacheAssetId, decimal: 8, address: cacheAddress, symbol: 'MINE' },
    toAddress: cacheAddress,
    amount: '0.01000000',
    feeRate: 12,
  }, deps);

  assert.equal(first.revealTxId, 'reveal-1-txid');
  assert.equal(second.revealTxId, 'reveal-2-txid');
});
