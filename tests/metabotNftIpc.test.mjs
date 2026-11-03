import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let nftIpc;
try {
  nftIpc = require('../dist-electron/main/services/metabotNftIpc.js');
} catch {
  nftIpc = null;
}

test('registerMetabotNftIpcHandlers exposes the NFT list and transfer handlers', async () => {
  assert.equal(
    typeof nftIpc?.registerMetabotNftIpcHandlers,
    'function',
    'registerMetabotNftIpcHandlers() should be exported',
  );

  const handlers = {};

  nftIpc.registerMetabotNftIpcHandlers({
    registerIpcHandler(name, fn) {
      handlers[name] = fn;
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotNftItems: async (_store, input) => [
      { kind: input.kind, key: 'k1', name: 'One', collectionName: 'Series', raw: {} },
    ],
    transferMetabotMvcNft: async (_store, input) => ({ txId: 'mvc-nft-txid', rawTx: 'raw' }),
    transferMetabotMrc721: async (_store, input) => ({
      txId: 'mrc721-txid',
      pinId: input.pinId,
      toAddress: input.toAddress,
      spentOutpoint: 'outpoint',
      outputValue: 1000,
    }),
    getNftCaRegistry: async (input) => ({
      protocol: 'idbots-nft-ca',
      version: 1,
      verified: false,
      status: 'empty-no-pin-configured',
      pinId: null,
      creatorMetaId: null,
      officialMetaId: '',
      collections: [],
      fetchedAt: 1,
      ...(input?.refresh === true ? { detail: 'refreshed' } : {}),
    }),
  });

  assert.equal(typeof handlers['idbots:getMetabotNfts'], 'function');
  assert.equal(typeof handlers['idbots:transferMetabotMvcNft'], 'function');
  assert.equal(typeof handlers['idbots:transferMetabotMrc721'], 'function');
  assert.equal(typeof handlers['idbots:getNftCaRegistry'], 'function');

  const registry = await handlers['idbots:getNftCaRegistry']({}, {});
  assert.equal(registry.success, true);
  assert.equal(registry.registry.status, 'empty-no-pin-configured');
  const refreshed = await handlers['idbots:getNftCaRegistry']({}, { refresh: true });
  assert.equal(refreshed.registry.detail, 'refreshed', 'refresh flag must reach the reader');

  const items = await handlers['idbots:getMetabotNfts']({}, { metabotId: 7, kind: 'mrc721' });
  assert.deepEqual(items, {
    success: true,
    items: [{ kind: 'mrc721', key: 'k1', name: 'One', collectionName: 'Series', raw: {} }],
  });

  const badKind = await handlers['idbots:getMetabotNfts']({}, { metabotId: 7, kind: 'nope' });
  assert.deepEqual(badKind, { success: false, error: "kind must be 'mrc721' or 'metacontract'" });

  const badId = await handlers['idbots:getMetabotNfts']({}, { metabotId: 0, kind: 'mrc721' });
  assert.equal(badId.success, false);
  assert.match(badId.error, /metabotId/);

  const mvcTransfer = await handlers['idbots:transferMetabotMvcNft']({}, {
    metabotId: 7,
    genesis: 'gen',
    codehash: 'hash',
    tokenIndex: '3',
    toAddress: 'mvc-dest',
    feeRate: 1,
  });
  assert.deepEqual(mvcTransfer, { success: true, result: { txId: 'mvc-nft-txid', rawTx: 'raw' } });

  const mrc721Transfer = await handlers['idbots:transferMetabotMrc721']({}, {
    metabotId: 7,
    pinId: 'pin…i0',
    toAddress: 'mvc-dest',
    feeRate: 1,
  });
  assert.deepEqual(mrc721Transfer, {
    success: true,
    result: { txId: 'mrc721-txid', pinId: 'pin…i0', toAddress: 'mvc-dest', spentOutpoint: 'outpoint', outputValue: 1000 },
  });
});

test('registerMetabotNftIpcHandlers surfaces NFT errors as failure payloads', async () => {
  const handlers = {};

  nftIpc.registerMetabotNftIpcHandlers({
    registerIpcHandler(name, fn) {
      handlers[name] = fn;
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotNftItems: async () => {
      throw new Error('nft boom');
    },
    transferMetabotMvcNft: async () => {
      throw new Error('mvc transfer boom');
    },
    transferMetabotMrc721: async () => {
      throw new Error('mrc721 transfer boom');
    },
    getNftCaRegistry: async () => {
      throw new Error('ca boom');
    },
  });

  await assert.doesNotReject(async () => {
    const items = await handlers['idbots:getMetabotNfts']({}, { metabotId: 1, kind: 'mrc721' });
    const mvcTransfer = await handlers['idbots:transferMetabotMvcNft']({}, { metabotId: 1 });
    const mrc721Transfer = await handlers['idbots:transferMetabotMrc721']({}, { metabotId: 1 });
    const registry = await handlers['idbots:getNftCaRegistry']({}, {});

    assert.deepEqual(items, { success: false, error: 'nft boom' });
    assert.deepEqual(mvcTransfer, { success: false, error: 'mvc transfer boom' });
    assert.deepEqual(mrc721Transfer, { success: false, error: 'mrc721 transfer boom' });
    assert.deepEqual(registry, { success: false, error: 'ca boom' });
  });
});
