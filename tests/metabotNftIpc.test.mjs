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
    sellMrc721Listing: async () => {
      throw new Error('sell boom');
    },
    buyMrc721Listing: async () => {
      throw new Error('buy boom');
    },
    listMrc721SellOrders: async () => {
      throw new Error('orders boom');
    },
    verifyMrc721Listing: async () => {
      throw new Error('verify boom');
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

    const sell = await handlers['idbots:sellMrc721Listing']({}, { metabotId: 1, itemPinId: 'p', buyerAddress: 'a', priceSats: 25000 });
    const buy = await handlers['idbots:buyMrc721Listing']({}, { metabotId: 1, listing: {} });
    const orders = await handlers['idbots:listMrc721SellOrders']({}, { metabotId: 1 });
    const verify = await handlers['idbots:verifyMrc721Listing']({}, { listing: {} });

    assert.deepEqual(sell, { success: false, error: 'sell boom' });
    assert.deepEqual(buy, { success: false, error: 'buy boom' });
    assert.deepEqual(orders, { success: false, error: 'orders boom' });
    assert.deepEqual(verify, { success: true, result: { ok: false, check: 'unknown', error: 'verify boom' } });
  });
});

test('registerMetabotNftIpcHandlers exposes the MRC-721 atomic-swap trade handlers', async () => {
  const sellInput = [];
  const buyInput = [];
  const ordersInput = [];
  const verifyInput = [];
  const handlers = {};

  nftIpc.registerMetabotNftIpcHandlers({
    registerIpcHandler(name, fn) {
      handlers[name] = fn;
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotNftItems: async () => [],
    transferMetabotMvcNft: async () => ({ txId: 'x', rawTx: 'r' }),
    transferMetabotMrc721: async () => ({ txId: 'x', pinId: 'p', toAddress: 't', spentOutpoint: 'o', outputValue: 1 }),
    getNftCaRegistry: async () => ({}),
    sellMrc721Listing: async (store, input) => {
      sellInput.push({ store, input });
      return {
        listingJson: '{"version":1,"kind":"mrc721-atomic-swap"}',
        itemPinId: input.itemPinId,
        buyerAddress: input.buyerAddress,
        priceSats: input.priceSats,
        outpoint: 'aa…i0:1',
      };
    },
    buyMrc721Listing: async (store, input) => {
      buyInput.push({ store, input });
      return {
        txId: 'buy-txid',
        itemPinId: 'aa…i0',
        priceSats: 25000,
        sellerAddress: '1Seller',
        feeSats: 40,
        feeRateEffective: 2,
      };
    },
    listMrc721SellOrders: async (store, metabotId) => {
      ordersInput.push({ store, metabotId });
      return [
        {
          id: 'order-1',
          status: 'valid',
          itemPinId: 'aa…i0',
          buyerAddress: '1Buyer',
          priceSats: 25000,
          outpoint: 'aa…i0:1',
        },
        {
          id: 'order-2',
          status: 'invalid',
          reason: 'MRC-721 listing failed check 3 (ownership): item moved.',
          itemPinId: 'bb…i0',
          buyerAddress: '1Buyer',
          priceSats: 22000,
          outpoint: 'bb…i0:0',
        },
      ];
    },
    verifyMrc721Listing: async (listing) => {
      verifyInput.push(listing);
      return {
        itemPinId: 'aa…i0',
        collectionPinId: 'coll…i0',
        sellerAddress: '1Seller',
        buyerAddress: '1Buyer',
        priceSats: 25000,
        outpoint: { txid: 'aa…i0'.padEnd(64, '0').slice(0, 64), vout: 1, satoshis: 3000 },
        createdAt: 1700000000,
        expiresAt: 1700100000,
        feeRate: 2,
      };
    },
  });

  assert.equal(typeof handlers['idbots:sellMrc721Listing'], 'function');
  assert.equal(typeof handlers['idbots:buyMrc721Listing'], 'function');
  assert.equal(typeof handlers['idbots:listMrc721SellOrders'], 'function');
  assert.equal(typeof handlers['idbots:verifyMrc721Listing'], 'function');

  const sell = await handlers['idbots:sellMrc721Listing']({}, {
    metabotId: 7,
    itemPinId: 'aa…i0',
    buyerAddress: '1Buyer',
    priceSats: 25000,
  });
  assert.deepEqual(sell, {
    success: true,
    result: {
      listingJson: '{"version":1,"kind":"mrc721-atomic-swap"}',
      itemPinId: 'aa…i0',
      buyerAddress: '1Buyer',
      priceSats: 25000,
      outpoint: 'aa…i0:1',
    },
  });
  assert.deepEqual(sellInput[0].input, { metabotId: 7, itemPinId: 'aa…i0', buyerAddress: '1Buyer', priceSats: 25000 });
  assert.deepEqual(sellInput[0].store, { fake: true });

  const buy = await handlers['idbots:buyMrc721Listing']({}, {
    metabotId: 7,
    listing: { version: 1, kind: 'mrc721-atomic-swap' },
  });
  assert.deepEqual(buy, {
    success: true,
    result: {
      txId: 'buy-txid',
      itemPinId: 'aa…i0',
      priceSats: 25000,
      sellerAddress: '1Seller',
      feeSats: 40,
      feeRateEffective: 2,
    },
  });
  assert.deepEqual(buyInput[0].input.listing, { version: 1, kind: 'mrc721-atomic-swap' });

  const orders = await handlers['idbots:listMrc721SellOrders']({}, { metabotId: 7 });
  assert.equal(orders.success, true);
  assert.equal(orders.orders.length, 2);
  assert.deepEqual(orders.orders[0], {
    id: 'order-1',
    status: 'valid',
    itemPinId: 'aa…i0',
    buyerAddress: '1Buyer',
    priceSats: 25000,
    outpoint: 'aa…i0:1',
  });
  assert.equal(orders.orders[1].status, 'invalid');
  assert.match(orders.orders[1].reason, /check 3 \(ownership\)/);
  assert.deepEqual(ordersInput[0], { store: { fake: true }, metabotId: 7 });

  const listingText = '{"version":1,"kind":"mrc721-atomic-swap"}';
  const verify = await handlers['idbots:verifyMrc721Listing']({}, { listing: listingText });
  assert.equal(verify.success, true);
  assert.equal(verify.result.ok, true);
  assert.deepEqual(verify.result.listing, {
    itemPinId: 'aa…i0',
    collectionPinId: 'coll…i0',
    sellerAddress: '1Seller',
    buyerAddress: '1Buyer',
    priceSats: 25000,
    outpoint: `${'aa…i0'.padEnd(64, '0').slice(0, 64)}:1`,
    createdAt: 1700000000,
    expiresAt: 1700100000,
    feeRate: 2,
  });
  assert.equal(verifyInput[0], listingText, 'the pasted listing text must reach the verifier unchanged');
});

test('MRC-721 trade handlers refuse bad shapes and surface verifier checks as ok:false', async () => {
  const handlers = {};

  nftIpc.registerMetabotNftIpcHandlers({
    registerIpcHandler(name, fn) {
      handlers[name] = fn;
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotNftItems: async () => [],
    transferMetabotMvcNft: async () => ({ txId: 'x', rawTx: 'r' }),
    transferMetabotMrc721: async () => ({ txId: 'x', pinId: 'p', toAddress: 't', spentOutpoint: 'o', outputValue: 1 }),
    getNftCaRegistry: async () => ({}),
    sellMrc721Listing: async () => {
      throw new Error('Selling Price must be greater than or equals to 22000 satoshis. 销售价格最低为22000聪。');
    },
    buyMrc721Listing: async () => {
      throw new Error('MRC-721 listing failed check 1 (sigtype): listing sigtype is 0, not SIGHASH_ALL|FORKID|ANYONECANPAY');
    },
    listMrc721SellOrders: async () => [],
    verifyMrc721Listing: async (listing) => {
      if (String(listing).includes('hiccup')) {
        throw new Error('fetch failed');
      }
      throw new Error('MRC-721 listing failed check 1 (listing): expected version 1 kind "mrc721-atomic-swap". This is not an MRC-721 atomic-swap listing.');
    },
  });

  // Floor refusal from the sell service surfaces as a failure payload.
  const belowFloor = await handlers['idbots:sellMrc721Listing']({}, {
    metabotId: 7,
    itemPinId: 'aa…i0',
    buyerAddress: '1Buyer',
    priceSats: 21999,
  });
  assert.equal(belowFloor.success, false);
  assert.match(belowFloor.error, /22000/);

  // Non-integer price and bad metabotId are refused by the handler itself.
  const badPrice = await handlers['idbots:sellMrc721Listing']({}, {
    metabotId: 7,
    itemPinId: 'aa…i0',
    buyerAddress: '1Buyer',
    priceSats: 22.5,
  });
  assert.deepEqual(badPrice, { success: false, error: 'priceSats must be a positive integer' });
  const badId = await handlers['idbots:sellMrc721Listing']({}, {
    metabotId: 0,
    itemPinId: 'aa…i0',
    buyerAddress: '1Buyer',
    priceSats: 25000,
  });
  assert.equal(badId.success, false);
  assert.match(badId.error, /metabotId/);

  // Buy: shape refusal from the verifier surfaces as a failure payload.
  const badListing = await handlers['idbots:buyMrc721Listing']({}, { metabotId: 7, listing: '{}' });
  assert.equal(badListing.success, false);
  assert.match(badListing.error, /check 1 \(sigtype\)/);

  // Verify never throws raw: a shape error reports its check, an
  // indexer/node hiccup reports ok:false with reason too.
  const shapeRefusal = await handlers['idbots:verifyMrc721Listing']({}, { listing: 'not-json' });
  assert.deepEqual(shapeRefusal.success, true);
  assert.equal(shapeRefusal.result.ok, false);
  assert.equal(shapeRefusal.result.check, 'check 1 (listing)');
  assert.match(shapeRefusal.result.error, /not an MRC-721 atomic-swap listing/);

  const hiccup = await handlers['idbots:verifyMrc721Listing']({}, { listing: 'node hiccup' });
  assert.deepEqual(hiccup.success, true);
  assert.equal(hiccup.result.ok, false);
  assert.equal(hiccup.result.check, 'unknown');
  assert.equal(hiccup.result.error, 'fetch failed');
});

// ---------------------------------------------------------------------------
// metabot:setNftAvatar — "use this NFT as the avatar" (the backing mechanism
// behind the single NFT-avatar picker entry)
// ---------------------------------------------------------------------------

function registerAvatarHarness(overrides = {}) {
  const handlers = {};
  const calls = { updates: [] };
  nftIpc.registerMetabotNftIpcHandlers({
    registerIpcHandler(name, fn) {
      handlers[name] = fn;
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotNftItems: async () => [],
    transferMetabotMvcNft: async () => ({ txId: 'tx', rawTx: 'raw' }),
    transferMetabotMrc721: async () => ({
      txId: 'tx', pinId: 'pin', toAddress: 'addr', spentOutpoint: 'out', outputValue: 1,
    }),
    getNftCaRegistry: async () => ({}),
    sellMrc721Listing: async () => { throw new Error('unused'); },
    buyMrc721Listing: async () => { throw new Error('unused'); },
    listMrc721SellOrders: async () => [],
    verifyMrc721Listing: async () => { throw new Error('unused'); },
    normalizeAvatar: async (source) => ({
      ok: true,
      dataUrl: `data:image/jpeg;base64,${Buffer.from(`snapshot:${source}`).toString('base64')}`,
      mime: 'image/jpeg',
      bytes: 13_250,
      source: 'metafile',
    }),
    updateMetabotAvatar: async (metabotId, input) => {
      calls.updates.push({ metabotId, input });
      return {
        success: true,
        metabot: { id: metabotId, name: 'Bot', avatar: input.avatar },
        sync: { skipped: false, success: true },
      };
    },
    ...overrides,
  });
  return { handlers, calls };
}

test('metabot:setNftAvatar normalizes the NFT reference and reuses the metabot-update path', async () => {
  const { handlers, calls } = registerAvatarHarness();
  assert.equal(typeof handlers['metabot:setNftAvatar'], 'function');

  const pinId = '14158a127fa1d7b66d821413abad64bc833cf145e7abd2b40838fde703609b45i0';
  const result = await handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: `metafile://${pinId}.jpg` });

  assert.equal(result.success, true);
  assert.deepEqual(result.avatar, { mime: 'image/jpeg', bytes: 13_250, source: 'metafile' });
  assert.equal(result.metabot.id, 7);
  assert.equal(calls.updates.length, 1, 'exactly one metabot update is attempted');
  assert.equal(calls.updates[0].metabotId, 7);
  assert.match(calls.updates[0].input.avatar, /^data:image\/jpeg;base64,/, 'the stored avatar is a data-URL snapshot');
  assert.equal(result.sync.success, true);
});

test('metabot:setNftAvatar returns the structured normalize failure and never touches the bot', async () => {
  const { handlers, calls } = registerAvatarHarness({
    normalizeAvatar: async () => ({
      ok: false,
      reason: 'too-large',
      detail: 'Avatar is 877125 bytes, over the 204800 byte avatar cap.',
    }),
  });

  const result = await handlers['metabot:setNftAvatar']({}, {
    metabotId: 7,
    imageRef: 'metafile://14158a127fa1d7b66d821413abad64bc833cf145e7abd2b40838fde703609b45i0.jpg',
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'too-large');
  assert.match(result.error, /too-large: Avatar is 877125 bytes/);
  assert.equal(calls.updates.length, 0, 'a failed normalization must not mutate the bot');
});

test('metabot:setNftAvatar surfaces update failures and rejects bad input without throwing', async () => {
  const { handlers } = registerAvatarHarness({
    updateMetabotAvatar: async () => ({ success: false, error: 'chain publish refused' }),
  });

  const failed = await handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: 'https://example.com/art.png' });
  assert.deepEqual(
    { success: failed.success, reason: failed.reason, error: failed.error },
    { success: false, reason: 'update-failed', error: 'chain publish refused' },
  );

  const empty = await handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: '   ' });
  assert.equal(empty.success, false);
  assert.equal(empty.reason, 'empty');

  const badId = await handlers['metabot:setNftAvatar']({}, { metabotId: 0, imageRef: 'metafile://x' });
  assert.equal(badId.success, false);
  assert.match(badId.error, /metabotId/);

  const throwing = registerAvatarHarness({
    normalizeAvatar: async () => {
      throw new Error('normalizer exploded');
    },
  });
  const crashed = await throwing.handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: 'x' });
  assert.deepEqual(crashed, { success: false, error: 'normalizer exploded' });
});

test('metabot:setNftAvatar reports update-unavailable when the edit path is not wired', async () => {
  const { handlers, calls } = registerAvatarHarness({ updateMetabotAvatar: undefined });

  const result = await handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: 'metafile://x' });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'update-unavailable');
  assert.equal(calls.updates.length, 0);
});
