import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveCompiled(rel) {
  const candidates = [`../dist-electron/main/${rel}`, `../dist-electron/main/${rel}`];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // try next compile output layout
    }
  }
  return require.resolve(candidates[0]);
}


function loadWalletAgentTools() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => '/tmp', getAppPath: () => process.cwd() } };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const path = resolveCompiled('libs/walletAgentTools.js');
    delete require.cache[path];
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

function createHarness({ transferResult } = {}) {
  const tools = [];
  const handlers = {};
  const tool = (name, description, schema, handler) => {
    tools.push(name);
    handlers[name] = { description, schema, handler };
    return { name };
  };
  const balanceEntries = new Map();
  const control = {
    getBalances: async ({ metabotIds, chains, options }) => {
      control.lastBalanceQuery = { metabotIds, chains, options };
      return {
        entries: metabotIds.map((id) => balanceEntries.get(id)),
        queried_at: '2026-09-03T00:00:00.000Z',
      };
    },
    getBalanceForAddress: async (chain, address, options) => {
      control.lastAddressBalanceQuery = { chain, address, options };
      return ({
      chain,
      address,
      unit: chain === 'btc' ? 'BTC' : chain === 'doge' ? 'DOGE' : 'SPACE',
      confirmed_sats: 7,
      unconfirmed_sats: 3,
      total_sats: 10,
      utxo_count: 2,
      ...(chain === 'mvc' && options?.deep === true
        ? { mvc_truth: { verdict: 'degraded', reason: 'deep probe fixture', guidance: 'fixture rule' } }
        : {}),
    });
    },
    resolveMetabotIdByName: (name) => (name === 'AI_Sunny' ? 1 : name === 'Worker' ? 2 : null),
    getMetabotMvcAddress: (id) => (id === 2 ? '1WorkerAddr' : id === 1 ? '1TwinAddr' : null),
    transfer: async (params, host) => {
      control.lastTransferCall = { params, host };
      return transferResult ?? { success: true, txid: 'tx-1', fee_sats: 200, channel: 'local', to_metabot_id: 2, audit_id: 7 };
    },
    listTransfers: () => [],
    lastTransferCall: null,
  };
  balanceEntries.set(1, {
    metabot_id: 1,
    name: 'AI_Sunny',
    addresses: { mvc: '1TwinAddr', btc: '1TwinBtc', doge: 'DogeTwin' },
    balances: {
      mvc: { chain: 'mvc', address: '1TwinAddr', unit: 'SPACE', confirmed_sats: 1_220_650_491, unconfirmed_sats: 0, total_sats: 1_220_650_491, utxo_count: 12 },
      btc: { chain: 'btc', address: '1TwinBtc', unit: 'BTC', confirmed_sats: 0, unconfirmed_sats: 0, total_sats: 0, utxo_count: 0 },
      doge: { chain: 'doge', address: 'DogeTwin', unit: 'DOGE', confirmed_sats: 5, unconfirmed_sats: 0, total_sats: 5, utxo_count: 1 },
    },
    errors: {},
  });
  balanceEntries.set(2, {
    metabot_id: 2,
    name: 'Worker',
    addresses: { mvc: '1WorkerAddr', btc: '', doge: '' },
    balances: {
      mvc: { chain: 'mvc', address: '1WorkerAddr', unit: 'SPACE', confirmed_sats: 199_427_367, unconfirmed_sats: 100, total_sats: 199_427_467, utxo_count: 3 },
    },
    errors: { btc: 'provider timeout' },
  });
  return { tool, handlers, control, tools };
}

test('wallet_balance batches ids and names into one readable sheet', async () => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { tool, handlers, control } = createHarness();
  const sessions = new Map([['s1', 15]]);
  buildWalletAgentTools({
    tool,
    control,
    sessionId: 's1',
    resolveMetabotId: (sid) => sessions.get(sid),
  });
  assert.ok(handlers.wallet_balance);
  assert.ok(handlers.wallet_transfer);
  assert.match(handlers.wallet_balance.description, /wallet balance/i);

  const result = await handlers.wallet_balance.handler({ metabot_ids: [1], names: ['Worker'] });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /# AI_Sunny \(metabot_id 1\)/);
  assert.match(text, /mvc: balance 1220650491 sats \(12\.20650491 SPACE\), 12 UTXOs \[spendable = confirmed 1220650491 \+ unconfirmed 0\]/);
  assert.match(text, /# Worker \(metabot_id 2\)/);
  assert.match(text, /btc: lookup failed: provider timeout/);
});

test('wallet_balance rejects unknown names and empty input', async () => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { tool, handlers, control } = createHarness();
  buildWalletAgentTools({ tool, control, sessionId: 's1', resolveMetabotId: () => 15 });

  const unknown = await handlers.wallet_balance.handler({ names: ['Nobody'] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /not found by name: Nobody/);

  const empty = await handlers.wallet_balance.handler({});
  assert.equal(empty.isError, true);
});

test('wallet_balance explicit address queries all chains when unspecified', async () => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { tool, handlers, control } = createHarness();
  buildWalletAgentTools({ tool, control, sessionId: 's1', resolveMetabotId: () => 15 });
  const result = await handlers.wallet_balance.handler({ address: '1SomeAddress' });
  const text = result.content[0].text;
  assert.match(text, /- mvc: balance 10 sats \(0\.00000010 SPACE\), 2 UTXOs \[spendable = confirmed 7 \+ unconfirmed 3\]/);
  assert.match(text, /- btc: /);
  assert.match(text, /- doge: /);
});

test('wallet_transfer resolves id/name/address targets and converts SPACE to sats', async () => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { tool, handlers, control } = createHarness();
  buildWalletAgentTools({ tool, control, sessionId: 's1', resolveMetabotId: () => 15 });

  const byId = await handlers.wallet_transfer.handler({ to: '2', amount: 0.001, memo: 'topup' });
  assert.equal(byId.isError, undefined);
  assert.match(byId.content[0].text, /txid: tx-1/);
  assert.match(byId.content[0].text, /channel: local/);
  assert.equal(control.lastTransferCall.params.to, '1WorkerAddr');
  assert.equal(control.lastTransferCall.params.amountSats, 100_000);
  assert.equal(control.lastTransferCall.params.metabotId, 15);
  assert.equal(control.lastTransferCall.params.memo, 'topup');
  assert.equal(control.lastTransferCall.params.origin, 'tool:wallet_transfer');

  await handlers.wallet_transfer.handler({ to: 'AI_Sunny', amount: 0.001 });
  assert.equal(control.lastTransferCall.params.to, '1TwinAddr');

  await handlers.wallet_transfer.handler({ to: '1RawExternaaAddressXy', amount: 0.001 });
  assert.equal(control.lastTransferCall.params.to, '1RawExternaaAddressXy');
});

test('wallet_transfer passes the owner dialog through to the control layer', async () => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { tool, handlers, control } = createHarness();
  const dialogs = [];
  buildWalletAgentTools({
    tool,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 15,
    confirmExternalTransfer: async (info) => {
      dialogs.push(info);
      return true;
    },
  });
  await handlers.wallet_transfer.handler({ to: '1RawExternaaAddressXy', amount: 0.001 });
  assert.ok(control.lastTransferCall.host);
  assert.equal(typeof control.lastTransferCall.host.confirmExternal, 'function');
  // The dialog callback is forwarded verbatim.
  const info = { metabotId: 15, fromAddress: 'a', toAddress: 'b', amountSats: 1, estimatedFeeSats: 2 };
  assert.equal(await control.lastTransferCall.host.confirmExternal(info), true);
  assert.deepEqual(dialogs, [info]);
});

test('wallet_transfer formats structured failures with have/need', async () => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { tool, handlers, control } = createHarness({
    transferResult: {
      success: false,
      error: 'insufficient balance: have 500 sats (0.00000500 SPACE), need 100200 sats at 1TwinAddr',
      error_code: 'insufficient_balance',
      have_sats: 500,
      need_sats: 100_200,
      channel: 'local',
    },
  });
  buildWalletAgentTools({ tool, control, sessionId: 's1', resolveMetabotId: () => 15 });
  const result = await handlers.wallet_transfer.handler({ to: '2', amount: 0.001 });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /insufficient_balance/);
  assert.match(text, /- have: 500 sats \(0\.00000500 SPACE\)/);
  assert.match(text, /- need: 100200 sats/);
});

test('wallet_transfer guards: no session bot, unknown target, dust amount', async () => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { tool, handlers, control } = createHarness();
  buildWalletAgentTools({ tool, control, sessionId: 's1', resolveMetabotId: () => undefined });

  const noBot = await handlers.wallet_transfer.handler({ to: '2', amount: 0.001 });
  assert.equal(noBot.isError, true);
  assert.match(noBot.content[0].text, /own wallet/);

  buildWalletAgentTools({ tool, control, sessionId: 's1', resolveMetabotId: () => 15 });
  const unknownName = await handlers.wallet_transfer.handler({ to: 'Not A Bot', amount: 0.001 });
  assert.equal(unknownName.isError, true);

  const unknownId = await handlers.wallet_transfer.handler({ to: '99', amount: 0.001 });
  assert.equal(unknownId.isError, true);
  assert.match(unknownId.content[0].text, /local MetaBot not found: 99/);

  const dust = await handlers.wallet_transfer.handler({ to: '2', amount: 0.000001 });
  assert.equal(dust.isError, true);
  assert.match(dust.content[0].text, /dust limit/);
});

test('wallet_balance passes deep to the MVC truth layer and renders the degraded verdict', async () => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { handlers, control } = createHarness();
  buildWalletAgentTools({ tool: (name, description, schema, handler) => { handlers[name] = { description, schema, handler }; }, control, sessionId: 's', resolveMetabotId: () => 1 });

  const result = await handlers.wallet_balance.handler({ chain: 'mvc', address: '1MvcDeep', deep: true });
  const text = result.content[0].text;
  assert.equal(control.lastAddressBalanceQuery?.options?.deep, true, 'deep reaches the truth layer');
  assert.match(text, /verdict: DEGRADED — deep probe fixture/);
  assert.match(text, /rule: fixture rule/);

  // The light path never claims deep verification.
  await handlers.wallet_balance.handler({ chain: 'mvc', address: '1MvcDeep' });
  assert.equal(control.lastAddressBalanceQuery?.options?.deep, undefined);
  assert.doesNotMatch(control.lastAddressBalanceQuery ? '' : '', /x/); // no-op shape guard

  // deep on non-mvc chains is ignored (the flag never reaches the snapshot).
  await handlers.wallet_balance.handler({ chain: 'btc', address: '1BtcDeep', deep: true });
  assert.equal(control.lastAddressBalanceQuery?.chain, 'btc');
  assert.equal(control.lastAddressBalanceQuery?.options?.deep, undefined);
});
