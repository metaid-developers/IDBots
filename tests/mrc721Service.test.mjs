import test from 'node:test';
import assert from 'node:assert/strict';

// MRC-721 service: content builders + validators (pure), the indexer read
// layer (stubbed fetch over the standard remote-first path), and the transfer
// orchestration (forced-outpoint spend shape).

process.env.IDBOTS_MAN_P2P_LOCAL_BASE && delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;

const {
  buildMrc721CollectionDescContent,
  buildMrc721ItemDescContent,
  normalizeMrc721CoverUri,
  validateMrc721CollectionName,
  validateMrc721ItemPath,
  validateMrc721RoyaltyRate,
  validateMrc721TotalSupply,
  isMrc721PinId,
  isMvcAddress,
  createMrc721Collection,
  createMrc721Mint,
  createMrc721ItemDescBatch,
  estimateMrc721Issue,
  estimateMvcMrc721PinFeeSats,
  updateMrc721Collection,
  transferMrc721Item,
  fetchMrc721CollectionInfo,
  fetchMrc721ItemInfo,
  scanMrc721CollectionNameForIssuer,
  verifyMrc721Holding,
  waitForMrc721CollectionInfo,
} = await import('../dist-electron/main/services/mrc721Service.js');

// ---------------------------------------------------------------------------
// fetch stubbing: the reads go through fetchFromLocalOrFallback → global fetch
// (no IDBOTS_MAN_P2P_LOCAL_BASE override in tests → direct remote fetch).
// ---------------------------------------------------------------------------

async function withFetchStub(stub, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Validators + content builders
// ---------------------------------------------------------------------------

test('validateMrc721CollectionName enforces the protocol namespace rules', () => {
  assert.equal(validateMrc721CollectionName(' pixel-cats '), 'pixel-cats');
  assert.equal(validateMrc721CollectionName('a1-b2'), 'a1-b2');
  assert.throws(() => validateMrc721CollectionName(''), /required/);
  assert.throws(() => validateMrc721CollectionName('Pixel Cats'), /lowercase/);
  assert.throws(() => validateMrc721CollectionName('has/slash'), /lowercase/);
  assert.throws(() => validateMrc721CollectionName('-lead'), /start with a letter/);
  assert.throws(() => validateMrc721CollectionName('collection_desc'), /reserved/);
  assert.throws(() => validateMrc721CollectionName('item_desc'), /reserved/);
  assert.throws(() => validateMrc721CollectionName('x'.repeat(65)), /at most 64/);
});

test('validateMrc721ItemPath rejects reserved segments case-insensitively', () => {
  assert.equal(validateMrc721ItemPath('nft-01'), 'nft-01');
  assert.throws(() => validateMrc721ItemPath('collection_desc'), /reserved/);
  assert.throws(() => validateMrc721ItemPath('Collection_Desc'), /reserved|lowercase/);
  assert.throws(() => validateMrc721ItemPath('has space'), /lowercase/);
  assert.throws(() => validateMrc721ItemPath(''), /required/);
});

test('numeric validators enforce the indexer ranges', () => {
  assert.equal(validateMrc721TotalSupply(undefined), -1);
  assert.equal(validateMrc721TotalSupply(100), 100);
  assert.throws(() => validateMrc721TotalSupply(-2), /-1/);
  assert.throws(() => validateMrc721TotalSupply(1.5), /integer/);
  assert.equal(validateMrc721RoyaltyRate(undefined), 0);
  assert.equal(validateMrc721RoyaltyRate(20), 20);
  assert.throws(() => validateMrc721RoyaltyRate(21), /\[0, 20\]/);
  assert.throws(() => validateMrc721RoyaltyRate(-1), /\[0, 20\]/);
});

test('buildMrc721CollectionDescContent keeps provided fields and omits empty ones', () => {
  const content = buildMrc721CollectionDescContent({
    name: 'Pixel Cats',
    totalSupply: 100,
    royaltyRate: 5,
    desc: '  cats on chain  ',
  });
  assert.deepEqual(content, {
    name: 'Pixel Cats',
    totalSupply: 100,
    royaltyRate: 5,
    desc: 'cats on chain',
  });
  assert.equal('cover' in content, false);
  assert.equal('website' in content, false);
});

test('buildMrc721CollectionDescContent handles metadata shapes like the indexer', () => {
  // JSON string is round-tripped; object passes through; non-JSON string kept.
  assert.deepEqual(
    buildMrc721CollectionDescContent({ metadata: '{"trait":"cool"}' }).metadata,
    { trait: 'cool' },
  );
  assert.deepEqual(
    buildMrc721CollectionDescContent({ metadata: { trait: 'cool' } }).metadata,
    { trait: 'cool' },
  );
  assert.equal(
    buildMrc721CollectionDescContent({ metadata: 'not json' }).metadata,
    'not json',
  );
  assert.throws(() => buildMrc721CollectionDescContent({ metadata: '   ' }), /must not be empty/);
});

test('normalizeMrc721CoverUri prefixes bare pinids with metafile://', () => {
  const pinid = `${'ab'.repeat(32)}i0`;
  assert.equal(normalizeMrc721CoverUri(pinid), `metafile://${pinid}`);
  assert.equal(normalizeMrc721CoverUri(`metafile://${pinid}`), `metafile://${pinid}`);
  assert.equal(normalizeMrc721CoverUri(undefined), undefined);
});

test('pinId and MVC address predicates', () => {
  assert.ok(isMrc721PinId(`${'ab'.repeat(32)}i0`));
  assert.ok(!isMrc721PinId('notapinid'));
  assert.ok(isMvcAddress(`1${'abcdef'.repeat(4)}`));
  assert.ok(!isMvcAddress('0x123'));
});

// ---------------------------------------------------------------------------
// Read layer (stubbed indexer)
// ---------------------------------------------------------------------------

test('fetchMrc721CollectionInfo hits, misses, and surfaces transport errors', async () => {
  const data = { collectionName: 'pixel-cats', pinid: `${'ab'.repeat(32)}i0`, totalnum: 3 };
  await withFetchStub(async () => jsonResponse({ code: 1, data }), async () => {
    assert.deepEqual(await fetchMrc721CollectionInfo({ name: 'pixel-cats' }), data);
  });
  await withFetchStub(async () => jsonResponse({ code: 0, message: 'not found' }), async () => {
    assert.equal(await fetchMrc721CollectionInfo({ name: 'pixel-cats' }), null);
  });
  await withFetchStub(async () => {
    throw new Error('connection refused');
  }, async () => {
    await assert.rejects(() => fetchMrc721CollectionInfo({ name: 'pixel-cats' }), /connection refused/);
  });
});

test('waitForMrc721CollectionInfo polls until hit or timeout', async () => {
  let calls = 0;
  const result = await withFetchStub(async () => {
    calls += 1;
    if (calls < 3) return jsonResponse({ code: 0, message: 'not found' });
    return jsonResponse({ code: 1, data: { collectionName: 'pixel-cats', totalnum: 0 } });
  }, () => waitForMrc721CollectionInfo({ name: 'pixel-cats', timeoutMs: 5000, intervalMs: 50 }));
  assert.equal(result.hit.collectionName, 'pixel-cats');
  assert.ok(calls >= 3);

  const missed = await withFetchStub(
    async () => jsonResponse({ code: 0, message: 'not found' }),
    () => waitForMrc721CollectionInfo({ name: 'pixel-cats', timeoutMs: 400, intervalMs: 100 }),
  );
  assert.equal(missed.hit, null);
});

// ---------------------------------------------------------------------------
// Write orchestration
// ---------------------------------------------------------------------------

function makeCreatePinSpy(overrides = {}) {
  const calls = [];
  const createPin = async (metabotId, metaidData, options) => {
    calls.push({ metabotId, metaidData, options });
    return {
      pinId: overrides.pinId ?? `${'cd'.repeat(32)}i0`,
      txids: ['tx1'],
      totalCost: 500,
      feeAssist: undefined,
    };
  };
  return { createPin, calls };
}

test('createMrc721Collection broadcasts the collection_desc pin with validated content', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const result = await createMrc721Collection(
    { createPin },
    {
      metabotId: 7,
      collectionName: 'pixel-cats',
      name: 'Pixel Cats',
      totalSupply: 100,
      royaltyRate: 5,
      desc: 'test collection',
    },
    { origin: 'tool:mrc721_collection_create' },
  );
  assert.equal(result.collectionName, 'pixel-cats');
  assert.equal(result.pinId, `${'cd'.repeat(32)}i0`);
  assert.equal(calls.length, 1);
  const { metabotId, metaidData, options } = calls[0];
  assert.equal(metabotId, 7);
  assert.equal(metaidData.operation, 'create');
  assert.equal(metaidData.path, '/nft/mrc721/pixel-cats/collection_desc');
  assert.equal(metaidData.contentType, 'application/json');
  assert.equal(options.origin, 'tool:mrc721_collection_create');
  const content = JSON.parse(metaidData.payload);
  assert.deepEqual(content, {
    name: 'Pixel Cats',
    totalSupply: 100,
    royaltyRate: 5,
    desc: 'test collection',
  });
});

test('createMrc721Collection rejects reserved names before any pin is built', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  await assert.rejects(
    () => createMrc721Collection({ createPin }, { metabotId: 7, collectionName: 'collection_desc' }),
    /reserved/,
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Collection update (operation=modify, issuer-only, full-content rewrite)
// ---------------------------------------------------------------------------

test('updateMrc721Collection broadcasts an issuer-verified full-content modify pin', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const current = {
    collectionName: 'pixel-cats',
    name: 'Pixel Cats',
    desc: 'old desc',
    website: 'https://cats.example',
    totalSupply: 100,
    royaltyRate: 5,
    pinid: `${'cd'.repeat(32)}i0`,
    createAddress: BOT_ADDRESS,
    cover: 'metafile://old',
  };
  const coverPinId = `${'ef'.repeat(32)}i1`;
  const result = await updateMrc721Collection(
    { createPin, store: makeStore() },
    { metabotId: 7, collectionName: 'pixel-cats', cover: coverPinId, current },
  );
  assert.equal(result.collectionName, 'pixel-cats');
  assert.deepEqual(result.updatedFields, ['cover']);
  assert.equal(calls.length, 1);
  const { metabotId, metaidData, options } = calls[0];
  assert.equal(metabotId, 7);
  assert.equal(metaidData.operation, 'modify');
  assert.equal(metaidData.path, '/nft/mrc721/pixel-cats/collection_desc');
  assert.equal(metaidData.contentType, 'application/json');
  assert.equal(options.origin, 'tool:mrc721_collection_update');
  // Full rewrite: current fields ride unchanged, cover is replaced.
  assert.deepEqual(JSON.parse(metaidData.payload), {
    name: 'Pixel Cats',
    totalSupply: 100,
    royaltyRate: 5,
    desc: 'old desc',
    website: 'https://cats.example',
    cover: `metafile://${coverPinId}`,
  });
});

test('updateMrc721Collection resolves the session issuer\'s own album via the issuer-scoped search', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const seen = [];
  await withFetchStub(
    async (url) => {
      seen.push(String(url));
      if (String(url).includes('/api/mrc721/collection/search')) {
        return jsonResponse({
          code: 1,
          data: { list: [{ collectionName: 'pixel-cats', name: 'Pixel Cats', createAddress: BOT_ADDRESS, pinid: `${'cd'.repeat(32)}i0` }] },
        });
      }
      return jsonResponse({ code: 1, data: { list: [] } });
    },
    async () => {
      const result = await updateMrc721Collection(
        { createPin, store: makeStore() },
        { metabotId: 7, collectionName: 'pixel-cats', name: 'Renamed Cats' },
      );
      assert.deepEqual(result.updatedFields, ['name']);
    },
  );
  const content = JSON.parse(calls[0].metaidData.payload);
  assert.equal(content.name, 'Renamed Cats');
  // The issuer-scoped search is the resolve path — no collection/info?name=.
  assert.ok(seen.some((url) => url.includes('/api/mrc721/collection/search')), 'must resolve via the issuer-scoped search');
});

test('updateMrc721Collection refuses a name owned by another issuer (issuer-only modify)', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  await withFetchStub(
    async (url) => {
      if (String(url).includes('/api/mrc721/collection/search')) {
        if (String(url).includes('issuer=')) {
          return jsonResponse({ code: 1, data: { list: [], total: 0 } });
        }
        return jsonResponse({
          code: 1,
          data: { list: [{ collectionName: 'pixel-cats', createAddress: '1SomeoneElse', pinid: `${'ab'.repeat(32)}i0` }] },
        });
      }
      return jsonResponse({ code: 1, data: { list: [] } });
    },
    async () => {
      await assert.rejects(
        () => updateMrc721Collection(
          { createPin, store: makeStore() },
          { metabotId: 7, collectionName: 'pixel-cats', name: 'New' },
        ),
        /issued by another issuer/,
      );
    },
  );
  assert.equal(calls.length, 0);
});

test('updateMrc721Collection passes indexed metadata through and lets overrides win', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const current = { collectionName: 'pixel-cats', createAddress: BOT_ADDRESS, metadata: '{"trait":"old"}' };
  await updateMrc721Collection(
    { createPin, store: makeStore() },
    { metabotId: 7, collectionName: 'pixel-cats', desc: 'new desc', current },
  );
  let content = JSON.parse(calls[0].metaidData.payload);
  assert.deepEqual(content.metadata, { trait: 'old' });
  assert.equal(content.desc, 'new desc');

  await updateMrc721Collection(
    { createPin, store: makeStore() },
    { metabotId: 7, collectionName: 'pixel-cats', metadata: { trait: 'new' }, current },
  );
  content = JSON.parse(calls[1].metaidData.payload);
  assert.deepEqual(content.metadata, { trait: 'new' });
});

test('updateMrc721Collection refuses non-issuers, unindexed collections, unverifiable creators, and no-ops', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const base = { metabotId: 7, collectionName: 'pixel-cats' };
  const current = { collectionName: 'pixel-cats', name: 'P', createAddress: BOT_ADDRESS };
  await assert.rejects(
    () => updateMrc721Collection(
      { createPin, store: makeStore() },
      { ...base, name: 'New', current: { ...current, createAddress: '1SomeoneElse' } },
    ),
    /only the issuing MetaBot/,
  );
  await assert.rejects(
    () => updateMrc721Collection({ createPin, store: makeStore() }, { ...base, name: 'New', current: null }),
    /not in the index/,
  );
  await assert.rejects(
    () => updateMrc721Collection(
      { createPin, store: makeStore() },
      { ...base, name: 'New', current: { ...current, createAddress: '' } },
    ),
    /cannot verify the modify permission/,
  );
  // No-op guard fires before any indexer lookup or pin broadcast.
  await assert.rejects(
    () => updateMrc721Collection({ createPin, store: makeStore() }, { ...base, current }),
    /nothing to update/,
  );
  assert.equal(calls.length, 0);
});

test('createMrc721Mint sends mint pin only, and item_desc only when display fields are given', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const bare = await createMrc721Mint(
    { createPin },
    { metabotId: 7, collectionName: 'pixel-cats', itemPath: 'nft-01', settleDelayMs: 0 },
  );
  assert.equal(bare.itemPath, 'nft-01');
  assert.equal(bare.itemDescPinId, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metaidData.path, '/nft/mrc721/pixel-cats/nft-01');
  assert.deepEqual(JSON.parse(calls[0].metaidData.payload), {});

  const withDisplay = await createMrc721Mint(
    { createPin },
    {
      metabotId: 7,
      collectionName: 'pixel-cats',
      itemPath: 'nft-02',
      name: 'Cat #2',
      desc: 'second cat',
      metadata: { trait: 'cool' },
      settleDelayMs: 0,
    },
  );
  assert.equal(withDisplay.itemDescPinId, `${'cd'.repeat(32)}i0`);
  assert.equal(calls.length, 3);
  const descCall = calls[2].metaidData;
  assert.equal(descCall.path, '/nft/mrc721/pixel-cats/item_desc');
  const descContent = JSON.parse(descCall.payload);
  assert.deepEqual(descContent, {
    items: [{ pinid: `${'cd'.repeat(32)}i0`, name: 'Cat #2', desc: 'second cat', metadata: { trait: 'cool' } }],
  });
});

test('createMrc721Mint auto-generates a non-reserved item path', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const result = await createMrc721Mint({ createPin }, { metabotId: 7, collectionName: 'pixel-cats', settleDelayMs: 0 });
  assert.match(result.itemPath, /^nft-[0-9a-f]{8}$/);
  assert.notEqual(['collection_desc', 'item_desc'].includes(result.itemPath), true);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Transfer orchestration (R3)
// ---------------------------------------------------------------------------

const BOT_ADDRESS = '1SessionBotAddress1234';
const NFT_TXID = 'ab'.repeat(32);

function makeStore(mvcAddress = BOT_ADDRESS) {
  return {
    getMetabotById: (id) => (id === 7 ? { mvc_address: mvcAddress } : null),
  };
}

function makeTransferDeps(overrides = {}) {
  const buildCalls = [];
  const deps = {
    buildRawTx: async (store, params) => {
      buildCalls.push(params);
      return overrides.buildResult ?? { raw_tx: 'rawhex', txid: 'newtxid', spent_outpoints: [`${NFT_TXID}:0`] };
    },
    broadcastTx: async (rawTx) => overrides.broadcastError ? Promise.reject(new Error(overrides.broadcastError)) : 'broadcast-txid',
  };
  return { deps, buildCalls };
}

const happyItem = {
  itemPinId: `${NFT_TXID}i0`,
  ownerAddress: BOT_ADDRESS,
  genesisChainName: 'mvc',
  output: `${NFT_TXID}:0`,
  outputValue: 1,
};

test('transferMrc721Item spends the item outpoint as the forced include input', async () => {
  const { deps, buildCalls } = makeTransferDeps();
  const result = await transferMrc721Item(
    deps,
    {
      store: makeStore(),
      metabotId: 7,
      pinId: `${NFT_TXID}i0`,
      toAddress: '1RecipientAddress5678',
      feeRate: 2,
      itemInfo: happyItem,
    },
  );
  assert.equal(result.txId, 'broadcast-txid');
  assert.equal(result.spentOutpoint, `${NFT_TXID}:0`);
  assert.equal(result.outputValue, 1);
  assert.equal(buildCalls.length, 1);
  assert.deepEqual(buildCalls[0], {
    metabotId: 7,
    toAddress: '1RecipientAddress5678',
    amountSats: 1,
    feeRate: 2,
    includeOutpoints: [{ txid: NFT_TXID, vout: 0, satoshis: 1 }],
  });
});

test('transferMrc721Item fetches item info from the indexer when not provided', async () => {
  const { deps, buildCalls } = makeTransferDeps();
  await withFetchStub(async () => jsonResponse({ code: 1, data: happyItem }), async () => {
    const result = await transferMrc721Item(
      deps,
      { store: makeStore(), metabotId: 7, pinId: `${NFT_TXID}i0`, toAddress: '1RecipientAddress5678', feeRate: 1 },
    );
    assert.equal(result.txId, 'broadcast-txid');
    assert.equal(buildCalls.length, 1);
  });
});

test('transferMrc721Item refuses items it does not own, burned items, and BTC items', async () => {
  const { deps } = makeTransferDeps();
  const base = { store: makeStore(), metabotId: 7, pinId: `${NFT_TXID}i0`, toAddress: '1RecipientAddress5678', feeRate: 1 };
  await assert.rejects(
    () => transferMrc721Item(deps, { ...base, itemInfo: { ...happyItem, ownerAddress: '1SomeoneElse' } }),
    /currently owned by/,
  );
  await assert.rejects(
    () => transferMrc721Item(deps, { ...base, itemInfo: { ...happyItem, burned: true } }),
    /burned/,
  );
  await assert.rejects(
    () => transferMrc721Item(deps, { ...base, itemInfo: { ...happyItem, genesisChainName: 'btc' } }),
    /BTC-side|mvc/i,
  );
  await assert.rejects(
    () => transferMrc721Item(deps, { ...base, itemInfo: { ...happyItem, output: '', outputValue: undefined } }),
    /no spendable current UTXO/,
  );
  await assert.rejects(
    () => transferMrc721Item(deps, { ...base, itemInfo: null }),
    /not in the index/,
  );
  await assert.rejects(
    () => transferMrc721Item(deps, { ...base, toAddress: 'not-an-address' }),
    /valid MVC address/,
  );
});

test('fetchMrc721ItemInfo surfaces a teaching error for unindexed items on transfer', async () => {
  await withFetchStub(async () => jsonResponse({ code: 0, message: 'not found' }), async () => {
    assert.equal(await fetchMrc721ItemInfo({ pinId: `${NFT_TXID}i0` }), null);
  });
});

// ---------------------------------------------------------------------------
// Issuer-only protocol revision (2026-11-07): issuer-scoped same-name scan +
// name-ambiguity guard on the holder gate
// ---------------------------------------------------------------------------

function searchRows(list, total = list.length) {
  return jsonResponse({ code: 1, data: { list, total } });
}

test('scanMrc721CollectionNameForIssuer splits same-name albums by issuer', async () => {
  const ownRow = { collectionName: 'pixel-cats', pinid: `${'cd'.repeat(32)}i0`, createAddress: BOT_ADDRESS };
  const foreignRow = { collectionName: 'pixel-cats', pinid: `${'ef'.repeat(32)}i0`, createAddress: '1SomeoneElse' };
  // Own album under the name: single conjunctive call, no foreign classification.
  const own = await withFetchStub(
    async () => searchRows([ownRow, foreignRow]),
    () => scanMrc721CollectionNameForIssuer({ issuerAddress: BOT_ADDRESS, collectionName: 'pixel-cats' }),
  );
  assert.deepEqual(own.own, ownRow);
  assert.deepEqual(own.foreign, []);

  // No own album: the keyword-only pass surfaces the foreign same-name album.
  const noOwn = await withFetchStub(
    async (url) => {
      if (String(url).includes('issuer=')) return searchRows([]);
      return searchRows([foreignRow, { collectionName: 'dog-pics', pinid: `${'ab'.repeat(32)}i0`, createAddress: '1SomeoneElse' }]);
    },
    () => scanMrc721CollectionNameForIssuer({ issuerAddress: BOT_ADDRESS, collectionName: 'pixel-cats' }),
  );
  assert.equal(noOwn.own, null);
  assert.deepEqual(noOwn.foreign, [foreignRow]);

  // Rows whose collectionName merely contains the keyword are not matches.
  const substring = await withFetchStub(
    async () => searchRows([{ collectionName: 'pixel-cats-v2', pinid: `${'ab'.repeat(32)}i0`, createAddress: BOT_ADDRESS }]),
    () => scanMrc721CollectionNameForIssuer({ issuerAddress: BOT_ADDRESS, collectionName: 'pixel-cats' }),
  );
  assert.equal(substring.own, null);
  assert.deepEqual(substring.foreign, []);
});

test('verifyMrc721Holding resolves a single same-name album by its collectionid', async () => {
  const seen = [];
  await withFetchStub(
    async (url) => {
      seen.push(String(url));
      if (String(url).includes('/api/mrc721/collection/search')) {
        return searchRows([{ collectionName: 'pixel-cats', pinid: `${'cd'.repeat(32)}i0`, createAddress: BOT_ADDRESS }]);
      }
      if (String(url).includes('/api/mrc721/address/item')) {
        return jsonResponse({ code: 1, data: { list: [] } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    () => verifyMrc721Holding({ holderAddress: BOT_ADDRESS, collectionName: 'pixel-cats' }),
  );
  assert.ok(seen.some((url) => url.includes(`pinId=${'cd'.repeat(32)}i0`)), 'holder query must carry the resolved collectionid');
});

test('verifyMrc721Holding refuses an ambiguous name instead of verifying the earliest album', async () => {
  const first = `${'cd'.repeat(32)}i0`;
  const second = `${'ef'.repeat(32)}i0`;
  await withFetchStub(
    async (url) => {
      if (String(url).includes('/api/mrc721/collection/search')) {
        return searchRows([
          { collectionName: 'pixel-cats', pinid: first, createAddress: BOT_ADDRESS },
          { collectionName: 'pixel-cats', pinid: second, createAddress: '1SomeoneElse' },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    () => verifyMrc721Holding({ holderAddress: BOT_ADDRESS, collectionName: 'pixel-cats' }),
  ).then(
    () => assert.fail('ambiguous name must throw'),
    (error) => {
      assert.match(error.message, /ambiguous/);
      assert.match(error.message, new RegExp(first));
      assert.match(error.message, new RegExp(second));
      assert.match(error.message, /collectionPinId/);
    },
  );
});

// ---------------------------------------------------------------------------
// MetaSo base resolution: production default built in, env override only
// ---------------------------------------------------------------------------

test('getMetasoApiBase defaults to the production base and honors the staging override', async () => {
  const previous = process.env.IDBOTS_METASO_API_BASE;
  delete process.env.IDBOTS_METASO_API_BASE;
  try {
    const mod = await import('../dist-electron/main/services/mrc721Service.js');
    assert.equal(mod.METASO_API_BASE_DEFAULT, 'https://so.metaid.io');
    assert.equal(mod.getMetasoApiBase(), 'https://so.metaid.io');
    process.env.IDBOTS_METASO_API_BASE = 'http://127.0.0.1:8080/';
    assert.equal(mod.getMetasoApiBase(), 'http://127.0.0.1:8080');
  } finally {
    if (previous == null) delete process.env.IDBOTS_METASO_API_BASE;
    else process.env.IDBOTS_METASO_API_BASE = previous;
  }
});

// ---------------------------------------------------------------------------
// MRC-721 read base: the /api/mrc721/* reads ride the MetaSo base too
// (2026-11-05 cutover off manapi.metaid.io — byte-compatible surface, global
// metaid values; IDBOTS_METASO_API_BASE doubles as the read rollback lever).
// ---------------------------------------------------------------------------

test('MRC-721 reads target the MetaSo base, overridable via IDBOTS_METASO_API_BASE', async () => {
  const previous = process.env.IDBOTS_METASO_API_BASE;
  delete process.env.IDBOTS_METASO_API_BASE;
  const seen = [];
  const stub = async (url) => {
    seen.push(String(url));
    return jsonResponse({ code: 1, data: { collectionName: 'pixel-cats' } });
  };
  try {
    await withFetchStub(stub, async () => {
      await fetchMrc721CollectionInfo({ name: 'pixel-cats' });
      await fetchMrc721ItemInfo({ pinId: `${'ab'.repeat(32)}i0` });
    });
    assert.equal(seen.length, 2);
    assert.ok(seen[0].startsWith('https://so.metaid.io/api/mrc721/collection/info?'), `expected MetaSo base, got ${seen[0]}`);
    assert.ok(seen[1].startsWith('https://so.metaid.io/api/mrc721/item/info?'), `expected MetaSo base, got ${seen[1]}`);

    // Rollback lever: the same env override retargets the read base.
    process.env.IDBOTS_METASO_API_BASE = 'https://manapi.metaid.io';
    seen.length = 0;
    await withFetchStub(stub, async () => {
      await fetchMrc721CollectionInfo({ name: 'pixel-cats' });
    });
    assert.ok(seen[0].startsWith('https://manapi.metaid.io/api/mrc721/collection/info?'), `expected rollback base, got ${seen[0]}`);
  } finally {
    if (previous == null) delete process.env.IDBOTS_METASO_API_BASE;
    else process.env.IDBOTS_METASO_API_BASE = previous;
  }
});

// ---------------------------------------------------------------------------
// item_desc batch write + dry-run issue estimate
// ---------------------------------------------------------------------------

test('createMrc721ItemDescBatch broadcasts ONE item_desc pin with every entry', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const itemA = `${'11'.repeat(32)}i0`;
  const itemB = `${'22'.repeat(32)}i0`;
  const result = await createMrc721ItemDescBatch(
    { createPin },
    {
      metabotId: 7,
      collectionName: 'pixel-cats',
      settleDelayMs: 0,
      items: [
        { pinId: itemA, name: 'Cat #1', desc: 'first', cover: `${'33'.repeat(32)}i0`, metadata: { trait: 'cool' } },
        { pinId: itemB, name: 'Cat #2' },
      ],
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metaidData.path, '/nft/mrc721/pixel-cats/item_desc');
  assert.equal(calls[0].metaidData.operation, 'create');
  assert.deepEqual(JSON.parse(calls[0].metaidData.payload), {
    items: [
      { pinid: itemA, name: 'Cat #1', desc: 'first', cover: `metafile://${'33'.repeat(32)}i0`, metadata: { trait: 'cool' } },
      { pinid: itemB, name: 'Cat #2' },
    ],
  });
  assert.deepEqual(result.referencedPinIds, [itemA, itemB]);
  assert.equal(result.collectionName, 'pixel-cats');
});

test('createMrc721ItemDescBatch refuses empty, duplicate, invalid, and oversized batches before any write', async () => {
  const { createPin, calls } = makeCreatePinSpy();
  const itemA = `${'11'.repeat(32)}i0`;
  await assert.rejects(
    () => createMrc721ItemDescBatch({ createPin }, { metabotId: 7, collectionName: 'pixel-cats', items: [] }),
    /at least one/,
  );
  await assert.rejects(
    () => createMrc721ItemDescBatch(
      { createPin },
      { metabotId: 7, collectionName: 'pixel-cats', items: [{ pinId: itemA }, { pinId: itemA }] },
    ),
    /duplicate pin_id/,
  );
  await assert.rejects(
    () => createMrc721ItemDescBatch(
      { createPin },
      { metabotId: 7, collectionName: 'pixel-cats', items: [{ pinId: 'nothex' }] },
    ),
    /pin_id/,
  );
  await assert.rejects(
    () => createMrc721ItemDescBatch(
      { createPin },
      { metabotId: 7, collectionName: 'pixel-cats', items: [{ pinId: itemA, metadata: 'x'.repeat(16_385) }] },
    ),
    /metadata must serialize/,
  );
  await assert.rejects(
    () => createMrc721ItemDescBatch(
      { createPin },
      {
        metabotId: 7,
        collectionName: 'pixel-cats',
        items: Array.from({ length: 101 }, (_, i) => ({ pinId: `${String(i).padStart(2, '0')}${'11'.repeat(31)}i0` })),
      },
    ),
    /at most 100/,
  );
  assert.equal(calls.length, 0);
});

test('estimateMvcMrc721PinFeeSats pins the payload-aware upper-bound math', () => {
  // OP_RETURN script: 1 + 7('metaid') + 7('create') + 33(path 32+push)
  // + 2('0') + 6('1.0.0') + 17('application/json') + 3('{}') = 76 bytes.
  const sats = estimateMvcMrc721PinFeeSats({
    operation: 'create',
    path: '/nft/mrc721/pixel-cats/item_desc',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: '{}',
  }, 1);
  assert.equal(sats, 486); // 62 base + 76 script + 2×148 inputs + 52 change output
});

test('estimateMrc721Issue plans collection_desc + mints + ONE batch item_desc', () => {
  const estimate = estimateMrc721Issue({
    collectionName: 'pixel-cats',
    name: 'Pixel Cats',
    totalSupply: 10,
    royaltyRate: 0,
    desc: 'a series',
    feeRate: 1,
    items: [
      { name: 'Cat #1', desc: 'first' },
      { name: 'Cat #2', desc: 'second', metadata: { trait: 'cool' } },
    ],
  });
  assert.equal(estimate.itemCount, 2);
  assert.deepEqual(estimate.writes.map((write) => write.kind), [
    'collection_desc', 'item_mint', 'item_mint', 'item_desc',
  ]);
  assert.equal(estimate.totalEstimatedSats, estimate.writes.reduce((sum, write) => sum + write.estimatedSats, 0));
  assert.ok(estimate.writes[3].payloadBytes > 2, 'batch item_desc payload carries both entries');
});

test('estimateMrc721Issue ride_along costs more than batch_desc for 2 items', () => {
  const items = [{ name: 'a' }, { name: 'b' }];
  const batch = estimateMrc721Issue({ collectionName: 'pixel-cats', items, displayMode: 'batch_desc', feeRate: 1 });
  const ride = estimateMrc721Issue({ collectionName: 'pixel-cats', items, displayMode: 'ride_along', feeRate: 1 });
  assert.equal(batch.writes.length, 4);
  assert.equal(ride.writes.length, 5);
  assert.ok(ride.totalEstimatedSats > batch.totalEstimatedSats);
});

test('estimateMrc721Issue add-to-existing drops the registration write and validates immutable fields', () => {
  const existing = estimateMrc721Issue({
    collectionName: 'pixel-cats',
    registerCollection: false,
    feeRate: 1,
    items: [{ name: 'Cat #3' }],
  });
  assert.deepEqual(existing.writes.map((write) => write.kind), ['item_mint', 'item_desc']);
  assert.throws(
    () => estimateMrc721Issue({ collectionName: 'pixel-cats', totalSupply: 1.5, feeRate: 1 }),
    /integer in \[-1, 1e12\]/,
  );
  assert.throws(
    () => estimateMrc721Issue({ collectionName: 'Bad Name', feeRate: 1 }),
    /lowercase/,
  );
});
