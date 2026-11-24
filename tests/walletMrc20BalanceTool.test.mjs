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
 * wallet_mrc20_balance tool layer, control-mock style (same harness shape
 * as walletAgentTools.test.mjs): verifies name resolution, batching, the
 * per-entry error surface and the holding formatter.
 */
function createMrc20Harness({ assets, error } = {}) {
  const tools = [];
  const handlers = {};
  const tool = (name, description, schema, handler) => {
    tools.push(name);
    handlers[name] = { description, schema, handler };
    return { name };
  };
  const calls = [];
  const control = {
    resolveMetabotIdByName: (name) => (name === 'AI_Sunny' ? 1 : name === 'Worker' ? 2 : null),
    getMetabotMvcAddress: (id) => (id === 1 ? '1TwinAddr' : null),
    listMrc20s: async (input) => {
      calls.push(input);
      const entries = [];
      for (const id of input.metabotIds ?? []) {
        if (id === 1) {
          entries.push({
            metabotId: 1,
            address: '1TwinBtc',
            ...(error ? { error } : { assets }),
          });
        } else {
          entries.push({ metabotId: id, address: '', error: 'local MetaBot not found or has no btc address' });
        }
      }
      if (input.address) entries.push({ metabotId: null, address: input.address, assets: error ? undefined : [] });
      return entries;
    },
  };
  return { tool, handlers, control, calls, tools };
}

const MRC20_ASSETS = [
  {
    kind: 'mrc20',
    chain: 'btc',
    symbol: 'TEST',
    tokenName: 'Test Token',
    mrc20Id: 'aabb'.repeat(32),
    address: '1TwinBtc',
    decimal: 18,
    balance: { confirmed: '1000.5', unconfirmed: '0.25', pendingIn: '2', pendingOut: '0', display: '1000.75' },
  },
];

test('wallet_mrc20_balance resolves names, batches ids, and formats holdings', async () => {
  const { buildWalletAgentTools } = loadCompiled('libs/walletAgentTools.js');
  const { tool, handlers, control, calls, tools } = createMrc20Harness({ assets: MRC20_ASSETS });
  buildWalletAgentTools({
    tool,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 1,
  });
  assert.ok(tools.includes('wallet_mrc20_balance'));
  assert.ok(handlers.wallet_mrc20_balance);
  assert.match(handlers.wallet_mrc20_balance.description, /MRC20/i);

  const result = await handlers.wallet_mrc20_balance.handler({ metabot_ids: [1], names: ['Worker'] });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /# metabot_id 1 1TwinBtc/);
  assert.match(text, /- 1 MRC20 token\(s\)/);
  assert.match(text, /TEST \(Test Token\): 1000\.75 TEST/);
  assert.match(text, /\[confirmed 1000\.5 \/ unconfirmed 0\.25 \/ pendingIn 2 \/ pendingOut 0\]/);
  assert.match(text, /mrc20Id aabb/);
  // Worker (id 2) has no btc address → error entry surfaced, not swallowed
  assert.match(text, /# metabot_id 2 /);
  assert.match(text, /lookup failed: local MetaBot not found or has no btc address/);
  assert.deepEqual(calls[0], { metabotIds: [1, 2], address: undefined });
});

test('wallet_mrc20_balance surfaces per-entry lookup errors and empty results', async () => {
  const { buildWalletAgentTools } = loadCompiled('libs/walletAgentTools.js');
  const { tool, handlers, control } = createMrc20Harness({ assets: MRC20_ASSETS, error: 'provider timeout' });
  buildWalletAgentTools({ tool, control, sessionId: 's1', resolveMetabotId: () => 1 });

  const failed = await handlers.wallet_mrc20_balance.handler({ metabot_ids: [1] });
  assert.match(failed.content[0].text, /lookup failed: provider timeout/);

  const empty = await handlers.wallet_mrc20_balance.handler({ address: '1SomeBtc' });
  assert.match(empty.content[0].text, /no MRC20 tokens held/);

  const badInput = await handlers.wallet_mrc20_balance.handler({});
  assert.equal(badInput.isError, true);
  assert.match(badInput.content[0].text, /requires metabot_ids, names, or address/);
});

test('wallet_mrc20_balance handles local and external idq1 GlobalMetaIDs with SegWit fallback and Taproot boundary guidance', async () => {
  const { buildWalletAgentTools } = loadCompiled('libs/walletAgentTools.js');
  const { convertToGlobalMetaId, convertGlobalMetaIdToAddresses } = loadCompiled('services/globalMetaid.js');
  const sampleMvcAddr = '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB';
  const sampleGmid = convertToGlobalMetaId(sampleMvcAddr);
  const decoded = convertGlobalMetaIdToAddresses(sampleGmid);

  // 1. Local MetaBot GlobalMetaID routes straight to metabotIds
  const localHarness = createMrc20Harness({ assets: MRC20_ASSETS });
  localHarness.control.resolveLocalMetabotByGlobalMetaId = (gmid) =>
    gmid === sampleGmid ? { id: 1, name: 'AI_Sunny', mvcAddress: sampleMvcAddr } : null;
  buildWalletAgentTools({
    tool: localHarness.tool,
    control: localHarness.control,
    sessionId: 's1',
    resolveMetabotId: () => 1,
  });
  const localRes = await localHarness.handlers.wallet_mrc20_balance.handler({ address: sampleGmid });
  assert.match(localRes.content[0].text, /# metabot_id 1 1TwinBtc/);
  assert.match(localRes.content[0].text, /TEST \(Test Token\): 1000\.75 TEST/);

  // 2. External idq1 GlobalMetaID with 0 on both 1... and bc1q... checks both and emits Taproot bc1p... guidance
  const extEmptyHarness = createMrc20Harness({ assets: [] });
  buildWalletAgentTools({
    tool: extEmptyHarness.tool,
    control: extEmptyHarness.control,
    sessionId: 's1',
    resolveMetabotId: () => 1,
  });
  const extEmptyRes = await extEmptyHarness.handlers.wallet_mrc20_balance.handler({ address: sampleGmid });
  assert.equal(extEmptyHarness.calls.length, 2, 'checks both P2PKH 1... and P2WPKH bc1q... for external idq1');
  assert.equal(extEmptyHarness.calls[0].address, decoded.btcAddress);
  assert.equal(extEmptyHarness.calls[1].address, decoded.btcSegwitAddress);
  assert.match(extEmptyRes.content[0].text, /Taproot \(bc1p\.\.\.\) address that cannot be derived offline from idq1/);
});

