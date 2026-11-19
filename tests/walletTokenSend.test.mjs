import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveCompiled(rel) {
  return require.resolve(`../dist-electron/main/${rel}`);
}

/**
 * walletTokenSendService imports walletTransferService (→ transferService)
 * and metabotTokenTransferService; the loader stubs electron plus those two
 * modules the same way walletTransferService.test.mjs does. The token
 * transfer impl is ALWAYS injected per test — the stub throws if the real
 * (network) transfer path is ever reached.
 */
function loadWalletTokenSendService() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => '/tmp', getAppPath: () => process.cwd() },
      };
    }
    if (request === './transferService' || request.endsWith('/transferService')) {
      return { executeTransfer: async () => { throw new Error('real executeTransfer must not run'); } };
    }
    if (request === './metabotTokenTransferService' || request.endsWith('/metabotTokenTransferService')) {
      return {
        executeTokenTransfer: async () => { throw new Error('real executeTokenTransfer must not run'); },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const path = resolveCompiled('services/walletTokenSendService.js');
    delete require.cache[path];
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

const MVC_ADDR_1 = '1MvcBotOne';
const MVC_ADDR_2 = '1MvcBotTwo';
const EXTERNAL_ADDR = '1ExternalTarget';
const METAID_GENESIS = '28a481ecdae9499a599a9457ae70b5cf234ef417';
const MATRIX_GENESIS = 'bb3f0cb7cb7314a30bfb60a6d97e7eda6985274f';

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 1 && id !== 2) return null;
      return {
        id,
        name: id === 1 ? 'Twin' : 'Worker',
        mvc_address: id === 1 ? MVC_ADDR_1 : MVC_ADDR_2,
        btc_address: `1BtcAddr${id}`,
        doge_address: `DogeAddr${id}`,
        public_key: 'pk',
      };
    },
    listMetabots() {
      return [
        { id: 1, mvc_address: MVC_ADDR_1 },
        { id: 2, mvc_address: MVC_ADDR_2 },
      ];
    },
  };
}

function createTransferLedger() {
  const records = [];
  let nextId = 1;
  return {
    records,
    record(input) {
      const created = { id: nextId++, ...input };
      records.push(created);
      return created;
    },
  };
}

/** Asset list fixture: METAID (decimal 6) plus Matrix (decimal 8). */
function metaidAssets({ extraGenesis = null } = {}) {
  const assets = [
    {
      kind: 'mvc-ft',
      chain: 'mvc',
      symbol: 'METAID',
      tokenName: 'META ID',
      genesis: METAID_GENESIS,
      codeHash: 'aa872f5a781e1e93c2a29fc49d09e3571a3b6b4f',
      address: MVC_ADDR_1,
      decimal: 6,
      balance: { confirmed: '1.029158', unconfirmed: '0.119265', display: '1.148423' },
    },
  ];
  if (extraGenesis) {
    assets.push({
      kind: 'mvc-ft',
      chain: 'mvc',
      symbol: 'FORK',
      tokenName: 'Fork',
      genesis: extraGenesis,
      codeHash: 'bb00000000000000000000000000000000000000',
      address: MVC_ADDR_1,
      decimal: 8,
      balance: { confirmed: '5', unconfirmed: '0', display: '5' },
    });
  }
  return assets;
}

function baseDeps({ assets = metaidAssets(), confirmExternal, settings, executeTokenTransfer } = {}) {
  const ledger = createTransferLedger();
  return {
    ledger,
    deps: {
      metabotStore: createMetabotStore(),
      transferStore: ledger,
      ...(confirmExternal ? { confirmExternal } : {}),
      ...(settings != null ? { settingsReader: { get: (key) => settings[key] } } : {}),
      getFeeRate: () => 1,
      listAssetsImpl: async () => assets,
      executeTokenTransferImpl: executeTokenTransfer,
    },
  };
}

const SEND = (over = {}) => ({
  metabotId: 1,
  genesis: METAID_GENESIS,
  to: MVC_ADDR_2,
  amount: '0.1',
  sessionId: 'sess-1',
  origin: 'tool:wallet_token_send',
  ...over,
});

test('channel A: local-roster target sends the partial amount without confirmation and audits the broadcast', async () => {
  const calls = [];
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps, ledger } = baseDeps({
    executeTokenTransfer: async (_store, params) => {
      calls.push(params);
      return { txId: 'tx-token-1' };
    },
  });
  const result = await executeWalletTokenSend(deps, SEND());
  assert.equal(result.success, true);
  assert.equal(result.txid, 'tx-token-1');
  assert.equal(result.channel, 'local');
  assert.equal(result.to_metabot_id, 2);
  assert.equal(result.token_symbol, 'METAID');
  assert.equal(result.amount, '0.100000');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'mvc-ft');
  assert.equal(calls[0].asset.genesis, METAID_GENESIS);
  assert.equal(calls[0].asset.decimal, 6);
  assert.equal(calls[0].toAddress, MVC_ADDR_2);
  assert.equal(calls[0].amount, '0.100000');
  assert.equal(calls[0].feeRate, 1);
  assert.equal(ledger.records.length, 1);
  const row = ledger.records[0];
  assert.equal(row.status, 'broadcast');
  assert.equal(row.channel, 'local');
  assert.equal(row.chain, 'mvc');
  assert.equal(row.toMetabotId, 2);
  assert.equal(row.txid, 'tx-token-1');
  assert.equal(row.amountSats, 100000); // token BASE units, not SPACE sats
  assert.equal(row.memo, 'mvc20 METAID 0.100000');
  assert.equal(row.sessionId, 'sess-1');
});

test('channel B: external target without any confirmation is refused with a structured gate error', async () => {
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps, ledger } = baseDeps({
    executeTokenTransfer: async () => { throw new Error('must not execute'); },
  });
  const result = await executeWalletTokenSend(deps, SEND({ to: EXTERNAL_ADDR }));
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'external_transfer_confirmation_required');
  assert.equal(result.channel, 'external');
  assert.match(result.error, /external_confirmed=true/);
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'refused');
  assert.equal(ledger.records[0].txid, null);
});

test('channel B: owner dialog receives the token context and a denial stops the send', async () => {
  const seen = [];
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps } = baseDeps({
    executeTokenTransfer: async () => { throw new Error('must not execute'); },
    confirmExternal: async (info) => {
      seen.push(info);
      return false;
    },
  });
  const result = await executeWalletTokenSend(deps, SEND({ to: EXTERNAL_ADDR }));
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'external_transfer_declined');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].token, {
    symbol: 'METAID',
    amount: '0.100000',
    genesis: METAID_GENESIS,
  });
  assert.equal(seen[0].amountSats, 100000);
  assert.ok(Number.isInteger(seen[0].estimatedFeeSats) && seen[0].estimatedFeeSats > 0);
});

test('channel B: explicit external_confirmed bypasses the missing dialog and broadcasts', async () => {
  const calls = [];
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps, ledger } = baseDeps({
    executeTokenTransfer: async (_store, params) => {
      calls.push(params);
      return { txId: 'tx-token-2' };
    },
  });
  const result = await executeWalletTokenSend(deps, SEND({ to: EXTERNAL_ADDR, externalConfirmed: true }));
  assert.equal(result.success, true);
  assert.equal(result.channel, 'external');
  assert.equal(result.to_metabot_id, null);
  assert.equal(calls.length, 1);
  assert.equal(ledger.records[0].status, 'broadcast');
  assert.equal(ledger.records[0].toMetabotId, null);
});

test('channel B: disabled settings gate lets an external token send through without confirmation', async () => {
  const calls = [];
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps } = baseDeps({
    settings: { wallet_transfer_external_confirm_enabled: false },
    executeTokenTransfer: async (_store, params) => {
      calls.push(params);
      return { txId: 'tx-token-3' };
    },
  });
  const result = await executeWalletTokenSend(deps, SEND({ to: EXTERNAL_ADDR }));
  assert.equal(result.success, true);
  assert.equal(result.channel, 'external');
  assert.equal(calls.length, 1);
});

test('unknown token genesis is rejected as token_not_found without touching the ledger', async () => {
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps, ledger } = baseDeps({
    executeTokenTransfer: async () => { throw new Error('must not execute'); },
  });
  const result = await executeWalletTokenSend(deps, SEND({ genesis: MATRIX_GENESIS }));
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'token_not_found');
  assert.match(result.error, /not found in 1MvcBotOne's wallet/);
  assert.equal(ledger.records.length, 0);
});

test('insufficient token balance fails fast with have/need in display units and audits the refusal', async () => {
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps, ledger } = baseDeps({
    executeTokenTransfer: async () => { throw new Error('must not execute'); },
  });
  const result = await executeWalletTokenSend(deps, SEND({ amount: '2' }));
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'insufficient_balance');
  assert.equal(result.have, '1.148423');
  assert.equal(result.need, '2.000000');
  assert.equal(result.token_symbol, 'METAID');
  assert.match(result.error, /insufficient METAID balance/);
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'refused');
});

test('genesis ambiguity without codehash is rejected and the candidates are named', async () => {
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps } = baseDeps({
    assets: metaidAssets({ extraGenesis: METAID_GENESIS }),
    executeTokenTransfer: async () => { throw new Error('must not execute'); },
  });
  const result = await executeWalletTokenSend(deps, SEND());
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'invalid_params');
  assert.match(result.error, /pass codehash to disambiguate/);
  assert.match(result.error, /aa872f5a781e1e93c2a29fc49d09e3571a3b6b4f/);
  assert.match(result.error, /bb00000000000000000000000000000000000000/);
});

test('codehash disambiguates forked tokens sharing a genesis', async () => {
  const calls = [];
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps } = baseDeps({
    assets: metaidAssets({ extraGenesis: METAID_GENESIS }),
    executeTokenTransfer: async (_store, params) => {
      calls.push(params);
      return { txId: 'tx-token-4' };
    },
  });
  const result = await executeWalletTokenSend(deps, SEND({ codehash: 'BB00000000000000000000000000000000000000' }));
  assert.equal(result.success, true);
  assert.equal(result.token_symbol, 'FORK');
  assert.equal(calls[0].asset.codeHash, 'bb00000000000000000000000000000000000000');
});

test('transfer failure (throw) is audited as failed with a structured error', async () => {
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps, ledger } = baseDeps({
    executeTokenTransfer: async () => { throw new Error('ft utxo build failed'); },
  });
  const result = await executeWalletTokenSend(deps, SEND());
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'transfer_failed');
  assert.match(result.error, /ft utxo build failed/);
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'failed');
  assert.equal(ledger.records[0].txid, null);
});

test('invalid params (bad genesis shape, bad amount) fail without any ledger row', async () => {
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps, ledger } = baseDeps({
    executeTokenTransfer: async () => { throw new Error('must not execute'); },
  });
  const badGenesis = await executeWalletTokenSend(deps, SEND({ genesis: 'zzz' }));
  assert.equal(badGenesis.error_code, 'invalid_params');
  const badAmount = await executeWalletTokenSend(deps, SEND({ amount: '0' }));
  assert.equal(badAmount.error_code, 'invalid_params');
  const badTo = await executeWalletTokenSend(deps, SEND({ to: '' }));
  assert.equal(badTo.error_code, 'invalid_params');
  assert.equal(ledger.records.length, 0);
});

test('user memo rides the audit row behind the mvc20 descriptor', async () => {
  const { executeWalletTokenSend } = loadWalletTokenSendService();
  const { deps, ledger } = baseDeps({
    executeTokenTransfer: async () => ({ txId: 'tx-token-5' }),
  });
  const result = await executeWalletTokenSend(deps, SEND({ memo: 'task payment' }));
  assert.equal(result.success, true);
  assert.equal(ledger.records[0].memo, 'mvc20 METAID 0.100000 | task payment');
});
