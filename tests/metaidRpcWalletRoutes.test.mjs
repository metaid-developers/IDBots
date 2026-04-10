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

async function startRpcServerForTestWithOverrides({
  walletRawTxService = null,
  transferService = null,
  utxoWalletService = null,
  mrc20Service = null,
} = {}) {
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
    if (utxoWalletService && request === '@metalet/utxo-wallet-service') {
      return utxoWalletService;
    }
    if (walletRawTxService && (request === './walletRawTxService' || request.endsWith('/walletRawTxService'))) {
      return walletRawTxService;
    }
    if (transferService && (request === './transferService' || request.endsWith('/transferService'))) {
      return transferService;
    }
    if (mrc20Service && (request === './mrc20Service' || request.endsWith('/mrc20Service'))) {
      return mrc20Service;
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

test('rpc transfer route forwards btc, doge, and space transfer requests through the same generic contract', async () => {
  const calls = [];
  const transferService = {
    async executeTransfer(_store, params) {
      calls.push(params);
      return { success: true, txId: `tx-${params.chain}` };
    },
  };

  const { server, baseUrl } = await startRpcServerForTestWithOverrides({ transferService });
  try {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/idbots/wallet/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metabot_id: 1,
          chain: 'btc',
          to_address: '1btc-recipient',
          amount: '0.001',
          fee_rate: 2,
        }),
      }),
      fetch(`${baseUrl}/api/idbots/wallet/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metabot_id: 1,
          chain: 'doge',
          to_address: 'DogeRecipient',
          amount: '1.25',
          fee_rate: 300000,
        }),
      }),
      fetch(`${baseUrl}/api/idbots/wallet/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metabot_id: 1,
          chain: 'space',
          to_address: '1space-recipient',
          amount: '0.5',
          fee_rate: 1,
        }),
      }),
    ]);

    const payloads = await Promise.all(responses.map((res) => res.json()));

    assert.equal(payloads[0].success, true);
    assert.equal(payloads[0].txid, 'tx-btc');
    assert.equal(payloads[1].success, true);
    assert.equal(payloads[1].txid, 'tx-doge');
    assert.equal(payloads[2].success, true);
    assert.equal(payloads[2].txid, 'tx-mvc');

    const expectedCalls = [
      {
        metabotId: 1,
        chain: 'btc',
        toAddress: '1btc-recipient',
        amountSpaceOrDoge: '0.001',
        feeRate: 2,
      },
      {
        metabotId: 1,
        chain: 'doge',
        toAddress: 'DogeRecipient',
        amountSpaceOrDoge: '1.25',
        feeRate: 300000,
      },
      {
        metabotId: 1,
        chain: 'mvc',
        toAddress: '1space-recipient',
        amountSpaceOrDoge: '0.5',
        feeRate: 1,
      },
    ];
    const sortByChain = (items) => items.slice().sort((a, b) => a.chain.localeCompare(b.chain));
    assert.equal(calls.length, expectedCalls.length);
    assert.deepEqual(sortByChain(calls), sortByChain(expectedCalls));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc transfer route rejects unsupported chain or missing fields with 400', async () => {
  const transferService = {
    async executeTransfer() {
      throw new Error('should not execute');
    },
  };
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({ transferService });
  try {
    const cases = [
      {
        body: {
          metabot_id: 1,
          chain: 'eth',
          to_address: '0xabc',
          amount: '1',
        },
        error: /unsupported/i,
      },
      {
        body: {
          metabot_id: 1,
          to_address: '1btc-recipient',
          amount: '1',
        },
        error: /chain/i,
      },
      {
        body: {
          metabot_id: 1,
          chain: 'btc',
          amount: '1',
        },
        error: /to_address/i,
      },
      {
        body: {
          metabot_id: 1,
          chain: 'doge',
          to_address: 'DogeRecipient',
          amount: 'abc',
        },
        error: /amount/i,
      },
      {
        body: {
          metabot_id: 1,
          chain: 'btc',
          to_address: '1btc-recipient',
          amount: '0',
        },
        error: /amount/i,
      },
      {
        body: {
          metabot_id: 1,
          chain: 'btc',
          to_address: '1btc-recipient',
          amount: '-1',
        },
        error: /amount/i,
      },
      {
        body: {
          metabot_id: 1,
          chain: 'btc',
          to_address: '1btc-recipient',
          amount: '1',
          fee_rate: 0,
        },
        error: /fee_rate/i,
      },
      {
        body: {
          metabot_id: 1,
          chain: 'btc',
          to_address: '1btc-recipient',
          amount: '1',
          fee_rate: -2,
        },
        error: /fee_rate/i,
      },
    ];

    const responses = await Promise.all(
      cases.map((testCase) =>
        fetch(`${baseUrl}/api/idbots/wallet/transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testCase.body),
        }),
      ),
    );

    const bodies = await Promise.all(responses.map((res) => res.json()));

    responses.forEach((res, index) => {
      assert.equal(res.status, 400);
      assert.match(String(bodies[index].error || ''), cases[index].error);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc btc signing routes expose sign-message and sign-psbt through metabot wallet context', async () => {
  const calls = [];
  class FakeBtcWallet {
    constructor(params) {
      calls.push({ kind: 'construct', params });
    }

    getAddress() {
      return '1btc-signer-address';
    }

    getPublicKey() {
      return Buffer.from(`02${'11'.repeat(32)}`, 'hex');
    }

    signMessage(message, encoding) {
      calls.push({ kind: 'sign-message', message, encoding });
      return 'signed-metaid-market-message';
    }

    signTx(signType, params) {
      calls.push({ kind: 'sign-psbt', signType, params });
      return {
        rawTx: 'signed-raw-tx',
        txId: 'signed-txid',
        psbtHex: 'signed-psbt-hex',
        fee: '123',
        txInputs: [{ address: '1btc-signer-address', value: 1000 }],
        txOutputs: [{ address: '1dest', value: 877 }],
      };
    }
  }

  const utxoWalletService = {
    AddressType: { SameAsMvc: 'same-as-mvc' },
    CoinType: { MVC: 'mvc' },
    SignType: { SIGN_PSBT: 'SIGN_PSBT' },
    BtcWallet: FakeBtcWallet,
  };

  const { server, baseUrl } = await startRpcServerForTestWithOverrides({ utxoWalletService });
  try {
    const signMessageRes = await fetch(`${baseUrl}/api/idbots/wallet/btc/sign-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        message: 'metaid.market',
      }),
    });
    const signPsbtRes = await fetch(`${baseUrl}/api/idbots/wallet/btc/sign-psbt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        psbt_hex: '70736274ff',
        auto_finalized: false,
        to_sign_inputs: [{ index: 0, sighash_types: [1] }],
      }),
    });

    const signMessageJson = await signMessageRes.json();
    const signPsbtJson = await signPsbtRes.json();

    assert.equal(signMessageJson.success, true);
    assert.equal(signMessageJson.signature, 'signed-metaid-market-message');
    assert.equal(signMessageJson.address, '1btc-signer-address');
    assert.equal(signMessageJson.public_key, `02${'11'.repeat(32)}`);

    assert.equal(signPsbtJson.success, true);
    assert.equal(signPsbtJson.raw_tx, 'signed-raw-tx');
    assert.equal(signPsbtJson.txid, 'signed-txid');
    assert.equal(signPsbtJson.psbt_hex, 'signed-psbt-hex');

    assert.deepEqual(calls, [
      {
        kind: 'construct',
        params: {
          coinType: 'mvc',
          addressType: 'same-as-mvc',
          addressIndex: 0,
          network: 'livenet',
          mnemonic: 'test mnemonic',
        },
      },
      {
        kind: 'sign-message',
        message: 'metaid.market',
        encoding: undefined,
      },
      {
        kind: 'construct',
        params: {
          coinType: 'mvc',
          addressType: 'same-as-mvc',
          addressIndex: 0,
          network: 'livenet',
          mnemonic: 'test mnemonic',
        },
      },
      {
        kind: 'sign-psbt',
        signType: 'SIGN_PSBT',
        params: {
          psbtHex: '70736274ff',
          autoFinalized: false,
          toSignInputs: [{ index: 0, sighashTypes: [1] }],
        },
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc mrc20 transfer route forwards validated requests to the main-process mrc20 executor', async () => {
  const calls = [];
  const mrc20Service = {
    async executeMrc20Transfer(_store, input) {
      calls.push(input);
      return {
        commitTxId: 'commit-txid',
        revealTxId: 'reveal-txid',
        totalFeeSats: 321,
      };
    },
  };

  const { server, baseUrl } = await startRpcServerForTestWithOverrides({ mrc20Service });
  try {
    const response = await fetch(`${baseUrl}/api/idbots/wallet/mrc20/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metabot_id: 1,
        mrc20_id: 'tick-id',
        symbol: 'metaid',
        decimal: 8,
        to_address: '1btc-recipient',
        amount: '1000',
        fee_rate: 9,
      }),
    });

    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.commit_txid, 'commit-txid');
    assert.equal(payload.reveal_txid, 'reveal-txid');
    assert.equal(payload.total_fee_sats, 321);
    assert.deepEqual(calls, [{
      metabotId: 1,
      asset: {
        mrc20Id: 'tick-id',
        decimal: 8,
        address: '1BtcAddress',
        symbol: 'METAID',
      },
      toAddress: '1btc-recipient',
      amount: '1000',
      feeRate: 9,
    }]);
  } finally {
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
