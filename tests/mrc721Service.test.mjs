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
  transferMrc721Item,
  fetchMrc721CollectionInfo,
  fetchMrc721ItemInfo,
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
