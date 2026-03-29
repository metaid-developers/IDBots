import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let walletIpc;
try {
  walletIpc = require('../dist-electron/services/metabotWalletIpc.js');
} catch {
  walletIpc = null;
}

test('registerMetabotWalletIpcHandlers exposes token asset aggregation and transfer handlers', async () => {
  assert.equal(
    typeof walletIpc?.registerMetabotWalletIpcHandlers,
    'function',
    'registerMetabotWalletIpcHandlers() should be exported',
  );

  const handlers = {};

  walletIpc.registerMetabotWalletIpcHandlers({
    ipcMain: {
      handle(name, fn) {
        handlers[name] = fn;
      },
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotWalletAssets: async (_store, input) => ({ metabotId: input.metabotId, nativeAssets: [], mrc20Assets: [], mvcFtAssets: [] }),
    getTokenTransferFeeSummary: async (kind) => ({ list: [{ title: 'Avg', desc: 'avg', feeRate: kind === 'mrc20' ? 2 : 1 }], defaultFeeRate: kind === 'mrc20' ? 2 : 1 }),
    buildTokenTransferPreview: async (input) => ({ fromAddress: input.asset.address, toAddress: input.toAddress, amount: input.amount }),
    executeTokenTransfer: async (_store, input) => ({ txId: input.kind === 'mrc20' ? 'reveal-txid' : 'mvc-txid' }),
  });

  assert.equal(typeof handlers['idbots:getMetabotWalletAssets'], 'function');
  assert.equal(typeof handlers['idbots:getTokenTransferFeeSummary'], 'function');
  assert.equal(typeof handlers['idbots:buildTokenTransferPreview'], 'function');
  assert.equal(typeof handlers['idbots:executeTokenTransfer'], 'function');

  const assets = await handlers['idbots:getMetabotWalletAssets']({}, { metabotId: 7 });
  assert.deepEqual(assets, {
    success: true,
    assets: { metabotId: 7, nativeAssets: [], mrc20Assets: [], mvcFtAssets: [] },
  });

  const feeSummary = await handlers['idbots:getTokenTransferFeeSummary']({}, { kind: 'mrc20' });
  assert.equal(feeSummary.success, true);
  assert.equal(feeSummary.defaultFeeRate, 2);

  const preview = await handlers['idbots:buildTokenTransferPreview']({}, {
    kind: 'mrc20',
    asset: {
      kind: 'mrc20',
      chain: 'btc',
      symbol: 'MINE',
      tokenName: 'Mine',
      mrc20Id: 'mine-id',
      address: 'btc-address',
      decimal: 8,
      balance: { confirmed: '1.0', unconfirmed: '0', pendingIn: '0', pendingOut: '0', display: '1.0' },
    },
    metabotId: 1,
    toAddress: 'btc-dest',
    amount: '0.5',
    feeRate: 2,
  });
  assert.deepEqual(preview, {
    success: true,
    preview: {
      fromAddress: 'btc-address',
      toAddress: 'btc-dest',
      amount: '0.5',
    },
  });

  const execution = await handlers['idbots:executeTokenTransfer']({}, {
    kind: 'mvc-ft',
    asset: {
      kind: 'mvc-ft',
      chain: 'mvc',
      symbol: 'MC',
      tokenName: 'Meta Coin',
      genesis: 'genesis',
      codeHash: 'code',
      address: 'mvc-address',
      decimal: 8,
      balance: { confirmed: '9', unconfirmed: '1', display: '9' },
    },
    metabotId: 1,
    toAddress: 'mvc-dest',
    amount: '1.25',
    feeRate: 1,
  });
  assert.deepEqual(execution, {
    success: true,
    result: { txId: 'mvc-txid' },
  });
});

test('registerMetabotWalletIpcHandlers surfaces wallet token errors as failure payloads', async () => {
  const handlers = {};

  walletIpc.registerMetabotWalletIpcHandlers({
    ipcMain: {
      handle(name, fn) {
        handlers[name] = fn;
      },
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotWalletAssets: async () => {
      throw new Error('asset boom');
    },
    getTokenTransferFeeSummary: async () => {
      throw new Error('fee boom');
    },
    buildTokenTransferPreview: async () => {
      throw new Error('preview boom');
    },
    executeTokenTransfer: async () => {
      throw new Error('execute boom');
    },
  });

  await assert.doesNotReject(async () => {
    const assets = await handlers['idbots:getMetabotWalletAssets']({}, { metabotId: 1 });
    const feeSummary = await handlers['idbots:getTokenTransferFeeSummary']({}, { kind: 'mrc20' });
    const preview = await handlers['idbots:buildTokenTransferPreview']({}, {});
    const execution = await handlers['idbots:executeTokenTransfer']({}, {});

    assert.deepEqual(assets, { success: false, error: 'asset boom' });
    assert.deepEqual(feeSummary, { success: false, error: 'fee boom' });
    assert.deepEqual(preview, { success: false, error: 'preview boom' });
    assert.deepEqual(execution, { success: false, error: 'execute boom' });
  });
});
