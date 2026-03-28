import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 1) return null;
      return {
        id: 1,
        name: 'Trader',
        mvc_address: '1MvcAddress',
        btc_address: '1BtcAddress',
        doge_address: 'DogeAddress',
        public_key: 'pub-key',
      };
    },
    getMetabotWalletByMetabotId(id) {
      if (id !== 1) return null;
      return {
        mnemonic: 'test mnemonic',
        path: "m/44'/10001'/0'/0/0",
      };
    },
  };
}

async function startRpcServerForTest() {
  return startRpcServerForTestWithOverrides({});
}

async function startRpcServerForTestWithOverrides({ walletRawTxService = null } = {}) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath() {
            return os.tmpdir();
          },
          getAppPath() {
            return process.cwd();
          },
        },
      };
    }
    if (request === './httpListenWithRetry' || request.endsWith('/httpListenWithRetry')) {
      return {
        listenWithRetry(server, _port, host, options = {}) {
          server.listen(0, host, () => {
            if (typeof options.onListening === 'function') options.onListening();
          });
        },
      };
    }
    if (walletRawTxService && (request === './walletRawTxService' || request.endsWith('/walletRawTxService'))) {
      return walletRawTxService;
    }
    return originalLoad(request, parent, isMain);
  };

  let startMetaidRpcServer;
  try {
    delete require.cache[require.resolve('../dist-electron/services/metaidRpcServer.js')];
    ({ startMetaidRpcServer } = require('../dist-electron/services/metaidRpcServer.js'));
  } finally {
    Module._load = originalLoad;
  }

  const server = startMetaidRpcServer(
    () => createMetabotStore(),
    () => ({
      getDatabase() {
        return {};
      },
      getSaveFunction() {
        return () => {};
      },
    }),
  );

  await new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    server.close();
    throw new Error('failed to resolve test server port');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

test('rpc routes expose account-summary, address-balance, and fee-rate-summary endpoints', async () => {
  const originalFetch = global.fetch;
  const { server, baseUrl } = await startRpcServerForTest();
  try {
    global.fetch = async (url, options) => {
      const href = String(url);
      if (href.startsWith(baseUrl)) {
        return originalFetch(url, options);
      }
      if (href.includes('/wallet-api/v4/mvc/address/balance-info')) {
        return jsonResponse({ code: 0, data: { confirmed: 123456789 } });
      }
      throw new Error(`unexpected fetch in route test: ${href}`);
    };

    const accountRes = await fetch(`${baseUrl}/api/idbots/metabot/account-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metabot_id: 1 }),
    });
    const balanceRes = await fetch(`${baseUrl}/api/idbots/address/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metabot_id: 1 }),
    });
    const feeRes = await fetch(`${baseUrl}/api/idbots/fee-rate-summary?chain=mvc`);

    const accountJson = await accountRes.json();
    const balanceJson = await balanceRes.json();
    const feeJson = await feeRes.json();

    assert.equal(accountJson.success, true);
    assert.equal(accountJson.mvc_address, '1MvcAddress');
    assert.equal(balanceJson.success, true);
    assert.equal(balanceJson.balance.mvc.unit, 'SPACE');
    assert.equal(feeJson.success, true);
    assert.ok(Array.isArray(feeJson.list));
    assert.equal(typeof feeJson.defaultFeeRate, 'number');
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc raw-tx routes return success payloads from the wallet raw-tx service contract', async () => {
  const walletRawTxService = {
    async buildMvcTransferRawTx(_store, params) {
      assert.deepEqual(params, {
        metabotId: 1,
        toAddress: '1recipient',
        amountSats: 1000,
        feeRate: 1,
        excludeOutpoints: ['A'.repeat(64) + ':0'],
      });
      return {
        raw_tx: 'mvc-raw',
        txid: 'mvc-txid',
        output_index: 0,
        spent_outpoints: ['a'.repeat(64) + ':0'],
        change_outpoint: 'mvc-txid:1',
      };
    },
    async buildMvcFtTransferRawTx(_store, params) {
      assert.deepEqual(params, {
        metabotId: 1,
        token: {
          symbol: 'MC',
          tokenID: 'token-id',
          genesisHash: 'genesis',
          codeHash: 'code',
          decimal: 8,
        },
        toAddress: '1recipient',
        amount: '500000000',
        feeRate: 1,
        excludeOutpoints: ['B'.repeat(64) + ':1'],
        fundingRawTx: 'mvc-funding-raw',
        fundingOutpoint: 'c'.repeat(64) + ':2',
      });
      return {
        raw_tx: 'ft-raw',
        output_index: 0,
        amount_check_raw_tx: 'amount-check-raw',
        spent_outpoints: ['b'.repeat(64) + ':1'],
        change_outpoint: 'ft-txid:1',
      };
    },
  };

  const { server, baseUrl } = await startRpcServerForTestWithOverrides({ walletRawTxService });
  try {
    const mvcRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc/build-transfer-rawtx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        to_address: '1recipient',
        amount_sats: 1000,
        fee_rate: 1,
        exclude_outpoints: ['A'.repeat(64) + ':0'],
      }),
    });
    const ftRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc-ft/build-transfer-rawtx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        token: {
          symbol: 'MC',
          tokenID: 'token-id',
          genesisHash: 'genesis',
          codeHash: 'code',
          decimal: 8,
        },
        to_address: '1recipient',
        amount: '500000000',
        fee_rate: 1,
        exclude_outpoints: ['B'.repeat(64) + ':1'],
        funding_raw_tx: 'mvc-funding-raw',
        funding_outpoint: 'c'.repeat(64) + ':2',
      }),
    });

    const mvcJson = await mvcRes.json();
    const ftJson = await ftRes.json();

    assert.equal(mvcJson.success, true);
    assert.equal(mvcJson.raw_tx, 'mvc-raw');
    assert.deepEqual(mvcJson.spent_outpoints, ['a'.repeat(64) + ':0']);
    assert.equal(ftJson.success, true);
    assert.equal(ftJson.amount_check_raw_tx, 'amount-check-raw');
    assert.deepEqual(ftJson.spent_outpoints, ['b'.repeat(64) + ':1']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc raw-tx routes reject invalid JSON bodies and surface service failures as 400 responses', async () => {
  const walletRawTxService = {
    async buildMvcTransferRawTx() {
      throw new Error('worker failed');
    },
    async buildMvcFtTransferRawTx() {
      throw new Error('worker failed');
    },
  };

  const { server, baseUrl } = await startRpcServerForTestWithOverrides({ walletRawTxService });
  try {
    const invalidJsonRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc/build-transfer-rawtx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const workerErrorRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc-ft/build-transfer-rawtx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        token: {
          symbol: 'MC',
          tokenID: 'token-id',
          genesisHash: 'genesis',
          codeHash: 'code',
          decimal: 8,
        },
        to_address: '1recipient',
        amount: '500000000',
        fee_rate: 1,
      }),
    });

    const invalidJson = await invalidJsonRes.json();
    const workerError = await workerErrorRes.json();

    assert.equal(invalidJson.success, false);
    assert.match(String(invalidJson.error || ''), /Invalid JSON body/i);
    assert.equal(workerError.success, false);
    assert.match(String(workerError.error || ''), /worker failed/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc raw-tx routes reject malformed input without exposing signer primitives', async () => {
  const { server, baseUrl } = await startRpcServerForTest();
  try {
    const mvcRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc/build-transfer-rawtx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        to_address: '1recipient',
        amount_sats: 0,
        fee_rate: 1,
      }),
    });
    const ftRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc-ft/build-transfer-rawtx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        token: { symbol: 'MC' },
        to_address: '1recipient',
        amount: '1',
        fee_rate: 1,
      }),
    });

    const mvcJson = await mvcRes.json();
    const ftJson = await ftRes.json();
    assert.equal(mvcJson.success, false);
    assert.match(String(mvcJson.error || ''), /amount_sats/i);
    assert.equal(ftJson.success, false);
    assert.match(String(ftJson.error || ''), /token/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc raw-tx bundle route forwards ordered steps to the wallet raw-tx service contract', async () => {
  const walletRawTxService = {
    async buildMvcOrderedRawTxBundle(_store, params) {
      assert.deepEqual(params, {
        metabotId: 1,
        steps: [
          {
            kind: 'mvc_transfer',
            toAddress: '1mvc-recipient',
            amountSats: 1000,
            feeRate: 1,
            excludeOutpoints: ['A'.repeat(64) + ':0'],
          },
          {
            kind: 'mvc_ft_transfer',
            token: {
              symbol: 'MC',
              tokenID: 'token-id',
              genesisHash: 'genesis',
              codeHash: 'code',
              decimal: 8,
            },
            toAddress: '1ft-recipient',
            amount: '500000000',
            feeRate: 1,
            funding: {
              stepIndex: 0,
              useOutput: 'change',
            },
          },
        ],
      });
      return {
        steps: [
          {
            index: 0,
            kind: 'mvc_transfer',
            raw_tx: 'mvc-raw',
            txid: 'mvc-txid',
            output_index: 0,
            spent_outpoints: ['a'.repeat(64) + ':0'],
            change_outpoint: 'mvc-txid:1',
          },
          {
            index: 1,
            kind: 'mvc_ft_transfer',
            raw_tx: 'ft-raw',
            output_index: 0,
            amount_check_raw_tx: 'amount-check-raw',
            spent_outpoints: ['b'.repeat(64) + ':1'],
            change_outpoint: 'ft-txid:1',
            resolved_funding_outpoint: 'mvc-txid:1',
          },
        ],
      };
    },
  };

  const { server, baseUrl } = await startRpcServerForTestWithOverrides({ walletRawTxService });
  try {
    const bundleRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc/build-rawtx-bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        steps: [
          {
            kind: 'mvc_transfer',
            to_address: '1mvc-recipient',
            amount_sats: 1000,
            fee_rate: 1,
            exclude_outpoints: ['A'.repeat(64) + ':0'],
          },
          {
            kind: 'mvc_ft_transfer',
            token: {
              symbol: 'MC',
              tokenID: 'token-id',
              genesisHash: 'genesis',
              codeHash: 'code',
              decimal: 8,
            },
            to_address: '1ft-recipient',
            amount: '500000000',
            fee_rate: 1,
            funding: {
              step_index: 0,
              use_output: 'change',
            },
          },
        ],
      }),
    });

    const bundleJson = await bundleRes.json();

    assert.equal(bundleJson.success, true);
    assert.equal(Array.isArray(bundleJson.steps), true);
    assert.equal(bundleJson.steps.length, 2);
    assert.equal(bundleJson.steps[0].change_outpoint, 'mvc-txid:1');
    assert.equal(bundleJson.steps[1].amount_check_raw_tx, 'amount-check-raw');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
