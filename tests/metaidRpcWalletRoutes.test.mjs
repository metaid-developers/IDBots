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

function resolveCompiledMetaidRpcServerPath() {
  const candidates = [
    '../dist-electron/services/metaidRpcServer.js',
    '../dist-electron/main/services/metaidRpcServer.js',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try next compile output layout.
    }
  }
  return require.resolve(candidates[0]);
}

function resolveCompiledMetaidRpcEndpointPath() {
  const candidates = [
    '../dist-electron/services/metaidRpcEndpoint.js',
    '../dist-electron/main/services/metaidRpcEndpoint.js',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try next compile output layout.
    }
  }
  return require.resolve(candidates[0]);
}

const { getMetaidRpcToken } = require(resolveCompiledMetaidRpcEndpointPath());
const RPC_TOKEN = getMetaidRpcToken();
const RPC_AUTH_HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${RPC_TOKEN}` };

async function startRpcServerForTest() {
  return startRpcServerForTestWithOverrides({});
}

async function startRpcServerForTestWithOverrides({
  walletRawTxService = null,
  transferService = null,
  utxoWalletService = null,
  mrc20Service = null,
  metaidCore = null,
  onBotBrowserOpen = null,
  onBotBrowserTabCommand = null,
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
        BrowserWindow: {
          getAllWindows() {
            return [];
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
    if (metaidCore && (request === './metaidCore' || request.endsWith('/metaidCore'))) {
      return metaidCore;
    }
    return originalLoad(request, parent, isMain);
  };

  let startMetaidRpcServer;
  try {
    const compiledRpcServerPath = resolveCompiledMetaidRpcServerPath();
    delete require.cache[compiledRpcServerPath];
    ({ startMetaidRpcServer } = require(compiledRpcServerPath));
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
    // Phase 4: memory routes are not exercised here; a stub satisfies the
    // new MemoryBackend getter argument.
    () => ({
      listUserMemories() {
        return [];
      },
      createUserMemory() {
        throw new Error('memory routes are not exercised in this test');
      },
    }),
    onBotBrowserOpen || onBotBrowserTabCommand
      ? {
          openBotBrowserUri: onBotBrowserOpen || undefined,
          controlBotBrowserTabs: onBotBrowserTabCommand || undefined,
        }
      : undefined,
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

test('rpc bot-browser open route accepts Browser URIs and invokes the host open callback', async () => {
  const opened = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    onBotBrowserOpen(input) {
      opened.push(input);
    },
  });

  try {
    const uris = [
      'metaapp://6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0',
      'metafile://6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0',
    ];

    for (const uri of uris) {
      const response = await fetch(`${baseUrl}/api/idbots/bot-browser/open`, {
        method: 'POST',
        headers: RPC_AUTH_HEADERS,
        body: JSON.stringify({ uri }),
      });
      const json = await response.json();

      assert.equal(response.status, 200);
      assert.equal(json.success, true);
      assert.equal(json.uri, uri);
    }

    assert.deepEqual(opened, [
      {
        uri: uris[0],
        actorId: null,
      },
      {
        uri: uris[1],
        actorId: null,
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc bot-browser open route rejects unsupported URI schemes', async () => {
  const opened = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    onBotBrowserOpen(input) {
      opened.push(input);
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/idbots/bot-browser/open`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ uri: 'https://example.com' }),
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assert.equal(json.success, false);
    assert.equal(opened.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc bot-browser tabs route validates and relays client-only tab commands', async () => {
  const commands = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    onBotBrowserTabCommand(command) {
      commands.push(command);
      return {
        action: command.action,
        openedTabId: command.action === 'open-tab' ? 4 : undefined,
        tabs: [{ id: 4, uri: command.uri || null, title: null, isActive: true }],
        activeTab: { id: 4, uri: command.uri || null, title: null, isActive: true },
      };
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/idbots/bot-browser/tabs`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ action: 'open-tab', uri: 'metaid://idq1alice' }),
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.result.openedTabId, 4);
    assert.deepEqual(commands, [{ action: 'open-tab', uri: 'metaid://idq1alice' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc bot-browser tabs route rejects invalid ids before renderer dispatch', async () => {
  const commands = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    onBotBrowserTabCommand(command) {
      commands.push(command);
      return { action: command.action, tabs: [], activeTab: null };
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/idbots/bot-browser/tabs`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ action: 'switch-tab', tabId: 'not-a-number' }),
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assert.equal(json.success, false);
    assert.equal(commands.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

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
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ metabot_id: 1 }),
    });
    const balanceRes = await fetch(`${baseUrl}/api/idbots/address/balance`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ metabot_id: 1 }),
    });
    const feeRes = await fetch(`${baseUrl}/api/idbots/fee-rate-summary?chain=mvc`, { headers: RPC_AUTH_HEADERS });

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
        headers: RPC_AUTH_HEADERS,
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
        headers: RPC_AUTH_HEADERS,
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
        headers: RPC_AUTH_HEADERS,
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
          headers: RPC_AUTH_HEADERS,
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
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({
        metabot_id: 1,
        message: 'metaid.market',
      }),
    });
    const signPsbtRes = await fetch(`${baseUrl}/api/idbots/wallet/btc/sign-psbt`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
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
      headers: RPC_AUTH_HEADERS,
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
      headers: RPC_AUTH_HEADERS,
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
      headers: RPC_AUTH_HEADERS,
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
      headers: RPC_AUTH_HEADERS,
      body: '{',
    });
    const workerErrorRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc-ft/build-transfer-rawtx`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
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
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({
        metabot_id: 1,
        to_address: '1recipient',
        amount_sats: 0,
        fee_rate: 1,
      }),
    });
    const ftRes = await fetch(`${baseUrl}/api/idbots/wallet/mvc-ft/build-transfer-rawtx`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
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
      headers: RPC_AUTH_HEADERS,
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

function createPinCapturingMetaidCoreStub(captured) {
  return {
    async createPin(_store, metabotId, metaidData, options) {
      captured.push({ metabotId, metaidData, options });
      const txid = 'ab'.repeat(32);
      return { txids: [txid], pinId: `${txid}i0`, totalCost: 0 };
    },
    async getPinData() {
      return null;
    },
    setMetaidCoreStore() {},
    async syncMetaBotEditChangesToChain() {
      return {};
    },
  };
}

const CREATE_PIN_TEST_METAID_DATA = {
  operation: 'create',
  path: '/protocols/test',
  contentType: 'text/plain',
  payload: 'hello',
};

test('rpc create-pin route resolves an omitted fee_rate through the store tier, not a hidden constant', async () => {
  const captured = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    metaidCore: createPinCapturingMetaidCoreStub(captured),
  });

  try {
    const response = await fetch(`${baseUrl}/api/metaid/create-pin`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({
        metabot_id: 1,
        metaidData: CREATE_PIN_TEST_METAID_DATA,
        network: 'doge',
      }),
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(captured.length, 1);
    // No fee_rate in the request: the route must resolve the user's selected
    // tier via resolveCreatePinFeeRate (doge default Fast tier = 7500000),
    // which differs from the hard-coded last-resort fallback (5000000).
    assert.equal(captured[0].options.feeRate, 7500000);
    assert.equal(captured[0].options.network, 'doge');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc create-pin route forwards an explicit fee_rate unchanged', async () => {
  const captured = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    metaidCore: createPinCapturingMetaidCoreStub(captured),
  });

  try {
    const response = await fetch(`${baseUrl}/api/metaid/create-pin`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({
        metabot_id: 1,
        metaidData: CREATE_PIN_TEST_METAID_DATA,
        fee_rate: 3,
      }),
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].options.feeRate, 3);
    assert.equal(captured[0].options.network, 'mvc');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc create-pin route rejects a non-positive fee_rate with 400 and never calls createPin', async () => {
  const captured = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    metaidCore: createPinCapturingMetaidCoreStub(captured),
  });

  try {
    for (const feeRate of [0, -2]) {
      const response = await fetch(`${baseUrl}/api/metaid/create-pin`, {
        method: 'POST',
        headers: RPC_AUTH_HEADERS,
        body: JSON.stringify({
          metabot_id: 1,
          metaidData: CREATE_PIN_TEST_METAID_DATA,
          fee_rate: feeRate,
        }),
      });
      const json = await response.json();

      assert.equal(response.status, 400);
      assert.equal(json.success, false);
      assert.match(json.error, /fee_rate must be positive/);
    }
    assert.equal(captured.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rpc auth gate: missing token -> 401, bad origin -> 403, allowed origin preflight -> 204 without wildcard ACAO', async () => {
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    onBotBrowserOpen() {},
  });
  try {
    // 1. No token: every endpoint must reject with 401 before routing.
    const noToken = await fetch(`${baseUrl}/api/idbots/bot-browser/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: 'metaapp://x' }),
    });
    assert.equal(noToken.status, 401);
    const noTokenJson = await noToken.json();
    assert.equal(noTokenJson.success, false);

    // 2. Wrong token: 401.
    const wrongToken = await fetch(`${baseUrl}/api/idbots/bot-browser/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ uri: 'metaapp://x' }),
    });
    assert.equal(wrongToken.status, 401);

    // 3. Non-app origin: 403 even with a valid token (browser-origin defense).
    const badOrigin = await fetch(`${baseUrl}/api/idbots/bot-browser/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RPC_TOKEN}`,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ uri: 'metaapp://x' }),
    });
    assert.equal(badOrigin.status, 403);

    // 4. Preflight from a non-app origin: 403.
    const badPreflight = await fetch(`${baseUrl}/api/idbots/bot-browser/open`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(badPreflight.status, 403);

    // 5. Preflight from an allowlisted origin: 204 with an echoed origin, never '*'.
    const goodPreflight = await fetch(`${baseUrl}/api/idbots/bot-browser/open`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5175', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(goodPreflight.status, 204);
    assert.equal(goodPreflight.headers.get('access-control-allow-origin'), 'http://localhost:5175');
    assert.notEqual(goodPreflight.headers.get('access-control-allow-origin'), '*');

    // 6. With the per-launch token and no Origin (native host-spawned client): accepted.
    const ok = await fetch(`${baseUrl}/api/idbots/bot-browser/open`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ uri: 'metaapp://6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0' }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
